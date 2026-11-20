/* Canonical canvas state. No DOM, filesystem, network, or pipeline-definition writes. */
(function (root) {
  'use strict';
  const LIMITS = Object.freeze({ nodes: 2000, edges: 8000, operations: 128, bytes: 262144,
    title: 240, tool: 80, desc: 12000, note: 32000, coordinate: 1000000, history: 24, receipts: 64 });
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
  function fault(code, message, details) { const e = Error(message); e.code = code; e.details = details; throw e; }
  function errorOf(e) { return { code: e.code || 'CANVAS_ERROR', message: e.code ? e.message : 'Canvas operation failed', ...(e.details ? { details: clone(e.details) } : {}) }; }
  function keys(o, allowed, required) {
    if (!object(o)) fault('INVALID_ARGUMENT', 'Expected an object');
    for (const k of Object.keys(o)) if (!allowed.includes(k)) fault('INVALID_ARGUMENT', 'Unknown field: ' + k);
    for (const k of required || []) if (!own(o, k)) fault('INVALID_ARGUMENT', 'Missing field: ' + k);
  }
  function jsonGuard(value, maximum) {
    let size = 0, count = 0;
    function visit(v, depth) {
      if (++count > 40000 || depth > 16) fault('INVALID_ARGUMENT', 'Payload is too large or too deep');
      if (typeof v === 'string') size += v.length * 2;
      else if (v === null || typeof v === 'boolean') size += 5;
      else if (typeof v === 'number' && Number.isFinite(v)) size += 24;
      else if (Array.isArray(v)) { size += 2; for (const x of v) visit(x, depth + 1); }
      else if (object(v)) {
        for (const k of Object.keys(v)) {
          if (['__proto__', 'constructor', 'prototype'].includes(k)) fault('INVALID_ARGUMENT', 'Unsafe object key');
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !own(d, 'value')) fault('INVALID_ARGUMENT', 'Accessors are not supported');
          size += k.length * 2 + 3; visit(d.value, depth + 1);
        }
      } else fault('INVALID_ARGUMENT', 'Only JSON values are supported');
      if (size > (maximum || LIMITS.bytes)) fault('INVALID_ARGUMENT', 'Payload is too large');
    }
    visit(value, 0); return true;
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  // Equality uses the complete canonical payload as well as this compact fingerprint.
  function hash(value) {
    const text = typeof value === 'string' ? value : stable(value);
    let a = 2166136261, b = 2246822507;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 3266489909); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function id(value, name) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value))
      fault('INVALID_ARGUMENT', 'Invalid ' + (name || 'node id'));
    return value;
  }
  function text(value, maximum, name, nonempty) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (nonempty && !value.trim()))
      fault('INVALID_ARGUMENT', 'Invalid ' + name);
    return value;
  }
  function idempotency(value) {
    text(value, 160, 'idempotency key', true);
    if (!/^[A-Za-z0-9_.:-]+$/.test(value)) fault('INVALID_ARGUMENT', 'Invalid idempotency key');
  }
  function number(value, name, low, high) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) fault('INVALID_ARGUMENT', 'Invalid ' + name);
    return value;
  }
  function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fault('INVALID_ARGUMENT', 'Invalid revision'); return value; }
  function viewport(value) {
    keys(value, ['scale', 'tx', 'ty'], ['scale', 'tx', 'ty']);
    return { scale: number(value.scale, 'scale', .22, 2.6), tx: number(value.tx, 'tx', -LIMITS.coordinate, LIMITS.coordinate), ty: number(value.ty, 'ty', -LIMITS.coordinate, LIMITS.coordinate) };
  }
  function seedNode(raw, manual) {
    const n = { id: id(raw.id), title: String(raw.title || ''), tool: String(raw.tool || ''), desc: String(raw.desc || ''),
      note: String(raw.note || ''), x: number(raw.x == null ? 40 : raw.x, 'x', -LIMITS.coordinate, LIMITS.coordinate),
      y: number(raw.y == null ? 34 : raw.y, 'y', -LIMITS.coordinate, LIMITS.coordinate),
      ownership: manual ? 'manual' : 'base', manual: !!manual, base: !manual };
    if (raw.binding) { keys(raw.binding, ['stepId'], ['stepId']); n.binding = { stepId: id(raw.binding.stepId, 'step id') }; }
    return n;
  }
  function content(s) { return { nodes: s.nodes, edges: s.edges }; }
  function view(s) { return { selection: s.selection, viewport: s.viewport }; }
  function same(a, b) { return stable(a) === stable(b); }
  function repairSelection(s) { const ids = new Set(s.nodes.map(n => n.id)); s.selection = s.selection.filter(x => ids.has(x)); }
  function graph(s) {
    if (s.nodes.length > LIMITS.nodes || s.edges.length > LIMITS.edges) fault('INVALID_ARGUMENT', 'Canvas limit exceeded');
    const ids = new Set(), edges = new Set();
    for (const n of s.nodes) { if (ids.has(n.id)) fault('INVALID_ARGUMENT', 'Duplicate node id'); ids.add(n.id); }
    for (const e of s.edges) {
      if (!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1]) || e[0] === e[1]) fault('INVALID_ARGUMENT', 'Invalid edge');
      const key = stable(e); if (edges.has(key)) fault('INVALID_ARGUMENT', 'Duplicate edge'); edges.add(key);
    }
    repairSelection(s);
    if (!s.selection.length && s.nodes.length) s.selection = [s.nodes[0].id];
  }
  function create(options) {
    options = options || {};
    const canvasId = id(options.canvasId, 'canvas id');
    const baseNodes = (options.nodes || []).filter(n => !n.manual && n.ownership !== 'manual').map(n => seedNode(n, false));
    const baseMap = new Map(baseNodes.map(n => [n.id, n]));
    const externalNotes = new Set(options.externalNoteIds || []);
    const baseEdges = clone(options.edges || []);
    let state = { canvasId, revision: 0, viewRevision: 0, nodes: clone(baseNodes), edges: baseEdges,
      selection: clone(options.selection || []), viewport: viewport(options.viewport || { scale: .85, tx: 16, ty: 16 }) };
    let receipts = [], changes = [], serial = 0, generation = 0, recovery = null, prepareSerial = 0;
    const prepared = new Map();
    const overlay = options.overlay || {};
    const doc = object(overlay.document) && overlay.document.v === 2 ? overlay.document : null;
    const deleted = new Set(doc ? doc.deletedIds || [] : (overlay.deleted || []).filter(x => x && x.node).map(x => x.node.id));
    state.nodes = state.nodes.filter(n => !deleted.has(n.id));
    state.edges = state.edges.filter(e => !deleted.has(e[0]) && !deleted.has(e[1]));
    const manualNodes = doc ? doc.nodes || [] : overlay.nodes || [];
    for (const raw of manualNodes) {
      if (!raw || !raw.manual || deleted.has(raw.id) || state.nodes.some(n => n.id === raw.id) || baseMap.has(raw.id)) continue;
      state.nodes.push(seedNode(raw, true));
    }
    for (const n of state.nodes) {
      const override = doc && doc.overrides && doc.overrides[n.id];
      if (override) {
        keys(override, ['title', 'tool', 'desc', 'note', 'x', 'y']);
        for (const field of Object.keys(override)) {
          if (field === 'note' && externalNotes.has(n.id)) continue;
          if (field === 'x' || field === 'y') n[field] = number(override[field], field, -LIMITS.coordinate, LIMITS.coordinate);
          else n[field] = text(override[field], LIMITS[field], field, field === 'title');
        }
      } else if (!doc) {
        if (own(overlay.titles || {}, n.id)) n.title = String(overlay.titles[n.id]);
        if (!externalNotes.has(n.id) && own(overlay.notes || {}, n.id)) n.note = String(overlay.notes[n.id]);
        const visual = (overlay.overrides || {})[n.id];
        if (visual) for (const k of ['x', 'y']) if (own(visual, k)) n[k] = number(visual[k], k, -LIMITS.coordinate, LIMITS.coordinate);
      }
    }
    if (doc && Array.isArray(doc.edges)) state.edges = clone(doc.edges).filter(e => Array.isArray(e) && e.length === 2 && state.nodes.some(n => n.id === e[0]) && state.nodes.some(n => n.id === e[1]));
    else for (const edge of overlay.edges || []) if (Array.isArray(edge) && edge.length === 2 && state.nodes.some(n => n.id === edge[0]) && state.nodes.some(n => n.id === edge[1]) && !state.edges.some(e => same(e, edge))) state.edges.push(clone(edge));
    if (doc) {
      if (doc.canvasId !== canvasId) fault('INVALID_DOCUMENT', 'Canvas identity does not match saved document');
      state.revision = revision(doc.revision); state.viewRevision = revision(doc.viewRevision);
      state.viewport = viewport(doc.viewport || state.viewport); state.selection = clone(doc.selection || []);
      receipts = Array.isArray(doc.receipts) ? clone(doc.receipts).slice(-LIMITS.receipts) : [];
      changes = Array.isArray(doc.changes) ? clone(doc.changes).slice(-LIMITS.history) : [];
      serial = Number.isSafeInteger(doc.serial) && doc.serial >= 0 ? doc.serial : 0;
    } else if (overlay.viewport) state.viewport = viewport(overlay.viewport);
    graph(state);
    if (doc && doc.contentSignature && doc.contentSignature !== stable(content(state))) { state.revision++; changes = []; }
    function snapshot() { return clone(state); }
    function serialize(next, nextReceipts, nextChanges, nextSerial) {
      const overrides = Object.create(null), notes = Object.create(null), titles = Object.create(null), noteRecovery = Object.create(null);
      for (const n of next.nodes) {
        const base = baseMap.get(n.id);
        if (base) {
          const patch = Object.create(null);
          for (const k of ['title', 'tool', 'desc', 'note', 'x', 'y']) if (!(k === 'note' && externalNotes.has(n.id)) && !same(n[k], base[k])) patch[k] = n[k];
          if (Object.keys(patch).length) overrides[n.id] = patch;
        }
        if (!externalNotes.has(n.id)) notes[n.id] = n.note;
        else if (base && n.binding) noteRecovery[n.id] = { stepId: n.binding.stepId, before: base.note, after: n.note };
        titles[n.id] = n.title;
      }
      const nodes = clone(next.nodes.filter(n => n.manual));
      const deletedIds = baseNodes.filter(n => !next.nodes.some(x => x.id === n.id)).map(n => n.id);
      const tombstones = deletedIds.map(nodeId => ({ node: clone(baseMap.get(nodeId)), index: baseNodes.findIndex(n => n.id === nodeId), edges: baseEdges.filter(e => e.includes(nodeId)) }));
      return { nodes, edges: clone(next.edges.filter(e => nodes.some(n => n.id === e[0] || n.id === e[1]))), notes, titles,
        deleted: tombstones, overrides: clone(overrides), viewport: clone(next.viewport),
        document: { v: 2, canvasId, revision: next.revision, viewRevision: next.viewRevision, nodes,
          edges: clone(next.edges), deletedIds, overrides: clone(overrides), noteRecovery: clone(noteRecovery), viewport: clone(next.viewport), selection: clone(next.selection),
          contentSignature: stable(content(next)), serial: nextSerial, receipts: clone(nextReceipts), changes: clone(nextChanges) } };
    }
    function noteChanges(before, after) {
      return after.nodes.filter(n => n.note !== (before.nodes.find(x => x.id === n.id) || {}).note)
        .map(n => ({ id: n.id, text: n.note, ...(n.binding && n.base ? { stepId: n.binding.stepId } : {}) }));
    }
    function result(before, next, changeId, kind) {
      return { canvasId, revision: next.revision, viewRevision: next.viewRevision, changeId, kind,
        contentChanged: !same(content(before), content(next)), viewChanged: !same(view(before), view(next)),
        changedNodeIds: Array.from(new Set(before.nodes.concat(next.nodes).filter(n => !same(before.nodes.find(x => x.id === n.id) || null, next.nodes.find(x => x.id === n.id) || null)).map(n => n.id))),
        noteChanges: noteChanges(before, next) };
    }
    function finish(next, receipt, record, hooks) {
      graph(next);
      const nextReceipts = receipt ? receipts.concat(receipt).slice(-LIMITS.receipts) : receipts;
      const nextChanges = record ? changes.concat(record).slice(-LIMITS.history) : changes;
      const nextSerial = record ? serial + 1 : serial;
      const observedGeneration = generation;
      const saved = serialize(next, nextReceipts, nextChanges, nextSerial);
      try {
        if (hooks && hooks.signal && hooks.signal.aborted) fault('CANCELLED', 'Canvas change cancelled before commit');
        if (hooks && hooks.beforeCommit) hooks.beforeCommit(saved, clone(next), record && clone(record.result));
        if (observedGeneration !== generation) fault('REVISION_CONFLICT', 'Canvas changed before commit', { revision: state.revision, viewRevision: state.viewRevision });
      } catch (e) { recovery = { snapshot: clone(next), overlay: saved }; throw e; }
      state = next; receipts = nextReceipts; changes = nextChanges; serial = nextSerial; generation++; recovery = null;
    }
    function request(args, undo) {
      jsonGuard(args);
      keys(args, ['canvasId', 'expectedRevision', 'expectedViewRevision', 'idempotencyKey', undo ? 'changeId' : 'operations'], ['canvasId', 'expectedRevision', 'idempotencyKey', undo ? 'changeId' : 'operations']);
      if (args.canvasId !== canvasId) fault('CANVAS_MISMATCH', 'The requested canvas is not active');
      revision(args.expectedRevision); if (own(args, 'expectedViewRevision')) revision(args.expectedViewRevision);
      idempotency(args.idempotencyKey);
      const payload = stable({ kind: undo ? 'undo' : 'apply', args });
      const old = receipts.find(x => x.key === args.idempotencyKey);
      if (old) {
        if (old.payload !== payload || old.hash !== hash(payload)) fault('IDEMPOTENCY_MISMATCH', 'Idempotency key was already used for a different payload');
        return { replay: { ...clone(old.result), replayed: true, currentRevision: state.revision, currentViewRevision: state.viewRevision } };
      }
      if (args.expectedRevision !== state.revision || (own(args, 'expectedViewRevision') && args.expectedViewRevision !== state.viewRevision))
        fault('REVISION_CONFLICT', 'Canvas changed; obtain a fresh snapshot', { revision: state.revision, viewRevision: state.viewRevision });
      return { payload };
    }
    function applyOperation(next, op) {
      if (!object(op) || typeof op.op !== 'string') fault('INVALID_ARGUMENT', 'Invalid canvas operation');
      function node(nodeId) { id(nodeId); const found = next.nodes.find(n => n.id === nodeId); if (!found) fault('NOT_FOUND', 'Node does not exist'); return found; }
      if (op.op === 'node.create') {
        keys(op, ['op', 'node'], ['op', 'node']);
        keys(op.node, ['id', 'title', 'tool', 'desc', 'note', 'x', 'y', 'binding'], ['id', 'title', 'x', 'y']);
        const input = op.node; id(input.id);
        if (baseMap.has(input.id) || next.nodes.some(n => n.id === input.id)) fault('ALREADY_EXISTS', 'Node id already exists or belongs to the source graph');
        for (const k of ['title', 'tool', 'desc', 'note']) if (own(input, k)) text(input[k], LIMITS[k], k, k === 'title');
        if (input.binding) {
          keys(input.binding, ['stepId'], ['stepId']); id(input.binding.stepId, 'step id');
          if (!baseNodes.some(n => n.binding && n.binding.stepId === input.binding.stepId)) fault('INVALID_ARGUMENT', 'Binding must reference an existing pipeline step');
        }
        next.nodes.push(seedNode(input, true));
      } else if (op.op === 'node.update') {
        keys(op, ['op', 'id', 'props'], ['op', 'id', 'props']); keys(op.props, ['title', 'tool', 'desc']);
        if (!Object.keys(op.props).length) fault('INVALID_ARGUMENT', 'Node update is empty');
        const n = node(op.id); for (const k of Object.keys(op.props)) n[k] = text(op.props[k], LIMITS[k], k, k === 'title');
      } else if (op.op === 'node.move') {
        keys(op, ['op', 'id', 'x', 'y'], ['op', 'id', 'x', 'y']); const n = node(op.id);
        n.x = number(op.x, 'x', -LIMITS.coordinate, LIMITS.coordinate); n.y = number(op.y, 'y', -LIMITS.coordinate, LIMITS.coordinate);
      } else if (op.op === 'node.delete') {
        keys(op, ['op', 'id'], ['op', 'id']); node(op.id);
        if (['empty', 'api-empty'].includes(op.id)) fault('INVALID_ARGUMENT', 'Placeholder nodes cannot be deleted');
        next.nodes = next.nodes.filter(n => n.id !== op.id); next.edges = next.edges.filter(e => !e.includes(op.id));
      } else if (op.op === 'edge.connect' || op.op === 'edge.disconnect') {
        keys(op, ['op', 'from', 'to'], ['op', 'from', 'to']); node(op.from); node(op.to);
        if (op.from === op.to) fault('INVALID_ARGUMENT', 'Self edges are not allowed');
        const index = next.edges.findIndex(e => e[0] === op.from && e[1] === op.to);
        if (op.op === 'edge.connect') { if (index >= 0) fault('ALREADY_EXISTS', 'Edge already exists'); next.edges.push([op.from, op.to]); }
        else { if (index < 0) fault('NOT_FOUND', 'Edge does not exist'); next.edges.splice(index, 1); }
      } else if (op.op === 'note.set') {
        keys(op, ['op', 'id', 'text'], ['op', 'id', 'text']); node(op.id).note = text(op.text, LIMITS.note, 'note');
      } else if (op.op === 'viewport.set') {
        keys(op, ['op', 'viewport'], ['op', 'viewport']); next.viewport = viewport(op.viewport);
      } else fault('INVALID_OPERATION', 'Canvas operation is not allowed');
    }
    function applyChange(args, hooks) {
      try {
        const checked = request(args, false); if (checked.replay) return { ok: true, result: checked.replay };
        if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > LIMITS.operations) fault('INVALID_ARGUMENT', 'Invalid operations list');
        const before = snapshot(), next = snapshot();
        for (const op of args.operations) applyOperation(next, op);
        graph(next);
        const changedContent = !same(content(before), content(next)), changedView = !same(view(before), view(next));
        next.revision += changedContent ? 1 : 0; next.viewRevision += changedView ? 1 : 0;
        const changeId = 'change_' + (serial + 1) + '_' + hash(checked.payload);
        const outcome = result(before, next, changeId, 'apply');
        const record = { changeId, before, afterRevision: next.revision, afterViewRevision: next.viewRevision,
          contentChanged: changedContent, viewportChanged: !same(before.viewport, next.viewport), undone: false,
          source: hooks && hooks.source === 'ui' ? 'ui' : 'api', deleted: args.operations.some(op => op.op === 'node.delete'), result: outcome };
        finish(next, { key: args.idempotencyKey, hash: hash(checked.payload), payload: checked.payload, result: outcome }, record, hooks);
        return { ok: true, result: clone(outcome) };
      } catch (e) { return { ok: false, error: errorOf(e) }; }
    }
    function undoChange(args, hooks) {
      try {
        const checked = request(args, true); if (checked.replay) return { ok: true, result: checked.replay };
        id(args.changeId, 'change id'); const old = changes.find(c => c.changeId === args.changeId);
        if (!old || old.undone || old.result.kind !== 'apply') fault('UNDO_UNAVAILABLE', 'Change is not available for undo on this canvas');
        if ((old.contentChanged && old.afterRevision !== state.revision) || (old.viewportChanged && old.afterViewRevision !== state.viewRevision))
          fault('REVISION_CONFLICT', 'Later edits prevent this undo', { revision: state.revision, viewRevision: state.viewRevision });
        const before = snapshot(), next = snapshot();
        if (old.contentChanged) { next.nodes = clone(old.before.nodes); next.edges = clone(old.before.edges); }
        if (old.viewportChanged) next.viewport = clone(old.before.viewport);
        repairSelection(next);
        next.revision += same(content(before), content(next)) ? 0 : 1;
        next.viewRevision += same(view(before), view(next)) ? 0 : 1;
        const changeId = 'undo_' + (serial + 1) + '_' + hash(checked.payload), outcome = { ...result(before, next, changeId, 'undo'), undoneChangeId: args.changeId };
        // Undoing a UI edit restores its exact previous content. Rebase the
        // immediately preceding UI edit so repeated Ctrl+Z can walk that history.
        // External edits still invalidate stale undo records through revisions.
        const updated = changes.map(c => c === old ? { ...c, undone: true } :
          hooks?.source === 'ui' && old.source === 'ui' && c.source === 'ui' && !c.undone && c.contentChanged &&
          c.afterRevision === old.before.revision ? { ...c, afterRevision: next.revision } : c);
        const previous = changes; changes = updated;
        try {
          finish(next, { key: args.idempotencyKey, hash: hash(checked.payload), payload: checked.payload, result: outcome },
            { changeId, before, afterRevision: next.revision, afterViewRevision: next.viewRevision, contentChanged: outcome.contentChanged,
              viewportChanged: old.viewportChanged, source: hooks && hooks.source === 'ui' ? 'ui' : 'api', result: outcome }, hooks);
        } catch (e) { changes = previous; throw e; }
        return { ok: true, result: clone(outcome) };
      } catch (e) { return { ok: false, error: errorOf(e) }; }
    }
    function observeLocal(input) {
      const next = snapshot();
      next.nodes = input.nodes.map(n => seedNode(n, !!n.manual)); next.edges = clone(input.edges);
      next.selection = clone(input.selection || []); next.viewport = viewport(input.viewport); graph(next);
      const contentChanged = !same(content(state), content(next)), viewChanged = !same(view(state), view(next));
      if (!contentChanged && !viewChanged) return { changed: false, contentChanged: false, viewChanged: false };
      next.revision += contentChanged ? 1 : 0; next.viewRevision += viewChanged ? 1 : 0;
      state = next; generation++; return { changed: true, contentChanged, viewChanged };
    }
    function diff(before, after) {
      const changes = [], show = v => typeof v === 'string' ? v : stable(v);
      const ids = new Set(before.nodes.concat(after.nodes).map(n => n.id));
      for (const nodeId of ids) {
        const a = before.nodes.find(n => n.id === nodeId), b = after.nodes.find(n => n.id === nodeId);
        if (!a || !b) changes.push({ target: 'node:' + nodeId, kind: !a ? 'create' : 'delete', ...(!a ? { after: show(b) } : { before: show(a) }) });
        else for (const field of ['title', 'tool', 'desc', 'note', 'x', 'y']) if (!same(a[field], b[field]))
          changes.push({ target: 'node:' + nodeId + ':' + field, kind: 'update', before: show(a[field]), after: show(b[field]) });
      }
      for (const edge of before.edges) if (!after.edges.some(e => same(e, edge))) changes.push({ target: 'edge:' + edge.join(':'), kind: 'disconnect', before: show(edge) });
      for (const edge of after.edges) if (!before.edges.some(e => same(e, edge))) changes.push({ target: 'edge:' + edge.join(':'), kind: 'connect', after: show(edge) });
      if (!same(before.viewport, after.viewport)) changes.push({ target: 'viewport', kind: 'update', before: show(before.viewport), after: show(after.viewport) });
      return { summary: changes.length + ' canvas changes', changes };
    }
    function prepare(kind, args) {
      try {
        // Fork the complete state, including receipts and scoped undo history. This is
        // the actual candidate that commitPrepared will publish after approval.
        const forkBase = baseNodes.map(n => externalNotes.has(n.id) ? { ...n, note: (state.nodes.find(x => x.id === n.id) || n).note } : n);
        const fork = create({ canvasId, nodes: forkBase, edges: baseEdges, externalNoteIds: Array.from(externalNotes),
          viewport: state.viewport, selection: state.selection, overlay: serialize(state, receipts, changes, serial) });
        const before = snapshot(), outcome = kind === 'undo' ? fork.undoChange(args) : fork.applyChange(args);
        if (!outcome.ok) return outcome;
        const candidate = fork.getSnapshot(), candidateOverlay = fork.toOverlay();
        const handle = 'prepared_' + (++prepareSerial) + '_' + hash(stable({ kind, args, generation }));
        prepared.set(handle, { kind, payload: stable(args), generation, candidate, overlay: candidateOverlay, outcome });
        if (prepared.size > 16) prepared.delete(prepared.keys().next().value);
        return { ok: true, result: { canvasId, revision: state.revision, viewRevision: state.viewRevision,
          prepared: handle, diff: diff(before, candidate) } };
      } catch (e) { return { ok: false, error: errorOf(e) }; }
    }
    function commitPrepared(handle, kind, args, hooks) {
      try {
        jsonGuard(args);
        const item = prepared.get(handle);
        if (!item || item.kind !== kind || item.payload !== stable(args)) fault('PREPARED_MISMATCH', 'Prepared change does not match the request');
        if (item.generation !== generation) fault('REVISION_CONFLICT', 'Canvas changed after preparation', { revision: state.revision, viewRevision: state.viewRevision });
        const next = clone(item.candidate), saved = clone(item.overlay);
        if (hooks && hooks.signal && hooks.signal.aborted) fault('CANCELLED', 'Canvas change cancelled before commit');
        try {
          if (hooks && hooks.beforeCommit) hooks.beforeCommit(saved, next, clone(item.outcome.result));
          if (item.generation !== generation) fault('REVISION_CONFLICT', 'Canvas changed before commit');
        } catch (e) { recovery = { snapshot: next, overlay: saved }; throw e; }
        state = next; receipts = saved.document.receipts; changes = saved.document.changes; serial = saved.document.serial;
        generation++; recovery = null; prepared.delete(handle);
        return clone(item.outcome);
      } catch (e) { return { ok: false, error: errorOf(e) }; }
    }
    function undoCandidate() {
      const c = changes.slice().reverse().find(c => c.source === 'ui' && c.result.kind === 'apply' && c.contentChanged && !c.undone && c.afterRevision === state.revision);
      return c ? c.changeId : null;
    }
    return { getSnapshot: snapshot, applyChange, undoChange, observeLocal, undoCandidate,
      prepareChange: args => prepare('apply', args), prepareUndo: args => prepare('undo', args), commitPrepared,
      toOverlay: () => serialize(state, receipts, changes, serial), getRecovery: () => recovery ? clone(recovery.snapshot) : null };
  }
  const api = { create, LIMITS, hash, stable, jsonGuard, errorOf, viewport, id };
  root.SB_CANVAS_DOCUMENT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
