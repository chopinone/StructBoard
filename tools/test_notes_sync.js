'use strict';

// Run: node tools/test_notes_sync.js
// Executes the real notes_sync.js with a fake storage and a scripted fetch.
// Covers: per-key patches instead of whole-table writes, in-flight edits,
// failure retention/backoff, restart replay, snapshot authority, and local errors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../notes_sync.js'), 'utf8');

function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (this.fail) throw Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
    raw: map,
  };
}

function makeFetch() {
  const calls = [];
  const fetch = (url, init) => {
    const entry = { url, method: init.method, body: JSON.parse(init.body) };
    calls.push(entry);
    const pending = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.respond = (payload, status) => entry.resolve({
      ok: status === undefined || status < 400,
      status: status || 200,
      json: async () => payload,
    });
    entry.fail = error => entry.reject(error);
    return pending;
  };
  return { fetch, calls };
}

function load(options) {
  const timers = [];
  const context = vm.createContext({
    fetch: options.fetch,
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    JSON, Object, Array, Error, String, Math, Date, Promise, console,
  });
  vm.runInContext(source, context);
  const notify = [];
  const api = context.SB_NOTES_SYNC.create({
    storage: options.storage,
    storageKey: 'pending',
    fetch: options.fetch,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; },
    onChange: (pid, keys) => notify.push({ pid, keys: keys.slice() }),
  });
  return { api, timers, notify, fire(timer) { timer.cleared = false; timer.fn(); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  // 1. One patch POST per document — never the whole notes table.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'hello' }, 0);
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), { pipe: { 'step-a': 'hello' } }, 'draft is durable before any request');
    h.timers[0].fn();
    await tick();
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, '/api/notes');
    assert.deepEqual(net.calls[0].body, { id: 'pipe', patch: { 'step-a': 'hello' } });
    assert.equal(net.calls[0].body.notes, undefined, 'must not post a full notes table');
    net.calls[0].respond({ ok: true, count: 1 });
    await tick(); await tick();
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), {}, 'cleared after the server accepted it');
    assert.equal(h.api.status('pipe', 'step-a').state, 'saved');
  }

  // 2. Two steps edited inside one debounce window travel as one patch.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'A' }, 0);
    h.api.put('pipe', { 'step-b': 'B' }, 0);
    assert.equal(net.calls.length, 0, 'debounce holds the request');
    h.timers[h.timers.length - 1].fn();
    await tick();
    assert.equal(net.calls.length, 1);
    assert.deepEqual(net.calls[0].body.patch, { 'step-a': 'A', 'step-b': 'B' });
    net.calls[0].respond({ ok: true });
    await tick(); await tick();
    assert.equal(h.api.pending('pipe', 'step-a'), false);
    assert.equal(h.api.pending('pipe', 'step-b'), false);
  }

  // 3. An edit typed while a request is in flight is not lost or merged into the old payload.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'first' }, 0);
    h.timers[0].fn();
    await tick();
    assert.equal(net.calls.length, 1);
    h.api.put('pipe', { 'step-a': 'second' }, 0);
    assert.equal(h.api.status('pipe', 'step-a').state, 'saving', 'still unsaved while the first request is open');
    net.calls[0].respond({ ok: true });
    await tick(); await tick();
    assert.equal(h.api.pending('pipe', 'step-a'), true, 'newer text stays queued');
    const retry = h.timers.filter(t => !t.cleared).pop();
    assert(retry, 'a follow-up send is scheduled');
    retry.fn();
    await tick();
    assert.equal(net.calls.length, 2);
    assert.deepEqual(net.calls[1].body.patch, { 'step-a': 'second' });
    net.calls[1].respond({ ok: true });
    await tick(); await tick();
    assert.equal(h.api.pending('pipe', 'step-a'), false);
  }

  // 4. Failure keeps the draft on disk and retries with growing delay.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'kept' }, 0);
    h.timers[0].fn();
    await tick();
    net.calls[0].fail(Error('backend offline'));
    await tick(); await tick();
    assert.equal(h.api.status('pipe', 'step-a').state, 'error');
    assert.match(h.api.status('pipe', 'step-a').error, /backend offline/);
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), { pipe: { 'step-a': 'kept' } }, 'draft survives the failure');
    const retry = h.timers.filter(t => !t.cleared).pop();
    assert.equal(retry.ms, 2000, 'first retry backs off');
    retry.fn();
    await tick();
    net.calls[1].fail(Error('still offline'));
    await tick(); await tick();
    assert.equal(h.timers.filter(t => !t.cleared).pop().ms, 4000, 'second retry backs off further');
  }

  // 5. HTTP 200 with ok:false is a failure, not a silent save.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'x' }, 0);
    h.timers[0].fn();
    await tick();
    net.calls[0].respond({ ok: false, error: '便签数据必须是对象' });
    await tick(); await tick();
    assert.equal(h.api.status('pipe', 'step-a').state, 'error');
    assert.match(h.api.status('pipe', 'step-a').error, /便签数据必须是对象/);
  }

  // 6. Restart replays whatever was still pending when the window closed.
  {
    const storage = makeStorage({ pending: JSON.stringify({ pipe: { 'step-a': 'from last run' } }) });
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    assert.equal(h.api.pending('pipe', 'step-a'), true);
    assert.equal(h.api.status('pipe', 'step-a').state, 'saving');
    h.api.flush();
    await tick();
    const call = net.calls[0];
    assert(call, 'pending drafts are sent on startup without user action');
    assert.deepEqual(call.body.patch, { 'step-a': 'from last run' });
    call.respond({ ok: true });
    await tick(); await tick();
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), {});
  }

  // 7. Disk notes fill gaps; unsent local text always wins.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': 'local newer' }, 0);
    const merged = h.api.applyPending('pipe', { 'step-a': 'disk older', 'step-b': 'disk only', marks: 1 });
    assert.equal(merged['step-a'], 'local newer');
    assert.equal(merged['step-b'], 'disk only');
    assert.equal(merged.marks, 1);
  }

  // 8. A full localStorage still sends the patch instead of dropping the edit.
  {
    const storage = makeStorage();
    storage.setItem = function () { throw Error('QuotaExceededError'); };
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    const saved = h.api.put('pipe', { 'step-a': 'no room locally' }, 0);
    assert.equal(saved, false, 'reports that the local copy failed');
    assert.match(h.api.storageError, /Quota/);
    assert(h.timers.some(t => !t.cleared), 'network write is still scheduled');
    h.timers[h.timers.length - 1].fn();
    await tick();
    assert.equal(net.calls.length, 1);
    assert.deepEqual(net.calls[0].body.patch, { 'step-a': 'no room locally' });
    net.calls[0].respond({ ok: true });
    await tick(); await tick();
  }

  // 9. Clearing a note to '' is a real value, not "delete the field".
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { 'step-a': '' }, 0);
    h.timers[0].fn();
    await tick();
    assert.deepEqual(net.calls[0].body.patch, { 'step-a': '' });
    net.calls[0].respond({ ok: true });
    await tick(); await tick();
  }

  // 10. Two documents keep separate queues.
  {
    const storage = makeStorage();
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    h.api.put('pipe-a', { s1: 'A' }, 0);
    h.api.put('pipe-b', { s1: 'B' }, 0);
    h.api.flush();
    for (let i = 0; i < 6 && net.calls.length < 2; i++) {
      await tick();
      net.calls.forEach(call => { if (!call.done) { call.done = true; call.respond({ ok: true }); } });
    }
    assert.deepEqual(net.calls.map(c => c.body.id).sort(), ['pipe-a', 'pipe-b']);
    await tick(); await tick();
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), {});
  }

  // Garbage in storage must not crash startup.
  {
    const storage = makeStorage({ pending: '{not json' });
    const net = makeFetch();
    const h = load({ storage, fetch: net.fetch });
    assert.equal(h.timers.length, 0);
    assert.equal(net.calls.length, 0);
  }

  // 11. A durable empty outbox means previous work was ACKed. Never replay an older snapshot.
  {
    const storage = makeStorage({ pending: '{}' });
    const net = makeFetch(), h = load({ storage, fetch: net.fetch });
    assert.equal(h.api.hasLocalSnapshot, true);
    assert.equal(h.api.restoreFallback({ pipe: { a: 'stale ACKed edit' } }), false);
    await h.api.flush();
    assert.equal(net.calls.length, 0);
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), {});
  }

  // 12. Only a missing local outbox may be recovered from a workspace snapshot, once.
  {
    const storage = makeStorage(), net = makeFetch(), h = load({ storage, fetch: net.fetch });
    assert.equal(h.api.hasLocalSnapshot, false);
    assert.equal(h.api.restoreFallback({ pipe: { a: '', b: 'recovered' } }), true);
    assert.equal(h.api.restoreFallback({ pipe: { a: 'stale', c: 'stale' } }), false);
    assert.deepEqual(JSON.parse(storage.raw.get('pending')), { pipe: { a: '', b: 'recovered' } });
  }

  // 13. Quota errors are status errors immediately, even while the network is pending.
  {
    const storage = makeStorage(), net = makeFetch(), h = load({ storage, fetch: net.fetch });
    storage.fail = true;
    h.api.put('pipe', { a: 'memory survives' });
    assert.equal(h.api.status('pipe', 'a').state, 'error');
    assert.match(h.api.status('pipe', 'a').localError, /Quota/);
    storage.fail = false;
    const saving = h.api.flush('pipe');
    await tick();
    assert.equal(h.api.status('pipe', 'a').state, 'saving', 'retry also repairs the durable local copy');
    net.calls[0].respond({ ok: true }); await saving;
    assert.equal(h.api.status('pipe', 'a').state, 'saved');
  }

  // 14. Repeated flushes cannot queue duplicate requests behind the same in-flight POST.
  {
    const storage = makeStorage(), net = makeFetch(), h = load({ storage, fetch: net.fetch });
    h.api.put('pipe', { a: 'first' });
    const first = h.api.flush('pipe'); await tick();
    h.api.put('pipe', { a: 'newer', b: 'another field' });
    assert.equal(h.api.flush('pipe'), first);
    assert.equal(h.api.flush('pipe'), first);
    net.calls[0].respond({ ok: true }); await first;
    assert.deepEqual(h.api.snapshot(), { pipe: { a: 'newer', b: 'another field' } });
    const second = h.api.flush('pipe'); await tick();
    assert.equal(net.calls.length, 2);
    assert.deepEqual(net.calls[1].body.patch, { a: 'newer', b: 'another field' });
    net.calls[1].respond({ ok: true }); await second;
  }

  // 15. A slow document must not block writes to another document.
  {
    const storage = makeStorage(), net = makeFetch(), h = load({ storage, fetch: net.fetch });
    h.api.put('slow', { a: 'slow' }); h.api.put('other', { b: 'fast' });
    const sending = h.api.flush(); await tick();
    assert.equal(net.calls.length, 2);
    net.calls[1].respond({ ok: true }); await tick();
    assert.equal(h.api.pending('other', 'b'), false);
    assert.equal(h.api.pending('slow', 'a'), true);
    net.calls[0].respond({ ok: true }); await sending;
  }

  // 16. Notes and marks stay independent, including edits made during a marks POST.
  {
    const storage = makeStorage(), net = makeFetch(), h = load({ storage, fetch: net.fetch });
    const marks = { count: 1, items: [{ name: 'one' }] };
    h.api.put('pipe', { __structboard_marks__: marks });
    const first = h.api.flush('pipe'); await tick();
    h.api.put('pipe', { a: 'note' });
    assert.deepEqual(net.calls[0].body.patch, { __structboard_marks__: marks });
    net.calls[0].respond({ ok: true }); await first;
    assert.deepEqual(h.api.snapshot(), { pipe: { a: 'note' } });
    const second = h.api.flush('pipe'); await tick();
    assert.deepEqual(net.calls[1].body.patch, { a: 'note' });
    net.calls[1].respond({ ok: true }); await second;
  }

  console.log('notes sync ok (17 cases: per-key patches, ordering, failures/retry, restart, authority, local errors, marks)');
})().catch(error => { console.error(error); process.exit(1); });
