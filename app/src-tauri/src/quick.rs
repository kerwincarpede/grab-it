//! Quick Access: the small floating card that appears in the corner after a
//! capture, a text capture or a colour pick.
//!
//! A capture shows its thumbnail with Copy, Annotate, Pin, Show in folder
//! and Delete; text, codes and colours show what was copied. The card never takes
//! the keyboard focus, so it does not interrupt what the user was doing, and
//! it dismisses itself after a few seconds unless the pointer is over it.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    codes::{self, Code},
    library::LibraryState,
    pin, windows,
};

pub const LABEL: &str = "quick";
/// Emitted to the card when it should show something else.
pub const QUICK_CHANGED_EVENT: &str = "quick-changed";

/// The card's size in logical pixels.
const WIDTH: f64 = 336.0;
const HEIGHT: f64 = 232.0;
/// The gap between the card and the edges of the monitor's work area.
const MARGIN: f64 = 20.0;
/// The card's corner radius, in points. Matches `.quick` in
/// src/quick/quick.css and the menu bar hub.
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 12.0;
/// The longest side of the thumbnail sent to the card, in pixels: twice the
/// card's width, so it stays sharp on a 2x display.
const THUMB_MAX: u32 = 672;

/// What the card shows. Mirrors `QuickItem` in src/quick/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuickItem {
    #[serde(rename_all = "camelCase")]
    Capture {
        path: PathBuf,
        file_name: String,
        width: u32,
        height: u32,
        /// Whether the capture is on the clipboard already.
        copied: bool,
    },
    /// Text read from the screen, already on the clipboard.
    Text {
        text: String,
        /// What OCR read, when the AI's tidied text took its place.
        #[serde(skip_serializing_if = "Option::is_none")]
        original: Option<String>,
        /// How tidying the text with AI went, when it was asked to.
        #[serde(skip_serializing_if = "Option::is_none")]
        tidy: Option<TextTidy>,
    },
    /// QR codes or barcodes read from the screen, their values already on
    /// the clipboard one per line. `text` is what OCR read around them,
    /// empty when it read nothing; the card offers it to copy instead, and
    /// offers to open the first link.
    Code {
        codes: Vec<Code>,
        text: String,
    },
    /// A picked colour as `#RRGGBB`, already on the clipboard.
    Colour {
        hex: String,
        rgb: String,
    },
    /// Something slow is under way, such as reading text.
    Working {
        message: String,
    },
    Notice {
        title: String,
        message: String,
    },
    Error {
        message: String,
    },
    /// A screen recording is under way; the card offers Stop.
    #[serde(rename_all = "camelCase")]
    Recording {
        /// Milliseconds since the Unix epoch, for the card's timer.
        started_at: u64,
        /// A GIF stops by itself after this long; an MP4 has no limit.
        #[serde(skip_serializing_if = "Option::is_none")]
        max_seconds: Option<u64>,
    },
    /// A finished recording.
    #[serde(rename_all = "camelCase")]
    Recorded {
        path: PathBuf,
        file_name: String,
        /// How long the recording runs, in milliseconds.
        duration_ms: u64,
        /// The file's size in bytes.
        bytes: u64,
        /// What it was saved as.
        format: crate::settings::RecordingFormat,
        /// Why an MP4 recording was saved as a GIF instead, or without
        /// the sound it was to have.
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
}

/// How tidying a text capture with AI is going (see `tidy.rs`). `by` is
/// who tidies it, as the card names them. Mirrors `TextTidy` in
/// src/quick/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TextTidy {
    /// The AI is reading the text again.
    Working { by: String },
    /// The AI's text is on the card. `format` is one of `tidy::FORMATS`;
    /// `changed` is false when it matched what OCR read, and `copied` says
    /// whether it is on the clipboard: not when the user copied something
    /// else while the AI was reading.
    Done {
        by: String,
        format: String,
        language: Option<String>,
        changed: bool,
        copied: bool,
    },
    /// The AI could not tidy it; the card keeps what OCR read.
    Failed { by: String, message: String },
}

/// Which corner of the work area the card sits in; Settings picks it.
pub use crate::settings::PopupCorner as Corner;

/// The corner and how long the card stays, as Settings has them now.
fn chosen(app: &AppHandle) -> (Corner, u32) {
    app.try_state::<crate::commands::SettingsState>()
        .map(|state| {
            let appearance = crate::commands::lock(&state).get().appearance;
            (appearance.popup_corner, appearance.popup_seconds)
        })
        .unwrap_or((
            Corner::default(),
            crate::settings::Appearance::default().popup_seconds,
        ))
}

/// The corner the user picked, for a caller that may move the card away
/// from what it shows.
pub fn preferred_corner(app: &AppHandle) -> Corner {
    chosen(app).0
}

impl QuickItem {
    pub fn capture(path: &Path, size: (u32, u32), copied: bool) -> Self {
        Self::Capture {
            path: path.to_path_buf(),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            width: size.0,
            height: size.1,
            copied,
        }
    }

    /// Text that OCR read, with nothing tidied.
    pub fn text(text: String) -> Self {
        Self::Text {
            text,
            original: None,
            tidy: None,
        }
    }

    pub fn colour(rgb: [u8; 3]) -> Self {
        Self::Colour {
            hex: hex_colour(rgb),
            rgb: format!("rgb({}, {}, {})", rgb[0], rgb[1], rgb[2]),
        }
    }
}

/// `#RRGGBB`, upper case, as design tools show it.
pub fn hex_colour(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// What is on the card, numbered so that an action can say which card it
/// was clicked on. Mirrors `QuickShown` in src/quick/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Shown {
    /// Different for every item the card has shown.
    pub generation: u64,
    pub item: QuickItem,
    /// How long the card stays, in seconds, as Settings has it; 0 keeps it
    /// until it is closed.
    pub seconds: u32,
}

#[derive(Default)]
pub struct QuickState {
    current: Mutex<Option<Shown>>,
    generations: AtomicU64,
    /// The newest capture, for the tray's "Show last capture".
    last_capture: Mutex<Option<QuickItem>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Shows `item` on the card, creating the card when it is not on screen,
/// and returns its generation. Call this off the main thread: it may create
/// a window.
pub fn show(app: &AppHandle, item: QuickItem) -> u64 {
    show_in(app, item, preferred_corner(app))
}

/// Like [`show`], in a chosen corner: a recording keeps the card out of
/// the area being recorded.
///
/// An existing card window is told about the item by event; a card still
/// loading reads it with `quick_info` once it is up, and reads it again
/// after subscribing, so an item set in between is not missed.
pub fn show_in(app: &AppHandle, item: QuickItem, corner: Corner) -> u64 {
    let state = app.state::<QuickState>();
    if matches!(item, QuickItem::Capture { .. }) {
        *lock(&state.last_capture) = Some(item.clone());
    }
    let shown = Shown {
        generation: state.generations.fetch_add(1, Ordering::Relaxed) + 1,
        item,
        seconds: chosen(app).1,
    };
    *lock(&state.current) = Some(shown.clone());

    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(position) = corner_position(app, corner) {
            let _ = window.set_position(position);
        }
        let _ = window.emit(QUICK_CHANGED_EVENT, &shown);
        let _ = window.show();
        return shown.generation;
    }
    if let Err(err) = create_window(app, corner) {
        eprintln!("Grab-it: could not show Quick Access: {err}");
    }
    shown.generation
}

/// Shows `item` in place of item `generation`, where it is: for news about
/// what the card shows, such as tidied text. Returns the new generation, or
/// None, changing nothing, when the card was dismissed or has moved on.
pub fn replace(app: &AppHandle, generation: u64, item: QuickItem) -> Option<u64> {
    let state = app.state::<QuickState>();
    // Held while the card is told, so a newer item shown meanwhile is
    // always told after this one and stays.
    let mut current = lock(&state.current);
    if current.as_ref().map(|shown| shown.generation) != Some(generation) {
        return None;
    }
    let shown = Shown {
        generation: state.generations.fetch_add(1, Ordering::Relaxed) + 1,
        item,
        seconds: chosen(app).1,
    };
    *current = Some(shown.clone());
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit(QUICK_CHANGED_EVENT, &shown);
    }
    Some(shown.generation)
}

/// Records a capture as the newest without showing the card, for when the
/// user chose the editor or nothing after a capture.
pub fn remember(app: &AppHandle, item: QuickItem) {
    *lock(&app.state::<QuickState>().last_capture) = Some(item);
}

/// Shows the newest capture again. False when there is none this session or
/// its file is gone.
pub fn show_last(app: &AppHandle) -> bool {
    let Some(item) = lock(&app.state::<QuickState>().last_capture).clone() else {
        return false;
    };
    let QuickItem::Capture { path, .. } = &item else {
        return false;
    };
    if !path.is_file() {
        return false;
    }
    show(app, item);
    true
}

/// Takes the card off screen, if it still shows item `generation`; a
/// newer item stays. The window is hidden, not destroyed, and reused for
/// the next item, so the next card appears without waiting for a webview.
fn dismiss(app: &AppHandle, generation: u64) {
    {
        let state = app.state::<QuickState>();
        let mut current = lock(&state.current);
        match current.as_ref() {
            Some(shown) if shown.generation == generation => *current = None,
            // A newer item has taken the card over.
            _ => return,
        }
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

fn create_window(app: &AppHandle, corner: Corner) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/quick".into()))
        .title("Grab-it Quick Access")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // The card must not pull the keyboard away from the user's work.
        .focused(false)
        .shadow(true)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    windows::round_corners(&window, CORNER_RADIUS)?;
    if let Some(position) = corner_position(app, corner) {
        window.set_position(position)?;
    }
    window.show()?;
    Ok(())
}

/// A corner of the monitor under the pointer (else the primary monitor),
/// inside its work area so the card clears the taskbar or Dock.
fn corner_position(app: &AppHandle, corner: Corner) -> Option<PhysicalPosition<i32>> {
    let under_pointer = app
        .cursor_position()
        .ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten());
    let monitor = under_pointer.or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some(place_in_corner(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
        corner,
    ))
}

/// Where the card's top-left corner goes, in physical pixels, for a work
/// area at `origin` of `size`.
pub fn place_in_corner(
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
    corner: Corner,
) -> PhysicalPosition<i32> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let margin = (MARGIN * scale).round() as i32;
    let width = (WIDTH * scale).round() as i32;
    let height = (HEIGHT * scale).round() as i32;
    let left = origin.0 + margin;
    let right = origin.0 + size.0 as i32 - width - margin;
    let top = origin.1 + margin;
    // A work area smaller than the card still keeps its top-left on screen.
    let bottom = (origin.1 + size.1 as i32 - height - margin).max(origin.1);
    match corner {
        Corner::BottomLeft => PhysicalPosition::new(left, bottom),
        Corner::BottomRight => PhysicalPosition::new(right.max(origin.0), bottom),
        Corner::TopLeft => PhysicalPosition::new(left, top),
        Corner::TopRight => PhysicalPosition::new(right.max(origin.0), top),
    }
}

/// The corner whose card would not cover `region`, a rectangle in a
/// monitor's image pixels: `preferred` when it is clear, else the first
/// clear one, else `preferred` anyway. The card's footprint is padded
/// generously, since the work area (and so the card's exact place) is only
/// known in screen units.
pub fn corner_clear_of(
    region: crate::capture::Rect,
    image_size: (u32, u32),
    scale: f64,
    preferred: Corner,
) -> Corner {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    // The card, its margin, and room for a taskbar or Dock.
    let reach_x = ((WIDTH + 2.0 * MARGIN) * scale) as i64;
    let reach_y = ((HEIGHT + 2.0 * MARGIN + 80.0) * scale) as i64;
    let (width, height) = (i64::from(image_size.0), i64::from(image_size.1));
    let left = i64::from(region.x);
    let top = i64::from(region.y);
    let right = left + i64::from(region.width);
    let bottom = top + i64::from(region.height);

    let in_left = left < reach_x;
    let in_right = right > width - reach_x;
    let in_bottom = bottom > height - reach_y;
    let in_top = top < reach_y;
    let covered = |corner: Corner| match corner {
        Corner::BottomLeft => in_left && in_bottom,
        Corner::BottomRight => in_right && in_bottom,
        Corner::TopLeft => in_left && in_top,
        Corner::TopRight => in_right && in_top,
    };
    [
        preferred,
        Corner::BottomLeft,
        Corner::BottomRight,
        Corner::TopLeft,
        Corner::TopRight,
    ]
    .into_iter()
    .find(|corner| !covered(*corner))
    .unwrap_or(preferred)
}

#[tauri::command]
pub fn quick_info(state: State<'_, QuickState>) -> Option<Shown> {
    lock(&state.current).clone()
}

/// The capture on the card as a small PNG.
#[tauri::command(async)]
pub fn quick_thumbnail(state: State<'_, QuickState>) -> Result<tauri::ipc::Response, String> {
    let path = match &*lock(&state.current) {
        Some(Shown {
            item: QuickItem::Capture { path, .. },
            ..
        }) => path.clone(),
        _ => return Err("there is no capture on the card".to_owned()),
    };
    let image =
        image::open(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?;
    let small = if image.width() > THUMB_MAX || image.height() > THUMB_MAX {
        image.resize(THUMB_MAX, THUMB_MAX, FilterType::Triangle)
    } else {
        image
    };
    let mut png = Vec::new();
    small
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    Ok(tauri::ipc::Response::new(png))
}

/// What a button on the card does. Mirrors `QuickAction` in src/quick/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuickAction {
    Copy,
    Edit,
    Pin,
    Reveal,
    Delete,
    Close,
    /// Copies what OCR read, in place of the tidied text.
    CopyOriginal,
    /// Copies the text read around the codes, in place of their values.
    CopyText,
    /// Opens the first code's link in the browser, and dismisses the card.
    /// Only ever on a click: a decoded link is never opened by itself.
    OpenLink,
}

/// Runs a button of the card that showed item `generation`. When the card
/// has moved on to a newer item the action is dropped: a click (or a
/// dismiss timer) racing a new capture must never copy, delete or hide the
/// newer one.
///
/// Async, so the windows some actions open are never created on the main
/// thread inside a command, which deadlocks on Windows.
#[tauri::command]
pub async fn quick_action(
    action: QuickAction,
    generation: u64,
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<QuickState>();
    let item = match &*lock(&state.current) {
        Some(shown) if shown.generation == generation => shown.item.clone(),
        _ => return Ok(()),
    };
    match (action, &item) {
        (QuickAction::Close, _) => dismiss(&app, generation),
        // A recording is a file but not a capture: it can be shown in its
        // folder and deleted, not annotated, pinned or copied as an image.
        (
            QuickAction::Reveal,
            QuickItem::Capture { path, .. } | QuickItem::Recorded { path, .. },
        ) => {
            app.opener()
                .reveal_item_in_dir(path)
                .map_err(|err| format!("could not show the file in its folder: {err}"))?;
        }
        (QuickAction::Delete, QuickItem::Recorded { path, .. }) => {
            fs::remove_file(path)
                .map_err(|err| format!("could not delete the recording: {err}"))?;
            dismiss(&app, generation);
        }
        (QuickAction::Delete, QuickItem::Capture { path, .. }) => {
            delete_capture(&app, path)?;
            *lock(&state.last_capture) = None;
            dismiss(&app, generation);
        }
        (QuickAction::Copy, QuickItem::Capture { path, .. }) => copy_file(&app, path)?,
        (QuickAction::Copy, QuickItem::Text { text, .. })
        | (
            QuickAction::CopyOriginal,
            QuickItem::Text {
                original: Some(text),
                ..
            },
        ) => copy_text(&app, text)?,
        (QuickAction::Copy, QuickItem::Code { codes, .. }) => {
            copy_text(&app, &codes::values(codes))?;
        }
        (QuickAction::CopyText, QuickItem::Code { text, .. }) if !text.trim().is_empty() => {
            copy_text(&app, text)?;
        }
        (QuickAction::OpenLink, QuickItem::Code { codes, .. }) => {
            let url = first_link(codes).ok_or("there is no link on the card")?;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|err| format!("could not open the link: {err}"))?;
            dismiss(&app, generation);
        }
        (QuickAction::Edit, QuickItem::Capture { path, .. }) => {
            windows::show_editor(&app, path).map_err(|err| err.to_string())?;
            dismiss(&app, generation);
        }
        (QuickAction::Pin, QuickItem::Capture { path, .. }) => {
            pin::open(&app, path, false)?;
            dismiss(&app, generation);
        }
        _ => return Err("there is no capture on the card".to_owned()),
    }
    Ok(())
}

/// The value of the first code in `codes` that is an http(s) link, for
/// Open link.
pub fn first_link(codes: &[Code]) -> Option<&str> {
    codes
        .iter()
        .find(|code| code.is_link)
        .map(|code| code.value.trim())
}

/// Puts `text` on the clipboard.
fn copy_text(app: &AppHandle, text: &str) -> Result<(), String> {
    app.clipboard()
        .write_text(text.to_owned())
        .map_err(|err| format!("could not copy the text: {err}"))
}

/// Puts the image in `path` on the clipboard.
pub fn copy_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    let image = image::open(path)
        .map_err(|err| format!("could not open {}: {err}", path.display()))?
        .into_rgba8();
    let clip = tauri::image::Image::new(image.as_raw(), image.width(), image.height());
    app.clipboard()
        .write_image(&clip)
        .map_err(|err| format!("could not copy to the clipboard: {err}"))
}

/// Deletes a capture with its sidecars, through the library when it knows
/// the capture so the Library window updates too.
fn delete_capture(app: &AppHandle, path: &Path) -> Result<(), String> {
    if let Some(window) = app
        .state::<crate::editor::EditorState>()
        .label_for(path)
        .and_then(|label| app.get_webview_window(&label))
    {
        let _ = window.destroy();
    }
    let library = app.state::<LibraryState>();
    let known = library
        .lock()
        .id_for_path(path)
        .map_err(|err| err.to_string())?;
    match known {
        Some(id) => {
            library.lock().delete(id).map_err(|err| err.to_string())?;
            let _ = app.emit(crate::library::LIBRARY_CHANGED_EVENT, ());
        }
        None => {
            fs::remove_file(path).map_err(|err| format!("could not delete the capture: {err}"))?;
            let _ = fs::remove_file(crate::capture::meta_path(path));
            let _ = fs::remove_file(crate::capture::annotations_path(path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_upper_case_hex() {
        assert_eq!(hex_colour([0, 144, 255]), "#0090FF");
        assert_eq!(
            QuickItem::colour([229, 72, 77]),
            QuickItem::Colour {
                hex: "#E5484D".into(),
                rgb: "rgb(229, 72, 77)".into(),
            }
        );
    }

    #[test]
    fn the_card_sits_in_the_bottom_left_of_the_work_area() {
        let corner = Corner::BottomLeft;
        // A 1920x1080 monitor with a 40 px taskbar at the bottom.
        assert_eq!(
            place_in_corner((0, 0), (1920, 1040), 1.0, corner),
            PhysicalPosition::new(20, 1040 - 232 - 20)
        );
        // A 2x monitor to the right: sizes and margins double.
        assert_eq!(
            place_in_corner((1920, 0), (3840, 2160), 2.0, corner),
            PhysicalPosition::new(1920 + 40, 2160 - 464 - 40)
        );
        // A work area shorter than the card keeps the card's top visible.
        assert_eq!(place_in_corner((0, 100), (800, 200), 1.0, corner).y, 100);
        // A nonsense scale factor falls back to 1.
        assert_eq!(place_in_corner((0, 0), (800, 600), 0.0, corner).x, 20);
    }

    #[test]
    fn the_other_corners_mirror_it() {
        assert_eq!(
            place_in_corner((0, 0), (1920, 1040), 1.0, Corner::TopRight),
            PhysicalPosition::new(1920 - 336 - 20, 20)
        );
        assert_eq!(
            place_in_corner((0, 0), (1920, 1040), 1.0, Corner::BottomRight),
            PhysicalPosition::new(1920 - 336 - 20, 1040 - 232 - 20)
        );
        assert_eq!(
            place_in_corner((100, 50), (1920, 1040), 1.0, Corner::TopLeft),
            PhysicalPosition::new(120, 70)
        );
    }

    #[test]
    fn the_card_keeps_out_of_a_recorded_region() {
        use crate::capture::Rect;
        let screen = (1920, 1080);
        let region = |x, y, width, height| Rect {
            x,
            y,
            width,
            height,
        };
        // A region in the middle leaves the usual corner free.
        assert_eq!(
            corner_clear_of(region(700, 300, 500, 300), screen, 1.0, Corner::BottomLeft),
            Corner::BottomLeft
        );
        // Recording the bottom-left moves the card to the right.
        assert_eq!(
            corner_clear_of(region(0, 600, 600, 480), screen, 1.0, Corner::BottomLeft),
            Corner::BottomRight
        );
        // A strip along the whole bottom leaves the top.
        assert_eq!(
            corner_clear_of(region(0, 800, 1920, 280), screen, 1.0, Corner::BottomLeft),
            Corner::TopLeft
        );
        // The whole screen: nowhere is clear, so the usual corner it is.
        assert_eq!(
            corner_clear_of(region(0, 0, 1920, 1080), screen, 1.0, Corner::BottomLeft),
            Corner::BottomLeft
        );
        // The chosen corner wins when it is clear, and is kept when nothing is.
        assert_eq!(
            corner_clear_of(region(700, 300, 500, 300), screen, 1.0, Corner::TopRight),
            Corner::TopRight
        );
        assert_eq!(
            corner_clear_of(region(1400, 0, 520, 300), screen, 1.0, Corner::TopRight),
            Corner::BottomLeft
        );
        assert_eq!(
            corner_clear_of(region(0, 0, 1920, 1080), screen, 1.0, Corner::TopRight),
            Corner::TopRight
        );
    }

    #[test]
    fn items_serialise_with_a_kind_tag() {
        let item = QuickItem::capture(Path::new("/x/originals/shot.png"), (30, 20), true);
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "capture");
        assert_eq!(json["fileName"], "shot.png");
        assert_eq!(json["width"], 30);
        assert_eq!(json["copied"], true);
        let text = serde_json::to_value(QuickItem::text("hi".into())).unwrap();
        assert_eq!(text, serde_json::json!({ "kind": "text", "text": "hi" }));
        let tidied = serde_json::to_value(QuickItem::Text {
            text: "{\n  \"a\": 1\n}".into(),
            original: Some("{a: 1}".into()),
            tidy: Some(TextTidy::Done {
                by: "Claude Code".into(),
                format: "json".into(),
                language: None,
                changed: true,
                copied: true,
            }),
        })
        .unwrap();
        assert_eq!(tidied["original"], "{a: 1}");
        assert_eq!(
            tidied["tidy"],
            serde_json::json!({
                "state": "done", "by": "Claude Code", "format": "json", "language": null,
                "changed": true, "copied": true,
            })
        );
        let working = serde_json::to_value(TextTidy::Working { by: "Codex".into() }).unwrap();
        assert_eq!(
            working,
            serde_json::json!({ "state": "working", "by": "Codex" })
        );
    }

    #[test]
    fn code_items_serialise_their_codes() {
        let item = QuickItem::Code {
            codes: vec![
                Code::new("QR code", "https://example.com"),
                Code::new("Code 128", "ABC-123"),
            ],
            text: "Scan me".into(),
        };
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            serde_json::json!({
                "kind": "code",
                "codes": [
                    { "format": "QR code", "value": "https://example.com", "isLink": true },
                    { "format": "Code 128", "value": "ABC-123", "isLink": false },
                ],
                "text": "Scan me",
            })
        );
    }

    #[test]
    fn actions_deserialise_from_camel_case() {
        let action = |name: &str| serde_json::from_value::<QuickAction>(name.into()).unwrap();
        assert_eq!(action("copyText"), QuickAction::CopyText);
        assert_eq!(action("openLink"), QuickAction::OpenLink);
        assert_eq!(action("copyOriginal"), QuickAction::CopyOriginal);
    }

    #[test]
    fn open_link_picks_the_first_link() {
        let codes = [
            Code::new("Code 128", "ABC-123"),
            Code::new("QR code", " https://one.example \n"),
            Code::new("QR code", "https://two.example"),
        ];
        assert_eq!(first_link(&codes), Some("https://one.example"));
        assert_eq!(first_link(&codes[..1]), None);
        assert_eq!(first_link(&[]), None);
    }
}
