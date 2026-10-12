//! The tray icon (with a dot for unread mentions), the taskbar/dock badge, and hiding to the tray on close.

use crate::shell::{show_window, Shell, MAIN};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

const TRAY: &str = "tray";
/// `--destructive` from clients/web/src/styles.css (#e74c3c).
pub const DOT: [u8; 4] = [0xe7, 0x4c, 0x3c, 0xff];

/// Paints a dot over the bottom-right third of an RGBA image.
pub fn with_dot(rgba: &mut [u8], width: u32, height: u32) {
    let r = width.min(height) as f32 / 4.0;
    let (cx, cy) = (width as f32 - r - 0.5, height as f32 - r - 0.5);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            if dx * dx + dy * dy <= r * r {
                let i = ((y * width + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&DOT);
            }
        }
    }
}

/// A round dot filling a `size`x`size` image (the Windows taskbar overlay).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dot_icon(size: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let r = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let (dx, dy) = (x as f32 + 0.5 - r, y as f32 + 0.5 - r);
            if dx * dx + dy * dy <= (r - 0.5) * (r - 0.5) {
                let i = ((y * size + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&DOT);
            }
        }
    }
    rgba
}

fn tray_icon(app: &AppHandle, dot: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    let mut rgba = base.rgba().to_vec();
    if dot {
        with_dot(&mut rgba, base.width(), base.height());
    }
    Some(Image::new_owned(rgba, base.width(), base.height()))
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Datrope", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start on login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Datrope", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let toggle = autostart.clone();
    let mut b = TrayIconBuilder::with_id(TRAY)
        .tooltip("Datrope")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "show" => show_window(app),
            "autostart" => {
                let on = toggle.is_checked().unwrap_or(false);
                let al = app.autolaunch();
                if on { al.enable() } else { al.disable() }.unwrap_or_else(|_| {
                    let _ = toggle.set_checked(!on);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = tray_icon(app, false) {
        b = b.icon(icon);
    }
    b.build(app)?;
    Ok(())
}

/// Updates the tray dot, the tooltip and the taskbar overlay (Windows) or badge count (macOS/Linux).
pub fn refresh(app: &AppHandle) {
    let mentions = app
        .state::<Shell>()
        .0
        .lock()
        .unwrap()
        .badges
        .total_mentions();
    let dot = mentions > 0;
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_icon(tray_icon(app, dot));
        let _ = tray.set_tooltip(Some(match mentions {
            0 => "Datrope".to_string(),
            1 => "Datrope — 1 unread mention".to_string(),
            n => format!("Datrope — {n} unread mentions"),
        }));
    }
    if let Some(window) = app.get_window(MAIN) {
        #[cfg(windows)]
        let _ = window.set_overlay_icon(dot.then(|| Image::new_owned(dot_icon(16), 16, 16)));
        #[cfg(not(windows))]
        let _ = window.set_badge_count(dot.then_some(i64::from(mentions)));
    }
}

/// Closing the window hides it; everything stays connected. The first time, say so.
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    let _ = window.hide();
    let app = window.app_handle();
    let first = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let first = !inner.store.tray_notice_shown;
        if first {
            inner.store.tray_notice_shown = true;
            inner.save();
        }
        first
    };
    if first {
        let _ = app
            .notification()
            .builder()
            .title("Datrope is still running")
            .body("It keeps you connected in the tray. Quit from the tray icon's menu.")
            .show();
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn px(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn dot_is_painted_bottom_right_only() {
        let (w, h) = (32, 32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        with_dot(&mut rgba, w, h);
        assert_eq!(px(&rgba, w, 26, 26), DOT);
        assert_eq!(px(&rgba, w, 2, 2), [0, 0, 0, 0]);
    }

    #[test]
    fn overlay_icon_is_a_full_dot() {
        let rgba = dot_icon(16);
        assert_eq!(rgba.len(), 16 * 16 * 4);
        assert_eq!(px(&rgba, 16, 8, 8), DOT);
        assert_eq!(px(&rgba, 16, 0, 0)[3], 0, "corners stay transparent");
    }
}
