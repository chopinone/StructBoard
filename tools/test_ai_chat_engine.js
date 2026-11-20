'use strict';

// Run: node tools/test_ai_chat_engine.js. All requests and storage are in-memory stubs.
const assert = require('node:assert/strict');
const A = require('../ai_chat.js');
const config = { format: 'openai-chat', baseUrl: 'https://stub.invalid/v1', apiKey: 'fake-secret-for-test', model: 'stub', stream: true, effort: 'off' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const block = (action, args = {}) => '```sb-action\n' + JSON.stringify({ action, args }) + '\n```';
const plain = value => JSON.parse(JSON.stringify(value));
function memoryStorage() {
  const values = new Map();
  return { values, getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const readSpec = { name: 'sb_list_entries', readOnly: true, inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } };
const writeSpec = { name: 'sb_folder_create', mutates: true, inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false } };
function setup({ request, specs = [readSpec, writeSpec], execute, storage = memoryStorage(), ...options } = {}) {
  const calls = [], requests = [];
  const bridge = A.createToolBridge({ SB_HARNESS: {
    async listTools() { return specs; },
    async execute(name, args, context) { calls.push({ name, args, context }); return execute ? execute(name, args, context) : { ok: true, result: { count: 2 } }; },
  } });
  const store = A.createChatStore(storage, undefined, { secrets: () => [config.apiKey] });
  const engine = A.createChatEngine({ store, bridge, config, ...options,
    request: async (body, onDelta, opts) => { requests.push(body); return request ? request(body, onDelta, opts, requests.length) : '完成'; },
  });
  return { engine, store, calls, requests, storage, bridge };
}
function actionId(store) { return Object.keys(store.getActions())[0]; }
function sseResponse(chunks, extra) {
  let index = 0, cancelled = false;
  const encoder = new TextEncoder();
  const response = { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
    read: async () => index < chunks.length ? { value: encoder.encode(chunks[index++]), done: false } : { done: true },
    cancel: async () => { cancelled = true; },
  }) }, ...extra };
  return { response, isCancelled: () => cancelled };
}

(async function () {
  // A turn owns a single user record. Failed retries reuse it and hidden results enter subsequent payloads.
  {
    const s = setup({ request: async (body, onDelta, opts, n) => {
      if (n === 1) throw Error('simulated offline');
      if (n === 2) return block('sb_list_entries', { limit: 2 });
      assert(body.messages.some(m => m.content.includes('工具 sb_list_entries 结果')));
      return '两个候选';
    } });
    const run = await s.engine.send('读取候选');
    assert.equal(s.store.getMessages().filter(m => m.role === 'user' && m.visible !== false).length, 1);
    await s.engine.retry(run.turnId);
    assert.equal(s.requests.length, 3);
    for (const body of s.requests) assert.equal(body.messages.filter(m => m.content === '读取候选').length, 1);
    assert.equal(s.store.getMessages().filter(m => m.role === 'user' && m.visible !== false).length, 1);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].context.source, 'builtin');
    assert.equal(s.calls[0].context.approved, undefined);
    assert.equal(s.calls[0].context.idempotencyKey, actionId(s.store));
    assert.equal(s.store.getAction(actionId(s.store)).status, 'succeeded');
    const hidden = s.store.getMessages().find(m => m.kind === 'tool-result');
    assert(hidden && hidden.visible === false && hidden.id && hidden.turnId);
    assert.match(s.requests[0].messages[0].content, /inputSchema/);
    assert.match(s.requests[0].messages[0].content, /maximum/);
    assert.match(s.requests[0].messages[0].content, /additionalProperties/);
    assert.equal(s.requests[0].tools, undefined, 'explicit sb-action schemas are the cross-provider fallback');
  }

  // Stop/Clear cancels the actual signal and old request callbacks cannot modify a newer turn.
  for (const mode of ['stop', 'clear']) {
    const old = deferred();
    let oldDelta, oldSignal;
    const s = setup({ request: (body, onDelta, opts, n) => {
      if (n === 1) { oldDelta = onDelta; oldSignal = opts.signal; onDelta('旧回复'); return old.promise; }
      return '新回复';
    } });
    const running = s.engine.send('旧问题');
    for (let i = 0; i < 12 && !oldDelta; i++) await tick();
    assert(oldDelta);
    const rejected = await s.engine.send('保留的草稿');
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'busy');
    assert.match(s.engine.getState().notice, /输入已保留/);
    s.engine[mode]();
    assert.equal(oldSignal.aborted, true);
    await s.engine.send('新问题');
    const before = JSON.stringify(s.store.snapshot());
    oldDelta(block('sb_list_entries'));
    old.resolve(block('sb_list_entries'));
    await running; await tick();
    assert.equal(JSON.stringify(s.store.snapshot()), before);
    assert.equal(s.calls.length, 0);
    assert.equal(s.engine.getState().busy, false);
    if (mode === 'clear') assert(!s.store.getMessages().some(m => m.content === '旧问题'));
  }

  // A delayed old tool can neither release a new turn's busy state nor enqueue a model followup.
  {
    const tool = deferred(), newRequest = deferred();
    const s = setup({ execute: () => tool.promise, request: (b, d, o, n) => n === 1 ? block('sb_list_entries') : newRequest.promise });
    const first = s.engine.send('旧读取');
    for (let i = 0; i < 12 && !s.calls.length; i++) await tick();
    assert.equal(s.calls.length, 1);
    s.engine.stop();
    const second = s.engine.send('新读取');
    for (let i = 0; i < 12 && s.requests.length < 2; i++) await tick();
    tool.resolve({ ok: true, result: { late: true } });
    await first; await tick();
    assert.equal(s.engine.getState().busy, true);
    assert.equal(s.requests.length, 2);
    assert.equal(s.store.getMessages().filter(m => m.kind === 'tool-result').length, 0);
    newRequest.resolve('新读取完成');
    await second;
  }

  // Mutable/unknown metadata cards wait for click; state persists and concurrent/reloaded clicks do not replay.
  {
    const write = deferred();
    const s = setup({ request: async (b, d, o, n) => n === 1 ? block('sb_folder_create', { name: '候选' }) : '文件夹已处理', execute: () => write.promise });
    await s.engine.send('创建文件夹');
    const id = actionId(s.store);
    assert.equal(s.store.getAction(id).status, 'pending');
    assert.equal(s.calls.length, 0);
    const approval = s.engine.approve(id);
    for (let i = 0; i < 12 && !s.calls.length; i++) await tick();
    assert.equal(s.store.getAction(id).status, 'running');
    assert.equal(await s.engine.approve(id), false);
    assert.equal(s.calls[0].context.approved, true);
    assert.equal(s.calls[0].context.idempotencyKey, id);
    const during = A.createChatStore(s.storage);
    assert.equal(during.getAction(id).status, 'interrupted');
    const resumed = A.createChatEngine({ store: during, bridge: s.bridge, config, request: async () => 'unexpected' });
    assert.equal(await resumed.approve(id), false);
    write.resolve({ ok: true, result: { saved: true } });
    await approval;
    assert.equal(s.store.getAction(id).status, 'succeeded');
    const reloaded = A.createChatStore(s.storage);
    const again = A.createChatEngine({ store: reloaded, bridge: s.bridge, config });
    assert.equal(await again.approve(id), false);
    assert.equal(s.calls.length, 1);
    assert.match(reloaded.exportText(), /succeeded/);
  }
  for (const spec of [{ name: 'unmarked', mutates: false, inputSchema: { type: 'object' } },
    { name: 'view.setSearch', mutates: false, inputSchema: { type: 'object' } }]) {
    const s = setup({ specs: [spec], request: async () => block(spec.name) });
    await s.engine.send('改变视图');
    assert.equal(s.calls.length, 0);
    assert.equal(s.store.getAction(actionId(s.store)).status, 'pending');
    s.engine.ignore(actionId(s.store));
    assert.equal(s.store.getAction(actionId(s.store)).status, 'ignored');
    assert.equal(await s.engine.approve(actionId(s.store)), false);
  }

  // Failure envelopes (including nested errors and thrown handlers) are recorded, never labeled success.
  for (const result of [{ ok: false, error: 'denied' }, { ok: true, result: { ok: false, error: 'nested failure' } }, { result: {} }, new Error('handler exploded')]) {
    const s = setup({ request: async (b, d, o, n) => n === 1 ? block('sb_list_entries') : '执行失败，等待处理',
      execute: () => { if (result instanceof Error) throw result; return result; } });
    await s.engine.send('读取');
    assert.equal(s.store.getAction(actionId(s.store)).status, 'failed');
    assert.equal(s.requests.length, 2);
    assert(s.requests[1].messages.some(m => m.content.includes('工具 sb_list_entries 结果')));
  }

  // Invalid schemas and multiple blocks remain inert. Followups are strictly bounded and sequential.
  for (const content of [block('sb_list_entries', { limit: 'two' }), block('sb_folder_create', {}),
    block('unknown'), block('sb_list_entries', { injected: true }), block('sb_list_entries') + block('sb_list_entries')]) {
    const s = setup({ request: async () => content });
    await s.engine.send('校验');
    assert.equal(s.calls.length, 0);
    assert(Object.values(s.store.getActions()).every(a => a.status === 'invalid'));
  }
  {
    const s = setup({ request: async () => block('sb_list_entries'), maxFollowups: 2 });
    await s.engine.send('循环');
    assert.equal(s.requests.length, 3);
    assert.equal(s.calls.length, 2);
    assert.equal(s.store.getMessages().filter(m => m.kind === 'tool-result').length, 2);
    assert.equal(Object.values(s.store.getActions()).filter(a => a.status === 'limited').length, 1);
  }

  // Only the separate bounded transcript key is written; context is ephemeral and secrets are redacted.
  {
    const storage = memoryStorage();
    const specs = [{ name: 'sb_get_context', readOnly: true, inputSchema: { type: 'object', properties: {} } }];
    const s = setup({ storage, specs, execute: async () => ({ ok: true, result: { snapshot: 'PRIVATE-SNAPSHOT', apiKey: config.apiKey } }),
      request: async (b, d, o, n) => n === 1 ? block('sb_get_context') : '密钥 ' + config.apiKey });
    await s.engine.send('上下文');
    const persisted = [...storage.values.values()].join('');
    assert.deepEqual([...storage.values.keys()], ['structboard.ai.transcript.v1']);
    assert(!persisted.includes('PRIVATE-SNAPSHOT'));
    assert(!persisted.includes(config.apiKey));
    assert(!s.store.exportText().includes(config.apiKey));
    assert(!s.store.exportText().includes('PRIVATE-SNAPSHOT'));
    assert(s.requests[0].messages.some(m => m.content.includes('PRIVATE-SNAPSHOT')), 'live context still reaches model');
    const store = A.createChatStore(memoryStorage(), 'bounded', { maxMessages: 3, maxText: 20, maxTotal: 40 });
    for (let i = 0; i < 8; i++) store.append({ role: 'user', content: String(i).repeat(100) });
    assert(store.getMessages().length <= 3);
    assert(store.getMessages().reduce((n, m) => n + m.content.length, 0) <= 45);
  }

  // Fallback resolution uses async HARNESS first, then APP operations, then legacy actions.
  {
    const names = [], host = {
      SB_HARNESS: { listTools: async () => [readSpec], execute: async () => { names.push('harness'); return { ok: true }; } },
      SB_APP_OPERATIONS: { listTools: async () => [writeSpec], execute: async () => { names.push('app'); return { ok: true }; } },
      SB_ACTIONS: { list: () => [{ name: 'workspace.describe', mutates: false, args: [{ key: 'limit', type: 'number' }] }, { name: 'view.setSearch', mutates: false, args: [] }], act: async () => { names.push('legacy'); return { ok: true }; } },
    };
    const bridge = A.createToolBridge(host);
    assert.equal((await bridge.listTools())[0].name, 'sb_list_entries'); await bridge.execute('x', {});
    delete host.SB_HARNESS;
    assert.equal((await bridge.listTools())[0].name, 'sb_folder_create'); await bridge.execute('x', {});
    delete host.SB_APP_OPERATIONS;
    const legacy = await bridge.listTools();
    assert.equal(legacy[0].readOnly, true); assert.equal(legacy[1].readOnly, false);
    assert.equal(legacy[0].inputSchema.properties.limit.type, 'number'); await bridge.execute('x', {});
    assert.deepEqual(names, ['harness', 'app', 'legacy']);
  }

  // Streaming terminal/finish/error states, partial UTF-8, EOF, HTTP errors, deadlines and abort.
  {
    const stream = sseResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n', 'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]']);
    assert.equal(await A.requestChat({}, null, { fetch: async () => stream.response }), '你好');
    assert.equal(stream.isCancelled(), true);
    for (const events of [
      ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
      ['data: {"error":{"message":"overloaded"}}\n\ndata: [DONE]\n\n'],
      ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n'],
      ['data: {"type":"response.incomplete"}\n\n'],
      ['data: invalid-json\n\ndata: [DONE]\n\n'],
      ['data: [DONE]\n\n'],
    ]) {
      const stub = sseResponse(events);
      await assert.rejects(A.requestChat({}, null, { fetch: async () => stub.response }));
      assert.equal(stub.isCancelled(), true);
    }
    await assert.rejects(A.requestChat({}, null, { fetch: async () => ({ ok: false, status: 503, headers: { get: () => 'text/plain' } }) }), /HTTP 503/);
    let signal;
    await assert.rejects(A.requestChat({}, null, { timeoutMs: 10, fetch: async (u, o) => { signal = o.signal; return new Promise(() => {}); } }), /停止/);
    assert.equal(signal.aborted, true);
    const controller = new AbortController(), hanging = deferred();
    const pending = A.requestChat({}, null, { signal: controller.signal, fetch: async () => hanging.promise });
    controller.abort();
    await assert.rejects(pending, /停止/);
  }
  // A turn deadline also applies to a hung tool-list request.
  {
    const e = A.createChatEngine({ store: A.createChatStore(memoryStorage()), config, turnTimeoutMs: 10,
      bridge: { listTools: () => new Promise(() => {}) }, request: async () => 'unexpected' });
    await e.send('hung');
    assert.equal(e.getState().busy, false);
    assert.match(e.getState().notice, /超时/);
  }
  console.log('AI CHAT ENGINE OK (retry/history, interleaving, abort, persistent cards, schemas, bounded loop, privacy, SSE failures)');
})().catch(error => { console.error(error); process.exitCode = 1; });
