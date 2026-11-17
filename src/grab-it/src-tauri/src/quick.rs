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
    pin,
    settings::RecordingFormat,
    windows,
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
    Scrolling {
        session_id: u64,
        width: u32,
        height: u32,
        capped: bool,
        auto_scrolling: bool,
        manual_reason: Option<String>,
    },
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
///
/// An existing card window is told about the item by event; a card still
/// loading reads it with `quick_info` once it is up, and reads it again
/// after subscribing, so an item set in between is not missed.
pub fn show(app: &AppHandle, item: QuickItem) -> u64 {
    let corner = preferred_corner(app);
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
pub(crate) fn is_current(app: &AppHandle, generation: u64) -> bool {
    lock(&app.state::<QuickState>().current)
        .as_ref()
        .is_some_and(|s| s.generation == generation)
}

pub(crate) fn dismiss(app: &AppHandle, generation: u64) {
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
        // Because the card is never focused, macOS would spend the first
        // click on activating it while another app is in front, so a button
        // such as Done would need two clicks. Let that first click through.
        .accept_first_mouse(true)
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

#[tauri::command]
pub fn quick_info(state: State<'_, QuickState>) -> Option<Shown> {
    lock(&state.current).clone()
}

/// The capture on the card as a small PNG, or a frame of the recording on
/// it: a GIF's first, an MP4's from a moment in (with ffmpeg, once ready).
#[tauri::command(async)]
pub fn quick_thumbnail(
    app: AppHandle,
    state: State<'_, QuickState>,
) -> Result<tauri::ipc::Response, String> {
    let item = match &*lock(&state.current) {
        Some(Shown { item, .. }) => item.clone(),
        None => return Err("there is nothing on the card".to_owned()),
    };
    let image = match item {
        QuickItem::Capture { path, .. }
        | QuickItem::Recorded {
            path,
            format: RecordingFormat::Gif,
            ..
        } => {
            image::open(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?
        }
        QuickItem::Recorded {
            path, duration_ms, ..
        } => {
            let ready = crate::ffmpeg::ready(&app).ok_or("ffmpeg is not ready")?;
            crate::ffmpeg::video_frame(
                &ready.path,
                &path,
                crate::ffmpeg::preview_at_ms(Some(duration_ms)),
                THUMB_MAX,
            )?
        }
        _ => return Err("there is no capture on the card".to_owned()),
    };
    thumbnail_png(image).map(tauri::ipc::Response::new)
}

/// Shared thumbnail encoding for the card and its native drag image.
fn thumbnail_png(image: image::DynamicImage) -> Result<Vec<u8>, String> {
    let small = if image.width() > THUMB_MAX || image.height() > THUMB_MAX {
        image.resize(THUMB_MAX, THUMB_MAX, FilterType::Triangle)
    } else {
        image
    };
    let mut png = Vec::new();
    small
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    Ok(png)
}

#[derive(Debug, PartialEq, Eq)]
enum DragImage {
    Thumbnail,
    AppIcon,
}

/// Pure selection: never reads the filesystem or uses window state.
fn drag_source(item: &QuickItem) -> Option<(PathBuf, DragImage)> {
    match item {
        QuickItem::Capture { path, .. } => Some((path.clone(), DragImage::Thumbnail)),
        QuickItem::Recorded { path, .. } => Some((path.clone(), DragImage::AppIcon)),
        _ => None,
    }
}

/// Resolves only after native drop/cancel, not when GTK merely starts the drag.
#[tauri::command]
pub async fn quick_drag(generation: u64, app: AppHandle) -> Result<(), String> {
    let item = {
        let state = app.state::<QuickState>();
        let current = lock(&state.current);
        match current.as_ref() {
            Some(shown) if shown.generation == generation => shown.item.clone(),
            _ => return Ok(()),
        }
    };
    let (path, image) = drag_source(&item).ok_or("there is no file on the card")?;
    let path = path
        .canonicalize()
        .map_err(|err| format!("could not find the file: {err}"))?;
    if !path.is_file() {
        return Err("the card's file is no longer available".into());
    }
    let image = match image {
        DragImage::Thumbnail => drag::Image::Raw(thumbnail_png(
            image::open(&path).map_err(|err| format!("could not open the capture: {err}"))?,
        )?),
        // Embedded so installed builds do not depend on the source tree.
        DragImage::AppIcon => drag::Image::Raw(include_bytes!("../icons/128x128.png").to_vec()),
    };
    let (send, receive) = std::sync::mpsc::channel();
    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            // Thumbnail IO may have raced a new capture.
            let state = main_app.state::<QuickState>();
            if lock(&state.current).as_ref().map(|shown| shown.generation) != Some(generation) {
                let _ = send.send(Ok(()));
                return Ok(());
            }
            let window = main_app
                .get_webview_window(LABEL)
                .ok_or("Quick Access is closed")?;
            #[cfg(target_os = "linux")]
            start_gtk_file_drag(
                &window.gtk_window().map_err(|err| err.to_string())?,
                &path,
                image,
                send.clone(),
            )?;
            #[cfg(not(target_os = "linux"))]
            {
                let completed = send.clone();
                drag::start_drag(
                    &window,
                    drag::DragItem::Files(vec![path]),
                    image,
                    move |_, _| {
                        let _ = completed.send(Ok(()));
                    },
                    drag::Options::default(),
                )
                .map_err(|err| format!("could not drag the file: {err}"))?;
            }
            Ok(())
        })();
        if let Err(err) = result {
            let _ = send.send(Err(err));
        }
    })
    .map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receive
            .recv()
            .map_err(|_| "native drag ended without a result".to_owned())?
    })
    .await
    .map_err(|err| err.to_string())?
}

/// GTK asks for selection data asynchronously, potentially *after*
/// drop-performed. Keep the provider installed until drag-end, which GTK
/// emits after transfer or cancellation. Never complete on drop-performed.
#[cfg(target_os = "linux")]
fn start_gtk_file_drag(
    window: &gtk::ApplicationWindow,
    path: &Path,
    image: drag::Image,
    completed: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use gtk::prelude::*;
    use std::{cell::RefCell, rc::Rc};

    // Validate everything fallible before installing any handlers.
    let bytes = match image {
        drag::Image::Raw(bytes) => bytes,
        drag::Image::File(path) => fs::read(path).map_err(|err| err.to_string())?,
    };
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    loader.write(&bytes).map_err(|err| err.to_string())?;
    loader.close().map_err(|err| err.to_string())?;
    let icon = loader.pixbuf().ok_or("could not decode the drag image")?;
    let uri = gtk::gio::File::for_path(path).uri();
    let handlers = Rc::new(RefCell::new(Vec::<gtk::glib::SignalHandlerId>::new()));

    // Closures own only handler IDs, URI data and the sender, never a window
    // or drag context. There is no GObject -> callback -> GObject cycle.
    let data_handler = window.connect_drag_data_get(move |_, _, selection, _, _| {
        selection.set_uris(&[uri.as_str()]);
    });
    handlers.borrow_mut().push(data_handler);
    let end_handlers = handlers.clone();
    let end_handler = window.connect_drag_end(move |window, _| {
        // Disconnect even ourselves, releasing the URI and callback sender.
        let ids = std::mem::take(&mut *end_handlers.borrow_mut());
        for id in ids {
            window.disconnect(id);
        }
        let _ = completed.send(Ok(()));
    });
    handlers.borrow_mut().push(end_handler);

    // An explicit target list avoids changing the widget's persistent drag
    // source configuration. Button is the button number, not its GDK mask.
    let targets = gtk::TargetList::new(&[gtk::TargetEntry::new(
        "text/uri-list",
        gtk::TargetFlags::empty(),
        0,
    )]);
    let context =
        window.drag_begin_with_coordinates(&targets, gtk::gdk::DragAction::COPY, 1, None, -1, -1);
    match context {
        Some(context) => {
            context.drag_set_icon_pixbuf(&icon, 0, 0);
            Ok(())
        }
        None => {
            let ids = std::mem::take(&mut *handlers.borrow_mut());
            for id in ids {
                window.disconnect(id);
            }
            Err("could not start the native file drag".into())
        }
    }
}

/// What a button on the card does. Mirrors `QuickAction` in src/quick/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuickAction {
    Copy,
    Edit,
    Pin,
    Reveal,
    /// Opens a recording in the app that plays it.
    Open,
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
        // A recording is a file but not a capture: it can be played, shown in
        // its folder, deleted and (an MP4) edited, not annotated, pinned or
        // copied as an image.
        (
            QuickAction::Reveal,
            QuickItem::Capture { path, .. } | QuickItem::Recorded { path, .. },
        ) => {
            app.opener()
                .reveal_item_in_dir(path)
                .map_err(|err| format!("could not show the file in its folder: {err}"))?;
        }
        (QuickAction::Open, QuickItem::Recorded { path, .. }) => {
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|err| format!("could not open the recording: {err}"))?;
            dismiss(&app, generation);
        }
        (QuickAction::Delete, QuickItem::Recorded { path, .. }) => {
            delete_recording(&app, path)?;
            dismiss(&app, generation);
        }
        (
            QuickAction::Edit,
            QuickItem::Recorded {
                path,
                format: RecordingFormat::Mp4,
                ..
            },
        ) => {
            windows::show_recording_editor(&app, path).map_err(|err| err.to_string())?;
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

/// Deletes a recording with its sidecars, closing its editor first.
fn delete_recording(app: &AppHandle, path: &Path) -> Result<(), String> {
    if let Some(window) = app
        .state::<crate::recording_editor::RecordingEditorState>()
        .label_for(path)
        .and_then(|label| app.get_webview_window(&label))
    {
        let _ = window.destroy();
    }
    // The library deletes its row with the files, thumbnail included.
    let library = app.state::<LibraryState>();
    let known = library
        .lock()
        .id_for_path(path)
        .map_err(|err| err.to_string())?;
    if let Some(id) = known {
        library.lock().delete(id).map_err(|err| err.to_string())?;
        let _ = app.emit(crate::library::LIBRARY_CHANGED_EVENT, ());
        return Ok(());
    }
    fs::remove_file(path).map_err(|err| format!("could not delete the recording: {err}"))?;
    let _ = fs::remove_file(crate::record::cursor_path(path));
    let _ = fs::remove_file(crate::recording_editor::edits_path(path));
    Ok(())
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

    /// Run explicitly under Xvfb + dbus-run-session with xdotool installed:
    /// cargo test gtk_drag_serves_a_delayed_drop -- --ignored --test-threads=1
    /// This is a native GTK fixture, independent of the Grab-it application.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated X11 display and xdotool"]
    fn gtk_drag_serves_a_delayed_drop() {
        use gtk::{gdk, glib, prelude::*};
        use std::{cell::RefCell, rc::Rc, time::Duration};

        gtk::init().expect("GTK display");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original # capture %.png");
        fs::write(&path, include_bytes!("../icons/128x128.png")).unwrap();
        let expected = gtk::gio::File::for_path(&path).uri().to_string();
        assert!(expected.contains("%23"));
        assert!(expected.contains("%25"));
        assert!(expected.contains("%20"));

        let source = gtk::ApplicationWindow::builder()
            .title("Drag source fixture")
            .default_width(160)
            .default_height(160)
            .build();
        source.move_(40, 40);
        source.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
        let target = gtk::Window::builder()
            .title("Delayed URI target fixture")
            .default_width(200)
            .default_height(200)
            .build();
        target.move_(350, 40);
        target.drag_dest_set(
            gtk::DestDefaults::empty(),
            &[gtk::TargetEntry::new(
                "text/uri-list",
                gtk::TargetFlags::empty(),
                0,
            )],
            gdk::DragAction::COPY,
        );
        target.connect_drag_motion(|_, context, _, _, time| {
            context.drag_status(gdk::DragAction::COPY, time);
            true
        });
        // No data prefetch during motion. Request it only *after* release,
        // delayed further so drop-performed has already been delivered.
        target.connect_drag_drop(|target, context, _, _, time| {
            let target = target.clone();
            let context = context.clone();
            glib::timeout_add_local_once(Duration::from_millis(100), move || {
                target.drag_get_data(&context, &gdk::Atom::intern("text/uri-list"), time);
            });
            true
        });
        let received = Rc::new(RefCell::new(Vec::new()));
        let received_data = received.clone();
        target.connect_drag_data_received(move |_, context, _, _, data, _, time| {
            *received_data.borrow_mut() = data.uris().iter().map(ToString::to_string).collect();
            // The copy must not delete the source file.
            context.drag_finish(!received_data.borrow().is_empty(), false, time);
        });
        let (send, receive) = std::sync::mpsc::channel();
        let start_error = Rc::new(RefCell::new(None));
        let error = start_error.clone();
        source.connect_button_press_event(move |window, _| {
            if let Err(err) = start_gtk_file_drag(
                window,
                &path,
                drag::Image::Raw(include_bytes!("../icons/128x128.png").to_vec()),
                send.clone(),
            ) {
                *error.borrow_mut() = Some(err);
            }
            glib::Propagation::Stop
        });
        source.show_all();
        target.show_all();
        let main_loop = glib::MainLoop::new(None, false);
        let done = main_loop.clone();
        let completion = Rc::new(RefCell::new(None));
        let result = completion.clone();
        let poll = glib::timeout_add_local(Duration::from_millis(20), move || {
            if let Ok(value) = receive.try_recv() {
                *result.borrow_mut() = Some(value);
                done.quit();
                glib::ControlFlow::Break
            } else {
                glib::ControlFlow::Continue
            }
        });
        let deadline_loop = main_loop.clone();
        let deadline =
            glib::timeout_add_local_once(Duration::from_secs(6), move || deadline_loop.quit());
        let mut pointer = std::process::Command::new("sh").args(["-c",
            "sleep 0.5; xdotool mousemove 100 100 mousedown 1; sleep 0.3; xdotool mousemove 120 100; sleep 0.3; xdotool mousemove 430 120; sleep 0.5; xdotool mouseup 1"
        ]).spawn().expect("xdotool fixture");
        main_loop.run();
        assert!(pointer.wait().unwrap().success(), "xdotool fixture failed");
        // Remove only sources that did not remove themselves.
        if completion.borrow().is_some() {
            deadline.remove();
        } else {
            poll.remove();
        }
        source.close();
        target.close();
        assert_eq!(*start_error.borrow(), None);
        assert_eq!(*received.borrow(), vec![expected]);
        assert_eq!(*completion.borrow(), Some(Ok(())));
    }

    #[test]
    fn drag_sources_keep_original_files_and_choose_their_preview() {
        let capture = QuickItem::capture(Path::new("/shots/original.png"), (30, 20), true);
        assert_eq!(
            drag_source(&capture),
            Some(("/shots/original.png".into(), DragImage::Thumbnail))
        );
        for format in [RecordingFormat::Mp4, RecordingFormat::Gif] {
            let path = PathBuf::from(if format == RecordingFormat::Mp4 {
                "/video.mp4"
            } else {
                "/video.gif"
            });
            let recording = QuickItem::Recorded {
                path: path.clone(),
                file_name: "video".into(),
                duration_ms: 100,
                bytes: 42,
                format,
                fallback: None,
            };
            assert_eq!(drag_source(&recording), Some((path, DragImage::AppIcon)));
        }
        for item in [
            QuickItem::colour([0, 0, 0]),
            QuickItem::text("text".into()),
            QuickItem::Code {
                codes: vec![],
                text: String::new(),
            },
            QuickItem::Notice {
                title: "Notice".into(),
                message: String::new(),
            },
            QuickItem::Error {
                message: "error".into(),
            },
            QuickItem::Working {
                message: "working".into(),
            },
        ] {
            assert_eq!(drag_source(&item), None);
        }
    }

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
