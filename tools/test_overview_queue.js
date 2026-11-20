'use strict';

// Run: node tools/test_overview_queue.js
// Executes the actual, unmodified overview.js. No browser, packages, real timers,
// WebGL, localStorage, or on-disk IndexedDB are used. The DOM/IDB doubles implement
// only the entry-card and thumbnail operations exercised below, not browser layout
// or the full IndexedDB transaction/error model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.resolve(__dirname, '../overview.js');
const source = fs.readFileSync(sourcePath, 'utf8');

class Clock {
  constructor() { this.now = 0; this.nextId = 0; this.tasks = new Map(); this.executed = 0; }
  setTimeout(fn, delay = 0) {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + Math.max(0, delay), fn });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  async flush() {
    // Drain nested async hooks, IDB continuations, and pump's finally block before
    // advancing virtual time. These promises run on Node's native microtask queue.
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }
  async next() {
    await this.flush();
    let chosen;
    for (const item of this.tasks) {
      if (!chosen || item[1].at < chosen[1].at) chosen = item;
    }
    if (!chosen) return false;
    this.tasks.delete(chosen[0]);
    this.now = chosen[1].at;
    this.executed++;
    chosen[1].fn(this.now);
    await this.flush();
    return true;
  }
  async until(predicate, label, limit = 20000) {
    await this.flush();
    for (let i = 0; !predicate(); i++) {
      assert(i < limit, label + ': exceeded deterministic callback budget');
      assert(await this.next(), label + ': stalled with no scheduled callbacks');
    }
  }
  async idle(label, limit = 20000) {
    await this.until(() => !this.tasks.size, label, limit);
    await this.flush();
    assert.equal(this.tasks.size, 0, label + ': microtasks scheduled more work');
  }
  async advance(ms) {
    const end = this.now + ms;
    await this.flush();
    for (let i = 0; ; i++) {
      const due = [...this.tasks.values()].some(t => t.at <= end);
      if (!due) break;
      assert(i < 20000, 'advance: possible infinite timer/pump loop');
      await this.next();
    }
    this.now = end;
    await this.flush();
  }
}

function imagePixels(width, height, blank) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 246; pixels[i + 1] = 245; pixels[i + 2] = 240; pixels[i + 3] = 255;
  }
  if (!blank) {
    for (let i = 0; i < 16; i++) {
      const offset = (Math.floor(height / 2) * width + Math.floor(width / 2) + i) * 4;
      pixels[offset] = 40; pixels[offset + 1] = 80; pixels[offset + 2] = 130;
    }
  }
  return { data: pixels };
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.style = { setProperty(k, v) { this[k] = v; } };
    this.className = ''; this.attributes = {}; this.listeners = new Map();
    this.scrollTop = 0; this.clientWidth = 460; this.clientHeight = 200;
    this.offsetTop = 0; this.hidden = false; this.src = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { for (const name of names) this.classList.toggle(name, true); },
      remove: (...names) => { for (const name of names) this.classList.toggle(name, false); },
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !names.has(name) : !!force;
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(' '); return on;
      },
    };
  }
  get firstChild() { return this.children[0] || null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const result = [];
    const match = element => {
      if (selector.startsWith('#')) return element.id === selector.slice(1);
      const suffix = /^\[id\$="([^"]+)"\]$/.exec(selector);
      if (suffix) return (element.id || '').endsWith(suffix[1]);
      if (selector.startsWith('.')) return element.classList && element.classList.contains(selector.slice(1));
      if (selector === '[id]') return !!element.id;
      return element.tagName === selector.toUpperCase();
    };
    const visit = element => {
      for (const child of element.children || []) { if (match(child)) result.push(child); visit(child); }
    };
    visit(this); return result;
  }
  contains(child) { return child === this || this.children.some(node => node.contains && node.contains(child)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, bottom: this.clientHeight, right: this.clientWidth }; }
  setPointerCapture(id) { this.capturedPointer = id; }
  releasePointerCapture(id) { if (this.capturedPointer === id) this.capturedPointer = null; }
  focus() { this.focused = true; }
  get scrollHeight() {
    const spacer = this.children.find(c => c.id === 'overviewSpacer');
    return spacer ? Math.max(this.clientHeight, parseFloat(spacer.style.height) || 0) : this.clientHeight;
  }
  set innerHTML(value) {
    this.replaceChildren();
    if (value.startsWith('<div class="overview-step-row">')) {
      const stack = [this];
      for (const match of value.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
        if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
        const node = new Element(match[2]);
        for (const attr of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) {
          if (attr[1] === 'class') node.className = attr[2];
          else node.setAttribute(attr[1], attr[2]);
        }
        stack[stack.length - 1].appendChild(node);
        if (!match[3].endsWith('/') && !['input', 'br'].includes(match[2])) stack.push(node);
      }
      return;
    }
    // Entry cards only inspect the first span of their star button. SVG markup
    // and minimap markup are deliberately inert; no folder/section tests use it.
    if (this.tagName === 'BUTTON' && value.startsWith('<span')) this.appendChild(new Element('span'));
  }
  appendChild(child) {
    if (child.parentElement) child.remove();
    this.children.push(child); child.parentElement = this; return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.append(...children);
  }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  removeEventListener(name, callback) {
    const listeners = this.listeners.get(name) || [];
    this.listeners.set(name, listeners.filter(listener => listener !== callback));
    if (!this.listeners.get(name).length) this.listeners.delete(name);
  }
  dispatch(name, event = {}) {
    for (const callback of [...(this.listeners.get(name) || [])]) callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, values) => count + values.length, 0); }
  getContext() {
    assert.equal(this.tagName, 'CANVAS');
    return {
      drawImage: bitmap => { this.blankImage = bitmap.blank; },
      getImageData: () => imagePixels(this.width, this.height, this.blankImage),
    };
  }
}

function makeIDB(clock) {
  const stores = new Map(), opens = [], reads = [], writes = [], connections = [];
  let closes = 0;
  function request(action) {
    const req = {};
    clock.setTimeout(() => { req.result = action(); if (req.onsuccess) req.onsuccess(); });
    return req;
  }
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: name => stores.set(name, new Map()),
    transaction(names, mode) {
      assert.equal(mode, 'readwrite');
      for (const name of names) assert(stores.has(name), 'unknown fake IDB store: ' + name);
      return { objectStore(name) {
        const store = stores.get(name);
        return {
          get(key) { reads.push({ name, key }); return request(() => structuredClone(store.get(key))); },
          put(value, key) {
            writes.push({ name, key });
            const copy = structuredClone(value);
            return request(() => { store.set(key, copy); return key; });
          },
          delete(key) { return request(() => store.delete(key)); },
        };
      } };
    },
  };
  return {
    stores, opens, reads, writes, connections,
    get closes() { return closes; },
    open(name, version) {
      opens.push({ name, version });
      const req = {};
      clock.setTimeout(() => {
        const connection = Object.create(db); let closed = false;
        connection.close = () => { if (!closed) { closed = true; closes++; } };
        connections.push(connection); req.result = connection;
        if (!stores.size && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

function harness(options = {}) {
  const clock = new Clock(), indexedDB = makeIDB(clock);
  const ids = new Map();
  for (const id of ['overviewScroll', 'overviewSpacer', 'overviewCards', 'overviewStatus',
    'overviewEmpty', 'overviewTitle', 'btnOverviewPause', 'btnOverviewLite',
    'btnOverviewBack', 'thumbnailHost']) {
    const element = new Element(); element.id = id; ids.set(id, element);
  }
  const scroll = ids.get('overviewScroll'), layer = ids.get('overviewCards');
  const root = new Element(); root.append(scroll);
  scroll.append(ids.get('overviewSpacer'), layer);
  const documentEvents = new Element(), windowEvents = new Element(), observerInstances = [];
  const document = {
    hidden: false, body: new Element('body'), activeElement: null,
    getElementById: id => ids.get(id) || null,
    querySelector: () => null,
    createElement: tag => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: text => ({ text, nodeType: 3, toString() { return text; } }),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  };
  const calls = { loads: [], captures: [], starts: 0, stops: 0, creates: 0,
    disposed: 0, commits: 0, liveLoop: false, maxLiveViewers: 0, liveViewers: 0 };
  const urls = new Set(), revoked = [], warnings = [], decodes = [];
  let urlSeq = 0, currentEntry;
  const window = {
    document, indexedDB, console: { warn: (...args) => warnings.push(args) },
    Blob, performance: { now: () => clock.now },
    async createImageBitmap(blob) {
      const text = await blob.text();
      decodes.push(text);
      if (options.decodeGate) await options.decodeGate(text, decodes.length);
      return { width: 320, height: 240, blank: text === 'blank', close() {} };
    },
    Date: class extends Date { static now() { return clock.now; } },
    URL: {
      createObjectURL() { const url = 'blob:test-' + (++urlSeq); urls.add(url); return url; },
      revokeObjectURL(url) { assert(urls.delete(url), 'URL revoked twice: ' + url); revoked.push(url); },
    },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    requestAnimationFrame: callback => clock.setTimeout(callback, 16),
    cancelAnimationFrame: clock.clearTimeout.bind(clock),
    requestIdleCallback: callback => clock.setTimeout(callback, 24),
    cancelIdleCallback: clock.clearTimeout.bind(clock),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; observerInstances.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); this.disconnected = true; }
    },
    SB_LINEAGE: { entryText: () => '' },
  };
  window.SB_UI={createSurface:require('./surface_fixture.cjs')(document)};
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../notes_edit.js'), 'utf8'), window);
  vm.runInNewContext(source, window, { filename: sourcePath });
  const hooks = {
    key: entry => entry.id, metric: () => '', color: () => '#abc', liteDefault: () => false,
    async createViewer() {
      calls.creates++; calls.liveViewers++;
      calls.maxLiveViewers = Math.max(calls.maxLiveViewers, calls.liveViewers);
      if (options.createGate) await options.createGate(calls.creates);
      let disposed = false;
      return {
        handleResize() {},
        dispose() { if (!disposed) { disposed = true; calls.disposed++; calls.liveViewers--; } },
        plugin: {
          animationLoop: {
            start() { calls.starts++; calls.liveLoop = true; },
            stop(arg) { assert.equal(arg.noDraw, true); calls.stops++; calls.liveLoop = false; },
          },
          canvas3d: { commit(sync) { assert.equal(sync, true); calls.commits++; } },
          helpers: { viewportScreenshot: {
            values: {}, behaviors: { values: { next(value) {
              assert.equal(value.resolution.params.width, 320);
              assert.equal(value.resolution.params.height, 240);
            } } },
            async getPreview(_context, width) {
              assert.equal(width, 320); calls.captures.push(currentEntry.id);
              const attempt = calls.captures.filter(id => id === currentEntry.id).length;
              const blank = !!(options.blankCapture && options.blankCapture(currentEntry, attempt));
              return { canvas: { width: 320, height: 240,
                getContext: () => ({ getImageData: () => imagePixels(320, 240, blank) }),
                toBlob(callback, type) {
                  assert.equal(type, 'image/webp');
                  const entry = currentEntry;
                  const finish = () => callback(new Blob([blank ? 'blank' : 'thumbnail:' + entry.id], { type }));
                  if (options.blobGate) options.blobGate(entry, finish); else finish();
                },
              } };
            },
          } },
        },
      };
    },
    async clearViewer() {},
    async loadEntryInto(_viewer, entry) {
      currentEntry = entry; calls.loads.push(entry.id);
      if (options.loadGate) await options.loadGate(entry);
      return entry.id;
    },
    async prepare() {}, async resetCamera() {},
  };
  const create = overrides => window.SB_OVERVIEW.create({ ...hooks, ...overrides });
  const pane = (prefix, overrides = {}) => {
    const paneRoot = new Element(), paneIds = new Map();
    for (const id of ['overviewScroll', 'overviewSpacer', 'overviewCards', 'overviewStatus',
      'overviewEmpty', 'overviewTitle', 'btnOverviewPause', 'btnOverviewLite', 'btnOverviewBack']) {
      const node = new Element(); node.id = prefix + id; paneIds.set(id, node);
      paneRoot.appendChild(node);
    }
    const paneScroll = paneIds.get('overviewScroll');
    paneScroll.append(paneIds.get('overviewSpacer'), paneIds.get('overviewCards'));
    document.body.appendChild(paneRoot);
    return { api: create({ root: paneRoot, panePrefix: prefix, ...overrides }),
      root: paneRoot, ids: paneIds, scroll: paneScroll, layer: paneIds.get('overviewCards') };
  };
  return { clock, indexedDB, ids, scroll, layer, root, calls, urls, revoked, warnings, decodes, create, pane,
    document, window, hooks, windowEvents, documentEvents, observerInstances,
    assertHealthy(api) {
      assert.equal(api.stats.errors, 0, 'production pump recorded errors');
      assert.equal(warnings.length, 0, 'production code warned: ' + warnings.map(String).join('; '));
      assert.equal(calls.liveLoop, false, 'animation loop left running');
      assert(calls.maxLiveViewers <= 1, 'multiple thumbnail viewers alive');
      assert.equal(api.stats.busy, false);
      assert.equal(api.stats.queueLength, 0);
    },
  };
}

function nodes(count) {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'entry', entry: { id: 'entry-' + i, name: 'model_' + i + '.pdb' }, pos: 1, total: 1,
  }));
}
function snapshot(api) { return JSON.parse(JSON.stringify(api.stats)); }
function assertExactlyOnce(actual, expected) {
  assert.deepEqual([...actual].sort(), expected.map(n => n.entry.id).sort());
  assert.equal(new Set(actual).size, actual.length, 'duplicate capture/load');
}

async function scrollBurstLayoutCache() {
  const h = harness(), api = h.create(), list = nodes(1000);
  h.ids.get('btnOverviewPause').onclick();
  api.refresh(list, true);
  assert.equal(api.stats.paused, true);
  assert(api.stats.mountedCards < list.length, '1000-node fixture must be virtualized');

  let before = snapshot(api);
  for (const top of [20, 40, 60]) {
    h.scroll.scrollTop = top;
    h.scroll.dispatch('scroll');
  }
  await h.clock.advance(16);
  assert.equal(api.stats.windowRenders, before.windowRenders + 1, 'scroll burst rendered more than once in a frame');
  assert.equal(h.scroll.scrollTop, 60, 'frame did not render the latest scrollTop');
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds, 'scroll rebuilt a stable layout');
  assert(api.stats.itemsVisited - before.itemsVisited > 0);
  assert(api.stats.itemsVisited - before.itemsVisited < list.length, 'scroll visited the full list');
  assert.equal(api.stats.cardsPainted, before.cardsPainted, 'unchanged mounted cards were repainted');

  before = snapshot(api);
  for (const top of [12000, 26000, 47000]) {
    h.scroll.scrollTop = top;
    h.scroll.dispatch('scroll');
  }
  await h.clock.advance(16);
  assert.equal(api.stats.windowRenders, before.windowRenders + 1, 'second scroll burst rendered more than once');
  assert.equal(h.scroll.scrollTop, 47000, 'render ignored the last scroll position');
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds);
  assert(api.stats.itemsVisited - before.itemsVisited <= 20, 'visible-window scan exceeded its bound');
  const mountedTops = h.layer.children.map(card => parseFloat(card.style.top));
  assert(mountedTops.length > 0);
  assert(Math.min(...mountedTops) >= 46500 && Math.max(...mountedTops) <= 47500,
    'mounted cards do not match the latest viewport');

  before = snapshot(api);
  h.scroll.clientWidth += 60;
  h.windowEvents.dispatch('resize');
  await h.clock.advance(16);
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds + 1, 'resize did not invalidate layout');

  const minimap = h.root.querySelector('.ov-minimap');
  assert(minimap, 'fixture minimap is missing');
  before = snapshot(api);
  h.scroll.clientHeight += 100;
  h.scroll.offsetTop += 18;
  h.windowEvents.dispatch('resize');
  await h.clock.advance(16);
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds, 'height-only resize rebuilt content layout');
  assert.equal(minimap.style.height, h.scroll.clientHeight + 'px', 'minimap height stayed stale');
  assert.equal(minimap.style.top, h.scroll.offsetTop + 'px', 'minimap vertical position stayed stale');

  before = snapshot(api);
  assert.equal(api.setSearch('model_999'), true);
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds + 1, 'query did not invalidate layout');

  before = snapshot(api);
  api.refresh(nodes(900), true);
  assert.equal(api.stats.layoutBuilds, before.layoutBuilds + 1, 'refresh did not invalidate layout');
  assert.equal(api.stats.paused, true, 'refresh unexpectedly resumed thumbnail generation');
  api.destroy(); await h.clock.idle('scroll/layout cleanup');
  assert.equal(h.urls.size, 0);
  return '1000 nodes: one render per burst, latest viewport only, unchanged cards retained; resize/query/refresh rebuild';
}

async function offscreenCompletion() {
  const h = harness(), api = h.create(), list = nodes(24);
  api.refresh(list, true);
  const mounted = h.layer.children.map(box => box.dataset.entryId);
  assert(mounted.length > 0 && mounted.length < list.length, 'fixture must be virtualized');
  await h.clock.idle('fixed-viewport completion');
  assert.equal(api.stats.generated, list.length);
  assert.equal(api.stats.completedKeys, list.length);
  assertExactlyOnce(h.calls.captures, list); assertExactlyOnce(h.calls.loads, list);
  assert(h.calls.captures.some(id => !mounted.includes(id)), 'no offscreen job captured');
  assert.equal(h.scroll.scrollTop, 0);
  assert.deepEqual(h.layer.children.map(box => box.dataset.entryId), mounted);
  h.assertHealthy(api);
  const result = `${list.length} captures, ${mounted.length} mounted, scrollTop=0`;
  api.clear(); await h.clock.idle('offscreen cleanup'); assert.equal(h.urls.size, 0);
  return result;
}

async function visibleViewportPriority() {
  const h = harness(), api = h.create(), list = nodes(120);
  h.scroll.clientWidth = 1280;
  h.scroll.clientHeight = 260;
  api.refresh(list, true);
  const visible = h.layer.children.filter(function (card) {
    const top = Number.parseFloat(card.style.top) || 0;
    const height = Number.parseFloat(card.style.height) || 0;
    return top + height >= h.scroll.scrollTop && top <= h.scroll.scrollTop + h.scroll.clientHeight;
  }).map(card => card.dataset.entryId);
  assert(visible.length >= 4, 'fixture must show at least four covers in its viewport');
  await h.clock.until(() => h.calls.captures.length >= visible.length, 'visible covers first');
  assert.deepEqual(h.calls.captures.slice(0, visible.length), visible,
    'offscreen thumbnails started before the covers visible on first paint');
  await h.clock.idle('background thumbnail completion');
  assert.equal(api.stats.generated, visible.length, 'large step must stop after visible covers');
  assert(!h.calls.loads.includes('entry-119'), 'unseen end of large step was loaded');
  h.assertHealthy(api);
  api.clear(); await h.clock.idle('visible priority cleanup');
  return `${visible.length} visible covers; ${list.length - visible.length} unseen covers left unloaded`;
}

async function lazyLoadKeyChangeCompletes() {
  const h = harness({ loadGate: async entry => { entry.loaded = true; } });
  const list = nodes(6), api = h.create({key:entry=>entry.id + (entry.loaded ? ':loaded' : ':catalog')});
  api.refresh(list,true);
  await h.clock.idle('lazy load cache-key transition completes');
  assert.equal(api.stats.generated,6,'a cache-key change during first load must not abandon the visible cover');
  assert.deepEqual([...new Set(h.calls.captures)].sort(),list.map(node=>node.entry.id).sort());
  assert.equal(api.stats.errors,0);
  api.clear();await h.clock.idle('lazy key transition cleanup');
  return 'all six covers complete after catalog data turns into loaded coordinates';
}

async function pauseInFlight() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ loadGate: () => gate }), api = h.create(), list = nodes(8);
  api.refresh(list, true);
  await h.clock.until(() => h.calls.loads.length === 1, 'reach suspended load');
  assert.equal(h.calls.liveLoop, true, 'fixture did not enter viewer work');
  h.ids.get('btnOverviewPause').onclick();
  assert.equal(api.stats.paused, true);
  assert.equal(h.calls.liveLoop, false, 'pause did not immediately stop animation loop');
  assert.equal(api.stats.queueLength, 0);
  release(); await h.clock.idle('paused in-flight job');
  assert.equal(api.stats.generated, 0); assert.equal(h.calls.captures.length, 0);
  assert.equal(api.stats.discarded, 1);
  const before = { stats: snapshot(api), loads: h.calls.loads.length, starts: h.calls.starts };
  await h.clock.advance(10000);
  assert.deepEqual(snapshot(api), before.stats, 'paused state kept pumping');
  assert.equal(h.calls.loads.length, before.loads); assert.equal(h.calls.starts, before.starts);
  h.assertHealthy(api);
  h.ids.get('btnOverviewPause').onclick();
  await h.clock.idle('resume completion');
  assert.equal(api.stats.paused, false); assert.equal(api.stats.generated, list.length);
  assertExactlyOnce(h.calls.captures, list); h.assertHealthy(api);
  api.clear(); await h.clock.idle('pause cleanup'); assert.equal(h.urls.size, 0);
  return 'in-flight pause stops loop immediately; 0 captures while paused; resume captures all 8';
}

async function cachedRestart() {
  const h = harness(), first = h.create(), list = nodes(24);
  first.refresh(list, true); await h.clock.idle('prime cache');
  assert.equal(first.stats.generated, list.length);
  assert.equal(h.indexedDB.stores.get('thumbs').size, list.length);
  const initial = { captures: h.calls.captures.length, loads: h.calls.loads.length,
    creates: h.calls.creates, writes: h.indexedDB.writes.filter(write => write.name === 'thumbs').length };
  first.leave(); first.refresh(list, true);
  await h.clock.idle('same-instance memory restart');
  assert.equal(h.calls.captures.length, initial.captures);
  assert.equal(h.calls.loads.length, initial.loads);
  assert.equal(h.calls.creates, initial.creates);
  assert.equal(h.indexedDB.writes.filter(write => write.name === 'thumbs').length, initial.writes);
  h.assertHealthy(first);
  first.clear(); await h.clock.idle('drop memory cache'); assert.equal(h.urls.size, 0);
  // A new controller has no memory cache or completed keys. IDB alone must serve
  // every entry, including offscreen entries explicitly queued by fill.
  const second = h.create(); second.refresh(list, true);
  second.renderWindow({ fill: true });
  await h.clock.idle('new-instance disk restart');
  assert.equal(second.stats.generated, 0);
  assert.equal(second.stats.cacheItems, list.length);
  // Visible recall can fill memory before pump's cache fast path; only jobs
  // actually resolved by the disk branch enter completed. Validate disk coverage
  // directly instead of depending on that internal scheduling detail.
  for (const node of list) assert(h.indexedDB.reads.some(read =>
    read.name === 'thumbs' && read.key === node.entry.id), 'entry was not recalled from disk');
  assert.equal(h.calls.captures.length, initial.captures);
  assert.equal(h.calls.loads.length, initial.loads);
  assert.equal(h.calls.creates, initial.creates, 'cache hits created a viewer');
  // IDB reads legitimately update meta.touched; only thumbnail Blob writes
  // would indicate unnecessary recapture/persistence on a cache hit.
  assert.equal(h.indexedDB.writes.filter(write => write.name === 'thumbs').length,
    initial.writes, 'cache hits rewrote saved thumbnails');
  assert.equal(second.stats.busy, false);
  const restartCallbacks = h.clock.executed;
  await h.clock.advance(60000);
  assert.equal(h.clock.executed, restartCallbacks, 'disk cache restart kept scheduling work');
  assert.equal(h.calls.captures.length, initial.captures);
  assert.equal(h.calls.loads.length, initial.loads);
  assert.equal(h.calls.creates, initial.creates);
  second.clear(); await h.clock.idle('restart cleanup'); assert.equal(h.urls.size, 0);
  return '24 memory hits and 24 disk hits; restart adds 0 captures, loads, viewers, or writes';
}

async function evictionQuiescence() {
  const h = harness(), api = h.create();
  const capacity = Math.floor(api.stats.decodedByteLimit /
    (api.stats.bitmapWidth * api.stats.bitmapHeight * 4));
  const list = nodes(capacity + 14);
  api.refresh(list, true);
  const rowHeight = parseFloat(h.layer.children[0].style.height) + 10;
  // Visit every row as a user would; no automatic whole-workspace fill.
  for (let row = 0; row < Math.ceil(list.length / 2); row++) {
    h.scroll.scrollTop = row * rowHeight; h.scroll.dispatch('scroll');
    await h.clock.idle('visited row ' + row, 30000);
  }
  h.scroll.scrollTop = 0; h.scroll.dispatch('scroll');
  await h.clock.idle('return after eviction', 30000);
  assert.equal(api.stats.generated, list.length);
  assert.equal(api.stats.completedKeys, list.length);
  assert(api.stats.evictions > 0, 'fixture never exceeded real memory budget');
  assert(api.stats.cacheItems < list.length);
  assert(api.stats.decodedCacheBytes <= api.stats.decodedByteLimit);
  assert.equal(h.indexedDB.stores.get('thumbs').size, list.length, 'evicted covers were not persisted');
  assertExactlyOnce(h.calls.captures, list); h.assertHealthy(api);
  const captured = h.calls.captures.length, callbacks = h.clock.executed;
  await h.clock.advance(60000);
  assert.equal(h.clock.executed, callbacks, 'completed queue kept scheduling callbacks');
  // Explicit idle-fill requests and viewport repaint must also settle after LRU
  // eviction. Completed keys must not become perpetual pump jobs.
  for (let i = 0; i < 3; i++) {
    api.renderWindow({ fill: true }); api.renderWindow();
    await h.clock.idle('completed eviction refill ' + i, 30000);
  }
  assert.equal(h.calls.captures.length, captured);
  assert.equal(api.stats.completedKeys, list.length);
  assert.equal(h.scroll.scrollTop, 0); h.assertHealthy(api);
  const result = `${list.length} completed, capacity ${capacity}, ${api.stats.evictions} evictions; ` +
    '60s idle has 0 callbacks; 3 refills add 0 captures';
  api.clear(); await h.clock.idle('eviction cleanup'); assert.equal(h.urls.size, 0);
  return result;
}

async function blankFirstFrame() {
  const h = harness({ blankCapture: (entry, attempt) => entry.id === 'entry-0' && attempt === 1 });
  const api = h.create(), list = nodes(5);
  api.refresh(list, true);
  await h.clock.idle('first empty frame retry');
  assert.equal(h.calls.captures.filter(id => id === 'entry-0').length, 2);
  assert.equal(h.calls.loads.filter(id => id === 'entry-0').length, 1, 'retry reloaded instead of finishing the same model');
  assert.equal(api.stats.generated, 5);
  assert.equal(api.stats.completedKeys, 5);
  const stored = h.indexedDB.stores.get('thumbs').get('entry-0');
  assert.equal(await stored.text(), 'thumbnail:entry-0', 'blank first frame was saved');
  assert.equal(h.indexedDB.writes.filter(write => write.name === 'thumbs').length, 5);
  h.assertHealthy(api);
  api.clear(); await h.clock.idle('first-frame retry cleanup');
  assert.equal(h.urls.size, 0);
  return 'first frame rejected; same model captured again; only 5 nonblank covers persisted';
}

async function legacyBlankCache() {
  const h = harness(), api = h.create(), list = nodes(5);
  await h.clock.idle('open test cache');
  const thumbs = h.indexedDB.stores.get('thumbs'), meta = h.indexedDB.stores.get('meta');
  for (const node of list) thumbs.set(node.entry.id, new Blob([node.entry.id === 'entry-0' ? 'blank' : 'thumbnail:' + node.entry.id]));
  meta.set('index', { items: Object.fromEntries([...thumbs].map(([key, blob]) => [key, { size: blob.size, touched: 0 }])), bytes: [...thumbs.values()].reduce((n, b) => n + b.size, 0) });
  api.refresh(list, true);
  await h.clock.idle('legacy blank cache rebuild');
  assert.deepEqual(h.calls.loads, ['entry-0'], 'valid cached siblings should not be regenerated');
  assert.deepEqual(h.calls.captures, ['entry-0']);
  assert.equal(api.stats.generated, 1);
  assert.equal(await thumbs.get('entry-0').text(), 'thumbnail:entry-0');
  assert.equal(thumbs.size, 5);
  h.assertHealthy(api);
  api.clear(); await h.clock.idle('legacy blank cache cleanup');
  assert.equal(h.urls.size, 0);
  return 'only background-only model_0 invalidated/rebuilt; four valid cached siblings preserved';
}

async function concurrentLegacyRepair() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ decodeGate: text => text === 'blank' ? gate : undefined });
  const api = h.create(), list = nodes(1);
  await h.clock.idle('open concurrent cache');
  h.indexedDB.stores.get('thumbs').set('entry-0', new Blob(['blank']));
  api.refresh(list, true);
  await h.clock.until(() => h.decodes.length === 1, 'reach delayed legacy validation');
  await h.clock.advance(1000);
  assert.equal(h.decodes.length, 1, 'recall and pump must share the pending blank-image decode');
  assert.equal(h.calls.loads.length, 0, 'regeneration cannot outrun validation of the same legacy cache');
  release();
  await h.clock.idle('complete shared legacy repair');
  assert.equal(h.calls.captures.length, 1);
  assert.equal(await h.indexedDB.stores.get('thumbs').get('entry-0').text(), 'thumbnail:entry-0');
  await h.clock.advance(60000);
  assert.equal(await h.indexedDB.stores.get('thumbs').get('entry-0').text(), 'thumbnail:entry-0', 'delayed validation deleted repaired cache');
  h.assertHealthy(api);
  api.clear(); await h.clock.idle('concurrent repair cleanup');
  assert.equal(h.urls.size, 0);
  return 'one shared delayed decode; repaired image remains persisted after all readers finish';
}

async function permanentlyBlankFrame() {
  const h = harness({ blankCapture: entry => entry.id === 'entry-0' });
  const api = h.create(), list = nodes(2);
  api.refresh(list, true);
  await h.clock.idle('bounded empty-frame failure');
  assert.equal(h.calls.captures.filter(id => id === 'entry-0').length, 3, 'empty-frame retries must be bounded');
  assert.equal(api.stats.generated, 1);
  assert.equal(api.stats.errors, 1);
  assert.equal(api.stats.completedKeys, 1);
  assert(!h.indexedDB.stores.get('thumbs').has('entry-0'), 'invalid image must never enter persistent cache');
  const card = h.layer.children.find(box => box.dataset.entryId === 'entry-0');
  assert(card.classList.contains('is-thumb-failed'), 'failed first model must show failure state');
  const open = card.children.find(child => child.className === 'overview-open');
  const placeholder = open.children.find(child => child.className === 'overview-placeholder');
  assert.match(placeholder.textContent, /生成失败.*尚未画出结构/);
  const retry = card.children.find(child => child.className === 'overview-retry');
  assert.equal(retry.hidden, false);
  const callbacks = h.clock.executed;
  await h.clock.advance(60000);
  assert.equal(h.clock.executed, callbacks, 'failed frame must not keep retrying in the background');
  assert.equal(h.calls.liveLoop, false);
  api.clear(); await h.clock.idle('bounded failure cleanup');
  assert.equal(h.urls.size, 0);
  return '3 attempts, explicit retry button, zero blank cache writes, then quiescent';
}

async function main() {
  let failures = 0;
  const tests = [
    ['virtual layout and scroll burst stay bounded', scrollBurstLayoutCache],
    ['offscreen jobs complete at a fixed viewport', offscreenCompletion],
    ['viewport covers run before background captures', visibleViewportPriority],
    ['lazy-load cache-key changes never abandon covers', lazyLoadKeyChangeCompletes],
    ['pause stops animation and generation; resume completes', pauseInFlight],
    ['memory and persisted restart avoid captures', cachedRestart],
    ['completed memory eviction settles without an infinite pump', evictionQuiescence],
    ['blank first frame retries the same model', blankFirstFrame],
    ['legacy blank model_0 cache repairs itself', legacyBlankCache],
    ['concurrent recall and pump share legacy validation', concurrentLegacyRepair],
    ['permanently blank model fails visibly without looping', permanentlyBlankFrame],
  ];
  for (const [name, test] of tests) {
    try { console.log('PASS ' + name + ' — ' + await test()); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`${tests.length - failures}/${tests.length} overview queue regression tests passed (actual ${sourcePath})`);
  if (failures) process.exitCode = 1;
}

module.exports = { harness, nodes, snapshot, Element, Clock, imagePixels };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
