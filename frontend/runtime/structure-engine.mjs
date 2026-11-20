// structure-engine: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function viewerOptions(isGrid) {
    return {
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      layoutShowLeftPanel: false,
      layoutShowRemoteState: false,
      collapseLeftPanel: true,
      collapseRightPanel: true,
      viewportShowControls: false,
      viewportShowReset: false,
      viewportShowScreenshotControls: false,
      viewportShowSettings: false,
      viewportShowExpand: false,
      viewportShowToggleFullscreen: false,
      viewportShowSelectionMode: false,
      viewportShowAnimation: false,
      viewportBackgroundColor: ports.canvasBg(),
      pdbProvider: 'rcsb',
    };
  }
  async function createViewer(container) {
    if (!window.molstar || !window.molstar.Viewer) {
      throw new Error('Mol* 脚本未加载，请确认 vendor/molstar.js 存在');
    }
    const viewer = await window.molstar.Viewer.create(container, viewerOptions(container.dataset.grid === '1'));
    try {
      const plugin = viewer.plugin;
      if (plugin && !plugin.canvas3d && plugin.canvas3dInitialized && typeof plugin.canvas3dInitialized.then === 'function') {
        await plugin.canvas3dInitialized;
      }
      return viewer;
    } catch (error) {
      try { viewer.dispose(); } catch (_) {}
      throw error;
    }
  }
  function ensureOverlayViewer(value) {
    const pane = ports.paneAt(value), state = ports.paneContext(pane);
    if (!pane || pane.disposed) return Promise.resolve(null);
    return ports.PANE_RUNTIME.ensureResource(pane, 'overlay', function () {
      const host = ports.paneElement(pane, 'overlayStage');
      if (!host) return null;
      if (!host.firstChild) host.appendChild(ports.el('div'));
      const container = host.firstChild;
      container.style.width = '100%'; container.style.height = '100%';
      return createViewer(container);
    }, function (viewer) {
      state.overlayViewer = viewer;
      attachCameraSync(viewer, pane);
    });
  }
  function paneRenderConfig(value) {
    if (value && value.__sbPaneConfig) return value;
    const pane = ports.paneAt(value), state = ports.paneContext(pane);
    return { __sbPaneConfig: true, pane: pane, life: pane && pane.life,
      aligned: !!state.aligned, referenceId: state.referenceId, theme: state.theme,
      repr: state.repr, syncCamera: state.syncCamera, dark: ports.isDarkTheme(),
      metrics: { primary: ports.rawS.metrics.primary, higher: ports.rawS.metrics.higher,
        range: ports.rawS.metrics.range && Object.assign({}, ports.rawS.metrics.range) } };
  }
  function renderConfigAlive(config) {
    return !!config && ports.PANE_RUNTIME.alive(config.pane) && config.life === config.pane.life &&
      (!config.ticket || ports.PANE_RUNTIME.current(config.pane, config.ticket));
  }
  function requireRenderConfig(config) {
    if (!renderConfigAlive(config)) { const error = Error('Pane job cancelled'); error.cancelled = true; throw error; }
  }
  function alignedRecord(entry, value) {
    const config = paneRenderConfig(value);
    if (!config.aligned || !renderConfigAlive(config) || entry.id === config.referenceId) return null;
    const reference = ports.rawS.entries.find(function (item) { return item.id === config.referenceId; });
    if (!reference || !reference.parsed || !entry.parsed) return null;
    return ports.PANE_RUNTIME.alignmentFor(config.pane, entry, reference, function (mov, ref) {
      const transform = ports.ALIGN.compute(ref.parsed, mov.parsed);
      const data = transform ? ports.ALIGN.toAlignedPdb(mov.parsed, transform) : null;
      return data ? { data: data, info: { rmsd: transform.rmsd, n: transform.n, mode: transform.mode },
        fingerprint: ports.contentFingerprint(data) } : null;
    });
  }
  function renderMetricColor(entry, config) {
    const metrics = config.metrics, val = entry && entry.metrics && entry.metrics[metrics.primary];
    return metrics.range && Number.isFinite(val)
      ? ports.METRICS.colorScale(val, metrics.range.min, metrics.range.max, metrics.higher) : 0x8b98a5;
  }
  function structuresOf(viewer) {
    try { return viewer.plugin.managers.structure.hierarchy.current.structures.slice(); }
    catch (e) { return []; }
  }
  function refKey(ref) { return ref && ref.cell && ref.cell.transform ? ref.cell.transform.ref : ''; }
  async function waitForNewStructure(viewer, before) {
    for (let i = 0; i < 24; i++) {
      const now = structuresOf(viewer);
      const added = now.find(function (s) { return !before.has(refKey(s)); });
      if (added) return added;
      await ports.sleep(30);
    }
    return null;
  }
  function activeData(entry, value) { const record = alignedRecord(entry, value); return record ? record.data : entry.data; }
  function activeFormat(entry, value) {
    if (alignedRecord(entry, value)) return 'pdb';
    return entry.format === 'bcif' ? 'mmcif' : (entry.format || 'pdb');
  }
  async function ensureEntryLoaded(entry) {
    if (!entry || entry.data || entry.isUrl || !entry.fetchUrl) return;
    if (!entry._load) {
      entry._load = (async function () {
        const r = await fetch(entry.fetchUrl, { cache: 'no-store' });
        if (!r.ok) throw new Error('读取结构失败');
        const physicalName = String(entry.fullPath || entry.path || entry.name).replace(/\\/g, '/').split('/').pop();
        const raw = await ports.IO.readFile(new File([await r.arrayBuffer()], physicalName));
        entry.data = raw.data;
        entry.format = raw.format || entry.format;
        entry.isBinary = !!raw.isBinary;
        entry.parsed = ports.IO.parse(entry.data, entry.format);
        entry.size = entry.size || raw.size || (entry.data ? String(entry.data).length : 0);
      })().catch(function (err) { entry._load = null; throw err; });
    }
    await entry._load;
  }
  async function loadEntryInto(viewer, entry, value, isCurrent) {
    const config = paneRenderConfig(value);
    const check = function () {
      requireRenderConfig(config);
      if (isCurrent && !isCurrent()) throw new DOMException('视野已切换', 'AbortError');
    };
    check();
    await ensureEntryLoaded(entry);
    check();
    if (config.aligned && entry.id !== config.referenceId) {
      const reference = ports.rawS.entries.find(function (item) { return item.id === config.referenceId; });
      if (reference) await ensureEntryLoaded(reference);
      check();
    }
    const record = alignedRecord(entry, config);
    const before = new Set(structuresOf(viewer).map(refKey));
    const data = record ? record.data : entry.data;
    const format = record ? 'pdb' : (entry.format === 'bcif' ? 'mmcif' : (entry.format || 'pdb'));
    if (entry.isUrl) {
      await viewer.loadStructureFromUrl(entry.url, format, false, { label: entry.name });
    } else if (entry.format === 'bcif' && !record) {
      const url = URL.createObjectURL(new Blob([data]));
      try { await viewer.loadStructureFromUrl(url, 'mmcif', true, { label: entry.name }); }
      finally { URL.revokeObjectURL(url); }
    } else {
      await viewer.loadStructureFromData(data, format, { dataLabel: entry.name });
    }
    check();
    const ref = await waitForNewStructure(viewer, before);
    check();
    if (!ref) throw new Error('结构解析后没有生成可显示的模型');
    return ref;
  }
  async function applyTheme(viewer, items, value) {
    const config = paneRenderConfig(value);
    if (!renderConfigAlive(config)) return;
    const cm = viewer.plugin.managers.structure.component;
    if (!cm) return;
    if (config.theme === 'per-structure' || config.theme === 'by-metric') {
      for (const it of items) {
        if (!renderConfigAlive(config)) return;
        if (!it.ref || !it.ref.components || !it.ref.components.length) continue;
        const entry = ports.rawS.entries.find(function (e) { return e.id === it.id; });
        const color = config.theme === 'by-metric' ? renderMetricColor(entry, config) : it.color;
        try {
          await cm.updateRepresentationsTheme(it.ref.components, {
            color: 'uniform', colorParams: { value: color },
          });
        } catch (e) { console.warn('[StructBoard] theme failed', e); }
      }
    } else {
      const comps = items.reduce(function (a, it) {
        return it.ref && it.ref.components ? a.concat(it.ref.components) : a;
      }, []);
      if (!comps.length) return;
      try { await cm.updateRepresentationsTheme(comps, { color: config.theme }); }
      catch (e) { console.warn('[StructBoard] theme failed', e); }
    }
  }
  function allViewers(value) {
    const targets = value == null ? ports.panes.filter(ports.PANE_RUNTIME.alive) : [ports.paneAt(value)];
    const out = [];
    for (const pane of targets) {
      if (!ports.PANE_RUNTIME.alive(pane)) continue;
      const state = pane.view;
      if (state.overlayViewer) out.push(state.overlayViewer);
      for (const cell of state.gridCells) {
        if (cell.viewer && cell.ref && cell.entryId === cell.loadedEntryId && cell.box.style.display !== 'none') out.push(cell.viewer);
      }
    }
    return out;
  }
  function cameraSnapshot(v) {
    try { return v.plugin.canvas3d.camera.getSnapshot(); } catch (e) { return null; }
  }
  function cameraFingerprint(s) {
    const n = function (v) { return typeof v === 'number' ? v.toFixed(3) : '0'; };
    return [].concat(s.position || [], s.target || [], s.up || []).map(n).join(',') +
      '|' + n(s.radius) + '|' + n(s.fov);
  }
  function applyCameraSnapshot(v, snap) {
    if (!snap) return;
    // radius 会被每个视窗自己的 radiusMax 夹住，放宽上限保证缩放一致
    const state = Object.assign({}, snap, {
      radiusMax: Math.max(snap.radiusMax || 0, snap.radius || 0) * 1.1 + 1,
    });
    v.__sbCamIgnoreUntil = performance.now() + 90;
    v.__sbCamFp = cameraFingerprint(state);   // 自己设的值记成基线，避免回环
    try { v.plugin.canvas3d.camera.setState(state); } catch (e) { /* ignore */ }
  }
  function broadcastCamera(source, snap, value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane)) return;
    const state = pane.view, camera = pane.runtime.camera;
    if (!state.syncCamera || camera.syncing || !snap || state.gridBusy) return;
    if (state.mode === 'grid' && !state.gridViewers.some(function (g) { return g.viewer === source; })) return;
    camera.syncing = true;
    try {
      for (const viewer of allViewers(pane)) if (viewer !== source) applyCameraSnapshot(viewer, snap);
      state.lastCamera = ports.PANE_RUNTIME.copy(snap);
    } finally { camera.syncing = false; }
  }
  function attachCameraSync(viewer, value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane) || viewer.__sbCameraPane === pane) return;
    viewer.__sbCameraPane = pane;
    const state = pane.view, camera = pane.runtime.camera, life = pane.life;
    const subscriptions = [];
    const alive = function () { return ports.PANE_RUNTIME.alive(pane) && pane.life === life; };
    try {
      const cam = viewer.plugin.canvas3d.camera;
      if (!cam) return;
      const handle = function () {
        if (!alive() || !state.syncCamera || camera.syncing || state.gridBusy) return;
        if (state.mode === 'grid' && !state.gridViewers.some(function (g) { return g.viewer === viewer; })) return;
        if (state.mode !== 'grid' && (state.mode !== 'overlay' || state.overlayViewer !== viewer)) return;
        const snap = cameraSnapshot(viewer);
        if (!snap) return;
        const fp = cameraFingerprint(snap), previous = viewer.__sbCamFp;
        viewer.__sbCamFp = fp;
        if (previous === undefined || previous === fp || performance.now() < (viewer.__sbCamIgnoreUntil || 0)) return;
        camera.lastUserAt = performance.now();
        state.lastCamera = ports.PANE_RUNTIME.copy(snap);
        camera.pending = { source: viewer, snap: snap };
        if (camera.raf) return;
        camera.raf = requestAnimationFrame(function () {
          camera.raf = 0;
          const pending = camera.pending; camera.pending = null;
          if (alive() && pending) broadcastCamera(pending.source, pending.snap, pane);
        });
      };
      if (cam.changed && typeof cam.changed.subscribe === 'function') subscriptions.push(cam.changed.subscribe(handle));
      if (cam.stateChanged && typeof cam.stateChanged.subscribe === 'function') {
        let first = true;
        subscriptions.push(cam.stateChanged.subscribe(function () {
          if (first) { first = false; return; }
          handle();
        }));
      }
      ports.PANE_RUNTIME.addCleanup(pane, function () {
        subscriptions.forEach(function (sub) { if (sub && sub.unsubscribe) sub.unsubscribe(); });
        if (camera.raf) cancelAnimationFrame(camera.raf);
        camera.raf = 0; camera.pending = null;
      });
    } catch (e) { console.warn('[StructBoard] camera sync attach failed', e); }
  }
  function syncAllCameras(force, value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane)) return;
    const state = pane.view, camera = pane.runtime.camera;
    if (!state.syncCamera && !force) return;
    const list = allViewers(pane);
    if (!list.length) return;
    const visible = function (cell) {
      return cell.viewer && cell.ref && cell.entryId === cell.loadedEntryId && cell.box.style.display !== 'none';
    };
    const master = state.gridCells.find(function (cell) { return visible(cell) && cell.entryId === state.referenceId; });
    const first = master || state.gridCells.find(visible);
    const source = state.mode === 'grid' && first ? first.viewer : state.overlayViewer;
    const snap = (source && cameraSnapshot(source)) || state.lastCamera;
    if (!snap) return;
    camera.syncing = true;
    try { for (const viewer of list) applyCameraSnapshot(viewer, snap); }
    finally { camera.syncing = false; }
    state.lastCamera = ports.PANE_RUNTIME.copy(snap);
  }
  async function resetCamera(viewer, durationMs, value) {
    const config = paneRenderConfig(value);
    if (!renderConfigAlive(config) || !viewer) return;
    try { await viewer.plugin.managers.camera.reset(undefined, durationMs); }
    catch (e) {
      if (renderConfigAlive(config)) try { viewer.plugin.canvas3d.requestCameraReset({ durationMs: durationMs }); } catch (e2) { /* ignore */ }
    }
  }
  async function clearViewer(viewer) {
    try { await viewer.plugin.clear(false); }
    catch (e) { console.warn('[StructBoard] clear failed', e); }
  }
  function rebuildOverlay(showBusy, value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane) || pane.view.mode !== 'overlay') return Promise.resolve();
    const state = ports.paneContext(pane), ticket = ports.PANE_RUNTIME.begin(pane, 'overlay');
    const config = paneRenderConfig(pane); config.ticket = ticket;
    const all = ports.withPaneSync(pane, function () {
      return state.gridFromOverview && !state.soloId
        ? ports.gridLayer().nodes.map(ports.gridNodeEntry).filter(Boolean) : ports.visibleEntries();
    });
    const list = all.slice(0, state.maxOverlay > 0 ? state.maxOverlay : all.length);
    const valid = function () { return ports.PANE_RUNTIME.current(pane, ticket) && state.mode === 'overlay'; };
    return ports.PANE_RUNTIME.enqueue(pane, 'overlay', async function () {
      const viewer = await ensureOverlayViewer(pane);
      if (!valid() || !viewer) return;
      if (showBusy && ports.panes[ports.activePane] === pane) ports.status('正在载入结构…');
      viewer.plugin.animationLoop.start();
      await clearViewer(viewer);
      if (!valid()) return;
      state.overlayRefs = []; state.overlaySkipped = all.length - list.length;
      for (let i = 0; i < list.length; i++) {
        if (!valid()) return;
        const entry = list[i];
        try {
          const ref = await loadEntryInto(viewer, entry, config);
          if (!valid()) return;
          state.overlayRefs.push({ id: entry.id, ref: ref, color: entry.color });
        } catch (error) {
          if (!valid()) return;
          console.error('[StructBoard] load failed', entry.name, error);
          if (ports.panes[ports.activePane] === pane) ports.note('载入失败：' + entry.name + ' — ' + (error.message || error), true);
        }
        if (i % 4 === 3) {
          if (ports.panes[ports.activePane] === pane) ports.status('正在载入 ' + (i + 1) + ' / ' + list.length + ' …');
          await ports.sleep(0);
        }
      }
      if (!valid()) return;
      if (list.length) await applyTheme(viewer, state.overlayRefs, config);
      if (!valid()) return;
      if (config.repr !== 'cartoon') await applyExtraRepresentation(viewer, state.overlayRefs, config);
      if (!valid()) return;
      await resetCamera(viewer, undefined, config);
      if (!valid()) return;
      syncAllCameras(false, pane);
      ports.withPaneSync(pane, ports.refreshBadge);
      if (ports.panes[ports.activePane] === pane) ports.status('叠加视图 · ' + state.overlayRefs.length + ' / ' + all.length + ' 个可见' +
        (state.overlaySkipped ? '（其余 ' + state.overlaySkipped + ' 个用分屏或单独查看）' : '') +
        ' · 共 ' + ports.rawS.entries.length + ' 个结构');
    }, ticket).catch(function (error) {
      if (valid() && !error.cancelled) console.error('[StructBoard] overlay rebuild failed', error);
    });
  }
  function appendToOverlay(entry, value) {
    // A rebuild shares the pane queue and preserves the overlay budget / scope semantics.
    if (!entry.visible) return Promise.resolve();
    return rebuildOverlay(false, ports.paneAt(value));
  }
  async function applyExtraRepresentation(viewer, items, value) {
    const config = paneRenderConfig(value), cm = viewer.plugin.managers.structure.component;
    if (!cm) return;
    for (const it of items) {
      if (!renderConfigAlive(config)) return;
      if (!it.ref || !it.ref.components || !it.ref.components.length) continue;
      try { await cm.addRepresentation(it.ref.components, config.repr); }
      catch (e) { console.warn('[StructBoard] addRepresentation failed', e); }
    }
  }
  function setOverlayVisibility(entry, value) {
    return rebuildOverlay(false, ports.paneAt(value));
  }
  function refreshAlignBtn(value) {
    const pane = typeof ports.paneAt === 'function' ? ports.paneAt(value) : null;
    const state = pane ? ports.paneContext(pane) : ports.S;
    const b = pane ? ports.paneElement(pane, 'btnAlign') : ports.$('btnAlign');
    if (!b) return;
    const config = pane ? paneRenderConfig(pane) : null;
    const rmsds = state.entries.map(function (e) {
      const record = config && state.aligned ? alignedRecord(e, config) : null;
      const info = config ? record && record.info : e.alignInfo;
      return info ? info.rmsd : null;
    }).filter(Number.isFinite);
    const mean = rmsds.length
      ? rmsds.reduce(function (a, x) { return a + x; }, 0) / rmsds.length : null;
    const aligned = !!state.aligned;
    const label = aligned ? '已对齐' : '对齐';
    const tooltip = aligned
      ? '已对齐到参考' + (mean === null ? '' : ' · RMSD ' + mean.toFixed(2) + ' Å') + '（点击还原原始坐标）'
      : '对齐到参考 · 参考结构保持原位，其余结构按 CA 原子刚体叠加';
    const update = function (button, text) {
      button.classList.toggle('active', aligned);
      button.setAttribute('aria-pressed', String(aligned));
      button.title = tooltip;
      button.querySelector('span').textContent = text;
    };
    update(b, label);
    const menuButton = b.closest('.bench-toolbar').querySelector('[data-action="btnAlign"]');
    if (menuButton) update(menuButton, aligned
      ? label + (mean === null ? '' : ' · RMSD ' + mean.toFixed(2) + ' Å') : '对齐到参考');
    ports.resizeGridViewers();
  }
  function toggleAlign(value) {
    const pane = ports.paneAt(value);
    if (!ports.PANE_RUNTIME.alive(pane) || !ports.rawS.entries.length || pane.runtime.alignBusy) return Promise.resolve();
    const state = ports.paneContext(pane);
    if (state.aligned) {
      ports.PANE_RUNTIME.invalidate(pane, 'align');
      pane.runtime.alignment.clear(); state.aligned = false;
      ports.withPaneSync(pane, function () {
        if (ports.panes[ports.activePane] === pane) ports.renderList();
        refreshAlignBtn(pane); ports.applyModeChange(true, pane);
      });
      ports.toast('已还原原始坐标');
      return Promise.resolve();
    }
    const ref = ports.rawS.entries.find(function (entry) { return entry.id === state.referenceId; }) || ports.rawS.entries[0];
    state.referenceId = ref.id;
    const ticket = ports.PANE_RUNTIME.begin(pane, 'align'), config = paneRenderConfig(pane);
    config.aligned = true; config.ticket = ticket;
    pane.runtime.alignBusy = true;
    const valid = function () { return ports.PANE_RUNTIME.current(pane, ticket) && state.referenceId === ref.id; };
    const scope = ports.withPaneSync(pane, function () {
      const visible = ports.visibleEntries();
      if (state.mode === 'overlay' && state.maxOverlay > 0) return visible.slice(0, state.maxOverlay);
      if (state.mode === 'grid') {
        const nodes = ports.gridLayer().nodes, size = ports.pageSize();
        return nodes.slice(state.page * size, (state.page + 1) * size).map(ports.gridNodeEntry).filter(Boolean);
      }
      const current = pane.overview && pane.overview.current ? pane.overview.current() : null;
      if (state.mode === 'overview' && current && current.entries) return current.entries.slice();
      return visible.length > 60 ? visible.filter(function (entry) { return !!entry.parsed; }) : visible;
    });
    return ports.PANE_RUNTIME.enqueue(pane, 'align', async function () {
      try {
        if (!valid()) return;
        if (!ref.parsed && !ref.isUrl && ref.fetchUrl) {
          if (ports.panes[ports.activePane] === pane) ports.status('正在读取参考结构 ' + ref.name + '…');
          await ensureEntryLoaded(ref);
        }
        if (!valid()) return;
        if (!ref.parsed || !ports.ALIGN.caAtoms(ref.parsed).length) {
          ports.toast('参考结构无法解析 CA 原子（BinaryCIF / 远程结构不支持对齐）', true); return;
        }
        const needLoad = scope.filter(function (entry) { return entry.id !== ref.id && !entry.parsed && !entry.isUrl && entry.fetchUrl; });
        let cursor = 0, done = 0;
        const worker = async function () {
          while (valid() && cursor < needLoad.length) {
            const entry = needLoad[cursor++];
            try { await ensureEntryLoaded(entry); } catch (_) {}
            if (!valid()) return;
            done++;
            if (ports.panes[ports.activePane] === pane) ports.status('正在读取结构用于对齐 (' + done + '/' + needLoad.length + ')…');
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, needLoad.length) }, worker));
        if (!valid()) return;
        let ok = 0, skipped = 0;
        for (const entry of ports.rawS.entries) {
          if (entry.id === ref.id || !entry.parsed) {
            if (entry.id !== ref.id && scope.indexOf(entry) >= 0) skipped++;
            continue;
          }
          if (alignedRecord(entry, config)) ok++; else skipped++;
        }
        const pending = ports.rawS.entries.some(function (entry) { return entry.id !== ref.id && !entry.parsed && !entry.isUrl && entry.fetchUrl; });
        if (!ok && !pending) { ports.toast('没有可对齐的结构（每个结构至少需要 4 个 CA 原子）', true); return; }
        if (!valid()) return;
        state.aligned = true;
        ports.withPaneSync(pane, function () {
          if (ports.panes[ports.activePane] === pane) ports.renderList();
          refreshAlignBtn(pane); ports.applyModeChange(true, pane);
        });
        ports.toast(ok ? '参考 ' + ref.name + ' 保持原位，' + ok + ' 个结构按 CA 叠到它' +
          (skipped ? '，跳过 ' + skipped + ' 个' : '') + '（仅视图，原文件不变）'
          : '参考 ' + ref.name + ' 已就绪；其余未读取结构将在浏览时自动按 CA 对齐');
      } catch (error) {
        if (valid()) ports.toast('读取参考结构失败：' + (error.message || error), true);
      } finally {
        pane.runtime.alignBusy = false;
        if (ports.PANE_RUNTIME.alive(pane) && typeof ports.syncPaneControls === 'function') ports.syncPaneControls(pane);
      }
    }, ticket);
  }
// SERVICE_FUNCTIONS_END
  return { viewerOptions, createViewer, ensureOverlayViewer, paneRenderConfig, renderConfigAlive, requireRenderConfig, alignedRecord, renderMetricColor, structuresOf, refKey, waitForNewStructure, activeData, activeFormat, ensureEntryLoaded, loadEntryInto, applyTheme, allViewers, cameraSnapshot, cameraFingerprint, applyCameraSnapshot, broadcastCamera, attachCameraSync, syncAllCameras, resetCamera, clearViewer, rebuildOverlay, appendToOverlay, applyExtraRepresentation, setOverlayVisibility, refreshAlignBtn, toggleAlign };
}
