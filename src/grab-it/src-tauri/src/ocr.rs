//! OCR of captures: with the system's own recognition where there is one
//! (Vision on macOS, see [`crate::ocr_vision`], and Windows.Media.Ocr on
//! Windows, see [`crate::ocr_windows`]), else with
//! [ocrs](https://github.com/robertknight/ocrs), which is also the fallback
//! when the system's engine fails.
//!
//! The two ocrs models ship with Grab-it as Tauri resources, in
//! `ocr-models/` under the resource directory (from `src-tauri/ocr-models/`,
//! with their licence). One background thread reads the text of every
//! capture waiting for OCR, newest first and one at a time, and stores it in
//! the library, where the full-text index picks it up. The values of any QR
//! codes or barcodes in a capture are stored after its text (see
//! [`with_codes`]), so search finds them too.

use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};

use ocrs::{ImageSource, OcrEngine, OcrEngineParams, TextItem};
use rten::Model;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use image::RgbaImage;

use crate::rt::AppHandle;
use crate::{
    capture::Rect,
    codes::{self, Code},
    library::{LIBRARY_CHANGED_EVENT, LibraryResult, LibraryState},
};

/// Where the models live, under the resource directory. Earlier versions
/// downloaded them into a folder of the same name under the app data
/// directory; [`remove_downloaded_models`] deletes that copy.
pub const MODELS_DIR: &str = "ocr-models";
/// Overrides the models directory, for trying other models.
pub const MODELS_DIR_ENV: &str = "GRAB_IT_OCR_MODELS";
/// Emitted with an [`OcrStatus`] whenever the OCR queue changes state.
pub const OCR_STATUS_EVENT: &str = "ocr-status";

/// The ocrs detection and recognition models, unmodified copies of the
/// ones the ocrs project publishes at
/// `https://ocrs-models.s3-accelerate.amazonaws.com/<file>`. Their SHA-256
/// checksums are pinned in the tests.
pub const MODELS: [&str; 2] = ["text-detection.onnx", "text-recognition.onnx"];

#[derive(Debug)]
pub enum OcrError {
    /// A model file could not be loaded.
    Model(String),
    /// The capture could not be opened.
    Image(image::ImageError),
    /// ocrs failed on the image.
    Engine(String),
}

impl fmt::Display for OcrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(err) => write!(f, "could not load the text recognition models: {err}"),
            Self::Image(err) => write!(f, "could not read the capture: {err}"),
            Self::Engine(err) => write!(f, "text recognition failed: {err}"),
        }
    }
}

impl std::error::Error for OcrError {}

impl From<image::ImageError> for OcrError {
    fn from(err: image::ImageError) -> Self {
        Self::Image(err)
    }
}

/// ocrs 0.12 reports engine failures as `anyhow::Error`.
fn engine_error(err: impl fmt::Display) -> OcrError {
    OcrError::Engine(err.to_string())
}

pub type OcrResult<T> = std::result::Result<T, OcrError>;

/// The models directory: `$GRAB_IT_OCR_MODELS` when set, else the models
/// bundled in `ocr-models/` under the resource directory.
pub fn models_dir(resources: &Path) -> PathBuf {
    match std::env::var_os(MODELS_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => resources.join(MODELS_DIR),
    }
}

/// Deletes the models that earlier versions downloaded into `ocr-models/`
/// under `app_data`, and their unfinished `.part-*` downloads, now that the
/// app ships its own. The folder itself goes only once it is empty, so
/// anything else someone put there stays.
pub fn remove_downloaded_models(app_data: &Path) {
    let dir = app_data.join(MODELS_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ours = MODELS.iter().any(|model| {
            name == *model
                || name
                    .strip_prefix(model)
                    .is_some_and(|rest| rest.starts_with(".part"))
        });
        if ours && let Err(err) = fs::remove_file(entry.path()) {
            eprintln!(
                "Grab-it: could not delete {}: {err}",
                entry.path().display()
            );
        }
    }
    let _ = fs::remove_dir(&dir);
}

/// A loaded ocrs engine.
pub struct Ocr {
    engine: OcrEngine,
}

impl Ocr {
    /// Loads the models from `dir`.
    pub fn load(dir: &Path) -> OcrResult<Self> {
        let load = |model: &str| {
            Model::load_file(dir.join(model))
                .map_err(|err| OcrError::Model(format!("{model}: {err}")))
        };
        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(load(MODELS[0])?),
            recognition_model: Some(load(MODELS[1])?),
            ..Default::default()
        })
        .map_err(engine_error)?;
        Ok(Self { engine })
    }

    /// The lines of text in a capture file, and the capture itself, for
    /// [`store_text`] to decode its codes from.
    pub fn read_capture(&self, png: &Path) -> OcrResult<(Vec<OcrLine>, RgbaImage)> {
        let image = image::open(png)?.into_rgba8();
        let lines = self.read_image(&image::DynamicImage::ImageRgba8(image.clone()).into_rgb8())?;
        Ok((lines, image))
    }

    /// The lines of text in an image already in memory, top to bottom, with
    /// their words and the boxes of both in the image's pixels. Read with
    /// the system's engine when there is one, else, or when it fails, with
    /// ocrs.
    pub fn read_image(&self, image: &image::RgbImage) -> OcrResult<Vec<OcrLine>> {
        let system = crate::ocr_vision::read(image)
            .map(|read| ("Vision", read))
            .or_else(|| crate::ocr_windows::read(image).map(|read| ("Windows OCR", read)));
        match system {
            Some((_, Ok(lines))) => return Ok(lines),
            Some((engine, Err(err))) => {
                eprintln!("Grab-it: {engine} could not read the text, reading it with ocrs: {err}");
            }
            None => {}
        }
        self.read_with_ocrs(image)
    }

    /// [`Ocr::read_image`] with ocrs alone.
    fn read_with_ocrs(&self, image: &image::RgbImage) -> OcrResult<Vec<OcrLine>> {
        let size = image.dimensions();
        let source = ImageSource::from_bytes(image.as_raw(), size).map_err(engine_error)?;
        let input = self.engine.prepare_input(source).map_err(engine_error)?;
        let words = self.engine.detect_words(&input).map_err(engine_error)?;
        let lines = self.engine.find_text_lines(&input, &words);
        let lines = self
            .engine
            .recognize_text(&input, &lines)
            .map_err(engine_error)?
            .into_iter()
            .flatten()
            .filter_map(|line| {
                let text = line.to_string().trim().to_owned();
                // Single characters are mostly noise (icons, borders).
                (text.chars().count() > 1).then(|| OcrLine {
                    text,
                    rect: clamped(&line, size),
                    words: line
                        .words()
                        .map(|word| OcrWord {
                            text: word.to_string(),
                            rect: clamped(&word, size),
                        })
                        .collect(),
                })
            })
            .collect();
        Ok(lines)
    }
}

/// A line of text OCR read, with its box and its words. Stored as JSON in
/// the library's `ocr_words` column; mirrors `OcrLine` in
/// src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    /// The line's axis-aligned box in the image's pixels.
    #[serde(flatten)]
    pub rect: Rect,
    pub words: Vec<OcrWord>,
}

/// A word in an [`OcrLine`]. Mirrors `OcrWord` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    /// The word's axis-aligned box in the image's pixels.
    #[serde(flatten)]
    pub rect: Rect,
}

/// The bounding box of an ocrs line or word, clipped to an image of
/// `size`: empty, at the nearest edge, when it lies wholly outside.
fn clamped(item: &impl TextItem, (width, height): (u32, u32)) -> Rect {
    let rect = item.bounding_rect();
    let clamp_x = |x: i32| x.clamp(0, i32::try_from(width).unwrap_or(i32::MAX));
    let clamp_y = |y: i32| y.clamp(0, i32::try_from(height).unwrap_or(i32::MAX));
    let (left, right) = (clamp_x(rect.left()), clamp_x(rect.right()));
    let (top, bottom) = (clamp_y(rect.top()), clamp_y(rect.bottom()));
    Rect {
        x: left,
        y: top,
        width: right.saturating_sub(left).max(0).unsigned_abs(),
        height: bottom.saturating_sub(top).max(0).unsigned_abs(),
    }
}

struct MergedLine {
    text: String,
    rect: Rect,
    boxed: bool,
    on_multi_item_row: bool,
}

/// The plain text of `lines`, reconstructing layout from bounding boxes when
/// present: horizontally split same-baseline fragments are rejoined, paragraph
/// gaps (> 1.5x line height) and column resets emit a blank line, indentation
/// is reconstructed from line `x` offsets, and malformed ellipses (`…..`) are
/// normalised to `…`. Lines with `width == 0 || height == 0` are treated as
/// unboxed and joined with plain newlines.
pub fn lines_text(lines: &[OcrLine]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let is_boxed = |line: &OcrLine| line.rect.width > 0 && line.rect.height > 0;
    if !lines.iter().any(is_boxed) {
        return lines
            .iter()
            .map(|line| normalise_ellipses(&line.text))
            .collect::<Vec<_>>()
            .join("\n");
    }

    // Pass 1: merge horizontally split same-baseline fragments while leaving
    // spaced controls (buttons, toolbar items) and unboxed lines separate.
    let mut merged: Vec<MergedLine> = Vec::with_capacity(lines.len());
    for line in lines {
        let text = normalise_ellipses(&line.text);
        let boxed = is_boxed(line);
        if boxed
            && let Some(prev) = merged.last_mut()
            && prev.boxed
            && should_merge_fragments(&prev.rect, &line.rect)
        {
            if !prev.text.is_empty()
                && !text.is_empty()
                && !prev.text.ends_with(char::is_whitespace)
                && !text.starts_with(char::is_whitespace)
            {
                prev.text.push(' ');
            }
            prev.text.push_str(&text);
            prev.rect = union_rect(prev.rect, line.rect);
            continue;
        }
        merged.push(MergedLine {
            text,
            rect: line.rect,
            boxed,
            on_multi_item_row: false,
        });
    }

    // Pass 2: mark distinct lines that share a horizontal row (e.g. button
    // bars) and segment into blocks at paragraph gaps (> 1.5x line height) or
    // column resets (y jumping upward).
    let mut blocks: Vec<Vec<MergedLine>> = Vec::new();
    let mut current: Vec<MergedLine> = Vec::new();
    for mut line in merged {
        let mut start_new_block = false;
        if let Some(prev) = current.last_mut()
            && prev.boxed
            && line.boxed
        {
            if same_baseline(&prev.rect, &line.rect) {
                prev.on_multi_item_row = true;
                line.on_multi_item_row = true;
            } else {
                let ref_h = i64::from(prev.rect.height.max(line.rect.height));
                let prev_cy2 = 2 * i64::from(prev.rect.y) + i64::from(prev.rect.height);
                let line_cy2 = 2 * i64::from(line.rect.y) + i64::from(line.rect.height);
                let column_reset = line_cy2 < prev_cy2;
                let prev_bottom = i64::from(prev.rect.y) + i64::from(prev.rect.height);
                let gap = i64::from(line.rect.y) - prev_bottom;
                let paragraph_gap = 2 * gap > 3 * ref_h;
                start_new_block = column_reset || paragraph_gap;
            }
        }
        if start_new_block && !current.is_empty() {
            blocks.push(current);
            current = Vec::new();
        }
        current.push(line);
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    // Pass 3: reconstruct indentation from x offsets within each block.
    let mut formatted_blocks: Vec<String> = Vec::with_capacity(blocks.len());
    for block in blocks {
        let indent_candidates: Vec<&MergedLine> = block
            .iter()
            .filter(|l| l.boxed && !l.on_multi_item_row)
            .collect();
        let (base_x, char_w) = if indent_candidates.len() >= 2 {
            let min_x = indent_candidates
                .iter()
                .map(|l| l.rect.x)
                .min()
                .unwrap_or(0);
            let cw = estimate_char_width(&indent_candidates);
            (min_x, cw)
        } else {
            (0, None)
        };

        let mut out_lines: Vec<String> = Vec::with_capacity(block.len());
        for line in block {
            if line.boxed
                && !line.on_multi_item_row
                && let Some(cw) = char_w
            {
                let delta = (line.rect.x - base_x).max(0) as f32;
                let spaces = if delta >= cw * 0.75 {
                    (delta / cw).round().min(64.0) as usize
                } else {
                    0
                };
                if spaces > 0 {
                    let mut indented = String::with_capacity(spaces + line.text.len());
                    for _ in 0..spaces {
                        indented.push(' ');
                    }
                    indented.push_str(&line.text);
                    out_lines.push(indented);
                    continue;
                }
            }
            out_lines.push(line.text);
        }
        formatted_blocks.push(out_lines.join("\n"));
    }

    formatted_blocks.join("\n\n")
}

/// Whether `a` and `b` lie on the same visual text baseline (their vertical
/// spans overlap by at least half the shorter line's height).
fn same_baseline(a: &Rect, b: &Rect) -> bool {
    let a_bottom = i64::from(a.y) + i64::from(a.height);
    let b_bottom = i64::from(b.y) + i64::from(b.height);
    let overlap = (a_bottom.min(b_bottom) - i64::from(a.y.max(b.y))).max(0);
    let min_h = i64::from(a.height.min(b.height));
    min_h > 0 && overlap * 2 >= min_h
}

/// Whether `next` is a horizontally split continuation of `prev` on the same
/// baseline rather than a distinct spaced button or toolbar item.
fn should_merge_fragments(prev: &Rect, next: &Rect) -> bool {
    if !same_baseline(prev, next) {
        return false;
    }
    let prev_right = i64::from(prev.x) + i64::from(prev.width);
    let next_right = i64::from(next.x) + i64::from(next.width);
    if next.x < prev.x || next_right <= prev_right {
        return false;
    }
    let avg_h = (f64::from(prev.height) + f64::from(next.height)) * 0.5;
    let gap = (i64::from(next.x) - prev_right) as f64;
    gap >= -(avg_h * 0.5) && gap <= avg_h * 1.1
}

/// Smallest box containing both `a` and `b`.
fn union_rect(a: Rect, b: Rect) -> Rect {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    let right = (i64::from(a.x) + i64::from(a.width)).max(i64::from(b.x) + i64::from(b.width));
    let bottom = (i64::from(a.y) + i64::from(a.height)).max(i64::from(b.y) + i64::from(b.height));
    Rect {
        x: left,
        y: top,
        width: (right - i64::from(left)).max(0) as u32,
        height: (bottom - i64::from(top)).max(0) as u32,
    }
}

/// Estimates one character's width in pixels for a block of boxed lines using
/// the median per-character width of its multi-character lines.
fn estimate_char_width(lines: &[&MergedLine]) -> Option<f32> {
    let mut widths: Vec<f32> = lines
        .iter()
        .filter_map(|line| {
            let chars = line.text.chars().count();
            (chars >= 4 && line.rect.width > 0).then(|| line.rect.width as f32 / chars as f32)
        })
        .collect();
    if widths.is_empty() {
        widths = lines
            .iter()
            .filter_map(|line| {
                let chars = line.text.chars().count();
                (chars >= 1 && line.rect.width > 0).then(|| line.rect.width as f32 / chars as f32)
            })
            .collect();
    }
    if widths.is_empty() {
        return None;
    }
    widths.sort_by(f32::total_cmp);
    let median = widths[widths.len() / 2];
    (median.is_finite() && median > 0.0).then_some(median)
}

/// Collapses malformed ellipsis sequences that mix `…` with extra dots or
/// ellipses (such as `…..` -> `…`) while leaving plain ASCII `...` and `..`
/// unchanged.
fn normalise_ellipses(text: &str) -> String {
    if !text.contains('\u{2026}') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '.' || ch == '\u{2026}' {
            let mut run = String::new();
            let mut has_ellipsis = ch == '\u{2026}';
            run.push(ch);
            while let Some(&next) = chars.peek() {
                if next == '.' || next == '\u{2026}' {
                    if next == '\u{2026}' {
                        has_ellipsis = true;
                    }
                    run.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if has_ellipsis {
                out.push('\u{2026}');
            } else {
                out.push_str(&run);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// `text` with the values of `codes` after it, one per line, as the
/// library stores a capture's text: search then finds a capture by what
/// its codes hold, and the Library's Copy text includes them. Just the
/// values when there is no text, and `text` alone when there are no codes.
pub fn with_codes(text: &str, codes: &[Code]) -> String {
    let values = codes::values(codes);
    if values.is_empty() {
        text.to_owned()
    } else if text.trim().is_empty() {
        values
    } else {
        format!("{}\n{values}", text.trim_end())
    }
}

/// Stores `lines`, read from `image`, as the text and word boxes of shot
/// `id`, then decodes the codes in `image` and, when it holds any, stores
/// the text again with their values ([`with_codes`]). Returns the text
/// stored.
///
/// The plain text is stored before decoding on purpose: release builds
/// abort on a panic, so a capture that crashes rxing is by then already
/// read, and the OCR queue does not pick it up and crash again on every
/// launch. That capture is only missing its codes.
pub fn store_text(
    library: &LibraryState,
    id: i64,
    lines: &[OcrLine],
    image: &RgbaImage,
) -> LibraryResult<String> {
    library.lock().set_ocr_lines(id, lines)?;
    let text = lines_text(lines);
    let codes = codes::decode(image);
    if codes.is_empty() {
        return Ok(text);
    }
    let full = with_codes(&text, &codes);
    library.lock().set_ocr_text(id, &full)?;
    Ok(full)
}

/// What the OCR queue is doing. Mirrors `OcrStatus` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum OcrStatus {
    /// Nothing waits for OCR.
    Idle,
    /// Captures are being read; `pending` counts the one being read too.
    Working { pending: u32 },
    /// The models could not be loaded, so the install is damaged. The next
    /// capture tries again.
    Failed { message: String },
}

/// The OCR queue, managed as Tauri state.
pub struct OcrState {
    wake: Mutex<Sender<()>>,
    status: Mutex<OcrStatus>,
}

impl OcrState {
    fn new(wake: Sender<()>) -> Self {
        Self {
            wake: Mutex::new(wake),
            status: Mutex::new(OcrStatus::Idle),
        }
    }

    pub fn status(&self) -> OcrStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn wake(&self) {
        let _ = self
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(());
    }
}

/// How often a waiting OCR job checks whether the capture overlay closed.
const OVERLAY_POLL: Duration = Duration::from_millis(100);

/// Starts the OCR thread. It reads every capture waiting for OCR, then
/// sleeps until [`wake`] is called.
pub fn start(app: &AppHandle, models: PathBuf) {
    let (sender, receiver) = mpsc::channel();
    app.manage(OcrState::new(sender));
    app.manage(TextOcr::new(models.clone()));
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("grab-it-ocr".into())
        .spawn(move || run(&app, &models, &receiver));
    if let Err(err) = spawned {
        eprintln!("Grab-it: could not start OCR: {err}");
    }
}

/// The engine behind "Capture text", loaded the first time it is used and
/// kept: the library's OCR thread owns its own engine and may be busy with
/// a long queue, and a text capture should not wait behind it.
pub struct TextOcr {
    models: PathBuf,
    engine: Mutex<Option<Arc<Ocr>>>,
}

impl TextOcr {
    pub fn new(models: PathBuf) -> Self {
        Self {
            models,
            engine: Mutex::new(None),
        }
    }
}

/// Reads the lines of text in `image` right now, loading the models first
/// when this is the first text capture since Grab-it started.
pub fn read_now(app: &AppHandle, image: &image::RgbaImage) -> OcrResult<Vec<OcrLine>> {
    let state = app.state::<TextOcr>();
    let engine = {
        let mut slot = state
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match slot.as_ref() {
            Some(engine) => Arc::clone(engine),
            None => {
                let engine = Arc::new(Ocr::load(&state.models)?);
                *slot = Some(Arc::clone(&engine));
                engine
            }
        }
    };
    let rgb = image::DynamicImage::ImageRgba8(image.clone()).into_rgb8();
    engine.read_image(&rgb)
}

/// Tells the OCR thread that captures may be waiting.
pub fn wake(app: &AppHandle) {
    if let Some(state) = app.try_state::<OcrState>() {
        state.wake();
    }
}

fn set_status(app: &AppHandle, status: OcrStatus) {
    let Some(state) = app.try_state::<OcrState>() else {
        return;
    };
    {
        let mut current = state
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == status {
            return;
        }
        *current = status.clone();
    }
    let _ = app.emit(OCR_STATUS_EVENT, status);
}

/// Blocks until woken. False once nothing can wake the thread any more.
fn wait(receiver: &Receiver<()>) -> bool {
    if receiver.recv().is_err() {
        return false;
    }
    // Several wakes while busy need only one more pass.
    while receiver.try_recv().is_ok() {}
    true
}

fn run(app: &AppHandle, models: &Path, receiver: &Receiver<()>) {
    let mut engine: Option<Ocr> = None;
    loop {
        let library = app.state::<LibraryState>();
        let next = library.lock().next_for_ocr();
        let job = match next {
            Ok(Some(job)) => job,
            Ok(None) => {
                set_status(app, OcrStatus::Idle);
                if !wait(receiver) {
                    return;
                }
                continue;
            }
            Err(err) => {
                eprintln!("Grab-it: could not read the OCR queue: {err}");
                set_status(app, OcrStatus::Idle);
                if !wait(receiver) {
                    return;
                }
                continue;
            }
        };

        if engine.is_none() {
            match Ocr::load(models) {
                Ok(ocr) => engine = Some(ocr),
                Err(err) => {
                    eprintln!("Grab-it: {err}");
                    set_status(
                        app,
                        OcrStatus::Failed {
                            message: err.to_string(),
                        },
                    );
                    if !wait(receiver) {
                        return;
                    }
                    continue;
                }
            }
        }
        let Some(ocr) = engine.as_ref() else {
            continue;
        };
        // A capture overlay is up: reading text would take the processor
        // from it while the user is selecting, so wait until it closes.
        while crate::overlay::is_open(app) {
            thread::sleep(OVERLAY_POLL);
        }

        let pending = library.lock().pending_ocr_count().unwrap_or(1);
        set_status(app, OcrStatus::Working { pending });
        // The library is not locked while OCR runs, so the windows stay
        // responsive.
        let read = ocr.read_capture(&job.path);
        let saved = match read {
            Ok((lines, image)) => store_text(&library, job.id, &lines, &image).map(|_| ()),
            Err(err) => {
                eprintln!("Grab-it: could not OCR {}: {err}", job.path.display());
                library.lock().mark_ocr_failed(job.id)
            }
        };
        match saved {
            Ok(()) => {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
                // The capture can now be described.
                crate::ai::wake(app);
            }
            // Deleted while it was being read.
            Err(crate::library::LibraryError::NotFound(_)) => {}
            Err(err) => {
                // Do not spin on a database that refuses writes.
                eprintln!("Grab-it: could not store OCR text: {err}");
                set_status(app, OcrStatus::Idle);
                if !wait(receiver) {
                    return;
                }
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn ocr_status(state: State<'_, OcrState>) -> OcrStatus {
    state.status()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::OnceLock;

    /// The fixture's only text; it appears nowhere in its metadata.
    pub const FIXTURE_WORD: &str = "pineapple";

    /// A 640×160 PNG reading "Order pineapple today", made with ImageMagick:
    /// `convert -size 640x160 xc:white -font DejaVu-Sans -pointsize 40
    /// -fill black -gravity center -annotate +0+0 'Order pineapple today'
    /// -strip -define png:exclude-chunks=date,time,tIME -type Grayscale`.
    pub fn fixture_png() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-pineapple.png")
    }

    /// The models as the app bundles them.
    pub fn bundled_models_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(MODELS_DIR)
    }

    /// One engine shared by every test, loaded from the bundled models.
    pub fn engine() -> &'static Ocr {
        static ENGINE: OnceLock<Ocr> = OnceLock::new();
        ENGINE.get_or_init(|| Ocr::load(&bundled_models_dir()).expect("load the ocrs models"))
    }

    #[test]
    fn models_dir_defaults_to_the_resource_dir() {
        if std::env::var_os(MODELS_DIR_ENV).is_none() {
            assert_eq!(
                models_dir(Path::new("/resources")),
                Path::new("/resources").join(MODELS_DIR)
            );
        }
    }

    /// The SHA-256 of each bundled model, as published by the ocrs project.
    /// Also listed in `ocr-models/LICENSE.md`.
    const MODEL_SHA256: [(&str, &str); 2] = [
        (
            "text-detection.onnx",
            "a917b23dbd9524b465df7e922641b3ff2981623df4ded5a0234004ef2fee7cfe",
        ),
        (
            "text-recognition.onnx",
            "86c145c2edb96c8caed5b1ebb8f44d706408922211451c309c625157dd6061c5",
        ),
    ];

    #[test]
    fn the_bundled_models_match_their_checksums() {
        use sha2::{Digest, Sha256};
        assert_eq!(MODEL_SHA256.map(|(file, _)| file), MODELS);
        for (file, expected) in MODEL_SHA256 {
            let bytes = fs::read(bundled_models_dir().join(file)).unwrap();
            let actual: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(actual, expected, "{file}");
        }
    }

    #[test]
    fn the_bundle_ships_every_model_and_its_licence() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        for file in MODELS.into_iter().chain(["LICENSE.md"]) {
            let path = format!("{MODELS_DIR}/{file}");
            assert_eq!(resources[&path], path.as_str(), "bundle.resources");
        }
    }

    #[test]
    fn a_missing_model_is_a_model_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = Ocr::load(dir.path()).err().expect("no models to load");
        assert!(matches!(err, OcrError::Model(_)), "got {err:?}");
        assert!(err.to_string().contains("text-detection.onnx"), "{err}");
    }

    #[test]
    fn the_downloaded_models_are_removed() {
        let data = tempfile::TempDir::new().unwrap();
        let dir = data.path().join(MODELS_DIR);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "text-detection.onnx",
            "text-recognition.onnx",
            "text-recognition.onnx.part-123-0",
        ] {
            fs::write(dir.join(name), b"model").unwrap();
        }
        remove_downloaded_models(data.path());
        assert!(!dir.exists());
    }

    #[test]
    fn other_files_beside_the_downloaded_models_are_kept() {
        let data = tempfile::TempDir::new().unwrap();
        let dir = data.path().join(MODELS_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("text-detection.onnx"), b"model").unwrap();
        fs::write(dir.join("notes.txt"), b"mine").unwrap();
        remove_downloaded_models(data.path());
        assert!(!dir.join("text-detection.onnx").exists());
        assert!(dir.join("notes.txt").is_file());
        // Nothing to remove is fine too.
        remove_downloaded_models(&data.path().join("nowhere"));
    }

    #[test]
    fn ocrs_reads_the_fixture_word() {
        let image = image::open(fixture_png()).unwrap().into_rgb8();
        let text = lines_text(&engine().read_with_ocrs(&image).unwrap());
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "ocrs read {text:?}"
        );
    }

    #[test]
    fn ocr_reads_the_fixture_word() {
        let (lines, _) = engine().read_capture(&fixture_png()).unwrap();
        let text = lines_text(&lines);
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "OCR read {text:?}"
        );
    }

    #[test]
    fn the_fixture_word_has_a_box_between_its_neighbours() {
        let (lines, image) = engine().read_capture(&fixture_png()).unwrap();
        let words: Vec<&OcrWord> = lines.iter().flat_map(|line| &line.words).collect();
        let index = words
            .iter()
            .position(|word| word.text.to_lowercase() == FIXTURE_WORD)
            .unwrap_or_else(|| panic!("no word {FIXTURE_WORD:?} in {lines:?}"));
        assert!(
            index > 0 && index + 1 < words.len(),
            "{FIXTURE_WORD:?} is not between two words: {words:?}"
        );
        let (before, word, after) = (
            &words[index - 1].rect,
            &words[index].rect,
            &words[index + 1].rect,
        );

        let (width, height) = image.dimensions();
        assert!(word.width > 0 && word.height > 0, "{word:?}");
        assert!(word.x >= 0 && word.y >= 0, "{word:?}");
        assert!(word.x.unsigned_abs() + word.width <= width, "{word:?}");
        assert!(word.y.unsigned_abs() + word.height <= height, "{word:?}");

        assert!(
            before.x + before.width as i32 <= word.x,
            "{before:?} {word:?}"
        );
        assert!(word.x + word.width as i32 <= after.x, "{word:?} {after:?}");
        // The line's box holds all three.
        let line = lines
            .iter()
            .find(|line| line.words.iter().any(|w| w.rect == *word))
            .unwrap();
        assert!(line.rect.x <= before.x && line.rect.y <= word.y, "{line:?}");
        assert!(
            line.rect.x + line.rect.width as i32 >= after.x + after.width as i32,
            "{line:?}"
        );
    }

    #[test]
    fn lines_join_into_text_one_per_line() {
        assert_eq!(lines_text(&[]), "");
        assert_eq!(
            lines_text(&[line("Order pineapple"), line("today")]),
            "Order pineapple\ntoday"
        );
    }

    fn boxed_line(text: &str, x: i32, y: i32, width: u32, height: u32) -> OcrLine {
        let rect = Rect {
            x,
            y,
            width,
            height,
        };
        OcrLine {
            text: text.to_owned(),
            rect,
            words: vec![OcrWord {
                text: text.to_owned(),
                rect,
            }],
        }
    }

    #[test]
    fn lines_text_merges_split_same_baseline_fragments() {
        let lines = vec![
            boxed_line("if", 195, 227, 38, 27),
            boxed_line("!items.is_empty() {", 227, 225, 325, 39),
        ];
        assert_eq!(lines_text(&lines), "if !items.is_empty() {");
    }

    #[test]
    fn lines_text_keeps_spaced_button_labels_separate_and_unindented() {
        let lines = vec![
            boxed_line("Confirm & Save", 94, 490, 194, 26),
            boxed_line("Cancel (Esc)", 358, 491, 159, 27),
            boxed_line("More options…..", 587, 490, 188, 28),
            boxed_line(
                "Path: /Users/demo/notes — 3 items (100% synced)",
                64,
                550,
                625,
                34,
            ),
        ];
        assert_eq!(
            lines_text(&lines),
            "Confirm & Save\nCancel (Esc)\nMore options…\nPath: /Users/demo/notes — 3 items (100% synced)"
        );
    }

    #[test]
    fn lines_text_emits_blank_lines_for_paragraphs_and_columns() {
        let paragraphs = vec![
            boxed_line("First paragraph line one.", 69, 73, 1440, 32),
            boxed_line("First paragraph line two.", 69, 117, 931, 31),
            boxed_line("Second paragraph line one.", 69, 208, 1407, 37),
            boxed_line("Second paragraph line two.", 68, 253, 488, 32),
        ];
        assert_eq!(
            lines_text(&paragraphs),
            "First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph line one.\nSecond paragraph line two."
        );

        let columns = vec![
            boxed_line("Left Column Heading", 68, 68, 304, 36),
            boxed_line("First line on the left side.", 68, 130, 322, 31),
            boxed_line("Right Column Heading", 856, 73, 321, 31),
            boxed_line("First line on the right side.", 854, 133, 339, 29),
        ];
        assert_eq!(
            lines_text(&columns),
            "Left Column Heading\nFirst line on the left side.\n\nRight Column Heading\nFirst line on the right side."
        );

        // Two-line left column transitioning to a taller right-column heading.
        let tight_columns = vec![
            boxed_line("Left line one.", 68, 100, 260, 32),
            boxed_line("Left line two.", 68, 136, 260, 32),
            boxed_line("Right Heading", 856, 100, 260, 40),
            boxed_line("Right line two.", 856, 146, 260, 32),
        ];
        assert_eq!(
            lines_text(&tight_columns),
            "Left line one.\nLeft line two.\n\nRight Heading\nRight line two."
        );
    }

    #[test]
    fn lines_text_reconstructs_code_indentation_from_x_offsets() {
        let lines = vec![
            boxed_line("fn demo() {", 67, 70, 180, 33),
            boxed_line("let items = vec![1];", 99, 110, 320, 33),
            boxed_line("if !items.is_empty() {", 131, 150, 352, 33),
            boxed_line("return items;", 195, 190, 208, 33),
            boxed_line("}", 131, 230, 16, 33),
            boxed_line("}", 67, 270, 16, 33),
        ];
        assert_eq!(
            lines_text(&lines),
            "fn demo() {\n  let items = vec![1];\n    if !items.is_empty() {\n        return items;\n    }\n}"
        );
    }

    #[test]
    fn lines_text_normalises_malformed_ellipses_without_touching_ascii_dots() {
        assert_eq!(normalise_ellipses("More options….."), "More options…");
        assert_eq!(normalise_ellipses("Wait..…."), "Wait…");
        assert_eq!(normalise_ellipses("Check alerts..."), "Check alerts...");
        assert_eq!(normalise_ellipses("for i in 0..10"), "for i in 0..10");
        assert_eq!(lines_text(&[line("More options…..")]), "More options…");
    }

    #[test]
    fn lines_serialize_flat_and_camel_case() {
        let stored = OcrLine {
            text: "Hi there".into(),
            rect: Rect {
                x: 1,
                y: 2,
                width: 30,
                height: 4,
            },
            words: vec![OcrWord {
                text: "Hi".into(),
                rect: Rect {
                    x: 1,
                    y: 2,
                    width: 10,
                    height: 4,
                },
            }],
        };
        let json = serde_json::json!([{
            "text": "Hi there", "x": 1, "y": 2, "width": 30, "height": 4,
            "words": [{ "text": "Hi", "x": 1, "y": 2, "width": 10, "height": 4 }],
        }]);
        assert_eq!(serde_json::to_value([&stored]).unwrap(), json);
        assert_eq!(
            serde_json::from_value::<Vec<OcrLine>>(json).unwrap(),
            vec![stored]
        );
    }

    /// A line of `text` whose words have no boxes, for storing.
    pub fn line(text: &str) -> OcrLine {
        let rect = Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        OcrLine {
            text: text.to_owned(),
            rect,
            words: text
                .split(' ')
                .map(|word| OcrWord {
                    text: word.to_owned(),
                    rect,
                })
                .collect(),
        }
    }

    #[test]
    fn code_values_follow_the_text_one_per_line() {
        let qr = Code::new("QR code", "https://example.com/menu");
        let bar = Code::new("Code 128", "GRAB-IT 0043");
        assert_eq!(
            with_codes("Scan for the menu", &[qr.clone(), bar.clone()]),
            "Scan for the menu\nhttps://example.com/menu\nGRAB-IT 0043"
        );
        assert_eq!(
            with_codes("Scan for the menu\n", std::slice::from_ref(&qr)),
            "Scan for the menu\nhttps://example.com/menu"
        );
    }

    #[test]
    fn code_values_alone_when_there_is_no_text() {
        let codes = [
            Code::new("QR code", "first"),
            Code::new("Code 128", "second"),
        ];
        assert_eq!(with_codes("", &codes), "first\nsecond");
        assert_eq!(with_codes(" \n ", &codes), "first\nsecond");
    }

    #[test]
    fn text_is_unchanged_without_codes() {
        assert_eq!(
            with_codes("Order pineapple today", &[]),
            "Order pineapple today"
        );
        assert_eq!(with_codes("", &[]), "");
    }

    /// A library holding one capture, and its id.
    fn library_with_a_capture(dir: &Path) -> (LibraryState, i64) {
        let originals = dir.join(crate::capture::ORIGINALS_DIR);
        fs::create_dir_all(&originals).unwrap();
        let png = originals.join("Grab-it 2026-03-07 09-00-00.png");
        fs::copy(fixture_png(), &png).unwrap();
        let mut library = crate::library::Library::open_in_memory().unwrap();
        let id = library.add_capture(&png).unwrap().id;
        (LibraryState::new(library), id)
    }

    fn stored(library: &LibraryState, id: i64) -> crate::library::ShotText {
        library.lock().text(id).unwrap()
    }

    #[test]
    fn a_capture_is_stored_with_the_values_of_its_codes() {
        use crate::codes::tests::{canvas, draw};
        let dir = tempfile::TempDir::new().unwrap();
        let (library, id) = library_with_a_capture(dir.path());
        let mut image = canvas(400, 400);
        let qr = draw(
            "https://example.com/ticket",
            rxing::BarcodeFormat::QR_CODE,
            260,
            260,
        );
        image::imageops::overlay(&mut image, &qr, 70, 70);
        let text = store_text(&library, id, &[line("Your ticket")], &image).unwrap();
        assert_eq!(text, "Your ticket\nhttps://example.com/ticket");
        assert_eq!(
            stored(&library, id),
            crate::library::ShotText::Read { text }
        );
        // The boxes are OCR's alone; codes have none.
        assert_eq!(
            library.lock().lines(id).unwrap(),
            Some(vec![line("Your ticket")])
        );
    }

    #[test]
    fn a_capture_without_codes_is_stored_with_its_text_alone() {
        use crate::codes::tests::canvas;
        let dir = tempfile::TempDir::new().unwrap();
        let (library, id) = library_with_a_capture(dir.path());
        let lines = [line("Order pineapple today")];
        let text = store_text(&library, id, &lines, &canvas(300, 200)).unwrap();
        assert_eq!(text, "Order pineapple today");
        assert_eq!(
            stored(&library, id),
            crate::library::ShotText::Read { text }
        );
        assert_eq!(library.lock().lines(id).unwrap(), Some(lines.to_vec()));
    }

    #[test]
    fn a_deleted_capture_is_not_decoded() {
        use crate::codes::tests::canvas;
        let library = LibraryState::new(crate::library::Library::open_in_memory().unwrap());
        assert!(matches!(
            store_text(&library, 42, &[line("gone")], &canvas(10, 10)),
            Err(crate::library::LibraryError::NotFound(42))
        ));
    }

    #[test]
    fn a_blank_image_has_no_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let blank = dir.path().join("blank.png");
        image::RgbImage::from_pixel(200, 80, image::Rgb([255, 255, 255]))
            .save(&blank)
            .unwrap();
        assert_eq!(engine().read_capture(&blank).unwrap().0, vec![]);
    }

    #[test]
    fn a_missing_image_is_an_image_error() {
        let missing = Path::new(env!("CARGO_MANIFEST_DIR")).join("no-such-capture.png");
        assert!(matches!(
            engine().read_capture(&missing),
            Err(OcrError::Image(_))
        ));
    }

    #[test]
    fn statuses_serialize_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(OcrStatus::Working { pending: 3 }).unwrap(),
            serde_json::json!({ "state": "working", "pending": 3 })
        );
        assert_eq!(
            serde_json::to_value(OcrStatus::Idle).unwrap(),
            serde_json::json!({ "state": "idle" })
        );
    }
}
