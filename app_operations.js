/* Strict app operation schemas and dispatcher. No DOM, file reads, or transport. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SB_APP_OPERATIONS_CORE = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = (properties, required) => ({ type: 'object', properties, required: required || [], additionalProperties: false });
  const text = (maxLength, minLength) => ({ type: 'string', minLength: minLength || 0, maxLength });
  const handle = () => text(160, 1);
  const ids = (minItems) => ({ type: 'array', items: handle(), minItems: minItems || 0, maxItems: 2000, uniqueItems: true });
  const relative = () => ({ ...text(1024, 1), format: 'relative-path' });
  const paths = () => ({ type: 'array', items: relative(), maxItems: 2000, uniqueItems: true });
  const file = object({ name: text(200, 1), path: relative() }, ['path']);
  const patch = object({ title: text(200, 1), tool: text(60), dir: { ...text(1024), format: 'relative-dir' }, globs: paths(), starGlobs: paths(), files: { type: 'array', items: file, maxItems: 2000 } });
  patch.minProperties = 1;
  const operation = { oneOf: [
    object({ op: { const: 'set_name' }, name: text(200, 1) }, ['op', 'name']),
    object({ op: { const: 'update_step' }, stepId: handle(), patch }, ['op', 'stepId', 'patch']),
    object({ op: { const: 'reorder_steps' }, stepIds: ids(1) }, ['op', 'stepIds']),
  ] };
  const write = { expectedRevision: handle(), idempotencyKey: text(160, 1) };
  const definitions = [
    ['sb_get_context', 'Workspace, steps, folders, and live panes', 'workspace.read', object({ includeNotes: { type: 'boolean', default: true }, includeMetrics: { type: 'boolean', default: false } })],
    ['sb_list_entries', 'Page through entry handles and optional metrics', 'workspace.read', object({ stepId: handle(), cursor: text(200, 1), limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, includeMetrics: { type: 'boolean', default: false } })],
    ['sb_notes_set', 'Set a step note using the durable note store', 'workspace.write', object({ stepId: handle(), text: text(5000), ...write }, ['stepId', 'text', 'expectedRevision', 'idempotencyKey'])],
    ['sb_folder_create', 'Create a workspace folder and optionally place entries in it', 'workspace.write', object({ stepId: handle(), name: text(60, 1), parentId: handle(), entryIds: ids(), ...write }, ['stepId', 'name', 'expectedRevision', 'idempotencyKey'])],
    ['sb_folder_move', 'Move entries to a folder or the step root', 'workspace.write', object({ stepId: handle(), entryIds: ids(1), folderId: handle(), ...write }, ['stepId', 'entryIds', 'expectedRevision', 'idempotencyKey'])],
    ['sb_star_set', 'Set or clear stars on explicit entries', 'workspace.write', object({ entryIds: ids(1), on: { type: 'boolean' }, ...write }, ['entryIds', 'on', 'expectedRevision', 'idempotencyKey'])],
    ['sb_view_open', 'Open explicit entries in one pane and wait for rendering', 'view.write', object({ paneId: handle(), entryIds: ids(1), stepId: handle(), mode: { type: 'string', enum: ['overview', 'grid', 'overlay'] }, cols: { type: 'integer', minimum: 1, maximum: 8 }, rows: { type: 'integer', minimum: 1, maximum: 4 }, split: { type: 'boolean' } }, ['paneId', 'mode'])],
    ['sb_pipeline_get', 'Get a pipeline definition with relative sources and an opaque root token', 'pipeline.read', object({ pipelineId: handle() })],
    ['sb_pipeline_apply', 'Preview or apply an approved allowlisted definition patch without running compute', 'pipeline.write', object({ pipelineId: handle(), operations: { type: 'array', items: operation, minItems: 1, maxItems: 100 }, ...write }, ['pipelineId', 'operations', 'expectedRevision', 'idempotencyKey'])],
  ].map(([name, description, permissionScope, inputSchema]) => ({ name, description, inputSchema, readOnly: permissionScope.endsWith('.read'), mutates: !permissionScope.endsWith('.read'), permissionScope }));
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function fault(code, message) { const error = new Error(message); error.code = code; return error; }
  function isRelative(value, allowEmpty) {
    if (allowEmpty && value === '') return true;
    if (!value || value !== value.trim() || /[\\:\x00-\x1f\x7f%]/.test(value) || value[0] === '/' || value.length > 1024) return false;
    return value.split('/').every(part => part && part !== '..' && part !== '.' && !/[. ]$/.test(part));
  }
  function validate(schema, value, label) {
    label = label || 'args';
    if (schema.oneOf) {
      if (schema.oneOf.filter(candidate => { try { validate(candidate, value, label); return true; } catch (_) { return false; } }).length !== 1) throw fault('INVALID_ARGUMENT', label + ' does not match an allowed operation');
      return;
    }
    if (own(schema, 'const')) { if (value !== schema.const) throw fault('INVALID_ARGUMENT', label + ' has an invalid value'); return; }
    const type = schema.type;
    const valid = type === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
      : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (!valid) throw fault('INVALID_ARGUMENT', label + ' must be ' + type);
    if (schema.enum && !schema.enum.includes(value)) throw fault('INVALID_ARGUMENT', label + ' has an invalid value');
    if (type === 'object') {
      for (const key of Object.keys(value)) if (!own(schema.properties, key)) throw fault('INVALID_ARGUMENT', label + ' has unknown property ' + key);
      for (const key of schema.required || []) if (!own(value, key) || value[key] === undefined) throw fault('INVALID_ARGUMENT', label + '.' + key + ' is required');
      if (Object.keys(value).length < (schema.minProperties || 0)) throw fault('INVALID_ARGUMENT', label + ' cannot be empty');
      for (const key of Object.keys(value)) validate(schema.properties[key], value[key], label + '.' + key);
    } else if (type === 'array') {
      if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems === undefined ? Infinity : schema.maxItems)) throw fault('INVALID_ARGUMENT', label + ' has invalid item count');
      if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) throw fault('INVALID_ARGUMENT', label + ' contains duplicate items');
      value.forEach((item, index) => validate(schema.items, item, label + '[' + index + ']'));
    } else if (type === 'string') {
      if (value.length < (schema.minLength || 0) || value.length > schema.maxLength || ((schema.minLength || 0) > 0 && !value.trim())) throw fault('INVALID_ARGUMENT', label + ' has invalid length');
      if (schema.format && !isRelative(value, schema.format === 'relative-dir')) throw fault('INVALID_ARGUMENT', label + ' must be a safe relative path');
    } else if (type === 'integer' || type === 'number') {
      if (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum) throw fault('INVALID_ARGUMENT', label + ' is outside its allowed bounds');
    }
  }
  function metricsOf(metrics) {
    const out = {};
    for (const key of Object.keys(metrics || {})) {
      const value = metrics[key];
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') out[key] = value;
      else if (typeof value === 'string' && value.length <= 200 && !/[\\/]/.test(value)) out[key] = value;
    }
    return out;
  }
  function safeLabel(value) { return String(value || '').replace(/\\/g, '/').split('/').pop().slice(0, 200); }
  function create(adapter) {
    if (!adapter || typeof adapter.snapshot !== 'function') throw Error('Operation adapter requires snapshot()');
    let sequence = 0, revision = 0, fingerprint = '', snapshot, workspace = '', workspaceIdentity = '';
    const handles = new Map(), records = new Map(), cursors = new Map(), requests = new Map(), pipelines = new Map(), prepared = new Map();
    let mutationQueue = Promise.resolve();
    function id(kind, identity, raw) {
      const key = workspace + ':' + kind + ':' + identity;
      if (!handles.has(key)) {
        const value = kind + '_' + (++sequence).toString(36);
        handles.set(key, value); records.set(value, { workspace, kind, raw });
      } else records.get(handles.get(key)).raw = raw;
      return handles.get(key);
    }
    function stepId(key) { return id('step', key, key); }
    function folderId(key, raw) { return id('folder', key + ':' + raw, { stepKey: key, id: raw }); }
    function entryId(entry) { return id('entry', canonical([entry.stepKey || 'plain', entry.key]), entry); }
    function pipelineId(raw) { return raw ? id('pipeline', raw, raw) : null; }
    function refresh() {
      snapshot = adapter.snapshot();
      const identity = canonical([snapshot.identity || '', snapshot.epoch || 0]);
      if (identity !== workspaceIdentity) {
        workspaceIdentity = identity; workspace = 'workspace_' + (++sequence).toString(36);
        cursors.clear();
      }
      for (const step of snapshot.steps || []) { stepId(step.key); for (const folder of step.folders || []) folderId(step.key, folder.id); }
      for (const entry of snapshot.entries || []) entryId(entry);
      for (const pid of snapshot.pipelineIds || []) pipelineId(pid);
      const next = canonical({ workspace, snapshot, pipelines: Array.from(pipelines).filter(([key]) => key.startsWith(workspace + ':')) });
      if (fingerprint !== next) { fingerprint = next; revision++; }
      return 'r' + revision;
    }
    function resolve(value, kind) {
      const record = records.get(value);
      if (!record || record.kind !== kind || record.workspace !== workspace) throw fault('NOT_FOUND', 'Unknown or stale ' + kind + ' handle');
      if (kind === 'entry') {
        const entry = (snapshot.entries || []).find(item => entryId(item) === value);
        if (!entry) throw fault('NOT_FOUND', 'Entry is no longer available');
        return entry;
      }
      if (kind === 'step' && !(snapshot.steps || []).some(step => step.key === record.raw) && !Array.from(pipelines.values()).some(def => (def.steps || []).some(step => step._key === record.raw))) throw fault('NOT_FOUND', 'Step is no longer available');
      return record.raw;
    }
    function getStep(value) { return resolve(value, 'step'); }
    function entries(values, key) {
      return (values || []).map(value => { const entry = resolve(value, 'entry'); if (key && entry.stepKey !== key) throw fault('INVALID_ARGUMENT', 'Entry belongs to a different step'); return entry; });
    }
    function getFolder(value, key) {
      if (!value) return null;
      const folder = resolve(value, 'folder');
      if (folder.stepKey !== key || !(snapshot.steps || []).some(step => step.key === key && (step.folders || []).some(item => item.id === folder.id))) throw fault('NOT_FOUND', 'Folder is not in this step');
      return folder.id;
    }
    function entryRow(entry, includeMetrics) {
      const row = { entryId: entryId(entry), stepId: stepId(entry.stepKey), name: safeLabel(entry.name), star: !!entry.star, format: entry.format || 'pdb', size: Number(entry.size) || 0, modelIndex: Number.isFinite(entry.modelIndex) ? entry.modelIndex : null, folderId: entry.folderId ? folderId(entry.stepKey, entry.folderId) : null };
      if (includeMetrics) row.metrics = metricsOf(entry.metrics);
      return row;
    }
    function contextResult(args) {
      const includeNotes = args.includeNotes !== false;
      const result = {
        workspaceId: workspace, pipelineId: pipelineId(snapshot.pipelineId),
        counts: { entries: snapshot.entries.length, steps: snapshot.steps.length, folders: snapshot.steps.reduce((sum, step) => sum + (step.folders || []).length, 0), starred: snapshot.entries.filter(entry => entry.star).length, trash: clone(snapshot.trash || {}) },
        panes: (snapshot.panes || []).map(pane => ({ paneId: pane.id, position: pane.position, mode: pane.mode, cols: pane.cols, rows: pane.rows, entryIds: (pane.entryKeys || []).map(key => (snapshot.entries || []).find(entry => canonical([entry.stepKey, entry.key]) === key)).filter(Boolean).map(entryId), active: pane.id === snapshot.activePaneId })),
        steps: snapshot.steps.map(step => {
          const item = { stepId: stepId(step.key), title: safeLabel(step.title), tool: safeLabel(step.tool), entryCount: snapshot.entries.filter(entry => entry.stepKey === step.key).length, folders: (step.folders || []).map(folder => {
            const node = { folderId: folderId(step.key, folder.id), name: safeLabel(folder.name), parentId: folder.parentId ? folderId(step.key, folder.parentId) : null, memberCount: snapshot.entries.filter(entry => entry.stepKey === step.key && entry.folderId === folder.id).length };
            if (includeNotes) node.note = String(folder.note || '');
            return node;
          }) };
          if (includeNotes) item.note = String(step.note || '');
          return item;
        }),
      };
      if (args.includeMetrics) result.metricColumns = Array.from(new Set(snapshot.entries.flatMap(entry => Object.keys(metricsOf(entry.metrics)))));
      return result;
    }
    function checkOwner(owner, context) {
      if (context.signal && context.signal.aborted) throw fault('CANCELLED', 'Operation was cancelled');
      if (owner && adapter.checkOwner) adapter.checkOwner(owner);
    }
    function checkRevision(expected) { if (expected !== refresh()) throw fault('REVISION_CONFLICT', 'Workspace changed; read the current revision and retry'); }
    function cachePipeline(pid, definition) {
      const value = clone(definition);
      if (!value || value.id !== pid || !Array.isArray(value.steps) || !value.root) throw fault('PIPELINE_UNAVAILABLE', 'Pipeline definition is unavailable');
      value.steps.forEach(step => { step._key = pid + ':' + step.id; stepId(step._key); });
      pipelines.set(workspace + ':' + pid, value);
      refresh(); return value;
    }
    function publicDefinition(definition) {
      const relativeOut = (value, empty) => isRelative(value, empty) ? value : null;
      return { pipelineId: pipelineId(definition.id), name: safeLabel(definition.name), rootToken: id('root', definition.id + ':' + definition.root, definition.root), steps: definition.steps.map(step => {
        const value = { stepId: stepId(step._key), title: safeLabel(step.title), tool: safeLabel(step.tool), dir: relativeOut(step.dir || '', true), globs: (step.globs || []).map(path => relativeOut(path, false)).filter(Boolean), starGlobs: (step.starGlobs || []).map(path => relativeOut(path, false)).filter(Boolean), files: (step.files || []).map(file => ({ name: safeLabel(file.name), path: relativeOut(file.path || file.name, false) })).filter(file => file.path) };
        return value;
      }) };
    }
    function applyPatch(definition, operations) {
      const result = clone(definition);
      for (const operation of operations) {
        if (operation.op === 'set_name') result.name = operation.name.trim();
        else if (operation.op === 'update_step') {
          const key = getStep(operation.stepId), step = result.steps.find(step => step._key === key);
          if (!step) throw fault('INVALID_ARGUMENT', 'Step is not in this pipeline');
          Object.assign(step, clone(operation.patch));
        } else {
          const keys = operation.stepIds.map(getStep);
          if (keys.length !== result.steps.length || result.steps.some(step => !keys.includes(step._key))) throw fault('INVALID_ARGUMENT', 'stepIds must contain every pipeline step exactly once');
          result.steps = keys.map(key => result.steps.find(step => step._key === key));
        }
      }
      return result;
    }
    async function run(name, args, context, owner) {
      checkOwner(owner, context);
      if (name === 'sb_get_context') return { result: contextResult(args) };
      if (name === 'sb_list_entries') {
        const key = args.stepId ? getStep(args.stepId) : '', currentRevision = refresh();
        let offset = 0;
        if (args.cursor) {
          const cursor = cursors.get(args.cursor);
          if (!cursor || cursor.workspace !== workspace || cursor.stepKey !== key || cursor.metrics !== !!args.includeMetrics) throw fault('INVALID_CURSOR', 'Cursor does not match this entry query');
          if (cursor.revision !== currentRevision) throw fault('REVISION_CONFLICT', 'Workspace changed since the previous page');
          offset = cursor.offset;
        }
        const list = snapshot.entries.filter(entry => !key || entry.stepKey === key), limit = args.limit || 100;
        let nextCursor = null;
        if (offset + limit < list.length) {
          nextCursor = 'cursor_' + (++sequence).toString(36);
          cursors.set(nextCursor, { workspace, stepKey: key, revision: currentRevision, metrics: !!args.includeMetrics, offset: offset + limit });
          if (cursors.size > 1000) cursors.delete(cursors.keys().next().value);
        }
        return { result: { items: list.slice(offset, offset + limit).map(entry => entryRow(entry, !!args.includeMetrics)), total: list.length, offset, nextCursor } };
      }
      if (name === 'sb_view_open') {
        const stepKey = args.stepId ? getStep(args.stepId) : '';
        const selected = args.entryIds ? entries(args.entryIds, stepKey) : snapshot.entries.filter(entry => !stepKey || entry.stepKey === stepKey);
        if (args.mode !== 'overview' && !selected.length) throw fault('INVALID_ARGUMENT', 'No entries selected for this view');
        const result = await adapter.openView({ ...args, stepKey, entries: selected }, owner, context);
        checkOwner(owner, context);
        const actual = result || {};
        const byKey = new Map(selected.map(entry => [entry.key, entry]));
        return { result: { paneId: actual.paneId, mode: args.mode, selected: selected.length, loaded: (actual.loaded || []).map(key => byKey.get(key)).filter(Boolean).map(entryId), failed: (actual.failed || []).map(key => byKey.get(key)).filter(Boolean).map(entryId), pending: (actual.pending || []).map(key => byKey.get(key)).filter(Boolean).map(entryId), cols: actual.cols, rows: actual.rows }, durability: 'view' };
      }
      if (name === 'sb_pipeline_get' || name === 'sb_pipeline_apply') {
        const pid = args.pipelineId ? resolve(args.pipelineId, 'pipeline') : snapshot.pipelineId;
        if (!pid || !(snapshot.pipelineIds || []).includes(pid)) throw fault('NOT_FOUND', 'Pipeline is not authorized in this workspace');
        const previous = pipelines.get(workspace + ':' + pid);
        const definition = await adapter.readPipeline(pid, owner, context);
        checkOwner(owner, context);
        const value = cachePipeline(pid, definition);
        if (name === 'sb_pipeline_get') return { result: { definition: publicDefinition(value) } };
        if (previous && canonical(previous) !== canonical(value)) throw fault('REVISION_CONFLICT', 'Pipeline definition changed; prepare again');
        checkRevision(args.expectedRevision);
        let next, diff, preparedRecord;
        const payload = canonical(args);
        if (context.phase === 'prepare') {
          next = applyPatch(value, args.operations);
          diff = { pipelineId: pipelineId(pid), before: publicDefinition(value), after: publicDefinition(next) };
          if (adapter.validatePipeline) await adapter.validatePipeline(pid, next, owner, context);
          checkOwner(owner, context); checkRevision(args.expectedRevision);
          const preparedId = 'prepared_' + (++sequence).toString(36);
          prepared.set(preparedId, { workspace, pid, payload, before: canonical(value), candidate: clone(next), diff: clone(diff), sessionId: String(context.sessionId || context.source || 'builtin'), revision: args.expectedRevision });
          if (prepared.size > 100) prepared.delete(prepared.keys().next().value);
          return { result: { diff, operations: clone(args.operations), expectedRevision: args.expectedRevision, requiresApproval: true, preparedId }, durability: 'preview' };
        }
        if (context.approved !== true) throw fault('APPROVAL_REQUIRED', 'Pipeline definition changes require approval from the trusted bridge');
        const input = context.prepared, token = typeof input === 'string' ? input : input && (input.preparedId || input.result && input.result.preparedId);
        preparedRecord = prepared.get(token);
        if (!preparedRecord || preparedRecord.workspace !== workspace || preparedRecord.pid !== pid || preparedRecord.payload !== payload || preparedRecord.revision !== args.expectedRevision || preparedRecord.sessionId !== String(context.sessionId || context.source || 'builtin')) throw fault('PREPARE_REQUIRED', 'Prepare the same definition change before applying it');
        if (preparedRecord.before !== canonical(value)) throw fault('REVISION_CONFLICT', 'Pipeline definition changed after preview');
        next = clone(preparedRecord.candidate); diff = clone(preparedRecord.diff);
        checkOwner(owner, context); checkRevision(args.expectedRevision);
        const clean = clone(next); clean.steps.forEach(step => delete step._key);
        await adapter.writePipeline(pid, clean, value, owner, { ...context, beforeCommit: function () { checkOwner(owner, context); checkRevision(args.expectedRevision); } });
        checkOwner(owner, context); cachePipeline(pid, clean); prepared.delete(token);
        return { result: { applied: true, diff, definition: publicDefinition(pipelines.get(workspace + ':' + pid)) }, durability: 'pipeline' };
      }
      checkRevision(args.expectedRevision);
      let result;
      if (name === 'sb_notes_set') {
        adapter.setNote(getStep(args.stepId), args.text, owner, context);
        result = { stepId: args.stepId, saved: true };
      }
      if (name === 'sb_folder_create') {
        const key = getStep(args.stepId), parentId = getFolder(args.parentId, key), selected = entries(args.entryIds, key);
        const created = adapter.createFolder(key, args.name.trim(), parentId, selected, owner, context);
        result = { folderId: folderId(key, created.folderId), members: selected.length, stepId: args.stepId };
      }
      if (name === 'sb_folder_move') {
        const key = getStep(args.stepId), folder = getFolder(args.folderId, key), selected = entries(args.entryIds, key);
        adapter.moveEntries(key, selected, folder, owner, context);
        result = { moved: selected.length, folderId: args.folderId || null, stepId: args.stepId };
      }
      if (name === 'sb_star_set') result = adapter.setStars(entries(args.entryIds), args.on, owner, context);
      result = await result;
      checkOwner(owner, context);
      return { result: result || { saved: true }, durability: adapter.durability ? adapter.durability(name) : 'queued' };
    }
    async function execute(tool, args, context) {
      context = context || {};
      let owner, spec;
      const errorResult = error => {
        let current; try { current = refresh(); } catch (_) { current = 'r' + revision; }
        return { ok: false, error: { code: error.code || 'OPERATION_FAILED', message: error.code ? error.message : 'Workspace operation failed' }, revision: current };
      };
      try {
        refresh();
        spec = definitions.find(item => item.name === tool);
        if (!spec) throw fault('UNKNOWN_TOOL', 'Unknown workspace tool');
        validate(spec.inputSchema, args === undefined ? {} : args);
        args = clone(args || {});
        const allowed = context.scopes;
        const coarse = spec.permissionScope.endsWith('.read') ? 'read' : spec.permissionScope === 'view.write' ? 'view' : 'edit';
        if (allowed && (!Array.isArray(allowed) || !allowed.includes(spec.permissionScope) && !allowed.includes(coarse) && !(spec.permissionScope === 'pipeline.read' && allowed.includes('workspace.read')))) throw fault('PERMISSION_DENIED', 'Required scope: ' + spec.permissionScope);
        if (context.phase !== undefined && !['prepare', 'apply', 'execute'].includes(context.phase)) throw fault('INVALID_ARGUMENT', 'context.phase must be prepare, apply, or execute');
        owner = adapter.captureOwner ? adapter.captureOwner(tool, args) : null;
        const preparing = tool === 'sb_pipeline_apply' && context.phase === 'prepare';
        if (tool === 'sb_pipeline_apply' && !preparing && context.approved !== true) throw fault('APPROVAL_REQUIRED', 'Pipeline definition changes require approval from the trusted bridge');
        const needsKey = own(args, 'idempotencyKey') && !preparing;
        const scope = workspace + ':' + String(context.sessionId || context.source || 'builtin') + ':' + String(args.idempotencyKey || '');
        const payload = canonical({ tool, args });
        if (needsKey && requests.has(scope)) {
          const previous = requests.get(scope);
          if (previous.payload !== payload) throw fault('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different payload');
          return clone(await previous.promise);
        }
        const perform = async () => {
          try {
            checkOwner(owner, context); refresh();
            if (spec.mutates && tool !== 'sb_view_open' && !preparing) checkRevision(args.expectedRevision);
            const outcome = await run(tool, args, context, owner);
            const response = { ok: true, result: outcome.result, revision: refresh() };
            if (outcome.durability) response.durability = outcome.durability;
            if (needsKey) response.changeId = 'change_' + (++sequence).toString(36);
            return response;
          } catch (error) { return errorResult(error); }
        };
        let task;
        if (spec.mutates) { task = mutationQueue.catch(() => {}).then(perform); mutationQueue = task; }
        else task = perform();
        if (needsKey) {
          requests.set(scope, { payload, promise: task });
          task.then(response => { if (!response.ok) requests.delete(scope); });
        }
        return clone(await task);
      } catch (error) { return errorResult(error); }
    }
    return { listTools: () => clone(definitions), execute, getContext: args => execute('sb_get_context', args || {}, {}) };
  }
  return { create, listTools: () => clone(definitions), validate, isRelative };
});
