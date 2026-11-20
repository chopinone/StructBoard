'use strict';

// Run: node tools/test_search_filter.js
// Extracts the real nodeMatches/filteredNodes sources from overview.js and checks
// the in-layer search semantics: entry/folder/metric matching, section blocks kept
// whole when the step title matches, hidden otherwise; same-realm value compare.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../overview.js'), 'utf8');

function extract(name) {
  const match = source.match(new RegExp('^ {6}function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^ {6}\\}', 'm'));
  assert(match, 'Missing function in overview.js: ' + name);
  return match[0];
}

let query = '';
const context = vm.createContext({
  queryText: () => query,
  Object, Array, String, Boolean,
});
vm.runInContext(extract('nodeMatches') + '\n' + extract('filteredNodes') + '\n' + extract('splitHighlight') +
  '\nglobalThis.api = { nodeMatches, filteredNodes, splitHighlight };', context);
const { nodeMatches, filteredNodes, splitHighlight } = context.api;
const same = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

function entryNode(name, extra) {
  return { kind: 'entry', entry: Object.assign({ name, path: 'D:/root/' + name }, extra || {}) };
}
function folderNode(name, members) {
  return { kind: 'folder', name, entries: members.map(n => n.entry) };
}

// 1. Entries match on name, path, lineage meta and metric values.
{
  const node = entryNode('SYNTH_demo_alpha_T01_id2_model_0.cif',
    { fullPath: 'D:/root/SYNTH_demo_alpha_T01_id2_model_0.cif', metrics: { iptm: 0.625 } });
  assert.equal(nodeMatches(node, 'demo_alpha'), true);
  assert.equal(nodeMatches(node, 'MODEL_0'), true, 'matching is case-insensitive');
  assert.equal(nodeMatches(node, '0.625'), true, 'metric values are searchable');
  assert.equal(nodeMatches(node, 'nomatch'), false);
}

// 2. Folders match through their members.
{
  const folder = folderNode('新文件夹', [entryNode('design_demo_beta.pdb')]);
  assert.equal(nodeMatches(folder, 'demo_beta'), true, 'folder is found via a member name');
  assert.equal(nodeMatches(folder, '新文件夹'), true);
  assert.equal(nodeMatches(folder, 'zzz'), false);
}

// 3. Section layout: title match keeps the whole block; card match keeps the
//    section header plus only matched cards; no match hides the whole block.
{
  const nodes = [
    { kind: 'section', id: 'sec:1', stepKey: 'p:s1', title: '第一步', index: 1 },
    entryNode('alpha_model_0.cif'),
    entryNode('alpha_model_1.cif'),
    entryNode('beta_model_0.cif'),
    { kind: 'section', id: 'sec:2', stepKey: 'p:s2', title: '第二步', index: 2 },
    entryNode('gamma_model_0.cif'),
  ];
  query = '第一步';
  same(filteredNodes(nodes).map(n => n.title || n.entry.name),
    ['第一步', 'alpha_model_0.cif', 'alpha_model_1.cif', 'beta_model_0.cif'],
    'a step-title match keeps every card of that step');
  query = 'alpha_model_1';
  same(filteredNodes(nodes).map(n => n.title || n.entry.name),
    ['第一步', 'alpha_model_1.cif'],
    'a card match keeps its own section header plus matched cards only');
  query = 'gamma';
  same(filteredNodes(nodes).map(n => n.title || n.entry.name),
    ['第二步', 'gamma_model_0.cif']);
  query = 'zzz';
  same(filteredNodes(nodes), [], 'nothing matches -> nothing is shown');
}

// 4. Folder drill view (no sections): plain filtering.
{
  const nodes = [folderNode('夹A', [entryNode('one.pdb')]), entryNode('two.pdb')];
  query = 'one';
  same(filteredNodes(nodes).map(n => n.name || n.entry.name), ['夹A']);
  query = 'two';
  same(filteredNodes(nodes).map(n => n.name || n.entry.name), ['two.pdb']);
}

// 5. Empty query is a passthrough reference, not a copy.
{
  query = '';
  const nodes = [entryNode('a.pdb')];
  assert.equal(filteredNodes(nodes), nodes, 'no query must not rebuild the array');
}

// 6. Highlight segmentation for card names.
{
  same(splitHighlight('SYNTH_demo_alpha_model_0.cif', 'demo_alpha'),
    [{ text: 'SYNTH_', hit: false }, { text: 'demo_alpha', hit: true }, { text: '_model_0.cif', hit: false }]);
  same(splitHighlight('aa', 'a'),
    [{ text: 'a', hit: true }, { text: 'a', hit: true }], 'repeated hits');
  same(splitHighlight('abc', 'AB'),
    [{ text: 'ab', hit: true }, { text: 'c', hit: false }], 'matching is case-insensitive');
  same(splitHighlight('abc', ''), [{ text: 'abc', hit: false }], 'empty query yields plain text');
  same(splitHighlight('abc', 'xyz'), [{ text: 'abc', hit: false }], 'no hit yields plain text');
  same(splitHighlight('', 'x'), [], 'empty text yields nothing');
}

console.log('search filter ok (entry/folder/metric matching, section keep-or-shrink, drill view, passthrough)');
