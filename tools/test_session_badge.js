'use strict';

// Executes the real app badge adapter and scheduling bridge with the production
// coordinator. The clock and store are controlled; no browser storage is touched.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { create } = require(path.join(root, 'workspace_save.js'));

function functionSource(name) {
  const match = source.match(new RegExp('^  function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  }', 'm'));
  assert(match, 'Missing app function: ' + name);
  return match[0];
}
class Clock {
  now = 0; serial = 0; tasks = new Map();
  setTimeout = (fn, ms = 0) => {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = id => this.tasks.delete(id);
  async drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async advance(ms) {
    const end = this.now + ms;
    await this.drain();
    for (let count = 0; ; count++) {
      const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert(count < 100, 'Unexpected timer loop');
      this.tasks.delete(next[0]); this.now = next[1].at;
      next[1].fn();
      await this.drain();
    }
    this.now = end;
    await this.drain();
  }
}
function harness() {
  const clock = new Clock(), saved = [], notices = [], states = [];
  const label = { textContent: '' }, icon = { dataset: {}, innerHTML: '' };
  const classes = new Set();
  const badge = {
    dataset: {}, attributes: {}, title: '', hidden: false,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelector(name) {
      return name === '.session-save-label' ? label : name === '.session-save-icon' ? icon : null;
    },
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
  };
  Object.defineProperty(badge, 'textContent', { set() { throw Error('Static badge children must survive'); } });
  const context = vm.createContext({
    document: { documentElement: { dataset: {} } }, location: { search: '' },
    $: id => id === 'sessionSaveState' ? badge : null,
    S: { restoringSession: false },
    folderEditStore: { persist() { context.persisted++; }, reset() { context.reset++; } },
    reconcileFolderNotes() { context.reconciled++; },
    buildLocalSnapshot: () => ({ entries: [{}], groups: [], customSteps: [], organization: {} }),
    sessionStore: {
      async save(snapshot) { if (context.fail) throw Error('磁盘写满'); saved.push(snapshot); },
      async clear() { if (context.fail) throw Error('清理失败'); context.cleared++; },
    },
    saveLastSessionMeta() { context.meta++; },
    ensureCurrentPipelineTab() {}, workspaceWindowKey: 'fixture', LEGACY_LAST_SESSION_KEY: 'structboard.lastSession',
    toast(message) { notices.push(message); },
    localStorage: { removeItem(key) { context.removed = key; } },
    LAST_SESSION_KEY: 'structboard.lastSession',
    persisted: 0, reset: 0, reconciled: 0, cleared: 0, meta: 0,
    window: { SB_WORKSPACE_SAVE: { create(options) {
      return create({ ...options, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        now: () => clock.now, onState(state, error) { states.push(state); options.onState(state, error); } });
    } } },
  });
  vm.runInContext('let sessionSaveCoordinator = null;\n' +
    ['showSessionSaveState', 'workspaceSaveCoordinator', 'scheduleSessionSave', 'clearSavedSession'].map(functionSource).join('\n') +
    '\nglobalThis.api={showSessionSaveState,scheduleSessionSave,clearSavedSession,workspaceSaveCoordinator};', context);
  return { context, api: context.api, clock, badge, label, icon, saved, states, notices };
}

(async () => {
  const right = html.indexOf('class="appbar-right"');
  const badge = html.indexOf('id="sessionSaveState"', right);
  const importButton = html.indexOf('id="btnImport"', right);
  assert(right >= 0 && badge > right && badge < importButton, 'Save status must precede Import');
  assert.equal((html.match(/id="sessionSaveState"/g) || []).length, 1, 'One global badge');
  assert(html.includes('class="session-save-icon"') && html.includes('class="session-save-label"'));
  {
    const h = harness();
    h.api.showSessionSaveState('saving');
    assert.equal(h.badge.dataset.state, 'saving');
    assert.equal(h.badge.attributes['aria-busy'], 'true');
    assert.match(h.label.textContent, /保存中/);
    h.api.showSessionSaveState('saved');
    assert.match(h.label.textContent, /已保存/);
    assert.equal(h.badge.attributes['aria-busy'], 'false');
    h.api.showSessionSaveState('error', '磁盘写满');
    assert.equal(h.badge.title, '磁盘写满');
    assert(h.badge.classList.contains('is-error'));
    h.api.showSessionSaveState('idle');
    assert.equal(h.badge.dataset.visible, 'false');
    assert.equal(h.badge.hidden, false, 'Hiding status must retain its layout slot');
  }
  {
    const h = harness();
    h.api.scheduleSessionSave();
    assert.equal(h.badge.dataset.state, 'saving');
    await h.clock.advance(400);
    h.api.scheduleSessionSave({ quiet: true });
    assert.equal(h.api.workspaceSaveCoordinator().deadline, 600, 'Quiet must not delay visible save');
    await h.clock.advance(200);
    assert.equal(h.saved.length, 1);
    assert.equal(h.badge.dataset.state, 'saved');
    assert.equal(h.context.meta, 1);
    assert.equal(h.context.reconciled, 1);
    await h.clock.advance(1999);
    assert.equal(h.badge.dataset.state, 'saved');
    await h.clock.advance(1);
    assert.equal(h.badge.dataset.state, 'idle');
  }
  {
    const h = harness();
    for (let i = 0; i < 12; i++) h.api.scheduleSessionSave({ quiet: true });
    assert.deepEqual(h.states, [], 'Durable note backups do not flash saving');
    await h.clock.advance(2500);
    assert.equal(h.saved.length, 1);
    assert.equal(h.context.reconciled, 0);
    assert.deepEqual(h.states, []);
  }
  {
    const h = harness();
    h.context.fail = true;
    h.api.scheduleSessionSave({ quiet: true });
    await h.clock.advance(2500);
    assert.equal(h.badge.dataset.state, 'error');
    assert.equal(h.badge.title, '磁盘写满');
    h.context.fail = false;
    await h.clock.advance(1000);
    assert.equal(h.badge.dataset.state, 'saved');
    assert(!h.badge.classList.contains('is-error'));
    await h.clock.advance(2000);
    assert.equal(h.badge.dataset.state, 'idle');
  }
  {
    const h = harness();
    h.context.S.restoringSession = true;
    h.api.scheduleSessionSave();
    h.context.S.restoringSession = false;
    h.context.location.search = '?autodemo=1';
    h.api.scheduleSessionSave();
    assert.equal(h.clock.tasks.size, 0);
    assert.deepEqual(h.states, []);
    h.context.location.search = '';
    await h.api.clearSavedSession();
    assert.equal(h.context.cleared, 1);
    assert.equal(h.context.reset, 1);
    assert.equal(h.context.removed, 'structboard.lastSession');
  }
  console.log('session badge ok (static slot before Import, real app/coordinator, progress/quiet/failure, two-second dismissal, clear)');
})().catch(error => { console.error(error); process.exitCode = 1; });
