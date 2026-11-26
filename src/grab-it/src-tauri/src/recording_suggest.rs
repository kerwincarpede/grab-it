//! Suggest edits in the recording editor: the pauses in a recording's
//! sound, which the page weighs against the pointer to propose cuts, and
//! short auditions of a stretch's sound as recorded and as the export
//! cleans it.
//!
//! Everything runs on the computer, through the bundled ffmpeg and noise
//! model; nothing is sent anywhere.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::ffmpeg;
use crate::recording_editor::{
    AudioKind, ClipSound, KeptSound, NO_NOISE_MODEL, RecordingEditorState, SoundFrom,
    audio_sources, clip_sound_file, kept_sound, push_clip_sound,
};
use crate::rt::{AppHandle, WebviewWindow};
use crate::zoom::CursorPath;

/// The quietest and loudest thresholds the page may ask for, in dBFS.
pub const PAUSE_NOISE_DB_RANGE: std::ops::RangeInclusive<i32> = -60..=-20;
/// The shortest stretch of quiet reported as a pause: the page's lowest
/// Minimum cut, so it filters the rest itself without listening again.
pub const MIN_PAUSE_MS: u64 = 500;
/// The longest stretch an audition plays.
pub const MAX_AUDITION_MS: u64 = 30_000;
/// How long finding the pauses of one recording may take.
const PAUSES_TIMEOUT: Duration = Duration::from_secs(120);
/// How long rendering one audition may take.
const AUDITION_TIMEOUT: Duration = Duration::from_secs(60);

/// A stretch of a recording, in its own time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PauseSpan {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// What a recording's pauses were heard in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PauseSound {
    /// The microphone alone, kept apart in the sound sidecar.
    Microphone,
    /// The MP4's one track, the microphone not kept apart: mixed with
    /// system sound, or a microphone whose sound sidecar was never
    /// written. It can only be played as recorded.
    Mixed,
    /// System sound only: no voice to pause.
    System,
    /// No sound at all; pauses come from the pointer alone.
    Silent,
}

/// The quiet stretches of one recording; the page reads it from the
/// generated bindings.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPauses {
    pub sound: PauseSound,
    /// Sorted, never overlapping; empty for a silent recording.
    pub pauses: Vec<PauseSpan>,
    /// Whether an audition can play the stretch cleaned as the export
    /// would: only with the microphone kept apart.
    pub can_clean: bool,
    /// The pointer as recorded, not smoothed, so a rest is found where the
    /// pointer really stopped; None without a pointer track.
    pub pointer: Option<CursorPath>,
}

/// The sound pauses are heard in, and where it is read from: the
/// microphone kept apart in `video`'s sound sidecar when there is one,
/// else the MP4's one track. A microphone in the MP4 itself (its sidecar
/// never written) is not kept apart, so it counts as mixed.
pub(crate) fn pause_source(
    video: &Path,
    kinds: &[(AudioKind, PathBuf, usize)],
) -> (PauseSound, Option<(PathBuf, usize)>) {
    if let Some((_, file, stream)) = kinds
        .iter()
        .find(|(kind, file, _)| *kind == AudioKind::Microphone && file != video)
    {
        return (PauseSound::Microphone, Some((file.clone(), *stream)));
    }
    match kinds.first() {
        Some((AudioKind::Mixed | AudioKind::Microphone, file, stream)) => {
            (PauseSound::Mixed, Some((file.clone(), *stream)))
        }
        Some((AudioKind::System, _, _)) => (PauseSound::System, None),
        _ => (PauseSound::Silent, None),
    }
}

/// ffmpeg's arguments to print the stretches of audio stream `stream` of
/// `file` quieter than `noise_db` dBFS, at least `MIN_PAUSE_MS` long.
pub fn silence_args(file: &Path, stream: usize, noise_db: i32) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostats", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(file.as_os_str().to_owned());
    args.push("-map".into());
    args.push(format!("0:a:{stream}").into());
    args.push("-af".into());
    args.push(
        format!(
            "silencedetect=noise={noise_db}dB:d={:.3}",
            MIN_PAUSE_MS as f64 / 1000.0
        )
        .into(),
    );
    for arg in ["-f", "null", "-"] {
        args.push(arg.into());
    }
    args
}

/// The pauses in what `silencedetect` printed. A pause still open when
/// the sound ends runs to `duration_ms` when it is known, else is
/// dropped. Malformed lines are skipped.
pub fn parse_silences(said: &str, duration_ms: Option<u64>) -> Vec<PauseSpan> {
    let value = |line: &str, key: &str| -> Option<f64> {
        let rest = &line[line.find(key)? + key.len()..];
        let number: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        number.parse::<f64>().ok().filter(|n| n.is_finite())
    };
    let ms = |seconds: f64| (seconds.max(0.0) * 1000.0).round() as u64;
    let mut spans = Vec::new();
    let mut open: Option<u64> = None;
    for line in said.lines() {
        if let Some(start) = value(line, "silence_start:") {
            open = Some(ms(start));
        } else if let Some(end) = value(line, "silence_end:")
            && let Some(start) = open.take()
            && ms(end) > start
        {
            spans.push(PauseSpan {
                start_ms: start,
                end_ms: ms(end),
            });
        }
    }
    if let (Some(start), Some(end)) = (open, duration_ms)
        && end > start
    {
        spans.push(PauseSpan {
            start_ms: start,
            end_ms: end,
        });
    }
    spans.sort_by_key(|span| span.start_ms);
    spans
}

/// Runs ffmpeg with `args` and returns what it printed to stderr.
fn stderr_of(ffmpeg_path: &Path, args: Vec<OsString>, timeout: Duration) -> Result<String, String> {
    let mut child = ffmpeg::command(ffmpeg_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start ffmpeg: {err}"))?;
    let reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });
    let status = ffmpeg::wait_for(&mut child, timeout);
    let said = reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(said),
        Some(_) => Err(ffmpeg::last_line(&said)
            .unwrap_or("ffmpeg could not read the sound")
            .to_owned()),
        None => Err("finding the pauses took too long".to_owned()),
    }
}

/// `noise_db` when it is a threshold the page may ask for, else why not.
pub fn pause_threshold(noise_db: i32) -> Result<i32, String> {
    if PAUSE_NOISE_DB_RANGE.contains(&noise_db) {
        Ok(noise_db)
    } else {
        Err(format!(
            "the pause threshold must be from {} to {} dB",
            PAUSE_NOISE_DB_RANGE.start(),
            PAUSE_NOISE_DB_RANGE.end()
        ))
    }
}

/// The pauses in recording `file_name`'s sound, for Suggest edits: the
/// stretches quieter than `noise_db` dBFS, from -60 to -20.
#[tauri::command]
#[specta::specta]
pub async fn recording_pauses(
    file_name: String,
    noise_db: i32,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<RecordingPauses, String> {
    let noise_db = pause_threshold(noise_db)?;
    let path = state.source_for(window.label(), &file_name)?;
    let Some(ready) = ffmpeg::ready(&app) else {
        ffmpeg::prepare_in_background(&app);
        return Err("ffmpeg is not ready yet; see Settings → Recording, then try again".to_owned());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let sources: Vec<_> = audio_sources(&path, Some(&ready.path))
            .into_iter()
            .map(|source| (source.kind, source.file, source.stream))
            .collect();
        let can_clean = kept_sound(&path).is_some();
        let (sound, from) = pause_source(&path, &sources);
        let pauses = match from {
            Some((file, stream)) => {
                let duration = ffmpeg::probe_file(&ready.path, &path).duration_ms;
                parse_silences(
                    &stderr_of(
                        &ready.path,
                        silence_args(&file, stream, noise_db),
                        PAUSES_TIMEOUT,
                    )?,
                    duration,
                )
            }
            None => Vec::new(),
        };
        Ok(RecordingPauses {
            sound,
            pauses,
            can_clean,
            pointer: CursorPath::load_recorded(&path),
        })
    })
    .await
    .map_err(|err| format!("could not listen for pauses: {err}"))?
}

/// ffmpeg's arguments to write `output`, a 16-bit WAV, from `clip`'s
/// sound, through the same filters the export uses.
pub fn audition_args(clip: &ClipSound<'_>, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let input = clip_sound_file(clip).map(|file| {
        args.push("-i".into());
        args.push(file.as_os_str().to_owned());
        0
    });
    let mut filters = Vec::new();
    push_clip_sound(&mut filters, clip, input, 0);
    args.push("-filter_complex".into());
    args.push(filters.join(";").into());
    for arg in ["-map", "[a0]", "-c:a", "pcm_s16le", "-f", "wav"] {
        args.push(arg.into());
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// Where an audition of `video` reads its sound: `cleaned` takes the kept
/// microphone through `noise_model`, as the export removes noise; the
/// original takes the kept sound unfiltered, or the MP4's own track when
/// the microphone is not kept apart.
pub fn audition_from<'a>(
    video: &'a Path,
    kept: Option<&'a KeptSound>,
    has_audio: bool,
    cleaned: bool,
    noise_model: Option<&'a Path>,
) -> Result<SoundFrom<'a>, String> {
    match (kept, cleaned) {
        (Some(kept), true) => match noise_model {
            Some(model) => Ok(SoundFrom::Kept {
                kept,
                noise_model: Some(model),
            }),
            None => Err(NO_NOISE_MODEL.to_owned()),
        },
        (None, true) => Err(
            "this recording keeps its microphone mixed with other sound, so it cannot be cleaned"
                .to_owned(),
        ),
        (Some(kept), false) => Ok(SoundFrom::Kept {
            kept,
            noise_model: None,
        }),
        (None, false) if has_audio => Ok(SoundFrom::Video(video)),
        (None, false) => Err("this recording has no sound".to_owned()),
    }
}

/// A fresh file in the temporary folder for one audition, removed once
/// it is read.
fn audition_path() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("grab-it-audition-{}-{n}.wav", std::process::id()))
}

/// The stretch `start_ms`..`end_ms` of recording `file_name`'s sound as a
/// WAV, as recorded or `cleaned` as the export cleans it. At most
/// `MAX_AUDITION_MS` long.
#[tauri::command]
pub async fn recording_audition(
    file_name: String,
    start_ms: u64,
    end_ms: u64,
    cleaned: bool,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<tauri::ipc::Response, String> {
    if end_ms <= start_ms {
        return Err("the stretch to play is empty".to_owned());
    }
    let end_ms = end_ms.min(start_ms + MAX_AUDITION_MS);
    let path = state.source_for(window.label(), &file_name)?;
    let Some(ready) = ffmpeg::ready(&app) else {
        ffmpeg::prepare_in_background(&app);
        return Err("ffmpeg is not ready yet; see Settings → Recording, then try again".to_owned());
    };
    let noise_model = if cleaned {
        crate::noise::bundled_model(&app)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let kept = kept_sound(&path);
        let has_audio = !audio_sources(&path, Some(&ready.path)).is_empty();
        let from = audition_from(
            &path,
            kept.as_ref(),
            has_audio,
            cleaned,
            noise_model.as_deref(),
        )?;
        let clip = ClipSound {
            start_ms,
            end_ms,
            from,
        };
        let output = audition_path();
        let rendered = ffmpeg::run(&ready.path, audition_args(&clip, &output), AUDITION_TIMEOUT)
            .map_err(|err| err.to_string())
            .and_then(|()| {
                fs::read(&output).map_err(|err| format!("could not read the audition: {err}"))
            });
        let _ = fs::remove_file(&output);
        Ok(tauri::ipc::Response::new(rendered?))
    })
    .await
    .map_err(|err| format!("the audition stopped: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn silences_are_read_from_silencedetect() {
        let said = "\
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75
size=N/A time=00:00:09.00
[silencedetect @ 0x1] silence_start: -0.01
[silencedetect @ 0x1] silence_end: 0.9 | silence_duration: 0.91
[silencedetect @ 0x1] silence_start: 8
";
        assert_eq!(
            parse_silences(said, Some(9_000)),
            [
                PauseSpan {
                    start_ms: 0,
                    end_ms: 900
                },
                PauseSpan {
                    start_ms: 1_500,
                    end_ms: 3_250
                },
                PauseSpan {
                    start_ms: 8_000,
                    end_ms: 9_000
                },
            ]
        );
    }

    #[test]
    fn an_open_pause_without_a_length_is_dropped() {
        assert_eq!(parse_silences("silence_start: 2\n", None), []);
    }

    #[test]
    fn malformed_and_backwards_lines_are_skipped() {
        let said = "silence_start: nope\nsilence_end: 2\nsilence_start: 5\nsilence_end: 4\n";
        assert_eq!(parse_silences(said, None), []);
    }

    #[test]
    fn silence_is_listened_for_on_one_stream() {
        let args = text(&silence_args(Path::new("/r/clip.sound.m4a"), 0, -40));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:a:0"]));
        assert!(
            args.iter()
                .any(|arg| arg == "silencedetect=noise=-40dB:d=0.500")
        );
        assert_eq!(&args[args.len() - 3..], ["-f", "null", "-"]);
    }

    #[test]
    fn silence_is_listened_for_at_the_asked_threshold() {
        let args = text(&silence_args(Path::new("/r/clip.mp4"), 1, -55));
        assert!(
            args.iter()
                .any(|arg| arg == "silencedetect=noise=-55dB:d=0.500")
        );
    }

    #[test]
    fn a_threshold_outside_its_range_is_refused() {
        assert_eq!(pause_threshold(-60), Ok(-60));
        assert_eq!(pause_threshold(-20), Ok(-20));
        assert_eq!(pause_threshold(-40), Ok(-40));
        for outside in [-61, -19, 0, i32::MIN] {
            assert_eq!(
                pause_threshold(outside),
                Err("the pause threshold must be from -60 to -20 dB".to_owned())
            );
        }
    }

    fn kinds(list: &[AudioKind]) -> Vec<(AudioKind, PathBuf, usize)> {
        list.iter()
            .enumerate()
            .map(|(stream, kind)| (*kind, PathBuf::from("/r/sound.m4a"), stream))
            .collect()
    }

    #[test]
    fn pauses_are_heard_in_the_isolated_microphone_first() {
        let video = Path::new("/r/clip.mp4");
        assert_eq!(
            pause_source(video, &kinds(&[AudioKind::Microphone, AudioKind::System])),
            (
                PauseSound::Microphone,
                Some((PathBuf::from("/r/sound.m4a"), 0))
            )
        );
        assert_eq!(
            pause_source(video, &kinds(&[AudioKind::Mixed])).0,
            PauseSound::Mixed
        );
        assert_eq!(
            pause_source(video, &kinds(&[AudioKind::System])),
            (PauseSound::System, None)
        );
        assert_eq!(pause_source(video, &[]), (PauseSound::Silent, None));
    }

    #[test]
    fn a_microphone_left_in_the_mp4_is_not_isolated() {
        // Its sound sidecar was never written, so the MP4's own track is
        // the microphone, which cannot be cleaned apart.
        let video = Path::new("/r/clip.mp4");
        let in_video = [(AudioKind::Microphone, video.to_path_buf(), 0)];
        assert_eq!(
            pause_source(video, &in_video),
            (PauseSound::Mixed, Some((video.to_path_buf(), 0)))
        );
    }

    #[test]
    fn auditions_follow_the_export_cleanup_path() {
        let video = Path::new("/r/clip.mp4");
        let kept = KeptSound {
            file: PathBuf::from("/r/clip.sound.m4a"),
            system: true,
        };
        let model = Path::new("/res/bd.rnnn");
        assert_eq!(
            audition_from(video, Some(&kept), true, true, Some(model)),
            Ok(SoundFrom::Kept {
                kept: &kept,
                noise_model: Some(model)
            })
        );
        assert_eq!(
            audition_from(video, Some(&kept), true, false, Some(model)),
            Ok(SoundFrom::Kept {
                kept: &kept,
                noise_model: None
            })
        );
        assert_eq!(
            audition_from(video, Some(&kept), true, true, None),
            Err(NO_NOISE_MODEL.to_owned())
        );
        assert_eq!(
            audition_from(video, None, true, false, None),
            Ok(SoundFrom::Video(video))
        );
        assert!(audition_from(video, None, true, true, Some(model)).is_err());
        assert!(audition_from(video, None, false, false, None).is_err());
    }

    #[test]
    fn a_cleaned_audition_denoises_the_microphone_and_mixes_system_sound() {
        let kept = KeptSound {
            file: PathBuf::from("/r/clip.sound.m4a"),
            system: true,
        };
        let clip = ClipSound {
            start_ms: 1_000,
            end_ms: 3_500,
            from: SoundFrom::Kept {
                kept: &kept,
                noise_model: Some(Path::new("/res/bd.rnnn")),
            },
        };
        let args = text(&audition_args(&clip, Path::new("/tmp/a.wav")));
        let graph = &args[args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .unwrap()
            + 1];
        assert!(
            graph.contains("[0:a:0]atrim=start=1.000:end=3.500"),
            "{graph}"
        );
        assert!(graph.contains("arnndn=m="), "{graph}");
        assert!(graph.contains("[0:a:1]atrim"), "{graph}");
        assert!(graph.contains("amix=inputs=2"), "{graph}");
        assert!(graph.ends_with("atrim=duration=2.500[a0]"), "{graph}");
        assert!(args.windows(2).any(|pair| pair == ["-map", "[a0]"]));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/a.wav"));
    }

    #[test]
    fn an_original_audition_of_a_mixed_recording_reads_its_own_track() {
        let video = Path::new("/r/clip.mp4");
        let clip = ClipSound {
            start_ms: 0,
            end_ms: 500,
            from: SoundFrom::Video(video),
        };
        let args = text(&audition_args(&clip, Path::new("/tmp/a.wav")));
        assert!(args.windows(2).any(|pair| pair == ["-i", "/r/clip.mp4"]));
        assert!(!args.iter().any(|arg| arg.contains("arnndn")));
    }
}
