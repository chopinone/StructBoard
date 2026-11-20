export function startPipeline() {
// CANVAS_RUNTIME_BEGIN

'use strict';
const $ = id => document.getElementById(id);
const el=(t,c,x)=>{const n=document.createElement(t);if(c)n.className=c;if(x!==undefined)n.textContent=x;return n;};

const NOTE_EMPTY='（还没写）在画布上这个节点下方的便签里直接写筛选条件 / 运行命令，这里会同步显示。';
const COLORS={r0:'#6b7f3a',r1:'#2f6fad',r2:'#9a63b8',final:'#d19a2c',real:'#2b6e9c',manual:'#5574bd'};
const DEMO_NODES=[
 {id:'n0',x:40,y:34,r:'r0',tag:'Demo',title:'人工合成双链模板',state:'done',
  desc:'由螺旋公式生成的教学结构，不对应任何真实靶点',cnt:'1 个合成模板',
  note:'全部坐标与数值为人工合成，仅用于学习软件操作。',path:'演示数据 / template',
  files:[['synthetic_template.pdb','合成结构']],kv:[['A 链','42 aa'],['B 链','24 aa']]},
 {id:'n1',x:320,y:34,r:'r1',tag:'Demo',title:'6 个演示候选',state:'done',
  desc:'平移合成 B 链，观察候选间结构差异',cnt:'6 个候选',
  note:'没有运行任何科研生成模型。可练习文件夹、旋转和叠加。',path:'演示数据 / design',
  files:[['Aurora_001…006.pdb','6 个示意结构']],kv:[['候选数','6']]},
 {id:'n2',x:600,y:34,r:'r1',tag:'Demo',title:'三模型教学复核',state:'done',
  desc:'每个候选 3 个模型，分数为人为设定的教学数值',cnt:'18 个示意模型',
  note:'教学规则：demo_score ≥ 0.78，同一候选至少 2/3 个模型达标。数值没有科研意义。',
  path:'演示数据 / review',files:[['demo-scores.csv','教学分数']],kv:[['模型数','18']]},
 {id:'n3',x:880,y:34,r:'final',tag:'Demo',title:'2 个演示入选候选',state:'done',
  desc:'Aurora_001 和 Aurora_002 满足教学规则',cnt:'2 个候选 / 6 个模型',
  note:'保留全部模型供并排检阅。这里的入选不代表实验结论。',path:'演示数据 / shortlist',
  files:[['Aurora_001 / Aurora_002','6 个示意模型']],kv:[['入选候选','2']]},
];
const DEMO_EDGES=[['n0','n1'],['n1','n2'],['n2','n3']];
const CARD_W=260,CARD_H=166;
let mapEditor=null;
const S={sel:'n3',scale:.85,tx:16,ty:16,nodes:DEMO_NODES.map(n=>({...n})),edges:DEMO_EDGES.map(e=>e.slice()),mode:'demo',realData:null,
  apiData:null,apiPipelines:[],apiId:null,apiOffline:false,apiMsg:''};

// 本地服务提供的管线 API。file:// 打开时同源取不到，退回 file:// 下不可用 → 降级到导入批次。
function apiBase(){
  if(location.protocol==='file:') return null;
  return location.origin;
}
async function apiGet(path){
  const base=apiBase();if(!base)return null;
  try{
    const r=await fetch(base+path,{cache:'no-store'});
    if(!r.ok)return null;
    const j=await r.json();
    return (j&&j.ok)?j:null;
  }catch(e){return null}
}
async function apiPost(path,body){
  const base=apiBase();if(!base)return null;
  try{
    const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store'});
    if(!r.ok)return null;
    const j=await r.json();
    return (j&&j.ok)?j:null;
  }catch(e){return null}
}
// Raw renderer state remains private; external canvas tools use SB_CANVAS_OPERATIONS.

// 带错误详情的 POST：导入时用户必须看到「为什么被拒」
async function apiPostFull(path,body){
  const base=apiBase();
  if(!base)return {ok:false,error:'当前是 file:// 打开，无法访问本地服务。请双击 start-server.bat 起服务后再用。'};
  try{
    const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store'});
    let j=null;
    try{j=await r.json()}catch(e){}
    if(j&&j.ok)return j;
    return {ok:false,error:(j&&j.error)?j.error:('请求失败 HTTP '+r.status),
            status:r.status,data:j};
  }catch(e){
    return {ok:false,error:'请求出错: '+(e&&e.message?e.message:e)};
  }
}

function byId(id){return S.nodes.find(n=>n.id===id);}
function color(n){return COLORS[n.r]||'#888';}

/* 节点工具标识：优先 JSON step.tool；否则从标题/命令里识别常见工具名。 */
const TOOL_RE=/(rfd\s?\d+|rf\s?\d+|boltz[\w.-]*|mpnn|alphafold\s?\d|af3|rosetta|pymol|python|py脚本|relax)/i;
function toolOf(n){
  if(n.tool)return String(n.tool).slice(0,18);
  const m=((n.title||'')+' '+(n.cmd||'')).match(TOOL_RE);
  if(!m)return '';
  let t=m[0].replace(/\s+/g,'');
  if(/^af3$/i.test(t))t='AF3';else if(/^mpnn$/i.test(t))t='MPNN';
  else if(/^python$/i.test(t)||/^py脚本$/i.test(t))t='py';
  else t=t.toUpperCase().startsWith('RF')?t.toUpperCase():t;
  return t;
}

const CANVAS_KEY='structboard.pipelineCanvas.v1';
let canvasController=null,canvasApplying=false,canvasViewTimer=0;
let canvasBaseNodes=DEMO_NODES.map(n=>JSON.parse(JSON.stringify(n))),canvasBaseEdges=DEMO_EDGES.map(e=>e.slice());
let canvasPrivateNodes=new Map(canvasBaseNodes.map(n=>[n.id,n]));
function canvasKey(){
 if(S.mode==='api')return 'api:'+S.apiId;
 if(S.mode==='demo')return 'demo:aurora-v1';
 const groups=((S.realData||{}).groups||[]).map(g=>[g.name,(g.files||[]).map(f=>[f.name,f.size]).sort()]);
 return 'real:'+JSON.stringify(groups);
}
function safeCanvasId(){
 if(S.mode==='demo')return 'demo:aurora-v1';
 if(S.mode==='api')return 'api:'+(/^[A-Za-z0-9_-]{1,64}$/.test(S.apiId||'')?S.apiId:window.SB_CANVAS_DOCUMENT.hash(String(S.apiId||'')));
 return 'real:'+window.SB_CANVAS_DOCUMENT.hash(canvasKey());
}
function readCanvas(strict){
 try{const all=JSON.parse(localStorage.getItem(CANVAS_KEY)||'{}');if(all&&typeof all==='object'&&!Array.isArray(all))return all;throw Error('Invalid canvas storage');}
 catch(error){if(strict)throw error;return {};}
}
function canvasState(){const all=readCanvas();return all[canvasKey()]||{nodes:[],edges:[],notes:{},titles:{}};}
function persistCanvasOverlay(key,state){
 const all=readCanvas(true);Object.defineProperty(all,key,{value:state,enumerable:true,writable:true,configurable:true});
 localStorage.setItem(CANVAS_KEY,JSON.stringify(all));
}
function writeCanvas(state){
 try{persistCanvasOverlay(canvasKey(),state);return true;}
 catch(_){toast('浏览器本地空间不可写，本次编辑暂未保存');return false;}
}
function saveCanvas(){if(canvasController)return canvasController.save();return false;}
function rememberCanvasBase(){
 canvasBaseNodes=S.nodes.filter(n=>!n.manual).map(n=>JSON.parse(JSON.stringify(n)));canvasBaseEdges=S.edges.map(e=>e.slice());
 canvasPrivateNodes=new Map(canvasBaseNodes.map(n=>[n.id,n]));
 if(S.mode==='api'){
  const recovery=(canvasState().document||{}).noteRecovery||{};
  for(const n of canvasBaseNodes){
   const item=recovery[n.id];
   if(!n.apiStepId||!item||item.stepId!==n.apiStepId||typeof item.after!=='string'||item.after.length>32000||canvasNotesSync.pending(S.apiId,n.apiStepId))continue;
   // Requeue only when the backend still contains exactly the pre-edit value.
   // A newer backend edit is authoritative and leaves this recovery record intact.
   if(n.note===item.before&&n.note!==item.after)scheduleNoteSave(n.apiStepId,item.after);
  }
 }
}
function canvasNodeValue(n,includePending){
 return {id:n.id,title:n.title||'',tool:n.tool||'',desc:n.desc||'',note:includePending&&n.apiStepId&&S.mode==='api'&&canvasNotesSync.pending(S.apiId,n.apiStepId)?canvasNotesSync.applyPending(S.apiId,{})[n.apiStepId]:n.note||'',x:n.x,y:n.y,manual:!!n.manual,
  ...(n.apiStepId?{binding:{stepId:n.apiStepId}}:n.canvasBinding?{binding:n.canvasBinding}:{})};
}
function canvasContext(){
 return {key:canvasKey(),canvasId:safeCanvasId(),nodes:S.nodes.map(n=>canvasNodeValue(n,false)),baseNodes:canvasBaseNodes.map(n=>canvasNodeValue(n,true)),
  edges:S.edges.map(e=>e.slice()),baseEdges:canvasBaseEdges.map(e=>e.slice()),selection:byId(S.sel)?[S.sel]:[],
  viewport:{scale:S.scale,tx:S.tx,ty:S.ty},externalNoteIds:canvasBaseNodes.filter(n=>n.apiStepId).map(n=>n.id),
  privateRoots:[S.apiData&&S.apiData.root].filter(Boolean)};
}
function publishCanvasSnapshot(snapshot){
 canvasApplying=true;
 try{
  const current=new Map(S.nodes.map(n=>[n.id,n]));
  S.nodes=snapshot.nodes.map(n=>{
   const old=current.get(n.id)||canvasPrivateNodes.get(n.id)||{r:'manual',tag:'手工',state:'wait',cnt:'未关联文件',date:dateLabel(Date.now()),path:'手工节点 · 保存在当前浏览器',files:[],kv:[]};
   Object.assign(old,{id:n.id,title:n.title,tool:n.tool,desc:n.desc,note:n.note,x:n.x,y:n.y,manual:n.manual});
   if(n.manual&&n.binding)old.canvasBinding={...n.binding};
   return old;
  });
  S.edges=snapshot.edges.map(e=>e.slice());S.sel=snapshot.selection[0]||S.nodes[0]?.id||null;
  S.scale=snapshot.viewport.scale;S.tx=snapshot.viewport.tx;S.ty=snapshot.viewport.ty;
  if(!byId(S.openStickyNodeId))S.openStickyNodeId=null;
 }finally{canvasApplying=false;}
}
function canvasOperation(operations,render){
 if(!canvasController)return null;
 const outcome=canvasController.applyLocal(operations);
 if(!outcome.ok){toast(outcome.error.message);return outcome;}
 if(operations.some(op=>!['viewport.set','selection.set'].includes(op.op)))mapEditor?.graphCommitted();
 if(render!==false)renderCanvasChange();return outcome;
}
function canvasObserveView(){
 if(!canvasController||canvasApplying)return;
 canvasController.observeLocal(false);
 clearTimeout(canvasViewTimer);canvasViewTimer=setTimeout(()=>{canvasViewTimer=0;canvasController.save();},180);
}
function startCanvasOperations(){
 canvasController=window.SB_CANVAS_BRIDGE.create({readContext:canvasContext,loadOverlay:key=>readCanvas(true)[key]||{},saveOverlay:persistCanvasOverlay,
  publish:publishCanvasSnapshot,onStorageError:()=>toast('浏览器本地空间不可写，本次编辑暂未保存'),
  validateCommit:next=>{if(S.openRequest&&!next.nodes.some(n=>n.id===S.openRequest.nodeId))throw Object.assign(Error('该节点正在加载结构，请稍候再删除'),{code:'NODE_BUSY'});},
  notes(changes,enqueue){
   const fields=changes.filter(c=>{const n=byId(c.id);return S.mode==='api'&&n&&n.apiStepId;});
   let durable=true,ack=fields.length?true:null;
   for(const c of fields){const n=byId(c.id);if(enqueue&&!scheduleNoteSave(n.apiStepId,c.text))durable=false;
    const status=canvasNotesSync.status(S.apiId,n.apiStepId);if(status.localError)durable=false;
    if(canvasNotesSync.pending(S.apiId,n.apiStepId))ack=false;}
   return {backendAck:ack,notesLocalDurable:durable};
  }});
 canvasController.restore();
 const api=canvasController.api;
 window.SB_CANVAS_OPERATIONS=Object.freeze({getSnapshot:api.getSnapshot,prepareChange:api.prepareChange,prepareUndo:api.prepareUndo,
  applyChange(args,context){const r=api.applyChange(args,context);if(r.ok){renderCanvasChange();applyTransform();}return r;},
  undoChange(args,context){const r=api.undoChange(args,context);if(r.ok){renderCanvasChange();applyTransform();}return r;}});
 window.SB_CANVAS_BRIDGE.installPostMessage(window,window.SB_CANVAS_OPERATIONS);
}

/* 左右面板折叠：收起后留一条玻璃导轨，状态存 localStorage。 */
const PANELS_KEY='structboard.pipelinePanels.v1';
function readPanels(){try{return JSON.parse(localStorage.getItem(PANELS_KEY)||'{}')||{}}catch(e){return{}}}
function applyPanels(){
 const p=readPanels(),L=p.left!==false,R=p.right!==false;
 document.querySelector('.main').classList.toggle('side-hidden',L);
 $('railSide').hidden=!L;
 document.querySelector('.canvas-area').classList.toggle('drawer-hidden',R);
 $('railDrawer').hidden=!R;
}
function setPanel(side,collapsed){
 const p=readPanels();p[side]=!!collapsed;
 try{localStorage.setItem(PANELS_KEY,JSON.stringify(p))}catch(e){}
 applyPanels();
 setTimeout(()=>mapEditor?.transform(),200);
}
function restoreCanvas(){
 if(typeof canvasController!=='undefined'&&canvasController){canvasController.restore();return;}
 const state=canvasState();
 const removed=new Set((state.deleted||[]).map(item=>item.node.id));
 S.nodes=S.nodes.filter(n=>!removed.has(n.id));
 S.edges=S.edges.filter(e=>!removed.has(e[0])&&!removed.has(e[1]));
 for(const n of state.nodes||[])if(n&&n.manual&&typeof n.id==='string'&&!removed.has(n.id)&&!byId(n.id))S.nodes.push({...n});
 const ids=new Set(S.nodes.map(n=>n.id));
 for(const e of state.edges||[])if(Array.isArray(e)&&ids.has(e[0])&&ids.has(e[1])&&!S.edges.some(x=>x[0]===e[0]&&x[1]===e[1]))S.edges.push(e.slice());
 for(const n of S.nodes){
  if(!n.apiStepId&&Object.prototype.hasOwnProperty.call(state.notes||{},n.id))n.note=state.notes[n.id];
  if(n.apiStepId&&canvasNotesSync.pending(S.apiId,n.apiStepId))n.note=canvasNotesSync.applyPending(S.apiId,{})[n.apiStepId];
  if(Object.prototype.hasOwnProperty.call(state.titles||{},n.id))n.title=state.titles[n.id];
 }
}
function canDeleteNode(n){return !!n&&n.id!=='empty'&&n.id!=='api-empty';}
const TRASH_ICON='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M8 3h4M5 5l1 12h8l1-12M8 8v6m4-6v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderCanvasChange(){
 if(!byId(S.sel))S.sel=S.nodes[0]?.id||null;
 renderNodes();renderEdges();renderSide();renderDrawer();
 if(!S.nodes.length){S.tx=16;S.ty=16;applyTransform();}
}
function renderNodeSelection(){
 const selected=S.sel;
 for(const node of document.querySelectorAll('#nodes .node'))
  node.classList.toggle('sel',node.dataset.nodeId===selected);
 for(const item of document.querySelectorAll('#sideList .side-item'))
  item.classList.toggle('sel',item.dataset.nodeId===selected);
}
function deleteNode(id){
 const n=byId(id);if(!canDeleteNode(n))return;
 if(S.openRequest?.nodeId===id){toast('该节点正在加载结构，请稍候再删除');return;}
 const title=n.title,result=canvasOperation([{op:'node.delete',id}]);
 if(result&&result.ok)toast('已删除「'+title+'」节点，磁盘文件保留',undoDeleteNode);
}
function undoDeleteNode(){
 if(!canvasController)return;
 const result=canvasController.undoLocal();
 if(!result.ok){toast(result.error.message);return;}
 renderCanvasChange();$('drawer').hidden=false;toast('已恢复删除的节点');
}
function setNodeNote(n,text){
 if(n.note===text)return;
 if(typeof canvasController!=='undefined'&&canvasController){
  const result=canvasOperation([{op:'note.set',id:n.id,text}],false);
  if(!result||!result.ok)return;
 }else{
  n.note=text;
  if(S.mode==='api'&&n.apiStepId)scheduleNoteSave(n.apiStepId,text);
  else{const state=canvasState();state.notes=state.notes||{};state.notes[n.id]=text;writeCanvas(state);saveCanvas();}
 }
 if(n.groupId&&window.parent!==window){
  if(S.realData){S.realData.notes=S.realData.notes||{};S.realData.notes[n.groupId]=text;}
  try{window.parent.postMessage({type:'pipelineNote',id:n.groupId,text},location.origin)}catch(_){}
 }
 if(S.sel===n.id){const dn=document.querySelector('.drawer .d-note');if(dn){dn.textContent=text||NOTE_EMPTY;dn.classList.toggle('is-empty',!text);}}
 paintCanvasNoteStatus();
}
let noteEditorState=null,noteEditorCloseTimer=null;
function openNoteEditor(nodeId,sourceTextarea){
 const n=byId(nodeId);if(!n)return;
 const mask=$('noteEditorMask'),area=$('noteEditorArea');
 clearTimeout(noteEditorCloseTimer);
 if(noteEditorState&&noteEditorState.nodeId===nodeId&&!mask.hidden){mask.setAttribute('aria-hidden','false');mask.classList.add('open');area.focus({preventScroll:true});return;}
 noteEditorState={nodeId,sourceTextarea:sourceTextarea||null,returnFocus:document.activeElement};
 $('noteEditorTitle').textContent=n.title+' · 便签';
 paintCanvasNoteStatus();
 area.value=n.note||'';mask.hidden=false;mask.setAttribute('aria-hidden','false');
 document.querySelector('.app').inert=true;
 void mask.offsetWidth;mask.classList.add('open');
 requestAnimationFrame(()=>{
  if(noteEditorState&&noteEditorState.nodeId===nodeId&&!mask.hidden){area.focus({preventScroll:true});area.setSelectionRange(0,0);area.scrollTop=0;}
 });
}
function closeNoteEditor(){
 const mask=$('noteEditorMask');if(mask.hidden)return;
 const state=noteEditorState,area=$('noteEditorArea');
 const n=state&&byId(state.nodeId);
 if(n&&area.value!==n.note)setNodeNote(n,area.value);
 if(state&&state.sourceTextarea&&state.sourceTextarea.isConnected)state.sourceTextarea.value=area.value;
 mask.classList.remove('open');
 clearTimeout(noteEditorCloseTimer);
 const delay=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:220;
 noteEditorCloseTimer=setTimeout(()=>{
  if(mask.classList.contains('open'))return;
  mask.hidden=true;mask.setAttribute('aria-hidden','true');
  document.querySelector('.app').inert=false;
  if(noteEditorState===state)noteEditorState=null;
  const target=state&&state.sourceTextarea&&state.sourceTextarea.isConnected
    ?state.sourceTextarea:(state&&state.returnFocus&&state.returnFocus.isConnected?state.returnFocus:null);
  if(target&&typeof target.focus==='function')target.focus({preventScroll:true});
 },delay);
}
function bindNoteEditor(){
 const mask=$('noteEditorMask'),area=$('noteEditorArea');
 area.oninput=()=>{
  if(!noteEditorState)return;
  const n=byId(noteEditorState.nodeId);if(!n)return;
  setNodeNote(n,area.value);
  if(noteEditorState.sourceTextarea&&noteEditorState.sourceTextarea.isConnected)
   noteEditorState.sourceTextarea.value=area.value;
  paintCanvasNoteStatus();
 };
 $('noteEditorClose').onclick=closeNoteEditor;
 $('noteEditorDone').onclick=closeNoteEditor;
 mask.onclick=e=>{if(e.target===mask)closeNoteEditor();};
 mask.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeNoteEditor();return;}
  if(e.key!=='Tab')return;
  const focusables=Array.from(mask.querySelectorAll('button,textarea')).filter(el=>!el.disabled);
  if(!focusables.length)return;
  const first=focusables[0],last=focusables[focusables.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
 });
}
function editNodeTitle(n,label){
 S.editingNodeId=n.id;renderNodes().then(()=>{const input=document.querySelector('[data-node-id="'+n.id+'"] .node-title-input');if(input){input.focus();input.select();}});
}
function createNode(){
 const parent=byId(S.sel);
 const id='manual_'+(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36));
 const y=S.nodes.length?Math.max(...S.nodes.map(n=>Number(n.y)||0))+310:34;
 const ops=[{op:'node.create',node:{id,x:40,y,title:'新建步骤',desc:'双击名称可修改\n在下方便签记录条件和命令',note:''}}];
 if(parent&&parent.id!=='empty'&&parent.id!=='api-empty')ops.push({op:'edge.connect',from:parent.id,to:id});
 const result=canvasOperation(ops);if(!result||!result.ok)return;
 const n=byId(id);select(id);focusNode(n);
 renderNodes().then(()=>{const title=document.querySelector('[data-node-id="'+id+'"] .c-title');if(title&&byId(id))editNodeTitle(byId(id),title);});
 toast('已添加步骤，输入名称后按 Enter');
}
function focusNote(){
 const n=byId(S.sel)||S.nodes[0];
 if(!n){createNode();return;}
 S.openStickyNodeId=n.id;
 if(S.sel!==n.id)select(n.id);
 renderNodes().then(()=>{const ta=document.querySelector('[data-node-id="'+n.id+'"] .sticky textarea');if(ta){ta.focus({preventScroll:true});ta.setSelectionRange(ta.value.length,ta.value.length);}});
 focusNode(n);
}

let nodeView=null;
function renderNodes(){
 if(!nodeView)nodeView=window.SB_UI.mountPipelineNodes($('nodes'));
 const rows=S.nodes.map((n,index)=>({id:n.id,index:index+1,x:n.x,y:n.y,color:color(n),selected:S.sel===n.id,tag:n.tag,title:n.title,tool:toolOf(n),desc:n.desc,count:n.cnt,date:n.date,
  stateClass:n.state==='done'?'done':n.state==='now'?'now':'wait',stateLabel:n.state==='done'?'完成':n.state==='now'?'当前':'待运行',deletable:canDeleteNode(n),editing:S.editingNodeId===n.id,hasNote:!!String(n.note||'').trim(),showSticky:S.openStickyNodeId===n.id,note:n.note||''}));
 const update=nodeView.update({model:{rows},handlers:{
  select(id){select(id);},
  inspect(id){select(id);setPanel('right',false);},
  open(id){const n=byId(id);if(!n)return;if(n.apiStepId&&window.parent!==window){const requestId=crypto.randomUUID();window.parent.postMessage({type:'pipelineOpenStep',id:S.apiId,stepId:n.apiStepId,requestId,stepIndex:S.nodes.indexOf(n),tool:n.tool||'',title:n.title},location.origin);}else {select(id);setPanel('right',false);}},
  remove:deleteNode,rename(id,label){const n=byId(id);if(n)editNodeTitle(n,label);},
  renameCommit(id,value){if(S.editingNodeId!==id)return;S.editingNodeId=null;if(value.trim())canvasOperation([{op:'node.update',id,props:{title:value.trim()}}],false);renderNodes();renderSide();renderDrawer();},
  renameCancel(id){if(S.editingNodeId!==id)return;S.editingNodeId=null;renderNodes();},
  noteOpen(id){S.openStickyNodeId=id;if(S.sel!==id)select(id);renderNodes().then(()=>document.querySelector('[data-node-id="'+id+'"] .sticky textarea')?.focus({preventScroll:true}));},
  noteEditor:openNoteEditor,note(id,value){const n=byId(id);if(n){setNodeNote(n,value);renderNodes();}},
  noteBlur(id,value){if(!value.trim()&&S.openStickyNodeId===id){S.openStickyNodeId=null;renderNodes();}},
  retry(){toast('设计稿：重跑该节点的命令');}
 }});
 $('addNode').style.left=S.nodes.length?S.nodes[0].x+'px':'40px';
 $('addNode').style.top=(S.nodes.length?Math.max(...S.nodes.map(n=>n.y))+310:34)+'px';syncStatus();return update;
}
function syncStatus(){
  $('btnUndoDelete').disabled=!(mapEditor?mapEditor.canUndo:canvasController&&canvasController.canUndoLocal());
  $('sideCount').textContent=S.nodes.length;
  const heading=$('routeTitle');if(heading)heading.textContent=S.apiData?.name|| (S.mode==='demo'?'Aurora 设计路线':S.mode==='real'?'当前导入路线':'设计路线');
  const counts=$('routeCounts');if(counts)counts.textContent=S.nodes.length+' 个步骤 · '+S.edges.length+' 条连线';
  $('railCount').textContent=S.nodes.length;
  $('statusL').textContent=S.nodes.length+' 个步骤 · '+S.edges.length+' 条连线';
  $('statusR').textContent=S.mode==='api'
    ? '真实管线 · 文件清单与 CSV 行数来自本机目录实测，便签落盘为 .pipeline_notes.json'
    : (S.mode==='real'
      ? '当前批次 · 节点来自本次导入，便签保存在浏览器本地'
      : '人工合成演示 · 结构和数值仅供学习，不代表科研结果');
}

function renderEdges(){if(mapEditor)mapEditor.render();}

let sidebarView=null;
function renderSide(){
 if(!sidebarView)sidebarView=window.SB_UI.mountPipelineSidebar($('sideList'));
 const groups=[['当前批次','real'],['输入','r0'],['第 1 轮','r1'],['第 2 轮','r2'],['最终','final'],['手工节点','manual']].map(([label,id])=>({label,id,nodes:S.nodes.filter(n=>n.r===id).map(n=>({id:n.id,color:color(n),title:n.title,count:n.cnt,selected:S.sel===n.id}))})).filter(g=>g.nodes.length);
 sidebarView.update({model:{groups},handlers:{select(id){const n=byId(id);if(n){select(id);focusNode(n);}}}});
}
function renderDrawer(){
  $('drawer').hidden=false;
  const n=byId(S.sel);
  if(!n){
    $('dBadge').textContent='—';$('dBadge').style.background='var(--text3)';
    $('dName').textContent='节点详情';$('dPath').textContent='选择画布中的节点查看内容';
    $('dBody').replaceChildren(el('div','drawer-empty',S.nodes.length?'点击一个节点，在这里查看结构、文件与便签。':'画布还没有节点。可添加文件夹节点，或撤销刚才的删除。'));
    return;
  }
  $('dBadge').textContent=n.tag;$('dBadge').style.background=color(n);
  const dTool=$('dTool'),tool=toolOf(n);
  dTool.hidden=!tool;dTool.textContent=tool;dTool.title=tool?'本步工具（可在 JSON step.tool 自定义）':'';
  $('dName').textContent=n.title;
  $('dPath').textContent=n.path;
  const b=$('dBody');b.innerHTML='';

  if(S.mode==='demo'&&!n.manual){
    b.appendChild(el('div','sec','结构预览'));
    const sb=el('div','struct');
    sb.innerHTML='<svg viewBox="0 0 300 132" preserveAspectRatio="xMidYMid meet">'
     +'<path d="M 18 82 Q 40 46 62 82 T 106 82 T 150 82 T 194 82 T 238 82 T 282 82" fill="none" stroke="#2f6fad" stroke-width="5" stroke-linecap="round" opacity=".85"/>'
     +'<path d="M 26 106 Q 48 72 70 106 T 114 106 T 158 106 T 202 106 T 246 106" fill="none" stroke="#d05a3c" stroke-width="4" stroke-linecap="round" opacity=".6"/>'
     +'<path d="M 40 58 Q 62 26 84 58 T 128 58 T 172 58 T 216 58 T 260 58" fill="none" stroke="#3d9367" stroke-width="3" stroke-linecap="round" opacity=".55"/>'
     +'</svg>';
    sb.appendChild(el('div','sl','binder（彩） + 靶点（灰）· 示意'));
    const ob=el('button','mini so','⤢ 在 StructBoard 打开');ob.onclick=()=>toast('设计稿：把该文件夹的结构送进 StructBoard');sb.appendChild(ob);
    b.appendChild(sb);
  }else{
    // 真实管线 / 真实批次模式下，没有把结构读进画布，画假曲线会误导
    b.appendChild(el('div','sec','结构预览'));
    const nb=el('div','struct-note');
    const sfs=(n.files||[]).filter(function(f){return /\.(pdb|ent|cif|mmcif|pdbqt|gro)(\.gz)?$/i.test(f[0])});
    nb.appendChild(el('div','sl',n.apiStepId
      ? '直接载入这一步关联的全部结构文件，加载后返回结构视图。'
      : (sfs.length ? '这组结构已在内存中，点击直接查看。' : '该节点尚未关联结构文件。')));
    const ob=el('button','mini so','⤢ 在结构视图中打开 →');
    ob.dataset.openStep=n.id;
    ob.disabled=!!S.openRequest;
    ob.onclick=()=>{
      if(window.parent===window){toast('请从 StructBoard 主界面打开设计管线');return;}
      if(n.groupId){window.parent.postMessage({type:'pipelineOpenGroup',id:n.groupId},location.origin);}
      else if(n.apiStepId){
        const requestId=crypto.randomUUID();
        S.openRequest={requestId,nodeId:n.id};
        ob.disabled=true;ob.textContent='正在读取结构清单…';
        window.parent.postMessage({type:'pipelineOpenStep',id:S.apiId,stepId:n.apiStepId,requestId,stepIndex:S.nodes.indexOf(n),tool:n.tool||'',title:n.title},location.origin);
      }else toast('该节点尚未关联结构文件');
    };
    nb.appendChild(ob);
    b.appendChild(nb);
  }

  b.appendChild(el('div','sec','文件夹内容'));
  for(const [f,sz] of n.files){
    const row=el('div','file');
    row.appendChild(el('span','fi',/\/$/.test(f)?'▣':'▤'));
    row.appendChild(el('span','fn',f));
    row.appendChild(el('span','fs',sz));
    b.appendChild(row);
  }

  const kv=(n.kv||[]).filter(function(x){return x[0]!=='文件数'&&x[0]!=='步骤'&&x[0]!=='步骤数'});
  if(kv.length){
    b.appendChild(el('div','sec','本轮关键数值'));
    for(const [k,v] of kv){const row=el('div','kv');row.appendChild(el('span','k',k));row.appendChild(el('span','v',v));b.appendChild(row);}
  }

  if(n.cmd){
    b.appendChild(el('div','sec','这一轮怎么跑的'));
    const cb=el('pre','d-cmd');cb.textContent=n.cmd;b.appendChild(cb);
  }
  if(n.facts&&Object.keys(n.facts).length){
    b.appendChild(el('div','sec','CSV 实测行数'));
    for(const fp in n.facts){
      const row=el('div','kv');
      row.appendChild(el('span','k',fp.split('/').pop()));
      row.appendChild(el('span','v',(n.facts[fp].rowsTruncated?'至少 ':'')+n.facts[fp].rows+' 行'));
      b.appendChild(row);
    }
  }
  b.appendChild(el('div','sec','这张便签写了什么'));
  b.appendChild(el('div','d-note'+(n.note?'':' is-empty'),n.note||NOTE_EMPTY));
  if(S.mode==='api'){
    const hint=el('div','d-hint');
    hint.innerHTML='便签自动保存到 <span class="mono">.pipeline_notes.json</span>（真实管线根目录）';
    b.appendChild(hint);
  }

  if(n.groupId){
    const og=el('button','open-group','在结构视图中打开这一组 →');
    og.onclick=()=>{if(window.parent!==window){try{window.parent.postMessage({type:'pipelineOpenGroup',id:n.groupId},location.origin)}catch(_){}}};
    b.appendChild(og);
  }
  b.appendChild(el('div','sec','上下游'));
  const up=S.edges.filter(e=>e[1]===n.id).map(e=>byId(e[0])).filter(Boolean);
  const down=S.edges.filter(e=>e[0]===n.id).map(e=>byId(e[1])).filter(Boolean);
  for(const u of up){const l=el('div','link','↑ 来自 '+u.title);l.onclick=()=>{select(u.id);focusNode(u)};b.appendChild(l)}
  for(const d of down){const l=el('div','link','↓ 流向 '+d.title);l.onclick=()=>{select(d.id);focusNode(d)};b.appendChild(l)}
  if(canDeleteNode(n)){
    const actions=el('div','drawer-delete'),del=el('button','btn','删除节点');del.type='button';del.id='btnDeleteNode';
    del.onclick=()=>deleteNode(n.id);actions.appendChild(del);actions.appendChild(el('span','','仅从本画布移除，磁盘文件保留。可撤销。'));b.appendChild(actions);
  }
}

function select(id){
 if(S.sel===id)return;
 S.sel=id;canvasObserveView();renderNodeSelection();renderDrawer();mapEditor?.render();
}
function focusNode(n){
  const viewport=$('viewport'),vw=Math.max(250,viewport.clientWidth),vh=viewport.clientHeight;
  const visibleH=Math.max(180,vh-48),nodeH=CARD_H+86;
  const scaledH=nodeH*S.scale;
  const centeredY=24+(visibleH-scaledH)/2;
  const topGuard=18;
  S.tx=vw/2-(n.x+CARD_W/2)*S.scale;
  S.ty=Math.max(topGuard,centeredY)-n.y*S.scale;
  applyTransform();
}
function fmtSize(n){
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}
function dateLabel(t){
  if(!t)return '—';
  const d=new Date(t);
  return (d.getMonth()+1)+'-'+String(d.getDate()).padStart(2,'0');
}
function refreshAll(){
  restoreCanvas();
  if(!byId(S.sel))S.sel=S.nodes[0]?.id||null;
  renderNodes();renderEdges();renderSide();renderDrawer();
  applyTransform();
  if(mapEditor&&!canvasState().document?.viewport&&!canvasState().viewport)requestAnimationFrame(()=>mapEditor.fit());
}
function applyRealData(d){
  const previous=S.sel;
  S.realData=d;S.mode='real';
  const gs=(d&&d.groups)||[];
  if(!gs.length){
    S.nodes=[{id:'empty',x:40,y:34,r:'real',tag:'—',title:'还没有导入批次',state:'wait',
      desc:'回到结构视图导入文件后\n这里会自动出现文件夹节点',cnt:'0 个结构',date:'—',
      note:'',path:'—',files:[],kv:[['结构数','0']]}];
    S.edges=[];S.sel='empty';
  }else{
    S.nodes=gs.map(function(g,i){
      const names=g.files.slice(0,2).map(function(f){return f.name}).join('\n');
      return {
        id:g.id,x:40+(i%4)*280,y:34+Math.floor(i/4)*284,
        r:'real',tag:'批次',title:g.name,
        state:d.activeGroupId===g.id?'now':'done',
        desc:g.files.length+' 个结构'+(names?'\n'+names:''),
        cnt:g.files.length+' 个结构',date:dateLabel(g.createdAt),
        note:(d.notes||{})[g.id]||'',
        path:'浏览器内 · 来自本次导入（不写入原文件）',
        files:g.files.slice(0,8).map(function(f){return [f.name,fmtSize(f.size)]}),
        kv:[['结构数',String(g.files.length)],['便签','已保存']],
        groupId:g.id,
      };
    });
    S.edges=S.nodes.slice(1).map(function(n,i){return [S.nodes[i].id,n.id]});
    S.sel=S.nodes[0].id;
  }
  rememberCanvasBase();restoreCanvas();if(byId(previous))S.sel=previous;
  $('tabApi').classList.remove('active');
  $('dataBadge').textContent='当前批次 · '+gs.length+' 个文件夹';
  $('tabReal').classList.add('active');$('tabDemo').classList.remove('active');
  refreshAll();
}
// 真实管线：把 API 返回的 steps 映射成画布节点
function applyApiData(d){
  S.apiData=d;S.mode='api';
  const steps=d.steps||[];
  if(!steps.length){
    S.nodes=[{id:'api-empty',x:40,y:34,r:'api',tag:'—',title:'这条管线没有步骤',state:'wait',
      desc:(d.rootExists===false)?('根目录不存在：'+(d.root||'—')):'定义里没有 steps',
      cnt:'0 个文件',date:'—',note:'',path:d.root||'—',files:[],kv:[['步骤数','0']]}];
    S.edges=[];S.sel='api-empty';
  }else{
    const colorOf=t=>t==='R0'?'r0':t==='R1'?'r1':t==='R2'?'r2':'final';
    S.nodes=steps.map(function(st,i){
      const row=(i%4)*280, rowY=Math.floor(i/4)*300;
      const cntText=st.counts&&st.counts.known ? SB_LINEAGE.countText(st.counts) : st.fileCount+' 份结构文件';
      // 关键数值：CSV 行数
      const kv=[['步骤',st.id]];
      if(st.dir)kv.push([st.dir.path,(st.dir.exists?st.dir.entries+' 项':'不存在')]);
      Object.keys(st.facts||{}).slice(0,3).forEach(function(fp){
        kv.push([fp.split('/').pop(),(st.facts[fp].rowsTruncated?'至少 ':'')+st.facts[fp].rows+' 行']);
      });
      kv.push(['结构文件数',String(st.fileCount)]);
      if(st.operation)kv.push(['本步操作',SB_LINEAGE.operationText(st.operation)]);
      if(st.counts&&st.counts.known){kv.push(['候选序列',String(st.counts.candidates)]);if(st.counts.controls)kv.push(['原版对照',String(st.counts.controls)]);}
      if(st.truncated)kv.push(['文件明细','仅列前'+(st.files||[]).length+'项，数量统计为完整集合']);
      return {
        id:'api_'+st.id,x:40+row,y:34+rowY,r:colorOf(st.tag),tag:st.tag||st.round||'',
        tool:st.tool||'',
        title:st.title,state:st.state==='done'?'done':(st.state==='now'?'now':'wait'),
        desc:st.desc||'',cnt:cntText,date:'',note:st.note||'',
        path:(d.root?d.root.replace(/[\\\/]+$/,'')+'/':'')+(st.dir?st.dir.path:st.id),
        files:(st.files||[]).map(function(f){return [f.name,f.sizeText]}).slice(0,8),
        kv:kv,apiStepId:st.id,
        cmd:st.cmd||'',facts:st.facts||{},fullFileCount:st.fileCount
      };
    });
    // 串成链：同轮次横向，相邻轮次换行
    S.edges=[];
    for(let i=1;i<S.nodes.length;i++){
      const a=S.nodes[i-1],b=S.nodes[i];
      const sameRow=Math.floor((a.y-34)/300)===Math.floor((b.y-34)/300);
      if(sameRow){b.x=a.x+280;b.y=a.y;}
      S.edges.push([a.id,b.id]);
    }
    S.sel=S.nodes[0].id;
  }
  rememberCanvasBase();
  $('dataBadge').textContent=(d.name||'真实管线')+' · '+steps.length+' 步';
  $('tabApi').classList.add('active');$('tabReal').classList.remove('active');$('tabDemo').classList.remove('active');
  $('sideFoot').replaceChildren(document.createTextNode('真实目录'),document.createElement('br'),el('span','mono',d.root||'—'),document.createElement('br'),document.createTextNode('只读扫描，脚本与 CSV 不改动'));
  refreshAll();
}
async function loadApiPipelines(){
  const j=await apiGet('/api/pipelines');
  if(!j){S.apiOffline=true;S.apiMsg='未连接本地服务';$('tabApi').classList.remove('active');return false;}
  S.apiPipelines=j.pipelines||[];
  renderPipeSelect();
  return true;
}
async function loadApiPipeline(pid){
  const j=await apiGet('/api/pipeline?id='+encodeURIComponent(pid));
  if(!j){toast('读取管线失败：'+pid);return;}
  S.apiId=pid;
  applyApiData(j.pipeline);
  $('pipeSelect').value=pid;
}
async function useApi(){
  if(S.apiOffline){toast('本地服务未运行，无法读取真实管线');return;}
  if(!S.apiPipelines.length){await loadApiPipelines();}
  const pid=S.apiId||(S.apiPipelines[0]&&S.apiPipelines[0].id);
  if(!pid){toast('没有可用管线');return;}
  await loadApiPipeline(pid);
}
// 与主窗口使用同一实现、独立存储键，避免两个窗口的本机 outbox 互相覆盖。
// 仅 HTTP 成功且 {ok:true} 才 ACK；失败和关窗前的输入始终留在持久队列。
const canvasNotesSync=window.SB_NOTES_SYNC.create({
 storage:localStorage,storageKey:'structboard.pipelineNotesPending',
 onChange:()=>paintCanvasNoteStatus(),
});
function paintCanvasNoteStatus(){
 const n=noteEditorState&&byId(noteEditorState.nodeId),label=$('noteEditorStatus');
 if(!n||!label)return;
 const state=S.mode==='api'&&n.apiStepId?canvasNotesSync.status(S.apiId,n.apiStepId):{state:'local'};
 label.textContent=window.SB_NOTE_EDIT.stateText(state);
 label.dataset.state=state.state;label.title=state.error||'';
}
function scheduleNoteSave(stepId,text){
 const pid=S.apiId;if(!pid)return;
 const durable=canvasNotesSync.put(pid,{[stepId]:text});
 if(S.apiData){S.apiData.notes={...(S.apiData.notes||{}),[stepId]:text};const step=(S.apiData.steps||[]).find(st=>st.id===stepId);if(step)step.note=text;}
 return durable;
}
function flushNotes(){return canvasNotesSync.flush();}
window.addEventListener('pagehide',()=>{if(canvasController)canvasController.save();flushNotes();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){if(canvasController)canvasController.save();flushNotes();}});
function useDemo(){
  S.mode='demo';S.nodes=DEMO_NODES.map(n=>({...n}));S.edges=DEMO_EDGES.map(e=>e.slice());S.sel='n3';rememberCanvasBase();
  $('dataBadge').textContent='Aurora 人工合成演示';
  $('tabDemo').classList.add('active');$('tabReal').classList.remove('active');$('tabApi').classList.remove('active');
  refreshAll();
}
function useReal(){
  if(!S.realData){toast('还没有导入批次，先回结构视图导入文件');return}
  applyRealData(S.realData);
}

function fitScale(){
 if(window.SB_UI.routeGeometry)return window.SB_UI.routeGeometry.fitView(S.nodes,$('viewport').clientWidth,$('viewport').clientHeight).scale;
 return .85;
}
function applyTransform(){
 S.scale=Math.max(.22,Math.min(2.6,S.scale));
 $('world').style.transform='translate('+S.tx+'px,'+S.ty+'px) scale('+S.scale+')';
 $('zoomLabel').textContent=Math.round(S.scale*100)+'%';
 mapEditor?.transform();canvasObserveView();
}
function zoomByWheel(e){
 const unit=e.deltaMode===1?16:e.deltaMode===2?120:1;
 const dy=(e.deltaY||e.deltaX)*unit;if(!dy)return;
 const r=$('viewport').getBoundingClientRect();
 if(mapEditor)mapEditor.zoom(Math.exp(-dy*.0022),{x:e.clientX-r.left,y:e.clientY-r.top});
 else{S.scale*=Math.exp(-dy*.0022);applyTransform();}
}
const pageZoom=window.devicePixelRatio||1;
let pageZoomFrame=0;
function keepPageScale(){
  if(!window.__SB_DESKTOP_INVOKE__||pageZoomFrame)return;
  pageZoomFrame=requestAnimationFrame(()=>{
    pageZoomFrame=0;
    if(Math.abs((window.devicePixelRatio||1)-pageZoom)<0.02)return;
    window.__SB_DESKTOP_INVOKE__('desktop_reset_zoom').catch(()=>{});
  });
}

let toastTimer;
function toast(msg,undo){
  let t=$('toast');if(!t){t=el('div');t.id='toast';document.body.appendChild(t);
    t.style.cssText='position:fixed;bottom:44px;left:50%;transform:translateX(-50%);z-index:99;padding:9px 16px;border-radius:8px;background:#223140;color:#fff;font-size:12px;box-shadow:0 6px 22px rgba(20,35,50,.25)';}
  t.textContent=msg;
  if(undo){const button=el('button','toast-undo','撤销');button.type='button';button.onclick=undo;t.appendChild(button);}
  t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true},undo?6500:2200);
}

// ---------------------------------------------------------------- 导入管线定义
const AGENT_EXAMPLE={
  id:'my_design',name:'我的多轮设计',target:'填写靶点与设计体系',root:'D:/datasets/my-project',
  steps:[
    {id:'input',tag:'R0',tool:'pymol',title:'输入结构',desc:'靶点结构与准备说明',
      files:[{name:'靶点模板',path:'input/target.pdb'}],note:'填写链定义与输入说明',state:'done'},
    {id:'candidates',tag:'R1',tool:'rfd3',title:'候选结构',desc:'按单文件或路径规则标记优选',
      files:[{name:'优选候选',path:'candidates/design_001.cif',star:true},
             {name:'暂不优选',path:'candidates/control_best.cif',star:false}],
      globs:['candidates/*.cif'],starGlobs:['candidates/*_best.cif'],
      note:'单文件 star 优先于 starGlobs；未显式设置的匹配文件自动标星',state:'done'},
    {id:'final',tag:'Final',tool:'boltz-2',title:'最终入选结构',desc:'填写实际筛选条件与结果',star:true,
      dir:'final/structures',globs:['final/structures/*.pdb','final/structures/*.cif','final/structures/*.cif.gz'],
      cmd:'填写实际运行命令；未核实则写待补充',note:'本步骤全部结构默认优选；请按实际筛选结论设置',state:'done'}
  ]
};
function agentInstructions(){
  return [
    '请把我指定的蛋白质设计目录整理为可导入 StructBoard 工作台的管线 JSON。',
    '先核对实际文件与运行记录，再按下面格式生成；只读整理，不移动、改名或修改结构文件。',
    '',
    '格式规则：',
    '1. 顶层必填 id、name、root、steps；target 可选。id 仅允许字母、数字、下划线和短横线，1–64字符。保存文件时命名为 <id>.json。',
    '2. root 必须是运行 StructBoard 的这台电脑可访问的绝对路径。Windows 路径优先用正斜杠，如 D:/datasets/my-project。若结构在远端，先说明本机可访问路径，不能把远端路径直接当成本机路径。',
    '3. steps 为非空数组，数组顺序即流程顺序；每步必填唯一 id 与 title。可选 tag、round、tool、groupBy、desc、cmd、note、files、globs、dir、state、star、starGlobs。tool 写该步实际用的工具（如 rfd3、rfd4、mpnn、boltz-2、py），会显示在节点头部。文件名带 _model_N 的步骤在总览自动按序列折叠成候选文件夹（无需配置）；其余结构需要分组时写 "groupBy": "dir:N"（按倒数第 N 层目录名分组）。',
    '4. files=[{name,path,star}] 精确关联文件；globs 批量关联文件；dir 为主目录，只有没有 globs 时才作为结构读取的目录回退。所有路径都相对 root，不可越界。',
    '5. 优选标记：单个文件写 "star": true；步骤写 "star": true 会标记该步骤全部结构；步骤写 "starGlobs": ["final/structures/*_best.cif"] 只标记匹配文件。优选默认显示在列表前面，同组内再按指标排序。',
    '6. 要能直接打开结构，每步需通过 files/globs/dir 实际关联结构；不要只列脚本或表格。支持 .pdb/.ent/.cif/.mmcif/.mcif/.bcif 及其 .gz。归档包需先解压出结构。',
    '7. glob 的 * 只匹配同一层，** 可跨层；递归包含当前层和子目录时同时写 structures/*.pdb 与 structures/**/*.pdb；不要使用 ? 或 [] 通配符。',
    '8. state 只允许 done/now/wait，默认 done。desc 写步骤说明；cmd 只记录实际命令；note 写默认便签。未知阈值、命令或血缘写待补充，不能编造。',
    '9. 显示层整理（自建文件夹、文件夹便签与位置、撤销历史）由 StructBoard 自动保存到 step.organization，导入 JSON 无需填写，手工编写时也不要写 organization。',
    '10. 输出合法 JSON，不要注释、尾逗号或 Markdown 围栏。示例路径和占位文字必须换成实际值。这个 JSON 记录路径，不包含结构文件本体。',
    '',
    'JSON 示例：',JSON.stringify(AGENT_EXAMPLE,null,2),
    '',
    '使用：在 StructBoard → 设计管线 → 导入，粘贴 JSON 或选择保存的 <id>.json，点导入并打开；再点节点里的在结构视图中打开。'
  ].join('\n');
}
async function copyAgentInstructions(){
  const text=agentInstructions(),status=$('agentCopyStatus');
  let copied=false;
  try{await navigator.clipboard.writeText(text);copied=true;}catch(_){
    const helper=el('textarea');helper.value=text;helper.style.cssText='position:fixed;left:-9999px;top:0';
    document.body.appendChild(helper);helper.select();
    try{copied=document.execCommand('copy');}catch(_){}helper.remove();
  }
  if(copied){status.textContent='已复制生成要求、字段规则和完整 JSON 示例，直接粘贴给 Agent。';return;}
  $('agentExample').value=text;$('agentExample').closest('details').open=true;
  $('agentExample').focus();$('agentExample').select();
  status.textContent='浏览器未允许直接复制，内容已选中，按 Ctrl+C 即可复制。';
}
let importState={tab:'json',scaffold:null,file:null,busy:false,run:null};
let importCloseTimer=null;
function formatBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<0)return '未知大小';
  if(bytes<1024)return bytes+' B';
  if(bytes<1024*1024)return (bytes/1024).toFixed(1)+' KB';
  if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(1)+' MB';
  return (bytes/1024/1024/1024).toFixed(2)+' GB';
}

function setImportMsg(text,kind){
  const m=$('importMsg');
  if(!text){m.hidden=true;m.textContent='';return;}
  m.hidden=false;m.textContent=text;m.className='m-msg '+(kind||'err');
}

function setImportProgress(title,percent,detail,indeterminate){
  const box=$('importProgress');
  box.hidden=false;
  box.classList.toggle('is-indeterminate',!!indeterminate);
  $('importProgressTitle').textContent=title||'正在处理';
  $('importProgressDetail').textContent=detail||'';
  const hasPercent=Number.isFinite(percent),track=box.querySelector('.import-progress-track');
  track.setAttribute('role','progressbar');track.setAttribute('aria-label',title||'导入进度');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
  if(hasPercent)track.setAttribute('aria-valuenow',String(Math.round(percent)));else track.removeAttribute('aria-valuenow');
  $('importProgressPct').textContent=hasPercent?Math.max(0,Math.min(100,Math.round(percent)))+'%':(indeterminate?'处理中':'已停止');
  if(hasPercent)$('importProgressBar').style.width=Math.max(0,Math.min(100,percent))+'%';
}
function resetImportProgress(){
  const box=$('importProgress');
  box.hidden=true;box.classList.remove('is-indeterminate');
  $('importProgressBar').style.width='0%';
  $('importProgressDetail').textContent='';
  $('importProgressPct').textContent='0%';
}
function setImportBusy(busy){
  importState.busy=busy;
  $('btnDoImport').disabled=busy;
  $('btnPickFile').disabled=busy;
  $('btnScaffold').disabled=busy;
  $('mTabJson').disabled=busy;
  $('mTabDir').disabled=busy;
  $('mJson').disabled=busy;
  $('mOverwrite').disabled=busy;
  $('btnCancel').disabled=false;
  $('btnCancel').textContent=busy?'取消导入':'取消';
  $('importMask').querySelector('.modal').setAttribute('aria-busy',String(busy));
}
function openImport(){
  clearTimeout(importCloseTimer);
  const mask=$('importMask');
  setImportMsg('');
  resetImportProgress();
  $('agentCopyStatus').textContent='';
  $('agentExample').value=JSON.stringify(AGENT_EXAMPLE,null,2);
  if(!apiBase()){
    setImportMsg('当前是 file:// 打开，无法访问本地服务。\n请双击 structboard/start-server.bat 起服务，'
      +'再打开 http://127.0.0.1:8000/ 用这个功能。','err');
  }
  mask.hidden=false;
  void mask.offsetWidth;
  mask.classList.add('open');
}
function closeImport(){
  if(importState.busy){cancelImport();return;}
  const mask=$('importMask');
  if(mask.hidden)return;
  mask.classList.remove('open');
  clearTimeout(importCloseTimer);
  const delay=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:300;
  importCloseTimer=setTimeout(()=>{
    if(mask.classList.contains('open'))return;
    mask.hidden=true;
    // 淡出结束后再清提示，避免退出时弹窗突然变矮。
    setImportMsg('');$('importMsg2').hidden=true;resetImportProgress();
  },delay);
}
async function cancelImport(){
  const run=importState.run;
  if(!run||!importState.busy)return;
  run.cancelled=true;
  $('btnCancel').disabled=true;
  $('btnCancel').textContent='正在取消…';
  if(!run.submitted){run.controller.abort();return;}
  setImportProgress('正在取消导入',null,'正在确认本地服务的保存状态…',true);
  if(run.jobId){
    const reply=await apiPostFull('/api/pipeline/import/cancel',{jobId:run.jobId});
    if(!reply.ok){
      setImportMsg('取消请求未确认：'+reply.error+'。将继续查询实际状态。','warn');
      $('btnCancel').disabled=false;
    }
  }
}

function switchImportTab(tab){
  if(importState.busy)return;
  importState.tab=tab;
  $('mTabJson').classList.toggle('active',tab==='json');
  $('mTabDir').classList.toggle('active',tab==='dir');
  $('mPaneJson').hidden=tab!=='json';
  $('mPaneDir').hidden=tab!=='dir';
  setImportMsg('');
}

function importWorkerSource(){
  return `self.onmessage=function(event){
    const blob=event.data.blob;
    const reader=new FileReader();
    reader.onprogress=e=>self.postMessage({type:'progress',loaded:e.loaded,total:blob.size});
    reader.onerror=()=>self.postMessage({type:'error',message:'文件读取失败，请重新选择文件'});
    reader.onload=function(){
      self.postMessage({type:'parsing'});
      try{
        const value=JSON.parse(String(reader.result||'').replace(/^\\uFEFF/,''));
        if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('顶层必须是 JSON 对象');
        self.postMessage({type:'ready',id:typeof value.id==='string'?value.id:'',steps:Array.isArray(value.steps)?value.steps.length:0});
      }catch(error){self.postMessage({type:'error',message:'JSON 解析失败：'+error.message});}
    };
    reader.readAsText(blob,'utf-8');
  };`;
}
function readImportSource(blob,run){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([importWorkerSource()],{type:'application/javascript'}));
    let worker;
    const abort=()=>{finish();reject(new DOMException('已取消','AbortError'));};
    const finish=()=>{if(worker)worker.terminate();URL.revokeObjectURL(url);run.controller.signal.removeEventListener('abort',abort);};
    try{
      worker=new Worker(url);
      run.controller.signal.addEventListener('abort',abort,{once:true});
      worker.onmessage=e=>{
        const d=e.data||{};
        if(d.type==='progress'){
          setImportProgress('读取 JSON',d.total?d.loaded/d.total*100:null,
            formatBytes(d.loaded)+' / '+formatBytes(d.total),!d.total);return;
        }
        if(d.type==='parsing'){setImportProgress('解析 JSON',null,'后台解析中，界面保持响应；可随时取消。',true);return;}
        finish();
        if(d.type==='ready')resolve(d);else reject(new Error(d.message||'JSON 读取失败'));
      };
      worker.onerror=e=>{finish();reject(new Error(e.message||'后台读取失败'));};
      worker.postMessage({blob});
    }catch(e){finish();reject(e);}
  });
}
function apiPostImport(source,overwrite,onUpload){
  const base=apiBase(),desktop=window.__SB_DESKTOP__;
  if(!base)return Promise.resolve({ok:false,error:'请先启动 StructBoard 本地服务再导入。'});
  return new Promise(resolve=>{
    const xhr=new XMLHttpRequest();
    const path='/api/pipeline/import?async=1&raw=1&overwrite='+(overwrite?'1':'0');
    xhr.open('POST',(desktop?desktop.apiBase:base)+path,true);
    xhr.timeout=120000;
    xhr.setRequestHeader('Content-Type','application/json');
    if(desktop&&desktop.token)xhr.setRequestHeader('X-StructBoard-Token',desktop.token);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onUpload(e.loaded,e.total);};
    xhr.upload.onload=()=>setImportProgress('校验管线定义',null,'文件已发送到本机服务，正在解析与校验…',true);
    xhr.onerror=()=>resolve({ok:false,error:'无法连接本地数据服务，请检查服务是否仍在运行。'});
    xhr.ontimeout=()=>resolve({ok:false,error:'本地服务 120 秒内未响应，保存状态未确认，请刷新管线列表检查。'});
    xhr.onload=()=>{
      let data;try{data=JSON.parse(xhr.responseText);}catch(_){ }
      resolve(data&&data.ok?data:{ok:false,error:data&&data.error?data.error:'请求失败 HTTP '+xhr.status});
    };
    // 直接发送原始 File/Blob，避免 stringify 和大字符串跨线程复制。
    xhr.send(source);
  });
}
async function waitImportJob(run){
  let failures=0;
  for(;;){
    if(run.cancelled&&!run.cancelSent){
      const reply=await apiPostFull('/api/pipeline/import/cancel',{jobId:run.jobId});
      run.cancelSent=reply.ok;
    }
    let reply;
    try{
      const response=await fetch(apiBase()+'/api/pipeline/import/status?job='+encodeURIComponent(run.jobId),
        {cache:'no-store',signal:AbortSignal.timeout(20000)});
      reply=await response.json();
      if(!reply.ok)throw new Error(reply.error||'无法查询任务');
      failures=0;
    }catch(e){
      if(++failures>=3)throw new Error('任务状态连接中断。导入可能仍在本机运行，请刷新管线列表检查。'+e.message);
      setImportProgress('正在重新连接',null,'等待本地服务恢复，正在重试…',true);
      await new Promise(resolve=>setTimeout(resolve,500));continue;
    }
    const job=reply.job;
    setImportProgress(job.title,job.percent,job.detail,job.percent===null);
    if(job.state==='done')return job.result;
    if(job.state==='error')throw new Error((job.saved?'管线已保存，后续处理失败：':'导入失败：')+job.error);
    if(job.state==='cancelled')throw new DOMException('导入已取消，未保存管线定义','AbortError');
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}

// 从目录生成草稿：只读扫描，返回草稿 JSON（不落盘，等用户确认）
async function runScaffold(){
  if(importState.busy)return;
  const root=$('mRoot').value.trim();
  if(!root){setImportMsg('请先填数据目录的绝对路径。','err');return;}
  setImportMsg('正在扫描目录…');
  const r=await apiPostFull('/api/pipeline/scaffold',{
    root:root,
    id:$('mPid').value.trim()||null,
    name:$('mName').value.trim()||null
  });
  if(!r.ok){setImportMsg(r.error,'err');return;}
  importState.scaffold=r.definition;
  importState.file=null;
  $('mJson').value=JSON.stringify(r.definition,null,2);
  switchImportTab('json');
  const w=(r.warnings&&r.warnings.length)?r.warnings:[];
  setImportMsg('草稿已生成：'+r.definition.steps.length+' 步。\n'
    +'★ 分组是按文件名猜的，不是流程事实。\n'
    +'★ cmd 和阈值必须你自己对照脚本补齐。\n'
    +(w.length?('\n提醒：\n· '+w.join('\n· ')):'')
    +'\n\n确认无误后点「导入并打开」。','warn');
}

// 百分比表示当前阶段的实际进度；未知总量的解析/保存阶段使用活动条。
async function runImport(){
  if(importState.busy)return;
  const raw=$('mJson').value;
  const source=raw.trim()?new Blob([raw],{type:'application/json'}):importState.file;
  if(!source){setImportMsg('请先粘贴 JSON，或选择 JSON 文件。','err');return;}
  if(source.size>128*1024*1024){setImportMsg('JSON 文件超过 128 MB 上限（'+formatBytes(source.size)+'），请拆分为多条管线后导入。','err');return;}
  const run={controller:new AbortController(),cancelled:false,submitted:false,jobId:null};
  const overwrite=$('mOverwrite').checked;
  clearTimeout(importCloseTimer);
  importState.run=run;
  setImportBusy(true);setImportMsg('');
  setImportProgress('读取 JSON',0,'正在后台读取 '+formatBytes(source.size),false);
  let success=false;
  try{
    const parsed=await readImportSource(source,run);
    if(run.cancelled)throw new DOMException('已取消','AbortError');
    setImportProgress('发送到本机服务',0,'JSON 已解析：'+parsed.steps+' 个步骤 · '+formatBytes(source.size),false);
    run.submitted=true;
    const response=await apiPostImport(source,overwrite,(loaded,total)=>{
      setImportProgress('发送到本机服务',loaded/total*100,formatBytes(loaded)+' / '+formatBytes(total),false);
    });
    if(!response.ok)throw new Error(response.error);
    run.jobId=response.jobId;
    if(!run.jobId)throw new Error('本地服务版本不支持导入进度，请关闭并重新打开更新后的 StructBoard。');
    const result=await waitImportJob(run);
    setImportProgress('打开管线',null,'正在绘制 '+result.pipeline.steps.length+' 个步骤…',true);
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    if(result.pipelines){S.apiPipelines=result.pipelines;renderPipeSelect();}
    S.apiId=result.id;S.userMode=true;
    applyApiData(result.pipeline);
    $('pipeSelect').value=result.id;
    setImportProgress('导入完成',100,'已保存并打开管线「'+result.id+'」。',false);
    setImportMsg(run.cancelled?'取消前已完成保存，现已打开管线「'+result.id+'」。':'已导入管线「'+result.id+'」。','ok');
    toast('已导入管线「'+result.id+'」');
    success=true;
  }catch(e){
    const cancelled=e.name==='AbortError';
    const message=cancelled?'导入已取消，未保存管线定义。':(e.message||String(e));
    setImportMsg(message,cancelled?'warn':'err');
    setImportProgress(cancelled?'已取消导入':'导入失败',null,message,false);
  }finally{
    if(importState.run===run){importState.run=null;setImportBusy(false);}
  }
  if(success){
    // 成功状态短暂停留；期间不允许新任务被旧任务的自动关闭打断。
    importCloseTimer=setTimeout(()=>{if(!importState.busy)closeImport();},900);
  }
}

// 重建下拉框（导入后刷新用）
function renderPipeSelect(){
  const sel=$('pipeSelect');
  sel.innerHTML='';
  if(!S.apiPipelines.length){sel.innerHTML='<option>没有可用管线</option>';sel.disabled=true;return;}
  sel.disabled=false;
  for(const p of S.apiPipelines){
    const o=document.createElement('option');
    o.value=p.id;o.textContent=p.name+(p.rootExists?'':'（目录缺失）');
    sel.appendChild(o);
  }
  if(S.apiId)sel.value=S.apiId;
}

function bindImport(){
  $('btnCopyAgent').onclick=copyAgentInstructions;
  $('btnImport').onclick=openImport;
  $('importClose').onclick=closeImport;
  $('btnCancel').onclick=closeImport;
  $('mTabJson').onclick=()=>switchImportTab('json');
  $('mTabDir').onclick=()=>switchImportTab('dir');
  $('btnScaffold').onclick=runScaffold;
  $('btnDoImport').onclick=runImport;
  $('mJson').oninput=()=>{if($('mJson').value.trim())$('pickFileName').textContent='将导入下方编辑的 JSON';};
  $('importMask').onclick=e=>{if(e.target===$('importMask')&&!importState.busy)closeImport();};
  $('btnPickFile').onclick=()=>{
    if(importState.busy)return;
    // 大文件保留 File 对象，小文件提供可编辑预览。
    const inp=document.createElement('input');
    inp.type='file';inp.accept='.json,application/json';
    inp.onchange=()=>{
      const f=inp.files&&inp.files[0];if(!f)return;
      importState.file=f;importState.scaffold=null;
      $('mJson').value='';
      $('pickFileName').textContent=f.name+' ('+formatBytes(f.size)+')';
      setImportMsg('已选择 '+f.name+'。点击「导入并打开」开始后台读取。','ok');
      setImportProgress('文件已就绪',0,'等待开始导入（'+formatBytes(f.size)+'）',false);
      if(f.size<=256*1024){
        const before=$('mJson').value;
        f.text().then(text=>{if(importState.file===f&&!importState.busy&&$('mJson').value===before)$('mJson').value=text;}).catch(()=>{});
      }else{
        $('mJson').placeholder='已选择 '+f.name+'（'+formatBytes(f.size)+'）。为保持流畅，文件内容将在导入时后台读取。';
      }
    };
    inp.click();
  };
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!$('importMask').hidden){
      e.preventDefault();e.stopPropagation();closeImport();
    }
  });
}

function init(){
  try{if(localStorage.getItem('structboard.theme')==='dark')document.body.classList.add('dark');}catch(e){}
  let preferredSource=null;
  try{preferredSource=JSON.parse(localStorage.getItem('structboard.routeSource.v1')||'null');}catch(_){}
  if(preferredSource?.mode==='demo'){
    S.userMode=true;$('tabDemo').classList.add('active');$('tabReal').classList.remove('active');$('tabApi').classList.remove('active');
  }
  if(preferredSource?.mode==='api'&&typeof preferredSource.id==='string')S.apiId=preferredSource.id;
  const rememberSource=mode=>{try{localStorage.setItem('structboard.routeSource.v1',JSON.stringify({mode,id:S.apiId}));}catch(_){}};
  startCanvasOperations();
  if(window.SB_UI.createRouteEditor)mapEditor=window.SB_UI.createRouteEditor({state:S,key:canvasKey,revision:()=>canvasController.api.getSnapshot({}).revision,
    commit:ops=>canvasOperation(ops),undo:()=>canvasController.undoLocal(),canUndo:()=>canvasController.canUndoLocal(),
    redraw:renderCanvasChange,transform:applyTransform,notice:toast,status:syncStatus});
  applyPanels();
  renderNodes();renderEdges();renderSide();renderDrawer();
  applyTransform();
  bindImport();bindNoteEditor();

  const vp=$('viewport');let drag=null,panFrame=0,pendingPan=null;
  function queuePanTransform(tx,ty){
    pendingPan={tx,ty};if(panFrame)return;
    panFrame=requestAnimationFrame(()=>{
      panFrame=0;if(!pendingPan)return;
      S.tx=pendingPan.tx;S.ty=pendingPan.ty;pendingPan=null;applyTransform();
    });
  }
  vp.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('.card,.sticky,.add-node,button,input,textarea,.edge-hit,.edge-handle,[contenteditable="true"]'))return;
    e.preventDefault();window.getSelection()?.removeAllRanges();
    drag={id:e.pointerId,sx:e.clientX,sy:e.clientY,ox:S.tx,oy:S.ty};
    vp.setPointerCapture(e.pointerId);vp.classList.add('dragging');
  });
  vp.addEventListener('pointermove',e=>{
    if(!drag||drag.id!==e.pointerId)return;
    e.preventDefault();queuePanTransform(drag.ox+e.clientX-drag.sx,drag.oy+e.clientY-drag.sy);
  });
  const stopDrag=()=>{
    drag=null;vp.classList.remove('dragging');
    if(panFrame){cancelAnimationFrame(panFrame);panFrame=0;}
    if(pendingPan){S.tx=pendingPan.tx;S.ty=pendingPan.ty;pendingPan=null;applyTransform();}
  };
  vp.addEventListener('pointerup',stopDrag);vp.addEventListener('pointercancel',stopDrag);
  vp.addEventListener('lostpointercapture',stopDrag);window.addEventListener('blur',stopDrag);
  vp.addEventListener('wheel',e=>{
    if(e.ctrlKey||e.metaKey)return;
    const sticky=e.target.closest('.sticky');
    if(sticky){
      // textarea 内保留浏览器原生滚动；便签标题和内边距也滚动该便签。
      if(e.target.tagName!=='TEXTAREA'){
        const ta=sticky.querySelector('textarea');
        if(ta){e.preventDefault();ta.scrollTop+=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?ta.clientHeight:1);}
      }
      return;
    }
    if(e.target.closest('input,textarea,[contenteditable="true"]'))return;
    e.preventDefault();stopEdgePan();
    const unit=e.deltaMode===1?16:e.deltaMode===2?Math.max(vp.clientHeight,300):1;
    // 滚轮/触摸板双指滑动 = 平移：视图随手势方向移动；Shift+滚轮走横向
    const dx=((e.shiftKey&&!e.deltaX)?e.deltaY:e.deltaX)*unit;
    const dy=(e.shiftKey?0:e.deltaY)*unit;
    if(!dx&&!dy)return;
    queuePanTransform(S.tx-dx,S.ty-dy);
  },{passive:false});
  // 触控板捏合在 Chromium / WebView2 里是带 ctrlKey 的 wheel。捕获阶段处理，避免整页被放大。
  window.addEventListener('wheel',e=>{
    if(!(e.ctrlKey||e.metaKey))return;
    e.preventDefault();
    e.stopPropagation();
    if(e.target.closest&&e.target.closest('#importMask,#noteEditorMask'))return;
    stopEdgePan();
    zoomByWheel(e);
    keepPageScale();
  },{capture:true,passive:false});
  let gestureBase=S.scale;
  window.addEventListener('gesturestart',e=>{e.preventDefault();gestureBase=S.scale;},{passive:false});
  window.addEventListener('gesturechange',e=>{
    e.preventDefault();
    if(!e.scale)return;
    S.scale=gestureBase*e.scale;
    applyTransform();
  },{passive:false});

  /* 悬停画布边缘：驻留片刻后视图自动向该侧滑动；按下鼠标、离开边缘带或操作滚轮即停。 */
  const EDGE_BAND=30,EDGE_DWELL=240;
  let edgeRaf=0,edgeDir=0,edgeTimer=0,edgeSince=0,edgeOver=null;
  const edgeGlow=document.createElement('div');edgeGlow.className='edge-pan-glow';edgeGlow.setAttribute('aria-hidden','true');
  function ensureGlow(){const host=$('viewport');if(edgeGlow.parentElement!==host)host.appendChild(edgeGlow);}
  function stopEdgePan(){
    edgeDir=0;edgeOver=null;
    if(edgeTimer){clearTimeout(edgeTimer);edgeTimer=0;}
    if(edgeRaf){cancelAnimationFrame(edgeRaf);edgeRaf=0;}
    edgeGlow.className='edge-pan-glow';
  }
  function edgeStep(ts){
    edgeRaf=0;
    if(!edgeDir){return;}
    const ramp=Math.min(1,(performance.now()-edgeSince)/1400);
    const speed=3+ramp*11;
    let tx=S.tx,ty=S.ty;
    if(edgeDir===1)tx+=speed;else if(edgeDir===2)tx-=speed;
    else if(edgeDir===3)ty+=speed;else ty-=speed;
    queuePanTransform(tx,ty);
    edgeRaf=requestAnimationFrame(edgeStep);
  }
  function startEdge(dir){
    if(edgeDir===dir)return;
    edgeDir=dir;edgeSince=performance.now();
    edgeGlow.className='edge-pan-glow on '+(['','left','right','top','bottom'][dir]||'');
    if(!edgeRaf)edgeRaf=requestAnimationFrame(edgeStep);
  }
  function edgeTrack(e){
    if(drag||S.openRequest)return;
    if(e.pointerType&&e.pointerType!=='mouse')return;
    const over=e.target.closest('.sticky,input,textarea,button,[contenteditable="true"]');
    if(over){stopEdgePan();return;}
    const r=vp.getBoundingClientRect();
    const x=e.clientX-r.left,y=e.clientY-r.top;
    let dir=0;
    if(x>=0&&y>=0&&x<=r.width&&y<=r.height){
      if(x<EDGE_BAND)dir=1;
      else if(x>=r.width-EDGE_BAND)dir=2;
      else if(y<EDGE_BAND)dir=3;
      else if(y>=r.height-EDGE_BAND)dir=4;
    }
    ensureGlow();
    if(dir){
      if(edgeOver!==dir){
        edgeOver=dir;
        if(edgeTimer)clearTimeout(edgeTimer);
        edgeTimer=setTimeout(()=>{edgeTimer=0;startEdge(edgeOver);},EDGE_DWELL);
      }
    }else stopEdgePan();
  }
  // Edge panning is reserved for explicit dragging; hovering never moves the map.
  // Node/link gestures have their own capture and cancellation lifecycle.
  vp.addEventListener('pointerdown',stopEdgePan);
  vp.addEventListener('pointerleave',stopEdgePan);
  window.addEventListener('blur',stopEdgePan);

  /* 左右面板折叠：收起后留一条玻璃导轨，状态存 localStorage。 */
  $('btnSideCollapse').onclick=()=>setPanel('left',true);
  $('btnDrawerCollapse').onclick=()=>setPanel('right',true);
  $('railSide').onclick=()=>setPanel('left',false);
  $('railDrawer').onclick=()=>setPanel('right',false);

  $('zoomIn').onclick=()=>mapEditor?mapEditor.zoom(1.15):(S.scale*=1.15,applyTransform());
  $('zoomOut').onclick=()=>mapEditor?mapEditor.zoom(1/1.15):(S.scale/=1.15,applyTransform());
  $('btnFit').onclick=()=>mapEditor?.fit();
  $('btnNew').onclick=createNode;
  $('btnNote').onclick=focusNote;
  $('btnUndoDelete').onclick=()=>mapEditor?mapEditor.undo():undoDeleteNode();
  document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||!$('importMask').hidden||!$('noteEditorMask').hidden||e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey){
      if(canvasController&&canvasController.canUndoLocal()){e.preventDefault();undoDeleteNode();}return;
    }
    if(e.key==='Delete'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!$('drawer').hidden&&canDeleteNode(byId(S.sel))){e.preventDefault();deleteNode(S.sel);}
  });
  $('addNode').onclick=()=>$('btnNew').click();
  $('tabReal').onclick=()=>{S.userMode=true;rememberSource('real');useReal()};
  $('tabDemo').onclick=()=>{S.userMode=true;rememberSource('demo');useDemo()};
  $('tabApi').onclick=()=>{S.userMode=true;rememberSource('api');useApi()};
  $('pipeSelect').onchange=function(){S.apiId=this.value;rememberSource('api');loadApiPipeline(this.value)};
  $('sideSearch').oninput=e=>{
    const q=e.target.value.trim().toLowerCase();
    for(const it of document.querySelectorAll('.side-item'))it.hidden=!!q&&it.textContent.toLowerCase().indexOf(q)<0;
  };
  // 工具各自绑定一次：不再覆写已有点击处理。
  window.addEventListener('keydown',e=>{if(e.defaultPrevented||!$('noteEditorMask').hidden)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('sideSearch').focus()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='b'){e.preventDefault();const p=readPanels();setPanel('left',!p.left);}});
  // 探测本地服务：有真实管线就默认展示它
  // 注意时序：父页会在 frame.load 与 setTimeout 兜底时推 pipelineData，
  // 所以这里必须等 API 回来后再把模式定成 api，否则会被覆盖回「当前批次」。
  (async function(){
    const ok=await loadApiPipelines();
    if(ok){
      if(S.userMode)return;
      if(!S.apiPipelines.length){
        $('sideFoot').innerHTML='本地服务已连接 → 没有可用管线<br />点击「＋ 导入」添加管线，或继续查看当前画布';
        return;
      }
      await useApi();
      // 再等一拍，确保父页后续的兜底推送都已到达
      setTimeout(async function(){
        if(S.mode!=='api'&&!S.userMode)await useApi();
      },600);
    }
    else{
      $('pipeSelect').disabled=true;
      $('pipeSelect').innerHTML='<option>本地服务未运行</option>';
      $('sideFoot').innerHTML='本地服务未运行 → 真实管线不可用<br />启动：双击 <span class="mono">start-server.bat</span>';
    }
  })();
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!e.defaultPrevented&&$('noteEditorMask').hidden){try{window.parent.postMessage({type:'pipelineEscape'},location.origin)}catch(_){}}
  });
  window.addEventListener('message',function(e){
    const d=e.data;
    if(!d||typeof d!=='object'||e.source!==window.parent)return;
    // 只接受同源父页（桌面窗口与浏览器版都是同源 iframe）；其它嵌框一律忽略。
    if(e.origin!==location.origin)return;
    if(d.type==='pipelineFullscreen'){document.body.classList.toggle('pipeline-fullscreen',!!d.full);return;}
    if(d.type==='pipelineLoadStatus'&&S.openRequest&&d.requestId===S.openRequest.requestId){
      const button=document.querySelector('[data-open-step="'+S.openRequest.nodeId+'"]');
      if(button){button.textContent=d.state==='loading'?d.text:'⤢ 在结构视图中打开 →';button.disabled=d.state==='loading';}
      if(d.state!=='loading'){S.openRequest=null;renderDrawer();if(d.state==='error')toast(d.text);}
      return;
    }
    // 真实管线模式下不采纳父页推来的导入批次数据：父页在 frame.load 与延迟兜底时
    // 都会再推一次，否则会把已经加载好的真实管线覆盖回「当前批次」。
    // 用户手动切到「当前批次」tab 时走 useReal()，不受此限制。
    if(d.type==='pipelineData'){S.realData=d;if(S.mode==='real'||S.mode==='demo'&&!S.userMode)applyRealData(d);}
    if(d.theme)document.body.classList.toggle('dark',d.theme==='dark');
  });
  if(window.parent!==window){
    try{window.parent.postMessage({type:'pipelineReady'},location.origin)}catch(_){}
  }
  const title=$('routeTitle');if(title)title.textContent=S.mode==='demo'?'Aurora 设计路线':'设计路线';
  window.addEventListener('pagehide',()=>mapEditor?.dispose(),{once:true});
  window.__READY__=true;
}
init();

// CANVAS_RUNTIME_END
}
