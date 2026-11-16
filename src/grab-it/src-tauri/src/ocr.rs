//! OCR of captures with [ocrs](https://github.com/robertknight/ocrs).
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

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use image::RgbaImage;

use crate::{
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

    /// The text in a capture file, one line of text per line, and the
    /// capture itself, for [`store_text`] to decode its codes from.
    pub fn read_capture(&self, png: &Path) -> OcrResult<(String, RgbaImage)> {
        let image = image::open(png)?.into_rgba8();
        let text = self.read_image(&image::DynamicImage::ImageRgba8(image.clone()).into_rgb8())?;
        Ok((text, image))
    }

    /// The text in an image already in memory, one line of text per line.
    pub fn read_image(&self, image: &image::RgbImage) -> OcrResult<String> {
        let source =
            ImageSource::from_bytes(image.as_raw(), image.dimensions()).map_err(engine_error)?;
        let input = self.engine.prepare_input(source).map_err(engine_error)?;
        let words = self.engine.detect_words(&input).map_err(engine_error)?;
        let lines = self.engine.find_text_lines(&input, &words);
        let text = self
            .engine
            .recognize_text(&input, &lines)
            .map_err(engine_error)?
            .into_iter()
            .flatten()
            .map(|line| line.to_string().trim().to_owned())
            // Single characters are mostly noise (icons, borders).
            .filter(|line| line.chars().count() > 1)
            .collect::<Vec<_>>()
            .join("\n");
        Ok(text)
    }
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

/// Stores `text`, read from `image`, as the text of shot `id`, then decodes
/// the codes in `image` and, when it holds any, stores the text again with
/// their values ([`with_codes`]). Returns what is stored.
///
/// The plain text is stored before decoding on purpose: release builds
/// abort on a panic, so a capture that crashes rxing is by then already
/// read, and the OCR queue does not pick it up and crash again on every
/// launch. That capture is only missing its codes.
pub fn store_text(
    library: &LibraryState,
    id: i64,
    text: &str,
    image: &RgbaImage,
) -> LibraryResult<String> {
    library.lock().set_ocr_text(id, text)?;
    let codes = codes::decode(image);
    if codes.is_empty() {
        return Ok(text.to_owned());
    }
    let full = with_codes(text, &codes);
    library.lock().set_ocr_text(id, &full)?;
    Ok(full)
}

/// What the OCR queue is doing. Mirrors `OcrStatus` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// Reads the text in `image` right now, loading the models first when this
/// is the first text capture since Grab-it started.
pub fn read_now(app: &AppHandle, image: &image::RgbaImage) -> OcrResult<String> {
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
            Ok((text, image)) => store_text(&library, job.id, &text, &image).map(|_| ()),
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
    fn ocr_reads_the_fixture_word() {
        let (text, _) = engine().read_capture(&fixture_png()).unwrap();
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "OCR read {text:?}"
        );
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
        let text = store_text(&library, id, "Your ticket", &image).unwrap();
        assert_eq!(text, "Your ticket\nhttps://example.com/ticket");
        assert_eq!(
            stored(&library, id),
            crate::library::ShotText::Read { text }
        );
    }

    #[test]
    fn a_capture_without_codes_is_stored_with_its_text_alone() {
        use crate::codes::tests::canvas;
        let dir = tempfile::TempDir::new().unwrap();
        let (library, id) = library_with_a_capture(dir.path());
        let text = store_text(&library, id, "Order pineapple today", &canvas(300, 200)).unwrap();
        assert_eq!(text, "Order pineapple today");
        assert_eq!(
            stored(&library, id),
            crate::library::ShotText::Read { text }
        );
    }

    #[test]
    fn a_deleted_capture_is_not_decoded() {
        use crate::codes::tests::canvas;
        let library = LibraryState::new(crate::library::Library::open_in_memory().unwrap());
        assert!(matches!(
            store_text(&library, 42, "gone", &canvas(10, 10)),
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
        assert_eq!(engine().read_capture(&blank).unwrap().0, "");
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
