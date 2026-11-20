import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixture } from './workspace-fixture.mjs';
function gate(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};}

test('local workspaces keep separate content and original scientific flags',async()=>{
  const f=workspaceFixture();await f.service.create();const one=f.api.currentWorkspaceTabId();
  f.rawS.entries=[{name:'one.pdb',data:'ONE'}];await f.service.create();const two=f.api.currentWorkspaceTabId();
  f.rawS.entries=[{name:'two.pdb',data:'TWO'}];
  await f.service.switchTo(one);assert.equal(f.rawS.entries[0].data,'ONE');
  await f.service.switchTo('original');assert.equal(f.rawS.entries[0].data,'KEEP');assert(f.rawS.entries[0].star);
  await f.service.switchTo(two);assert.equal(f.rawS.entries[0].data,'TWO');assert.equal(f.state.importCalls,0);
});
test('create refuses failed flush/write and rolls back a failed renderer',async()=>{
  for(const failure of ['failFlush','failWrite','failRender']){
    const f=workspaceFixture();f.state[failure]=true;
    assert.equal(await f.service.create(),false,failure);
    assert.equal(f.rawS.entries[0].data,'KEEP');assert.equal(f.tabs.activeId,'original');
    assert.equal(f.store.getKey(),'workspace:main:original');assert.equal(f.tabs.items.length,1);
    assert.equal(f.state.busy,false);assert.equal(f.rawS.restoringSession,false);
  }
});
test('failed final close retains the catalog and durable snapshot',async()=>{
  const f=workspaceFixture();f.state.failRender=true;
  assert.equal(await f.service.close('original'),false);
  assert.equal(f.tabs.activeId,'original');assert.equal(f.rawS.entries[0].data,'KEEP');
  assert.equal(f.disk.get('workspace:main:original').entries[0].data,'KEEP');
  assert.equal(await f.service.close('original'),true);assert.equal(f.tabs.items.length,0);assert.equal(f.rawS.entries.length,0);
});
test('failed switch restores the current view even after partial import',async()=>{
  const f=workspaceFixture();f.tabs.add({id:'remote',name:'Remote'},false);
  assert.equal(await f.service.switchTo('remote'),false);
  assert.equal(f.state.importCalls,1);assert.equal(f.rawS.entries[0].data,'KEEP');assert.equal(f.tabs.activeId,'original');
});
test('dirty changes during an awaited save prevent replacing the current workspace',async()=>{
  const f=workspaceFixture(),g=gate();f.state.saveGate=g.promise;
  const operation=f.service.create();await new Promise(r=>setImmediate(r));
  f.state.version++;f.rawS.entries[0].data='NEW EDIT';g.resolve();
  assert.equal(await operation,false);assert.equal(f.rawS.entries[0].data,'NEW EDIT');assert.equal(f.state.resetCount,0);
});
test('one service lock covers non-UI callers as well as tab clicks',async()=>{
  const f=workspaceFixture(),g=gate();f.state.saveGate=g.promise;
  const first=f.service.create();await new Promise(r=>setImmediate(r));assert.equal(f.service.busy,true);
  assert.equal(await f.service.close('original'),false);assert.equal(await f.service.switchTo('original'),false);
  g.resolve();assert.equal(await first,true);assert.equal(f.service.busy,false);
});
test('window creation failure removes only transfer data and preserves the source',async()=>{
  const f=workspaceFixture();f.state.failWindow=true;
  assert.equal(await f.service.detach('original'),false);assert.equal(f.tabs.activeId,'original');
  assert.equal(f.rawS.entries[0].data,'KEEP');assert.deepEqual([...f.disk.keys()],['workspace:main:original']);
});
test('acknowledged child retains its snapshot when the parent cannot return to start',async()=>{
  const f=workspaceFixture();f.state.onWindowOpen=()=>{f.state.failRender=true};
  assert.equal(await f.service.detach('original'),false);assert.equal(f.native.length,1);
  assert.equal(f.tabs.activeId,'original');assert.equal(f.rawS.entries[0].data,'KEEP');
  assert(f.disk.has('workspace:w_1:original'));assert.match(f.messages[0],/独立窗口已经打开/);
});
test('successful detach transfers only the requested workspace',async()=>{
  const f=workspaceFixture();await f.service.create();const id=f.api.currentWorkspaceTabId();
  f.rawS.entries=[{name:'local.pdb',data:'LOCAL'}];
  assert.equal(await f.service.detach(id),true);assert.equal(f.tabs.activeId,'original');assert.equal(f.rawS.entries[0].data,'KEEP');
  assert.equal(f.native[0].snapshot.entries[0].data,'LOCAL');assert.equal(f.native[0].tabs[0].id,id);
});

test('slow snapshot reads cannot replace edits made while switching',async()=>{
  const f=workspaceFixture();await f.service.create();const second=f.api.currentWorkspaceTabId();
  f.rawS.entries=[{name:'latest.pdb',data:'BEFORE'}];
  const g=gate();f.state.loadGate=g.promise;
  const switching=f.service.switchTo('original');await new Promise(r=>setImmediate(r));
  f.rawS.entries[0].data='EDIT DURING READ';f.state.version++;g.resolve();
  assert.equal(await switching,false);assert.equal(f.tabs.activeId,second);
  assert.equal(f.rawS.entries[0].data,'EDIT DURING READ');assert.equal(f.store.getKey(),'workspace:main:'+second);
  f.state.loadGate=null;assert.equal(await f.service.switchTo('original'),true);
  await f.service.switchTo(second);assert.equal(f.rawS.entries[0].data,'EDIT DURING READ');
});

test('an acknowledged child never discards newer unsaved parent edits',async()=>{
  const f=workspaceFixture();f.state.onWindowOpen=()=>{f.rawS.entries[0].data='EDIT AFTER TRANSFER';f.state.version++};
  assert.equal(await f.service.detach('original'),false);
  assert.equal(f.native[0].snapshot.entries[0].data,'KEEP');
  assert.equal(f.rawS.entries[0].data,'EDIT AFTER TRANSFER');assert.equal(f.tabs.activeId,'original');
  assert.equal(f.disk.get('workspace:w_1:original').entries[0].data,'KEEP');
});

test('read failures, unavailable native windows and import locks leave the source intact',async()=>{
  const f=workspaceFixture();await f.service.create();const second=f.api.currentWorkspaceTabId();
  f.rawS.entries=[{name:'second.pdb',data:'SECOND'}];f.state.failLoad=true;
  assert.equal(await f.service.switchTo('original'),false);assert.equal(f.rawS.entries[0].data,'SECOND');
  assert.equal(await f.service.detach(second),false);assert.equal(f.tabs.items.length,2);
  f.state.failLoad=false;f.state.nativeAvailable=false;
  assert.equal(await f.service.detach(second),false);assert.equal(f.native.length,0);
  f.state.blocked=true;
  for(const action of [()=>f.service.create(),()=>f.service.close(second),()=>f.service.switchTo('original'),()=>f.service.detach(second)])assert.equal(await action(),false);
  assert.equal(f.rawS.entries[0].data,'SECOND');assert.equal(f.tabs.activeId,second);assert.equal(f.service.busy,false);
});

test('seeded operation sequences retain each workspace payload through failures and transfers',async()=>{
  const clone=value=>JSON.parse(JSON.stringify(value));
  for(const seed of [13,29,113,65537]) {
    const f=workspaceFixture(),expected=new Map([['original',clone(f.rawS.entries)]]);
    let random=seed;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random};
    for(let i=0;i<160;i++) {
      const ids=[...expected.keys()],choice=next()%6,id=ids[next()%Math.max(1,ids.length)];
      if(!ids.length||choice===0&&ids.length<7) {
        assert.equal(await f.service.create(),true);expected.set(f.api.currentWorkspaceTabId(),[]);
      } else if(choice===1) {
        const current=f.api.currentWorkspaceTabId();
        f.rawS.entries=[{name:`synthetic-${seed}-${i}.pdb`,data:`payload-${seed}-${i}`,star:!!(i%2),note:`note ${i}`}];
        f.state.version++;expected.set(current,clone(f.rawS.entries));
      } else if(choice===2) {
        assert.equal(await f.service.switchTo(id),true);
      } else if(choice===3) {
        assert.equal(await f.service.close(id),true);expected.delete(id);
      } else if(choice===4) {
        assert.equal(await f.service.detach(id),true);
        assert.deepEqual(f.native.at(-1).snapshot.entries,expected.get(id));expected.delete(id);
      } else {
        const before=clone(f.rawS.entries),active=f.tabs.activeId;
        f.state.failRender=true;assert.equal(await f.service.create(),false);
        assert.equal(f.tabs.activeId,active);assert.deepEqual(f.rawS.entries,before);
      }
      assert.deepEqual(new Set(f.tabs.items.map(t=>t.id)),new Set(expected.keys()),`catalog seed ${seed} operation ${i}`);
      const active=f.api.currentWorkspaceTabId();
      assert.deepEqual(f.rawS.entries,active?expected.get(active):[],`payload seed ${seed} operation ${i}`);
      assert.equal(f.service.busy,false);assert.equal(f.rawS.restoringSession,false);
    }
  }
});
