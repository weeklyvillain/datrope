//! Commands the chrome, the drawer, the offline page and the server pages call. Each checks who is calling, on
//! top of the capability that already limits which webview may call it.

use crate::screen::{PickRequest, Picked, StreamSettings};
use crate::servers::{host_of, normalize_address, probe, AddError};
use crate::shell::{
    self, server_id, server_label, ChromeMode, RailState, Shell, DRAWER, PICKER, RAIL,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Webview};

/// The title bar may call every chrome command; the drawer only those its capability grants (`drawer_too`).
fn chrome_caller_allowed(label: &str, drawer_too: bool) -> bool {
    label == RAIL || (drawer_too && label == DRAWER)
}

fn only_rail(webview: &Webview) -> Result<(), String> {
    if chrome_caller_allowed(webview.label(), false) {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

fn rail_or_drawer(webview: &Webview) -> Result<(), String> {
    if chrome_caller_allowed(webview.label(), true) {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

#[tauri::command]
pub fn servers_list(app: AppHandle, webview: Webview) -> Result<RailState, String> {
    rail_or_drawer(&webview)?;
    Ok(shell::rail_state(&app.state::<Shell>().0.lock().unwrap()))
}

#[tauri::command]
pub async fn server_add(
    app: AppHandle,
    webview: Webview,
    address: String,
) -> Result<RailState, String> {
    only_rail(&webview)?;
    let origin =
        normalize_address(&address, cfg!(debug_assertions)).map_err(|e| e.message().to_string())?;
    if app
        .state::<Shell>()
        .0
        .lock()
        .unwrap()
        .store
        .servers
        .iter()
        .any(|s| s.url == origin)
    {
        return Err(AddError::Duplicate.message().into());
    }
    // Store where the server really is: an apex address that redirects to www would otherwise be stored as an
    // origin whose page load the navigation rule blocks.
    let origin = probe(&origin, cfg!(debug_assertions))
        .await
        .map_err(|e| e.message().to_string())?;
    let server = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let s = inner
            .store
            .add(origin.clone(), host_of(&origin))
            .map_err(|e| e.message().to_string())?;
        inner.save();
        inner.selected = Some(s.id.clone());
        inner.mode = ChromeMode::Closed;
        s
    };
    // The new server webview went on top: recreate the drawer above it (the add dialog hides all of it).
    if let Err(e) = shell::add_server_webview(&app, &server)
        .and_then(|()| shell::create_drawer_webview(&app))
        .and_then(|()| shell::layout(&app))
    {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        inner.store.remove(&server.id);
        inner.selected = inner.store.servers.first().map(|s| s.id.clone());
        inner.save();
        return Err(e.to_string());
    }
    shell::apply_visibility(&app);
    shell::emit_rail_state(&app);
    Ok(shell::rail_state(&app.state::<Shell>().0.lock().unwrap()))
}

#[tauri::command]
pub fn server_remove(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_rail(&webview)?;
    let label = server_label(&id);
    let unregister_key;
    let origin;
    let dir = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let Some(server) = inner.store.remove(&id) else {
            return Ok(());
        };
        origin = server.url;
        inner.save();
        inner.badges.remove(&id);
        inner.offline.remove(&id);
        inner.limiter.forget(&id);
        inner.voice.forget(&label);
        inner.channels.remove(&label);
        inner.window_limiter.forget(&id);
        inner.theme_limiter.forget(&id);
        inner.claimed.remove(&label);
        inner.themes.remove(&label);
        crate::screen::page_gone(&app, &label);
        unregister_key = inner.ptt.set(&label, None).unregister;
        if inner.selected.as_deref() == Some(id.as_str()) {
            inner.selected = inner.store.servers.first().map(|s| s.id.clone());
        }
        inner.mode = ChromeMode::Closed;
        inner.data_root.join(&id)
    };
    if let Some(key) = unregister_key {
        crate::ptt::unregister(&app, &key);
    }
    if let Some(wv) = app.get_webview(&label) {
        shell::close_server_webview(wv, &origin);
    }
    remove_data_later(&app, &id, dir);
    let _ = shell::layout(&app);
    shell::apply_visibility(&app);
    shell::emit_rail_state(&app);
    crate::tray::refresh(&app);
    Ok(())
}

/// The closed webview's browser process may still hold its files for a moment: retry for a few seconds. Anything
/// left is removed on the next start (`purge_orphan_data`).
fn remove_data_later(app: &AppHandle, id: &str, dir: std::path::PathBuf) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(uuid) = uuid::Uuid::parse_str(id) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = app.remove_data_store(*uuid.as_bytes()).await;
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id);
    std::thread::spawn(move || {
        for _ in 0..20 {
            if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[tauri::command]
pub fn servers_reorder(app: AppHandle, webview: Webview, ids: Vec<String>) -> Result<(), String> {
    rail_or_drawer(&webview)?;
    {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.reorder(&ids) {
            inner.save();
        }
    }
    shell::emit_rail_state(&app);
    Ok(())
}

/// `animate`: slide the drawer out (false when the user prefers reduced motion).
#[tauri::command]
pub fn server_select(
    app: AppHandle,
    webview: Webview,
    id: String,
    animate: bool,
) -> Result<(), String> {
    rail_or_drawer(&webview)?;
    shell::select(&app, &id, animate);
    Ok(())
}

/// The chrome opens or closes the server drawer (sliding, with `animate`), or takes the whole window for a dialog.
#[tauri::command]
pub fn chrome_mode(
    app: AppHandle,
    webview: Webview,
    mode: ChromeMode,
    animate: bool,
) -> Result<(), String> {
    rail_or_drawer(&webview)?;
    shell::set_mode(&app, mode, animate).map_err(|e| e.to_string())
}

/// What the drawer asks the title bar webview to open: `"add"` or `{ "remove": id }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChromeRequest {
    Add,
    Remove(String),
}

/// The drawer is too narrow for the add and remove dialogs: close it, give the chrome the whole window and have
/// it open the dialog. The dialogs return to closed mode as before.
#[tauri::command]
pub fn chrome_request(
    app: AppHandle,
    webview: Webview,
    action: ChromeRequest,
) -> Result<(), String> {
    rail_or_drawer(&webview)?;
    if let ChromeRequest::Remove(id) = &action {
        if app
            .state::<Shell>()
            .0
            .lock()
            .unwrap()
            .store
            .get(id)
            .is_none()
        {
            return Err("unknown server".into());
        }
    }
    shell::set_mode(&app, ChromeMode::Full, false).map_err(|e| e.to_string())?;
    if let Some(rail) = app.get_webview(RAIL) {
        let _ = rail.set_focus();
    }
    app.emit_to(EventTarget::webview(RAIL), "chrome_request", &action)
        .map_err(|e| e.to_string())
}

/// "Retry" on the offline page: load the server again if it answers now.
#[tauri::command]
pub async fn server_retry(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    if server_id(webview.label()) != Some(id.as_str()) {
        return Err("not allowed".into());
    }
    let url = app
        .state::<Shell>()
        .0
        .lock()
        .unwrap()
        .store
        .get(&id)
        .map(|s| s.url.clone())
        .ok_or("unknown server")?;
    // The stored origin stays; if it now redirects to another origin its page load would be blocked, so that
    // counts as unreachable.
    let reached = probe(&url, cfg!(debug_assertions))
        .await
        .map_err(|e| e.message().to_string())?;
    if reached != url {
        return Err(AddError::Unreachable.message().into());
    }
    app.state::<Shell>().0.lock().unwrap().offline.remove(&id);
    webview
        .navigate(url.parse().map_err(|_| "bad url")?)
        .map_err(|e| e.to_string())?;
    shell::emit_rail_state(&app);
    Ok(())
}

use crate::state::{ptt_allowed, voice_change, Badge};

fn caller(webview: &Webview) -> Result<String, String> {
    server_id(webview.label())
        .map(str::to_string)
        .ok_or_else(|| "not allowed".into())
}

const MAX_NAME: usize = 100;
const MAX_ICON: usize = 300_000; // characters of the data: URL (~220 KB of image)

pub fn sanitize_server_info(name: &str, icon: Option<String>) -> Option<(String, Option<String>)> {
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        return None;
    }
    let icon = icon.filter(|i| i.starts_with("data:image/") && i.len() <= MAX_ICON);
    Some((name, icon))
}

/// A server page hands the shell the one channel it receives everything on: `{ event, payload }` for `visible`,
/// `ptt`, `leave_voice` and `open_notification`. A new subscription replaces the old one; the current `visible`
/// state is sent straight away.
#[tauri::command]
pub fn desktop_subscribe(
    app: AppHandle,
    webview: Webview,
    channel: Channel<serde_json::Value>,
) -> Result<(), String> {
    caller(&webview)?;
    let label = webview.label().to_string();
    let visible = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        inner.channels.insert(label.clone(), channel);
        inner.visible.as_deref() == Some(label.as_str())
    };
    shell::send_to_page(
        &app,
        &label,
        "visible",
        serde_json::json!({ "visible": visible }),
    );
    send_chrome_state_to(&app, &label);
    Ok(())
}

#[tauri::command]
pub fn desktop_notify(
    app: AppHandle,
    webview: Webview,
    title: String,
    body: String,
    target: String,
) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some((title, body, target)) = crate::notify::sanitize_notification(&title, &body, &target)
    else {
        return Ok(());
    };
    let server_name = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if !inner.limiter.allow(&id, std::time::Instant::now()) {
            return Ok(());
        }
        inner
            .store
            .get(&id)
            .map(|s| s.name.clone())
            .unwrap_or_default()
    };
    crate::notify::show(&app, &id, &server_name, &title, &body, &target)
}

#[tauri::command]
pub fn desktop_set_unread(
    app: AppHandle,
    webview: Webview,
    unread: bool,
    mentions: u32,
) -> Result<(), String> {
    let id = caller(&webview)?;
    let changed = app.state::<Shell>().0.lock().unwrap().badges.set(
        &id,
        Badge {
            unread,
            mentions: mentions.min(9999),
        },
    );
    if changed {
        shell::emit_rail_state(&app);
        crate::tray::refresh(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_voice_state(app: AppHandle, webview: Webview, in_call: bool) -> Result<(), String> {
    caller(&webview)?;
    let (leave, updates) = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let inner = &mut *inner;
        voice_change(&mut inner.voice, &mut inner.ptt, webview.label(), in_call)
    };
    for update in &updates {
        if let Some(l) = &update.release {
            crate::ptt::release(&app, l);
        }
        if let Some(k) = &update.unregister {
            crate::ptt::unregister(&app, k);
        }
    }
    if let Some(label) = leave {
        shell::send_to_page(&app, &label, "leave_voice", serde_json::Value::Null);
    }
    shell::apply_memory_levels(&app);
    Ok(())
}

#[tauri::command]
pub fn desktop_ptt_set_key(
    app: AppHandle,
    webview: Webview,
    key: Option<String>,
) -> Result<(), String> {
    caller(&webview)?;
    let label = webview.label().to_string();
    let update = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if key.is_some() && !ptt_allowed(&inner.voice, &label) {
            return Ok(());
        }
        inner.ptt.set(&label, key)
    };
    if let Some(l) = &update.release {
        crate::ptt::release(&app, l);
    }
    if let Some(k) = &update.unregister {
        crate::ptt::unregister(&app, k);
    }
    if let Some(k) = &update.register {
        if let Err(e) = crate::ptt::register(&app, k) {
            app.state::<Shell>().0.lock().unwrap().ptt.set(&label, None);
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_server_info(
    app: AppHandle,
    webview: Webview,
    name: String,
    icon: Option<String>,
) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some((name, icon)) = sanitize_server_info(&name, icon) else {
        return Ok(());
    };
    let changed = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let Some(s) = inner.store.get_mut(&id) else {
            return Ok(());
        };
        let changed = s.name != name || s.icon != icon;
        s.name = name;
        s.icon = icon;
        if changed {
            inner.save();
        }
        changed
    };
    if changed {
        shell::emit_rail_state(&app);
    }
    Ok(())
}

/// A server page wants to share its screen. The shell's own picker, in its own webview over the whole window, chooses
/// what (the page never sees the list) and, given `settings`, the stream quality too, starting from those. Resolves
/// to the capture's generation (with the chosen quality if it was offered), or none if the user cancelled; the
/// frames then arrive on `frames` and in the shared buffer posted to the page.
#[tauri::command]
pub async fn desktop_screen_pick(
    app: AppHandle,
    webview: Webview,
    fps: u32,
    frames: Channel<serde_json::Value>,
    settings: Option<StreamSettings>,
) -> Result<Option<Picked>, String> {
    let id = caller(&webview)?;
    if !cfg!(windows) {
        return Err("Screen share from the app is only on Windows so far.".into());
    }
    let label = webview.label().to_string();
    let settings = settings.filter(StreamSettings::valid);
    let sources = tauri::async_runtime::spawn_blocking(crate::screen::sources)
        .await
        .map_err(|e| e.to_string())?;
    if sources.is_empty() {
        return Err("There is nothing to share.".into());
    }
    let server = app
        .state::<Shell>()
        .0
        .lock()
        .unwrap()
        .store
        .get(&id)
        .map(|s| s.name.clone())
        .unwrap_or_default();
    let theme = {
        let shell = app.state::<Shell>();
        let inner = shell.0.lock().unwrap();
        shell::theme_of(&inner, Some(&id))
    };
    let request = crate::screen::PickRequest {
        server,
        sources,
        settings,
        theme,
    };
    let mut answer = crate::screen::open_pick(&app, &label, request);
    // The picker webview fetches the request once it has loaded (`screen_pick_request`).
    if let Err(e) = shell::open_picker_webview(&app) {
        crate::screen::answer_pick(&app, None, None);
        return Err(e.to_string());
    }
    let chosen = answer.recv().await.flatten();
    // Back to the page, unless a newer request has the picker open.
    if !crate::screen::picking(&app) {
        shell::close_picker_webview(&app);
        shell::focus_shown(&app);
    }
    let Some((source, chosen)) = chosen else {
        return Ok(None);
    };
    let fps = chosen.map_or(fps, |s| s.fps);
    let gen = crate::screen::start(&app, &label, &source, fps, frames)?;
    Ok(Some(match chosen {
        Some(settings) => Picked::WithSettings { gen, settings },
        None => Picked::Source(gen),
    }))
}

fn only_picker(webview: &Webview) -> Result<(), String> {
    if webview.label() == PICKER {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

/// What the open picker shows; none once it was answered or replaced.
#[tauri::command]
pub fn screen_pick_request(
    app: AppHandle,
    webview: Webview,
) -> Result<Option<PickRequest>, String> {
    only_picker(&webview)?;
    Ok(crate::screen::request(&app))
}

/// The picker's answer: a source id it was offered, or none for cancel, and the quality if it offered one.
#[tauri::command]
pub fn screen_pick_done(
    app: AppHandle,
    webview: Webview,
    id: Option<String>,
    settings: Option<StreamSettings>,
) -> Result<(), String> {
    only_picker(&webview)?;
    crate::screen::answer_pick(&app, id, settings);
    Ok(())
}

/// The page stopped sharing (or the shared window closed and the page noticed).
#[tauri::command]
pub fn desktop_screen_stop(app: AppHandle, webview: Webview) -> Result<(), String> {
    caller(&webview)?;
    crate::screen::stop_for(&app, webview.label());
    Ok(())
}

#[tauri::command]
pub fn update_restart(app: AppHandle, webview: Webview) -> Result<(), String> {
    only_rail(&webview)?;
    #[cfg(feature = "updater")]
    {
        crate::update::install(&app)
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        Err("updates are not enabled in this build".into())
    }
}

/// The page on screen asks for its title bar: hides the shell bar above it (or shows it again).
#[tauri::command]
pub fn desktop_title_bar(app: AppHandle, webview: Webview, claimed: bool) -> Result<(), String> {
    let id = caller(&webview)?;
    let label = webview.label().to_string();
    let changed = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if !inner.window_limiter.allow(&id, std::time::Instant::now()) {
            return Err("too many requests".into());
        }
        if claimed {
            inner.claimed.insert(label.clone())
        } else {
            inner.claimed.remove(&label)
        }
    };
    if changed {
        shell::layout(&app).map_err(|e| e.to_string())?;
        shell::emit_rail_state(&app);
    }
    if claimed {
        send_chrome_state_to(&app, &label);
    }
    Ok(())
}

/// Sends the claimed page `label` its chrome state.
fn send_chrome_state_to(app: &AppHandle, label: &str) {
    let state = {
        let shell = app.state::<Shell>();
        let inner = shell.0.lock().unwrap();
        if !inner.claimed.contains(label) {
            return;
        }
        shell::chrome_state_for(&inner, label)
    };
    if let Some(state) = state {
        shell::send_to_page(app, label, "chrome", state);
    }
}

/// What a server page may ask of the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
    Servers,
    Update,
}

/// Only the visible page may move or close the window, within its own rate limit.
fn visible_caller(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let id = caller(webview)?;
    let shell = app.state::<Shell>();
    let mut inner = shell.0.lock().unwrap();
    if inner.visible.as_deref() != Some(webview.label()) {
        return Err("not visible".into());
    }
    if !inner.window_limiter.allow(&id, std::time::Instant::now()) {
        return Err("too many requests".into());
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_window(
    app: AppHandle,
    webview: Webview,
    action: WindowAction,
) -> Result<(), String> {
    visible_caller(&app, &webview)?;
    let window = shell::main_window(&app).ok_or("no window")?;
    match action {
        WindowAction::Minimize => window.minimize().map_err(|e| e.to_string()),
        WindowAction::ToggleMaximize => if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        }
        .map_err(|e| e.to_string()),
        // The close-requested handler hides the window to the tray.
        WindowAction::Close => window.close().map_err(|e| e.to_string()),
        WindowAction::Servers => {
            shell::set_mode(&app, ChromeMode::Drawer, true).map_err(|e| e.to_string())
        }
        WindowAction::Update => {
            if !app.state::<Shell>().0.lock().unwrap().update_ready {
                return Ok(());
            }
            #[cfg(feature = "updater")]
            {
                crate::update::install(&app)
            }
            #[cfg(not(feature = "updater"))]
            {
                Err("updates are not enabled in this build".into())
            }
        }
    }
}

#[tauri::command]
pub fn desktop_start_drag(app: AppHandle, webview: Webview) -> Result<(), String> {
    visible_caller(&app, &webview)?;
    shell::main_window(&app)
        .ok_or("no window")?
        .start_dragging()
        .map_err(|e| e.to_string())
}

/// A server page's colour tokens for the app's own screens. Invalid payloads are ignored whole.
#[tauri::command]
pub fn desktop_set_theme(
    app: AppHandle,
    webview: Webview,
    tokens: HashMap<String, String>,
) -> Result<(), String> {
    let id = caller(&webview)?;
    let Some(theme) = crate::theme::validate(&tokens) else {
        return Ok(());
    };
    let selected = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if !inner.theme_limiter.allow(&id, std::time::Instant::now()) {
            return Ok(());
        }
        inner.themes.insert(webview.label().to_string(), theme);
        inner.selected.as_deref() == Some(id.as_str())
    };
    if selected {
        shell::emit_rail_state(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_commands_check_the_caller() {
        assert!(chrome_caller_allowed("rail", false));
        assert!(chrome_caller_allowed("rail", true));
        assert!(chrome_caller_allowed("drawer", true));
        assert!(
            !chrome_caller_allowed("drawer", false),
            "adding, removing and updating stay with the title bar"
        );
        assert!(!chrome_caller_allowed("server-abc", true));
        assert!(!chrome_caller_allowed("server-abc", false));
    }

    #[test]
    fn window_actions_parse() {
        let a: WindowAction = serde_json::from_str("\"toggle_maximize\"").unwrap();
        assert_eq!(a, WindowAction::ToggleMaximize);
        assert!(serde_json::from_str::<WindowAction>("\"set_position\"").is_err());
    }

    #[test]
    fn chrome_requests_parse() {
        assert_eq!(
            serde_json::from_str::<ChromeRequest>(r#""add""#).unwrap(),
            ChromeRequest::Add
        );
        assert_eq!(
            serde_json::from_str::<ChromeRequest>(r#"{"remove":"abc"}"#).unwrap(),
            ChromeRequest::Remove("abc".into())
        );
        assert_eq!(
            serde_json::to_value(ChromeRequest::Remove("abc".into())).unwrap(),
            serde_json::json!({ "remove": "abc" }),
            "the rail gets the same shape"
        );
    }

    #[test]
    fn server_info_is_capped() {
        assert_eq!(
            sanitize_server_info(" Friends ", None),
            Some(("Friends".into(), None))
        );
        assert_eq!(sanitize_server_info("", None), None);
        assert_eq!(
            sanitize_server_info(&"n".repeat(1000), None)
                .unwrap()
                .0
                .chars()
                .count(),
            100
        );
        let png = format!("data:image/png;base64,{}", "A".repeat(100));
        assert_eq!(
            sanitize_server_info("A", Some(png.clone())).unwrap().1,
            Some(png)
        );
        assert_eq!(
            sanitize_server_info("A", Some("https://x/icon.png".into()))
                .unwrap()
                .1,
            None,
            "only data: images"
        );
        let huge = format!("data:image/png;base64,{}", "A".repeat(400_000));
        assert_eq!(
            sanitize_server_info("A", Some(huge)).unwrap().1,
            None,
            "too big: dropped"
        );
    }
}
