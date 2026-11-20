'use strict';

// Run: node tools/test_ai_chat.js
// Exercises the pure helpers from ai_chat.js: provider config validation,
// sb-action block extraction, and cross-chunk SSE parsing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../ai_chat.js'), 'utf8');

const context = vm.createContext({
  window: {}, Object, Array, String, Number, Boolean, JSON, Error, RegExp, URL, console,
});
vm.runInContext(source, context);
const A = context.window.SB_AI_CHAT;
assert(A, 'SB_AI_CHAT must be exported');

// 1. normalizeCfg
{
  const ok = A.normalizeCfg({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-x', model: 'gpt-5.1', effort: 'high', stream: false, extra: '{"temperature":0.2}' });
  assert.equal(ok.ok, true);
  assert.equal(ok.cfg.baseUrl, 'https://api.openai.com/v1', 'trailing slash stripped');
  assert.equal(ok.cfg.effort, 'high');
  assert.equal(ok.cfg.stream, false);
  assert.equal(ok.cfg.effort, 'high');

  const loop = A.normalizeCfg({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' });
  assert.equal(loop.ok, true, 'loopback http allowed');

  const bad = [
    [{}, /baseUrl/],
    [{ baseUrl: 'ftp://x', model: 'm' }, /https/],
    [{ baseUrl: 'http://evil.example.com', model: 'm' }, /https/],
    [{ baseUrl: 'not a url', model: 'm' }, /URL/],
    [{ baseUrl: 'https://api.openai.com/v1' }, /模型名/],
    [{ baseUrl: 'https://x', model: 'm', extra: '{bad' }, /JSON/],
    [{ baseUrl: 'https://x', model: 'm', extra: '[1,2]' }, /对象/],
  ];
  for (const [input, re] of bad) {
    const res = A.normalizeCfg(input);
    assert.equal(res.ok, false, 'expected reject: ' + JSON.stringify(input));
    if (re) assert.match(res.error, re);
  }
  // 未知 effort 宽容回落到 off（UI 下拉不会产生非法值）
  const lenient = A.normalizeCfg({ baseUrl: 'https://x', model: 'm', effort: 'turbo' });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.cfg.effort, 'off');
  const def = A.normalizeCfg({ baseUrl: 'https://x', model: 'm' });
  assert.equal(def.cfg.effort, 'off', 'effort defaults to off');
  assert.equal(def.cfg.format, 'openai-chat', 'format defaults to openai-chat');
  const fmts = A.normalizeCfg({ baseUrl: 'https://api.anthropic.com', model: 'claude', format: 'anthropic' });
  assert.equal(fmts.ok, true);
  assert.equal(fmts.cfg.format, 'anthropic');
  // 未知格式宽容回落（UI 下拉不会产生非法值），与 effort 的处理一致
  const badFmt = A.normalizeCfg({ baseUrl: 'https://x', model: 'm', format: 'gemini' });
  assert.equal(badFmt.ok, true);
  assert.equal(badFmt.cfg.format, 'openai-chat');
  assert.equal(def.cfg.stream, true, 'stream defaults on');
}

// 2. parseActionBlocks
{
  const single = A.parseActionBlocks('好的。\n```sb-action\n{"action":"organize.createFolder","args":{"name":"X"}}\n```');
  assert.equal(single.length, 2);
  assert.equal(single[0].type, 'text');
  assert.match(single[0].text, /好的/);
  assert.equal(single[1].type, 'action');
  assert.equal(single[1].json.action, 'organize.createFolder');

  const multi = A.parseActionBlocks('a```sb-action\n{"action":"p1"}\n```b```sb-action\n{"action":"p2"}\n```c');
  assert.deepEqual(JSON.parse(JSON.stringify(multi.map(p => p.type))), ['text', 'action', 'text', 'action', 'text']);
  assert.equal(multi[1].json.action, 'p1');
  assert.equal(multi[3].json.action, 'p2');

  const none = A.parseActionBlocks('普通回复，没有动作');
  assert.equal(none.length, 1);
  assert.equal(none[0].type, 'text');

  const broken = A.parseActionBlocks('```sb-action\n{not json}\n```');
  assert.equal(broken[0].type, 'action');
  assert.match(broken[0].error, /合法 JSON/);

  const empty = A.parseActionBlocks('');
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), []);
}

// 3. createSseParser — cross-chunk safety
{
  const p = A.createSseParser();
  const pieces = [];
  const feed = s => p.push(s).forEach(ev => { if (ev.delta) pieces.push(ev.delta); });
  feed('data: {"choices":[{"delta":{"content":"你"}}]}\n');
  feed('data: {"choices":[{"del');
  feed('ta":{"content":"好"}}]}\n\n');
  feed(': keep-alive comment\n');
  feed('data: [DONE]\n\n');
  assert.equal(pieces.join(''), '你好');
  const done = p.push('');
  assert.deepEqual(JSON.parse(JSON.stringify(done)), []);
  // SSE without trailing newline stays buffered, not emitted twice
  const q = A.createSseParser();
  assert.deepEqual(JSON.parse(JSON.stringify(q.push('data: {"choices":[{"delta":{"content":"x"}}]}'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(q.push('\n').filter(e => e.delta))), [{ delta: 'x' }]);
}

console.log('ai chat helpers ok (cfg validation incl. loopback rule, action blocks, streaming parser)');
