// dialogs: explicit application ports; heavyweight data stays outside reactive views.
export function create(ports) {
// SERVICE_FUNCTIONS_BEGIN
  function copyEntryPath(entry) {
    const path = ports.entryPath(entry);
    if (!path) { toast('这个结构没有可用的本机路径', true); return; }
    const copy = (window.__SB_DESKTOP_INVOKE__ ? window.__SB_DESKTOP_INVOKE__('desktop_copy', {text: path}) : navigator.clipboard.writeText(path));
    Promise.resolve(copy).then(function () { toast('已复制完整路径'); }).catch(function () { toast('复制路径失败', true); });
  }
  function openLocalDir(node) {
    const path = node && (node.fullPath || node.path);
    if (!path || !/^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(String(path))) {
      toast('当前浏览器只拿到了相对目录；请用桌面版打开，或先复制路径', true);
      return;
    }
    if (window.__SB_DESKTOP_INVOKE__) {
      window.__SB_DESKTOP_INVOKE__('desktop_open_dir', { path: path }).then(function (message) {
        if (message) toast(message);
      }).catch(function (error) { toast('打开本地目录失败：' + error, true); });
      return;
    }
    const copy = navigator.clipboard && navigator.clipboard.writeText(path);
    Promise.resolve(copy).then(function () { toast('浏览器模式已复制目录路径'); }).catch(function () { toast(path, true); });
  }
  function revealEntry(entry) {
    const path = ports.entryPath(entry);
    if (!path) { toast('这个结构没有可用的本机路径', true); return; }
    if (window.__SB_DESKTOP_INVOKE__) {
      window.__SB_DESKTOP_INVOKE__('desktop_reveal_file', {path: path}).then(function (message) {
        if (message) toast(message);
      }).catch(function (error) { toast('打开文件位置失败：' + error, true); });
    } else {
      copyEntryPath(entry);
      toast('浏览器模式已复制路径；请在资源管理器中粘贴打开', false);
    }
  }
  function renameEntry(entry) {
    if (!entry) return;
    askSheet({
      title: '重命名结构',
      message: '只改界面显示名称，不改磁盘上的文件。',
      value: entry.name,
      ok: '保存',
    }).then(function (name) {
      if (name === null) return;
      const next = String(name || '').trim();
      if (!next || next === entry.name) return;
      const prev = entry.name;
      entry.name = next;
      entry.renamed = true;
      // 兼容旧 name|size 标记；新管线标记按步骤与条目身份隔离。
      try {
        const marks = ports.loadMarks();
        const oldKey = prev + '|' + (entry.size || 0);
        const newKey = next + '|' + (entry.size || 0);
        if (Object.prototype.hasOwnProperty.call(marks, oldKey)) {
          marks[newKey] = marks[oldKey];
          delete marks[oldKey];
          localStorage.setItem(ports.MARKS_KEY, JSON.stringify(marks));
        }
      } catch (_) { /* ignore */ }
      if (!ports.S.restoringSession) ports.scheduleSessionSave();
      ports.renderList();
      ports.refreshReferenceSelect();
      ports.refreshGridHeaders();
      ports.refreshBadge();
      ports.refreshSharedPaneViews();
      toast('已改名为「' + next + '」');
    });
  }
  function openEntryMenu(entry, anchor, colorInput) {
    const m = ports.$('entryMenu');
    m.innerHTML = '';
    const mk = function (label, cls, fn) {
      const b = ports.el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      return b;
    };
    m.appendChild(mk(entry.star ? '取消优选 ★' : '标记为优选 ★', '', function () {
      ports.toggleStar(entry); ports.closeMenus();
    }));
    m.appendChild(mk('重命名…', '', function () { ports.closeMenus(); renameEntry(entry); }));
    m.appendChild(mk('查看完整路径', '', function () { ports.closeMenus();
      const path = ports.entryPath(entry);
      if (!path) { toast('这个结构没有可用的本机路径', true); return; }
      askSheet({ title: '本机文件路径', value: path, readonly: true, ok: '复制', cancel: '关闭' });
    }));
    m.appendChild(mk('复制完整路径', '', function () { ports.closeMenus(); copyEntryPath(entry); }));
    m.appendChild(mk('在文件夹中显示', '', function () { ports.closeMenus(); revealEntry(entry); }));
    m.appendChild(mk('查看序列…', '', function () { ports.closeMenus(); openSeqViewer(entry); }));
    if (ports.S.referenceId !== entry.id) {
      m.appendChild(mk('设为参考', '', function () { ports.setReference(entry); ports.closeMenus(); }));
    }
    m.appendChild(mk('更改颜色…', '', function () {
      ports.closeMenus();
      if (colorInput) colorInput.click();
    }));
    m.appendChild(mk('移入文件夹…', '', function () { ports.closeMenus(); ports.openGroupMenu([entry.id], anchor); }));
    m.appendChild(mk('移入步骤…', '', function () { ports.closeMenus(); ports.openMoveToStepMenu([entry.id], anchor); }));
    m.appendChild(mk('移除此结构', 'danger', function () { ports.removeEntry(entry.id); ports.closeMenus(); }));
    m.hidden = false;
    ports.closeMenus('entryMenu');
    const r = anchor.getBoundingClientRect();
    const mw = 190;
    const mh = m.offsetHeight || 150;
    let x = r.right - mw + 4;
    if (x < 8) x = 8;
    let y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  }
  function plddtClass(b) {
    if (!b || b <= 0) return 'b0';
    for (const [min, cls] of ports.PLDDT_BANDS) {
      if (b >= min) return cls;
    }
    return 'pl4';
  }
  function renderSeqBody() {
    const body = ports.$('seqBody');
    body.innerHTML = '';
    if (!ports.seqCtx) return;
    const s = ports.seqCtx.seqs[ports.seqCtx.chainIdx];
    const perLine = 50;
    const res = s.residues;
    let hasB = false;
    for (const r of res) { if (r.b > 0) { hasB = true; break; } }
    for (let start = 0; start < res.length; start += perLine) {
      const line = ports.el('div', 'seq-line');
      line.appendChild(ports.el('span', 'seq-pos', String(start + 1)));
      const row = ports.el('div', 'seq-res');
      for (let i = start; i < Math.min(start + perLine, res.length); i++) {
        if (i > start && i % 10 === 0) row.appendChild(ports.el('span', 'seq-gap'));
        const aa = ports.el('span', 'seq-aa' + (hasB ? ' ' + plddtClass(res[i].b) : ''), res[i].code);
        aa.title = res[i].seq + ' ' + res[i].name + (res[i].b > 0 ? ' · pLDDT ' + res[i].b.toFixed(1) : '');
        row.appendChild(aa);
      }
      line.appendChild(row);
      body.appendChild(line);
    }
    ports.$('seqLegend').hidden = !hasB;
  }
  function renderSeqChains() {
    const box = ports.$('seqChains');
    box.innerHTML = '';
    if (!ports.seqCtx) return;
    if (ports.seqCtx.seqs.length <= 1) return;
    ports.seqCtx.seqs.forEach(function (s, i) {
      const b = ports.el('button', 'seq-chain-btn' + (i === ports.seqCtx.chainIdx ? ' active' : ''));
      b.innerHTML = '<b>链 ' + s.chain + '</b> · ' + s.length + ' aa';
      b.addEventListener('click', function () {
        ports.seqCtx.chainIdx = i;
        renderSeqChains();
        renderSeqBody();
      });
      box.appendChild(b);
    });
  }
  function openSeqViewer(entry) {
    const seqs = ports.IO.sequences(entry.parsed);
    if (!seqs.length) {
      toast('这个结构解析不出序列（BinaryCIF / 远程结构暂不支持）', true);
      return;
    }
    ports.seqCtx = { entry: entry, seqs: seqs, chainIdx: 0 };
    ports.$('seqName').textContent = entry.name;
    let total = 0;
    for (const s of seqs) total += s.length;
    ports.$('seqSub').textContent = seqs.length + ' 条链 · 共 ' + total + ' 个残基';
    renderSeqChains();
    renderSeqBody();
    ports.$('seqOverlay').hidden = false;
  }
  function closeSeqViewer() {
    ports.$('seqOverlay').hidden = true;
    ports.seqCtx = null;
  }
  function copyText(text, okMsg) {
    const done = function () { toast(okMsg || '已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text); done();
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }
  function toast(msg, isError) {
    const t = ports.$('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 2800);
  }
  let promptHost = null;
  function askSheet(opts) {
    if(!promptHost)promptHost=window.SB_UI.createDialogHost(ports.$('sheetMask'));
    return promptHost.show(opts).then(function(value){if(value!==null&&opts.readonly)copyText(value,'已复制完整路径');return value;});
  }
  function status(msg) { ports.$('statusLeft').textContent = msg; }
  function setLoadProgress(title, percent, detail) {
    const box = ports.$('loadProgress');
    box.hidden = false;
    ports.$('loadProgressTitle').textContent = title || '正在导入';
    ports.$('loadProgressDetail').textContent = detail || '';
    const known = Number.isFinite(percent);
    box.classList.toggle('is-indeterminate', !known);
    ports.$('loadProgressPct').textContent = known ? Math.max(0, Math.min(100, Math.round(percent))) + '%' : '处理中';
    if (known) ports.$('loadProgressBar').style.width = Math.max(0, Math.min(100, percent)) + '%';
    const track = box.querySelector('.load-progress-track');
    track.setAttribute('aria-valuenow', known ? String(Math.round(percent)) : '0');
    track.setAttribute('aria-label', title || '导入进度');
  }
  function hideLoadProgress() {
    const box = ports.$('loadProgress');
    box.hidden = true;
    box.classList.remove('is-indeterminate');
    ports.$('loadProgressBar').style.width = '0%';
  }
  function note(msg, isError) {
    status(msg);
    if (isError) { ports.S.errors.push(msg); toast(msg, true); }
  }
// SERVICE_FUNCTIONS_END
  return { copyEntryPath, openLocalDir, revealEntry, renameEntry, openEntryMenu, plddtClass, renderSeqBody, renderSeqChains, openSeqViewer, closeSeqViewer, copyText, fallbackCopy, toast, askSheet, status, setLoadProgress, hideLoadProgress, note };
}
