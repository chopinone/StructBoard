/* Per-step workspace folders. Display-only: never writes PDB/CIF or lineage. */
(function (root) {
  'use strict';
  const LIMIT = 50;
  const NOTE_WINDOW_MS = 600;
  const history = { undo: [], redo: [], note: null };

  function empty() {
    return { folders: [], dissolved: [], placements: {}, removed: [], notes: {}, layout: { version: 1, parents: {} } };
  }
  function clone(org) {
    return JSON.parse(JSON.stringify(org && typeof org === 'object' ? org : empty()));
  }
  function isEmpty(org) {
    if (!org) return true;
    const notes = org.notes || {};
    const hasNotes = Object.keys(notes).some(function (k) { return String(notes[k] || '').trim(); });
    const layout = org.layout && org.layout.parents;
    const hasLayout = !!(layout && Object.keys(layout).some(function (k) {
      const slots = layout[k] && layout[k].slots;
      return slots && Object.keys(slots).length;
    }));
    return !(org.folders && org.folders.length) &&
      !(org.dissolved && org.dissolved.length) &&
      !(org.removed && org.removed.length) &&
      !Object.keys(org.placements || {}).length &&
      !hasNotes &&
      !hasLayout;
  }
  function ensure(store, stepKey) {
    if (!store[stepKey]) store[stepKey] = empty();
    return store[stepKey];
  }
  function normalizeParent(parentId) {
    if (parentId == null || parentId === '' || parentId === 'root') return null;
    return String(parentId);
  }
  function sanitizeFolders(raw) {
    const folders = [];
    const ids = new Set();
    (Array.isArray(raw) ? raw : []).forEach(function (f) {
      if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || !f.id || ids.has(f.id)) return;
      ids.add(f.id);
      folders.push({ id: f.id, name: f.name, parentId: normalizeParent(f.parentId) });
    });
    const known = new Set(folders.map(function (f) { return f.id; }));
    folders.forEach(function (f) {
      if (f.parentId && f.parentId.indexOf('lineage:') !== 0 && !known.has(f.parentId)) f.parentId = null;
    });
    folders.forEach(function (start) {
      const seen = new Set();
      let current = start;
      while (current && current.parentId && known.has(current.parentId)) {
        if (seen.has(current.id)) {
          current.parentId = null;
          break;
        }
        seen.add(current.id);
        current = folders.find(function (f) { return f.id === current.parentId; });
      }
    });
    return folders;
  }
  function placeId(entry) {
    if (!entry) return '';
    if (entry.sourceKey && !isRuntimeKey(entry.sourceKey)) return String(entry.sourceKey);
    if (entry.fileKey && !isRuntimeKey(entry.fileKey)) return String(entry.fileKey);
    // 本地/演示条目没有后端身份时，使用内容与路径组成稳定 key；绝不把运行时 e1/e2
    // 当作 organization 身份，否则重载后新条目会继承旧回收站状态。
    const path = entry.fullPath || entry.path || '';
    const size = Number(entry.size) || 0;
    if (path || entry.name || size) return [path, entry.name || '', size].join('|');
    return '';
  }
  function isRuntimeKey(key) {
    return /^e\d+$/.test(String(key || ''));
  }
  function stableKeyFor(entry) {
    const key = placeId(entry);
    return key && !isRuntimeKey(key) ? key : '';
  }

  /* ---------- 总览格子布局（显示层；slot 为行优先逻辑序号） ----------
     总览拖拽按“手机桌面插入式”提交：抽出拖动项、插入目标位、其余收拢重编号，
     所以正常落点写入的是 dense 0..n-1。schema 仍接受稀疏 slot 以兼容旧数据/特殊场景；
     未布局层按自然顺序标注 slot。空 slot 只是显示空洞，不产生节点。 ---------- */

  const FOLDER_REF_PREFIX = 'folder:';
  function folderNodeKey(node) {
    if (!node || node.kind !== 'folder') return '';
    if (node.id && String(node.id).indexOf('pile:') === 0) return String(node.id);
    if (node.origin === 'user' && node.orgId) return FOLDER_REF_PREFIX + 'user:' + node.orgId;
    return FOLDER_REF_PREFIX + (node.groupKey || node.id || '');
  }
  function refOfNode(node) {
    if (!node) return '';
    if (node.kind === 'entry' && node.entry) return placeId(node.entry);
    if (node.kind === 'folder') return folderNodeKey(node);
    return '';
  }
  function isEntryRef(ref) {
    return !!ref && !isRuntimeKey(ref) &&
      String(ref).indexOf(FOLDER_REF_PREFIX) !== 0 && String(ref).indexOf('pile:') !== 0;
  }
  function normalizeLayoutParents(raw) {
    if (!raw || typeof raw !== 'object' || !raw.parents || typeof raw.parents !== 'object') return null;
    const parents = {};
    Object.keys(raw.parents).forEach(function (parentKey) {
      if (!parentKey || typeof parentKey !== 'string') return;
      const src = raw.parents[parentKey];
      const slotsIn = src && typeof src === 'object' ? (Array.isArray(src.slots) ? src.slots : src.slots && typeof src.slots === 'object' ? src.slots : null) : null;
      if (!slotsIn) return;
      const slots = {};
      const refs = {};
      const used = {};
      const add = function (ref, slot, path) {
        if (!ref || typeof ref !== 'string' || isRuntimeKey(ref)) return;
        const n = Number(slot);
        if (!Number.isInteger(n) || n < 0 || n > 100000) return;
        if (used[n]) return;               // 同一格子只保留先到的引用
        if (slots[ref] !== undefined) return; // 同一引用只保留第一次
        used[n] = true;
        slots[ref] = n;
        if (isEntryRef(ref) && path) refs[ref] = { sourceKey: ref, path: String(path) };
      };
      if (Array.isArray(slotsIn)) {
        slotsIn.forEach(function (row) {
          if (row && typeof row === 'object') add(row.ref || row.sourceKey, row.slot, row.path);
          else if (typeof row === 'string') add(row, undefined, '');
        });
      } else {
        Object.keys(slotsIn).forEach(function (ref) { add(ref, slotsIn[ref], ''); });
      }
      if (Object.keys(slots).length) parents[parentKey] = { slots: slots, refs: refs };
    });
    return Object.keys(parents).length ? { version: 1, parents: parents } : { version: 1, parents: {} };
  }
  function layoutFor(org, parentKey) {
    if (!org || !org.layout || !org.layout.parents) return null;
    const rec = org.layout.parents[parentKey];
    return rec && rec.slots && Object.keys(rec.slots).length ? rec : null;
  }
  // items: [{ ref, slot, path? }] —— 一次放置 = 一次 commit，撤销/重做天然覆盖。
  function setLayout(store, stepKey, parentKey, items) {
    if (!parentKey || typeof parentKey !== 'string') return false;
    let changed = false;
    commit(store, stepKey, function (org) {
      changed = setLayoutRaw(org, parentKey, items);
    });
    return changed;
  }
  function setLayoutRaw(org, parentKey, items) {
    if (!org.layout || typeof org.layout !== 'object') org.layout = { version: 1, parents: {} };
    if (!org.layout.parents || typeof org.layout.parents !== 'object') org.layout.parents = {};
    const before = JSON.stringify(org.layout.parents[parentKey] || null);
    const normalized = normalizeLayoutParents({ parents: (function () {
      const rows = (items || []).map(function (item) {
        return { ref: item && item.ref, slot: item && item.slot, path: item && item.path };
      }).filter(function (row) { return row.ref; });
      const out = {}; out[parentKey] = { slots: rows }; return out;
    })() });
    const next = normalized && normalized.parents[parentKey] ? normalized.parents[parentKey] : undefined;
    if (next) org.layout.parents[parentKey] = next;
    else delete org.layout.parents[parentKey];
    return JSON.stringify(org.layout.parents[parentKey] || null) !== before;
  }
  function clearLayout(store, stepKey, parentKey) {
    commit(store, stepKey, function (org) {
      if (org.layout && org.layout.parents) delete org.layout.parents[parentKey];
    });
  }
  function newId() {
    return 'wf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }
  function relPath(entry) {
    if (!entry) return '';
    if (entry.fetchUrl) {
      try {
        const path = new URL(entry.fetchUrl, 'http://localhost').searchParams.get('path');
        if (path) return String(path).replace(/\\/g, '/');
      } catch (_) { /* ignore */ }
    }
    const p = String(entry.path || '').replace(/\\/g, '/');
    if (p && !/^[A-Za-z]:/.test(p) && p.charAt(0) !== '/') return p;
    return p;
  }
  function matchKey(rec, entries) {
    if (!rec) return '';
    if (rec.sourceKey && entries.some(function (e) { return placeId(e) === rec.sourceKey; })) return rec.sourceKey;
    if (rec.sourceKey && isRuntimeKey(rec.sourceKey)) return '';
    const path = String(rec.path || '').replace(/\\/g, '/');
    if (path) {
      const hit = entries.find(function (e) {
        const rel = relPath(e);
        const full = String(e.fullPath || e.path || '').replace(/\\/g, '/');
        return rel === path || full === path || full.endsWith('/' + path);
      });
      if (hit) return placeId(hit);
    }
    return rec.sourceKey || path || '';
  }

  function serialize(org, entries) {
    const list = entries || [];
    const byKey = {};
    list.forEach(function (e) { byKey[placeId(e)] = e; });
    function rec(key) {
      const e = byKey[key];
      return { sourceKey: key, path: e ? relPath(e) : '' };
    }
    return {
      version: 1,
      folders: sanitizeFolders(org && org.folders).map(function (f) {
        return { id: f.id, name: f.name, parentId: f.parentId || null };
      }),
      dissolved: (org.dissolved || []).slice(),
      placements: Object.keys(org.placements || {}).filter(function (k) {
        return org.placements[k];
      }).map(function (k) {
        return Object.assign(rec(k), { folderId: org.placements[k] });
      }),
      removed: (org.removed || []).map(rec),
      layout: (function () {
        const src = org && org.layout && org.layout.parents;
        if (!src || !Object.keys(src).length) return undefined;
        const parents = {};
        Object.keys(src).forEach(function (parentKey) {
          const rec = src[parentKey];
          if (!rec || !rec.slots) return;
          const rows = Object.keys(rec.slots).map(function (ref) {
            const path = rec.refs && rec.refs[ref] ? rec.refs[ref].path : '';
            return { ref: ref, slot: rec.slots[ref], path: path || undefined };
          });
          parents[parentKey] = { slots: rows };
        });
        return Object.keys(parents).length ? { version: 1, parents: parents } : undefined;
      })(),
      notes: (function () {
        const src = org.notes || {};
        const out = {};
        Object.keys(src).forEach(function (k) {
          const v = String(src[k] || '');
          if (v.trim()) out[k] = v;
        });
        return out;
      }()),
    };
  }
  function hydrate(data, entries) {
    const org = empty();
    if (!data || typeof data !== 'object') return org;
    const list = entries || [];
    org.folders = sanitizeFolders(data.folders);
    org.dissolved = Array.isArray(data.dissolved) ? data.dissolved.filter(function (v) { return typeof v === 'string'; }) : [];
    const placements = {};
    const folderIds = new Set(org.folders.map(function (f) { return f.id; }));
    function addPlacement(row) {
      if (!row || typeof row !== 'object' || !folderIds.has(row.folderId)) return;
      const key = matchKey(row, list);
      if (typeof key === 'string' && key) placements[key] = row.folderId;
    }
    if (Array.isArray(data.placements)) data.placements.forEach(addPlacement);
    else if (data.placements && typeof data.placements === 'object') {
      Object.keys(data.placements).forEach(function (k) {
        addPlacement({ sourceKey: k, path: k, folderId: data.placements[k] });
      });
    }
    org.placements = placements;
    org.removed = (Array.isArray(data.removed) ? data.removed : []).map(function (row) {
      if (typeof row === 'string') return matchKey({ sourceKey: row, path: row }, list);
      return row && typeof row === 'object' ? matchKey(row, list) : '';
    }).filter(function (key) { return typeof key === 'string' && key && !isRuntimeKey(key); });
    org.layout = normalizeLayoutParents(data.layout) || { version: 1, parents: {} };
    org.notes = {};
    if (data.notes && typeof data.notes === 'object' && !Array.isArray(data.notes)) {
      Object.keys(data.notes).forEach(function (k) {
        const v = String(data.notes[k] == null ? '' : data.notes[k]);
        if (v.trim()) org.notes[k] = v;
      });
    }
    return org;
  }
  function rebind(org, entries) {
    if (!org) return org;
    const next = clone(org);
    const placements = {};
    Object.keys(next.placements || {}).forEach(function (k) {
      const key = matchKey({ sourceKey: k, path: k }, entries);
      if (key && !isRuntimeKey(key)) placements[key] = next.placements[k];
    });
    next.placements = placements;
    next.removed = (next.removed || []).map(function (k) {
      return matchKey({ sourceKey: k, path: k }, entries);
    }).filter(function (k) { return k && !isRuntimeKey(k); });
    // 布局引用同样要跟上条目身份：能重新关联的换新 key，稳定但暂时缺席的保留休眠。
    if (next.layout && next.layout.parents) {
      Object.keys(next.layout.parents).forEach(function (parentKey) {
        const rec = next.layout.parents[parentKey];
        if (!rec || !rec.slots) return;
        const slots = {};
        const refs = {};
        Object.keys(rec.slots).forEach(function (ref) {
          let key = ref;
          if (isEntryRef(ref)) {
            const stored = rec.refs && rec.refs[ref];
            key = matchKey({ sourceKey: ref, path: stored ? stored.path : ref }, entries) || ref;
            if (isRuntimeKey(key)) return;
          }
          slots[key] = rec.slots[ref];
          if (isEntryRef(key) && rec.refs && rec.refs[ref]) refs[key] = rec.refs[ref];
        });
        rec.slots = slots;
        rec.refs = refs;
        if (!Object.keys(slots).length) delete next.layout.parents[parentKey];
      });
    }
    return next;
  }

  function commit(store, stepKey, fn) {
    history.note = null;
    const before = clone(store[stepKey]);
    fn(ensure(store, stepKey));
    history.undo.push({ stepKey: stepKey, before: before, after: clone(store[stepKey]) });
    if (history.undo.length > LIMIT) history.undo.shift();
    history.redo = [];
    return store[stepKey];
  }
  function undo(store) {
    history.note = null;
    const item = history.undo.pop();
    if (!item) return null;
    store[item.stepKey] = clone(item.before);
    if (isEmpty(store[item.stepKey])) delete store[item.stepKey];
    history.redo.push(item);
    return item;
  }
  function redo(store) {
    history.note = null;
    const item = history.redo.pop();
    if (!item) return null;
    store[item.stepKey] = clone(item.after);
    history.undo.push(item);
    return item;
  }
  function canUndo() { return history.undo.length > 0; }
  function canRedo() { return history.redo.length > 0; }
  function clearHistory() { history.undo = []; history.redo = []; history.note = null; }

  function folderById(org, id) {
    return (org.folders || []).find(function (f) { return f.id === id; });
  }
  function descendantFolderIds(org, id) {
    const ids = [id];
    (org.folders || []).forEach(function (f) {
      if (f.parentId === id) ids.push.apply(ids, descendantFolderIds(org, f.id));
    });
    return ids;
  }

  function createFolder(store, stepKey, opts) {
    opts = opts || {};
    const id = opts.id || newId();
    const name = String(opts.name || '新建文件夹').trim() || '新建文件夹';
    commit(store, stepKey, function (org) {
      org.folders.push({ id: id, name: name, parentId: normalizeParent(opts.parentId) });
      (opts.entryKeys || []).forEach(function (key) {
        if (key) org.placements[key] = id;
      });
      (opts.nestedFolderIds || []).forEach(function (fid) {
        const f = folderById(org, fid);
        if (f && f.id !== id) f.parentId = id;
      });
    });
    return id;
  }
  function renameFolder(store, stepKey, id, name) {
    const next = String(name || '').trim();
    if (!next) return false;
    commit(store, stepKey, function (org) {
      const f = folderById(org, id);
      if (f) f.name = next;
    });
    return true;
  }
  function dissolveFolder(store, stepKey, node) {
    commit(store, stepKey, function (org) {
      if (node && node.origin === 'user' && node.orgId) {
        const parent = (folderById(org, node.orgId) || {}).parentId || null;
        (node.entries || []).forEach(function (e) {
          const key = placeId(e);
          if (org.placements[key] === node.orgId) {
            if (parent && String(parent).indexOf('lineage:') !== 0) org.placements[key] = parent;
            else delete org.placements[key];
          }
        });
        (org.folders || []).forEach(function (f) {
          if (f.parentId === node.orgId) f.parentId = parent;
        });
        org.folders = org.folders.filter(function (f) { return f.id !== node.orgId; });
        return;
      }
      const mark = (node && (node.groupKey || node.id)) || '';
      if (mark && org.dissolved.indexOf(mark) < 0) org.dissolved.push(mark);
    });
  }
  function removeKeys(store, stepKey, keys) {
    commit(store, stepKey, function (org) {
      keys.forEach(function (key) {
        if (!key || isRuntimeKey(key)) return;
        if (org.removed.indexOf(key) < 0) org.removed.push(key);
        delete org.placements[key];
      });
    });
  }
  function deleteFolder(store, stepKey, node) {
    const keys = (node.entries || []).map(placeId).filter(function (key) { return key && !isRuntimeKey(key); });
    commit(store, stepKey, function (org) {
      keys.forEach(function (key) {
        if (org.removed.indexOf(key) < 0) org.removed.push(key);
        delete org.placements[key];
      });
      if (node.origin === 'user' && node.orgId) {
        const ids = descendantFolderIds(org, node.orgId);
        org.folders = org.folders.filter(function (f) { return ids.indexOf(f.id) < 0; });
        Object.keys(org.placements).forEach(function (k) {
          if (ids.indexOf(org.placements[k]) >= 0) {
            if (!isRuntimeKey(k) && org.removed.indexOf(k) < 0) org.removed.push(k);
            delete org.placements[k];
          }
        });
      }
    });
  }
  function restoreKeys(store, stepKey, keys) {
    commit(store, stepKey, function (org) {
      const stable = (keys || []).filter(function (k) { return k && !isRuntimeKey(k); });
      org.removed = org.removed.filter(function (k) { return stable.indexOf(k) < 0; });
    });
  }
  function moveKeys(store, stepKey, keys, folderId) {
    commit(store, stepKey, function (org) {
      keys.forEach(function (key) {
        if (!key) return;
        org.removed = org.removed.filter(function (k) { return k !== key; });
        if (!folderId || folderId === 'root') delete org.placements[key];
        else org.placements[key] = folderId;
      });
    });
  }
  function reparentFolder(store, stepKey, id, parentId) {
    commit(store, stepKey, function (org) {
      const f = folderById(org, id);
      if (!f || f.id === parentId) return;
      const nested = descendantFolderIds(org, id);
      if (parentId && nested.indexOf(parentId) >= 0) return;
      f.parentId = parentId || null;
    });
  }
  function resetStep(store, stepKey) {
    commit(store, stepKey, function (org) {
      org.folders = [];
      org.dissolved = [];
      org.placements = {};
      org.removed = [];
      org.notes = {};
      org.layout = { version: 1, parents: {} };
    });
  }
  function setNote(store, stepKey, folderId, text) {
    if (!folderId) return;
    const org = ensure(store, stepKey);
    if (!org.notes) org.notes = {};
    const v = String(text || '');
    const before = clone(org);
    if (v.trim()) org.notes[folderId] = v;
    else delete org.notes[folderId];
    const after = clone(org);
    const now = Date.now();
    const last = history.note;
    if (last && last.stepKey === stepKey && last.folderId === folderId && now - last.time <= NOTE_WINDOW_MS) {
      last.item.after = after;
      last.time = now;
      history.redo = [];
    } else {
      const item = { stepKey: stepKey, before: before, after: after, note: true, folderId: folderId };
      history.undo.push(item);
      if (history.undo.length > LIMIT) history.undo.shift();
      history.redo = [];
      history.note = { stepKey: stepKey, folderId: folderId, time: now, item: item };
    }
  }
  function getNote(org, folderId) {
    if (!org || !folderId) return '';
    return String((org.notes || {})[folderId] || '');
  }

  function flattenDissolved(nodes, dissolved, lineage) {
    const set = new Set(dissolved || []);
    const out = [];
    (nodes || []).forEach(function (n) {
      const mark = n.groupKey || n.id;
      if (n.kind === 'folder' && n.origin !== 'user' && n.origin !== 'removed' && set.has(mark)) {
        flattenDissolved(lineage.children(n), dissolved, lineage).forEach(function (child) { out.push(child); });
      } else {
        out.push(n);
      }
    });
    return out;
  }
  function makeUserFolder(rec, entries, children, lineage, stepKey, stepTitle) {
    const items = entries.slice();
    const cover = items[0] || (children[0] && children[0].cover) || null;
    const all = items.slice();
    children.forEach(function (ch) { if (ch.entries) all.push.apply(all, ch.entries); });
    const counts = lineage.summarize(all);
    return {
      kind: 'folder',
      id: 'folder:user:' + rec.id,
      orgId: rec.id,
      origin: 'user',
      groupKind: 'user',
      groupKey: rec.id,
      name: rec.name,
      entries: all,
      directEntries: items,
      cover: cover,
      count: all.length,
      counts: counts,
      countText: all.length ? lineage.countText(counts) : '空文件夹',
      roleText: '工作台文件夹',
      auditEnabled: false,
      children: children.concat(items.map(function (e, i) {
        return { kind: 'entry', entry: e, pos: i + 1, total: items.length, unit: '份结构', auditEnabled: false };
      })),
      stepKey: stepKey,
      stepTitle: stepTitle,
    };
  }
  function findLineageFolder(nodes, groupKey, lineage) {
    if (!groupKey) return null;
    return lineage.find(nodes, 'folder:' + groupKey) || lineage.find(nodes, groupKey) ||
      nodes.find(function (n) { return n.kind === 'folder' && (n.groupKey === groupKey || n.id === groupKey); });
  }
  function apply(nodes, entries, org, opts) {
    opts = opts || {};
    const lineage = opts.lineage || root.SB_LINEAGE;
    const stepKey = opts.stepKey || '';
    const stepTitle = opts.stepTitle || '';
    const grouped = opts.grouped !== false;
    let list = (nodes || []).slice();
    list.forEach(function (n) {
      if (n.kind === 'folder') {
        n.stepKey = n.stepKey || stepKey;
        n.stepTitle = n.stepTitle || stepTitle;
        n.origin = n.origin || 'lineage';
      }
    });
    if (!org || isEmpty(org) || !lineage) return list;

    const removed = new Set(org.removed || []);
    const placed = org.placements || {};
    function shown(e) { return e && !removed.has(placeId(e)); }
    function inUser(e) { const id = placeId(e); return !!(id && placed[id]); }

    const remaining = (entries || []).filter(function (e) { return shown(e) && !inUser(e); });
    list = flattenDissolved(lineage.nodes(remaining, grouped), org.dissolved, lineage);
    list.forEach(function (n) {
      if (n.kind === 'folder') {
        n.stepKey = stepKey;
        n.stepTitle = stepTitle;
        n.origin = n.origin || 'lineage';
      }
    });

    const folders = sanitizeFolders(org.folders);
    const byParent = {};
    folders.forEach(function (f) {
      const p = f.parentId || '';
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(f);
    });
    function buildUser(rec) {
      const kids = (byParent[rec.id] || []).map(buildUser);
      const files = (entries || []).filter(function (e) {
        return shown(e) && placed[placeId(e)] === rec.id;
      });
      return makeUserFolder(rec, files, kids, lineage, stepKey, stepTitle);
    }
    (byParent[''] || byParent[null] || []).concat(byParent.root || []).forEach(function (rec) {
      if (rec.parentId) return;
      list.push(buildUser(rec));
    });
    Object.keys(byParent).forEach(function (parent) {
      if (!parent || parent === 'root') return;
      if (parent.indexOf('lineage:') !== 0) return;
      const gk = parent.slice('lineage:'.length);
      const host = findLineageFolder(list, gk, lineage);
      const extra = byParent[parent].map(buildUser);
      if (!host) extra.forEach(function (n) { list.push(n); });
      else {
        host.children = (host.children || []).concat(extra);
        extra.forEach(function (n) {
          host.entries = (host.entries || []).concat(n.entries || []);
        });
        host.count = (host.entries || []).length;
        host.countText = lineage.countText(lineage.summarize(host.entries || []));
      }
    });

    const hidden = (entries || []).filter(function (e) { return removed.has(placeId(e)); });
    if (hidden.length) {
      const counts = lineage.summarize(hidden);
      list.push({
        kind: 'folder',
        id: 'folder:removed:' + stepKey,
        origin: 'removed',
        groupKind: 'removed',
        groupKey: 'removed:' + stepKey,
        name: '已移除',
        entries: hidden,
        cover: hidden[0],
        count: hidden.length,
        counts: counts,
        countText: hidden.length + ' 份，可还原',
        roleText: '仅工作台隐藏，磁盘文件保留',
        auditEnabled: false,
        children: hidden.map(function (e, i) {
          return { kind: 'entry', entry: e, stepKey: e.stepKey || stepKey, stepTitle: e.stepTitle || stepTitle,
            pos: i + 1, total: hidden.length, unit: '份结构', auditEnabled: false };
        }),
        stepKey: stepKey,
        stepTitle: stepTitle,
      });
    }
    return list;
  }

  // 递归给显示树标注 _slot/_parentKey 并按布局排序。
  // 已布局层：已知引用按 slot 排，新节点排在最大 slot 之后（不填用户留的空位）；
  // 未布局层：按自然顺序标注 slot。空 slot 只是显示空洞，不产生节点。
  function applyDisplayLayout(nodes, org, parentKey) {
    const list = (nodes || []).slice();
    const rec = layoutFor(org, parentKey);
    const slotOf = rec ? rec.slots : null;
    let natural = list.filter(function (n) {
      const ref = refOfNode(n);
      return !ref || !slotOf || slotOf[ref] === undefined;
    });
    let nextNatural = 0;
    if (slotOf) {
      for (const ref of Object.keys(slotOf)) nextNatural = Math.max(nextNatural, slotOf[ref] + 1);
    }
    list.forEach(function (node) {
      const ref = refOfNode(node);
      node._parentKey = parentKey;
      if (ref && slotOf && slotOf[ref] !== undefined) {
        node._slot = slotOf[ref];
      } else {
        node._slot = nextNatural++;
      }
    });
    if (slotOf) {
      list.sort(function (a, b) { return a._slot - b._slot; });
      // 排序后引用 _slot 定位；自然节点若与新 slot 冲突由显示层按 _slot 放置
    }
    list.forEach(function (node) {
      if (node.kind === 'folder' && node.children && node.children.length) {
        // 排序返回的是新数组，必须写回，否则钻入后子层顺序不变
        node.children = applyDisplayLayout(node.children, org, folderNodeKey(node));
      }
    });
    return list;
  }

  function ingestDefinition(store, pipeline, entries) {
    if (!pipeline || !pipeline.id || !Array.isArray(pipeline.steps)) return store;
    pipeline.steps.forEach(function (step) {
      if (!step || !step.id || !step.organization) return;
      const key = pipeline.id + ':' + step.id;
      const stepEntries = (entries || []).filter(function (e) { return e.stepKey === key; });
      store[key] = hydrate(step.organization, stepEntries);
    });
    return store;
  }

  const api = {
    empty: empty, clone: clone, isEmpty: isEmpty, ensure: ensure, placeId: placeId,
    serialize: serialize, hydrate: hydrate, rebind: rebind,
    commit: commit, undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo, clearHistory: clearHistory,
    createFolder: createFolder, renameFolder: renameFolder, dissolveFolder: dissolveFolder, reparentFolder: reparentFolder,
    deleteFolder: deleteFolder, removeKeys: removeKeys, restoreKeys: restoreKeys, moveKeys: moveKeys,
    resetStep: resetStep, setNote: setNote, getNote: getNote, apply: apply, ingestDefinition: ingestDefinition, relPath: relPath,
    history: history,
    layoutFor: layoutFor, setLayout: setLayout, clearLayout: clearLayout,
    refOfNode: refOfNode, folderNodeKey: folderNodeKey, applyDisplayLayout: applyDisplayLayout,
    isEntryRef: isEntryRef,
  };
  root.SB_ORG = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
