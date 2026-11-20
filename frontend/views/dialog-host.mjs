import {createApp,h,shallowRef,nextTick} from 'vue';
import PromptDialog from '../components/PromptDialog.vue';
export function createDialogHost(container) {
  const active=shallowRef(null),queue=[];let sequence=0,disposed=false;
  const app=createApp({render:()=>active.value?h(PromptDialog,{key:active.value.id,model:active.value.options,handlers:{done:finish}}):null});app.mount(container);container.dataset.uiOwner='vue-dialog';
  function pump(){if(disposed||active.value||!queue.length)return;active.value=queue.shift();container.hidden=false;container.classList.add('open');}
  function finish(value){if(!active.value)return;const current=active.value;active.value=null;container.classList.remove('open');container.hidden=true;current.resolve(value);nextTick(()=>{if(queue.length)pump();else current.previous?.isConnected&&current.previous.focus();});}
  function keys(event){if(!active.value)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(null);}else if(event.key==='Tab'){
    const targets=[...container.querySelectorAll('button,input')].filter(el=>!el.disabled&&el.getClientRects().length);if(!targets.length)return;
    const first=targets[0],last=targets.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }}
  document.addEventListener('keydown',keys,true);const click=event=>{if(event.target===container)finish(null);};container.addEventListener('click',click);
  return {show(options){if(disposed)return Promise.resolve(null);return new Promise(resolve=>{queue.push({id:++sequence,options,resolve,previous:document.activeElement});pump();});},
    dispose(){disposed=true;active.value?.resolve(null);for(const item of queue.splice(0))item.resolve(null);document.removeEventListener('keydown',keys,true);container.removeEventListener('click',click);app.unmount();}};
}
