'use strict';

// Run: node tools/test_actions.js
// Executes the real actions.js registry: schema validation, defaults, unified
// result shaping, duplicate rejection, and list()/mutates metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../actions.js'), 'utf8');

const context = vm.createContext({
  window: {}, Object, Map, Array, String, Number, Boolean, Error, Promise, console,
});
vm.runInContext(source, context);
const A = context.window.SB_ACTIONS;
// Objects returned from the vm realm differ in prototype; compare by JSON value.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
assert(A, 'SB_ACTIONS must be exported on window');

(async () => {
  // 1. Registration shape and duplicate rejection.
  const seen = [];
  A.define('demo.noop', {
    description: '什么都不做',
    mutates: false,
    args: { text: { type: 'string', required: false, default: 'hi', max: 10 } },
    handler: args => ({ echo: args.text }),
  });
  A.define('demo.add', {
    description: '求和',
    mutates: true,
    args: {
      a: { type: 'number', required: true, integer: true },
      list: { type: 'array', required: false, item: 'string', max: 3 },
      flag: { type: 'boolean', required: false, default: false },
    },
    handler: args => ({ sum: args.a + 1, list: args.list, flag: args.flag }),
  });
  assert.throws(() => A.define('demo.noop', { handler: () => {} }), /重复注册/);
  assert.throws(() => A.define('demo.bad', {}), /handler/);
  assert.throws(() => A.define('demo.bad2', {
    handler: () => {}, args: { x: { type: 'function' } },
  }), /类型非法/);
  assert.throws(() => A.define('demo.bad3', {
    handler: () => {}, args: { x: { required: true, default: 1 } },
  }), /required 和 default/);

  // 2. Success path merges metadata and applies defaults.
  {
    const res = await A.act('demo.noop', {});
    same(res, { ok: true, action: 'demo.noop', mutates: false, echo: 'hi' });
  }
  {
    const res = await A.act('demo.add', { a: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.sum, 3);
    assert.deepEqual(res.list, undefined, 'unset array stays unset');
    assert.equal(res.flag, false, 'boolean default applied');
    assert.equal(res.mutates, true);
  }

  // 3. Validation errors never reach the handler.
  let handlerHits = 0;
  A.define('demo.guard', {
    mutates: true,
    args: { a: { type: 'number', required: true }, s: { type: 'string', max: 4 } },
    handler: () => { handlerHits++; return {}; },
  });
  {
    const missing = await A.act('demo.guard', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /缺少参数 a/);
    const wrong = await A.act('demo.guard', { a: 'x' });
    assert.match(wrong.error, /必须是 number/);
    const long = await A.act('demo.guard', { a: 1, s: 'toolong' });
    assert.match(long.error, /超过 4 字符/);
    const badList = await A.act('demo.add', { a: 1, list: [1] });
    assert.match(badList.error, /每一项都必须是字符串/);
    const tooMany = await A.act('demo.add', { a: 1, list: ['1', '2', '3', '4'] });
    assert.match(tooMany.error, /超过 3 项/);
    const nonInt = await A.act('demo.add', { a: 1.5 });
    assert.match(nonInt.error, /必须是整数/);
    const badArgs = await A.act('demo.add', [1]);
    assert.match(badArgs.error, /args 必须是对象/);
    assert.equal(handlerHits, 0, 'invalid calls must not invoke handlers');
    const unknownKey = await A.act('demo.guard', { a: 1, hidden: true });
    assert.match(unknownKey.error, /未知参数 hidden/);
    A.define('demo.bounds', {
      args: { count: { type: 'number', integer: true, min: 1, max: 8 }, mode: { type: 'string', enum: ['grid', 'overlay'] } },
      handler: () => { handlerHits++; },
    });
    assert.match((await A.act('demo.bounds', { count: 0 })).error, /不能小于 1/);
    assert.match((await A.act('demo.bounds', { count: 9 })).error, /不能大于 8/);
    assert.match((await A.act('demo.bounds', { mode: 'arbitrary' })).error, /不在允许值中/);
    assert.equal(handlerHits, 0, 'unknown fields and bounds must not invoke handlers');
  }

  // 4. Unknown action lists what exists; handler throws become ok:false.
  {
    const unknown = await A.act('demo.nope');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /demo\.noop/);
    A.define('demo.boom', { mutates: true, handler: () => { throw Error('后端炸了'); } });
    const boom = await A.act('demo.boom');
    same(boom, { ok: false, action: 'demo.boom', error: '后端炸了' });
  }

  // 5. list() exposes the contract an AI client needs.
  {
    const list = A.list();
    const add = list.find(x => x.name === 'demo.add');
    same(add, {
      name: 'demo.add',
      description: '求和',
      mutates: true,
      readOnly: false,
      permissionScope: 'workspace.write',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'integer' },
          list: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 5000 } },
          flag: { type: 'boolean', default: false },
        },
        required: ['a'], additionalProperties: false,
      },
      args: [
        { key: 'a', type: 'number', required: true, integer: true },
        { key: 'list', type: 'array', required: false, item: 'string', max: 3 },
        { key: 'flag', type: 'boolean', required: false, default: false },
      ],
    });
    assert(list.every(x => x.mutates === false || x.mutates === true));
  }

  console.log('actions registry ok (schemas, defaults, guard-before-handler, unknown listing, contract list)');
})().catch(error => { console.error(error); process.exit(1); });
