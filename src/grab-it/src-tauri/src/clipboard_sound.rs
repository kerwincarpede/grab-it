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
    let played = tauri::async_runtime::spawn_blocking(move || output::play(&app, ticket))
        .await
        .map_err(|err| format!("Could not play the copy sound: {err}"))?;
    settle(played)
}

/// Why the sound did not play in full.
#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// A recording started.
    Cancelled,
    /// There is no output to play it on.
    Unavailable(String),
    /// The output opened but stopped or stalled part-way.
    Interrupted(String),
}

/// An output that opened but hiccuped is only logged: the copy, or the
/// Preview button, did its job, and the next sound opens a fresh output.
fn settle(played: Result<(), Failure>) -> Result<(), String> {
    match played {
        Ok(()) => Ok(()),
        Err(Failure::Cancelled) => Err(RECORDING_ERROR.into()),
        Err(Failure::Unavailable(message)) => Err(message),
        Err(Failure::Interrupted(message)) => {
            eprintln!("Grab-it: {message}");
            Ok(())
        }
    }
}

// The checksum test pins this WAV's layout: 44-byte RIFF header and
// 48 kHz mono signed 16-bit little-endian samples.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
const PCM: &[u8] = WAV.split_at(44).1;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
const SOURCE_RATE: u32 = 48_000;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const UNFINISHED: &str = "The audio output did not finish playing the copy sound.";

/// The clip's sample at `position` (in source frames), linearly interpolated.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
fn sample_at(position: f64) -> f32 {
    let sample = |index: usize| {
        let offset = index * 2;
        PCM.get(offset..offset + 2).map_or(0.0, |bytes| {
            f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0
        })
    };
    let index = position as usize;
    let fraction = (position - index as f64) as f32;
    let left = sample(index);
    left + (sample(index + 1) - left) * fraction
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn source_frames() -> usize {
    PCM.len() / 2
}

/// Windows and macOS: Core Audio and WASAPI pull the clip through cpal's
/// callback, which their own real-time threads drive.
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod output {
    use std::{sync::mpsc, time::Duration, time::Instant};

    use cpal::{
        Device, ErrorKind, FromSample, SampleFormat, SizedSample, StreamConfig,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{AppHandle, Failure, SOURCE_RATE, UNFINISHED, sample_at, source_frames};
    use crate::record;

    const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);
    const CHECK_RECORDING_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) fn play(app: &AppHandle, ticket: u64) -> Result<(), Failure> {
        if !record::playback_current(app, ticket) {
            return Err(Failure::Cancelled);
        }
        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| Failure::Unavailable("No default audio output is available.".into()))?;
        let config = device
            .default_output_config()
            .map_err(|err| Failure::Unavailable(output_error(&err)))?;
        let format = config.sample_format();
        let config = config.into();
        match format {
            SampleFormat::I8 => play_samples::<i8>(&device, config, app, ticket),
            SampleFormat::I16 => play_samples::<i16>(&device, config, app, ticket),
            SampleFormat::I24 => play_samples::<cpal::I24>(&device, config, app, ticket),
            SampleFormat::I32 => play_samples::<i32>(&device, config, app, ticket),
            SampleFormat::I64 => play_samples::<i64>(&device, config, app, ticket),
            SampleFormat::U8 => play_samples::<u8>(&device, config, app, ticket),
            SampleFormat::U16 => play_samples::<u16>(&device, config, app, ticket),
            SampleFormat::U24 => play_samples::<cpal::U24>(&device, config, app, ticket),
            SampleFormat::U32 => play_samples::<u32>(&device, config, app, ticket),
            SampleFormat::U64 => play_samples::<u64>(&device, config, app, ticket),
            SampleFormat::F32 => play_samples::<f32>(&device, config, app, ticket),
            SampleFormat::F64 => play_samples::<f64>(&device, config, app, ticket),
            _ => Err(Failure::Unavailable(format!(
                "The audio output uses an unsupported format ({format})."
            ))),
        }
    }

    fn output_error(err: &cpal::Error) -> String {
        format!("Could not play the copy sound: {err}")
    }

    /// Whether a stream error ends playback. A glitch or a notice does not:
    /// the stream carries on by itself.
    pub(super) fn ends_playback(kind: ErrorKind) -> bool {
        !matches!(
            kind,
            ErrorKind::Xrun | ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied
        )
    }

    fn play_samples<T: SizedSample + FromSample<f32>>(
        device: &Device,
        config: StreamConfig,
        app: &AppHandle,
        ticket: u64,
    ) -> Result<(), Failure> {
        let (send, receive) = mpsc::sync_channel(1);
        let errors = send.clone();
        let callback_app = app.clone();
        let channels = usize::from(config.channels);
        let rate = f64::from(config.sample_rate);
        let source_step = f64::from(SOURCE_RATE) / rate;
        let end = source_frames() as f64;
        let mut position = 0.0_f64;
        let mut finished = false;
        let stream = device
            .build_output_stream(
                config,
                move |buffer: &mut [T], info| {
                    if finished || !record::playback_current(&callback_app, ticket) {
                        buffer.fill(T::EQUILIBRIUM);
                        return;
                    }
                    let frame_count = buffer.len() / channels;
                    for frame in buffer.chunks_mut(channels) {
                        frame.fill(T::from_sample(sample_at(position)));
                        position += source_step;
                    }
                    if position >= end {
                        finished = true;
                        let time = info.timestamp();
                        let drain = time.playback.duration_since(time.callback)
                            + Duration::from_secs_f64(frame_count as f64 / rate);
                        let _ = send.try_send(Ok(drain.min(OUTPUT_TIMEOUT)));
                    }
                },
                move |err| {
                    if ends_playback(err.kind()) {
                        let _ = errors.try_send(Err(output_error(&err)));
                    }
                },
                None,
            )
            .map_err(|err| Failure::Unavailable(output_error(&err)))?;
        stream
            .play()
            .map_err(|err| Failure::Unavailable(output_error(&err)))?;
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        let drain = loop {
            if !record::playback_current(app, ticket) {
                return Err(Failure::Cancelled);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receive.recv_timeout(remaining.min(CHECK_RECORDING_INTERVAL)) {
                Ok(result) => break result.map_err(Failure::Interrupted)?,
                Err(mpsc::RecvTimeoutError::Timeout) if !remaining.is_zero() => continue,
                Err(_) => return Err(Failure::Interrupted(UNFINISHED.into())),
            }
        };
        // Dropping the stream cancels queued output when recording starts,
        // even if there are no more callbacks to see the invalidated ticket.
        if record::wait_for_playback(app, ticket, drain) {
            Ok(())
        } else {
            Err(Failure::Cancelled)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn glitches_and_notices_do_not_end_playback() {
            assert!(!ends_playback(ErrorKind::Xrun));
            assert!(!ends_playback(ErrorKind::DeviceChanged));
            assert!(!ends_playback(ErrorKind::RealtimeDenied));
            assert!(ends_playback(ErrorKind::DeviceNotAvailable));
            assert!(ends_playback(ErrorKind::StreamInvalidated));
        }
    }
}

/// Linux: the whole clip is written up front to ALSA's `default` PCM, which
/// is PulseAudio's or PipeWire's plugin on a desktop, the way aplay and
/// ffmpeg play, and the thread then waits for the output to drain.
///
/// cpal's ALSA stream double-buffers two small periods and refills one each
/// time a poll wakes its worker. While a capture overlay closes, a late
/// refill underruns, cpal's recovery prepares the PCM again, the Pulse
/// plugin rebuilds its stream, and polling it returns `EIO` or stalls, so
/// the clip was cut short or silent. Here the clip is already queued in a
/// buffer longer than itself, so nothing depends on this thread waking on
/// time. cpal's PulseAudio host also opened a native connection for every
/// sound that PulseAudio refused; ALSA's plugin is the only client now.
#[cfg(target_os = "linux")]
mod output {
    use std::{
        io,
        time::{Duration, Instant},
    };

    use alsa::{
        Direction, ValueOr,
        pcm::{Access, Format, HwParams, PCM, State},
    };

    use super::{AppHandle, Failure, SOURCE_RATE, UNFINISHED, sample_at};
    use crate::record;

    /// Asked for so the 260 ms clip fits with room to spare.
    const BUFFER_TIME_US: u32 = 500_000;
    const PERIOD_TIME_US: u32 = 50_000;
    /// The most one sound may take, from opening the output to its end.
    const DEADLINE: Duration = Duration::from_secs(3);
    const CHECK_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) fn play(app: &AppHandle, ticket: u64) -> Result<(), Failure> {
        if !record::playback_current(app, ticket) {
            return Err(Failure::Cancelled);
        }
        let deadline = Instant::now() + DEADLINE;
        let pcm = open().map_err(|err| Failure::Unavailable(output_error(&err)))?;
        let (rate, channels) = pcm
            .hw_params_current()
            .and_then(|params| Ok((params.get_rate()?, params.get_channels()?)))
            .map_err(|err| Failure::Unavailable(output_error(&err)))?;
        let samples = frames(rate, channels);
        let channels = channels.max(1) as usize;
        write(&pcm, &samples, channels, app, ticket, deadline)?;
        let clip = Duration::from_secs_f64((samples.len() / channels) as f64 / f64::from(rate));
        let buffer = pcm
            .get_params()
            .map_or(Duration::from_micros(BUFFER_TIME_US.into()), |(size, _)| {
                Duration::from_secs_f64(size as f64 / f64::from(rate))
            });
        let started = Instant::now();
        loop {
            let running = matches!(pcm.state(), State::Running | State::Draining);
            let delay = if running { pcm.delay().ok() } else { Some(0) };
            if drained(started.elapsed(), clip, delay, buffer) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let _ = pcm.drop();
                return Err(Failure::Interrupted(UNFINISHED.into()));
            }
            // A recording start wakes this at once and drops the queued sound.
            if !record::wait_for_playback(app, ticket, CHECK_INTERVAL) {
                let _ = pcm.drop();
                return Err(Failure::Cancelled);
            }
        }
    }

    fn output_error(err: &alsa::Error) -> String {
        format!("Could not play the copy sound: {err}")
    }

    /// Opens the default output for the clip's format, letting ALSA convert
    /// the rate and channels where the device needs other ones.
    fn open() -> alsa::Result<PCM> {
        let pcm = PCM::new("default", Direction::Playback, true)?;
        {
            let params = HwParams::any(&pcm)?;
            params.set_access(Access::RWInterleaved)?;
            params.set_format(Format::s16())?;
            let _ = params.set_rate_resample(true);
            params.set_channels_near(1)?;
            params.set_rate_near(SOURCE_RATE, ValueOr::Nearest)?;
            let _ = params.set_buffer_time_near(BUFFER_TIME_US, ValueOr::Nearest);
            let _ = params.set_period_time_near(PERIOD_TIME_US, ValueOr::Nearest);
            pcm.hw_params(&params)?;
            let (_, period) = pcm.get_params()?;
            let software = pcm.sw_params_current()?;
            // Start as soon as a period is queued, not when the buffer
            // (longer than the clip) is full.
            software.set_start_threshold(i64::try_from(period).unwrap_or(1).max(1))?;
            pcm.sw_params(&software)?;
        }
        Ok(pcm)
    }

    /// Writes every frame without blocking, waiting for room where the
    /// buffer is full and recovering from underruns.
    fn write(
        pcm: &PCM,
        samples: &[i16],
        channels: usize,
        app: &AppHandle,
        ticket: u64,
        deadline: Instant,
    ) -> Result<(), Failure> {
        let io = pcm
            .io_i16()
            .map_err(|err| Failure::Unavailable(output_error(&err)))?;
        let mut written = 0;
        while written < samples.len() {
            if !record::playback_current(app, ticket) {
                let _ = pcm.drop();
                return Err(Failure::Cancelled);
            }
            if Instant::now() >= deadline {
                let _ = pcm.drop();
                return Err(Failure::Interrupted(UNFINISHED.into()));
            }
            match io.writei(&samples[written..]) {
                Ok(frames) => written += frames * channels,
                Err(err) if would_block(&err) => {
                    let _ = pcm.wait(Some(CHECK_INTERVAL.as_millis() as u32));
                }
                Err(err) => {
                    if pcm.try_recover(err, true).is_err() {
                        return Err(Failure::Interrupted(output_error(&err)));
                    }
                }
            }
        }
        if pcm.state() == State::Prepared {
            pcm.start()
                .map_err(|err| Failure::Interrupted(output_error(&err)))?;
        }
        Ok(())
    }

    fn would_block(err: &alsa::Error) -> bool {
        io::Error::from_raw_os_error(err.errno()).kind() == io::ErrorKind::WouldBlock
    }

    /// The clip at `rate`, interleaved over `channels`.
    pub(super) fn frames(rate: u32, channels: u32) -> Vec<i16> {
        let channels = channels.max(1) as usize;
        let rate = rate.max(1);
        let source = super::PCM.len() / 2;
        let count = (source as u64 * u64::from(rate)).div_ceil(u64::from(SOURCE_RATE)) as usize;
        let step = f64::from(SOURCE_RATE) / f64::from(rate);
        let mut samples = Vec::with_capacity(count * channels);
        for frame in 0..count {
            let value = (sample_at(frame as f64 * step) * 32_768.0)
                .round()
                .clamp(-32_768.0, 32_767.0) as i16;
            samples.extend(std::iter::repeat_n(value, channels));
        }
        samples
    }

    /// Whether the output has played everything written, `elapsed` after
    /// the last write. `delay` is the output's queued frames, or `None`
    /// when it cannot say; a delay of zero counts only once the clip could
    /// have played, since an output may report none before it starts.
    pub(super) fn drained(
        elapsed: Duration,
        clip: Duration,
        delay: Option<i64>,
        buffer: Duration,
    ) -> bool {
        match delay {
            Some(delay) => delay <= 0 && elapsed >= clip,
            None => elapsed >= clip + buffer,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_clip_is_written_unchanged_at_its_own_rate() {
            let samples = frames(SOURCE_RATE, 1);
            let source: Vec<i16> = super::super::PCM
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bytes| i16::from_le_bytes(*bytes))
                .collect();
            assert_eq!(samples, source);
        }

        #[test]
        fn the_clip_is_resampled_and_copied_to_every_channel() {
            let mono = frames(SOURCE_RATE, 1);
            let stereo = frames(96_000, 2);
            assert_eq!(stereo.len(), mono.len() * 4);
            assert!(
                stereo
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .all(|[left, right]| left == right)
            );
            assert_eq!(stereo[4], mono[1]);
            assert_eq!(
                frames(44_100, 1).len(),
                (mono.len() * 44_100).div_ceil(48_000)
            );
        }

        #[test]
        fn playback_ends_once_the_queue_is_empty_and_the_clip_could_have_played() {
            let clip = Duration::from_millis(260);
            let buffer = Duration::from_millis(500);
            assert!(!drained(Duration::from_millis(100), clip, Some(0), buffer));
            assert!(!drained(clip, clip, Some(480), buffer));
            assert!(drained(clip, clip, Some(0), buffer));
            assert!(drained(clip * 2, clip, Some(-12), buffer));
        }

        #[test]
        fn an_output_that_cannot_report_its_delay_is_given_its_buffer() {
            let clip = Duration::from_millis(260);
            let buffer = Duration::from_millis(500);
            assert!(!drained(clip, clip, None, buffer));
            assert!(drained(clip + buffer, clip, None, buffer));
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod output {
    pub(super) fn play(_: &super::AppHandle, _: u64) -> Result<(), super::Failure> {
        Err(super::Failure::Unavailable(
            "The copy sound is unavailable on this system.".into(),
        ))
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

    #[test]
    fn an_output_hiccup_is_not_reported_as_an_error() {
        assert_eq!(settle(Ok(())), Ok(()));
        assert_eq!(settle(Err(Failure::Interrupted("stalled".into()))), Ok(()));
        assert_eq!(settle(Err(Failure::Cancelled)), Err(RECORDING_ERROR.into()));
        assert_eq!(
            settle(Err(Failure::Unavailable("No output.".into()))),
            Err("No output.".into())
        );
    }

    #[test]
    fn interpolation_lands_on_and_between_source_samples() {
        let at = |index: usize| {
            f32::from(i16::from_le_bytes([PCM[index * 2], PCM[index * 2 + 1]])) / 32_768.0
        };
        assert_eq!(sample_at(100.0), at(100));
        let middle = sample_at(100.5);
        assert!((middle - (at(100) + at(101)) / 2.0).abs() < 1e-6);
        assert_eq!(sample_at((source_frames() + 1) as f64), 0.0);
    }
}
