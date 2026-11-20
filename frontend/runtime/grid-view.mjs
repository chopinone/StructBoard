import { benchGroups, benchPageGroups } from '../domain/bench-arrangement.mjs';
// grid-view: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function arrangeGridCells(pane) {
    const S = ports.paneContext(pane), stage = ports.paneElement(pane, 'gridStage');
    if (!stage || pane.disposed) return;
    const all = (S.gridNodes || []).map(n => n.entry).filter(Boolean), grouping = benchGroups(all);
    S.gridGroupCount = grouping.available ? grouping.groups.length : 0;
    S.gridArrangementLabel = grouping.label;
    const grouped = S.gridArrangement !== 'flat' && grouping.available;
    const visible = S.gridCells.filter(c => c.node && c.entryId && c.box.style.display !== 'none');
    const cameras = visible.filter(c => c.viewer && c.loadedEntryId === c.entryId).map(c => [c.viewer, ports.cameraSnapshot(c.viewer)]);
    // Move the same cell/viewer elements. A display change must never clear/load a model.
    S.gridCells.forEach(c => stage.appendChild(c.box));
    stage.querySelectorAll('.bench-model-group').forEach(node => node.remove());
    stage.classList.toggle('is-arranged', grouped);
    stage.dataset.arrangement = grouped ? 'candidate' : 'flat';
    stage.style.setProperty('--grid-rows', String(S.rows));
    if (grouped) {
      const byId = new Map(visible.map(c => [c.entryId, c]));
      const layout = benchPageGroups(visible.map(c => c.node.entry), grouping, S.cols);
      stage.style.setProperty('--grid-rows', String(Math.max(S.rows, layout.rows)));
      for (const chunk of layout.chunks) {
        const group = ports.el('section', 'bench-model-group'), heading = ports.el('div', 'bench-model-heading');
        group.dataset.groupKey = chunk.key;
        group.style.gridColumn = chunk.column + ' / span ' + chunk.entries.length;
        group.style.gridRow = String(chunk.row);
        const title = ports.el('strong'), count = ports.el('span');
        title.textContent = chunk.name;title.title = chunk.name;
        count.textContent = chunk.entries.length + ' / ' + chunk.total + ' 个结构';
        count.title = '本行显示 ' + chunk.entries.length + ' 个，本次比较中该组共 ' + chunk.total + ' 个';
        heading.append(title, count);
        const row = ports.el('div', 'bench-model-row');row.style.gridTemplateColumns = 'repeat(' + chunk.entries.length + ', minmax(0, 1fr))';
        chunk.entries.forEach(entry => row.appendChild(byId.get(entry.id).box));
        group.append(heading, row);stage.appendChild(group);
      }
    }
    const wasSyncing = pane.runtime.camera.syncing;pane.runtime.camera.syncing = true;
    try { cameras.forEach(([viewer, camera]) => { viewer.handleResize();ports.applyCameraSnapshot(viewer, camera); }); }
    finally { pane.runtime.camera.syncing = wasSyncing; }
    ports.syncPaneControls(pane);
  }
  function setGridArrangement(mode, value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane) || pane.view.mode !== 'grid' || !['candidate', 'flat'].includes(mode)) return;
    if (pane.view.gridArrangement === mode) return;
    pane.view.gridArrangement = mode;
    arrangeGridCells(pane);
    ports.schedulePipelineViewSave();
    ports.toast((mode === 'flat' ? '已平铺排列' : '已' + pane.view.gridArrangementLabel) + ' · 共 ' + pane.view.gridNodes.length + ' 个结构');
  }
  function updateGridGeometry(value) {
    const pane = typeof ports.paneAt === 'function' ? ports.paneAt(value) : null;
    if (pane && pane.disposed) return;
    const state = pane ? pane.view : ports.S;
    const get = pane ? function (id) { return ports.paneElement(pane, id); } : ports.$;
    const stage = get('gridStage'), toolbar = get('toolbar');
    const top = (toolbar && !toolbar.hidden
      ? Math.ceil(toolbar.offsetTop + toolbar.offsetHeight + 10) : 10) + 'px';
    for (const [target, name, val] of [
      [stage, '--grid-rows', stage && stage.classList.contains('is-arranged') ? stage.style.getPropertyValue('--grid-rows') : String(state.rows)], [stage, '--grid-cols', String(state.cols)],
      [stage, '--grid-top', top], [get('overviewStage'), '--overview-top', top],
    ]) {
      if (target && target.style.getPropertyValue(name) !== val) target.style.setProperty(name, val);
    }
  }
  function resizeGridViewers(value) {
    const standalone = typeof ports.paneAt !== 'function';
    const targets = standalone ? [null] : (typeof value === 'number' || (value && (value.view || value.pane))
      ? [ports.paneAt(value)] : ports.panes.filter(ports.PANE_RUNTIME.alive));
    for (const pane of targets) {
      if (pane && pane.disposed) continue;
      const runtime = pane ? pane.runtime : null, state = pane ? pane.view : ports.S;
      updateGridGeometry(pane || undefined);
      const previous = runtime ? runtime.resizeRaf : ports.gridResizeRaf;
      if (previous) cancelAnimationFrame(previous);
      const frame = requestAnimationFrame(function () {
        if (runtime) runtime.resizeRaf = 0; else ports.gridResizeRaf = 0;
        if (pane && pane.disposed) return;
        for (const cell of state.gridCells) {
          if (cell.viewer && cell.box.style.display !== 'none') cell.viewer.handleResize();
          if (cell.node && cell.node.kind === 'folder' && window.SB_FOLDER_SHELL && window.SB_FOLDER_SHELL.fit) {
            window.SB_FOLDER_SHELL.fit(cell.box, cell.folderShell);
          }
        }
        if (state.mode === 'overlay' && state.overlayViewer) state.overlayViewer.handleResize();
      });
      if (runtime) runtime.resizeRaf = frame; else ports.gridResizeRaf = frame;
    }
  }
  function disposeGrid(value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane)) return Promise.resolve();
    ports.PANE_RUNTIME.invalidate(pane, 'grid');
    const state = pane.view, retired = state.gridCells;
    state.gridCells = []; state.gridViewers = []; state.gridNodes = []; state.gridBusy = false;
    const stage = ports.paneElement(pane, 'gridStage');
    if (stage) { stage.replaceChildren(); stage.setAttribute('aria-busy', 'false'); }
    return ports.PANE_RUNTIME.enqueue(pane, 'grid', async function () {
      for (const cell of retired) {
        if (cell.viewer) { await ports.PANE_RUNTIME.release(pane, cell.viewer); cell.viewer = null; }
        if(cell.box.__disposeView)cell.box.__disposeView();
      }
    });
  }
  function disposePane(value) {
    const pane = ports.paneAt(value);
    if (!pane) return Promise.resolve();
    if (pane.runtime.resizeRaf) cancelAnimationFrame(pane.runtime.resizeRaf);
    pane.runtime.resizeRaf = 0;
    return ports.PANE_RUNTIME.disposePane(pane);
  }
  function refreshGridHeaders() {
    const entriesById = new Map(ports.S.entries.map(function (e) { return [e.id, e]; }));
    for (const cell of ports.S.gridCells) {
      const node = cell.node;
      const folder = !!(node && node.kind === 'folder');
      const entry = folder
        ? (node.cover || entriesById.get(cell.entryId) || null)
        : entriesById.get(cell.entryId);
      const starred = folder ? (node.entries || []).some(function (e) {
        const current = entriesById.get(e.id); return !!(current && current.star);
      }) : !!(entry && entry.star);
      cell.actions.hidden = !(entry || folder);
      cell.starBtn.hidden = folder;
      cell.moreBtn.hidden = folder;
      cell.starBadge.hidden = !folder;
      cell.starBadge.classList.toggle('on', starred);
      cell.starBadge.title = starred ? '此文件夹中有优选预测' : '此文件夹尚无优选预测';
      cell.box.classList.toggle('is-starred', starred);
      cell.box.classList.toggle('grid-folder', folder);
      if (!folder) cell.box.style.clipPath = '';
      cell.folderTab.hidden = true;
      if (cell.folderShell) cell.folderShell.hidden = !folder;
      cell.folderOpen.hidden = !folder;
      if (cell.folderNote) {
        cell.folderNote.hidden = !folder;
        if (folder && document.activeElement !== cell.folderNote) {
          cell.folderNote.value = ports.folderNoteOf(node);
        }
      }
      cell.masterTag.hidden = !(entry && ports.S.syncCamera && ports.S.referenceId === entry.id);
      cell.position.hidden = !(node && !folder && node.total > 1);
      if (!entry && !folder) {
        cell.box.removeAttribute('data-entry-id');
        cell.box.removeAttribute('data-node-id');
        cell.nameEl.textContent = ''; cell.metaEl.textContent = '';
        cell.position.hidden = true; cell.audit.hidden = true;
        continue;
      }
      if (entry) cell.box.dataset.entryId = entry.id;
      else cell.box.removeAttribute('data-entry-id');
      cell.box.dataset.nodeId = folder ? node.id : entry.id;
      cell.nameEl.textContent = folder ? node.name : entry.name;
      cell.nameEl.title = folder
        ? (node.name + (entry ? ' · 封面 ' + entry.name : ''))
        : ((entry.fullPath || entry.path || entry.name) + ' · 双击重命名');
      cell.nameEl.classList.toggle('is-renamable', !folder);
      cell.dot.style.background = folder ? '' : ports.hexOf(ports.S.theme === 'by-metric' ? ports.metricColor(entry) : entry.color);
      cell.metaEl.textContent = folder ? (node.countText || node.count + ' 份结构') + (node.roleText ? ' · ' + node.roleText : '')
        : ports.LINEAGE.entryText(entry) || ports.metricText(entry) || (entry.parsed ? entry.parsed.residueCount + ' res' : ports.formatLabel(entry));
      cell.metaEl.title = cell.metaEl.textContent;
      if (entry) {
        cell.starBtn.classList.toggle('on', !!entry.star);
        cell.starBtn.setAttribute('aria-pressed', String(!!entry.star));
        cell.starBtn.title = entry.star ? '取消优选标记' : '标记为优选';
        cell.starBtn.setAttribute('aria-label', cell.starBtn.title + '：' + entry.name);
        cell.moreBtn.setAttribute('aria-label', '结构设置：' + entry.name);
        cell.colorInput.value = ports.hexOf(entry.color);
      }
      if (folder) {
        cell.folderLabel.textContent = '进入 · ' + (node.countText || node.count + ' 份结构');
        cell.folderOpen.setAttribute('aria-label', '打开分组 ' + node.name + '，' + (node.countText || node.count + ' 份结构'));
        cell.folderOpen.title = '打开这一层的结构';
        if (window.SB_FOLDER_SHELL && window.SB_FOLDER_SHELL.fit) window.SB_FOLDER_SHELL.fit(cell.box, cell.folderShell);
      } else if (node && node.total > 1) {
        cell.position.textContent = node.pos + '/' + node.total;
        cell.position.title = '当前文件夹中第 ' + node.pos + ' 个模型，共 ' + node.total + ' 个';
      }
    }
  }
  function updateGridAudit(cell) {
    const node = cell.node;
    cell.audit.hidden = true;
    cell.audit.className = 'grid-audit';
    cell.audit.removeAttribute('data-pass');
    cell.audit.removeAttribute('data-total');
    if (!node || node.auditEnabled === false) return;
    try {
      if (node.kind === 'folder') {
        const result = ports.auditFolderNode(node);
        cell.audit.hidden = false;
        if (result.source === 'pending') {
          cell.audit.textContent = '位置 待核对';
          cell.audit.classList.add('pending');
          cell.audit.title = '还有 ' + result.pending + '/' + result.total + ' 个结构未读取坐标（延迟加载中）';
        } else {
          cell.audit.textContent = '位置 ' + result.pass + '/' + result.total;
          cell.audit.dataset.pass = String(result.pass);
          cell.audit.dataset.total = String(result.total);
          cell.audit.classList.toggle('ok', result.pass === result.total);
          cell.audit.classList.toggle('partial', result.pass > 0 && result.pass < result.total);
          cell.audit.title = result.source === 'table' ? '沿用指标表中的位置标记'
            : '沿用当前本地判据：相对封面模型，靶点对齐后 binder CA RMSD ≤ ' + result.threshold + ' Å；不是实验结合验证';
        }
      } else if (node.total > 1) {
        const pose = ports.entryPose(node.entry);
        if (!pose) return;
        cell.audit.hidden = false;
        cell.audit.classList.toggle('ok', !!pose.pass && pose.source !== 'cover');
        cell.audit.classList.toggle('bad', !pose.pass);
        cell.audit.textContent = pose.source === 'cover' ? '封面基准'
          : pose.source === 'table' ? (pose.pass ? '位置符合' : '位置不符')
          : 'Δ' + pose.rmsd.toFixed(2) + ' Å';
        cell.audit.title = pose.source === 'table' ? '沿用指标表中的位置标记'
          : '相对封面 ' + pose.cover + ' 的本地位姿比较；不是实验结合验证';
      }
    } catch (error) {
      cell.audit.hidden = false;
      cell.audit.textContent = '位置未计算';
      cell.audit.title = String(error.message || error);
    }
  }
  function ensureGridCells(n, value) {
    const pane = ports.paneAt(value), S = ports.paneContext(pane);
    const stage = ports.paneElement(pane, 'gridStage');
    if (!stage || pane.disposed) return;
    const act = function (fn) { return ports.withPaneSync(pane, function () {
      ports.setActivePane(pane.index, { sync: false }); return fn();
    }); };
    while (S.gridCells.length < n) {
      const { box, folderTab, head, dot, nameEl, metaEl, masterTag, actions, starBtn, moreBtn, colorInput, starBadge, body, container, folderOpen, folderLabel, folderNote, position, audit, message } = window.SB_UI.createSurface('gridCell');
      const folderShell = (window.SB_FOLDER_SHELL && window.SB_FOLDER_SHELL.make) ? window.SB_FOLDER_SHELL.make() : ports.el('div', 'folder-shell');
      folderShell.hidden = true; box.appendChild(folderShell);
      folderTab.hidden = true;
      folderTab.setAttribute('aria-hidden', 'true');
      masterTag.hidden = true;
      starBtn.type = 'button';
      moreBtn.type = 'button';
      moreBtn.title = '结构设置（重命名 / 序列 / 参考 / 颜色 / 移动 / 删除）';
      moreBtn.setAttribute('aria-haspopup', 'menu');
      colorInput.type = 'color'; colorInput.className = 'sr-color';
      colorInput.setAttribute('tabindex', '-1');
      colorInput.setAttribute('aria-label', '结构颜色');
      starBadge.hidden = true;
      nameEl.addEventListener('dblclick', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (cell.node && cell.node.kind === 'folder') return;
        const entry = cell.entryId && S.entries.find(function (e) { return e.id === cell.entryId; });
        if (entry) act(function () { ports.renameEntry(entry); });
      });
      container.dataset.grid = '1';
      folderOpen.type = 'button'; folderOpen.hidden = true;
      folderNote.className = 'folder-note';
      folderNote.hidden = true;
      folderNote.placeholder = '写标记…';
      folderNote.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
      folderNote.addEventListener('click', function (event) { event.stopPropagation(); });
      folderNote.addEventListener('dblclick', function (event) { event.stopPropagation(); });
      stage.appendChild(box);
      const cell = {
        box: box, container: container, dot: dot, nameEl: nameEl,
        metaEl: metaEl, masterTag: masterTag, viewer: null, entryId: null, ref: null,
        actions: actions, starBtn: starBtn, moreBtn: moreBtn, colorInput: colorInput,
        starBadge: starBadge, folderTab: folderTab, folderOpen: folderOpen, folderLabel: folderLabel,
        folderShell: folderShell, folderNote: folderNote,
        position: position, audit: audit, message: message, node: null, loadedEntryId: null,
      };
      folderNote.addEventListener('input', function () {
        if (cell.node && cell.node.kind === 'folder') act(function () { ports.saveFolderNote(cell.node, folderNote.value); });
      });
      folderOpen.addEventListener('click', function () {
        if (cell.node && cell.node.kind === 'folder') act(function () { ports.openGridFolder(cell.node.id); });
      });
      folderTab.addEventListener('click', function () {
        if (cell.node && cell.node.kind === 'folder') act(function () { ports.openGridFolder(cell.node.id); });
      });
      head.addEventListener('click', function (event) {
        if (event.target.closest('button, input')) return;
        if (cell.node && cell.node.kind === 'folder') act(function () { ports.openGridFolder(cell.node.id); });
      });
      const currentEntry = function () {
        if (cell.node && cell.node.kind === 'folder') return null;
        return S.entries.find(function (e) { return e.id === cell.entryId; });
      };
      starBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        const entry = currentEntry();
        if (entry) act(function () { ports.toggleStar(entry); });
      });
      moreBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        const entry = currentEntry();
        if (entry) act(function () { ports.openEntryMenu(entry, moreBtn, colorInput); });
      });
      colorInput.addEventListener('input', function () {
        const entry = currentEntry();
        if (entry) act(function () { ports.onColorChange(entry, colorInput.value); });
      });
      S.gridCells.push(cell);
    }
    for (let i = 0; i < S.gridCells.length; i++) {
      const c = S.gridCells[i];
      c.box.style.display = i < n ? '' : 'none';
      if (i >= n) {
        c.entryId = null; c.node = null; c.ref = null;
        c.audit.hidden = true; c.position.hidden = true; c.folderOpen.hidden = true;
        if (c.viewer) { try { c.viewer.plugin.animationLoop.stop({ noDraw: true }); } catch (_) {} }
      }
    }
  }
  function rebuildGrid(value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane)) return Promise.resolve();
    return ports.withPaneSync(pane, function () { return rebuildGridInPane(pane); });
  }
  function rebuildGridInPane(pane) {
    const S = ports.paneContext(pane), $ = function (id) { return ports.paneElement(pane, id); };
    if (S.mode !== 'grid') return Promise.resolve();
    const ticket = ports.PANE_RUNTIME.begin(pane, 'grid');
    const config = ports.paneRenderConfig(pane); config.ticket = ticket;
    const valid = function () { return ports.PANE_RUNTIME.current(pane, ticket) && S.mode === 'grid'; };
    const stage = $('gridStage');
    if (!stage) return Promise.resolve();
    stage.className = 'grid-stage' + (S.cols >= 5 ? ' dense' : '');
    updateGridGeometry();
    const layer = ports.gridLayer(), all = layer.nodes;
    const size = ports.pageSize();
    const pages = Math.ceil(all.length / size), maxPage = Math.max(0, pages - 1);
    S.page = Math.max(0, Math.min(S.page, maxPage));
    const slice = all.slice(S.page * size, (S.page + 1) * size);
    const folders = all.filter(function (n) { return n.kind === 'folder'; }).length;
    const total = all.reduce(function (sum, n) { return sum + (n.kind === 'folder' ? n.count : 1); }, 0);
    const layerEntries = all.flatMap(n => n.kind === 'folder' ? n.entries : [n.entry]);
    const summary = (layer.folder ? layer.folder.name + ' · ' : '') + ports.LINEAGE.countText(ports.LINEAGE.summarize(layerEntries));
    $('pageLabel').textContent = (pages ? S.page + 1 : 0) + ' / ' + pages + '  ·  ' + summary;
    $('pageLabel').title = summary;
    const backBtn = $('btnGridBack');
    // 方案 A：检阅台的返回键只剩「回总览」一个语义；从总览进来的镜头或单体都显示。
    backBtn.hidden = !(S.gridFromOverview || S.overviewReturn);
    backBtn.title = '返回总览当前位置（Esc）';
    backBtn.setAttribute('aria-label', '返回总览');
    $('btnPrevPage').disabled = !pages || S.page === 0;
    $('btnNextPage').disabled = !pages || S.page === maxPage;
    ensureGridCells(slice.length);
    const cells = S.gridCells.slice();
    S.gridViewers = [];
    S.gridLoadErrors = [];
    S.gridBusy = true;
    stage.setAttribute('aria-busy', 'true');
    slice.forEach(function (node, i) {
      const c = cells[i];
      c.node = node; c.entryId = (ports.gridNodeEntry(node) || {}).id || ''; c.ref = null;
      c.audit.hidden = true;
      if (node.kind === 'folder') {
        c.container.style.visibility = 'hidden';
        c.message.hidden = true;
        if (c.folderNote) c.folderNote.hidden = false;
      } else {
        c.container.style.visibility = 'hidden';
        c.message.hidden = false; c.message.textContent = '正在载入…';
        if (c.folderNote) c.folderNote.hidden = true;
      }
    });
    arrangeGridCells(pane);
    refreshGridHeaders();
    ports.status(slice.length ? '正在载入 ' + slice.length + ' 个封面/模型…' : '没有符合当前筛选条件的结构');

    // 全部 clear/load 串行化：快速翻页、返回和换模式不会并发写同一个 Viewer。
    const run = async function () {
      if (!valid()) return;
      try {
        for (let i = 0; i < cells.length; i++) {
          if (!valid()) return;
          const cell = cells[i], node = slice[i];
          if (!node) {
            // 分页复用池：即使 loadedEntryId 已因上次失败/取消清空，也必须清掉 viewer 残留状态。
            if (cell.viewer) {
              await ports.clearViewer(cell.viewer);
              cell.loadedEntryId = null;
              try { cell.viewer.plugin.animationLoop.stop({ noDraw: true }); } catch (_) {}
            }
            cell.ref = null;
            cell.container.style.visibility = 'hidden';
            cell.message.hidden = true;
            continue;
          }
          if (node.kind === 'folder') {
            if (cell.viewer && cell.loadedEntryId) {
              await ports.clearViewer(cell.viewer);
              cell.loadedEntryId = null;
              try { cell.viewer.plugin.animationLoop.stop({ noDraw: true }); } catch (_) {}
            }
            cell.ref = null;
            cell.container.style.visibility = 'hidden';
            cell.message.hidden = true;
            if (cell.folderNote) cell.folderNote.hidden = false;
            continue;
          }
          const entry = ports.gridNodeEntry(node);
          try {
            if (!cell.viewer) {
              const viewer = await ports.createViewer(cell.container);
              if (!valid()) { try { viewer.dispose(); } catch (_) {} return; }
              ports.PANE_RUNTIME.own(pane, viewer);
              cell.viewer = viewer;
              ports.attachCameraSync(viewer, pane);
            } else {
              cell.viewer.plugin.animationLoop.start();
              await ports.clearViewer(cell.viewer);
              await ports.sleep(30);
            }
            cell.loadedEntryId = null;
            if (!valid()) return;
            cell.viewer.handleResize();
            cell.viewer.plugin.canvas3d.setProps({ renderer: { backgroundColor: parseInt(ports.canvasBg().slice(1), 16) } });
            const ref = await ports.loadEntryInto(cell.viewer, entry, config);
            if (!valid()) return;
            if (!ref) throw Error('未获得结构引用');
            const item = { id: entry.id, ref: ref, color: entry.color };
            await ports.applyTheme(cell.viewer, [item], config);
            if (config.repr !== 'cartoon') await ports.applyExtraRepresentation(cell.viewer, [item], config);
            if (!valid()) return;
            cell.ref = ref; cell.loadedEntryId = entry.id;
            if (!config.syncCamera) await ports.resetCamera(cell.viewer, undefined, config);
            if (!valid()) return;
            cell.container.style.visibility = '';
            cell.message.hidden = true;
            ports.withPaneSync(pane, function () { updateGridAudit(cell); });
          } catch (error) {
            if (!valid()) return;
            cell.ref = null; cell.loadedEntryId = null;
            cell.message.hidden = false;
            cell.message.textContent = '载入失败：' + (error.message || error);
            S.gridLoadErrors.push({ entryId: entry.id, message: String(error.message || error) });
            console.error('[StructBoard] grid cell failed', entry.name, error);
          }
        }
        if (!valid()) return;
        S.gridViewers = cells.filter(function (c) {
          return c.viewer && c.ref && c.entryId === c.loadedEntryId && c.box.style.display !== 'none';
        }).map(function (c) { return { viewer: c.viewer, entryId: c.entryId, ref: c.ref }; });
        ports.withPaneSync(pane, refreshGridHeaders);
        ports.syncAllCameras(false, pane);
        if (S.syncCamera) setTimeout(function () {
          if (!valid() || performance.now() - pane.runtime.camera.lastUserAt < 700) return;
          ports.syncAllCameras(false, pane);
        }, 400);
        ports.withPaneSync(pane, ports.refreshBadge);
        if (ports.panes[ports.activePane] === pane) ports.status('检阅台 · ' + summary + (S.gridLoadErrors.length ? ' · ' + S.gridLoadErrors.length + ' 个载入失败' : ''));
      } finally {
        if (valid()) { S.gridBusy = false; stage.setAttribute('aria-busy', 'false'); }
      }
    };
    return ports.PANE_RUNTIME.enqueue(pane, 'grid', run, ticket).catch(function (error) {
      if (valid()) { S.gridBusy = false; stage.setAttribute('aria-busy', 'false'); }
      if (!error.cancelled) console.error('[StructBoard] grid rebuild failed', error);
    });
  }
// SERVICE_FUNCTIONS_END
  return { arrangeGridCells, setGridArrangement, updateGridGeometry, resizeGridViewers, disposeGrid, disposePane, refreshGridHeaders, updateGridAudit, ensureGridCells, rebuildGrid, rebuildGridInPane };
}
