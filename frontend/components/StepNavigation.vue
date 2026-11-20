<script setup>
const props = defineProps({ rows: { type: Array, required: true }, handlers: { type: Object, required: true } });
function open(event, key) {
  if (event.target.closest('button')) return;
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  if (event.type === 'keydown') event.preventDefault();
  props.handlers.open(key);
}
function dragover(event) {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault(); event.currentTarget.classList.add('is-step-dragover');
}
function dragleave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('is-step-dragover');
}
</script>

<template>
  <div v-for="row in rows" :key="row.key" class="entry is-dir" role="button" tabindex="0"
    :data-step-key="row.key" @click="open($event, row.key)" @keydown="open($event, row.key)"
    @dragover="dragover" @dragleave="dragleave" @drop="dragleave">
    <span class="step-num" :class="{'is-plain': row.plain}">
      <svg v-if="row.plain" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.2h4.4l1.4 1.6h7.2v7.2a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z"/></svg>
      <template v-else>{{ row.index }}</template>
    </span>
    <div class="entry-main">
      <div class="step-title-line"><div class="entry-name">{{ row.title }}</div><span v-if="row.tool" class="step-tool-pill">{{ row.tool }}</span></div>
      <div class="entry-meta">{{ row.summary }}</div>
    </div>
    <div class="step-row-actions">
      <template v-if="!row.plain">
        <button type="button" class="icon-btn" title="追加结构 / 文件夹到这一步" @click.stop="handlers.append(row.key)">＋</button>
        <button type="button" class="icon-btn" title="重命名这一步" @click.stop="handlers.rename(row.key)">✎</button>
        <button type="button" class="step-drag-handle" title="按住上下拖动调整步骤顺序（Alt + ↑/↓）" :aria-label="'调整步骤顺序：' + row.title">
          <svg viewBox="0 0 12 20" aria-hidden="true"><circle cx="4" cy="5" r="1"/><circle cx="8" cy="5" r="1"/><circle cx="4" cy="10" r="1"/><circle cx="8" cy="10" r="1"/><circle cx="4" cy="15" r="1"/><circle cx="8" cy="15" r="1"/></svg>
        </button>
      </template>
      <button type="button" class="icon-btn" title="更多步骤操作" @click.stop="handlers.menu(row.key, $event.currentTarget)">⋯</button>
    </div>
    <span class="entry-chevron">›</span>
  </div>
  <button type="button" class="side-step-add" title="选本地文件夹、文件/ZIP 或创建空步骤，自动加入编号序列" @click="handlers.create()">+ 导入 / 新建步骤</button>
</template>
