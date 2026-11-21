//! Screen recording to an MP4 or an animated GIF.
//!
//! The user drags a region (or clicks a window) on the usual overlay; that
//! area of that monitor is then grabbed over and over and written straight
//! into a file in `<save folder>/recordings/`, so memory use does not grow
//! with the length of the recording. The recording toolbar (record_bar.rs)
//! shows the elapsed time with Mute, Pause, Stop, Restart and Discard,
//! after an optional countdown.
//!
//! An MP4 is piped through ffmpeg (see ffmpeg.rs) at a constant 30 or 60
//! frames a second, with no length limit, and `<name>.cursor.json` beside
//! it says where the pointer was in each frame. With Audio set to
//! Microphone, System or Both, that sound is recorded alongside (see
//! audio.rs) and muxed in when it stops, the two mixed into one track for
//! Both; a recording whose sound failed is kept silent, or with only the
//! sound that worked, and the card says why. A GIF is silent, encoded here at about ten frames a
//! second, for at most [`MAX_DURATION`]. MP4 is the
//! default; while ffmpeg is not ready yet, a recording is saved as a GIF
//! and the card says why. Frames are grabbed as frames.rs says. With Show
//! clicks or Show keystrokes on, click rings and a keystroke label are
//! drawn into each frame after the pointer (see frame_overlays.rs). With
//! Show webcam on, the camera is shown in a bubble over the recorded area
//! for as long as the recording runs, and so recorded with it (see
//! webcam.rs).
//!
//! Recording needs to read the screen freely, so it is not offered on
//! Wayland, where only the desktop's own portal may do that.

use std::{
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
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
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::rt::AppHandle;
use crate::{
    actions,
    audio::{self, Gap, Input, Sound},
    capture::{self, Rect},
    commands::{SettingsState, lock},
    ffmpeg::{self, Video, VideoSpec},
    frame_overlays::Overlays,
    frames::{self, FrameSource, Grabbed},
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
/// Ends the name of the sound sidecar beside an MP4 recorded with the
/// microphone: each source of its sound, unmixed.
pub const SOUND_SUFFIX: &str = ".sound.m4a";
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

/// How often a paused recording checks whether it should go on.
const PAUSE_POLL: Duration = Duration::from_millis(20);

/// What the recording toolbar can change while a recording runs, shared
/// with the thread that records.
#[derive(Debug, Default)]
pub struct Controls {
    stop: AtomicBool,
    /// Throw the recording away once it stops.
    discard: AtomicBool,
    /// Throw it away and start again on the same area once it stops.
    restart: AtomicBool,
    paused: AtomicBool,
    microphone_muted: AtomicBool,
    system_muted: AtomicBool,
    /// How loud the microphone is, once it has started.
    meter: Mutex<Option<audio::Meter>>,
}

impl Controls {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Whether `input` is muted on the toolbar.
    fn muted(&self, input: &Input) -> bool {
        match input {
            Input::Microphone(_) => self.microphone_muted.load(Ordering::SeqCst),
            Input::System => self.system_muted.load(Ordering::SeqCst),
        }
    }

    /// Waits while paused and not stopped. Returns how long it waited.
    fn wait_while_paused(&self) -> Duration {
        let began = Instant::now();
        while self.paused() && !self.stopped() {
            std::thread::sleep(PAUSE_POLL);
        }
        began.elapsed()
    }
}

/// Where a recording is in its life, as the toolbar shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Counting down to the first frame.
    Countdown,
    Recording,
    /// Stopped, and finishing the file.
    Saving,
}

/// What the recording toolbar shows. Mirrors `BarStatus` in
/// src/recordbar/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BarStatus {
    pub phase: Phase,
    /// Milliseconds since the Unix epoch when the countdown ends.
    pub countdown_ends_at: Option<u64>,
    /// Milliseconds since the Unix epoch when the first frame was grabbed.
    pub started_at: Option<u64>,
    /// How long the recording has been paused, before the pause under way.
    pub paused_ms: u64,
    /// When the pause under way began, if it is paused.
    pub paused_at: Option<u64>,
    /// A GIF stops by itself after this many seconds; an MP4 has no limit.
    pub max_seconds: Option<u64>,
    pub format: RecordingFormat,
    /// Whether the microphone is muted, when it is recorded at all.
    pub microphone: Option<bool>,
    /// Whether the system sound is muted, when it is recorded at all.
    pub system: Option<bool>,
    /// Whether the webcam bubble is showing.
    pub webcam: bool,
}

/// What an agent's recording (`grab-it record`) asks for in place of the
/// settings: its format, frame rate and pointer, with no sound, webcam,
/// countdown, clicks or keystrokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentOptions {
    pub format: RecordingFormat,
    /// An MP4's frames a second: one of [`crate::settings::RECORDING_FPS`].
    pub fps: u32,
    pub show_cursor: bool,
}

impl AgentOptions {
    /// `settings` with these options in place of the user's.
    pub fn apply(&self, settings: RecordingSettings) -> RecordingSettings {
        RecordingSettings {
            format: self.format,
            fps: self.fps,
            show_cursor: self.show_cursor,
            show_clicks: false,
            show_keystrokes: false,
            audio: crate::settings::RecordingAudio::None,
            show_webcam: false,
            countdown: 0,
            ..settings
        }
    }
}

/// A recording that was saved: what `grab-it stop` and `grab-it record
/// --for` print.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub format: RecordingFormat,
    /// The Library item's id, when an agent's recording was added.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
}

/// The recording under way: what it records, its controls and what the
/// toolbar shows of it.
pub struct Session {
    controls: Arc<Controls>,
    monitor: MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    recording: RecordingSettings,
    status: Mutex<BarStatus>,
    /// The file it is written to.
    path: PathBuf,
    /// Set when an agent started it: it is then tagged agent and told in a
    /// notice, not on the Quick Access card.
    agent: Option<AgentOptions>,
    /// How it ended, once it has: saved, or why not.
    outcome: Mutex<Option<Result<Finished, String>>>,
    ended: Condvar,
}

impl Session {
    /// What the toolbar shows now.
    pub fn status(&self) -> BarStatus {
        lock_status(&self.status).clone()
    }

    /// The file the recording is written to.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What it is written as: an MP4, or a GIF.
    pub fn format(&self) -> RecordingFormat {
        lock_status(&self.status).format
    }

    /// Asks this recording to finish. A recording still counting down has
    /// nothing to keep, so it is dropped.
    pub fn request_stop(&self, app: &AppHandle) {
        let counting = self.status().phase == Phase::Countdown;
        if counting {
            self.controls.discard.store(true, Ordering::SeqCst);
        }
        self.controls.stop.store(true, Ordering::SeqCst);
        // Unpaused, so a paused recording finishes at once.
        self.controls.paused.store(false, Ordering::SeqCst);
        self.update(app, |status| status.phase = Phase::Saving);
    }

    /// Waits up to `timeout` for the recording to end, and says how it did;
    /// None when it is still going.
    pub fn wait(&self, timeout: Duration) -> Option<Result<Finished, String>> {
        let outcome = self
            .outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (outcome, _) = self
            .ended
            .wait_timeout_while(outcome, timeout, |outcome| outcome.is_none())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        outcome.clone()
    }

    /// Says how the recording ended, to whoever waits for it.
    fn end(&self, outcome: Result<Finished, String>) {
        *self
            .outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(outcome);
        self.ended.notify_all();
    }

    /// Changes what the toolbar shows and tells it.
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut BarStatus)) {
        let status = {
            let mut status = lock_status(&self.status);
            change(&mut status);
            status.clone()
        };
        crate::record_bar::changed(app, &status);
    }
}

fn lock_status(status: &Mutex<BarStatus>) -> MutexGuard<'_, BarStatus> {
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The recording under way, if any.
#[derive(Default)]
pub struct RecordState(Mutex<Option<Arc<Session>>>);

impl RecordState {
    fn lock(&self) -> MutexGuard<'_, Option<Arc<Session>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The recording under way, if any.
pub fn session(app: &AppHandle) -> Option<Arc<Session>> {
    app.try_state::<RecordState>()
        .and_then(|state| state.lock().clone())
}

/// Asks the recording under way to finish. False when there is none. A
/// recording still counting down has nothing to keep, so it is dropped.
pub fn stop(app: &AppHandle) -> bool {
    let Some(session) = session(app) else {
        return false;
    };
    session.request_stop(app);
    true
}

/// Stops the recording under way and waits, briefly, for its file to be
/// finished. Returns at once when nothing is recording.
pub fn stop_and_wait(app: &AppHandle) {
    if !stop(app) {
        return;
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if session(app).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
#[specta::specta]
pub fn record_stop(app: AppHandle) {
    stop(&app);
}

/// Pauses the recording under way, or carries it on.
#[tauri::command]
#[specta::specta]
pub fn record_pause(paused: bool, app: AppHandle) {
    let Some(session) = session(&app) else {
        return;
    };
    if session.status().phase != Phase::Recording {
        return;
    }
    let was = session.controls.paused.swap(paused, Ordering::SeqCst);
    if was == paused {
        return;
    }
    let now = now_ms();
    session.update(&app, |status| {
        if paused {
            status.paused_at = Some(now);
        } else if let Some(at) = status.paused_at.take() {
            status.paused_ms += now.saturating_sub(at);
        }
    });
}

/// Which sound the toolbar mutes. Mirrors `MutedInput` in
/// src/recordbar/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MutedInput {
    Microphone,
    System,
}

/// Mutes the microphone or the system sound of the recording under way,
/// or turns it back on: silence is recorded in its place meanwhile.
#[tauri::command]
#[specta::specta]
pub fn record_mute(input: MutedInput, muted: bool, app: AppHandle) {
    let Some(session) = session(&app) else {
        return;
    };
    let flag = match input {
        MutedInput::Microphone => &session.controls.microphone_muted,
        MutedInput::System => &session.controls.system_muted,
    };
    flag.store(muted, Ordering::SeqCst);
    session.update(&app, |status| {
        let shown = match input {
            MutedInput::Microphone => &mut status.microphone,
            MutedInput::System => &mut status.system,
        };
        if shown.is_some() {
            *shown = Some(muted);
        }
    });
}

/// Shows or hides the webcam bubble of the recording under way.
#[tauri::command]
#[specta::specta]
pub fn record_webcam(shown: bool, app: AppHandle) {
    let Some(session) = session(&app) else {
        return;
    };
    // Opening a window waits on the main thread.
    std::thread::spawn(move || {
        if shown {
            crate::webcam::open(
                &app,
                &session.monitor,
                session.image_size,
                session.rect,
                &session.recording,
            );
        } else {
            crate::webcam::close(&app);
        }
        session.update(&app, |status| status.webcam = shown);
    });
}

/// Throws the recording under way away.
#[tauri::command]
#[specta::specta]
pub fn record_discard(app: AppHandle) {
    if let Some(session) = session(&app) {
        session.controls.discard.store(true, Ordering::SeqCst);
    }
    stop(&app);
}

/// Throws the recording under way away and starts again on the same area.
#[tauri::command]
#[specta::specta]
pub fn record_restart(app: AppHandle) {
    if let Some(session) = session(&app) {
        session.controls.restart.store(true, Ordering::SeqCst);
    }
    stop(&app);
}

/// What the recording toolbar shows, or None when nothing is recording.
#[tauri::command]
#[specta::specta]
pub fn record_bar_status(app: AppHandle) -> Option<BarStatus> {
    session(&app).map(|session| session.status())
}

/// How loud the microphone has been since this was last asked, from 0 to
/// 1, or None when it is not being recorded.
#[tauri::command]
#[specta::specta]
pub fn record_bar_level(app: AppHandle) -> Option<f32> {
    let session = session(&app)?;
    let meter = session
        .controls
        .meter
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()?;
    Some(meter.take())
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

pub fn unique_recording_path(
    dir: &Path,
    time: &DateTime<Local>,
    format: RecordingFormat,
) -> PathBuf {
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
/// frame is always grabbed soon and the video keeps moving. Each stretch
/// dropped is kept as a [`Gap`], so the same stretch can be cut out of the
/// sound, which does not skip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pacer {
    fps: u64,
    /// Frames written so far, repeats included.
    frames: u64,
    /// Frame times dropped because the recording fell too far behind.
    dropped: u64,
    /// Where those frame times were, from the recording's start.
    gaps: Vec<Gap>,
}

const NANOS_PER_SECOND: u128 = 1_000_000_000;

impl Pacer {
    pub fn new(fps: u32) -> Self {
        Self {
            fps: u64::from(fps.max(1)),
            frames: 0,
            dropped: 0,
            gaps: Vec::new(),
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
        let dropped = behind - repeats;
        if dropped > 0 {
            // The dropped frame times follow this frame's repeats.
            let first = self.frames + repeats + self.dropped;
            self.gaps.push(Gap {
                start: self.at(first),
                length: self.at(first + dropped) - self.at(first),
            });
        }
        self.dropped += dropped;
        repeats
    }

    /// Skips the frame times that went by during a pause that ended
    /// `elapsed` after the recording started, keeping them as a [`Gap`] so
    /// the same stretch is cut out of the sound.
    pub fn resume(&mut self, elapsed: Duration) {
        let current = (elapsed.as_nanos() * u128::from(self.fps) / NANOS_PER_SECOND) as u64;
        let next = self.frames + self.dropped;
        if current <= next {
            return;
        }
        self.gaps.push(Gap {
            start: self.at(next),
            length: self.at(current) - self.at(next),
        });
        self.dropped += current - next;
    }

    /// The stretches of the recording the video skipped, in order.
    pub fn gaps(&self) -> &[Gap] {
        &self.gaps
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
    /// The sources the MP4's sound holds, in the order of the sound
    /// sidecar's streams: empty when it is silent, its sound having
    /// failed. Absent in recordings made before sources were kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<Vec<SoundSource>>,
    /// Whether background noise was removed from the microphone in the
    /// MP4's sound. Its sound sidecar is never filtered. Absent when it
    /// was not, and in recordings made before it could be.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub remove_noise: bool,
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
            audio: None,
            remove_noise: false,
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

/// The sound sidecar of a recording: `<name>.mp4` gives
/// `<name>.sound.m4a`.
pub fn sound_path(video: &Path) -> PathBuf {
    capture::sidecar_path(video, SOUND_SUFFIX)
}

/// One source of a recording's sound, as `<name>.cursor.json`'s `audio`
/// names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundSource {
    Microphone,
    System,
}

impl SoundSource {
    fn of(input: &Input) -> Self {
        match input {
            Input::Microphone(_) => Self::Microphone,
            Input::System => Self::System,
        }
    }
}

/// Why a recording cannot start while a step capture runs.
pub const STEPS_RUNNING: &str = "Stop the step capture before recording.";

/// Refuses a recording while a step capture is under way: both watch
/// clicks through input.rs's one listener, and a recording ending would
/// disconnect it from the step capture.
fn refuse_during_steps(steps_running: bool) -> Result<(), crate::scroll::StartError> {
    if steps_running {
        Err(crate::scroll::StartError::Failed(STEPS_RUNNING.to_owned()))
    } else {
        Ok(())
    }
}

/// What a recording is written as.
enum Output {
    Gif,
    Mp4(ffmpeg::Ready),
}

/// Starts recording `rect` of `monitor`. `rect` is in the pixels of the
/// monitor's image, whose size is `image_size`. Counts down first when
/// the settings say so, then runs until [`stop`], or for a GIF
/// [`MAX_DURATION`] of recording time. Call this off the main thread.
pub fn start(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
) -> Result<(), crate::scroll::StartError> {
    start_with(app, monitor, image_size, rect, None).map(|_| ())
}

/// [`start`], with `agent`'s options in place of the settings' format,
/// frame rate, pointer, sound, webcam and countdown when an agent asked
/// for the recording. Returns the recording under way.
pub fn start_with(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    agent: Option<AgentOptions>,
) -> Result<Arc<Session>, crate::scroll::StartError> {
    let _gate = crate::scroll::start_lock();
    crate::scroll::ensure_idle(session(app).is_some(), crate::scroll::active(app))?;
    refuse_during_steps(crate::steps::is_running())?;
    let (folder, recording) = {
        let state = app.state::<SettingsState>();
        let store = lock(&state);
        let settings = store.get();
        let recording = settings.recording.clone();
        (
            settings.save_folder.join(RECORDINGS_DIR),
            match agent {
                Some(options) => options.apply(recording),
                None => recording,
            },
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
    let path = fs::create_dir_all(&folder)
        .map(|()| unique_recording_path(&folder, &started, format))
        .map_err(|err| format!("could not create {}: {err}", folder.display()))?;
    let session = Arc::new(Session {
        controls: Arc::new(Controls::default()),
        monitor: monitor.clone(),
        image_size,
        rect,
        recording: recording.clone(),
        status: Mutex::new(BarStatus {
            phase: if recording.countdown > 0 {
                Phase::Countdown
            } else {
                Phase::Recording
            },
            countdown_ends_at: None,
            started_at: None,
            paused_ms: 0,
            paused_at: None,
            max_seconds: match format {
                RecordingFormat::Gif => Some(MAX_DURATION.as_secs()),
                RecordingFormat::Mp4 => None,
            },
            format,
            microphone: None,
            system: None,
            webcam: recording.show_webcam,
        }),
        path: path.clone(),
        agent,
        outcome: Mutex::new(None),
        ended: Condvar::new(),
    });
    let state = app.state::<RecordState>();
    {
        let mut current = state.lock();
        if current.is_some() {
            return Err(crate::scroll::StartError::Busy);
        }
        *current = Some(Arc::clone(&session));
    }
    crate::tray::set_recording(app, true);

    // Only an MP4 has sound. macOS asks for the microphone first, the
    // first time; the recording waits for the answer.
    let mp4 = format == RecordingFormat::Mp4;
    let microphone = mp4 && recording.audio.microphone();
    // Without the model the microphone is kept as it was heard.
    let noise_model = if microphone && recording.remove_noise {
        crate::noise::bundled_model(app)
    } else {
        None
    };
    let system = mp4 && recording.audio.system();
    let mut inputs = Vec::new();
    let mut refused = Vec::new();
    if microphone {
        if crate::permissions::ensure_microphone(app) {
            inputs.push(Input::Microphone(recording.microphone.clone()));
        } else {
            refused.push((
                Input::Microphone(None).what(),
                "Grab-it may not use the microphone".to_owned(),
            ));
        }
    }
    if system {
        if audio::system_available() {
            inputs.push(Input::System);
        } else {
            refused.push((
                Input::System.what(),
                "it needs macOS 13 or later".to_owned(),
            ));
        }
    }
    {
        let mut status = lock_status(&session.status);
        status.microphone = inputs
            .iter()
            .any(|input| matches!(input, Input::Microphone(_)))
            .then_some(false);
        status.system = inputs.contains(&Input::System).then_some(false);
    }
    // What was refused is told on the card with whatever else fails, once
    // the recording knows what sound it kept (see `record_mp4`).

    // Clicks and keys are watched through global input hooks, which macOS
    // only allows with Input Monitoring.
    let wants_input = recording.show_clicks || recording.show_keystrokes;
    let input_allowed = wants_input && crate::permissions::ensure_input_monitoring(app);
    if wants_input && !input_allowed && fallback.is_none() {
        fallback = Some(
            "Saved without clicks or keystrokes: Grab-it may not watch the mouse and keyboard."
                .to_owned(),
        );
    }
    if recording.countdown > 0 {
        let ends = now_ms() + u64::from(recording.countdown) * 1000;
        lock_status(&session.status).countdown_ends_at = Some(ends);
    }
    crate::record_bar::show(app, monitor, image_size, rect, &session.status());
    crate::record_frame::show(
        app,
        monitor,
        image_size,
        rect,
        crate::record_frame::shape_for(rect, image_size, recording.source),
    );
    // Opened before the countdown and the settle delay, so the camera has
    // started by the first frame.
    if recording.show_webcam {
        crate::webcam::open(app, monitor, image_size, rect, &recording);
    }

    let handle = app.clone();
    let recorder = Arc::clone(&session);
    let spawned = std::thread::Builder::new()
        .name("grab-it-record".into())
        .spawn(move || {
            let session = recorder;
            let controls = Arc::clone(&session.controls);
            let counted = count_down(&controls, recording.countdown);
            let result = if counted {
                // The overlay was closed a moment ago; give the desktop time
                // to repaint so the first frame shows the screen, not the
                // overlay.
                std::thread::sleep(SETTLE_DELAY);
                session.update(&handle, |status| {
                    status.phase = if controls.stopped() {
                        Phase::Saving
                    } else {
                        Phase::Recording
                    };
                    status.countdown_ends_at = None;
                    status.started_at = Some(now_ms());
                });
                // Started after the settle delay, so the click that chose
                // the area is not shown.
                let mut overlays = if input_allowed {
                    Overlays::start(
                        recording.show_clicks,
                        recording.show_keystrokes,
                        session.monitor.scale_factor,
                    )
                } else {
                    Overlays::none()
                };
                let monitor = &session.monitor;
                let result = match &output {
                    Output::Gif => frames::open(monitor, rect, GIF_FPS, recording.show_cursor)
                        .and_then(|mut source| {
                            record_gif(source.as_mut(), &path, &controls, &mut overlays)
                        })
                        .map(|duration| (duration, None)),
                    Output::Mp4(ready) => {
                        frames::open(monitor, rect, recording.fps, recording.show_cursor).and_then(
                            |mut source| {
                                record_mp4(
                                    source.as_mut(),
                                    &path,
                                    &controls,
                                    ready,
                                    &recording,
                                    inputs,
                                    refused,
                                    noise_model.as_deref(),
                                    &mut overlays,
                                )
                            },
                        )
                    }
                };
                // Stops collecting clicks and keys.
                drop(overlays);
                Some(result)
            } else {
                None
            };
            crate::webcam::close(&handle);
            *handle.state::<RecordState>().lock() = None;
            crate::tray::set_recording(&handle, false);
            let restart = controls.restart.load(Ordering::SeqCst);
            let discard = restart || controls.discard.load(Ordering::SeqCst);
            if !restart {
                crate::record_bar::close(&handle);
                crate::record_frame::close(&handle);
            }
            let outcome = match result {
                // Stopped during the countdown: nothing was recorded.
                None => Err("the recording was stopped before it began".to_owned()),
                Some(Ok(_)) if discard => {
                    remove_recording(&path);
                    Err(if restart {
                        "the recording was restarted from its toolbar".to_owned()
                    } else {
                        "the recording was discarded".to_owned()
                    })
                }
                Some(Ok((duration, _))) if session.agent.is_some() => {
                    let duration_ms = duration.as_millis() as u64;
                    let id = crate::agent::add_recording(&handle, &path, duration_ms);
                    Ok(Finished {
                        path: path.clone(),
                        duration_ms,
                        format,
                        id,
                    })
                }
                Some(Ok((duration, note))) => {
                    crate::library::record_recording(&handle, &path, duration.as_millis() as u64);
                    let bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                    quick::show(
                        &handle,
                        QuickItem::Recorded {
                            file_name: path
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                                .unwrap_or_default(),
                            path: path.clone(),
                            duration_ms: duration.as_millis() as u64,
                            bytes,
                            format,
                            fallback: fallback.or(note),
                        },
                    );
                    Ok(Finished {
                        path: path.clone(),
                        duration_ms: duration.as_millis() as u64,
                        format,
                        id: None,
                    })
                }
                Some(Err(err)) => {
                    remove_recording(&path);
                    let message = format!("the recording failed: {err}");
                    if !restart {
                        actions::report_failure(&handle, &message);
                    }
                    Err(message)
                }
            };
            session.end(outcome);
            if restart
                && let Err(err) = start_with(
                    &handle,
                    &session.monitor,
                    session.image_size,
                    session.rect,
                    session.agent,
                )
            {
                crate::record_bar::close(&handle);
                crate::record_frame::close(&handle);
                crate::scroll::report_start_failure(err, |message| {
                    actions::report_failure(&handle, message)
                });
            }
        });
    if let Err(err) = spawned {
        crate::webcam::close(app);
        crate::record_bar::close(app);
        crate::record_frame::close(app);
        *state.lock() = None;
        crate::tray::set_recording(app, false);
        return Err(format!("could not start recording: {err}").into());
    }
    Ok(session)
}

/// Waits `seconds` before a recording starts. False when it was stopped
/// meanwhile, so there is nothing to record.
fn count_down(controls: &Controls, seconds: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(u64::from(seconds));
    while Instant::now() < deadline {
        if controls.stopped() {
            return false;
        }
        std::thread::sleep(PAUSE_POLL);
    }
    !controls.stopped()
}

/// Deletes a recording thrown away, with its pointer and sound sidecars.
fn remove_recording(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(cursor_path(path));
    let _ = fs::remove_file(sound_path(path));
}

/// What the card says when a recording was saved without its sound.
fn no_sound(why: &str) -> String {
    format!("Saved without sound: {why}.")
}

/// What the card says about the sound that `failed`, each by what it is
/// and why: nothing when nothing failed, that there is no sound when
/// nothing was `kept` either, or which sound is missing.
fn sound_note(kept: bool, failed: &[(&str, String)]) -> Option<String> {
    let (what, why) = failed.first()?;
    Some(if kept {
        format!("Saved without {what}: {why}.")
    } else {
        no_sound(why)
    })
}

/// What the card says about a recording's sound once it is muxed in:
/// every sound in `failed` (refused before the recording, or failed
/// during it), told against whether any sound was `kept`; and when the
/// kept sound could not be muxed in, that the video is silent.
fn final_note(failed: &[(&str, String)], kept: bool, muxed: Result<(), String>) -> Option<String> {
    match muxed {
        Err(err) if kept => Some(no_sound(&err)),
        _ => sound_note(kept, failed),
    }
}

/// Grabs frames into the MP4 at `path` until `stop` is set, at a constant
/// frame rate: a frame time that goes by while a grab is under way
/// repeats the frame before. Draws `overlays` into each frame grabbed.
/// Saves where the pointer was beside it, and muxes in the sound of
/// `inputs`, mixed into one track when there are two. With the
/// microphone, each source is also kept unmixed in the sound sidecar.
/// With `noise_model`, background noise is removed from the microphone
/// in the MP4 with that RNNoise model, though not in the sound sidecar.
/// `refused` is the
/// sound that was not allowed or not available, by what it is and why.
/// Returns how long the video runs, and why it is missing sound when some
/// was refused or failed.
#[allow(clippy::too_many_arguments)]
fn record_mp4(
    source: &mut dyn FrameSource,
    path: &Path,
    controls: &Controls,
    ready: &ffmpeg::Ready,
    recording: &RecordingSettings,
    inputs: Vec<Input>,
    refused: Vec<(&'static str, String)>,
    noise_model: Option<&Path>,
    overlays: &mut Overlays,
) -> Result<(Duration, Option<String>), String> {
    // What was refused or failed, and why.
    let mut failed: Vec<(&str, String)> = refused;
    // Started before the first grab, so the sound covers the first frame;
    // what it heard before that frame is cut when it is muxed in. Dropped
    // on an early return, which stops them and deletes their WAVs.
    let sounds: Vec<Sound> = inputs
        .into_iter()
        .filter_map(|input| {
            let what = input.what();
            match Sound::start(&ready.path, input) {
                Ok(sound) => Some(sound),
                Err(err) => {
                    eprintln!("Grab-it: recording without {what}: {err}");
                    failed.push((what, err));
                    None
                }
            }
        })
        .collect();
    if let Some(sound) = sounds
        .iter()
        .find(|sound| matches!(sound.input(), Input::Microphone(_)))
    {
        *controls
            .meter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sound.meter());
    }
    let mute = |sounds: &[Sound]| {
        for sound in sounds {
            sound.set_muted(controls.muted(sound.input()));
        }
    };
    mute(&sounds);
    let Grabbed {
        image: mut frame,
        mut pointer,
    } = source.grab()?;
    overlays.apply(&mut frame, pointer, Instant::now());
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
            if controls.stopped() {
                break;
            }
            video.write(&frame).map_err(|err| err.to_string())?;
            pacer.repeated();
            track.push(pointer, 1);
        }
        if controls.stopped() {
            break;
        }
        if controls.paused() {
            // The sound runs on meanwhile: the pause is cut out of it as
            // a gap, as a stretch the video dropped is.
            controls.wait_while_paused();
            pacer.resume(started.elapsed());
            if controls.stopped() {
                break;
            }
        }
        mute(&sounds);
        let due = started + pacer.next_frame_at();
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        }
        (frame, pointer) = match source.grab() {
            Ok(Grabbed { mut image, pointer }) if image.dimensions() == input => {
                overlays.apply(&mut image, pointer, Instant::now());
                (image, pointer)
            }
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
    // Each sound that was heard, and when it starts against the first frame.
    let mut captured = Vec::new();
    for sound in sounds {
        let what = sound.what();
        let source = SoundSource::of(sound.input());
        let prepared = sound.stop().and_then(|sound| {
            let offset = audio::offset(started, sound.first_sample);
            // The sound runs on through the frame times the video dropped:
            // cut them out of it too, or it would run ahead of the video.
            sound
                .cut(pacer.gaps(), offset)
                .map_err(|err| format!("could not cut the sound to the video: {err}"))?;
            Ok((source, sound, offset))
        });
        match prepared {
            Ok(track) => captured.push(track),
            Err(err) => {
                eprintln!("Grab-it: the recording is without {what}: {err}");
                failed.push((what, err));
            }
        }
    }
    // In the sound sidecar's stream order: the microphone first.
    captured.sort_by_key(|(source, _, _)| *source);
    let sources: Vec<SoundSource> = captured.iter().map(|(source, _, _)| *source).collect();
    let kept = !captured.is_empty();
    let muxed = if kept {
        let tracks: Vec<ffmpeg::AudioTrack<'_>> = captured
            .iter()
            .map(|(source, sound, offset)| ffmpeg::AudioTrack {
                wav: &sound.wav,
                offset: *offset,
                microphone: *source == SoundSource::Microphone,
            })
            .collect();
        // The video is kept, silent.
        let muxed = ffmpeg::add_audio(&ready.path, path, &tracks, noise_model, pacer.duration())
            .map_err(|err| {
                eprintln!("Grab-it: the recording has no sound: {err}");
                err.to_string()
            });
        // Written from the same WAVs before they are dropped. The video
        // is fine without it: its sound is then only the mixed track.
        if muxed.is_ok()
            && sources.contains(&SoundSource::Microphone)
            && let Err(err) =
                ffmpeg::write_sound(&ready.path, &tracks, pacer.duration(), &sound_path(path))
        {
            eprintln!("Grab-it: no sound sidecar: {err}");
        }
        muxed
    } else {
        Ok(())
    };
    track.remove_noise =
        muxed.is_ok() && noise_model.is_some() && sources.contains(&SoundSource::Microphone);
    track.audio = Some(if muxed.is_ok() { sources } else { Vec::new() });
    let note = final_note(&failed, kept, muxed);
    // The video is fine without it.
    if let Err(err) = track.save(path) {
        eprintln!("Grab-it: no pointer sidecar: {err}");
    }
    Ok((pacer.duration(), note))
}

/// Grabs frames into the GIF at `path` until `stop` is set or the time is
/// up, drawing `overlays` into each. Returns how long the recording runs.
fn record_gif(
    source: &mut dyn FrameSource,
    path: &Path,
    controls: &Controls,
    overlays: &mut Overlays,
) -> Result<Duration, String> {
    let file = File::create(path).map_err(|err| format!("could not create the file: {err}"))?;
    let mut encoder = GifEncoder::new_with_speed(BufWriter::new(file), QUANTISER_SPEED);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|err| err.to_string())?;

    // Moved on by each pause, so a pause does not count towards the limit.
    let mut started = Instant::now();
    // Each frame is shown until the next one was grabbed, so the GIF plays
    // back in real time even when a frame took longer than the interval.
    let mut pending: Option<(RgbaImage, Instant)> = None;
    let mut total = Duration::ZERO;
    loop {
        let grabbed_at = Instant::now();
        let frame = match grab(source, overlays) {
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

        if controls.paused() {
            // The frame before the pause is shown only as long as it was
            // on screen before it.
            let paused = controls.wait_while_paused();
            started += paused;
            if let Some((_, since)) = pending.as_mut() {
                *since += paused;
            }
        }
        if controls.stopped() || started.elapsed() >= MAX_DURATION {
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

/// The recorded area with `overlays` drawn in, scaled down for a GIF.
fn grab(source: &mut dyn FrameSource, overlays: &mut Overlays) -> Result<RgbaImage, String> {
    let Grabbed {
        image: mut cropped,
        pointer,
    } = source.grab()?;
    overlays.apply(&mut cropped, pointer, Instant::now());
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
    fn a_recording_is_refused_while_a_step_capture_runs() {
        assert_eq!(
            refuse_during_steps(true),
            Err(crate::scroll::StartError::Failed(STEPS_RUNNING.to_owned()))
        );
        assert_eq!(refuse_during_steps(false), Ok(()));
    }

    #[test]
    fn an_agents_options_replace_the_settings_with_no_sound_webcam_or_countdown() {
        let settings = RecordingSettings {
            format: RecordingFormat::Gif,
            fps: 30,
            show_cursor: false,
            show_clicks: true,
            show_keystrokes: true,
            audio: crate::settings::RecordingAudio::Both,
            show_webcam: true,
            countdown: 5,
            ..RecordingSettings::default()
        };
        let options = AgentOptions {
            format: RecordingFormat::Mp4,
            fps: 60,
            show_cursor: true,
        };
        let applied = options.apply(settings.clone());
        assert_eq!(applied.format, RecordingFormat::Mp4);
        assert_eq!(applied.fps, 60);
        assert!(applied.show_cursor);
        assert!(!applied.show_clicks && !applied.show_keystrokes && !applied.show_webcam);
        assert_eq!(applied.audio, crate::settings::RecordingAudio::None);
        assert_eq!(applied.countdown, 0);
        // What the agent does not choose is the user's.
        assert_eq!(applied.quality, settings.quality);
        assert_eq!(applied.webcam_shape, settings.webcam_shape);
    }

    #[test]
    fn a_finished_recording_is_a_json_line() {
        let finished = Finished {
            path: PathBuf::from("/p/recordings/Grab-it.mp4"),
            duration_ms: 5021,
            format: RecordingFormat::Mp4,
            id: Some(4),
        };
        assert_eq!(
            serde_json::to_string(&finished).unwrap(),
            r#"{"path":"/p/recordings/Grab-it.mp4","durationMs":5021,"format":"mp4","id":4}"#
        );
    }

    #[test]
    fn the_card_says_which_sound_is_missing() {
        assert_eq!(sound_note(true, &[]), None);
        assert_eq!(sound_note(false, &[]), None);
        let mic = [("the microphone", "it was unplugged".to_owned())];
        assert_eq!(
            sound_note(true, &mic).as_deref(),
            Some("Saved without the microphone: it was unplugged.")
        );
        assert_eq!(
            sound_note(false, &mic).as_deref(),
            Some("Saved without sound: it was unplugged.")
        );
    }

    #[test]
    fn a_refused_sound_is_told_with_the_one_that_failed_during_the_recording() {
        let refused = (
            "the microphone",
            "Grab-it may not use the microphone".to_owned(),
        );
        let failed = (
            "the system sound",
            "the computer played no sound".to_owned(),
        );
        // Both are missing: the MP4 is silent, whichever was refused.
        assert_eq!(
            final_note(&[refused.clone(), failed.clone()], false, Ok(())).as_deref(),
            Some("Saved without sound: Grab-it may not use the microphone.")
        );
        // Refused, and the other kept.
        assert_eq!(
            final_note(std::slice::from_ref(&refused), true, Ok(())).as_deref(),
            Some("Saved without the microphone: Grab-it may not use the microphone.")
        );
        // Refused, and the other could not be muxed in: silent too.
        assert_eq!(
            final_note(
                std::slice::from_ref(&refused),
                true,
                Err("it exited with 1".to_owned())
            )
            .as_deref(),
            Some("Saved without sound: it exited with 1.")
        );
        // Nothing refused or failed, and the sound is in.
        assert_eq!(final_note(&[], true, Ok(())), None);
        // No sound was wanted at all.
        assert_eq!(final_note(&[], false, Ok(())), None);
    }

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
    fn a_pause_is_skipped_in_the_video_and_kept_as_a_gap_for_the_sound() {
        let mut pacer = Pacer::new(30);
        // A second of frames, on time.
        for frame in 0..30u64 {
            let elapsed = Duration::from_nanos(frame * 1_000_000_000 / 30);
            assert_eq!(pacer.wrote_frame(elapsed), 0);
        }
        assert_eq!(pacer.next_frame_at(), Duration::from_secs(1));
        // Paused from 1 s until 3 s.
        pacer.resume(Duration::from_secs(3));
        assert_eq!(
            pacer.gaps(),
            &[Gap {
                start: Duration::from_secs(1),
                length: Duration::from_secs(2),
            }]
        );
        // The next frame is due at once, and nothing is repeated for the pause.
        assert_eq!(pacer.next_frame_at(), Duration::from_secs(3));
        assert_eq!(pacer.wrote_frame(Duration::from_secs(3)), 0);
        assert_eq!(
            pacer.duration(),
            Duration::from_nanos(31 * 1_000_000_000 / 30)
        );
        // A pause shorter than a frame skips nothing.
        let mut short = Pacer::new(30);
        short.wrote_frame(Duration::ZERO);
        short.resume(Duration::from_millis(10));
        assert!(short.gaps().is_empty());
    }

    #[test]
    fn dropped_frame_times_are_kept_as_gaps_for_the_sound() {
        let mut pacer = Pacer::new(10);
        let ms = Duration::from_millis;
        assert_eq!(pacer.wrote_frame(ms(10)), 0);
        assert!(pacer.gaps().is_empty());
        // The second grab took until 1.25 s: frame times 2 to 11 went by.
        // Five are repeats (half a second); 7 to 11 are dropped.
        let repeats = pacer.wrote_frame(ms(1250));
        assert_eq!(repeats, 5);
        for _ in 0..repeats {
            pacer.repeated();
        }
        assert_eq!(
            pacer.gaps(),
            [Gap {
                start: ms(700),
                length: ms(500),
            }]
        );
        assert_eq!(pacer.next_frame_at(), ms(1200));
        assert_eq!(pacer.wrote_frame(ms(1210)), 0);
        // The video plays 0.8 s; with the gap, 1.3 s of sound went by.
        assert_eq!(pacer.duration(), ms(800));
        assert_eq!(pacer.duration() + pacer.gaps()[0].length, ms(1300));
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
    fn the_sound_sidecar_sits_beside_the_video() {
        assert_eq!(
            sound_path(Path::new(
                "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4"
            )),
            PathBuf::from("/shots/recordings/Grab-it 2026-03-07 09-05-01.sound.m4a")
        );
    }

    #[test]
    fn the_sound_sources_are_saved_in_stream_order_and_absent_before() {
        let spec = VideoSpec {
            input: (640, 360),
            output: (640, 360),
            fps: 30,
            bits_per_pixel: 0.2,
        };
        let json = |track: &CursorTrack| serde_json::to_value(track).unwrap();
        let mut track = CursorTrack::new(&spec);
        // Not set: no `audio` at all, as recordings made before it read.
        assert!(json(&track).get("audio").is_none());
        track.audio = Some(vec![SoundSource::Microphone, SoundSource::System]);
        assert_eq!(
            json(&track)["audio"],
            serde_json::json!(["microphone", "system"])
        );
        // A recording whose sound failed holds none.
        track.audio = Some(Vec::new());
        assert_eq!(json(&track)["audio"], serde_json::json!([]));
        // Noise removal is saved only once it ran.
        assert!(json(&track).get("removeNoise").is_none());
        track.remove_noise = true;
        assert_eq!(json(&track)["removeNoise"], true);
        // The microphone sorts first, as the sound sidecar's streams do.
        let mut sources = [SoundSource::System, SoundSource::Microphone];
        sources.sort();
        assert_eq!(sources, [SoundSource::Microphone, SoundSource::System]);
        assert_eq!(
            serde_json::from_str::<Vec<SoundSource>>(r#"["system"]"#).unwrap(),
            [SoundSource::System]
        );
    }

    #[test]
    fn a_thrown_away_recording_takes_its_sidecars_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        for path in [&video, &cursor_path(&video), &sound_path(&video)] {
            fs::write(path, b"x").unwrap();
        }
        remove_recording(&video);
        assert!(!video.exists());
        assert!(!cursor_path(&video).exists());
        assert!(!sound_path(&video).exists());
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
