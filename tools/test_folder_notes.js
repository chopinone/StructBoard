'use strict';

// Run: node tools/test_folder_notes.js
// Real local stores, note outbox, organization module, and extracted app note blocks.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const app = read('app.js');
const { createFolderStore, createStore } = require(path.join(root, 'notes_edit.js'));
const plain = value => JSON.parse(JSON.stringify(value));
function block(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'cannot locate real app block ' + start); return text.slice(a, b);
}
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, failKeys: new Set(), getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) { if (this.fail || this.failKeys.has(key)) throw Error('QuotaExceededError: ' + key); values.set(key, String(value)); },
    removeItem(key) { values.delete(key); } };
}
class Clock {
  now = 0; serial = 0; tasks = new Map();
  setTimeout = (fn, ms = 0) => { const id = ++this.serial; this.tasks.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = id => this.tasks.delete(id);
  async drain() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
  async advance(ms) {
    await this.drain(); const end = this.now + ms;
    for (let n = 0; ; n++) {
      const item = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break; assert(n < 200); this.tasks.delete(item[0]); this.now = item[1].at; item[1].fn(); await this.drain();
    }
    this.now = end; await this.drain();
  }
}
function network() {
  const calls = [];
  return { calls, fetch(url, init = {}) {
    const call = { url, method: init.method || 'GET', body: init.body && JSON.parse(init.body) }; calls.push(call);
    return new Promise((resolve, reject) => {
      call.respond = (data = { ok: true }, status = 200) => resolve({ ok: status < 400, status, json: async () => data });
      call.fail = reject;
    });
  } };
}
function node(stepKey = 'pipe:a', id = 'same-folder') {
  return { kind: 'folder', origin: 'user', orgId: id, groupKey: id,
    id: 'folder:user:' + id, stepKey, name: 'Folder', entries: [] };
}
function organization() { return { 'pipe:a': { folders: [{ id: 'same-folder', name: 'Folder', parentId: null }],
  notes: {}, placements: {}, removed: [], dissolved: [], layout: { version: 1, parents: {} } } }; }
function harness(store = storage(), savedOrg = organization()) {
  const clock = new Clock(), net = network();
  const c = vm.createContext({ localStorage: store, windowStorageKey: key => key, fetch: net.fetch, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, AbortController, console, location: { search: '' } });
  vm.runInContext('window=globalThis;', c);
  for (const file of ['notes_edit.js', 'notes_sync.js', 'lineage.js', 'workspace_org.js']) vm.runInContext(read(file), c);
  c.S = { organization: plain(savedOrg), entries: [{ id: 'e1', name: 'a', stepKey: 'pipe:a', pipelineId: 'pipe', sourceKey: 'source' }],
    customSteps: [], trashFolders: [], trashSteps: [], activePipelineId: 'pipe', mode: 'overview', restoringSession: false };
  c.ORG = c.SB_ORG; c.LINEAGE = c.SB_LINEAGE; c.overview = null;
  c.saves = []; c.errors = []; c.badge = []; c.pipelineSyncs = 0;
  c.scheduleSessionSave = options => c.saves.push(options || {});
  c.showSessionSaveState = (state, error) => c.badge.push({ state, error });
  c.toast = (message, error) => { if (error) c.errors.push(message); };
  c.refreshOrgButtons = c.saveCustomSteps = c.rebuildOverview = () => {};
  c.schedulePipelineSync = () => c.pipelineSyncs++;
  c.stepKeyOfNode = n => n.stepKey || n.entries?.[0]?.stepKey || 'plain';
  c.entryIsTrashed = () => false;
  const local = block(app, '  function loadStepEdits()', '  function applyGridPlace(');
  const functions = block(app, '  function pipelineNoteTarget(', '  function orderedStepBuckets(');
  const active = block(app, '  function activePipelineId()', '  function scheduleMarksSync(');
  const init = block(app, '  const stepEditStore = ', '  let marksSyncTimer = ');
  vm.runInContext(local + functions + active + init + '\nglobalThis.api={' +
    'folderNoteOf,saveFolderNote,restoreFolderNotes,reconcileFolderNotes,folderEditStore,loadStepEdits,notesSync,' +
    'hydrateStepNotesFromPipeline,applyPendingStepNotes};', c);
  return { c, api: c.api, store, clock, net };
}
let cases = 0;
async function test(name, run) { await run(); cases++; console.log('ok - ' + name); }
(async () => {
  await test('separate folder store synchronously recovers exact text before timers or network', async () => {
    const store = storage(), drafts = createFolderStore({ storage: store, makeId: () => 'workspace' });
    assert.equal(drafts.save('pipe:a', 'user:same-folder', '中文 café\nrecover immediately'), true);
    const restarted = createFolderStore({ storage: store });
    assert.equal(restarted.find('pipe:a', 'user:same-folder').note, '中文 café\nrecover immediately');
    assert.equal(store.getItem('structboard.stepEdits'), null, 'folder drafts use an independent namespace');
  });
  await test('atomic empty values and tombstones defeat stale snapshot fallback', async () => {
    const store = storage(), drafts = createFolderStore({ storage: store, makeId: () => 'workspace' });
    drafts.save('pipe:a', 'user:f', 'old'); const old = drafts.snapshot();
    drafts.save('pipe:a', 'user:f', ''); drafts.restore(old, 'workspace');
    assert.equal(drafts.find('pipe:a', 'user:f').note, '');
    drafts.save('pipe:a', 'user:f', '', true); drafts.restore(old, 'workspace');
    assert.equal(drafts.find('pipe:a', 'user:f').deleted, true);
    const restart = createFolderStore({ storage: store }); restart.restore(old, 'workspace');
    assert.equal(restart.find('pipe:a', 'user:f').deleted, true);
  });
  await test('snapshot fallback works with missing or malformed local storage and validates metadata', async () => {
    const original = createFolderStore({ storage: storage(), makeId: () => 'workspace' });
    original.save('pipe:a', 'user:f', 'fallback'); const saved = plain(original.snapshot());
    for (const initial of [{}, { 'structboard.folderEdits': '{broken' }]) {
      const restored = createFolderStore({ storage: storage(initial) }); restored.restore(saved, 'workspace');
      assert.equal(restored.find('pipe:a', 'user:f').note, 'fallback');
    }
    const invalid = createFolderStore({ storage: storage({ 'structboard.workspaceId': 'workspace',
      'structboard.folderEdits': JSON.stringify({ 'wrong-key': Object.values(saved)[0],
        '["workspace","pipe:a","user:f"]': { ...Object.values(saved)[0], note: 42 } }) }) });
    assert.equal(invalid.find('pipe:a', 'user:f'), null);
  });
  await test('workspace, step, and folder identity isolate drafts and reset cannot inherit old notes', async () => {
    const store = storage(); let serial = 0;
    const drafts = createFolderStore({ storage: store, makeId: () => 'workspace-' + (++serial) });
    drafts.save('pipe:a', 'user:f', 'A'); drafts.save('pipe:b', 'user:f', 'B'); drafts.save('pipe:a', 'user:g', 'G');
    assert.equal(drafts.find('pipe:a', 'user:f').note, 'A'); assert.equal(drafts.find('pipe:b', 'user:f').note, 'B');
    const old = drafts.snapshot(), oldId = drafts.workspaceId; drafts.reset(); drafts.restore(old, oldId);
    assert.equal(drafts.find('pipe:a', 'user:f'), null); assert.deepEqual(plain(drafts.snapshot()), {});
    const restart = createFolderStore({ storage: store }); assert.equal(restart.find('pipe:a', 'user:f'), null);
  });
  await test('quota errors retain canonical memory and can later persist without stale reread', async () => {
    const store = storage(), drafts = createFolderStore({ storage: store, makeId: () => 'workspace' });
    drafts.save('pipe:a', 'user:f', 'old'); store.fail = true;
    assert.equal(drafts.save('pipe:a', 'user:f', 'new in memory'), false); assert.match(drafts.error, /QuotaExceeded/);
    assert.equal(drafts.find('pipe:a', 'user:f').note, 'new in memory');
    assert.equal(Object.values(drafts.snapshot())[0].note, 'new in memory');
    store.fail = false; assert.equal(drafts.persist(), true); assert.equal(drafts.error, '');
    assert.equal(createFolderStore({ storage: store }).find('pipe:a', 'user:f').note, 'new in memory');
  });
  await test('existing step-store field fallback semantics remain intact', async () => {
    const store = createStore({ storage: storage() }); store.save('pipe:a', { note: '' });
    store.restore({ 'pipe:a': { note: 'stale', title: 'recover title' } });
    assert.deepEqual(plain(store.load()['pipe:a']), { note: '', title: 'recover title' });
  });
  await test('real folder input writes durable drafts immediately and restores over an older snapshot', async () => {
    const store = storage(), h = harness(store), folder = node();
    h.api.saveFolderNote(folder, 'instant text');
    assert.equal(h.api.folderNoteOf(folder), 'instant text'); assert.equal(h.net.calls.length, 0);
    assert.equal(h.c.pipelineSyncs, 0, 'typing does not GET and replace an entire pipeline definition');
    const record = Object.values(JSON.parse(store.getItem('structboard.folderEdits')))[0]; assert.equal(record.note, 'instant text');
    const snapshotOrg = organization(); snapshotOrg['pipe:a'].notes[folder.id] = 'older snapshot';
    const restarted = harness(store, snapshotOrg); restarted.api.restoreFolderNotes();
    assert.equal(restarted.api.folderNoteOf(folder), 'instant text');
    assert.equal(restarted.c.S.organization['pipe:a'].notes[folder.id], 'instant text');
  });
  await test('real clear-to-empty masks every legacy alias and remains empty after restart and hydration', async () => {
    const store = storage(), org = organization(), folder = node();
    org['pipe:a'].notes = { [folder.id]: 'old', [folder.orgId]: 'old alias' };
    const h = harness(store, org); h.api.saveFolderNote(folder, '');
    assert.equal(h.api.folderNoteOf(folder), '');
    const restarted = harness(store, org); restarted.api.restoreFolderNotes(); assert.equal(restarted.api.folderNoteOf(folder), '');
    const task = restarted.api.hydrateStepNotesFromPipeline('pipe');
    const key = Object.keys(restarted.api.notesSync.snapshot().pipe)[0];
    restarted.net.calls[0].respond({ ok: true, notes: { [key]: 'disk old', a: 'step text' } }); await task;
    assert.equal(restarted.api.folderNoteOf(folder), ''); assert.equal(restarted.api.loadStepEdits()['pipe:a'].note, 'step text');
  });
  await test('folder patches share the per-key notes outbox and never hydrate into step notes', async () => {
    const h = harness(), folder = node(); h.api.saveFolderNote(folder, 'folder');
    h.api.notesSync.put('pipe', { a: 'step', __structboard_marks__: { count: 1 } });
    const pending = plain(h.api.notesSync.snapshot().pipe), key = Object.keys(pending).find(k => k.startsWith('__structboard_folder_note__:'));
    assert(key); assert.equal(pending[key], 'folder'); h.api.applyPendingStepNotes();
    assert.equal(h.api.loadStepEdits()['pipe:' + key], undefined);
    await h.clock.advance(320); assert.equal(h.net.calls.length, 1); assert.equal(h.net.calls[0].method, 'POST');
    assert.deepEqual(h.net.calls[0].body, { id: 'pipe', patch: pending }); assert.equal(h.net.calls[0].body.notes, undefined);
    h.net.calls[0].respond(); await h.clock.drain(); assert.deepEqual(plain(h.api.notesSync.snapshot()), {});
    const task = h.api.hydrateStepNotesFromPipeline('pipe'); h.net.calls[1].respond({ ok: true, notes: { [key]: 'disk', b: 'B' } }); await task;
    assert.equal(h.api.loadStepEdits()['pipe:' + key], undefined); assert.equal(h.api.loadStepEdits()['pipe:b'].note, 'B');
  });
  await test('deleted folders are tombstoned and recovery never creates the absent target', async () => {
    const store = storage(), h = harness(store), folder = node(); h.api.saveFolderNote(folder, 'keep isolated');
    h.c.ORG.deleteFolder(h.c.S.organization, 'pipe:a', folder); h.api.reconcileFolderNotes();
    const snapshot = h.api.folderEditStore.snapshot(); assert.equal(Object.values(snapshot)[0].deleted, true);
    h.api.restoreFolderNotes(); assert.equal(h.c.S.organization['pipe:a'].folders.length, 0);
    const restarted = harness(store, h.c.S.organization); restarted.api.restoreFolderNotes(snapshot, h.api.folderEditStore.workspaceId);
    assert.equal(restarted.c.S.organization['pipe:a'].folders.length, 0); assert.equal(restarted.api.folderNoteOf(folder), '');
    restarted.c.S.organization['pipe:a'].folders.push({ id: 'different', name: 'Replacement', parentId: null });
    assert.equal(restarted.api.folderNoteOf(node('pipe:a', 'different')), '');
  });
  await test('a stale input callback cannot recreate a removed folder or its note', async () => {
    const h = harness(), folder = node(); h.c.ORG.deleteFolder(h.c.S.organization, 'pipe:a', folder);
    assert.equal(h.api.saveFolderNote(folder, 'stale textarea'), false);
    assert.equal(h.c.S.organization['pipe:a'].folders.length, 0); assert.equal(h.api.folderNoteOf(folder), '');
  });
  await test('folder storage failure is visible immediately and snapshot recovery retains memory', async () => {
    const h = harness(); h.store.fail = true; const folder = node();
    assert.equal(h.api.saveFolderNote(folder, 'quota draft'), false); assert.match(h.c.badge.at(-1).error, /QuotaExceeded/);
    assert.equal(h.c.badge.at(-1).state, 'error'); assert.equal(h.api.folderNoteOf(folder), 'quota draft');
    const saved = plain(h.api.folderEditStore.snapshot()), workspace = h.api.folderEditStore.workspaceId;
    const restored = harness(); restored.api.restoreFolderNotes(saved, workspace);
    assert.equal(restored.api.folderNoteOf(folder), 'quota draft');
    h.store.fail = false; assert.equal(h.api.folderEditStore.persist(), true); assert.equal(h.api.folderEditStore.error, '');
  });
  console.log('folder notes ok (' + cases + ' cases; durable drafts, real app hooks, patch isolation, quota and deletion)');
})().catch(error => { console.error(error); process.exitCode = 1; });
