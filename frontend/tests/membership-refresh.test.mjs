import test from 'node:test';
import assert from 'node:assert/strict';
import migration from '../../session_migration.js';
import {refreshMemberships} from '../application/membership-refresh.mjs';
import {create as workspaceState} from '../runtime/workspace-state.mjs';

const snapshot=()=>({entries:[{pipelineId:'fixture',stepKey:'fixture:a',name:'saved.pdb',sourceKey:'saved',star:true}],groups:[]});
const definition={id:'fixture',root:'X:/synthetic',steps:[{id:'a',title:'A'},{id:'b',title:'B'}]};
const response=data=>({ok:true,json:async()=>({ok:true,...data})});
const fetcher=async url=>url.includes('&raw=1')?response({pipeline:definition}):response({stepId:new URL(url,'http://local').searchParams.get('step'),files:[]});
test('membership refresh advances progress, backs up first and skips already current definitions',async()=>{
  const seen=[];let backedUp=false;
  const result=await refreshMemberships(snapshot(),{migration,fetch:fetcher,backup:async()=>{backedUp=true},progress:(n,text)=>seen.push([n,text])});
  assert(backedUp);assert.equal(result.report.steps.length,2);assert.equal(result.snapshot.entries[0].star,true);
  assert(seen[1][0]>seen[0][0]);assert.match(seen[1][1],/2 \/ 2/);
  const fresh=await refreshMemberships(result.snapshot,{migration,fetch:fetcher,backup:()=>{throw Error('unexpected backup')},progress:()=>{throw Error('unexpected progress')}});
  assert.equal(fresh.report,null);
});
test('deadline includes reading JSON; failure returns the untouched snapshot for later retry',async()=>{
  const original=snapshot(),failures=[];
  const result=await refreshMemberships(original,{migration,timeoutMs:10,fetch:async()=>({ok:true,json:()=>new Promise(()=>{})}),pending:(id,error)=>failures.push(error.message),backup:()=>{throw Error('no backup on failure')}});
  assert.equal(result.snapshot,original);assert.match(failures[0],/超时/);
});
test('user cancellation aborts an in-flight fetch without publishing or backing up partial data',async()=>{
  const controller=new AbortController();let signal,backups=0;
  const task=refreshMemberships(snapshot(),{migration,signal:controller.signal,fetch:async(url,opts)=>{
    if(url.includes('&raw=1'))return response({pipeline:definition});signal=opts.signal;return new Promise(()=>{});
  },backup:()=>backups++});
  await new Promise(r=>setImmediate(r));controller.abort();
  await assert.rejects(task,{name:'AbortError'});assert.equal(signal.aborted,true);assert.equal(backups,0);
});
test('workspace progress owner always closes on success, backup failure and cancellation',async()=>{
  const originals={window:globalThis.window,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  try{
    for(const mode of ['success','backupFailure','cancel']){
      let hidden=0,shown=0;const buttons={disabled:false};
      const ports={S:{},loadProgressRun:null,$:()=>buttons,setLoadProgress(){shown++;if(mode==='cancel')ports.loadProgressRun.controller.abort()},hideLoadProgress(){hidden++},toast(){}};
      const db={objectStoreNames:{contains:()=>true},close(){},transaction(){const tx={objectStore:()=>({get(){const r={result:mode==='backupFailure'?null:{entries:[]}};queueMicrotask(()=>r.onsuccess?.());return r},put(){queueMicrotask(()=>{tx.error=Error('Backup quota exceeded');tx.onabort?.()});}})};return tx}};
      globalThis.indexedDB={open(){const r={result:db};queueMicrotask(()=>r.onsuccess?.());return r}};
      globalThis.window={indexedDB:globalThis.indexedDB,SB_SESSION_STORE:{VERSION:2},SB_SESSION_MIGRATION:migration};
      globalThis.fetch=fetcher;
      const service=workspaceState(ports);
      const task=service.migrateSavedMemberships(snapshot());
      if(mode==='success')await task;else await assert.rejects(task);
      assert(shown>0);assert.equal(hidden,1,mode);assert.equal(ports.loadProgressRun,null,mode);assert.equal(buttons.disabled,false);
    }
  }finally{Object.assign(globalThis,originals);}
});
