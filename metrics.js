/* StructBoard · metrics.js
 * 指标表（CSV / TSV / JSON）解析、与结构文件名匹配、色阶与名单导出。
 * 不假定固定列名：自动识别名称列与数值列。
 */
(function (global) {
  'use strict';

  const NAME_HINTS = [
    'design', 'name', 'model', 'file', 'filename', 'id', 'pdb',
    'structure', 'sample', 'basename', 'stem', 'target', 'entry',
  ];

  function detectDelimiter(line) {
    const candidates = [',', '\t', ';'];
    let best = ',', bestN = -1;
    for (const d of candidates) {
      let n = 0, quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      if (n > bestN) { bestN = n; best = d; }
    }
    return best;
  }

  function splitLine(line, d) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (c === d && !quoted) {
        out.push(cur.trim()); cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  function isNumericColumn(rows, col) {
    const vals = rows.map(function (r) { return r[col]; })
      .filter(function (v) { return v !== '' && v !== undefined && v !== null && String(v).toLowerCase() !== 'nan'; });
    if (!vals.length) return false;
    const ok = vals.filter(function (v) { return Number.isFinite(parseFloat(v)); }).length;
    return ok / vals.length >= 0.8;
  }

  function fromDelimited(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
      .filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
    if (lines.length < 2) return null;
    const d = detectDelimiter(lines[0]);
    const header = splitLine(lines[0], d);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i], d);
      if (cells.length < 2) continue;
      const row = {};
      header.forEach(function (h, j) { row[h] = cells[j] !== undefined ? cells[j] : ''; });
      rows.push(row);
    }
    const nameCol = header.find(function (h) {
      return NAME_HINTS.indexOf(h.toLowerCase()) >= 0;
    }) || header[0];
    const columns = header.filter(function (h) {
      return h !== nameCol && isNumericColumn(rows, h);
    });
    return { nameCol: nameCol, columns: columns, allColumns: header, rows: rows, kind: 'csv' };
  }

  function fromJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    let rows = [];
    if (Array.isArray(data)) {
      rows = data.map(function (x, i) {
        return (x && typeof x === 'object') ? Object.assign({ _key: String(i) }, x) : { _key: String(i), value: x };
      });
    } else if (data && typeof data === 'object') {
      rows = Object.keys(data).map(function (k) {
        const v = data[k];
        return (v && typeof v === 'object') ? Object.assign({ _key: k }, v) : { _key: k, value: v };
      });
    }
    if (!rows.length) return null;
    const all = [];
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (all.indexOf(k) < 0 && k.charAt(0) !== '_') all.push(k); });
    });
    const nameCol = all.find(function (k) { return NAME_HINTS.indexOf(k.toLowerCase()) >= 0; }) || '_key';
    const columns = all.filter(function (k) { return k !== nameCol && isNumericColumn(rows, k); });
    return { nameCol: nameCol, columns: columns, allColumns: all.indexOf(nameCol) >= 0 ? all : [nameCol].concat(all), rows: rows, kind: 'json' };
  }

  function parse(text, name) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^\s*[\[{]/.test(t) || /\.json$/i.test(name || '')) {
      const j = fromJson(t);
      if (j) return j;
    }
    return fromDelimited(t);
  }

  // .cif.gz / .pdb / 目录路径 统一成可比对的 key
  // 同时剥掉 AF3 / Boltz-2 分数文件的常见后缀，让 <design>.cif 与
  // <design>_scores.json / <design>_summary_confidences_0.json 落到同一个 key
  function normalizeName(s) {
    let t = String(s === undefined || s === null ? '' : s).trim().replace(/\\/g, '/').split('/').pop();
    t = t.replace(/\.(gz|bz2|zip)$/i, '');
    t = t.replace(/\.(cif|mmcif|mcif|pdb|ent|bcif|pdbx|txt|json|csv)$/i, '');
    for (let i = 0; i < 3; i++) {
      t = t.replace(/[_\s-]?(summary_confidences?_\d+|summary_confidences?|ranking_scores?|confidence_scores?|confidences?|scores?|models?_\d+|models?|seed[_-]?\d+|sample[_-]?\d+)$/i, '');
    }
    return t.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function attach(table, entries) {
    const map = new Map();
    for (const row of table.rows) {
      let raw = row[table.nameCol];
      if (raw === undefined || raw === null || raw === '') raw = row._key;
      const k = normalizeName(raw);
      if (k && !map.has(k)) map.set(k, row);
    }
    let hit = 0;
    for (const e of entries) {
      e.metrics = null; e.metricRow = null;
      const k = normalizeName(e.name);
      let row = map.get(k);
      if (!row && k) {
        for (const [mk, mv] of map) {
          if (mk && (mk.indexOf(k) >= 0 || k.indexOf(mk) >= 0)) { row = mv; break; }
        }
      }
      if (row) {
        const m = {};
        for (const c of table.columns) {
          const v = parseFloat(row[c]);
          if (Number.isFinite(v)) m[c] = v;
        }
        e.metrics = m; e.metricRow = row; hit++;
      }
    }
    return hit;
  }

  function range(entries, col) {
    const vals = entries.map(function (e) { return e.metrics ? e.metrics[col] : undefined; })
      .filter(function (v) { return Number.isFinite(v); });
    if (!vals.length) return null;
    return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = function (n) { return (n + h / 30) % 12; };
    const a = s * Math.min(l, 1 - l);
    const f = function (n) {
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    };
    return (f(0) << 16) | (f(8) << 8) | f(4);
  }

  /** 红（差）→ 黄 → 绿（好）；higherIsBetter 决定方向 */
  function colorScale(v, min, max, higherIsBetter) {
    if (!Number.isFinite(v)) return 0x8b98a5;
    let t = max > min ? (v - min) / (max - min) : 0.5;
    if (!higherIsBetter) t = 1 - t;
    t = Math.max(0, Math.min(1, t));
    // hslToHex 接收的是 HSL 百分比（s/l 为 0-100），别传 0-1 的小数
    return hslToHex(140 * t, 62, 45);
  }

  function csvCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(entries, columns) {
    const lines = [['design'].concat(columns).map(csvCell).join(',')];
    for (const e of entries) {
      const vals = columns.map(function (c) {
        return (e.metrics && Number.isFinite(e.metrics[c])) ? e.metrics[c] : '';
      });
      lines.push([e.name].concat(vals).map(csvCell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  global.SB_METRICS = {
    parse: parse, attach: attach, range: range, colorScale: colorScale,
    toCSV: toCSV, normalizeName: normalizeName, NAME_HINTS: NAME_HINTS,
  };
})(window);
