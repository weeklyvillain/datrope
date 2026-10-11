//! Auto-update (Cargo feature "updater", off by default): check at start and every 6 hours, download in the
//! background, and install only when the user presses "Restart to update" — never mid-call.

use crate::shell::{emit_rail_state, Shell};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending(pub Mutex<Option<(Update, Vec<u8>)>>);

pub fn start(app: AppHandle) {
    app.manage(Pending::default());
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = check(&app).await {
                eprintln!("update check: {e}");
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.state::<Pending>().0.lock().unwrap().is_some() {
        return Ok(());
    }
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let bytes = update.download(|_, _| {}, || {}).await?;
    *app.state::<Pending>().0.lock().unwrap() = Some((update, bytes));
    app.state::<Shell>().0.lock().unwrap().update_ready = true;
    emit_rail_state(app);
    Ok(())
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<Pending>().0.lock().unwrap().take();
    let Some((update, bytes)) = pending else {
        return Err("no update ready".into());
    };
    if let Err(e) = update.install(bytes) {
        app.state::<Shell>().0.lock().unwrap().update_ready = false;
        emit_rail_state(app);
        return Err(e.to_string());
    }
    app.restart();
}
