import { refreshMemberships } from '../application/membership-refresh.mjs';
// workspace-state: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function pipelineWorkspaceKey(pipelineId, windowKey) {
    return 'workspace:' + (windowKey || ports.workspaceWindowKey) + ':' + (!pipelineId || pipelineId === '__local__' ? 'local' : pipelineId);
  }
  function isLocalWorkspaceTab(id) {
    return id === '__local__' || (typeof id === 'string' && id.startsWith('local:'));
  }
  function pipelineViewStateKey(pipelineId, windowKey) {
    return 'structboard.pipelineView.' + (windowKey || ports.workspaceWindowKey) + '.' + (!pipelineId || pipelineId === '__local__' ? 'local' : pipelineId);
  }
  function pipelineFolderWorkspaceId(pipelineId, windowKey) {
    return 'sb-folder-' + (windowKey || ports.workspaceWindowKey) + '-' + (pipelineId || 'local').replace(/[^A-Za-z0-9_-]/g, '_');
  }
  function rekeyFolderDrafts(snapshot, pipelineId, windowKey) {
    const next = pipelineFolderWorkspaceId(pipelineId, windowKey), old = snapshot.workspaceId || '', result = Object.create(null);
    Object.keys(snapshot.folderEdits || {}).forEach(function (key) {
      let ids; try { ids = JSON.parse(key); } catch (_) { return; }
      if (!Array.isArray(ids) || ids.length !== 3 || ids[0] !== old) return;
      const target = JSON.stringify([next, ids[1], ids[2]]);
      result[target] = Object.assign({}, snapshot.folderEdits[key], { workspaceId: next, key: target });
    });
    snapshot.workspaceId = next; snapshot.folderEdits = result;
    const prefix = String(pipelineId || '') + ':';
    const localSteps = new Set((snapshot.customSteps || []).map(function (step) { return step.key; }));
    (snapshot.entries || []).forEach(function (entry) { if (entry.stepKey) localSteps.add(entry.stepKey); });
    snapshot.stepEdits = Object.fromEntries(Object.entries(snapshot.stepEdits || {}).filter(([key]) =>
      isLocalWorkspaceTab(pipelineId) ? localSteps.has(key) : key.startsWith(prefix)));
    snapshot.notesPending = pipelineId && snapshot.notesPending && snapshot.notesPending[pipelineId]
      ? { [pipelineId]: snapshot.notesPending[pipelineId] } : {};
    return snapshot;
  }
  function openSessionDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(ports.SESSION_DB, window.SB_SESSION_STORE.VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(ports.SESSION_STORE)) db.createObjectStore(ports.SESSION_STORE);
        if (!db.objectStoreNames.contains('entry-data')) db.createObjectStore('entry-data');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function idbGet(key) {
    try {
      const db = await openSessionDB();
      if (!db) return null;
      return await new Promise(function (resolve) {
        const tx = db.transaction(ports.SESSION_STORE, 'readonly');
        const req = tx.objectStore(ports.SESSION_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); db.close(); };
        req.onerror = function () { resolve(null); db.close(); };
      });
    } catch (_) { return null; }
  }
  async function idbSet(key, val) {
    const db = await openSessionDB();
    if (!db) throw Error('当前环境不支持本地保存');
    try {
      await new Promise(function (resolve, reject) {
        const tx = db.transaction(ports.SESSION_STORE, 'readwrite');
        tx.objectStore(ports.SESSION_STORE).put(val, key);
        tx.oncomplete = resolve;
        tx.onabort = function () { reject(tx.error || Error('工作区备份写入失败')); };
        tx.onerror = function () {};
      });
    } finally { db.close(); }
  }
  async function idbDel(key) {
    try {
      const db = await openSessionDB();
      if (!db) return;
      await new Promise(function (resolve) {
        const tx = db.transaction(ports.SESSION_STORE, 'readwrite');
        tx.objectStore(ports.SESSION_STORE).delete(key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); resolve(); };
      });
    } catch (_) { /* ignore */ }
  }
  function loadLastSessionMeta() {
    try {
      return JSON.parse(localStorage.getItem(ports.LAST_SESSION_KEY) ||
        (ports.workspaceWindowKey === 'main' ? localStorage.getItem(ports.LEGACY_LAST_SESSION_KEY) : null) || 'null');
    } catch (_) { return null; }
  }
  function saveLastSessionMeta() {
    if (ports.S.restoringSession) return;
    if (/[?&](autodemo|testaf3)=1/.test(location.search)) return;
    const pid = ports.activePipelineId();
    const hasEntries = ports.S.entries.length > 0 || (ports.S.customSteps && ports.S.customSteps.length > 0);
    if (!pid && !hasEntries && !ports.S.localWorkspaceId) return;
    const ref = ports.S.entries.find(function (e) { return e.id === ports.S.referenceId; });
    const meta = {
      pipelineId: pid || '',
      workspaceTabId: currentWorkspaceTabId(),
      pipelineName: ports.rawS.activePipelineName || '',
      mode: ports.S.mode || 'overview',
      activeGroupId: ports.S.activeGroupId || 'all',
        referenceKey: ref ? ports.entryOrgKey(ref) : '',
      updatedAt: Date.now(),
    };
    try { localStorage.setItem(ports.LAST_SESSION_KEY, JSON.stringify(meta)); } catch (_) { /* ignore */ }
  }
  function buildLocalSnapshot(workspace) {
    workspace = workspace || ports.S;
    const isLiveWorkspace = workspace === ports.S || workspace === ports.rawS;
    // 管线 lazy 条目只存元数据 + fetchUrl（不存 PDB 正文），重启直接灌回，避免再走「读取管线」整盘扫描
    const localEntries = [];
    for (const e of workspace.entries) {
      const lazyPipe = !!(e.lazy && (e.pipelineId || e.fetchUrl));
      localEntries.push({
        name: e.name,
        data: lazyPipe ? '' : (e.data || ''),
        format: e.format || 'pdb',
        isBinary: !!e.isBinary,
        isUrl: !!e.isUrl,
        url: e.url || '',
        size: e.size || 0,
        path: e.path || e.name,
        fullPath: e.fullPath || '',
        sourceKey: e.sourceKey || null,
        fileKey: e.fileKey || null,
        group: e.group || null,
        modelIndex: e.modelIndex,
        ...ports.LINEAGE.meta(e),
        renamed: !!e.renamed,
        color: e.color,
        sessionMembershipVersion: e.sessionMembershipVersion || 0,
        star: !!e.star,
        starManual: !!e.starManual,
        lazy: !!e.lazy || lazyPipe,
        fetchUrl: e.fetchUrl || '',
        stepKey: e.stepKey || '',
        stepIndex: e.stepIndex || 0,
        stepTitle: e.stepTitle || '',
        stepTool: e.stepTool || '',
        pipelineId: e.pipelineId || '',
        metrics: e.metrics || null,
        visible: e.visible !== false,
      });
    }
    const idToKey = new Map(workspace.entries.map(function (e) { return [e.id, ports.entryOrgKey(e)]; }));
    const localGroups = workspace.groups.map(function (g) {
      return {
        name: g.name,
        keys: g.entryIds.map(function (id) { return idToKey.get(id); }).filter(Boolean),
        pipelineKey: g.pipelineKey || '',
        stepIndex: Number.isFinite(g.stepIndex) ? g.stepIndex : undefined,
      };
    });
    return { entries: localEntries, groups: localGroups, savedAt: Date.now(),
      membershipVersion: window.SB_SESSION_MIGRATION.VERSION,
      customSteps: JSON.parse(JSON.stringify(workspace.customSteps || [])),
      activePipelineName: workspace.activePipelineName || '',
      viewState: isLiveWorkspace ? captureWorkspaceViewState() : null,
      stepEdits: isLiveWorkspace
        ? Object.fromEntries(Object.entries(ports.loadStepEdits()).filter(([key]) => !workspace.activePipelineId || key.startsWith(workspace.activePipelineId + ':')))
        : Object.fromEntries(Object.entries(ports.loadStepEdits()).filter(([key]) => String(key).startsWith(String(workspace.activePipelineId || '') + ':'))),
      workspaceId: isLiveWorkspace ? ports.folderEditStore.workspaceId : pipelineFolderWorkspaceId(workspace.activePipelineId),
      folderEdits: isLiveWorkspace ? ports.folderEditStore.snapshot() : {},
      notesPending: (function () {
        const pending = ports.notesSync.snapshot();
        return workspace.activePipelineId && pending[workspace.activePipelineId]
          ? { [workspace.activePipelineId]: pending[workspace.activePipelineId] } : {};
      })(),
      activePipelineId: workspace.activePipelineId || '',
      localWorkspaceId: workspace.localWorkspaceId || '',
      metricsState: JSON.parse(JSON.stringify(workspace.metrics || null)),
      autoScoreRows: JSON.parse(JSON.stringify(workspace.autoScoreRows || [])),
      definitionFingerprints: Object.assign({}, workspace.definitionFingerprints || {}),
      organization: JSON.parse(JSON.stringify(workspace.organization || {})),
      trashFolders: JSON.parse(JSON.stringify(workspace.trashFolders || [])),
      trashSteps: JSON.parse(JSON.stringify(workspace.trashSteps || [])) };
  }
  function stableGroupKey(workspace, groupId) {
    const group = (workspace.groups || []).find(function (item) { return item.id === groupId; });
    return group ? (group.pipelineKey ? 'pipeline:' + group.pipelineKey : 'group:' + group.name) : 'all';
  }
  function captureWorkspaceViewState() {
    const entryById = new Map(ports.S.entries.map(e => [e.id, e]));
    const viewPanes = ports.panes.filter(ports.PANE_RUNTIME.alive).map(function (pane) {
      return ports.withPaneSync(pane, function () {
        const reference = ports.S.entries.find(function (entry) { return entry.id === ports.S.referenceId; });
        const overview = pane.overview;
        return {
          mode: ports.S.mode, filter: ports.S.filter || '', starOnly: !!ports.S.starOnly,
          activeGroupKey: stableGroupKey(ports.rawS, ports.S.activeGroupId),
          referenceKey: reference ? ports.entryOrgKey(reference) : '',
          theme: ports.S.theme, repr: ports.S.repr, cols: ports.S.cols, rows: ports.S.rows, page: ports.S.page,
          gridDrill: ports.S.gridDrill || null, gridParentPage: ports.S.gridParentPage || 0,
          gridArrangement: ports.S.gridArrangement || 'candidate',
          gridPinnedKeys: (ports.S.gridPinned || []).map(id => entryById.get(id)).filter(Boolean).map(ports.entryOrgKey),
          gridFromOverview: ports.S.gridFromOverview || null, overviewReturn: ports.S.overviewReturn || null,
          syncCamera: !!ports.S.syncCamera, overviewGrouped: !!ports.S.overviewGrouped,
          overviewPlace: overview && overview.capture ? overview.capture() : null,
          overviewSearch: overview && overview.searchStats ? overview.searchStats().query : '',
        };
      });
    });
    return { activePane: ports.activePane, panes: viewPanes };
  }
  function savePipelineViewNow() {
    clearTimeout(ports.pipelineViewSaveTimer);
    ports.pipelineViewSaveTimer = 0;
    const id = currentWorkspaceTabId();
    if (!id || ports.rawS.restoringSession || /[?&](autodemo|testaf3)=1/.test(location.search)) return;
    try { localStorage.setItem(pipelineViewStateKey(id), JSON.stringify(captureWorkspaceViewState())); } catch (_) {}
  }
  function schedulePipelineViewSave() {
    if (ports.rawS.restoringSession) return;
    clearTimeout(ports.pipelineViewSaveTimer);
    ports.pipelineViewSaveTimer = setTimeout(savePipelineViewNow, 650);
  }
  function loadPipelineViewState(pipelineId) {
    try { return JSON.parse(localStorage.getItem(pipelineViewStateKey(pipelineId)) || 'null'); } catch (_) { return null; }
  }
  function restoreWorkspaceViewState(saved) {
    if (!saved || !Array.isArray(saved.panes)) return;
    if (saved.panes.length > 1 && !ports.splitState.active) ports.splitOn();
    else if (saved.panes.length < 2 && ports.splitState.active) ports.splitOff();
    saved.panes.forEach(function (view, index) {
      const pane = ports.panes[index];
      if (!pane || pane.disposed || !view) return;
      ports.withPaneSync(pane, function () {
        ports.S.mode = ['overview', 'grid', 'overlay'].indexOf(view.mode) >= 0 ? view.mode : 'overview';
        ports.S.filter = String(view.filter || ''); ports.S.starOnly = !!view.starOnly;
        ports.S.theme = view.theme || ports.S.theme; ports.S.repr = view.repr || ports.S.repr;
        ports.S.cols = Number.isFinite(view.cols) ? view.cols : ports.S.cols;
        ports.S.rows = Number.isFinite(view.rows) ? view.rows : ports.S.rows;
        ports.S.page = Number.isFinite(view.page) ? Math.max(0, view.page) : 0;
        ports.S.gridDrill = typeof view.gridDrill === 'string' ? view.gridDrill : null;
        ports.S.gridParentPage = Number.isFinite(view.gridParentPage) ? Math.max(0, view.gridParentPage) : 0;
        ports.S.gridArrangement = view.gridArrangement === 'flat' ? 'flat' : 'candidate';
        const byKey = new Map(ports.S.entries.map(e => [ports.entryOrgKey(e), e.id]));
        ports.S.gridPinned = (view.gridPinnedKeys || []).map(key => byKey.get(key)).filter(Boolean);
        ports.S.gridFromOverview = view.gridFromOverview || null;
        ports.S.overviewReturn = view.overviewReturn || null;
        ports.S.syncCamera = view.syncCamera !== false;
        ports.S.overviewGrouped = view.overviewGrouped !== false;
        const group = ports.rawS.groups.find(function (item) { return stableGroupKey(ports.rawS, item.id) === view.activeGroupKey; });
        ports.S.activeGroupId = group ? group.id : 'all';
        const reference = ports.rawS.entries.find(function (entry) { return ports.entryOrgKey(entry) === view.referenceKey; });
        ports.S.referenceId = reference ? reference.id : null;
      });
    });
    ports.activePane = Math.max(0, Math.min(Number.isInteger(saved.activePane) ? saved.activePane : 0, ports.panes.length - 1));
    ports.overview = (ports.panes[ports.activePane] || {}).overview || null;
    const searchInput = ports.$('searchInput');
    if (searchInput) searchInput.value = ports.S.filter || '';
  }
  function showSessionSaveState(state, error) {
    document.documentElement.dataset.sessionSave = state;
    document.documentElement.dataset.sessionSaveError = error || '';
    const badge = ports.$('sessionSaveState');
    if (!badge) return;
    badge.dataset.state = state;
    badge.dataset.visible = state === 'idle' ? 'false' : 'true';
    badge.setAttribute('aria-busy', String(state === 'saving'));
    const label = badge.querySelector('.session-save-label');
    const icon = badge.querySelector('.session-save-icon');
    if (label) label.textContent = state === 'saving' ? '工作区保存中…'
      : state === 'error' ? '工作区保存失败' : state === 'idle' ? '' : '工作区已保存';
    if (icon) icon.dataset.state = state;
    badge.title = error || '这里指整个工作区（步骤、文件夹、星标、便签备份）的本机快照；步骤便签本身在输入时已即时保存';
    badge.classList.toggle('is-error', state === 'error');
  }
  function workspaceSaveCoordinator() {
    if (!ports.sessionSaveCoordinator) ports.sessionSaveCoordinator = window.SB_WORKSPACE_SAVE.create({
      store: ports.sessionStore,
      snapshot: function () {
        // Retry the synchronous copy; failed writes still survive in this snapshot's draft metadata.
        ports.folderEditStore.persist();
        return buildLocalSnapshot();
      },
      empty: function (snap) {
        return !(snap.localWorkspaceId || snap.entries.length || snap.groups.length || snap.customSteps.length || Object.keys(snap.organization).length);
      },
      hasError: function () { return document.documentElement.dataset.sessionSave === 'error'; },
      onState: showSessionSaveState,
      onCommit: saveLastSessionMeta,
      onError: function (error) { ports.toast('工作区保存失败，上一份快照已保留：' + error, true); },
    });
    return ports.sessionSaveCoordinator;
  }
  function scheduleSessionSave(options) {
    if (ports.S.restoringSession) return;
    if (/[?&](autodemo|testaf3)=1/.test(location.search)) return;
    ensureCurrentPipelineTab();
    // Reconcile structural deletion/undo now. Quiet backups never replace newer drafts with old organization notes.
    if (!(options && options.quiet)) ports.reconcileFolderNotes();
    return workspaceSaveCoordinator().schedule(options);
  }
  function clearSavedSession() {
    try { localStorage.removeItem(ports.LAST_SESSION_KEY); } catch (_) { /* ignore */ }
    if (ports.workspaceWindowKey === 'main') try { localStorage.removeItem(ports.LEGACY_LAST_SESSION_KEY); } catch (_) { /* ignore */ }
    const cleared = workspaceSaveCoordinator().clear();
    ports.folderEditStore.reset();
    return cleared;
  }
  function applySnapshotEntries(snap) {
    if (!snap || !Array.isArray(snap.entries)) return false;
    if (!snap.entries.length && !(snap.customSteps && snap.customSteps.length) && !Object.keys(snap.organization || {}).length && !snap.localWorkspaceId) return false;
    ports.S.localWorkspaceId = snap.localWorkspaceId || '';
    if (snap.workspaceId && ports.folderEditStore.activateWorkspace) ports.folderEditStore.activateWorkspace(snap.workspaceId);
    ports.restoreStepEdits(snap.stepEdits);
    // 本机 outbox 的存在本身就是权威，包括 ACK 后的 {}；旧快照只能在它缺失时回填。
    ports.notesSync.restoreFallback(snap.notesPending);
    ports.applyPendingStepNotes();
    ports.S.definitionFingerprints = Object.assign({}, snap.definitionFingerprints || {});
    ports.S.organization = JSON.parse(JSON.stringify(snap.organization || {}));
    ports.S.trashFolders = Array.isArray(snap.trashFolders) ? JSON.parse(JSON.stringify(snap.trashFolders)) : [];
    ports.S.trashSteps = Array.isArray(snap.trashSteps) ? JSON.parse(JSON.stringify(snap.trashSteps)) : [];
    ports.S.customSteps = Array.isArray(snap.customSteps) ? JSON.parse(JSON.stringify(snap.customSteps)) : ports.S.customSteps;
    ports.addEntries(snap.entries, '', { group: false, rebuild: false, quiet: true, skipSessionSave: true, deferRender: true });
    const byKey = new Map(snap.entries.map(function (raw) {
      return [raw.sourceKey || raw.fileKey || [raw.fullPath || raw.path || '', raw.name || '', raw.size || 0].join('|'), raw];
    }));
    ports.S.entries.forEach(function (e) {
      const raw = byKey.get(ports.entryOrgKey(e));
      if (!raw) return;
      if (raw.metrics) e.metrics = Object.assign({}, raw.metrics);
      if (raw.sessionMembershipVersion === window.SB_SESSION_MIGRATION.VERSION) {
        e.star = !!raw.star;
        e.starManual = !!raw.starManual;
      }
      e.visible = raw.visible !== false;
      if (raw.stepKey) e.stepKey = raw.stepKey;
      if (raw.stepTitle) e.stepTitle = raw.stepTitle;
      if (raw.stepTool !== undefined) e.stepTool = raw.stepTool;
      if (raw.pipelineId) e.pipelineId = raw.pipelineId;
      if (Number.isFinite(raw.stepIndex)) e.stepIndex = raw.stepIndex;
      if (raw.fetchUrl) e.fetchUrl = raw.fetchUrl;
      if (raw.lazy) e.lazy = true;
    });
    if (Array.isArray(snap.groups)) {
      const keyToId = new Map(ports.S.entries.map(function (e) { return [ports.entryOrgKey(e), e.id]; }));
      for (const g of snap.groups) {
        if (g.pipelineKey && ports.S.groups.some(function (x) { return x.pipelineKey === g.pipelineKey; })) continue;
        const ids = (g.keys || []).map(function (k) { return keyToId.get(k); }).filter(Boolean);
        if (!ids.length && !g.pipelineKey) continue;
        const created = ports.createGroup(g.name, ids, false);
        if (g.pipelineKey) created.pipelineKey = g.pipelineKey;
        if (Number.isFinite(g.stepIndex)) created.stepIndex = g.stepIndex;
      }
    }
    const pipeHit = ports.S.entries.find(function (e) { return e.pipelineId; });
    ports.S.activePipelineId = snap.activePipelineId || (pipeHit && pipeHit.pipelineId) || '';
    ports.S.activePipelineName = snap.activePipelineName || '';
    if (snap.metricsState) {
      ports.S.metrics = JSON.parse(JSON.stringify(snap.metricsState));
      ports.S.metrics.matched = ports.S.entries.filter(function (entry) { return !!entry.metrics; }).length;
    }
    ports.S.autoScoreRows = JSON.parse(JSON.stringify(snap.autoScoreRows || []));
    ports.restoreFolderNotes(snap.folderEdits, snap.workspaceId);
    return true;
  }
  async function migrateSavedMemberships(snapshot) {
    const run = { controller: new AbortController(), cancelled: false, committing: false };
    let shown = false;
    try {
      const result = await refreshMemberships(snapshot, {
        migration: window.SB_SESSION_MIGRATION, signal: run.controller.signal,
        progress(percent, detail) {
          shown = true; ports.loadProgressRun = run;
          ports.$('loadProgressCancel').disabled = false;
          ports.setLoadProgress('核对工作区来源', percent, detail);
        },
        pending(pid, error) {
          console.warn('[StructBoard] kept original workspace; lineage migration pending for', pid, error);
          ports.S.migrationPending = true;
          ports.toast('旧工作区已保留，来源同步未完成：' + error.message, true);
        },
        async backup(value) {
          if (!(await idbGet('snapshot.before-membership-v2'))) await idbSet('snapshot.before-membership-v2', value);
          const saved = await idbGet('snapshot.before-membership-v2');
          if (!saved || !Array.isArray(saved.entries)) throw Error('旧工作区备份未成功，停止迁移');
        },
      });
      if (result.report) ports.S.migrationReport = result.report;
      return result.snapshot;
    } finally {
      if (shown && ports.loadProgressRun === run) {
        ports.loadProgressRun = null; ports.$('loadProgressCancel').disabled = false;
        ports.hideLoadProgress();
      }
    }
  }
  async function restoreLastSession() {
    try {
      const catalog = JSON.parse(localStorage.getItem('structboard.pipelineTabs.' + ports.workspaceWindowKey) || 'null');
      if (catalog && catalog.version === 1 && Array.isArray(catalog.items) && !catalog.items.length) {
        ports.S.customSteps = []; ports.S.restoringSession = false;
        ports.renderGroups(); ports.renderList(); updatePipelineIdentity('');
        return false;
      }
    } catch (_) { /* Legacy sessions without a valid tab catalog still restore. */ }
    const meta = loadLastSessionMeta();
    const preferredPipelineId = ports.pipelineTabs.activeId || (meta && (meta.workspaceTabId || meta.pipelineId)) || '';
    const preferredKey = pipelineWorkspaceKey(preferredPipelineId);
    ports.sessionStore.setKey(preferredKey);
    let snap;
    try { snap = await ports.sessionStore.load(preferredKey); }
    catch (error) {
      showSessionSaveState('error', error.message);
      ports.toast('读取工作区失败，正在尝试上一份快照：' + error.message, true);
      try { snap = await ports.sessionStore.load(preferredKey === 'snapshot' ? 'snapshot.previous' : preferredKey + '.previous'); }
      catch (backupError) {
        ports.toast('工作区备份也无法读取：' + backupError.message, true);
        return false;
      }
      if (!snap) return false;
    }
    if (!snap && ports.workspaceWindowKey === 'main') {
      try {
        const legacy = await ports.sessionStore.load('snapshot');
        if (legacy && (!preferredPipelineId || legacy.activePipelineId === preferredPipelineId)) snap = legacy;
      } catch (_) { snap = null; }
    }
    if (!snap && ports.workspaceWindowKey !== 'main') {
      try {
        const bootstrapResponse = await fetch('/api/pipeline/window-bootstrap?key=' + encodeURIComponent(ports.workspaceWindowKey), { cache: 'no-store' });
        const bootstrap = await bootstrapResponse.json();
        if (bootstrapResponse.ok && bootstrap.ok && bootstrap.snapshot && Array.isArray(bootstrap.tabs)) {
          bootstrap.tabs.forEach(function (item) { ports.pipelineTabs.add(item, false); });
          snap = bootstrap.snapshot;
          const bootPipeline = snap.activePipelineId || (bootstrap.tabs[0] && bootstrap.tabs[0].id) || '';
          if (bootPipeline) {
            ports.pipelineTabs.activate(bootPipeline);
            ports.sessionStore.setKey(pipelineWorkspaceKey(bootPipeline));
            await ports.sessionStore.save(snap, { key: pipelineWorkspaceKey(bootPipeline) });
          }
        }
      } catch (error) {
        ports.toast('独立窗口快照读取失败：' + (error.message || String(error)), true);
      }
    }
    if (!meta && (!snap || !snap.entries || !snap.entries.length) && !(snap && snap.customSteps && snap.customSteps.length) && !(snap && snap.localWorkspaceId)) return false;
    ports.S.restoringSession = true;
    let restored = false;
    try {
      ports.status('正在恢复上次打开的结构与步骤…');
      const snapHasPipeline = !!(snap && Array.isArray(snap.entries) && snap.entries.some(function (e) {
        return e && (e.pipelineId || e.stepKey || (e.lazy && e.fetchUrl));
      }));
      if (snapHasPipeline) {
        // 本地已有管线清单缓存：秒级恢复，不再弹「读取管线」去扫盘
        ports.setLoadProgress('恢复工作区', 40, '正在从本地缓存恢复…');
        try {
          try { snap = await migrateSavedMemberships(snap); }
          catch (error) {
            if (error.name !== 'AbortError') throw error;
            ports.toast('已停止来源核对，恢复原工作区');
          }
          restored = applySnapshotEntries(snap);
        } finally { ports.hideLoadProgress(); }
      } else {
        // 已保存的本地结构优先于旧管线提示。仅当没有可恢复的快照时回退到整条导入。
        restored = applySnapshotEntries(snap);
        if (!restored && !isLocalWorkspaceTab(preferredPipelineId) && (preferredPipelineId || (meta && meta.pipelineId)) && window.__SB_RESTORE_PIPELINE__) {
          ports.setLoadProgress('恢复工作区', 10, '正在加载管线步骤与结构…');
          restored = await window.__SB_RESTORE_PIPELINE__(preferredPipelineId || meta.pipelineId, { silent: false, openAsTab: true });
          ports.hideLoadProgress();
        }
      }
      if (!restored && !ports.S.entries.length) return false;
      if (!ports.S.activePipelineName && meta && meta.pipelineId === ports.S.activePipelineId) ports.S.activePipelineName = meta.pipelineName || '';
      if (ports.S.activePipelineId && (!ports.S.activePipelineName || ports.S.activePipelineName === ports.S.activePipelineId)) {
        const id = ports.S.activePipelineId;
        try {
          const response = await fetch('/api/pipelines', { cache: 'no-store' });
          const data = await response.json();
          const item = (data.pipelines || []).find(function (pipeline) { return pipeline.id === id; });
          if (item && item.name && ports.S.activePipelineId === id) ports.S.activePipelineName = item.name;
        } catch (_) { /* The last known title remains usable offline. */ }
      }
      if (ports.S.activePipelineId) {
        ports.pipelineTabs.add({ id: ports.S.activePipelineId, name: ports.S.activePipelineName || ports.S.activePipelineId }, true);
        ports.sessionStore.setKey(pipelineWorkspaceKey(ports.S.activePipelineId));
        ports.renderPipelineTabs();
      }
      else if (ports.S.localWorkspaceId || isLocalWorkspaceTab(preferredPipelineId)) {
        ports.S.localWorkspaceId = ports.S.localWorkspaceId || preferredPipelineId;
        ensureCurrentPipelineTab();
      }
      if (meta && meta.pipelineId === ports.S.activePipelineId && meta.referenceKey) {
        const refHit = ports.S.entries.find(function (e) {
          return ports.entryOrgKey(e) === meta.referenceKey || e.fileKey === meta.referenceKey;
        });
        if (refHit) ports.S.referenceId = refHit.id;
      }
      const savedView = loadPipelineViewState(currentWorkspaceTabId()) || (snap && snap.viewState);
      if (savedView) restoreWorkspaceViewState(savedView);
      else ports.S.activeGroupId = 'all';
      ports.renderGroups();
      ports.refreshReferenceSelect();
      ports.renderList();
      ports.refreshBadge();
      const activeView = savedView && savedView.panes && savedView.panes[Math.min(ports.activePane, savedView.panes.length - 1)];
      const targetMode = (activeView && activeView.mode)
        || ((meta && meta.pipelineId === ports.S.activePipelineId && meta.mode)
        || (ports.S.entries.some(function (e) { return !!e.stepKey; }) ? 'overview' : 'overlay'));
      const restoreStates = savedView && savedView.panes && savedView.panes.length ? savedView.panes : [{ mode: targetMode }];
      for (let i = 0; i < Math.min(restoreStates.length, ports.panes.filter(ports.PANE_RUNTIME.alive).length); i++) {
        const pane = ports.panes[i], view = restoreStates[i] || {};
        const sameMode = pane.view.mode === (view.mode || targetMode);
        const result = ports.setMode(view.mode || targetMode, { skipSessionSave: true }, pane);
        if (result && typeof result.then === 'function') await result;
        if (sameMode) await ports.applyModeChange(true, pane);
        if (pane.overview && view.overviewSearch !== undefined) pane.overview.setSearch(view.overviewSearch);
        if (pane.overview && view.mode === 'overview' && view.overviewPlace) pane.overview.restore(view.overviewPlace);
        ports.refreshOverviewSearchState(pane.index);
      }
      ports.toast('已自动恢复上次工作区 · ' + ports.S.entries.length + ' 个结构');
      return true;
    } catch (error) {
      showSessionSaveState('error', error.message || String(error));
      ports.toast('恢复工作区失败，原快照已保留：' + (error.message || error), true);
      return false;
    } finally {
      ports.S.restoringSession = false;
      if (restored) scheduleSessionSave();
    }
  }
  function workspaceTransactions() {
    if (ports.workspaceService) return ports.workspaceService;
    ports.workspaceService = window.SB_UI.createWorkspaceService({
      catalog: ports.pipelineTabs, storage: ports.sessionStore,
      persistence: {
        flush: function () { return workspaceSaveCoordinator().flush(); },
        version: function () { return workspaceSaveCoordinator().version; },
        clearLastSession: function () { localStorage.removeItem(ports.LAST_SESSION_KEY); },
      },
      workspace: {
        currentId: currentWorkspaceTabId, key: pipelineWorkspaceKey, isLocal: isLocalWorkspaceTab,
        uuid: function () { return window.crypto.randomUUID(); },
        blocked: function () { return !!(ports.localImportBusy || (ports.panePipelineController && ports.panePipelineController.busy)); },
        capture: buildLocalSnapshot, empty: emptyLocalWorkspace, reset: resetWorkspaceForPipelineSwitch,
        restore: restorePipelineSnapshot, migrate: migrateSavedMemberships,
        ensureCurrentTab: ensureCurrentPipelineTab, saveView: savePipelineViewNow,
        viewFor: loadPipelineViewState, rekey: rekeyFolderDrafts, hydrateNotes: ports.hydrateStepNotesFromPipeline,
        setRestoring: function (value) { ports.rawS.restoringSession = value; },
        setName: function (name) { ports.rawS.activePipelineName = name; updatePipelineIdentity(name); },
        clearIdentity: function () { ports.rawS.localWorkspaceId = ''; updatePipelineIdentity(''); },
        flushNotes: function () {
          for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) if (pane.overview) pane.overview.flushNoteEdits();
        },
        importPipeline: function (id) {
          if (!ports.panePipelineController) throw Error('管线载入器尚未就绪');
          return ports.panePipelineController.importWholePipeline({ pipelineId: id, openAsTab: true, forceReload: true, pane: ports.activePane });
        },
      },
      windows: {
        available: function () { return !!window.__SB_DESKTOP_INVOKE__; },
        open: function (payload) { return window.__SB_DESKTOP_INVOKE__('desktop_open_pipeline_window', payload); },
        catalog: function (key) { return window.SB_PIPELINE_TABS.create({ storage: window.localStorage, key: 'structboard.pipelineTabs.' + key }); },
      },
      ui: {
        refresh: ports.renderPipelineTabs, status: ports.status,
        error: function (message) { ports.toast(message, true); },
        busy: function (value) {
          ports.pipelineTabBusy = value;
          if (ports.$('pipelineTabs')) ports.$('pipelineTabs').setAttribute('aria-busy', String(value));
        },
        finalize: function () {
          ports.updateEmptyState();
          if (ports.pipelineTabs.activeId && ports.pipelineTabs.activeId === currentWorkspaceTabId()) saveLastSessionMeta();
        },
      },
    });
    return ports.workspaceService;
  }
  async function resetWorkspaceForPipelineSwitch() {
    ports.rawS.workspaceEpoch = (ports.rawS.workspaceEpoch || 0) + 1;
    await ports.resetSharedPaneViews();
    ports.rawS.entries = []; ports.rawS.seq = 0; ports.rawS.groups = []; ports.rawS.groupSeq = 0;
    ports.rawS.activePipelineId = ''; ports.rawS.activePipelineName = ''; ports.rawS.localWorkspaceId = ''; ports.rawS.customSteps = [];
    ports.rawS.organization = {}; ports.rawS.trashFolders = []; ports.rawS.trashSteps = [];
    ports.rawS.metrics = { table: null, primary: '', higher: true, filters: [], range: null, matched: 0, fileName: '', auto: false };
    ports.rawS.autoScoreRows = []; ports.rawS.referenceId = null; ports.rawS.aligned = false; ports.rawS.soloId = null;
    ports.rawS.listNav = null; ports.rawS.starOnly = false; ports.rawS.filter = ''; ports.rawS.manualOrder = false;
    ports.rawS.migrationPending = false; ports.rawS.migrationReport = null;
    if (ports.ORG) ports.ORG.clearHistory();
    ports.folderEditStore.reset();
    ports.panes.forEach(function (pane) {
      Object.assign(pane.view, { mode: 'overview', filter: '', starOnly: false, referenceId: null, aligned: false,
        activeGroupId: 'all', soloId: null, page: 0, listNav: null, overviewReturn: null, soloFrom: null,
        gridDrill: null, gridParentPage: 0, gridContext: '', gridPinned: [], trashOpen: false });
    });
    ports.activePane = 0; ports.overview = ports.panes[0] && ports.panes[0].overview || null;
    ports.$('searchInput').value = '';
    ports.renderGroups(); ports.renderList(); ports.refreshReferenceSelect(); ports.refreshBadge();
    return true;
  }
  async function restorePipelineSnapshot(snapshot) {
    if (!applySnapshotEntries(snapshot)) throw Error('这个管线标签没有可恢复的工作区快照');
    if (!ports.rawS.activePipelineName) ports.rawS.activePipelineName = snapshot.activePipelineName || ports.rawS.activePipelineId;
    const savedView = loadPipelineViewState(currentWorkspaceTabId()) || snapshot.viewState;
    if (savedView) restoreWorkspaceViewState(savedView);
    ports.renderGroups(); ports.refreshReferenceSelect(); ports.renderList(); ports.refreshBadge(); ports.renderMetricUI();
    const views = savedView && savedView.panes || [{ mode: 'overview' }];
    for (let i = 0; i < Math.min(views.length, ports.panes.filter(ports.PANE_RUNTIME.alive).length); i++) {
      const pane = ports.panes[i], view = views[i] || {}, mode = ['overview', 'grid', 'overlay'].indexOf(view.mode) >= 0 ? view.mode : 'overview';
      const sameMode = pane.view.mode === mode;
      const result = ports.setMode(mode, { skipSessionSave: true }, pane);
      if (result && typeof result.then === 'function') await result;
      if (sameMode) await ports.applyModeChange(true, pane);
      if (pane.overview && view.overviewSearch !== undefined) pane.overview.setSearch(view.overviewSearch);
      if (pane.overview && mode === 'overview' && view.overviewPlace) pane.overview.restore(view.overviewPlace);
      ports.refreshOverviewSearchState(pane.index);
    }
    updatePipelineIdentity(ports.rawS.activePipelineName);
    ports.renderPipelineTabs();
    ports.refreshBadge();
    return true;
  }
  function emptyLocalWorkspace(id) {
    return { entries: [], groups: [], customSteps: [], organization: {}, trashFolders: [], trashSteps: [],
      activePipelineId: '', activePipelineName: '新标签页', localWorkspaceId: id || '__local__',
      workspaceId: pipelineFolderWorkspaceId(id), folderEdits: {}, stepEdits: {},
      viewState: { activePane: 0, panes: [{ mode: 'overview', filter: '', starOnly: false }] } };
  }
  function updatePipelineIdentity(name) {
    ports.rawS.activePipelineName = String(name || '');
    const label = ports.$('currentPipelineTitle');
    if (label) {
      label.hidden = !ports.rawS.activePipelineName;
      label.textContent = ports.rawS.activePipelineName;
      label.title = ports.rawS.activePipelineName;
    }
    if (window.__SB_DESKTOP_INVOKE__ && ports.workspaceWindowKey !== 'main') {
      window.__SB_DESKTOP_INVOKE__('desktop_set_window_title', { title: ports.rawS.activePipelineName || '构境·StructBoard' }).catch(function () {});
    }
  }
  function ensureCurrentPipelineTab() {
    const pid = ports.activePipelineId();
    const populated = !!(ports.S.entries.length || ports.S.customSteps.length || ports.S.groups.length);
    if (!pid && !populated && !ports.rawS.localWorkspaceId) return;
    const id = pid || ports.rawS.localWorkspaceId || '__local__';
    const name = pid ? (ports.rawS.activePipelineName || pid) : populated
      ? (ports.S.groups[0] && ports.S.groups[0].name) || (ports.S.entries.length === 1 ? ports.S.entries[0].name : '本地结构 · ' + ports.S.entries.length)
      : '新标签页';
    if (!pid) ports.rawS.localWorkspaceId = id;
    if (!pid) ports.rawS.activePipelineName = name;
    ports.sessionStore.setKey(pipelineWorkspaceKey(id));
    const current = ports.pipelineTabs.get(id);
    if (!current || current.name !== name || ports.pipelineTabs.activeId !== id) {
      ports.pipelineTabs.add({ id: id, name: name }, true);
      ports.renderPipelineTabs();
    }
  }
  function currentWorkspaceTabId() {
    return ports.activePipelineId() || ports.rawS.localWorkspaceId || ((ports.S.entries.length || ports.S.customSteps.length || ports.S.groups.length) ? '__local__' : '');
  }
// SERVICE_FUNCTIONS_END
  return { pipelineWorkspaceKey, isLocalWorkspaceTab, pipelineViewStateKey, pipelineFolderWorkspaceId, rekeyFolderDrafts, openSessionDB, idbGet, idbSet, idbDel, loadLastSessionMeta, saveLastSessionMeta, buildLocalSnapshot, stableGroupKey, captureWorkspaceViewState, savePipelineViewNow, schedulePipelineViewSave, loadPipelineViewState, restoreWorkspaceViewState, showSessionSaveState, workspaceSaveCoordinator, scheduleSessionSave, clearSavedSession, applySnapshotEntries, migrateSavedMemberships, restoreLastSession, workspaceTransactions, resetWorkspaceForPipelineSwitch, restorePipelineSnapshot, emptyLocalWorkspace, updatePipelineIdentity, ensureCurrentPipelineTab, currentWorkspaceTabId };
}
