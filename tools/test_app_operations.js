'use strict';
// Execute the real dispatcher and app operation functions with pane/runtime and organization stores.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../app_operations.js');
const runtime = require('../pane_runtime.js');
const org = require('../workspace_org.js');
const notes = require('../notes_edit.js');
const actionsSource = fs.readFileSync(path.join(__dirname, '../actions.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').replace(/\r\n/g, '\n');
const copy = value => JSON.parse(JSON.stringify(value));
function functionSource(name) {
  const start = app.indexOf('  function ' + name + '(') >= 0 ? app.indexOf('  function ' + name + '(') : app.indexOf('  async function ' + name + '(');
  assert(start >= 0, 'Missing executable app function ' + name);
  const firstLineEnd = app.indexOf('\n', start);
  if (app.slice(start, firstLineEnd).trimEnd().endsWith('}')) return app.slice(start, firstLineEnd);
  const end = app.indexOf('\n  }', start);
  assert(end >= 0, 'Missing function end ' + name); return app.slice(start, end + 4);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  org.clearHistory();
  const stored = new Map(), storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) };
  const stepEditStore = notes.createStore({ storage }), folderEditStore = notes.createFolderStore({ storage, makeId: () => 'fixture-workspace' });
  const rawS = { entries: [
    { id: 'e1', name: 'local.pdb', sourceKey: null, path: 'demo/local.pdb', size: 12, stepKey: null, data: 'ATOM', metrics: { confidence: 80, unsafe: 'E:/secret/raw' } },
    { id: 'e2', name: 'other.pdb', sourceKey: null, path: 'demo/other.pdb', size: 15, stepKey: null, data: 'ATOM', metrics: { confidence: 90 } },
    { id: 'e3', name: 'pipe.pdb', sourceKey: 'E:/private/data|prediction.pdb', size: 20, stepKey: 'design:s1', pipelineId: 'design', stepTitle: 'Prediction', data: 'ATOM', metrics: { confidence: 95 } },
  ], organization: {}, customSteps: [], metrics: { filters: [] }, activePipelineId: 'design', workspaceEpoch: 0, trashSteps: [], trashFolders: [] };
  const initial = { mode: 'overview', cols: 2, rows: 2, page: 0, filter: '', gridPinned: [], theme: 'per-structure', repr: 'cartoon' };
  const viewKeys = [...Object.keys(initial), 'gridViewers', 'gridCells', 'gridLoadErrors', 'overlayRefs', 'starOnly', 'soloId', 'listNav', 'gridFromOverview', 'gridDrill', 'overviewGrouped', 'maxOverlay', 'referenceId', 'aligned'];
  const panes = [runtime.createPane(initial, viewKeys, { index: 0 }), runtime.createPane(initial, viewKeys, { index: 1 })];
  const writes = [], marks = [], renders = [], pendingNotes = [], saveCalls = [];
  for (const pane of panes) pane.overview = { capture: () => ({ drillId: null }), current: () => null, mark: entry => marks.push([pane.id, entry.id]), searchQuery: () => '', scrollToStep: key => renders.push(['scroll', pane.id, key]) };
  let renderGate = null, fetchGate = null, definition = { id: 'design', name: 'Design', root: 'E:/private/data', steps: [{ id: 's1', title: 'Prediction', tool: 'predict', globs: ['prediction/*.pdb'], files: [{ name: 'pipe.pdb', path: 'prediction/pipe.pdb', lineage: { artifactKind: 'prediction' } }], lineage: { artifactKind: 'prediction' } }] };
  let context;
  const globals = {
    window: {}, console, Object, Array, Map, Set, WeakMap, String, Number, Boolean, JSON, Error, Promise, Proxy, Date,
    AbortController, File, URL, rawS, panes, PANE_RUNTIME: runtime, PANE_VIEW_SET: new Set(viewKeys), ORG: org, stepEditStore, folderEditStore,
    localStorage: storage, splitState: { active: true }, sessionSaveCoordinator: null, workspaceWindowKey: 'main',
    notesSync: { storageError: '', put: (pid, patch) => { pendingNotes.push({ pid, patch: copy(patch) }); return true; } },
    IO: { readFile: async file => ({ data: await file.text(), format: 'pdb', size: file.size }), parse: () => ({ atoms: [] }) },
    document: { getElementById: () => null },
    scheduleSessionSave: value => saveCalls.push(value || {}), saveCustomSteps: () => {},
    refreshStepsUI: () => renders.push(['steps']), renderList: () => renders.push(['list', currentPane().id]), refreshBadge: () => {},
    afterOrgChange: stepKey => { saveCalls.push({ stepKey }); },
    saveMarks: () => stored.set('marks', JSON.stringify(rawS.entries.map(entry => !!entry.star))),
    toast: () => {}, ensureOverview: pane => (pane || currentPane()).overview,
    armGridFromOverview: place => { currentPane().view.gridFromOverview = place || {}; }, applyGridPlace: () => {},
    splitOn: () => { globals.splitState.active = true; vm.runInContext('activePane = 0', context); if (panes.length < 2) panes.push(runtime.createPane(initial, viewKeys, { index: 1 })); },
    setMode(mode, opts, value) {
      const pane = value || currentPane(); pane.view.mode = mode;
      if (mode === 'grid') return globals.rebuildGrid(pane);
      if (mode === 'overlay') return globals.rebuildOverlay(true, pane);
      return Promise.resolve();
    },
    rebuildGrid(value) {
      const pane = value || currentPane();
      const selected = rawS.entries.filter(entry => pane.view.gridPinned.includes(entry.id));
      const task = (async () => { if (renderGate) await renderGate.promise; if (pane.disposed) return;
        pane.view.gridViewers = selected.slice(0, pane.view.cols * pane.view.rows).map(entry => ({ entryId: entry.id, ref: {} }));
        renders.push(['grid', pane.id, selected.map(entry => entry.id)]);
      })(); pane.runtime.queues.grid = task; return task;
    },
    rebuildOverlay(busy, value) {
      const pane = value || currentPane(), selected = rawS.entries.filter(entry => pane.view.gridPinned.includes(entry.id));
      const task = (async () => { if (renderGate) await renderGate.promise; if (pane.disposed) return;
        pane.view.overlayRefs = selected.map(entry => ({ id: entry.id, ref: {} })); renders.push(['overlay', pane.id, selected.map(entry => entry.id)]);
      })(); pane.runtime.queues.overlay = task; return task;
    },
    async fetch(url, options) {
      if (fetchGate) await fetchGate.promise;
      if (url.startsWith('/api/pipeline?id=')) return { ok: true, json: async () => ({ ok: true, pipeline: copy(definition) }) };
      if (url === '/api/pipeline/import') { const body = JSON.parse(options.body); writes.push(body); definition = copy(body.definition); return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: !url.includes('failed'), arrayBuffer: async () => new TextEncoder().encode('ATOM').buffer };
    },
  };
  context = vm.createContext(globals);
  vm.runInContext(actionsSource, context);
  context.window.SB_APP_OPERATIONS_CORE = core;
  const operationBlock = app.slice(app.indexOf('  function stepExists('), app.indexOf('  /* ---------------- AI 生成管线'));
  const helpers = ['paneAt', 'paneContext', 'withPaneSync', 'paneView', 'entryOrgKey', 'stepIsTrashed', 'entryIsTrashed', 'activePipelineId', 'pipelineFolderWorkspaceId', 'loadStepEdits', 'saveStepEdit', 'pipelineNoteTarget', 'persistStepNote', 'saveStepNote', 'orderedStepBuckets', 'stepKeyOfNode', 'folderNoteOf', 'folderNoteTarget', 'folderNodeForNote', 'organizationFolderNote', 'openBenchWithEntries'];
  vm.runInContext("let activePane=0, scopedPane=null, overview=panes[0].overview; const S = new Proxy(rawS,{get:(target,key)=>PANE_VIEW_SET.has(key)?paneAt().view[key]:target[key],set:(target,key,value)=>{if(PANE_VIEW_SET.has(key))paneAt().view[key]=value;else target[key]=value;return true;}});\n" + helpers.map(functionSource).join('\n') + '\n' + operationBlock + '\nregisterActions();', context);
  function currentPane() { return vm.runInContext('paneAt()', context); }
  return { api: context.window.SB_APP_OPERATIONS, actions: context.window.SB_ACTIONS, rawS, panes, stored, stepEditStore, folderEditStore, writes, marks, pendingNotes, renders, saveCalls,
    focus(index) { vm.runInContext('activePane=' + index + '; overview=panes[activePane].overview;', context); },
    set renderGate(value) { renderGate = value; }, set fetchGate(value) { fetchGate = value; },
    get definition() { return definition; }, set definition(value) { definition = value; }, context,
  };
}
async function setup(h) {
  const context = await h.api.execute('sb_get_context', {}), list = await h.api.execute('sb_list_entries', { includeMetrics: true });
  assert(context.ok, JSON.stringify(context)); assert(list.ok, JSON.stringify(list));
  return { context: context.result, entries: list.result.items, revision: list.revision };
}
let cases = 0;
async function test(name, run) { await run(); cases++; console.log('ok - ' + name); }
(async () => {
  await test('strict schemas, metadata, bounds, nested path validation, and unknown fields', async () => {
    const h = harness(), tools = h.api.listTools(); assert.equal(tools.length, 9);
    assert(tools.every(tool => tool.inputSchema.additionalProperties === false && typeof tool.readOnly === 'boolean'));
    assert.equal((await h.api.execute('sb_get_context', { rogue: true })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await h.api.execute('sb_list_entries', { limit: 0 })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await h.api.execute('sb_list_entries', { limit: 501 })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await h.api.execute('sb_view_open', { paneId: h.panes[1].id, mode: 'grid', cols: 9 })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await h.api.execute('sb_get_context', {}, { scopes: ['edit'] })).error.code, 'PERMISSION_DENIED');
    assert.equal((await h.api.execute('eval', {})).error.code, 'UNKNOWN_TOOL');
    for (const value of ['../x.pdb', 'a/../../x.pdb', 'C:/x.pdb', '/x.pdb', '//server/file', 'a\\x.pdb', 'a/%2e%2e/x', 'a:stream', 'a/./b', 'a/../b']) assert.equal(core.isRelative(value), false, value);
    const search = h.actions.list().find(action => action.name === 'view.setSearch'); assert.equal(search.readOnly, false); assert.equal(search.permissionScope, 'view.write');
    assert.equal((await h.actions.act('workspace.describe', { entryLimit: -1 })).ok, false);
    assert.equal((await h.actions.act('workspace.describe', { evil: true })).ok, false);
  });
  await test('opaque local and pipeline handles, metric filtering, notes filtering, and real pagination', async () => {
    const h = harness(); org.createFolder(h.rawS.organization, 'plain', { id: 'with-note', name: 'Folder' });
    org.setNote(h.rawS.organization, 'plain', 'folder:user:with-note', 'FOLDER SECRET'); h.stepEditStore.save('plain', { note: 'STEP SECRET' });
    const info = await h.api.execute('sb_get_context', { includeNotes: false, includeMetrics: true }); assert(info.ok, JSON.stringify(info));
    const json = JSON.stringify(info); assert(!json.includes('SECRET')); assert(!json.includes('E:/')); assert(!json.includes('sourceKey')); assert(!json.includes('ATOM'));
    assert(info.result.metricColumns.includes('confidence')); assert(!info.result.metricColumns.includes('unsafe'));
    const first = await h.api.execute('sb_list_entries', { limit: 1, includeMetrics: true });
    assert.equal(first.result.items.length, 1); assert.equal(first.result.total, 3); assert(first.result.nextCursor);
    assert(first.result.items[0].entryId.startsWith('entry_')); assert.equal(first.result.items[0].metrics.confidence, 80);
    const second = await h.api.execute('sb_list_entries', { cursor: first.result.nextCursor, limit: 2, includeMetrics: true });
    assert.equal(second.result.offset, 1); assert.equal(second.result.items.length, 2); assert.equal(second.result.nextCursor, null);
    assert.notEqual(first.result.items[0].entryId, second.result.items[0].entryId);
    const legacy = await h.actions.act('workspace.describe', { includeNotes: false }); assert(!JSON.stringify(legacy).includes('SECRET'));
    h.rawS.entries[0].name = 'renamed.pdb';
    assert.equal((await h.api.execute('sb_list_entries', { cursor: first.result.nextCursor, includeMetrics: true })).error.code, 'REVISION_CONFLICT');
  });
  await test('real organization keys, note persistence, revision conflicts, and idempotency once', async () => {
    const h = harness(), state = await setup(h), plain = state.context.steps.find(step => step.title === '其他导入');
    const noteArgs = { stepId: plain.stepId, text: 'saved note', expectedRevision: state.revision, idempotencyKey: 'note-once' };
    const note = await h.api.execute('sb_notes_set', noteArgs); assert(note.ok, JSON.stringify(note));
    assert.equal(JSON.parse(h.stored.get('structboard.stepEdits')).plain.note, 'saved note');
    const again = await h.api.execute('sb_notes_set', noteArgs); assert.deepEqual(again, note);
    assert.equal((await h.api.execute('sb_notes_set', { ...noteArgs, text: 'different' })).error.code, 'IDEMPOTENCY_CONFLICT');
    const folderArgs = { stepId: plain.stepId, name: 'Selected', entryIds: [state.entries[0].entryId], expectedRevision: note.revision, idempotencyKey: 'folder-once' };
    const [created, duplicate] = await Promise.all([h.api.execute('sb_folder_create', folderArgs), h.api.execute('sb_folder_create', folderArgs)]);
    assert(created.ok, JSON.stringify(created)); assert.deepEqual(created, duplicate); assert.equal(h.rawS.organization.plain.folders.length, 1);
    const internalId = h.rawS.organization.plain.folders[0].id;
    assert.equal(h.rawS.organization.plain.placements[org.placeId(h.rawS.entries[0])], internalId);
    assert.equal(h.rawS.organization.plain.placements[state.entries[0].entryId], undefined);
    const moved = await h.api.execute('sb_folder_move', { stepId: plain.stepId, entryIds: [state.entries[0].entryId], expectedRevision: created.revision, idempotencyKey: 'move-root' });
    assert(moved.ok, JSON.stringify(moved)); assert.equal(h.rawS.organization.plain.placements[org.placeId(h.rawS.entries[0])], undefined);
    h.rawS.entries[1].star = true;
    assert.equal((await h.api.execute('sb_star_set', { entryIds: [state.entries[0].entryId], on: true, expectedRevision: moved.revision, idempotencyKey: 'stale-star' })).error.code, 'REVISION_CONFLICT');
    const now = await h.api.getContext(), starred = await h.api.execute('sb_star_set', { entryIds: [state.entries[0].entryId], on: true, expectedRevision: now.revision, idempotencyKey: 'star' });
    assert(starred.ok, JSON.stringify(starred)); assert.equal(h.rawS.entries[0].star, true); assert.equal(h.marks.length, 2);
    const cross = await h.api.execute('sb_folder_create', { ...folderArgs, entryIds: [state.entries[2].entryId], expectedRevision: starred.revision, idempotencyKey: 'cross' });
    assert.equal(cross.error.code, 'INVALID_ARGUMENT');
  });
  await test('view subset targets captured pane across focus changes and waits for actual render', async () => {
    const h = harness(), state = await setup(h), gate = deferred(); h.renderGate = gate;
    const beforeLeft = copy(h.panes[0].view), right = h.panes[1];
    let settled = false;
    const task = h.api.execute('sb_view_open', { paneId: right.id, entryIds: [state.entries[1].entryId], mode: 'grid', cols: 1, rows: 1 }).then(result => { settled = true; return result; });
    for (let i = 0; i < 10; i++) await Promise.resolve(); h.focus(0); assert.equal(settled, false);
    gate.resolve(); const result = await task; assert(result.ok, JSON.stringify(result));
    assert.deepEqual(result.result.loaded, [state.entries[1].entryId]); assert.deepEqual(result.result.failed, []);
    assert.deepEqual(copy(h.panes[0].view), beforeLeft); assert.deepEqual(copy(right.view.gridPinned), ['e2']);
    assert(h.renders.some(call => call[0] === 'grid' && call[1] === right.id && call[2].join(',') === 'e2'));
    const overlay = await h.api.execute('sb_view_open', { paneId: right.id, entryIds: [state.entries[0].entryId, state.entries[2].entryId], mode: 'overlay', cols: 2, rows: 1 });
    assert(overlay.ok, JSON.stringify(overlay)); assert.equal(overlay.result.loaded.length, 2); assert.equal(overlay.result.pending.length, 0);
  });
  await test('owner guards prevent stale lazy publish and replaced panes are not updated', async () => {
    const h = harness(), state = await setup(h), gate = deferred();
    delete h.rawS.entries[0].data; h.rawS.entries[0].fetchUrl = '/existing/local.pdb'; h.fetchGate = gate;
    const task = h.api.execute('sb_view_open', { paneId: h.panes[1].id, entryIds: [state.entries[0].entryId], mode: 'grid' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    h.rawS.workspaceEpoch++; h.panes[1].disposed = true; h.panes[1].life++; gate.resolve();
    const result = await task; assert.equal(result.error.code, 'STALE_OWNER'); assert.equal(h.rawS.entries[0].data, undefined); assert.equal(h.renders.some(call => call[0] === 'grid'), false);
    const newContext = await h.api.getContext(); assert.notEqual(newContext.result.workspaceId, state.context.workspaceId);
    const stale = await h.api.execute('sb_star_set', { entryIds: [state.entries[0].entryId], on: true, expectedRevision: newContext.revision, idempotencyKey: 'old-handle' }); assert.equal(stale.error.code, 'NOT_FOUND');
  });
  await test('lazy failures return explicit failed handles without opening unrelated entries', async () => {
    const h = harness(), state = await setup(h); delete h.rawS.entries[0].data; h.rawS.entries[0].fetchUrl = '/failed/local.pdb';
    const result = await h.api.execute('sb_view_open', { paneId: h.panes[1].id, entryIds: [state.entries[0].entryId], mode: 'grid' });
    assert(result.ok, JSON.stringify(result)); assert.deepEqual(result.result.failed, [state.entries[0].entryId]); assert.deepEqual(result.result.loaded, []); assert(!h.renders.some(call => call[0] === 'grid'));
  });
  await test('pipeline preview is read-only, apply commits exact approved candidate, and repeats once', async () => {
    const h = harness(), state = await setup(h), get = await h.api.execute('sb_pipeline_get', { pipelineId: state.context.pipelineId });
    assert(get.ok, JSON.stringify(get)); assert(!JSON.stringify(get).includes('E:/')); assert(!JSON.stringify(get).includes('root"'));
    const args = { pipelineId: get.result.definition.pipelineId, expectedRevision: get.revision, idempotencyKey: 'pipeline-edit', operations: [{ op: 'update_step', stepId: get.result.definition.steps[0].stepId, patch: { title: 'Reviewed', globs: ['reviewed/*.pdb'] } }] };
    const preview = await h.api.execute('sb_pipeline_apply', args, { phase: 'prepare', sessionId: 'session' });
    assert(preview.ok, JSON.stringify(preview)); assert.equal(h.writes.length, 0); assert.equal(preview.result.diff.after.steps[0].title, 'Reviewed'); assert(preview.result.preparedId);
    assert.equal((await h.api.execute('sb_pipeline_apply', args, { phase: 'apply', sessionId: 'session' })).error.code, 'APPROVAL_REQUIRED');
    assert.equal((await h.api.execute('sb_pipeline_apply', args, { phase: 'apply', approved: true, sessionId: 'session' })).error.code, 'PREPARE_REQUIRED');
    assert.equal((await h.api.execute('sb_pipeline_apply', { ...args, operations: [{ op: 'set_name', name: 'Altered after approval' }] }, { phase: 'apply', approved: true, prepared: preview.result, sessionId: 'session' })).error.code, 'PREPARE_REQUIRED');
    const applied = await h.api.execute('sb_pipeline_apply', args, { phase: 'apply', approved: true, prepared: preview, sessionId: 'session' });
    assert(applied.ok, JSON.stringify(applied)); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].definition.root, 'E:/private/data'); assert.equal(h.writes[0].definition.steps[0].title, 'Reviewed');
    assert.deepEqual(h.writes[0].definition.steps[0].files[0].lineage, { artifactKind: 'prediction' }); assert.equal(h.writes[0].definition.steps[0]._key, undefined);
    const replay = await h.api.execute('sb_pipeline_apply', args, { phase: 'apply', approved: true, prepared: preview, sessionId: 'session' }); assert.deepEqual(replay, applied); assert.equal(h.writes.length, 1);
    const badPath = await h.api.execute('sb_pipeline_apply', { ...args, operations: [{ op: 'update_step', stepId: args.operations[0].stepId, patch: { files: [{ path: '../escape.pdb' }] } }] }, { phase: 'prepare' }); assert.equal(badPath.error.code, 'INVALID_ARGUMENT');
  });
  await test('pipeline definition change after preview conflicts without writing', async () => {
    const h = harness(), get = await h.api.execute('sb_pipeline_get', {});
    const args = { pipelineId: get.result.definition.pipelineId, expectedRevision: get.revision, idempotencyKey: 'pipeline-stale', operations: [{ op: 'set_name', name: 'Next' }] };
    const preview = await h.api.execute('sb_pipeline_apply', args, { phase: 'prepare' }); assert(preview.ok, JSON.stringify(preview));
    h.definition = { ...h.definition, name: 'User edit while confirming' };
    const applied = await h.api.execute('sb_pipeline_apply', args, { phase: 'apply', approved: true, prepared: preview.result }); assert.equal(applied.error.code, 'REVISION_CONFLICT'); assert.equal(h.writes.length, 0);
  });
  console.log('app operations ok (' + cases + ' executable cases)');
})().catch(error => { console.error(error); process.exitCode = 1; });
