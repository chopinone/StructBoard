// Only presentation fields cross into Vue. The caller retains scientific data.
export function stepNavigationRows(steps, plain, describe) {
  const rows = steps.map(step => {
    const starred = step.entries.filter(entry => entry.star).length;
    return Object.freeze({ key: step.key, title: step.title, index: step.displayIndex,
      tool: step.tool || '', plain: false,
      summary: describe(step.entries) + (starred ? ' · 优选标记 ' + starred : '') });
  });
  if (plain.length) {
    const starred = plain.filter(entry => entry.star).length;
    rows.push(Object.freeze({ key: 'plain', title: '其他导入', index: '', tool: '', plain: true,
      summary: plain.length + ' 个结构' + (starred ? ' · ★' + starred : '') }));
  }
  return Object.freeze(rows);
}
