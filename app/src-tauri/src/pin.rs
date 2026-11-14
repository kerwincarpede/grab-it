//! Pinned captures: an image floating above every other window, for
//! keeping a reference in view while working in another app.
//!
//! Each pin is a borderless always-on-top window showing one image. Drag it
//! anywhere, scroll to resize, Esc or double-click to close.

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
    AppHandle, LogicalSize, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, ipc::InvokeBody,
};

use crate::{quick, windows};

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
}

#[derive(Default)]
pub struct PinState(Mutex<HashMap<String, Pin>>);

impl PinState {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Pin>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
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
        },
    );
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/pin".into()))
        .title("Grab-it pin")
        .inner_size(width, height)
        .decorations(false)
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
    if let Some(pin) = pin.filter(|pin| pin.temporary) {
        let _ = fs::remove_file(pin.path);
    }
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
}
