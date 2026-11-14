//! Screen recording to an MP4 or an animated GIF.
//!
//! The user drags a region (or clicks a window) on the usual overlay; that
//! area of that monitor is then grabbed over and over and written straight
//! into a file in `<save folder>/recordings/`, so memory use does not grow
//! with the length of the recording. The Quick Access card shows the
//! elapsed time and a Stop button, and moves out of the recorded area.
//!
//! An MP4 is piped through ffmpeg (see ffmpeg.rs) at a constant 30 or 60
//! frames a second, with no length limit, and `<name>.cursor.json` beside
//! it says where the pointer was in each frame. A GIF is encoded here,
//! about ten frames a second, for at most [`MAX_DURATION`]. MP4 is the
//! default; while ffmpeg is not ready yet, a recording is saved as a GIF
//! and the card says why. Frames are grabbed as frames.rs says.
//!
//! Recording needs to read the screen freely, so it is not offered on
//! Wayland, where only the desktop's own portal may do that.

use std::{
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Local};
use image::{
    Delay, Frame, RgbaImage,
    codecs::gif::{GifEncoder, Repeat},
    imageops::{self, FilterType},
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    actions,
    capture::{self, Rect},
    commands::{SettingsState, lock},
    ffmpeg::{self, Video, VideoSpec},
    frames::{self, FrameSource},
    quick::{self, QuickItem},
    screen::MonitorInfo,
    settings::{RecordingFormat, RecordingSettings},
};

pub const RECORDINGS_DIR: &str = "recordings";
/// The time between GIF frames: ten frames a second.
const FRAME_INTERVAL: Duration = Duration::from_millis(100);
/// A GIF's frame rate, as [`FRAME_INTERVAL`] says.
const GIF_FPS: u32 = 10;
/// Ends the name of the pointer sidecar beside an MP4.
pub const CURSOR_SUFFIX: &str = ".cursor.json";
/// How long the desktop gets to repaint after the overlay closes.
const SETTLE_DELAY: Duration = Duration::from_millis(200);
/// How long quitting waits for a recording to write its last frames. An
/// MP4 is finished by moving its index to the front, which rewrites it.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// A GIF recording stops by itself after this long.
pub const MAX_DURATION: Duration = Duration::from_secs(60);
/// Frames wider than this are scaled down, which keeps HiDPI recordings a
/// sensible size and the encoder fast enough to hold the frame rate.
const MAX_WIDTH: u32 = 1280;
/// The GIF quantiser's speed, 1 (best) to 30 (fastest). 10 is the encoder's
/// own recommendation for a good balance.
const QUANTISER_SPEED: i32 = 10;

/// The stop flag of the recording under way, if any.
#[derive(Default)]
pub struct RecordState(Mutex<Option<Arc<AtomicBool>>>);

impl RecordState {
    fn lock(&self) -> MutexGuard<'_, Option<Arc<AtomicBool>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Asks the recording under way to finish. False when there is none.
pub fn stop(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<RecordState>() else {
        return false;
    };
    match &*state.lock() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Stops the recording under way and waits, briefly, for its file to be
/// finished. Returns at once when nothing is recording.
pub fn stop_and_wait(app: &AppHandle) {
    if !stop(app) {
        return;
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        let recording = app
            .try_state::<RecordState>()
            .is_some_and(|state| state.lock().is_some());
        if !recording {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
pub fn record_stop(app: AppHandle) {
    stop(&app);
}

/// The file name for a recording started at `time`, without a folder.
pub fn recording_file_name(
    time: &DateTime<Local>,
    counter: u32,
    format: RecordingFormat,
) -> String {
    let stamp = time.format("%Y-%m-%d %H-%M-%S");
    let extension = format.extension();
    if counter <= 1 {
        format!("Grab-it {stamp}.{extension}")
    } else {
        format!("Grab-it {stamp} ({counter}).{extension}")
    }
}

fn unique_recording_path(dir: &Path, time: &DateTime<Local>, format: RecordingFormat) -> PathBuf {
    let mut counter = 1;
    loop {
        let path = dir.join(recording_file_name(time, counter, format));
        if !path.exists() {
            return path;
        }
        counter += 1;
    }
}

/// The size frames are written at: the region's own size, or scaled down
/// to [`MAX_WIDTH`] keeping its ratio.
pub fn frame_size(region: (u32, u32)) -> (u32, u32) {
    let (width, height) = (region.0.max(1), region.1.max(1));
    if width <= MAX_WIDTH {
        return (width, height);
    }
    let scaled = (f64::from(height) * f64::from(MAX_WIDTH) / f64::from(width)).round() as u32;
    (MAX_WIDTH, scaled.max(1))
}

/// Keeps an MP4 at a constant frame rate: says when the next frame is due,
/// and how many times to repeat the last one when a grab took so long that
/// frame times went by without one.
///
/// At most half a second of repeats follows each grab. Frame times further
/// behind than that (ffmpeg taking frames in more slowly than the frame
/// rate, or the computer sleeping mid-recording) are dropped, so a new
/// frame is always grabbed soon and the video keeps moving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pacer {
    fps: u64,
    /// Frames written so far, repeats included.
    frames: u64,
    /// Frame times dropped because the recording fell too far behind.
    dropped: u64,
}

const NANOS_PER_SECOND: u128 = 1_000_000_000;

impl Pacer {
    pub fn new(fps: u32) -> Self {
        Self {
            fps: u64::from(fps.max(1)),
            frames: 0,
            dropped: 0,
        }
    }

    /// The most repeats written after one grab: half a second.
    pub fn max_repeats(&self) -> u64 {
        (self.fps / 2).max(1)
    }

    /// Counts a frame just written, `elapsed` after the recording started.
    /// Returns how many more times to write it, each counted with
    /// [`Pacer::repeated`]: once for each frame time that has fully gone by
    /// since, up to [`Pacer::max_repeats`].
    pub fn wrote_frame(&mut self, elapsed: Duration) -> u64 {
        self.frames += 1;
        // The frame time under way now, which the next grab fills.
        let current = (elapsed.as_nanos() * u128::from(self.fps) / NANOS_PER_SECOND) as u64;
        let behind = current.saturating_sub(self.frames + self.dropped);
        let repeats = behind.min(self.max_repeats());
        self.dropped += behind - repeats;
        repeats
    }

    /// Counts one repeat of the last frame.
    pub fn repeated(&mut self) {
        self.frames += 1;
    }

    /// When the next frame should be grabbed, from the recording's start.
    pub fn next_frame_at(&self) -> Duration {
        self.at(self.frames + self.dropped)
    }

    /// How long the frames written so far play for.
    pub fn duration(&self) -> Duration {
        self.at(self.frames)
    }

    fn at(&self, frames: u64) -> Duration {
        let nanos = u128::from(frames) * NANOS_PER_SECOND / u128::from(self.fps);
        Duration::from_nanos(nanos.min(u128::from(u64::MAX)) as u64)
    }
}

/// Where the pointer was in each frame of an MP4, saved beside it as
/// `<name>.cursor.json` for later edits such as zooming in on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTrack {
    pub version: u32,
    /// The video's size: positions are in its pixels.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// One entry a frame, repeats included: the pointer's hot spot as
    /// `[x, y]` from the frame's top-left corner, which may lie outside
    /// it, or null where it could not be told.
    pub positions: Vec<Option<[i32; 2]>>,
    /// The grabbed frames' size, which the video may be scaled from.
    #[serde(skip)]
    grabbed: (u32, u32),
}

impl CursorTrack {
    pub fn new(spec: &VideoSpec) -> Self {
        Self {
            version: 1,
            width: spec.output.0,
            height: spec.output.1,
            fps: spec.fps,
            positions: Vec::new(),
            grabbed: spec.input,
        }
    }

    /// Adds `count` frames with the pointer at `pointer`, in the pixels of
    /// the grabbed frame.
    pub fn push(&mut self, pointer: Option<(i32, i32)>, count: u64) {
        let scale = |value: i32, from: u32, to: u32| {
            (f64::from(value) * f64::from(to) / f64::from(from.max(1))).round() as i32
        };
        let position = pointer.map(|(x, y)| {
            [
                scale(x, self.grabbed.0, self.width),
                scale(y, self.grabbed.1, self.height),
            ]
        });
        for _ in 0..count {
            self.positions.push(position);
        }
    }

    pub fn save(&self, video: &Path) -> Result<(), String> {
        let path = cursor_path(video);
        let json = serde_json::to_vec(self).map_err(|err| err.to_string())?;
        fs::write(&path, json).map_err(|err| format!("could not write {}: {err}", path.display()))
    }
}

/// The pointer sidecar of a recording: `<name>.mp4` gives
/// `<name>.cursor.json`.
pub fn cursor_path(video: &Path) -> PathBuf {
    capture::sidecar_path(video, CURSOR_SUFFIX)
}

/// What a recording is written as.
enum Output {
    Gif,
    Mp4(ffmpeg::Ready),
}

/// Starts recording `rect` of `monitor`. `rect` is in the pixels of the
/// monitor's image, whose size is `image_size`. Runs until [`stop`], or for
/// a GIF [`MAX_DURATION`]. Call this off the main thread.
pub fn start(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
) -> Result<(), String> {
    let state = app.state::<RecordState>();
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut current = state.lock();
        if current.is_some() {
            return Err("a recording is already under way".to_owned());
        }
        *current = Some(Arc::clone(&flag));
    }
    crate::tray::set_recording(app, true);

    let (folder, recording) = {
        let state = app.state::<SettingsState>();
        let store = lock(&state);
        let settings = store.get();
        (
            settings.save_folder.join(RECORDINGS_DIR),
            settings.recording,
        )
    };
    // MP4 needs ffmpeg; until it is ready, the recording is a GIF.
    let mut fallback = None;
    let output = match recording.format {
        RecordingFormat::Gif => Output::Gif,
        RecordingFormat::Mp4 => match ffmpeg::ready(app) {
            Some(ready) => Output::Mp4(ready),
            None => {
                fallback = Some(ffmpeg::fallback_reason(&ffmpeg::status(app)));
                // Not asked for yet, or failed earlier: try again for next time.
                ffmpeg::prepare_in_background(app);
                Output::Gif
            }
        },
    };
    let format = match output {
        Output::Gif => RecordingFormat::Gif,
        Output::Mp4(..) => RecordingFormat::Mp4,
    };
    let started = Local::now();
    let prepared = fs::create_dir_all(&folder)
        .map(|()| unique_recording_path(&folder, &started, format))
        .map_err(|err| format!("could not create {}: {err}", folder.display()));
    let path = match prepared {
        Ok(path) => path,
        Err(err) => {
            *state.lock() = None;
            crate::tray::set_recording(app, false);
            return Err(err);
        }
    };

    // Measured against the frozen frame itself: whether a monitor's
    // reported size is in pixels or points differs between platforms.
    let corner = quick::corner_clear_of(
        rect,
        image_size,
        monitor.scale_factor,
        quick::preferred_corner(app),
    );
    quick::show_in(
        app,
        QuickItem::Recording {
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or_default(),
            max_seconds: match format {
                RecordingFormat::Gif => Some(MAX_DURATION.as_secs()),
                RecordingFormat::Mp4 => None,
            },
        },
        corner,
    );

    let handle = app.clone();
    let monitor = monitor.clone();
    let spawned = std::thread::Builder::new()
        .name("grab-it-record".into())
        .spawn(move || {
            // The overlay was closed a moment ago; give the desktop time to
            // repaint so the first frame shows the screen, not the overlay.
            std::thread::sleep(SETTLE_DELAY);
            let result = match &output {
                Output::Gif => frames::open(&monitor, rect, GIF_FPS, recording.show_cursor)
                    .and_then(|mut source| record_gif(source.as_mut(), &path, &flag)),
                Output::Mp4(ready) => {
                    frames::open(&monitor, rect, recording.fps, recording.show_cursor).and_then(
                        |mut source| record_mp4(source.as_mut(), &path, &flag, ready, &recording),
                    )
                }
            };
            *handle.state::<RecordState>().lock() = None;
            crate::tray::set_recording(&handle, false);
            match result {
                Ok(duration) => {
                    let bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                    quick::show(
                        &handle,
                        QuickItem::Recorded {
                            file_name: path
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                                .unwrap_or_default(),
                            path,
                            duration_ms: duration.as_millis() as u64,
                            bytes,
                            format,
                            fallback,
                        },
                    );
                }
                Err(err) => {
                    let _ = fs::remove_file(&path);
                    let _ = fs::remove_file(cursor_path(&path));
                    actions::report_failure(&handle, &format!("the recording failed: {err}"));
                }
            }
        });
    if let Err(err) = spawned {
        *state.lock() = None;
        crate::tray::set_recording(app, false);
        return Err(format!("could not start recording: {err}"));
    }
    Ok(())
}

/// Grabs frames into the MP4 at `path` until `stop` is set, at a constant
/// frame rate: a frame time that goes by while a grab is under way
/// repeats the frame before. Saves where the pointer was beside it.
/// Returns how long the video runs.
fn record_mp4(
    source: &mut dyn FrameSource,
    path: &Path,
    stop: &AtomicBool,
    ready: &ffmpeg::Ready,
    recording: &RecordingSettings,
) -> Result<Duration, String> {
    let first = source.grab()?;
    let (mut frame, mut pointer) = (first.image, first.pointer);
    let input = frame.dimensions();
    let spec = VideoSpec {
        input,
        output: ffmpeg::video_size(input),
        fps: recording.fps,
        bits_per_pixel: recording.quality.bits_per_pixel(),
    };
    let mut video =
        Video::start(&ready.path, ready.encoder, &spec, path).map_err(|err| err.to_string())?;
    let mut track = CursorTrack::new(&spec);
    let started = Instant::now();
    let mut pacer = Pacer::new(spec.fps);
    loop {
        video.write(&frame).map_err(|err| err.to_string())?;
        track.push(pointer, 1);
        // Stop is checked between repeats, so it is never kept waiting.
        for _ in 0..pacer.wrote_frame(started.elapsed()) {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            video.write(&frame).map_err(|err| err.to_string())?;
            pacer.repeated();
            track.push(pointer, 1);
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let due = started + pacer.next_frame_at();
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        }
        (frame, pointer) = match source.grab() {
            Ok(next) if next.image.dimensions() == input => (next.image, next.pointer),
            // The monitor changed resolution: keep what was recorded.
            Ok(_) => {
                eprintln!("Grab-it: recording ended early: the recorded area changed size");
                break;
            }
            // The screen went away mid-recording (a monitor unplugged,
            // say): keep what was recorded rather than throw it away.
            Err(err) => {
                eprintln!("Grab-it: recording ended early: {err}");
                break;
            }
        };
    }
    video.finish().map_err(|err| err.to_string())?;
    // The video is fine without it.
    if let Err(err) = track.save(path) {
        eprintln!("Grab-it: no pointer sidecar: {err}");
    }
    Ok(pacer.duration())
}

/// Grabs frames into the GIF at `path` until `stop` is set or the time is
/// up. Returns how long the recording runs.
fn record_gif(
    source: &mut dyn FrameSource,
    path: &Path,
    stop: &AtomicBool,
) -> Result<Duration, String> {
    let file = File::create(path).map_err(|err| format!("could not create the file: {err}"))?;
    let mut encoder = GifEncoder::new_with_speed(BufWriter::new(file), QUANTISER_SPEED);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|err| err.to_string())?;

    let started = Instant::now();
    // Each frame is shown until the next one was grabbed, so the GIF plays
    // back in real time even when a frame took longer than the interval.
    let mut pending: Option<(RgbaImage, Instant)> = None;
    let mut total = Duration::ZERO;
    loop {
        let grabbed_at = Instant::now();
        let frame = match grab(source) {
            Ok(frame) => frame,
            // Nothing recorded yet: the recording failed outright.
            Err(err) if pending.is_none() => return Err(err),
            // The screen went away mid-recording (a monitor unplugged,
            // say): keep what was recorded rather than throw it away.
            Err(err) => {
                eprintln!("Grab-it: recording ended early: {err}");
                break;
            }
        };
        if let Some((previous, since)) = pending.take() {
            total += write_frame(&mut encoder, previous, grabbed_at - since)?;
        }
        pending = Some((frame, grabbed_at));

        if stop.load(Ordering::SeqCst) || started.elapsed() >= MAX_DURATION {
            break;
        }
        let spent = grabbed_at.elapsed();
        if spent < FRAME_INTERVAL {
            std::thread::sleep(FRAME_INTERVAL - spent);
        }
    }
    if let Some((last, since)) = pending {
        // The last frame lingers at least a moment so it can be seen.
        let shown = since.elapsed().max(FRAME_INTERVAL);
        total += write_frame(&mut encoder, last, shown)?;
    }
    Ok(total)
}

/// The recorded area, scaled down for a GIF.
fn grab(source: &mut dyn FrameSource) -> Result<RgbaImage, String> {
    let cropped = source.grab()?.image;
    let size = frame_size(cropped.dimensions());
    Ok(if size == cropped.dimensions() {
        cropped
    } else {
        imageops::resize(&cropped, size.0, size.1, FilterType::Triangle)
    })
}

/// Writes one frame shown for `shown`. Returns the time the GIF actually
/// shows it for, which is rounded to the format's hundredths of a second.
fn write_frame(
    encoder: &mut GifEncoder<BufWriter<File>>,
    image: RgbaImage,
    shown: Duration,
) -> Result<Duration, String> {
    let delay = Delay::from_saturating_duration(shown);
    let frame = Frame::from_parts(image, 0, 0, delay);
    encoder
        .encode_frame(frame)
        .map_err(|err| format!("could not write a frame: {err}"))?;
    Ok(Duration::from(delay))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use image::{AnimationDecoder, Rgba, codecs::gif::GifDecoder};

    #[test]
    fn recordings_are_named_like_captures() {
        let time = Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 1).unwrap();
        assert_eq!(
            recording_file_name(&time, 1, RecordingFormat::Gif),
            "Grab-it 2026-03-07 09-05-01.gif"
        );
        assert_eq!(
            recording_file_name(&time, 2, RecordingFormat::Gif),
            "Grab-it 2026-03-07 09-05-01 (2).gif"
        );
    }

    #[test]
    fn mp4_recordings_end_in_mp4_and_never_overwrite_one() {
        let time = Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 1).unwrap();
        assert_eq!(
            recording_file_name(&time, 1, RecordingFormat::Mp4),
            "Grab-it 2026-03-07 09-05-01.mp4"
        );
        assert_eq!(
            recording_file_name(&time, 3, RecordingFormat::Mp4),
            "Grab-it 2026-03-07 09-05-01 (3).mp4"
        );
        let dir = tempfile::tempdir().unwrap();
        let first = unique_recording_path(dir.path(), &time, RecordingFormat::Mp4);
        fs::write(&first, b"video").unwrap();
        assert_eq!(
            unique_recording_path(dir.path(), &time, RecordingFormat::Mp4),
            dir.path().join("Grab-it 2026-03-07 09-05-01 (2).mp4")
        );
        // A GIF of the same second does not take the MP4's name.
        assert_eq!(
            unique_recording_path(dir.path(), &time, RecordingFormat::Gif),
            dir.path().join("Grab-it 2026-03-07 09-05-01.gif")
        );
    }

    #[test]
    fn frames_on_time_are_written_once() {
        let mut pacer = Pacer::new(30);
        let ms = Duration::from_millis;
        // Each grab finishes inside its own frame time.
        assert_eq!(pacer.wrote_frame(ms(5)), 0);
        assert_eq!(pacer.next_frame_at(), Duration::from_secs(1) / 30);
        assert_eq!(pacer.wrote_frame(ms(40)), 0);
        assert_eq!(pacer.wrote_frame(ms(70)), 0);
        assert_eq!(pacer.duration(), Duration::from_secs(1) / 10);
    }

    #[test]
    fn a_late_grab_repeats_the_last_frame_to_keep_time() {
        let mut pacer = Pacer::new(10);
        let ms = Duration::from_millis;
        assert_eq!(pacer.wrote_frame(ms(10)), 0);
        assert_eq!(pacer.next_frame_at(), ms(100));
        // The second grab, due at 100 ms, took until 450 ms: the frame
        // times at 200 and 300 ms went by, so it fills those too, and the
        // grab for 400 ms starts at once.
        assert_eq!(pacer.wrote_frame(ms(450)), 2);
        pacer.repeated();
        pacer.repeated();
        assert_eq!(pacer.next_frame_at(), ms(400));
        assert_eq!(pacer.wrote_frame(ms(460)), 0);
        assert_eq!(pacer.next_frame_at(), ms(500));
        // Five frames at 10 fps: the video is as long as the recording.
        assert_eq!(pacer.duration(), ms(500));
    }

    #[test]
    fn a_slow_encoder_still_gets_new_frames() {
        // Every write, repeats included, takes 50 ms: longer than a frame
        // time at 30 fps. Repeats stay capped, so grabs keep coming.
        let mut pacer = Pacer::new(30);
        let write = Duration::from_millis(50);
        let mut now = Duration::ZERO;
        let mut most = 0;
        for _ in 0..200 {
            now += write;
            let repeats = pacer.wrote_frame(now);
            most = most.max(repeats);
            for _ in 0..repeats {
                now += write;
                pacer.repeated();
            }
            now = now.max(pacer.next_frame_at());
        }
        assert!(most <= pacer.max_repeats(), "{most} repeats after one grab");
        assert_eq!(pacer.max_repeats(), 15);
        // The next grab is due no later than now: nothing waits on the past.
        assert!(pacer.next_frame_at() <= now + Duration::from_secs(1) / 30);
    }

    #[test]
    fn a_long_stall_writes_half_a_second_of_repeats_not_thousands() {
        let mut pacer = Pacer::new(30);
        assert_eq!(pacer.wrote_frame(Duration::ZERO), 0);
        // The computer slept for an hour mid-recording.
        assert_eq!(pacer.wrote_frame(Duration::from_secs(3600)), 15);
        for _ in 0..15 {
            pacer.repeated();
        }
        assert_eq!(pacer.next_frame_at(), Duration::from_secs(3600));
        // The video holds what was written, not the hour.
        assert_eq!(pacer.duration(), Duration::from_secs(17) / 30);
    }

    #[test]
    fn sixty_seconds_at_thirty_fps_is_1800_frames_and_a_minute_long() {
        let mut pacer = Pacer::new(30);
        let mut written = 0;
        while pacer.next_frame_at() < Duration::from_secs(60) {
            let at = pacer.next_frame_at() + Duration::from_millis(1);
            written += 1;
            for _ in 0..pacer.wrote_frame(at) {
                pacer.repeated();
                written += 1;
            }
        }
        assert_eq!(written, 1800);
        assert_eq!(pacer.duration().as_secs(), 60);
    }

    #[test]
    fn the_pointer_sidecar_sits_beside_the_video() {
        assert_eq!(
            cursor_path(Path::new(
                "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4"
            )),
            PathBuf::from("/shots/recordings/Grab-it 2026-03-07 09-05-01.cursor.json")
        );
    }

    #[test]
    fn the_pointer_is_saved_for_every_frame_in_video_pixels() {
        // Grabbed at 1001×600, so the video is 1000×600.
        let spec = VideoSpec {
            input: (1001, 600),
            output: ffmpeg::video_size((1001, 600)),
            fps: 60,
            bits_per_pixel: 0.2,
        };
        let mut track = CursorTrack::new(&spec);
        track.push(Some((10, 20)), 1);
        // A late grab: the frame and its repeat share the place.
        track.push(None, 2);
        track.push(Some((1001, -5)), 1);
        assert_eq!(
            track.positions,
            vec![Some([10, 20]), None, None, Some([1000, -5])]
        );

        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        track.save(&video).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("clip.cursor.json")).unwrap())
                .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1,
                "width": 1000,
                "height": 600,
                "fps": 60,
                "positions": [[10, 20], null, null, [1000, -5]],
            })
        );
    }

    #[test]
    fn sixty_fps_keeps_time_too() {
        let mut pacer = Pacer::new(60);
        let mut written = 0;
        while pacer.next_frame_at() < Duration::from_secs(2) {
            // Each grab ends a little after its frame time, before the next.
            let at = pacer.next_frame_at() + Duration::from_millis(20);
            written += 1 + pacer.wrote_frame(at);
        }
        assert_eq!(written, 120);
        assert_eq!(pacer.duration(), Duration::from_secs(2));
    }

    #[test]
    fn wide_regions_are_scaled_down_keeping_their_ratio() {
        assert_eq!(frame_size((800, 600)), (800, 600));
        assert_eq!(frame_size((1280, 720)), (1280, 720));
        assert_eq!(frame_size((2560, 1440)), (1280, 720));
        assert_eq!(frame_size((3000, 10)), (1280, 4));
        assert_eq!(frame_size((0, 0)), (1, 1));
    }

    #[test]
    fn frames_play_back_for_as_long_as_they_were_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.gif");
        let mut encoder = GifEncoder::new_with_speed(
            BufWriter::new(File::create(&path).unwrap()),
            QUANTISER_SPEED,
        );
        encoder.set_repeat(Repeat::Infinite).unwrap();
        let red = RgbaImage::from_pixel(4, 3, Rgba([255, 0, 0, 255]));
        let blue = RgbaImage::from_pixel(4, 3, Rgba([0, 0, 255, 255]));
        let first = write_frame(&mut encoder, red, Duration::from_millis(100)).unwrap();
        let second = write_frame(&mut encoder, blue, Duration::from_millis(250)).unwrap();
        drop(encoder);
        assert_eq!(first, Duration::from_millis(100));
        assert_eq!(second, Duration::from_millis(250));

        let decoder = GifDecoder::new(std::io::BufReader::new(File::open(&path).unwrap())).unwrap();
        let frames = decoder.into_frames().collect_frames().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].buffer().dimensions(), (4, 3));
        assert_eq!(
            Duration::from(frames[1].delay()),
            Duration::from_millis(250)
        );
        assert_eq!(frames[1].buffer().get_pixel(0, 0), &Rgba([0, 0, 255, 255]));
    }
}
