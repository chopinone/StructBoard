// Presentation only: no filtering, source mutation, or representative-model substitution.
export function benchGroups(entries) {
  const byParent = entries.length > 0 && entries.every(e => e.groupKind === 'parent' && e.lineage?.parentId);
  const groups = new Map(), multipleSteps = new Set(entries.map(e => e.stepKey || e.pipelineId || '')).size > 1;
  for (const entry of entries) {
    const lineage = entry.lineage || {}, scope = entry.stepKey || entry.pipelineId || 'local';
    const identity = byParent ? lineage.parentId : lineage.candidateId || entry.groupKey || entry.group;
    const key = JSON.stringify([scope, byParent ? 'parent' : 'candidate', identity || '__unassigned__']);
    const name = byParent ? lineage.parentName || lineage.parentId
      : lineage.candidateName || lineage.candidateId || entry.group || '未标注候选';
    if (!groups.has(key)) groups.set(key, { key, name: multipleSteps && entry.stepTitle ? entry.stepTitle + ' · ' + name : name, entries: [], identified: !!identity });
    groups.get(key).entries.push(entry);
  }
  return { groups: [...groups.values()], label: byParent ? '按母本排列' : '按候选排列',
    available: groups.size > 1 && [...groups.values()].some(g => g.identified) };
}

export function benchPageGroups(entries, grouping, columns) {
  const pageIds = new Set(entries.map(e => e.id)), chunks = [];
  const cols = Math.max(1, columns || 1);let row = 1, column = 1;
  for (const group of grouping.groups) {
    const visible = group.entries.filter(e => pageIds.has(e.id));
    for (let start = 0; start < visible.length; start += cols) {
      const members = visible.slice(start, start + cols);
      if (column + members.length - 1 > cols) { row++; column = 1; }
      chunks.push({ key: group.key, name: group.name, total: group.entries.length, entries: members, row, column });
      column += members.length;
    }
  }
  return { chunks, rows: chunks.length ? row : 1 };
}

export function benchLeaves(nodes) {
  const entries = [], seen = new Set();
  function visit(node) {
    if (node?.kind === 'entry' && node.entry && !seen.has(node.entry.id)) { seen.add(node.entry.id);entries.push(node.entry); }
    else if (node?.kind === 'folder') {
      if (node.children?.length) node.children.forEach(visit);
      else (node.entries || []).forEach(entry => visit({ kind: 'entry', entry }));
    }
  }
  nodes.forEach(visit);return entries;
}
