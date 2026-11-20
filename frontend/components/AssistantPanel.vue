<template>
  <button type="button" class="ai-bubble" title="StructBoard AI 助手" aria-label="StructBoard AI 助手"><img class="ai-bubble-logo" :src="'ai_logo.png'" alt="" aria-hidden="true" draggable="false" decoding="async" /></button>
  <section class="ai-panel ai-glass" hidden>
    <header class="ai-panel-head"><span class="ai-head-grip" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="5" cy="7" r="1.4"/><circle cx="10" cy="7" r="1.4"/><circle cx="15" cy="7" r="1.4"/><circle cx="5" cy="12" r="1.4"/><circle cx="10" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/></svg></span><strong>StructBoard AI</strong><span class="ai-status-dot" hidden></span><span class="ai-head-spacer"></span>
      <button type="button" id="aiExport" class="ai-icon-btn" title="导出本机对话" aria-label="导出本机对话"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m-3-3 3 3 3-3M4 13v3h12v-3"/></svg></button>
      <button type="button" id="aiClear" class="ai-icon-btn" title="清空对话" aria-label="清空对话"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l1 9.5h6l1-9.5"/></svg></button>
      <button type="button" id="aiSettings" class="ai-icon-btn" title="供应商设置" aria-label="供应商设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82l-.06-.06A1.65 1.65 0 0 0 3.09 14H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 7.18l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 16.82 4.6l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 10H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/></svg></button>
      <button type="button" id="aiClose" class="ai-icon-btn" title="收起" aria-label="收起对话"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
    </header>
    <div class="ai-msgs"></div><div class="ai-chips"></div>
    <div class="ai-composer"><textarea class="ai-input" rows="1" placeholder="问问当前数据，或让 AI 整理…" aria-label="AI 对话输入"></textarea><button type="button" id="aiStop" class="ai-btn-ghost" aria-label="停止本轮回复与工具执行" hidden>停止</button><button type="button" class="ai-send" title="发送" aria-label="发送消息"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 10 16 3.8 12.6 16.2 9.8 11.2z"/></svg></button></div>
    <footer class="ai-foot" role="status" aria-live="polite"></footer>
  </section>
</template>
