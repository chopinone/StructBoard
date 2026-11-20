/* StructBoard: bounded, virtualized thumbnail overview. No per-card WebGL contexts.
   显示节点（node）：{kind:'entry', entry, pos, total}、{kind:'folder', ...}，
   或 {kind:'localfile', id, name, path, remain}（超过 100 个时，多出来的文件收成一张同样的卡片，排在这一格的最前）。
   文件夹卡片不再拍封面，袋里是便签；结构封面一次生成后从缓存当相册滑。 */
(function (global) {
  'use strict';
  let shellSeq = 0;

  /* One viewer and one creation promise per window. Each overview retains an owner
     token; Priority leases (FIFO within a priority) cover every renderer mutation, including asynchronous encoding.
     Cancellation can stop only that owner's lease, which stays held until it settles. */
  const sharedRenderer = (function () {
    const owners = new Set();
    let viewer = null, creating = null, host = null, ownsHost = false, current = null;
    const waiting = [], blobs = new Map();
    let blobBytes = 0, interactionUntil = 0, interactionTimer = 0, wakeTimer = 0;
    function interactionDelay() { return Math.max(0, interactionUntil - performance.now()); }
    function recall(key) {
      const blob = blobs.get(key);
      if (blob) { blobs.delete(key); blobs.set(key, blob); }
      return blob || null;
    }
    function remember(key, blob) {
      if (!key || !blob || blob.size > 16 * 1024 * 1024) return;
      const previous = blobs.get(key);
      if (previous) blobBytes -= previous.size;
      blobs.delete(key); blobs.set(key, blob); blobBytes += blob.size;
      while (blobs.size > 256 || blobBytes > 16 * 1024 * 1024) {
        const first = blobs.keys().next().value;
        blobBytes -= blobs.get(first).size; blobs.delete(first);
      }
    }
    function interact() {
      if (current) { current.cancelled = true; stop(current); }
      interactionUntil = performance.now() + 180;
      document.body.classList.add('sb-overview-interacting');
      if (interactionTimer) clearTimeout(interactionTimer);
      interactionTimer = setTimeout(function settle() {
        const delay = interactionDelay();
        if (delay > 0) { interactionTimer = setTimeout(settle, delay); return; }
        interactionTimer = 0; document.body.classList.remove('sb-overview-interacting');
        void drain();
      }, 180);
    }
    function stop(lease) {
      if (!lease || !lease.drawing) return;
      lease.drawing = false;
      try { viewer.plugin.animationLoop.stop({ noDraw: true }); } catch (_) {}
    }
    function disposeIfUnused() {
      if (owners.size || current || creating || waiting.length) return;
      if (interactionTimer) clearTimeout(interactionTimer), interactionTimer = 0;
      if (wakeTimer) clearTimeout(wakeTimer), wakeTimer = 0;
      interactionUntil = 0; blobs.clear(); blobBytes = 0;
      document.body.classList.remove('sb-overview-interacting');
      const old = viewer; viewer = null;
      if (old) { try { old.dispose(); } catch (_) {} }
      if (ownsHost && host) host.remove();
      host = null; ownsHost = false;
    }
    function ensureViewer(createViewer) {
      if (viewer) return Promise.resolve(viewer);
      if (!creating) {
        if (!host) {
          host = document.getElementById('thumbnailHost');
          ownsHost = !host;
          if (!host) {
            host = document.createElement('div'); host.id = 'thumbnailHost';
            host.className = 'thumbnail-render-host'; host.setAttribute('aria-hidden', 'true');
            document.body.appendChild(host);
          }
        }
        creating = Promise.resolve().then(function () { return createViewer(host); }).then(function (v) {
          viewer = v; return v;
        }).finally(function () { creating = null; disposeIfUnused(); });
      }
      return creating;
    }
    async function drain() {
      if (current) return;
      if (waiting.length && interactionDelay() > 0) {
        if (!wakeTimer) wakeTimer = setTimeout(function () { wakeTimer = 0; void drain(); }, interactionDelay());
        return;
      }
      waiting.sort(function (a, b) { return a.priority - b.priority; });
      const lease = waiting.shift();
      if (!lease) { disposeIfUnused(); return; }
      current = lease;
      const valid = function () { return !lease.cancelled && owners.has(lease.owner) && lease.valid(); };
      try {
        let result = null;
        if (valid()) {
          result = recall(lease.key);
          if (!result) {
            const v = await ensureViewer(lease.createViewer);
            if (valid()) {
              v.handleResize();
              lease.drawing = true;
              v.plugin.animationLoop.start();
              result = await lease.work(v, valid);
              if (result && valid()) remember(lease.key, result);
            }
          }
        }
        lease.resolve(result);
      } catch (error) { lease.reject(error); }
      finally {
        stop(lease); current = null;
        void drain();
      }
    }
    function cancel(owner) {
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i].owner === owner) waiting.splice(i, 1)[0].resolve(null);
      }
      if (current && current.owner === owner) { current.cancelled = true; stop(current); }
      disposeIfUnused();
    }
    return {
      retain: function (owner) { owners.add(owner); },
      release: function (owner) { owners.delete(owner); cancel(owner); },
      cancel: cancel,
      stop: function (owner) { if (current && current.owner === owner) stop(current); },
      interact: interact, interactionDelay: interactionDelay, recall: recall, remember: remember,
      viewerFor: function (owner) { return owners.has(owner) ? viewer : null; },
      run: function (owner, createViewer, valid, work, key, priority) {
        owners.add(owner);
        return new Promise(function (resolve, reject) {
          waiting.push({ owner: owner, createViewer: createViewer, valid: valid, work: work, key: key,
            resolve: resolve, reject: reject, cancelled: false, drawing: false, priority: priority || 0 });
          void drain();
        });
      }
    };
  })();

  function makeFolderShell() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'folder-shell');
    svg.setAttribute('aria-hidden', 'true');
    const id = 'fs' + (++shellSeq);
    svg.dataset.sid = id;
    svg.innerHTML = '<defs><linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="70" gradientUnits="userSpaceOnUse"><stop offset="0%"/><stop offset="100%"/></linearGradient><clipPath id="' + id + 'c"><path class="fs-clip"/></clipPath></defs><g clip-path="url(#' + id + 'c)"><rect class="fs-pocket" x="0" y="0" width="100%" height="100%"/><rect class="fs-header" x="0" y="0" width="100%"/><path class="fs-shine" fill="none" stroke-width="1.2"/><line class="fs-line" stroke-width="1"/></g><path class="fs-edge" fill="none" stroke-width="1.2"/>';
    return svg;
  }
  function fitFolderShell(box, shell) {
    if (!box || !shell) return;
    const w = Math.max(80, parseFloat(box.style.width) || box.clientWidth || 220);
    const h = Math.max(80, parseFloat(box.style.height) || box.clientHeight || 240);
    shell.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const tab = Math.max(84, Math.min(118, w * 0.4));
    const ear = tab + 26;
    const yEar = 13;
    const r = 16;
    const d = 'M 1 ' + (yEar + 3) + ' Q 1 1 ' + r + ' 1 L ' + tab + ' 1 C ' + (tab + 12) + ' 1 ' + (tab + 16) + ' ' + yEar + ' ' + ear + ' ' + yEar
      + ' L ' + (w - r) + ' ' + yEar + ' Q ' + (w - 1) + ' ' + yEar + ' ' + (w - 1) + ' ' + (yEar + r)
      + ' L ' + (w - 1) + ' ' + (h - r) + ' Q ' + (w - 1) + ' ' + (h - 1) + ' ' + (w - r) + ' ' + (h - 1)
      + ' L ' + r + ' ' + (h - 1) + ' Q 1 ' + (h - 1) + ' 1 ' + (h - r) + ' Z';
    const shine = 'M 1 ' + (yEar + 3) + ' Q 1 2 ' + r + ' 2 L ' + tab + ' 2 C ' + (tab + 12) + ' 2 ' + (tab + 16) + ' ' + (yEar + 1) + ' ' + ear + ' ' + (yEar + 1)
      + ' L ' + (w - r) + ' ' + (yEar + 1) + ' Q ' + (w - 2) + ' ' + (yEar + 1) + ' ' + (w - 2) + ' ' + (yEar + r);
    shell.querySelector('.fs-clip').setAttribute('d', d);
    shell.querySelector('.fs-edge').setAttribute('d', d);
    box.style.clipPath = 'path("' + d + '")';
    shell.querySelector('.fs-shine').setAttribute('d', shine);
    const band = Math.max(72, Math.round(h * 0.3));
    const header = shell.querySelector('.fs-header');
    header.setAttribute('height', String(band));
    const grad = shell.querySelector('linearGradient');
    grad.setAttribute('y2', String(band));
    const line = shell.querySelector('.fs-line');
    line.setAttribute('x1', '0'); line.setAttribute('x2', String(w));
    line.setAttribute('y1', String(band)); line.setAttribute('y2', String(band));
    box.style.setProperty('--folder-band', band + 'px');
    const starred = box.classList.contains('is-starred');
    const dark = document.body.classList.contains('dark');
    // 袋身、描边、预览井一律用未星标的奶油色。金色只涂页签到标题这一条。
    const body = dark
      ? { pocket: '#2C2924', line: '#5A5146', edge: '#6A5E50', shine: 'rgba(255,255,255,.18)' }
      : { pocket: '#F8F5EC', line: '#DED5C2', edge: '#E2DAC9', shine: 'rgba(255,255,255,.75)' };
    const head = starred
      ? (dark ? { top: '#C6A15A', bot: '#A8843A' } : { top: '#FDE292', bot: '#F9CD5E' })
      : (dark ? { top: '#4A4338', bot: '#3E382F' } : { top: '#F2ECDE', bot: '#EAE2CF' });
    const theme = {
      top: head.top, bot: head.bot,
      pocket: body.pocket, line: body.line, edge: body.edge, shine: body.shine
    };
    const stops = shell.querySelectorAll('stop');
    stops[0].setAttribute('stop-color', theme.top);
    stops[1].setAttribute('stop-color', theme.bot);
    header.setAttribute('fill', 'url(#' + shell.dataset.sid + 'g)');
    shell.querySelector('.fs-pocket').setAttribute('fill', theme.pocket);
    line.setAttribute('stroke', theme.line);
    shell.querySelector('.fs-edge').setAttribute('stroke', theme.edge);
    shell.querySelector('.fs-shine').setAttribute('stroke', theme.shine);
  }
  global.SB_FOLDER_SHELL = { make: makeFolderShell, fit: fitFolderShell };

  function thumbnailHasContent(canvas) {
    if (!canvas || !(canvas.width > 0 && canvas.height > 0)) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('无法检查缩略图内容');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 四角估计纯背景；至少少量像素确实画出结构，才算有效截图。
    const corners = [0, (canvas.width - 1) * 4,
      (canvas.width * (canvas.height - 1)) * 4, (canvas.width * canvas.height - 1) * 4];
    const bg = [0, 0, 0];
    corners.forEach(function (index) {
      for (let channel = 0; channel < 3; channel++) bg[channel] += pixels[index + channel] / 4;
    });
    let changed = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 16) continue;
      if (Math.max(Math.abs(pixels[i] - bg[0]), Math.abs(pixels[i + 1] - bg[1]),
        Math.abs(pixels[i + 2] - bg[2])) > 20 && ++changed >= 8) return true;
    }
    return false;
  }

  global.SB_OVERVIEW = {
    hasThumbnailContent: thumbnailHasContent,
    create: function (hooks) {
      // 多实例：分屏时每栏各建一份总览。root 缺省回落到 document，单栏行为与旧版一致；
      // 传入栏元素后所有查找都限定在该栏内，两栏互不串台。
      const root = (hooks && hooks.root) || document;
      const scoped = root && typeof root.querySelector === 'function' && root !== document;
      // 第二栏的 id 带前缀（p2-）。overview.js 内部会新建元素并写回 id，
      // 这些写回也必须带前缀，否则两栏会抢同一个 id（document.getElementById 只能命中一个）。
      const prefix = scoped ? (hooks.panePrefix || 'p2-') : '';
      const $ = id => {
        if (!scoped) return document.getElementById(id);
        // 栏内元素带 p2- 之类的 id 前缀（由 app.js 克隆时加），这里按「后缀匹配」找。
        // 不回落到 document.getElementById：跨实例回落会把别的栏（或已销毁栏）的
        // 元素抓进来，出现「关掉分屏后 p2- 前缀泄漏进单屏」这类串台。
        // 找不到就返回 null：调用方（setDrillUI 等）都按可空处理，绝不隐式造节点——
        // 隐式造节点正是把 p2- 前缀带进单屏 DOM 的来源。
        return root.querySelector('[id$="-' + id + '"]') || root.querySelector('#' + id) || null;
      };
      const scroll = $('overviewScroll'), spacer = $('overviewSpacer'), layer = $('overviewCards');
      const cache = new Map(), failures = new Map(), cards = new Map();
      const entryCardPool = [];
      const MAX_ITEMS = 4000, MAX_BYTES = 64 * 1024 * 1024, W = 320, H = 240;
      const DECODED_LIMIT = 128 * 1024 * 1024, DECODED_COST = W * H * 4;
      const DISK_ITEMS = 4000, DISK_BYTES = 128 * 1024 * 1024;
      const SMALL_STEP_LIMIT = 24;
      let list = [], epoch = 0, active = false, paused = false, lite = false, busy = false;
      let owner = {}, ownerRetained = true, destroyed = false;
      sharedRenderer.retain(owner);
      let queue = [], frame = 0, bytes = 0, decodedBytes = 0, visibleFillTimer = 0;
      const completed = new Set(), renderConfigs = new Map();
      const boundEvents = [], observers = [], trackedTimers = new Set(), rafIds = new Set(), frameWaiters = new Set();
      let gestureCleanup = null, dbClosed = false;
      const bind = function (target, name, handler, options) {
        if (!target || !target.addEventListener) return handler;
        target.addEventListener(name, handler, options); boundEvents.push({ target, name, handler, options });
        return handler;
      };
      const unbind = function (target, name, handler, options) {
        if (target && target.removeEventListener) target.removeEventListener(name, handler, options);
        for (let i = boundEvents.length - 1; i >= 0; i--) {
          const item = boundEvents[i];
          if (item.target === target && item.name === name && item.handler === handler) boundEvents.splice(i, 1);
        }
      };
      const later = function (fn, delay) {
        let id = 0;
        id = setTimeout(function () {
          trackedTimers.delete(id);
          if (!destroyed) fn();
        }, delay || 0);
        trackedTimers.add(id); return id;
      };
      const cancelLater = function (id) {
        if (!id) return; clearTimeout(id); trackedTimers.delete(id);
      };
      const raf = function (fn) {
        let id = 0;
        id = requestAnimationFrame(function (time) {
          rafIds.delete(id);
          if (!destroyed) fn(time);
        });
        rafIds.add(id); return id;
      };
      const cancelRaf = function (id) {
        if (!id) return; cancelAnimationFrame(id); rafIds.delete(id);
      };
      const nextFrame = function () {
        if (destroyed) return Promise.resolve();
        return new Promise(function (resolve) {
          const wait = { id: 0, resolve: resolve };
          wait.id = requestAnimationFrame(function (time) {
            rafIds.delete(wait.id); frameWaiters.delete(wait); if (!destroyed) resolve(time); else resolve();
          });
          rafIds.add(wait.id); frameWaiters.add(wait);
        });
      };
      function cancelScheduled() {
        for (const id of trackedTimers) clearTimeout(id); trackedTimers.clear();
        for (const id of rafIds) cancelAnimationFrame(id); rafIds.clear();
        for (const wait of frameWaiters) { frameWaiters.delete(wait); wait.resolve(); }
        if (gestureCleanup) { gestureCleanup(); gestureCleanup = null; }
        if (auditTimer) {
          if (window.requestIdleCallback && window.cancelIdleCallback) window.cancelIdleCallback(auditTimer);
          else clearTimeout(auditTimer);
        }
        frame = visibleFillTimer = pumpTimer = auditTimer = mmFrame = mmAnim = moveRAF = scrollRAF = 0;
      }
      const disconnectResources = function () {
        while (boundEvents.length) {
          const item = boundEvents.pop();
          if (item.target && item.target.removeEventListener) item.target.removeEventListener(item.name, item.handler, item.options);
        }
        while (observers.length) { try { observers.pop().disconnect(); } catch (_) {} }
        cancelScheduled();
      };
      let runningKey = '', pumpTimer = 0, renderConfigEpoch = -1, viewRevision = 0;
      function configFor(node) {
        const id = idOf(node);
        if (renderConfigEpoch !== epoch) { renderConfigs.clear(); renderConfigEpoch = epoch; }
        if (renderConfigs.has(id)) return renderConfigs.get(id);
        const entry = entryOf(node);
        let config;
        try {
          const capture = hooks.captureRenderConfig || hooks.context;
          config = capture ? capture(entry, node) : undefined;
        } catch (_) { config = undefined; }
        renderConfigs.set(id, config);
        return config;
      }
      function ensureOwner() {
        if (!destroyed && !ownerRetained) { sharedRenderer.retain(owner); ownerRetained = true; }
      }
      function newEpoch() {
        epoch++; viewRevision++; renderConfigs.clear(); completed.clear(); queue = [];
        if (visibleFillTimer) { cancelLater(visibleFillTimer); visibleFillTimer = 0; }
        invalidateLayout();
        sharedRenderer.cancel(owner); stopDrawing(); cancelThumbIO();
        if (auditTimer) {
          if (window.requestIdleCallback && window.cancelIdleCallback) window.cancelIdleCallback(auditTimer);
          else cancelLater(auditTimer);
          auditTimer = 0;
        }
        if (pumpTimer) { cancelLater(pumpTimer); pumpTimer = 0; }
      }
      function canRun() { return !destroyed && active && !paused && !lite && !document.hidden; }
      function schedulePump() {
        if (pumpTimer || busy || !canRun() || !queue.length) return;
        pumpTimer = later(function () { pumpTimer = 0; void pump(); }, Math.max(30, sharedRenderer.interactionDelay()));
      }
      function scheduleVisibleFill(layout) {
        if (visibleFillTimer || destroyed || !active || document.hidden || !activeLayout) return;
        const token = epoch, capturedLayout = layout || activeLayout;
        visibleFillTimer = later(function () {
          visibleFillTimer = 0;
          if (!ioValid(token) || !active || activeLayout !== capturedLayout) return;
          if (sharedRenderer.interactionDelay() > 0) { scheduleVisibleFill(capturedLayout); return; }
          const top = scroll.scrollTop, bottom = top + scroll.clientHeight;
          const visible = visibleItems(capturedLayout, top, bottom), groups = new Set();
          const demand = new Map();
          for (const item of visible) {
            if (item.grid) groups.add(item.grid);
            if (item.coverGrid) groups.add(item.coverGrid);
            if (wantsCover(item.node)) demand.set(item.index, { item: item, visible: true });
          }
          // Only small steps intersecting this viewport may finish offscreen.
          for (const grid of groups) if (grid.coverCount <= SMALL_STEP_LIMIT) {
            for (const item of grid.coverItems) if (!demand.has(item.index)) {
              demand.set(item.index, { item: item, visible: false });
            }
          }
          const priority = [], keys = new Set();
          for (const value of demand.values()) {
            const item = value.item, node = item.node;
            const card = cards.get(idOf(node));
            if (card) void recallThumb(card);
            if (!canRun()) continue;
            const config = configFor(node), key = keyFor(node, config);
            if (!key || key === runningKey || cache.has(key) || completed.has(key) || failures.has(key) || keys.has(key)) continue;
            keys.add(key);
            priority.push({ node, config, key, index: item.index, epoch: token, viewRevision,
              visible: value.visible, size: item.grid ? item.grid.coverCount : 1 });
          }
          priority.sort(function (a, b) {
            return Number(b.visible) - Number(a.visible) || a.size - b.size || a.index - b.index;
          });
          queue = priority;
          stats.demandItems = demand.size;
          updateStatus(capturedLayout.nodes);
          schedulePump();
        }, sharedRenderer.interactionDelay());
      }
      let cols = 1, cardWidth = 220, rowHeight = 230, rendered = 0, totalMs = 0;
      // 层内搜索词，仅用于显示过滤；不参与任何持久化，也不改成员关系。
      let searchQuery = '';
      function queryText() { return searchQuery.trim().toLowerCase(); }
      function setSearch(text) {
        if (destroyed) return false;
        const next = String(text == null ? '' : text);
        if (next === searchQuery) return false;
        searchQuery = next;
        newEpoch(); renderWindow();
        buildMinimapTicks();
        if (hooks.onViewChange) hooks.onViewChange('search');
        return true;
      }
      function searchStats() {
        const shown = filteredNodes(drill ? window.SB_LINEAGE.children(drill) : list);
        const total = (drill ? window.SB_LINEAGE.children(drill) : list).filter(function (n) { return n.kind !== 'section'; }).length;
        const visible = shown.filter(function (n) { return n.kind !== 'section'; }).length;
        return { query: searchQuery, visible: visible, total: total };
      }
      // 位置符合审计：结果按文件夹缓存，逐个空闲档计算，避免一次卡住滚动。
      const auditResults = new Map(), pendingAudit = new Map();
      let auditTimer = 0;
      function scheduleAudit() {
        if (destroyed || auditTimer || !pendingAudit.size || !hooks.folderAudit || !active) return;
        const token = epoch;
        const run = function () {
          auditTimer = 0;
          if (!ioValid(token) || !active || !pendingAudit.size) return;
          if (sharedRenderer.interactionDelay() > 0) { auditTimer = later(run, sharedRenderer.interactionDelay()); return; }
          const first = pendingAudit.entries().next();
          if (first.done) return;
          const akey = first.value[0], job = first.value[1];
          pendingAudit.delete(akey);
          if (!cards.has(job.id)) { scheduleAudit(); return; }
          let result = null;
          try { result = hooks.folderAudit(job.node); }
          catch (error) { console.warn('[StructBoard] placement audit', error); }
          if (result) auditResults.set(akey, result);
          const card = cards.get(job.id);
          if (card && card.node && card.node.kind === 'folder') paintCard(card, card.node);
          if (pendingAudit.size) scheduleAudit();
        };
        auditTimer = window.requestIdleCallback
          ? window.requestIdleCallback(run, { timeout: 600 })
          : later(run, 24);
      }
      let drill = null, drillScroll = 0, drillStack = [], baseTitle = '结构总览';
      let drillGuardUntil = 0;
      const selected = new Set();
      let lastSelectedId = '';
      const lineage = global.SB_LINEAGE;
      function folderText(node) { return node.countText || node.count + ' 个模型'; }
      const stats = { cacheLimit: MAX_ITEMS, byteLimit: MAX_BYTES, decodedByteLimit: DECODED_LIMIT,
        bitmapWidth: W, bitmapHeight: H, cacheItems: 0, cacheBytes: 0, encodedCacheBytes: 0,
        decodedCacheBytes: 0, mountedCards: 0, viewerCount: 0, generated: 0,
        discarded: 0, evictions: 0, errors: 0, active: false, paused: false, busy: false, queueLength: 0,
        totalEntries: 0, totalFolders: 0, meanGenerateMs: 0,
        layoutBuilds: 0, itemsVisited: 0, windowRenders: 0, cardsPainted: 0, sharedHits: 0 };
      function viewNodes() {
        if (!drill) return filteredNodes(list);
        return filteredNodes(window.SB_LINEAGE.children(drill));
      }
      // 层内搜索：只看当前这一层的节点，命中名字或所在目录。
      // 纯函数，不进科学数据、不改变 organization，只在显示层过滤。
      function nodeMatches(node, query) {
        if (!query) return true;
        const q = String(query).toLowerCase();
        const text = [];
        if (node.kind === 'entry') {
          const e = node.entry || {};
          text.push(e.name, e.path, e.fullPath, e.stepTitle, e.stepTool);
          if (e.metrics) for (const key of Object.keys(e.metrics)) text.push(String(e.metrics[key]));
        } else if (node.kind === 'localfile') {
          text.push(node.name, node.path, node.fullPath);
        } else {
          text.push(node.name, node.title, node.tool);
          if (node.entries) for (const e of node.entries) text.push(e && e.name, e && (e.fullPath || e.path));
        }
        return text.some(function (value) {
          return value && String(value).toLowerCase().indexOf(q) >= 0;
        });
      }
      function filteredNodes(nodes) {
        const query = queryText();
        if (!query) return nodes;
        // 总览节点按「步骤标题 + 该步骤卡片」分段。搜步骤名时保留整段；
        // 搜模型名/路径/指标时只保留命中的卡片，并隐藏没有命中的步骤标题。
        if (!nodes.some(function (node) { return node.kind === 'section'; })) {
          return nodes.filter(function (node) { return nodeMatches(node, query); });
        }
        const out = [];
        for (let i = 0; i < nodes.length; ) {
          const section = nodes[i];
          if (section.kind !== 'section') {
            if (nodeMatches(section, query)) out.push(section);
            i++;
            continue;
          }
          const cards = [];
          let j = i + 1;
          while (j < nodes.length && nodes[j].kind !== 'section') cards.push(nodes[j++]);
          if (nodeMatches(section, query)) out.push(section, ...cards);
          else {
            const matches = cards.filter(function (card) { return nodeMatches(card, query); });
            if (matches.length) out.push(section, ...matches);
          }
          i = j;
        }
        return out;
      }
      function coverage(nodes) {
        let n = 0, folders = 0;
        for (const node of nodes) {
          if (node.kind === 'section') continue;
          if (node.kind === 'folder') { n += node.count; folders++; }
          else if (node.kind === 'localfile') n += node.remain;
          else n++;
        }
        return { covered: n, folders: folders };
      }
      function syncStats(nodes, viewport) {
        const c = activeLayout && activeLayout.nodes === nodes ? activeLayout.coverage : coverage(nodes);
        let visibleTotal = 0, visibleReady = 0;
        const top = viewport ? viewport.top : scroll.scrollTop;
        const bottom = top + (viewport ? viewport.height : scroll.clientHeight);
        for (const card of cards.values()) {
          if (!wantsCover(card.node)) continue;
          const y = Number.parseFloat(card.box.style.top) || 0, h = Number.parseFloat(card.box.style.height) || 0;
          if (y + h < top || y > bottom) continue;
          visibleTotal++;
          if (card.key && cache.has(card.key)) visibleReady++;
        }
        Object.assign(stats, { cacheItems: cache.size, cacheBytes: bytes, encodedCacheBytes: bytes,
          decodedCacheBytes: cache.size * DECODED_COST, decodedBytesEstimated: true,
          completedKeys: completed.size, mountedCards: cards.size,
          viewerCount: sharedRenderer.viewerFor(owner) ? 1 : 0, active, paused, busy, queueLength: queue.length,
          totalEntries: c.covered, totalFolders: c.folders, drilled: !!drill,
          visibleTotal: visibleTotal, visibleReady: visibleReady,
          meanGenerateMs: rendered ? Math.round(totalMs / rendered) : 0 });
      }
      function updateStatus(nodes, viewport) {
        syncStats(nodes, viewport);
        if (destroyed) return;
        const pauseBtn = $('btnOverviewPause');
        const liteBtn = $('btnOverviewLite');
        const hint = document.querySelector('.overview-hint');
        if (pauseBtn) pauseBtn.hidden = lite;
        if (liteBtn) {
          liteBtn.classList.toggle('active', lite);
          liteBtn.setAttribute('aria-pressed', String(lite));
        }
        if (hint) hint.textContent = lite
          ? '相册浏览 · 文件夹写标记 · 已有结构封面直接显示'
          : '先显示当前封面 · 小步骤自动补齐 · 大步骤按需加载';
        $('overviewStatus').textContent = (lite ? '相册浏览 · 不现场拍三维' : paused ? '已暂停' : busy ? (stats.visibleReady < stats.visibleTotal ? '正在生成当前封面' : '后台补封面') : '已有封面直接显示，空闲时补缺') +
          ' · 当前可见 ' + stats.visibleReady + '/' + stats.visibleTotal + ' 张 · 全部已生成 ' + stats.generated + ' 张' +
          ' · 缓存 ' + cache.size + '/' + MAX_ITEMS + ' 张 · 图片预算 ' + (bytes / 1048576).toFixed(1) +
          '/' + (MAX_BYTES / 1048576).toFixed(0) + ' MiB · 生成器 ' + (sharedRenderer.viewerFor(owner) ? 1 : 0) + ' 个 · 累计 ' + stats.generated + ' 张 · 当前待补 ' + queue.length + ' 张' +
          (rendered ? ' · 平均 ' + Math.round(totalMs / rendered) + ' ms/张' : '');
        if (pauseBtn) pauseBtn.textContent = paused ? '继续生成' : '暂停生成';
      }
      function release(key) {
        const item = cache.get(key); if (!item) return;
        cache.delete(key); bytes -= item.encodedCost; decodedBytes -= item.decodedCost;
        URL.revokeObjectURL(item.url); stats.evictions++;
      }
      function cached(key) {
        const item = cache.get(key); if (!item) return null;
        cache.delete(key); cache.set(key, item); return item;
      }
      function cacheImage(key, blob, persist, token) {
        if (token === undefined) token = epoch;
        if (!ioValid(token) || !active) return null;
        const encodedCost = Number(blob && blob.size) || 0;
        const decodedCost = DECODED_COST;
        if (encodedCost > MAX_BYTES || decodedCost > DECODED_LIMIT) return null;
        while (cache.size >= MAX_ITEMS || bytes + encodedCost > MAX_BYTES || decodedBytes + decodedCost > DECODED_LIMIT) {
          const first = cache.keys().next().value; if (first === undefined) break; release(first);
        }
        if (cache.has(key)) release(key);
        const item = { url: URL.createObjectURL(blob), encodedCost, decodedCost };
        cache.set(key, item); bytes += encodedCost; decodedBytes += decodedCost;
        if (persist !== false) rememberThumb(key, blob, token);
        return item;
      }
      const thumbTransactions = new Set(), validationCancels = new Set();
      let dbConnection = null;
      function ioValid(token) { return !destroyed && token === epoch; }
      function cancelThumbIO() {
        for (const tx of thumbTransactions) { try { if (tx.abort) tx.abort(); } catch (_) {} }
        thumbTransactions.clear();
        for (const cancel of validationCancels) cancel(); validationCancels.clear();
        thumbReads.clear(); thumbWait.clear();
      }
      function thumbTransaction(db, token, aborted) {
        if (!db || !ioValid(token)) return null;
        const tx = db.transaction(['thumbs', 'meta'], 'readwrite');
        thumbTransactions.add(tx);
        tx.oncomplete = function () { thumbTransactions.delete(tx); };
        tx.onabort = function () { thumbTransactions.delete(tx); if (aborted) aborted(); };
        tx.onerror = function () { thumbTransactions.delete(tx); if (aborted) aborted(); };
        return tx;
      }
      const thumbDb = new Promise(function (resolve) {
        try {
          const req = indexedDB.open('structboard-thumbs', 2);
          req.onupgradeneeded = function () {
            if (destroyed) return;
            const db = req.result;
            if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          };
          req.onsuccess = function () {
            const db = req.result;
            if (destroyed) { try { if (db && db.close) db.close(); } catch (_) {} resolve(null); return; }
            dbConnection = db; resolve(db);
          };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
      const thumbWait = new Map();
      const thumbReads = new Map();
      function forgetThumb(key, token) {
        thumbDb.then(function (db) {
          if (!db || !ioValid(token)) return;
          try {
            const tx = thumbTransaction(db, token);
            if (!tx) return;
            tx.objectStore('thumbs').delete(key);
            const meta = tx.objectStore('meta');
            const req = meta.get('index');
            req.onsuccess = function () {
              if (!ioValid(token)) return;
              const index = req.result;
              if (!index || !index.items || !index.items[key]) return;
              index.bytes = Math.max(0, (index.bytes || 0) - (index.items[key].size || 0));
              delete index.items[key];
              meta.put(index, 'index');
            };
          } catch (_) { /* 重新生成仍可更新当前内存缓存 */ }
        });
      }
      async function validStoredThumb(blob, token) {
        if (!ioValid(token)) return false;
        const canvas = document.createElement('canvas');
        let bitmap = null, image = null, url = '', cancelled = false, finishImage = null;
        const cancel = function () {
          cancelled = true;
          if (url) { URL.revokeObjectURL(url); url = ''; }
          if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
          if (finishImage) finishImage(false);
        };
        validationCancels.add(cancel);
        try {
          if (typeof createImageBitmap === 'function') {
            bitmap = await createImageBitmap(blob);
            if (cancelled || !ioValid(token)) return false;
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
          } else {
            if (!ioValid(token)) return false;
            url = URL.createObjectURL(blob);
            image = document.createElement('img');
            const loaded = await new Promise(function (resolve) {
              finishImage = resolve; image.onload = function () { resolve(true); };
              image.onerror = function () { resolve(false); }; image.src = url;
            });
            if (!loaded || cancelled || !ioValid(token)) return false;
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            canvas.getContext('2d').drawImage(image, 0, 0);
          }
          return ioValid(token) && thumbnailHasContent(canvas);
        } catch (_) {
          return false;
        } finally {
          validationCancels.delete(cancel);
          if (bitmap && bitmap.close) bitmap.close();
          if (image) { image.onload = null; image.onerror = null; }
          if (url) URL.revokeObjectURL(url);
        }
      }
      function rememberThumb(key, blob, token) {
        thumbDb.then(function (db) {
          if (!db || !ioValid(token)) return;
          try {
            const tx = thumbTransaction(db, token);
            if (!tx) return;
            const thumbs = tx.objectStore('thumbs'), meta = tx.objectStore('meta');
            const now = Date.now(), size = Number(blob && blob.size) || 0;
            thumbs.put(blob, key);
            const req = meta.get('index');
            req.onsuccess = function () {
              if (!ioValid(token)) return;
              const index = req.result || { items: {}, bytes: 0 };
              const old = index.items[key];
              index.bytes += size - (old ? old.size : 0);
              index.items[key] = { size: size, touched: now };
              const keys = Object.keys(index.items);
              keys.sort(function (a, b) { return index.items[a].touched - index.items[b].touched; });
              while (keys.length > DISK_ITEMS || index.bytes > DISK_BYTES) {
                const victim = keys.shift();
                if (victim === key) continue;
                const info = index.items[victim];
                delete index.items[victim]; index.bytes -= info ? info.size : 0;
                thumbs.delete(victim);
              }
              meta.put(index, 'index');
            };
            tx.onerror = function () { /* quota/transaction failure leaves the current frame usable */ };
          } catch (e) { /* quota/old browsers: memory cache remains authoritative */ }
        });
      }
      function idbGet(key, token) {
        if (token === undefined) token = epoch;
        if (!ioValid(token)) return Promise.resolve(null);
        // Card recall and pump share one read/validation within an epoch. An old
        // continuation cannot remove a newer epoch's pending read or repaired cover.
        const old = thumbReads.get(key);
        if (old && old.epoch === token) return old.promise;
        const read = { epoch: token, promise: null };
        read.promise = readStoredThumb(key, token).finally(function () {
          if (thumbReads.get(key) === read) thumbReads.delete(key);
        });
        thumbReads.set(key, read);
        return read.promise;
      }
      function readStoredThumb(key, token) {
        return thumbDb.then(function (db) {
          if (!db || !ioValid(token)) return null;
          return new Promise(function (resolve) {
            try {
              const tx = thumbTransaction(db, token, function () { resolve(null); });
              if (!tx) { resolve(null); return; }
              const thumbs = tx.objectStore('thumbs'), meta = tx.objectStore('meta');
              const req = thumbs.get(key);
              req.onsuccess = function () {
                if (!ioValid(token)) { resolve(null); return; }
                const blob = req.result || null;
                if (!blob) { resolve(null); return; }
                const validated = function () {
                  if (!ioValid(token)) return Promise.resolve(null);
                  return validStoredThumb(blob, token).then(function (valid) {
                    if (!ioValid(token)) return null;
                    if (!valid) { forgetThumb(key, token); return null; }
                    return blob;
                  });
                };
                const indexReq = meta.get('index');
                indexReq.onsuccess = function () {
                  if (!ioValid(token)) { resolve(null); return; }
                  const index = indexReq.result || { items: {}, bytes: 0 };
                  const old = index.items[key], size = Number(blob.size) || 0;
                  index.bytes += size - (old ? old.size : 0);
                  index.items[key] = { size: size, touched: Date.now() };
                  meta.put(index, 'index');
                  resolve(validated());
                };
                indexReq.onerror = function () { resolve(validated()); };
              };
              req.onerror = function () { resolve(null); };
            } catch (e) { resolve(null); }
          });
        });
      }
      function recallThumb(card) {
        const key = card.key, token = epoch;
        if (!key || !active || !ioValid(token)) return Promise.resolve(null);
        if (cache.has(key)) return Promise.resolve(cache.get(key));
        const old = thumbWait.get(key);
        if (old && old.epoch === token) return old.promise;
        const wait = { epoch: token, promise: null };
        wait.promise = idbGet(key, token).then(function (blob) {
          if (!active || !ioValid(token)) return null;
          if (blob && !cache.has(key)) cacheImage(key, blob, false, token);
          if (blob) {
            for (const c of cards.values()) {
              if (c.key === key && c.node) paintCard(c, c.node);
            }
            updateStatus(activeLayout ? activeLayout.nodes : viewNodes());
          }
          return blob || null;
        }).finally(function () { if (thumbWait.get(key) === wait) thumbWait.delete(key); });
        thumbWait.set(key, wait);
        return wait.promise;
      }
      function isNoteFolder(node) {
        return !!(node && node.kind === 'folder' && (node.origin === 'user' || node.origin === 'removed' || !node.cover));
      }
      function wantsCover(node) {
        // 文件夹只显示收纳信息，进入后才为真实结构卡生成缩略图。
        return !!(node && node.kind === 'entry');
      }
      function savedLite() {
        try {
          const v = localStorage.getItem('structboard.overviewLite');
          if (v === '0') return false;
          if (v === '1') return true;
        } catch (e) { /* ignore */ }
        return hooks.liteDefault ? !!hooks.liteDefault() : false;
      }
      function setLite(on, persist) {
        if (destroyed) return;
        lite = !!on;
        if (lite) {
          newEpoch(); disposeViewer();
        } else if (active) ensureOwner();
        const btn = $('btnOverviewLite');
        if (btn) {
          btn.classList.toggle('active', lite);
          btn.setAttribute('aria-pressed', String(lite));
        }
        if (persist) {
          try { localStorage.setItem('structboard.overviewLite', lite ? '1' : '0'); } catch (e) { /* ignore */ }
        }
      }
      function keyFor(node, config) {
        if (node.kind === 'localfile') return node.id;
        return hooks.key(entryOf(node), arguments.length > 1 ? config : configFor(node), node);
      }
      function entryOf(node) {
        if (node.kind === 'localfile') return null;
        return node.kind === 'folder' ? node.cover : node.entry;
      }
      function idOf(node) {
        if (node.kind === 'section' || node.kind === 'localfile') return node.id;
        return node.kind === 'folder' ? node.id : node.entry.id;
      }
      function setDrillUI() {
        const back = $('btnOverviewBack');
        if (back) back.hidden = !drill;
        const nav = $('overviewPath');
        const title = $('overviewTitle');
        if (!nav) {
          if (title) title.textContent = drill
            ? drillStack.map(x => x.name).concat([drill.name]).join(' › ') + ' · ' + (drill.countText || drill.count + ' 份结构')
            : baseTitle;
          return;
        }
        nav.replaceChildren();
        function addSep() {
          const sep = document.createElement('span');
          sep.className = 'path-sep';
          sep.textContent = '›';
          nav.appendChild(sep);
        }
        function addCrumb(label, index, current) {
          if (nav.children.length) addSep();
          const btn = document.createElement(current ? 'strong' : 'button');
          btn.textContent = label;
          if (current) {
            // 不写动态 id：面包屑随 setDrillUI 反复重建，写 id 的时刻与其它实例的
            // 查找相互踩踏（曾导致 p2- 前缀泄漏进单屏）。身份由 .is-current 类 +
            // 「root 内最近一次重建的 nav」定位，不需要全局 id。
            btn.className = 'is-current';
          } else {
            btn.type = 'button';
            btn.addEventListener('click', function () { jumpTo(index); });
          }
          nav.appendChild(btn);
        }
        if (!drill) {
          addCrumb(baseTitle, -1, true);
          return;
        }
        addCrumb(drill.stepTitle || '结构总览', -1, false);
        drillStack.forEach(function (node, i) { addCrumb(node.name, i, false); });
        addCrumb(drill.name, drillStack.length, true);
      }
      function jumpTo(index) {
        if (destroyed) return;
        if (index < 0) {
          drill = null; drillStack = []; newEpoch();
          setDrillUI(); renderWindow(); playDrillAnimation();
          return;
        }
        const trail = drillStack.concat(drill ? [drill] : []);
        if (index >= trail.length) return;
        drill = trail[index];
        drillStack = trail.slice(0, index);
        newEpoch(); scroll.scrollTop = (drill && drill.returnScroll) || 0;
        setDrillUI(); renderWindow(); playDrillAnimation();
      }
      function selectionIds() { return Array.from(selected); }
      function paintSelection() {
        for (const card of cards.values()) {
          const id = card.node ? idOf(card.node) : '';
          card.box.classList.toggle('is-selected', selected.has(id));
        }
        // 方案 A：步骤行也参与选中（Ctrl+点选），选中整步可整体送进检阅台。
        for (const box of sections.values()) {
          box.classList.toggle('is-selected', selected.has(box.dataset.sectionId));
        }
      }
      function selectNode(node, mode, ordered) {
        if (!node) return;
        const id = idOf(node);
        if (mode === 'only') { selected.clear(); selected.add(id); }
        else if (mode === 'toggle') { if (selected.has(id)) selected.delete(id); else selected.add(id); }
        else if (mode === 'range' && lastSelectedId) {
          const ids = (ordered || viewNodes()).filter(function (n) { return n.kind !== 'section'; }).map(idOf);
          const a = ids.indexOf(lastSelectedId), b = ids.indexOf(id);
          if (a >= 0 && b >= 0) {
            const lo = Math.min(a, b), hi = Math.max(a, b);
            for (let i = lo; i <= hi; i++) selected.add(ids[i]);
          } else selected.add(id);
        } else selected.add(id);
        lastSelectedId = id;
        paintSelection();
        if (hooks.onSelect) hooks.onSelect(selectionIds());
      }
      // 搜索命中高亮：把命中的片段包成 <mark>，其余保持纯文本；不改变节点数据。
      function splitHighlight(text, query) {
        const q = String(query || '').trim().toLowerCase();
        const out = [];
        if (!q) { if (text) out.push({ text: text, hit: false }); return out; }
        const lower = String(text).toLowerCase();
        let i = 0;
        for (;;) {
          const hit = lower.indexOf(q, i);
          if (hit < 0) {
            if (i < text.length) out.push({ text: text.slice(i), hit: false });
            return out;
          }
          if (hit > i) out.push({ text: text.slice(i, hit), hit: false });
          out.push({ text: text.slice(hit, hit + q.length), hit: true });
          i = hit + q.length;
        }
      }
      function paintHighlighted(el, text, query) {
        el.textContent = '';
        for (const seg of splitHighlight(text, query)) {
          if (seg.hit) {
            const mark = document.createElement('mark');
            mark.textContent = seg.text;
            el.appendChild(mark);
          } else el.appendChild(document.createTextNode(seg.text));
        }
      }
      function paintCard(card, node) {
        if (node.kind === 'localfile') {
          card.box.classList.add('is-localfile');
          card.box.classList.remove('folder-card', 'is-starred', 'is-thumb-failed');
          card.tab.hidden = true;
          card.retryBtn.hidden = true;
          card.box.dataset.entryId = node.id;
          paintHighlighted(card.name, node.name, queryText());
          card.name.title = node.path || node.name;
          card.meta.textContent = '还有 ' + node.remain + ' 个';
          card.meta.title = node.path || '';
          card.dot.style.background = '';
          card.starBtn.hidden = true;
          card.starBadge.hidden = true;
          card.pos.hidden = true;
          card.pose.hidden = true;
          card.count.hidden = true;
          card.audit.hidden = true;
          if (card.noteDot) card.noteDot.hidden = true;
          card.image.hidden = true;
          card.placeholder.hidden = false;
          card.placeholder.textContent = '打开本地目录';
          card.key = node.id;
          card.open.dataset.hint = '打开本地目录';
          card.open.setAttribute('aria-label', '打开本地目录 ' + (node.path || '') + '，还有 ' + node.remain + ' 个文件');
          card.image.alt = '';
          return;
        }
        card.box.classList.remove('is-localfile');
        const folder = node.kind === 'folder';
        if (folder && !card.shell) { card.shell = makeFolderShell(); card.box.appendChild(card.shell); }
        const entry = entryOf(node);
        const starred = folder ? node.entries.some(function (x) { return x.star; }) : !!entry.star;
        card.box.classList.toggle('is-selected', selected.has(idOf(node)));
        card.box.classList.toggle('origin-user', node.origin === 'user');
        card.box.classList.toggle('origin-removed', node.origin === 'removed');
        card.box.classList.toggle('folder-card', folder);
        card.tab.hidden = !folder;
        card.box.classList.toggle('is-starred', starred);
        card.box.dataset.entryId = idOf(node);
        paintHighlighted(card.name, folder ? node.name : entry.name, queryText());
        card.name.classList.toggle('is-renamable', !!(hooks.onRename) && (!folder || node.origin === 'user'));
        card.name.title = folder
          ? node.name + '（' + (node.countText || node.count + ' 份结构') + (entry && entry.name ? '，封面 ' + entry.name : '') + '）'
          : ((entry.fullPath || entry.path || entry.name) + (hooks.onRename ? ' · 双击重命名' : ''));
        card.meta.textContent = folder ? (node.countText || node.count + ' 份结构') + (node.roleText ? ' · ' + node.roleText : '') : window.SB_LINEAGE.entryText(entry) || hooks.metric(entry);
        card.meta.title = card.meta.textContent;
        card.dot.style.background = folder ? '' : hooks.color(entry, configFor(node), node);
        card.starBtn.hidden = false;
        card.starBtn.setAttribute('aria-pressed', String(starred));
        card.starBtn.title = starred ? '取消优选' : '标记优选';
        card.star.classList.toggle('on', starred);
        card.open3d.hidden = !(!folder && entry && hooks.onOpen);
        card.starBadge.hidden = true;
        card.starBadge.classList.toggle('on', starred);
        card.starBadge.title = starred ? '此序列有优选预测' : '';
        const showPos = !folder && node.total > 1 && Number.isFinite(node.pos);
        card.pos.hidden = !showPos;
        if (showPos) card.pos.textContent = node.pos + '/' + node.total;
        // 点进文件夹后逐预测标注位姿：与封面 model_0 的偏差，或指标表里的显式结论。
        let poseInfo = null;
        if (!lite && showPos && node.auditEnabled !== false && hooks.entryPose) {
          try { poseInfo = hooks.entryPose(entry); } catch (error) { poseInfo = null; }
        }
        card.pose.hidden = !poseInfo;
        if (poseInfo) {
          if (poseInfo.source === 'cover') {
            card.pose.textContent = '封面';
            card.pose.classList.remove('ok', 'bad');
            card.pose.title = '此设计的封面模型（model_0），作为位置比较基准';
          } else if (poseInfo.source === 'table') {
            card.pose.textContent = poseInfo.pass ? '位置符合' : '位置不符';
            card.pose.classList.toggle('ok', !!poseInfo.pass);
            card.pose.classList.toggle('bad', !poseInfo.pass);
            card.pose.title = '指标表字段判定：' + (poseInfo.pass ? '符合位置' : '不符合位置');
          } else {
            card.pose.textContent = 'Δ' + poseInfo.rmsd.toFixed(2) + ' Å';
            card.pose.classList.toggle('ok', !!poseInfo.pass);
            card.pose.classList.toggle('bad', !poseInfo.pass);
            card.pose.title = '靶点 CA 对齐后 binder CA RMSD（相对 ' + poseInfo.cover + '）≤ '
              + poseInfo.threshold + ' Å 记为符合' + (poseInfo.swapped ? '；已按同源二聚体拷贝互换取更优' : '');
          }
          card.pose.dataset.pass = String(!!poseInfo.pass);
          card.pose.dataset.rmsd = poseInfo.rmsd === undefined ? '' : poseInfo.rmsd.toFixed(2);
        }
        card.count.hidden = !folder;
        if (folder) card.count.textContent = node.countText || node.count + ' 份结构';
        card.audit.hidden = !folder || !entry || node.auditEnabled === false || !hooks.folderAudit || lite;
        card.audit.classList.remove('all-pass', 'none-pass', 'is-pending');
        if (!lite && folder && entry && node.auditEnabled !== false && hooks.folderAudit) {
          const akey = hooks.folderAuditKey ? hooks.folderAuditKey(node) : idOf(node);
          const res = auditResults.get(akey);
          if (res) {
            if (res.source === 'pending') {
              card.audit.textContent = '位置 待核对';
              card.audit.removeAttribute('data-pass');
              card.audit.dataset.total = String(res.total);
              card.audit.dataset.source = 'pending';
              card.audit.classList.add('is-pending');
              card.audit.title = '还有 ' + res.pending + '/' + res.total + ' 个结构未读取坐标（延迟加载中）；打开或对齐后自动核算';
            } else {
              card.audit.textContent = '位置 ' + res.pass + '/' + res.total;
              card.audit.dataset.pass = String(res.pass);
              card.audit.dataset.total = String(res.total);
              card.audit.dataset.source = res.source;
              if (res.scores) card.audit.dataset.scores = res.scores.join(',');
              card.audit.classList.toggle('all-pass', res.pass === res.total);
              card.audit.classList.toggle('none-pass', res.pass === 0);
              card.audit.title = res.source === 'table'
                ? '符合位置的预测数（来自指标表字段）× 共 ' + res.total + ' 个预测'
                : '靶点 CA 对齐后 binder 与封面 ' + entry.name + ' 的 CA RMSD ≤ ' + res.threshold + ' Å 的预测数，共 ' + res.total + ' 个；本地位姿判定';
            }
          } else {
            card.audit.textContent = '位置 计算中';
            card.audit.title = '正在按界面残基一致性核算符合位置的预测数';
            pendingAudit.set(akey, { node, id: idOf(node) });
            scheduleAudit();
          }
        }
        if (isNoteFolder(node)) {
          card.key = '';
          card.image.removeAttribute('src');
          card.image.hidden = true;
          card.placeholder.hidden = true;
          card.retryBtn.hidden = true;
          const noteText = hooks.folderNote ? String(hooks.folderNote(node) || '') : '';
          if (card.noteDot) {
            // 有内容的便签常驻一枚金色角标，不用悬停也能发现
            card.noteDot.hidden = !noteText.trim();
            card.noteDot.title = noteText.trim() ? '已有便签：' + noteText.trim().slice(0, 60) : '';
          }
          if (card.note) {
            card.note.hidden = false;
            if (document.activeElement !== card.note) {
              card.note.value = hooks.folderNote ? String(hooks.folderNote(node) || '') : '';
            }
          }
          card.open.dataset.hint = '';
          card.open.setAttribute('aria-label', '文件夹 ' + node.name + '，单击进入，袋里可写标记');
          card.image.alt = '';
          fitFolderShell(card.box, card.shell);
          return;
        }
        if (card.note) card.note.hidden = true;
        if (card.noteDot) card.noteDot.hidden = true;
        const key = keyFor(node); card.key = key;
        // 文件夹外壳统一不展示封面；进入文件夹后，内部结构卡继续使用封面。
        if (folder) {
          card.image.removeAttribute('src');
          card.image.hidden = true;
          card.placeholder.hidden = false;
          card.placeholder.textContent = node.count ? '进入查看 ' + node.count + ' 条结构' : '空文件夹';
          card.retryBtn.hidden = true;
          card.box.classList.remove('is-thumb-failed');
          card.placeholder.removeAttribute('title');
        } else {
        const item = cached(key);
        if (item) {
          if (card.image.src !== item.url) card.image.src = item.url;
          card.image.hidden = false; card.placeholder.hidden = true;
          card.retryBtn.hidden = true;
          card.box.classList.remove('is-thumb-failed');
          card.placeholder.removeAttribute('title');
        } else {
          card.image.removeAttribute('src'); card.image.hidden = true; card.placeholder.hidden = false;
          const failed = failures.has(key);
          const reason = failed ? (failures.get(key) || '未知错误') : '';
          card.box.classList.toggle('is-thumb-failed', failed);
          card.retryBtn.hidden = !failed;
          card.placeholder.textContent = failed
            ? '生成失败：' + reason
            : thumbWait.has(key) ? '读取封面…'
            : lite ? '已保存的封面会直接显示'
            : paused ? '已暂停生成' : '等待封面…';
          if (failed) card.placeholder.title = reason + '（点击重试或直接进入查看）';
          else card.placeholder.removeAttribute('title');
        }
        }
        if (folder) {
          card.open.dataset.hint = '';
          card.open.setAttribute('aria-label', '文件夹 ' + node.name + '，单击进入');
          card.image.alt = (entry && entry.name ? entry.name + ' ' : '') + '封面';
          fitFolderShell(card.box, card.shell);
        } else {
          card.open.dataset.hint = '双击打开三维';
          card.open.setAttribute('aria-label', '交互查看：' + entry.name);
          card.image.alt = entry.name + '结构缩略图';
          card.box.style.clipPath = '';
        }
      }
      function makeCard(node) {
        const { box, tab, head, dot, name, meta, actions, starBtn, star, starBadge, noteDot, open, open3d, retryBtn, image, placeholder, note, pos, count, audit, pose } = global.SB_UI.createSurface('overviewCard');
        const shell = node.kind === 'folder' ? makeFolderShell() : null;
        if (shell) box.appendChild(shell);
        tab.hidden = true; tab.setAttribute('aria-hidden', 'true');
        starBtn.onclick = (e) => {
          e.stopPropagation();
          const n = card.node; if (!n || !hooks.onStar) return;
          if (n.kind === 'folder') {
            const anyStar = n.entries.some(function (x) { return x.star; });
            hooks.onStar(anyStar ? n.entries : n.cover, !anyStar);
          } else {
            hooks.onStar(n.entry);
          }
        };
        name.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const n = card.node;
          if (!n || n.kind === 'localfile' || !hooks.onRename) return;
          if (n.kind === 'folder' && n.origin === 'user' && hooks.onRenameFolder) {
            hooks.onRenameFolder(n); return;
          }
          if (n.kind === 'folder' || !n.entry) return;
          hooks.onRename(n.entry);
        });
        // 悬浮 3D 入口：双击开三维的显式替代；仅结构卡显示，hover 时出现。
        open3d.type = 'button'; open3d.className = 'cell-open-3d';
        open3d.textContent = '3D'; open3d.hidden = true;
        open3d.title = '打开三维查看';
        open3d.addEventListener('click', (e) => {
          e.stopPropagation();
          const n = card.node;
          if (!n || n.kind !== 'entry' || !n.entry || !hooks.onOpen) return;
          hooks.onOpen(n.entry);
        });
        retryBtn.type = 'button'; retryBtn.className = 'overview-retry'; retryBtn.textContent = '重试封面'; retryBtn.hidden = true;
        retryBtn.onclick = (e) => {
          e.stopPropagation();
          if (!card.key) return;
          failures.delete(card.key);
          if (card.node) paintCard(card, card.node);
          renderWindow({ fill: true });
        };
        image.width = W; image.height = H; image.decoding = 'async';
        image.draggable = false; // 图片默认可拖会抢走指针手势（pointercancel）
        note.className = 'folder-note';
        note.hidden = true;
        note.rows = 4;
        note.placeholder = '写标记…';
        note.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        note.addEventListener('click', function (e) { e.stopPropagation(); });
        note.addEventListener('dblclick', function (e) { e.stopPropagation(); });
        note.addEventListener('input', function () {
          const n = card.node;
          if (n && n.kind === 'folder' && hooks.onFolderNote) hooks.onFolderNote(n, note.value);
        });
        box.addEventListener('click', (e) => {
          if (Date.now() < drillGuardUntil || Date.now() < dragGuardUntil) return;
          if (pickMode) { pickClick(e, card.node); return; }
          if (e.target && e.target.closest && e.target.closest('button.icon-btn, button.mini-btn, button.overview-retry, input, textarea')) return;
          const n = card.node; if (!n) return;
          if (n.kind === 'folder' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            openFolder(n);
            return;
          }
          if (n.kind === 'localfile' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            if (hooks.onOpenDir) hooks.onOpenDir(n);
            return;
          }
          selectNode(n, e.shiftKey ? 'range' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'only');
        });
        box.addEventListener('dblclick', (e) => {
          if (Date.now() < drillGuardUntil || Date.now() < dragGuardUntil) return;
          if (pickMode) { e.preventDefault(); return; }
          if (e.target && e.target.closest && e.target.closest('.cell-name.is-renamable, textarea, .folder-note')) return;
          const n = card.node; if (!n) return;
          if (n.kind === 'localfile') { if (hooks.onOpenDir) hooks.onOpenDir(n); return; }
          if (n.kind === 'folder') openFolder(n);
          else if (hooks.onOpen) hooks.onOpen(n.entry);
        });
        box.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (pickMode) { exitPickPlace(); return; }
          const n = card.node; if (!n) return;
          if (!selected.has(idOf(n))) selectNode(n, 'only');
          if (hooks.onContext) hooks.onContext({ node: n, selected: selectionIds(), x: e.clientX, y: e.clientY });
        });
        // 拖拽由容器级 Pointer 手势统一处理；不再挂原生 draggable（会与 pointercancel 竞态）
        tab.onclick = (e) => { e.stopPropagation(); const n = card.node; if (n && n.kind === 'folder') openFolder(n); };
        const card = { box, shell, tab, name, meta, dot, star, starBtn, starBadge, noteDot, open, open3d, retryBtn, image, placeholder, note, pos, count, audit, pose, node, key: '' };
        return card;
      }
      const openNotes = new Set();
      // v2：一次性甩掉旧版本按 >24 卡自动折叠留下的历史状态，迁移后默认全部展开。
      const COLLAPSE_KEY = 'structboard.stepCollapsed.v2';
      function collapseMap() {
        try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; }
        catch (e) { return {}; }
      }
      function stepIsCollapsed(node) {
        const saved = collapseMap();
        if (Object.prototype.hasOwnProperty.call(saved, node.stepKey)) return !!saved[node.stepKey];
        // 方案 A（总览为家）：默认展开，打开就能看到货架；大管线的性能由虚拟化 +
        // 按需封面兜底，不再按卡片数自动折叠（那会让首页变成一排标题目录）。
        // 用户手动折叠过的步骤仍会被记住。
        return false;
      }
      function toggleStep(node) {
        // 收起吸顶的步骤时回到它的起点，避免内容缩短后跳到别的步骤。
        const item = ensureLayout().headers.find(function (item) { return item.node.id === node.id; });
        if (item && scroll.scrollTop > item.top) scroll.scrollTop = item.top;
        const saved = collapseMap();
        saved[node.stepKey] = !stepIsCollapsed(node);
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(saved)); } catch (e) { /* ignore */ }
        invalidateLayout(); renderWindow();
        buildMinimapTicks();
      }
      const PLAIN_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.2h4.4l1.4 1.6h7.2v7.2a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';
      function noteStateText(state) {
        return global.SB_NOTE_EDIT ? global.SB_NOTE_EDIT.stateText(state) : '';
      }
      function paintNoteState(box, node) {
        if (box.noteEdit) { box.noteEdit.paint(); return; }
        const label = box.querySelector('.overview-note-state');
        if (!label) return;
        const state = hooks.stepNoteState ? hooks.stepNoteState(node.stepKey) : null;
        label.textContent = noteStateText(state);
        label.dataset.state = (state && state.state) || 'saved';
        label.title = (state && state.error) || '输入即写本机；管线目录写入失败会自动重试';
        const retry = box.querySelector('.overview-note-retry');
        if (retry) retry.hidden = !(state && state.state === 'error' && !!hooks.onStepNoteRetry);
      }
      function paintNoteStates() {
        for (const [id, box] of sections) {
          const node = list.find(function (n) { return n.kind === 'section' && n.id === id; });
          if (node && box.querySelector('.overview-note-state')) paintNoteState(box, node);
        }
      }
      // 虚拟卸载、切模式、切目录、关窗前都把还排队的便签写入立刻交出去。
      function flushNoteEdits() {
        for (const [id, box] of sections) {
          const node = list.find(function (n) { return n.kind === 'section' && n.id === id; });
          if (!node) continue;
          if (box.noteEdit && box.noteEdit.hasPending()) box.noteEdit.commit();
        }
      }
      function paintSection(box, node) {
        box.dataset.stepKey = node.stepKey || '';
        const idxEl = box.querySelector('.overview-step-index');
        idxEl.classList.toggle('is-plain', !!node.plain);
        if (node.plain) idxEl.innerHTML = PLAIN_ICON;
        else idxEl.textContent = String(node.index || '');
        const title = box.querySelector('.overview-step-title');
        if (title.contentEditable !== 'true') title.textContent = node.title || '';
        const tool = box.querySelector('.overview-step-tool');
        if (node.plain) {
          tool.hidden = true;
        } else {
          tool.hidden = false;
          tool.classList.toggle('is-empty', !node.tool);
          tool.textContent = node.tool || '+ 工具';
          tool.title = node.tool ? '点击修改工具标签' : '点击添加工具标签';
        }
        const actions = box.querySelector('.overview-step-actions');
        if (actions) {
          actions.hidden = !!node.trash;
          actions.querySelectorAll('[data-nonplain="1"]').forEach(function (btn) { btn.hidden = !!node.plain; });
        }
        const noteBtn = box.querySelector('.overview-note-btn');
        if (noteBtn) noteBtn.hidden = !!node.trash;
        box.querySelector('.overview-step-count').textContent = node.countText || (node.count || 0) + ' 份结构';
        box.querySelector('.overview-step-count').title = [node.operation, node.desc].filter(Boolean).join(' · ');
        if (node.operation) tool.textContent = (node.tool ? node.tool + ' · ' : '') + node.operation;
        const area = box.querySelector('textarea');
        // 输入时就把 node.note 同步改掉，所以滚动/折叠/失焦触发重画不会再拿旧值覆盖输入框。
        if (document.activeElement !== area && area.value !== (node.note || '')) area.value = node.note || '';
        box.classList.toggle('note-open', openNotes.has(node.id));
        box.querySelector('.overview-note-btn').classList.toggle('has-note', !!(node.note && String(node.note).trim()));
        paintNoteState(box, node);
        const folded = node.trash ? false : stepIsCollapsed(node);
        box.classList.toggle('is-collapsed', folded);
        box.classList.toggle('is-trash-section', !!node.trash);
        const fold = box.querySelector('.overview-fold');
        fold.setAttribute('aria-expanded', String(!folded));
        fold.title = node.trash ? '回收站固定展开' : (folded ? '展开这一步' : '折叠这一步');
        fold.disabled = !!node.trash;
      }
      function makeSection(node) {
        const { box } = global.SB_UI.createSurface('overviewSection');

        const toggleCurrent = function () {
          const current = list.find(function (n) { return n.kind === 'section' && n.id === box.dataset.sectionId; });
          if (current) toggleStep(current);
        };
        const currentNode = function () {
          return list.find(function (n) { return n.kind === 'section' && n.id === box.dataset.sectionId; });
        };
        const title = box.querySelector('.overview-step-title');
        let foldTimer = 0;
        let origTitle = '';
        box.querySelector('.overview-step-row').addEventListener('click', function (e) {
          if (e.target && e.target.closest('button, textarea')) return;
          const current = currentNode();
          if (current && current.trash) return;
          if (title.contentEditable === 'true') return;
          if (e.ctrlKey || e.metaKey) {
            // 方案 A：Ctrl+点步骤 = 选中整步（可多选），供检阅台按范围打开。
            e.preventDefault();
            const cur = currentNode();
            if (cur) selectNode(cur, 'toggle');
            return;
          }
          if (e.target && e.target.closest('.overview-step-title')) {
            cancelLater(foldTimer);
            foldTimer = later(toggleCurrent, 200);
            return;
          }
          toggleCurrent();
        });
        box.querySelector('.overview-step-tool').addEventListener('click', function (e) {
          e.stopPropagation();
          const cur = currentNode();
          if (cur && hooks.onStepAction) hooks.onStepAction('tool', cur, e.currentTarget);
        });
        box.querySelectorAll('.overview-step-btn').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const cur = currentNode();
            if (cur && hooks.onStepAction) hooks.onStepAction(btn.dataset.act, cur, btn);
          });
        });
        box.addEventListener('dragover', function (e) {
          if (!e.dataTransfer || !hooks.onStepDrop) return;
          e.preventDefault();
          box.classList.add('is-step-dragover');
        });
        box.addEventListener('dragleave', function (e) {
          if (!box.contains(e.relatedTarget)) box.classList.remove('is-step-dragover');
        });
        box.addEventListener('drop', function (e) {
          if (!e.dataTransfer || !hooks.onStepDrop) return;
          e.preventDefault();
          e.stopPropagation();
          box.classList.remove('is-step-dragover');
          hooks.onStepDrop(box.dataset.stepKey || '', e.dataTransfer);
        });
        box.querySelector('.overview-fold').addEventListener('click', function (e) {
          e.stopPropagation();
          const current = currentNode();
          if (!current || current.trash) return;
          toggleCurrent();
        });
        title.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          cancelLater(foldTimer);
          origTitle = title.textContent || '';
          title.contentEditable = 'true';
          title.focus();
          const range = document.createRange();
          range.selectNodeContents(title);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        });
        title.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
          else if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            title.textContent = origTitle;
            title.contentEditable = 'false';
            title.blur();
          }
        });
        title.addEventListener('blur', function () {
          if (title.contentEditable !== 'true') return;
          title.contentEditable = 'false';
          const text = title.textContent.replace(/\s+/g, ' ').trim();
          if (!text) { title.textContent = origTitle; return; }
          if (hooks.onStepTitle) hooks.onStepTitle(box.dataset.stepKey, text);
        });
        box.querySelector('.overview-note-btn').addEventListener('click', function () {
          const id = box.dataset.sectionId;
          if (openNotes.has(id)) {
            if (box.noteEdit) box.noteEdit.commit();
            openNotes.delete(id);
          } else openNotes.add(id);
          invalidateLayout(); renderWindow(); buildMinimapTicks();
          if (openNotes.has(id)) later(function () { if (active && sections.get(id) === box) box.querySelector('textarea').focus(); }, 160);
        });
        const area = box.querySelector('textarea');
        area.setAttribute('aria-label', (node.title || '这一步') + '的便签');
        const currentSection = function () {
          return list.find(function (n) { return n.kind === 'section' && n.id === box.dataset.sectionId; });
        };
        // 输入即写本机与 outbox；网络防抖统一由 notes_sync 负责。
        box.noteEdit = global.SB_NOTE_EDIT.create({
          area: area,
          stateLabel: box.querySelector('.overview-note-state'),
          retryBtn: box.querySelector('.overview-note-retry'),
          noteBtn: box.querySelector('.overview-note-btn'),
          hooks: {
            draft: function (key, value) { if (hooks.onStepNoteDraft) hooks.onStepNoteDraft(key, value); },
            save: function (key, value) { if (hooks.onStepNote) hooks.onStepNote(key, value); },
            flush: function (key) { if (hooks.onStepNoteFlush) hooks.onStepNoteFlush(key); },
            retry: function (key) { if (hooks.onStepNoteRetry) hooks.onStepNoteRetry(key); },
            state: function (key) { return hooks.stepNoteState ? hooks.stepNoteState(key) : null; },
          },
          node: currentSection,
          key: function () { return box.dataset.stepKey; },
        });
        box.dataset.sectionId = node.id;
        paintSection(box, node);
        return box;
      }
      let placed = new Map();
      const sections = new Map();
      let activeLayout = null, layoutWidth = -1, layoutRevision = 0;
      let minimapLayout = null, minimapHeight = -1, minimapTop = -1;
      function invalidateLayout() {
        activeLayout = null; layoutRevision++; viewRevision++; queue = [];
        if (visibleFillTimer) { cancelLater(visibleFillTimer); visibleFillTimer = 0; }
      }
      function ensureLayout(width) {
        if (width === undefined) width = scroll.clientWidth;
        if (!activeLayout || layoutWidth !== width) {
          const nodes = viewNodes(), layout = layoutOf(nodes, width);
          const rows = [];
          for (const item of layout.items.slice().sort(function (a, b) { return a.top - b.top || a.index - b.index; })) {
            let row = rows[rows.length - 1];
            if (!row || row.top !== item.top) {
              row = { top: item.top, bottom: item.top + item.height, items: [] }; rows.push(row);
            }
            row.bottom = Math.max(row.bottom, item.top + item.height); row.items.push(item);
          }
          layout.nodes = nodes; layout.rows = rows; layout.coverage = coverage(nodes);
          layout.headers = layout.items.filter(function (item) { return item.node.kind === 'section'; });
          for (const grid of layout.grids) { grid.coverCount = 0; grid.coverItems = []; }
          for (const item of layout.items) if (item.grid && wantsCover(item.node)) {
            const grid = item.grid; grid.coverCount++;
            if (grid.coverCount <= SMALL_STEP_LIMIT) grid.coverItems.push(item);
            else if (grid.coverItems.length) grid.coverItems = [];
          }
          for (let i = 0; i < layout.headers.length; i++) layout.headers[i].coverGrid = layout.grids[i];
          activeLayout = layout; layoutWidth = width;
          placed = new Map(layout.items.map(function (item) { return [item.index, item]; }));
          stats.layoutBuilds++;
        }
        return activeLayout;
      }
      function visibleItems(layout, top, bottom) {
        const rows = layout.rows;
        let lo = 0, hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (rows[mid].bottom < top) lo = mid + 1; else hi = mid;
        }
        const items = [];
        for (let i = lo; i < rows.length && rows[i].top <= bottom; i++) {
          for (const item of rows[i].items) if (item.top + item.height >= top) items.push(item);
        }
        stats.itemsVisited += items.length;
        return items;
      }
      function sectionIndexAt(layout, top) {
        let lo = 0, hi = layout.headers.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (layout.headers[mid].top <= top + 1) lo = mid + 1; else hi = mid;
        }
        return lo - 1;
      }
      function scrollExtent(layout, height) {
        // Let even a short/folded final step reach the top when selected.
        const last = layout.headers[layout.headers.length - 1];
        return Math.max(height, layout.height, last ? last.top + height : 0);
      }
      function placeBox(box, left, top, width, height) {
        const geometry = [left, top, width, height].join('|');
        if (box.overviewGeometry === geometry) return false;
        box.overviewGeometry = geometry;
        box.style.left = left + 'px'; box.style.top = top + 'px';
        box.style.width = width + 'px'; box.style.height = height + 'px';
        return true;
      }
      function layoutOf(nodes, viewportWidth) {
        // 左侧留 26px 给刻度滚动条（minimap 移到左边）；右侧原生滚动条由 clientWidth 自动扣除。
        const MM_INSET = 26;
        const width = Math.max(180, (viewportWidth === undefined ? scroll.clientWidth : viewportWidth) - 36), gap = 10;
        // 与步骤行一致：fold(26) + gap(8) + row pad(2) = 36，卡片左缘对齐蓝色序号 / 便签
        const STEP_INDENT = 36;
        const hasSections = nodes.some(function (n) { return n.kind === 'section'; });
        const contentWidth = hasSections ? Math.max(160, width - STEP_INDENT) : width;
        const colsN = Math.max(1, Math.floor((contentWidth + gap) / 210));
        const cardWidth = (contentWidth - gap * (colsN - 1)) / colsN;
        const rowHeight = Math.round(49 + cardWidth * .75) + gap;
        const cardH = rowHeight - gap;
        const items = [];
        const grids = []; // 每个父层网格的几何：命中测试 / 落点高亮 / pick 模式共用
        const ORG = global.SB_ORG;
        const drillKey = (drill && ORG) ? ORG.folderNodeKey(drill) : null;
        const placeAt = function (node, slot, gridLeft, gridTop, grid) {
          items.push({
            node: node, index: items.length, slot: slot, grid: grid,
            left: gridLeft + (slot % colsN) * (cardWidth + gap),
            top: gridTop + Math.floor(slot / colsN) * rowHeight,
            width: cardWidth, height: cardH,
          });
        };
        const collectSlots = function (list) {
          // 显式 _slot 优先；缺槽的卡（聚合入口等）排到最大 slot 之后
          let maxSlot = -1;
          list.forEach(function (n) { if (Number.isFinite(n._slot)) maxSlot = Math.max(maxSlot, n._slot); });
          let natural = maxSlot + 1;
          list.forEach(function (n) {
            if (!Number.isFinite(n._slot)) n._slot = natural++;
            maxSlot = Math.max(maxSlot, n._slot);
          });
          return maxSlot;
        };
        if (!hasSections) {
          // 钻取视图：单网格，slot 之间允许留空
          const maxSlot = collectSlots(nodes);
          const height = Math.ceil((maxSlot + 1) / colsN) * rowHeight;
          const grid = { parentKey: drillKey || 'root', stepKey: drill ? drill.stepKey : '', sectionNode: null,
            left: MM_INSET, top: 0, bottom: height, colsN: colsN, cardWidth: cardWidth, cardH: cardH, rowHeight: rowHeight, maxSlot: maxSlot, hidden: false };
          nodes.forEach(function (node) { placeAt(node, node._slot, MM_INSET, 0, grid); });
          grids.push(grid);
          return { items: items, grids: grids, height: height };
        }
        let y = 0;
        for (let i = 0; i < nodes.length; ) {
          const node = nodes[i];
          if (node.kind !== 'section') { i++; continue; }
          if (i) y += 18;
          const hide = node.trash ? false : stepIsCollapsed(node);
          const sectionH = openNotes.has(node.id) ? 196 : 40;
          items.push({ node: node, index: items.length, left: MM_INSET, top: y, width: width, height: sectionH });
          const gridTop = y + sectionH + (hide ? 4 : 12);
          const cards = [];
          let j = i + 1;
          while (j < nodes.length && nodes[j].kind !== 'section') { cards.push(nodes[j]); j++; }
          let maxSlot = -1;
          if (!hide && cards.length) maxSlot = collectSlots(cards);
          const grid = { parentKey: 'root', stepKey: node.stepKey || '', sectionNode: node,
            left: STEP_INDENT + MM_INSET, top: gridTop, colsN: colsN, cardWidth: cardWidth, cardH: cardH, rowHeight: rowHeight, maxSlot: maxSlot, hidden: hide };
          if (!hide) cards.forEach(function (card) { placeAt(card, card._slot, grid.left, gridTop, grid); });
          grids.push(grid);
          // slot 是格子序号，不是行数；步骤高度按实际行数计算。
          y = gridTop + (hide ? 0 : Math.max(1, Math.ceil((maxSlot + 1) / colsN)) * rowHeight);
          grid.bottom = y;
          i = j;
        }
        // 卡片与空白落点共用同一个、已含 minimap 留白的网格对象。
        // 不能仅给 items/grids 分别拷贝加偏移，否则命中与让位拿到的不是同一坐标系。
        return { items: items, grids: grids, height: y };
      }
      function inView(index) {
        const item = placed.get(index);
        if (!item) return false;
        const top = scroll.scrollTop, bottom = top + scroll.clientHeight;
        return item.top + item.height >= top - 240 && item.top <= bottom + 240;
      }
      function renderWindow(opts) {
        if (destroyed || !active) return;
        const scrolling = !!(opts && opts.scroll);
        const top = scroll.scrollTop, height = scroll.clientHeight, width = scroll.clientWidth;
        const previousLayout = activeLayout, layout = ensureLayout(width), nodes = layout.nodes;
        const windowTop = top - 240, windowBottom = top + height + 240;
        const visible = visibleItems(layout, windowTop, windowBottom);
        // 虚拟窗口之外也保留当前步骤的真实标题，操作和便签仍共用原节点。
        const headers = layout.headers;
        const currentIndex = sectionIndexAt(layout, top);
        const pinned = headers[currentIndex], nextHeader = headers[currentIndex + 1];
        if (pinned && !visible.includes(pinned)) visible.push(pinned);
        cols = Math.max(1, Math.floor((Math.max(180, width - 10) + 10) / 210));
        rowHeight = layout.items.length ? layout.items[0].height + 10 : 230;
        const spacerHeight = scrollExtent(layout, height) + 'px';
        if (spacer.style.height !== spacerHeight) spacer.style.height = spacerHeight;
        const desired = new Set(visible.map(function (item) { return idOf(item.node); }));
        for (const [id, card] of cards) if (!desired.has(id)) {
          card.box.remove(); card.image.removeAttribute('src'); cards.delete(id);
          if (card.node.kind === 'entry' && !drag && !dragPending && !pickMode && entryCardPool.length < 64) {
            card.node = null; card.key = ''; card.overviewRevision = -1;
            card.box.className = 'overview-card'; card.box.style.transform = '';
            entryCardPool.push(card);
          } else if (card.box.__disposeView) card.box.__disposeView();
        }
        for (const item of visible) {
          const node = item.node;
          const id = idOf(node);
          desired.add(id);
          if (node.kind === 'section') {
            let box = sections.get(id);
            if (!box) { box = makeSection(node); sections.set(id, box); layer.append(box); }
            if (!scrolling || box.overviewRevision !== layoutRevision) {
              paintSection(box, node); box.overviewRevision = layoutRevision;
            }
            const pinnedTop = item === pinned
              ? Math.max(item.top, Math.min(top, nextHeader ? nextHeader.top - item.height : top))
              : item.top;
            box.classList.toggle('is-sticky', pinnedTop > item.top);
            placeBox(box, 0, item.top, item.width, item.height);
            const shift = pinnedTop - item.top;
            const transform = shift ? 'translateY(' + shift + 'px)' : '';
            if (box.style.transform !== transform) box.style.transform = transform;
            continue;
          }
          let card = cards.get(id);
          const fresh = !card;
          if (!card) {
            card = node.kind === 'entry' && entryCardPool.length ? entryCardPool.pop() : makeCard(node);
            cards.set(id, card);
          }
          const nodeChanged = card.node !== node;
          card.node = node;
          const moved = placeBox(card.box, item.left, item.top, item.width, item.height);
          if (!scrolling || fresh || moved || nodeChanged || card.overviewRevision !== layoutRevision) {
            paintCard(card, node); card.overviewRevision = layoutRevision; stats.cardsPainted++;
          }
          if (fresh) layer.append(card.box);
        }
        for (const [id, box] of sections) if (!desired.has(id)) {
          // 只加速已编辑便签的同步；滚动卸载不能生成未编辑空便签的写入。
          if (box.noteEdit && box.noteEdit.hasPending()) box.noteEdit.commit();
          if (box.__disposeView) box.__disposeView();
          box.remove(); sections.delete(id);
        }
        $('overviewEmpty').hidden = !!nodes.length;
        if (!scrolling || previousLayout !== layout || desired.size !== stats.mountedCards + sections.size) updateStatus(nodes, { top, height });
        else syncStats(nodes, { top, height });
        stats.windowRenders++;
        if (previousLayout !== layout) buildMinimapTicks();
        scheduleVisibleFill(layout);
      }
      function scheduleWindow() {
        if (destroyed || frame || !active) return;
        frame = raf(function () {
          frame = 0;
          buildMinimapTicks(); updateMinimapPill();
          renderWindow({ scroll: true });
        });
        scheduleVisibleFill();
      }
      function scrolled() {
        if (destroyed || !active) return;
        sharedRenderer.interact(); mmBubble.hidden = true;
        viewRevision++; queue = [];
        sharedRenderer.cancel(owner);
        if (hooks.onViewChange) hooks.onViewChange('scroll');
        scheduleWindow();
      }
      /* ---------- 指针拖拽：跟手卡片预览 + 网格摆放（保留空位）/ 文件夹移入 ----------
         单一 Pointer Events 手势；不再使用原生 draggable（WebView2 pointercancel 竞态）。 */
      let drag = null;          // 活动拖拽
      let dragPending = null;   // pointerdown 未过 6px 阈值
      let pickMode = null;      // 右键“移动位置…”的选格状态
      let dragGuardUntil = 0;   // 拖完抑制误点击/误进夹
      let moveRAF = 0, scrollRAF = 0;
      let lastPointer = { x: 0, y: 0 };
      let dropCell = null, dropHint = null;
      const previewBox = document.createElement('div');
      previewBox.className = 'ov-drag-preview-layer';
      previewBox.setAttribute('aria-hidden', 'true');
      const pickBanner = document.createElement('div');
      pickBanner.className = 'ov-pick-banner';
      pickBanner.hidden = true;
      function ensureDropCell() {
        if (!dropCell) { dropCell = document.createElement('div'); dropCell.className = 'ov-drop-cell'; dropCell.hidden = true; layer.appendChild(dropCell); }
        return dropCell;
      }
      function ensureDropHint() {
        if (!dropHint) { dropHint = document.createElement('div'); dropHint.className = 'ov-drop-hint'; dropHint.hidden = true; document.body.appendChild(dropHint); }
        return dropHint;
      }
      function clearTargetUI() {
        if (dropCell) dropCell.hidden = true;
        if (dropHint) dropHint.hidden = true;
        for (const card of cards.values()) {
          card.box.classList.remove('is-drop-target', 'is-reflowing');
          card.box.style.transform = '';
          delete card._reflow;
        }
      }
      function movableNode(node) {
        if (!node || node.kind === 'localfile' || node.origin === 'removed' || node.trash) return false;
        if (String(node.id || '').indexOf('pile:') === 0) return false;
        const ORG = global.SB_ORG;
        return !!(ORG && ORG.refOfNode(node));
      }
      function folderCenterOK(node) {
        return node && node.kind === 'folder' && node.origin !== 'removed' &&
          String(node.id || '').indexOf('pile:') !== 0;
      }
      function nodeStepKey(node, grid) {
        if (grid && grid.stepKey) return grid.stepKey;
        return (drill && drill.stepKey) || node.stepKey || (node.entry && node.entry.stepKey) || '';
      }
      function itemOfNode(node) {
        const id = idOf(node);
        for (const item of placed.values()) if (idOf(item.node) === id) return item;
        return null;
      }
      function currentGrids() {
        return ensureLayout().grids;
      }
      function layerNodesForGrid(grid) {
        if (grid.sectionNode) {
          const nodes = viewNodes();
          let inside = false;
          const out = [];
          for (const n of nodes) {
            if (n.kind === 'section') { inside = n === grid.sectionNode; continue; }
            if (inside) out.push(n);
          }
          return out;
        }
        return viewNodes();
      }
      // 手机桌面式让位：把 srcNodes 从当前顺序中抽出、插入到 slot 处，
      // 返回每个节点的新 slot（其余节点自动收拢，不留空洞）。
      // 排序结果按网格缓存在拖拽状态里——大步骤（数千卡）不能每帧重排。
      function gridKeyOf(grid) {
        return grid.sectionNode ? grid.sectionNode.id : '__drill__';
      }
      function sortedLayerNodes(grid) {
        if (!drag) return layerNodesForGrid(grid).slice().sort(function (a, b) { return a._slot - b._slot; });
        let arr = drag.sortedCache.get(gridKeyOf(grid));
        if (!arr) {
          arr = layerNodesForGrid(grid).slice().sort(function (a, b) { return a._slot - b._slot; });
          drag.sortedCache.set(gridKeyOf(grid), arr);
        }
        return arr;
      }
      function reflowInfo(grid, slot, srcNodes) {
        const ordered = sortedLayerNodes(grid);
        const srcSet = new Set(srcNodes);
        const remaining = ordered.filter(function (n) { return !srcSet.has(n); });
        const idx = remaining.filter(function (n) { return Number.isFinite(n._slot) && n._slot < slot; }).length;
        const newSlot = new Map();
        remaining.slice(0, idx).forEach(function (n, i) { newSlot.set(n, i); });
        srcNodes.forEach(function (n, i) { newSlot.set(n, idx + i); });
        remaining.slice(idx).forEach(function (n, i) { newSlot.set(n, idx + srcNodes.length + i); });
        return { idx: idx, newSlot: newSlot, ordered: ordered, remaining: remaining };
      }
      function computeTarget(cx, cy, parentKey, stepKey, srcNodes) {
        const rect = layer.getBoundingClientRect();
        const px = cx - rect.left, py = cy - rect.top;
        let hitItem = null;
        for (const item of placed.values()) {
          if (px >= item.left && px <= item.left + item.width && py >= item.top && py <= item.top + item.height) { hitItem = item; break; }
        }
        let grid = hitItem ? hitItem.grid : null;
        if (!grid) {
          const grids = currentGrids();
          for (let i = 0; i < grids.length; i++) {
            const g = grids[i];
            if (g.hidden) continue;
            const next = grids[i + 1];
            const end = next && next.sectionNode ? next.top - 12 : g.bottom + g.rowHeight;
            if (py >= g.top && py < end) { grid = g; break; }
          }
        }
        if (!grid) return { type: 'none' };
        if (parentKey && grid.parentKey !== parentKey) return { type: 'invalid', grid: grid };
        if (stepKey && grid.stepKey && grid.stepKey !== stepKey) return { type: 'invalid', grid: grid };
        const col = Math.max(0, Math.min(grid.colsN - 1, Math.floor((px - grid.left + 5) / (grid.cardWidth + 10))));
        const row = Math.max(0, Math.floor((py - grid.top + 5) / grid.rowHeight));
        if (row > grid.maxSlot + 1) return { type: 'none' };
        const slot = row * grid.colsN + col;
        const info = reflowInfo(grid, slot, srcNodes || []);
        // 文件夹中心 = 移入（桌面直觉：对准夹子扔进去）；想插到夹子前方/后方
        // 用它外缘的格子区域。文件夹被让位移走后，基准格与视觉位置错开——
        // 按让位后的视觉矩形补一次中心命中。
        const folderHit = function (item) {
          if (!item || item.node.kind !== 'folder' || !folderCenterOK(item.node) || item.grid !== grid) return false;
          if ((srcNodes || []).indexOf(item.node) >= 0) return false;
          const off = reflowOffsetOf(item);
          const innerX = (px - item.left - off.dx) / item.width, innerY = (py - item.top - off.dy) / item.height;
          return innerX > 0.22 && innerX < 0.78 && innerY > 0.22 && innerY < 0.78;
        };
        if (folderHit(hitItem)) return { type: 'folder', node: hitItem.node, item: hitItem, grid: grid };
        if (!hitItem || !folderHit(hitItem)) {
          for (const item of placed.values()) {
            if (folderHit(item)) return { type: 'folder', node: item.node, item: item, grid: grid };
          }
        }
        // 插入位由 reflowInfo 的 idx 决定：slot 超出剩余节点数时自然变成队尾追加，
        // landSlot 由 paintTarget 取 srcNodes[0] 的新 slot 展示。
        return { type: 'slot', slot: slot, grid: grid, info: info };
      }
      function reflowOffsetOf(item) {
        const card = cards.get(idOf(item.node));
        return (card && card._reflow) ? card._reflow : { dx: 0, dy: 0 };
      }
      function applyReflowVisual(grid, slot, srcNodes) {
        const info = reflowInfo(grid, slot, srcNodes);
        for (const item of placed.values()) {
          if (item.grid !== grid) continue;
          const card = cards.get(idOf(item.node));
          if (!card) continue;
          const ns = info.newSlot.get(item.node);
          if (ns === undefined || ns === item.slot) {
            card.box.classList.remove('is-reflowing');
            card.box.style.transform = '';
            delete card._reflow;
            continue;
          }
          const dx = ((ns % grid.colsN) - (item.slot % grid.colsN)) * (grid.cardWidth + 10);
          const dy = (Math.floor(ns / grid.colsN) - Math.floor(item.slot / grid.colsN)) * grid.rowHeight;
          card.box.classList.add('is-reflowing');
          card.box.style.transform = 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px)';
          card._reflow = { dx: Math.round(dx), dy: Math.round(dy) };
        }
      }
      function paintTarget(target) {
        // 同一目标格不重复做清除/重算——大工作区每帧全量 clear+sort 是卡顿根源
        const key = (!target || target.type === 'none') ? 'none'
          : target.type + ':' + gridKeyOf(target.grid) + ':' +
            (target.type === 'slot' ? target.slot : target.type === 'folder' ? idOf(target.node) : '') + ':' + Math.round(scroll.scrollTop);
        if (drag) {
          if (key === drag.lastPaintKey) return;
          drag.lastPaintKey = key;
        }
        clearTargetUI();
        if (!target || target.type === 'none') return;
        const layerRect = layer.getBoundingClientRect();
        const srcNodes = (drag ? drag.sources : (pickMode ? pickMode.sources : [])).map(function (s) { return s.node; });
        if (target.type === 'invalid') {
          const hint = ensureDropHint();
          hint.textContent = '跨步骤不能直接移动';
          hint.className = 'ov-drop-hint is-invalid';
          hint.style.left = Math.round(layerRect.left + target.grid.left + 10) + 'px';
          hint.style.top = Math.round(layerRect.top + target.grid.top - 24) + 'px';
          hint.hidden = false;
          return;
        }
        if (target.type === 'folder') {
          const card = cards.get(idOf(target.node));
          if (card) card.box.classList.add('is-drop-target');
          const hint = ensureDropHint();
          hint.textContent = '移入「' + (target.node.name || '文件夹') + '」';
          hint.className = 'ov-drop-hint is-move';
          hint.style.left = Math.round(layerRect.left + target.item.left + target.item.width / 2 - 60) + 'px';
          hint.style.top = Math.round(layerRect.top + target.item.top - 26) + 'px';
          hint.hidden = false;
          return;
        }
        const g = target.grid;
        const info = reflowInfo(g, target.slot, srcNodes);
        // 虚线格画在“松手后这张卡实际落到的位置”（插入位），而不是指针所在的原始格
        const landSlot = srcNodes.length ? (info.newSlot.get(srcNodes[0].node || srcNodes[0]) ?? target.slot) : target.slot;
        const cell = ensureDropCell();
        cell.style.left = Math.round(g.left + (landSlot % g.colsN) * (g.cardWidth + 10)) + 'px';
        cell.style.top = Math.round(g.top + Math.floor(landSlot / g.colsN) * g.rowHeight) + 'px';
        cell.style.width = Math.round(g.cardWidth) + 'px';
        cell.style.height = Math.round(g.cardH) + 'px';
        cell.hidden = false;
        let occ = null;
        for (const item of placed.values()) {
          if (item.grid === g && item.slot === landSlot) { occ = item.node; break; }
        }
        const hint = ensureDropHint();
        hint.textContent = '插入到第 ' + (landSlot + 1) + ' 位' + (occ ? ' ·「' + (occ.name || (occ.entry && occ.entry.name) || '?') + '」自动让位' : '');
        hint.className = 'ov-drop-hint';
        hint.style.left = Math.round(layerRect.left + (g.left + (landSlot % g.colsN) * (g.cardWidth + 10))) + 'px';
        hint.style.top = Math.round(layerRect.top + (g.top + Math.floor(landSlot / g.colsN) * g.rowHeight) - 24) + 'px';
        hint.hidden = false;
        if (srcNodes.length) applyReflowVisual(g, target.slot, srcNodes);
      }
      function buildPreview() {
        previewBox.replaceChildren();
        const previewSources = drag.sources.slice().sort(function (a, b) {
          return Number(idOf(b.node) === drag.anchorId) - Number(idOf(a.node) === drag.anchorId);
        });
        previewBox.style.width = drag.w + 'px';
        previewBox.style.height = drag.h + 'px';
        previewSources.slice(0, 3).forEach(function (src, i) {
          const card = cards.get(idOf(src.node));
          if (!card) return;
          const clone = card.box.cloneNode(true);
          // cloneNode 保留 source card 的 .overview-card 结构；只移除临时状态，
          // 不覆盖 folder-card/origin-user/is-starred 等视觉类，否则文件夹预览会退化成白块。
          clone.classList.remove('is-selected', 'is-drag-source', 'is-drop-target', 'is-reflowing', 'is-jump-flash');
          clone.classList.add('ov-drag-preview');
          clone.removeAttribute('data-entry-id');
          clone.removeAttribute('id');
          // 源卡的内联 left/top 属于整个滚动内容，不能带入 fixed 预览层。
          clone.style.left = '0px';
          clone.style.top = '0px';
          clone.style.width = drag.w + 'px';
          clone.style.height = drag.h + 'px';
          clone.style.transition = 'none';
          clone.style.transform = 'translate(' + (i * 16) + 'px,' + (i * 16) + 'px)';
          clone.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
          const oldShell = clone.querySelector('.folder-shell');
          if (oldShell && clone.classList.contains('folder-card')) {
            // 生成独立 SVG ID，保留文件夹外壳/星标颜色，避免与源卡 clip/gradient 冲突。
            const shell = makeFolderShell();
            oldShell.replaceWith(shell);
            fitFolderShell(clone, shell);
          }
          previewBox.appendChild(clone);
        });
        if (drag.sources.length > 3) {
          const more = document.createElement('span');
          more.className = 'ov-drag-count';
          more.textContent = '+' + (drag.sources.length - 3);
          previewBox.appendChild(more);
        }
        drag.sources.forEach(function (src) {
          const card = cards.get(idOf(src.node));
          if (card) card.box.classList.add('is-drag-source');
        });
      }
      function startDrag(pending, pointer) {
        const node = pending.node;
        if (!movableNode(node)) return false;
        if (!selected.has(idOf(node))) selectNode(node, 'only');
        const item = itemOfNode(node);
        const sourceStep = nodeStepKey(node, item && item.grid);
        const sources = selectionIds().map(function (id) { return findNode(id); })
          .filter(Boolean).filter(movableNode)
          .filter(function (n) {
            const current = itemOfNode(n);
            return n._parentKey === node._parentKey && nodeStepKey(n, current && current.grid) === sourceStep;
          });
        sources.sort(function (a, b) { return (a._slot || 0) - (b._slot || 0); });
        const sourceCard = cards.get(idOf(node));
        const sourceRect = sourceCard ? sourceCard.box.getBoundingClientRect() : null;
        drag = {
          pointerId: pending.pointerId,
          sources: sources.map(function (n) { return { node: n }; }),
          parentKey: node._parentKey || 'root',
          stepKey: nodeStepKey(node, item ? item.grid : null),
          grabDX: pending.gx, grabDY: pending.gy,
          anchorId: idOf(node),
          w: sourceRect ? sourceRect.width : (item ? item.width : 200),
          h: sourceRect ? sourceRect.height : (item ? item.height : 160),
          lastTarget: null,
          sortedCache: new Map(),
          lastPaintKey: '',
        };
        try { scroll.setPointerCapture(drag.pointerId); } catch (_) { /* 老内核忽略 */ }
        scroll.classList.add('is-card-dragging');
        buildPreview();
        document.body.appendChild(previewBox);
        bind(document, 'keydown', dragKeydown, true);
        lastPointer = { x: pointer.clientX, y: pointer.clientY };
        updateDrag(lastPointer.x, lastPointer.y);
        scrollRAF = raf(scrollLoop);
        return true;
      }
      function updateDrag(cx, cy) {
        if (!drag) return;
        previewBox.style.transform = 'translate(' + Math.round(cx - drag.grabDX) + 'px,' + Math.round(cy - drag.grabDY) + 'px)';
        const target = computeTarget(cx, cy, drag.parentKey, drag.stepKey, drag.sources.map(function (s) { return s.node; }));
        drag.lastTarget = target;
        paintTarget(target);
      }
      function scrollLoop() {
        scrollRAF = 0;
        if (!drag) return;
        const rect = scroll.getBoundingClientRect();
        const y = lastPointer.y;
        const zone = 56;
        let dy = 0;
        if (y < rect.top + zone) dy = -Math.ceil((rect.top + zone - y) / 5);
        else if (y > rect.bottom - zone) dy = Math.ceil((y - (rect.bottom - zone)) / 5);
        if (dy) {
          scroll.scrollTop = Math.max(0, scroll.scrollTop + dy);
          updateDrag(lastPointer.x, lastPointer.y);
        }
        scrollRAF = raf(scrollLoop);
      }
      function dragKeydown(e) {
        if (e.key !== 'Escape' || !drag) return;
        e.preventDefault();
        e.stopPropagation();
        endDrag(false);
      }
      // 插入式提交：抽出拖动项、插到 slot 处，其余节点收拢重编号（dense 0..n-1，不留空洞）。
      function commitPlacement(sources, parentKey, stepKey, slot, grid) {
        const ORG = global.SB_ORG;
        if (!ORG || !sources.length) return false;
        const srcNodes = sources.map(function (s) { return s.node || s; });
        const info = reflowInfo(grid, slot, srcNodes);
        const newOrder = info.remaining.slice(0, info.idx)
          .concat(srcNodes.map(function (s) { return s.node || s; }), info.remaining.slice(info.idx));
        const items = [];
        for (let s = 0; s < newOrder.length; s++) {
          const n = newOrder[s];
          const ref = ORG.refOfNode(n);
          if (!ref) continue;
          items.push({ ref: ref, slot: s, path: (n.kind === 'entry' && n.entry && ORG.relPath) ? ORG.relPath(n.entry) : undefined });
        }
        if (!items.length) return false;
        if (hooks.onPlace) hooks.onPlace({ stepKey: stepKey, parentKey: parentKey, items: items });
        return true;
      }
      function commitDrop() {
        const target = drag.lastTarget;
        if (!target || target.type === 'none' || target.type === 'invalid') return false;
        if (target.type === 'folder') {
          if (hooks.onMove) hooks.onMove({ ids: drag.sources.map(function (s) { return idOf(s.node); }), target: target.node });
          return true;
        }
        return commitPlacement(drag.sources, drag.parentKey, drag.stepKey, target.slot, target.grid);
      }
      function endDrag(commit) {
        if (!drag) return;
        const pointerId = drag.pointerId;
        try {
          if (commit) commitDrop();
        } finally {
          drag = null;
          if (previewBox.parentElement) previewBox.remove();
          clearTargetUI();
          stopLoops();
          unbind(document, 'keydown', dragKeydown, true);
          try { scroll.releasePointerCapture(pointerId); } catch (_) { /* 已释放 */ }
          for (const card of cards.values()) card.box.classList.remove('is-drag-source');
          scroll.classList.remove('is-card-dragging');
          dragGuardUntil = Date.now() + 350;
        }
      }
      function stopLoops() {
        if (moveRAF) cancelRaf(moveRAF); moveRAF = 0;
        if (scrollRAF) cancelRaf(scrollRAF); scrollRAF = 0;
      }
      // ---- 选格模式（右键“移动位置…”）：点击 / Enter 放置，方向键移格，Esc 取消 ----
      function pickGrid() {
        const parentKey = pickMode.parentKey, stepKey = pickMode.stepKey;
        for (const g of currentGrids()) {
          if (g.hidden) continue;
          if (g.parentKey === parentKey && (!g.stepKey || !stepKey || g.stepKey === stepKey)) return g;
        }
        return null;
      }
      function updatePickCursor() {
        const grid = pickGrid();
        if (!grid || pickMode.cursor < 0) { if (dropCell) dropCell.hidden = true; return; }
        const g = grid;
        const cell = ensureDropCell();
        cell.style.left = Math.round(g.left + (pickMode.cursor % g.colsN) * (g.cardWidth + 10)) + 'px';
        cell.style.top = Math.round(g.top + Math.floor(pickMode.cursor / g.colsN) * g.rowHeight) + 'px';
        cell.style.width = Math.round(g.cardWidth) + 'px';
        cell.style.height = Math.round(g.cardH) + 'px';
        cell.hidden = false;
      }
      function commitPick(slot) {
        const grid = pickGrid();
        if (!grid) { exitPickPlace(); return; }
        if (commitPlacement(pickMode.sources, pickMode.parentKey, pickMode.stepKey, slot, grid)) {
          exitPickPlace();
        } else exitPickPlace();
      }
      function pickKeydown(e) {
        if (!pickMode) return;
        const grid = pickGrid();
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitPickPlace(); return; }
        if (!grid) return;
        const cols = grid.colsN;
        if (e.key === 'ArrowRight') pickMode.cursor++;
        else if (e.key === 'ArrowLeft') pickMode.cursor = Math.max(0, pickMode.cursor - 1);
        else if (e.key === 'ArrowDown') pickMode.cursor += cols;
        else if (e.key === 'ArrowUp') pickMode.cursor = Math.max(0, pickMode.cursor - cols);
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitPick(Math.max(0, pickMode.cursor)); return; }
        else return;
        e.preventDefault();
        e.stopPropagation();
        updatePickCursor();
      }
      function pickClick(e, node) {
        e.preventDefault();
        e.stopPropagation();
        if (node && node._parentKey === pickMode.parentKey && Number.isFinite(node._slot)) {
          commitPick(node._slot);
          return;
        }
        const target = computeTarget(e.clientX, e.clientY, pickMode.parentKey, pickMode.stepKey, pickMode.sources.map(function (s) { return s.node; }));
        if (target.type === 'slot') commitPick(target.slot);
        else if (target.type !== 'none') exitPickPlace();
      }
      function enterPickPlace(sources) {
        if (destroyed || !active) return false;
        const movable = (sources || []).filter(movableNode);
        if (!movable.length || pickMode || drag) return false;
        selected.clear();
        lastSelectedId = '';
        paintSelection();
        pickMode = {
          sources: movable.map(function (n) { return { node: n }; }),
          parentKey: movable[0]._parentKey || 'root',
          stepKey: nodeStepKey(movable[0], itemOfNode(movable[0])),
          cursor: Number.isFinite(movable[0]._slot) ? movable[0]._slot : 0,
        };
        movable.forEach(function (n) {
          const card = cards.get(idOf(n));
          if (card) card.box.classList.add('is-drag-source');
        });
        pickBanner.textContent = '移动位置：点击目标格放置 · 方向键选格 · Enter 确认 · Esc 取消';
        pickBanner.hidden = false;
        document.body.appendChild(pickBanner);
        bind(document, 'keydown', pickKeydown, true);
        updatePickCursor();
        return true;
      }
      function exitPickPlace() {
        if (!pickMode) return;
        pickMode = null;
        pickBanner.remove();
        if (dropCell) dropCell.hidden = true;
        unbind(document, 'keydown', pickKeydown, true);
        for (const card of cards.values()) card.box.classList.remove('is-drag-source');
        dragGuardUntil = Date.now() + 350;
      }
      bind(scroll, 'pointerdown', function (e) {
        if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
        if (e.button !== 0 || pickMode) return;
        const cardEl = e.target && e.target.closest ? e.target.closest('.overview-card') : null;
        if (!cardEl) return;
        if (e.target.closest && e.target.closest('button, input, textarea, [contenteditable]')) return;
        const node = findNode(cardEl.dataset.entryId);
        if (!node || !movableNode(node)) return;
        const r = cardEl.getBoundingClientRect();
        dragPending = {
          pointerId: e.pointerId, x: e.clientX, y: e.clientY,
          gx: e.clientX - r.left, gy: e.clientY - r.top, node: node,
        };
      });
      bind(window, 'pointermove', function (e) {
        if (drag) {
          lastPointer = { x: e.clientX, y: e.clientY };
          // 预览直接贴鼠标（零延迟）；目标格计算/让位动画走 RAF
          previewBox.style.transform = 'translate(' + Math.round(e.clientX - drag.grabDX) + 'px,' + Math.round(e.clientY - drag.grabDY) + 'px)';
          if (!moveRAF) moveRAF = raf(function () {
            moveRAF = 0;
            if (drag) updateDrag(lastPointer.x, lastPointer.y);
          });
          return;
        }
        if (!dragPending || e.pointerId !== dragPending.pointerId) return;
        if (Math.abs(e.clientX - dragPending.x) < 6 && Math.abs(e.clientY - dragPending.y) < 6) return;
        const pending = dragPending;
        dragPending = null;
        startDrag(pending, e);
      });
      bind(window, 'pointerup', function (e) {
        dragPending = null;
        if (drag && e.pointerId === drag.pointerId) {
          // 最后一次 pointermove 的 RAF 可能尚未执行，松手以当前指针坐标重新判定。
          updateDrag(e.clientX, e.clientY);
          endDrag(true);
        }
      });
      bind(window, 'pointercancel', function (e) {
        dragPending = null;
        if (drag && e.pointerId === drag.pointerId) endDrag(false);
      });
      bind(window, 'blur', function () {
        dragPending = null;
        if (drag) endDrag(false);
      });
      function stopDrawing() { sharedRenderer.stop(owner); }
      function disposeViewer() {
        if (ownerRetained) { ownerRetained = false; sharedRenderer.release(owner); }
      }
      async function capture(v, valid) {
        if (!valid()) return null;
        const helper = v.plugin.helpers.viewportScreenshot;
        if (!helper || typeof helper.getPreview !== 'function') throw Error('缩略图截图接口不可用');
        helper.behaviors.values.next({ ...helper.values, resolution: { name: 'custom', params: { width: W, height: H } }, axes: { name: 'off', params: {} } });
        // Use Mol* preview image pass (no high-quality screenshot multisampling).
        const preview = await helper.getPreview({ shouldUpdate: false, isSynchronous: true, update: async () => {} }, W);
        if (!valid()) return null;
        if (!preview) throw Error('缩略图渲染未返回图像');
        if (!thumbnailHasContent(preview.canvas)) throw Error('缩略图尚未画出结构');
        return new Promise((resolve, reject) => preview.canvas.toBlob(b => b ? resolve(b) : reject(Error('图片编码失败')), 'image/webp', .8));
      }
      async function prepareCapture(v, task, valid) {
        if (!valid()) return;
        const c3d = v.plugin.canvas3d || v.plugin.canvas;
        if (!c3d) throw Error('缩略图渲染器尚未就绪');
        v.handleResize();
        c3d.commit(true);
        // reset() 本身只排队；即时复位后必须再 commit 才会应用到截图相机。
        await hooks.resetCamera(v, 0, task.config, task.node);
        if (!valid()) return;
        c3d.commit(true);
        let frames = 0;
        while (valid() && c3d.camera && c3d.camera.transition && c3d.camera.transition.inTransition) {
          if (++frames > 90) throw Error('缩略图相机尚未就绪');
          await nextFrame();
        }
      }
      async function pump() {
        if (busy || !canRun() || !queue.length) return;
        if (sharedRenderer.interactionDelay() > 0) { schedulePump(); return; }
        const task = queue.shift();
        if (!task || task.epoch !== epoch) { schedulePump(); return; }
        const tEntry = task.node && entryOf(task.node);
        if (!tEntry || !wantsCover(task.node)) { schedulePump(); return; }
        if (cache.has(task.key) || completed.has(task.key)) {
          const card = cards.get(idOf(task.node));
          if (card && card.key === task.key) paintCard(card, card.node);
          updateStatus(activeLayout ? activeLayout.nodes : viewNodes());
          schedulePump(); return;
        }
        const valid = function () { return canRun() && task.epoch === epoch && task.viewRevision === viewRevision && sharedRenderer.interactionDelay() === 0 && keyFor(task.node, task.config) === task.key; };
        busy = true; runningKey = task.key; updateStatus(activeLayout ? activeLayout.nodes : viewNodes()); const start = performance.now();
        let generated = false;
        try {
          const disk = sharedRenderer.recall(task.key) || await idbGet(task.key, task.epoch);
          if (!valid()) { stats.discarded++; return; }
          if (disk && !cache.has(task.key)) cacheImage(task.key, disk, false, task.epoch);
          if (cache.has(task.key)) {
            completed.add(task.key);
            const hit = cards.get(idOf(task.node));
            if (hit && hit.key === task.key) paintCard(hit, hit.node);
            return;
          }
          ensureOwner();
          const blob = await sharedRenderer.run(owner, hooks.createViewer, valid, async function (v, leased) {
            generated = true;
            await hooks.clearViewer(v, task.config, task.node);
            if (!leased()) return null;
            const ref = await hooks.loadEntryInto(v, tEntry, task.config, task.node, leased);
            if (!leased()) return null;
            // Yield at async boundaries when the user scrolls or changes the view.
            await hooks.prepare(v, tEntry, ref, task.config, task.node);
            for (let attempt = 0; attempt < 3 && leased(); attempt++) {
              await prepareCapture(v, task, leased);
              if (!leased()) return null;
              await nextFrame();
              if (!leased()) return null;
              try { return await capture(v, leased); }
              catch (error) {
                if (!leased()) return null;
                if (attempt === 2) throw error;
                await nextFrame();
              }
            }
            return null;
          }, task.key, task.visible ? 0 : 1);
          if (!blob || !valid()) { stats.discarded++; return; }
          cacheImage(task.key, blob, generated, task.epoch); completed.add(task.key);
          if (generated) { stats.generated++; rendered++; totalMs += performance.now() - start; }
          else stats.sharedHits++;
          const card = cards.get(idOf(task.node));
          if (card && card.key === task.key) paintCard(card, card.node);
        } catch (error) {
          if (valid()) {
            stats.errors++; failures.set(task.key, String(error.message || error));
            if (failures.size > 128) failures.delete(failures.keys().next().value);
            const card = cards.get(idOf(task.node)); if (card) paintCard(card, card.node);
            console.warn('[StructBoard] thumbnail', tEntry.name, error);
          }
        } finally {
          // The manager alone stops/releases a renderer lease. Another owner may
          // already be rendering when this instance's promise continuation runs.
          busy = false; runningKey = '';
          if (valid() && wantsCover(task.node)) {
            const currentKey = keyFor(task.node, task.config);
            if (currentKey && currentKey !== task.key && !cache.has(currentKey) && !completed.has(currentKey) && !failures.has(currentKey)) {
              queue = queue.filter(function (pending) { return pending.key !== task.key && pending.key !== currentKey; });
              queue.unshift(Object.assign({}, task, { key: currentKey }));
              const changedCard = cards.get(idOf(task.node));
              if (changedCard) paintCard(changedCard, changedCard.node);
            }
          }
          if (!active || !list.length) disposeViewer();
          if (destroyed) { syncStats([]); return; }
          updateStatus(activeLayout ? activeLayout.nodes : viewNodes());
          if (canRun()) scheduleVisibleFill();
        }
      }
      function capturePlace() {
        return { scroll: scroll.scrollTop, drillId: drill ? drill.id : null, drillScroll: drillScroll, drillStack: drillStack.map(x => ({ id: x.id, returnScroll: x.returnScroll })) };
      }
      function restore(place) {
        if (destroyed || !place) return;
        drillScroll = place.drillScroll || 0;
        if (place.drillId) {
          const node = window.SB_LINEAGE.find(list, place.drillId) || findNode(place.drillId);
          drillStack = (place.drillStack || []).map(x => {
            const p = window.SB_LINEAGE.find(list, x.id) || findNode(x.id);
            return p ? Object.assign({}, p, { returnScroll: x.returnScroll }) : null;
          }).filter(Boolean);
          if (node) { drill = node; newEpoch(); }
          else { drill = null; drillStack = []; }
        } else {
          drill = null;
          drillStack = [];
        }
        setDrillUI();
        invalidateLayout();
        spacer.style.height = scrollExtent(ensureLayout(), scroll.clientHeight) + 'px';
        scroll.scrollTop = place.scroll || 0;
        renderWindow();
      }
      function playDrillAnimation() {
        layer.classList.remove('is-animating');
        void layer.offsetWidth;
        layer.classList.add('is-animating');
      }
      function openFolder(node) {
        if (destroyed || !node || node.kind !== 'folder') return;
        if (drill && drill.id === node.id) return;
        if (drill) drillStack.push(Object.assign({}, drill, { returnScroll: drillScroll }));
        drillScroll = scroll.scrollTop;
        drill = node; newEpoch(); scroll.scrollTop = 0;
        drillGuardUntil = Date.now() + 550;
        setDrillUI(); renderWindow(); playDrillAnimation();
        if (hooks.onViewChange) hooks.onViewChange('drill');
      }
      function back() {
        if (destroyed || !drill) return false;
        const returnScroll = drillScroll;
        const parent = drillStack.pop();
        drill = parent || null; newEpoch();
        drillScroll = parent ? parent.returnScroll || 0 : 0;
        drillGuardUntil = Date.now() + 550;
        setDrillUI();
        spacer.style.height = scrollExtent(ensureLayout(), scroll.clientHeight) + 'px';
        scroll.scrollTop = returnScroll || 0;
        renderWindow(); playDrillAnimation();
        if (hooks.onViewChange) hooks.onViewChange('drill');
        return true;
      }
      function refresh(nodes, resetScroll, title) {
        if (destroyed) return;
        newEpoch(); active = true; list = nodes.slice(); ensureOwner();
        if (resetScroll) {
          drill = null;
          drillStack = [];
          drillScroll = 0;
        } else if (drill) {
          const same = window.SB_LINEAGE.find(list, drill.id);
          drill = same || null;
          if (!drill) drillScroll = 0;
        }
        baseTitle = title || ('结构总览 · ' + coverage(list).covered + ' 个');
        // 审计结果按「文件夹 + 数据/表格指纹」缓存，节点消失后自然不再被引用；
        // 这里只清理待算队列，避免目录切换后仍去算已不存在的文件夹。
        const alive = new Set();
        for (const n of list) if (n.kind === 'folder') alive.add(n.id);
        for (const [k, job] of Array.from(pendingAudit)) if (!alive.has(job.id)) pendingAudit.delete(k);
        if (resetScroll) scroll.scrollTop = 0;
        setLite(savedLite(), false);
        setDrillUI();
        renderWindow();
        buildMinimapTicks();
      }
      function leave() {
        if (destroyed) return;
        if (drag) endDrag(false); if (pickMode) exitPickPlace(); dragPending = null;
        flushNoteEdits(); newEpoch(); active = false; failures.clear(); cancelScheduled(); disposeViewer();
        drill = null; drillStack = []; drillScroll = 0; setDrillUI();
        for (const card of [...cards.values(), ...entryCardPool]) {card.image.removeAttribute('src');if(card.box.__disposeView)card.box.__disposeView();} cards.clear();
        entryCardPool.length = 0;
        for (const box of sections.values()) {if(box.__disposeView)box.__disposeView();box.remove();} sections.clear();
        layer.replaceChildren(); placed.clear(); activeLayout = null;
        if (dropCell) dropCell.remove(); if (dropHint) dropHint.remove(); dropCell = dropHint = null;
        previewBox.replaceChildren(); previewBox.remove(); pickBanner.remove();
        minimap.hidden = true; mmBubble.hidden = true; mmPill.hidden = true;
        mmTicks.replaceChildren(); mmTickMeta = [];
        layer.classList.remove('is-animating'); spacer.style.height = '0px';
        updateStatus(list);
      }
      function clear() {
        if (destroyed) return;
        leave(); for (const key of Array.from(cache.keys())) release(key); failures.clear(); list = []; paused = false;
        auditResults.clear(); pendingAudit.clear(); selected.clear(); openNotes.clear(); lastSelectedId = '';
        updateStatus(list);
      }
      function destroy() {
        if (destroyed) return;
        clear(); destroyed = true; epoch++; renderConfigs.clear(); completed.clear(); queue = [];
        cancelThumbIO(); disposeViewer(); disconnectResources();
        for (const item of controlHandlers) { if (item.node.onclick === item.handler) item.node.onclick = item.previous; }
        controlHandlers.length = 0;
        if (dbConnection && !dbClosed) {
          dbClosed = true; try { if (dbConnection.close) dbConnection.close(); } catch (_) {}
        }
        dbConnection = null;
        minimap.remove(); previewBox.remove(); pickBanner.remove();
        stats.destroyed = true; syncStats([]);
      }
      function mark(entry) {
        for (const card of cards.values()) {
          const n = card.node; if (!n || n.kind === 'localfile') continue;
          if (n.kind === 'entry' ? n.entry === entry : n.entries.includes(entry)) paintCard(card, n);
        }
      }
      const controlHandlers = [];
      function controlClick(node, handler) {
        if (!node) return;
        const wrapped = function (event) { if (!destroyed) return handler(event); };
        controlHandlers.push({ node: node, handler: wrapped, previous: node.onclick || null }); node.onclick = wrapped;
      }
      controlClick($('btnOverviewPause'), function () {
        paused = !paused;
        if (paused) newEpoch();
        else renderWindow({ fill: true });
        updateStatus(viewNodes());
      });
      controlClick($('btnOverviewLite'), function () { setLite(!lite, true); renderWindow(); updateStatus(viewNodes()); });
      controlClick($('btnOverviewBack'), function () { back(); });
      bind(scroll, 'click', function (e) {
        if (pickMode) { pickClick(e, null); return; }
        if (e.target && e.target.closest && e.target.closest('.overview-card, .overview-section, button, input, textarea')) return;
        selected.clear(); lastSelectedId = '';
        paintSelection();
      });
      bind(scroll, 'contextmenu', function (e) {
        if (e.target && e.target.closest && e.target.closest('.overview-card, .overview-section, textarea')) return;
        e.preventDefault();
        if (hooks.onContext) hooks.onContext({ node: drill, selected: selectionIds(), x: e.clientX, y: e.clientY, blank: true });
      });
      bind(scroll, 'scroll', scrolled, { passive: true });
      bind(scroll, 'wheel', function () {
        if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
      }, { passive: true });
      bind(window, 'resize', scheduleWindow);
      bind(document, 'visibilitychange', function () {
        if (destroyed) return;
        if (!document.hidden) renderWindow({ fill: true });
        else newEpoch();
      });
      if (window.ResizeObserver) {
        const observer = new ResizeObserver(scheduleWindow); observers.push(observer); observer.observe(scroll);
      }
      // 封面/气泡用的格式名：识别 .pdb/.cif 等真后缀（忽略 .gz）
      function fmtOf(name) {
        const m = /\.(pdb|ent|cif|mmcif|mcif|bcif)(\.gz)?$/i.exec(name || '');
        return m ? m[1].toUpperCase() : '';
      }
      // 方案 A：ZCode 式刻度滚动条（minimap）。内容密度画成一排短横线，步骤节是长刻度，
      // 胶囊标出顶部当前步骤，点刻度精确跳转，拖动按相同内容坐标移动。
      const minimap = document.createElement('div');
      minimap.className = 'ov-minimap'; minimap.hidden = true;
      const mmTicks = document.createElement('div'); mmTicks.className = 'ov-minimap-ticks';
      const mmPill = document.createElement('div'); mmPill.className = 'ov-mm-pill'; mmPill.hidden = true;
      const mmBubble = document.createElement('div'); mmBubble.className = 'ov-mm-bubble'; mmBubble.hidden = true;
      minimap.appendChild(mmTicks); minimap.appendChild(mmPill); minimap.appendChild(mmBubble);
      scroll.parentElement.appendChild(minimap);
      let mmFrame = 0, mmAnim = 0;
      let mmTickMeta = []; // { y: 内容坐标, mapY: 刻度条上的像素位置 }
      function buildMinimapTicks() {
        if (destroyed || !active) return;
        const lay = ensureLayout(), height = scroll.clientHeight, top = scroll.offsetTop;
        if (minimapLayout === lay && minimapHeight === height && minimapTop === top) return;
        minimapLayout = lay; minimapHeight = height; minimapTop = top;
        if (!lay.items.length) { minimap.hidden = true; return; }
        minimap.hidden = false;
        minimap.style.top = top + 'px';
        minimap.style.height = height + 'px';
        const H = Math.max(1, scrollExtent(lay, height));
        const mapH = Math.max(1, minimap.clientHeight);
        const sections = [];
        const rows = []; // { top, entries: [entry] } —— 一行卡片共用一个 top
        let curRow = null, lastTop = -1;
        for (const it of lay.items) {
          if (it.node.kind === 'section') { sections.push({ top: it.top, node: it.node }); curRow = null; }
          else if (it.node.kind === 'entry' && it.node.entry) {
            if (it.top !== lastTop) { lastTop = it.top; curRow = { top: it.top, entries: [] }; rows.push(curRow); }
            curRow.entries.push(it.node.entry);
          } else curRow = null;
        }
        const maxRows = Math.max(1, Math.floor((mapH - sections.length * 4) / 3));
        const stepK = Math.max(1, Math.ceil(rows.length / maxRows));
        mmTickMeta = [];
        for (let i = 0; i < rows.length; i += stepK) {
          const covered = rows.slice(i, i + stepK);
          const first = covered[0].entries[0] || null;
          let count = 0, stars = 0;
          for (const r of covered) for (const e of r.entries) { count++; if (e.star) stars++; }
          const mapY = (covered[0].top / H * mapH).toFixed(1);
          mmTickMeta.push({ y: covered[0].top, mapY: parseFloat(mapY), kind: 'row',
            firstName: first ? first.name : '', count: count,
            stepTitle: first ? (first.stepTitle || '') : '',
            fmt: first ? fmtOf(first.name) : '', stars: stars });
        }
        for (const sec of sections) {
          const mapY = (sec.top / H * mapH).toFixed(1);
          mmTickMeta.push({ y: sec.top, mapY: parseFloat(mapY), kind: 'section',
            title: sec.node.title || '', tool: sec.node.tool || '',
            countText: sec.node.countText || (sec.node.count + ' 份结构'),
            note: sec.node.note || '', stepKey: sec.node.stepKey || '' });
        }
        mmTickMeta.sort(function (a, b) { return a.mapY - b.mapY; });
        mmTicks.innerHTML = mmTickMeta.map(function (tick, index) {
          return '<i class="ov-mm-tick' + (tick.kind === 'section' ? ' ov-mm-section' : '')
            + '" data-mm-index="' + index + '" style="transform:translateY(' + tick.mapY + 'px)"></i>';
        }).join('');
        mmTicks.querySelectorAll('.ov-mm-section').forEach(function (element) {
          const tick = mmTickMeta[Number(element.dataset.mmIndex)];
          element.dataset.stepKey = tick.stepKey;
          element.setAttribute('aria-label', tick.title);
        });
        updateMinimapPill();
      }
      function updateMinimapPill() {
        if (destroyed || !active || minimap.hidden) return;
        if (!mmTickMeta.length) { mmPill.hidden = true; return; }
        mmPill.hidden = false;
        // Use the same section boundary as the sticky title, not the viewport center.
        const layout = ensureLayout(), current = layout.headers[sectionIndexAt(layout, scroll.scrollTop)];
        let tick = current && mmTickMeta.find(function (t) { return t.kind === 'section' && t.stepKey === current.node.stepKey; });
        if (!tick) {
          tick = mmTickMeta[0];
          for (const t of mmTickMeta) { if (t.y <= scroll.scrollTop + 1) tick = t; else break; }
        }
        mmPill.dataset.stepKey = tick.stepKey || '';
        mmPill.style.transform = 'translateY(' + (tick.mapY - 7).toFixed(1) + 'px)';
      }
      function mmSmoothTo(target) {
        if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
        target = Math.max(0, Math.min(Math.ceil(target), scroll.scrollHeight - scroll.clientHeight));
        const from = scroll.scrollTop, delta = target - from;
        if (Math.abs(delta) < 3 || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
          scroll.scrollTop = Math.max(0, target); updateMinimapPill(); return;
        }
        const t0 = performance.now(), dur = 240;
        const step = function (t) {
          const p = Math.min(1, (t - t0) / dur);
          const e = 1 - Math.pow(1 - p, 3);
          scroll.scrollTop = from + delta * e;
          updateMinimapPill();
          if (p < 1) mmAnim = raf(step); else mmAnim = 0;
        };
        mmAnim = raf(step);
      }
      function nearestMinimapTick(ev) {
        const hit = ev.target && ev.target.closest && ev.target.closest('[data-mm-index]');
        if (hit && mmTicks.contains(hit)) return mmTickMeta[Number(hit.dataset.mmIndex)] || null;
        const y = ev.clientY - minimap.getBoundingClientRect().top;
        let best = null, distance = 9;
        for (const tick of mmTickMeta) {
          const delta = Math.abs(tick.mapY - y);
          if (delta < distance) { best = tick; distance = delta; }
        }
        return best;
      }
      function mmTargetFromEvent(ev, snap) {
        const tick = snap && nearestMinimapTick(ev);
        if (tick) return tick.y;
        const rect = minimap.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
        return Math.min(ratio * scrollExtent(ensureLayout(), scroll.clientHeight), Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      }
      bind(minimap, 'wheel', function (e) {
        // 悬停在刻度条上滚滚轮 = 直接滚内容，手不用挪到右侧滚动条
        e.preventDefault();
        if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
        scroll.scrollTop += e.deltaY;
        updateMinimapPill();
      }, { passive: false });
      bind(minimap, 'pointerdown', function (e) {
        if (gestureCleanup) gestureCleanup();
        e.preventDefault();
        try { minimap.setPointerCapture(e.pointerId); } catch (_) {}
        mmSmoothTo(mmTargetFromEvent(e, true));
        const move = function (ev) {
          if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
          scroll.scrollTop = mmTargetFromEvent(ev);
          updateMinimapPill();
        };
        const up = function () {
          unbind(minimap, 'pointermove', move);
          unbind(minimap, 'pointerup', up);
          unbind(minimap, 'pointercancel', up);
          try { minimap.releasePointerCapture(e.pointerId); } catch (_) {}
          if (gestureCleanup === up) gestureCleanup = null;
        };
        gestureCleanup = up;
        bind(minimap, 'pointermove', move);
        bind(minimap, 'pointerup', up);
        bind(minimap, 'pointercancel', up);
      });
      function showBubble(t) {
        mmBubble.textContent = '';
        const title = document.createElement('div'); title.className = 'ov-bub-title';
        const meta = document.createElement('div'); meta.className = 'ov-bub-meta';
        if (t.kind === 'section') {
          title.textContent = t.title || t.stepKey || '步骤';
          const tag = document.createElement('span'); tag.className = 'ov-bub-tag'; tag.textContent = t.tool || '步骤';
          const cnt = document.createElement('span'); cnt.textContent = t.countText;
          meta.append(tag, cnt);
          mmBubble.append(title, meta);
          if (t.note) { const note = document.createElement('div'); note.className = 'ov-bub-note'; note.textContent = t.note; mmBubble.append(note); }
        } else {
          title.textContent = t.count > 1 ? (t.firstName + ' 等 ' + t.count + ' 条') : t.firstName;
          if (t.stepTitle) { const st = document.createElement('span'); st.textContent = t.stepTitle; meta.append(st); }
          if (t.fmt) { const f = document.createElement('span'); f.textContent = t.fmt; meta.append(f); }
          if (t.stars) { const st = document.createElement('span'); st.className = 'ov-bub-star'; st.textContent = '★ ' + t.stars; meta.append(st); }
          mmBubble.append(title, meta);
        }
        const mapH = Math.max(1, minimap.clientHeight);
        mmBubble.style.top = Math.max(2, Math.min(mapH - 46, t.mapY - 10)) + 'px';
        mmBubble.hidden = false;
      }
      bind(minimap, 'pointermove', function (e) {
        if (e.buttons) { mmBubble.hidden = true; return; }
        const best = nearestMinimapTick(e);
        if (best) showBubble(best); else mmBubble.hidden = true;
      });
      bind(minimap, 'pointerleave', function () { mmBubble.hidden = true; });
      if (window.ResizeObserver) {
        const observer = new ResizeObserver(function () { scheduleWindow(); }); observers.push(observer); observer.observe(scroll);
      }
      // 方案 A：流程地图跳转——把总览滚到某一步的 section 头部。
      // 虚拟化下盒子可能还没创建：先用布局算 y 滚过去，窗口渲染出盒子后再高亮。
      function scrollToStep(stepKey) {
        if (destroyed || !active || !stepKey) return false;
        const flash = function () {
          for (const box of sections.values()) {
            if (box.dataset && box.dataset.stepKey === stepKey) {
              box.classList.remove('is-jump-flash');
              void box.offsetWidth;
              box.classList.add('is-jump-flash');
              later(() => box.classList.remove('is-jump-flash'), 1400);
              return true;
            }
          }
          return false;
        };
        // 吸顶后的 DOM 位置不再是步骤起点，跳转始终以原布局为准。
        const hit = ensureLayout().headers.find(function (it) {
          return it.node.stepKey === stepKey;
        });
        if (!hit) return false;
        if (mmAnim) cancelRaf(mmAnim), mmAnim = 0;
        scroll.scrollTop = Math.max(0, Math.ceil(hit.top));
        scheduleWindow();
        later(flash, 140);
        return true;
      }
      function findNode(id) {
        function walk(nodes) {
          for (const n of nodes || []) {
            if (idOf(n) === id) return n;
            if (n.kind === 'folder') {
              const hit = walk(n.children || []);
              if (hit) return hit;
            }
          }
          return null;
        }
        return walk(viewNodes()) || walk(list);
      }
      return { refresh, renderWindow, leave, clear, destroy, mark, openFolder, back, jumpTo, capture: capturePlace, restore, stats,
        scrollToStep,
        setSearch: setSearch,
        searchStats: searchStats,
        nodeMatches: nodeMatches,
        paintNoteStates: paintNoteStates,
        flushNoteEdits: flushNoteEdits,
        selection: selectionIds,
        current: function () { return drill; },
        nodes: viewNodes,
        findNode: findNode,
        enterPickPlace: enterPickPlace,
        get viewer() { return destroyed ? null : sharedRenderer.viewerFor(owner); },
        get drill() { return drill; } };
    }
  };
})(window);
