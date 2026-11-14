//! Screen recording to an animated GIF.
//!
//! The user drags a region (or clicks a window) on the usual overlay; that
//! area of that monitor is then grabbed about ten times a second and written
//! straight into a GIF in `<save folder>/recordings/`, so memory use does
//! not grow with the length of the recording. The Quick Access card shows
//! the elapsed time and a Stop button, and moves out of the recorded area.
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
use tauri::{AppHandle, Manager};

use crate::{
    actions,
    capture::{self, Rect},
    commands::{SettingsState, lock},
    quick::{self, QuickItem},
    screen::{self, MonitorInfo},
};

pub const RECORDINGS_DIR: &str = "recordings";
/// The time between frames: ten frames a second.
const FRAME_INTERVAL: Duration = Duration::from_millis(100);
/// How long the desktop gets to repaint after the overlay closes.
const SETTLE_DELAY: Duration = Duration::from_millis(200);
/// How long quitting waits for a recording to write its last frames.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
/// A recording stops by itself after this long.
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
pub fn recording_file_name(time: &DateTime<Local>, counter: u32) -> String {
    let stamp = time.format("%Y-%m-%d %H-%M-%S");
    if counter <= 1 {
        format!("Grab-it {stamp}.gif")
    } else {
        format!("Grab-it {stamp} ({counter}).gif")
    }
}

fn unique_recording_path(dir: &Path, time: &DateTime<Local>) -> PathBuf {
    let mut counter = 1;
    loop {
        let path = dir.join(recording_file_name(time, counter));
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

/// Starts recording `rect` of `monitor`. `rect` is in the pixels of the
/// monitor's image, whose size is `image_size`. Runs until [`stop`] or
/// [`MAX_DURATION`]. Call this off the main thread.
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

    let folder = lock(&app.state::<SettingsState>())
        .get()
        .save_folder
        .join(RECORDINGS_DIR);
    let started = Local::now();
    let prepared = fs::create_dir_all(&folder)
        .map(|()| unique_recording_path(&folder, &started))
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
            max_seconds: MAX_DURATION.as_secs(),
        },
        corner,
    );

    let handle = app.clone();
    let index = monitor.index;
    let spawned = std::thread::Builder::new()
        .name("grab-it-record".into())
        .spawn(move || {
            // The overlay was closed a moment ago; give the desktop time to
            // repaint so the first frame shows the screen, not the overlay.
            std::thread::sleep(SETTLE_DELAY);
            let result = record(index, rect, &path, &flag);
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
                        },
                    );
                }
                Err(err) => {
                    let _ = fs::remove_file(&path);
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

/// Grabs frames into the GIF at `path` until `stop` is set or the time is
/// up. Returns how long the recording runs.
fn record(monitor: usize, rect: Rect, path: &Path, stop: &AtomicBool) -> Result<Duration, String> {
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
        let frame = match grab(monitor, rect) {
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

fn grab(monitor: usize, rect: Rect) -> Result<RgbaImage, String> {
    let image = screen::capture_monitor(monitor)?;
    let cropped = capture::crop(&image, rect).ok_or("the recorded area is off screen")?;
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
            recording_file_name(&time, 1),
            "Grab-it 2026-03-07 09-05-01.gif"
        );
        assert_eq!(
            recording_file_name(&time, 2),
            "Grab-it 2026-03-07 09-05-01 (2).gif"
        );
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
