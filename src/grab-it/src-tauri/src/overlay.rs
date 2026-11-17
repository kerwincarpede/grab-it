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
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::{
    actions,
    capture::{self, CaptureMode, CapturedPointer, CssRect, Foreground, Rect},
    screen::{self, MonitorInfo, WindowInfo},
    settings::AfterCapture,
};

/// Overlay windows are labelled `overlay-<n>`.
pub const LABEL_PREFIX: &str = "overlay-";

/// Emitted to a spare overlay when a selection starts on it. Mirrors
/// `START_EVENT` in src/overlay/api.ts.
const START_EVENT: &str = "overlay-start";

/// Emitted to every overlay of an All-in-one selection when one of them
/// changes the toolbar's mode or Timer, with the [`Choice`]. Mirrors
/// `CHOICE_EVENT` in src/overlay/api.ts.
const CHOICE_EVENT: &str = "overlay-choice";

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

/// A frozen monitor as an image file for its overlay's page, or why it
/// could not be encoded. Filled in once, off the main thread.
type Encoded = Arc<OnceLock<Result<Vec<u8>, String>>>;

struct Frame {
    monitor: MonitorInfo,
    image: Arc<RgbaImage>,
    /// `image` for the page ([`encode_for_page`]), being written from the
    /// moment the monitor froze.
    encoded: Encoded,
    /// The overlay's page has asked what to show, so it is alive.
    responded: bool,
}

/// What the overlay's selection is for. Mirrors `Intent` in
/// src/overlay/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Record the selection as an MP4 or an animated GIF.
    Record,
    /// Stitch manually scrolled frames of the selected area.
    Scroll,
}

struct Session {
    /// Tells this session apart from a later one.
    id: u64,
    mode: CaptureMode,
    intent: Intent,
    /// Opened by All-in-one: the page shows its mode toolbar, and
    /// [`overlay_finish`] takes the mode and intent chosen there.
    all_in_one: bool,
    /// What the toolbar last chose on any monitor, so every overlay
    /// finishes the same way whichever one the selection is made on.
    choice: Option<Choice>,
    foreground: Foreground,
    /// macOS: the app that was active when the overlay opened, given the
    /// focus back when it closes ([`give_back_focus`]).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    previous_app: Option<u32>,
    /// Frozen monitors, by overlay window label.
    frames: HashMap<String, Frame>,
    /// Visible windows, front to back, in desktop coordinates.
    windows: Vec<WindowInfo>,
    /// The mouse pointer as the monitors froze.
    /// Boxed, so an open session stays small beside the other phases.
    pointer: Option<Box<crate::pointer::Snapshot>>,
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
/// its monitor's scale factor and the mouse pointer in it.
pub fn capture_last_region(
    app: &AppHandle,
) -> Result<(RgbaImage, f64, Option<CapturedPointer>), String> {
    let last = app
        .state::<LastRegionState>()
        .lock()
        .clone()
        .ok_or("Capture a region first, then this captures the same area again.")?;
    let monitors = screen::monitors()?;
    let monitor = find_monitor(&last.monitor, &monitors)
        .ok_or("The monitor the last region was on is no longer connected.")?;
    let snapshot = crate::pointer::snapshot();
    let image = screen::capture_monitor(monitor.index)?;
    let region = capture::crop(&image, last.rect).ok_or("the last region is off screen")?;
    let pointer = snapshot.and_then(|snapshot| {
        snapshot.place_on_monitor(monitor, image.dimensions(), Some(last.rect))
    });
    Ok((region, monitor.scale_factor, pointer))
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
        .map(|monitor| (*monitor.position(), *monitor.size(), monitor.scale_factor()))
        .collect();

    // A monitor that was unplugged or changed leaves its spare misplaced.
    let stale: Vec<Spare> = {
        let state = app.state::<SpareState>();
        let mut spares = state.lock();
        let (keep, stale) = std::mem::take(&mut *spares).into_iter().partition(|spare| {
            wanted
                .iter()
                .any(|&(position, size, _)| (spare.position, spare.size) == (position, size))
        });
        *spares = keep;
        stale
    };
    for spare in stale {
        if let Some(window) = app.get_webview_window(&spare.label) {
            let _ = window.destroy();
        }
    }

    for (position, size, scale) in wanted {
        let have = app
            .state::<SpareState>()
            .lock()
            .iter()
            .any(|spare| spare.position == position && spare.size == size);
        if have {
            continue;
        }
        let label = next_label();
        match create_window(app, &label, position, size, scale) {
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
/// `all_in_one` gives the overlay its mode toolbar.
pub fn open(
    app: &AppHandle,
    mode: CaptureMode,
    intent: Intent,
    all_in_one: bool,
) -> Result<(), String> {
    // The windows are listed beside the capture, not ahead of it, so the
    // overlay waits only for the slower of the two. Both are done before an
    // overlay takes the focus from the window the user was in.
    let started = Instant::now();
    let listing = std::thread::spawn(move || {
        let listed = screen::desktop();
        trace(format_args!("windows listed in {:?}", started.elapsed()));
        listed
    });
    let frames = match screen::capture_monitors() {
        Ok(frames) => frames,
        Err(err) => {
            abandon(app);
            return Err(err);
        }
    };
    let pointer = crate::pointer::snapshot().map(Box::new);
    trace(format_args!("monitors frozen in {:?}", started.elapsed()));
    let desktop = listing.join().unwrap_or_default();
    let placements = app.available_monitors().unwrap_or_default();

    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let mut session = Session {
        id,
        mode,
        intent,
        all_in_one,
        choice: None,
        foreground: desktop.foreground,
        previous_app: desktop.active_app,
        frames: HashMap::new(),
        windows: desktop.windows,
        pointer,
    };
    let mut spares = std::mem::take(&mut *app.state::<SpareState>().lock());
    let mut warm = Vec::new();
    let mut cold = Vec::new();
    // The overlay on the display the pointer is on is shown last, so it
    // takes the keyboard.
    let mut pointer_label = None;
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
                let scale = placement_scale(&monitor, &placements);
                cold.push((label.clone(), position, size, scale));
                label
            }
        };
        if pointer_label.is_none() && crate::record_bar::pointer_on(app, &monitor) {
            pointer_label = Some(label.clone());
        }
        let image = Arc::new(image);
        session.frames.insert(
            label,
            Frame {
                monitor,
                encoded: encode_later(&image, started),
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
        let under_pointer = |label: &str| pointer_label.as_deref() == Some(label);
        let mut last = None;
        for window in &warm {
            if INSTANT {
                if under_pointer(window.label()) {
                    last = Some(window.clone());
                } else {
                    reveal(window)?;
                }
            }
            // Its page has been waiting for this. One that is still loading
            // misses it, and asks for the selection itself once it is up.
            window.emit_to(window.label(), START_EVENT, ())?;
        }
        for (label, position, size, scale) in &cold {
            let window = create_window(app, label, *position, *size, *scale)?;
            if INSTANT {
                if under_pointer(label) {
                    last = Some(window);
                } else {
                    reveal(&window)?;
                }
            }
        }
        // Shown last, so it is the key window and a key press reaches the
        // overlay the user is looking at.
        if let Some(window) = last {
            reveal(&window)?;
        }
        Ok(())
    })();
    if let Err(err) = shown {
        close(app);
        return Err(format!("could not show the capture overlay: {err}"));
    }

    trace(format_args!("overlay shown in {:?}", started.elapsed()));

    follow_pointer(app, id);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_TIMEOUT);
        settle(&app, id);
    });
    Ok(())
}

/// How often the pointer is checked for a move to another display's
/// overlay: a frame at 60 Hz.
#[cfg(target_os = "macos")]
const FOLLOW_INTERVAL: Duration = Duration::from_millis(16);

/// macOS: while session `id` is open, gives the overlay under the pointer
/// the focus as the pointer moves from display to display
/// ([`crate::panel::focus_under_pointer`]), so the crosshair, loupe and
/// window highlight follow it.
#[cfg(target_os = "macos")]
fn follow_pointer(app: &AppHandle, id: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(FOLLOW_INTERVAL);
            let labels: Vec<String> = match &*app.state::<OverlayState>().lock() {
                Phase::Open(session) if session.id == id => {
                    session.frames.keys().cloned().collect()
                }
                _ => return,
            };
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let windows: Vec<WebviewWindow> = labels
                    .iter()
                    .filter_map(|label| handle.get_webview_window(label))
                    .collect();
                crate::panel::focus_under_pointer(&windows);
            });
        }
    });
}

/// Windows and Linux send pointer moves to the window under the pointer,
/// focused or not.
#[cfg(not(target_os = "macos"))]
fn follow_pointer(_app: &AppHandle, _id: u64) {}

/// Prints how long the steps of opening an overlay took, when
/// `GRAB_IT_TRACE_OVERLAY` is set.
fn trace(message: std::fmt::Arguments<'_>) {
    static ON: OnceLock<bool> = OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("GRAB_IT_TRACE_OVERLAY").is_some()) {
        eprintln!("Grab-it overlay: {message}");
    }
}

/// Starts encoding `image` for the page on its own thread, so the page's
/// request for it finds it done or nearly done, and the main thread never
/// encodes.
fn encode_later(image: &Arc<RgbaImage>, started: Instant) -> Encoded {
    let encoded = Encoded::default();
    let (image, out) = (Arc::clone(image), Arc::clone(&encoded));
    std::thread::spawn(move || {
        let _ = out.set(encode_for_page(&image));
        trace(format_args!(
            "frozen image encoded in {:?}",
            started.elapsed()
        ));
    });
    encoded
}

/// `image` as the overlay's page is sent it: an uncompressed BMP on macOS,
/// where WebKit took about 100 ms to decode a 5K screen as PNG (the loupe
/// and the hover blur have nothing to draw until then) and under 30 ms as
/// a BMP. Elsewhere a PNG, until the BMP has been tried in those webviews.
fn encode_for_page(image: &RgbaImage) -> Result<Vec<u8>, String> {
    if cfg!(target_os = "macos") {
        encode_bmp(image)
    } else {
        encode_png(image)
    }
}

/// `image` as an uncompressed BMP. The frozen image only travels to the
/// page, so nothing is gained by compressing it. The pixels are stored
/// top-down in the image's own RGBA order, with bit masks saying so, so
/// writing it is one copy. A BITMAPV5HEADER, since macOS's ImageIO refuses
/// bit masks with alpha in the older headers.
fn encode_bmp(image: &RgbaImage) -> Result<Vec<u8>, String> {
    const FILE_HEADER: u32 = 14;
    const INFO_HEADER: u32 = 124;
    const OFFSET: u32 = FILE_HEADER + INFO_HEADER;
    /// `BI_BITFIELDS`: the channels are where the masks say.
    const BITFIELDS: u32 = 3;
    /// `LCS_sRGB`, as the bytes spell it.
    const SRGB: u32 = 0x7352_4742;
    /// `LCS_GM_IMAGES`: perceptual rendering.
    const PERCEPTUAL: u32 = 4;

    let (width, height) = image.dimensions();
    let too_large = || "the screen is too large to send to the overlay".to_string();
    let pixels = image.as_raw();
    let data_size = u32::try_from(pixels.len()).map_err(|_| too_large())?;
    let file_size = data_size.checked_add(OFFSET).ok_or_else(too_large)?;
    let width = i32::try_from(width).map_err(|_| too_large())?;
    // Negative: the first row is the top one.
    let height = i32::try_from(height)
        .map_err(|_| too_large())?
        .wrapping_neg();

    let mut bmp = Vec::with_capacity(file_size as usize);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&OFFSET.to_le_bytes());
    bmp.extend_from_slice(&INFO_HEADER.to_le_bytes());
    bmp.extend_from_slice(&width.to_le_bytes());
    bmp.extend_from_slice(&height.to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes()); // planes
    bmp.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    bmp.extend_from_slice(&BITFIELDS.to_le_bytes());
    bmp.extend_from_slice(&data_size.to_le_bytes());
    bmp.extend_from_slice(&2835u32.to_le_bytes()); // 72 dpi, in pixels per metre
    bmp.extend_from_slice(&2835u32.to_le_bytes());
    bmp.extend_from_slice(&[0; 8]); // palette: none
    // Red, green, blue and alpha masks: bytes 0 to 3 of each pixel.
    for mask in [0x0000_00ffu32, 0x0000_ff00, 0x00ff_0000, 0xff00_0000] {
        bmp.extend_from_slice(&mask.to_le_bytes());
    }
    bmp.extend_from_slice(&SRGB.to_le_bytes());
    bmp.extend_from_slice(&[0; 36 + 12]); // endpoints and gamma, unused with sRGB
    bmp.extend_from_slice(&PERCEPTUAL.to_le_bytes());
    bmp.extend_from_slice(&[0; 12]); // no embedded profile; reserved
    debug_assert_eq!(bmp.len(), OFFSET as usize);
    bmp.extend_from_slice(pixels);
    Ok(bmp)
}

/// `image` as PNG, compressed lightly: it only travels to the page.
fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    );
    image
        .write_with_encoder(encoder)
        .map_err(|err| err.to_string())?;
    Ok(png)
}

/// How long an overlay's page may take to respond.
const READY_TIMEOUT: Duration = Duration::from_millis(1500);

/// Shows and focuses an overlay that is still hidden. On macOS it takes
/// the keyboard without activating Grab-it ([`crate::panel`]).
fn reveal(window: &WebviewWindow) -> tauri::Result<()> {
    if !window.is_visible()? {
        window.show()?;
        #[cfg(target_os = "macos")]
        crate::panel::focus(window)?;
        #[cfg(not(target_os = "macos"))]
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
pub(crate) fn placement_for(
    monitor: &MonitorInfo,
    placements: &[tauri::Monitor],
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    match placement_monitor(monitor, placements) {
        Some(m) => (*m.position(), *m.size()),
        None => (
            PhysicalPosition::new(monitor.x, monitor.y),
            PhysicalSize::new(monitor.width, monitor.height),
        ),
    }
}

/// The scale of the display a monitor's overlay is placed on, to turn
/// [`placement_for`] into points on macOS. xcap's own numbers, used when
/// no Tauri monitor matches, are taken as they are.
fn placement_scale(monitor: &MonitorInfo, placements: &[tauri::Monitor]) -> f64 {
    placement_monitor(monitor, placements).map_or(1.0, tauri::Monitor::scale_factor)
}

/// The Tauri monitor that xcap's `monitor` is, by name, else by physical
/// or logical position.
fn placement_monitor<'a>(
    monitor: &MonitorInfo,
    placements: &'a [tauri::Monitor],
) -> Option<&'a tauri::Monitor> {
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
    by_name.or_else(by_position)
}

/// A display's frame, given in physical pixels at the display's own
/// `scale`, in logical points.
///
/// macOS: tao builds a monitor's physical frame from that monitor's scale,
/// but turns a physical size or position for a window back into points
/// with the scale of the screen the window is on now. Where the scales
/// differ the window lands at half or double the right place, so overlays
/// are placed in points instead. A scale that is not a positive number
/// counts as 1.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn logical_frame(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (
        LogicalPosition::new(f64::from(position.x) / scale, f64::from(position.y) / scale),
        LogicalSize::new(
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        ),
    )
}

/// Makes a hidden overlay covering a monitor and starts loading its page.
/// `position` and `size` are the monitor's frame in physical pixels at its
/// own `scale`.
fn create_window(
    app: &AppHandle,
    label: &str,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(PAGE.into()))
        .title("Grab-it capture")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(true)
        // A click on an overlay that is not the key window starts a drag
        // rather than only making it key, so any display takes the first
        // drag.
        .accept_first_mouse(true);
    // See-through, so it can be on screen before its page has anything to
    // paint. Matches `INSTANT`. Not focused: wry activates Grab-it for a
    // focused webview as it is made, even in a hidden window, and the
    // spares are made in the background. `panel::focus` gives the page the
    // keyboard when the overlay shows.
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true).focused(false);
    // The setup toolbar's Refresh camera list opens a camera for a moment
    // to read the cameras' names.
    let builder = crate::webcam::allow_camera(builder);
    let window = builder.build()?;
    if let Err(err) = crate::webcam::enable_media_streams(&window) {
        eprintln!("Grab-it: could not let the overlay list the cameras: {err}");
    }
    // A panel, so showing it does not activate Grab-it and bring the
    // library or Settings forward from under it.
    #[cfg(target_os = "macos")]
    crate::panel::make_panel(&window)?;
    #[cfg(target_os = "macos")]
    raise_above_menu_bar(&window)?;
    #[cfg(target_os = "macos")]
    render_at_display_rate(&window)?;
    // Placed after the level change, so the window keeps the monitor's
    // full size, menu bar area included, and the region scale (image width
    // over viewport width) holds vertically too.
    //
    // Sized before it is placed: macOS resizes a window around its
    // bottom-left corner, so resizing after placing it would push its top
    // edge off the screen by the difference in height.
    //
    // macOS places it in the display's points ([`logical_frame`]); Windows
    // and Linux place it in pixels.
    #[cfg(target_os = "macos")]
    {
        let (position, size) = logical_frame(position, size, scale);
        window.set_size(size)?;
        window.set_position(position)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        window.set_size(size)?;
        window.set_position(position)?;
    }

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

/// macOS: WebKit draws a page at most 60 times a second by default, even on
/// a 120 Hz ProMotion display, so a selection dragged with a 120 Hz pointer
/// moved in steps behind the cursor. The overlay is told to keep up with
/// the display instead. The switch is WebKit's internal "Prefer Page
/// Rendering Updates near 60fps" feature; where a WebKit does not have it,
/// nothing changes.
#[cfg(target_os = "macos")]
fn render_at_display_rate(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    const FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

    window.with_webview(|webview| {
        let web_view = webview.inner().cast::<AnyObject>();
        if web_view.is_null() {
            return;
        }
        let Some(class) = AnyClass::get(c"WKPreferences") else {
            return;
        };
        let wanted = NSString::from_str(FEATURE);
        // SAFETY: `web_view` is this window's live WKWebView, used on the
        // main thread, where `with_webview` runs. The private selectors are
        // only sent after checking they exist; `_features` is an NSArray of
        // `_WKFeature`, each with an NSString `key`.
        unsafe {
            let has: Bool = objc2::msg_send![class, respondsToSelector: objc2::sel!(_features)];
            if !has.as_bool() {
                return;
            }
            let configuration: *mut AnyObject = objc2::msg_send![web_view, configuration];
            if configuration.is_null() {
                return;
            }
            let preferences: *mut AnyObject = objc2::msg_send![configuration, preferences];
            if preferences.is_null() {
                return;
            }
            let can_set: Bool = objc2::msg_send![
                preferences,
                respondsToSelector: objc2::sel!(_setEnabled:forFeature:)
            ];
            if !can_set.as_bool() {
                return;
            }
            let features: *mut AnyObject = objc2::msg_send![class, _features];
            if features.is_null() {
                return;
            }
            let count: usize = objc2::msg_send![features, count];
            for index in 0..count {
                let feature: *mut AnyObject = objc2::msg_send![features, objectAtIndex: index];
                let key: *mut AnyObject = objc2::msg_send![feature, key];
                if key.is_null() {
                    continue;
                }
                let same: Bool = objc2::msg_send![key, isEqualToString: &*wanted];
                if same.as_bool() {
                    let _: () = objc2::msg_send![
                        preferences,
                        _setEnabled: Bool::NO,
                        forFeature: feature
                    ];
                    return;
                }
            }
        }
    })
}

/// Removes every overlay and forgets the frozen images, and gives the
/// focus back to the app the user was in.
pub fn close(app: &AppHandle) {
    let _ = take_session(app, |_| true);
}

/// macOS: makes the app that was active when `session` opened active
/// again, in case something activated Grab-it meanwhile
/// ([`crate::panel::reactivate`]). Elsewhere the window manager gives the
/// focus back itself.
fn give_back_focus(app: &AppHandle, session: &Session) {
    #[cfg(target_os = "macos")]
    if let Some(pid) = session.previous_app {
        crate::panel::reactivate(app, pid);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, session);
}

/// Ends the selection: takes its session and removes its overlays, giving
/// the focus back first when `give_back` says so for the session.
fn take_session(app: &AppHandle, give_back: impl FnOnce(&Session) -> bool) -> Option<Session> {
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
    // Before the windows go, so an active Grab-it does not move the focus
    // to another of its windows on the way.
    if give_back(&session) {
        give_back_focus(app, &session);
    }
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
    /// Opened by All-in-one: show the mode toolbar.
    pub all_in_one: bool,
    /// What the toolbar has chosen so far on another monitor, for a page
    /// that loads after the choice was made.
    pub choice: Option<Choice>,
    pub monitor_width: u32,
    pub monitor_height: u32,
    /// The frozen image's width in its own pixels, for sizes shown before
    /// the image itself has arrived.
    pub image_width: u32,
    /// Front to back.
    pub windows: Vec<OverlayWindow>,
    /// How far down the monitor the menu bar or a camera notch reaches, as
    /// a share of its height (0 to 0.2): the hint goes below it.
    pub top_inset: f64,
    /// The last region captured, in this monitor's frozen image pixels,
    /// when it was on this monitor. Only an All-in-one overlay gets one: it
    /// starts with the region selected.
    pub last_region: Option<Rect>,
    /// The pointer was on this monitor when the page asked: the Record
    /// overlay's setup toolbar shows here, and Screen starts picked here.
    pub pointer_here: bool,
    /// Where the recording toolbar would open on this monitor, as the
    /// centre of its pill in the page's CSS pixels: the setup toolbar opens
    /// centred on it. `None` when the monitor cannot be told.
    pub bar_centre: Option<crate::record_bar::CssPoint>,
    /// The monitor's name, shown when Screen records it.
    pub monitor_name: String,
}

/// The last region as a starting selection for an overlay on `monitor`
/// whose frozen image is `image_size`: in that image's pixels, or `None`
/// when it was on another monitor or no longer fits on this one.
///
/// The region's monitor is found among every frozen monitor (`monitors`),
/// as Repeat last region finds it, so a name match on one monitor wins over
/// an index match on another and only one overlay offers it.
pub fn last_region_on(
    last: Option<&LastRegion>,
    monitor: &MonitorInfo,
    monitors: &[MonitorInfo],
    image_size: (u32, u32),
) -> Option<Rect> {
    let last = last?;
    let found = find_monitor(&last.monitor, monitors)?;
    if found.index != monitor.index || found.name != monitor.name {
        return None;
    }
    let clipped = capture::clip_rect(last.rect, image_size)?;
    // Cut short by the edge, it would not be the same region any more.
    (clipped == last.rect).then_some(clipped)
}

/// On macOS, how much of a window that is cut off by its monitor's edge has
/// to show, across and down in points, for the overlay to offer it there.
/// AeroSpace hides the windows of other workspaces by moving them into a
/// corner of the screen with a pixel or so left on it, and the window
/// server still lists them as on screen. Elsewhere any part will do.
const MIN_VISIBLE: u32 = if cfg!(target_os = "macos") { 16 } else { 1 };

/// Whether a window whose part on a monitor is `visible`, out of `whole`,
/// shows enough there to be picked: all of it, or at least `min` across
/// and down.
fn shows_enough(visible: Rect, whole: Rect, min: u32) -> bool {
    visible == whole || (visible.width >= min && visible.height >= min)
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
            let visible = capture::clip_rect(relative, (bounds.width, bounds.height))?;
            if !shows_enough(visible, relative, MIN_VISIBLE) {
                return None;
            }
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
    /// Every frozen monitor, stitched. Only All-in-one's Screen mode
    /// sends it.
    Screen,
}

/// What an All-in-one overlay's toolbar chose, sent with its selection.
/// An overlay opened for one mode has no toolbar, and this is ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub intent: Option<Intent>,
    pub mode: Option<CaptureMode>,
    /// The Timer: how long to wait, with the overlay closed, before the
    /// chosen area is captured as it looks then.
    pub delay_seconds: Option<u64>,
}

/// The longest Timer the toolbar offers.
const MAX_DELAY_SECONDS: u64 = 10;

/// What a finished selection is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Resolved {
    intent: Intent,
    mode: CaptureMode,
    /// Only screenshots wait: text, colours and recordings start at once.
    delay: Option<Duration>,
}

/// The session's own intent and mode, or in an All-in-one overlay the ones
/// its toolbar chose.
fn resolve(
    all_in_one: bool,
    intent: Intent,
    mode: CaptureMode,
    choice: Option<Choice>,
) -> Resolved {
    let choice = choice.filter(|_| all_in_one).unwrap_or_default();
    let intent = choice.intent.unwrap_or(intent);
    let mode = choice.mode.unwrap_or(mode);
    let delay = choice
        .delay_seconds
        .filter(|seconds| *seconds > 0 && intent == Intent::Capture)
        .map(|seconds| Duration::from_secs(seconds.min(MAX_DELAY_SECONDS)));
    Resolved {
        intent,
        mode,
        delay,
    }
}

/// Whether finishing with `selection` opens the editor straight away: a
/// screenshot taken now, with After capture set to open it. The editor
/// makes Grab-it the active app on purpose, so the app the user was in is
/// not given the focus back first, only to lose it again.
fn opens_editor(
    intent: Intent,
    delay: Option<Duration>,
    selection: &Selection,
    after_capture: AfterCapture,
) -> bool {
    let screenshot = match selection {
        // Screen always saves a screenshot.
        Selection::Screen => true,
        Selection::Point { .. } => false,
        Selection::Region { .. } | Selection::Window { .. } => intent == Intent::Capture,
    };
    screenshot && delay.is_none() && after_capture == AfterCapture::Editor
}

/// Every frozen monitor joined into one image, following the desktop
/// layout, with the densest monitor's scale factor it is drawn at.
fn stitch_frames(frames: &HashMap<String, Frame>) -> Result<(RgbaImage, Option<f64>), String> {
    let tiles: Vec<capture::Tile<'_>> = frames
        .values()
        .map(|frame| capture::Tile {
            x: frame.monitor.x,
            y: frame.monitor.y,
            width: frame.monitor.width,
            height: frame.monitor.height,
            image: &frame.image,
        })
        .collect();
    let image = capture::stitch(&tiles).ok_or("no monitors found")?;
    let scale = frames
        .values()
        .map(|frame| frame.monitor.scale_factor)
        .reduce(f64::max);
    Ok((image, scale))
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
pub fn overlay_info(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    last: State<'_, LastRegionState>,
) -> Option<OverlayInfo> {
    let mut guard = state.lock();
    let Phase::Open(session) = &mut *guard else {
        return None;
    };
    // Every frozen monitor, so the last region is offered on its own one only.
    let monitors: Vec<MonitorInfo> = session
        .frames
        .values()
        .map(|frame| frame.monitor.clone())
        .collect();
    let frame = session.frames.get_mut(window.label())?;
    frame.responded = true;
    Some(OverlayInfo {
        mode: session.mode,
        intent: session.intent,
        all_in_one: session.all_in_one,
        choice: session.choice,
        monitor_width: frame.monitor.width,
        monitor_height: frame.monitor.height,
        image_width: frame.image.width(),
        windows: windows_on_monitor(&frame.monitor, &session.windows),
        top_inset: top_inset(&window),
        last_region: if session.all_in_one {
            last_region_on(
                last.lock().as_ref(),
                &frame.monitor,
                &monitors,
                frame.image.dimensions(),
            )
        } else {
            None
        },
        pointer_here: crate::record_bar::pointer_on(&app, &frame.monitor),
        bar_centre: crate::record_bar::bar_centre_on(&app, &frame.monitor),
        monitor_name: frame.monitor.name.clone(),
    })
}

/// How far down `window`'s monitor the menu bar or a notch reaches, as a
/// share of the monitor's height. The work area leaves out a menu bar that
/// is showing; a notch is read from macOS, since it stays when the menu bar
/// hides.
fn top_inset(window: &WebviewWindow) -> f64 {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return 0.0;
    };
    let height = f64::from(monitor.size().height);
    if height <= 0.0 {
        return 0.0;
    }
    let menu_bar = f64::from((monitor.work_area().position.y - monitor.position().y).max(0));
    let notch = notch_height(window) * monitor.scale_factor();
    (menu_bar.max(notch) / height).clamp(0.0, 0.2)
}

/// The camera notch's height in points, or 0 without one.
#[cfg(target_os = "macos")]
fn notch_height(window: &WebviewWindow) -> f64 {
    use objc2::{
        Encode, Encoding,
        runtime::{AnyObject, Bool},
    };

    /// `NSEdgeInsets`: top, left, bottom, right.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct EdgeInsets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }
    // SAFETY: four doubles, laid out as AppKit's NSEdgeInsets.
    unsafe impl Encode for EdgeInsets {
        const ENCODING: Encoding = Encoding::Struct(
            "NSEdgeInsets",
            &[
                Encoding::Double,
                Encoding::Double,
                Encoding::Double,
                Encoding::Double,
            ],
        );
    }

    let Ok(ns_window) = window.ns_window() else {
        return 0.0;
    };
    let ns_window = ns_window.cast::<AnyObject>();
    if ns_window.is_null() {
        return 0.0;
    }
    // SAFETY: `ns_window` is this window's live NSWindow. Commands that are
    // not async run on the main thread, where AppKit may be used.
    // `safeAreaInsets` (macOS 12) is only asked for when the screen has it.
    unsafe {
        let screen: *mut AnyObject = objc2::msg_send![ns_window, screen];
        if screen.is_null() {
            return 0.0;
        }
        let has: Bool = objc2::msg_send![screen, respondsToSelector: objc2::sel!(safeAreaInsets)];
        if !has.as_bool() {
            return 0.0;
        }
        let insets: EdgeInsets = objc2::msg_send![screen, safeAreaInsets];
        if insets.top.is_finite() {
            insets.top.max(0.0)
        } else {
            0.0
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn notch_height(_window: &WebviewWindow) -> f64 {
    0.0
}

/// The frozen monitor image, as [`encode_for_page`] wrote it. Off the main
/// thread: it may wait for the encoder, and the overlay must keep following
/// the pointer.
#[tauri::command(async)]
pub fn overlay_image(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
) -> Result<tauri::ipc::Response, String> {
    let encoded = {
        let guard = state.lock();
        let Phase::Open(session) = &*guard else {
            return Err("no capture in progress".into());
        };
        let frame = session
            .frames
            .get(window.label())
            .ok_or("this window is not a capture overlay")?;
        Arc::clone(&frame.encoded)
    };
    // Waited for without the lock, so the selection can end meanwhile.
    let encoded = encoded.wait().clone()?;
    Ok(tauri::ipc::Response::new(encoded))
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

/// The All-in-one toolbar on one monitor changed its mode or Timer: keep
/// it for the session and tell every other overlay, so each toolbar shows
/// it and a selection on any monitor finishes with it.
#[tauri::command]
pub fn overlay_choose(
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    choice: Choice,
) -> Result<(), String> {
    let others: Vec<String> = {
        let mut guard = state.lock();
        let Phase::Open(session) = &mut *guard else {
            return Err("no capture in progress".into());
        };
        if !session.all_in_one {
            return Err("this overlay has no toolbar".into());
        }
        session.choice = Some(choice);
        session
            .frames
            .keys()
            .filter(|label| *label != window.label())
            .cloned()
            .collect()
    };
    // Sent without the lock held.
    for label in others {
        if let Err(err) = window.emit_to(label.as_str(), CHOICE_EVENT, choice) {
            eprintln!("Grab-it: could not share the capture mode: {err}");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    close(&app);
}

/// Closes the overlays and saves the selection. An All-in-one overlay
/// sends the `choice` its toolbar made with it; with a Timer, the area is
/// captured live once the overlays are gone and the time is up.
#[tauri::command]
pub fn overlay_finish(
    window: WebviewWindow,
    app: AppHandle,
    selection: Selection,
    choice: Option<Choice>,
) -> Result<(), String> {
    let after_capture = crate::commands::lock(&app.state::<crate::commands::SettingsState>())
        .get()
        .preferences
        .after_capture;
    let session = take_session(&app, |session| {
        let Resolved { intent, delay, .. } = resolve(
            session.all_in_one,
            session.intent,
            session.mode,
            choice.or(session.choice),
        );
        !opens_editor(intent, delay, &selection, after_capture)
    })
    .ok_or("no capture in progress")?;
    let frame = session
        .frames
        .get(window.label())
        .ok_or("this window is not a capture overlay")?;
    let Resolved {
        intent,
        mode,
        delay,
    } = resolve(
        session.all_in_one,
        session.intent,
        session.mode,
        choice.or(session.choice),
    );

    if selection == Selection::Screen {
        // Screen is a mode of its own: it always saves a screenshot.
        if mode != CaptureMode::Screen {
            return Err("this overlay does not capture the screen".into());
        }
        if let Some(delay) = delay {
            actions::start_after(&app, actions::Action::Screen, delay);
            return Ok(());
        }
        let (image, scale) = stitch_frames(&session.frames)?;
        let monitors: Vec<MonitorInfo> = session
            .frames
            .values()
            .map(|frame| frame.monitor.clone())
            .collect();
        let pointer = session
            .pointer
            .as_ref()
            .and_then(|snapshot| snapshot.place_on_desktop(&monitors, image.dimensions()));
        let foreground = session.foreground.clone();
        std::thread::spawn(move || {
            actions::finish(
                &app,
                &image,
                CaptureMode::Screen,
                &foreground,
                scale,
                pointer,
            )
        });
        return Ok(());
    }

    if matches!(intent, Intent::Record | Intent::Scroll) {
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
            Selection::Point { .. } | Selection::Screen => None,
        }
        .ok_or("the selection is empty")?;
        let monitor = frame.monitor.clone();
        let foreground = session.foreground.clone();
        std::thread::spawn(move || {
            let result = if intent == Intent::Scroll {
                crate::scroll::start(&app, &monitor, rect, size, foreground)
            } else {
                crate::record::start(&app, &monitor, size, rect)
            };
            if let Err(err) = result {
                crate::scroll::report_start_failure(err, |message| {
                    actions::report_failure(&app, message)
                });
            }
        });
        return Ok(());
    }

    let (image, mode, foreground, pointer) = match selection {
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
            let pointer = session.pointer.as_ref().and_then(|snapshot| {
                snapshot.place_on_monitor(&frame.monitor, frame.image.dimensions(), Some(pixels))
            });
            if intent == Intent::Capture {
                *app.state::<LastRegionState>().lock() = Some(LastRegion {
                    monitor: frame.monitor.clone(),
                    rect: pixels,
                });
                if let Some(delay) = delay {
                    // The same area as Repeat last region captures, live.
                    actions::start_after(&app, actions::Action::Repeat, delay);
                    return Ok(());
                }
            }
            (
                image,
                CaptureMode::Region,
                session.foreground.clone(),
                pointer,
            )
        }
        Selection::Window { id } => {
            let picked = session
                .windows
                .iter()
                .find(|w| w.id == id)
                .ok_or("the window is no longer there")?;
            let foreground = screen::foreground_of(picked);
            if let Some(delay) = delay {
                let scale = frame.monitor.scale_factor;
                let area = picked.rect;
                crate::timer_bar::after(&app, delay, move |app| {
                    let snapshot = crate::pointer::snapshot();
                    match screen::capture_window(id) {
                        Ok(image) => actions::finish(
                            app,
                            &image,
                            CaptureMode::Window,
                            &foreground,
                            Some(scale),
                            snapshot.and_then(|snapshot| {
                                snapshot.place_in_area(area, image.dimensions())
                            }),
                        ),
                        Err(err) => actions::report_failure(app, &err),
                    }
                });
                return Ok(());
            }
            let image = window_image(frame, picked)?;
            let pointer = session
                .pointer
                .as_ref()
                .and_then(|snapshot| snapshot.place_in_area(picked.rect, image.dimensions()));
            (image, CaptureMode::Window, foreground, pointer)
        }
        // Handled above.
        Selection::Screen => return Err("the selection is empty".into()),
    };

    let scale = frame.monitor.scale_factor;
    std::thread::spawn(move || match intent {
        Intent::Text => actions::finish_text(&app, &image),
        Intent::Capture | Intent::Colour | Intent::Record | Intent::Scroll => {
            actions::finish(&app, &image, mode, &foreground, Some(scale), pointer)
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
    fn windows_with_only_a_sliver_on_screen_are_not_offered() {
        let whole = Rect {
            x: 1900,
            y: 1060,
            width: 800,
            height: 600,
        };
        // AeroSpace's parked window: a corner pixel or so of it shows.
        let corner = Rect {
            width: 20,
            height: 4,
            ..whole
        };
        assert!(!shows_enough(corner, whole, 16));
        assert!(shows_enough(
            Rect {
                width: 120,
                height: 600,
                ..whole
            },
            whole,
            16
        ));
        // A small window that shows in full is offered however small.
        let tiny = Rect {
            width: 10,
            height: 10,
            ..whole
        };
        assert!(shows_enough(tiny, tiny, 16));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_window_parked_in_the_corner_is_left_out_of_the_picker() {
        let screen = monitor(0, 0, 1920, 1080);
        let windows = [
            window(1, 1919, 1079, 1200, 800),
            window(2, 100, 100, 1200, 800),
            window(3, -1199, 1079, 1200, 800),
        ];
        let ids: Vec<u32> = windows_on_monitor(&screen, &windows)
            .iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn only_an_editor_opened_now_keeps_grab_it_in_front() {
        let region = Selection::Region {
            rect: CssRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            viewport_width: 100.0,
        };
        let point = Selection::Point {
            x: 1.0,
            y: 1.0,
            viewport_width: 100.0,
        };
        let editor = AfterCapture::Editor;
        assert!(opens_editor(Intent::Capture, None, &region, editor));
        assert!(opens_editor(
            Intent::Capture,
            None,
            &Selection::Screen,
            editor
        ));
        assert!(opens_editor(
            Intent::Capture,
            None,
            &Selection::Window { id: 1 },
            editor
        ));
        // Quick Access and nothing show no Grab-it window that wants the focus.
        assert!(!opens_editor(
            Intent::Capture,
            None,
            &region,
            AfterCapture::QuickAccess
        ));
        assert!(!opens_editor(
            Intent::Capture,
            None,
            &region,
            AfterCapture::Nothing
        ));
        // A Timer captures the user's own app live first.
        let timer = Some(Duration::from_secs(3));
        assert!(!opens_editor(Intent::Capture, timer, &region, editor));
        // Text, colours and recordings never open the editor.
        assert!(!opens_editor(Intent::Text, None, &region, editor));
        assert!(!opens_editor(Intent::Colour, None, &point, editor));
        assert!(!opens_editor(Intent::Record, None, &region, editor));
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

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn frozen_frames_are_sent_as_top_down_rgba_bitmaps() {
        let image = RgbaImage::from_fn(3, 2, |x, y| image::Rgba([x as u8, y as u8, 7, 200]));
        let bmp = encode_bmp(&image).unwrap();

        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32_at(&bmp, 2) as usize, bmp.len());
        let offset = u32_at(&bmp, 10) as usize;
        assert_eq!(offset, 14 + 124);
        // A BITMAPV5HEADER: ImageIO refuses alpha bit masks in older ones.
        assert_eq!(u32_at(&bmp, 14), 124);
        assert_eq!(u32_at(&bmp, 18), 3);
        // Negative height: the rows run top to bottom.
        assert_eq!(u32_at(&bmp, 22) as i32, -2);
        assert_eq!(u16::from_le_bytes([bmp[28], bmp[29]]), 32);
        assert_eq!(u32_at(&bmp, 30), 3, "BI_BITFIELDS");
        assert_eq!(u32_at(&bmp, 34) as usize, 3 * 2 * 4);
        let masks: Vec<u32> = (0..4).map(|i| u32_at(&bmp, 54 + i * 4)).collect();
        assert_eq!(masks, [0xff, 0xff00, 0xff_0000, 0xff00_0000]);
        assert_eq!(&bmp[70..74], b"BGRs", "LCS_sRGB");
        // The pixels follow unchanged, in the image's own order.
        assert_eq!(&bmp[offset..], image.as_raw().as_slice());
    }

    #[test]
    fn picked_windows_are_cropped_from_the_frozen_frame() {
        let frame = Frame {
            monitor: monitor(100, 0, 4, 4),
            image: Arc::new(RgbaImage::from_fn(4, 4, |x, y| {
                image::Rgba([x as u8, y as u8, 0, 255])
            })),
            encoded: Encoded::default(),
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
        assert_eq!(serde_json::to_value(Intent::Scroll).unwrap(), "scroll");
    }

    #[test]
    fn all_in_one_finishes_with_what_its_toolbar_chose() {
        let choice = Choice {
            intent: Some(Intent::Text),
            mode: Some(CaptureMode::Region),
            delay_seconds: None,
        };
        assert_eq!(
            resolve(true, Intent::Capture, CaptureMode::Region, Some(choice)),
            Resolved {
                intent: Intent::Text,
                mode: CaptureMode::Region,
                delay: None,
            }
        );
        // An overlay opened for one mode keeps it, whatever is sent.
        assert_eq!(
            resolve(false, Intent::Colour, CaptureMode::Region, Some(choice)),
            Resolved {
                intent: Intent::Colour,
                mode: CaptureMode::Region,
                delay: None,
            }
        );
        // Nothing chosen: the overlay's own intent and mode.
        assert_eq!(
            resolve(true, Intent::Capture, CaptureMode::Region, None),
            Resolved {
                intent: Intent::Capture,
                mode: CaptureMode::Region,
                delay: None,
            }
        );
    }

    #[test]
    fn the_timer_only_delays_screenshots() {
        let timed = |intent, seconds| Choice {
            intent: Some(intent),
            mode: Some(CaptureMode::Screen),
            delay_seconds: Some(seconds),
        };
        let delay =
            |choice| resolve(true, Intent::Capture, CaptureMode::Region, Some(choice)).delay;
        assert_eq!(
            delay(timed(Intent::Capture, 5)),
            Some(Duration::from_secs(5))
        );
        assert_eq!(delay(timed(Intent::Capture, 0)), None);
        // Longer than the toolbar offers is cut to its longest.
        assert_eq!(
            delay(timed(Intent::Capture, 600)),
            Some(Duration::from_secs(10))
        );
        assert_eq!(delay(timed(Intent::Text, 5)), None);
        assert_eq!(delay(timed(Intent::Colour, 5)), None);
        assert_eq!(delay(timed(Intent::Record, 5)), None);
        // Not from an overlay without the toolbar.
        assert_eq!(
            resolve(
                false,
                Intent::Capture,
                CaptureMode::Region,
                Some(timed(Intent::Capture, 5))
            )
            .delay,
            None
        );
    }

    #[test]
    fn choices_reach_the_other_overlays_in_the_frontend_spelling() {
        let choice = Choice {
            intent: Some(Intent::Text),
            mode: Some(CaptureMode::Region),
            delay_seconds: Some(5),
        };
        assert_eq!(
            serde_json::to_value(choice).unwrap(),
            serde_json::json!({"intent": "text", "mode": "region", "delaySeconds": 5})
        );
        // A page that sends no choice of its own finishes with the shared one.
        let shared = Some(choice);
        assert_eq!(
            resolve(true, Intent::Capture, CaptureMode::Region, None.or(shared)),
            Resolved {
                intent: Intent::Text,
                mode: CaptureMode::Region,
                delay: None,
            }
        );
    }

    #[test]
    fn a_late_page_is_told_the_choice_made_so_far() {
        let info = OverlayInfo {
            mode: CaptureMode::Region,
            intent: Intent::Capture,
            all_in_one: true,
            choice: Some(Choice {
                intent: Some(Intent::Text),
                mode: Some(CaptureMode::Region),
                delay_seconds: Some(3),
            }),
            monitor_width: 100,
            monitor_height: 100,
            image_width: 100,
            windows: Vec::new(),
            top_inset: 0.0,
            last_region: None,
            pointer_here: true,
            bar_centre: None,
            monitor_name: "eDP-1".into(),
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["allInOne"], true);
        assert_eq!(
            value["choice"],
            serde_json::json!({"intent": "text", "mode": "region", "delaySeconds": 3})
        );
        let none = OverlayInfo {
            choice: None,
            ..info
        };
        assert!(serde_json::to_value(&none).unwrap()["choice"].is_null());
    }

    #[test]
    fn choices_and_screen_selections_deserialize_from_the_frontend() {
        let choice: Choice =
            serde_json::from_str(r#"{"intent":"color","mode":"window","delaySeconds":3}"#).unwrap();
        assert_eq!(
            choice,
            Choice {
                intent: Some(Intent::Colour),
                mode: Some(CaptureMode::Window),
                delay_seconds: Some(3),
            }
        );
        assert_eq!(
            serde_json::from_str::<Choice>("{}").unwrap(),
            Choice::default()
        );
        let screen: Selection = serde_json::from_str(r#"{"kind":"screen"}"#).unwrap();
        assert_eq!(screen, Selection::Screen);
    }

    #[test]
    fn screen_stitches_every_frozen_monitor() {
        let frame = |x: i32, value: u8| Frame {
            monitor: MonitorInfo {
                scale_factor: f64::from(value),
                ..monitor(x, 0, 2, 2)
            },
            image: Arc::new(RgbaImage::from_pixel(2, 2, image::Rgba([value, 0, 0, 255]))),
            encoded: Encoded::default(),
            responded: false,
        };
        let frames = HashMap::from([
            ("overlay-2".to_owned(), frame(2, 2)),
            ("overlay-1".to_owned(), frame(0, 1)),
        ]);
        let (image, scale) = stitch_frames(&frames).unwrap();
        assert_eq!(image.dimensions(), (4, 2));
        assert_eq!(image.get_pixel(0, 0).0[0], 1);
        assert_eq!(image.get_pixel(3, 1).0[0], 2);
        assert_eq!(scale, Some(2.0));
        assert!(stitch_frames(&HashMap::new()).is_err());
    }

    #[test]
    fn the_last_region_is_offered_only_on_its_own_monitor() {
        let left = MonitorInfo {
            name: "DP-1".into(),
            ..monitor(0, 0, 1920, 1080)
        };
        let right = MonitorInfo {
            index: 1,
            name: "DP-2".into(),
            ..monitor(1920, 0, 1280, 1024)
        };
        let rect = Rect {
            x: 100,
            y: 50,
            width: 1280,
            height: 720,
        };
        let last = LastRegion {
            monitor: left.clone(),
            rect,
        };
        let both = [left.clone(), right.clone()];
        assert_eq!(
            last_region_on(Some(&last), &left, &both, (1920, 1080)),
            Some(rect)
        );
        assert_eq!(
            last_region_on(Some(&last), &right, &both, (1280, 1024)),
            None
        );
        assert_eq!(last_region_on(None, &left, &both, (1920, 1080)), None);
        // A region that no longer fits the frozen image is not offered.
        assert_eq!(
            last_region_on(Some(&last), &left, &both, (1000, 1080)),
            None
        );
    }

    #[test]
    fn the_last_region_stays_on_its_monitor_after_the_indices_swap() {
        let screen = |index: usize, name: &str, x: i32| MonitorInfo {
            index,
            name: name.into(),
            ..monitor(x, 0, 1920, 1080)
        };
        let rect = Rect {
            x: 10,
            y: 10,
            width: 100,
            height: 100,
        };
        // Taken on DP-1 while it was index 0.
        let last = LastRegion {
            monitor: screen(0, "DP-1", 0),
            rect,
        };
        // After a replug DP-2 is index 0 and DP-1 index 1.
        let dp2 = screen(0, "DP-2", 0);
        let dp1 = screen(1, "DP-1", 1920);
        let monitors = [dp2.clone(), dp1.clone()];
        assert_eq!(
            last_region_on(Some(&last), &dp1, &monitors, (1920, 1080)),
            Some(rect)
        );
        // DP-2 only matches by index, and DP-1 matched by name first.
        assert_eq!(
            last_region_on(Some(&last), &dp2, &monitors, (1920, 1080)),
            None
        );
    }

    #[test]
    fn overlay_info_sends_the_last_region_in_the_frontend_spelling() {
        let info = OverlayInfo {
            mode: CaptureMode::Region,
            intent: Intent::Capture,
            all_in_one: true,
            choice: None,
            monitor_width: 1920,
            monitor_height: 1080,
            image_width: 1920,
            windows: vec![],
            top_inset: 0.0,
            last_region: Some(Rect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }),
            pointer_here: false,
            bar_centre: Some(crate::record_bar::CssPoint { x: 960.0, y: 42.0 }),
            monitor_name: "DELL U2720Q".into(),
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(
            value["lastRegion"],
            serde_json::json!({ "x": 1, "y": 2, "width": 3, "height": 4 })
        );
        assert_eq!(value["allInOne"], true);
        let none = OverlayInfo {
            last_region: None,
            ..info
        };
        assert!(serde_json::to_value(&none).unwrap()["lastRegion"].is_null());
        assert_eq!(value["pointerHere"], false);
        assert_eq!(
            value["barCentre"],
            serde_json::json!({ "x": 960.0, "y": 42.0 })
        );
        assert_eq!(value["monitorName"], "DELL U2720Q");
        let unknown = OverlayInfo {
            bar_centre: None,
            ..none
        };
        assert!(serde_json::to_value(&unknown).unwrap()["barCentre"].is_null());
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

    #[test]
    fn overlays_are_placed_in_each_display_s_own_points() {
        // The #207 layout: the main display at 2x, a 1x display above it
        // and a 2x display to its right, each frame in pixels at its scale.
        let one_x = logical_frame(
            PhysicalPosition::new(640, -1080),
            PhysicalSize::new(2560, 1080),
            1.0,
        );
        assert_eq!(
            one_x,
            (
                LogicalPosition::new(640.0, -1080.0),
                LogicalSize::new(2560.0, 1080.0)
            )
        );
        let two_x = logical_frame(
            PhysicalPosition::new(6400, 0),
            PhysicalSize::new(3840, 2160),
            2.0,
        );
        assert_eq!(
            two_x,
            (
                LogicalPosition::new(3200.0, 0.0),
                LogicalSize::new(1920.0, 1080.0)
            )
        );
    }

    #[test]
    fn a_scale_that_is_not_a_positive_number_counts_as_one() {
        let frame = (
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
        );
        let expected = (
            LogicalPosition::new(-1920.0, 0.0),
            LogicalSize::new(1920.0, 1080.0),
        );
        for scale in [0.0, -2.0, f64::NAN] {
            assert_eq!(logical_frame(frame.0, frame.1, scale), expected);
        }
    }
}
