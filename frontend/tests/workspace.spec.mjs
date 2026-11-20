import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
let preview, access;
const pdb = Buffer.from('HEADER    SYNTHETIC MIGRATION TEST\nATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 90.00           C\nATOM      2  CA  GLY A   2       3.800   0.000   0.000  1.00 90.00           C\nEND\n');
test.beforeEach(async () => {
  const profile='web-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6);
  preview = spawn(process.env.STRUCTBOARD_TEST_PYTHON || join(root,'.venv/Scripts/python.exe'),
    ['-X','utf8','-B','tools/migration_workspace.py','preview','--profile',profile], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let output='', errors='';
  preview.stderr.on('data',d=>errors+=d);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Preview timeout: '+errors)),20000);
    preview.once('exit',code=>{clearTimeout(timer);reject(Error('Preview exited '+code+': '+errors));});
    preview.stdout.on('data',d=>{output+=d;if(output.includes('UI_PREVIEW_READY ')){clearTimeout(timer);resolve();}});
  });
  access=JSON.parse(await readFile(join(root,'_migration',profile,'access.json'),'utf8'));
});
test.afterEach(async () => { preview?.kill(); });
test.beforeEach(async ({page}) => {
  await page.addInitScript(c=>{
    window.__SB_DESKTOP__={apiBase:c.backend,token:c.token};
    window.__nativeCalls=[];
    window.__TAURI__={core:{invoke:async(command,args)=>{
      window.__nativeCalls.push({command,args});
      if(command==='desktop_status')return true;
      return undefined;
    }}};
  },access);
});

test('Vue tabs preserve independent imports, order, reload and closing the last tab', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);
  await expect(page.locator('#pipelineTabs')).toHaveAttribute('data-ui-owner','vue');
  await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(1);
  await expect(page.locator('#overviewPath')).toContainText('31');
  const original=page.locator('#pipelineTabs').getByRole('tab').first();
  await original.evaluate(el=>{el.dataset.identityProbe='retained';});
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(2);
  await expect(original).toHaveAttribute('data-identity-probe','retained');
  await expect(page.getByText('把一批结构拖进来',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  const aId=await page.locator('.pipeline-tab').last().getAttribute('data-pipeline-id');
  await page.locator('#fileInput').setInputFiles({name:'Migration_A.pdb',mimeType:'text/plain',buffer:pdb});
  await expect(page.locator('#sidebar')).toContainText('Migration_A.pdb');
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  const bId=await page.locator('.pipeline-tab').last().getAttribute('data-pipeline-id');
  await page.locator('#fileInput').setInputFiles({name:'Migration_B.pdb',mimeType:'text/plain',buffer:pdb});
  await expect(page.locator('#sidebar')).toContainText('Migration_B.pdb');
  await page.locator('.pipeline-tab[data-pipeline-id="'+aId+'"] [role=tab]').click();
  await expect(page.locator('.pipeline-tab[data-pipeline-id="'+aId+'"] [role=tab]')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#overviewPath')).toContainText('1');
  await original.click();await expect(page.locator('#overviewPath')).toContainText('31');
  await page.locator('.pipeline-tab').nth(2).dragTo(page.locator('.pipeline-tab').first());
  await expect(page.locator('.pipeline-tab').first()).toHaveAttribute('data-pipeline-id',bId);
  await page.reload();await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.pipeline-tab').first()).toHaveAttribute('data-pipeline-id',bId);
  await page.locator('.pipeline-tab[data-pipeline-id="'+aId+'"] [role=tab]').click();
  const tabBox=await page.locator('.pipeline-tab.is-active').boundingBox();
  await page.mouse.move(tabBox.x+30,tabBox.y+15);await page.mouse.down();
  await page.mouse.move(tabBox.x+35,tabBox.y+20,{steps:4});await page.mouse.move(800,450,{steps:12});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(x=>x.command==='desktop_open_pipeline_window').length)).toBe(1);
  await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(2);
  while(await page.locator('#pipelineTabs').getByRole('tab').count()) {
    const count=await page.locator('#pipelineTabs').getByRole('tab').count();await page.locator('.pipeline-tab-close').last().click();
    await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(count-1);
  }
  await page.reload();await expect(page.locator('#pipelineTabs').getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('把一批结构拖进来',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('keyboard navigation, sticky overview, sidebar and theme remain usable', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#overviewPath')).toContainText('31');
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await page.locator('#pipelineTabs').getByRole('tab').last().focus();await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#pipelineTabs').getByRole('tab').first()).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#pipelineTabs').getByRole('tab').first()).toBeFocused();
  await page.locator('#overviewScroll').hover();await page.mouse.wheel(0,600);
  await expect(page.locator('.overview-section.is-sticky')).toHaveAttribute('data-step-key','aurora-demo:design');
  const delta=await page.evaluate(()=>Math.abs(document.querySelector('.overview-section.is-sticky').getBoundingClientRect().top-document.querySelector('#overviewScroll').getBoundingClientRect().top));
  expect(delta).toBeLessThan(1);
  await page.locator('#btnSidebarCollapse').click();await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
  await page.locator('#btnSidebarCollapse').click();await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
  await page.locator('#btnTheme').click();await page.setViewportSize({width:1000,height:760});
  await expect(page.locator('#pipelineTabs').getByRole('tab').first()).toBeVisible();
  await mkdir(join(root,'_migration/evidence'),{recursive:true});
  await page.screenshot({path:join(root,'_migration/evidence/vue-tabs-narrow.png')});
  expect(errors).toEqual([]);
});

test('Vue step navigation retains row identity and supports drill, rename, reorder and drop', async ({page}) => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url); await page.getByRole('button',{name:'先看示例',exact:true}).click();
  const list=page.locator('#entryList'), review=list.locator('[data-step-key="aurora-demo:review"]');
  await expect(list).toHaveAttribute('data-ui-owner','vue-step-navigation');
  await expect(list.locator('[data-step-key]')).toHaveCount(4);
  await review.focus(); await page.keyboard.press('Enter');
  await expect(list).not.toHaveAttribute('data-ui-owner','vue-step-navigation');
  await expect(list.locator('.entry.is-dir')).toHaveCount(6);
  await list.locator('.entry.is-dir').first().click();
  await expect(list.locator('[data-entry-id]')).toHaveCount(3);
  await list.locator('.entry.is-back').click();
  await expect(list.locator('.entry.is-dir')).toHaveCount(6);
  await list.locator('.entry.is-back').click();
  await expect(list).toHaveAttribute('data-ui-owner','vue-step-navigation');
  await review.evaluate(el=>{el.dataset.identityProbe='same-row';});
  const oldTitle=await review.locator('.entry-name').innerText();
  await review.getByTitle('重命名这一步',{exact:true}).click();
  await page.locator('#sheetInput').fill('迁移验收步骤');await page.locator('#sheetOk').click();
  await expect(review.locator('.entry-name')).toHaveText('迁移验收步骤');
  await expect(review).toHaveAttribute('data-identity-probe','same-row');
  await review.locator('.step-drag-handle').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect(list.locator('[data-step-key]').nth(1)).toHaveAttribute('data-step-key','aurora-demo:review');
  await expect(review).toHaveAttribute('data-identity-probe','same-row');
  await review.locator('.step-drag-handle').focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect(list.locator('[data-step-key]').nth(2)).toHaveAttribute('data-step-key','aurora-demo:review');
  await review.getByTitle('更多步骤操作',{exact:true}).click();await expect(page.locator('#stepMenu')).toBeVisible();
  await page.locator('#overviewPath').click();
  await review.getByTitle('重命名这一步',{exact:true}).click();
  await page.locator('#sheetInput').fill(oldTitle);await page.locator('#sheetOk').click();
  await expect(review.locator('.entry-name')).toHaveText(oldTitle);
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await page.locator('#entryList .side-step-add').click();
  await page.locator('#stepModalName').fill('Synthetic drop target');await page.locator('#btnStepCreateEmpty').click();
  const target=list.locator('[data-step-key]').first();await expect(target).toBeVisible();
  const stepKey=await target.getAttribute('data-step-key');
  const transfer=await page.evaluateHandle(text=>{const dt=new DataTransfer();dt.items.add(new File([text],'SidebarDrop.pdb',{type:'text/plain'}));return dt;},pdb.toString());
  await target.dispatchEvent('dragover',{dataTransfer:transfer});
  await expect(target).toHaveClass(/is-step-dragover/);
  await target.dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
  await expect.poll(()=>page.evaluate(()=>window.__SB__.entries.length)).toBe(1);
  expect(await page.evaluate(()=>window.__SB__.entries[0].stepKey)).toBe(stepKey);
  await page.locator('#searchInput').fill('SidebarDrop');
  await expect(list).not.toHaveAttribute('data-ui-owner','vue-step-navigation');
  await expect(list.locator('[data-entry-id]')).toHaveCount(1);
  await page.locator('#searchInput').fill('');await expect(list).toHaveAttribute('data-ui-owner','vue-step-navigation');
  await page.locator('#btnTheme').click();await page.setViewportSize({width:1000,height:760});
  await page.screenshot({path:join(root,'_migration/evidence/vue-sidebar-phase2.png')});
  expect(errors).toEqual([]);
});

test('storage write failures retain the active contents and the UI recovers after retry', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#overviewPath')).toContainText('31');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.sessionSave)).toBe('saved');
  await page.evaluate(()=>{
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...rest) {
      if(window.__testFailWrites&&mode==='readwrite')throw new DOMException('Synthetic quota failure','QuotaExceededError');
      return original.call(this,stores,mode,...rest);
    };
    window.__testFailWrites=true;
  });
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.locator('body')).toContainText('新建标签页失败');
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await expect(page.locator('#pipelineTabs [role=tab]')).toHaveCount(1);
  expect(await page.evaluate(()=>window.__SB__.entries.length)).toBe(31);
  await page.evaluate(()=>{window.__testFailWrites=false});
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.locator('#pipelineTabs [role=tab]')).toHaveCount(2);
  await page.locator('#pipelineTabs [role=tab]').first().click();
  await expect(page.locator('#overviewPath')).toContainText('31');
  await page.reload();await expect(page.locator('#overviewPath')).toContainText('31');
  expect(errors).toEqual([]);
});

test('repeated sidebar mount cycles and keyboard tab switches keep independent views', async ({page}) => {
  test.setTimeout(90000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#entryList')).toHaveAttribute('data-ui-owner','vue-step-navigation');
  for(let i=0;i<12;i++) {
    await page.locator('#entryList [data-step-key="aurora-demo:review"]').click();
    await expect(page.locator('#entryList .entry.is-dir')).toHaveCount(6);
    await page.locator('#entryList .entry.is-dir').nth(i%6).click();
    await expect(page.locator('#entryList [data-entry-id]')).toHaveCount(3);
    await page.locator('#entryList .entry.is-back').click();
    await page.locator('#entryList .entry.is-back').click();
    await expect(page.locator('#entryList [data-step-key]')).toHaveCount(4);
    if(i%3===0){await page.locator('#searchInput').fill('no-match-test');await expect(page.locator('#entryList [data-step-key]')).toHaveCount(0);await page.locator('#searchInput').fill('');}
  }
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await page.locator('#fileInput').setInputFiles({name:'RepeatLocal.pdb',mimeType:'text/plain',buffer:pdb});
  await expect(page.locator('#sidebar')).toContainText('RepeatLocal.pdb');
  for(let i=0;i<12;i++) {
    const tab=page.locator('#pipelineTabs [role=tab]').nth(i%2);
    await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#listCount')).toHaveText(i%2?'1':'31');
    await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  }
  await page.reload();await expect(page.locator('#listCount')).toHaveText('1');
  await page.locator('#pipelineTabs [role=tab]').first().click();
  await expect(page.locator('#entryList [data-step-key]')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('two window-scoped catalogs and saved local payloads remain separate', async ({page,context}) => {
  const peer=await context.newPage(),errors=[];
  for(const p of [page,peer])p.on('pageerror',e=>errors.push(e.message));
  await peer.addInitScript(c=>{
    window.__SB_DESKTOP__={apiBase:c.backend,token:c.token};
    window.__TAURI__={core:{invoke:async cmd=>cmd==='desktop_status'?true:undefined}};
  },access);
  await page.goto(access.url+'/?workspaceWindow=qa_window_one');
  await peer.goto(access.url+'/?workspaceWindow=qa_window_two');
  for(const [p,name] of [[page,'WindowOne.pdb'],[peer,'WindowTwo.pdb']]) {
    await p.getByRole('button',{name:'新建标签页',exact:true}).click();
    await expect(p.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
    await p.locator('#fileInput').setInputFiles({name,mimeType:'text/plain',buffer:pdb});
    await expect.poll(()=>p.evaluate(()=>document.documentElement.dataset.sessionSave)).toBe('saved');
  }
  for(const [p,name] of [[page,'WindowOne.pdb'],[peer,'WindowTwo.pdb']]) {
    await p.reload();await expect(p.locator('#sidebar')).toContainText(name);
    await expect(p.locator('#pipelineTabs [role=tab]')).toHaveCount(1);
    expect(await p.evaluate(()=>window.__SB__.entries.map(e=>e.name))).toEqual([name]);
  }
  await peer.locator('.pipeline-tab-close').click();await expect(peer.locator('#pipelineTabs [role=tab]')).toHaveCount(0);
  await page.reload();await expect(page.locator('#sidebar')).toContainText('WindowOne.pdb');
  expect(errors).toEqual([]);await peer.close();
});

test('a detached window does not resurrect its bootstrap tab after closing it', async ({page,context}) => {
  await page.goto(access.url);await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await page.locator('#fileInput').setInputFiles({name:'Transferred.pdb',mimeType:'text/plain',buffer:pdb});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.sessionSave)).toBe('saved');
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await page.locator('.pipeline-tab.is-active').dispatchEvent('dragstart',{dataTransfer:transfer});
  await page.locator('.pipeline-tab.is-active').dispatchEvent('dragend',{dataTransfer:transfer,clientX:800,clientY:500});
  await transfer.dispose();
  await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(c=>c.command==='desktop_open_pipeline_window').length)).toBe(1);
  const payload=await page.evaluate(()=>window.__nativeCalls.find(c=>c.command==='desktop_open_pipeline_window').args);
  const child=await context.newPage();
  await child.addInitScript(({access,payload})=>{
    window.__SB_DESKTOP__={apiBase:access.backend,token:access.token};
    window.__TAURI__={core:{invoke:async cmd=>cmd==='desktop_status'?true:undefined}};
    window.__SB_WORKSPACE_WINDOW_KEY__=payload.workspaceWindowKey;
    window.__SB_BOOTSTRAP_TABS__=payload.tabs;
    window.__SB_BOOTSTRAP_ACTIVE_PIPELINE__=payload.snapshot.activePipelineId||'';
  },{access,payload});
  await child.goto(access.url);await expect(child.locator('#sidebar')).toContainText('Transferred.pdb');
  await child.locator('.pipeline-tab-close').click();await expect(child.locator('#pipelineTabs [role=tab]')).toHaveCount(0);
  await child.reload();await expect(child.locator('#appSplashScreen')).toBeHidden();
  await expect(child.locator('#pipelineTabs [role=tab]')).toHaveCount(0);
  await expect(child.locator('#listCount')).toHaveText('0');await child.close();
});

test('split-pane navigation can return to a new tab without leaving commands busy', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#entryList [data-step-key]')).toHaveCount(4);
  await page.locator('#btnSplitGlobal').click();await expect(page.locator('body')).toHaveClass(/is-split/);
  await page.locator('#btnSidebarCollapse').click();
  await page.locator('#p2-overviewPath').click();await expect(page.locator('#p2-stage')).toHaveClass(/is-focus/);
  await page.locator('#entryList [data-step-key="aurora-demo:review"]').click();
  await expect(page.locator('#entryList .entry.is-dir')).toHaveCount(6);
  await page.locator('#overviewPath').click();await expect(page.locator('#stage')).toHaveClass(/is-focus/);
  await expect(page.locator('#entryList [data-step-key]')).toHaveCount(4);
  await page.locator('#btnSplitGlobal').click();await expect(page.locator('body')).not.toHaveClass(/is-split/);
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await page.locator('.pipeline-tab.is-active .pipeline-tab-close').click();
  await expect(page.locator('#pipelineTabs [role=tab]')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'新建标签页',exact:true})).toBeEnabled();
  await expect(page.locator('#listCount')).toHaveText('31');
  expect(errors).toEqual([]);
});

test('Vue file rows retain identity through star, visibility, rename and metric changes',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await page.locator('#entryList [data-step-key="aurora-demo:design"]').click();
  await expect(page.locator('#entryList')).toHaveAttribute('data-ui-owner','vue-entry-list');
  const row=page.locator('#entryList [data-entry-id]').first();const id=await row.getAttribute('data-entry-id');
  const target=page.locator('#entryList [data-entry-id="'+id+'"]');
  await target.evaluate(e=>{e.dataset.identityProbe='entry'});
  await target.locator('.star').click();await expect(target).toHaveAttribute('data-identity-probe','entry');
  await target.getByTitle('隐藏',{exact:true}).click();await expect(target).toHaveClass(/is-hidden/);
  await target.getByTitle('显示',{exact:true}).click();await expect(target).not.toHaveClass(/is-hidden/);
  const oldName=await target.locator('.entry-name').innerText();
  await target.locator('.more').click();await page.locator('#entryMenu').getByText(/重命名/).click();
  await page.locator('#sheetInput').fill('RenamedSynthetic.pdb');await page.locator('#sheetOk').click();
  await expect(target.locator('.entry-name')).toHaveText('RenamedSynthetic.pdb');
  await target.locator('.more').click();await page.locator('#entryMenu').getByText(/重命名/).click();
  await page.locator('#sheetInput').fill(oldName);await page.locator('#sheetOk').click();
  await page.locator('#btnMetrics').click();await expect(page.locator('#metricsPanel .mp-body-wrap')).toHaveAttribute('data-ui-owner','vue-metrics');
  await page.locator('#btnAddFilter').click();const filter=page.locator('#filterRows .mp-filter').last();
  await filter.locator('.f-col').selectOption('demo_score');await filter.locator('.f-op').selectOption('>=');await filter.locator('.f-val').fill('0.75');
  await page.locator('#btnApplyMetrics').click();
  expect(await page.evaluate(()=>window.__SB__.metrics.filters)).toEqual([{col:'demo_score',op:'>=',value:0.75}]);
  await page.locator('#selPrimary').selectOption('demo_deviation');
  await expect(filter.locator('.f-val')).toHaveValue('0.75');
  await filter.locator('.f-del').click();await page.locator('#btnApplyMetrics').click();
  expect(await page.evaluate(()=>window.__SB__.metrics.filters)).toEqual([]);
  await page.locator('#btnSortDir').click();
  await page.locator('#btnToggleMetrics').click();
  expect(errors).toEqual([]);
});

test('startup paints the logo while the backend is waiting and before heavy UI scripts run',async({page})=>{
  await page.addInitScript(c=>{
    window.__SB_NATIVE_STARTUP__=true;window.__releaseTestBackend=false;
    window.__TAURI__={core:{invoke:async(command,args)=>{
      if(command==='desktop_startup_status')return window.__releaseTestBackend?{state:'ready',config:{apiBase:c.backend,token:c.token}}:{state:'loading'};
      return true;
    }}};
  },access);
  await page.goto(access.url);
  await expect(page.locator('#appSplashScreen')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>!!window.__SB_STARTUP_TIMINGS__?.['logo-visible'])).toBe(true);
  await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('.splash-graphic')].filter(e=>getComputedStyle(e).display!=='none').every(e=>e.complete&&e.naturalWidth>0))).toBe(true);
  expect(await page.evaluate(()=>({vue:!!window.SB_UI,threeD:!!window.molstar,ready:!!window.__SB_READY__}))).toEqual({vue:false,threeD:false,ready:false});
  await expect(page.locator('#pipelineFrame')).not.toHaveAttribute('src',/pipeline.html/);
  await page.screenshot({path:join(root,'_migration/evidence/logo-before-ui.png')});
  await page.evaluate(()=>{window.__releaseTestBackend=true});
  await expect(page.locator('#appSplashScreen')).toBeHidden();
  const times=await page.evaluate(()=>window.__SB_STARTUP_TIMINGS__);
  expect(times['logo-visible']).toBeLessThan(times['scripts-ready']);
  expect(times['scripts-ready']).toBeLessThanOrEqual(times['workspace-ready']);
  await page.locator('#btnPipeline').click();
  const pipeline=page.frameLocator('#pipelineFrame');await pipeline.locator('#tabApi').click();
  await expect(pipeline.locator('#pipeSelect')).toBeEnabled();
  await expect(pipeline.locator('#pipeSelect')).toContainText('Aurora');
});

test('Vue overview surfaces and grid cells preserve live 3D, notes and toolbar actions',async({page})=>{
  test.setTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('.overview-card[data-ui-owner="vue-overviewCard"]').first()).toBeVisible();
  const section=page.locator('.overview-section[data-step-key="aurora-demo:template"]');
  await section.locator('.overview-note-btn').click();await section.locator('textarea').fill('Vue note persistence test');
  await section.locator('.overview-note-btn').click();await section.locator('.overview-note-btn').click();
  await expect(section.locator('textarea')).toHaveValue('Vue note persistence test');
  await section.locator('.overview-note-btn').click();
  await page.locator('#overviewSearch').fill('Aurora_001');
  const folder=page.locator('.overview-card.folder-card').first();await folder.click();
  await expect(page.locator('.overview-card:not(.folder-card)')).toHaveCount(3);
  await page.locator('#btnBench').click();
  await expect(page.locator('#toolbar')).toHaveAttribute('data-ui-owner','vue-toolbar');
  await expect(page.locator('.cell[data-ui-owner="vue-gridCell"]').first()).toBeVisible();
  await expect.poll(()=>page.locator('.cell-viewer canvas').count(),{timeout:20000}).toBeGreaterThan(0);
  const appearance=page.locator('#btnGridAppearance');if(await appearance.isVisible())await appearance.click();
  await page.locator('#selTheme').selectOption('chain-id');if(await appearance.isVisible())await appearance.click();
  const cell=page.locator('.cell[data-ui-owner="vue-gridCell"]').first();const wasStar=await cell.locator('.cell-star').getAttribute('aria-pressed');await cell.locator('.cell-star').click();
  await expect(cell.locator('.cell-star')).toHaveAttribute('aria-pressed',String(wasStar!=='true'));
  await page.locator('#btnGridLayout').click();await page.locator('#selCols').selectOption('1');await page.locator('#selRows').selectOption('1');
  await page.locator('#btnGridLayout').click();
  await expect.poll(()=>page.evaluate(()=>window.__SB__.cols*window.__SB__.rows)).toBe(1);
  await page.locator('#btnGridBack').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-mode','overview');
  await expect(page.locator('.overview-card')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('migrated assistant and MCP panels preserve settings, streamed text and safe literal rendering',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    localStorage.setItem('structboard.ai.provider',JSON.stringify({format:'openai-chat',baseUrl:'https://stub.invalid/v1',apiKey:'synthetic-not-a-secret',model:'synthetic',effort:'off',stream:true}));
    const original=window.fetch;
    window.fetch=async function(input,options){
      if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/ai/chat'){
        const body=new ReadableStream({start(controller){window.__syntheticChat={push:text=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n')),finish:()=>{controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}};}});
        return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
      }
      return original.apply(this,arguments);
    };
  });
  await page.goto(access.url);await expect(page.locator('#appSplashScreen')).toBeHidden();
  await page.locator('#btnHarnessConnection').click();await expect(page.locator('#harnessPanel')).toHaveAttribute('data-ui-owner','vue-harnessPanel');
  await expect(page.locator('#harnessScopeRead')).toBeChecked();await expect(page.locator('#harnessScopeRead')).toBeDisabled();
  await expect(page.locator('#harnessScopeEdit')).not.toBeChecked();await page.locator('#btnHarnessClose').click();
  await page.locator('.ai-bubble').click();await expect(page.locator('#aiChatRoot')).toHaveAttribute('data-ui-owner','vue-assistantPanel');
  await page.locator('#aiSettings').click();await expect(page.locator('.ai-settings')).toHaveAttribute('data-ui-owner','vue-assistantSettings');
  await expect(page.locator('#aiSetModel')).toHaveValue('synthetic');await page.locator('#aiSetCancel').click();
  await page.locator('.ai-input').fill('Synthetic streaming check');await page.locator('.ai-send').click();
  await expect.poll(()=>page.evaluate(()=>!!window.__syntheticChat)).toBe(true);
  await page.evaluate(()=>window.__syntheticChat.push('第一段 <script>never execute</script>'));
  await expect(page.locator('.ai-msgs')).toContainText('第一段');
  const message=page.locator('.ai-msg.is-ai').last();await message.evaluate(el=>{el.dataset.identityProbe='retained-message';});
  await page.evaluate(()=>window.__syntheticChat.push('\n第二段'));
  await expect(message).toHaveAttribute('data-identity-probe','retained-message');
  await expect(page.locator('.ai-msgs')).toContainText('<script>never execute</script>');
  expect(await page.locator('.ai-msgs script').count()).toBe(0);
  await page.evaluate(()=>window.__syntheticChat.finish());await expect(page.locator('#aiStop')).toBeHidden();
  await expect(page.locator('.ai-msgs')).toHaveAttribute('data-ui-owner','vue-transcript');
  await page.locator('#aiClose').click();await page.locator('.ai-bubble').click();
  await expect(page.locator('.ai-msgs')).toContainText('第二段');expect(errors).toEqual([]);
});

test('Vue pipeline canvas preserves nodes, notes, rename, delete and undo',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(access.url);await expect(page.locator('#appSplashScreen')).toBeHidden();await page.locator('#btnPipeline').click();
  const frame=page.frameLocator('#pipelineFrame');await frame.locator('#tabDemo').click();
  await expect(frame.locator('#nodes')).toHaveAttribute('data-ui-owner','vue-pipeline-nodes');
  await expect(frame.locator('#sideList')).toHaveAttribute('data-ui-owner','vue-pipeline-sidebar');
  await expect(frame.locator('#nodes .node')).toHaveCount(4);
  await frame.locator('#btnNew').click();await expect(frame.locator('#nodes .node')).toHaveCount(5);
  const manual=frame.locator('#nodes .node[data-node-id^="manual_"]');
  await manual.locator('.node-title-input').fill('Synthetic canvas node');await manual.locator('.node-title-input').press('Enter');
  await expect(manual.locator('.c-title')).toHaveText('Synthetic canvas node');
  await manual.locator('.c-note-btn').click();await manual.locator('.sticky textarea').fill('Canvas migration note');
  await manual.locator('.c-title').click();await expect(manual.locator('.c-note-btn')).toHaveText('便签');
  await manual.locator('.node-delete').click();await expect(frame.locator('#nodes .node')).toHaveCount(4);
  await frame.locator('#btnUndoDelete').click();await expect(frame.locator('#nodes .node')).toHaveCount(5);
  await expect(manual.locator('.sticky textarea')).toHaveValue('Canvas migration note');
  await frame.locator('#btnFit').click();
  await page.locator('#btnPipelineClose').click();await expect(page.locator('#pipelineOverlay')).toBeHidden();
  await page.locator('#btnPipeline').click();await expect(manual.locator('.c-title')).toHaveText('Synthetic canvas node');
  expect(errors).toEqual([]);
});

test('removed steps can be restored from the migrated trash view without losing structures',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  const step=page.locator('#entryList [data-step-key="aurora-demo:design"]');await step.getByTitle('更多步骤操作',{exact:true}).click();
  await page.locator('#stepMenu').getByText('移除此步骤（结构保留）',{exact:true}).click();
  await expect(step).toHaveCount(0);
  await page.locator('#overviewStage .pane-actions-btn').click();
  await page.getByRole('menuitem',{name:'回收站',exact:true}).click();
  await expect(page.locator('#trashCards')).toHaveAttribute('data-ui-owner','vue-trash');
  const row=page.locator('.trash-row').filter({hasText:'步骤 · 6 个示意候选'});await row.getByRole('button',{name:'还原',exact:true}).click();
  await page.locator('#btnTrashBack').click();await expect(step).toBeVisible();
  expect(await page.evaluate(()=>window.__SB__.entries.length)).toBe(31);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.sessionSave)).toBe('saved');
  await page.reload();await expect(page.locator('#entryList [data-step-key="aurora-demo:design"]')).toBeVisible();expect(errors).toEqual([]);
});

test('route map supports node dragging, link creation, bend editing, reconnect, undo and persistence',async({page})=>{
  test.setTimeout(90000);await page.emulateMedia({reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url+'/pipeline.html');await page.locator('#tabDemo').click();await page.locator('#btnArrange').click();
  const snapshot=()=>page.evaluate(()=>window.SB_CANVAS_OPERATIONS.getSnapshot({}));
  const original=await snapshot();const a=page.locator('#nodes [data-node-id="n1"]');
  const box=await a.locator('.c-top').boundingBox();
  await page.mouse.move(box.x+90,box.y+10);await page.mouse.down();await page.mouse.move(box.x+160,box.y+100,{steps:12});await page.mouse.up();
  const moved=await snapshot();expect(moved.nodes.find(n=>n.id==='n1').y).toBeGreaterThan(original.nodes.find(n=>n.id==='n1').y+60);
  await page.locator('#btnUndoDelete').click();expect((await snapshot()).nodes.find(n=>n.id==='n1').y).toBe(original.nodes.find(n=>n.id==='n1').y);
  await page.locator('#nodes [data-node-id="n0"] .output-port').dragTo(page.locator('#nodes [data-node-id="n2"] .input-port'));
  expect((await snapshot()).edges).toContainEqual(['n0','n2']);
  await expect(page.locator('.edge-handle.bend')).toBeVisible();const handle=await page.locator('.edge-handle.bend').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+35,handle.y-110,{steps:12});await page.mouse.up();
  const bent=await page.locator('.route-edge.selected .edge-path').getAttribute('d');
  await page.reload();await expect(page.locator('#nodes .node')).toHaveCount(4);
  await expect(page.locator('#tabDemo')).toHaveClass(/active/);
  expect((await snapshot()).edges).toContainEqual(['n0','n2']);
  const custom=page.locator('.route-edge').nth(3);expect(await custom.locator('.edge-path').getAttribute('d')).toBe(bent);
  const point=await custom.locator('.edge-hit').evaluate(e=>{const p=e.getPointAtLength(e.getTotalLength()/2),m=e.getScreenCTM();const q=new DOMPoint(p.x,p.y).matrixTransform(m);return {x:q.x,y:q.y}});
  await page.mouse.click(point.x,point.y);await page.locator('.edge-handle.target').dragTo(page.locator('#nodes [data-node-id="n3"] .input-port'));
  expect((await snapshot()).edges).toContainEqual(['n0','n3']);expect((await snapshot()).edges).not.toContainEqual(['n0','n2']);
  await page.locator('#btnEdgeRemove').click();expect((await snapshot()).edges).not.toContainEqual(['n0','n3']);
  await page.locator('#btnUndoDelete').click();expect((await snapshot()).edges).toContainEqual(['n0','n3']);
  const beforeCancel=await snapshot();const dragBox=await a.locator('.c-top').boundingBox();
  await page.mouse.move(dragBox.x+80,dragBox.y+10);await page.mouse.down();await page.mouse.move(dragBox.x+110,dragBox.y+50,{steps:5});await page.keyboard.press('Escape');await page.mouse.up();
  expect((await snapshot()).nodes.find(n=>n.id==='n1')).toEqual(beforeCancel.nodes.find(n=>n.id==='n1'));
  await page.locator('#zoomOut').click({clickCount:4});await expect(page.locator('#world')).toHaveAttribute('data-zoom','overview');
  await page.locator('#btnFit').click();await expect(page.locator('#routeMinimap')).toBeVisible();
  await page.screenshot({path:join(root,'_migration/evidence/route-map-light.png')});
  await page.evaluate(()=>document.body.classList.add('dark'));await page.setViewportSize({width:1000,height:760});await page.locator('#btnFit').click();
  await page.screenshot({path:join(root,'_migration/evidence/route-map-dark.png')});expect(errors).toEqual([]);
});

test('route edits reject unsaved changes and never modify the imported pipeline definition',async({page,request})=>{
  await page.emulateMedia({reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url+'/pipeline.html');await page.locator('#tabApi').click();
  await expect(page.locator('#pipeSelect')).toBeEnabled();await page.locator('#btnArrange').click();
  const before=await page.evaluate(()=>window.SB_CANVAS_OPERATIONS.getSnapshot({}));
  const definition=await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers:{'X-StructBoard-Token':access.token}});
  expect(definition.ok()).toBe(true);const originalDefinition=await definition.json();
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(window.__failRouteSave&&key==='structboard.pipelineCanvas.v1')throw new DOMException('Synthetic disk full','QuotaExceededError');return original.call(this,key,value);};window.__failRouteSave=true;
  });
  const row=page.locator('#nodes .node').first(),box=await row.locator('.c-top').boundingBox();
  await page.mouse.move(box.x+70,box.y+10);await page.mouse.down();await page.mouse.move(box.x+105,box.y+70,{steps:8});await page.mouse.up();
  const after=await page.evaluate(()=>window.SB_CANVAS_OPERATIONS.getSnapshot({}));expect(after.nodes).toEqual(before.nodes);
  await page.evaluate(()=>{window.__failRouteSave=false});
  const finalDefinition=await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers:{'X-StructBoard-Token':access.token}});
  expect(await finalDefinition.json()).toEqual(originalDefinition);
  await row.locator('.node-inspect').click();await expect(page.locator('.canvas-area')).not.toHaveClass(/drawer-hidden/);
  await page.locator('#btnDrawerCollapse').click();await expect(page.locator('.canvas-area')).toHaveClass(/drawer-hidden/);
  expect(errors).toEqual([]);
});

test('opening another pipeline from the route map keeps both workspaces separate',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#listCount')).toHaveText('31');
  const headers={'X-StructBoard-Token':access.token};
  const source=await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers});
  const {pipeline}=await source.json();pipeline.id='separate-fixture';pipeline.name='Independent synthetic route';
  const imported=await request.post(access.backend+'/api/pipeline/import',{headers,data:{definition:pipeline}});
  expect(imported.ok()).toBe(true);
  await page.reload();await expect(page.locator('#listCount')).toHaveText('31');
  await page.locator('#btnPipeline').click();
  const route=page.frameLocator('#pipelineFrame');await route.locator('#tabApi').click();
  await expect(route.locator('#pipeSelect option[value="separate-fixture"]')).toHaveCount(1);
  await route.locator('#pipeSelect').selectOption('separate-fixture');
  await expect(route.locator('#nodes .node')).toHaveCount(4);
  await route.locator('.node-open-structures').first().click();
  await expect(page.locator('#pipelineTabs [role=tab]')).toHaveCount(2);
  await expect(page.locator('.pipeline-tab.is-active')).toContainText(pipeline.name);
  await expect(page.locator('#loadProgress')).toBeHidden();
  for(const id of ['separate-fixture','aurora-demo','separate-fixture']){
    await page.locator('.pipeline-tab[data-pipeline-id="'+id+'"] [role=tab]').click();
    await expect.poll(()=>page.evaluate(()=>({id:window.__SB__.activePipelineId,count:window.__SB__.entries.length,ids:[...new Set(window.__SB__.entries.map(e=>e.pipelineId))]}))).toEqual({id,count:31,ids:[id]});
  }
  await page.reload();await expect(page.locator('#loadProgress')).toBeHidden();
  await expect(page.locator('#listCount')).toHaveText('31');
  expect(errors).toEqual([]);
});

test('cached membership refresh closes progress and cancellation retains the active workspace',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#listCount')).toHaveText('31');
  await page.getByRole('button',{name:'新建标签页',exact:true}).click();
  await expect(page.locator('#pipelineTabs')).toHaveAttribute('aria-busy','false');
  const blank=await page.locator('.pipeline-tab.is-active').getAttribute('data-pipeline-id');
  await page.evaluate(async()=>{
    const store=window.SB_SESSION_STORE.create(indexedDB,'structboard_session'),key='workspace:main:aurora-demo';
    const snapshot=await store.load(key);snapshot.definitionFingerprints={};
    snapshot.entries[0].star=true;snapshot.entries[0].starManual=true;
    await store.save(snapshot,{key});
  });
  let release;const held=new Promise(resolve=>{release=resolve});let holding=true;
  await page.route('**/api/pipeline/structures?**',async route=>{if(holding)await held;await route.continue().catch(()=>{});});
  const demo=page.locator('.pipeline-tab[data-pipeline-id="aurora-demo"] [role=tab]');
  await demo.click();await expect(page.locator('#loadProgress')).toBeVisible();
  await expect(page.locator('#loadProgressTitle')).toHaveText('核对工作区来源');
  await page.locator('#loadProgressCancel').click();await expect(page.locator('#loadProgress')).toBeHidden();
  await expect(page.locator('.pipeline-tab.is-active')).toHaveAttribute('data-pipeline-id',blank);
  await expect(page.locator('#listCount')).toHaveText('0');
  holding=false;release();await demo.click();
  await expect(page.locator('.pipeline-tab.is-active')).toHaveAttribute('data-pipeline-id','aurora-demo');
  await expect(page.locator('#loadProgress')).toBeHidden();await expect(page.locator('#listCount')).toHaveText('31');
  expect(await page.evaluate(()=>window.__SB__.entries[0].starManual&&window.__SB__.entries[0].star)).toBe(true);
  await page.screenshot({path:join(root,'_migration/evidence/membership-refresh-complete.png')});
  expect(errors).toEqual([]);
});

test('step minimap clicks, sticky title and current marker agree through the final step',async({page,request})=>{
  test.setTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const headers={'X-StructBoard-Token':access.token};
  const source=await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers});
  const {pipeline}=await source.json(),originalSteps=pipeline.steps;
  pipeline.id='navigation-fixture';pipeline.name='Eleven synthetic steps';
  pipeline.steps=Array.from({length:11},(_,index)=>({...originalSteps[index%originalSteps.length],id:'step-'+(index+1),title:'Synthetic step '+(index+1)}));
  const imported=await request.post(access.backend+'/api/pipeline/import',{headers,data:{definition:pipeline}});expect(imported.ok()).toBe(true);
  await page.goto(access.url);await page.locator('#btnPipeline').click();
  const route=page.frameLocator('#pipelineFrame');await route.locator('#tabApi').click();
  await route.locator('#pipeSelect').selectOption(pipeline.id);
  await expect(route.locator('#nodes .node')).toHaveCount(11);
  await route.locator('.node-open-structures').first().click();
  await expect(page.locator('#entryList [data-step-key]')).toHaveCount(11);
  const map=page.locator('#overviewStage .ov-minimap'),pill=map.locator('.ov-mm-pill');
  const key=n=>pipeline.id+':step-'+n;
  const aligned=async n=>{
    await expect(pill).toHaveAttribute('data-step-key',key(n));
    await expect.poll(()=>page.evaluate(step=>{
      const header=document.querySelector('#overviewCards .overview-section[data-step-key="'+step+'"]'),scroll=document.querySelector('#overviewScroll');
      return header?Math.abs(header.getBoundingClientRect().top-scroll.getBoundingClientRect().top):Infinity;
    },key(n))).toBeLessThan(1.5);
    await expect(page.locator('#overviewCards .overview-section.is-sticky:not([data-step-key="'+key(n)+'"])')).toHaveCount(0);
    await expect.poll(()=>page.evaluate(step=>{
      const tick=document.querySelector('.ov-mm-section[data-step-key="'+step+'"]'),pill=document.querySelector('.ov-mm-pill');
      return Math.abs(tick.getBoundingClientRect().top+1-(pill.getBoundingClientRect().top+8));
    },key(n))).toBeLessThan(1.5);
  };
  // Default animated clicks, including the short last section at the document bottom.
  for(const n of [11,10,1,11]){await map.locator('.ov-mm-section[data-step-key="'+key(n)+'"]').click();await aligned(n);}
  await page.locator('#overviewCards .overview-section[data-step-key="'+key(11)+'"] .overview-fold').click();
  await expect(page.locator('#overviewCards .overview-section[data-step-key="'+key(11)+'"]')).toHaveClass(/is-collapsed/);
  await aligned(11);
  await page.setViewportSize({width:1000,height:760});await page.emulateMedia({reducedMotion:'reduce'});
  await map.locator('.ov-mm-section[data-step-key="'+key(10)+'"]').click();await aligned(10);
  await map.locator('.ov-mm-section[data-step-key="'+key(11)+'"]').click();await aligned(11);
  // Dragging uses the same content coordinate scale as the ticks.
  const a=await map.locator('.ov-mm-section[data-step-key="'+key(11)+'"]').boundingBox(),b=await map.locator('.ov-mm-section[data-step-key="'+key(10)+'"]').boundingBox();
  await page.mouse.move(a.x+4,a.y+1);await page.mouse.down();await page.mouse.move(b.x+4,b.y+4,{steps:12});await page.mouse.up();
  await expect(pill).toHaveAttribute('data-step-key',key(10));
  await expect(page.locator('.overview-section.is-sticky')).toHaveAttribute('data-step-key',key(10));
  // Route-map navigation uses the same exact boundary, without leaving the old sticky header.
  await page.locator('#btnPipeline').click();await route.locator('#btnFit').click();
  await route.locator('#nodes .node').last().locator('.c-title').click();
  await route.locator('.node-open-structures').last().click();await aligned(11);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.sessionSave)).toBe('saved');
  await page.reload();await expect(page.locator('#loadProgress')).toBeHidden();await aligned(11);
  await page.screenshot({path:join(root,'_migration/evidence/minimap-final-step.png')});expect(errors).toEqual([]);
});

test('bench arrangement preserves all ten models, viewers, alignment, cameras and the selected scope',async({page,request})=>{
  test.setTimeout(120000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const headers={'X-StructBoard-Token':access.token};
  const {pipeline}=await(await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers})).json();
  const models=pipeline.steps.find(s=>s.id==='review').files.slice(0,15).map((file,i)=>({...file,
    name:'Candidate '+['A','B','C'][Math.floor(i/5)]+' model '+(i%5),lineage:{...file.lineage,candidateId:['A','B','C'][Math.floor(i/5)],candidateName:'候选 '+['A','B','C'][Math.floor(i/5)],modelIndex:i%5}}));
  pipeline.id='bench-fixture';pipeline.name='Synthetic comparison';pipeline.steps=[{id:'compare',title:'3 candidates × 5 models',groupBy:'candidate',files:models}];
  expect((await request.post(access.backend+'/api/pipeline/import',{headers,data:{definition:pipeline}})).ok()).toBe(true);
  await page.goto(access.url);await page.locator('#btnPipeline').click();const route=page.frameLocator('#pipelineFrame');
  await route.locator('#tabApi').click();await route.locator('#pipeSelect').selectOption(pipeline.id);
  await expect(route.locator('#nodes .node')).toHaveCount(1);await expect(route.locator('#nodes .c-title')).toHaveText('3 candidates × 5 models');
  await route.locator('#btnFit').click();await route.locator('#nodes .c-title').click();
  await route.locator('.node-open-structures').first().click();await expect(page.locator('#listCount')).toHaveText('15');
  await page.locator('.overview-card.folder-card').filter({hasText:'候选 A'}).click({modifiers:['Control']});
  await page.locator('.overview-card.folder-card').filter({hasText:'候选 B'}).click({modifiers:['Control']});
  await page.locator('#btnBench').click();await expect(page.locator('#gridStage')).toBeVisible();
  await page.locator('#btnGridLayout').click();await page.locator('#selCols').selectOption('5');await page.locator('#selRows').selectOption('2');await page.locator('#btnGridLayout').click();
  const ready=async count=>{await expect.poll(()=>page.evaluate(()=>({busy:window.__SB__?.gridBusy,loaded:window.__SB__?.gridViewers.length})),{timeout:30000}).toEqual({busy:false,loaded:count});};
  await ready(10);await expect(page.locator('#gridStage .bench-model-group')).toHaveCount(2);
  await expect(page.locator('#pageLabel')).toContainText('10 个预测模型');
  await page.locator('#btnAlign').click();await expect(page.locator('#btnAlign')).toHaveAttribute('aria-pressed','true');await ready(10);
  await page.locator('#btnFollowRef').click();await expect(page.locator('#btnFollowRef')).toHaveAttribute('aria-pressed','false');
  const canvas=page.locator('#gridStage .cell-viewer canvas').first(),box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.4,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.6,{steps:12});await page.mouse.up();
  await page.evaluate(()=>{
    const s=window.__SB__;window.__benchBefore={pins:[...s.gridPinned],drill:s.gridDrill,aligned:s.aligned,reference:s.referenceId,overviewGrouped:s.overviewGrouped,page:s.page,
      cells:s.gridCells.map(c=>({id:c.entryId,viewer:c.viewer,canvas:c.container.querySelector('canvas'),camera:c.viewer.plugin.canvas3d.camera.getSnapshot(),ref:c.ref}))};
  });
  for(const mode of ['flat','candidate','flat','candidate']){
    await page.locator(mode==='flat'?'#btnGridFlat':'#btnGridByCandidate').click();
    await expect(page.locator('#gridStage')).toHaveAttribute('data-arrangement',mode);
    const preserved=await page.evaluate(()=>{
      const s=window.__SB__,before=window.__benchBefore;
      return {scope:JSON.stringify(s.gridPinned)===JSON.stringify(before.pins),drill:s.gridDrill===before.drill,aligned:s.aligned===before.aligned,reference:s.referenceId===before.reference,
        overview:s.overviewGrouped===before.overviewGrouped,page:s.page===before.page,viewers:s.gridCells.every((c,i)=>c.viewer===before.cells[i].viewer&&c.ref===before.cells[i].ref&&c.container.querySelector('canvas')===before.cells[i].canvas),
        camera:s.gridCells.every((c,i)=>{const a=c.viewer.plugin.canvas3d.camera.getSnapshot(),b=before.cells[i].camera;return ['position','target','up'].every(k=>a[k].every((v,j)=>Math.abs(v-b[k][j])<.01))&&Math.abs(a.radius-b.radius)<.01})};
    });
    expect(Object.values(preserved)).toEqual(Array(Object.keys(preserved).length).fill(true));
    await expect(page.locator('#gridStage .cell')).toHaveCount(10);
    if(mode==='flat')await page.screenshot({path:join(root,'_migration/evidence/bench-flat.png')});
  }
  await page.screenshot({path:join(root,'_migration/evidence/bench-candidates.png')});
  // Pagination keeps its members and page when the arrangement changes.
  await page.locator('#btnGridLayout').click();await page.locator('#selCols').selectOption('3');await page.locator('#selRows').selectOption('1');await page.locator('#btnGridLayout').click();await ready(3);
  const seen=new Set();
  for(let i=0;i<4;i++){
    await ready(i===3?1:3);
    const before=await page.evaluate(()=>({page:window.__SB__.page,ids:window.__SB__.gridViewers.map(v=>v.entryId)}));
    before.ids.forEach(id=>seen.add(id));await page.locator('#btnGridFlat').click();
    expect(await page.evaluate(()=>({page:window.__SB__.page,ids:window.__SB__.gridViewers.map(v=>v.entryId)}))).toEqual(before);
    await page.locator('#btnGridByCandidate').click();if(i<3)await page.locator('#btnNextPage').click();
  }
  expect(seen.size).toBe(10);
  await expect.poll(()=>page.evaluate(()=>{const view=JSON.parse(localStorage.getItem('structboard.pipelineView.main.bench-fixture')||'null');return view?.panes?.[0]?.page;})).toBe(3);
  await page.reload();await ready(1);expect(await page.evaluate(()=>window.__SB__.gridPinned.length)).toBe(10);expect(await page.evaluate(()=>window.__SB__.page)).toBe(3);
  // A single candidate has no pointless grouping control; returning restores the overview.
  await page.locator('#btnGridBack').click();await expect(page.locator('#overviewStage')).toBeVisible();
  await page.locator('.overview-card.folder-card').first().click();await page.locator('#btnBench').click();await ready(3);
  expect(await page.evaluate(()=>window.__SB__.gridPinned.length)).toBe(5);
  await expect(page.locator('.bench-arrangement')).toBeHidden();await expect(page.locator('#gridStage')).toHaveAttribute('data-arrangement','flat');
  await page.locator('#btnGridBack').click();
  await page.locator('.overview-card:not(.folder-card)').first().click();await page.locator('#btnBench').click();await ready(1);
  expect(await page.evaluate(()=>window.__SB__.gridPinned.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('bench parent arrangement and compact split controls stay independent',async({page,request})=>{
  test.setTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const headers={'X-StructBoard-Token':access.token};
  const {pipeline}=await(await request.get(access.backend+'/api/pipeline?id=aurora-demo&raw=1',{headers})).json();
  const models=pipeline.steps.find(s=>s.id==='review').files.slice(0,4).map((file,i)=>({...file,lineage:{...file.lineage,candidateId:'variant-'+i,artifactKind:'mpnn_backbone',role:'variant',parentId:i<2?'parent-a':'parent-b'}}));
  pipeline.id='parent-arrangement';pipeline.name='Synthetic parents';pipeline.steps=[{id:'sequences',title:'Parent sequences',groupBy:'parent',files:models}];
  expect((await request.post(access.backend+'/api/pipeline/import',{headers,data:{definition:pipeline}})).ok()).toBe(true);
  await page.goto(access.url);await page.locator('#btnPipeline').click();const route=page.frameLocator('#pipelineFrame');
  await route.locator('#tabApi').click();await route.locator('#pipeSelect').selectOption(pipeline.id);
  await expect(route.locator('#nodes .node')).toHaveCount(1);await expect(route.locator('#nodes .c-title')).toHaveText('Parent sequences');
  await route.locator('#btnFit').click();await route.locator('#nodes .c-title').click();await route.locator('.node-open-structures').first().click();
  await expect(page.locator('#listCount')).toHaveText('4');await page.locator('#btnBench').click();
  const ready=()=>expect.poll(()=>page.evaluate(()=>({busy:window.__SB__.gridBusy,count:window.__SB__.gridViewers.length})),{timeout:30000}).toEqual({busy:false,count:4});
  await ready();await expect(page.locator('#btnGridByCandidate')).toHaveText('按母本排列');
  await expect(page.locator('#gridStage .bench-model-group')).toHaveCount(2);
  await page.locator('#btnSplitGlobal').click();await expect(page.locator('body')).toHaveClass(/is-split/);
  await page.locator('#p2-btnViewMore').click();
  await page.locator('#p2-viewMenu [data-action="btnGridFlat"]').click();
  await expect(page.locator('#p2-gridStage')).toHaveAttribute('data-arrangement','flat');
  await expect(page.locator('#gridStage')).toHaveAttribute('data-arrangement','candidate');
  await expect(page.locator('#p2-viewMenu')).toBeHidden();
  const fits=await page.evaluate(()=>[...document.querySelectorAll('.toolbar')].filter(e=>!e.hidden).every(e=>e.scrollWidth<=e.clientWidth+1));expect(fits).toBe(true);
  await page.screenshot({path:join(root,'_migration/evidence/bench-split.png')});
  expect(errors).toEqual([]);
});

test('split and merge animate repeatedly and pane mode controls match the title bar',async({page})=>{
  test.setTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(access.url);await page.getByRole('button',{name:'先看示例',exact:true}).click();
  await expect(page.locator('#listCount')).toHaveText('31');
  // Collapse the sidebar first: split motion must exist independently of its animation.
  await page.locator('#btnSidebarCollapse').click();
  await page.evaluate(()=>{
    const animate=Element.prototype.animate;window.__splitAnimations=[];
    Element.prototype.animate=function(frames,options){const result=animate.call(this,frames,options);
      if(this.id==='stage'&&frames[0].width){
        const record={frames,options,target:this.getBoundingClientRect().width,samples:[]};window.__splitAnimations.push(record);
        const sample=()=>{if(result.playState==='running'){record.samples.push(this.getBoundingClientRect().width);requestAnimationFrame(sample);}};
        requestAnimationFrame(sample);
      }return result;};
  });
  const settled=()=>expect.poll(()=>page.locator('#stage').getAttribute('data-split-motion')).toBe(null);
  const globalStyle=()=>page.locator('#btnOverview').evaluate(el=>{
    const svg=getComputedStyle(el.querySelector('svg')),button=getComputedStyle(el),thumb=getComputedStyle(document.querySelector('#modeThumb'));
    return {fill:svg.fill,stroke:svg.stroke,strokeWidth:svg.strokeWidth,color:button.color,background:thumb.backgroundColor,shadow:thumb.boxShadow};
  });
  const checkStyles=async reference=>{
    const styles=await page.evaluate(()=>[...document.querySelectorAll('.pane-mode')].map(seg=>{
      const button=seg.querySelector('.active'),svg=getComputedStyle(button.querySelector('svg')),style=getComputedStyle(button),thumb=getComputedStyle(seg.querySelector('.pane-mode-thumb'));
      return {fill:svg.fill,stroke:svg.stroke,strokeWidth:svg.strokeWidth,color:style.color,background:thumb.backgroundColor,shadow:thumb.boxShadow};
    }));expect(styles).toEqual([reference,reference]);
    const icons=await page.evaluate(()=>['overview','grid'].every(mode=>{
      const source=document.querySelector(mode==='overview'?'#btnOverview svg':'#btnBench svg').outerHTML;
      return [...document.querySelectorAll('.pane-mode [data-mode="'+mode+'"] svg')].every(svg=>svg.outerHTML===source);
    }));expect(icons).toBe(true);
  };
  for(let cycle=0;cycle<3;cycle++){
    const style=await globalStyle();
    await page.locator('#btnSplitGlobal').click();await expect(page.locator('body')).toHaveClass(/is-split/);
    await expect.poll(()=>page.evaluate(()=>window.__splitAnimations.length)).toBe(cycle*2+1);await settled();await checkStyles(style);
    expect(await page.locator('.pane-divider').count()).toBe(1);
    await page.locator('#btnSplitGlobal').click();await expect(page.locator('body')).not.toHaveClass(/is-split/);
    await expect.poll(()=>page.evaluate(()=>window.__splitAnimations.length)).toBe(cycle*2+2);await settled();
    await expect(page.locator('#p2-stage')).toHaveCount(0);
    const delta=await page.locator('#stage').evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.parentElement.getBoundingClientRect().width));expect(delta).toBeLessThan(1);
  }
  // Interrupt/reverse while running; stale animation completion must not restore a split.
  await page.locator('#btnSplitGlobal').click();await page.locator('#btnSplitGlobal').click();
  await settled();await expect(page.locator('#p2-stage')).toHaveCount(0);
  const frames=await page.evaluate(()=>window.__splitAnimations.slice(0,6));
  frames.forEach(({frames,samples},index)=>{
    const from=parseFloat(frames[0].width),to=samples.at(-1);
    if(index%2)expect(to-from).toBeGreaterThan(50);else expect(from-to).toBeGreaterThan(50);
    expect(samples.some(width=>width>Math.min(from,to)+5&&width<Math.max(from,to)-5)).toBe(true);
  });
  await page.locator('#btnSplitGlobal').click();await settled();
  const left=page.locator('#stage'),right=page.locator('#p2-stage');
  await right.locator('.pane-mode [data-mode="grid"]').click();await expect(right).toHaveAttribute('data-mode','grid');
  await expect(left.locator('.pane-mode [data-mode="overview"]')).toHaveAttribute('aria-selected','true');
  await expect(right.locator('.pane-mode [data-mode="grid"]')).toHaveAttribute('aria-selected','true');
  await expect.poll(()=>right.locator('.pane-mode').evaluate(seg=>Math.abs(seg.querySelector('.pane-mode-thumb').getBoundingClientRect().left-seg.querySelector('.active').getBoundingClientRect().left))).toBeLessThan(1);
  await right.locator('.pane-mode [data-mode="overview"]').click();
  await page.screenshot({path:join(root,'_migration/evidence/split-mode-controls-light.png')});
  await page.locator('#btnTheme').click();await page.locator('#btnSplitGlobal').click();await settled();
  const dark=await globalStyle();await page.locator('#btnSplitGlobal').click();await settled();await checkStyles(dark);
  await page.screenshot({path:join(root,'_migration/evidence/split-mode-controls-dark.png')});
  // Repeated split/merge keeps the first pane's live comparison and viewers.
  await left.locator('.pane-mode [data-mode="grid"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__SB__.gridBusy===false&&window.__SB__.gridViewers.length>0),{timeout:20000}).toBe(true);
  await page.evaluate(()=>{window.__retainedSplitViewers=window.__SB__.gridViewers.map(v=>v.viewer);});
  await page.locator('#btnSplitGlobal').click();await settled();await page.locator('#btnSplitGlobal').click();await settled();
  expect(await page.evaluate(()=>window.__retainedSplitViewers.every((v,i)=>window.__SB__.gridViewers[i]?.viewer===v))).toBe(true);
  // Reduced-motion still switches correctly, without launching an animation.
  await page.emulateMedia({reducedMotion:'reduce'});const before=await page.evaluate(()=>window.__splitAnimations.length);
  await page.locator('#btnSplitGlobal').click();await page.locator('#btnSplitGlobal').click();await settled();
  expect(await page.evaluate(()=>window.__splitAnimations.length)).toBe(before);
  // Opening split while the sidebar is visible reaches the correct final width.
  await page.locator('#btnSplitGlobal').click();await page.locator('#btnSidebarCollapse').click();
  await expect(page.locator('#btnSidebarCollapse')).toHaveAttribute('aria-expanded','true');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('#btnSplitGlobal').click();await settled();
  await expect.poll(()=>page.locator('#stage').evaluate(el=>Math.abs(el.getBoundingClientRect().width-(el.parentElement.getBoundingClientRect().width/2-5)))).toBeLessThan(1);
  await expect(page.locator('#listCount')).toHaveText('31');expect(errors).toEqual([]);
});
