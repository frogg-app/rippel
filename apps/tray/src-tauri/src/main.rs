// The rippel agent's tray panel.
//
// The agent starts this process and supervises it: it passes the address and
// token of its local desktop API in RIPPEL_DESKTOP_URL / RIPPEL_DESKTOP_TOKEN,
// restarts it if it dies, and kills it on the way out. Everything the panel
// shows or does goes through that API; this process holds no state of its own.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect, WebviewWindow, WindowEvent};

/// The only paths the panel may call. The token grants the whole desktop API,
/// so the webview gets a list rather than a pass-through.
const ALLOWED: &[(&str, &str)] = &[
    ("GET", "/status"),
    ("GET", "/logs"),
    ("POST", "/pause"),
    ("POST", "/resume"),
    ("POST", "/engine/start"),
    ("POST", "/engine/stop"),
    ("POST", "/engine/restart"),
    ("POST", "/quit"),
];

/// How long the agent may go unanswered before the tray assumes it is gone for
/// good and exits. The agent restarts the tray when it comes back.
const ORPHAN_AFTER: u32 = 30;

#[derive(Clone)]
struct Agent {
    url: String,
    token: String,
}

impl Agent {
    fn from_env() -> Option<Self> {
        Some(Self {
            url: std::env::var("RIPPEL_DESKTOP_URL").ok()?,
            token: std::env::var("RIPPEL_DESKTOP_TOKEN").ok()?,
        })
    }

    fn call(&self, method: &str, path: &str) -> Result<Value, String> {
        let response = ureq::request(method, &format!("{}{}", self.url, path))
            .set("X-Rippel-Desktop-Token", &self.token)
            .timeout(Duration::from_secs(12))
            .call();
        match response {
            Ok(r) => r.into_json().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(_, r)) => {
                let body: Value = r.into_json().unwrap_or(Value::Null);
                Err(body["message"].as_str().unwrap_or("The agent refused that.").to_string())
            }
            Err(e) => Err(format!("The agent is not answering ({e}).")),
        }
    }
}

#[tauri::command]
async fn agent(state: tauri::State<'_, Agent>, method: String, path: String) -> Result<Value, String> {
    if !ALLOWED.iter().any(|(m, p)| *m == method && *p == path) {
        return Err(format!("{method} {path} is not something the panel can ask for."));
    }
    let agent = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || agent.call(&method, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// When the panel last hid itself because it lost focus. Clicking the tray icon
/// takes focus first, so without this a click meant to close the panel would
/// hide it on blur and immediately show it again.
static LAST_BLUR_HIDE: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn panel(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Show the panel beside the tray icon, on whichever edge the taskbar is.
fn show_at_tray(window: &WebviewWindow, rect: Rect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let icon = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let size = window.outer_size().unwrap_or_default();
    let (w, h) = (size.width as f64, size.height as f64);
    let gap = 12.0 * scale;

    let mut x = icon.x + icon_size.width / 2.0 - w / 2.0;
    let mut y = icon.y - h - gap;
    if let Ok(Some(monitor)) = window.monitor_from_point(icon.x, icon.y) {
        let origin = monitor.position();
        let area = monitor.size();
        let (left, top) = (origin.x as f64, origin.y as f64);
        let (right, bottom) = (left + area.width as f64, top + area.height as f64);
        // A taskbar on the top edge puts the icon in the upper half.
        if icon.y < top + area.height as f64 / 2.0 {
            y = icon.y + icon_size.height + gap;
        }
        x = x.clamp(left + gap, right - w - gap);
        y = y.clamp(top + gap, bottom - h - gap);
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.show();
    let _ = window.set_focus();
}

/// Show the panel in the bottom-right corner, for when there is no tray click
/// to place it by: the agent asking us to open, or the menu's "Open".
fn show_in_corner(window: &WebviewWindow) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = window.outer_size().unwrap_or_default();
        let origin = monitor.position();
        let area = monitor.size();
        // Clear of a bottom taskbar, which is where it nearly always is.
        let x = origin.x + area.width as i32 - size.width as i32 - (16.0 * scale) as i32;
        let y = origin.y + area.height as i32 - size.height as i32 - (64.0 * scale) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle(app: &AppHandle, rect: Rect) {
    let Some(window) = panel(app) else { return };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if now_ms().saturating_sub(LAST_BLUR_HIDE.load(Ordering::Relaxed)) > 300 {
        show_at_tray(&window, rect);
    }
}

/// Polls the agent for two things the panel cannot do itself: a request to
/// open (someone ran rippel-agent.exe again), and whether the agent is still
/// there at all. Also keeps the tray tooltip saying what state it is in.
fn watch(app: AppHandle, agent: Agent) {
    std::thread::spawn(move || {
        let mut silent = 0;
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            tick += 1;
            match agent.call("GET", "/show") {
                Ok(answer) => {
                    silent = 0;
                    if answer["show"].as_bool() == Some(true) {
                        if let Some(window) = panel(&app) {
                            show_in_corner(&window);
                        }
                    }
                }
                Err(_) => {
                    silent += 1;
                    if silent >= ORPHAN_AFTER {
                        app.exit(0);
                        break;
                    }
                }
            }
            if tick % 5 == 0 {
                if let (Ok(status), Some(tray)) = (agent.call("GET", "/status"), app.tray_by_id("main")) {
                    let state = status["connection"].as_str().unwrap_or("Running");
                    let _ = tray.set_tooltip(Some(format!("rippel agent — {state}")));
                }
            }
        }
    });
}

fn main() {
    let Some(desktop) = Agent::from_env() else {
        // Started by hand rather than by the agent: there is nothing to show.
        eprintln!("rippel-tray is started by the rippel agent; run rippel-agent.exe instead.");
        std::process::exit(2);
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(desktop.clone())
        .invoke_handler(tauri::generate_handler![agent])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if window.is_visible().unwrap_or(false) {
                    LAST_BLUR_HIDE.store(now_ms(), Ordering::Relaxed);
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let open = MenuItem::with_id(app, "open", "Open panel", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit agent", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
            let menu_agent = desktop.clone();

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no icon")?)
                .tooltip("rippel agent")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = panel(app) {
                            show_in_corner(&window);
                        }
                    }
                    "quit" => {
                        // The agent ends this process as part of quitting; exit
                        // anyway in case it refused (it does while busy).
                        if menu_agent.call("POST", "/quit").is_ok() {
                            app.exit(0);
                        } else if let Some(window) = panel(app) {
                            show_in_corner(&window);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            watch(app.handle().clone(), desktop.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("rippel-tray failed to start");
}
