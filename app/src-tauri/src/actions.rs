//! Starting captures from the tray, hotkeys and `--open region`, and
//! finishing them: save to `originals/`, write the sidecar, copy to the
//! clipboard and open the capture in the editor.

use chrono::Local;
use image::RgbaImage;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    capture::{self, CaptureMode, Foreground, SavedCapture},
    commands::{SettingsState, lock},
    overlay, permissions, screen, windows,
};

/// Emitted to every window after a capture is saved, with [`SavedCapture`].
pub const CAPTURE_SAVED_EVENT: &str = "capture-saved";
/// Emitted when a capture fails, with the message.
pub const CAPTURE_FAILED_EVENT: &str = "capture-failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Region,
    Window,
    /// Every monitor.
    Screen,
    /// One monitor, by index in `screen::monitors()`.
    Monitor(usize),
}

impl Action {
    pub fn from_mode(mode: CaptureMode) -> Self {
        match mode {
            CaptureMode::Region => Self::Region,
            CaptureMode::Window => Self::Window,
            CaptureMode::Screen | CaptureMode::Monitor => Self::Screen,
        }
    }

    pub fn mode(self) -> CaptureMode {
        match self {
            Self::Region => CaptureMode::Region,
            Self::Window => CaptureMode::Window,
            Self::Screen => CaptureMode::Screen,
            Self::Monitor(_) => CaptureMode::Monitor,
        }
    }
}

/// Starts a capture without blocking the caller (often the main thread).
pub fn start(app: &AppHandle, action: Action) {
    if !permissions::ensure_screen_capture(app) {
        return;
    }
    if overlay::is_open(app) {
        // A region or window selection is already on screen.
        return;
    }

    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mode = action.mode();
            match crate::portal::screenshot(mode).await {
                Ok(image) => finish(&app, &image, mode, &Foreground::default()),
                Err(err) => report_failure(&app, &err),
            }
        });
        return;
    }

    // Claimed before the thread starts, so a second press while the
    // monitors are still freezing does not open a second overlay.
    let uses_overlay = matches!(action, Action::Region | Action::Window);
    if uses_overlay && !overlay::begin(app) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let result = match action {
            Action::Region | Action::Window => overlay::open(&app, action.mode()),
            Action::Screen => {
                let foreground = screen::foreground();
                screen::capture_all()
                    .map(|image| finish(&app, &image, CaptureMode::Screen, &foreground))
            }
            Action::Monitor(index) => {
                let foreground = screen::foreground();
                screen::capture_monitor(index)
                    .map(|image| finish(&app, &image, CaptureMode::Monitor, &foreground))
            }
        };
        if let Err(err) = result {
            report_failure(&app, &err);
        }
    });
}

/// Saves a finished capture, copies it to the clipboard and opens it in
/// the editor. Runs off the main thread, so creating the window is safe.
pub fn finish(app: &AppHandle, image: &RgbaImage, mode: CaptureMode, foreground: &Foreground) {
    match save(app, image, mode, foreground) {
        Ok(saved) => {
            let _ = app.emit(CAPTURE_SAVED_EVENT, &saved);
            if let Err(err) = windows::show_editor(app, &saved.path) {
                eprintln!("Grab-it: saved, but could not open the editor: {err}");
            }
        }
        Err(err) => report_failure(app, &err),
    }
}

fn save(
    app: &AppHandle,
    image: &RgbaImage,
    mode: CaptureMode,
    foreground: &Foreground,
) -> Result<SavedCapture, String> {
    let folder = lock(&app.state::<SettingsState>())
        .get()
        .save_folder
        .clone();
    let saved = capture::save_capture(&folder, image, mode, foreground, Local::now())
        .map_err(|err| err.to_string())?;
    crate::library::record_capture(app, &saved.path);
    let clip = tauri::image::Image::new(image.as_raw(), image.width(), image.height());
    if let Err(err) = app.clipboard().write_image(&clip) {
        // The file is saved; a clipboard failure is not worth losing it over.
        eprintln!("Grab-it: saved, but could not copy to the clipboard: {err}");
    }
    Ok(saved)
}

pub fn report_failure(app: &AppHandle, message: &str) {
    eprintln!("Grab-it: capture failed: {message}");
    let _ = app.emit(CAPTURE_FAILED_EVENT, message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkey_modes_map_to_actions() {
        for action in [Action::Region, Action::Window, Action::Screen] {
            assert_eq!(Action::from_mode(action.mode()), action);
        }
        assert_eq!(Action::Monitor(1).mode(), CaptureMode::Monitor);
    }
}
