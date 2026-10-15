//! The main window: the chrome (title bar, dialogs) on top, one child webview per server below it (only the
//! selected one visible), and the server drawer webview sliding in over the server page.

use crate::servers::{host_of, navigation_allowed, Server, Store};
use crate::state::{voice_change, Badge, Badges, PttRouter, PttUpdate, RateLimiter, VoiceTracker};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window,
};

/// The chrome webview: title bar and dialogs. Its label stays "rail" (internal).
pub const RAIL: &str = "rail";
/// The server drawer: its own webview, created after the server webviews so it stacks above them.
pub const DRAWER: &str = "drawer";
/// The screen picker: its own transparent webview over the whole window while a server page asks for a source.
pub const PICKER: &str = "picker";
pub const MAIN: &str = "main";
pub const TOP_BAR_HEIGHT: f64 = 32.0;
pub const DRAWER_WIDTH: f64 = 260.0;
const SLIDE_STEPS: usize = 11;
const SLIDE_MS: u64 = 150;

/// How much of the window the chrome takes: just the title bar, the title bar with the server drawer slid in over
/// the page, or all of it (add dialog, remove confirmation, no servers yet; server pages hidden).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChromeMode {
    #[default]
    Closed,
    Drawer,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self {
            x,
            y,
            w: w.max(0.0),
            h: h.max(0.0),
        }
    }
}

/// Where the chrome, the server webviews and the open drawer go in a `w` x `h` window: (chrome, page, drawer).
/// The drawer covers the page's left edge without moving it; it is `None` (hidden) outside drawer mode. In full
/// mode the page rect doesn't matter: server webviews are hidden.
/// `bar` is the shell bar's height above the selected server's page: 0 once that page draws the title bar itself.
pub fn layout_rects(mode: ChromeMode, w: f64, h: f64, bar: f64) -> (Rect, Rect, Option<Rect>) {
    let chrome = Rect::new(0.0, 0.0, w, bar);
    let page = Rect::new(0.0, bar, w, h - bar);
    match mode {
        ChromeMode::Closed => (chrome, page, None),
        ChromeMode::Drawer => (chrome, page, Some(drawer_rect(h, bar))),
        ChromeMode::Full => (Rect::new(0.0, 0.0, w, h), page, None),
    }
}

/// The open drawer in a window `h` high, below a shell bar `bar` high.
fn drawer_rect(h: f64, bar: f64) -> Rect {
    Rect::new(0.0, bar, DRAWER_WIDTH, h - bar)
}

/// The shell bar's height above a server page: none once that page draws the title bar itself.
pub fn bar_height(inner: &Inner, label: &str) -> f64 {
    bar_for(&inner.claimed, label)
}

fn bar_for(claimed: &HashSet<String>, label: &str) -> f64 {
    if claimed.contains(label) {
        0.0
    } else {
        TOP_BAR_HEIGHT
    }
}

/// Whether the chrome webview shows: always in full mode, otherwise only while there is a shell bar to draw.
pub fn rail_visible(mode: ChromeMode, bar: f64) -> bool {
    mode == ChromeMode::Full || bar > 0.0
}

/// The shell bar's height above the selected server's page.
fn selected_bar(inner: &Inner) -> f64 {
    inner
        .selected
        .as_deref()
        .map_or(TOP_BAR_HEIGHT, |id| bar_height(inner, &server_label(id)))
}

/// Unread and mentions on every server but `id`: the badge on that page's Servers button.
pub fn others_badge(inner: &Inner, id: &str) -> Badge {
    inner
        .store
        .servers
        .iter()
        .filter(|s| s.id != id)
        .map(|s| inner.badges.get(&s.id))
        .fold(Badge::default(), |acc, b| Badge {
            unread: acc.unread || b.unread,
            mentions: acc.mentions.saturating_add(b.mentions),
        })
}

/// The x positions of a slide from `from` to `to` in `steps` steps (at least one), easing out (cubic): fast
/// first, slow at the end. The last one is exactly `to`.
pub fn slide_steps(from: f64, to: f64, steps: usize) -> Vec<f64> {
    let steps = steps.max(1);
    (1..=steps)
        .map(|i| {
            if i == steps {
                return to;
            }
            let t = i as f64 / steps as f64;
            from + (to - from) * (1.0 - (1.0 - t).powi(3))
        })
        .collect()
}

/// Tells the title bar whether to draw window buttons (Windows, Linux) or leave room for the traffic lights (macOS).
pub const fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

pub fn server_label(id: &str) -> String {
    format!("server-{id}")
}

pub fn server_id(label: &str) -> Option<&str> {
    label.strip_prefix("server-")
}

pub struct Inner {
    pub store: Store,
    pub path: PathBuf,
    /// One data directory per server id below this, so cookies never mix.
    pub data_root: PathBuf,
    pub selected: Option<String>,
    /// What the chrome asked for; see `chrome_mode` for what applies.
    pub mode: ChromeMode,
    /// The drawer webview's x: `-DRAWER_WIDTH` when hidden, 0 when open, in between while it slides.
    pub drawer_x: f64,
    /// Bumped by every slide; a running slide stops once it no longer matches (the latest toggle wins).
    pub drawer_slide: u64,
    /// The main window is maximized (the title bar shows Restore instead of Maximize).
    pub maximized: bool,
    pub offline: HashSet<String>,
    pub badges: Badges,
    pub voice: VoiceTracker,
    pub ptt: PttRouter,
    pub limiter: RateLimiter,
    pub update_ready: bool,
    /// The server webview that last got `visible: true`.
    pub visible: Option<String>,
    /// Each server page's channel from `desktop_subscribe`, by webview label: the only way the shell talks to
    /// server pages (they get no event permissions, so they can't emit to or listen in on each other).
    pub channels: HashMap<String, Channel<serde_json::Value>>,
    /// Server webview labels whose page draws the title bar itself (`desktop_title_bar`); cleared on page load.
    pub claimed: HashSet<String>,
    /// Limits the window and drag commands server pages call.
    pub window_limiter: RateLimiter,
    /// Limits `desktop_set_theme`.
    pub theme_limiter: RateLimiter,
    /// The theme each claimed page asked the shell to apply, by webview label.
    pub themes: HashMap<String, std::collections::BTreeMap<String, String>>,
}

impl Inner {
    pub fn new(store: Store, path: PathBuf, data_root: PathBuf) -> Self {
        let selected = store.servers.first().map(|s| s.id.clone());
        Self {
            store,
            path,
            data_root,
            selected,
            mode: ChromeMode::Closed,
            drawer_x: -DRAWER_WIDTH,
            drawer_slide: 0,
            maximized: false,
            offline: HashSet::new(),
            badges: Badges::default(),
            voice: VoiceTracker::default(),
            ptt: PttRouter::default(),
            limiter: RateLimiter::new(5, Duration::from_secs(10)),
            update_ready: false,
            visible: None,
            channels: HashMap::new(),
            claimed: HashSet::new(),
            window_limiter: RateLimiter::new(30, Duration::from_secs(10)),
            theme_limiter: RateLimiter::new(10, Duration::from_secs(10)),
            themes: HashMap::new(),
        }
    }

    /// A server page started loading a new document (reload, sign-out, navigation, the offline page), so what the
    /// old one reported no longer holds: it leaves its call, loses its channel and its badge. Returns the
    /// push-to-talk updates to apply, whether the badge changed and whether the page title bar claim ended.
    pub fn page_reset(&mut self, label: &str) -> (Vec<PttUpdate>, bool, bool) {
        let (_, updates) = voice_change(&mut self.voice, &mut self.ptt, label, false);
        self.channels.remove(label);
        let claim_removed = self.claimed.remove(label);
        self.themes.remove(label);
        let badge_changed = server_id(label).is_some_and(|id| {
            let was = self.badges.get(id);
            self.badges.set(id, Badge::default());
            was != Badge::default()
        });
        (updates, badge_changed, claim_removed)
    }

    /// The mode in effect: with no servers the chrome always takes the whole window.
    pub fn chrome_mode(&self) -> ChromeMode {
        if self.store.servers.is_empty() {
            ChromeMode::Full
        } else {
            self.mode
        }
    }

    pub fn save(&self) {
        if let Err(e) = self.store.save(&self.path) {
            eprintln!("saving {}: {e}", self.path.display());
        }
    }
}

pub struct Shell(pub Mutex<Inner>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailServer {
    pub id: String,
    pub url: String,
    pub name: String,
    pub icon: Option<String>,
    pub unread: bool,
    pub mentions: u32,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailState {
    pub servers: Vec<RailServer>,
    pub selected: Option<String>,
    pub update_ready: bool,
    pub mode: ChromeMode,
    pub maximized: bool,
    pub platform: &'static str,
    /// The selected server's page draws the title bar, so the shell bar has no height.
    pub bar_hidden: bool,
    /// The selected server's colour tokens for the app's own screens; empty if it sent none.
    pub theme: std::collections::BTreeMap<String, String>,
}

/// The colour tokens server `id` sent (empty if none).
pub fn theme_of(inner: &Inner, id: Option<&str>) -> std::collections::BTreeMap<String, String> {
    id.and_then(|id| inner.themes.get(&server_label(id)))
        .cloned()
        .unwrap_or_default()
}

pub fn rail_state(inner: &Inner) -> RailState {
    RailState {
        servers: inner
            .store
            .servers
            .iter()
            .map(|s| {
                let b = inner.badges.get(&s.id);
                RailServer {
                    id: s.id.clone(),
                    url: s.url.clone(),
                    name: s.name.clone(),
                    icon: s.icon.clone(),
                    unread: b.unread,
                    mentions: b.mentions,
                    online: !inner.offline.contains(&s.id),
                }
            })
            .collect(),
        selected: inner.selected.clone(),
        update_ready: inner.update_ready,
        mode: inner.chrome_mode(),
        maximized: inner.maximized,
        platform: platform(),
        bar_hidden: selected_bar(inner) == 0.0,
        theme: theme_of(inner, inner.selected.as_deref()),
    }
}

/// Sends the state to the title bar and the drawer.
pub fn emit_rail_state(app: &AppHandle) {
    let state = rail_state(&app.state::<Shell>().0.lock().unwrap());
    for label in [RAIL, DRAWER] {
        let _ = app.emit_to(EventTarget::webview(label), "rail_state", &state);
    }
    send_chrome_state(app);
}

/// The `chrome` event payload for the claimed page `label`; none for anything but a server page.
pub fn chrome_state_for(inner: &Inner, label: &str) -> Option<serde_json::Value> {
    let o = others_badge(inner, server_id(label)?);
    Some(serde_json::json!({
        "maximized": inner.maximized,
        "updateReady": inner.update_ready,
        "platform": platform(),
        "others": { "unread": o.unread, "mentions": o.mentions },
    }))
}

/// Tells every page that draws the title bar what its buttons show: maximized, update ready, the other servers' badge.
pub fn send_chrome_state(app: &AppHandle) {
    let messages: Vec<(String, serde_json::Value)> = {
        let shell = app.state::<Shell>();
        let inner = shell.0.lock().unwrap();
        inner
            .claimed
            .iter()
            .filter_map(|label| Some((label.clone(), chrome_state_for(&inner, label)?)))
            .collect()
    };
    for (label, payload) in messages {
        send_to_page(app, &label, "chrome", payload);
    }
}

/// Chromium flags for server webviews on Windows: Tauri's defaults plus no background throttling, so a hidden
/// server keeps its gateway heartbeat and voice running. The chrome uses them too: a webview joins an existing
/// WebView2 environment only with the same flags.
pub fn server_browser_args() -> Option<&'static str> {
    if cfg!(windows) {
        Some(concat!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
            "--disable-background-timer-throttling --disable-renderer-backgrounding ",
            "--disable-backgrounding-occluded-windows ",
            "--autoplay-policy=no-user-gesture-required"
        ))
    } else {
        None
    }
}

/// The data directory all server webviews share on Windows, below the data root.
pub const SHARED_DATA: &str = "shared";

/// Where server `id`'s webview keeps its data. On Windows all servers share one WebView2 user data folder, so they
/// run in one browser process (with one GPU and one network process) instead of a process group per server; their
/// origins keep cookies and storage apart. Elsewhere each server gets its own directory, so cookies never mix.
pub fn server_data_dir(data_root: &Path, id: &str) -> PathBuf {
    if cfg!(windows) {
        data_root.join(SHARED_DATA)
    } else {
        data_root.join(id)
    }
}

/// Whether the data directory `name` below the data root is still in use.
fn data_in_use(name: &str, store: &Store) -> bool {
    if cfg!(windows) {
        name == SHARED_DATA
    } else {
        store.get(name).is_some()
    }
}

/// Deletes data directories that belong to no server (left over when deleting failed while a webview held files,
/// and on Windows the per-server directories from before servers shared one).
pub fn purge_orphan_data(data_root: &Path, store: &Store) {
    let Ok(entries) = std::fs::read_dir(data_root) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !data_in_use(&name, store) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Closes a removed server's webview. On Windows its cookies and storage live in the shared data directory, so they
/// are cleared first (elsewhere its own directory is deleted afterwards).
pub fn close_server_webview(wv: tauri::Webview, origin: &str) {
    #[cfg(windows)]
    {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::{w, HSTRING};
        // Close from another thread: the close then runs from the event loop, not inside a WebView2 callback.
        let close = |wv: tauri::Webview| {
            std::thread::spawn(move || {
                let _ = wv.close();
            });
        };
        let params = serde_json::json!({ "origin": origin, "storageTypes": "all" }).to_string();
        let target = wv.clone();
        let started = wv.with_webview(move |pw| {
            let on_done = target.clone();
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| {
                close(on_done);
                Ok(())
            }));
            // SAFETY: plain WebView2 COM calls on the main thread, where with_webview runs this.
            let called = unsafe {
                pw.controller().CoreWebView2().and_then(|core| {
                    core.CallDevToolsProtocolMethod(
                        w!("Storage.clearDataForOrigin"),
                        &HSTRING::from(params),
                        &done,
                    )
                })
            };
            if let Err(e) = called {
                eprintln!("clearing server data: {e}");
                close(target);
            }
        });
        if started.is_err() {
            let _ = wv.close();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = origin;
        let _ = wv.close();
    }
}

/// Whether the server page `label` may run on a reduced memory budget: nobody sees it and it isn't in a call.
pub fn trim_memory(label: &str, shown: Option<&str>, in_call: Option<&str>) -> bool {
    shown != Some(label) && in_call != Some(label)
}

/// Asks WebView2 to trim the memory of server pages nobody uses right now (see `trim_memory`) and gives the others
/// their normal budget back. Windows only; WebKit has no such knob.
pub fn apply_memory_levels(app: &AppHandle) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows::core::Interface;
        let (shown, in_call) = {
            let shell = app.state::<Shell>();
            let inner = shell.0.lock().unwrap();
            (
                inner.visible.clone(),
                inner.voice.in_call().map(str::to_string),
            )
        };
        let Some(window) = main_window(app) else {
            return;
        };
        for wv in window.webviews() {
            if server_id(wv.label()).is_none() {
                continue;
            }
            let level = if trim_memory(wv.label(), shown.as_deref(), in_call.as_deref()) {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            let _ = wv.with_webview(move |pw| {
                // SAFETY: plain WebView2 COM calls on the main thread, where with_webview runs this.
                let _ = unsafe {
                    pw.controller()
                        .CoreWebView2()
                        .and_then(|core| core.cast::<ICoreWebView2_19>())
                        .and_then(|core| core.SetMemoryUsageTargetLevel(level))
                };
            });
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

pub fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window(MAIN)
}

fn content_size(window: &Window) -> tauri::Result<LogicalSize<f64>> {
    Ok(window.inner_size()?.to_logical(window.scale_factor()?))
}

/// The window's maximized state changed (maximize, restore, snap): tell the title bar. Resizes that keep it are
/// ignored, so dragging the window edge doesn't flood the chrome.
pub fn maximized_changed(app: &AppHandle) {
    let Some(maximized) = main_window(app).and_then(|w| w.is_maximized().ok()) else {
        return;
    };
    let changed = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        std::mem::replace(&mut inner.maximized, maximized) != maximized
    };
    if changed {
        emit_rail_state(app);
    }
}

pub fn create_main_window(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let builder = tauri::window::WindowBuilder::new(app, MAIN)
        .title("Datrope")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .visible(!hidden);
    // Our own title bar: no native one on Windows and Linux; on macOS the traffic lights stay over our bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let window = builder.build()?;
    app.state::<Shell>().0.lock().unwrap().maximized = window.is_maximized().unwrap_or(false);
    let size = content_size(&window)?;
    window.add_child(
        chrome_webview(app, RAIL, "index.html"),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(size.width, TOP_BAR_HEIGHT),
    )?;
    let servers = app.state::<Shell>().0.lock().unwrap().store.servers.clone();
    for s in &servers {
        add_server_webview(app, s)?;
    }
    create_drawer_webview(app)?;
    layout(app)?;
    apply_visibility(app);
    Ok(())
}

/// Opens the screen picker in its own webview over the whole window, replacing an open one. It is transparent and
/// created last, so it stacks above everything and the server page stays visible, live, under its dimmed overlay.
pub fn open_picker_webview(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    close_picker_webview(app);
    let size = content_size(&window)?;
    let wv = window.add_child(
        chrome_webview(app, PICKER, "picker.html").transparent(true),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(size.width, size.height),
    )?;
    wv.set_focus()
}

pub fn close_picker_webview(app: &AppHandle) {
    if let Some(wv) = app.get_webview(PICKER) {
        let _ = wv.close();
    }
}

/// A chrome webview (title bar, drawer) showing the bundled `page`. On Windows it joins the servers' WebView2
/// environment (same data directory, same browser flags), so the chrome starts no browser process group of its own.
fn chrome_webview(app: &AppHandle, label: &str, page: &str) -> WebviewBuilder<tauri::Wry> {
    let b = WebviewBuilder::new(label, WebviewUrl::App(page.into()));
    #[cfg(windows)]
    let b = {
        let data_root = app.state::<Shell>().0.lock().unwrap().data_root.clone();
        let b = b.data_directory(data_root.join(SHARED_DATA));
        match server_browser_args() {
            Some(args) => b.additional_browser_args(args),
            None => b,
        }
    };
    #[cfg(not(windows))]
    let _ = app;
    b
}

/// (Re)creates the hidden drawer webview. Each new child webview goes on top, so after a server webview is added
/// the drawer is closed and created again to stay above it. That happens while the chrome is in full mode (add
/// dialog), so nobody sees it. On Windows, call this from the setup hook or an async command: creating a webview
/// from a sync command can deadlock.
pub fn create_drawer_webview(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    if let Some(old) = app.get_webview(DRAWER) {
        old.close()?;
    }
    {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        inner.drawer_slide += 1;
        inner.drawer_x = -DRAWER_WIDTH;
    }
    let size = content_size(&window)?;
    let bar = selected_bar(&app.state::<Shell>().0.lock().unwrap());
    let r = drawer_rect(size.height, bar);
    let wv = window.add_child(
        chrome_webview(app, DRAWER, "drawer.html"),
        LogicalPosition::new(-DRAWER_WIDTH, r.y),
        LogicalSize::new(r.w, r.h),
    )?;
    wv.hide()?;
    Ok(())
}

/// Records the drawer's x for slide `slide`; false once a newer slide has taken over.
fn drawer_step(app: &AppHandle, slide: u64, x: f64) -> bool {
    let shell = app.state::<Shell>();
    let mut inner = shell.0.lock().unwrap();
    if inner.drawer_slide != slide {
        return false;
    }
    inner.drawer_x = x;
    true
}

/// Slides the drawer in (shown and focused) or out (then hidden), from wherever it is now. Without `animate` it
/// jumps to the end. The slide runs on its own thread and never holds the shell lock across a move or a pause;
/// a newer call stops it.
pub fn slide_drawer(app: &AppHandle, open: bool, animate: bool) {
    let Some(wv) = app.get_webview(DRAWER) else {
        return;
    };
    let (slide, from, bar) = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        inner.drawer_slide += 1;
        (inner.drawer_slide, inner.drawer_x, selected_bar(&inner))
    };
    let to = if open { 0.0 } else { -DRAWER_WIDTH };
    let animate = animate && from != to;
    if open {
        let _ = wv.set_position(LogicalPosition::new(from, bar));
        let _ = wv.show();
        let _ = wv.set_focus();
    }
    let steps = if animate {
        slide_steps(from, to, SLIDE_STEPS)
    } else {
        vec![to]
    };
    let app = app.clone();
    let run = move || {
        let pause = Duration::from_millis(SLIDE_MS / SLIDE_STEPS as u64);
        for &x in &steps {
            if animate {
                std::thread::sleep(pause);
            }
            if !drawer_step(&app, slide, x) {
                return;
            }
            let _ = wv.set_position(LogicalPosition::new(x, bar));
        }
        // Again at the end: a slide out that lost the race may have hidden it after this one showed it.
        let _ = if open { wv.show() } else { wv.hide() };
    };
    if animate {
        std::thread::spawn(run);
    } else {
        run();
    }
}

/// Everything a server page may call. No `core:` permissions: with events, one server could emit into another
/// server's page or listen to the rail. The shell reaches pages through their `desktop_subscribe` channel instead.
pub const SERVER_PERMISSIONS: &[&str] = &[
    "allow-desktop-subscribe",
    "allow-desktop-notify",
    "allow-desktop-set-unread",
    "allow-desktop-voice-state",
    "allow-desktop-ptt-set-key",
    "allow-desktop-server-info",
    "allow-desktop-screen-pick",
    "allow-desktop-screen-stop",
    "allow-desktop-title-bar",
    "allow-desktop-window",
    "allow-desktop-start-drag",
    "allow-desktop-set-theme",
    "allow-desktop-open-url",
];

fn add_server_capability(app: &AppHandle, label: &str, origin: &str) -> tauri::Result<()> {
    let capability = SERVER_PERMISSIONS.iter().fold(
        tauri::ipc::CapabilityBuilder::new(label)
            .remote(format!("{origin}/*"))
            .webview(label),
        |c, p| c.permission(*p),
    );
    app.add_capability(capability)
}

/// Base URL of the bundled app (where `offline.html` lives), from config rather than a live webview URL that may
/// still be about:blank: the dev server in debug builds, otherwise Tauri's custom protocol origin.
pub fn app_base(app: &AppHandle) -> Url {
    if tauri::is_dev() {
        if let Some(url) = &app.config().build.dev_url {
            return url.clone();
        }
    }
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    base.parse().expect("static url")
}

/// Percent-encodes everything but unreserved characters.
fn encode_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn offline_url(app: &AppHandle, s: &Server) -> Option<Url> {
    let mut url = app_base(app).join("offline.html").ok()?;
    url.query_pairs_mut()
        .append_pair("id", &s.id)
        .append_pair("host", &host_of(&s.url));
    let theme = theme_of(&app.state::<Shell>().0.lock().unwrap(), Some(&s.id));
    if !theme.is_empty() {
        let json = serde_json::to_string(&theme).ok()?;
        url.set_fragment(Some(&format!("theme={}", encode_fragment(&json))));
    }
    Some(url)
}

/// Adds the webview for one server, loading the server's own web app. It starts hidden; `apply_visibility` shows it.
pub fn add_server_webview(app: &AppHandle, s: &Server) -> tauri::Result<()> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    let label = server_label(&s.id);
    let origin = s.url.clone();
    let url: Url = origin
        .parse()
        .map_err(|e: url::ParseError| tauri::Error::Anyhow(e.into()))?;
    add_server_capability(app, &label, &origin)?;

    // The bundled app's origin (the offline page lives there): tauri://localhost in release, the dev server in dev.
    let app_origin = app_base(app).origin().ascii_serialization();
    let nav_origin = origin.clone();
    let mic_origin = origin.clone();
    let mut b = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |target| {
            let ok = navigation_allowed(&nav_origin, &app_origin, target);
            if !ok {
                open_external(target);
            }
            ok
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                page_started(webview.app_handle(), webview.label());
            }
        })
        .on_new_window(|target, _features| {
            open_external(&target);
            NewWindowResponse::Deny
        })
        .on_permission_request(move |webview, kind| {
            // Voice needs the microphone: the server's own pages get it without a prompt. Everything else asks.
            if kind == PermissionKind::Microphone && mic_allowed(&mic_origin, webview.url().ok()) {
                PermissionResponse::Allow
            } else {
                PermissionResponse::Default
            }
        });
    if let Some(args) = server_browser_args() {
        b = b.additional_browser_args(args);
    }
    #[cfg(target_os = "macos")]
    {
        let id = uuid::Uuid::parse_str(&s.id).map_err(|e| tauri::Error::Anyhow(e.into()))?;
        b = b.data_store_identifier(*id.as_bytes());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let data_root = app.state::<Shell>().0.lock().unwrap().data_root.clone();
        b = b.data_directory(server_data_dir(&data_root, &s.id));
    }

    let size = content_size(&window)?;
    let (_, page, _) = layout_rects(ChromeMode::Closed, size.width, size.height, TOP_BAR_HEIGHT);
    let wv = window.add_child(
        b,
        LogicalPosition::new(page.x, page.y),
        LogicalSize::new(page.w, page.h),
    )?;
    wv.hide()?;
    spawn_probe(app.clone(), s.clone());
    Ok(())
}

/// Whether a page at `url` is the server at `origin` (not the bundled offline page or anything else).
pub fn mic_allowed(origin: &str, url: Option<Url>) -> bool {
    url.is_some_and(|u| u.origin().ascii_serialization() == origin)
}

/// A server webview started loading a new document: the old page can't report leaving its call any more (reload,
/// sign-out, navigating away), so leave it on its behalf and free the push-to-talk key. Its screen share stops too.
fn page_started(app: &AppHandle, label: &str) {
    crate::screen::page_gone(app, label);
    let (updates, badge_changed, claim_removed) =
        app.state::<Shell>().0.lock().unwrap().page_reset(label);
    for update in &updates {
        if let Some(l) = &update.release {
            crate::ptt::release(app, l);
        }
        if let Some(k) = &update.unregister {
            crate::ptt::unregister(app, k);
        }
    }
    if claim_removed {
        let _ = layout(app);
    }
    if badge_changed || claim_removed {
        emit_rail_state(app);
    }
    if badge_changed {
        crate::tray::refresh(app);
    }
}

/// Sends `{ event, payload }` to a server page over its `desktop_subscribe` channel; nothing if it has none.
pub fn send_to_page(app: &AppHandle, label: &str, event: &str, payload: serde_json::Value) {
    let channel = app
        .state::<Shell>()
        .0
        .lock()
        .unwrap()
        .channels
        .get(label)
        .cloned();
    if let Some(channel) = channel {
        let _ = channel.send(serde_json::json!({ "event": event, "payload": payload }));
    }
}

/// Opens `target` in the system's default handler; only http, https and mailto. Whether it was handed off.
pub fn open_external(target: &Url) -> bool {
    if !matches!(target.scheme(), "http" | "https" | "mailto") {
        return false;
    }
    tauri_plugin_opener::open_url(target.as_str(), None::<&str>).is_ok()
}

/// Checks the server answers; if not, shows the offline page in its webview and greys out its rail icon.
pub fn spawn_probe(app: AppHandle, s: Server) {
    tauri::async_runtime::spawn(async move {
        // Same rule as Retry: a redirect to another origin would be blocked, so it counts as offline.
        let online = matches!(
            crate::servers::probe(&s.url, cfg!(debug_assertions)).await,
            Ok(origin) if origin == s.url
        );
        {
            let shell = app.state::<Shell>();
            let mut inner = shell.0.lock().unwrap();
            if online {
                inner.offline.remove(&s.id);
            } else {
                inner.offline.insert(s.id.clone());
            }
        }
        if !online {
            if let (Some(wv), Some(url)) =
                (app.get_webview(&server_label(&s.id)), offline_url(&app, &s))
            {
                let _ = wv.navigate(url);
            }
        }
        emit_rail_state(&app);
    });
}

/// Sizes the chrome, every server webview and the drawer for the current mode (see `layout_rects`). The drawer's
/// x belongs to its slide (`Inner.drawer_x`, 0 once open); its height follows the window even while hidden.
pub fn layout(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    let size = content_size(&window)?;
    let (mode, drawer_x, bar, claimed) = {
        let shell = app.state::<Shell>();
        let inner = shell.0.lock().unwrap();
        (
            inner.chrome_mode(),
            inner.drawer_x,
            selected_bar(&inner),
            inner.claimed.clone(),
        )
    };
    let (chrome, _, drawer) = layout_rects(mode, size.width, size.height, bar);
    let drawer = Rect {
        x: drawer_x,
        ..drawer.unwrap_or_else(|| drawer_rect(size.height, bar))
    };
    for wv in window.webviews() {
        let r = match wv.label() {
            RAIL => chrome,
            DRAWER => drawer,
            PICKER => Rect::new(0.0, 0.0, size.width, size.height),
            label => {
                let b = bar_for(&claimed, label);
                Rect::new(0.0, b, size.width, size.height - b)
            }
        };
        if wv.label() == RAIL {
            // Nothing to show while the selected page draws the title bar itself (full mode always shows it).
            if !rail_visible(mode, bar) {
                wv.hide()?;
                continue;
            }
            wv.show()?;
        }
        wv.set_position(LogicalPosition::new(r.x, r.y))?;
        wv.set_size(LogicalSize::new(r.w, r.h))?;
    }
    Ok(())
}

/// Shows the selected server's webview and hides the others (all of them while the chrome takes the whole window),
/// and tells pages when they become visible or hidden (the notification focus check uses it).
pub fn apply_visibility(app: &AppHandle) {
    let (show, previous) = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        let show = if inner.chrome_mode() == ChromeMode::Full {
            None
        } else {
            inner.selected.as_deref().map(server_label)
        };
        let previous = std::mem::replace(&mut inner.visible, show.clone());
        (show, previous)
    };
    let Some(window) = main_window(app) else {
        return;
    };
    for wv in window.webviews() {
        if [RAIL, DRAWER, PICKER].contains(&wv.label()) {
            continue;
        }
        let visible = show.as_deref() == Some(wv.label());
        let _ = if visible { wv.show() } else { wv.hide() };
    }
    apply_memory_levels(app);
    if previous != show {
        if let Some(p) = previous {
            send_to_page(app, &p, "visible", serde_json::json!({ "visible": false }));
        }
        if let Some(s) = &show {
            send_to_page(app, s, "visible", serde_json::json!({ "visible": true }));
            if let Some(wv) = app.get_webview(s) {
                let _ = wv.set_focus();
            }
        }
    }
}

/// Gives keyboard focus to the shown server page, so clicking the chrome doesn't leave it unfocused (an unfocused
/// page treats its open channel as unseen and notifies).
pub fn focus_shown(app: &AppHandle) {
    let shown = app.state::<Shell>().0.lock().unwrap().visible.clone();
    if let Some(wv) = shown.and_then(|l| app.get_webview(&l)) {
        let _ = wv.set_focus();
    }
}

/// Applies a chrome mode: lays out the chrome and the servers, slides the drawer in or out (at once without
/// `animate`, and always for full mode) and gives the server page focus once the drawer is closed.
pub fn set_mode(app: &AppHandle, mode: ChromeMode, animate: bool) -> tauri::Result<()> {
    let effective = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        inner.mode = mode;
        inner.chrome_mode()
    };
    layout(app)?;
    apply_visibility(app);
    slide_drawer(
        app,
        effective == ChromeMode::Drawer,
        animate && effective != ChromeMode::Full,
    );
    if effective == ChromeMode::Closed {
        focus_shown(app);
    }
    emit_rail_state(app);
    Ok(())
}

/// Shows server `id`. Picking a server closes the drawer (sliding out with `animate`); a dialog in full mode stays.
pub fn select(app: &AppHandle, id: &str, animate: bool) {
    let closed_drawer = {
        let shell = app.state::<Shell>();
        let mut inner = shell.0.lock().unwrap();
        if inner.store.get(id).is_none() {
            return;
        }
        inner.selected = Some(id.to_string());
        let drawer = inner.mode == ChromeMode::Drawer;
        if drawer {
            inner.mode = ChromeMode::Closed;
        }
        drawer
    };
    let _ = layout(app);
    apply_visibility(app);
    if closed_drawer {
        slide_drawer(app, false, animate);
    }
    focus_shown(app);
    emit_rail_state(app);
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        assert_eq!(server_label("abc"), "server-abc");
        assert_eq!(server_id("server-abc"), Some("abc"));
        assert_eq!(server_id("rail"), None);
    }

    #[test]
    fn rail_state_merges_badges_and_offline() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        let a = inner
            .store
            .add("https://a.example".into(), "A".into())
            .unwrap();
        let b = inner
            .store
            .add("https://b.example".into(), "B".into())
            .unwrap();
        inner.badges.set(
            &a.id,
            crate::state::Badge {
                unread: true,
                mentions: 3,
            },
        );
        inner.offline.insert(b.id.clone());
        inner.selected = Some(b.id.clone());
        let s = rail_state(&inner);
        assert_eq!(s.selected.as_deref(), Some(b.id.as_str()));
        assert_eq!(
            (
                s.servers[0].unread,
                s.servers[0].mentions,
                s.servers[0].online
            ),
            (true, 3, true)
        );
        assert!(!s.servers[1].online);
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("updateReady").is_some(), "camelCase for the rail");
        assert_eq!(json["mode"], "closed");
        assert_eq!(json["maximized"], false);
        assert!(["windows", "macos", "linux"].contains(&json["platform"].as_str().unwrap()));
    }

    #[test]
    fn rail_state_carries_the_selected_servers_theme() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        let a = inner
            .store
            .add("https://a.example".into(), "A".into())
            .unwrap();
        let b = inner
            .store
            .add("https://b.example".into(), "B".into())
            .unwrap();
        let theme =
            |c: &str| std::collections::BTreeMap::from([("background".to_string(), c.to_string())]);
        inner.themes.insert(server_label(&a.id), theme("#111111"));
        inner.themes.insert(server_label(&b.id), theme("#222222"));
        inner.selected = Some(b.id.clone());
        assert_eq!(rail_state(&inner).theme, theme("#222222"));
        inner.selected = None;
        assert!(rail_state(&inner).theme.is_empty());
        assert_eq!(
            encode_fragment(r##"{"a":"#fff"}"##),
            "%7B%22a%22%3A%22%23fff%22%7D"
        );
    }

    #[test]
    fn layout_rects_per_mode() {
        let (w, h) = (1000.0, 600.0);
        let bar = Rect::new(0.0, 0.0, w, TOP_BAR_HEIGHT);
        let page = Rect::new(0.0, TOP_BAR_HEIGHT, w, h - TOP_BAR_HEIGHT);
        assert_eq!(
            layout_rects(ChromeMode::Closed, w, h, TOP_BAR_HEIGHT),
            (bar, page, None)
        );
        assert_eq!(
            layout_rects(ChromeMode::Drawer, w, h, TOP_BAR_HEIGHT),
            (
                bar,
                page,
                Some(Rect::new(
                    0.0,
                    TOP_BAR_HEIGHT,
                    DRAWER_WIDTH,
                    h - TOP_BAR_HEIGHT
                ))
            ),
            "the drawer covers the page's left edge; the page keeps its place and size"
        );
        let (full, _, drawer) = layout_rects(ChromeMode::Full, w, h, TOP_BAR_HEIGHT);
        assert_eq!(full, Rect::new(0.0, 0.0, w, h));
        assert_eq!(drawer, None);
        let (_, tiny, tiny_drawer) = layout_rects(ChromeMode::Drawer, 100.0, 20.0, TOP_BAR_HEIGHT);
        assert!(tiny.w >= 0.0 && tiny.h >= 0.0, "never negative");
        assert!(tiny_drawer.unwrap().h >= 0.0, "never negative");
    }

    #[test]
    fn layout_rects_with_a_claimed_page() {
        let (w, h) = (1000.0, 600.0);
        let (bar, page, drawer) = layout_rects(ChromeMode::Drawer, w, h, 0.0);
        assert_eq!(bar.h, 0.0, "no shell bar when the page draws it");
        assert_eq!(page, Rect::new(0.0, 0.0, w, h), "the page fills the window");
        assert_eq!(
            drawer,
            Some(Rect::new(0.0, 0.0, DRAWER_WIDTH, h)),
            "the drawer starts at the top"
        );
        let (full, _, _) = layout_rects(ChromeMode::Full, w, h, 0.0);
        assert_eq!(
            full,
            Rect::new(0.0, 0.0, w, h),
            "dialogs still take the whole window"
        );
    }

    #[test]
    fn unclaimed_pages_keep_the_shell_bar() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        assert_eq!(bar_height(&inner, "server-a"), TOP_BAR_HEIGHT);
        inner.claimed.insert("server-a".into());
        assert_eq!(bar_height(&inner, "server-a"), 0.0);
        assert!(inner.page_reset("server-a").2, "the claim ended");
        assert_eq!(
            bar_height(&inner, "server-a"),
            TOP_BAR_HEIGHT,
            "a reload must claim again"
        );
    }

    #[test]
    fn the_chrome_shows_only_with_a_bar_or_in_full_mode() {
        assert!(rail_visible(ChromeMode::Full, 0.0));
        assert!(rail_visible(ChromeMode::Full, TOP_BAR_HEIGHT));
        assert!(rail_visible(ChromeMode::Closed, TOP_BAR_HEIGHT));
        assert!(rail_visible(ChromeMode::Drawer, TOP_BAR_HEIGHT));
        assert!(!rail_visible(ChromeMode::Closed, 0.0));
        assert!(!rail_visible(ChromeMode::Drawer, 0.0));
    }

    #[test]
    fn others_badge_sums_the_other_servers() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        let a = inner
            .store
            .add("https://a.example".into(), "A".into())
            .unwrap();
        let b = inner
            .store
            .add("https://b.example".into(), "B".into())
            .unwrap();
        let c = inner
            .store
            .add("https://c.example".into(), "C".into())
            .unwrap();
        inner.badges.set(
            &a.id,
            Badge {
                unread: true,
                mentions: 2,
            },
        );
        inner.badges.set(
            &b.id,
            Badge {
                unread: true,
                mentions: 1,
            },
        );
        inner.badges.set(
            &c.id,
            Badge {
                unread: false,
                mentions: 0,
            },
        );
        assert_eq!(
            others_badge(&inner, &a.id),
            Badge {
                unread: true,
                mentions: 1
            }
        );
        assert_eq!(
            others_badge(&inner, &c.id),
            Badge {
                unread: true,
                mentions: 3
            }
        );
    }

    #[test]
    fn slide_steps_ease_out_to_the_end() {
        let steps = slide_steps(-DRAWER_WIDTH, 0.0, 11);
        assert_eq!(steps.len(), 11);
        assert_eq!(*steps.last().unwrap(), 0.0, "ends exactly at the target");
        assert!(steps.windows(2).all(|p| p[0] <= p[1]), "monotonic");
        assert!(steps[0] > -DRAWER_WIDTH, "the first step already moves");
        // Ease-out: the first step covers more ground than the last one.
        assert!(steps[0] - -DRAWER_WIDTH > steps[10] - steps[9]);

        let back = slide_steps(0.0, -DRAWER_WIDTH, 11);
        assert_eq!(*back.last().unwrap(), -DRAWER_WIDTH);
        assert!(back.windows(2).all(|p| p[0] >= p[1]), "monotonic both ways");

        let odd = slide_steps(-123.4, 7.7, 3);
        assert_eq!(*odd.last().unwrap(), 7.7);
        assert_eq!(slide_steps(-1.0, 0.0, 0), vec![0.0], "at least one step");
    }

    #[test]
    fn no_servers_means_full_chrome() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        inner.mode = ChromeMode::Drawer;
        assert_eq!(inner.chrome_mode(), ChromeMode::Full);
        inner
            .store
            .add("https://a.example".into(), "A".into())
            .unwrap();
        assert_eq!(inner.chrome_mode(), ChromeMode::Drawer);
        inner.mode = ChromeMode::Closed;
        assert_eq!(inner.chrome_mode(), ChromeMode::Closed);
    }

    #[test]
    fn server_pages_get_no_core_permissions() {
        assert!(SERVER_PERMISSIONS.contains(&"allow-desktop-subscribe"));
        assert!(SERVER_PERMISSIONS.contains(&"allow-desktop-open-url"));
        assert!(
            SERVER_PERMISSIONS.iter().all(|p| !p.starts_with("core:")),
            "no events: pages talk to the shell only through commands and their channel"
        );
    }

    #[test]
    fn a_new_page_load_leaves_the_call_and_clears_the_badge() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        voice_change(&mut inner.voice, &mut inner.ptt, "server-a", true);
        inner.ptt.set("server-a", Some("F8".into()));
        inner.ptt.press(true);
        inner.badges.set(
            "a",
            Badge {
                unread: true,
                mentions: 2,
            },
        );
        let (updates, badge_changed, claim_removed) = inner.page_reset("server-a");
        assert!(badge_changed);
        assert!(!claim_removed);
        assert_eq!(inner.badges.get("a"), Badge::default());
        assert_eq!(inner.voice.in_call(), None);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].unregister.as_deref(), Some("F8"));
        assert_eq!(updates[0].release.as_deref(), Some("server-a"));
        assert_eq!(
            inner.ptt.press(true),
            None,
            "the key no longer routes anywhere"
        );

        let (updates, badge_changed, _) = inner.page_reset("server-a");
        assert!(!badge_changed, "a fresh page with no badge changes nothing");
        assert_eq!(updates, [PttUpdate::default()]);
    }

    #[test]
    fn a_new_page_load_elsewhere_keeps_the_call() {
        let mut inner = Inner::new(
            Store::default(),
            "x/servers.json".into(),
            "x/webviews".into(),
        );
        voice_change(&mut inner.voice, &mut inner.ptt, "server-a", true);
        inner.ptt.set("server-a", Some("F8".into()));
        inner.page_reset("server-b");
        assert_eq!(inner.voice.in_call(), Some("server-a"));
        assert_eq!(inner.ptt.press(true), Some(("server-a".into(), true)));
    }

    #[test]
    fn only_the_server_itself_gets_the_microphone() {
        let origin = "https://chat.example.com";
        assert!(mic_allowed(
            origin,
            "https://chat.example.com/channels/1".parse().ok()
        ));
        assert!(!mic_allowed(
            origin,
            "https://evil.example.com/".parse().ok()
        ));
        assert!(!mic_allowed(
            origin,
            "http://tauri.localhost/offline.html".parse().ok()
        ));
        assert!(!mic_allowed(origin, None));
    }

    #[test]
    fn hidden_webviews_are_not_throttled() {
        if cfg!(windows) {
            let args = server_browser_args().unwrap();
            assert!(args.contains("--disable-background-timer-throttling"));
            assert!(args.contains("--disable-renderer-backgrounding"));
            assert!(args.contains("--disable-backgrounding-occluded-windows"));
            assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
            assert!(
                args.contains("msWebOOUI"),
                "keeps Tauri's default WebView2 flags"
            );
        } else {
            assert!(server_browser_args().is_none());
        }
    }

    #[test]
    fn purges_data_dirs_of_removed_servers() {
        let root = std::env::temp_dir().join(format!("datrope-wv-{}", uuid::Uuid::new_v4()));
        let mut store = Store::default();
        let keep = store.add("https://a.example".into(), "A".into()).unwrap();
        std::fs::create_dir_all(root.join(&keep.id)).unwrap();
        std::fs::create_dir_all(root.join(SHARED_DATA)).unwrap();
        std::fs::create_dir_all(root.join("gone")).unwrap();
        purge_orphan_data(&root, &store);
        assert!(!root.join("gone").exists());
        if cfg!(windows) {
            assert!(root.join(SHARED_DATA).exists());
            assert!(
                !root.join(&keep.id).exists(),
                "per-server directories from before the shared one go"
            );
        } else {
            assert!(root.join(&keep.id).exists());
            assert!(!root.join(SHARED_DATA).exists());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn servers_share_one_data_dir_on_windows() {
        let root = Path::new("x/webviews");
        if cfg!(windows) {
            assert_eq!(server_data_dir(root, "a"), server_data_dir(root, "b"));
        } else {
            assert_eq!(server_data_dir(root, "a"), root.join("a"));
        }
    }

    #[test]
    fn only_unused_pages_trim_memory() {
        assert!(!trim_memory("server-a", Some("server-a"), None), "shown");
        assert!(
            !trim_memory("server-a", Some("server-b"), Some("server-a")),
            "in a call"
        );
        assert!(trim_memory("server-a", Some("server-b"), Some("server-c")));
        assert!(
            trim_memory("server-a", None, None),
            "chrome takes the whole window"
        );
    }
}
