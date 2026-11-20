'use strict';
// Run: node tools/test_canvas_document.js
const assert = require('node:assert/strict');
const Canvas = require('../canvas_document.js');
const plain = x => JSON.parse(JSON.stringify(x));
let count = 0;
function test(name, fn) { fn(); count++; process.stdout.write('ok ' + count + ' - ' + name + '\n'); }
const base = () => ({ canvasId: 'api:pipe', nodes: [
  { id: 'api_a', title: 'A', tool: 'rf3', desc: 'science stays', note: 'old', x: 40, y: 34, binding: { stepId: 'a' } },
  { id: 'api_b', title: 'B', note: '', x: 320, y: 34, binding: { stepId: 'b' } }],
  edges: [['api_a', 'api_b']], selection: ['api_a'], viewport: { scale: .85, tx: 16, ty: 16 } });
function make(extra) { return Canvas.create({ ...base(), ...extra }); }
let key = 0;
function args(doc, operations, extra) { const s = doc.getSnapshot(); return { canvasId: s.canvasId, expectedRevision: s.revision, idempotencyKey: 'test_' + (++key), operations, ...extra }; }
function apply(doc, ops, hooks) { const r = doc.applyChange(args(doc, ops), hooks); assert.equal(r.ok, true, JSON.stringify(r)); return r.result; }
function undoArgs(doc, changeId) { const s = doc.getSnapshot(); return { canvasId: s.canvasId, expectedRevision: s.revision, changeId, idempotencyKey: 'undo_' + (++key) }; }
function fail(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code, JSON.stringify(result)); }

test('safe immutable snapshot and stable ownership', () => {
  const source = base(); source.nodes[0].root = 'X:/secret'; source.nodes[0].cmd = 'private'; source.nodes[0].files = ['science'];
  const d = Canvas.create(source), s = d.getSnapshot();
  assert.equal(s.nodes[0].ownership, 'base'); assert.equal(s.nodes[0].base, true);
  assert.deepEqual(s.nodes[0].binding, { stepId: 'a' }); assert(!('root' in s.nodes[0])); assert(!('files' in s.nodes[0]));
  s.nodes[0].title = 'mutated'; assert.equal(d.getSnapshot().nodes[0].title, 'A');
});
test('all eight operations share one atomic content revision', () => {
  const d = make(); const before = d.getSnapshot();
  const r = apply(d, [
    { op: 'node.create', node: { id: 'manual_1', title: 'Manual', x: 2, y: 3, binding: { stepId: 'a' } } },
    { op: 'node.update', id: 'api_a', props: { title: 'A display', tool: 'mpnn', desc: 'display only' } },
    { op: 'node.move', id: 'api_a', x: -10, y: 450 },
    { op: 'edge.disconnect', from: 'api_a', to: 'api_b' },
    { op: 'edge.connect', from: 'api_a', to: 'manual_1' },
    { op: 'note.set', id: 'manual_1', text: '' },
    { op: 'viewport.set', viewport: { scale: 1.2, tx: 12, ty: -18 } },
    { op: 'node.delete', id: 'api_b' }]);
  assert.equal(r.revision, 1); assert.equal(r.viewRevision, before.viewRevision + 1);
  assert.deepEqual(d.getSnapshot().edges, [['api_a', 'manual_1']]);
  assert.equal(d.getSnapshot().nodes[1].ownership, 'manual'); assert.equal(base().nodes[0].title, 'A');
});
test('invalid tail operation rolls the whole batch back before persistence', () => {
  const d = make(), before = d.getSnapshot(); let writes = 0;
  fail(d.applyChange(args(d, [{ op: 'node.move', id: 'api_a', x: 9, y: 9 }, { op: 'edge.connect', from: 'api_a', to: 'missing' }]), { beforeCommit() { writes++; } }), 'NOT_FOUND');
  assert.deepEqual(d.getSnapshot(), before); assert.equal(writes, 0);
});
test('strict operation fields reject arbitrary state and scientific fields', () => {
  for (const op of [
    { op: 'node.update', id: 'api_a', props: { cmd: 'rm' } },
    { op: 'node.create', node: { id: 'm', title: 'x', x: 0, y: 0, files: ['x'] } },
    { op: 'node.move', id: 'api_a', x: 0, y: 0, approved: true },
    { op: 'note.set', id: 'api_a', text: 'x', pipelineId: 'elsewhere' },
    { op: 'node.create', node: { id: 'm', title: 'x', x: 0, y: 0, binding: { stepId: 'no-step' } } }]) {
    const d = make(); fail(d.applyChange(args(d, [op])), 'INVALID_ARGUMENT'); assert.equal(d.getSnapshot().revision, 0);
  }
  const d = make(); fail(d.applyChange(args(d, [{ op: 'eval', script: 'x' }])), 'INVALID_OPERATION');
});
test('IDs coordinates text limits malformed objects and huge payload are bounded', () => {
  const invalid = [
    { op: 'node.create', node: { id: '../root', title: 'x', x: 0, y: 0 } },
    { op: 'node.create', node: { id: '__proto__', title: 'x', x: 0, y: 0 } },
    { op: 'node.move', id: 'api_a', x: Infinity, y: 0 },
    { op: 'node.move', id: 'api_a', x: 1000001, y: 0 },
    { op: 'node.update', id: 'api_a', props: { title: ' ' } },
    { op: 'note.set', id: 'api_a', text: 'x'.repeat(32001) },
    { op: 'viewport.set', viewport: { scale: 99, tx: 0, ty: 0 } }];
  for (const op of invalid) fail(make().applyChange({ canvasId: 'api:pipe', expectedRevision: 0, idempotencyKey: 'invalid', operations: [op] }), 'INVALID_ARGUMENT');
  const d = make(); const a = args(d, [{ op: 'note.set', id: 'api_a', text: 'x'.repeat(300000) }]); fail(d.applyChange(a), 'INVALID_ARGUMENT');
  const unsafe = JSON.parse('{"op":"node.delete","id":"api_a","__proto__":{}}'); fail(d.applyChange(args(d, [unsafe])), 'INVALID_ARGUMENT');
  const accessor = { op: 'node.delete' }; Object.defineProperty(accessor, 'id', { enumerable: true, get() { throw Error('must not execute'); } });
  fail(d.applyChange(args(d, [accessor])), 'INVALID_ARGUMENT');
});
test('content and view revisions conflict independently and idempotency checks precede conflicts', () => {
  const d = make(), a = args(d, [{ op: 'note.set', id: 'api_a', text: 'new' }]);
  assert(d.applyChange(a).ok); const replay = d.applyChange(plain(a)); assert(replay.ok); assert.equal(replay.result.replayed, true); assert.equal(d.getSnapshot().revision, 1);
  fail(d.applyChange({ ...a, operations: [{ op: 'note.set', id: 'api_a', text: 'different' }] }), 'IDEMPOTENCY_MISMATCH');
  fail(d.applyChange({ ...a, idempotencyKey: 'stale' }), 'REVISION_CONFLICT');
  apply(d, [{ op: 'viewport.set', viewport: { scale: 1, tx: 1, ty: 2 } }]); assert.equal(d.getSnapshot().revision, 1);
  fail(d.applyChange(args(d, [{ op: 'node.move', id: 'api_a', x: 0, y: 0 }], { expectedViewRevision: 0 })), 'REVISION_CONFLICT');
});
test('same payload replays across reload and no-op does not invent a content revision', () => {
  const d = make(), a = args(d, [{ op: 'node.move', id: 'api_a', x: 40, y: 34 }]);
  assert(d.applyChange(a).ok); assert.equal(d.getSnapshot().revision, 0);
  const reloaded = make({ overlay: d.toOverlay() }); assert.equal(reloaded.applyChange(a).result.replayed, true);
});
test('manual UI edits increment content revision and block stale requests', () => {
  const d = make(), a = args(d, [{ op: 'node.delete', id: 'api_a' }]);
  const local = d.getSnapshot(); local.nodes[0].title = 'typed by user';
  assert.equal(d.observeLocal(local).contentChanged, true); assert.equal(d.getSnapshot().revision, 1);
  fail(d.applyChange(a), 'REVISION_CONFLICT');
});
test('undo is scoped by changeId, preserves viewport, and cannot overwrite later content edits', () => {
  const d = make(), r = apply(d, [{ op: 'node.delete', id: 'api_b' }]);
  apply(d, [{ op: 'viewport.set', viewport: { scale: 1.5, tx: 0, ty: 0 } }]);
  const u = d.undoChange(undoArgs(d, r.changeId)); assert(u.ok); assert.equal(d.getSnapshot().nodes.length, 2); assert.equal(d.getSnapshot().viewport.scale, 1.5);
  fail(d.undoChange(undoArgs(d, r.changeId)), 'UNDO_UNAVAILABLE');
  const first = apply(d, [{ op: 'node.move', id: 'api_a', x: 2, y: 2 }]); apply(d, [{ op: 'note.set', id: 'api_b', text: 'later' }]);
  fail(d.undoChange(undoArgs(d, first.changeId)), 'REVISION_CONFLICT');
  fail(make().undoChange({ canvasId: 'api:pipe', expectedRevision: 0, changeId: r.changeId, idempotencyKey: 'foreign' }), 'UNDO_UNAVAILABLE');
});
test('storage failure and cancellation leave state unchanged and keep a recovery candidate', () => {
  const d = make(), a = args(d, [{ op: 'node.delete', id: 'api_a' }]), before = d.getSnapshot();
  fail(d.applyChange(a, { beforeCommit() { throw Object.assign(Error('no storage'), { code: 'STORAGE_WRITE_FAILED' }); } }), 'STORAGE_WRITE_FAILED');
  assert.deepEqual(d.getSnapshot(), before); assert.equal(d.getRecovery().nodes.length, 1);
  const controller = new AbortController(); controller.abort(); fail(d.applyChange(a, { signal: controller.signal }), 'CANCELLED');
  assert(d.applyChange(a).ok); assert.equal(d.getRecovery(), null);
});
test('overlay roundtrip retains base overrides, manual nodes, graph changes, viewport, revisions and undo', () => {
  const d = make(); apply(d, [
    { op: 'node.update', id: 'api_a', props: { title: 'renamed', tool: 'boltz', desc: 'visual' } },
    { op: 'node.move', id: 'api_a', x: 99, y: 100 }, { op: 'note.set', id: 'api_a', text: 'note' },
    { op: 'node.create', node: { id: 'manual', title: 'Manual', x: 33, y: 50, note: 'm' } },
    { op: 'edge.disconnect', from: 'api_a', to: 'api_b' }, { op: 'edge.connect', from: 'api_a', to: 'manual' },
    { op: 'viewport.set', viewport: { scale: 2, tx: 5, ty: -12 } }]);
  const r = apply(d, [{ op: 'node.delete', id: 'api_b' }]);
  const saved = d.toOverlay(), next = make({ overlay: saved }); assert.deepEqual(next.getSnapshot(), d.getSnapshot());
  assert.equal(saved.document.overrides.api_a.x, 99); assert.equal(saved.nodes[0].manual, true); assert.equal(saved.document.deletedIds[0], 'api_b');
  assert(next.undoChange(undoArgs(next, r.changeId)).ok); assert.equal(next.getSnapshot().nodes.length, 3);
});
test('legacy manual nodes notes titles deleted nodes and edges migrate', () => {
  const d = make({ overlay: { nodes: [{ id: 'manual', title: 'legacy', x: 0, y: 1, manual: true }],
    edges: [['api_a', 'manual']], notes: { api_a: 'legacy note' }, titles: { api_a: 'legacy title' },
    deleted: [{ node: { id: 'api_b' } }], overrides: { api_a: { x: 77, y: 88 } } } });
  const s = d.getSnapshot(); assert.deepEqual(s.nodes.map(n => n.id), ['api_a', 'manual']); assert.equal(s.nodes[0].note, 'legacy note'); assert.equal(s.nodes[0].title, 'legacy title'); assert.equal(s.nodes[0].x, 77);
});
test('external API notes ignore stale canvas copies and a changed source invalidates old revision', () => {
  const d = make({ externalNoteIds: ['api_a'] }); apply(d, [{ op: 'note.set', id: 'api_a', text: 'pending note' }]);
  const overlay = d.toOverlay(); assert(!own(overlay.notes, 'api_a')); assert(!own(overlay.document.overrides.api_a || {}, 'note'));
  const source = base(); source.nodes[0].note = 'fresh backend'; const next = Canvas.create({ ...source, externalNoteIds: ['api_a'], overlay });
  assert.equal(next.getSnapshot().nodes[0].note, 'fresh backend'); assert.equal(next.getSnapshot().revision, d.getSnapshot().revision + 1);
  function own(x, k) { return Object.prototype.hasOwnProperty.call(x, k); }
});
test('prepared diff uses actual candidate and commits it without recalculating', () => {
  const d = make(), a = args(d, [{ op: 'node.delete', id: 'api_b' }, { op: 'note.set', id: 'api_a', text: 'new' }]);
  const p = d.prepareChange(a); assert(p.ok); assert(p.result.diff.changes.some(c => c.kind === 'delete' && c.before.includes('api_b')));
  assert.equal(d.getSnapshot().nodes.length, 2); let writes = 0;
  const r = d.commitPrepared(p.result.prepared, 'apply', a, { beforeCommit(saved, candidate) { writes++; assert.equal(candidate.nodes.length, 1); assert.equal(saved.document.revision, 1); } });
  assert(r.ok); assert.equal(writes, 1); assert.equal(d.getSnapshot().nodes[0].note, 'new');
  const u = undoArgs(d, r.result.changeId), preview = d.prepareUndo(u); assert(preview.ok); assert(d.commitPrepared(preview.result.prepared, 'undo', u).ok); assert.equal(d.getSnapshot().nodes.length, 2);
});
test('prepared change rejects payload changes, intervening selection/content and cancellation', () => {
  const d = make(), a = args(d, [{ op: 'node.delete', id: 'api_b' }]), p = d.prepareChange(a);
  fail(d.commitPrepared(p.result.prepared, 'apply', { ...a, idempotencyKey: 'different' }), 'PREPARED_MISMATCH');
  const controller = new AbortController(); controller.abort(); fail(d.commitPrepared(p.result.prepared, 'apply', a, { signal: controller.signal }), 'CANCELLED');
  const s = d.getSnapshot(); s.selection = ['api_b']; d.observeLocal(s);
  fail(d.commitPrepared(p.result.prepared, 'apply', a), 'REVISION_CONFLICT'); assert.equal(d.getSnapshot().nodes.length, 2);
});
test('prepare preserves the current pending API note when previewing another field', () => {
  const d = make({ externalNoteIds: ['api_a'] }); apply(d, [{ op: 'note.set', id: 'api_a', text: 'pending' }]);
  const a = args(d, [{ op: 'node.move', id: 'api_a', x: 8, y: 9 }]), p = d.prepareChange(a);
  assert(p.ok, JSON.stringify(p)); assert(!p.result.diff.changes.some(c => c.target.endsWith(':note')));
  assert(d.commitPrepared(p.result.prepared, 'apply', a).ok); assert.equal(d.getSnapshot().nodes[0].note, 'pending');
});
test('UI move and connection edits undo in order while external changes block stale undo',()=>{
  const d=make(),before=d.getSnapshot();
  const move=apply(d,[{op:'node.move',id:'api_a',x:120,y:250}],{source:'ui'});
  const disconnect=apply(d,[{op:'edge.disconnect',from:'api_a',to:'api_b'}],{source:'ui'});
  assert.equal(d.undoCandidate(),disconnect.changeId);
  assert(d.undoChange(undoArgs(d,d.undoCandidate()),{source:'ui'}).ok);
  assert.equal(d.undoCandidate(),move.changeId);
  assert(d.undoChange(undoArgs(d,d.undoCandidate()),{source:'ui'}).ok);
  assert.deepEqual(d.getSnapshot().nodes,before.nodes);assert.deepEqual(d.getSnapshot().edges,before.edges);
  apply(d,[{op:'node.move',id:'api_a',x:200,y:250}],{source:'ui'});
  apply(d,[{op:'note.set',id:'api_b',text:'external change'}],{source:'api'});
  assert.equal(d.undoCandidate(),null);
});
console.log('canvas document: ' + count + ' tests passed');
