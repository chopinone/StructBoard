// metrics: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function demoMetricsCSV() {
    const rows = [
      ['design', 'ranking_score', 'iptm', 'ptm', 'hotspot_contacts', 'interface_contacts', 'clashes', 'binder_rg_nm', 'interface_pae_AB'],
      ['design_001.pdb', '0.812', '0.719', '0.844', '6', '136', '0', '1.205', '8.41'],
      ['design_002.pdb', '0.779', '0.706', '0.831', '5', '128', '1', '1.194', '12.30'],
      ['design_003.pdb', '0.701', '0.688', '0.792', '3', '99', '2', '1.229', '19.75'],
      ['design_004.pdb', '0.847', '0.741', '0.869', '7', '183', '0', '1.224', '6.12'],
    ];
    return rows.map(function (r) { return r.join(','); }).join('\n');
  }
  function loadDemoMetrics() {
    const t = ports.METRICS.parse(demoMetricsCSV(), 'demo_metrics.csv');
    if (!t) return;
    ports.S.metrics.table = t;
    ports.S.metrics.fileName = 'demo_metrics.csv';
    ports.S.metrics.auto = false;
    ports.S.metrics.filters = [];
    ports.S.metrics.primary = 'interface_pae_AB';
    ports.S.metrics.higher = false;   // 界面 PAE 越小越好，别拿 iptm 排序
    ports.S.metrics.matched = ports.METRICS.attach(t, ports.S.entries);
    recomputeMetricRange();
    renderMetricUI();
    ports.renderList();
    refreshMetricsStatus();
  }
  function recomputeMetricRange() {
    ports.S.metrics.range = (ports.S.metrics.table && ports.S.metrics.primary)
      ? ports.METRICS.range(ports.S.entries, ports.S.metrics.primary) : null;
  }
  function ensureMetricsView() {
    if(ports.metricsView)return ports.metricsView;
    ports.metricsView=window.SB_UI.mountMetrics(document.querySelector('#metricsPanel .mp-body-wrap'),{
      primary:function(value){const manual=ports.S.manualOrder;ports.S.manualOrder=false;ports.S.metrics.primary=value;recomputeMetricRange();refreshMetricsStatus();ports.renderList();if(ports.S.theme==='by-metric'&&ports.S.overlayViewer)ports.applyTheme(ports.S.overlayViewer,ports.S.overlayRefs);if(manual)ports.applyModeChange(true);},
      direction:function(){ports.S.manualOrder=false;ports.S.metrics.higher=!ports.S.metrics.higher;renderMetricUI();ports.renderList();ports.applyModeChange(true);},
      apply:applyMetrics,preset:presetRf3,clear:clearMetrics,export:exportList,pick:ports.pickImportMetrics,import:importMetrics,
    });
    return ports.metricsView;
  }
  function metricPanelModel() {
    const m=ports.S.metrics;
    return {hasTable:!!m.table,columns:m.table?m.table.columns.slice():[],primary:m.primary,higher:m.higher,
      status:m.table?m.fileName+' · '+m.table.rows.length+' 行 · '+m.table.columns.length+' 个数值列 · 匹配 '+m.matched+'/'+ports.S.entries.length+' · 主指标 '+(m.primary||'（未选）'):'未导入 · 可按指标排序、筛选、上色'};
  }
  function refreshMetricsStatus() { ensureMetricsView().update(metricPanelModel()); }
  function renderMetricUI() {
    const m=ports.S.metrics;
    if(m.table&&m.table.columns.indexOf(m.primary)<0)m.primary=m.table.columns[0]||'';
    ensureMetricsView().update(metricPanelModel(),m.filters);
  }
  function addFilterRow(col,op,value) { ensureMetricsView().add(col,op,value); }
  function readFilters() { return ensureMetricsView().filters(); }
  function applyMetrics() {
    const m = ports.S.metrics;
    if (!m.table) { ports.toast('请先导入指标表', true); return; }
    m.filters = readFilters();
    recomputeMetricRange();
    ports.renderList();
    refreshMetricsStatus();
    ports.refreshBadge();
    ports.refreshSharedPaneViews();
    ports.toast('已按 ' + (m.primary || '原顺序') + ' 排序' +
      (m.filters.length ? '，' + m.filters.length + ' 个条件' : '') +
      ' · 当前 ' + ports.visibleEntries().length + ' 个结构');
  }
  function guessPrimary(table) {
    const low = table.columns.map(function (c) { return c.toLowerCase(); });
    const smallBetter = ['interface_pae_ab', 'interface_pae_min_ab', 'interface_pae', 'pae_ab', 'rmsd', 'overall_pae', 'clashes', 'clash'];
    for (const key of smallBetter) {
      const i = low.indexOf(key);
      if (i >= 0) return { col: table.columns[i], higher: false };
    }
    const bigBetter = ['ranking_score', 'iptm', 'hotspot_contacts', 'interface_contacts', 'ptm'];
    for (const key of bigBetter) {
      const i = low.indexOf(key);
      if (i >= 0) return { col: table.columns[i], higher: true };
    }
    return { col: table.columns[0] || '', higher: true };
  }
  function findCol(names) {
    for (const n of names) {
      const hit = ports.S.metrics.table.columns.find(function (c) { return c.toLowerCase() === n.toLowerCase(); });
      if (hit) return hit;
    }
    return '';
  }
  function presetRf3() {
    const m = ports.S.metrics;
    if (!m.table) { ports.toast('请先导入指标表', true); return; }
    const hot = findCol(['hotspot_contacts', 'hotspot']);
    const clash = findCol(['clashes', 'clash']);
    const pae = findCol(['interface_pae_AB', 'interface_pae', 'pae_AB']);
    const filters = [];
    if (hot) filters.push({ col: hot, op: '>=', value: 4 });
    if (clash) filters.push({ col: clash, op: '<=', value: 1 });
    m.primary = pae || hot || m.table.columns[0] || '';
    m.higher = !pae;
    m.filters = filters;
    recomputeMetricRange();
    renderMetricUI();
    ports.renderList();
    ports.refreshBadge();
    ports.refreshSharedPaneViews();
    ports.toast(filters.length
      ? 'RF3 预设：' + hot + ' ≥ 4 且 ' + clash + ' ≤ 1，主指标 ' + m.primary
      : '表里没有 hotspot_contacts / clashes，已改用 ' + m.primary);
  }
  function clearMetrics() {
    ports.S.metrics.table = null;
    ports.S.metrics.primary = '';
    ports.S.metrics.filters = [];
    ports.S.metrics.range = null;
    ports.S.metrics.matched = 0;
    ports.S.metrics.fileName = '';
    for (const e of ports.S.entries) { e.metrics = null; e.metricRow = null; }
    if (ports.S.theme === 'by-metric') { ports.S.theme = 'per-structure'; ports.$('selTheme').value = 'per-structure'; }
    renderMetricUI();
    ports.renderList();
    ports.refreshBadge();
    ports.refreshSharedPaneViews();
    ports.toast('已移除指标表');
  }
  async function importMetrics(fileList) {
    const epoch = ports.rawS.workspaceEpoch;
    const files = Array.from(fileList || []).filter(function (f) {
      return /\.(csv|tsv|txt|json)$/i.test(f.name);
    });
    if (!files.length) { ports.toast('请选择 .csv / .tsv / .json 指标表', true); return; }
    const f = files[0];
    try {
      const text = await new Promise(function (resolve, reject) {
        const r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(new Error('读取失败')); };
        r.readAsText(f);
      });
      if (ports.rawS.workspaceEpoch !== epoch) return;
      const table = ports.METRICS.parse(text, f.name);
      if (!table || !table.columns.length) { ports.toast('指标表里没有可识别的数值列', true); return; }
      ports.S.manualOrder = false;
      ports.S.metrics.table = table;
      ports.S.metrics.fileName = f.name;
      ports.S.metrics.filters = [];
      const guess = guessPrimary(table);
      ports.S.metrics.primary = guess.col;
      ports.S.metrics.higher = guess.higher;
      ports.S.metrics.matched = ports.METRICS.attach(table, ports.S.entries);
      recomputeMetricRange();
      renderMetricUI();
      ports.renderList();
      if (ports.S.metrics.matched) ports.refreshSharedPaneViews();
      ports.toast(ports.S.metrics.matched
        ? '指标表：' + table.rows.length + ' 行 / ' + table.columns.length + ' 列，匹配到 ' + ports.S.metrics.matched + ' 个结构 · 主指标 ' + ports.S.metrics.primary
        : '指标表已读（' + table.rows.length + ' 行），但文件名没对上：检查 design 列，或先导入对应结构');
    } catch (e) {
      ports.note('指标表导入失败：' + (e && e.message ? e.message : e), true);
    }
  }
  function exportList() {
    const list = ports.visibleEntries();
    if (!list.length) { ports.toast('当前没有可导出的结构', true); return; }
    const cols = ports.S.metrics.table ? ports.S.metrics.table.columns : [];
    // 手动拼 CSV（含星标列），复用 metrics 的单元格转义
    const esc = function (v) {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const out = [['design', '优选'].concat(cols)];
    for (const e of list) {
      const vals = cols.map(function (c) {
        return (e.metrics && Number.isFinite(e.metrics[c])) ? e.metrics[c] : '';
      });
      out.push([e.name, e.star ? '★' : ''].concat(vals));
    }
    const csv = '\uFEFF' + out.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'structboard-selection-' + Date.now() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    ports.toast('已导出 ' + list.length + ' 个结构（含优选标记与指标）');
  }
// SERVICE_FUNCTIONS_END
  return { demoMetricsCSV, loadDemoMetrics, recomputeMetricRange, ensureMetricsView, metricPanelModel, refreshMetricsStatus, renderMetricUI, addFilterRow, readFilters, applyMetrics, guessPrimary, findCol, presetRf3, clearMetrics, importMetrics, exportList };
}
