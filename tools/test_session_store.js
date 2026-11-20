'use strict';

// Dependency-free runner for the HTML storage regression suite. This deliberately
// small IndexedDB fixture keeps every database in memory and models request
// ordering, structured cloning, transaction commit/abort, and cursor deletion.
// Real browser IndexedDB coverage remains available in test_session_store.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sessionStore = require('../session_store.js');

function createMemoryIndexedDB() {
  const databases = new Map();
  function checkName(name) {
    assert.match(name, /^structboard_session_test_/,
      'Storage tests must only open isolated test databases');
  }
  function startNext(database) {
    if (database.active || !database.pending.length) return;
    database.active = database.pending.shift();
    database.active.start();
  }
  class Transaction {
    constructor(database, names, mode) {
      this.database = database;
      this.names = typeof names === 'string' ? [names] : names;
      this.mode = mode;
      this.jobs = [];
      this.finished = false;
      this.started = false;
      this.error = null;
      this.names.forEach(name => assert.ok(database.stores.has(name), 'Unknown object store: ' + name));
      database.pending.push(this);
      setImmediate(() => startNext(database));
    }
    start() {
      if (this.finished) return;
      this.started = true;
      this.stores = new Map(this.names.map(name => [name, new Map(this.database.stores.get(name))]));
      setImmediate(() => this.step());
    }
    release() {
      if (this.database.active === this) this.database.active = null;
      else this.database.pending = this.database.pending.filter(tx => tx !== this);
      startNext(this.database);
    }
    abort() {
      assert.ok(!this.finished, 'Cannot abort a finished transaction');
      this.finished = true;
      setImmediate(() => {
        if (this.onabort) this.onabort({ target: this });
        this.release();
      });
    }
    step() {
      if (this.finished) return;
      const job = this.jobs.shift();
      if (!job) {
        if (this.mode === 'readwrite') {
          this.stores.forEach((rows, name) => this.database.stores.set(name, rows));
        }
        this.finished = true;
        if (this.oncomplete) this.oncomplete({ target: this });
        this.release();
        return;
      }
      try { job(); }
      catch (error) {
        this.error = error;
        if (this.onerror) this.onerror({ target: this });
        if (!this.finished) this.abort();
      }
      setImmediate(() => this.step());
    }
    request(work, request) {
      assert.ok(!this.finished, 'Cannot queue work in a finished transaction');
      const req = request || {};
      this.jobs.push(() => {
        req.result = work();
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    }
    objectStore(name) {
      assert.ok(this.names.includes(name), 'Object store outside transaction scope');
      const rows = () => this.stores.get(name);
      const writable = () => assert.equal(this.mode, 'readwrite');
      return {
        get: key => this.request(() => structuredClone(rows().get(key))),
        getAllKeys: () => this.request(() => Array.from(rows().keys()).sort()),
        put: (value, key) => {
          writable();
          // IndexedDB clones synchronously: DataCloneError must precede enqueueing.
          const copy = structuredClone(value);
          return this.request(() => { rows().set(key, copy); return key; });
        },
        delete: key => {
          writable();
          return this.request(() => { rows().delete(key); });
        },
        openCursor: () => {
          const req = {};
          let keys, index = 0;
          const next = () => this.request(() => {
            if (!keys) keys = Array.from(rows().keys()).sort();
            if (index >= keys.length) return null;
            const key = keys[index++];
            return {
              key: key,
              value: structuredClone(rows().get(key)),
              delete: () => {
                writable();
                return this.request(() => { rows().delete(key); });
              },
              continue: next
            };
          }, req);
          return next();
        }
      };
    }
  }
  return {
    open: function (name, version) {
      checkName(name);
      const req = {};
      setImmediate(() => {
        let database = databases.get(name);
        if (!database) {
          database = { version: 0, stores: new Map(), pending: [], active: null };
          databases.set(name, database);
        }
        const requestedVersion = version || database.version || 1;
        if (requestedVersion < database.version) {
          req.error = Error('VersionError');
          if (req.onerror) req.onerror({ target: req });
          return;
        }
        let closed = false;
        req.result = {
          objectStoreNames: { contains: name => database.stores.has(name) },
          createObjectStore: name => {
            assert.ok(!database.stores.has(name));
            database.stores.set(name, new Map());
          },
          close: () => { closed = true; },
          transaction: (names, mode) => {
            assert.ok(!closed, 'Database connection must be open');
            return new Transaction(database, names, mode);
          }
        };
        if (requestedVersion > database.version) {
          database.version = requestedVersion;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase: function (name) {
      checkName(name);
      const database = databases.get(name);
      assert.ok(!database || (!database.active && !database.pending.length), 'Transactions must finish before cleanup');
      databases.delete(name);
      return {};
    }
  };
}

async function main() {
  const html = fs.readFileSync(path.join(__dirname, 'test_session_store.html'), 'utf8');
  const inlineScripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
  assert.equal(inlineScripts.length, 1, 'Expected one shared HTML regression suite');
  const result = { textContent: '' };
  const document = {
    documentElement: { dataset: {} },
    getElementById: id => { assert.equal(id, 'result'); return result; }
  };
  const run = new Function('SB_SESSION_STORE', 'indexedDB', 'document',
    'return ' + inlineScripts[0][1].trim());
  await run(sessionStore, createMemoryIndexedDB(), document);
  const report = JSON.parse(result.textContent);
  assert.equal(document.documentElement.dataset.testResult, 'pass', report.error);
  assert.equal(report.ok, true, report.error);
  console.log(JSON.stringify({ ok: true, fixture: 'in-memory IndexedDB', checks: report.checks.length, names: report.checks }, null, 2));
}

const timeout = setTimeout(() => {
  console.error('Session storage regression suite timed out');
  process.exit(1);
}, 120000);
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(timeout));
