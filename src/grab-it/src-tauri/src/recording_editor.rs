//! The recording editor's backend: which MP4 each recording editor window
//! shows, serving it to the page, its edits sidecar, and exporting the
//! edited copy.
//!
//! The recording is never written here. Edits (trim, backdrop, zooms) live in
//! `<recording>.edits.json`; Export renders them into a new
//! `<name> (edited).mp4` beside the original. The page plays the recording
//! from the `grab-it-video` URI scheme ([`VIDEO_SCHEME`]), which serves only
//! MP4s in the recordings folder, a range at a time.
//!
//! The edits can join other MP4s from the same recordings folder into a
//! sequence of clips ([`ExportClip`]), each a stretch of its recording. The
//! recording the editor opened sets the output size and frame rate; other
//! recordings are fitted inside its video box with black bars.
//!
//! On export the page paints the backdrop (fill and shadow) and a mask of
//! the video's rounded corners as PNGs at the output size. ffmpeg decodes
//! each clip in turn as raw RGBA at the size it takes on the backdrop;
//! each frame is laid over the backdrop through the mask ([`Composer`])
//! and piped into the same H.264 encoder recordings use. Each clip's
//! trimmed sound is then joined in order and added as AAC. With zooms, a
//! clip's frames are decoded larger instead, and each is cut to its zoomed
//! view ([`crate::zoom`]) before it is laid over the backdrop.

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
    record::{RECORDINGS_DIR, SoundSource, cursor_path, sound_path},
    settings::RecordingFormat,
    zoom::{self, CursorPath, View, Zoom},
};

/// The URI scheme the page plays recordings from. Mirrors `VIDEO_SCHEME` in
/// src/recording/api.ts.
pub const VIDEO_SCHEME: &str = "grab-it-video";
/// The newest edits sidecar format version this build reads and writes:
/// 2 adds `clips`. Version 1 (a trim of the recording itself) is still
/// written whenever the sequence is that one clip.
pub const EDITS_VERSION: u64 = 2;
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
/// The largest recording a zoomed export decodes frames at.
const MAX_SOURCE_SIDE: u32 = 8192;
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
/// `startMs` and `endMs` and an optional `zooms` list, or `{version: 2,
/// ...}` which may also hold a `clips` list of `{id, source, startMs,
/// endMs}`; any other fields are kept as they are. The page drops a zoom it
/// cannot read on its own.
pub fn validate_edits(value: &Value) -> Result<(), String> {
    let version = value.get("version").and_then(Value::as_u64);
    if !matches!(version, Some(1..=EDITS_VERSION)) {
        return Err(format!(
            "unsupported edits version {}",
            value.get("version").unwrap_or(&Value::Null)
        ));
    }
    if !matches!(
        value.get("zooms"),
        None | Some(Value::Null | Value::Array(_))
    ) {
        return Err("the zooms must be a list".to_owned());
    }
    match value.get("clips") {
        None | Some(Value::Null) => {}
        Some(Value::Array(clips)) if version == Some(2) => {
            clips.iter().try_for_each(validate_clip)?;
        }
        Some(Value::Array(_)) => return Err("clips need edits version 2".to_owned()),
        Some(_) => return Err("the clips must be a list".to_owned()),
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

/// One entry of a version 2 `clips` list: an id, the file name of a
/// recording (no folders), and a stretch of it.
fn validate_clip(clip: &Value) -> Result<(), String> {
    let text = |key: &str| {
        clip.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    if text("id").is_none() {
        return Err("a clip needs an id".to_owned());
    }
    match text("source") {
        Some(source) if !source.contains(['/', '\\']) && source != ".." => {}
        _ => return Err("a clip needs the file name of a recording".to_owned()),
    }
    let ms = |key: &str| clip.get(key).and_then(Value::as_f64);
    match (ms("startMs"), ms("endMs")) {
        (Some(start), Some(end)) if start >= 0.0 && end > start => Ok(()),
        _ => Err("a clip needs a startMs before its endMs".to_owned()),
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
    sidecar_fps(video).unwrap_or(DEFAULT_FPS)
}

/// The frame rate in a recording's pointer sidecar, if it has one.
fn sidecar_fps(video: &Path) -> Option<u32> {
    fs::read(cursor_path(video))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("fps").and_then(Value::as_u64))
        .and_then(|fps| u32::try_from(fps).ok())
        .filter(|fps| (1..=240).contains(fps))
}

/// The frame rate of the first video stream in what `ffmpeg -i` prints
/// about a file (`Stream #0:0 ... 60 fps, 60 tbr ...`), rounded.
pub fn parse_stream_fps(said: &str) -> Option<u32> {
    said.lines()
        .filter(|line| line.contains("Stream #") && line.contains("Video:"))
        .find_map(|line| {
            let before = line.split(" fps").next()?;
            let number = before.rsplit([' ', ',']).next()?;
            let fps: f64 = number.parse().ok()?;
            (1.0..=240.0).contains(&fps).then(|| fps.round() as u32)
        })
}

/// The frame rate an export of `video` is made at: its pointer sidecar's,
/// else the file's own as ffmpeg reads it (an earlier export has no
/// sidecar), else [`DEFAULT_FPS`].
fn export_fps(ffmpeg: &Path, video: &Path) -> u32 {
    if let Some(fps) = sidecar_fps(video) {
        return fps;
    }
    let probed = ffmpeg::command(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(video)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
        .and_then(|mut child| {
            let reader = child.stderr.take().map(|mut stderr| {
                thread::spawn(move || {
                    let mut text = String::new();
                    let _ = stderr.read_to_string(&mut text);
                    text
                })
            });
            // ffmpeg exits with an error here (no output named), after
            // printing what the file holds.
            ffmpeg::wait_for(&mut child, Duration::from_secs(10));
            reader.and_then(|reader| reader.join().ok())
        });
    probed
        .as_deref()
        .and_then(parse_stream_fps)
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

/// What one source of a recording's sound is. Mirrors `AudioKind` in
/// src/recording/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioKind {
    Microphone,
    System,
    /// The microphone and system sound in one track, which can only be
    /// edited together: recordings made before the sources were kept, or
    /// whose sound sidecar could not be written.
    Mixed,
}

impl From<SoundSource> for AudioKind {
    fn from(source: SoundSource) -> Self {
        match source {
            SoundSource::Microphone => Self::Microphone,
            SoundSource::System => Self::System,
        }
    }
}

/// One source of a recording's sound and where to read it: an audio
/// stream of the MP4 or of its sound sidecar, lined up with the video.
/// Waveforms and per-source mixing build on these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub kind: AudioKind,
    /// The file holding it.
    pub file: PathBuf,
    /// Its audio stream in `file`, as ffmpeg's `a:<stream>` counts.
    pub stream: usize,
}

/// The sources in a recording's pointer sidecar's `audio`, or `None` when
/// the sidecar, or its `audio`, is missing or unreadable.
fn sidecar_audio(video: &Path) -> Option<Vec<SoundSource>> {
    fs::read(cursor_path(video))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|mut value| value.get_mut("audio").map(Value::take))
        .and_then(|audio| serde_json::from_value(audio).ok())
}

/// The sources of `video`'s sound. `ffmpeg` probes an older recording
/// for whether it has sound at all; without it such a recording lists
/// none.
pub fn audio_sources(video: &Path, ffmpeg: Option<&Path>) -> Vec<AudioSource> {
    audio_sources_with(video, || {
        ffmpeg.is_some_and(|ffmpeg| ffmpeg::probe_file(ffmpeg, video).audio)
    })
}

/// [`audio_sources`], with `has_audio` saying whether the MP4 has a sound
/// stream. With the sound sidecar, each source in the pointer sidecar's
/// `audio` is its stream there. Without it, the MP4's one track is that
/// source, or mixed when it holds two. A recording made before `audio`
/// was saved is mixed when it has sound.
fn audio_sources_with(video: &Path, has_audio: impl FnOnce() -> bool) -> Vec<AudioSource> {
    let in_video = |kind: AudioKind| AudioSource {
        kind,
        file: video.to_path_buf(),
        stream: 0,
    };
    match sidecar_audio(video) {
        Some(sources) => {
            let sound = sound_path(video);
            if !sources.is_empty() && sound.is_file() {
                sources
                    .into_iter()
                    .enumerate()
                    .map(|(stream, source)| AudioSource {
                        kind: source.into(),
                        file: sound.clone(),
                        stream,
                    })
                    .collect()
            } else {
                match sources.as_slice() {
                    [] => Vec::new(),
                    [only] => vec![in_video((*only).into())],
                    _ => vec![in_video(AudioKind::Mixed)],
                }
            }
        }
        None if has_audio() => vec![in_video(AudioKind::Mixed)],
        None => Vec::new(),
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
    /// The pointer's smoothed path from `<recording>.cursor.json`, which
    /// follow-the-pointer zooms centre on; the export uses the same one.
    pub cursor: Option<CursorPath>,
    /// Each source of its sound, by kind, in [`audio_sources`]' order:
    /// empty when it is silent.
    pub audio: Vec<AudioKind>,
}

#[tauri::command]
pub async fn recording_info(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingInfo, String> {
    let path = state.path_for(window.label())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let edits = read_edits(&path)?;
    let fps = recording_fps(&path);
    let cursor = CursorPath::load(&path);
    let ffmpeg = ffmpeg::ready(&app).map(|ready| ready.path);
    let video = path.clone();
    // An older recording is probed by ffmpeg: off the async runtime.
    let audio = tauri::async_runtime::spawn_blocking(move || {
        audio_sources(&video, ffmpeg.as_deref())
            .into_iter()
            .map(|source| source.kind)
            .collect()
    })
    .await
    .map_err(|err| format!("could not read the recording's sound: {err}"))?;
    Ok(RecordingInfo {
        path,
        file_name,
        edits,
        fps,
        cursor,
        audio,
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

/// A recording a clip of the sequence plays. Mirrors `RecordingSource` in
/// src/recording/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSource {
    pub path: PathBuf,
    pub file_name: String,
    /// The frame rate it was recorded at.
    pub fps: u32,
    /// Its pointer path, for follow-the-pointer zooms.
    pub cursor: Option<CursorPath>,
    /// Whether it holds sound.
    pub has_audio: bool,
}

/// The MP4 `file_name` names in `recordings`: a bare file name, never a
/// path, of a file that is there.
pub fn source_file(recordings: &Path, file_name: &str) -> Result<PathBuf, String> {
    let bare = !file_name.is_empty()
        && !file_name.contains(['/', '\\'])
        && Path::new(file_name).file_name() == Some(std::ffi::OsStr::new(file_name));
    let file = if bare {
        allowed_video(recordings, &recordings.join(file_name))
    } else {
        None
    };
    file.ok_or_else(|| format!("{file_name} is not a recording in the recordings folder"))
}

/// The folder clips are taken from: the one holding the recording the
/// editor opened, which is a recordings folder.
fn recordings_of(original: &Path) -> Result<&Path, String> {
    original
        .parent()
        .ok_or_else(|| "the recording has no folder".to_owned())
}

/// What the editor needs to play and export `file_name` from the
/// recordings folder as a clip. Refuses any other file, or one that is
/// gone. Whether it has sound is asked of ffmpeg; before ffmpeg is ready
/// it is assumed to have some.
#[tauri::command]
pub async fn recording_source(
    file_name: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingSource, String> {
    let original = state.path_for(window.label())?;
    let path = source_file(recordings_of(&original)?, &file_name)?;
    let ffmpeg = ffmpeg::ready(&app).map(|ready| ready.path);
    tauri::async_runtime::spawn_blocking(move || {
        let has_audio = ffmpeg
            .as_deref()
            .is_none_or(|ffmpeg| ffmpeg::probe_file(ffmpeg, &path).audio);
        RecordingSource {
            fps: recording_fps(&path),
            cursor: CursorPath::load(&path),
            file_name,
            has_audio,
            path,
        }
    })
    .await
    .map_err(|err| format!("could not read the recording: {err}"))
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
        // The page draws frames into a canvas for the blurred backdrop, and
        // on Linux fetches the file a range at a time (see src/recording/api.ts).
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        );
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
    // A fetch with a Range header from the page's origin asks first.
    if request.method() == tauri::http::Method::OPTIONS {
        return preflight();
    }
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

/// The answer to a CORS preflight: any origin may GET with a `Range`.
pub fn preflight() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .body(Vec::new())
        .unwrap_or_default()
}

// --- Exporting -------------------------------------------------------------

/// One clip of an export: a stretch of a recording, fitted inside the
/// video box. Mirrors `ExportClip` in src/recording/api.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    /// The file name of its recording in the recordings folder.
    pub source: String,
    /// The stretch kept, in its recording's time.
    pub start_ms: u64,
    pub end_ms: u64,
    /// Its recording's own size, which frames are cut from.
    pub source_width: u32,
    pub source_height: u32,
    /// Where it sits inside the video box, and the size it takes there;
    /// the rest of the box is black.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Its zooms, in its recording's time; none leaves every frame whole.
    #[serde(default)]
    pub zooms: Vec<Zoom>,
}

impl ExportClip {
    /// Refuses a clip that could not be decoded into a `video` box.
    pub fn check(&self, (video_width, video_height): (u32, u32)) -> Result<(), String> {
        if self.width == 0
            || self.height == 0
            || self.x.saturating_add(self.width) > video_width
            || self.y.saturating_add(self.height) > video_height
        {
            return Err(format!("{} does not fit inside the video", self.source));
        }
        if self.end_ms < self.start_ms.saturating_add(MIN_EXPORT_MS) {
            return Err(format!("{} is trimmed too short to export", self.source));
        }
        let fits = |side: u32| (1..=MAX_SOURCE_SIDE).contains(&side);
        if !fits(self.source_width) || !fits(self.source_height) {
            return Err(format!("the export needs the size of {}", self.source));
        }
        self.zooms.iter().try_for_each(Zoom::check)
    }

    /// The size frames are decoded at: the size the clip takes in the
    /// video box, or with zooms, as large as the deepest zoom needs to
    /// stay sharp, up to its recording's own size.
    pub fn decode_size(&self) -> (u32, u32) {
        if self.zooms.is_empty() {
            return (self.width, self.height);
        }
        let (source_w, source_h) = (f64::from(self.source_width), f64::from(self.source_height));
        let needed = (f64::from(self.width) / source_w).max(f64::from(self.height) / source_h)
            * zoom::max_scale(&self.zooms);
        let factor = needed.min(1.0);
        let side = |source: f64| ((source * factor).round() as u32).max(1);
        (side(source_w), side(source_h))
    }

    /// How long it plays.
    pub fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    /// How many frames it gives at `fps`.
    pub fn frames(&self, fps: u32) -> u64 {
        (self.duration_ms() * u64::from(fps)).div_ceil(1000)
    }
}

/// What an export makes, from the page. Mirrors `ExportPlan` in
/// src/recording/api.ts. Sizes are in output pixels.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    /// The sequence, played in order.
    pub clips: Vec<ExportClip>,
    /// The output's size, even both ways.
    pub width: u32,
    pub height: u32,
    /// Where the video box's top-left corner goes, and its size there.
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
        let even = |side: u32| side >= 2 && side.is_multiple_of(2) && side <= MAX_EXPORT_SIDE;
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
        if self.clips.is_empty() {
            return Err("there is nothing to export".to_owned());
        }
        self.clips
            .iter()
            .try_for_each(|clip| clip.check((self.video_width, self.video_height)))
    }

    /// How many frames the export holds at `fps`, over all its clips.
    pub fn frames(&self, fps: u32) -> u64 {
        self.clips.iter().map(|clip| clip.frames(fps)).sum()
    }

    /// How long the export plays.
    pub fn duration_ms(&self) -> u64 {
        self.clips.iter().map(ExportClip::duration_ms).sum()
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

/// ffmpeg's arguments to decode `clip`'s stretch of `input` as raw RGBA
/// frames on stdout, scaled to [`ExportClip::decode_size`], at a constant
/// `fps`. Seeking before `-i` is exact when decoding.
pub fn decode_args(input: &Path, clip: &ExportClip, fps: u32) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-ss"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(seconds(clip.start_ms).into());
    args.push("-i".into());
    args.push(input.as_os_str().to_owned());
    let mut push = |arg: &str| args.push(OsString::from(arg));
    push("-t");
    push(&seconds(clip.duration_ms()));
    for arg in ["-map", "0:v:0", "-an", "-vf"] {
        push(arg);
    }
    let (width, height) = clip.decode_size();
    push(&format!(
        "scale={width}:{height}:flags=bicubic,fps={fps},format=rgba"
    ));
    for arg in ["-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"] {
        push(arg);
    }
    args
}

/// One clip's sound: its recording, or `None` when that has none.
pub struct ClipSound<'a> {
    pub clip: &'a ExportClip,
    pub file: Option<&'a Path>,
}

/// ffmpeg's arguments to write `output` from the silent `video` with each
/// clip's stretch of its recording's sound, resampled to 48 kHz stereo
/// and joined in order, as AAC. Each clip's sound is exactly its length:
/// padded with silence where its recording's sound stops early, and
/// silence throughout when its recording has none.
pub fn clip_sound_args(video: &Path, clips: &[ClipSound<'_>], output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(video.as_os_str().to_owned());
    let mut filters = Vec::new();
    let mut inputs = 0;
    for (index, sound) in clips.iter().enumerate() {
        let clip = sound.clip;
        match sound.file {
            Some(file) => {
                args.push("-i".into());
                args.push(file.as_os_str().to_owned());
                inputs += 1;
                // Padded with silence and cut to the clip's length, so a
                // sound track that ends early never pulls later clips'
                // sound ahead of their frames.
                filters.push(format!(
                    "[{inputs}:a:0]atrim=start={}:end={},asetpts=PTS-STARTPTS,\
                     aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
                     apad,atrim=duration={}[a{index}]",
                    seconds(clip.start_ms),
                    seconds(clip.end_ms),
                    seconds(clip.duration_ms())
                ));
            }
            None => filters.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=duration={},\
                 aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]",
                seconds(clip.duration_ms())
            )),
        }
    }
    let joined: String = (0..clips.len())
        .map(|index| format!("[a{index}]"))
        .collect();
    filters.push(format!("{joined}concat=n={}:v=0:a=1[sound]", clips.len()));
    args.push("-filter_complex".into());
    args.push(filters.join(";").into());
    for arg in [
        "-map",
        "0:v:0",
        "-map",
        "[sound]",
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
        args.push(arg.into());
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// Draws a decoded clip frame into the black video box at the clip's
/// place. `boxed` is `video_width` × `video_height` RGBA.
pub fn place_in_box(frame: &[u8], clip: &ExportClip, boxed: &mut [u8], video_width: u32) {
    let (bw, cw) = (video_width as usize, clip.width as usize);
    let (cx, cy) = (clip.x as usize, clip.y as usize);
    for row in 0..clip.height as usize {
        let src = row * cw * 4;
        let dst = ((cy + row) * bw + cx) * 4;
        boxed[dst..dst + cw * 4].copy_from_slice(&frame[src..src + cw * 4]);
    }
}

/// A box of opaque black pixels.
fn black(width: u32, height: u32) -> Vec<u8> {
    [0u8, 0, 0, 255].repeat(width as usize * height as usize)
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
    pub fn new(backdrop: RgbaImage, mask: &RgbaImage, plan: &ExportPlan) -> Result<Self, String> {
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
            plan: plan.clone(),
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

/// The recording behind one clip of an export.
struct ClipSource {
    path: PathBuf,
    /// The pointer path follow-the-pointer zooms centre on.
    cursor: Option<CursorPath>,
    has_audio: bool,
}

/// One export to render.
struct ExportJob<'a> {
    output: &'a Path,
    plan: ExportPlan,
    /// Each clip's recording, in the plan's order.
    sources: Vec<ClipSource>,
    /// The backdrop and mask, or none for the video alone.
    layers: Option<(RgbaImage, RgbaImage)>,
    /// The opened recording's frame rate, which every clip is decoded at.
    fps: u32,
    bits_per_pixel: f64,
}

/// Decodes `clip` of `input` at `fps` and calls `frame` with each frame,
/// `clip.decode_size()` RGBA, until ffmpeg runs out. Returns how many
/// frames there were.
fn decode_clip(
    ffmpeg_path: &Path,
    input: &Path,
    clip: &ExportClip,
    fps: u32,
    mut frame: impl FnMut(&[u8], u64) -> Result<(), String>,
) -> Result<u64, String> {
    let mut decoder = ffmpeg::command(ffmpeg_path)
        .args(decode_args(input, clip, fps))
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
    let (width, height) = clip.decode_size();
    let mut buffer = vec![0; width as usize * height as usize * 4];
    let mut done: u64 = 0;
    let decoded = loop {
        match stdout.read_exact(&mut buffer) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break Ok(()),
            Err(err) => break Err(format!("could not read the frames: {err}")),
        }
        if let Err(err) = frame(&buffer, done) {
            break Err(err);
        }
        done += 1;
    };
    drop(stdout);
    let status = ffmpeg::wait_for(&mut decoder, Duration::from_secs(10));
    let said = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    decoded?;
    match status {
        Some(status) if status.success() => Ok(done),
        _ => Err(format!(
            "ffmpeg could not read {}: {}",
            clip.source,
            ffmpeg::last_line(&said).unwrap_or("it stopped")
        )),
    }
}

/// Renders `job` with `ready`'s ffmpeg, calling `progress` as frames are
/// written. Each clip is decoded in turn into one encoder, at the opened
/// recording's frame rate. The silent video is written beside the output
/// first and the sound added from it, so the output only ever holds a
/// finished export.
fn render(
    ready: &ffmpeg::Ready,
    job: ExportJob<'_>,
    mut progress: impl FnMut(ExportProgress),
) -> Result<(), String> {
    let ExportJob {
        output,
        plan,
        sources,
        layers,
        fps,
        bits_per_pixel,
    } = job;
    let plan = &plan;
    if sources.len() != plan.clips.len() {
        return Err("every clip needs its recording".to_owned());
    }
    let composer = layers
        .map(|(backdrop, mask)| Composer::new(backdrop, &mask, plan))
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
        let total = plan.frames(fps);
        let video_box = (plan.video_width, plan.video_height);
        let mut done: u64 = 0;
        let mut last_percent = None;
        for (clip, source) in plan.clips.iter().zip(&sources) {
            let decoded_size = clip.decode_size();
            let clip_size = (clip.width, clip.height);
            // Each zoomed frame's view, at the clip's size in the box.
            let mut zoomed = vec![0; clip.width as usize * clip.height as usize * 4];
            // The video box, black around a clip that does not fill it.
            let fills = clip_size == video_box;
            let mut boxed = if fills {
                Vec::new()
            } else {
                black(plan.video_width, plan.video_height)
            };
            let frames = decode_clip(&ready.path, &source.path, clip, fps, |buffer, index| {
                let mut shown: &[u8] = if clip.zooms.is_empty() {
                    buffer
                } else {
                    let ms = clip.start_ms as f64 + index as f64 * 1000.0 / f64::from(fps);
                    let view: View = zoom::view_at(&clip.zooms, ms, source.cursor.as_ref());
                    zoom::draw_view(buffer, decoded_size, view, &mut zoomed, clip_size);
                    &zoomed
                };
                if !fills {
                    place_in_box(shown, clip, &mut boxed, plan.video_width);
                    shown = &boxed;
                }
                let frame = match &composer {
                    Some(composer) => composer.compose(shown),
                    None => RgbaImage::from_raw(plan.width, plan.height, shown.to_vec())
                        .ok_or("a frame was the wrong size")?,
                };
                video.write(&frame).map_err(|err| err.to_string())?;
                done += 1;
                let percent = (done * 100).checked_div(total).unwrap_or(100);
                if last_percent != Some(percent) {
                    last_percent = Some(percent);
                    progress(ExportProgress {
                        done: done.min(total),
                        total,
                    });
                }
                Ok(())
            })?;
            if frames == 0 {
                return Err(format!(
                    "the trimmed stretch of {} holds no frames",
                    clip.source
                ));
            }
        }
        video.finish().map_err(|err| err.to_string())?;
        let sounds: Vec<ClipSound<'_>> = plan
            .clips
            .iter()
            .zip(&sources)
            .map(|(clip, source)| ClipSound {
                clip,
                file: source.has_audio.then_some(source.path.as_path()),
            })
            .collect();
        ffmpeg::run(
            &ready.path,
            clip_sound_args(&silent, &sounds, output),
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

/// The recording each clip of `plan` plays, from `recordings`. A clip of
/// any other file, or of one that is gone, refuses the export.
fn clip_sources(
    ffmpeg_path: &Path,
    recordings: &Path,
    plan: &ExportPlan,
) -> Result<Vec<ClipSource>, String> {
    plan.clips
        .iter()
        .map(|clip| {
            let path = source_file(recordings, &clip.source)?;
            Ok(ClipSource {
                cursor: CursorPath::load(&path),
                has_audio: ffmpeg::probe_file(ffmpeg_path, &path).audio,
                path,
            })
        })
        .collect()
}

/// Renders `plan`'s sequence beside `original`, the recording the editor
/// opened, then shows the export on the Quick Access card. Returns its path.
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
    // Clips are looked for beside the opened recording, which is in the
    // recordings folder the editor was opened from.
    let sources = clip_sources(&ready.path, recordings_of(original)?, &plan)?;
    let output = edited_path(original);
    let duration_ms = plan.duration_ms();
    let job = ExportJob {
        output: &output,
        plan,
        sources,
        layers,
        fps: export_fps(&ready.path, original),
        bits_per_pixel,
    };
    render(ready, job, |progress| {
        let _ = app.emit_to(
            EventTarget::webview_window(label),
            EXPORT_PROGRESS_EVENT,
            progress,
        );
    })?;
    crate::library::record_recording(app, &output, duration_ms);
    let bytes = fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    quick::show(
        app,
        QuickItem::Recorded {
            file_name: output
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: output.clone(),
            duration_ms,
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

    /// A recording in a folder of its own, with a pointer sidecar holding
    /// `cursor` when given, and a sound sidecar when `sound`.
    fn recording_with(cursor: Option<&str>, sound: bool) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        fs::write(&video, b"mp4").unwrap();
        if let Some(cursor) = cursor {
            fs::write(cursor_path(&video), cursor).unwrap();
        }
        if sound {
            fs::write(sound_path(&video), b"m4a").unwrap();
        }
        (dir, video)
    }

    fn source(kind: AudioKind, file: &Path, stream: usize) -> AudioSource {
        AudioSource {
            kind,
            file: file.to_path_buf(),
            stream,
        }
    }

    #[test]
    fn kept_sources_are_read_from_the_sound_sidecar_in_order() {
        let both = r#"{"version":1,"fps":30,"audio":["microphone","system"]}"#;
        let (_dir, video) = recording_with(Some(both), true);
        let sound = sound_path(&video);
        assert_eq!(
            audio_sources_with(&video, || panic!("not probed")),
            [
                source(AudioKind::Microphone, &sound, 0),
                source(AudioKind::System, &sound, 1),
            ]
        );

        let (_dir, video) = recording_with(Some(r#"{"audio":["microphone"]}"#), true);
        assert_eq!(
            audio_sources_with(&video, || panic!("not probed")),
            [source(AudioKind::Microphone, &sound_path(&video), 0)]
        );
    }

    #[test]
    fn without_the_sound_sidecar_the_videos_one_track_is_used() {
        // The sound sidecar failed: the two are mixed in the MP4.
        let (_dir, video) = recording_with(Some(r#"{"audio":["microphone","system"]}"#), false);
        assert_eq!(
            audio_sources_with(&video, || panic!("not probed")),
            [source(AudioKind::Mixed, &video, 0)]
        );
        // System sound alone has no sound sidecar: the MP4's track is it.
        let (_dir, video) = recording_with(Some(r#"{"audio":["system"]}"#), false);
        assert_eq!(
            audio_sources_with(&video, || panic!("not probed")),
            [source(AudioKind::System, &video, 0)]
        );
    }

    #[test]
    fn a_recording_whose_sound_failed_has_no_sources() {
        let (_dir, video) = recording_with(Some(r#"{"audio":[]}"#), false);
        assert!(audio_sources_with(&video, || panic!("not probed")).is_empty());
    }

    #[test]
    fn an_older_recording_is_mixed_when_ffmpeg_hears_sound() {
        let (_dir, video) = recording_with(Some(r#"{"version":1,"fps":30}"#), false);
        assert_eq!(
            audio_sources_with(&video, || true),
            [source(AudioKind::Mixed, &video, 0)]
        );
        assert!(audio_sources_with(&video, || false).is_empty());
        // No pointer sidecar, or one that cannot be read, is the same.
        let (_dir, video) = recording_with(None, false);
        assert_eq!(
            audio_sources_with(&video, || true),
            [source(AudioKind::Mixed, &video, 0)]
        );
        let (_dir, video) = recording_with(Some("not json"), true);
        assert!(audio_sources_with(&video, || false).is_empty());
        let (_dir, video) = recording_with(Some(r#"{"audio":["speaker"]}"#), true);
        assert_eq!(
            audio_sources_with(&video, || true),
            [source(AudioKind::Mixed, &video, 0)]
        );
        // Without ffmpeg, nothing is probed.
        assert!(audio_sources(&video, None).is_empty());
    }

    #[test]
    fn audio_kinds_serialize_for_the_page() {
        assert_eq!(
            serde_json::to_value([AudioKind::Microphone, AudioKind::System, AudioKind::Mixed])
                .unwrap(),
            json!(["microphone", "system", "mixed"])
        );
    }

    fn strings(args: Vec<OsString>) -> String {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 1.25 s to 9.5 s of a 1920×1080 recording, filling a 960×540 box.
    fn clip() -> ExportClip {
        ExportClip {
            source: "clip.mp4".to_owned(),
            start_ms: 1250,
            end_ms: 9500,
            source_width: 1920,
            source_height: 1080,
            x: 0,
            y: 0,
            width: 960,
            height: 540,
            zooms: Vec::new(),
        }
    }

    fn plan() -> ExportPlan {
        ExportPlan {
            clips: vec![clip()],
            width: 1080,
            height: 1920,
            x: 60,
            y: 656,
            video_width: 960,
            video_height: 540,
            backdrop_bytes: 10,
        }
    }

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
        assert!(validate_edits(&json!({ "version": 3 })).is_err());
        assert!(validate_edits(&json!({})).is_err());
        assert!(validate_edits(&json!({ "version": 1 })).is_ok());
        assert!(validate_edits(&json!({ "version": 1, "trim": null })).is_ok());
        assert!(validate_edits(&json!({ "version": 1, "zooms": [] })).is_ok());
        assert!(validate_edits(&json!({ "version": 1, "zooms": { "startMs": 0 } })).is_err());
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
    fn version_2_edits_hold_a_list_of_clips() {
        let clip = |source: &str, start: f64, end: f64| json!({ "id": "c1", "source": source, "startMs": start, "endMs": end });
        assert!(validate_edits(&json!({ "version": 2 })).is_ok());
        assert!(
            validate_edits(&json!({
                "version": 2,
                "clips": [clip("a.mp4", 0.0, 4000.0), clip("b.mp4", 500.0, 2500.0)],
            }))
            .is_ok()
        );
        // Clips are new in version 2.
        assert!(
            validate_edits(&json!({ "version": 1, "clips": [clip("a.mp4", 0.0, 1.0)] })).is_err()
        );
        assert!(validate_edits(&json!({ "version": 2, "clips": {} })).is_err());
        // A clip names a file in the recordings folder, nothing further.
        for source in ["../a.mp4", "sub/a.mp4", "C:\\a.mp4", ""] {
            assert!(
                validate_edits(&json!({ "version": 2, "clips": [clip(source, 0.0, 1.0)] }))
                    .is_err(),
                "{source}"
            );
        }
        assert!(
            validate_edits(&json!({ "version": 2, "clips": [clip("a.mp4", 5.0, 5.0)] })).is_err()
        );
        assert!(
            validate_edits(
                &json!({ "version": 2, "clips": [{ "source": "a.mp4", "startMs": 0, "endMs": 1 }] })
            )
            .is_err()
        );
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
    fn an_earlier_export_keeps_its_frame_rate() {
        // What `ffmpeg -i` says about a 60 fps export, which has no sidecar.
        let said = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip (edited).mp4':\n  \
                    Duration: 00:00:08.25, start: 0.000000, bitrate: 4016 kb/s\n  \
                    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), \
                    1080x1920, 3858 kb/s, 60 fps, 60 tbr, 15360 tbn (default)\n  \
                    Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 159 kb/s\n\
                    At least one output file must be specified\n";
        assert_eq!(parse_stream_fps(said), Some(60));
        assert_eq!(
            parse_stream_fps("  Stream #0:0: Video: h264, yuv420p, 640x480, 29.97 fps, 29.97 tbr"),
            Some(30)
        );
        assert_eq!(
            parse_stream_fps("  Stream #0:1: Audio: aac, 48000 Hz"),
            None
        );
        assert_eq!(parse_stream_fps(""), None);
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

        // The page reads Content-Range when it fetches the file in parts.
        assert!(
            part.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS]
                .to_str()
                .unwrap()
                .contains("Content-Range")
        );
        let asked = preflight();
        assert_eq!(asked.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            asked.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "Range"
        );

        let past = video_response(&clip, Some("bytes=20-"));
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn plans_must_fit_and_be_even() {
        assert_eq!(plan().check(), Ok(()));
        assert!(
            ExportPlan {
                width: 1081,
                ..plan()
            }
            .check()
            .is_err()
        );
        assert!(
            ExportPlan {
                height: 8192,
                ..plan()
            }
            .check()
            .is_err()
        );
        assert!(ExportPlan { x: 200, ..plan() }.check().is_err());
        assert!(
            ExportPlan {
                video_height: 0,
                ..plan()
            }
            .check()
            .is_err()
        );
        assert!(
            ExportPlan {
                clips: Vec::new(),
                ..plan()
            }
            .check()
            .is_err()
        );
        let with = |clip: ExportClip| ExportPlan {
            clips: vec![self::clip(), clip],
            ..plan()
        };
        // Every clip is long enough, fits in the box and has its size.
        assert!(
            with(ExportClip {
                end_ms: 1300,
                ..clip()
            })
            .check()
            .is_err()
        );
        assert!(with(ExportClip { x: 2, ..clip() }).check().is_err());
        assert!(
            with(ExportClip {
                source_width: 0,
                ..clip()
            })
            .check()
            .is_err()
        );
        assert_eq!(plan().frames(60), 495);
        assert_eq!(
            ExportClip {
                end_ms: 1251,
                ..clip()
            }
            .frames(30),
            1
        );
    }

    #[test]
    fn the_sequence_runs_over_all_its_clips() {
        let second = ExportClip {
            source: "other.mp4".to_owned(),
            start_ms: 0,
            end_ms: 2000,
            source_width: 1280,
            source_height: 1024,
            x: 142,
            y: 0,
            width: 676,
            height: 540,
            zooms: Vec::new(),
        };
        let plan = ExportPlan {
            clips: vec![clip(), second],
            ..plan()
        };
        assert_eq!(plan.check(), Ok(()));
        assert_eq!(plan.duration_ms(), 10_250);
        assert_eq!(plan.frames(30), 248 + 60);
        // A clip narrower than the box is decoded at its own size there.
        assert_eq!(plan.clips[1].decode_size(), (676, 540));
    }

    #[test]
    fn a_narrower_clip_sits_in_black_bars() {
        let narrow = ExportClip {
            x: 1,
            y: 0,
            width: 2,
            height: 2,
            ..clip()
        };
        let mut boxed = black(4, 2);
        place_in_box(&[9u8; 16], &narrow, &mut boxed, 4);
        let pixel = |x: usize, y: usize| &boxed[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        assert_eq!(pixel(0, 0), [0, 0, 0, 255]);
        assert_eq!(pixel(1, 0), [9, 9, 9, 9]);
        assert_eq!(pixel(2, 1), [9, 9, 9, 9]);
        assert_eq!(pixel(3, 1), [0, 0, 0, 255]);
    }

    #[test]
    fn trimmed_frames_are_decoded_at_the_size_they_take_on_the_backdrop() {
        assert_eq!(
            strings(decode_args(Path::new("/rec/clip.mp4"), &clip(), 60)),
            "-hide_banner -loglevel error -ss 1.250 -i /rec/clip.mp4 -t 8.250 -map 0:v:0 -an \
             -vf scale=960:540:flags=bicubic,fps=60,format=rgba -f rawvideo -pix_fmt rgba pipe:1"
        );
    }

    fn zoomed(zooms: Vec<Zoom>) -> ExportClip {
        ExportClip { zooms, ..clip() }
    }

    fn area_zoom(scale: f64) -> Zoom {
        Zoom {
            start_ms: 2000.0,
            end_ms: 4000.0,
            scale,
            focus: zoom::Focus::Area { x: 0.5, y: 0.5 },
        }
    }

    #[test]
    fn clips_come_with_the_plan() {
        let plan: ExportPlan = serde_json::from_str(
            r#"{"clips":[{"source":"a.mp4","startMs":0,"endMs":5000,
                "sourceWidth":1920,"sourceHeight":1080,"x":0,"y":0,"width":1920,"height":1080,
                "zooms":[{"id":"z1","startMs":1000,"endMs":3000,"scale":2,"focus":{"kind":"cursor"}}]},
                {"source":"b.mp4","startMs":500,"endMs":1500,
                "sourceWidth":640,"sourceHeight":480,"x":240,"y":0,"width":1440,"height":1080}],
                "width":1920,"height":1080,"x":0,"y":0,
                "videoWidth":1920,"videoHeight":1080,"backdropBytes":0}"#,
        )
        .unwrap();
        assert_eq!(plan.clips.len(), 2);
        assert_eq!(plan.clips[0].zooms.len(), 1);
        assert!(plan.clips[1].zooms.is_empty());
        assert_eq!(plan.check(), Ok(()));
    }

    #[test]
    fn zoomed_clips_need_sound_zooms() {
        let plan = |zooms| ExportPlan {
            clips: vec![zoomed(zooms)],
            ..plan()
        };
        assert_eq!(plan(vec![area_zoom(2.0)]).check(), Ok(()));
        assert!(plan(vec![area_zoom(12.0)]).check().is_err());
    }

    #[test]
    fn zoomed_frames_are_decoded_large_enough_to_stay_sharp() {
        // The clip takes 960×540: no zoom needs only that.
        assert_eq!(clip().decode_size(), (960, 540));
        // Twice as deep needs the full 1920×1080.
        assert_eq!(zoomed(vec![area_zoom(2.0)]).decode_size(), (1920, 1080));
        assert_eq!(zoomed(vec![area_zoom(1.5)]).decode_size(), (1440, 810));
        // Never past the recording's own size.
        assert_eq!(zoomed(vec![area_zoom(4.0)]).decode_size(), (1920, 1080));
        assert!(
            strings(decode_args(
                Path::new("/rec/clip.mp4"),
                &zoomed(vec![area_zoom(1.5)]),
                60
            ))
            .contains("-vf scale=1440:810:flags=bicubic,fps=60,format=rgba")
        );
    }

    #[test]
    fn each_clips_sound_is_trimmed_and_joined_in_order() {
        let first = clip();
        let silent = ExportClip {
            source: "quiet.mp4".to_owned(),
            start_ms: 0,
            end_ms: 2000,
            ..clip()
        };
        let again = ExportClip {
            start_ms: 0,
            end_ms: 500,
            ..clip()
        };
        let original = Path::new("/rec/clip.mp4");
        let sounds = [
            ClipSound {
                clip: &first,
                file: Some(original),
            },
            ClipSound {
                clip: &silent,
                file: None,
            },
            ClipSound {
                clip: &again,
                file: Some(original),
            },
        ];
        assert_eq!(
            strings(clip_sound_args(
                Path::new("/rec/clip (edited).exporting.mp4"),
                &sounds,
                Path::new("/rec/clip (edited).mp4"),
            )),
            "-hide_banner -loglevel error -y -i /rec/clip (edited).exporting.mp4 \
             -i /rec/clip.mp4 -i /rec/clip.mp4 -filter_complex \
             [1:a:0]atrim=start=1.250:end=9.500,asetpts=PTS-STARTPTS,\
             aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration=8.250[a0];\
             anullsrc=r=48000:cl=stereo,atrim=duration=2.000,\
             aformat=sample_fmts=fltp:channel_layouts=stereo[a1];\
             [2:a:0]atrim=start=0.000:end=0.500,asetpts=PTS-STARTPTS,\
             aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration=0.500[a2];\
             [a0][a1][a2]concat=n=3:v=0:a=1[sound] \
             -map 0:v:0 -map [sound] -c:v copy -c:a aac -b:a 160k -shortest \
             -movflags +faststart /rec/clip (edited).mp4"
        );
    }

    #[test]
    fn clip_sources_are_bare_names_of_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        fs::create_dir_all(recordings.join("sub")).unwrap();
        fs::write(recordings.join("a.mp4"), b"video").unwrap();
        fs::write(recordings.join("sub").join("b.mp4"), b"video").unwrap();
        fs::write(recordings.join("a.gif"), b"gif").unwrap();
        fs::write(dir.path().join("outside.mp4"), b"video").unwrap();
        assert_eq!(
            source_file(&recordings, "a.mp4"),
            Ok(fs::canonicalize(recordings.join("a.mp4")).unwrap())
        );
        for refused in ["gone.mp4", "a.gif", "../outside.mp4", "sub/b.mp4", "", ".."] {
            assert!(source_file(&recordings, refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn frames_are_laid_over_the_backdrop_through_the_mask() {
        let plan = ExportPlan {
            width: 4,
            height: 2,
            x: 1,
            y: 0,
            video_width: 2,
            video_height: 2,
            backdrop_bytes: 1,
            ..plan()
        };
        let backdrop = RgbaImage::from_pixel(4, 2, Rgba([0, 0, 200, 255]));
        let mut mask = RgbaImage::new(4, 2);
        mask.put_pixel(1, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(2, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(1, 1, Rgba([255, 255, 255, 255]));
        // A rounded corner: half the video shows.
        mask.put_pixel(2, 1, Rgba([255, 255, 255, 128]));
        let composer = Composer::new(backdrop, &mask, &plan).unwrap();
        let red = [255, 0, 0, 255].repeat(4);
        let out = composer.compose(&red);
        assert_eq!(out.get_pixel(0, 0), &Rgba([0, 0, 200, 255]));
        assert_eq!(out.get_pixel(1, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(2, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(1, 1), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(2, 1), &Rgba([128, 0, 100, 255]));
        assert_eq!(out.get_pixel(3, 1), &Rgba([0, 0, 200, 255]));

        let wrong = RgbaImage::new(2, 2);
        assert!(Composer::new(wrong, &mask, &plan).is_err());
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
            ..plan()
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
                    ..self::plan()
                }
            ),
            Ok(None)
        );
        assert!(backdrop_and_mask(&backdrop, &plan).is_err());
    }
}
