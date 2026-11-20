// structure-data: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function entryPath(entry) {
    return (entry && (entry.fullPath || entry.path)) || '';
  }
  function parentDir(path) {
    const norm = String(path || '').replace(/\\/g, '/');
    const cut = norm.lastIndexOf('/');
    return cut > 0 ? norm.slice(0, cut) : '';
  }
  function makeLocalFileNode(rest, key) {
    const counts = new Map();
    for (const entry of rest) {
      const dir = parentDir(entry.fullPath || entry.path);
      if (!dir) continue;
      counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    let dir = '', best = 0;
    for (const [path, n] of counts) if (n > best) { dir = path; best = n; }
    return {
      kind: 'localfile',
      id: 'localfile:' + (key || dir || 'rest'),
      name: dir ? dir.split('/').pop() : '本地目录',
      path: dir,
      fullPath: /^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(dir) ? dir : '',
      remain: rest.length,
    };
  }
  function capOverviewCards(cards, entries, key) {
    if (cards.length <= 100) return cards;
    const shown = cards.slice(0, 100);
    const seen = new Set();
    for (const card of shown) {
      if (card.kind === 'folder') card.entries.forEach(function (entry) { seen.add(entry.id); });
      else if (card.entry) seen.add(card.entry.id);
    }
    const rest = entries.filter(function (entry) { return !seen.has(entry.id); });
    if (!rest.length) return shown;
    shown.unshift(makeLocalFileNode(rest, key));
    return shown;
  }
  function entryOrgKey(entry) {
    if (!entry) return '';
    if (ports.ORG && ports.ORG.placeId) return ports.ORG.placeId(entry);
    return entry.sourceKey || entry.fileKey || [entry.fullPath || entry.path || '', entry.name || '', entry.size || 0].join('|');
  }
  function stepIsTrashed(key) {
    return (ports.S.trashSteps || []).some(function (item) { return item && item.key === key; });
  }
  function entryIsTrashed(entry) {
    if (!entry) return false;
    const stepKey = entry.stepKey || 'plain';
    if (stepIsTrashed(stepKey)) return true;
    const key = entryOrgKey(entry);
    const folderHit = (ports.S.trashFolders || []).some(function (item) {
      return item && Array.isArray(item.entryKeys) && item.entryKeys.indexOf(key) >= 0;
    });
    if (folderHit) return true;
    const org = ports.S.organization[stepKey];
    return !!(org && key && Array.isArray(org.removed) && org.removed.indexOf(key) >= 0);
  }
  function loadMarks() {
    try { return JSON.parse(localStorage.getItem(ports.MARKS_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function activePipelineId() {
    if (ports.S.activePipelineId) return ports.S.activePipelineId;
    const hit = ports.S.entries.find(function (e) { return !!e.pipelineId; });
    return hit ? hit.pipelineId : '';
  }
  function scheduleMarksSync() {
    const pid = activePipelineId(), epoch = ports.S.workspaceEpoch || 0;
    if (!pid) return;
    clearTimeout(ports.marksSyncTimer);
    ports.marksSyncTimer = setTimeout(function () {
      ports.marksSyncTimer = 0;
      if ((ports.S.workspaceEpoch || 0) !== epoch || activePipelineId() !== pid) return;
      const starred = ports.S.entries.filter(function (e) { return e.pipelineId === pid && e.star; }).map(function (e) {
        return {
          name: e.name,
          path: e.path || '',
          fullPath: e.fullPath || '',
          stepKey: e.stepKey || '',
          stepTitle: e.stepTitle || '',
          group: e.group || '',
          modelIndex: e.modelIndex,
          metrics: e.metrics || null,
        };
      });
      ports.notesSync.put(pid, { __structboard_marks__: { updatedAt: new Date().toISOString(), count: starred.length, items: starred } });
    }, 450);
  }
  function saveMarks() {
    const m = loadMarks();
    for (const e of ports.S.entries) {
      if (e.starManual) m[e.sourceKey ? 'source:' + e.sourceKey : e.name + '|' + e.size] = e.star ? 1 : 0;
    }
    try { localStorage.setItem(ports.MARKS_KEY, JSON.stringify(m)); } catch (err) { /* ignore */ }
    scheduleMarksSync();
    if (!ports.S.restoringSession) ports.scheduleSessionSave();
  }
  function toggleStar(entry, on) {
    entry.star = (on === undefined) ? !entry.star : !!on;
    entry.starManual = true;
    saveMarks();
    ports.renderList();
    ports.refreshSharedPaneViews({ entry: entry });
    ports.status(entry.star ? '★ 已标优选：' + entry.name : '已取消优选：' + entry.name);
  }
  function starCount() {
    return ports.S.entries.filter(function (e) { return e.star; }).length;
  }
  function extractScoreRow(fileName, text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const row = { design: String(fileName).replace(/\.json(\.gz)?$/i, '') };
    const PRE = ['ranking_score', 'iptm', 'ptm', 'confidence_score', 'aggregate_score',
      'complex_plddt', 'complex_iptm', 'protein_iptm', 'ligand_iptm',
      'fraction_disordered', 'has_clash'];
    let n = 0;
    const put = function (k, v) {
      if (n >= 14 || row[k] !== undefined || k.length > 40) return;
      row[k] = Math.round(v * 1e6) / 1e6;
      n++;
    };
    for (const k of PRE) {
      const v = d[k];
      if (typeof v === 'number' && Number.isFinite(v)) put(k, v);
      else if (typeof v === 'boolean') row[k] = v ? 1 : 0;
    }
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'number' && /plddt/i.test(k)) {
        let s = 0;
        for (const x of v) s += x;
        put(k + '_mean', s / v.length);
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) put(k, v);
    }
    return n >= 1 ? row : null;
  }
  function plddtRow(raw) {
    if (!raw || !raw.parsed || !raw.parsed.atoms || !raw.parsed.atoms.length) return null;
    let s = 0, n = 0;
    for (const a of raw.parsed.atoms) {
      if (a.b > 0) { s += a.b; n++; }
    }
    if (!n) return null;
    return { design: raw.name, plddt_mean: Math.round(s / n * 10) / 10 };
  }
  function autoApplyScores(newRows) {
    if (!newRows || !newRows.length) return;
    if (ports.S.metrics.table && !ports.S.metrics.auto) {
      ports.status('检测到 ' + newRows.length + ' 行 AF3/Boltz 分数，但已存在手动导入的指标表，未覆盖');
      return;
    }
    const merged = new Map();
    const pushRow = function (r) {
      const k = ports.METRICS.normalizeName(r.design);
      if (!k) return;
      const old = merged.get(k) || {};
      for (const key of Object.keys(r)) {
        if (key !== 'design' && r[key] !== undefined) old[key] = r[key];
      }
      old.design = old.design || r.design;
      merged.set(k, old);
    };
    for (const r of ports.S.autoScoreRows) pushRow(r);
    for (const r of newRows) pushRow(r);
    ports.S.autoScoreRows = [...merged.values()];

    const cols = ['design'];
    for (const r of ports.S.autoScoreRows) {
      for (const k of Object.keys(r)) {
        if (k !== 'design' && cols.indexOf(k) < 0) cols.push(k);
      }
    }
    const lines = [cols.join(',')];
    for (const r of ports.S.autoScoreRows) {
      lines.push(cols.map(function (c) {
        const v = r[c];
        return (v === undefined || v === null) ? '' : String(v);
      }).join(','));
    }
    const table = ports.METRICS.parse(lines.join('\n'), 'auto_scores.csv');
    if (!table) return;
    ports.S.metrics.table = table;
    ports.S.metrics.fileName = '自动解析 · AF3/Boltz 分数';
    ports.S.metrics.auto = true;
    ports.S.metrics.filters = [];
    const guess = ports.guessPrimary(table);
    ports.S.metrics.primary = guess.col;
    ports.S.metrics.higher = guess.higher;
    ports.S.metrics.matched = ports.METRICS.attach(table, ports.S.entries);
    ports.recomputeMetricRange();
    ports.renderMetricUI();
    ports.renderList();
  }
  function passesMetrics(e) {
    const m = ports.S.metrics;
    if (!m.table || !m.filters.length) return true;
    if (!e.metrics) return false;
    for (const f of m.filters) {
      const v = e.metrics[f.col];
      if (!Number.isFinite(v)) return false;
      if (f.op === '>=' && !(v >= f.value)) return false;
      if (f.op === '<=' && !(v <= f.value)) return false;
      if (f.op === '>' && !(v > f.value)) return false;
      if (f.op === '<' && !(v < f.value)) return false;
      if (f.op === '=' && v !== f.value) return false;
    }
    return true;
  }
  function metricValue(e) {
    if (!ports.S.metrics.primary || !e.metrics) return null;
    const v = e.metrics[ports.S.metrics.primary];
    return Number.isFinite(v) ? v : null;
  }
  function metricText(e) {
    const v = metricValue(e);
    if (v === null) return '';
    const n = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return ports.S.metrics.primary + ' ' + n;
  }
  function metricColor(e) {
    if (!e || !ports.S.metrics.range) return 0x8b98a5;
    const v = metricValue(e);
    if (v === null) return 0x8b98a5;
    return ports.METRICS.colorScale(v, ports.S.metrics.range.min, ports.S.metrics.range.max, ports.S.metrics.higher);
  }
  function sortByMetric(list) {
    if (ports.S.manualOrder) return list;
    const ordered = list.slice().sort(function (a, b) {
      if (!!a.star !== !!b.star) return a.star ? -1 : 1;
      if (!ports.S.metrics.table || !ports.S.metrics.primary) return 0;
      const va = metricValue(a), vb = metricValue(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return ports.S.metrics.higher ? vb - va : va - vb;
    });
    return ordered;
  }
  function inActiveGroup(e) {
    if (ports.S.activeGroupId === 'all') return true;
    const g = ports.S.groups.find(function (x) { return x.id === ports.S.activeGroupId; });
    return !!g && g.entryIds.indexOf(e.id) >= 0;
  }
  function visibleEntries() {
    if (ports.S.soloId && ports.S.lineageReferenceId === ports.S.soloId) {
      const parent = ports.S.entries.find(e => e.id === ports.S.soloId);
      return parent ? [parent] : [];
    }
    let list = ports.S.entries.filter(function (e) {
      return !entryIsTrashed(e) && e.visible && inActiveGroup(e) && (!ports.S.starOnly || e.star) &&
        (!ports.S.filter || e.name.toLowerCase().indexOf(ports.S.filter) >= 0) && passesMetrics(e);
    });
    if (ports.S.soloId) {
      const only = list.find(function (e) { return e.id === ports.S.soloId; });
      list = only ? [only] : [];
    }
    return sortByMetric(list);
  }
  function formatLabel(e) {
    if (e.isUrl) return '远程';
    return (e.format || 'pdb').toUpperCase();
  }
  function pipelineCatalogRaw(item, manifest, pipelineId, stepId, stepIndex) {
    const formatPath = item.path || item.fullPath || item.name || '';
    return {
      name: item.name || String(formatPath).replace(/\\/g, '/').split('/').pop(),
      path: item.fullPath || item.path, fullPath: item.fullPath || '',
      size: item.size || 0, star: !!item.star, sourceKey: item.sourceKey,
      group: item.group || null, modelIndex: item.modelIndex == null ? null : item.modelIndex,
      ...ports.LINEAGE.meta(item),
      stepOperation: manifest.operation || '', stepState: manifest.state || '', stepDesc: manifest.desc || '',
      format: /\.bcif(\.gz)?$/i.test(formatPath) ? 'bcif'
        : (/\.(cif|mmcif|mcif)(\.gz)?$/i.test(formatPath) ? 'mmcif' : 'pdb'),
      parsed: null, data: null, lazy: true,
      fetchUrl: '/api/pipeline/structure?id=' + encodeURIComponent(pipelineId)
        + '&step=' + encodeURIComponent(stepId) + '&path=' + encodeURIComponent(item.path),
      stepKey: pipelineId + ':' + stepId, stepIndex: stepIndex,
      stepTitle: manifest.title || stepId, stepTool: manifest.tool || '', pipelineId: pipelineId,
      sessionMembershipVersion: window.SB_SESSION_MIGRATION.VERSION,
    };
  }
  function preparePipelineWorkspace(definition, manifests) {
    if (!definition || !definition.id || !Array.isArray(definition.steps) || !definition.steps.length) {
      throw Error('管线定义没有有效步骤');
    }
    const raws = [], customSteps = [], seenSteps = new Set(), seenSources = new Set();
    definition.steps.forEach(function (step, index) {
      if (!step || !step.id || seenSteps.has(step.id)) throw Error('管线步骤标识缺失或重复');
      seenSteps.add(step.id);
      const manifest = manifests[index];
      if (!manifest || !Array.isArray(manifest.files) || (manifest.stepId && manifest.stepId !== step.id)) {
        throw Error('步骤清单不完整：' + (step.title || step.id));
      }
      const key = definition.id + ':' + step.id;
      customSteps.push({ key: key, title: step.title || manifest.title || step.id,
        tool: step.tool || manifest.tool || '', index: index, order: index,
        pipelineId: definition.id, pipelineStep: true });
      manifest.files.forEach(function (item) {
        if (!item || !item.sourceKey || !item.path || seenSources.has(item.sourceKey)) {
          throw Error('步骤成员标识缺失或重复：' + (step.title || step.id));
        }
        seenSources.add(item.sourceKey);
        const raw = pipelineCatalogRaw(item, manifest, definition.id, step.id, index);
        raw.stepTitle = customSteps[index].title; raw.stepTool = customSteps[index].tool;
        raws.push(raw);
      });
    });
    if (!raws.length) throw Error('这些步骤里没有可显示的结构，原工作区已保留');
    const prepared = addEntries(raws, '', { replace: true, prepareOnly: true });
    const organization = {};
    if (ports.ORG) ports.ORG.ingestDefinition(organization, definition, prepared.entries);
    const idsByStep = new Map(customSteps.map(function (step) { return [step.key, []]; }));
    prepared.entries.forEach(function (entry) { idsByStep.get(entry.stepKey).push(entry.id); });
    const groups = customSteps.map(function (step, index) {
      return { id: 'g' + (index + 1), name: step.title, pipelineKey: step.key, stepIndex: index,
        createdAt: Date.now(), entryIds: idsByStep.get(step.key) };
    });
    return { entries: prepared.entries, seq: prepared.seq, groups: groups, groupSeq: groups.length,
      customSteps: customSteps, organization: organization, trashFolders: [], trashSteps: [],
      activePipelineId: definition.id,
      activePipelineName: definition.name || definition.id,
      definitionFingerprints: { [definition.id]: window.SB_SESSION_MIGRATION.fingerprint(definition) } };
  }
  function hasWorkspaceContent(workspace) {
    return !!(workspace.entries.length || workspace.groups.length || workspace.customSteps.length
      || workspace.trashFolders.length || workspace.trashSteps.length || Object.keys(workspace.organization).length);
  }
  function publishPipelineWorkspace(prepared, ownerPane) {
    ports.rawS.workspaceEpoch = (ports.rawS.workspaceEpoch || 0) + 1;
    ports.cancelPipelineSync();
    clearTimeout(ports.marksSyncTimer); ports.marksSyncTimer = 0;
    Object.assign(ports.rawS, prepared, {
      localWorkspaceId: '',
      migrationPending: false, migrationReport: null,
      autoScoreRows: [], metrics: { table: null, primary: '', higher: true, filters: [], range: null,
        matched: 0, fileName: '', auto: false },
    });
    ports.updatePipelineIdentity(ports.rawS.activePipelineName || ports.rawS.activePipelineId);
    if (ports.ORG) ports.ORG.clearHistory();
    for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
      Object.assign(pane.view, { filter: '', starOnly: false, manualOrder: false,
        trashOpen: false, trashReturnPlace: null, page: 0, listNav: null, activeGroupId: 'all' });
      if (pane.view.theme === 'by-metric') pane.view.theme = 'per-structure';
    }
    const clearing = ports.resetSharedPaneViews();
    ports.saveCustomSteps();
    ports.restoreFolderNotes();
    const target = ports.PANE_RUNTIME.alive(ownerPane) ? ownerPane : ports.paneAt();
    ports.withPaneSync(target, function () {
      ports.$('searchInput').value = '';
      ports.renderMetricUI(); ports.renderGroups(); ports.renderList(); ports.refreshReferenceSelect(); ports.refreshBadge();
      ports.setMode('overview', { skipSessionSave: true }, target);
    });
    ports.saveLastSessionMeta();
    ports.pipelineTabs.add({ id: ports.rawS.activePipelineId, name: ports.rawS.activePipelineName || ports.rawS.activePipelineId }, true);
    ports.sessionStore.setKey(ports.pipelineWorkspaceKey(ports.rawS.activePipelineId));
    ports.renderPipelineTabs();
    const epoch = ports.rawS.workspaceEpoch;
    clearing.then(function () {
      if (ports.rawS.workspaceEpoch === epoch) return ports.applyAllPaneModes(true);
    }).catch(function (error) { console.error('[StructBoard] 刷新管线视图失败', error); });
    ports.hydrateStepNotesFromPipeline(prepared.activePipelineId);
  }
  function addEntries(rawList, groupName, opts) {
    opts = opts || {};
    const fresh = [];
    const current = opts.replace ? [] : ports.S.entries;
    let seq = ports.S.seq;
    const seen = new Set(current.map(function (e) { return e.sourceKey || e.name + ':' + e.size; }));
    const marks = loadMarks();
    for (const raw of rawList) {
      if (!raw || !raw.name) continue;
      const key = raw.sourceKey || raw.name + ':' + (raw.size || (raw.data ? String(raw.data).length : 0));
      if (seen.has(key)) continue;
      seen.add(key);
      const legacyMarkKey = raw.name + '|' + (raw.size || (raw.data ? String(raw.data).length : 0));
      const scopedMarkKey = raw.sourceKey ? 'source:' + raw.sourceKey : legacyMarkKey;
      const markKey = Object.prototype.hasOwnProperty.call(marks, scopedMarkKey) ? scopedMarkKey : legacyMarkKey;
      const hasManualMark = Object.prototype.hasOwnProperty.call(marks, markKey);
      const idx = current.length + fresh.length;
      const entry = {
        id: 'e' + (++seq),
        name: raw.name,
        data: raw.data,
        format: raw.format || 'pdb',
        isBinary: !!raw.isBinary,
        isUrl: !!raw.isUrl,
        url: raw.url || '',
        size: raw.size || (raw.data ? String(raw.data).length : 0),
        color: Number.isInteger(raw.color) && raw.color >= 0 && raw.color <= 0xffffff ? raw.color : ports.PALETTE[idx % ports.PALETTE.length],
        visible: raw.visible !== false,
        // 只有「正文还没到」的懒条目才标记为未解析。复制/派生出来的条目可能带着
        // 已加载正文（例如作为封面提前加载过的 model_0），这时必须保留解析结果，
        // 否则它会一直绕过对齐，走与同夹其它模型不同的数据路径。
        _parsed: (raw.isUrl || (raw.lazy && !raw.data)) ? null : (raw.parsed !== undefined ? raw.parsed : undefined),
        alignedData: null,
        alignInfo: null,
        demo: !!raw.demo,
        path: raw.path || raw.name,
        fullPath: raw.fullPath || raw.path || '',
        sourceKey: raw.sourceKey || null,
        group: raw.group || null,
        modelIndex: (raw.modelIndex === undefined || raw.modelIndex === null) ? null : raw.modelIndex,
        ...ports.LINEAGE.meta(raw),
        renamed: !!raw.renamed,
        sessionMembershipVersion: raw.sessionMembershipVersion || 0,
        star: hasManualMark ? !!marks[markKey] : !!raw.star,
        starManual: hasManualMark || !!raw.starManual,
        lazy: !!raw.lazy,
        fetchUrl: raw.fetchUrl || '',
        stepKey: raw.stepKey || opts.stepKey || '',
        stepIndex: Number.isFinite(raw.stepIndex) ? raw.stepIndex : (Number.isFinite(opts.stepIndex) ? opts.stepIndex : 0),
        stepTitle: raw.stepTitle || opts.stepTitle || '',
        stepTool: raw.stepTool || opts.stepTool || '',
        pipelineId: raw.pipelineId || opts.pipelineId || '',
      };
      Object.defineProperty(entry, 'parsed', {
        get: function () {
          if (this._parsed !== undefined) return this._parsed;
          if (this.data && typeof this.data === 'string' && this.format !== 'bcif') {
            try { this._parsed = ports.IO.parse(this.data, this.format); } catch (_) { this._parsed = null; }
          } else {
            this._parsed = null;
          }
          return this._parsed;
        },
        set: function (v) { this._parsed = v; },
        configurable: true,
        enumerable: true,
      });
      fresh.push(entry);
    }
    if (!fresh.length && !opts.replace) {
      if (!opts.quiet) ports.toast('没有新结构（可能重复或格式不支持）');
      return;
    }
    // Construct the complete replacement before changing the shared workspace.
    if (opts.prepareOnly) return { entries: fresh, seq: seq };
    ports.S.seq = seq;
    ports.S.entries = current.concat(fresh);
    if (ports.S.metrics.table) {
      ports.S.metrics.matched = ports.METRICS.attach(ports.S.metrics.table, ports.S.entries);
      ports.refreshMetricsStatus();
    }
    if (ports.S.aligned) {
      ports.paneAt().runtime.alignment.clear();
      ports.S.aligned = false;
    }
    if (ports.S.referenceId === null) ports.S.referenceId = ports.S.entries[0].id;

    let toastName = groupName || defaultImportName();
    if (opts.perEntryGroup) {
      // AF3 批量包：一个设计 = 一个文件夹
      const byGroup = new Map();
      for (const e of fresh) {
        const gname = e.group || toastName;
        if (!byGroup.has(gname)) byGroup.set(gname, []);
        byGroup.get(gname).push(e.id);
      }
      let first = true;
      for (const [gname, ids] of byGroup) {
        const g = createGroup(gname, ids, false);
        if (first) { ports.S.activeGroupId = g.id; toastName = g.name; first = false; }
      }
    } else if (opts.group !== false) {
      toastName = createGroup(toastName,
        fresh.map(function (e) { return e.id; }), true).name;
    }
    if (!opts.skipSessionSave) ports.scheduleSessionSave();
    if (opts.deferRender) return;
    ports.S.soloId = null;
    ports.resetGridNavigation();
    ports.renderGroups();
    ports.refreshReferenceSelect();
    ports.renderList();
    if (opts.rebuild !== false) ports.refreshSharedPaneViews();
    const visible = visibleEntries().length;
    if (!visible) {
      ports.toast('已导入 ' + fresh.length + ' 个结构，但当前筛选条件把全部结构筛掉了，点指标面板「清除」重置');
    } else if (ports.S.entries.length > 50) {
      ports.toast('共 ' + ports.S.entries.length + ' 个结构 · 叠加视图默认只载入前 ' +
        (ports.S.maxOverlay || ports.S.entries.length) + ' 个；用分屏网格或点列表单独查看其余');
    } else {
      ports.toast('已导入 ' + fresh.length + ' 个结构 → 文件夹「' + toastName + '」');
    }
  }
  function removeEntry(id) {
    const entry = ports.S.entries.find(function (e) { return e.id === id; });
    if (!entry) return;
    const stepKey = entry.stepKey || 'plain';
    if (ports.ORG) ports.ORG.removeKeys(ports.S.organization, stepKey, [entryOrgKey(entry)]);
    const card = document.querySelector('[data-entry-id="' + id + '"]');
    const pane = ports.paneAt();
    ports.animateTrashFlight([card].filter(Boolean), function () {
      for (const target of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
        if (target.view.referenceId === id) {
          const ref = ports.rawS.entries.find(function (entry) { return entry.id !== id && !entryIsTrashed(entry); });
          target.view.referenceId = ref ? ref.id : null; target.view.aligned = false;
          target.runtime.alignment.clear(); ports.PANE_RUNTIME.invalidate(target, 'align');
        }
        if (target.view.soloId === id) target.view.soloId = null;
      }
      for (const group of ports.rawS.groups) group.entryIds = group.entryIds.filter(function (key) { return key !== id; });
      if (ports.PANE_RUNTIME.alive(pane)) ports.withPaneSync(pane, function () { ports.renderGroups(); ports.refreshReferenceSelect(); });
      ports.renderList(); ports.refreshSharedPaneViews();
      ports.scheduleSessionSave();
    });
  }
  function defaultImportName() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return '导入 ' + (ports.S.groups.length + 1) + ' · ' + hh + ':' + mm;
  }
  function createGroup(name, entryIds, switchTo) {
    const g = {
      id: 'g' + (++ports.S.groupSeq),
      name: name || defaultImportName(),
      entryIds: entryIds || [],
      createdAt: Date.now(),
    };
    ports.S.groups.push(g);
    if (switchTo) ports.S.activeGroupId = g.id;
    ports.renderGroups();
    return g;
  }
  function onColorChange(entry, hex) {
    entry.color = ports.colorOf(hex);
    ports.renderList();
    ports.refreshSharedPaneViews({ entry: entry });
  }
  function toggleVisible(entry) {
    entry.visible = !entry.visible;
    ports.renderList();
    ports.refreshSharedPaneViews({ entry: entry });
  }
  function setReference(entry, value) {
    const pane = ports.paneAt(value), state = ports.paneContext(pane);
    if (!entry || !ports.PANE_RUNTIME.alive(pane)) return;
    const wasAligned = state.aligned;
    state.referenceId = entry.id;
    ports.PANE_RUNTIME.invalidate(pane, 'align'); pane.runtime.alignment.clear();
    state.aligned = wasAligned;
    const sel = ports.paneElement(pane, 'selReference');
    if (sel) sel.value = entry.id;
    ports.withPaneSync(pane, function () {
      if (ports.panes[ports.activePane] === pane) ports.renderList();
      ports.refreshAlignBtn(pane); ports.refreshBadge();
      if (wasAligned) ports.applyModeChange(true, pane);
      else if (typeof ports.syncPaneControls === 'function') ports.syncPaneControls(pane);
    });
    if (!ports.rawS.restoringSession) ports.scheduleSessionSave();
    ports.toast('参考结构：' + entry.name + '（对齐时它保持原位，其余结构按它叠加）');
  }
  function setAllVisible(v) {
    ports.S.entries.forEach(function (e) { e.visible = v; });
    ports.renderList(); ports.refreshSharedPaneViews();
  }
// SERVICE_FUNCTIONS_END
  return { entryPath, parentDir, makeLocalFileNode, capOverviewCards, entryOrgKey, stepIsTrashed, entryIsTrashed, loadMarks, activePipelineId, scheduleMarksSync, saveMarks, toggleStar, starCount, extractScoreRow, plddtRow, autoApplyScores, passesMetrics, metricValue, metricText, metricColor, sortByMetric, inActiveGroup, visibleEntries, formatLabel, pipelineCatalogRaw, preparePipelineWorkspace, hasWorkspaceContent, publishPipelineWorkspace, addEntries, removeEntry, defaultImportName, createGroup, onColorChange, toggleVisible, setReference, setAllVisible };
}
