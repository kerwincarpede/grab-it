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
        sync::mpsc,
        time::{Duration, Instant},
    };

    use cpal::{
        Device, FromSample, SampleFormat, SizedSample, StreamConfig,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{AppHandle, RECORDING_ERROR, WAV};
    use crate::record;

    // The checksum test pins this WAV's layout: 44-byte RIFF header and
    // 48 kHz mono signed 16-bit little-endian samples.
    const PCM: &[u8] = WAV.split_at(44).1;
    const SOURCE_RATE: f64 = 48_000.0;
    const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);
    const CHECK_RECORDING_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) fn play(app: &AppHandle, ticket: u64) -> Result<(), String> {
        if !record::playback_current(app, ticket) {
            return Err(RECORDING_ERROR.into());
        }
        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| "No default audio output is available.".to_owned())?;
        let config = device.default_output_config().map_err(output_error)?;
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
            _ => Err(format!(
                "The audio output uses an unsupported format ({format})."
            )),
        }
    }

    fn output_error(err: cpal::Error) -> String {
        format!("Could not play the copy sound: {err}")
    }

    fn sample(index: usize) -> f32 {
        let offset = index * 2;
        let Some(bytes) = PCM.get(offset..offset + 2) else {
            return 0.0;
        };
        f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0
    }

    fn play_samples<T: SizedSample + FromSample<f32>>(
        device: &Device,
        config: StreamConfig,
        app: &AppHandle,
        ticket: u64,
    ) -> Result<(), String> {
        let (send, receive) = mpsc::sync_channel(1);
        let errors = send.clone();
        let callback_app = app.clone();
        let channels = usize::from(config.channels);
        let rate = f64::from(config.sample_rate);
        let source_step = SOURCE_RATE / rate;
        let mut position = 0.0_f64;
        let mut finished = false;
        let stream = device
            .build_output_stream(
                config,
                move |buffer: &mut [T], info| {
                    if !record::playback_current(&callback_app, ticket) {
                        buffer.fill(T::EQUILIBRIUM);
                        let _ = send.try_send(Err(RECORDING_ERROR.into()));
                        return;
                    }
                    if finished {
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
                        let _ = send.try_send(Ok(drain.min(OUTPUT_TIMEOUT)));
                    }
                },
                move |err| {
                    let _ = errors.try_send(Err(output_error(err)));
                },
                None,
            )
            .map_err(output_error)?;
        stream.play().map_err(output_error)?;
        let deadline = Instant::now() + OUTPUT_TIMEOUT;
        let drain = loop {
            if !record::playback_current(app, ticket) {
                return Err(RECORDING_ERROR.into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receive.recv_timeout(remaining.min(CHECK_RECORDING_INTERVAL)) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Timeout) if !remaining.is_zero() => continue,
                Err(_) => {
                    return Err("The audio output did not finish playing the copy sound.".into());
                }
            }
        };
        // Dropping the stream cancels queued output when recording starts,
        // even if there are no more callbacks to see the invalidated ticket.
        if record::wait_for_playback(app, ticket, drain) {
            Ok(())
        } else {
            Err(RECORDING_ERROR.into())
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
