import { createApp,h,shallowRef,nextTick } from 'vue';
export function mountView(container,component,owner) {
  const props=shallowRef({});let revision=0,disposed=false;
  const app=createApp({render:()=>props.value.model||props.value.rows?h(component,props.value):null});
  app.mount(container);container.dataset.uiOwner=owner;
  return {update(value,position){props.value=value;const token=++revision;
    return nextTick(()=>{if(!disposed&&token===revision&&Number.isFinite(position))container.scrollTop=position;});},
    dispose(){disposed=true;app.unmount();delete container.dataset.uiOwner;}};
}
