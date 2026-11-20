<template>
  <div class="harness-panel-head"><h2 id="harnessPanelTitle" tabindex="-1">外部助手连接</h2><button id="btnHarnessClose" type="button" class="harness-action">关闭</button></div>
  <p id="harnessDesktopStatus" class="harness-desktop-status"></p>
  <div class="harness-controls"><button id="btnHarnessRefresh" type="button" class="harness-action">刷新状态</button><button id="btnHarnessStop" type="button" class="harness-action harness-danger">全部停止</button></div>
  <p id="harnessError" class="harness-error" role="alert" hidden></p>
  <section id="harnessClientSetup" class="harness-section"><h3>添加到 AI 客户端</h3><p class="harness-muted">选择权限后，为所选客户端保存独立授权并添加配置。已有设置会备份；完成后在客户端刷新 MCP，或重启客户端。</p>
    <fieldset class="harness-scopes"><legend>授权范围</legend><label class="harness-check"><input type="checkbox" id="harnessScopeRead" value="read" checked disabled /><span>读取（必选）</span></label><label class="harness-check"><input type="checkbox" id="harnessScopeView" value="view" /><span>视图</span></label><label class="harness-check"><input type="checkbox" id="harnessScopeEdit" value="edit" /><span>编辑</span></label></fieldset>
    <div class="harness-client-list"></div><p id="harnessClientMessage" class="harness-muted" role="status"></p>
  </section>
  <section class="harness-section" aria-labelledby="harnessSessionsTitle"><h3 id="harnessSessionsTitle">已授权助手</h3><ul id="harnessSessions" class="harness-sessions"></ul><p id="harnessSessionsEmpty" class="harness-muted">暂无已授权助手。</p></section>
  <section class="harness-section" aria-labelledby="harnessPairingTitle"><h3 id="harnessPairingTitle">连接新助手</h3><label class="harness-check"><input type="checkbox" id="harnessRemember" /><span>记住此助手的授权</span></label><p class="harness-muted">配对码 5 分钟内有效、用后即废；仅授予勾选的权限。一键复制的配置粘贴到 ZCode 等 MCP 客户端的 mcpServers 里即可，客户端首次启动会自动完成配对。</p>
    <button id="btnHarnessPair" type="button" class="harness-action harness-primary">生成配对码</button>
    <div id="harnessPairing" class="harness-pairing" hidden><code id="harnessPairingCode" class="harness-pair-code" aria-label="配对码"></code><span id="harnessPairingExpiry" class="harness-muted"></span><div class="harness-copy-row"><button id="btnHarnessCopyConfig" type="button" class="harness-action harness-primary" hidden>一键复制 MCP 配置</button><button id="btnHarnessCopy" type="button" class="harness-action">复制配对码</button></div><p id="harnessPairingMessage" class="harness-muted" role="status"></p></div>
  </section>
  <section class="harness-section" aria-labelledby="harnessRequestsTitle"><h3 id="harnessRequestsTitle">请求与变更确认</h3><ul id="harnessRunning" class="harness-running"></ul><div id="harnessApprovals" class="harness-requests"></div><p id="harnessRequestsEmpty" class="harness-muted">当前没有执行中或待确认的请求。</p></section>
</template>
