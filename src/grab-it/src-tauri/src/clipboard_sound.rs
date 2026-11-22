//! Plays the bundled confirmation sound through the desktop's default output.

use tauri::Manager;

use crate::{commands, record, rt::AppHandle};

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

    fn notify(self, enabled: bool, ticket: Option<u64>) -> Option<u64> {
        if self == Self::Confirm && enabled {
            ticket
        } else {
            None
        }
    }
}

/// Called once at the logical clipboard write boundary, after every format
/// has been offered. Audio is independent of the clipboard write's result.
pub(crate) fn copied<E>(app: &AppHandle, sound: CopySound, result: Result<(), E>) -> Result<(), E> {
    after_write(result, || {
        if sound == CopySound::Silent {
            return;
        }
        let ticket = record::playback_ticket(app);
        let enabled = app
            .try_state::<commands::SettingsState>()
            .is_some_and(|state| commands::lock(&state).get().copy_sound);
        let Some(ticket) = sound.notify(enabled, ticket) else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = play(app, ticket).await {
                eprintln!("Grab-it: {err}");
            }
        });
    })
}

fn after_write<E>(result: Result<(), E>, confirm: impl FnOnce()) -> Result<(), E> {
    result.inspect(|()| confirm())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
const WAV: &[u8] = include_bytes!("../sounds/2-holga-two-part.wav");

/// Previews the sound independently of the preference, whenever recording is idle.
#[tauri::command]
#[specta::specta]
pub async fn preview_copy_sound(app: AppHandle) -> Result<(), String> {
    let ticket = record::playback_ticket(&app)
        .ok_or_else(|| "The copy sound is unavailable while recording.".to_owned())?;
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
    use std::{sync::mpsc, thread, time::Duration};

    use cpal::{
        Device, FromSample, SampleFormat, SizedSample, StreamConfig,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::{AppHandle, WAV};

    // The checksum test pins this WAV's layout: 44-byte RIFF header and
    // 48 kHz mono signed 16-bit little-endian samples.
    const PCM: &[u8] = WAV.split_at(44).1;
    const SOURCE_RATE: f64 = 48_000.0;
    const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);

    pub(super) fn play(app: &AppHandle, ticket: u64) -> Result<(), String> {
        if !crate::record::playback_current(app, ticket) {
            return Err("The copy sound is unavailable while recording.".into());
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
                    if !crate::record::playback_current(&callback_app, ticket) {
                        buffer.fill(T::EQUILIBRIUM);
                        let _ = send
                            .try_send(Err("The copy sound is unavailable while recording.".into()));
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
        let drain = receive
            .recv_timeout(OUTPUT_TIMEOUT)
            .map_err(|_| "The audio output did not finish playing the copy sound.".to_owned())??;
        // Keep the stream alive until the last submitted buffer is audible.
        thread::sleep(drain);
        Ok(())
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
    fn only_a_successful_logical_copy_notifies_once() {
        let mut notifications = 0;
        let error = "clipboard unavailable";
        assert_eq!(after_write(Err(error), || notifications += 1), Err(error));
        assert_eq!(notifications, 0);

        // A multi-format writer combines its offers before reporting success.
        let outcomes = [Ok::<(), &str>(()), Ok(())];
        let result = outcomes.into_iter().collect::<Result<(), _>>();
        assert_eq!(after_write(result, || notifications += 1), Ok(()));
        assert_eq!(notifications, 1);
    }

    #[test]
    fn confirmation_requires_an_enabled_preference_and_an_idle_recording_state() {
        let enabled = CopySound::Confirm;
        assert_eq!(enabled.notify(true, Some(0)), Some(0));
        assert_eq!(enabled.notify(false, Some(0)), None);
        assert_eq!(enabled.notify(true, None), None);
    }

    #[test]
    fn only_the_first_ai_copy_can_play_the_confirmation() {
        assert_eq!(CopySound::tidied("  ").notify(true, Some(0)), Some(0));
        assert_eq!(CopySound::tidied("OCR text").notify(true, Some(0)), None);
    }

    #[test]
    fn bundled_sound_matches_the_approved_wav() {
        assert_eq!(
            format!("{:x}", Sha256::digest(WAV)),
            "064e15b3b34b9633820370507a5dac6219929f7e5983ebad2b9124c845737fc8"
        );
    }
}
