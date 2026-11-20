/* Paint the existing logo before waiting for local services or loading the 3D runtime. */
(function () {
  'use strict';
  const splash = document.getElementById('appSplashScreen');
  const label = document.getElementById('startupStatus');
  const close = document.getElementById('startupClose');
  const reload = document.getElementById('startupRetry');
  const native = !!window.__SB_NATIVE_STARTUP__;
  const timings = window.__SB_STARTUP_TIMINGS__ = { started: performance.now() };
  let failed = false, stopped = false, watchdog = 0;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  function mark(phase) {
    timings[phase] = performance.now();
    if (native) void invoke('desktop_startup_mark', { phase }).catch(() => {});
  }
  function stage(text) {
    if (!failed && label) label.textContent = text;
  }
  function fail(error) {
    if (failed || stopped) return;
    failed = true;
    clearTimeout(watchdog);
    if (splash) { splash.classList.remove('is-hidden'); splash.classList.add('is-error'); }
    if (label) label.textContent = String(error && error.message || error || '启动未完成，请重试。');
    if (reload) reload.hidden = !!(error && error.restartRequired);
    mark('frontend-error');
  }
  async function backendReady() {
    if (!native) return;
    const deadline = performance.now() + 25000;
    while (!stopped && performance.now() < deadline) {
      const result = await Promise.race([
        invoke('desktop_startup_status'),
        wait(3000).then(() => { throw Error('启动暂时没有响应，请关闭后重新打开。'); }),
      ]);
      if (result.state === 'error') {
        const error = Error('本地服务未能启动，请关闭后重新打开构境。');
        error.restartRequired = true;
        throw error;
      }
      if (result.state === 'ready' && result.config) {
        window.__SB_DESKTOP__ = result.config;
        return;
      }
      await wait(80);
    }
    throw Error('启动等待超时，请关闭后重新打开构境。');
  }
  async function loadScripts() {
    for (const placeholder of document.querySelectorAll('script[type="application/x-structboard-script"][src]')) {
      if (stopped || failed) return;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.async = false;
        const timeout = setTimeout(() => reject(Error('界面加载超时，请重试。')), 20000);
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); reject(Error('界面文件加载失败，请重试。')); };
        script.src = placeholder.src;
        document.body.appendChild(script);
      });
    }
  }
  window.__SB_STARTUP__ = { stage, fail };
  if (close) {
    close.hidden = !(native || window.__SB_DESKTOP__);
    close.addEventListener('click', () => {
      stopped = true; clearTimeout(watchdog);
      void invoke('desktop_window', { action: 'close' }).catch(() => { stopped = false; fail('无法关闭窗口，请使用 Alt+F4。'); });
    });
  }
  if (reload) reload.addEventListener('click', () => location.reload());
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(watchdog); }, { once: true });
  window.__SB_STARTUP_DONE__ = (async function () {
    try {
      // Two frames guarantee that the logo gets a paint opportunity before heavy scripts.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      mark('logo-visible');
      stage('正在打开构境…');
      await backendReady();
      if (stopped) return false;
      stage('正在准备界面…');
      watchdog = setTimeout(() => stage('仍在恢复工作区，请稍候…'), 8000);
      await loadScripts();
      if (failed || stopped) return false;
      mark('scripts-ready');
      if (!window.__SB_APP_INITIALIZED__) throw Error('界面未能初始化，请重试。');
      const result = await window.__SB_APP_INITIALIZED__;
      if (!result || failed || stopped) return false;
      clearTimeout(watchdog);
      mark('workspace-ready');
      if (splash) {
        splash.classList.add('is-hidden');
        setTimeout(() => { splash.hidden = true; }, 200);
      }
      return true;
    } catch (error) { fail(error); return false; }
  })();
})();
