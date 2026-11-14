//! Starting captures from the tray, hotkeys and `--open region`, and
//! finishing them: save to `originals/`, write the sidecar, copy to the
//! clipboard and show the capture in Quick Access or the editor.
//!
//! Two more actions reuse the region overlay without saving a capture:
//! reading the text in a region, and picking a colour.

use std::time::Duration;

use chrono::Local;
use image::RgbaImage;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    capture::{self, CaptureMode, Foreground, SavedCapture},
    commands::{SettingsState, lock},
    ocr, overlay,
    overlay::Intent,
    permissions,
    quick::{self, QuickItem},
    record, screen,
    settings::AfterCapture,
    windows,
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
    /// The region dragged last time, captured again without the overlay.
    Repeat,
    /// Read the text in a dragged region and copy it; nothing is saved.
    Text,
    /// Copy the colour of the pixel the user clicks; nothing is saved.
    Colour,
    /// Record a region or window as a GIF, or stop the recording under way.
    Record,
}

impl Action {
    pub fn mode(self) -> CaptureMode {
        match self {
            Self::Region | Self::Repeat | Self::Text | Self::Colour | Self::Record => {
                CaptureMode::Region
            }
            Self::Window => CaptureMode::Window,
            Self::Screen => CaptureMode::Screen,
            Self::Monitor(_) => CaptureMode::Monitor,
        }
    }

    /// What the region overlay is asked to pick, for the actions that use it.
    fn intent(self) -> Intent {
        match self {
            Self::Text => Intent::Text,
            Self::Colour => Intent::Colour,
            Self::Record => Intent::Record,
            _ => Intent::Capture,
        }
    }
}

/// Starts `action` after `delay`, leaving time to open a menu or hover a
/// tooltip that a capture taken at once would miss.
pub fn start_after(app: &AppHandle, action: Action, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        start(&app, action);
    });
}

/// Starts a capture without blocking the caller (often the main thread).
pub fn start(app: &AppHandle, action: Action) {
    // The same action that starts a recording ends it.
    if action == Action::Record && record::stop(app) {
        return;
    }
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
            if action == Action::Repeat {
                // The portal always asks the user to pick; it cannot be
                // handed a rectangle.
                report_failure(
                    &app,
                    "Repeat last region is not available on Wayland; capture a region instead.",
                );
                return;
            }
            if action == Action::Record {
                report_failure(
                    &app,
                    "Recording is not available on Wayland yet: only the desktop may read the screen there.",
                );
                return;
            }
            if action == Action::Colour {
                match crate::portal::pick_colour().await {
                    Ok(Some(rgb)) => finish_colour(&app, rgb),
                    // The user cancelled the picker.
                    Ok(None) => {}
                    Err(err) => report_failure(&app, &err),
                }
                return;
            }
            match crate::portal::screenshot(mode).await {
                Ok(Some(image)) if action == Action::Text => {
                    // OCR is slow: keep it off the async runtime's threads.
                    std::thread::spawn(move || finish_text(&app, &image));
                }
                // The desktop portal does not say which monitor it captured.
                Ok(Some(image)) => finish(&app, &image, mode, &Foreground::default(), None),
                // The user cancelled the desktop's picker.
                Ok(None) => {}
                Err(err) => report_failure(&app, &err),
            }
        });
        return;
    }

    // Claimed before the thread starts, so a second press while the
    // monitors are still freezing does not open a second overlay.
    let uses_overlay = matches!(
        action,
        Action::Region | Action::Window | Action::Text | Action::Colour | Action::Record
    );
    if uses_overlay && !overlay::begin(app) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let result = match action {
            Action::Region | Action::Window | Action::Text | Action::Colour | Action::Record => {
                overlay::open(&app, action.mode(), action.intent())
            }
            Action::Repeat => {
                let foreground = screen::foreground();
                overlay::capture_last_region(&app).map(|(image, scale)| {
                    finish(&app, &image, CaptureMode::Region, &foreground, Some(scale))
                })
            }
            Action::Screen => {
                let foreground = screen::foreground();
                let scale = monitor_scale(None);
                screen::capture_all()
                    .map(|image| finish(&app, &image, CaptureMode::Screen, &foreground, scale))
            }
            Action::Monitor(index) => {
                let foreground = screen::foreground();
                let scale = monitor_scale(Some(index));
                screen::capture_monitor(index)
                    .map(|image| finish(&app, &image, CaptureMode::Monitor, &foreground, scale))
            }
        };
        if let Err(err) = result {
            report_failure(&app, &err);
        }
    });
}

/// The pixels per point of monitor `index`, or for `None` of the densest
/// monitor (which a stitched capture of every screen is drawn at).
fn monitor_scale(index: Option<usize>) -> Option<f64> {
    let monitors = screen::monitors().ok()?;
    match index {
        Some(index) => monitors.get(index).map(|monitor| monitor.scale_factor),
        None => monitors
            .iter()
            .map(|monitor| monitor.scale_factor)
            .reduce(f64::max),
    }
}

/// Saves a finished capture, copies it to the clipboard and shows it as
/// the user chose in Settings. `scale_factor` is the source monitor's
/// pixels per point, when known. Runs off the main thread, so creating a
/// window is safe.
pub fn finish(
    app: &AppHandle,
    image: &RgbaImage,
    mode: CaptureMode,
    foreground: &Foreground,
    scale_factor: Option<f64>,
) {
    let preferences = lock(&app.state::<SettingsState>())
        .get()
        .preferences
        .clone();
    match save(
        app,
        image,
        mode,
        foreground,
        scale_factor,
        preferences.copy_to_clipboard,
    ) {
        Ok((saved, copied)) => {
            let _ = app.emit(CAPTURE_SAVED_EVENT, &saved);
            let item = QuickItem::capture(&saved.path, image.dimensions(), copied);
            match preferences.after_capture {
                AfterCapture::QuickAccess => quick::show(app, item),
                AfterCapture::Editor => {
                    quick::remember(app, item);
                    if let Err(err) = windows::show_editor(app, &saved.path) {
                        eprintln!("Grab-it: saved, but could not open the editor: {err}");
                    }
                }
                AfterCapture::Nothing => quick::remember(app, item),
            }
        }
        Err(err) => report_failure(app, &err),
    }
}

/// Saves the capture and, when asked, copies it. The second value says
/// whether the capture reached the clipboard.
fn save(
    app: &AppHandle,
    image: &RgbaImage,
    mode: CaptureMode,
    foreground: &Foreground,
    scale_factor: Option<f64>,
    copy: bool,
) -> Result<(SavedCapture, bool), String> {
    let folder = lock(&app.state::<SettingsState>())
        .get()
        .save_folder
        .clone();
    let saved = capture::save_capture(&folder, image, mode, foreground, scale_factor, Local::now())
        .map_err(|err| err.to_string())?;
    crate::library::record_capture(app, &saved.path);
    if !copy {
        return Ok((saved, false));
    }
    let clip = tauri::image::Image::new(image.as_raw(), image.width(), image.height());
    let copied = match app.clipboard().write_image(&clip) {
        Ok(()) => true,
        Err(err) => {
            // The file is saved; a clipboard failure is not worth losing it over.
            eprintln!("Grab-it: saved, but could not copy to the clipboard: {err}");
            false
        }
    };
    Ok((saved, copied))
}

/// Reads the text in `image` and copies it. Nothing is saved. Slow the
/// first time (the OCR models are downloaded and loaded), so Quick Access
/// says what is happening meanwhile.
pub fn finish_text(app: &AppHandle, image: &RgbaImage) {
    quick::show(
        app,
        QuickItem::Working {
            message: "Reading text…".into(),
        },
    );
    let text = match ocr::read_now(app, image) {
        Ok(text) => text,
        Err(err) => return report_failure(app, &format!("could not read the text: {err}")),
    };
    if text.trim().is_empty() {
        quick::show(
            app,
            QuickItem::Notice {
                title: "No text found".into(),
                message: "Try a larger region, or zoom in on small text first.".into(),
            },
        );
        return;
    }
    match app.clipboard().write_text(text.clone()) {
        Ok(()) => quick::show(app, QuickItem::Text { text }),
        Err(err) => report_failure(app, &format!("could not copy the text: {err}")),
    }
}

/// Copies a picked colour as `#RRGGBB`.
pub fn finish_colour(app: &AppHandle, rgb: [u8; 3]) {
    match app.clipboard().write_text(quick::hex_colour(rgb)) {
        Ok(()) => quick::show(app, QuickItem::colour(rgb)),
        Err(err) => report_failure(app, &format!("could not copy the colour: {err}")),
    }
}

/// Reports a failed capture. Grab-it usually has no window open, so the
/// message is shown on the Quick Access card as well as sent to any window
/// listening. May be called on any thread.
pub fn report_failure(app: &AppHandle, message: &str) {
    eprintln!("Grab-it: capture failed: {message}");
    let _ = app.emit(CAPTURE_FAILED_EVENT, message);
    let app = app.clone();
    let message = message.to_owned();
    // The card may need a window, which must not be made on the main thread
    // from inside an event handler.
    std::thread::spawn(move || quick::show(&app, QuickItem::Error { message }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_know_their_capture_mode() {
        assert_eq!(Action::Region.mode(), CaptureMode::Region);
        assert_eq!(Action::Window.mode(), CaptureMode::Window);
        assert_eq!(Action::Screen.mode(), CaptureMode::Screen);
        assert_eq!(Action::Monitor(1).mode(), CaptureMode::Monitor);
        assert_eq!(Action::Repeat.mode(), CaptureMode::Region);
    }

    #[test]
    fn text_and_colour_use_the_region_overlay_with_their_own_intent() {
        assert_eq!(Action::Text.mode(), CaptureMode::Region);
        assert_eq!(Action::Colour.mode(), CaptureMode::Region);
        assert_eq!(Action::Text.intent(), Intent::Text);
        assert_eq!(Action::Colour.intent(), Intent::Colour);
        assert_eq!(Action::Record.mode(), CaptureMode::Region);
        assert_eq!(Action::Record.intent(), Intent::Record);
        assert_eq!(Action::Region.intent(), Intent::Capture);
        assert_eq!(Action::Window.intent(), Intent::Capture);
    }
}
