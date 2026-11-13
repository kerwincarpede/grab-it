//! The region and window overlay.
//!
//! Every monitor is frozen first, then shown fullscreen in a borderless
//! window per monitor. The user drags a region, or hovers and clicks a
//! window, on the frozen image; Esc cancels. Selections arrive in the
//! overlay's CSS pixels and are converted with the frozen image's own
//! pixels-per-CSS-pixel, so monitors with different scale factors each crop
//! correctly.

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    actions,
    capture::{self, CaptureMode, CssRect, Foreground, Rect},
    screen::{self, MonitorInfo, WindowInfo},
};

pub const LABEL_PREFIX: &str = "overlay-";

struct Frame {
    monitor: MonitorInfo,
    image: RgbaImage,
}

struct Session {
    /// Tells this session's windows apart from a later session's, which
    /// reuse the same labels.
    id: u64,
    mode: CaptureMode,
    foreground: Foreground,
    /// Frozen monitors, by overlay window label.
    frames: HashMap<String, Frame>,
    /// Visible windows, front to back, in desktop coordinates.
    windows: Vec<WindowInfo>,
}

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    /// A capture was started and the monitors are being frozen.
    Opening,
    Open(Session),
}

#[derive(Default)]
pub struct OverlayState(Mutex<Phase>);

impl OverlayState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Phase> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// True while a selection is starting or on screen.
pub fn is_open(app: &AppHandle) -> bool {
    app.try_state::<OverlayState>()
        .is_some_and(|state| !matches!(*state.lock(), Phase::Idle))
}

/// Claims the overlay for a new selection. False when one is already
/// starting or on screen, so a second hotkey press or tray click does
/// nothing instead of replacing it. Call [`open`] after a true result.
pub fn begin(app: &AppHandle) -> bool {
    let state = app.state::<OverlayState>();
    let mut phase = state.lock();
    if matches!(*phase, Phase::Idle) {
        *phase = Phase::Opening;
        true
    } else {
        false
    }
}

/// Releases a claim from [`begin`] that never got its overlays.
fn abandon(app: &AppHandle) {
    let state = app.state::<OverlayState>();
    let mut phase = state.lock();
    if matches!(*phase, Phase::Opening) {
        *phase = Phase::Idle;
    }
}

/// Freezes every monitor and shows an overlay on each. Expects a claim
/// from [`begin`], and releases it when the overlay cannot be shown.
pub fn open(app: &AppHandle, mode: CaptureMode) -> Result<(), String> {
    let foreground = screen::foreground();
    let windows = screen::windows();
    let frames = match screen::capture_monitors() {
        Ok(frames) => frames,
        Err(err) => {
            abandon(app);
            return Err(err);
        }
    };
    let placements = app.available_monitors().unwrap_or_default();

    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let mut session = Session {
        id,
        mode,
        foreground,
        frames: HashMap::new(),
        windows,
    };
    let mut labels = Vec::new();
    for (monitor, image) in frames {
        let label = format!("{LABEL_PREFIX}{}", monitor.index);
        let placement = placement_for(&monitor, &placements);
        labels.push((label.clone(), placement));
        session.frames.insert(label, Frame { monitor, image });
    }
    *app.state::<OverlayState>().lock() = Phase::Open(session);

    for (label, (position, size)) in labels {
        if let Err(err) = create_window(app, id, &label, position, size) {
            close(app);
            return Err(format!("could not show the capture overlay: {err}"));
        }
    }
    Ok(())
}

/// Where to put a monitor's overlay, in physical pixels.
///
/// xcap and Tauri may report positions in different units (macOS uses
/// points in xcap), so the Tauri monitor is matched by name, then by
/// physical or logical position, and finally by xcap's own numbers.
fn placement_for(
    monitor: &MonitorInfo,
    placements: &[tauri::Monitor],
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let by_name = placements
        .iter()
        .find(|m| m.name().is_some_and(|name| *name == monitor.name));
    let by_position = || {
        placements.iter().find(|m| {
            let pos = m.position();
            let scale = m.scale_factor();
            (pos.x == monitor.x && pos.y == monitor.y)
                || ((f64::from(pos.x) / scale).round() as i32 == monitor.x
                    && (f64::from(pos.y) / scale).round() as i32 == monitor.y)
        })
    };
    match by_name.or_else(by_position) {
        Some(m) => (*m.position(), *m.size()),
        None => (
            PhysicalPosition::new(monitor.x, monitor.y),
            PhysicalSize::new(monitor.width, monitor.height),
        ),
    }
}

fn create_window(
    app: &AppHandle,
    session: u64,
    label: &str,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> tauri::Result<()> {
    let window =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html#/overlay".into()))
            .title("Grab-it capture")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(false)
            .focused(true)
            .build()?;
    #[cfg(target_os = "macos")]
    raise_above_menu_bar(&window)?;
    // Placed after the level change, so the window keeps the monitor's
    // full size, menu bar area included, and the region scale (image width
    // over viewport width) holds vertically too.
    window.set_position(position)?;
    window.set_size(size)?;
    window.show()?;
    window.set_focus()?;

    let app = app.clone();
    window.on_window_event(move |event| {
        // An overlay closed some other way (Alt+F4) ends its selection,
        // but not a later one that reuses the window labels.
        if matches!(event, WindowEvent::Destroyed) {
            close_session(&app, session);
        }
    });
    Ok(())
}

/// macOS: `always_on_top` puts the overlay at the floating level, under the
/// menu bar and the Dock, which would then cover the frozen image. Lift it
/// above both, and let it show over full-screen apps on any Space.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &WebviewWindow) -> tauri::Result<()> {
    /// `NSMainMenuWindowLevel` (24) + 1; the Dock is at 20.
    const ABOVE_MENU_BAR: isize = 25;
    /// `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary`.
    const ALL_SPACES: usize = 1 | (1 << 8);

    let target = window.clone();
    // AppKit windows may only be changed on the main thread. Queued ahead of
    // the position and size changes, which go through the same event loop.
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<objc2::runtime::AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread; both selectors take an NSInteger / NSUInteger.
        unsafe {
            let _: () = objc2::msg_send![ns_window, setLevel: ABOVE_MENU_BAR];
            let _: () = objc2::msg_send![ns_window, setCollectionBehavior: ALL_SPACES];
        }
    })
}

/// Removes every overlay and forgets the frozen images.
pub fn close(app: &AppHandle) {
    let _ = take_session(app);
}

/// Like [`close`], but only while session `id` is the one on screen.
fn close_session(app: &AppHandle, id: u64) {
    let current = {
        let state = app.state::<OverlayState>();
        let phase = state.lock();
        matches!(&*phase, Phase::Open(session) if session.id == id)
    };
    if current {
        close(app);
    }
}

fn take_session(app: &AppHandle) -> Option<Session> {
    // Taken before the windows go, so their `Destroyed` events find nothing.
    let session = {
        let state = app.state::<OverlayState>();
        let mut phase = state.lock();
        match std::mem::take(&mut *phase) {
            Phase::Open(session) => session,
            other => {
                // Idle, or another capture still freezing the monitors.
                *phase = other;
                return None;
            }
        }
    };
    for label in session.frames.keys() {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
    Some(session)
}

/// A window the overlay can highlight, relative to the overlay's monitor in
/// the monitor's own units (`monitorWidth` by `monitorHeight`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayWindow {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInfo {
    pub mode: CaptureMode,
    pub monitor_width: u32,
    pub monitor_height: u32,
    /// Front to back.
    pub windows: Vec<OverlayWindow>,
}

/// Windows that show on `monitor`, moved to the monitor's origin.
pub fn windows_on_monitor(monitor: &MonitorInfo, windows: &[WindowInfo]) -> Vec<OverlayWindow> {
    let bounds = Rect {
        x: 0,
        y: 0,
        width: monitor.width,
        height: monitor.height,
    };
    windows
        .iter()
        .filter_map(|window| {
            let relative = Rect {
                x: window.rect.x - monitor.x,
                y: window.rect.y - monitor.y,
                ..window.rect
            };
            capture::clip_rect(relative, (bounds.width, bounds.height))?;
            Some(OverlayWindow {
                id: window.id,
                title: window.title.clone(),
                app_name: window.app_name.clone(),
                x: relative.x,
                y: relative.y,
                width: relative.width,
                height: relative.height,
            })
        })
        .collect()
}

/// Converts a window's monitor-relative rect into frozen image pixels.
pub fn monitor_to_image_rect(rect: Rect, monitor: &MonitorInfo, image_size: (u32, u32)) -> Rect {
    let sx = if monitor.width > 0 {
        f64::from(image_size.0) / f64::from(monitor.width)
    } else {
        1.0
    };
    let sy = if monitor.height > 0 {
        f64::from(image_size.1) / f64::from(monitor.height)
    } else {
        1.0
    };
    Rect {
        x: (f64::from(rect.x) * sx).round() as i32,
        y: (f64::from(rect.y) * sy).round() as i32,
        width: (f64::from(rect.width) * sx).round() as u32,
        height: (f64::from(rect.height) * sy).round() as u32,
    }
}

/// What the user picked in an overlay.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Selection {
    /// A dragged region in the overlay's CSS pixels, with the overlay's
    /// viewport width to derive the scale.
    #[serde(rename_all = "camelCase")]
    Region { rect: CssRect, viewport_width: f64 },
    /// A window from [`OverlayInfo::windows`].
    Window { id: u32 },
}

#[tauri::command]
pub fn overlay_info(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
) -> Result<OverlayInfo, String> {
    let guard = state.lock();
    let Phase::Open(session) = &*guard else {
        return Err("no capture in progress".into());
    };
    let frame = session
        .frames
        .get(window.label())
        .ok_or("this window is not a capture overlay")?;
    Ok(OverlayInfo {
        mode: session.mode,
        monitor_width: frame.monitor.width,
        monitor_height: frame.monitor.height,
        windows: windows_on_monitor(&frame.monitor, &session.windows),
    })
}

/// The frozen monitor image as PNG bytes.
#[tauri::command]
pub fn overlay_image(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
) -> Result<tauri::ipc::Response, String> {
    let image = {
        let guard = state.lock();
        let Phase::Open(session) = &*guard else {
            return Err("no capture in progress".into());
        };
        let frame = session
            .frames
            .get(window.label())
            .ok_or("this window is not a capture overlay")?;
        frame.image.clone()
    };
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    );
    image
        .write_with_encoder(encoder)
        .map_err(|err| err.to_string())?;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    close(&app);
}

/// Closes the overlays and saves the selection.
#[tauri::command]
pub fn overlay_finish(
    window: WebviewWindow,
    app: AppHandle,
    selection: Selection,
) -> Result<(), String> {
    let session = take_session(&app).ok_or("no capture in progress")?;
    let frame = session
        .frames
        .get(window.label())
        .ok_or("this window is not a capture overlay")?;

    let (image, mode, foreground) = match selection {
        Selection::Region {
            rect,
            viewport_width,
        } => {
            let scale = capture::image_scale(
                frame.image.width(),
                viewport_width,
                frame.monitor.scale_factor,
            );
            let pixels = capture::css_to_image_rect(rect, scale, frame.image.dimensions())
                .ok_or("the selection is empty")?;
            let image = capture::crop(&frame.image, pixels).ok_or("the selection is empty")?;
            (image, CaptureMode::Region, session.foreground.clone())
        }
        Selection::Window { id } => {
            let picked = session
                .windows
                .iter()
                .find(|w| w.id == id)
                .ok_or("the window is no longer there")?;
            (
                window_image(frame, picked)?,
                CaptureMode::Window,
                screen::foreground_of(picked),
            )
        }
    };

    std::thread::spawn(move || actions::finish(&app, &image, mode, &foreground));
    Ok(())
}

/// A window as it looked when the screen froze. A window that spills onto
/// another monitor is captured on its own through xcap instead.
fn window_image(frame: &Frame, window: &WindowInfo) -> Result<RgbaImage, String> {
    let monitor = &frame.monitor;
    let relative = Rect {
        x: window.rect.x - monitor.x,
        y: window.rect.y - monitor.y,
        ..window.rect
    };
    let fits = relative.x >= 0
        && relative.y >= 0
        && relative.x as u32 + relative.width <= monitor.width
        && relative.y as u32 + relative.height <= monitor.height;
    if !fits && let Ok(image) = screen::capture_window(window.id) {
        return Ok(image);
    }
    let pixels = monitor_to_image_rect(relative, monitor, frame.image.dimensions());
    capture::crop(&frame.image, pixels).ok_or_else(|| "the window is off screen".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorInfo {
        MonitorInfo {
            index: 0,
            name: "test".into(),
            x,
            y,
            width,
            height,
            scale_factor: 1.0,
            is_primary: true,
        }
    }

    fn window(id: u32, x: i32, y: i32, width: u32, height: u32) -> WindowInfo {
        WindowInfo {
            id,
            app_name: "app".into(),
            title: "title".into(),
            rect: Rect {
                x,
                y,
                width,
                height,
            },
        }
    }

    #[test]
    fn windows_are_moved_to_the_monitor_origin_and_offscreen_ones_dropped() {
        let right = monitor(1920, 0, 1280, 1024);
        let windows = [
            window(1, 2000, 100, 300, 200),
            window(2, 10, 10, 300, 200),
            window(3, 1800, 0, 300, 200),
        ];
        let shown = windows_on_monitor(&right, &windows);
        let ids: Vec<u32> = shown.iter().map(|w| w.id).collect();
        assert_eq!(ids, vec![1, 3]);
        assert_eq!((shown[0].x, shown[0].y), (80, 100));
        assert_eq!(shown[1].x, -120);
    }

    #[test]
    fn monitor_units_scale_to_image_pixels() {
        // macOS: a 1440x900 point monitor frozen at 2880x1800 pixels.
        let retina = monitor(0, 0, 1440, 900);
        let rect = Rect {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
        };
        assert_eq!(
            monitor_to_image_rect(rect, &retina, (2880, 1800)),
            Rect {
                x: 20,
                y: 40,
                width: 200,
                height: 100
            }
        );
        assert_eq!(monitor_to_image_rect(rect, &retina, (1440, 900)), rect);
    }

    #[test]
    fn picked_windows_are_cropped_from_the_frozen_frame() {
        let frame = Frame {
            monitor: monitor(100, 0, 4, 4),
            image: RgbaImage::from_fn(4, 4, |x, y| image::Rgba([x as u8, y as u8, 0, 255])),
        };
        let image = window_image(&frame, &window(1, 101, 2, 2, 2)).unwrap();
        assert_eq!(image.dimensions(), (2, 2));
        assert_eq!(image.get_pixel(0, 0), &image::Rgba([1, 2, 0, 255]));
    }

    #[test]
    fn selections_deserialize_from_the_frontend() {
        let region: Selection = serde_json::from_str(
            r#"{"kind":"region","rect":{"x":1,"y":2,"width":3,"height":4},"viewportWidth":800}"#,
        )
        .unwrap();
        assert_eq!(
            region,
            Selection::Region {
                rect: CssRect {
                    x: 1.0,
                    y: 2.0,
                    width: 3.0,
                    height: 4.0
                },
                viewport_width: 800.0
            }
        );
        let window: Selection = serde_json::from_str(r#"{"kind":"window","id":7}"#).unwrap();
        assert_eq!(window, Selection::Window { id: 7 });
    }
}
