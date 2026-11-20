'use strict';

// Run: node tools/test_pipeline_assist.js
// Extracts the real stripJsonFence / summarizeDefinitionForConfirm from app.js.
// These gate what the user sees before confirming an AI-generated pipeline import.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

function extract(name) {
  const match = source.match(new RegExp('^ {2}function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^ {2}\\}', 'm'));
  assert(match, 'Missing function in app.js: ' + name);
  return match[0];
}
const context = vm.createContext({ Object, Array, String, Number });
vm.runInContext(extract('stripJsonFence') + '\n' + extract('summarizeDefinitionForConfirm') +
  '\nglobalThis.api = { stripJsonFence, summarizeDefinitionForConfirm };', context);
const { stripJsonFence, summarizeDefinitionForConfirm } = context.api;
const same = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// 1. Fence stripping handles the shapes AI tools actually emit.
{
  assert.equal(stripJsonFence('{"id":"a"}'), '{"id":"a"}', 'plain JSON passes through');
  assert.equal(stripJsonFence('```json\n{"id":"a"}\n```'), '{"id":"a"}');
  assert.equal(stripJsonFence('```\n{"id":"a"}\n```'), '{"id":"a"}', 'fence without language tag');
  assert.equal(stripJsonFence('好的，这是定义：\n```json\n{"id":"a"}\n```\n希望有帮助'), '{"id":"a"}',
    'prose around the fence is dropped');
  assert.equal(stripJsonFence('前缀说明 {"id":"a"} 后缀'), '{"id":"a"}',
    'no fence: first { to last } is taken');
  assert.equal(stripJsonFence(''), '');
  assert.equal(stripJsonFence(null), '');
  // Nested braces survive.
  assert.equal(stripJsonFence('x {"steps":[{"id":"s1"}]} y'), '{"steps":[{"id":"s1"}]}');
}

// 2. Confirm summary: valid definition with globs and files.
{
  const res = summarizeDefinitionForConfirm({
    id: 'my_design', name: '我的设计流程', root: 'D:/data',
    steps: [
      { id: 's1', title: '输入', globs: ['input/*.pdb'] },
      { id: 's2', title: '预测', globs: ['a', 'b', 'c'] },
      { id: 's3', title: '对照', files: [{ path: 'final/1.cif' }, { path: 'final/2.cif' }] },
    ],
  });
  assert.equal(res.ok, true);
  same(res.summary, {
    id: 'my_design', name: '我的设计流程', root: 'D:/data',
    stepCount: 3, totalRules: 6,
    lines: [
      { title: '输入', match: '1 个通配符' },
      { title: '预测', match: '3 个通配符' },
      { title: '对照', match: '2 个文件' },
    ],
  });
}

// 3. Missing matches are named, not hidden; title falls back to id.
{
  const res = summarizeDefinitionForConfirm({ steps: [{ id: 's1' }] });
  assert.equal(res.ok, true);
  assert.equal(res.summary.lines[0].match, '没有匹配规则');
  assert.equal(res.summary.lines[0].title, 's1');
  assert.equal(res.summary.root, '');
}

// 4. Malformed shapes fail with actionable errors.
same(summarizeDefinitionForConfirm(null), { ok: false, error: 'JSON 顶层必须是对象' });
same(summarizeDefinitionForConfirm([1]), { ok: false, error: 'JSON 顶层必须是对象' });
same(summarizeDefinitionForConfirm({}), { ok: false, error: 'steps 必须是非空数组' });
same(summarizeDefinitionForConfirm({ steps: [] }), { ok: false, error: 'steps 必须是非空数组' });
same(summarizeDefinitionForConfirm({ steps: ['x'] }), { ok: false, error: 'steps 里每一项都必须是对象' });

// 5. Long pipelines cap the preview at 8 lines but keep the true count.
{
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, title: '步骤' + i, globs: ['*.pdb'] }));
  const res = summarizeDefinitionForConfirm({ id: 'big', steps });
  assert.equal(res.ok, true);
  assert.equal(res.summary.lines.length, 8, 'preview capped');
  assert.equal(res.summary.stepCount, 12, 'real count preserved');
  assert.equal(res.summary.totalRules, 12);
}

console.log('pipeline assist ok (fence stripping, confirm summary, error shapes, preview cap)');
