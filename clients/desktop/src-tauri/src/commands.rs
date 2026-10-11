//! Commands the chrome, the drawer, the offline page and the server pages call. Each checks who is calling, on
//! top of the capability that already limits which webview may call it.

use crate::servers::{host_of, normalize_address, probe, AddError};
use crate::shell::{self, server_id, server_label, ChromeMode, RailState, Shell, DRAWER, RAIL};
use serde::{Deserialize, Serialize};
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
    let dir = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.remove(&id).is_none() {
            return Ok(());
        }
        inner.save();
        inner.badges.remove(&id);
        inner.offline.remove(&id);
        inner.limiter.forget(&id);
        inner.voice.forget(&label);
        inner.channels.remove(&label);
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
        let _ = wv.close();
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
