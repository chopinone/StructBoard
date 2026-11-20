/* Canonical renderer adapter and nonce-bound parent/iframe protocol. */
(function (root) {
  'use strict';
  const Document = root.SB_CANVAS_DOCUMENT || (typeof require === 'function' ? require('./canvas_document.js') : null);
  const clone = x => JSON.parse(JSON.stringify(x));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function error(code, message, details) { return { ok: false, error: { code, message, ...(details ? { details } : {}) } }; }
  function create(options) {
    let engine = null, activeKey = null, baseKey = '', uiSerial = 0, storageFailure = false, applying = false;
    const instances = new Map(), candidates = new Map();
    const context = () => options.readContext();
    function baseSignature(ctx) { return Document.stable({ nodes: ctx.baseNodes || ctx.nodes.filter(n => !n.manual), edges: ctx.baseEdges || [] }); }
    function ensure() {
      const ctx = context();
      if (!engine || ctx.key !== activeKey) restore(ctx);
      return { ctx: context(), engine };
    }
    function restore(ctx) {
      ctx = ctx || context();
      candidates.clear();
      const signature = baseSignature(ctx), cached = instances.get(ctx.key);
      if (cached && cached.baseKey === signature) engine = cached.engine;
      else {
        const overlay = cached ? cached.engine.toOverlay() : options.loadOverlay(ctx.key);
        engine = Document.create({ ...ctx, nodes: ctx.baseNodes || ctx.nodes, edges: ctx.baseEdges || ctx.edges, overlay });
        if (cached) {
          const previous = cached.engine.getSnapshot(), current = engine.getSnapshot();
          if (Document.stable({ nodes: previous.nodes, edges: previous.edges }) !== Document.stable({ nodes: current.nodes, edges: current.edges }) && current.revision <= previous.revision) {
            const revised = engine.toOverlay(); revised.document.revision = previous.revision + 1; revised.document.changes = [];
            engine = Document.create({ ...ctx, nodes: ctx.baseNodes || ctx.nodes, edges: ctx.baseEdges || ctx.edges, overlay: revised });
          }
        }
      }
      activeKey = ctx.key; baseKey = signature; storageFailure = false;
      instances.set(ctx.key, { engine, baseKey });
      publish(); return engine.getSnapshot();
    }
    function publish() {
      applying = true;
      try { options.publish(engine.getSnapshot()); }
      finally { applying = false; }
    }
    function observeLocal(persist) {
      if (applying) return { changed: false };
      const { ctx } = ensure();
      const result = engine.observeLocal(ctx);
      if (result.changed || (storageFailure && persist !== false)) {
        storageFailure = true;
        if (persist !== false) {
          try { options.saveOverlay(activeKey, engine.toOverlay()); storageFailure = false; }
          catch (_) { if (options.onStorageError) options.onStorageError(); }
        }
      }
      return result;
    }
    function safeSnapshot(optionsValue) {
      optionsValue = optionsValue || {};
      Document.jsonGuard(optionsValue, 4096);
      if (Object.keys(optionsValue).some(k => k !== 'canvasId')) throw Object.assign(Error('Unknown snapshot option'), { code: 'INVALID_ARGUMENT' });
      ensure(); observeLocal();
      const snap = engine.getSnapshot();
      if (optionsValue.canvasId && optionsValue.canvasId !== snap.canvasId) throw Object.assign(Error('The requested canvas is not active'), { code: 'CANVAS_MISMATCH' });
      // No renderer objects, root, file paths, commands, or pipeline definitions leave here.
      const privateRoots = (context().privateRoots || []).filter(x => typeof x === 'string' && x.length > 2);
      const redact = value => privateRoots.reduce((s, p) => s.split(p).join('[private]').split(p.replace(/\\/g, '/')).join('[private]'), value);
      for (const n of snap.nodes) for (const field of ['title', 'tool', 'desc', 'note']) n[field] = redact(n[field]);
      snap.durability = { rendererApplied: true, localDurable: !storageFailure, backendAck: noteDurability(snap.nodes.filter(n => n.base && n.binding).map(n => ({ id: n.id, text: n.note, stepId: n.binding.stepId })), false).backendAck };
      return snap;
    }
    function noteDurability(changes, enqueue) {
      if (!options.notes) return { backendAck: null, notesLocalDurable: true };
      try { return options.notes(changes, enqueue); }
      catch (_) { return { backendAck: false, notesLocalDurable: false, notesError: 'Note outbox is not durable' }; }
    }
    function hooks(ctx, callContext) {
      return { source: callContext && callContext.source, signal: callContext && callContext.signal,
        beforeCommit(overlay, next) {
          if (callContext && callContext.signal && callContext.signal.aborted) throw Object.assign(Error('Canvas change cancelled before commit'), { code: 'CANCELLED' });
          const current = context();
          if (current.key !== ctx.key) throw Object.assign(Error('The active canvas changed'), { code: 'CANVAS_MISMATCH' });
          if (options.validateCommit) options.validateCommit(next);
          try { options.saveOverlay(ctx.key, overlay); }
          catch (_) { storageFailure = true; throw Object.assign(Error('Local canvas storage is not writable; change was not applied'), { code: 'STORAGE_WRITE_FAILED' }); }
        } };
    }
    function transact(kind, args, callContext) {
      try {
        const { ctx } = ensure(); observeLocal();
        const signature = kind + ':' + Document.stable(args), candidate = candidates.get(signature);
        let outcome;
        if (callContext && callContext.prepared && (!candidate || candidate.handle !== callContext.prepared)) return error('PREPARED_MISMATCH', 'Prepared handle does not match this request');
        if (candidate) outcome = engine.commitPrepared(candidate.handle, kind, args, hooks(ctx, callContext));
        else outcome = kind === 'undo' ? engine.undoChange(args, hooks(ctx, callContext)) : engine.applyChange(args, hooks(ctx, callContext));
        if (!outcome.ok) return outcome;
        if (!outcome.result.replayed) { candidates.delete(signature); storageFailure = false; publish(); }
        const canonicalNotes = (engine.getSnapshot().nodes || []).filter(n => n.base && n.binding).map(n => ({ id: n.id, text: n.note, stepId: n.binding.stepId }));
        const notes = noteDurability(outcome.result.replayed ? canonicalNotes : outcome.result.noteChanges || [], !outcome.result.replayed);
        const result = { ...outcome.result, rendererApplied: true, localDurable: !storageFailure,
          backendAck: notes.backendAck, notesLocalDurable: notes.notesLocalDurable !== false };
        delete result.noteChanges;
        if (notes.notesError) result.notesError = notes.notesError;
        result.durability = { rendererApplied: result.rendererApplied, localDurable: result.localDurable, backendAck: result.backendAck,
          notesLocalDurable: result.notesLocalDurable };
        return { ok: true, result };
      } catch (e) { return { ok: false, error: Document.errorOf(e) }; }
    }
    function prepare(kind, args) {
      try {
        ensure(); observeLocal();
        const outcome = kind === 'undo' ? engine.prepareUndo(args) : engine.prepareChange(args);
        if (outcome.ok) {
          candidates.set(kind + ':' + Document.stable(args), { handle: outcome.result.prepared });
          if (candidates.size > 16) candidates.delete(candidates.keys().next().value);
          const privateRoots = context().privateRoots || [];
          for (const c of outcome.result.diff.changes) for (const k of ['before', 'after']) if (typeof c[k] === 'string')
            for (const p of privateRoots.filter(p => p && p.length > 2)) c[k] = c[k].split(p).join('[private]').split(p.replace(/\\/g, '/')).join('[private]');
        }
        return outcome;
      } catch (e) { return { ok: false, error: Document.errorOf(e) }; }
    }
    const api = Object.freeze({ getSnapshot: safeSnapshot,
      applyChange: (args, ctx) => transact('apply', args, ctx), undoChange: (args, ctx) => transact('undo', args, ctx),
      prepareChange: args => prepare('apply', args), prepareUndo: args => prepare('undo', args) });
    return { api, restore, observeLocal,
      applyLocal(operations) {
        ensure(); observeLocal(); const snap = engine.getSnapshot();
        return transact('apply', { canvasId: snap.canvasId, expectedRevision: snap.revision,
          idempotencyKey: 'ui_' + Date.now().toString(36) + '_' + (++uiSerial), operations }, { source: 'ui' });
      },
      undoLocal() {
        ensure(); observeLocal(); const snap = engine.getSnapshot(), changeId = engine.undoCandidate();
        if (!changeId) return error('UNDO_UNAVAILABLE', 'No compatible local change to undo');
        return transact('undo', { canvasId: snap.canvasId, expectedRevision: snap.revision,
          idempotencyKey: 'ui_undo_' + Date.now().toString(36) + '_' + (++uiSerial), changeId }, { source: 'ui' });
      },
      canUndoLocal() { ensure(); return !!engine.undoCandidate(); },
      save() {
        ensure(); observeLocal(false);
        try { options.saveOverlay(activeKey, engine.toOverlay()); storageFailure = false; return true; }
        catch (_) { storageFailure = true; if (options.onStorageError) options.onStorageError(); return false; }
      },
      recoverySnapshot() { return engine && engine.getRecovery(); } };
  }
  function installPostMessage(win, api) {
    let nonce = null, parentOrigin = null, disposed = false;
    const pending = new Map(), seen = new Set();
    function exact(value, allowed, required) {
      return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => own(value, k));
    }
    function post(data) { if (!disposed) win.parent.postMessage(data, parentOrigin === 'null' ? '*' : parentOrigin); }
    const validToken = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{16,160}$/.test(s);
    const validId = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(s);
    async function receive(event) {
      if (disposed || win.parent === win || event.source !== win.parent || event.origin !== win.location.origin) return;
      const d = event.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      try { Document.jsonGuard(d, Document.LIMITS.bytes + 4096); } catch (_) { return; }
      if (d.type === 'sb.canvas.hello') {
        if (!exact(d, ['type', 'v', 'nonce'], ['type', 'v', 'nonce']) || d.v !== 1 || !validToken(d.nonce) || (nonce && nonce !== d.nonce)) return;
        nonce = d.nonce; parentOrigin = event.origin; post({ type: 'sb.canvas.ready', v: 1, nonce }); return;
      }
      if (!nonce || event.origin !== parentOrigin || d.nonce !== nonce || d.v !== 1) return;
      if (d.type === 'sb.canvas.cancel') {
        if (!exact(d, ['type', 'v', 'requestId', 'nonce'], ['type', 'v', 'requestId', 'nonce']) || !validId(d.requestId)) return;
        const job = pending.get(d.requestId); if (job) job.abort(); return;
      }
      if (d.type !== 'sb.canvas.request' || !exact(d, ['type', 'v', 'requestId', 'nonce', 'op', 'args', 'prepared'], ['type', 'v', 'requestId', 'nonce', 'op', 'args']) || !validId(d.requestId)) return;
      const respond = outcome => post({ type: 'sb.canvas.response', v: 1, requestId: d.requestId, nonce, ...outcome });
      if (!['snapshot', 'prepare', 'apply', 'undo'].includes(d.op)) { respond(error('INVALID_OPERATION', 'Canvas bridge operation is not allowed')); return; }
      if (own(d, 'prepared') && (!validId(d.prepared) || !['apply', 'undo'].includes(d.op))) { respond(error('INVALID_ARGUMENT', 'Invalid prepared handle')); return; }
      if (seen.has(d.requestId)) { respond(error('DUPLICATE_REQUEST', 'Request id has already been used')); return; }
      if (pending.size >= 32 || seen.size >= 20000) { respond(error('BUSY', 'Too many canvas requests')); return; }
      seen.add(d.requestId);
      const controller = new AbortController(); pending.set(d.requestId, controller);
      // Yield once so a cancellation already in the queue can block precommit.
      try {
        await Promise.resolve();
        if (controller.signal.aborted) { respond(error('CANCELLED', 'Canvas request cancelled before commit')); return; }
        let outcome;
        const ctx = { signal: controller.signal, prepared: d.prepared };
        if (d.op === 'snapshot') outcome = { ok: true, result: await api.getSnapshot(d.args) };
        else if (d.op === 'prepare') {
          if (!exact(d.args, ['kind', 'change'], ['kind', 'change']) || !['apply', 'undo'].includes(d.args.kind)) outcome = error('INVALID_ARGUMENT', 'Invalid prepare request');
          else outcome = await (d.args.kind === 'undo' ? api.prepareUndo(d.args.change) : api.prepareChange(d.args.change));
        } else outcome = await (d.op === 'undo' ? api.undoChange(d.args, ctx) : api.applyChange(d.args, ctx));
        // If an async adapter committed before cancel arrived, return the real result.
        respond(outcome);
      } catch (e) { respond({ ok: false, error: Document.errorOf(e) }); }
      finally { pending.delete(d.requestId); }
    }
    win.addEventListener('message', receive);
    return { dispose() { disposed = true; for (const c of pending.values()) c.abort(); pending.clear(); win.removeEventListener('message', receive); } };
  }
  const api = { create, installPostMessage };
  root.SB_CANVAS_BRIDGE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
