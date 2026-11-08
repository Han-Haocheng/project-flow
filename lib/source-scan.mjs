/**
 * 源码扫描器（`lib/source-scan.mjs`）——把源码文本解析成「模块级 import 边」
 * 与「顶层声明」，供描述台账（`lib/desc.mjs`）做成员归属与模块边推导。
 *
 * 冻结接口（`.dsh-ops/desc-spec.md` §4）：
 *
 *   languageOf(path)        → 'js' | 'python' | null
 *   scanSource(path, text)  → { language, imports[], declarations[] }
 *
 * imports:      { specifier, kind: 'static'|'reexport'|'dynamic'|'side-effect', offset }
 * declarations: { name, kind: 'function'|'class'|'const'|'let'|'var',
 *                 exported, startLine, endLine, identifiers[] }
 *
 * 叶子模块：零依赖，不 import `lib/` 下任何模块（依赖方向 `core → desc →
 * source-scan`，source-scan 是链尾）。
 *
 * 解析是「词法近似」而不是真解析器：零依赖项目里不引入 acorn/babel，所以用
 * 「剥注释 → 跳字符串 → 记括号深度」的扫描器判定顶层语句。它足以支撑描述
 * 台账（成员归属 / 模块边），代价是若干已知漏扫（见文件尾「已知局限」）。
 *
 * 两个关键取舍：
 *   - 注释替换成等长空白、字符串保留原样（`stripComments`）：import 扫描既不
 *     会被注释里的假 import 误导，也不会破坏字面量里的 specifier。
 *   - identifiers 从「去注释去字符串」的掩码文本（`mask`）里取：字符串与注释
 *     里的词不会混进成员引用。
 */

const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx'])

const SPACE = /\s/
const DIGIT = /[0-9]/
const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/

/** 允许出现在声明关键字前面的词（`export default function` 等）。 */
const STATEMENT_PREFIX = new Set(['export', 'default', 'async', 'declare', 'abstract'])

/** 这些词之后出现的 `/` 一定是正则字面量，不是除号。 */
const REGEX_PREFIX = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await', 'throw',
])

/** 不算「成员引用」的语法词：保留字、字面量、少量上下文关键字。 */
const JS_NOISE = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'namespace',
  'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'readonly',
  'require', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  'NaN', 'Infinity', 'globalThis',
])

/** Python 的关键字与惯用噪声（`self`/`cls` 不是成员引用）。 */
const PY_NOISE = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'None', 'True', 'False', 'self', 'cls',
])

const isIdentStart = (ch) => ch !== undefined && IDENT_START.test(ch)
const isIdentPart = (ch) => ch !== undefined && IDENT_PART.test(ch)
const isSpace = (ch) => ch !== undefined && SPACE.test(ch)

// ---------------------------------------------------------------- 公开接口

/**
 * 按扩展名判定语言。JS/TS/JSX 统一归 `js`（扫描规则相同）；`.py` 归
 * `python`；其余返回 `null`（`scanSource` 里再落成 `'unknown'`）。
 *
 * @param {string} path 仓库相对路径或绝对路径（只看最后一段的扩展名）
 * @returns {'js'|'python'|null}
 */
export function languageOf(path) {
  const extension = extensionOf(path)
  if (JS_EXTENSIONS.has(extension)) return 'js'
  if (extension === '.py') return 'python'
  return null
}

/**
 * 扫描一份源码文本。
 *
 * @param {string} path 路径只用于判定语言（内容由 `text` 决定）
 * @param {string} text 源码文本
 * @returns {{ language: 'js'|'python'|'unknown', imports: object[], declarations: object[] }}
 */
export function scanSource(path, text) {
  const source = typeof text === 'string' ? text : ''
  const language = languageOf(path)

  if (language === 'js') {
    const code = stripComments(source)
    return {
      language,
      imports: scanJsImports(code),
      declarations: scanJsDeclarations(source, code),
    }
  }

  if (language === 'python') {
    return {
      language,
      imports: scanPythonImports(source),
      declarations: scanPythonDeclarations(source),
    }
  }

  // 其它语言只留文件级描述：不猜结构，也不假装扫描过。
  return { language: 'unknown', imports: [], declarations: [] }
}

// ------------------------------------------------------------ 通用词法工具

/** `a/b/c.mjs` → `.mjs`；无扩展名或点文件（`.gitignore`）→ `''`。 */
function extensionOf(path) {
  const name = String(path ?? '')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = name.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

function readWord(src, start) {
  let end = start
  while (end < src.length && isIdentPart(src[end])) end += 1
  return { text: src.slice(start, end), end }
}

function skipSpace(src, index) {
  let i = index
  while (i < src.length && isSpace(src[i])) i += 1
  return i
}

/**
 * 从开引号位置跳到闭引号之后；转义按两字符跳过。模板串额外处理 `${…}`：
 * 插值里可以再出现字符串、模板串与成对花括号，逐层跳过。
 */
function skipString(src, start) {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      i = skipTemplateExpression(src, i + 2)
      continue
    }
    i += 1
  }
  return i
}

/** 从 `${` 之后扫到配对的 `}` 之后；返回的位置一定大于起点。 */
function skipTemplateExpression(src, start) {
  let depth = 1
  let i = start
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i)
      continue
    }
    if (ch === '{') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      i += 1
      if (depth === 0) return i
      continue
    }
    i += 1
  }
  return i
}

/** 把一段文本换成等长空白（换行保留，行号不漂）。 */
function blank(span) {
  let out = ''
  for (const ch of span) out += ch === '\n' ? '\n' : ' '
  return out
}

/**
 * 从 `/` 判断这里是不是正则字面量。启发式与词法器同源：除号的前一个有效
 * token 只能是值（标识符、数字、`)`、`]`、`}`、字符串），其余位置是正则。
 */
function startsRegex(src, index) {
  let p = index - 1
  while (p >= 0 && isSpace(src[p])) p -= 1
  if (p < 0) return true
  const ch = src[p]
  if (ch === ')' || ch === ']' || ch === '}' || ch === '"' || ch === "'" || ch === '`') return false
  if (DIGIT.test(ch)) return false
  if (isIdentPart(ch)) {
    let q = p
    while (q >= 0 && isIdentPart(src[q])) q -= 1
    return REGEX_PREFIX.has(src.slice(q + 1, p + 1))
  }
  return true
}

/**
 * 跳过正则字面量（含 `[...]` 字符类与 `\/` 转义），返回闭 `/` 之后的位置；
 * 同一行内找不到闭合就按除号处理（返回 `start + 1`），避免吞掉后续代码。
 *
 * 不做这一步的代价很大：`/[<>:"|?*]/` 里的引号会被当成字符串起点，
 * 把后面整个文件的括号深度算错（core.mjs 曾因此只扫出 40 条声明）。
 */
function skipRegex(src, start) {
  let inClass = false
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n') return start + 1
    if (inClass) {
      if (ch === ']') inClass = false
      i += 1
      continue
    }
    if (ch === '[') {
      inClass = true
      i += 1
      continue
    }
    if (ch === '/') {
      i += 1
      while (i < src.length && isIdentPart(src[i])) i += 1 // flags
      return i
    }
    i += 1
  }
  return start + 1
}

/** 扫描器共用的「这里是正则吗」判断（注释已剥离的文本同样适用）。 */
function regexAt(src, index) {
  return startsRegex(src, index) ? skipRegex(src, index) : index + 1
}

/**
 * 把注释替换为等长空白，**字符串保留原样**。这样语句扫描既不会被注释里的
 * `import` 误导，也不会破坏字面量里的 specifier。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (ch === '/') {
      const end = regexAt(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 把注释**和字符串**都替换为等长空白。identifiers 只从这份掩码文本里取，
 * 因此字面量里的词不会被当成成员引用。
 */
function mask(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i)
      out += blank(src.slice(i, end))
      i = end
      continue
    }
    if (ch === '/') {
      const end = regexAt(src, i)
      out += blank(src.slice(i, end))
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function computeLineStarts(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 偏移 → 1-based 行号（二分查行首表）。 */
function lineOf(lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 区间 `[start, end)` 去掉尾部空白后的右边界。 */
function trimEnd(src, start, end) {
  let right = end
  while (right > start && isSpace(src[right - 1])) right -= 1
  return right
}

/**
 * 取区间内标识符：剔除属性访问（`.foo`）、声明自身名字、语法噪声词，
 * 去重后按 UTF-16 码元排序（`Array#sort` 默认序，跨平台稳定）。
 */
function collectIdentifiers(masked, start, end, ownName, noise) {
  const span = masked.slice(start, end)
  const run = /[A-Za-z_$][A-Za-z0-9_$]*/g
  const seen = new Set()
  let match = run.exec(span)
  while (match !== null) {
    const word = match[0]
    const at = match.index
    const before = at > 0 ? span[at - 1] : ''
    // `.foo` 是属性访问；`...args` 是展开（保留）；`1e3` 里的 `e3` 不是标识符。
    const property = before === '.' && span[at - 2] !== '.'
    if (!property && !DIGIT.test(before) && word !== ownName && !noise.has(word)) {
      seen.add(word)
    }
    match = run.exec(span)
  }
  return [...seen].sort()
}

// -------------------------------------------------------------- JS / TS 侧

/** 语句起点判定：文件头、换行（ASI）、`;`、`}`，或 `export/default/async/…` 之后。 */
function isStatementStart(src, index) {
  let p = index - 1
  let sawNewline = false
  while (p >= 0 && isSpace(src[p])) {
    if (src[p] === '\n') sawNewline = true
    p -= 1
  }
  if (p < 0) return true
  if (sawNewline) return true
  const ch = src[p]
  if (ch === ';' || ch === '}') return true
  if (!isIdentPart(ch)) return false
  let q = p
  while (q >= 0 && isIdentPart(src[q])) q -= 1
  return STATEMENT_PREFIX.has(src.slice(q + 1, p + 1))
}

/**
 * 声明语句的真正起点：把前面的 `export` / `default` / `async` / `declare` /
 * `abstract` 一起纳入，否则上一条声明的区间会吃掉下一行的 `export` 前缀。
 */
function statementStartOf(code, index) {
  let start = index
  let p = index - 1
  for (;;) {
    while (p >= 0 && isSpace(code[p])) p -= 1
    if (p < 0 || !isIdentPart(code[p])) break
    let q = p
    while (q >= 0 && isIdentPart(code[q])) q -= 1
    const word = code.slice(q + 1, p + 1)
    if (!STATEMENT_PREFIX.has(word)) break
    start = q + 1
    p = q
  }
  return start
}

/** `export function` / `export default class` → true（只回看紧邻的词）。 */
function isExported(src, index) {
  let p = index - 1
  while (p >= 0 && isSpace(src[p])) p -= 1
  if (p < 0 || !isIdentPart(src[p])) return false
  let q = p
  while (q >= 0 && isIdentPart(src[q])) q -= 1
  const prev = src.slice(q + 1, p + 1)
  if (prev === 'export') return true
  if (prev !== 'default') return false
  p = q
  while (p >= 0 && isSpace(src[p])) p -= 1
  if (p < 0 || !isIdentPart(src[p])) return false
  q = p
  while (q >= 0 && isIdentPart(src[q])) q -= 1
  return src.slice(q + 1, p + 1) === 'export'
}

/**
 * 读一条顶层声明（`function` / `class` / `const|let|var`，含 `async function`）。
 * 返回 `{ name, kind, exported, start, headEnd }` 或 `null`；`headEnd` 停在名字
 * 之后，让调用方继续扫描声明体（括号深度照常累计）。
 */
function readJsDeclaration(code, keywordStart, token) {
  let kind = null
  let i = token.end

  if (token.text === 'function') kind = 'function'
  else if (token.text === 'class') kind = 'class'
  else if (token.text === 'const' || token.text === 'let' || token.text === 'var') kind = token.text
  else if (token.text === 'async') {
    const next = skipSpace(code, token.end)
    if (!code.startsWith('function', next) || isIdentPart(code[next + 8])) return null
    kind = 'function'
    i = next + 8
  } else {
    return null
  }

  if (!isStatementStart(code, keywordStart)) return null

  let at = skipSpace(code, i)
  if (kind === 'function' && code[at] === '*') at = skipSpace(code, at + 1)
  // 匿名默认导出 / 解构声明没有单一名字：按已知局限跳过，不漏红。
  if (!isIdentStart(code[at])) return null
  const name = readWord(code, at)

  return {
    name: name.text,
    kind,
    exported: isExported(code, keywordStart),
    start: statementStartOf(code, keywordStart),
    headEnd: name.end,
  }
}

/** 扫描 `import` / `export … from`，按文档序返回 import 边。 */
function scanJsImports(code) {
  const imports = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i)
      continue
    }
    if (ch === '/') {
      i = regexAt(code, i)
      continue
    }
    if (!isIdentStart(ch)) {
      i += 1
      continue
    }
    const token = readWord(code, i)

    if (token.text === 'import') {
      const next = skipSpace(code, token.end)
      if (code[next] === '.') {
        // `import.meta` —— 不是模块边。
        i = token.end
        continue
      }
      if (code[next] === ':') {
        // `{ import: 1 }` 里的属性名，不是语句。
        i = token.end
        continue
      }
      if (code[next] === '(') {
        const dynamic = readDynamicImport(code, token.end)
        if (dynamic) {
          imports.push({ specifier: dynamic.specifier, kind: 'dynamic', offset: i })
          i = dynamic.end
          continue
        }
        i = token.end
        continue
      }
      const clause = readImportClause(code, token.end)
      if (clause) {
        imports.push({ specifier: clause.specifier, kind: clause.kind, offset: i })
        i = clause.end
        continue
      }
      i = token.end
      continue
    }

    if (token.text === 'export') {
      const clause = readExportFrom(code, token.end)
      if (clause) {
        imports.push({ specifier: clause.specifier, kind: 'reexport', offset: i })
        i = clause.end
        continue
      }
    }

    i = token.end
  }
  return imports
}

/** `import('./x.mjs')`：只收字面量实参（变量/模板插值无法静态解析）。 */
function readDynamicImport(code, afterKeyword) {
  const open = skipSpace(code, afterKeyword)
  if (code[open] !== '(') return null
  const arg = skipSpace(code, open + 1)
  const quote = code[arg]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  const end = skipString(code, arg)
  const specifier = code.slice(arg + 1, end - 1)
  if (specifier === '' || specifier.includes('${')) return null
  return { specifier, end }
}

/** `import './x'`（side-effect）与 `import … from './x'`（static）。 */
function readImportClause(code, afterKeyword) {
  let i = skipSpace(code, afterKeyword)
  // TS：`import type { X } from './x'`（`import type from './x'` 是默认导入，不吞）。
  if (code.startsWith('type', i) && !isIdentPart(code[i + 4])) {
    const afterType = skipSpace(code, i + 4)
    if (code[afterType] === '{' || code[afterType] === '*') i = afterType
  }
  if (code[i] === '"' || code[i] === "'") {
    const end = skipString(code, i)
    return { specifier: code.slice(i + 1, end - 1), kind: 'side-effect', end }
  }

  let depth = 0
  const limit = Math.min(code.length, afterKeyword + 4000)
  for (let k = i; k < limit; k += 1) {
    const ch = code[k]
    if (ch === '"' || ch === "'" || ch === '`') {
      k = skipString(code, k) - 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) return null
    else if (depth === 0 && isIdentStart(ch)) {
      const token = readWord(code, k)
      if (token.text === 'from') {
        const at = skipSpace(code, token.end)
        if (code[at] !== '"' && code[at] !== "'") return null
        const end = skipString(code, at)
        return { specifier: code.slice(at + 1, end - 1), kind: 'static', end }
      }
      k = token.end - 1
    }
  }
  return null
}

/** `export { x } from './x'` / `export * from './x'` / `export * as ns from './x'`。 */
function readExportFrom(code, afterKeyword) {
  let i = skipSpace(code, afterKeyword)
  if (code.startsWith('type', i) && !isIdentPart(code[i + 4])) {
    const afterType = skipSpace(code, i + 4)
    if (code[afterType] === '{' || code[afterType] === '*') i = afterType
  }

  if (code[i] === '{') {
    let depth = 0
    let k = i
    for (; k < code.length; k += 1) {
      if (code[k] === '{') depth += 1
      else if (code[k] === '}') {
        depth -= 1
        if (depth === 0) {
          k += 1
          break
        }
      }
    }
    i = skipSpace(code, k)
  } else if (code[i] === '*') {
    i = skipSpace(code, i + 1)
    if (code.startsWith('as', i) && !isIdentPart(code[i + 2])) {
      const alias = readWord(code, skipSpace(code, i + 2))
      i = skipSpace(code, alias.end)
    }
  } else {
    return null // export const / export default / export function …
  }

  if (!code.startsWith('from', i) || isIdentPart(code[i + 4])) return null
  const at = skipSpace(code, i + 4)
  if (code[at] !== '"' && code[at] !== "'") return null
  const end = skipString(code, at)
  return { specifier: code.slice(at + 1, end - 1), end }
}

/**
 * 顶层声明扫描：括号深度 0 处的声明关键字才算顶层（`for (const …)`、函数实参里
 * 的函数表达式都因此被排除）。声明按文档序返回，区间在最后统一计算。
 */
function scanJsDeclarations(source, code) {
  const found = []
  let brace = 0
  let paren = 0
  let bracket = 0
  let i = 0

  while (i < code.length) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i)
      continue
    }
    if (ch === '/') {
      // 正则字面量里的括号/引号不参与深度计算，也不产生声明。
      i = regexAt(code, i)
      continue
    }
    if (ch === '{') {
      brace += 1
      i += 1
      continue
    }
    if (ch === '}') {
      brace = Math.max(0, brace - 1)
      i += 1
      continue
    }
    if (ch === '(') {
      paren += 1
      i += 1
      continue
    }
    if (ch === ')') {
      paren = Math.max(0, paren - 1)
      i += 1
      continue
    }
    if (ch === '[') {
      bracket += 1
      i += 1
      continue
    }
    if (ch === ']') {
      bracket = Math.max(0, bracket - 1)
      i += 1
      continue
    }
    if (!isIdentStart(ch)) {
      i += 1
      continue
    }

    const token = readWord(code, i)
    if (brace === 0 && paren === 0 && bracket === 0) {
      const declaration = readJsDeclaration(code, i, token)
      if (declaration) {
        found.push(declaration)
        i = declaration.headEnd
        continue
      }
    }
    i = token.end
  }

  return finishJsDeclarations(source, found)
}

/**
 * 声明区间 = 声明起点 → 下一个顶层声明起点（或文件尾）；`endLine` 取区间内
 * 最后一个非空白字符所在行（声明之间的空行不算进上一条声明）。
 */
function finishJsDeclarations(source, found) {
  const masked = mask(source)
  const lineStarts = computeLineStarts(source)

  return found.map((declaration, index) => {
    const nextStart = index + 1 < found.length ? found[index + 1].start : source.length
    const start = declaration.start
    const end = Math.max(trimEnd(source, start, nextStart), start)
    return {
      name: declaration.name,
      kind: declaration.kind,
      exported: declaration.exported,
      startLine: lineOf(lineStarts, start),
      endLine: lineOf(lineStarts, Math.max(start, end - 1)),
      identifiers: collectIdentifiers(masked, start, end, declaration.name, JS_NOISE),
    }
  })
}

// ------------------------------------------------------------------ Python

/**
 * Python 掩码：注释（`#` 到行尾）与字符串（单/双引号、三引号跨行）都换成
 * 等长空白。三引号 docstring 因此不会在顶层冒充语句。
 */
function maskPython(src) {
  let out = ''
  let i = 0
  let triple = null

  while (i < src.length) {
    const ch = src[i]

    if (triple) {
      if (src.startsWith(triple, i)) {
        out += blank(triple)
        i += 3
        triple = null
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      const marker = src.slice(i, i + 3)
      if (marker === '"""' || marker === "'''") {
        const close = src.indexOf(marker, i + 3)
        const newline = src.indexOf('\n', i + 3)
        if (close !== -1 && (newline === -1 || close < newline)) {
          out += blank(src.slice(i, close + 3))
          i = close + 3
          continue
        }
        triple = marker
        out += '   '
        i += 3
        continue
      }
      const end = skipPyString(src, i)
      out += blank(src.slice(i, end))
      i = end
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/** 单行 Python 字符串：转义两字符跳过；未闭合时停在行尾（不吞下一行）。 */
function skipPyString(src, start) {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    if (ch === '\n') return i
    i += 1
  }
  return i
}

function splitLines(src) {
  const lines = []
  let offset = 0
  for (const text of src.split('\n')) {
    lines.push({ text, offset })
    offset += text.length + 1
  }
  return lines
}

function leadingWidth(text) {
  let i = 0
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  return i
}

/** `import x` / `import a as b, c` / `from .x import y`（只收列首语句）。 */
function scanPythonImports(source) {
  const masked = maskPython(source)
  const imports = []

  for (const line of splitLines(masked)) {
    const indent = leadingWidth(line.text)
    if (indent !== 0) continue
    const body = line.text.slice(indent).replace(/\s+$/, '')
    if (body === '') continue
    const offset = line.offset + indent

    const direct = /^import\s+(.+)$/.exec(body)
    if (direct) {
      for (const part of direct[1].split(',')) {
        const specifier = part.split(/\s+as\s+/)[0].trim()
        if (specifier !== '') imports.push({ specifier, kind: 'static', offset })
      }
      continue
    }

    const from = /^from\s+(\S+)\s+import\b/.exec(body)
    if (from) imports.push({ specifier: from[1], kind: 'static', offset })
  }

  return imports
}

/**
 * 列首 `def` / `async def` / `class` 与顶层 `NAME = …`。
 * Python 没有导出语法，`exported` 取「名字不以 `_` 开头」（公开名）。
 * 顶层赋值按 `const` 归类：它是模块级绑定，Python 不区分 const/let/var。
 */
function scanPythonDeclarations(source) {
  const masked = maskPython(source)
  const lines = splitLines(masked)
  const declarations = []

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text
    if (leadingWidth(text) !== 0) continue
    const body = text.replace(/\s+$/, '')
    if (body === '') continue

    let name = null
    let kind = null

    const def = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body)
    if (def) {
      name = def[1]
      kind = 'function'
    } else {
      const klass = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body)
      if (klass) {
        name = klass[1]
        kind = 'class'
      } else {
        // 顶层赋值：排除 `==` 比较与增强赋值（`+=` 等在名字后不是裸 `=`）。
        const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/.exec(body)
        if (assign) {
          name = assign[1]
          kind = 'const'
        }
      }
    }

    if (name === null) continue

    // 块结束：缩进回 0 的非空行为止；空行与续行闭括号不截断块。
    let last = index
    for (let j = index + 1; j < lines.length; j += 1) {
      const next = lines[j].text
      if (next.trim() === '') continue
      if (leadingWidth(next) > 0 || /^[)\]}]/.test(next)) last = j
      else break
    }

    const startOffset = lines[index].offset
    const endOffset = lines[last].offset + lines[last].text.length
    const span = masked.slice(startOffset, endOffset)

    declarations.push({
      name,
      kind,
      exported: !name.startsWith('_'),
      startLine: index + 1,
      endLine: last + 1,
      identifiers: collectIdentifiers(span, 0, span.length, name, PY_NOISE),
    })
  }

  return declarations
}

// 已知局限（与 CONTRACT §3.7 对齐；漏扫 = 不要求归属，不产生假红）：
//   - 解构声明（`const { a, b } = x`）与匿名默认导出（`export default () => {}`）
//     没有单一名字，不产生 declaration。
//   - 正则字面量里的 `{`/`}` 会干扰括号深度（`/a{2}/` 这类）；含正则的模块可能
//     少收后续顶层声明。
//   - 模板串插值里的标识符被整体掩码，不进入 identifiers；插值里的 import()
//     也不会被计边。
//   - Python 只收列首（顶层）import；函数内延迟导入与 `if TYPE_CHECKING:` 块内
//     的导入不计边。
//   - Python 顶层赋值只认单个名字（`A = B = 1` 只收 `A`）。
