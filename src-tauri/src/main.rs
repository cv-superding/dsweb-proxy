//! dsweb-proxy 桌面壳：
//!  - 启动时把 Node sidecar（dsweb-proxy-node）作为子进程拉起（OpenAI 兼容服务）
//!  - 主窗口：控制台（登录状态 / 服务地址 / 登录按钮）
//!  - 托盘：左键显示窗口，菜单提供 显示窗口 / 登录 / 退出；关闭窗口 = 隐藏到托盘
//!  - 退出时杀掉 sidecar
//!
//! 为什么 sidecar 而不是把 Node 逻辑移植进 Rust：核心 6500 行（PoW/SSE/工具协议）
//! 已在 Node 侧验证通过，稳定压倒重写；Node 以 SEA 单文件 exe 打进安装包。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct SidecarChild(Mutex<Option<CommandChild>>);

impl Drop for SidecarChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
        }
    }
}

/// 解析 proxy.json 路径（与 Node 侧 core/paths.ts 的解析顺序保持一致）。
fn proxy_config_path() -> PathBuf {
    if let Ok(home) = std::env::var("DSWEB_PROXY_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join("proxy.json");
        }
    }
    if let Ok(dsh) = std::env::var("DSH_HOME") {
        if !dsh.is_empty() {
            return PathBuf::from(dsh).join("web-login").join("proxy.json");
        }
    }
    let user = std::env::var("USERPROFILE").unwrap_or_else(|_| String::from("C:"));
    PathBuf::from(user).join(".dsh").join("web-login").join("proxy.json")
}

/// 读 (enabled, port)。缺文件 / 坏 JSON 一律按「启用 + 8787」——宁可多起一次服务，
/// 也不要因为一个手改坏的配置文件让反代静默不启动。
/// 把 `enabled` 写回 proxy.json（其余字段原样保留）。
fn set_config_enabled(enabled: bool) {
    let path = proxy_config_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}));
    json["enabled"] = serde_json::Value::Bool(enabled);
    if let Ok(pretty) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(&path, pretty);
    }
}

/// 读窗口尺寸（proxy.json 的 windowWidth/windowHeight）。缺省 900x700；
/// 手改配置越界时回落默认，别让一个坏数字把窗口变成 1px。
fn read_window_config() -> (f64, f64) {
    let path = proxy_config_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (900.0, 700.0),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return (900.0, 700.0),
    };
    let clamp = |v: f64, lo: f64, hi: f64, dft: f64| {
        if v.is_finite() && v >= lo && v <= hi { v } else { dft }
    };
    let w = json.get("windowWidth").and_then(|v| v.as_f64()).unwrap_or(900.0);
    let h = json.get("windowHeight").and_then(|v| v.as_f64()).unwrap_or(700.0);
    (clamp(w, 400.0, 3000.0, 900.0), clamp(h, 400.0, 2400.0, 700.0))
}

/// 把窗口尺寸写回 proxy.json（其余字段原样保留）。
fn set_config_window_size(width: f64, height: f64) {
    let path = proxy_config_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}));
    json["windowWidth"] = serde_json::Value::from(width);
    json["windowHeight"] = serde_json::Value::from(height);
    if let Ok(pretty) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(&path, pretty);
    }
}

fn read_config() -> (bool, u16) {
    let path = proxy_config_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (true, 8787),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return (true, 8787),
    };
    let enabled = json.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let port = json
        .get("port")
        .and_then(|v| v.as_u64())
        .filter(|p| *p >= 1024 && *p <= 65535)
        .unwrap_or(8787) as u16;
    (enabled, port)
}

#[tauri::command]
fn proxy_status(state: State<SidecarChild>) -> String {
    let running = state.0.lock().map(|g| g.is_some()).unwrap_or(false);
    serde_json::json!({ "sidecarRunning": running }).to_string()
}

/// 在 sidecar 里跑 `login` 子命令：拉起系统浏览器窗口（CDP 捕获），完成后自动退出。
#[tauri::command]
fn open_login(app: AppHandle, state: State<SidecarChild>) -> String {
    let shell = app.shell();
    let sidecar_running = state.0.lock().map(|g| g.is_some()).unwrap_or(false);
    if !sidecar_running {
        return r#"{"ok":false,"message":"服务未运行（sidecar 未启动）"}"#.into();
    }
    match shell.sidecar("dsweb-proxy-node") {
        Ok(cmd) => match cmd.args(["login"]).spawn() {
            // tauri v2 shell spawn 返回 (Receiver<CommandEvent>, CommandChild)
            Ok((mut events, _child)) => {
                tauri::async_runtime::spawn(async move {
                    while let Some(_ev) = events.recv().await {}
                });
                r#"{"ok":true,"message":"已拉起浏览器登录窗口，请在窗口中完成登录（完成后本窗口自动关闭）"}"#
                    .into()
            }
            Err(e) => format!(r#"{{"ok":false,"message":"拉起失败：{}"}}"#, e),
        },
        Err(e) => format!(r#"{{"ok":false,"message":"sidecar 不可用：{}"}}"#, e),
    }
}

fn spawn_serve(app: &AppHandle, state: &State<SidecarChild>) -> Result<(), String> {
    let (enabled, port) = read_config();
    if !enabled {
        println!("[dsweb-proxy] 配置里「启动反代」为关，跳过 sidecar 启动");
        return Ok(());
    }
    // 防呆：该端口已有服务在跑（比如用户手动开过 CLI serve）就不重复拉，
    // 也不覆盖 SidecarChild —— 退出时那个外部进程不受影响。
    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        println!("[dsweb-proxy] {} 端口已有服务在运行，跳过 sidecar 启动", port);
        return Ok(());
    }
    let shell = app.shell();
    let cmd = shell
        .sidecar("dsweb-proxy-node")
        .map_err(|e| format!("sidecar 定位失败：{}", e))?
        .args(["serve"]);
    let (_rx, child) = cmd
        .spawn()
        .map_err(|e| format!("sidecar 启动失败：{}", e))?;
    *state
        .0
        .lock()
        .map_err(|_| "锁 poisoned".to_string())? = Some(child);
    Ok(())
}

/// 当前窗口尺寸（控制台设置卡回显用）。
#[tauri::command]
fn get_window_config() -> String {
    let (width, height) = read_window_config();
    serde_json::json!({ "width": width, "height": height }).to_string()
}

/// 设置窗口尺寸：立即 resize 主窗口，并落盘为下次打开的默认尺寸。
#[tauri::command]
fn set_window_size(app: AppHandle, width: f64, height: f64) -> String {
    let clamp = |v: f64, lo: f64, hi: f64| if v.is_finite() && v >= lo && v <= hi { v } else { 0.0 };
    let (w, h) = (clamp(width, 400.0, 3000.0), clamp(height, 400.0, 2400.0));
    if w == 0.0 || h == 0.0 {
        return serde_json::json!({ "ok": false, "message": "宽高需在 400~3000 / 400~2400 之间" }).to_string();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
    }
    set_config_window_size(w, h);
    serde_json::json!({ "ok": true, "width": w, "height": h }).to_string()
}

/// 开启服务：立即拉起 sidecar，并把「启动反代」落盘为开（下次启动也自动运行）。
#[tauri::command]
fn start_service(app: AppHandle, state: State<SidecarChild>) -> String {
    set_config_enabled(true);
    match spawn_serve(&app, &state) {
        Ok(()) => {
            let (_, port) = read_config();
            serde_json::json!({ "ok": true, "port": port }).to_string()
        }
        Err(e) => serde_json::json!({ "ok": false, "message": e }).to_string(),
    }
}

/// 停止服务：杀掉 sidecar，并把「启动反代」落盘为关（下次启动不再自动运行）。
#[tauri::command]
fn stop_service(state: State<SidecarChild>) -> String {
    set_config_enabled(false);
    if let Some(child) = state.0.lock().ok().and_then(|mut g| g.take()) {
        let _ = child.kill();
    }
    serde_json::json!({ "ok": true, "stopped": true }).to_string()
}

/// 重启服务：杀掉当前 sidecar 再按**磁盘上的最新配置**拉起。
/// 控制台改完端口/开关后点「重启服务」走这里（端口变更无法热生效 —— 需要重新 listen）。
#[tauri::command]
fn restart_service(app: AppHandle, state: State<SidecarChild>) -> String {
    if let Some(child) = state.0.lock().ok().and_then(|mut g| g.take()) {
        let _ = child.kill();
    }
    // 给旧进程一点时间释放端口（Windows 上 TIME_WAIT 不会阻塞新 listen，但 SO_REUSEADDR 之外
    // 的竞态还是留一点余量更稳）。
    std::thread::sleep(std::time::Duration::from_millis(600));
    match spawn_serve(&app, &state) {
        Ok(()) => {
            let (enabled, port) = read_config();
            if enabled {
                serde_json::json!({ "ok": true, "port": port }).to_string()
            } else {
                serde_json::json!({ "ok": true, "stopped": true }).to_string()
            }
        }
        Err(e) => serde_json::json!({ "ok": false, "message": e }).to_string(),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(SidecarChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 托盘（程序化创建）
            let show = MenuItem::with_id(app, "show", "显示控制台", true, None::<&str>)?;
            let login = MenuItem::with_id(app, "login", "浏览器登录 / 重登", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出（停止服务）", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &login, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("dsweb-proxy — 网页版模型反代")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "login" => {
                        let state: State<SidecarChild> = app.state();
                        let _ = open_login(app.clone(), state);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 窗口尺寸按 proxy.json 应用（tauri.conf 的 900x700 只是打包缺省）
            let (ww, wh) = read_window_config();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.set_size(tauri::LogicalSize::new(ww, wh));
            }

            // sidecar
            let state: State<SidecarChild> = handle.state();
            if let Err(e) = spawn_serve(&handle, &state) {
                eprintln!("[dsweb-proxy] {}", e);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗口 = 藏进托盘（服务继续跑）；真退出走托盘菜单的「退出」
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![proxy_status, open_login, restart_service, start_service, stop_service, get_window_config, set_window_size])
        .run(tauri::generate_context!())
        .expect("error while running dsweb-proxy");
}
