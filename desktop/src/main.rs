#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Win10：CSS border-radius 只能圆内容，WebView 底层仍是方角灰底。
// 圆角方案：用 SetWindowRgn 把整个 HWND 裁成圆角矩形，角外不再参与绘制。
// 注意：区域裁剪会关掉 DWM 系统投影——这是「圆角 vs 投影」二选一的根源，用户已拍板要圆角。
#[cfg(target_os = "windows")]
fn apply_window_round_region(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::CreateRoundRectRgn;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: isize, hrgn: isize, redraw: i32) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd_raw = hwnd.0 as isize;
    let hwnd = HWND(hwnd.0);
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        unsafe { SetWindowRgn(hwnd_raw, 0, 1) };
        return;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return;
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    // CreateRoundRectRgn 的宽/高是角椭圆直径；CSS 用 12px 半径 → 直径 24 * DPI
    let diameter = ((12.0 * scale) * 2.0).round().max(2.0) as i32;
    let hrgn = unsafe { CreateRoundRectRgn(0, 0, width, height, diameter, diameter) };
    if hrgn.is_invalid() {
        return;
    }
    unsafe { SetWindowRgn(hwnd_raw, hrgn.0 as isize, 1) };
}

#[cfg(not(target_os = "windows"))]
fn apply_window_round_region(_window: &tauri::WebviewWindow) {}

struct Backend(Mutex<Option<Child>>, AtomicBool);
impl Backend {
    fn stop(&self) {
        self.1.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.0.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) { self.stop(); }
}

struct DesktopConfig {
    api_base: String,
    token: String,
    data_dir: PathBuf,
}

struct DesktopStartup {
    started: Instant,
    data_dir: PathBuf,
    state: Mutex<serde_json::Value>,
}
impl DesktopStartup {
    fn mark(&self, phase: &str) {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(self.data_dir.join("startup.log")) {
            let _ = writeln!(file, "startup phase={} elapsed_ms={}", phase, self.started.elapsed().as_millis());
        }
    }
}

#[tauri::command]
fn desktop_startup_status(window: tauri::WebviewWindow, state: tauri::State<'_, DesktopStartup>) -> Result<serde_json::Value, String> {
    if window.label() != "main" { return Err("Startup belongs to the main window".into()); }
    state.state.lock().map(|value| value.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_startup_mark(window: tauri::WebviewWindow, phase: String, state: tauri::State<'_, DesktopStartup>) -> Result<(), String> {
    if window.label() != "main" { return Ok(()); }
    if !["logo-visible", "scripts-ready", "workspace-ready", "frontend-error"].contains(&phase.as_str()) {
        return Err("Unknown startup phase".into());
    }
    state.mark(&phase);
    Ok(())
}

fn launch_backend(app: &tauri::AppHandle, mut command: Command, token: String, data: PathBuf) -> Result<(), String> {
    let backend = app.state::<Backend>();
    let stdout = {
        let mut slot = backend.0.lock().map_err(|e| e.to_string())?;
        if backend.1.load(Ordering::SeqCst) { return Err("Startup cancelled".into()); }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take();
        *slot = Some(child);
        stdout.ok_or("Missing backend stdout")?
    };
    app.state::<DesktopStartup>().mark("backend-spawned");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let line = rx.recv_timeout(Duration::from_secs(20)).map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if backend.1.load(Ordering::SeqCst) { return Err("Startup cancelled".into()); }
    let info: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let port = info["port"].as_u64().filter(|p| *p > 0 && *p <= 65535).ok_or("Invalid backend port")?;
    let api_base = format!("http://127.0.0.1:{}", port);
    app.manage(DesktopConfig { api_base: api_base.clone(), token: token.clone(), data_dir: data });
    let startup = app.state::<DesktopStartup>();
    *startup.state.lock().map_err(|e| e.to_string())? = serde_json::json!({"state":"ready", "config":{"apiBase":api_base,"token":token}});
    startup.mark("backend-ready");
    Ok(())
}

#[tauri::command]
fn desktop_fullscreen(window: tauri::WebviewWindow, full: bool) -> Result<(), String> {
    window.set_fullscreen(full).map_err(|e| e.to_string())
}

// 自绘标题栏的窗口控制；红绿灯按钮只在桌面端显示，浏览器模式下由 CSS 隐藏。
#[tauri::command]
fn desktop_window(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "maximize" => {
            let maximized = window.is_maximized().map_err(|e| e.to_string())?;
            if maximized {
                window.unmaximize().map_err(|e| e.to_string())?;
                if let (Ok(size), Ok(Some(mon))) = (window.outer_size(), window.current_monitor()) {
                    let msize = mon.size();
                    if size.width >= msize.width.saturating_sub(40) && size.height >= msize.height.saturating_sub(60) {
                        let _ = window.set_size(tauri::LogicalSize::new(1380.0, 880.0));
                        let _ = window.center();
                    }
                }
            } else {
                window.maximize().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "close" => window.close().map_err(|e| e.to_string()),
        _ => Err(format!("未知窗口操作：{action}")),
    }
}

#[tauri::command]
fn desktop_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

// 标题栏拖拽的 JS 直调通道：即使 drag-region 属性处理失效也能移动窗口。
#[tauri::command]
fn desktop_start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

// 捏合要先把 WebView2 的缩放打开，事件才会变成带 Ctrl 的滚轮。
// 页面自己缩放画布，并在整页被放大时把缩放比拉回 1。
#[tauri::command]
fn desktop_reset_zoom(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_zoom(1.0).map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_status(backend: tauri::State<'_, Backend>) -> Result<bool, String> {
    let mut child = backend.0.lock().map_err(|e| e.to_string())?;
    match child.as_mut() {
        Some(process) => process.try_wait().map(|status| status.is_none()).map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

#[tauri::command]
fn desktop_copy(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_open_dir(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("目录路径必须是绝对路径".into());
    }
    let dir = if target.is_dir() {
        target
    } else {
        target.parent().map(|p| p.to_path_buf()).ok_or_else(|| "没有上级目录".to_string())?
    };
    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer.exe")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("目录");
        return Ok(format!("已打开本地目录：{}", name));
    }
    #[cfg(not(target_os = "windows"))]
    { Err("当前平台暂不支持打开本地目录".into()) }
}

#[tauri::command]
fn desktop_reveal_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(path);
    if !file.is_absolute() {
        return Err("文件路径必须是绝对路径".into());
    }
    if !file.is_file() {
        return Err(format!("文件不存在：{}", file.display()));
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(&file)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(format!("已在文件夹中定位：{}", file.file_name().and_then(|n| n.to_str()).unwrap_or("文件")));
    }
    #[cfg(not(target_os = "windows"))]
    { Err("当前平台暂不支持打开文件位置".into()) }
}

// ---------- 本地文件选择（绕开 WebView2 对话框崩溃，WebView2Feedback #4648） ----------

#[derive(serde::Serialize)]
struct PickedPath {
    /// 绝对路径：供前端写入 entry.fullPath（在文件夹中显示 / 打开本地目录）。
    path: String,
    /// 相对路径：文件夹导入时等价于 webkitRelativePath（含顶层目录名）。
    rel_path: String,
}

fn collect_dir_files(root: &std::path::Path, dir: &std::path::Path, depth: u32, out: &mut Vec<PickedPath>) -> Result<(), String> {
    if depth > 12 {
        return Ok(()); // 目录太深按截断处理，避免符号链接环
    }
    if out.len() > 20000 {
        return Err("文件夹内文件超过 20000 个，请分批导入".into());
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("读不了目录 {}：{}", dir.display(), e))?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            subdirs.push(p);
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        out.push(PickedPath { path: p.to_string_lossy().into_owned(), rel_path: rel });
    }
    for sub in subdirs {
        collect_dir_files(root, &sub, depth + 1, out)?;
    }
    Ok(())
}

/// 弹原生文件/文件夹选择框（Rust 进程持有对话框，不经 WebView2）。
/// folder=true 时递归收集整个文件夹，返回 webkitRelativePath 语义的相对路径。
#[tauri::command]
async fn desktop_pick_paths(folder: bool, exts: Vec<String>) -> Result<Vec<PickedPath>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PickedPath>, String> {
        let mut dialog = rfd::FileDialog::new();
        let filters: Vec<String> = exts.into_iter()
            .filter(|e| !e.is_empty())
            .map(|e| e.trim_start_matches('.').to_lowercase())
            .collect();
        if !filters.is_empty() {
            dialog = dialog.add_filter("结构 / 数据文件", &filters.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        }
        if folder {
            let Some(dir) = dialog.set_title("选择要导入的文件夹").pick_folder() else { return Ok(vec![]) };
            let mut out = Vec::new();
            collect_dir_files(&dir, &dir, 0, &mut out)?;
            Ok(out)
        } else {
            let Some(paths) = dialog.set_title("选择要导入的文件").pick_files() else { return Ok(vec![]) };
            Ok(paths.into_iter().map(|p| PickedPath {
                path: p.to_string_lossy().into_owned(),
                rel_path: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            }).collect())
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn desktop_set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    let title = title.chars().take(200).collect::<String>();
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_open_pipeline_window(
    app: tauri::AppHandle,
    workspace_window_key: String,
    title: String,
    snapshot: serde_json::Value,
    tabs: Vec<serde_json::Value>,
    config: tauri::State<'_, DesktopConfig>,
) -> Result<(), String> {
    if workspace_window_key.len() < 8 || workspace_window_key.len() > 96 ||
        !workspace_window_key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("Invalid workspace window key".into());
    }
    let label = format!("pipeline-{}", workspace_window_key);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let mut bootstrap = serde_json::to_vec(&serde_json::json!({"snapshot": snapshot, "tabs": tabs}))
        .map_err(|e| e.to_string())?;
    if bootstrap.len() > 32 * 1024 * 1024 {
        return Err("Pipeline snapshot exceeds the 32 MiB window-transfer limit".into());
    }
    let bootstrap_dir = config.data_dir.join("pipeline-window-bootstrap");
    fs::create_dir_all(&bootstrap_dir).map_err(|e| e.to_string())?;
    let bootstrap_path = bootstrap_dir.join(format!("{}.json", workspace_window_key));
    let temporary = bootstrap_dir.join(format!("{}.{}.tmp", workspace_window_key, std::process::id()));
    {
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bootstrap).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, &bootstrap_path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    bootstrap.clear();
    let api_base = serde_json::to_string(&config.api_base).map_err(|e| e.to_string())?;
    let token = serde_json::to_string(&config.token).map_err(|e| e.to_string())?;
    let workspace_key = serde_json::to_string(&workspace_window_key).map_err(|e| e.to_string())?;
    let bootstrap_tabs = serde_json::to_string(&tabs).map_err(|e| e.to_string())?;
    let active_pipeline = snapshot.get("activePipelineId").and_then(|value| value.as_str()).unwrap_or("");
    let active_pipeline = serde_json::to_string(active_pipeline).map_err(|e| e.to_string())?;
    let init = format!(
        "window.__SB_DESKTOP__={{apiBase:{api_base},token:{token}}};window.__SB_WORKSPACE_WINDOW_KEY__={workspace_key};window.__SB_BOOTSTRAP_TABS__={bootstrap_tabs};window.__SB_BOOTSTRAP_ACTIVE_PIPELINE__={active_pipeline};"
    );
    let win_icon = tauri::image::Image::from_bytes(include_bytes!("../../app_icon.ico"))
        .map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("构境·{}", title.chars().take(180).collect::<String>()))
        .zoom_hotkeys_enabled(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .resizable(true)
        .inner_size(1380.0, 880.0)
        .min_inner_size(940.0, 600.0)
        .initialization_script(&init)
        .data_directory(config.data_dir.join("WebView2").join(&workspace_window_key))
        .disable_drag_drop_handler()
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .icon(win_icon.clone())
        .map_err(|e| e.to_string())?;
    if std::env::var("STRUCTBOARD_DEBUG_PORT").is_ok() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let debug_dir = config.data_dir.join("pipeline-window-bootstrap");
        fs::create_dir_all(&debug_dir).map_err(|e| e.to_string())?;
        fs::write(debug_dir.join(format!("{}.port", workspace_window_key)), port.to_string()).map_err(|e| e.to_string())?;
        builder = builder.additional_browser_args(&format!("--remote-debugging-port={} --remote-allow-origins=*", port));
    }
    let window = builder.build()
        .map_err(|e| e.to_string())?;
    let _ = window.set_resizable(true);
    apply_window_round_region(&window);
    let _ = window.set_icon(win_icon);
    let _ = window.set_focus();
    Ok(())
}

fn main() {
    let started = Instant::now();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(
            tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION
        ).build())
        .invoke_handler(tauri::generate_handler![desktop_fullscreen, desktop_window, desktop_is_maximized, desktop_start_drag, desktop_copy, desktop_reveal_file, desktop_open_dir, desktop_status, desktop_reset_zoom, desktop_pick_paths, desktop_set_window_title, desktop_open_pipeline_window, desktop_startup_status, desktop_startup_mark])
        .setup(move |app| {
            let exe_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
            let backend_dir = std::env::var_os("STRUCTBOARD_BACKEND_DIR")
                .map(PathBuf::from).unwrap_or_else(|| exe_dir.join("backend"));
            let data = std::env::var_os("STRUCTBOARD_DATA_DIR")
                .map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            fs::create_dir_all(&data)?;
            let mut startup_log = fs::OpenOptions::new().create(true).append(true).open(data.join("startup.log"))?;
            let _ = writeln!(startup_log, "startup exe={} data={}", exe_dir.display(), data.display());
            app.manage(Backend(Mutex::new(None), AtomicBool::new(false)));
            app.manage(DesktopStartup { started, data_dir: data.clone(), state: Mutex::new(serde_json::json!({"state":"loading"})) });
            app.state::<DesktopStartup>().mark("setup");
            let pipelines = data.join("pipelines");
            fs::create_dir_all(&pipelines)?;
            // Seed without replacing existing user definitions, including those from the old install.
            // Demonstration data is generated independently in the backend.
            // Existing user pipeline definitions remain in AppData untouched.
            let mut random = [0u8; 32];
            getrandom::fill(&mut random).map_err(|e| e.to_string())?;
            let token = random.iter().map(|x| format!("{x:02x}")).collect::<String>();
            let log = fs::OpenOptions::new().create(true).append(true).open(data.join("backend.log"))?;
            let backend_exe = backend_dir.join("StructBoardBackend.exe");
            let _ = writeln!(startup_log, "backend={} exists={}", backend_exe.display(), backend_exe.is_file());
            let mut command = Command::new(&backend_exe);
            command.env("STRUCTBOARD_API_TOKEN", &token)
                .env("STRUCTBOARD_PIPE_DIR", &pipelines)
                .env("STRUCTBOARD_DATA_DIR", &data)
                .env("STRUCTBOARD_HARNESS_DISCOVERY", data.join("harness.json"))
                .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::from(log));
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            // Backend startup and WebView creation overlap; the event loop never waits for stdout.
            let backend_app = app.handle().clone();
            let backend_data = data.clone();
            std::thread::spawn(move || {
                if let Err(error) = launch_backend(&backend_app, command, token, backend_data) {
                    let backend = backend_app.state::<Backend>();
                    if !backend.1.load(Ordering::SeqCst) {
                        let startup = backend_app.state::<DesktopStartup>();
                        startup.mark("backend-error");
                        if let Ok(mut log) = fs::OpenOptions::new().append(true).open(startup.data_dir.join("startup.log")) {
                            let _ = writeln!(log, "backend startup failed: {}", error);
                        }
                        if let Ok(mut state) = startup.state.lock() { *state = serde_json::json!({"state":"error"}); };
                    }
                    backend.stop();
                }
            });
            let storage: serde_json::Value = fs::read_to_string(data.join("legacy-storage.json"))
                .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
            let storage = serde_json::to_string(&storage)?;
            let init = format!("window.__SB_NATIVE_STARTUP__=true;window.__SB_WORKSPACE_WINDOW_KEY__='main';\nif(!localStorage.getItem('structboard.desktopMigrated')){{const old={storage};for(const [k,v] of Object.entries(old)){{if(k.startsWith('structboard.')&&typeof v==='string'&&localStorage.getItem(k)===null)localStorage.setItem(k,v)}}localStorage.setItem('structboard.desktopMigrated','1')}}");
            // background_color(0,0,0,0)：Win10 WebView2 默认清屏色是黑，透明圆角外若不设会露黑角（内圆外方）
            // 运行时窗口图标：任务栏/Alt+Tab 显示的。include_bytes 直接嵌最新 app_icon.ico。
            let win_icon = tauri::image::Image::from_bytes(include_bytes!("../../app_icon.ico"))
                .expect("app_icon.ico 无效");
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("构境·StructBoard")
                // 默认关闭时，触控板捏合和 Ctrl+滚轮都到不了页面。打开后由页面 preventDefault，避免整窗被放大。
                .zoom_hotkeys_enabled(true)
                .decorations(false)
                // 用户拍板：圆角优先、无投影。Win10 上系统投影(DWM)与 SetWindowRgn 自绘圆角互斥，
                // 只能二选一；透明窗口 + body 圆角裁剪实现圆角，任何 CSS 假阴影都会贴边形成一圈
                // 「外框」，所以阴影一个都不画。
                .transparent(true)
                .shadow(false)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .resizable(true)
                .inner_size(1380.0, 880.0).min_inner_size(940.0, 600.0)
                .initialization_script(&init)
                .data_directory(data.join("WebView2"))
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
                });
            // 在原生窗口显示前设置图标，避免任务栏先出现默认图标、页面加载后才换图标。
            builder = builder.icon(win_icon.clone()).map_err(|e| {
                let _ = writeln!(startup_log, "window icon setup failed: {}", e);
                e
            })?;
            // Diagnostics are opt-in for an isolated validation process, never enabled by default.
            if let Ok(port) = std::env::var("STRUCTBOARD_DEBUG_PORT") {
                if port.parse::<u16>().is_ok() {
                    builder = builder.additional_browser_args(&format!("--remote-debugging-port={port} --remote-allow-origins=*"));
                }
            }
            let win = builder.build().map_err(|e| {
                let _ = writeln!(startup_log, "webview build failed: {}", e);
                e
            })?;
            let _ = win.set_resizable(true);
            if win.is_maximized().unwrap_or(false) {
                let _ = win.unmaximize();
            }
            if let (Ok(size), Ok(pos), Ok(Some(mon))) = (win.outer_size(), win.outer_position(), win.current_monitor()) {
                let msize = mon.size();
                if (size.width >= msize.width.saturating_sub(40) && size.height >= msize.height.saturating_sub(60))
                    || pos.x < -20 || pos.y < -20
                {
                    let _ = win.set_size(tauri::LogicalSize::new(1380.0, 880.0));
                    let _ = win.center();
                }
            }
            apply_window_round_region(&win);
            let _ = win.set_icon(win_icon);
            let _ = writeln!(startup_log, "webview built");
            app.state::<DesktopStartup>().mark("window-built");
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    if window.app_handle().webview_windows().len() <= 1 {
                        if let Some(backend) = window.app_handle().try_state::<Backend>() { backend.stop(); }
                        window.app_handle().exit(0);
                    }
                }
                tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                        apply_window_round_region(&win);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("StructBoard desktop could not start");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(backend) = app.try_state::<Backend>() { backend.stop(); }
        }
    });
}
