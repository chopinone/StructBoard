'use strict';
// Run: node tools/test_ai_chat_ui.js. Executes actual widget event handlers against a local DOM fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ai_chat.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(res => { resolve = res; }); return { resolve, promise }; };

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.listeners = {}; this.style = {};
    this.dataset = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ''; this.className = '';
    this.classList = {
      add: value => { this.className += ' ' + value; },
      remove: value => { this.className = this.className.split(/\s+/).filter(v => v !== value).join(' '); },
      toggle: (value, on) => { const has = this.className.split(/\s+/).includes(value); if (on === undefined ? !has : on) this.classList.add(value); else this.classList.remove(value); },
    };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) {
    this.replaceChildren();
    // Only the settings form IDs are queried; decorative SVG markup needs no raster behavior.
    for (const match of String(value).matchAll(/<(input|select|textarea|button|span)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const child = new Element(match[1], this.doc); child.id = match[2]; this.append(child);
    }
  }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  fire(type, props = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of this.listeners[type] || []) fn(event);
  }
  click() { if (!this.disabled) this.fire('click'); }
  matches(selector) { return selector[0] === '#' ? this.id === selector.slice(1) : selector[0] === '.' ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector.split(/,\s*/).some(s => this.matches(s)) ? this : (this.parentElement && this.parentElement.closest(selector)); }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 500, top: 600, width: 64, height: 64, bottom: 664 }; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  setPointerCapture() {}
}

(async () => {
  const doc = { readyState: 'complete', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, createElement(tag) { return new Element(tag, this); } };
  doc.body = new Element('body', doc);
  doc.getElementById = id => doc.body.querySelector('#' + id);
  const saved = new Map([['structboard.ai.provider', JSON.stringify({ baseUrl: 'https://stub.invalid/v1', model: 'stub', apiKey: 'fake-ui-key', stream: true })]]);
  const localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  let active, requestCount = 0;
  const calls = [], downloads = [], timers = new Set();
  const window = {
    innerWidth: 1400, innerHeight: 900, addEventListener() {},
    SB_HARNESS: {
      listTools: async () => [{ name: 'sb_folder_create', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, mutates: true }],
      execute: async (name, args, context) => { calls.push({ name, args, context }); return { ok: true, result: { saved: true } }; },
    },
    fetch: async (url, opts) => {
      requestCount++;
      active = { signal: opts.signal, packets: [], waiting: null, cancelled: false };
      const current = active;
      return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
        read() { if (current.packets.length) return Promise.resolve(current.packets.shift()); current.waiting = deferred(); return current.waiting.promise; },
        cancel() { current.cancelled = true; if (current.waiting) current.waiting.resolve({ done: true }); return Promise.resolve(); },
      }) } };
    },
  };
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => { downloads.push(blob); return 'blob:local-fixture'; };
  TestURL.revokeObjectURL = () => {};
  function schedule(fn, delay) { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; }
  const context = vm.createContext({ window, document: doc, localStorage, URL: TestURL, Blob, AbortController, TextDecoder,
    setTimeout: schedule, clearTimeout(id) { timers.delete(id); clearTimeout(id); }, requestAnimationFrame: fn => fn(), console, performance });
  window.SB_UI={createSurface:require('./surface_fixture.cjs')(doc)};
  const {transcriptTree}=await import('../frontend/views/transcript-tree.mjs');
  function h(tag,props,children){const node=doc.createElement(tag);for(const [key,value] of Object.entries(props||{})){
    if(key==='key')continue;if(key==='class')node.className=value;else if(key==='disabled')node.disabled=!!value;else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);else node.setAttribute(key,value);
  }for(const child of Array.isArray(children)?children:[children]){if(child==null)continue;if(typeof child==='object')node.appendChild(child);else {const text=doc.createElement('span');text.textContent=String(child);node.appendChild(text);}}return node;}
  window.SB_UI.mountTranscript=(host,handlers)=>({update:model=>host.replaceChildren(...transcriptTree(h,model,handlers)),dispose:()=>host.replaceChildren()});

  vm.runInContext(source, context);
  const A = window.SB_AI_CHAT;
  A.openPanel();
  const input = doc.body.querySelector('.ai-input');
  const panel = doc.body.querySelector('.ai-panel');
  const send = doc.body.querySelector('.ai-send');
  const stop = doc.body.querySelector('.ai-composer').children.find(node => node.textContent === '停止');
  const findTitle = title => doc.body.querySelectorAll('button').find(node => node.title === title);
  const waitFor = async fn => { for (let i = 0; i < 30 && !fn(); i++) await tick(); assert(fn()); };
  const chunk = text => {
    const packet = { value: new TextEncoder().encode(text), done: false };
    if (active.waiting) { const waiter = active.waiting; active.waiting = null; waiter.resolve(packet); } else active.packets.push(packet);
  };
  const enter = text => { input.value = text; input.fire('keydown', { key: 'Enter', shiftKey: false }); };
  try {
    enter('第一条');
    await waitFor(() => active && active.waiting);
    assert.equal(input.value, '');
    assert.equal(stop.hidden, false);
    enter('第二条草稿');
    assert.equal(input.value, '第二条草稿');
    assert.match(doc.body.querySelector('.ai-foot').textContent, /输入已保留/);
    chunk('data: {"choices":[{"delta":{"content":"流式开头"}}]}\n\n');
    await waitFor(() => doc.body.querySelector('.ai-msgs').textContent.includes('流式开头'));
    findTitle('收起').click();
    assert.equal(panel.hidden, true);
    A.openPanel();
    assert(doc.body.querySelector('.ai-msgs').textContent.includes('流式开头'));
    chunk('data: {"choices":[{"delta":{"content":"，完成"}}]}\n\ndata: [DONE]\n\n');
    await waitFor(() => stop.hidden);
    assert(doc.body.querySelector('.ai-msgs').textContent.includes('流式开头，完成'));
    assert.equal(input.value, '第二条草稿');
    assert.equal(requestCount, 1);

    findTitle('清空对话').click();
    enter('会停止的请求');
    await waitFor(() => active && active.waiting && requestCount === 2);
    const stoppedRequest = active;
    stop.click();
    await waitFor(() => stop.hidden);
    assert.equal(stoppedRequest.signal.aborted, true);
    assert.equal(stoppedRequest.cancelled, true);
    assert.match(doc.body.querySelector('.ai-msgs').textContent, /已停止/);
    assert.equal(doc.body.querySelectorAll('button').filter(node => node.textContent === '重试本轮').length, 1);

    findTitle('清空对话').click();
    enter('创建一个文件夹');
    await waitFor(() => active && active.waiting && requestCount === 3);
    const content = '```sb-action\n{"action":"sb_folder_create","args":{"name":"候选"}}\n```';
    chunk('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n');
    await waitFor(() => stop.hidden);
    assert.equal(calls.length, 0);
    findTitle('收起').click(); A.openPanel();
    const execute = doc.body.querySelectorAll('button').find(node => node.textContent === '执行');
    assert(execute && !execute.disabled);
    execute.click();
    await waitFor(() => calls.length === 1 && requestCount === 4 && active.waiting);
    assert.equal(calls[0].context.approved, true);
    findTitle('收起').click(); A.openPanel();
    assert(doc.body.querySelector('.ai-msgs').textContent.includes('已执行'));
    assert.equal(doc.body.querySelectorAll('button').filter(node => node.textContent === '执行').length, 0);
    chunk('data: {"choices":[{"delta":{"content":"文件夹完成"}}]}\n\ndata: [DONE]\n\n');
    await waitFor(() => stop.hidden);
    assert.equal(calls.length, 1);
    findTitle('导出本机对话').click();
    assert.equal(downloads.length, 1);
    const exported = await downloads[0].text();
    assert.match(exported, /sb_folder_create/);
    assert(!exported.includes('fake-ui-key'));
    console.log('AI CHAT UI OK (busy draft, reopen streaming, Stop signal, persistent card repaint, local export)');
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
