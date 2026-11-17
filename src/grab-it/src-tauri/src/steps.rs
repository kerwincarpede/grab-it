//! Step capture: every click while it runs saves the window under the
//! pointer as a normal capture, with a numbered step badge where the click
//! landed, and adds it to a guide. Stopping opens the Guide window.
//!
//! The guide is `<save folder>/guides/Grab-it Guide <time>.guide.json`:
//! `{version: 1, steps: [{capture, description}]}` in step order, where
//! `capture` is the PNG's path from the save folder. Each capture's
//! annotations sidecar holds one `step` shape whose `number` is the step's
//! place in the guide; reordering or deleting steps rewrites those numbers.
//!
//! The frame is taken when the button goes down, so it shows the screen
//! before the click. A click within [`REPEAT_DISTANCE`] of the last step in
//! the same window, on a frame that barely changed, adds nothing; nor does
//! the second click of a double click. Clicks come from rdev's listener
//! (input.rs), which Wayland does not allow.

use std::{
    collections::VecDeque,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use base64::{Engine, prelude::BASE64_STANDARD};
use chrono::{DateTime, Local};
use image::{DynamicImage, GrayImage, Rgba, RgbaImage, imageops};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    actions, ai,
    capture::{self, CaptureMode, Foreground, Rect},
    commands::{SettingsState, lock as lock_settings},
    editor, guide_export,
    input::{self, InputKind},
    permissions,
    quick::{self, QuickItem},
    screen, tray, windows,
};

/// The folder in the save folder that holds the guides.
pub const GUIDES_DIR: &str = "guides";
/// A guide file's name ends in this.
pub const GUIDE_SUFFIX: &str = ".guide.json";
/// Emitted to the Guide window when a step's description arrives from the
/// AI, with the guide's path.
pub const GUIDE_CHANGED_EVENT: &str = "guide-changed";

/// How often the session looks for new clicks.
const POLL: Duration = Duration::from_millis(10);
/// A window smaller than this, in points, is captured with its monitor so
/// the step has some context.
const SMALL_WINDOW: (f64, f64) = (400.0, 300.0);
/// A click this close to the last step's marker, in image pixels, may be a
/// repeat of it.
const REPEAT_DISTANCE: f64 = 24.0;
/// ...and is one when the 64x64 grey frames differ by less than this share.
const REPEAT_DIFFERENCE: f64 = 0.01;
/// The side of the grey frames compared.
const THUMB_SIDE: u32 = 64;
/// A second click this soon and this close is a double click: one step.
const DOUBLE_CLICK: Duration = Duration::from_millis(500);
const DOUBLE_CLICK_DISTANCE: f64 = 4.0;
/// The badge's colour and radius in points: the editor's first colour and
/// default step size.
const STEP_COLOR: &str = "#e5484d";
const STEP_RADIUS: f64 = 20.0;
/// How many of the clicks that stop a step capture from the tray or the
/// hub land outside Grab-it, so are taken as steps before the stop is
/// seen, when they cannot be told apart by what they hit. Windows: none
/// by count; its stopping clicks are the ones on the taskbar or the tray's
/// overflow flyout (see [`kept_at_stop`]), and the menu and the hub are
/// Grab-it's own. macOS: none, since the status item, its menu and the hub
/// are all Grab-it's, and a click on the status item that the window list
/// misses is skipped by the icon's hover (see [`tray::pointer_over_icon`]),
/// as is any click on the tray icon where it reports hover. Linux: the
/// click on the icon and the one on the menu item, both shown by the
/// panel's tray host, which reports no hover.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const STOP_CLICKS_OUTSIDE: usize = 2;
#[cfg(any(target_os = "windows", target_os = "macos"))]
const STOP_CLICKS_OUTSIDE: usize = 0;
/// How many of the latest steps wait for a later click, or the stop, to
/// say whether they were stopping clicks. Windows: the chevron on the
/// taskbar and the icon in the overflow flyout.
#[cfg(target_os = "windows")]
const HELD_STEPS: usize = 2;
#[cfg(not(target_os = "windows"))]
const HELD_STEPS: usize = STOP_CLICKS_OUTSIDE;
/// A step is taken for one of those clicks only when it was clicked this
/// soon before the stop: an older one is the user's.
const STOP_GESTURE: Duration = Duration::from_secs(15);
/// How long the AI may take over one step's description.
const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(120);
/// The longest description kept from the AI.
const MAX_DESCRIPTION_CHARS: usize = 200;

const STEP_SYSTEM_PROMPT: &str = "You write short, clear how-to guides from screenshots.";
const STEP_PROMPT: &str = "The screenshot shows the screen just before the user clicked where the \
red numbered marker is. Write one short imperative sentence, under 15 words, saying what the user \
does in this step, for example \"Click Save in the toolbar.\" Name the button, link or field \
clicked when it can be read. Reply with JSON only: {\"description\": \"...\"}.";

/// A guide file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guide {
    pub version: u32,
    pub steps: Vec<GuideStep>,
}

/// One step: its capture, as a path from the save folder, and what it says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuideStep {
    pub capture: String,
    pub description: String,
}

impl Default for Guide {
    fn default() -> Self {
        Self {
            version: 1,
            steps: Vec::new(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where a guide started at `time` is written, not overwriting another.
pub fn guide_path(save_folder: &Path, time: &DateTime<Local>) -> PathBuf {
    let dir = save_folder.join(GUIDES_DIR);
    let base = format!("Grab-it Guide {}", time.format("%Y-%m-%d %H-%M-%S"));
    let mut path = dir.join(format!("{base}{GUIDE_SUFFIX}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}){GUIDE_SUFFIX}"));
        n += 1;
    }
    path
}

/// The guide's name: its file name without `.guide.json`.
pub fn guide_title(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.strip_suffix(GUIDE_SUFFIX).unwrap_or(&name).to_owned()
}

pub fn read_guide(path: &Path) -> Result<Guide, String> {
    let text = fs::read_to_string(path)
        .map_err(|err| format!("could not open the guide {}: {err}", path.display()))?;
    let guide: Guide =
        serde_json::from_str(&text).map_err(|err| format!("the guide is not valid: {err}"))?;
    if guide.version != 1 {
        return Err(format!("unsupported guide version {}", guide.version));
    }
    Ok(guide)
}

/// Writes the guide in one step, through a temporary file.
pub fn write_guide(path: &Path, guide: &Guide) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("could not save the guide: {err}"))?;
    }
    let mut json = serde_json::to_string_pretty(guide).map_err(|err| err.to_string())?;
    json.push('\n');
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)
        .and_then(|()| fs::rename(&tmp, path))
        .map_err(|err| format!("could not save the guide: {err}"))
}

/// `capture` as a path from the save folder, with `/` between parts.
pub fn relative_capture(save_folder: &Path, capture: &Path) -> String {
    let relative = capture.strip_prefix(save_folder).unwrap_or(capture);
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// The capture a step names, refusing paths that leave the save folder.
pub fn resolve_capture(save_folder: &Path, capture: &str) -> Result<PathBuf, String> {
    let relative = Path::new(capture);
    let inside = relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !inside || capture.is_empty() {
        return Err(format!("`{capture}` is not a capture in the save folder"));
    }
    Ok(save_folder.join(relative))
}

/// The annotations of a step capture: one badge at `x`, `y` in image
/// pixels, numbered `number`.
pub fn step_annotations(x: f64, y: f64, radius: f64, number: usize) -> Value {
    json!({
        "version": 1,
        "shapes": [{
            "id": "guide-step",
            "type": "step",
            "color": STEP_COLOR,
            "x": round1(x),
            "y": round1(y),
            "radius": round1(radius),
            "number": number,
        }],
        "crop": null,
    })
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Sets every numbered step badge in `annotations` to `number`. Badges the
/// user added in the editor, which have no number, are left alone. True
/// when anything changed.
pub fn renumber_annotations(annotations: &mut Value, number: usize) -> bool {
    let Some(shapes) = annotations.get_mut("shapes").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for shape in shapes {
        let is_step = shape.get("type").and_then(Value::as_str) == Some("step");
        if is_step
            && let Some(current) = shape.get_mut("number")
            && current.as_u64() != Some(number as u64)
        {
            *current = json!(number);
            changed = true;
        }
    }
    changed
}

/// Gives each step's badge its place in `guide`, rewriting the sidecars
/// that changed. A missing capture or sidecar is skipped.
pub fn renumber(save_folder: &Path, guide: &Guide) -> Result<(), String> {
    for (index, step) in guide.steps.iter().enumerate() {
        let Ok(png) = resolve_capture(save_folder, &step.capture) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(capture::annotations_path(&png)) else {
            continue;
        };
        let Ok(mut annotations) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if renumber_annotations(&mut annotations, index + 1) {
            editor::write_annotations(&png, &annotations)?;
        }
    }
    Ok(())
}

/// The default description: `Click in <app>`.
pub fn fallback_description(app_name: &str) -> String {
    let app_name = app_name.trim();
    if app_name.is_empty() {
        "Click in the window".into()
    } else {
        format!("Click in {app_name}")
    }
}

/// The sentence in the AI's reply: the `description` of its JSON, or the
/// reply itself when it sent plain text. None when it is empty.
pub fn parse_step_description(reply: &str) -> Option<String> {
    let from_json = reply
        .find('{')
        .zip(reply.rfind('}'))
        .filter(|(start, end)| start < end)
        .and_then(|(start, end)| serde_json::from_str::<Value>(&reply[start..=end]).ok())
        .and_then(|value| {
            value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let text = from_json.unwrap_or_else(|| {
        reply
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_owned()
    });
    let text = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .to_owned();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_DESCRIPTION_CHARS).collect())
}

/// Whether a window of `width` by `height` pixels at `pixels_per_point` is
/// too small to show a step on its own.
pub fn is_small(width: u32, height: u32, pixels_per_point: f64) -> bool {
    let per_point = if pixels_per_point > 0.0 {
        pixels_per_point
    } else {
        1.0
    };
    f64::from(width) / per_point < SMALL_WINDOW.0 || f64::from(height) / per_point < SMALL_WINDOW.1
}

/// Where the click at `x`, `y` in desktop coordinates lands in an image of
/// `area` (in desktop coordinates) that is `image_size` pixels.
pub fn marker_at(x: f64, y: f64, area: &Rect, image_size: (u32, u32)) -> (f64, f64) {
    let scale_x = f64::from(image_size.0) / f64::from(area.width.max(1));
    let scale_y = f64::from(image_size.1) / f64::from(area.height.max(1));
    (
        (x - f64::from(area.x)) * scale_x,
        (y - f64::from(area.y)) * scale_y,
    )
}

/// A 64x64 grey copy of `image`, for telling repeated frames apart.
pub fn thumbnail(image: &RgbaImage) -> GrayImage {
    let grey = DynamicImage::ImageRgba8(image.clone()).into_luma8();
    imageops::resize(
        &grey,
        THUMB_SIDE,
        THUMB_SIDE,
        imageops::FilterType::Triangle,
    )
}

/// The share, 0 to 1, by which two grey frames differ.
pub fn difference(a: &GrayImage, b: &GrayImage) -> f64 {
    if a.dimensions() != b.dimensions() {
        return 1.0;
    }
    let total: u64 = a
        .as_raw()
        .iter()
        .zip(b.as_raw())
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    total as f64 / (a.as_raw().len().max(1) as f64 * 255.0)
}

/// The last step taken, to tell a repeated click.
#[derive(Debug, Clone)]
pub struct LastStep {
    /// The window's id, or None for a monitor capture.
    pub window: Option<u32>,
    pub marker: (f64, f64),
    pub thumb: GrayImage,
}

/// Whether a click at `marker` in `window`, on a frame whose grey copy is
/// `thumb`, repeats `last`: same window, near its marker, and a frame that
/// barely changed.
pub fn is_repeat(
    last: Option<&LastStep>,
    window: Option<u32>,
    marker: (f64, f64),
    thumb: &GrayImage,
) -> bool {
    let Some(last) = last else {
        return false;
    };
    let distance = (marker.0 - last.marker.0).hypot(marker.1 - last.marker.1);
    last.window == window
        && distance <= REPEAT_DISTANCE
        && difference(&last.thumb, thumb) < REPEAT_DIFFERENCE
}

/// Whether a click at `at`, `position` is the second of a double click
/// whose first was `previous`.
pub fn is_double_click(
    previous: Option<(Instant, (f64, f64))>,
    at: Instant,
    position: (f64, f64),
) -> bool {
    previous.is_some_and(|(then, place)| {
        at.saturating_duration_since(then) <= DOUBLE_CLICK
            && (position.0 - place.0).hypot(position.1 - place.1) <= DOUBLE_CLICK_DISTANCE
    })
}

/// Draws a filled badge at `marker` on a copy of `image`, so the AI sees
/// where the click was.
fn with_marker(image: &RgbaImage, marker: (f64, f64), radius: f64) -> RgbaImage {
    let mut marked = image.clone();
    let (cx, cy) = marker;
    let r2 = radius * radius;
    let left = (cx - radius).floor().max(0.0) as u32;
    let top = (cy - radius).floor().max(0.0) as u32;
    let right = ((cx + radius).ceil().max(0.0) as u32).min(marked.width());
    let bottom = ((cy + radius).ceil().max(0.0) as u32).min(marked.height());
    for y in top..bottom {
        for x in left..right {
            let dx = f64::from(x) + 0.5 - cx;
            let dy = f64::from(y) + 0.5 - cy;
            if dx * dx + dy * dy <= r2 {
                marked.put_pixel(x, y, Rgba([229, 72, 77, 255]));
            }
        }
    }
    marked
}

/// The step capture under way.
struct Session {
    stop: Arc<AtomicBool>,
    /// Set when it was stopped by a click on the tray or the hub.
    stopped_by_click: Arc<AtomicBool>,
    guide: PathBuf,
    thread: Option<JoinHandle<()>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Serialises writes to a guide between the session and its describer.
static GUIDE_WRITE: Mutex<()> = Mutex::new(());
/// The guide the Guide window shows.
static OPEN_GUIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Whether a step capture is under way.
pub fn is_running() -> bool {
    lock(&SESSION).is_some()
}

/// How a step capture was started or stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The hotkey or the command line.
    Keys,
    /// The tray menu or the hub, whose clicks the session also sees.
    Click,
}

/// Starts a step capture, or stops the one under way and opens its guide.
pub fn toggle(app: &AppHandle, trigger: Trigger) {
    if stop(app, trigger) {
        return;
    }
    start(app);
}

fn start(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        actions::report_failure(
            app,
            "Step capture is not available on Wayland: apps cannot watch clicks there.",
        );
        return;
    }
    if crate::record::session(app).is_some() {
        actions::report_failure(app, "Stop the recording before starting a step capture.");
        return;
    }
    if !permissions::ensure_screen_capture(app) || !permissions::ensure_input_monitoring(app) {
        return;
    }
    // Starting the listener waits to see whether it fails: off the caller,
    // which is often the main thread.
    let app = app.clone();
    std::thread::spawn(move || begin(&app));
}

fn begin(app: &AppHandle) {
    let mut session = lock(&SESSION);
    if session.is_some() {
        return;
    }
    let capture = match input::Capture::start(true, false) {
        Ok(capture) => capture,
        Err(err) => return actions::report_failure(app, &err),
    };
    let folder = save_folder(app);
    let guide = guide_path(&folder, &Local::now());
    if let Err(err) = write_guide(&guide, &Guide::default()) {
        return actions::report_failure(app, &err);
    }
    // Hover on the icon from before the session says nothing about its clicks.
    tray::reset_hover();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped_by_click = Arc::new(AtomicBool::new(false));
    let thread = {
        let app = app.clone();
        let stop = stop.clone();
        let stopped_by_click = stopped_by_click.clone();
        let guide = guide.clone();
        std::thread::Builder::new()
            .name("grab-it-steps".into())
            .spawn(move || run(&app, &capture, &stop, &stopped_by_click, &folder, &guide))
    };
    let thread = match thread {
        Ok(thread) => thread,
        Err(err) => {
            let _ = fs::remove_file(&guide);
            return actions::report_failure(app, &format!("could not start step capture: {err}"));
        }
    };
    *session = Some(Session {
        stop,
        stopped_by_click,
        guide,
        thread: Some(thread),
    });
    drop(session);
    // No card is shown: it would be in the first step's frame. The pill
    // is left out of captures where the system allows.
    tray::set_steps(app, true);
    crate::steps_bar::show(app);
    // Stopped while the pill was opening: its close may have run first.
    if !is_running() {
        crate::steps_bar::close(app);
    }
}

/// Stops the step capture under way and opens its guide. False when none
/// runs. A guide with no steps is removed.
fn stop(app: &AppHandle, trigger: Trigger) -> bool {
    let Some(mut session) = lock(&SESSION).take() else {
        return false;
    };
    session
        .stopped_by_click
        .store(trigger == Trigger::Click, Ordering::SeqCst);
    session.stop.store(true, Ordering::SeqCst);
    tray::set_steps(app, false);
    let app = app.clone();
    // Off the caller's thread: waiting for the last step, and making the
    // window, must not happen inside a menu or hotkey handler.
    std::thread::spawn(move || {
        crate::steps_bar::close(&app);
        if let Some(thread) = session.thread.take() {
            let _ = thread.join();
        }
        let guide = session.guide;
        let steps = read_guide(&guide)
            .map(|guide| guide.steps.len())
            .unwrap_or(0);
        if steps == 0 {
            let _ = fs::remove_file(&guide);
            quick::show(
                &app,
                QuickItem::Notice {
                    title: "No steps captured".into(),
                    message: "Click through the task while step capture runs.".into(),
                },
            );
        } else if let Err(err) = show_guide(&app, &guide) {
            eprintln!("Grab-it: could not open the guide: {err}");
        }
    });
    true
}

fn save_folder(app: &AppHandle) -> PathBuf {
    lock_settings(&app.state::<SettingsState>())
        .get()
        .save_folder
        .clone()
}

/// A frame grabbed for a click, to be saved by the saver.
pub struct Grabbed {
    image: RgbaImage,
    marker: (f64, f64),
    radius: f64,
    image_per_point: f64,
    mode: CaptureMode,
    foreground: Foreground,
    /// The shell part its click hit, for telling stopping clicks apart.
    shell: Option<screen::Shell>,
    /// Its click hit a popup or nothing, so it may have been on the tray
    /// icon (see [`Waiting`]).
    maybe_icon: bool,
}

/// A step to describe once it is saved, found again by its capture so a
/// reordered guide still gets the right text.
struct DescribeJob {
    capture: String,
    fallback: String,
    png: Vec<u8>,
}

/// A step held back until the next click, or the stop, shows it was not
/// one of the clicks that stopped the capture.
pub struct Held<T> {
    /// When its click was seen.
    pub at: Instant,
    /// The shell part its click hit.
    pub shell: Option<screen::Shell>,
    pub step: T,
}

/// The held steps kept when the session stops at `stopped_at`, oldest
/// first. Stopped from the keyboard, all of them. Stopped by clicking, the
/// stopping clicks that landed outside Grab-it are dropped (those on
/// Grab-it were never taken): a click on the taskbar's tray icon, or on the
/// overflow flyout's icon with the taskbar chevron click that opened it,
/// then the last `outside` of the rest. A step clicked longer than
/// [`STOP_GESTURE`] before the stop is the user's and is kept.
pub fn kept_at_stop<T>(
    mut held: Vec<Held<T>>,
    trigger: Trigger,
    stopped_at: Instant,
    outside: usize,
) -> Vec<T> {
    if trigger == Trigger::Click {
        let recent = |held: &[Held<T>], shell: Option<screen::Shell>| {
            held.last().is_some_and(|last| {
                stopped_at.saturating_duration_since(last.at) <= STOP_GESTURE
                    && (shell.is_none() || last.shell == shell)
            })
        };
        if recent(&held, Some(screen::Shell::TrayOverflow)) {
            held.pop();
            if recent(&held, Some(screen::Shell::Taskbar)) {
                held.pop();
            }
        } else if recent(&held, Some(screen::Shell::Taskbar)) {
            held.pop();
        }
        let mut dropped = 0;
        while dropped < outside && recent(&held, None) {
            held.pop();
            dropped += 1;
        }
    }
    held.into_iter().map(|held| held.step).collect()
}

/// A step about to be saved, waiting until [`tray::HOVER_LEAD`] has passed
/// since its click: the icon's hover event can arrive after a click on it,
/// as when an auto-hidden macOS menu bar slides in under a still pointer
/// and the icon's first event is its click.
pub struct Waiting<T> {
    /// When its click was seen.
    pub at: Instant,
    /// Whether a click on the icon would have hit what this one did.
    pub maybe_icon: bool,
    pub step: T,
}

/// Takes from the front of `waiting` the steps whose click is at least
/// [`tray::HOVER_LEAD`] old at `now`, oldest first, dropping those that
/// `over_icon` says were on the tray icon.
pub fn ripe<T>(
    waiting: &mut VecDeque<Waiting<T>>,
    now: Instant,
    over_icon: impl Fn(Instant) -> bool,
) -> Vec<T> {
    let mut ripe = Vec::new();
    while let Some(next) = waiting.front() {
        if now.saturating_duration_since(next.at) < tray::HOVER_LEAD {
            break;
        }
        if let Some(next) = waiting.pop_front()
            && !(next.maybe_icon && over_icon(next.at))
        {
            ripe.push(next.step);
        }
    }
    ripe
}

/// Whether the click that stops a session by clicking is always on
/// Grab-it's own hub or menu. On Linux it is on the panel's menu, one of
/// [`STOP_CLICKS_OUTSIDE`].
const STOP_CLICK_IS_OWN: bool = cfg!(any(target_os = "windows", target_os = "macos"));

/// How long before the stop the click that stopped it can have been seen:
/// the hub takes `HIDE_SETTLE` to hide, and the click is looked at only
/// once the grab before it is done. An older last click is the user's, as
/// when the tray menu was driven from the keyboard.
const STOP_CLICK_LAG: Duration = Duration::from_secs(2);

/// The click to drop as the one that stopped the session: the last click
/// seen, `last_click`, when the session was stopped by a click on Grab-it's
/// own hub or menu (`own`) and that click is recent enough to be it.
pub fn stopping_click(
    last_click: Option<Instant>,
    trigger: Trigger,
    stopped_at: Instant,
    own: bool,
) -> Option<Instant> {
    let at = last_click?;
    (own && trigger == Trigger::Click && stopped_at.saturating_duration_since(at) <= STOP_CLICK_LAG)
        .then_some(at)
}

/// Drops the steps for the click seen at `at` from `held` and `waiting`.
pub fn drop_click<T>(
    held: &mut VecDeque<Held<T>>,
    waiting: &mut VecDeque<Waiting<T>>,
    at: Instant,
) {
    held.retain(|held| held.at != at);
    waiting.retain(|waiting| waiting.at != at);
}

/// The session's loop. Each click's frame is grabbed as soon as the click
/// is seen; a saver thread writes it, so slow saves never delay the next
/// grab. The latest [`HELD_STEPS`] steps wait until later clicks,
/// or the stop, say whether they are kept; then each [`Waiting`] step
/// waits for any late hover on the tray icon.
fn run(
    app: &AppHandle,
    capture: &input::Capture,
    stop: &AtomicBool,
    stopped_by_click: &AtomicBool,
    folder: &Path,
    guide: &Path,
) {
    let ai = ai::current_settings(app);
    let (jobs, queue) = mpsc::channel::<DescribeJob>();
    let describes = ai.enabled;
    if describes {
        let app = app.clone();
        let guide = guide.to_path_buf();
        std::thread::spawn(move || describe_steps(&app, &ai, &guide, &queue));
    }
    let (frames, received) = mpsc::channel::<Grabbed>();
    let saver = {
        let app = app.clone();
        let folder = folder.to_path_buf();
        let guide = guide.to_path_buf();
        std::thread::spawn(move || {
            for (index, grabbed) in received.into_iter().enumerate() {
                match save_step(&app, &folder, &guide, &grabbed, index + 1) {
                    Ok(job) if describes => {
                        let _ = jobs.send(job);
                    }
                    Ok(_) => {}
                    Err(err) => eprintln!("Grab-it: could not save a step: {err}"),
                }
            }
        })
    };
    let mut last: Option<LastStep> = None;
    let mut last_click: Option<(Instant, (f64, f64))> = None;
    let mut held: VecDeque<Held<Grabbed>> = VecDeque::new();
    let mut waiting: VecDeque<Waiting<Grabbed>> = VecDeque::new();
    let wait = |waiting: &mut VecDeque<Waiting<Grabbed>>, at: Instant, step: Grabbed| {
        waiting.push_back(Waiting {
            at,
            maybe_icon: step.maybe_icon,
            step,
        });
    };
    let mut handle = |events: Vec<input::InputEvent>,
                      held: &mut VecDeque<Held<Grabbed>>,
                      waiting: &mut VecDeque<Waiting<Grabbed>>| {
        for event in events {
            let (InputKind::Click, Some(position)) = (&event.kind, event.position) else {
                continue;
            };
            let double = is_double_click(last_click, event.at, position);
            last_click = Some((event.at, position));
            if double {
                continue;
            }
            match grab(position, event.at, last.as_ref()) {
                Ok(Some((step, grabbed))) => {
                    last = Some(step);
                    held.push_back(Held {
                        at: event.at,
                        shell: grabbed.shell,
                        step: grabbed,
                    });
                    while held.len() > HELD_STEPS {
                        if let Some(oldest) = held.pop_front() {
                            wait(waiting, oldest.at, oldest.step);
                        }
                    }
                }
                Ok(None) => {}
                Err(err) => eprintln!("Grab-it: could not take a step: {err}"),
            }
        }
    };
    while !stop.load(Ordering::SeqCst) {
        handle(capture.take(), &mut held, &mut waiting);
        for step in ripe(&mut waiting, Instant::now(), tray::pointer_over_icon) {
            let _ = frames.send(step);
        }
        std::thread::sleep(POLL);
    }
    let stopped_at = Instant::now();
    // Clicks seen just before the stop, such as the one on the menu item
    // that stopped it, are still looked at: Grab-it's own, and those on
    // its tray icon, are skipped.
    handle(capture.take(), &mut held, &mut waiting);
    let trigger = if stopped_by_click.load(Ordering::SeqCst) {
        Trigger::Click
    } else {
        Trigger::Keys
    };
    // The click that stopped it was on Grab-it's hub or menu, but it is
    // only looked at once the grab before it is done. After a full-monitor
    // grab, such as one for a click on the tray icon, that can be a second
    // later, when the hub has closed and the click seems to land on the
    // window behind it. So a recent last click is dropped whatever it hit;
    // an older one is the user's, since the menu can be used from the
    // keyboard with no click at all.
    if let Some(at) = stopping_click(
        last_click.map(|(at, _)| at),
        trigger,
        stopped_at,
        STOP_CLICK_IS_OWN,
    ) {
        drop_click(&mut held, &mut waiting, at);
    }
    let held = held
        .into_iter()
        .map(|held| Held {
            at: held.at,
            shell: held.shell,
            step: (held.at, held.step),
        })
        .collect();
    for (at, kept) in kept_at_stop(held, trigger, stopped_at, STOP_CLICKS_OUTSIDE) {
        wait(&mut waiting, at, kept);
    }
    if let Some(newest) = waiting.back() {
        let ready = newest.at + tray::HOVER_LEAD;
        std::thread::sleep(ready.saturating_duration_since(Instant::now()));
    }
    for step in ripe(&mut waiting, Instant::now(), tray::pointer_over_icon) {
        let _ = frames.send(step);
    }
    drop(frames);
    // The guide is complete before the Guide window opens; the describer
    // finishes the steps it was sent, then ends.
    let _ = saver.join();
}

/// Grabs the frame for a click at `position`: the window under it, or its
/// monitor for a small window, a menu or popover, or the desktop. None for
/// a click on Grab-it itself, on its tray icon, or one that repeats `last`.
fn grab(
    position: (f64, f64),
    at: Instant,
    last: Option<&LastStep>,
) -> Result<Option<(LastStep, Grabbed)>, String> {
    let (x, y) = position;
    let hit = screen::hit_test(x, y);
    if hit == screen::Hit::Own {
        return Ok(None);
    }
    // The window list may not report the icon as Grab-it's, as with an
    // auto-hidden macOS menu bar, so its hover events decide: now, and
    // again once a late hover event would have arrived (see [`Waiting`]).
    // A click that hit an ordinary window or the Windows shell is judged
    // as before.
    let maybe_icon = matches!(hit, screen::Hit::Popup | screen::Hit::Nothing);
    if maybe_icon && tray::pointer_over_icon(at) {
        return Ok(None);
    }
    let shell = match hit {
        screen::Hit::Shell(shell) => Some(shell),
        _ => None,
    };
    let monitors = screen::monitors()?;
    let monitor = screen::monitor_at(&monitors, x, y)
        .or_else(|| monitors.first())
        .cloned()
        .ok_or("no monitors found")?;
    // macOS lists windows in points; elsewhere they are pixels.
    let pixels_per_point = if cfg!(target_os = "macos") {
        1.0
    } else {
        monitor.scale_factor
    };
    let window = match hit {
        screen::Hit::Window(window)
            if !is_small(window.rect.width, window.rect.height, pixels_per_point) =>
        {
            Some(window)
        }
        _ => None,
    };
    let window_frame = window.as_ref().and_then(|window| {
        screen::capture_window(window.id).ok().map(|image| {
            (
                image,
                window.rect,
                Some(window.id),
                screen::foreground_of(window),
                CaptureMode::Window,
            )
        })
    });
    let (image, area, window_id, foreground, mode) = match window_frame {
        Some(frame) => frame,
        None => monitor_step(&monitor, &screen::foreground())?,
    };
    let marker = marker_at(x, y, &area, image.dimensions());
    let thumb = thumbnail(&image);
    if is_repeat(last, window_id, marker, &thumb) {
        return Ok(None);
    }
    let image_per_point =
        f64::from(image.width()) * pixels_per_point / f64::from(area.width.max(1));
    Ok(Some((
        LastStep {
            window: window_id,
            marker,
            thumb,
        },
        Grabbed {
            image,
            marker,
            radius: STEP_RADIUS * image_per_point.max(0.5),
            image_per_point,
            mode,
            foreground,
            shell,
            maybe_icon,
        },
    )))
}

/// Saves a grabbed step as capture `number` of the guide.
fn save_step(
    app: &AppHandle,
    folder: &Path,
    guide: &Path,
    grabbed: &Grabbed,
    number: usize,
) -> Result<DescribeJob, String> {
    let saved = capture::save_capture(
        folder,
        &grabbed.image,
        grabbed.mode,
        &grabbed.foreground,
        Some(grabbed.image_per_point),
        Local::now(),
    )
    .map_err(|err| err.to_string())?;
    editor::write_annotations(
        &saved.path,
        &step_annotations(grabbed.marker.0, grabbed.marker.1, grabbed.radius, number),
    )?;
    crate::library::record_capture(app, &saved.path);
    let _ = app.emit(actions::CAPTURE_SAVED_EVENT, &saved);

    let fallback = fallback_description(grabbed.foreground.app.as_deref().unwrap_or(""));
    let capture = relative_capture(folder, &saved.path);
    {
        let _writing = lock(&GUIDE_WRITE);
        let mut current = read_guide(guide).unwrap_or_default();
        current.steps.push(GuideStep {
            capture: capture.clone(),
            description: fallback.clone(),
        });
        write_guide(guide, &current)?;
    }
    let png = ai::fit_png(DynamicImage::ImageRgba8(with_marker(
        &grabbed.image,
        grabbed.marker,
        grabbed.radius,
    )))
    .unwrap_or_default();
    Ok(DescribeJob {
        capture,
        fallback,
        png,
    })
}

type Frame = (RgbaImage, Rect, Option<u32>, Foreground, CaptureMode);

fn monitor_step(monitor: &screen::MonitorInfo, foreground: &Foreground) -> Result<Frame, String> {
    let image = screen::capture_monitor(monitor.index)?;
    let area = Rect {
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
    };
    Ok((image, area, None, foreground.clone(), CaptureMode::Monitor))
}

/// Puts the AI's `description` on the step showing `capture`, wherever it
/// has moved, unless the user changed its text from `fallback`. True when
/// it was applied.
pub fn apply_description(
    guide: &mut Guide,
    capture: &str,
    fallback: &str,
    description: String,
) -> bool {
    match guide.steps.iter_mut().find(|step| step.capture == capture) {
        Some(step) if step.description == fallback => {
            step.description = description;
            true
        }
        _ => false,
    }
}

/// Describes each step it is sent with the AI, on the step capture's own
/// thread rather than the Library's queue, replacing the fallback text
/// unless the user changed it meanwhile.
fn describe_steps(
    app: &AppHandle,
    ai: &crate::settings::AiSettings,
    guide: &Path,
    queue: &mpsc::Receiver<DescribeJob>,
) {
    let clients = ai::Clients::new(DESCRIBE_TIMEOUT);
    let schema = json!({
        "type": "object",
        "properties": { "description": { "type": "string" } },
        "required": ["description"],
        "additionalProperties": false,
    });
    for job in queue {
        if job.png.is_empty() {
            continue;
        }
        let reply = ai::ask(
            &clients,
            ai,
            &ai::Ask {
                system: STEP_SYSTEM_PROMPT,
                prompt: STEP_PROMPT,
                png: &job.png,
                schema: &schema,
                max_tokens: 120,
            },
        );
        let description = match reply {
            Ok(reply) => parse_step_description(&reply),
            Err(err) => {
                eprintln!("Grab-it: could not describe {}: {err}", job.capture);
                None
            }
        };
        let Some(description) = description else {
            continue;
        };
        let _writing = lock(&GUIDE_WRITE);
        let Ok(mut current) = read_guide(guide) else {
            continue;
        };
        if apply_description(&mut current, &job.capture, &job.fallback, description)
            && write_guide(guide, &current).is_ok()
        {
            let _ = app.emit(GUIDE_CHANGED_EVENT, guide);
        }
    }
}

/// Opens the Guide window on `guide`, or points the open one at it.
pub fn show_guide(app: &AppHandle, guide: &Path) -> tauri::Result<()> {
    *lock(&OPEN_GUIDE) = Some(guide.to_path_buf());
    windows::show_guide(app, &guide_title(guide))
}

fn open_guide() -> Result<PathBuf, String> {
    lock(&OPEN_GUIDE)
        .clone()
        .ok_or_else(|| "no guide is open".to_owned())
}

/// What the Guide window shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideInfo {
    pub path: PathBuf,
    pub title: String,
    pub steps: Vec<GuideStepInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideStepInfo {
    pub capture: String,
    pub description: String,
    /// The capture's annotations sidecar, or null without one.
    pub annotations: Value,
    /// False when the capture's file is gone.
    pub exists: bool,
}

#[tauri::command]
pub fn guide_info(app: AppHandle) -> Result<GuideInfo, String> {
    let path = open_guide()?;
    let folder = save_folder(&app);
    let guide = read_guide(&path)?;
    let steps = guide
        .steps
        .into_iter()
        .map(|step| {
            let png = resolve_capture(&folder, &step.capture).ok();
            let annotations = png
                .as_ref()
                .and_then(|png| fs::read_to_string(capture::annotations_path(png)).ok())
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or(Value::Null);
            GuideStepInfo {
                exists: png.as_ref().is_some_and(|png| png.is_file()),
                capture: step.capture,
                description: step.description,
                annotations,
            }
        })
        .collect();
    Ok(GuideInfo {
        title: guide_title(&path),
        path,
        steps,
    })
}

/// A step capture's PNG.
#[tauri::command]
pub fn guide_image(capture: String, app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let png = resolve_capture(&save_folder(&app), &capture)?;
    let bytes = fs::read(&png).map_err(|err| format!("could not open {}: {err}", png.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Writes the guide's steps in their new order and renumbers their badges.
#[tauri::command]
pub fn guide_save(steps: Vec<GuideStep>, app: AppHandle) -> Result<(), String> {
    let path = open_guide()?;
    let folder = save_folder(&app);
    let guide = Guide { version: 1, steps };
    {
        let _writing = lock(&GUIDE_WRITE);
        write_guide(&path, &guide)?;
    }
    renumber(&folder, &guide)?;
    // Renumbered badges change the steps' drawn thumbnails.
    let _ = app.emit(crate::library::LIBRARY_CHANGED_EVENT, ());
    Ok(())
}

/// Opens a step's capture in the editor.
#[tauri::command]
pub fn guide_open_editor(capture: String, app: AppHandle) -> Result<(), String> {
    let png = resolve_capture(&save_folder(&app), &capture)?;
    std::thread::spawn(move || {
        if let Err(err) = windows::show_editor(&app, &png) {
            eprintln!("Grab-it: could not open the editor: {err}");
        }
    });
    Ok(())
}

/// One flattened step, as the Guide window sends it for export.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStep {
    pub description: String,
    /// The flattened image as base64 PNG.
    pub png: String,
}

fn decode_steps(steps: Vec<ExportStep>) -> Result<Vec<guide_export::Step>, String> {
    steps
        .into_iter()
        .map(|step| {
            let png = BASE64_STANDARD
                .decode(step.png.as_bytes())
                .map_err(|err| format!("a step's image is not valid: {err}"))?;
            guide_export::Step::new(step.description, png)
        })
        .collect()
}

/// Exports the guide as `format` (markdown, html, docx or pptx) to `path`.
#[tauri::command]
pub fn guide_export(format: String, path: PathBuf, steps: Vec<ExportStep>) -> Result<(), String> {
    let format = guide_export::Format::parse(&format)?;
    let title = open_guide()
        .map(|guide| guide_title(&guide))
        .unwrap_or_else(|_| "Grab-it Guide".into());
    guide_export::write(format, &path, &title, &decode_steps(steps)?)
}

/// Copies the guide as HTML with its images, and as Markdown text.
#[tauri::command]
pub fn guide_copy(steps: Vec<ExportStep>, app: AppHandle) -> Result<(), String> {
    let title = open_guide()
        .map(|guide| guide_title(&guide))
        .unwrap_or_else(|_| "Grab-it Guide".into());
    let steps = decode_steps(steps)?;
    let html = guide_export::html(&title, &steps);
    let text = guide_export::markdown_text(&title, &steps);
    app.clipboard()
        .write_html(html, Some(text))
        .map_err(|err| format!("could not copy the guide: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use image::Luma;

    use crate::screen::Shell;

    #[test]
    fn guides_are_named_after_their_start_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let time = Local.with_ymd_and_hms(2026, 3, 4, 5, 6, 7).unwrap();
        let first = guide_path(dir.path(), &time);
        assert_eq!(
            first,
            dir.path()
                .join("guides")
                .join("Grab-it Guide 2026-03-04 05-06-07.guide.json")
        );
        write_guide(&first, &Guide::default()).unwrap();
        let second = guide_path(dir.path(), &time);
        assert_eq!(
            second.file_name().unwrap(),
            "Grab-it Guide 2026-03-04 05-06-07 (2).guide.json"
        );
        assert_eq!(guide_title(&first), "Grab-it Guide 2026-03-04 05-06-07");
    }

    #[test]
    fn a_guide_round_trips_and_other_versions_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("g.guide.json");
        let guide = Guide {
            version: 1,
            steps: vec![GuideStep {
                capture: "originals/a.png".into(),
                description: "Click Save".into(),
            }],
        };
        write_guide(&path, &guide).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"capture\": \"originals/a.png\""));
        assert_eq!(read_guide(&path).unwrap(), guide);
        fs::write(&path, r#"{"version": 2, "steps": []}"#).unwrap();
        assert!(read_guide(&path).is_err());
    }

    #[test]
    fn captures_are_kept_relative_to_the_save_folder() {
        let folder = Path::new("/pictures/Grab-it");
        let png = folder.join("originals").join("a.png");
        assert_eq!(relative_capture(folder, &png), "originals/a.png");
        assert_eq!(resolve_capture(folder, "originals/a.png").unwrap(), png);
        assert!(resolve_capture(folder, "../secret.png").is_err());
        assert!(resolve_capture(folder, "/etc/passwd").is_err());
        assert!(resolve_capture(folder, "").is_err());
    }

    #[test]
    fn renumbering_changes_only_guide_badges() {
        let mut annotations = step_annotations(10.0, 20.0, 20.0, 3);
        annotations["shapes"].as_array_mut().unwrap().push(json!({
            "id": "mine", "type": "step", "color": "#000000", "x": 1, "y": 1, "radius": 10,
        }));
        assert!(renumber_annotations(&mut annotations, 1));
        assert_eq!(annotations["shapes"][0]["number"], 1);
        assert!(annotations["shapes"][1].get("number").is_none());
        assert!(!renumber_annotations(&mut annotations, 1));
    }

    #[test]
    fn renumbering_rewrites_each_steps_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let originals = dir.path().join("originals");
        fs::create_dir_all(&originals).unwrap();
        for (name, number) in [("a.png", 1), ("b.png", 2)] {
            let png = originals.join(name);
            fs::write(&png, b"").unwrap();
            editor::write_annotations(&png, &step_annotations(5.0, 5.0, 20.0, number)).unwrap();
        }
        // b moved first; a missing capture is skipped.
        let guide = Guide {
            version: 1,
            steps: ["originals/b.png", "originals/gone.png", "originals/a.png"]
                .iter()
                .map(|capture| GuideStep {
                    capture: (*capture).into(),
                    description: String::new(),
                })
                .collect(),
        };
        renumber(dir.path(), &guide).unwrap();
        let number = |name: &str| {
            let text =
                fs::read_to_string(capture::annotations_path(&originals.join(name))).unwrap();
            serde_json::from_str::<Value>(&text).unwrap()["shapes"][0]["number"].clone()
        };
        assert_eq!(number("b.png"), 1);
        assert_eq!(number("a.png"), 3);
    }

    #[test]
    fn small_windows_are_measured_in_points() {
        assert!(is_small(399, 800, 1.0));
        assert!(is_small(800, 299, 1.0));
        assert!(!is_small(400, 300, 1.0));
        // 700x500 pixels at 2x is 350x250 points.
        assert!(is_small(700, 500, 2.0));
        assert!(!is_small(800, 600, 2.0));
    }

    #[test]
    fn the_marker_lands_where_the_click_was_in_image_pixels() {
        let area = Rect {
            x: 100,
            y: 50,
            width: 400,
            height: 300,
        };
        assert_eq!(marker_at(150.0, 80.0, &area, (400, 300)), (50.0, 30.0));
        // A 2x window: twice the pixels.
        assert_eq!(marker_at(150.0, 80.0, &area, (800, 600)), (100.0, 60.0));
    }

    fn flat(value: u8) -> GrayImage {
        GrayImage::from_pixel(THUMB_SIDE, THUMB_SIDE, Luma([value]))
    }

    #[test]
    fn a_near_identical_click_in_the_same_window_repeats_the_last_step() {
        let last = LastStep {
            window: Some(7),
            marker: (100.0, 100.0),
            thumb: flat(100),
        };
        assert!(!is_repeat(None, Some(7), (100.0, 100.0), &flat(100)));
        assert!(is_repeat(Some(&last), Some(7), (110.0, 110.0), &flat(101)));
        // Too far, another window, or a frame that changed.
        assert!(!is_repeat(Some(&last), Some(7), (130.0, 100.0), &flat(100)));
        assert!(!is_repeat(Some(&last), Some(8), (100.0, 100.0), &flat(100)));
        assert!(!is_repeat(Some(&last), Some(7), (100.0, 100.0), &flat(110)));
    }

    #[test]
    fn frames_are_compared_as_small_grey_copies() {
        let white = RgbaImage::from_pixel(300, 200, Rgba([255, 255, 255, 255]));
        let mut changed = white.clone();
        for x in 0..150 {
            for y in 0..200 {
                changed.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let a = thumbnail(&white);
        assert_eq!(a.dimensions(), (64, 64));
        assert_eq!(difference(&a, &thumbnail(&white)), 0.0);
        let half = difference(&a, &thumbnail(&changed));
        assert!((0.4..0.6).contains(&half), "{half}");
    }

    #[test]
    fn a_quick_second_click_in_place_is_a_double_click() {
        let at = Instant::now();
        let first = Some((at, (10.0, 10.0)));
        assert!(is_double_click(
            first,
            at + Duration::from_millis(200),
            (12.0, 11.0)
        ));
        assert!(!is_double_click(
            first,
            at + Duration::from_millis(800),
            (10.0, 10.0)
        ));
        assert!(!is_double_click(
            first,
            at + Duration::from_millis(200),
            (40.0, 10.0)
        ));
        assert!(!is_double_click(None, at, (10.0, 10.0)));
    }

    #[test]
    fn a_description_finds_its_step_after_a_reorder() {
        let step = |capture: &str| GuideStep {
            capture: capture.into(),
            description: "Click in Firefox".into(),
        };
        let mut guide = Guide {
            version: 1,
            steps: vec![
                step("originals/a.png"),
                step("originals/b.png"),
                step("originals/c.png"),
            ],
        };
        // The user moved c up and deleted a before b's description arrived.
        guide.steps = vec![step("originals/c.png"), step("originals/b.png")];
        assert!(apply_description(
            &mut guide,
            "originals/b.png",
            "Click in Firefox",
            "Click Save.".into()
        ));
        assert_eq!(guide.steps[0].description, "Click in Firefox");
        assert_eq!(guide.steps[1].description, "Click Save.");
        // A step the user edited, or one deleted, keeps what it has.
        guide.steps[0].description = "Open the menu".into();
        assert!(!apply_description(
            &mut guide,
            "originals/c.png",
            "Click in Firefox",
            "x".into()
        ));
        assert!(!apply_description(
            &mut guide,
            "originals/a.png",
            "Click in Firefox",
            "x".into()
        ));
        assert_eq!(guide.steps[0].description, "Open the menu");
    }

    fn held(stopped_at: Instant, ago: &[u64]) -> Vec<Held<u8>> {
        let clicks: Vec<(u64, Option<Shell>)> = ago.iter().map(|secs| (*secs, None)).collect();
        held_on(stopped_at, &clicks)
    }

    #[test]
    fn steps_wait_for_a_late_hover_on_the_tray_icon() {
        let click = Instant::now();
        let lead = tray::HOVER_LEAD;
        let step = |at: Instant, maybe_icon: bool, step: u8| Waiting {
            at,
            maybe_icon,
            step,
        };
        let mut waiting = VecDeque::from([
            step(click, true, 1),
            step(click, false, 2),
            step(click + lead, true, 3),
        ]);
        // Nothing is judged before the hover could have arrived.
        assert!(ripe(&mut waiting, click + lead / 2, |_| true).is_empty());
        assert_eq!(waiting.len(), 3);
        // The hover stretch began after the click, within the lead: the
        // click was on the icon, so its step is dropped. One that hit a
        // window is kept, and a later click still waits.
        let hover_from = click + lead / 2;
        let over = |at: Instant| hover_from.saturating_duration_since(at) <= lead;
        assert_eq!(ripe(&mut waiting, click + lead, over), vec![2]);
        assert_eq!(waiting.len(), 1);
        // With no hover, it is kept.
        assert_eq!(ripe(&mut waiting, click + lead * 2, |_| false), vec![3]);
        assert!(waiting.is_empty());
    }

    #[test]
    fn the_stop_click_is_dropped_wherever_it_waits() {
        let start = Instant::now();
        let at = |millis: u64| start + Duration::from_millis(millis);
        let mut held = VecDeque::from([Held {
            at: at(2000),
            shell: None,
            step: 2,
        }]);
        let mut waiting = VecDeque::from([
            Waiting {
                at: at(1000),
                maybe_icon: false,
                step: 1,
            },
            Waiting {
                at: at(3000),
                maybe_icon: false,
                step: 3,
            },
        ]);
        drop_click(&mut held, &mut waiting, at(3000));
        assert_eq!(held.len(), 1);
        assert_eq!(waiting.iter().map(|w| w.step).collect::<Vec<_>>(), [1]);
        drop_click(&mut held, &mut waiting, at(2000));
        assert!(held.is_empty());
        // A click that took no step drops nothing.
        drop_click(&mut held, &mut waiting, at(4000));
        assert_eq!(waiting.len(), 1);
    }

    #[test]
    fn only_a_recent_last_click_is_taken_as_the_stopping_one() {
        let start = Instant::now();
        let at = |millis: u64| start + Duration::from_millis(millis);
        let stopped_at = at(10_000);
        // The click on the hub or menu, seen just before the stop.
        assert_eq!(
            stopping_click(Some(at(9_000)), Trigger::Click, stopped_at, true),
            Some(at(9_000))
        );
        assert_eq!(
            stopping_click(Some(at(8_000)), Trigger::Click, stopped_at, true),
            Some(at(8_000))
        );
        // A menu chosen from the keyboard: the last click is the user's.
        assert_eq!(
            stopping_click(Some(at(7_999)), Trigger::Click, stopped_at, true),
            None
        );
        // Stopped by keys, on a panel's menu, or with no click at all.
        assert_eq!(
            stopping_click(Some(at(9_000)), Trigger::Keys, stopped_at, true),
            None
        );
        assert_eq!(
            stopping_click(Some(at(9_000)), Trigger::Click, stopped_at, false),
            None
        );
        assert_eq!(stopping_click(None, Trigger::Click, stopped_at, true), None);
    }

    fn held_on(stopped_at: Instant, clicks: &[(u64, Option<Shell>)]) -> Vec<Held<u8>> {
        clicks
            .iter()
            .enumerate()
            .map(|(n, (secs, shell))| Held {
                at: stopped_at - Duration::from_secs(*secs),
                shell: *shell,
                step: n as u8 + 1,
            })
            .collect()
    }

    #[test]
    fn a_step_capture_stopped_from_the_keyboard_keeps_every_step() {
        let now = Instant::now();
        assert_eq!(
            kept_at_stop(held(now, &[9, 2, 1]), Trigger::Keys, now, 2),
            vec![1, 2, 3]
        );
        assert!(kept_at_stop(held(now, &[]), Trigger::Keys, now, 2).is_empty());
    }

    #[test]
    fn stopping_clicks_on_grab_it_drop_no_step() {
        // macOS: the status item, its menu and the hub are Grab-it's, so
        // none of the stopping clicks was taken and the last step is real.
        let now = Instant::now();
        assert_eq!(
            kept_at_stop(held(now, &[1]), Trigger::Click, now, 0),
            vec![1]
        );
    }

    #[test]
    fn stopping_clicks_outside_grab_it_are_dropped() {
        let now = Instant::now();
        // Linux: the tray icon and the menu item, both the tray host's.
        assert_eq!(
            kept_at_stop(held(now, &[8, 3, 1]), Trigger::Click, now, 2),
            vec![1]
        );
        // A step clicked well before the stop is the user's, kept even
        // when fewer stopping clicks were taken than expected.
        assert_eq!(
            kept_at_stop(held(now, &[60, 1]), Trigger::Click, now, 2),
            vec![1]
        );
        assert!(kept_at_stop(held(now, &[2, 1]), Trigger::Click, now, 2).is_empty());
    }

    #[test]
    fn stopping_clicks_on_the_windows_taskbar_and_overflow_are_dropped() {
        let now = Instant::now();
        let stop = |clicks: &[(u64, Option<Shell>)]| {
            kept_at_stop(held_on(now, clicks), Trigger::Click, now, 0)
        };
        // A pinned tray icon: one click on the taskbar.
        assert_eq!(stop(&[(8, None), (1, Some(Shell::Taskbar))]), vec![1]);
        // An icon in the overflow flyout: the chevron on the taskbar, then
        // the icon in the flyout.
        assert_eq!(
            stop(&[
                (8, None),
                (3, Some(Shell::Taskbar)),
                (1, Some(Shell::TrayOverflow))
            ]),
            vec![1]
        );
        // A taskbar click of the user's just before a pinned icon's is kept.
        assert_eq!(
            stop(&[(4, Some(Shell::Taskbar)), (1, Some(Shell::Taskbar))]),
            vec![1]
        );
        // The last step was in an app window: the stop came from the hub.
        assert_eq!(stop(&[(3, None), (1, None)]), vec![1, 2]);
        // A taskbar click long before the stop is the user's.
        assert_eq!(stop(&[(60, Some(Shell::Taskbar))]), vec![1]);
        // Stopped from the keyboard, a taskbar step is kept.
        assert_eq!(
            kept_at_stop(
                held_on(now, &[(1, Some(Shell::Taskbar))]),
                Trigger::Keys,
                now,
                0
            ),
            vec![1]
        );
    }

    #[test]
    fn steps_are_described_by_the_ai_or_by_their_app() {
        assert_eq!(fallback_description("Firefox"), "Click in Firefox");
        assert_eq!(fallback_description(" "), "Click in the window");
        assert_eq!(
            parse_step_description("```json\n{\"description\": \"Click  Save.\"}\n```").as_deref(),
            Some("Click Save.")
        );
        assert_eq!(
            parse_step_description("\"Open the File menu.\"\n").as_deref(),
            Some("Open the File menu.")
        );
        assert_eq!(parse_step_description("{\"description\": \"\"}"), None);
        assert_eq!(parse_step_description("  "), None);
    }

    #[test]
    fn the_ai_sees_the_marker() {
        let image = RgbaImage::from_pixel(40, 40, Rgba([0, 0, 0, 255]));
        let marked = with_marker(&image, (20.0, 20.0), 5.0);
        assert_eq!(marked.get_pixel(20, 20), &Rgba([229, 72, 77, 255]));
        assert_eq!(marked.get_pixel(2, 2), &Rgba([0, 0, 0, 255]));
        // A marker over the edge is clipped.
        let _ = with_marker(&image, (-3.0, 39.0), 5.0);
    }
}
