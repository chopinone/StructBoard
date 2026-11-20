<script setup>
import {ref,onMounted} from 'vue';
const props=defineProps({model:{type:Object,required:true},handlers:{type:Object,required:true}});
const value=ref(props.model.value||''),field=ref(null),choices=ref(null);
onMounted(()=>{const target=props.model.choices?.length?choices.value?.querySelector('button'):field.value;target?.focus();if(!props.model.readonly)field.value?.select();});
</script>
<template>
  <form class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" @submit.prevent="handlers.done(value)">
    <h2 id="sheetTitle">{{ model.title||'' }}</h2><p id="sheetMessage" :hidden="!model.message">{{ model.message }}</p>
    <div ref="choices" id="sheetChoices" class="sheet-choices" :hidden="!model.choices?.length">
      <button v-for="(choice,index) in model.choices||[]" :key="index" type="button" class="sheet-choice" @click="handlers.done(choice.value)"><span class="sheet-choice-name">{{ choice.label }}</span><span v-if="choice.detail" class="sheet-choice-detail">{{ choice.detail }}</span></button>
    </div>
    <label class="sheet-field" id="sheetField" :hidden="!!model.choices?.length"><input ref="field" id="sheetInput" autocomplete="off" spellcheck="false" v-model="value" :readonly="model.readonly" :placeholder="model.placeholder||''" /></label>
    <div class="sheet-actions"><button type="button" class="btn" id="sheetCancel" @click="handlers.done(null)">{{ model.cancel||'取消' }}</button><button type="submit" class="btn btn-primary" id="sheetOk" :hidden="!!model.choices?.length">{{ model.ok||'确定' }}</button></div>
  </form>
</template>
