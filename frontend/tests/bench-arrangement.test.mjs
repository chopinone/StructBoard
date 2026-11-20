import test from 'node:test';
import assert from 'node:assert/strict';
import { benchGroups, benchPageGroups, benchLeaves } from '../domain/bench-arrangement.mjs';
const entry=(id,candidateId,stepKey='p:s')=>({id,stepKey,lineage:{candidateId,candidateName:candidateId}});
test('arrangement preserves interleaved comparison members and does not merge steps',()=>{
  const entries=[entry('a1','A'),entry('b1','B'),entry('a2','A'),entry('b2','B'),entry('elsewhere','A','p:other')];
  const original=structuredClone(entries),groups=benchGroups(entries);
  assert.equal(groups.groups.length,3);assert(groups.available);
  const layout=benchPageGroups(entries.slice(1,4),groups,2);
  assert.deepEqual(layout.chunks.flatMap(g=>g.entries.map(e=>e.id)).sort(),['a2','b1','b2']);
  assert.deepEqual(entries,original);assert.equal(layout.chunks.find(g=>g.name==='A').total,2);
  const occupied=new Set();for(const chunk of layout.chunks)for(let i=0;i<chunk.entries.length;i++){
    const slot=chunk.row+':'+(chunk.column+i);assert(!occupied.has(slot));occupied.add(slot);assert(chunk.column+i<=2);
  }
});
test('nested folders flatten to all distinct structures, including user subfolders',()=>{
  const a=entry('a','A'),b=entry('b','A'),c=entry('c','B');
  const nodes=[{kind:'folder',children:[{kind:'entry',entry:a},{kind:'folder',entries:[b]}]},
    {kind:'folder',entries:[a,c]},{kind:'entry',entry:c}];
  assert.deepEqual(benchLeaves(nodes),[a,b,c]);
});
test('parent labels follow metadata and one candidate offers no redundant switch',()=>{
  const a=entry('a','A'),b=entry('b','B');
  assert(!benchGroups([a,entry('a2','A')]).available);
  for(const e of [a,b]){e.groupKind='parent';e.lineage.parentId=e.id+'-parent';}
  assert.equal(benchGroups([a,b]).label,'按母本排列');assert(benchGroups([a,b]).available);
  assert(!benchGroups([{id:'x'},{id:'y'}]).available);
  assert.deepEqual(benchLeaves([]),[]);
});
