// file-import: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  async function desktopPickFiles(asFolder, exts) {
    const picked = await window.__SB_DESKTOP_INVOKE__('desktop_pick_paths', { folder: !!asFolder, exts: exts || [] });
    const out = [];
    for (const item of (Array.isArray(picked) ? picked : [])) {
      const r = await fetch('/api/local/read?path=' + encodeURIComponent(item.path));
      if (!r.ok) {
        let message = '读取失败';
        try { message = (await r.json()).error || message; } catch (_) { /* 保留默认文案 */ }
        throw new Error(message);
      }
      const buf = await r.arrayBuffer();
      const file = new File([buf], (item.rel_path || '').split('/').pop() || 'structure');
      try { Object.defineProperty(file, 'webkitRelativePath', { value: item.rel_path || item.path }); } catch (_) { /* 老内核不认就算了 */ }
      try { Object.defineProperty(file, 'fullPath', { value: item.path }); } catch (_) { /* 同上 */ }
      out.push(file);
    }
    return out;
  }
  async function pickImport(asFolder, stepKey) {
    const stepFlow = !!stepKey; // '__pending__' = pendingStepTarget 已由新步骤弹窗布好
    if (!window.__SB_DESKTOP_INVOKE__) {
      // 浏览器路径：沿用 input[type=file] 的原生对话框
      if (stepFlow && stepKey !== '__pending__') {
        ports.pendingStepTarget = { mode: 'append', stepKey: stepKey };
      }
      ports.$(asFolder ? 'stepFolderInput' : 'stepFileInput').click();
      return;
    }
    let files;
    try {
      files = await desktopPickFiles(asFolder,
        asFolder ? [] : ['pdb', 'ent', 'cif', 'mmcif', 'mcif', 'bcif', 'pdbx', 'gz', 'zip', 'txt']);
    } catch (err) {
      ports.toast((err && err.message) || '打不开文件选择框', true);
      return;
    }
    if (!files.length) return;
    if (stepFlow && window.__SB_STEP_PICK__) return window.__SB_STEP_PICK__(files, asFolder);
    if (asFolder) {
      const top = (files[0].webkitRelativePath || '').split('/')[0] || '';
      return importFiles(files, top);
    }
    return importFiles(files);
  }
  async function pickImportMetrics() {
    if (!window.__SB_DESKTOP_INVOKE__) { ports.$('metricsInput').click(); return; }
    let files;
    try { files = await desktopPickFiles(false, ['csv', 'tsv', 'txt', 'json']); }
    catch (err) { ports.toast((err && err.message) || '打不开文件选择框', true); return; }
    if (files.length) ports.importMetrics(files);
  }
  function triggerStepImport(stepKey, asFolder) {
    ports.pendingStepTarget = { mode: 'append', stepKey: stepKey };
    pickImport(asFolder, stepKey);
  }
  async function importDropIntoStep(dt, stepKey) {
    const steps = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    let step = stepKey && stepKey !== 'plain' ? steps.find(function (s) { return s.key === stepKey; }) : null;
    const files = [];
    const failed = [];
    const items = Array.from((dt && dt.items) || []);
    const dtEntries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (dtEntries.length) {
      for (const e of dtEntries) await traverseEntry(e, files, 0, failed);
      if (failed.length) ports.note('文件夹里有 ' + failed.length + ' 个文件读不到', true);
    } else if (dt && dt.files) {
      for (const f of dt.files) files.push(f);
    }
    if (!files.length) return;
    if (stepKey === '__new__') {
      const topName = (dtEntries.length === 1 && dtEntries[0].isDirectory) ? dtEntries[0].name : '';
      const rec = ports.createCustomStep({ title: topName || ('导入步骤 ' + (steps.length + 1)) });
      step = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === rec.key; }) || rec;
    }
    if (!step) {
      await importFiles(files);
      return;
    }
    await importFiles(files, step.title, {
      group: false,
      stepKey: step.key,
      stepIndex: Number.isFinite(step.order) ? step.order : (step.displayIndex * 10),
      stepTitle: step.title,
      stepTool: step.tool || '',
      pipelineId: step.pipelineId || ports.activePipelineId(),
    });
    ports.renderList();
    if (ports.S.mode === 'overview') ports.rebuildOverview();
  }
  async function importFiles(fileList, suggestedName, opts) {
    if (ports.pipelineTabBusy) return;
    ports.localImportBusy++;
    try { return await importFilesIntoCurrentTab(fileList, suggestedName, opts); }
    finally { ports.localImportBusy--; }
  }
  async function importFilesIntoCurrentTab(fileList, suggestedName, opts) {
    opts = opts || {};
    const all = Array.from(fileList || []);
    const zips = all.filter(function (f) { return /\.zip$/i.test(f.name); });
    const files = all.filter(function (f) { return ports.IO.isStructureFile(f.name); });
    const scoreJsons = all.filter(function (f) {
      return /\.json$/i.test(f.name) && !ports.IO.isStructureFile(f.name);
    });
    if (zips.length) await importZipFiles(zips, opts);
    if (!files.length) {
      if (!zips.length && !scoreJsons.length) {
        ports.toast('没有找到 .pdb / .cif / .cif.gz / .zip 文件', true);
      }
      return;
    }
    let groupName = suggestedName || '';
    if (!groupName && files[0].webkitRelativePath) {
      groupName = files[0].webkitRelativePath.split('/')[0];
    }
    ports.status('正在读取 ' + files.length + ' 个文件…');
    if (files.length >= 20) ports.setLoadProgress('读取结构文件', 0, '0 / ' + files.length);
    const raws = [];
    const failed = [];
    let completed = 0;
    const CONCURRENCY = 24;
    let cursor = 0;
    async function readWorker() {
      while (cursor < files.length) {
        const file = files[cursor++];
        if (!file) break;
        try {
          const raw = await ports.IO.readFile(file);
          raw.parsed = undefined; // 延迟按需解析，大幅提升导入速度
          raws.push(raw);
        } catch (e) {
          failed.push(file.name + '（' + (e && e.message ? e.message : e) + '）');
        }
        completed++;
        if (completed % 15 === 0 || completed === files.length) {
          const pct = Math.round((completed / files.length) * 100);
          if (files.length >= 20) ports.setLoadProgress('读取结构文件', pct, completed + ' / ' + files.length);
          ports.status('已读取 ' + completed + ' / ' + files.length);
          await ports.sleep(0);
        }
      }
    }
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, files.length); w++) {
      workers.push(readWorker());
    }
    await Promise.all(workers);
    if (files.length >= 20) ports.hideLoadProgress();
    if (failed.length) {
      ports.note(files.length + ' 个文件里 ' + failed.length + ' 个读取失败：' +
        failed.slice(0, 2).join('；'), true);
    }
    if (!raws.length) {
      ports.note('文件找到了但一个都读不出来：检查源文件是否被移动、是否下载完整、或权限是否足够', true);
      return;
    }
    ports.status('正在建立结构列表…');
    ports.addEntries(raws, groupName, opts);

    // 自动解析同目录的 AF3 / Boltz-2 分数 JSON + 结构自身的 pLDDT
    const rows = [];
    let scoreHits = 0;
    if (scoreJsons.length) {
      const parsedScores = await Promise.all(scoreJsons.map(async function (f) {
        try {
          const text = await f.text();
          return ports.extractScoreRow(f.name, text);
        } catch (_) { return null; }
      }));
      for (const row of parsedScores) {
        if (row) { rows.push(row); scoreHits++; }
      }
    }
    if (!scoreHits && raws.length <= 100) {
      for (const raw of raws) {
        const r = ports.plddtRow(raw);
        if (r) rows.push(r);
      }
    }
    if (rows.length) {
      ports.autoApplyScores(rows);
      if (scoreHits) {
        ports.toast('已导入 ' + raws.length + ' 个结构；自动解析 ' + scoreHits +
          ' 个分数文件（ipTM / pLDDT / ranking_score…）');
      } else {
        ports.status('已导入 ' + raws.length + ' 个结构 · 已从 B 因子列提取 pLDDT');
      }
    }
  }
  function traverseEntry(entry, out, depth, failed) {
    return new Promise(function (resolve) {
      if (!entry || depth > 6) return resolve();
      if (entry.isFile) {
        entry.file(
          function (f) { out.push(f); resolve(); },
          function (e) {
            failed.push(entry.name + '（' + (e && e.message ? e.message : '路径不可读') + '）');
            resolve();
          }
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const readBatch = function () {
          reader.readEntries(function (results) {
            if (!results.length) {
              Promise.all(all.map(function (c) {
                return traverseEntry(c, out, depth + 1, failed);
              })).then(resolve);
            } else {
              results.forEach(function (r) { all.push(r); });
              readBatch();
            }
          }, function () { failed.push(entry.name + '（目录不可读）'); resolve(); });
        };
        readBatch();
      } else resolve();
    });
  }
  async function importDrop(dt) {
    return importExternalDrop(dt, null);
  }
  function externalDropTarget(element) {
    if (!element || !element.closest) return null;
    const stage = element.closest('.stage');
    const owner = stage ? ports.panes.find(function (pane) { return pane.el === stage; }) || ports.paneAt() : ports.paneAt();
    const card = element.closest('.overview-card[data-entry-id]');
    const folder = card && owner.overview && owner.overview.findNode(card.dataset.entryId);
    if (folder && folder.kind === 'folder' && folder.origin !== 'removed' && !folder.trash &&
        (folder.origin === 'user' || folder.origin === 'lineage')) {
      const stepKey = ports.stepKeyOfNode(folder);
      if (stepKey) return { element: card, pane: owner, stepKey: stepKey, folder: folder,
        label: '添加到「' + folder.name + '」' + (folder.origin === 'lineage' ? '中的“外部导入”' : '') };
    }
    const row = element.closest('.entry.is-dir[data-step-key], .overview-section[data-step-key]');
    if (!row || !row.dataset.stepKey || row.dataset.stepKey === '__new__') return null;
    const step = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === row.dataset.stepKey; });
    if (!step) return null;
    return { element: row, pane: owner, stepKey: step.key, label: '添加到「' + step.title + '」' };
  }
  async function collectExternalFiles(dt) {
    const items = Array.from(dt.items || []);
    const fallbackFiles = Array.from(dt.files || []);
    const entries = [];
    for (const it of items) {
      const e = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (e) entries.push(e);
    }
    if (entries.length) {
      const files = [];
      const failed = [];
      for (const e of entries) await traverseEntry(e, files, 0, failed);
      if (failed.length) {
        ports.note('文件夹里有 ' + failed.length + ' 个文件读不到：' +
          failed.slice(0, 2).join('；') + '（源文件可能被移动或权限不足）', true);
      }
      const topName = (entries.length === 1 && entries[0].isDirectory) ? entries[0].name : '';
      return { files: files, name: topName };
    } else {
      return { files: fallbackFiles, name: '' };
    }
  }
  async function importExternalDrop(dt, target) {
    if (ports.pipelineTabBusy || ports.localImportBusy || (ports.panePipelineController && ports.panePipelineController.busy)) {
      ports.toast('正在读取文件或切换标签，请稍后再拖入。'); return false;
    }
    const sourceEpoch = ports.rawS.workspaceEpoch || 0;
    let batch;
    ports.localImportBusy++;
    try { batch = await collectExternalFiles(dt); }
    catch (error) { ports.toast('读取拖入文件失败：' + error.message, true); return false; }
    finally { ports.localImportBusy--; }
    if (!batch.files.some(function (file) { return ports.IO.isStructureFile(file.name) || /\.zip$/i.test(file.name); })) {
      ports.toast('没有可读取的结构文件；管线 JSON 请使用“粘贴 JSON 导入”。', true); return false;
    }
    if ((ports.rawS.workspaceEpoch || 0) !== sourceEpoch) { ports.toast('工作区已变化，请重新拖入。'); return false; }
    if (!target) {
      if (ports.hasWorkspaceContent(ports.rawS) && !await ports.addPipelineTab()) return false;
      await importFiles(batch.files, batch.name || (batch.files.length === 1 ? batch.files[0].name : '导入 ' + batch.files.length + ' 个文件'));
      ports.status('已在独立标签打开拖入文件');
      return true;
    }
    const step = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === target.stepKey; });
    if (!step && target.stepKey !== 'plain') { ports.toast('目标步骤已不存在，请重新拖入。', true); return false; }
    if (target.folder && target.folder.origin === 'user' && !(ports.S.organization[target.stepKey]?.folders || []).some(function (f) { return f.id === target.folder.orgId; })) {
      ports.toast('目标文件夹已不存在，请重新拖入。', true); return false;
    }
    const beforeIds = new Set(ports.rawS.entries.map(function (entry) { return entry.id; }));
    const opts = { group: false, stepKey: target.stepKey === 'plain' ? '' : target.stepKey,
      stepTitle: step && step.title || '', stepTool: step && step.tool || '',
      stepIndex: step && Number.isFinite(step.order) ? step.order : 0,
      pipelineId: step && step.pipelineId || '' };
    if (target.pane && ports.PANE_RUNTIME.alive(target.pane)) ports.setActivePane(target.pane.index, { sync: false });
    await importFiles(batch.files, batch.name, opts);
    const fresh = ports.rawS.entries.filter(function (entry) { return !beforeIds.has(entry.id); });
    for (const group of ports.rawS.groups) {
      if (group.pipelineKey === target.stepKey) {
        for (const entry of fresh) if (!group.entryIds.includes(entry.id)) group.entryIds.push(entry.id);
      }
    }
    if (target.folder && fresh.length) {
      const keys = fresh.map(ports.entryOrgKey);
      if (target.folder.origin === 'user') ports.ORG.moveKeys(ports.S.organization, target.stepKey, keys, target.folder.orgId);
      else ports.ORG.createFolder(ports.S.organization, target.stepKey, {name: batch.name || '外部导入',
        parentId: 'lineage:' + (target.folder.groupKey || target.folder.id), entryKeys: keys});
      ports.afterOrgChange(target.stepKey, '已添加 ' + fresh.length + ' 个结构到「' + target.folder.name + '」');
    } else if (fresh.length) {
      ports.refreshSharedPaneViews(); ports.scheduleSessionSave();
      ports.toast('已添加 ' + fresh.length + ' 个结构到「' + (step && step.title || '其他导入') + '」');
    }
    return true;
  }
  function buildAf3Plan(zip) {
    // 只认设计目录根下的 *_model_N.cif；templates/ 下 8 个模板 cif 必须排除
    const models = zip.entries.filter(function (e) {
      return /_model_\d+\.cif$/i.test(e.name) && !/\/(templates|msas)\//i.test(e.name);
    });
    const groups = new Map();
    for (const e of models) {
      const parts = e.name.split('/');
      const design = parts.length > 1
        ? parts[0]
        : (parts[0].replace(/_model_\d+\.cif$/i, '') || '单个设计');
      if (!groups.has(design)) groups.set(design, []);
      groups.get(design).push(e);
    }
    const plans = [];
    for (const [design, list] of groups) {
      list.sort(function (a, b) {
        const na = parseInt((a.name.match(/_model_(\d+)\.cif$/i) || [0, 0])[1], 10);
        const nb = parseInt((b.name.match(/_model_(\d+)\.cif$/i) || [0, 0])[1], 10);
        return na - nb;
      });
      plans.push({ design: design, models: list.slice(0, 5) });
    }
    return plans;
  }
  function summaryEntryFor(zip, modelEntry) {
    const want = modelEntry.name.replace(/_model_(\d+)\.cif$/i, '_summary_confidences_$1.json');
    return ports.ZIP.byName(zip, want);
  }
  async function importZipFiles(zipFiles, opts) {
    opts = opts || {};
    const allRaws = [];
    const metricRows = [];
    let designCount = 0, modelCount = 0, skipped = 0;

    for (const zf of zipFiles) {
      let zip;
      try { zip = await ports.ZIP.open(zf); }
      catch (e) {
        ports.note('ZIP 打开失败：' + zf.name + ' — ' + (e && e.message ? e.message : e), true);
        continue;
      }
      const plans = buildAf3Plan(zip);
      if (!plans.length) { ports.note('ZIP 里没找到 *_model_N.cif（可识别的预测结构）', true); continue; }
      ports.status('解析 ' + zf.name + '：' + plans.length + ' 个设计…');
      for (const plan of plans) {
        designCount++;
        for (const m of plan.models) {
          try {
            const text = await ports.ZIP.extract(zip, m, true);
            const name = m.name.split('/').pop();
            allRaws.push({
              name: name, data: text, format: 'mmcif', isBinary: false,
              size: text.length, parsed: undefined, group: plan.design,
            });
            modelCount++;
            const row = {
              design: name,
              model: (m.name.match(/_model_(\d+)\.cif$/i) || [])[1] || '',
            };
            const se = summaryEntryFor(zip, m);
            if (se) {
              try {
                const d = JSON.parse(await ports.ZIP.extract(zip, se, true));
                row.ranking_score = d.ranking_score;
                row.iptm = d.iptm;
                row.ptm = d.ptm;
                row.has_clash = d.has_clash ? 1 : 0;
                row.fraction_disordered = d.fraction_disordered;
                const pae = d.chain_pair_pae_min;
                if (Array.isArray(pae) && Array.isArray(pae[0]) && pae[0][1] != null) {
                  row.interface_pae_min_AB = pae[0][1];
                }
              } catch (e) { /* 单个指标读不到不影响结构 */ }
            }
            metricRows.push(row);
          } catch (e) {
            skipped++;
            console.warn('[StructBoard] zip entry failed', m.name, e);
          }
          await ports.sleep(0);
        }
      }
    }
    if (!allRaws.length) {
      ports.note('ZIP 里一个模型都没解出来（' + (skipped ? skipped + ' 个条目失败' : '没找到模型文件') + '）', true);
      return;
    }
    ports.status('正在建立 ' + designCount + ' 个设计 / ' + modelCount + ' 个模型…');
    const packName = zipFiles.length === 1
      ? zipFiles[0].name.replace(/\.zip$/i, '') : 'AF3 批量导入';
    ports.addEntries(allRaws, packName, Object.assign({}, opts, { perEntryGroup: opts.group !== false }));
    applyMetricsRows(metricRows);
    ports.toast('AF3 包：' + designCount + ' 个设计 / ' + modelCount + ' 个模型，已按设计建文件夹' +
      (skipped ? '，跳过 ' + skipped + ' 个' : ''));
  }
  function applyMetricsRows(rows) {
    // ZIP 里的 summary_confidences 已在导入时抽好；统一并入自动分数表
    const withModel = rows.map(function (r) {
      const out = Object.assign({}, r);
      delete out.model;
      return out;
    });
    ports.autoApplyScores(withModel);
    if (ports.S.metrics.primary) {
      ports.status('已载入 ' + rows.length + ' 行 AF3 指标 · 主指标 ' + ports.S.metrics.primary);
    }
  }
  async function addFromUrl(text) {
    const t = text.trim();
    if (!t) return;
    let url = t, name = t;
    if (/^[0-9a-zA-Z]{4}$/.test(t)) {
      const id = t.toUpperCase();
      url = 'https://files.rcsb.org/download/' + id + '.cif';
      name = id + '.cif';
    } else if (!/^https?:\/\//i.test(t)) {
      ports.toast('请输入 4 位 PDB ID 或 http(s) 开头的 URL', true);
      return;
    } else {
      name = decodeURIComponent(t.split('?')[0].split('/').pop() || 'remote.cif');
    }
    const format = /\.(pdb|ent)$/i.test(name) ? 'pdb' : 'mmcif';
    ports.addEntries([{ name: name, url: url, isUrl: true, format: format, size: 0, data: '' }], '远程结构');
    ports.$('urlInput').value = '';
  }
  async function loadDemo() {
    if (ports.panePipelineController && ports.panePipelineController.importWholePipeline) {
      try {
        const response = await fetch('/api/pipelines', { cache: 'no-store' });
        const value = await response.json();
        if (value.ok && value.pipelines.some(function (p) { return p.id === 'aurora-demo'; })) {
          const opened = await ports.panePipelineController.importWholePipeline({ pipelineId: 'aurora-demo', openAsTab: true });
          if (opened) {
            const scores = await fetch('/api/demo/scores', { cache: 'no-store' }).then(function (r) { return r.json(); });
            if (scores.ok) {
              ports.autoApplyScores(scores.rows);
              ports.S.metrics.fileName = '演示分数（人工设定）';
              ports.S.metrics.primary = 'demo_score'; ports.S.metrics.higher = true;
              ports.recomputeMetricRange(); ports.renderMetricUI();
            }
            ports.toast('人工合成演示：结构和分数仅用于学习操作');
          }
          return;
        }
      } catch (_) { /* Plain browser mode keeps the independent helix demo below. */ }
    }
    if (ports.overview) ports.overview.clear();
    ports.resetGridNavigation();
    ports.S.manualOrder = false;
    ports.S.entries = [];
    ports.S.referenceId = null;
    ports.S.aligned = false;
    ports.S.soloId = null;
    ports.clearOverviewReturn();
    ports.S.starOnly = false;
    ports.S.listLimit = 60;
    ports.S.groups = []; ports.S.activeGroupId = 'all'; ports.S.groupSeq = 0;
    ports.S.customSteps = []; ports.S.activePipelineId = ''; ports.S.listNav = null; ports.S.organization = {}; if (ports.ORG) ports.ORG.clearHistory();
    ports.S.overlayRefs = [];
    ports.S.autoScoreRows = [];
    ports.disposeGrid();
    ports.addEntries(ports.IO.makeDemo(), '人工合成演示（非科研结果）');
    ports.loadDemoMetrics();
    ports.refreshAlignBtn();
  }
  async function runAf3SelfTest() {
    const designs = [
      { name: 'binder_01', b: 88, iptm: 0.71, ranking: 0.82 },
      { name: 'binder_02', b: 76, iptm: 0.64, ranking: 0.76 },
      { name: 'binder_03', b: 91, iptm: 0.78, ranking: 0.88 },
      { name: 'binder_04', b: 62, iptm: 0.55, ranking: 0.66 },
    ];
    const files = [];
    for (const d of designs) {
      const atoms = helixDemoAtoms(d.b);
      files.push(new File([ports.IO.toPdb(atoms)], d.name + '.pdb'));
      const plddt = atoms.map(function (a) { return a.b; });
      files.push(new File([JSON.stringify({
        ranking_score: d.ranking,
        iptm: d.iptm,
        ptm: Math.min(0.95, d.iptm + 0.1),
        fraction_disordered: 0.02,
        has_clash: 0.0,
        atom_plddt: plddt,
      })], d.name + '_scores.json'));
    }
    // 再混一个 Boltz-2 风格的 confidence json，验证另一套键名
    files.push(new File([JSON.stringify({
      confidence_score: 0.79, complex_plddt: 0.84, complex_iptm: 0.66,
      iptm: 0.66, ptm: 0.81, protein_iptm: 0.66,
    })], 'binder_01_confidence.json'));
    await importFiles(files, 'AF3 自测批次');
  }
  function helixDemoAtoms(b) {
    // 复用 io.js 的示例螺旋生成
    const demo = ports.IO.makeDemo();
    const parsed = ports.IO.parse(demo[0].data, 'pdb');
    for (const a of parsed.atoms) a.b = b;
    return parsed.atoms;
  }
// SERVICE_FUNCTIONS_END
  return { desktopPickFiles, pickImport, pickImportMetrics, triggerStepImport, importDropIntoStep, importFiles, importFilesIntoCurrentTab, traverseEntry, importDrop, externalDropTarget, collectExternalFiles, importExternalDrop, buildAf3Plan, summaryEntryFor, importZipFiles, applyMetricsRows, addFromUrl, loadDemo, runAf3SelfTest, helixDemoAtoms };
}
