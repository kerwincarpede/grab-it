//! OCR of captures with [ocrs](https://github.com/robertknight/ocrs).
//!
//! The two ocrs models are not shipped with Grab-it: they are downloaded
//! into `ocr-models/` in the app data directory the first time a capture
//! needs OCR, with progress shown in the Library. One background thread
//! then reads the text of every capture waiting for OCR, newest first and
//! one at a time, and stores it in the library, where the full-text index
//! picks it up.

use std::{
    fmt, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::library::{LIBRARY_CHANGED_EVENT, LibraryState};

/// Where the models live, under the app data directory.
pub const MODELS_DIR: &str = "ocr-models";
/// Overrides the models directory, for tests and CI caches.
pub const MODELS_DIR_ENV: &str = "GRAB_IT_OCR_MODELS";
/// Emitted with an [`OcrStatus`] whenever the OCR queue changes state.
pub const OCR_STATUS_EVENT: &str = "ocr-status";

/// How long the model download may wait to resolve the host, connect, or
/// for any single read or write before it gives up. A stalled connection
/// (Wi-Fi drop, sleep, hung proxy) then fails the download, so the Library
/// offers Retry instead of waiting forever.
pub const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// One ocrs model file.
#[derive(Debug, Clone, Copy)]
pub struct ModelFile {
    pub file: &'static str,
    pub url: &'static str,
    /// Expected size in bytes, for download progress.
    pub size: u64,
}

/// The ocrs models, as published by the ocrs project (see its
/// `ocrs/examples/download-models.sh`).
pub const MODELS: [ModelFile; 2] = [
    ModelFile {
        file: "text-detection.onnx",
        url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.onnx",
        size: 2_499_479,
    },
    ModelFile {
        file: "text-recognition.onnx",
        url: "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.onnx",
        size: 9_713_177,
    },
];

#[derive(Debug)]
pub enum OcrError {
    /// A model could not be downloaded.
    Download(String),
    Io(io::Error),
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
            Self::Download(err) => {
                write!(f, "could not download the text recognition models: {err}")
            }
            Self::Io(err) => write!(f, "{err}"),
            Self::Model(err) => write!(f, "could not load the text recognition models: {err}"),
            Self::Image(err) => write!(f, "could not read the capture: {err}"),
            Self::Engine(err) => write!(f, "text recognition failed: {err}"),
        }
    }
}

impl std::error::Error for OcrError {}

impl From<io::Error> for OcrError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

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

/// The models directory: `$GRAB_IT_OCR_MODELS` when set, else
/// `ocr-models/` in the app data directory.
pub fn models_dir(app_data: &Path) -> PathBuf {
    match std::env::var_os(MODELS_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => app_data.join(MODELS_DIR),
    }
}

/// Downloads the models missing from `dir`. `progress` gets the bytes
/// downloaded so far and the total expected. Each file is written beside
/// its final name and renamed when complete, so a cut-off download is never
/// mistaken for a model.
pub fn download_models(dir: &Path, progress: impl FnMut(u64, u64)) -> OcrResult<()> {
    download_models_from(&download_agent(DOWNLOAD_STALL_TIMEOUT), dir, progress)
}

/// An HTTP agent whose every network phase gives up after `stall`
/// without progress. ureq has no timeouts by default.
fn download_agent(stall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_resolve(Some(stall))
        .timeout_connect(Some(stall))
        .timeout_send_request(Some(stall))
        .timeout_recv_response(Some(stall))
        .timeout_per_read(Some(stall))
        .timeout_per_write(Some(stall))
        .build()
        .new_agent()
}

fn download_models_from(
    agent: &ureq::Agent,
    dir: &Path,
    mut progress: impl FnMut(u64, u64),
) -> OcrResult<()> {
    let missing: Vec<&ModelFile> = MODELS
        .iter()
        .filter(|model| !dir.join(model.file).is_file())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    let total: u64 = missing.iter().map(|model| model.size).sum();
    let mut done = 0;
    progress(0, total);
    // Unique per download, so parallel downloads (tests) never share one.
    static NEXT_PART: AtomicU64 = AtomicU64::new(0);
    for model in missing {
        let part = dir.join(format!(
            "{}.part-{}-{}",
            model.file,
            std::process::id(),
            NEXT_PART.fetch_add(1, Ordering::Relaxed)
        ));
        let result = download(agent, model.url, &part, |bytes| {
            progress((done + bytes).min(total), total);
        })
        .and_then(|bytes| {
            fs::rename(&part, dir.join(model.file))?;
            Ok(bytes)
        });
        match result {
            Ok(bytes) => done += bytes.min(model.size),
            Err(err) => {
                let _ = fs::remove_file(&part);
                return Err(err);
            }
        }
    }
    progress(total, total);
    Ok(())
}

/// Streams `url` into `to`, returning how many bytes were written.
fn download(
    agent: &ureq::Agent,
    url: &str,
    to: &Path,
    mut progress: impl FnMut(u64),
) -> OcrResult<u64> {
    let response = agent
        .get(url)
        .call()
        .map_err(|err| OcrError::Download(err.to_string()))?;
    let mut reader = response.into_body().into_reader();
    let mut out = fs::File::create(to)?;
    let mut buffer = vec![0; 64 * 1024];
    let mut written = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(OcrError::Download(err.to_string())),
        };
        out.write_all(&buffer[..read])?;
        written += read as u64;
        progress(written);
    }
    out.sync_all()?;
    if written == 0 {
        return Err(OcrError::Download(format!("{url} was empty")));
    }
    Ok(written)
}

/// A loaded ocrs engine.
pub struct Ocr {
    engine: OcrEngine,
}

impl Ocr {
    /// Loads the models from `dir`; they must have been downloaded.
    pub fn load(dir: &Path) -> OcrResult<Self> {
        let load = |model: &ModelFile| {
            Model::load_file(dir.join(model.file))
                .map_err(|err| OcrError::Model(format!("{}: {err}", model.file)))
        };
        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(load(&MODELS[0])?),
            recognition_model: Some(load(&MODELS[1])?),
            ..Default::default()
        })
        .map_err(engine_error)?;
        Ok(Self { engine })
    }

    /// The text in an image file, one line of text per line.
    pub fn read_text(&self, png: &Path) -> OcrResult<String> {
        self.read_image(&image::open(png)?.into_rgb8())
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

/// What the OCR queue is doing. Mirrors `OcrStatus` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum OcrStatus {
    /// Nothing waits for OCR.
    Idle,
    /// The models are being downloaded.
    Downloading { downloaded: u64, total: u64 },
    /// Captures are being read; `pending` counts the one being read too.
    Working { pending: u32 },
    /// The models could not be downloaded or loaded. Waiting captures are
    /// read after a retry or the next capture.
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

/// Reads the text in `image` right now, downloading the models first when
/// this is the first OCR on this machine.
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
                let engine = Arc::new(prepare(app, &state.models)?);
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
            match prepare(app, models) {
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

        let pending = library.lock().pending_ocr_count().unwrap_or(1);
        set_status(app, OcrStatus::Working { pending });
        // The library is not locked while OCR runs, so the windows stay
        // responsive.
        let text = ocr.read_text(&job.path);
        let saved = match text {
            Ok(text) => library.lock().set_ocr_text(job.id, &text),
            Err(err) => {
                eprintln!("Grab-it: could not OCR {}: {err}", job.path.display());
                library.lock().mark_ocr_failed(job.id)
            }
        };
        match saved {
            Ok(()) => {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
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

/// Downloads the models if needed, reporting progress, then loads them.
fn prepare(app: &AppHandle, models: &Path) -> OcrResult<Ocr> {
    let mut last_percent = None;
    download_models(models, |downloaded, total| {
        let percent = downloaded * 100 / total.max(1);
        if last_percent != Some(percent) {
            last_percent = Some(percent);
            set_status(app, OcrStatus::Downloading { downloaded, total });
        }
    })?;
    Ocr::load(models).inspect_err(|_| {
        // Most likely a damaged download: fetch fresh copies next time.
        for model in &MODELS {
            let _ = fs::remove_file(models.join(model.file));
        }
    })
}

#[tauri::command]
pub fn ocr_status(state: State<'_, OcrState>) -> OcrStatus {
    state.status()
}

/// Retries a failed model download and reads any waiting captures.
#[tauri::command]
pub fn ocr_retry(app: AppHandle) {
    // Cleared first so the same failure, if it happens again, is reported.
    set_status(&app, OcrStatus::Idle);
    wake(&app);
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

    /// Where tests keep the models between runs: `$GRAB_IT_OCR_MODELS`
    /// (cached in CI), else `target/ocr-models`.
    pub fn test_models_dir() -> PathBuf {
        match std::env::var_os(MODELS_DIR_ENV) {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(MODELS_DIR),
        }
    }

    /// One engine shared by every test, downloading the models once.
    pub fn engine() -> &'static Ocr {
        static ENGINE: OnceLock<Ocr> = OnceLock::new();
        ENGINE.get_or_init(|| {
            let dir = test_models_dir();
            download_models(&dir, |_, _| {}).expect("download the ocrs models");
            Ocr::load(&dir).expect("load the ocrs models")
        })
    }

    #[test]
    fn models_dir_defaults_to_the_app_data_dir() {
        if std::env::var_os(MODELS_DIR_ENV).is_none() {
            assert_eq!(
                models_dir(Path::new("/data")),
                Path::new("/data").join(MODELS_DIR)
            );
        }
    }

    #[test]
    fn ocr_reads_the_fixture_word() {
        let text = engine().read_text(&fixture_png()).unwrap();
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "OCR read {text:?}"
        );
        for model in &MODELS {
            assert!(test_models_dir().join(model.file).is_file());
        }
    }

    #[test]
    fn a_blank_image_has_no_text() {
        let dir = tempfile::TempDir::new().unwrap();
        let blank = dir.path().join("blank.png");
        image::RgbImage::from_pixel(200, 80, image::Rgb([255, 255, 255]))
            .save(&blank)
            .unwrap();
        assert_eq!(engine().read_text(&blank).unwrap(), "");
    }

    #[test]
    fn a_missing_image_is_an_image_error() {
        let missing = Path::new(env!("CARGO_MANIFEST_DIR")).join("no-such-capture.png");
        assert!(matches!(
            engine().read_text(&missing),
            Err(OcrError::Image(_))
        ));
    }

    /// Serves one connection: sends `reply`, then holds the connection
    /// open without sending anything more, like a stalled network.
    fn stalling_server(reply: &'static [u8]) -> (String, thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.onnx", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply);
            let _ = stream.flush();
            thread::sleep(Duration::from_secs(5));
        });
        (url, server)
    }

    fn assert_stalled_download_fails(reply: &'static [u8]) {
        let (url, server) = stalling_server(reply);
        let dir = tempfile::TempDir::new().unwrap();
        let part = dir.path().join("model.onnx.part");
        let started = std::time::Instant::now();
        let result = download(
            &download_agent(Duration::from_millis(300)),
            &url,
            &part,
            |_| {},
        );
        assert!(
            matches!(result, Err(OcrError::Download(_))),
            "got {result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        server.join().unwrap();
    }

    #[test]
    fn a_download_stalled_before_the_response_fails() {
        assert_stalled_download_fails(b"");
    }

    #[test]
    fn a_download_stalled_mid_body_fails() {
        assert_stalled_download_fails(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nonly a few bytes",
        );
    }

    #[test]
    fn statuses_serialize_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(OcrStatus::Downloading {
                downloaded: 5,
                total: 10
            })
            .unwrap(),
            serde_json::json!({ "state": "downloading", "downloaded": 5, "total": 10 })
        );
        assert_eq!(
            serde_json::to_value(OcrStatus::Idle).unwrap(),
            serde_json::json!({ "state": "idle" })
        );
    }
}
