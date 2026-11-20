<!-- Mol* exclusively owns .cell-viewer; the surface port synchronizes the
     surrounding controls without putting viewers/coordinates in reactive state. -->
<template>
  <div class="folder-tab" hidden aria-hidden="true"></div>
  <div class="cell-head"><span class="cell-dot"></span><span class="cell-name"></span><span class="spacer"></span><span class="tag master" hidden>主控</span><span class="cell-meta"></span><div class="cell-actions"><button type="button" class="icon-btn star cell-star"><span class="st" aria-hidden="true">★</span></button><button type="button" class="icon-btn more cell-settings" title="结构设置（重命名 / 序列 / 参考 / 颜色 / 移动 / 删除）" aria-haspopup="menu">⋯</button><input type="color" class="sr-color" tabindex="-1" aria-label="结构颜色" /><span class="star-badge" hidden>★</span></div></div>
  <div class="cell-body"><div class="cell-viewer" data-grid="1"></div><textarea class="folder-note" hidden placeholder="写标记…"></textarea><button type="button" class="grid-folder-open" hidden><span class="grid-folder-label"></span></button><span class="grid-position" hidden></span><span class="grid-audit" hidden></span><span class="grid-load-message" hidden></span></div>
</template>
