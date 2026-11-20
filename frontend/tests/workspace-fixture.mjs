import tabsApi from '../../pipeline_tabs.js';
import { createWorkspaceService } from '../application/workspace-service.mjs';
const copy = value => JSON.parse(JSON.stringify(value));
export function workspaceFixture() {
  const values=new Map(), disk=new Map(), messages=[], native=[];
  const local={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const tabs=tabsApi.create({storage:local,key:'tabs:main'});
  tabs.add({id:'original',name:'Original'});
  const rawS={entries:[{name:'original.pdb',data:'KEEP',star:true}],groups:[],customSteps:[],
    organization:{},activePipelineId:'original',activePipelineName:'Original',localWorkspaceId:'',restoringSession:false};
  const state={failFlush:false,failWrite:false,failRender:false,resetCount:0,importCalls:0,version:0,
    blocked:false,nativeAvailable:true,failWindow:false,busy:false,finalized:0};
  let key='workspace:main:original',serial=0;
  const currentId=()=>rawS.activePipelineId||rawS.localWorkspaceId||'';
  const empty=id=>({entries:[],groups:[],customSteps:[],organization:{},activePipelineId:'',activePipelineName:'新标签页',localWorkspaceId:id});
  const store={getKey:()=>key,setKey:k=>{key=k},
    save:async(value,options)=>{if(state.saveGate)await state.saveGate;if(state.failWrite)throw Error('disk full');disk.set(options?.key||key,copy(value));},
    load:async k=>{if(state.loadGate)await state.loadGate;if(state.failLoad)throw Error('disk read failed');return copy(disk.get(k)||null)},
    clear:async k=>disk.delete(k)};
  disk.set(key,copy(rawS));
  const service=createWorkspaceService({catalog:tabs,storage:store,
    persistence:{flush:async()=>{if(state.failFlush)return false;disk.set(key,copy(rawS));return true},version:()=>state.version,clearLastSession:()=>values.delete('last')},
    workspace:{currentId,key:(id,w='main')=>'workspace:'+w+':'+(id||'local'),isLocal:id=>id.startsWith('local:')||id==='__local__',
      uuid:()=>String(++serial),blocked:()=>state.blocked,capture:()=>copy(rawS),empty,
      reset:async()=>{state.resetCount++;Object.assign(rawS,empty(''));},
      restore:async value=>{if(state.failRender){state.failRender=false;throw Error('render failed')}Object.assign(rawS,copy(value));},
      setRestoring:value=>rawS.restoringSession=value,setName:name=>rawS.activePipelineName=name,
      clearIdentity:()=>{rawS.localWorkspaceId='';rawS.activePipelineName=''},
      flushNotes(){},saveView(){},ensureCurrentTab(){},hydrateNotes(){},migrate:async value=>value,
      viewFor:()=>null,rekey:(value,id,w)=>{value.workspaceId=w},
      importPipeline:async()=>{state.importCalls++;Object.assign(rawS,empty(''));return false}},
    windows:{available:()=>state.nativeAvailable,catalog:w=>tabsApi.create({storage:local,key:'tabs:'+w}),
      open:async payload=>{if(state.failWindow)throw Error('native failed');native.push(payload);state.onWindowOpen?.();}},
    ui:{busy:value=>state.busy=value,refresh(){},status(){},error:message=>messages.push(message),finalize:()=>state.finalized++},
  });
  return {state,rawS,tabs,disk,store,messages,native,values,service,
    api:{addPipelineTab:service.create,switchPipelineTab:service.switchTo,closePipelineTab:service.close,currentWorkspaceTabId:currentId}};
}
