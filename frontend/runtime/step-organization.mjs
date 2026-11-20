// step-organization: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function orderedStepBuckets(entries, opts) {
    opts = opts || {};
    const edits = ports.loadStepEdits();
    const map = new Map();
    const definitions = new Map();
    for (const cs of (ports.S.customSteps || [])) {
      if (!cs || !cs.key) continue;
      const saved = edits[cs.key] || {};
      if (cs.pipelineStep) definitions.set(cs.key, cs);
      else if (saved.deleted) continue;
      if (opts.includeEmpty === false) continue;
      map.set(cs.key, {
        key: cs.key,
        index: Number.isFinite(cs.index) ? cs.index : 9000,
        order: !cs.pipelineStep && Number.isFinite(saved.order) ? saved.order : (Number.isFinite(cs.order) ? cs.order : null),
        title: saved.title || cs.title || cs.key,
        tool: saved.tool !== undefined ? saved.tool : (cs.tool || ''),
        pipelineId: cs.pipelineId || '',
        custom: !cs.pipelineStep,
        entries: [],
      });
    }
    for (const entry of entries) {
      if (!entry.stepKey) continue;
      const saved = edits[entry.stepKey] || {};
      const step = definitions.get(entry.stepKey);
      if (!map.has(entry.stepKey)) {
        map.set(entry.stepKey, {
          key: entry.stepKey,
          index: Number.isFinite(entry.stepIndex) ? entry.stepIndex : 9000,
          order: step ? step.order : (Number.isFinite(saved.order) ? saved.order : null),
          title: saved.title || entry.stepTitle || entry.stepKey,
          tool: saved.tool !== undefined ? saved.tool : (entry.stepTool || ''),
          pipelineId: entry.pipelineId || '',
          custom: false,
          entries: [],
        });
      }
      map.get(entry.stepKey).entries.push(entry);
    }
    const list = Array.from(map.values()).sort(function (a, b) {
      const ao = a.order !== null ? a.order : a.index;
      const bo = b.order !== null ? b.order : b.index;
      if (ao !== bo) return ao - bo;
      return a.index - b.index;
    });
    list.forEach(function (step, i) { step.displayIndex = i + 1; });
    return list;
  }
  function persistStepOrder(orderedList) {
    orderedList.forEach(function (step, i) {
      const ord = (i + 1) * 10;
      ports.saveStepEdit(step.key, { order: ord });
      ports.S.entries.forEach(function (e) { if (e.stepKey === step.key) e.stepIndex = ord; });
    });
    schedulePipelineSync();
  }
  function mergePipelineSteps(defn, ordered, edits, helpers) {
    const isTrashed = (helpers && helpers.isTrashed) || function () { return false; };
    const attach = (helpers && helpers.attach) || function () {};
    const pid = (defn && defn.id) || '';
    const byId = new Map(((defn && defn.steps) || []).map(function (st) { return [st.id, st]; }));
    const normRoot = String((defn && defn.root) || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const nextSteps = [];
    const usedIds = new Set();
    for (const st of ordered || []) {
      const prefix = pid + ':';
      const rawKey = String(st.key || '');
      // 管线步骤的 key 是「管线id:步骤id」；自建步骤的 key 是「step-xxxx」，不带前缀，
      // 落盘时的步骤 id 就是 key 本身（清掉非法字符后）。两条路径都要能找到磁盘上已有的那一步。
      const sid = rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : '';
      const customSid = rawKey.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
      const diskId = sid || (st.custom && st.pipelineId === pid ? customSid : '');
      const ed = (edits && edits[st.key]) || {};
      const existing = diskId ? byId.get(diskId) : null;
      if (existing) {
        // 已经在磁盘上的步骤（管线的或之前建好的自建步骤）：只更新显示层。
        // 以前自建步骤每次同步都按「当前内存能看到的条目」重新合成 files，
        // 会把回收站成员、以及本次没加载到的成员永久写掉。
        const kept = Object.assign({}, existing);
        if (ed.title) kept.title = ed.title;
        if (ed.tool !== undefined) kept.tool = ed.tool;
        attach(kept, st.key, st.entries);
        nextSteps.push(kept);
        usedIds.add(existing.id);
        continue;
      }
      if (!(st.custom && st.pipelineId === pid)) continue;
      const cleanSid = customSid;
      if (!cleanSid || usedIds.has(cleanSid)) continue;
      // 真正新建的自建步骤：只在这里按成员清单落一次 files。
      // 跳过回收站成员，避免把已删除的条目写回科学定义。
      const files = [];
      if (normRoot) {
        for (const e of st.entries || []) {
          if (isTrashed(e)) continue;
          const fp = String(e.fullPath || e.path || '').replace(/\\/g, '/');
          if (fp.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
            files.push({ name: e.name, path: fp.slice(normRoot.length + 1), star: !!e.star });
          }
        }
      }
      const customStep = {
        id: cleanSid,
        title: st.title,
        tool: st.tool || '',
        desc: st.derivedFrom ? '从优选结果提取的候选步骤' : '用户新增步骤',
        files: files,
        state: 'done',
      };
      attach(customStep, st.key, st.entries);
      nextSteps.push(customStep);
      usedIds.add(cleanSid);
    }
    // 保留未载入到当前界面的步骤（除非明确标记 deleted 且仍留有至少 1 步）
    // 删除标记可能挂在两种 key 上：管线步骤是「管线id:步骤id」，自建步骤是「step-xxx」。
    for (const orig of (defn && defn.steps) || []) {
      if (usedIds.has(orig.id)) continue;
      const fullEd = (edits && edits[pid + ':' + orig.id]) || {};
      const bareEd = (edits && edits[orig.id]) || {};
      const deleted = !!fullEd.deleted || !!bareEd.deleted;
      if (!deleted || !nextSteps.length) nextSteps.push(orig);
    }
    if (!nextSteps.length) return null;
    const out = Object.assign({}, defn, { steps: nextSteps });
    return out;
  }
  function cancelPipelineSync() {
    clearTimeout(ports.pipelineSyncTimer); ports.pipelineSyncTimer = 0;
    if (ports.pipelineSyncController) ports.pipelineSyncController.abort();
    ports.pipelineSyncController = null;
  }
  function schedulePipelineSync() {
    const pid = ports.activePipelineId(), epoch = ports.S.workspaceEpoch || 0;
    if (!pid) return;
    cancelPipelineSync();
    const controller = ports.pipelineSyncController = new AbortController();
    const current = function () {
      return !controller.signal.aborted && (ports.S.workspaceEpoch || 0) === epoch && ports.activePipelineId() === pid;
    };
    ports.pipelineSyncTimer = setTimeout(function () {
      ports.pipelineSyncTimer = 0;
      if (!current()) return;
      const edits = JSON.parse(JSON.stringify(ports.loadStepEdits()));
      const ordered = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
      fetch('/api/pipeline?id=' + encodeURIComponent(pid) + '&raw=1', { cache: 'no-store', signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!current() || !res || !res.ok || !res.pipeline || !Array.isArray(res.pipeline.steps)) return;
          const defn = res.pipeline;
          const merged = mergePipelineSteps(defn, ordered, edits, {
            isTrashed: ports.entryIsTrashed,
            attach: attachStepOrganization,
          });
          if (!merged || !current()) return;
          return fetch('/api/pipeline/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ definition: merged, overwrite: true }),
            signal: controller.signal,
          });
        })
        .catch(function () { /* 后端同步失败时仍保留本机状态 */ })
        .finally(function () { if (ports.pipelineSyncController === controller) ports.pipelineSyncController = null; });
    }, 500);
  }
  function refreshStepsUI(rebuildRight) {
    ports.renderList();
    ports.refreshBadge();
    if (rebuildRight !== false) ports.refreshSharedPaneViews();
  }
  function moveStepByDelta(key, delta) {
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const idx = steps.findIndex(function (s) { return s.key === key; });
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= steps.length) return;
    const item = steps.splice(idx, 1)[0];
    steps.splice(next, 0, item);
    persistStepOrder(steps);
    refreshStepsUI(true);
    ports.toast('已将「' + item.title + '」移为第 ' + (next + 1) + ' 步');
  }
  function moveStepBefore(sourceKey, targetKey, after) {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const srcIdx = steps.findIndex(function (s) { return s.key === sourceKey; });
    if (srcIdx < 0) return;
    const item = steps.splice(srcIdx, 1)[0];
    const tgtIdx = steps.findIndex(function (s) { return s.key === targetKey; });
    if (tgtIdx < 0) return;
    const insertAt = tgtIdx + (after ? 1 : 0);
    steps.splice(insertAt, 0, item);
    persistStepOrder(steps);
    refreshStepsUI(true);
    ports.toast('已调整步骤顺序：「' + item.title + '」→ 第 ' + (insertAt + 1) + ' 步');
  }
  function createCustomStep(opts) {
    opts = opts || {};
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const key = opts.key || ('step-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5));
    const title = (opts.title || ('步骤 ' + (steps.length + 1))).trim();
    const tool = (opts.tool || '').trim();
    const pid = opts.pipelineId || ports.activePipelineId() || '';
    const record = { key: key, title: title, tool: tool, index: (steps.length + 1) * 10, order: (steps.length + 1) * 10, pipelineId: pid, derivedFrom: opts.derivedFrom || '' };
    let insertAt = steps.length;
    if (opts.afterKey === '__top__') insertAt = 0;
    else if (opts.afterKey) {
      const idx = steps.findIndex(function (s) { return s.key === opts.afterKey; });
      if (idx >= 0) insertAt = idx + 1;
    }
    const stub = { key: key, title: title, tool: tool, order: 0, index: 0, custom: true, pipelineId: pid };
    steps.splice(insertAt, 0, stub);
    ports.S.customSteps = (ports.S.customSteps || []).filter(function (s) { return s.key !== key; });
    ports.S.customSteps.push(record);
    ports.saveStepEdit(key, { title: title, tool: tool, deleted: false });
    ports.saveCustomSteps();
    persistStepOrder(steps);
    return record;
  }
  function renameStepPrompt(key) {
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const step = steps.find(function (s) { return s.key === key; });
    if (!step) return;
    ports.askSheet({ title: '重命名步骤', message: '修改第 ' + step.displayIndex + ' 步在侧栏与总览中的名称。', value: step.title, ok: '保存' }).then(function (name) {
      if (!name || !name.trim() || name.trim() === step.title) return;
      ports.saveStepEdit(key, { title: name.trim() });
      if (ports.S.listNav && ports.S.listNav.stepKey === key) ports.S.listNav.title = name.trim();
      schedulePipelineSync();
      refreshStepsUI(true);
    });
  }
  function deleteStep(key) {
    if (!key || key === 'plain') return;
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const step = steps.find(function (s) { return s.key === key; });
    if (!step) return;
    const stepEntries = ports.S.entries.filter(function (e) { return e.stepKey === key; });
    const org = ports.ORG ? ports.ORG.ensure(ports.S.organization, key) : null;
    if (ports.ORG && org && stepEntries.length) ports.ORG.removeKeys(ports.S.organization, key, stepEntries.map(ports.entryOrgKey));
    ports.S.trashSteps = (ports.S.trashSteps || []).filter(function (x) { return x.key !== key; });
    const customStep = (ports.S.customSteps || []).find(function (s) { return s.key === key; });
    ports.S.trashSteps.push({ key: key, title: step.title || key, count: stepEntries.length,
      custom: customStep ? JSON.parse(JSON.stringify(customStep)) : null, removedAt: Date.now() });
    ports.S.customSteps = (ports.S.customSteps || []).filter(function (s) { return s.key !== key; });
    ports.saveCustomSteps();
    ports.saveStepEdit(key, { deleted: true });
    if (ports.S.listNav && ports.S.listNav.stepKey === key) ports.S.listNav = null;
    schedulePipelineSync();
    refreshStepsUI(true);
    ports.toast('已将步骤「' + step.title + '」移入回收站 · ' + stepEntries.length + ' 条结构');
  }
  function moveEntriesToStep(ids, targetStepKey) {
    const set = new Set(ids);
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const step = targetStepKey ? steps.find(function (s) { return s.key === targetStepKey; }) : null;
    let count = 0;
    for (const e of ports.S.entries) {
      if (!set.has(e.id)) continue;
      if (step) {
        e.stepKey = step.key;
        e.stepIndex = Number.isFinite(step.order) ? step.order : (step.displayIndex * 10);
        e.stepTitle = step.title;
        e.stepTool = step.tool || '';
        if (step.pipelineId) e.pipelineId = step.pipelineId;
      } else {
        e.stepKey = ''; e.stepIndex = 0; e.stepTitle = ''; e.stepTool = '';
      }
      count++;
    }
    if (count) {
      schedulePipelineSync();
      refreshStepsUI(true);
      ports.toast('已将 ' + count + ' 个结构移入' + (step ? '第 ' + step.displayIndex + ' 步「' + step.title + '」' : '「其他导入」'));
    }
  }
  function openMoveToStepMenu(ids, anchorEl) {
    const m = ports.$('stepMenu');
    if (!m) return;
    m.innerHTML = '';
    m.appendChild(ports.el('div', 'gm-title', ids.length > 1 ? ('把 ' + ids.length + ' 个结构移入步骤…') : '移入哪一步…'));
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    for (const st of steps) {
      const b = ports.el('button', 'menu-item', st.displayIndex + '. ' + st.title + ' (' + st.entries.length + ')');
      b.addEventListener('click', function (e) { e.stopPropagation(); ports.closeMenus(); moveEntriesToStep(ids, st.key); });
      m.appendChild(b);
    }
    if (steps.length) m.appendChild(ports.el('div', 'menu-sep'));
    const nb = ports.el('button', 'menu-item', '+ 新建步骤并移入…');
    nb.addEventListener('click', function (e) {
      e.stopPropagation();
      ports.closeMenus();
      ports.askSheet({ title: '新建步骤并移入', value: '候选步骤 ' + (steps.length + 1), ok: '创建并移入' }).then(function (name) {
        if (!name || !name.trim()) return;
        const rec = createCustomStep({ title: name.trim() });
        moveEntriesToStep(ids, rec.key);
      });
    });
    m.appendChild(nb);
    m.appendChild(ports.el('button', 'menu-item', '移出步骤（放入「其他导入」）')).addEventListener('click', function (e) {
      e.stopPropagation(); ports.closeMenus(); moveEntriesToStep(ids, '');
    });
    m.hidden = false;
    ports.closeMenus('stepMenu');
    const r = anchorEl.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 220)) + 'px';
    m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 280)) + 'px';
  }
  function deriveStepFromStars(sourceStepKey) {
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const src = steps.find(function (s) { return s.key === sourceStepKey; });
    const pool = sourceStepKey === 'plain'
      ? ports.S.entries.filter(function (e) { return !e.stepKey && e.star; })
      : ports.S.entries.filter(function (e) { return e.stepKey === sourceStepKey && e.star; });
    if (!pool.length) {
      ports.toast('这一步还没有标记 ★ 优选结构：请先点击卡片上的 ☆ 勾选候选', true);
      return;
    }
    const baseTitle = src ? src.title : '其他导入';
    const rec = createCustomStep({
      title: baseTitle + ' · 优选候选（' + pool.length + '条）',
      tool: src ? src.tool : '',
      afterKey: sourceStepKey === 'plain' ? '' : sourceStepKey,
      derivedFrom: sourceStepKey,
    });
    const clones = pool.map(function (e) {
      return {
        name: e.name,
        data: e.data,
        format: e.format,
        isBinary: e.isBinary,
        isUrl: e.isUrl,
        url: e.url,
        size: e.size,
        parsed: e.parsed,
        path: e.path,
        fullPath: e.fullPath,
        sourceKey: rec.key + '|' + (e.sourceKey || e.id),
        group: e.group,
        modelIndex: e.modelIndex,
        ...ports.LINEAGE.meta(e),
        groupKey: e.groupKey ? rec.key + '|' + e.groupKey : null,
        star: false,
        lazy: e.lazy,
        fetchUrl: e.fetchUrl,
        stepKey: rec.key,
        stepIndex: rec.order,
        stepTitle: rec.title,
        stepTool: rec.tool,
        pipelineId: rec.pipelineId,
      };
    });
    ports.addEntries(clones, rec.title, {
      group: false, rebuild: false, quiet: true,
      stepKey: rec.key, stepIndex: rec.order, stepTitle: rec.title, stepTool: rec.tool, pipelineId: rec.pipelineId,
    });
    // 继承原指标数值，方便在下一步继续排序/筛选
    const bySource = new Map(pool.map(function (e) { return [rec.key + '|' + (e.sourceKey || e.id), e]; }));
    ports.S.entries.forEach(function (e) {
      if (e.stepKey === rec.key && bySource.has(e.sourceKey)) {
        const orig = bySource.get(e.sourceKey);
        if (orig.metrics) e.metrics = Object.assign({}, orig.metrics);
      }
    });
    schedulePipelineSync();
    refreshStepsUI(true);
    ports.toast('已从「' + baseTitle + '」提取 ' + clones.length + ' 个 ★ 优选结构生成下一步');
  }
  function openStepModal(opts) {
    opts = opts || {};
    const mask = ports.$('stepModalMask');
    const nameInput = ports.$('stepModalName');
    const toolInput = ports.$('stepModalTool');
    const posSelect = ports.$('stepModalPos');
    const pills = ports.$('stepToolPills');
    const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
    const isEdit = opts.mode === 'edit' && opts.stepKey;
    const editingStep = isEdit ? steps.find(function (s) { return s.key === opts.stepKey; }) : null;

    ports.stepModalState = {
      mode: isEdit ? 'edit' : 'create',
      stepKey: isEdit ? opts.stepKey : '',
    };

    ports.$('stepModalTitle').textContent = isEdit ? '编辑步骤信息' : '导入 / 新建步骤';
    ports.$('stepModalDesc').textContent = isEdit
      ? '修改这一步的名称、工具标签，在侧栏与总览实时同步。'
      : '选一个本地文件夹或结构文件直接成为带编号的新步骤，也可先建空步骤占位。';

    nameInput.value = editingStep ? editingStep.title : (opts.title || '');
    toolInput.value = editingStep ? (editingStep.tool || '') : (opts.tool || '');

    const syncPills = function (val) {
      const lower = String(val || '').trim().toLowerCase();
      pills.querySelectorAll('.step-tool-chip').forEach(function (btn) {
        btn.classList.toggle('active', String(btn.dataset.tool || '').toLowerCase() === lower);
      });
    };
    syncPills(toolInput.value);
    pills.onclick = function (e) {
      const btn = e.target.closest('.step-tool-chip');
      if (!btn) return;
      toolInput.value = btn.dataset.tool || '';
      syncPills(toolInput.value);
    };
    toolInput.oninput = function () { syncPills(toolInput.value); };

    ports.$('stepModalPosGroup').hidden = isEdit;
    if (!isEdit) {
      posSelect.replaceChildren();
      const appendOpt = function (value, label) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        posSelect.appendChild(o);
      };
      appendOpt('', '添加到末尾（第 ' + (steps.length + 1) + ' 步）');
      if (steps.length) appendOpt('__top__', '插到最前面（第 1 步）');
      steps.forEach(function (s) {
        appendOpt(s.key, '插在第 ' + s.displayIndex + ' 步「' + s.title + '」之后');
      });
      posSelect.value = opts.afterStepKey || '';
    }

    ports.$('stepSourceActions').hidden = isEdit;
    ports.$('stepEditActions').hidden = !isEdit;
    mask.hidden = false;
    requestAnimationFrame(function () { mask.classList.add('open'); });
    setTimeout(function () { nameInput.focus(); if (isEdit) nameInput.select(); }, 40);
  }
  function closeStepModal() {
    const mask = ports.$('stepModalMask');
    if (!mask || mask.hidden) return;
    mask.classList.remove('open');
    setTimeout(function () { mask.hidden = true; }, 220);
  }
  function openStepMenu(step, anchorEl) {
    const m = ports.$('stepMenu');
    if (!m) return;
    m.innerHTML = '';
    const isPlain = !step || step.key === 'plain';
    const mk = function (label, cls, fn) {
      const b = ports.el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
      b.addEventListener('click', function (e) { e.stopPropagation(); ports.closeMenus(); fn(); });
      return b;
    };
    if (!isPlain) {
      const stepEntries = ports.S.entries.filter(function (e) { return e.stepKey === step.key; });
      m.appendChild(mk('⊞ 在检阅台打开 · ' + stepEntries.length + ' 条', '', function () {
        ports.openBenchWithEntries(stepEntries, '检阅台 · ' + (step.title || step.key) + ' · ' + stepEntries.length + ' 条');
      }));
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('+ 追加文件夹到这一步…', '', function () { ports.triggerStepImport(step.key, true); }));
      m.appendChild(mk('+ 追加文件 / ZIP 到这一步…', '', function () { ports.triggerStepImport(step.key, false); }));
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('✎ 重命名步骤…', '', function () { renameStepPrompt(step.key); }));
      m.appendChild(mk('⚑ 编辑名称与工具标签…', '', function () { openStepModal({ mode: 'edit', stepKey: step.key }); }));
      m.appendChild(mk('↑ 上移一步', '', function () { moveStepByDelta(step.key, -1); }));
      m.appendChild(mk('↓ 下移一步', '', function () { moveStepByDelta(step.key, 1); }));
      m.appendChild(mk('✚ 在下方插入新步骤…', '', function () { openStepModal({ afterStepKey: step.key }); }));
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('★ 把本步优选生成为下一步', '', function () { deriveStepFromStars(step.key); }));
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('新建工作台文件夹…', '', function () { promptNewOrgFolder(step.key, null, []); }));
      m.appendChild(mk('恢复本步默认分组', '', function () { resetOrgStep(step.key); }));
      m.appendChild(mk('移除此步骤（结构保留）', 'danger', function () { deleteStep(step.key); }));
    } else {
      const plainEntries = ports.S.entries.filter(function (e) { return !e.stepKey; });
      m.appendChild(mk('⊞ 在检阅台打开 · ' + plainEntries.length + ' 条', '', function () {
        ports.openBenchWithEntries(plainEntries, '检阅台 · 其他导入 · ' + plainEntries.length + ' 条');
      }));
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('★ 把优选结构生成为新步骤', '', function () { deriveStepFromStars('plain'); }));
      m.appendChild(mk('全部移入某个步骤…', '', function () {
        const plainIds = ports.S.entries.filter(function (e) { return !e.stepKey; }).map(function (e) { return e.id; });
        openMoveToStepMenu(plainIds, anchorEl);
      }));
    }
    m.hidden = false;
    ports.closeMenus('stepMenu');
    const r = anchorEl.getBoundingClientRect();
    const mw = 210, mh = m.offsetHeight || 240;
    let x = Math.min(r.left, window.innerWidth - mw - 8);
    if (x < 8) x = 8;
    let y = r.bottom + 4;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  }
  function attachStepOrganization(rawStep, stepKey, stepEntries) {
    if (!ports.ORG || !rawStep) return;
    const org = ports.S.organization[stepKey];
    if (!org || ports.ORG.isEmpty(org)) {
      delete rawStep.organization;
      return;
    }
    rawStep.organization = ports.ORG.serialize(org, stepEntries || ports.S.entries.filter(function (e) { return e.stepKey === stepKey; }));
  }
  function stepKeyOfNode(node) {
    if (!node) return 'plain';
    if (node.stepKey) return node.stepKey;
    if (node.entry && node.entry.stepKey) return node.entry.stepKey;
    if (node.entries && node.entries[0] && node.entries[0].stepKey) return node.entries[0].stepKey;
    return 'plain';
  }
  function parentIdForCreate(node) {
    if (!node) return null;
    if (node.origin === 'user' && node.orgId) return node.orgId;
    if (node.origin === 'lineage' && (node.groupKey || node.id)) return 'lineage:' + (node.groupKey || node.id);
    return null;
  }
  function nodePlaceKeys(node) {
    if (!node) return [];
    if (node.kind === 'entry' && node.entry) return [ports.entryOrgKey(node.entry)].filter(Boolean);
    if (node.kind === 'folder') return (node.entries || []).map(ports.entryOrgKey).filter(Boolean);
    return [];
  }
  function trashEntries() {
    const out = [];
    const seen = new Set();
    ports.S.entries.forEach(function (entry) {
      const key = ports.entryOrgKey(entry);
      if (!key || seen.has(key) || !ports.entryIsTrashed(entry)) return;
      const inFolder = (ports.S.trashFolders || []).some(function (item) {
        return item && Array.isArray(item.entryKeys) && item.entryKeys.indexOf(key) >= 0;
      });
      const inStep = (ports.S.trashSteps || []).some(function (item) {
        return item && item.key === (entry.stepKey || 'plain');
      });
      if (!inFolder && !inStep) { seen.add(key); out.push(entry); }
    });
    return out;
  }
  function updateTrashBadge() {
    const count = trashEntries().length + (ports.S.trashFolders || []).length + (ports.S.trashSteps || []).length;
    const badge = ports.$('trashCount');
    if (!badge) return;
    badge.hidden = count < 1;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.title = count ? '回收站：' + count + ' 项' : '回收站为空';
  }
  function refreshOrgButtons() {
    const undoBtn = ports.$('btnOverviewUndo'), redoBtn = ports.$('btnOverviewRedo');
    if (undoBtn) undoBtn.disabled = !(ports.ORG && ports.ORG.canUndo());
    if (redoBtn) redoBtn.disabled = !(ports.ORG && ports.ORG.canRedo());
    updateTrashBadge();
  }
  function afterOrgChange(stepKey, message, focusId) {
    if (ports.ORG && ports.S.organization[stepKey] && ports.ORG.isEmpty(ports.S.organization[stepKey])) delete ports.S.organization[stepKey];
    ports.scheduleSessionSave();
    schedulePipelineSync();
    refreshOrgButtons();
    ports.renderList();
    if (ports.S.mode === 'overview') ports.rebuildOverview();
    else ports.applyModeChange(true);
    if (arguments.length >= 3 && focusId && ports.S.mode === 'overview') {
      // 方案 A：新夹挂在步骤末尾，虚拟化下可能没渲染——先到步骤头部，再逐步下探直到盒子出现。
      if (ports.overview && ports.overview.scrollToStep) ports.overview.scrollToStep(stepKey);
      let tries = 0;
      const hunt = function () {
        const box = document.querySelector('#overviewCards [data-entry-id="' + focusId + '"]');
        if (box) {
          box.scrollIntoView({ block: 'center' });
          box.classList.add('is-jump-flash');
          setTimeout(function () { box.classList.remove('is-jump-flash'); }, 1400);
          return;
        }
        if (tries++ < 30) {
          const sr = ports.$('overviewScroll');
          sr.scrollTop = Math.min(sr.scrollHeight, sr.scrollTop + Math.max(300, Math.round(sr.clientHeight * 0.8)));
          setTimeout(hunt, 90);
        }
      };
      setTimeout(hunt, 140);
    }
    if (message) ports.toast(message);
  }
  function currentOrgContext() {
    const drill = ports.overview && ports.overview.current ? ports.overview.current() : null;
    if (drill && stepKeyOfNode(drill)) {
      return { stepKey: stepKeyOfNode(drill), parentId: parentIdForCreate(drill), selected: [] };
    }
    const ids = ports.overview && ports.overview.selection ? ports.overview.selection() : [];
    const nodes = ids.map(function (id) { return ports.overview.findNode(id); }).filter(Boolean);
    if (nodes[0]) return { stepKey: stepKeyOfNode(nodes[0]), parentId: null, selected: nodes };
    const steps = orderedStepBuckets(ports.overviewEntries(), { includeEmpty: false });
    if (steps.length === 1) return { stepKey: steps[0].key, parentId: null, selected: nodes };
    return { stepKey: 'plain', parentId: null, selected: nodes };
  }
  function promptNewOrgFolder(stepKey, parentId, selectedNodes) {
    if (!ports.ORG) return;
    stepKey = stepKey || 'plain';
    ports.askSheet({
      title: '新建文件夹',
      message: '只改这一步怎么收纳，不改磁盘上的结构文件。',
      value: '新建文件夹',
      ok: '创建',
    }).then(function (name) {
      if (!name || !name.trim()) return;
      const entryKeys = [];
      const nested = [];
      (selectedNodes || []).forEach(function (n) {
        if (n.origin === 'user' && n.orgId) nested.push(n.orgId);
        else entryKeys.push.apply(entryKeys, nodePlaceKeys(n));
      });
      const newId = ports.ORG.createFolder(ports.S.organization, stepKey, {
        name: name.trim(), parentId: parentId || null, entryKeys: entryKeys, nestedFolderIds: nested,
      });
      afterOrgChange(stepKey, '已新建「' + name.trim() + '」', 'folder:user:' + newId);
    });
  }
  function renameOrgFolder(node) {
    if (!node || node.origin !== 'user' || !node.orgId) return;
    const stepKey = stepKeyOfNode(node);
    ports.askSheet({ title: '重命名文件夹', value: node.name, ok: '保存' }).then(function (name) {
      if (!name || !name.trim() || name.trim() === node.name) return;
      ports.ORG.renameFolder(ports.S.organization, stepKey, node.orgId, name.trim());
      afterOrgChange(stepKey, '已改名为「' + name.trim() + '」');
    });
  }
  function resetOrgStep(stepKey) {
    if (!stepKey || !ports.ORG) return;
    ports.ORG.resetStep(ports.S.organization, stepKey);
    afterOrgChange(stepKey, '已恢复这一步的默认分组');
  }
  function undoOrg() {
    if (!ports.ORG || !ports.ORG.canUndo()) { ports.toast('没有可撤销的整理'); return; }
    const item = ports.ORG.undo(ports.S.organization);
    afterOrgChange(item.stepKey, '已撤销');
  }
  function redoOrg() {
    if (!ports.ORG || !ports.ORG.canRedo()) { ports.toast('没有可重做的整理'); return; }
    const item = ports.ORG.redo(ports.S.organization);
    afterOrgChange(item.stepKey, '已重做');
  }
  function handleOrgPlace(payload) {
    window.__orgPlaceLog=(window.__orgPlaceLog||[]);window.__orgPlaceLog.push(payload&&payload.items?payload.items.length:String(payload));
    if (!ports.ORG || !payload || !payload.parentKey || !Array.isArray(payload.items)) return;
    const stepKey = payload.stepKey || 'plain';
    const items = payload.items.filter(function (item) {
      return item && item.ref && Number.isInteger(item.slot) && item.slot >= 0;
    });
    if (!items.length) return;
    ports.ORG.setLayout(ports.S.organization, stepKey, payload.parentKey, items);
    afterOrgChange(stepKey, '已调整位置');
  }
  function handleOrgResetLayout(node) {
    if (!ports.ORG || !node) return;
    const stepKey = stepKeyOfNode(node) || 'plain';
    const parentKey = node._parentKey || 'root';
    ports.ORG.clearLayout(ports.S.organization, stepKey, parentKey);
    afterOrgChange(stepKey, '已恢复默认排列');
  }
  function nodeIsPlaceable(node) {
    if (!node || !ports.ORG) return false;
    if (node.kind === 'localfile' || node.origin === 'removed' || node.trash) return false;
    if (String(node.id || '').indexOf('pile:') === 0) return false;
    return !!ports.ORG.refOfNode(node);
  }
  function handleOrgMove(payload) {
    if (!ports.ORG || !payload || !payload.target) return;
    const target = payload.target;
    const stepKey = stepKeyOfNode(target);
    if (!stepKey) return;
    const nodes = (payload.ids || []).map(function (id) { return ports.overview.findNode(id); }).filter(Boolean)
      .filter(function (n) { return n.id !== target.id; });
    if (!nodes.length) return;
    // 跨步骤混选拒绝：moveKeys 只改目标步骤的 organization，混选会把别的步骤的 key 写错地方。
    if (nodes.some(function (n) { return stepKeyOfNode(n) !== stepKey; })) {
      ports.toast('请选择同一步的结构再移动');
      return;
    }
    const userFolders = nodes.filter(function (n) { return n.origin === 'user' && n.orgId; });
    const keys = [];
    nodes.forEach(function (n) {
      if (!(n.origin === 'user' && n.orgId)) keys.push.apply(keys, nodePlaceKeys(n));
    });
    const flashTarget = function () {
      const box = document.querySelector('[data-entry-id="' + target.id + '"]');
      if (box) { box.classList.add('is-jump-flash'); setTimeout(function () { box.classList.remove('is-jump-flash'); }, 1200); }
    };
    if (target.origin === 'removed') {
      userFolders.forEach(function (n) { ports.ORG.restoreKeys(ports.S.organization, stepKey, nodePlaceKeys(n)); });
      if (keys.length) ports.ORG.restoreKeys(ports.S.organization, stepKey, keys);
      afterOrgChange(stepKey, '已从回收站还原');
      return;
    }
    if (target.origin === 'user') {
      userFolders.forEach(function (n) { ports.ORG.reparentFolder(ports.S.organization, stepKey, n.orgId, target.orgId); });
      if (keys.length) ports.ORG.moveKeys(ports.S.organization, stepKey, keys, target.orgId);
      afterOrgChange(stepKey, '已移入「' + target.name + '」');
      flashTarget();
      return;
    }
    if (target.origin === 'lineage') {
      userFolders.forEach(function (n) {
        ports.ORG.reparentFolder(ports.S.organization, stepKey, n.orgId, 'lineage:' + (target.groupKey || target.id));
      });
      const homeKeys = keys.filter(function (k) {
        const e = ports.S.entries.find(function (x) { return ports.entryOrgKey(x) === k; });
        return e && e.groupKey === target.groupKey;
      });
      if (homeKeys.length) ports.ORG.moveKeys(ports.S.organization, stepKey, homeKeys, 'root');
      afterOrgChange(stepKey, homeKeys.length || userFolders.length
        ? '已放回「' + target.name + '」'
        : '只能回到原来的谱系文件夹，或放进自己建的文件夹');
      return;
    }
  }
  function captureTrashFolder(node, stepKey) {
    const org = ports.S.organization[stepKey] || (ports.ORG ? ports.ORG.empty() : { folders: [], placements: {} });
    const ids = new Set([node.orgId]);
    let changed = true;
    while (changed) {
      changed = false;
      (org.folders || []).forEach(function (folder) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id); changed = true;
        }
      });
    }
    const folders = (org.folders || []).filter(function (folder) { return ids.has(folder.id); }).map(function (folder) {
      return { id: folder.id, name: folder.name, parentId: folder.parentId || null };
    });
    const placements = Object.keys(org.placements || {}).filter(function (key) {
      return ids.has(org.placements[key]);
    }).map(function (key) { return { key: key, folderId: org.placements[key] }; });
    return { id: node.orgId, name: node.name, stepKey: stepKey, stepTitle: node.stepTitle || '',
      folders: folders, entryKeys: placements.map(function (item) { return item.key; }), placements: placements, removedAt: Date.now() };
  }
  function orgRemoveSelection() {
    if (!ports.overview) return;
    const ids = ports.overview.selection();
    const nodes = ids.map(function (id) { return ports.overview.findNode(id); }).filter(Boolean);
    if (!nodes.length) return;
    const stepKey = stepKeyOfNode(nodes[0]);
    if (!stepKey) return;
    const targetCards = nodes.map(function (n) { return document.querySelector('[data-entry-id="' + n.id + '"]'); }).filter(Boolean);
    nodes.filter(function (n) { return n.kind === 'folder' && n.origin !== 'removed'; })
      .forEach(function (n) {
        if (n.origin === 'user') {
          ports.S.trashFolders.push(captureTrashFolder(n, stepKey));
        }
        ports.ORG.deleteFolder(ports.S.organization, stepKey, n);
      });
    const fileKeys = [];
    nodes.filter(function (n) { return n.kind === 'entry'; }).forEach(function (n) {
      fileKeys.push.apply(fileKeys, nodePlaceKeys(n));
    });
    if (fileKeys.length) ports.ORG.removeKeys(ports.S.organization, stepKey, fileKeys);
    animateTrashFlight(targetCards, function () {
      afterOrgChange(stepKey, '已移入回收站');
    });
  }
  function animateTrashFlight(cards, done) {
    const target = ports.$('btnTrash');
    if (!cards.length || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    const tr = target.getBoundingClientRect();
    let pending = cards.length;
    cards.forEach(function (card) {
      const r = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.className = 'trash-flight';
      ghost.style.left = r.left + 'px'; ghost.style.top = r.top + 'px';
      ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
      document.body.appendChild(ghost);
      requestAnimationFrame(function () {
        ghost.style.transform = 'translate(' + (tr.left + tr.width / 2 - r.left - r.width / 2) + 'px,' + (tr.top + tr.height / 2 - r.top - r.height / 2) + 'px) scale(.12)';
        ghost.style.opacity = '0';
      });
      setTimeout(function () { ghost.remove(); if (!--pending) done(); }, 360);
    });
  }
  function openOrgMenu(info) {
    const m = ports.$('orgMenu');
    if (!m || !ports.ORG) return;
    m.innerHTML = '';
    // 子菜单锚点：mk 在回调前先 closeMenus()，回调里 getBoundingClientRect() 拿到的是
    // display:none 的全 0 矩形——子菜单会因此跳到窗口左上角。所以打开时先记下位置。
    const menuAnchor = { left: 100, top: 100, bottom: 140, right: 300 };
    const mk = function (label, cls, fn) {
      const b = ports.el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
      b.addEventListener('click', function (e) { e.stopPropagation(); ports.closeMenus(); fn(e); });
      return b;
    };
    const node = info.node;
    const blank = !!info.blank;
    const ctx = currentOrgContext();
    let stepKey = stepKeyOfNode(node) || ctx.stepKey;
    // 方案 A：空白处右键 = 想在这一步里建夹。按点击位置反查所在 section 的 stepKey，
    // 兜底才是 ctx.stepKey（旧逻辑会丢进「其他导入」桶，文件夹像"消失"了一样）。
    if (blank && typeof info.y === 'number') {
      // section 盒子只有 40px 标题行，卡片行不算在内——归属 = 点击位置上方最近的 section 头
      let bestSec = null, bestTop = -Infinity;
      document.querySelectorAll('.overview-section').forEach(function (sb) {
        const t = sb.getBoundingClientRect().top;
        if (t <= info.y && t > bestTop) { bestTop = t; bestSec = sb; }
      });
      if (bestSec && bestSec.dataset.stepKey) stepKey = bestSec.dataset.stepKey;
    }
    const selectedNodes = (info.selected || []).map(function (id) {
      return ports.overview.findNode(id);
    }).filter(Boolean);
    if (!blank && node && node.kind === 'folder') {
      m.appendChild(mk('打开', '', function () { ports.overview.openFolder(node); }));
    }
    if (!blank && node && node.kind === 'entry' && node.entry) {
      m.appendChild(mk('打开结构', '', function () {
        ports.S.soloId = node.entry.id; ports.renderList(); ports.setMode('overlay'); ports.refreshBadge();
      }));
      // 方案 A：卡片右键直接移入工作台文件夹（多选时整批移入），不用非得记拖拽。
      const moveIds = (info.selected || []).filter(function (id) {
        const n = ports.overview.findNode(id);
        return n && n.kind === 'entry';
      });
      if (!moveIds.length && node.kind === 'entry') moveIds.push(node.entry.id);
      if (moveIds.length) {
        m.appendChild(mk('移入文件夹…', '', function (e) {
          // 真实点击用光标位置；合成 click（clientX=0）退回菜单打开时记录的锚点。
          const anchorRect = (e && e.clientX && e.clientY)
            ? { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX }
            : menuAnchor;
          ports.openOrgMoveMenu(moveIds, stepKey, anchorRect);
        }));
      }
    }
    m.appendChild(mk('新建文件夹…', '', function () {
      const parent = (node && node.kind === 'folder' && node.origin !== 'removed')
        ? parentIdForCreate(node)
        : (blank ? parentIdForCreate(node) : ctx.parentId);
      const pack = (!blank && node && node.kind === 'folder') ? []
        : (selectedNodes.length ? selectedNodes : (!blank && node ? [node] : []));
      promptNewOrgFolder(stepKey, parent, pack);
    }));
    if (!blank && nodeIsPlaceable(node) && ports.overview && ports.overview.enterPickPlace) {
      m.appendChild(mk('移动位置…', '', function () {
        // 选中集里同父层的可摆卡一起挪；否则只挪当前节点
        const sources = selectedNodes.filter(nodeIsPlaceable)
          .filter(function (n) { return n._parentKey === node._parentKey; });
        ports.overview.enterPickPlace(sources.length > 1 ? sources : [node]);
      }));
      m.appendChild(mk('恢复当前层默认排列', '', function () { handleOrgResetLayout(node); }));
    }
    if (!blank && node && node.kind === 'folder' && node.origin !== 'removed') {
      m.appendChild(mk('消除文件夹（拆开平铺）', '', function () {
        ports.ORG.dissolveFolder(ports.S.organization, stepKey, node);
        afterOrgChange(stepKey, '已消除「' + node.name + '」，内容留在当前层');
      }));
      m.appendChild(mk('删除文件夹', 'danger', function () {
        ports.S.trashFolders.push(captureTrashFolder(node, stepKey));
        ports.ORG.deleteFolder(ports.S.organization, stepKey, node);
        animateTrashFlight([document.querySelector('[data-entry-id="' + node.id + '"]')].filter(Boolean), function () {
          afterOrgChange(stepKey, '已移入回收站');
        });
      }));
      if (node.origin === 'user') {
        m.appendChild(mk('重命名…', '', function () { renameOrgFolder(node); }));
      }
    }
    if (!blank && node && node.origin === 'removed' && node.kind === 'folder') {
      m.appendChild(mk('全部还原', '', function () {
        ports.ORG.restoreKeys(ports.S.organization, stepKey, (node.entries || []).map(ports.entryOrgKey));
        afterOrgChange(stepKey, '已还原「已移除」中的结构');
      }));
    }
    if (!blank && node && node.kind === 'entry' && node.entry) {
        const inTrash = ((ports.S.organization[stepKey] || {}).removed || []).indexOf(ports.entryOrgKey(node.entry)) >= 0;
      if (inTrash) {
        m.appendChild(mk('还原', '', function () {
          ports.ORG.restoreKeys(ports.S.organization, stepKey, [ports.entryOrgKey(node.entry)]);
          afterOrgChange(stepKey, '已还原');
        }));
      } else {
        m.appendChild(mk('移除', 'danger', function () {
          ports.ORG.removeKeys(ports.S.organization, stepKey, [ports.entryOrgKey(node.entry)]);
          animateTrashFlight([document.querySelector('[data-entry-id="' + node.id + '"]')].filter(Boolean), function () {
            afterOrgChange(stepKey, '已移入回收站');
          });
        }));
      }
    }
    if (stepKey) {
      m.appendChild(ports.el('div', 'menu-sep'));
      m.appendChild(mk('恢复本步默认分组', '', function () { resetOrgStep(stepKey); }));
    }
    if (!m.children.length) return;
    m.hidden = false;
    ports.closeMenus('orgMenu');
    const mw = 220, mh = m.offsetHeight || 180;
    let x = Math.min(info.x || 8, window.innerWidth - mw - 8);
    let y = info.y || 8;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, y - mh);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    // 记录可见时的矩形，供子菜单（移入文件夹…）作兜底锚点
    const vr = m.getBoundingClientRect();
    menuAnchor.left = vr.left; menuAnchor.top = vr.top;
    menuAnchor.bottom = vr.bottom; menuAnchor.right = vr.right;
  }
  function handleOverviewStepAction(act, node, anchorEl) {
    const key = node && node.stepKey;
    if (!key) return;
    if (act === 'bench') {
      // 方案 A：整步一键进检阅台（该步全部结构，分页翻）。
      const stepEntries = ports.S.entries.filter(function (e) { return e.stepKey === key; });
      ports.openBenchWithEntries(stepEntries, '检阅台 · ' + (node.title || key) + ' · ' + stepEntries.length + ' 条');
      return;
    }
    if (act === 'append') { ports.triggerStepImport(key, true); return; }
    if (act === 'up') { moveStepByDelta(key, -1); return; }
    if (act === 'down') { moveStepByDelta(key, 1); return; }
    if (act === 'tool') { openStepModal({ mode: 'edit', stepKey: key }); return; }
    if (act === 'menu') {
      const steps = orderedStepBuckets(ports.S.entries, { includeEmpty: true });
      const step = key === 'plain'
        ? { key: 'plain', title: '其他导入', entries: ports.S.entries.filter(function (e) { return !e.stepKey; }) }
        : (steps.find(function (s) { return s.key === key; }) || { key: key, title: node.title, tool: node.tool, entries: [] });
      openStepMenu(step, anchorEl);
    }
  }
  function openTrashPage() {
    ports.S.trashReturnMode = ports.S.mode;
    ports.S.trashReturnPlace = (ports.S.mode === 'overview' && ports.overview && ports.overview.capture) ? ports.overview.capture() : null;
    ports.S.trashOpen = true;
    ports.closeMenus();
    ports.$('overviewStage').hidden = true;
    ports.$('gridStage').hidden = true;
    ports.$('overlayStage').hidden = true;
    ports.$('trashStage').hidden = false;
    renderTrashPage();
  }
  function closeTrashPage() {
    ports.S.trashOpen = false;
    ports.$('trashStage').hidden = true;
    const mode = ports.S.trashReturnMode || 'overview';
    if (ports.S.mode === mode) {
      // 同模式 setMode 会早退，不会重刷 stage 显隐——必须显式恢复总览并重建，
      // 否则 overviewStage 停在 openTrashPage 设置的 hidden 上，返回就是一片空白。
      ports.applyModeChange(true);
      if (mode === 'overview' && ports.S.trashReturnPlace && ports.overview && ports.overview.restore) {
        ports.overview.restore(ports.S.trashReturnPlace);
      }
      return;
    }
    ports.setMode(mode, mode === 'overview' ? { overviewPlace: ports.S.trashReturnPlace || null } : {});
  }
  function renderTrashPage() {
    const entries = trashEntries();
    const folders = ports.S.trashFolders || [];
    const steps = ports.S.trashSteps || [];
    const total = entries.length + folders.length + steps.length;
    const count = ports.$('trashPageCount');
    const host = ports.$('trashCards');
    const empty = ports.$('trashEmpty');
    if (count) count.textContent = total + ' 项';
    if (!host || !empty) return;
    if (!host.__trashView) host.__trashView=window.SB_UI.mountTrash(host);
    const rows=[],actions=new Map();
    empty.hidden = total > 0;
    const makeRow = function(label,meta,restore){const id=String(rows.length);rows.push({id,label,meta});actions.set(id,restore);};
    entries.forEach(function (entry) {
      makeRow(entry.name, '结构 · ' + (entry.stepTitle || entry.stepKey || '其他导入'), function () {
        const key = entry.stepKey || 'plain';
        if (ports.ORG) ports.ORG.restoreKeys(ports.S.organization, key, [ports.entryOrgKey(entry)]);
        afterOrgChange(key, '已还原「' + entry.name + '」');
        renderTrashPage();
      });
    });
    folders.forEach(function (item) {
      makeRow('文件夹 · ' + item.name, item.stepTitle || item.stepKey || '工作台文件夹', function () {
        const key = item.stepKey || 'plain';
        const org = ports.ORG ? ports.ORG.ensure(ports.S.organization, key) : null;
        if (org && Array.isArray(item.folders)) {
          item.folders.forEach(function (folder) {
            if (!org.folders.some(function (existing) { return existing.id === folder.id; })) org.folders.push(folder);
          });
          (item.placements || []).forEach(function (placement) { org.placements[placement.key] = placement.folderId; });
        }
        if (ports.ORG && item.entryKeys) ports.ORG.restoreKeys(ports.S.organization, key, item.entryKeys);
        ports.S.trashFolders = ports.S.trashFolders.filter(function (x) { return x.id !== item.id; });
        schedulePipelineSync(); ports.scheduleSessionSave(); refreshOrgButtons(); renderTrashPage();
        ports.toast('已还原文件夹「' + item.name + '」');
      });
    });
    steps.forEach(function (item) {
      makeRow('步骤 · ' + item.title, item.count + ' 条结构', function () {
        const key = item.key;
        if (ports.ORG && ports.S.organization[key]) {
          ports.ORG.restoreKeys(ports.S.organization, key, ports.S.entries.filter(function (e) { return e.stepKey === key; }).map(ports.entryOrgKey));
        }
        ports.saveStepEdit(key, { deleted: false });
        if (item.custom && !ports.S.customSteps.some(function (s) { return s.key === key; })) ports.S.customSteps.push(item.custom);
        ports.S.trashSteps = ports.S.trashSteps.filter(function (x) { return x.key !== key; });
        schedulePipelineSync(); ports.scheduleSessionSave(); refreshStepsUI(true); renderTrashPage();
        ports.toast('已还原步骤「' + item.title + '」');
      });
    });
    host.__trashView.update({model:{items:rows},handlers:{restore:function(id){const fn=actions.get(id);if(fn)fn();}}});
  }
  function restoreAllTrash() {
    const entries = trashEntries();
    entries.forEach(function (entry) {
      const key = entry.stepKey || 'plain';
      if (ports.ORG) ports.ORG.restoreKeys(ports.S.organization, key, [ports.entryOrgKey(entry)]);
    });
    for (const item of ports.S.trashFolders || []) {
      const key=item.stepKey||'plain',org=ports.ORG?ports.ORG.ensure(ports.S.organization,key):null;
      if(org){for(const folder of item.folders||[])if(!org.folders.some(existing=>existing.id===folder.id))org.folders.push(folder);
        for(const placement of item.placements||[])org.placements[placement.key]=placement.folderId;
        if(item.entryKeys)ports.ORG.restoreKeys(ports.S.organization,key,item.entryKeys);}
    }
    for (const item of ports.S.trashSteps || []) {
      ports.saveStepEdit(item.key,{deleted:false});
      if(item.custom&&!ports.S.customSteps.some(step=>step.key===item.key))ports.S.customSteps.push(item.custom);
    }
    ports.S.trashFolders = []; ports.S.trashSteps = [];
    schedulePipelineSync(); ports.scheduleSessionSave(); refreshStepsUI(true); renderTrashPage(); ports.toast('已还原全部回收站内容');
  }
// SERVICE_FUNCTIONS_END
  return { orderedStepBuckets, persistStepOrder, mergePipelineSteps, cancelPipelineSync, schedulePipelineSync, refreshStepsUI, moveStepByDelta, moveStepBefore, createCustomStep, renameStepPrompt, deleteStep, moveEntriesToStep, openMoveToStepMenu, deriveStepFromStars, openStepModal, closeStepModal, openStepMenu, attachStepOrganization, stepKeyOfNode, parentIdForCreate, nodePlaceKeys, trashEntries, updateTrashBadge, refreshOrgButtons, afterOrgChange, currentOrgContext, promptNewOrgFolder, renameOrgFolder, resetOrgStep, undoOrg, redoOrg, handleOrgPlace, handleOrgResetLayout, nodeIsPlaceable, handleOrgMove, captureTrashFolder, orgRemoveSelection, animateTrashFlight, openOrgMenu, handleOverviewStepAction, openTrashPage, closeTrashPage, renderTrashPage, restoreAllTrash };
}
