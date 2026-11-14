//! Pinned captures: an image floating above every other window, for
//! keeping a reference in view while working in another app.
//!
//! Each pin is a borderless always-on-top window showing one image. Drag it
//! anywhere, scroll to resize, Esc or double-click to close. A pin can be
//! locked, making it click-through until it is unlocked from the tray menu,
//! and nudged with the arrow keys.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU32, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, ipc::InvokeBody,
};

use crate::{quick, tray, windows};

/// Pin windows are labelled `pin-<n>`.
pub const LABEL_PREFIX: &str = "pin-";
/// Where images pinned from the editor are kept, in the app cache directory.
const PINS_DIR: &str = "pins";

/// A pin never opens larger than this share of its monitor.
const MAX_SCREEN_SHARE: f64 = 0.6;
/// The smallest a pin can be zoomed, in logical pixels on its longer side.
const MIN_SIDE: f64 = 64.0;
/// The largest a pin can be zoomed, relative to the image's own pixels.
const MAX_ZOOM: f64 = 4.0;

struct Pin {
    path: PathBuf,
    /// A flattened copy made for this pin, deleted when the pin closes.
    temporary: bool,
    size: (u32, u32),
    /// Click-through: mouse input goes to the window underneath.
    locked: bool,
}

#[derive(Default)]
pub struct PinState(Mutex<HashMap<String, Pin>>);

impl PinState {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Pin>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Marks the pin `label` locked or unlocked. False if there is no such pin.
    fn set_locked(&self, label: &str, locked: bool) -> bool {
        match self.lock().get_mut(label) {
            Some(pin) => {
                pin.locked = locked;
                true
            }
            None => false,
        }
    }

    /// The labels of the pins that are locked now.
    fn locked_labels(&self) -> Vec<String> {
        let mut labels: Vec<String> = self
            .lock()
            .iter()
            .filter(|(_, pin)| pin.locked)
            .map(|(label, _)| label.clone())
            .collect();
        labels.sort();
        labels
    }

    fn any_locked(&self) -> bool {
        self.lock().values().any(|pin| pin.locked)
    }
}

/// Where a pin at `current` lands after moving by `delta`, in logical
/// pixels, rounded to whole pixels so repeated nudges do not drift.
pub fn nudged_position(current: (f64, f64), delta: (f64, f64)) -> (f64, f64) {
    ((current.0 + delta.0).round(), (current.1 + delta.1).round())
}

/// The size a pin opens at, in logical pixels: the image at the monitor's
/// scale (so one image pixel is one physical pixel), shrunk to fit
/// [`MAX_SCREEN_SHARE`] of the monitor, keeping its ratio.
pub fn initial_size(image: (u32, u32), monitor: (f64, f64), scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = f64::from(image.0.max(1)) / scale;
    let height = f64::from(image.1.max(1)) / scale;
    let fit = (monitor.0 * MAX_SCREEN_SHARE / width)
        .min(monitor.1 * MAX_SCREEN_SHARE / height)
        .min(1.0);
    let fit = if fit.is_finite() && fit > 0.0 {
        fit
    } else {
        1.0
    };
    (
        (width * fit).round().max(1.0),
        (height * fit).round().max(1.0),
    )
}

/// A pin's size after zooming by `factor`, keeping the image's ratio and
/// staying between [`MIN_SIDE`] and [`MAX_ZOOM`] times the image.
pub fn zoomed_size(current_width: f64, image: (u32, u32), factor: f64) -> (f64, f64) {
    let image_width = f64::from(image.0.max(1));
    let image_height = f64::from(image.1.max(1));
    let ratio = image_height / image_width;
    // The limit applies to the longer side, so a wide strip keeps a
    // grabbable height and a tall one a grabbable width.
    let min_width = if ratio >= 1.0 {
        MIN_SIDE / ratio
    } else {
        MIN_SIDE
    }
    .min(image_width * MAX_ZOOM);
    let width = (current_width * factor).clamp(min_width, image_width * MAX_ZOOM);
    (width.round(), (width * ratio).round().max(1.0))
}

/// Floats the image at `path` above other windows. `temporary` images are
/// deleted when their pin closes. Call this off the main thread.
pub fn open(app: &AppHandle, path: &Path, temporary: bool) -> Result<(), String> {
    static NEXT_PIN: AtomicU32 = AtomicU32::new(1);

    let size = image::image_dimensions(path)
        .map_err(|err| format!("could not open {}: {err}", path.display()))?;
    let monitor = app.primary_monitor().ok().flatten();
    let (monitor_size, scale) = match &monitor {
        Some(monitor) => {
            let scale = monitor.scale_factor();
            let size = monitor.size();
            (
                (
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                ),
                scale,
            )
        }
        None => ((1280.0, 720.0), 1.0),
    };
    let (width, height) = initial_size(size, monitor_size, scale);

    let label = format!("{LABEL_PREFIX}{}", NEXT_PIN.fetch_add(1, Ordering::Relaxed));
    let state = app.state::<PinState>();
    state.lock().insert(
        label.clone(),
        Pin {
            path: path.to_path_buf(),
            temporary,
            size,
            locked: false,
        },
    );
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/pin".into()))
        .title("Grab-it pin")
        .inner_size(width, height)
        .decorations(false)
        // See-through, so a faded pin shows the windows behind it.
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .center()
        .build();
    let window = match built {
        Ok(window) => window,
        Err(err) => {
            forget(app, &label);
            return Err(format!("could not pin the capture: {err}"));
        }
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            forget(&handle, &label);
        }
    });
    Ok(())
}

/// Drops a closed pin, deleting its image when it was a temporary copy.
fn forget(app: &AppHandle, label: &str) {
    let pin = app.state::<PinState>().lock().remove(label);
    let was_locked = pin.as_ref().is_some_and(|pin| pin.locked);
    if let Some(pin) = pin.filter(|pin| pin.temporary) {
        let _ = fs::remove_file(pin.path);
    }
    if was_locked {
        sync_tray(app);
    }
}

/// Enables the tray's Unlock item while any pin is locked.
fn sync_tray(app: &AppHandle) {
    let any_locked = app.state::<PinState>().any_locked();
    tray::set_unlock_enabled(app, any_locked);
}

/// Makes every locked pin take mouse input again. Called from the tray menu.
pub fn unlock_all(app: &AppHandle) {
    let state = app.state::<PinState>();
    // The labels are collected first: the state lock is never held across
    // window calls.
    for label in state.locked_labels() {
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        match window.set_ignore_cursor_events(false) {
            Ok(()) => {
                state.set_locked(&label, false);
            }
            Err(err) => eprintln!("Grab-it: could not unlock a pin: {err}"),
        }
    }
    sync_tray(app);
}

/// Mirrors `PinInfo` in src/pin/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInfo {
    pub width: u32,
    pub height: u32,
    /// False for images pinned from the editor, which have no capture of
    /// their own to open.
    pub editable: bool,
}

fn with_pin<T>(
    window: &WebviewWindow,
    state: &PinState,
    read: impl FnOnce(&Pin) -> T,
) -> Result<T, String> {
    state
        .lock()
        .get(window.label())
        .map(read)
        .ok_or_else(|| "this window is not a pin".to_owned())
}

#[tauri::command]
pub fn pin_info(window: WebviewWindow, state: State<'_, PinState>) -> Result<PinInfo, String> {
    with_pin(&window, &state, |pin| PinInfo {
        width: pin.size.0,
        height: pin.size.1,
        editable: !pin.temporary,
    })
}

/// The pinned image's bytes.
#[tauri::command(async)]
pub fn pin_image(
    window: WebviewWindow,
    state: State<'_, PinState>,
) -> Result<tauri::ipc::Response, String> {
    let path = with_pin(&window, &state, |pin| pin.path.clone())?;
    let bytes =
        fs::read(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Resizes the pin by `factor` (above 1 grows it), keeping its ratio.
#[tauri::command]
pub fn pin_zoom(
    factor: f64,
    window: WebviewWindow,
    state: State<'_, PinState>,
) -> Result<(), String> {
    if !(factor.is_finite() && factor > 0.0) {
        return Err("bad zoom factor".to_owned());
    }
    let image = with_pin(&window, &state, |pin| pin.size)?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let current = window
        .inner_size()
        .map_err(|err| err.to_string())?
        .to_logical::<f64>(scale);
    let (width, height) = zoomed_size(current.width, image, factor);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| err.to_string())
}

/// Locks the pin: clicks pass through it to the window underneath while it
/// stays on top, until Unlock pinned captures in the tray menu.
#[tauri::command]
pub fn pin_lock(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, PinState>,
) -> Result<(), String> {
    with_pin(&window, &state, |_| ())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|err| format!("could not lock the pin: {err}"))?;
    state.set_locked(window.label(), true);
    sync_tray(&app);
    Ok(())
}

/// Moves the pin by `dx`, `dy` logical pixels.
#[tauri::command]
pub fn pin_nudge(
    dx: f64,
    dy: f64,
    window: WebviewWindow,
    state: State<'_, PinState>,
) -> Result<(), String> {
    if !(dx.is_finite() && dy.is_finite()) {
        return Err("bad nudge".to_owned());
    }
    with_pin(&window, &state, |_| ())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let current = window
        .outer_position()
        .map_err(|err| err.to_string())?
        .to_logical::<f64>(scale);
    let (x, y) = nudged_position((current.x, current.y), (dx, dy));
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pin_copy(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, PinState>,
) -> Result<(), String> {
    let path = with_pin(&window, &state, |pin| pin.path.clone())?;
    quick::copy_file(&app, &path)
}

/// Opens the pinned capture in the editor. Async, so the editor window is
/// not created on the main thread inside a command.
#[tauri::command]
pub async fn pin_edit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let state = app.state::<PinState>();
    let (path, temporary) = with_pin(&window, &state, |pin| (pin.path.clone(), pin.temporary))?;
    if temporary {
        return Err("this pin was made in the editor and has no capture to open".to_owned());
    }
    windows::show_editor(&app, &path).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pin_close(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|err| err.to_string())
}

/// Pins the flattened PNG in the request body: the editor's annotated image.
#[tauri::command]
pub async fn editor_pin(request: tauri::ipc::Request<'_>, app: AppHandle) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected image bytes".to_owned());
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join(PINS_DIR);
    fs::create_dir_all(&dir).map_err(|err| format!("could not pin the image: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let path = dir.join(format!("pin-{stamp}.png"));
    fs::write(&path, bytes).map_err(|err| format!("could not pin the image: {err}"))?;
    open(&app, &path, true).inspect_err(|_| {
        let _ = fs::remove_file(&path);
    })
}

/// Removes pin images left behind by a crash or a forced quit.
pub fn clear_stale(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = fs::remove_dir_all(cache.join(PINS_DIR));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_open_at_one_image_pixel_per_screen_pixel() {
        assert_eq!(
            initial_size((400, 300), (1920.0, 1080.0), 1.0),
            (400.0, 300.0)
        );
        // On a 2x monitor the same image takes half the logical size.
        assert_eq!(
            initial_size((400, 300), (1440.0, 900.0), 2.0),
            (200.0, 150.0)
        );
    }

    #[test]
    fn large_pins_shrink_to_fit_the_monitor() {
        // A full-screen capture opens at 60% of the screen, same ratio.
        assert_eq!(
            initial_size((1920, 1080), (1920.0, 1080.0), 1.0),
            (1152.0, 648.0)
        );
        // A tall capture is limited by the height.
        let (width, height) = initial_size((500, 4000), (1920.0, 1000.0), 1.0);
        assert_eq!(height, 600.0);
        assert_eq!(width, 75.0);
    }

    #[test]
    fn zooming_keeps_the_ratio_and_stays_in_bounds() {
        assert_eq!(zoomed_size(400.0, (400, 200), 1.5), (600.0, 300.0));
        // Never beyond four times the image.
        assert_eq!(zoomed_size(1500.0, (400, 200), 2.0), (1600.0, 800.0));
        // Never smaller than a grabbable size.
        assert_eq!(zoomed_size(100.0, (400, 200), 0.1), (64.0, 32.0));
        assert_eq!(zoomed_size(100.0, (200, 400), 0.1), (32.0, 64.0));
    }

    fn pin() -> Pin {
        Pin {
            path: PathBuf::from("pin.png"),
            temporary: false,
            size: (400, 300),
            locked: false,
        }
    }

    #[test]
    fn locking_tracks_which_pins_are_locked() {
        let state = PinState::default();
        state.lock().insert("pin-1".into(), pin());
        state.lock().insert("pin-2".into(), pin());
        assert!(!state.any_locked());
        assert!(state.locked_labels().is_empty());

        assert!(state.set_locked("pin-2", true));
        assert!(state.set_locked("pin-1", true));
        assert!(state.any_locked());
        assert_eq!(state.locked_labels(), ["pin-1", "pin-2"]);

        assert!(state.set_locked("pin-1", false));
        assert_eq!(state.locked_labels(), ["pin-2"]);

        // A closed pin is no longer counted.
        state.lock().remove("pin-2");
        assert!(!state.any_locked());
        assert!(!state.set_locked("pin-2", true));
        assert!(!state.any_locked());
    }

    #[test]
    fn nudges_move_by_whole_logical_pixels() {
        assert_eq!(nudged_position((100.0, 50.0), (1.0, 0.0)), (101.0, 50.0));
        assert_eq!(nudged_position((100.0, 50.0), (0.0, -10.0)), (100.0, 40.0));
        assert_eq!(nudged_position((100.0, 50.0), (-10.0, 0.0)), (90.0, 50.0));
        // A position off the pixel grid (a scaled monitor) snaps to it.
        assert_eq!(nudged_position((100.4, 49.6), (1.0, 1.0)), (101.0, 51.0));
        // Off the left or top edge of the primary monitor is allowed: other
        // monitors can sit there.
        assert_eq!(nudged_position((0.0, 0.0), (-1.0, -1.0)), (-1.0, -1.0));
    }
}
