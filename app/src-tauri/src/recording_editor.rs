//! The recording editor's backend: which MP4 each recording editor window
//! shows, serving it to the page, its edits sidecar, and exporting the
//! edited copy.
//!
//! The recording is never written here. Edits (trim, backdrop) live in
//! `<recording>.edits.json`; Export renders them into a new
//! `<name> (edited).mp4` beside the original. The page plays the recording
//! from the `grab-it-video` URI scheme ([`VIDEO_SCHEME`]), which serves only
//! MP4s in the recordings folder, a range at a time.
//!
//! On export the page paints the backdrop (fill and shadow) and a mask of
//! the video's rounded corners as PNGs at the output size. ffmpeg decodes
//! the trimmed frames as raw RGBA at the size the video takes on the
//! backdrop; each is laid over the backdrop through the mask ([`Composer`])
//! and piped into the same H.264 encoder recordings use. The trimmed sound
//! of the original is then added as AAC.

use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    ops::Deref,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::Duration,
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow,
    http::{Request, Response, StatusCode, header},
    ipc::InvokeBody,
};

use crate::{
    capture::sidecar_path,
    commands::{SettingsState, lock},
    editor::{EditorState, percent_decode},
    ffmpeg::{self, Video, VideoSpec},
    quick::{self, QuickItem},
    record::{RECORDINGS_DIR, cursor_path},
    settings::RecordingFormat,
};

/// The URI scheme the page plays recordings from. Mirrors `VIDEO_SCHEME` in
/// src/recording/api.ts.
pub const VIDEO_SCHEME: &str = "grab-it-video";
/// The edits sidecar format version this build reads and writes.
pub const EDITS_VERSION: u64 = 1;
/// Ends the name of the edits sidecar beside an MP4.
pub const EDITS_SUFFIX: &str = ".edits.json";
/// The request header carrying the export plan as URI-encoded JSON.
pub const EXPORT_PLAN_HEADER: &str = "x-recording-export";
/// Emitted to the exporting window with an [`ExportProgress`].
pub const EXPORT_PROGRESS_EVENT: &str = "recording-export-progress";
/// The most bytes one ranged request is answered with, so a long recording
/// is never read into memory whole.
pub const MAX_CHUNK: u64 = 4 * 1024 * 1024;
/// The frame rate assumed for a recording whose pointer sidecar is gone.
const DEFAULT_FPS: u32 = 30;
/// The largest side an export may have; the page keeps to 1920.
const MAX_EXPORT_SIDE: u32 = 4096;
/// The shortest clip an export may be.
const MIN_EXPORT_MS: u64 = 100;
/// How long adding the trimmed sound may take.
const MUX_TIMEOUT: Duration = Duration::from_secs(300);

/// The recording each recording editor window shows, by window label.
#[derive(Default)]
pub struct RecordingEditorState(EditorState);

impl Deref for RecordingEditorState {
    type Target = EditorState;

    fn deref(&self) -> &EditorState {
        &self.0
    }
}

/// The edits sidecar of a recording: `<name>.mp4` gives `<name>.edits.json`.
pub fn edits_path(video: &Path) -> PathBuf {
    sidecar_path(video, EDITS_SUFFIX)
}

/// Accepts `{version: 1, ...}` with an optional `trim` object holding
/// `startMs` and `endMs`; any other fields are kept as they are.
pub fn validate_edits(value: &Value) -> Result<(), String> {
    let version = value.get("version").and_then(Value::as_u64);
    if version != Some(EDITS_VERSION) {
        return Err(format!(
            "unsupported edits version {}",
            value.get("version").unwrap_or(&Value::Null)
        ));
    }
    match value.get("trim") {
        None | Some(Value::Null) => Ok(()),
        Some(trim) => {
            let ms = |key: &str| trim.get(key).and_then(Value::as_f64);
            match (ms("startMs"), ms("endMs")) {
                (Some(start), Some(end)) if start >= 0.0 && end > start => Ok(()),
                _ => Err("the trim needs a startMs before its endMs".to_owned()),
            }
        }
    }
}

/// Reads `<recording>.edits.json`. A missing file is `Ok(None)`; an
/// unreadable or unknown sidecar is an error so it is never overwritten by
/// mistake.
pub fn read_edits(video: &Path) -> Result<Option<Value>, String> {
    let path = edits_path(video);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("could not parse {}: {err}", path.display()))?;
    validate_edits(&value)?;
    Ok(Some(value))
}

/// Writes the sidecar through a temporary file so a crash never leaves a
/// half-written one.
pub fn write_edits(video: &Path, edits: &Value) -> Result<(), String> {
    validate_edits(edits)?;
    let path = edits_path(video);
    let tmp = path.with_extension("json.tmp");
    let mut json = serde_json::to_string_pretty(edits).map_err(|err| err.to_string())?;
    json.push('\n');
    fs::write(&tmp, json)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|err| format!("could not save the edits: {err}"))
}

/// The frame rate a recording was made at, from its pointer sidecar, else
/// [`DEFAULT_FPS`].
pub fn recording_fps(video: &Path) -> u32 {
    fs::read(cursor_path(video))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("fps").and_then(Value::as_u64))
        .and_then(|fps| u32::try_from(fps).ok())
        .filter(|fps| (1..=240).contains(fps))
        .unwrap_or(DEFAULT_FPS)
}

/// Where an export of `original` goes: `<name> (edited).mp4` beside it, or
/// `<name> (edited 2).mp4` and so on when that is taken. Never the original.
pub fn edited_path(original: &Path) -> PathBuf {
    let stem = original
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Recording".to_owned());
    let mut counter = 1;
    loop {
        let name = match counter {
            1 => format!("{stem} (edited).mp4"),
            n => format!("{stem} (edited {n}).mp4"),
        };
        let path = original.with_file_name(name);
        if !path.exists() {
            return path;
        }
        counter += 1;
    }
}

/// Mirrors `RecordingInfo` in src/recording/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: PathBuf,
    pub file_name: String,
    /// The saved sidecar, or `None` when the recording has no edits yet.
    pub edits: Option<Value>,
    /// The frame rate it was recorded at.
    pub fps: u32,
}

#[tauri::command]
pub fn recording_info(
    window: WebviewWindow,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingInfo, String> {
    let path = state.path_for(window.label())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let edits = read_edits(&path)?;
    let fps = recording_fps(&path);
    Ok(RecordingInfo {
        path,
        file_name,
        edits,
        fps,
    })
}

#[tauri::command]
pub fn recording_save_edits(
    edits: Value,
    window: WebviewWindow,
    state: State<'_, RecordingEditorState>,
) -> Result<(), String> {
    let path = state.path_for(window.label())?;
    write_edits(&path, &edits)
}

// --- Serving the recording ------------------------------------------------

/// The file a `grab-it-video` request names, when it is an MP4 directly in
/// `recordings`. Both are compared by the files they name, so `..` and
/// symlinks cannot reach anything else.
pub fn allowed_video(recordings: &Path, requested: &Path) -> Option<PathBuf> {
    let is_mp4 = requested
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return None;
    }
    let folder = fs::canonicalize(recordings).ok()?;
    let file = fs::canonicalize(requested).ok()?;
    (file.is_file() && file.parent() == Some(folder.as_path())).then_some(file)
}

/// A `Range` header that cannot be met, answered with 416.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsatisfiable;

/// The bytes a `Range` header asks for, inclusive, in a file of `len`
/// bytes; `Ok(None)` means the whole file. An open-ended range is cut to
/// [`MAX_CHUNK`].
pub fn parse_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, Unsatisfiable> {
    let Some(header) = header else {
        return Ok(None);
    };
    let spec = header.trim().strip_prefix("bytes=").ok_or(Unsatisfiable)?;
    // Only the first range of a list is served.
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (start, end) = spec.split_once('-').ok_or(Unsatisfiable)?;
    let (start, end) = (start.trim(), end.trim());
    if len == 0 {
        return Err(Unsatisfiable);
    }
    let last = len - 1;
    let (from, to) = if start.is_empty() {
        // The last `end` bytes.
        let suffix: u64 = end.parse().map_err(|_| Unsatisfiable)?;
        if suffix == 0 {
            return Err(Unsatisfiable);
        }
        (len.saturating_sub(suffix), last)
    } else {
        let from: u64 = start.parse().map_err(|_| Unsatisfiable)?;
        let to = if end.is_empty() {
            from.saturating_add(MAX_CHUNK - 1)
        } else {
            end.parse().map_err(|_| Unsatisfiable)?
        };
        (from, to.min(last))
    };
    if from > last || from > to {
        return Err(Unsatisfiable);
    }
    Ok(Some((from, to)))
}

fn read_span(path: &Path, from: u64, to: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = vec![0; (to - from + 1) as usize];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_default()
}

/// Answers a request for `path` (already allowed), with `range` its
/// `Range` header: the whole file when it is small, else a part of it.
pub fn video_response(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let len = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => return plain(StatusCode::NOT_FOUND, "no such recording"),
    };
    let span = match parse_range(range, len) {
        Ok(Some(span)) => Some(span),
        // A player that asks for everything gets the start of a long file.
        Ok(None) if len > MAX_CHUNK => Some((0, MAX_CHUNK - 1)),
        Ok(None) => None,
        Err(Unsatisfiable) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap_or_default();
        }
    };
    let (from, to) = span.unwrap_or((0, len.saturating_sub(1)));
    let bytes = if len == 0 {
        Ok(Vec::new())
    } else {
        read_span(path, from, to)
    };
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(err) => {
            return plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("could not read the recording: {err}"),
            );
        }
    };
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, bytes.len())
        // The page draws frames into a canvas for the blurred backdrop.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let builder = match span {
        Some((from, to)) => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {from}-{to}/{len}")),
        None => builder.status(StatusCode::OK),
    };
    builder.body(bytes).unwrap_or_default()
}

/// The file a request's URI names: `grab-it-video://localhost/<path>`, or
/// `http://grab-it-video.localhost/<path>` on Windows, the path URI-encoded.
pub fn requested_path(uri_path: &str) -> Option<PathBuf> {
    let encoded = uri_path.strip_prefix('/').unwrap_or(uri_path);
    percent_decode(encoded)
        .ok()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Serves a `grab-it-video` request: MP4s in the current save folder's
/// recordings only.
pub fn serve_video(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let recordings = app
        .try_state::<SettingsState>()
        .map(|state| lock(&state).get().save_folder.join(RECORDINGS_DIR));
    let allowed = recordings.zip(requested_path(request.uri().path()));
    let Some(path) = allowed.and_then(|(folder, path)| allowed_video(&folder, &path)) else {
        return plain(StatusCode::FORBIDDEN, "not a recording");
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    video_response(&path, range)
}

// --- Exporting -------------------------------------------------------------

/// What an export makes, from the page. Mirrors `ExportPlan` in
/// src/recording/api.ts. Sizes are in output pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub start_ms: u64,
    pub end_ms: u64,
    /// The output's size, even both ways.
    pub width: u32,
    pub height: u32,
    /// Where the video's top-left corner goes, and the size it takes there.
    pub x: u32,
    pub y: u32,
    pub video_width: u32,
    pub video_height: u32,
    /// How many bytes of the body are the backdrop PNG; the rest is the
    /// mask PNG. 0, with an empty body, when there is no backdrop.
    pub backdrop_bytes: usize,
}

impl ExportPlan {
    /// Refuses a plan that could not be encoded or would not fit.
    pub fn check(&self) -> Result<(), String> {
        let even = |side: u32| side >= 2 && side % 2 == 0 && side <= MAX_EXPORT_SIDE;
        if !even(self.width) || !even(self.height) {
            return Err(format!(
                "the export size {}×{} is not an even size up to {MAX_EXPORT_SIDE}",
                self.width, self.height
            ));
        }
        if self.video_width == 0
            || self.video_height == 0
            || self.x.saturating_add(self.video_width) > self.width
            || self.y.saturating_add(self.video_height) > self.height
        {
            return Err("the video does not fit inside the export".to_owned());
        }
        if self.end_ms < self.start_ms.saturating_add(MIN_EXPORT_MS) {
            return Err("the trimmed recording is too short to export".to_owned());
        }
        Ok(())
    }

    pub fn duration(&self) -> Duration {
        Duration::from_millis(self.end_ms - self.start_ms)
    }

    /// How many frames the export holds at `fps`.
    pub fn frames(&self, fps: u32) -> u64 {
        ((self.end_ms - self.start_ms) * u64::from(fps)).div_ceil(1000)
    }
}

/// How far an export is, in frames. Mirrors `ExportProgress` in
/// src/recording/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExportProgress {
    pub done: u64,
    pub total: u64,
}

/// Seconds as ffmpeg takes them, to the millisecond.
fn seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// ffmpeg's arguments to decode `plan`'s stretch of `input` as raw RGBA
/// frames on stdout, scaled to the size the video takes in the export, at
/// a constant `fps`. Seeking before `-i` is exact when decoding.
pub fn decode_args(input: &Path, plan: &ExportPlan, fps: u32) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-ss"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(seconds(plan.start_ms).into());
    args.push("-i".into());
    args.push(input.as_os_str().to_owned());
    let mut push = |arg: &str| args.push(OsString::from(arg));
    push("-t");
    push(&seconds(plan.end_ms - plan.start_ms));
    for arg in ["-map", "0:v:0", "-an", "-vf"] {
        push(arg);
    }
    push(&format!(
        "scale={}:{}:flags=bicubic,fps={fps},format=rgba",
        plan.video_width, plan.video_height
    ));
    for arg in ["-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"] {
        push(arg);
    }
    args
}

/// ffmpeg's arguments to write `output` from the silent `video` with the
/// sound of `original` over `plan`'s stretch, as AAC. A recording without
/// sound gives a silent export (the `?` on its map).
pub fn trim_audio_args(
    video: &Path,
    original: &Path,
    plan: &ExportPlan,
    output: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(video.as_os_str().to_owned());
    args.push("-ss".into());
    args.push(seconds(plan.start_ms).into());
    args.push("-t".into());
    args.push(seconds(plan.end_ms - plan.start_ms).into());
    args.push("-i".into());
    args.push(original.as_os_str().to_owned());
    let mut push = |arg: &str| args.push(OsString::from(arg));
    for arg in [
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        ffmpeg::AUDIO_BITRATE,
        "-shortest",
        "-movflags",
        "+faststart",
    ] {
        push(arg);
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// Lays each decoded frame over the backdrop through the mask.
pub struct Composer {
    backdrop: RgbaImage,
    /// The mask's alpha, one byte per output pixel: how much of the video
    /// shows there.
    mask: Vec<u8>,
    plan: ExportPlan,
}

impl Composer {
    /// `backdrop` and `mask` must be the plan's output size.
    pub fn new(backdrop: RgbaImage, mask: &RgbaImage, plan: ExportPlan) -> Result<Self, String> {
        let size = (plan.width, plan.height);
        if backdrop.dimensions() != size || mask.dimensions() != size {
            return Err(format!(
                "the backdrop and mask must be {}×{}",
                plan.width, plan.height
            ));
        }
        let mask = mask.pixels().map(|pixel| pixel.0[3]).collect();
        Ok(Self {
            backdrop,
            mask,
            plan,
        })
    }

    /// The output frame for one decoded `frame`, `video_width` ×
    /// `video_height` RGBA. Video frames are opaque, so the result is too
    /// wherever the backdrop is.
    pub fn compose(&self, frame: &[u8]) -> RgbaImage {
        let mut out = self.backdrop.clone();
        let (width, vw, vh) = (
            self.plan.width as usize,
            self.plan.video_width as usize,
            self.plan.video_height as usize,
        );
        let (ox, oy) = (self.plan.x as usize, self.plan.y as usize);
        let pixels: &mut [u8] = &mut out;
        for row in 0..vh {
            let out_row = (oy + row) * width + ox;
            for col in 0..vw {
                let alpha = u32::from(self.mask[out_row + col]);
                if alpha == 0 {
                    continue;
                }
                let src = (row * vw + col) * 4;
                let dst = (out_row + col) * 4;
                if alpha == 255 {
                    pixels[dst..dst + 3].copy_from_slice(&frame[src..src + 3]);
                } else {
                    for channel in 0..3 {
                        let under = u32::from(pixels[dst + channel]);
                        let over = u32::from(frame[src + channel]);
                        pixels[dst + channel] =
                            ((over * alpha + under * (255 - alpha) + 127) / 255) as u8;
                    }
                }
                pixels[dst + 3] = 255;
            }
        }
        out
    }
}

/// Splits the export request's body into the backdrop and mask images.
fn backdrop_and_mask(
    body: &[u8],
    plan: &ExportPlan,
) -> Result<Option<(RgbaImage, RgbaImage)>, String> {
    if plan.backdrop_bytes == 0 {
        return Ok(None);
    }
    if plan.backdrop_bytes >= body.len() {
        return Err("the export is missing its mask".to_owned());
    }
    let (backdrop, mask) = body.split_at(plan.backdrop_bytes);
    let decode = |bytes: &[u8], what: &str| {
        image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .map(|image| image.into_rgba8())
            .map_err(|err| format!("could not read the {what}: {err}"))
    };
    Ok(Some((decode(backdrop, "backdrop")?, decode(mask, "mask")?)))
}

/// One export to render.
struct ExportJob<'a> {
    original: &'a Path,
    output: &'a Path,
    plan: ExportPlan,
    /// The backdrop and mask, or none for the video alone.
    layers: Option<(RgbaImage, RgbaImage)>,
    fps: u32,
    bits_per_pixel: f64,
}

/// Renders `job` with `ready`'s ffmpeg, calling `progress` as frames are
/// written. The silent video is written beside the output first and the
/// sound added from it, so the output only ever holds a finished export.
fn render(
    ready: &ffmpeg::Ready,
    job: ExportJob<'_>,
    mut progress: impl FnMut(ExportProgress),
) -> Result<(), String> {
    let ExportJob {
        original,
        output,
        plan,
        layers,
        fps,
        bits_per_pixel,
    } = job;
    let plan = &plan;
    let composer = layers
        .map(|(backdrop, mask)| Composer::new(backdrop, &mask, *plan))
        .transpose()?;
    // Without a backdrop the video fills the export by itself.
    if composer.is_none() && (plan.video_width, plan.video_height) != (plan.width, plan.height) {
        return Err("an export without a backdrop must be the video's size".to_owned());
    }
    let silent = sidecar_path(output, ".exporting.mp4");
    let result = (|| -> Result<(), String> {
        let spec = VideoSpec {
            input: (plan.width, plan.height),
            output: (plan.width, plan.height),
            fps,
            bits_per_pixel,
        };
        let mut video = Video::start(&ready.path, ready.encoder, &spec, &silent)
            .map_err(|err| err.to_string())?;
        let mut decoder = ffmpeg::command(&ready.path)
            .args(decode_args(original, plan, fps))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("could not start ffmpeg: {err}"))?;
        let stderr = decoder.stderr.take().map(|mut stderr| {
            thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            })
        });
        let mut stdout = decoder.stdout.take().ok_or("ffmpeg gave no frames")?;
        let total = plan.frames(fps);
        let frame_len = plan.video_width as usize * plan.video_height as usize * 4;
        let mut buffer = vec![0; frame_len];
        let mut done = 0;
        let mut last_percent = None;
        let decoded = loop {
            match stdout.read_exact(&mut buffer) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break Ok(()),
                Err(err) => break Err(format!("could not read the frames: {err}")),
            }
            let frame = match &composer {
                Some(composer) => composer.compose(&buffer),
                None => match RgbaImage::from_raw(plan.width, plan.height, buffer.clone()) {
                    Some(frame) => frame,
                    None => break Err("a frame was the wrong size".to_owned()),
                },
            };
            if let Err(err) = video.write(&frame) {
                break Err(err.to_string());
            }
            done += 1;
            let percent = (done * 100).checked_div(total).unwrap_or(100);
            if last_percent != Some(percent) {
                last_percent = Some(percent);
                progress(ExportProgress {
                    done: done.min(total),
                    total,
                });
            }
        };
        drop(stdout);
        let status = ffmpeg::wait_for(&mut decoder, Duration::from_secs(10));
        let said = stderr
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        decoded?;
        match status {
            Some(status) if status.success() => {}
            _ => {
                return Err(format!(
                    "ffmpeg could not read the recording: {}",
                    ffmpeg::last_line(&said).unwrap_or("it stopped")
                ));
            }
        }
        if done == 0 {
            return Err("the trimmed stretch holds no frames".to_owned());
        }
        video.finish().map_err(|err| err.to_string())?;
        ffmpeg::run(
            &ready.path,
            trim_audio_args(&silent, original, plan, output),
            MUX_TIMEOUT,
        )
        .map_err(|err| format!("could not add the sound: {err}"))
    })();
    let _ = fs::remove_file(&silent);
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

/// Exports the window's recording as the plan in the [`EXPORT_PLAN_HEADER`]
/// header says, with the backdrop and mask PNGs in the body. Saves
/// `<name> (edited).mp4` beside it, shows it on the Quick Access card, and
/// returns its path. Progress goes to the window as
/// [`EXPORT_PROGRESS_EVENT`].
#[tauri::command]
pub async fn recording_export(
    request: tauri::ipc::Request<'_>,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<PathBuf, String> {
    let original = state.path_for(window.label())?;
    let plan = request
        .headers()
        .get(EXPORT_PLAN_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("missing export plan")
        .and_then(|value| percent_decode(value).map_err(|_| "bad export plan"))?;
    let plan: ExportPlan =
        serde_json::from_str(&plan).map_err(|err| format!("bad export plan: {err}"))?;
    plan.check()?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => Vec::new(),
    };
    let Some(ready) = ffmpeg::ready(&app) else {
        ffmpeg::prepare_in_background(&app);
        return Err(
            "ffmpeg is not ready yet; see Settings → Recording, then export again".to_owned(),
        );
    };
    let label = window.label().to_owned();
    // Minutes of decoding and encoding: on a thread of its own, not the
    // async runtime's.
    tauri::async_runtime::spawn_blocking(move || {
        export(&app, &ready, &original, plan, &body, &label)
    })
    .await
    .map_err(|err| format!("the export stopped: {err}"))?
}

/// Renders `plan` of `original` beside it, then shows the export on the
/// Quick Access card. Returns its path.
fn export(
    app: &AppHandle,
    ready: &ffmpeg::Ready,
    original: &Path,
    plan: ExportPlan,
    body: &[u8],
    label: &str,
) -> Result<PathBuf, String> {
    let layers = backdrop_and_mask(body, &plan)?;
    let bits_per_pixel = app
        .try_state::<SettingsState>()
        .map(|state| lock(&state).get().recording.quality.bits_per_pixel())
        .unwrap_or_else(|| crate::settings::RecordingQuality::High.bits_per_pixel());
    let output = edited_path(original);
    let job = ExportJob {
        original,
        output: &output,
        plan,
        layers,
        fps: recording_fps(original),
        bits_per_pixel,
    };
    render(ready, job, |progress| {
        let _ = app.emit_to(
            EventTarget::webview_window(label),
            EXPORT_PROGRESS_EVENT,
            progress,
        );
    })?;
    let bytes = fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    quick::show(
        app,
        QuickItem::Recorded {
            file_name: output
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: output.clone(),
            duration_ms: plan.end_ms - plan.start_ms,
            bytes,
            format: RecordingFormat::Mp4,
            fallback: None,
        },
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use serde_json::json;

    fn strings(args: Vec<OsString>) -> String {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
            .join(" ")
    }

    const PLAN: ExportPlan = ExportPlan {
        start_ms: 1250,
        end_ms: 9500,
        width: 1080,
        height: 1920,
        x: 60,
        y: 656,
        video_width: 960,
        video_height: 540,
        backdrop_bytes: 10,
    };

    #[test]
    fn the_edits_sidecar_sits_beside_the_video() {
        assert_eq!(
            edits_path(Path::new(
                "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4"
            )),
            PathBuf::from("/shots/recordings/Grab-it 2026-03-07 09-05-01.edits.json")
        );
    }

    #[test]
    fn edits_round_trip_and_leave_the_video_alone() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        fs::write(&video, b"video").unwrap();
        assert_eq!(read_edits(&video), Ok(None));
        let edits = json!({
            "version": 1,
            "trim": { "startMs": 1250, "endMs": 9500 },
            "backdrop": { "fill": "ocean", "padding": 64, "radius": 36, "shadow": true, "aspect": "9:16" },
        });
        write_edits(&video, &edits).unwrap();
        assert!(dir.path().join("clip.edits.json").is_file());
        assert!(!dir.path().join("clip.edits.json.tmp").exists());
        assert_eq!(read_edits(&video), Ok(Some(edits)));
        assert_eq!(fs::read(&video).unwrap(), b"video");
    }

    #[test]
    fn unknown_or_broken_edits_are_refused() {
        assert!(validate_edits(&json!({ "version": 2 })).is_err());
        assert!(validate_edits(&json!({})).is_err());
        assert!(validate_edits(&json!({ "version": 1 })).is_ok());
        assert!(validate_edits(&json!({ "version": 1, "trim": null })).is_ok());
        assert!(
            validate_edits(&json!({ "version": 1, "trim": { "startMs": 5, "endMs": 5 } })).is_err()
        );
        assert!(
            validate_edits(&json!({ "version": 1, "trim": { "startMs": -1, "endMs": 5 } }))
                .is_err()
        );

        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        fs::write(dir.path().join("clip.edits.json"), "{").unwrap();
        assert!(read_edits(&video).is_err());
        assert!(write_edits(&video, &json!({ "version": 9 })).is_err());
    }

    #[test]
    fn the_frame_rate_comes_from_the_pointer_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        assert_eq!(recording_fps(&video), 30);
        fs::write(
            dir.path().join("clip.cursor.json"),
            r#"{"version":1,"fps":60}"#,
        )
        .unwrap();
        assert_eq!(recording_fps(&video), 60);
        fs::write(dir.path().join("clip.cursor.json"), r#"{"fps":0}"#).unwrap();
        assert_eq!(recording_fps(&video), 30);
    }

    #[test]
    fn exports_never_overwrite_the_original_or_an_earlier_export() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Grab-it 2026-03-07 09-05-01.mp4");
        fs::write(&video, b"video").unwrap();
        let first = edited_path(&video);
        assert_eq!(
            first,
            dir.path().join("Grab-it 2026-03-07 09-05-01 (edited).mp4")
        );
        fs::write(&first, b"edited").unwrap();
        assert_eq!(
            edited_path(&video),
            dir.path()
                .join("Grab-it 2026-03-07 09-05-01 (edited 2).mp4")
        );
    }

    #[test]
    fn only_mp4s_in_the_recordings_folder_are_served() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        fs::create_dir_all(&recordings).unwrap();
        let clip = recordings.join("clip.MP4");
        fs::write(&clip, b"video").unwrap();
        fs::write(recordings.join("clip.cursor.json"), b"{}").unwrap();
        fs::write(dir.path().join("secret.mp4"), b"no").unwrap();

        assert_eq!(
            allowed_video(&recordings, &clip),
            Some(fs::canonicalize(&clip).unwrap())
        );
        // `..` is seen through.
        assert_eq!(
            allowed_video(&recordings, &recordings.join("..").join("secret.mp4")),
            None
        );
        assert_eq!(
            allowed_video(&recordings, &recordings.join("clip.cursor.json")),
            None
        );
        assert_eq!(
            allowed_video(&recordings, &recordings.join("gone.mp4")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_recordings_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        fs::create_dir_all(&recordings).unwrap();
        let outside = dir.path().join("outside.mp4");
        fs::write(&outside, b"no").unwrap();
        let link = recordings.join("link.mp4");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(allowed_video(&recordings, &link), None);
    }

    #[test]
    fn request_paths_are_uri_decoded() {
        assert_eq!(
            requested_path("/%2Fshots%2Frecordings%2FGrab-it%202026.mp4"),
            Some(PathBuf::from("/shots/recordings/Grab-it 2026.mp4"))
        );
        assert_eq!(requested_path("/"), None);
        assert_eq!(requested_path("/%zz"), None);
    }

    #[test]
    fn ranges_are_read_as_players_send_them() {
        let len = 10 * MAX_CHUNK;
        assert_eq!(parse_range(None, len), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-99"), len), Ok(Some((0, 99))));
        // Open-ended ranges are answered a chunk at a time.
        assert_eq!(
            parse_range(Some("bytes=100-"), len),
            Ok(Some((100, 100 + MAX_CHUNK - 1)))
        );
        assert_eq!(parse_range(Some("bytes=100-"), 500), Ok(Some((100, 499))));
        // The end is cut to the file, and a suffix counts from the end.
        assert_eq!(parse_range(Some("bytes=10-9999"), 500), Ok(Some((10, 499))));
        assert_eq!(parse_range(Some("bytes=-100"), 500), Ok(Some((400, 499))));
        assert_eq!(parse_range(Some("bytes=0-1, 5-9"), 500), Ok(Some((0, 1))));
        assert_eq!(parse_range(Some("bytes=500-"), 500), Err(Unsatisfiable));
        assert_eq!(parse_range(Some("bytes=9-3"), 500), Err(Unsatisfiable));
        assert_eq!(parse_range(Some("items=0-1"), 500), Err(Unsatisfiable));
        assert_eq!(parse_range(Some("bytes=-0"), 500), Err(Unsatisfiable));
    }

    #[test]
    fn a_range_is_answered_with_just_those_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip.mp4");
        fs::write(&clip, b"0123456789").unwrap();

        let part = video_response(&clip, Some("bytes=2-5"));
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), b"2345");
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(part.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(part.headers()[header::CONTENT_TYPE], "video/mp4");

        let whole = video_response(&clip, None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), b"0123456789");

        let past = video_response(&clip, Some("bytes=20-"));
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn plans_must_fit_and_be_even() {
        assert_eq!(PLAN.check(), Ok(()));
        assert!(
            ExportPlan {
                width: 1081,
                ..PLAN
            }
            .check()
            .is_err()
        );
        assert!(
            ExportPlan {
                height: 8192,
                ..PLAN
            }
            .check()
            .is_err()
        );
        assert!(ExportPlan { x: 200, ..PLAN }.check().is_err());
        assert!(
            ExportPlan {
                video_height: 0,
                ..PLAN
            }
            .check()
            .is_err()
        );
        assert!(
            ExportPlan {
                end_ms: 1300,
                ..PLAN
            }
            .check()
            .is_err()
        );
        assert_eq!(PLAN.duration(), Duration::from_millis(8250));
        assert_eq!(PLAN.frames(60), 495);
        assert_eq!(
            ExportPlan {
                end_ms: 1251,
                ..PLAN
            }
            .frames(30),
            1
        );
    }

    #[test]
    fn trimmed_frames_are_decoded_at_the_size_they_take_on_the_backdrop() {
        assert_eq!(
            strings(decode_args(Path::new("/rec/clip.mp4"), &PLAN, 60)),
            "-hide_banner -loglevel error -ss 1.250 -i /rec/clip.mp4 -t 8.250 -map 0:v:0 -an \
             -vf scale=960:540:flags=bicubic,fps=60,format=rgba -f rawvideo -pix_fmt rgba pipe:1"
        );
    }

    #[test]
    fn the_trimmed_sound_is_added_from_the_original() {
        assert_eq!(
            strings(trim_audio_args(
                Path::new("/rec/clip (edited).exporting.mp4"),
                Path::new("/rec/clip.mp4"),
                &PLAN,
                Path::new("/rec/clip (edited).mp4"),
            )),
            "-hide_banner -loglevel error -y -i /rec/clip (edited).exporting.mp4 \
             -ss 1.250 -t 8.250 -i /rec/clip.mp4 -map 0:v:0 -map 1:a:0? -c:v copy \
             -c:a aac -b:a 160k -shortest -movflags +faststart /rec/clip (edited).mp4"
        );
    }

    #[test]
    fn frames_are_laid_over_the_backdrop_through_the_mask() {
        let plan = ExportPlan {
            start_ms: 0,
            end_ms: 1000,
            width: 4,
            height: 2,
            x: 1,
            y: 0,
            video_width: 2,
            video_height: 2,
            backdrop_bytes: 1,
        };
        let backdrop = RgbaImage::from_pixel(4, 2, Rgba([0, 0, 200, 255]));
        let mut mask = RgbaImage::new(4, 2);
        mask.put_pixel(1, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(2, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(1, 1, Rgba([255, 255, 255, 255]));
        // A rounded corner: half the video shows.
        mask.put_pixel(2, 1, Rgba([255, 255, 255, 128]));
        let composer = Composer::new(backdrop, &mask, plan).unwrap();
        let red = [255, 0, 0, 255].repeat(4);
        let out = composer.compose(&red);
        assert_eq!(out.get_pixel(0, 0), &Rgba([0, 0, 200, 255]));
        assert_eq!(out.get_pixel(1, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(2, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(1, 1), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(2, 1), &Rgba([128, 0, 100, 255]));
        assert_eq!(out.get_pixel(3, 1), &Rgba([0, 0, 200, 255]));

        let wrong = RgbaImage::new(2, 2);
        assert!(Composer::new(wrong, &mask, plan).is_err());
    }

    #[test]
    fn the_body_is_the_backdrop_then_the_mask() {
        let png = |colour: [u8; 4]| {
            let mut bytes = Vec::new();
            RgbaImage::from_pixel(2, 2, Rgba(colour))
                .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
                .unwrap();
            bytes
        };
        let backdrop = png([1, 2, 3, 255]);
        let mask = png([255, 255, 255, 0]);
        let plan = ExportPlan {
            backdrop_bytes: backdrop.len(),
            ..PLAN
        };
        let body = [backdrop.clone(), mask].concat();
        let (read_backdrop, read_mask) = backdrop_and_mask(&body, &plan).unwrap().unwrap();
        assert_eq!(read_backdrop.get_pixel(0, 0), &Rgba([1, 2, 3, 255]));
        assert_eq!(read_mask.get_pixel(1, 1).0[3], 0);

        assert_eq!(
            backdrop_and_mask(
                &[],
                &ExportPlan {
                    backdrop_bytes: 0,
                    ..PLAN
                }
            ),
            Ok(None)
        );
        assert!(backdrop_and_mask(&backdrop, &plan).is_err());
    }
}
