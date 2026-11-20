import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangeGraph,fitView,zoomAt,edgeGeometry,NODE_W,NODE_H} from '../canvas/route-geometry.mjs';
test('auto-arrange separates branches, disconnected nodes and cycles deterministically',()=>{
  const nodes=['a','b','c','d','e','f'].map(id=>({id,x:0,y:0}));
  const edges=[['a','b'],['a','c'],['b','d'],['c','d'],['e','f'],['f','e']];
  const layout=arrangeGraph(nodes,edges),by=new Map(layout.map(n=>[n.id,n]));
  assert.equal(layout.length,nodes.length);assert.deepEqual(arrangeGraph(nodes,edges),layout);
  assert(by.get('d').x>by.get('b').x);assert(by.get('b').x>by.get('a').x);
  for(const a of layout)for(const b of layout)if(a.id!==b.id)assert(Math.abs(a.x-b.x)>=NODE_W||Math.abs(a.y-b.y)>=NODE_H);
  assert(nodes.every(n=>n.x===0&&n.y===0),'layout does not mutate source');
});
test('fit handles negative coordinates and zoom preserves the cursor anchor',()=>{
  const nodes=[{x:-500,y:-200},{x:300,y:200}];const view=fitView(nodes,1400,900);
  for(const n of nodes){assert(n.x*view.scale+view.tx>=0);assert((n.x+NODE_W)*view.scale+view.tx<=1400);assert(n.y*view.scale+view.ty>=0);assert((n.y+NODE_H)*view.scale+view.ty<=900);}
  const p={x:170,y:240},next=zoomAt(view,1.5,p);
  assert(Math.abs((p.x-view.tx)/view.scale-(p.x-next.tx)/next.scale)<1e-8);
  assert(Math.abs((p.y-view.ty)/view.scale-(p.y-next.ty)/next.scale)<1e-8);
});
test('manual bend remains on the path and endpoints follow moved nodes',()=>{
  const a={x:0,y:0},b={x:400,y:250},bend={x:350,y:-50};
  const edge=edgeGeometry(a,b,bend);assert.deepEqual(edge.point,bend);assert(edge.d.includes('350 -50'));
  assert.equal(edge.from.x,NODE_W);assert.equal(edge.to.y,250+NODE_H/2);
  assert.notEqual(edgeGeometry({...a,x:30},b,bend).d,edge.d);
});
