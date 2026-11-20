// UI commands own ordering; the workspace service owns durable transactions.
// No DOM, Vue state, structure bytes, viewers or global workspace access here.
export function createTabController(catalog, initialHandlers = {}) {
  let handlers = initialHandlers, active = null, disposed = false;
  const queue = [], pending = new Map(), listeners = new Set();
  let state = Object.freeze({ busy: false, pending: 0, command: '' });
  function publish() {
    state = Object.freeze({ busy: !!active, pending: queue.length, command: active?.type || '' });
    for (const fn of listeners) fn(state);
  }
  async function pump() {
    if (active || disposed || !queue.length) return;
    active = queue.shift(); publish();
    const task = active;
    try {
      if (task.id && !catalog.get(task.id)) { task.resolve(false); return; }
      const names = { select: 'onSelect', close: 'onClose', add: 'onAdd', detach: 'onDetach' };
      if (task.type === 'move') {
        if (task.beforeId && !catalog.get(task.beforeId)) { task.resolve(false); return; }
        const moved = catalog.move(task.id, task.beforeId);
        if (moved) await handlers.onChange?.();
        task.resolve(moved);
      } else {
        const action = handlers[names[task.type]];
        task.resolve(action ? await action(task.id) : false);
      }
    } catch (error) { task.reject(error); }
    finally {
      pending.delete(task.key); active = null;
      if (!disposed) { publish(); void pump(); }
    }
  }
  function dispatch(type, id = '', beforeId = '') {
    if (!['select', 'close', 'add', 'detach', 'move'].includes(type)) return Promise.reject(Error('Unknown tab command: ' + type));
    if (disposed) return Promise.resolve(false);
    const key = JSON.stringify([type, id, beforeId]);
    if (pending.has(key)) return pending.get(key).promise;
    if (queue.length >= 32) return Promise.resolve(false);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = { key, type, id, beforeId, resolve, reject, promise };
    pending.set(key, task); queue.push(task);
    if (active) publish(); else void pump();
    return promise;
  }
  return {
    dispatch, getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    updateHandlers(next) { handlers = next || {}; },
    dispose() {
      disposed = true;
      for (const task of queue.splice(0)) { pending.delete(task.key); task.resolve(false); }
      listeners.clear();
      // An already-dispatched durable workspace save must be allowed to finish.
    },
  };
}
