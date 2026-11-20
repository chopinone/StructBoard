<script setup>
defineProps({model:{type:Object,required:true},filters:{type:Array,required:true},handlers:{type:Object,required:true}});
const operators=['>=','<=','>','<','='];
</script>
<template>
  <div class="mp-status" id="metricsStatus">{{ model.status }}</div>
  <div class="mp-body" id="metricsBody" :hidden="!model.hasTable">
    <div class="mp-row"><select id="selPrimary" aria-label="主指标" :value="model.primary" @change="handlers.primary($event.target.value)"><option v-for="column in model.columns" :key="column" :value="column">{{ column }}</option></select>
      <button class="mini-btn" id="btnSortDir" :title="model.higher?'当前：越大越好（点击改为越小越好）':'当前：越小越好（点击改为越大越好）'" @click="handlers.direction()">{{ model.higher?'大 → 小':'小 → 大' }}</button></div>
    <div class="mp-filters" id="filterRows"><div v-for="filter in filters" :key="filter.id" class="mp-filter">
      <select class="f-col" v-model="filter.col" aria-label="筛选指标"><option v-for="column in model.columns" :key="column" :value="column">{{ column }}</option></select>
      <select class="f-op" v-model="filter.op" aria-label="比较方式"><option v-for="operator in operators" :key="operator">{{ operator }}</option></select>
      <input class="f-val" type="number" step="any" placeholder="值" aria-label="筛选数值" v-model="filter.value" />
      <button class="icon-btn del f-del" title="删除此条件" @click="handlers.remove(filter.id)">×</button>
    </div></div>
    <button class="mini-btn wide" id="btnAddFilter" @click="handlers.add()">+ 增加条件</button>
    <div class="mp-actions"><button class="mini-btn" id="btnApplyMetrics" @click="handlers.apply()">应用</button><button class="mini-btn" id="btnPresetRf3" @click="handlers.preset()">RF3 预设</button><button class="mini-btn" id="btnClearMetrics" @click="handlers.clear()">清除</button></div>
    <button class="mini-btn wide" id="btnExportList" @click="handlers.export()">导出当前名单 CSV</button>
  </div>
  <div class="mp-pick"><button class="mini-btn wide" id="btnPickMetrics" @click="handlers.pick()">导入 CSV / JSON</button><input type="file" id="metricsInput" hidden accept=".csv,.tsv,.txt,.json" @change="handlers.import($event.target.files);$event.target.value=''" /></div>
</template>
