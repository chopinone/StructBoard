'use strict';

// Run: node tools/test_pipeline_merge.js
// Executes the real mergePipelineSteps() from app.js against fixture definitions.
// The rule under test: saving display-layer edits must never rewrite scientific
// history. A step already on disk keeps files[]/lineage byte-for-byte; only the
// display fields and organization may change.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

const match = source.match(/^ {2}function mergePipelineSteps\([^)]*\) \{[\s\S]*?^ {2}\}/m);
assert(match, 'Missing mergePipelineSteps in app.js');

const context = vm.createContext({ Object, Map, Set, String, Boolean, Array, JSON, console });
vm.runInContext(match[0] + '\nglobalThis.merge = mergePipelineSteps;', context);
const merge = context.merge;
// Objects come back from another vm realm, so compare by JSON value, not prototype.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

function entry(name, extra) {
  return Object.assign({
    name: name,
    path: 'D:/root/' + name,
    fullPath: 'D:/root/' + name,
    star: false,
    stepKey: 'pipe:s1',
  }, extra || {});
}

const definition = {
  id: 'pipe',
  root: 'D:/root',
  steps: [
    {
      id: 's1',
      title: '原步骤一',
      tool: 'boltz',
      globs: ['*.cif'],
      files: [{ name: 'a.cif', path: 'a.cif', star: true }],
      lineage: { runId: 'RUN-1' },
      organization: { folders: [{ id: 'f1' }] },
    },
    {
      id: 'step-derived',
      title: '优选候选',
      files: [{ name: 'a.cif', path: 'a.cif' }, { name: 'b.cif', path: 'b.cif' }, { name: 'gone.cif', path: 'gone.cif' }],
      organization: { notes: { old: 'keep me' } },
    },
  ],
};

const snapshot = () => JSON.parse(JSON.stringify(definition));

// 1. Display-only edit on an existing step keeps science untouched.
{
  const ordered = [{ key: 'pipe:s1', title: '改过的标题', tool: 'newtool', entries: [] }];
  const merged = merge(snapshot(), ordered, { 'pipe:s1': { title: '改过的标题', tool: 'newtool' } }, {});
  const step = merged.steps.find(s => s.id === 's1');
  assert.equal(step.title, '改过的标题');
  assert.equal(step.tool, 'newtool');
  same(step.files, definition.steps[0].files, 'files must survive a rename');
  same(step.lineage, definition.steps[0].lineage, 'lineage must survive a rename');
  same(step.globs, definition.steps[0].globs, 'globs must survive a rename');
  same(step.organization, definition.steps[0].organization, 'organization survives when no attach helper');
}

// 2. Re-saving an existing custom/derived step must not shrink its files to what
//    happens to be visible in memory right now.
{
  const ordered = [{
    key: 'step-derived', title: '优选候选', tool: '', custom: true, pipelineId: 'pipe',
    entries: [entry('a.cif', { stepKey: 'pipe:derived' }), entry('b.cif', { stepKey: 'pipe:derived' })],
  }];
  const merged = merge(snapshot(), ordered, {}, {});
  const step = merged.steps.find(s => s.id === 'step-derived');
  same(step.files, definition.steps[1].files,
    'a previously saved step must keep every member, including ones not loaded now');
  assert.equal(step.files.length, 3, 'gone.cif must not be dropped');
  same(step.organization, definition.steps[1].organization);
}

// 3. A brand-new custom step does get its files from its members — once.
{
  const ordered = [{
    key: 'step-fresh', title: '新步骤', tool: 'x', custom: true, pipelineId: 'pipe',
    entries: [
      entry('a.cif', { stepKey: 'step-fresh' }),
      entry('b.cif', { stepKey: 'step-fresh', star: true }),
    ],
  }];
  const merged = merge(snapshot(), ordered, {}, {});
  const step = merged.steps.find(s => s.id === 'step-fresh');
  same(step.files, [
    { name: 'a.cif', path: 'a.cif', star: false },
    { name: 'b.cif', path: 'b.cif', star: true },
  ]);
  assert.equal(step.state, 'done');
}

// 4. Trashed members are never written into a brand-new step's members.
{
  const trashed = new Set(['D:/root/gone.cif']);
  const ordered = [{
    key: 'step-fresh2', title: '新步骤', custom: true, pipelineId: 'pipe',
    entries: [
      entry('a.cif', { stepKey: 'step-fresh2' }),
      entry('gone.cif', { stepKey: 'step-fresh2' }),
    ],
  }];
  const merged = merge(snapshot(), ordered, {}, { isTrashed: e => trashed.has(e.fullPath) });
  const step = merged.steps.find(s => s.id === 'step-fresh2');
  same(step.files.map(f => f.name), ['a.cif'], 'trashed members stay out');
}

// 5. Members outside the pipeline root are not invented as relative paths.
{
  const ordered = [{
    key: 'step-outside', title: '外部', custom: true, pipelineId: 'pipe',
    entries: [entry('x.cif', { fullPath: 'E:/elsewhere/x.cif', stepKey: 'step-outside' })],
  }];
  const merged = merge(snapshot(), ordered, {}, {});
  const step = merged.steps.find(s => s.id === 'step-outside');
  same(step.files, [], 'paths outside the root are not fabricate-able');
}

// 6. Steps not loaded in this session survive untouched.
{
  const ordered = [{ key: 'pipe:s1', title: '原步骤一', entries: [] }];
  const merged = merge(snapshot(), ordered, {}, {});
  same(merged.steps.find(s => s.id === 'step-derived'), definition.steps[1],
    'an unloaded step is passed through verbatim');
}

// 7. A deleted step is dropped — unless it would leave nothing behind.
{
  const both = merge(snapshot(), [{ key: 'pipe:s1', entries: [] }], { 'step-derived': { deleted: true } }, {});
  assert.equal(both.steps.some(s => s.id === 'step-derived'), false, 'deleted step is removed');

  // Deleting everything must never produce an empty pipeline: the last one survives.
  const only = merge(snapshot(), [], { 'pipe:s1': { deleted: true }, 'step-derived': { deleted: true } }, {});
  assert.equal(only.steps.length, 1, 'a pipeline is never saved empty');
  assert.equal(only.steps[0].id, 's1', 'the surviving step keeps its on-disk id and members');
  same(only.steps[0].files, definition.steps[0].files, 'and its science');
}

// 8. A step reordered among others keeps its own science.
{
  const ordered = [
    { key: 'step-derived', title: '优选候选', custom: true, pipelineId: 'pipe', entries: [] },
    { key: 'pipe:s1', title: '原步骤一', entries: [] },
  ];
  const merged = merge(snapshot(), ordered, {}, {});
  same(merged.steps.map(s => s.id), ['step-derived', 's1'], 'order follows the interface');
  assert.deepEqual(merged.steps[0].files, definition.steps[1].files);
  assert.deepEqual(merged.steps[1].files, definition.steps[0].files);
}

// 9. The attach helper writes organization but is never allowed to touch files.
{
  const calls = [];
  const ordered = [{ key: 'pipe:s1', entries: [entry('a.cif')] }];
  const merged = merge(snapshot(), ordered, {}, {
    attach(step, key, entries) {
      calls.push(key);
      step.organization = { tags: ['edited'] };
      step.title = step.title; // display field, fine
    },
  });
  const step = merged.steps.find(s => s.id === 's1');
  same(calls, ['pipe:s1']);
  same(step.files, definition.steps[0].files, 'attach must not affect members');
  same(step.organization, { tags: ['edited'] });
}

// 10. The input definition is never mutated in place.
{
  const before = snapshot();
  merge(before, [{ key: 'pipe:s1', title: 'T', entries: [] }], { 'pipe:s1': { title: 'T' } }, {});
  same(before, definition, 'merge returns a new definition');
}

console.log('pipeline merge ok (science preserved, new steps written once, deletes never empty a pipeline)');
