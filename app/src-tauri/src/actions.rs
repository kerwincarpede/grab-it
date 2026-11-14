//! Starting captures from the tray, hotkeys and `--open region`, and
//! finishing them: save to `originals/`, write the sidecar, copy to the
//! clipboard and show the capture in Quick Access or the editor.
//!
//! Two more actions reuse the region overlay without saving a capture:
//! reading the text in a region, and picking a colour. Reading text reads
//! any QR code or barcode in the region first (see `codes.rs`); text with
//! no code in it can be tidied up by AI afterwards (see `tidy.rs`).

use std::time::Duration;

use chrono::Local;
use image::RgbaImage;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    ai::{self, AiError},
    capture::{self, CaptureMode, Foreground, SavedCapture},
    codes::{self, Code},
    commands::{SettingsState, lock},
    ocr, overlay,
    overlay::Intent,
    permissions,
    quick::{self, QuickItem, TextTidy},
    record, screen,
    settings::AfterCapture,
    tidy::{self, Tidied},
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
    /// Record a region or window as an MP4 or a GIF, or stop the recording under way.
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
                AfterCapture::QuickAccess => {
                    quick::show(app, item);
                }
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
///
/// With tidying on, the text OCR read is copied straight away and the AI
/// then reads the image again: its text takes the place of OCR's on the
/// card, and on the clipboard unless something else was copied meanwhile.
/// When OCR found nothing, the AI's text is the only one.
///
/// A QR code or barcode in `image` comes first: its value is copied in
/// place of the text, which the card offers instead, and nothing is tidied.
pub fn finish_text(app: &AppHandle, image: &RgbaImage) {
    let working = quick::show(
        app,
        QuickItem::Working {
            message: "Reading text…".into(),
        },
    );
    let found = codes::decode(image);
    if !found.is_empty() {
        let text = ocr::read_now(app, image).unwrap_or_else(|err| {
            // The codes are what matter; the text around them is a bonus.
            eprintln!("Grab-it: read a code, but OCR could not read the text: {err}");
            String::new()
        });
        let outcome = code_outcome(found, &text);
        match app.clipboard().write_text(outcome.copy) {
            Ok(()) => {
                quick::show(app, outcome.item);
            }
            Err(err) => report_failure(app, &format!("could not copy the code: {err}")),
        }
        return;
    }
    let ai = ai::current_settings(app);
    let tidies = ai.tidies_text();
    let read = match ocr::read_now(app, image) {
        Ok(text) => text,
        // The AI may still read it.
        Err(err) if tidies => {
            eprintln!("Grab-it: OCR could not read the text, asking AI: {err}");
            String::new()
        }
        Err(err) => return report_failure(app, &format!("could not read the text: {err}")),
    };
    if !tidies {
        if read.trim().is_empty() {
            quick::show(app, no_text_found());
            return;
        }
        match app.clipboard().write_text(read.clone()) {
            Ok(()) => {
                quick::show(app, QuickItem::text(read));
            }
            Err(err) => report_failure(app, &format!("could not copy the text: {err}")),
        }
        return;
    }

    let by = tidy::tidier_name(&ai);
    let shown = if read.trim().is_empty() {
        // Nothing to copy yet. Closing this card cancels.
        quick::replace(
            app,
            working,
            QuickItem::Working {
                message: format!("Reading text with {by}…"),
            },
        )
    } else {
        if let Err(err) = app.clipboard().write_text(read.clone()) {
            return report_failure(app, &format!("could not copy the text: {err}"));
        }
        Some(quick::show(
            app,
            QuickItem::Text {
                text: read.clone(),
                original: None,
                tidy: Some(TextTidy::Working { by: by.clone() }),
            },
        ))
    };
    let Some(generation) = shown else {
        return;
    };
    let clients = ai::Clients::new(tidy::TIDY_TIMEOUT);
    let tidied = tidy::tidy(&clients, &ai, image, &read);
    let clipboard = app.clipboard().read_text().ok();
    let outcome = tidied_outcome(&read, clipboard.as_deref(), &by, tidied);
    // The user may have closed the card, or captured again, meanwhile.
    if quick::replace(app, generation, outcome.item).is_none() {
        return;
    }
    if let Some(text) = outcome.copy
        && let Err(err) = app.clipboard().write_text(text)
    {
        eprintln!("Grab-it: could not copy the tidied text: {err}");
    }
}

fn no_text_found() -> QuickItem {
    QuickItem::Notice {
        title: "No text found".into(),
        message: "Try a larger region, or zoom in on small text first.".into(),
    }
}

/// What Capture text ends with when it found codes: the card's item, and
/// the text to put on the clipboard.
#[derive(Debug, PartialEq, Eq)]
struct CodeOutcome {
    item: QuickItem,
    copy: String,
}

/// What the card shows, and what is copied, when Capture text found
/// `codes` in an area where OCR read `text`: every code's value, one per
/// line, with the text kept for the card's Copy text. Text that is only
/// whitespace counts as none.
fn code_outcome(codes: Vec<Code>, text: &str) -> CodeOutcome {
    let text = if text.trim().is_empty() {
        String::new()
    } else {
        text.to_owned()
    };
    CodeOutcome {
        copy: codes::values(&codes),
        item: QuickItem::Code { codes, text },
    }
}

/// What tidying a text capture ends with: the card's item, and the text to
/// put on the clipboard.
#[derive(Debug, PartialEq, Eq)]
struct TidyOutcome {
    item: QuickItem,
    copy: Option<String>,
}

/// What the card shows once the AI answered about the text OCR `read`, and
/// what is copied. `clipboard` is the clipboard's text now: the AI's text
/// only replaces OCR's there when the user has not copied something else
/// since.
fn tidied_outcome(
    read: &str,
    clipboard: Option<&str>,
    by: &str,
    tidied: Result<Tidied, AiError>,
) -> TidyOutcome {
    let read_nothing = read.trim().is_empty();
    let kept = |message: String| TidyOutcome {
        item: QuickItem::Text {
            text: read.to_owned(),
            original: None,
            tidy: Some(TextTidy::Failed {
                by: by.to_owned(),
                message,
            }),
        },
        copy: None,
    };
    match tidied {
        Err(err) if read_nothing => TidyOutcome {
            item: QuickItem::Notice {
                title: "Could not read the text".into(),
                message: err.to_string(),
            },
            copy: None,
        },
        Err(err) => kept(err.to_string()),
        Ok(tidied) if tidied.text.trim().is_empty() => {
            if read_nothing {
                TidyOutcome {
                    item: no_text_found(),
                    copy: None,
                }
            } else {
                kept("it found no text in the image".into())
            }
        }
        Ok(tidied) => {
            let changed = tidied.text != read.trim();
            let ours = read_nothing || clipboard == Some(read);
            let copy = (changed && ours).then(|| tidied.text.clone());
            TidyOutcome {
                item: QuickItem::Text {
                    original: (changed && !read_nothing).then(|| read.to_owned()),
                    tidy: Some(TextTidy::Done {
                        by: by.to_owned(),
                        format: tidied.format,
                        language: tidied.language,
                        changed,
                        copied: ours,
                    }),
                    text: tidied.text,
                },
                copy,
            }
        }
    }
}

/// Copies a picked colour as `#RRGGBB`.
pub fn finish_colour(app: &AppHandle, rgb: [u8; 3]) {
    match app.clipboard().write_text(quick::hex_colour(rgb)) {
        Ok(()) => {
            quick::show(app, QuickItem::colour(rgb));
        }
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

    fn tidied(text: &str, format: &str) -> Result<Tidied, AiError> {
        Ok(Tidied {
            text: text.into(),
            format: format.into(),
            language: None,
        })
    }

    #[test]
    fn tidied_text_replaces_what_ocr_copied() {
        let outcome = tidied_outcome(
            "{a: 1}",
            Some("{a: 1}"),
            "Claude Code",
            tidied("{\n  \"a\": 1\n}", "json"),
        );
        assert_eq!(outcome.copy.as_deref(), Some("{\n  \"a\": 1\n}"));
        assert_eq!(
            outcome.item,
            QuickItem::Text {
                text: "{\n  \"a\": 1\n}".into(),
                original: Some("{a: 1}".into()),
                tidy: Some(TextTidy::Done {
                    by: "Claude Code".into(),
                    format: "json".into(),
                    language: None,
                    changed: true,
                    copied: true,
                }),
            }
        );
    }

    #[test]
    fn something_copied_meanwhile_stays_on_the_clipboard() {
        let outcome = tidied_outcome("helo", Some("other"), "Codex", tidied("hello", "plain"));
        assert_eq!(outcome.copy, None);
        let QuickItem::Text {
            text,
            original,
            tidy: Some(TextTidy::Done { copied, .. }),
        } = outcome.item
        else {
            panic!("{:?}", outcome.item);
        };
        assert_eq!(text, "hello");
        assert_eq!(original.as_deref(), Some("helo"));
        assert!(!copied);
    }

    #[test]
    fn unchanged_text_copies_nothing_again() {
        let outcome = tidied_outcome("same\n", Some("same\n"), "Codex", tidied("same", "plain"));
        assert_eq!(outcome.copy, None);
        assert!(matches!(
            outcome.item,
            QuickItem::Text {
                original: None,
                tidy: Some(TextTidy::Done {
                    changed: false,
                    copied: true,
                    ..
                }),
                ..
            }
        ));
    }

    #[test]
    fn when_ocr_read_nothing_the_ai_text_is_copied() {
        let outcome = tidied_outcome("", Some("older"), "Claude Code", tidied("found", "plain"));
        assert_eq!(outcome.copy.as_deref(), Some("found"));
        assert!(matches!(
            outcome.item,
            QuickItem::Text { original: None, .. }
        ));
        let nothing = tidied_outcome(" ", None, "Claude Code", tidied("", "plain"));
        assert_eq!(nothing.item, no_text_found());
        assert_eq!(nothing.copy, None);
    }

    #[test]
    fn a_failure_keeps_what_ocr_read() {
        let failed = Err(AiError::Endpoint(
            "Claude Code failed: not signed in".into(),
        ));
        let outcome = tidied_outcome("text", Some("text"), "Claude Code", failed.clone());
        assert_eq!(outcome.copy, None);
        assert_eq!(
            outcome.item,
            QuickItem::Text {
                text: "text".into(),
                original: None,
                tidy: Some(TextTidy::Failed {
                    by: "Claude Code".into(),
                    message: "Claude Code failed: not signed in".into(),
                }),
            }
        );
        let nothing = tidied_outcome("", None, "Claude Code", failed);
        assert!(matches!(
            nothing.item,
            QuickItem::Notice { title, .. } if title == "Could not read the text"
        ));
        let empty = tidied_outcome("text", Some("text"), "Codex", tidied(" ", "plain"));
        assert!(matches!(
            empty.item,
            QuickItem::Text {
                tidy: Some(TextTidy::Failed { .. }),
                ..
            }
        ));
    }

    #[test]
    fn one_code_copies_its_value() {
        let outcome = code_outcome(vec![Code::new("QR code", "https://example.com")], "");
        assert_eq!(outcome.copy, "https://example.com");
        assert_eq!(
            outcome.item,
            QuickItem::Code {
                codes: vec![Code {
                    format: "QR code".into(),
                    value: "https://example.com".into(),
                    is_link: true,
                }],
                text: String::new(),
            }
        );
    }

    #[test]
    fn several_codes_copy_one_value_per_line() {
        let codes = vec![
            Code::new("QR code", "first"),
            Code::new("Code 128", "second"),
            Code::new("EAN-13", "4006381333931"),
        ];
        let outcome = code_outcome(codes.clone(), "  \n");
        assert_eq!(outcome.copy, "first\nsecond\n4006381333931");
        assert_eq!(
            outcome.item,
            QuickItem::Code {
                codes,
                text: String::new(),
            }
        );
    }

    #[test]
    fn text_around_a_code_is_kept_for_the_card_but_not_copied() {
        let outcome = code_outcome(
            vec![Code::new("QR code", "https://example.com/menu")],
            "Scan for the menu\n",
        );
        assert_eq!(outcome.copy, "https://example.com/menu");
        let QuickItem::Code { codes, text } = outcome.item else {
            panic!("{:?}", outcome.item);
        };
        assert_eq!(text, "Scan for the menu\n");
        assert_eq!(codes.len(), 1);
        assert!(codes[0].is_link);
    }
}
