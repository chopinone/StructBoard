// sidebar: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function refreshReferenceSelect() {
    const sel = ports.$('selReference');
    if (!sel) return;
    sel.innerHTML = '';
    if (!ports.S.entries.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '（未导入）';
      sel.appendChild(o);
      return;
    }
    for (const e of ports.S.entries) {
      const o = document.createElement('option');
      o.value = e.id; o.textContent = e.name;
      sel.appendChild(o);
    }
    const valid = ports.S.entries.some(function (e) { return e.id === ports.S.referenceId; });
    if (!valid) ports.S.referenceId = ports.S.entries[0].id;
    sel.value = ports.S.referenceId;
  }
  function sequenceBuckets(entries) {
    const was = ports.S.overviewGrouped;
    ports.S.overviewGrouped = true;
    const nodes = ports.overviewNodes(entries, { layout: false });
    ports.S.overviewGrouped = was;
    return { folders: nodes.filter(n => n.kind === 'folder'), loose: nodes.filter(n => n.kind === 'entry').map(n => n.entry) };
  }
  function renderSidebarSteps(box, steps, plain, scrollTop) {
    if (ports.sidebarEntryView) { ports.sidebarEntryView.dispose(); ports.sidebarEntryView = null; }
    if (!ports.sidebarStepView) ports.sidebarStepView = window.SB_UI.mountStepNavigation(box);
    const epoch = ports.rawS.workspaceEpoch;
    const stepByKey = new Map(steps.map(function (step) { return [step.key, step]; }));
    stepByKey.set('plain', { key: 'plain', title: '其他导入', entries: plain });
    const guard = function (fn) { return function () {
      if (ports.rawS.workspaceEpoch === epoch) return fn.apply(null, arguments);
    }; };
    ports.sidebarStepView.update(window.SB_UI.stepNavigationRows(steps, plain, function (entries) {
      return ports.LINEAGE.countText(ports.LINEAGE.summarize(entries));
    }), {
      open: guard(function (key) {
        const step = stepByKey.get(key); if (!step) return;
        ports.S.listReset = true; ports.S.listLimit = 60;
        ports.S.listNav = { stepKey: key === 'plain' ? '' : key, title: step.title };
        renderList(); ports.syncGridToListNav();
      }),
      append: guard(function (key) { ports.triggerStepImport(key, true); }),
      rename: guard(ports.renameStepPrompt),
      menu: guard(function (key, anchor) { const step = stepByKey.get(key); if (step) ports.openStepMenu(step, anchor); }),
      create: guard(function () { ports.openStepModal({}); }),
    }, scrollTop);
  }
  function releaseSidebarSteps() {
    if (ports.sidebarStepView) { ports.sidebarStepView.dispose(); ports.sidebarStepView = null; }
  }
  function recoverEmptyImportGroup() {
    const group = ports.S.groups.find(function (item) { return item.id === ports.S.activeGroupId; });
    if (!group || group.pipelineKey) return false;
    const members = new Set(group.entryIds);
    if (ports.S.entries.some(function (entry) { return members.has(entry.id) && !ports.entryIsTrashed(entry); })) return false;
    if (!ports.S.entries.some(function (entry) { return !ports.entryIsTrashed(entry); })) return false;
    ports.S.activeGroupId = 'all'; ports.S.listNav = null; ports.S.soloId = null; ports.S.page = 0;
    renderGroups();
    ports.schedulePipelineViewSave();
    return true;
  }
  function renderList() {
    recoverEmptyImportGroup();
    ports.refreshGridHeaders();
    const box = ports.$('entryList');
    const savedScroll = box.scrollTop;
    ports.$('listCount').textContent = String(ports.S.entries.length);
    const vis = ports.S.entries.filter(function (e) { return e.visible; }).length;
    const stars = ports.starCount();
    ports.$('sideSub').textContent = ports.S.entries.length
      ? vis + ' 个显示 · ' + (ports.S.entries.length - vis) + ' 个隐藏 · ★' + stars + ' 优选 · 参考 ' + (referenceName() || '未设')
      : '尚未导入结构';
    const starChip = ports.$('btnStarOnly');
    starChip.classList.toggle('active', ports.S.starOnly);
    ports.$('starCount').textContent = String(stars);

    const filtered = ports.sortByMetric(ports.S.entries.filter(function (e) {
      return !ports.entryIsTrashed(e) && ports.inActiveGroup(e) && (!ports.S.starOnly || e.star) &&
        (!ports.S.filter || e.name.toLowerCase().indexOf(ports.S.filter) >= 0);
    }));
    const hasCustomEmpty = !ports.S.filter && !ports.S.starOnly && ports.S.activeGroupId === 'all' &&
      ports.orderedStepBuckets([], { includeEmpty: true }).length > 0;
    ports.S.listedCount = filtered.length;
    const rootSteps = !ports.S.filter && !ports.S.listNav && (filtered.length || hasCustomEmpty)
      ? ports.orderedStepBuckets(filtered, { includeEmpty: !ports.S.starOnly && ports.S.activeGroupId === 'all' }).filter(function(step){return !ports.stepIsTrashed(step.key);}) : [];
    if (rootSteps.length) {
      const plain = filtered.filter(function (entry) { return !entry.stepKey; });
      renderSidebarSteps(box, rootSteps, plain, ports.S.listReset ? 0 : savedScroll);
      ports.S.listReset = false; ports.S.listedCount = 0;
      ports.$('btnShowAll').hidden = !ports.S.soloId; ports.updateEmptyState();
      return;
    }
    releaseSidebarSteps();
    if (!ports.sidebarEntryView) ports.sidebarEntryView = window.SB_UI.mountEntryList(box);
    const model = { back: '', empty: '', folders: [], entries: [], remaining: 0, total: 0, addStep: false };
    let files = filtered;
    const nav = ports.S.listNav;
    if (!filtered.length && !hasCustomEmpty) {
      model.empty = !ports.S.entries.length ? '导入后在这里管理每个结构' : ports.S.starOnly ? '还没有标记任何优选结构：点条目右侧的 ☆ 标记'
        : ports.S.activeGroupId !== 'all' ? '这个文件夹是空的，用「移入」把结构放进来' : '没有匹配的结构';
      model.addStep = !ports.S.entries.length || ports.S.activeGroupId === 'all';
    } else if (!ports.S.filter) {
      if (nav && nav.group) {
        model.back = nav.title;
        files = filtered.filter(function (entry) { return (entry.stepKey || '') === (nav.stepKey || '') &&
          (nav.groupKey ? ports.LINEAGE.groupKey(entry) === nav.groupKey : entry.group === nav.group); });
      } else {
        if (nav) model.back = '全部结构';
        const seq = sequenceBuckets(nav ? filtered.filter(function (entry) { return nav.stepKey ? entry.stepKey === nav.stepKey : !entry.stepKey; }) : filtered);
        model.folders = seq.folders.map(function (folder, index) {
          const stars = folder.entries.filter(function (entry) { return entry.star; }).length;
          return { key: folder.groupKey || folder.id || folder.name, name: folder.name, groupKey: folder.groupKey,
            summary: (folder.countText || folder.entries.length + ' 份结构') + (folder.roleText ? ' · ' + folder.roleText : '') + (stars ? ' · 优选标记 ' + stars : '') };
        });
        files = seq.loose;
      }
    }
    ports.S.listedCount = files.length;
    model.total = files.length; model.remaining = Math.max(0, files.length - ports.S.listLimit);
    model.entries = files.slice(0,ports.S.listLimit).map(sidebarEntryModel);
    const epoch=ports.rawS.workspaceEpoch, owner=ports.paneAt();
    const guard=function(fn){return function(){if(ports.rawS.workspaceEpoch===epoch && ports.PANE_RUNTIME.alive(owner) && ports.paneAt()===owner)return fn.apply(null,arguments);};};
    const entryAction=function(fn){return guard(function(id){const entry=ports.S.entries.find(function(e){return e.id===id;});if(entry)return fn.apply(null,[entry].concat(Array.from(arguments).slice(1)));});};
    const navigate=guard(function(next){ports.S.listNav=next;ports.S.listReset=true;ports.S.listLimit=60;renderList();ports.syncGridToListNav();});
    ports.sidebarEntryView.update({model:model,handlers:{
      back:function(){navigate(nav && nav.group && nav.stepKey ? {stepKey:nav.stepKey,title:nav.title} : null);},
      folder:function(key){const folder=model.folders.find(function(f){return f.key===key;});if(folder)navigate({stepKey:nav?nav.stepKey:'',title:nav?nav.title:'全部结构',group:folder.name,groupKey:folder.groupKey});},
      solo:entryAction(ports.toggleSolo),rename:entryAction(ports.renameEntry),color:entryAction(ports.onColorChange),star:entryAction(ports.toggleStar),
      visible:entryAction(ports.toggleVisible),reveal:entryAction(ports.revealEntry),menu:entryAction(ports.openEntryMenu),
      more:guard(function(){ports.S.listLimit+=60;renderList();}),create:guard(function(){ports.openStepModal({});})
    }}, ports.S.listReset ? 0 : savedScroll);
    ports.S.listReset=false;ports.$('btnShowAll').hidden=!ports.S.soloId;ports.updateEmptyState();
  }
  function sidebarEntryModel(entry) {
    const meta=[], tags=[];
    if(entry.parsed&&!entry.isUrl)meta.push(entry.parsed.residueCount+' res',entry.parsed.chains.length+' chain',entry.parsed.atoms.length+' atom');
    else meta.push(ports.formatLabel(entry));
    const lineage=ports.LINEAGE.entryText(entry);if(lineage)meta.push(lineage);meta.push(ports.fmtSize(entry.size));
    if(ports.S.referenceId===entry.id)tags.push({type:'ref',text:'● 参考'});
    const alignment=ports.S.aligned?ports.alignedRecord(entry,ports.paneAt()):null;
    if(alignment&&alignment.info)tags.push({type:'aligned',text:'RMSD '+alignment.info.rmsd.toFixed(2)+' Å'});
    const metric=ports.metricText(entry);if(metric)tags.push({type:'metric',text:metric,background:'#'+ports.metricColor(entry).toString(16).padStart(6,'0')+'22'});
    if(entry.metrics)for(const extra of ['iptm','ranking_score','confidence_score']){
      const value=entry.metrics[extra];if(Number.isFinite(value)&&extra!==ports.S.metrics.primary){tags.push({type:'score',text:extra+' '+(Math.abs(value)>=100?value.toFixed(1):value.toFixed(3).replace(/0+$/,'').replace(/\.$/,''))});break;}
    }
    return {id:entry.id,name:entry.name,path:entry.fullPath||entry.path||entry.name,summary:meta.join(' · '),tags:tags,
      star:!!entry.star,visible:!!entry.visible,color:ports.hexOf(entry.color),swatch:ports.hexOf(ports.S.theme==='by-metric'?ports.metricColor(entry):entry.color),
      classes:['entry',!entry.visible?'is-hidden':'',ports.S.referenceId===entry.id?'is-reference':'',entry.star?'is-starred':'',!ports.passesMetrics(entry)?'is-filtered':'',ports.S.soloId===entry.id?'is-solo':ports.S.soloId?'is-solo-other':''].filter(Boolean).join(' ')};
  }
  function referenceName() {
    const r = ports.S.entries.find(function (e) { return e.id === ports.S.referenceId; });
    return r ? r.name : '';
  }
  function updateGroupNavigation() {
    const box = ports.$('groupChips'), prev = ports.$('btnGroupPrev'), next = ports.$('btnGroupNext');
    if (!box || !prev || !next) return;
    const navWidth = box.parentElement.clientWidth;
    const chipMax = Math.max(60, navWidth - 58) + 'px';
    if (box.style.getPropertyValue('--group-chip-max') !== chipMax) box.style.setProperty('--group-chip-max', chipMax);
    // 所有标签使用固定上限，不随箭头显示后视口宽度收缩，避免临界宽度震荡。
    const overflow = box.scrollWidth > navWidth + 1;
    prev.hidden = next.hidden = !overflow;
    ports.$('groupJump').hidden = !overflow && ports.S.groups.length < 4;
    if (ports.revealActiveGroup) {
      ports.revealActiveGroup = false;
      const chip = box.querySelector('.gchip.active');
      if (chip) {
        const bounds = box.getBoundingClientRect(), rect = chip.getBoundingClientRect();
        if (rect.left < bounds.left) box.scrollLeft -= bounds.left - rect.left;
        else if (rect.right > bounds.right) box.scrollLeft += rect.right - bounds.right;
      }
    }
    const max = Math.max(0, box.scrollWidth - box.clientWidth);
    prev.disabled = box.scrollLeft <= 1;
    next.disabled = box.scrollLeft >= max - 1;
  }
  function scheduleGroupNavigation(reveal) {
    ports.revealActiveGroup = ports.revealActiveGroup || !!reveal;
    if (ports.groupNavFrame) return;
    ports.groupNavFrame = requestAnimationFrame(function () { ports.groupNavFrame = 0; updateGroupNavigation(); });
  }
  function bindGroupNavigation() {
    const box = ports.$('groupChips');
    function scrollGroups(direction) {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      box.scrollBy({left: direction * Math.max(100, box.clientWidth * .8), behavior: behavior});
    }
    ports.$('btnGroupPrev').onclick = function () { scrollGroups(-1); };
    ports.$('btnGroupNext').onclick = function () { scrollGroups(1); };
    box.addEventListener('scroll', function () { scheduleGroupNavigation(false); }, {passive: true});
    box.addEventListener('wheel', function (event) {
      if (event.ctrlKey || box.scrollWidth <= box.clientWidth + 1) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      box.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientWidth : 1);
    }, {passive: false});
    box.addEventListener('keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const chips = Array.from(box.querySelectorAll('.gchip')), index = chips.indexOf(document.activeElement);
      if (index < 0) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); chips[index].click(); return;
      }
      let next;
      if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
      else if (event.key === 'ArrowRight') next = Math.min(chips.length - 1, index + 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = chips.length - 1;
      else return;
      event.preventDefault(); event.stopPropagation();
      chips[next].focus({preventScroll: true});
      const bounds = box.getBoundingClientRect(), rect = chips[next].getBoundingClientRect();
      if (rect.left < bounds.left) box.scrollLeft -= bounds.left - rect.left;
      else if (rect.right > bounds.right) box.scrollLeft += rect.right - bounds.right;
      scheduleGroupNavigation(false);
    });
    ports.$('groupJump').onchange = function () { setActiveGroup(this.value); };
    window.addEventListener('resize', function () { scheduleGroupNavigation(true); });
    if (window.ResizeObserver) new ResizeObserver(function () { scheduleGroupNavigation(false); }).observe(box.parentElement);
  }
  function renderGroups() {
    const box=ports.$('groupChips');if(!box)return;
    const previous=box.scrollLeft,changed=box.dataset.activeGroup!==ports.S.activeGroupId;
    box.dataset.activeGroup=ports.S.activeGroupId;
    const ids=new Set(ports.S.entries.map(function(entry){return entry.id;}));
    const items=[{id:'all',name:'全部',count:ports.S.entries.length}].concat(ports.S.groups.map(function(group){
      return {id:group.id,name:group.name,count:group.entryIds.filter(function(id){return ids.has(id);}).length};
    }));
    if(!ports.groupView)ports.groupView=window.SB_UI.mountGroups(box);
    ports.groupView.update({model:{items:items,activeId:ports.S.activeGroupId},handlers:{select:setActiveGroup,rename:renameGroup,remove:deleteGroup}}).then(function(){box.scrollLeft=previous;scheduleGroupNavigation(changed);});
    const jump=ports.$('groupJump');jump.replaceChildren();
    for(const item of items){const option=document.createElement('option');option.value=item.id;option.textContent=item.name+' · '+item.count+' 个';jump.appendChild(option);}
    jump.value=ports.S.activeGroupId;
  }
  function setActiveGroup(id, opts) {
    // Phase 1：总览镜头锁定期间，侧栏换组不冲掉镜头（管线对话框等显式流程用 force 旁路）。
    if (!(opts && opts.force) && ports.S.mode === 'grid' && ports.S.gridFromOverview) {
      ports.toast('检阅台镜头停在总览当前位置；返回总览后再用侧栏切换目标');
      return;
    }
    if (ports.S.activeGroupId === id) return;
    ports.S.activeGroupId = id;
    ports.schedulePipelineViewSave();
    ports.S.soloId = null;
    ports.S.page = 0;
    ports.S.listNav = null;
    ports.S.listLimit = 60;
    closeGroupMenu();
    renderGroups();
    renderList();
    ports.refreshBadge();
    ports.applyModeChange(true);
    const g = ports.S.groups.find(function (x) { return x.id === id; });
    ports.toast(g ? '文件夹「' + g.name + '」· ' + ports.visibleEntries().length + ' 个结构' : '显示全部结构');
  }
  function renameGroup(id) {
    const g = ports.S.groups.find(function (x) { return x.id === id; });
    if (!g) return;
    ports.askSheet({ title: '重命名文件夹', message: '只改侧栏里的名称，不改文件。', value: g.name, ok: '保存' }).then(function (name) {
      if (name && name.trim() && name.trim() !== g.name) { g.name = name.trim(); renderGroups(); }
    });
  }
  function deleteGroup(id) {
    const i = ports.S.groups.findIndex(function (x) { return x.id === id; });
    if (i < 0) return;
    ports.S.groups.splice(i, 1);
    if (ports.S.activeGroupId === id) ports.S.activeGroupId = 'all';
    closeGroupMenu();
    renderGroups(); renderList(); ports.refreshBadge(); ports.applyModeChange(true);
    ports.toast('已删除文件夹（结构仍保留在「全部」里）');
  }
  function closeGroupMenu() {
    const m = ports.$('groupMenu');
    if (m) m.hidden = true;
  }
  function openOrgMoveMenu(entryIds, stepKey, anchorRect) {
    const mk = function (label, cls, fn) {
      const btn = ports.el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
      btn.addEventListener('click', function (e) { e.stopPropagation(); ports.closeMenus(); fn(); });
      return btn;
    };
    const m = ports.$('orgMenu');
    if (!m || !ports.ORG || !entryIds.length) return;
    // 跨步骤混选拒绝：选择器只操作 stepKey 这一步的 organization。
    const stepMismatch = entryIds.some(function (id) {
      const node = ports.overview && ports.overview.findNode ? ports.overview.findNode(id) : null;
      return node ? ports.stepKeyOfNode(node) !== stepKey : true;
    });
    if (stepMismatch) { ports.toast('请选择同一步的结构再移入'); return; }
    m.innerHTML = '';
    const title = ports.el('div', 'menu-item', '移入哪个工作台文件夹…');
    title.style.color = 'var(--text-3, #8a8a8a)';
    title.style.cursor = 'default';
    m.appendChild(title);
    const org = ports.S.organization[stepKey] || ports.ORG.empty();
    // 同一步所有工作台文件夹都可选，包括挂在 lineage:<groupKey> 下的子夹。
    const folderById = new Map((org.folders || []).map(function (f) { return [f.id, f]; }));
    const allFolders = [];
    const walkFolders = function (folder, path) {
      const nextPath = path.concat(folder.name);
      allFolders.push({ folder: folder, path: nextPath });
      (org.folders || []).filter(function (child) { return child.parentId === folder.id; })
        .forEach(function (child) { walkFolders(child, nextPath); });
    };
    (org.folders || []).filter(function (f) { return !f.parentId || f.parentId === 'root' || String(f.parentId).indexOf('lineage:') === 0; })
      .forEach(function (f) { walkFolders(f, String(f.parentId || '').indexOf('lineage:') === 0 ? [String(f.parentId).slice(8)] : []); });
    // ORG placements use sourceKey/fileKey identity; menu selection uses runtime entry.id.
    const placeKeys = entryIds.map(function (id) {
      const node = ports.overview && ports.overview.findNode ? ports.overview.findNode(id) : null;
      return ports.nodePlaceKeys(node);
    }).flat().filter(Boolean);
    const countIn = function (fid) {
      let n = 0;
      const placements = org.placements || {};
      Object.keys(placements).forEach(function (k) { if (placements[k] === fid) n++; });
      return n;
    };
    allFolders.forEach(function (item) {
      const f = item.folder;
      m.appendChild(mk('📁 ' + item.path.join(' / ') + ' (' + countIn(f.id) + ')', '', function () {
        ports.ORG.moveKeys(ports.S.organization, stepKey, placeKeys, f.id);
        ports.afterOrgChange(stepKey, '已移入「' + f.name + '」· ' + entryIds.length + ' 条');
      }));
    });
    if (allFolders.length) m.appendChild(ports.el('div', 'menu-sep'));
    m.appendChild(mk('📁 + 新建文件夹并移入…', '', function () {
      ports.askSheet({ title: '新建文件夹并移入', value: '新建文件夹', ok: '创建并移入' }).then(function (name) {
        if (!name || !name.trim()) return;
        const newId = ports.ORG.createFolder(ports.S.organization, stepKey, { name: name.trim(), entryKeys: placeKeys });
        ports.afterOrgChange(stepKey, '已新建「' + name.trim() + '」并移入 ' + entryIds.length + ' 条', 'folder:user:' + newId);
      });
    }));
    m.appendChild(mk('移到这一步的根目录（移出文件夹）', '', function () {
      ports.ORG.moveKeys(ports.S.organization, stepKey, placeKeys, 'root');
      ports.afterOrgChange(stepKey, '已移到根目录 · ' + entryIds.length + ' 条');
    }));
    // 先关其他菜单，但不要再次调用 closeMenus('orgMenu')，否则刚生成的选择器会立刻隐藏。
    document.querySelectorAll('.menu').forEach(function (other) {
      if (other !== m) other.hidden = true;
    });
    m.hidden = false;
    const r = anchorRect || { left: 100, top: 100, bottom: 140, right: 300 };
    const mw = 250, mh = m.offsetHeight || 200;
    let x = Math.min(r.left, window.innerWidth - mw - 8);
    if (x < 8) x = 8;
    let y = r.bottom + 4;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  }
  function openGroupMenu(ids, anchorEl) {
    const menu = ports.$('groupMenu');
    if (!menu) return;
    menu.innerHTML = '';
    menu.appendChild(ports.el('div', 'gm-title',
      ids.length > 1 ? ('把 ' + ids.length + ' 个结构移入…') : '移入文件夹…'));
    for (const g of ports.S.groups) {
      const b = ports.el('button', 'gm-item', g.name + ' (' + g.entryIds.length + ')');
      b.addEventListener('click', function () { moveEntriesToGroup(ids, g.id); closeGroupMenu(); });
      menu.appendChild(b);
    }
    const nb = ports.el('button', 'gm-item gm-new', '+ 新建文件夹并移入');
    nb.addEventListener('click', function () {
      ports.askSheet({ title: '新建文件夹', value: '新建文件夹 ' + (ports.S.groups.length + 1), ok: '创建' }).then(function (name) {
        if (name && name.trim()) {
          const g = ports.createGroup(name.trim(), [], false);
          moveEntriesToGroup(ids, g.id);
        }
        closeGroupMenu();
      });
    });
    menu.appendChild(nb);
    const r = anchorEl.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 222)) + 'px';
    menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 270)) + 'px';
    menu.hidden = false;
  }
  function moveEntriesToGroup(ids, groupId) {
    const target = ports.S.groups.find(function (x) { return x.id === groupId; });
    if (!target) return;
    const set = new Set(ids);
    for (const g of ports.S.groups) {
      g.entryIds = g.entryIds.filter(function (id) { return !set.has(id); });
    }
    for (const id of ids) {
      if (target.entryIds.indexOf(id) < 0) target.entryIds.push(id);
    }
    renderGroups(); renderList(); ports.refreshBadge(); ports.applyModeChange(true);
    ports.toast('已移入「' + target.name + '」' + ids.length + ' 个结构');
  }
  function notifySidebarResize() {
    if (ports.S.overlayViewer) ports.S.overlayViewer.handleResize();
    ports.resizeGridViewers();
    scheduleGroupNavigation(true);
    if (ports.S.mode === 'overview') ports.renderOverviewWindow();
  }
  function setSidebarCollapsed(collapsed, persist) {
    ports.S.sidebarCollapsed = !!collapsed;
    const side = ports.$('sidebar');
    side.hidden = false;
    side.classList.toggle('is-collapsed', !!collapsed);
    side.inert = !!collapsed;
    document.body.classList.toggle('sidebar-collapsed', !!collapsed);
    ports.$('btnSidebarCollapse').setAttribute('aria-expanded', String(!collapsed));
    ports.$('btnSidebarCollapse').setAttribute('aria-label', collapsed ? '展开结构侧栏' : '收起结构侧栏');
    ports.$('btnSidebarCollapse').title = collapsed ? '展开结构侧栏' : '收起结构侧栏';
    ports.$('btnSidebarCollapse').classList.toggle('active', !collapsed);
    if (collapsed) { ports.closeMenus(); closeGroupMenu(); ports.$('metricsPanel').classList.remove('open'); }
    if (persist) try { localStorage.setItem(ports.SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (_) {}
    requestAnimationFrame(notifySidebarResize);
  }
  function bindSidebar() {
    let collapsed = false;
    try { collapsed = localStorage.getItem(ports.SIDEBAR_KEY) === '1'; } catch (_) {}
    setSidebarCollapsed(collapsed, false);
    ports.$('sidebar').addEventListener('transitionend', function (e) {
      if (e.target === ports.$('sidebar') && e.propertyName === 'margin-left') notifySidebarResize();
    });
    ports.$('btnSidebarCollapse').onclick = function () { setSidebarCollapsed(!ports.S.sidebarCollapsed, true); };
  }
// SERVICE_FUNCTIONS_END
  return { refreshReferenceSelect, sequenceBuckets, renderSidebarSteps, releaseSidebarSteps, recoverEmptyImportGroup, renderList, sidebarEntryModel, referenceName, updateGroupNavigation, scheduleGroupNavigation, bindGroupNavigation, renderGroups, setActiveGroup, renameGroup, deleteGroup, closeGroupMenu, openOrgMoveMenu, openGroupMenu, moveEntriesToGroup, notifySidebarResize, setSidebarCollapsed, bindSidebar };
}
