/* StructBoard AI 助手：右下角悬浮球 + 液态玻璃对话面板。
   - 拖拽跟随指针、松手即停，位置记忆；区分点击（展开/收起）与拖动。
   - 对话走本机代理 /api/ai/chat（OpenAI 兼容格式，支持 SSE 流式）。
   - v2 能力：模型可输出 ```sb-action 动作块——只读动作自动执行并回传结果；
     会改数据的动作先在对话里出确认卡，用户点「执行」才真正生效。
   纯函数（normalizeCfg / parseActionBlocks / createSseParser）在底部单独导出便于回归。 */
(function (root) {
  'use strict';

  /* ---------------- 纯函数（可回归） ---------------- */

  const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high'];
  const FORMATS = ['openai-chat', 'openai-responses', 'anthropic'];

  function normalizeCfg(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cfg = {
      baseUrl: String(src.baseUrl || '').trim().replace(/\/+$/, ''),
      format: FORMATS.indexOf(src.format) >= 0 ? src.format : 'openai-chat',
      apiKey: String(src.apiKey || ''),
      model: String(src.model || '').trim(),
      effort: EFFORTS.indexOf(src.effort) >= 0 ? src.effort : 'off',
      stream: src.stream === undefined ? true : !!src.stream,
      extra: String(src.extra || '').trim(),
    };
    if (!cfg.baseUrl) return { ok: false, error: '缺少接口地址 baseUrl' };
    try {
      const u = new URL(cfg.baseUrl);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '::1'].indexOf(u.hostname) >= 0)) {
        return { ok: false, error: '接口地址必须是 https（本机回环可为 http）' };
      }
    } catch (e) { return { ok: false, error: '接口地址不是合法 URL' }; }
    if (!cfg.model) return { ok: false, error: '缺少模型名' };
    if (cfg.model.length > 80) return { ok: false, error: '模型名过长' };
    if (cfg.extra) {
      try {
        const parsed = JSON.parse(cfg.extra);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, error: '附加字段必须是 JSON 对象' };
        }
      } catch (e) { return { ok: false, error: '附加字段不是合法 JSON：' + e.message }; }
    }
    return { ok: true, cfg: cfg };
  }

  // 把模型输出拆成：正文 + ```sb-action {json}``` 动作块序列
  function parseActionBlocks(text) {
    const source = String(text || '');
    const out = [];
    const re = /```sb-action\s*\n?([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = re.exec(source)) !== null) {
      if (m.index > last) out.push({ type: 'text', text: source.slice(last, m.index) });
      const raw = m[1].trim();
      let item = { type: 'action', raw: raw };
      try { item.json = JSON.parse(raw); } catch (e) { item.error = '动作块不是合法 JSON：' + e.message; }
      out.push(item);
      last = m.index + m[0].length;
    }
    if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
    return out;
  }

  // SSE 增量解析：跨 chunk 安全，并保留终止、错误、finish reason 等状态。
  function createSseParser() {
    let buf = '';
    function parseLine(line, out) {
      line = String(line || '').replace(/\r$/, '');
      if (line.indexOf('data:') !== 0) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        out.push({ done: true, terminal: true, finishReason: 'stop' });
        return;
      }
      let obj;
      try { obj = JSON.parse(data); } catch (e) { out.push({ error: '代理返回无效 SSE JSON', terminal: true }); return; }
      if (!obj || typeof obj !== 'object') return;
      const err = obj.error || (obj.type === 'error' ? obj : null)
        || (obj.type === 'response.failed' ? (obj.error || obj) : null);
      if (err) {
        const message = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
        out.push({ error: message, terminal: true, raw: obj });
        return;
      }
      const terminalError = obj.type === 'response.incomplete' || obj.type === 'response.cancelled';
      if (terminalError) { out.push({ error: '回复未完成：' + obj.type, terminal: true }); return; }
      const choice = obj.choices && obj.choices[0];
      const delta = choice && (choice.delta || choice.message);
      const piece = delta && typeof delta.content === 'string' ? delta.content : '';
      if (piece) out.push({ delta: piece });
      const finishReason = (choice && choice.finish_reason)
        || obj.finish_reason || (obj.finish && obj.finish.reason);
      const completed = obj.done === true || obj.type === 'response.completed'
        || obj.type === 'message_stop' || obj.type === 'response.done';
      if (finishReason || completed) {
        out.push({ done: true, terminal: true, finishReason: finishReason || 'stop', raw: obj });
      }
    }
    return {
      push(chunk) {
        buf += String(chunk || '');
        const out = [];
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          parseLine(line, out);
        }
        return out;
      },
      finish() {
        const out = [];
        if (buf) { parseLine(buf, out); buf = ''; }
        return out;
      },
      buffered() { return buf; },
    };
  }

  let _idSeq = 0;
  function makeStableId(prefix) {
    _idSeq += 1;
    const now = Date.now().toString(36);
    let random = '';
    try { random = Math.random().toString(36).slice(2, 8); } catch (_) { random = String(_idSeq); }
    return String(prefix || 'id') + '-' + now + '-' + _idSeq.toString(36) + '-' + random;
  }

  const TRANSCRIPT_MAX_MESSAGES = 80;
  const TRANSCRIPT_MAX_TEXT = 12000;
  const TRANSCRIPT_MAX_TOTAL = 240000;
  const ACTION_MAX_RESULT = 6000;

  function clipText(value, max) {
    const text = String(value === undefined || value === null ? '' : value);
    const limit = max || TRANSCRIPT_MAX_TEXT;
    return text.length > limit ? text.slice(0, limit) + '…(截断)' : text;
  }
  function safeJson(value, max) {
    try { return clipText(JSON.stringify(value), max || ACTION_MAX_RESULT); }
    catch (_) { return '（结果无法序列化）'; }
  }
  function redactText(value, secrets) {
    let text = String(value === undefined || value === null ? '' : value);
    (secrets || []).filter(Boolean).forEach(secret => { text = text.split(String(secret)).join('[已隐藏密钥]'); });
    return text.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{6,}/g, '[已隐藏密钥]')
      .replace(/("(?:apiKey|api_key|authorization)"\s*:\s*")[^"\r\n]*(")/gi, '$1[已隐藏密钥]$2');
  }
  function privateJson(value) {
    try {
      return JSON.stringify(value, function (key, val) {
        if (/^(apiKey|api_key|authorization|snapshot)$/i.test(key)) return '[本机私密内容未保存]';
        return val;
      });
    } catch (_) { return '（结果无法序列化）'; }
  }
  function createChatStore(storage, key, options) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const storageKey = key || 'structboard.ai.transcript.v1';
    const opts = options || {};
    let state = { version: 1, messages: [], actions: {} };
    const scrub = value => redactText(value, typeof opts.secrets === 'function' ? opts.secrets() : opts.secrets);
    function cleanMessage(message) {
      const m = message && typeof message === 'object' ? message : {};
      const out = {
        id: String(m.id || makeStableId('msg')),
        turnId: String(m.turnId || ''),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: clipText(m.content, opts.maxText || TRANSCRIPT_MAX_TEXT),
        visible: m.visible !== false,
      };
      if (m.persistContent !== undefined) out.persistContent = clipText(m.persistContent);
      if (m.kind) out.kind = String(m.kind).slice(0, 40);
      if (m.status) out.status = String(m.status).slice(0, 40);
      if (m.error) out.error = clipText(m.error, 1000);
      if (m.actionId) out.actionId = String(m.actionId).slice(0, 120);
      if (m.actionName) out.actionName = String(m.actionName).slice(0, 120);
      return out;
    }
    function cleanAction(id, action) {
      const a = action && typeof action === 'object' ? action : {};
      const out = {
        id: String(id || a.id || makeStableId('action')),
        name: String(a.name || '').slice(0, 120),
        status: String(a.status || 'pending').slice(0, 40),
      };
      if (a.messageId) out.messageId = String(a.messageId);
      if (a.result !== undefined) out.result = scrub(clipText(a.result, ACTION_MAX_RESULT));
      if (a.error) out.error = scrub(clipText(a.error, ACTION_MAX_RESULT));
      return out;
    }
    function trim() {
      while (state.messages.length > (opts.maxMessages || TRANSCRIPT_MAX_MESSAGES)) state.messages.shift();
      let total = state.messages.reduce((n, m) => n + m.content.length, 0);
      while (total > (opts.maxTotal || TRANSCRIPT_MAX_TOTAL) && state.messages.length > 1) {
        total -= state.messages[0].content.length;
        state.messages.shift();
      }
      const ids = new Set(state.messages.map(m => m.id));
      Object.keys(state.actions).forEach(id => {
        const a = state.actions[id];
        if (a && a.messageId && !ids.has(a.messageId)) delete state.actions[id];
      });
    }
    function snapshot() {
      trim();
      return {
        version: 1,
        messages: state.messages.map(m => {
          const copy = Object.assign({}, m);
          copy.content = scrub(copy.persistContent === undefined ? copy.content : copy.persistContent);
          if (copy.error) copy.error = scrub(copy.error);
          delete copy.persistContent;
          return copy;
        }),
        actions: Object.fromEntries(Object.keys(state.actions).map(id => [id, cleanAction(id, state.actions[id])])),
      };
    }
    function persist() {
      trim();
      if (!store || typeof store.setItem !== 'function') return true;
      try { store.setItem(storageKey, JSON.stringify(snapshot())); return true; }
      catch (_) { return false; }
    }
    function load() {
      if (!store || typeof store.getItem !== 'function') return;
      try {
        const raw = JSON.parse(store.getItem(storageKey) || 'null');
        if (!raw || typeof raw !== 'object') return;
        state = { version: 1, messages: [], actions: {} };
        (Array.isArray(raw.messages) ? raw.messages : []).forEach(m => {
          const clean = cleanMessage(m);
          if (clean.status === 'streaming') { clean.status = 'interrupted'; clean.error = '上次回复未完成'; }
          state.messages.push(clean);
        });
        const actions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
        Object.keys(actions).slice(0, TRANSCRIPT_MAX_MESSAGES * 3).forEach(id => {
          state.actions[id] = cleanAction(id, actions[id]);
          if (state.actions[id].status === 'running') {
            state.actions[id].status = 'interrupted';
            state.actions[id].error = '上次执行结果未知，请先检查工作台；不会自动重试';
          }
        });
        trim();
      } catch (_) { state = { version: 1, messages: [], actions: {} }; }
    }
    load();
    return {
      getMessages() { return state.messages.slice(); },
      getActions() { return Object.assign({}, state.actions); },
      getAction(id) { return state.actions[id] || null; },
      append(message) { const m = cleanMessage(message); state.messages.push(m); persist(); return m; },
      update(id, patch) {
        const index = state.messages.findIndex(m => m.id === id);
        if (index < 0) return null;
        state.messages[index] = cleanMessage(Object.assign({}, state.messages[index], patch || {}));
        persist(); return state.messages[index];
      },
      setAction(id, patch) {
        state.actions[id] = cleanAction(id, Object.assign({}, state.actions[id] || {}, patch || {}));
        persist(); return state.actions[id];
      },
      flush: persist,
      clear() { state = { version: 1, messages: [], actions: {} }; persist(); },
      snapshot: snapshot,
      exportText() {
        const saved = snapshot();
        return saved.messages.map(m => {
          const who = m.role === 'assistant' ? 'AI' : (m.visible === false ? '系统' : '我');
          return who + '：' + m.content;
        }).join('\n\n') + '\n\n动作状态：\n' + JSON.stringify(saved.actions, null, 2);
      },
      storageKey: storageKey,
    };
  }

  function normalizeTool(spec, legacy) {
    if (!spec || typeof spec.name !== 'string') return null;
    let schema = spec.inputSchema || spec.parameters;
    if (!schema) {
      schema = { type: 'object', properties: {}, additionalProperties: false };
      const rules = Array.isArray(spec.args) ? spec.args : Object.keys(spec.args || {}).map(key =>
        Object.assign({ key: key }, spec.args[key]));
      const required = [];
      rules.forEach(rule => {
        const property = Object.assign({}, rule);
        delete property.key; delete property.required;
        if (property.max) {
          property[property.type === 'array' ? 'maxItems' : 'maxLength'] = property.max;
          delete property.max;
        }
        if (property.item) { property.items = { type: property.item }; delete property.item; }
        if (property.integer) { property.type = 'integer'; delete property.integer; }
        schema.properties[rule.key] = property;
        if (rule.required) required.push(rule.key);
      });
      if (required.length) schema.required = required;
    }
    // Old mutates:false did not mean read-only (view.setSearch changed the view).
    const readOnly = spec.name !== 'view.setSearch' && (spec.readOnly === true
      || !!(spec.annotations && spec.annotations.readOnlyHint === true)
      || (legacy && spec.name === 'workspace.describe'));
    return { name: spec.name, description: String(spec.description || ''), inputSchema: schema,
      readOnly: readOnly, mutates: !readOnly };
  }
  function createToolBridge(host) {
    const target = host || root;
    function provider() {
      if (target.SB_HARNESS && typeof target.SB_HARNESS.listTools === 'function'
        && typeof target.SB_HARNESS.execute === 'function') return { api: target.SB_HARNESS, legacy: false };
      if (target.SB_APP_OPERATIONS && typeof target.SB_APP_OPERATIONS.listTools === 'function'
        && typeof target.SB_APP_OPERATIONS.execute === 'function') return { api: target.SB_APP_OPERATIONS, legacy: false };
      if (target.SB_ACTIONS && typeof target.SB_ACTIONS.list === 'function'
        && typeof target.SB_ACTIONS.act === 'function') return { api: target.SB_ACTIONS, legacy: true };
      throw Error('工作台工具尚未就绪');
    }
    return {
      async listTools() {
        const p = provider();
        const specs = await (p.legacy ? p.api.list() : p.api.listTools());
        if (!Array.isArray(specs)) throw Error('工作台工具清单格式错误');
        return specs.map(spec => normalizeTool(spec, p.legacy)).filter(Boolean);
      },
      async execute(name, args, context) {
        const p = provider();
        return p.legacy ? p.api.act(name, args) : p.api.execute(name, args, context);
      },
    };
  }
  function validateToolArgs(schema, args, location) {
    const s = schema || {};
    const here = location || 'args';
    if (Array.isArray(s.enum) && !s.enum.some(item => JSON.stringify(item) === JSON.stringify(args))) return here + ' 不在允许值中';
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(args)) return here + ' 值不匹配';
    if (Array.isArray(s.anyOf) && !s.anyOf.some(item => !validateToolArgs(item, args, here))) return here + ' 不符合参数类型';
    if (Array.isArray(s.oneOf) && s.oneOf.filter(item => !validateToolArgs(item, args, here)).length !== 1) return here + ' 不符合参数类型';
    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) { const invalid = validateToolArgs(sub, args, here); if (invalid) return invalid; }
    }
    const type = Array.isArray(args) ? 'array' : args === null ? 'null' : typeof args;
    const allowed = Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
    if (allowed.length && !allowed.some(kind => kind === type || (kind === 'integer' && type === 'number' && Number.isInteger(args)))) return here + ' 必须是 ' + allowed.join('/');
    if (type === 'number') {
      if (!Number.isFinite(args)) return here + ' 必须是有限数';
      if (s.minimum !== undefined && args < s.minimum) return here + ' 小于最小值';
      if (s.maximum !== undefined && args > s.maximum) return here + ' 大于最大值';
    }
    if (type === 'string') {
      if (s.minLength !== undefined && args.length < s.minLength) return here + ' 过短';
      if (args.length > (s.maxLength === undefined ? 20000 : s.maxLength)) return here + ' 过长';
      if (s.pattern) { try { if (!(new RegExp(s.pattern)).test(args)) return here + ' 格式错误'; } catch (_) { return here + ' schema 无效'; } }
    }
    if (type === 'array') {
      if (args.length > (s.maxItems === undefined ? 2000 : s.maxItems)) return here + ' 项数过多';
      if (s.minItems !== undefined && args.length < s.minItems) return here + ' 项数过少';
      for (let i = 0; s.items && i < args.length; i++) {
        const invalid = validateToolArgs(s.items, args[i], here + '[' + i + ']'); if (invalid) return invalid;
      }
    }
    if (type === 'object') {
      for (const key of s.required || []) { if (!Object.prototype.hasOwnProperty.call(args, key)) return here + ' 缺少参数 ' + key; }
      for (const key of Object.keys(args)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return here + ' 非法参数 ' + key;
        const rule = (s.properties || {})[key];
        if (!rule && s.additionalProperties === false) return here + ' 未知参数 ' + key;
        const invalid = rule ? validateToolArgs(rule, args[key], here + '.' + key) : null; if (invalid) return invalid;
      }
    }
    return null;
  }
  function toolSucceeded(result) {
    return !!(result && result.ok === true && !result.error
      && !(result.result && (result.result.ok === false || result.result.error)));
  }
  function abortError(message) { const error = Error(message || '已停止'); error.name = 'AbortError'; return error; }
  function withSignal(work, signal) {
    if (!signal) return Promise.resolve().then(work);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(abortError()); };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => { if (signal.aborted) throw abortError(); return work(); })
        .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  function validFinish(reason) { return !reason || reason === 'stop' || reason === 'end_turn' || reason === 'stop_sequence' || reason === 'completed'; }
  async function requestChat(body, onDelta, options) {
    const opts = options || {};
    const controller = new AbortController();
    const outer = opts.signal;
    const cancel = () => controller.abort();
    if (outer) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', cancel, { once: true }); }
    const signal = controller.signal;
    const deadline = setTimeout(cancel, opts.timeoutMs || 180000);
    let reader;
    try {
      const res = await withSignal(() => (opts.fetch || root.fetch || fetch)('/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: signal,
      }), signal);
      const ctype = res.headers.get('Content-Type') || '';
      if (res.ok === false) throw Error('代理 HTTP ' + res.status);
      if (ctype.indexOf('text/event-stream') >= 0) {
        if (!res.body || typeof res.body.getReader !== 'function') throw Error('代理流不可读');
        const parser = createSseParser();
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '', terminal = false;
        function consume(events) {
          for (const ev of events) {
            if (ev.error) throw Error('供应商流错误：' + ev.error);
            if (ev.delta) { full += ev.delta; if (onDelta) onDelta(full); }
            if (ev.done) {
              if (!validFinish(ev.finishReason)) throw Error('回复未完成：' + ev.finishReason);
              terminal = true;
            }
          }
        }
        for (;;) {
          const chunk = await withSignal(() => reader.read(), signal);
          if (chunk.done) { consume(parser.push(decoder.decode())); consume(parser.finish()); break; }
          consume(parser.push(decoder.decode(chunk.value, { stream: true })));
          if (terminal) break;
        }
        if (!terminal) throw Error('回复流意外中断（缺少结束事件）');
        if (!full.trim()) throw Error('供应商返回空回复');
        return full;
      }
      const data = await withSignal(() => res.json(), signal);
      if (!data || data.ok !== true || data.error) throw Error(data && data.error || '代理返回无法解析');
      const inner = data.data;
      if (!inner || inner.error) throw Error(inner && inner.error && (inner.error.message || String(inner.error)) || '供应商返回无效');
      const choice = inner.choices && inner.choices[0];
      if (!choice || !validFinish(choice.finish_reason)) throw Error('回复未完成：' + (choice && choice.finish_reason || '无有效结果'));
      const content = choice.message && choice.message.content;
      if (typeof content !== 'string' || !content.trim()) throw Error('供应商返回空回复');
      if (onDelta) onDelta(content);
      return content;
    } finally {
      clearTimeout(deadline);
      if (outer) outer.removeEventListener('abort', cancel);
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* already closed */ } }
      controller.abort();
    }
  }
  function createChatEngine(options) {
    const opts = options || {};
    const store = opts.store || createChatStore(opts.storage);
    const bridge = opts.bridge || createToolBridge(opts.host || root);
    const request = opts.request || requestChat;
    let epoch = 0, active = null, tools = [], notice = '';
    const listeners = new Set();
    function emit() { listeners.forEach(fn => { try { fn(); } catch (_) { /* view cannot break engine */ } }); }
    function current(token) { return active === token && token.epoch === epoch && !token.controller.signal.aborted; }
    function ensure(token) { if (!current(token)) throw abortError(); }
    function begin(turnId) {
      const token = { turnId: turnId, epoch: ++epoch, controller: new AbortController() };
      active = token; notice = '';
      token.deadline = setTimeout(() => stop('本轮超时，已停止；可以重试。'), opts.turnTimeoutMs || 240000);
      emit(); return token;
    }
    function end(token) {
      clearTimeout(token.deadline);
      if (active === token) { active = null; emit(); }
    }
    function stop(reason) {
      const token = active;
      if (!token) return;
      epoch += 1; active = null;
      clearTimeout(token.deadline); token.controller.abort();
      store.getMessages().filter(m => m.turnId === token.turnId && m.status === 'streaming').forEach(m =>
        store.update(m.id, { status: 'cancelled', error: reason || '已停止，可重试' }));
      Object.keys(store.getActions()).forEach(id => {
        const a = store.getAction(id);
        if (a.status === 'running') store.setAction(id, { status: 'interrupted', error: '执行已停止，结果未知；请检查工作台，不会自动重试' });
      });
      notice = reason || '已停止，输入内容已保留。'; emit();
    }
    async function refreshTools(token) {
      const list = await withSignal(() => bridge.listTools(), token && token.controller.signal);
      if (token) ensure(token);
      tools = list; return tools;
    }
    function actionRecords(message) {
      let index = 0;
      return parseActionBlocks(message.content).filter(p => p.type === 'action').map(part => {
        const id = message.id + '-action-' + index++;
        const name = part.json && part.json.action;
        const args = part.json && part.json.args === undefined ? {} : part.json && part.json.args;
        const spec = tools.find(t => t.name === name);
        const invalid = part.error || (!part.json || typeof part.json !== 'object' || Array.isArray(part.json) ? '动作必须是对象' : '')
          || (!spec ? '动作不存在：' + String(name || '') : '')
          || (!args || typeof args !== 'object' || Array.isArray(args) ? 'args 必须是对象' : '')
          || (spec && validateToolArgs(spec.inputSchema, args));
        return { id: id, messageId: message.id, turnId: message.turnId, name: name, args: args,
          readOnly: !!(spec && spec.readOnly), error: invalid || '', part: part };
      });
    }
    function registerActions(message) {
      const records = actionRecords(message);
      records.forEach(a => {
        if (!store.getAction(a.id)) store.setAction(a.id, { name: a.name, messageId: message.id,
          status: a.error ? 'invalid' : 'pending', error: a.error });
      });
      return records;
    }
    function recordResult(action, result) {
      const ok = toolSucceeded(result);
      const text = safeJson(result);
      const privateResult = /^(sb_get_context|sb_get_canvas|sb_pipeline_get|workspace\.describe)$/.test(action.name);
      const persisted = privateResult ? '（系统）工具 ' + action.name + ' ' + (ok ? '成功' : '失败') + '；工作台快照未保存，继续时请重新读取。'
        : '（系统）工具 ' + action.name + ' 结果：' + clipText(privateJson(result), ACTION_MAX_RESULT);
      store.append({ id: makeStableId('tool'), turnId: action.turnId, role: 'user', visible: false, kind: 'tool-result',
        actionId: action.id, actionName: action.name, content: '（系统）工具 ' + action.name + ' 结果：' + text,
        persistContent: persisted });
      store.setAction(action.id, { status: ok ? 'succeeded' : 'failed',
        result: privateResult ? '快照内容未保存' : clipText(privateJson(result), 1200),
        error: ok ? '' : String(result && (result.error || (result.result && result.result.error)) || '工具未返回 ok:true') });
      emit(); return ok;
    }
    async function runAction(action, token, approved) {
      ensure(token);
      const existing = store.getAction(action.id);
      if (!existing || existing.status !== 'pending') return false;
      const spec = tools.find(t => t.name === action.name);
      const invalid = !spec ? '动作不存在' : validateToolArgs(spec.inputSchema, action.args);
      if (invalid || (!spec.readOnly && approved !== true)) {
        store.setAction(action.id, { status: 'invalid', error: invalid || '需要用户确认' }); emit(); return false;
      }
      store.setAction(action.id, { status: 'running' });
      if (store.flush && !store.flush()) {
        store.setAction(action.id, { status: 'failed', error: '无法保存动作状态，本次未执行；请释放本机存储空间后重试' });
        emit(); return false;
      }
      emit();
      try {
        const context = { source: 'builtin', idempotencyKey: action.id, signal: token.controller.signal };
        if (approved === true) context.approved = true;
        const result = await withSignal(() => bridge.execute(action.name, action.args, context), token.controller.signal);
        ensure(token); recordResult(action, result); return true;
      } catch (error) {
        if (!current(token)) return false;
        recordResult(action, { ok: false, error: String(error.message || error) }); return true;
      }
    }
    async function payload(token, cfg) {
      ensure(token);
      const prompt = [SYSTEM_PROMPT, '可用工具（必须严格遵守完整 JSON Schema，未知工具不可调用）：',
        JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, readOnly: t.readOnly, inputSchema: t.inputSchema })))].join('\n');
      const messages = [{ role: 'system', content: prompt }];
      const contextTool = tools.find(t => t.name === 'sb_get_context') || tools.find(t => t.name === 'workspace.describe');
      if (contextTool && contextTool.readOnly) {
        const args = contextTool.name === 'workspace.describe' ? { includeEntries: true, includeMetrics: true, entryLimit: 200 } : {};
        const result = await withSignal(() => bridge.execute(contextTool.name, args,
          { source: 'builtin', signal: token.controller.signal }), token.controller.signal);
        ensure(token);
        messages.push({ role: 'system', content: '本轮工作台上下文（仅本轮发送，不保存到对话）：\n' + safeJson(result, 60000) });
      }
      // The user is already present in the durable history. Retries reuse this exact turn.
      const history = store.getMessages().filter(m => m.status !== 'streaming'
        && !(m.role === 'assistant' && m.status && m.status !== 'complete'));
      let total = 0;
      const recent = [];
      for (let i = history.length - 1; i >= 0 && recent.length < 24; i--) {
        const m = history[i]; if (total + m.content.length > 90000) break;
        recent.unshift({ role: m.role, content: m.content }); total += m.content.length;
      }
      messages.push(...recent);
      const body = { format: cfg.format, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        stream: cfg.stream !== false, messages: messages };
      if (cfg.effort && cfg.effort !== 'off') body.reasoning_effort = cfg.effort;
      if (cfg.extra) { try { body.extra = JSON.parse(cfg.extra); } catch (_) { /* configuration was validated */ } }
      return body;
    }
    async function loop(token, cfg) {
      for (let depth = 0; depth <= (opts.maxFollowups === undefined ? 4 : opts.maxFollowups); depth++) {
        ensure(token); await refreshTools(token);
        const body = await payload(token, cfg); ensure(token);
        const assistant = store.append({ id: makeStableId('msg'), turnId: token.turnId, role: 'assistant',
          content: '', status: 'streaming' });
        emit();
        let full;
        try {
          full = await withSignal(() => request(body, text => {
            if (!current(token)) return;
            store.update(assistant.id, { content: String(text || ''), status: 'streaming' }); emit();
          }, { signal: token.controller.signal, timeoutMs: opts.requestTimeoutMs || 180000 }), token.controller.signal);
          ensure(token);
          if (typeof full !== 'string' || !full.trim()) throw Error('供应商返回空回复');
        } catch (error) {
          if (!current(token)) return;
          store.update(assistant.id, { status: 'failed', error: String(error.message || error) }); emit(); return;
        }
        const message = store.update(assistant.id, { content: full, status: 'complete' });
        const actions = registerActions(message); emit();
        if (!actions.length) return;
        if (actions.length > 1) {
          actions.forEach(a => store.setAction(a.id, { status: 'invalid', error: '每次回复只允许一个动作，请重新请求' }));
          notice = '本次回复包含多个动作，均未执行。'; emit(); return;
        }
        const action = actions[0];
        if (action.error || !action.readOnly) return;
        if (depth === (opts.maxFollowups === undefined ? 4 : opts.maxFollowups)) {
          store.setAction(action.id, { status: 'limited', error: '自动执行已达本轮上限，请继续手动对话' });
          notice = '自动执行已达本轮上限。'; emit(); return;
        }
        if (!(await runAction(action, token, false))) return;
      }
    }
    const initialMessages = store.getMessages();
    initialMessages.filter(m => m.role === 'assistant' && m.status === 'complete').forEach(message => {
      let index = 0;
      parseActionBlocks(message.content).filter(p => p.type === 'action').forEach(part => {
        const id = message.id + '-action-' + index++;
        if (!store.getAction(id)) store.setAction(id, { name: part.json && part.json.action,
          messageId: message.id, status: 'interrupted', error: '旧动作未记录执行状态，不会自动重放；请重新提问' });
      });
    });
    async function drive(turnId) {
      const cfg = opts.getConfig ? opts.getConfig() : opts.config;
      if (!cfg) { notice = '请先配置供应商，输入已保留。'; emit(); return { accepted: false, reason: 'config' }; }
      const token = begin(turnId);
      try { await loop(token, cfg); }
      catch (error) {
        if (current(token)) {
          const message = String(error.message || error);
          store.append({ id: makeStableId('msg'), turnId: turnId, role: 'assistant', content: '', status: 'failed', error: message });
          notice = message; emit();
        }
      } finally { end(token); }
      return { accepted: true, turnId: turnId };
    }
    return {
      store: store,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      getState() { return { busy: !!active, notice: notice, messages: store.getMessages(), actions: store.getActions(), tools: tools.slice() }; },
      async send(text) {
        const content = String(text || '').trim();
        if (active) { notice = '正在处理上一轮；输入已保留，请等待或先停止。'; emit(); return { accepted: false, reason: 'busy' }; }
        if (!content) return { accepted: false, reason: 'empty' };
        const cfg = opts.getConfig ? opts.getConfig() : opts.config;
        if (!cfg) { notice = '请先配置供应商，输入已保留。'; emit(); return { accepted: false, reason: 'config' }; }
        const turnId = makeStableId('turn');
        store.append({ id: makeStableId('msg'), turnId: turnId, role: 'user', content: content });
        return drive(turnId);
      },
      async retry(turnId) {
        if (active) { notice = '正在处理上一轮；请先停止。'; emit(); return { accepted: false, reason: 'busy' }; }
        const messages = store.getMessages();
        const last = messages.filter(m => m.role === 'user' && m.visible !== false).pop();
        if (!last || last.turnId !== turnId) { notice = '只能重试最近一轮。'; emit(); return { accepted: false }; }
        // Failed retry rows are replaced in place; an old button cannot launch another attempt.
        const pending = messages.filter(m => m.turnId === turnId && m.role === 'assistant').pop();
        if (!pending || !['failed', 'cancelled', 'interrupted'].includes(pending.status)) {
          notice = '本轮没有可重试的失败回复。'; emit(); return { accepted: false };
        }
        store.update(pending.id, { status: 'retried' });
        return drive(turnId);
      },
      async approve(actionId) {
        if (active) { notice = '正在处理上一轮；请稍后执行。'; emit(); return false; }
        const saved = store.getAction(actionId);
        if (!saved || saved.status !== 'pending') return false;
        const message = store.getMessages().find(m => m.id === saved.messageId && m.status === 'complete');
        if (!message) return false;
        const token = begin(message.turnId);
        const cfg = opts.getConfig ? opts.getConfig() : opts.config;
        try {
          await refreshTools(token); ensure(token);
          const action = actionRecords(message).find(a => a.id === actionId);
          if (!action || action.error) throw Error(action && action.error || '动作无效');
          if (await runAction(action, token, true)) {
            if (cfg && current(token)) await loop(token, cfg);
          }
        } catch (error) { if (current(token)) { notice = String(error.message || error); emit(); } }
        finally { end(token); }
        return true;
      },
      ignore(actionId) {
        const a = store.getAction(actionId);
        if (a && a.status === 'pending') { store.setAction(actionId, { status: 'ignored' }); emit(); }
      },
      stop: stop,
      clear() { stop(''); epoch += 1; store.clear(); notice = '对话已清空。'; emit(); },
      actionsFor: actionRecords,
      refreshTools() { return refreshTools(null).then(() => { emit(); return tools; }); },
    };
  }

  root.SB_AI_CHAT = {
    normalizeCfg: normalizeCfg,
    parseActionBlocks: parseActionBlocks,
    createSseParser: createSseParser,
    createChatStore: createChatStore,
    createChatEngine: createChatEngine,
    createModelEngine: createChatEngine,
    createToolBridge: createToolBridge,
    normalizeTool: normalizeTool,
    validateToolArgs: validateToolArgs,
    toolSucceeded: toolSucceeded,
    requestChat: requestChat,
    makeStableId: makeStableId,
    EFFORTS: EFFORTS,
    FORMATS: FORMATS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SB_AI_CHAT;

  /* ---------------- 界面与流程 ---------------- */

  const CFG_KEY = 'structboard.ai.provider';
  const POS_KEY = 'structboard.ai.widget.pos';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ZCode 自定义厂商式：选接口格式，路径后缀由格式决定
  const FORMAT_OPTIONS = [
    { value: 'openai-chat', label: 'OpenAI · Chat Completions（主流）', suffix: '/chat/completions', placeholder: 'https://api.openai.com/v1' },
    { value: 'openai-responses', label: 'OpenAI · Responses（新版 GPT-5）', suffix: '/responses', placeholder: 'https://api.openai.com/v1' },
    { value: 'anthropic', label: 'Anthropic · Messages（Claude）', suffix: '/v1/messages', placeholder: 'https://api.anthropic.com' },
  ];
  const FORMAT_SHORT = { 'openai-chat': 'OAI·Chat', 'openai-responses': 'OAI·Resp', 'anthropic': 'Anthropic' };

  const SYSTEM_PROMPT = [
    '你是 StructBoard（构境）蛋白质结构工作台的 AI 助手，用简体中文回答，简洁专业。',
    '你面前是用户本机的工作台：可以读取步骤、文件夹、成员、指标（通过动作）。',
    '',
    '你可以通过动作块操作工作台。格式（在普通回复文字之后）：',
    '```sb-action',
    '{"action":"动作名","args":{...}}',
    '```',
    '规则：',
    '1. 一次只输出一个动作块；输出后停下等结果，不要假设结果。',
    '2. 仅工具清单明确标记 readOnly:true 的动作会自动执行；改变数据或视图的动作须先等用户确认。',
    '3. 工具结果会作为隐藏的系统结果消息回传；ok:false 或 error 必须解释失败，不得说已成功。',
    '4. 整理建议要给出理由（依据指标/分组）；不要发明不存在的步骤或成员；成员身份用 describe 返回的 sourceKey。',
    '5. 指标解读：iptm/ptm 越高越好，interface_pae 越低越好；排序看用户当前筛选。',
  ].join('\n');

  const QUICK_ASKS = [
    { label: '解释当前步骤', text: '请读取工作台，用几句话解释现在每个步骤是什么、各自有多少结构。' },
    { label: '找异常候选', text: '请读取工作台的指标，找出表现异常（明显偏离同组）的候选并说明理由。' },
    { label: '整理建议', text: '请基于指标与分组，给出一个整理文件夹的方案；确认后我会逐个执行你给出的动作。' },
  ];

  function loadCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (!raw) return null;
      // 旧版本配置缺 format 等字段：归一化迁移，而不是让界面显示 undefined
      const res = normalizeCfg(raw);
      if (!res.ok) return null;
      return res.cfg;
    } catch (e) { return null; }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function loadPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null') || null; }
    catch (e) { return null; }
  }
  function savePos(pos) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ }
  }

  function init() {
    if (!root.SB_HARNESS && !root.SB_APP_OPERATIONS && !root.SB_ACTIONS) return;
    let cfg = loadCfg();
    const chatStore = createChatStore(null, 'structboard.ai.transcript.v1', {
      secrets: function () { return cfg && cfg.apiKey ? [cfg.apiKey] : []; },
    });
    const engine = createChatEngine({ store: chatStore, getConfig: function () { return cfg; } });

    const {box:rootEl,bubble, bubbleLogo, statusDot, panel, head, headGrip, btnExport, btnClear, btnSettings, btnClose, msgs, chips, composer, input, sendBtn, stopBtn, foot}=root.SB_UI.createSurface('assistantPanel');
    QUICK_ASKS.forEach(function(q){const c=el('button','ai-chip',q.label);c.type='button';c.addEventListener('click',function(){send(q.text);});chips.appendChild(c);});
    document.body.appendChild(rootEl);

    /* ---- 设置弹层 ---- */
    const mask = el('div', 'ai-settings-mask'); mask.hidden = true;
    const {box:card}=root.SB_UI.createSurface('assistantSettings');

    mask.appendChild(card);
    document.body.appendChild(mask);

    function paintFormatUI() {
      const fmt = $('aiSetFormat').value;
      const opt = FORMAT_OPTIONS.find(function (f) { return f.value === fmt; }) || FORMAT_OPTIONS[0];
      $('aiSetSuffix').textContent = '自动拼接路径：' + opt.suffix;
      $('aiSetUrl').placeholder = opt.placeholder;
      $('aiSetKey').placeholder = fmt === 'anthropic' ? 'sk-ant-…' : 'sk-…';
    }
    $('aiSetFormat').addEventListener('change', paintFormatUI);

    /* ---- 状态渲染：DOM 只投影状态，重画不会触发动作 ---- */
    function paintStatus() {
      const state = engine.getState();
      statusDot.hidden = false;
      statusDot.dataset.state = cfg ? 'ok' : 'empty';
      statusDot.title = cfg ? ('已配置：' + cfg.model) : '未配置供应商';
      const provider = cfg ? ((FORMAT_SHORT[cfg.format] || 'OAI·Chat') + ' · ' + cfg.model
        + (cfg.effort !== 'off' ? ' · 思考 ' + cfg.effort : '') + (cfg.stream ? ' · 流式' : ''))
        : '未配置供应商——点右上齿轮设置';
      foot.textContent = state.notice || (state.busy ? '正在处理；可停止，下一条输入会保留。' : provider);
      msgs.setAttribute('aria-busy', state.busy ? 'true' : 'false');
      stopBtn.hidden = !state.busy;
      sendBtn.disabled = state.busy;
      sendBtn.title = state.busy ? '处理中，输入已保留' : '发送';
    }
    const transcript=root.SB_UI.mountTranscript(msgs,{approve:id=>engine.approve(id),ignore:id=>engine.ignore(id),retry:id=>engine.retry(id)});
    function paintMsgs() {
      const history=engine.getState().messages.filter(m=>m.visible!==false&&m.status!=='retried');
      const messages=history.map(function(message){
        const row={id:message.id,role:message.role,turnId:message.turnId,parts:[]};
        if(message.role!=='assistant')row.parts.push({type:'text',text:message.content});
        else if(message.status==='streaming')row.parts.push({type:'text',text:message.content||'正在回复…',typing:!message.content});
        else {
          const records=engine.actionsFor(message);let index=0;
          for(const part of parseActionBlocks(message.content)){
            if(part.type==='text'){if(part.text.trim())row.parts.push({type:'text',text:part.text.trim()});}
            else row.parts.push(actionModel(part,records[index++],message));
          }
          if(!row.parts.length&&message.status==='complete')row.parts.push({type:'text',text:'（空回复）'});
          if(message.status&&message.status!=='complete')row.error=message.error||'回复未完成';
        }
        return row;
      });
      if(!messages.length)messages.push({id:'welcome',role:'assistant',parts:[{type:'text',text:'你好！我是 StructBoard AI。我可以解释步骤、分析指标、并在你确认后整理文件夹或筛选结构。对话会保存在本机，可导出。'+(cfg?'':'先点右上齿轮配置供应商。')}]});
      transcript.update({messages,busy:engine.getState().busy});
    }
    function actionModel(part,action,message) {
      action=action||{};
      const row={type:'action',id:action.id,name:action.name||'(未知动作)',args:JSON.stringify(action.args||{},null,1),runnable:false};
      if(part.error){row.status=part.error;row.args='';return row;}
      const saved=chatStore.getAction(action.id),state=saved&&saved.status;
      const labels={succeeded:'已执行',failed:'执行失败',ignored:'已忽略',running:'执行中…',interrupted:'上次执行结果未知，不会重复执行',invalid:'动作无效',limited:'已达自动执行上限'};
      if(state&&state!=='pending'){row.status=(labels[state]||state)+(saved.error?'：'+saved.error:'');row.ok=state==='succeeded'||state==='ignored';row.result=saved.result;return row;}
      if(message.status!=='complete'){row.status='回复未完成，动作未执行';return row;}
      if(action.error&&!saved){row.status=action.error;return row;}
      if(action.readOnly){row.status='只读动作，等待本轮执行；重开面板不会重放';row.ok=true;return row;}
      row.runnable=true;return row;
    }
    function send(text) {
      const run = engine.send(text);
      if (!cfg) openSettings();
      return run;
    }
    function submitInput() {
      const value = input.value;
      // Rejections (busy, missing config, or empty input) retain the draft.
      if (engine.getState().busy || !cfg || !String(value || '').trim()) { send(value); return; }
      send(value);
      input.value = ''; input.style.height = 'auto';
    }
    stopBtn.addEventListener('click', function () { engine.stop(); });
    btnExport.addEventListener('click', function () {
      const blob = new Blob([chatStore.exportText()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = el('a'); link.href = url;
      link.download = 'StructBoard-AI-' + new Date().toISOString().slice(0, 10) + '.txt';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    engine.subscribe(function () { paintStatus(); paintMsgs(); });

    /* ---- 拖拽与开合 ---- */
    let open = false;
    function setOpen(next) {
      open = next;
      panel.hidden = !open;
      bubble.classList.toggle('is-open', open);
      // 面板展开时藏起悬浮球，避免球被面板盖住后点不到“收起”
      bubble.classList.toggle('is-hidden-by-panel', open);
      if (open) {
        paintStatus(); paintMsgs();
        // 面板显示后才能量尺寸：锚定悬浮球定位（球在底部 → 面板在上方，反之亦然）
        requestAnimationFrame(syncPanelToBubble);
        setTimeout(function () { input.focus(); }, 60);
      }
    }
    bubble.addEventListener('click', function () { setOpen(!open); });
    btnClose.addEventListener('click', function () { setOpen(false); });

    function clampPos(x, y) {
      const maxX = window.innerWidth - 64, maxY = window.innerHeight - 64;
      return {
        x: Math.max(8, Math.min(maxX - 8, x)),
        y: Math.max(8, Math.min(maxY - 8, y)),
      };
    }
    function applyPos() {
      const pos = loadPos();
      if (!pos) return;
      const c = clampPos(pos.x, pos.y);
      bubble.style.left = c.x + 'px';
      bubble.style.top = c.y + 'px';
      bubble.style.right = 'auto';
      bubble.style.bottom = 'auto';
      if (open) syncPanelToBubble();
    }
    function syncPanelToBubble() {
      const b = bubble.getBoundingClientRect();
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      const pw = panel.offsetWidth || 380, ph = panel.offsetHeight || 520;
      let x = b.left + b.width / 2 - pw / 2;
      let y = b.top - ph - 12;
      if (y < 8) y = b.bottom + 12;
      x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
      y = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    }
    function makeDraggable(target, isBubble) {
      let startX = 0, startY = 0, origX = 0, origY = 0, moved = false, pid = 0;
      target.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        if (!isBubble && e.target.closest('button, input, textarea, select')) return;
        pid = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        const r = bubble.getBoundingClientRect();
        origX = r.left; origY = r.top;
        moved = false;
        try { target.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      target.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pid || (!e.buttons && e.pointerType === 'mouse')) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        moved = true;
        rootEl.classList.add('is-dragging');
        const c = clampPos(origX + dx, origY + dy);
        bubble.style.left = c.x + 'px';
        bubble.style.top = c.y + 'px';
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
        if (open) syncPanelToBubble();
      });
      const finish = function (e) {
        if (e.pointerId !== pid) return;
        pid = 0;
        rootEl.classList.remove('is-dragging');
        if (moved) {
          const r = bubble.getBoundingClientRect();
          savePos({ x: Math.round(r.left), y: Math.round(r.top) });
          if (isBubble) e.preventDefault(); // 拖完不算点击
        } else if (!isBubble) {
          // 头部空点：不处理
        }
      };
      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
    }
    makeDraggable(bubble, true);
    makeDraggable(head, false);
    // 拖动面板头结束时不触发 header 按钮点击
    head.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      if (head._dragMoved) { e.stopPropagation(); head._dragMoved = false; }
    }, true);

    btnSettings.addEventListener('click', openSettings);
    btnClear.addEventListener('click', function () {
      engine.clear();
    });
    mask.addEventListener('click', function (e) { if (e.target === mask) closeSettings(); });
    card.querySelector('#aiSetCancel').addEventListener('click', closeSettings);
    card.querySelector('#aiSetSave').addEventListener('click', function (e) { e.preventDefault(); saveSettings(); });
    card.addEventListener('submit', function (e) { e.preventDefault(); saveSettings(); });
    card.querySelector('#aiSetTest').addEventListener('click', testSettings);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!mask.hidden) { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
      if (open) { setOpen(false); }
    }, true);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitInput();
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    sendBtn.addEventListener('click', submitInput);

    function openSettings() {
      $('aiSetFormat').value = cfg ? cfg.format : 'openai-chat';
      $('aiSetUrl').value = cfg ? cfg.baseUrl : '';
      $('aiSetKey').value = cfg ? cfg.apiKey : '';
      $('aiSetModel').value = cfg ? cfg.model : '';
      $('aiSetEffort').value = cfg ? cfg.effort : 'off';
      $('aiSetStream').checked = cfg ? cfg.stream !== false : true;
      $('aiSetExtra').value = cfg ? cfg.extra : '';
      $('aiSetTestOut').textContent = '';
      paintFormatUI();
      mask.hidden = false;
      requestAnimationFrame(function () { mask.classList.add('open'); });
      setTimeout(function () { $('aiSetUrl').focus(); }, 50);
    }
    function closeSettings() {
      mask.classList.remove('open');
      setTimeout(function () { mask.hidden = true; }, 180);
    }
    function collectSettings() {
      return normalizeCfg({
        format: $('aiSetFormat').value,
        baseUrl: $('aiSetUrl').value,
        apiKey: $('aiSetKey').value,
        model: $('aiSetModel').value,
        effort: $('aiSetEffort').value,
        stream: $('aiSetStream').checked,
        extra: $('aiSetExtra').value,
      });
    }
    function saveSettings() {
      const res = collectSettings();
      if (!res.ok) {
        $('aiSetTestOut').textContent = res.error;
        $('aiSetTestOut').dataset.state = 'error';
        return;
      }
      if (engine.getState().busy) engine.stop('供应商设置已更改，请重试本轮。');
      cfg = res.cfg;
      saveCfg(cfg);
      closeSettings();
      paintStatus();
      paintMsgs();
    }
    async function testSettings() {
      const res = collectSettings();
      const out = $('aiSetTestOut');
      if (!res.ok) {
        out.textContent = res.error; out.dataset.state = 'error'; return;
      }
      out.dataset.state = 'busy';
      out.textContent = '测试中…';
      const t0 = performance.now();
      try {
        const body = {
          format: res.cfg.format,
          baseUrl: res.cfg.baseUrl, apiKey: res.cfg.apiKey, model: res.cfg.model,
          stream: false,
          messages: [{ role: 'user', content: '只回复两个字母：OK' }],
        };
        if (res.cfg.effort !== 'off') body.reasoning_effort = res.cfg.effort;
        const text = await requestChat(body);
        out.textContent = '连通 ✓ ' + Math.round(performance.now() - t0) + 'ms · 回复「' + String(text).trim().slice(0, 20) + '」';
        out.dataset.state = 'ok';
      } catch (err) {
        out.textContent = '失败：' + String(err.message || err);
        out.dataset.state = 'error';
      }
    }

    /* ---- 启动 ---- */
    paintStatus();
    paintMsgs();
    engine.refreshTools().catch(function () { /* bridge may finish initializing after the widget */ });
    applyPos();
    // 供主界面直达：打开对话面板 / 直达供应商设置
    root.SB_AI_CHAT.openPanel = function () { setOpen(true); };
    root.SB_AI_CHAT.openSettingsUI = function () { setOpen(true); openSettings(); };
    window.addEventListener('resize', function () {
      const r = bubble.getBoundingClientRect();
      const c = clampPos(r.left, r.top);
      bubble.style.left = c.x + 'px';
      bubble.style.top = c.y + 'px';
      if (open) syncPanelToBubble();
    });
  }

  if (typeof document === 'undefined') return; // 纯函数环境（回归测试）不注入界面
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window === 'undefined' ? globalThis : window);
