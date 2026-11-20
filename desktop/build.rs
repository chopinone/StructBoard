fn main() {
    // 方案 A：把最新 app_icon.ico 编进 exe 资源——资源管理器/桌面快捷方式/固定任务栏显示的
    // 就是它。不设的话 tauri-build 会嵌默认 Tauri logo。
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("../app_icon.ico"),
        ),
    )
    .expect("failed to run tauri-build");
}
