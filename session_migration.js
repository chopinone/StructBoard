/* Restore old physical-file snapshots as independent per-step memberships.
   Pure reconciliation: no structure writes, no file-name inference, no storage IO. */
(function (root) {
  'use strict';
  const VERSION = 2;
  const norm = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const oldKey = e => e.sourceKey || e.name + ':' + (e.size || 0);
  const fullPath = (e, base) => {
    const p = e.fullPath || e.path || '';
    return norm(/^(?:[A-Za-z]:[\\/]|\/)/.test(p) ? p : String(base || '').replace(/[\\/]+$/, '') + '/' + p);
  };
  function fingerprint(definition) {
    // Folder organization is display-only; ignore it so rearranging
    // cards never retriggers membership reconciliation.
    if (!definition || typeof definition !== 'object') return JSON.stringify(definition);
    const copy = Object.assign({}, definition);
    if (Array.isArray(copy.steps)) {
      copy.steps = copy.steps.map(function (step) {
        if (!step || step.organization === undefined) return step;
        const next = Object.assign({}, step);
        delete next.organization;
        return next;
      });
    }
    return JSON.stringify(copy);
  }
  function ids(snapshot) {
    const result = new Set();
    for (const e of snapshot.entries || []) {
      if (e.pipelineId) result.add(e.pipelineId);
      else if (e.stepKey && e.fetchUrl) {
        try { const p = new URL(e.fetchUrl, 'http://localhost').searchParams.get('id'); if (p) result.add(p); } catch (_) {}
      }
    }
    return Array.from(result);
  }
  function needs(snapshot, definition) {
    if (!snapshot || snapshot.membershipVersion !== VERSION) return true;
    return !snapshot.definitionFingerprints || snapshot.definitionFingerprints[definition.id] !== fingerprint(definition);
  }
  function reconcile(snapshot, datasets) {
    if (!snapshot || !Array.isArray(snapshot.entries)) throw Error('Invalid snapshot');
    const original = snapshot.entries;
    const result = Object.assign({}, snapshot, { entries: [], groups: [], membershipVersion: VERSION,
      definitionFingerprints: Object.assign({}, snapshot.definitionFingerprints || {}) });
    const rebuilt = new Map(), consumed = new Set(), mapping = new Map();
    const report = { version: VERSION, beforeEntries: original.length, afterEntries: 0, pipelines: [], steps: [], newMemberships: 0 };
    const oldGroups = snapshot.groups || [];
    for (const dataset of datasets) {
      const def = dataset.definition, manifests = dataset.manifests;
      if (!def || !def.id || !Array.isArray(def.steps)) throw Error('Invalid current definition');
      const rawBySource = new Map(original.filter(e => e.pipelineId === def.id || String(e.stepKey || '').startsWith(def.id + ':')).map(e => [oldKey(e), e]));
      const rawByPath = new Map();
      for (const e of rawBySource.values()) {
        const p = fullPath(e, def.root);
        if (!rawByPath.has(p)) rawByPath.set(p, []);
        rawByPath.get(p).push(e);
      }
      def.steps.forEach((step, stepIndex) => {
        const m = manifests.find(x => x.stepId === step.id);
        if (!m || !Array.isArray(m.files)) throw Error('Incomplete step manifest: ' + step.id);
        const stepKey = def.id + ':' + step.id;
        const previousGroup = oldGroups.find(g => g.pipelineKey === stepKey);
        const previousGroupKeys = new Set(previousGroup ? previousGroup.keys || [] : []);
        const currentKeys = [], seen = new Set();
        for (const f of m.files) {
          if (!f.sourceKey || seen.has(f.sourceKey)) throw Error('Duplicate or missing step identity: ' + step.id);
          seen.add(f.sourceKey);
          const donors = rawByPath.get(fullPath(f, def.root)) || [];
          const sameStage = donors.find(e => e.stepKey === stepKey);
          const donor = sameStage || donors.find(e => previousGroupKeys.has(oldKey(e))) || donors[0];
          const explicitRename = donor && (donor.renamed || (!donor.lineage && donor.name &&
            donor.name !== String(donor.fullPath || donor.path || '').replace(/\\/g, '/').split('/').pop()));
          const raw = donor ? Object.assign({}, donor) : {};
          // Never inherit another stage's star, visibility or metrics simply
          // because an old application had deduplicated the physical structure.
          if (!sameStage) { raw.metrics = null; raw.starManual = false; raw.visible = true; }
          const physicalMatches = donor && ((donor.fileKey || donor.sourceKey) === f.fileKey || donor.sourceKey === f.sourceKey);
          if (!physicalMatches) { raw.data = ''; raw.parsed = null; delete raw.metrics; }
          const physicalName = String(f.path).split('/').pop();
          Object.assign(raw, { name: explicitRename ? donor.name : f.name, renamed: !!explicitRename,
            path: f.fullPath || f.path, fullPath: f.fullPath || '', sourceKey: f.sourceKey, fileKey: f.fileKey,
            size: f.size, format: /\.(?:cif|mmcif|mcif)(?:\.gz)?$/i.test(physicalName) ? 'mmcif' : /\.bcif(?:\.gz)?$/i.test(physicalName) ? 'bcif' : 'pdb',
            group: f.group || null, groupKind: f.groupKind || null, groupKey: f.groupKey || null,
            groupingWarning: f.groupingWarning || '', lineage: Object.assign({}, f.lineage || {}),
            modelIndex: f.modelIndex == null ? null : f.modelIndex,
            star: sameStage && sameStage.starManual ? !!sameStage.star : !!f.star,
            starManual: !!(sameStage && sameStage.starManual),
            lazy: true, fetchUrl: '/api/pipeline/structure?id=' + encodeURIComponent(def.id) + '&step=' + encodeURIComponent(step.id) + '&path=' + encodeURIComponent(f.path),
            stepKey: stepKey, stepIndex: sameStage && Number.isFinite(sameStage.stepIndex) ? sameStage.stepIndex : previousGroup && Number.isFinite(previousGroup.stepIndex) ? previousGroup.stepIndex : stepIndex,
            stepTitle: sameStage && sameStage.stepTitle || previousGroup && previousGroup.name || step.title,
            stepTool: sameStage && sameStage.stepTool || m.tool || step.tool || '',
            stepOperation: m.operation || '', stepState: m.state || step.state || '', stepDesc: m.desc || step.desc || '',
            pipelineId: def.id, sessionMembershipVersion: VERSION });
          result.entries.push(raw);
          currentKeys.push(raw.sourceKey);
          if (!sameStage) report.newMemberships++;
          for (const e of donors) {
            if (!mapping.has(oldKey(e))) mapping.set(oldKey(e), []);
            mapping.get(oldKey(e)).push({ key: raw.sourceKey, stepKey: stepKey });
            // Only consume a donor when its own current step is reconstructed.
            if (e.stepKey === stepKey) consumed.add(e);
          }
        }
        rebuilt.set(stepKey, Object.assign({}, previousGroup || {}, { name: previousGroup && previousGroup.name || m.title || step.title,
          pipelineKey: stepKey, stepIndex: previousGroup && Number.isFinite(previousGroup.stepIndex) ? previousGroup.stepIndex : stepIndex, keys: currentKeys }));
        report.steps.push({ pipelineId: def.id, id: step.id, before: original.filter(e => e.stepKey === stepKey).length,
          after: currentKeys.length, parents: new Set(m.files.map(e => (e.lineage || {}).parentId).filter(Boolean)).size });
      });
      result.definitionFingerprints[def.id] = fingerprint(def);
      report.pipelines.push(def.id);
    }
    // Unrelated imports and user-created/derived steps remain intact. Entries no
    // longer named by a definition are retained instead of silently discarded.
    const nowKeys = new Set(result.entries.map(oldKey));
    for (const e of original) {
      if (!consumed.has(e) && !nowKeys.has(oldKey(e))) { result.entries.push(e); nowKeys.add(oldKey(e)); }
    }
    const usedGroups = new Set();
    for (const group of oldGroups) {
      if (rebuilt.has(group.pipelineKey)) {
        if (!usedGroups.has(group.pipelineKey)) result.groups.push(rebuilt.get(group.pipelineKey));
        usedGroups.add(group.pipelineKey);
      } else {
        const keys = [];
        for (const key of group.keys || []) {
          if (nowKeys.has(key)) keys.push(key);
          else for (const match of mapping.get(key) || []) if (!group.pipelineKey || match.stepKey === group.pipelineKey) keys.push(match.key);
        }
        result.groups.push(Object.assign({}, group, { keys: Array.from(new Set(keys)) }));
      }
    }
    for (const [key, group] of rebuilt) if (!usedGroups.has(key)) result.groups.push(group);
    report.afterEntries = result.entries.length;
    result.migrationReport = report;
    result.savedAt = Date.now();
    return { snapshot: result, report: report };
  }
  root.SB_SESSION_MIGRATION = { VERSION: VERSION, ids: ids, needs: needs, reconcile: reconcile, fingerprint: fingerprint };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SB_SESSION_MIGRATION;
})(typeof window === 'undefined' ? globalThis : window);
