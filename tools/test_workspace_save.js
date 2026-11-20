'use strict';

// Run: node tools/test_workspace_save.js
// Virtual clock and deferred transactions exercise real coordinator interleavings.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { create } = require(path.join(root, 'workspace_save.js'));
class Clock {
  now = 0; serial = 0; tasks = new Map();
  setTimeout = (fn, ms = 0) => { const id = ++this.serial; this.tasks.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = id => this.tasks.delete(id);
  async drain() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
  async advance(ms) {
    await this.drain(); const end = this.now + ms;
    for (let n = 0; ; n++) {
      const next = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert(n < 100, 'coordinator must not spin on retries');
      this.tasks.delete(next[0]); this.now = next[1].at; next[1].fn(); await this.drain();
    }
    this.now = end; await this.drain();
  }
}
function harness(settings = {}) {
  const clock = new Clock(), calls = [], states = [], errors = [], commits = [];
  let value = 0, sequence = Promise.resolve();
  const transaction = (kind, data) => {
    const call = { kind, data, started: false };
    calls.push(call);
    const task = sequence.then(() => new Promise((resolve, reject) => {
      call.started = true; call.resolve = resolve; call.reject = reject;
    }));
    sequence = task.catch(() => {});
    return task;
  };
  const store = { save: snap => transaction('save', snap), clear: () => transaction('clear') };
  const api = create({ store, snapshot: () => ({ value }), setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, now: () => clock.now,
    onState: (state, error) => states.push({ state, error, at: clock.now }),
    onCommit: (snap, version) => commits.push({ snap, version }), onError: error => errors.push(error), ...settings });
  return { api, clock, calls, states, errors, commits, set value(next) { value = next; },
    get state() { return states.at(-1)?.state || 'idle'; } };
}
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function functionSource(name) {
  const match = app.match(new RegExp('^  function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  }', 'm'));
  assert(match, 'missing app function ' + name); return match[0];
}
let cases = 0;
async function test(name, run) { await run(); cases++; console.log('ok - ' + name); }
(async () => {
  await test('normal save keeps its deadline and visible debt when quiet edits arrive', async () => {
    const h = harness(); h.value = 1; h.api.schedule();
    assert.equal(h.api.deadline, 600); assert.equal(h.api.visibleDebt, true); assert.equal(h.state, 'saving');
    await h.clock.advance(400); h.value = 2; h.api.schedule({ quiet: true });
    assert.equal(h.api.deadline, 600); await h.clock.advance(200);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].data, { value: 2 });
    h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.api.committedVersion, 2); assert.equal(h.api.visibleDebt, false); assert.equal(h.state, 'saved');
    await h.clock.advance(1999); assert.equal(h.state, 'saved');
    await h.clock.advance(1); assert.equal(h.state, 'idle');
  });
  await test('normal edits pull a quiet deadline forward, and pure quiet work never flashes status', async () => {
    const quiet = harness(); quiet.api.schedule({ quiet: true });
    await quiet.clock.advance(2500); quiet.calls[0].resolve(); await quiet.clock.drain();
    assert.deepEqual(quiet.states, []);
    const h = harness(); h.api.schedule({ quiet: true }); await h.clock.advance(100);
    h.api.schedule(); assert.equal(h.api.deadline, 700); await h.clock.advance(600);
    h.calls[0].resolve(); await h.clock.drain(); assert.equal(h.state, 'saved');
  });
  await test('continuous normal and quiet input have bounded snapshot staleness', async () => {
    for (const quiet of [false, true]) {
      const h = harness(); h.api.schedule({ quiet });
      for (let i = 0; i < 12 && !h.calls.length; i++) {
        await h.clock.advance(250); h.value++; h.api.schedule({ quiet });
      }
      assert.equal(h.calls.length, 1); assert(h.clock.now <= 3000);
      h.calls[0].resolve(); await h.clock.drain();
    }
  });
  await test('quiet success clears a persistent error and settles the two-second success state', async () => {
    const h = harness({ maxRetries: 0 }); h.api.schedule(); await h.clock.advance(600);
    h.calls[0].reject(Error('QuotaExceededError')); await h.clock.drain();
    assert.equal(h.state, 'error'); assert.equal(h.api.committedVersion, 0);
    await h.clock.advance(5000); assert.equal(h.state, 'error');
    h.api.schedule({ quiet: true }); await h.clock.advance(2500); h.calls[1].resolve(); await h.clock.drain();
    assert.equal(h.api.error, ''); assert.equal(h.state, 'saved');
    await h.clock.advance(2000); assert.equal(h.state, 'idle');
  });
  await test('quiet success settles an existing app-level storage error without showing saving', async () => {
    const h = harness({ hasError: () => true }); h.api.schedule({ quiet: true });
    assert.deepEqual(h.states, []); await h.clock.advance(2500); h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.state, 'saved'); assert(!h.states.some(s => s.state === 'saving'));
    await h.clock.advance(2000); assert.equal(h.state, 'idle');
  });
  await test('a newer normal edit during a transaction remains visibly owed until its own commit', async () => {
    const h = harness(); h.value = 1; h.api.schedule(); await h.clock.advance(600);
    h.value = 2; h.api.schedule(); await h.clock.advance(900);
    assert.equal(h.calls.length, 1, 'no overlapping snapshots'); h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.api.committedVersion, 1); assert.equal(h.api.visibleDebt, true); assert.equal(h.state, 'saving');
    await h.clock.advance(0); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].data.value, 2);
    h.calls[1].resolve(); await h.clock.drain(); assert.equal(h.state, 'saved');
    assert.equal(h.api.committedVersion, 2);
  });
  await test('quiet in-flight work cannot consume visible debt from a later normal edit', async () => {
    const h = harness(); h.api.schedule({ quiet: true }); await h.clock.advance(2500);
    h.value = 9; h.api.schedule(); h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.api.visibleDebt, true); assert.equal(h.state, 'saving');
    await h.clock.advance(600); h.calls[1].resolve(); await h.clock.drain();
    assert.equal(h.api.visibleDebt, false); assert.equal(h.state, 'saved');
  });
  await test('failures retry only a bounded number of times without clearing the real error', async () => {
    const h = harness(); h.api.schedule({ quiet: true }); await h.clock.advance(2500);
    for (let i = 0; i < 3; i++) {
      h.calls[i].reject(Error('disk denied')); await h.clock.drain(); assert.equal(h.state, 'error');
      if (i < 2) await h.clock.advance(1000 * (2 ** i));
    }
    await h.clock.advance(60000); assert.equal(h.calls.length, 3);
    assert.equal(h.errors.length, 1, 'identical errors notify once');
    assert.equal(h.api.committedVersion, 0); assert.equal(h.clock.tasks.size, 0);
  });
  await test('flush includes edits received during an active transaction and cancels debounce', async () => {
    const h = harness(); h.value = 1; h.api.schedule({ quiet: true }); const flushed = h.api.flush();
    await h.clock.drain(); assert.equal(h.calls.length, 1);
    h.value = 2; h.api.schedule(); h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].data.value, 2);
    h.calls[1].resolve(); assert.equal(await flushed, true); await h.clock.drain();
    assert.equal(h.api.committedVersion, 2); await h.clock.advance(10000); assert.equal(h.calls.length, 2);
  });
  await test('clear invalidates in-flight completion and queues before later workspace edits', async () => {
    const h = harness(); h.api.schedule(); await h.clock.advance(600);
    const oldEpoch = h.api.epoch, cleared = h.api.clear();
    assert.equal(h.api.epoch, oldEpoch + 1); assert.equal(h.calls[1].kind, 'clear');
    assert.equal(h.calls[1].started, false, 'reuse the store transaction queue');
    h.value = 99; h.api.schedule(); h.calls[0].resolve(); await h.clock.drain();
    assert.equal(h.commits.length, 0, 'stale snapshot cannot publish metadata');
    assert.equal(h.calls[1].started, true); h.calls[1].resolve(); assert.equal(await cleared, true);
    await h.clock.advance(600); assert.equal(h.calls[2].data.value, 99);
    h.calls[2].resolve(); await h.clock.drain(); assert.equal(h.state, 'saved');
  });
  await test('clear before a scheduled snapshot starts prevents resurrection; stale failures are ignored', async () => {
    const h = harness(); h.api.schedule(); const flushed = h.api.flush(); const cleared = h.api.clear();
    await h.clock.drain(); assert.deepEqual(h.calls.map(c => c.kind), ['clear']);
    h.calls[0].resolve(); await cleared; assert.equal(await flushed, false); assert.equal(h.state, 'idle');
    const active = harness(); active.api.schedule(); await active.clock.advance(600); const done = active.api.clear();
    active.calls[0].reject(Error('stale failure')); await active.clock.drain(); active.calls[1].resolve(); await done;
    assert.equal(active.errors.length, 0); assert.equal(active.state, 'idle');
  });
  await test('failed clear stays visible and empty snapshots use the same clear transaction', async () => {
    const h = harness(); const cleared = h.api.clear(); await h.clock.drain();
    h.calls[0].reject(Error('clear denied')); assert.equal(await cleared, false); assert.equal(h.state, 'error');
    const empty = harness({ empty: () => true }); empty.api.schedule(); await empty.clock.advance(600);
    assert.equal(empty.calls[0].kind, 'clear'); empty.calls[0].resolve(); await empty.clock.drain();
    assert.equal(empty.api.committedVersion, 1); assert.equal(empty.state, 'saved');
  });
  await test('the real app updates static badge children and attributes without destroying icon markup', async () => {
    const icon = { dataset: {}, innerHTML: '', textContent: '' }, label = { textContent: '' };
    const badge = { dataset: {}, attributes: {}, hidden: false, title: '', classList: { toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      querySelector(selector) { return selector === '.session-save-icon' ? icon : selector === '.session-save-label' ? label : null; } };
    Object.defineProperty(badge, 'textContent', { set() { throw Error('must preserve static children'); } });
    const context = vm.createContext({ document: { documentElement: { dataset: {} } }, $: () => badge });
    vm.runInContext(functionSource('showSessionSaveState') + '\nglobalThis.show=showSessionSaveState;', context);
    context.show('saving'); assert.equal(badge.dataset.state, 'saving'); assert.match(label.textContent, /工作区保存中/);
    context.show('saved'); assert.equal(badge.dataset.state, 'saved'); assert.match(label.textContent, /已保存/);
    context.show('idle'); assert.equal(badge.dataset.state, 'idle'); assert.equal(badge.hidden, false);
    context.show('error', 'disk denied'); assert.equal(badge.title, 'disk denied'); assert.equal(badge.dataset.state, 'error');
  });
  console.log('workspace save ok (' + cases + ' cases; real coordinator and static app badge)');
})().catch(error => { console.error(error); process.exitCode = 1; });
