import {createApp,h,shallowRef,nextTick} from 'vue';
import {transcriptTree} from './transcript-tree.mjs';
export function mountTranscript(container,handlers) {
  const model=shallowRef({messages:[],busy:false});let generation=0,disposed=false;
  const app=createApp({render:()=>transcriptTree(h,model.value,handlers)});app.mount(container);container.dataset.uiOwner='vue-transcript';
  return {update(value){const follow=container.scrollHeight-container.scrollTop-container.clientHeight<64;const token=++generation;model.value=value;
    nextTick(()=>{if(!disposed&&token===generation&&follow)container.scrollTop=container.scrollHeight;});},
    dispose(){disposed=true;app.unmount();delete container.dataset.uiOwner;}};
}
