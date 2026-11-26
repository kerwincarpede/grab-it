//! Transcribe a recording into timed text for its captions, on this
//! computer.
//!
//! The multilingual Whisper base model (`onnx-community/whisper-base`, at a
//! pinned revision) is downloaded once into `whisper-models/` in the app's
//! data folder, each file checked against its pinned SHA-256, and runs with
//! rten. The recording's sound is read through the bundled ffmpeg as 16 kHz
//! mono, picked as Suggest edits picks it, and decoded 30 seconds at a time
//! as `rten-examples`' whisper example does. Nothing is sent anywhere but
//! the model download from Hugging Face.
//!
//! The transcript is saved beside its recording as `<name>.transcript.json`
//! and never changes the recording or its edits: the page turns it into
//! caption cues.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rten::Model;
use rten_generate::filter::LogitsFilter;
use rten_generate::generator::TokenId;
use rten_generate::{Generator, GeneratorUtils, Logits};
use rten_tensor::NdTensor;
use rten_tensor::prelude::*;
use rten_text::Tokenizer;
use rustfft::FftPlanner;
use rustfft::num_complex::Complex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, EventTarget, Manager, State};

use crate::capture::sidecar_path;
use crate::ffmpeg;
use crate::recording_editor::{RecordingEditorState, audio_sources};
use crate::recording_suggest::{PauseSound, pause_source};
use crate::rt::{AppHandle, WebviewWindow};

/// The transcript sidecar's format version.
pub const TRANSCRIPT_VERSION: u64 = 1;
/// Ends the name of the transcript sidecar beside an MP4.
pub const TRANSCRIPT_SUFFIX: &str = ".transcript.json";
/// Emitted to the transcribing window with a [`TranscribeProgress`].
pub const TRANSCRIBE_PROGRESS_EVENT: &str = "recording-transcribe-progress";
/// The folder in the app's data folder the model is kept in.
pub const MODELS_DIR: &str = "whisper-models";
/// The model, as the transcript names it.
pub const MODEL_NAME: &str = "whisper-base";
/// The Hugging Face repository and the revision of it downloaded.
const MODEL_REPO: &str = "onnx-community/whisper-base";
const MODEL_REVISION: &str = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";

/// A file of the model: its path in the repository, size and SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    pub path: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

impl ModelFile {
    /// Where it is kept, under the models folder: its own name, so the
    /// repository's `onnx/` folder is not made.
    fn local(&self, dir: &Path) -> PathBuf {
        dir.join(self.path.rsplit('/').next().unwrap_or(self.path))
    }
}

/// Every file the model needs, at [`MODEL_REVISION`].
pub const MODEL_FILES: [ModelFile; 3] = [
    ModelFile {
        path: "onnx/encoder_model.onnx",
        bytes: 82_468_078,
        sha256: "a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe",
    },
    ModelFile {
        path: "onnx/decoder_model_merged.onnx",
        bytes: 208_521_528,
        sha256: "514903744bb1b45803ec571af99b31110491c6f77b0a154825866995fb124b73",
    },
    ModelFile {
        path: "tokenizer.json",
        bytes: 2_480_466,
        sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
    },
];

/// How long the download may stall before it gives up.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long reading one recording's sound may take.
const SOUND_TIMEOUT: Duration = Duration::from_secs(600);

/// The sample rate, FFT size and hop Whisper's log-mel input is made at.
pub const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const N_MELS: usize = 80;
/// One window of sound, and its frames of log-mel input.
pub const WINDOW_SAMPLES: usize = 30 * SAMPLE_RATE;
const WINDOW_FRAMES: usize = WINDOW_SAMPLES / HOP;
/// The most tokens one window decodes, as Whisper allows.
const MAX_TOKENS: usize = 224;

/// Whisper's special tokens (the multilingual vocabulary).
const END_OF_TEXT: TokenId = 50257;
const START_OF_TRANSCRIPT: TokenId = 50258;
const FIRST_LANGUAGE: TokenId = 50259;
const LAST_LANGUAGE: TokenId = 50357;
const TRANSCRIBE: TokenId = 50359;
const NO_TIMESTAMPS: TokenId = 50363;
/// The language each language token stands for, from `<|en|>` on.
const LANGUAGES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];
/// `<|0.00|>`; each later timestamp token is 20 ms on.
pub const TIMESTAMP_BEGIN: TokenId = 50364;
const TIMESTAMP_MS: u64 = 20;

/// The model's input and output names.
const ENCODER_INPUT: &str = "input_features";
const ENCODER_OUTPUT: &str = "last_hidden_state";
const DECODER_ENCODER_INPUT: &str = "encoder_hidden_states";

/// One word, in the recording's own time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// One stretch Whisper heard, in the recording's own time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<TranscriptWord>,
}

/// `<name>.transcript.json`: what was said in one recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub version: u64,
    pub model: String,
    /// The language Whisper heard, as its code (`en`); None when nothing
    /// was heard.
    pub language: Option<String>,
    /// Sorted, never overlapping; empty when there was no voice to hear.
    pub segments: Vec<TranscriptSegment>,
}

/// What transcribing is doing, for its progress bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TranscribeStage {
    /// Downloading the model, in bytes.
    Download,
    /// Hearing the recording, in milliseconds of its sound.
    Transcribe,
}

/// How far transcribing one recording is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeProgress {
    pub source: String,
    pub stage: TranscribeStage,
    pub done: u64,
    pub total: u64,
}

/// Whether the model is downloaded, and how big it is, so Transcribe can
/// say what it will download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeModel {
    pub downloaded: bool,
    pub bytes: u64,
}

/// The transcription running in each editor window, by window label.
#[derive(Default)]
pub struct TranscribeState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TranscribeState {
    fn begin(&self, label: &str) -> Result<Arc<AtomicBool>, String> {
        let mut running = self.running.lock().unwrap_or_else(|err| err.into_inner());
        if running.contains_key(label) {
            return Err("Transcribing is already running".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(label.to_owned(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, label: &str) {
        if let Some(flag) = self
            .running
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(label)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn finish(&self, label: &str) {
        self.running
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(label);
    }
}

const CANCELLED: &str = "Transcribing cancelled";

fn check_cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

/// The transcript sidecar of a recording: `<name>.mp4` gives
/// `<name>.transcript.json`.
pub fn transcript_path(video: &Path) -> PathBuf {
    sidecar_path(video, TRANSCRIPT_SUFFIX)
}

/// Reads `<recording>.transcript.json`; a missing file is `Ok(None)`. A
/// newer version is refused, so it is never overwritten by mistake.
pub fn read_transcript(video: &Path) -> Result<Option<Transcript>, String> {
    let path = transcript_path(video);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    let transcript: Transcript = serde_json::from_str(&text)
        .map_err(|err| format!("could not parse {}: {err}", path.display()))?;
    if !(1..=TRANSCRIPT_VERSION).contains(&transcript.version) {
        return Err(format!(
            "{} is from a newer version of Grab-it",
            path.display()
        ));
    }
    Ok(Some(transcript))
}

/// Writes the sidecar through a temporary file, as the edits are written,
/// so a crash never leaves a half-written one.
pub fn write_transcript(video: &Path, transcript: &Transcript) -> Result<(), String> {
    let path = transcript_path(video);
    let tmp = path.with_extension("json.tmp");
    let mut json = serde_json::to_string_pretty(transcript).map_err(|err| err.to_string())?;
    json.push('\n');
    fs::write(&tmp, json)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|err| format!("could not save the transcript: {err}"))
}

/// The bytes the whole model downloads.
pub fn model_bytes() -> u64 {
    MODEL_FILES.iter().map(|file| file.bytes).sum()
}

/// Whether every model file is in `dir` at its pinned size. Its checksum
/// was checked when it was downloaded.
pub fn model_present(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|file| {
        fs::metadata(file.local(dir)).is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
    })
}

/// Where a model file is downloaded from.
fn model_url(base_url: &str, file: &ModelFile) -> String {
    format!(
        "{base_url}/{MODEL_REPO}/resolve/{MODEL_REVISION}/{}",
        file.path
    )
}

/// Downloads every model file `dir` lacks from `base_url` (Hugging Face's
/// in the app), each written beside its place and renamed in only once its
/// SHA-256 matches. `progress` gets the bytes downloaded of all files and
/// their total; the download stops between chunks once `cancelled` is set.
pub fn download_model(
    agent: &ureq::Agent,
    base_url: &str,
    files: &[ModelFile],
    dir: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("could not make {}: {err}", dir.display()))?;
    let total: u64 = files.iter().map(|file| file.bytes).sum();
    let mut before = 0u64;
    for file in files {
        let to = file.local(dir);
        if fs::metadata(&to).is_ok_and(|meta| meta.len() == file.bytes) {
            before += file.bytes;
            progress(before, total);
            continue;
        }
        let part = to.with_extension(format!("part-{}", std::process::id()));
        let result = ffmpeg::download_hashed_until(
            agent,
            &model_url(base_url, file),
            &part,
            &mut |done, _| progress(before + done, total),
            &|| cancelled.load(Ordering::Relaxed),
        )
        .map_err(|err| {
            if cancelled.load(Ordering::Relaxed) {
                CANCELLED.to_owned()
            } else {
                format!("could not download the speech model: {err}")
            }
        })
        .and_then(|actual| {
            if actual == file.sha256 {
                fs::rename(&part, &to).map_err(|err| err.to_string())
            } else {
                Err(format!(
                    "the speech model's {} did not match its checksum",
                    file.path
                ))
            }
        });
        if result.is_err() {
            let _ = fs::remove_file(&part);
        }
        result?;
        before += file.bytes;
    }
    Ok(())
}

/// ffmpeg's arguments to write audio stream `stream` of `file` to stdout as
/// 16 kHz mono signed 16-bit samples.
pub fn sound_args(file: &Path, stream: usize) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-loglevel", "error", "-i"]
        .into_iter()
        .map(Into::into)
        .collect();
    args.push(file.as_os_str().to_owned());
    for arg in [
        "-map".to_owned(),
        format!("0:a:{stream}"),
        "-ac".to_owned(),
        "1".to_owned(),
        "-ar".to_owned(),
        SAMPLE_RATE.to_string(),
        "-f".to_owned(),
        "s16le".to_owned(),
        "-".to_owned(),
    ] {
        args.push(arg.into());
    }
    args
}

/// Samples in [-1, 1] from little-endian signed 16-bit ones.
pub fn samples_from_s16le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| f32::from(i16::from_le_bytes(*pair)) / 32768.0)
        .collect()
}

/// Reads `file`'s audio stream `stream` as Whisper hears it.
fn read_sound(
    ffmpeg_path: &Path,
    file: &Path,
    stream: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<f32>, String> {
    let mut child = ffmpeg::command(ffmpeg_path)
        .args(sound_args(file, stream))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start ffmpeg: {err}"))?;
    let out = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            bytes
        })
    });
    let err = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });
    let status = ffmpeg::wait_for_unless(&mut child, SOUND_TIMEOUT, || {
        cancelled.load(Ordering::Relaxed)
    });
    let bytes = out.and_then(|out| out.join().ok()).unwrap_or_default();
    let said = err.and_then(|err| err.join().ok()).unwrap_or_default();
    check_cancelled(cancelled)?;
    match status {
        Some(status) if status.success() => Ok(samples_from_s16le(&bytes)),
        Some(_) => Err(ffmpeg::last_line(&said)
            .unwrap_or("ffmpeg could not read the sound")
            .to_owned()),
        None => Err("reading the sound took too long".to_owned()),
    }
}

/// Whisper's mel filters, `[N_MELS][N_FFT / 2 + 1]`, as librosa makes them
/// (Slaney's mel scale and area normalisation).
pub fn mel_filters() -> Vec<Vec<f32>> {
    const F_SP: f64 = 200.0 / 3.0;
    const MIN_LOG_HZ: f64 = 1000.0;
    const MIN_LOG_MEL: f64 = MIN_LOG_HZ / F_SP;
    let log_step = 6.4f64.ln() / 27.0;
    let to_mel = |hz: f64| {
        if hz < MIN_LOG_HZ {
            hz / F_SP
        } else {
            MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() / log_step
        }
    };
    let to_hz = |mel: f64| {
        if mel < MIN_LOG_MEL {
            mel * F_SP
        } else {
            MIN_LOG_HZ * ((mel - MIN_LOG_MEL) * log_step).exp()
        }
    };
    let bins = N_FFT / 2 + 1;
    let top = to_mel(SAMPLE_RATE as f64 / 2.0);
    let points: Vec<f64> = (0..N_MELS + 2)
        .map(|i| to_hz(top * i as f64 / (N_MELS + 1) as f64))
        .collect();
    (0..N_MELS)
        .map(|m| {
            let (low, mid, high) = (points[m], points[m + 1], points[m + 2]);
            let norm = 2.0 / (high - low);
            (0..bins)
                .map(|k| {
                    let hz = k as f64 * SAMPLE_RATE as f64 / N_FFT as f64;
                    let rising = (hz - low) / (mid - low);
                    let falling = (high - hz) / (high - mid);
                    (rising.min(falling).max(0.0) * norm) as f32
                })
                .collect()
        })
        .collect()
}

/// Whisper's input for one 30 s window, `[1, N_MELS, WINDOW_FRAMES]`:
/// `samples`, padded with silence, as a log-mel spectrogram (a periodic
/// Hann window, reflected at the ends, the last frame dropped), clamped to
/// 8 below its loudest and scaled as Whisper was trained.
pub fn log_mel(samples: &[f32], filters: &[Vec<f32>]) -> NdTensor<f32, 3> {
    let mut window = samples[..samples.len().min(WINDOW_SAMPLES)].to_vec();
    window.resize(WINDOW_SAMPLES, 0.0);
    let pad = N_FFT / 2;
    let reflect = |i: isize| -> f32 {
        let n = WINDOW_SAMPLES as isize;
        let j = if i < 0 {
            -i
        } else if i >= n {
            2 * (n - 1) - i
        } else {
            i
        };
        window[j.clamp(0, n - 1) as usize]
    };
    let hann: Vec<f32> = (0..N_FFT)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
    let bins = N_FFT / 2 + 1;
    let mut mel = NdTensor::<f32, 3>::zeros([1, N_MELS, WINDOW_FRAMES]);
    let mut buffer = vec![Complex::new(0.0f32, 0.0); N_FFT];
    let mut power = vec![0.0f32; bins];
    for frame in 0..WINDOW_FRAMES {
        let start = (frame * HOP) as isize - pad as isize;
        for (i, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex::new(reflect(start + i as isize) * hann[i], 0.0);
        }
        fft.process(&mut buffer);
        for (k, value) in power.iter_mut().enumerate() {
            *value = buffer[k].norm_sqr();
        }
        for (m, filter) in filters.iter().enumerate() {
            let energy: f32 = filter.iter().zip(&power).map(|(w, p)| w * p).sum();
            mel[[0, m, frame]] = energy.max(1e-10).log10();
        }
    }
    let loudest = mel.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    for value in mel.iter_mut() {
        *value = (value.max(loudest - 8.0) + 4.0) / 4.0;
    }
    mel
}

/// One token Whisper produced: the token, and the timestamp token it
/// scored highest when it was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub token: TokenId,
    pub likeliest_timestamp: Option<TokenId>,
}

fn timestamp_ms(token: TokenId) -> u64 {
    u64::from(token - TIMESTAMP_BEGIN) * TIMESTAMP_MS
}

/// The segments in one window's tokens, `offset_ms` into the recording.
/// A segment runs between a pair of timestamp tokens; each word starts at
/// its first token's likeliest timestamp, clamped to its segment and never
/// before the word before, and ends where the next word starts or the
/// segment ends. `decode` turns a run of text tokens into text, and a word
/// starts at a token whose text starts with a space. Text after the last
/// timestamp is dropped, as Whisper leaves it unfinished. Returns the
/// segments and where the last one ended, in the window's time.
pub fn segments_from_steps(
    steps: &[Step],
    offset_ms: u64,
    decode: impl Fn(&[TokenId]) -> String,
) -> (Vec<TranscriptSegment>, Option<u64>) {
    let mut segments = Vec::new();
    let mut last_end = None;
    let mut start: Option<u64> = None;
    let mut text_steps: Vec<Step> = Vec::new();
    for step in steps {
        if step.token >= TIMESTAMP_BEGIN {
            let at = timestamp_ms(step.token);
            match start {
                // A timestamp with no text before it opens a segment (the
                // second of `<|a|><|a|>` opens the next one at `a`).
                _ if text_steps.is_empty() => start = Some(at),
                Some(from) => {
                    // A closing timestamp no later than its opening one
                    // still keeps the text, one timestamp step long.
                    let to = at.max(from + TIMESTAMP_MS);
                    if let Some(segment) = segment(&text_steps, from, to, offset_ms, &decode) {
                        segments.push(segment);
                        last_end = Some(to);
                    }
                    text_steps.clear();
                    // A closing timestamp also opens the next segment, for
                    // when the model does not repeat it.
                    start = Some(to);
                }
                None => {}
            }
        } else if step.token < END_OF_TEXT && start.is_some() {
            text_steps.push(*step);
        }
    }
    (segments, last_end)
}

fn segment(
    steps: &[Step],
    from: u64,
    to: u64,
    offset_ms: u64,
    decode: &impl Fn(&[TokenId]) -> String,
) -> Option<TranscriptSegment> {
    let tokens: Vec<TokenId> = steps.iter().map(|step| step.token).collect();
    let text = decode(&tokens).trim().to_owned();
    if text.is_empty() {
        return None;
    }
    // Group tokens into words at each leading space.
    let mut groups: Vec<(Vec<TokenId>, u64)> = Vec::new();
    let mut floor = from;
    for step in steps {
        let piece = decode(&[step.token]);
        let at = step
            .likeliest_timestamp
            .filter(|token| *token >= TIMESTAMP_BEGIN)
            .map(timestamp_ms)
            .unwrap_or(floor)
            .clamp(floor, to);
        // A token that finishes a character cut across tokens stays with
        // it; scripts written without spaces take each token as a word.
        let unfinished = groups
            .last()
            .is_some_and(|(tokens, _)| is_partial(&decode(tokens)));
        let unspaced = groups
            .last()
            .is_some_and(|(tokens, _)| decode(tokens).chars().last().is_some_and(is_unspaced))
            || piece.chars().next().is_some_and(is_unspaced)
            || is_partial(&piece);
        if groups.is_empty() || (!unfinished && (piece.starts_with(' ') || unspaced)) {
            floor = at;
            groups.push((vec![step.token], at));
        } else if let Some((tokens, _)) = groups.last_mut() {
            tokens.push(step.token);
        }
    }
    let mut words = Vec::new();
    for (i, (tokens, at)) in groups.iter().enumerate() {
        let text = decode(tokens).trim().to_owned();
        if text.is_empty() {
            continue;
        }
        let end = groups.get(i + 1).map_or(to, |(_, next)| *next).max(*at);
        words.push(TranscriptWord {
            text,
            start_ms: offset_ms + at,
            end_ms: offset_ms + end,
        });
    }
    Some(TranscriptSegment {
        start_ms: offset_ms + from,
        end_ms: offset_ms + to,
        text,
        words,
    })
}

/// Whether `text` holds a character cut across tokens: the tokenizer
/// gives nothing, or a replacement character, for part of one.
fn is_partial(text: &str) -> bool {
    text.is_empty() || text.contains('\u{FFFD}')
}

/// Whether `c` belongs to a script written without spaces between words
/// (Chinese, Japanese, Thai, Lao, Khmer, Myanmar and Tibetan), whose
/// characters each count as a word.
fn is_unspaced(c: char) -> bool {
    matches!(
        c as u32,
        0x0E00..=0x0EFF // Thai, Lao
            | 0x0F00..=0x0FFF // Tibetan
            | 0x1000..=0x109F // Myanmar
            | 0x1780..=0x17FF // Khmer
            | 0x3000..=0x303F // CJK punctuation
            | 0x3040..=0x30FF // Hiragana, Katakana
            | 0x3400..=0x4DBF // CJK extension A
            | 0x4E00..=0x9FFF // CJK
            | 0xF900..=0xFAFF // CJK compatibility
            | 0xFF00..=0xFFEF // Full-width forms
            | 0x20000..=0x2FFFF // CJK extensions
    )
}

/// Whether Whisper may produce timestamp `token` after `generated`, by
/// its timestamp rules: timestamps come in pairs, so after a closing one
/// (a timestamp after text) only another timestamp or the end follows,
/// and after an opening one only text; a closing timestamp is later than
/// the one before it, and an opening one no earlier; the first is within
/// a second.
fn timestamp_allowed(generated: &[TokenId], token: TokenId) -> bool {
    let is_time = |t: &TokenId| *t >= TIMESTAMP_BEGIN;
    let Some(last) = generated.last() else {
        return token <= TIMESTAMP_BEGIN + 50;
    };
    let last_was_time = is_time(last);
    let penultimate_was_time = generated.len() < 2 || is_time(&generated[generated.len() - 2]);
    if last_was_time && penultimate_was_time {
        return false;
    }
    match generated.iter().rev().find(|t| is_time(t)) {
        Some(&last_time) if last_was_time => token >= last_time,
        Some(&last_time) => token > last_time,
        None => true,
    }
}

/// Whether Whisper may produce text `token` after `generated`: never
/// first, and never straight after a closing timestamp.
fn text_allowed(generated: &[TokenId]) -> bool {
    let is_time = |t: &TokenId| *t >= TIMESTAMP_BEGIN;
    match generated {
        [] => false,
        [.., before, last] if is_time(last) && !is_time(before) => false,
        _ => true,
    }
}

/// Keeps Whisper's timestamps in order, and notes the timestamp each step
/// scored highest, for the words' times.
struct TimestampFilter {
    likeliest: Rc<RefCell<Vec<Option<TokenId>>>>,
    prompt_len: usize,
}

impl LogitsFilter for TimestampFilter {
    fn filter(&self, logits: Logits, prev_tokens: &[TokenId]) -> Logits {
        let generated = &prev_tokens[self.prompt_len.min(prev_tokens.len())..];
        let text_ok = text_allowed(generated);
        let (values, indices) = logits.into_logits_indices();
        let mut best: Option<(TokenId, f32)> = None;
        let mut kept_values = Vec::with_capacity(values.len());
        let mut kept_indices = Vec::with_capacity(indices.len());
        for (value, token) in values.into_iter().zip(indices) {
            if token == NO_TIMESTAMPS || (token > END_OF_TEXT && token < TIMESTAMP_BEGIN) {
                continue;
            }
            if token >= TIMESTAMP_BEGIN {
                if best.is_none_or(|(_, score)| value > score) {
                    best = Some((token, value));
                }
                if !timestamp_allowed(generated, token) {
                    continue;
                }
            } else if (token < END_OF_TEXT && !text_ok)
                || (token == END_OF_TEXT && generated.is_empty())
            {
                continue;
            }
            kept_values.push(value);
            kept_indices.push(token);
        }
        self.likeliest
            .borrow_mut()
            .push(best.map(|(token, _)| token));
        Logits::sparse(kept_values, kept_indices)
    }
}

/// A loaded Whisper model.
pub struct Whisper {
    encoder: Model,
    decoder: Model,
    tokenizer: Tokenizer,
    filters: Vec<Vec<f32>>,
}

impl Whisper {
    /// Loads the model from `dir`.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let load = |file: &ModelFile| {
            Model::load_file(file.local(dir))
                .map_err(|err| format!("could not load the speech model: {err}"))
        };
        let tokenizer = Tokenizer::from_file(MODEL_FILES[2].local(dir))
            .map_err(|err| format!("could not load the speech model's words: {err}"))?;
        Ok(Self {
            encoder: load(&MODEL_FILES[0])?,
            decoder: load(&MODEL_FILES[1])?,
            tokenizer,
            filters: mel_filters(),
        })
    }

    fn decode(&self, tokens: &[TokenId]) -> String {
        self.tokenizer.decode(tokens).unwrap_or_default()
    }

    /// Runs the encoder on one window's log-mel input.
    fn encode(&self, mel: NdTensor<f32, 3>) -> Result<rten::Value, String> {
        let engine = |err: rten::RunError| format!("the speech model failed: {err}");
        let input = self.encoder.node_id(ENCODER_INPUT).map_err(engine)?;
        let output = self.encoder.node_id(ENCODER_OUTPUT).map_err(engine)?;
        let [hidden] = self
            .encoder
            .run_n(vec![(input, mel.into())], [output], None)
            .map_err(engine)?;
        Ok(hidden)
    }

    fn generator<'a>(&'a self, hidden: &'a rten::Value) -> Result<Generator<'a>, String> {
        let engine = |err: &dyn std::fmt::Display| format!("the speech model failed: {err}");
        let input = self
            .decoder
            .node_id(DECODER_ENCODER_INPUT)
            .map_err(|err| engine(&err))?;
        Ok(Generator::from_model(&self.decoder)
            .map_err(|err| engine(&err))?
            .with_constant_input(input, hidden.as_view()))
    }

    /// The language Whisper hears in a window: its likeliest language token.
    fn language(&self, hidden: &rten::Value) -> Result<TokenId, String> {
        let mut generator = self
            .generator(hidden)?
            .with_prompt(&[START_OF_TRANSCRIPT])
            .with_logits_filter(LanguageFilter);
        match generator.next() {
            Some(Ok(token)) if (FIRST_LANGUAGE..=LAST_LANGUAGE).contains(&token) => Ok(token),
            Some(Err(err)) => Err(format!("the speech model failed: {err}")),
            _ => Ok(FIRST_LANGUAGE),
        }
    }

    /// The tokens Whisper hears in a window, each with its likeliest
    /// timestamp.
    fn window_steps(
        &self,
        hidden: &rten::Value,
        language: TokenId,
        cancelled: &AtomicBool,
    ) -> Result<Vec<Step>, String> {
        let prompt = [START_OF_TRANSCRIPT, language, TRANSCRIBE];
        let likeliest = Rc::new(RefCell::new(Vec::new()));
        let generator = self
            .generator(hidden)?
            .with_prompt(&prompt)
            .with_logits_filter(TimestampFilter {
                likeliest: likeliest.clone(),
                prompt_len: prompt.len(),
            });
        let mut tokens = Vec::new();
        for token in generator.stop_on_tokens([END_OF_TEXT]).take(MAX_TOKENS) {
            check_cancelled(cancelled)?;
            tokens.push(token.map_err(|err| format!("the speech model failed: {err}"))?);
        }
        let likeliest = likeliest.borrow();
        Ok(tokens
            .into_iter()
            .enumerate()
            .map(|(i, token)| Step {
                token,
                likeliest_timestamp: likeliest.get(i).copied().flatten(),
            })
            .collect())
    }

    /// Transcribes 16 kHz mono `samples`, 30 s at a time, each window
    /// starting where the last finished segment ended. `progress` gets the
    /// milliseconds heard and the sound's length.
    pub fn transcribe(
        &self,
        samples: &[f32],
        cancelled: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<Transcript, String> {
        let ms = |samples: usize| (samples as u64 * 1000) / SAMPLE_RATE as u64;
        let total = ms(samples.len());
        let mut language = None;
        let mut segments = Vec::new();
        let mut seek = 0usize;
        progress(0, total);
        while seek < samples.len() {
            check_cancelled(cancelled)?;
            let window = &samples[seek..samples.len().min(seek + WINDOW_SAMPLES)];
            let hidden = self.encode(log_mel(window, &self.filters))?;
            let heard = match language {
                Some(token) => token,
                None => *language.insert(self.language(&hidden)?),
            };
            let steps = self.window_steps(&hidden, heard, cancelled)?;
            let offset = ms(seek);
            let window_ms = ms(window.len());
            let (found, last_end) =
                segments_from_steps(&steps, offset, |tokens| self.decode(tokens));
            segments.extend(found.into_iter().filter_map(|mut segment| {
                segment.end_ms = segment.end_ms.min(offset + window_ms);
                (segment.start_ms < segment.end_ms).then_some(segment)
            }));
            // A full window ends where its last finished segment did;
            // anything later is heard again in the next window.
            let advance = match last_end {
                Some(end) if window.len() == WINDOW_SAMPLES && end > 0 && end < window_ms => {
                    (end as usize * SAMPLE_RATE) / 1000
                }
                _ => window.len(),
            };
            seek += advance.max(1);
            progress(ms(seek).min(total), total);
        }
        let language = language
            .filter(|_| !segments.is_empty())
            .and_then(language_code)
            .map(str::to_owned);
        Ok(Transcript {
            version: TRANSCRIPT_VERSION,
            model: MODEL_NAME.to_owned(),
            language,
            segments,
        })
    }
}

/// The code of language token `token`, such as `en`.
pub fn language_code(token: TokenId) -> Option<&'static str> {
    LANGUAGES
        .get(token.checked_sub(FIRST_LANGUAGE)? as usize)
        .copied()
}

/// Lets only language tokens through.
struct LanguageFilter;

impl LogitsFilter for LanguageFilter {
    fn filter(&self, logits: Logits, _prev_tokens: &[TokenId]) -> Logits {
        let (values, indices) = logits.into_logits_indices();
        let (values, indices) = values
            .into_iter()
            .zip(indices)
            .filter(|(_, token)| (FIRST_LANGUAGE..=LAST_LANGUAGE).contains(token))
            .unzip();
        Logits::sparse(values, indices)
    }
}

/// The models folder in the app's data folder.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join(MODELS_DIR))
}

/// Whether the speech model is downloaded, and its size.
#[tauri::command]
#[specta::specta]
pub fn recording_transcribe_model(app: AppHandle) -> Result<TranscribeModel, String> {
    Ok(TranscribeModel {
        downloaded: model_present(&models_dir(&app)?),
        bytes: model_bytes(),
    })
}

/// The saved transcript of recording `source`, if it has one.
#[tauri::command]
#[specta::specta]
pub fn recording_transcript(
    source: String,
    window: WebviewWindow,
    state: State<'_, RecordingEditorState>,
) -> Result<Option<Transcript>, String> {
    read_transcript(&state.source_for(window.label(), &source)?)
}

/// Requests cancellation of the transcription running in this window.
#[tauri::command]
#[specta::specta]
pub fn recording_transcribe_cancel(window: WebviewWindow, state: State<'_, TranscribeState>) {
    state.cancel(window.label());
}

/// Transcribes recording `source`, downloading the model first if needed,
/// saves its transcript beside it and returns it. A recording with only
/// system sound, or none, gets a transcript with no segments. Progress
/// goes to the window as [`TRANSCRIBE_PROGRESS_EVENT`].
#[tauri::command]
#[specta::specta]
pub async fn recording_transcribe(
    source: String,
    window: WebviewWindow,
    app: AppHandle,
    editors: State<'_, RecordingEditorState>,
    state: State<'_, TranscribeState>,
) -> Result<Transcript, String> {
    let path = editors.source_for(window.label(), &source)?;
    let Some(ready) = ffmpeg::ready(&app) else {
        ffmpeg::prepare_in_background(&app);
        return Err("ffmpeg is not ready yet; see Settings → Recording, then try again".to_owned());
    };
    let dir = models_dir(&app)?;
    let label = window.label().to_owned();
    let cancelled = state.begin(&label)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let report = |stage: TranscribeStage, done: u64, total: u64| {
            let _ = app.emit_to(
                EventTarget::webview_window(&label),
                TRANSCRIBE_PROGRESS_EVENT,
                TranscribeProgress {
                    source: source.clone(),
                    stage,
                    done,
                    total,
                },
            );
        };
        let sources: Vec<_> = audio_sources(&path, Some(&ready.path))
            .into_iter()
            .map(|source| (source.kind, source.file, source.stream))
            .collect();
        let transcript = match pause_source(&path, &sources) {
            (PauseSound::Microphone | PauseSound::Mixed, Some((file, stream))) => {
                if !model_present(&dir) {
                    download_model(
                        &ffmpeg::download_agent(DOWNLOAD_STALL_TIMEOUT),
                        "https://huggingface.co",
                        &MODEL_FILES,
                        &dir,
                        &cancelled,
                        |done, total| report(TranscribeStage::Download, done, total),
                    )?;
                }
                let samples = read_sound(&ready.path, &file, stream, &cancelled)?;
                let whisper = Whisper::load(&dir)?;
                whisper.transcribe(&samples, &cancelled, |done, total| {
                    report(TranscribeStage::Transcribe, done, total)
                })?
            }
            _ => Transcript {
                version: TRANSCRIPT_VERSION,
                model: MODEL_NAME.to_owned(),
                language: None,
                segments: Vec::new(),
            },
        };
        check_cancelled(&cancelled)?;
        write_transcript(&path, &transcript)?;
        Ok(transcript)
    })
    .await;
    state.finish(window.label());
    result.map_err(|err| format!("transcribing stopped: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use std::net::TcpListener;

    /// A fake tokenizer: token `n` is the text in `vocab[n]`.
    fn decoder(vocab: &'static [&'static str]) -> impl Fn(&[TokenId]) -> String {
        move |tokens| tokens.iter().map(|t| vocab[*t as usize]).collect()
    }

    fn ts(ms: u64) -> TokenId {
        TIMESTAMP_BEGIN + (ms / TIMESTAMP_MS) as TokenId
    }

    fn text(token: TokenId, at_ms: u64) -> Step {
        Step {
            token,
            likeliest_timestamp: Some(ts(at_ms)),
        }
    }

    fn stamp(ms: u64) -> Step {
        Step {
            token: ts(ms),
            likeliest_timestamp: Some(ts(ms)),
        }
    }

    const VOCAB: &[&str] = &[" Hello", " wor", "ld", ".", " Again", " now"];

    #[test]
    fn segments_and_words_come_from_timestamps() {
        let steps = [
            stamp(0),
            text(0, 200),
            text(1, 600),
            text(2, 700),
            text(3, 900),
            stamp(1000),
            stamp(1000),
            text(4, 1200),
            // Earlier than the word before: held at it.
            text(5, 1100),
            stamp(2000),
        ];
        let (segments, last) = segments_from_steps(&steps, 5000, decoder(VOCAB));
        assert_eq!(last, Some(2000));
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Hello world.");
        assert_eq!((segments[0].start_ms, segments[0].end_ms), (5000, 6000));
        let words: Vec<_> = segments[0]
            .words
            .iter()
            .map(|w| (w.text.as_str(), w.start_ms, w.end_ms))
            .collect();
        assert_eq!(words, [("Hello", 5200, 5600), ("world.", 5600, 6000)]);
        let again: Vec<_> = segments[1]
            .words
            .iter()
            .map(|w| (w.text.as_str(), w.start_ms, w.end_ms))
            .collect();
        assert_eq!(again, [("Again", 6200, 6200), ("now", 6200, 7000)]);
    }

    #[test]
    fn unfinished_text_after_the_last_timestamp_is_dropped() {
        let steps = [stamp(0), text(0, 0), stamp(500), text(4, 600)];
        let (segments, last) = segments_from_steps(&steps, 0, decoder(VOCAB));
        assert_eq!(segments.len(), 1);
        assert_eq!(last, Some(500));
    }

    #[test]
    fn a_lone_closing_timestamp_also_opens_the_next_segment() {
        let steps = [
            stamp(0),
            text(0, 200),
            stamp(2400),
            text(4, 2600),
            text(5, 3000),
            stamp(5000),
        ];
        let (segments, last) = segments_from_steps(&steps, 0, decoder(VOCAB));
        let spans: Vec<_> = segments
            .iter()
            .map(|s| (s.text.as_str(), s.start_ms, s.end_ms))
            .collect();
        assert_eq!(spans, [("Hello", 0, 2400), ("Again now", 2400, 5000)]);
        assert_eq!(last, Some(5000));
    }

    #[test]
    fn a_zero_length_segment_keeps_its_text() {
        let steps = [stamp(1000), text(0, 1000), stamp(1000)];
        let (segments, last) = segments_from_steps(&steps, 0, decoder(VOCAB));
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Hello");
        assert_eq!(
            (segments[0].start_ms, segments[0].end_ms),
            (1000, 1000 + TIMESTAMP_MS)
        );
        assert_eq!(last, Some(1000 + TIMESTAMP_MS));
    }

    #[test]
    fn unspaced_scripts_take_each_token_as_a_word() {
        // "\u{FFFD}" stands for the first token of a character cut across two.
        const CJK: &[&str] = &["你", "好", "世", "界", "\u{FFFD}", "\u{FFFD}好", " ok"];
        let steps = [
            stamp(0),
            text(0, 0),
            text(1, 400),
            text(2, 800),
            text(3, 1200),
            text(4, 1600),
            text(5, 1700),
            text(6, 1800),
            stamp(2000),
        ];
        let decode = |tokens: &[TokenId]| -> String {
            let joined: String = tokens.iter().map(|t| CJK[*t as usize]).collect();
            // Two halves of one character decode to it.
            joined.replace("\u{FFFD}\u{FFFD}好", "们")
        };
        let (segments, _) = segments_from_steps(&steps, 0, decode);
        let words: Vec<_> = segments[0]
            .words
            .iter()
            .map(|w| (w.text.as_str(), w.start_ms))
            .collect();
        assert_eq!(
            words,
            [
                ("你", 0),
                ("好", 400),
                ("世", 800),
                ("界", 1200),
                ("们", 1600),
                ("ok", 1800)
            ]
        );
    }

    #[test]
    fn timestamps_come_in_pairs_and_move_forward() {
        let (t0, t1, t2) = (ts(0), ts(1000), ts(2000));
        let hello = 0;
        // First: a timestamp within a second, never text.
        assert!(timestamp_allowed(&[], t0));
        assert!(!timestamp_allowed(&[], ts(2000)));
        assert!(!text_allowed(&[]));
        // After an opening timestamp: text only.
        assert!(!timestamp_allowed(&[t0], t1));
        assert!(text_allowed(&[t0]));
        // After text: a strictly later timestamp closes the segment.
        assert!(!timestamp_allowed(&[t1, hello], t1));
        assert!(timestamp_allowed(&[t1, hello], t2));
        // After a lone closing timestamp: a timestamp no earlier, or the
        // end, but no text.
        assert!(!text_allowed(&[t0, hello, t1]));
        assert!(timestamp_allowed(&[t0, hello, t1], t1));
        assert!(!timestamp_allowed(&[t0, hello, t1], t0));
        // After a pair: text again, no timestamp.
        assert!(!timestamp_allowed(&[t0, hello, t1, t1], t2));
        assert!(text_allowed(&[t0, hello, t1, t1]));
    }

    #[test]
    fn word_times_are_clamped_to_their_segment() {
        let steps = [stamp(1000), text(0, 0), text(5, 9000), stamp(2000)];
        let (segments, _) = segments_from_steps(&steps, 0, decoder(VOCAB));
        let words = &segments[0].words;
        assert_eq!((words[0].start_ms, words[0].end_ms), (1000, 2000));
        assert_eq!((words[1].start_ms, words[1].end_ms), (2000, 2000));
    }

    #[test]
    fn silence_gives_a_flat_log_mel() {
        let mel = log_mel(&[0.0; 1000], &mel_filters());
        assert_eq!(mel.shape(), [1, N_MELS, WINDOW_FRAMES]);
        assert!(mel.iter().all(|value| (*value - -1.5).abs() < 1e-6));
    }

    #[test]
    fn a_tone_is_loudest_in_its_mel_band() {
        let samples: Vec<f32> = (0..SAMPLE_RATE)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let filters = mel_filters();
        let mel = log_mel(&samples, &filters);
        let loudest = (0..N_MELS)
            .max_by(|a, b| mel[[0, *a, 50]].total_cmp(&mel[[0, *b, 50]]))
            .unwrap();
        let bin = 440 * N_FFT / SAMPLE_RATE;
        assert!(filters[loudest][bin] > 0.0 || filters[loudest][bin + 1] > 0.0);
        // Past the tone the window is silence: the floor, 8 below the top.
        let top = mel.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        assert!((mel[[0, 0, WINDOW_FRAMES - 1]] - (top - 2.0)).abs() < 1e-5);
    }

    #[test]
    fn language_tokens_name_their_language() {
        assert_eq!(
            LANGUAGES.len() as TokenId,
            LAST_LANGUAGE - FIRST_LANGUAGE + 1
        );
        assert_eq!(language_code(FIRST_LANGUAGE), Some("en"));
        assert_eq!(language_code(FIRST_LANGUAGE + 2), Some("de"));
        assert_eq!(language_code(LAST_LANGUAGE), Some("su"));
        assert_eq!(language_code(LAST_LANGUAGE + 1), None);
        assert_eq!(language_code(END_OF_TEXT), None);
    }

    #[test]
    fn mel_filters_cover_the_spectrum() {
        let filters = mel_filters();
        assert_eq!(filters.len(), N_MELS);
        assert!(filters.iter().all(|filter| filter.len() == N_FFT / 2 + 1));
        assert!(filters.iter().all(|filter| filter.iter().any(|w| *w > 0.0)));
    }

    #[test]
    fn s16le_samples_are_scaled() {
        let bytes = [0x00, 0x80, 0x00, 0x00, 0xff, 0x7f];
        let samples = samples_from_s16le(&bytes);
        assert_eq!(samples[0], -1.0);
        assert_eq!(samples[1], 0.0);
        assert!((samples[2] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn sound_args_ask_for_16_khz_mono() {
        let args: Vec<String> = sound_args(Path::new("a.m4a"), 1)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let joined = args.join(" ");
        assert!(joined.contains("-i a.m4a -map 0:a:1 -ac 1 -ar 16000 -f s16le -"));
    }

    #[test]
    fn transcript_round_trips_beside_its_recording() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        assert_eq!(read_transcript(&video), Ok(None));
        let transcript = Transcript {
            version: 1,
            model: MODEL_NAME.into(),
            language: Some("en".into()),
            segments: vec![TranscriptSegment {
                start_ms: 0,
                end_ms: 900,
                text: "Hi".into(),
                words: vec![TranscriptWord {
                    text: "Hi".into(),
                    start_ms: 0,
                    end_ms: 900,
                }],
            }],
        };
        write_transcript(&video, &transcript).unwrap();
        assert!(dir.path().join("clip.transcript.json").is_file());
        assert_eq!(read_transcript(&video), Ok(Some(transcript)));
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(transcript_path(&video)).unwrap()).unwrap();
        assert_eq!(json["segments"][0]["words"][0]["startMs"], 0);
        assert_eq!(json["language"], "en");
    }

    #[test]
    fn a_newer_transcript_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        fs::write(
            transcript_path(&video),
            r#"{"version":2,"model":"x","language":null,"segments":[]}"#,
        )
        .unwrap();
        assert!(read_transcript(&video).is_err());
    }

    #[test]
    fn the_model_is_pinned_and_about_290_mb() {
        assert!((280_000_000..300_000_000).contains(&model_bytes()));
        for file in MODEL_FILES {
            assert_eq!(file.sha256.len(), 64);
            assert!(model_url("https://huggingface.co", &file).contains(MODEL_REVISION));
        }
    }

    /// Serves `body` once per connection, `times` times, on a local port.
    fn serve(body: &'static [u8], times: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(times) {
                let mut stream = stream.unwrap();
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        format!("http://{address}")
    }

    fn sha256(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn download_keeps_only_files_that_match_their_checksum() {
        static BODY: &[u8] = b"model bytes";
        let hash: &'static str = Box::leak(sha256(BODY).into_boxed_str());
        let dir = tempfile::tempdir().unwrap();
        let good = ModelFile {
            path: "onnx/good.onnx",
            bytes: BODY.len() as u64,
            sha256: hash,
        };
        let agent = ffmpeg::download_agent(Duration::from_secs(5));
        let mut seen = Vec::new();
        download_model(
            &agent,
            &serve(BODY, 1),
            &[good],
            dir.path(),
            &AtomicBool::new(false),
            |done, total| seen.push((done, total)),
        )
        .unwrap();
        assert_eq!(fs::read(dir.path().join("good.onnx")).unwrap(), BODY);
        assert_eq!(seen.last(), Some(&(BODY.len() as u64, BODY.len() as u64)));

        let bad = ModelFile {
            path: "bad.onnx",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..good
        };
        let err = download_model(
            &agent,
            &serve(BODY, 1),
            &[bad],
            dir.path(),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        let left: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, [std::ffi::OsString::from("good.onnx")]);
    }

    #[test]
    fn a_cancelled_download_stops_and_leaves_nothing() {
        static BODY: &[u8] = b"model bytes";
        let dir = tempfile::tempdir().unwrap();
        let file = ModelFile {
            path: "m.onnx",
            bytes: BODY.len() as u64,
            sha256: "00",
        };
        let err = download_model(
            &ffmpeg::download_agent(Duration::from_secs(5)),
            &serve(BODY, 1),
            &[file],
            dir.path(),
            &AtomicBool::new(true),
            |_, _| {},
        )
        .unwrap_err();
        assert_eq!(err, CANCELLED);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancelling_is_scoped_to_one_window() {
        let state = TranscribeState::default();
        let first = state.begin("first").unwrap();
        let second = state.begin("second").unwrap();
        assert!(state.begin("first").is_err());
        state.cancel("first");
        assert!(check_cancelled(&first).is_err());
        assert!(check_cancelled(&second).is_ok());
        state.finish("first");
        assert!(state.begin("first").is_ok());
    }
}
