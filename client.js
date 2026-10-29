/**
 * project-flow — browser half of the project flow board panel.
 *
 * Single file, no build step, no dependencies besides `react` (no JSX).
 * Lives in the right sidebar as one tab type:
 *   - `ctx.sidebarRightTabs.register` — the tab type (id
 *     `@local/project-flow/panel`, kind `project-flow`, priority `extension`) and
 *     its guide card;
 *   - `sidebar.right.pane.tab` (key = tab id) — the tab body;
 *   - `sidebar.right.pane.tab.title` (key = tab id) — the chip title;
 *   - `conversation.session.header.utilities` (id `project-flow`) — one-click
 *     opener; the right bar starts collapsed.
 *
 * The panel is scoped to ONE workspace. `PanelBody` reads the tab's `sessionId`
 * and resolves that session's `cwd` through the `useSessions` prop, then the
 * panel polls `api/project-flow/state?root=<workspace cwd>` (document relative)
 * every 2500 ms, keeps the last good snapshot on failure, and renders:
 *   experiment lineage tree · task ledger progress · gate definitions ·
 *   gate log tail · agent heartbeats · recent run output.
 *
 * Host payload notes (all optional, all tolerated when missing):
 *   - `root` is the workspace the snapshot describes; `roots[]` is only
 *     informational — there is no global project switcher any more, because
 *     the panel must never show a different workspace's ledger;
 *   - a workspace without a ledger answers HTTP 200 `{ ok:false, root, roots,
 *     error: { code: 'not-initialized', message } }`; the panel answers with
 *     the init guidance plus an Initialize button that POSTs the workspace root
 *     to `api/project-flow/init` and then reloads the ledger;
 *   - `contract: { source, schema, name }` renders one footer line saying
 *     whether the ledger is inferred ("defaults") or declared by a file;
 *   - `experiments.source` is `store` (a `.dsh/flow/` store: flat `items`, a
 *     `tree` of `{id, children}`, per-status `counts`) or `git-trailers` (the
 *     legacy `groups` per Factor); the tree renders either shape;
 *   - `gates[]` are gate definitions with an optional `lastRun`; a missing or
 *     null `gates` key (legacy payload) hides the section entirely, while an
 *     empty array shows its empty state;
 *   - `gate: null` means the project turned gate logging off — the gate log
 *     section shows a localized empty state instead of an empty log;
 *   - `tasks.counts.other` covers markdown / no-ledger task sources.
 *
 * Layout is container-query driven: the same component serves a 300 px docked
 * right bar (single column, compact) and a wide/full-screen bar (two columns).
 *
 * Read-only apart from that one init POST: no other writes, no host DOM
 * access, colors only through `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: '@local/project-flow',
  factory(require) {
    'use strict';

    const React = require('react');
    const { useState, useEffect, useMemo, useCallback } = React;

    const NS = 'project-flow';
    /** This implementation's identity in the right-bar tab system. */
    const TAB_ID = '@local/project-flow/panel';
    /** Tab kind passed to `sidebarRight.openTab` when the tab is opened. */
    const TAB_KIND = 'project-flow';
    /** Fixed id of the conversation-header action that opens the tab. */
    const HEADER_ACTION_ID = 'project-flow';
    const STATE_ENDPOINT = 'api/project-flow/state';
    /** The one write the panel may perform: create the ledger in this workspace. */
    const INIT_ENDPOINT = 'api/project-flow/init';
    const POLL_MS = 2500;
    const CLOCK_MS = 1000;
    const MAX_TREE_ROWS = 300;
    const MAX_TREE_DEPTH = 12;
    const MAX_GATE_TAIL_LINES = 8;
    const MAX_GATE_LINES = 10;
    const MAX_RUN_LINES = 8;
    const MAX_WARNINGS = 10;
    const MAX_LIST_ROWS = 25;
    const STALE_AFTER_SECONDS = 6 * 60 * 60;

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // #region locale dictionaries
    /* Key sets of `zh` and `en` must stay identical (bilingual balance). */
    const zh = {
      'tab.title': '项目流',
      'guide.title': '项目流看板',
      'guide.description': '实验树、任务进度与运行信号',
      'action.open': '打开项目流面板',
      'page.title': '项目流',
      'page.readonly': '只读',
      'page.root': '项目',
      'top.head': 'HEAD',
      'top.branch': '分支',
      'top.dirty': '{n} 个未提交改动',
      'top.live': '实时',
      'top.liveStale': '已断开',
      'refresh': '刷新',
      'refresh.aria': '刷新项目数据',
      'refresh.busy': '刷新中…',
      'time.justNow': '刚刚',
      'time.secondsAgo': '{n} 秒前',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'stale.text': '连接失败，显示 {time}的数据',
      'loading': '读取中…',
      'error.title': '无法读取实验状态',
      'error.retry': '重试',
      'error.noProject': '当前目录不是可读取的项目。',
      'error.forbidden': '目标路径不允许读取。',
      'error.badRoot': '项目路径无效。',
      'error.generic': '未知错误。',
      'exp.title': '实验树',
      'exp.confirmed': '已确认',
      'exp.refuted': '已证伪',
      'exp.open': '未验证',
      'exp.total': '总数',
      'exp.empty': '还没有带实验记录的提交。',
      'exp.emptyHint': '提交带实验 trailer 的 commit 后，实验会出现在这里。',
      'exp.empty.store': '还没有实验记录。',
      'exp.emptyHint.store': '运行 flow exp add … 或使用 flow_exp 工具添加第一条实验。',
      'exp.more': '还有 {n} 条未显示',
      'exp.openBanner': '○ {n} 条假设还没验证',
      'exp.detail.hypothesis': '假设',
      'exp.detail.expected': '预期',
      'exp.detail.measured': '实测',
      'exp.detail.none': '未记录',
      'exp.metrics': '指标',
      'exp.notes': '备注',
      'exp.parent': '父实验',
      'exp.commits': '提交',
      'exp.source.store': 'store',
      'exp.source.trailers': 'git trailer',
      'exp.status.open': '未验证',
      'exp.status.confirmed': '已确认',
      'exp.status.refuted': '已证伪',
      'exp.status.abandoned': '已放弃',
      'tasks.title': '任务进度',
      'tasks.total': '共 {n} 个任务',
      'tasks.status.draft': '草稿',
      'tasks.status.active': '进行中',
      'tasks.status.done': '已完成',
      'tasks.status.archived': '已归档',
      'tasks.status.other': '其它',
      'tasks.current': '当前任务',
      'tasks.currentNone': '无',
      'tasks.active': '进行中',
      'tasks.activeEmpty': '任务台账里没有进行中的任务。',
      'tasks.recent': '最近完成',
      'tasks.recentEmpty': '任务台账里还没有完成的任务。',
      'tasks.owner': '负责人',
      'tasks.gate.pass': '门禁通过',
      'tasks.gate.fail': '门禁失败',
      'gates.title': '门禁',
      'gates.empty': '还没有门禁定义；用 flow gate add 创建',
      'gates.phase.commit': '提交',
      'gates.phase.release': '发布',
      'gates.phase.manual': '手动',
      'gates.never': '从未运行',
      'gates.run.ok': '✔ {time}',
      'gates.run.fail': '✘ {time}',
      'gates.steps': '步骤',
      'signals.title': '实时信号',
      'signals.gate': '门禁日志',
      'signals.gate.updated': '更新于 {time}',
      'signals.gate.empty': '还没有门禁日志。',
      'signals.gate.disabled': '该项目未启用门禁日志。',
      'signals.heartbeat': '心跳',
      'signals.heartbeat.empty': '没有心跳文件。',
      'signals.heartbeat.stale': '可能已停',
      'signals.runs': '运行输出',
      'signals.runs.empty': '近 15 分钟没有运行中的输出。',
      'signals.runs.lines': '尾部 {n} 行',
      'section.collapse': '收起',
      'section.expand': '展开',
      'footer.source': '项目',
      'footer.generated': '生成于',
      'footer.contract': '契约：{source}',
      'contract.defaults': '默认布局',
      'footer.warnings': '{n} 条警告',
      'footer.warningsNone': '无警告',
      'footer.warningsTitle': '警告',
      'workspace.pending': '正在读取当前工作区…',
      'empty.title': '未初始化',
      'empty.init': '初始化',
      'empty.initializing': '初始化中…',
      'error.notInitialized': '这个工作区还没有项目流台账。',
      'error.initHint': '点「初始化」在当前工作区创建 .dsh/flow 台账，或在项目根运行 node bin/flow.mjs init。',
      'error.initFailed': '初始化失败：{message}',
      'misc.dash': '—',
    };

    const en = {
      'tab.title': 'Project Flow',
      'guide.title': 'Project flow board',
      'guide.description': 'Experiments, tasks and live signals',
      'action.open': 'Open the project flow panel',
      'page.title': 'Project Flow',
      'page.readonly': 'Read-only',
      'page.root': 'Project',
      'top.head': 'HEAD',
      'top.branch': 'Branch',
      'top.dirty': '{n} uncommitted',
      'top.live': 'live',
      'top.liveStale': 'disconnected',
      'refresh': 'Refresh',
      'refresh.aria': 'Refresh project data',
      'refresh.busy': 'Refreshing…',
      'time.justNow': 'just now',
      'time.secondsAgo': '{n}s ago',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n}h ago',
      'time.daysAgo': '{n}d ago',
      'stale.text': 'Connection failed · data from {time}',
      'loading': 'Loading…',
      'error.title': 'Cannot read experiment state',
      'error.retry': 'Retry',
      'error.noProject': 'This directory is not a readable project.',
      'error.forbidden': 'The requested path is not readable.',
      'error.badRoot': 'The project path is invalid.',
      'error.generic': 'Unexpected error.',
      'exp.title': 'Experiment tree',
      'exp.confirmed': 'confirmed',
      'exp.refuted': 'refuted',
      'exp.open': 'open',
      'exp.total': 'total',
      'exp.empty': 'No commit carries an experiment record yet.',
      'exp.emptyHint': 'Commit with an experiment trailer and it shows up here.',
      'exp.empty.store': 'No experiments recorded yet.',
      'exp.emptyHint.store': 'Run flow exp add … or add the first one with the flow_exp tool.',
      'exp.more': '{n} more not shown',
      'exp.openBanner': '○ {n} hypotheses not yet tested',
      'exp.detail.hypothesis': 'Hypothesis',
      'exp.detail.expected': 'Expected',
      'exp.detail.measured': 'Measured',
      'exp.detail.none': 'not recorded',
      'exp.metrics': 'Metrics',
      'exp.notes': 'Notes',
      'exp.parent': 'Parent',
      'exp.commits': 'Commits',
      'exp.source.store': 'store',
      'exp.source.trailers': 'git trailers',
      'exp.status.open': 'open',
      'exp.status.confirmed': 'confirmed',
      'exp.status.refuted': 'refuted',
      'exp.status.abandoned': 'abandoned',
      'tasks.title': 'Task progress',
      'tasks.total': '{n} tasks',
      'tasks.status.draft': 'draft',
      'tasks.status.active': 'active',
      'tasks.status.done': 'done',
      'tasks.status.archived': 'archived',
      'tasks.status.other': 'other',
      'tasks.current': 'Current task',
      'tasks.currentNone': 'none',
      'tasks.active': 'In progress',
      'tasks.activeEmpty': 'No task in the ledger is in progress.',
      'tasks.recent': 'Recently completed',
      'tasks.recentEmpty': 'Nothing in the ledger is completed yet.',
      'tasks.owner': 'owner',
      'tasks.gate.pass': 'gate pass',
      'tasks.gate.fail': 'gate fail',
      'gates.title': 'Gates',
      'gates.empty': 'No gate definitions yet; create one with flow gate add',
      'gates.phase.commit': 'commit',
      'gates.phase.release': 'release',
      'gates.phase.manual': 'manual',
      'gates.never': 'never run',
      'gates.run.ok': '✔ {time}',
      'gates.run.fail': '✘ {time}',
      'gates.steps': 'Steps',
      'signals.title': 'Live signals',
      'signals.gate': 'Gate log',
      'signals.gate.updated': 'updated {time}',
      'signals.gate.empty': 'No gate log yet.',
      'signals.gate.disabled': 'This project has no gate log.',
      'signals.heartbeat': 'Heartbeats',
      'signals.heartbeat.empty': 'No heartbeat files.',
      'signals.heartbeat.stale': 'possibly stopped',
      'signals.runs': 'Run output',
      'signals.runs.empty': 'No run output in the last 15 minutes.',
      'signals.runs.lines': 'last {n} lines',
      'section.collapse': 'Collapse',
      'section.expand': 'Expand',
      'footer.source': 'project',
      'footer.generated': 'generated',
      'footer.contract': 'contract: {source}',
      'contract.defaults': 'default layout',
      'footer.warnings': '{n} warnings',
      'footer.warningsNone': 'no warnings',
      'footer.warningsTitle': 'Warnings',
      'workspace.pending': 'Reading the current workspace…',
      'empty.title': 'Not initialized',
      'empty.init': 'Initialize',
      'empty.initializing': 'Initializing…',
      'error.notInitialized': 'This workspace has no project flow ledger yet.',
      'error.initHint': 'Click Initialize to create the .dsh/flow ledger in this workspace, or run node bin/flow.mjs init in the project root.',
      'error.initFailed': 'Initialization failed: {message}',
      'misc.dash': '—',
    };
    // #endregion

    // #region defensive helpers
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function asText(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }

    function asNumber(value, fallback) {
      let number = NaN;
      if (typeof value === 'number') number = value;
      else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function shortSha(value) {
      const text = asText(value);
      return text ? text.slice(0, 7) : '';
    }

    function absoluteDate(ms) {
      try {
        const date = new Date(ms);
        if (!Number.isFinite(date.getTime())) return null;
        const pad = (n) => (n < 10 ? '0' + n : String(n));
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      } catch (error) {
        return null;
      }
    }

    /** Seconds-ish duration to localized "3 分钟前" text; null when over a week. */
    function relativeFromSeconds(seconds, t) {
      if (!Number.isFinite(seconds)) return null;
      const value = Math.max(0, seconds);
      if (value < 5) return t('time.justNow');
      if (value < 60) return t('time.secondsAgo', { n: Math.round(value) });
      if (value < 3600) return t('time.minutesAgo', { n: Math.round(value / 60) });
      if (value < 86400) return t('time.hoursAgo', { n: Math.round(value / 3600) });
      if (value < 7 * 86400) return t('time.daysAgo', { n: Math.round(value / 86400) });
      return null;
    }

    /** Relative text for a timestamp; falls back to the calendar date past a week. */
    function relativeMoment(ms, now, t) {
      if (!Number.isFinite(ms) || ms <= 0) return null;
      const relative = relativeFromSeconds((now - ms) / 1000, t);
      return relative || absoluteDate(ms);
    }

    /** Relative text for a host `ageSeconds`, with mtime as the absolute fallback. */
    function ageText(ageSeconds, mtime, now, t) {
      let seconds = Number.isFinite(ageSeconds) ? ageSeconds : null;
      if (seconds === null && Number.isFinite(mtime) && Number.isFinite(now)) {
        seconds = (now - mtime) / 1000;
      }
      if (seconds === null) return null;
      const relative = relativeFromSeconds(seconds, t);
      if (relative) return relative;
      if (Number.isFinite(mtime)) return absoluteDate(mtime);
      return absoluteDate(now - seconds * 1000);
    }

    function formatBytes(size) {
      if (!Number.isFinite(size) || size < 0) return '';
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
      return (size / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function basename(path) {
      const text = asText(path);
      if (!text) return '';
      const parts = text.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : text;
    }

    function verdictOf(verdict) {
      const value = asText(verdict);
      if (value === 'confirmed') return { cls: 'confirmed', glyph: '\u2714' };
      if (value === 'refuted') return { cls: 'refuted', glyph: '\u2718' };
      if (value === 'abandoned') return { cls: 'abandoned', glyph: '\u2298' };
      return { cls: 'open', glyph: '\u25cb' };
    }

    /** Compact duration for a gate run: "850ms" · "1.2s" · "2m 5s". */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return seconds > 0 ? minutes + 'm ' + seconds + 's' : minutes + 'm';
    }

    function joinParts(parts) {
      return parts.filter((part) => part !== null && part !== undefined && part !== '').join(' \u00b7 ');
    }
    // #endregion

    // #region state normalization
    /** One flat store experiment; legacy group items are not passed through here. */
    function normalizeItem(raw) {
      const item = asObject(raw);
      return {
        id: asText(item.id),
        title: asText(item.title),
        hypothesis: asText(item.hypothesis),
        factor: asText(item.factor),
        parent: asText(item.parent) || null,
        status: asText(item.status) || asText(item.verdict),
        verdict: asText(item.verdict),
        expected: asText(item.expected),
        measured: asText(item.measured),
        scale: asText(item.scale),
        metrics: item.metrics === undefined ? null : item.metrics,
        commits: asArray(item.commits).map(asText).filter(Boolean),
        created_at: asText(item.created_at),
        updated_at: asText(item.updated_at),
        notes: asText(item.notes),
        at: asText(item.at),
        date: asText(item.date),
        sha: asText(item.sha),
      };
    }

    /** `tree` nodes are `{id, children[]}`; the item data is looked up by id. */
    function normalizeTreeNode(rawNode, depth) {
      const node = asObject(rawNode);
      return {
        id: asText(node.id),
        children:
          depth < MAX_TREE_DEPTH
            ? asArray(node.children)
                .filter((child) => child && typeof child === 'object' && !Array.isArray(child))
                .map((child) => normalizeTreeNode(child, depth + 1))
            : [],
      };
    }

    function normalizeGate(rawGate) {
      const gate = asObject(rawGate);
      const lastSrc =
        gate.lastRun && typeof gate.lastRun === 'object' && !Array.isArray(gate.lastRun)
          ? asObject(gate.lastRun)
          : null;
      let lastRun = null;
      if (lastSrc) {
        const startedAt = asText(lastSrc.started_at);
        lastRun = {
          startedAt,
          startedMs: asNumber(Date.parse(startedAt), null),
          ok: lastSrc.ok === true,
          durationMs: asNumber(lastSrc.durationMs, null),
          steps: asArray(lastSrc.steps)
            .filter((step) => step && typeof step === 'object' && !Array.isArray(step))
            .map((step) => {
              const result = asObject(step);
              return {
                id: asText(result.id),
                exit: asNumber(result.exit, null),
                ok: result.ok === true,
                tail: asText(result.tail),
              };
            }),
        };
      }
      return {
        id: asText(gate.id),
        title: asText(gate.title),
        phase: asText(gate.phase),
        enabled: gate.enabled === false ? false : true,
        steps: asArray(gate.steps)
          .filter((step) => step && typeof step === 'object' && !Array.isArray(step))
          .map((step) => {
            const definition = asObject(step);
            return {
              id: asText(definition.id),
              run: asText(definition.run),
              expect: asText(definition.expect),
              timeoutSeconds: asNumber(definition.timeoutSeconds, null),
            };
          }),
        lastRun,
      };
    }

    /** `undefined`/`null` hides the section (legacy payload); `[]` shows it empty. */
    function normalizeGates(rawGates) {
      if (rawGates === undefined || rawGates === null) return null;
      return asArray(rawGates)
        .filter((gate) => gate && typeof gate === 'object' && !Array.isArray(gate))
        .map(normalizeGate);
    }

    /** Tolerant mapping of the host payload; never throws on missing fields. */
    function normalize(payload) {
      const src = asObject(payload);
      const headSrc = asObject(src.head);
      /* Contract spelling is `experiments`; `exp` stays accepted for older hosts. */
      const expSrc = asObject(src.experiments !== undefined ? src.experiments : src.exp);
      const tasksSrc = asObject(src.tasks);
      const gateSrc = asObject(src.gate);
      /* `gate: null` means the project turned the gate section off (not "empty"). */
      const gateDisabled = src.gate === null;
      /* `contract` is optional; when absent the footer line is hidden entirely. */
      const contractSrc =
        src.contract && typeof src.contract === 'object' && !Array.isArray(src.contract)
          ? src.contract
          : null;

      const groups = asArray(expSrc.groups).map((rawGroup) => {
        const group = asObject(rawGroup);
        return {
          factor: asText(group.factor),
          items: asArray(group.items).filter((item) => item && typeof item === 'object'),
        };
      });

      /* Store mode: flat `items` + a `tree` of `{id, children}` + status `counts`. */
      const items = asArray(expSrc.items)
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map(normalizeItem);
      const tree = asArray(expSrc.tree)
        .filter((node) => node && typeof node === 'object' && !Array.isArray(node))
        .map((node) => normalizeTreeNode(node, 0));
      const storeMode = asText(expSrc.source) === 'store' || items.length > 0 || tree.length > 0;

      /* Legacy tally from `groups`; store tally from each item's `status`. */
      let legacyConfirmed = 0;
      let legacyRefuted = 0;
      let legacyOpen = 0;
      groups.forEach((group) => {
        group.items.forEach((item) => {
          const verdict = asText(item.verdict);
          if (verdict === 'confirmed') legacyConfirmed += 1;
          else if (verdict === 'refuted') legacyRefuted += 1;
          else legacyOpen += 1;
        });
      });
      const statusTally = { open: 0, confirmed: 0, refuted: 0, abandoned: 0 };
      items.forEach((item) => {
        if (Object.prototype.hasOwnProperty.call(statusTally, item.status)) statusTally[item.status] += 1;
      });
      const tallies = storeMode
        ? statusTally
        : { open: legacyOpen, confirmed: legacyConfirmed, refuted: legacyRefuted, abandoned: 0 };
      const expCounts = asObject(expSrc.counts);
      /* Explicit top-level counts (older hosts) stay ahead of the tally. */
      const counts = {
        open: asNumber(expCounts.open, asNumber(expSrc.open, tallies.open)),
        confirmed: asNumber(expCounts.confirmed, asNumber(expSrc.confirmed, tallies.confirmed)),
        refuted: asNumber(expCounts.refuted, asNumber(expSrc.refuted, tallies.refuted)),
        abandoned: asNumber(expCounts.abandoned, tallies.abandoned),
      };
      const expTotal = asNumber(
        expSrc.total,
        counts.open + counts.confirmed + counts.refuted + counts.abandoned
      );

      const taskCountsSrc = asObject(tasksSrc.counts);
      const gates = normalizeGates(src.gates);
      const warnings = asArray(src.warnings).map(asText).filter(Boolean);

      return {
        generatedAt: asText(src.generatedAt),
        contract: contractSrc
          ? {
              source: asText(contractSrc.source),
              schema: asNumber(contractSrc.schema, null),
              name: asText(contractSrc.name),
            }
          : null,
        root: asText(src.root),
        roots: asArray(src.roots)
          .filter((entry) => asText(asObject(entry).path))
          .map((entry) => {
            const root = asObject(entry);
            return { path: asText(root.path), name: asText(root.name) || asText(root.path) };
          }),
        head: {
          sha: asText(headSrc.sha),
          subject: asText(headSrc.subject),
          branch: asText(headSrc.branch),
          dirty: asNumber(headSrc.dirty, 0),
        },
        exp: {
          source: asText(expSrc.source) || 'git-trailers',
          store: storeMode,
          total: expTotal,
          confirmed: counts.confirmed,
          refuted: counts.refuted,
          open: counts.open,
          abandoned: counts.abandoned,
          counts,
          items,
          tree,
          groups,
        },
        tasks: {
          total: asNumber(tasksSrc.total, 0),
          counts: {
            draft: asNumber(taskCountsSrc.draft, 0),
            active: asNumber(taskCountsSrc.active, 0),
            done: asNumber(taskCountsSrc.done, 0),
            archived: asNumber(taskCountsSrc.archived, 0),
            /* Markdown / no-ledger projects often report only this bucket. */
            other: asNumber(taskCountsSrc.other, 0),
          },
          current: tasksSrc.current === undefined ? null : tasksSrc.current,
          active: asArray(tasksSrc.active).filter((task) => task && typeof task === 'object'),
          recentDone: asArray(tasksSrc.recentDone).filter((task) => task && typeof task === 'object'),
        },
        gates,
        gate: {
          disabled: gateDisabled,
          lines: asArray(gateSrc.lines).map(asText),
          mtime: asNumber(gateSrc.mtime, null),
          size: asNumber(gateSrc.size, null),
        },
        heartbeats: asArray(src.heartbeats)
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            file: asText(entry.file),
            title: asText(entry.title),
            statusLine: asText(entry.statusLine),
            ageSeconds: asNumber(entry.ageSeconds, null),
            mtime: asNumber(entry.mtime, null),
          })),
        runs: asArray(src.runs)
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            path: asText(entry.path),
            ageSeconds: asNumber(entry.ageSeconds, null),
            size: asNumber(entry.size, null),
            lines: asArray(entry.lines).map(asText),
          })),
        warnings,
      };
    }
    // #endregion

    // #region icon
    /** Sidebar glyph: a small branch/experiment tree in currentColor. */
    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 20;
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: 'M4.75 3.5v13' }),
        React.createElement('path', { d: 'M4.75 6.75h4.25' }),
        React.createElement('path', { d: 'M4.75 13.25h4.25' }),
        React.createElement('circle', { cx: 12.4, cy: 6.75, r: 2.4, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 12.4, cy: 13.25, r: 2.4, fill: 'currentColor', stroke: 'none' })
      );
    }

    /**
     * Small glyph for the guide card and the tab chip. The guide host calls the
     * icon with its own `size` (22/26 px); everything else falls back to 16.
     */
    function PanelGlyph(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16;
      return React.createElement(PanelIcon, { size });
    }
    // #endregion

    // #region small presentational pieces
    function Caret(props) {
      return React.createElement(
        'span',
        { className: 'project-flow-caret' + (props.open ? '' : ' project-flow-caret--collapsed'), 'aria-hidden': 'true' },
        '\u25be'
      );
    }

    function Chip(props) {
      return React.createElement(
        'span',
        { className: 'project-flow-chip' + (props.tone ? ' project-flow-chip--' + props.tone : '') },
        props.children
      );
    }

    function Section(props) {
      return React.createElement(
        'div',
        { className: 'project-flow-section' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'project-flow-sectionHead',
            'aria-expanded': props.open ? true : false,
            onClick: props.onToggle,
          },
          React.createElement(Caret, { open: props.open }),
          React.createElement('span', { className: 'project-flow-sectionTitle' }, props.title),
          Number.isFinite(props.count) ? React.createElement('span', { className: 'project-flow-count' }, ' (' + props.count + ')') : null
        ),
        props.open ? React.createElement('div', { className: 'project-flow-sectionBody' }, props.children) : null
      );
    }

    function EmptyLine(props) {
      return React.createElement('p', { className: 'project-flow-empty' }, props.children);
    }

    function ListRow(props) {
      return React.createElement(
        'li',
        { className: 'project-flow-listRow' },
        props.leading ? React.createElement('span', { className: 'project-flow-listLeading' }, props.leading) : null,
        React.createElement('span', { className: 'project-flow-listId' }, props.id || ''),
        React.createElement(
          'span',
          { className: 'project-flow-listTitle', title: props.title || undefined },
          props.title || '—'
        ),
        props.meta ? React.createElement('span', { className: 'project-flow-listMeta' }, props.meta) : null
      );
    }
    // #endregion

    // #region experiment tree
    /** `metrics` may arrive as an object or as `{key, value}` entries. */
    function metricsText(metrics) {
      if (!metrics) return '';
      if (Array.isArray(metrics)) {
        return metrics
          .map((entry) => {
            if (entry && typeof entry === 'object') {
              const key = asText(entry.key !== undefined ? entry.key : entry.name);
              const value = asText(entry.value);
              if (key && value) return key + ': ' + value;
              return key || value;
            }
            return asText(entry);
          })
          .filter(Boolean)
          .join('\n');
      }
      if (typeof metrics !== 'object') return asText(metrics);
      return Object.keys(metrics)
        .map((key) => key + ': ' + asText(metrics[key]))
        .join('\n');
    }

    function DetailBlock(props) {
      const item = asObject(props.item);
      const t = props.t;
      const rows = [
        { label: t('exp.detail.hypothesis'), value: item.hypothesis },
        { label: t('exp.detail.expected'), value: item.expected },
        { label: t('exp.detail.measured'), value: item.measured },
      ];
      const metrics = metricsText(item.metrics);
      if (metrics) rows.push({ label: t('exp.metrics'), value: metrics });
      if (asText(item.notes)) rows.push({ label: t('exp.notes'), value: item.notes });
      /* A parent is display-only text: the tree already draws the lineage. */
      if (asText(item.parent)) rows.push({ label: t('exp.parent'), value: item.parent });
      const commits = asArray(item.commits).map(shortSha).filter(Boolean).join(', ');
      if (commits) rows.push({ label: t('exp.commits'), value: commits });
      return React.createElement(
        'div',
        { className: 'project-flow-detail' },
        rows.map((row, index) =>
          React.createElement(
            'div',
            { className: 'project-flow-detailItem', key: 'detail-' + index },
            React.createElement('span', { className: 'project-flow-detailLabel' }, row.label),
            React.createElement(
              'pre',
              { className: 'project-flow-detailValue' },
              asText(row.value) || t('exp.detail.none')
            )
          )
        )
      );
    }

    /** Stand-in item for a tree node whose id is absent from `items`. */
    function blankItem(id) {
      return normalizeItem({ id });
    }

    function hydrateNode(rawNode, itemById, seen, depth) {
      const node = asObject(rawNode);
      const id = asText(node.id);
      const item = id && itemById[id] ? itemById[id] : blankItem(id);
      if (depth >= MAX_TREE_DEPTH) return { item, children: [] };
      if (id) {
        if (seen[id]) return { item, children: [] };
        seen[id] = true;
      }
      const children = asArray(node.children)
        .filter((child) => child && typeof child === 'object' && !Array.isArray(child))
        .map((child) => hydrateNode(child, itemById, seen, depth + 1));
      return { item, children };
    }

    /** The payload `tree` wins; without it the forest is rebuilt from `parent`. */
    function composeTree(exp) {
      const items = asArray(exp.items);
      const nodes = asArray(exp.tree);
      const itemById = Object.create(null);
      items.forEach((item) => {
        if (item && item.id && !itemById[item.id]) itemById[item.id] = item;
      });
      if (nodes.length > 0) {
        const seen = Object.create(null);
        return nodes
          .filter((node) => node && typeof node === 'object' && !Array.isArray(node))
          .map((node) => hydrateNode(node, itemById, seen, 0));
      }
      if (items.length === 0) return [];

      const childrenOf = Object.create(null);
      const roots = [];
      items.forEach((item) => {
        const parentId = item.parent && item.parent !== item.id && itemById[item.parent] ? item.parent : '';
        if (!parentId) {
          roots.push(item);
          return;
        }
        if (!childrenOf[parentId]) childrenOf[parentId] = [];
        childrenOf[parentId].push(item);
      });

      const seen = Object.create(null);
      const build = (item, depth) => {
        if (depth >= MAX_TREE_DEPTH || seen[item.id]) return { item, children: [] };
        seen[item.id] = true;
        const children = asArray(childrenOf[item.id]).map((child) => build(child, depth + 1));
        return { item, children };
      };
      /* A parent cycle would leave every node parented; promote all to roots. */
      const top = roots.length > 0 ? roots : items;
      return top.map((item) => build(item, 0));
    }

    /** Flatten the forest; every row carries its own `├─` / `└─` prefix. */
    function flattenTree(nodes, ancestors, out) {
      const list = asArray(nodes);
      list.forEach((node, index) => {
        const last = index === list.length - 1;
        let prefix = '';
        ancestors.forEach((hasNext) => {
          prefix += hasNext ? '\u2502  ' : '   ';
        });
        prefix += last ? '\u2514\u2500' : '\u251c\u2500';
        out.push({ item: node.item, children: node.children, prefix });
        /* A leaf draws no extra connector: only its own line is emitted. */
        if (asArray(node.children).length > 0) {
          flattenTree(node.children, ancestors.concat(!last), out);
        }
      });
      return out;
    }

    function ExperimentTree(props) {
      const exp = props.exp || {};
      const t = props.t;
      const now = props.now;
      const [collapsedGroups, setCollapsedGroups] = useState({});
      const [openItems, setOpenItems] = useState({});

      const toggleGroup = (factor) => {
        setCollapsedGroups((previous) => {
          const next = Object.assign({}, previous);
          if (next[factor]) delete next[factor];
          else next[factor] = true;
          return next;
        });
      };

      const toggleItem = (key) => {
        setOpenItems((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      const groups = asArray(exp.groups);
      const items = asArray(exp.items);
      const storeMode = exp.store === true || items.length > 0 || asArray(exp.tree).length > 0;
      const counts = asObject(exp.counts);
      const confirmed = asNumber(counts.confirmed, asNumber(exp.confirmed, 0));
      const refuted = asNumber(counts.refuted, asNumber(exp.refuted, 0));
      const openCount = asNumber(counts.open, asNumber(exp.open, 0));
      const abandoned = asNumber(counts.abandoned, 0);
      const total = asNumber(exp.total, confirmed + refuted + openCount + abandoned);

      const children = [];
      const treeRows = storeMode ? flattenTree(composeTree(exp), [], []) : [];
      let budget = MAX_TREE_ROWS;
      let hidden = 0;

      if (treeRows.length > 0) {
        treeRows.forEach((row, index) => {
          if (budget <= 0) {
            hidden += 1;
            return;
          }
          budget -= 1;
          const item = row.item || {};
          const key = 'tree-' + index + '-' + (item.id || '');
          const expanded = openItems[key] === true;
          const verdict = verdictOf(asText(item.status) || asText(item.verdict));
          const label = asText(item.title) || asText(item.hypothesis);
          const meta = joinParts([
            asText(item.scale),
            relativeMoment(Date.parse(asText(item.updated_at)), now, t) || '',
            shortSha(asArray(item.commits)[0]),
          ]);

          children.push(
            React.createElement(
              'div',
              { className: 'project-flow-treeItem', key },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'project-flow-row',
                  'aria-expanded': expanded ? true : false,
                  title: asText(item.hypothesis) || label || undefined,
                  onClick: () => toggleItem(key),
                },
                React.createElement('span', { className: 'project-flow-branch', 'aria-hidden': 'true' }, row.prefix),
                React.createElement(
                  'span',
                  { className: 'project-flow-verdict project-flow-verdict--' + verdict.cls, 'aria-hidden': 'true' },
                  verdict.glyph
                ),
                React.createElement('span', { className: 'project-flow-rowId' }, asText(item.id) || t('misc.dash')),
                React.createElement('span', { className: 'project-flow-rowHyp' }, label || t('misc.dash')),
                React.createElement('span', { className: 'project-flow-rowMeta' }, meta)
              ),
              expanded ? React.createElement(DetailBlock, { item, t }) : null
            )
          );
        });
      } else {
        // 未验证的假设永远置顶：这是「容易忘」的部分（legacy 分组模式）。
        const openList = [];
        groups.forEach((group) => {
          asArray(group.items).forEach((item) => {
            if (!item || item.verdict) return;
            openList.push(item);
          });
        });
        if (openList.length > 0) {
          const openRows = openList.slice(0, 5).map((item) =>
            React.createElement(
              'div',
              { className: 'project-flow-row', key: 'open-' + item.id },
              React.createElement('span', { className: 'project-flow-verdict project-flow-verdict--open', 'aria-hidden': 'true' }, '\u25cb'),
              React.createElement('span', { className: 'project-flow-rowId' }, asText(item.id)),
              React.createElement('span', { className: 'project-flow-rowHyp' }, asText(item.hypothesis) || t('misc.dash'))
            )
          );
          children.push(
            React.createElement(
              'div',
              { className: 'project-flow-guide', key: 'open-box' },
              React.createElement('p', { className: 'project-flow-guideTitle' }, t('exp.openBanner', { n: openList.length })),
              openRows,
              openList.length > openRows.length
                ? React.createElement('p', { className: 'project-flow-muted' }, t('exp.more', { n: openList.length - openRows.length }))
                : null
            )
          );
        }

        groups.forEach((group, groupIndex) => {
          const factor = group.factor || t('misc.dash');
          const groupKey = 'group-' + groupIndex + '-' + factor;
          const collapsed = collapsedGroups[groupKey] === true;
          children.push(
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'project-flow-groupHead',
                key: groupKey,
                'aria-expanded': collapsed ? false : true,
                onClick: () => toggleGroup(groupKey),
              },
              React.createElement(Caret, { open: !collapsed }),
              React.createElement('span', { className: 'project-flow-groupName', title: factor }, factor),
              React.createElement('span', { className: 'project-flow-count' }, ' (' + group.items.length + ')')
            )
          );
          if (collapsed) return;

          group.items.forEach((item, itemIndex) => {
            if (budget <= 0) {
              hidden += 1;
              return;
            }
            budget -= 1;
            const id = asText(item.id) || t('misc.dash');
            const verdict = verdictOf(item.verdict);
            const itemKey = 'item-' + groupIndex + '-' + itemIndex;
            const expanded = openItems[itemKey] === true;
            const hypothesis = asText(item.hypothesis);
            const meta = joinParts([asText(item.scale), asText(item.at) || asText(item.date), shortSha(item.sha)]);
            const isLast = itemIndex === group.items.length - 1;

            children.push(
              React.createElement(
                'div',
                { className: 'project-flow-treeItem', key: itemKey },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'project-flow-row',
                    'aria-expanded': expanded ? true : false,
                    title: hypothesis || undefined,
                    onClick: () => toggleItem(itemKey),
                  },
                  React.createElement('span', { className: 'project-flow-connector', 'aria-hidden': 'true' }, isLast ? '\u2514\u2500' : '\u251c\u2500'),
                  React.createElement('span', { className: 'project-flow-verdict project-flow-verdict--' + verdict.cls, 'aria-hidden': 'true' }, verdict.glyph),
                  React.createElement('span', { className: 'project-flow-rowId' }, id),
                  React.createElement('span', { className: 'project-flow-rowHyp' }, hypothesis || t('misc.dash')),
                  React.createElement('span', { className: 'project-flow-rowMeta' }, meta)
                ),
                expanded ? React.createElement(DetailBlock, { item, t }) : null
              )
            );
          });
        });
      }

      if (hidden > 0) {
        children.push(
          React.createElement('p', { className: 'project-flow-muted project-flow-more', key: 'more' }, t('exp.more', { n: hidden }))
        );
      }

      const chips = [
        React.createElement(Chip, { key: 'source', tone: 'brand' }, t(storeMode ? 'exp.source.store' : 'exp.source.trailers')),
        React.createElement(Chip, { key: 'confirmed', tone: 'ok' }, '\u2714 ' + confirmed + ' ' + t('exp.status.confirmed')),
        React.createElement(Chip, { key: 'refuted', tone: 'error' }, '\u2718 ' + refuted + ' ' + t('exp.status.refuted')),
        React.createElement(Chip, { key: 'open', tone: 'warn' }, '\u25cb ' + openCount + ' ' + t('exp.status.open')),
      ];
      if (abandoned > 0) {
        chips.push(
          React.createElement(Chip, { key: 'abandoned' }, '\u2298 ' + abandoned + ' ' + t('exp.status.abandoned'))
        );
      }
      chips.push(React.createElement(Chip, { key: 'total' }, total + ' ' + t('exp.total')));

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          React.createElement('h2', { className: 'project-flow-cardTitle' }, t('exp.title')),
          React.createElement('div', { className: 'project-flow-chips' }, chips)
        ),
        total === 0
          ? React.createElement(
              'div',
              { className: 'project-flow-guide' },
              React.createElement('p', { className: 'project-flow-guideTitle' }, t(storeMode ? 'exp.empty.store' : 'exp.empty')),
              React.createElement('p', { className: 'project-flow-muted' }, t(storeMode ? 'exp.emptyHint.store' : 'exp.emptyHint'))
            )
          : children.length === 0
            ? React.createElement(EmptyLine, null, t('misc.dash'))
            : React.createElement('div', { className: 'project-flow-tree' }, children)
      );
    }
    // #endregion

    // #region right column cards
    function TasksCard(props) {
      const tasks = props.tasks || {};
      const counts = asObject(tasks.counts);
      const activeTasks = asArray(tasks.active);
      const recentTasks = asArray(tasks.recentDone);
      const t = props.t;
      const now = props.now;

      const current = tasks.current;
      let currentId = t('tasks.currentNone');
      let currentTitle = '';
      if (typeof current === 'string' && current) {
        currentId = current;
      } else if (current && typeof current === 'object') {
        currentId = asText(current.id) || t('tasks.currentNone');
        currentTitle = asText(current.title);
      }

      const statusOrder = ['draft', 'active', 'done', 'archived'];
      /* Projects whose ledger is markdown/absent may only report `other`. */
      const otherCount = asNumber(counts.other, 0);
      const statusRows = otherCount > 0 ? statusOrder.concat(['other']) : statusOrder;

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          React.createElement('h2', { className: 'project-flow-cardTitle' }, t('tasks.title')),
          React.createElement('span', { className: 'project-flow-muted' }, t('tasks.total', { n: asNumber(tasks.total, 0) }))
        ),
        React.createElement(
          'div',
          { className: 'project-flow-chips' },
          statusRows.map((status) =>
            React.createElement(
              Chip,
              { key: status },
              asNumber(counts[status], 0) + ' ' + t('tasks.status.' + status)
            )
          )
        ),
        React.createElement(
          'div',
          { className: 'project-flow-current' },
          React.createElement('span', { className: 'project-flow-muted' }, t('tasks.current') + '\uff1a'),
          React.createElement('span', { className: 'project-flow-currentId' }, currentId),
          currentTitle ? React.createElement('span', { className: 'project-flow-currentTitle', title: currentTitle }, currentTitle) : null
        ),
        React.createElement('h3', { className: 'project-flow-subTitle' }, t('tasks.active')),
        activeTasks.length === 0
          ? React.createElement(EmptyLine, null, t('tasks.activeEmpty'))
          : React.createElement(
              'ul',
              { className: 'project-flow-list' },
              activeTasks.slice(0, MAX_LIST_ROWS).map((task, index) => {
                const meta = joinParts([
                  asText(task.owner) ? t('tasks.owner') + ' ' + asText(task.owner) : '',
                  relativeMoment(Date.parse(asText(task.updated_at)), now, t) || '',
                ]);
                return React.createElement(ListRow, {
                  key: 'active-' + index,
                  id: asText(task.id),
                  title: asText(task.title),
                  meta,
                });
              })
            ),
        React.createElement('h3', { className: 'project-flow-subTitle' }, t('tasks.recent')),
        recentTasks.length === 0
          ? React.createElement(EmptyLine, null, t('tasks.recentEmpty'))
          : React.createElement(
              'ul',
              { className: 'project-flow-list' },
              recentTasks.slice(0, MAX_LIST_ROWS).map((task, index) => {
                const gate = asText(task.gate);
                const commits = asArray(task.commits).map(shortSha).filter(Boolean).join(', ');
                const mark = gate === 'pass' ? '\u2714' : gate === 'fail' ? '\u2718' : '';
                const tone = gate === 'pass' ? 'ok' : gate === 'fail' ? 'error' : '';
                return React.createElement(ListRow, {
                  key: 'done-' + index,
                  id: asText(task.id),
                  title: asText(task.title),
                  meta: joinParts([
                    commits,
                    mark ? mark + ' ' + t(gate === 'pass' ? 'tasks.gate.pass' : 'tasks.gate.fail') : '',
                  ]),
                  leading: mark ? React.createElement('span', { className: 'project-flow-gateMark project-flow-gateMark--' + tone }, mark) : null,
                });
              })
            )
      );
    }

    /** Phase chip text: known phases are localized, anything else is shown raw. */
    function phaseOf(phase, t) {
      const value = asText(phase);
      if (value === 'commit' || value === 'release' || value === 'manual') {
        return { cls: value, text: t('gates.phase.' + value) };
      }
      return { cls: 'other', text: value || t('misc.dash') };
    }

    /** Expanded gate: one block per step definition with its latest result. */
    function GateDetail(props) {
      const gate = asObject(props.gate);
      const t = props.t;
      const steps = asArray(gate.steps);
      const lastRun = gate.lastRun && typeof gate.lastRun === 'object' ? gate.lastRun : null;
      const results = Object.create(null);
      asArray(lastRun ? lastRun.steps : []).forEach((entry) => {
        const result = asObject(entry);
        if (result.id && !results[result.id]) results[result.id] = result;
      });

      return React.createElement(
        'div',
        { className: 'project-flow-gateBody' },
        React.createElement('h4', { className: 'project-flow-subTitle' }, t('gates.steps')),
        steps.length === 0
          ? React.createElement(EmptyLine, null, t('misc.dash'))
          : React.createElement(
              'div',
              { className: 'project-flow-steps' },
              steps.map((step, index) => {
                const result = step.id && results[step.id] ? results[step.id] : null;
                const exit = result ? asNumber(result.exit, null) : null;
                const ok = result ? result.ok === true : null;
                const tailText = result ? asText(result.tail).replace(/\r\n/g, '\n') : '';
                const tailLines = tailText ? tailText.split('\n') : [];
                /* The tail is folded to its first lines; the rest stays in the log. */
                while (tailLines.length > 0 && tailLines[tailLines.length - 1] === '') tailLines.pop();
                const shown = tailLines.slice(0, MAX_GATE_TAIL_LINES);
                return React.createElement(
                  'div',
                  { className: 'project-flow-step', key: 'step-' + index },
                  React.createElement(
                    'div',
                    { className: 'project-flow-stepHead' },
                    React.createElement('span', { className: 'project-flow-stepId' }, step.id || t('misc.dash')),
                    ok === true
                      ? React.createElement('span', { className: 'project-flow-stepExit project-flow-stepExit--ok' }, '\u2714 ok')
                      : null,
                    ok === false
                      ? React.createElement('span', { className: 'project-flow-stepExit project-flow-stepExit--fail' }, '\u2718 fail')
                      : null,
                    exit !== null
                      ? React.createElement('span', { className: 'project-flow-stepExit' }, 'exit ' + exit)
                      : null
                  ),
                  step.run
                    ? React.createElement('code', { className: 'project-flow-stepRun', title: step.run }, step.run)
                    : null,
                  step.expect ? React.createElement('p', { className: 'project-flow-stepExpect' }, step.expect) : null,
                  shown.length > 0
                    ? React.createElement('pre', { className: 'project-flow-pre project-flow-stepTail' }, shown.join('\n'))
                    : null
                );
              })
            )
      );
    }

    /** Read-only gate definitions: title, phase, enabled flag and the last run. */
    function GatesCard(props) {
      const gates = asArray(props.gates);
      const t = props.t;
      const now = props.now;
      const [openGates, setOpenGates] = useState({});

      const toggleGate = (key) => {
        setOpenGates((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          React.createElement('h2', { className: 'project-flow-cardTitle' }, t('gates.title')),
          React.createElement('span', { className: 'project-flow-muted' }, String(gates.length))
        ),
        gates.length === 0
          ? React.createElement(
              'div',
              { className: 'project-flow-guide' },
              React.createElement('p', { className: 'project-flow-guideTitle' }, t('gates.empty'))
            )
          : React.createElement(
              'div',
              { className: 'project-flow-gates' },
              gates.map((gate, index) => {
                const key = 'gate-' + index + '-' + gate.id;
                const expanded = openGates[key] === true;
                const disabled = gate.enabled === false;
                const phase = phaseOf(gate.phase, t);
                const run = gate.lastRun;
                const when = run && Number.isFinite(run.startedMs) ? relativeMoment(run.startedMs, now, t) : null;
                const duration = run ? formatDuration(asNumber(run.durationMs, null)) : '';
                const whenText = [when, duration].filter(Boolean).join(' ');
                const runText = run
                  ? t(run.ok ? 'gates.run.ok' : 'gates.run.fail', { time: whenText || t('misc.dash') })
                  : t('gates.never');
                const runTone = run ? (run.ok ? ' project-flow-gateRun--ok' : ' project-flow-gateRun--fail') : '';

                return React.createElement(
                  'div',
                  {
                    className: 'project-flow-gate' + (disabled ? ' project-flow-gate--disabled' : ''),
                    key,
                  },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'project-flow-gateHead',
                      'aria-expanded': expanded ? true : false,
                      title: gate.title || gate.id || undefined,
                      onClick: () => toggleGate(key),
                    },
                    React.createElement(Caret, { open: expanded }),
                    React.createElement('span', { className: 'project-flow-gateTitle' }, gate.title || gate.id || t('misc.dash')),
                    React.createElement(Chip, { tone: phase.cls === 'other' ? null : 'phase' }, phase.text),
                    React.createElement('span', { className: 'project-flow-gateRun' + runTone }, runText)
                  ),
                  expanded ? React.createElement(GateDetail, { gate, t, now }) : null
                );
              })
            )
      );
    }

    function SignalsCard(props) {
      /* Every list is tolerated when absent or not an array. */
      const gate = props.gate;
      const heartbeats = asArray(props.heartbeats);
      const runs = asArray(props.runs);
      const t = props.t;
      const now = props.now;

      const [closed, setClosed] = useState({});
      const [openRuns, setOpenRuns] = useState({});

      const toggleSection = (key) => {
        setClosed((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      const toggleRun = (key) => {
        setOpenRuns((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      /* `gate` may arrive as null (section switched off) or be missing. */
      const gateInfo = gate && typeof gate === 'object' ? gate : {};
      const gateDisabled = gateInfo.disabled === true;
      const gateAll = gateDisabled ? [] : asArray(gateInfo.lines);
      const gateLines = gateAll.slice(-MAX_GATE_LINES);
      const gateAge = gateDisabled ? null : relativeMoment(gateInfo.mtime, now, t);

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement('h2', { className: 'project-flow-cardTitle project-flow-cardTitle--spaced' }, t('signals.title')),
        React.createElement(
          Section,
          {
            title: t('signals.gate'),
            open: !closed.gate,
            onToggle: () => toggleSection('gate'),
            count: gateAll.length,
          },
          gateAge
            ? React.createElement('p', { className: 'project-flow-muted project-flow-sectionNote' }, t('signals.gate.updated', { time: gateAge }))
            : null,
          gateLines.length === 0
            ? React.createElement(EmptyLine, null, t(gateDisabled ? 'signals.gate.disabled' : 'signals.gate.empty'))
            : React.createElement('pre', { className: 'project-flow-pre' }, gateLines.join('\n'))
        ),
        React.createElement(
          Section,
          {
            title: t('signals.heartbeat'),
            open: !closed.heartbeat,
            onToggle: () => toggleSection('heartbeat'),
            count: heartbeats.length,
          },
          heartbeats.length === 0
            ? React.createElement(EmptyLine, null, t('signals.heartbeat.empty'))
            : React.createElement(
                'ul',
                { className: 'project-flow-list' },
                heartbeats.map((beat, index) => {
                  const age = Number.isFinite(beat.ageSeconds) ? beat.ageSeconds : null;
                  const stale = Number.isFinite(age) && age > STALE_AFTER_SECONDS;
                  const timeText = ageText(age, beat.mtime, now, t);
                  return React.createElement(
                    'li',
                    { className: 'project-flow-beat', key: 'beat-' + index },
                    React.createElement(
                      'div',
                      { className: 'project-flow-beatHead' },
                      React.createElement(
                        'span',
                        { className: 'project-flow-beatName', title: beat.file || undefined },
                        beat.title || basename(beat.file) || t('misc.dash')
                      ),
                      timeText ? React.createElement('span', { className: 'project-flow-beatTime' }, timeText) : null,
                      stale
                        ? React.createElement(
                            'span',
                            { className: 'project-flow-chip project-flow-chip--warn' },
                            t('signals.heartbeat.stale')
                          )
                        : null
                    ),
                    beat.statusLine
                      ? React.createElement('p', { className: 'project-flow-beatStatus', title: beat.statusLine }, beat.statusLine)
                      : null
                  );
                })
              )
        ),
        React.createElement(
          Section,
          {
            title: t('signals.runs'),
            open: !closed.runs,
            onToggle: () => toggleSection('runs'),
            count: runs.length,
          },
          runs.length === 0
            ? React.createElement(EmptyLine, null, t('signals.runs.empty'))
            : React.createElement(
                'div',
                { className: 'project-flow-runList' },
                runs.map((run, index) => {
                  const key = 'run-' + index;
                  const expanded = openRuns[key] === true;
                  const timeText = ageText(run.ageSeconds, null, now, t);
                  return React.createElement(
                    'div',
                    { className: 'project-flow-run', key },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'project-flow-runHead',
                        'aria-expanded': expanded ? true : false,
                        onClick: () => toggleRun(key),
                        title: run.path || undefined,
                      },
                      React.createElement(Caret, { open: expanded }),
                      React.createElement('span', { className: 'project-flow-runPath' }, run.path || t('misc.dash')),
                      React.createElement(
                        'span',
                        { className: 'project-flow-runMeta' },
                        joinParts([timeText, formatBytes(run.size)])
                      )
                    ),
                    expanded
                      ? run.lines.length === 0
                        ? React.createElement(EmptyLine, null, t('misc.dash'))
                        : React.createElement(
                            'pre',
                            { className: 'project-flow-pre project-flow-pre--run' },
                            run.lines.slice(-MAX_RUN_LINES).join('\n')
                          )
                      : null
                  );
                })
              )
        )
      );
    }
    // #endregion

    // #region top bar / footer / states
    function TopBar(props) {
      const view = props.view;
      const t = props.t;
      const now = props.now;
      const lastOkAt = props.lastOkAt;
      const failed = props.failed;
      const refreshing = props.refreshing;
      const onRefresh = props.onRefresh;

      const liveText = relativeMoment(lastOkAt, now, t);
      const head = view.head;
      const dirty = head.dirty;

      return React.createElement(
        'header',
        { className: 'project-flow-top' },
        React.createElement(
          'div',
          { className: 'project-flow-lead' },
          React.createElement('span', { className: 'project-flow-iconWrap' }, React.createElement(PanelIcon, { size: 20 })),
          React.createElement(
            'div',
            { className: 'project-flow-titles' },
            React.createElement('h1', { className: 'project-flow-title' }, t('page.title')),
            React.createElement(
              'p',
              { className: 'project-flow-subtitle', title: view.root || undefined },
              view.root || t('misc.dash')
            )
          )
        ),
        React.createElement(
          'div',
          { className: 'project-flow-meta' },
          head.sha
            ? React.createElement(
                'span',
                { className: 'project-flow-pill', title: head.subject || undefined },
                React.createElement('span', { className: 'project-flow-muted' }, t('top.head')),
                React.createElement('span', { className: 'project-flow-mono' }, shortSha(head.sha))
              )
            : null,
          head.branch
            ? React.createElement(
                'span',
                { className: 'project-flow-pill' },
                React.createElement('span', { className: 'project-flow-muted' }, t('top.branch')),
                React.createElement('span', { className: 'project-flow-mono' }, head.branch)
              )
            : null,
          dirty > 0
            ? React.createElement(
                'span',
                { className: 'project-flow-pill', title: t('top.dirty', { n: dirty }) },
                React.createElement('span', { className: 'project-flow-dirtyDot', 'aria-hidden': 'true' }),
                React.createElement('span', null, t('top.dirty', { n: dirty }))
              )
            : null,
          React.createElement(
            'span',
            { className: 'project-flow-pill project-flow-live', title: failed ? t('top.liveStale') : t('top.live') },
            React.createElement('span', {
              className: 'project-flow-liveDot' + (failed ? ' project-flow-liveDot--stale' : ''),
              'aria-hidden': 'true',
            }),
            React.createElement('span', null, failed ? t('top.liveStale') : t('top.live')),
            liveText ? React.createElement('span', { className: 'project-flow-muted' }, liveText) : null
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'project-flow-btn',
              onClick: onRefresh,
              disabled: refreshing ? true : false,
              'aria-label': t('refresh.aria'),
            },
            refreshing ? t('refresh.busy') : t('refresh')
          ),
          React.createElement(Chip, { tone: 'brand' }, t('page.readonly'))
        )
      );
    }

    function Footer(props) {
      const view = props.view;
      const t = props.t;
      const [openWarnings, setOpenWarnings] = useState(false);
      const warnings = view.warnings;
      /* Where the ledger came from: `defaults` = inferred, anything else = declared. */
      const contract = view.contract;
      const contractSource = contract && contract.source ? contract.source : '';
      const contractLabel = contractSource === 'defaults' ? t('contract.defaults') : contractSource;
      const contractTitle = contract
        ? joinParts([
            contract.name,
            Number.isFinite(contract.schema) ? 'schema ' + contract.schema : '',
            contractSource,
          ])
        : '';

      return React.createElement(
        'footer',
        { className: 'project-flow-footer' },
        React.createElement('span', null, t('footer.source') + ': ' + (view.root || t('misc.dash'))),
        contractSource
          ? React.createElement(
              'span',
              { className: 'project-flow-contract', title: contractTitle || undefined },
              t('footer.contract', { source: contractLabel })
            )
          : null,
        view.generatedAt
          ? React.createElement('span', null, t('footer.generated') + ': ' + view.generatedAt)
          : null,
        warnings.length > 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'project-flow-footerLink',
                onClick: () => setOpenWarnings((previous) => !previous),
                'aria-expanded': openWarnings ? true : false,
              },
              t('footer.warnings', { n: warnings.length })
            )
          : React.createElement('span', null, t('footer.warningsNone')),
        openWarnings && warnings.length > 0
          ? React.createElement(
              'ul',
              { className: 'project-flow-warnList' },
              warnings.slice(0, MAX_WARNINGS).map((warning, index) =>
                React.createElement('li', { className: 'project-flow-warnItem', key: 'warn-' + index }, warning)
              )
            )
          : null
      );
    }

    function errorText(info, t) {
      const code = info && info.code ? String(info.code) : '';
      if (code === 'no-project') return t('error.noProject');
      if (code === 'forbidden') return t('error.forbidden');
      if (code === 'bad-root') return t('error.badRoot');
      const message = info && info.message ? String(info.message) : '';
      return message ? message : t('error.generic');
    }

    function LoadingState(props) {
      const t = props.t;
      return React.createElement(
        'div',
        { className: 'project-flow-card project-flow-loadingCard' },
        React.createElement(
          'div',
          { className: 'project-flow-loading' },
          React.createElement('span', { className: 'project-flow-spinner', 'aria-hidden': 'true' }),
          React.createElement('span', null, t(props.message || 'loading'))
        )
      );
    }

    function ErrorState(props) {
      const t = props.t;
      const info = props.info;
      const code = info && info.code ? String(info.code) : '';
      /* A workspace without a ledger is a normal first-run state, not a fault. */
      const notInitialized = code === 'not-initialized';
      const [initializing, setInitializing] = useState(false);
      const [initError, setInitError] = useState(null);

      /* The one write this panel performs: ask the host to create the ledger. */
      const initialize = useCallback(async () => {
        if (initializing) return;
        setInitializing(true);
        setInitError(null);
        try {
          const response = await window.fetch(INIT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
            body: JSON.stringify({ root: props.workspaceRoot }),
          });
          let payload = null;
          try {
            const raw = await response.text();
            payload = raw ? JSON.parse(raw) : null;
          } catch (error) {
            payload = null;
          }
          if (!response.ok || !payload || payload.ok !== true) {
            const hostError = payload && payload.error ? payload.error : null;
            throw new Error(
              (hostError && asText(hostError.message)) || 'HTTP ' + response.status
            );
          }
          setInitializing(false);
          if (typeof props.onInitialized === 'function') props.onInitialized();
        } catch (error) {
          /* Keep the card, re-arm the button and show why the init failed. */
          setInitializing(false);
          setInitError(asText(error && error.message) || t('error.generic'));
        }
      }, [initializing, props.workspaceRoot, props.onInitialized, t]);

      const initButton = notInitialized
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'project-flow-btn',
              onClick: initialize,
              disabled: initializing,
            },
            t(initializing ? 'empty.initializing' : 'empty.init')
          )
        : React.createElement(
            'button',
            { type: 'button', className: 'project-flow-btn', onClick: props.onRetry },
            t('error.retry')
          );

      return React.createElement(
        'div',
        { className: 'project-flow-card project-flow-errorCard' },
        React.createElement(
          'h2',
          { className: 'project-flow-cardTitle' },
          t(notInitialized ? 'empty.title' : 'error.title')
        ),
        React.createElement(
          'p',
          { className: 'project-flow-muted' },
          notInitialized ? t('error.notInitialized') : errorText(info, t)
        ),
        notInitialized
          ? React.createElement('p', { className: 'project-flow-muted' }, t('error.initHint'))
          : null,
        notInitialized && initError !== null
          ? React.createElement(
              'p',
              { className: 'project-flow-muted' },
              t('error.initFailed', { message: initError })
            )
          : null,
        initButton
      );
    }
    // #endregion

    // #region panel + polling
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      /* The one workspace this panel may show; undefined until the tab resolves it. */
      const workspaceRoot = props.workspaceRoot;
      const [data, setData] = useState(null);
      const [errorInfo, setErrorInfo] = useState(null);
      const [lastOkAt, setLastOkAt] = useState(0);
      const [reloadKey, setReloadKey] = useState(0);
      const [refreshing, setRefreshing] = useState(false);
      const [now, setNow] = useState(() => Date.now());

      // Re-render every second so every relative time is recomputed on render.
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
        return () => window.clearInterval(timer);
      }, []);

      // Polling loop for the current session's workspace. Restarts on a workspace
      // change or a manual refresh; no workspace yet means no polling at all.
      useEffect(() => {
        if (workspaceRoot === undefined) return undefined;

        let cancelled = false;
        let controller = null;
        let timer = null;

        setRefreshing(false);

        const url = STATE_ENDPOINT + '?root=' + encodeURIComponent(workspaceRoot);

        const load = async (manual) => {
          if (cancelled) return;
          if (typeof document !== 'undefined' && document.hidden) return;
          if (controller) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
          const current = new AbortController();
          controller = current;
          if (manual) setRefreshing(true);
          try {
            const response = await window.fetch(url, {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              credentials: 'same-origin',
              signal: current.signal,
            });
            let payload = null;
            try {
              const raw = await response.text();
              payload = raw ? JSON.parse(raw) : null;
            } catch (error) {
              payload = null;
            }
            if (cancelled) return;
            if (!response.ok || !payload || payload.ok !== true) {
              const hostError = payload && payload.error ? payload.error : null;
              const failure = new Error(
                (hostError && asText(hostError.message)) || 'HTTP ' + response.status
              );
              failure.code = (hostError && asText(hostError.code)) || 'http-' + response.status;
              throw failure;
            }
            setData(payload);
            setErrorInfo(null);
            setLastOkAt(Date.now());
          } catch (error) {
            if (cancelled || !error || error.name === 'AbortError') return;
            setErrorInfo({
              code: asText(error.code) || 'network',
              message: asText(error.message),
              at: Date.now(),
            });
          } finally {
            if (!cancelled) setRefreshing(false);
          }
        };

        void load(reloadKey > 0);
        timer = window.setInterval(() => void load(false), POLL_MS);

        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void load(true);
        };
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility);
        }

        return () => {
          cancelled = true;
          if (timer !== null) window.clearInterval(timer);
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
          if (controller) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [workspaceRoot, reloadKey]);

      const view = useMemo(() => (data ? normalize(data) : null), [data]);

      const refresh = useCallback(() => {
        setReloadKey((value) => value + 1);
      }, []);

      const failed = errorInfo !== null;
      const body =
        workspaceRoot === undefined
          ? /* The workspace is not known yet: same card, workspace-scoped copy. */
            React.createElement(LoadingState, { t, message: 'workspace.pending' })
          : data === null
            ? failed
              ? React.createElement(ErrorState, {
                  t,
                  info: errorInfo,
                  workspaceRoot,
                  onRetry: refresh,
                  onInitialized: refresh,
                })
              : React.createElement(LoadingState, { t })
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { className: 'project-flow-grid' },
                  React.createElement(
                    'div',
                    { className: 'project-flow-col' },
                    React.createElement(ExperimentTree, { exp: view.exp, t, now })
                  ),
                  React.createElement(
                    'div',
                    { className: 'project-flow-col' },
                    React.createElement(TasksCard, { tasks: view.tasks, t, now }),
                    /* Gate definitions sit between tasks and live signals (store mode only). */
                    view.gates ? React.createElement(GatesCard, { gates: view.gates, t, now }) : null,
                    React.createElement(SignalsCard, {
                      gate: view.gate,
                      heartbeats: view.heartbeats,
                      runs: view.runs,
                      t,
                      now,
                    })
                  )
                ),
                React.createElement(Footer, { view, t })
              );

      return React.createElement(
        'div',
        { className: 'project-flow-page' },
        React.createElement('style', null, CSS),
        React.createElement(
          'div',
          { className: 'project-flow-inner' },
          view
            ? React.createElement(TopBar, {
                view,
                t,
                now,
                lastOkAt,
                failed,
                refreshing,
                onRefresh: refresh,
              })
            : React.createElement(
                'header',
                { className: 'project-flow-top' },
                React.createElement(
                  'div',
                  { className: 'project-flow-lead' },
                  React.createElement('span', { className: 'project-flow-iconWrap' }, React.createElement(PanelIcon, { size: 20 })),
                  React.createElement(
                    'div',
                    { className: 'project-flow-titles' },
                    React.createElement('h1', { className: 'project-flow-title' }, t('page.title')),
                    React.createElement('p', { className: 'project-flow-subtitle' }, t('loading'))
                  )
                )
              ),
          failed && data !== null
            ? React.createElement(
                'div',
                { className: 'project-flow-stale', role: 'status' },
                React.createElement('span', { className: 'project-flow-staleMark', 'aria-hidden': 'true' }, '!'),
                React.createElement(
                  'span',
                  null,
                  t('stale.text', { time: relativeMoment(lastOkAt, now, t) || t('misc.dash') })
                ),
                errorInfo && errorInfo.code
                  ? React.createElement('span', { className: 'project-flow-staleCode' }, errorInfo.code)
                  : null
              )
            : null,
          body
        )
      );
    }

    /** Error-boundary equivalent: a failed render must never take the page down. */
    function makeBoundary() {
      const fallback = React.createElement(
        'div',
        { className: 'project-flow-page' },
        React.createElement(
          'div',
          { className: 'project-flow-inner' },
          React.createElement(
            'div',
            { className: 'project-flow-card project-flow-errorCard' },
            React.createElement('h2', { className: 'project-flow-cardTitle' }, '面板渲染失败 / Panel failed to render'),
            React.createElement('p', { className: 'project-flow-muted' }, '请刷新页面 / Please reload the page.')
          )
        )
      );

      if (typeof React.Component !== 'function') {
        return function PassthroughBoundary(props) {
          return props.children;
        };
      }

      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { failed: false };
        }

        static getDerivedStateFromError() {
          return { failed: true };
        }

        componentDidCatch(error) {
          try {
            console.error('[' + NS + '] panel render failed', error);
          } catch (ignored) {
            /* ignore */
          }
        }

        render() {
          if (this.state.failed) return fallback;
          return this.props.children;
        }
      }

      return PanelBoundary;
    }

    const PanelBoundary = makeBoundary();

    function PanelRoot(props) {
      return React.createElement(PanelBoundary, null, React.createElement(Panel, props));
    }
    // #endregion

    // #region right-bar seats
    /** The single stylesheet; each seat renders it so no seat depends on another. */
    function StyleTag() {
      return React.createElement('style', null, CSS);
    }

    /**
     * Resolve the current session's workspace directory from the tab seat:
     * the standard `sessionId` prop plus the `useSessions` store hook (exactly
     * what the shipped Files tab does with `sessions.byId[sessionId]?.cwd`).
     * The hook is called unconditionally — with an empty-store fallback when the
     * prop is absent — so the hook order stays stable across renders.
     */
    function resolveWorkspaceRoot(props) {
      const source = props || {};
      const sessionId = source.sessionId;
      const useSessions =
        typeof source.useSessions === 'function'
          ? source.useSessions
          : (selector) => selector({ byId: {} });
      const cwd = useSessions((sessions) => {
        const byId = sessions && typeof sessions === 'object' ? sessions.byId : undefined;
        const session =
          byId && sessionId !== undefined && sessionId !== null ? byId[sessionId] : undefined;
        const value = session && typeof session === 'object' ? session.cwd : undefined;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      });
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
    }

    /**
     * Body of the `sidebar.right.pane.tab` seat: the same panel as before, still
     * wrapped in its own error boundary, but scoped to the session's workspace.
     * The `key` remounts the panel when the workspace changes, so the previous
     * workspace's snapshot is discarded instead of being shown.
     */
    function PanelBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const workspaceRoot = resolveWorkspaceRoot(props);
      return React.createElement(PanelRoot, {
        key: workspaceRoot === undefined ? 'pending' : workspaceRoot,
        t,
        workspaceRoot,
      });
    }

    /** Chip text in the right-bar tab strip; icon + label, width-adaptive. */
    function PanelTitle(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(StyleTag, null),
        React.createElement(
          'span',
          { className: 'project-flow-tabTitle', title: t('tab.title') },
          React.createElement(PanelGlyph, null),
          React.createElement('span', { className: 'project-flow-tabTitleText' }, t('tab.title'))
        )
      );
    }

    /**
     * `conversation.session.header.utilities` seat: one compact icon button that
     * opens the tab (a repeat click focuses the tab already open).
     */
    function HeaderAction(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const openPanel = typeof props.openPanel === 'function' ? props.openPanel : null;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(StyleTag, null),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'project-flow-headerBtn',
            title: t('action.open'),
            'aria-label': t('action.open'),
            onClick: (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault();
              if (!openPanel) return;
              try {
                openPanel();
              } catch (error) {
                try {
                  console.error('[' + NS + '] openPanel failed', error);
                } catch (ignored) {
                  /* ignore */
                }
              }
            },
          },
          React.createElement(PanelIcon, { size: 16 })
        )
      );
    }
    // #endregion

    // #region styles
    /*
     * Base rules are the narrow right-bar (single column, compact); one
     * `@container (min-width:640px)` block restores the wide/full-screen
     * layout (two columns). `.project-flow-inner` is the query container, so only
     * its descendants may be restyled by the block. The page root is the only
     * scroll container.
     */
    const CSS = `
.project-flow-page{box-sizing:border-box;width:100%;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;}
.project-flow-inner{box-sizing:border-box;width:100%;padding:12px;container-type:inline-size;}
.project-flow-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 8px;}
.project-flow-lead{display:flex;align-items:center;gap:8px;min-width:0;}
.project-flow-iconWrap{display:none;flex:none;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);}
.project-flow-titles{display:flex;flex-direction:column;gap:1px;min-width:0;}
.project-flow-title{margin:0;font-size:15px;font-weight:600;line-height:20px;}
.project-flow-subtitle{margin:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:${MONO};font-size:10.5px;}
.project-flow-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);}
.project-flow-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap;}
.project-flow-mono{font-family:${MONO};}
.project-flow-muted{color:var(--dsw-alias-label-secondary);font-size:11px;}
.project-flow-dirtyDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none;}
.project-flow-live{color:var(--dsw-alias-label-secondary);}
.project-flow-liveDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;animation:project-flow-pulse 2.4s ease-in-out infinite;}
.project-flow-liveDot--stale{background:var(--dsw-alias-state-warn-primary);animation:none;}
@keyframes project-flow-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.project-flow-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .12s ease;}
.project-flow-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
.project-flow-btn:disabled{opacity:.55;cursor:default;}
.project-flow-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.project-flow-chips{display:flex;flex-wrap:wrap;gap:5px;}
.project-flow-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-chip--ok{color:var(--dsw-alias-state-success-primary);}
.project-flow-chip--error{color:var(--dsw-alias-state-error-primary);}
.project-flow-chip--warn{color:var(--dsw-alias-state-warn-primary);}
.project-flow-chip--brand{color:var(--dsw-alias-brand-primary);}
.project-flow-stale{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-warn-primary);font-size:11px;}
.project-flow-staleMark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-state-warn-primary);font-size:10px;line-height:1;flex:none;}
.project-flow-staleCode{font-family:${MONO};font-size:10.5px;opacity:.8;}
.project-flow-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:10px;align-items:start;}
.project-flow-col{display:flex;flex-direction:column;gap:10px;min-width:0;}
.project-flow-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;min-width:0;}
.project-flow-cardHead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px;}
.project-flow-cardTitle{margin:0;font-size:12.5px;font-weight:600;line-height:18px;}
.project-flow-cardTitle--spaced{margin-bottom:8px;}
.project-flow-subTitle{margin:10px 0 4px;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.project-flow-current{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;margin-top:8px;padding:5px 7px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;min-width:0;}
.project-flow-currentId{font-family:${MONO};font-weight:600;}
.project-flow-currentTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.project-flow-list{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;}
.project-flow-listRow{display:flex;align-items:baseline;gap:6px;padding:2px 3px;border-radius:5px;font-size:11.5px;min-width:0;}
.project-flow-listRow:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-listLeading{flex:none;display:inline-flex;align-items:center;}
.project-flow-listId{flex:none;font-family:${MONO};font-weight:600;font-size:11px;}
.project-flow-listTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.project-flow-listMeta{flex:none;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-gateMark{font-size:11px;line-height:1;}
.project-flow-gateMark--ok{color:var(--dsw-alias-state-success-primary);}
.project-flow-gateMark--error{color:var(--dsw-alias-state-error-primary);}
.project-flow-guide{margin-top:5px;padding:10px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.project-flow-guideTitle{margin:0 0 3px;font-size:12.5px;}
.project-flow-guide p{margin:0;}
.project-flow-tree{display:flex;flex-direction:column;}
.project-flow-groupHead{display:flex;align-items:center;gap:5px;width:100%;margin-top:4px;padding:4px 3px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:600;text-align:left;cursor:pointer;}
.project-flow-groupHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-groupHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-groupName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-count{color:var(--dsw-alias-label-secondary);font-weight:400;font-variant-numeric:tabular-nums;}
.project-flow-caret{display:inline-block;flex:none;width:10px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;transition:transform .12s ease;}
.project-flow-caret--collapsed{transform:rotate(-90deg);}
.project-flow-treeItem{display:block;}
.project-flow-row{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:1px;width:100%;padding:3px 3px 3px 0;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.project-flow-row:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-connector{flex:none;color:var(--dsw-alias-label-secondary);font-family:${MONO};letter-spacing:-1px;}
.project-flow-verdict{flex:none;width:1em;text-align:center;font-size:10.5px;line-height:1.6;}
.project-flow-verdict--confirmed{color:var(--dsw-alias-state-success-primary);}
.project-flow-verdict--refuted{color:var(--dsw-alias-state-error-primary);}
.project-flow-verdict--open{color:var(--dsw-alias-state-warn-primary);}
.project-flow-verdict--abandoned{color:var(--dsw-alias-label-secondary);}
.project-flow-branch{flex:none;white-space:pre;overflow:hidden;font-family:${MONO};font-size:10.5px;line-height:1.6;letter-spacing:0;color:var(--dsw-alias-label-secondary);}
.project-flow-rowId{order:1;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-weight:600;font-size:11px;}
.project-flow-rowMeta{order:3;flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-rowHyp{order:4;flex:1 1 100%;min-width:0;white-space:normal;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--dsw-alias-label-secondary);}
.project-flow-detail{display:flex;flex-direction:column;gap:6px;margin:2px 0 6px 18px;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 7px 7px 0;background:var(--dsw-alias-bg-layer-2);}
.project-flow-detailItem{display:flex;flex-direction:column;gap:1px;min-width:0;}
.project-flow-detailLabel{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.project-flow-detailValue{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:${MONO};font-size:10.5px;line-height:1.5;}
.project-flow-more{margin:5px 0 0;padding-left:14px;}
.project-flow-section{margin-top:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);}
.project-flow-section:first-of-type{margin-top:0;padding-top:0;border-top:0;}
.project-flow-sectionHead{display:flex;align-items:center;gap:5px;width:100%;padding:3px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:600;text-align:left;cursor:pointer;}
.project-flow-sectionHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-sectionHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-sectionTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-sectionBody{padding:4px 0 2px;}
.project-flow-sectionNote{margin:0 0 5px;padding-left:15px;}
.project-flow-pre{box-sizing:border-box;margin:0;padding:6px 8px;max-height:160px;overflow:auto;border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:${MONO};font-size:10.5px;line-height:1.45;white-space:pre;tab-size:2;}
.project-flow-pre--run{max-height:150px;margin-top:3px;}
.project-flow-beat{display:flex;flex-direction:column;gap:1px;padding:4px 3px;border-radius:5px;min-width:0;}
.project-flow-beat:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-beatHead{display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-width:0;}
.project-flow-beatName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:500;}
.project-flow-beatTime{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;}
.project-flow-beatStatus{margin:0;padding-left:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.project-flow-runList{display:flex;flex-direction:column;gap:1px;}
.project-flow-run{display:block;min-width:0;}
.project-flow-runHead{display:flex;align-items:center;gap:5px;width:100%;padding:3px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;text-align:left;cursor:pointer;}
.project-flow-runHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-runHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-runPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:10.5px;color:var(--dsw-alias-label-secondary);}
.project-flow-runMeta{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-empty{margin:3px 0 0;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:9px;color:var(--dsw-alias-label-secondary);font-size:11px;}
.project-flow-loadingCard{margin-top:10px;}
.project-flow-loading{display:flex;align-items:center;gap:8px;padding:20px 4px;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.project-flow-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:project-flow-spin .8s linear infinite;flex:none;}
@keyframes project-flow-spin{to{transform:rotate(360deg);}}
.project-flow-errorCard{margin-top:10px;}
.project-flow-errorCard .project-flow-muted{margin:5px 0 10px;}
.project-flow-footer{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;font-family:${MONO};}
.project-flow-footerLink{padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer;text-decoration:underline;}
.project-flow-footerLink:hover{color:var(--dsw-alias-label-primary);}
.project-flow-footerLink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.project-flow-contract{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-warnList{flex-basis:100%;margin:0;padding:0 0 0 14px;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.project-flow-warnItem{white-space:pre-wrap;overflow-wrap:anywhere;}
.project-flow-headerBtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease;}
.project-flow-headerBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.project-flow-headerBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.project-flow-tabTitle{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;font-size:12px;line-height:16px;color:inherit;}
.project-flow-tabTitleText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
@container (min-width:640px){
.project-flow-top{align-items:flex-start;gap:12px 16px;}
.project-flow-lead{gap:12px;}
.project-flow-iconWrap{display:flex;width:36px;height:36px;border-radius:10px;}
.project-flow-title{font-size:20px;line-height:28px;}
.project-flow-subtitle{max-width:min(560px,60vw);font-size:11.5px;}
.project-flow-meta{gap:8px;font-size:12px;}
.project-flow-pill{gap:6px;height:24px;padding:0 9px;border-radius:12px;font-size:11.5px;}
.project-flow-muted{font-size:11.5px;}
.project-flow-dirtyDot{width:7px;height:7px;}
.project-flow-liveDot{width:7px;height:7px;}
.project-flow-btn{height:28px;padding:0 12px;border-radius:14px;font-size:12px;}
.project-flow-chips{gap:6px;}
.project-flow-chip{height:22px;padding:0 8px;border-radius:11px;font-size:11px;}
.project-flow-stale{gap:8px;margin-top:12px;padding:8px 12px;border-radius:10px;font-size:12px;}
.project-flow-staleMark{width:16px;height:16px;font-size:11px;}
.project-flow-grid{grid-template-columns:minmax(0,1.15fr) minmax(0,0.85fr);gap:16px;margin-top:16px;}
.project-flow-col{gap:16px;}
.project-flow-card{padding:14px 16px;border-radius:12px;}
.project-flow-cardHead{margin-bottom:10px;gap:8px;}
.project-flow-cardTitle{font-size:13px;line-height:20px;}
.project-flow-cardTitle--spaced{margin-bottom:10px;}
.project-flow-subTitle{margin:14px 0 6px;font-size:11px;}
.project-flow-current{margin-top:10px;padding:6px 8px;font-size:12px;}
.project-flow-list{gap:2px;}
.project-flow-listRow{gap:8px;padding:3px 4px;border-radius:6px;font-size:12px;}
.project-flow-listId{font-size:11.5px;}
.project-flow-listMeta{font-size:11px;}
.project-flow-guide{margin-top:6px;padding:14px;border-radius:10px;}
.project-flow-guideTitle{font-size:13px;margin-bottom:4px;}
.project-flow-groupHead{margin-top:6px;padding:5px 4px;border-radius:6px;font-size:12px;}
.project-flow-row{flex-wrap:nowrap;column-gap:8px;row-gap:0;padding:4px 4px 4px 0;border-radius:6px;font-size:12px;}
.project-flow-verdict{font-size:11px;}
.project-flow-rowId{order:0;flex:none;overflow:visible;text-overflow:clip;font-size:11.5px;}
.project-flow-rowMeta{order:0;max-width:none;overflow:visible;text-overflow:clip;font-size:10.5px;}
.project-flow-rowHyp{order:0;display:block;flex:1 1 auto;white-space:nowrap;overflow-wrap:normal;text-overflow:ellipsis;overflow:hidden;}
.project-flow-detail{gap:8px;margin:2px 0 8px 42px;padding:8px 10px;border-radius:0 8px 8px 0;}
.project-flow-detailLabel{font-size:10px;}
.project-flow-detailValue{font-size:11px;line-height:1.55;}
.project-flow-more{padding-left:20px;}
.project-flow-section{margin-top:10px;padding-top:8px;}
.project-flow-sectionHead{padding:4px;border-radius:6px;font-size:12px;}
.project-flow-sectionNote{padding-left:16px;margin-bottom:6px;}
.project-flow-pre{padding:8px 10px;max-height:200px;border-radius:8px;font-size:11px;line-height:1.5;}
.project-flow-pre--run{max-height:180px;margin-top:4px;}
.project-flow-beat{gap:2px;padding:5px 4px;border-radius:6px;}
.project-flow-beatName{font-size:12px;}
.project-flow-beatTime{font-size:10.5px;}
.project-flow-beatStatus{font-size:11px;}
.project-flow-runHead{gap:6px;padding:4px;font-size:11.5px;}
.project-flow-runPath{font-size:11px;}
.project-flow-runMeta{font-size:10.5px;}
.project-flow-empty{margin-top:4px;padding:10px 12px;border-radius:10px;font-size:11.5px;}
.project-flow-loadingCard{margin-top:16px;}
.project-flow-loading{padding:26px 4px;font-size:13px;}
.project-flow-errorCard{margin-top:16px;}
.project-flow-footer{gap:10px;margin-top:18px;padding-top:12px;font-size:11px;}
.project-flow-footerLink{font-size:11px;}
.project-flow-warnList{padding-left:16px;font-size:11px;}
.project-flow-tabTitle{font-size:12.5px;}
}
`;
    // #endregion

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const report = (message, error) => {
          try {
            console.error('[' + NS + '] ' + message, error);
          } catch (ignored) {
            /* ignore */
          }
        };

        let t = (key) => key;
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-flow: dictionaries');
          t = ctx.locale.bind(NS);
        } catch (error) {
          report('locale registration failed', error);
        }

        /** Open (or focus) this plugin's tab in the right bar. */
        const openPanel = () => {
          try {
            return ctx.sidebarRight.openTab(TAB_KIND);
          } catch (error) {
            report('sidebarRight.openTab failed', error);
            return undefined;
          }
        };

        // 1) the tab type itself (plus the guide card of the right bar's guide page).
        try {
          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => t('tab.title'),
                guide: [
                  {
                    id: 'paths',
                    order: 10,
                    title: () => t('guide.title'),
                    description: () => t('guide.description'),
                    icon: PanelGlyph,
                  },
                ],
              }),
            'project-flow: tab type'
          );
        } catch (error) {
          report('sidebarRightTabs.register failed', error);
        }

        // 2) the tab body, keyed by the tab type id.
        try {
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                locale: NS,
                inject: () => ({ t }),
              },
              PanelBody
            )
          );
        } catch (error) {
          report('sidebar.right.pane.tab registration failed', error);
        }

        // 3) the chip title in the right bar's tab strip.
        try {
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: TAB_ID,
                locale: NS,
              },
              PanelTitle
            )
          );
        } catch (error) {
          report('sidebar.right.pane.tab.title registration failed', error);
        }

        // 4) a one-click opener in the conversation header (the bar starts folded).
        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: HEADER_ACTION_ID,
                order: 5,
                locale: NS,
                inject: () => ({ openPanel }),
              },
              HeaderAction
            )
          );
        } catch (error) {
          report('conversation.session.header.utilities registration failed', error);
        }
      },
    };
  },
});
