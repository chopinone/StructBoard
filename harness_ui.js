/* StructBoard harness UI. Activity comes only from SB_HARNESS job snapshots. */
(function () {
  'use strict';
  if (window.__SB_HARNESS_UI_LOADED__) return;
  window.__SB_HARNESS_UI_LOADED__ = true;

  function init() {
    const button = document.getElementById('btnHarnessConnection');
    const indicator = document.getElementById('harnessIndicator');
    const halo = document.getElementById('harnessHalo');
    const live = document.getElementById('harnessLiveStatus');
    const activity = document.getElementById('harnessActivityLabel');
    const shortActivity = document.getElementById('harnessActivityShort');
    if (!button || !indicator || !halo || !live || !activity) return;

    let bridge = null, unsubscribe = null, stateVersion = 0, refreshSerial = 0;
    let status = { state: 'offline', enabled: false, connected: false, sessions: [], running: [], approvals: [] };
    let connectorInfo = null;
    let localError = '', pairing = null, pairingVersion = 0, pairTimer = 0, doneTimer = 0, doneUntil = 0;
    let pairBusy = false, stopBusy = false, refreshBusy = false, closed = false;
    const requests = new Map(), settled = new Set(), sessionRows = new Map();
    const scopeLabels = { read: '读取', view: '视图', edit: '编辑' };

    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    }
    function action(id, text, primary) {
      const element = node('button', 'harness-action' + (primary ? ' harness-primary' : ''), text);
      element.id = id;
      element.type = 'button';
      return element;
    }
    function literal(value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2) || '—'; } catch (_) { return '无法显示此值'; }
    }
    function timestamp(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
      return typeof value === 'string' ? Date.parse(value) : NaN;
    }
    function sourceName(source, builtin) {
      return builtin || (source && source.name === 'builtin') ? '内置助手' :
        (source && typeof source.name === 'string' && source.name ? source.name : '外部助手');
    }
    function keyOf(approval) {
      return approval && typeof approval.requestId === 'string' && approval.requestId &&
        typeof approval.diffHash === 'string' && approval.diffHash ?
        JSON.stringify([approval.requestId, approval.diffHash]) : null;
    }
    function preciseDiff(approval) {
      const diff = approval && approval.diff;
      return !!(keyOf(approval) && diff && typeof diff.summary === 'string' && diff.summary.trim() &&
        Array.isArray(diff.changes) && diff.changes.length && diff.changes.every(function (change) {
          return change && typeof change.target === 'string' && change.target &&
            typeof change.kind === 'string' && change.kind;
        }));
    }
    function desktop() {
      return document.documentElement.dataset.desktop === 'tauri' || typeof window.__SB_DESKTOP_INVOKE__ === 'function';
    }
    function checkResult(result) {
      if (result && result.ok === false) throw new Error('Harness request failed');
      return result;
    }
    function pendingRequests() {
      return Array.from(requests.values()).filter(function (record) { return !record.expired; });
    }

    const {box:panel,title, closeButton, desktopStatus, refreshButton, stopButton, errorBox, remember, pairButton, pairBox, pairCode, pairExpiry, copyConfigButton, copyButton, pairMessage, sessionsList, sessionsEmpty, runningList, requestList, requestsEmpty, clientsSection, clientsList, clientMessage}=window.SB_UI.createSurface('harnessPanel');
    const scopeInputs={read:panel.querySelector('#harnessScopeRead'),view:panel.querySelector('#harnessScopeView'),edit:panel.querySelector('#harnessScopeEdit')};
    const clientRows = new Map();
    let setupBusy = false;
    ['codex', 'workbuddy', 'claude', 'zcode', 'antigravity'].forEach(function (id, index) {
      const row = node('div', 'harness-client');
      const text = node('div', 'harness-session-text');
      const name = node('strong', '', ['Codex', 'WorkBuddy', 'Claude Code', 'ZCode', 'Antigravity'][index]);
      const detail = node('span', 'harness-muted', '点击连接灯后检查配置');
      const add = action('btnClientSetup-' + id, '添加');
      text.append(name, detail); row.append(text, add); clientsList.append(row);
      clientRows.set(id, { row: row, detail: detail, button: add });
      add.addEventListener('click', async function () {
        if (!bridge || setupBusy || typeof bridge.registerClient !== 'function') return;
        setupBusy = true;
        clientRows.forEach(function (item) { item.button.disabled = true; });
        clientMessage.textContent = '正在添加 ' + name.textContent + '…';
        try {
          const selected = ['read'];
          if (scopeInputs.view.checked) selected.push('view');
          if (scopeInputs.edit.checked) selected.push('edit');
          const result = await bridge.registerClient(id, selected);
          if (!result || result.ok !== true) throw new Error(result && result.error && result.error.message || '添加失败，请检查配置文件权限。');
          clientMessage.textContent = name.textContent + '：' + result.message;
          await refreshClients();
        } catch (failure) { clientMessage.textContent = failure.message || '添加失败，原配置已保留。'; }
        finally { setupBusy = false; clientRows.forEach(function (item) { item.button.disabled = false; }); }
      });
    });
    document.body.append(panel);

    function positionPanel() {
      if (panel.hidden) return;
      const rect = button.getBoundingClientRect();
      const width = Math.min(420, Math.max(0, window.innerWidth - 24));
      const top = Math.max(8, Math.min(rect.bottom + 10, window.innerHeight - 100));
      panel.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
      panel.style.top = top + 'px';
      panel.style.maxHeight = Math.max(60, window.innerHeight - top - 12) + 'px';
    }
    function openPanel(focusTarget) {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      positionPanel();
      (focusTarget || title).focus({ preventScroll: true });
      refreshClients();
    }
    async function refreshClients() {
      clientsSection.hidden = !desktop() || !bridge || typeof bridge.listClients !== 'function';
      if (clientsSection.hidden) return;
      try {
        const result = await bridge.listClients();
        if (!result || !result.ok || !Array.isArray(result.clients)) return;
        result.clients.forEach(function (client) {
          const item = clientRows.get(client.id); if (!item) return;
          item.detail.textContent = client.message;
          item.row.title = client.configPath;
          item.button.textContent = client.authorized ? '检查 / 更新' : client.configured ? '修复授权' : '添加';
          item.button.disabled = setupBusy || !!client.error;
        });
      } catch (_) { clientMessage.textContent = '暂时无法检查客户端配置，请刷新状态。'; }
    }
    function closePanel(restoreFocus) {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) button.focus({ preventScroll: true });
    }
    function focusAfterRemoval(element) {
      if (!panel.hidden && element.contains(document.activeElement)) title.focus({ preventScroll: true });
    }
    function renderErrors() {
      errorBox.textContent = localError || (status.error ? '助手连接异常，请刷新状态后重试。' : '');
      errorBox.hidden = !errorBox.textContent;
    }
    function sessionName(session) {
      return session && typeof session.name === 'string' && session.name && !/^MCP connector$/i.test(session.name)
        ? session.name : '未命名客户端';
    }
    function onlineSessions() {
      return status.sessions.filter(function (session) { return session && session.connected && !session.revoked; });
    }
    function renderControls() {
      const online = onlineSessions();
      desktopStatus.textContent = !bridge ? '连接组件尚未就绪。' : !desktop() ?
        '浏览器模式；外部助手连接需在桌面版启用。' :
        online.length ? '当前连接 · ' + online.map(sessionName).join('、') :
          '桌面连接：' + (status.enabled ? '已启用' : '未启用') + ' · ' + (status.connected ? '已连接 · 未命名客户端' : '暂无助手连接');
      pairButton.disabled = !bridge || !desktop() || pairBusy || stopBusy;
      copyConfigButton.hidden = !connectorInfo;
      pairButton.textContent = pairBusy ? '正在生成…' : '生成配对码';
      refreshButton.disabled = !bridge || refreshBusy;
      refreshButton.textContent = refreshBusy ? '正在刷新…' : '刷新状态';
      stopButton.disabled = !bridge || stopBusy || (!status.enabled && !status.running.length && !pendingRequests().length &&
        !status.sessions.some(function (session) { return !session.revoked; }));
      stopButton.textContent = stopBusy ? '正在停止…' : '全部停止';
      scopeInputs.view.disabled = pairBusy;
      scopeInputs.edit.disabled = pairBusy;
      remember.disabled = pairBusy;
      renderErrors();
    }
    function renderActivity() {
      const running = status.running.length > 0;
      const approvals = pendingRequests().length;
      const state = approvals ? 'approval' : running ? 'running' : status.state === 'error' || status.error ? 'error' :
        status.state === 'done' && Date.now() < doneUntil ? 'done' : status.connected ? 'connected' : 'offline';
      const labels = { offline: '未连接', connected: '已连接', running: '执行中', approval: '等待确认', done: '已完成', error: '连接异常' };
      const online = onlineSessions();
      const who = online.length === 1 ? sessionName(online[0]) : online.length ? online.length + ' 个助手' : '';
      const visibleState = state === 'done' && status.connected ? '已连接' : labels[state];
      let description = '外部助手连接：' + visibleState;
      if (online.length) description += ' · ' + online.map(sessionName).join('、');
      if (running) description += '；' + status.running.length + ' 个工具正在执行';
      if (approvals) description += '；' + approvals + ' 个请求等待确认';
      indicator.dataset.state = state;
      indicator.dataset.connected = String(status.connected);
      button.dataset.state = state;
      button.setAttribute('aria-busy', String(running));
      button.title = description;
      activity.textContent = who ? who + ' ' + visibleState : visibleState;
      if (shortActivity) shortActivity.textContent = visibleState;
      if (live.textContent !== description) live.textContent = description;
      const haloState = status.error || state === 'error' ? 'offline' : running ? 'running' : status.connected ? 'connected' : 'offline';
      halo.dataset.state = haloState;
      halo.dataset.active = String(haloState !== 'offline');
      requestsEmpty.hidden = !!(running || requests.size);
      renderControls();
    }
    function renderRunning() {
      runningList.replaceChildren();
      status.running.forEach(function (request) {
        runningList.append(node('li', '', sourceName(request.source, false) + ' · ' + literal(request.tool) + ' · 执行中'));
      });
    }
    function clearPairing(message) {
      pairingVersion++;
      window.clearInterval(pairTimer);
      pairTimer = 0;
      pairing = null;
      pairCode.textContent = '';
      pairExpiry.textContent = '';
      pairMessage.textContent = message || '';
      pairBox.hidden = !message;
      copyButton.disabled = true;
      copyConfigButton.disabled = true;
    }
    function tickPairing() {
      if (!pairing) return;
      const remaining = Math.ceil((pairing.expiresAt - Date.now()) / 1000);
      if (remaining <= 0) { clearPairing('配对码已过期，请重新生成。'); return; }
      pairExpiry.textContent = '剩余 ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
    }
    function renderSessions() {
      const seen = new Set();
      status.sessions.forEach(function (session) {
        if (!session || typeof session.sessionId !== 'string' || seen.has(session.sessionId)) return;
        seen.add(session.sessionId);
        let row = sessionRows.get(session.sessionId);
        if (!row) {
          const element = node('li', 'harness-session');
          const text = node('div', 'harness-session-text');
          const name = node('strong');
          name.dir = 'auto';
          const meta = node('span', 'harness-muted');
          const detected = node('span', 'harness-muted');
          const form = node('form', 'harness-session-text');
          form.hidden = true;
          const aliasInput = node('input', 'harness-session-alias');
          aliasInput.type = 'text';
          aliasInput.maxLength = 80;
          aliasInput.required = true;
          aliasInput.setAttribute('aria-label', '连接显示名称');
          const editActions = node('div', 'harness-controls');
          const save = action('', '保存', true);
          save.type = 'submit';
          const cancel = action('', '取消');
          editActions.append(save, cancel);
          form.append(aliasInput, editActions);
          const rename = action('', '改名');
          const revoke = action('', '撤销');
          text.append(name, meta, detected, form);
          element.append(text, rename, revoke);
          row = { element: element, name: name, meta: meta, detected: detected, rename: rename, revoke: revoke, pending: false };
          sessionRows.set(session.sessionId, row);
          sessionsList.append(element);
          function closeEditor() {
            form.hidden = true; rename.hidden = false; rename.focus();
          }
          rename.addEventListener('click', function () {
            aliasInput.value = row.name.textContent === '未命名客户端' ? '' : row.name.textContent;
            form.hidden = false; rename.hidden = true; aliasInput.focus();
          });
          cancel.addEventListener('click', closeEditor);
          form.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && !row.pending) { event.preventDefault(); event.stopPropagation(); closeEditor(); }
          });
          form.addEventListener('submit', async function (event) {
            event.preventDefault();
            const alias = aliasInput.value.trim();
            if (!alias || row.pending || !bridge || typeof bridge.rename !== 'function') return;
            const currentBridge = bridge;
            row.pending = true;
            save.disabled = aliasInput.disabled = cancel.disabled = true;
            localError = '';
            renderSessions(); renderErrors();
            try {
              checkResult(await currentBridge.rename(session.sessionId, alias));
              if (bridge === currentBridge) closeEditor();
            } catch (_) { localError = '连接改名失败，请重试。'; aliasInput.focus(); }
            finally {
              row.pending = false;
              save.disabled = aliasInput.disabled = cancel.disabled = false;
              renderSessions(); renderControls();
            }
          });
          revoke.addEventListener('click', async function () {
            if (row.pending || !bridge) return;
            const currentBridge = bridge;
            row.pending = true;
            revoke.disabled = true;
            localError = '';
            renderErrors();
            try {
              checkResult(await currentBridge.revoke(session.sessionId));
              if (bridge === currentBridge) await refreshStatus(true);
            } catch (_) { localError = '撤销授权失败，请刷新后重试。'; }
            finally { row.pending = false; renderSessions(); renderControls(); }
          });
        }
        row.name.textContent = sessionName(session);
        row.detected.hidden = !session.alias || !session.clientName || session.alias === session.clientName;
        row.detected.textContent = row.detected.hidden ? '' : '客户端自报：' + session.clientName;
        const scopes = Array.isArray(session.scopes) ? session.scopes.filter(function (scope) { return scopeLabels[scope]; }) : [];
        row.meta.textContent = (session.revoked ? '已撤销' : session.connected ? '已连接' : '未连接') + ' · ' + scopes.map(function (scope) { return scopeLabels[scope]; }).join(' / ');
        row.meta.classList.toggle('harness-session-online', !!session.connected && !session.revoked);
        row.rename.disabled = !bridge || typeof bridge.rename !== 'function' || !!session.revoked || row.pending;
        row.rename.setAttribute('aria-label', '修改 ' + row.name.textContent + ' 的连接名称');
        row.revoke.disabled = !bridge || !!session.revoked || row.pending;
        row.revoke.setAttribute('aria-label', '撤销 ' + row.name.textContent + ' 的授权');
      });
      sessionRows.forEach(function (row, id) {
        if (seen.has(id)) return;
        focusAfterRemoval(row.element);
        row.element.remove();
        sessionRows.delete(id);
      });
      sessionsEmpty.hidden = !!seen.size;
    }
    function removeRequest(record, decision) {
      window.clearTimeout(record.timer);
      requests.delete(record.key);
      settled.add(record.key);
      focusAfterRemoval(record.element);
      record.element.remove();
      if (record.resolve) { record.resolve(decision === true); record.resolve = null; }
      renderActivity();
    }
    function expireRequest(record) {
      record.expired = true;
      record.confirm.disabled = true;
      record.reject.disabled = true;
      record.message.textContent = '请求已过期，未批准执行。';
      if (record.resolve) { record.resolve(false); record.resolve = null; }
      settled.add(record.key);
      renderActivity();
    }
    async function decide(record, approve) {
      if (record.processing || record.expired || requests.get(record.key) !== record) return;
      if (Date.now() >= record.deadline || !Number.isFinite(record.deadline)) { expireRequest(record); return; }
      if (approve && !record.precise) return;
      const currentBridge = bridge;
      record.processing = true;
      record.confirm.disabled = true;
      record.reject.disabled = true;
      record.message.textContent = '正在提交…';
      try {
        // A registered built-in handler owns the Promise. External requests go to the broker.
        if (!record.builtin) {
          if (!currentBridge || typeof currentBridge.approve !== 'function') throw new Error('Harness unavailable');
          checkResult(await currentBridge.approve({ requestId: record.approval.requestId, diffHash: record.approval.diffHash, approve: approve }));
        }
        removeRequest(record, approve);
      } catch (_) {
        record.processing = false;
        record.message.textContent = '提交失败，请刷新状态后重试。';
        record.confirm.disabled = !record.precise || Date.now() >= record.deadline;
        record.reject.disabled = Date.now() >= record.deadline;
      }
    }
    function addLiteralBlock(parent, label, value) {
      const group = node('div', 'harness-diff-value');
      group.append(node('span', 'harness-muted', label), node('pre', '', literal(value)));
      parent.append(group);
    }
    function upsertRequest(approval) {
      const key = keyOf(approval);
      if (!key || settled.has(key)) return null;
      if (requests.has(key)) return requests.get(key);
      const element = node('details', 'harness-approval');
      element.dataset.requestId = approval.requestId;
      element.dataset.diffHash = approval.diffHash;
      element.open = true;
      const summary = node('summary');
      const summaryName = node('strong', '', sourceName(approval.source, false));
      summary.append(summaryName, node('span', '', ' · ' + literal(approval.tool) + ' · 等待确认'));
      const body = node('div', 'harness-approval-body');
      body.append(node('p', 'harness-request-id', '请求：' + approval.requestId));
      const precise = preciseDiff(approval);
      if (precise) {
        body.append(node('p', 'harness-diff-summary', approval.diff.summary));
        approval.diff.changes.forEach(function (change) {
          const block = node('div', 'harness-diff-change');
          block.append(node('h4', '', change.kind + ' · ' + change.target));
          if (Object.prototype.hasOwnProperty.call(change, 'before')) addLiteralBlock(block, '变更前', change.before);
          if (Object.prototype.hasOwnProperty.call(change, 'after')) addLiteralBlock(block, '变更后', change.after);
          body.append(block);
        });
      } else body.append(node('p', 'harness-error', '缺少精确变更内容，无法确认执行。'));
      const args = node('details', 'harness-request-args');
      args.append(node('summary', '', '查看请求参数'), node('pre', '', literal(approval.args)));
      body.append(args);
      const deadline = timestamp(approval.deadline);
      body.append(node('p', 'harness-muted', Number.isFinite(deadline) ? '确认期限：' + new Date(deadline).toLocaleTimeString() : '请求期限无效，无法确认执行。'));
      const message = node('p', 'harness-request-message');
      message.setAttribute('role', 'status');
      const actions = node('div', 'harness-approval-actions');
      const reject = action('', '拒绝');
      reject.dataset.decision = 'reject';
      const confirm = action('', '确认此变更', true);
      confirm.dataset.decision = 'confirm';
      confirm.disabled = !precise;
      actions.append(reject, confirm);
      body.append(message, actions);
      element.append(summary, body);
      requestList.append(element);
      const record = { key: key, approval: approval, element: element, summary: summary, summaryName: summaryName,
        confirm: confirm, reject: reject, message: message, precise: precise, deadline: deadline,
        reported: false, builtin: false, processing: false, expired: false, timer: 0, resolve: null, promise: null };
      requests.set(key, record);
      confirm.addEventListener('click', function () { decide(record, true); });
      reject.addEventListener('click', function () { decide(record, false); });
      const remaining = deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) expireRequest(record);
      else record.timer = window.setTimeout(function () { expireRequest(record); }, Math.min(remaining, 2147483647));
      return record;
    }
    function syncRequests() {
      const seen = new Set();
      let firstNew = null;
      status.approvals.forEach(function (approval) {
        const key = keyOf(approval);
        if (!key) return;
        seen.add(key);
        const exists = requests.has(key);
        const record = upsertRequest(approval);
        if (record) {
          record.reported = true;
          if (!exists && !record.expired && !firstNew) firstNew = record;
        }
      });
      requests.forEach(function (record) {
        if (record.reported && !seen.has(record.key) && !record.processing) removeRequest(record, false);
      });
      // Reveal a new precise request without repeatedly stealing focus on status refreshes.
      if (firstNew) {
        if (panel.hidden) openPanel(firstNew.summary);
        else positionPanel();
      }
    }
    function handleBuiltin(approval) {
      const record = upsertRequest(approval);
      if (!record || record.expired || closed) return Promise.resolve(false);
      record.builtin = true;
      record.summaryName.textContent = '内置助手';
      if (!record.promise) record.promise = new Promise(function (resolve) { record.resolve = resolve; });
      if (panel.hidden) openPanel(record.summary);
      renderActivity();
      return record.promise;
    }
    function receiveStatus(next) {
      if (!next || typeof next !== 'object') return;
      stateVersion++;
      const prior = status.state;
      if (next.connector && typeof next.connector.exe === 'string' && next.connector.exe &&
          typeof next.connector.credential === 'string' && next.connector.credential) {
        connectorInfo = { exe: next.connector.exe, credential: next.connector.credential };
      } else connectorInfo = null;
      status = { state: next.state, enabled: next.enabled === true, connected: next.connected === true,
        sessions: Array.isArray(next.sessions) ? next.sessions : [], running: Array.isArray(next.running) ? next.running : [],
        approvals: Array.isArray(next.approvals) ? next.approvals : [], error: !!next.error };
      if (status.state === 'done' && prior !== 'done') {
        doneUntil = Date.now() + 1800;
        window.clearTimeout(doneTimer);
        doneTimer = window.setTimeout(renderActivity, 1800);
      }
      syncRequests();
      renderRunning();
      renderSessions();
      renderActivity();
    }
    async function refreshStatus(showError) {
      if (!bridge) return;
      const currentBridge = bridge, version = stateVersion, serial = ++refreshSerial;
      refreshBusy = true;
      renderControls();
      try {
        const next = checkResult(await currentBridge.getStatus());
        if (bridge === currentBridge && version === stateVersion && serial === refreshSerial) receiveStatus(next);
      } catch (_) {
        if (showError && bridge === currentBridge) localError = '无法刷新连接状态，请稍后重试。';
      } finally {
        if (serial === refreshSerial) refreshBusy = false;
        renderControls();
      }
    }
    function tryBind() {
      const candidate = window.SB_HARNESS;
      if (!candidate || candidate === bridge || typeof candidate.getStatus !== 'function' || typeof candidate.onChange !== 'function') return;
      if (typeof unsubscribe === 'function') unsubscribe();
      requests.forEach(function (record) { removeRequest(record, false); });
      clearPairing();
      bridge = candidate;
      unsubscribe = candidate.onChange(function (next) { if (bridge === candidate) receiveStatus(next); });
      if (typeof candidate.setApprovalHandler === 'function') candidate.setApprovalHandler(handleBuiltin);
      receiveStatus(candidate.state);
      refreshStatus(true);
    }

    button.addEventListener('click', function () {
      tryBind();
      if (!panel.hidden) { closePanel(true); return; }
      openPanel();
      refreshStatus(true);
    });
    closeButton.addEventListener('click', function () { closePanel(true); });
    refreshButton.addEventListener('click', function () { localError = ''; refreshStatus(true); refreshClients(); });
    document.addEventListener('pointerdown', function (event) {
      if (!panel.hidden && !panel.contains(event.target) && !indicator.contains(event.target)) closePanel(false);
    });
    document.addEventListener('focusin', function (event) {
      if (!panel.hidden && !panel.contains(event.target) && !indicator.contains(event.target)) closePanel(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); closePanel(true); }
    });
    async function generatePairing() {
      if (!bridge || pairBusy) return null;
      const currentBridge = bridge;
      pairBusy = true;
      localError = '';
      clearPairing();
      const version = pairingVersion;
      renderControls();
      try {
        const scopes = ['read'];
        if (scopeInputs.view.checked) scopes.push('view');
        if (scopeInputs.edit.checked) scopes.push('edit');
        const result = checkResult(await currentBridge.createPairing({ scopes: scopes, remember: remember.checked === true }));
        if (bridge !== currentBridge || version !== pairingVersion || closed) return null;
        const expiresAt = timestamp(result && result.expiresAt);
        if (!result || typeof result.code !== 'string' || !result.code || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid pairing');
        pairing = { code: result.code, expiresAt: Math.min(expiresAt, Date.now() + 300000) };
        pairCode.textContent = pairing.code;
        pairBox.hidden = false;
        copyButton.disabled = false;
        copyConfigButton.disabled = false;
        tickPairing();
        pairTimer = window.setInterval(tickPairing, 1000);
        await refreshStatus(true);
        return pairing;
      } catch (_) { if (version === pairingVersion) localError = '无法生成配对码，请检查桌面连接状态后重试。'; return null; }
      finally { pairBusy = false; renderControls(); }
    }
    pairButton.addEventListener('click', function () {
      if (pairButton.disabled) return;
      generatePairing();
    });
    copyConfigButton.addEventListener('click', async function () {
      if (!connectorInfo || pairBusy || copyConfigButton.disabled) return;
      if (!pairing || pairing.expiresAt <= Date.now()) { tickPairing(); return; }
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
        if (!remember.checked) {
          // One-click config must survive client restarts, so the grant is remembered;
          // regenerate the pairing so the new code carries the persisted grant.
          remember.checked = true;
          const regenerated = await generatePairing();
          if (!regenerated) throw new Error('Pairing unavailable');
        }
        if (!pairing || pairing.expiresAt <= Date.now()) throw new Error('Pairing expired');
        // Repeated copies of one pairing reuse its path. A different pairing
        // must never silently reuse the grant installed by another host.
        if (!pairing.credentialPath) {
          const suffix = window.crypto.randomUUID();
          pairing.credentialPath = connectorInfo.credential.replace(/[^\\/]+$/, 'connector-' + suffix + '.json');
        }
        const config = { mcpServers: { structboard: {
          command: connectorInfo.exe,
          args: ['--mcp', '--pair-code', pairing.code, '--credential-file', pairing.credentialPath]
        } } };
        await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
        pairMessage.textContent = '已复制 MCP 配置：粘贴到 ZCode 等 MCP 客户端的 mcpServers 里即可，客户端首次启动会自动完成配对。';
      } catch (_) { pairMessage.textContent = '复制失败，请改用“复制配对码”并按交接文档手动配置。'; }
    });
    copyButton.addEventListener('click', async function () {
      if (!pairing || pairing.expiresAt <= Date.now()) { tickPairing(); return; }
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(pairing.code);
        pairMessage.textContent = '已复制到剪贴板。';
      } catch (_) { pairMessage.textContent = '复制失败，请手动选择配对码。'; }
    });
    stopButton.addEventListener('click', async function () {
      if (!bridge || stopBusy || stopButton.disabled) return;
      const currentBridge = bridge;
      stopBusy = true;
      localError = '';
      clearPairing();
      renderControls();
      try {
        checkResult(await currentBridge.stop());
        if (bridge !== currentBridge) return;
        clearPairing();
        requests.forEach(function (record) { removeRequest(record, false); });
        receiveStatus(currentBridge.state);
        await refreshStatus(true);
      } catch (_) { localError = '停止请求失败，请刷新状态后重试。'; }
      finally { stopBusy = false; renderControls(); }
    });
    window.addEventListener('resize', positionPanel);
    window.addEventListener('sb:harness-ready', tryBind);
    document.addEventListener('sb:harness-ready', tryBind);
    window.addEventListener('load', tryBind);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { tryBind(); tickPairing(); }
    });
    window.addEventListener('pagehide', function (event) {
      if (event.persisted) return;
      closed = true;
      clearPairing();
      window.clearTimeout(doneTimer);
      requests.forEach(function (record) { removeRequest(record, false); });
      if (typeof unsubscribe === 'function') unsubscribe();
      if(panel.__disposeView)panel.__disposeView();
    });
    renderActivity();
    tryBind();
    clientsSection.hidden = !desktop() || !bridge || typeof bridge.listClients !== 'function';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
