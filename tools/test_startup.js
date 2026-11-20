'use strict';
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { Clock } = require('./test_overview_queue.js');
const source = fs.readFileSync(path.join(__dirname, '../startup.js'), 'utf8');

function fixture(options = {}) {
  const clock = new Clock(), events = {}, calls = [], loads = [];
  const elements = new Map();
  for (const id of ['appSplashScreen', 'startupStatus', 'startupClose', 'startupRetry']) {
    const classes = new Set();
    elements.set(id, { hidden: id === 'startupClose' || id === 'startupRetry', textContent: '',
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      addEventListener(name, fn) { this[name] = fn; } });
  }
  let state = options.state || { state: 'loading' }, reloads = 0;
  const c = { console, Promise, Error, performance: { now: () => clock.now },
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    requestAnimationFrame: fn => clock.setTimeout(fn, 16),
    location: { reload() { reloads++; } },
    document: { getElementById: id => elements.get(id),
      querySelectorAll: () => ['desktop_bridge.js', 'vendor/molstar.js', 'app.js'].map(src => ({ src })),
      createElement: () => ({}), body: { appendChild(script) {
        loads.push(script.src);
        clock.setTimeout(() => {
          if (options.failScript === script.src) script.onerror();
          else { if (script.src === 'app.js') c.__SB_APP_INITIALIZED__ = Promise.resolve(true); script.onload(); }
        }, 10);
      } } },
    __SB_NATIVE_STARTUP__: options.native !== false,
    __TAURI__: { core: { invoke(command, args) {
      calls.push({ command, args, at: clock.now });
      if (command === 'desktop_startup_status') return Promise.resolve(state);
      return Promise.resolve();
    } } },
    addEventListener(name, fn) { events[name] = fn; },
  };
  c.window = c;
  vm.runInNewContext(source, c);
  return { c, clock, elements, calls, loads, events, setState: x => { state = x; }, get reloads() { return reloads; } };
}

async function slowBackendShowsLogo() {
  const h = fixture();
  await h.clock.advance(2000);
  assert.equal(h.elements.get('appSplashScreen').hidden, false);
  assert.deepEqual(h.loads, [], 'heavy scripts loaded before backend was ready');
  assert(h.calls.some(x => x.command === 'desktop_startup_mark' && x.args.phase === 'logo-visible'));
  assert.equal(h.elements.get('startupClose').hidden, false);
  h.setState({ state: 'ready', config: { apiBase: 'http://127.0.0.1:1234', token: 'fixture' } });
  await h.clock.idle('complete startup');
  assert.deepEqual(h.loads, ['desktop_bridge.js', 'vendor/molstar.js', 'app.js']);
  assert.equal(await h.c.__SB_STARTUP_DONE__, true);
  assert.equal(h.elements.get('appSplashScreen').hidden, true);
  assert(h.calls.some(x => x.args && x.args.phase === 'workspace-ready'));
}
async function failureStaysVisible() {
  for (const options of [{ state: { state: 'error' } }, { state: { state: 'ready', config: {} }, failScript: 'vendor/molstar.js' }]) {
    const h = fixture(options); await h.clock.idle('failure');
    assert.equal(await h.c.__SB_STARTUP_DONE__, false);
    assert.equal(h.elements.get('appSplashScreen').hidden, false);
    assert.equal(h.elements.get('startupRetry').hidden, options.state.state === 'error');
    assert(!h.loads.includes('app.js'));
    if (options.failScript) { h.elements.get('startupRetry').click(); assert.equal(h.reloads, 1); }
  }
}
async function closingCancelsLoading() {
  const h = fixture(); await h.clock.advance(100);
  h.elements.get('startupClose').click();
  await h.clock.idle('close');
  assert(h.calls.some(x => x.command === 'desktop_window' && x.args.action === 'close'));
  assert.deepEqual(h.loads, []);
  assert.equal(h.elements.get('startupRetry').hidden, true);
}
async function browserNeedsNoNativeBackend() {
  const h = fixture({ native: false }); await h.clock.idle('browser');
  assert.equal(await h.c.__SB_STARTUP_DONE__, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.elements.get('startupClose').hidden, true);
}
async function timeoutExplainsFailure() {
  const h = fixture(); await h.clock.idle('timeout', 10000);
  assert.equal(await h.c.__SB_STARTUP_DONE__, false);
  assert.match(h.elements.get('startupStatus').textContent, /超时/);
  assert.equal(h.elements.get('startupRetry').hidden, false);
}

(async () => {
  for (const test of [slowBackendShowsLogo, failureStaysVisible, closingCancelsLoading, browserNeedsNoNativeBackend, timeoutExplainsFailure]) {
    await test(); console.log('PASS ' + test.name);
  }
  console.log('5/5 startup behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
