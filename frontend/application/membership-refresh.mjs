// Upgrade durable membership metadata without owning a view or hiding failures.
// Every request (including its response body) is bounded; cancellation propagates
// to the workspace transaction so the currently displayed workspace survives.
export async function refreshMemberships(snapshot, options) {
  const { migration, signal, progress = () => {}, pending = () => {}, backup } = options;
  const fetcher = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  const datasets = [], ids = migration.ids(snapshot);
  function check() { if (signal?.aborted) throw new DOMException('来源核对已取消', 'AbortError'); }
  async function request(url, label) {
    check(); const controller = new AbortController();
    let timer, abort;
    const stopped = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new DOMException('来源核对已取消', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(Error('读取「' + label + '」超时，原工作区已保留')); }, timeoutMs);
    });
    try {
      const value = await Promise.race([stopped, (async () => {
        const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.ok) throw Error(data.error || '读取「' + label + '」失败');
        return data;
      })()]);
      check(); return value;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  for (let index = 0; index < ids.length; index++) {
    const pid = ids[index];
    try {
      const raw = await request('/api/pipeline?id=' + encodeURIComponent(pid) + '&raw=1', '管线定义');
      if (!raw.pipeline) throw Error('管线定义为空');
      if (!migration.needs(snapshot, raw.pipeline)) continue;
      const manifests = [], steps = raw.pipeline.steps || [];
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        check(); const step = steps[stepIndex], fraction = (index + stepIndex / Math.max(1, steps.length)) / ids.length;
        progress(5 + fraction * 85, (stepIndex + 1) + ' / ' + steps.length + ' · 核对「' + (step.title || step.id) + '」的成员');
        const manifest = await request('/api/pipeline/structures?id=' + encodeURIComponent(pid) + '&step=' + encodeURIComponent(step.id), step.title || step.id);
        manifests.push(manifest);
      }
      datasets.push({ definition: raw.pipeline, manifests });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      pending(pid, error);
    }
  }
  check();
  if (!datasets.length) return { snapshot, report: null };
  progress(95, '保存原工作区备份…'); await backup(snapshot); check();
  progress(98, '整理来源信息…'); const result = migration.reconcile(snapshot, datasets); check();
  result.snapshot.trashFolders = snapshot.trashFolders || [];
  result.snapshot.trashSteps = snapshot.trashSteps || [];
  return result;
}
