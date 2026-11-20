// notes: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function loadCustomSteps() {
    try {
      const list = JSON.parse(localStorage.getItem(ports.CUSTOM_STEPS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveCustomSteps() {
    try { localStorage.setItem(ports.CUSTOM_STEPS_KEY, JSON.stringify(ports.S.customSteps || [])); } catch (e) { /* ignore */ }
  }
  function loadStepEdits() { return ports.stepEditStore.load(); }
  function restoreStepEdits(saved) {
    // 按步骤、字段补缺；保留本机显式空串和本次运行中的内存新值。
    ports.stepEditStore.restore(saved);
  }
  function saveStepEdit(key, patch, options) {
    if (!key) return false;
    const locallySaved = ports.stepEditStore.save(key, patch);
    const custom = (ports.S.customSteps || []).find(function (s) { return s.key === key; });
    if (custom) {
      if (patch.title != null) custom.title = patch.title;
      if (patch.tool != null) custom.tool = patch.tool;
      if (patch.order != null) custom.order = patch.order;
      saveCustomSteps();
    }
    if (patch.title != null) {
      ports.S.entries.forEach(function (entry) { if (entry.stepKey === key) entry.stepTitle = patch.title; });
    }
    if (patch.tool != null) {
      ports.S.entries.forEach(function (entry) { if (entry.stepKey === key) entry.stepTool = patch.tool; });
    }
    // 便签传 quiet：内容已在输入时落盘，这里只是补工作区备份，不打断顶部状态。
    if (!ports.S.restoringSession) ports.scheduleSessionSave(options);
    return locallySaved;
  }
  function folderNoteOf(node) {
    const target = folderNoteTarget(node);
    if (!target || !folderNodeForNote(target.stepKey, target.folderId)) return '';
    const draft = ports.folderEditStore.find(target.stepKey, target.folderId);
    if (draft) return draft.deleted ? '' : draft.note;
    return organizationFolderNote(node);
  }
  function folderNoteTarget(node) {
    if (!node || !ports.ORG || node.kind !== 'folder' || node.origin === 'removed') return null;
    const stepKey = ports.stepKeyOfNode(node), id = node.origin === 'user' && node.orgId
      ? 'user:' + node.orgId : 'node:' + (node.id || node.groupKey || '');
    if (!stepKey || id === 'node:') return null;
    return { stepKey: stepKey, folderId: id };
  }
  function folderNodeForNote(stepKey, folderId) {
    if (!ports.ORG || (ports.S.trashSteps || []).some(function (item) { return item.key === stepKey; })
      || (loadStepEdits()[stepKey] || {}).deleted) return null;
    const org = ports.S.organization[stepKey];
    if (folderId.indexOf('user:') === 0) {
      const id = folderId.slice(5), folder = org && (org.folders || []).find(function (item) { return item.id === id; });
      return folder ? { kind: 'folder', origin: 'user', orgId: id, groupKey: id, id: 'folder:user:' + id, stepKey: stepKey } : null;
    }
    if (folderId.indexOf('node:') !== 0) return null;
    const id = folderId.slice(5), entries = ports.S.entries.filter(function (entry) {
      return (entry.stepKey || 'plain') === stepKey && !ports.entryIsTrashed(entry);
    });
    const nodes = ports.ORG.apply(ports.LINEAGE.nodes(entries, true), entries, org || ports.ORG.empty(),
      { lineage: ports.LINEAGE, stepKey: stepKey, grouped: true });
    const found = ports.LINEAGE.find(nodes, id);
    if (found && found.kind === 'folder') return Object.assign({}, found, { stepKey: stepKey });
    if (id === 'pile:' + stepKey && nodes.filter(function (item) { return item.kind === 'entry'; }).length > 8) {
      return { kind: 'folder', id: id, stepKey: stepKey };
    }
    return null;
  }
  function organizationFolderNote(node) {
    const org = ports.S.organization[ports.stepKeyOfNode(node)], notes = org && org.notes || {};
    const aliases = [node.id, node.groupKey, node.orgId];
    for (const key of aliases) if (key && Object.prototype.hasOwnProperty.call(notes, key)) return String(notes[key] == null ? '' : notes[key]);
    return '';
  }
  function applyFolderNote(node, value) {
    const org = ports.ORG.ensure(ports.S.organization, ports.stepKeyOfNode(node));
    if (!org.notes) org.notes = {};
    // Do not leave a legacy alias behind an explicit clear-to-empty.
    [node.groupKey, node.orgId].forEach(function (key) { if (key && key !== node.id) delete org.notes[key]; });
    org.notes[node.id] = value;
  }
  function folderNotePatchKey(target) {
    return '__structboard_folder_note__:' + encodeURIComponent(JSON.stringify([target.stepKey, target.folderId]));
  }
  function persistFolderNote(target, value) {
    const pipeline = pipelineNoteTarget(target.stepKey);
    if (!pipeline) return true;
    const patch = {}; patch[folderNotePatchKey(target)] = value;
    return ports.notesSync.put(pipeline.pid, patch);
  }
  function folderDraftError(error) {
    const message = String(error || '文件夹便签本机保存失败');
    ports.showSessionSaveState('error', message);
    if (folderDraftError.last !== message) ports.toast('文件夹便签保存失败，请保持窗口打开：' + message, true);
    folderDraftError.last = message;
  }
  function saveFolderNote(node, text) {
    const target = folderNoteTarget(node);
    if (!target || !folderNodeForNote(target.stepKey, target.folderId)) return false;
    const value = String(text == null ? '' : text);
    // Canonical text and the outbox are durable before this input handler returns.
    const localSaved = ports.folderEditStore.save(target.stepKey, target.folderId, value, false);
    ports.ORG.setNote(ports.S.organization, target.stepKey, node.id, value);
    applyFolderNote(node, value);
    const queued = persistFolderNote(target, value);
    ports.refreshOrgButtons();
    ports.scheduleSessionSave({ quiet: true });
    if (!localSaved || !queued) folderDraftError(ports.folderEditStore.error || ports.notesSync.storageError);
    else folderDraftError.last = '';
    return localSaved && queued;
  }
  function restoreFolderNotes(saved, workspaceId) {
    if (saved || workspaceId) ports.folderEditStore.restore(saved, workspaceId);
    let changed = false;
    Object.keys(ports.folderEditStore.snapshot()).forEach(function (key) {
      const draft = ports.folderEditStore.snapshot()[key];
      const node = folderNodeForNote(draft.stepKey, draft.folderId);
      if (!node) return; // A note never resurrects a deleted/dissolved folder.
      const value = draft.deleted ? '' : draft.note;
      if (organizationFolderNote(node) !== value) changed = true;
      applyFolderNote(node, value);
    });
    return changed;
  }
  function reconcileFolderNotes() {
    const drafts = ports.folderEditStore.snapshot();
    const steps = new Set((ports.S.customSteps || []).map(function (step) { return step.key; }));
    for (const entry of ports.S.entries) steps.add(entry.stepKey || 'plain');
    for (const step of ports.S.trashSteps || []) steps.add(step.key);
    Object.keys(drafts).forEach(function (key) {
      const draft = drafts[key];
      if (!steps.has(draft.stepKey) && !ports.S.organization[draft.stepKey]) return;
      const node = folderNodeForNote(draft.stepKey, draft.folderId);
      const deleted = !node, value = node ? organizationFolderNote(node) : '';
      if (draft.deleted === deleted && draft.note === value) return;
      if (!ports.folderEditStore.save(draft.stepKey, draft.folderId, value, deleted)) folderDraftError(ports.folderEditStore.error);
      persistFolderNote(draft, value);
    });
  }
  function hydrateFolderNotes(pid, values) {
    let changed = restoreFolderNotes();
    Object.keys(values).forEach(function (key) {
      const prefix = '__structboard_folder_note__:';
      if (key.indexOf(prefix) !== 0 || typeof values[key] !== 'string') return;
      try {
        const ids = JSON.parse(decodeURIComponent(key.slice(prefix.length)));
        if (!Array.isArray(ids) || ids.length !== 2 || typeof ids[0] !== 'string' || typeof ids[1] !== 'string') return;
        const target = pipelineNoteTarget(ids[0]);
        if (!target || target.pid !== pid || ports.folderEditStore.find(ids[0], ids[1])) return;
        const node = folderNodeForNote(ids[0], ids[1]);
        if (!node) return;
        if (!ports.folderEditStore.save(ids[0], ids[1], values[key], false)) folderDraftError(ports.folderEditStore.error);
        applyFolderNote(node, values[key]); changed = true;
      } catch (_) { /* Ignore malformed foreign folder keys. */ }
    });
    return changed;
  }
  function pipelineNoteTarget(key) {
    const text = String(key || '');
    const split = text.indexOf(':');
    if (split < 1) {
      const custom = (ports.S.customSteps || []).find(function (s) { return s.key === text; });
      return custom && custom.pipelineId ? { pid: custom.pipelineId, sid: '', localOnly: true } : null;
    }
    const pid = text.slice(0, split), sid = text.slice(split + 1);
    const known = ports.S.entries.some(function (e) { return e.pipelineId === pid && e.stepKey === text; })
      || (ports.S.customSteps || []).some(function (s) { return s.pipelineId === pid && s.key === text; })
      || pid === ports.S.activePipelineId;
    if (!sid || !known) return null;
    return { pid: pid, sid: sid, localOnly: false };
  }
  function stepNoteState(key) {
    const target = pipelineNoteTarget(key), localError = ports.stepEditStore.error;
    if (!target || target.localOnly) return localError
      ? { state: 'error', error: localError, localError: localError }
      : { state: 'local', error: '' };
    const status = ports.notesSync.status(target.pid, target.sid);
    if (localError || status.localError) return Object.assign({}, status, {
      state: 'error', localError: localError || status.localError,
      error: [localError, status.error].filter(Boolean).join('；'),
      pipelineSaved: !ports.notesSync.pending(target.pid, target.sid),
    });
    return status;
  }
  function persistStepNote(key, note) {
    const target = pipelineNoteTarget(key);
    if (!target || target.localOnly) return;
    const patch = {};
    patch[target.sid] = String(note == null ? '' : note);
    return ports.notesSync.put(target.pid, patch);
  }
  function saveStepNote(key, note) {
    const value = String(note == null ? '' : note), saved = loadStepEdits()[key];
    if (saved && saved.note === value && !ports.stepEditStore.error) return;
    // 便签本体在输入时已写本机并排队写管线；工作区快照只是备份，用静默模式。
    saveStepEdit(key, { note: value }, { quiet: true });
    persistStepNote(key, value); // Durable before returning from the input handler.
  }
  function retryStepNote(key) {
    ports.stepEditStore.persist();
    const saved = loadStepEdits()[key];
    if (saved && Object.prototype.hasOwnProperty.call(saved, 'note')) persistStepNote(key, saved.note);
    const target = pipelineNoteTarget(key);
    if (target && !target.localOnly) ports.notesSync.flush(target.pid);
    if (!ports.S.restoringSession) ports.scheduleSessionSave({ quiet: true });
    if (ports.overview && ports.overview.paintNoteStates) ports.overview.paintNoteStates();
  }
  function applyPendingStepNotes() {
    const pending = ports.notesSync.snapshot(), all = loadStepEdits();
    Object.keys(pending).forEach(function (pid) {
      Object.keys(pending[pid]).forEach(function (sid) {
        if (sid.indexOf('__structboard_folder_note__:') === 0 || sid.indexOf('__') === 0 || typeof pending[pid][sid] !== 'string') return;
        const key = pid + ':' + sid;
        if (!all[key] || all[key].note !== pending[pid][sid]) ports.stepEditStore.save(key, { note: pending[pid][sid] });
      });
    });
  }
  async function hydrateStepNotesFromPipeline(pipelineId) {
    const pid = pipelineId || ports.activePipelineId();
    if (!pid) return;
    if (ports.stepNoteHydrateRuns.has(pid)) return ports.stepNoteHydrateRuns.get(pid);
    const task = (async function () {
      const controller = new AbortController();
      const timeout = setTimeout(function () { controller.abort(); }, 10000);
      try {
        const response = await fetch('/api/notes?id=' + encodeURIComponent(pid), { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data || !data.ok || !data.notes) return;
        const disk = ports.notesSync.applyPending(pid, data.notes), all = loadStepEdits();
        let changed = hydrateFolderNotes(pid, disk);
        Object.keys(disk).forEach(function (sid) {
          if (sid.indexOf('__structboard_folder_note__:') === 0 || sid.indexOf('__') === 0 || typeof disk[sid] !== 'string') return;
          const key = pid + ':' + sid, saved = all[key] || {};
          if (Object.prototype.hasOwnProperty.call(saved, 'note')) return;
          saveStepEdit(key, { note: disk[sid] });
          changed = true;
        });
        if (changed && ports.S.mode === 'overview') ports.rebuildOverview();
        else if (ports.overview) ports.overview.paintNoteStates();
      } catch (error) { /* 本地服务不可用时保留本机草稿 */ }
      finally { clearTimeout(timeout); }
    })();
    ports.stepNoteHydrateRuns.set(pid, task);
    try { await task; } finally { ports.stepNoteHydrateRuns.delete(pid); }
  }
  function hydrateWorkspaceStepNotes() {
    const ids = new Set(ports.S.entries.map(function (e) { return e.pipelineId; }).filter(Boolean));
    if (ports.activePipelineId()) ids.add(ports.activePipelineId());
    return Promise.all(Array.from(ids).map(function (pid) { return hydrateStepNotesFromPipeline(pid); }));
  }
  function flushAllStepNotes() {
    for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
      if (pane.overview && pane.overview.flushNoteEdits) pane.overview.flushNoteEdits();
    }
    reconcileFolderNotes();
    if (!ports.folderEditStore.persist()) folderDraftError(ports.folderEditStore.error);
    const notes = Object.keys(ports.notesSync.snapshot()).length ? ports.notesSync.flush() : Promise.resolve();
    const workspace = ports.sessionSaveCoordinator ? ports.sessionSaveCoordinator.flush() : Promise.resolve();
    return Promise.all([notes, workspace]);
  }
// SERVICE_FUNCTIONS_END
  return { loadCustomSteps, saveCustomSteps, loadStepEdits, restoreStepEdits, saveStepEdit, folderNoteOf, folderNoteTarget, folderNodeForNote, organizationFolderNote, applyFolderNote, folderNotePatchKey, persistFolderNote, folderDraftError, saveFolderNote, restoreFolderNotes, reconcileFolderNotes, hydrateFolderNotes, pipelineNoteTarget, stepNoteState, persistStepNote, saveStepNote, retryStepNote, applyPendingStepNotes, hydrateStepNotesFromPipeline, hydrateWorkspaceStepNotes, flushAllStepNotes };
}
