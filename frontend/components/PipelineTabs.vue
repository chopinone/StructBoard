<script setup>
import { shallowRef, onBeforeUnmount, ref, nextTick } from 'vue';

const props = defineProps({ catalog: { type: Object, required: true }, controller: { type: Object, required: true } });
const emit = defineEmits(['error']);
const state = shallowRef(props.catalog.getSnapshot());
const operation = shallowRef(props.controller.getSnapshot());
const strip = ref(null);
const unsubscribe = props.catalog.subscribe(value => { state.value = value; });
const unsubscribeOperation = props.controller.subscribe(value => { operation.value = value; });
onBeforeUnmount(() => { unsubscribe(); unsubscribeOperation(); });
let dragId = '', dropped = false;
const dragType = 'application/x-structboard-pipeline-tab';

function run(type, id = '', beforeId = '') {
  return props.controller.dispatch(type, id, beforeId).catch(error => emit('error', error));
}
function dragStart(event, id) {
  if (operation.value.busy) { event.preventDefault(); return; }
  dragId = id; dropped = false;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(dragType, id);
  event.dataTransfer.setData('text/plain', id);
  event.currentTarget.classList.add('is-dragging');
}
function drop(event, beforeId = '') {
  if (!dragId) return;
  event.preventDefault(); dropped = true;
  if (dragId !== beforeId) void run('move', dragId, beforeId);
}
function dragEnd(event, id) {
  event.currentTarget.classList.remove('is-dragging');
  const bounds = strip.value.closest('.pipeline-tabs').getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (!dropped && outside) void run('detach', id);
  dragId = '';
}
async function navigate(event, index) {
  let next;
  if (event.key === 'ArrowRight') next = (index + 1) % state.value.items.length;
  else if (event.key === 'ArrowLeft') next = (index + state.value.items.length - 1) % state.value.items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = state.value.items.length - 1;
  else return;
  event.preventDefault();
  await run('select', state.value.items[next].id);
  await nextTick();
  strip.value?.querySelector('[aria-selected="true"]')?.focus();
}
</script>

<template>
  <div ref="strip" class="pipeline-tabs-list" role="tablist" aria-label="已打开的管线"
    @dragover="dragId && $event.preventDefault()" @drop.self="drop($event)">
    <div v-for="(item, index) in state.items" :key="item.id" class="pipeline-tab"
      :class="{ 'is-active': item.id === state.activeId }" :data-pipeline-id="item.id"
      :draggable="!operation.busy" @dragstart="dragStart($event, item.id)" @dragend="dragEnd($event, item.id)"
      @dragover="dragId && dragId !== item.id && $event.preventDefault()" @drop.stop="drop($event, item.id)">
      <button class="pipeline-tab-select" type="button" role="tab" :aria-selected="item.id === state.activeId"
        :tabindex="item.id === state.activeId ? 0 : -1" :title="item.name" :disabled="operation.busy"
        @click="run('select', item.id)" @keydown="navigate($event, index)">{{ item.name }}</button>
      <button class="pipeline-tab-close" type="button" :draggable="false" :disabled="operation.busy"
        :aria-label="'关闭管线标签：' + item.name" title="关闭标签" @click.stop="run('close', item.id)">×</button>
    </div>
  </div>
  <span class="pipeline-tabs-spacer" aria-hidden="true" @dragover="dragId && $event.preventDefault()" @drop="drop($event)"></span>
  <button class="pipeline-tabs-add" type="button" aria-label="新建标签页" title="新建空白标签页"
    :disabled="operation.busy" @click="run('add')" @dragover="dragId && $event.preventDefault()" @drop="drop($event)">
    <span aria-hidden="true">+</span>
  </button>
</template>
