'use strict';
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function method(name) {
  const hit = source.match(new RegExp('^  (?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  }', 'm'));
  assert(hit, 'Missing function ' + name); return hit[0];
}
function fixture() {
  const original = { id:'original', name:'original.pdb', data:'PRESERVE', stepKey:'pipe:design',star:true };
  const state = { entries:[original],groups:[],customSteps:[],organization:{},trashFolders:[],trashSteps:[],workspaceEpoch:1,activeGroupId:'all' };
  const calls=[],notices=[];const pane={index:0,overview:{findNode:()=>null},el:{}};
  const step={key:'pipe:design',title:'Design',tool:'demo',pipelineId:'pipe',order:1};
  const c=vm.createContext({rawS:state,S:state,panes:[pane],paneAt:()=>pane,stepKeyOfNode:n=>n.stepKey,
    hasWorkspaceContent:s=>s.entries.length>0, IO:{isStructureFile:n=>/\.pdb$/.test(n)},
    PANE_RUNTIME:{alive:()=>true},setActivePane(){},entryOrgKey:e=>e.id,
    orderedStepBuckets:()=>[step],panePipelineController:{busy:false},renderGroups(){},schedulePipelineViewSave(){},
    entryIsTrashed:e=>!!e.trashed,
    addPipelineTab:async()=>{calls.push('new');state.entries=[];state.workspaceEpoch++;return true},
    importFiles:async(files,name,opts)=>{calls.push({files:files.map(f=>f.name),name,opts});state.entries.push(...files.map((f,i)=>({id:'fresh-'+i,name:f.name,...opts})))},
    collectExternalFiles:async dt=>({files:dt.files,name:''}),
    toast:m=>notices.push(m),status(){},refreshSharedPaneViews(){},scheduleSessionSave(){},afterOrgChange(){},
    ORG:{moveKeys:(...args)=>calls.push(['move',...args]),createFolder:(...args)=>calls.push(['folder',...args])}
  });
  vm.runInContext('let pipelineTabBusy=false, localImportBusy=0;\n'+['importExternalDrop','externalDropTarget','recoverEmptyImportGroup'].map(method).join('\n')+
    '\nglobalThis.api={importExternalDrop,externalDropTarget,recoverEmptyImportGroup};',c);
  return {c,state,original,pane,step,calls,notices,api:c.api};
}
(async()=>{
  let f=fixture();await f.api.importExternalDrop({files:[{name:'new.pdb'}]},null);
  assert.equal(f.calls[0],'new');assert.equal(f.state.entries[0].name,'new.pdb');assert.equal(f.original.data,'PRESERVE');assert(f.original.star);
  f=fixture();f.state.entries=[];await f.api.importExternalDrop({files:[{name:'new.pdb'}]},null);assert(!f.calls.includes('new'));
  f=fixture();await f.api.importExternalDrop({files:[{name:'notes.txt'}]},null);assert.equal(f.calls.length,0);assert.equal(f.state.entries[0],f.original);
  f=fixture();await f.api.importExternalDrop({files:[{name:'new.pdb'}]},{stepKey:f.step.key,pane:f.pane});
  assert(!f.calls.includes('new'));assert.equal(f.calls[0].opts.group,false);assert.equal(f.calls[0].opts.stepKey,f.step.key);assert.equal(f.state.entries[0],f.original);
  f=fixture();await f.api.importExternalDrop({files:[{name:'new.pdb'}]},{stepKey:'missing'});assert.equal(f.calls.length,0);
  f=fixture();const autoFolder={kind:'folder',name:'Candidate',origin:'lineage',groupKey:'candidate-group',stepKey:f.step.key};
  await f.api.importExternalDrop({files:[{name:'new.pdb'}]},{stepKey:f.step.key,folder:autoFolder,pane:f.pane});
  const folder=f.calls.find(c=>Array.isArray(c)&&c[0]==='folder');assert.equal(folder[3].parentId,'lineage:candidate-group');assert.equal(folder[3].name,'外部导入');
  assert.equal(f.state.entries[1].lineage,undefined,'Do not assign scientific identity to an external file');
  f=fixture();f.state.organization[f.step.key]={folders:[{id:'user-folder'}]};
  await f.api.importExternalDrop({files:[{name:'new.pdb'}]},{stepKey:f.step.key,folder:{name:'User',origin:'user',orgId:'user-folder'},pane:f.pane});
  assert.equal(f.calls.find(c=>Array.isArray(c)&&c[0]==='move')[4],'user-folder');
  f=fixture();f.state.groups=[{id:'batch',entryIds:['gone']}];f.state.activeGroupId='batch';
  assert(f.api.recoverEmptyImportGroup());assert.equal(f.state.activeGroupId,'all');assert.equal(f.state.entries[0],f.original);
  f.state.groups=[{id:'step',entryIds:[],pipelineKey:f.step.key}];f.state.activeGroupId='step';assert.equal(f.api.recoverEmptyImportGroup(),false);
  f=fixture();const card={dataset:{entryId:'candidate'}};f.pane.overview.findNode=()=>autoFolder;
  const target=f.api.externalDropTarget({closest:sel=>sel==='.stage'?f.pane.el:sel.includes('.overview-card')?card:null});
  assert(target.label.includes('外部导入'));assert.equal(target.element,card);
  console.log('external drop ok (new tab, blank page, explicit step/folder, invalid target, unsupported file, legacy empty-group recovery)');
})().catch(error=>{console.error(error);process.exit(1)});
