// overview-controller: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function ensureOverview(value) {
    const slot = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(slot)) return null;
    const i = slot.index;
    if (!slot.overview) {
      const root = ports.paneElement(slot, 'overviewStage');
      if (!root) return null;
      const hooks = {
        root: root, panePrefix: slot.prefix,
        onViewChange: ports.schedulePipelineViewSave,
        captureRenderConfig: function () { return ports.paneRenderConfig(slot); },
        key: function (entry, config) { return ports.thumbnailKey(entry, config || slot); },
        // 方案 A（总览为家）：封面是首页的核心体验，默认自动生成；省资源开关保留给用户手动开。
        liteDefault: function () { return false; },
        folderNote: ports.folderNoteOf,
        onFolderNote: ports.saveFolderNote,
        color: function (entry, value) {
          const config = ports.paneRenderConfig(value || slot);
          return ports.hexOf(config.theme === 'by-metric' ? ports.renderMetricColor(entry, config) : entry.color);
        },
        metric: function (entry) { return ports.metricText(entry) || (entry.parsed ? entry.parsed.residueCount + ' res' : ports.formatLabel(entry)); },
        createViewer: ports.createViewer, clearViewer: ports.clearViewer,
        loadEntryInto: function (v, entry, config, node, isCurrent) { return ports.loadEntryInto(v, entry, config || ports.paneRenderConfig(slot), isCurrent); },
        resetCamera: function (v, duration, config) { return ports.resetCamera(v, duration, config || ports.paneRenderConfig(slot)); },
        prepare: async function (v, entry, ref, value) {
          const config = ports.paneRenderConfig(value || slot);
          ports.requireRenderConfig(config);
          const c3d = v.plugin.canvas3d;
          const thumbBg = config.dark ? 0x221f1a : 0xf6f5f0;
          c3d.setProps({ renderer: { backgroundColor: thumbBg },
            multiSample: { mode: 'off' }, postprocessing: { occlusion: { name: 'off', params: {} }, outline: { name: 'off', params: {} } } });
          await ports.applyTheme(v, [{ id: entry.id, ref: ref, color: entry.color }], config);
        },
        onStar: function (target, on) {
          if (Array.isArray(target)) {
            for (const e of target) {
              e.star = !!on;
              e.starManual = true;
            }
            ports.saveMarks();
            ports.renderList();
            ports.refreshBadge();
            if (ports.overview) {
              for (const e of target) ports.overview.mark(e);
            }
            ports.status((on ? '★ 已标优选：' : '已取消优选：') + target.length + ' 个预测');
            return;
          }
          ports.toggleStar(target, on);
        },
        folderAudit: ports.auditFolderNode,
        onReference: function (entry) {
          const rel = (entry.lineage || {}).referencePath;
          if (!rel) return;
          const target = ports.S.entries.find(e => (e.fullPath || e.path || '').replace(/\\/g, '/').endsWith('/' + rel));
          if (!target) { ports.toast('请先打开母本输入步骤；参考路径：' + rel, true); return; }
          ports.rememberOverviewPlace();
          // A parent belongs to the preceding step, not the currently filtered
          // MPNN group. This temporary solo view must not change saved filters.
          ports.S.lineageReferenceId = target.id;
          ports.S.soloId = target.id; ports.renderList(); ports.setMode('overlay'); ports.refreshBadge();
        },
        folderAuditKey: ports.auditFolderKey,
        entryPose: ports.entryPose,
        onOpen: function (entry) {
          if (ports.S.mode === 'overview') ports.rememberOverviewPlace();
          ports.S.soloId = entry.id;
          ports.renderList();
          ports.setMode('overlay');
          ports.refreshBadge();
        },
        onRename: function (entry) { ports.renameEntry(entry); },
        localFile: ports.makeLocalFileNode,
        onOpenDir: ports.openLocalDir,
        onStepTitle: function (key, title) {
          ports.saveStepEdit(key, { title: title });
          ports.renderList();
          ports.schedulePipelineSync();
        },
        onStepNote: ports.saveStepNote,
        onStepNoteDraft: ports.saveStepNote,
        stepNoteState: ports.stepNoteState,
        onStepNoteFlush: function (key) { const target = ports.pipelineNoteTarget(key); if (target && !target.localOnly) ports.notesSync.flush(target.pid); },
        onStepNoteRetry: ports.retryStepNote,
        onStepAction: function (act, node, anchor) { ports.handleOverviewStepAction(act, node, anchor); },
        onStepDrop: function (stepKey, dt) { ports.importDropIntoStep(dt, stepKey); },
        onRenameFolder: function (node) { ports.renameOrgFolder(node); },
        onContext: function (info) { ports.openOrgMenu(info); },
        onMove: function (payload) { ports.handleOrgMove(payload); },
        onPlace: function (payload) { ports.handleOrgPlace(payload); },
        onResetLayout: function (node) { ports.handleOrgResetLayout(node); },
        onOpenGrid: ports.openCurrentInGrid,
        onSelect: function () { ports.refreshOverviewGridButton(); },
      };
      // Every event/data hook retains this pane. Async render hooks above use their job config.
      for (const key of Object.keys(hooks)) {
        if (key.indexOf('on') !== 0 && ['folderNote', 'metric', 'folderAudit', 'folderAuditKey', 'entryPose', 'stepNoteState'].indexOf(key) < 0) continue;
        const callback = hooks[key];
        hooks[key] = function () {
          const args = arguments;
          return ports.withPaneSync(slot, function () {
            if (key.indexOf('on') === 0 && key !== 'onSelect') ports.setActivePane(slot.index, { sync: false });
            return callback.apply(null, args);
          });
        };
      }
      const created = window.SB_OVERVIEW.create(hooks);
      slot.view.overviewStats = created.stats;
      slot.overview = created;
    }
    if (value == null || ports.scopedPane === slot) ports.overview = slot.overview;
    return slot.overview;
  }
  function overviewEntries() { return ports.visibleEntries().filter(function (entry) { return !ports.S.starOnly || entry.star; }); }
  function overviewNodes(entries, opts) {
    opts = opts || {};
    const grouped = opts.grouped === undefined ? ports.S.overviewGrouped : opts.grouped;
    const raw = ports.LINEAGE.nodes(entries, grouped);
    if (!ports.ORG) return raw;
    // 允许显式传 stepKey：空步骤（无成员）也可能持有用户文件夹/回收站，必须照样渲染。
    const stepKey = opts.stepKey || (entries[0] && entries[0].stepKey) || 'plain';
    if (entries.some(function (e) { return (e.stepKey || 'plain') !== stepKey; })) return raw;
    const orgSource = ports.S.organization[stepKey];
    if (!entries.length && (!orgSource || ports.ORG.isEmpty(orgSource))) return raw;
    const org = ports.ORG.rebind(orgSource || ports.ORG.empty(), entries);
    if (!ports.ORG.isEmpty(org)) ports.S.organization[stepKey] = org;
    else if (ports.S.organization[stepKey] && ports.ORG.isEmpty(ports.S.organization[stepKey])) delete ports.S.organization[stepKey];
    const out = ports.ORG.apply(raw, entries, org, {
      lineage: ports.LINEAGE,
      stepKey: stepKey,
      stepTitle: entries[0] ? (entries[0].stepTitle || '') : '',
      grouped: grouped,
    });
    // 手动格子位置只用于总览：检阅台/侧栏传 layout:false，保持各自的自然排列。
    return opts.layout === false ? out : ports.ORG.applyDisplayLayout(out, org, 'root');
  }
  function withPipelineSections(entries) {
    const removed = ports.trashEntries();
    const alive = entries.filter(function (e) { return !ports.entryIsTrashed(e); });
    const steps = ports.orderedStepBuckets(alive, { includeEmpty: !ports.S.filter && !ports.S.starOnly && ports.S.activeGroupId === 'all' });
    const plain = alive.filter(function (e) { return !e.stepKey; });
    if (!steps.length) return overviewNodes(alive);
    const nodes = [];
    const edits = ports.loadStepEdits();
    function nestLooseFiles(cards, key) {
      const loose = [];
      const kept = [];
      for (const card of cards) {
        if (card.kind === 'entry' && card.entry) loose.push(card.entry);
        else kept.push(card);
      }
      if (loose.length <= 8) return cards;
      const dir = ports.makeLocalFileNode(loose, key);
      kept.push({
        kind: 'folder', id: 'pile:' + key, name: dir.name || '结构',
        entries: loose, cover: loose[0], count: loose.length,
      });
      return kept;
    }
    function pushStep(list, index, title, tool, key, isPlain) {
      const semantic = list.some(e => e.lineage && e.lineage.artifactKind);
      const cards = ports.capOverviewCards(semantic ? overviewNodes(list, { stepKey: key }) : nestLooseFiles(overviewNodes(list, { stepKey: key }), key), list, key);
      const pileCard = cards.find(function (c) {
        return c.kind === 'folder' && String(c.id || '').indexOf('pile:') === 0;
      });
      if (pileCard && pileCard.children && ports.ORG) {
        // 聚合夹钻入后的子层也支持手动格子位置（排序返回新数组，须写回）
        pileCard.children = ports.ORG.applyDisplayLayout(pileCard.children, ports.S.organization[key], pileCard.id);
      }
      const count = list.length;
      nodes.push({
        kind: 'section', id: 'section:' + key, stepKey: key, index: index, plain: !!isPlain,
        title: title, tool: tool || '', count: count, cardCount: cards.length,
        countText: ports.LINEAGE.countText(ports.LINEAGE.summarize(list)),
        operation: ports.LINEAGE.operationText((list[0] || {}).stepOperation),
        desc: (list[0] || {}).stepDesc || '',
        note: (edits[key] || {}).note || '',
      });
      nodes.push.apply(nodes, cards);
    }
    steps.forEach(function (step) { pushStep(step.entries, step.displayIndex, step.title, step.tool, step.key, false); });
    // 「其他导入」即使没有成员，也可能持有用户文件夹/回收站，不能整段消失。
    const plainOrgAlive = ports.ORG && ports.S.organization.plain && !ports.ORG.isEmpty(ports.S.organization.plain);
    if (plain.length || plainOrgAlive) pushStep(plain, null, '其他导入', '', 'plain', true);
    return nodes;
  }
  function setOverviewGrouped(on, persist) {
    ports.S.overviewGrouped = !!on;
    for (const id of ['btnOverviewGrouped']) {
      const b = ports.$(id);
      if (!b) continue;
      b.classList.toggle('active', !!ports.S.overviewGrouped);
      b.setAttribute('aria-pressed', String(!!ports.S.overviewGrouped));
    }
    if (persist) try { localStorage.setItem(ports.GROUPED_KEY, ports.S.overviewGrouped ? '1' : '0'); } catch (_) {}
  }
  function renderOverviewWindow(value) {
    const targets = typeof value === 'number' || (value && (value.view || value.pane))
      ? [ports.paneAt(value)] : ports.panes.filter(ports.PANE_RUNTIME.alive);
    for (const pane of targets) {
      if (!ports.PANE_RUNTIME.alive(pane)) continue;
      ports.updateGridGeometry(pane);
      if (pane.overview) pane.overview.renderWindow();
    }
  }
  function rebuildOverview(value) {
    const targets = typeof value === 'number' || (value && (value.view || value.pane))
      ? [ports.paneAt(value)] : ports.panes.filter(ports.PANE_RUNTIME.alive);
    for (const pane of targets) {
      if (!ports.PANE_RUNTIME.alive(pane) || pane.view.mode !== 'overview') continue;
      rebuildOnePane(pane);
      // host.refresh() already renders; retain the geometry and search-state updates.
      ports.updateGridGeometry(pane);
      refreshOverviewSearchState(pane.index);
    }
  }
  function rebuildOnePane(value) {
    const pane = ports.paneAt(value), i = pane && pane.index;
    return ports.withPaneSync(pane, function () {
      const stage = ports.paneStage(i);
      const ovStage = ports.paneOverviewStage(i);
      if (!stage || !ovStage) return;
      const host = ensureOverview(pane);
      if (!host) return;
      const group = ports.S.activeGroupId + '|' + ports.S.filter + '|' + ports.S.starOnly + '|' + (ports.S.overviewGrouped ? 'g' : 'f');
      const changed = ovStage.dataset.group !== group;
      ovStage.dataset.group = group;
      const nodes = withPipelineSections(overviewEntries());
      let folders = 0, covered = 0, sections = 0;
      for (const n of nodes) {
        if (n.kind === 'section') sections++;
        else if (n.kind === 'folder') { folders++; covered += n.count; }
        else if (n.kind === 'localfile') covered += n.remain;
        else covered++;
      }
      const titlePrefix = ports.rawS.activePipelineName || '结构总览';
      const title = sections
        ? titlePrefix + ' · ' + sections + ' 个步骤 / ' + covered + ' 份结构记录'
        : (ports.S.overviewGrouped && folders
          ? titlePrefix + ' · ' + ports.LINEAGE.countText(ports.LINEAGE.summarize(overviewEntries()))
          : titlePrefix + ' · ' + covered + ' 个');
      host.refresh(nodes, changed, title);
      // 每栏自己的标题按栏写。面包屑不再写动态 id（泄漏源），用 .is-current 定位；
      // 若该栏还没渲染面包屑，跳过——refresh() 内部的 setDrillUI 会用 baseTitle 兜底。
      const titleEl = stage.querySelector('.overview-path .is-current, .overview-title-row [id$="-overviewTitle"]');
      if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
      if (i === ports.activePane) ports.status(title + ' · 缩略图按可见区域生成');
    });
  }
  function applyOverviewSearch(text, value) {
    const pane = ports.paneAt(value);
    return ports.withPaneSync(pane, function () {
      const host = ensureOverview(pane);
      if (!host) return false;
      const applied = host.setSearch(text);
      if (applied) ports.schedulePipelineViewSave();
      refreshOverviewSearchState(pane.index);
      if (applied && ports.panes[ports.activePane] === pane) {
        const s = host.searchStats();
        ports.status(s.query ? '搜索「' + s.query.trim() + '」· 本层 ' + s.visible + ' / ' + s.total + ' 个' : '已清除搜索');
      }
      return applied;
    });
  }
  function refreshOverviewSearchState(index) {
    const i = typeof index === 'number' ? index : ports.activePane;
    const stage = ports.paneStage(i);
    const api = ports.panes[i] && ports.panes[i].overview;
    // 按栏取输入框，避免分屏时把左栏的状态写到右栏。
    const input = stage && stage.querySelector('#overviewSearch, [id$="-overviewSearch"]');
    const clear = stage && stage.querySelector('#btnOverviewSearchClear, [id$="-btnOverviewSearchClear"]');
    if (!input) return;
    const stats = api ? api.searchStats() : { query: '', visible: 0, total: 0 };
    if (document.activeElement !== input && input.value !== stats.query) input.value = stats.query;
    if (clear) clear.hidden = !stats.query;
    const active = !!stats.query.trim();
    input.classList.toggle('has-filter', active);
    input.title = active
      ? '本层显示 ' + stats.visible + ' / ' + stats.total + ' 个（按 Esc 清除）'
      : '在当前这一层里按名称、路径或指标查找';
  }
// SERVICE_FUNCTIONS_END
  return { ensureOverview, overviewEntries, overviewNodes, withPipelineSections, setOverviewGrouped, renderOverviewWindow, rebuildOverview, rebuildOnePane, applyOverviewSearch, refreshOverviewSearchState };
}
