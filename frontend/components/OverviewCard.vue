<!-- The virtual renderer owns geometry, images and editor values through the
     surface port. Vue owns the stable widget tree and its lifetime. -->
<template>
  <div class="folder-tab" hidden aria-hidden="true"></div>
  <div class="cell-head"><span class="cell-dot"></span><span class="cell-name"></span><span class="cell-meta"></span><div class="cell-actions"><span class="note-dot" hidden></span><button type="button" class="icon-btn star"><span class="st" aria-hidden="true">★</span></button><span class="star-badge" hidden><span aria-hidden="true">★</span></span></div></div>
  <div class="overview-open"><button type="button" class="cell-open-3d" title="打开三维查看" hidden>3D</button><img hidden width="320" height="240" decoding="async" draggable="false" /><span class="overview-placeholder"></span><textarea class="folder-note" hidden rows="4" placeholder="写标记…"></textarea><span class="overview-pos" hidden></span><span class="overview-count" hidden></span><span class="folder-audit" hidden></span><span class="entry-pose" hidden></span></div>
  <button type="button" class="overview-retry" hidden>重试封面</button>
</template>
