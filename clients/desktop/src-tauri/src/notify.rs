//! Native notifications for server pages. On Windows a click opens the message's channel; on macOS and Linux a
//! click only brings the app forward.

use tauri::AppHandle;

const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 300;

fn cap(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// Caps what a page asks to show. `target` is the message id the page wants back on click.
pub fn sanitize_notification(
    title: &str,
    body: &str,
    target: &str,
) -> Option<(String, String, String)> {
    let title = cap(title, MAX_TITLE);
    if title.is_empty()
        || target.is_empty()
        || target.len() > 32
        || !target.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((title, cap(body, MAX_BODY), target.to_string()))
}

/// Brings the app forward on that server and tells its page which notification was clicked.
// Only the Windows toast click calls this; other platforms' notifications don't carry a click handler.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn open(app: &AppHandle, server_id: &str, target: &str) {
    crate::shell::show_window(app);
    crate::shell::select(app, server_id, false);
    crate::shell::send_to_page(
        app,
        &crate::shell::server_label(server_id),
        "open_notification",
        serde_json::json!({ "target": target }),
    );
}

#[cfg(windows)]
pub fn show(
    app: &AppHandle,
    server_id: &str,
    server_name: &str,
    title: &str,
    body: &str,
    target: &str,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    // Installed builds are registered under the bundle identifier; `tauri dev` borrows PowerShell's.
    let app_id = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let (app2, id, target) = (app.clone(), server_id.to_string(), target.to_string());
    Toast::new(&app_id)
        .title(title)
        .text1(body)
        .text2(server_name)
        .on_activated(move |_action| {
            open(&app2, &id, &target);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn show(
    app: &AppHandle,
    _server_id: &str,
    server_name: &str,
    title: &str,
    body: &str,
    _target: &str,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(format!("{title} · {server_name}"))
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_are_trimmed_and_targets_checked() {
        let (t, b, target) = sanitize_notification(" Alice in #general ", "hi", "123").unwrap();
        assert_eq!(
            (t.as_str(), b.as_str(), target.as_str()),
            ("Alice in #general", "hi", "123")
        );
        let (t, b, _) = sanitize_notification(&"x".repeat(500), &"y".repeat(5000), "1").unwrap();
        assert_eq!(t.chars().count(), 120);
        assert_eq!(b.chars().count(), 300);
        assert!(
            sanitize_notification("", "body", "1").is_none(),
            "no title, no notification"
        );
        assert!(
            sanitize_notification("t", "b", "javascript:alert(1)").is_none(),
            "targets are message ids"
        );
        assert!(sanitize_notification("t", "b", &"9".repeat(40)).is_none());
    }
}
