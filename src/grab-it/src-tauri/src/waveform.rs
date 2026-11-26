//! Waveforms for the recording editor's timeline: the loudest moment of
//! every 10 ms of one source of a recording's sound, decoded by the
//! bundled ffmpeg and cached so a recording is only read once.
//!
//! Each peak is one byte, 0 for silence to 255 for full scale, and there
//! are [`PEAKS_PER_SECOND`] of them for the whole sound file, from its
//! start. The page lines them up with each clip's kept stretch.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::ffmpeg;
use crate::recording_editor::{AudioSource, RecordingEditorState, audio_sources};
use crate::rt::{AppHandle, WebviewWindow};

/// The rate ffmpeg decodes the sound at for peaks, in samples a second.
pub const SAMPLE_RATE: u32 = 8_000;
/// How many peaks one second of sound gives: one every 10 ms.
pub const PEAKS_PER_SECOND: u32 = 100;
/// Samples reduced into each peak.
const SAMPLES_PER_PEAK: usize = (SAMPLE_RATE / PEAKS_PER_SECOND) as usize;
/// The folder in the app's cache directory that holds computed peaks.
pub const WAVEFORMS_DIR: &str = "waveforms";
/// How long decoding one source's sound may take.
const PEAKS_TIMEOUT: Duration = Duration::from_secs(300);
/// Starts every cache entry, so a foreign or truncated file is never read
/// as peaks.
const CACHE_MAGIC: &[u8; 8] = b"GIWAVE01";

/// ffmpeg's arguments to write audio stream `stream` of `file` to its
/// stdout as mono 16-bit samples at [`SAMPLE_RATE`].
pub fn peaks_args(file: &Path, stream: usize) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostats", "-loglevel", "error", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(file.as_os_str().to_owned());
    args.push("-map".into());
    args.push(format!("0:a:{stream}").into());
    for arg in [
        "-ac",
        "1",
        "-ar",
        &SAMPLE_RATE.to_string(),
        "-f",
        "s16le",
        "pipe:1",
    ] {
        args.push(arg.into());
    }
    args
}

/// Reduces little-endian 16-bit samples, fed in pieces of any length,
/// to one peak for every [`SAMPLES_PER_PEAK`] of them.
#[derive(Debug, Default)]
pub struct Peaks {
    peaks: Vec<u8>,
    /// A sample's first byte, when a piece ended between its two.
    odd: Option<u8>,
    /// The loudest sample so far in the peak being gathered.
    loudest: u16,
    /// How many samples the peak being gathered holds.
    counted: usize,
}

impl Peaks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the samples in `bytes`.
    pub fn push(&mut self, mut bytes: &[u8]) {
        if let Some(low) = self.odd.take() {
            let Some((&high, rest)) = bytes.split_first() else {
                self.odd = Some(low);
                return;
            };
            self.sample(i16::from_le_bytes([low, high]));
            bytes = rest;
        }
        let (pairs, rest) = bytes.as_chunks::<2>();
        for pair in pairs {
            self.sample(i16::from_le_bytes(*pair));
        }
        self.odd = rest.first().copied();
    }

    fn sample(&mut self, sample: i16) {
        self.loudest = self.loudest.max(sample.unsigned_abs());
        self.counted += 1;
        if self.counted == SAMPLES_PER_PEAK {
            self.close();
        }
    }

    fn close(&mut self) {
        self.peaks.push(peak_byte(self.loudest));
        self.loudest = 0;
        self.counted = 0;
    }

    /// The peaks, the last one from however many samples were left.
    pub fn finish(mut self) -> Vec<u8> {
        if self.counted > 0 {
            self.close();
        }
        self.peaks
    }
}

/// A sample's magnitude, 0 to 32768, as a byte, 0 to 255, rounded.
fn peak_byte(magnitude: u16) -> u8 {
    ((u32::from(magnitude) * 255 + 16_384) / 32_768).min(255) as u8
}

/// Decodes audio stream `stream` of `file` with `ffmpeg_path` into peaks,
/// reading the samples as ffmpeg writes them.
pub fn decode_peaks(ffmpeg_path: &Path, file: &Path, stream: usize) -> Result<Vec<u8>, String> {
    let mut child = ffmpeg::command(ffmpeg_path)
        .args(peaks_args(file, stream))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start ffmpeg: {err}"))?;
    let samples = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut peaks = Peaks::new();
            let mut buffer = vec![0; 64 * 1024];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => peaks.push(&buffer[..read]),
                }
            }
            peaks.finish()
        })
    });
    let said = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });
    let status = ffmpeg::wait_for(&mut child, PEAKS_TIMEOUT);
    let peaks = samples
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let said = said
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(peaks),
        Some(_) => Err(ffmpeg::last_line(&said)
            .unwrap_or("ffmpeg could not read the sound")
            .to_owned()),
        None => Err("reading the sound took too long".to_owned()),
    }
}

/// Computed peaks kept in a folder, one file per source of sound, named
/// by what the sound file is: its path, length and modified time, and
/// the stream. A sound file that changes is read again.
#[derive(Debug, Clone)]
pub struct PeaksCache {
    dir: PathBuf,
}

impl PeaksCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The entry for stream `stream` of `file` as it is now, or `None`
    /// when the file cannot be read.
    pub fn entry(&self, file: &Path, stream: usize) -> Option<PathBuf> {
        let meta = fs::metadata(file).ok()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos());
        let mut hash = Sha256::new();
        hash.update(file.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(meta.len().to_le_bytes());
        hash.update(modified.to_le_bytes());
        hash.update((stream as u64).to_le_bytes());
        let name: String = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Some(self.dir.join(format!("{name}.peaks")))
    }

    /// The peaks kept in `entry`, or `None` when there are none or they
    /// cannot be read.
    pub fn load(&self, entry: &Path) -> Option<Vec<u8>> {
        let bytes = fs::read(entry).ok()?;
        bytes
            .strip_prefix(CACHE_MAGIC.as_slice())
            .map(<[u8]>::to_vec)
    }

    /// Keeps `peaks` in `entry`. Best effort: a cache that cannot be
    /// written only means reading the sound again.
    pub fn store(&self, entry: &Path, peaks: &[u8]) {
        if fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        // Written aside and renamed, so a reader never sees half an entry.
        let partial = entry.with_extension(format!("partial-{}", std::process::id()));
        let mut bytes = CACHE_MAGIC.to_vec();
        bytes.extend_from_slice(peaks);
        if fs::write(&partial, bytes).is_err() || fs::rename(&partial, entry).is_err() {
            let _ = fs::remove_file(&partial);
        }
    }
}

/// The peaks of `source`, from `cache` when it holds them, else from
/// `compute`, which are then kept there. The entry is named for the file
/// as it was before `compute` read it, so a file that changes meanwhile
/// is read again next time.
pub fn cached_peaks(
    cache: Option<&PeaksCache>,
    source: &AudioSource,
    compute: impl FnOnce(&Path, usize) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let entry = cache.and_then(|cache| Some((cache, cache.entry(&source.file, source.stream)?)));
    if let Some(peaks) = entry.as_ref().and_then(|(cache, entry)| cache.load(entry)) {
        return Ok(peaks);
    }
    let peaks = compute(&source.file, source.stream)?;
    if let Some((cache, entry)) = &entry {
        cache.store(entry, &peaks);
    }
    Ok(peaks)
}

/// Source `audio` of `sources`, in [`audio_sources`]' order.
pub fn source_at(sources: &[AudioSource], audio: usize) -> Result<&AudioSource, String> {
    sources
        .get(audio)
        .ok_or_else(|| format!("this recording has no sound source {audio}"))
}

/// The peaks of source `audio` of recording `file_name`'s sound, in
/// [`audio_sources`]' order (`RecordingInfo.audio` and
/// `RecordingSource.audio` list their kinds): [`PEAKS_PER_SECOND`] bytes
/// a second from the start of the recording.
#[tauri::command]
pub async fn recording_waveform(
    file_name: String,
    audio: usize,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, RecordingEditorState>,
) -> Result<tauri::ipc::Response, String> {
    let path = state.source_for(window.label(), &file_name)?;
    let Some(ready) = ffmpeg::ready(&app) else {
        ffmpeg::prepare_in_background(&app);
        return Err("ffmpeg is not ready yet; see Settings → Recording, then try again".to_owned());
    };
    let cache = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| PeaksCache::new(dir.join(WAVEFORMS_DIR)));
    tauri::async_runtime::spawn_blocking(move || {
        let sources = audio_sources(&path, Some(&ready.path));
        let source = source_at(&sources, audio)?;
        let peaks = cached_peaks(cache.as_ref(), source, |file, stream| {
            decode_peaks(&ready.path, file, stream)
        })?;
        Ok(tauri::ipc::Response::new(peaks))
    })
    .await
    .map_err(|err| format!("could not read the waveform: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_editor::AudioKind;
    use std::cell::Cell;

    /// The peaks of `samples`, little-endian 16-bit, in one piece.
    fn peaks_of(samples: &[u8]) -> Vec<u8> {
        let mut peaks = Peaks::new();
        peaks.push(samples);
        peaks.finish()
    }

    /// What `cache` holds for stream `stream` of `file` as it is now.
    fn cached(cache: &PeaksCache, file: &Path, stream: usize) -> Option<Vec<u8>> {
        cache.load(&cache.entry(file, stream)?)
    }

    fn samples(values: &[i16]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    #[test]
    fn each_peak_is_the_loudest_sample_of_its_10_ms() {
        let mut values = vec![0i16; SAMPLES_PER_PEAK * 2 + 3];
        values[5] = -16_384;
        values[10] = 8_000;
        values[SAMPLES_PER_PEAK + 1] = i16::MIN;
        values[SAMPLES_PER_PEAK * 2 + 1] = 129;
        assert_eq!(peaks_of(&samples(&values)), [128, 255, 1]);
    }

    #[test]
    fn silence_and_nothing_have_no_height() {
        assert_eq!(peaks_of(&samples(&[0; SAMPLES_PER_PEAK])), [0]);
        assert!(peaks_of(&[]).is_empty());
        assert_eq!(peaks_of(&samples(&[i16::MAX])), [255]);
    }

    #[test]
    fn samples_split_between_reads_are_joined() {
        let mut values = vec![0i16; SAMPLES_PER_PEAK];
        values[3] = -32_000;
        let bytes = samples(&values);
        let mut peaks = Peaks::new();
        // Split inside a sample, and send an empty piece between halves.
        peaks.push(&bytes[..7]);
        peaks.push(&[]);
        peaks.push(&bytes[7..]);
        assert_eq!(peaks.finish(), peaks_of(&bytes));
        assert_eq!(peaks_of(&bytes), [249]);
    }

    #[test]
    fn peaks_are_decoded_from_one_stream_as_mono_samples() {
        let args: Vec<String> = peaks_args(Path::new("/r/clip.sound.m4a"), 1)
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-i", "/r/clip.sound.m4a"])
        );
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:a:1"]));
        assert!(args.windows(2).any(|pair| pair == ["-ac", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["-ar", "8000"]));
        assert_eq!(&args[args.len() - 3..], ["-f", "s16le", "pipe:1"]);
    }

    fn sound_in(dir: &Path) -> AudioSource {
        let file = dir.join("clip.sound.m4a");
        fs::write(&file, b"sound").unwrap();
        AudioSource {
            kind: AudioKind::Microphone,
            file,
            stream: 0,
        }
    }

    #[test]
    fn cached_peaks_are_not_computed_again() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PeaksCache::new(dir.path().join(WAVEFORMS_DIR));
        let source = sound_in(dir.path());
        let computed = Cell::new(0);
        let compute = |_: &Path, _: usize| {
            computed.set(computed.get() + 1);
            Ok(vec![1, 2, 3])
        };
        assert_eq!(
            cached_peaks(Some(&cache), &source, compute),
            Ok(vec![1, 2, 3])
        );
        assert_eq!(
            cached_peaks(Some(&cache), &source, compute),
            Ok(vec![1, 2, 3])
        );
        assert_eq!(computed.get(), 1);
        // Another stream of the same file is its own entry.
        let system = AudioSource {
            stream: 1,
            ..source.clone()
        };
        assert_eq!(cached(&cache, &system.file, 1), None);
    }

    #[test]
    fn a_changed_sound_file_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PeaksCache::new(dir.path().join(WAVEFORMS_DIR));
        let source = sound_in(dir.path());
        cache.store(&cache.entry(&source.file, 0).unwrap(), &[9, 9]);
        fs::write(&source.file, b"longer sound").unwrap();
        let fresh = cached_peaks(Some(&cache), &source, |_, _| Ok(vec![4]));
        assert_eq!(fresh, Ok(vec![4]));
        assert_eq!(cached(&cache, &source.file, 0), Some(vec![4]));
    }

    #[test]
    fn a_sound_file_changed_while_it_is_read_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PeaksCache::new(dir.path().join(WAVEFORMS_DIR));
        let source = sound_in(dir.path());
        let changing = |file: &Path, _: usize| {
            fs::write(file, b"sound recorded on").unwrap();
            Ok(vec![1])
        };
        assert_eq!(cached_peaks(Some(&cache), &source, changing), Ok(vec![1]));
        // Kept for the file as it was, not as it is now.
        assert_eq!(cached(&cache, &source.file, 0), None);
        assert_eq!(
            cached_peaks(Some(&cache), &source, |_, _| Ok(vec![2])),
            Ok(vec![2])
        );
    }

    #[test]
    fn an_unreadable_entry_is_computed_again() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PeaksCache::new(dir.path().join(WAVEFORMS_DIR));
        let source = sound_in(dir.path());
        let entry = cache.entry(&source.file, 0).unwrap();
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, b"not peaks").unwrap();
        assert_eq!(cached(&cache, &source.file, 0), None);
        let fresh = cached_peaks(Some(&cache), &source, |_, _| Ok(vec![7, 8]));
        assert_eq!(fresh, Ok(vec![7, 8]));
        assert_eq!(cached(&cache, &source.file, 0), Some(vec![7, 8]));
        // An entry that is a folder is no better.
        let other = AudioSource {
            stream: 2,
            ..source.clone()
        };
        fs::create_dir_all(cache.entry(&other.file, 2).unwrap()).unwrap();
        assert_eq!(
            cached_peaks(Some(&cache), &other, |_, _| Ok(vec![5])),
            Ok(vec![5])
        );
    }

    #[test]
    fn a_failure_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let cache = PeaksCache::new(dir.path().join(WAVEFORMS_DIR));
        let source = sound_in(dir.path());
        assert!(cached_peaks(Some(&cache), &source, |_, _| Err("no".into())).is_err());
        assert_eq!(cached(&cache, &source.file, 0), None);
        assert_eq!(cached_peaks(None, &source, |_, _| Ok(vec![1])), Ok(vec![1]));
    }

    #[test]
    fn a_source_past_the_recordings_sound_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let sources = [sound_in(dir.path())];
        assert_eq!(source_at(&sources, 0), Ok(&sources[0]));
        assert!(
            source_at(&sources, 1)
                .unwrap_err()
                .contains("no sound source 1")
        );
        assert!(source_at(&[], 0).is_err());
    }
}
