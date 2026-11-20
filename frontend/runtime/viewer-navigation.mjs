import { benchLeaves } from '../domain/bench-arrangement.mjs';
// viewer-navigation: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function soloChipLabel(backToOverview) {
    const chip = ports.$('btnShowAll');
    const label = chip && chip.querySelector('span');
    if (label) label.textContent = backToOverview ? '返回刚才的总览' : '正在单独查看，点击返回全部';
    if (chip) chip.title = backToOverview ? '返回刚才的总览位置' : '退出单独查看，恢复显示全部';
  }
  function clearOverviewReturn() {
    ports.S.soloFrom = null;
    ports.S.overviewReturn = null;
    soloChipLabel(false);
  }
  function rememberOverviewPlace() {
    ports.S.soloFrom = 'overview';
    ports.S.overviewReturn = ports.overview && ports.overview.capture ? ports.overview.capture() : null;
    soloChipLabel(true);
  }
  function toggleSolo(entry) {
    if (ports.S.mode === 'overview') {
      rememberOverviewPlace();
      ports.S.soloId = entry.id;
      ports.setMode('overlay');
      return;
    }
    if (ports.S.soloFrom === 'overview') clearOverviewReturn();
    ports.S.soloId = (ports.S.soloId === entry.id) ? null : entry.id;
    ports.renderList();
    ports.refreshBadge();
    ports.applyModeChange(true);
    if (ports.S.soloId) ports.toast('单独查看：' + entry.name + '（再点一次该行，或点「显示全部」恢复）');
  }
  function pageSize() { return ports.S.cols * ports.S.rows; }
  function resetGridNavigation() {
    ports.S.gridDrill = null;
    ports.S.gridParentPage = 0;
    ports.S.gridStack = [];
    ports.S.gridNodes = [];
    ports.S.gridPinned = [];
    ports.S.gridContext = '';
    ports.S.page = 0;
  }
  function listNavEntries(base) {
    if (!ports.S.listNav) return base;
    if (ports.S.listNav.group) {
      return base.filter(function (e) {
        return (ports.S.listNav.stepKey ? e.stepKey === ports.S.listNav.stepKey : !e.stepKey) &&
          (ports.S.listNav.groupKey ? ports.LINEAGE.groupKey(e) === ports.S.listNav.groupKey : e.group === ports.S.listNav.group);
      });
    }
    return base.filter(function (e) {
      return ports.S.listNav.stepKey ? e.stepKey === ports.S.listNav.stepKey : !e.stepKey;
    });
  }
  function syncGridToListNav() {
    if (ports.S.mode !== 'grid') return;
    if (ports.S.gridFromOverview) {
      // Phase 1：从总览带入的镜头锁定在原位置，不随侧栏冲掉（要换目标先回总览）。
      ports.toast('检阅台镜头停在总览当前位置；返回总览后再用侧栏切换目标');
      return;
    }
    resetGridNavigation();
    ports.rebuildGrid();
    const n = listNavEntries(ports.overviewEntries()).length;
    if (ports.S.listNav) ports.toast('检阅台 · 「' + ports.S.listNav.title + '」· ' + n + ' 个结构');
    else ports.toast('检阅台 · 全部结构 · ' + n + ' 个');
  }
  function gridLayer() {
    if (ports.S.gridPinned && ports.S.gridPinned.length) {
      // 方案 A：选中集镜头——只看总览里选中的这几条（含整步），不随筛选/侧栏变化。
      const byId = {};
      ports.S.entries.forEach(function (e) { byId[e.id] = e; });
      const pinned = ports.S.gridPinned.map(function (id) { return byId[id]; })
        .filter(Boolean).map(function (e) { return { kind: 'entry', entry: e }; });
      ports.S.gridNodes = pinned;
      return { nodes: pinned, roots: [], folder: null };
    }
    const fromOverview = !!ports.S.gridFromOverview;
    const context = JSON.stringify([ports.S.activeGroupId, ports.S.filter, ports.S.starOnly, ports.S.soloId,
      ports.S.metrics.filters,
      fromOverview ? null : (ports.S.listNav && ports.S.listNav.stepKey),
      fromOverview ? null : (ports.S.listNav && (ports.S.listNav.groupKey || ports.S.listNav.group))]);
    if (!ports.S.gridHoldPlace && ports.S.gridContext && ports.S.gridContext !== context) resetGridNavigation();
    ports.S.gridHoldPlace = false;
    ports.S.gridContext = context;
    const roots = ports.overviewNodes((fromOverview ? ports.overviewEntries() : listNavEntries(ports.overviewEntries())), { layout: false, grouped: true });
    let folder = null, nodes = roots;
    if (ports.S.gridDrill) {
      folder = ports.LINEAGE.find(roots, ports.S.gridDrill);
      if (folder && folder.kind === 'folder') {
        nodes = ports.LINEAGE.children(folder);
      } else {
        ports.S.gridDrill = null;
        ports.S.page = ports.S.gridParentPage;
        ports.S.gridParentPage = 0;
      }
    }
    // A comparison contains every structure in its scope, including nested folders.
    const leaves = benchLeaves(nodes).map(function (entry) { return { kind: 'entry', entry: entry }; });
    ports.S.gridNodes = leaves;
    return { nodes: leaves, roots: roots, folder: folder };
  }
  function openGridFolder(id) {
    const layer = gridLayer();
    const folder = ports.LINEAGE.find(layer.nodes, id);
    if (!folder) return;
    ports.S.gridStack = ports.S.gridStack || [];
    ports.S.gridStack.push({ id: ports.S.gridDrill || null, page: ports.S.page });
    ports.S.gridParentPage = ports.S.page;
    ports.S.gridDrill = folder.id;
    ports.S.page = 0;
    ports.closeMenus();
    ports.rebuildGrid();
    ports.$('btnGridBack').focus();
  }
  function backGridFolder() {
    // Phase 1：网格没有自己的层级导航，返回只有一个语义——回到总览当前位置（关镜头）。
    if (ports.S.gridFromOverview || (!ports.S.gridDrill && ports.S.overviewReturn)) {
      returnToOverviewPlace();
      return true;
    }
    return false;
  }
  function gridNodeEntry(node) {
    if (!node) return null;
    return node.kind === 'folder' ? (node.cover || null) : node.entry;
  }
  function applyGridPlace(place) {
    place = place || {};
    ports.S.gridStack = (place.drillStack || []).map(function (x) {
      return { id: x.id, page: 0 };
    });
    ports.S.gridDrill = place.drillId || null;
    ports.S.page = 0;
  }
  function stepTitleOfKey(stepKey) {
    if (!stepKey) return '全部结构';
    const hit = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === stepKey; });
    return (hit && hit.title) || stepKey;
  }
  function listNavFromOverviewNode(node) {
    if (!node) return null;
    const e = node.cover || (node.entries && node.entries[0]) || node.entry || null;
    const stepKey = node.stepKey || (e && e.stepKey) || '';
    const title = node.stepTitle || (e && e.stepTitle) || stepTitleOfKey(stepKey);
    const nav = { stepKey: stepKey, title: title || '全部结构' };
    if (node.kind === 'folder' && node.origin !== 'user' && node.origin !== 'removed') {
      const gk = node.groupKey || (e && ports.LINEAGE.groupKey(e)) || '';
      if (gk) {
        nav.group = node.name || (e && e.group) || '';
        nav.groupKey = gk;
      }
    }
    return nav;
  }
  function armGridFromOverview(place, drill) {
    place = place || {};
    ports.S.overviewReturn = place;
    ports.S.gridFromOverview = { depth: (place.drillStack || []).length };
    ports.S.gridHoldPlace = true;
    const nav = listNavFromOverviewNode(drill);
    if (nav) {
      ports.S.listNav = nav;
      ports.S.listReset = true;
      ports.S.listLimit = 60;
    }
  }
  function returnToOverviewPlace() {
    const place = ports.S.overviewReturn;
    ports.S.gridFromOverview = null;
    ports.setMode('overview', { overviewPlace: place || null });
  }
  function overviewCurrentLeafCount() {
    const ov = ports.ensureOverview();
    const drill = ov && ov.current ? ov.current() : null;
    let nodes = ports.overviewNodes(listNavEntries(ports.overviewEntries()), { layout: false, grouped: true });
    if (drill && drill.kind === 'folder') nodes = ports.LINEAGE.children(drill);
    return benchLeaves(nodes).length;
  }
  function refreshOverviewGridButton(selectedIds) {
    const btn = ports.$('btnOverviewToGrid');
    if (!btn) return;
    const sel = selectedIds || (ports.overview && ports.overview.selection ? ports.overview.selection() : []);
    const scope = benchScopeFromSelection();
    if (scope.length) {
      btn.textContent = '检阅台 · ' + scope.length + ' 条';
      btn.title = '打开检阅台：选中的步骤与结构共 ' + scope.length + ' 条，并排三维对比';
      btn.disabled = false;
    } else {
      btn.textContent = '检阅台';
      const n = overviewCurrentLeafCount();
      btn.disabled = n === 0;
      btn.title = n ? '打开检阅台：当前范围的 ' + n + ' 个结构并排比较' : '当前范围没有可比较的结构';
    }
  }
  function benchScopeFromSelection() {
    if (!ports.overview || !ports.overview.nodes || !ports.overview.selection) return [];
    const sel = new Set(ports.overview.selection());
    if (!sel.size) return [];
    const pinned = [];
    ports.overview.nodes().forEach(function (n) {
      if (n.kind === 'section') {
        if (sel.has(n.id)) ports.S.entries.forEach(function (e) { if (e.stepKey === n.stepKey) pinned.push(e); });
      } else if (n.kind === 'folder') {
        // 选中的文件夹卡 = 整夹条目（含里面所有预测）
        if (sel.has(n.id)) (n.entries || []).forEach(function (e) { pinned.push(e); });
      } else if (n.kind === 'entry' && n.entry && sel.has(n.entry.id)) {
        pinned.push(n.entry);
      }
    });
    const seen = new Set();
    return pinned.filter(function (entry) {
      const key = (entry.stepKey || 'plain') + '|' + ports.entryOrgKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function openBenchWithEntries(entries, label) {
    if (!entries || !entries.length) return;
    const ov = ports.ensureOverview();
    const place = ov && ov.capture ? ov.capture() : {};
    const drill = ov && ov.current ? ov.current() : null;
    ports.S.gridPinned = entries.map(function (e) { return e.id; });
    armGridFromOverview(place, drill);
    if (ports.S.mode === 'grid') {
      applyGridPlace(place);
      ports.rebuildGrid();
      ports.renderList();
    } else {
      ports.setMode('grid', { gridPlace: place });
      ports.toast(label || ('检阅台 · ' + entries.length + ' 条'));
    }
  }
  function openPinnedInGrid() {
    const entries = benchScopeFromSelection();
    if (!entries.length) return;
    openBenchWithEntries(entries, '检阅台 · 已选 ' + entries.length + ' 条');
  }
  function openCurrentInGrid() {
    const ov = ports.ensureOverview();
    const drill = ov && ov.current ? ov.current() : null;
    // An explicit selection takes precedence, including one selected structure.
    const scope = benchScopeFromSelection();
    if (scope.length) { openBenchWithEntries(scope, '检阅台 · ' + scope.length + ' 条'); return; }
    const nodes = drill && drill.kind === 'folder' ? ports.LINEAGE.children(drill)
      : ports.overviewNodes(listNavEntries(ports.overviewEntries()), { layout: false, grouped: true });
    const entries = benchLeaves(nodes);
    if (!entries.length) {
      ports.toast('当前范围没有可比较的结构', true);
      return;
    }
    openBenchWithEntries(entries, '检阅台 · ' + entries.length + ' 个结构');
  }
// SERVICE_FUNCTIONS_END
  return { soloChipLabel, clearOverviewReturn, rememberOverviewPlace, toggleSolo, pageSize, resetGridNavigation, listNavEntries, syncGridToListNav, gridLayer, openGridFolder, backGridFolder, gridNodeEntry, applyGridPlace, stepTitleOfKey, listNavFromOverviewNode, armGridFromOverview, returnToOverviewPlace, overviewCurrentLeafCount, refreshOverviewGridButton, benchScopeFromSelection, openBenchWithEntries, openPinnedInGrid, openCurrentInGrid };
}
