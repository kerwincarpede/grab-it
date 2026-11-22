//! Plays the bundled confirmation sound through the desktop's default output.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use crate::{record, rt::AppHandle};

const RECORDING_ERROR: &str = "The copy sound is unavailable while recording.";

/// The persisted preference, available to clipboard writers without taking the settings lock.
pub(crate) struct Preference(AtomicBool);

impl Preference {
    pub(crate) fn new(enabled: bool) -> Self {
        Self(AtomicBool::new(enabled))
    }

    pub(crate) fn set(&self, enabled: bool) {
        self.0.store(enabled, Ordering::Release);
    }

    pub(crate) fn enabled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Whether a logical copy is user-facing or an automatic update to OCR's copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CopySound {
    Confirm,
    Silent,
}

impl CopySound {
    /// AI is the first writer only when OCR supplied no text.
    pub(crate) fn tidied(ocr_text: &str) -> Self {
        if ocr_text.trim().is_empty() {
            Self::Confirm
        } else {
            Self::Silent
        }
    }

    /// Runs confirmation once after a successful logical write.
    pub(crate) fn written<E>(self, result: Result<(), E>, confirm: impl FnOnce()) -> Result<(), E> {
        result.inspect(|()| {
            if self == Self::Confirm {
                confirm();
            }
        })
    }
}

/// Schedules audio separately from the clipboard operation.
pub(crate) fn confirm(app: &AppHandle) {
    if !app
        .try_state::<Preference>()
        .is_some_and(|preference| preference.enabled())
    {
        return;
    }
    let Some(ticket) = record::playback_ticket(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = play(app, ticket).await {
            eprintln!("Grab-it: {err}");
        }
    });
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
const WAV: &[u8] = include_bytes!("../sounds/2-holga-two-part.wav");

/// Previews the sound independently of the preference, whenever recording is idle.
#[tauri::command]
#[specta::specta]
pub async fn preview_copy_sound(app: AppHandle) -> Result<(), String> {
    let ticket = record::playback_ticket(&app).ok_or_else(|| RECORDING_ERROR.to_owned())?;
    play(app, ticket).await
}

/// Plays the bundled shutter sound on a worker thread, if the recording
/// generation still matches the one from when it was requested.
async fn play(app: AppHandle, ticket: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || output::play(&app, ticket))
        .await
        .map_err(|err| format!("Could not play the copy sound: {err}"))?
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod output {
    use std::{
        sync::{
            Arc, Mutex, PoisonError,
            atomic::{AtomicU64, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    use cpal::{
        BufferSize, Device, ErrorKind, FromSample, SampleFormat, SizedSample, Stream, StreamConfig,
        SupportedBufferSize,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{AppHandle, RECORDING_ERROR, WAV};
    use crate::record;

    // The checksum test pins this WAV's layout: 44-byte RIFF header and
    // 48 kHz mono signed 16-bit little-endian samples.
    const PCM: &[u8] = WAV.split_at(44).1;
    const SOURCE_RATE: f64 = 48_000.0;
    /// The longest one attempt may take to hand the whole clip to the output.
    const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);
    /// How long an output may ask for no samples before it counts as stalled.
    const STALL_TIMEOUT: Duration = Duration::from_millis(500);
    const CHECK_INTERVAL: Duration = Duration::from_millis(10);
    /// A clip that fails before it finishes is played once more on a fresh stream.
    const ATTEMPTS: usize = 2;
    /// The period asked for on Linux. ALSA's default there, through the
    /// PulseAudio plugin, is about 16 ms double-buffered, which stalls or
    /// underruns while a closing overlay or another stream keeps the CPU busy.
    /// ALSA and PulseAudio both double-buffer this, so about 150 ms is queued.
    const LINUX_PERIOD_MS: u64 = 75;
    const UNFINISHED: &str = "The audio output did not finish playing the copy sound.";

    /// Why one attempt at playing the clip ended without playing it.
    #[derive(Debug, PartialEq, Eq)]
    enum Failure {
        /// A recording started: stop without retrying.
        Cancelled,
        /// Retrying cannot help, such as when there is no output at all.
        Fatal(String),
        /// The stream failed or stalled; a fresh one may play it.
        Retry(String),
    }

    pub(super) fn play(app: &AppHandle, ticket: u64) -> Result<(), String> {
        retry(|| {
            if record::playback_current(app, ticket) {
                attempt(app, ticket)
            } else {
                Err(Failure::Cancelled)
            }
        })
    }

    /// Runs `attempt` until it plays the clip, is cancelled or fails for
    /// good, at most [`ATTEMPTS`] times.
    fn retry(mut attempt: impl FnMut() -> Result<(), Failure>) -> Result<(), String> {
        let mut last = String::new();
        for _ in 0..ATTEMPTS {
            match attempt() {
                Ok(()) => return Ok(()),
                Err(Failure::Cancelled) => return Err(RECORDING_ERROR.into()),
                Err(Failure::Fatal(message)) => return Err(message),
                Err(Failure::Retry(message)) => last = message,
            }
        }
        Err(last)
    }

    /// Plays the clip once on a fresh stream from the current default output.
    fn attempt(app: &AppHandle, ticket: u64) -> Result<(), Failure> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| Failure::Fatal("No default audio output is available.".into()))?;
        let supported = device.default_output_config().map_err(retryable)?;
        let format = supported.sample_format();
        let config = supported.config();
        let progress = Arc::new(Progress::default());
        let stream = match buffer_size(supported.buffer_size(), config.sample_rate) {
            BufferSize::Default => open(&device, config, format, &progress, app, ticket),
            larger => open(
                &device,
                StreamConfig {
                    buffer_size: larger,
                    ..config
                },
                format,
                &progress,
                app,
                ticket,
            )
            .or_else(|failure| match failure {
                Failure::Retry(_) => open(&device, config, format, &progress, app, ticket),
                failure => Err(failure),
            }),
        }?;
        let mut watch = Watch::new(Instant::now());
        let drain = loop {
            if !record::playback_current(app, ticket) {
                return Err(Failure::Cancelled);
            }
            let verdict = {
                let error = progress
                    .error
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                watch.check(
                    Instant::now(),
                    progress.callbacks.load(Ordering::Acquire),
                    progress.drain(),
                    error.as_ref(),
                )
            };
            match verdict {
                Verdict::Wait => thread::sleep(CHECK_INTERVAL),
                Verdict::Finished(drain) => break drain,
                Verdict::Failed(message) => return Err(Failure::Retry(message)),
            }
        };
        // Dropping the stream cancels queued output when recording starts,
        // even if there are no more callbacks to see the invalidated ticket.
        let finished = record::wait_for_playback(app, ticket, drain);
        drop(stream);
        if finished {
            Ok(())
        } else {
            Err(Failure::Cancelled)
        }
    }

    /// A larger buffer than the default on Linux, within what the output allows.
    fn buffer_size(supported: &SupportedBufferSize, rate: u32) -> BufferSize {
        if cfg!(target_os = "linux") {
            linux_buffer_size(supported, rate)
        } else {
            BufferSize::Default
        }
    }

    fn linux_buffer_size(supported: &SupportedBufferSize, rate: u32) -> BufferSize {
        let period = u32::try_from(u64::from(rate) * LINUX_PERIOD_MS / 1000).unwrap_or(u32::MAX);
        match *supported {
            SupportedBufferSize::Range { min, max } if min <= max => {
                BufferSize::Fixed(period.clamp(min, max))
            }
            SupportedBufferSize::Range { .. } => BufferSize::Default,
            // An unsupported size fails to build, and the default is tried.
            SupportedBufferSize::Unknown => BufferSize::Fixed(period),
        }
    }

    fn open(
        device: &Device,
        config: StreamConfig,
        format: SampleFormat,
        progress: &Arc<Progress>,
        app: &AppHandle,
        ticket: u64,
    ) -> Result<Stream, Failure> {
        type Build =
            fn(&Device, StreamConfig, Arc<Progress>, AppHandle, u64) -> Result<Stream, cpal::Error>;
        let build: Build = match format {
            SampleFormat::I8 => build::<i8>,
            SampleFormat::I16 => build::<i16>,
            SampleFormat::I24 => build::<cpal::I24>,
            SampleFormat::I32 => build::<i32>,
            SampleFormat::I64 => build::<i64>,
            SampleFormat::U8 => build::<u8>,
            SampleFormat::U16 => build::<u16>,
            SampleFormat::U24 => build::<cpal::U24>,
            SampleFormat::U32 => build::<u32>,
            SampleFormat::U64 => build::<u64>,
            SampleFormat::F32 => build::<f32>,
            SampleFormat::F64 => build::<f64>,
            _ => {
                return Err(Failure::Fatal(format!(
                    "The audio output uses an unsupported format ({format})."
                )));
            }
        };
        let stream =
            build(device, config, Arc::clone(progress), app.clone(), ticket).map_err(retryable)?;
        stream.play().map_err(retryable)?;
        Ok(stream)
    }

    fn retryable(err: cpal::Error) -> Failure {
        Failure::Retry(output_error(&err))
    }

    fn output_error(err: &cpal::Error) -> String {
        format!("Could not play the copy sound: {err}")
    }

    /// What the audio callbacks report to the thread watching them.
    #[derive(Default)]
    struct Progress {
        /// How many times the output asked for samples.
        callbacks: AtomicU64,
        /// Microseconds of queued output left when the last sample was
        /// handed over, plus one; zero until then.
        drain: AtomicU64,
        error: Mutex<Option<StreamError>>,
    }

    impl Progress {
        fn finish(&self, drain: Duration) {
            let micros = u64::try_from(drain.as_micros()).unwrap_or(u64::MAX - 1);
            self.drain.store(micros + 1, Ordering::Release);
        }

        fn drain(&self) -> Option<Duration> {
            match self.drain.load(Ordering::Acquire) {
                0 => None,
                micros => Some(Duration::from_micros(micros - 1)),
            }
        }

        fn failed(&self, err: &cpal::Error) {
            let Some(broken) = breaks_stream(err.kind()) else {
                return;
            };
            let mut error = self.error.lock().unwrap_or_else(PoisonError::into_inner);
            // A glitch never hides an earlier error that broke the stream.
            if broken || error.as_ref().is_none_or(|error| !error.broken) {
                *error = Some(StreamError {
                    broken,
                    message: output_error(err),
                });
            }
        }
    }

    /// An error the output stream reported while playing.
    #[derive(Clone, Debug)]
    struct StreamError {
        /// Whether the stream cannot be trusted to keep playing.
        broken: bool,
        message: String,
    }

    /// `None` for notices that need nothing, `Some(false)` for a glitch the
    /// stream recovers from by itself, `Some(true)` for an error after which
    /// the clip is played on a fresh stream.
    fn breaks_stream(kind: ErrorKind) -> Option<bool> {
        match kind {
            ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied => None,
            ErrorKind::Xrun => Some(false),
            _ => Some(true),
        }
    }

    /// What the watching thread does next.
    #[derive(Debug, PartialEq, Eq)]
    enum Verdict {
        Wait,
        /// The whole clip was handed over; wait this long for it to play.
        Finished(Duration),
        Failed(String),
    }

    /// Decides when an attempt has finished, failed or stalled.
    struct Watch {
        started: Instant,
        callbacks: u64,
        progressed: Instant,
    }

    impl Watch {
        fn new(now: Instant) -> Self {
            Self {
                started: now,
                callbacks: 0,
                progressed: now,
            }
        }

        fn check(
            &mut self,
            now: Instant,
            callbacks: u64,
            drain: Option<Duration>,
            error: Option<&StreamError>,
        ) -> Verdict {
            if let Some(drain) = drain {
                return Verdict::Finished(drain);
            }
            if let Some(error) = error.filter(|error| error.broken) {
                return Verdict::Failed(error.message.clone());
            }
            if callbacks != self.callbacks {
                self.callbacks = callbacks;
                self.progressed = now;
            }
            if now.duration_since(self.progressed) >= STALL_TIMEOUT
                || now.duration_since(self.started) >= OUTPUT_TIMEOUT
            {
                return Verdict::Failed(
                    error.map_or_else(|| UNFINISHED.to_owned(), |error| error.message.clone()),
                );
            }
            Verdict::Wait
        }
    }

    fn sample(index: usize) -> f32 {
        let offset = index * 2;
        let Some(bytes) = PCM.get(offset..offset + 2) else {
            return 0.0;
        };
        f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0
    }

    fn build<T: SizedSample + FromSample<f32>>(
        device: &Device,
        config: StreamConfig,
        progress: Arc<Progress>,
        app: AppHandle,
        ticket: u64,
    ) -> Result<Stream, cpal::Error> {
        let errors = Arc::clone(&progress);
        let channels = usize::from(config.channels);
        let rate = f64::from(config.sample_rate);
        let source_step = SOURCE_RATE / rate;
        let mut position = 0.0_f64;
        let mut finished = false;
        device.build_output_stream(
            config,
            move |buffer: &mut [T], info| {
                progress.callbacks.fetch_add(1, Ordering::Release);
                if finished || !record::playback_current(&app, ticket) {
                    buffer.fill(T::EQUILIBRIUM);
                    return;
                }
                let frame_count = buffer.len() / channels;
                for frame in buffer.chunks_mut(channels) {
                    let index = position as usize;
                    let fraction = (position - index as f64) as f32;
                    let left = sample(index);
                    let value = left + (sample(index + 1) - left) * fraction;
                    frame.fill(T::from_sample(value));
                    position += source_step;
                }
                if position >= (PCM.len() / 2) as f64 {
                    finished = true;
                    let time = info.timestamp();
                    let drain = time.playback.duration_since(time.callback)
                        + Duration::from_secs_f64(frame_count as f64 / rate);
                    progress.finish(drain.min(OUTPUT_TIMEOUT));
                }
            },
            move |err| errors.failed(&err),
            None,
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn glitch() -> StreamError {
            StreamError {
                broken: false,
                message: "underrun".into(),
            }
        }

        #[test]
        fn a_failed_attempt_is_retried_once_on_a_fresh_stream() {
            let mut calls = 0;
            let result = retry(|| {
                calls += 1;
                if calls == 1 {
                    Err(Failure::Retry("I/O error".into()))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result, Ok(()));
            assert_eq!(calls, 2);
        }

        #[test]
        fn a_second_failure_reports_the_last_error() {
            let mut calls = 0;
            let result = retry(|| {
                calls += 1;
                Err(Failure::Retry(format!("failure {calls}")))
            });
            assert_eq!(result, Err("failure 2".into()));
            assert_eq!(calls, ATTEMPTS);
        }

        #[test]
        fn recording_and_missing_outputs_are_not_retried() {
            let mut calls = 0;
            let cancelled = retry(|| {
                calls += 1;
                Err(Failure::Cancelled)
            });
            assert_eq!(cancelled, Err(RECORDING_ERROR.into()));
            let fatal = retry(|| {
                calls += 1;
                Err(Failure::Fatal("No output.".into()))
            });
            assert_eq!(fatal, Err("No output.".into()));
            assert_eq!(calls, 2);
        }

        #[test]
        fn xruns_are_glitches_and_other_stream_errors_break_the_stream() {
            assert_eq!(breaks_stream(ErrorKind::Xrun), Some(false));
            assert_eq!(breaks_stream(ErrorKind::DeviceChanged), None);
            assert_eq!(breaks_stream(ErrorKind::RealtimeDenied), None);
            assert_eq!(breaks_stream(ErrorKind::DeviceNotAvailable), Some(true));
            assert_eq!(breaks_stream(ErrorKind::StreamInvalidated), Some(true));
        }

        #[test]
        fn a_glitch_never_replaces_a_breaking_error() {
            let progress = Progress::default();
            progress.failed(&cpal::Error::with_message(ErrorKind::Xrun, "underrun"));
            assert!(
                progress
                    .error
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|e| !e.broken)
            );
            progress.failed(&cpal::Error::with_message(
                ErrorKind::StreamInvalidated,
                "gone",
            ));
            progress.failed(&cpal::Error::with_message(ErrorKind::Xrun, "underrun"));
            progress.failed(&cpal::Error::with_message(
                ErrorKind::DeviceChanged,
                "moved",
            ));
            let error = progress.error.lock().unwrap().clone().unwrap();
            assert!(error.broken);
            assert!(error.message.contains("gone"));
        }

        #[test]
        fn the_drain_is_reported_once_the_clip_is_handed_over() {
            let progress = Progress::default();
            assert_eq!(progress.drain(), None);
            progress.finish(Duration::ZERO);
            assert_eq!(progress.drain(), Some(Duration::ZERO));
            progress.finish(Duration::from_millis(120));
            assert_eq!(progress.drain(), Some(Duration::from_millis(120)));
        }

        #[test]
        fn a_finished_clip_is_not_failed_by_a_late_error() {
            let start = Instant::now();
            let mut watch = Watch::new(start);
            let broken = StreamError {
                broken: true,
                message: "I/O error".into(),
            };
            let drain = Duration::from_millis(40);
            assert_eq!(
                watch.check(start, 3, Some(drain), Some(&broken)),
                Verdict::Finished(drain)
            );
        }

        #[test]
        fn a_breaking_error_fails_the_attempt_at_once() {
            let start = Instant::now();
            let mut watch = Watch::new(start);
            let broken = StreamError {
                broken: true,
                message: "I/O error".into(),
            };
            assert_eq!(
                watch.check(start, 1, None, Some(&broken)),
                Verdict::Failed("I/O error".into())
            );
        }

        #[test]
        fn a_glitch_waits_while_the_output_keeps_asking_for_samples() {
            let start = Instant::now();
            let mut watch = Watch::new(start);
            let error = glitch();
            for step in 1..=10 {
                let now = start + STALL_TIMEOUT / 2 * step;
                if now.duration_since(start) >= OUTPUT_TIMEOUT {
                    break;
                }
                assert_eq!(
                    watch.check(now, u64::from(step), None, Some(&error)),
                    Verdict::Wait
                );
            }
        }

        #[test]
        fn a_stalled_output_fails_with_its_last_error() {
            let start = Instant::now();
            let mut watch = Watch::new(start);
            let error = glitch();
            assert_eq!(watch.check(start, 2, None, None), Verdict::Wait);
            let almost = start + STALL_TIMEOUT - Duration::from_millis(1);
            assert_eq!(watch.check(almost, 2, None, Some(&error)), Verdict::Wait);
            assert_eq!(
                watch.check(start + STALL_TIMEOUT, 2, None, Some(&error)),
                Verdict::Failed("underrun".into())
            );
            let mut silent = Watch::new(start);
            assert_eq!(
                silent.check(start + STALL_TIMEOUT, 0, None, None),
                Verdict::Failed(UNFINISHED.into())
            );
        }

        #[test]
        fn an_output_that_never_finishes_fails_at_the_timeout() {
            let start = Instant::now();
            let mut watch = Watch::new(start);
            let late = start + OUTPUT_TIMEOUT;
            assert_eq!(
                watch.check(late, 99, None, None),
                Verdict::Failed(UNFINISHED.into())
            );
        }

        #[test]
        fn linux_asks_for_a_larger_buffer_within_the_supported_range() {
            let wide = SupportedBufferSize::Range {
                min: 64,
                max: 65_536,
            };
            assert_eq!(linux_buffer_size(&wide, 48_000), BufferSize::Fixed(3_600));
            assert_eq!(linux_buffer_size(&wide, 44_100), BufferSize::Fixed(3_307));
            let narrow = SupportedBufferSize::Range {
                min: 64,
                max: 1_024,
            };
            assert_eq!(linux_buffer_size(&narrow, 48_000), BufferSize::Fixed(1_024));
            let invalid = SupportedBufferSize::Range { min: 2, max: 1 };
            assert_eq!(linux_buffer_size(&invalid, 48_000), BufferSize::Default);
            assert_eq!(
                linux_buffer_size(&SupportedBufferSize::Unknown, 48_000),
                BufferSize::Fixed(3_600)
            );
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod output {
    pub(super) fn play(_: &super::AppHandle, _: u64) -> Result<(), String> {
        Err("The copy sound is unavailable on this system.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn bundled_sound_matches_the_approved_wav() {
        assert_eq!(
            format!("{:x}", Sha256::digest(WAV)),
            "064e15b3b34b9633820370507a5dac6219929f7e5983ebad2b9124c845737fc8"
        );
    }
}
