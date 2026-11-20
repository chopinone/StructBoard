// app-operations: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function stepExists(key) {
    if (key === 'plain') return true;
    return ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).some(function (s) { return s.key === key; });
  }
  function stepEntriesAlive(key) {
    return ports.S.entries.filter(function (e) {
      return (e.stepKey || 'plain') === key && !ports.entryIsTrashed(e);
    });
  }
  function resolveStepKeys(stepKey, list) {
    const entries = stepEntriesAlive(stepKey);
    const bySource = new Map(), byPlace = new Map(), byName = new Map();
    for (const e of entries) {
      if (e.sourceKey) bySource.set(e.sourceKey, e);
      const place = ports.entryOrgKey(e);
      if (place) byPlace.set(place, e);
      if (!byName.has(e.name)) byName.set(e.name, e);
    }
    const out = [], missing = [];
    for (const raw of list || []) {
      const key = String(raw || '');
      const hit = bySource.get(key) || byPlace.get(key) || byName.get(key);
      if (!hit) missing.push(key);
      else if (out.indexOf(hit) < 0) out.push(hit);
    }
    if (missing.length) throw Error('这些成员不在步骤「' + stepKey + '」里: ' + missing.slice(0, 5).join(', '));
    return out.map(ports.entryOrgKey).filter(Boolean);
  }
  function orgFolders(stepKey) {
    const org = ports.S.organization[stepKey];
    return (org && Array.isArray(org.folders)) ? org.folders : [];
  }
  function folderTreeFor(stepKey, includeNotes) {
    const org = ports.S.organization[stepKey];
    const folders = orgFolders(stepKey);
    if (!org || !folders.length) return [];
    const alive = stepEntriesAlive(stepKey);
    const counts = new Map();
    for (const e of alive) {
      const place = ports.entryOrgKey(e);
      const target = place && org.placements ? org.placements[place] : '';
      if (target) counts.set(target, (counts.get(target) || 0) + 1);
    }
    const byId = new Map(folders.map(function (f) {
      const noteKey = 'folder:user:' + f.id;
      return [f.id, {
        id: f.id, name: f.name, parentId: f.parentId || null,
        memberCount: counts.get(f.id) || 0,
        note: includeNotes === false ? undefined : ((org.notes && org.notes[noteKey]) || ''),
        children: [],
      }];
    }));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parentId && byId.get(node.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }
  function describeWorkspace(opts) {
    opts = opts || {};
    const stepFilter = opts.stepKey || '';
    const entryLimit = Math.max(1, Math.min(Number(opts.entryLimit) || 200, 1000));
    const entryOffset = Math.max(0, Number(opts.entryOffset) || 0);
    const includeEntries = opts.includeEntries !== false;
    const includeMetrics = !!opts.includeMetrics;
    const includeNotes = opts.includeNotes !== false;
    const edits = includeNotes ? ports.loadStepEdits() : {};
    const alive = ports.S.entries.filter(function (e) { return !ports.entryIsTrashed(e); });
    const steps = [];
    for (const bucket of ports.orderedStepBuckets(alive, { includeEmpty: true })) {
      if (stepFilter && bucket.key !== stepFilter) continue;
      const members = alive.filter(function (e) { return (e.stepKey || 'plain') === bucket.key; });
      steps.push({
        key: bucket.key,
        title: bucket.title,
        tool: bucket.tool || '',
        entryCount: members.length,
        note: includeNotes ? ((edits[bucket.key] || {}).note || '') : undefined,
        folders: folderTreeFor(bucket.key, includeNotes),
      });
    }
    let entries;
    if (includeEntries) {
      const list = alive.filter(function (e) { return !stepFilter || (e.stepKey || 'plain') === stepFilter; });
      entries = {
        total: list.length,
        offset: entryOffset,
        items: list.slice(entryOffset, entryOffset + entryLimit).map(function (e) {
          const row = {
            sourceKey: e.sourceKey || null,
            name: e.name,
            stepKey: e.stepKey || 'plain',
            group: e.group || null,
            modelIndex: Number.isFinite(e.modelIndex) ? e.modelIndex : null,
            star: !!e.star,
            format: e.format || 'pdb',
            size: e.size || 0,
            folder: (ports.S.organization[e.stepKey || 'plain'] || {}).placements
              ? (ports.S.organization[e.stepKey || 'plain'].placements[ports.entryOrgKey(e)] || null)
              : null,
          };
          if (includeMetrics && e.metrics) row.metrics = e.metrics;
          return row;
        }),
      };
    }
    return {
      generatedAt: new Date().toISOString(),
      mode: ports.S.mode,
      pipelineId: ports.activePipelineId() || null,
      stepCount: steps.length,
      entryCount: alive.length,
      starCount: alive.filter(function (e) { return e.star; }).length,
      steps: steps,
      entries: entries,
      trash: {
        steps: (ports.S.trashSteps || []).length,
        folders: (ports.S.trashFolders || []).length,
        entries: ports.S.entries.length - alive.length,
      },
      filters: {
        search: ports.S.filter || '',
        starOnly: !!ports.S.starOnly,
        metricFilters: (ports.S.metrics && ports.S.metrics.filters || []).map(function (f) {
          return { col: f.col, op: f.op, value: f.value };
        }),
      },
    };
  }
  function actNoteSet(args) {
    if (!stepExists(args.stepKey)) throw Error('步骤不存在: ' + args.stepKey);
    ports.saveStepNote(args.stepKey, args.text);
    return { stepKey: args.stepKey, saved: true };
  }
  function actFolderCreate(args) {
    if (!ports.ORG) throw Error('组织模块未加载');
    if (!stepExists(args.stepKey)) throw Error('步骤不存在: ' + args.stepKey);
    const parentId = args.parentId || null;
    if (parentId && !orgFolders(args.stepKey).some(function (f) { return f.id === parentId; })) throw Error('目标父文件夹不存在');
    const keys = resolveStepKeys(args.stepKey, args.sourceKeys || []);
    const newId = ports.ORG.createFolder(ports.S.organization, args.stepKey, { name: args.name.trim(), parentId: parentId, entryKeys: keys });
    // Explicit API targets must never start an unowned delayed scroll/focus hunt.
    ports.afterOrgChange(args.stepKey, '已新建「' + args.name.trim() + '」');
    return { stepKey: args.stepKey, folderId: newId, members: keys.length };
  }
  function actFolderMove(args) {
    if (!ports.ORG) throw Error('组织模块未加载');
    if (!stepExists(args.stepKey)) throw Error('步骤不存在: ' + args.stepKey);
    const folderId = !args.folderId || args.folderId === 'root' ? null : args.folderId;
    if (folderId && !orgFolders(args.stepKey).some(function (f) { return f.id === folderId; })) throw Error('目标文件夹不存在');
    const keys = resolveStepKeys(args.stepKey, args.sourceKeys);
    if (!keys.length) throw Error('没有可移动的成员');
    ports.ORG.moveKeys(ports.S.organization, args.stepKey, keys, folderId);
    ports.afterOrgChange(args.stepKey, folderId ? '已移入文件夹' : '已移到这一步顶层');
    return { stepKey: args.stepKey, moved: keys.length, folderId: folderId };
  }
  function actStarTargets(targets, on) {
    if (!targets.length) throw Error('没有匹配的成员');
    for (const e of targets) { e.star = !!on; e.starManual = true; }
    ports.saveMarks(); ports.renderList(); ports.refreshBadge();
    for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
      if (pane.overview && pane.overview.mark) for (const e of targets) pane.overview.mark(e);
    }
    return { changed: targets.length, on: !!on };
  }
  function resolvePanel(args) {
    let pane = ports.panes.find(function (item) { return item.id === args.paneId && !item.disposed; });
    if (args.paneId === 'right') pane = ports.panes[1];
    if (!pane && args.paneId !== 'right') throw appOperationError('NOT_FOUND', 'Unknown pane handle');
    if (args.split && !ports.splitState.active) {
      const previous = ports.panes[ports.activePane];
      ports.splitOn();
      if (previous && ports.panes.indexOf(previous) >= 0) {
        ports.activePane = ports.panes.indexOf(previous); ports.overview = previous.overview || null;
      }
      if (args.paneId === 'right') pane = ports.panes[1];
    }
    if (!pane || pane.disposed) throw appOperationError('NOT_FOUND', 'Requested pane is unavailable; use split:true to create the right pane');
    return pane;
  }
  function appOperationError(code, message) {
    const error = new Error(message); error.code = code; return error;
  }
  function captureAppOperationOwner(tool, args) {
    const pane = tool === 'sb_view_open' ? resolvePanel(args) : ports.paneAt();
    if (!pane || pane.disposed) throw appOperationError('NOT_FOUND', 'Pane is unavailable');
    const owner = { pane: pane, life: pane.life, epoch: ports.rawS.workspaceEpoch || 0, workspaceId: ports.folderEditStore.workspaceId };
    if (tool === 'sb_view_open') owner.ticket = ports.PANE_RUNTIME.begin(pane, 'app-operation');
    return owner;
  }
  function checkAppOperationOwner(owner) {
    if (!owner || owner.pane.disposed || owner.pane.life !== owner.life || (ports.rawS.workspaceEpoch || 0) !== owner.epoch || ports.folderEditStore.workspaceId !== owner.workspaceId) {
      throw appOperationError('STALE_OWNER', 'Pane or workspace changed during the operation');
    }
    if (owner.ticket && !ports.PANE_RUNTIME.current(owner.pane, owner.ticket)) throw appOperationError('SUPERSEDED', 'A newer view command replaced this operation');
  }
  function appOperationSnapshot() {
    const edits = ports.loadStepEdits(), all = ports.rawS.entries || [], alive = all.filter(function (entry) { return !ports.entryIsTrashed(entry); });
    const buckets = ports.orderedStepBuckets(alive, { includeEmpty: true }).filter(function (step) { return !ports.stepIsTrashed(step.key) && !(edits[step.key] || {}).deleted; });
    if (alive.some(function (entry) { return !entry.stepKey; }) || ports.rawS.organization.plain) buckets.push({ key: 'plain', title: '其他导入', tool: '' });
    const entryRows = alive.map(function (entry) {
      const key = entry.stepKey || 'plain', org = ports.rawS.organization[key] || {};
      return { key: ports.entryOrgKey(entry), runtimeId: entry.id, stepKey: key, name: entry.name, star: !!entry.star,
        format: entry.format || 'pdb', size: entry.size || 0, modelIndex: entry.modelIndex, metrics: entry.metrics || {},
        folderId: (org.placements || {})[ports.entryOrgKey(entry)] || null };
    });
    const pids = Array.from(new Set([ports.activePipelineId()].concat(all.map(function (entry) { return entry.pipelineId; }), (ports.rawS.customSteps || []).map(function (step) { return step.pipelineId; })).filter(Boolean)));
    return {
      identity: ports.rawS.activePipelineId ? ports.pipelineFolderWorkspaceId(ports.rawS.activePipelineId) : (ports.folderEditStore.workspaceId || 'current'), epoch: ports.rawS.workspaceEpoch || 0, pipelineId: ports.activePipelineId() || '', pipelineIds: pids,
      activePaneId: (ports.panes[ports.activePane] || {}).id || '',
      entries: entryRows,
      steps: buckets.map(function (step) {
        const org = ports.rawS.organization[step.key] || {};
        return { key: step.key, title: step.title || step.key, tool: step.tool || '', note: (edits[step.key] || {}).note || '',
          folders: (org.folders || []).map(function (folder) {
            const node = { kind: 'folder', origin: 'user', orgId: folder.id, id: 'folder:user:' + folder.id, stepKey: step.key };
            return { id: folder.id, name: folder.name, parentId: folder.parentId || null, note: ports.folderNoteOf(node) };
          }) };
      }),
      panes: ports.panes.filter(ports.PANE_RUNTIME.alive).map(function (pane) {
        const view = pane.view, pins = new Set(view.gridPinned || []);
        return { id: pane.id, position: pane.index ? 'right' : 'left', mode: view.mode, cols: view.cols, rows: view.rows,
          entryKeys: entryRows.filter(function (entry) { return pins.has(entry.runtimeId); }).map(function (entry) { return JSON.stringify([entry.stepKey, entry.key]); }),
          filter: view.filter || '', starOnly: !!view.starOnly, referenceId: view.referenceId || null,
          query: pane.overview && pane.overview.searchStats ? String(pane.overview.searchStats().query || '') : '', page: view.page || 0,
          listNav: view.listNav || null, gridDrill: view.gridDrill || null, overviewGrouped: view.overviewGrouped !== false,
          theme: view.theme || '', repr: view.repr || '', aligned: !!view.aligned };
      }),
      trash: { steps: (ports.rawS.trashSteps || []).length, folders: (ports.rawS.trashFolders || []).length, entries: all.length - alive.length },
      organization: ports.rawS.organization, customSteps: ports.rawS.customSteps || [], stepEdits: edits,
      metricFilters: ports.rawS.metrics && ports.rawS.metrics.filters || [],
    };
  }
  async function openAppOperationView(args, owner, context) {
    const pane = owner.pane, state = ports.paneContext(pane);
    const guard = function () {
      checkAppOperationOwner(owner);
      if (context.signal && context.signal.aborted) throw appOperationError('CANCELLED', 'View operation was cancelled');
    };
    guard();
    const wanted = args.entries.map(function (entry) {
      const hit = ports.rawS.entries.find(function (raw) { return raw.id === entry.runtimeId && ports.entryOrgKey(raw) === entry.key && (raw.stepKey || 'plain') === entry.stepKey; });
      if (!hit || ports.entryIsTrashed(hit)) throw appOperationError('NOT_FOUND', 'An entry is no longer available');
      return hit;
    });
    if (args.mode === 'overview') {
      const build = ports.withPaneSync(pane, function () { return ports.setMode('overview', {}, pane); });
      await build; guard();
      ports.withPaneSync(pane, function () {
        const host = ports.ensureOverview(pane);
        if (args.stepKey && host && host.scrollToStep) host.scrollToStep(args.stepKey);
      });
      return { paneId: pane.id, loaded: [], failed: [], pending: wanted.map(ports.entryOrgKey), cols: state.cols, rows: state.rows };
    }
    // Fetch existing lazy sources only. Parsing is staged so stale owners cannot publish it.
    const failed = [];
    for (const entry of wanted) {
      guard();
      if (entry.data || entry.isUrl || !entry.fetchUrl) continue;
      try {
        const response = await fetch(entry.fetchUrl, { cache: 'no-store', signal: context.signal });
        guard();
        if (!response.ok) throw Error('load failed');
        const bytes = await response.arrayBuffer(); guard();
        const physicalName = String(entry.fullPath || entry.path || entry.name).replace(/\\/g, '/').split('/').pop();
        const raw = await ports.IO.readFile(new File([bytes], physicalName)); guard();
        const parsed = ports.IO.parse(raw.data, raw.format || entry.format); guard();
        entry.data = raw.data; entry.format = raw.format || entry.format; entry.isBinary = !!raw.isBinary; entry.parsed = parsed;
        entry.size = entry.size || raw.size || (raw.data ? String(raw.data).length : 0);
      } catch (error) {
        guard(); failed.push(ports.entryOrgKey(entry));
      }
    }
    guard();
    const selected = wanted.filter(function (entry) { return failed.indexOf(ports.entryOrgKey(entry)) < 0; });
    if (!selected.length) return { paneId: pane.id, loaded: [], failed: failed, pending: [], cols: state.cols, rows: state.rows };
    if (args.cols !== undefined) state.cols = args.cols;
    if (args.rows !== undefined) state.rows = args.rows;
    state.page = 0; state.soloId = null; state.listNav = null; state.filter = ''; state.starOnly = false;
    const build = ports.withPaneSync(pane, function () {
      if (selected.length) ports.openBenchWithEntries(selected, '检阅台 · ' + selected.length + ' 条');
      else { state.gridPinned = []; ports.setMode('grid', {}, pane); }
      state.gridPinned = selected.map(function (entry) { return entry.id; });
      if (args.mode === 'overlay') {
        state.maxOverlay = selected.length;
        return ports.setMode('overlay', {}, pane) || ports.rebuildOverlay(true, pane);
      }
      return pane.runtime.queues.grid || Promise.resolve();
    });
    await build; guard();
    const mode = state.mode, refs = mode === 'overlay' ? (state.overlayRefs || []).filter(function (item) { return item.ref; }).map(function (item) { return item.id; })
      : (state.gridViewers || []).filter(function (item) { return item.ref; }).map(function (item) { return item.entryId; });
    if (mode !== args.mode) throw appOperationError('SUPERSEDED', 'Pane mode changed during rendering');
    const loaded = selected.filter(function (entry) { return refs.indexOf(entry.id) >= 0; }).map(ports.entryOrgKey);
    const errors = (state.gridLoadErrors || []).map(function (item) { return item.entryId; });
    const attempted = args.mode === 'overlay' ? selected : selected.slice(0, state.cols * state.rows);
    attempted.forEach(function (entry) {
      if (loaded.indexOf(ports.entryOrgKey(entry)) < 0 && (args.mode === 'overlay' || errors.indexOf(entry.id) >= 0)) failed.push(ports.entryOrgKey(entry));
    });
    const pending = selected.filter(function (entry) { return loaded.indexOf(ports.entryOrgKey(entry)) < 0 && failed.indexOf(ports.entryOrgKey(entry)) < 0; }).map(ports.entryOrgKey);
    return { paneId: pane.id, loaded: loaded, failed: failed, pending: pending, cols: state.cols, rows: state.rows };
  }
  async function readAppOperationPipeline(pid, owner, context) {
    const response = await fetch('/api/pipeline?id=' + encodeURIComponent(pid) + '&raw=1', { cache: 'no-store', signal: context.signal });
    const data = await response.json(); checkAppOperationOwner(owner);
    if (!response.ok || !data || !data.ok || !data.pipeline) throw appOperationError('PIPELINE_UNAVAILABLE', 'Could not load pipeline definition');
    return data.pipeline;
  }
  async function writeAppOperationPipeline(pid, definition, before, owner, context) {
    checkAppOperationOwner(owner);
    const current = await readAppOperationPipeline(pid, owner, context);
    if (JSON.stringify(current) !== JSON.stringify(before, function (key, value) { return key === '_key' ? undefined : value; })) {
      throw appOperationError('REVISION_CONFLICT', 'Pipeline definition changed before commit');
    }
    checkAppOperationOwner(owner);
    if (context.beforeCommit) context.beforeCommit();
    if (definition.root !== current.root || definition.id !== current.id) throw appOperationError('INVALID_ARGUMENT', 'Pipeline root and identity cannot change');
    const response = await fetch('/api/pipeline/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: definition, overwrite: true }), signal: context.signal });
    const data = await response.json(); checkAppOperationOwner(owner);
    if (!response.ok || !data || !data.ok) throw appOperationError('PIPELINE_SAVE_FAILED', 'Pipeline definition validation or save failed');
    definition.steps.forEach(function (step, index) {
      const key = pid + ':' + step.id;
      ports.saveStepEdit(key, { title: step.title, tool: step.tool || '', order: (index + 1) * 10 });
      ports.rawS.entries.forEach(function (entry) { if (entry.stepKey === key) entry.stepIndex = (index + 1) * 10; });
    });
    ports.refreshStepsUI(true);
    if (window.__SB_PIPELINE__ && window.__SB_PIPELINE__.push) window.__SB_PIPELINE__.push();
  }
  function appOperationDurability(tool) {
    if (tool === 'sb_notes_set') {
      return ports.stepEditStore.error || ports.notesSync.storageError ? 'error' : 'local';
    }
    return ports.sessionSaveCoordinator && ports.sessionSaveCoordinator.error ? 'error' : 'queued';
  }
  function installAppOperations() {
    const core = window.SB_APP_OPERATIONS_CORE;
    if (!core || window.SB_APP_OPERATIONS) return;
    window.SB_APP_OPERATIONS = core.create({
      snapshot: appOperationSnapshot, captureOwner: captureAppOperationOwner, checkOwner: checkAppOperationOwner,
      setNote: function (stepKey, text, owner) { return ports.withPaneSync(owner.pane, function () { return actNoteSet({ stepKey: stepKey, text: text }); }); },
      createFolder: function (stepKey, name, parentId, entries, owner) { return ports.withPaneSync(owner.pane, function () { return actFolderCreate({ stepKey: stepKey, name: name, parentId: parentId, sourceKeys: entries.map(function (entry) { return entry.key; }) }); }); },
      moveEntries: function (stepKey, entries, folderId, owner) { return ports.withPaneSync(owner.pane, function () { return actFolderMove({ stepKey: stepKey, folderId: folderId, sourceKeys: entries.map(function (entry) { return entry.key; }) }); }); },
      setStars: function (entries, on, owner) { return ports.withPaneSync(owner.pane, function () { return actStarTargets(entries.map(function (entry) { return ports.rawS.entries.find(function (raw) { return raw.id === entry.runtimeId && ports.entryOrgKey(raw) === entry.key; }); }).filter(Boolean), on); }); },
      openView: openAppOperationView, readPipeline: readAppOperationPipeline, writePipeline: writeAppOperationPipeline, durability: appOperationDurability,
    });
  }
  function actStarSet(args) {
    const stepKey = args.stepKey || 'plain';
    let targets;
    if (args.all) {
      targets = stepEntriesAlive(stepKey);
    } else {
      const bySource = new Map();
      for (const e of stepEntriesAlive(stepKey)) if (e.sourceKey) bySource.set(e.sourceKey, e);
      targets = (args.sourceKeys || []).map(function (key) {
        const hit = bySource.get(key);
        if (!hit) throw Error('成员不在步骤「' + stepKey + '」里: ' + key);
        return hit;
      });
    }
    return Object.assign(actStarTargets(targets, args.on), { stepKey: stepKey });
  }
  function actFilterByMetric(args) {
    const m = ports.S.metrics;
    if (args.mode === 'clear') {
      m.filters = [];
    } else {
      if (!m.table) throw Error('还没有导入指标表，无法按指标筛选');
      const col = m.table.columns.find(function (c) { return c.toLowerCase() === String(args.col || '').toLowerCase(); });
      if (!col) throw Error('指标表没有这一列: ' + args.col);
      if (!Number.isFinite(args.value)) throw Error('value 必须是数字');
      const rule = { col: col, op: args.op, value: args.value };
      if (args.mode === 'add') {
        m.filters = m.filters.filter(function (f) { return f.col !== col || f.op !== args.op; });
        m.filters.push(rule);
      } else m.filters = [rule];
    }
    ports.recomputeMetricRange();
    ports.renderList();
    ports.refreshMetricsStatus();
    ports.refreshBadge();
    ports.applyModeChange(true);
    return { filters: (m.filters || []).slice(), visible: ports.visibleEntries().length };
  }
  function registerActions() {
    installAppOperations();
    const A = window.SB_ACTIONS;
    if (!A || A.has('workspace.describe')) return;
    A.define('workspace.describe', {
      description: '只读：当前工作台快照（步骤、文件夹树、便签、成员、筛选状态）',
      mutates: false,
      args: {
        stepKey: { type: 'string', required: false, max: 120 },
        includeEntries: { type: 'boolean', required: false, default: true },
        includeMetrics: { type: 'boolean', required: false, default: false },
        includeNotes: { type: 'boolean', required: false, default: true },
        entryLimit: { type: 'number', required: false, default: 200, integer: true, min: 1, max: 1000 },
        entryOffset: { type: 'number', required: false, default: 0, integer: true, min: 0, max: 10000000 },
      },
      handler: describeWorkspace,
    });
    A.define('note.setStep', {
      description: '写某一步的便签（即时落本机，随后写入管线目录）',
      mutates: true,
      args: {
        stepKey: { type: 'string', required: true, max: 120 },
        text: { type: 'string', required: true, max: 5000 },
      },
      handler: actNoteSet,
    });
    A.define('organize.createFolder', {
      description: '在某一步新建工作台文件夹，可同时放入成员（不改磁盘文件）',
      mutates: true,
      args: {
        stepKey: { type: 'string', required: false, default: 'plain', max: 120 },
        name: { type: 'string', required: true, name: true, max: 60 },
        parentId: { type: 'string', required: false, max: 120 },
        sourceKeys: { type: 'array', required: false, item: 'string', max: 2000 },
      },
      handler: actFolderCreate,
    });
    A.define('organize.moveKeys', {
      description: '把成员移入某文件夹（folderId）或移回根层（folderId 留空 / "root"）',
      mutates: true,
      args: {
        stepKey: { type: 'string', required: true, max: 120 },
        sourceKeys: { type: 'array', required: true, item: 'string', max: 2000 },
        folderId: { type: 'string', required: false, max: 120 },
      },
      handler: actFolderMove,
    });
    A.define('organize.undo', {
      description: '撤销上一次整理动作（同 ORG 撤销栈）',
      mutates: true,
      args: {},
      handler: function () {
        if (!ports.ORG || !ports.ORG.canUndo()) throw Error('没有可撤销的整理');
        const item = ports.ORG.undo(ports.S.organization);
        ports.afterOrgChange(item.stepKey, '已撤销');
        return { stepKey: item.stepKey };
      },
    });
    A.define('organize.redo', {
      description: '重做被撤销的整理动作',
      mutates: true,
      args: {},
      handler: function () {
        if (!ports.ORG || !ports.ORG.canRedo()) throw Error('没有可重做的整理');
        const item = ports.ORG.redo(ports.S.organization);
        ports.afterOrgChange(item.stepKey, '已重做');
        return { stepKey: item.stepKey };
      },
    });
    A.define('star.set', {
      description: '批量设置/取消优选（显示层标记，可再次覆盖）',
      mutates: true,
      args: {
        stepKey: { type: 'string', required: false, default: 'plain', max: 120 },
        sourceKeys: { type: 'array', required: false, item: 'string', max: 2000 },
        all: { type: 'boolean', required: false, default: false },
        on: { type: 'boolean', required: true },
      },
      handler: actStarSet,
    });
    A.define('filter.byMetric', {
      description: '按指标列筛选（mode: replace/add/clear；replace 是默认）',
      mutates: true,
      permissionScope: 'view.write',
      args: {
        col: { type: 'string', required: false, max: 60 },
        op: { type: 'string', required: false, max: 2, enum: ['>=', '<=', '>', '<', '=', '!='] },
        value: { type: 'number', required: false },
        mode: { type: 'string', required: false, default: 'replace', max: 8, enum: ['replace', 'add', 'clear'] },
      },
      handler: actFilterByMetric,
    });
    A.define('view.setSearch', {
      description: '设置总览当前层的搜索词（空字符串清除）',
      mutates: true,
      readOnly: false,
      permissionScope: 'view.write',
      args: { text: { type: 'string', required: false, default: '', max: 200 } },
      handler: function (args) {
        if (!ports.overview) throw Error('总览尚未初始化');
        const applied = ports.applyOverviewSearch(String(args.text || ''));
        const stats = ports.overview.searchStats();
        return { applied: applied, visible: stats.visible, total: stats.total };
      },
    });
  }
// SERVICE_FUNCTIONS_END
  return { stepExists, stepEntriesAlive, resolveStepKeys, orgFolders, folderTreeFor, describeWorkspace, actNoteSet, actFolderCreate, actFolderMove, actStarTargets, resolvePanel, appOperationError, captureAppOperationOwner, checkAppOperationOwner, appOperationSnapshot, openAppOperationView, readAppOperationPipeline, writeAppOperationPipeline, appOperationDurability, installAppOperations, actStarSet, actFilterByMetric, registerActions };
}
