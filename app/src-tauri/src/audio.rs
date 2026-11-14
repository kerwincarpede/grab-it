//! The microphone, recorded into an MP4's sound.
//!
//! While an MP4 records, the chosen microphone is written to a 16-bit PCM
//! WAV in the temporary folder, and the time its first sample was heard is
//! noted. When the recording stops, ffmpeg muxes the WAV into the MP4 as
//! AAC, shifted by the gap between the first frame and that first sample
//! (see `ffmpeg::add_audio`), and the WAV is deleted.
//!
//! On macOS and Windows the microphone is read through cpal (Core Audio,
//! WASAPI). On Linux ffmpeg's own PulseAudio input reads it (`-f pulse`,
//! which PipeWire's Pulse server also answers) and pipes raw samples to
//! Grab-it, so no ALSA or Pulse headers are needed to build Grab-it.

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
        self.out.write_all(&bytes)?;
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
    /// The first write that failed.
    error: Option<String>,
}

type SharedSink = Arc<Mutex<Sink>>;

fn lock(sink: &SharedSink) -> MutexGuard<'_, Sink> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Sink {
    fn create(wav: &Path, channels: u16, sample_rate: u32) -> Result<SharedSink, String> {
        let file = File::create(wav)
            .map_err(|err| format!("could not create {}: {err}", wav.display()))?;
        let writer = WavWriter::new(BufWriter::new(file), channels, sample_rate)
            .map_err(|err| format!("could not write {}: {err}", wav.display()))?;
        Ok(Arc::new(Mutex::new(Self {
            writer: Some(writer),
            channels,
            sample_rate,
            first_sample: None,
            error: None,
        })))
    }

    /// Writes `samples`, which arrived at `at`.
    fn push(&mut self, samples: &[i16], at: Instant) {
        if samples.is_empty() {
            return;
        }
        if self.first_sample.is_none() {
            self.first_sample = Some(first_sample_at(
                at,
                samples.len(),
                self.channels,
                self.sample_rate,
            ));
        }
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        if let Err(err) = writer.write(samples)
            && self.error.is_none()
        {
            self.error = Some(format!("could not write the sound: {err}"));
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

/// A WAV in the temporary folder for one recording's sound.
fn scratch_wav() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "grab-it-microphone-{}-{}.wav",
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

/// The sample frames of the sound that fall in `gaps`, as sorted
/// `[from, to)` ranges, given that the sound starts `offset` seconds after
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
    ranges
}

/// Copies the 16-bit WAV `from` (as [`WavWriter`] writes it) to `to`,
/// leaving out the sample frames in `ranges`.
fn cut_wav(
    from: &Path,
    to: &Path,
    channels: u16,
    sample_rate: u32,
    ranges: &[(u64, u64)],
) -> io::Result<()> {
    let mut input = BufReader::new(File::open(from)?);
    input.seek(SeekFrom::Start(u64::from(WAV_HEADER_BYTES)))?;
    let mut writer = WavWriter::new(BufWriter::new(File::create(to)?), channels, sample_rate)?;
    let mut frame = vec![0u8; usize::from(channels.max(1)) * 2];
    let mut kept: Vec<i16> = Vec::with_capacity(8 * 1024);
    let mut index = 0u64;
    loop {
        match input.read_exact(&mut frame) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(err),
        }
        if !ranges
            .iter()
            .any(|&(start, end)| (start..end).contains(&index))
        {
            kept.extend(
                frame
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| i16::from_le_bytes(*pair)),
            );
            if kept.len() >= 8 * 1024 {
                writer.write(&kept)?;
                kept.clear();
            }
        }
        index += 1;
    }
    writer.write(&kept)?;
    writer.finish()?;
    Ok(())
}

impl Drop for Captured {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);
    }
}

/// The microphone being recorded.
pub struct Microphone {
    wav: PathBuf,
    sink: SharedSink,
    capture: Option<platform::Capture>,
}

impl Microphone {
    /// Starts recording `device` (a [`MicrophoneInfo::id`]), or the
    /// system's default microphone when None. On Linux `ffmpeg` reads it.
    pub fn start(ffmpeg: &Path, device: Option<&str>) -> Result<Self, String> {
        let wav = scratch_wav();
        match platform::Capture::start(ffmpeg, device, &wav) {
            Ok((capture, sink)) => Ok(Self {
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
                Err(said.unwrap_or_else(|| "the microphone sent no sound".to_owned()))
            }
            Err(err) => {
                let _ = std::fs::remove_file(&wav);
                Err(err)
            }
        }
    }
}

impl Drop for Microphone {
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
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PULSE_CHANNELS: u16 = 1;

/// ffmpeg's arguments to record the Pulse source `device` (its default
/// source when None) and write raw 16-bit samples to stdout.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn pulse_capture_args(device: Option<&str>) -> Vec<std::ffi::OsString> {
    let rate = PULSE_RATE.to_string();
    let channels = PULSE_CHANNELS.to_string();
    // 20 ms of sound a read, so the first sample's time is close.
    let fragment = (PULSE_RATE / 50 * u32::from(PULSE_CHANNELS) * 2).to_string();
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
        device
            .filter(|device| !device.is_empty())
            .unwrap_or("default"),
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
        MicrophoneInfo, PULSE_CHANNELS, PULSE_RATE, SharedSink, Sink, lock, parse_pulse_sources,
        pulse_capture_args,
    };

    /// How long ffmpeg gets to exit once told to.
    const EXIT_TIMEOUT: Duration = Duration::from_secs(5);

    /// ffmpeg reading the microphone, and the thread writing what it reads.
    pub struct Capture {
        child: Child,
        reader: Option<JoinHandle<()>>,
        stderr: Option<JoinHandle<String>>,
    }

    impl Capture {
        pub fn start(
            ffmpeg: &Path,
            device: Option<&str>,
            wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            let sink = Sink::create(wav, PULSE_CHANNELS, PULSE_RATE)?;
            let mut child = crate::ffmpeg::command(ffmpeg)
                .args(pulse_capture_args(device))
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
            exited_early.then(|| {
                crate::ffmpeg::last_line(&said)
                    .map(|line| format!("ffmpeg could not record the microphone: {line}"))
                    .unwrap_or_else(|| "ffmpeg could not record the microphone".to_owned())
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
        Data, InputCallbackInfo, SampleFormat,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{MicrophoneInfo, START_TIMEOUT, SharedSink, Sink, lock};

    /// The thread holding the cpal stream, which is not `Send` everywhere.
    pub struct Capture {
        stop: mpsc::Sender<()>,
        thread: Option<JoinHandle<()>>,
    }

    impl Capture {
        pub fn start(
            _ffmpeg: &Path,
            device: Option<&str>,
            wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            let (ready_tx, ready_rx) = mpsc::channel::<Result<SharedSink, String>>();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let device = device.map(str::to_owned);
            let wav = wav.to_owned();
            let thread = thread::Builder::new()
                .name("grab-it-microphone".into())
                .spawn(move || match open(device.as_deref(), &wav) {
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
                .map_err(|err| format!("could not start the microphone: {err}"))?;
            let capture = Self {
                stop: stop_tx,
                thread: Some(thread),
            };
            match ready_rx.recv_timeout(START_TIMEOUT) {
                Ok(Ok(sink)) => Ok((capture, sink)),
                Ok(Err(err)) => Err(err),
                Err(_) => Err("the microphone did not start".to_owned()),
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

    /// Opens `name`, or the default microphone, and starts it into a WAV
    /// at `wav`.
    fn open(name: Option<&str>, wav: &Path) -> Result<(cpal::Stream, SharedSink), String> {
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
            return Err(format!("the microphone sends {format} samples"));
        }
        let config = supported.config();
        let channels = usize::from(config.channels.max(1));
        // More than two channels (an audio interface, say) keeps the first two.
        let kept = channels.min(2);
        let sink = Sink::create(wav, kept as u16, config.sample_rate)?;
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
                |err| eprintln!("Grab-it: the microphone failed: {err}"),
                None,
            )
            .map_err(|err| format!("could not open the microphone: {err}"))?;
        stream
            .play()
            .map_err(|err| format!("could not start the microphone: {err}"))?;
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

/// Elsewhere there is no microphone to record.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use std::path::Path;

    use super::{MicrophoneInfo, SharedSink};

    pub struct Capture;

    impl Capture {
        pub fn start(
            _ffmpeg: &Path,
            _device: Option<&str>,
            _wav: &Path,
        ) -> Result<(Self, SharedSink), String> {
            Err("recording a microphone is not supported here".to_owned())
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
        let sink = Sink::create(&wav, 1, 1000).unwrap();
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
        let args = |device| {
            pulse_capture_args(device)
                .into_iter()
                .map(|arg| arg.into_string().unwrap())
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(
            args(Some("alsa_input.usb")),
            "-hide_banner -loglevel error -nostdin -f pulse -sample_rate 48000 -channels 1 \
             -fragment_size 1920 -i alsa_input.usb -f s16le pipe:1"
        );
        assert!(args(None).contains("-i default -f s16le"));
        assert!(args(Some("")).contains("-i default -f s16le"));
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
