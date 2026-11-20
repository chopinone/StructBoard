import test from 'node:test';
import assert from 'node:assert/strict';
import { stepNavigationRows } from '../domain/step-navigation.mjs';
test('sidebar snapshots contain only lightweight display fields',()=>{
  const entries=[{star:true,coordinates:new Float32Array(30000),parsed:{atoms:[1,2]}}];
  const rows=stepNavigationRows([{key:'p:s',title:'Synthetic step',displayIndex:2,tool:'Demo',entries}],[],list=>list.length+' 个结构');
  assert.deepEqual(Object.keys(rows[0]).sort(),['index','key','plain','summary','title','tool']);
  assert.equal(rows[0].summary,'1 个结构 · 优选标记 1');assert(Object.isFrozen(rows[0]));
  entries[0].star=false;assert.match(rows[0].summary,/优选标记 1/);
  assert.equal(stepNavigationRows([],entries,()=>'' )[0].key,'plain');
});
