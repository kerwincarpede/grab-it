//! The recording toolbar: a small pill that floats over the screen while a
//! recording runs, with the elapsed time, the microphone, Pause, Stop and
//! a menu of the rest (see src/recordbar/).
//!
//! It can be dragged anywhere, and remembers where it was left on each
//! display, in `record-bar.json` beside the settings: as the corner of the
//! display's work area it is nearest and its distance from that corner, in
//! points, so it stays put when the resolution changes. The next recording
//! opens it on the display it was last left on when that is still
//! connected, else on the display being recorded, at the spot saved for
//! it, or at the top centre when there is none.
//!
//! It is kept out of the recording where the system allows: Windows and
//! macOS leave a window that asks for it out of screen captures
//! (`content_protected`). X11 has no such thing, so there a toolbar that
//! would sit on the recorded area is moved just outside it when it opens.

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::rt::{AppHandle, WebviewWindow};
use crate::windows::E2eBrowserArgs;
use crate::{capture::Rect, record::BarStatus, screen::MonitorInfo};

pub const LABEL: &str = "record-bar";
/// Emitted to the toolbar with a [`BarStatus`] whenever it changes.
/// Mirrors `RECORD_BAR_EVENT` in src/recordbar/api.ts.
pub const RECORD_BAR_EVENT: &str = "record-bar-status";
/// Where the toolbar's spots are kept, in the app data directory.
const MEMORY_FILE: &str = "record-bar.json";
/// The window's size before the page has measured itself, in points.
/// The 50 pt pill and the 10 pt room for its shadow (`.recordbar` padding).
const INITIAL_SIZE: (f64, f64) = (300.0, 70.0);
/// The gap between the toolbar and the work area's edge at its default
/// spot, and between it and the recorded area when it is moved clear.
const GAP: f64 = 12.0;
/// A move this soon after Grab-it placed the window is its own, not a drag.
const OWN_MOVE: Duration = Duration::from_millis(300);
/// A dragged toolbar's spot is saved once it has stayed put this long.
const SAVE_DELAY: Duration = Duration::from_millis(400);

/// A rectangle in physical pixels on the desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    fn centre(&self) -> (i32, i32) {
        (
            self.x + (self.width / 2) as i32,
            self.y + (self.height / 2) as i32,
        )
    }

    fn contains(&self, (x, y): (i32, i32)) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    fn overlaps(&self, other: &Area) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }
}

/// A display the toolbar can sit on.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    /// What its spot is saved under.
    pub key: String,
    /// Its work area, clear of the taskbar, Dock or menu bar.
    pub work: Area,
    pub scale: f64,
}

/// A corner of a display's work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Where the toolbar was left on a display: the corner of the work area
/// it was nearest, and how far its own nearest edges were from it, in
/// points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Spot {
    pub corner: Corner,
    pub dx: f64,
    pub dy: f64,
}

/// The spots saved, by display, and the display it was last left on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    pub last_display: Option<String>,
    pub spots: BTreeMap<String, Spot>,
}

/// The display `key` names, or the one `recorded` names, or the first.
pub fn display_for<'a>(
    memory: &Memory,
    displays: &'a [Display],
    recorded: &str,
) -> Option<&'a Display> {
    let by_key = |key: &str| displays.iter().find(|display| display.key == key);
    memory
        .last_display
        .as_deref()
        .and_then(by_key)
        .or_else(|| by_key(recorded))
        .or_else(|| displays.first())
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// The spot of a toolbar covering `bar` on `display`.
pub fn spot_of(bar: Area, display: &Display) -> Spot {
    let scale = valid_scale(display.scale);
    let work = display.work;
    let (cx, cy) = bar.centre();
    let (wx, wy) = work.centre();
    let left = cx < wx;
    let top = cy < wy;
    let dx = if left {
        bar.x - work.x
    } else {
        work.right() - bar.right()
    };
    let dy = if top {
        bar.y - work.y
    } else {
        work.bottom() - bar.bottom()
    };
    let corner = match (top, left) {
        (true, true) => Corner::TopLeft,
        (true, false) => Corner::TopRight,
        (false, true) => Corner::BottomLeft,
        (false, false) => Corner::BottomRight,
    };
    Spot {
        corner,
        dx: f64::from(dx.max(0)) / scale,
        dy: f64::from(dy.max(0)) / scale,
    }
}

/// Keeps a toolbar of `size` at `position` inside `work`.
fn clamp_into(position: (i32, i32), size: (u32, u32), work: Area) -> (i32, i32) {
    let max_x = (work.right() - size.0 as i32).max(work.x);
    let max_y = (work.bottom() - size.1 as i32).max(work.y);
    (
        position.0.clamp(work.x, max_x),
        position.1.clamp(work.y, max_y),
    )
}

/// The top-left corner of a toolbar of `size` (physical pixels) at
/// `spot` on `display`, or at the top centre of its work area without
/// one, always inside the work area.
pub fn position_at(spot: Option<Spot>, size: (u32, u32), display: &Display) -> (i32, i32) {
    let scale = valid_scale(display.scale);
    let work = display.work;
    let (width, height) = (size.0 as i32, size.1 as i32);
    let position = match spot {
        None => (
            work.x + (work.width as i32 - width) / 2,
            work.y + (GAP * scale).round() as i32,
        ),
        Some(spot) => {
            let dx = (spot.dx * scale).round() as i32;
            let dy = (spot.dy * scale).round() as i32;
            let x = match spot.corner {
                Corner::TopLeft | Corner::BottomLeft => work.x + dx,
                Corner::TopRight | Corner::BottomRight => work.right() - dx - width,
            };
            let y = match spot.corner {
                Corner::TopLeft | Corner::TopRight => work.y + dy,
                Corner::BottomLeft | Corner::BottomRight => work.bottom() - dy - height,
            };
            (x, y)
        }
    };
    clamp_into(position, size, work)
}

/// The pill of `size` centred on `centre`, all in physical pixels.
pub fn pill_around(centre: (i32, i32), size: (u32, u32)) -> Area {
    Area {
        x: centre.0 - (size.0 / 2) as i32,
        y: centre.1 - (size.1 / 2) as i32,
        width: size.0,
        height: size.1,
    }
}

/// The centre of a pill of `size` at `position`, in the CSS pixels of a
/// page covering the display whose top-left corner is `origin`, drawn at
/// `scale`. All but the result are physical pixels.
pub fn centre_in_css(
    position: (i32, i32),
    size: (u32, u32),
    origin: (i32, i32),
    scale: f64,
) -> (f64, f64) {
    let scale = valid_scale(scale);
    let pill = Area {
        x: position.0,
        y: position.1,
        width: size.0,
        height: size.1,
    };
    let (x, y) = pill.centre();
    (
        f64::from(x - origin.0) / scale,
        f64::from(y - origin.1) / scale,
    )
}

/// A point in a page's CSS pixels. Mirrors `Point` in src/overlay/geometry.ts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct CssPoint {
    pub x: f64,
    pub y: f64,
}

/// Where the recording toolbar would open on `monitor`, as the centre of
/// its pill in the CSS pixels of an overlay covering that monitor: the
/// Record overlay's setup toolbar opens centred on the same point.
pub fn bar_centre_on(app: &AppHandle, monitor: &MonitorInfo) -> Option<CssPoint> {
    let monitors = app.available_monitors().ok()?;
    let found = monitor_for(monitor, &monitors)?;
    let display = display_of(found);
    let size = pill_size(app, &display);
    let spot = memory(app).spots.get(&display.key).copied();
    let position = position_at(spot, size, &display);
    let origin = (found.position().x, found.position().y);
    let (x, y) = centre_in_css(position, size, origin, found.scale_factor());
    Some(CssPoint { x, y })
}

/// Whether the pointer is on `monitor`. Where the pointer cannot be read,
/// the primary monitor counts as the one it is on.
pub fn pointer_on(app: &AppHandle, monitor: &MonitorInfo) -> bool {
    let Ok(pointer) = app.cursor_position() else {
        return monitor.is_primary;
    };
    let monitors = app.available_monitors().unwrap_or_default();
    let Some(found) = monitor_for(monitor, &monitors) else {
        return monitor.is_primary;
    };
    let area = Area {
        x: found.position().x,
        y: found.position().y,
        width: found.size().width,
        height: found.size().height,
    };
    holds_pointer(app, (pointer.x, pointer.y), area, found.scale_factor())
}

/// macOS gives the pointer in pixels at the main display's scale, and each
/// monitor in pixels at its own, so the two are compared in points.
#[cfg(target_os = "macos")]
fn holds_pointer(app: &AppHandle, pointer: (f64, f64), area: Area, scale: f64) -> bool {
    let main_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |main| main.scale_factor());
    pointer_in_points(pointer, main_scale, area, scale)
}

/// Windows and Linux give the pointer and the monitors in the same pixels.
#[cfg(not(target_os = "macos"))]
fn holds_pointer(_app: &AppHandle, pointer: (f64, f64), area: Area, _scale: f64) -> bool {
    area.contains((pointer.0.floor() as i32, pointer.1.floor() as i32))
}

/// Whether a pointer at `pointer`, in pixels at the main display's
/// `main_scale`, is on a display whose frame `area` is in pixels at its own
/// `scale`. Both are turned into points first, which is how macOS lays out
/// displays of different scales.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pointer_in_points(pointer: (f64, f64), main_scale: f64, area: Area, scale: f64) -> bool {
    let main_scale = valid_scale(main_scale);
    let scale = valid_scale(scale);
    let (x, y) = (pointer.0 / main_scale, pointer.1 / main_scale);
    let left = f64::from(area.x) / scale;
    let top = f64::from(area.y) / scale;
    let right = left + f64::from(area.width) / scale;
    let bottom = top + f64::from(area.height) / scale;
    x >= left && x < right && y >= top && y < bottom
}

/// A toolbar of `size` at `position` moved just outside `recorded` when
/// it would cover it, for a system that cannot leave it out of the
/// recording: below, above, to the right or to the left of it, whichever
/// is nearest and still inside `work`. Where it is when it is clear
/// already, or when there is no room around the area.
pub fn clear_of(
    position: (i32, i32),
    size: (u32, u32),
    recorded: Area,
    work: Area,
    scale: f64,
) -> (i32, i32) {
    let bar = Area {
        x: position.0,
        y: position.1,
        width: size.0,
        height: size.1,
    };
    if !bar.overlaps(&recorded) {
        return position;
    }
    let gap = (GAP * valid_scale(scale)).round() as i32;
    let (width, height) = (size.0 as i32, size.1 as i32);
    let candidates = [
        (position.0, recorded.bottom() + gap),
        (position.0, recorded.y - gap - height),
        (recorded.right() + gap, position.1),
        (recorded.x - gap - width, position.1),
    ];
    candidates
        .into_iter()
        .map(|(x, y)| {
            // Slid along the side it moved to, to stay on screen.
            let along = clamp_into((x, y), size, work);
            if y == position.1 {
                (x, along.1)
            } else {
                (along.0, y)
            }
        })
        .filter(|&(x, y)| {
            let moved = Area {
                x,
                y,
                width: size.0,
                height: size.1,
            };
            x >= work.x
                && y >= work.y
                && moved.right() <= work.right()
                && moved.bottom() <= work.bottom()
                && !moved.overlaps(&recorded)
        })
        .min_by_key(|&(x, y)| (x - position.0).abs() + (y - position.1).abs())
        .unwrap_or(position)
}

/// What the page has said about its size, and what Grab-it did last.
#[derive(Debug, Default)]
struct Layout {
    /// The pill's size, in physical pixels, without the menu.
    pill: Option<(u32, u32)>,
    /// The menu's height in physical pixels while it is open.
    menu: Option<u32>,
    /// Whether the open menu sits above the pill.
    up: bool,
    /// When Grab-it last moved or resized the window itself.
    placed_at: Option<Instant>,
}

/// The toolbar's spots and layout.
#[derive(Default)]
pub struct RecordBarState {
    memory: Mutex<Option<Memory>>,
    layout: Mutex<Layout>,
    saves: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn memory_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(MEMORY_FILE))
}

/// The spots saved, read from disk the first time.
fn memory(app: &AppHandle) -> Memory {
    let state = app.state::<RecordBarState>();
    let mut memory = lock(&state.memory);
    memory
        .get_or_insert_with(|| {
            memory_path(app)
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default()
        })
        .clone()
}

/// Changes the spots saved and writes them to disk.
fn remember(app: &AppHandle, change: impl FnOnce(&mut Memory)) {
    let mut current = memory(app);
    change(&mut current);
    *lock(&app.state::<RecordBarState>().memory) = Some(current.clone());
    let Some(path) = memory_path(app) else {
        return;
    };
    let written = serde_json::to_vec_pretty(&current)
        .map_err(|err| err.to_string())
        .and_then(|json| {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|err| err.to_string())?;
            }
            fs::write(&path, json).map_err(|err| err.to_string())
        });
    if let Err(err) = written {
        eprintln!("Grab-it: could not save where the recording toolbar is: {err}");
    }
}

/// What a monitor's spot is saved under: its name, which stays the same
/// when displays are plugged in in another order, else its size.
fn key_of(monitor: &Monitor) -> String {
    monitor.name().cloned().unwrap_or_else(|| {
        let size = monitor.size();
        format!("{}x{}", size.width, size.height)
    })
}

pub(crate) fn display_of(monitor: &Monitor) -> Display {
    let work = monitor.work_area();
    Display {
        key: key_of(monitor),
        work: Area {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        scale: monitor.scale_factor(),
    }
}

/// The connected displays.
fn displays(app: &AppHandle) -> Vec<Display> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(display_of)
        .collect()
}

/// The Tauri monitor that `monitor` is, by name, else by position.
pub(crate) fn monitor_for<'a>(
    monitor: &MonitorInfo,
    monitors: &'a [Monitor],
) -> Option<&'a Monitor> {
    monitors
        .iter()
        .find(|m| m.name().is_some_and(|name| *name == monitor.name))
        .or_else(|| {
            monitors.iter().find(|m| {
                let pos = m.position();
                let scale = valid_scale(m.scale_factor());
                (pos.x == monitor.x && pos.y == monitor.y)
                    || ((f64::from(pos.x) / scale).round() as i32 == monitor.x
                        && (f64::from(pos.y) / scale).round() as i32 == monitor.y)
            })
        })
}

/// The pill's size in physical pixels on `display`.
fn pill_size(app: &AppHandle, display: &Display) -> (u32, u32) {
    lock(&app.state::<RecordBarState>().layout)
        .pill
        .unwrap_or_else(|| {
            let scale = valid_scale(display.scale);
            (
                (INITIAL_SIZE.0 * scale).round() as u32,
                (INITIAL_SIZE.1 * scale).round() as u32,
            )
        })
}

/// Moves and sizes the window, noting that the move is Grab-it's own.
/// `position` and `size` are in physical pixels at the `scale` of the
/// display it is placed on.
fn place(
    app: &AppHandle,
    window: &WebviewWindow,
    position: (i32, i32),
    size: (u32, u32),
    scale: f64,
) {
    lock(&app.state::<RecordBarState>().layout).placed_at = Some(Instant::now());
    let position = PhysicalPosition::new(position.0, position.1);
    let size = PhysicalSize::new(size.0, size.1);
    let _ = crate::overlay::place_window(window, position, size, scale);
}

/// Opens the toolbar for a recording of `rect`, an area of `monitor`'s
/// image of `image_size` pixels, showing `status`. A toolbar already open
/// (a recording started again) stays where it is. Call this off the main
/// thread.
pub fn show(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    status: &BarStatus,
) {
    if let Some(window) = app.get_webview_window(LABEL) {
        changed(app, status);
        let _ = window.show();
        return;
    }
    {
        let state = app.state::<RecordBarState>();
        let mut layout = lock(&state.layout);
        layout.menu = None;
        layout.up = false;
    }
    let monitors = app.available_monitors().unwrap_or_default();
    let all: Vec<Display> = monitors.iter().map(display_of).collect();
    let recorded = monitor_for(monitor, &monitors);
    let recorded_key = recorded.map(key_of).unwrap_or_default();
    let memory = memory(app);
    let Some(display) = display_for(&memory, &all, &recorded_key) else {
        eprintln!("Grab-it: no display to show the recording toolbar on");
        return;
    };
    let size = pill_size(app, display);
    let mut position = position_at(memory.spots.get(&display.key).copied(), size, display);
    if !cfg!(any(target_os = "macos", target_os = "windows"))
        && display.key == recorded_key
        && let Some(recorded) = recorded
    {
        let (origin, area) = crate::webcam::screen_area(
            rect,
            image_size,
            (recorded.position().x, recorded.position().y),
            (recorded.size().width, recorded.size().height),
        );
        let area = Area {
            x: origin.0,
            y: origin.1,
            width: area.0,
            height: area.1,
        };
        position = clear_of(position, size, area, display.work, display.scale);
    }
    if let Err(err) = create(app, display, position, size) {
        eprintln!("Grab-it: could not show the recording toolbar: {err}");
    }
}

fn create(
    app: &AppHandle,
    display: &Display,
    position: (i32, i32),
    size: (u32, u32),
) -> tauri::Result<()> {
    let scale = valid_scale(display.scale);
    let window =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/recordbar".into()))
            .e2e_browser_args()
            .title("Grab-it recording")
            .inner_size(f64::from(size.0) / scale, f64::from(size.1) / scale)
            .decorations(false)
            // See-through, so only the rounded pill shows.
            .transparent(true)
            // GTK keeps a window that may not be resized at the size it
            // was built with, and no smaller than the webview's minimum,
            // which would leave a see-through area that still takes
            // clicks. With no title bar or frame there is nothing to
            // resize it by, so there it can be resizable.
            .resizable(cfg!(target_os = "linux"))
            .min_inner_size(1.0, 1.0)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            // Left out of screen captures where the system allows, so it is
            // not recorded wherever it is dragged.
            .content_protected(true)
            // The toolbar must not pull the keyboard away from what is recorded.
            .focused(false)
            // Because it is never focused, macOS would spend the first click
            // on activating it while another app is in front, so Stop or
            // Start now would need two clicks. Let that first click through.
            .accept_first_mouse(true)
            .shadow(false)
            .visible(false)
            .build()?;
    place(app, &window, position, size, scale);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(position) = event {
            moved(&handle, *position);
        }
    });
    window.show()?;
    Ok(())
}

/// The window moved: when the user dragged it, saves its spot once it has
/// settled.
fn moved(app: &AppHandle, position: PhysicalPosition<i32>) {
    let state = app.state::<RecordBarState>();
    let size = {
        let layout = lock(&state.layout);
        let own = layout.placed_at.is_some_and(|at| at.elapsed() < OWN_MOVE);
        // A drag closes the menu first, so an open one moved with Grab-it.
        if own || layout.menu.is_some() {
            return;
        }
        layout.pill
    };
    let generation = state.saves.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DELAY);
        if app.state::<RecordBarState>().saves.load(Ordering::SeqCst) != generation {
            return;
        }
        let Some(size) = size.or_else(|| {
            app.get_webview_window(LABEL)
                .and_then(|window| window.outer_size().ok())
                .map(|size| (size.width, size.height))
        }) else {
            return;
        };
        let bar = Area {
            x: position.x,
            y: position.y,
            width: size.0,
            height: size.1,
        };
        let scale = app
            .get_webview_window(LABEL)
            .and_then(|window| window.scale_factor().ok())
            .unwrap_or(1.0);
        let all = displays(&app);
        let Some((bar, display)) = display_under(bar, scale, &all) else {
            return;
        };
        let spot = spot_of(bar, display);
        let key = display.key.clone();
        remember(&app, |memory| {
            memory.spots.insert(key.clone(), spot);
            memory.last_display = Some(key);
        });
    });
}

/// Tells the toolbar what it shows now, and the recorded area's outline,
/// which shows the countdown too (see record_frame.rs).
pub fn changed(app: &AppHandle, status: &BarStatus) {
    let listening = [LABEL, crate::record_frame::LABEL]
        .into_iter()
        .any(|label| app.get_webview_window(label).is_some());
    if listening {
        let _ = app.emit(RECORD_BAR_EVENT, status);
    }
}

/// Closes the toolbar, if it is open.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the recording toolbar: {err}");
    }
    let state = app.state::<RecordBarState>();
    let mut layout = lock(&state.layout);
    layout.menu = None;
    layout.up = false;
}

/// The display the window's pill is on, and the pill's rectangle.
fn pill_area(app: &AppHandle, window: &WebviewWindow) -> Option<(Area, Display)> {
    let position = window.outer_position().ok()?;
    let (pill, menu, up) = {
        let state = app.state::<RecordBarState>();
        let layout = lock(&state.layout);
        (layout.pill, layout.menu, layout.up)
    };
    let size = window.outer_size().ok()?;
    let pill = pill.unwrap_or((size.width, size.height));
    let y = match menu {
        Some(menu) if up => position.y + menu as i32,
        _ => position.y,
    };
    let bar = Area {
        x: position.x,
        y,
        width: pill.0,
        height: pill.1,
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let all = displays(app);
    let (bar, display) = display_under(bar, scale, &all).or_else(|| Some((bar, all.first()?)))?;
    Some((bar, display.clone()))
}

/// The display a toolbar covering `bar` is on, and `bar` in that
/// display's pixels: the display holding its centre, else one it
/// overlaps. `bar` was read from the window, in pixels at `scale`, the
/// scale of the screen the window is on.
///
/// macOS gives each display's frame in pixels at its own scale, so frames
/// of displays with different scales overlap in pixels, and the toolbar is
/// found in points instead. Windows and Linux lay displays out in one
/// space of pixels.
fn display_under(bar: Area, scale: f64, displays: &[Display]) -> Option<(Area, &Display)> {
    #[cfg(target_os = "macos")]
    {
        display_in_points(bar, scale, displays)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        displays
            .iter()
            .find(|display| display.work.contains(bar.centre()))
            .or_else(|| displays.iter().find(|display| display.work.overlaps(&bar)))
            .map(|display| (bar, display))
    }
}

/// [`display_under`] with every frame in points, as macOS lays out
/// displays of different scales.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn display_in_points(bar: Area, scale: f64, displays: &[Display]) -> Option<(Area, &Display)> {
    let scale = valid_scale(scale);
    // A rectangle in points: left, top, right, bottom.
    let points = |area: Area, scale: f64| {
        (
            f64::from(area.x) / scale,
            f64::from(area.y) / scale,
            f64::from(area.right()) / scale,
            f64::from(area.bottom()) / scale,
        )
    };
    let (left, top, right, bottom) = points(bar, scale);
    let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
    let on = |display: &&Display| points(display.work, valid_scale(display.scale));
    let found = displays
        .iter()
        .find(|display| {
            let (l, t, r, b) = on(display);
            cx >= l && cx < r && cy >= t && cy < b
        })
        .or_else(|| {
            displays.iter().find(|display| {
                let (l, t, r, b) = on(display);
                left < r && l < right && top < b && t < bottom
            })
        })?;
    // The window's pixels, read at its screen's scale, in the display's.
    let ratio = valid_scale(found.scale) / scale;
    let px = |value: i32| (f64::from(value) * ratio).round() as i32;
    let len = |value: u32| (f64::from(value) * ratio).round() as u32;
    Some((
        Area {
            x: px(bar.x),
            y: px(bar.y),
            width: len(bar.width),
            height: len(bar.height),
        },
        found,
    ))
}

/// Where the menu opens. Mirrors `BarLayout` in src/recordbar/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BarLayout {
    /// Whether the menu sits above the pill.
    pub up: bool,
}

/// Fits the window to the page: a pill `width` by `height` points, with a
/// menu `menu` points tall open below or above it. The pill keeps the
/// corner it is anchored by when it changes size, and the menu opens
/// above it in the lower half of the display.
#[tauri::command]
#[specta::specta]
pub fn record_bar_fit(
    width: f64,
    height: f64,
    menu: Option<f64>,
    app: AppHandle,
) -> Result<BarLayout, String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("the recording toolbar is not open")?;
    let (bar, display) = pill_area(&app, &window).ok_or("the recording toolbar is off screen")?;
    let scale = valid_scale(display.scale);
    let physical = |points: f64| (points.max(1.0) * scale).round() as u32;
    let pill = (physical(width), physical(height));
    // The corner it is anchored by stays put.
    let anchored = if pill == (bar.width, bar.height) {
        (bar.x, bar.y)
    } else {
        position_at(Some(spot_of(bar, &display)), pill, &display)
    };
    let menu = menu.map(physical);
    let up = menu.is_some() && bar.centre().1 > display.work.centre().1;
    {
        let state = app.state::<RecordBarState>();
        let mut layout = lock(&state.layout);
        layout.pill = Some(pill);
        layout.menu = menu;
        layout.up = up;
    }
    let (position, size) = match menu {
        Some(menu) if up => (
            (anchored.0, anchored.1 - menu as i32),
            (pill.0, pill.1 + menu),
        ),
        Some(menu) => (anchored, (pill.0, pill.1 + menu)),
        None => (anchored, pill),
    };
    place(&app, &window, position, size, scale);
    Ok(BarLayout { up })
}

/// Remembers where the Record overlay's setup toolbar was dragged to, as
/// the spot of the recording toolbar's pill centred on the same point:
/// `centre` is in the CSS pixels of the overlay `window` it was dragged
/// on. The two toolbars share one spot per display, so the recording
/// toolbar opens where the setup toolbar was left, and the next setup
/// toolbar too.
#[tauri::command]
#[specta::specta]
pub fn record_bar_remember(
    centre: CssPoint,
    window: WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if !(centre.x.is_finite() && centre.y.is_finite()) {
        return Err("the toolbar's centre is not a point".into());
    }
    let origin = window.outer_position().map_err(|err| err.to_string())?;
    let scale = valid_scale(window.scale_factor().map_err(|err| err.to_string())?);
    let physical = (
        origin.x + (centre.x * scale).round() as i32,
        origin.y + (centre.y * scale).round() as i32,
    );
    let all = displays(&app);
    let display = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| display_of(&monitor))
        .or_else(|| {
            all.iter()
                .find(|display| display.work.contains(physical))
                .cloned()
        })
        .ok_or("the toolbar is on no display")?;
    let bar = pill_around(physical, pill_size(&app, &display));
    let spot = spot_of(bar, &display);
    let key = display.key.clone();
    remember(&app, |memory| {
        memory.spots.insert(key.clone(), spot);
        memory.last_display = Some(key);
    });
    Ok(())
}

/// Forgets where the toolbar was left and moves it back to the top
/// centre of the display it is on.
#[tauri::command]
#[specta::specta]
pub fn record_bar_reset(app: AppHandle) {
    remember(&app, |memory| *memory = Memory::default());
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Some((bar, display)) = pill_area(&app, &window) else {
        return;
    };
    let (menu, up) = {
        let state = app.state::<RecordBarState>();
        let layout = lock(&state.layout);
        (layout.menu, layout.up)
    };
    let position = position_at(None, (bar.width, bar.height), &display);
    let size = window
        .outer_size()
        .map(|size| (size.width, size.height))
        .unwrap_or((bar.width, bar.height));
    let y = match menu {
        Some(menu) if up => position.1 - menu as i32,
        _ => position.1,
    };
    place(&app, &window, (position.0, y), size, display.scale);
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Area = Area {
        x: 0,
        y: 25,
        width: 1920,
        height: 1055,
    };

    fn display(key: &str, work: Area, scale: f64) -> Display {
        Display {
            key: key.into(),
            work,
            scale,
        }
    }

    #[test]
    fn opens_at_the_top_centre_without_a_saved_spot() {
        let built_in = display("eDP-1", WORK, 1.0);
        assert_eq!(position_at(None, (300, 60), &built_in), (810, 37));
    }

    #[test]
    fn a_spot_is_measured_from_the_nearest_corner_in_points() {
        let retina = display("Built-in", WORK, 2.0);
        // Near the bottom right, 40 by 30 pixels in from it.
        let bar = Area {
            x: 1920 - 300 - 40,
            y: 25 + 1055 - 60 - 30,
            width: 300,
            height: 60,
        };
        let spot = spot_of(bar, &retina);
        assert_eq!(
            spot,
            Spot {
                corner: Corner::BottomRight,
                dx: 20.0,
                dy: 15.0,
            }
        );
        assert_eq!(position_at(Some(spot), (300, 60), &retina), (bar.x, bar.y));
    }

    #[test]
    fn a_spot_keeps_its_corner_when_the_resolution_changes() {
        let spot = spot_of(
            Area {
                x: 1500,
                y: 100,
                width: 300,
                height: 60,
            },
            &display("DELL", WORK, 1.0),
        );
        assert_eq!(spot.corner, Corner::TopRight);
        let bigger = display(
            "DELL",
            Area {
                x: 0,
                y: 25,
                width: 2560,
                height: 1415,
            },
            1.0,
        );
        assert_eq!(
            position_at(Some(spot), (300, 60), &bigger),
            (2560 - 120 - 300, 100)
        );
    }

    #[test]
    fn a_spot_off_the_work_area_is_pulled_back_onto_it() {
        let spot = Spot {
            corner: Corner::TopLeft,
            dx: 5000.0,
            dy: 5000.0,
        };
        assert_eq!(
            position_at(Some(spot), (300, 60), &display("x", WORK, 1.0)),
            (1920 - 300, 25 + 1055 - 60)
        );
    }

    #[test]
    fn opens_on_the_display_it_was_last_left_on_while_that_is_connected() {
        let displays = [
            display("eDP-1", WORK, 1.0),
            display(
                "DELL",
                Area {
                    x: 1920,
                    y: 0,
                    width: 2560,
                    height: 1440,
                },
                1.0,
            ),
        ];
        let mut memory = Memory::default();
        assert_eq!(display_for(&memory, &displays, "DELL").unwrap().key, "DELL");
        memory.last_display = Some("eDP-1".into());
        assert_eq!(
            display_for(&memory, &displays, "DELL").unwrap().key,
            "eDP-1"
        );
        // Unplugged: the display being recorded instead.
        memory.last_display = Some("LG".into());
        assert_eq!(display_for(&memory, &displays, "DELL").unwrap().key, "DELL");
        assert_eq!(
            display_for(&memory, &displays, "gone").unwrap().key,
            "eDP-1"
        );
        assert!(display_for(&memory, &[], "DELL").is_none());
    }

    #[test]
    fn a_toolbar_on_the_recorded_area_is_moved_to_its_nearest_side() {
        let recorded = Area {
            x: 400,
            y: 200,
            width: 800,
            height: 500,
        };
        // Nearer the top: just above it.
        assert_eq!(
            clear_of((810, 300), (300, 60), recorded, WORK, 1.0),
            (810, 128)
        );
        // Nearer the bottom: just below it.
        assert_eq!(
            clear_of((810, 600), (300, 60), recorded, WORK, 1.0),
            (810, 712)
        );
    }

    #[test]
    fn a_toolbar_clear_of_the_area_stays_where_it_is() {
        let recorded = Area {
            x: 400,
            y: 200,
            width: 800,
            height: 500,
        };
        assert_eq!(
            clear_of((810, 37), (300, 60), recorded, WORK, 1.0),
            (810, 37)
        );
    }

    #[test]
    fn a_toolbar_goes_above_or_beside_an_area_with_no_room_below() {
        let tall = Area {
            x: 400,
            y: 300,
            width: 800,
            height: 780,
        };
        assert_eq!(clear_of((810, 400), (300, 60), tall, WORK, 1.0), (810, 228));
        let full_height = Area {
            x: 0,
            y: 25,
            width: 1200,
            height: 1055,
        };
        assert_eq!(
            clear_of((810, 400), (300, 60), full_height, WORK, 1.0),
            (1212, 400)
        );
    }

    #[test]
    fn a_full_screen_recording_leaves_the_toolbar_where_it_is() {
        assert_eq!(clear_of((810, 37), (300, 60), WORK, WORK, 1.0), (810, 37));
    }

    #[test]
    fn the_setup_toolbar_opens_centred_where_the_recording_toolbar_would() {
        let retina = display("Built-in", WORK, 2.0);
        // No spot: top centre, 12 points down, on a display at the desktop's origin.
        let position = position_at(None, (600, 120), &retina);
        assert_eq!(
            centre_in_css(position, (600, 120), (0, 0), 2.0),
            (480.0, 54.5)
        );
        // A second display to the right: measured from its own corner.
        assert_eq!(
            centre_in_css((2000, 100), (300, 60), (1920, 0), 1.0),
            (230.0, 130.0)
        );
    }

    #[test]
    fn a_dragged_setup_toolbar_leaves_the_spot_the_recording_toolbar_opens_at() {
        let built_in = display("eDP-1", WORK, 1.0);
        let size = (300, 60);
        // Dropped with its centre near the bottom left.
        let bar = pill_around((400, 900), size);
        assert_eq!(
            bar,
            Area {
                x: 250,
                y: 870,
                width: 300,
                height: 60,
            }
        );
        let spot = spot_of(bar, &built_in);
        assert_eq!(spot.corner, Corner::BottomLeft);
        let position = position_at(Some(spot), size, &built_in);
        assert_eq!(position, (250, 870));
        assert_eq!(centre_in_css(position, size, (0, 0), 1.0), (400.0, 900.0));
    }

    #[test]
    fn css_points_use_the_frontend_spelling() {
        let point: CssPoint = serde_json::from_str(r#"{"x": 12.5, "y": 40}"#).unwrap();
        assert_eq!(point, CssPoint { x: 12.5, y: 40.0 });
        assert_eq!(
            serde_json::to_value(point).unwrap(),
            serde_json::json!({"x": 12.5, "y": 40.0})
        );
    }

    #[test]
    fn the_memory_file_reads_back_what_was_saved() {
        let mut memory = Memory {
            last_display: Some("eDP-1".into()),
            ..Memory::default()
        };
        memory.spots.insert(
            "eDP-1".into(),
            Spot {
                corner: Corner::BottomLeft,
                dx: 24.0,
                dy: 16.5,
            },
        );
        let json = serde_json::to_string(&memory).unwrap();
        assert!(json.contains(r#""lastDisplay":"eDP-1""#));
        assert!(json.contains(r#""corner":"bottomLeft""#));
        assert_eq!(serde_json::from_str::<Memory>(&json).unwrap(), memory);
        assert_eq!(
            serde_json::from_str::<Memory>("{}").unwrap(),
            Memory::default()
        );
    }

    #[test]
    fn the_toolbar_is_found_on_a_display_of_another_scale_in_points() {
        // A 2x main display at 0,0 3200x1800 points and a 1x display to its
        // right at 3200,0 1920x1080 points: in pixels the 1x display's frame
        // lies inside the main display's.
        let main = display(
            "main",
            Area {
                x: 0,
                y: 0,
                width: 6400,
                height: 3600,
            },
            2.0,
        );
        let side = display(
            "side",
            Area {
                x: 3200,
                y: 0,
                width: 1920,
                height: 1080,
            },
            1.0,
        );
        let all = [main.clone(), side.clone()];
        // Dragged to 4000,500 points on the 1x display, read at its 1x.
        let on_side = Area {
            x: 4000,
            y: 500,
            width: 300,
            height: 60,
        };
        let (bar, found) = display_in_points(on_side, 1.0, &all).unwrap();
        assert_eq!(found.key, "side");
        assert_eq!(bar, on_side);
        // At 1000,500 points on the main display, read at its 2x.
        let on_main = Area {
            x: 2000,
            y: 1000,
            width: 600,
            height: 120,
        };
        let (bar, found) = display_in_points(on_main, 2.0, &all).unwrap();
        assert_eq!(found.key, "main");
        assert_eq!(bar, on_main);
        // Read at the main display's 2x but sitting on the 1x display, as
        // while it is dragged across: given in the 1x display's pixels.
        let crossing = Area {
            x: 8000,
            y: 1000,
            width: 600,
            height: 120,
        };
        let (bar, found) = display_in_points(crossing, 2.0, &all).unwrap();
        assert_eq!(found.key, "side");
        assert_eq!(
            bar,
            Area {
                x: 4000,
                y: 500,
                width: 300,
                height: 60,
            }
        );
        // Off every display.
        let off = Area {
            x: -5000,
            y: -5000,
            width: 300,
            height: 60,
        };
        assert_eq!(display_in_points(off, 1.0, &all), None);
    }

    #[test]
    fn the_pointer_is_found_on_a_display_of_another_scale_in_points() {
        // The #207 layout: the main display at 2x (0,0 3200x1800 points), a
        // 1x display above it and a 2x display to its right, each frame in
        // pixels at its own scale.
        let main = Area {
            x: 0,
            y: 0,
            width: 6400,
            height: 3600,
        };
        let above = Area {
            x: 640,
            y: -1080,
            width: 2560,
            height: 1080,
        };
        let right = Area {
            x: 6400,
            y: 0,
            width: 3840,
            height: 2160,
        };
        // At 1000,-500 points, read as pixels at the main display's 2x.
        let on_above = (2000.0, -1000.0);
        assert!(pointer_in_points(on_above, 2.0, above, 1.0));
        assert!(!pointer_in_points(on_above, 2.0, main, 2.0));
        assert!(!pointer_in_points(on_above, 2.0, right, 2.0));
        // At 4000,500 points.
        let on_right = (8000.0, 1000.0);
        assert!(pointer_in_points(on_right, 2.0, right, 2.0));
        assert!(!pointer_in_points(on_right, 2.0, main, 2.0));
        // At 3199,10 points, just inside the main display's right edge.
        let on_main = (6398.0, 20.0);
        assert!(pointer_in_points(on_main, 2.0, main, 2.0));
        assert!(!pointer_in_points(on_main, 2.0, above, 1.0));
    }
}
