const lineage = require('../lineage.js');
const org = require('../workspace_org.js');

function entry(id, parent, extra) {
  return Object.assign({
    id: id, name: id, sourceKey: 'k-' + id, stepKey: 'p:mpnn',
    lineage: { parentId: parent, parentName: parent, candidateId: id, role: 'variant', artifactKind: 'mpnn_backbone' },
    group: parent, groupKind: 'parent', groupKey: 'p|mpnn|parent|' + parent,
  }, extra || {});
}
const entries = [];
['Aurora_001', 'Aurora_002'].forEach(function (p) {
  for (let i = 1; i <= 2; i++) entries.push(entry(p + '_' + i, p));
});
const store = {};
const nodes0 = org.apply(lineage.nodes(entries, true), entries, org.empty(), { lineage: lineage, stepKey: 'p:mpnn', stepTitle: 'MPNN' });
if (nodes0.filter(n => n.kind === 'folder').length !== 2) throw new Error('expected 2 parent folders');

org.dissolveFolder(store, 'p:mpnn', nodes0[0]);
const nodes1 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn', stepTitle: 'MPNN' });
const folders1 = nodes1.filter(n => n.kind === 'folder');
const files1 = nodes1.filter(n => n.kind === 'entry');
if (folders1.length !== 1 || files1.length !== 2) throw new Error('dissolve should flatten one parent: ' + folders1.length + ',' + files1.length);

org.undo(store);
const nodes2 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'] || org.empty(), { lineage: lineage, stepKey: 'p:mpnn' });
if (nodes2.filter(n => n.kind === 'folder').length !== 2) throw new Error('undo dissolve failed');

org.redo(store);
const nodes3 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn' });
if (nodes3.filter(n => n.kind === 'entry').length !== 2) throw new Error('redo dissolve failed');

const id = org.createFolder(store, 'p:mpnn', { name: '准备实验', entryKeys: ['k-Aurora_001_1'] });
const nodes4 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn' });
const user = nodes4.find(n => n.origin === 'user');
if (!user || user.name !== '准备实验' || user.entries.length !== 1) throw new Error('create folder failed');

org.deleteFolder(store, 'p:mpnn', user);
const nodes5 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn' });
const trash = nodes5.find(n => n.origin === 'removed');
if (!trash || trash.entries.length !== 1) throw new Error('delete folder should send files to removed');
const json = org.serialize(store['p:mpnn'], entries);
if (!json.removed || json.removed.length !== 1) throw new Error('serialize failed');
org.undo(store);
const nodes6 = org.apply(lineage.nodes(entries, true), entries, store['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn' });
if (!nodes6.find(n => n.origin === 'user')) throw new Error('undo delete should restore user folder');
if (JSON.stringify(lineage.nodes(entries, true).map(n => n.name)).indexOf('Aurora_001') < 0) throw new Error('lineage itself must stay intact');
org.setNote(store, 'p:mpnn', 'folder:p|mpnn|parent|Aurora_001', '演示便签：候选一');
const json2 = org.serialize(store['p:mpnn'], entries);
if (!json2.notes || json2.notes['folder:p|mpnn|parent|Aurora_001'] !== '演示便签：候选一') throw new Error('notes serialize failed');
const hydrated = org.hydrate(json2, entries);
if (org.getNote(hydrated, 'folder:p|mpnn|parent|Aurora_001') !== '演示便签：候选一') throw new Error('notes hydrate failed');

// sourceKey and runtime id may differ: organization persistence must use sourceKey.
const runtimeEntry = entry('runtime-1', 'Aurora_001', { sourceKey: 'physical-source-1' });
const keyedStore = {};
const keyedFolder = org.createFolder(keyedStore, 'p:mpnn', { name: '按 sourceKey', entryKeys: [org.placeId(runtimeEntry)] });
const keyedNodes = org.apply(lineage.nodes([runtimeEntry], false), [runtimeEntry], keyedStore['p:mpnn'], { lineage: lineage, stepKey: 'p:mpnn' });
const keyedUser = keyedNodes.find(n => n.origin === 'user');
if (!keyedUser || keyedUser.entries.length !== 1) throw new Error('sourceKey placement failed');

// Object-form placements are accepted by the API and must hydrate without throwing.
const objectOrg = org.hydrate({ folders: [{ id: 'obj', name: '对象格式' }], placements: { 'physical-source-1': 'obj' } }, [runtimeEntry]);
if (objectOrg.placements['physical-source-1'] !== 'obj') throw new Error('object placements hydrate failed');
const corrupted = org.hydrate({
  folders: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'bad', name: 'Bad', parentId: 'missing' }],
  placements: [{ sourceKey: 'physical-source-1', folderId: 'missing' }, { sourceKey: 'physical-source-1', folderId: 'a' }],
}, [runtimeEntry]);
if (!corrupted.folders.length || corrupted.placements['physical-source-1'] !== 'a') throw new Error('corrupted organization recovery failed');

// Note edits are undoable and coalesced; structural undo must not erase later notes.
const noteStore = {};
const noteFolder = org.createFolder(noteStore, 'p:mpnn', { name: '便签测试' });
org.setNote(noteStore, 'p:mpnn', noteFolder, '第一版');
org.setNote(noteStore, 'p:mpnn', noteFolder, '第二版');
org.undo(noteStore);
if (org.getNote(noteStore['p:mpnn'], noteFolder) !== '') throw new Error('note undo failed');
org.redo(noteStore);
if (org.getNote(noteStore['p:mpnn'], noteFolder) !== '第二版') throw new Error('note redo failed');
org.renameFolder(noteStore, 'p:mpnn', noteFolder, '便签测试2');
org.setNote(noteStore, 'p:mpnn', noteFolder, '保留便签');
org.undo(noteStore);
if (org.getNote(noteStore['p:mpnn'], noteFolder) !== '第二版') throw new Error('structural undo erased note history');

console.log('workspace_org ok');

// ---------- 格子布局：slot 保留空位、过滤休眠、撤销、序列化 ----------
{
  const store = {};
  const ents = [entry('a1', 'Aurora_001'), entry('a2', 'Aurora_001'), entry('a3', 'Aurora_001')];
  // 一次放置 = 一次 commit：a3 挪到 slot 4，原 slot 2 留空
  org.setLayout(store, 'p:mpnn', 'root', [
    { ref: org.refOfNode({ kind: 'entry', entry: ents[0] }), slot: 0 },
    { ref: org.refOfNode({ kind: 'entry', entry: ents[1] }), slot: 1 },
    { ref: org.refOfNode({ kind: 'entry', entry: ents[2] }), slot: 4, path: 'x/a3.pdb' },
  ]);
  if (org.isEmpty(store['p:mpnn'])) throw new Error('layout-only organization must not be empty');
  const laid = org.applyDisplayLayout(
    ents.map(function (e) { return { kind: 'entry', entry: e }; }), store['p:mpnn'], 'root');
  const slots = laid.map(function (n) { return n._slot; });
  if (JSON.stringify(slots) !== '[0,1,4]') throw new Error('slots must keep gap, got ' + JSON.stringify(slots));
  if (laid[2]._parentKey !== 'root') throw new Error('parent annotation missing');

  // 撤销回到无布局；重做恢复
  org.undo(store);
  if (org.layoutFor(store['p:mpnn'], 'root')) throw new Error('undo should clear layout');
  org.redo(store);
  if (!org.layoutFor(store['p:mpnn'], 'root')) throw new Error('redo should restore layout');

  // serialize → hydrate 往返，含 path 回绑与运行时 key 拒绝
  const json = org.serialize(store['p:mpnn'], ents);
  if (!json.layout || !json.layout.parents.root) throw new Error('serialize dropped layout');
  const runtimeJson = JSON.parse(JSON.stringify(json));
  runtimeJson.layout.parents.root.slots.push({ ref: 'e9', slot: 9 });
  const hydrated = org.hydrate(runtimeJson, ents);
  if (org.layoutFor(hydrated, 'root').slots.e9 !== undefined) throw new Error('runtime key must be dropped from layout');
  if (org.layoutFor(hydrated, 'root').slots[org.refOfNode({ kind: 'entry', entry: ents[2] })] !== 4) {
    throw new Error('hydrate lost slot');
  }

  // 过滤缺席：条目不在列表时布局引用保留；rebind 能按 path 找回改了身份的条目
  const partial = org.applyDisplayLayout(
    [{ kind: 'entry', entry: ents[0] }], store['p:mpnn'], 'root');
  if (partial[0]._slot !== 0) throw new Error('partial view keeps slot');
  const rebound = org.rebind(store['p:mpnn'], ents);
  if (!org.layoutFor(rebound, 'root')) throw new Error('rebind must keep layout');

  // clearLayout / resetStep
  org.clearLayout(store, 'p:mpnn', 'root');
  if (org.layoutFor(store['p:mpnn'], 'root')) throw new Error('clearLayout failed');
  org.setLayout(store, 'p:mpnn', 'root', [{ ref: 'k-a1', slot: 3 }]);
  org.resetStep(store, 'p:mpnn');
  if (org.layoutFor(store['p:mpnn'], 'root')) throw new Error('resetStep must clear layout');

  // 父层隔离：不同 parentKey 互不影响；文件夹引用不带 path
  org.setLayout(store, 'p:mpnn', 'root', [{ ref: 'folder:user:x1', slot: 0 }]);
  org.setLayout(store, 'p:mpnn', 'folder:user:x1', [{ ref: 'k-a1', slot: 2 }]);
  if (org.layoutFor(store['p:mpnn'], 'root').slots['folder:user:x1'] !== 0) throw new Error('folder ref slot lost');
  if (org.layoutFor(store['p:mpnn'], 'folder:user:x1').slots['k-a1'] !== 2) throw new Error('parent isolation failed');
}
