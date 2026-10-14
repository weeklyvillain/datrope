mod commands;
mod notify;
mod ptt;
mod screen;
mod servers;
mod shell;
mod state;
mod tray;
#[cfg(feature = "updater")]
mod update;

use shell::{Inner, Shell};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_window(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Decorations are ours to set (custom title bar): a saved state from before must not bring the
                // native title bar back.
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(ptt::plugin());
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            let data_root = app.path().app_local_data_dir()?.join("webviews");
            let path = config.join("servers.json");
            let (store, corrupt) = servers::Store::load(&path);
            // An unreadable list says nothing about which data directories are still in use.
            if !corrupt {
                shell::purge_orphan_data(&data_root, &store);
            }
            app.manage(Shell(Mutex::new(Inner::new(store, path, data_root))));
            app.manage(screen::Screen::default());
            let hidden = std::env::args().any(|a| a == "--hidden");
            shell::create_main_window(app.handle(), hidden)?;
            tray::build(app.handle())?;
            #[cfg(feature = "updater")]
            update::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_) => {
                let _ = shell::layout(window.app_handle());
                shell::maximized_changed(window.app_handle());
            }
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == shell::MAIN => {
                tray::on_close_requested(window, api);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::servers_list,
            commands::server_add,
            commands::server_remove,
            commands::servers_reorder,
            commands::server_select,
            commands::chrome_mode,
            commands::chrome_request,
            commands::server_retry,
            commands::desktop_subscribe,
            commands::desktop_notify,
            commands::desktop_set_unread,
            commands::desktop_voice_state,
            commands::desktop_ptt_set_key,
            commands::desktop_server_info,
            commands::update_restart,
            commands::desktop_screen_pick,
            commands::desktop_screen_stop,
            commands::screen_pick_request,
            commands::screen_pick_done,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Datrope")
        .run(|app, event| {
            // macOS: clicking the dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                shell::show_window(app);
            }
            let _ = (app, event);
        });
}
