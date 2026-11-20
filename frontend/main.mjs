import { createApp, h, shallowRef, nextTick, ref } from 'vue';
import PipelineTabs from './components/PipelineTabs.vue';
import StepNavigation from './components/StepNavigation.vue';
import EntryList from './components/EntryList.vue';
import WorkbenchToolbar from './components/WorkbenchToolbar.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import GroupChips from './components/GroupChips.vue';
import { mountView } from './views/mount-view.mjs';
import { createRouteEditor } from './canvas/route-editor.mjs';
import * as routeGeometry from './canvas/route-geometry.mjs';
import { startPipeline } from './canvas/runtime.mjs';
import { services } from './runtime/registry.mjs';
import { createSurface } from './views/surfaces.mjs';
import { mountTranscript } from './views/transcript.mjs';
import { createDialogHost } from './views/dialog-host.mjs';
import TrashList from './components/TrashList.vue';
import PipelineNodes from './components/PipelineNodes.vue';
import PipelineSidebar from './components/PipelineSidebar.vue';
import { createTabController } from './application/tab-controller.mjs';
import { createWorkspaceService } from './application/workspace-service.mjs';
import { stepNavigationRows } from './domain/step-navigation.mjs';

export function mountPipelineTabs(container, catalog, handlers) {
  const controller = createTabController(catalog, handlers);
  const app = createApp(PipelineTabs, { catalog, controller,
    onError: error => container.dispatchEvent(new CustomEvent('structboard:ui-error', { detail: error, bubbles: true })) });
  app.mount(container);
  container.dataset.uiOwner = 'vue';
  return {
    update(next) { controller.updateHandlers(next); },
    dispose() { controller.dispose(); app.unmount(); delete container.dataset.uiOwner; },
  };
}
export function mountStepNavigation(container) {
  const rows = shallowRef([]), handlers = shallowRef({});
  let revision = 0, disposed = false;
  const app = createApp({ render: () => h(StepNavigation, { rows: rows.value, handlers: handlers.value }) });
  app.mount(container); container.dataset.uiOwner = 'vue-step-navigation';
  return {
    update(value, actions, scrollTop) {
      const token = ++revision; rows.value = value; handlers.value = actions;
      nextTick(() => { if (!disposed && token === revision) container.scrollTop = scrollTop; });
    },
    dispose() { disposed = true; app.unmount(); delete container.dataset.uiOwner; },
  };
}
export function mountEntryList(container) {return mountView(container,EntryList,'vue-entry-list');}
export function mountMetrics(container,actions) {
  const view=mountView(container,MetricsPanel,'vue-metrics'),filters=ref([]);let serial=0,model={columns:[]};
  const add=(col,op,value)=>{if(!model.hasTable)return;filters.value.push({id:++serial,col:col||model.columns[0]||'',op:op||'>=',value:value??''});};
  const handlers={...actions,add,remove:id=>{filters.value=filters.value.filter(f=>f.id!==id);paint();}};
  function paint(){return view.update({model,filters:filters.value,handlers});}
  return {update(value,reset){model=value;if(reset)filters.value=reset.map(f=>({...f,id:++serial}));return paint();},add,
    filters:()=>filters.value.filter(f=>f.col&&f.value!==''&&Number.isFinite(Number(f.value))).map(f=>({col:f.col,op:f.op,value:Number(f.value)})),
    dispose:view.dispose};
}
export function mountGroups(container) {return mountView(container,GroupChips,'vue-groups');}
export function mountToolbar(container,prefix) { const app=createApp(WorkbenchToolbar,{prefix});app.mount(container);container.dataset.uiOwner='vue-toolbar';return {dispose(){app.unmount();delete container.dataset.uiOwner;}};}
export function mountTrash(container) {return mountView(container,TrashList,'vue-trash');}
export function mountPipelineNodes(container) {return mountView(container,PipelineNodes,'vue-pipeline-nodes');}
export function mountPipelineSidebar(container) {return mountView(container,PipelineSidebar,'vue-pipeline-sidebar');}
window.SB_UI = Object.freeze({ createRouteEditor, routeGeometry, startPipeline, mountPipelineNodes, mountPipelineSidebar, mountTranscript, createSurface, createDialogHost, mountTrash, mountToolbar, mountPipelineTabs, createWorkspaceService, mountStepNavigation, stepNavigationRows, mountEntryList, mountMetrics, mountGroups, services });
