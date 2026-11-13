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
 * panel polls `api/project-flow/state?root=<workspace cwd>`: one request at a
 * time (single flight), with the next one armed `POLL_MS` (2500 ms) after the
 * previous one settles — a success or a failure both settle. A request slower
 * than 2500 ms is therefore never cancelled by its own successor, which is what
 * used to leave the panel stuck on the loading card. A teardown (unmount,
 * workspace switch, manual-refresh restart) is not a settle: it terminates this
 * chain — abort the one in-flight request, drop the pending re-arm — and
 * schedules or writes nothing afterwards, so abort belongs to teardown only.
 * On failure the panel keeps the last good snapshot and renders:
 *   experiment lineage tree · task ledger progress · gate definitions ·
 *   agent heartbeats.
 * The tab's `sessionId` is used only to highlight its own heartbeat; it is not
 * part of the request URL.
 *
 * Host payload notes (all tolerated when missing):
 *   - `root` is the workspace the snapshot describes; `roots[]` is only
 *     informational — there is no global project switcher any more, because
 *     the panel must never show a different workspace's ledger;
 *   - a workspace without a ledger answers HTTP 200 `{ ok:false, root, roots,
 *     error: { code: 'not-initialized', message } }`; the panel answers with
 *     the init guidance plus an Initialize button that POSTs the workspace root
 *     to `api/project-flow/init` and then reloads the ledger;
 *   - `contract: { source, schema, name }` renders one footer line saying
 *     whether the ledger is inferred ("defaults") or declared by a file;
 *   - `experiments` is always the `.agents/flow/` store: flat `items`, a `tree` of
 *     `{id, children}`, per-status `counts` (a section without `items`/`tree`
 *     still renders its empty state);
 *   - `gates[]` are gate definitions with an optional `lastRun`; an absent
 *     `gates` key hides the section, while an empty array shows its empty state;
 *   - `heartbeats` is a `{ dir, items, counts }` section or a plain item array;
 *     each item is the rich shape (`session/agent/status/goal/task/claims/...`);
 *   - `POST api/project-flow/gate { root, id, enabled }` flips one gate and
 *     answers `{ ok:true, root, gate:{ id, enabled } }` (or `{ ok:false,
 *     error:{ code, message } }`);
 *   - `tasks.counts.other` covers task records whose status is unknown;
 *   - `description` is a read-only projection of the `.agents/description`
 *     ledger (`{ available, counts:{files,modules,missingSemantics,plans},
 *     recentPlans[] }`); `available !== true` (or a missing key) hides the
 *     framework card entirely instead of drawing zero counters;
 *   - every row in `tasks.active` / `tasks.draft` / `tasks.recentDone` carries
 *     `goal` plus bounded detail fields (`notes`, `scope`, `acceptance`,
 *     `commits`, `created_at`, `updated_at`). A row is one line by default
 *     (`type: title`, stage badge, owner/time meta and the business id) and only
 *     renders the detail — notes and every ledger field — after a click or
 *     Enter/Space (`aria-expanded` / `aria-controls`).
 *
 * Layout is container-query driven: the same component serves a 300 px docked
 * right bar (single column, compact) and a wide/full-screen bar (two columns).
 *
 * Read-only apart from two documented POSTs — `init` (create the ledger) and
 * `gate` (flip one gate definition on/off): no host DOM access, colors only
 * through `--dsw-alias-*` theme tokens.
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
    /** Create the ledger in this workspace (the panel's other write is below). */
    const INIT_ENDPOINT = 'api/project-flow/init';
    /** Flip one gate definition on/off; the body is `{ root, id, enabled }`. */
    const GATE_ENDPOINT = 'api/project-flow/gate';
    const POLL_MS = 2500;
    const CLOCK_MS = 1000;
    const MAX_TREE_ROWS = 300;
    const MAX_TREE_DEPTH = 12;
    const MAX_GATE_TAIL_LINES = 8;
    const MAX_WARNINGS = 10;
    const MAX_LIST_ROWS = 25;
    /* Trend sparkline (T-09): fixed 26 px band, one stacked bar per day. */
    const TREND_BAR_HEIGHT = 26;
    const TREND_DAY_MS = 86400000;
    /* First-screen budget for the task card: the active group opens on this many
       rows so a 50-task ledger still fits the sidebar. Everything beyond it stays
       behind the group toggle and is always announced by the "N more" line. */
    const TASK_PREVIEW_ROWS = 6;
    /* task-71: the nine stage ids are a host projection; the client only maps
       them to display labels and to the six stage buckets. No status→stage
       mapping lives here — a legacy row without `stage` is bucketed by the
       bucket-safe fallback in `stageOfRow` (done/archived exact, everything
       else "todo"), which matches legacyStageFromStatus's bucket outcome. */
    const STAGE_LABEL_KEYS = {
      created: 'tasks.stage.created',
      'queued-analysis': 'tasks.stage.queued-analysis',
      analyzing: 'tasks.stage.analyzing',
      'queued-implementation': 'tasks.stage.queued-implementation',
      implementing: 'tasks.stage.implementing',
      'queued-review': 'tasks.stage.queued-review',
      reviewing: 'tasks.stage.reviewing',
      done: 'tasks.stage.done',
      archived: 'tasks.stage.archived',
    };
    const TASK_STAGE_GROUPS = [
      { id: 'todo', label: 'tasks.stageGroup.todo', stages: ['created', 'queued-analysis'] },
      { id: 'analyzing', label: 'tasks.stageGroup.analyzing', stages: ['analyzing'] },
      { id: 'queuedImplementation', label: 'tasks.stageGroup.queuedImplementation', stages: ['queued-implementation'] },
      { id: 'implementing', label: 'tasks.stageGroup.implementing', stages: ['implementing'] },
      { id: 'queuedReview', label: 'tasks.stageGroup.queuedReview', stages: ['queued-review', 'reviewing'] },
      { id: 'done', label: 'tasks.stageGroup.done', stages: ['done', 'archived'] },
    ];
    const STALE_AFTER_SECONDS = 6 * 60 * 60;

    /** The seven tallies the Host reports for the decision section. */
    const DECISION_COUNT_KEYS = [
      'open',
      'blocking',
      'escalated',
      'answered',
      'withdrawn',
      'superseded',
      'total',
    ];

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
      'top.head': 'HEAD',
      'top.branch': '分支',
      'top.currentBranch': '当前分支',
      'top.dirty': '{n} 个未提交改动',
      'top.live': '实时',
      'top.liveStale': '已断开',
      // T-20261112154725：后端 CLI 不可用时的只读降级，必须在页头可见。
      'top.degraded': '降级模式',
      'top.degradedHint': '后端 CLI 不可用，已退回只读直连台账',
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
      'exp.total': '总数',
      'exp.empty': '还没有实验记录。',
      'exp.emptyHint': '运行 flow exp add … 或使用 flow_exp 工具添加第一条实验。',
      'exp.more': '还有 {n} 条未显示',
      'exp.detail.hypothesis': '假设',
      'exp.detail.expected': '预期',
      'exp.detail.measured': '实测',
      'exp.detail.none': '未记录',
      'exp.metrics': '指标',
      'exp.notes': '备注',
      'exp.parent': '父实验',
      'exp.commits': '提交',
      'exp.source.store': 'store',
      'exp.status.open': '未验证',
      'exp.status.confirmed': '已确认',
      'exp.status.refuted': '已证伪',
      'exp.status.abandoned': '已放弃',
      'exp.status.inconclusive': '未定论',
      'exp.status.pivoted': '已转向',
      'exp.tree': '实验树',
      'tasks.title': '任务进度',
      'tasks.total': '共 {n} 个任务',
      'tasks.status.draft': '草稿',
      'tasks.status.active': '进行中',
      'tasks.status.done': '已完成',
      'tasks.status.archived': '已归档',
      'tasks.status.other': '其它',
      'tasks.current': '当前任务',
      'tasks.currentNone': '无',
      'tasks.stage.created': '已创建',
      'tasks.stage.queued-analysis': '待分析',
      'tasks.stage.analyzing': '分析中',
      'tasks.stage.queued-implementation': '待实现',
      'tasks.stage.implementing': '实现中',
      'tasks.stage.queued-review': '待审查',
      'tasks.stage.reviewing': '审查中',
      'tasks.stage.done': '已完成',
      'tasks.stage.archived': '已归档',
      'tasks.stageGroup.todo': '待办',
      'tasks.stageGroup.analyzing': '分析中',
      'tasks.stageGroup.queuedImplementation': '待实现',
      'tasks.stageGroup.implementing': '实现中',
      'tasks.stageGroup.queuedReview': '待审查',
      'tasks.stageGroup.done': '已完成',
      'tasks.stageEmpty': '任务台账里还没有任务。',
      'tasks.teamLine': '团队 {members} 成员 · {tasks} 张共享任务 · {orphaned} 条未关联',
      'tasks.controlFold': '历史控制词 {n} 条（遗留，不再新增）',
      'tasks.more': '还有 {n} 条未显示',
      'tasks.trendSummary': '近 {days} 天 · 新增 {created} · 完成 {done} · 归档 {archived}',
      'tasks.trendBar': '{date} 新增 {created} · 完成 {done} · 归档 {archived}',
      'tasks.trendApprox': '≈',
      'tasks.trendApproxTitle': '完成/归档按 updated_at 近似（无 done_at/archived_at）',
      'tasks.trendEmpty': '暂无趋势',
      'tasks.parentIn': '父在{group}',
      'display.collapseAll': '全部收起',
      'display.expandAll': '全部展开',
      'display.showExperiments': '实验',
      'display.showTrend': '趋势',
      'display.showHeartbeats': '心跳',
      'display.collapseCard': '收起此卡',
      'display.expandCard': '展开此卡',
      'display.experimentsOff': '项目未开启实验区（experiments.enabled=false）',
      'live.busy': '正在刷新…',
      'live.updated': '已更新',
      'live.error': '读取失败',
      'signals.hidden': '+{n} 条已隐藏（--all 见 CLI）',
      'tasks.expandChildren': '展开 {n} 个子任务',
      'tasks.collapseChildren': '收起 {n} 个子任务',
      'tasks.trendAria': '近 {days} 天任务趋势',
      'tasks.trendChartTitle': '近 {days} 天 · 新增 {created} · 完成 {done}',
      'tasks.trendLegendCreated': '新增',
      'tasks.trendLegendDone': '完成',
      'tasks.queueHead': '队列头',
      'tasks.queueEmpty': '暂无进行中任务',
      'tasks.owner': '会话',
      'tasks.gate.pass': '门禁通过',
      'tasks.gate.fail': '门禁失败',
      'tasks.detail.id': '编号',
      'tasks.detail.type': '类型',
      'tasks.detail.title': '标题',
      'tasks.detail.notes': '备注',
      'tasks.detail.allow': '文件域（允许）',
      'tasks.detail.deny': '文件域（禁止）',
      'tasks.detail.acceptance': '验收',
      'tasks.detail.commits': '提交',
      'tasks.detail.created': '创建于',
      'tasks.detail.updated': '更新于',
      'tasks.detail.dispatch': '工单',
      'tasks.dispatch.badge': '{who} · {round}/{attempt}',
      'tasks.dispatch.unassigned': '未指派',
      'tasks.dispatch.title': '工单 {status} · {who} · 第 {round} 轮 / 第 {attempt} 次',
      'tasks.dispatch.status.pending': '待派工',
      'tasks.dispatch.status.acked': '已确认',
      'tasks.dispatch.status.closed': '已关闭',
      'tasks.dispatch.stale': '已过期',
      'tasks.dispatch.orphan': '孤儿工单',
      'tasks.dispatch.expires': '到期于',
      'tasks.dispatch.outcome': '结果',
      'tasks.dispatch.closedAt': '关闭于',
      'framework.title': '框架视图',
      'framework.summary': '文件 {files} · 模块 {modules} · 缺语义 {missing} · 计划 {plans}',
      'framework.plans': '最近语义变更',
      'framework.plansEmpty': '还没有已实现的语义变更计划。',
      'framework.summaryDescription': '文件 {files} · 已描述模块 {described} · 缺语义 {missing} · 计划 {plans}',
      'framework.summaryGraph': '图模块 {modules} · 切片 {slices} · 角色 {roles} · 未归属 {unmanaged}',
      'framework.modules': '模块',
      'framework.slices': '横向切片',
      'framework.roles': '角色',
      'framework.unmanaged': '未归属文件',
      'framework.owns': '归属',
      'framework.sections': '区段',
      'framework.relatedSlices': '相关切片',
      'framework.semantics': '语义',
      'framework.ownerRole': '负责角色',
      'framework.rationale': '理由',
      'framework.files': '文件',
      'framework.missingFiles': '缺失文件',
      'framework.missing': '文件不存在',
      'framework.notOwned': '未归属模块',
      'framework.more': '还有更多',
      'framework.degraded': '模块图不可用（docs/module-domain.json 缺失或无法解析），仅显示描述摘要。',
      'framework.empty': '模块图里还没有模块。',
      'framework.slicesEmpty': '还没有横向切片。',
      'framework.selectHint': '选择左侧模块或下方切片查看语义与归属。',
      'framework.expand': '展开模块',
      'framework.collapse': '收起模块',
      'framework.warnings': '模块图警告',
      'aspect.title': 'aspect 锁',
      'aspect.summary': '占用 {held} / 共 {total}',
      'aspect.releasable': '可回收 {n}',
      'aspect.leaseSeconds': '{n} 秒后到期',
      'aspect.leaseMinutes': '{n} 分钟后到期',
      'aspect.leaseHours': '{n} 小时后到期',
      'aspect.leaseDays': '{n} 天后到期',
      'aspect.leaseExpired': '已过期',
      'aspect.ttlOnly': 'ttl-only',
      'aspect.waiters': '排队 {n}（最早 {age}）',
      'gates.title': '门禁',
      'gates.empty': '还没有门禁定义；用 flow gate add 创建',
      'gates.phase.commit': '提交',
      'gates.phase.release': '发布',
      'gates.phase.manual': '手动',
      'gates.never': '从未运行',
      'gates.run.ok': '✔ {time}',
      'gates.run.fail': '✘ {time}',
      'gates.steps': '步骤',
      'gates.summary': '启用 {on} / 共 {total}',
      'gate.enable': '启用',
      'gate.disable': '禁用',
      'gate.busy': '切换中…',
      'gate.disabled': '已禁用',
      'gate.toggleAria': '切换门禁：{title}',
      'gate.noId': '缺少 id，无法切换',
      'gate.error': '切换失败：{message}',
      'signals.title': '实时信号',
      'signals.heartbeat': '心跳',
      'signals.heartbeat.empty': '没有心跳文件。',
      'signals.heartbeat.stale': '可能已停',
      'hb.status.working': '工作中',
      'hb.status.idle': '空闲',
      'hb.status.waiting': '等待子会话',
      'hb.status.done': '已完成',
      'hb.status.missed': '已错过',
      'hb.status.dead': '已结束',
      'hb.counts': '活跃 {active} · 已结束 {dead} / 共 {total}',
      'hb.current': '本会话',
      'hb.task': '任务',
      'tasks.branch': '分支',
      'hb.branch': '分支',
      'hb.goal': '目标',
      'hb.claims': '文件域',
      'hb.claimsHint': '独占文件域，其他会话不应修改',
      'footer.source': '项目',
      'footer.generated': '生成于',
      'footer.contract': '契约：{source}',
      'contract.defaults': '默认布局',
      'footer.warnings': '{n} 条警告',
      'footer.warningsNone': '无警告',
      'workspace.pending': '正在读取当前工作区…',
      'empty.title': '未初始化',
      'empty.init': '初始化',
      'empty.initializing': '初始化中…',
      'error.notInitialized': '这个工作区还没有项目流台账。',
      'error.initHint': '点「初始化」在当前工作区创建 .agents/flow 台账，或在项目根运行 node bin/flow.mjs init。',
      'error.initFailed': '初始化失败：{message}',
      'decisions.title': '待决策 {n}',
      'decisions.blocking': '阻塞 {n}',
      'decisions.copy': '复制回答串',
      'decisions.copyAria': '复制决策 {id} 的回答命令',
      'decisions.more': '还有 {n} 条',
      'decisions.empty': '没有待决策',
      'misc.dash': '—',
      'misc.count': '{n} 条',
    };

    const en = {
      'tab.title': 'Project Flow',
      'guide.title': 'Project flow board',
      'guide.description': 'Experiments, tasks and live signals',
      'action.open': 'Open the project flow panel',
      'page.title': 'Project Flow',
      'page.readonly': 'Read-only',
      'top.head': 'HEAD',
      'top.branch': 'Branch',
      'top.currentBranch': 'Current branch',
      'top.dirty': '{n} uncommitted',
      'top.live': 'live',
      'top.liveStale': 'disconnected',
      'top.degraded': 'degraded',
      'top.degradedHint': 'backend CLI unavailable — read-only direct store fallback',
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
      'exp.total': 'total',
      'exp.empty': 'No experiments recorded yet.',
      'exp.emptyHint': 'Run flow exp add … or add the first one with the flow_exp tool.',
      'exp.more': '{n} more not shown',
      'exp.detail.hypothesis': 'Hypothesis',
      'exp.detail.expected': 'Expected',
      'exp.detail.measured': 'Measured',
      'exp.detail.none': 'not recorded',
      'exp.metrics': 'Metrics',
      'exp.notes': 'Notes',
      'exp.parent': 'Parent',
      'exp.commits': 'Commits',
      'exp.source.store': 'store',
      'exp.status.open': 'open',
      'exp.status.confirmed': 'confirmed',
      'exp.status.refuted': 'refuted',
      'exp.status.abandoned': 'abandoned',
      'exp.status.inconclusive': 'inconclusive',
      'exp.status.pivoted': 'pivoted',
      'exp.tree': 'Experiment tree',
      'tasks.title': 'Task progress',
      'tasks.total': '{n} tasks',
      'tasks.status.draft': 'draft',
      'tasks.status.active': 'active',
      'tasks.status.done': 'done',
      'tasks.status.archived': 'archived',
      'tasks.status.other': 'other',
      'tasks.current': 'Current task',
      'tasks.currentNone': 'none',
      'tasks.stage.created': 'Created',
      'tasks.stage.queued-analysis': 'Awaiting analysis',
      'tasks.stage.analyzing': 'Analyzing',
      'tasks.stage.queued-implementation': 'Awaiting implementation',
      'tasks.stage.implementing': 'Implementing',
      'tasks.stage.queued-review': 'Awaiting review',
      'tasks.stage.reviewing': 'Reviewing',
      'tasks.stage.done': 'Done',
      'tasks.stage.archived': 'Archived',
      'tasks.stageGroup.todo': 'Todo',
      'tasks.stageGroup.analyzing': 'Analyzing',
      'tasks.stageGroup.queuedImplementation': 'Awaiting implementation',
      'tasks.stageGroup.implementing': 'Implementing',
      'tasks.stageGroup.queuedReview': 'Awaiting review',
      'tasks.stageGroup.done': 'Done',
      'tasks.stageEmpty': 'The task ledger has no tasks yet.',
      'tasks.teamLine': 'Team {members} members · {tasks} shared tasks · {orphaned} unlinked',
      'tasks.controlFold': 'Legacy control words: {n} (no longer recorded)',
      'tasks.more': '{n} more not shown',
      'tasks.trendSummary': 'Last {days}d · {created} new · {done} done · {archived} archived',
      'tasks.trendBar': '{date} · {created} new · {done} done · {archived} archived',
      'tasks.trendApprox': '≈',
      'tasks.trendApproxTitle': 'done/archived approximated from updated_at (no done_at/archived_at)',
      'tasks.trendEmpty': 'No trend yet',
      'tasks.parentIn': 'parent in {group}',
      'display.collapseAll': 'Collapse all',
      'display.expandAll': 'Expand all',
      'display.showExperiments': 'Experiments',
      'display.showTrend': 'Trend',
      'display.showHeartbeats': 'Heartbeats',
      'display.collapseCard': 'Collapse this card',
      'display.expandCard': 'Expand this card',
      'display.experimentsOff': 'The experiment area is off for this project (experiments.enabled=false)',
      'live.busy': 'Refreshing…',
      'live.updated': 'Updated',
      'live.error': 'Read failed',
      'signals.hidden': '+{n} hidden (--all in the CLI)',
      'tasks.expandChildren': 'Expand {n} subtasks',
      'tasks.collapseChildren': 'Collapse {n} subtasks',
      'tasks.trendAria': 'Task trend over the last {days} days',
      'tasks.trendChartTitle': 'Last {days}d · {created} new · {done} done',
      'tasks.trendLegendCreated': 'new',
      'tasks.trendLegendDone': 'done',
      'tasks.queueHead': 'Queue head',
      'tasks.queueEmpty': 'Nothing in progress',
      'tasks.owner': 'session',
      'tasks.gate.pass': 'gate pass',
      'tasks.gate.fail': 'gate fail',
      'tasks.detail.id': 'Id',
      'tasks.detail.type': 'Type',
      'tasks.detail.title': 'Title',
      'tasks.detail.notes': 'Notes',
      'tasks.detail.allow': 'Scope (allow)',
      'tasks.detail.deny': 'Scope (deny)',
      'tasks.detail.acceptance': 'Acceptance',
      'tasks.detail.commits': 'Commits',
      'tasks.detail.created': 'Created',
      'tasks.detail.updated': 'Updated',
      'tasks.detail.dispatch': 'Dispatch',
      'tasks.dispatch.badge': '{who} · {round}/{attempt}',
      'tasks.dispatch.unassigned': 'unassigned',
      'tasks.dispatch.title': 'Dispatch {status} · {who} · round {round} / attempt {attempt}',
      'tasks.dispatch.status.pending': 'pending',
      'tasks.dispatch.status.acked': 'acked',
      'tasks.dispatch.status.closed': 'closed',
      'tasks.dispatch.stale': 'stale',
      'tasks.dispatch.orphan': 'orphan',
      'tasks.dispatch.expires': 'expires',
      'tasks.dispatch.outcome': 'Outcome',
      'tasks.dispatch.closedAt': 'Closed',
      'framework.title': 'Framework view',
      'framework.summary': '{files} files · {modules} modules · {missing} missing semantics · {plans} plans',
      'framework.plans': 'Recent semantic changes',
      'framework.plansEmpty': 'No implemented semantic-change plans yet.',
      'framework.summaryDescription': '{files} files · {described} described modules · {missing} missing semantics · {plans} plans',
      'framework.summaryGraph': 'Graph modules {modules} · slices {slices} · roles {roles} · unmanaged {unmanaged}',
      'framework.modules': 'Modules',
      'framework.slices': 'Cross-module slices',
      'framework.roles': 'Roles',
      'framework.unmanaged': 'Unmanaged files',
      'framework.owns': 'Owns',
      'framework.sections': 'Sections',
      'framework.relatedSlices': 'Related slices',
      'framework.semantics': 'Semantics',
      'framework.ownerRole': 'Owner role',
      'framework.rationale': 'Rationale',
      'framework.files': 'Files',
      'framework.missingFiles': 'Missing files',
      'framework.missing': 'file missing',
      'framework.notOwned': 'no owning module',
      'framework.more': 'more not shown',
      'framework.degraded': 'Module graph unavailable (docs/module-domain.json missing or unparsable); showing the description summary only.',
      'framework.empty': 'The module graph has no modules yet.',
      'framework.slicesEmpty': 'No cross-module slices yet.',
      'framework.selectHint': 'Select a module on the left or a slice below to see its semantics and ownership.',
      'framework.expand': 'Expand module',
      'framework.collapse': 'Collapse module',
      'framework.warnings': 'Module graph warnings',
      'aspect.title': 'Aspect locks',
      'aspect.summary': '{held} held / {total} total',
      'aspect.releasable': '{n} releasable',
      'aspect.leaseSeconds': 'expires in {n}s',
      'aspect.leaseMinutes': 'expires in {n}m',
      'aspect.leaseHours': 'expires in {n}h',
      'aspect.leaseDays': 'expires in {n}d',
      'aspect.leaseExpired': 'expired',
      'aspect.ttlOnly': 'ttl-only',
      'aspect.waiters': 'queued {n} (oldest {age})',
      'gates.title': 'Gates',
      'gates.empty': 'No gate definitions yet; create one with flow gate add',
      'gates.phase.commit': 'commit',
      'gates.phase.release': 'release',
      'gates.phase.manual': 'manual',
      'gates.never': 'never run',
      'gates.run.ok': '✔ {time}',
      'gates.run.fail': '✘ {time}',
      'gates.steps': 'Steps',
      'gates.summary': '{on} enabled / {total}',
      'gate.enable': 'Enable',
      'gate.disable': 'Disable',
      'gate.busy': 'Toggling…',
      'gate.disabled': 'Disabled',
      'gate.toggleAria': 'Toggle gate: {title}',
      'gate.noId': 'No id; cannot toggle',
      'gate.error': 'Toggle failed: {message}',
      'signals.title': 'Live signals',
      'signals.heartbeat': 'Heartbeats',
      'signals.heartbeat.empty': 'No heartbeat files.',
      'signals.heartbeat.stale': 'possibly stopped',
      'hb.status.working': 'working',
      'hb.status.idle': 'idle',
      'hb.status.waiting': 'waiting on subagents',
      'hb.status.done': 'done',
      'hb.status.missed': 'missed',
      'hb.status.dead': 'dead',
      'hb.counts': '{active} active · {dead} dead / {total}',
      'hb.current': 'current',
      'hb.task': 'Task',
      'tasks.branch': 'Branch',
      'hb.branch': 'Branch',
      'hb.goal': 'Goal',
      'hb.claims': 'Claims',
      'hb.claimsHint': 'Exclusive file scope; other sessions should not modify these',
      'footer.source': 'project',
      'footer.generated': 'generated',
      'footer.contract': 'contract: {source}',
      'contract.defaults': 'default layout',
      'footer.warnings': '{n} warnings',
      'footer.warningsNone': 'no warnings',
      'workspace.pending': 'Reading the current workspace…',
      'empty.title': 'Not initialized',
      'empty.init': 'Initialize',
      'empty.initializing': 'Initializing…',
      'error.notInitialized': 'This workspace has no project flow ledger yet.',
      'error.initHint': 'Click Initialize to create the .agents/flow ledger in this workspace, or run node bin/flow.mjs init in the project root.',
      'error.initFailed': 'Initialization failed: {message}',
      'decisions.title': '{n} pending decisions',
      'decisions.blocking': '{n} blocking',
      'decisions.copy': 'Copy answer command',
      'decisions.copyAria': 'Copy the answer command for {id}',
      'decisions.more': '{n} more',
      'decisions.empty': 'No pending decisions',
      'misc.dash': '—',
      'misc.count': '{n}',
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

    function basename(path) {
      const text = asText(path);
      if (!text) return '';
      const parts = text.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : text;
    }

    /** Short display key of a session id: drop the `session-` prefix, keep 8. */
    function shortSession(value) {
      const text = asText(value).trim().replace(/^session-/, '');
      return text ? text.slice(0, 8) : '';
    }

    /** Session ids compare without a `session-` prefix and case; empty never matches. */
    function sameSession(left, right) {
      const normalize = (value) => asText(value).trim().toLowerCase().replace(/^session-/, '');
      const a = normalize(left);
      const b = normalize(right);
      return a !== '' && a === b;
    }

    /** A heartbeat's session key: explicit `session` first, then the file stem. */
    function beatSessionKey(beat) {
      const explicit = asText(beat && beat.session);
      if (explicit) return explicit;
      const file = basename(beat && beat.file);
      return file ? file.replace(/\.[^.]+$/, '') : '';
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
    /** One flat store experiment record. */
    function normalizeItem(raw) {
      const item = asObject(raw);
      return {
        id: asText(item.id),
        title: asText(item.title),
        hypothesis: asText(item.hypothesis),
        factor: asText(item.factor),
        parent: asText(item.parent) || null,
        status: asText(item.status),
        expected: asText(item.expected),
        measured: asText(item.measured),
        scale: asText(item.scale),
        metrics: item.metrics === undefined ? null : item.metrics,
        commits: asArray(item.commits).map(asText).filter(Boolean),
        created_at: asText(item.created_at),
        updated_at: asText(item.updated_at),
        notes: asText(item.notes),
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

    /** `undefined`/`null` hides the section; `[]` shows it empty. */
    function normalizeGates(rawGates) {
      if (rawGates === undefined || rawGates === null) return null;
      return asArray(rawGates)
        .filter((gate) => gate && typeof gate === 'object' && !Array.isArray(gate))
        .map(normalizeGate);
    }

    /**
     * One heartbeat. Every row is the rich shape; a missing or extra field
     * never throws (the panel simply shows less).
     */
    function normalizeHeartbeat(raw) {
      const entry = asObject(raw);
      const stats = asObject(entry.stats);
      const updatedAt = asText(entry.updated_at);
      const ageSeconds = asNumber(entry.ageSeconds, null);
      const status = asText(entry.status).toLowerCase();
      const liveness = asText(entry.liveness);
      const reason = asText(entry.reason);
      const dead = liveness === 'dead';
      const stale =
        entry.stale === true ||
        (entry.stale !== false && Number.isFinite(ageSeconds) && ageSeconds > STALE_AFTER_SECONDS);
      return {
        file: asText(entry.file),
        title: asText(entry.title),
        statusLine: asText(entry.statusLine),
        ageSeconds,
        mtime: asNumber(entry.mtime, null),
        updatedMs: asNumber(Date.parse(updatedAt), null),
        session: asText(entry.session),
        agent: asText(entry.agent),
        goal: asText(entry.goal),
        task: asText(entry.task),
        /* 心跳行的任务阶段（宿主 join 任务卡后投影；旧记录/未挂任务为 null）。 */
        taskStage: asText(entry.taskStage),
        taskStageZh: asText(entry.taskStageZh),
        branch: asText(entry.branch),
        worktree: asText(entry.worktree),
        claims: asArray(entry.claims)
          .map((claim) => asText(claim).trim())
          .filter(Boolean),
        status,
        /* T-10: host liveness verdict; a dead session must not render "working". */
        liveness,
        reason,
        dead,
        lastAction: asText(entry.last_action),
        startedAt: asText(entry.started_at),
        endedAt: asText(entry.ended_at),
        stale,
        turn: asNumber(entry.turn, null),
        stats: {
          turns: asNumber(stats.turns, 0),
          missed: asNumber(stats.missed, 0),
        },
      };
    }

    /** `heartbeats` is `{ dir, items, counts }` or a plain item array. */
    function normalizeHeartbeats(raw) {
      const section = Array.isArray(raw) ? null : asObject(raw);
      const rawItems = Array.isArray(raw) ? raw : asArray(section.items);
      const items = asArray(rawItems)
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(normalizeHeartbeat);
      const countsSrc = asObject(section && section.counts);
      /* Same active rule as core: `live` is exempt from the 6 h fallback, a dead
         session never counts, and unknown/stale still needs freshness. */
      const derivedActive = items.filter((beat) => {
        const statusActive = beat.status === 'working' || beat.status === 'idle' || beat.status === 'waiting';
        if (!statusActive) return false;
        if (beat.liveness === 'live') return true;
        if (beat.liveness === 'dead' || beat.liveness === 'foreign' || beat.liveness === 'stale') return false;
        return beat.stale !== true;
      }).length;
      return {
        items,
        counts: {
          total: asNumber(countsSrc.total, items.length),
          active: asNumber(countsSrc.active, derivedActive),
          stale: asNumber(countsSrc.stale, items.filter((beat) => beat.stale).length),
          dead: asNumber(countsSrc.dead, items.filter((beat) => beat.dead).length),
        },
      };
    }

    /**
     * One pending decision, exactly the eleven canonical keys written below
     * (`id`, `kind`, `status`, `question`, `blocks`, `options`,
     * `recommendation`, `default`, `escalated`, `ageSeconds`, `asked_at`); the
     * selftest diffs that key set against its own copy of the shared contract.
     * `options` accepts `{id, label}` entries or bare ids; every other field
     * degrades to '' / [] / null on hostile input, so nothing here throws.
     */
    function normalizeDecision(raw) {
      const item = asObject(raw);
      const options = asArray(item.options)
        .map((option) => {
          if (!option || typeof option !== 'object' || Array.isArray(option)) {
            const id = asText(option).trim();
            return id ? { id, label: id } : null;
          }
          const entry = asObject(option);
          return { id: asText(entry.id).trim(), label: asText(entry.label) };
        })
        .filter((option) => option && (option.id !== '' || option.label !== ''));
      return {
        id: asText(item.id).trim(),
        kind: asText(item.kind),
        status: asText(item.status),
        question: asText(item.question),
        blocks: asArray(item.blocks)
          .map((block) => asText(block).trim())
          .filter(Boolean),
        options,
        recommendation: asText(item.recommendation),
        default: asText(item.default),
        escalated: item.escalated === true,
        ageSeconds: asNumber(item.ageSeconds, null),
        asked_at: asText(item.asked_at),
      };
    }

    /**
     * `decisions` is `{ items, counts }`; a missing, non-object or hostile
     * section becomes `{ items: [], counts: zeros }`. The seven counts are the
     * Host's tally — a missing key stays 0 here instead of being derived from
     * `items`, because the card keys off `counts.open`.
     */
    function normalizeDecisions(raw) {
      const section = asObject(raw);
      const countsSrc = asObject(section.counts);
      const counts = {};
      DECISION_COUNT_KEYS.forEach((key) => {
        counts[key] = asNumber(countsSrc[key], 0);
      });
      return {
        items: asArray(section.items)
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map(normalizeDecision),
        counts,
      };
    }

    /**
     * The single line that answers one decision: the recommendation, else the
     * default, else the first option id. '' means the decision offers no choice
     * (the card then renders no copy button). `input` decisions quote the text
     * because it may contain spaces.
     */
    function decisionAnswerCommand(item) {
      const decision = asObject(item);
      const id = asText(decision.id).trim();
      if (!id) return '';
      const options = asArray(decision.options);
      const first = options.length > 0 ? options[0] : null;
      const firstId =
        first && typeof first === 'object' && !Array.isArray(first)
          ? asText(asObject(first).id)
          : asText(first);
      const choice =
        asText(decision.recommendation).trim() ||
        asText(decision.default).trim() ||
        firstId.trim();
      if (!choice) return '';
      const line = 'flow decision answer ' + id + ' --choice ';
      return asText(decision.kind) === 'input' ? line + '"' + choice + '"' : line + choice;
    }

    /** A task row's optional dispatch work order (T-20261113155234 阶段 3). */
    function normalizeTaskDispatch(raw) {
      if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const src = raw;
      if (Object.keys(src).length === 0) return null;
      const positive = (value) => {
        const number = asNumber(value, 1);
        return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 1;
      };
      const statusRaw = asText(src.status);
      return {
        id: asText(src.id),
        round: positive(src.round),
        attempt: positive(src.attempt),
        agent: asText(src.agent),
        role: asText(src.role),
        /* The three-state panel view; outcome is a separate dimension. */
        status: statusRaw === 'acked' || statusRaw === 'closed' ? statusRaw : 'pending',
        expiresAt: asText(src.expiresAt),
        /* stale and orphan are independent flags, never derived from each other. */
        stale: src.stale === true,
        orphan: src.orphan === true,
        outcome: asText(src.outcome) || null,
        closedAt: asText(src.closedAt) || null,
      };
    }

    /**
     * One task row. Title and goal are the two visible lines; notes, scope,
     * acceptance, commits and the timestamps feed the expanded detail block.
     * Every field degrades to '' / [] on hostile input, never throws.
     */
    function normalizeTask(raw) {
      const task = asObject(raw);
      const scope = asObject(task.scope);
      const list = (value) =>
        asArray(value)
          .map((entry) => asText(entry).trim())
          .filter(Boolean);
      return {
        id: asText(task.id),
        /* Row contract: `type` is a string or '' — a non-string must not paint a
           `[object Object]: ` prefix on the title. */
        type: typeof task.type === 'string' ? task.type : '',
        title: asText(task.title),
        status: asText(task.status),
        owner: asText(task.owner),
        notes: asText(task.notes),
        scope: { allow: list(scope.allow), deny: list(scope.deny) },
        acceptance: list(task.acceptance),
        commits: list(task.commits),
        created_at: asText(task.created_at),
        updated_at: asText(task.updated_at),
        gate: asText(task.gate),
        /* task-71: 14th row key. The host derives it (stage.mjs); an older
           payload has none and the stage bucket falls back to status. */
        stage: asText(task.stage),
        /* T-13 A2 tree fields: absent on an older payload → null / 0 (flat). */
        parent: asText(task.parent) || null,
        depth: asNumber(task.depth, 0),
        /* 2026-11-09（审计项 11）：15th row key——捕获分支来源；缺失/空串 → null（不出徽标）。 */
        branch: asText(task.branch) || null,
        /* 16th row key (optional): the card's dispatch work order; absent = no badge. */
        dispatch: normalizeTaskDispatch(task.dispatch),
      };
    }

    /** A task group (`active` / `draft` / `recentDone`); non-objects are dropped. */
    /** `YYYY-MM-DD` → epoch day number on the local calendar (NaN when invalid). */
    function trendDayNumber(key) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asText(key));
      if (match === null) return Number.NaN;
      return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / TREND_DAY_MS);
    }

    /** `MM-DD` label for the day `index` steps after `from`. */
    function trendDayLabel(from, index, fallback) {
      const start = trendDayNumber(from);
      if (Number.isFinite(start) === false) return fallback;
      const date = new Date((start + index) * TREND_DAY_MS);
      return String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
    }

    /**
     * Trend section (T-09): `{from,to,days,estimatedFrom,created[],done[],archived[]}`.
     * Anything missing, mis-sized or non-numeric collapses to `null`, which hides
     * the whole row — an older payload must not render a bogus chart.
     */
    function normalizeTrend(value) {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
      const src = value;
      /* Deliberately tolerant on the numbers: the payload comes from our own
         snapshot, where numeric strings (e.g. days:'14') are the only plausible
         drift, and coercing them is more robust than dropping the whole trend.
         The shape stays strict — `days` must end up an integer in [1, 400] and
         every series must have exactly that many entries, else the row hides. */
      const days = asNumber(src.days, 0);
      if (Number.isInteger(days) === false || days < 1 || days > 400) return null;
      const series = (key) => {
        const list = asArray(src[key]);
        if (list.length !== days) return null;
        return list.map((entry) => asNumber(entry, 0));
      };
      const created = series('created');
      const done = series('done');
      const archived = series('archived');
      if (created === null || done === null || archived === null) return null;
      const from = asText(src.from);
      const to = asText(src.to);
      if (from === '' || to === '') return null;
      return {
        from,
        to,
        days,
        estimatedFrom: asText(src.estimatedFrom) || null,
        created,
        done,
        archived,
      };
    }

    /** task-73: team-board summary. `available` gates the whole panel line. */
    function boardTeamStatus(raw) {
      const team = asObject(raw);
      const count = (value) => {
        const number = asNumber(value, 0);
        return number > 0 ? Math.floor(number) : 0;
      };
      return {
        available: team.available === true,
        members: count(team.members),
        tasks: count(team.tasks),
        linked: count(team.linked),
        missing: count(team.missing),
        orphaned: count(team.orphaned),
      };
    }

    function normalizeTasks(value) {
      return asArray(value)
        .filter((task) => task && typeof task === 'object' && !Array.isArray(task))
        .map(normalizeTask);
    }

    /** `tasks.stages`: stage id → rows; non-object buckets are dropped. */
    function normalizeTaskStages(value) {
      const source = asObject(value);
      const out = {};
      for (const stage of Object.keys(source)) out[stage] = normalizeTasks(source[stage]);
      return out;
    }

    /** Tolerant mapping of the host payload; never throws on missing fields. */
    /**
     * Framework view projection: description-ledger counts + the latest
     * implemented semantic-change plans. Returns null when the ledger is absent
     * (`available !== true`), which is the card's hide signal. A counter that
     * was not computable stays null and renders as "—", never as a fake 0.
     */
    function normalizeDescription(raw) {
      const src = asObject(raw);
      if (src.available !== true) return null;
      const countsSrc = asObject(src.counts);
      const countOf = (value) => {
        const number = asNumber(value, null);
        return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
      };
      return {
        counts: {
          files: countOf(countsSrc.files),
          modules: countOf(countsSrc.modules),
          missingSemantics: countOf(countsSrc.missingSemantics),
          plans: countOf(countsSrc.plans),
        },
        plans: asArray(src.recentPlans)
          .map((entry) => asObject(entry))
          .map((entry) => {
            const at = asText(entry.at);
            const atMs = Date.parse(at);
            return {
              task: asText(entry.task),
              title: asText(entry.title),
              at,
              atMs: Number.isFinite(atMs) ? atMs : null,
            };
          })
          .filter((entry) => entry.task !== '')
          .slice(0, 5),
      };
    }

    /**
     * Framework graph projection (T-20261113162857): the viewed workspace's
     * docs/module-domain.json as projected by the host. Every list is tolerant;
     * `degraded:true` means only `summary` is trustworthy, so the card must hide
     * the tree and the slices instead of inventing an empty graph.
     */
    function normalizeFramework(raw) {
      const src = asObject(raw);
      if (Object.keys(src).length === 0) return null;
      const countOf = (value) => {
        const number = asNumber(value, null);
        return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
      };
      const summarySrc = asObject(src.summary);
      const summary = {
        files: countOf(summarySrc.files),
        describedModules: countOf(summarySrc.describedModules),
        missingSemantics: countOf(summarySrc.missingSemantics),
        plans: countOf(summarySrc.plans),
        graphModules: countOf(summarySrc.graphModules),
        graphSlices: countOf(summarySrc.graphSlices),
        graphRoles: countOf(summarySrc.graphRoles),
        graphUnmanaged: countOf(summarySrc.graphUnmanaged),
      };
      const degraded = src.degraded === true;
      const textList = (value) => asArray(value).map(asText).filter(Boolean);
      const modules = degraded
        ? []
        : asArray(src.modules)
            .map((entry) => asObject(entry))
            .map((module) => ({
              name: asText(module.name),
              title: asText(module.title),
              owns: asArray(module.owns)
                .map((item) => asObject(item))
                .map((item) => ({ path: asText(item.path), kind: asText(item.kind) === 'dir' ? 'dir' : 'file' }))
                .filter((item) => item.path !== ''),
              sections: asArray(module.sections)
                .map((section) => asObject(section))
                .map((section) => ({
                  key: asText(section.key),
                  members: textList(section.members),
                  membersTruncated: section.membersTruncated === true,
                }))
                .filter((section) => section.key !== ''),
              sectionsTruncated: module.sectionsTruncated === true,
              slices: textList(module.slices),
            }))
            .filter((module) => module.name !== '');
      const slices = degraded
        ? []
        : asArray(src.slices)
            .map((entry) => asObject(entry))
            .map((slice) => ({
              id: asText(slice.id),
              title: asText(slice.title),
              semantics: asText(slice.semantics),
              ownerRole: asText(slice.ownerRole),
              rationale: asText(slice.rationale),
              files: asArray(slice.files)
                .map((file) => asObject(file))
                .map((file) => ({
                  path: asText(file.path),
                  moduleName: asText(file.moduleName) || null,
                  exists: file.exists !== false,
                }))
                .filter((file) => file.path !== ''),
              modules: textList(slice.modules),
              missingFiles: textList(slice.missingFiles),
              filesTruncated: slice.filesTruncated === true,
              missingFilesTruncated: slice.missingFilesTruncated === true,
            }))
            .filter((slice) => slice.id !== '');
      const roles = degraded
        ? []
        : asArray(src.roles)
            .map((entry) => asObject(entry))
            .map((role) => ({
              id: asText(role.id),
              title: asText(role.title),
              semantics: asText(role.semantics),
              modules: textList(role.modules),
            }))
            .filter((role) => role.id !== '');
      const unmanaged = degraded
        ? []
        : asArray(src.unmanaged)
            .map((entry) => asObject(entry))
            .map((row) => ({ path: asText(row.path), reason: asText(row.reason) }))
            .filter((row) => row.path !== '');
      return {
        summary,
        degraded,
        modules,
        slices,
        roles,
        unmanaged,
        warnings: textList(src.warnings),
        modulesTruncated: src.modulesTruncated === true,
        slicesTruncated: src.slicesTruncated === true,
        rolesTruncated: src.rolesTruncated === true,
        unmanagedTruncated: src.unmanagedTruncated === true,
      };
    }

    /**
     * aspect 锁段（T-20261112211817）：宿主富化产物（数据来自 `flow aspect list --json`）。
     * 键缺席、available!==true 或没有锁 → null，PanelView 不挂载整张卡（隐藏而不是报错）。
     */
    function normalizeAspects(value) {
      const src = asObject(value);
      if (src === null || src.available !== true) return null;
      const items = asArray(src.items)
        .map((entry) => asObject(entry))
        .map((entry) => {
          const owner = asObject(entry.owner);
          const leaseAt = asText(entry.leaseExpiresAt);
          const leaseMs = Date.parse(leaseAt);
          return {
            aspect: asText(entry.aspect),
            title: asText(entry.title),
            state: asText(entry.state) || 'held',
            releasable: entry.releasable === true,
            evidence: asText(entry.evidence),
            reason: asText(entry.reason),
            leaseMs: Number.isFinite(leaseMs) ? leaseMs : null,
            ownerSession: asText(owner.session),
            waiters: asArray(entry.waiters)
              .map((waiter) => asObject(waiter))
              .map((waiter) => ({ session: asText(waiter.session), since: asText(waiter.since) }))
              .filter((waiter) => waiter.session !== ''),
          };
        })
        .filter((entry) => entry.aspect !== '');
      if (items.length === 0) return null;
      const counts = asObject(src.counts);
      return {
        livenessEvidence: asText(src.livenessEvidence),
        counts: {
          total: Math.max(0, Math.floor(asNumber(counts.total, items.length))),
          held: Math.max(0, Math.floor(asNumber(counts.held, items.filter((item) => item.state === 'held').length))),
          releasable: Math.max(0, Math.floor(asNumber(counts.releasable, items.filter((item) => item.releasable === true).length))),
        },
        items,
      };
    }

    function normalize(payload) {
      const src = asObject(payload);
      const headSrc = asObject(src.head);
      const chSrc = asObject(src.currentHead);
      const expSrc = asObject(src.experiments);
      const tasksSrc = asObject(src.tasks);
      /* `contract` is optional; when absent the footer line is hidden entirely. */
      const contractSrc =
        src.contract && typeof src.contract === 'object' && !Array.isArray(src.contract)
          ? src.contract
          : null;

      const items = asArray(expSrc.items)
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map(normalizeItem);
      const tree = asArray(expSrc.tree)
        .filter((node) => node && typeof node === 'object' && !Array.isArray(node))
        .map((node) => normalizeTreeNode(node, 0));

      /* Status tally from each item; explicit `counts` on the payload win. */
      const statusTally = { open: 0, confirmed: 0, refuted: 0, abandoned: 0, inconclusive: 0, pivoted: 0 };
      items.forEach((item) => {
        if (Object.prototype.hasOwnProperty.call(statusTally, item.status)) statusTally[item.status] += 1;
      });
      const expCounts = asObject(expSrc.counts);
      const counts = {
        open: asNumber(expCounts.open, statusTally.open),
        confirmed: asNumber(expCounts.confirmed, statusTally.confirmed),
        refuted: asNumber(expCounts.refuted, statusTally.refuted),
        abandoned: asNumber(expCounts.abandoned, statusTally.abandoned),
        inconclusive: asNumber(expCounts.inconclusive, statusTally.inconclusive),
        pivoted: asNumber(expCounts.pivoted, statusTally.pivoted),
      };
      const expTotal = asNumber(
        expSrc.total,
        counts.open + counts.confirmed + counts.refuted + counts.abandoned
      );

      const taskCountsSrc = asObject(tasksSrc.counts);
      const gates = normalizeGates(src.gates);
      const heartbeatSection = normalizeHeartbeats(src.heartbeats);
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
        /* The ledger may live in the project's main worktree while this panel was
           asked for a linked worktree; keep both roots so the header can say so. */
        ledgerRoot: asText(src.ledgerRoot),
        worktree: src.worktree === true,
        /* T-20261112154725：宿主读不到后端 CLI（spawn 失败/超时/坏信封）时退回只读直连，
           payload 带 degraded + 原因；页头必须有一个可见标记，不能只塞进警告折叠区。 */
        degraded: src.degraded === true,
        degradedReason: asText(src.degradedReason),
        currentHead: {
          sha: asText(chSrc.sha),
          subject: asText(chSrc.subject),
          branch: asText(chSrc.branch),
          dirty: asNumber(chSrc.dirty, 0),
        },
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
          /* Strict true: a payload without the flag closes the experiment area. */
          enabled: expSrc.enabled === true,
          total: expTotal,
          confirmed: counts.confirmed,
          refuted: counts.refuted,
          open: counts.open,
          abandoned: counts.abandoned,
          inconclusive: counts.inconclusive,
          pivoted: counts.pivoted,
          counts,
          items,
          tree,
        },
        tasks: {
          total: asNumber(tasksSrc.total, 0),
          counts: {
            draft: asNumber(taskCountsSrc.draft, 0),
            active: asNumber(taskCountsSrc.active, 0),
            done: asNumber(taskCountsSrc.done, 0),
            archived: asNumber(taskCountsSrc.archived, 0),
            /* Task records whose status is not one of the four canonical ones. */
            other: asNumber(taskCountsSrc.other, 0),
          },
          current: tasksSrc.current === undefined ? null : tasksSrc.current,
          /* A host payload may omit `draft`; an absent array simply lists nothing. */
          draft: normalizeTasks(tasksSrc.draft),
          active: normalizeTasks(tasksSrc.active),
          recentDone: normalizeTasks(tasksSrc.recentDone),
          /* task-71: nine stage buckets + their counts, generated by the host
             from STAGE_IDS. Absent on an older payload; the card falls back to
             the three legacy arrays for grouping. */
          stageCounts: asObject(tasksSrc.stageCounts),
          stages: normalizeTaskStages(tasksSrc.stages),
          /* task-77: control-word captures are counted, never bucketed. */
          control: {
            count: Math.max(0, Math.floor(asNumber(asObject(tasksSrc.control).count, 0))),
            ids: asArray(asObject(tasksSrc.control).ids).map(asText).filter(Boolean),
          },
          trend: normalizeTrend(tasksSrc.trend),
        },
        /* task-73: read-only Team-board summary. Absent on an older payload →
           available:false, so the panel hides the line instead of showing 0. */
        team: boardTeamStatus(src.team),
        /* T-20261112211817：aspect 锁段；null = 后端不可用/没有锁，整卡隐藏。 */
        aspects: normalizeAspects(src.aspects),
        gates,
        heartbeats: heartbeatSection.items,
        heartbeatCounts: heartbeatSection.counts,
        /* T-13 A5: rows the payload held back (hidden dead/stale beats). */
        heartbeatsHidden: asNumber(src.heartbeatsHidden, 0),
        decisions: normalizeDecisions(src.decisions),
        /* Read-only framework view over the description ledger; null hides it. */
        description: normalizeDescription(src.description),
        /* Module-map graph for the framework card; degraded carries summary only. */
        framework: normalizeFramework(src.framework),
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
          Number.isFinite(props.count) ? React.createElement('span', { className: 'project-flow-count' }, ' (' + props.count + ')') : null,
          props.countText
            ? React.createElement('span', { className: 'project-flow-count' }, ' (' + props.countText + ')')
            : null
        ),
        props.open ? React.createElement('div', { className: 'project-flow-sectionBody' }, props.children) : null
      );
    }

    function EmptyLine(props) {
      return React.createElement('p', { className: 'project-flow-empty' }, props.children);
    }

    /** Who to show for a work order: agent, else role, else the localized fallback. */
    function dispatchWhoOf(dispatch, t) {
      return asText(dispatch.agent) || asText(dispatch.role) || t('tasks.dispatch.unassigned');
    }

    /** Collapsed-row badge text: who + round/attempt. */
    function dispatchBadgeText(dispatch, t) {
      return t('tasks.dispatch.badge', {
        who: dispatchWhoOf(dispatch, t),
        round: asNumber(dispatch.round, 1),
        attempt: asNumber(dispatch.attempt, 1),
      });
    }

    /** Full tooltip/aria text: status + who + round/attempt + stale/orphan/expiry. */
    function dispatchTitleText(dispatch, t) {
      const parts = [
        t('tasks.dispatch.title', {
          status: t('tasks.dispatch.status.' + asText(dispatch.status)),
          who: dispatchWhoOf(dispatch, t),
          round: asNumber(dispatch.round, 1),
          attempt: asNumber(dispatch.attempt, 1),
        }),
      ];
      if (dispatch.stale === true) parts.push(t('tasks.dispatch.stale'));
      if (dispatch.orphan === true) parts.push(t('tasks.dispatch.orphan'));
      if (asText(dispatch.expiresAt)) parts.push(t('tasks.dispatch.expires') + ': ' + dispatch.expiresAt);
      return parts.join(' · ');
    }

    /**
     * Expanded-detail one-liner: status and outcome are separate dimensions.
     * A closed order shows its outcome and closedAt even when outcome is absent
     * (an explicit dash, never a silently dropped result field).
     */
    function dispatchDetailText(dispatch, t) {
      const parts = [t('tasks.dispatch.status.' + asText(dispatch.status)), dispatchBadgeText(dispatch, t)];
      if (asText(dispatch.status) === 'closed') {
        parts.push(t('tasks.dispatch.outcome') + ': ' + (asText(dispatch.outcome) || t('misc.dash')));
        parts.push(t('tasks.dispatch.closedAt') + ': ' + (asText(dispatch.closedAt) || t('misc.dash')));
      } else if (asText(dispatch.outcome)) {
        parts.push(t('tasks.dispatch.outcome') + ': ' + dispatch.outcome);
      }
      if (dispatch.stale === true) parts.push(t('tasks.dispatch.stale'));
      if (dispatch.orphan === true) parts.push(t('tasks.dispatch.orphan'));
      if (asText(dispatch.expiresAt)) parts.push(t('tasks.dispatch.expires') + ': ' + dispatch.expiresAt);
      return parts.join(' · ');
    }

    /** Owner + relative update time shown as the row's small meta line. */
    function taskMetaText(task, now, t) {
      const owner = asText(task.owner);
      const updatedMs = Date.parse(asText(task.updated_at));
      const updated = relativeMoment(updatedMs, now, t);
      return joinParts([owner ? t('tasks.owner') + ' ' + owner : '', updated || '']);
    }

    /**
     * Expanded detail of one task: every ledger field (bounded by the Host) plus
     * the business id, which the collapsed row also shows as its signature.
     */
    function TaskDetail(props) {
      const task = asObject(props.task);
      const t = props.t;
      const scope = asObject(task.scope);
      const lines = (value) =>
        asArray(value)
          .map((entry) => asText(entry))
          .filter(Boolean)
          .join('\n');
      const rows = [
        { label: t('tasks.detail.id'), value: asText(task.id) },
        { label: t('tasks.detail.type'), value: asText(task.type) },
        { label: t('tasks.detail.title'), value: asText(task.title) },
        { label: t('tasks.detail.notes'), value: asText(task.notes) },
        { label: t('tasks.detail.allow'), value: lines(scope.allow) },
        { label: t('tasks.detail.deny'), value: lines(scope.deny) },
        { label: t('tasks.detail.acceptance'), value: lines(task.acceptance) },
        { label: t('tasks.detail.commits'), value: asArray(task.commits).map(shortSha).filter(Boolean).join(', ') },
        { label: t('tasks.detail.created'), value: asText(task.created_at) },
        { label: t('tasks.detail.updated'), value: asText(task.updated_at) },
      ];
      if (task.dispatch && typeof task.dispatch === 'object') {
        rows.push({ label: t('tasks.detail.dispatch'), value: dispatchDetailText(task.dispatch, t) });
      }
      return React.createElement(
        'div',
        { className: 'project-flow-detail project-flow-taskDetail' },
        rows.map((row, index) =>
          React.createElement(
            'div',
            { className: 'project-flow-detailItem', key: 'task-detail-' + index },
            React.createElement('span', { className: 'project-flow-detailLabel' }, row.label),
            React.createElement('pre', { className: 'project-flow-detailValue' }, row.value || t('misc.dash'))
          )
        )
      );
    }

    /**
     * One task row: a single collapsed line — `type: title`, the stage badge,
     * owner/time as small meta and the business id as a right-aligned signature.
     * Everything else (notes, scope, acceptance, commits, timestamps) lives in
     * the detail, revealed by the head — a focusable `role="button"` with
     * `aria-expanded` and `aria-controls`, toggled by click or Enter/Space.
     */
    function TaskRow(props) {
      const task = asObject(props.task);
      const t = props.t;
      const open = props.open === true;
      /* T-13 A3 tree facet: depth for the indent, a caret that is its OWN button
         (so it never triggers the row's detail toggle), and the child <ul>. */
      const tree = asObject(props.tree);
      const depth = asNumber(tree.depth, 0);
      const visualDepth = Math.min(depth, 3);
      const hasChildren = tree.hasChildren === true;
      const expanded = tree.expanded !== false;
      const toggleChildren = () => {
        if (typeof tree.onToggleChildren === 'function') tree.onToggleChildren();
      };
      const caretLabel = t(expanded ? 'tasks.collapseChildren' : 'tasks.expandChildren', {
        n: asNumber(tree.childCount, 0),
      });
      const type = asText(task.type);
      const title = asText(task.title);
      /* `': '` is hardcoded on purpose (D-6): a missing type shows the bare
         title, with no prefix and no placeholder. */
      const heading = type ? type + ': ' + title : title;
      const signature = asText(task.id);
      /* `rowKey` is the forest's unique node id (`row-<index>` for a legacy record
         without a business id), so two id-less rows never share a DOM id. */
      const detailId = 'project-flow-taskDetail-' + (asText(props.rowKey) || signature || 'row');
      const stage = asText(task.stage);
      const stageLabel =
        stage === '' ? '' : STAGE_LABEL_KEYS[stage] ? t(STAGE_LABEL_KEYS[stage]) : t('tasks.stage.' + stage);
      const stageClosed = stage === 'done' || stage === 'archived';
      const meta = taskMetaText(task, props.now, t);
      const gate = asText(task.gate);
      const mark = gate === 'pass' ? '\u2714' : gate === 'fail' ? '\u2718' : '';
      const tone = gate === 'pass' ? 'ok' : gate === 'fail' ? 'error' : '';
      const toggle = () => {
        if (typeof props.onToggle === 'function') props.onToggle(asText(task.id));
      };
      const caret = hasChildren
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'project-flow-taskCaret',
              'aria-expanded': expanded ? true : false,
              'aria-controls': asText(tree.controlsId),
              'aria-label': caretLabel,
              title: caretLabel,
              onClick: (event) => {
                /* The row header is itself a button: stop the caret click from
                   bubbling into it, or opening the tree would open the detail. */
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                toggleChildren();
              },
              onKeyDown: (event) => {
                if (!event) return;
                const key = event.key || event.keyCode;
                if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
                if (typeof event.preventDefault === 'function') event.preventDefault();
                toggleChildren();
              },
            },
            expanded ? '\u25BE' : '\u25B8'
          )
        : null;
      const badge = asText(tree.badge);
      const branch = asText(task && task.branch);
      const dispatch = task.dispatch && typeof task.dispatch === 'object' ? task.dispatch : null;
      return React.createElement(
        'li',
        {
          className: 'project-flow-taskRow' + (depth > 0 ? ' project-flow-taskNested' : ''),
          style: visualDepth > 0 ? { '--d': visualDepth } : undefined,
          'aria-level': visualDepth + 1,
          'data-depth': depth,
        },
        React.createElement(
          'div',
          {
            className: 'project-flow-taskHead',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? true : false,
            'aria-controls': detailId,
            title: heading || undefined,
            onClick: toggle,
            onKeyDown: (event) => {
              if (!event) return;
              const key = event.key || event.keyCode;
              if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
              if (typeof event.preventDefault === 'function') event.preventDefault();
              toggle();
            },
          },
          caret,
          mark
            ? React.createElement(
                'span',
                {
                  className: 'project-flow-taskMark project-flow-gateMark project-flow-gateMark--' + tone,
                  title: t(gate === 'pass' ? 'tasks.gate.pass' : 'tasks.gate.fail'),
                  'aria-hidden': 'true',
                },
                mark
              )
            : null,
          React.createElement('span', { className: 'project-flow-taskTitle', title: heading || undefined }, heading || t('misc.dash')),
          /* task-71: the nine-stage badge, right after `type: title`; done/archived
             take the secondary tone so finished work does not compete for the eye. */
          stageLabel === ''
            ? null
            : React.createElement(
                'span',
                {
                  className: 'project-flow-taskStage' + (stageClosed ? ' project-flow-taskStage--closed' : ''),
                  title: stage,
                },
                stageLabel
              ),
          /* 2026-11-09（审计项 11）：任务卡的分支来源徽标。只有捕获建卡才有
             `source.branch`；手写/旧记录为 null，不渲染（不占位）。 */
          branch
            ? React.createElement(
                'span',
                { className: 'project-flow-taskBranch', title: joinParts([t('tasks.branch'), branch]) },
                branch
              )
            : null,
          dispatch
            ? React.createElement(
                'span',
                {
                  className:
                    'project-flow-taskDispatch project-flow-taskDispatch--' +
                    asText(dispatch.status) +
                    (dispatch.stale === true ? ' project-flow-taskDispatch--stale' : '') +
                    (dispatch.orphan === true ? ' project-flow-taskDispatch--orphan' : ''),
                  title: dispatchTitleText(dispatch, t),
                  role: 'img',
                  'aria-label': dispatchTitleText(dispatch, t),
                },
                dispatchBadgeText(dispatch, t)
              )
            : null,
          badge ? React.createElement('span', { className: 'project-flow-taskBadge', title: badge }, badge) : null,
          meta ? React.createElement('span', { className: 'project-flow-taskMeta' }, meta) : null,
          React.createElement('span', { className: 'project-flow-taskSignature', title: signature || undefined }, signature)
        ),
        /* The slot exists in both states so `aria-controls` always points at a
           real element; its content is created only while open, keeping the
           collapsed row a single line and out of the accessibility tree. */
        React.createElement(
          'div',
          { id: detailId, className: 'project-flow-taskDetailSlot', hidden: open ? undefined : true },
          open ? React.createElement(TaskDetail, { task, t, now: props.now }) : null
        ),
        tree.childrenList || null
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

    // #region shared fold header
    /**
     * One fold header: a real <button> (keyboard reachable, `aria-expanded` /
     * `aria-controls`) carrying a chevron, an already-translated label and a
     * count chip.
     *
     * Shared by the task card's groups and the experiment tree so both render the
     * same DOM and reuse the `.project-flow-groupToggle` styling. `countText`
     * overrides the default "<n>" template when a section wants other copy.
     */
    function FoldHeader(props) {
      const t = props.t;
      const expanded = props.expanded === true;
      const label = asText(props.label);
      const countText =
        typeof props.countText === 'string' && props.countText !== ''
          ? props.countText
          : t('misc.count', { n: asNumber(props.count, 0) });
      return React.createElement(
        'div',
        { className: 'project-flow-groupHead' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'project-flow-groupToggle',
            'aria-expanded': expanded,
            'aria-controls': props.controlsId,
            onClick: () => {
              if (typeof props.onToggle === 'function') props.onToggle();
            },
          },
          React.createElement(
            'span',
            { className: 'project-flow-groupChevron', 'aria-hidden': 'true' },
            expanded ? '\u25BE' : '\u25B8'
          ),
          React.createElement('span', null, label),
          React.createElement('span', { className: 'project-flow-groupCount' }, countText)
        )
      );
    }
    // #endregion

    function ExperimentTree(props) {
      const exp = props.exp || {};
      const t = props.t;
      const now = props.now;
      const [openItems, setOpenItems] = useState({});
      /* The whole tree starts folded: the card then costs three lines, and a
         50-experiment ledger never pushes the task queue off screen. */
      const [treeOpen, setTreeOpen] = useState(false);

      const toggleItem = (key) => {
        setOpenItems((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      const counts = asObject(exp.counts);
      const confirmed = asNumber(counts.confirmed, 0);
      const refuted = asNumber(counts.refuted, 0);
      const openCount = asNumber(counts.open, 0);
      const abandoned = asNumber(counts.abandoned, 0);
      const inconclusive = asNumber(counts.inconclusive, 0);
      const pivoted = asNumber(counts.pivoted, 0);
      const total = asNumber(exp.total, confirmed + refuted + openCount + abandoned);

      const children = [];
      const treeRows = flattenTree(composeTree(exp), [], []);
      let budget = MAX_TREE_ROWS;
      let hidden = 0;

      treeRows.forEach((row, index) => {
        if (budget <= 0) {
          hidden += 1;
          return;
        }
        budget -= 1;
        const item = row.item || {};
        /* Expansion is keyed by the experiment id, so a reordered refresh (new
           item, changed sort) keeps the same row open. Rows without an id fall
           back to their render index. */
        const itemId = asText(item.id);
        const key = itemId !== '' ? itemId : 'tree-' + index;
        const expanded = openItems[key] === true;
        const verdict = verdictOf(item.status);
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

      if (hidden > 0) {
        children.push(
          React.createElement('p', { className: 'project-flow-muted project-flow-more', key: 'more' }, t('exp.more', { n: hidden }))
        );
      }

      const chips = [
        React.createElement(Chip, { key: 'source', tone: 'brand' }, t('exp.source.store')),
        React.createElement(Chip, { key: 'confirmed', tone: 'ok' }, '\u2714 ' + confirmed + ' ' + t('exp.status.confirmed')),
        React.createElement(Chip, { key: 'refuted', tone: 'error' }, '\u2718 ' + refuted + ' ' + t('exp.status.refuted')),
        React.createElement(Chip, { key: 'open', tone: 'warn' }, '\u25cb ' + openCount + ' ' + t('exp.status.open')),
      ];
      if (abandoned > 0) {
        chips.push(
          React.createElement(Chip, { key: 'abandoned' }, '\u2298 ' + abandoned + ' ' + t('exp.status.abandoned'))
        );
      }
      if (inconclusive > 0) {
        chips.push(React.createElement(Chip, { key: 'inconclusive' }, '? ' + inconclusive + ' ' + t('exp.status.inconclusive')));
      }
      if (pivoted > 0) {
        chips.push(React.createElement(Chip, { key: 'pivoted' }, '\u21bb ' + pivoted + ' ' + t('exp.status.pivoted')));
      }
      chips.push(React.createElement(Chip, { key: 'total' }, total + ' ' + t('exp.total')));

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          props.showTitle === false ? null : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('exp.title')),
          React.createElement('div', { className: 'project-flow-chips' }, chips)
        ),
        total === 0
          ? React.createElement(
              'div',
              { className: 'project-flow-guide' },
              React.createElement('p', { className: 'project-flow-guideTitle' }, t('exp.empty')),
              React.createElement('p', { className: 'project-flow-muted' }, t('exp.emptyHint'))
            )
          : React.createElement(FoldHeader, {
              t,
              label: t('exp.tree'),
              count: total,
              expanded: treeOpen,
              controlsId: 'project-flow-expTree',
              onToggle: () => setTreeOpen((open) => !open),
            }),
        /* Always rendered so the toggle's aria-controls always resolves; the
           rows themselves only exist while the tree is open. */
        total === 0
          ? null
          : React.createElement(
              'div',
              { id: 'project-flow-expTree', hidden: treeOpen ? undefined : true },
              treeOpen
                ? children.length === 0
                  ? React.createElement(EmptyLine, null, t('misc.dash'))
                  : React.createElement('div', { className: 'project-flow-tree' }, children)
                : null
            )
      );
    }
    // #endregion

    // #region right column cards
    /**
     * Trend sparkline (T-09): one stacked bar per day, created / done / archived.
     *
     * `estimatedFrom !== null` means the derived series leaned on `updated_at`
     * for that day onwards (the ledger has no `done_at`/`archived_at` there):
     * those bars drop to 60% opacity, the summary gets a `≈`, and the bar title
     * says why. An all-zero window is a placeholder, not an empty chart; a
     * payload without `trend` renders nothing at all.
     */
    function TrendBlock(props) {
      /* `asObject()` normalizes null to {}, so the raw value is checked here —
         an older payload (no `tasks.trend`) must render nothing at all. */
      const trend = props.trend;
      if (
        trend === null ||
        trend === undefined ||
        typeof trend !== 'object' ||
        Array.isArray(trend) ||
        Array.isArray(trend.created) === false ||
        Array.isArray(trend.done) === false ||
        Array.isArray(trend.archived) === false
      ) {
        return null;
      }
      const t = props.t;
      const days = trend.days;
      const created = trend.created;
      const done = trend.done;
      const archived = trend.archived;
      const sum = (list) => list.reduce((total, value) => total + asNumber(value, 0), 0);
      const totals = [];
      for (let index = 0; index < days; index += 1) {
        totals.push(asNumber(created[index], 0) + asNumber(done[index], 0) + asNumber(archived[index], 0));
      }
      const approxFrom =
        trend.estimatedFrom === null
          ? -1
          : (() => {
              const from = trendDayNumber(trend.from);
              const at = trendDayNumber(trend.estimatedFrom);
              if (Number.isFinite(from) === false || Number.isFinite(at) === false) return -1;
              const index = at - from;
              /* An approximation that starts at (or before) the window head covers
                 every bar; one that starts after the window tail covers none. */
              if (index <= 0) return 0;
              return index >= days ? -1 : index;
            })();
      const approx = approxFrom >= 0;

      const head = React.createElement(
        'div',
        { className: 'project-flow-trendHead' },
        approx
          ? React.createElement(
              'span',
              { className: 'project-flow-trendApprox', title: t('tasks.trendApproxTitle') },
              t('tasks.trendApprox')
            )
          : null,
        React.createElement(
          'span',
          { className: 'project-flow-muted project-flow-trendSummary' },
          t('tasks.trendSummary', {
            days,
            created: sum(created),
            done: sum(done),
            archived: sum(archived),
          })
        ),
        React.createElement(
          'span',
          { className: 'project-flow-trendLegend' },
          React.createElement(
            'span',
            { className: 'project-flow-trendLegendItem project-flow-trendLegendCreated' },
            '\u25CF ' + t('tasks.trendLegendCreated')
          ),
          React.createElement(
            'span',
            { className: 'project-flow-trendLegendItem project-flow-trendLegendDone' },
            '\u25CF ' + t('tasks.trendLegendDone')
          )
        )
      );

      if (totals.every((value) => value === 0)) {
        return React.createElement(
          'div',
          { className: 'project-flow-trend' },
          head,
          React.createElement(
            'p',
            { className: 'project-flow-muted project-flow-trendEmpty' },
            t('tasks.trendEmpty')
          )
        );
      }

      /* Peak per line, not per day total: a day with 3 created + 3 done must put
         BOTH lines at the top, otherwise the two lines are not comparable. */
      const peak = Math.max(1, ...created, ...done);
      /* Shared y scale (both lines use the same peak) with a 1 px top/bottom pad;
         the unit is one day column wide, so `preserveAspectRatio="none"` only
         stretches horizontally. */
      const spine = TREND_BAR_HEIGHT - 2;
      const round = (value) => Math.round(value * 100) / 100;
      const column = (index) => round(index + 0.5);
      const level = (value) => round(TREND_BAR_HEIGHT - 1 - (value * spine) / peak);

      const segment = (series, start, end, key, tone, dashed) => {
        const points = [];
        for (let index = start; index <= end; index += 1) {
          points.push(column(index) + ',' + level(asNumber(series[index], 0)));
        }
        return React.createElement('polyline', {
          key,
          className: 'project-flow-trendLine ' + tone + (dashed ? ' project-flow-trendLine--approx' : ''),
          points: points.join(' '),
          opacity: dashed ? 0.6 : 1,
          ...(dashed ? { strokeDasharray: '2 1.5' } : null),
        });
      };

      /* Two lines: daily created vs daily done. Archived stays in the summary
         text only — a third line turns the 26 px band into noise. The line is
         split at `estimatedFrom` so the approximated tail can be dashed. */
      const lines = [];
      const dots = [];
      const cut = approx ? approxFrom : -1;
      for (const [lineTone, dotTone, series] of [
        ['project-flow-trendLineCreated', 'project-flow-trendPointCreated', created],
        ['project-flow-trendLineDone', 'project-flow-trendPointDone', done],
      ]) {
        if (cut < 0) {
          /* Fully exact window. */
          lines.push(segment(series, 0, days - 1, lineTone, lineTone, false));
        } else if (cut === 0) {
          /* The approximation covers the whole window — nothing to split. */
          lines.push(segment(series, 0, days - 1, lineTone + '-approx', lineTone, true));
        } else {
          lines.push(segment(series, 0, cut, lineTone, lineTone, false));
          lines.push(segment(series, cut, days - 1, lineTone + '-approx', lineTone, true));
          /* Mark where the estimate takes over, so the dashes read as a boundary
             rather than a rendering glitch. */
          dots.push(
            React.createElement('circle', {
              key: 'trend-cut-' + lineTone,
              className: 'project-flow-trendApproxPoint',
              cx: column(cut),
              cy: level(asNumber(series[cut], 0)),
              r: 0.9,
              opacity: 0.6,
            })
          );
        }
        for (let index = 0; index < days; index += 1) {
          const value = asNumber(series[index], 0);
          if (value <= 0) continue;
          dots.push(
            React.createElement('circle', {
              key: dotTone + '-' + index,
              className: 'project-flow-trendPoint ' + dotTone,
              cx: column(index),
              cy: level(value),
              r: 0.6,
            })
          );
        }
      }

      /* One transparent hit column per day keeps the per-day numbers reachable
         (the old stacked bars had them in `<title>`). */
      const hover = [];
      for (let index = 0; index < days; index += 1) {
        const values = [asNumber(created[index], 0), asNumber(done[index], 0), asNumber(archived[index], 0)];
        const dayApprox = approx && index >= approxFrom;
        const label = trendDayLabel(trend.from, index, String(days));
        const title =
          t('tasks.trendBar', {
            date: label,
            created: values[0],
            done: values[1],
            archived: values[2],
          }) + (dayApprox ? ' · ' + t('tasks.trendApproxTitle') : '');
        hover.push(
          React.createElement(
            'rect',
            {
              key: 'trend-hit-' + index,
              className: 'project-flow-trendDay',
              x: index,
              y: 0,
              width: 1,
              height: TREND_BAR_HEIGHT,
              fill: 'transparent',
            },
            React.createElement('title', null, title)
          )
        );
      }

      return React.createElement(
        'div',
        { className: 'project-flow-trend' },
        head,
        React.createElement(
          'svg',
          {
            className: 'project-flow-trendChart',
            viewBox: '0 0 ' + days + ' ' + TREND_BAR_HEIGHT,
            preserveAspectRatio: 'none',
            width: '100%',
            height: TREND_BAR_HEIGHT,
            role: 'img',
            'aria-label': t('tasks.trendAria', { days }),
          },
          React.createElement(
            'title',
            null,
            t('tasks.trendChartTitle', { days, created: sum(created), done: sum(done) })
          ),
          lines,
          dots,
          hover
        ),
        React.createElement(
          'div',
          { className: 'project-flow-trendAxis' },
          React.createElement('span', null, trendDayLabel(trend.from, 0, trend.from)),
          React.createElement('span', null, trendDayLabel(trend.from, days - 1, trend.to))
        )
      );
    }

    function TasksCard(props) {
      const tasks = props.tasks || {};
      const counts = asObject(tasks.counts);
      const activeTasks = asArray(tasks.active);
      const team = asObject(props.team);
      const recentTasks = asArray(tasks.recentDone);
      const t = props.t;
      const now = props.now;
      /* D-20261105-06: the UI state below survives a workspace round trip through
         the per-root cache (the panel is keyed by root, so this remounts). */
      const stateRoot = asText(props.stateRoot);

      /* One expanded row at a time, keyed by the business id so a data refresh
         keeps the same row open instead of collapsing on index shifts. */
      const [openId, setOpenId] = useState(() => uiRead(stateRoot, 'openId', null));
      const toggleTask = (id) => {
        const value = asText(id);
        if (!value) return;
        const next = openId === value ? null : value;
        uiWrite(stateRoot, 'openId', next);
        setOpenId(next);
      };

      const current = tasks.current;
      let currentId = t('tasks.currentNone');
      let currentTitle = '';
      if (typeof current === 'string' && current) {
        currentId = current;
      } else if (current && typeof current === 'object') {
        currentId = asText(current.id) || t('tasks.currentNone');
        currentTitle = asText(current.title);
      }

      /* Groups fold independently, and the fold amount is keyed by GROUP NAME —
         never by row index — so a 2.5 s poll that reorders rows keeps the state.
         Defaults keep the first screen short: the queue head (active) opens on a
         preview, the backlog and the recent completions start folded. */
      const [groupLimits, setGroupLimits] = useState(() =>
        uiRead(stateRoot, 'groupLimits', {
          todo: TASK_PREVIEW_ROWS,
          analyzing: 0,
          queuedImplementation: 0,
          implementing: 0,
          queuedReview: 0,
          done: 0,
        })
      );
      const groupLimit = (key) => {
        const table = asObject(groupLimits) || {};
        const value = asNumber(table[key], 0);
        return value > 0 ? Math.min(value, MAX_LIST_ROWS) : 0;
      };
      const toggleGroup = (key) => {
        const table = asObject(groupLimits) || {};
        const shown = asNumber(table[key], 0);
        const next = Object.assign({}, table);
        /* Preview -> full cap -> folded -> full cap: a folded or previewed group
           always opens completely first, so one click never hides rows. */
        next[key] = shown >= MAX_LIST_ROWS ? 0 : MAX_LIST_ROWS;
        /* Cache first, then the hook: the cache is what survives a root switch. */
        uiWrite(stateRoot, 'groupLimits', next);
        setGroupLimits(next);
      };

      const statusOrder = ['draft', 'active', 'done', 'archived'];
      /* Projects whose ledger is markdown/absent may only report `other`. */
      const otherCount = asNumber(counts.other, 0);
      const statusRows = otherCount > 0 ? statusOrder.concat(['other']) : statusOrder;

      /* Queue head: A2 derives `tasks.current` as the oldest active ROOT, so the
         head is a real queue head rather than "whatever the array starts with".
         A row that vanished (or a legacy payload) falls back to the first row. */
      const queueHead = (() => {
        const id = asText(currentId);
        if (id !== '') {
          const match = activeTasks.find((row) => asText(asObject(row).id) === id);
          if (match) return match;
        }
        return activeTasks.length > 0 ? activeTasks[0] : null;
      })();
      const queueHeadId = queueHead ? asText(queueHead.id) : '';
      const queueHeadTitle = queueHead ? asText(queueHead.title) : '';

      /* task-71: six stage buckets. The host pre-groups rows into `tasks.stages`
         (nine keys, each row exactly once); an older payload has no `stages`, so
         the three legacy arrays are re-bucketed. `stageOfRow`'s fallback is
         bucket-safe: done/archived map exactly, everything else lands in "todo"
         — the same bucket legacyStageFromStatus would produce for the row. */
      const stageBuckets = asObject(tasks.stages);
      const hasStageBuckets = Object.keys(stageBuckets).length > 0;
      const legacyRows = activeTasks.concat(asArray(tasks.draft), recentTasks);
      const stageOfRow = (row) => {
        const stage = asText(asObject(row).stage);
        if (stage !== '') return stage;
        const status = asText(asObject(row).status);
        if (status === 'done') return 'done';
        if (status === 'archived') return 'archived';
        return 'created';
      };
      const rowsOfStage = (stage) =>
        hasStageBuckets ? asArray(stageBuckets[stage]) : legacyRows.filter((row) => stageOfRow(row) === stage);
      const stageGroups = TASK_STAGE_GROUPS.map((def) => {
        const rows = [];
        for (const stage of def.stages) for (const row of rowsOfStage(stage)) rows.push(row);
        return { id: def.id, label: def.label, rows };
      });
      const stageGroupLabel = (id) => {
        const def = TASK_STAGE_GROUPS.find((group) => group.id === id);
        return def === undefined ? t('tasks.stageGroup.done') : t(def.label);
      };

      /* T-13 A3: fold state per PARENT task id (never per index), so a 2.5 s poll
         that reorders rows keeps every subtree open. Default shows one level. */
      const [collapsedIds, setCollapsedIds] = useState(() => uiRead(stateRoot, 'collapsedIds', {}));
      const collapsedOf = (id, depth) => {
        const table = asObject(collapsedIds);
        return Object.prototype.hasOwnProperty.call(table, id) ? table[id] === true : depth >= 1;
      };
      const toggleChildren = (id, expanded) => {
        const key = asText(id);
        if (key === '') return;
        const next = Object.assign({}, asObject(collapsedIds), { [key]: expanded });
        uiWrite(stateRoot, 'collapsedIds', next);
        setCollapsedIds(next);
      };

      /* Which group owns each task: the same-group nesting rule and the
         「父在…」badge both read this map. */
      const groupOfTask = new Map();
      for (const group of stageGroups) {
        for (const row of group.rows) {
          const id = asText(row.id);
          if (id !== '' && !groupOfTask.has(id)) groupOfTask.set(id, group.id);
        }
      }

      /** Parent-linked forest for one group; a cycle or dangling parent re-roots. */
      const buildForest = (rows, kind) => {
        /* A record without a business id still needs a unique node key. The
           index restarts per stage group, so the group kind is part of it —
           two id-less rows in different groups must not share a DOM id. */
        const nodes = rows.map((task, index) => ({ task, id: asText(task.id) || 'row-' + kind + '-' + index, children: [] }));
        const byId = new Map();
        for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
        const roots = [];
        for (const node of nodes) {
          const parentId = asText(node.task.parent);
          const parent = parentId !== '' && parentId !== node.id ? byId.get(parentId) : null;
          if (parent) parent.children.push(node);
          else roots.push(node);
        }
        /* Anything unreachable from a root (a parent cycle) is promoted back to a
           root, so a bad `parent` can never hide a row. */
        const seen = new Set();
        const walk = (node) => {
          if (seen.has(node)) return;
          seen.add(node);
          node.children.forEach(walk);
        };
        roots.forEach(walk);
        for (const node of nodes) {
          if (seen.has(node)) continue;
          for (const other of nodes) {
            const at = other.children.indexOf(node);
            if (at >= 0) other.children.splice(at, 1);
          }
          roots.push(node);
          walk(node);
        }
        return roots;
      };

      const badgeFor = (kind, task) => {
        const parentId = asText(task.parent);
        if (parentId === '') return '';
        const owner = groupOfTask.get(parentId);
        if (owner === kind) return '';
        return t('tasks.parentIn', { group: stageGroupLabel(owner) });
      };

      /** Rows of one group; business ids are the React keys, never row indexes. */
      const renderRows = (kind, rows) => {
        const limit = groupLimit(kind);
        const roots = buildForest(rows, kind);
        const countVisible = (nodes, depth) =>
          nodes.reduce(
            (sum, node) => sum + 1 + (collapsedOf(node.id, depth) ? 0 : countVisible(node.children, depth + 1)),
            0
          );
        const visibleTotal = countVisible(roots, 0);
        let rendered = 0;
        const renderNode = (node, depth) => {
          if (rendered >= limit) return null;
          rendered += 1;
          const id = node.id;
          const taskId = asText(node.task.id);
          const collapsed = collapsedOf(id, depth);
          const hasChildren = node.children.length > 0;
          const controlsId = 'project-flow-taskChildren-' + id;
          const children = [];
          if (hasChildren && !collapsed) {
            for (const child of node.children) {
              if (rendered >= limit) break;
              const element = renderNode(child, depth + 1);
              if (element) children.push(element);
            }
          }
          const childrenList = hasChildren
            ? React.createElement(
                'ul',
                {
                  key: 'children',
                  id: controlsId,
                  role: 'group',
                  className: 'project-flow-taskChildren',
                  hidden: collapsed ? true : undefined,
                },
                children
              )
            : null;
          return React.createElement(TaskRow, {
            key: id,
            rowKey: id,
            task: node.task,
            t,
            now,
            open: taskId !== '' && taskId === openId,
            onToggle: toggleTask,
            tree: {
              depth,
              hasChildren,
              expanded: hasChildren ? collapsed === false : false,
              controlsId,
              childCount: node.children.length,
              badge: badgeFor(kind, node.task),
              childrenList,
              onToggleChildren: () => toggleChildren(id, !collapsed),
            },
          });
        };
        const elements = [];
        for (const root of roots) {
          if (rendered >= limit) break;
          elements.push(renderNode(root, 0));
        }
        return {
          list: React.createElement(
            'ul',
            {
              className: 'project-flow-list project-flow-taskList',
              id: 'project-flow-group-' + kind,
              hidden: limit > 0 ? undefined : true,
            },
            elements
          ),
          /* A folded group and a preview both report what they hold back; rows in
             a collapsed subtree are the caret's business, not "还有 N 条". */
          hidden: Math.max(0, visibleTotal - rendered),
        };
      };

      /* One foldable group: a real <button> (keyboard + aria-expanded/controls),
         its visible rows, and a "N more" line whenever rows are held back — the
         active and recent groups used to truncate at 25 rows silently. */
      const renderGroup = (group) => {
        const rows = group.rows;
        const limit = groupLimit(group.key);
        const treeRows = renderRows(group.key, rows);
        return React.createElement(
          'div',
          { className: 'project-flow-group', key: group.key },
          React.createElement(FoldHeader, {
            t,
            label: t(group.label),
            count: rows.length,
            expanded: limit > 0,
            controlsId: 'project-flow-group-' + group.key,
            onToggle: () => toggleGroup(group.key),
          }),
          /* Always render the list element, even for an empty group: the toggle's
             aria-controls must point at an element that exists, and "nothing in
             progress / nothing completed yet" are common everyday states. */
          treeRows.list,
          rows.length === 0 && group.empty
            ? React.createElement(EmptyLine, null, t(group.empty))
            : null,
          treeRows.hidden > 0
            ? React.createElement(
                'p',
                { className: 'project-flow-muted project-flow-more' },
                t('tasks.more', { n: treeRows.hidden })
              )
            : null
        );
      };

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          props.showTitle === false ? null : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('tasks.title')),
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
        /* Trend band: hidden entirely for an older payload without `tasks.trend`,
           and switchable off from the display row (A5). */
        props.showTrend === false ? null : React.createElement(TrendBlock, { trend: tasks.trend, t }),
        React.createElement(
          'div',
          { className: 'project-flow-current' },
          React.createElement('span', { className: 'project-flow-muted' }, t('tasks.current') + '\uff1a'),
          React.createElement('span', { className: 'project-flow-currentId' }, currentId),
          currentTitle ? React.createElement('span', { className: 'project-flow-currentTitle', title: currentTitle }, currentTitle) : null
        ),
        React.createElement(
          'div',
          { className: 'project-flow-queueHead' },
          React.createElement('span', { className: 'project-flow-muted' }, t('tasks.queueHead') + '\uff1a'),
          queueHead ? React.createElement('span', { className: 'project-flow-queueId' }, queueHeadId) : null,
          queueHead && queueHeadTitle
            ? React.createElement('span', { className: 'project-flow-queueTitle', title: queueHeadTitle }, queueHeadTitle)
            : null,
          queueHead ? null : React.createElement('span', { className: 'project-flow-muted' }, t('tasks.queueEmpty'))
        ),
        /* task-71: one block per non-empty stage bucket, order fixed by
           TASK_STAGE_GROUPS (todo → … → done). An empty ledger shows one line,
           never six empty buckets. */
        stageGroups.map((group) =>
          group.rows.length === 0
            ? null
            : renderGroup({ key: group.id, label: group.label, rows: group.rows, empty: null })
        ),
        stageGroups.every((group) => group.rows.length === 0)
          ? React.createElement(EmptyLine, null, t('tasks.stageEmpty'))
          : null,
        /* task-77: control-word captures are folded into one muted line — they
           are recorded but never occupy the queue, so they get no rows. */
        tasks.control && tasks.control.count > 0
          ? React.createElement(
              'p',
              { className: 'project-flow-muted project-flow-controlFold', title: (tasks.control.ids || []).join(', ') || undefined },
              t('tasks.controlFold', { n: tasks.control.count })
            )
          : null,
        /* task-73: one read-only team line. `available:false` hides it — "cannot
           read the board" must not look like "0 members / 0 tasks". */
        team.available === true
          ? React.createElement(
              'p',
              { className: 'project-flow-muted project-flow-teamLine' },
              t('tasks.teamLine', {
                members: asNumber(team.members, 0),
                tasks: asNumber(team.tasks, 0),
                orphaned: asNumber(team.orphaned, 0),
              })
            )
          : null
      );
    }

    /**
     * Best-effort clipboard copy. The panel is read-only, so a missing or
     * rejecting Clipboard API degrades to a no-op instead of throwing — the
     * render selftest clicks every button without a DOM or a clipboard.
     */
    function copyTextToClipboard(text) {
      const value = asText(text);
      if (!value) return;
      try {
        const clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
        if (!clipboard || typeof clipboard.writeText !== 'function') return;
        const pending = clipboard.writeText(value);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (error) {
        /* clipboard access may be denied; the read-only panel reports nothing */
      }
    }

    /**
     * One pending decision line: the ⚠ mark when escalated, the business id,
     * the kind chip, the question, the blocked ids, the age and the copy
     * button. Rows follow the Host payload order; nothing is re-sorted here.
     */
    function DecisionRow(props) {
      const item = asObject(props.item);
      const t = props.t;
      const id = asText(item.id);
      const kind = asText(item.kind);
      const question = asText(item.question);
      const blocks = asArray(item.blocks)
        .map((block) => asText(block).trim())
        .filter(Boolean);
      const escalated = item.escalated === true;
      const age = ageText(asNumber(item.ageSeconds, null), null, props.now, t);
      /* A decision whose choice is unknowable gets no button (and no lie). */
      const command = decisionAnswerCommand(item);
      return React.createElement(
        'li',
        {
          className:
            'project-flow-decisionRow' + (escalated ? ' project-flow-decisionRow--escalated' : ''),
        },
        escalated
          ? React.createElement(
              'span',
              { className: 'project-flow-decisionMark', 'aria-hidden': 'true' },
              '\u26a0'
            )
          : null,
        React.createElement(
          'span',
          { className: 'project-flow-decisionId', title: id || undefined },
          id || t('misc.dash')
        ),
        kind ? React.createElement(Chip, null, kind) : null,
        React.createElement(
          'span',
          { className: 'project-flow-decisionQuestion', title: question || undefined },
          question || t('misc.dash')
        ),
        blocks.length > 0
          ? React.createElement(
              'span',
              { className: 'project-flow-muted project-flow-decisionBlocks', title: blocks.join(', ') },
              blocks.join(', ')
            )
          : null,
        age
          ? React.createElement('span', { className: 'project-flow-muted project-flow-decisionAge' }, age)
          : null,
        command
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'project-flow-btn project-flow-decisionCopy',
                /* The tooltip is the exact line the user will paste. */
                title: command,
                'aria-label': t('decisions.copyAria', { id: id || t('misc.dash') }),
                onClick: () => copyTextToClipboard(command),
              },
              t('decisions.copy')
            )
          : null
      );
    }

    /**
     * Pending decisions of this workspace, full width above the two columns.
     * `counts.open === 0` renders nothing at all, so an idle board keeps its
     * old height instead of reserving an empty card.
     */
    function DecisionsCard(props) {
      const decisions = asObject(props.decisions);
      const counts = asObject(decisions.counts);
      const items = asArray(decisions.items);
      const t = props.t;
      const now = props.now;
      const open = asNumber(counts.open, 0);
      const blocking = asNumber(counts.blocking, 0);
      if (open === 0) return null;
      /* The Host may report more open rows than it shipped (bounded payload). */
      const hidden = open > items.length ? open - items.length : 0;
      return React.createElement(
        'section',
        { className: 'project-flow-card project-flow-decisions' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          props.showTitle === false ? null : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('decisions.title', { n: open })),
          blocking > 0
            ? React.createElement(
                'span',
                { className: 'project-flow-chip project-flow-chip--warn' },
                t('decisions.blocking', { n: blocking })
              )
            : null
        ),
        items.length === 0
          ? React.createElement(EmptyLine, null, t('decisions.empty'))
          : React.createElement(
              'ul',
              { className: 'project-flow-list project-flow-decisionList' },
              items.map((item, index) =>
                React.createElement(DecisionRow, {
                  key: asText(item.id) || 'decision-' + index,
                  item,
                  t,
                  now,
                })
              )
            ),
        hidden > 0
          ? React.createElement(
              'p',
              { className: 'project-flow-muted project-flow-more' },
              t('decisions.more', { n: hidden })
            )
          : null
      );
    }

    /**
     * Read-only 「框架视图」 (T-20261113171442). The host projects
     * payload.framework from the viewed workspace's docs/module-domain.json:
     * a summary, a foldable module tree (module -> owns -> sections), the
     * cross-module slices, roles, unmanaged files and map warnings. A degraded
     * section has summary only, so the tree/slices are hidden and an explicit
     * 「模块图不可用」 line replaces them. An older payload without `framework`
     * keeps the legacy description-only card (summary + recent plans).
     */
    function FrameworkCard(props) {
      const t = props.t;
      const now = props.now;
      const dash = t('misc.dash');
      const countText = (value) => (Number.isFinite(value) ? String(value) : dash);
      const framework = props.framework && typeof props.framework === 'object' ? props.framework : null;
      /* Hooks are unconditional: React forbids a changing hook order, and a later
         poll may add a framework section to an already mounted card. */
      const [selection, setSelection] = useState(null);
      const [openModules, setOpenModules] = useState({});
      const description = asObject(props.description);
      const legacyCounts = asObject(description.counts);
      const legacyPlans = asArray(description.plans);

      if (framework === null) {
        /* Legacy payload: only the description ledger exists. */
        return React.createElement(
          'section',
          { className: 'project-flow-card' },
          props.showTitle === false
            ? null
            : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('framework.title')),
          React.createElement(
            'p',
            { className: 'project-flow-muted project-flow-frameworkSummary' },
            t('framework.summary', {
              files: countText(legacyCounts.files),
              modules: countText(legacyCounts.modules),
              missing: countText(legacyCounts.missingSemantics),
              plans: countText(legacyCounts.plans),
            })
          ),
          React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.plans')),
          legacyPlans.length === 0
            ? React.createElement(EmptyLine, null, t('framework.plansEmpty'))
            : React.createElement(
                'ul',
                { className: 'project-flow-list project-flow-frameworkList' },
                legacyPlans.map((plan, index) => {
                  const when = Number.isFinite(plan.atMs) ? relativeMoment(plan.atMs, now, t) : null;
                  const timeText = when || asText(plan.at);
                  return React.createElement(
                    'li',
                    { className: 'project-flow-frameworkRow', key: asText(plan.task) || 'plan-' + index },
                    React.createElement('span', { className: 'project-flow-frameworkId', title: plan.task }, plan.task),
                    React.createElement(
                      'span',
                      { className: 'project-flow-frameworkTitle', title: plan.title || undefined },
                      plan.title || dash
                    ),
                    timeText
                      ? React.createElement(
                          'span',
                          { className: 'project-flow-muted project-flow-frameworkTime' },
                          timeText
                        )
                      : null
                  );
                })
              )
        );
      }

      const MAX_UI_FILES = 8;
      const summary = asObject(framework.summary);
      const modules = asArray(framework.modules);
      const slices = asArray(framework.slices);
      const roles = asArray(framework.roles);
      const unmanaged = asArray(framework.unmanaged);
      const warnings = asArray(framework.warnings);
      const degraded = framework.degraded === true;
      const selected = asObject(selection);
      const selectedKind = asText(selected.kind);
      const selectedId = asText(selected.id);
      const moduleByName = (name) => modules.find((module) => asText(module.name) === name) || null;
      const sliceById = (id) => slices.find((slice) => asText(slice.id) === id) || null;
      const roleById = (id) => roles.find((role) => asText(role.id) === id) || null;
      const selectedModule = selectedKind === 'module' ? moduleByName(selectedId) : null;
      const selectedSlice = selectedKind === 'slice' ? sliceById(selectedId) : null;
      const activeModules = new Set(
        selectedModule
          ? [asText(selectedModule.name)]
          : selectedSlice
            ? asArray(selectedSlice.modules).map(asText)
            : []
      );
      const activeSlices = new Set(
        selectedModule
          ? asArray(selectedModule.slices).map(asText)
          : selectedSlice
            ? [asText(selectedSlice.id)]
            : []
      );
      const toggleOpen = (name) => {
        const table = asObject(openModules);
        const next = Object.assign({}, table);
        next[name] = table[name] !== true;
        setOpenModules(next);
      };
      const select = (kind, id) => setSelection({ kind, id });
      const controlsOf = (name) => 'project-flow-frameworkModuleBody-' + asText(name).replace(/[^A-Za-z0-9_-]/g, '-');
      const moreLine = (key) =>
        React.createElement('p', { className: 'project-flow-muted project-flow-frameworkMore', key }, t('framework.more'));
      const chips = (values, onPick, prefix) =>
        values.map((value, index) =>
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'project-flow-frameworkChip',
              key: prefix + index,
              title: value,
              onClick: () => onPick(value),
            },
            value
          )
        );

      const renderModule = (module) => {
        const name = asText(module.name);
        const open = asObject(openModules)[name] === true;
        const controlsId = controlsOf(name);
        const active = activeModules.has(name);
        const owns = asArray(module.owns);
        const sections = asArray(module.sections);
        const sliceIds = asArray(module.slices);
        const sectionNodes = sections.map((section) =>
          React.createElement(
            'span',
            {
              className: 'project-flow-frameworkSection',
              key: 'section-' + section.key,
              title: asArray(section.members).join(', '),
            },
            section.key,
            asArray(section.members).length === 0
              ? null
              : React.createElement('span', { className: 'project-flow-frameworkMembers' }, ' · ' + asArray(section.members).join(', ')),
            section.membersTruncated === true
              ? React.createElement('span', { className: 'project-flow-frameworkMoreMark' }, ' · ' + t('framework.more'))
              : null
          )
        );
        if (module.sectionsTruncated === true) {
          sectionNodes.push(
            React.createElement('span', { className: 'project-flow-frameworkMoreMark', key: 'sections-more' }, t('framework.more'))
          );
        }
        const body = [
          React.createElement(
            'div',
            { className: 'project-flow-frameworkField', key: 'owns' },
            React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.owns')),
            owns.length === 0
              ? React.createElement('span', { className: 'project-flow-muted' }, dash)
              : owns.map((item, index) =>
                  React.createElement(
                    'span',
                    { className: 'project-flow-frameworkPath', key: 'own-' + index, title: item.path },
                    item.path
                  )
                )
          ),
          React.createElement(
            'div',
            { className: 'project-flow-frameworkField', key: 'sections' },
            React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.sections')),
            sectionNodes.length === 0 ? React.createElement('span', { className: 'project-flow-muted' }, dash) : sectionNodes
          ),
        ];
        if (sliceIds.length > 0) {
          body.push(
            React.createElement(
              'div',
              { className: 'project-flow-frameworkField', key: 'slices' },
              React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.relatedSlices')),
              sliceIds.map((id) =>
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'project-flow-frameworkChip' + (activeSlices.has(id) ? ' project-flow-frameworkChip--active' : ''),
                    key: 'slice-chip-' + id,
                    title: id,
                    onClick: () => select('slice', id),
                  },
                  (sliceById(id) || {}).title || id
                )
              )
            )
          );
        }
        return React.createElement(
          'li',
          { className: 'project-flow-frameworkModule' + (active ? ' project-flow-frameworkModule--active' : ''), key: name },
          React.createElement(
            'div',
            { className: 'project-flow-frameworkModuleHead' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'project-flow-frameworkModuleToggle',
                'aria-expanded': open === true,
                'aria-controls': controlsId,
                'aria-label': t(open === true ? 'framework.collapse' : 'framework.expand') + ' ' + name,
                onClick: () => toggleOpen(name),
              },
              open === true ? '\u25BE' : '\u25B8'
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'project-flow-frameworkModuleSelect',
                'aria-pressed': active === true,
                onClick: () => select('module', name),
              },
              React.createElement('span', { className: 'project-flow-frameworkModuleName' }, name),
              asText(module.title)
                ? React.createElement('span', { className: 'project-flow-frameworkModuleTitle' }, module.title)
                : null
            )
          ),
          React.createElement('div', { className: 'project-flow-frameworkModuleBody', id: controlsId, hidden: open === true ? undefined : true }, body)
        );
      };

      const renderSlice = (slice) => {
        const id = asText(slice.id);
        const titleText = asText(slice.title);
        const active = activeSlices.has(id);
        const ownerRole = asText(slice.ownerRole);
        const role = ownerRole === '' ? null : roleById(ownerRole);
        const files = asArray(slice.files);
        const shown = files.slice(0, MAX_UI_FILES);
        const fileNodes = shown.map((file, index) => {
          const path = asText(file.path);
          const unowned = file.moduleName === null;
          const missing = file.exists === false;
          return React.createElement(
            'span',
            {
              className:
                'project-flow-frameworkFile' +
                (unowned ? ' project-flow-frameworkFile--unowned' : '') +
                (missing ? ' project-flow-frameworkFile--missing' : ''),
              key: 'file-' + index,
              title: path,
            },
            path,
            unowned ? ' · ' + t('framework.notOwned') : '',
            missing ? ' · ' + t('framework.missing') : ''
          );
        });
        if (slice.filesTruncated === true || files.length > shown.length) {
          fileNodes.push(React.createElement('span', { className: 'project-flow-frameworkMoreMark', key: 'files-more' }, t('framework.more')));
        }
        const sliceModules = asArray(slice.modules);
        return React.createElement(
          'li',
          { className: 'project-flow-frameworkSlice' + (active ? ' project-flow-frameworkSlice--active' : ''), key: id },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'project-flow-frameworkSliceHead',
              'aria-pressed': active === true,
              onClick: () => select('slice', id),
            },
            React.createElement('span', { className: 'project-flow-frameworkId' }, id),
            React.createElement('span', { className: 'project-flow-frameworkTitle' }, titleText || id),
            ownerRole
              ? React.createElement(
                  'span',
                  { className: 'project-flow-frameworkRole' },
                  t('framework.ownerRole') + ': ' + (role && asText(role.title) ? role.title : ownerRole)
                )
              : null
          ),
          React.createElement(
            'div',
            { className: 'project-flow-frameworkSliceMeta' },
            sliceModules.length > 0
              ? React.createElement(
                  'span',
                  { className: 'project-flow-frameworkModules' },
                  t('framework.modules') + ':',
                  sliceModules.map((name) =>
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className:
                          'project-flow-frameworkChip' +
                          (activeModules.has(name) ? ' project-flow-frameworkChip--active' : ''),
                        key: 'slice-module-' + name,
                        title: name,
                        onClick: () => select('module', name),
                      },
                      name
                    )
                  )
                )
              : null,
            fileNodes.length > 0 ? React.createElement('span', { className: 'project-flow-frameworkFiles' }, fileNodes) : null
          )
        );
      };

      const detail = (() => {
        if (selectedModule !== null) {
          const name = asText(selectedModule.name);
          const owns = asArray(selectedModule.owns);
          const sections = asArray(selectedModule.sections);
          const sliceIds = asArray(selectedModule.slices);
          return React.createElement(
            'div',
            { className: 'project-flow-frameworkDetailPanel' },
            React.createElement('h4', { className: 'project-flow-frameworkDetailTitle' }, name),
            asText(selectedModule.title) ? React.createElement('p', { className: 'project-flow-frameworkDetailText' }, selectedModule.title) : null,
            React.createElement('div', { className: 'project-flow-frameworkDetailLabel' }, t('framework.owns')),
            owns.length === 0
              ? React.createElement('p', { className: 'project-flow-muted' }, dash)
              : React.createElement(
                  'ul',
                  { className: 'project-flow-list' },
                  owns.map((item, index) =>
                    React.createElement(
                      'li',
                      { className: 'project-flow-frameworkPath', key: 'detail-own-' + index },
                      item.path
                    )
                  )
                ),
            React.createElement('div', { className: 'project-flow-frameworkDetailLabel' }, t('framework.sections')),
            sections.length === 0
              ? React.createElement('p', { className: 'project-flow-muted' }, dash)
              : React.createElement(
                  'ul',
                  { className: 'project-flow-list' },
                  sections.map((section) =>
                    React.createElement(
                      'li',
                      { className: 'project-flow-frameworkSection', key: 'detail-section-' + section.key },
                      section.key,
                      asArray(section.members).length === 0
                        ? null
                        : React.createElement('span', { className: 'project-flow-frameworkMembers' }, ' · ' + asArray(section.members).join(', ')),
                      section.membersTruncated === true
                        ? React.createElement('span', { className: 'project-flow-frameworkMoreMark' }, ' · ' + t('framework.more'))
                        : null
                    )
                  )
                ),
            selectedModule.sectionsTruncated === true ? moreLine('detail-sections-more') : null,
            sliceIds.length > 0
              ? React.createElement(
                  'div',
                  { className: 'project-flow-frameworkField' },
                  React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.relatedSlices')),
                  sliceIds.map((id) =>
                    React.createElement(
                      'button',
                      { type: 'button', className: 'project-flow-frameworkChip', key: 'detail-slice-' + id, onClick: () => select('slice', id) },
                      (sliceById(id) || {}).title || id
                    )
                  )
                )
              : null
          );
        }
        if (selectedSlice !== null) {
          const id = asText(selectedSlice.id);
          const role = roleById(asText(selectedSlice.ownerRole));
          const files = asArray(selectedSlice.files);
          const shown = files.slice(0, MAX_UI_FILES);
          const missing = asArray(selectedSlice.missingFiles);
          const shownMissing = missing.slice(0, MAX_UI_FILES);
          return React.createElement(
            'div',
            { className: 'project-flow-frameworkDetailPanel' },
            React.createElement(
              'h4',
              { className: 'project-flow-frameworkDetailTitle' },
              id + (asText(selectedSlice.title) ? ' · ' + selectedSlice.title : '')
            ),
            React.createElement('div', { className: 'project-flow-frameworkDetailLabel' }, t('framework.semantics')),
            React.createElement('p', { className: 'project-flow-frameworkDetailText' }, asText(selectedSlice.semantics) || dash),
            asText(selectedSlice.ownerRole)
              ? React.createElement(
                  'p',
                  { className: 'project-flow-muted project-flow-frameworkDetailText' },
                  t('framework.ownerRole') + ': ' + asText(selectedSlice.ownerRole) + (role && asText(role.title) ? ' · ' + role.title : '')
                )
              : null,
            asText(selectedSlice.rationale)
              ? React.createElement(
                  React.Fragment,
                  { key: 'rationale' },
                  React.createElement('div', { className: 'project-flow-frameworkDetailLabel' }, t('framework.rationale')),
                  React.createElement('p', { className: 'project-flow-frameworkDetailText' }, selectedSlice.rationale)
                )
              : null,
            asArray(selectedSlice.modules).length > 0
              ? React.createElement(
                  'div',
                  { className: 'project-flow-frameworkField' },
                  React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.modules')),
                  chips(asArray(selectedSlice.modules), (name) => select('module', name), 'detail-module-')
                )
              : null,
            React.createElement('div', { className: 'project-flow-frameworkDetailLabel' }, t('framework.files')),
            shown.length === 0
              ? React.createElement('p', { className: 'project-flow-muted' }, dash)
              : React.createElement(
                  'ul',
                  { className: 'project-flow-list' },
                  shown.map((file, index) =>
                    React.createElement(
                      'li',
                      {
                        className:
                          'project-flow-frameworkFile' +
                          (file.moduleName === null ? ' project-flow-frameworkFile--unowned' : '') +
                          (file.exists === false ? ' project-flow-frameworkFile--missing' : ''),
                        key: 'detail-file-' + index,
                      },
                      asText(file.path),
                      file.moduleName === null ? ' · ' + t('framework.notOwned') : ' · ' + asText(file.moduleName),
                      file.exists === false ? ' · ' + t('framework.missing') : ''
                    )
                  )
                ),
            selectedSlice.filesTruncated === true || files.length > shown.length
              ? moreLine('detail-files-more')
              : null,
            shownMissing.length > 0
              ? React.createElement(
                  'div',
                  { className: 'project-flow-frameworkField' },
                  React.createElement('span', { className: 'project-flow-frameworkLabel' }, t('framework.missingFiles')),
                  shownMissing.map((path, index) =>
                    React.createElement('span', { className: 'project-flow-frameworkFile project-flow-frameworkFile--missing', key: 'missing-' + index }, path)
                  )
                )
              : null,
            selectedSlice.missingFilesTruncated === true || missing.length > shownMissing.length
              ? moreLine('detail-missing-more')
              : null
          );
        }
        return React.createElement('p', { className: 'project-flow-muted project-flow-frameworkHint' }, t('framework.selectHint'));
      })();

      const rolesBlock = roles.length === 0
        ? null
        : React.createElement(
            'div',
            { className: 'project-flow-frameworkRoles' },
            React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.roles')),
            React.createElement(
              'ul',
              { className: 'project-flow-list' },
              roles.map((role) =>
                React.createElement(
                  'li',
                  { className: 'project-flow-frameworkRoleRow', key: asText(role.id) },
                  React.createElement('span', { className: 'project-flow-frameworkId' }, role.id),
                  asText(role.title) ? React.createElement('span', { className: 'project-flow-frameworkTitle' }, role.title) : null,
                  asArray(role.modules).length > 0
                    ? React.createElement('span', { className: 'project-flow-muted' }, asArray(role.modules).join(', '))
                    : null
                )
              )
            ),
            framework.rolesTruncated === true ? moreLine('roles-more') : null
          );

      const unmanagedBlock = unmanaged.length === 0
        ? null
        : React.createElement(
            'div',
            { className: 'project-flow-frameworkUnmanaged' },
            React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.unmanaged')),
            React.createElement(
              'ul',
              { className: 'project-flow-list' },
              unmanaged.map((row, index) =>
                React.createElement(
                  'li',
                  { className: 'project-flow-frameworkFile', key: 'unmanaged-' + index },
                  row.path,
                  asText(row.reason) ? React.createElement('span', { className: 'project-flow-muted' }, ' · ' + row.reason) : null
                )
              )
            ),
            framework.unmanagedTruncated === true ? moreLine('unmanaged-more') : null
          );

      const warningsBlock = warnings.length === 0
        ? null
        : React.createElement(
            'div',
            { className: 'project-flow-frameworkWarnings' },
            React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.warnings')),
            React.createElement(
              'ul',
              { className: 'project-flow-list' },
              warnings.map((line, index) =>
                React.createElement('li', { className: 'project-flow-muted project-flow-frameworkWarning', key: 'warning-' + index }, line)
              )
            )
          );

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        props.showTitle === false
          ? null
          : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('framework.title')),
        React.createElement(
          'p',
          { className: 'project-flow-muted project-flow-frameworkSummary' },
          t('framework.summaryDescription', {
            files: countText(summary.files),
            described: countText(summary.describedModules),
            missing: countText(summary.missingSemantics),
            plans: countText(summary.plans),
          })
        ),
        React.createElement(
          'p',
          { className: 'project-flow-muted project-flow-frameworkSummary' },
          t('framework.summaryGraph', {
            modules: countText(summary.graphModules),
            slices: countText(summary.graphSlices),
            roles: countText(summary.graphRoles),
            unmanaged: countText(summary.graphUnmanaged),
          })
        ),
        degraded === true
          ? React.createElement('p', { className: 'project-flow-frameworkDegraded' }, t('framework.degraded'))
          : React.createElement(
              'div',
              { className: 'project-flow-frameworkGrid' },
              React.createElement(
                'div',
                { className: 'project-flow-frameworkCol' },
                React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.modules')),
                modules.length === 0
                  ? React.createElement(EmptyLine, null, t('framework.empty'))
                  : React.createElement('ul', { className: 'project-flow-list project-flow-frameworkTree' }, modules.map(renderModule)),
                framework.modulesTruncated === true ? moreLine('modules-more') : null
              ),
              React.createElement('div', { className: 'project-flow-frameworkCol' }, detail)
            ),
        degraded === true
          ? null
          : React.createElement('h4', { className: 'project-flow-subTitle' }, t('framework.slices')),
        degraded === true
          ? null
          : slices.length === 0
            ? React.createElement(EmptyLine, null, t('framework.slicesEmpty'))
            : React.createElement('ul', { className: 'project-flow-list project-flow-frameworkSlices' }, slices.map(renderSlice)),
        degraded === true ? null : framework.slicesTruncated === true ? moreLine('slices-more') : null,
        degraded === true ? null : rolesBlock,
        degraded === true ? null : unmanagedBlock,
        warningsBlock
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

    /** Status badge text; unknown values stay visible but use the neutral chip. */
    function heartbeatStatusOf(status, t) {
      const value = asText(status);
      if (value === 'working' || value === 'idle' || value === 'waiting' || value === 'done' || value === 'missed') {
        return { cls: value, text: t('hb.status.' + value) };
      }
      return value ? { cls: 'unknown', text: value } : null;
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

    /**
     * Flip one gate definition. Same-origin JSON POST; the host answers
     * `{ ok:true, root, gate:{ id, enabled } }` or `{ ok:false, error }`.
     */
    async function postGateToggle(root, id, enabled) {
      const response = await window.fetch(GATE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ root, id, enabled }),
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
        const failure = new Error((hostError && asText(hostError.message)) || 'HTTP ' + response.status);
        failure.code = (hostError && asText(hostError.code)) || 'http-' + response.status;
        throw failure;
      }
      const gate = asObject(payload.gate);
      return {
        id: asText(gate.id) || id,
        enabled: gate.enabled === undefined ? enabled === true : gate.enabled !== false,
      };
    }

    /** Gate definitions: title, phase, last run and a per-row enable switch. */
    function GatesCard(props) {
      const gates = asArray(props.gates);
      const t = props.t;
      const now = props.now;
      const workspaceRoot = props.workspaceRoot;
      const [openGates, setOpenGates] = useState({});
      /* Optimistic values while a POST is in flight (and until the next poll). */
      const [overrides, setOverrides] = useState({});
      const [pending, setPending] = useState({});
      const [gateError, setGateError] = useState(null);

      const toggleGate = (key) => {
        setOpenGates((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      /* A fresh host snapshot always wins over an optimistic value. */
      useEffect(() => {
        setOverrides({});
      }, [props.gates]);

      const enabledOf = (gate) =>
        Object.prototype.hasOwnProperty.call(overrides, gate.id)
          ? overrides[gate.id] === true
          : gate.enabled !== false;
      const enabledCount = gates.filter(enabledOf).length;

      const toggleEnabled = (gate) => {
        const id = asText(gate.id);
        const target = !enabledOf(gate);
        if (!id || pending[id] === true || workspaceRoot === undefined) return;
        setGateError(null);
        setOverrides((previous) => Object.assign({}, previous, { [id]: target }));
        setPending((previous) => Object.assign({}, previous, { [id]: true }));
        postGateToggle(workspaceRoot, id, target)
          .then((result) => {
            setOverrides((previous) => Object.assign({}, previous, { [id]: result.enabled }));
          })
          .catch((error) => {
            /* Roll the optimistic flip back; the next poll already agrees. */
            setOverrides((previous) => {
              const next = Object.assign({}, previous);
              delete next[id];
              return next;
            });
            setGateError({ id, message: asText(error && error.message) || t('error.generic') });
          })
          .finally(() => {
            setPending((previous) => {
              const next = Object.assign({}, previous);
              delete next[id];
              return next;
            });
          });
      };

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead' },
          props.showTitle === false ? null : React.createElement('h2', { className: 'project-flow-cardTitle' }, t('gates.title')),
          React.createElement(
            'span',
            { className: 'project-flow-muted' },
            t('gates.summary', { on: enabledCount, total: gates.length })
          )
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
                const enabled = enabledOf(gate);
                const disabled = !enabled;
                const busy = gate.id !== '' && pending[gate.id] === true;
                const label = gate.title || gate.id || t('misc.dash');
                const phase = phaseOf(gate.phase, t);
                const run = gate.lastRun;
                const when = run && Number.isFinite(run.startedMs) ? relativeMoment(run.startedMs, now, t) : null;
                const duration = run ? formatDuration(asNumber(run.durationMs, null)) : '';
                const whenText = [when, duration].filter(Boolean).join(' ');
                const runText = run
                  ? t(run.ok ? 'gates.run.ok' : 'gates.run.fail', { time: whenText || t('misc.dash') })
                  : t('gates.never');
                const runTone = run ? (run.ok ? ' project-flow-gateRun--ok' : ' project-flow-gateRun--fail') : '';
                const error = gateError && gateError.id === gate.id ? gateError : null;

                return React.createElement(
                  'div',
                  {
                    className: 'project-flow-gate' + (disabled ? ' project-flow-gate--disabled' : ''),
                    key,
                  },
                  React.createElement(
                    'div',
                    { className: 'project-flow-gateRow' },
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
                      React.createElement('span', { className: 'project-flow-gateTitle' }, label),
                      disabled ? React.createElement(Chip, { tone: 'muted' }, t('gate.disabled')) : null,
                      React.createElement(Chip, { tone: phase.cls === 'other' ? null : 'phase' }, phase.text),
                      React.createElement('span', { className: 'project-flow-gateRun' + runTone }, runText)
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'project-flow-switch' + (enabled ? ' project-flow-switch--on' : ''),
                        role: 'switch',
                        'aria-checked': enabled ? true : false,
                        'aria-label': t('gate.toggleAria', { title: label }),
                        title: !gate.id
                          ? t('gate.noId')
                          : busy
                            ? t('gate.busy')
                            : enabled
                              ? t('gate.disable')
                              : t('gate.enable'),
                        disabled: !gate.id || busy || workspaceRoot === undefined,
                        onClick: () => toggleEnabled(gate),
                      },
                      React.createElement('span', {
                        className: 'project-flow-switchThumb',
                        'aria-hidden': 'true',
                      })
                    )
                  ),
                  error
                    ? React.createElement(
                        'p',
                        { className: 'project-flow-gateError', role: 'alert' },
                        t('gate.error', { message: error.message })
                      )
                    : null,
                  expanded ? React.createElement(GateDetail, { gate, t, now }) : null
                );
              })
            )
      );
    }

    /** Live signals: the agent heartbeats of this workspace. */
    function SignalsCard(props) {
      const heartbeats = asArray(props.heartbeats);
      const heartbeatCounts = asObject(props.heartbeatCounts);
      const t = props.t;
      const now = props.now;
      const sessionId = props.sessionId;

      const [closed, setClosed] = useState({});

      const toggleSection = (key) => {
        setClosed((previous) => {
          const next = Object.assign({}, previous);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      const hbActive = asNumber(
        heartbeatCounts.active,
        heartbeats.filter((beat) => beat.status === 'working' || beat.status === 'idle' || beat.status === 'waiting').length
      );
      const hbTotal = asNumber(heartbeatCounts.total, heartbeats.length);
      /* T-10: a provably dead session is not "active", but the count is shown. */
      const hbDead = asNumber(heartbeatCounts.dead, heartbeats.filter((beat) => beat.dead === true).length);
      /* T-13 A5: the payload may hold back rows (dead/stale hidden by default);
         the count keeps the total honest instead of silently shrinking it. */
      const hbHidden = asNumber(props.heartbeatsHidden, 0);

      return React.createElement(
        'section',
        { className: 'project-flow-card' },
        props.showTitle === false ? null : React.createElement('h2', { className: 'project-flow-cardTitle project-flow-cardTitle--spaced' }, t('signals.title')),
        React.createElement(
          Section,
          {
            title: t('signals.heartbeat'),
            open: !closed.heartbeat,
            onToggle: () => toggleSection('heartbeat'),
            countText: t('hb.counts', { active: hbActive, dead: hbDead, total: hbTotal }),
          },
          hbHidden > 0
            ? React.createElement('p', { className: 'project-flow-muted project-flow-hiddenCount' }, t('signals.hidden', { n: hbHidden }))
            : null,
          heartbeats.length === 0
            ? React.createElement(EmptyLine, null, t('signals.heartbeat.empty'))
            : React.createElement(
                'ul',
                { className: 'project-flow-list' },
                heartbeats.map((beat, index) => {
                  const age = Number.isFinite(beat.ageSeconds) ? beat.ageSeconds : null;
                  const stale =
                    beat.stale === true ||
                    (beat.stale !== false && Number.isFinite(age) && age > STALE_AFTER_SECONDS);
                  const timeText = ageText(
                    age,
                    Number.isFinite(beat.mtime) ? beat.mtime : beat.updatedMs,
                    now,
                    t
                  );
                  const sessionKey = beatSessionKey(beat);
                  const current = sameSession(sessionKey, sessionId);
                  const dead = beat.dead === true || beat.liveness === 'dead';
                  const key = 'beat-' + index + '-' + (beat.file || sessionKey);
                  const currentChip = current
                    ? React.createElement(Chip, { tone: 'brand' }, t('hb.current'))
                    : null;
                  /* A dead session is stronger evidence than staleness: one mark, no yellow. */
                  const staleChip = stale && !dead
                    ? React.createElement(
                        'span',
                        { className: 'project-flow-chip project-flow-chip--warn' },
                        t('signals.heartbeat.stale')
                      )
                    : null;
                  const status = dead ? null : heartbeatStatusOf(beat.status, t);
                  const displayName =
                    beat.title || beat.agent || shortSession(beat.session) || basename(beat.file) || t('misc.dash');
                  const note = beat.lastAction || beat.statusLine;
                  return React.createElement(
                    'li',
                    {
                      className: 'project-flow-beat' + (current ? ' project-flow-beat--current' : ''),
                      key,
                    },
                    React.createElement(
                      'div',
                      { className: 'project-flow-beatHead' },
                      React.createElement(
                        'span',
                        { className: 'project-flow-beatName', title: beat.session || beat.file || undefined },
                        displayName
                      ),
                      beat.agent && beat.session
                        ? React.createElement(
                            'span',
                            { className: 'project-flow-beatSession', title: beat.session },
                            shortSession(beat.session)
                          )
                        : null,
                      dead
                        ? React.createElement(Chip, { tone: 'hb-dead' }, t('hb.status.dead'))
                        : status
                          ? React.createElement(
                              Chip,
                              { tone: status.cls === 'unknown' ? null : 'hb-' + status.cls },
                              status.text
                            )
                          : null,
                      beat.task
                        ? React.createElement(
                            'span',
                            {
                              className: 'project-flow-beatTask',
                              title: joinParts([t('hb.task'), beat.task, beat.taskStageZh]),
                            },
                            beat.taskStageZh ? beat.task + ' \u00b7 ' + beat.taskStageZh : beat.task
                          )
                        : null,
                      beat.branch
                        ? React.createElement(
                            'span',
                            {
                              className: 'project-flow-beatBranch',
                              title: joinParts([
                                t('hb.branch'),
                                beat.branch,
                                beat.worktree ? beat.worktree : '',
                              ]),
                            },
                            beat.branch
                          )
                        : null,
                      currentChip,
                      timeText ? React.createElement('span', { className: 'project-flow-beatTime' }, timeText) : null,
                      staleChip
                    ),
                    beat.goal
                      ? React.createElement(
                          'p',
                          { className: 'project-flow-beatGoal', title: beat.goal },
                          React.createElement('span', { className: 'project-flow-beatGoalLabel' }, t('hb.goal')),
                          beat.goal
                        )
                      : null,
                    beat.claims.length > 0
                      ? React.createElement(
                          'div',
                          { className: 'project-flow-beatClaims' },
                          React.createElement(
                            'span',
                            { className: 'project-flow-beatClaimsLabel', title: t('hb.claimsHint') },
                            t('hb.claims')
                          ),
                          beat.claims.map((claim, claimIndex) =>
                            React.createElement(
                              'span',
                              {
                                className: 'project-flow-beatClaim',
                                key: 'claim-' + claimIndex,
                                title: joinParts([claim, t('hb.claimsHint')]),
                              },
                              claim
                            )
                          )
                        )
                      : null,
                    note
                      ? React.createElement('p', { className: 'project-flow-beatStatus', title: note }, note)
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
              {
                className: 'project-flow-subtitle',
                title: view.worktree && view.ledgerRoot ? `${view.root} → ${view.ledgerRoot}` : view.root || undefined,
              },
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
          view.worktree && view.currentHead.branch
            ? React.createElement(
                'span',
                { className: 'project-flow-pill', title: view.ledgerRoot || undefined },
                React.createElement('span', { className: 'project-flow-muted' }, t('top.currentBranch')),
                React.createElement('span', { className: 'project-flow-mono' }, view.currentHead.branch)
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
          view.degraded
            ? React.createElement(
                'span',
                {
                  className: 'project-flow-pill project-flow-degraded',
                  title: view.degradedReason || t('top.degradedHint'),
                },
                t('top.degraded')
              )
            : null,
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
     * Aspect 锁卡（T-20261112211817）：只读展示宿主富化段。
     * 段缺席（CLI 不可用）或没有锁时 normalize 已经给 null，本组件不会被挂载。
     */
    function AspectCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const now = Number.isFinite(props.now) ? props.now : Date.now();
      const aspects = asObject(props.aspects);
      if (aspects === null) return null;
      const items = asArray(aspects.items).filter((item) => asObject(item) !== null && asText(item.aspect) !== '');
      if (items.length === 0) return null;
      const counts = asObject(aspects.counts);
      const held = Math.max(0, Math.floor(asNumber(counts.held, 0)));
      const total = Math.max(0, Math.floor(asNumber(counts.total, items.length)));
      const releasable = Math.max(0, Math.floor(asNumber(counts.releasable, 0)));

      /* 租约剩余：未来时间按秒/分/时/天分桶；已过期单独一个词，不与「没有租约」混淆。 */
      const leaseTextOf = (item) => {
        if (Number.isFinite(item.leaseMs) === false) return '';
        const delta = item.leaseMs - now;
        if (delta <= 0) return t('aspect.leaseExpired');
        const seconds = Math.round(delta / 1000);
        if (seconds < 60) return t('aspect.leaseSeconds', { n: seconds });
        if (seconds < 3600) return t('aspect.leaseMinutes', { n: Math.round(seconds / 60) });
        if (seconds < 86400) return t('aspect.leaseHours', { n: Math.round(seconds / 3600) });
        return t('aspect.leaseDays', { n: Math.round(seconds / 86400) });
      };

      /* 排队：只报人数与最早等待时长（行太长会把窄栏挤爆）。 */
      const waiterTextOf = (item) => {
        const waiters = asArray(item.waiters);
        if (waiters.length === 0) return '';
        let oldest = null;
        for (const waiter of waiters) {
          const stamp = Date.parse(asText(waiter.since));
          if (Number.isFinite(stamp) === false) continue;
          oldest = oldest === null ? stamp : Math.min(oldest, stamp);
        }
        const age = oldest === null ? '' : relativeFromSeconds(Math.max(0, (now - oldest) / 1000), t);
        return t('aspect.waiters', { n: waiters.length, age: age || t('misc.dash') });
      };

      return React.createElement(
        'div',
        { className: 'project-flow-aspects' },
        React.createElement(
          'div',
          { className: 'project-flow-aspectSummary' },
          t('aspect.summary', { held, total }),
          releasable > 0 ? ' · ' + t('aspect.releasable', { n: releasable }) : ''
        ),
        items.map((item) =>
          React.createElement(
            'div',
            { className: 'project-flow-aspectRow', key: item.aspect },
            React.createElement('span', { className: 'project-flow-aspectId' }, item.aspect),
            item.ownerSession
              ? React.createElement('span', { className: 'project-flow-aspectOwner' }, item.ownerSession)
              : null,
            item.state !== 'held'
              ? React.createElement(Chip, { tone: 'warning' }, item.state)
              : null,
            leaseTextOf(item) !== ''
              ? React.createElement('span', { className: 'project-flow-aspectLease' }, leaseTextOf(item))
              : null,
            item.evidence === 'ttl-only'
              ? React.createElement('span', { className: 'project-flow-aspectTtl' }, t('aspect.ttlOnly'))
              : null,
            waiterTextOf(item) !== ''
              ? React.createElement('span', { className: 'project-flow-aspectWaiters' }, waiterTextOf(item))
              : null
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
    // #region display preferences (D-20261113: in-place fold + a top control row)
    const DISPLAY_KEY = 'project-flow.display:';
    const DISPLAY_VERSION = 1;
    const DISPLAY_DEFAULTS = {
      allCollapsed: false,
      showExperiments: true,
      showTrend: true,
      showHeartbeats: true,
    };

    /** localStorage when the host page has it; null keeps every call a no-op. */
    function displayStorage() {
      try {
        if (typeof window === 'undefined' || !window || !window.localStorage) return null;
        return window.localStorage;
      } catch (error) {
        return null;
      }
    }

    /**
     * Read the display preferences for one workspace root.
     *
     * Storage holds `{v:1, allCollapsed, showExperiments, showTrend, showHeartbeats}`
     * under `project-flow.display:<root>`. Anything missing, unparsable, of a
     * different version or of the wrong type falls back to the defaults — the
     * panel must never fail to render because a preference is corrupt.
     */
    function readDisplayPrefs(root) {
      const prefs = Object.assign({}, DISPLAY_DEFAULTS);
      try {
        const store = displayStorage();
        if (store === null) return prefs;
        const raw = store.getItem(DISPLAY_KEY + asText(root));
        if (typeof raw !== 'string' || raw === '') return prefs;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return prefs;
        if (parsed.v !== DISPLAY_VERSION) return prefs;
        for (const key of Object.keys(DISPLAY_DEFAULTS)) {
          if (typeof parsed[key] === 'boolean') prefs[key] = parsed[key];
        }
      } catch (error) {
        /* Corrupt JSON or a blocked storage: defaults, never a throw. */
      }
      return prefs;
    }

    function writeDisplayPrefs(root, prefs) {
      try {
        const store = displayStorage();
        if (store === null) return false;
        const source = asObject(prefs);
        store.setItem(
          DISPLAY_KEY + asText(root),
          JSON.stringify({
            v: DISPLAY_VERSION,
            allCollapsed: source.allCollapsed === true,
            showExperiments: source.showExperiments !== false,
            showTrend: source.showTrend !== false,
            showHeartbeats: source.showHeartbeats !== false,
          })
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /* Per-root UI state (D-20261105-06). Switching workspace unmounts the panel
       (`PanelBody` keys it by root), so without a cache every grouping/expansion
       is lost. Memory only on purpose: the display prefs already own the single
       storage key, and a cache must never become a second write. */
    const UI_STATE = new Map();
    function uiStateOf(root) {
      const key = asText(root);
      /* No root (a bare render, or a pending panel) never touches the cache: it
         would otherwise become one shared bucket across unrelated renders. */
      if (key === '') return null;
      let entry = UI_STATE.get(key);
      if (entry === undefined) {
        entry = {};
        UI_STATE.set(key, entry);
      }
      return entry;
    }
    function uiRead(root, slot, fallback) {
      const entry = uiStateOf(root);
      if (entry === null) return fallback;
      return Object.prototype.hasOwnProperty.call(entry, slot) ? entry[slot] : fallback;
    }
    function uiWrite(root, slot, value) {
      const entry = uiStateOf(root);
      if (entry === null) return;
      entry[slot] = value;
    }

    /** 「全部收起」wins over a per-card manual expand (D-20261113). */
    function cardCollapsed(prefs, manual) {
      return asObject(prefs).allCollapsed === true || manual === true;
    }

    /**
     * A card with an in-place fold (D-20261113): the caret lives in the title row
     * and the card itself is hidden while folded. Implemented as a wrapper
     * component — the panel cannot see a child component's markup, so a
     * post-processing pass over the card element would be a silent no-op.
     */
    function FoldCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const collapsed = props.collapsed === true;
      const controlsId = asText(props.controlsId);
      const label = t(collapsed ? 'display.expandCard' : 'display.collapseCard');
      const caret = React.createElement(
        'button',
        {
          type: 'button',
          className: 'project-flow-cardFold',
          'aria-expanded': collapsed ? false : true,
          'aria-controls': controlsId,
          'aria-label': label,
          title: label,
          onClick: () => {
            if (typeof props.onToggle === 'function') props.onToggle();
          },
        },
        collapsed ? '\u25B8' : '\u25BE'
      );
      return React.createElement(
        'div',
        { className: 'project-flow-cardWrap' },
        React.createElement(
          'div',
          { className: 'project-flow-cardHead project-flow-cardHead--fold' },
          caret,
          React.createElement('h2', { className: 'project-flow-cardTitle' }, t(props.titleKey))
        ),
        React.createElement(
          'div',
          { id: controlsId, className: 'project-flow-cardBody', hidden: collapsed ? true : undefined },
          collapsed ? null : props.card
        )
      );
    }

    /** Top control row: collapse all + the three section switches. */
    function DisplayBar(props) {
      const t = props.t;
      const display = asObject(props.display);
      const experimentsEnabled = props.experimentsEnabled === true;
      const allCollapsed = display.allCollapsed === true;
      const toggle = (key, label) => {
        const on = display[key] !== false;
        const disabled = key === 'showExperiments' && experimentsEnabled === false;
        return React.createElement(
          'button',
          {
            key,
            type: 'button',
            className: 'project-flow-displayToggle' + (on ? '' : ' project-flow-displayToggle--off'),
            'aria-pressed': on ? true : false,
            'aria-disabled': disabled ? true : undefined,
            disabled: disabled ? true : undefined,
            title: disabled ? t('display.experimentsOff') : undefined,
            onClick: () => {
              if (disabled) return;
              if (typeof props.onToggle === 'function') props.onToggle(key);
            },
          },
          t(label)
        );
      };
      return React.createElement(
        'div',
        { className: 'project-flow-displayRow' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'project-flow-displayAll',
            'aria-pressed': allCollapsed ? true : false,
            onClick: () => {
              if (typeof props.onAllCollapsed === 'function') props.onAllCollapsed(!allCollapsed);
            },
          },
          t(allCollapsed ? 'display.expandAll' : 'display.collapseAll')
        ),
        toggle('showExperiments', 'display.showExperiments'),
        toggle('showTrend', 'display.showTrend'),
        toggle('showHeartbeats', 'display.showHeartbeats')
      );
    }
    // #endregion

    /**
     * The data-state body of the panel: display control row, the cards and
     * the footer. Split out of `Panel` (which owns the poll) so the layout and
     * the switches can be rendered and clicked without a fetch — the selftest
     * mounts this component directly.
     */
    function PanelView(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const view = props.view;
      const now = props.now;
      const workspaceRoot = props.workspaceRoot;
      const sessionId = props.sessionId;
      const refreshing = props.refreshing === true;
      const failed = props.failed === true;
      const stateRoot = asText(view ? view.root : '');
      /* Refreshing wins over a stale failure: a retry after an error must still
         announce "refreshing…", otherwise the phase never leaves 'error' until
         the next success and the start of the retry is silent (P1-1). */
      const phase = refreshing ? 'busy' : failed ? 'error' : 'idle';

      /* Write root (D-20261108 panel): the gate POST must target the directory
         that owns the ledger. In a linked-worktree session the panel reads the
         project main worktree's ledger, so writing to the session cwd would flip
         the gate in that worktree's committed store copy instead — a silent
         branch-private edit that the next poll (reading the main ledger) undoes. */
      const ledgerWriteRoot = asText(view ? view.ledgerRoot : '') || workspaceRoot;

      /* Screen-reader announcement (D-20261105-06): the polite region only writes
         on a PHASE TRANSITION — background polls never flip `refreshing`, so the
         2.5 s loop stays silent; a manual refresh announces once when it starts
         and once when it settles. The initial value is empty (nothing to say). */
      const [announced, setAnnounced] = useState({ phase: 'idle', text: '' });
      if (announced.phase !== phase) {
        const text = phase === 'busy' ? t('live.busy') : phase === 'error' ? t('live.error') : t('live.updated');
        setAnnounced({ phase, text });
      }

      /* Display preferences (D-20261113): persisted per workspace root, read on
         every render so a root switch simply picks up that root's file. */
      const [displayTick, setDisplayTick] = useState(0);
      /* Card folds follow the root cache, not component state: a workspace switch
         remounts the panel, and a trip back restores what was open. */
      const foldedCards = asObject(uiRead(stateRoot, 'foldedCards', {}));
      const display = readDisplayPrefs(view ? view.root : '');
      const updateDisplay = (patch) => {
        writeDisplayPrefs(view ? view.root : '', Object.assign({}, display, patch));
        setDisplayTick((value) => value + 1);
      };
      const toggleCard = (key) => {
        /* D-13「总控权威」: while 「全部收起」is on the per-card carets are inert;
           only 「全部展开」leaves that mode. Clicking one must not secretly record
           a per-card state that would resurrect a closed card afterwards. */
        if (display.allCollapsed === true) return;
        const next = Object.assign({}, foldedCards);
        next[key] = foldedCards[key] === true ? false : true;
        uiWrite(stateRoot, 'foldedCards', next);
        setDisplayTick((value) => value + 1);
      };
      /* Local switch vs project switch: a hidden experiment area disables the
         toggle instead of letting the user "show" a card that must not exist. */
      const expVisible = view !== null && view.exp.enabled === true && display.showExperiments !== false;
      const heartbeatsVisible = display.showHeartbeats !== false;
      /* Every card is wrapped the same way: FoldCard owns the title row + caret,
         the card supplies the body, and 「全部收起」overrides the per-card state. */
      const foldCard = (key, titleKey, card) =>
        React.createElement(FoldCard, {
          /* Keyed by root: a workspace switch remounts the cards, so their state
             initialisers read that root's cache instead of reusing another's. */
          key: stateRoot + ':' + key,
          t,
          collapsed: cardCollapsed(display, asObject(foldedCards)[key] === true),
          onToggle: () => toggleCard(key),
          controlsId: 'project-flow-cardBody-' + key,
          titleKey,
          card,
        });

      /* The live region must NOT live inside the aria-busy subtree: while
         aria-busy is true an assistive technology may defer content changes in
         that subtree until it clears, which would delay or swallow the
         "refreshing…" announcement (it is written exactly during busy). So the
         status region stays a SIBLING of the busy container below, and only the
         data body carries aria-busy. */
      const body = React.createElement(
        'div',
        { 'aria-busy': refreshing ? true : undefined },
        React.createElement(DisplayBar, {
          t,
          display,
          experimentsEnabled: view.exp.enabled === true,
          onAllCollapsed: (next) => updateDisplay({ allCollapsed: next }),
          onToggle: (key) => updateDisplay({ [key]: display[key] === false }),
        }),
        /* Pending decisions sit above both columns, full width. */
        foldCard(
          'decisions',
          'decisions.title',
          React.createElement(DecisionsCard, { decisions: view.decisions, t, now, showTitle: false })
        ),
        /* Framework view: a read-only projection of the description ledger.
           An unbuilt/absent ledger normalizes to null, so the card is not
           mounted at all (no empty shell, no fake zeros). */
        view.description
          ? foldCard(
              'framework',
              'framework.title',
              React.createElement(FrameworkCard, { framework: view.framework, description: view.description, t, now, showTitle: false })
            )
          : view.framework
            ? foldCard(
                'framework',
                'framework.title',
                React.createElement(FrameworkCard, { framework: view.framework, description: view.description, t, now, showTitle: false })
              )
            : null,
        React.createElement(
          'div',
          /* The base class stays a literal (a selftest pins it); a closed
             experiment area only adds the single-column modifier. */
          { className: 'project-flow-grid' + (expVisible ? '' : ' project-flow-grid--single') },
          expVisible
            ? React.createElement(
                'div',
                { className: 'project-flow-col' },
                foldCard(
                  'experiments',
                  'exp.title',
                  React.createElement(ExperimentTree, { exp: view.exp, t, now, showTitle: false })
                )
              )
            : null,
          React.createElement(
            'div',
            { className: 'project-flow-col' },
            foldCard(
              'tasks',
              'tasks.title',
              React.createElement(TasksCard, { tasks: view.tasks, team: view.team, t, now, showTitle: false, stateRoot, showTrend: display.showTrend !== false })
            ),
            /* Gate definitions sit between tasks and live signals. The switch is
               a write, so it targets the ledger root, not the session cwd. */
            view.gates
              ? foldCard('gates', 'gates.title', React.createElement(GatesCard, { gates: view.gates, t, now, workspaceRoot: ledgerWriteRoot, showTitle: false }))
              : null,
            /* T-20261112211817：aspect 锁段只在宿主富化成功且真有锁时出现。 */
            view.aspects
              ? foldCard('aspects', 'aspect.title', React.createElement(AspectCard, { aspects: view.aspects, t, now }))
              : null,
            heartbeatsVisible
              ? foldCard(
                  'signals',
                  'signals.title',
                  React.createElement(SignalsCard, {
                    heartbeats: view.heartbeats,
                    heartbeatCounts: view.heartbeatCounts,
                    heartbeatsHidden: view.heartbeatsHidden,
                    showTitle: false,
                    t,
                    now,
                    sessionId,
                  })
                )
              : null
          )
        ),
        React.createElement(Footer, { view, t })
      );

      return React.createElement(
        'div',
        { className: 'project-flow-view' },
        React.createElement(
          'div',
          { className: 'project-flow-srOnly', role: 'status', 'aria-live': 'polite' },
          announced.text
        ),
        body
      );
    }

    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      /* The one workspace this panel may show; undefined until the tab resolves it. */
      const workspaceRoot = props.workspaceRoot;
      /* The tab's session id highlights its own heartbeat (never a query param). */
      const sessionId = props.sessionId;
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
      // Single flight: one request at a time, and the next one is armed POLL_MS
      // after a success or a failure settles — never on a fixed wall-clock
      // interval. A teardown (unmount, workspace switch, manual-refresh restart)
      // does not settle: it ends this chain, so nothing is re-armed and nothing
      // is written. A host slower than POLL_MS therefore keeps its request
      // instead of being cancelled by its own successor.
      useEffect(() => {
        if (workspaceRoot === undefined) return undefined;

        /* Teardown latch: once it flips this chain never writes state, never arms
           a timer and never aborts anything again. */
        let disposed = false;
        /* The one in-flight request, or null. Abort belongs to teardown only. */
        let controller = null;
        /* The pending `POLL_MS` re-arm, or null. */
        let timer = null;
        /* A visibility refresh that arrived while a request was in flight. */
        let queuedRefresh = false;

        setRefreshing(false);

        const url = STATE_ENDPOINT + '?root=' + encodeURIComponent(workspaceRoot);

        const clearTimer = () => {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
        };

        /* Arm the next poll, measured from the moment this one settled. */
        const schedule = () => {
          if (disposed) return;
          clearTimer();
          timer = window.setTimeout(() => {
            timer = null;
            void poll(false);
          }, POLL_MS);
        };

        const poll = async (manual) => {
          if (disposed) return;
          /* Single flight: a request that is merely slow keeps the slot, so this
             call neither cancels it nor arms a second one. A refresh arriving now
             is a wish, not a request: it is honored the moment that request
             settles (a settle always re-arms the chain, so no tick is lost). */
          if (controller !== null) {
            if (manual) queuedRefresh = true;
            return;
          }
          /* Nothing is in flight, so a pending tick is now redundant. */
          clearTimer();
          if (typeof document !== 'undefined' && document.hidden) {
            /* Same skip the fixed interval used to perform, but the chain stays
               alive: the visible tab flips it from `onVisibility`, and until then
               the parked tick re-arms itself without fetching. */
            schedule();
            return;
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
            if (disposed) return;
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
            if (disposed || !error || error.name === 'AbortError') return;
            /* A failure only records the reason; `data` keeps the last good
               snapshot (the stale banner is rendered from errorInfo). */
            setErrorInfo({
              code: asText(error.code) || 'network',
              message: asText(error.message),
              at: Date.now(),
            });
          } finally {
            /* Only the request that still owns the slot may clear the busy flag
               and re-arm the chain: an aborted predecessor must not wipe the busy
               state (or the schedule) of the chain that replaced it. */
            const owns = controller === current;
            if (owns) controller = null;
            if (!disposed && owns) {
              setRefreshing(false);
              /* A visibility refresh that had to wait is honored now, from the
                 settle moment, instead of being queued behind a 2500 ms tick. */
              if (queuedRefresh) {
                queuedRefresh = false;
                void poll(true);
              } else {
                schedule();
              }
            }
          }
        };

        /* First frame: fire immediately, no timer wait (unchanged behaviour). */
        void poll(reloadKey > 0);

        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          if (controller !== null) {
            /* One request at a time: remember the wish and refresh on settle
               rather than starting a second, parallel request. */
            queuedRefresh = true;
            return;
          }
          void poll(true);
        };
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility);
        }

        return () => {
          disposed = true;
          clearTimer();
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
          /* Abort is teardown-only: workspace switch, manual refresh restart or
             unmount. Nothing else cancels an in-flight state request. */
          if (controller !== null) {
            const inFlight = controller;
            controller = null;
            try {
              inFlight.abort();
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
            : React.createElement(PanelView, {
                view,
                t,
                now,
                workspaceRoot,
                sessionId,
                refreshing,
                failed,
              });

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
        sessionId: props.sessionId,
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
.project-flow-page{box-sizing:border-box;width:100%;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  /* Plugin-local text colours (D-20261105-06). The host state-* primaries are
     tuned for large marks, not 11 px chip text (light: 2.2-2.3:1 on white).
     Mixing them 52/48 with the theme's label colour darkens the hue on a light
     theme and lightens it on a dark one, so this needs neither a literal colour
     nor a theme branch — it simply follows whatever the host set. The first
     declaration is the fallback for engines without color-mix support. */
  --project-flow-ok-text:var(--dsw-alias-state-success-primary);
  --project-flow-ok-text:color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, var(--dsw-alias-label-primary));
  --project-flow-warn-text:var(--dsw-alias-state-warn-primary);
  --project-flow-warn-text:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 52%, var(--dsw-alias-label-primary));
  --project-flow-error-text:var(--dsw-alias-state-error-primary);
  --project-flow-error-text:color-mix(in srgb, var(--dsw-alias-state-error-primary) 52%, var(--dsw-alias-label-primary));}
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
/* T-20261112154725：后端 CLI 不可用时的降级标记（页头可见，不依赖警告折叠区）。
   注意：样式表是 <style> 的文本节点，会被首屏渲染断言当作页面文案采集；
   这里不要写任何页头才会出现的 UI 文案。 */
.project-flow-degraded{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}
.project-flow-liveDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;animation:project-flow-pulse 2.4s ease-in-out infinite;}
.project-flow-liveDot--stale{background:var(--dsw-alias-state-warn-primary);animation:none;}
@keyframes project-flow-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.project-flow-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .12s ease;}
.project-flow-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
.project-flow-btn:disabled{opacity:.55;cursor:default;}
.project-flow-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.project-flow-chips{display:flex;flex-wrap:wrap;gap:5px;}
.project-flow-displayRow{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0 2px;}
.project-flow-displayAll,.project-flow-displayToggle{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 8px;font-size:11px;line-height:18px;cursor:pointer;}
.project-flow-displayAll{color:var(--dsw-alias-label-primary);}
.project-flow-displayToggle--off{opacity:.55;text-decoration:line-through;}
.project-flow-displayToggle[disabled]{opacity:.4;cursor:not-allowed;text-decoration:none;}
.project-flow-cardHead--fold{align-items:center;gap:2px;justify-content:flex-start;}
.project-flow-cardFold{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border:0;padding:0;margin-right:2px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1;}
.project-flow-cardFold:hover{color:var(--dsw-alias-label-primary);}
.project-flow-ready .project-flow-cardHead .project-flow-cardTitle{display:inline-flex;align-items:center;gap:2px;}
.project-flow-cardBody{min-width:0;}
.project-flow-view{min-width:0;}
.project-flow-srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;}
.project-flow-taskRow{position:relative;}
.project-flow-taskNested{padding-left:calc(var(--d,1) * 12px);border-left:1px solid var(--dsw-alias-border-l2);margin-left:8px;}
.project-flow-taskChildren{list-style:none;margin:0;padding:0;border-left:1px solid var(--dsw-alias-border-l2);margin-left:12px;}
.project-flow-taskCaret{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;border:0;padding:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:10px;line-height:1;}
.project-flow-taskCaret:hover{color:var(--dsw-alias-label-primary);}
.project-flow-taskBadge{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.project-flow-taskDispatch{flex:none;max-width:26%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:9.5px;line-height:16px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}
.project-flow-taskDispatch--pending{border-style:dashed;}
.project-flow-taskDispatch--acked{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.project-flow-taskDispatch--closed{color:var(--dsw-alias-label-secondary);opacity:.8;}
.project-flow-taskDispatch--stale{color:var(--project-flow-warn-text);border-color:currentColor;}
.project-flow-taskDispatch--orphan{color:var(--project-flow-error-text);border-color:currentColor;text-decoration:underline dotted;}
.project-flow-taskBranch{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:9.5px;color:var(--dsw-alias-brand-primary);border:1px solid currentColor;border-radius:3px;padding:0 3px;opacity:.85;}
.project-flow-trend{margin-top:8px;min-width:0;}
.project-flow-trendHead{display:flex;align-items:baseline;gap:4px;font-size:11px;min-width:0;}
.project-flow-trendApprox{color:var(--dsw-alias-label-secondary);font-weight:600;cursor:help;}
.project-flow-trendSummary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-trendChart{display:block;width:100%;height:26px;margin-top:4px;shape-rendering:crispEdges;}
.project-flow-trendLine{fill:none;stroke-width:1.2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke;}
.project-flow-trendLineCreated{stroke:var(--dsw-alias-brand-primary);}
.project-flow-trendLineDone{stroke:var(--project-flow-ok-text);}
.project-flow-trendLine--approx{stroke-dasharray:2 1.5;opacity:.6;}
.project-flow-trendPoint{stroke:none;}
.project-flow-trendPointCreated{fill:var(--dsw-alias-brand-primary);}
.project-flow-trendPointDone{fill:var(--project-flow-ok-text);}
.project-flow-trendDay{fill:transparent;}
.project-flow-trendLegend{display:inline-flex;gap:8px;margin-left:auto;flex:none;}
.project-flow-trendLegendItem{display:inline-flex;align-items:center;gap:2px;white-space:nowrap;}
.project-flow-trendLegendCreated{color:var(--dsw-alias-brand-primary);}
.project-flow-trendLegendDone{color:var(--project-flow-ok-text);}
.project-flow-trendAxis{display:flex;justify-content:space-between;gap:6px;margin-top:2px;font-size:10px;color:var(--dsw-alias-label-secondary);}
.project-flow-trendEmpty{margin:4px 0 0;font-size:11px;}
.project-flow-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
/* T-20261112211817：aspect 锁卡。注意：样式表文本会被首屏断言采集，
   注释里不要写任何页头才会出现的 UI 文案。 */
.project-flow-aspects{display:flex;flex-direction:column;gap:6px;}
.project-flow-aspectSummary{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;}
.project-flow-aspectRow{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:18px;}
.project-flow-aspectId{font-family:${MONO};font-weight:600;color:var(--dsw-alias-label-primary);}
.project-flow-aspectOwner{font-family:${MONO};color:var(--dsw-alias-label-secondary);}
.project-flow-aspectLease,.project-flow-aspectTtl{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.project-flow-aspectWaiters{color:var(--dsw-alias-state-warn-primary);font-variant-numeric:tabular-nums;}
.project-flow-chip--ok{color:var(--project-flow-ok-text);}
.project-flow-chip--error{color:var(--project-flow-error-text);}
.project-flow-chip--warn{color:var(--project-flow-warn-text);}
.project-flow-chip--brand{color:var(--dsw-alias-brand-primary);}
.project-flow-chip--muted{color:var(--dsw-alias-label-secondary);}
.project-flow-chip--hb-working{color:var(--project-flow-ok-text);}
.project-flow-chip--hb-idle{color:var(--project-flow-warn-text);}
.project-flow-chip--hb-waiting{color:var(--dsw-alias-brand-primary);}
.project-flow-chip--hb-done{color:var(--dsw-alias-label-secondary);}
.project-flow-chip--hb-missed{color:var(--project-flow-error-text);}
.project-flow-chip--hb-dead{color:var(--dsw-alias-label-secondary);text-decoration:line-through;}
.project-flow-stale{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1);color:var(--project-flow-warn-text);font-size:11px;}
.project-flow-staleMark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-label-secondary);font-size:10px;line-height:1;flex:none;}
.project-flow-staleCode{font-family:${MONO};font-size:10.5px;color:var(--dsw-alias-label-secondary);}
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
.project-flow-group{display:flex;flex-direction:column;min-width:0;}
.project-flow-groupHead{display:flex;align-items:center;gap:6px;margin:10px 0 4px;}
.project-flow-groupToggle{display:inline-flex;align-items:center;gap:6px;padding:2px 5px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;}
.project-flow-groupToggle:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-groupToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-groupChevron{display:inline-block;width:8px;font-size:9px;line-height:1;text-align:center;}
.project-flow-groupCount{font-weight:400;letter-spacing:0;text-transform:none;opacity:.75;}
.project-flow-queueHead{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;margin-top:6px;padding:5px 7px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;min-width:0;}
.project-flow-queueId{font-family:${MONO};font-weight:600;}
.project-flow-queueTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.project-flow-list{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;}
.project-flow-taskList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;}
.project-flow-taskRow{display:flex;flex-direction:column;min-width:0;border-radius:6px;}
.project-flow-taskHead{box-sizing:border-box;display:flex;align-items:baseline;flex-wrap:nowrap;column-gap:8px;width:100%;overflow:hidden;padding:3px 4px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:1.45;text-align:left;cursor:pointer;}
.project-flow-taskHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-taskHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-taskMark{flex:none;width:1em;text-align:center;font-size:10.5px;line-height:1.6;}
.project-flow-taskTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.project-flow-teamLine{margin-top:6px;font-size:11px;}
.project-flow-taskStage{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:10px;line-height:1.6;white-space:nowrap;}
.project-flow-taskStage--closed{color:var(--dsw-alias-label-secondary);}
.project-flow-taskMeta{flex:none;max-width:35%;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-taskSignature{flex:none;margin-left:auto;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.project-flow-taskDetailSlot{min-width:0;}
.project-flow-taskDetail{margin-left:12px;}
.project-flow-gateMark{font-size:11px;line-height:1;}
.project-flow-gateMark--ok{color:var(--project-flow-ok-text);}
.project-flow-gateMark--error{color:var(--project-flow-error-text);}
.project-flow-gates{display:flex;flex-direction:column;gap:1px;}
.project-flow-gate{min-width:0;border-radius:6px;}
.project-flow-gateRow{display:flex;align-items:center;gap:4px;min-width:0;}
.project-flow-gateHead{display:flex;flex:1 1 auto;align-items:center;gap:6px;min-width:0;padding:3px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.project-flow-gateHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-gateHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-gateTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.project-flow-gateRun{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-gateRun--ok{color:var(--project-flow-ok-text);}
.project-flow-gateRun--fail{color:var(--project-flow-error-text);}
.project-flow-gate--disabled .project-flow-gateHead{opacity:.55;}
.project-flow-gate--disabled .project-flow-gateBody{opacity:.55;}
.project-flow-gateError{margin:2px 0 3px;padding-left:4px;color:var(--project-flow-error-text);font-size:10.5px;overflow-wrap:anywhere;}
.project-flow-switch{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;width:28px;height:16px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color .12s ease,border-color .12s ease;}
.project-flow-switch--on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.project-flow-switch:disabled{opacity:.55;cursor:default;}
.project-flow-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.project-flow-switchThumb{display:block;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-secondary);transform:translateX(3px);transition:transform .12s ease,background-color .12s ease;}
.project-flow-switch--on .project-flow-switchThumb{background:var(--dsw-alias-bg-base);transform:translateX(13px);}
.project-flow-guide{margin-top:5px;padding:10px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.project-flow-guideTitle{margin:0 0 3px;font-size:12.5px;}
.project-flow-guide p{margin:0;}
.project-flow-tree{display:flex;flex-direction:column;}
.project-flow-count{color:var(--dsw-alias-label-secondary);font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;}
.project-flow-caret{display:inline-block;flex:none;width:10px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;transition:transform .12s ease;}
.project-flow-caret--collapsed{transform:rotate(-90deg);}
.project-flow-treeItem{display:block;}
.project-flow-row{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:1px;width:100%;padding:3px 3px 3px 0;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.project-flow-row:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.project-flow-verdict{flex:none;width:1em;text-align:center;font-size:10.5px;line-height:1.6;}
.project-flow-verdict--confirmed{color:var(--project-flow-ok-text);}
.project-flow-verdict--refuted{color:var(--project-flow-error-text);}
.project-flow-verdict--open{color:var(--project-flow-warn-text);}
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
.project-flow-beat{display:flex;flex-direction:column;gap:1px;padding:4px 3px;border-radius:5px;min-width:0;}
.project-flow-beat:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-beatHead{display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-width:0;}
.project-flow-beatName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:500;}
.project-flow-beatTime{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;}
.project-flow-beatStatus{margin:0;padding-left:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.project-flow-beat--current{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);}
.project-flow-beatSession{flex:none;font-family:${MONO};font-size:10px;color:var(--dsw-alias-label-secondary);}
.project-flow-beatTask{flex:none;font-family:${MONO};font-size:10px;color:var(--dsw-alias-label-secondary);}
.project-flow-beatBranch{flex:none;font-family:${MONO};font-size:10px;color:var(--dsw-alias-brand-primary);border:1px solid currentColor;border-radius:3px;padding:0 3px;opacity:.85;}
.project-flow-beatGoal{margin:0;padding-left:2px;color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.45;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
.project-flow-beatGoalLabel{margin-right:4px;color:var(--dsw-alias-label-secondary);font-size:10px;}
.project-flow-beatClaims{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:1px;padding-left:2px;min-width:0;}
.project-flow-beatClaimsLabel{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;}
.project-flow-beatClaim{display:inline-flex;align-items:center;max-width:100%;height:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:${MONO};font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
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
.project-flow-decisions{margin-top:12px;}
.project-flow-decisionList{gap:2px;}
.project-flow-decisionRow{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:2px;padding:4px 3px;border-radius:5px;min-width:0;}
.project-flow-decisionRow:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-decisionRow--escalated{box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary);}
.project-flow-decisionMark{flex:none;width:1em;text-align:center;color:var(--project-flow-warn-text);font-size:11px;line-height:1.5;}
.project-flow-decisionId{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-weight:600;font-size:11px;}
.project-flow-decisionQuestion{flex:1 1 100%;min-width:0;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.45;}
.project-flow-decisionBlocks{flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:10px;}
.project-flow-decisionAge{flex:none;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:10px;}
.project-flow-decisionCopy{flex:none;height:22px;padding:0 8px;font-size:10.5px;}
.project-flow-frameworkSummary{margin:0 0 6px;}
.project-flow-frameworkGrid{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin-top:4px;}
.project-flow-frameworkCol{display:flex;flex-direction:column;min-width:0;}
.project-flow-frameworkTree,.project-flow-frameworkSlices{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;}
.project-flow-frameworkModule,.project-flow-frameworkSlice{min-width:0;border-radius:6px;}
.project-flow-frameworkModule--active,.project-flow-frameworkSlice--active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);}
.project-flow-frameworkModuleHead{display:flex;align-items:baseline;gap:2px;min-width:0;}
.project-flow-frameworkModuleToggle{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border:0;padding:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:10px;line-height:1;}
.project-flow-frameworkModuleToggle:hover{color:var(--dsw-alias-label-primary);}
.project-flow-frameworkModuleToggle:focus-visible,.project-flow-frameworkModuleSelect:focus-visible,.project-flow-frameworkSliceHead:focus-visible,.project-flow-frameworkChip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.project-flow-frameworkModuleSelect{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:6px;padding:2px 3px;border:0;border-radius:4px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.project-flow-frameworkModuleSelect:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-frameworkModuleName{flex:none;font-family:${MONO};font-weight:600;font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-frameworkModuleTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.project-flow-frameworkModuleBody{padding:2px 0 4px 18px;border-left:1px solid var(--dsw-alias-border-l2);margin-left:7px;}
.project-flow-frameworkField{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;min-width:0;margin:2px 0;}
.project-flow-frameworkLabel{flex:none;color:var(--dsw-alias-label-secondary);font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;}
.project-flow-frameworkPath{font-family:${MONO};font-size:10px;line-height:1.5;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);}
.project-flow-frameworkSection{font-family:${MONO};font-size:10px;line-height:1.6;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow-wrap:anywhere;}
.project-flow-frameworkMembers{color:var(--dsw-alias-label-secondary);font-family:inherit;}
.project-flow-frameworkMoreMark{color:var(--dsw-alias-label-secondary);font-size:9.5px;}
.project-flow-frameworkChip{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0 4px;font-size:9.5px;line-height:16px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-flow-frameworkChip--active{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.project-flow-frameworkDetailPanel{min-width:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
.project-flow-frameworkDetailTitle{margin:0 0 4px;font-size:12px;line-height:1.4;overflow-wrap:anywhere;}
.project-flow-frameworkDetailLabel{margin:6px 0 2px;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.project-flow-frameworkDetailText{margin:0 0 4px;font-size:11px;line-height:1.5;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);}
.project-flow-frameworkHint{margin:0;font-size:11px;}
.project-flow-frameworkSliceHead{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;width:100%;padding:3px 4px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.project-flow-frameworkSliceHead:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-frameworkRole{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;}
.project-flow-frameworkSliceMeta{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;padding:0 4px 3px;min-width:0;}
.project-flow-frameworkModules{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:3px;font-size:10px;color:var(--dsw-alias-label-secondary);}
.project-flow-frameworkFiles{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:3px;min-width:0;}
.project-flow-frameworkFile{font-family:${MONO};font-size:9.5px;line-height:1.6;padding:0 3px;border-radius:3px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.project-flow-frameworkFile--unowned{border-style:dashed;color:var(--project-flow-warn-text);}
.project-flow-frameworkFile--missing{color:var(--project-flow-error-text);text-decoration:line-through;}
.project-flow-frameworkDegraded{margin:4px 0;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--project-flow-warn-text);font-size:11px;line-height:1.5;}
.project-flow-frameworkRoleRow{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;padding:2px 0;font-size:11px;min-width:0;}
.project-flow-frameworkRoles,.project-flow-frameworkUnmanaged,.project-flow-frameworkWarnings{min-width:0;margin-top:4px;}
.project-flow-frameworkMore{margin:2px 0;padding-left:18px;}
.project-flow-frameworkList{gap:2px;}
.project-flow-frameworkRow{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:1px;padding:3px 3px 3px 0;border-radius:5px;min-width:0;font-size:11.5px;}
.project-flow-frameworkRow:hover{background:var(--dsw-alias-bg-layer-2);}
.project-flow-frameworkId{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-weight:600;font-size:11px;}
.project-flow-frameworkTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}
.project-flow-frameworkTime{flex:none;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:10px;}
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
.project-flow-grid--single{grid-template-columns:minmax(0,1fr);}
.project-flow-col{gap:16px;}
.project-flow-card{padding:14px 16px;border-radius:12px;}
.project-flow-cardHead{margin-bottom:10px;gap:8px;}
.project-flow-cardTitle{font-size:13px;line-height:20px;}
.project-flow-cardTitle--spaced{margin-bottom:10px;}
.project-flow-subTitle{margin:14px 0 6px;font-size:11px;}
.project-flow-frameworkGrid{grid-template-columns:minmax(0,1fr) minmax(0,0.9fr);gap:12px;margin-top:6px;margin-bottom:6px;}
.project-flow-frameworkModuleSelect{font-size:12px;}
.project-flow-frameworkModuleName{font-size:11.5px;}
.project-flow-frameworkDetailPanel{padding:8px 10px;border-radius:10px;}
.project-flow-frameworkDetailTitle{font-size:12.5px;}
.project-flow-frameworkDetailText{font-size:11.5px;}
.project-flow-frameworkSummary{font-size:11.5px;}
.project-flow-frameworkRow{column-gap:8px;padding:4px 4px 4px 0;font-size:12px;}
.project-flow-frameworkId{font-size:11.5px;}
.project-flow-frameworkTime{font-size:10.5px;}
.project-flow-current{margin-top:10px;padding:6px 8px;font-size:12px;}
.project-flow-list{gap:2px;}
.project-flow-taskList{gap:2px;}
.project-flow-taskHead{column-gap:10px;padding:4px 5px;font-size:12px;}
.project-flow-taskMark{font-size:11px;}
.project-flow-taskMeta{font-size:11px;}
.project-flow-taskStage{font-size:10.5px;}
.project-flow-taskBranch{flex:none;font-family:${MONO};font-size:9.5px;color:var(--dsw-alias-brand-primary);border:1px solid currentColor;border-radius:3px;padding:0 3px;opacity:.85;}
.project-flow-taskSignature{font-size:11px;}
.project-flow-taskDetail{margin-left:42px;}
.project-flow-guide{margin-top:6px;padding:14px;border-radius:10px;}
.project-flow-guideTitle{font-size:13px;margin-bottom:4px;}
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
.project-flow-beat{gap:2px;padding:5px 4px;border-radius:6px;}
.project-flow-beatName{font-size:12px;}
.project-flow-beatTime{font-size:10.5px;}
.project-flow-beatStatus{font-size:11px;}
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
