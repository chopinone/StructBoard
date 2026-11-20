'use strict';

// Run: node tools/test_pane_controls.js
// Executes the actual control helpers, bind(), clone, and AI binding code from
// app.js against an event-propagating DOM fixture parsed from index.html.
// No browser, WebGL, dependencies, or source-string assertions are involved.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const runtime = require('../pane_runtime.js');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const toolbarTemplate = fs.readFileSync(path.join(root, 'frontend/components/WorkbenchToolbar.vue'), 'utf8').split('<template>')[1].split('</template>')[0].replace(/:(id|aria-controls)="prefix\+'([^']+)'"/g, '$1="$2"');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/(<div class="toolbar bench-toolbar"[^>]*>)(<\/div>)/, '$1'+toolbarTemplate+'$2');

function functionSource(name) {
  const match = source.match(new RegExp('^  (?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}', 'm')) ||
    source.match(new RegExp('^  const ' + name + ' = function \\([^\\n]*\\) \\{[\\s\\S]*?^  \\};', 'm'));
  assert(match, 'Missing executable function ' + name);
  return match[0];
}

class FixtureEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, bubbles: true, cancelable: true, button: 0, pointerId: 1, key: '', defaultPrevented: false }, options);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
}
class FixtureTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    const capture = options === true || !!(options && options.capture);
    const list = this.listeners.get(type) || [];
    if (!list.some(item => item.fn === fn && item.capture === capture)) list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || !!(options && options.capture);
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.fn !== fn || item.capture !== capture));
  }
  dispatchEvent(event) {
    event.target = this;
    const chain = [];
    for (let current = this; current; current = current.parentElement || current.parentTarget) chain.push(current);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const item of [...(node.listeners.get(event.type) || [])]) {
        if (item.capture !== capture) continue;
        item.fn.call(node, event);
        if (event.immediate) break;
      }
      if (!capture && !event.immediate && typeof node['on' + event.type] === 'function') node['on' + event.type](event);
    };
    for (const node of [...chain].reverse()) { invoke(node, true); if (event.stopped) return !event.defaultPrevented; }
    for (const node of chain) { invoke(node, false); if (event.stopped || !event.bubbles) break; }
    return !event.defaultPrevented;
  }
}
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[value]);
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class FixtureElement extends FixtureTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.attrs = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ''; this.type = '';
    this.style = { setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name] || ''; } };
    this.scrollTop = 0; this.clientWidth = 800; this.clientHeight = 700; this.offsetWidth = 200; this.offsetHeight = 40;
    this.rect = { left: 0, top: 0, right: 800, bottom: 850, width: 800, height: 850 };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const on = force === undefined ? !this.classList.contains(name) : force; this.classList[on ? 'add' : 'remove'](name); return on; },
    };
  }
  get id() { return this.attrs.get('id') || ''; }
  set id(value) { this.attrs.set('id', value); }
  get className() { return this.attrs.get('class') || ''; }
  set className(value) { this.attrs.set('class', value); }
  setAttribute(name, value) {
    value = String(value); this.attrs.set(name, value);
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'value' || name === 'type') this[name] = value;
  }
  getAttribute(name) { return name.startsWith('data-') ? (this.dataset[dataKey(name)] ?? null) : (this.attrs.get(name) ?? null); }
  removeAttribute(name) { this.attrs.delete(name); if (name.startsWith('data-')) delete this.dataset[dataKey(name)]; }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  insertBefore(node, before) {
    node.remove(); const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    node.parentElement = this; return node;
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (!this.parentElement) return; const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { if (!this.parentElement) return null; return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) { this.replaceChildren(); parseInto(this.ownerDocument, String(value), this); }
  get innerHTML() { return this.textContent; }
  matches(selector) {
    return selector.split(',').some(part => {
      const segments = part.trim().split(/\s+(?![^\[]*\])/);
      let current = this;
      const simple = (node, token) => {
        if (!node || !node.tagName) return false;
        const tag = token.match(/^[a-z][\w-]*/i);
        if (tag && node.tagName !== tag[0].toUpperCase()) return false;
        for (const match of token.matchAll(/#([\w-]+)|\.([\w-]+)|\[([^\]=~^$*\s]+)\s*(?:(\^=|\$=|\*=|=)\s*["']?([^"'\]]*)["']?)?\]/g)) {
          if (match[1] && node.id !== match[1]) return false;
          if (match[2] && !node.classList.contains(match[2])) return false;
          if (match[3]) {
            const value = node.getAttribute(match[3]), expected = match[5];
            if (value === null || (match[4] === '=' && value !== expected) || (match[4] === '^=' && !value.startsWith(expected)) || (match[4] === '$=' && !value.endsWith(expected)) || (match[4] === '*=' && !value.includes(expected))) return false;
          }
        }
        return true;
      };
      if (!simple(current, segments.pop())) return false;
      while (segments.length) {
        const segment = segments.pop(); current = current.parentElement;
        while (current && !simple(current, segment)) current = current.parentElement;
        if (!current) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) { const found = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new FixtureEvent('focusin')); }
  select() { this.selected = true; }
  click() { if (!this.disabled) this.dispatchEvent(new FixtureEvent('click')); }
  getBoundingClientRect() { return this.rect; }
  getContext() { return null; }
  cloneNode(deep) {
    const node = new FixtureElement(this.ownerDocument, this.tagName);
    this.attrs.forEach((value, name) => node.setAttribute(name, value));
    Object.assign(node.dataset, this.dataset); node.value = this.value; node.hidden = this.hidden; node.disabled = this.disabled; node.type = this.type;
    node._text = this._text; Object.assign(node.style, this.style); node.rect = { ...this.rect };
    if (deep) this.children.forEach(child => node.appendChild(child.cloneNode(true)));
    return node;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
}
function parseInto(document, markup, target) {
  markup = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const stack = [target], voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const token of markup.matchAll(/<\/[^>]+>|<[a-z][^>]*>|[^<]+/gi)) {
    const text = token[0];
    if (text.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!text.startsWith('<')) { stack[stack.length - 1]._text = (stack[stack.length - 1]._text || '') + decode(text); continue; }
    const match = text.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/); if (!match) continue;
    const node = document.createElement(match[1]);
    for (const attribute of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
    stack[stack.length - 1].appendChild(node);
    if (!voids.has(match[1].toLowerCase()) && !text.endsWith('/>')) stack.push(node);
  }
}
function makeHarness({ bindAll = true, realPipeline = false } = {}) {
  const window = new FixtureTarget();
  Object.assign(window, { innerWidth: 1800, innerHeight: 1000, devicePixelRatio: 1, matchMedia: () => ({ matches: true }) });
  const document = new FixtureTarget(); document.parentTarget = window;
  document.createElement = tag => new FixtureElement(document, tag);
  const tree = document.createElement('fixture'); tree.parentTarget = document; parseInto(document, html, tree);
  document.documentElement = tree.querySelector('html'); document.body = tree.querySelector('body');
  document.getElementById = id => tree.querySelector('[id="' + id + '"]');
  document.querySelector = selector => tree.querySelector(selector); document.querySelectorAll = selector => tree.querySelectorAll(selector);
  document.activeElement = document.body;
  const pipelineMessages = [];
  document.getElementById('pipelineFrame').contentWindow = { postMessage(message) { pipelineMessages.push(message); } };
  document.getElementById('pipelineFrame').contentDocument = { body: document.body };
  const shared = { entries: [{ id: 'left-model', color: 1 }], groups: [], metrics: { table: null }, organization: {}, errors: [], customSteps: [], trashSteps: [], trashFolders: [] };
  const viewKeys = ['mode', 'theme', 'repr', 'cols', 'rows', 'page', 'overviewGrouped', 'syncCamera', 'maxOverlay', 'soloId', 'soloFrom', 'overviewReturn', 'lineageReferenceId', 'referenceId', 'aligned', 'filter', 'starOnly', 'activeGroupId', 'gridRecommend', 'gridFromOverview', 'gridDrill', 'trashOpen', 'trashReturnMode', 'trashReturnPlace', 'gridViewers', 'gridCells', 'overlayViewer', 'overlayRefs'];
  const initial = { mode: 'overview', theme: 'per-structure', repr: 'cartoon', cols: 2, rows: 2, page: 0, overviewGrouped: true, syncCamera: true, maxOverlay: 20, activeGroupId: 'all' };
  const panes = [runtime.createPane(initial, viewKeys, { index: 0 }), runtime.createPane(initial, viewKeys, { index: 1, prefix: 'p2-' })];
  panes[0].el = document.getElementById('stage');
  const calls = [], frames = new Map(), timers = new Map(), storage = new Map(); let frameId = 0, timerId = 0;
  const log = (name, ...args) => calls.push({ name, args, pane: currentPane() });
  let context;
  const currentPane = () => context ? vm.runInContext('paneAt()', context) : panes[0];
  const noopNames = ['bindGroupNavigation', 'bindSidebar', 'syncModeTabs', 'syncModeThumb', 'resizeGridViewers', 'renderOverviewWindow', 'setReference', 'applyMetrics', 'presetRf3', 'clearMetrics', 'exportList', 'pickImportMetrics', 'recomputeMetricRange', 'refreshMetricsStatus', 'renderMetricUI', 'setAllVisible', 'closeSeqViewer', 'setActiveGroup', 'importFiles', 'loadDemoMetrics', 'addFilterRow', 'importMetrics', 'addFromUrl', 'openAIPipelineAssist', 'closeAIPipelineAssist', 'importAIPipelineJson', 'closeGroupMenu', 'setLoadProgress', 'hideLoadProgress', 'status', 'refreshStepsUI', 'schedulePipelineSync', 'scheduleSessionSave', 'closeStepModal', 'handleStepPickedFiles'];
  const globals = {
    window, document, console, navigator: { hardwareConcurrency: 8, deviceMemory: 8 }, location: { origin: 'http://fixture.test', search: '' },
    Event: FixtureEvent, File, AbortController, PANE_RUNTIME: runtime, PANE_VIEW_SET: new Set(viewKeys), rawS: shared, panes,
    IO: { readFile: async () => ({ name: 'right-model.pdb', data: 'fixture-data' }) },
    PANE_SCOPED_IDS: new Set([...document.getElementById('stage').querySelectorAll('[id]')].map(node => node.id)),
    splitState: { active: false, prefixes: ['', 'p2-'] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    sessionStore: { key: 'workspace:fixture:local', getKey() { return this.key; }, setKey(key) { const previous = this.key; this.key = key; return previous; }, async load() { return null; }, async save() {} },
    folderEditStore: { workspaceId: 'fixture-folder-workspace', snapshot: () => ({}), restore() {}, activateWorkspace() {}, reset() {}, persist() { return true; } },
    pipelineWorkspaceKey: id => 'workspace:fixture:' + (id || 'local'),
    windowStorageKey: key => key,
    activePipelineId: () => shared.activePipelineId || '',
    currentWorkspaceTabId: () => shared.activePipelineId || shared.localWorkspaceId || '',
    isLocalWorkspaceTab: id => id === '__local__' || String(id).startsWith('local:'),
    pipelineTabs: { activeId: '', get: () => null, add: () => null, activate: () => false, remove: () => null },
    renderPipelineTabs() {}, updatePipelineIdentity() {}, savePipelineViewNow() {}, switchPipelineTab: async () => false,
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    getComputedStyle: () => ({ borderTopLeftRadius: '12', transform: 'none', opacity: '1' }),
    performance: { now: () => 1000 },
    toast: (...args) => log('toast', ...args), copyText: (...args) => log('copyText', ...args),
    renderList: () => log('renderList'), refreshBadge: () => log('refreshBadge'),
    resetGridNavigation: () => { currentPane().view.gridDrill = null; log('resetGridNavigation'); },
    setGridArrangement: (mode,pane) => { pane.view.gridArrangement=mode;log('setGridArrangement',mode,pane); },
    rebuildGrid: pane => log('rebuildGrid', pane), rebuildOverlay: async (busy, pane) => { log('rebuildOverlay', busy, pane); const target = pane || currentPane(); target.view.overlayRefs = shared.entries.map(entry => ({ id: entry.id })); }, rebuildOverview: index => log('rebuildOverview', index),
    applyModeChange: rebuild => log('applyModeChange', rebuild),
    setMode(mode) { currentPane().view.mode = mode; context.api.syncPaneControls(currentPane()); log('setMode', mode); },
    openCurrentInGrid() { currentPane().view.gridFromOverview = { drillId: 'owned-folder' }; currentPane().view.mode = 'grid'; log('openCurrentInGrid'); },
    applyOverviewSearch(value, index) { panes[index].query = value; log('applyOverviewSearch', value, index); },
    currentOrgContext() { return { stepKey: currentPane().id, parentId: 'owned-folder', selected: ['owned-selection'] }; },
    promptNewOrgFolder: (...args) => log('promptNewOrgFolder', ...args), openStepModal: (...args) => log('openStepModal', ...args),
    undoOrg: () => log('undoOrg'), redoOrg: () => log('redoOrg'), starPassing: () => log('starPassing'), exportPlacement: () => log('exportPlacement'),
    openTrashPage: () => log('openTrashPage'), closeTrashPage: () => log('closeTrashPage'), restoreAllTrash: () => log('restoreAllTrash'),
    toggleSplit() { globals.splitState.active = !globals.splitState.active; log('toggleSplit'); },
    pickImport: folder => log('pickImport', folder), loadDemo: () => log('loadDemo'),
    syncAllCameras: (force, pane) => log('syncAllCameras', force, pane), toggleAlign: pane => log('toggleAlign', pane),
    applyTheme: (viewer, items, pane) => log('applyTheme', viewer, items, pane), saveImage: () => log('saveImage'),
    resetCamera: async viewer => { log('resetCamera', viewer); },
    backGridFolder: () => log('backGridFolder'), gridLayer: () => ({ nodes: Array.from({ length: 20 }, (_, i) => i) }), pageSize: () => currentPane().view.cols * currentPane().view.rows,
    visibleEntries: () => shared.entries, gridNodeEntry: node => node.entry || node,
    soloChipLabel: value => log('soloChipLabel', value),
    syncPaneFocus: rebuild => log('syncPaneFocus', rebuild),
    makeDividerDraggable: () => {},
    sleep: async () => {}, hydrateStepNotesFromPipeline: () => {}, loadProgressRun: null,
    ORG: { ingestDefinition() {}, clearHistory() {} }, LINEAGE: { meta: item => ({ sourceKey: item.sourceKey }) },
    loadStepEdits: () => ({}), autoApplyScores: () => {}, plddtRow: () => null,
    addEntries(raws, name, opts) {
      const entries = raws.map((entry, index) => ({ ...entry, id: 'new-' + shared.entries.length + '-' + index }));
      if (opts && opts.prepareOnly) return { entries, seq: entries.length };
      shared.entries.push(...entries); log('addEntries');
    },
    askSheet: async () => 'replace', cancelPipelineSync: () => log('cancelPipelineSync'), marksSyncTimer: 0,
    resetSharedPaneViews: async () => { for (const pane of panes) Object.assign(pane.view, { activeGroupId: 'all', referenceId: null, aligned: false }); },
    saveCustomSteps() {}, saveLastSessionMeta() {}, restoreFolderNotes() {}, applyAllPaneModes: async () => {},
    buildLocalSnapshot(workspace) { return JSON.parse(JSON.stringify(workspace || shared)); },
    workspaceSaveCoordinator: () => ({ flush: async () => true, persistImport: async (next, backup, check) => { check(); log('persistImport', next, backup); } }),
    createGroup(name, ids) { const group = { id: 'group-' + shared.groups.length, name, entryIds: ids }; shared.groups.push(group); return group; },
    refreshReferenceSelect: () => log('refreshReferenceSelect'), renderGroups: () => log('renderGroups'),
    fetch: async () => { throw Error('Unexpected fixture fetch'); },
  };
  noopNames.forEach(name => { globals[name] = (...args) => log(name, ...args); });
  context = vm.createContext(globals);
  const controlStart = source.indexOf('  const paneControlBindings =');
  const controlEnd = source.indexOf('  // 把第 0 栏当前状态复制', controlStart);
  assert(controlStart >= 0 && controlEnd > controlStart, 'Missing executable control helper block');
  const names = ['paneStage', 'paneOverviewStage', 'paneAt', 'paneContext', 'paneElement', 'withPaneSync', 'setActivePane', 'syncPaneFocus', 'ensurePaneModeRow', 'clonePaneDom', 'harnessPane', 'setOverviewGrouped', 'bind', 'bindAIPipelineAssist', 'closeMenus', 'toggleMenu', 'el', 'hasWorkspaceContent', 'pipelineCatalogRaw', 'preparePipelineWorkspace', 'publishPipelineWorkspace', 'orderedStepBuckets', 'pipelineFolderWorkspaceId'];
  window.SB_SESSION_MIGRATION = { fingerprint: () => 'fixture-fingerprint' };
  let pendingPipeline;
  vm.runInContext(`let activePane = 0, scopedPane = null, overview = null; const GROUPED_KEY = 'structboard.overviewGrouped';
    const AI_PIPELINE_PROMPT = 'fixture prompt', AI_PIPELINE_EXAMPLE = {steps: []}; let aiAssistLastRaw = '';
    const MENU_IDS = ['importMenu', 'listMenu', 'viewMenu', 'entryMenu', 'stepMenu', 'orgMenu', 'overviewMoreMenu'];
    const S = new Proxy(rawS, { get: (target,key) => PANE_VIEW_SET.has(key) ? paneAt().view[key] : target[key], set: (target,key,value) => { if(PANE_VIEW_SET.has(key)) paneAt().view[key]=value; else target[key]=value; return true; }});
    const $ = id => { const p = paneAt(); return PANE_SCOPED_IDS.has(id) && p.prefix ? document.getElementById(p.prefix + id) : document.getElementById(id); };
    ${names.map(functionSource).join('\n')}
    ${source.slice(controlStart, controlEnd)}
    const setActivePaneImpl = setActivePane, syncPaneFocusImpl = syncPaneFocus;
    setActivePane = function(index, options) { recordActivation(index, options); return setActivePaneImpl(index, options); };
    syncPaneFocus = function(refresh) { recordFocus(refresh); return syncPaneFocusImpl(refresh); };
    globalThis.api = { bind, bindAIPipelineAssist, bindPaneControls, ensurePaneModeRow, clonePaneDom, harnessPane, syncPaneControls, runPaneControl, paneControlElement, resetPaneCameras, recommendGrid, applyGridShape, setPaneSearchOpen, orderedStepBuckets,
      focus(index) { setActivePane(index, {sync:false}); }, active() { return activePane; }, setPipeline(controller) { panePipelineController = controller; }, menu() {return paneActionsMenu;} };`,
  Object.assign(context, { recordActivation: (index, options) => calls.push({ name: 'activate', args: [index, options], pane: panes[index] }), recordFocus: refresh => log('syncPaneFocus', refresh) }));
  if (bindAll) { context.api.bind(); context.api.bindAIPipelineAssist(); }
  context.api.ensurePaneModeRow(0);
  const ownerCounts = new Map();
  function ownOverview(pane) {
    pane.overview = { stats: { paused: false, lite: false }, restore: place => log('restore', place) };
    for (const id of ['btnOverviewBack', 'btnOverviewPause', 'btnOverviewLite']) {
      const button = context.api.paneControlElement(pane, id);
      button.onclick = () => { const key = pane.id + ':' + id; ownerCounts.set(key, (ownerCounts.get(key) || 0) + 1); };
    }
  }
  ownOverview(panes[0]);
  context.api.clonePaneDom(); panes[1].el = document.getElementById('p2-stage'); ownOverview(panes[1]);
  context.api.setPipeline({ importWholePipeline: options => {
    log('importWholePipeline', options);
    if (realPipeline) {
      pendingPipeline = window.__SB_RESTORE_PIPELINE__('fixture-pipe', options);
      return pendingPipeline;
    }
  } });
  context.fetch = async url => {
    if (url === '/api/pipelines') return { ok: true, json: async () => ({ ok: true, pipelines: [{ id: 'fixture-pipe', name: 'Fixture pipeline', steps: 1 }] }) };
    if (url.includes('/api/pipeline/structures')) return { ok: true, json: async () => ({ ok: true, title: 'Fixture step', files: [{ name: 'right-model.pdb', path: 'right-model.pdb', sourceKey: 'fixture-source', fileKey: 'fixture-file' }] }) };
    return { ok: true, json: async () => ({ ok: true, pipeline: { id: 'fixture-pipe', name: 'Fixture pipeline', steps: [{ id: 's1', title: 'Fixture step' }] } }) };
  };
  calls.length = 0;
  return {
    api: context.api, context, document, window, panes, calls, frames, storage, ownerCounts, pipelineMessages,
    pipelineTask() { return pendingPipeline; },
    fetchWith(handler) { context.fetch = handler; },
    get(index, id) { return context.api.paneControlElement(panes[index], id); },
    fire(node, type = 'click', options) { const event = new FixtureEvent(type, options); node.dispatchEvent(event); return event; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    count(name) { return calls.filter(call => call.name === name).length; }, last(name) { return calls.filter(call => call.name === name).at(-1); }, clear() { calls.length = 0; },
  };
}

async function main() {
  let assertions = 0;
  const check = (fn) => { fn(); assertions++; };
  const h = makeHarness();
  for (const pane of h.panes) {
    const index = h.panes.indexOf(pane), stage = pane.el;
    const control = h.api.bindPaneControls(pane);
    check(() => assert.equal(h.api.bindPaneControls(index), control, 'stage binding is idempotent'));
    check(() => assert.equal(pane.runtime.controls, control, 'runtime owns its disposable controller'));
    h.api.ensurePaneModeRow(index); h.api.harnessPane(stage, index);
    check(() => assert.equal(stage.querySelectorAll('.pane-mode').length, 1, 'one mode group per pane'));
    const folder = h.get(index, 'btnOverviewNewFolder');
    const icon = h.document.createElement('svg'), pathNode = h.document.createElement('path'); icon.appendChild(pathNode); folder.appendChild(icon);
    h.clear(); h.api.focus(1 - index); h.fire(pathNode);
    check(() => assert.equal(h.count('promptNewOrgFolder'), 1, 'original bind + delegate execute once'));
    check(() => assert.equal(h.last('promptNewOrgFolder').pane, pane));
    check(() => assert.equal(h.last('promptNewOrgFolder').args[0], pane.id));
    folder.disabled = true; h.fire(pathNode);
    check(() => assert.equal(h.count('promptNewOrgFolder'), 1, 'disabled ancestor suppresses nested hit'));
    folder.disabled = false;
    const seg = stage.querySelector('.pane-mode');
    const grid = seg.querySelector('[data-mode="grid"]');
    pane.view.mode = 'overview'; h.clear(); h.fire(grid);
    check(() => assert.equal(h.count('openCurrentInGrid'), 1, 'mode grid preserves current overview scope'));
    check(() => assert.equal(seg.parentElement, stage.querySelector('.pane-mode-slot'), 'same group moves into toolbar'));
    pane.view.mode = 'overlay'; h.api.syncPaneControls(pane);
    check(() => assert.equal(grid.getAttribute('aria-selected'), 'true', 'overlay is a bench submode'));
    h.fire(seg.querySelector('[data-mode="overview"]'));
    check(() => assert.equal(seg.parentElement, stage.querySelector('.overview-head')));
    for (const id of ['btnOverviewBack', 'btnOverviewPause', 'btnOverviewLite']) {
      const key = pane.id + ':' + id; h.fire(h.get(index, id));
      check(() => assert.equal(h.ownerCounts.get(key), 1, 'overview owns ' + id + ' once'));
    }
  }

  for (let index = 0; index < 2; index++) {
    const pane = h.panes[index], other = h.panes[1 - index];
    const routes = [
      ['btnOverviewNewStep', 'openStepModal'], ['btnOverviewPipeline', 'importWholePipeline'], ['btnOverviewAIPipeline', 'openAIPipelineAssist'],
      ['btnOverviewStarPass', 'starPassing'], ['btnOverviewExport', 'exportPlacement'], ['btnOverviewUndo', 'undoOrg'], ['btnOverviewRedo', 'redoOrg'],
      ['btnTrash', 'openTrashPage'], ['btnTrashBack', 'closeTrashPage'], ['btnTrashRestoreAll', 'restoreAllTrash'],
      ['btnGridBack', 'backGridFolder'], ['btnShot', 'saveImage'], ['btnAlign', 'toggleAlign'],
      ['btnEmptyFiles', 'pickImport'], ['btnEmptyFolder', 'pickImport'], ['btnEmptyDemo', 'loadDemo'], ['btnEmptyAIImport', 'openAIPipelineAssist'],
      ['btnEmptyAIPrompt', 'copyText'], ['btnEmptyAIExample', 'copyText'],
    ];
    for (const [id, command] of routes) {
      const button = h.get(index, id); button.disabled = false;
      h.clear(); h.api.focus(1 - index); h.fire(button);
      check(() => assert.equal(h.count(command), 1, id + ' is bound once in both panes'));
      check(() => assert.equal(h.last(command).pane, pane, id + ' runs with its pane'));
      if (id === 'btnAlign') check(() => assert.equal(h.last(command).args[0], pane));
      if (id === 'btnOverviewPipeline') check(() => assert.equal(h.last(command).args[0].pane, pane));
    }
    h.window.SB_AI_CHAT = { openSettingsUI() { h.calls.push({ name: 'settings', pane }); } };
    h.clear(); h.fire(h.get(index, 'btnOpenAISettings')); check(() => assert.equal(h.count('settings'), 1));
    const search = h.get(index, 'overviewSearch'), box = search.closest('.overview-search');
    search.value = 'own-layer'; h.api.focus(1 - index); h.fire(search, 'input');
    check(() => assert.equal(pane.query, 'own-layer')); check(() => assert.notEqual(other.query, 'own-layer'));
    h.fire(h.get(index, 'btnOverviewSearchToggle'));
    check(() => assert(box.classList.contains('is-open'))); check(() => assert.equal(h.document.activeElement, search));
    const escape = h.fire(search, 'keydown', { key: 'Escape' });
    check(() => assert(escape.defaultPrevented)); check(() => assert.equal(pane.query, '')); check(() => assert(box.classList.contains('is-open')));
    h.fire(search, 'keydown', { key: 'Escape' }); check(() => assert(!box.classList.contains('is-open')));
    search.value = 'clear me'; h.fire(search, 'input'); h.fire(h.get(index, 'btnOverviewSearchClear'));
    check(() => assert.equal(search.value, '')); check(() => assert.equal(h.document.activeElement, search));
    h.api.setPaneSearchOpen(pane, true); h.fire(h.document.body); check(() => assert(!box.classList.contains('is-open'), 'outside click closes search'));
    h.api.setPaneSearchOpen(pane, true); h.fire(h.get(index, 'btnOverviewMore'));
    check(() => assert(!box.classList.contains('is-open'), 'menu toggle also closes search despite stopped bubbling'));
    h.fire(h.document.body);
    pane.view.mode = 'grid'; pane.view.page = 1; h.clear(); h.fire(h.get(index, 'btnNextPage')); h.fire(h.get(index, 'btnPrevPage'));
    check(() => assert.equal(pane.view.page, 1)); check(() => assert.equal(h.count('rebuildGrid'), 2));
    const cols = h.get(index, 'selCols'), rows = h.get(index, 'selRows'); cols.value = '3'; h.fire(cols, 'change'); rows.value = '4'; h.fire(rows, 'change');
    check(() => assert.equal(pane.view.cols, 3)); check(() => assert.equal(pane.view.rows, 4)); check(() => assert.equal(h.storage.get('structboard.grid.shape'), '3x4'));
    check(() => assert.equal(pane.el.querySelector('.grid-layout-label').textContent, '3 × 4', 'layout menu label tracks pane shape'));
    h.fire(h.get(index, 'btnGridRec')); check(() => assert.equal(pane.view.cols, h.api.recommendGrid(pane).cols));
    const oldGrouping = pane.view.overviewGrouped, otherGrouping = other.view.overviewGrouped;
    h.clear(); h.fire(h.get(index, 'btnGridFlat'));
    check(() => assert.equal(pane.view.overviewGrouped, oldGrouping)); check(() => assert.equal(other.view.overviewGrouped, otherGrouping)); check(() => assert.equal(h.count('resetGridNavigation'), 0));
    check(() => assert.equal(pane.view.gridArrangement, 'flat'));check(() => assert.equal(h.last('setGridArrangement').args[1],pane));
    for (const [button, menu] of [['btnGridLayout', 'gridLayoutMenu'], ['btnGridAppearance', 'gridAppearanceMenu'], ['btnViewMore', 'viewMenu'], ['btnOverviewMore', 'overviewMoreMenu']]) {
      h.fire(h.get(index, button)); check(() => assert.equal(h.get(index, menu).hidden, false, 'menu opens once'));
      check(() => assert.equal(h.get(index, button).getAttribute('aria-expanded'), 'true'));
      h.fire(h.get(index, button)); check(() => assert.equal(h.get(index, menu).hidden, true, 'second click closes once'));
      h.fire(h.get(index, button)); h.fire(h.document.body); check(() => assert.equal(h.get(index, menu).hidden, true, 'outside closes menu'));
    }
    pane.view.soloFrom = 'overview'; pane.view.soloId = 'solo'; pane.view.overviewReturn = { drillId: 'owned-return' };
    h.clear(); h.fire(h.get(index, 'btnShowAll'));
    check(() => assert.equal(pane.view.soloId, null)); check(() => assert.equal(pane.view.mode, 'overview'));
    check(() => assert.equal(h.last('restore').args[0].drillId, 'owned-return'));
    pane.view.soloFrom = null; pane.view.soloId = 'solo'; h.clear(); h.fire(h.get(index, 'btnShowAll'));
    check(() => assert.equal(pane.view.soloId, null)); check(() => assert.equal(h.count('applyModeChange'), 1));
    const aliases = pane.el.querySelectorAll('[data-action="benchSide"], [data-action="benchOverlay"]');
    for (const alias of aliases) {
      h.fire(alias); check(() => assert.equal(pane.view.mode, alias.dataset.action === 'benchSide' ? 'grid' : 'overlay'));
      check(() => assert.equal(alias.getAttribute('aria-pressed'), 'true'));
    }
    pane.view.syncCamera = false; h.clear(); h.fire(h.get(index, 'btnFollowRef'));
    check(() => assert.equal(h.last('syncAllCameras').args[1], pane));
    h.fire(h.get(index, 'btnSyncCam')); check(() => assert.equal(h.last('syncAllCameras').args[0], true));
    pane.view.overlayViewer = { id: pane.id + '-overlay' }; pane.view.overlayRefs = [{ id: 'overlay-ref' }]; pane.view.gridViewers = [{ viewer: { id: pane.id + '-grid' }, entryId: 'left-model', ref: 'r' }];
    const theme = h.get(index, 'selTheme'); theme.value = 'chain-id'; h.clear(); h.fire(theme, 'change');
    check(() => assert.equal(h.count('applyTheme'), 2)); check(() => assert(h.calls.filter(call => call.name === 'applyTheme').every(call => call.args[2] === pane)));
    const repr = h.get(index, 'selRepr'); repr.value = 'spacefill'; h.fire(repr, 'change'); check(() => assert.equal(pane.view.repr, 'spacefill'));
    pane.view.mode = 'overlay'; const max = h.get(index, 'selMaxOverlay'); max.value = '50'; h.clear(); h.fire(max, 'change');
    check(() => assert.equal(pane.view.maxOverlay, 50)); check(() => assert.equal(h.last('rebuildOverlay').args[1], pane));
  }

  // Actual nested icon hits anchor the body action menu at the button, not stage.
  const actions = h.panes[1].el.querySelector('.pane-actions-btn');
  actions.rect = { left: 500, right: 540, top: 50, bottom: 80, width: 40, height: 30 };
  h.fire(actions.querySelector('circle')); const menu = h.api.menu();
  check(() => assert.equal(menu.hidden, false)); check(() => assert.equal(menu.style.top, '86px'));
  const newFolder = menu.querySelectorAll('button').find(button => button.textContent === '新建文件夹');
  h.api.focus(0); h.clear(); h.fire(newFolder);
  check(() => assert.equal(h.count('promptNewOrgFolder'), 1)); check(() => assert.equal(h.last('promptNewOrgFolder').pane, h.panes[1]));

  // Gesture starts do not rebuild: shared UI sync occurs after the target's drop.
  h.api.focus(0); h.clear(); h.fire(h.get(1, 'overviewCards'), 'pointerdown', { pointerId: 7 });
  check(() => assert.equal(h.api.active(), 1)); check(() => assert.equal(h.count('renderList'), 0));
  check(() => assert(h.calls.filter(call => call.name === 'syncPaneFocus').every(call => call.args[0] === false), 'gesture activation only performs light synchronization'));
  check(() => assert(h.calls.filter(call => call.name === 'activate').every(call => call.args[1].sync === false)));
  let dropCommitted = false;
  h.get(1, 'overviewCards').addEventListener('pointerup', () => { dropCommitted = true; });
  const syncsBeforeDrop = h.count('syncPaneFocus');
  h.fire(h.get(1, 'overviewCards'), 'pointerup', { pointerId: 7 });
  check(() => assert(dropCommitted)); check(() => assert.equal(h.count('syncPaneFocus'), syncsBeforeDrop)); h.flush();
  check(() => assert.equal(h.count('syncPaneFocus'), syncsBeforeDrop + 1)); check(() => assert.equal(h.last('syncPaneFocus').args[0], true));
  check(() => assert(h.count('renderList') > 0, 'shared sidebar follows the active pane after the gesture finishes'));
  h.api.focus(0); h.clear(); h.get(1, 'overviewSearch').focus(); check(() => assert.equal(h.api.active(), 1));
  const syncsBeforeFocusFrame = h.count('syncPaneFocus'); h.flush(); check(() => assert.equal(h.count('syncPaneFocus'), syncsBeforeFocusFrame + 1));

  // Async resets retain the originating pane/viewers after focus changes.
  const pane = h.panes[1], a = { id: 'right-a' }, b = { id: 'right-b' }, left = { id: 'left' };
  pane.view.mode = 'grid'; pane.view.syncCamera = true; pane.view.gridViewers = [{ viewer: a }, { viewer: b }]; h.panes[0].view.gridViewers = [{ viewer: left }];
  let release;
  h.context.resetCamera = (viewer, duration, paneOwner) => { h.calls.push({ name: 'capturedReset', args: [viewer, duration, paneOwner] }); return new Promise(resolve => { release = resolve; }); };
  h.clear(); const resetting = h.api.resetPaneCameras(pane); h.api.focus(0); release(); await resetting;
  check(() => assert.equal(h.last('capturedReset').args[0], a)); check(() => assert.equal(h.last('capturedReset').args[2], pane)); check(() => assert.equal(h.last('syncAllCameras').args[1], pane));
  pane.view.syncCamera = false; const resets = []; let first = true;
  h.context.resetCamera = viewer => { resets.push(viewer); if (first) { first = false; return new Promise(resolve => { release = resolve; }); } return Promise.resolve(); };
  const independent = h.api.resetPaneCameras(pane); h.api.focus(0); release(); await independent;
  check(() => assert.deepEqual(resets, [a, b], 'unlinked reset cannot migrate to the active pane'));
  const alias = pane.el.querySelector('[data-action="btnResetCam"]');
  h.clear(); h.context.resetCamera = async (viewer, duration, owner) => h.calls.push({ name: 'aliasReset', args: [viewer, duration, owner] });
  h.fire(alias);
  for (let turn = 0; turn < 30 && h.count('aliasReset') < 2; turn++) await Promise.resolve();
  check(() => assert.equal(h.count('aliasReset'), 2, 'narrow-toolbar reset alias works once per captured viewer'));
  check(() => assert(h.calls.filter(call => call.name === 'aliasReset').every(call => call.args[2] === pane)));

  // A new clone discards WebGL/minimap children while retaining toolbar templates.
  const cloneHarness = makeHarness({ bindAll: false });
  cloneHarness.panes[1].el.remove(); cloneHarness.document.getElementById('paneDivider').remove();
  cloneHarness.panes[1].el = null;
  for (const id of ['gridStage', 'overlayStage']) {
    const canvas = cloneHarness.document.createElement('canvas'); cloneHarness.get(0, id).appendChild(canvas);
  }
  const minimap = cloneHarness.document.createElement('div'); minimap.className = 'ov-minimap'; cloneHarness.get(0, 'overviewStage').appendChild(minimap);
  cloneHarness.api.clonePaneDom(); cloneHarness.panes[1].el = cloneHarness.document.getElementById('p2-stage');
  check(() => assert.equal(cloneHarness.get(1, 'gridStage').children.length, 0)); check(() => assert.equal(cloneHarness.get(1, 'overlayStage').children.length, 0));
  check(() => assert.equal(cloneHarness.panes[1].el.querySelectorAll('.ov-minimap').length, 0));
  check(() => assert(cloneHarness.get(1, 'selTheme') && cloneHarness.get(1, 'btnGridLayout'), 'toolbar templates survive clone cleanup'));
  check(() => assert.equal(cloneHarness.get(1, 'btnGridLayout').getAttribute('aria-controls'), 'p2-gridLayoutMenu'));

  // Exercise the real bridge, manifest loader, and final UI handoff without network.
  const pipeline = makeHarness({ realPipeline: true });
  pipeline.panes[1].view.mode = 'grid';
  pipeline.fire(pipeline.get(1, 'btnOverviewPipeline'));
  const pipelineDone = await pipeline.pipelineTask();
  check(() => assert.equal(pipelineDone, true, 'real pipeline bridge completes'));
  check(() => assert.equal(pipeline.panes[1].view.mode, 'overview'));
  check(() => assert.equal(pipeline.panes[0].view.mode, 'overview'));
  check(() => assert.equal(pipeline.context.rawS.entries.map(entry => entry.stepKey).join(','), 'fixture-pipe:s1'));
  check(() => assert.equal(pipeline.last('persistImport').args[1].entries[0].id, 'left-model'));

  const focusPipeline = makeHarness({ realPipeline: true });
  focusPipeline.panes[0].view.mode = 'overlay'; focusPipeline.panes[0].view.filter = 'left-filter'; focusPipeline.panes[0].view.activeGroupId = 'left-group';
  focusPipeline.panes[1].view.mode = 'grid'; focusPipeline.panes[1].view.filter = 'right-filter';
  const defaultFetch = focusPipeline.context.fetch;
  let releasePipeline;
  focusPipeline.fetchWith(url => url === '/api/pipelines' ? new Promise(resolve => { releasePipeline = async () => resolve(await defaultFetch(url)); }) : defaultFetch(url));
  focusPipeline.fire(focusPipeline.get(1, 'btnOverviewPipeline'));
  focusPipeline.api.focus(0); await releasePipeline();
  const focusPipelineDone = await focusPipeline.pipelineTask();
  check(() => assert.equal(focusPipelineDone, true, 'delayed pipeline import completes'));
  check(() => assert.equal(focusPipeline.panes[1].view.mode, 'overview', 'pipeline result returns to its initiating pane'));
  check(() => assert.equal(focusPipeline.panes[1].view.filter, '', 'replacement resets the initiating filter'));
  check(() => assert.equal(focusPipeline.panes[0].view.mode, 'overlay', 'focus switch during import preserves other pane mode'));
  check(() => assert.equal(focusPipeline.panes[0].view.filter, '', 'replacement clears the retired workspace filter in both panes'));
  check(() => assert.equal(focusPipeline.panes[0].view.activeGroupId, 'all', 'replacement drops old group IDs from both panes'));

  const replacement = makeHarness({ realPipeline: true });
  const r = replacement.context.rawS, id = 'fixture-pipe';
  const fixtureSteps = n => Array.from({ length: n }, (_, i) => ({ id: 's' + (i + 1), title: 'Step ' + (i + 1) }));
  r.entries = fixtureSteps(21).map(step => ({ id: 'old-' + step.id, stepKey: id + ':' + step.id, pipelineId: id }));
  replacement.panes[0].view.referenceId = 'old-s1'; replacement.panes[0].view.aligned = true;
  r.metrics.table = { stale: true }; r.autoScoreRows = [{ stale: true }];
  replacement.context.loadStepEdits = () => ({ [id + ':s1']: { order: 900, note: 'keep it' }, [id + ':s5']: { deleted: true } });
  const fixtureFetch = replacement.context.fetch;
  let failStep = '', stepCount = 11;
  replacement.fetchWith(async url => {
    if (url === '/api/pipelines') return { ok: true, json: async () => ({ ok: true, pipelines: [{ id, name: 'Fixture pipeline', steps: stepCount }] }) };
    if (url.includes('&raw=1')) return { ok: true, json: async () => ({ ok: true, pipeline: { id, steps: fixtureSteps(stepCount) } }) };
    const stepId = new URL(url, 'http://fixture.test').searchParams.get('step');
    if (stepId === failStep) return { ok: false, json: async () => ({ ok: false, error: 'unavailable' }) };
    if (stepId) return { ok: true, json: async () => ({ ok: true, stepId, files: stepId === 's5' ? [] : [{ path: 'same.pdb', sourceKey: id + '|' + stepId + '|same', fileKey: 'same' }] }) };
    return fixtureFetch(url);
  });
  const runReplacement = () => { replacement.fire(replacement.get(1, 'btnOverviewPipeline')); return replacement.pipelineTask(); };
  const originalEntries = r.entries;
  replacement.context.askSheet = async () => null;
  check(() => assert.equal(r.entries.length, 21));
  assert.equal(await runReplacement(), false);
  replacement.context.askSheet = async () => 'replace';
  failStep = 's7'; assert.equal(await runReplacement(), false);
  check(() => assert.equal(r.entries, originalEntries, 'cancel and partial read error leave old entries untouched'));
  failStep = '';
  const createSaver = replacement.context.workspaceSaveCoordinator;
  replacement.context.workspaceSaveCoordinator = () => ({ flush: async () => true, persistImport: async () => { throw Error('quota'); } });
  assert.equal(await runReplacement(), false);
  check(() => assert.equal(r.entries, originalEntries, 'transaction failure leaves the old workspace live'));
  replacement.context.workspaceSaveCoordinator = createSaver;
  assert.equal(await runReplacement(), true);
  check(() => assert.equal(r.entries.length, 10, 'the same physical file belongs independently to each nonempty step'));
  const expectedOrder = fixtureSteps(11).map(step => id + ':' + step.id).join(',');
  check(() => assert.equal(replacement.api.orderedStepBuckets(r.entries).map(step => step.key).join(','), expectedOrder, 'definition order and empty steps override stale same-ID edits'));
  check(() => assert.equal(replacement.last('persistImport').args[1].entries.length, 21));
  check(() => assert.equal(replacement.panes[0].view.referenceId, null));
  check(() => assert.equal(r.metrics.table, null));
  check(() => assert.equal(r.autoScoreRows.length, 0));
  assert.equal(await runReplacement(), true);
  check(() => assert.equal(replacement.api.orderedStepBuckets(r.entries).map(step => step.key).join(','), expectedOrder, 'repeat import is not additive'));

  const stepPipeline = makeHarness();
  stepPipeline.context.rawS.activePipelineId = 'step-pipe';
  stepPipeline.panes[0].view.mode = 'grid'; stepPipeline.panes[0].view.activeGroupId = 'left-step-group';
  stepPipeline.panes[1].view.mode = 'overlay'; stepPipeline.panes[1].view.filter = 'right-step-filter';
  let releaseStep;
  stepPipeline.fetchWith(async url => {
    if (url.includes('/api/pipeline/structures')) return new Promise(resolve => {
      releaseStep = () => resolve({ ok: true, json: async () => ({ ok: true, title: 'Async step', files: [{ name: 'right-model.pdb', path: 'right-model.pdb', sourceKey: 'right-step-source' }] }) });
    });
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  stepPipeline.api.focus(1);
  stepPipeline.window.dispatchEvent(new FixtureEvent('message', { source: stepPipeline.document.getElementById('pipelineFrame').contentWindow, origin: 'http://fixture.test', data: { type: 'pipelineOpenStep', id: 'step-pipe', stepId: 's2', title: 'Async step', requestId: 'async-step' } }));
  stepPipeline.api.focus(0); releaseStep();
  for (let turn = 0; turn < 30 && !stepPipeline.pipelineMessages.some(message => message.requestId === 'async-step' && ['done', 'error'].includes(message.state)); turn++) await Promise.resolve();
  const stepStatus = stepPipeline.pipelineMessages.filter(message => message.requestId === 'async-step').at(-1);
  check(() => assert.equal(stepStatus.state, 'done', 'single-step pipeline rendering completes'));
  check(() => assert.notEqual(stepPipeline.panes[1].view.activeGroupId, 'all', 'single-step scope is applied to its initiating pane'));
  check(() => assert.equal(stepPipeline.panes[0].view.activeGroupId, 'left-step-group'));
  check(() => assert.equal(stepPipeline.panes[1].view.filter, ''));
  check(() => assert.equal(stepPipeline.last('rebuildOverlay').args[1], stepPipeline.panes[1], 'step render receives its captured pane'));

  // Dispose removes all stage/window listeners, allows a clean rebind, and is safe twice.
  const controller = h.api.bindPaneControls(pane); controller.dispose(); controller.dispose(); h.clear();
  h.fire(h.get(1, 'btnOverviewNewFolder')); check(() => assert.equal(h.count('promptNewOrgFolder'), 0));
  const rebound = h.api.bindPaneControls(pane); check(() => assert.notEqual(rebound, controller));
  h.fire(h.get(1, 'btnOverviewNewFolder')); check(() => assert.equal(h.count('promptNewOrgFolder'), 1));
  console.log('pane controls ok (' + assertions + ' checks: actual bind/clone/delegation, both panes, single-fire, menus/search, aliases, owner controls, gesture deferral, async camera isolation, dispose/rebind)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
