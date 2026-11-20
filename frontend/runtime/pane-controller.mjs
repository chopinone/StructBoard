import { createSplitMotion } from '../views/split-motion.mjs';
// pane-controller: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
  const splitMotion = createSplitMotion({ settled() { ports.resizeGridViewers(); ports.renderOverviewWindow(); } });
// SERVICE_FUNCTIONS_BEGIN
  function paneStage(index) {
    // 返回整个栏（.stage），第 0 栏是页面原有的 #stage，第 1 栏是克隆出来的 #p2-stage。
    return index === 0 ? document.getElementById('stage') : document.getElementById('p2-stage');
  }
  function paneOverviewStage(index) {
    const stage = paneStage(index);
    if (!stage) return null;
    return index === 0
      ? document.getElementById('overviewStage')
      : stage.querySelector('[id$="-overviewStage"]');
  }
  function setActivePane(index, options) {
    const pane = ports.paneAt(index);
    if (!ports.PANE_RUNTIME.alive(pane) || ports.panes[pane.index] !== pane) return;
    options = options || {};
    const previous = ports.panes[ports.activePane];
    if (previous !== pane) {
      const stage = previous && (previous.el || paneStage(previous.index));
      const scroll = stage && stage.querySelector('.overview-scroll');
      if (scroll) previous.scrollTop = scroll.scrollTop;
      ports.activePane = pane.index;
    }
    syncPaneFocus(options.sync !== false);
  }
  function syncPaneFocus(refresh) {
    for (const pane of ports.panes) {
      const stage = pane.el || paneStage(pane.index);
      if (!stage) continue;
      pane.el = stage;
      stage.classList.toggle('is-focus', ports.splitState.active && pane.index === ports.activePane);
      const header = stage.querySelector('.overview-head');
      if (header) header.classList.toggle('is-focus', pane.index === ports.activePane);
    }
    const pane = ports.panes[ports.activePane];
    if (!ports.PANE_RUNTIME.alive(pane)) return;
    ports.overview = pane.overview || null;
    if (typeof syncPaneControls === 'function') syncPaneControls(pane);
    if (refresh) {
      ports.withPaneSync(pane, function () { ports.renderList(); ports.refreshReferenceSelect(); refreshBadge(); });
    }
    ports.scheduleSessionSave();
  }
  function applyAllPaneModes(rebuild) {
    return Promise.all(ports.panes.filter(ports.PANE_RUNTIME.alive).map(function (pane) {
      return applyModeChange(!!rebuild, pane);
    }));
  }
  function ensurePaneModeRow(index) {
    const pane = ports.paneAt(index);
    const stage = pane && (pane.el || paneStage(ports.panes.indexOf(pane)));
    if (!stage) return;
    const head = stage.querySelector('.overview-head');
    if (!head) return;
    let seg = stage.querySelector('.pane-mode');
    stage.querySelectorAll('.pane-mode').forEach(function (node) { if (node !== seg) node.remove(); });
    if (!seg) {
      seg = document.createElement('div');
      seg.className = 'pane-mode';
      seg.setAttribute('role', 'tablist');
      seg.setAttribute('aria-label', '本栏视图模式');
      const thumb = document.createElement('span');thumb.className = 'pane-mode-thumb';
      thumb.setAttribute('aria-hidden', 'true');seg.appendChild(thumb);
      for (const mode of ['overview', 'grid']) {
        const label = mode === 'overview' ? '总览' : '检阅台';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mode-btn pane-mode-btn';
        button.dataset.mode = mode;
        button.dataset.action = 'pane-mode';
        button.title = label;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-label', label);
        const icon = document.getElementById(mode === 'overview' ? 'btnOverview' : 'btnBench').querySelector('svg');
        if (icon) button.appendChild(icon.cloneNode(true));
        const text = document.createElement('span');text.className = 'pane-mode-label';text.textContent = label;
        button.appendChild(text);
        seg.appendChild(button);
      }
      head.insertBefore(seg, head.firstChild);
    }
    let actions = head.querySelector('.pane-actions-btn');
    if (!actions) {
      actions = document.createElement('button');
      actions.type = 'button';
      actions.className = 'mini-btn icon-only pane-actions-btn';
      actions.dataset.action = 'pane-actions';
      actions.title = '本栏操作';
      actions.setAttribute('aria-label', '本栏操作');
      actions.setAttribute('aria-haspopup', 'menu');
      actions.setAttribute('aria-expanded', 'false');
      actions.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.2" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.8" cy="10" r="1.4"/></svg>';
      const titleRow = head.querySelector('.overview-title-row');
      (titleRow || head).appendChild(actions);
    }
    stage.classList.add('pane-compact');
    bindPaneControls(pane);
    syncPaneControls(pane);
  }
  function paneControlElement(paneOrIndex, id) {
    const pane = ports.paneAt(paneOrIndex), index = ports.panes.indexOf(pane);
    const stage = pane && (pane.el || paneStage(index));
    if (!stage || index < 0 || pane.disposed) return null;
    const prefix = ports.splitState.prefixes[index] || '';
    return stage.querySelector('[id="' + prefix + id + '"]') || stage.querySelector('[data-action="' + id + '"]');
  }
  function closePaneControlMenus(paneOrIndex, except) {
    const pane = ports.paneAt(paneOrIndex);
    if (!pane) return;
    for (const id of ports.PANE_CONTROL_MENUS) {
      const menu = paneControlElement(pane, id);
      if (menu && id !== except) menu.hidden = true;
    }
    for (const id of Object.keys(ports.PANE_MENU_BUTTONS)) {
      const button = paneControlElement(pane, id), menu = paneControlElement(pane, ports.PANE_MENU_BUTTONS[id]);
      if (button) button.setAttribute('aria-expanded', String(!!menu && !menu.hidden));
    }
  }
  function togglePaneControlMenu(pane, id, anchor) {
    const menu = paneControlElement(pane, id);
    if (!menu) return;
    const show = menu.hidden;
    ports.closeMenus();
    for (const other of ports.panes) closePaneControlMenus(other);
    menu.hidden = !show;
    closePaneControlMenus(pane, id);
    if (anchor) anchor.setAttribute('aria-expanded', String(show));
  }
  function syncPaneControls(paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex);
    const stage = pane && (pane.el || paneStage(ports.panes.indexOf(pane)));
    if (!stage || pane.disposed) return;
    const view = pane.view, bench = view.mode === 'grid' || view.mode === 'overlay';
    const seg = stage.querySelector('.pane-mode');
    const home = bench ? (stage.querySelector('.toolbar .pane-mode-slot') || stage.querySelector('.toolbar .bench-context') || stage.querySelector('.toolbar')) : stage.querySelector('.overview-head');
    if (seg && home) {
      if (seg.parentElement !== home) {
        if (bench) home.appendChild(seg); else home.insertBefore(seg, home.firstChild);
      }
      seg.classList.toggle('pane-mode-toolbar', bench);
      seg.dataset.mode = bench ? 'grid' : 'overview';
      seg.querySelectorAll('.pane-mode-btn').forEach(function (button) {
        const on = button.dataset.mode === (bench ? 'grid' : 'overview');
        button.classList.toggle('active', on);
        button.setAttribute('aria-selected', String(on));
        button.setAttribute('aria-pressed', String(on));
      });
    }
    for (const pair of [['selTheme', 'theme'], ['selRepr', 'repr'], ['selCols', 'cols'], ['selRows', 'rows'], ['selMaxOverlay', 'maxOverlay']]) {
      const input = paneControlElement(pane, pair[0]);
      if (input && view[pair[1]] !== undefined) input.value = String(view[pair[1]]);
    }
    const states = { btnOverviewGrouped: !!view.overviewGrouped, btnGridByCandidate: view.gridArrangement !== 'flat', btnGridFlat: view.gridArrangement === 'flat', btnFollowRef: !!view.syncCamera, benchSide: view.mode === 'grid', benchOverlay: view.mode === 'overlay' };
    for (const action of Object.keys(states)) {
      const prefix = ports.splitState.prefixes[ports.panes.indexOf(pane)] || '';
      stage.querySelectorAll('[id="' + prefix + action + '"], [data-action="' + action + '"]').forEach(function (button) {
        button.classList.toggle('active', states[action]);
        button.setAttribute('aria-pressed', String(states[action]));
        if (action === 'benchSide' || action === 'benchOverlay') button.setAttribute('aria-selected', String(states[action]));
      });
    }
    const showArrangement = view.mode === 'grid' && view.gridGroupCount > 1;
    stage.querySelectorAll('.bench-arrangement, [data-arrangement-option]').forEach(function (node) { node.hidden = !showArrangement; });
    stage.querySelectorAll('[data-arrangement-label]').forEach(function (node) { node.textContent = view.gridArrangementLabel || '按候选排列'; });
    const layout = paneControlElement(pane, 'btnGridLayout');
    const layoutLabel = layout && layout.querySelector('.grid-layout-label');
    if (layoutLabel) layoutLabel.textContent = view.cols + ' × ' + view.rows;
    const split = paneControlElement(pane, 'btnSplitToggle');
    if (split) split.setAttribute('aria-pressed', String(ports.splitState.active));
  }
  function togglePaneGrouping() {
    ports.setOverviewGrouped(!ports.S.overviewGrouped, true);
    ports.resetGridNavigation();
    if (ports.S.mode === 'overview') ports.rebuildOverview(); else if (ports.S.mode === 'grid') ports.rebuildGrid();
    const stage = ports.$('overviewStage');
    if (stage) stage.dataset.group = '';
  }
  function clampGridCount(value, max, fallback) {
    const n = parseInt(value, 10);
    return !n || n < 1 ? fallback : Math.min(max, n);
  }
  function gpuInfo() {
    if (ports.gridGpuCache) return ports.gridGpuCache;
    ports.gridGpuCache = { renderer: '', weak: true, strong: false };
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return ports.gridGpuCache;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      const weak = !renderer || /swiftshader|llvmpipe|microsoft basic|intel\(r\) hd|intel\(r\) uhd|uhd graphics|hd graphics/.test(renderer.toLowerCase());
      ports.gridGpuCache = { renderer: renderer, weak: weak, strong: /nvidia|geforce|rtx|gtx|quadro|radeon|rx \d|arc\(tm\)|apple m/.test(renderer.toLowerCase()) && !weak };
    } catch (_) { /* 探测失败按较弱机器推荐 */ }
    return ports.gridGpuCache;
  }
  function recommendGrid(paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex), stage = pane && (pane.el || paneStage(ports.panes.indexOf(pane)));
    const rect = stage && stage.getBoundingClientRect();
    const width = rect && rect.width ? rect.width : Math.max(1, window.innerWidth - 280);
    const height = rect && rect.height ? rect.height : window.innerHeight;
    const cores = navigator.hardwareConcurrency || 4, mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 0, gpu = gpuInfo();
    const fitCols = Math.max(1, Math.min(ports.GRID_COL_MAX, Math.floor(width / 230)));
    const fitRows = Math.max(1, Math.min(ports.GRID_ROW_MAX, Math.floor((height - 170) / 210)));
    let budget = 10;
    if (mem && mem <= 4) budget = 4;
    else if (gpu.weak) budget = 6;
    else if (gpu.strong && cores >= 8 && (!mem || mem >= 8)) budget = 16;
    else if (cores >= 8) budget = 12;
    let cols = fitCols, rows = Math.min(2, fitRows);
    if (gpu.strong && fitRows >= 3 && height >= 1000 && budget >= 15) rows = 3;
    while (cols * rows > budget && cols > 1) cols--;
    while (cols * rows > budget && rows > 1) rows--;
    const bits = [cores + ' 线程'];
    if (mem) bits.push(mem >= 8 ? '内存不少于 8 GB' : ('内存约 ' + mem + ' GB'));
    if (gpu.renderer) bits.push(gpu.renderer.replace(/\s+/g, ' ').slice(0, 64));
    bits.push('本栏大约放得下 ' + fitCols + '×' + fitRows);
    bits.push('同时开太多三维视窗会卡，建议 ' + cols + '×' + rows);
    return { cols: cols, rows: rows, title: bits.join(' · ') };
  }
  function paintGridRecommendation(paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex);
    if (!pane) return;
    const rec = recommendGrid(pane);
    pane.view.gridRecommend = rec;
    const button = paneControlElement(pane, 'btnGridRec');
    if (!button) return;
    const same = pane.view.cols === rec.cols && pane.view.rows === rec.rows;
    button.textContent = (same ? '推荐 ' : '改用 ') + rec.cols + '×' + rec.rows;
    button.classList.toggle('is-current', same);
    button.title = rec.title;
  }
  function applyGridShape(cols, rows, persist, paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex);
    if (!pane) return;
    ports.withPaneSync(pane, function () {
      const nextCols = clampGridCount(cols, ports.GRID_COL_MAX, 2), nextRows = clampGridCount(rows, ports.GRID_ROW_MAX, 2);
      const changed = nextCols !== ports.S.cols || nextRows !== ports.S.rows;
      ports.S.cols = nextCols; ports.S.rows = nextRows;
      if (persist) try { localStorage.setItem(ports.GRID_SHAPE_KEY, ports.S.cols + 'x' + ports.S.rows); } catch (_) {}
      paintGridRecommendation(pane); syncPaneControls(pane);
      if (changed && ports.S.cols * ports.S.rows > 12) ports.toast('这一页会同时渲染 ' + (ports.S.cols * ports.S.rows) + ' 路三维视窗，显存可能吃紧；一般建议 ≤12，卡的话点旁边的推荐。');
      if (ports.S.mode === 'grid') { ports.S.page = 0; ports.rebuildGrid(pane); }
    });
  }
  function showAllPaneEntries() {
    if (ports.S.soloFrom === 'overview') {
      const place = ports.S.overviewReturn;
      ports.S.soloFrom = null; ports.S.overviewReturn = null; ports.S.soloId = null; ports.S.lineageReferenceId = null;
      ports.soloChipLabel(false); setMode('overview');
      if (ports.overview && place && ports.overview.restore) ports.overview.restore(place);
      return;
    }
    ports.S.soloId = null;
    ports.renderList(); refreshBadge(); applyModeChange(true);
  }
  async function resetPaneCameras(paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex);
    if (!pane || pane.disposed) return;
    const view = pane.view, linked = view.syncCamera;
    const viewers = view.mode === 'overlay' ? [view.overlayViewer].filter(Boolean) : (view.gridViewers || []).map(function (g) { return g.viewer; });
    if (linked) {
      if (viewers[0]) { await ports.resetCamera(viewers[0], undefined, pane); if (ports.panes.indexOf(pane) >= 0 && !pane.disposed) ports.syncAllCameras(false, pane); }
    } else for (const viewer of viewers) { if (pane.disposed || ports.panes.indexOf(pane) < 0) break; await ports.resetCamera(viewer, undefined, pane); }
  }
  function setPaneSearchOpen(pane, open) {
    const input = paneControlElement(pane, 'overviewSearch');
    const box = input && input.closest('.overview-search');
    const toggle = paneControlElement(pane, 'btnOverviewSearchToggle');
    if (box) box.classList.toggle('is-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (open && input) input.focus();
  }
  function runPaneControl(pane, action, anchor, event) {
    const view = pane.view;
    if (event.type === 'input') {
      if (action !== 'overviewSearch') return false;
      const value = anchor.value;
      ports.applyOverviewSearch(value, ports.panes.indexOf(pane));
      if (anchor.value !== value) anchor.value = value;
      return true;
    }
    if (event.type === 'keydown') {
      if (action !== 'overviewSearch' || event.key !== 'Escape') return false;
      if (anchor.value) {
        event.preventDefault(); event.stopPropagation();
        anchor.value = ''; ports.applyOverviewSearch('', ports.panes.indexOf(pane));
        return true;
      }
      const box = anchor.closest('.overview-search');
      if (!box || !box.classList.contains('is-open')) return false;
      event.preventDefault(); event.stopPropagation(); setPaneSearchOpen(pane, false);
      const toggle = paneControlElement(pane, 'btnOverviewSearchToggle');
      if (toggle) toggle.focus();
      return true;
    }
    if (event.type === 'change') {
      if (action === 'selTheme') {
        view.theme = anchor.value;
        if (view.theme === 'by-metric' && !ports.S.metrics.table) ports.toast('请先导入指标表', true);
        if (view.overlayViewer) ports.applyTheme(view.overlayViewer, view.overlayRefs, pane);
        for (const grid of view.gridViewers || []) {
          const entry = ports.S.entries.find(function (x) { return x.id === grid.entryId; });
          ports.applyTheme(grid.viewer, [{ id: grid.entryId, ref: grid.ref, color: entry ? entry.color : 0x888888 }], pane);
        }
        if (view.mode === 'overview') ports.rebuildOverview(ports.panes.indexOf(pane));
        refreshBadge();
      } else if (action === 'selRepr') { view.repr = anchor.value; applyModeChange(true); }
      else if (action === 'selCols') applyGridShape(anchor.value, view.rows, true, pane);
      else if (action === 'selRows') applyGridShape(view.cols, anchor.value, true, pane);
      else if (action === 'selMaxOverlay') { view.maxOverlay = parseInt(anchor.value, 10); if (view.mode === 'overlay') ports.rebuildOverlay(true, pane); }
      else return false;
      return true;
    }
    if (event.type !== 'click') return false;
    if (action !== 'btnOverviewSearchToggle' && action !== 'btnOverviewSearchClear' && action !== 'overviewSearch') {
      for (const other of ports.panes) setPaneSearchOpen(other, false);
    }
    if (ports.PANE_MENU_BUTTONS[action]) { event.stopPropagation(); togglePaneControlMenu(pane, ports.PANE_MENU_BUTTONS[action], anchor); return true; }
    switch (action) {
      case 'pane-mode':
        if (anchor.dataset.mode === 'grid') { if (view.mode !== 'grid' && view.mode !== 'overlay') ports.openCurrentInGrid(); }
        else if (anchor.dataset.mode === 'overview') setMode('overview');
        break;
      case 'pane-actions': event.stopPropagation(); openPaneActions(pane, anchor); break;
      case 'btnOverviewToGrid': ports.closeMenus(); closePaneControlMenus(pane); ports.openCurrentInGrid(); break;
      case 'benchSide': if (view.mode !== 'grid') setMode('grid'); break;
      case 'benchOverlay': if (view.mode !== 'overlay') setMode('overlay'); break;
      case 'btnOverviewSearchToggle': { const input = paneControlElement(pane, 'overviewSearch'), box = input && input.closest('.overview-search'); setPaneSearchOpen(pane, !box || !box.classList.contains('is-open')); break; }
      case 'btnOverviewSearchClear': {
        const input = paneControlElement(pane, 'overviewSearch');
        if (input) input.value = '';
        ports.applyOverviewSearch('', ports.panes.indexOf(pane));
        if (input) input.focus();
        break;
      }
      case 'btnOverviewNewFolder': { const ctx = ports.currentOrgContext(); ports.promptNewOrgFolder(ctx.stepKey, ctx.parentId, ctx.selected); break; }
      case 'btnOverviewNewStep': ports.closeMenus(); closePaneControlMenus(pane); ports.openStepModal({}); break;
      case 'btnOverviewPipeline': ports.closeMenus(); closePaneControlMenus(pane); if (ports.panePipelineController) ports.panePipelineController.importWholePipeline({ pane: pane }); break;
      case 'btnOverviewAIPipeline': case 'btnEmptyAIImport': ports.closeMenus(); closePaneControlMenus(pane); ports.openAIPipelineAssist(); break;
      case 'btnOpenAISettings':
        ports.closeMenus(); closePaneControlMenus(pane);
        if (window.SB_AI_CHAT && window.SB_AI_CHAT.openSettingsUI) window.SB_AI_CHAT.openSettingsUI();
        else ports.toast('AI 助手尚未就绪，请稍候再试', true);
        break;
      case 'btnEmptyAIPrompt': ports.copyText(ports.AI_PIPELINE_PROMPT, '提示词已复制，发给任意 AI 即可'); break;
      case 'btnEmptyAIExample': ports.copyText(JSON.stringify(ports.AI_PIPELINE_EXAMPLE, null, 2), '示例 JSON 已复制'); break;
      case 'btnOverviewStarPass': ports.closeMenus(); closePaneControlMenus(pane); ports.starPassing(); break;
      case 'btnOverviewExport': ports.closeMenus(); closePaneControlMenus(pane); ports.exportPlacement(); break;
      case 'btnOverviewUndo': ports.undoOrg(); break;
      case 'btnOverviewRedo': ports.redoOrg(); break;
      case 'btnOverviewGrouped': togglePaneGrouping(); break;
      case 'btnGridByCandidate': case 'btnGridFlat':
        closePaneControlMenus(pane);ports.setGridArrangement(action === 'btnGridFlat' ? 'flat' : 'candidate', pane);break;
      case 'btnSplitToggle': ports.closeMenus(); toggleSplit(); break;
      case 'btnTrash': ports.openTrashPage(); break;
      case 'btnTrashBack': ports.closeTrashPage(); break;
      case 'btnTrashRestoreAll': ports.restoreAllTrash(); break;
      case 'btnGridRec': { const rec = recommendGrid(pane); applyGridShape(rec.cols, rec.rows, true, pane); break; }
      case 'btnAlign': closePaneControlMenus(pane); ports.toggleAlign(pane); break;
      case 'btnResetCam': resetPaneCameras(pane); break;
      case 'btnShot': closePaneControlMenus(pane); saveImage(); break;
      case 'btnFollowRef':
        view.syncCamera = !view.syncCamera;
        if (view.syncCamera) ports.syncAllCameras(false, pane);
        refreshBadge();
        ports.toast(view.syncCamera ? '实时联动已开启：鼠标拖动任一视窗，其余持续跟随' : '实时联动已关闭：各视窗独立操作');
        break;
      case 'btnSyncCam': closePaneControlMenus(pane); ports.syncAllCameras(true, pane); refreshBadge(); ports.toast('已把所有视窗统一到参考视角（一次性，不影响实时联动开关）'); break;
      case 'btnGridBack': ports.backGridFolder(); break;
      case 'btnPrevPage': ports.gridLayer(); if (view.page > 0) { view.page--; ports.rebuildGrid(pane); } break;
      case 'btnNextPage': { const nodes = ports.gridLayer().nodes; if ((view.page + 1) * ports.pageSize() < nodes.length) { view.page++; ports.rebuildGrid(pane); } break; }
      case 'btnShowAll': showAllPaneEntries(); break;
      case 'btnEmptyFiles': ports.pickImport(false); break;
      case 'btnEmptyFolder': ports.pickImport(true); break;
      case 'btnEmptyDemo': ports.loadDemo(); break;
      default: return false; // Back/Pause/Lite 属于 overview 实例，不能再执行一次。
    }
    return true;
  }
  function bindPaneControls(paneOrIndex) {
    const pane = ports.paneAt(paneOrIndex), stage = pane && (pane.el || paneStage(ports.panes.indexOf(pane)));
    if (!stage || pane.disposed) return null;
    const existing = ports.paneControlBindings.get(stage);
    if (existing && !existing.disposed) { pane.runtime.controls = existing; return existing; }
    if (existing) ports.paneControlBindings.delete(stage);
    const listeners = [];
    const controller = {
      pane: pane, stage: stage, harnessed: false, disposed: false,
      listen: function (target, type, handler, options) { if (controller.disposed) return; target.addEventListener(type, handler, options); listeners.push([target, type, handler, options]); },
      dispose: function () {
        if (controller.disposed) return;
        controller.disposed = true;
        listeners.forEach(function (args) { args[0].removeEventListener(args[1], args[2], args[3]); });
        listeners.length = 0; ports.paneControlBindings.delete(stage);
      },
    };
    const delegate = function (event) {
      const target = event.target && (event.target.closest ? event.target : event.target.parentElement);
      const anchor = target && target.closest('button, select, input, [data-action]');
      if (!anchor || !stage.contains(anchor) || anchor.disabled || anchor.getAttribute('aria-disabled') === 'true') return;
      const action = anchor.dataset.action || (anchor.classList.contains('pane-mode-btn') ? 'pane-mode' : anchor.classList.contains('pane-actions-btn') ? 'pane-actions' : anchor.id.replace(/^p\d+-/, ''));
      const index = ports.panes.indexOf(pane);
      if (index < 0 || pane.disposed) return;
      const capturedValue = event.type === 'change' || event.type === 'input' ? anchor.value : null;
      setActivePane(index, { sync: false });
      if (capturedValue !== null && anchor.value !== capturedValue) anchor.value = capturedValue;
      ports.withPaneSync(pane, function () { if (runPaneControl(pane, action, anchor, event)) syncPaneControls(pane); });
    };
    for (const type of ['click', 'change', 'input', 'keydown']) controller.listen(stage, type, delegate);
    ports.paneControlBindings.set(stage, controller);
    pane.runtime.controls = controller;
    return controller;
  }
  function openPaneActions(paneOrIndex, anchor) {
    const pane = ports.paneAt(paneOrIndex), index = ports.panes.indexOf(pane);
    if (index < 0 || pane.disposed) return;
    ports.closeMenus();
    for (const other of ports.panes) closePaneControlMenus(other);
    const wasOpen = ports.paneActionsMenu && !ports.paneActionsMenu.hidden && ports.paneActionsMenu.__sbAnchor === anchor;
    if (ports.paneActionsMenu && ports.paneActionsMenu.__sbAnchor) ports.paneActionsMenu.__sbAnchor.setAttribute('aria-expanded', 'false');
    if (wasOpen) { ports.paneActionsMenu.hidden = true; return; }
    if (!ports.paneActionsMenu) {
      ports.paneActionsMenu = document.createElement('div');
      ports.paneActionsMenu.className = 'pane-actions-menu';
      ports.paneActionsMenu.setAttribute('role', 'menu');
      ports.paneActionsMenu.hidden = true;
      document.body.appendChild(ports.paneActionsMenu);
      document.addEventListener('mousedown', function (event) {
        const target = event.target;
        if (!ports.paneActionsMenu.hidden && !ports.paneActionsMenu.contains(target) && !(target.closest && target.closest('.pane-actions-btn'))) {
          ports.paneActionsMenu.hidden = true;
          if (ports.paneActionsMenu.__sbAnchor) ports.paneActionsMenu.__sbAnchor.setAttribute('aria-expanded', 'false');
        }
      });
      ports.paneActionsMenu.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); ports.paneActionsMenu.hidden = true;
        if (ports.paneActionsMenu.__sbAnchor) { ports.paneActionsMenu.__sbAnchor.setAttribute('aria-expanded', 'false'); ports.paneActionsMenu.__sbAnchor.focus(); }
      });
    }
    const api = pane.overview;
    const items = [
      { label: '新建文件夹', action: 'btnOverviewNewFolder' },
      { label: '新步骤…', action: 'btnOverviewNewStep' },
      { label: '全管线', action: 'btnOverviewPipeline' },
      { sep: true },
      { label: '撤销', action: 'btnOverviewUndo' },
      { label: '重做', action: 'btnOverviewRedo' },
      { sep: true },
      { label: '按序列分组', action: 'btnOverviewGrouped', state: pane.view.overviewGrouped ? '开' : '关' },
      { label: '暂停生成封面', action: 'btnOverviewPause', state: api && api.stats && api.stats.paused ? '已暂停' : '' },
      { label: '省资源模式', action: 'btnOverviewLite', state: api && api.stats && api.stats.lite ? '开' : '' },
      { sep: true },
      { label: 'AI 助手设置…', action: 'btnOpenAISettings' },
      { label: 'AI 生成管线…', action: 'btnOverviewAIPipeline' },
      { label: '标记符合位置', action: 'btnOverviewStarPass' },
      { label: '导出审计', action: 'btnOverviewExport' },
      { sep: true },
      { label: '回收站', action: 'btnTrash' },
    ];
    ports.paneActionsMenu.replaceChildren();
    for (const item of items) {
      if (item.sep) { ports.paneActionsMenu.appendChild(ports.el('div', 'pa-sep')); continue; }
      const button = ports.el('button', 'pa-item', item.label);
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      const original = paneControlElement(pane, item.action);
      button.disabled = !!original && original.disabled;
      if (item.state) button.appendChild(ports.el('span', 'pa-state', item.state));
      button.addEventListener('click', function (event) {
        event.stopPropagation(); ports.paneActionsMenu.hidden = true;
        anchor.setAttribute('aria-expanded', 'false');
        if (pane.disposed || ports.panes.indexOf(pane) < 0 || button.disabled) return;
        setActivePane(ports.panes.indexOf(pane), { sync: false });
        ports.withPaneSync(pane, function () {
          // 这三个按钮的原 onclick 由该栏 overview 实例安装。
          if (item.action === 'btnOverviewPause' || item.action === 'btnOverviewLite' || item.action === 'btnOverviewBack') {
            if (original) original.click();
          } else runPaneControl(pane, item.action, button, event);
          syncPaneControls(pane);
        });
      });
      ports.paneActionsMenu.appendChild(button);
    }
    ports.paneActionsMenu.__sbAnchor = anchor;
    ports.paneActionsMenu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    const rect = anchor.getBoundingClientRect();
    const mw = ports.paneActionsMenu.offsetWidth || 180, mh = ports.paneActionsMenu.offsetHeight || 300;
    const x = Math.min(rect.right - mw, window.innerWidth - mw - 8);
    let y = rect.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
    ports.paneActionsMenu.style.left = Math.max(8, x) + 'px';
    ports.paneActionsMenu.style.top = y + 'px';
  }
  function syncPaneModeButtons(stage, index) {
    if (stage) syncPaneControls(index);
  }
  function clonePaneDom() {
    const source = document.getElementById('stage');
    if (!source || document.getElementById('p2-stage')) return;
    const clone = source.cloneNode(true);
    clone.id = 'p2-stage';
    clone.classList.add('stage-secondary');
    // 只保留本栏该有的东西：摘掉全窗唯一的离屏渲染宿主、toast、AI 浮层等。
    for (const sel of ['#thumbnailHost', '#toast', '[id^="aiChat"], .toast']) {
      clone.querySelectorAll(sel).forEach(function (n) { n.remove(); });
    }
    // 卡片与偏移量是左栏实例算出来的，必须清空：新实例会按自己的宽度重新布局，
    // 留着旧卡片会让右栏出现「4 张 + 4 张」的重复堆叠。
    const clonedCards = clone.querySelector('#overviewCards');
    const clonedSpacer = clone.querySelector('#overviewSpacer');
    if (clonedCards) clonedCards.replaceChildren();
    if (clonedSpacer) clonedSpacer.style.height = '0px';
    // Viewer/canvas 与 minimap 属于运行态，不能把左栏残留当作右栏视窗。
    for (const id of ['gridStage', 'overlayStage', 'trashCards']) {
      const host = clone.querySelector('#' + id);
      if (host) host.replaceChildren();
    }
    clone.querySelectorAll('.ov-minimap, .ov-drag-ghost, .ov-pick-overlay, .overview-marquee').forEach(function (node) { node.remove(); });
    const clonedIds = new Set(Array.from(clone.querySelectorAll('[id]'), function (node) { return node.id; }));
    clone.querySelectorAll('.menu, .pane-actions-menu').forEach(function (node) { node.hidden = true; });
    clone.querySelectorAll('[aria-expanded]').forEach(function (node) { node.setAttribute('aria-expanded', 'false'); });
    clone.querySelectorAll('.overview-search.is-open').forEach(function (node) { node.classList.remove('is-open'); });
    clone.querySelectorAll('[id]').forEach(function (node) {
      node.id = 'p2-' + node.id;
      if (node.tagName === 'INPUT' && node.type === 'search') node.value = '';
    });
    // 仅重写本栏引用；多 id 的 aria 关系逐项处理，全窗唯一目标保持原样。
    clone.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby],[for]').forEach(function (node) {
      for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) {
        const value = node.getAttribute(attr);
        if (value) node.setAttribute(attr, value.split(/\s+/).map(function (id) { return clonedIds.has(id) ? 'p2-' + id : id; }).join(' '));
      }
    });
    // 第二栏不加额外标识徽章：左右位置已足够区分，少一个元素就少一分噪声。
    source.parentElement.insertBefore(clone, source.nextSibling);
    const toolbar=clone.querySelector('#p2-toolbar');
    const owner=ports.panes[1];
    if(toolbar && window.SB_UI) { owner.runtime.toolbar=window.SB_UI.mountToolbar(toolbar,'p2-'); ports.PANE_RUNTIME.addCleanup(owner,function(){owner.runtime.toolbar.dispose();}); }
    // 两栏都要有「总览 / 检阅台」切换（第 1 栏用 1 作索引）。
    ensurePaneModeRow(1);
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.id = 'paneDivider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.title = '拖动调整两栏宽度';
    source.parentElement.insertBefore(divider, clone);
    makeDividerDraggable(divider);
    harnessPane(clone, 1);
  }
  function applySplitRatio(ratio) {
    const r = Math.max(0.28, Math.min(0.72, ratio));   // 太窄会挤成单列
    const first = document.getElementById('stage');
    const second = document.getElementById('p2-stage');
    const divider = document.getElementById('paneDivider');
    if (!first || !second || !divider) return;
    const pct = (r * 100).toFixed(2);
    first.style.width = 'calc(' + pct + '% - 5px)';
    second.style.left = 'calc(' + pct + '% + 5px)';
    divider.style.left = 'calc(' + pct + '% - 5px)';
  }
  function makeDividerDraggable(divider) {
    let dragging = false;
    let frame = 0;
    let latestClientX = null;
    let disposed = false;
    const pane = ports.panes[1];
    const readRatio = function (clientX) {
      const host = divider.parentElement;
      if (!host || !Number.isFinite(clientX)) return null;
      const rect = host.getBoundingClientRect();
      return rect.width ? (clientX - rect.left) / rect.width : null;
    };
    const renderPanes = function () {
      ports.panes.forEach(function (p) {
        if (ports.PANE_RUNTIME.alive(p) && p.overview) p.overview.renderWindow();
      });
    };
    const applyLatest = function () {
      if (disposed || !dragging) return;
      const ratio = readRatio(latestClientX);
      if (ratio == null) return;
      applySplitRatio(ratio);
      renderPanes();
    };
    const schedule = function () {
      if (frame || disposed || !dragging) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        applyLatest();
      });
    };
    const cleanup = function () {
      disposed = true;
      dragging = false;
      latestClientX = null;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    if (pane && ports.PANE_RUNTIME && ports.PANE_RUNTIME.addCleanup) ports.PANE_RUNTIME.addCleanup(pane, cleanup);
    divider.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || disposed) return;
      dragging = true;
      latestClientX = e.clientX;
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', function (e) {
      if (!dragging || disposed) return;
      latestClientX = e.clientX;
      schedule();
    });
    const stop = function (e) {
      if (!dragging || disposed) return;
      if (Number.isFinite(e.clientX)) latestClientX = e.clientX;
      dragging = false;
      try { divider.releasePointerCapture(e.pointerId); } catch (_) {}
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      const ratio = readRatio(latestClientX);
      if (ratio == null) return;
      applySplitRatio(ratio);
      renderPanes();
      try { localStorage.setItem(ports.SPLIT_RATIO_KEY, String(Math.max(0.28, Math.min(0.72, ratio)))); } catch (_) {}
    };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }
  function harnessPane(stage, index) {
    const pane = ports.paneAt(index), controller = bindPaneControls(pane);
    if (!controller || controller.harnessed) return controller;
    controller.harnessed = true;
    let pointer = null, frame = 0, pending = false;
    const deferSync = function () {
      if (frame || !pending) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        if (pointer !== null || pane.disposed || ports.panes.indexOf(pane) < 0) return;
        pending = false;
        if (ports.activePane === ports.panes.indexOf(pane)) syncPaneFocus(true);
      });
    };
    const activate = function () {
      const target = ports.panes.indexOf(pane);
      if (target < 0 || pane.disposed) return;
      if (ports.activePane !== target) pending = true;
      setActivePane(target, { sync: false });
    };
    controller.listen(stage, 'pointerdown', function (event) {
      pointer = event.pointerId;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      activate();
    }, true);
    controller.listen(stage, 'focusin', function () { activate(); if (pointer === null) deferSync(); }, true);
    const finish = function (event) {
      if (pointer === null || (event.pointerId !== undefined && event.pointerId !== pointer)) return;
      pointer = null; deferSync();
    };
    controller.listen(window, 'pointerup', finish, true);
    controller.listen(window, 'pointercancel', finish, true);
    controller.listen(window, 'blur', function () { if (pointer !== null) { pointer = null; deferSync(); } });
    const dispose = controller.dispose;
    controller.dispose = function () { if (frame) cancelAnimationFrame(frame); dispose(); };
    return controller;
  }
  function activateAndApply(index, text) {
    if (ports.activePane !== index) setActivePane(index);
    ports.applyOverviewSearch(text);
  }
  function splitOn() {
    if (ports.splitState.active) return;
    ports.panes[0].el = document.getElementById('stage');
    const fromWidth = splitMotion.capture(ports.panes[0].el);
    const firstScroll = ports.panes[0].el && ports.panes[0].el.querySelector('.overview-scroll');
    if (firstScroll) ports.panes[0].scrollTop = firstScroll.scrollTop;
    const place = ports.panes[0].overview && ports.panes[0].overview.capture ? ports.panes[0].overview.capture() : null;
    ports.addPane2();
    ports.splitState.active = true;
    clonePaneDom();
    ports.panes[1].el = document.getElementById('p2-stage');
    document.body.classList.add('is-split');
    for (const pane of ports.panes) {
      if (typeof bindPaneControls === 'function') bindPaneControls(pane);
      if (typeof syncPaneControls === 'function') syncPaneControls(pane);
    }
    if (!ports.rawS.sidebarCollapsed) ports.setSidebarCollapsed(true, false);
    ports.activePane = 0;
    ports.overview = ports.panes[0].overview || null;
    // The existing pane retains its live pool; only the new pane needs a content build.
    applyModeChange(false, ports.panes[0]);
    applyModeChange(true, ports.panes[1]);
    if (place && ports.panes[1].view.mode === 'overview' && ports.panes[1].overview && ports.panes[1].overview.restore) ports.panes[1].overview.restore(ports.PANE_RUNTIME.copy(place));
    syncPaneFocus(true);
    ports.resizeGridViewers(); ports.renderOverviewWindow(); syncSplitButtons();
    splitMotion.play(ports.panes[0].el, fromWidth, { entering: ports.panes[1].el, restoring: ports.rawS.restoringSession });
    ports.scheduleSessionSave();
    ports.toast('已分屏：点任一栏切换焦点，每栏可独立选择总览或检阅台');
  }
  function splitOff() {
    if (!ports.splitState.active) return;
    const fromWidth = splitMotion.capture(document.getElementById('stage'));
    const retired = ports.panes[1], stage = retired && (retired.el || document.getElementById('p2-stage'));
    // Invalidate the old identity before removing its slot; disposal waits for creates / queues.
    const done = ports.disposePane(retired);
    ports.removePane2();
    ports.splitState.active = false; ports.activePane = 0;
    document.body.classList.remove('is-split');
    const divider = document.getElementById('paneDivider');
    if (divider) divider.remove();
    if (stage) stage.remove();
    const first = document.getElementById('stage');
    ports.panes[0].el = first; ports.overview = ports.panes[0].overview || null;
    if (first) { first.style.width = ''; first.classList.remove('is-focus'); first.dataset.mode = ports.panes[0].view.mode; }
    if (typeof bindPaneControls === 'function') bindPaneControls(ports.panes[0]);
    syncPaneFocus(true); applyModeChange(false, ports.panes[0]);
    ports.resizeGridViewers(); ports.renderOverviewWindow(ports.panes[0]); syncSplitButtons();
    syncModeTabs();
    splitMotion.play(first, fromWidth, { restoring: ports.rawS.restoringSession });
    ports.scheduleSessionSave();
    return done;
  }
  function toggleSplit() {
    if (ports.splitState.active) splitOff(); else splitOn();
    syncSplitButtons();
  }
  function syncSplitButtons() {
    const pressed = String(ports.splitState.active);
    for (const id of ['btnSplitGlobal', 'btnSplitToggle']) {
      const b = ports.$(id);
      if (b) b.setAttribute('aria-pressed', pressed);
    }
  }
  function refreshSharedPaneViews(options) {
    options = options || {};
    const jobs = [];
    for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
      const state = pane.view;
      if (state.referenceId && !ports.rawS.entries.some(function (entry) { return entry.id === state.referenceId && !ports.entryIsTrashed(entry); })) {
        const reference = ports.rawS.entries.find(function (entry) { return !ports.entryIsTrashed(entry); });
        state.referenceId = reference ? reference.id : null; state.aligned = false;
        ports.PANE_RUNTIME.invalidate(pane, 'align'); pane.runtime.alignment.clear();
      }
      ports.withPaneSync(pane, function () {
        ports.refreshGridHeaders(); refreshBadge();
        if (typeof syncPaneControls === 'function') syncPaneControls(pane);
      });
      if (options.rebuild !== false) jobs.push(applyModeChange(true, pane));
      else if (pane.overview && options.entry) pane.overview.mark(options.entry);
    }
    return Promise.all(jobs);
  }
  function resetSharedPaneViews() {
    const jobs = [];
    for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
      const state = pane.view;
      ports.PANE_RUNTIME.invalidate(pane, 'overlay'); ports.PANE_RUNTIME.invalidate(pane, 'grid'); ports.PANE_RUNTIME.invalidate(pane, 'align');
      pane.runtime.alignment.clear();
      state.aligned = false; state.referenceId = null; state.soloId = null; state.lineageReferenceId = null;
      state.page = 0; state.listNav = null; state.listLimit = 60; state.activeGroupId = 'all';
      state.gridFromOverview = null; state.overviewReturn = null; state.soloFrom = null; state.overlayRefs = []; state.overlaySkipped = 0;
      ports.withPaneSync(pane, ports.resetGridNavigation);
      if (pane.overview) {
        pane.overview.clear();
        if (pane.overview.setSearch) pane.overview.setSearch('');
      }
      jobs.push(ports.disposeGrid(pane));
      jobs.push(ports.PANE_RUNTIME.enqueue(pane, 'overlay', async function () {
        if (state.overlayViewer) await ports.clearViewer(state.overlayViewer);
      }));
    }
    return Promise.all(jobs);
  }
  function refreshBadge() {
    const badge = ports.$('stageBadge');
    const vis = ports.S.gridFromOverview && !ports.S.soloId
      ? ports.gridLayer().nodes.length : ports.visibleEntries().length;
    if (!ports.S.entries.length || ports.S.mode === 'overview') { badge.hidden = true; return; }
    badge.hidden = false;
    const parts = [vis + ' 个可见结构'];
    if (ports.S.aligned) parts.push('已按 CA 对齐');
    if (ports.S.theme === 'per-structure') parts.push('每文件一色');
    if (ports.S.theme === 'by-metric' && ports.S.metrics.primary) parts.push('按 ' + ports.S.metrics.primary + ' 上色');
    if (ports.S.starOnly) parts.push('仅看优选');
    if (ports.S.metrics.filters.length) parts.push(ports.S.metrics.filters.length + ' 个筛选条件');
    if (ports.S.soloId) {
      const e = ports.S.entries.find(function (x) { return x.id === ports.S.soloId; });
      parts.push('单独查看：' + (e ? e.name : ''));
    }
    if (ports.S.syncCamera) parts.push('实时联动');
    if (ports.S.activeGroupId !== 'all') {
      const g = ports.S.groups.find(function (x) { return x.id === ports.S.activeGroupId; });
      if (g) parts.push('文件夹：' + g.name);
    }
    if (ports.S.overlaySkipped && ports.S.mode === 'overlay') parts.push('另有 ' + ports.S.overlaySkipped + ' 个未载入');
    badge.textContent = parts.join(' · ');
  }
  function updateEmptyState() {
    const empty = ports.$('emptyState');
    empty.hidden = ports.S.entries.length > 0 || !!ports.S.restoringSession;
    ports.$('toolbar').hidden = ports.S.entries.length === 0;
    ports.$('camDock').hidden = ports.S.entries.length === 0 || ports.S.mode === 'overview';
    ports.$('gridPager').hidden = !(ports.S.mode === 'grid' && ports.S.entries.length > 0);
  }
  function applyModeChange(rebuild, value) {
    const pane = typeof ports.paneAt === 'function' ? ports.paneAt(value) : null;
    if (pane && pane.disposed) return Promise.resolve();
    if (pane && ports.scopedPane !== pane) return ports.withPaneSync(pane, function () { return applyModeChange(rebuild, pane); });
    updateEmptyState();
    const isOverview = ports.S.mode === 'overview';
    const reprGroup = ports.$('selRepr') && ports.$('selRepr').closest('.tool-group');
    if (reprGroup) reprGroup.hidden = isOverview;
    ports.$('btnFollowRef').hidden = isOverview;
    ports.$('gridTools').hidden = ports.S.mode !== 'grid';
    ports.$('overlayTools').hidden = ports.S.mode !== 'overlay';
    ports.$('benchToggle').hidden = isOverview;
    // 方案 A：检阅台的返回键只在检阅台里出现；总览自己的层级返回在面包屑旁，别让两个 ← 打架。
    ports.$('btnGridBack').hidden = isOverview || !(ports.S.gridFromOverview || ports.S.overviewReturn);
    ports.$('benchSide').setAttribute('aria-pressed', String(ports.S.mode === 'grid'));
    ports.$('benchOverlay').setAttribute('aria-pressed', String(ports.S.mode === 'overlay'));
    ports.$('gridPager').hidden = !(ports.S.mode === 'grid' && ports.S.entries.length > 0);
    ports.$('overlayStage').hidden = ports.S.mode !== 'overlay';
    ports.$('gridStage').hidden = ports.S.mode !== 'grid';
    ports.$('overviewStage').hidden = !isOverview || ports.S.trashOpen;
    ports.$('trashStage').hidden = !ports.S.trashOpen;
    if (isOverview) { ports.$('camDock').hidden = true; ports.$('stageBadge').hidden = true; }
    // 标记本栏当前的模式，供 CSS 控制「总览时不显示检阅台工具栏」。
    // paneStage 在工具栏几何测试的沙箱里不存在，这里要容忍。
    const curStage = pane ? (pane.el || paneStage(pane.index)) : null;
    if (curStage) curStage.dataset.mode = ports.S.mode;
    // 模式开关的选中态。不调用 syncModeThumb：它会做 DOM 测量，
    // 而 applyModeChange 被工具栏几何测试单独抽取执行，不能引入额外依赖。
    const paneOv = ports.$('btnOverview'), paneBench = ports.$('btnBench');
    if (paneOv) paneOv.setAttribute('aria-selected', String(isOverview));
    if (paneBench) paneBench.setAttribute('aria-selected', String(ports.S.mode === 'grid' || ports.S.mode === 'overlay'));
    if (pane && typeof syncPaneControls === 'function') syncPaneControls(pane);
    ports.resizeGridViewers(pane || undefined);
    if (!rebuild) return;
    if (ports.S.mode === 'overlay') return ports.rebuildOverlay(true, pane || undefined);
    else if (isOverview) return ports.rebuildOverview(pane || undefined);
    else return ports.rebuildGrid(pane || undefined);
  }
  function syncModeThumb() {
    const thumb = ports.$('modeThumb');
    const active = document.querySelector('.mode-switch .mode-btn.active');
    if (!thumb || !active) return;
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
  function syncModeTabs() {
    const ov = ports.$('btnOverview'), bench = ports.$('btnBench');
    if (!ov || !bench) return;
    const inBench = ports.S.mode === 'grid' || ports.S.mode === 'overlay';
    ov.classList.toggle('active', !inBench);
    ov.setAttribute('aria-selected', String(!inBench));
    bench.classList.toggle('active', inBench);
    bench.setAttribute('aria-selected', String(inBench));
    syncModeThumb();
  }
  function setMode(mode, opts, value) {
    opts = opts || {};
    const pane = ports.paneAt(value == null ? opts.pane : value);
    if (!ports.PANE_RUNTIME.alive(pane)) return;
    if (ports.scopedPane !== pane) return ports.withPaneSync(pane, function () { return setMode(mode, opts, pane); });
    const host = pane.overview;
    if (ports.S.mode === mode) {
      if (mode === 'grid' && opts.gridPlace) { ports.applyGridPlace(ports.PANE_RUNTIME.copy(opts.gridPlace)); ports.rebuildGrid(pane); }
      if (mode === 'overview' && opts.overviewPlace && host && host.restore) host.restore(ports.PANE_RUNTIME.copy(opts.overviewPlace));
      if (typeof syncPaneControls === 'function') syncPaneControls(pane);
      return;
    }
    const previousMode = ports.S.mode;
    let gridPlace = opts.gridPlace && ports.PANE_RUNTIME.copy(opts.gridPlace);
    if (mode === 'grid' && previousMode === 'overview') {
      if (!gridPlace && host && host.capture) gridPlace = host.capture();
      ports.armGridFromOverview(gridPlace, host && host.current ? host.current() : null);
    }
    if (previousMode === 'grid' && mode !== 'overlay') ports.resetGridNavigation();
    if (previousMode === 'overview' && host) host.leave();
    if (mode !== 'overlay' && mode !== 'grid' && ports.S.soloFrom) ports.clearOverviewReturn();
    ports.PANE_RUNTIME.invalidate(pane, 'overlay');
    ports.PANE_RUNTIME.invalidate(pane, 'grid');
    ports.S.gridBusy = false;
    if (mode !== 'grid') ports.disposeGrid(pane);
    if (mode === 'overview') { ports.S.gridFromOverview = null; ports.S.soloId = null; }
    if (ports.S.overlayViewer) {
      try {
        if (mode === 'overlay') ports.S.overlayViewer.plugin.animationLoop.start();
        else ports.S.overlayViewer.plugin.animationLoop.stop({ noDraw: true });
      } catch (_) {}
    }
    ports.S.mode = mode;
    if (mode === 'grid' && gridPlace) ports.applyGridPlace(gridPlace);
    syncModeTabs();
    if (ports.panes[ports.activePane] === pane) ports.renderList();
    refreshBadge();
    const build = applyModeChange(true, pane);
    if (mode === 'overview' && (opts.overviewPlace || ports.S.overviewReturn) && pane.overview && pane.overview.restore) {
      pane.overview.restore(ports.PANE_RUNTIME.copy(opts.overviewPlace || ports.S.overviewReturn));
    }
    if (!opts.skipSessionSave && !ports.rawS.restoringSession && ports.rawS.entries.length) ports.scheduleSessionSave();
    return build;
  }
  function saveImage() {
    const v = ports.S.mode === 'overlay'
      ? ports.S.overlayViewer
      : (ports.S.gridViewers[0] && ports.S.gridViewers[0].viewer);
    if (!v) { ports.toast('当前没有可截图的结构', true); return; }
    try {
      const c3d = v.plugin.canvas3d;
      if (c3d && typeof c3d.commit === 'function') c3d.commit(true);
      const canvas = c3d && c3d.canvas;
      if (!canvas) throw new Error('找不到 3D 画布');
      const url = canvas.toDataURL('image/png');
      if (!url || url.length < 100) throw new Error('画布为空');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'structboard-' + Date.now() + '.png';
      a.click();
      ports.toast('图片已保存');
    } catch (e) {
      ports.toast('直接截图不可用，请用 Mol* 右下角的相机按钮', true);
    }
  }
// SERVICE_FUNCTIONS_END
  return { paneStage, paneOverviewStage, setActivePane, syncPaneFocus, applyAllPaneModes, ensurePaneModeRow, paneControlElement, closePaneControlMenus, togglePaneControlMenu, syncPaneControls, togglePaneGrouping, clampGridCount, gpuInfo, recommendGrid, paintGridRecommendation, applyGridShape, showAllPaneEntries, resetPaneCameras, setPaneSearchOpen, runPaneControl, bindPaneControls, openPaneActions, syncPaneModeButtons, clonePaneDom, applySplitRatio, makeDividerDraggable, harnessPane, activateAndApply, splitOn, splitOff, toggleSplit, syncSplitButtons, refreshSharedPaneViews, resetSharedPaneViews, refreshBadge, updateEmptyState, applyModeChange, syncModeThumb, syncModeTabs, setMode, saveImage };
}
