<script setup>
defineProps({ model: { type: Object, required: true }, handlers: { type: Object, required: true } });
function activate(event, action) {
  if (event.target.closest('button,input,select')) return;
  if (event.type === 'keydown' && !['Enter',' '].includes(event.key)) return;
  if (event.type === 'keydown') event.preventDefault();
  action();
}
</script>
<template>
  <div v-if="model.back" class="entry is-back" role="button" tabindex="0" @click="handlers.back()" @keydown.enter.prevent="handlers.back()" @keydown.space.prevent="handlers.back()">
    <span class="entry-chevron">‹</span><div class="entry-name">{{ model.back }}</div>
  </div>
  <div v-if="model.empty" class="empty-list">{{ model.empty }}</div>
  <div v-for="folder in model.folders" :key="folder.key" class="entry is-dir" role="button" tabindex="0"
    @click="activate($event,()=>handlers.folder(folder.key))" @keydown="activate($event,()=>handlers.folder(folder.key))">
    <div class="entry-main"><div class="step-title-line"><div class="entry-name">{{ folder.name }}</div></div><div class="entry-meta">{{ folder.summary }}</div></div><span class="entry-chevron">›</span>
  </div>
  <div v-for="entry in model.entries" :key="entry.id" :data-entry-id="entry.id" :class="entry.classes" :style="{'--swatch':entry.swatch}"
    role="button" tabindex="0" title="单击：单独查看这个结构；再点一次恢复" @click="activate($event,()=>handlers.solo(entry.id))" @keydown="activate($event,()=>handlers.solo(entry.id))">
    <button class="entry-drag-handle" type="button" title="按住上下拖动调整顺序（Alt + ↑/↓ 也可移动）" :aria-label="'调整顺序：'+entry.name">
      <svg viewBox="0 0 12 20" aria-hidden="true"><circle cx="4" cy="5" r="1"/><circle cx="8" cy="5" r="1"/><circle cx="4" cy="10" r="1"/><circle cx="8" cy="10" r="1"/><circle cx="4" cy="15" r="1"/><circle cx="8" cy="15" r="1"/></svg>
    </button>
    <input type="color" class="sr-color" :value="entry.color" tabindex="-1" @input="handlers.color(entry.id,$event.target.value)" />
    <div class="entry-main"><div class="entry-name is-renamable" :title="entry.path+' · 双击重命名'" @dblclick.stop.prevent="handlers.rename(entry.id)">{{ entry.name }}</div>
      <div class="entry-meta">{{ entry.summary }}</div>
      <div class="entry-tags"><span v-for="tag in entry.tags" :key="tag.type" :class="'tag '+tag.type" :style="tag.background?{background:tag.background}:{}">{{ tag.text }}</span></div>
    </div>
    <div class="entry-actions">
      <button type="button" :class="['icon-btn','star',{on:entry.star}]" :title="entry.star?'取消优选标记':'标记为优选'" @click="handlers.star(entry.id)"><span class="st">★</span></button>
      <button type="button" :class="['icon-btn',{on:entry.visible}]" :title="entry.visible?'隐藏':'显示'" @click="handlers.visible(entry.id)">{{ entry.visible?'◉':'○' }}</button>
      <button type="button" class="icon-btn reveal" title="在文件夹中显示" :aria-label="'在文件夹中显示：'+entry.name" @click="handlers.reveal(entry.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.8 2h9.2v9.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.5 7.5V5.8A1.8 1.8 0 0 1 5.3 4h4l2 2h5.4"/></svg></button>
      <button type="button" class="icon-btn more" title="更多操作（重命名 / 路径 / 文件位置 / 序列 / 参考 / 颜色 / 移动 / 删除）" @click.stop="handlers.menu(entry.id,$event.currentTarget,$event.currentTarget.closest('.entry').querySelector('input[type=color]'))">⋯</button>
    </div>
  </div>
  <button v-if="model.remaining" type="button" class="list-more" @click="handlers.more()">继续显示（还有 {{ model.remaining }} 个，共 {{ model.total }}）</button>
  <button v-if="model.addStep" type="button" class="side-step-add" title="选本地文件夹、文件/ZIP 或创建空步骤，自动加入编号序列" @click="handlers.create()">+ 导入 / 新建步骤</button>
</template>
