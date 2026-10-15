fn main() {
    let commands = &[
        // chrome (title bar, dialogs) and the server drawer
        "servers_list",
        "server_add",
        "server_remove",
        "servers_reorder",
        "server_select",
        "chrome_mode",
        "chrome_request",
        "update_restart",
        // screen picker
        "screen_pick_request",
        "screen_pick_done",
        // offline page
        "server_retry",
        // server pages
        "desktop_subscribe",
        "desktop_notify",
        "desktop_set_unread",
        "desktop_voice_state",
        "desktop_ptt_set_key",
        "desktop_server_info",
        "desktop_screen_pick",
        "desktop_screen_stop",
        "desktop_title_bar",
        "desktop_window",
        "desktop_start_drag",
        "desktop_set_theme",
        "desktop_open_url",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
