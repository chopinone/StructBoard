/* StructBoard · io.js
 * 纯前端文件读取与轻量结构解析。
 * 只用于：判断格式、统计残基/链/原子、以及 CA 叠加时重写坐标。
 * 真正的结构解析与渲染全部交给 Mol*。
 */
(function (global) {
  'use strict';

  const TEXT_EXT = /\.(pdb|ent|pdbx|txt|cif|mmcif|mcif)(\.gz)?$/i;
  const BINARY_EXT = /\.bcif(\.gz)?$/i;
  const GZ_EXT = /\.gz$/i;

  function stripGz(name) { return String(name || '').replace(GZ_EXT, ''); }

  function detectFormat(name, isBinary) {
    const n = stripGz(name);
    if (/\.bcif$/i.test(n) || isBinary) return 'bcif';
    if (/\.(cif|mmcif|mcif)$/i.test(n)) return 'mmcif';
    return 'pdb';
  }

  function isStructureFile(name) {
    return TEXT_EXT.test(name) || BINARY_EXT.test(name) || /\.(pdbqt|gro|xyz)(\.gz)?$/i.test(name);
  }

  // RF3 / AF3 输出常见 .cif.gz：用浏览器原生 DecompressionStream 解压
  async function inflate(buffer, asText) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('此浏览器不支持 gzip 解压，请用新版 Chrome / Edge');
    }
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('文件内容为空（源文件可能被移动或没下载完）');
    }
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buffer]).stream().pipeThrough(ds);
    try {
      const resp = new Response(stream);
      return asText ? await resp.text() : await resp.arrayBuffer();
    } catch (e) {
      throw new Error('gzip 数据不完整或不可读（' + (e && e.message ? e.message : e) + '）');
    }
  }

  async function readFile(file) {
    const isGz = GZ_EXT.test(file.name);
    const base = stripGz(file.name);
    const isBinary = /\.bcif$/i.test(base);
    let data;
    try {
      if (typeof file.arrayBuffer === 'function' && typeof file.text === 'function') {
        if (isGz || isBinary) {
          data = await file.arrayBuffer();
        } else {
          data = await file.text();
        }
      } else {
        data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('读取失败：' + file.name));
          reader.onload = () => resolve(reader.result);
          if (isGz || isBinary) reader.readAsArrayBuffer(file);
          else reader.readAsText(file);
        });
      }
      if (isGz) data = await inflate(data, !isBinary);
      return {
        name: file.name.split(/[/\\\\]/).pop(),
        // webkitRelativePath 只是相对目录；WebView2/Tauri 若提供 path/fullPath 才是可供 Explorer 打开的绝对路径。
        path: file.webkitRelativePath || file.name,
        fullPath: (/^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(String(file.fullPath || file.path || '')))
          ? String(file.fullPath || file.path) : '',
        size: file.size,
        data: data,
        format: detectFormat(base, isBinary),
        isBinary: isBinary,
      };
    } catch (e) {
      throw new Error('读取失败：' + file.name + ' — ' + (e && e.message ? e.message : e));
    }
  }

  /* ---------------- PDB ---------------- */

  function parsePdb(text) {
    const atoms = [];
    const chains = new Set();
    const residues = new Set();
    let models = 0;
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const rec = line.slice(0, 6);
      if (rec === 'MODEL ') { models++; continue; }
      if (rec !== 'ATOM  ' && rec !== 'HETATM') continue;
      let x = parseFloat(line.slice(30, 38));
      let y = parseFloat(line.slice(38, 46));
      let z = parseFloat(line.slice(46, 54));
      if (![x, y, z].every(Number.isFinite)) {
        const t = line.trim().split(/\s+/);
        if (t.length >= 9) {
          x = parseFloat(t[6]); y = parseFloat(t[7]); z = parseFloat(t[8]);
        }
      }
      if (![x, y, z].every(Number.isFinite)) continue;
      const atomName = (line.slice(12, 16) || '').trim();
      const altLoc = (line.slice(16, 17) || '').trim();
      const resName = (line.slice(17, 20) || '').trim();
      const chain = (line.slice(21, 22) || '').trim() || 'A';
      const resSeq = (line.slice(22, 26) || '').trim();
      const iCode = (line.slice(26, 27) || '').trim();
      const element = (line.slice(76, 78) || '').trim() || atomName.replace(/[^A-Za-z]/g, '').slice(0, 1);
      const bfactor = parseFloat(line.slice(60, 66));
      const occ = parseFloat(line.slice(54, 60));
      atoms.push({
        name: atomName, altLoc, resName, chain, resSeq, iCode,
        x, y, z,
        occ: Number.isFinite(occ) ? occ : 1,
        b: Number.isFinite(bfactor) ? bfactor : 0,
        element: (element || 'C').toUpperCase(),
        het: rec === 'HETATM',
      });
      chains.add(chain);
      residues.add(chain + ':' + resSeq + iCode + ':' + resName);
    }
    return { atoms, chains: [...chains], residueCount: residues.size, models: Math.max(models, atoms.length ? 1 : 0), kind: 'pdb' };
  }

  /* ---------------- mmCIF ---------------- */

  // 支持引号包裹、'.'/'?' 空值的简单 mmCIF tokenizer
  function tokenizeCifLine(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i])) i++;
      if (i >= line.length) break;
      const q = line[i];
      if (q === '"' || q === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== q) j++;
        out.push(line.slice(i + 1, j));
        i = Math.min(j + 1, line.length);
      } else {
        let j = i;
        while (j < line.length && !/\s/.test(line[j])) j++;
        out.push(line.slice(i, j));
        i = j;
      }
    }
    return out;
  }

  function cleanCifValue(v) {
    return (v === undefined || v === '.' || v === '?') ? '' : v;
  }

  function parseMmcif(text) {
    const lines = text.split(/\r?\n/);
    const atoms = [];
    const chains = new Set();
    const residues = new Set();
    let colMap = null;
    let inAtomLoop = false;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trim();
      if (/^loop_\s*$/i.test(trimmed)) { colMap = null; inAtomLoop = false; continue; }
      if (/^_atom_site\./i.test(trimmed)) {
        if (!colMap) { colMap = {}; inAtomLoop = true; }
        colMap[trimmed.split(/\s+/)[0].replace(/^_atom_site\./i, '').toLowerCase()] = Object.keys(colMap).length;
        continue;
      }
      if (!inAtomLoop || !colMap) continue;
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('_') || /^data_/i.test(trimmed) || /^save_/i.test(trimmed)) {
        if (trimmed.startsWith('#') && atoms.length) { inAtomLoop = false; colMap = null; }
        continue;
      }
      const t = tokenizeCifLine(line);
      if (t.length < 3) continue;
      const get = function (key) { return cleanCifValue(t[colMap[key.toLowerCase()]]); };
      const x = parseFloat(get('cartn_x'));
      const y = parseFloat(get('cartn_y'));
      const z = parseFloat(get('cartn_z'));
      if (![x, y, z].every(Number.isFinite)) continue;

      const group = get('group_pdb') || 'ATOM';
      const name = get('label_atom_id') || get('auth_atom_id') || '';
      const resName = get('label_comp_id') || get('auth_comp_id') || 'UNK';
      const chain = get('auth_asym_id') || get('label_asym_id') || 'A';
      const resSeq = get('auth_seq_id') || get('label_seq_id') || String(atoms.length + 1);
      const iCode = get('pdbx_pdb_ins_code') || '';
      const element = (get('type_symbol') || name.replace(/[^A-Za-z]/g, '').slice(0, 1) || 'C').toUpperCase();
      const b = parseFloat(get('b_iso_or_equiv'));
      const occ = parseFloat(get('occupancy'));

      atoms.push({
        name: name, altLoc: get('label_alt_id') || '', resName, chain, resSeq, iCode,
        x, y, z,
        occ: Number.isFinite(occ) ? occ : 1,
        b: Number.isFinite(b) ? b : 0,
        element, het: group.toUpperCase() === 'HETATM',
      });
      chains.add(chain);
      residues.add(chain + ':' + resSeq + iCode + ':' + resName);
    }
    return { atoms, chains: [...chains], residueCount: residues.size, models: atoms.length ? 1 : 0, kind: 'mmcif' };
  }

  function parse(data, format) {
    if (format === 'bcif') return null;               // 二进制 CIF 由 Mol* 直接读取
    if (typeof data !== 'string') return null;
    try {
      if (format === 'mmcif' || /^\s*data_/i.test(data.slice(0, 200))) return parseMmcif(data);
      return parsePdb(data);
    } catch (e) {
      console.warn('[StructBoard] parse failed', e);
      return null;
    }
  }

  /* ---------------- 序列（AA3 → AA1） ---------------- */

  const AA3TO1 = {
    ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
    GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
    PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
    MSE: 'M', SEC: 'U', PYL: 'O', HYP: 'P', CSO: 'C',
  };

  /**
   * 把 parse() 结果按链整理成残基序列。
   * 返回 [{ chain, length, meanB, residues: [{ code, name, seq, icode, b }] }]
   * b 取该残基全部原子的 B 因子均值（AF3 / Boltz 的 mmCIF 里就是 pLDDT）。
   */
  function sequences(parsed) {
    if (!parsed || !parsed.atoms || !parsed.atoms.length) return [];
    const order = [];
    const byChain = new Map();
    for (const a of parsed.atoms) {
      let c = byChain.get(a.chain);
      if (!c) {
        c = { last: null };
        byChain.set(a.chain, c);
        order.push({ chain: a.chain, c: c });
      }
      const key = String(a.resSeq) + (a.iCode || '');
      if (c.last && c.last.key === key && c.last.name === a.resName) {
        c.last.bSum += a.b || 0;
        c.last.bN += 1;
        continue;
      }
      const r = {
        key: key, name: a.resName || 'UNK',
        seq: AA3TO1[a.resName] || 'X',
        icode: a.iCode || '', bSum: a.b || 0, bN: 1,
      };
      c.last = r;
      c.residues = c.residues || [];
      c.residues.push(r);
    }
    const out = [];
    for (const { chain, c } of order) {
      const residues = (c.residues || []).map(function (r) {
        return { code: r.seq, name: r.name, seq: r.key, icode: r.icode, b: r.bN ? r.bSum / r.bN : 0 };
      });
      let bSum = 0, bN = 0;
      for (const r of residues) { bSum += r.b; bN += 1; }
      out.push({
        chain: chain,
        length: residues.length,
        meanB: bN ? bSum / bN : 0,
        residues: residues,
      });
    }
    return out;
  }

  function toFasta(name, seqs) {
    const header = String(name || 'structure').replace(/[^\w.\-]+/g, '_');
    const lines = [];
    for (const s of seqs) {
      const letters = s.residues.map(function (r) { return r.code; }).join('');
      lines.push('>' + header + '|' + s.chain + ' len=' + s.length);
      for (let i = 0; i < letters.length; i += 60) lines.push(letters.slice(i, i + 60));
    }
    return lines.join('\n');
  }

  /* ---------------- 输出 PDB（对齐后使用） ---------------- */

  function f8(v) { return (Number.isFinite(v) ? v : 0).toFixed(3).padStart(8); }
  function f6(v) { return (Number.isFinite(v) ? v : 0).toFixed(2).padStart(6); }

  function toPdb(atoms, chainIds) {
    const out = ['REMARK   1  Generated by StructBoard (view-only coordinates)'];
    const map = chainIds || {};
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      const ch = map[a.chain] || a.chain.slice(0, 1) || 'A';
      const resSeq = String(a.resSeq).replace(/[^0-9\-]/g, '').slice(-4) || String((i % 9999) + 1);
      const an = a.name.length >= 4 ? a.name.slice(0, 4) : (' ' + a.name).padEnd(4);
      const rec = a.het ? 'HETATM' : 'ATOM  ';
      out.push(
        rec + String(i + 1).padStart(5) + ' ' + an +
        (a.altLoc || ' ').slice(0, 1) +
        String(a.resName || 'UNK').padEnd(3).slice(0, 3) + ' ' +
        ch.slice(0, 1) + resSeq.padStart(4) + (a.iCode || ' ').slice(0, 1) + '   ' +
        f8(a.x) + f8(a.y) + f8(a.z) + f6(a.occ) + f6(a.b) +
        '          ' + String(a.element || 'C').padStart(2)
      );
    }
    out.push('TER');
    out.push('END');
    return out.join('\n');
  }

  /* ---------------- 内置示例数据 ---------------- */

  function rotPoint(p, cz, sz, cx, sx, off) {
    // 先绕 Y，再绕 Z，最后平移
    const x1 = cx * p[0] + sx * p[2];
    const y1 = p[1];
    const z1 = -sx * p[0] + cx * p[2];
    return [cz * x1 - sz * y1 + off[0], sz * x1 + cz * y1 + off[1], z1 + off[2]];
  }

  function helixBackbone(nRes, opts) {
    const o = opts || {};
    const R = o.radius || 2.3;
    const rise = o.rise || 1.5;
    const phase = (o.phase || 0) * Math.PI / 180;
    const rz = (o.rotZ || 0) * Math.PI / 180, ry = (o.rotY || 0) * Math.PI / 180;
    const cz = Math.cos(rz), sz = Math.sin(rz), cy = Math.cos(ry), sy = Math.sin(ry);
    const off = o.offset || [0, 0, 0];
    const atoms = [];
    const step = 100 * Math.PI / 180;
    const push = function (name, r, da, dz, i) {
      const t = phase + i * step + da;
      const p = [r * Math.cos(t), r * Math.sin(t), rise * i + dz];
      atoms.push({
        name, altLoc: '', resName: o.resName || 'ALA', chain: o.chain || 'A',
        resSeq: String(o.start || 1), iCode: '',
        x: 0, y: 0, z: 0, occ: 1, b: o.bfactor || 70, element: name[0],
        het: false, _raw: p,
      });
    };
    for (let i = 0; i < nRes; i++) {
      const idx = (o.start || 1) + i;
      push('N', R * 0.86, -0.42, -0.72, i);
      push('CA', R, 0, 0, i);
      push('C', R * 1.12, 0.46, 0.70, i);
      push('O', R * 1.30, 0.58, 1.28, i);
      push('CB', R * 1.34, -0.18, 0.15, i);
      for (let k = atoms.length - 5; k < atoms.length; k++) atoms[k].resSeq = String(idx);
    }
    return atoms.map(function (a) {
      const p = rotPoint(a._raw, cz, sz, cy, sy, off);
      a.x = p[0]; a.y = p[1]; a.z = p[2];
      delete a._raw;
      return a;
    });
  }

  function makeDemo() {
    const designs = [
      { name: 'design_001.pdb', n: 30, phase: 0, rotZ: 0, rotY: 0, offset: [0, 0, 0], b: 88 },
      { name: 'design_002.pdb', n: 30, phase: 12, rotZ: 7, rotY: -5, offset: [0.6, -0.4, 0.3], b: 76 },
      { name: 'design_003.pdb', n: 28, phase: -16, rotZ: -9, rotY: 8, offset: [-0.5, 0.7, -0.2], b: 64 },
      { name: 'design_004.pdb', n: 32, phase: 25, rotZ: 14, rotY: 12, offset: [1.0, 0.5, -0.6], b: 91 },
    ];
    return designs.map(function (d) {
      const atoms = helixBackbone(d.n, {
        phase: d.phase, rotZ: d.rotZ, rotY: 72 + d.rotY, offset: d.offset,
        chain: 'A', bfactor: d.b, start: 1,
      });
      const text = 'REMARK 900 ARTIFICIAL STRUCTBOARD DEMO; NOT RESEARCH DATA.\n' + toPdb(atoms);
      return {
        name: d.name,
        data: text,
        format: 'pdb',
        isBinary: false,
        size: text.length,
        demo: true,
      };
    });
  }

  global.SB_IO = {
    detectFormat, isStructureFile, readFile, parse, toPdb, makeDemo, stripGz, inflate,
    sequences, toFasta,
  };
})(window);
