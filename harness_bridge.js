/* Shared renderer tool bridge for the built-in assistant and paired MCP jobs. */
(function (root, factory) {
  'use strict';
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else {
    root.SB_HARNESS_CORE = core;
    const boot = function () {
      if (root.SB_HARNESS) return;
      const bridge = core.create({ window: root });
      root.SB_HARNESS = bridge;
      root.dispatchEvent(new CustomEvent('sb:harness-ready'));
      bridge.start();
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const CANVAS_TOOLS = new Set(['sb_get_canvas', 'sb_canvas_apply', 'sb_canvas_undo']);
  function fault(code, message) { const error = new Error(message); error.code = code; return error; }
  function publicError(error) {
    return { code: String(error && error.code || (error && error.name === 'AbortError' ? 'CANCELLED' : 'OPERATION_FAILED')).replace(/[^A-Za-z_]/g, '_').slice(0, 64),
      message: String(error && error.message || '操作未能完成').slice(0, 1000) };
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function jsonGuard(value, maximum) {
    let count = 0;
    const walk = function (item, depth) {
      if (++count > 50000 || depth > 32) throw fault('INVALID_ARGUMENT', '请求内容过大或嵌套过深');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (Array.isArray(item)) { item.forEach(next => walk(next, depth + 1)); return; }
      if (!item || typeof item !== 'object') throw fault('INVALID_ARGUMENT', '只接受 JSON 数据');
      for (const key of Object.keys(item)) {
        if (BAD_KEYS.has(key)) throw fault('INVALID_ARGUMENT', '不支持此属性');
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !own(property, 'value')) throw fault('INVALID_ARGUMENT', '不支持动态属性');
        walk(property.value, depth + 1);
      }
    };
    walk(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > maximum) throw fault('PAYLOAD_TOO_LARGE', '请求或结果超过大小限制');
  }
  function resolve(schema, contract) {
    if (!schema.$ref) return schema;
    if (!/^#\/\$defs\/[A-Za-z0-9_]+$/.test(schema.$ref)) throw fault('INVALID_SCHEMA', '工具契约引用无效');
    const found = contract.$defs[schema.$ref.split('/').pop()];
    if (!found) throw fault('INVALID_SCHEMA', '工具契约引用缺失');
    return Object.assign({}, resolve(found, contract), Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')));
  }
  function expand(schema, contract) {
    if (Array.isArray(schema)) return schema.map(item => expand(item, contract));
    if (!schema || typeof schema !== 'object') return schema;
    return Object.fromEntries(Object.entries(resolve(schema, contract)).map(([key, value]) => [key, expand(value, contract)]));
  }
  function validate(value, schema, contract, path, depth) {
    path = path || 'args'; depth = depth || 0;
    if (depth > 40) throw fault('INVALID_SCHEMA', '工具契约嵌套过深');
    schema = resolve(schema, contract);
    for (const key of ['oneOf', 'anyOf', 'allOf']) if (schema[key]) {
      const matches = schema[key].filter(option => { try { validate(value, option, contract, path, depth + 1); return true; } catch (_) { return false; } }).length;
      if (key === 'oneOf' && matches !== 1 || key === 'anyOf' && !matches || key === 'allOf' && matches !== schema[key].length) throw fault('INVALID_ARGUMENT', path + ' 不符合允许的参数组合');
    }
    if (schema.not) {
      let matches = true;
      try { validate(value, schema.not, contract, path, depth + 1); } catch (_) { matches = false; }
      if (matches) throw fault('INVALID_ARGUMENT', path + ' 包含互斥字段');
    }
    const kinds = schema.type && (Array.isArray(schema.type) ? schema.type : [schema.type]);
    const typeMatches = kind => kind === 'null' ? value === null : kind === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : kind === 'array' ? Array.isArray(value) : kind === 'integer' ? Number.isSafeInteger(value)
        : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind;
    if (kinds && !kinds.some(typeMatches)) throw fault('INVALID_ARGUMENT', path + ' 类型不正确');
    if (own(schema, 'const') && canonical(value) !== canonical(schema.const)) throw fault('INVALID_ARGUMENT', path + ' 值不正确');
    if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) throw fault('INVALID_ARGUMENT', path + ' 值不在允许范围内');
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const properties = schema.properties || {};
      for (const key of schema.required || []) if (!own(value, key)) throw fault('INVALID_ARGUMENT', path + '.' + key + ' 为必填项');
      const keys = Object.keys(value);
      if (keys.length < (schema.minProperties || 0) || keys.length > (schema.maxProperties === undefined ? Infinity : schema.maxProperties)) throw fault('INVALID_ARGUMENT', path + ' 字段数量不正确');
      for (const key of keys) {
        if (own(properties, key)) validate(value[key], properties[key], contract, path + '.' + key, depth + 1);
        else if (schema.additionalProperties === false) throw fault('INVALID_ARGUMENT', path + ' 包含未知字段 ' + key);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(value[key], schema.additionalProperties, contract, path + '.' + key, depth + 1);
      }
    } else if (Array.isArray(value)) {
      if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems === undefined ? Infinity : schema.maxItems)) throw fault('INVALID_ARGUMENT', path + ' 数量不正确');
      if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) throw fault('INVALID_ARGUMENT', path + ' 包含重复项');
      value.forEach((item, index) => {
        if (schema.prefixItems && index < schema.prefixItems.length) validate(item, schema.prefixItems[index], contract, path + '[' + index + ']', depth + 1);
        else if (schema.items === false) throw fault('INVALID_ARGUMENT', path + ' 包含多余项');
        else if (schema.items && typeof schema.items === 'object') validate(item, schema.items, contract, path + '[' + index + ']', depth + 1);
      });
    } else if (typeof value === 'string') {
      if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength === undefined ? Infinity : schema.maxLength) || schema.pattern && !new RegExp(schema.pattern).test(value)) throw fault('INVALID_ARGUMENT', path + ' 长度或格式不正确');
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < (schema.minimum === undefined ? -Infinity : schema.minimum) || value > (schema.maximum === undefined ? Infinity : schema.maximum)) throw fault('INVALID_ARGUMENT', path + ' 超出允许范围');
    }
    return value;
  }
  function randomId(crypto, prefix) {
    const bytes = new Uint8Array(16);
    if (!crypto || !crypto.getRandomValues) throw fault('CRYPTO_UNAVAILABLE', '当前环境不支持安全连接标识');
    crypto.getRandomValues(bytes);
    return (prefix || 'request') + '_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  async function digest(crypto, value) {
    if (!crypto || !crypto.subtle) throw fault('CRYPTO_UNAVAILABLE', '当前环境无法校验变更摘要');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function createCanvasClient(options) {
    const win = options.window, getFrame = options.getFrame, crypto = options.crypto || win.crypto;
    const later = options.setTimeout || win.setTimeout.bind(win), cancel = options.clearTimeout || win.clearTimeout.bind(win);
    const pending = new Map();
    let nonce = randomId(crypto, 'canvas'), frame = null, ready = false, greeting = null, disposed = false;
    const origin = win.location.origin;
    const postOrigin = origin === 'null' ? '*' : origin;
    function post(data) {
      const target = getFrame();
      if (!target || !target.contentWindow) throw fault('CANVAS_UNAVAILABLE', '流程画布尚未就绪');
      target.contentWindow.postMessage(data, postOrigin);
    }
    function clearPending(reason) {
      for (const request of pending.values()) { cancel(request.timer); request.detach(); request.reject(reason); }
      pending.clear();
    }
    function loaded() {
      ready = false; nonce = randomId(crypto, 'canvas');
      clearPending(fault('CANVAS_RELOADED', '画布已重新加载，请读取最新状态'));
    }
    function attach() {
      const next = getFrame();
      if (!next || !next.contentWindow) throw fault('CANVAS_UNAVAILABLE', '流程画布尚未就绪');
      if (next !== frame) {
        if (frame) frame.removeEventListener('load', loaded);
        frame = next; ready = false; frame.addEventListener('load', loaded);
      }
      return next;
    }
    function receive(event) {
      if (disposed || !frame || event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data;
      if (!data || data.v !== 1 || data.nonce !== nonce) return;
      try { jsonGuard(data, 1048576); } catch (_) { return; }
      if (data.type === 'sb.canvas.ready') { ready = true; return; }
      if (data.type !== 'sb.canvas.response' || typeof data.requestId !== 'string' || typeof data.ok !== 'boolean') return;
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId); cancel(request.timer); request.detach();
      if (data.ok && own(data, 'result') && !own(data, 'error')) request.resolve(data.result);
      else request.reject(fault(data.error && data.error.code || 'CANVAS_FAILED', data.error && data.error.message || '画布操作失败'));
    }
    win.addEventListener('message', receive);
    async function handshake() {
      if (disposed) throw fault('CANCELLED', '画布连接已停止');
      attach();
      if (ready) return;
      if (!greeting) greeting = new Promise((resolve, reject) => {
        let elapsed = 0;
        const tick = function () {
          if (disposed) { reject(fault('CANCELLED', '画布连接已停止')); return; }
          if (ready) { resolve(); return; }
          if (elapsed >= (options.handshakeMs || 4000)) { reject(fault('CANVAS_UNAVAILABLE', '画布没有响应，请打开流程后重试')); return; }
          try { attach(); post({ type: 'sb.canvas.hello', v: 1, nonce }); } catch (error) { reject(error); return; }
          elapsed += 100; later(tick, 100);
        };
        tick();
      }).finally(() => { greeting = null; });
      return greeting;
    }
    async function request(op, args, context) {
      context = context || {};
      if (context.signal && context.signal.aborted) throw fault('CANCELLED', '操作已取消');
      await handshake();
      if (context.signal && context.signal.aborted) throw fault('CANCELLED', '操作已取消');
      const requestId = randomId(crypto, 'canvas_request');
      return new Promise((resolve, reject) => {
        const abort = function () {
          const item = pending.get(requestId);
          if (!item) return;
          pending.delete(requestId); cancel(item.timer); item.detach();
          try { post({ type: 'sb.canvas.cancel', v: 1, requestId, nonce }); } catch (_) {}
          reject(fault('CANCELLED', '已请求取消；重试前请读取当前画布版本'));
        };
        const timer = later(function () {
          abort();
        }, context.timeoutMs || options.timeoutMs || 20000);
        const detach = () => { if (context.signal) context.signal.removeEventListener('abort', abort); };
        pending.set(requestId, { resolve, reject, timer, detach });
        if (context.signal) context.signal.addEventListener('abort', abort, { once: true });
        try {
          const message = { type: 'sb.canvas.request', v: 1, requestId, nonce, op, args };
          if (context.prepared) message.prepared = context.prepared;
          post(message);
        } catch (error) { pending.delete(requestId); cancel(timer); detach(); reject(error); }
      });
    }
    return { request, dispose() {
      if (disposed) return;
      disposed = true; win.removeEventListener('message', receive);
      if (frame) frame.removeEventListener('load', loaded);
      clearPending(fault('CANCELLED', '画布连接已停止'));
    } };
  }
  function needsApproval(tool, args) {
    return tool === 'sb_pipeline_apply' || tool === 'sb_canvas_undo' || tool === 'sb_canvas_apply' && args.operations.some(op => op.op === 'node.delete' || op.op === 'edge.disconnect');
  }
  function preciseDiff(value) {
    if (value && typeof value.summary === 'string' && Array.isArray(value.changes)) {
      const kinds = { create: 'add', delete: 'remove', connect: 'add', disconnect: 'remove' };
      return { summary: value.summary, changes: value.changes.map(item => {
        const change = { target: item.target, kind: kinds[item.kind] || item.kind };
        if (own(item, 'before')) change.before = typeof item.before === 'string' ? item.before : canonical(item.before);
        if (own(item, 'after')) change.after = typeof item.after === 'string' ? item.after : canonical(item.after);
        return change;
      }) };
    }
    if (!value || !value.before || !value.after) throw fault('INVALID_DIFF', '操作没有返回可确认的真实差异');
    const changes = [], before = value.before, after = value.after;
    const add = (target, a, b) => { if (canonical(a) !== canonical(b)) changes.push({ target, kind: 'update', before: canonical(a), after: canonical(b) }); };
    add(value.pipelineId || after.pipelineId, before.name, after.name);
    const oldSteps = new Map((before.steps || []).map(step => [step.stepId, step]));
    for (const step of after.steps || []) {
      const old = oldSteps.get(step.stepId);
      if (!old) throw fault('INVALID_DIFF', '管线预览包含不支持的新步骤');
      for (const field of ['title', 'tool', 'dir', 'globs', 'starGlobs', 'files']) add(step.stepId + ':' + field, old[field], step[field]);
    }
    add((value.pipelineId || after.pipelineId) + ':order', (before.steps || []).map(step => step.stepId), (after.steps || []).map(step => step.stepId));
    if (!changes.length) throw fault('NO_CHANGE', '没有需要应用的变更');
    return { summary: '修改管线定义：' + changes.length + ' 项，不运行计算', changes };
  }
  function create(options) {
    options = options || {};
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const rendererId = 'window_' + (win && win.__SB_WORKSPACE_WINDOW_KEY__ || 'main');
    const crypto = options.crypto || win && win.crypto;
    const later = options.setTimeout || (win ? win.setTimeout.bind(win) : setTimeout);
    const cancel = options.clearTimeout || (win ? win.clearTimeout.bind(win) : clearTimeout);
    const now = options.now || Date.now;
    const desktop = options.desktop === undefined ? !!(win && win.__SB_DESKTOP__) : !!options.desktop;
    const app = options.getApp || (() => win.SB_APP_OPERATIONS);
    const fetcher = options.fetch || (win && win.fetch.bind(win));
    const listeners = new Set(), running = new Map(), controllers = new Map(), prepared = new Map(), localApprovals = new Map(), seen = new Map(), outbox = new Map();
    const canvas = options.canvas || (win && createCanvasClient({ window: win, crypto, getFrame: () => win.document.getElementById('pipelineFrame') }));
    let contract = options.contract || null, contractTask = null, approvalHandler = null, queue = Promise.resolve();
    let sessions = [], externalApprovals = [], enabled = false, error = '', doneUntil = 0;
    let endpoint = '', instanceId = '', connectorInfo = null, pollTimer = 0, doneTimer = 0, started = false, disposed = false, epoch = 0;
    function state() {
      const approvals = externalApprovals.concat(Array.from(localApprovals.values(), item => item.approval));
      const connected = sessions.some(session => session.connected && !session.revoked);
      const phase = approvals.length ? 'approval' : running.size ? 'running' : error ? 'error' : now() < doneUntil ? 'done' : connected ? 'connected' : 'offline';
      return { state: phase, enabled, connected, sessions: copy(sessions), running: copy(Array.from(running.values())), approvals: copy(approvals), error, endpoint, instanceId, connector: connectorInfo ? copy(connectorInfo) : null };
    }
    function emit() { const value = state(); for (const listener of listeners) { try { listener(value); } catch (_) {} } }
    function finished(success) {
      if (success) {
        error = ''; doneUntil = now() + 1500; cancel(doneTimer);
        doneTimer = later(() => { doneUntil = 0; emit(); }, 1500);
      }
      emit();
    }
    async function request(path, body, signal) {
      if (options.request) return options.request(path, body, signal);
      const controller = new AbortController(), relay = () => controller.abort();
      const timer = later(relay, 12000);
      if (signal) {
        if (signal.aborted) relay(); else signal.addEventListener('abort', relay, { once: true });
      }
      try {
        const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store' });
        const text = await response.text();
        if (text.length > 1048576) throw fault('RESPONSE_TOO_LARGE', '连接响应过大');
        let value; try { value = JSON.parse(text); } catch (_) { throw fault('INVALID_RESPONSE', '连接返回的不是 JSON'); }
        if (!response.ok || value.ok === false) throw fault(value.error && value.error.code || 'BROKER_UNAVAILABLE', typeof value.error === 'string' ? value.error : value.error && value.error.message || '连接请求失败');
        return value;
      } catch (failure) {
        if (controller.signal.aborted) throw fault(signal && signal.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT', signal && signal.aborted ? '操作已取消' : '连接请求超时');
        throw failure;
      } finally {
        cancel(timer); if (signal) signal.removeEventListener('abort', relay);
      }
    }
    async function ensureContract() {
      if (contract) return contract;
      if (!contractTask) contractTask = (async function () {
        const value = await request(desktop ? '/api/harness/contract' : 'harness_contract.json');
        const loaded = value.contract || value;
        if (!loaded || loaded.version !== 1 || !loaded.$defs || !Array.isArray(loaded.tools)) throw fault('INVALID_SCHEMA', '助手工具契约未加载');
        contract = loaded;
        return contract;
      })().finally(() => { contractTask = null; });
      return contractTask;
    }
    async function listTools() {
      const definition = await ensureContract();
      return definition.tools.filter(tool => !['sb_get_job', 'sb_cancel_job'].includes(tool.name)).map(tool => ({
        name: tool.name, description: tool.description, inputSchema: expand(tool.inputSchema, definition),
        readOnly: tool.scope === 'read', mutates: tool.scope !== 'read', scope: tool.scope,
        annotations: { readOnlyHint: tool.scope === 'read', destructiveHint: ['sb_canvas_undo', 'sb_pipeline_apply'].includes(tool.name), idempotentHint: tool.scope === 'read' || !!tool.inputSchema.properties.idempotencyKey, openWorldHint: false },
      }));
    }
    async function runNative(tool, args, context) {
      if (context.signal && context.signal.aborted) throw fault('CANCELLED', '操作已取消');
      let value;
      if (CANVAS_TOOLS.has(tool)) {
        if (!canvas) throw fault('CANVAS_UNAVAILABLE', '画布连接不可用');
        const op = tool === 'sb_get_canvas' ? 'snapshot' : tool === 'sb_canvas_undo' ? 'undo' : 'apply';
        value = await canvas.request(context.phase === 'prepare' ? 'prepare' : op,
          context.phase === 'prepare' ? { kind: op, change: args } : args, context);
        return { ok: true, result: value, revision: value.revision };
      }
      const application = app();
      if (!application || typeof application.execute !== 'function') throw fault('APP_NOT_READY', '工作区尚未就绪，请稍候重试');
      const appContext = { source: context.source, sessionId: context.sessionId, scopes: context.scopes, signal: context.signal };
      if (context.phase === 'prepare' || context.phase === 'apply') appContext.phase = context.phase;
      if (context.approved === true) appContext.approved = true;
      if (context.prepared) appContext.prepared = context.prepared;
      value = await application.execute(tool, args, appContext);
      if (!value || value.ok !== true) throw fault(value && value.error && value.error.code || 'OPERATION_FAILED', value && value.error && value.error.message || '应用操作失败');
      return value;
    }
    async function invoke(tool, args, context) {
      const specification = contract.tools.find(item => item.name === tool);
      if (!specification) throw fault('UNKNOWN_TOOL', '不支持此工具');
      const work = async function () {
        const outcome = await runNative(tool, args, context);
        if (context.phase === 'prepare') return outcome;
        const result = copy(outcome.result);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw fault('INVALID_RESULT', '工具结果格式不正确');
        if (!CANVAS_TOOLS.has(tool)) {
          result.revision = outcome.revision;
          if (outcome.changeId !== undefined) result.changeId = outcome.changeId;
          if (outcome.durability !== undefined) result.durability = outcome.durability;
        }
        if (tool === 'sb_get_context') {
          result.capabilities = contract.tools.filter(item => !['sb_get_job', 'sb_cancel_job'].includes(item.name)).map(item => item.name);
          try {
            const activeCanvas = await canvas.request('snapshot', {}, { signal: context.signal, timeoutMs: 5000 });
            result.canvasId = activeCanvas.canvasId; result.canvasRevision = activeCanvas.revision;
          } catch (failure) {
            if (context.signal && context.signal.aborted) throw failure;
          }
        }
        jsonGuard(result, contract.limits.responseBytes || 1048576);
        validate(result, specification.resultSchema, contract, 'result');
        return { ok: true, result, revision: result.revision, ...(typeof result.durability === 'string' ? { durability: result.durability } : {}), ...(outcome.changeId ? { changeId: outcome.changeId } : {}) };
      };
      if (specification.scope === 'read') return work();
      const task = queue.catch(() => {}).then(work); queue = task.catch(() => {}); return task;
    }
    function trimPrepared() {
      for (const [key, record] of prepared) if (record.expiresAt <= now()) prepared.delete(key);
      while (prepared.size > 32) prepared.delete(prepared.keys().next().value);
    }
    async function prepare(tool, args, context) {
      const outcome = await invoke(tool, args, Object.assign({}, context, { phase: 'prepare', approved: false }));
      const result = outcome.result, token = result && (result.prepared || result.preparedId);
      if (typeof token !== 'string' || !token || token.length > 128) throw fault('PREPARE_FAILED', '工具没有返回固定的候选变更');
      const diff = preciseDiff(result.diff);
      validate(diff, { $ref: '#/$defs/diff' }, contract, 'diff');
      jsonGuard(diff, 262144);
      prepared.set(token, { tool, args: canonical(args), sessionId: context.sessionId, diff: canonical(diff), native: token, expiresAt: now() + 300000,
        requestId: context.requestId, brokerHash: null });
      trimPrepared();
      return { diff, prepared: token };
    }
    async function applyPrepared(tool, args, context) {
      trimPrepared();
      const record = prepared.get(context.prepared);
      if (!record || record.tool !== tool || record.args !== canonical(args) || record.sessionId !== context.sessionId || record.diff !== canonical(context.diff)) throw fault('PREPARED_MISMATCH', '确认的变更与当前请求不一致，请重新预览');
      if (context.external && record.brokerHash !== context.diffHash) throw fault('APPROVAL_MISMATCH', '确认摘要不匹配，请重新预览');
      const result = await invoke(tool, args, Object.assign({}, context, { phase: 'apply', approved: true, prepared: record.native }));
      prepared.delete(context.prepared);
      return result;
    }
    function activity(requestId, tool, source, sessionId) {
      error = ''; doneUntil = 0;
      running.set(requestId, { requestId, tool, source, sessionId }); emit();
    }
    function ask(approval, signal) {
      if (!approvalHandler) throw fault('APPROVAL_UI_UNAVAILABLE', '确认界面尚未就绪');
      return new Promise((resolve, reject) => {
        const settle = function (accepted, failure) {
          if (!localApprovals.has(approval.requestId)) return;
          const record = localApprovals.get(approval.requestId);
          cancel(record.timer); localApprovals.delete(approval.requestId);
          if (signal) signal.removeEventListener('abort', abort);
          emit(); if (failure) reject(failure); else resolve(accepted === true);
        };
        const abort = () => settle(false, fault('CANCELLED', '操作已取消'));
        const timer = later(() => settle(false, fault('APPROVAL_EXPIRED', '确认已过期，请重新预览')), Math.max(0, approval.deadline * 1000 - now()));
        localApprovals.set(approval.requestId, { approval, timer, settle }); emit();
        if (signal) { if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true }); }
        Promise.resolve().then(() => approvalHandler(copy(approval))).then(value => settle(value), () => settle(false));
      });
    }
    async function execute(tool, args, context) {
      context = context || {}; args = args === undefined ? {} : args;
      let requestId, timer, relay, controller;
      try {
        if (disposed) throw fault('CANCELLED', '工具连接已关闭');
        await ensureContract();
        jsonGuard(args, contract.limits.requestBytes);
        const spec = contract.tools.find(item => item.name === tool);
        if (!spec || ['sb_get_job', 'sb_cancel_job'].includes(tool)) throw fault('UNKNOWN_TOOL', '不支持此本机工具');
        validate(args, spec.inputSchema, contract); args = copy(args);
        if (spec.scope !== 'read' && context.approved !== true) throw fault('APPROVAL_REQUIRED', '请先确认这项操作');
        requestId = randomId(crypto, 'builtin'); controller = new AbortController(); controllers.set(requestId, { controller, source: 'builtin' });
        relay = () => controller.abort();
        if (context.signal) { if (context.signal.aborted) relay(); else context.signal.addEventListener('abort', relay, { once: true }); }
        timer = later(relay, 120000);
        const fixed = { source: 'builtin', sessionId: 'builtin', scopes: ['read', 'view', 'edit'], signal: controller.signal, requestId };
        activity(requestId, tool, { name: 'builtin' }, 'builtin');
        let result;
        if (needsApproval(tool, args)) {
          const candidate = await prepare(tool, args, fixed);
          const approval = { requestId, sessionId: 'builtin', tool, args, source: { name: 'builtin' }, ...candidate, deadline: now() / 1000 + 300,
            diffHash: await digest(crypto, { tool, args, diff: candidate.diff, prepared: candidate.prepared }) };
          running.delete(requestId); emit();
          if (!await ask(approval, controller.signal)) throw fault('APPROVAL_REJECTED', '已取消本次变更');
          activity(requestId, tool, { name: 'builtin' }, 'builtin');
          result = await applyPrepared(tool, args, Object.assign({}, fixed, candidate, { diffHash: approval.diffHash }));
        } else result = await invoke(tool, args, fixed);
        running.delete(requestId); finished(true); return result;
      } catch (failure) {
        const item = publicError(failure);
        if (requestId) running.delete(requestId);
        if (!['CANCELLED', 'APPROVAL_REJECTED'].includes(item.code)) error = item.message;
        finished(false); return { ok: false, error: item };
      } finally {
        cancel(timer); if (context.signal && relay) context.signal.removeEventListener('abort', relay);
        if (requestId) controllers.delete(requestId);
      }
    }
    function updateStatus(value) {
      if (!value || value.ok === false) throw fault('INVALID_RESPONSE', '连接状态响应无效');
      sessions = Array.isArray(value.sessions) ? value.sessions.filter(session => !session.rendererId || session.rendererId === rendererId).map(session => ({ sessionId: session.sessionId, name: session.name, scopes: session.scopes,
        clientName: session.clientName, alias: session.alias,
        connected: !!session.connected, revoked: !!session.revoked, remember: !!session.remember, lastSeen: session.lastSeen })) : sessions;
      if (typeof value.enabled === 'boolean') enabled = value.enabled;
      if (typeof value.endpoint === 'string') endpoint = value.endpoint;
      if (typeof value.instanceId === 'string') instanceId = value.instanceId;
      if (value.connector && typeof value.connector.exe === 'string' && typeof value.connector.credential === 'string' &&
          value.connector.exe && value.connector.credential) {
        connectorInfo = { exe: value.connector.exe, credential: value.connector.credential };
      }
    }
    async function getStatus() {
      if (desktop && !disposed) {
        try { updateStatus(await request('/api/harness/status')); error = ''; }
        catch (failure) { error = publicError(failure).message; }
      }
      emit(); return state();
    }
    function receiveApprovals(approvals) {
      externalApprovals = (approvals || []).filter(item => item && typeof item.requestId === 'string' && typeof item.diffHash === 'string');
      for (const approval of externalApprovals) {
        const record = Array.from(prepared.values()).find(item => item.requestId === approval.requestId && item.sessionId === approval.sessionId && item.tool === approval.tool && item.args === canonical(approval.args) && item.diff === canonical(approval.diff));
        if (record) record.brokerHash = approval.diffHash;
      }
      emit();
    }
    async function sendResults() {
      for (const [requestId, payload] of Array.from(outbox)) {
        try {
          const response = await request('/api/harness/result', Object.assign({ rendererId: rendererId }, payload));
          outbox.delete(requestId);
          if (response.job && response.job.state === 'approval_required') {
            const record = Array.from(prepared.values()).find(item => item.requestId === requestId);
            if (record) record.brokerHash = response.job.diffHash;
          }
        } catch (failure) {
          if (['request_not_found', 'unauthorized', 'broker_stopped'].includes(failure.code)) outbox.delete(requestId);
          else { error = publicError(failure).message; break; }
        }
      }
    }
    async function processMessage(message) {
      if (!message || message.v !== 1 || typeof message.requestId !== 'string' || seen.has(message.requestId)) return;
      const requestId = message.requestId, controller = new AbortController(), runEpoch = epoch;
      seen.set(requestId, true); while (seen.size > 2048) seen.delete(seen.keys().next().value);
      controllers.set(requestId, { controller, source: 'external', sessionId: message.sessionId });
      const delay = Math.max(0, Math.min(120000, Number(message.deadline) * 1000 - now()));
      const timer = later(() => controller.abort(), delay);
      let payload;
      try {
        jsonGuard(message, 270336);
        const spec = contract.tools.find(item => item.name === message.tool);
        if (!spec || !['execute', 'prepare', 'apply'].includes(message.phase) || !Array.isArray(message.scopes) || !message.scopes.includes(spec.scope)) throw fault('SCOPE_DENIED', '请求不在授权范围内');
        if (!delay || runEpoch !== epoch || disposed) throw fault('CANCELLED', '请求已过期或连接已停止');
        validate(message.args, spec.inputSchema, contract);
        const context = { source: 'external', external: true, sessionId: message.sessionId, scopes: message.scopes,
          signal: controller.signal, requestId, phase: message.phase, prepared: message.prepared, diff: message.diff, diffHash: message.diffHash };
        activity(requestId, message.tool, message.source || { name: '外部助手' }, message.sessionId);
        let outcome;
        if (message.phase === 'prepare') outcome = { ok: true, result: await prepare(message.tool, message.args, context) };
        else if (message.phase === 'apply') outcome = await applyPrepared(message.tool, message.args, context);
        else {
          if (needsApproval(message.tool, message.args)) throw fault('APPROVAL_REQUIRED', '此操作需要在应用中确认真实变更');
          outcome = await invoke(message.tool, message.args, context);
        }
        payload = { requestId, ok: true, result: outcome.result };
        if (message.phase !== 'prepare' && outcome.revision !== undefined) payload.revision = outcome.revision;
        if (message.phase !== 'prepare' && typeof outcome.durability === 'string') payload.durability = outcome.durability;
      } catch (failure) {
        const item = publicError(failure); payload = { requestId, ok: false, error: item };
        if (item.code !== 'CANCELLED') error = item.message;
      } finally { cancel(timer); controllers.delete(requestId); running.delete(requestId); }
      if (runEpoch === epoch && !disposed) {
        outbox.set(requestId, payload); finished(payload.ok);
      }
    }
    async function poll() {
      if (disposed || !started || !desktop) return;
      try {
        await ensureContract();
        if (!app() || win && !win.__SB_READY__ && !options.ready) { pollTimer = later(poll, 500); return; }
        await sendResults();
        const focused = !!(win && win.document && typeof win.document.hasFocus === 'function' && win.document.hasFocus());
        const value = await request('/api/harness/poll', { limit: 8, rendererId: rendererId, focused: focused });
        updateStatus(value); receiveApprovals(value.approvals);
        for (const item of value.cancellations || []) {
          const active = controllers.get(item.requestId); if (active) active.controller.abort();
          for (const [key, record] of prepared) if (record.requestId === item.requestId) prepared.delete(key);
        }
        for (const message of value.messages || []) processMessage(message).catch(failure => { error = publicError(failure).message; emit(); });
      } catch (failure) { error = publicError(failure).message; sessions = sessions.map(session => Object.assign({}, session, { connected: false })); emit(); }
      pollTimer = later(poll, 500);
    }
    async function approve(approval) {
      if (!desktop) throw fault('DESKTOP_REQUIRED', '外部连接确认仅在桌面版提供');
        const value = await request('/api/harness/approve', { requestId: approval.requestId, diffHash: approval.diffHash, approve: approval.approve === true, rendererId: rendererId });
      externalApprovals = externalApprovals.filter(item => item.requestId !== approval.requestId); emit(); return value;
    }
    async function createPairing(settings) {
      if (!desktop) throw fault('DESKTOP_REQUIRED', '请在桌面版生成配对码');
      const value = await request('/api/harness/pairing', Object.assign({}, settings || { scopes: ['read'], remember: false }, { rendererId: rendererId }));
      await getStatus(); return value;
    }
    async function revoke(sessionId) {
      const result = await request('/api/harness/revoke', { sessionId });
      for (const active of controllers.values()) if (active.sessionId === sessionId) active.controller.abort();
      for (const [key, record] of prepared) if (record.sessionId === sessionId) prepared.delete(key);
      await getStatus(); return result;
    }
    async function rename(sessionId, alias) {
      const value = await request('/api/harness/rename', { sessionId, alias, rendererId });
      await getStatus(); return value;
    }
    async function stop() {
      epoch++; doneUntil = 0; error = '';
      for (const active of controllers.values()) active.controller.abort();
      for (const pending of Array.from(localApprovals.values())) pending.settle(false);
      running.clear(); prepared.clear(); outbox.clear(); externalApprovals = [];
      if (desktop) updateStatus(await request('/api/harness/stop', {}));
      else { enabled = false; sessions = []; }
      emit(); return state();
    }
    function dispose() {
      if (disposed) return;
      disposed = true; epoch++; started = false; cancel(pollTimer); cancel(doneTimer);
      for (const active of controllers.values()) active.controller.abort();
      for (const pending of Array.from(localApprovals.values())) pending.settle(false);
      running.clear(); prepared.clear(); outbox.clear();
      if (canvas && canvas.dispose) canvas.dispose();
      if (win) win.removeEventListener('pagehide', dispose);
    }
    const api = { listTools, execute, runBuiltin: execute, getStatus, createPairing, approve, rename, revoke, stop,
      listClients() { return request('/api/harness/clients'); },
      async registerClient(clientId, scopes) {
        const value = await request('/api/harness/clients/register', { clientId, scopes, rendererId });
        await getStatus(); return value;
      },
      setApprovalHandler(handler) { approvalHandler = typeof handler === 'function' ? handler : null; },
      onChange(handler) { listeners.add(handler); handler(state()); return () => listeners.delete(handler); },
      start() { if (started || disposed) return; started = true; ensureContract().catch(failure => { error = publicError(failure).message; emit(); }); if (desktop) poll(); },
      dispose, get state() { return state(); },
    };
    if (options.exposeTesting) api.processMessage = processMessage;
    if (win) win.addEventListener('pagehide', dispose, { once: true });
    return api;
  }
  return { create, createCanvasClient, validate, expand, canonical, preciseDiff, needsApproval };
});
