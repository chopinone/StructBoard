// Framework-independent workspace transactions. Storage and viewer operations
// are ports: this service never reads DOM, globals, structure bytes or Mol*.
export function createWorkspaceService({ catalog, storage, workspace, persistence, windows, ui }) {
  let busy = false;
  const labels = { create: '新建标签页失败', switch: '切换工作区失败', close: '关闭标签失败', detach: '分离窗口失败' };
  async function prepare() {
    workspace.flushNotes();
    if (!await persistence.flush()) throw Error('当前工作区尚未保存成功');
    workspace.saveView();
    return { id: workspace.currentId(), key: storage.getKey(), snapshot: workspace.capture(),
      catalog: catalog.getSnapshot(), version: persistence.version() };
  }
  function unchanged(checkpoint) {
    if (persistence.version() !== checkpoint.version) throw Error('当前工作区有新修改，请重试');
  }
  async function rollback(checkpoint) {
    storage.setKey(checkpoint.key);
    workspace.setRestoring(true);
    await workspace.reset();
    await workspace.restore(checkpoint.snapshot);
    catalog.restore(checkpoint.catalog);
    storage.setKey(checkpoint.key);
    ui.refresh();
  }
  async function run(kind, operation) {
    if (busy || workspace.blocked()) return false;
    busy = true; ui.busy(true);
    const transaction = { checkpoint: null, changedView: false, transferred: false };
    try { return await operation(transaction); }
    catch (error) {
      let recoveryFailed = false;
      if (transaction.changedView && transaction.checkpoint) {
        try { await rollback(transaction.checkpoint); }
        catch (_) { recoveryFailed = true; }
      }
      ui.error(labels[kind] + '：' + (error.message || String(error)) +
        (transaction.transferred ? '。独立窗口已经打开，原标签已保留。' : '') +
        (recoveryFailed ? '。原快照仍在，重新打开标签可恢复。' : ''));
      return false;
    } finally {
      workspace.setRestoring(false);
      busy = false; ui.busy(false); ui.finalize();
    }
  }
  async function show(id, transaction) {
    const tab = catalog.get(id);
    if (!tab) throw Error('标签已不存在');
    if (id === workspace.currentId()) { catalog.activate(id); ui.refresh(); return true; }
    const checkpoint = transaction.checkpoint || (transaction.checkpoint = await prepare());
    const targetKey = workspace.key(id);
    let snapshot = await storage.load(targetKey);
    if (!snapshot) {
      if (workspace.isLocal(id)) throw Error('本地结构工作区快照不存在');
      unchanged(checkpoint);
      transaction.changedView = true;
      if (!await workspace.importPipeline(id)) throw Error('管线载入未完成');
      return true;
    }
    if (snapshot.entries?.some(entry => entry.pipelineId || entry.stepKey || entry.lazy?.fetchUrl)) {
      snapshot = await workspace.migrate(snapshot);
    }
    unchanged(checkpoint);
    transaction.changedView = true;
    workspace.setRestoring(true); storage.setKey(targetKey);
    await workspace.reset(); await workspace.restore(snapshot);
    workspace.setName(snapshot.activePipelineName || tab.name);
    catalog.activate(id); storage.setKey(targetKey); ui.refresh();
    if (!workspace.isLocal(id)) workspace.hydrateNotes(id);
    ui.status('已切换到「' + (snapshot.activePipelineName || tab.name) + '」');
    return true;
  }
  async function clear(transaction) {
    unchanged(transaction.checkpoint);
    transaction.changedView = true; workspace.setRestoring(true);
    storage.setKey(workspace.key(''));
    await workspace.reset(); await workspace.restore(workspace.empty(''));
    workspace.clearIdentity(); persistence.clearLastSession();
  }
  return {
    get busy() { return busy; },
    switchTo(id) { return run('switch', transaction => show(id, transaction)); },
    create() {
      return run('create', async transaction => {
        workspace.ensureCurrentTab();
        const checkpoint = transaction.checkpoint = await prepare();
        const id = 'local:' + workspace.uuid(), key = workspace.key(id);
        const snapshot = workspace.empty(id);
        await storage.save(snapshot, { key });
        unchanged(checkpoint);
        transaction.changedView = true; workspace.setRestoring(true);
        await workspace.reset(); storage.setKey(key); await workspace.restore(snapshot);
        catalog.add({ id, name: '新标签页' }, true); ui.refresh();
        ui.status('新标签页 · 导入文件、文件夹或管线 JSON');
        return true;
      });
    },
    close(id) {
      return run('close', async transaction => {
        if (!catalog.get(id)) return false;
        if (id === workspace.currentId()) {
          transaction.checkpoint = await prepare();
          const items = catalog.items, index = items.findIndex(item => item.id === id);
          const next = items[index + 1] || items[index - 1];
          if (next) await show(next.id, transaction);
          else await clear(transaction);
        }
        catalog.remove(id); ui.refresh(); ui.status('标签已关闭');
        return true;
      });
    },
    detach(id) {
      return run('detach', async transaction => {
        const tab = catalog.get(id);
        if (!tab) return false;
        if (!windows.available()) throw Error('拖出标签需要桌面版窗口');
        const active = id === workspace.currentId();
        if (active) transaction.checkpoint = await prepare();
        const windowKey = 'w_' + workspace.uuid().replaceAll('-', '');
        const targetKey = workspace.key(id, windowKey);
        let child = null;
        try {
          const snapshot = await storage.load(workspace.key(id));
          if (!snapshot) throw Error('工作区快照尚未保存');
          workspace.rekey(snapshot, id, windowKey);
          snapshot.viewState = workspace.viewFor(id) || snapshot.viewState;
          await storage.save(snapshot, { key: targetKey });
          if (active) unchanged(transaction.checkpoint);
          child = windows.catalog(windowKey); child.add(tab, true);
          await windows.open({ workspaceWindowKey: windowKey, title: tab.name, snapshot, tabs: [tab] });
          transaction.transferred = true;
          if (active) {
            const next = catalog.items.find(item => item.id !== id);
            if (next) await show(next.id, transaction); else await clear(transaction);
          }
          catalog.remove(id); ui.refresh();
          return true;
        } catch (error) {
          // Once the native window acknowledged ownership, preserve its snapshot
          // even if returning the parent to another tab fails.
          if (!transaction.transferred) {
            child?.remove(id);
            await storage.clear(targetKey).catch(() => {});
          }
          throw error;
        } finally { child?.destroy(); }
      });
    },
  };
}
