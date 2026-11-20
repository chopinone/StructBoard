import {h,render} from 'vue';
import OverviewCard from '../components/OverviewCard.vue';
import OverviewSection from '../components/OverviewSection.vue';
import GridCell from '../components/GridCell.vue';
import HarnessPanel from '../components/HarnessPanel.vue';
import AssistantPanel from '../components/AssistantPanel.vue';
import AssistantSettings from '../components/AssistantSettings.vue';
import contract from './surfaces.json';
const components={overviewCard:OverviewCard,overviewSection:OverviewSection,gridCell:GridCell,harnessPanel:HarnessPanel,assistantPanel:AssistantPanel,assistantSettings:AssistantSettings};
export function createSurface(kind) {
  const spec=contract[kind],box=document.createElement(spec.tag);box.className=spec.className;
  for(const [key,value] of Object.entries(spec.attributes||{}))box.setAttribute(key,value);
  render(h(components[kind]),box);box.dataset.uiOwner='vue-'+kind;
  const result={box};
  for(const [name,selector] of Object.entries(spec.selectors)) {
    result[name]=box.querySelector(selector);if(!result[name])throw Error('Missing surface port '+kind+'.'+name);
  }
  let disposed=false;box.__disposeView=()=>{if(disposed)return;disposed=true;render(null,box);};
  return result;
}
