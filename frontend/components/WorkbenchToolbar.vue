<script setup>defineProps({prefix:{type:String,default:''}});</script>
<template>

        <div class="bench-context">
          <button class="icon-btn grid-back" :id="prefix+'btnGridBack'" type="button" title="返回总览当前位置（Esc）" hidden aria-label="返回总览">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H5.2"/><path d="M9.2 5.1 4.2 10l5 4.9"/></svg>
          </button>
          <div class="pane-mode-slot"></div>
        </div>
        <div class="tool-group bench-toggle" :id="prefix+'benchToggle'" hidden role="group" aria-label="检阅台摆法">
          <button class="mini-btn" :id="prefix+'benchSide'" type="button" aria-pressed="true" title="每个结构一个视窗并排摆开">并排</button>
          <button class="mini-btn" :id="prefix+'benchOverlay'" type="button" aria-pressed="false" title="所有结构叠进同一个视窗看偏差">叠加</button>
        </div>
        <div class="menu-anchor appearance-anchor">
          <button class="mini-btn bench-menu-button" :id="prefix+'btnGridAppearance'" type="button" aria-label="外观设置" aria-haspopup="true" aria-expanded="false" :aria-controls="prefix+'gridAppearanceMenu'">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.4"/><path d="M10 3.6v12.8M3.6 10h12.8"/></svg>
            <span>外观</span>
          </button>
          <div class="menu appearance-menu" :id="prefix+'gridAppearanceMenu'" hidden>
            <label class="tool-group appearance-group">
              <span class="tool-label">配色</span>
              <select :id="prefix+'selTheme'" aria-label="配色方案">
                <option value="per-structure">按结构</option>
                <option value="chain-id">按链</option>
                <option value="secondary-structure">二级结构</option>
                <option value="uncertainty">B 因子 / pLDDT</option>
                <option value="element-symbol">元素</option>
                <option value="by-metric">按主指标</option>
              </select>
            </label>
            <label class="tool-group appearance-group">
              <span class="tool-label">表示</span>
              <select :id="prefix+'selRepr'" aria-label="表示方式">
                <option value="cartoon">Cartoon</option>
                <option value="molecular-surface">+ 分子表面</option>
                <option value="ball-and-stick">+ 球棍</option>
                <option value="spacefill">+ 空间填充</option>
              </select>
            </label>
          </div>
        </div>
        <div class="tool-group layout-anchor menu-anchor" :id="prefix+'gridTools'" hidden>
          <button class="mini-btn bench-menu-button" :id="prefix+'btnGridLayout'" type="button" aria-label="网格布局" aria-haspopup="true" aria-expanded="false" :aria-controls="prefix+'gridLayoutMenu'" title="调整检阅台行列数">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1"/></svg>
            <span class="grid-layout-label">2 × 2</span>
          </button>
          <div class="menu menu-right grid-layout-menu" :id="prefix+'gridLayoutMenu'" hidden>
            <div class="menu-heading">网格布局</div>
            <div class="layout-fields">
              <label><span>列数</span><select :id="prefix+'selCols'" aria-label="网格列数">
                <option value="1">1 列</option>
                <option value="2">2 列</option>
                <option value="3">3 列</option>
                <option value="4">4 列</option>
                <option value="5">5 列</option>
                <option value="6">6 列</option>
                <option value="7">7 列</option>
                <option value="8">8 列</option>
              </select></label>
              <label><span>行数</span><select :id="prefix+'selRows'" aria-label="网格行数">
                <option value="1">1 行</option>
                <option value="2" selected>2 行</option>
                <option value="3">3 行</option>
                <option value="4">4 行</option>
              </select></label>
            </div>
            <button class="grid-rec" :id="prefix+'btnGridRec'" type="button">推荐布局</button>
            <p class="menu-hint">按本栏空间推荐，同时显示的视窗越多，资源占用越高。</p>
          </div>
        </div>
        <span class="bench-spacer" aria-hidden="true"></span>
        <div class="bench-actions" role="group" aria-label="对齐、排列与视角操作">
          <button class="mini-btn bench-action" :id="prefix+'btnAlign'" aria-label="对齐到参考" type="button" aria-pressed="false" title="对齐到参考 · 按参考结构对齐坐标，再点一次还原">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5"/><path d="M10 2.5v4m0 7v4M2.5 10h4m7 0h4"/></svg>
            <span class="bench-action-label">对齐</span>
          </button>
          <button class="mini-btn bench-action" :id="prefix+'btnFollowRef'" aria-label="实时联动" type="button" aria-pressed="true" title="实时联动 · 开启后，转动或缩放任一视窗，其余视窗实时跟随">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8.5 11.5 3-3M7.5 12.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0m3 1 1-1a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0" transform="translate(0 1)"/></svg>
            <span class="bench-action-label">联动</span>
          </button>
          <div class="bench-arrangement" role="group" aria-label="结构排列方式" hidden title="调整当前页的排列，保留比较范围与视角">
            <button class="mini-btn" :id="prefix+'btnGridByCandidate'" type="button" aria-pressed="true"><span data-arrangement-label>按候选排列</span></button>
            <button class="mini-btn" :id="prefix+'btnGridFlat'" type="button" aria-pressed="false">平铺排列</button>
          </div>
          <button class="mini-btn bench-action" :id="prefix+'btnResetCam'" aria-label="重置视角" type="button" title="重置视角 · 把视窗恢复到默认视角">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 10V6.5M4 10h3.5"/></svg>
            <span class="bench-action-label">重置</span>
          </button>
          <button class="mini-btn bench-action" :id="prefix+'btnSyncCam'" aria-label="统一到参考视角" type="button" title="统一到参考视角 · 将当前视窗一次性统一到参考视角">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="6" height="5" rx="1"/><rect x="11.5" y="11" width="6" height="5" rx="1"/><path d="M11 6.5h4.5V9m-2-2 2 2 2-2M5 11v2.5h4"/></svg>
            <span class="bench-action-label">参考视角</span>
          </button>
          <button class="mini-btn bench-action" :id="prefix+'btnShot'" aria-label="保存图片" type="button" title="保存图片 · 保存当前检阅台的图片">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h3.5l1.2-2h4.6l1.2 2H17a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><circle cx="10" cy="11" r="2.5"/></svg>
            <span class="bench-action-label">截图</span>
          </button>
        </div>
        <div class="cam-dock toolbar-more" :id="prefix+'camDock'" hidden>
          <div class="menu-anchor">
            <button class="icon-btn" :id="prefix+'btnViewMore'" type="button" title="更多视图选项" aria-label="更多视图选项" aria-haspopup="true" aria-expanded="false" :aria-controls="prefix+'viewMenu'">
              <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.2" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="15.8" cy="10" r="1.2"/></svg>
            </button>
            <div class="menu menu-right bench-more-menu" :id="prefix+'viewMenu'" hidden>
              <div class="menu-heading">检阅台</div>
              <div class="compact-bench-modes">
                <button class="menu-item" type="button" data-action="benchSide" aria-pressed="true">并排查看</button>
                <button class="menu-item" type="button" data-action="benchOverlay" aria-pressed="false">叠加查看</button>
                <div class="menu-sep"></div>
              </div>
              <button class="menu-item" data-action="btnAlign" type="button" aria-pressed="false" title="对齐到参考 · 按参考结构对齐坐标，再点一次还原">
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5"/><path d="M10 2.5v4m0 7v4M2.5 10h4m7 0h4"/></svg>
                <span>对齐到参考</span>
              </button>
              <button class="menu-item" data-action="btnFollowRef" type="button" aria-pressed="true" title="实时联动 · 开启后，转动或缩放任一视窗，其余视窗实时跟随">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8.5 11.5 3-3M7.5 12.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0m3 1 1-1a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0" transform="translate(0 1)"/></svg>
                <span>实时联动</span>
              </button>
              <button class="menu-item" data-action="btnGridByCandidate" data-arrangement-option type="button" aria-pressed="true" hidden><span data-arrangement-label>按候选排列</span></button>
              <button class="menu-item" data-action="btnGridFlat" data-arrangement-option type="button" aria-pressed="false" hidden>平铺排列</button>
              <div class="menu-sep"></div>
              <button class="menu-item" data-action="btnResetCam" type="button" title="重置视角 · 把视窗恢复到默认视角">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 10V6.5M4 10h3.5"/></svg>
                <span>重置视角</span>
              </button>
              <button class="menu-item" data-action="btnSyncCam" type="button" title="统一到参考视角 · 将当前视窗一次性统一到参考视角">
                <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="6" height="5" rx="1"/><rect x="11.5" y="11" width="6" height="5" rx="1"/><path d="M11 6.5h4.5V9m-2-2 2 2 2-2M5 11v2.5h4"/></svg>
                <span>统一到参考视角</span>
              </button>
              <button class="menu-item" data-action="btnShot" type="button" title="保存图片 · 保存当前检阅台的图片">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h3.5l1.2-2h4.6l1.2 2H17a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><circle cx="10" cy="11" r="2.5"/></svg>
                <span>保存图片</span>
              </button>
              <div class="menu-row" :id="prefix+'overlayTools'">
                <label for="selMaxOverlay">叠加载入上限</label>
                <select :id="prefix+'selMaxOverlay'" aria-label="叠加视图最多载入的结构数">
                  <option value="10">10 个</option>
                  <option value="20">20 个</option>
                  <option value="50">50 个</option>
                  <option value="0">全部</option>
                </select>
              </div>
            </div>
          </div>
        </div>

</template>
