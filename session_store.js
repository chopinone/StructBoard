/* Atomic session metadata and local structure payloads, with independent recovery backups. */
(function (root) {
  'use strict';
  const VERSION = 2;
  const IMPORT_BACKUP_KEY = 'snapshot.before-pipeline-import';
  const BACKUP_KEYS = ['snapshot.before-membership-v2', IMPORT_BACKUP_KEY];
  function pack(snapshot, revision) {
    const bodies = [];
    const entries = (snapshot.entries || []).map(function (entry, i) {
      const next = Object.assign({}, entry);
      if (entry.data && (entry.data.byteLength || entry.data.length)) {
        const key = revision + ':' + i;
        bodies.push({ key: key, data: entry.data });
        next.data = '';
        next.dataRef = key;
      } else delete next.dataRef;
      return next;
    });
    return { snapshot: Object.assign({}, snapshot, { storageVersion: VERSION, entries: entries }), bodies: bodies };
  }
  function create(indexedDB, name) {
    let sequence = Promise.resolve(), serial = 0, defaultKey = 'snapshot';
    const storeId = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() :
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    function nextRevision() { return storeId + ':' + Date.now().toString(36) + '-' + (++serial); }
    function normalizeKey(value) {
      const key = typeof value === 'string' && value.trim() ? value.trim() : defaultKey;
      if (key.length > 240 || /[\u0000-\u001f]/.test(key)) throw Error('工作区存储标识无效');
      return key;
    }
    function open() {
      return new Promise(function (resolve, reject) {
        if (!indexedDB) { reject(Error('当前环境不支持本地保存')); return; }
        const req = indexedDB.open(name || 'structboard_session', VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('entry-data')) db.createObjectStore('entry-data');
        };
        req.onsuccess = function () {
          req.result.onversionchange = function () { req.result.close(); };
          resolve(req.result);
        };
        req.onerror = function () { reject(req.error || Error('打开工作区存储失败')); };
        req.onblocked = function () { reject(Error('工作区存储升级被其他窗口占用，请关闭旧窗口')); };
      });
    }
    function enqueue(work) {
      const result = sequence.then(work);
      sequence = result.catch(function () {});
      return result;
    }
    function keepReferences(snapshot, keep) {
      ((snapshot || {}).entries || []).forEach(function (entry) {
        if (entry.dataRef) keep.add(entry.dataRef);
      });
    }
    function collectGarbage(kv, data, keep, preserveKeys) {
      preserveKeys = preserveKeys || [];
      let pending = BACKUP_KEYS.length + preserveKeys.length + 1;
      function ready() {
        if (--pending) return;
        const cursor = data.openCursor();
        cursor.onsuccess = function () {
          const row = cursor.result;
          if (!row) return;
          if (!keep.has(row.key)) row.delete();
          row.continue();
        };
      }
      BACKUP_KEYS.concat(preserveKeys).forEach(function (key) {
        const req = kv.get(key);
        req.onsuccess = function () {
          keepReferences(req.result, keep);
          ready();
        };
      });
      const tabs = kv.openCursor();
      tabs.onsuccess = function () {
        const row = tabs.result;
        if (!row) { ready(); return; }
        if (typeof row.key === 'string' && (row.key.startsWith('workspace:') || row.key === 'snapshot' || row.key === 'snapshot.previous')) keepReferences(row.value, keep);
        row.continue();
      };
    }
    function backupBeforeImport(snapshot, options) {
      options = options || {};
      const key = normalizeKey(options.key), backupKey = key === 'snapshot' ? IMPORT_BACKUP_KEY : key + '.beforeImport';
      return enqueue(async function () {
        const prepared = pack(snapshot, nextRevision());
        const db = await open();
        try {
          await new Promise(function (resolve, reject) {
            const tx = db.transaction(['kv', 'entry-data'], 'readwrite');
            tx.oncomplete = resolve;
            tx.onabort = function () { reject(tx.error || Error('导入前备份事务已取消')); };
            tx.onerror = function () { /* onabort reports the transaction failure */ };
            try {
              const kv = tx.objectStore('kv'), data = tx.objectStore('entry-data');
              prepared.bodies.forEach(function (row) { data.put(row.data, row.key); });
              kv.put(prepared.snapshot, backupKey);
            } catch (error) {
              tx.abort();
              reject(error);
            }
          });
        } finally { db.close(); }
      });
    }
    function save(snapshot, options) {
      options = options || {};
      const key = normalizeKey(options.key);
      const previousKey = key === 'snapshot' ? 'snapshot.previous' : key + '.previous';
      const importBackupKey = key === 'snapshot' ? IMPORT_BACKUP_KEY : key + '.beforeImport';
      const prepared = pack(snapshot, nextRevision());
      const backup = options.beforeImport && pack(options.beforeImport, nextRevision());
      return enqueue(async function () {
        const db = await open();
        try {
          await new Promise(function (resolve, reject) {
            const tx = db.transaction(['kv', 'entry-data'], 'readwrite');
            const kv = tx.objectStore('kv'), data = tx.objectStore('entry-data');
            const previous = kv.get(key);
            previous.onsuccess = function () {
              try {
                if (options.check) options.check();
                if (previous.result) kv.put(previous.result, previousKey);
                if (backup) {
                  backup.bodies.forEach(function (row) { data.put(row.data, row.key); });
                  kv.put(backup.snapshot, importBackupKey);
                }
                prepared.bodies.forEach(function (row) { data.put(row.data, row.key); });
                kv.put(prepared.snapshot, key);
                const keep = new Set(prepared.bodies.map(function (row) { return row.key; }));
                keepReferences(previous.result, keep);
                collectGarbage(kv, data, keep, [previousKey, importBackupKey]);
              } catch (error) {
                tx.abort();
                reject(error);
              }
            };
            tx.oncomplete = resolve;
            tx.onabort = function () { reject(tx.error || Error('工作区保存事务已取消')); };
            tx.onerror = function () { /* onabort reports the transaction failure */ };
          });
        } finally { db.close(); }
      });
    }
    async function read(db, key) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(['kv', 'entry-data'], 'readonly');
        let snapshot = null, failure = null;
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = function () {
          snapshot = req.result || null;
          if (!snapshot) return;
          snapshot.entries = (snapshot.entries || []).map(function (e) { return Object.assign({}, e); });
          snapshot.entries.forEach(function (entry) {
            if (!entry.dataRef) return;
            const body = tx.objectStore('entry-data').get(entry.dataRef);
            body.onsuccess = function () {
              if (body.result === undefined) failure = Error('工作区结构正文缺失：' + entry.name);
              else entry.data = body.result;
            };
          });
        };
        tx.oncomplete = function () { if (failure) reject(failure); else resolve(snapshot); };
        tx.onabort = function () { reject(tx.error || Error('读取工作区失败')); };
      });
    }
    async function load(key) {
      key = normalizeKey(key);
      await sequence;
      const db = await open();
      try { return await read(db, key); }
      finally { db.close(); }
    }
    function clear(key) {
      key = normalizeKey(key);
      const previousKey = key === 'snapshot' ? 'snapshot.previous' : key + '.previous';
      return enqueue(async function () {
        const db = await open();
        try {
          await new Promise(function (resolve, reject) {
            const tx = db.transaction(['kv', 'entry-data'], 'readwrite');
            const kv = tx.objectStore('kv');
            kv.delete(key);
            kv.delete(previousKey);
            collectGarbage(kv, tx.objectStore('entry-data'), new Set(), [previousKey]);
            tx.oncomplete = resolve;
            tx.onabort = function () { reject(tx.error || Error('清理工作区失败')); };
          });
        } finally { db.close(); }
      });
    }
    return { save: save, load: load, clear: clear, backupBeforeImport: backupBeforeImport,
      setKey: function (key) { const previous = defaultKey; defaultKey = normalizeKey(key); return previous; },
      getKey: function () { return defaultKey; } };
  }
  const api = { VERSION: VERSION, IMPORT_BACKUP_KEY: IMPORT_BACKUP_KEY, pack: pack, create: create };
  root.SB_SESSION_STORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
