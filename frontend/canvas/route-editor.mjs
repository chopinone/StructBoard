import {NODE_W,NODE_H,edgeKey,edgeGeometry,bounds,fitView,zoomAt,arrangeGraph} from './route-geometry.mjs';

export function createRouteEditor(ports) {
  const {state:S}=ports,doc=ports.document||document,win=doc.defaultView||window;
  const viewport=doc.getElementById('viewport'),svg=doc.getElementById('edges');
  const storage=ports.storage||win.localStorage,ns='structboard.routeGeometry.v1.';
  let key='',routes={},selectedEdge=null,gesture=null,raf=0,history=[],knownRevision=null,suppressClickUntil=0;
  const listeners=[];const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));};
  const revision=()=>ports.revision();
  function sync(){const current=ports.key();if(current!==key){key=current;routes={};history=[];selectedEdge=null;knownRevision=revision();try{const saved=JSON.parse(storage.getItem(ns+key)||'{}');for(const [k,p] of Object.entries(saved))if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1e6&&Math.abs(p.y)<=1e6)routes[k]={x:p.x,y:p.y};}catch(_){ports.notice('连线位置读取失败，已显示默认连线');}}}
  function persist(next){try{storage.setItem(ns+key,JSON.stringify(next));routes=next;return true;}catch(_){ports.notice('连线位置未保存，原位置已保留');return false;}}
  function record(item){if(knownRevision!==null&&knownRevision!==revision())history=[];history.push(item);if(history.length>24)history.shift();knownRevision=revision();}
  function bend(edge,point){sync();const previous=structuredClone(routes),next={...routes};if(point)next[edgeKey(edge)]=point;else delete next[edgeKey(edge)];if(persist(next))record({kind:'route',previous});render();}
  function node(id){const n=S.nodes.find(n=>n.id===id);return n&&gesture?.kind==='node'&&gesture.moved&&gesture.at&&gesture.nodeId===id
    ?{...n,x:gesture.before.x+gesture.at.x-gesture.start.x,y:gesture.before.y+gesture.at.y-gesture.start.y}:n;}
  function point(event){const r=viewport.getBoundingClientRect();return {x:(event.clientX-r.left-S.tx)/S.scale,y:(event.clientY-r.top-S.ty)/S.scale};}
  function element(name,attrs){const e=doc.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,String(v));return e;}
  function render(){sync();svg.replaceChildren();const defs=element('defs'),marker=element('marker',{id:'route-arrow',viewBox:'0 0 10 10',refX:15,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(element('path',{d:'M 1 1 L 9 5 L 1 9 z',fill:'#8da2bf'}));defs.append(marker);svg.append(defs);
    if(selectedEdge&&!S.edges.some(e=>edgeKey(e)===edgeKey(selectedEdge)))selectedEdge=null;
    S.edges.forEach((edge,index)=>{const a=node(edge[0]),b=node(edge[1]);if(!a||!b)return;const active=selectedEdge&&edgeKey(edge)===edgeKey(selectedEdge),geometry=edgeGeometry(a,b,routes[edgeKey(edge)]);
      const g=element('g',{'data-edge-index':index,class:active?'route-edge selected':'route-edge'});
      const hit=element('path',{d:geometry.d,class:'edge-hit',tabindex:0,role:'button','aria-label':`${a.title} → ${b.title}`});
      const line=element('path',{d:geometry.d,class:'edge-path','marker-end':'url(#route-arrow)'});g.append(hit,line);
      if(active)for(const [handle,p] of [['bend',geometry.point],['source',{x:geometry.from.x+24,y:geometry.from.y}],['target',{x:geometry.to.x-24,y:geometry.to.y}]])g.append(element('circle',{cx:p.x,cy:p.y,r:handle==='bend'?7:6,class:'edge-handle '+handle,'data-edge-handle':handle,tabindex:0,role:'button','aria-label':handle==='bend'?'拖动调整连线弯折':handle==='source'?'拖动更换起点':'拖动更换终点'}));
      svg.append(g);
    });
    const tools=doc.getElementById('edgeTools');if(tools)tools.hidden=!selectedEdge;
    const label=doc.getElementById('edgeSelectionLabel');if(label)label.textContent=selectedEdge?'已选连线':'';
    if(gesture?.kind==='connect'||gesture?.kind==='reconnect'){
      const from=gesture.from,at=gesture.at||from;
      svg.append(element('path',{class:'edge-preview',d:`M ${from.x} ${from.y} C ${from.x+64} ${from.y} ${at.x-64} ${at.y} ${at.x} ${at.y}`}));
    }
    minimap();ports.status?.();
  }
  function minimap(){const map=doc.getElementById('routeMinimap');if(!map)return;const b=bounds(S.nodes),pad=50;map.setAttribute('viewBox',`${b.x-pad} ${b.y-pad} ${b.width+pad*2} ${b.height+pad*2}`);map.replaceChildren();
    for(const [aId,bId] of S.edges){const a=node(aId),n=node(bId);if(a&&n)map.append(element('path',{d:edgeGeometry(a,n).d,class:'mini-edge'}));}
    for(const n of S.nodes)map.append(element('rect',{x:n.x,y:n.y,width:NODE_W,height:NODE_H,rx:18,class:n.id===S.sel?'mini-node selected':'mini-node'}));
    map.append(element('rect',{x:-S.tx/S.scale,y:-S.ty/S.scale,width:viewport.clientWidth/S.scale,height:viewport.clientHeight/S.scale,class:'mini-viewport',rx:8}));
  }
  function transform(){doc.getElementById('world').dataset.zoom=S.scale<.78?'overview':S.scale>1.05?'detail':'normal';minimap();}
  function fit(){Object.assign(S,fitView(S.nodes,viewport.clientWidth,viewport.clientHeight));ports.transform();}
  function zoom(factor,screen){const r=viewport.getBoundingClientRect();Object.assign(S,zoomAt(S,S.scale*factor,screen||{x:r.width/2,y:r.height/2}));ports.transform();}
  function commitGraph(ops){const result=ports.commit(ops);return !!result?.ok;}
  function graphCommitted(){sync();history.push({kind:'graph',previous:structuredClone(routes)});if(history.length>24)history.shift();knownRevision=revision();}
  function undo(){sync();if(knownRevision!==revision()){history=[];knownRevision=revision();}const item=history.at(-1);
    if(item?.kind==='route'){if(persist(item.previous))history.pop();render();return;}
    const result=ports.undo();if(result?.ok){if(item)history.pop();if(item?.previous)persist(item.previous);knownRevision=revision();ports.redraw();render();}
  }
  function arrange(){sync();const positions=arrangeGraph(S.nodes,S.edges);if(!positions.length)return;
    if(positions.length>128){ports.notice('一次自动整理最多 128 个步骤，请分批调整更大的画布');return;}
    if(commitGraph(positions.map(n=>({op:'node.move',id:n.id,x:n.x,y:n.y})))){persist({});ports.redraw();render();fit();ports.notice('已按连线整理，可撤销');}
  }
  function capture(event,data){gesture={...data,canvasKey:key,revision:revision(),pointer:event.pointerId,start:point(event),client:{x:event.clientX,y:event.clientY}};viewport.setPointerCapture(event.pointerId);viewport.classList.add('is-route-editing');event.preventDefault();event.stopPropagation();}
  function down(event){if(event.button!==0)return;suppressClickUntil=0;sync();const target=event.target;
    const edgeGroup=target.closest('[data-edge-index]');if(edgeGroup){const edge=S.edges[Number(edgeGroup.dataset.edgeIndex)];if(!edge)return;selectedEdge=edge.slice();const handle=target.dataset.edgeHandle;
      if(handle==='bend'){capture(event,{kind:'bend',edge:edge.slice(),before:routes[edgeKey(edge)],at:point(event)});}
      else if(handle==='source'||handle==='target'){const fixed=node(handle==='source'?edge[1]:edge[0]);capture(event,{kind:'reconnect',edge:edge.slice(),end:handle,from:handle==='source'?{x:fixed.x,y:fixed.y+NODE_H/2}:{x:fixed.x+NODE_W,y:fixed.y+NODE_H/2}});}
      event.stopPropagation();render();return;
    }
    const port=target.closest('[data-port]');if(port){const n=node(port.closest('.node').dataset.nodeId);if(!n)return;capture(event,{kind:'connect',nodeId:n.id,end:port.dataset.port,from:{x:n.x+(port.dataset.port==='out'?NODE_W:0),y:n.y+NODE_H/2}});render();return;}
    if(target.closest('button,input,textarea,[contenteditable=true],.sticky'))return;
    const card=target.closest('.card');if(card){const n=node(card.closest('.node').dataset.nodeId);if(n)capture(event,{kind:'node',nodeId:n.id,before:{x:n.x,y:n.y}});}
    else {selectedEdge=null;render();}
  }
  function paintGesture(){raf=0;if(!gesture)return;const at=gesture.at;if(!at)return;
    if(gesture.kind==='node'){const n=node(gesture.nodeId);if(n){const element=doc.querySelector(`#nodes [data-node-id="${n.id}"]`);if(element){element.style.left=n.x+'px';element.style.top=n.y+'px';}render();}}
    else if(gesture.kind==='bend'){routes[edgeKey(gesture.edge)]=at;render();}else render();
  }
  function move(event){if(!gesture||event.pointerId!==gesture.pointer)return;gesture.at=point(event);gesture.moved=gesture.moved||Math.hypot(event.clientX-gesture.client.x,event.clientY-gesture.client.y)>5;if(!gesture.moved)return;event.preventDefault();if(!raf)raf=win.requestAnimationFrame(paintGesture);}
  function finish(event,cancel=false){if(!gesture||(event.pointerId!==undefined&&event.pointerId!==gesture.pointer))return;if(raf){win.cancelAnimationFrame(raf);raf=0;paintGesture();}const g=gesture;gesture=null;viewport.classList.remove('is-route-editing');try{viewport.releasePointerCapture(g.pointer);}catch(_){}
    if(g.canvasKey!==ports.key()||g.revision!==revision()){cancel=true;ports.notice('画布已有新修改，本次拖动已取消');}
    if(g.moved)suppressClickUntil=Date.now()+300;
    if(g.kind==='node'){const n=node(g.nodeId);if(n){if(!cancel&&g.moved)commitGraph([{op:'node.move',id:n.id,x:g.before.x+g.at.x-g.start.x,y:g.before.y+g.at.y-g.start.y}]);ports.redraw();}}
    if(g.kind==='bend'){if(g.before)routes[edgeKey(g.edge)]=g.before;else delete routes[edgeKey(g.edge)];if(!cancel&&g.moved)bend(g.edge,g.at);}
    if(!cancel&&(g.kind==='connect'||g.kind==='reconnect')){const hit=doc.elementFromPoint(event.clientX,event.clientY),dest=hit?.closest('[data-port]');const targetId=dest?.closest('.node')?.dataset.nodeId;
      if(targetId){const from=g.kind==='connect'?(g.end==='out'?g.nodeId:targetId):(g.end==='source'?targetId:g.edge[0]);const to=g.kind==='connect'?(g.end==='out'?targetId:g.nodeId):(g.end==='target'?targetId:g.edge[1]);
        if(from!==to){if(S.edges.some(e=>e[0]===from&&e[1]===to)){ports.notice('这两个步骤已有连线');}else {const ops=g.kind==='reconnect'?[{op:'edge.disconnect',from:g.edge[0],to:g.edge[1]}]:[];ops.push({op:'edge.connect',from,to});if(commitGraph(ops))selectedEdge=[from,to];}}
      }
    }
    render();
  }
  listen(viewport,'pointerdown',down,true);listen(win,'pointermove',move);listen(win,'pointerup',event=>finish(event));listen(win,'pointercancel',event=>finish(event,true));listen(win,'blur',()=>finish({},true));
  listen(viewport,'click',event=>{if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  listen(svg,'click',event=>{const g=event.target.closest('[data-edge-index]');if(g){selectedEdge=S.edges[Number(g.dataset.edgeIndex)]?.slice();render();event.stopPropagation();}});
  listen(doc,'keydown',event=>{if(event.target.closest('input,textarea,select,[contenteditable=true]')||!doc.getElementById('importMask').hidden||!doc.getElementById('noteEditorMask').hidden)return;
    if(event.key==='Escape'){if(gesture||selectedEdge){event.preventDefault();event.stopImmediatePropagation();}finish({},true);selectedEdge=null;render();}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.stopImmediatePropagation();undo();}
    if(selectedEdge&&(event.key==='Delete'||event.key==='Backspace')){event.preventDefault();event.stopImmediatePropagation();removeEdge();}
  },true);
  function removeEdge(){if(selectedEdge){commitGraph([{op:'edge.disconnect',from:selectedEdge[0],to:selectedEdge[1]}]);selectedEdge=null;render();}}
  const bind=(id,fn)=>{const e=doc.getElementById(id);if(e)listen(e,'click',fn);};bind('btnArrange',arrange);bind('btnEdgeRemove',removeEdge);bind('btnEdgeReset',()=>selectedEdge&&bend(selectedEdge,null));
  const map=doc.getElementById('routeMinimap');if(map)listen(map,'pointerdown',event=>{const matrix=map.getScreenCTM();if(!matrix)return;const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());S.tx=viewport.clientWidth/2-p.x*S.scale;S.ty=viewport.clientHeight/2-p.y*S.scale;ports.transform();event.preventDefault();});
  return {render,transform,fit,zoom,arrange,undo,graphCommitted,get canUndo(){return history.length>0||ports.canUndo();},dispose(){if(raf)win.cancelAnimationFrame(raf);finish({},true);listeners.forEach(fn=>fn());}};
}
