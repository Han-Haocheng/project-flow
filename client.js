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
 * The panel polls `api/project-flow/state` (document relative) every 2500 ms,
 * keeps the last good snapshot on failure, and renders:
 *   experiment tree (grouped by Factor) · task ledger progress · gate log tail ·
 *   agent heartbeats · recent run output.
 *
 * Host payload notes (all optional, all tolerated when missing):
 *   - `roots[]` drives the project switcher (hidden unless more than one);
 *   - `contract: { source, schema, name }` renders one footer line saying
 *     whether the ledger is inferred ("defaults") or declared by a file;
 *   - `gate: null` means the project turned gate logging off — the gate section
 *     shows a localized empty state instead of an empty log;
 *   - `tasks.counts.other` covers markdown / no-ledger task sources.
 *
 * Layout is container-query driven: the same component serves a 300 px docked
 * right bar (single column, compact) and a wide/full-screen bar (two columns).
 *
 * Read-only: only GET requests, no host DOM access, colors only through
 * `--dsw-alias-*` theme tokens.
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
    const POLL_MS = 2500;
    const CLOCK_MS = 1000;
    const MAX_TREE_ROWS = 300;
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
      'exp.more': '还有 {n} 条未显示',
      'exp.openBanner': '○ {n} 条假设还没验证',
      'exp.detail.hypothesis': '假设',
      'exp.detail.expected': '预期',
      'exp.detail.measured': '实测',
      'exp.detail.none': '未记录',
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
      'project.select': '项目',
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
      'exp.more': '{n} more not shown',
      'exp.openBanner': '○ {n} hypotheses not yet tested',
      'exp.detail.hypothesis': 'Hypothesis',
      'exp.detail.expected': 'Expected',
      'exp.detail.measured': 'Measured',
      'exp.detail.none': 'not recorded',
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
      'project.select': 'Project',
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
      return { cls: 'open', glyph: '\u25cb' };
    }

    function joinParts(parts) {
      return parts.filter((part) => part !== null && part !== undefined && part !== '').join(' \u00b7 ');
    }
    // #endregion

    // #region state normalization
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

      let confirmed = 0;
      let refuted = 0;
      let open = 0;
      groups.forEach((group) => {
        group.items.forEach((item) => {
          const verdict = asText(item.verdict);
          if (verdict === 'confirmed') confirmed += 1;
          else if (verdict === 'refuted') refuted += 1;
          else open += 1;
        });
      });

      const countsSrc = asObject(tasksSrc.counts);
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
          total: asNumber(expSrc.total, confirmed + refuted + open),
          confirmed: asNumber(expSrc.confirmed, confirmed),
          refuted: asNumber(expSrc.refuted, refuted),
          open: asNumber(expSrc.open, open),
          groups,
        },
        tasks: {
          total: asNumber(tasksSrc.total, 0),
          counts: {
            draft: asNumber(countsSrc.draft, 0),
            active: asNumber(countsSrc.active, 0),
            done: asNumber(countsSrc.done, 0),
            archived: asNumber(countsSrc.archived, 0),
            /* Markdown / no-ledger projects often report only this bucket. */
            other: asNumber(countsSrc.other, 0),
          },
          current: tasksSrc.current === undefined ? null : tasksSrc.current,
          active: asArray(tasksSrc.active).filter((task) => task && typeof task === 'object'),
          recentDone: asArray(tasksSrc.recentDone).filter((task) => task && typeof task === 'object'),
        },
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
    function DetailBlock(props) {
      const item = props.item;
      const t = props.t;
      const rows = [
        { label: t('exp.detail.hypothesis'), value: item.hypothesis },
        { label: t('exp.detail.expected'), value: item.expected },
        { label: t('exp.detail.measured'), value: item.measured },
      ];
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

    function ExperimentTree(props) {
      const exp = props.exp;
      const t = props.t;
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
      const children = [];
      let budget = MAX_TREE_ROWS;
      let hidden = 0;

      // 未验证的假设永远置顶：这是「容易忘」的部分。
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

      if (hidden > 0) {
        children.push(
          React.createElement('p', { className: 'project-flow-muted project-flow-more', key: 'more' }, t('exp.more', { n: hidden }))
        );
      }

      const total = exp.total;

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          React.createElement('h2', { className: 'project-flow-cardTitle' }, t('exp.title')),
          React.createElement(
            'div',
            { className: 'project-flow-chips' },
            React.createElement(Chip, { tone: 'ok' }, '\u2714 ' + exp.confirmed + ' ' + t('exp.confirmed')),
            React.createElement(Chip, { tone: 'error' }, '\u2718 ' + exp.refuted + ' ' + t('exp.refuted')),
            React.createElement(Chip, { tone: 'warn' }, '\u25cb ' + exp.open + ' ' + t('exp.open')),
            React.createElement(Chip, null, total + ' ' + t('exp.total'))
          )
        ),
        total === 0
          ? React.createElement(
              'div',
              { className: 'project-flow-guide' },
              React.createElement('p', { className: 'project-flow-guideTitle' }, t('exp.empty')),
              React.createElement('p', { className: 'project-flow-muted' }, t('exp.emptyHint'))
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

    /**
     * Project switcher. `roots[]` carries one entry per project the host knows
     * about; the visible option text is the project name while the option
     * value (and tooltip) stays the path sent back as `?root=`.
     */
    function ProjectPicker(props) {
      const roots = props.roots;
      const t = props.t;
      const value = props.value;
      const onChange = props.onChange;

      return React.createElement(
        'div',
        { className: 'project-flow-roots' },
        React.createElement('label', { className: 'project-flow-rootsLabel', htmlFor: 'project-flow-project-select' }, t('project.select')),
        React.createElement(
          'select',
          {
            id: 'project-flow-project-select',
            className: 'project-flow-select',
            value,
            onChange: (event) => onChange(event.target.value),
          },
          roots.map((root) =>
            React.createElement('option', { key: root.path, value: root.path, title: root.path }, root.name)
          )
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
      return React.createElement(
        'div',
        { className: 'project-flow-card project-flow-loadingCard' },
        React.createElement(
          'div',
          { className: 'project-flow-loading' },
          React.createElement('span', { className: 'project-flow-spinner', 'aria-hidden': 'true' }),
          React.createElement('span', null, props.t('loading'))
        )
      );
    }

    function ErrorState(props) {
      const t = props.t;
      return React.createElement(
        'div',
        { className: 'project-flow-card project-flow-errorCard' },
        React.createElement('h2', { className: 'project-flow-cardTitle' }, t('error.title')),
        React.createElement('p', { className: 'project-flow-muted' }, errorText(props.info, t)),
        React.createElement(
          'button',
          { type: 'button', className: 'project-flow-btn', onClick: props.onRetry },
          t('error.retry')
        )
      );
    }
    // #endregion

    // #region panel + polling
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [data, setData] = useState(null);
      const [errorInfo, setErrorInfo] = useState(null);
      const [lastOkAt, setLastOkAt] = useState(0);
      const [root, setRoot] = useState(null);
      const [reloadKey, setReloadKey] = useState(0);
      const [refreshing, setRefreshing] = useState(false);
      const [now, setNow] = useState(() => Date.now());

      // Re-render every second so every relative time is recomputed on render.
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
        return () => window.clearInterval(timer);
      }, []);

      // Polling loop. Restarts on root switch or manual refresh.
      useEffect(() => {
        let cancelled = false;
        let controller = null;
        let timer = null;

        setRefreshing(false);

        const url = root
          ? STATE_ENDPOINT + '?root=' + encodeURIComponent(root)
          : STATE_ENDPOINT;

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
      }, [root, reloadKey]);

      const view = useMemo(() => (data ? normalize(data) : null), [data]);

      const refresh = useCallback(() => {
        setReloadKey((value) => value + 1);
      }, []);

      const handleRootChange = useCallback(
        (next) => {
          const currentRoot = view ? view.root : '';
          setRoot(next && next !== currentRoot ? next : null);
        },
        [view]
      );

      const failed = errorInfo !== null;
      const body = data === null
        ? failed
          ? React.createElement(ErrorState, { t, info: errorInfo, onRetry: refresh })
          : React.createElement(LoadingState, { t })
        : React.createElement(
            React.Fragment,
            null,
            view.roots.length > 1
              ? React.createElement(ProjectPicker, {
                  roots: view.roots,
                  t,
                  value: root || view.root || view.roots[0].path,
                  onChange: handleRootChange,
                })
              : null,
            React.createElement(
              'div',
              { className: 'project-flow-grid' },
              React.createElement(
                'div',
                { className: 'project-flow-col' },
                React.createElement(ExperimentTree, { exp: view.exp, t })
              ),
              React.createElement(
                'div',
                { className: 'project-flow-col' },
                React.createElement(TasksCard, { tasks: view.tasks, t, now }),
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
     * Body of the `sidebar.right.pane.tab` seat: the same panel as before, still
     * wrapped in its own error boundary. Only `t` is taken from the tab context.
     */
    function PanelBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      return React.createElement(PanelRoot, { t });
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
.project-flow-roots{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}
.project-flow-rootsLabel{color:var(--dsw-alias-label-secondary);}
.project-flow-select{box-sizing:border-box;height:26px;max-width:100%;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;}
.project-flow-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
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
.project-flow-roots{margin-top:12px;font-size:12px;}
.project-flow-select{height:28px;font-size:12px;}
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
