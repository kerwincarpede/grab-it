//! The microphone and the system sound, recorded into an MP4's sound.
//!
//! While an MP4 records, each [`Input`] it records (the chosen microphone,
//! what the computer plays, or both) is written to its own 16-bit PCM WAV
//! in the temporary folder, and the time its first sample was heard is
//! noted. When the recording stops, ffmpeg muxes the WAVs into the MP4 as
//! one AAC track, each shifted by the gap between the first frame and its
//! first sample and mixed together when there are two (see
//! `ffmpeg::add_audio`), and the WAVs are deleted.
//!
//! On macOS and Windows the microphone is read through cpal (Core Audio,
//! WASAPI). On Linux ffmpeg's own PulseAudio input reads it (`-f pulse`,
//! which PipeWire's Pulse server also answers) and pipes raw samples to
//! Grab-it, so no ALSA or Pulse headers are needed to build Grab-it.
//!
//! The system sound is read on Windows through cpal's WASAPI loopback of
//! the default output device, on Linux by ffmpeg from the default output's
//! monitor source (`@DEFAULT_MONITOR@`), and on macOS 13 and later by an
//! audio-only ScreenCaptureKit stream (see audio/system_mac.rs). macOS
//! before 13 cannot record it ([`system_available`]). WASAPI sends nothing
//! while nothing plays, so the system sound's WAV is padded with silence
//! wherever its chunks arrive later than the samples so far account for.

#[cfg(target_os = "macos")]
mod system_mac;

use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::AppHandle;

/// How long a microphone gets to start.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// What a recording's sound is recorded from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// A microphone, by its [`MicrophoneInfo::id`], or the system's default
    /// one when None.
    Microphone(Option<String>),
    /// What the computer plays.
    System,
}

impl Input {
    /// What the card calls it.
    pub fn what(&self) -> &'static str {
        match self {
            Self::Microphone(_) => "the microphone",
            Self::System => "the system sound",
        }
    }

    /// Why there is no sound when none was heard.
    fn silent(&self) -> &'static str {
        match self {
            Self::Microphone(_) => "the microphone sent no sound",
            Self::System => "the computer played no sound",
        }
    }

    /// Names its WAV in the temporary folder.
    fn tag(&self) -> &'static str {
        match self {
            Self::Microphone(_) => "microphone",
            Self::System => "system",
        }
    }

    /// Whether a stretch with no chunks is filled with silence: the
    /// system sound may send nothing while nothing plays.
    fn fills_gaps(&self) -> bool {
        matches!(self, Self::System)
    }
}

/// Whether what the computer plays can be recorded here: on Windows, on
/// Linux, and on macOS 13 and later.
pub fn system_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        system_mac::available()
    }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        true
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Whether Settings offers System and Both.
#[tauri::command]
pub fn recording_system_audio() -> bool {
    system_available()
}

/// The longest stretch with no chunks that is not filled with silence:
/// chunks arrive in bursts, so a little lateness is not a gap.
const SILENCE_AFTER: Duration = Duration::from_millis(100);

/// A microphone that can be picked. Mirrors `Microphone` in
/// src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneInfo {
    /// What `recording.microphone` saves to pick it.
    pub id: String,
    /// What Settings shows.
    pub name: String,
    /// The system's default microphone.
    pub is_default: bool,
}

/// Writes 16-bit PCM samples as a WAV, filling in its sizes on
/// [`WavWriter::finish`].
pub struct WavWriter<W: Write + Seek> {
    out: W,
    data_bytes: u32,
}

/// The size of a PCM WAV header.
const WAV_HEADER_BYTES: u32 = 44;

impl<W: Write + Seek> WavWriter<W> {
    pub fn new(mut out: W, channels: u16, sample_rate: u32) -> io::Result<Self> {
        let block_align = channels * 2;
        let mut header = Vec::with_capacity(WAV_HEADER_BYTES as usize);
        header.extend_from_slice(b"RIFF");
        // The sizes are filled in when the samples are all written.
        header.extend_from_slice(&0u32.to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        // PCM.
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&channels.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&(sample_rate * u32::from(block_align)).to_le_bytes());
        header.extend_from_slice(&block_align.to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&0u32.to_le_bytes());
        out.write_all(&header)?;
        Ok(Self { out, data_bytes: 0 })
    }

    pub fn write(&mut self, samples: &[i16]) -> io::Result<()> {
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        self.write_bytes(&bytes)
    }

    /// Writes samples already in the WAV's little-endian 16-bit form.
    pub fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.out.write_all(bytes)?;
        self.data_bytes = self
            .data_bytes
            .saturating_add(u32::try_from(bytes.len()).unwrap_or(u32::MAX));
        Ok(())
    }

    /// Fills in the sizes and hands the output back.
    pub fn finish(mut self) -> io::Result<W> {
        self.out.seek(SeekFrom::Start(4))?;
        self.out
            .write_all(&(self.data_bytes.saturating_add(WAV_HEADER_BYTES - 8)).to_le_bytes())?;
        self.out.seek(SeekFrom::Start(40))?;
        self.out.write_all(&self.data_bytes.to_le_bytes())?;
        self.out.seek(SeekFrom::End(0))?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Where the samples go, shared with the thread that hears them.
struct Sink {
    writer: Option<WavWriter<BufWriter<File>>>,
    channels: u16,
    sample_rate: u32,
    /// When the first sample was heard.
    first_sample: Option<Instant>,
    /// The sample frames written so far, silence included.
    frames: u64,
    /// Whether a stretch with no chunks is filled with silence.
    fill_gaps: bool,
    /// The first write that failed.
    error: Option<String>,
}

type SharedSink = Arc<Mutex<Sink>>;

fn lock(sink: &SharedSink) -> MutexGuard<'_, Sink> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Sink {
    fn create(
        wav: &Path,
        channels: u16,
        sample_rate: u32,
        fill_gaps: bool,
    ) -> Result<SharedSink, String> {
        let file = File::create(wav)
            .map_err(|err| format!("could not create {}: {err}", wav.display()))?;
        let writer = WavWriter::new(BufWriter::new(file), channels, sample_rate)
            .map_err(|err| format!("could not write {}: {err}", wav.display()))?;
        Ok(Arc::new(Mutex::new(Self {
            writer: Some(writer),
            channels,
            sample_rate,
            first_sample: None,
            frames: 0,
            fill_gaps,
            error: None,
        })))
    }

    /// Writes `samples`, which arrived at `at`.
    fn push(&mut self, samples: &[i16], at: Instant) {
        if samples.is_empty() {
            return;
        }
        let heard = first_sample_at(at, samples.len(), self.channels, self.sample_rate);
        let silence = match self.first_sample {
            None => {
                self.first_sample = Some(heard);
                0
            }
            Some(first) if self.fill_gaps => {
                missing_frames(first, self.frames, self.sample_rate, heard)
            }
            Some(_) => 0,
        };
        let channels = u64::from(self.channels.max(1));
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        let mut written = write_silence(writer, silence, self.channels);
        if written.is_ok() {
            written = writer.write(samples);
        }
        match written {
            Ok(()) => self.frames += silence + samples.len() as u64 / channels,
            Err(err) if self.error.is_none() => {
                self.error = Some(format!("could not write the sound: {err}"));
            }
            Err(_) => {}
        }
    }

    /// Finishes the WAV. Returns when its first sample was heard, or None
    /// when none was.
    fn finish(&mut self) -> Result<Option<Instant>, String> {
        if let Some(err) = self.error.take() {
            return Err(err);
        }
        if let Some(writer) = self.writer.take() {
            writer
                .finish()
                .map_err(|err| format!("could not write the sound: {err}"))?;
        }
        Ok(self.first_sample)
    }
}

/// How many sample frames of silence go before a chunk first heard at
/// `heard`, given that the sound's first sample was heard at `first` and
/// `written` frames have been written since: none unless the chunk is
/// more than [`SILENCE_AFTER`] later than they account for.
pub fn missing_frames(first: Instant, written: u64, sample_rate: u32, heard: Instant) -> u64 {
    let rate = u64::from(sample_rate.max(1));
    let nanos = u128::from(written) * 1_000_000_000 / u128::from(rate);
    let accounted = first + Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX));
    match heard.checked_duration_since(accounted) {
        Some(late) if late > SILENCE_AFTER => {
            (late.as_secs_f64() * f64::from(sample_rate)).round() as u64
        }
        _ => 0,
    }
}

/// Writes `frames` sample frames of silence, a piece at a time.
fn write_silence<W: Write + Seek>(
    writer: &mut WavWriter<W>,
    frames: u64,
    channels: u16,
) -> io::Result<()> {
    const PIECE: u64 = 4800;
    if frames == 0 {
        return Ok(());
    }
    let channels = u64::from(channels.max(1));
    let zeros = vec![0u8; (PIECE * channels * 2) as usize];
    let mut left = frames;
    while left > 0 {
        let now = left.min(PIECE);
        writer.write_bytes(&zeros[..(now * channels * 2) as usize])?;
        left -= now;
    }
    Ok(())
}

/// Float samples from `planes`, each holding its channel count of
/// interleaved channels in turn (one plane of two, say, or two planes of
/// one), as `channels` interleaved 16-bit ones: the first `channels` of
/// them, or the one there is repeated.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn interleave_planes(planes: &[(&[f32], usize)], channels: usize) -> Vec<i16> {
    let frames = planes
        .iter()
        .map(|(samples, count)| samples.len() / (*count).max(1))
        .min()
        .unwrap_or(0);
    let total: usize = planes.iter().map(|(_, count)| *count).sum();
    if total == 0 || channels == 0 {
        return Vec::new();
    }
    let float = |sample: f32| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
    let mut out = Vec::with_capacity(frames * channels);
    for frame in 0..frames {
        for channel in 0..channels {
            // The channel'th across the planes, or the last there is.
            let mut wanted = channel.min(total - 1);
            for (samples, count) in planes {
                if wanted < *count {
                    out.push(float(samples[frame * count + wanted]));
                    break;
                }
                wanted -= count;
            }
        }
    }
    out
}

/// When the first of `samples` (interleaved over `channels`) was heard,
/// given that the last of them arrived at `at`.
pub fn first_sample_at(at: Instant, samples: usize, channels: u16, sample_rate: u32) -> Instant {
    let frames = samples / usize::from(channels.max(1));
    let nanos = frames as u128 * 1_000_000_000 / u128::from(sample_rate.max(1));
    let span = Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX));
    at.checked_sub(span).unwrap_or(at)
}

/// How far the sound is shifted against the video, in seconds: positive
/// when the first sample was heard after the first frame was grabbed,
/// which delays the sound; negative when before, which trims its start.
pub fn offset(first_frame: Instant, first_sample: Instant) -> f64 {
    if first_sample >= first_frame {
        (first_sample - first_frame).as_secs_f64()
    } else {
        -(first_frame - first_sample).as_secs_f64()
    }
}

/// A WAV in the temporary folder for one recording's sound from `tag`.
fn scratch_wav(tag: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "grab-it-{tag}-{}-{}.wav",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The sound of a finished recording, in a WAV deleted when this is
/// dropped.
pub struct Captured {
    pub wav: PathBuf,
    /// When the first sample was heard.
    pub first_sample: Instant,
    channels: u16,
    sample_rate: u32,
}

impl Captured {
    /// Cuts the stretches the video skipped (`gaps`) out of the sound, so
    /// what comes after them stays in step. `offset` is when the sound
    /// starts against the first frame, as [`offset`] says.
    pub fn cut(&self, gaps: &[Gap], offset: f64) -> io::Result<()> {
        let ranges = gap_frames(gaps, offset, self.sample_rate);
        if ranges.is_empty() {
            return Ok(());
        }
        let cut = self.wav.with_extension("cut.wav");
        let result = cut_wav(&self.wav, &cut, self.channels, self.sample_rate, &ranges)
            .and_then(|()| fs::rename(&cut, &self.wav));
        if result.is_err() {
            let _ = fs::remove_file(&cut);
        }
        result
    }
}

/// A stretch of the recording the video skipped, `start` after its first
/// frame and `length` long (see `record::Pacer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gap {
    pub start: Duration,
    pub length: Duration,
}

/// The sample frames of the sound that fall in `gaps`, as sorted `[from,
/// to)` ranges, merged where they touch or overlap, given that the sound starts `offset` seconds after
/// the first frame. Sound before the first frame is not counted here: the
/// mux cuts it.
pub fn gap_frames(gaps: &[Gap], offset: f64, sample_rate: u32) -> Vec<(u64, u64)> {
    let frame_at = |seconds: f64| (seconds.max(0.0) * f64::from(sample_rate)).round() as u64;
    let mut ranges: Vec<(u64, u64)> = gaps
        .iter()
        .filter_map(|gap| {
            let start = gap.start.as_secs_f64() - offset;
            let from = frame_at(start);
            let to = frame_at(start + gap.length.as_secs_f64());
            (to > from).then_some((from, to))
        })
        .collect();
    ranges.sort_unstable();
    // Touching or overlapping ranges become one.
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (from, to) in ranges {
        match merged.last_mut() {
            Some(last) if from <= last.1 => last.1 = last.1.max(to),
            _ => merged.push((from, to)),
        }
    }
    merged
}

/// Copies the 16-bit WAV `from` (as [`WavWriter`] writes it) to `to`,
/// leaving out the sample frames in `ranges`, which must be sorted and not
/// overlap, as [`gap_frames`] gives them. One pass over the file, copying
/// and skipping whole stretches.
fn cut_wav(
    from: &Path,
    to: &Path,
    channels: u16,
    sample_rate: u32,
    ranges: &[(u64, u64)],
) -> io::Result<()> {
    let frame_bytes = u64::from(channels.max(1)) * 2;
    let mut input = BufReader::new(File::open(from)?);
    input.seek(SeekFrom::Start(u64::from(WAV_HEADER_BYTES)))?;
    let mut writer = WavWriter::new(BufWriter::new(File::create(to)?), channels, sample_rate)?;
    let mut buffer = vec![0u8; 64 * 1024];
    // The sample frame `input` is at.
    let mut at = 0u64;
    for &(start, end) in ranges {
        if end <= at {
            continue;
        }
        if start > at {
            let wanted = (start - at) * frame_bytes;
            let copied = copy_bytes(&mut input, &mut writer, wanted, &mut buffer)?;
            if copied < wanted {
                // The sound ended before this gap.
                return finish_cut(writer);
            }
            at = start;
        }
        let skip = (end - at) * frame_bytes;
        input.seek_relative(i64::try_from(skip).unwrap_or(i64::MAX))?;
        at = end;
    }
    copy_bytes(&mut input, &mut writer, u64::MAX, &mut buffer)?;
    finish_cut(writer)
}

/// Copies up to `limit` bytes of samples from `input` to `writer`, in
/// `buffer`-sized pieces. Returns how many there were.
fn copy_bytes<R: Read, W: Write + Seek>(
    input: &mut R,
    writer: &mut WavWriter<W>,
    limit: u64,
    buffer: &mut [u8],
) -> io::Result<u64> {
    let mut copied = 0u64;
    while copied < limit {
        let want = usize::try_from(limit - copied)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = match input.read(&mut buffer[..want]) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        writer.write_bytes(&buffer[..read])?;
        copied += read as u64;
    }
    Ok(copied)
}

fn finish_cut<W: Write + Seek>(writer: WavWriter<W>) -> io::Result<()> {
    writer.finish()?;
    Ok(())
}

impl Drop for Captured {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);
    }
}

/// An [`Input`] being recorded.
pub struct Sound {
    input: Input,
    wav: PathBuf,
    sink: SharedSink,
    capture: Option<platform::Capture>,
}

impl Sound {
    /// Starts recording `input`. On Linux `ffmpeg` reads it.
    pub fn start(ffmpeg: &Path, input: Input) -> Result<Self, String> {
        let wav = scratch_wav(input.tag());
        match platform::Capture::start(ffmpeg, &input, &wav) {
            Ok((capture, sink)) => Ok(Self {
                input,
                wav,
                sink,
                capture: Some(capture),
            }),
            Err(err) => {
                let _ = std::fs::remove_file(&wav);
                Err(err)
            }
        }
    }

    /// What it records, as the card calls it.
    pub fn what(&self) -> &'static str {
        self.input.what()
    }

    /// Stops recording. Returns the sound, or an error saying why there is
    /// none.
    pub fn stop(mut self) -> Result<Captured, String> {
        let said = match self.capture.take() {
            Some(capture) => capture.stop(),
            None => None,
        };
        let (finished, channels, sample_rate) = {
            let mut sink = lock(&self.sink);
            (sink.finish(), sink.channels, sink.sample_rate)
        };
        // From here the WAV is the result's to delete.
        let wav = std::mem::take(&mut self.wav);
        match finished {
            Ok(Some(first_sample)) => Ok(Captured {
                wav,
                first_sample,
                channels,
                sample_rate,
            }),
            Ok(None) => {
                let _ = std::fs::remove_file(&wav);
                Err(said.unwrap_or_else(|| self.input.silent().to_owned()))
            }
            Err(err) => {
                let _ = std::fs::remove_file(&wav);
                Err(err)
            }
        }
    }
}

impl Drop for Sound {
    fn drop(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        if !self.wav.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.wav);
        }
    }
}

/// The microphones that can be picked. On Linux `ffmpeg` lists them, so
/// without it there are none to list.
pub fn microphones(ffmpeg: Option<&Path>) -> Result<Vec<MicrophoneInfo>, String> {
    platform::microphones(ffmpeg)
}

/// Lists the microphones for Settings. Async: listing asks the sound
/// server, which may take a moment.
#[tauri::command(async)]
pub fn recording_microphones(app: AppHandle) -> Vec<MicrophoneInfo> {
    let ffmpeg = crate::ffmpeg::ready(&app).map(|ready| ready.path);
    microphones(ffmpeg.as_deref()).unwrap_or_else(|err| {
        eprintln!("Grab-it: could not list the microphones: {err}");
        Vec::new()
    })
}

/// The microphones in what `ffmpeg -sources pulse` prints. Each line after
/// the heading is a source's name and its description in brackets, the
/// default one marked with `*`. Monitors of outputs are system sound, not
/// microphones, and are left out.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_pulse_sources(text: &str) -> Vec<MicrophoneInfo> {
    text.lines()
        .filter(|line| !line.trim_end().ends_with(':'))
        .filter_map(|line| {
            let line = line.trim_end();
            let (is_default, rest) = match line.strip_prefix('*') {
                Some(rest) => (true, rest),
                None => (false, line),
            };
            let rest = rest.trim_start();
            let (id, name) = match rest.split_once(" [") {
                Some((id, name)) => (id.trim(), name.strip_suffix(']').unwrap_or(name).trim()),
                None => (rest.trim(), ""),
            };
            if id.is_empty() || id.ends_with(".monitor") {
                return None;
            }
            Some(MicrophoneInfo {
                id: id.to_owned(),
                name: if name.is_empty() { id } else { name }.to_owned(),
                is_default,
            })
        })
        .collect()
}

/// The PulseAudio source ffmpeg records on Linux.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PULSE_RATE: u32 = 48_000;

/// The Pulse source `input` is read from, and its channels: the chosen
/// microphone (the default source when None) in mono, or the default
/// output's monitor, which hears what it plays, in stereo.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn pulse_source(input: &Input) -> (&str, u16) {
    match input {
        Input::Microphone(device) => (
            device
                .as_deref()
                .filter(|device| !device.is_empty())
                .unwrap_or("default"),
            1,
        ),
        Input::System => ("@DEFAULT_MONITOR@", 2),
    }
}

/// ffmpeg's arguments to record the Pulse source `source` in `channels`
/// and write raw 16-bit samples to stdout.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn pulse_capture_args(source: &str, channels: u16) -> Vec<std::ffi::OsString> {
    let rate = PULSE_RATE.to_string();
    // 20 ms of sound a read, so the first sample's time is close.
    let fragment = (PULSE_RATE / 50 * u32::from(channels) * 2).to_string();
    let channels = channels.to_string();
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "pulse",
        "-sample_rate",
        rate.as_str(),
        "-channels",
        channels.as_str(),
        "-fragment_size",
        fragment.as_str(),
        "-i",
        source,
        "-f",
        "s16le",
        "pipe:1",
    ]
    .into_iter()
    .map(std::ffi::OsString::from)
    .collect()
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        io::Read,
        path::Path,
        process::{Child, Stdio},
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    use super::{
        Input, MicrophoneInfo, PULSE_RATE, SharedSink, Sink, lock, parse_pulse_sources,
        pulse_capture_args, pulse_source,
    };

    /// How long ffmpeg gets to exit once told to.
    const EXIT_TIMEOUT: Duration = Duration::from_secs(5);

    /// ffmpeg reading the microphone or the system sound, and the thread
    /// writing what it reads.
    pub struct Capture {
        child: Child,
        reader: Option<JoinHandle<()>>,
        stderr: Option<JoinHandle<String>>,
        what: &'static str,
    }

    impl Capture {
        pub fn start(
            ffmpeg: &Path,
            input: &Input,
            wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            let (source, channels) = pulse_source(input);
            let sink = Sink::create(wav, channels, PULSE_RATE, input.fills_gaps())?;
            let mut child = crate::ffmpeg::command(ffmpeg)
                .args(pulse_capture_args(source, channels))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|err| format!("could not start {}: {err}", ffmpeg.display()))?;
            let stderr = child.stderr.take().map(|mut stderr| {
                thread::spawn(move || {
                    let mut text = String::new();
                    let _ = stderr.read_to_string(&mut text);
                    text
                })
            });
            let reader = child.stdout.take().map(|mut stdout| {
                let sink = SharedSink::clone(&sink);
                thread::spawn(move || {
                    let mut buffer = vec![0u8; 8 * 1024];
                    // An odd byte left over from the read before.
                    let mut carry: Option<u8> = None;
                    loop {
                        let read = match stdout.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => read,
                        };
                        let at = Instant::now();
                        let mut bytes = Vec::with_capacity(read + 1);
                        bytes.extend(carry.take());
                        bytes.extend_from_slice(&buffer[..read]);
                        if !bytes.len().is_multiple_of(2) {
                            carry = bytes.pop();
                        }
                        let samples: Vec<i16> = bytes
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|pair| i16::from_le_bytes(*pair))
                            .collect();
                        lock(&sink).push(&samples, at);
                    }
                })
            });
            Ok((
                Self {
                    child,
                    reader,
                    stderr,
                    what: input.what(),
                },
                sink,
            ))
        }

        /// Stops ffmpeg. Returns what it said when it failed by itself.
        pub fn stop(mut self) -> Option<String> {
            // Grab-it writes the WAV, so ffmpeg has nothing to finish.
            let exited_early =
                matches!(self.child.try_wait(), Ok(Some(status)) if !status.success());
            let _ = self.child.kill();
            let _ = crate::ffmpeg::wait_for(&mut self.child, EXIT_TIMEOUT);
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
            let said = self
                .stderr
                .take()
                .and_then(|reader| reader.join().ok())
                .unwrap_or_default();
            let what = self.what;
            exited_early.then(|| {
                crate::ffmpeg::last_line(&said)
                    .map(|line| format!("ffmpeg could not record {what}: {line}"))
                    .unwrap_or_else(|| format!("ffmpeg could not record {what}"))
            })
        }
    }

    pub fn microphones(ffmpeg: Option<&Path>) -> Result<Vec<MicrophoneInfo>, String> {
        let Some(ffmpeg) = ffmpeg else {
            return Ok(Vec::new());
        };
        let output = crate::ffmpeg::command(ffmpeg)
            .args(["-hide_banner", "-sources", "pulse"])
            .stdin(Stdio::null())
            .output()
            .map_err(|err| format!("could not start {}: {err}", ffmpeg.display()))?;
        Ok(parse_pulse_sources(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform {
    use std::{
        path::Path,
        sync::mpsc,
        thread::{self, JoinHandle},
        time::Instant,
    };

    use cpal::{
        Data, InputCallbackInfo, SampleFormat, SupportedStreamConfig,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{Input, MicrophoneInfo, START_TIMEOUT, SharedSink, Sink, lock};

    /// What keeps the sound coming until it is dropped.
    enum Held {
        Cpal(#[allow(dead_code)] cpal::Stream),
        #[cfg(target_os = "macos")]
        Screen(#[allow(dead_code)] super::system_mac::Stream),
    }

    /// The thread holding the stream, which is not `Send` everywhere.
    pub struct Capture {
        stop: mpsc::Sender<()>,
        thread: Option<JoinHandle<()>>,
    }

    impl Capture {
        pub fn start(
            _ffmpeg: &Path,
            input: &Input,
            wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            let (ready_tx, ready_rx) = mpsc::channel::<Result<SharedSink, String>>();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let what = input.what();
            let input = input.clone();
            let wav = wav.to_owned();
            let thread = thread::Builder::new()
                .name(format!("grab-it-{}", input.tag()))
                .spawn(move || match open(&input, &wav) {
                    Ok((stream, sink)) => {
                        let _ = ready_tx.send(Ok(sink));
                        // Until stopped, or until the recording is dropped.
                        let _ = stop_rx.recv();
                        drop(stream);
                    }
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                    }
                })
                .map_err(|err| format!("could not start {what}: {err}"))?;
            let capture = Self {
                stop: stop_tx,
                thread: Some(thread),
            };
            match ready_rx.recv_timeout(START_TIMEOUT) {
                Ok(Ok(sink)) => Ok((capture, sink)),
                Ok(Err(err)) => Err(err),
                Err(_) => Err(format!("{what} did not start")),
            }
        }

        pub fn stop(mut self) -> Option<String> {
            let _ = self.stop.send(());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            None
        }
    }

    /// Opens `input` and starts it into a WAV at `wav`.
    fn open(input: &Input, wav: &Path) -> Result<(Held, SharedSink), String> {
        match input {
            Input::Microphone(name) => open_microphone(name.as_deref(), wav)
                .map(|(stream, sink)| (Held::Cpal(stream), sink)),
            #[cfg(target_os = "windows")]
            Input::System => open_loopback(wav).map(|(stream, sink)| (Held::Cpal(stream), sink)),
            #[cfg(target_os = "macos")]
            Input::System => super::system_mac::Stream::start(wav)
                .map(|(stream, sink)| (Held::Screen(stream), sink)),
        }
    }

    /// Opens the default output device for WASAPI loopback, which hears
    /// what it plays, and starts it into a WAV at `wav`: cpal records an
    /// output device that is opened for input that way.
    #[cfg(target_os = "windows")]
    fn open_loopback(wav: &Path) -> Result<(cpal::Stream, SharedSink), String> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or("there is no sound output")?;
        let supported = device
            .default_output_config()
            .map_err(|err| format!("could not use the sound output: {err}"))?;
        start_stream(&device, supported, wav, &Input::System)
    }

    /// Opens `name`, or the default microphone, and starts it into a WAV
    /// at `wav`.
    fn open_microphone(
        name: Option<&str>,
        wav: &Path,
    ) -> Result<(cpal::Stream, SharedSink), String> {
        let host = cpal::default_host();
        let named = name.and_then(|name| {
            let found = host
                .input_devices()
                .ok()
                .and_then(|mut devices| devices.find(|device| device.to_string() == name));
            if found.is_none() {
                eprintln!("Grab-it: no microphone named {name}; recording the default one");
            }
            found
        });
        let device = named
            .or_else(|| host.default_input_device())
            .ok_or("there is no microphone")?;
        let supported = device
            .default_input_config()
            .map_err(|err| format!("could not use the microphone: {err}"))?;
        start_stream(&device, supported, wav, &Input::Microphone(None))
    }

    /// Starts `device` as an input stream in `supported` into a WAV at
    /// `wav`. `input` says what it is.
    fn start_stream(
        device: &cpal::Device,
        supported: SupportedStreamConfig,
        wav: &Path,
        input: &Input,
    ) -> Result<(cpal::Stream, SharedSink), String> {
        let what = input.what();
        let format = supported.sample_format();
        if !matches!(
            format,
            SampleFormat::F32
                | SampleFormat::F64
                | SampleFormat::I8
                | SampleFormat::I16
                | SampleFormat::I32
                | SampleFormat::U8
                | SampleFormat::U16
        ) {
            return Err(format!("{what} sends {format} samples"));
        }
        let config = supported.config();
        let channels = usize::from(config.channels.max(1));
        // More than two channels (an audio interface, say) keeps the first two.
        let kept = channels.min(2);
        let sink = Sink::create(wav, kept as u16, config.sample_rate, input.fills_gaps())?;
        let writer = SharedSink::clone(&sink);
        let stream = device
            .build_input_stream_raw(
                config,
                format,
                move |data: &Data, _: &InputCallbackInfo| {
                    let at = Instant::now();
                    let samples = to_i16(data);
                    let samples: Vec<i16> = if kept == channels {
                        samples
                    } else {
                        samples
                            .chunks(channels)
                            .flat_map(|frame| frame.iter().take(kept).copied())
                            .collect()
                    };
                    lock(&writer).push(&samples, at);
                },
                move |err| eprintln!("Grab-it: {what} failed: {err}"),
                None,
            )
            .map_err(|err| format!("could not open {what}: {err}"))?;
        stream
            .play()
            .map_err(|err| format!("could not start {what}: {err}"))?;
        Ok((stream, sink))
    }

    /// The samples as 16-bit integers, whatever the microphone sends.
    fn to_i16(data: &Data) -> Vec<i16> {
        let float = |sample: f64| (sample.clamp(-1.0, 1.0) * f64::from(i16::MAX)) as i16;
        match data.sample_format() {
            SampleFormat::F32 => data
                .as_slice::<f32>()
                .map(|s| s.iter().map(|&x| float(f64::from(x))).collect()),
            SampleFormat::F64 => data
                .as_slice::<f64>()
                .map(|s| s.iter().map(|&x| float(x)).collect()),
            SampleFormat::I16 => data.as_slice::<i16>().map(<[i16]>::to_vec),
            SampleFormat::I32 => data
                .as_slice::<i32>()
                .map(|s| s.iter().map(|&x| (x >> 16) as i16).collect()),
            SampleFormat::I8 => data
                .as_slice::<i8>()
                .map(|s| s.iter().map(|&x| i16::from(x) << 8).collect()),
            SampleFormat::U8 => data
                .as_slice::<u8>()
                .map(|s| s.iter().map(|&x| (i16::from(x) - 128) << 8).collect()),
            SampleFormat::U16 => data
                .as_slice::<u16>()
                .map(|s| s.iter().map(|&x| (i32::from(x) - 32768) as i16).collect()),
            _ => None,
        }
        .unwrap_or_default()
    }

    pub fn microphones(_ffmpeg: Option<&Path>) -> Result<Vec<MicrophoneInfo>, String> {
        let host = cpal::default_host();
        let default = host.default_input_device().map(|device| device.to_string());
        let devices = host
            .input_devices()
            .map_err(|err| format!("could not list the microphones: {err}"))?;
        let mut list: Vec<MicrophoneInfo> = Vec::new();
        for device in devices {
            let name = device.to_string();
            if list.iter().any(|known| known.id == name) {
                continue;
            }
            list.push(MicrophoneInfo {
                is_default: default.as_deref() == Some(name.as_str()),
                id: name.clone(),
                name,
            });
        }
        Ok(list)
    }
}

/// Elsewhere there is no sound to record.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use std::path::Path;

    use super::{Input, MicrophoneInfo, SharedSink};

    pub struct Capture;

    impl Capture {
        pub fn start(
            _ffmpeg: &Path,
            input: &Input,
            _wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            Err(format!("recording {} is not supported here", input.what()))
        }

        pub fn stop(self) -> Option<String> {
            None
        }
    }

    pub fn microphones(_ffmpeg: Option<&Path>) -> Result<Vec<MicrophoneInfo>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn a_wav_holds_its_samples_and_their_sizes() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), 1, 48_000).unwrap();
        writer.write(&[0, 1, -1]).unwrap();
        writer.write(&[i16::MAX]).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert_eq!(bytes.len(), 44 + 8);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        // PCM, mono, 48 kHz, 96 000 bytes a second, 2-byte frames, 16 bits.
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 1);
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(
            u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
            96_000
        );
        assert_eq!(u16::from_le_bytes([bytes[32], bytes[33]]), 2);
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16);
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 8);
        assert_eq!(&bytes[44..], &[0, 0, 1, 0, 0xff, 0xff, 0xff, 0x7f]);
    }

    #[test]
    fn the_first_sample_was_heard_a_chunk_before_it_arrived() {
        let at = Instant::now() + Duration::from_secs(1);
        // 960 stereo frames at 48 kHz: 20 ms.
        assert_eq!(
            first_sample_at(at, 1920, 2, 48_000),
            at - Duration::from_millis(20)
        );
        assert_eq!(first_sample_at(at, 0, 1, 48_000), at);
    }

    #[test]
    fn the_sound_is_shifted_by_the_gap_to_the_first_frame() {
        let frame = Instant::now() + Duration::from_secs(1);
        let later = frame + Duration::from_millis(120);
        let earlier = frame - Duration::from_millis(250);
        assert!((offset(frame, later) - 0.12).abs() < 1e-9);
        assert!((offset(frame, earlier) + 0.25).abs() < 1e-9);
        assert_eq!(offset(frame, frame), 0.0);
    }

    #[test]
    fn the_sink_notes_when_its_first_sample_was_heard() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("mic.wav");
        let sink = Sink::create(&wav, 1, 1000, false).unwrap();
        let at = Instant::now() + Duration::from_secs(1);
        lock(&sink).push(&[], at);
        lock(&sink).push(&[1; 100], at);
        lock(&sink).push(&[2; 100], at + Duration::from_millis(100));
        let first = lock(&sink).finish().unwrap();
        assert_eq!(first, Some(at - Duration::from_millis(100)));
        assert_eq!(std::fs::metadata(&wav).unwrap().len(), 44 + 400);
    }

    #[test]
    fn gaps_are_found_in_the_sound_by_its_offset() {
        let ms = Duration::from_millis;
        let gaps = [
            Gap {
                start: ms(2000),
                length: ms(500),
            },
            Gap {
                start: ms(700),
                length: ms(100),
            },
        ];
        // The sound started 250 ms before the first frame, so it is 250 ms
        // further along at each gap.
        assert_eq!(
            gap_frames(&gaps, -0.25, 1000),
            vec![(950, 1050), (2250, 2750)]
        );
        // Started 100 ms after: 100 ms less far along.
        assert_eq!(gap_frames(&gaps, 0.1, 1000), vec![(600, 700), (1900, 2400)]);
        // A gap over before the sound began cuts nothing.
        assert_eq!(gap_frames(&[gaps[1]], 1.0, 1000), Vec::<(u64, u64)>::new());
    }

    #[test]
    fn the_sound_the_video_skipped_is_cut_out() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("mic.wav");
        // Stereo at 10 Hz: frame n holds the samples n and -n.
        let mut writer =
            WavWriter::new(BufWriter::new(File::create(&wav).unwrap()), 2, 10).unwrap();
        let samples: Vec<i16> = (0..20).flat_map(|n| [n, -n]).collect();
        writer.write(&samples).unwrap();
        writer.finish().unwrap();
        let sound = Captured {
            wav: wav.clone(),
            first_sample: Instant::now(),
            channels: 2,
            sample_rate: 10,
        };
        let gap = Gap {
            start: Duration::from_millis(500),
            length: Duration::from_millis(300),
        };
        sound.cut(&[gap], 0.0).unwrap();

        let bytes = fs::read(&wav).unwrap();
        let kept: Vec<i16> = bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes(*pair))
            .collect();
        let expected: Vec<i16> = (0..5).chain(8..20).flat_map(|n| [n, -n]).collect();
        assert_eq!(kept, expected);
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            (expected.len() * 2) as u32
        );
        // Nothing but the sound is left behind, and dropping it deletes it.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(sound);
        assert!(!wav.exists());
    }

    #[test]
    fn touching_and_overlapping_gaps_are_merged() {
        let ms = Duration::from_millis;
        let gap = |start, length| Gap {
            start: ms(start),
            length: ms(length),
        };
        let gaps = [gap(500, 100), gap(100, 100), gap(200, 100), gap(550, 200)];
        assert_eq!(gap_frames(&gaps, 0.0, 1000), vec![(100, 300), (500, 750)]);
    }

    #[test]
    fn several_gaps_are_cut_in_one_pass() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("mic.wav");
        // Mono at 100 Hz: sample n is n.
        let mut writer =
            WavWriter::new(BufWriter::new(File::create(&wav).unwrap()), 1, 100).unwrap();
        let samples: Vec<i16> = (0..300).collect();
        writer.write(&samples).unwrap();
        writer.finish().unwrap();
        let sound = Captured {
            wav: wav.clone(),
            first_sample: Instant::now(),
            channels: 1,
            sample_rate: 100,
        };
        let ms = Duration::from_millis;
        let gap = |start, length| Gap {
            start: ms(start),
            length: ms(length),
        };
        // Frames 10-20 and 20-30 touch; 0-5 starts the sound; 250-400
        // runs past its end.
        let gaps = [
            gap(200, 100),
            gap(100, 100),
            gap(0, 50),
            gap(1000, 10),
            gap(2500, 1500),
        ];
        sound.cut(&gaps, 0.0).unwrap();

        let bytes = fs::read(&wav).unwrap();
        let kept: Vec<i16> = bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes(*pair))
            .collect();
        let expected: Vec<i16> = (5..10).chain(30..100).chain(101..250).collect();
        assert_eq!(kept, expected);
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            (expected.len() * 2) as u32
        );
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            36 + (expected.len() * 2) as u32
        );
    }

    #[test]
    fn pulse_sources_are_listed_without_monitors() {
        let text = "Auto-detected sources for pulse:\n\
                    \x20 alsa_output.pci-0000_00_1f.3.analog-stereo.monitor [Monitor of Built-in Audio Analog Stereo]\n\
                    * alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo]\n\
                    \x20 alsa_input.usb-Blue_Yeti-00.analog-stereo [Yeti Stereo Microphone]\n\
                    \x20 bare_source\n";
        assert_eq!(
            parse_pulse_sources(text),
            vec![
                MicrophoneInfo {
                    id: "alsa_input.pci-0000_00_1f.3.analog-stereo".into(),
                    name: "Built-in Audio Analog Stereo".into(),
                    is_default: true,
                },
                MicrophoneInfo {
                    id: "alsa_input.usb-Blue_Yeti-00.analog-stereo".into(),
                    name: "Yeti Stereo Microphone".into(),
                    is_default: false,
                },
                MicrophoneInfo {
                    id: "bare_source".into(),
                    name: "bare_source".into(),
                    is_default: false,
                },
            ]
        );
        assert_eq!(parse_pulse_sources(""), Vec::new());
    }

    #[test]
    fn pulse_is_read_as_raw_samples_on_stdout() {
        let args = |input: Input| {
            let (source, channels) = pulse_source(&input);
            pulse_capture_args(source, channels)
                .into_iter()
                .map(|arg| arg.into_string().unwrap())
                .collect::<Vec<_>>()
                .join(" ")
        };
        let microphone = |device: Option<&str>| Input::Microphone(device.map(str::to_owned));
        assert_eq!(
            args(microphone(Some("alsa_input.usb"))),
            "-hide_banner -loglevel error -nostdin -f pulse -sample_rate 48000 -channels 1 \
             -fragment_size 1920 -i alsa_input.usb -f s16le pipe:1"
        );
        assert!(args(microphone(None)).contains("-i default -f s16le"));
        assert!(args(microphone(Some(""))).contains("-i default -f s16le"));
        // The system sound is the default output's monitor, in stereo.
        assert_eq!(
            args(Input::System),
            "-hide_banner -loglevel error -nostdin -f pulse -sample_rate 48000 -channels 2 \
             -fragment_size 3840 -i @DEFAULT_MONITOR@ -f s16le pipe:1"
        );
    }

    #[test]
    fn system_sound_is_offered_on_windows_linux_and_macos_13() {
        // macOS before 13 has no ScreenCaptureKit sound; the CI runners
        // are newer.
        let expected = cfg!(any(
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        ));
        assert_eq!(system_available(), expected);
        assert_eq!(recording_system_audio(), expected);
    }

    #[test]
    fn each_input_says_what_it_is_and_names_its_wav() {
        let microphone = Input::Microphone(Some("Mic".into()));
        assert_eq!(microphone.what(), "the microphone");
        assert_eq!(Input::System.what(), "the system sound");
        assert!(!microphone.fills_gaps());
        assert!(Input::System.fills_gaps());
        let wav = scratch_wav(Input::System.tag());
        let name = wav.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("grab-it-system-"), "{name}");
        assert!(name.ends_with(".wav"), "{name}");
    }

    #[test]
    fn a_late_chunk_of_system_sound_is_preceded_by_silence() {
        let first = Instant::now() + Duration::from_secs(1);
        let ms = Duration::from_millis;
        // 1000 frames at 1 kHz is a second: a chunk heard then is on time.
        assert_eq!(missing_frames(first, 1000, 1000, first + ms(1000)), 0);
        // Late by no more than the allowance: chunks arrive in bursts.
        assert_eq!(missing_frames(first, 1000, 1000, first + ms(1100)), 0);
        // Early: nothing is missing.
        assert_eq!(missing_frames(first, 1000, 1000, first + ms(500)), 0);
        // Nothing played for 2.5 s.
        assert_eq!(missing_frames(first, 1000, 1000, first + ms(3500)), 2500);

        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("system.wav");
        let sink = Sink::create(&wav, 2, 1000, true).unwrap();
        // 100 stereo frames, then the next 100 half a second late.
        lock(&sink).push(&[1; 200], first + ms(100));
        lock(&sink).push(&[2; 200], first + ms(700));
        assert_eq!(lock(&sink).finish().unwrap(), Some(first));
        let bytes = fs::read(&wav).unwrap();
        let samples: Vec<i16> = bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes(*pair))
            .collect();
        // 100 frames, 500 of silence, then 100 more.
        assert_eq!(samples.len(), (100 + 500 + 100) * 2);
        assert!(samples[..200].iter().all(|&s| s == 1));
        assert!(samples[200..1200].iter().all(|&s| s == 0));
        assert!(samples[1200..].iter().all(|&s| s == 2));

        // The microphone is never padded.
        let wav = dir.path().join("mic.wav");
        let sink = Sink::create(&wav, 2, 1000, false).unwrap();
        lock(&sink).push(&[1; 200], first + ms(100));
        lock(&sink).push(&[2; 200], first + ms(700));
        lock(&sink).finish().unwrap();
        assert_eq!(fs::metadata(&wav).unwrap().len(), 44 + 800);
    }

    #[test]
    fn screen_capture_kit_planes_are_interleaved_as_16_bit_stereo() {
        let left: &[f32] = &[0.0, 0.5, -1.0];
        let right: &[f32] = &[1.0, -0.5, 2.0];
        // Two planes of one channel: ScreenCaptureKit's own layout.
        assert_eq!(
            interleave_planes(&[(left, 1), (right, 1)], 2),
            vec![0, 32767, 16383, -16383, -32767, 32767]
        );
        // One plane of two channels already interleaved.
        let both: &[f32] = &[0.0, 1.0, 0.5, -0.5];
        assert_eq!(
            interleave_planes(&[(both, 2)], 2),
            vec![0, 32767, 16383, -16383]
        );
        // One mono plane is repeated on both sides.
        assert_eq!(
            interleave_planes(&[(&left[..2], 1)], 2),
            vec![0, 0, 16383, 16383]
        );
        // Planes of different lengths stop at the shortest.
        assert_eq!(
            interleave_planes(&[(left, 1), (&right[..1], 1)], 2),
            vec![0, 32767]
        );
        assert_eq!(interleave_planes(&[], 2), Vec::<i16>::new());
    }

    #[test]
    fn microphones_serialize_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(MicrophoneInfo {
                id: "mic".into(),
                name: "Mic".into(),
                is_default: true,
            })
            .unwrap(),
            serde_json::json!({ "id": "mic", "name": "Mic", "isDefault": true })
        );
    }
}
