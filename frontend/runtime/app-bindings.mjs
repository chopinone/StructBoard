// app-bindings: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function bind() {
    ports.harnessPane(ports.paneStage(0), 0);
    ports.bindGroupNavigation();
    ports.bindSidebar();
    // 设计管线浮层：背景虚化 + 面板缩放淡入，点外面 / Esc / 关闭按钮收回
    const pipeOverlay = ports.$('pipelineOverlay');
    const pipePanel = ports.$('pipelinePanel');
    function roundedBlurClip(box, panelWidth, panelHeight, scale, translateY) {
      const radius = Math.max(0, parseFloat(getComputedStyle(pipePanel).borderTopLeftRadius) * scale - .5);
      const w = panelWidth * scale - 1, h = panelHeight * scale - 1;
      const x = (box.width - panelWidth * scale) / 2 + .5;
      const y = (box.height - panelHeight * scale) / 2 + translateY + .5;
      const points = ['0px 0px', box.width + 'px 0px', box.width + 'px ' + box.height + 'px', '0px ' + box.height + 'px', '0px 0px'];
      const hole = [];
      for (const corner of [[x + w - radius, y + radius, -90], [x + w - radius, y + h - radius, 0], [x + radius, y + h - radius, 90], [x + radius, y + radius, 180]]) {
        for (let i = 0; i <= 8; i++) {
          const a = (corner[2] + i * 90 / 8) * Math.PI / 180;
          hole.push((corner[0] + Math.cos(a) * radius).toFixed(3) + 'px ' + (corner[1] + Math.sin(a) * radius).toFixed(3) + 'px');
        }
      }
      points.push.apply(points, hole.concat(hole[0]));
      return 'polygon(evenodd, ' + points.join(', ') + ')';
    }
    function updatePeripheralBlur() {
      if (pipeOverlay.hidden) return;
      const box = pipeOverlay.getBoundingClientRect();
      const width = pipePanel.offsetWidth, height = pipePanel.offsetHeight;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      pipeOverlay.style.setProperty('--pipeline-blur-closed', roundedBlurClip(box, width, height, reduced ? 1 : .94, reduced ? 0 : 14));
      pipeOverlay.style.setProperty('--pipeline-blur-open', roundedBlurClip(box, width, height, 1, 0));
    }
    window.addEventListener('resize', updatePeripheralBlur);
    const fullscreenButton = ports.$('btnPipelineFullscreen');
    function setPipelineFullscreen(full) {
      pipeOverlay.classList.toggle('is-fullscreen', full);
      fullscreenButton.setAttribute('aria-pressed', String(full));
      fullscreenButton.setAttribute('aria-label', full ? '还原设计管线' : '全屏设计管线');
      fullscreenButton.title = full ? '还原设计管线（Esc）' : '全屏设计管线';
      fullscreenButton.querySelector('span').textContent = full ? '还原' : '全屏';
      fullscreenButton.querySelector('path').setAttribute('d', full
        ? 'M3 7h4V3m6 0v4h4M7 17v-4H3m14 0h-4v4'
        : 'M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4');
      ports.$('pipelineFrame').contentWindow.postMessage({type: 'pipelineFullscreen', full: full}, location.origin);
      updatePeripheralBlur();
    }
    function restorePipeline() {
      setPipelineFullscreen(false);
      if (window.__SB_DESKTOP_INVOKE__) window.__SB_DESKTOP_INVOKE__('desktop_fullscreen', {full: false}).catch(() => {});
      else if (document.fullscreenElement === pipeOverlay) document.exitFullscreen().catch(() => {});
    }
    fullscreenButton.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pipeOverlay.classList.contains('is-fullscreen')) { restorePipeline(); return; }
      setPipelineFullscreen(true);
      // 独立窗口若禁用原生全屏，仍保留铺满工作区的放大视图。
      if (window.__SB_DESKTOP_INVOKE__) window.__SB_DESKTOP_INVOKE__('desktop_fullscreen', {full: true}).catch(() => {});
      else if (pipeOverlay.requestFullscreen) pipeOverlay.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', function () {
      if (document.fullscreenElement === pipeOverlay) setPipelineFullscreen(true);
      else if (pipeOverlay.classList.contains('is-fullscreen')) setPipelineFullscreen(false);
    });
    function escapePipeline() {
      if (pipeOverlay.classList.contains('is-fullscreen')) restorePipeline();
      else closePipeline();
    }
    let pipeHideTimer = null;
    const openPipeline = function () {
      clearTimeout(pipeHideTimer);
      pipeOverlay.hidden = false;
      void pipeOverlay.offsetWidth;   // 强制 reflow，让过渡动画生效
      updatePeripheralBlur();
      // 先提交遮罩和面板各自的起始样式，再由同一次 class 变更一起过渡。
      getComputedStyle(pipeOverlay, '::before').opacity;
      getComputedStyle(pipePanel).transform;
      pipeOverlay.classList.add('open');
    };
    const closePipeline = function () {
      if (pipeOverlay.hidden) return;
      if (pipeOverlay.classList.contains('is-fullscreen')) restorePipeline();
      pipeOverlay.classList.remove('open');
      clearTimeout(pipeHideTimer);
      pipeHideTimer = setTimeout(function () { if (!pipeOverlay.classList.contains('open')) pipeOverlay.hidden = true; }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300);
    };
    ports.$('btnPipeline').addEventListener('click', function () { openPipeline(); pushPipelineData(); });
    ports.$('btnPipelineClose').addEventListener('click', function (e) { e.stopPropagation(); closePipeline(); });
    pipeOverlay.addEventListener('click', function (e) {
      if (e.target === pipeOverlay) closePipeline();   // 只点遮罩本身才关，面板内不关
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!pipeOverlay.hidden) { escapePipeline(); return; }
        if (!ports.$('seqOverlay').hidden) { ports.closeSeqViewer(); return; }
        const inEditor = e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
        const menuOpen = Array.from(document.querySelectorAll('.menu')).some(function (m) { return !m.hidden; });
        const metricsOpen = ports.$('metricsPanel').classList.contains('open');
        if (ports.paneActionsMenu && !ports.paneActionsMenu.hidden) {
          ports.paneActionsMenu.hidden = true;
          if (ports.paneActionsMenu.__sbAnchor) { ports.paneActionsMenu.__sbAnchor.setAttribute('aria-expanded', 'false'); ports.paneActionsMenu.__sbAnchor.focus(); }
          return;
        }
        if (menuOpen || metricsOpen) {
          ports.closeMenus();
          ports.panes.forEach(function (pane) { ports.closePaneControlMenus(pane); });
          ports.$('metricsPanel').classList.remove('open');
          return;
        }
        if (ports.S.mode === 'overview' && ports.overview && ports.overview.back && ports.overview.back()) return;
        if (ports.S.mode === 'grid' && (ports.S.gridDrill || ports.S.gridFromOverview) && !inEditor) {
          e.preventDefault(); ports.backGridFolder(); return;
        }
        if (ports.S.mode === 'overlay' && ports.S.soloId && !inEditor) {
          e.preventDefault(); ports.$('btnShowAll').click(); return;
        }
        ports.closeMenus();
        ports.$('metricsPanel').classList.remove('open');
      }
    });
    const NOTES_KEY = ports.windowStorageKey('structboard.pipelineNotes');
    function loadPipelineNotes() {
      try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch (e) { return {}; }
    }
    function pipelinePayload() {
      return {
        type: 'pipelineData',
        groups: ports.S.groups.map(function (g) {
          return {
            id: g.id, name: g.name, createdAt: g.createdAt,
            files: g.entryIds.map(function (id) {
              const e = ports.S.entries.find(function (x) { return x.id === id; });
              return e ? { name: e.name, size: e.size } : null;
            }).filter(Boolean),
          };
        }),
        notes: loadPipelineNotes(),
        activeGroupId: ports.S.activeGroupId,
        theme: ports.isDarkTheme() ? 'dark' : 'light',
      };
    }
    function pushPipelineData() {
      const frame = ports.$('pipelineFrame');
      if (!frame || !frame.contentWindow) return;
      try { frame.contentWindow.postMessage(pipelinePayload(), location.origin); } catch (e) { /* ignore */ }
    }
    let pipelineLoading = false;
    async function openPipelineStep(d) {
      const pane = ports.paneAt(d.pane), S = ports.paneContext(pane);
      if (!pane || pane.disposed || !S) return false;
      const ownerLife = pane.life, ownerEpoch = S.workspaceEpoch || 0;
      const checkOwner = function () {
        if (pane.disposed || pane.life !== ownerLife || (S.workspaceEpoch || 0) !== ownerEpoch) {
          const error = new Error('目标分栏已关闭，已停止载入');
          error.name = 'AbortError'; throw error;
        }
      };
      const frame = ports.$('pipelineFrame');
      const report = function (state, text) {
        frame.contentWindow.postMessage({type: 'pipelineLoadStatus', requestId: d.requestId, state: state, text: text}, location.origin);
      };
      // A node in another pipeline belongs to its own workspace. Load its
      // metadata into an independent tab before locating the requested step.
      // Never append it into the current tab and change only activePipelineId.
      if (!d.batch && d.id && ports.rawS.activePipelineId !== d.id) {
        report('loading', '正在独立标签中打开管线…');
        const opened = await importWholePipeline({ pipelineId: d.id, openAsTab: true, pane: pane });
        if (!opened || ports.rawS.activePipelineId !== d.id) {
          report('error', '管线未打开，原工作区已保留'); return false;
        }
        return openPipelineStep(Object.assign({}, d, { pane: ports.paneAt(), catalog: true }));
      }
      // 方案 A：这一步已经在总览里 → 流程节点点击变成「定位」，直接滚过去，不重复加载。
      const alreadyKey = (d.id || '') + ':' + (d.stepId || '');
      if (d.id && !d.batch) ports.hydrateStepNotesFromPipeline(d.id);
      if (!d.batch && S.entries.some(function (e) { return e.stepKey === alreadyKey; })) {
        report('done', '已在总览中定位');
        const locate = function () {
          if (pane.disposed || pane.life !== ownerLife) return false;
          const host = pane.overview;
          return host && host.scrollToStep ? host.scrollToStep(alreadyKey) : false;
        };
        if (S.mode !== 'overview') ports.withPaneSync(pane, function () { ports.setMode('overview', {}, pane); });
        const ok = locate();
        if (!ok) setTimeout(locate, 150);
        closePipeline();
        ports.toast(ok ? ('已定位到' + (d.title ? '「' + d.title + '」' : '这一步'))
                 : ('已切到总览' + (d.title ? '「' + d.title + '」' : '') + '；这一步可能被筛选隐藏了'), !ok);
        return;
      }
      if (pipelineLoading && !d.batch) { report('error', '已有步骤正在加载，请稍候'); return; }
      if (!d.batch) pipelineLoading = true;
      try {
        const query = '?id=' + encodeURIComponent(d.id) + '&step=' + encodeURIComponent(d.stepId);
        report('loading', '正在读取结构清单…');
        const response = await fetch('/api/pipeline/structures' + query, {cache: 'no-store', signal: d.signal});
        checkOwner();
        const manifest = await response.json();
        checkOwner();
        if (!response.ok || !manifest.ok) throw new Error(manifest.error || '读取结构清单失败');
        if (!manifest.files.length) throw new Error('这一步没有可加载的结构文件，请检查步骤的 files / globs / dir');
        const membershipKey = d.id + ':' + d.stepId;
        // Older snapshots deduplicated physical files across stages. Upgrade only
        // entries owned by this stage; never overwrite another stage's membership.
        const legacyByFile = new Map(S.entries.filter(e => e.stepKey === membershipKey).map(e => [e.fileKey || e.sourceKey, e]));
        for (const item of manifest.files) {
          const old = legacyByFile.get(item.fileKey);
          if (old && old.sourceKey !== item.sourceKey) { old.sourceKey = item.sourceKey; old.fileKey = item.fileKey; }
        }
        const cached = new Map(S.entries.filter(e => e.sourceKey).map(e => [e.sourceKey, e]));
        const existingGroup = S.groups.find(g => g.pipelineKey === membershipKey);
        for (const item of manifest.files) {
          const e = cached.get(item.sourceKey);
          if (!e) continue;
          Object.assign(e, ports.LINEAGE.meta(item));
          e.group = item.group || null;
          e.modelIndex = item.modelIndex == null ? null : item.modelIndex;
          if (!e.renamed && item.name) e.name = item.name;
          if (!e.starManual) e.star = !!item.star;
        }
        const currentKeys = new Set(existingGroup ? existingGroup.entryIds.map(id => S.entries.find(e => e.id === id)?.sourceKey) : []);
        const alreadyDisplayed = S.mode === 'overlay' ? S.overlayRefs.length : S.gridViewers.length;
        if (existingGroup && S.activeGroupId === existingGroup.id && currentKeys.size === manifest.files.length &&
            manifest.files.every(f => currentKeys.has(f.sourceKey) && cached.get(f.sourceKey)?.visible) &&
            !S.filter && !S.soloId && !S.starOnly && !S.metrics.filters.length && alreadyDisplayed) {
          report('done', '已打开 ' + manifest.files.length + ' 个结构');
          closePipeline();
          ports.toast('已打开「' + manifest.title + '」· ' + manifest.files.length + ' 个结构');
          return;
        }
        const raws = [], ids = [], failed = [];
        let cursor = 0, done = 0;
        function stubRaw(item) {
          const name = item.name || '';
          const formatPath = item.path || item.fullPath || name;
          const format = /\.bcif(\.gz)?$/i.test(formatPath) ? 'bcif'
            : (/\.(cif|mmcif|mcif)(\.gz)?$/i.test(formatPath) ? 'mmcif' : 'pdb');
          return {
            name: name, path: item.fullPath || item.path, fullPath: item.fullPath || '',
            size: item.size || 0, star: !!item.star, sourceKey: item.sourceKey,
            group: item.group || null,
            modelIndex: (item.modelIndex === undefined || item.modelIndex === null) ? null : item.modelIndex,
            ...ports.LINEAGE.meta(item),
            stepOperation: manifest.operation || '', stepState: manifest.state || '', stepDesc: manifest.desc || '',
            format: format, parsed: null, data: null, lazy: true,
            fetchUrl: '/api/pipeline/structure' + query + '&path=' + encodeURIComponent(item.path),
          };
        }
        if (d.catalog) {
          for (const item of manifest.files) {
            if (cached.has(item.sourceKey)) ids.push(cached.get(item.sourceKey).id);
            else raws.push(stubRaw(item));
          }
        }
        async function worker() {
          if (d.catalog) return;
          while (cursor < manifest.files.length) {
            const item = manifest.files[cursor++];
            try {
              if (cached.has(item.sourceKey)) ids.push(cached.get(item.sourceKey).id);
              else {
                const r = await fetch('/api/pipeline/structure' + query + '&path=' + encodeURIComponent(item.path), {cache: 'no-store'});
                if (!r.ok) {
                  const error = await r.json();
                  throw new Error(error.error || '读取失败');
                }
                const raw = await ports.IO.readFile(new File([await r.arrayBuffer()], (item.path || item.name).split('/').pop()));
                raw.name = item.name || raw.name;
                raw.path = item.fullPath || item.path;
                raw.star = !!item.star;
                raw.sourceKey = item.sourceKey;
                raw.group = item.group || null;                       // 候选文件夹分组（后端按 _model_N / groupBy 推断）
                raw.modelIndex = (item.modelIndex === undefined || item.modelIndex === null) ? null : item.modelIndex;
                Object.assign(raw, ports.LINEAGE.meta(item));
                raw.stepOperation = manifest.operation || ''; raw.stepState = manifest.state || ''; raw.stepDesc = manifest.desc || '';
                raw.parsed = undefined;
                raws.push(raw);
              }
            } catch (err) { failed.push(item.name + '：' + err.message); }
            done++;
            report('loading', '已读取 ' + done + ' / ' + manifest.files.length + ' 个结构');
            if (done % 5 === 0) await ports.sleep(0);
          }
        }
        await Promise.all(Array.from({length: Math.min(4, manifest.files.length)}, worker));
        checkOwner();
        if (!raws.length && !ids.length) throw new Error('结构读取失败：' + failed.slice(0, 2).join('；'));
        // 先按清单顺序建立列表，再复用同一文件已有的内存条目。
        const order = new Map(manifest.files.map((f, i) => [f.sourceKey, i]));
        raws.sort((a, b) => order.get(a.sourceKey) - order.get(b.sourceKey));
        if (raws.length) ports.withPaneSync(pane, function () {
          ports.addEntries(raws, manifest.title, {group: false, rebuild: false, quiet: true, deferRender: !!(d.catalog && d.batch), skipSessionSave: true, pane: pane});
        });
        checkOwner();
        const sourceKeys = new Set(manifest.files.map(f => f.sourceKey));
        const entries = S.entries.filter(e => sourceKeys.has(e.sourceKey));
        const key = d.id + ':' + d.stepId;
        let group = S.groups.find(g => g.pipelineKey === key);
        if (!group) {
          group = ports.withPaneSync(pane, function () { return ports.createGroup(manifest.title, [], false); });
          group.pipelineKey = key;
        }
        group.entryIds = entries.sort((a, b) => order.get(a.sourceKey) - order.get(b.sourceKey)).map(e => e.id);
        group.stepIndex = Number.isFinite(d.stepIndex) ? d.stepIndex : group.stepIndex;
        const stepIndex = Number.isFinite(d.stepIndex) ? d.stepIndex : 0;
        const saved = ports.loadStepEdits()[key] || {};
        const resolvedIndex = Number.isFinite(saved.order) ? saved.order : stepIndex;
        const resolvedTitle = saved.title || d.title || manifest.title;
        const resolvedTool = saved.tool !== undefined ? saved.tool : (d.tool || manifest.tool || '');
        S.activePipelineId = d.id;
        if (!S.activePipelineName) S.activePipelineName = d.pipelineName || d.id;
        entries.forEach(function (e) {
          e.visible = true;
          e.stepKey = key;
          e.stepIndex = resolvedIndex;
          e.stepTitle = resolvedTitle;
          e.stepTool = resolvedTool;
          e.stepOperation = manifest.operation || '';
          e.stepState = manifest.state || '';
          e.stepDesc = manifest.desc || '';
          e.pipelineId = d.id;
        });
        if (!d.batch) ports.scheduleSessionSave();
        if (!d.batch) ports.withPaneSync(pane, function () { ports.autoApplyScores(raws.map(ports.plddtRow).filter(Boolean)); });
        if (d.batch) {
          report('done', '已读取 ' + entries.length + ' 个结构');
          return;
        }
        ports.withPaneSync(pane, function () {
          S.activeGroupId = group.id;
          S.soloId = null; S.page = 0; S.filter = ''; S.starOnly = false; S.metrics.filters = [];
          ports.resetGridNavigation();
          ports.$('searchInput').value = '';
          ports.renderMetricUI(); ports.renderGroups(); ports.renderList(); ports.refreshBadge();
          ports.applyModeChange(false, pane);
        });
        report('loading', '正在显示 ' + entries.length + ' 个结构…');
        const displayMode = S.mode;
        if (displayMode === 'overview') {
          ports.rebuildOverview(pane.index);
        } else {
          if (displayMode === 'overlay') await ports.rebuildOverlay(true, pane);
          else await ports.rebuildGrid(pane);
          checkOwner();
          if (S.mode !== displayMode) return;
          const displayed = new Set((displayMode === 'overlay' ? S.overlayRefs.map(r => r.id) : S.gridViewers.map(v => v.entryId)));
          const expected = ports.withPaneSync(pane, function () {
            return displayMode === 'overlay' ? ports.visibleEntries().slice(0, S.maxOverlay || entries.length)
              : S.gridNodes.slice(S.page * ports.pageSize(), (S.page + 1) * ports.pageSize()).map(ports.gridNodeEntry);
          });
          const renderFailed = expected.filter(e => !displayed.has(e.id));
          if (!displayed.size) throw new Error('结构已读取，但未能显示模型；请检查结构文件内容');
          renderFailed.forEach(e => failed.push(e.name + '：模型显示失败'));
        }
        report('done', '已打开 ' + entries.length + ' 个结构');
        closePipeline();
        const message = '已打开「' + manifest.title + '」· ' + entries.length + ' 个结构';
        ports.toast(message + (failed.length ? '；' + failed.length + ' 个失败：' + failed.slice(0, 2).join('；') : ''), !!failed.length);
        pushPipelineData();
      } catch (err) {
        report('error', err.message);
        if (d.batch) throw err;
        ports.toast(err.message, true);
      } finally { if (!d.batch) pipelineLoading = false; }
    }
    window.addEventListener('message', function (e) {
      if (e.source !== ports.$('pipelineFrame').contentWindow) return;
      // 同源嵌入的流程画布才处理，外部页面无法伪造消息类型。
      if (e.origin !== location.origin && location.origin !== 'null') return;
      const d = e.data;
      if (d === 'closePipeline') { closePipeline(); return; }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'pipelineEscape') { escapePipeline(); return; }
      if (d.type === 'closePipeline') { closePipeline(); return; }
      if (d.type === 'pipelineReady') { pushPipelineData(); return; }
      if (d.type === 'pipelineNote') {
        const notes = loadPipelineNotes();
        notes[d.id] = d.text;
        try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (err) { /* ignore */ }
        return;
      }
      if (d.type === 'pipelineOpenStep') { openPipelineStep(d); return; }
      if (d.type === 'pipelineOpenGroup') {
        const g = ports.S.groups.find(function (x) { return x.id === d.id; });
        if (g) { ports.setActiveGroup(g.id, { force: true }); closePipeline(); ports.toast('已切到文件夹「' + g.name + '」'); }
      }
    });
    async function importWholePipeline(opts) {
      opts = (opts && typeof opts === 'object' && !(typeof Event !== 'undefined' && opts instanceof Event)) ? opts : {};
      const ownerPane = ports.paneAt(opts.pane);
      if (!ownerPane || ownerPane.disposed) return false;
      const ownerLife = ownerPane.life, ownerEpoch = ports.S.workspaceEpoch || 0;
      const run = { controller: new AbortController(), cancelled: false, committing: false };
      const checkOwner = function () {
        if (run.cancelled || ownerPane.disposed || ownerPane.life !== ownerLife || (ports.S.workspaceEpoch || 0) !== ownerEpoch) {
          const error = new Error('导入已停止'); error.name = 'AbortError'; throw error;
        }
      };
      const silent = !!opts.silent;
      if (pipelineLoading) { if (!silent) ports.toast('已有步骤正在加载，请稍候', true); return false; }
      pipelineLoading = true;
      let persisted = false;
      let targetSessionKey = '';
      const previousSessionKey = ports.sessionStore.getKey();
      let openAsTab = !!opts.openAsTab;
      const previousPipelineId = ports.currentWorkspaceTabId();
      const replaceEmptyLocalTab = ports.isLocalWorkspaceTab(previousPipelineId) && !ports.hasWorkspaceContent(ports.rawS);
      let confirmed = ports.rawS.restoringSession;
      try {
        const request = { cache: 'no-store', signal: run.controller.signal };
        const listRes = await fetch('/api/pipelines', request);
        checkOwner();
        const list = await listRes.json();
        checkOwner();
        if (!listRes.ok || !list.ok) throw new Error(list.error || '读不到管线列表');
        const pipes = (list.pipelines || []).filter(function (p) { return !p.error && p.steps; });
        if (!pipes.length) throw new Error('还没有可导入的管线');
        let pipe = opts.pipelineId ? pipes.find(function (p) { return p.id === opts.pipelineId; }) : pipes[0];
        if (!pipe) throw new Error('所选管线不存在或没有步骤');
        if (!opts.pipelineId && pipes.length > 1) {
          const picked = await ports.askSheet({
            title: '导入哪一条管线',
            message: '整条导入只打开所选管线。',
            choices: pipes.map(function (p) {
              return {
                value: p.id,
                label: p.name,
                detail: p.steps + ' 步' + (p.target ? ' · ' + p.target : ''),
              };
            }),
          });
          if (!picked) return false;
          pipe = pipes.find(function (p) { return p.id === picked; });
          if (!pipe) return false;
          checkOwner();
        }
        if (openAsTab && !opts.forceReload && !ports.rawS.restoringSession) {
          const cachedTab = await ports.sessionStore.load(ports.pipelineWorkspaceKey(pipe.id));
          if (cachedTab) {
            ports.pipelineTabs.add({ id: pipe.id, name: pipe.name || pipe.id }, false);
            pipelineLoading = false;
            const switched = await ports.switchPipelineTab(pipe.id);
            if (switched && replaceEmptyLocalTab) { ports.pipelineTabs.remove(previousPipelineId); ports.renderPipelineTabs(); }
            return switched;
          }
        }
        if (ports.hasWorkspaceContent(ports.rawS) && !ports.rawS.restoringSession && !openAsTab) {
          if (silent) return false;
          const picked = await ports.askSheet({
            title: '打开管线',
            message: '「' + pipe.name + '」· ' + pipe.steps + ' 步',
            choices: [
              { value: 'tab', label: '新建管线标签', detail: '保留当前工作区，单独打开这条管线' },
              { value: 'replace', label: '替换当前标签', detail: '先保存当前工作区，再打开新管线' },
            ],
          });
          if (picked === 'tab') openAsTab = true;
          else if (picked === 'replace') confirmed = true;
          else return false;
          checkOwner();
        }
        if (!silent) {
          ports.loadProgressRun = run;
          ports.setLoadProgress('读取管线', 0, '正在读取「' + pipe.name + '」的步骤…');
        }
        ports.status('正在读取「' + pipe.name + '」…');
        const url = '?id=' + encodeURIComponent(pipe.id);
        const defRes = await fetch('/api/pipeline' + url + '&raw=1', request);
        checkOwner();
        const def = await defRes.json();
        checkOwner();
        if (!defRes.ok || !def.ok || !def.pipeline || def.pipeline.id !== pipe.id || !Array.isArray(def.pipeline.steps)) {
          throw new Error(def.error || '读取管线失败');
        }
        const steps = def.pipeline.steps, manifests = [];
        for (let i = 0; i < steps.length; i++) {
          checkOwner();
          const step = steps[i];
          if (!step || !step.id) throw new Error('管线步骤缺少标识');
          const label = (i + 1) + ' / ' + steps.length + ' · ' + (step.title || step.id);
          if (!silent) ports.setLoadProgress('读取结构清单', (i / steps.length) * 95, label);
          const response = await fetch('/api/pipeline/structures' + url + '&step=' + encodeURIComponent(step.id), request);
          const manifest = await response.json();
          checkOwner();
          if (!response.ok || !manifest.ok) {
            throw new Error('读取「' + (step.title || step.id) + '」失败：' + (manifest.error || '未取得结构清单'));
          }
          manifests.push(manifest);
        }
        const saver = ports.workspaceSaveCoordinator();
        for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
          if (pane.overview && pane.overview.flushNoteEdits) pane.overview.flushNoteEdits();
        }
        if (!silent) ports.setLoadProgress('保存工作区', 96, '正在保存导入前的修改…');
        if (!await saver.flush()) throw new Error('旧工作区未能保存');
        checkOwner();
        ports.savePipelineViewNow();
        const replacing = ports.hasWorkspaceContent(ports.rawS);
        if (replacing && !confirmed && !openAsTab) throw new Error('当前工作区有新增内容，请重新确认替换');
        const prepared = ports.preparePipelineWorkspace(def.pipeline, manifests);
        prepared.activePipelineName = def.pipeline.name || pipe.name || pipe.id;
        targetSessionKey = ports.pipelineWorkspaceKey(pipe.id);
        ports.sessionStore.setKey(targetSessionKey);
        const nextSnapshot = ports.buildLocalSnapshot(prepared);
        // Cancel remains available while reading manifests and flushing old edits.
        // From here one storage transaction writes both snapshots or neither.
        run.committing = true;
        if (!silent) ports.$('loadProgressCancel').disabled = true;
        await saver.persistImport(nextSnapshot, replacing && !openAsTab ? ports.buildLocalSnapshot() : null, checkOwner);
        persisted = true;
        if ((ports.rawS.workspaceEpoch || 0) !== ownerEpoch) return false;
        if (ports.folderEditStore.activateWorkspace) ports.folderEditStore.activateWorkspace(nextSnapshot.workspaceId);
        ports.folderEditStore.restore(nextSnapshot.folderEdits, nextSnapshot.workspaceId);
        if (((!openAsTab && replacing) || replaceEmptyLocalTab) && previousPipelineId && previousPipelineId !== pipe.id) ports.pipelineTabs.remove(previousPipelineId);
        ports.publishPipelineWorkspace(prepared, ownerPane);
        const empty = manifests.filter(function (manifest) { return !manifest.files.length; }).length;
        const summary = prepared.entries.length + ' 个结构 / ' + steps.length + ' 步' + (empty ? '，其中 ' + empty + ' 步没有结构' : '');
        ports.status('已打开「' + (def.pipeline.name || pipe.name) + '」· ' + summary);
        if (!silent) {
          ports.toast('已打开「' + (def.pipeline.name || pipe.name) + '」· ' + summary);
        }
        return true;
      } catch (err) {
        if (!persisted) ports.sessionStore.setKey(previousSessionKey);
        if (!silent) {
          const message = persisted ? '管线已保存，刷新页面可重新打开：' + (err.message || String(err))
            : (run.cancelled || err.name === 'AbortError') ? '导入已停止，未替换工作区'
            : '导入失败，原工作区已保留：' + (err.message || String(err));
          ports.status(message);
          ports.toast(message, err.name !== 'AbortError');
        }
        return persisted;
      } finally {
        if (ports.loadProgressRun === run) {
          ports.loadProgressRun = null;
          ports.$('loadProgressCancel').disabled = false;
          ports.hideLoadProgress();
        }
        pipelineLoading = false;
      }
    }
    window.__SB_RESTORE_PIPELINE__ = function (pid, opts) {
      return importWholePipeline(Object.assign({}, opts || {}, { pipelineId: pid }));
    };
    ports.$('loadProgressCancel').addEventListener('click', function () {
      if (!ports.loadProgressRun || ports.loadProgressRun.committing) return;
      ports.loadProgressRun.cancelled = true;
      ports.loadProgressRun.controller.abort();
    });
    ports.panePipelineController = { open: openPipeline, close: closePipeline, push: pushPipelineData, importWholePipeline: importWholePipeline,
      get busy() { return pipelineLoading; } };
    window.__SB_PIPELINE__ = {
      open: function () { openPipeline(); pushPipelineData(); },
      close: closePipeline, push: pushPipelineData,
    };
    // iframe 可能先于 bind() 加载完并错过 handshake，这里补两道
    ports.$('pipelineFrame').addEventListener('load', pushPipelineData);
    // bind() runs after the startup handshake. Loading the iframe earlier makes
    // its transport miss the parent's late desktop config and falsely go offline.
    ports.$('pipelineFrame').setAttribute('src', 'pipeline.html?v=20261120-migration');
    setTimeout(pushPipelineData, 350);
    ports.$('btnNewGroup').addEventListener('click', function () {
      ports.askSheet({ title: '新建文件夹', value: '新建文件夹 ' + (ports.S.groups.length + 1), ok: '创建' }).then(function (name) {
        if (!name || !name.trim()) return;
        ports.createGroup(name.trim(), [], false);
        ports.toast('已新建「' + name.trim() + '」，用列表里的「移入」把结构放进来');
      });
    });
    ports.$('btnMoveVisible').addEventListener('click', function (e) {
      const ids = ports.visibleEntries().map(function (x) { return x.id; });
      if (!ids.length) { ports.toast('当前没有可移入的结构', true); return; }
      ports.openGroupMenu(ids, e.currentTarget);
    });
    document.addEventListener('click', function (e) {
      const menu = ports.$('groupMenu');
      if (menu.hidden) return;
      if (menu.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('#btnMoveVisible, .mini-tag-btn')) return;
      ports.closeGroupMenu();
    });

    ports.$('btnImport').addEventListener('click', function () { ports.toggleMenu('importMenu'); });
    ports.$('btnImportPipeline').addEventListener('click', function () { ports.closeMenus(); importWholePipeline({ openAsTab: true }); });
    ports.$('btnListMenu').addEventListener('click', function () { ports.toggleMenu('listMenu'); });
    ports.$('btnStarOnly').addEventListener('click', function () {
      ports.S.starOnly = !ports.S.starOnly;
      ports.S.listLimit = 60;
      ports.renderList();
      ports.refreshBadge();
      if (ports.S.mode === 'overview') ports.rebuildOverview();
      else if (ports.S.mode === 'grid') ports.rebuildGrid();
      else ports.rebuildOverlay(true);
    });
    ports.$('btnSeqClose').addEventListener('click', ports.closeSeqViewer);
    ports.$('seqOverlay').addEventListener('click', function (e) {
      if (e.target === ports.$('seqOverlay')) ports.closeSeqViewer();
    });
    ports.$('btnCopyChain').addEventListener('click', function () {
      if (!ports.seqCtx) return;
      const s = ports.seqCtx.seqs[ports.seqCtx.chainIdx];
      const letters = s.residues.map(function (r) { return r.code; }).join('');
      ports.copyText(letters, '已复制 ' + s.length + ' 个残基（链 ' + s.chain + '）');
    });
    ports.$('btnCopyFasta').addEventListener('click', function () {
      if (!ports.seqCtx) return;
      ports.copyText(ports.IO.toFasta(ports.seqCtx.entry.name, ports.seqCtx.seqs), '已复制 FASTA（' + ports.seqCtx.seqs.length + ' 条链）');
    });
    let themeFx = null;
    ports.$('btnTheme').addEventListener('click', function () {
      const dark = !document.body.classList.contains('dark');
      const apply = function () {
        document.body.classList.toggle('dark', dark);
        try { localStorage.setItem(ports.THEME_KEY, dark ? 'dark' : 'light'); } catch (err) { /* ignore */ }
        try {
          const doc = ports.$('pipelineFrame').contentDocument;
          if (doc && doc.body) doc.body.classList.toggle('dark', dark);
        } catch (err) { /* iframe 尚未就绪 */ }
        ports.applyCanvasTheme();
        if (ports.S.mode === 'overview') ports.rebuildOverview();
        pushPipelineData();
      };
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce || themeFx || typeof document.startViewTransition !== 'function') { apply(); return; }
      const rect = this.getBoundingClientRect();
      document.documentElement.style.setProperty('--theme-x', (rect.left + rect.width / 2) + 'px');
      document.documentElement.style.setProperty('--theme-y', (rect.top + rect.height / 2) + 'px');
      themeFx = document.startViewTransition(apply);
      themeFx.finished.finally(function () { themeFx = null; });
    });

    document.addEventListener('click', function (e) {
      for (const pane of ports.panes) {
        const input = ports.paneControlElement(pane, 'overviewSearch');
        const box = input && input.closest('.overview-search');
        const toggle = ports.paneControlElement(pane, 'btnOverviewSearchToggle');
        if (box && !box.contains(e.target) && !(toggle && toggle.contains(e.target))) ports.setPaneSearchOpen(pane, false);
        const root = pane.el || ports.paneStage(ports.panes.indexOf(pane));
        const inside = root && root.contains(e.target) && e.target.closest && e.target.closest('.menu-anchor, .menu');
        if (!inside) ports.closePaneControlMenus(pane);
      }
      if (e.target && e.target.closest && e.target.closest('.menu-anchor, #entryMenu, #stepMenu')) return;
      ports.closeMenus();
    });

    ports.$('selReference').addEventListener('change', function (e) {
      const entry = ports.S.entries.find(function (x) { return x.id === e.target.value; });
      if (entry) ports.setReference(entry);
    });
    const entryList = ports.$('entryList');
    let reorderDrag = null;
    function moveEntryBefore(sourceId, targetId, after) {
      if (sourceId === targetId) return;
      const ordered = ports.sortByMetric(ports.S.entries);
      const source = ordered.find(function (e) { return e.id === sourceId; });
      const remaining = ordered.filter(function (e) { return e.id !== sourceId; });
      const targetIndex = remaining.findIndex(function (e) { return e.id === targetId; });
      if (!source || targetIndex < 0) return;
      remaining.splice(targetIndex + (after ? 1 : 0), 0, source);
      ports.S.entries = remaining; ports.S.manualOrder = true;
      ports.renderList(); ports.applyModeChange(true); ports.refreshBadge();
      ports.status('已调整结构顺序 · 手动排序（选择指标可恢复自动排序）');
    }
    function clearDropHints() {
      entryList.querySelectorAll('.is-drop-before,.is-drop-after').forEach(function (row) { row.classList.remove('is-drop-before', 'is-drop-after'); });
    }
    entryList.addEventListener('pointerdown', function (event) {
      const entryHandle = event.target.closest('.entry-drag-handle');
      const stepHandle = event.target.closest('.step-drag-handle');
      const handle = entryHandle || stepHandle;
      if (!handle || event.button !== 0) return;
      const row = handle.closest('.entry');
      if (!row) return;
      reorderDrag = {
        id: event.pointerId,
        kind: stepHandle ? 'step' : 'entry',
        sourceId: stepHandle ? row.dataset.stepKey : row.dataset.entryId,
        y: event.clientY,
        moved: false,
        targetId: null,
        after: false,
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault(); event.stopPropagation();
    });
    window.addEventListener('pointermove', function (event) {
      if (!reorderDrag || event.pointerId !== reorderDrag.id) return;
      if (!reorderDrag.moved && Math.abs(event.clientY - reorderDrag.y) < 6) return;
      reorderDrag.moved = true; event.preventDefault();
      entryList.classList.add('is-reordering');
      const bounds = entryList.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) entryList.scrollTop -= 14;
      if (event.clientY > bounds.bottom - 32) entryList.scrollTop += 14;
      clearDropHints();
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const row = hit && hit.closest('.entry');
      reorderDrag.targetId = null;
      if (!row || !entryList.contains(row)) return;
      const targetKey = reorderDrag.kind === 'step' ? row.dataset.stepKey : row.dataset.entryId;
      if (!targetKey || targetKey === 'plain' || targetKey === reorderDrag.sourceId) return;
      const rect = row.getBoundingClientRect();
      reorderDrag.targetId = targetKey;
      reorderDrag.after = event.clientY > rect.top + rect.height / 2;
      row.classList.add(reorderDrag.after ? 'is-drop-after' : 'is-drop-before');
    }, { passive: false });
    function endReorder(event, cancelled) {
      if (!reorderDrag || (event.pointerId !== undefined && event.pointerId !== reorderDrag.id)) return;
      const drag = reorderDrag; reorderDrag = null;
      entryList.classList.remove('is-reordering'); clearDropHints();
      if (drag.moved) suppressListClickUntil = performance.now() + 450;
      if (!cancelled && drag.moved && drag.targetId) {
        if (drag.kind === 'step') ports.moveStepBefore(drag.sourceId, drag.targetId, drag.after);
        else moveEntryBefore(drag.sourceId, drag.targetId, drag.after);
      }
    }
    window.addEventListener('pointerup', function (event) { endReorder(event, false); });
    window.addEventListener('pointercancel', function (event) { endReorder(event, true); });
    window.addEventListener('blur', function () { endReorder({}, true); });
    entryList.addEventListener('keydown', function (event) {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      if (event.target.closest('.step-drag-handle')) {
        event.preventDefault();
        const row = event.target.closest('.entry');
        if (row && row.dataset.stepKey) ports.moveStepByDelta(row.dataset.stepKey, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (!event.target.closest('.entry-drag-handle')) return;
      event.preventDefault();
      const rows = Array.from(entryList.querySelectorAll('.entry'));
      const row = event.target.closest('.entry'), index = rows.indexOf(row);
      const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) moveEntryBefore(row.dataset.entryId, target.dataset.entryId, event.key === 'ArrowDown');
    });
    let listDrag = null, suppressListClickUntil = 0;
    entryList.addEventListener('pointerdown', function (event) {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target.closest('button,input,select,textarea,a,[contenteditable]')) return;
      const rect = entryList.getBoundingClientRect();
      if (event.clientX >= rect.left + entryList.clientWidth) return; // 保留原生滚动条操作。
      if (entryList.scrollHeight <= entryList.clientHeight + 1) return;
      listDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, top: entryList.scrollTop, moved: false };
    });
    window.addEventListener('pointermove', function (event) {
      if (!listDrag || event.pointerId !== listDrag.id) return;
      const dy = event.clientY - listDrag.y;
      if (!listDrag.moved) {
        if (Math.abs(dy) < 6 || Math.abs(dy) < Math.abs(event.clientX - listDrag.x)) return;
        listDrag.moved = true;
        entryList.classList.add('is-drag-scrolling');
        entryList.setPointerCapture(event.pointerId);
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      }
      event.preventDefault();
      entryList.scrollTop = listDrag.top - dy;
    }, { passive: false });
    function endListDrag(event) {
      if (!listDrag || (event && event.pointerId !== undefined && event.pointerId !== listDrag.id)) return;
      const drag = listDrag; listDrag = null;
      entryList.classList.remove('is-drag-scrolling');
      if (drag.moved) suppressListClickUntil = performance.now() + 450;
      if (entryList.hasPointerCapture(drag.id)) entryList.releasePointerCapture(drag.id);
    }
    window.addEventListener('pointerup', endListDrag);
    window.addEventListener('pointercancel', endListDrag);
    window.addEventListener('blur', function () { endListDrag(); });
    entryList.addEventListener('lostpointercapture', endListDrag);
    entryList.addEventListener('click', function (event) {
      if (performance.now() >= suppressListClickUntil || event.detail === 0) return;
      suppressListClickUntil = 0;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    entryList.addEventListener('dragstart', function (event) {
      if (listDrag) event.preventDefault();
    });
    entryList.addEventListener('scroll', function (e) {
      const b = e.target;
      if (b.scrollTop + b.clientHeight >= b.scrollHeight - 100 && ports.S.listLimit < ports.S.listedCount) {
        ports.S.listLimit += 60;
        ports.renderList();
      }
    });

    ports.$('btnToggleMetrics').addEventListener('click', function () {
      ports.$('metricsPanel').classList.remove('open');
    });
    ports.$('btnMetrics').addEventListener('click', function () {
      ports.$('metricsPanel').classList.toggle('open');
      ports.closeMenus();
    });
    ports.renderMetricUI();

    ports.$('btnPickFiles').addEventListener('click', function () { ports.pickImport(false); });
    ports.$('fileInput').addEventListener('change', function (e) { ports.importFiles(e.target.files); e.target.value = ''; });

    ports.$('btnPickFolder').addEventListener('click', function () { ports.pickImport(true); });
    ports.$('folderInput').addEventListener('change', function (e) { ports.importFiles(e.target.files); e.target.value = ''; });

    ports.$('btnDemo').addEventListener('click', ports.loadDemo);
    ports.$('btnAddUrl').addEventListener('click', function () { ports.addFromUrl(ports.$('urlInput').value); });
    ports.$('urlInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') ports.addFromUrl(ports.$('urlInput').value);
    });

    // 顶栏的全局「总览/检阅台」开关已移除：模式切换一律走每栏头部的开关（pane-mode）。
    // 下面两个引用在元素不存在时安全跳过，保留只为兼容可能的旧 DOM。
    const topOv = ports.$('btnOverview');
    if (topOv) topOv.addEventListener('click', function () { ports.setMode('overview'); });
    const topBench = ports.$('btnBench');
    if (topBench) topBench.addEventListener('click', function () {
      if (ports.S.mode === 'grid' || ports.S.mode === 'overlay') return;
      ports.openCurrentInGrid();
    });
    // 栏内控件统一委托；顶栏分屏开关保持全窗唯一。
    const splitGlobal = ports.$('btnSplitGlobal');
    if (splitGlobal) splitGlobal.addEventListener('click', function () { ports.closeMenus(); ports.toggleSplit(); });
    // Ctrl+F / Cmd+F：总览可见时聚焦层内搜索框
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'f') return;
      const stage = ports.$('overviewStage');
      const input = ports.$('overviewSearch');
      if (!stage || stage.hidden || !input) return;
      e.preventDefault();
      ports.setPaneSearchOpen(ports.paneAt(), true);
      input.select();
    });

    // 桌面端选择器路径：pickImport 拿到文件后回调这里（函数声明会提升，bind 时即可挂）
    window.__SB_STEP_PICK__ = handleStepPickedFiles;
    async function handleStepPickedFiles(fileList, isFolder) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      let target = ports.pendingStepTarget;
      ports.pendingStepTarget = null;
      let step = null;
      if (target && target.mode === 'new') {
        const fallbackName = isFolder && files[0].webkitRelativePath
          ? files[0].webkitRelativePath.split('/')[0]
          : (files.length === 1 ? files[0].name.replace(/\.(pdb|ent|cif|mmcif|mcif|bcif|zip)(\.gz)?$/i, '') : '');
        const rec = ports.createCustomStep({
          title: (target.title || fallbackName || '新步骤').trim(),
          tool: target.tool || '',
          afterKey: target.afterKey || '',
        });
        step = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === rec.key; }) || rec;
      } else if (target && target.stepKey) {
        step = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true }).find(function (s) { return s.key === target.stepKey; });
      }
      if (!step) return;
      await ports.importFiles(files, step.title, {
        group: false,
        stepKey: step.key,
        stepIndex: Number.isFinite(step.order) ? step.order : (step.displayIndex * 10),
        stepTitle: step.title,
        stepTool: step.tool || '',
        pipelineId: step.pipelineId || ports.activePipelineId(),
      });
      ports.schedulePipelineSync();
      ports.refreshStepsUI(true);
    }
    ports.$('stepFolderInput').addEventListener('change', function (e) { handleStepPickedFiles(e.target.files, true); e.target.value = ''; });
    ports.$('stepFileInput').addEventListener('change', function (e) { handleStepPickedFiles(e.target.files, false); e.target.value = ''; });

    const collectNewStepPending = function () {
      ports.pendingStepTarget = {
        mode: 'new',
        title: ports.$('stepModalName').value.trim(),
        tool: ports.$('stepModalTool').value.trim(),
        afterKey: ports.$('stepModalPos').value || '',
      };
      ports.closeStepModal();
    };
    ports.$('btnStepPickFolder').addEventListener('click', function () { collectNewStepPending(); ports.pickImport(true, '__pending__'); });
    ports.$('btnStepPickFiles').addEventListener('click', function () { collectNewStepPending(); ports.pickImport(false, '__pending__'); });
    ports.$('btnStepCreateEmpty').addEventListener('click', function () {
      const steps = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true });
      const title = ports.$('stepModalName').value.trim() || ('新步骤 ' + (steps.length + 1));
      const tool = ports.$('stepModalTool').value.trim();
      const afterKey = ports.$('stepModalPos').value || '';
      const rec = ports.createCustomStep({ title: title, tool: tool, afterKey: afterKey });
      ports.closeStepModal();
      ports.schedulePipelineSync();
      ports.refreshStepsUI(true);
      ports.toast('已新建空步骤「' + rec.title + '」（可把文件夹直接拖到该步骤上）');
    });
    ports.$('btnStepModalClose').addEventListener('click', ports.closeStepModal);
    ports.$('stepModalCancel').addEventListener('click', ports.closeStepModal);
    ports.$('stepModalMask').addEventListener('click', function (e) { if (e.target === ports.$('stepModalMask')) ports.closeStepModal(); });
    ports.$('stepModal').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!ports.stepModalState || ports.stepModalState.mode !== 'edit' || !ports.stepModalState.stepKey) return;
      const key = ports.stepModalState.stepKey;
      const steps = ports.orderedStepBuckets(ports.S.entries, { includeEmpty: true });
      const cur = steps.find(function (s) { return s.key === key; });
      const title = ports.$('stepModalName').value.trim() || (cur ? cur.title : key);
      const tool = ports.$('stepModalTool').value.trim();
      ports.saveStepEdit(key, { title: title, tool: tool });
      if (ports.S.listNav && ports.S.listNav.stepKey === key) ports.S.listNav.title = title;
      ports.closeStepModal();
      ports.schedulePipelineSync();
      ports.refreshStepsUI(true);
    });

    // 自绘标题栏与 8 向边缘缩放控制（仅桌面端）
    const syncWindowMaximized = function () {
      const inv = window.__SB_DESKTOP_INVOKE__;
      if (!inv) return;
      Promise.resolve(inv('desktop_is_maximized')).then(function (max) {
        document.documentElement.classList.toggle('is-maximized', !!max);
      }).catch(function () { /* 桌面桥不可用时静默 */ });
    };
    const winAction = function (action) {
      const inv = window.__SB_DESKTOP_INVOKE__;
      if (!inv) return;
      Promise.resolve(inv('desktop_window', { action: action })).then(function () {
        if (action === 'maximize') setTimeout(syncWindowMaximized, 40);
      }).catch(function () { /* 桌面桥不可用时静默 */ });
    };
    ports.$('winClose').addEventListener('click', async function () {
      ports.savePipelineViewNow();
      await ports.flushAllStepNotes();
      winAction('close');
    });
    ports.$('winMin').addEventListener('click', function () { winAction('minimize'); });
    ports.$('winMax').addEventListener('click', function () { winAction('maximize'); });
    const resizeEdges = ports.$('winResizeEdges');
    if (resizeEdges) {
      const RESIZE_DIR = {
        n: 'North', s: 'South', e: 'East', w: 'West',
        nw: 'NorthWest', ne: 'NorthEast', sw: 'SouthWest', se: 'SouthEast',
      };
      resizeEdges.addEventListener('mousedown', function (e) {
        if (e.button !== 0 || !window.__SB_DESKTOP_INVOKE__) return;
        const edge = e.target.closest('.win-edge');
        const dir = edge && RESIZE_DIR[edge.dataset.dir];
        if (!dir) return;
        e.preventDefault();
        const api = window.__TAURI__ || (window.parent && window.parent.__TAURI__);
        if (api && api.window && api.window.getCurrentWindow) {
          Promise.resolve(api.window.getCurrentWindow().startResizeDragging(dir)).catch(function () { });
        } else {
          Promise.resolve(window.__SB_DESKTOP_INVOKE__('plugin:window|start_resize_dragging', { value: dir })).catch(function () { });
        }
      });
    }
    syncWindowMaximized();
    // 彻底禁止顶层视口滚动，杜绝因滚轮或子项聚焦导致标题栏被顶出屏幕
    window.addEventListener('scroll', function () {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    });
    // 拖拽保底：WebView2 的 app-region + Tauri start_dragging 双通道
    // 标题栏几乎被控件占满时，品牌区 / 左右空白仍应可拖；控件命中则跳过
    const titlebarEl = document.querySelector('.titlebar');
    const isTitlebarChrome = function (target) {
      return !!(target && target.closest && target.closest(
        'button, input, select, label, a, .menu, .menu-anchor, .mode-switch, .win-lights, .win-light, .win-edge'
      ));
    };
    const startWindowDrag = function () {
      const api = window.__TAURI__ || (window.parent && window.parent.__TAURI__);
      if (api && api.window && api.window.getCurrentWindow) {
        return Promise.resolve(api.window.getCurrentWindow().startDragging());
      }
      if (window.__SB_DESKTOP_INVOKE__) {
        return Promise.resolve(window.__SB_DESKTOP_INVOKE__('desktop_start_drag'));
      }
      return Promise.resolve();
    };
    if (titlebarEl) {
      titlebarEl.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (isTitlebarChrome(e.target)) return;
        startWindowDrag().catch(function () { /* 桌面桥不可用时静默 */ });
      });
      titlebarEl.addEventListener('dblclick', function (e) {
        if (isTitlebarChrome(e.target)) return;
        winAction('maximize');
      });
    }
    let groupedSaved = true;
    try { groupedSaved = localStorage.getItem(ports.GROUPED_KEY) !== '0'; } catch (_) {}
    ports.setOverviewGrouped(groupedSaved, false);
    try {
      const saved = (localStorage.getItem(ports.GRID_SHAPE_KEY) || '').match(/^(\d+)x(\d+)$/);
      if (saved) {
        ports.S.cols = ports.clampGridCount(saved[1], ports.GRID_COL_MAX, ports.S.cols);
        ports.S.rows = ports.clampGridCount(saved[2], ports.GRID_ROW_MAX, ports.S.rows);
      }
    } catch (_) {}
    ports.paintGridRecommendation();
    ports.syncModeTabs();
    ports.applyModeChange(false);
    let recFrame = 0;
    window.addEventListener('resize', function () {
      if (recFrame) return;
      recFrame = requestAnimationFrame(function () { recFrame = 0; ports.panes.forEach(ports.paintGridRecommendation); });
    });

    ports.syncPaneControls(ports.paneAt());
    const pageZoom = window.devicePixelRatio || 1;
    let pageZoomFrame = 0;
    window.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (!window.__SB_DESKTOP_INVOKE__ || pageZoomFrame) return;
      pageZoomFrame = requestAnimationFrame(function () {
        pageZoomFrame = 0;
        if (Math.abs((window.devicePixelRatio || 1) - pageZoom) < 0.02) return;
        window.__SB_DESKTOP_INVOKE__('desktop_reset_zoom').catch(function () {});
      });
    }, { capture: true, passive: false });
    ports.$('btnAll').addEventListener('click', function () { ports.setAllVisible(true); });
    ports.$('btnNone').addEventListener('click', function () { ports.setAllVisible(false); });
    ports.$('btnInvert').addEventListener('click', function () {
      ports.S.entries.forEach(function (e) { e.visible = !e.visible; });
      ports.renderList(); ports.applyModeChange(true); ports.refreshBadge();
    });
    ports.$('btnClear').addEventListener('click', async function () {
      if (!ports.S.entries.length) return;
      const closingTab = ports.currentWorkspaceTabId();
      ports.S.workspaceEpoch = (ports.S.workspaceEpoch || 0) + 1;
      if (ports.loadProgressRun) {
        ports.loadProgressRun.cancelled = true;
        if (ports.loadProgressRun.controller) ports.loadProgressRun.controller.abort();
      }
      clearTimeout(ports.marksSyncTimer); ports.marksSyncTimer = 0;
      ports.S.entries = []; ports.S.groups = []; ports.S.groupSeq = 0;
      ports.S.customSteps = []; ports.saveCustomSteps(); ports.S.activePipelineId = ''; ports.S.activePipelineName = ''; ports.S.localWorkspaceId = '';
      ports.S.organization = {}; ports.S.trashFolders = []; ports.S.trashSteps = [];
      if (ports.ORG) ports.ORG.clearHistory();
      ports.S.metrics.table = null; ports.S.metrics.primary = ''; ports.S.metrics.filters = [];
      ports.S.metrics.range = null; ports.S.metrics.matched = 0; ports.S.metrics.fileName = '';
      for (const pane of ports.panes.filter(ports.PANE_RUNTIME.alive)) {
        Object.assign(pane.view, { referenceId: null, aligned: false, page: 0, soloId: null,
          listLimit: 60, listNav: null, activeGroupId: 'all', overlayRefs: [] });
        if (pane.view.theme === 'by-metric') pane.view.theme = 'per-structure';
      }
      const saved = ports.clearSavedSession();
      if (closingTab) ports.pipelineTabs.remove(closingTab);
      ports.renderPipelineTabs(); ports.updatePipelineIdentity('');
      const clearing = ports.resetSharedPaneViews();
      ports.renderMetricUI(); ports.renderGroups(); ports.refreshReferenceSelect(); ports.renderList();
      ports.applyAllPaneModes(false);
      await Promise.all([saved, clearing]);
      ports.applyAllPaneModes(false);
      ports.status('已清空');
    });

    ports.$('searchInput').addEventListener('input', function (e) {
      ports.S.filter = e.target.value.trim().toLowerCase();
      ports.schedulePipelineViewSave();
      ports.S.listLimit = 60;
      ports.renderList();
      ports.applyModeChange(true);
    });

    // 拖放
    let dragLayer = null, dropTargetElement = null;
    const clearExternalDropHint = function () {
      if (dragLayer) { dragLayer.remove(); dragLayer = null; }
      if (dropTargetElement) { dropTargetElement.classList.remove('is-external-drop-target'); dropTargetElement = null; }
      document.querySelectorAll('.is-step-dragover').forEach(function (el) { el.classList.remove('is-step-dragover'); });
    };
    document.addEventListener('dragover', function (e) {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
      if (!types.includes('Files') || types.includes('application/x-structboard-org') || types.includes('application/x-structboard-pipeline-tab')) return;
      e.preventDefault();
      const target = ports.externalDropTarget(e.target);
      if (dropTargetElement) dropTargetElement.classList.remove('is-external-drop-target');
      dropTargetElement = target && target.element;
      if (dropTargetElement) dropTargetElement.classList.add('is-external-drop-target');
      if (!dragLayer) {
        dragLayer = ports.el('div', 'external-drop-hint');
        dragLayer.setAttribute('role', 'status');
        document.body.appendChild(dragLayer);
      }
      dragLayer.textContent = '松开后' + (target ? target.label : ports.hasWorkspaceContent(ports.rawS) ? '在新标签打开' : '在当前空白页打开');
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', function (e) {
      if (!dragLayer) return;
      const r = e.relatedTarget;
      if (r === null && (e.clientX <= 0 || e.clientY <= 0 ||
          e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
        clearExternalDropHint();
      }
    });
    document.addEventListener('drop', function (e) {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
      if (!types.includes('Files') || types.includes('application/x-structboard-org') || types.includes('application/x-structboard-pipeline-tab')) return;
      e.preventDefault();
      e.stopPropagation();          // 捕获阶段拦截，别让 Mol* 的 onDrop 重复读同一批文件
      const target = ports.externalDropTarget(e.target);
      clearExternalDropHint();
      if (e.dataTransfer) ports.importExternalDrop(e.dataTransfer, target).catch(function (error) { ports.toast('拖入失败：' + error.message, true); });
    }, true);
    document.addEventListener('dragend', clearExternalDropHint);
    window.addEventListener('blur', clearExternalDropHint);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ports.$('stepModalMask') && !ports.$('stepModalMask').hidden) {
        e.preventDefault(); e.stopPropagation(); ports.closeStepModal(); return;
      }
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) ports.redoOrg(); else ports.undoOrg();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault(); ports.redoOrg(); return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && ports.S.mode === 'overview') {
        e.preventDefault(); ports.orgRemoveSelection(); return;
      }
      if (e.key === '1') ports.setMode('overview');
      if (e.key === '2' && ports.S.mode === 'overview') ports.openCurrentInGrid();
      if (e.key === '3' && (ports.S.mode === 'grid' || ports.S.mode === 'overlay')) ports.setMode(ports.S.mode === 'grid' ? 'overlay' : 'grid');
      if (e.key.toLowerCase() === 'r' && ports.S.overlayViewer) ports.resetCamera(ports.S.overlayViewer);
    });

    window.addEventListener('resize', function () {
      syncWindowMaximized();
      ports.syncModeThumb();
      if (ports.S.overlayViewer) ports.S.overlayViewer.handleResize();
      ports.resizeGridViewers();
      if (ports.S.mode === 'overview') ports.renderOverviewWindow();
    });
    if (window.ResizeObserver) {
      // Label/font changes and sidebar transitions can reflow tools without a window resize.
      const toolbarResizeObserver = new ResizeObserver(ports.resizeGridViewers);
      toolbarResizeObserver.observe(ports.$('toolbar'), { box: 'border-box' });
      toolbarResizeObserver.observe(ports.$('stage'));
    }
  }
// SERVICE_FUNCTIONS_END
  return { bind };
}
