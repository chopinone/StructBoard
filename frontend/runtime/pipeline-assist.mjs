// pipeline-assist: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function stripJsonFence(text) {
    let t = String(text || '').trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) t = fenced[1].trim();
    const first = t.indexOf('{'), last = t.lastIndexOf('}');
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
    return t;
  }
  function summarizeDefinitionForConfirm(defn) {
    if (!defn || typeof defn !== 'object' || Array.isArray(defn)) return { ok: false, error: 'JSON 顶层必须是对象' };
    if (!Array.isArray(defn.steps) || !defn.steps.length) return { ok: false, error: 'steps 必须是非空数组' };
    const lines = [];
    let totalRules = 0;
    for (const st of defn.steps) {
      if (!st || typeof st !== 'object' || Array.isArray(st)) return { ok: false, error: 'steps 里每一项都必须是对象' };
      const globs = Array.isArray(st.globs) ? st.globs.filter(function (g) { return typeof g === 'string'; }) : [];
      const files = Array.isArray(st.files) ? st.files.length : 0;
      totalRules += globs.length + files;
      if (lines.length < 8) {
        lines.push({
          title: st.title || st.id || '（未命名）',
          match: globs.length ? globs.length + ' 个通配符' : (files ? files + ' 个文件' : '没有匹配规则'),
        });
      }
    }
    return { ok: true, summary: {
      id: String(defn.id || ''), name: String(defn.name || ''),
      root: String(defn.root || ''), stepCount: defn.steps.length,
      totalRules: totalRules, lines: lines,
    } };
  }
  async function postPipelineDefinition(defn, overwrite) {
    // 本地服务理论上毫秒级响应；给个 20s 超时，挂起时让用户看到明确错误而不是永远转圈。
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      const res = await fetch('/api/pipeline/import?raw=1&overwrite=' + (overwrite ? '1' : '0'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defn),
        signal: controller.signal,
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ('导入失败（HTTP ' + res.status + '）'));
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('导入请求超时：本地服务没有响应，请确认服务仍在运行后重试');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  function showAIPipelineError(message, jsonText) {
    const box = ports.$('aiAssistError');
    ports.aiAssistLastRaw = String(jsonText || '');
    box.textContent = message;
    box.hidden = false;
    ports.$('aiAssistFix').hidden = false;
  }
  function openAIPipelineAssist() {
    ports.$('aiAssistError').hidden = true;
    ports.$('aiAssistFix').hidden = true;
    ports.$('aiAssistText').value = '';
    const mask = ports.$('aiAssistMask');
    mask.hidden = false;
    requestAnimationFrame(function () { mask.classList.add('open'); });
    setTimeout(function () { ports.$('aiAssistText').focus(); }, 40);
  }
  function closeAIPipelineAssist() {
    const mask = ports.$('aiAssistMask');
    mask.classList.remove('open');
    setTimeout(function () { mask.hidden = true; }, 200);
  }
  async function importAIPipelineJson() {
    const raw = ports.$('aiAssistText').value;
    let defn;
    try { defn = JSON.parse(stripJsonFence(raw)); }
    catch (e) { showAIPipelineError('JSON 解析失败：' + e.message, raw); return; }
    const shape = summarizeDefinitionForConfirm(defn);
    if (!shape.ok) { showAIPipelineError(shape.error, raw); return; }
    const s = shape.summary;
    const picked = await ports.askSheet({
      title: '确认导入这份管线？',
      message: (s.name || s.id || '未命名管线') + ' · ' + s.stepCount + ' 步 · ' + s.totalRules + ' 条匹配规则',
      choices: [{ value: 'go', label: '导入并打开总览', detail: s.root ? ('root: ' + s.root) : 'root 未填（导入后可再改）' }],
    });
    if (picked !== 'go') return;
    // 导入期间锁定按钮并给进行中反馈，避免误以为没反应。
    const submitBtn = ports.$('aiAssistImport');
    const prevLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '正在导入…';
    let saved;
    try {
      saved = await postPipelineDefinition(defn, false);
    } catch (err) {
      if (!/已存在同名管线/.test(err.message)) { showAIPipelineError(err.message, raw); return; }
      const over = await ports.askSheet({
        title: '同名管线已存在',
        message: err.message,
        choices: [{ value: 'over', label: '覆盖旧定义并导入', detail: '已有的整理、便签保留在本机会话里' }],
      });
      if (over !== 'over') return;
      try { saved = await postPipelineDefinition(defn, true); }
      catch (e2) { showAIPipelineError(e2.message, raw); return; }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
    }
    closeAIPipelineAssist();
    ports.toast(saved.message || '管线已导入');
    // 直接进总览：复用 bind() 里暴露的批量导入桥（importWholePipeline 是闭包私有）。
    // 它会按步骤顺序载入并 setMode('overview')；失败时有进度面板与 toast。
    window.__SB_RESTORE_PIPELINE__(saved.id);
  }
  function bindAIPipelineAssist() {
    // 首页和总览入口由 bindPaneControls 委托；此处只绑定全窗唯一的对话框。
    ports.$('aiAssistPrompt').addEventListener('click', function () { ports.copyText(ports.AI_PIPELINE_PROMPT, '提示词已复制，发给任意 AI 即可'); });
    ports.$('aiAssistExample').addEventListener('click', function () {
      ports.copyText(JSON.stringify(ports.AI_PIPELINE_EXAMPLE, null, 2), '示例 JSON 已复制');
    });
    ports.$('aiAssistCancel').addEventListener('click', closeAIPipelineAssist);
    ports.$('aiAssistFix').addEventListener('click', function () {
      ports.copyText([
        '我生成的 StructBoard 管线 JSON 导入失败了。请修正后只输出修正后的 JSON。',
        '',
        '错误：' + ports.$('aiAssistError').textContent,
        '',
        'JSON：',
        ports.aiAssistLastRaw,
      ].join('\n'), 'JSON 与错误已复制，发给 AI 修正');
    });
    ports.$('aiAssistMask').addEventListener('click', function (e) {
      if (e.target === ports.$('aiAssistMask')) closeAIPipelineAssist();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || ports.$('aiAssistMask').hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeAIPipelineAssist();
    }, true);
    ports.$('aiAssistSheet').addEventListener('submit', function (e) {
      e.preventDefault();
      importAIPipelineJson();
    });
  }
// SERVICE_FUNCTIONS_END
  return { stripJsonFence, summarizeDefinitionForConfirm, postPipelineDefinition, showAIPipelineError, openAIPipelineAssist, closeAIPipelineAssist, importAIPipelineJson, bindAIPipelineAssist };
}
