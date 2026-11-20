/* StructBoard · app.js
 * 基于 Mol* 5.13.1 的批量结构浏览台。
 * 所有结构数据只留在浏览器内存里，不上传。
 */
(function () {
  'use strict';
  let serviceInstances = null;
  function runtimeServices() {
    if (!serviceInstances) serviceInstances = {
    'workspace-state': window.SB_UI.services['workspace-state']({
      get $() { return $; },
      get LAST_SESSION_KEY() { return LAST_SESSION_KEY; },
      get LEGACY_LAST_SESSION_KEY() { return LEGACY_LAST_SESSION_KEY; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get SESSION_DB() { return SESSION_DB; },
      get SESSION_STORE() { return SESSION_STORE; },
      get activePane() { return activePane; }, set activePane(value) { activePane = value; },
      get activePipelineId() { return activePipelineId; },
      get addEntries() { return addEntries; },
      get applyModeChange() { return applyModeChange; },
      get applyPendingStepNotes() { return applyPendingStepNotes; },
      get createGroup() { return createGroup; },
      get entryOrgKey() { return entryOrgKey; },
      get folderEditStore() { return folderEditStore; },
      get hideLoadProgress() { return hideLoadProgress; },
      get hydrateStepNotesFromPipeline() { return hydrateStepNotesFromPipeline; },
      get loadStepEdits() { return loadStepEdits; },
      get loadProgressRun() { return loadProgressRun; }, set loadProgressRun(value) { loadProgressRun = value; },
      get localImportBusy() { return localImportBusy; },
      get notesSync() { return notesSync; },
      get overview() { return overview; }, set overview(value) { overview = value; },
      get panePipelineController() { return panePipelineController; },
      get panes() { return panes; },
      get pipelineTabBusy() { return pipelineTabBusy; }, set pipelineTabBusy(value) { pipelineTabBusy = value; },
      get pipelineTabs() { return pipelineTabs; },
      get pipelineViewSaveTimer() { return pipelineViewSaveTimer; }, set pipelineViewSaveTimer(value) { pipelineViewSaveTimer = value; },
      get rawS() { return rawS; },
      get reconcileFolderNotes() { return reconcileFolderNotes; },
      get refreshBadge() { return refreshBadge; },
      get refreshOverviewSearchState() { return refreshOverviewSearchState; },
      get refreshReferenceSelect() { return refreshReferenceSelect; },
      get renderGroups() { return renderGroups; },
      get renderList() { return renderList; },
      get renderMetricUI() { return renderMetricUI; },
      get renderPipelineTabs() { return renderPipelineTabs; },
      get resetSharedPaneViews() { return resetSharedPaneViews; },
      get restoreFolderNotes() { return restoreFolderNotes; },
      get restoreStepEdits() { return restoreStepEdits; },
      get sessionSaveCoordinator() { return sessionSaveCoordinator; }, set sessionSaveCoordinator(value) { sessionSaveCoordinator = value; },
      get sessionStore() { return sessionStore; },
      get setLoadProgress() { return setLoadProgress; },
      get setMode() { return setMode; },
      get splitOff() { return splitOff; },
      get splitOn() { return splitOn; },
      get splitState() { return splitState; },
      get status() { return status; },
      get toast() { return toast; },
      get updateEmptyState() { return updateEmptyState; },
      get withPaneSync() { return withPaneSync; },
      get workspaceService() { return workspaceService; }, set workspaceService(value) { workspaceService = value; },
      get workspaceWindowKey() { return workspaceWindowKey; }
    }),
    'structure-engine': window.SB_UI.services['structure-engine']({
      get $() { return $; },
      get ALIGN() { return ALIGN; },
      get IO() { return IO; },
      get METRICS() { return METRICS; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePane() { return activePane; },
      get applyModeChange() { return applyModeChange; },
      get canvasBg() { return canvasBg; },
      get contentFingerprint() { return contentFingerprint; },
      get el() { return el; },
      get gridLayer() { return gridLayer; },
      get gridNodeEntry() { return gridNodeEntry; },
      get isDarkTheme() { return isDarkTheme; },
      get note() { return note; },
      get pageSize() { return pageSize; },
      get paneAt() { return paneAt; },
      get paneContext() { return paneContext; },
      get paneElement() { return paneElement; },
      get panes() { return panes; },
      get rawS() { return rawS; },
      get refreshBadge() { return refreshBadge; },
      get renderList() { return renderList; },
      get resizeGridViewers() { return resizeGridViewers; },
      get sleep() { return sleep; },
      get status() { return status; },
      get syncPaneControls() { return syncPaneControls; },
      get toast() { return toast; },
      get visibleEntries() { return visibleEntries; },
      get withPaneSync() { return withPaneSync; }
    }),
    'structure-audit': window.SB_UI.services['structure-audit']({
      get ALIGN() { return ALIGN; },
      get LINEAGE() { return LINEAGE; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get PLACEMENT_RMSD() { return PLACEMENT_RMSD; },
      get S() { return S; },
      get alignedRecord() { return alignedRecord; },
      get overviewEntries() { return overviewEntries; },
      get overviewNodes() { return overviewNodes; },
      get paneRenderConfig() { return paneRenderConfig; },
      get placementCache() { return placementCache; },
      get poseCache() { return poseCache; },
      get rebuildOverview() { return rebuildOverview; },
      get refreshBadge() { return refreshBadge; },
      get renderList() { return renderList; },
      get renderMetricColor() { return renderMetricColor; },
      get saveMarks() { return saveMarks; },
      get toast() { return toast; }
    }),
    'structure-data': window.SB_UI.services['structure-data']({
      get $() { return $; },
      get IO() { return IO; },
      get LINEAGE() { return LINEAGE; },
      get MARKS_KEY() { return MARKS_KEY; },
      get METRICS() { return METRICS; },
      get ORG() { return ORG; },
      get PALETTE() { return PALETTE; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePane() { return activePane; },
      get animateTrashFlight() { return animateTrashFlight; },
      get applyAllPaneModes() { return applyAllPaneModes; },
      get applyModeChange() { return applyModeChange; },
      get cancelPipelineSync() { return cancelPipelineSync; },
      get colorOf() { return colorOf; },
      get guessPrimary() { return guessPrimary; },
      get hydrateStepNotesFromPipeline() { return hydrateStepNotesFromPipeline; },
      get marksSyncTimer() { return marksSyncTimer; }, set marksSyncTimer(value) { marksSyncTimer = value; },
      get notesSync() { return notesSync; },
      get paneAt() { return paneAt; },
      get paneContext() { return paneContext; },
      get paneElement() { return paneElement; },
      get panes() { return panes; },
      get pipelineTabs() { return pipelineTabs; },
      get pipelineWorkspaceKey() { return pipelineWorkspaceKey; },
      get rawS() { return rawS; },
      get recomputeMetricRange() { return recomputeMetricRange; },
      get refreshAlignBtn() { return refreshAlignBtn; },
      get refreshBadge() { return refreshBadge; },
      get refreshMetricsStatus() { return refreshMetricsStatus; },
      get refreshReferenceSelect() { return refreshReferenceSelect; },
      get refreshSharedPaneViews() { return refreshSharedPaneViews; },
      get renderGroups() { return renderGroups; },
      get renderList() { return renderList; },
      get renderMetricUI() { return renderMetricUI; },
      get renderPipelineTabs() { return renderPipelineTabs; },
      get resetGridNavigation() { return resetGridNavigation; },
      get resetSharedPaneViews() { return resetSharedPaneViews; },
      get restoreFolderNotes() { return restoreFolderNotes; },
      get saveCustomSteps() { return saveCustomSteps; },
      get saveLastSessionMeta() { return saveLastSessionMeta; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get sessionStore() { return sessionStore; },
      get setMode() { return setMode; },
      get status() { return status; },
      get syncPaneControls() { return syncPaneControls; },
      get toast() { return toast; },
      get updatePipelineIdentity() { return updatePipelineIdentity; },
      get withPaneSync() { return withPaneSync; }
    }),
    'file-import': window.SB_UI.services['file-import']({
      get $() { return $; },
      get IO() { return IO; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get ZIP() { return ZIP; },
      get activePipelineId() { return activePipelineId; },
      get addEntries() { return addEntries; },
      get addPipelineTab() { return addPipelineTab; },
      get afterOrgChange() { return afterOrgChange; },
      get autoApplyScores() { return autoApplyScores; },
      get clearOverviewReturn() { return clearOverviewReturn; },
      get createCustomStep() { return createCustomStep; },
      get disposeGrid() { return disposeGrid; },
      get entryOrgKey() { return entryOrgKey; },
      get extractScoreRow() { return extractScoreRow; },
      get hasWorkspaceContent() { return hasWorkspaceContent; },
      get hideLoadProgress() { return hideLoadProgress; },
      get importMetrics() { return importMetrics; },
      get loadDemoMetrics() { return loadDemoMetrics; },
      get localImportBusy() { return localImportBusy; }, set localImportBusy(value) { localImportBusy = value; },
      get note() { return note; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get overview() { return overview; },
      get paneAt() { return paneAt; },
      get panePipelineController() { return panePipelineController; },
      get panes() { return panes; },
      get pendingStepTarget() { return pendingStepTarget; }, set pendingStepTarget(value) { pendingStepTarget = value; },
      get pipelineTabBusy() { return pipelineTabBusy; },
      get plddtRow() { return plddtRow; },
      get rawS() { return rawS; },
      get rebuildOverview() { return rebuildOverview; },
      get recomputeMetricRange() { return recomputeMetricRange; },
      get refreshAlignBtn() { return refreshAlignBtn; },
      get refreshSharedPaneViews() { return refreshSharedPaneViews; },
      get renderList() { return renderList; },
      get renderMetricUI() { return renderMetricUI; },
      get resetGridNavigation() { return resetGridNavigation; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get setActivePane() { return setActivePane; },
      get setLoadProgress() { return setLoadProgress; },
      get sleep() { return sleep; },
      get status() { return status; },
      get stepKeyOfNode() { return stepKeyOfNode; },
      get toast() { return toast; }
    }),
    'metrics': window.SB_UI.services['metrics']({
      get $() { return $; },
      get METRICS() { return METRICS; },
      get S() { return S; },
      get applyModeChange() { return applyModeChange; },
      get applyTheme() { return applyTheme; },
      get metricsView() { return metricsView; }, set metricsView(value) { metricsView = value; },
      get note() { return note; },
      get pickImportMetrics() { return pickImportMetrics; },
      get rawS() { return rawS; },
      get refreshBadge() { return refreshBadge; },
      get refreshSharedPaneViews() { return refreshSharedPaneViews; },
      get renderList() { return renderList; },
      get toast() { return toast; },
      get visibleEntries() { return visibleEntries; }
    }),
    'notes': window.SB_UI.services['notes']({
      get CUSTOM_STEPS_KEY() { return CUSTOM_STEPS_KEY; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePipelineId() { return activePipelineId; },
      get entryIsTrashed() { return entryIsTrashed; },
      get folderEditStore() { return folderEditStore; },
      get notesSync() { return notesSync; },
      get overview() { return overview; },
      get panes() { return panes; },
      get rebuildOverview() { return rebuildOverview; },
      get refreshOrgButtons() { return refreshOrgButtons; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get sessionSaveCoordinator() { return sessionSaveCoordinator; },
      get showSessionSaveState() { return showSessionSaveState; },
      get stepEditStore() { return stepEditStore; },
      get stepKeyOfNode() { return stepKeyOfNode; },
      get stepNoteHydrateRuns() { return stepNoteHydrateRuns; },
      get toast() { return toast; }
    }),
    'step-organization': window.SB_UI.services['step-organization']({
      get $() { return $; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get S() { return S; },
      get activePipelineId() { return activePipelineId; },
      get addEntries() { return addEntries; },
      get applyModeChange() { return applyModeChange; },
      get askSheet() { return askSheet; },
      get closeMenus() { return closeMenus; },
      get el() { return el; },
      get entryIsTrashed() { return entryIsTrashed; },
      get entryOrgKey() { return entryOrgKey; },
      get loadStepEdits() { return loadStepEdits; },
      get openBenchWithEntries() { return openBenchWithEntries; },
      get openOrgMoveMenu() { return openOrgMoveMenu; },
      get overview() { return overview; },
      get overviewEntries() { return overviewEntries; },
      get pipelineSyncController() { return pipelineSyncController; }, set pipelineSyncController(value) { pipelineSyncController = value; },
      get pipelineSyncTimer() { return pipelineSyncTimer; }, set pipelineSyncTimer(value) { pipelineSyncTimer = value; },
      get rebuildOverview() { return rebuildOverview; },
      get refreshBadge() { return refreshBadge; },
      get refreshSharedPaneViews() { return refreshSharedPaneViews; },
      get renderList() { return renderList; },
      get saveCustomSteps() { return saveCustomSteps; },
      get saveStepEdit() { return saveStepEdit; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get setMode() { return setMode; },
      get stepModalState() { return stepModalState; }, set stepModalState(value) { stepModalState = value; },
      get toast() { return toast; },
      get triggerStepImport() { return triggerStepImport; }
    }),
    'sidebar': window.SB_UI.services['sidebar']({
      get entryIsTrashed() { return entryIsTrashed; },
      get stepIsTrashed() { return stepIsTrashed; },
      get $() { return $; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get SIDEBAR_KEY() { return SIDEBAR_KEY; },
      get afterOrgChange() { return afterOrgChange; },
      get alignedRecord() { return alignedRecord; },
      get applyModeChange() { return applyModeChange; },
      get askSheet() { return askSheet; },
      get closeMenus() { return closeMenus; },
      get createGroup() { return createGroup; },
      get el() { return el; },
      get entryIsTrashed() { return entryIsTrashed; },
      get fmtSize() { return fmtSize; },
      get formatLabel() { return formatLabel; },
      get groupNavFrame() { return groupNavFrame; }, set groupNavFrame(value) { groupNavFrame = value; },
      get groupView() { return groupView; }, set groupView(value) { groupView = value; },
      get hexOf() { return hexOf; },
      get inActiveGroup() { return inActiveGroup; },
      get metricColor() { return metricColor; },
      get metricText() { return metricText; },
      get nodePlaceKeys() { return nodePlaceKeys; },
      get onColorChange() { return onColorChange; },
      get openEntryMenu() { return openEntryMenu; },
      get openStepMenu() { return openStepMenu; },
      get openStepModal() { return openStepModal; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get overview() { return overview; },
      get overviewNodes() { return overviewNodes; },
      get paneAt() { return paneAt; },
      get passesMetrics() { return passesMetrics; },
      get rawS() { return rawS; },
      get refreshBadge() { return refreshBadge; },
      get refreshGridHeaders() { return refreshGridHeaders; },
      get renameEntry() { return renameEntry; },
      get renameStepPrompt() { return renameStepPrompt; },
      get renderOverviewWindow() { return renderOverviewWindow; },
      get resizeGridViewers() { return resizeGridViewers; },
      get revealActiveGroup() { return revealActiveGroup; }, set revealActiveGroup(value) { revealActiveGroup = value; },
      get revealEntry() { return revealEntry; },
      get schedulePipelineViewSave() { return schedulePipelineViewSave; },
      get sidebarEntryView() { return sidebarEntryView; }, set sidebarEntryView(value) { sidebarEntryView = value; },
      get sidebarStepView() { return sidebarStepView; }, set sidebarStepView(value) { sidebarStepView = value; },
      get sortByMetric() { return sortByMetric; },
      get starCount() { return starCount; },
      get stepKeyOfNode() { return stepKeyOfNode; },
      get syncGridToListNav() { return syncGridToListNav; },
      get toast() { return toast; },
      get toggleSolo() { return toggleSolo; },
      get toggleStar() { return toggleStar; },
      get toggleVisible() { return toggleVisible; },
      get triggerStepImport() { return triggerStepImport; },
      get updateEmptyState() { return updateEmptyState; },
      get visibleEntries() { return visibleEntries; }
    }),
    'viewer-navigation': window.SB_UI.services['viewer-navigation']({
      get $() { return $; },
      get LINEAGE() { return LINEAGE; },
      get S() { return S; },
      get applyModeChange() { return applyModeChange; },
      get closeMenus() { return closeMenus; },
      get ensureOverview() { return ensureOverview; },
      get entryOrgKey() { return entryOrgKey; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get overview() { return overview; },
      get overviewEntries() { return overviewEntries; },
      get overviewNodes() { return overviewNodes; },
      get rebuildGrid() { return rebuildGrid; },
      get refreshBadge() { return refreshBadge; },
      get renderList() { return renderList; },
      get setMode() { return setMode; },
      get toast() { return toast; }
    }),
    'grid-view': window.SB_UI.services['grid-view']({
      get cameraSnapshot() { return cameraSnapshot; },
      get applyCameraSnapshot() { return applyCameraSnapshot; },
      get syncPaneControls() { return syncPaneControls; },
      get schedulePipelineViewSave() { return schedulePipelineViewSave; },
      get toast() { return toast; },
      get $() { return $; },
      get LINEAGE() { return LINEAGE; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePane() { return activePane; },
      get applyExtraRepresentation() { return applyExtraRepresentation; },
      get applyTheme() { return applyTheme; },
      get attachCameraSync() { return attachCameraSync; },
      get auditFolderNode() { return auditFolderNode; },
      get canvasBg() { return canvasBg; },
      get clearViewer() { return clearViewer; },
      get createViewer() { return createViewer; },
      get el() { return el; },
      get entryPose() { return entryPose; },
      get folderNoteOf() { return folderNoteOf; },
      get formatLabel() { return formatLabel; },
      get gridLayer() { return gridLayer; },
      get gridNodeEntry() { return gridNodeEntry; },
      get gridResizeRaf() { return gridResizeRaf; }, set gridResizeRaf(value) { gridResizeRaf = value; },
      get hexOf() { return hexOf; },
      get loadEntryInto() { return loadEntryInto; },
      get metricColor() { return metricColor; },
      get metricText() { return metricText; },
      get onColorChange() { return onColorChange; },
      get openEntryMenu() { return openEntryMenu; },
      get openGridFolder() { return openGridFolder; },
      get pageSize() { return pageSize; },
      get paneAt() { return paneAt; },
      get paneContext() { return paneContext; },
      get paneElement() { return paneElement; },
      get paneRenderConfig() { return paneRenderConfig; },
      get panes() { return panes; },
      get refreshBadge() { return refreshBadge; },
      get renameEntry() { return renameEntry; },
      get resetCamera() { return resetCamera; },
      get saveFolderNote() { return saveFolderNote; },
      get setActivePane() { return setActivePane; },
      get sleep() { return sleep; },
      get status() { return status; },
      get syncAllCameras() { return syncAllCameras; },
      get toggleStar() { return toggleStar; },
      get withPaneSync() { return withPaneSync; }
    }),
    'overview-controller': window.SB_UI.services['overview-controller']({
      get $() { return $; },
      get GROUPED_KEY() { return GROUPED_KEY; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePane() { return activePane; },
      get applyTheme() { return applyTheme; },
      get auditFolderKey() { return auditFolderKey; },
      get auditFolderNode() { return auditFolderNode; },
      get capOverviewCards() { return capOverviewCards; },
      get clearViewer() { return clearViewer; },
      get createViewer() { return createViewer; },
      get entryIsTrashed() { return entryIsTrashed; },
      get entryPose() { return entryPose; },
      get folderNoteOf() { return folderNoteOf; },
      get formatLabel() { return formatLabel; },
      get handleOrgMove() { return handleOrgMove; },
      get handleOrgPlace() { return handleOrgPlace; },
      get handleOrgResetLayout() { return handleOrgResetLayout; },
      get handleOverviewStepAction() { return handleOverviewStepAction; },
      get hexOf() { return hexOf; },
      get importDropIntoStep() { return importDropIntoStep; },
      get loadEntryInto() { return loadEntryInto; },
      get loadStepEdits() { return loadStepEdits; },
      get makeLocalFileNode() { return makeLocalFileNode; },
      get metricText() { return metricText; },
      get notesSync() { return notesSync; },
      get openCurrentInGrid() { return openCurrentInGrid; },
      get openLocalDir() { return openLocalDir; },
      get openOrgMenu() { return openOrgMenu; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get overview() { return overview; }, set overview(value) { overview = value; },
      get paneAt() { return paneAt; },
      get paneElement() { return paneElement; },
      get paneOverviewStage() { return paneOverviewStage; },
      get paneRenderConfig() { return paneRenderConfig; },
      get paneStage() { return paneStage; },
      get panes() { return panes; },
      get pipelineNoteTarget() { return pipelineNoteTarget; },
      get rawS() { return rawS; },
      get refreshBadge() { return refreshBadge; },
      get refreshOverviewGridButton() { return refreshOverviewGridButton; },
      get rememberOverviewPlace() { return rememberOverviewPlace; },
      get renameEntry() { return renameEntry; },
      get renameOrgFolder() { return renameOrgFolder; },
      get renderList() { return renderList; },
      get renderMetricColor() { return renderMetricColor; },
      get requireRenderConfig() { return requireRenderConfig; },
      get resetCamera() { return resetCamera; },
      get retryStepNote() { return retryStepNote; },
      get saveFolderNote() { return saveFolderNote; },
      get saveMarks() { return saveMarks; },
      get saveStepEdit() { return saveStepEdit; },
      get saveStepNote() { return saveStepNote; },
      get schedulePipelineSync() { return schedulePipelineSync; },
      get schedulePipelineViewSave() { return schedulePipelineViewSave; },
      get scopedPane() { return scopedPane; },
      get setActivePane() { return setActivePane; },
      get setMode() { return setMode; },
      get status() { return status; },
      get stepNoteState() { return stepNoteState; },
      get thumbnailKey() { return thumbnailKey; },
      get toast() { return toast; },
      get toggleStar() { return toggleStar; },
      get trashEntries() { return trashEntries; },
      get updateGridGeometry() { return updateGridGeometry; },
      get visibleEntries() { return visibleEntries; },
      get withPaneSync() { return withPaneSync; }
    }),
    'pane-controller': window.SB_UI.services['pane-controller']({
      get setGridArrangement() { return setGridArrangement; },
      get $() { return $; },
      get AI_PIPELINE_EXAMPLE() { return AI_PIPELINE_EXAMPLE; },
      get AI_PIPELINE_PROMPT() { return AI_PIPELINE_PROMPT; },
      get GRID_COL_MAX() { return GRID_COL_MAX; },
      get GRID_ROW_MAX() { return GRID_ROW_MAX; },
      get GRID_SHAPE_KEY() { return GRID_SHAPE_KEY; },
      get PANE_CONTROL_MENUS() { return PANE_CONTROL_MENUS; },
      get PANE_MENU_BUTTONS() { return PANE_MENU_BUTTONS; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get SPLIT_RATIO_KEY() { return SPLIT_RATIO_KEY; },
      get activePane() { return activePane; }, set activePane(value) { activePane = value; },
      get addPane2() { return addPane2; },
      get applyGridPlace() { return applyGridPlace; },
      get applyOverviewSearch() { return applyOverviewSearch; },
      get applyTheme() { return applyTheme; },
      get armGridFromOverview() { return armGridFromOverview; },
      get backGridFolder() { return backGridFolder; },
      get clearOverviewReturn() { return clearOverviewReturn; },
      get clearViewer() { return clearViewer; },
      get closeMenus() { return closeMenus; },
      get closeTrashPage() { return closeTrashPage; },
      get copyText() { return copyText; },
      get currentOrgContext() { return currentOrgContext; },
      get disposeGrid() { return disposeGrid; },
      get disposePane() { return disposePane; },
      get el() { return el; },
      get entryIsTrashed() { return entryIsTrashed; },
      get exportPlacement() { return exportPlacement; },
      get gridGpuCache() { return gridGpuCache; }, set gridGpuCache(value) { gridGpuCache = value; },
      get gridLayer() { return gridLayer; },
      get loadDemo() { return loadDemo; },
      get openAIPipelineAssist() { return openAIPipelineAssist; },
      get openCurrentInGrid() { return openCurrentInGrid; },
      get openStepModal() { return openStepModal; },
      get openTrashPage() { return openTrashPage; },
      get overview() { return overview; }, set overview(value) { overview = value; },
      get pageSize() { return pageSize; },
      get paneActionsMenu() { return paneActionsMenu; }, set paneActionsMenu(value) { paneActionsMenu = value; },
      get paneAt() { return paneAt; },
      get paneControlBindings() { return paneControlBindings; },
      get panePipelineController() { return panePipelineController; },
      get panes() { return panes; },
      get pickImport() { return pickImport; },
      get promptNewOrgFolder() { return promptNewOrgFolder; },
      get rawS() { return rawS; },
      get rebuildGrid() { return rebuildGrid; },
      get rebuildOverlay() { return rebuildOverlay; },
      get rebuildOverview() { return rebuildOverview; },
      get redoOrg() { return redoOrg; },
      get refreshGridHeaders() { return refreshGridHeaders; },
      get refreshReferenceSelect() { return refreshReferenceSelect; },
      get removePane2() { return removePane2; },
      get renderList() { return renderList; },
      get renderOverviewWindow() { return renderOverviewWindow; },
      get resetCamera() { return resetCamera; },
      get resetGridNavigation() { return resetGridNavigation; },
      get resizeGridViewers() { return resizeGridViewers; },
      get restoreAllTrash() { return restoreAllTrash; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get scopedPane() { return scopedPane; },
      get setOverviewGrouped() { return setOverviewGrouped; },
      get setSidebarCollapsed() { return setSidebarCollapsed; },
      get soloChipLabel() { return soloChipLabel; },
      get splitState() { return splitState; },
      get starPassing() { return starPassing; },
      get syncAllCameras() { return syncAllCameras; },
      get toast() { return toast; },
      get toggleAlign() { return toggleAlign; },
      get undoOrg() { return undoOrg; },
      get visibleEntries() { return visibleEntries; },
      get withPaneSync() { return withPaneSync; }
    }),
    'app-operations': window.SB_UI.services['app-operations']({
      get IO() { return IO; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get activePane() { return activePane; }, set activePane(value) { activePane = value; },
      get activePipelineId() { return activePipelineId; },
      get afterOrgChange() { return afterOrgChange; },
      get applyModeChange() { return applyModeChange; },
      get applyOverviewSearch() { return applyOverviewSearch; },
      get ensureOverview() { return ensureOverview; },
      get entryIsTrashed() { return entryIsTrashed; },
      get entryOrgKey() { return entryOrgKey; },
      get folderEditStore() { return folderEditStore; },
      get folderNoteOf() { return folderNoteOf; },
      get loadStepEdits() { return loadStepEdits; },
      get notesSync() { return notesSync; },
      get openBenchWithEntries() { return openBenchWithEntries; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get overview() { return overview; }, set overview(value) { overview = value; },
      get paneAt() { return paneAt; },
      get paneContext() { return paneContext; },
      get panes() { return panes; },
      get pipelineFolderWorkspaceId() { return pipelineFolderWorkspaceId; },
      get rawS() { return rawS; },
      get rebuildOverlay() { return rebuildOverlay; },
      get recomputeMetricRange() { return recomputeMetricRange; },
      get refreshBadge() { return refreshBadge; },
      get refreshMetricsStatus() { return refreshMetricsStatus; },
      get refreshStepsUI() { return refreshStepsUI; },
      get renderList() { return renderList; },
      get saveMarks() { return saveMarks; },
      get saveStepEdit() { return saveStepEdit; },
      get saveStepNote() { return saveStepNote; },
      get sessionSaveCoordinator() { return sessionSaveCoordinator; },
      get setMode() { return setMode; },
      get splitOn() { return splitOn; },
      get splitState() { return splitState; },
      get stepEditStore() { return stepEditStore; },
      get stepIsTrashed() { return stepIsTrashed; },
      get visibleEntries() { return visibleEntries; },
      get withPaneSync() { return withPaneSync; }
    }),
    'pipeline-assist': window.SB_UI.services['pipeline-assist']({
      get $() { return $; },
      get AI_PIPELINE_EXAMPLE() { return AI_PIPELINE_EXAMPLE; },
      get AI_PIPELINE_PROMPT() { return AI_PIPELINE_PROMPT; },
      get aiAssistLastRaw() { return aiAssistLastRaw; }, set aiAssistLastRaw(value) { aiAssistLastRaw = value; },
      get askSheet() { return askSheet; },
      get copyText() { return copyText; },
      get toast() { return toast; }
    }),
    'dialogs': window.SB_UI.services['dialogs']({
      get $() { return $; },
      get IO() { return IO; },
      get MARKS_KEY() { return MARKS_KEY; },
      get PLDDT_BANDS() { return PLDDT_BANDS; },
      get S() { return S; },
      get closeMenus() { return closeMenus; },
      get el() { return el; },
      get entryPath() { return entryPath; },
      get loadMarks() { return loadMarks; },
      get openGroupMenu() { return openGroupMenu; },
      get openMoveToStepMenu() { return openMoveToStepMenu; },
      get refreshBadge() { return refreshBadge; },
      get refreshGridHeaders() { return refreshGridHeaders; },
      get refreshReferenceSelect() { return refreshReferenceSelect; },
      get refreshSharedPaneViews() { return refreshSharedPaneViews; },
      get removeEntry() { return removeEntry; },
      get renderList() { return renderList; },
      get scheduleSessionSave() { return scheduleSessionSave; },
      get seqCtx() { return seqCtx; }, set seqCtx(value) { seqCtx = value; },
      get setReference() { return setReference; },
      get sheetHideTimer() { return sheetHideTimer; }, set sheetHideTimer(value) { sheetHideTimer = value; },
      get toggleStar() { return toggleStar; }
    }),
    'app-bindings': window.SB_UI.services['app-bindings']({
      get $() { return $; },
      get GRID_COL_MAX() { return GRID_COL_MAX; },
      get GRID_ROW_MAX() { return GRID_ROW_MAX; },
      get GRID_SHAPE_KEY() { return GRID_SHAPE_KEY; },
      get GROUPED_KEY() { return GROUPED_KEY; },
      get IO() { return IO; },
      get LINEAGE() { return LINEAGE; },
      get ORG() { return ORG; },
      get PANE_RUNTIME() { return PANE_RUNTIME; },
      get S() { return S; },
      get THEME_KEY() { return THEME_KEY; },
      get activePipelineId() { return activePipelineId; },
      get addEntries() { return addEntries; },
      get addFromUrl() { return addFromUrl; },
      get applyAllPaneModes() { return applyAllPaneModes; },
      get applyCanvasTheme() { return applyCanvasTheme; },
      get applyModeChange() { return applyModeChange; },
      get askSheet() { return askSheet; },
      get autoApplyScores() { return autoApplyScores; },
      get backGridFolder() { return backGridFolder; },
      get bindGroupNavigation() { return bindGroupNavigation; },
      get bindSidebar() { return bindSidebar; },
      get buildLocalSnapshot() { return buildLocalSnapshot; },
      get clampGridCount() { return clampGridCount; },
      get clearSavedSession() { return clearSavedSession; },
      get closeGroupMenu() { return closeGroupMenu; },
      get closeMenus() { return closeMenus; },
      get closePaneControlMenus() { return closePaneControlMenus; },
      get closeSeqViewer() { return closeSeqViewer; },
      get closeStepModal() { return closeStepModal; },
      get copyText() { return copyText; },
      get createCustomStep() { return createCustomStep; },
      get createGroup() { return createGroup; },
      get currentWorkspaceTabId() { return currentWorkspaceTabId; },
      get el() { return el; },
      get externalDropTarget() { return externalDropTarget; },
      get flushAllStepNotes() { return flushAllStepNotes; },
      get folderEditStore() { return folderEditStore; },
      get gridNodeEntry() { return gridNodeEntry; },
      get harnessPane() { return harnessPane; },
      get hasWorkspaceContent() { return hasWorkspaceContent; },
      get hideLoadProgress() { return hideLoadProgress; },
      get hydrateStepNotesFromPipeline() { return hydrateStepNotesFromPipeline; },
      get importExternalDrop() { return importExternalDrop; },
      get importFiles() { return importFiles; },
      get isDarkTheme() { return isDarkTheme; },
      get isLocalWorkspaceTab() { return isLocalWorkspaceTab; },
      get loadDemo() { return loadDemo; },
      get loadProgressRun() { return loadProgressRun; }, set loadProgressRun(value) { loadProgressRun = value; },
      get loadStepEdits() { return loadStepEdits; },
      get marksSyncTimer() { return marksSyncTimer; }, set marksSyncTimer(value) { marksSyncTimer = value; },
      get moveStepBefore() { return moveStepBefore; },
      get moveStepByDelta() { return moveStepByDelta; },
      get openCurrentInGrid() { return openCurrentInGrid; },
      get openGroupMenu() { return openGroupMenu; },
      get orderedStepBuckets() { return orderedStepBuckets; },
      get orgRemoveSelection() { return orgRemoveSelection; },
      get overview() { return overview; },
      get pageSize() { return pageSize; },
      get paintGridRecommendation() { return paintGridRecommendation; },
      get paneActionsMenu() { return paneActionsMenu; },
      get paneAt() { return paneAt; },
      get paneContext() { return paneContext; },
      get paneControlElement() { return paneControlElement; },
      get panePipelineController() { return panePipelineController; }, set panePipelineController(value) { panePipelineController = value; },
      get paneStage() { return paneStage; },
      get panes() { return panes; },
      get pendingStepTarget() { return pendingStepTarget; }, set pendingStepTarget(value) { pendingStepTarget = value; },
      get pickImport() { return pickImport; },
      get pipelineTabs() { return pipelineTabs; },
      get pipelineWorkspaceKey() { return pipelineWorkspaceKey; },
      get plddtRow() { return plddtRow; },
      get preparePipelineWorkspace() { return preparePipelineWorkspace; },
      get publishPipelineWorkspace() { return publishPipelineWorkspace; },
      get rawS() { return rawS; },
      get rebuildGrid() { return rebuildGrid; },
      get rebuildOverlay() { return rebuildOverlay; },
      get rebuildOverview() { return rebuildOverview; },
      get redoOrg() { return redoOrg; },
      get refreshBadge() { return refreshBadge; },
      get refreshReferenceSelect() { return refreshReferenceSelect; },
      get refreshStepsUI() { return refreshStepsUI; },
      get renderGroups() { return renderGroups; },
      get renderList() { return renderList; },
      get renderMetricUI() { return renderMetricUI; },
      get renderOverviewWindow() { return renderOverviewWindow; },
      get renderPipelineTabs() { return renderPipelineTabs; },
      get resetCamera() { return resetCamera; },
      get resetGridNavigation() { return resetGridNavigation; },
      get resetSharedPaneViews() { return resetSharedPaneViews; },
      get resizeGridViewers() { return resizeGridViewers; },
      get saveCustomSteps() { return saveCustomSteps; },
      get savePipelineViewNow() { return savePipelineViewNow; },
      get saveStepEdit() { return saveStepEdit; },
      get schedulePipelineSync() { return schedulePipelineSync; },
      get schedulePipelineViewSave() { return schedulePipelineViewSave; },
      get seqCtx() { return seqCtx; },
      get sessionStore() { return sessionStore; },
      get setActiveGroup() { return setActiveGroup; },
      get setAllVisible() { return setAllVisible; },
      get setLoadProgress() { return setLoadProgress; },
      get setMode() { return setMode; },
      get setOverviewGrouped() { return setOverviewGrouped; },
      get setPaneSearchOpen() { return setPaneSearchOpen; },
      get setReference() { return setReference; },
      get sleep() { return sleep; },
      get sortByMetric() { return sortByMetric; },
      get status() { return status; },
      get stepModalState() { return stepModalState; },
      get switchPipelineTab() { return switchPipelineTab; },
      get syncModeTabs() { return syncModeTabs; },
      get syncModeThumb() { return syncModeThumb; },
      get syncPaneControls() { return syncPaneControls; },
      get toast() { return toast; },
      get toggleMenu() { return toggleMenu; },
      get toggleSplit() { return toggleSplit; },
      get undoOrg() { return undoOrg; },
      get updatePipelineIdentity() { return updatePipelineIdentity; },
      get visibleEntries() { return visibleEntries; },
      get windowStorageKey() { return windowStorageKey; },
      get withPaneSync() { return withPaneSync; },
      get workspaceSaveCoordinator() { return workspaceSaveCoordinator; }
    })
    };
    return serviceInstances;
  }

  const IO = window.SB_IO;
  const ALIGN = window.SB_ALIGN;
  const METRICS = window.SB_METRICS;
  const ZIP = window.SB_ZIP;
  const LINEAGE = window.SB_LINEAGE;
  const ORG = window.SB_ORG;
  const workspaceWindowKey = (function () {
    const query = new URLSearchParams(location.search).get('workspaceWindow') || '';
    const value = window.__SB_WORKSPACE_WINDOW_KEY__ || query || 'main';
    return /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : 'main';
  })();
  function windowStorageKey(key) { return workspaceWindowKey === 'main' ? key : key + '.' + workspaceWindowKey; }
  const pipelineTabs = window.SB_PIPELINE_TABS.create({
    storage: window.localStorage,
    key: 'structboard.pipelineTabs.' + workspaceWindowKey,
    document: document,
  });
  // Native initialization scripts run again on reload. Seed only the first
  // opening: an existing (including intentionally empty) catalog is authoritative.
  if (!pipelineTabs.hasSavedCatalog) {
    (window.__SB_BOOTSTRAP_TABS__ || []).forEach(function (item) { pipelineTabs.add(item, false); });
    if (window.__SB_BOOTSTRAP_ACTIVE_PIPELINE__) pipelineTabs.activate(window.__SB_BOOTSTRAP_ACTIVE_PIPELINE__);
  }
  function pipelineWorkspaceKey(pipelineId, windowKey) { /* @service workspace-state pipelineWorkspaceKey */
    return runtimeServices()['workspace-state'].pipelineWorkspaceKey(...arguments);
  }
  function isLocalWorkspaceTab(id) { /* @service workspace-state isLocalWorkspaceTab */
    return runtimeServices()['workspace-state'].isLocalWorkspaceTab(...arguments);
  }
  function pipelineViewStateKey(pipelineId, windowKey) { /* @service workspace-state pipelineViewStateKey */
    return runtimeServices()['workspace-state'].pipelineViewStateKey(...arguments);
  }
  function pipelineFolderWorkspaceId(pipelineId, windowKey) { /* @service workspace-state pipelineFolderWorkspaceId */
    return runtimeServices()['workspace-state'].pipelineFolderWorkspaceId(...arguments);
  }
  function rekeyFolderDrafts(snapshot, pipelineId, windowKey) { /* @service workspace-state rekeyFolderDrafts */
    return runtimeServices()['workspace-state'].rekeyFolderDrafts(...arguments);
  }
  const PALETTE = [
    0x2f6fad, 0xd05a3c, 0x3d9367, 0x9a63b8,
    0xd19a2c, 0x2f8f9d, 0xb8477a, 0x6b7f3a,
    0x5b6fb5, 0xb8703a, 0x3f9c8b, 0x8d5a8f,
  ];

  // 分屏状态必须早于 $() 声明：$() 依赖它判断「这个 id 属于哪一栏」。
  // prefixes 里第 0 栏为空串（沿用原有 id，单屏时零成本），第 1 栏加前缀避免 id 冲突。
  let activePane = 0;
  let scopedPane = null; // 同步兼容代码的上下文；异步作业必须捕获 pane / render config。
  const splitState = { active: false, get activePane() { return activePane; }, prefixes: ['', 'p2-'] };

  // 分屏时每栏各有一份的界面元素。其余元素（侧栏、状态栏、AI 悬浮球）全窗唯一。
  const PANE_SCOPED_IDS = new Set([
    'overviewStage', 'overviewScroll', 'overviewSpacer', 'overviewCards', 'overviewEmpty', 'overviewStatus',
    'overviewPath', 'overviewTitle', 'overviewSearch', 'btnOverviewSearchClear', 'btnOverviewBack',
    'btnOverviewNewFolder', 'btnOverviewUndo', 'btnOverviewRedo', 'btnOverviewLite', 'btnOverviewPause',
    'btnOverviewGrouped', 'btnOverviewToGrid', 'btnOverviewMore', 'overviewMoreMenu', 'btnSplitToggle',
    // 检阅台与工具栏同样每栏一份：否则右侧切到检阅台会画在整幅宽度上，盖住另一栏。
    'gridStage', 'overlayStage', 'trashStage', 'toolbar', 'camDock', 'gridPager', 'pageLabel',
    'btnGridBack', 'btnPrevPage', 'btnNextPage', 'btnShowAll', 'stageBadge', 'emptyState',
    'selTheme', 'selRepr', 'selCols', 'selRows', 'btnGridRec', 'btnAlign', 'btnFollowRef',
    'benchSide', 'benchOverlay', 'gridTools', 'overlayTools', 'benchToggle', 'btnGridByCandidate', 'btnGridFlat',
    'selMaxOverlay', 'btnSyncCam', 'btnResetCam', 'btnShot', 'btnViewMore', 'viewMenu',
    'btnTrash', 'trashCount', 'trashCards', 'trashEmpty', 'trashPageCount',
    'btnTrashBack', 'btnTrashRestoreAll',
    'btnOverviewSearchToggle', 'btnOverviewNewStep', 'btnOverviewPipeline', 'btnOverviewAIPipeline',
    'btnOverviewStarPass', 'btnOverviewExport', 'btnOverviewOpenAISettings',
    'btnGridLayout', 'gridLayoutMenu', 'btnGridAppearance', 'gridAppearanceMenu',
    'btnEmptyFiles', 'btnEmptyFolder', 'btnEmptyDemo', 'btnEmptyAIPrompt', 'btnEmptyAIExample', 'btnEmptyAIImport',
    // 注意：顶栏的 mode-switch 全窗唯一，故意不放进来；每栏的模式切换用栏内按钮。
  ]);

  const $ = function (id) {
    if (PANE_SCOPED_IDS.has(id) && (scopedPane || splitState.active)) {
      const prefix = scopedPane ? scopedPane.prefix : splitState.prefixes[activePane];
      if (prefix) return document.getElementById(prefix + id);
    }
    return document.getElementById(id);
  };
  const el = function (tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /* ---------------- 主题（磨砂浅色 / 深色玻璃） ---------------- */

  const THEME_KEY = 'structboard.theme';
  function isDarkTheme() { return document.body.classList.contains('dark'); }
  function canvasBg() { return isDarkTheme() ? '#1f2023' : '#eef0f2'; }
  try {
    document.body.classList.toggle('dark', localStorage.getItem(THEME_KEY) === 'dark');
  } catch (e) { /* ignore */ }

  function applyCanvasTheme() {
    // Mol* 的 Color 实际就是 number（0xRRGGBB），直接传数值即可
    const bgNum = parseInt(canvasBg().slice(1), 16);
    for (const v of allViewers()) {
      try {
        const c3d = v.plugin.canvas3d || v.plugin.canvas;
        if (c3d && c3d.setProps) c3d.setProps({ renderer: { backgroundColor: bgNum } });
      } catch (err) { /* ignore */ }
    }
  }

  /* ---------------- 玻璃菜单（导入 / 列表 / 视图 / 条目） ---------------- */

  const MENU_IDS = ['importMenu', 'listMenu', 'viewMenu', 'entryMenu', 'stepMenu', 'orgMenu', 'overviewMoreMenu'];

  function closeMenus(except) {
    for (const id of MENU_IDS) {
      if (id === except) continue;
      const m = $(id);
      if (m && !m.hidden) m.hidden = true;
    }
  }

  function toggleMenu(id) {
    const m = $(id);
    const show = m.hidden;
    closeMenus(id);
    m.hidden = !show;
  }

  function entryPath(entry) { /* @service structure-data entryPath */
    return runtimeServices()['structure-data'].entryPath(...arguments);
  }
  function copyEntryPath(entry) { /* @service dialogs copyEntryPath */
    return runtimeServices()['dialogs'].copyEntryPath(...arguments);
  }
  function parentDir(path) { /* @service structure-data parentDir */
    return runtimeServices()['structure-data'].parentDir(...arguments);
  }
  function makeLocalFileNode(rest, key) { /* @service structure-data makeLocalFileNode */
    return runtimeServices()['structure-data'].makeLocalFileNode(...arguments);
  }
  function capOverviewCards(cards, entries, key) { /* @service structure-data capOverviewCards */
    return runtimeServices()['structure-data'].capOverviewCards(...arguments);
  }
  function openLocalDir(node) { /* @service dialogs openLocalDir */
    return runtimeServices()['dialogs'].openLocalDir(...arguments);
  }
  function revealEntry(entry) { /* @service dialogs revealEntry */
    return runtimeServices()['dialogs'].revealEntry(...arguments);
  }
  function renameEntry(entry) { /* @service dialogs renameEntry */
    return runtimeServices()['dialogs'].renameEntry(...arguments);
  }

  function openEntryMenu(entry, anchor, colorInput) { /* @service dialogs openEntryMenu */
    return runtimeServices()['dialogs'].openEntryMenu(...arguments);
  }

  const rawS = {
    entries: [],
    seq: 0,
    mode: 'overview',
    theme: 'per-structure',
    repr: 'cartoon',
    cols: 2,
    rows: 2,
    page: 0,
    filter: '',
    referenceId: null,
    aligned: false,
    overlayViewer: null,
    overlayRefs: [],       // { id, ref, color }
    gridViewers: [],
    busy: false,
    errors: [],
    metrics: {
      table: null,
      primary: '',
      higher: true,
      filters: [],
      range: null,
      matched: 0,
      fileName: '',
      auto: false,           // true = 指标表由 AF3/Boltz 分数自动生成（手动导入 CSV 会置 false 并接管）
    },
    autoScoreRows: [],       // 自动解析累积的分数行（{design, iptm, ...}）
    starOnly: false,         // 只看优选
    manualOrder: false,      // 拖动后使用手动顺序，重新选指标/应用排序时恢复指标顺序
    soloId: null,          // 单击列表单独查看
    syncCamera: true,      // 实时联动（转动任一视窗，其余持续跟随）
    maxOverlay: 20,        // 叠加视图最多同时载入的结构数，0 = 全部
    listLimit: 60,         // 列表分块渲染，避免上千个 DOM
    listNav: null,         // 侧栏层级：null | {stepKey,title} | {stepKey,title,group}
    listedCount: 0,
    overlaySkipped: 0,
    gridCells: [],         // 分屏 Viewer 池（翻页复用，不反复 dispose）
    lastCamera: null,
    groups: [],            // 每次导入自动归档为一个「文件夹」
    activeGroupId: 'all',
    groupSeq: 0,
    sidebarCollapsed: false,
    overviewGrouped: true,   // 总览的管线文件夹展示
    gridArrangement: 'candidate', gridGroupCount: 0, gridArrangementLabel: '按候选排列',
    gridDrill: null,         // 网格里已进入的文件夹 id；null = 序列层
    gridParentPage: 0,       // 进入文件夹前的页码
    gridContext: '',         // 批次/筛选变更后不沿用旧文件夹
    gridFromOverview: null,  // 从总览「检阅台」进来：返回要回到总览当前位置
    gridHoldPlace: false,    // 刚从总览带入路径时，侧栏同步不要冲掉 gridDrill
    gridNodes: [],           // 网格当前层节点（folder / entry），供钻入与分页共用
    gridPinned: [],          // Phase 1：选中集镜头——只看总览里选中的这几条 entry id
    gridBusy: false,
    gridLoadErrors: [],
    overviewStats: null,
    activePipelineId: '',
    localWorkspaceId: '',
    activePipelineName: '',
    customSteps: [],
    organization: {},
    trashFolders: [],
    trashSteps: [],
    trashOpen: false,
    trashReturnMode: 'overview',
    trashReturnPlace: null,
  };

  /* ---------------- 分屏：每栏独立的视图状态 ----------------
     数据（entries/groups/metrics/organization/visible/star）全局共享：同一份结构在
     两栏必须是同一份真相，否则「左栏可见、右栏隐藏」无法自洽。
     视图（模式/筛选/搜索/所在层级/滚动/配色/参考）各自独立，两栏才能分别停在
     不同步骤上做并排比对。
     实现上用代理转发：S.mode 这类读写自动落到「当前栏」，因此既有 84 处
     S.mode 引用不必逐个改写；分屏关闭时 panes 只有一栏，行为与旧版一致。 */
  const PANE_VIEW_KEYS = [
    'mode', 'theme', 'cols', 'rows', 'page', 'filter', 'referenceId', 'aligned',
    'starOnly', 'soloId', 'overviewGrouped', 'listNav', 'gridDrill', 'gridParentPage',
    'gridContext', 'gridFromOverview', 'gridPinned', 'gridNodes', 'gridStack', 'gridHoldPlace',
    'gridArrangement', 'gridGroupCount', 'gridArrangementLabel',
    'overviewReturn', 'soloFrom', 'lineageReferenceId', 'manualOrder', 'activeGroupId',
    'listLimit', 'listReset', 'listedCount', 'gridRecommend', 'overviewStats',
    'trashOpen', 'trashReturnMode', 'trashReturnPlace',
    'overlayViewer', 'overlayRefs', 'gridViewers', 'gridCells', 'gridBusy',
    'gridLoadErrors', 'lastCamera', 'syncCamera', 'overlaySkipped', 'repr', 'maxOverlay',
  ];
  const PANE_RUNTIME = window.SB_PANE_RUNTIME;
  const PANE_VIEW_SET = new Set(PANE_VIEW_KEYS);
  function makePaneState(initial, index) {
    return PANE_RUNTIME.createPane(initial, PANE_VIEW_KEYS, {
      index: index || 0, prefix: splitState.prefixes[index || 0] || '',
    });
  }
  const panes = [makePaneState(rawS, 0)];
  function addPane2() {
    if (panes.length > 1) return panes[1];
    const pane = makePaneState(panes[0].view, 1);
    pane.scrollTop = panes[0].scrollTop;
    panes.push(pane);
    return pane;
  }
  function removePane2() {
    if (panes.length < 2) return;
    const retired = panes.pop();
    disposePane(retired);
    if (activePane > 0) activePane = 0;
    return retired;
  }
  function paneAt(value) {
    if (value && value.pane) return value.pane;
    if (value && value.view && value.runtime) return value;
    return typeof value === 'number' ? panes[value] : (scopedPane || panes[activePane]);
  }
  function paneContext(value) {
    const pane = paneAt(value);
    if (!pane) return null;
    if (!pane.runtime.context) pane.runtime.context = PANE_RUNTIME.stateFor(pane, rawS, PANE_VIEW_SET);
    return pane.runtime.context;
  }
  function paneElement(value, id) {
    const pane = paneAt(value);
    if (!pane || pane.disposed) return null;
    if (!PANE_SCOPED_IDS.has(id)) return document.getElementById(id);
    const root = pane.el || paneStage(pane.index);
    const node = document.getElementById(pane.prefix + id);
    return root && node && root.contains(node) ? node : null;
  }
  // Only synchronous compatibility work belongs here. The context is restored before any Promise resumes.
  function withPaneSync(value, fn) {
    const pane = paneAt(value);
    if (!pane || pane.disposed) return;
    const previous = scopedPane;
    scopedPane = pane; overview = pane.overview || null;
    try { return fn(paneContext(pane), function (id) { return paneElement(pane, id); }, pane); }
    finally { scopedPane = previous; overview = ((previous || panes[activePane]) || {}).overview || null; }
  }
  function paneView() { return paneAt().view; }
  const S = new Proxy(rawS, {
    get: function (target, prop) { return PANE_VIEW_SET.has(prop) ? paneView()[prop] : target[prop]; },
    set: function (target, prop, value) {
      if (PANE_VIEW_SET.has(prop)) paneView()[prop] = value; else target[prop] = value;
      return true;
    },
    has: function (target, prop) { return PANE_VIEW_SET.has(prop) || prop in target; },
  });
  window.__SB__ = S;
  // 位置审计的行数据与动作：供验收脚本与外部调用，不参与运行逻辑。
  window.__SB_PLACEMENT__ = {
    rows: function () { return placementRows(); },
    starPassing: function () { return starPassing(); },
    exportCsv: function () { return exportPlacement(); },
  };

  function hexOf(c) { return '#' + c.toString(16).padStart(6, '0'); }
  function colorOf(hex) { return parseInt(hex.replace('#', ''), 16); }
  function entryOrgKey(entry) { /* @service structure-data entryOrgKey */
    return runtimeServices()['structure-data'].entryOrgKey(...arguments);
  }
  function stepIsTrashed(key) { /* @service structure-data stepIsTrashed */
    return runtimeServices()['structure-data'].stepIsTrashed(...arguments);
  }
  function entryIsTrashed(entry) { /* @service structure-data entryIsTrashed */
    return runtimeServices()['structure-data'].entryIsTrashed(...arguments);
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------------- 优选默认值与本机手动选择 ---------------- */

  const MARKS_KEY = windowStorageKey('structboard.marks');

  function loadMarks() { /* @service structure-data loadMarks */
    return runtimeServices()['structure-data'].loadMarks(...arguments);
  }

  // 便签只提交自己改动的那几个键；未写进管线的内容留在本机，下次启动重放。
  // 以前整表 GET→改一个键→整表 POST，会和星标、流程画布互相覆盖。
  const stepEditStore = window.SB_NOTE_EDIT.createStore({ storage: localStorage, storageKey: windowStorageKey('structboard.stepEdits') });
  const folderEditStore = window.SB_NOTE_EDIT.createFolderStore({ storage: localStorage,
    identityKey: windowStorageKey('structboard.workspaceId'), storageKey: windowStorageKey('structboard.folderEdits') });
  const notesSync = window.SB_NOTES_SYNC.create({
    storage: localStorage,
    storageKey: windowStorageKey('structboard.notesPending'),
    onChange: function () {
      // 便签每次输入都会走到这里：只补后台工作区备份，不把顶部徽标拉到「保存中」。
      if (!S.restoringSession) scheduleSessionSave({ quiet: true });
      if (overview && overview.paintNoteStates) overview.paintNoteStates();
    },
  });
  applyPendingStepNotes();

  let marksSyncTimer = 0;
  function activePipelineId() { /* @service structure-data activePipelineId */
    return runtimeServices()['structure-data'].activePipelineId(...arguments);
  }

  function scheduleMarksSync() { /* @service structure-data scheduleMarksSync */
    return runtimeServices()['structure-data'].scheduleMarksSync(...arguments);
  }

  function saveMarks() { /* @service structure-data saveMarks */
    return runtimeServices()['structure-data'].saveMarks(...arguments);
  }

  /* ---------------- 会话自动持久化（重启/重建免重复导入） ---------------- */
  const LAST_SESSION_KEY = 'structboard.lastSession.' + workspaceWindowKey;
  const LEGACY_LAST_SESSION_KEY = 'structboard.lastSession';
  const SESSION_DB = 'structboard_session';
  const SESSION_STORE = 'kv';
  const sessionStore = window.SB_SESSION_STORE.create(window.indexedDB, SESSION_DB);
  sessionStore.setKey(pipelineWorkspaceKey(''));
  let sessionSaveCoordinator = null;

  function openSessionDB() { /* @service workspace-state openSessionDB */
    return runtimeServices()['workspace-state'].openSessionDB(...arguments);
  }

  async function idbGet(key) { /* @service workspace-state idbGet */
    return runtimeServices()['workspace-state'].idbGet(...arguments);
  }

  async function idbSet(key, val) { /* @service workspace-state idbSet */
    return runtimeServices()['workspace-state'].idbSet(...arguments);
  }

  async function idbDel(key) { /* @service workspace-state idbDel */
    return runtimeServices()['workspace-state'].idbDel(...arguments);
  }

  function loadLastSessionMeta() { /* @service workspace-state loadLastSessionMeta */
    return runtimeServices()['workspace-state'].loadLastSessionMeta(...arguments);
  }

  function saveLastSessionMeta() { /* @service workspace-state saveLastSessionMeta */
    return runtimeServices()['workspace-state'].saveLastSessionMeta(...arguments);
  }

  function buildLocalSnapshot(workspace) { /* @service workspace-state buildLocalSnapshot */
    return runtimeServices()['workspace-state'].buildLocalSnapshot(...arguments);
  }

  function stableGroupKey(workspace, groupId) { /* @service workspace-state stableGroupKey */
    return runtimeServices()['workspace-state'].stableGroupKey(...arguments);
  }
  function captureWorkspaceViewState() { /* @service workspace-state captureWorkspaceViewState */
    return runtimeServices()['workspace-state'].captureWorkspaceViewState(...arguments);
  }
  let pipelineViewSaveTimer = 0;
  function savePipelineViewNow() { /* @service workspace-state savePipelineViewNow */
    return runtimeServices()['workspace-state'].savePipelineViewNow(...arguments);
  }
  function schedulePipelineViewSave() { /* @service workspace-state schedulePipelineViewSave */
    return runtimeServices()['workspace-state'].schedulePipelineViewSave(...arguments);
  }
  function loadPipelineViewState(pipelineId) { /* @service workspace-state loadPipelineViewState */
    return runtimeServices()['workspace-state'].loadPipelineViewState(...arguments);
  }
  function restoreWorkspaceViewState(saved) { /* @service workspace-state restoreWorkspaceViewState */
    return runtimeServices()['workspace-state'].restoreWorkspaceViewState(...arguments);
  }

  function showSessionSaveState(state, error) { /* @service workspace-state showSessionSaveState */
    return runtimeServices()['workspace-state'].showSessionSaveState(...arguments);
  }
  function workspaceSaveCoordinator() { /* @service workspace-state workspaceSaveCoordinator */
    return runtimeServices()['workspace-state'].workspaceSaveCoordinator(...arguments);
  }
  function scheduleSessionSave(options) { /* @service workspace-state scheduleSessionSave */
    return runtimeServices()['workspace-state'].scheduleSessionSave(...arguments);
  }

  function clearSavedSession() { /* @service workspace-state clearSavedSession */
    return runtimeServices()['workspace-state'].clearSavedSession(...arguments);
  }

  function applySnapshotEntries(snap) { /* @service workspace-state applySnapshotEntries */
    return runtimeServices()['workspace-state'].applySnapshotEntries(...arguments);
  }

  async function migrateSavedMemberships(snapshot) { /* @service workspace-state migrateSavedMemberships */
    return runtimeServices()['workspace-state'].migrateSavedMemberships(...arguments);
  }

  async function restoreLastSession() { /* @service workspace-state restoreLastSession */
    return runtimeServices()['workspace-state'].restoreLastSession(...arguments);
  }

  let pipelineTabBusy = false;
  let localImportBusy = 0;
  let workspaceService = null;
  function workspaceTransactions() { /* @service workspace-state workspaceTransactions */
    return runtimeServices()['workspace-state'].workspaceTransactions(...arguments);
  }

  async function resetWorkspaceForPipelineSwitch() { /* @service workspace-state resetWorkspaceForPipelineSwitch */
    return runtimeServices()['workspace-state'].resetWorkspaceForPipelineSwitch(...arguments);
  }
  async function restorePipelineSnapshot(snapshot) { /* @service workspace-state restorePipelineSnapshot */
    return runtimeServices()['workspace-state'].restorePipelineSnapshot(...arguments);
  }
  async function switchPipelineTab(pipelineId) {
    return workspaceTransactions().switchTo(pipelineId);
  }
  async function closePipelineTab(pipelineId) {
    return workspaceTransactions().close(pipelineId);
  }
  async function addPipelineTab() {
    return workspaceTransactions().create();
  }
  function emptyLocalWorkspace(id) { /* @service workspace-state emptyLocalWorkspace */
    return runtimeServices()['workspace-state'].emptyLocalWorkspace(...arguments);
  }
  async function detachPipelineTab(pipelineId) {
    return workspaceTransactions().detach(pipelineId);
  }

  function toggleStar(entry, on) { /* @service structure-data toggleStar */
    return runtimeServices()['structure-data'].toggleStar(...arguments);
  }

  function starCount() { /* @service structure-data starCount */
    return runtimeServices()['structure-data'].starCount(...arguments);
  }

  /* ---------------- AF3 / Boltz-2 分数自动解析 ---------------- */

  /**
   * 从一个 *_scores.json / *_summary_confidences_N.json / confidence json 里
   * 抽出 { design, ranking_score, iptm, ... } 一行。识别不了返回 null。
   * 规则：顶层对象；取有限的数值键（白名单优先，其余数值键也收，上限 14 个）；
   *       长数值数组若名字含 plddt → 求均值记 <key>_mean。
   */
  function extractScoreRow(fileName, text) { /* @service structure-data extractScoreRow */
    return runtimeServices()['structure-data'].extractScoreRow(...arguments);
  }

  /** pLDDT 兜底行：mmCIF/PDB 的 B 因子列（AF3 / Boltz 写的就是 pLDDT） */
  function plddtRow(raw) { /* @service structure-data plddtRow */
    return runtimeServices()['structure-data'].plddtRow(...arguments);
  }

  /**
   * 把自动分数行并入指标表。只填「没有手动导入过指标表」时的空档；
   * 用户手动导入 CSV（S.metrics.auto=false）后自动分数据不再抢主控。
   */
  function autoApplyScores(newRows) { /* @service structure-data autoApplyScores */
    return runtimeServices()['structure-data'].autoApplyScores(...arguments);
  }

  /* ---------------- 序列查看 ---------------- */

  let seqCtx = null;   // { entry, seqs, chainIdx }

  const PLDDT_BANDS = [[90, 'pl1'], [70, 'pl2'], [50, 'pl3']];

  function plddtClass(b) { /* @service dialogs plddtClass */
    return runtimeServices()['dialogs'].plddtClass(...arguments);
  }

  function renderSeqBody() { /* @service dialogs renderSeqBody */
    return runtimeServices()['dialogs'].renderSeqBody(...arguments);
  }

  function renderSeqChains() { /* @service dialogs renderSeqChains */
    return runtimeServices()['dialogs'].renderSeqChains(...arguments);
  }

  function openSeqViewer(entry) { /* @service dialogs openSeqViewer */
    return runtimeServices()['dialogs'].openSeqViewer(...arguments);
  }

  function closeSeqViewer() { /* @service dialogs closeSeqViewer */
    return runtimeServices()['dialogs'].closeSeqViewer(...arguments);
  }

  function copyText(text, okMsg) { /* @service dialogs copyText */
    return runtimeServices()['dialogs'].copyText(...arguments);
  }

  function fallbackCopy(text) { /* @service dialogs fallbackCopy */
    return runtimeServices()['dialogs'].fallbackCopy(...arguments);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function toast(msg, isError) { /* @service dialogs toast */
    return runtimeServices()['dialogs'].toast(...arguments);
  }

  function openTrashPage() { /* @service step-organization openTrashPage */
    return runtimeServices()['step-organization'].openTrashPage(...arguments);
  }
  function closeTrashPage() { /* @service step-organization closeTrashPage */
    return runtimeServices()['step-organization'].closeTrashPage(...arguments);
  }
  function renderTrashPage() { /* @service step-organization renderTrashPage */
    return runtimeServices()['step-organization'].renderTrashPage(...arguments);
  }
  function restoreAllTrash() { /* @service step-organization restoreAllTrash */
    return runtimeServices()['step-organization'].restoreAllTrash(...arguments);
  }

  let sheetHideTimer = 0;
  function askSheet(opts) { /* @service dialogs askSheet */
    return runtimeServices()['dialogs'].askSheet(...arguments);
  }

  function status(msg) { /* @service dialogs status */
    return runtimeServices()['dialogs'].status(...arguments);
  }

  function updatePipelineIdentity(name) { /* @service workspace-state updatePipelineIdentity */
    return runtimeServices()['workspace-state'].updatePipelineIdentity(...arguments);
  }
  function renderPipelineTabs() {
    const container = $('pipelineTabs');
    if (!container) return;
    if (!container.__uiErrorBound) {
      container.__uiErrorBound = true;
      container.addEventListener('structboard:ui-error', function (event) {
        toast('标签操作失败：' + (event.detail && event.detail.message || String(event.detail)), true);
      });
    }
    pipelineTabs.render(container, {
      onSelect: function (pipelineId) { return switchPipelineTab(pipelineId); },
      onClose: function (pipelineId) { return closePipelineTab(pipelineId); },
      onAdd: function () { return addPipelineTab(); },
      onDetach: function (pipelineId) { return detachPipelineTab(pipelineId); },
      onChange: renderPipelineTabs,
    });
    updatePipelineIdentity(rawS.activePipelineName || (pipelineTabs.get(pipelineTabs.activeId) || {}).name || '');
  }
  function ensureCurrentPipelineTab() { /* @service workspace-state ensureCurrentPipelineTab */
    return runtimeServices()['workspace-state'].ensureCurrentPipelineTab(...arguments);
  }
  function currentWorkspaceTabId() { /* @service workspace-state currentWorkspaceTabId */
    return runtimeServices()['workspace-state'].currentWorkspaceTabId(...arguments);
  }

  let loadProgressRun = null;
  function setLoadProgress(title, percent, detail) { /* @service dialogs setLoadProgress */
    return runtimeServices()['dialogs'].setLoadProgress(...arguments);
  }
  function hideLoadProgress() { /* @service dialogs hideLoadProgress */
    return runtimeServices()['dialogs'].hideLoadProgress(...arguments);
  }
  function note(msg, isError) { /* @service dialogs note */
    return runtimeServices()['dialogs'].note(...arguments);
  }

  /* ---------------- Viewer ---------------- */

  function viewerOptions(isGrid) { /* @service structure-engine viewerOptions */
    return runtimeServices()['structure-engine'].viewerOptions(...arguments);
  }

  async function createViewer(container) { /* @service structure-engine createViewer */
    return runtimeServices()['structure-engine'].createViewer(...arguments);
  }

  function ensureOverlayViewer(value) { /* @service structure-engine ensureOverlayViewer */
    return runtimeServices()['structure-engine'].ensureOverlayViewer(...arguments);
  }

  function paneRenderConfig(value) { /* @service structure-engine paneRenderConfig */
    return runtimeServices()['structure-engine'].paneRenderConfig(...arguments);
  }
  function renderConfigAlive(config) { /* @service structure-engine renderConfigAlive */
    return runtimeServices()['structure-engine'].renderConfigAlive(...arguments);
  }
  function requireRenderConfig(config) { /* @service structure-engine requireRenderConfig */
    return runtimeServices()['structure-engine'].requireRenderConfig(...arguments);
  }
  function alignedRecord(entry, value) { /* @service structure-engine alignedRecord */
    return runtimeServices()['structure-engine'].alignedRecord(...arguments);
  }
  function renderMetricColor(entry, config) { /* @service structure-engine renderMetricColor */
    return runtimeServices()['structure-engine'].renderMetricColor(...arguments);
  }

  function structuresOf(viewer) { /* @service structure-engine structuresOf */
    return runtimeServices()['structure-engine'].structuresOf(...arguments);
  }
  function refKey(ref) { /* @service structure-engine refKey */
    return runtimeServices()['structure-engine'].refKey(...arguments);
  }

  async function waitForNewStructure(viewer, before) { /* @service structure-engine waitForNewStructure */
    return runtimeServices()['structure-engine'].waitForNewStructure(...arguments);
  }

  function activeData(entry, value) { /* @service structure-engine activeData */
    return runtimeServices()['structure-engine'].activeData(...arguments);
  }
  function activeFormat(entry, value) { /* @service structure-engine activeFormat */
    return runtimeServices()['structure-engine'].activeFormat(...arguments);
  }

  async function ensureEntryLoaded(entry) { /* @service structure-engine ensureEntryLoaded */
    return runtimeServices()['structure-engine'].ensureEntryLoaded(...arguments);
  }

  async function loadEntryInto(viewer, entry, value, isCurrent) { /* @service structure-engine loadEntryInto */
    return runtimeServices()['structure-engine'].loadEntryInto(...arguments);
  }

  async function applyTheme(viewer, items, value) { /* @service structure-engine applyTheme */
    return runtimeServices()['structure-engine'].applyTheme(...arguments);
  }

  /* ---------------- 实时联动 ---------------- */

  function allViewers(value) { /* @service structure-engine allViewers */
    return runtimeServices()['structure-engine'].allViewers(...arguments);
  }

  function cameraSnapshot(v) { /* @service structure-engine cameraSnapshot */
    return runtimeServices()['structure-engine'].cameraSnapshot(...arguments);
  }

  function cameraFingerprint(s) { /* @service structure-engine cameraFingerprint */
    return runtimeServices()['structure-engine'].cameraFingerprint(...arguments);
  }

  function applyCameraSnapshot(v, snap) { /* @service structure-engine applyCameraSnapshot */
    return runtimeServices()['structure-engine'].applyCameraSnapshot(...arguments);
  }

  function broadcastCamera(source, snap, value) { /* @service structure-engine broadcastCamera */
    return runtimeServices()['structure-engine'].broadcastCamera(...arguments);
  }

  function attachCameraSync(viewer, value) { /* @service structure-engine attachCameraSync */
    return runtimeServices()['structure-engine'].attachCameraSync(...arguments);
  }

  function syncAllCameras(force, value) { /* @service structure-engine syncAllCameras */
    return runtimeServices()['structure-engine'].syncAllCameras(...arguments);
  }

  function refreshReferenceSelect() { /* @service sidebar refreshReferenceSelect */
    return runtimeServices()['sidebar'].refreshReferenceSelect(...arguments);
  }

  function soloChipLabel(backToOverview) { /* @service viewer-navigation soloChipLabel */
    return runtimeServices()['viewer-navigation'].soloChipLabel(...arguments);
  }
  function clearOverviewReturn() { /* @service viewer-navigation clearOverviewReturn */
    return runtimeServices()['viewer-navigation'].clearOverviewReturn(...arguments);
  }
  function rememberOverviewPlace() { /* @service viewer-navigation rememberOverviewPlace */
    return runtimeServices()['viewer-navigation'].rememberOverviewPlace(...arguments);
  }
  function toggleSolo(entry) { /* @service viewer-navigation toggleSolo */
    return runtimeServices()['viewer-navigation'].toggleSolo(...arguments);
  }

  async function resetCamera(viewer, durationMs, value) { /* @service structure-engine resetCamera */
    return runtimeServices()['structure-engine'].resetCamera(...arguments);
  }

  async function clearViewer(viewer) { /* @service structure-engine clearViewer */
    return runtimeServices()['structure-engine'].clearViewer(...arguments);
  }

  /* ---------------- 叠加视图 ---------------- */

  function rebuildOverlay(showBusy, value) { /* @service structure-engine rebuildOverlay */
    return runtimeServices()['structure-engine'].rebuildOverlay(...arguments);
  }

  function appendToOverlay(entry, value) { /* @service structure-engine appendToOverlay */
    return runtimeServices()['structure-engine'].appendToOverlay(...arguments);
  }

  async function applyExtraRepresentation(viewer, items, value) { /* @service structure-engine applyExtraRepresentation */
    return runtimeServices()['structure-engine'].applyExtraRepresentation(...arguments);
  }

  function setOverlayVisibility(entry, value) { /* @service structure-engine setOverlayVisibility */
    return runtimeServices()['structure-engine'].setOverlayVisibility(...arguments);
  }

  /* ---------------- 分屏网格 ---------------- */

  function pageSize() { /* @service viewer-navigation pageSize */
    return runtimeServices()['viewer-navigation'].pageSize(...arguments);
  }

  function resetGridNavigation() { /* @service viewer-navigation resetGridNavigation */
    return runtimeServices()['viewer-navigation'].resetGridNavigation(...arguments);
  }

  // 侧栏钻进某一步 / 某个候选夹时，网格只展示对应结构（总览墙仍看全管线）
  function listNavEntries(base) { /* @service viewer-navigation listNavEntries */
    return runtimeServices()['viewer-navigation'].listNavEntries(...arguments);
  }

  function syncGridToListNav() { /* @service viewer-navigation syncGridToListNav */
    return runtimeServices()['viewer-navigation'].syncGridToListNav(...arguments);
  }

  // 检阅台范围始终是结构集合，排列方式不改变成员。
  function gridLayer() { /* @service viewer-navigation gridLayer */
    return runtimeServices()['viewer-navigation'].gridLayer(...arguments);
  }

  function openGridFolder(id) { /* @service viewer-navigation openGridFolder */
    return runtimeServices()['viewer-navigation'].openGridFolder(...arguments);
  }

  function backGridFolder() { /* @service viewer-navigation backGridFolder */
    return runtimeServices()['viewer-navigation'].backGridFolder(...arguments);
  }

  function gridNodeEntry(node) { /* @service viewer-navigation gridNodeEntry */
    return runtimeServices()['viewer-navigation'].gridNodeEntry(...arguments);
  }

  function updateGridGeometry(value) { /* @service grid-view updateGridGeometry */
    return runtimeServices()['grid-view'].updateGridGeometry(...arguments);
  }
  function arrangeGridCells(pane) { /* @service grid-view arrangeGridCells */
    return runtimeServices()['grid-view'].arrangeGridCells(...arguments);
  }
  function setGridArrangement(mode, value) { /* @service grid-view setGridArrangement */
    return runtimeServices()['grid-view'].setGridArrangement(...arguments);
  }

  let gridResizeRaf = 0; // Standalone geometry harness fallback; real panes own their RAF.
  function resizeGridViewers(value) { /* @service grid-view resizeGridViewers */
    return runtimeServices()['grid-view'].resizeGridViewers(...arguments);
  }

  function disposeGrid(value) { /* @service grid-view disposeGrid */
    return runtimeServices()['grid-view'].disposeGrid(...arguments);
  }

  function disposePane(value) { /* @service grid-view disposePane */
    return runtimeServices()['grid-view'].disposePane(...arguments);
  }

  function refreshGridHeaders() { /* @service grid-view refreshGridHeaders */
    return runtimeServices()['grid-view'].refreshGridHeaders(...arguments);
  }

  // 显示现有位置审计口径，不把封面相似度误写成实验结合结论。
  function updateGridAudit(cell) { /* @service grid-view updateGridAudit */
    return runtimeServices()['grid-view'].updateGridAudit(...arguments);
  }

  function ensureGridCells(n, value) { /* @service grid-view ensureGridCells */
    return runtimeServices()['grid-view'].ensureGridCells(...arguments);
  }

  function rebuildGrid(value) { /* @service grid-view rebuildGrid */
    return runtimeServices()['grid-view'].rebuildGrid(...arguments);
  }
  function rebuildGridInPane(pane) { /* @service grid-view rebuildGridInPane */
    return runtimeServices()['grid-view'].rebuildGridInPane(...arguments);
  }

  /* ---------------- 可滚动结构缩略图总览 ---------------- */

  let overview = null;
  // 对齐后坐标的内容指纹：同样长度的不同结构也必须得到不同缓存键。
  // FNV-1a 32 位，计算一次后缓存在条目上（对齐 PDB 约几百 KB，全扫毫秒级）。
  function contentFingerprint(text) { /* @service structure-audit contentFingerprint */
    return runtimeServices()['structure-audit'].contentFingerprint(...arguments);
  }
  function alignedVariant(entry, value) { /* @service structure-audit alignedVariant */
    return runtimeServices()['structure-audit'].alignedVariant(...arguments);
  }
  function thumbnailKey(entry, value) { /* @service structure-audit thumbnailKey */
    return runtimeServices()['structure-audit'].thumbnailKey(...arguments);
  }
  /* 位置符合判定：优先读指标表里的显式字段；没有则本地算位姿偏差
     （靶点 CA 对齐后，binder CA RMSD ≤ 3 Å 记为符合）。 */
  const PLACEMENT_RMSD = 3.0;
  const placementCache = new Map();

  function parityKey(node) { /* @service structure-audit parityKey */
    return runtimeServices()['structure-audit'].parityKey(...arguments);
  }

  function auditFlagFromTable(entry) { /* @service structure-audit auditFlagFromTable */
    return runtimeServices()['structure-audit'].auditFlagFromTable(...arguments);
  }

  function splitChains(entry) { /* @service structure-audit splitChains */
    return runtimeServices()['structure-audit'].splitChains(...arguments);
  }

  /* 靶点（非 binder 链）按 CA 对齐后，比较 binder 的位姿偏差。
     同源二聚体（两条靶链残基数相同）需再做一次拷贝互换映射，取更优值，
     否则「binder 落到对称的另一拷贝」会被误判成位置不符。
     返回 null 表示无法比较（链结构不一致、原子不足、对齐失败）。 */
  function poseOnce(A, B, swapTargets) { /* @service structure-audit poseOnce */
    return runtimeServices()['structure-audit'].poseOnce(...arguments);
  }

  function poseDeviation(cover, entry) { /* @service structure-audit poseDeviation */
    return runtimeServices()['structure-audit'].poseDeviation(...arguments);
  }

  function auditFlags(node) { /* @service structure-audit auditFlags */
    return runtimeServices()['structure-audit'].auditFlags(...arguments);
  }
  function auditParsedSig(node) { /* @service structure-audit auditParsedSig */
    return runtimeServices()['structure-audit'].auditParsedSig(...arguments);
  }
  function auditFolderKey(node) { /* @service structure-audit auditFolderKey */
    return runtimeServices()['structure-audit'].auditFolderKey(...arguments);
  }

  function auditFolderNode(node) { /* @service structure-audit auditFolderNode */
    return runtimeServices()['structure-audit'].auditFolderNode(...arguments);
  }

  /* 单个预测相对同组封面（model_0）的位姿偏差，供「点进文件夹」后逐卡片标注。
     指标表里有显式字段时直接用表，否则本地算，口径与文件夹角标一致。 */
  const poseCache = new Map();
  function groupCover(entry) { /* @service structure-audit groupCover */
    return runtimeServices()['structure-audit'].groupCover(...arguments);
  }
  function entryPose(entry) { /* @service structure-audit entryPose */
    return runtimeServices()['structure-audit'].entryPose(...arguments);
  }

  /* 位置审计的逐模型行：供导出 CSV 与「标记符合位置的为优选」共用。 */
  function placementRows() { /* @service structure-audit placementRows */
    return runtimeServices()['structure-audit'].placementRows(...arguments);
  }

  function exportPlacement() { /* @service structure-audit exportPlacement */
    return runtimeServices()['structure-audit'].exportPlacement(...arguments);
  }

  function starPassing() { /* @service structure-audit starPassing */
    return runtimeServices()['structure-audit'].starPassing(...arguments);
  }

  function ensureOverview(value) { /* @service overview-controller ensureOverview */
    return runtimeServices()['overview-controller'].ensureOverview(...arguments);
  }
  function overviewEntries() { /* @service overview-controller overviewEntries */
    return runtimeServices()['overview-controller'].overviewEntries(...arguments);
  }

  /* 候选文件夹卡片：entry.group（AF3 zip 每设计的 5 个预测、管线 _model_N/groupBy 推断）折叠成一张文件夹卡片。
     只有 ≥2 个成员的分组才成文件夹（boltz619 这类每序列 1 个预测的保持平铺）；
     组内按 modelIndex 排序保证封面是 model_0。点进文件夹后才看到里面的结构。 */
  function overviewNodes(entries, opts) { /* @service overview-controller overviewNodes */
    return runtimeServices()['overview-controller'].overviewNodes(...arguments);
  }

  const CUSTOM_STEPS_KEY = windowStorageKey('structboard.customSteps');
  function loadCustomSteps() { /* @service notes loadCustomSteps */
    return runtimeServices()['notes'].loadCustomSteps(...arguments);
  }
  function saveCustomSteps() { /* @service notes saveCustomSteps */
    return runtimeServices()['notes'].saveCustomSteps(...arguments);
  }

  function loadStepEdits() { /* @service notes loadStepEdits */
    return runtimeServices()['notes'].loadStepEdits(...arguments);
  }
  function restoreStepEdits(saved) { /* @service notes restoreStepEdits */
    return runtimeServices()['notes'].restoreStepEdits(...arguments);
  }
  function saveStepEdit(key, patch, options) { /* @service notes saveStepEdit */
    return runtimeServices()['notes'].saveStepEdit(...arguments);
  }
  function folderNoteOf(node) { /* @service notes folderNoteOf */
    return runtimeServices()['notes'].folderNoteOf(...arguments);
  }
  function folderNoteTarget(node) { /* @service notes folderNoteTarget */
    return runtimeServices()['notes'].folderNoteTarget(...arguments);
  }
  function folderNodeForNote(stepKey, folderId) { /* @service notes folderNodeForNote */
    return runtimeServices()['notes'].folderNodeForNote(...arguments);
  }
  function organizationFolderNote(node) { /* @service notes organizationFolderNote */
    return runtimeServices()['notes'].organizationFolderNote(...arguments);
  }
  function applyFolderNote(node, value) { /* @service notes applyFolderNote */
    return runtimeServices()['notes'].applyFolderNote(...arguments);
  }
  function folderNotePatchKey(target) { /* @service notes folderNotePatchKey */
    return runtimeServices()['notes'].folderNotePatchKey(...arguments);
  }
  function persistFolderNote(target, value) { /* @service notes persistFolderNote */
    return runtimeServices()['notes'].persistFolderNote(...arguments);
  }
  function folderDraftError(error) { /* @service notes folderDraftError */
    return runtimeServices()['notes'].folderDraftError(...arguments);
  }
  function saveFolderNote(node, text) { /* @service notes saveFolderNote */
    return runtimeServices()['notes'].saveFolderNote(...arguments);
  }
  function restoreFolderNotes(saved, workspaceId) { /* @service notes restoreFolderNotes */
    return runtimeServices()['notes'].restoreFolderNotes(...arguments);
  }
  function reconcileFolderNotes() { /* @service notes reconcileFolderNotes */
    return runtimeServices()['notes'].reconcileFolderNotes(...arguments);
  }
  function hydrateFolderNotes(pid, values) { /* @service notes hydrateFolderNotes */
    return runtimeServices()['notes'].hydrateFolderNotes(...arguments);
  }
  function applyGridPlace(place) { /* @service viewer-navigation applyGridPlace */
    return runtimeServices()['viewer-navigation'].applyGridPlace(...arguments);
  }
  function stepTitleOfKey(stepKey) { /* @service viewer-navigation stepTitleOfKey */
    return runtimeServices()['viewer-navigation'].stepTitleOfKey(...arguments);
  }
  function listNavFromOverviewNode(node) { /* @service viewer-navigation listNavFromOverviewNode */
    return runtimeServices()['viewer-navigation'].listNavFromOverviewNode(...arguments);
  }
  function armGridFromOverview(place, drill) { /* @service viewer-navigation armGridFromOverview */
    return runtimeServices()['viewer-navigation'].armGridFromOverview(...arguments);
  }
  function returnToOverviewPlace() { /* @service viewer-navigation returnToOverviewPlace */
    return runtimeServices()['viewer-navigation'].returnToOverviewPlace(...arguments);
  }
  // Phase 1：总览当前位置上可直接查看的结构数（墙根规则与按钮状态共用）。
  function overviewCurrentLeafCount() { /* @service viewer-navigation overviewCurrentLeafCount */
    return runtimeServices()['viewer-navigation'].overviewCurrentLeafCount(...arguments);
  }
  function refreshOverviewGridButton(selectedIds) { /* @service viewer-navigation refreshOverviewGridButton */
    return runtimeServices()['viewer-navigation'].refreshOverviewGridButton(...arguments);
  }
  // 方案 A：从总览选中集构建检阅台范围——选中的步骤（整步条目）+ 选中的结构卡，按管线顺序。
  // 注意：section 节点不带 entries 字段，用 stepKey 从 S.entries 取整步条目。
  function benchScopeFromSelection() { /* @service viewer-navigation benchScopeFromSelection */
    return runtimeServices()['viewer-navigation'].benchScopeFromSelection(...arguments);
  }
  function openBenchWithEntries(entries, label) { /* @service viewer-navigation openBenchWithEntries */
    return runtimeServices()['viewer-navigation'].openBenchWithEntries(...arguments);
  }
  function openPinnedInGrid() { /* @service viewer-navigation openPinnedInGrid */
    return runtimeServices()['viewer-navigation'].openPinnedInGrid(...arguments);
  }
  function openCurrentInGrid() { /* @service viewer-navigation openCurrentInGrid */
    return runtimeServices()['viewer-navigation'].openCurrentInGrid(...arguments);
  }
  // 步骤便签的磁盘目标是「管线 id : 步骤 id」。自建步骤没有对应管线步骤，只留在本机。
  function pipelineNoteTarget(key) { /* @service notes pipelineNoteTarget */
    return runtimeServices()['notes'].pipelineNoteTarget(...arguments);
  }
  function stepNoteState(key) { /* @service notes stepNoteState */
    return runtimeServices()['notes'].stepNoteState(...arguments);
  }
  function persistStepNote(key, note) { /* @service notes persistStepNote */
    return runtimeServices()['notes'].persistStepNote(...arguments);
  }
  function saveStepNote(key, note) { /* @service notes saveStepNote */
    return runtimeServices()['notes'].saveStepNote(...arguments);
  }
  function retryStepNote(key) { /* @service notes retryStepNote */
    return runtimeServices()['notes'].retryStepNote(...arguments);
  }
  function applyPendingStepNotes() { /* @service notes applyPendingStepNotes */
    return runtimeServices()['notes'].applyPendingStepNotes(...arguments);
  }

  // 本机值（包括显式空串）优先；每条管线独立获取，异步返回不能覆盖期间的新输入。
  const stepNoteHydrateRuns = new Map();
  async function hydrateStepNotesFromPipeline(pipelineId) { /* @service notes hydrateStepNotesFromPipeline */
    return runtimeServices()['notes'].hydrateStepNotesFromPipeline(...arguments);
  }
  function hydrateWorkspaceStepNotes() { /* @service notes hydrateWorkspaceStepNotes */
    return runtimeServices()['notes'].hydrateWorkspaceStepNotes(...arguments);
  }

  function orderedStepBuckets(entries, opts) { /* @service step-organization orderedStepBuckets */
    return runtimeServices()['step-organization'].orderedStepBuckets(...arguments);
  }

  function persistStepOrder(orderedList) { /* @service step-organization persistStepOrder */
    return runtimeServices()['step-organization'].persistStepOrder(...arguments);
  }

  // 把「当前界面上的步骤顺序 / 标题 / 工具标签 / organization」合成管线定义的 steps。
  // 纯函数：不读 S、不发请求，方便直接回归，也方便以后由动作层复用。
  // 关键约束：已存在的步骤一律只改显示层字段，科学 files[] / lineage 逐字段原样带过去。
  function mergePipelineSteps(defn, ordered, edits, helpers) { /* @service step-organization mergePipelineSteps */
    return runtimeServices()['step-organization'].mergePipelineSteps(...arguments);
  }

  let pipelineSyncTimer = 0;
  let pipelineSyncController = null;
  function cancelPipelineSync() { /* @service step-organization cancelPipelineSync */
    return runtimeServices()['step-organization'].cancelPipelineSync(...arguments);
  }
  function schedulePipelineSync() { /* @service step-organization schedulePipelineSync */
    return runtimeServices()['step-organization'].schedulePipelineSync(...arguments);
  }

  function refreshStepsUI(rebuildRight) { /* @service step-organization refreshStepsUI */
    return runtimeServices()['step-organization'].refreshStepsUI(...arguments);
  }

  function moveStepByDelta(key, delta) { /* @service step-organization moveStepByDelta */
    return runtimeServices()['step-organization'].moveStepByDelta(...arguments);
  }

  function moveStepBefore(sourceKey, targetKey, after) { /* @service step-organization moveStepBefore */
    return runtimeServices()['step-organization'].moveStepBefore(...arguments);
  }

  function createCustomStep(opts) { /* @service step-organization createCustomStep */
    return runtimeServices()['step-organization'].createCustomStep(...arguments);
  }

  function renameStepPrompt(key) { /* @service step-organization renameStepPrompt */
    return runtimeServices()['step-organization'].renameStepPrompt(...arguments);
  }

  function deleteStep(key) { /* @service step-organization deleteStep */
    return runtimeServices()['step-organization'].deleteStep(...arguments);
  }

  function moveEntriesToStep(ids, targetStepKey) { /* @service step-organization moveEntriesToStep */
    return runtimeServices()['step-organization'].moveEntriesToStep(...arguments);
  }

  function openMoveToStepMenu(ids, anchorEl) { /* @service step-organization openMoveToStepMenu */
    return runtimeServices()['step-organization'].openMoveToStepMenu(...arguments);
  }

  function deriveStepFromStars(sourceStepKey) { /* @service step-organization deriveStepFromStars */
    return runtimeServices()['step-organization'].deriveStepFromStars(...arguments);
  }

  let pendingStepTarget = null;
  let stepModalState = null;

  function openStepModal(opts) { /* @service step-organization openStepModal */
    return runtimeServices()['step-organization'].openStepModal(...arguments);
  }

  function closeStepModal() { /* @service step-organization closeStepModal */
    return runtimeServices()['step-organization'].closeStepModal(...arguments);
  }

  /* ---------- 桌面端文件选择：rfd 原生对话框 + /api/local/read 回读 ----------
     WebView2 131 的 IFileOpenDialog 在无边框窗口上必崩（WebView2Feedback #4648），
     桌面端一律绕开 input[type=file] 的 WebView2 对话框管线；浏览器路径保持不变。 */
  async function desktopPickFiles(asFolder, exts) { /* @service file-import desktopPickFiles */
    return runtimeServices()['file-import'].desktopPickFiles(...arguments);
  }
  async function pickImport(asFolder, stepKey) { /* @service file-import pickImport */
    return runtimeServices()['file-import'].pickImport(...arguments);
  }
  async function pickImportMetrics() { /* @service file-import pickImportMetrics */
    return runtimeServices()['file-import'].pickImportMetrics(...arguments);
  }

  function triggerStepImport(stepKey, asFolder) { /* @service file-import triggerStepImport */
    return runtimeServices()['file-import'].triggerStepImport(...arguments);
  }

  async function importDropIntoStep(dt, stepKey) { /* @service file-import importDropIntoStep */
    return runtimeServices()['file-import'].importDropIntoStep(...arguments);
  }

  function openStepMenu(step, anchorEl) { /* @service step-organization openStepMenu */
    return runtimeServices()['step-organization'].openStepMenu(...arguments);
  }

  function attachStepOrganization(rawStep, stepKey, stepEntries) { /* @service step-organization attachStepOrganization */
    return runtimeServices()['step-organization'].attachStepOrganization(...arguments);
  }
  function stepKeyOfNode(node) { /* @service step-organization stepKeyOfNode */
    return runtimeServices()['step-organization'].stepKeyOfNode(...arguments);
  }
  function parentIdForCreate(node) { /* @service step-organization parentIdForCreate */
    return runtimeServices()['step-organization'].parentIdForCreate(...arguments);
  }
  function nodePlaceKeys(node) { /* @service step-organization nodePlaceKeys */
    return runtimeServices()['step-organization'].nodePlaceKeys(...arguments);
  }
  function trashEntries() { /* @service step-organization trashEntries */
    return runtimeServices()['step-organization'].trashEntries(...arguments);
  }
  function updateTrashBadge() { /* @service step-organization updateTrashBadge */
    return runtimeServices()['step-organization'].updateTrashBadge(...arguments);
  }
  function refreshOrgButtons() { /* @service step-organization refreshOrgButtons */
    return runtimeServices()['step-organization'].refreshOrgButtons(...arguments);
  }
  function afterOrgChange(stepKey, message, focusId) { /* @service step-organization afterOrgChange */
    return runtimeServices()['step-organization'].afterOrgChange(...arguments);
  }
  function currentOrgContext() { /* @service step-organization currentOrgContext */
    return runtimeServices()['step-organization'].currentOrgContext(...arguments);
  }
  function promptNewOrgFolder(stepKey, parentId, selectedNodes) { /* @service step-organization promptNewOrgFolder */
    return runtimeServices()['step-organization'].promptNewOrgFolder(...arguments);
  }
  function renameOrgFolder(node) { /* @service step-organization renameOrgFolder */
    return runtimeServices()['step-organization'].renameOrgFolder(...arguments);
  }
  function resetOrgStep(stepKey) { /* @service step-organization resetOrgStep */
    return runtimeServices()['step-organization'].resetOrgStep(...arguments);
  }
  function undoOrg() { /* @service step-organization undoOrg */
    return runtimeServices()['step-organization'].undoOrg(...arguments);
  }
  function redoOrg() { /* @service step-organization redoOrg */
    return runtimeServices()['step-organization'].redoOrg(...arguments);
  }
  function handleOrgPlace(payload) { /* @service step-organization handleOrgPlace */
    return runtimeServices()['step-organization'].handleOrgPlace(...arguments);
  }
  function handleOrgResetLayout(node) { /* @service step-organization handleOrgResetLayout */
    return runtimeServices()['step-organization'].handleOrgResetLayout(...arguments);
  }
  function nodeIsPlaceable(node) { /* @service step-organization nodeIsPlaceable */
    return runtimeServices()['step-organization'].nodeIsPlaceable(...arguments);
  }
  function handleOrgMove(payload) { /* @service step-organization handleOrgMove */
    return runtimeServices()['step-organization'].handleOrgMove(...arguments);
  }
  function captureTrashFolder(node, stepKey) { /* @service step-organization captureTrashFolder */
    return runtimeServices()['step-organization'].captureTrashFolder(...arguments);
  }
  function orgRemoveSelection() { /* @service step-organization orgRemoveSelection */
    return runtimeServices()['step-organization'].orgRemoveSelection(...arguments);
  }
  function animateTrashFlight(cards, done) { /* @service step-organization animateTrashFlight */
    return runtimeServices()['step-organization'].animateTrashFlight(...arguments);
  }
  function openOrgMenu(info) { /* @service step-organization openOrgMenu */
    return runtimeServices()['step-organization'].openOrgMenu(...arguments);
  }

  function handleOverviewStepAction(act, node, anchorEl) { /* @service step-organization handleOverviewStepAction */
    return runtimeServices()['step-organization'].handleOverviewStepAction(...arguments);
  }

  function withPipelineSections(entries) { /* @service overview-controller withPipelineSections */
    return runtimeServices()['overview-controller'].withPipelineSections(...arguments);
  }

  const GROUPED_KEY = 'structboard.overviewGrouped';
  function setOverviewGrouped(on, persist) { /* @service overview-controller setOverviewGrouped */
    return runtimeServices()['overview-controller'].setOverviewGrouped(...arguments);
  }

  function renderOverviewWindow(value) { /* @service overview-controller renderOverviewWindow */
    return runtimeServices()['overview-controller'].renderOverviewWindow(...arguments);
  }
  /* ---------------- 分屏 ----------------
     两栏结构：第 0 栏是页面里原有的 overviewStage（id 不变，单屏时行为与旧版一致）；
     第 1 栏在开启分屏时由第 0 栏克隆而来，所有 id 加 p2- 前缀，$() 按当前栏解析。
     两栏共用 entries/指标/分组等数据，各自持有模式、筛选、层级、滚动与 overview 实例。 */
  function paneStage(index) { /* @service pane-controller paneStage */
    return runtimeServices()['pane-controller'].paneStage(...arguments);
  }
  // 栏内的总览页（overview.js 的 root）
  function paneOverviewStage(index) { /* @service pane-controller paneOverviewStage */
    return runtimeServices()['pane-controller'].paneOverviewStage(...arguments);
  }
  function setActivePane(index, options) { /* @service pane-controller setActivePane */
    return runtimeServices()['pane-controller'].setActivePane(...arguments);
  }
  function syncPaneFocus(refresh) { /* @service pane-controller syncPaneFocus */
    return runtimeServices()['pane-controller'].syncPaneFocus(...arguments);
  }
  function applyAllPaneModes(rebuild) { /* @service pane-controller applyAllPaneModes */
    return runtimeServices()['pane-controller'].applyAllPaneModes(...arguments);
  }
  // 每栏只保留同一组模式按钮；总览与检阅台之间移动节点，保留焦点与委托绑定。
  function ensurePaneModeRow(index) { /* @service pane-controller ensurePaneModeRow */
    return runtimeServices()['pane-controller'].ensurePaneModeRow(...arguments);
  }
  // 每个 stage 一个控制器，原 DOM 与克隆体复用委托和业务命令。
  const paneControlBindings = new WeakMap();
  const PANE_CONTROL_MENUS = ['overviewMoreMenu', 'viewMenu', 'gridLayoutMenu', 'gridAppearanceMenu'];
  const PANE_MENU_BUTTONS = { btnOverviewMore: 'overviewMoreMenu', btnViewMore: 'viewMenu', btnGridMore: 'viewMenu', btnGridLayout: 'gridLayoutMenu', btnGridAppearance: 'gridAppearanceMenu' };
  let panePipelineController = null;
  function paneControlElement(paneOrIndex, id) { /* @service pane-controller paneControlElement */
    return runtimeServices()['pane-controller'].paneControlElement(...arguments);
  }
  function closePaneControlMenus(paneOrIndex, except) { /* @service pane-controller closePaneControlMenus */
    return runtimeServices()['pane-controller'].closePaneControlMenus(...arguments);
  }
  function togglePaneControlMenu(pane, id, anchor) { /* @service pane-controller togglePaneControlMenu */
    return runtimeServices()['pane-controller'].togglePaneControlMenu(...arguments);
  }
  function syncPaneControls(paneOrIndex) { /* @service pane-controller syncPaneControls */
    return runtimeServices()['pane-controller'].syncPaneControls(...arguments);
  }
  function togglePaneGrouping() { /* @service pane-controller togglePaneGrouping */
    return runtimeServices()['pane-controller'].togglePaneGrouping(...arguments);
  }
  const GRID_SHAPE_KEY = 'structboard.grid.shape';
  const GRID_COL_MAX = 8, GRID_ROW_MAX = 4;
  let gridGpuCache = null;
  function clampGridCount(value, max, fallback) { /* @service pane-controller clampGridCount */
    return runtimeServices()['pane-controller'].clampGridCount(...arguments);
  }
  function gpuInfo() { /* @service pane-controller gpuInfo */
    return runtimeServices()['pane-controller'].gpuInfo(...arguments);
  }
  function recommendGrid(paneOrIndex) { /* @service pane-controller recommendGrid */
    return runtimeServices()['pane-controller'].recommendGrid(...arguments);
  }
  function paintGridRecommendation(paneOrIndex) { /* @service pane-controller paintGridRecommendation */
    return runtimeServices()['pane-controller'].paintGridRecommendation(...arguments);
  }
  function applyGridShape(cols, rows, persist, paneOrIndex) { /* @service pane-controller applyGridShape */
    return runtimeServices()['pane-controller'].applyGridShape(...arguments);
  }
  function showAllPaneEntries() { /* @service pane-controller showAllPaneEntries */
    return runtimeServices()['pane-controller'].showAllPaneEntries(...arguments);
  }
  async function resetPaneCameras(paneOrIndex) { /* @service pane-controller resetPaneCameras */
    return runtimeServices()['pane-controller'].resetPaneCameras(...arguments);
  }
  function setPaneSearchOpen(pane, open) { /* @service pane-controller setPaneSearchOpen */
    return runtimeServices()['pane-controller'].setPaneSearchOpen(...arguments);
  }
  function runPaneControl(pane, action, anchor, event) { /* @service pane-controller runPaneControl */
    return runtimeServices()['pane-controller'].runPaneControl(...arguments);
  }
  function bindPaneControls(paneOrIndex) { /* @service pane-controller bindPaneControls */
    return runtimeServices()['pane-controller'].bindPaneControls(...arguments);
  }
  // 每栏 ⋯ 菜单复用业务命令，保留实际点击按钮作为锚点。
  let paneActionsMenu = null;
  function openPaneActions(paneOrIndex, anchor) { /* @service pane-controller openPaneActions */
    return runtimeServices()['pane-controller'].openPaneActions(...arguments);
  }
  // 兼容现有运行态调用点；单栏同样同步，不再生成第二份模式组。
  function syncPaneModeButtons(stage, index) { /* @service pane-controller syncPaneModeButtons */
    return runtimeServices()['pane-controller'].syncPaneModeButtons(...arguments);
  }
  // 把第 0 栏当前状态复制成第 1 栏，保证分屏那一刻两栏看到同样的东西。
  // 复制的是整个 stage（含总览、检阅台、工具栏、相机坞），而不是只复制总览：
  // 否则右侧切到检阅台时，那个全窗唯一的 gridStage 会画在整幅宽度上盖住左栏。
  function clonePaneDom() { /* @service pane-controller clonePaneDom */
    return runtimeServices()['pane-controller'].clonePaneDom(...arguments);
  }
  // 拖动分隔条调整两栏宽度。比例存进 localStorage，下次开分屏还是这个比例。
  const SPLIT_RATIO_KEY = 'structboard.split.ratio';
  function applySplitRatio(ratio) { /* @service pane-controller applySplitRatio */
    return runtimeServices()['pane-controller'].applySplitRatio(...arguments);
  }
  function makeDividerDraggable(divider) { /* @service pane-controller makeDividerDraggable */
    return runtimeServices()['pane-controller'].makeDividerDraggable(...arguments);
  }
  // pointerdown/focusin 只轻切焦点；共享侧栏在手势提交后的下一帧同步。
  function harnessPane(stage, index) { /* @service pane-controller harnessPane */
    return runtimeServices()['pane-controller'].harnessPane(...arguments);
  }
  function activateAndApply(index, text) { /* @service pane-controller activateAndApply */
    return runtimeServices()['pane-controller'].activateAndApply(...arguments);
  }
  function splitOn() { /* @service pane-controller splitOn */
    return runtimeServices()['pane-controller'].splitOn(...arguments);
  }
  function splitOff() { /* @service pane-controller splitOff */
    return runtimeServices()['pane-controller'].splitOff(...arguments);
  }
  function toggleSplit() { /* @service pane-controller toggleSplit */
    return runtimeServices()['pane-controller'].toggleSplit(...arguments);
  }
  // 两处分屏开关（顶栏 btnSplitGlobal 与栏内 btnSplitToggle）状态保持一致。
  function syncSplitButtons() { /* @service pane-controller syncSplitButtons */
    return runtimeServices()['pane-controller'].syncSplitButtons(...arguments);
  }
  function rebuildOverview(value) { /* @service overview-controller rebuildOverview */
    return runtimeServices()['overview-controller'].rebuildOverview(...arguments);
  }
  function rebuildOnePane(value) { /* @service overview-controller rebuildOnePane */
    return runtimeServices()['overview-controller'].rebuildOnePane(...arguments);
  }

  // 层内搜索：只影响总览显示，不写任何持久化数据。
  function applyOverviewSearch(text, value) { /* @service overview-controller applyOverviewSearch */
    return runtimeServices()['overview-controller'].applyOverviewSearch(...arguments);
  }
  function refreshOverviewSearchState(index) { /* @service overview-controller refreshOverviewSearchState */
    return runtimeServices()['overview-controller'].refreshOverviewSearchState(...arguments);
  }

  /* ---------------- 数据 ---------------- */

  function passesMetrics(e) { /* @service structure-data passesMetrics */
    return runtimeServices()['structure-data'].passesMetrics(...arguments);
  }

  function metricValue(e) { /* @service structure-data metricValue */
    return runtimeServices()['structure-data'].metricValue(...arguments);
  }

  function metricText(e) { /* @service structure-data metricText */
    return runtimeServices()['structure-data'].metricText(...arguments);
  }

  function metricColor(e) { /* @service structure-data metricColor */
    return runtimeServices()['structure-data'].metricColor(...arguments);
  }

  function sortByMetric(list) { /* @service structure-data sortByMetric */
    return runtimeServices()['structure-data'].sortByMetric(...arguments);
  }

  function inActiveGroup(e) { /* @service structure-data inActiveGroup */
    return runtimeServices()['structure-data'].inActiveGroup(...arguments);
  }

  function visibleEntries() { /* @service structure-data visibleEntries */
    return runtimeServices()['structure-data'].visibleEntries(...arguments);
  }
  function formatLabel(e) { /* @service structure-data formatLabel */
    return runtimeServices()['structure-data'].formatLabel(...arguments);
  }

  function pipelineCatalogRaw(item, manifest, pipelineId, stepId, stepIndex) { /* @service structure-data pipelineCatalogRaw */
    return runtimeServices()['structure-data'].pipelineCatalogRaw(...arguments);
  }

  function preparePipelineWorkspace(definition, manifests) { /* @service structure-data preparePipelineWorkspace */
    return runtimeServices()['structure-data'].preparePipelineWorkspace(...arguments);
  }

  function hasWorkspaceContent(workspace) { /* @service structure-data hasWorkspaceContent */
    return runtimeServices()['structure-data'].hasWorkspaceContent(...arguments);
  }

  function publishPipelineWorkspace(prepared, ownerPane) { /* @service structure-data publishPipelineWorkspace */
    return runtimeServices()['structure-data'].publishPipelineWorkspace(...arguments);
  }

  function addEntries(rawList, groupName, opts) { /* @service structure-data addEntries */
    return runtimeServices()['structure-data'].addEntries(...arguments);
  }

  function removeEntry(id) { /* @service structure-data removeEntry */
    return runtimeServices()['structure-data'].removeEntry(...arguments);
  }

  /* ---------------- 导入文件夹（批次） ---------------- */

  function defaultImportName() { /* @service structure-data defaultImportName */
    return runtimeServices()['structure-data'].defaultImportName(...arguments);
  }

  function createGroup(name, entryIds, switchTo) { /* @service structure-data createGroup */
    return runtimeServices()['structure-data'].createGroup(...arguments);
  }

  let groupNavFrame = 0;
  let revealActiveGroup = false;
  function updateGroupNavigation() { /* @service sidebar updateGroupNavigation */
    return runtimeServices()['sidebar'].updateGroupNavigation(...arguments);
  }
  function scheduleGroupNavigation(reveal) { /* @service sidebar scheduleGroupNavigation */
    return runtimeServices()['sidebar'].scheduleGroupNavigation(...arguments);
  }
  function bindGroupNavigation() { /* @service sidebar bindGroupNavigation */
    return runtimeServices()['sidebar'].bindGroupNavigation(...arguments);
  }

  let groupView=null;
  function renderGroups() { /* @service sidebar renderGroups */
    return runtimeServices()['sidebar'].renderGroups(...arguments);
  }

  function setActiveGroup(id, opts) { /* @service sidebar setActiveGroup */
    return runtimeServices()['sidebar'].setActiveGroup(...arguments);
  }

  function renameGroup(id) { /* @service sidebar renameGroup */
    return runtimeServices()['sidebar'].renameGroup(...arguments);
  }

  function deleteGroup(id) { /* @service sidebar deleteGroup */
    return runtimeServices()['sidebar'].deleteGroup(...arguments);
  }

  function closeGroupMenu() { /* @service sidebar closeGroupMenu */
    return runtimeServices()['sidebar'].closeGroupMenu(...arguments);
  }

  // 方案 A：ORG 工作台文件夹选择器——把 entryIds 移入某一步的某个工作台文件夹。
  // 注意别和 openGroupMenu（候选分组，S.groups）搞混——那套是科学分组，不是工作台文件夹。
  function openOrgMoveMenu(entryIds, stepKey, anchorRect) { /* @service sidebar openOrgMoveMenu */
    return runtimeServices()['sidebar'].openOrgMoveMenu(...arguments);
  }

  function openGroupMenu(ids, anchorEl) { /* @service sidebar openGroupMenu */
    return runtimeServices()['sidebar'].openGroupMenu(...arguments);
  }

  function moveEntriesToGroup(ids, groupId) { /* @service sidebar moveEntriesToGroup */
    return runtimeServices()['sidebar'].moveEntriesToGroup(...arguments);
  }

  /* ---------------- 列表 UI ---------------- */

  const SIDEBAR_KEY = 'structboard.sidebarCollapsed';
  function notifySidebarResize() { /* @service sidebar notifySidebarResize */
    return runtimeServices()['sidebar'].notifySidebarResize(...arguments);
  }
  function setSidebarCollapsed(collapsed, persist) { /* @service sidebar setSidebarCollapsed */
    return runtimeServices()['sidebar'].setSidebarCollapsed(...arguments);
  }
  function bindSidebar() { /* @service sidebar bindSidebar */
    return runtimeServices()['sidebar'].bindSidebar(...arguments);
  }

  function sequenceBuckets(entries) { /* @service sidebar sequenceBuckets */
    return runtimeServices()['sidebar'].sequenceBuckets(...arguments);
  }
  let sidebarStepView = null, sidebarEntryView = null;
  function renderSidebarSteps(box, steps, plain, scrollTop) { /* @service sidebar renderSidebarSteps */
    return runtimeServices()['sidebar'].renderSidebarSteps(...arguments);
  }
  function releaseSidebarSteps() { /* @service sidebar releaseSidebarSteps */
    return runtimeServices()['sidebar'].releaseSidebarSteps(...arguments);
  }

  function recoverEmptyImportGroup() { /* @service sidebar recoverEmptyImportGroup */
    return runtimeServices()['sidebar'].recoverEmptyImportGroup(...arguments);
  }
  function renderList() { /* @service sidebar renderList */
    return runtimeServices()['sidebar'].renderList(...arguments);
  }
  function sidebarEntryModel(entry) { /* @service sidebar sidebarEntryModel */
    return runtimeServices()['sidebar'].sidebarEntryModel(...arguments);
  }

  function referenceName() { /* @service sidebar referenceName */
    return runtimeServices()['sidebar'].referenceName(...arguments);
  }

  function refreshSharedPaneViews(options) { /* @service pane-controller refreshSharedPaneViews */
    return runtimeServices()['pane-controller'].refreshSharedPaneViews(...arguments);
  }
  function resetSharedPaneViews() { /* @service pane-controller resetSharedPaneViews */
    return runtimeServices()['pane-controller'].resetSharedPaneViews(...arguments);
  }

  function onColorChange(entry, hex) { /* @service structure-data onColorChange */
    return runtimeServices()['structure-data'].onColorChange(...arguments);
  }

  function toggleVisible(entry) { /* @service structure-data toggleVisible */
    return runtimeServices()['structure-data'].toggleVisible(...arguments);
  }

  function setReference(entry, value) { /* @service structure-data setReference */
    return runtimeServices()['structure-data'].setReference(...arguments);
  }

  function refreshBadge() { /* @service pane-controller refreshBadge */
    return runtimeServices()['pane-controller'].refreshBadge(...arguments);
  }

  function updateEmptyState() { /* @service pane-controller updateEmptyState */
    return runtimeServices()['pane-controller'].updateEmptyState(...arguments);
  }

  /* ---------------- 模式 ---------------- */

  function applyModeChange(rebuild, value) { /* @service pane-controller applyModeChange */
    return runtimeServices()['pane-controller'].applyModeChange(...arguments);
  }

  function syncModeThumb() { /* @service pane-controller syncModeThumb */
    return runtimeServices()['pane-controller'].syncModeThumb(...arguments);
  }

  // 方案 A：顶栏只有两个 Tab。grid / overlay 是检阅台内部的两种摆法，都点亮「检阅台」。
  function syncModeTabs() { /* @service pane-controller syncModeTabs */
    return runtimeServices()['pane-controller'].syncModeTabs(...arguments);
  }

  function setMode(mode, opts, value) { /* @service pane-controller setMode */
    return runtimeServices()['pane-controller'].setMode(...arguments);
  }

  function flushAllStepNotes() { /* @service notes flushAllStepNotes */
    return runtimeServices()['notes'].flushAllStepNotes(...arguments);
  }
  // 关窗前尽最后一次努力把便签交给本地服务；本机草稿在每次输入时已经同步写好了。
  window.addEventListener('pagehide', flushAllStepNotes);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushAllStepNotes();
  });

  /* ---------------- 对齐 ---------------- */
  function refreshAlignBtn(value) { /* @service structure-engine refreshAlignBtn */
    return runtimeServices()['structure-engine'].refreshAlignBtn(...arguments);
  }

  function toggleAlign(value) { /* @service structure-engine toggleAlign */
    return runtimeServices()['structure-engine'].toggleAlign(...arguments);
  }

  /* ---------------- 导入 ---------------- */

  async function importFiles(fileList, suggestedName, opts) { /* @service file-import importFiles */
    return runtimeServices()['file-import'].importFiles(...arguments);
  }
  async function importFilesIntoCurrentTab(fileList, suggestedName, opts) { /* @service file-import importFilesIntoCurrentTab */
    return runtimeServices()['file-import'].importFilesIntoCurrentTab(...arguments);
  }

  function traverseEntry(entry, out, depth, failed) { /* @service file-import traverseEntry */
    return runtimeServices()['file-import'].traverseEntry(...arguments);
  }

  async function importDrop(dt) { /* @service file-import importDrop */
    return runtimeServices()['file-import'].importDrop(...arguments);
  }
  function externalDropTarget(element) { /* @service file-import externalDropTarget */
    return runtimeServices()['file-import'].externalDropTarget(...arguments);
  }
  async function collectExternalFiles(dt) { /* @service file-import collectExternalFiles */
    return runtimeServices()['file-import'].collectExternalFiles(...arguments);
  }
  async function importExternalDrop(dt, target) { /* @service file-import importExternalDrop */
    return runtimeServices()['file-import'].importExternalDrop(...arguments);
  }

  /* ---------------- AF3 ZIP 自动解析 ---------------- */

  function buildAf3Plan(zip) { /* @service file-import buildAf3Plan */
    return runtimeServices()['file-import'].buildAf3Plan(...arguments);
  }

  function summaryEntryFor(zip, modelEntry) { /* @service file-import summaryEntryFor */
    return runtimeServices()['file-import'].summaryEntryFor(...arguments);
  }

  async function importZipFiles(zipFiles, opts) { /* @service file-import importZipFiles */
    return runtimeServices()['file-import'].importZipFiles(...arguments);
  }

  function applyMetricsRows(rows) { /* @service file-import applyMetricsRows */
    return runtimeServices()['file-import'].applyMetricsRows(...arguments);
  }

  async function addFromUrl(text) { /* @service file-import addFromUrl */
    return runtimeServices()['file-import'].addFromUrl(...arguments);
  }

  /* ---------------- 指标表 ---------------- */

  const FILTER_OPS = ['>=', '<=', '>', '<', '='];

  function demoMetricsCSV() { /* @service metrics demoMetricsCSV */
    return runtimeServices()['metrics'].demoMetricsCSV(...arguments);
  }

  function loadDemoMetrics() { /* @service metrics loadDemoMetrics */
    return runtimeServices()['metrics'].loadDemoMetrics(...arguments);
  }

  function recomputeMetricRange() { /* @service metrics recomputeMetricRange */
    return runtimeServices()['metrics'].recomputeMetricRange(...arguments);
  }

  let metricsView = null;
  function ensureMetricsView() { /* @service metrics ensureMetricsView */
    return runtimeServices()['metrics'].ensureMetricsView(...arguments);
  }
  function metricPanelModel() { /* @service metrics metricPanelModel */
    return runtimeServices()['metrics'].metricPanelModel(...arguments);
  }
  function refreshMetricsStatus() { /* @service metrics refreshMetricsStatus */
    return runtimeServices()['metrics'].refreshMetricsStatus(...arguments);
  }
  function renderMetricUI() { /* @service metrics renderMetricUI */
    return runtimeServices()['metrics'].renderMetricUI(...arguments);
  }
  function addFilterRow(col,op,value) { /* @service metrics addFilterRow */
    return runtimeServices()['metrics'].addFilterRow(...arguments);
  }
  function readFilters() { /* @service metrics readFilters */
    return runtimeServices()['metrics'].readFilters(...arguments);
  }

  function applyMetrics() { /* @service metrics applyMetrics */
    return runtimeServices()['metrics'].applyMetrics(...arguments);
  }

  function guessPrimary(table) { /* @service metrics guessPrimary */
    return runtimeServices()['metrics'].guessPrimary(...arguments);
  }

  function findCol(names) { /* @service metrics findCol */
    return runtimeServices()['metrics'].findCol(...arguments);
  }

  function presetRf3() { /* @service metrics presetRf3 */
    return runtimeServices()['metrics'].presetRf3(...arguments);
  }

  function clearMetrics() { /* @service metrics clearMetrics */
    return runtimeServices()['metrics'].clearMetrics(...arguments);
  }

  async function importMetrics(fileList) { /* @service metrics importMetrics */
    return runtimeServices()['metrics'].importMetrics(...arguments);
  }

  function exportList() { /* @service metrics exportList */
    return runtimeServices()['metrics'].exportList(...arguments);
  }

  /* ---------------- 截图 ---------------- */

  function saveImage() { /* @service pane-controller saveImage */
    return runtimeServices()['pane-controller'].saveImage(...arguments);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() { /* @service app-bindings bind */
    return runtimeServices()['app-bindings'].bind(...arguments);
  }

  function setAllVisible(v) { /* @service structure-data setAllVisible */
    return runtimeServices()['structure-data'].setAllVisible(...arguments);
  }

  async function loadDemo() { /* @service file-import loadDemo */
    return runtimeServices()['file-import'].loadDemo(...arguments);
  }

  window.addEventListener('error', function (e) {
    S.errors.push(String(e.message));
    console.error('[StructBoard]', e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    S.errors.push(String(e.reason));
    console.error('[StructBoard] unhandled', e.reason);
  });

  /* ---------------- 自测：模拟 AF3 输出文件夹导入（?testaf3=1） ---------------- */

  async function runAf3SelfTest() { /* @service file-import runAf3SelfTest */
    return runtimeServices()['file-import'].runAf3SelfTest(...arguments);
  }

  function helixDemoAtoms(b) { /* @service file-import helixDemoAtoms */
    return runtimeServices()['file-import'].helixDemoAtoms(...arguments);
  }

  function dismissSplashScreen(instant = false) {
    const splash = document.getElementById('appSplashScreen');
    if (!splash || splash.classList.contains('is-hidden')) return;
    if (instant) {
      splash.classList.add('is-hidden');
      setTimeout(() => { splash.style.display = 'none'; }, 500);
      return;
    }
    setTimeout(() => {
      splash.classList.add('is-hidden');
      setTimeout(() => { splash.style.display = 'none'; }, 500);
    }, 350);
  }

  /* ---------------- 动作层（AI / 脚本的唯一入口） ----------------
     只读的 describe + 白名单 act；所有写动作都走已有路径
     （ORG.commit / saveStepNote / saveMarks），天然可撤销、可审计。 */
  function stepExists(key) { /* @service app-operations stepExists */
    return runtimeServices()['app-operations'].stepExists(...arguments);
  }
  function stepEntriesAlive(key) { /* @service app-operations stepEntriesAlive */
    return runtimeServices()['app-operations'].stepEntriesAlive(...arguments);
  }
  // 接受 sourceKey / 稳定 placeId / 步内唯一名称；拒绝运行时 id 与跨步成员。
  function resolveStepKeys(stepKey, list) { /* @service app-operations resolveStepKeys */
    return runtimeServices()['app-operations'].resolveStepKeys(...arguments);
  }
  function orgFolders(stepKey) { /* @service app-operations orgFolders */
    return runtimeServices()['app-operations'].orgFolders(...arguments);
  }
  function folderTreeFor(stepKey, includeNotes) { /* @service app-operations folderTreeFor */
    return runtimeServices()['app-operations'].folderTreeFor(...arguments);
  }
  function describeWorkspace(opts) { /* @service app-operations describeWorkspace */
    return runtimeServices()['app-operations'].describeWorkspace(...arguments);
  }
  function actNoteSet(args) { /* @service app-operations actNoteSet */
    return runtimeServices()['app-operations'].actNoteSet(...arguments);
  }
  function actFolderCreate(args) { /* @service app-operations actFolderCreate */
    return runtimeServices()['app-operations'].actFolderCreate(...arguments);
  }
  function actFolderMove(args) { /* @service app-operations actFolderMove */
    return runtimeServices()['app-operations'].actFolderMove(...arguments);
  }
  function actStarTargets(targets, on) { /* @service app-operations actStarTargets */
    return runtimeServices()['app-operations'].actStarTargets(...arguments);
  }
  function resolvePanel(args) { /* @service app-operations resolvePanel */
    return runtimeServices()['app-operations'].resolvePanel(...arguments);
  }
  function appOperationError(code, message) { /* @service app-operations appOperationError */
    return runtimeServices()['app-operations'].appOperationError(...arguments);
  }
  function captureAppOperationOwner(tool, args) { /* @service app-operations captureAppOperationOwner */
    return runtimeServices()['app-operations'].captureAppOperationOwner(...arguments);
  }
  function checkAppOperationOwner(owner) { /* @service app-operations checkAppOperationOwner */
    return runtimeServices()['app-operations'].checkAppOperationOwner(...arguments);
  }
  function appOperationSnapshot() { /* @service app-operations appOperationSnapshot */
    return runtimeServices()['app-operations'].appOperationSnapshot(...arguments);
  }
  async function openAppOperationView(args, owner, context) { /* @service app-operations openAppOperationView */
    return runtimeServices()['app-operations'].openAppOperationView(...arguments);
  }
  async function readAppOperationPipeline(pid, owner, context) { /* @service app-operations readAppOperationPipeline */
    return runtimeServices()['app-operations'].readAppOperationPipeline(...arguments);
  }
  async function writeAppOperationPipeline(pid, definition, before, owner, context) { /* @service app-operations writeAppOperationPipeline */
    return runtimeServices()['app-operations'].writeAppOperationPipeline(...arguments);
  }
  function appOperationDurability(tool) { /* @service app-operations appOperationDurability */
    return runtimeServices()['app-operations'].appOperationDurability(...arguments);
  }
  function installAppOperations() { /* @service app-operations installAppOperations */
    return runtimeServices()['app-operations'].installAppOperations(...arguments);
  }
  function actStarSet(args) { /* @service app-operations actStarSet */
    return runtimeServices()['app-operations'].actStarSet(...arguments);
  }
  function actFilterByMetric(args) { /* @service app-operations actFilterByMetric */
    return runtimeServices()['app-operations'].actFilterByMetric(...arguments);
  }
  function registerActions() { /* @service app-operations registerActions */
    return runtimeServices()['app-operations'].registerActions(...arguments);
  }

  /* ---------------- AI 生成管线（首页助手） ---------------- */

  const AI_PIPELINE_EXAMPLE = {
    id: 'my_design',
    name: '我的设计流程',
    root: 'D:/data/my-design',
    steps: [
      { id: 's1', title: '输入结构', tool: 'input', globs: ['input/*.pdb'] },
      { id: 's2', title: '预测模型', tool: 'boltz', globs: ['predictions/**/*_model_*.cif'] },
      { id: 's3', title: '最终对照', tool: 'check', globs: ['final/*.cif'] },
    ],
  };
  const AI_PIPELINE_PROMPT = [
    '请帮我生成一个 StructBoard 管线定义 JSON。要求：只输出一个 JSON 对象本身，不要任何解释文字。',
    '',
    'JSON 结构：',
    '{ "id": 短英文标识, "name": 中文流程名, "root": "数据目录绝对路径（用 / 分隔）",',
    '  "steps": [ { "id": "s1", "title": "中文步骤名", "tool": "工具标签(可空)", "globs": ["相对 root 的文件通配符", ...] }, ... ] }',
    '',
    '规则：',
    '1. steps 按处理顺序排列；每一步的 globs 只匹配属于这一步的 .pdb / .cif / .mmcif 等结构文件。',
    '2. 同一物理文件可以出现在多个步骤；不要发明不存在的文件。',
    '3. 如果你不知道我的数据目录或每一步的文件规律，请先向我提问，拿到答案后再生成 JSON。',
    '',
    '示例（请按我的实际情况修改）：',
    JSON.stringify(AI_PIPELINE_EXAMPLE, null, 2),
  ].join('\n');

  // AI 常见输出包裹（```json 围栏、前后解释文字）——剥到纯 JSON 再解析。
  function stripJsonFence(text) { /* @service pipeline-assist stripJsonFence */
    return runtimeServices()['pipeline-assist'].stripJsonFence(...arguments);
  }
  // 仅做导入确认用的形状摘要；权威校验仍由后端 /api/pipeline/import 完成。
  function summarizeDefinitionForConfirm(defn) { /* @service pipeline-assist summarizeDefinitionForConfirm */
    return runtimeServices()['pipeline-assist'].summarizeDefinitionForConfirm(...arguments);
  }
  async function postPipelineDefinition(defn, overwrite) { /* @service pipeline-assist postPipelineDefinition */
    return runtimeServices()['pipeline-assist'].postPipelineDefinition(...arguments);
  }
  let aiAssistLastRaw = '';
  function showAIPipelineError(message, jsonText) { /* @service pipeline-assist showAIPipelineError */
    return runtimeServices()['pipeline-assist'].showAIPipelineError(...arguments);
  }
  function openAIPipelineAssist() { /* @service pipeline-assist openAIPipelineAssist */
    return runtimeServices()['pipeline-assist'].openAIPipelineAssist(...arguments);
  }
  function closeAIPipelineAssist() { /* @service pipeline-assist closeAIPipelineAssist */
    return runtimeServices()['pipeline-assist'].closeAIPipelineAssist(...arguments);
  }
  async function importAIPipelineJson() { /* @service pipeline-assist importAIPipelineJson */
    return runtimeServices()['pipeline-assist'].importAIPipelineJson(...arguments);
  }
  function bindAIPipelineAssist() { /* @service pipeline-assist bindAIPipelineAssist */
    return runtimeServices()['pipeline-assist'].bindAIPipelineAssist(...arguments);
  }

  async function init() {
    if (!window.molstar) {
      note('Mol* 未加载：请确认 vendor/molstar.js 与 index.html 在同一目录', true);
      throw Error('三维显示组件加载失败，请重试。');
    }
    S.customSteps = loadCustomSteps();
    panes[0].runtime.toolbar = window.SB_UI.mountToolbar(document.getElementById('toolbar'), '');
    bind();
    renderPipelineTabs();
    bindAIPipelineAssist();
    registerActions();
    // 紧凑头部是唯一形态：启动时装好、永不拆。单屏与分屏同一套头部
    //（开关/标题/搜索/⋯），不再有「开分屏装、关分屏拆」的残留问题。
    try { ensurePaneModeRow(0); } catch (_) { /* 头部装配失败不阻塞启动 */ }
    requestAnimationFrame(syncModeThumb);
    renderGroups();
    renderList();
    refreshReferenceSelect();
    $('selMaxOverlay').value = String(S.maxOverlay);
    $('btnFollowRef').classList.toggle('active', S.syncCamera);
    refreshAlignBtn();
    renderMetricUI();
    if (loadLastSessionMeta()) S.restoringSession = true;
    updateEmptyState();
    refreshBadge();
    status('就绪 · 点右上「导入」选择文件 / 文件夹，或直接拖进来');
    // Overview/start pages do not need a WebGL viewer; create it only when opened.
    if (window.__SB_STARTUP__) window.__SB_STARTUP__.stage('正在恢复工作区…');
    if (/[?&]autodemo=1/.test(location.search)) loadDemo();
    else if (/[?&]testaf3=1/.test(location.search)) runAf3SelfTest();
    else await restoreLastSession();
    updateEmptyState();
    refreshOrgButtons();
    // 已打开的各条管线都补回便签；本机草稿和显式清空值优先。
    hydrateWorkspaceStepNotes();
    // 上次没写出去的便签立刻重放，不再等下一次编辑。
    if (notesSync.snapshot && Object.keys(notesSync.snapshot()).length) notesSync.flush();
    window.__SB_READY__ = true;
    if (!window.__SB_STARTUP__) dismissSplashScreen(true);
    return true;
  }

  window.__SB_APP_INITIALIZED__ = init().catch(function (error) {
    if (window.__SB_STARTUP__) window.__SB_STARTUP__.fail(error);
    else { dismissSplashScreen(true); note('启动失败：' + (error.message || error), true); }
    return false;
  });
})();
