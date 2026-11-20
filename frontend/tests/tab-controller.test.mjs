import test from 'node:test';
import assert from 'node:assert/strict';
import tabsApi from '../../pipeline_tabs.js';
import { createTabController } from '../application/tab-controller.mjs';
import { writeBuildRecord, checkBuild } from '../../tools/check_frontend_build.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const catalog = () => { const c = tabsApi.create({ storage: { getItem() {}, setItem() {} } });
  c.add({id:'a',name:'A'}); c.add({id:'b',name:'B'}); return c; };
const gate = () => { let done; return { promise: new Promise(r=>done=r), done:()=>done() }; };

test('workspace transactions serialize, identical pending clicks share one result', async () => {
  const c=catalog(), g=gate(), order=[];
  const controller=createTabController(c,{onSelect:async id=>{order.push('start '+id);await g.promise;c.activate(id);order.push('end '+id);return true;},onClose:id=>{order.push('close '+id);c.remove(id);return true;}});
  const first=controller.dispatch('select','a'), duplicate=controller.dispatch('select','a'), close=controller.dispatch('close','b');
  assert.equal(first,duplicate);assert.deepEqual(order,['start a']);assert(controller.getSnapshot().busy);
  assert.equal(controller.getSnapshot().pending,1);
  g.done();assert.equal(await first,true);assert.equal(await close,true);
  assert.deepEqual(order,['start a','end a','close b']);assert.equal(c.activeId,'a');
  assert.equal(controller.getSnapshot().busy,false);
});
test('a failed save does not prevent the next operation; stale IDs are ignored', async () => {
  const c=catalog(), calls=[];
  const controller=createTabController(c,{onSelect:()=>{throw Error('save failed')},onClose:id=>{calls.push(id);return c.remove(id)}});
  await assert.rejects(controller.dispatch('select','a'),/save failed/);
  await controller.dispatch('close','b');assert.deepEqual(calls,['b']);
  assert.equal(await controller.dispatch('close','b'),false);
  assert.equal(await controller.dispatch('move','a','gone'),false);
});
test('disposing drops queued work without cancelling an in-flight durable save', async () => {
  const c=catalog(),g=gate();let added=0,seen=0;
  const controller=createTabController(c,{onSelect:async()=>{await g.promise;return true},onAdd:()=>added++});
  const unsubscribe=controller.subscribe(()=>seen++);
  const current=controller.dispatch('select','a'),queued=controller.dispatch('add');
  unsubscribe();controller.dispose();g.done();
  assert.equal(await current,true);assert.equal(await queued,false);assert.equal(added,0);assert.equal(seen,2);
  assert.equal(await controller.dispatch('add'),false);
});
test('fresh handlers are used and reordered catalogs retain stable identities', async () => {
  const c=catalog();let changed=0,selected='';
  const controller=createTabController(c,{});
  controller.updateHandlers({onSelect:id=>selected=id,onChange:()=>changed++});
  await controller.dispatch('select','a');await controller.dispatch('move','b','a');
  assert.equal(selected,'a');assert.equal(changed,1);assert.deepEqual(c.items.map(t=>t.id),['b','a']);
  await assert.rejects(controller.dispatch('typo'),/Unknown tab command/);
});

test('packaging rejects stale source or edited output even when the bundle exists', () => {
  const root=mkdtempSync(join(tmpdir(),'structboard-ui-build-'));
  try {
    for(const name of ['tools','frontend','ui'])mkdirSync(join(root,name));
    for(const name of ['package.json','package-lock.json','tools/check_frontend_build.mjs','frontend/main.mjs','ui/shell.js'])writeFileSync(join(root,name),'fixture');
    writeBuildRecord(root);checkBuild(root);
    writeFileSync(join(root,'frontend/main.mjs'),'changed source');
    assert.throws(()=>checkBuild(root),/stale/);
    writeBuildRecord(root);checkBuild(root);
    writeFileSync(join(root,'ui/shell.js'),'tampered bundle');
    assert.throws(()=>checkBuild(root),/stale/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
