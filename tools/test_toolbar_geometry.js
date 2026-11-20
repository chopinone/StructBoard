'use strict';

// Run: node tools/test_toolbar_geometry.js
// Executes the actual geometry, label, mode, and observer code from app.js.
// DOM heights are supplied fixtures: this tests propagation/order/idempotence,
// not CSS flex layout or browser rendering. No packages, WebGL, or real timers.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

function functionSource(name) {
  const match = source.match(new RegExp('^  function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}', 'm'));
  assert(match, 'Missing source function: ' + name);
  return match[0];
}

// Only execute the observer registration at the end of bind(), avoiding unrelated
// application event bindings. The callback and registration are unmodified source.
const bindSource = functionSource('bind');
const observerStart = bindSource.lastIndexOf('\n    if (window.ResizeObserver) {');
assert(observerStart >= 0, 'Missing optional ResizeObserver binding');
const observerSource = bindSource.slice(observerStart, bindSource.lastIndexOf('\n  }'));

function makeHarness(withObserver = true) {
  const elements = new Map(), frames = new Map(), observers = [], rebuilds = [];
  let frameId = 0;
  function element(id) {
    const properties = new Map(), writes = [];
    const node = {
      id, hidden: false, innerHTML: '', attributes: {}, label: { textContent: '' },
      style: {
        writes, display: '',
        getPropertyValue: name => properties.get(name) || '',
        setProperty(name, value) { properties.set(name, value); writes.push([name, value]); },
      },
      classList: { toggle() {}, contains() { return false; } },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector(selector) { return selector === 'span' ? this.label : null; },
      closest() { return elements.get('reprGroup'); },
    };
    elements.set(id, node);
    return node;
  }
  for (const id of ['stage', 'toolbar', 'gridStage', 'overviewStage', 'btnAlign', 'emptyState',
    'camDock', 'gridPager', 'selRepr', 'reprGroup', 'btnFollowRef', 'gridTools', 'overlayTools',
    'benchToggle', 'btnGridBack', 'benchSide', 'benchOverlay', 'overlayStage', 'trashStage', 'stageBadge']) element(id);
  const get = id => elements.get(id);
  const toolbar = get('toolbar');
  toolbar.offsetTop = 12;
  toolbar.measureHeight = () => 44;
  Object.defineProperty(toolbar, 'offsetHeight', { get: () => toolbar.hidden ? 0 : toolbar.measureHeight() });
  const state = { rows: 2, cols: 3, entries: [{ alignInfo: null }], mode: 'grid', gridCells: [], aligned: false };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
  }
  const snapshot = () => ({
    grid: get('gridStage').style.getPropertyValue('--grid-top'),
    overview: get('overviewStage').style.getPropertyValue('--overview-top'),
  });
  const context = vm.createContext({
    S: state, $: get,
    window: withObserver ? { ResizeObserver } : {}, ResizeObserver,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    rebuildGrid() { rebuilds.push({ mode: 'grid', ...snapshot() }); },
    rebuildOverlay() { rebuilds.push({ mode: 'overlay', ...snapshot() }); },
    rebuildOverview() { rebuilds.push({ mode: 'overview', ...snapshot() }); },
  });
  const names = ['updateGridGeometry', 'resizeGridViewers', 'refreshAlignBtn', 'updateEmptyState', 'applyModeChange'];
  vm.runInContext('let gridResizeRaf = 0;\n' + names.map(functionSource).join('\n') +
    '\nglobalThis.api = { ' + names.join(', ') + ', observeToolbar: function () {' + observerSource + '\n} };', context);
  return {
    api: context.api, state, get, toolbar, frames, observers, rebuilds, snapshot,
    clearWrites() { for (const node of elements.values()) node.style.writes.length = 0; },
    writeCount() { return [...elements.values()].reduce((count, node) => count + node.style.writes.length, 0); },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
  };
}

function expectClearance(h, expected, label) {
  assert.deepEqual(h.snapshot(), { grid: expected + 'px', overview: expected + 'px' }, label);
}

// Reproduce the reported ordering: grid is built with the short label, then
// refreshAlignBtn expands it. Extra rows must be reserved before another frame.
for (const heights of [{ raw: 44, aligned: 82 }, { raw: 82, aligned: 120 }]) {
  const h = makeHarness();
  h.toolbar.measureHeight = () => /已对齐/.test(h.get('btnAlign').label.textContent) ? heights.aligned : heights.raw;
  h.api.applyModeChange(true);
  expectClearance(h, 12 + heights.raw + 10, 'initial grid clearance');
  h.state.entries[0].alignInfo = { rmsd: 20.22 };
  h.state.aligned = true;
  h.api.refreshAlignBtn();
  assert.equal(h.get('btnAlign').label.textContent, '已对齐');
  assert.match(h.get('btnAlign').title, /RMSD 20\.22 Å/);
  expectClearance(h, 12 + heights.aligned + 10, 'aligned label must synchronously clear all wrapped rows');
  assert.equal(h.frames.size, 1, 'multiple synchronous updates should coalesce viewer resizes');
  h.state.entries[0].alignInfo = null;
  h.state.aligned = false;
  h.api.refreshAlignBtn();
  expectClearance(h, 12 + heights.raw + 10, 'short label must reclaim unused space');
}

{
  const h = makeHarness();
  // Fixture changes after mode controls/stages change visibility.
  h.toolbar.measureHeight = () => h.get('gridStage').hidden ? 44 : 82;
  h.api.applyModeChange(true);
  assert.deepEqual(h.rebuilds[0], { mode: 'grid', grid: '104px', overview: '104px' }, 'clearance precedes rebuild');
  h.state.mode = 'overview';
  h.api.applyModeChange(false);
  assert(h.get('btnFollowRef').hidden && h.get('camDock').hidden && h.get('gridStage').hidden);
  expectClearance(h, 66, 'mode changes without a rebuild must still synchronize geometry');
  h.state.mode = 'overlay';
  h.api.applyModeChange(false);
  assert.equal(h.get('btnFollowRef').hidden, false);
  assert.equal(h.get('camDock').hidden, false);
  h.state.entries = [];
  h.api.applyModeChange(false);
  assert(h.toolbar.hidden);
  expectClearance(h, 10, 'hidden toolbar must release its old height');
  h.state.entries = [{}];
  h.state.mode = 'grid';
  h.api.applyModeChange(false);
  expectClearance(h, 104, 'restoring toolbar and grid must use visible dimensions');
}

{
  const h = makeHarness();
  h.api.observeToolbar();
  assert.equal(h.observers.length, 1);
  const observer = h.observers[0];
  assert.deepEqual(observer.targets.map(item => item.target.id), ['toolbar', 'stage']);
  assert.equal(observer.targets[0].options.box, 'border-box', 'padding changes affect toolbar border-box height');
  observer.callback();
  expectClearance(h, 66, 'initial observation');
  h.toolbar.measureHeight = () => 120;
  observer.callback();
  expectClearance(h, 142, 'stage/sidebar/font resize observation must clear every row');
  h.clearWrites();
  for (let i = 0; i < 10; i++) observer.callback();
  assert.equal(h.writeCount(), 0, 'unchanged observer deliveries must not rewrite CSS variables');
  assert.equal(h.frames.size, 1, 'observer bursts must schedule one viewer pass');
  let visibleResizes = 0, hiddenResizes = 0;
  h.state.gridCells = [
    { viewer: { handleResize() { visibleResizes++; } }, box: { style: { display: '' } } },
    { viewer: { handleResize() { hiddenResizes++; } }, box: { style: { display: 'none' } } },
  ];
  h.flush();
  assert.equal(visibleResizes, 1);
  assert.equal(hiddenResizes, 0);
  h.state.rows = 4; h.state.cols = 8;
  h.api.updateGridGeometry();
  assert.equal(h.get('gridStage').style.getPropertyValue('--grid-rows'), '4');
  assert.equal(h.get('gridStage').style.getPropertyValue('--grid-cols'), '8');
  h.toolbar.offsetTop = 12.25;
  h.toolbar.measureHeight = () => 81.5;
  h.api.updateGridGeometry();
  expectClearance(h, 104, 'fractional measurements must round up');
}

{
  const h = makeHarness(false);
  h.api.observeToolbar();
  assert.equal(h.observers.length, 0, 'ResizeObserver remains optional');
  h.toolbar.measureHeight = () => 82;
  h.api.refreshAlignBtn();
  expectClearance(h, 104, 'label updates remain synchronous without ResizeObserver');
}

console.log('toolbar geometry ok (label growth/shrink, modes, visibility, resize observation, idempotence, viewer coalescing)');
