<script setup>defineProps({model:{type:Object,required:true},handlers:{type:Object,required:true}});</script>
<template>
  <button v-for="group in model.items" :key="group.id" type="button" :class="['gchip',{active:model.activeId===group.id}]" :data-group-id="group.id" :aria-pressed="model.activeId===group.id"
    :title="group.id==='all'?'显示全部结构':group.name+' · 单击切换 · 双击重命名 · × 删除文件夹（不删结构）'"
    @click="handlers.select(group.id)" @dblclick.prevent="group.id!=='all'&&handlers.rename(group.id)">
    <span class="gchip-name">{{ group.name }}</span><span class="gchip-count">{{ group.count }}</span>
    <span v-if="group.id!=='all'" class="gchip-x" title="删除此文件夹（结构仍在「全部」里）" @click.stop="handlers.remove(group.id)">×</span>
  </button>
</template>
