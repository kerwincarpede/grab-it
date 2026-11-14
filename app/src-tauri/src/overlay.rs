//! The region and window overlay.
//!
//! Every monitor is frozen first, then shown fullscreen in a borderless
//! window per monitor. The user drags a region, or hovers and clicks a
//! window, on the frozen image; Esc cancels. Selections arrive in the
//! overlay's CSS pixels and are converted with the frozen image's own
//! pixels-per-CSS-pixel, so monitors with different scale factors each crop
//! correctly.
//!
//! A selection has to appear the moment it is asked for, so nothing the
//! user waits on is left to do then:
//!
//! - A spare overlay per monitor is kept hidden with its page loaded
//!   ([`prewarm_later`]), so starting a selection creates no window and
//!   loads no page. Monitors without a spare get a window made on the spot.
//! - On macOS the overlay is see-through and is shown as soon as the
//!   monitors are frozen. The frozen image is still being sent to the page
//!   then, and slides in under the dim unnoticed, being the same picture as
//!   the desktop behind it.
//! - Elsewhere an overlay stays hidden until its page has the frozen image
//!   on screen ([`overlay_ready`]), so it replaces the live desktop with an
//!   identical picture instead of flashing an empty webview first.

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    actions,
    capture::{self, CaptureMode, CssRect, Foreground, Rect},
    screen::{self, MonitorInfo, WindowInfo},
};

/// Overlay windows are labelled `overlay-<n>`.
pub const LABEL_PREFIX: &str = "overlay-";

/// Emitted to a spare overlay when a selection starts on it. Mirrors
/// `START_EVENT` in src/overlay/api.ts.
const START_EVENT: &str = "overlay-start";

/// Whether overlays are see-through and shown the moment the monitors are
/// frozen, ahead of their frozen image.
const INSTANT: bool = cfg!(target_os = "macos");

/// The overlay's page. It learns from the address whether its window is
/// see-through, before it paints anything.
const PAGE: &str = if INSTANT {
    "index.html#/overlay?instant"
} else {
    "index.html#/overlay"
};

struct Frame {
    monitor: MonitorInfo,
    image: RgbaImage,
    /// The overlay's page has asked what to show, so it is alive.
    responded: bool,
}

/// What the overlay's selection is for. Mirrors `Intent` in
/// src/overlay/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    /// Save the selection as a capture.
    #[default]
    Capture,
    /// Read the text in the selection and copy it.
    Text,
    /// Copy the colour of the clicked pixel.
    #[serde(rename = "color")]
    Colour,
    /// Record the selection as an animated GIF.
    Record,
}

struct Session {
    /// Tells this session apart from a later one.
    id: u64,
    mode: CaptureMode,
    intent: Intent,
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

/// The last region the user dragged, for "Repeat last region": the monitor
/// it was on and the rectangle in that monitor's image pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct LastRegion {
    pub monitor: MonitorInfo,
    pub rect: Rect,
}

#[derive(Default)]
pub struct LastRegionState(Mutex<Option<LastRegion>>);

impl LastRegionState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<LastRegion>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The monitor a remembered region belongs to, among those connected now:
/// the one with the same name, else the one at the same index, as long as
/// its size is unchanged (the region would not mean the same place on a
/// monitor that was swapped or switched resolution).
pub fn find_monitor<'a>(
    wanted: &MonitorInfo,
    monitors: &'a [MonitorInfo],
) -> Option<&'a MonitorInfo> {
    let same_size = |m: &&MonitorInfo| m.width == wanted.width && m.height == wanted.height;
    monitors
        .iter()
        .filter(same_size)
        .find(|m| m.name == wanted.name)
        .or_else(|| {
            monitors
                .iter()
                .filter(same_size)
                .find(|m| m.index == wanted.index)
        })
}

/// Captures the last dragged region again, as the screen looks now, with
/// its monitor's scale factor.
pub fn capture_last_region(app: &AppHandle) -> Result<(RgbaImage, f64), String> {
    let last = app
        .state::<LastRegionState>()
        .lock()
        .clone()
        .ok_or("Capture a region first, then this captures the same area again.")?;
    let monitors = screen::monitors()?;
    let monitor = find_monitor(&last.monitor, &monitors)
        .ok_or("The monitor the last region was on is no longer connected.")?;
    let image = screen::capture_monitor(monitor.index)?;
    let region = capture::crop(&image, last.rect).ok_or("the last region is off screen")?;
    Ok((region, monitor.scale_factor))
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// A label no overlay has had, so a window on its way out is never
/// mistaken for the one that replaced it.
fn next_label() -> String {
    format!(
        "{LABEL_PREFIX}{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    )
}

/// A hidden overlay with its page already loaded, in place on a monitor
/// and waiting for the next selection.
struct Spare {
    label: String,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Default)]
pub struct SpareState(Mutex<Vec<Spare>>);

impl SpareState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Spare>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// How long after startup or a selection the spares are made, so making
/// them does not compete with what the user is waiting for.
const PREWARM_DELAY: Duration = Duration::from_millis(400);

/// Gets a spare overlay ready on every monitor, shortly and off this
/// thread. Call at startup and whenever a selection has used the spares.
pub fn prewarm_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PREWARM_DELAY);
        prewarm(&app);
    });
}

fn prewarm(app: &AppHandle) {
    static PREWARMING: Mutex<()> = Mutex::new(());

    // On Wayland the desktop's own portal picks the area; no overlay shows.
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return;
    }
    let _one_at_a_time = PREWARMING.lock().unwrap_or_else(|p| p.into_inner());
    // Not under a selection: loading a page would make it stutter, and the
    // selection asks for new spares when it ends.
    if is_open(app) {
        return;
    }
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    let wanted: Vec<_> = monitors
        .iter()
        .map(|monitor| (*monitor.position(), *monitor.size()))
        .collect();

    // A monitor that was unplugged or changed leaves its spare misplaced.
    let stale: Vec<Spare> = {
        let state = app.state::<SpareState>();
        let mut spares = state.lock();
        let (keep, stale) = std::mem::take(&mut *spares)
            .into_iter()
            .partition(|spare| wanted.contains(&(spare.position, spare.size)));
        *spares = keep;
        stale
    };
    for spare in stale {
        if let Some(window) = app.get_webview_window(&spare.label) {
            let _ = window.destroy();
        }
    }

    for (position, size) in wanted {
        let have = app
            .state::<SpareState>()
            .lock()
            .iter()
            .any(|spare| spare.position == position && spare.size == size);
        if have {
            continue;
        }
        let label = next_label();
        match create_window(app, &label, position, size) {
            Ok(_) => app.state::<SpareState>().lock().push(Spare {
                label,
                position,
                size,
            }),
            Err(err) => eprintln!("Grab-it: could not prepare the capture overlay: {err}"),
        }
    }
}

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
pub fn open(app: &AppHandle, mode: CaptureMode, intent: Intent) -> Result<(), String> {
    // The windows are listed beside the capture, not ahead of it, so the
    // overlay waits only for the slower of the two. Both are done before an
    // overlay takes the focus from the window the user was in.
    let listing = std::thread::spawn(|| (screen::foreground(), screen::windows()));
    let frames = match screen::capture_monitors() {
        Ok(frames) => frames,
        Err(err) => {
            abandon(app);
            return Err(err);
        }
    };
    let (foreground, windows) = listing.join().unwrap_or_default();
    let placements = app.available_monitors().unwrap_or_default();

    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let mut session = Session {
        id,
        mode,
        intent,
        foreground,
        frames: HashMap::new(),
        windows,
    };
    let mut spares = std::mem::take(&mut *app.state::<SpareState>().lock());
    let mut warm = Vec::new();
    let mut cold = Vec::new();
    for (monitor, image) in frames {
        let (position, size) = placement_for(&monitor, &placements);
        let spare = spares
            .iter()
            .position(|spare| spare.position == position && spare.size == size)
            .map(|at| spares.swap_remove(at))
            .and_then(|spare| app.get_webview_window(&spare.label));
        let label = match spare {
            Some(window) => {
                let label = window.label().to_owned();
                warm.push(window);
                label
            }
            None => {
                let label = next_label();
                cold.push((label.clone(), position, size));
                label
            }
        };
        session.frames.insert(
            label,
            Frame {
                monitor,
                image,
                responded: false,
            },
        );
    }
    *app.state::<OverlayState>().lock() = Phase::Open(session);

    // Spares left over sit where no monitor is any more.
    for spare in spares {
        if let Some(window) = app.get_webview_window(&spare.label) {
            let _ = window.destroy();
        }
    }

    let shown = (|| -> tauri::Result<()> {
        for window in &warm {
            if INSTANT {
                reveal(window)?;
            }
            // Its page has been waiting for this. One that is still loading
            // misses it, and asks for the selection itself once it is up.
            window.emit_to(window.label(), START_EVENT, ())?;
        }
        for (label, position, size) in &cold {
            let window = create_window(app, label, *position, *size)?;
            if INSTANT {
                reveal(&window)?;
            }
        }
        Ok(())
    })();
    if let Err(err) = shown {
        close(app);
        return Err(format!("could not show the capture overlay: {err}"));
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_TIMEOUT);
        settle(&app, id);
    });
    Ok(())
}

/// How long an overlay's page may take to respond.
const READY_TIMEOUT: Duration = Duration::from_millis(1500);

/// Shows and focuses an overlay that is still hidden.
fn reveal(window: &WebviewWindow) -> tauri::Result<()> {
    if !window.is_visible()? {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

/// Deals with a session `id` whose pages have had their time (a script
/// error, a stalled image), so it is not left holding the claim.
///
/// Overlays still hidden are shown. A see-through one is on screen already,
/// and if its page never came up it is an invisible sheet swallowing every
/// click with no way to dismiss it, so the selection is ended instead.
fn settle(app: &AppHandle, id: u64) {
    let (labels, responded): (Vec<String>, bool) = {
        let state = app.state::<OverlayState>();
        let phase = state.lock();
        match &*phase {
            Phase::Open(session) if session.id == id => (
                session.frames.keys().cloned().collect(),
                session.frames.values().all(|frame| frame.responded),
            ),
            _ => return,
        }
    };
    if INSTANT {
        if !responded {
            close(app);
            actions::report_failure(app, "The capture overlay did not respond. Try again.");
        }
        return;
    }
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = reveal(&window);
        }
    }
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

/// Makes a hidden overlay covering a monitor and starts loading its page.
fn create_window(
    app: &AppHandle,
    label: &str,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(PAGE.into()))
        .title("Grab-it capture")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(true);
    // See-through, so it can be on screen before its page has anything to
    // paint. Matches `INSTANT`.
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true);
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    raise_above_menu_bar(&window)?;
    // Placed after the level change, so the window keeps the monitor's
    // full size, menu bar area included, and the region scale (image width
    // over viewport width) holds vertically too.
    //
    // Sized before it is placed: macOS resizes a window around its
    // bottom-left corner, so resizing after placing it would push its top
    // edge off the screen by the difference in height.
    window.set_size(size)?;
    window.set_position(position)?;

    let app = app.clone();
    let label = label.to_owned();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            forget(&app, &label);
        }
    });
    Ok(window)
}

/// An overlay is gone. Closed some other way than by its selection ending
/// (Alt+F4), it ends that selection; a spare is just no longer one.
fn forget(app: &AppHandle, label: &str) {
    app.state::<SpareState>()
        .lock()
        .retain(|spare| spare.label != label);
    let current = {
        let state = app.state::<OverlayState>();
        let phase = state.lock();
        matches!(&*phase, Phase::Open(session) if session.frames.contains_key(label))
    };
    if current {
        close(app);
    }
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
    // A page is not reused, so the next selection starts from a clean one.
    prewarm_later(app);
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
    pub intent: Intent,
    pub monitor_width: u32,
    pub monitor_height: u32,
    /// The frozen image's width in its own pixels, for sizes shown before
    /// the image itself has arrived.
    pub image_width: u32,
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
    /// A clicked point in the overlay's CSS pixels, for picking a colour.
    #[serde(rename_all = "camelCase")]
    Point { x: f64, y: f64, viewport_width: f64 },
}

/// The image pixel under a point in the overlay's CSS pixels, clamped to
/// the image so a click on the very edge still lands on a pixel.
pub fn css_to_image_point(
    x: f64,
    y: f64,
    scale: f64,
    image_size: (u32, u32),
) -> Option<(u32, u32)> {
    if !(scale.is_finite() && scale > 0.0 && x.is_finite() && y.is_finite()) {
        return None;
    }
    if image_size.0 == 0 || image_size.1 == 0 {
        return None;
    }
    let clamp =
        |value: f64, size: u32| (value * scale).floor().clamp(0.0, f64::from(size - 1)) as u32;
    Some((clamp(x, image_size.0), clamp(y, image_size.1)))
}

/// What this overlay is to show, or `None` for a spare with no selection
/// yet: its page then waits for [`START_EVENT`].
#[tauri::command]
pub fn overlay_info(window: WebviewWindow, state: State<'_, OverlayState>) -> Option<OverlayInfo> {
    let mut guard = state.lock();
    let Phase::Open(session) = &mut *guard else {
        return None;
    };
    let frame = session.frames.get_mut(window.label())?;
    frame.responded = true;
    Some(OverlayInfo {
        mode: session.mode,
        intent: session.intent,
        monitor_width: frame.monitor.width,
        monitor_height: frame.monitor.height,
        image_width: frame.image.width(),
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

/// The page has the frozen image on screen: show its window.
#[tauri::command]
pub fn overlay_ready(window: WebviewWindow, state: State<'_, OverlayState>) -> Result<(), String> {
    let current = matches!(
        &*state.lock(),
        Phase::Open(session) if session.frames.contains_key(window.label())
    );
    if !current {
        return Err("no capture in progress".into());
    }
    reveal(&window).map_err(|err| err.to_string())
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

    if session.intent == Intent::Record {
        let size = frame.image.dimensions();
        let rect = match selection {
            Selection::Region {
                rect,
                viewport_width,
            } => {
                let scale =
                    capture::image_scale(size.0, viewport_width, frame.monitor.scale_factor);
                capture::css_to_image_rect(rect, scale, size)
            }
            Selection::Window { id } => session.windows.iter().find(|w| w.id == id).and_then(|w| {
                let relative = Rect {
                    x: w.rect.x - frame.monitor.x,
                    y: w.rect.y - frame.monitor.y,
                    ..w.rect
                };
                capture::clip_rect(monitor_to_image_rect(relative, &frame.monitor, size), size)
            }),
            Selection::Point { .. } => None,
        }
        .ok_or("the selection is empty")?;
        let monitor = frame.monitor.clone();
        std::thread::spawn(move || {
            if let Err(err) = crate::record::start(&app, &monitor, size, rect) {
                actions::report_failure(&app, &err);
            }
        });
        return Ok(());
    }

    let (image, mode, foreground) = match selection {
        Selection::Point {
            x,
            y,
            viewport_width,
        } => {
            let scale = capture::image_scale(
                frame.image.width(),
                viewport_width,
                frame.monitor.scale_factor,
            );
            let (px, py) = css_to_image_point(x, y, scale, frame.image.dimensions())
                .ok_or("the click was outside the screen")?;
            let pixel = frame.image.get_pixel(px, py).0;
            let rgb = [pixel[0], pixel[1], pixel[2]];
            std::thread::spawn(move || actions::finish_colour(&app, rgb));
            return Ok(());
        }
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
            if session.intent == Intent::Capture {
                *app.state::<LastRegionState>().lock() = Some(LastRegion {
                    monitor: frame.monitor.clone(),
                    rect: pixels,
                });
            }
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

    let intent = session.intent;
    let scale = frame.monitor.scale_factor;
    std::thread::spawn(move || match intent {
        Intent::Text => actions::finish_text(&app, &image),
        Intent::Capture | Intent::Colour | Intent::Record => {
            actions::finish(&app, &image, mode, &foreground, Some(scale))
        }
    });
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
            responded: false,
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

    #[test]
    fn clicked_points_map_to_image_pixels() {
        // 1x: CSS pixels are image pixels.
        assert_eq!(
            css_to_image_point(10.0, 20.0, 1.0, (100, 100)),
            Some((10, 20))
        );
        // 2x: a CSS pixel covers two image pixels; its first one is picked.
        assert_eq!(
            css_to_image_point(10.5, 20.0, 2.0, (400, 400)),
            Some((21, 40))
        );
        // The far edge still lands on the last pixel.
        assert_eq!(
            css_to_image_point(100.0, 100.0, 1.0, (100, 100)),
            Some((99, 99))
        );
        assert_eq!(css_to_image_point(-3.0, 5.0, 1.0, (100, 100)), Some((0, 5)));
        assert_eq!(css_to_image_point(1.0, 1.0, 0.0, (100, 100)), None);
        assert_eq!(css_to_image_point(f64::NAN, 1.0, 1.0, (100, 100)), None);
        assert_eq!(css_to_image_point(1.0, 1.0, 1.0, (0, 0)), None);
    }

    #[test]
    fn point_selections_and_intents_use_the_frontend_spelling() {
        let point: Selection =
            serde_json::from_str(r#"{"kind":"point","x":3.5,"y":4,"viewportWidth":1280}"#).unwrap();
        assert_eq!(
            point,
            Selection::Point {
                x: 3.5,
                y: 4.0,
                viewport_width: 1280.0
            }
        );
        assert_eq!(serde_json::to_value(Intent::Colour).unwrap(), "color");
        assert_eq!(serde_json::to_value(Intent::Text).unwrap(), "text");
        assert_eq!(serde_json::to_value(Intent::Capture).unwrap(), "capture");
        assert_eq!(serde_json::to_value(Intent::Record).unwrap(), "record");
    }

    #[test]
    fn a_remembered_region_finds_its_monitor_again() {
        let monitor = |index: usize, name: &str, width: u32| MonitorInfo {
            index,
            name: name.into(),
            x: 0,
            y: 0,
            width,
            height: 1080,
            scale_factor: 1.0,
            is_primary: index == 0,
        };
        let wanted = monitor(1, "DP-2", 1920);
        // Found by name even after the monitors were reordered.
        let reordered = [monitor(0, "DP-2", 1920), monitor(1, "HDMI-1", 1920)];
        assert_eq!(find_monitor(&wanted, &reordered).map(|m| m.index), Some(0));
        // A renamed output falls back to the same position.
        let renamed = [monitor(0, "eDP-1", 2560), monitor(1, "DP-3", 1920)];
        assert_eq!(find_monitor(&wanted, &renamed).map(|m| m.index), Some(1));
        // A different resolution is a different place: not found.
        let resized = [monitor(0, "eDP-1", 2560), monitor(1, "DP-2", 2560)];
        assert_eq!(find_monitor(&wanted, &resized), None);
        assert_eq!(find_monitor(&wanted, &[]), None);
    }
}
