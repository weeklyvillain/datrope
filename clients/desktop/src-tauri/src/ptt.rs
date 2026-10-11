//! The global push-to-talk shortcut, registered only while a server page is in a call with push-to-talk on.

use crate::shell::{send_to_page, Shell};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The plugin's handler: every press/release of the registered shortcut lands here.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            let pressed = event.state() == ShortcutState::Pressed;
            let routed = app.state::<Shell>().0.lock().unwrap().ptt.press(pressed);
            if let Some((label, down)) = routed {
                send_to_page(app, &label, "ptt", serde_json::json!({ "down": down }));
            }
        })
        .build()
}

pub fn register(app: &AppHandle, key: &str) -> Result<(), String> {
    app.global_shortcut()
        .register(key)
        .map_err(|e| e.to_string())
}

pub fn unregister(app: &AppHandle, key: &str) {
    let _ = app.global_shortcut().unregister(key);
}

pub fn release(app: &AppHandle, label: &str) {
    send_to_page(app, label, "ptt", serde_json::json!({ "down": false }));
}
