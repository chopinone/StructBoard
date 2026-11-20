export const NODE_W = 260, NODE_H = 166;
export const edgeKey = edge => JSON.stringify(edge);
export function bounds(nodes) {
  if (!nodes.length) return {x:0,y:0,width:NODE_W,height:NODE_H};
  const x=Math.min(...nodes.map(n=>n.x)),y=Math.min(...nodes.map(n=>n.y));
  return {x,y,width:Math.max(...nodes.map(n=>n.x+NODE_W))-x,height:Math.max(...nodes.map(n=>n.y+NODE_H))-y};
}
export function fitView(nodes,width,height) {
  const b=bounds(nodes),scale=Math.max(.22,Math.min(1,(width-112)/b.width,(height-160)/b.height));
  return {scale,tx:(width-b.width*scale)/2-b.x*scale,ty:(height-b.height*scale)/2-b.y*scale-14};
}
export function zoomAt(view,scale,point) {
  scale=Math.max(.22,Math.min(2.6,scale));
  return {scale,tx:point.x-(point.x-view.tx)/view.scale*scale,ty:point.y-(point.y-view.ty)/view.scale*scale};
}
export function edgeGeometry(a,b,bend) {
  const from={x:a.x+NODE_W,y:a.y+NODE_H/2},to={x:b.x,y:b.y+NODE_H/2};
  const point=bend||{x:(from.x+to.x)/2,y:(from.y+to.y)/2};
  const length=Math.max(48,Math.min(180,Math.abs(to.x-from.x)*.45));
  const d=bend
    ?`M ${from.x} ${from.y} C ${from.x+length} ${from.y} ${point.x-48} ${point.y} ${point.x} ${point.y} S ${to.x-length} ${to.y} ${to.x} ${to.y}`
    :`M ${from.x} ${from.y} C ${from.x+length} ${from.y} ${to.x-length} ${to.y} ${to.x} ${to.y}`;
  return {d,from,to,point};
}

// Condense cycles, then arrange the DAG in columns. Stable IDs/order make layout
// deterministic; disconnected routes remain legible and every node appears once.
export function arrangeGraph(nodes,edges) {
  const ids=nodes.map(n=>n.id),valid=new Set(ids),next=new Map(ids.map(id=>[id,[]]));
  for(const [a,b] of edges)if(valid.has(a)&&valid.has(b)&&a!==b)next.get(a).push(b);
  let serial=0;const stack=[],onStack=new Set(),index=new Map(),low=new Map(),components=[];
  function visit(id){index.set(id,serial);low.set(id,serial++);stack.push(id);onStack.add(id);
    for(const child of next.get(id)){if(!index.has(child)){visit(child);low.set(id,Math.min(low.get(id),low.get(child)));}else if(onStack.has(child))low.set(id,Math.min(low.get(id),index.get(child)));}
    if(low.get(id)===index.get(id)){const group=[];let item;do{item=stack.pop();onStack.delete(item);group.push(item);}while(item!==id);components.push(group.reverse());}
  }
  ids.forEach(id=>{if(!index.has(id))visit(id);});
  const owner=new Map();components.forEach((c,i)=>c.forEach(id=>owner.set(id,i)));
  const links=components.map(()=>new Set()),indegree=components.map(()=>0),rank=components.map(()=>0);
  for(const [a,children] of next)for(const b of children){const x=owner.get(a),y=owner.get(b);if(x!==y&&!links[x].has(y)){links[x].add(y);indegree[y]++;}}
  const ready=indegree.flatMap((n,i)=>n?[]:[i]);
  while(ready.length){const i=ready.shift();for(const j of links[i]){rank[j]=Math.max(rank[j],rank[i]+1);if(!--indegree[j])ready.push(j);}}
  const columns=new Map();for(const id of ids){const r=rank[owner.get(id)];if(!columns.has(r))columns.set(r,[]);columns.get(r).push(id);}
  const placed=new Map();for(const [r,column] of columns)column.forEach((id,row)=>placed.set(id,{id,x:64+r*360,y:72+row*238}));
  return ids.map(id=>placed.get(id));
}
