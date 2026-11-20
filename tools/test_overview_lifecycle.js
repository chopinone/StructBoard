'use strict';

// Run: node tools/test_overview_lifecycle.js
// Shares only the deterministic DOM/clock doubles with the queue regressions.
// Every test executes the actual overview.js once per simulated window.
const assert = require('node:assert/strict');
const { harness, nodes, snapshot } = require('./test_overview_queue.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function entries(prefix, count = 1) {
  return nodes(count).map((node, index) => ({ ...node,
    entry: { ...node.entry, id: prefix + index } }));
}
function idleHealthy(h, ...panes) {
  for (const pane of panes) h.assertHealthy(pane.api);
  assert.equal(h.calls.liveViewers, 1);
  assert.equal(h.calls.creates, 1);
}

async function singleCreationExclusiveFIFO() {
  const creation = deferred();
  let encoding = false, finishEncoding, leaseDepth = 0, maxDepth = 0;
  const h = harness({ createGate: () => creation.promise,
    blobGate(entry, finish) {
      assert.equal(leaseDepth, 1, 'encoding escaped renderer lease');
      if (!finishEncoding) {
        encoding = true;
        finishEncoding = () => { encoding = false; finish(); };
      } else finish();
    } });
  const order = [];
  async function createViewer(host) {
    const viewer = await h.hooks.createViewer(host);
    const loop = viewer.plugin.animationLoop, start = loop.start, stop = loop.stop;
    loop.start = () => {
      assert.equal(leaseDepth, 0, 'two owners started the renderer together');
      leaseDepth++; maxDepth = Math.max(maxDepth, leaseDepth); start();
    };
    loop.stop = options => { assert.equal(leaseDepth, 1); leaseDepth--; stop(options); };
    return viewer;
  }
  const overrides = {
    createViewer,
    async clearViewer() { assert.equal(leaseDepth, 1); assert.equal(encoding, false, 'clear overlapped toBlob'); },
    async loadEntryInto(viewer, entry) {
      assert.equal(leaseDepth, 1); assert.equal(encoding, false);
      order.push(entry.id); return h.hooks.loadEntryInto(viewer, entry);
    },
    async prepare() { assert.equal(leaseDepth, 1); assert.equal(encoding, false); },
    async resetCamera() { assert.equal(leaseDepth, 1); assert.equal(encoding, false); },
  };
  const panes = ['a', 'b', 'c'].map(name => h.pane(name + '-', overrides));
  panes.forEach((pane, index) => pane.api.refresh(entries(String.fromCharCode(97 + index), 2), true));
  await h.clock.until(() => h.calls.creates === 1, 'reach shared pending creation');
  await h.clock.advance(1000);
  assert.equal(h.calls.creates, 1, 'concurrent owners created separate viewers');
  assert.equal(h.calls.loads.length, 0);
  creation.resolve();
  await h.clock.until(() => encoding, 'reach asynchronous toBlob');
  await h.clock.advance(1000);
  assert.deepEqual(order, ['a0'], 'next owner ran before the encoded frame settled');
  finishEncoding(); await h.clock.idle('finish all leased jobs');
  assert.deepEqual(order.slice(0, 3), ['a0', 'b0', 'c0'], 'waiting owners did not receive FIFO leases');
  assert.equal(order.length, 6); assert.equal(h.calls.captures.length, 6);
  assert.equal(maxDepth, 1); assert.equal(leaseDepth, 0); idleHealthy(h, ...panes);
  panes[0].api.destroy(); panes[1].api.destroy();
  assert.equal(h.calls.disposed, 0, 'retained third owner lost its viewer');
  panes[2].api.destroy(); await h.clock.idle('dispose final owner');
  assert.equal(h.calls.disposed, 1); assert.equal(h.calls.liveViewers, 0); assert.equal(h.urls.size, 0);
  return '3 owners, 1 pending creation, FIFO jobs and no overlap through delayed toBlob';
}

async function ownerCancellationIsolation() {
  const loadA = deferred(), loadB = deferred();
  const h = harness({ loadGate: entry => entry.id === 'a0' ? loadA.promise : loadB.promise });
  const a = h.pane('a-'), b = h.pane('b-');
  a.api.refresh(entries('a'), true); b.api.refresh(entries('b'), true);
  await h.clock.until(() => h.calls.loads.length === 1, 'reach owner A load');
  await h.clock.advance(1000);
  assert.equal(h.calls.liveLoop, true);
  const before = h.calls.stops;
  b.ids.get('btnOverviewPause').onclick();
  assert.equal(h.calls.stops, before, 'pausing a waiting owner stopped owner A');
  assert.equal(h.calls.liveLoop, true);
  b.ids.get('btnOverviewPause').onclick();
  await h.clock.advance(1000);
  a.api.leave();
  assert.equal(h.calls.liveLoop, false, 'leaving own active lease did not stop drawing synchronously');
  assert.equal(h.calls.disposed, 0, 'viewer disposed while an operation was suspended');
  loadA.resolve();
  await h.clock.until(() => h.calls.loads.includes('b0'), 'waiting B acquires lease');
  const duringB = h.calls.stops;
  a.api.leave(); a.api.clear(); a.api.destroy();
  assert.equal(h.calls.stops, duringB, 'leaving/destroying A stopped the B lease');
  assert.equal(h.calls.liveLoop, true); assert.equal(h.calls.disposed, 0);
  loadB.resolve(); await h.clock.idle('complete surviving owner');
  assert.deepEqual(h.calls.captures, ['b0']);
  assert.equal(a.api.stats.generated, 0); assert.equal(b.api.stats.generated, 1);
  h.assertHealthy(b.api);
  b.api.destroy(); await h.clock.idle('isolated cancellation cleanup');
  assert.equal(h.calls.disposed, 1); assert.equal(h.urls.size, 0);
  return 'waiting-owner pause and departed-owner leave/clear/destroy never stop the active peer';
}

async function destroyDuringCreation() {
  const creation = deferred();
  const h = harness({ createGate: () => creation.promise });
  const a = h.pane('a-'), b = h.pane('b-');
  a.api.refresh(entries('a'), true); b.api.refresh(entries('b'), true);
  await h.clock.until(() => h.calls.creates === 1, 'pending shared creation');
  await h.clock.advance(1000);
  a.api.destroy();
  assert.equal(a.api.viewer, null); assert.equal(h.calls.disposed, 0);
  creation.resolve(); await h.clock.idle('creation transferred to surviving owner');
  assert.deepEqual(h.calls.loads, ['b0']); assert.deepEqual(h.calls.captures, ['b0']);
  assert.equal(h.calls.creates, 1); assert.equal(h.calls.disposed, 0); h.assertHealthy(b.api);
  b.api.destroy(); await h.clock.idle('destroy creation survivor');
  assert.equal(h.calls.disposed, 1);

  const soloCreation = deferred(), solo = harness({ createGate: () => soloCreation.promise });
  const pane = solo.pane('solo-'); pane.api.refresh(entries('solo'), true);
  await solo.clock.until(() => solo.calls.creates === 1, 'sole owner creating');
  pane.api.destroy();
  assert.equal(solo.calls.disposed, 0, 'pending creation disposed prematurely');
  soloCreation.resolve(); await solo.clock.idle('orphaned creation settlement');
  assert.equal(solo.calls.disposed, 1); assert.equal(solo.calls.starts, 0);
  assert.equal(solo.calls.loads.length, 0); assert.equal(solo.urls.size, 0);
  assert.equal(pane.api.stats.busy, false); assert.equal(solo.indexedDB.closes, 1);
  return 'destroy during shared creation preserves the peer; orphaned creation disposes once after settlement';
}

async function cancelledEncodingHoldsLease() {
  let finish;
  const h = harness({ blobGate(entry, done) { if (entry.id === 'a0') finish = done; else done(); } });
  const a = h.pane('a-'), b = h.pane('b-');
  a.api.refresh(entries('a'), true); b.api.refresh(entries('b'), true);
  await h.clock.until(() => !!finish, 'suspend encoded capture');
  a.api.destroy();
  const writes = h.indexedDB.writes.length;
  assert.equal(h.calls.disposed, 0);
  await h.clock.advance(1000);
  assert.deepEqual(h.calls.loads, ['a0'], 'peer acquired renderer before cancelled encoding settled');
  finish(); await h.clock.idle('finish peer after cancelled encoding');
  assert.deepEqual(h.calls.loads, ['a0', 'b0']);
  assert.equal(a.api.stats.generated, 0); assert.equal(a.api.stats.cacheItems, 0);
  assert(!h.indexedDB.stores.get('thumbs').has('a0'), 'destroyed owner persisted its delayed capture');
  assert(h.indexedDB.writes.length >= writes);
  assert.equal(h.urls.size, 1, 'cancelled capture created a blob URL');
  h.assertHealthy(b.api); b.api.destroy(); await h.clock.idle('encoded cancellation cleanup');
  assert.equal(h.calls.disposed, 1); assert.equal(h.urls.size, 0);
  return 'cancelled toBlob retains its lease until callback; only the surviving peer publishes';
}

async function delayedDiskCannotPublish() {
  for (const action of ['leave', 'clear', 'destroy']) {
    const decode = deferred(), h = harness({ decodeGate: () => decode.promise });
    const pane = h.pane(action + '-');
    await h.clock.idle('open ' + action + ' cache');
    h.indexedDB.stores.get('thumbs').set('old0', new Blob(['thumbnail:old0']));
    pane.api.refresh(entries('old'), true);
    await h.clock.until(() => h.decodes.length === 1, 'suspend disk validation before ' + action);
    pane.api[action]();
    const writes = h.indexedDB.writes.length, urls = h.urls.size;
    assert.equal(pane.layer.children.length, 0);
    decode.resolve(); await h.clock.idle(action + ' delayed disk completion');
    assert.equal(h.urls.size, urls, action + ' recreated an object URL');
    assert.equal(h.indexedDB.writes.length, writes, action + ' wrote cache metadata after cancellation');
    assert.equal(pane.layer.children.length, 0, action + ' redrew cards after cancellation');
    assert.equal(pane.api.stats.cacheItems, 0);
    assert.equal(h.calls.creates, 0); assert.equal(h.calls.loads.length, 0);
    pane.api.destroy(); await h.clock.idle(action + ' cache final cleanup');
    assert.equal(h.indexedDB.closes, 1);
  }
  return 'delayed disk validation after leave/clear/destroy adds no URLs, writes, redraws, or viewers';
}

async function configSnapshot() {
  const load = deferred(), seen = [], captures = [];
  const h = harness({ loadGate: () => load.promise });
  let state = 'initial';
  const pane = h.pane('config-', {
    captureRenderConfig(entry) { const config = Object.freeze({ state, id: entry.id }); captures.push(config); return config; },
    key(entry, config) { seen.push(['key', config]); return entry.id + ':' + config.state; },
    color(_entry, config) { seen.push(['color', config]); return '#abc'; },
    async loadEntryInto(viewer, entry, config) { seen.push(['load', config]); return h.hooks.loadEntryInto(viewer, entry); },
    async prepare(_viewer, _entry, _ref, config) { seen.push(['prepare', config]); },
    async resetCamera(_viewer, _duration, config) { seen.push(['camera', config]); },
  });
  pane.api.refresh(entries('snapshot'), true);
  await h.clock.until(() => h.calls.loads.length === 1, 'load with captured config');
  state = 'changed'; load.resolve(); await h.clock.idle('complete captured config');
  assert.equal(captures.length, 1, 'same queued model captured mutable config more than once');
  for (const [name, config] of seen) assert.equal(config, captures[0], name + ' received a different config');
  for (const name of ['key', 'color', 'load', 'prepare', 'camera']) assert(seen.some(call => call[0] === name));
  assert(h.indexedDB.stores.get('thumbs').has('snapshot0:initial'));
  assert(!h.indexedDB.stores.get('thumbs').has('snapshot0:changed'));
  h.assertHealthy(pane.api); pane.api.destroy(); await h.clock.idle('config cleanup');
  return 'key/color/load/prepare/camera receive one identical config despite state changes mid-load';
}

async function sharedThumbnailKeyAndConfigIsolation() {
  const shared = harness();
  const sameKey = { captureRenderConfig: () => ({ variant: 'same' }),
    key: entry => 'complete-thumb:' + entry.id };
  const a = shared.pane('same-a-', sameKey), b = shared.pane('same-b-', sameKey);
  a.api.refresh(entries('shared'), true); b.api.refresh(entries('shared'), true);
  await shared.clock.idle('same full thumbnail key across panes');
  assert.deepEqual(shared.calls.loads, ['shared0'], 'identical cold key loaded more than once');
  assert.deepEqual(shared.calls.captures, ['shared0'], 'identical cold key captured more than once');
  assert(shared.indexedDB.stores.get('thumbs').has('complete-thumb:shared0'));
  await cleanupPanes(shared, a, b);

  const distinct = harness(), seenConfigs = [];
  const paneFor = (prefix, variant) => distinct.pane(prefix, {
    captureRenderConfig: () => ({ variant }),
    key(entry, config) { return 'complete-thumb:' + entry.id + ':' + config.variant; },
    async loadEntryInto(viewer, entry, config) {
      seenConfigs.push(config.variant);
      return distinct.hooks.loadEntryInto(viewer, entry);
    },
  });
  const left = paneFor('different-left-', 'left'), right = paneFor('different-right-', 'right');
  left.api.refresh(entries('same-id'), true); right.api.refresh(entries('same-id'), true);
  await distinct.clock.idle('different config produces distinct thumbnail keys');
  assert.equal(distinct.calls.loads.length, 2, 'different complete keys merged model loads');
  assert.equal(distinct.calls.captures.length, 2, 'different complete keys merged captures');
  assert.deepEqual(seenConfigs.sort(), ['left', 'right']);
  const thumbs = distinct.indexedDB.stores.get('thumbs');
  assert(thumbs.has('complete-thumb:same-id0:left'));
  assert(thumbs.has('complete-thumb:same-id0:right'));
  await cleanupPanes(distinct, left, right);
  return 'same cold full key loads/captures once across panes; distinct config keys load/capture separately';
}

async function cleanupPanes(h, ...panes) {
  panes.forEach(pane => pane.api.destroy());
  await h.clock.idle('pane cleanup');
  assert.equal(h.urls.size, 0, 'destroy leaked object URLs');
  assert.equal(h.indexedDB.closes, h.indexedDB.opens.length, 'destroy leaked IndexedDB connections');
}

async function peerWaitsForScrollToSettle() {
  const loadA = deferred();
  const h = harness({ loadGate: entry => entry.id === 'scroll-a0' ? loadA.promise : undefined });
  const a = h.pane('scroll-a-'), b = h.pane('scroll-b-');
  a.api.refresh(entries('scroll-a'), true); b.api.refresh(entries('scroll-b'), true);
  await h.clock.until(() => h.calls.loads.includes('scroll-a0'), 'pane A owns renderer');
  await h.clock.advance(30);
  assert.deepEqual(h.calls.loads, ['scroll-a0'], 'peer started while first renderer lease was held');

  const tops = [30, 60, 90];
  for (let i = 0; i < tops.length; i++) {
    a.scroll.scrollTop = tops[i];
    a.scroll.dispatch('scroll');
    if (i + 1 < tops.length) await h.clock.advance(100);
  }
  loadA.resolve();
  await h.clock.advance(16);
  assert.deepEqual(h.calls.captures, [], 'in-flight cover must yield before capture during scroll');
  assert.equal(h.calls.liveLoop, false, 'scroll left the old renderer drawing');
  assert(!h.calls.loads.includes('scroll-b0'), 'peer loaded a cover before scrolling settled');
  await h.clock.advance(162);
  assert(!h.calls.loads.includes('scroll-b0'), 'peer started before 180ms scroll quiet period elapsed');
  await h.clock.advance(2);
  await h.clock.until(() => h.calls.loads.includes('scroll-b0'), 'peer resumes after scroll settles');
  await h.clock.idle('peer cover completion');
  assert.deepEqual([...h.calls.captures].sort(), ['scroll-a0', 'scroll-b0']);
  h.assertHealthy(a.api); h.assertHealthy(b.api);
  await cleanupPanes(h, a, b);
  return 'peer cover waits through repeated scroll events and resumes after the 180ms quiet period';
}

async function resourceCleanup() {
  const h = harness(), a = h.pane('a-'), b = h.pane('b-');
  a.api.refresh(entries('a', 20), true); b.api.refresh(entries('b', 2), true);
  await h.clock.idle('prime cleanup fixture');
  assert.equal(h.observerInstances.length, 4);
  const baseWindow = h.windowEvents.listenerCount / 2;
  const baseDocument = h.documentEvents.listenerCount / 2;
  h.window.SB_ORG = { refOfNode: node => node.entry ? { id: node.entry.id } : null };
  assert.equal(a.api.enterPickPlace([a.api.nodes()[0]]), true);
  const minimap = a.root.querySelector('.ov-minimap');
  minimap.dispatch('pointerdown', { pointerId: 17, clientY: 160 });
  a.scroll.dispatch('scroll'); h.windowEvents.dispatch('resize');
  assert(h.clock.tasks.size > 0, 'fixture did not schedule minimap/window work');
  a.api.destroy(); a.api.destroy();
  assert.equal(h.windowEvents.listenerCount, baseWindow);
  assert.equal(h.documentEvents.listenerCount, baseDocument, 'pick keydown/visibility listener leaked');
  assert.equal(a.scroll.listenerCount, 0); assert.equal(minimap.listenerCount, 0);
  assert.equal(minimap.capturedPointer, null); assert.equal(minimap.parentElement, null);
  assert.equal(a.layer.children.length, 0);
  assert.equal(h.document.body.querySelectorAll('.ov-pick-banner').length, 0);
  assert.equal(h.document.body.querySelectorAll('.ov-drop-hint').length, 0);
  assert.equal(h.observerInstances.filter(observer => observer.disconnected).length, 2);
  assert.equal(h.indexedDB.closes, 1); assert.equal(h.calls.disposed, 0);
  for (const id of ['btnOverviewPause', 'btnOverviewLite', 'btnOverviewBack']) assert.equal(a.ids.get(id).onclick, null);
  const frozen = snapshot(a.api);
  for (const observer of h.observerInstances.slice(0, 2)) observer.callback([]);
  a.api.refresh(entries('late'), true); a.api.renderWindow({ fill: true });
  assert.equal(a.api.enterPickPlace(entries('late')), false);
  assert.equal(a.api.setSearch('late'), false); assert.equal(a.api.scrollToStep('late'), false);
  await h.clock.idle('ignore destroyed observer and API calls');
  assert.deepEqual(snapshot(a.api), frozen);
  h.assertHealthy(b.api); b.api.destroy(); await h.clock.idle('release all cleanup resources');
  assert.equal(h.windowEvents.listenerCount, 0); assert.equal(h.documentEvents.listenerCount, 0);
  assert.equal(h.observerInstances.filter(observer => observer.disconnected).length, 4);
  assert.equal(h.indexedDB.closes, 2); assert.equal(h.urls.size, 0); assert.equal(h.calls.disposed, 1);
  assert.equal(h.clock.tasks.size, 0);
  return 'idempotent destroy removes window/document/scroll/gesture handlers, both observers, timers, DOM, URLs and DB';
}

async function main() {
  const tests = [
    ['one shared creation and exclusive FIFO leases through encoding', singleCreationExclusiveFIFO],
    ['owner cancellation cannot stop another lease', ownerCancellationIsolation],
    ['destroy during pending shared or orphaned creation', destroyDuringCreation],
    ['cancelled capture holds lease and cannot publish late', cancelledEncodingHoldsLease],
    ['late disk/cache results are epoch and destruction guarded', delayedDiskCannotPublish],
    ['render task reuses one configuration snapshot', configSnapshot],
    ['shared thumbnail key is reused without merging distinct configs', sharedThumbnailKeyAndConfigIsolation],
    ['peer renderer work waits until scrolling settles', peerWaitsForScrollToSettle],
    ['destroy releases listeners, observers and runtime resources', resourceCleanup],
  ];
  let failures = 0;
  for (const [name, test] of tests) {
    try { console.log('PASS ' + name + ' — ' + await test()); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`${tests.length - failures}/${tests.length} overview lifecycle regression tests passed`);
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
