<script setup>defineProps({model:{type:Object,required:true},handlers:{type:Object,required:true}});</script>
<template>
  <div v-for="node in model.rows" :key="node.id" :class="['node',{sel:node.selected}]" :data-node-id="node.id" :style="{left:node.x+'px',top:node.y+'px','--nc':node.color}">
    <button class="node-port input-port" data-port="in" type="button" :aria-label="'连接到 '+node.title" title="拖到这里连接步骤"></button>
    <button class="node-port output-port" data-port="out" type="button" :aria-label="'从 '+node.title+' 连出'" title="拖动圆点连接下一步"></button>
    <div class="card" @click.stop="!$event.target.closest('input,button,textarea')&&handlers.select(node.id)">
      <div class="c-top"><span class="route-step-index">{{ String(node.index).padStart(2,'0') }}</span><span class="tool-chip">{{ node.tool || (node.deletable&&node.tag==='手工'?'自定义':node.tag) }}</span><span class="spacer"></span><span class="node-drag-mark" aria-hidden="true" title="拖动调整位置">⠿</span>
        <button v-if="node.deletable" type="button" class="node-delete" title="删除节点（仅画布，保留磁盘文件）" :aria-label="'删除节点：'+node.title" @click.stop="handlers.remove(node.id)"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M8 3h4M5 5l1 12h8l1-12M8 8v6m4-6v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <input v-if="node.editing" class="node-title-input" :value="node.title" maxlength="120" aria-label="文件夹名称" @pointerdown.stop @click.stop @keydown.enter.stop.prevent="handlers.renameCommit(node.id,$event.target.value)" @keydown.esc.stop.prevent="handlers.renameCancel(node.id)" @blur="handlers.renameCommit(node.id,$event.target.value)" />
      <div v-else class="c-title" title="双击修改名称 · 拖动调整位置" @dblclick.stop="handlers.rename(node.id)">{{ node.title }}</div><div class="c-desc">{{ node.desc }}</div>
      <div class="c-foot"><span class="c-cnt">{{ node.count }}</span><span class="spacer"></span><button type="button" class="node-inspect" title="节点详情" @click.stop="handlers.inspect(node.id)">详情</button><button type="button" :class="['c-note-btn',{on:node.hasNote}]" :title="node.hasNote?'打开便签':'添加便签'" @click.stop="handlers.noteOpen(node.id)">便签<span v-if="node.hasNote" class="note-presence"></span></button></div>
      <button type="button" class="node-open-structures" title="在结构视图中打开" @click.stop="handlers.open(node.id)">查看结构 <span aria-hidden="true">↗</span></button>
    </div>
    <div class="tail" :hidden="!node.showSticky"></div>
    <div class="sticky" :hidden="!node.showSticky" @dblclick.stop.prevent="handlers.noteEditor(node.id,$event.currentTarget.querySelector('textarea'))">
      <div class="sticky-h" title="双击打开大窗口编辑" tabindex="0" role="button" :aria-label="'放大编辑「'+node.title+'」便签'" @keydown.enter.prevent="handlers.noteEditor(node.id,$event.currentTarget.parentElement.querySelector('textarea'))" @keydown.space.prevent="handlers.noteEditor(node.id,$event.currentTarget.parentElement.querySelector('textarea'))"><span>▤ 便签 · 双击放大编辑</span></div>
      <textarea :value="node.note" placeholder="写筛选条件、运行命令、备注…" spellcheck="false" :aria-label="node.title+'的便签'" title="双击打开大窗口编辑" @click.stop @input="handlers.note(node.id,$event.target.value)" @blur="handlers.noteBlur(node.id,$event.target.value)"></textarea>
    </div>
  </div>
</template>
