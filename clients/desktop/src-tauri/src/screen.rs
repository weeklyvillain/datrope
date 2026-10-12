//! Screen share with our own picker. A server page asks for a capture (`desktop_screen_pick`); the shell lists the
//! screens and windows and lets the user choose in its own chrome, so a server page never sees the list or captures
//! anything the user didn't pick. Frames go to the page through a WebView2 shared buffer (a ring of slots) with a
//! small `{ gen, slot, width, height, timestamp }` message per frame on the page's channel. Windows only for now;
//! elsewhere the page keeps using the browser's own picker.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Frames in flight: the shell writes one slot while the page copies the previous one.
#[cfg_attr(not(windows), allow(dead_code))]
pub const SLOTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Screen,
    Window,
}

/// One thing that can be shared, as the picker shows it. `id` is `screen:<handle>` or `window:<handle>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    /// A `data:image/jpeg` URL, or none if the source couldn't be drawn (some windows refuse).
    pub thumbnail: Option<String>,
}

/// What the picker gets: the sources and which server asks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    pub server: String,
    pub sources: Vec<Source>,
}

pub fn parse_id(id: &str) -> Option<(SourceKind, usize)> {
    let (kind, handle) = id.split_once(':')?;
    let kind = match kind {
        "screen" => SourceKind::Screen,
        "window" => SourceKind::Window,
        _ => return None,
    };
    Some((kind, handle.parse().ok()?))
}

/// The picker that is open: which page asked, what it was offered and where the answer goes.
struct Pick {
    label: String,
    offered: Vec<String>,
    answer: tauri::async_runtime::Sender<Option<String>>,
}

#[derive(Default)]
struct State {
    pick: Option<Pick>,
    session: Option<platform::Session>,
    generation: u64,
}

#[derive(Default)]
pub struct Screen(Mutex<State>);

fn screen(app: &AppHandle) -> &Screen {
    app.state::<Screen>().inner()
}

/// Opens a pick for `label`. A new picker replaces an open one; the old request gets no source.
pub fn open_pick(
    app: &AppHandle,
    label: &str,
    offered: Vec<String>,
) -> tauri::async_runtime::Receiver<Option<String>> {
    let (tx, rx) = tauri::async_runtime::channel(1);
    let old = screen(app).0.lock().unwrap().pick.replace(Pick {
        label: label.to_string(),
        offered,
        answer: tx,
    });
    if let Some(old) = old {
        let _ = old.answer.try_send(None);
    }
    rx
}

/// The picker's answer. Only an id that was offered counts; anything else is a cancel.
pub fn answer_pick(app: &AppHandle, id: Option<String>) {
    let Some(pick) = screen(app).0.lock().unwrap().pick.take() else {
        return;
    };
    let id = id.filter(|id| pick.offered.contains(id));
    let _ = pick.answer.try_send(id);
}

/// Whether a picker is open (a newer request may have replaced the one that just ended).
pub fn picking(app: &AppHandle) -> bool {
    screen(app).0.lock().unwrap().pick.is_some()
}

/// Stops `label`'s capture, if it has one. The capture thread is joined off the caller's thread (this runs from
/// page-load callbacks on the main thread too).
pub fn stop_for(app: &AppHandle, label: &str) {
    let session = {
        let mut state = screen(app).0.lock().unwrap();
        if state.session.as_ref().is_some_and(|s| s.label() == label) {
            state.session.take()
        } else {
            None
        }
    };
    if let Some(s) = session {
        let app = app.clone();
        std::thread::spawn(move || s.stop(&app));
    }
}

/// A server page loaded a new document or was removed: its picker closes with no source and its capture stops.
pub fn page_gone(app: &AppHandle, label: &str) {
    stop_for(app, label);
    let pick = {
        let mut state = screen(app).0.lock().unwrap();
        if state.pick.as_ref().is_some_and(|p| p.label == label) {
            state.pick.take()
        } else {
            None
        }
    };
    if let Some(p) = pick {
        let _ = p.answer.try_send(None);
    }
}

/// Starts capturing `id` for the page `label`: one capture at a time, a new one replaces the old. Returns the
/// generation the page's frame messages and shared buffer carry.
pub fn start(
    app: &AppHandle,
    label: &str,
    id: &str,
    fps: u32,
    frames: Channel<serde_json::Value>,
) -> Result<u64, String> {
    let (kind, handle) = parse_id(id).ok_or("unknown source")?;
    let (old, generation) = {
        let mut state = screen(app).0.lock().unwrap();
        state.generation += 1;
        (state.session.take(), state.generation)
    };
    if let Some(old) = old {
        old.stop(app);
    }
    let session = platform::Session::start(
        app,
        label,
        kind,
        handle,
        fps.clamp(1, 60),
        generation,
        frames,
    )?;
    let replaced = {
        let mut state = screen(app).0.lock().unwrap();
        // Another start may have won while this one was setting up: the newest generation stays.
        if state.generation == generation {
            state.session.replace(session)
        } else {
            Some(session)
        }
    };
    if let Some(s) = replaced {
        s.stop(app);
    }
    Ok(generation)
}

/// The screens and windows to offer. Off Windows there is nothing: the page uses the browser's picker.
pub fn sources() -> Vec<Source> {
    platform::sources()
}

/// The largest size with `w`:`h`'s aspect ratio that fits in `max_w` x `max_h` (never bigger than the original,
/// never zero).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (1, 1);
    }
    let scale = f64::min(max_w as f64 / w as f64, max_h as f64 / h as f64).min(1.0);
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

/// Copies a `width` x `height` BGRA frame whose rows are `pitch` bytes apart into `dst` with tight rows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn copy_rows(src: &[u8], pitch: usize, width: usize, height: usize, dst: &mut [u8]) {
    let row = width * 4;
    for y in 0..height {
        dst[y * row..(y + 1) * row].copy_from_slice(&src[y * pitch..y * pitch + row]);
    }
}

#[cfg(windows)]
mod platform {
    use super::{copy_rows, fit, Source, SourceKind, SLOTS};
    use std::time::{Duration, Instant};
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows::core::{Interface, HSTRING};
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    const THUMB_W: u32 = 320;
    const THUMB_H: u32 = 180;

    /// Shrinks an RGBA image to fit the thumbnail box and encodes it as a `data:image/jpeg` URL.
    fn thumbnail(img: image::RgbaImage) -> Option<String> {
        use base64::Engine;
        let (w, h) = fit(img.width(), img.height(), THUMB_W, THUMB_H);
        let small = image::imageops::thumbnail(&img, w, h);
        let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70)
            .encode_image(&rgb)
            .ok()?;
        Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ))
    }

    pub fn sources() -> Vec<Source> {
        let me = std::process::id();
        let monitors = xcap::Monitor::all().unwrap_or_default();
        let windows: Vec<_> = xcap::Window::all()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| {
                w.pid().is_ok_and(|p| p != me)
                    && !w.is_minimized().unwrap_or(true)
                    && w.title().is_ok_and(|t| !t.trim().is_empty())
                    && w.width().unwrap_or(0) >= 50
                    && w.height().unwrap_or(0) >= 50
            })
            .collect();
        // xcap's handles can't cross threads, so the thumbnails are drawn one after another.
        let screens = monitors.iter().enumerate().filter_map(|(i, m)| {
            Some(Source {
                id: format!("screen:{}", m.id().ok()?),
                kind: SourceKind::Screen,
                name: format!("Screen {}", i + 1),
                thumbnail: m.capture_image().ok().and_then(thumbnail),
            })
        });
        let wins = windows.iter().filter_map(|w| {
            Some(Source {
                id: format!("window:{}", w.id().ok()?),
                kind: SourceKind::Window,
                name: w.title().ok()?.chars().take(200).collect(),
                thumbnail: w.capture_image().ok().and_then(thumbnail),
            })
        });
        screens.chain(wins).collect()
    }

    /// The shared buffer is a COM object of the page's webview: created, posted and closed on the main thread.
    struct Buffer(ICoreWebView2SharedBuffer);
    // SAFETY: only used on the main thread (`with_webview`, `run_on_main_thread`); other threads only carry it.
    unsafe impl Send for Buffer {}

    pub struct Flags {
        /// The shared memory's address and the size of one slot.
        ptr: usize,
        slot_size: usize,
        generation: u64,
        interval: Duration,
        frames: Channel<serde_json::Value>,
    }

    pub struct Handler {
        flags: Flags,
        next: usize,
        last: Option<Instant>,
    }

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = Flags;
        type Error = String;

        fn new(ctx: Context<Flags>) -> Result<Self, String> {
            Ok(Self {
                flags: ctx.flags,
                next: 0,
                last: None,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), String> {
            // The update interval only limits how often Windows offers frames; keep the rate the page asked for.
            let now = Instant::now();
            if self
                .last
                .is_some_and(|t| now - t < self.flags.interval.mul_f64(0.9))
            {
                return Ok(());
            }
            let (w, h) = (frame.width() as usize, frame.height() as usize);
            let (ptr, slot_size) = (self.flags.ptr, self.flags.slot_size);
            if w == 0 || h == 0 || w * h * 4 > slot_size {
                return Ok(()); // bigger than the buffer (a window stretched over several screens): skip
            }
            let timestamp = frame.timestamp().map(|t| t.Duration / 10).unwrap_or(0); // 100 ns -> us
            let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
            let pitch = buffer.row_pitch() as usize;
            let src = buffer.as_raw_buffer();
            let slot = self.next;
            // SAFETY: the shared buffer is SLOTS * slot_size bytes and outlives the capture (it is closed only after
            // the capture thread has been joined); w * h * 4 <= slot_size was checked above.
            let dst = unsafe {
                std::slice::from_raw_parts_mut((ptr + slot * slot_size) as *mut u8, w * h * 4)
            };
            copy_rows(src, pitch, w, h, dst);
            self.next = (slot + 1) % SLOTS;
            self.last = Some(now);
            let _ = self.flags.frames.send(serde_json::json!({
                "gen": self.flags.generation, "slot": slot, "width": w, "height": h, "timestamp": timestamp,
            }));
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), String> {
            let _ = self
                .flags
                .frames
                .send(serde_json::json!({ "gen": self.flags.generation, "ended": true }));
            Ok(())
        }
    }

    pub struct Session {
        label: String,
        control: CaptureControl<Handler, String>,
        buffer: Buffer,
    }

    fn area(w: impl TryInto<usize>, h: impl TryInto<usize>) -> usize {
        w.try_into().unwrap_or(0) * h.try_into().unwrap_or(0)
    }

    impl Session {
        pub fn label(&self) -> &str {
            &self.label
        }

        pub fn start(
            app: &AppHandle,
            label: &str,
            kind: SourceKind,
            handle: usize,
            fps: u32,
            generation: u64,
            frames: Channel<serde_json::Value>,
        ) -> Result<Self, String> {
            let webview = app.get_webview(label).ok_or("no such page")?;
            // Room for the biggest screen, or the source as it is now if that is bigger.
            let biggest = Monitor::enumerate()
                .unwrap_or_default()
                .iter()
                .map(|m| area(m.width().unwrap_or(0), m.height().unwrap_or(0)))
                .max()
                .unwrap_or(0);
            let current = match kind {
                SourceKind::Screen => {
                    let m = Monitor::from_raw_hmonitor(handle as *mut _);
                    area(m.width().unwrap_or(0), m.height().unwrap_or(0))
                }
                SourceKind::Window => {
                    let w = Window::from_raw_hwnd(handle as *mut _);
                    if !w.is_valid() {
                        return Err("That window is gone.".into());
                    }
                    area(w.width().unwrap_or(0), w.height().unwrap_or(0))
                }
            };
            let slot_size = biggest.max(current) * 4;
            if slot_size == 0 {
                return Err("Couldn't measure the screen.".into());
            }
            let buffer = post_buffer(&webview, generation, slot_size)?;
            let mut ptr = std::ptr::null_mut();
            // SAFETY: Buffer() hands out the mapping's address, valid until Close().
            if let Err(e) = unsafe { buffer.0.Buffer(&mut ptr) } {
                close_buffer(app, buffer);
                return Err(e.to_string());
            }
            let interval = Duration::from_secs(1) / fps;
            let flags = Flags {
                ptr: ptr as usize,
                slot_size,
                generation,
                interval,
                frames,
            };
            let started = match kind {
                SourceKind::Screen => Handler::start_free_threaded(settings(
                    Monitor::from_raw_hmonitor(handle as *mut _),
                    interval,
                    flags,
                )),
                SourceKind::Window => Handler::start_free_threaded(settings(
                    Window::from_raw_hwnd(handle as *mut _),
                    interval,
                    flags,
                )),
            };
            match started {
                Ok(control) => Ok(Self {
                    label: label.to_string(),
                    control,
                    buffer,
                }),
                Err(e) => {
                    close_buffer(app, buffer);
                    Err(format!("Couldn't start the capture: {e}"))
                }
            }
        }

        /// Stops capturing, then (with the capture thread gone) closes the shared buffer, which also detaches it
        /// from the page.
        pub fn stop(self, app: &AppHandle) {
            let _ = self.control.stop();
            close_buffer(app, self.buffer);
        }
    }

    fn settings<T: TryInto<GraphicsCaptureItemType>>(
        item: T,
        interval: Duration,
        flags: Flags,
    ) -> Settings<Flags, T> {
        Settings::new(
            item,
            CursorCaptureSettings::WithCursor,
            // Keep Windows' yellow border: it shows what is being shared.
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(interval),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        )
    }

    /// Creates the shared buffer on the main thread and posts it to the page, read-only, tagged with the
    /// generation the frame messages carry.
    fn post_buffer(
        webview: &tauri::Webview,
        generation: u64,
        slot_size: usize,
    ) -> Result<Buffer, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |pw| {
                // SAFETY: plain WebView2 COM calls on the main thread, where with_webview runs this.
                let made = unsafe {
                    (|| -> windows::core::Result<Buffer> {
                        let core = pw.controller().CoreWebView2()?;
                        let env = pw.environment().cast::<ICoreWebView2Environment12>()?;
                        let buffer = env.CreateSharedBuffer((slot_size * SLOTS) as u64)?;
                        let info = serde_json::json!({
                            "datropeScreen": generation, "slots": SLOTS, "slotSize": slot_size,
                        });
                        core.cast::<ICoreWebView2_17>()?.PostSharedBufferToScript(
                            &buffer,
                            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                            &HSTRING::from(info.to_string()),
                        )?;
                        Ok(Buffer(buffer))
                    })()
                };
                let _ = tx.send(made.map_err(|e| e.to_string()));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The page didn't answer.".to_string())?
    }

    fn close_buffer(app: &AppHandle, buffer: Buffer) {
        let _ = app.run_on_main_thread(move || {
            let buffer = buffer; // the whole Send wrapper, not just its (non-Send) field
                                 // SAFETY: on the main thread; nothing writes into it any more.
            let _ = unsafe { buffer.0.Close() };
        });
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{Source, SourceKind};
    use tauri::ipc::Channel;
    use tauri::AppHandle;

    pub fn sources() -> Vec<Source> {
        Vec::new()
    }

    pub struct Session(String);

    impl Session {
        pub fn label(&self) -> &str {
            &self.0
        }

        pub fn start(
            _app: &AppHandle,
            _label: &str,
            _kind: SourceKind,
            _handle: usize,
            _fps: u32,
            _generation: u64,
            _frames: Channel<serde_json::Value>,
        ) -> Result<Self, String> {
            Err("Screen share from the app is only on Windows so far.".into())
        }

        pub fn stop(self, _app: &AppHandle) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse() {
        assert_eq!(parse_id("screen:65537"), Some((SourceKind::Screen, 65537)));
        assert_eq!(parse_id("window:123"), Some((SourceKind::Window, 123)));
        assert_eq!(parse_id("tab:1"), None);
        assert_eq!(parse_id("window:"), None);
        assert_eq!(parse_id("window:-1"), None);
        assert_eq!(parse_id("garbage"), None);
    }

    #[test]
    fn thumbnails_fit_the_box() {
        assert_eq!(fit(1920, 1080, 320, 180), (320, 180));
        assert_eq!(
            fit(1080, 1920, 320, 180),
            (101, 180),
            "portrait keeps its shape"
        );
        assert_eq!(fit(100, 50, 320, 180), (100, 50), "never scaled up");
        assert_eq!(fit(0, 10, 320, 180), (1, 1));
        assert_eq!(fit(10000, 1, 320, 180), (320, 1), "never zero");
    }

    #[test]
    fn rows_lose_their_padding() {
        // 2x2 BGRA frame, rows padded to 12 bytes.
        let src = [
            1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, //
            3, 3, 3, 3, 4, 4, 4, 4, 0, 0, 0, 0,
        ];
        let mut dst = [9u8; 16];
        copy_rows(&src, 12, 2, 2, &mut dst);
        assert_eq!(dst, [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    }

    #[test]
    fn sources_serialize_for_the_picker() {
        let s = Source {
            id: "screen:1".into(),
            kind: SourceKind::Screen,
            name: "Screen 1".into(),
            thumbnail: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "id": "screen:1", "kind": "screen", "name": "Screen 1", "thumbnail": null })
        );
    }
}
