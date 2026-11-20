'use strict';

// Runs the real editor, outbox, overview hook mapping, and extracted app/canvas
// note blocks. No Mol*, backend, science files, browser, or real timers are used.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const app = read('app.js'), overview = read('overview.js'), pipeline = read('pipeline.html');
const plain = value => JSON.parse(JSON.stringify(value));
function block(text, start, end) {
  const begin = text.indexOf(start), finish = text.indexOf(end, begin + start.length);
  assert(begin >= 0 && finish > begin, 'cannot locate real code block: ' + start);
  return text.slice(begin, finish);
}
class Clock {
  constructor() { this.now = 0; this.id = 0; this.tasks = new Map(); }
  setTimeout = (fn, ms = 0) => { const id = ++this.id; this.tasks.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = id => this.tasks.delete(id);
  async drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async advance(ms) {
    await this.drain();
    const end = this.now + ms;
    for (let count = 0; ; count++) {
      const next = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert(count < 1000, 'unexpected timer loop');
      this.tasks.delete(next[0]); this.now = next[1].at; next[1].fn();
      await this.drain();
    }
    this.now = end;
    await this.drain();
  }
}
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, failKeys: new Set(),
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (this.fail || this.failKeys.has(key)) throw Error('QuotaExceededError: ' + key);
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}
function network() {
  const calls = [];
  return { calls, fetch(url, init = {}) {
    const call = { url, method: init.method || 'GET', body: init.body && JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    return new Promise((resolve, reject) => {
      call.respond = (data = { ok: true }, status = 200) => resolve({ ok: status < 400, status, json: async () => data });
      call.fail = reject;
    });
  } };
}
function element(value = '') {
  const events = new Map(), classes = new Set();
  return { value, dataset: {}, textContent: '', hidden: true, title: '', attributes: {},
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute(name, text) { this.attributes[name] = text; },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    dispatch(name) { for (const fn of events.get(name) || []) fn({ stopPropagation() {} }); },
  };
}
function baseContext(store) {
  const clock = new Clock(), net = network();
  // Real pages always have location; the pipeline status path now targets location.origin.
  const context = vm.createContext({ localStorage: store, windowStorageKey: key => key, fetch: net.fetch, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, AbortController, console,
    location: { origin: 'http://127.0.0.1:8000' } });
  vm.runInContext('window=globalThis;global=globalThis;window.addEventListener=function(){};', context);
  vm.runInContext(read('notes_sync.js') + '\n' + read('notes_edit.js'), context);
  return { context, clock, net, store };
}
function makeApp(store = storage()) {
  const h = baseContext(store), c = h.context;
  c.S = { entries: [{ pipelineId: 'pipe', stepKey: 'pipe:a' }, { pipelineId: 'other', stepKey: 'other:b' }],
    customSteps: [{ key: 'custom', pipelineId: 'pipe' }], activePipelineId: 'pipe', mode: 'overview', restoringSession: false };
  c.rawS = c.S;
  c.saves = 0; c.paints = 0; c.rebuilds = 0;
  c.scheduleSessionSave = () => c.saves++;
  c.saveCustomSteps = () => {};
  c.overview = { paintNoteStates: () => c.paints++, scrollToStep: () => true };
  c.rebuildOverview = () => c.rebuilds++;
  c.closePipeline = () => {};
  c.toast = () => {};
  c.$ = () => ({ contentWindow: { postMessage() {} } });
  vm.runInContext(read('lineage.js') + '\n' + read('workspace_org.js'), c);
  c.ORG = c.SB_ORG; c.LINEAGE = c.SB_LINEAGE;
  c.S.organization = {}; c.S.trashFolders = []; c.S.trashSteps = [];
  c.stepKeyOfNode = node => node.stepKey || 'plain';
  c.entryIsTrashed = () => false;
  c.refreshOrgButtons = c.schedulePipelineSync = c.showSessionSaveState = () => {};
  const pane = { view: c.S, overview: c.overview, disposed: false };
  c.paneAt = () => pane;
  c.paneContext = () => c.S;
  c.withPaneSync = (owner, fn) => fn();
  c.setMode = mode => { c.S.mode = mode; };
  const local = block(app, '  function loadStepEdits()', '  function applyGridPlace(');
  const functions = block(app, '  function pipelineNoteTarget(', '  function orderedStepBuckets(');
  const active = block(app, '  function activePipelineId()', '  function scheduleMarksSync(');
  const init = block(app, '  const stepEditStore = ', '  let marksSyncTimer = ');
  const hooks = block(app, '        onStepNote: ', '        onStepAction: ');
  const snapshot = block(app, '    restoreStepEdits(snap.stepEdits);', '    S.definitionFingerprints = ');
  const open = block(app, '    async function openPipelineStep(d)', "    window.addEventListener('message'");
  vm.runInContext(local + functions + active + init + '\nconst noteHooks={' + hooks + '};\n' +
    'function restoreSnapshotNotes(snap){' + snapshot + '}\n' + open + '\n' +
    'globalThis.api={loadStepEdits,saveStepEdit,restoreStepEdits,saveStepNote,retryStepNote,stepNoteState,' +
    'hydrateStepNotesFromPipeline,hydrateWorkspaceStepNotes,openPipelineStep,restoreSnapshotNotes,notesSync,stepEditStore,noteHooks};', c);
  h.api = c.api;
  const factory = block(overview, '        box.noteEdit = global.SB_NOTE_EDIT.create({', '        box.dataset.sectionId = node.id;');
  const flush = block(overview, '      function flushNoteEdits() {', '      function paintSection(');
  const unload = block(overview, '        for (const [id, box] of sections) if (!desired.has(id)) {', "        $('overviewEmpty')");
  vm.runInContext('globalThis.bindEditor=function(box,area,currentSection,hooks){' + factory + 'return box.noteEdit;};' +
    'globalThis.flushOverviewNotes=function(items,unmount){const sections=new Map(items.map(x=>[x.key,x.box]));' +
    'const list=items.map(x=>({kind:"section",id:x.key,stepKey:x.key}));const hooks={};' + flush +
    'if(unmount){const desired=new Set();' + unload + '}else flushNoteEdits();};', c);
  h.flushEditors = (items, unmount = false) => c.flushOverviewNotes(items, unmount);
  h.editor = (key, value = '') => {
    let node = { note: value, stepKey: key };
    const area = element(value), label = element(), retry = element(), button = element();
    const box = { dataset: { stepKey: key }, querySelector(selector) {
      return ({ '.overview-note-state': label, '.overview-note-retry': retry, '.overview-note-btn': button })[selector];
    } };
    box.remove = () => { box.removed = true; };
    const edit = c.bindEditor(box, area, () => node, h.api.noteHooks);
    return { key, box, edit, area, label, retry, button, input(text) { area.value = text; area.dispatch('input'); },
      rebuild() { node = { note: (h.api.loadStepEdits()[key] || {}).note || '', stepKey: key }; return node; },
      get node() { return node; } };
  };
  return h;
}
function makeCanvas(store = storage()) {
  const h = baseContext(store), c = h.context;
  c.S = { mode: 'api', apiId: 'pipe', apiData: { notes: {} }, nodes: [
    { id: 'api_a', apiStepId: 'a', note: 'old' }, { id: 'api_b', apiStepId: 'b', note: 'old-b' }], edges: [], sel: 'api_a' };
  c.document = { addEventListener() {}, querySelector() { return null; } };
  c.label = element();
  c.$ = () => c.label;
  c.byId = id => c.S.nodes.find(n => n.id === id);
  c.canvasState = () => ({ notes: { api_a: 'stale legacy canvas', api_b: 'stale legacy canvas' } });
  c.writeCanvas = c.saveCanvas = () => { throw Error('API notes must not rewrite the canvas'); };
  const functions = block(pipeline, 'function setNodeNote(n,text){', 'function openNoteEditor(');
  const restore = block(pipeline, 'function restoreCanvas(){', 'function canDeleteNode(');
  const sync = block(pipeline, '// 与主窗口使用同一实现、独立存储键', 'function useDemo(){');
  vm.runInContext(functions + restore + sync + '\nglobalThis.api={setNodeNote,restoreCanvas,scheduleNoteSave,flushNotes,canvasNotesSync};', c);
  h.api = c.api;
  return h;
}
let cases = 0;
async function test(name, run) { await run(); cases++; console.log('ok - ' + name); }
(async () => {
  await test('input is durable before debounce; abrupt close/restart replays the exact text', async () => {
    const store = storage(), h = makeApp(store), e = h.editor('pipe:a');
    e.input('中文 café draft');
    assert.equal(e.node.note, '中文 café draft');
    assert(e.button.classList.contains('has-note'));
    assert.equal(e.label.dataset.state, 'saving', 'status paints on input');
    assert.equal(JSON.parse(store.getItem('structboard.stepEdits'))['pipe:a'].note, '中文 café draft');
    assert.deepEqual(JSON.parse(store.getItem('structboard.notesPending')), { pipe: { a: '中文 café draft' } });
    assert.equal(h.net.calls.length, 0);
    assert.equal(h.clock.tasks.size, 1, 'one network debounce, no editor save timer');
    const restarted = makeApp(store);
    assert.equal(restarted.api.loadStepEdits()['pipe:a'].note, '中文 café draft');
    await restarted.clock.advance(0);
    assert.deepEqual(restarted.net.calls[0].body, { id: 'pipe', patch: { a: '中文 café draft' } });
    restarted.net.calls[0].respond();
    await restarted.clock.drain();
    assert.deepEqual(JSON.parse(store.getItem('structboard.notesPending')), {});
  });
  await test('untouched blur/unmount writes nothing; redraw and duplicate blur cannot roll back input', async () => {
    const h = makeApp(), e = h.editor('pipe:a');
    e.edit.commit(); e.area.dispatch('blur'); e.area.dispatch('change');
    assert.equal(h.store.values.size, 0, 'untouched empty boxes are not local edits');
    e.input('new'); e.rebuild();
    e.area.value = 'stale DOM value'; // A redraw must not save an old textarea value on blur.
    e.area.dispatch('blur'); e.area.dispatch('change'); e.edit.commit();
    assert.equal(h.api.loadStepEdits()['pipe:a'].note, 'new');
    await h.clock.drain();
    assert.equal(h.net.calls.length, 1);
    assert.deepEqual(h.net.calls[0].body.patch, { a: 'new' });
    h.net.calls[0].respond(); await h.clock.drain();
    e.edit.commit(); await h.clock.advance(1000);
    assert.equal(h.net.calls.length, 1, 'no post-ACK duplicate from scrolling/blur');
  });
  await test('real overview leave and virtual unmount ignore every untouched empty editor', async () => {
    const h = makeApp(), edits = [h.editor('pipe:a'), h.editor('pipe:b'), h.editor('plain')];
    h.flushEditors(edits); h.flushEditors(edits, true); await h.clock.drain();
    assert.equal(h.store.values.size, 0); assert.equal(h.net.calls.length, 0);
    assert(edits.every(e => e.box.removed));
    edits[0].input('only edited box'); h.flushEditors(edits, true); await h.clock.drain();
    assert.equal(h.net.calls.length, 1);
    assert.deepEqual(h.net.calls[0].body.patch, { a: 'only edited box' });
    assert.equal(h.api.loadStepEdits()['pipe:b'], undefined); assert.equal(h.api.loadStepEdits().plain, undefined);
    h.net.calls[0].respond(); await h.clock.drain(); h.flushEditors(edits); await h.clock.advance(1000);
    assert.equal(h.net.calls.length, 1);
  });
  await test('rapid input uses one network debounce with the latest text', async () => {
    const h = makeApp(), e = h.editor('pipe:a');
    e.input('a'); await h.clock.advance(200); e.input('ab');
    await h.clock.advance(319); assert.equal(h.net.calls.length, 0);
    await h.clock.advance(1);
    assert.equal(h.net.calls.length, 1); assert.deepEqual(h.net.calls[0].body.patch, { a: 'ab' });
    h.net.calls[0].respond(); await h.clock.drain();
  });
  await test('failure retains durable text, exposes retry, and clears status only after ACK', async () => {
    const h = makeApp(), e = h.editor('pipe:a');
    e.input('keep me'); e.area.dispatch('blur'); await h.clock.drain();
    h.net.calls[0].respond({ ok: false, error: 'disk denied' }); await h.clock.drain(); e.edit.paint();
    assert.equal(e.label.dataset.state, 'error'); assert.equal(e.retry.hidden, false);
    assert.equal(h.api.notesSync.snapshot().pipe.a, 'keep me');
    assert.match(e.label.textContent, /草稿已留在本机/);
    e.retry.dispatch('click'); await h.clock.drain();
    assert.equal(h.net.calls.length, 2); assert.equal(h.api.stepNoteState('pipe:a').state, 'saving');
    h.net.calls[1].respond(); await h.clock.drain(); e.edit.paint();
    assert.equal(e.label.dataset.state, 'saved'); assert.equal(e.retry.hidden, true);
  });
  await test('quota failure keeps canonical edits through rebuild and snapshot; plain/custom report local failure', async () => {
    const h = makeApp(storage({ 'structboard.stepEdits': JSON.stringify({ 'pipe:a': { note: 'old' } }) }));
    h.store.fail = true;
    for (const key of ['pipe:a', 'plain', 'custom']) {
      const e = h.editor(key, key === 'pipe:a' ? 'old' : '');
      e.input('memory ' + key); e.rebuild();
      assert.equal(e.node.note, 'memory ' + key);
      assert.equal(e.label.dataset.state, 'error'); assert.equal(e.retry.hidden, false);
      assert.match(e.label.textContent, /本机保存失败/); assert.doesNotMatch(e.label.textContent, /草稿已留在本机/);
    }
    const snapshotEdits = plain(h.api.loadStepEdits());
    assert.equal(snapshotEdits.plain.note, 'memory plain');
    const fallback = makeApp(); fallback.api.restoreSnapshotNotes({ stepEdits: snapshotEdits, notesPending: h.api.notesSync.snapshot() });
    assert.equal(fallback.api.loadStepEdits().plain.note, 'memory plain');
    assert.equal(fallback.api.notesSync.snapshot().pipe.a, 'memory pipe:a');
    h.store.fail = false; h.api.retryStepNote('plain'); h.api.retryStepNote('custom');
    assert.equal(h.api.stepNoteState('plain').state, 'local'); assert.equal(h.api.stepNoteState('custom').state, 'local');
    assert.equal(JSON.parse(h.store.getItem('structboard.stepEdits')).plain.note, 'memory plain');
  });
  await test('successful pipeline write with local storage failure never claims both copies saved', async () => {
    const h = makeApp(), e = h.editor('pipe:a'); h.store.fail = true;
    e.input('remote safe'); e.edit.commit(); await h.clock.drain();
    h.net.calls[0].respond(); await h.clock.drain(); e.edit.paint();
    assert.equal(e.label.dataset.state, 'error'); assert.match(e.label.textContent, /管线已保存.*本机保存失败/);
    assert.equal(e.rebuild().note, 'remote safe');
    h.store.fail = false; e.retry.dispatch('click'); await h.clock.drain();
    h.net.calls[1].respond(); await h.clock.drain(); e.edit.paint();
    assert.equal(e.label.dataset.state, 'saved');
  });
  await test('clear-to-empty survives ACK, restart, stale snapshot, and disk hydration', async () => {
    const store = storage(), h = makeApp(store), e = h.editor('pipe:a', 'old');
    e.input(''); e.edit.commit(); await h.clock.drain();
    assert.deepEqual(h.net.calls[0].body.patch, { a: '' });
    h.net.calls[0].respond(); await h.clock.drain();
    const restarted = makeApp(store);
    restarted.api.restoreSnapshotNotes({ stepEdits: { 'pipe:a': { note: 'stale snapshot', title: 'title' } },
      notesPending: { pipe: { a: 'stale ACKed draft' } } });
    assert.deepEqual(plain(restarted.api.notesSync.snapshot()), {});
    const hydrated = restarted.api.hydrateStepNotesFromPipeline('pipe');
    restarted.net.calls[0].respond({ ok: true, notes: { a: 'disk older', b: '', c: 'disk only', __structboard_marks__: {} } });
    await hydrated;
    assert.equal(restarted.api.loadStepEdits()['pipe:a'].note, '');
    assert.equal(restarted.api.loadStepEdits()['pipe:a'].title, 'title', 'snapshot merges missing fields');
    assert.equal(restarted.api.loadStepEdits()['pipe:b'].note, '', 'explicit disk empty is hydrated');
    assert.equal(restarted.api.loadStepEdits()['pipe:c'].note, 'disk only');
    assert.equal(restarted.api.loadStepEdits()['pipe:__structboard_marks__'], undefined);
  });
  await test('snapshot fills individual fields; current outbox beats older snapshot and storage', async () => {
    const h = makeApp(storage({ 'structboard.stepEdits': JSON.stringify({ 'pipe:a': { title: 'current title' } }),
      'structboard.notesPending': JSON.stringify({ pipe: { a: '' } }) }));
    h.api.restoreSnapshotNotes({ stepEdits: { 'pipe:a': { title: 'old title', note: 'old text' }, 'pipe:b': { note: 'recovered' } },
      notesPending: { pipe: { a: 'stale', z: 'must not replay' } } });
    assert.deepEqual(plain(h.api.loadStepEdits()['pipe:a']), { title: 'current title', note: '' });
    assert.equal(h.api.loadStepEdits()['pipe:b'].note, 'recovered');
    assert.deepEqual(plain(h.api.notesSync.snapshot()), { pipe: { a: '' } });
  });
  await test('two fields and newer in-flight input are independently ordered and ACKed', async () => {
    const h = makeApp(), a = h.editor('pipe:a'), b = h.editor('pipe:b');
    a.input('A1'); b.input('B1'); await h.clock.advance(320);
    assert.deepEqual(h.net.calls[0].body.patch, { a: 'A1', b: 'B1' });
    a.input('A2'); b.input(''); a.edit.commit(); b.edit.commit(); await h.clock.drain();
    assert.equal(h.net.calls.length, 1, 'no overlapping writes to the same document');
    h.net.calls[0].respond(); await h.clock.drain();
    assert.deepEqual(plain(h.api.notesSync.snapshot()), { pipe: { a: 'A2', b: '' } });
    await h.clock.advance(0);
    assert.deepEqual(h.net.calls[1].body.patch, { a: 'A2', b: '' });
    h.net.calls[1].respond(); await h.clock.drain();
    assert.deepEqual(plain(h.api.notesSync.snapshot()), {});
  });
  await test('hydration cannot overwrite text typed or cleared while GET was pending', async () => {
    const h = makeApp(), a = h.editor('pipe:a');
    const task = h.api.hydrateStepNotesFromPipeline('pipe');
    a.input('during GET'); h.editor('pipe:b', 'old').input('');
    h.net.calls[0].respond({ ok: true, notes: { a: 'old disk', b: 'old disk', c: 'disk' } }); await task;
    assert.equal(h.api.loadStepEdits()['pipe:a'].note, 'during GET');
    assert.equal(h.api.loadStepEdits()['pipe:b'].note, '');
    assert.equal(h.api.loadStepEdits()['pipe:c'].note, 'disk');
  });
  await test('startup hydrates every open pipeline; opening an existing step also fetches its notes', async () => {
    const h = makeApp(); const task = h.api.hydrateWorkspaceStepNotes();
    assert.deepEqual(h.net.calls.map(c => c.url).sort(), ['/api/notes?id=other', '/api/notes?id=pipe']);
    h.net.calls.forEach(c => c.respond({ ok: true, notes: { a: 'disk' } })); await task;
    await h.api.openPipelineStep({ id: 'pipe', stepId: 'a' });
    assert.equal(h.net.calls[2].url, '/api/notes?id=pipe');
    h.net.calls[2].respond({ ok: true, notes: {} }); await h.clock.drain();
    assert(app.includes('    hydrateWorkspaceStepNotes();'), 'init must call workspace note hydration');
  });
  await test('hung fetch times out, retains current edit, retries, and ignores a late stale ACK', async () => {
    const h = makeApp(), e = h.editor('pipe:a');
    e.input('A1'); e.edit.commit(); await h.clock.drain();
    e.input('A2'); await h.clock.advance(10000);
    assert.equal(h.api.stepNoteState('pipe:a').state, 'error'); assert.equal(h.net.calls[0].signal.aborted, true);
    assert.equal(h.api.notesSync.snapshot().pipe.a, 'A2');
    await h.clock.advance(2000); assert.equal(h.net.calls.length, 2);
    assert.deepEqual(h.net.calls[1].body.patch, { a: 'A2' });
    h.net.calls[0].respond(); await h.clock.drain();
    assert.equal(h.api.notesSync.pending('pipe', 'a'), true, 'late timed-out request must not ACK the new edit');
    h.net.calls[1].respond(); await h.clock.drain(); assert.equal(h.api.stepNoteState('pipe:a').state, 'saved');
  });
  await test('canvas input is immediately durable and ok:false remains queued across restart', async () => {
    const store = storage(), h = makeCanvas(store), n = h.context.S.nodes[0];
    h.api.setNodeNote(n, 'canvas draft');
    assert.deepEqual(JSON.parse(store.getItem('structboard.pipelineNotesPending')), { pipe: { a: 'canvas draft' } });
    await h.clock.advance(320);
    assert.deepEqual(h.net.calls[0].body, { id: 'pipe', patch: { a: 'canvas draft' } });
    h.net.calls[0].respond({ ok: false, error: 'disk denied' }); await h.clock.drain();
    assert.equal(h.api.canvasNotesSync.status('pipe', 'a').state, 'error');
    const restart = makeCanvas(store); restart.api.restoreCanvas();
    assert.equal(restart.context.S.nodes[0].note, 'canvas draft', 'pending overrides disk/legacy canvas');
    assert.equal(restart.context.S.nodes[1].note, 'old-b', 'legacy API canvas notes must not override disk');
    await restart.clock.advance(0); restart.net.calls[0].respond(); await restart.clock.drain();
    assert.deepEqual(JSON.parse(store.getItem('structboard.pipelineNotesPending')), {});
    restart.api.setNodeNote(restart.context.S.nodes[0], ''); await restart.clock.advance(320);
    assert.deepEqual(restart.net.calls[1].body.patch, { a: '' });
  });
  await test('canvas and app use independent durable keys and per-field patches', async () => {
    const store = storage(), a = makeApp(store), canvas = makeCanvas(store);
    a.editor('pipe:a').input('overview'); canvas.api.setNodeNote(canvas.context.S.nodes[1], 'canvas');
    assert.deepEqual(JSON.parse(store.getItem('structboard.notesPending')), { pipe: { a: 'overview' } });
    assert.deepEqual(JSON.parse(store.getItem('structboard.pipelineNotesPending')), { pipe: { b: 'canvas' } });
    await a.clock.advance(320); await canvas.clock.advance(320);
    assert.deepEqual(a.net.calls[0].body.patch, { a: 'overview' });
    assert.deepEqual(canvas.net.calls[0].body.patch, { b: 'canvas' });
  });
  // Compile each inline script as actually shipped, and check the two required assets.
  let script = 0;
  for (const match of pipeline.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(match[1])) new vm.Script(match[2], { filename: 'pipeline-inline-' + (++script) });
  }
  for (const html of [read('index.html'), pipeline]) {
    for (const asset of ['notes_sync.js', 'notes_edit.js']) assert(html.includes('src="' + asset), 'missing note asset: ' + asset);
  }
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const assets = JSON.parse(execFileSync(process.env.STRUCTBOARD_TEST_PYTHON || 'python', [
    '-I', '-B', '-c',
    'import json,sys; sys.path.insert(0,sys.argv[1]); import resource_contract as c; names=c.resource_paths(sys.argv[1]); c.validate_references(sys.argv[1],names); print(json.dumps(names))',
    root,
  ], { encoding: 'utf8' }));
  for (const asset of ['notes_sync.js', 'notes_edit.js']) assert(assets.includes(asset), 'missing desktop asset: ' + asset);
  console.log('step note edit ok (' + cases + ' cases; real app/overview/canvas note blocks; inline scripts compile)');
})().catch(error => { console.error(error); process.exitCode = 1; });
