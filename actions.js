/* StructBoard action layer: a small, auditable command surface.
   AI (and scripts) only ever call act(name, args) against a whitelist;
   every entry carries a schema, a mutates flag, and unified error shaping.
   Pure module: no DOM, no app state — handlers are registered by app.js. */
(function (root) {
  'use strict';
  const MAX_TEXT = 5000, MAX_NAME = 60, MAX_LIST = 2000;
  const TYPES = ['string', 'number', 'boolean', 'array', 'object'];

  const registry = new Map();

  function checkScalar(kind, value) {
    if (kind === 'string') return typeof value === 'string';
    if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (kind === 'boolean') return typeof value === 'boolean';
    if (kind === 'array') return Array.isArray(value);
    if (kind === 'object') return !!(value && typeof value === 'object' && !Array.isArray(value));
    return false;
  }

  function validateValue(rule, value, key) {
    const kind = rule.type || 'string';
    if (!checkScalar(kind, value)) return '参数 ' + key + ' 必须是 ' + kind;
    if (rule.enum && !rule.enum.includes(value)) return '参数 ' + key + ' 不在允许值中';
    if (kind === 'string') {
      const max = rule.max === undefined ? (rule.name ? MAX_NAME : MAX_TEXT) : rule.max;
      if (value.length > max) return '参数 ' + key + ' 超过 ' + max + ' 字符';
      if (value.length < (rule.min || 0) || (rule.name && !value.trim())) return '参数 ' + key + ' 不能为空';
      if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) return '参数 ' + key + ' 格式非法';
    }
    if (kind === 'number') {
      if (rule.integer && !Number.isInteger(value)) return '参数 ' + key + ' 必须是整数';
      if (rule.min !== undefined && value < rule.min) return '参数 ' + key + ' 不能小于 ' + rule.min;
      if (rule.max !== undefined && value > rule.max) return '参数 ' + key + ' 不能大于 ' + rule.max;
    }
    if (kind === 'array') {
      const max = rule.max === undefined ? MAX_LIST : rule.max;
      if (value.length > max) return '参数 ' + key + ' 超过 ' + max + ' 项';
      if (value.length < (rule.min || 0)) return '参数 ' + key + ' 项数不足';
      if (rule.unique && new Set(value).size !== value.length) return '参数 ' + key + ' 不能重复';
      if (rule.item === 'string' && value.some(v => typeof v !== 'string')) return '参数 ' + key + ' 的每一项都必须是字符串';
      const itemRule = rule.items || (rule.item ? { type: rule.item } : null);
      if (itemRule) for (let i = 0; i < value.length; i++) {
        const error = validateValue(itemRule, value[i], key + '[' + i + ']');
        if (error) return error;
      }
    }
    if (kind === 'object' && rule.properties) return validateArgs({ args: rule.properties }, value);
    return null;
  }
  // 验证原始对象：多余字段在 handler 之前拒绝，默认值只在验证后补入。
  function validateArgs(spec, args) {
    const schema = spec.args || {};
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) return '未知参数 ' + key;
    }
    for (const key of Object.keys(schema)) {
      const rule = schema[key] || {};
      const present = Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
      if (!present) {
        if (rule.required) return '缺少参数 ' + key;
        continue;
      }
      const error = validateValue(rule, args[key], key);
      if (error) return error;
    }
    return null;
  }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function jsonSchema(rules) {
    const properties = {}, required = [];
    for (const key of Object.keys(rules)) {
      const rule = rules[key], kind = rule.type || 'string';
      const out = { type: kind === 'number' && rule.integer ? 'integer' : kind };
      if (rule.required) required.push(key);
      if (rule.default !== undefined) out.default = copy(rule.default);
      if (rule.enum) out.enum = copy(rule.enum);
      if (rule.pattern) out.pattern = rule.pattern;
      if (kind === 'string') {
        out.maxLength = rule.max === undefined ? (rule.name ? MAX_NAME : MAX_TEXT) : rule.max;
        if (rule.min || rule.name) out.minLength = rule.min || 1;
      } else if (kind === 'array') {
        out.maxItems = rule.max === undefined ? MAX_LIST : rule.max;
        if (rule.min !== undefined) out.minItems = rule.min;
        if (rule.unique) out.uniqueItems = true;
        if (rule.items) out.items = jsonSchema({ item: rule.items }).properties.item;
        else if (rule.item) out.items = { type: rule.item, ...(rule.item === 'string' ? { maxLength: MAX_TEXT } : {}) };
      } else if (kind === 'number') {
        if (rule.min !== undefined) out.minimum = rule.min;
        if (rule.max !== undefined) out.maximum = rule.max;
      } else if (kind === 'object' && rule.properties) Object.assign(out, jsonSchema(rule.properties));
      properties[key] = out;
    }
    return { type: 'object', properties: properties, required: required, additionalProperties: false };
  }

  function define(name, spec) {
    if (!name || typeof name !== 'string') throw Error('动作名必须是字符串');
    if (registry.has(name)) throw Error('动作重复注册: ' + name);
    if (!spec || typeof spec.handler !== 'function') throw Error('动作缺少 handler: ' + name);
    if (spec.args) {
      for (const key of Object.keys(spec.args)) {
        const rule = spec.args[key] || {};
        if (rule.type && !TYPES.includes(rule.type)) throw Error('动作 ' + name + ' 参数 ' + key + ' 类型非法');
        if (rule.required && rule.default !== undefined) throw Error('动作 ' + name + ' 参数 ' + key + ' 不能同时 required 和 default');
      }
    }
    registry.set(name, {
      name: name,
      handler: spec.handler,
      args: copy(spec.args || {}),
      description: String(spec.description || ''),
      mutates: !!spec.mutates,
      readOnly: spec.readOnly === undefined ? !spec.mutates : !!spec.readOnly,
      permissionScope: String(spec.permissionScope || (spec.mutates ? 'workspace.write' : 'workspace.read')),
    });
    return name;
  }

  function applyDefaults(spec, args) {
    const out = Object.assign({}, args);
    for (const key of Object.keys(spec.args || {})) {
      const rule = spec.args[key];
      if (!Object.prototype.hasOwnProperty.call(out, key) || out[key] === undefined) {
        if (rule && rule.default !== undefined) out[key] = copy(rule.default);
      }
    }
    return out;
  }

  async function act(name, args) {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      return { ok: false, action: name, error: 'args 必须是对象' };
    }
    const spec = registry.get(name);
    if (!spec) {
      const known = Array.from(registry.keys());
      return { ok: false, action: name, error: '未知动作: ' + name + '（可用: ' + known.join(', ') + '）' };
    }
    const input = args || {};
    const invalid = validateArgs(spec, input);
    if (invalid) return { ok: false, action: name, error: invalid };
    const finalArgs = applyDefaults(spec, input);
    try {
      const result = await spec.handler(finalArgs);
      return Object.assign({ ok: true, action: name, mutates: spec.mutates }, result || {});
    } catch (error) {
      return { ok: false, action: name, error: error.message || String(error) };
    }
  }

  function list() {
    return Array.from(registry.values()).map(function (spec) {
      return {
        name: spec.name,
        description: spec.description,
        mutates: spec.mutates,
        readOnly: spec.readOnly,
        permissionScope: spec.permissionScope,
        inputSchema: jsonSchema(spec.args),
        args: Object.keys(spec.args).map(function (key) {
          const rule = spec.args[key] || {};
          return Object.assign({ key: key, type: rule.type || 'string', required: !!rule.required }, copy(rule));
        }),
      };
    });
  }

  function has(name) { return registry.has(name); }
  function clearForTest() { registry.clear(); }

  const api = { define: define, act: act, list: list, has: has, clearForTest: clearForTest,
    LIMITS: { MAX_TEXT: MAX_TEXT, MAX_NAME: MAX_NAME, MAX_LIST: MAX_LIST } };
  root.SB_ACTIONS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
