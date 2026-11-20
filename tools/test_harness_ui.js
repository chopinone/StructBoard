'use strict';

// Run: node tools/test_harness_ui.js
// Executes the actual, unmodified harness_ui.js against a local DOM fixture.
// No browser, real timers, or real clipboard are used. Pairing expiry and the
// one-click MCP config copy run on a virtual clock with a recording clipboard
// double, so the assertions are deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../harness_ui.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Clock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map(); }
  setTimeout(fn, delay = 0) { const id = this.nextId++; this.timers.set(id, { at: this.now + Math.max(0, delay), fn, repeat: 0 }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  setInterval(fn, delay = 0) { const id = this.nextId++; this.timers.set(id, { at: this.now + Math.max(1, delay), fn, repeat: Math.max(1, delay) }); return id; }
  clearInterval(id) { this.timers.delete(id); }
  async advance(ms) {
    const end = this.now + ms;
    for (let i = 0; ; i++) {
      let due = null;
      for (const [id, timer] of this.timers) if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer];
      if (!due) break;
      assert(i < 10000, 'advance: possible infinite timer loop');
      const firedAt = due[1].at;
      if (due[1].repeat) due[1].at = firedAt + due[1].repeat; else this.timers.delete(due[0]);
      this.now = firedAt;
      due[1].fn();
      await tick();
    }
    this.now = end;
  }
}

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.listeners = {}; this.style = {};
    this.dataset = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ''; this.className = ''; this.parentElement = null; this.type = ''; this.id = ''; this.tabIndex = 0;
    this.classList = {
      add: value => { this.className += ' ' + value; },
      remove: value => { this.className = this.className.split(/\s+/).filter(v => v !== value).join(' '); },
      toggle: (value, force) => { if (force) this.classList.add(value); else this.classList.remove(value); },
    };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] !== undefined ? this.attributes[key] : null; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  fire(type) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, key: '' };
    for (const fn of this.listeners[type] || []) fn(event);
  }
  click() { if (!this.disabled && !this.hidden) this.fire('click'); }
  matches(selector) { return selector[0] === '#' ? this.id === selector.slice(1) : selector[0] === '.' ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { while (node) { if (node === this) return true; node = node.parentElement; } return false; }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 500, top: 600, width: 24, height: 24, bottom: 624 }; }
}

async function scenario(label, options, run) {
  const clock = new Clock();
  const doc = { readyState: 'complete', listeners: {}, hidden: false,
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    createElement(tag) { return new Element(tag, doc) } };
  doc.documentElement = new Element('html', doc);
  doc.documentElement.dataset.desktop = options.desktop === false ? 'browser' : 'tauri';
  doc.body = new Element('body', doc);
  doc.activeElement = doc.body;
  for (const id of ['btnHarnessConnection', 'harnessIndicator', 'harnessHalo', 'harnessLiveStatus', 'harnessActivityLabel', 'harnessActivityShort']) {
    const seed = new Element(id === 'btnHarnessConnection' ? 'button' : 'div', doc);
    seed.id = id;
    doc.body.append(seed);
  }
  doc.getElementById = id => doc.body.querySelector('#' + id);
  const clipboard = { writes: [], fail: false,
    async writeText(text) { if (this.fail) throw new TypeError('denied'); this.writes.push(String(text)); } };
  const calls = { pairing: [], renamed: [], stops: 0, status: 0, nextStatus: null, onChange: null };
  let codeSeq = 0, uuidSeq = 0;
  const payload = () => Object.assign({ state: 'offline', enabled: true, connected: false, sessions: [], running: [], approvals: [],
    connector: options.connector === false ? undefined :
      { exe: 'C:/apps/StructBoardTauri/StructBoardBackend.exe', credential: 'C:/synthetic-profile/StructBoardMCP/connector.json' } }, calls.nextStatus || {});
  const SB_HARNESS = {
    getStatus: async () => { calls.status++; return payload(); },
    onChange(handler) { calls.onChange = handler; handler(payload()); return () => {}; },
    setApprovalHandler() {},
    createPairing: async settings => {
      calls.pairing.push(settings);
      return { code: 'PAIR-' + String(++codeSeq).padStart(2, '0') + '-' + 'x'.repeat(20), expiresAt: clock.now + 300000 };
    },
    stop: async () => { calls.stops++; return payload(); },
    async rename(id, alias) {
      calls.renamed.push({ id, alias });
      calls.nextStatus.sessions.find(session => session.sessionId === id).name = alias;
      calls.onChange(payload());
      return { ok: true };
    },
    get state() { return payload(); },
  };
  const winListeners = {};
  if (options.clientSetup) {
    calls.registrations = [];
    SB_HARNESS.listClients = async () => ({ ok: true, clients: [{ id: 'codex', message: '未添加', configPath: 'test/config.toml' }] });
    SB_HARNESS.registerClient = async (id, scopes) => {
      calls.registrations.push({ id, scopes });
      return { ok: true, message: '已添加，请重启客户端' };
    };
  }
  const window = { innerWidth: 1400, innerHeight: 900, SB_HARNESS, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++uuidSeq).padStart(12, '0') },
    setTimeout: (fn, d) => clock.setTimeout(fn, d), clearTimeout: id => clock.clearTimeout(id),
    setInterval: (fn, d) => clock.setInterval(fn, d), clearInterval: id => clock.clearInterval(id),
    addEventListener(type, fn) { (winListeners[type] || (winListeners[type] = [])).push(fn); } };
  if (options.desktop !== false) window.__SB_DESKTOP_INVOKE__ = () => {};
  class VDate extends Date {}
  VDate.now = () => clock.now;
  VDate.parse = Date.parse;
  const context = vm.createContext({ window, document: doc, navigator: { clipboard },
    Date: VDate, setTimeout: (fn, d) => clock.setTimeout(fn, d), clearTimeout: id => clock.clearTimeout(id),
    setInterval: (fn, d) => clock.setInterval(fn, d), clearInterval: id => clock.clearInterval(id), console });
  window.SB_UI={createSurface:require('./surface_fixture.cjs')(doc)};
  vm.runInContext(source, context, { filename: 'harness_ui.js' });
  const get = id => doc.getElementById(id);
  const waitFor = async fn => { for (let i = 0; i < 60 && !fn(); i++) await tick(); assert(fn(), label + ': condition not reached'); };
  try {
    await run({ get, waitFor, clock, clipboard, calls, doc, winListeners });
  } catch (error) {
    throw new Error(label + ': ' + error.message);
  }
}

(async () => {
  await scenario('desktop pairing, one-click config copy, expiry', {}, async ({ get, waitFor, clock, clipboard, calls }) => {
    const copyConfig = get('btnHarnessCopyConfig');
    await waitFor(() => copyConfig.hidden === false);
    assert.equal(copyConfig.disabled, true, 'copy-config disabled before pairing');
    assert.match(get('harnessDesktopStatus').textContent, /桌面连接：已启用/);

    get('btnHarnessPair').click();
    await waitFor(() => calls.pairing.length === 1 && get('harnessPairing').hidden === false);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.pairing[0])), { scopes: ['read'], remember: false });
    assert.notEqual(get('harnessPairingCode').textContent, '');
    assert.equal(copyConfig.disabled, false);
    assert.match(get('harnessPairingExpiry').textContent, /剩余 [45]:/);

    copyConfig.click();
    await waitFor(() => clipboard.writes.length === 1);
    assert.equal(get('harnessRemember').checked, true, 'remember auto-checked for a durable config');
    assert.equal(calls.pairing.length, 2, 'pairing regenerated with remembered grant');
    assert.deepEqual(JSON.parse(JSON.stringify(calls.pairing[1])), { scopes: ['read'], remember: true });
    const config = JSON.parse(clipboard.writes[0]);
    const server = config.mcpServers && config.mcpServers.structboard;
    assert.equal(server.command, 'C:/apps/StructBoardTauri/StructBoardBackend.exe');
    assert.deepEqual(server.args, ['--mcp', '--pair-code', get('harnessPairingCode').textContent,
      '--credential-file', 'C:/synthetic-profile/StructBoardMCP/connector-00000000-0000-4000-8000-000000000001.json']);
    copyConfig.click();
    await waitFor(() => clipboard.writes.length === 2);
    assert.deepEqual(JSON.parse(clipboard.writes[1]).mcpServers.structboard.args, server.args);
    assert.match(get('harnessPairingMessage').textContent, /已复制 MCP 配置/);

    clipboard.writes.length = 0;
    get('btnHarnessCopy').click();
    await waitFor(() => clipboard.writes.length === 1);
    assert.equal(clipboard.writes[0], get('harnessPairingCode').textContent);

    await clock.advance(300001);
    assert.equal(get('harnessPairingCode').textContent, '', 'expired pairing clears the code');
    assert.match(get('harnessPairingMessage').textContent, /过期/);
    assert.equal(get('btnHarnessCopy').disabled, true);
    assert.equal(copyConfig.disabled, true);

    clipboard.writes.length = 0;
    get('btnHarnessPair').click();
    await waitFor(() => calls.pairing.length === 3 && copyConfig.disabled === false);
    clipboard.fail = true;
    copyConfig.click();
    await waitFor(() => get('harnessPairingMessage').textContent.includes('复制失败'));
    assert.equal(clipboard.writes.length, 0);
    assert.equal(get('harnessRemember').checked, true, 'remember stays checked after clipboard failure');
  });

  await scenario('browser mode without connector hides one-click copy', { desktop: false, connector: false }, async ({ get, waitFor, calls }) => {
    await waitFor(() => calls.status > 0);
    assert.equal(get('btnHarnessCopyConfig').hidden, true);
    assert.equal(get('btnHarnessPair').disabled, true, 'pairing requires the desktop shell');
    assert.match(get('harnessDesktopStatus').textContent, /浏览器模式/);
    get('btnHarnessPair').click();
    await tick();
    assert.equal(calls.pairing.length, 0, 'no pairing from a disabled button');
  });

  await scenario('desktop bridge without connector hides one-click copy only', { connector: false }, async ({ get, waitFor, calls }) => {
    await waitFor(() => calls.status > 0);
    assert.equal(get('btnHarnessCopyConfig').hidden, true, 'no connector advertised in source runs');
    assert.equal(get('btnHarnessPair').disabled, false);
    get('btnHarnessPair').click();
    await waitFor(() => calls.pairing.length === 1 && get('harnessPairing').hidden === false);
    assert.equal(get('btnHarnessCopy').disabled, false, 'manual code copy still available');
    assert.equal(get('btnHarnessCopyConfig').hidden, true, 'one-click copy stays hidden without a connector');
  });

  await scenario('inner glow tracks MCP connection and active tool state', {}, async ({ get, waitFor, calls }) => {
    const halo = get('harnessHalo');
    await waitFor(() => calls.onChange && calls.status > 0);
    assert.equal(halo.dataset.state, 'offline');
    calls.nextStatus = { state: 'connected', connected: true };
    calls.onChange(calls.nextStatus);
    assert.equal(halo.dataset.state, 'connected');
    assert.equal(halo.dataset.active, 'true');
    calls.nextStatus = { state: 'running', connected: true, running: [{ tool: 'sb_get_context' }] };
    calls.onChange(calls.nextStatus);
    assert.equal(halo.dataset.state, 'running');
    calls.nextStatus = { state: 'offline', connected: false, running: [] };
    calls.onChange(calls.nextStatus);
    assert.equal(halo.dataset.state, 'offline');
    assert.equal(halo.dataset.active, 'false');
  });

  await scenario('one and multiple connections are named; legacy grants can be renamed in place', {}, async ({ get, waitFor, calls }) => {
    await waitFor(() => calls.onChange && calls.status > 0);
    const codex = { sessionId: 'session_codex', name: 'Codex', clientName: 'Codex', scopes: ['read'], connected: true };
    calls.nextStatus = { state: 'connected', connected: true, sessions: [codex] };
    calls.onChange(calls.nextStatus);
    assert.equal(get('harnessActivityLabel').textContent, 'Codex 已连接');
    assert.equal(get('harnessActivityShort').textContent, '已连接');
    assert.equal(get('harnessDesktopStatus').textContent, '当前连接 · Codex');
    calls.nextStatus.sessions.push({ sessionId: 'session_old', name: 'MCP connector', scopes: ['view', 'read'], connected: true });
    calls.onChange(calls.nextStatus);
    assert.equal(get('harnessActivityLabel').textContent, '2 个助手 已连接');
    const row = get('harnessSessions').children[1];
    row.children[1].click();
    const form = row.querySelector('form');
    assert.equal(form.hidden, false);
    row.querySelector('input').value = 'ZCode 工作区';
    form.fire('submit');
    await waitFor(() => form.hidden);
    assert.deepEqual(calls.renamed, [{ id: 'session_old', alias: 'ZCode 工作区' }]);
    assert.equal(get('harnessDesktopStatus').textContent, '当前连接 · Codex、ZCode 工作区');
  });

  await scenario('client wizard grants selected scopes only and reports pending client reload', { clientSetup: true }, async ({ get, waitFor, calls }) => {
    get('btnHarnessConnection').click();
    await waitFor(() => get('harnessClientSetup').hidden === false);
    get('harnessScopeView').checked = true;
    get('btnClientSetup-codex').click();
    await waitFor(() => calls.registrations.length === 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.registrations)), [{ id: 'codex', scopes: ['read', 'view'] }]);
    await waitFor(() => get('harnessClientSetup').textContent.includes('已添加，请重启客户端'));
    assert.equal(calls.pairing.length, 0, 'wizard never creates an unused clipboard pairing');
  });
  console.log('test_harness_ui: 6 scenarios ok');
})().catch(error => { console.error(error.message); process.exit(1); });
