/* Shared, metadata-first lineage navigation. No source files or coordinates are changed. */
(function (root) {
  'use strict';
  const ROLE = { candidate: '候选', variant: '新版本', parent: '原版母本', parent_control: '原版对照', reference: '参考' };
  const ARTIFACT = { design: '原设计', mpnn_backbone: 'MPNN骨架', prediction: '预测模型', aligned: '叠合副本', reference: '设计参考', preview: '旧模型预览' };
  const OPERATION = { generate: '生成', predict: '预测', filter: '筛选', compare: '比较已有结果', reference: '输入参考', preview: '结果待补' };
  const META = ['lineage', 'groupKey', 'groupKind', 'groupBy', 'groupingWarning', 'fileKey', 'stepOperation', 'stepState', 'stepDesc'];
  function meta(source) {
    const value = {};
    META.forEach(function (key) {
      if (source && source[key] !== undefined) value[key] = key === 'lineage' ? Object.assign({}, source[key] || {}) : source[key];
    });
    return value;
  }
  function scope(e) { return e.stepKey || e.pipelineId || 'local'; }
  function groupKey(e) { return e.group ? (e.groupKey || scope(e) + '|group|' + e.group) : ''; }
  function sameGroup(a, b) { return !!groupKey(a) && groupKey(a) === groupKey(b); }
  function summarize(entries) {
    const sets = { candidates: new Set(), parents: new Set(), variants: new Set(), controls: new Set() };
    const c = { files: entries.length, candidates: 0, parents: 0, variants: 0, controls: 0, models: 0, backbones: 0, previews: 0, references: 0, designs: 0, aligned: 0, identifiedFiles: 0, known: true };
    const keys = { prediction: 'models', mpnn_backbone: 'backbones', preview: 'previews', reference: 'references', design: 'designs', aligned: 'aligned' };
    entries.forEach(function (e) {
      const l = e.lineage || {};
      if (l.candidateId) sets.candidates.add(scope(e) + '|' + l.candidateId);
      if (l.parentId) sets.parents.add(scope(e) + '|' + l.parentId);
      if (l.role === 'variant' && l.candidateId) sets.variants.add(scope(e) + '|' + l.candidateId);
      if (l.role === 'parent_control' && l.candidateId) sets.controls.add(scope(e) + '|' + l.candidateId);
      if (keys[l.artifactKind]) c[keys[l.artifactKind]]++;
      if (ARTIFACT[l.artifactKind] && (l.candidateId || l.artifactKind === 'reference') && !e.groupingWarning) c.identifiedFiles++;
    });
    Object.keys(sets).forEach(function (k) { c[k] = sets[k].size; });
    c.known = c.files > 0 && c.identifiedFiles === c.files;
    return c;
  }
  function countText(c) {
    if (!c || !c.known) return (c ? c.files : 0) + ' 份结构文件';
    if (c.backbones === c.files && c.variants) return (c.parents ? c.parents + ' 个母本 · ' : '') + c.variants + ' 条新序列';
    let subject = c.variants ? c.variants + ' 条新版本' : '';
    if (c.controls) subject += (subject ? ' + ' : '') + c.controls + ' 条原版对照';
    const rest = c.candidates - c.variants - c.controls;
    if (rest > 0) subject += (subject ? ' + ' : '') + rest + (c.references === c.files ? ' 条原版' : ' 条候选');
    if (c.models) subject += (subject ? ' · ' : '') + c.models + ' 个预测模型';
    if (c.previews) subject += (subject ? ' · ' : '') + c.previews + ' 份旧模型预览';
    if (c.aligned) subject += (subject ? ' · ' : '') + c.aligned + ' 份叠合副本';
    if (!subject) subject = c.references === c.files ? c.references + ' 份参考结构' : c.files + ' 份结构文件';
    return subject;
  }
  function parentRole(l) { return l.parentRole === 'extra_control' ? '额外对照来源' : l.parentRole === 'main' ? '主力母本' : ''; }
  function entryText(e) {
    const l = e.lineage || {}, fields = [];
    if (ROLE[l.role]) fields.push(ROLE[l.role]);
    if (l.parentName || l.parentId) fields.push('来自 ' + (l.parentName || l.parentId));
    if (Number.isFinite(l.temperature)) fields.push('T=' + l.temperature);
    if (Number.isFinite(l.variantIndex)) fields.push('版本 ' + l.variantIndex);
    if (ARTIFACT[l.artifactKind]) fields.push(ARTIFACT[l.artifactKind]);
    if (l.artifactKind === 'prediction' && Number.isInteger(e.modelIndex)) fields.push('模型 ' + e.modelIndex);
    if (l.artifactKind === 'preview') fields.push('非本阶段新结果');
    return fields.join(' · ');
  }
  function candidateText(e) {
    const l = e.lineage || {};
    return l.candidateName || l.candidateId || e.group || e.name;
  }
  function sortedEntries(entries) {
    return entries.slice().sort(function (a, b) {
      const ai = Number.isInteger(a.modelIndex) ? a.modelIndex : Infinity;
      const bi = Number.isInteger(b.modelIndex) ? b.modelIndex : Infinity;
      if (ai !== bi) return ai - bi;
      const x = a.lineage || {}, y = b.lineage || {};
      if (Number.isFinite(x.temperature) && Number.isFinite(y.temperature) && x.temperature !== y.temperature) return x.temperature - y.temperature;
      return (x.variantIndex || 0) - (y.variantIndex || 0);
    });
  }
  function leafNodes(entries, parent) {
    const unit = parent && parent.groupKind === 'parent' ? '条新序列' : '个模型';
    return entries.map(function (e, i) { return { kind: 'entry', entry: e, pos: i + 1, total: entries.length, unit: unit, auditEnabled: !parent || parent.auditEnabled !== false }; });
  }
  function makeFolder(id, name, entries, kind) {
    const items = sortedEntries(entries), cover = items[0], l = cover.lineage || {}, c = summarize(items);
    const hasKnownKinds = items.some(function (e) { return !!(e.lineage && e.lineage.artifactKind); });
    const auditEnabled = kind !== 'parent' && (!hasKnownKinds || items.every(function (e) { return (e.lineage || {}).artifactKind === 'prediction'; }));
    const info = kind === 'parent' ? parentRole(l) : (l.role === 'parent_control' ? '原版对照' : l.role === 'variant' ? '新版本' : '');
    let label = c.known ? countText(c) : items.length + (kind === 'parent' ? ' 份结构' : ' 个模型');
    if (kind === 'parent' && c.known && c.backbones === c.files) label = c.variants + ' 条新序列';
    const node = { kind: 'folder', id: 'folder:' + id, groupKey: id, name: name, entries: items, cover: cover, count: items.length,
      groupKind: kind || 'directory', counts: c, countText: label, roleText: info, auditEnabled: auditEnabled, referenceEntry: l.referencePath ? cover : null };
    if (kind === 'parent') {
      const byCandidate = new Map();
      items.forEach(function (e) {
        const cid = (e.lineage || {}).candidateId || e.id;
        if (!byCandidate.has(cid)) byCandidate.set(cid, []);
        byCandidate.get(cid).push(e);
      });
      node.children = [];
      byCandidate.forEach(function (values, cid) {
        if (values.length > 1) node.children.push(makeFolder(id + '|candidate|' + cid, candidateText(values[0]), values, 'candidate'));
        else node.children.push({ kind: 'entry', entry: values[0], pos: node.children.length + 1, total: byCandidate.size, unit: '条新序列', auditEnabled: false });
      });
    } else node.children = leafNodes(items, node);
    return node;
  }
  function nodes(entries, grouped) {
    if (grouped === false) return entries.map(function (e) { return { kind: 'entry', entry: e }; });
    const buckets = new Map(), loose = [];
    entries.forEach(function (e) {
      const key = groupKey(e);
      if (!key) { loose.push(e); return; }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(e);
    });
    const result = [];
    buckets.forEach(function (values, key) {
      const e = values[0];
      if (values.length < 2 && e.groupKind !== 'parent') { loose.push(e); return; }
      result.push(makeFolder(key, e.group, values, e.groupKind || 'directory'));
    });
    loose.forEach(function (e) { result.push({ kind: 'entry', entry: e }); });
    return result;
  }
  function children(node) { return node.children || leafNodes(node.entries || [], node); }
  function find(nodes, id) {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.kind === 'folder' && node.children) { const child = find(node.children, id); if (child) return child; }
    }
    return null;
  }
  function folders(nodes) {
    let found = [];
    nodes.forEach(function (n) { if (n.kind === 'folder') { found.push(n); if (n.children) found = found.concat(folders(n.children)); } });
    return found;
  }
  const api = { meta: meta, groupKey: groupKey, sameGroup: sameGroup, summarize: summarize, countText: countText,
    entryText: entryText, nodes: nodes, children: children, find: find, folders: folders,
    operationText: function (name) { return OPERATION[name] || name || ''; } };
  root.SB_LINEAGE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
