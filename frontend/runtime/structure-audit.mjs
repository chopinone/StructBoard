// structure-audit: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function contentFingerprint(text) {
    const s = String(text || '');
    let h = 0x811c9dc5;
    const stride = s.length > 262144 ? 3 : 1; // 超大内容隔字节采样，足以区分坐标文本
    for (let i = 0; i < s.length; i += stride) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ s.length) >>> 0;
    return 'a' + h.toString(36) + '.' + s.length.toString(36);
  }
  function alignedVariant(entry, value) {
    const config = ports.paneRenderConfig(value), record = ports.alignedRecord(entry, config);
    return record ? config.referenceId + ':' + record.fingerprint : 'raw';
  }
  function thumbnailKey(entry, value) {
    const config = ports.paneRenderConfig(value);
    const color = config.theme === 'by-metric' ? ports.renderMetricColor(entry, config) : entry.color;
    const identity = entry.sourceKey || entry.fullPath || entry.path || (entry.name + ':' + (entry.size || 0));
    // Catalog source keys include physical path, size and nanosecond mtime.
    // Loading the same lazy file must not invalidate the cover currently being rendered.
    const contentVersion = entry.lazy && entry.fetchUrl && (entry.fileKey || entry.sourceKey)
      ? 'catalog-v2:' + (entry.fileKey || entry.sourceKey) + ':' + (entry.contentVersion || '')
      : ports.PANE_RUNTIME.contentVersion(entry);
    return [identity, contentVersion, alignedVariant(entry, config), config.theme,
      config.repr, color, config.dark ? 'dark' : 'light'].join('|');
  }
  function parityKey(node) {
    return node.id + '|' + node.entries.length;
  }
  function auditFlagFromTable(entry) {
    const l = entry && entry.lineage;
    if (l && typeof l.posePass === 'boolean') return l.posePass;
    const m = entry && entry.metrics;
    if (!m) return null;
    for (const name of Object.keys(m)) {
      if (!/^(pose_pass|position_pass|placement_pass|compliant|符合|位置符合)$/i.test(name)) continue;
      const v = m[name];
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return /^(1|true|yes|y|符合|通过|是|一致)$/i.test(String(v).trim());
    }
    return null;
  }
  function splitChains(entry) {
    const atoms = (entry && entry.parsed && entry.parsed.atoms) || [];
    const ca = atoms.filter(function (a) {
      return !a.het && a.name && a.name.toUpperCase() === 'CA' && Number.isFinite(a.x);
    });
    const byChain = new Map();
    for (const a of ca) {
      if (!byChain.has(a.chain)) byChain.set(a.chain, []);
      byChain.get(a.chain).push(a);
    }
    if (byChain.size < 2) return null;                 // 单链结构没有「相对位置」可比
    let binder = null, min = Infinity;
    for (const [chain, list] of byChain) {
      if (list.length < min) { min = list.length; binder = chain; }
    }
    const targets = Array.from(byChain.keys()).filter(function (c) { return c !== binder; });
    return { ca: ca, byChain: byChain, binder: binder, targets: targets };
  }
  function poseOnce(A, B, swapTargets) {
    const pick = function (split, chains, relabel) {
      return {
        atoms: split.ca.filter(function (a) { return chains.indexOf(a.chain) >= 0; }).map(function (a) {
          if (!relabel) return a;
          return { name: a.name, chain: relabel[a.chain] || a.chain, resSeq: a.resSeq, iCode: a.iCode, x: a.x, y: a.y, z: a.z };
        }),
      };
    };
    const align = ports.ALIGN.compute(pick(A, A.targets), pick(B, B.targets, swapTargets ? swapTargets.relabel : null));
    if (!align) return null;
    const refBinder = A.byChain.get(A.binder), movBinder = B.byChain.get(B.binder);
    const n = Math.min(refBinder.length, movBinder.length);
    if (n < 10 || Math.abs(refBinder.length - movBinder.length) > Math.max(4, refBinder.length * 0.1)) return null;
    let sum = 0, cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0;
    for (let i = 0; i < n; i++) {
      const a = refBinder[i], b = movBinder[i];
      const p = ports.ALIGN.transformPoint(align, [b.x, b.y, b.z]);
      const dx = p[0] - a.x, dy = p[1] - a.y, dz = p[2] - a.z;
      sum += dx * dx + dy * dy + dz * dz;
      cx += p[0]; cy += p[1]; cz += p[2];
      rx += a.x; ry += a.y; rz += a.z;
    }
    const rmsd = Math.sqrt(sum / n);
    const centroid = Math.sqrt(
      Math.pow(cx / n - rx / n, 2) + Math.pow(cy / n - ry / n, 2) + Math.pow(cz / n - rz / n, 2));
    return { rmsd: rmsd, centroid: centroid, atoms: n, targetRmsd: align.rmsd, swapped: !!swapTargets };
  }
  function poseDeviation(cover, entry) {
    const A = splitChains(cover), B = splitChains(entry);
    if (!A || !B) return null;
    if (A.targets.length !== B.targets.length) return null;
    const best = poseOnce(A, B, null);
    // 同源二聚体：两靶链残基数相同 → 允许 A/B 拷贝互换后再比一次
    if (A.targets.length === 2) {
      const [t0, t1] = A.targets;
      const lenA = (A.byChain.get(t0) || []).length, lenB = (A.byChain.get(t1) || []).length;
      if (lenA === lenB) {
        const relabel = {};
        relabel[B.targets[0]] = A.targets[1];
        relabel[B.targets[1]] = A.targets[0];
        const swapped = poseOnce(A, B, { relabel: relabel });
        if (swapped && (!best || swapped.rmsd < best.rmsd)) return swapped;
      }
    }
    return best;
  }
  function auditFlags(node) {
    return node.entries.map(function (e) {
      const f = auditFlagFromTable(e);
      return f === null ? 'n' : (f ? '1' : '0');
    }).join('');
  }
  function auditParsedSig(node) {
    return node.entries.map(function (e) { return e.parsed ? '1' : '0'; }).join('');
  }
  function auditFolderKey(node) { return parityKey(node) + '|' + auditFlags(node) + '|' + auditParsedSig(node); }
  function auditFolderNode(node) {
    const flags = node.entries.map(auditFlagFromTable);
    const key = auditFolderKey(node);
    const cached = ports.placementCache.get(key);
    if (cached) return cached;
    let result;
    if (flags.some(function (f) { return f !== null; })) {
      result = {
        pass: flags.filter(function (f) { return f === true; }).length,
        total: node.entries.length, source: 'table',
      };
    } else {
      const unparsed = node.entries.filter(function (e) { return !e.parsed && !e.isUrl; }).length;
      if (unparsed > 0) {
        result = {
          pass: null, total: node.entries.length, pending: unparsed, source: 'pending',
        };
      } else {
        const scores = [];
        let pass = 0;
        for (const e of node.entries) {
          if (e === node.cover) { scores.push(0); pass++; continue; }
          const dev = poseDeviation(node.cover, e);
          if (!dev) { scores.push(null); continue; }
          scores.push(Number(dev.rmsd.toFixed(2)));
          if (dev.rmsd <= ports.PLACEMENT_RMSD) pass++;
        }
        result = {
          pass: pass, total: node.entries.length, source: 'geometry',
          threshold: ports.PLACEMENT_RMSD, scores: scores,
        };
      }
    }
    ports.placementCache.set(key, result);
    return result;
  }
  function groupCover(entry) {
    if (!entry || !entry.group) return null;
    let cover = null, best = Infinity;
    for (const e of ports.S.entries) {
      if (!ports.LINEAGE.sameGroup(e, entry)) continue;
      const mi = (e.modelIndex === null || e.modelIndex === undefined) ? Infinity : e.modelIndex;
      if (mi < best) { best = mi; cover = e; }
    }
    return cover;
  }
  function entryPose(entry) {
    const l = entry.lineage || {};
    if (l.artifactKind && l.artifactKind !== 'prediction') return null;
    if (typeof l.posePass === 'boolean') return { source: 'table', pass: l.posePass, rmsd: l.poseRmsd, cover: '原设计参考', assessment: l.assessmentSource || '外部审计' };
    const cover = groupCover(entry);
    if (!cover) return null;
    if (cover === entry) return { source: 'cover', pass: true, cover: cover.name };
    const flag = auditFlagFromTable(entry);
    if (flag !== null) return { source: 'table', pass: flag, cover: cover.name };
    const key = entry.id + '|' + cover.id;
    const hit = ports.poseCache.get(key);
    if (hit) return hit;
    const dev = poseDeviation(cover, entry);
    if (!dev) return null;
    const result = {
      source: 'geometry', rmsd: dev.rmsd, pass: dev.rmsd <= ports.PLACEMENT_RMSD,
      threshold: ports.PLACEMENT_RMSD, cover: cover.name, swapped: !!dev.swapped,
    };
    ports.poseCache.set(key, result);
    return result;
  }
  function placementRows() {
    const wasGrouped = ports.S.overviewGrouped;
    let nodes;
    try { ports.S.overviewGrouped = true; nodes = ports.overviewNodes(ports.overviewEntries(), { layout: false }); }
    finally { ports.S.overviewGrouped = wasGrouped; }
    const rows = [];
    for (const n of nodes) {
      if (n.kind !== 'folder' || n.auditEnabled === false) continue;
      const audit = auditFolderNode(n);
      for (const e of n.entries) {
        const pose = entryPose(e);
        const pending = audit.source === 'pending' && (!pose || pose.source === 'cover' || !e.parsed);
        rows.push({
          node: n, entry: e, design: n.name, model: e.name,
          isCover: !!(pose && pose.source === 'cover'),
          pending: pending,
          pass: pending ? false : !!(pose && pose.pass),
          rmsd: (pose && pose.rmsd !== undefined) ? Number(pose.rmsd.toFixed(2)) : '',
          swapped: !!(pose && pose.swapped),
          source: audit.source,
          folderPass: audit.source === 'pending' ? '待核对' : audit.pass,
          folderTotal: audit.total,
        });
      }
    }
    return rows;
  }
  function exportPlacement() {
    const rows = placementRows();
    if (!rows.length) { ports.toast('当前没有按序列分组的结构（需 ≥2 个预测才成文件夹）', true); return; }
    const esc = function (v) {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['design', 'model', '位置符合', 'binder_CA_RMSD_A', '镜像拷贝映射', '该序列符合数', '该序列预测总数', '判据来源', '优选'];
    const out = [header];
    for (const r of rows) {
      out.push([
        r.design, r.model,
        r.pending ? '待核对' : (r.isCover ? '封面(基准)' : (r.pass ? '符合' : '不符')),
        r.rmsd, r.swapped ? '是' : '否',
        r.folderPass, r.folderTotal,
        r.source === 'table' ? '指标表' : (r.source === 'pending' ? '待读取' : '本地几何'),
        r.entry.star ? '★' : '',
      ]);
    }
    const csv = '\uFEFF' + out.map(function (row) { return row.map(esc).join(','); }).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'structboard-placement-audit-' + Date.now() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    const designs = new Set(rows.map(function (r) { return r.design; }));
    ports.toast('已导出位置审计：' + designs.size + ' 个序列 / ' + rows.length + ' 个预测');
  }
  function starPassing() {
    const rows = placementRows();
    const targets = rows.filter(function (r) { return r.pass && !r.entry.star; });
    if (!rows.length) { ports.toast('当前没有按序列分组的结构', true); return; }
    if (!targets.length) {
      ports.toast(rows.some(function (r) { return r.pending; })
        ? '部分结构尚未读取坐标，先展开文件夹或对齐后再标记优选'
        : '符合位置的预测已经全部标为优选');
      return;
    }
    for (const r of targets) { r.entry.star = true; r.entry.starManual = true; }
    ports.saveMarks();
    ports.renderList();
    ports.refreshBadge();
    if (ports.S.mode === 'overview') ports.rebuildOverview();
    ports.toast('已把 ' + targets.length + ' 个符合位置的预测标为优选（共 ' + rows.length + ' 个预测）');
  }
// SERVICE_FUNCTIONS_END
  return { contentFingerprint, alignedVariant, thumbnailKey, parityKey, auditFlagFromTable, splitChains, poseOnce, poseDeviation, auditFlags, auditParsedSig, auditFolderKey, auditFolderNode, groupCover, entryPose, placementRows, exportPlacement, starPassing };
}
