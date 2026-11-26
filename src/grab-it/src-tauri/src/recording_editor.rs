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
//! recordings are fitted inside its video box with black bars. A gap
//! ([`ExportGap`]) between clips renders as the backdrop with a black video
//! box, and silence.
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
    collections::HashMap,
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    Emitter, EventTarget, Manager, State,
    http::{Request, Response, StatusCode, header},
    ipc::InvokeBody,
};

use crate::rt::{AppHandle, WebviewWindow};
use crate::{
    capture::sidecar_path,
    commands::{SettingsState, lock},
    editor::percent_decode,
    ffmpeg::{self, Video, VideoSpec},
    media::is_month_folder,
    quick::{self, QuickItem},
    record::{RECORDINGS_DIR, SoundSource, cursor_path, sound_path},
    settings::RecordingFormat,
    zoom::{self, CursorPath, View, Zoom},
};

/// The URI scheme the page plays recordings from. Mirrors `VIDEO_SCHEME` in
/// src/recording/api.ts.
pub const VIDEO_SCHEME: &str = "grab-it-video";
/// The newest edits sidecar format version this build reads and writes:
/// 2 adds clips, 3 adds gaps, 4 adds month-qualified source references, and
/// [`CAPTIONS_VERSION`] adds caption cues.
pub const EDITS_VERSION: u64 = CAPTIONS_VERSION;
/// The edits sidecar version that adds caption cues; older builds open a
/// sidecar with cues read-only. Mirrors `CAPTIONS_VERSION` in
/// src/recording/edits.ts.
pub const CAPTIONS_VERSION: u64 = 5;
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
pub struct RecordingEditorState {
    editors: Mutex<HashMap<String, RecordingFile>>,
    exports: Mutex<HashMap<String, ActiveExport>>,
}

#[derive(Clone)]
struct RecordingFile {
    path: PathBuf,
    source: String,
    recordings_folder: PathBuf,
}

struct ActiveExport {
    original: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl RecordingEditorState {
    fn editors(&self) -> MutexGuard<'_, HashMap<String, RecordingFile>> {
        self.editors.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Registers the file and its validated root before the webview opens.
    pub(crate) fn register(
        &self,
        label: &str,
        path: &Path,
        configured_root: &Path,
    ) -> io::Result<()> {
        let recording = recording_reference(configured_root, path)
            .or_else(|| recording_reference(named_recordings_root(path)?, path))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the recording is outside the recordings folder",
                )
            })?;
        self.editors().insert(label.to_owned(), recording);
        Ok(())
    }

    pub(crate) fn remove(&self, label: &str) {
        self.editors().remove(label);
    }

    pub(crate) fn label_for(&self, path: &Path) -> Option<String> {
        let canonical = fs::canonicalize(path).ok();
        self.editors()
            .iter()
            .find(|(_, open)| open.path == path || Some(&open.path) == canonical.as_ref())
            .map(|(label, _)| label.clone())
    }

    fn recording_for(&self, label: &str) -> Result<RecordingFile, String> {
        self.editors()
            .get(label)
            .cloned()
            .ok_or_else(|| "this window is not an editor".to_owned())
    }

    pub(crate) fn source_for(&self, label: &str, source: &str) -> Result<PathBuf, String> {
        let recording = self.recording_for(label)?;
        source_file(&recording.recordings_folder, source)
    }

    fn begin_export(&self, label: &str, original: &Path) -> Result<Arc<AtomicBool>, String> {
        let mut exports = self.exports.lock().unwrap_or_else(|err| err.into_inner());
        if exports.contains_key(label) || exports.values().any(|export| export.original == original)
        {
            return Err("An export is already running".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        exports.insert(
            label.to_owned(),
            ActiveExport {
                original: original.to_owned(),
                cancelled: flag.clone(),
            },
        );
        Ok(flag)
    }

    fn cancel_export(&self, label: &str) {
        if let Some(export) = self
            .exports
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(label)
        {
            export.cancelled.store(true, Ordering::Relaxed);
        }
    }

    fn finish_export(&self, label: &str) {
        self.exports
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(label);
    }
}

fn check_cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err("Export cancelled".into())
    } else {
        Ok(())
    }
}

/// The edits sidecar of a recording: `<name>.mp4` gives `<name>.edits.json`.
pub fn edits_path(video: &Path) -> PathBuf {
    sidecar_path(video, EDITS_SUFFIX)
}

/// Accepts `{version: 1, ...}` with an optional `trim` object holding
/// `startMs` and `endMs` and an optional `zooms` list, or `{version: 2,
/// ...}` which may also hold a `clips` list of `{id, source, startMs,
/// endMs}`. Version 3 adds gaps of `{id, gapMs}`, and version 4 permits
/// month-qualified clip and zoom sources. Version 5 adds `captions`, a
/// `{burnIn, cues, style?}` object whose cues are `{id, source?, startMs,
/// endMs, text}`. The page skips unknown zooms.
pub fn validate_edits(value: &Value) -> Result<(), String> {
    let Some(version @ 1..=EDITS_VERSION) = value.get("version").and_then(Value::as_u64) else {
        return Err(format!(
            "unsupported edits version {}",
            value.get("version").unwrap_or(&Value::Null)
        ));
    };
    if !matches!(
        value.get("zooms"),
        None | Some(Value::Null | Value::Array(_))
    ) {
        return Err("the zooms must be a list".to_owned());
    }
    match value.get("clips") {
        None | Some(Value::Null) => {}
        Some(Value::Array(clips)) if version >= 2 => {
            clips
                .iter()
                .try_for_each(|clip| validate_clip(clip, version))?;
        }
        Some(Value::Array(_)) => return Err("clips need edits version 2".to_owned()),
        Some(_) => return Err("the clips must be a list".to_owned()),
    }
    validate_captions(value.get("captions"), version)?;
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

/// Captions are `{burnIn, cues: [{id, source?, startMs, endMs, text}],
/// style?}`; cues need [`CAPTIONS_VERSION`] so older builds open them read-only.
fn validate_captions(captions: Option<&Value>, version: u64) -> Result<(), String> {
    let captions = match captions {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Object(captions)) => captions,
        Some(_) => return Err("the captions must be an object".to_owned()),
    };
    if !matches!(captions.get("burnIn"), None | Some(Value::Bool(_))) {
        return Err("burnIn must be true or false".to_owned());
    }
    if !matches!(
        captions.get("style"),
        None | Some(Value::Null | Value::Object(_))
    ) {
        return Err("the caption style must be an object".to_owned());
    }
    let cues = match captions.get("cues") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Array(cues)) => cues,
        Some(_) => return Err("the cues must be a list".to_owned()),
    };
    if !cues.is_empty() && version < CAPTIONS_VERSION {
        return Err(format!("cues need edits version {CAPTIONS_VERSION}"));
    }
    cues.iter().try_for_each(|cue| {
        let text = |key: &str| cue.get(key).and_then(Value::as_str);
        if text("id").is_none_or(str::is_empty) {
            return Err("a cue needs an id".to_owned());
        }
        if text("text").is_none() {
            return Err("a cue needs its text".to_owned());
        }
        match cue.get("source") {
            None | Some(Value::Null) => {}
            Some(Value::String(source)) if is_source(source) => {}
            Some(_) => {
                return Err(
                    "a cue's source must be a recording in the recordings folder".to_owned(),
                );
            }
        }
        let ms = |key: &str| cue.get(key).and_then(Value::as_f64);
        match (ms("startMs"), ms("endMs")) {
            (Some(start), Some(end)) if start >= 0.0 && end > start => Ok(()),
            _ => Err("a cue needs a startMs before its endMs".to_owned()),
        }
    })
}

/// A clip plays a stretch of one source, or is a gap of a specified length.
fn validate_clip(clip: &Value, version: u64) -> Result<(), String> {
    let text = |key: &str| {
        clip.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    if text("id").is_none() {
        return Err("a clip needs an id".to_owned());
    }
    if let Some(gap) = clip.get("gapMs") {
        if version < 3 {
            return Err("gaps need edits version 3".to_owned());
        }
        return match gap.as_f64() {
            Some(ms) if ms > 0.0 => Ok(()),
            _ => Err("a gap needs a gapMs above 0".to_owned()),
        };
    }
    let valid_source = text("source").is_some_and(|source| {
        if version >= 4 {
            is_source(source)
        } else {
            !source.contains(['/', '\\']) && source != ".."
        }
    });
    if !valid_source {
        return Err("a clip needs the name of a recording in the recordings folder".to_owned());
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
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

/// The field `key` of a recording's pointer sidecar, or `None` when the
/// sidecar, or that field, is missing or unreadable.
fn sidecar_field(video: &Path, key: &str) -> Option<Value> {
    fs::read(cursor_path(video))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|mut value| value.get_mut(key).map(Value::take))
}

/// The sources in a recording's pointer sidecar's `audio`, or `None` when
/// the sidecar, or its `audio`, is missing or unreadable.
fn sidecar_audio(video: &Path) -> Option<Vec<SoundSource>> {
    sidecar_field(video, "audio").and_then(|audio| serde_json::from_value(audio).ok())
}

/// Whether background noise was removed from the microphone in the MP4's
/// sound, as its pointer sidecar's `removeNoise` says. False when that is
/// absent: the recording was made without it, or before it could be.
pub fn sidecar_remove_noise(video: &Path) -> bool {
    sidecar_field(video, "removeNoise").and_then(|value| value.as_bool()) == Some(true)
}

/// A recording's sound sidecar when it holds the microphone apart, which
/// an export can mix again with or without noise removal: the microphone
/// is its `a:0`, and system sound, when recorded, its `a:1`. Both are
/// unfiltered and lined up with the video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptSound {
    pub file: PathBuf,
    /// Whether system sound is its `a:1`.
    pub system: bool,
}

/// The kept sound among `sources`, `video`'s [`audio_sources`], or `None`
/// when its microphone is not kept apart in the sound sidecar.
fn kept_sound_in(video: &Path, sources: &[AudioSource]) -> Option<KeptSound> {
    match sources {
        [microphone, rest @ ..]
            if microphone.kind == AudioKind::Microphone
                && microphone.stream == 0
                && microphone.file != video =>
        {
            Some(KeptSound {
                file: microphone.file.clone(),
                system: rest.first().is_some_and(|system| {
                    system.kind == AudioKind::System
                        && system.stream == 1
                        && system.file == microphone.file
                }),
            })
        }
        _ => None,
    }
}

/// `video`'s kept sound, or `None` when its microphone is not kept apart.
/// Never probes the MP4: a recording without a sound sidecar has none.
pub fn kept_sound(video: &Path) -> Option<KeptSound> {
    kept_sound_in(video, &audio_sources_with(video, || false))
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
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: PathBuf,
    pub file_name: String,
    /// The recording's source reference within the recordings folder.
    pub source: String,
    /// The folder the file picker starts in, containing flat files and months.
    pub recordings_folder: PathBuf,
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
    /// Whether background noise was removed from the microphone in the
    /// MP4's sound, from its pointer sidecar.
    pub remove_noise: bool,
    /// Whether the sound sidecar keeps its microphone apart, so an export
    /// can remove background noise or leave it in ([`kept_sound`]).
    pub separate_microphone: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn recording_info(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingInfo, String> {
    let RecordingFile {
        path,
        source,
        recordings_folder,
    } = state.recording_for(window.label())?;
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
    let (audio, separate_microphone) = tauri::async_runtime::spawn_blocking(move || {
        let sources = audio_sources(&video, ffmpeg.as_deref());
        let separate = kept_sound_in(&video, &sources).is_some();
        (
            sources.into_iter().map(|source| source.kind).collect(),
            separate,
        )
    })
    .await
    .map_err(|err| format!("could not read the recording's sound: {err}"))?;
    Ok(RecordingInfo {
        remove_noise: sidecar_remove_noise(&path),
        path,
        file_name,
        source,
        recordings_folder,
        edits,
        fps,
        cursor,
        audio,
        separate_microphone,
    })
}

#[tauri::command]
#[specta::specta]
pub fn recording_save_edits(
    edits: Value,
    window: WebviewWindow,
    state: State<'_, RecordingEditorState>,
) -> Result<(), String> {
    let recording = state.recording_for(window.label())?;
    write_edits(&recording.path, &edits)
}

/// A recording a clip of the sequence plays. Mirrors `RecordingSource` in
/// src/recording/api.ts.
#[derive(Debug, Clone, Serialize, specta::Type)]
// Named apart from the settings' `RecordingSource` in the bindings. A
// struct's name never reaches the JSON, so the wire format is unchanged.
#[serde(rename = "RecordingClipSource", rename_all = "camelCase")]
pub struct RecordingSource {
    pub path: PathBuf,
    pub file_name: String,
    /// The recording's source reference within the recordings folder.
    pub source: String,
    /// The frame rate it was recorded at.
    pub fps: u32,
    /// Its pointer path, for follow-the-pointer zooms.
    pub cursor: Option<CursorPath>,
    /// Whether it holds sound.
    pub has_audio: bool,
    /// Each source of its sound, by kind, in [`audio_sources`]' order, as
    /// `RecordingInfo.audio` lists the opened recording's: what its
    /// waveform lanes draw. Before ffmpeg is ready an older recording
    /// lists none.
    pub audio: Vec<AudioKind>,
    /// Whether background noise was removed from the microphone in the
    /// MP4's sound, from its pointer sidecar.
    pub remove_noise: bool,
    /// Whether the sound sidecar keeps its microphone apart, so an export
    /// can remove background noise or leave it in ([`kept_sound`]).
    pub separate_microphone: bool,
}

/// A source is a bare MP4 name or `YYYY-MM/name.mp4`, with a portable
/// slash as the separator in edits and IPC.
fn is_source(source: &str) -> bool {
    let file = match source.split_once('/') {
        Some((month, file)) if is_month_folder(month.as_ref()) => file,
        Some(_) => return false,
        None => source,
    };
    !(file.contains(['/', '\\', '\0']) || cfg!(windows) && file.contains(':'))
        && Path::new(file).file_name() == Some(file.as_ref())
        && is_mp4(Path::new(file))
}

/// Resolves a clip reference within the recording editor's media root.
fn source_file(recordings: &Path, source: &str) -> Result<PathBuf, String> {
    if is_source(source)
        && let Some(path) = allowed_video(recordings, &recordings.join(source))
    {
        return Ok(path);
    }
    Err(format!(
        "{source} is not a recording in the recordings folder"
    ))
}

/// The root for an earlier save folder, or for a file named through a
/// recordings-folder alias rather than its canonical path.
fn named_recordings_root(original: &Path) -> Option<&Path> {
    let parent = original.parent()?;
    let root = if parent.file_name().is_some_and(is_month_folder) {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    root.file_name()
        .filter(|name| name.eq_ignore_ascii_case(RECORDINGS_DIR))
        .map(|_| root)
}

/// What the editor needs to play and export `file_name` from the
/// recordings folder as a clip. Refuses any other file, or one that is
/// gone. Whether it has sound is asked of ffmpeg; before ffmpeg is ready
/// it is assumed to have some.
#[tauri::command]
#[specta::specta]
pub async fn recording_source(
    file_name: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingSource, String> {
    let path = state.source_for(window.label(), &file_name)?;
    load_source(&app, path, file_name).await
}

/// Resolves the file picker result to a source in the editor's recordings folder.
#[tauri::command]
#[specta::specta]
pub async fn recording_pick_source(
    path: PathBuf,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingSource, String> {
    let original = state.recording_for(window.label())?;
    let RecordingFile { path, source, .. } =
        recording_reference(&original.recordings_folder, &path)
            .ok_or_else(|| "Only recordings in the recordings folder can be added.".to_owned())?;
    load_source(&app, path, source).await
}

async fn load_source(
    app: &AppHandle,
    path: PathBuf,
    source: String,
) -> Result<RecordingSource, String> {
    let ffmpeg = ffmpeg::ready(app).map(|ready| ready.path);
    tauri::async_runtime::spawn_blocking(move || {
        let has_audio = ffmpeg
            .as_deref()
            .is_none_or(|ffmpeg| ffmpeg::probe_file(ffmpeg, &path).audio);
        let audio = audio_sources(&path, ffmpeg.as_deref())
            .into_iter()
            .map(|source| source.kind)
            .collect();
        RecordingSource {
            fps: recording_fps(&path),
            cursor: CursorPath::load(&path),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            source,
            has_audio,
            audio,
            remove_noise: sidecar_remove_noise(&path),
            separate_microphone: kept_sound(&path).is_some(),
            path,
        }
    })
    .await
    .map_err(|err| format!("could not read the recording: {err}"))
}

// --- Serving the recording ------------------------------------------------

/// The canonical MP4 a request names, within the flat or monthly layout.
pub fn allowed_video(recordings: &Path, requested: &Path) -> Option<PathBuf> {
    recording_reference(recordings, requested).map(|recording| recording.path)
}

fn is_mp4(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
}

fn recording_reference(recordings: &Path, requested: &Path) -> Option<RecordingFile> {
    if !is_mp4(requested) {
        return None;
    }
    let root = fs::canonicalize(recordings).ok()?;
    let file = fs::canonicalize(requested).ok()?;
    let mut relative = file.strip_prefix(&root).ok()?.components();
    let Some(Component::Normal(first)) = relative.next() else {
        return None;
    };
    let reference = match relative.next() {
        None => first.to_str()?.to_owned(),
        Some(Component::Normal(name)) if is_month_folder(first) && relative.next().is_none() => {
            format!("{}/{}", first.to_str()?, name.to_str()?)
        }
        _ => return None,
    };
    (is_source(&reference) && file.is_file()).then_some(RecordingFile {
        path: file,
        source: reference,
        recordings_folder: root,
    })
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

/// Serves MP4s in the recordings folder associated with this webview.
pub fn serve_video(app: &AppHandle, label: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    // A fetch with a Range header from the page's origin asks first.
    if request.method() == tauri::http::Method::OPTIONS {
        return preflight();
    }
    let original = app
        .try_state::<RecordingEditorState>()
        .and_then(|state| state.recording_for(label).ok());
    let allowed = original.zip(requested_path(request.uri().path()));
    let Some(path) =
        allowed.and_then(|(original, path)| allowed_video(&original.recordings_folder, &path))
    else {
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
}

/// A stretch of the sequence with no clip: the backdrop with a black video
/// box, and silence. Mirrors `ExportGap` in src/recording/api.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportGap {
    /// How long it lasts.
    pub gap_ms: u64,
}

/// One entry of an export's sequence: a gap or a clip. Mirrors
/// `ExportEntry` in src/recording/api.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ExportEntry {
    Gap(ExportGap),
    Clip(ExportClip),
}

impl From<ExportClip> for ExportEntry {
    fn from(clip: ExportClip) -> Self {
        Self::Clip(clip)
    }
}

impl ExportEntry {
    /// The clip, or `None` for a gap.
    pub fn clip(&self) -> Option<&ExportClip> {
        match self {
            Self::Clip(clip) => Some(clip),
            Self::Gap(_) => None,
        }
    }

    /// Refuses an entry that could not be rendered into a `video` box.
    pub fn check(&self, video: (u32, u32)) -> Result<(), String> {
        match self {
            Self::Clip(clip) => clip.check(video),
            Self::Gap(gap) if gap.gap_ms < MIN_EXPORT_MS => {
                Err("a gap is too short to export".to_owned())
            }
            Self::Gap(_) => Ok(()),
        }
    }

    /// How long it plays.
    pub fn duration_ms(&self) -> u64 {
        match self {
            Self::Clip(clip) => clip.duration_ms(),
            Self::Gap(gap) => gap.gap_ms,
        }
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
    /// The sequence, played in order: clips and the gaps between them.
    pub clips: Vec<ExportEntry>,
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
    /// Whether background noise is removed from the microphone of every
    /// clip whose recording keeps it apart. Other clips keep the sound
    /// they were recorded with.
    #[serde(default)]
    pub remove_noise: bool,
    /// Images laid over the finished frames for a stretch of the output,
    /// such as captions. Their PNGs follow the mask in the body, in order.
    #[serde(default)]
    pub overlays: Vec<ExportOverlay>,
}

/// An image laid over every output frame from `start_ms` until `end_ms`,
/// in the exported sequence's time, with its top-left corner at `x`, `y`
/// in output pixels. Mirrors `ExportOverlay` in src/recording/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOverlay {
    pub start_ms: u64,
    pub end_ms: u64,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// How many bytes of the body its PNG takes.
    pub bytes: usize,
}

impl ExportOverlay {
    /// Refuses an overlay that shows for no time or would not fit in a
    /// `width` × `height` output.
    fn check(&self, (width, height): (u32, u32)) -> Result<(), String> {
        if self.start_ms >= self.end_ms {
            return Err("an overlay must end after it starts".to_owned());
        }
        if self.width == 0
            || self.height == 0
            || self.bytes == 0
            || self.x.saturating_add(self.width) > width
            || self.y.saturating_add(self.height) > height
        {
            return Err("an overlay does not fit inside the export".to_owned());
        }
        Ok(())
    }
}

/// An overlay's image, read from the body, and when it shows.
#[derive(Debug, Clone, PartialEq)]
pub struct OverlayImage {
    pub start_ms: u64,
    pub end_ms: u64,
    pub x: u32,
    pub y: u32,
    pub image: RgbaImage,
}

impl OverlayImage {
    /// Whether it shows on the frame `ms` into the output.
    fn shows_at(&self, ms: u64) -> bool {
        (self.start_ms..self.end_ms).contains(&ms)
    }

    /// Lays the image over `frame` with its own transparency.
    fn draw(&self, frame: &mut RgbaImage) {
        let (frame_width, frame_height) = frame.dimensions();
        for (col, row, pixel) in self.image.enumerate_pixels() {
            let (x, y) = (self.x + col, self.y + row);
            if x >= frame_width || y >= frame_height {
                continue;
            }
            let alpha = u32::from(pixel.0[3]);
            if alpha == 0 {
                continue;
            }
            let under = frame.get_pixel_mut(x, y);
            for channel in 0..3 {
                let below = u32::from(under.0[channel]);
                let over = u32::from(pixel.0[channel]);
                under.0[channel] = ((over * alpha + below * (255 - alpha) + 127) / 255) as u8;
            }
            let below = u32::from(under.0[3]);
            under.0[3] = (alpha + (below * (255 - alpha) + 127) / 255) as u8;
        }
    }
}

/// Lays every overlay showing `ms` into the output over `frame`, in order.
fn draw_overlays(frame: &mut RgbaImage, overlays: &[OverlayImage], ms: u64) {
    for overlay in overlays.iter().filter(|overlay| overlay.shows_at(ms)) {
        overlay.draw(frame);
    }
}

/// How far into the output frame `index` is, at `fps`.
fn frame_ms(index: u64, fps: u32) -> u64 {
    index * 1000 / u64::from(fps.max(1))
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
        if !self.clips.iter().any(|entry| entry.clip().is_some()) {
            return Err("there is nothing to export".to_owned());
        }
        self.overlays
            .iter()
            .try_for_each(|overlay| overlay.check((self.width, self.height)))?;
        self.clips
            .iter()
            .try_for_each(|entry| entry.check((self.video_width, self.video_height)))
    }

    /// How many frames the export holds at `fps`, over all its clips and gaps.
    pub fn frames(&self, fps: u32) -> u64 {
        self.clips.iter().map(|entry| entry.frames(fps)).sum()
    }

    /// How long the export plays.
    pub fn duration_ms(&self) -> u64 {
        self.clips.iter().map(ExportEntry::duration_ms).sum()
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

/// Where a clip's sound is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundFrom<'a> {
    /// Nothing: a gap, or a recording without sound.
    Silence,
    /// The MP4's own sound, as it was recorded.
    Video(&'a Path),
    /// The sound sidecar's unfiltered sources, mixed as the recording
    /// mixed them. With `noise_model`, background noise is first removed
    /// from the microphone alone with that RNNoise model.
    Kept {
        kept: &'a KeptSound,
        noise_model: Option<&'a Path>,
    },
}

/// One entry's sound: a stretch of its recording, or silence as long as
/// the stretch.
pub struct ClipSound<'a> {
    pub start_ms: u64,
    pub end_ms: u64,
    pub from: SoundFrom<'a>,
}

impl<'a> ClipSound<'a> {
    /// `entry`'s sound: read `from` for a clip, silence for a gap.
    pub fn of(entry: &ExportEntry, from: SoundFrom<'a>) -> Self {
        match entry {
            ExportEntry::Clip(clip) => Self {
                start_ms: clip.start_ms,
                end_ms: clip.end_ms,
                from,
            },
            ExportEntry::Gap(gap) => Self {
                start_ms: 0,
                end_ms: gap.gap_ms,
                from: SoundFrom::Silence,
            },
        }
    }

    fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

/// Where `source`'s sound is read from when the export removes
/// background noise (`remove_noise`) or not: the MP4, as recorded, when
/// its sound already matches, otherwise its kept sound mixed again,
/// through `noise_model` when removing noise. A recording that does not
/// keep its microphone apart always gives its MP4. Refuses to remove
/// noise without the model.
fn sound_from<'a>(
    source: Option<&'a ClipSource>,
    remove_noise: bool,
    noise_model: Option<&'a Path>,
) -> Result<SoundFrom<'a>, String> {
    let Some(source) = source.filter(|source| source.has_audio) else {
        return Ok(SoundFrom::Silence);
    };
    match &source.kept {
        Some(kept) if source.remove_noise != remove_noise => {
            if remove_noise && noise_model.is_none() {
                return Err(NO_NOISE_MODEL.to_owned());
            }
            Ok(SoundFrom::Kept {
                kept,
                noise_model: noise_model.filter(|_| remove_noise),
            })
        }
        _ => Ok(SoundFrom::Video(&source.path)),
    }
}

/// Why an export that removes background noise cannot.
pub(crate) const NO_NOISE_MODEL: &str = "the background noise model is missing from this install of \
     Grab-it; reinstall it, or turn off Remove background noise";

/// The file `clip`'s sound is read from, or `None` for silence.
pub fn clip_sound_file<'a>(clip: &ClipSound<'a>) -> Option<&'a Path> {
    match clip.from {
        SoundFrom::Silence => None,
        SoundFrom::Video(file) => Some(file),
        SoundFrom::Kept { kept, .. } => Some(kept.file.as_path()),
    }
}

/// Adds to `filters` the graph that brings `clip`'s sound, from ffmpeg
/// input `input` (`None` for silence), to `[a<index>]`: 48 kHz stereo,
/// exactly the clip's length, its microphone denoised when asked and
/// mixed with system sound as recording mixed them. The export and the
/// editor's audio auditions share it, so an audition sounds as the
/// export will.
pub fn push_clip_sound(
    filters: &mut Vec<String>,
    clip: &ClipSound<'_>,
    input: Option<usize>,
    index: usize,
) {
    match input {
        Some(inputs) => {
            let trim = |stream: usize| {
                format!(
                    "[{inputs}:a:{stream}]atrim=start={}:end={},asetpts=PTS-STARTPTS,",
                    seconds(clip.start_ms),
                    seconds(clip.end_ms),
                )
            };
            // The stretch, ready for the format every clip shares.
            let sound = match clip.from {
                SoundFrom::Kept { kept, noise_model } => {
                    let denoise = noise_model
                        .map(|model| format!("{},", ffmpeg::noise_filter(model)))
                        .unwrap_or_default();
                    if kept.system {
                        // Trimmed before noise removal, so only the
                        // stretch kept goes through the model.
                        filters.push(format!(
                            "{}{denoise}{}[m{index}]",
                            trim(0),
                            ffmpeg::MIX_FORMAT
                        ));
                        filters.push(format!("{}{}[s{index}]", trim(1), ffmpeg::MIX_FORMAT));
                        format!("[m{index}][s{index}]{},", ffmpeg::mix(2))
                    } else {
                        format!("{}{denoise}", trim(0))
                    }
                }
                _ => trim(0),
            };
            // Padded with silence and cut to the clip's length, so a
            // sound track that ends early never pulls later clips'
            // sound ahead of their frames.
            filters.push(format!(
                "{sound}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
                 apad,atrim=duration={}[a{index}]",
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

/// ffmpeg's arguments to write `output` from the silent `video` with each
/// clip's stretch of its recording's sound, resampled to 48 kHz stereo
/// and joined in order, as AAC. Each clip's sound is exactly its length:
/// padded with silence where its recording's sound stops early, and
/// silence throughout when its recording has none or it is a gap. A clip
/// read from its kept sound has its stretch of the microphone, denoised
/// when asked, mixed with its stretch of system sound, as recording
/// mixed them.
pub fn clip_sound_args(video: &Path, clips: &[ClipSound<'_>], output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(video.as_os_str().to_owned());
    let mut filters = Vec::new();
    let mut inputs = 0;
    for (index, clip) in clips.iter().enumerate() {
        let input = clip_sound_file(clip).map(|file| {
            args.push("-i".into());
            args.push(file.as_os_str().to_owned());
            inputs += 1;
            inputs
        });
        push_clip_sound(&mut filters, clip, input, index);
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

/// Reads a PNG from the export request's body.
fn decode_png(bytes: &[u8], what: &str) -> Result<RgbaImage, String> {
    image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map(|image| image.into_rgba8())
        .map_err(|err| format!("could not read the {what}: {err}"))
}

/// Splits the export request's body into the backdrop and mask images
/// and the overlays' images, whose PNGs come last.
/// The backdrop and mask images, when sent, and the overlays' images.
type ExportBody = (Option<(RgbaImage, RgbaImage)>, Vec<OverlayImage>);

fn read_body(body: &[u8], plan: &ExportPlan) -> Result<ExportBody, String> {
    let overlay_bytes = plan
        .overlays
        .iter()
        .try_fold(0usize, |total, overlay| total.checked_add(overlay.bytes))
        .filter(|&total| total <= body.len())
        .ok_or("the export is missing its overlays")?;
    let (layers, mut rest) = body.split_at(body.len() - overlay_bytes);
    let layers = backdrop_and_mask(layers, plan)?;
    let overlays = plan
        .overlays
        .iter()
        .map(|overlay| {
            let (png, next) = rest.split_at(overlay.bytes);
            rest = next;
            let image = decode_png(png, "overlay")?;
            if image.dimensions() != (overlay.width, overlay.height) {
                return Err(format!(
                    "an overlay must be {}×{}",
                    overlay.width, overlay.height
                ));
            }
            Ok(OverlayImage {
                start_ms: overlay.start_ms,
                end_ms: overlay.end_ms,
                x: overlay.x,
                y: overlay.y,
                image,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((layers, overlays))
}

/// Splits the body's layers, everything before the overlays, into the
/// backdrop and mask images.
fn backdrop_and_mask(
    body: &[u8],
    plan: &ExportPlan,
) -> Result<Option<(RgbaImage, RgbaImage)>, String> {
    if plan.backdrop_bytes == 0 {
        if !body.is_empty() {
            return Err("the export has a mask without a backdrop".to_owned());
        }
        return Ok(None);
    }
    if plan.backdrop_bytes >= body.len() {
        return Err("the export is missing its mask".to_owned());
    }
    let (backdrop, mask) = body.split_at(plan.backdrop_bytes);
    Ok(Some((
        decode_png(backdrop, "backdrop")?,
        decode_png(mask, "mask")?,
    )))
}

/// The recording behind one clip of an export.
struct ClipSource {
    path: PathBuf,
    /// The pointer path follow-the-pointer zooms centre on.
    cursor: Option<CursorPath>,
    has_audio: bool,
    /// Whether the MP4's microphone had background noise removed.
    remove_noise: bool,
    /// Its microphone kept apart, when it is.
    kept: Option<KeptSound>,
}

/// One export to render.
struct ExportJob<'a> {
    output: &'a Path,
    plan: ExportPlan,
    /// Each clip's recording, in the plan's order; `None` for a gap.
    sources: Vec<Option<ClipSource>>,
    /// The backdrop and mask, or none for the video alone.
    layers: Option<(RgbaImage, RgbaImage)>,
    /// What is laid over the finished frames, and when.
    overlays: Vec<OverlayImage>,
    /// The opened recording's frame rate, which every clip is decoded at.
    fps: u32,
    bits_per_pixel: f64,
    /// The RNNoise model, when the plan removes background noise and it
    /// is installed.
    noise_model: Option<PathBuf>,
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
    cancelled: &AtomicBool,
    mut progress: impl FnMut(ExportProgress),
) -> Result<(), String> {
    check_cancelled(cancelled)?;
    let ExportJob {
        output,
        plan,
        sources,
        layers,
        overlays,
        fps,
        bits_per_pixel,
        noise_model,
    } = job;
    let plan = &plan;
    if sources.len() != plan.clips.len() {
        return Err("every clip needs its recording".to_owned());
    }
    // Where each clip's sound comes from, settled before minutes of
    // encoding.
    let sounds = plan
        .clips
        .iter()
        .zip(&sources)
        .map(|(entry, source)| {
            sound_from(source.as_ref(), plan.remove_noise, noise_model.as_deref())
                .map(|from| ClipSound::of(entry, from))
        })
        .collect::<Result<Vec<_>, String>>()?;
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
        // A gap's frame: the backdrop with a black video box, or all black.
        let gap_frame = || -> Result<RgbaImage, String> {
            let boxed = black(plan.video_width, plan.video_height);
            match &composer {
                Some(composer) => Ok(composer.compose(&boxed)),
                None => RgbaImage::from_raw(plan.width, plan.height, boxed)
                    .ok_or_else(|| "a frame was the wrong size".to_owned()),
            }
        };
        let mut report = |done: u64| {
            let percent = (done * 100).checked_div(total).unwrap_or(100);
            if last_percent != Some(percent) {
                last_percent = Some(percent);
                progress(ExportProgress {
                    done: done.min(total),
                    total,
                });
            }
        };
        for (entry, source) in plan.clips.iter().zip(&sources) {
            let (clip, source) = match (entry, source) {
                (ExportEntry::Clip(clip), Some(source)) => (clip, source),
                (ExportEntry::Gap(_), _) => {
                    let frame = gap_frame()?;
                    for _ in 0..entry.frames(fps) {
                        check_cancelled(cancelled)?;
                        let ms = frame_ms(done, fps);
                        if overlays.iter().any(|overlay| overlay.shows_at(ms)) {
                            let mut covered = frame.clone();
                            draw_overlays(&mut covered, &overlays, ms);
                            video.write(&covered).map_err(|err| err.to_string())?;
                        } else {
                            video.write(&frame).map_err(|err| err.to_string())?;
                        }
                        done += 1;
                        report(done);
                    }
                    continue;
                }
                (ExportEntry::Clip(_), None) => {
                    return Err("every clip needs its recording".to_owned());
                }
            };
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
                check_cancelled(cancelled)?;
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
                let mut frame = match &composer {
                    Some(composer) => composer.compose(shown),
                    None => RgbaImage::from_raw(plan.width, plan.height, shown.to_vec())
                        .ok_or("a frame was the wrong size")?,
                };
                draw_overlays(&mut frame, &overlays, frame_ms(done, fps));
                video.write(&frame).map_err(|err| err.to_string())?;
                done += 1;
                report(done);
                Ok(())
            })?;
            if frames == 0 {
                return Err(format!(
                    "the trimmed stretch of {} holds no frames",
                    clip.source
                ));
            }
        }
        check_cancelled(cancelled)?;
        let finished = video.finish_cancellable(|| cancelled.load(Ordering::Relaxed));
        check_cancelled(cancelled)?;
        finished.map_err(|err| err.to_string())?;
        check_cancelled(cancelled)?;
        let mux = ffmpeg::run_cancellable(
            &ready.path,
            clip_sound_args(&silent, &sounds, output),
            MUX_TIMEOUT,
            || cancelled.load(Ordering::Relaxed),
        );
        check_cancelled(cancelled)?;
        mux.map_err(|err| format!("could not add the sound: {err}"))
    })();
    let _ = fs::remove_file(&silent);
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

/// Requests cancellation of the export running in this editor window.
#[tauri::command]
#[specta::specta]
pub fn recording_export_cancel(window: WebviewWindow, state: State<'_, RecordingEditorState>) {
    state.cancel_export(window.label());
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
    let original = state.recording_for(window.label())?;
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
    let path = allowed_video(&original.recordings_folder, &original.path)
        .ok_or("the recording is no longer in the recordings folder")?;
    let cancelled = state.begin_export(&label, &path)?;
    // Minutes of decoding and encoding: on a thread of its own, not the
    // async runtime's.
    let result = tauri::async_runtime::spawn_blocking(move || {
        export(&app, &ready, &original, plan, &body, &label, &cancelled)
    })
    .await;
    state.finish_export(window.label());
    result.map_err(|err| format!("the export stopped: {err}"))?
}

/// The recording each clip of `plan` plays, from `recordings`; `None` for
/// a gap. A clip of any other file, or of one that is gone, refuses the
/// export.
fn clip_sources(
    ffmpeg_path: &Path,
    recordings: &Path,
    plan: &ExportPlan,
    cancelled: &AtomicBool,
) -> Result<Vec<Option<ClipSource>>, String> {
    plan.clips
        .iter()
        .map(|entry| {
            check_cancelled(cancelled)?;
            let Some(clip) = entry.clip() else {
                return Ok(None);
            };
            let path = source_file(recordings, &clip.source)?;
            let probe = ffmpeg::probe_file_cancellable(ffmpeg_path, &path, || {
                cancelled.load(Ordering::Relaxed)
            });
            check_cancelled(cancelled)?;
            Ok(Some(ClipSource {
                cursor: CursorPath::load(&path),
                has_audio: probe.audio,
                remove_noise: sidecar_remove_noise(&path),
                kept: kept_sound(&path),
                path,
            }))
        })
        .collect()
}

/// Renders `plan`'s sequence beside `original`, the recording the editor
/// opened, then shows the export on the Quick Access card. Returns its path.
fn export(
    app: &AppHandle,
    ready: &ffmpeg::Ready,
    recording: &RecordingFile,
    plan: ExportPlan,
    body: &[u8],
    label: &str,
    cancelled: &AtomicBool,
) -> Result<PathBuf, String> {
    let original = &recording.path;
    let fps = export_fps(&ready.path, original);
    let report = |progress: ExportProgress| {
        let _ = app.emit_to(
            EventTarget::webview_window(label),
            EXPORT_PROGRESS_EVENT,
            progress,
        );
    };
    report(ExportProgress {
        done: 0,
        total: plan.frames(fps),
    });
    let (layers, overlays) = read_body(body, &plan)?;
    let bits_per_pixel = app
        .try_state::<SettingsState>()
        .map(|state| lock(&state).get().recording.quality.bits_per_pixel())
        .unwrap_or_else(|| crate::settings::RecordingQuality::High.bits_per_pixel());
    // Every clip comes from the recordings folder the editor opened from.
    let sources = clip_sources(&ready.path, &recording.recordings_folder, &plan, cancelled)?;
    // Missing, an export that removes noise from a clip is refused.
    let noise_model = if plan.remove_noise {
        crate::noise::bundled_model(app)
    } else {
        None
    };
    let output = edited_path(original);
    let duration_ms = plan.duration_ms();
    let job = ExportJob {
        output: &output,
        plan,
        sources,
        layers,
        overlays,
        fps,
        bits_per_pixel,
        noise_model,
    };
    render(ready, job, cancelled, report)?;
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

    #[test]
    fn the_kept_microphone_and_noise_removal_come_from_the_sidecars() {
        let both = r#"{"version":1,"fps":30,"audio":["microphone","system"]}"#;
        let (_dir, video) = recording_with(Some(both), true);
        assert_eq!(
            kept_sound(&video),
            Some(KeptSound {
                file: sound_path(&video),
                system: true,
            })
        );
        assert!(!sidecar_remove_noise(&video));

        let denoised = r#"{"audio":["microphone"],"removeNoise":true}"#;
        let (_dir, video) = recording_with(Some(denoised), true);
        assert_eq!(
            kept_sound(&video),
            Some(KeptSound {
                file: sound_path(&video),
                system: false,
            })
        );
        assert!(sidecar_remove_noise(&video));

        // System sound alone has no microphone to remove noise from.
        let (_dir, video) = recording_with(Some(r#"{"audio":["system"]}"#), true);
        assert_eq!(kept_sound(&video), None);
        // Without the sound sidecar, the MP4's one track cannot be split.
        let (_dir, video) = recording_with(Some(both), false);
        assert_eq!(kept_sound(&video), None);
        // An older recording, or one whose sidecar says something else.
        let (_dir, video) = recording_with(None, false);
        assert_eq!(kept_sound(&video), None);
        assert!(!sidecar_remove_noise(&video));
        let (_dir, video) = recording_with(Some(r#"{"removeNoise":"yes"}"#), false);
        assert!(!sidecar_remove_noise(&video));
    }

    /// A clip's recording at `/rec/clip.mp4`, with sound, its MP4
    /// denoised when `remove_noise`, and its microphone kept apart when
    /// `kept`.
    fn sounding(remove_noise: bool, kept: bool) -> ClipSource {
        ClipSource {
            path: PathBuf::from("/rec/clip.mp4"),
            cursor: None,
            has_audio: true,
            remove_noise,
            kept: kept.then(|| KeptSound {
                file: PathBuf::from("/rec/clip.sound.m4a"),
                system: true,
            }),
        }
    }

    #[test]
    fn the_kept_sound_is_used_only_when_the_toggle_differs_from_the_mp4() {
        let model = Path::new("/opt/bd.rnnn");
        let video = Path::new("/rec/clip.mp4");
        // As recorded: the MP4's own sound, either way.
        for remove_noise in [false, true] {
            let source = sounding(remove_noise, true);
            assert_eq!(
                sound_from(Some(&source), remove_noise, Some(model)),
                Ok(SoundFrom::Video(video))
            );
        }
        // Turned on for a recording made without it: denoised from the
        // kept sound.
        let plain = sounding(false, true);
        assert_eq!(
            sound_from(Some(&plain), true, Some(model)),
            Ok(SoundFrom::Kept {
                kept: plain.kept.as_ref().unwrap(),
                noise_model: Some(model),
            })
        );
        // Turned off for a recording made with it: the kept sound as heard.
        let denoised = sounding(true, true);
        assert_eq!(
            sound_from(Some(&denoised), false, Some(model)),
            Ok(SoundFrom::Kept {
                kept: denoised.kept.as_ref().unwrap(),
                noise_model: None,
            })
        );
        // Without a kept microphone a clip exports as it is.
        let older = sounding(false, false);
        assert_eq!(
            sound_from(Some(&older), true, Some(model)),
            Ok(SoundFrom::Video(video))
        );
        // Silence for a gap or a recording without sound.
        assert_eq!(sound_from(None, true, Some(model)), Ok(SoundFrom::Silence));
        let silent = ClipSource {
            has_audio: false,
            ..sounding(false, true)
        };
        assert_eq!(
            sound_from(Some(&silent), true, Some(model)),
            Ok(SoundFrom::Silence)
        );
    }

    #[test]
    fn removing_noise_without_the_model_is_refused() {
        let plain = sounding(false, true);
        assert_eq!(
            sound_from(Some(&plain), true, None),
            Err(NO_NOISE_MODEL.to_owned())
        );
        // Turning it off needs no model.
        let denoised = sounding(true, true);
        assert!(sound_from(Some(&denoised), false, None).is_ok());
    }

    #[test]
    fn noise_removal_comes_with_the_plan_and_is_off_without_it() {
        let json = |extra: &str| {
            format!(
                r#"{{"clips":[{{"source":"a.mp4","startMs":0,"endMs":5000,
                    "sourceWidth":1920,"sourceHeight":1080,"x":0,"y":0,"width":1920,"height":1080}}],
                    "width":1920,"height":1080,"x":0,"y":0,
                    "videoWidth":1920,"videoHeight":1080,"backdropBytes":0{extra}}}"#
            )
        };
        let plan = |extra: &str| serde_json::from_str::<ExportPlan>(&json(extra)).unwrap();
        assert!(!plan("").remove_noise);
        assert!(plan(r#","removeNoise":true"#).remove_noise);
    }

    #[test]
    fn noise_is_removed_from_the_kept_microphone_and_mixed_with_system_sound() {
        let kept = KeptSound {
            file: PathBuf::from("/rec/clip.sound.m4a"),
            system: true,
        };
        let sounds = [ClipSound::of(
            &clip().into(),
            SoundFrom::Kept {
                kept: &kept,
                noise_model: Some(Path::new("/opt/bd.rnnn")),
            },
        )];
        assert_eq!(
            strings(clip_sound_args(
                Path::new("/rec/clip (edited).exporting.mp4"),
                &sounds,
                Path::new("/rec/clip (edited).mp4"),
            )),
            "-hide_banner -loglevel error -y -i /rec/clip (edited).exporting.mp4 \
             -i /rec/clip.sound.m4a -filter_complex \
             [1:a:0]atrim=start=1.250:end=9.500,asetpts=PTS-STARTPTS,\
             arnndn=m=/opt/bd.rnnn,aformat=sample_rates=48000:channel_layouts=stereo[m0];\
             [1:a:1]atrim=start=1.250:end=9.500,asetpts=PTS-STARTPTS,\
             aformat=sample_rates=48000:channel_layouts=stereo[s0];\
             [m0][s0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,\
             aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration=8.250[a0];\
             [a0]concat=n=1:v=0:a=1[sound] \
             -map 0:v:0 -map [sound] -c:v copy -c:a aac -b:a 160k -shortest \
             -movflags +faststart /rec/clip (edited).mp4"
        );
    }

    #[test]
    fn a_kept_microphone_alone_is_exported_unfiltered_when_turned_off() {
        let kept = KeptSound {
            file: PathBuf::from("/rec/clip.sound.m4a"),
            system: false,
        };
        let sounds = [ClipSound::of(
            &clip().into(),
            SoundFrom::Kept {
                kept: &kept,
                noise_model: None,
            },
        )];
        let args = strings(clip_sound_args(
            Path::new("/rec/clip (edited).exporting.mp4"),
            &sounds,
            Path::new("/rec/clip (edited).mp4"),
        ));
        assert!(
            args.contains(
                "-i /rec/clip.sound.m4a -filter_complex \
                 [1:a:0]atrim=start=1.250:end=9.500,asetpts=PTS-STARTPTS,\
                 aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
                 apad,atrim=duration=8.250[a0];"
            ),
            "{args}"
        );
        assert!(!args.contains("arnndn"));
        assert!(!args.contains("amix"));
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
            clips: vec![clip().into()],
            width: 1080,
            height: 1920,
            x: 60,
            y: 656,
            video_width: 960,
            video_height: 540,
            backdrop_bytes: 10,
            remove_noise: false,
            overlays: Vec::new(),
        }
    }

    #[test]
    fn cancellation_is_scoped_to_one_window_and_one_export() {
        let state = RecordingEditorState::default();
        let first = state.begin_export("first", Path::new("first.mp4")).unwrap();
        let second = state
            .begin_export("second", Path::new("second.mp4"))
            .unwrap();
        assert!(state.begin_export("first", Path::new("first.mp4")).is_err());
        assert!(
            state
                .begin_export("reopened", Path::new("first.mp4"))
                .is_err()
        );
        state.cancel_export("first");
        assert!(check_cancelled(&first).is_err());
        assert!(check_cancelled(&second).is_ok());
        state.finish_export("first");
        assert!(
            check_cancelled(
                &state
                    .begin_export("reopened", Path::new("first.mp4"))
                    .unwrap()
            )
            .is_ok()
        );
    }

    #[test]
    fn cancelled_render_stops_before_starting_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("edited.mp4");
        let ready = ffmpeg::Ready {
            path: dir.path().join("no-ffmpeg"),
            encoder: ffmpeg::X264,
        };
        let job = ExportJob {
            output: &output,
            plan: plan(),
            layers: None,
            overlays: Vec::new(),
            sources: vec![],
            fps: 30,
            bits_per_pixel: 0.1,
            noise_model: None,
        };
        assert_eq!(
            render(&ready, job, &AtomicBool::new(true), |_| panic!(
                "unexpected frame"
            )),
            Err("Export cancelled".into())
        );
        assert!(!output.exists());
        assert!(!sidecar_path(&output, ".exporting.mp4").exists());
    }

    // Exercise the real pipes and child cleanup without requiring a system encoder.
    #[cfg(unix)]
    fn render_fixture(dir: &Path) -> ffmpeg::Ready {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("ffmpeg");
        fs::write(
            &path,
            r#"#!/bin/sh
for output do :; done
if [ "$#" = 3 ] && [ "$2" = -i ]; then
    : > "$output.probing"
    exec sleep 30
fi
case "$output" in
    pipe:1) exec dd if=/dev/zero bs=262144 count=4 2>/dev/null ;;
    *.exporting.mp4)
        if [ -f "$output.hold" ]; then
            cat > "$output"
            : > "$output.finishing"
            exec sleep 30
        fi
        exec cat > "$output"
        ;;
    *) : > "$output"; exec sleep 30 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        ffmpeg::Ready {
            path,
            encoder: ffmpeg::X264,
        }
    }

    #[cfg(unix)]
    fn fixture_job(output: &Path, gap: bool) -> ExportJob<'_> {
        let (entry, source) = if gap {
            (ExportEntry::Gap(ExportGap { gap_ms: 1000 }), None)
        } else {
            let clip = ExportClip {
                source_width: 256,
                source_height: 256,
                width: 256,
                height: 256,
                start_ms: 0,
                end_ms: 1000,
                ..clip()
            };
            (
                clip.into(),
                Some(ClipSource {
                    path: output.with_file_name("clip.mp4"),
                    cursor: None,
                    has_audio: false,
                    remove_noise: false,
                    kept: None,
                }),
            )
        };
        ExportJob {
            output,
            plan: ExportPlan {
                clips: vec![entry],
                width: 256,
                height: 256,
                video_width: 256,
                video_height: 256,
                x: 0,
                y: 0,
                backdrop_bytes: 0,
                remove_noise: false,
                overlays: Vec::new(),
            },
            sources: vec![source],
            layers: None,
            overlays: Vec::new(),
            fps: 4,
            bits_per_pixel: 0.1,
            noise_model: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_after_a_frame_stops_clips_and_gaps_and_removes_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let ready = render_fixture(dir.path());
        let output = dir.path().join("edited.mp4");
        let silent = sidecar_path(&output, ".exporting.mp4");
        for gap in [false, true] {
            let cancelled = AtomicBool::new(false);
            let mut frames = Vec::new();
            let result = render(&ready, fixture_job(&output, gap), &cancelled, |progress| {
                assert!(silent.is_file());
                frames.push(progress.done);
                cancelled.store(true, Ordering::Relaxed);
            });
            assert_eq!(result, Err("Export cancelled".into()));
            assert_eq!(frames, [1]);
            assert!(!silent.exists());
            assert!(!output.exists());
        }
    }

    #[cfg(unix)]
    fn cancel_when_created(path: &Path, cancelled: &AtomicBool) {
        let start = std::time::Instant::now();
        while !path.exists() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "ffmpeg never created {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
        cancelled.store(true, Ordering::Relaxed);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_during_source_probe_stops_preflight() {
        let dir = tempfile::tempdir().unwrap();
        let ready = render_fixture(dir.path());
        fs::write(dir.path().join("clip.mp4"), []).unwrap();
        let probing = dir.path().join("clip.mp4.probing");
        let cancelled = AtomicBool::new(false);
        let start = std::time::Instant::now();
        thread::scope(|scope| {
            scope.spawn(|| cancel_when_created(&probing, &cancelled));
            let result = clip_sources(&ready.path, dir.path(), &plan(), &cancelled);
            assert_eq!(result.err().as_deref(), Some("Export cancelled"));
        });
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_during_encoder_finish_removes_unfinished_video() {
        let dir = tempfile::tempdir().unwrap();
        let ready = render_fixture(dir.path());
        let output = dir.path().join("edited.mp4");
        let silent = sidecar_path(&output, ".exporting.mp4");
        fs::write(dir.path().join("edited.exporting.mp4.hold"), []).unwrap();
        let finishing = dir.path().join("edited.exporting.mp4.finishing");
        let cancelled = AtomicBool::new(false);
        let start = std::time::Instant::now();
        thread::scope(|scope| {
            scope.spawn(|| cancel_when_created(&finishing, &cancelled));
            let result = render(&ready, fixture_job(&output, true), &cancelled, |_| {});
            assert_eq!(result, Err("Export cancelled".into()));
        });
        assert!(start.elapsed() < Duration::from_secs(20));
        assert!(!silent.exists());
        assert!(!output.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_during_mux_reaps_ffmpeg_and_removes_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let ready = render_fixture(dir.path());
        let output = dir.path().join("edited.mp4");
        let cancelled = AtomicBool::new(false);
        let start = std::time::Instant::now();
        thread::scope(|scope| {
            scope.spawn(|| cancel_when_created(&output, &cancelled));
            let result = render(&ready, fixture_job(&output, true), &cancelled, |_| {});
            assert_eq!(result, Err("Export cancelled".into()));
        });
        assert!(start.elapsed() < Duration::from_secs(20));
        assert!(!output.exists());
        assert!(!sidecar_path(&output, ".exporting.mp4").exists());
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
    fn captions_need_valid_cues_and_the_captions_version() {
        let cue = json!({ "id": "c1", "startMs": 0, "endMs": 1500, "text": "Hello" });
        let with =
            |version: u64, captions: Value| json!({ "version": version, "captions": captions });
        assert!(
            validate_edits(&with(
                CAPTIONS_VERSION,
                json!({ "burnIn": true, "cues": [cue.clone()] })
            ))
            .is_ok()
        );
        assert!(
            validate_edits(&with(4, json!({ "burnIn": true, "cues": [cue.clone()] }))).is_err()
        );
        // No cues needs no new version.
        assert!(validate_edits(&with(1, json!({ "burnIn": false, "cues": [] }))).is_ok());
        assert!(validate_edits(&with(CAPTIONS_VERSION, json!([]))).is_err());
        assert!(validate_edits(&with(CAPTIONS_VERSION, json!({ "burnIn": "yes" }))).is_err());
        assert!(validate_edits(&with(CAPTIONS_VERSION, json!({ "cues": {} }))).is_err());
        assert!(validate_edits(&with(CAPTIONS_VERSION, json!({ "style": 3 }))).is_err());
        let bad = |change: Value| {
            let mut cue = cue.clone();
            cue.as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            validate_edits(&with(CAPTIONS_VERSION, json!({ "cues": [cue] }))).is_err()
        };
        assert!(bad(json!({ "id": "" })));
        assert!(bad(json!({ "text": 3 })));
        assert!(bad(json!({ "endMs": 0 })));
        assert!(bad(json!({ "startMs": -1 })));
        assert!(bad(json!({ "source": "../escape.mp4" })));
        assert!(!bad(json!({ "source": "2026-05/talk.mp4" })));
    }

    #[test]
    fn unknown_or_broken_edits_are_refused() {
        assert!(validate_edits(&json!({ "version": EDITS_VERSION + 1 })).is_err());
        assert!(validate_edits(&json!({ "version": EDITS_VERSION })).is_ok());
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
    fn version_3_clips_may_hold_gaps() {
        let clip = json!({ "id": "c1", "source": "a.mp4", "startMs": 0, "endMs": 4000 });
        let gap = |ms: f64| json!({ "id": "g1", "gapMs": ms });
        assert!(validate_edits(&json!({ "version": 3 })).is_ok());
        assert!(
            validate_edits(&json!({ "version": 3, "clips": [clip.clone(), gap(1500.0)] })).is_ok()
        );
        // A version 3 sidecar without gaps is still fine.
        assert!(validate_edits(&json!({ "version": 3, "clips": [clip.clone()] })).is_ok());
        // Gaps are new in version 3.
        assert!(
            validate_edits(&json!({ "version": 2, "clips": [clip.clone(), gap(1500.0)] })).is_err()
        );
        assert!(validate_edits(&json!({ "version": 3, "clips": [gap(0.0)] })).is_err());
        assert!(validate_edits(&json!({ "version": 3, "clips": [gap(-5.0)] })).is_err());
        assert!(validate_edits(&json!({ "version": 3, "clips": [{ "gapMs": 1000 }] })).is_err());
        assert!(
            validate_edits(&json!({ "version": 3, "clips": [{ "id": "g", "gapMs": "1" }] }))
                .is_err()
        );
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
    fn version_4_round_trips_flat_and_month_qualified_recording_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("own.mp4");
        let edits = json!({
            "version": 4,
            "clips": [
                { "id": "c1", "source": "2026-03/same.mp4", "startMs": 0, "endMs": 1500 },
                { "id": "g1", "gapMs": 200 },
                { "id": "c2", "source": "2026-04/same.MP4", "startMs": 500, "endMs": 1800 },
                { "id": "c3", "source": "legacy.mp4", "startMs": 500, "endMs": 1800 },
            ],
            "zooms": [{
                "id": "z1", "source": "2026-04/same.MP4", "startMs": 500, "endMs": 1800,
                "scale": 2, "focus": { "kind": "cursor" },
            }],
        });
        write_edits(&path, &edits).unwrap();
        assert_eq!(read_edits(&path).unwrap(), Some(edits.clone()));
        let mut legacy_version = edits.clone();
        legacy_version["version"] = json!(3);
        assert!(validate_edits(&legacy_version).is_err());
        let mut invalid = edits;
        invalid["clips"][0]["source"] = json!("2026-03/../own.mp4");
        assert!(validate_edits(&invalid).is_err());
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

        std::os::unix::fs::symlink(dir.path(), recordings.join("2026-04")).unwrap();
        assert!(source_file(&recordings, "2026-04/outside.mp4").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn registered_alias_uses_the_original_root_for_legacy_joins() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("video archive");
        let configured = dir.path().join(RECORDINGS_DIR);
        fs::create_dir(&target).unwrap();
        symlink(&target, &configured).unwrap();
        let own = target.join("original.mp4");
        let another = target.join("another.mp4");
        for path in [&own, &another] {
            fs::write(path, b"video").unwrap();
        }
        let edits = json!({
            "version": 2,
            "clips": [
                { "id": "own", "source": "original.mp4", "startMs": 0, "endMs": 4000 },
                { "id": "other", "source": "another.mp4", "startMs": 500, "endMs": 2500 }
            ],
        });
        write_edits(&own, &edits).unwrap();

        // The Library hands the editor a canonical path, so none of its
        // components has the configured alias's name.
        let state = RecordingEditorState::default();
        let own = fs::canonicalize(own).unwrap();
        state.register("editor", &own, &configured).unwrap();
        let recording = state.recording_for("editor").unwrap();
        assert_eq!(recording.source, "original.mp4");
        assert_eq!(
            recording.recordings_folder,
            fs::canonicalize(&target).unwrap()
        );
        assert_eq!(read_edits(&recording.path).unwrap(), Some(edits));

        // The window keeps the root it opened with.
        fs::remove_file(configured).unwrap();
        assert_eq!(
            state.source_for("editor", "another.mp4").unwrap(),
            fs::canonicalize(another).unwrap()
        );
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
            clips: vec![self::clip().into(), clip.into()],
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
            ExportEntry::from(ExportClip {
                end_ms: 1251,
                ..clip()
            })
            .frames(30),
            1
        );
    }

    #[test]
    fn gaps_come_with_the_plan_and_count_their_frames() {
        let plan: ExportPlan = serde_json::from_str(
            r#"{"clips":[{"gapMs":1000},{"source":"a.mp4","startMs":0,"endMs":5000,
                "sourceWidth":1920,"sourceHeight":1080,"x":0,"y":0,"width":1920,"height":1080},
                {"gapMs":2500}],
                "width":1920,"height":1080,"x":0,"y":0,
                "videoWidth":1920,"videoHeight":1080,"backdropBytes":0}"#,
        )
        .unwrap();
        assert_eq!(plan.clips[0], ExportEntry::Gap(ExportGap { gap_ms: 1000 }));
        assert!(plan.clips[1].clip().is_some());
        assert_eq!(plan.check(), Ok(()));
        assert_eq!(plan.duration_ms(), 8500);
        assert_eq!(plan.frames(30), 30 + 150 + 75);
        // A plan of gaps alone has nothing to show, and a gap has a length.
        let gaps = ExportPlan {
            clips: vec![ExportEntry::Gap(ExportGap { gap_ms: 1000 })],
            ..plan.clone()
        };
        assert!(gaps.check().is_err());
        let short = ExportPlan {
            clips: vec![
                plan.clips[1].clone(),
                ExportEntry::Gap(ExportGap { gap_ms: 0 }),
            ],
            ..plan
        };
        assert!(short.check().is_err());
    }

    #[test]
    fn a_gap_plays_silence() {
        let first = clip();
        let original = Path::new("/rec/clip.mp4");
        let gap = ExportEntry::Gap(ExportGap { gap_ms: 1500 });
        let sounds = [
            ClipSound::of(&first.into(), SoundFrom::Video(original)),
            // A gap is silent even when handed a file.
            ClipSound::of(&gap, SoundFrom::Video(original)),
        ];
        assert_eq!(
            strings(clip_sound_args(
                Path::new("/rec/clip (edited).exporting.mp4"),
                &sounds,
                Path::new("/rec/clip (edited).mp4"),
            )),
            "-hide_banner -loglevel error -y -i /rec/clip (edited).exporting.mp4 \
             -i /rec/clip.mp4 -filter_complex \
             [1:a:0]atrim=start=1.250:end=9.500,asetpts=PTS-STARTPTS,\
             aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             apad,atrim=duration=8.250[a0];\
             anullsrc=r=48000:cl=stereo,atrim=duration=1.500,\
             aformat=sample_fmts=fltp:channel_layouts=stereo[a1];\
             [a0][a1]concat=n=2:v=0:a=1[sound] \
             -map 0:v:0 -map [sound] -c:v copy -c:a aac -b:a 160k -shortest \
             -movflags +faststart /rec/clip (edited).mp4"
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
            clips: vec![clip().into(), second.into()],
            ..plan()
        };
        assert_eq!(plan.check(), Ok(()));
        assert_eq!(plan.duration_ms(), 10_250);
        assert_eq!(plan.frames(30), 248 + 60);
        // A clip narrower than the box is decoded at its own size there.
        assert_eq!(plan.clips[1].clip().unwrap().decode_size(), (676, 540));
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
        assert_eq!(plan.clips[0].clip().unwrap().zooms.len(), 1);
        assert!(plan.clips[1].clip().unwrap().zooms.is_empty());
        assert_eq!(plan.check(), Ok(()));
    }

    #[test]
    fn zoomed_clips_need_sound_zooms() {
        let plan = |zooms| ExportPlan {
            clips: vec![zoomed(zooms).into()],
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
            ClipSound::of(&first.into(), SoundFrom::Video(original)),
            ClipSound::of(&silent.into(), SoundFrom::Silence),
            ClipSound::of(&again.into(), SoundFrom::Video(original)),
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
            remove_noise: false,
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
            remove_noise: false,
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
                    remove_noise: false,
                    ..self::plan()
                }
            ),
            Ok(None)
        );
        assert!(backdrop_and_mask(&backdrop, &plan).is_err());
    }

    fn overlay(start_ms: u64, end_ms: u64) -> ExportOverlay {
        ExportOverlay {
            start_ms,
            end_ms,
            x: 10,
            y: 1800,
            width: 200,
            height: 100,
            bytes: 64,
        }
    }

    #[test]
    fn overlays_come_with_the_plan_and_are_none_without_them() {
        let json = |extra: &str| {
            format!(
                r#"{{"clips":[{{"source":"a.mp4","startMs":0,"endMs":5000,
                    "sourceWidth":1920,"sourceHeight":1080,"x":0,"y":0,"width":1920,"height":1080}}],
                    "width":1920,"height":1080,"x":0,"y":0,
                    "videoWidth":1920,"videoHeight":1080,"backdropBytes":0{extra}}}"#
            )
        };
        let plan = |extra: &str| serde_json::from_str::<ExportPlan>(&json(extra)).unwrap();
        assert!(plan("").overlays.is_empty());
        assert_eq!(
            plan(
                r#","overlays":[{"startMs":100,"endMs":900,"x":4,"y":8,"width":20,"height":10,"bytes":55}]"#
            )
            .overlays,
            vec![ExportOverlay {
                start_ms: 100,
                end_ms: 900,
                x: 4,
                y: 8,
                width: 20,
                height: 10,
                bytes: 55,
            }]
        );
    }

    #[test]
    fn overlays_must_fit_and_show_for_a_while() {
        let with = |overlay: ExportOverlay| ExportPlan {
            overlays: vec![overlay],
            ..plan()
        };
        assert_eq!(with(overlay(0, 1000)).check(), Ok(()));
        // The output is 1080×1920.
        assert_eq!(
            with(ExportOverlay {
                x: 880,
                y: 1820,
                ..overlay(0, 1000)
            })
            .check(),
            Ok(())
        );
        for refused in [
            overlay(1000, 1000),
            overlay(2000, 1000),
            ExportOverlay {
                x: 881,
                ..overlay(0, 1000)
            },
            ExportOverlay {
                y: 1821,
                ..overlay(0, 1000)
            },
            ExportOverlay {
                width: 0,
                ..overlay(0, 1000)
            },
            ExportOverlay {
                bytes: 0,
                ..overlay(0, 1000)
            },
            ExportOverlay {
                x: u32::MAX,
                ..overlay(0, 1000)
            },
        ] {
            assert!(with(refused.clone()).check().is_err(), "{refused:?}");
        }
    }

    #[test]
    fn overlay_pngs_follow_the_mask_in_the_body() {
        let png = |colour: [u8; 4], width: u32, height: u32| {
            let mut bytes = Vec::new();
            RgbaImage::from_pixel(width, height, Rgba(colour))
                .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
                .unwrap();
            bytes
        };
        let backdrop = png([1, 2, 3, 255], 2, 2);
        let mask = png([255, 255, 255, 0], 2, 2);
        let first = png([9, 9, 9, 255], 3, 1);
        let second = png([7, 7, 7, 128], 1, 2);
        let overlays = vec![
            ExportOverlay {
                width: 3,
                height: 1,
                bytes: first.len(),
                ..overlay(0, 500)
            },
            ExportOverlay {
                width: 1,
                height: 2,
                bytes: second.len(),
                ..overlay(500, 900)
            },
        ];
        let plan = ExportPlan {
            backdrop_bytes: backdrop.len(),
            overlays: overlays.clone(),
            ..plan()
        };
        let body = [
            backdrop.clone(),
            mask.clone(),
            first.clone(),
            second.clone(),
        ]
        .concat();
        let (layers, read) = read_body(&body, &plan).unwrap();
        let (read_backdrop, read_mask) = layers.unwrap();
        assert_eq!(read_backdrop.get_pixel(0, 0), &Rgba([1, 2, 3, 255]));
        assert_eq!(read_mask.get_pixel(1, 1).0[3], 0);
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].image.dimensions(), (3, 1));
        assert_eq!((read[1].start_ms, read[1].end_ms), (500, 900));
        assert_eq!(read[1].image.get_pixel(0, 1), &Rgba([7, 7, 7, 128]));

        // Without a backdrop the overlays are the whole body.
        let alone = ExportPlan {
            backdrop_bytes: 0,
            ..plan.clone()
        };
        let (layers, read) = read_body(&[first.clone(), second.clone()].concat(), &alone).unwrap();
        assert!(layers.is_none());
        assert_eq!(read.len(), 2);

        // Missing or wrongly sized overlays refuse the export.
        assert!(
            read_body(
                &[backdrop.clone(), mask.clone(), first.clone()].concat(),
                &plan
            )
            .is_err()
        );
        let wrong_size = ExportPlan {
            overlays: vec![ExportOverlay {
                width: 2,
                ..overlays[0].clone()
            }],
            ..plan.clone()
        };
        assert!(read_body(&[backdrop, mask, first].concat(), &wrong_size).is_err());
    }

    #[test]
    fn overlays_are_laid_over_the_frames_they_show_on() {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        // Half see-through.
        image.put_pixel(1, 0, Rgba([255, 255, 255, 128]));
        let overlays = [OverlayImage {
            start_ms: 1000,
            end_ms: 2000,
            x: 1,
            y: 1,
            image,
        }];
        let frame = || RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255]));

        let mut before = frame();
        draw_overlays(&mut before, &overlays, 999);
        assert_eq!(before, frame());
        let mut after = frame();
        draw_overlays(&mut after, &overlays, 2000);
        assert_eq!(after, frame());

        let mut shown = frame();
        draw_overlays(&mut shown, &overlays, 1000);
        assert_eq!(shown.get_pixel(0, 1), &Rgba([0, 0, 0, 255]));
        assert_eq!(shown.get_pixel(1, 1), &Rgba([255, 255, 255, 255]));
        assert_eq!(shown.get_pixel(2, 1), &Rgba([128, 128, 128, 255]));
        assert_eq!(shown.get_pixel(3, 1), &Rgba([0, 0, 0, 255]));
        assert_eq!(shown.get_pixel(1, 0), &Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn frames_are_timed_in_the_output() {
        assert_eq!(frame_ms(0, 30), 0);
        assert_eq!(frame_ms(30, 30), 1000);
        assert_eq!(frame_ms(45, 30), 1500);
        assert_eq!(frame_ms(5, 4), 1250);
    }
}
