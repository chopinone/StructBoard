'use strict';
// Run: node tools/test_canvas_bridge.js
// Executes the real adapter, message receiver, and pipeline inline integration in a VM.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const Canvas = require('../canvas_document.js');
const Bridge = require('../canvas_bridge.js');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
let count = 0;
const tests = [];
function test(name, run) { tests.push({ name, run }); }
const baseNodes = () => [{ id: 'api_a', title: 'A', tool: 'rf3', desc: 'science', note: 'old', x: 40, y: 34, binding: { stepId: 'a' } },
  { id: 'api_b', title: 'B', tool: '', desc: '', note: '', x: 320, y: 34, binding: { stepId: 'b' } }];
function adapter(store = new Map()) {
  const model = { key: 'api:pipe', canvasId: 'api:pipe', baseNodes: baseNodes(), baseEdges: [['api_a', 'api_b']],
    nodes: baseNodes(), edges: [['api_a', 'api_b']], selection: ['api_a'], viewport: { scale: .85, tx: 16, ty: 16 }, privateRoots: ['X:/private/root'] };
  const h = { model, store, writes: 0, publications: 0, notes: [], fail: false, ack: false, notesDurable: true };
  h.controller = Bridge.create({ readContext: () => model, loadOverlay: key => plain(store.get(key) || {}),
    saveOverlay(key, value) { if (h.fail) throw Error('quota with private path'); h.writes++; store.set(key, plain(value)); },
    publish(s) { h.publications++; Object.assign(model, { nodes: plain(s.nodes), edges: plain(s.edges), selection: plain(s.selection), viewport: plain(s.viewport) }); },
    notes(changes, enqueue) { if (enqueue) h.notes.push(...plain(changes)); return { backendAck: changes.length ? h.ack : null, notesLocalDurable: h.notesDurable }; } });
  h.controller.restore(); h.api = h.controller.api; return h;
}
let serial = 0;
function change(h, operations, extra) { const s = h.api.getSnapshot(); return { canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'bridge_' + (++serial), operations, ...extra }; }
function fail(r, code) { assert.equal(r.ok, false); assert.equal(r.error.code, code, JSON.stringify(r)); }
function windowHarness(origin = 'http://127.0.0.1:8000') {
  const events = new Map(), sent = [];
  const parent = { postMessage(data, target) { sent.push({ data: plain(data), target }); } };
  const win = { parent, location: { origin }, addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  return { win, parent, sent, dispatch(data, extra) { return events.get('message')({ source: parent, origin, data, ...extra }); } };
}
const nonce = '0123456789abcdef0123456789abcdef';
const hello = { type: 'sb.canvas.hello', v: 1, nonce };
function request(op, args, id = 'request_' + (++serial), extra) { return { type: 'sb.canvas.request', v: 1, requestId: id, nonce, op, args, ...extra }; }

test('adapter publishes atomic candidates and reports renderer local and backend durability separately', () => {
  const h = adapter(), r = h.api.applyChange(change(h, [{ op: 'note.set', id: 'api_a', text: 'new' }]));
  assert(r.ok); assert.equal(h.model.nodes[0].note, 'new'); assert.equal(h.writes, 1); assert.equal(r.result.rendererApplied, true);
  assert.equal(r.result.localDurable, true); assert.equal(r.result.backendAck, false); assert(!('noteChanges' in r.result));
  h.ack = true; assert.equal(h.api.getSnapshot().durability.backendAck, true);
});
test('storage write failure rolls back renderer and retains candidate without leaking storage exception', () => {
  const h = adapter(), before = h.api.getSnapshot(); h.fail = true;
  const r = h.api.applyChange(change(h, [{ op: 'node.delete', id: 'api_b' }])); fail(r, 'STORAGE_WRITE_FAILED');
  assert.equal(h.model.nodes.length, 2); assert.equal(h.api.getSnapshot().revision, before.revision); assert.equal(h.controller.recoverySnapshot().nodes.length, 1);
  assert(!JSON.stringify(r).includes('private path')); assert.equal(h.writes, 0);
});
test('local renderer edits increment revision and conflict with an old external request', () => {
  const h = adapter(), a = change(h, [{ op: 'node.delete', id: 'api_b' }]);
  h.model.nodes[0].title = 'typed locally'; fail(h.api.applyChange(a), 'REVISION_CONFLICT');
  assert.equal(h.api.getSnapshot().revision, 1); assert.equal(h.store.get('api:pipe').document.overrides.api_a.title, 'typed locally');
  const revision = h.api.getSnapshot().revision; h.model.viewport.tx = 100; h.controller.observeLocal(false);
  assert.equal(h.api.getSnapshot().revision, revision); assert.equal(h.api.getSnapshot().viewRevision, 1);
});
test('adapter reload retains base visual overrides manual graph and viewport', () => {
  const h = adapter(); const r = h.api.applyChange(change(h, [
    { op: 'node.move', id: 'api_a', x: 123, y: 456 }, { op: 'node.update', id: 'api_a', props: { title: 'renamed' } },
    { op: 'node.create', node: { id: 'manual', title: 'M', x: 7, y: 8 } },
    { op: 'edge.connect', from: 'api_a', to: 'manual' }, { op: 'viewport.set', viewport: { scale: 1.2, tx: 1, ty: 2 } }]));
  assert(r.ok); const next = adapter(h.store); assert.deepEqual(next.api.getSnapshot(), h.api.getSnapshot());
});
test('prepare never persists and apply commits exactly the cached candidate', () => {
  const h = adapter(), a = change(h, [{ op: 'node.delete', id: 'api_b' }]);
  const p = h.api.prepareChange(a); assert(p.ok); assert.equal(h.writes, 0); assert.equal(h.model.nodes.length, 2);
  assert(p.result.diff.changes.some(c => c.kind === 'delete'));
  fail(h.api.applyChange(a, { prepared: 'wrong' }), 'PREPARED_MISMATCH');
  const r = h.api.applyChange(a, { prepared: p.result.prepared }); assert(r.ok); assert.equal(h.writes, 1); assert.equal(h.model.nodes.length, 1);
  const undo = { canvasId: 'api:pipe', expectedRevision: 1, changeId: r.result.changeId, idempotencyKey: 'undo_prepared' };
  const up = h.api.prepareUndo(undo); assert(up.ok); assert.equal(h.model.nodes.length, 1); assert(h.api.undoChange(undo, { prepared: up.result.prepared }).ok); assert.equal(h.model.nodes.length, 2);
});
test('prepared request fails if the user changes selection or content before approval returns', () => {
  const h = adapter(), a = change(h, [{ op: 'node.delete', id: 'api_b' }]), p = h.api.prepareChange(a);
  h.model.selection = ['api_b']; fail(h.api.applyChange(a, { prepared: p.result.prepared }), 'REVISION_CONFLICT'); assert.equal(h.model.nodes.length, 2);
});
test('snapshot and prepared diff redact known private root text and reject extra snapshot flags', () => {
  const h = adapter(); h.model.nodes[0].note = 'at X:/private/root/secret';
  const s = h.api.getSnapshot(); assert(!JSON.stringify(s).includes('X:/private/root'));
  const p = h.api.prepareChange(change(h, [{ op: 'node.delete', id: 'api_a' }])); assert(p.ok); assert(!JSON.stringify(p).includes('X:/private/root'));
  assert.throws(() => h.api.getSnapshot({ includePrivate: true }), /Unknown/);
});
test('bridge accepts only exact parent source origin and lifecycle-bound nonce', async () => {
  const h = adapter(), w = windowHarness(); Bridge.installPostMessage(w.win, h.api);
  await w.dispatch(request('snapshot', {})); assert.equal(w.sent.length, 0);
  await w.dispatch(hello, { source: {} }); await w.dispatch(hello, { origin: 'https://foreign.example' }); assert.equal(w.sent.length, 0);
  await w.dispatch({ ...hello, nonce: 'too-short' }); await w.dispatch({ ...hello, extra: true }); assert.equal(w.sent.length, 0);
  await w.dispatch(hello); assert.deepEqual(w.sent[0].data, { type: 'sb.canvas.ready', v: 1, nonce }); assert.equal(w.sent[0].target, w.win.location.origin);
  await w.dispatch({ ...hello, nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }); assert.equal(w.sent.length, 1);
  await w.dispatch(request('snapshot', {}, 'wrong_nonce', { nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })); assert.equal(w.sent.length, 1);
  await w.dispatch(request('snapshot', {})); assert.equal(w.sent[1].data.ok, true); assert.equal(w.sent[1].data.result.canvasId, 'api:pipe');
});
test('bridge rejects malformed huge extra-field and foreign operation requests without writes', async () => {
  const h = adapter(), w = windowHarness(); Bridge.installPostMessage(w.win, h.api); await w.dispatch(hello);
  await w.dispatch(null); await w.dispatch('malformed'); await w.dispatch([]);
  await w.dispatch(request('apply', change(h, [{ op: 'node.delete', id: 'api_b' }]), 'extra', { approved: true }));
  await w.dispatch(request('snapshot', { x: 'x'.repeat(300000) }, 'huge')); assert.equal(w.sent.length, 1);
  await w.dispatch(request('eval', {}, 'eval')); fail(w.sent.at(-1).data, 'INVALID_OPERATION');
  await w.dispatch(request('prepare', { kind: 'apply', change: {}, extra: true })); fail(w.sent.at(-1).data, 'INVALID_ARGUMENT');
  assert.equal(h.writes, 0);
});
test('real message handlers run snapshot prepare apply and undo with matching envelopes', async () => {
  const h = adapter(), w = windowHarness(); Bridge.installPostMessage(w.win, h.api); await w.dispatch(hello);
  const a = change(h, [{ op: 'node.delete', id: 'api_b' }]); await w.dispatch(request('prepare', { kind: 'apply', change: a })); const p = w.sent.at(-1).data;
  assert(p.ok); await w.dispatch(request('apply', a, 'apply_real', { prepared: p.result.prepared })); const r = w.sent.at(-1).data;
  assert(r.ok); assert.equal(h.model.nodes.length, 1); assert.equal(r.type, 'sb.canvas.response'); assert.equal(r.nonce, nonce);
  await w.dispatch(request('undo', { canvasId: 'api:pipe', expectedRevision: 1, changeId: r.result.changeId, idempotencyKey: 'undo_real' })); assert(w.sent.at(-1).data.ok); assert.equal(h.model.nodes.length, 2);
});
test('duplicate request IDs do not execute a second mutation', async () => {
  const h = adapter(), w = windowHarness(); Bridge.installPostMessage(w.win, h.api); await w.dispatch(hello);
  const r = request('apply', change(h, [{ op: 'note.set', id: 'api_a', text: 'new' }]), 'same'); await w.dispatch(r); await w.dispatch(r);
  fail(w.sent.at(-1).data, 'DUPLICATE_REQUEST'); assert.equal(h.writes, 1);
});
test('cancel message and pre-aborted API context prevent commit without claiming rollback', async () => {
  const h = adapter(), w = windowHarness(); Bridge.installPostMessage(w.win, h.api); await w.dispatch(hello);
  const a = change(h, [{ op: 'node.delete', id: 'api_b' }]), pending = w.dispatch(request('apply', a, 'cancel_me'));
  await w.dispatch({ type: 'sb.canvas.cancel', v: 1, nonce, requestId: 'cancel_me' }); await pending;
  fail(w.sent.at(-1).data, 'CANCELLED'); assert.equal(h.writes, 0); assert.equal(h.model.nodes.length, 2);
  const controller = new AbortController(); controller.abort(); fail(h.api.applyChange(a, { signal: controller.signal }), 'CANCELLED');
});
test('null and tauri origins require exact event origin and parent source', async () => {
  for (const origin of ['null', 'tauri://localhost', 'http://tauri.localhost']) {
    const h = adapter(), w = windowHarness(origin); Bridge.installPostMessage(w.win, h.api);
    await w.dispatch(hello, { origin: 'https://foreign.example' }); await w.dispatch(hello, { source: {} }); assert.equal(w.sent.length, 0);
    await w.dispatch(hello); assert.equal(w.sent[0].target, origin === 'null' ? '*' : origin);
    await w.dispatch(request('snapshot', {})); assert(w.sent.at(-1).data.ok);
  }
});

function pipelineHarness(store = new Map(), options = {}) {
  const elements = new Map(), listeners = new Map(), timers = new Map(); let nextTimer = 0;
  function element(tag = 'div') {
    const classes = new Set();
    return { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, style: { setProperty() {} }, value: '', hidden: true, textContent: '', clientWidth: 1200, clientHeight: 800,
      classList: { add(...xs) { xs.forEach(x => classes.add(x)); }, remove(...xs) { xs.forEach(x => classes.delete(x)); }, toggle(x, on) { if (on === undefined) on = !classes.has(x); on ? classes.add(x) : classes.delete(x); }, contains: x => classes.has(x) },
      appendChild(x) { this.children.push(x); x.parentElement = this; return x; }, replaceChildren(...xs) { this.children = xs; }, replaceWith() {},
      setAttribute(k, v) { this.attributes[k] = v; }, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      focus() {}, select() {}, setSelectionRange() {}, closest() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const parent = { postMessage() {} };
  const h = { store, elements, timers, failed: new Set(), network: [], get };
  const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem(k, v) { if (h.failed.has(k)) throw Error('quota'); store.set(k, String(v)); } };
  const document = { body: element('body'), activeElement: null, visibilityState: 'visible', hidden: false,
    getElementById: get, createElement: element, createTextNode: text => ({ textContent: text }),
    querySelector: selector => selector.includes('.d-note') ? null : get(selector), querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ console, localStorage, document, location: { origin: 'http://127.0.0.1:8000', protocol: 'http:' }, parent,
    crypto: { randomUUID: () => 'manual-uuid-' + (++serial) }, AbortController, DOMException, performance: { now: () => 0 },
    fetch(url, init) { h.network.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) }); },
    setTimeout(fn) { const n = ++nextTimer; timers.set(n, fn); return n; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return ++nextTimer; }, cancelAnimationFrame() {}, devicePixelRatio: 1,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    removeEventListener() {}, getSelection() { return null; }, matchMedia: () => ({ matches: true }) });
  vm.runInContext('window=globalThis;', context);
  context.SB_UI={mountPipelineNodes:()=>({update:()=>Promise.resolve()}),mountPipelineSidebar:()=>({update:()=>Promise.resolve()})};
  for (const file of ['lineage.js', 'notes_sync.js', 'notes_edit.js', 'canvas_document.js', 'canvas_bridge.js']) vm.runInContext(read(file), context, { filename: file });
  const inline = [...read('pipeline.html').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim());
  for (const m of inline) vm.runInContext(m[1], context, { filename: 'pipeline.html' });
  vm.runInContext('globalThis.testCanvas={S,canvasController,createNode,setNodeNote,deleteNode,undoDeleteNode,applyApiData,applyRealData,useDemo,select,applyTransform,canvasNotesSync,editNodeTitle};', context);
  h.context = context; h.api = context.SB_CANVAS_OPERATIONS; h.live = context.testCanvas; return h;
}

test('startup probe keeps a successful empty pipeline list online without changing the canvas', async () => {
  const h = pipelineHarness(new Map(), { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pipelines: [] }) }) });
  const before = plain(h.api.getSnapshot());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.network.length, 1); assert(h.network[0].url.endsWith('/api/pipelines'));
  assert.equal(h.live.S.apiOffline, false); assert.equal(h.live.S.mode, 'demo');
  assert.deepEqual(plain(h.api.getSnapshot()), before);
  assert.equal(h.get('pipeSelect').disabled, true); assert.match(h.get('pipeSelect').innerHTML, /没有可用管线/);
  assert.match(h.get('sideFoot').innerHTML, /本地服务已连接/); assert.match(h.get('sideFoot').innerHTML, /导入/);
  assert(!h.get('sideFoot').innerHTML.includes('未运行'));
});
test('startup probe preserves a manual mode selected while a successful nonempty list is pending', async () => {
  let reply;
  const pending = new Promise(resolve => { reply = resolve; });
  const h = pipelineHarness(new Map(), { fetch: () => pending });
  h.live.applyRealData({ groups: [] }); h.get('tabReal').onclick();
  assert.equal(h.live.S.userMode, true); assert.equal(h.live.S.mode, 'real');
  const before = plain(h.api.getSnapshot()); h.get('sideFoot').innerHTML = '当前批次说明';
  reply({ ok: true, status: 200, json: async () => ({ ok: true, pipelines: [{ id: 'pipe', name: 'Pipe', rootExists: true }] }) });
  await new Promise(resolve => setImmediate(resolve));
  for (const [id, fn] of [...h.timers]) { h.timers.delete(id); await fn(); }
  assert.equal(h.live.S.mode, 'real'); assert.equal(h.live.S.apiOffline, false);
  assert.deepEqual(plain(h.api.getSnapshot()), before); assert.equal(h.network.length, 1);
  assert.equal(h.get('pipeSelect').disabled, false); assert.equal(h.get('pipeSelect').children[0].value, 'pipe');
  assert.equal(h.get('sideFoot').innerHTML, '当前批次说明');
});
test('startup probe reports actual HTTP failure as offline without changing the canvas', async () => {
  const h = pipelineHarness(), before = plain(h.api.getSnapshot());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.live.S.apiOffline, true); assert.equal(h.live.S.mode, 'demo');
  assert.deepEqual(plain(h.api.getSnapshot()), before); assert.equal(h.network.length, 1);
  assert.equal(h.get('pipeSelect').disabled, true); assert.match(h.get('pipeSelect').innerHTML, /本地服务未运行/);
  assert.match(h.get('sideFoot').innerHTML, /本地服务未运行/); assert.match(h.get('sideFoot').innerHTML, /start-server\.bat/);
});

test('pipeline integration exposes only structured API and safe root DOM, and preserves scientific source', () => {
  const h = pipelineHarness(); assert.equal(h.context.__PC__, undefined); assert.equal(h.api.getSnapshot().canvasId, 'demo:aurora-v1');
  h.live.S.apiId = 'pipe'; const definition = { id: 'pipe', root: '<img src=x onerror=evil()>', name: 'Pipe', steps: [
    { id: 'a', title: 'A', tool: 'rf3', note: 'old', desc: 'science', fileCount: 0, files: [], cmd: 'private command', dir: { path: 'files', exists: true, entries: 0 } }] };
  const before = plain(definition); h.live.applyApiData(definition);
  const foot = h.get('sideFoot'); assert.equal(foot.children[2].textContent, definition.root); assert.equal(foot.innerHTML, undefined);
  const s = h.api.getSnapshot(); assert.equal(s.canvasId, 'api:pipe'); assert(!JSON.stringify(s).includes('private command')); assert(!JSON.stringify(s).includes(definition.root));
  assert(h.api.applyChange({ canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'display', operations: [{ op: 'node.update', id: 'api_a', props: { title: 'Display' } }] }).ok);
  assert.deepEqual(plain(definition), before); assert.deepEqual(plain(s.nodes[0].binding), { stepId: 'a' });
});
test('pipeline UI create edit delete undo and manual mutation share canonical revision and overlay', () => {
  const h = pipelineHarness(), initial = h.api.getSnapshot(); h.live.createNode(); const s = h.api.getSnapshot();
  assert.equal(s.revision, initial.revision + 1); const manual = s.nodes.find(n => n.manual); assert(manual); assert.equal(h.live.S.nodes.find(n => n.id === manual.id).state, 'wait');
  const stale = { canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'ui_stale', operations: [{ op: 'node.delete', id: manual.id }] };
  h.live.setNodeNote(h.live.S.nodes.find(n => n.id === manual.id), 'typed'); fail(h.api.applyChange(stale), 'REVISION_CONFLICT');
  h.live.deleteNode(manual.id); assert(!h.api.getSnapshot().nodes.some(n => n.id === manual.id)); h.live.undoDeleteNode(); assert(h.api.getSnapshot().nodes.some(n => n.id === manual.id));
  const revision = h.api.getSnapshot().revision; h.live.S.nodes[0].title = 'manual renderer edit'; assert.equal(h.api.getSnapshot().revision, revision + 1);
  const saved = JSON.parse(h.store.get('structboard.pipelineCanvas.v1')); assert.equal(saved['demo:aurora-v1'].document.overrides.n0.title, 'manual renderer edit');
});
test('pipeline reload persists base movement, notes, manual nodes and viewport without altering definitions', () => {
  const h = pipelineHarness(); h.live.createNode(); const before = h.api.getSnapshot();
  assert(h.api.applyChange({ canvasId: before.canvasId, expectedRevision: before.revision, idempotencyKey: 'reload_display', operations: [
    { op: 'node.move', id: 'n0', x: 777, y: -20 }, { op: 'note.set', id: 'n0', text: 'remember' }, { op: 'viewport.set', viewport: { scale: 1.3, tx: 99, ty: -8 } }] }).ok);
  const s = h.api.getSnapshot(), restarted = pipelineHarness(h.store); assert.deepEqual(plain(restarted.api.getSnapshot()), plain(s));
});
test('pipeline API note outbox has per-key durability and failed network never reports backend ACK', async () => {
  const h = pipelineHarness(); h.live.S.apiId = 'pipe'; h.live.applyApiData({ root: 'X:/private/root', name: 'Pipe', steps: [
    { id: 'a', title: 'A', tool: '', desc: '', note: 'old', fileCount: 0, files: [] }, { id: 'b', title: 'B', note: 'b', fileCount: 0, files: [] }] });
  const s = h.api.getSnapshot(), a = { canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'note_a', operations: [{ op: 'note.set', id: 'api_a', text: '' }] };
  const r = h.api.applyChange(a); assert(r.ok); assert.equal(r.result.backendAck, false); assert.equal(r.result.notesLocalDurable, true);
  assert.equal(h.live.canvasNotesSync.snapshot().pipe.a, ''); assert.equal(h.live.canvasNotesSync.snapshot().pipe.b, undefined);
  await h.live.canvasNotesSync.flush('pipe'); assert.equal(h.live.canvasNotesSync.pending('pipe', 'a'), true); assert.equal(h.api.getSnapshot().durability.backendAck, false);
  const restarted = pipelineHarness(h.store); restarted.live.S.apiId = 'pipe'; restarted.live.applyApiData({ root: 'X:/private/root', steps: [{ id: 'a', title: 'A', note: 'old', fileCount: 0, files: [] }] });
  assert.equal(restarted.api.getSnapshot().nodes[0].note, '');
});
test('pipeline canvas failure is not ACKed; note outbox failure reports partial durability and retains recovery overlay', () => {
  const h = pipelineHarness(); h.failed.add('structboard.pipelineCanvas.v1'); const s = h.api.getSnapshot();
  fail(h.api.applyChange({ canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'writefail', operations: [{ op: 'node.delete', id: 'n0' }] }), 'STORAGE_WRITE_FAILED'); assert.equal(h.api.getSnapshot().nodes.length, 4);
  h.failed.clear(); h.live.S.apiId = 'pipe'; h.live.applyApiData({ steps: [{ id: 'a', title: 'A', note: 'old', fileCount: 0, files: [] }] }); h.failed.add('structboard.pipelineNotesPending');
  const a = h.api.getSnapshot(), r = h.api.applyChange({ canvasId: a.canvasId, expectedRevision: a.revision, idempotencyKey: 'outboxfail', operations: [{ op: 'note.set', id: 'api_a', text: 'recover me' }] });
  assert(r.ok); assert.equal(r.result.rendererApplied, true); assert.equal(r.result.localDurable, true); assert.equal(r.result.notesLocalDurable, false); assert.equal(r.result.backendAck, false);
  const saved = JSON.parse(h.store.get('structboard.pipelineCanvas.v1'))['api:pipe']; assert(saved.document.contentSignature.includes('recover me'));
  verifyFailedOutboxRecovery();
});

function verifyFailedOutboxRecovery() {
  const h = pipelineHarness(); h.live.S.apiId = 'pipe'; h.live.applyApiData({ steps: [{ id: 'a', title: 'A', note: 'old', fileCount: 0, files: [] }] });
  h.failed.add('structboard.pipelineNotesPending'); const s = h.api.getSnapshot();
  assert(h.api.applyChange({ canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'recover_note', operations: [{ op: 'note.set', id: 'api_a', text: '' }] }).ok);
  const saved = new Map(h.store), restarted = pipelineHarness(saved); restarted.live.S.apiId = 'pipe';
  restarted.live.applyApiData({ steps: [{ id: 'a', title: 'A', note: 'old', fileCount: 0, files: [] }] });
  assert.equal(restarted.api.getSnapshot().nodes[0].note, ''); assert.equal(restarted.live.canvasNotesSync.snapshot().pipe.a, '');
  const newer = pipelineHarness(new Map(h.store)); newer.live.S.apiId = 'pipe';
  newer.live.applyApiData({ steps: [{ id: 'a', title: 'A', note: 'newer backend', fileCount: 0, files: [] }] });
  assert.equal(newer.api.getSnapshot().nodes[0].note, 'newer backend'); assert.equal(newer.live.canvasNotesSync.pending('pipe', 'a'), false);
  verifyUpdatedSource();
}
function verifyUpdatedSource() {
  const h = adapter(), before = h.api.getSnapshot(), a = change(h, [{ op: 'node.delete', id: 'api_b' }]);
  const p = h.api.prepareChange(a); assert(p.ok); h.model.baseNodes[0].desc = 'fresh source'; h.model.nodes = plain(h.model.baseNodes); h.controller.restore();
  assert.equal(h.api.getSnapshot().revision, before.revision + 1); fail(h.api.applyChange(a, { prepared: p.result.prepared }), 'PREPARED_MISMATCH');
}

(async () => {
  for (const t of tests) { await t.run(); count++; process.stdout.write('ok ' + count + ' - ' + t.name + '\n'); }
  console.log('canvas bridge: ' + count + ' tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
