'use strict';
// Execute the app's actual tab transaction handlers. Fake disk failures must
// never publish an empty workspace or switch the existing store key.
const assert = require('node:assert/strict');
let fixture;
(async()=>{
  fixture = (await import('../frontend/tests/workspace-fixture.mjs')).workspaceFixture;
  const f=fixture();await f.api.addPipelineTab();const first=f.api.currentWorkspaceTabId();
  assert(first.startsWith('local:'));assert.equal(f.rawS.entries.length,0);assert.equal(f.tabs.items.length,2);
  assert.equal(f.state.importCalls,0);assert(f.disk.get(f.store.getKey()).localWorkspaceId);
  f.rawS.entries=[{name:'first.pdb',data:'FIRST'}];await f.api.addPipelineTab();const second=f.api.currentWorkspaceTabId();
  assert.notEqual(first,second);assert.equal(f.rawS.entries.length,0);
  f.rawS.entries=[{name:'second.pdb',data:'SECOND'}];
  await f.api.switchPipelineTab(first);assert.equal(f.rawS.entries[0].data,'FIRST');
  await f.api.switchPipelineTab('original');assert.equal(f.rawS.entries[0].data,'KEEP');assert(f.rawS.entries[0].star);
  await f.api.switchPipelineTab(second);assert.equal(f.rawS.entries[0].data,'SECOND');
  await f.api.closePipelineTab(second);assert.equal(f.tabs.get(second),null);assert.equal(f.rawS.entries[0].data,'FIRST');
  for(const failure of ['failFlush','failWrite','failRender']){
    const h=fixture();h.state[failure]=true;assert.equal(await h.api.addPipelineTab(),false);
    assert.equal(h.rawS.entries[0].data,'KEEP',failure);assert.equal(h.tabs.activeId,'original');
    assert.equal(h.store.getKey(),'workspace:main:original');assert.equal(h.tabs.items.length,1);
  }
  const h=fixture();await h.api.addPipelineTab();const blank=h.api.currentWorkspaceTabId();
  await h.api.switchPipelineTab('original');await h.api.switchPipelineTab(blank);
  assert.equal(h.rawS.entries.length,0);assert.equal(h.state.importCalls,0);
  console.log('blank tabs ok (unique snapshots, independent imports, empty restore, close, save/flush/render failure recovery)');
})().catch(error=>{console.error(error);process.exit(1)});
