//! Automatic and manual scrolling capture. Unmatched frames never alter the accepted reference.
use crate::stitch::{Axis, Push, Stitcher};
use image::RgbaImage;
use std::sync::{Mutex, OnceLock};
/// Serializes recording/scroll startup, including their state reservations.
pub fn start_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// A busy rejection must not replace the bar controlling an existing session.
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Busy,
    Failed(String),
}
impl From<String> for StartError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
pub fn ensure_idle(recording: bool, scrolling: bool) -> Result<(), StartError> {
    if recording || scrolling {
        Err(StartError::Busy)
    } else {
        Ok(())
    }
}
pub fn report_start_failure(error: StartError, report: impl FnOnce(&str)) {
    match error {
        StartError::Busy => {
            eprintln!("Grab-it: a recording or scrolling capture is already under way")
        }
        StartError::Failed(message) => report(&message),
    }
}

/// Shown when the user chose to scroll by hand.
const BY_HAND: &str = "Scroll at a steady pace, then choose Done.";
/// Shown once the image has reached its length limit.
const CAPPED: &str = "The image has reached its length limit. Choose Done to save it.";
/// Shown by hand while frames cannot be placed.
const TOO_FAST: &str = "Scrolled too fast. Scroll back a little.";

/// A session never resumes synthetic input after yielding to the user.
struct AutoScroll {
    center: (i32, i32),
    /// Image pixels per point, so the Mouse moved rule is 8 points everywhere.
    scale: f64,
    reason: Option<&'static str>,
    still_steps: u8,
    /// Whether a frame after a wheel step ever differed from the one before.
    moved: bool,
}
impl AutoScroll {
    fn new(center: (i32, i32), allowed: bool, scale: f64) -> Self {
        Self {
            center,
            scale: usable_scale(scale),
            reason: (!allowed)
                .then_some("Accessibility permission is needed. Scroll by hand, then choose Done."),
            still_steps: 0,
            moved: false,
        }
    }
    fn observe_pointer(&mut self, pointer: Option<(i32, i32)>) {
        if self.reason.is_none()
            && pointer.is_some_and(|(x, y)| {
                let dx = f64::from(x) - f64::from(self.center.0);
                let dy = f64::from(y) - f64::from(self.center.1);
                let limit = 8.0 * self.scale;
                dx * dx + dy * dy > limit * limit
            })
        {
            self.reason = Some("Mouse moved. Scroll by hand, then choose Done.");
        }
    }
    /// Count only unchanged frames after successful wheel events. Rejected
    /// overlaps can be moving content and must not be mistaken for the end.
    fn at_end(&mut self, unchanged: bool, has_scrolled: bool) -> bool {
        if self.reason.is_some() {
            return false;
        }
        self.moved |= !unchanged;
        self.still_steps = if unchanged { self.still_steps + 1 } else { 0 };
        if self.still_steps < 5 {
            return false;
        }
        if !has_scrolled {
            // Content that moved but never lined up did scroll; saying
            // nothing scrolled would send the user looking for the wrong fault.
            self.reason = Some(if self.moved {
                "The page scrolled, but Grab-it could not join the views. Scroll by hand, then choose Done."
            } else {
                "Nothing scrolled automatically. Scroll by hand, then choose Done."
            });
            return false;
        }
        true
    }
    /// The wheel event for one step of `amount` in the platform's unit
    /// (points on macOS, notches elsewhere), toward content not yet seen.
    fn wheel(&self, axis: Option<Axis>, reverse: Option<bool>, amount: i32) -> rdev::EventType {
        let amount = i64::from(amount.max(1));
        let delta = if reverse == Some(true) {
            amount
        } else {
            -amount
        };
        if axis == Some(Axis::Horizontal) {
            rdev::EventType::Wheel {
                // X11 button 7 and Windows HWHEEL use positive for right;
                // macOS uses negative for right, as it does for down.
                delta_x: if cfg!(target_os = "macos") {
                    delta
                } else {
                    -delta
                },
                delta_y: 0,
            }
        } else {
            rdev::EventType::Wheel {
                delta_x: 0,
                delta_y: delta,
            }
        }
    }
}

/// One automatic step moves a third of the area along the scroll axis, in
/// the area's image pixels. The axis counts as vertical until one is accepted.
/// A third leaves the Stitcher a wide overlap to match.
fn step_pixels(width: u32, height: u32, axis: Option<Axis>) -> u32 {
    let along = if axis == Some(Axis::Horizontal) {
        width
    } else {
        height
    };
    (along / 3).max(1)
}
/// The scale factor, or 1 when a monitor reports none that can divide.
fn usable_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}
/// macOS scrolls in points, which are image pixels over the scale factor.
fn step_points(pixels: u32, scale: f64) -> i32 {
    ((f64::from(pixels) / usable_scale(scale)).round() as i32).max(1)
}
/// Windows and X11 scroll in wheel notches of about 100 logical pixels.
fn step_notches(pixels: u32, scale: f64) -> i32 {
    ((f64::from(pixels) / usable_scale(scale) / 100.0).round() as i32).max(1)
}
/// The step in this platform's own scroll unit.
fn step_amount(pixels: u32, scale: f64) -> i32 {
    if cfg!(target_os = "macos") {
        step_points(pixels, scale)
    } else {
        step_notches(pixels, scale)
    }
}

use crate::rt::AppHandle;
use crate::{
    actions,
    capture::{CaptureMode, Foreground, Rect},
    frames,
    screen::MonitorInfo,
    scroll_bar::{self, ScrollBarState},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::Manager;
#[derive(Default)]
pub struct ScrollState(Mutex<Option<Arc<Control>>>);
struct Control {
    id: u64,
    end: AtomicU8,
}
fn state_lock(state: &ScrollState) -> std::sync::MutexGuard<'_, Option<Arc<Control>>> {
    state.0.lock().unwrap_or_else(|p| p.into_inner())
}
pub fn active(app: &AppHandle) -> bool {
    state_lock(&app.state::<ScrollState>()).is_some()
}
#[tauri::command]
#[specta::specta]
pub fn scroll_done(app: AppHandle, session_id: u64) {
    end(&app, session_id, 1);
}
#[tauri::command]
#[specta::specta]
pub fn scroll_cancel(app: AppHandle, session_id: u64) {
    end(&app, session_id, 2);
}
fn end(app: &AppHandle, id: u64, action: u8) {
    if let Some(c) = state_lock(&app.state::<ScrollState>())
        .as_ref()
        .filter(|c| c.id == id)
    {
        let _ = c
            .end
            .compare_exchange(0, action, Ordering::SeqCst, Ordering::SeqCst);
    }
}
// SetCursorPos accepts signed virtual-desktop coordinates directly, avoiding
// rdev's absolute-input normalization that loses a negative desktop origin.
#[cfg(any(target_os = "windows", test))]
fn desktop_pointer_target(monitor: (i32, i32), offset: (i32, i32)) -> (i32, i32) {
    (monitor.0 + offset.0, monitor.1 + offset.1)
}

fn place_pointer(monitor: &MonitorInfo, offset: (i32, i32)) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (x, y) = desktop_pointer_target((monitor.x, monitor.y), offset);
        // SAFETY: SetCursorPos takes coordinates by value and no pointers.
        unsafe { windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y) }
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // rdev uses desktop points on macOS and pixels on X11.
        let scale = if cfg!(target_os = "macos") {
            monitor.scale_factor
        } else {
            1.0
        };
        rdev::simulate(&rdev::EventType::MouseMove {
            x: monitor.x as f64 + offset.0 as f64 / scale,
            y: monitor.y as f64 + offset.1 as f64 / scale,
        })
        .map_err(|error| format!("{error:?}"))
    }
}

/// Posts one automatic step. rdev's macOS wheel scrolls a single point per
/// unit, so macOS posts a pixel-unit scroll of the whole step itself; rdev
/// sends Windows and X11 one wheel notch per unit.
fn post_wheel(event: &rdev::EventType) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_core_graphics::{
            CGEvent, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGScrollEventUnit,
        };
        let rdev::EventType::Wheel { delta_x, delta_y } = *event else {
            return Err("not a wheel event".into());
        };
        let (Ok(delta_x), Ok(delta_y)) = (i32::try_from(delta_x), i32::try_from(delta_y)) else {
            return Err("scroll step out of range".into());
        };
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .ok_or("could not create an event source")?;
        // As rdev does: wheel 1 is vertical, wheel 2 horizontal.
        let scroll = CGEvent::new_scroll_wheel_event2(
            Some(&source),
            CGScrollEventUnit::Pixel,
            2,
            delta_y,
            delta_x,
            0,
        )
        .ok_or("could not create a scroll event")?;
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&scroll));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        rdev::simulate(event).map_err(|error| format!("{error:?}"))
    }
}

pub fn start(
    app: &AppHandle,
    monitor: &MonitorInfo,
    rect: Rect,
    image_size: (u32, u32),
    foreground: Foreground,
    automatic: bool,
) -> Result<(), StartError> {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return Err(StartError::Failed(
            "scrolling capture is unavailable on Wayland".into(),
        ));
    }
    let _gate = start_lock();
    ensure_idle(crate::record::session(app).is_some(), active(app))?;
    static IDS: AtomicU64 = AtomicU64::new(1);
    let control = Arc::new(Control {
        id: IDS.fetch_add(1, Ordering::Relaxed),
        end: AtomicU8::new(0),
    });
    *state_lock(&app.state::<ScrollState>()) = Some(control.clone());
    let handle = app.clone();
    let monitor = monitor.clone();
    let spawned = std::thread::Builder::new()
        .name("grab-it-scroll".into())
        .spawn(move || {
            let result = (|| -> Result<(), String> {
                std::thread::sleep(Duration::from_millis(250));
                // Checked without a prompt: the guide offered Open Settings
                // before the capture started.
                let allowed = automatic && crate::permissions::accessibility_trusted();
                let center = ((rect.width / 2) as i32, (rect.height / 2) as i32);
                let mut auto = AutoScroll::new(center, allowed, monitor.scale_factor);
                if !automatic {
                    auto.reason = Some(BY_HAND);
                }
                if allowed {
                    if place_pointer(&monitor, (rect.x + center.0, rect.y + center.1)).is_err() {
                        auto.reason = Some("Automatic scrolling is unavailable. Scroll by hand, then choose Done.");
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                // Open after placing the pointer, so buffered video frames cannot
                // report its pre-placement position and falsely pause the session.
                let mut source = frames::open(&monitor, rect, 10, false)?;
                let mut synchronous = frames::open_synchronous(&monitor, rect)?;
                let first = grab_clean(
                    source.as_mut(),
                    synchronous.as_mut(),
                    true,
                    || Ok(()),
                    || Ok(()),
                )?;
                auto.observe_pointer(first.pointer);
                let mut stitch = Stitcher::new(first.image);
                let mut too_fast = false;
                let state = |s: &Stitcher, a: &AutoScroll, too_fast: bool, saving: bool| {
                    let mut state = ScrollBarState::new(control.id, s.image.dimensions(), s.axis);
                    state.capped = s.capped;
                    state.auto_scrolling = a.reason.is_none() && !s.capped;
                    state.message = if s.capped {
                        Some(CAPPED.to_owned())
                    } else if too_fast {
                        Some(TOO_FAST.to_owned())
                    } else {
                        a.reason.map(str::to_owned)
                    };
                    state.saving = saving;
                    state.preview = scroll_bar::preview_url(&s.image, s.axis, s.reverse == Some(true));
                    state
                };
                // Kept out of the frames where the system allows; on X11 it
                // moves outside the area, or with no room hides for each grab.
                let overlaps = scroll_bar::show(&handle, &monitor, rect, image_size, state(&stitch, &auto, too_fast, false))?;
                // The bar may have opened over the area before it was placed:
                // start the video cache only once it is in its place.
                drop(source);
                source = frames::open(&monitor, rect, 10, false)?;
                // The Stitcher starts again from the reader every later frame
                // comes from.
                let use_buffered;
                (stitch, use_buffered) = if overlaps {
                    (stitch, false)
                } else {
                    let (restarted, _, use_buffered) =
                        restart_stitch(source.as_mut(), synchronous.as_mut())?;
                    (restarted, use_buffered)
                };
                let mut wheel_pending = false;
                while control.end.load(Ordering::SeqCst) == 0 {
                    // By hand, frames are read faster so a quick scroll still
                    // leaves an overlap to match.
                    std::thread::sleep(Duration::from_millis(if auto.reason.is_some() { 100 } else { 250 }));
                    if !scroll_bar::is_open(&handle) {
                        control.end.store(2, Ordering::SeqCst);
                        break;
                    }
                    if control.end.load(Ordering::SeqCst) != 0 {
                        break;
                    }
                    if stitch.capped {
                        continue;
                    }
                    let frame = if use_buffered {
                        source.grab()?
                    } else if overlaps {
                        grab_clean(
                            source.as_mut(),
                            synchronous.as_mut(),
                            true,
                            || hide_bar(&handle),
                            || restore_bar(&handle),
                        )?
                    } else {
                        synchronous.grab()?
                    };
                    let old_reason = auto.reason;
                    let old_too_fast = too_fast;
                    auto.observe_pointer(frame.pointer);
                    // The automatic step breaks ties between offsets.
                    let hint = wheel_pending.then(|| {
                        let step = i64::from(step_pixels(rect.width, rect.height, stitch.axis));
                        if stitch.reverse == Some(true) { -step } else { step }
                    });
                    let outcome = stitch.push_with_hint(frame.image, hint);
                    // Only content that stayed put counts toward the end, so
                    // a blinking caret or an animation cannot keep it going.
                    let unchanged = outcome == Push::Still;
                    let changed = outcome == Push::Grew;
                    match outcome {
                        Push::Grew | Push::Placed => too_fast = false,
                        Push::Lost => too_fast = auto.reason.is_some(),
                        Push::Still | Push::Capped => {}
                    }
                    if wheel_pending && auto.at_end(unchanged, stitch.axis.is_some()) {
                        let _ = control.end.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
                        break;
                    }
                    wheel_pending = false;
                    if changed || old_reason != auto.reason || old_too_fast != too_fast {
                        scroll_bar::update(&handle, state(&stitch, &auto, too_fast, false));
                    }
                    if auto.reason.is_none() && !stitch.capped && control.end.load(Ordering::SeqCst) == 0 {
                        let step = step_amount(
                            step_pixels(rect.width, rect.height, stitch.axis),
                            monitor.scale_factor,
                        );
                        if post_wheel(&auto.wheel(stitch.axis, stitch.reverse, step)).is_ok() {
                            wheel_pending = true;
                        } else {
                            auto.reason = Some("Automatic scrolling is unavailable. Scroll by hand, then choose Done.");
                            scroll_bar::update(&handle, state(&stitch, &auto, too_fast, false));
                        }
                    }
                }
                // Drop the frame source before saving or allowing a new session.
                drop(source);
                if control.end.load(Ordering::SeqCst) == 1 {
                    scroll_bar::update(&handle, state(&stitch, &auto, too_fast, true));
                    actions::finish(
                        &handle,
                        &stitch.image,
                        CaptureMode::Region,
                        &foreground,
                        Some(monitor.scale_factor),
                        None,
                    );
                }
                Ok(())
            })();
            scroll_bar::close(&handle);
            scroll_bar::clear(&handle);
            *state_lock(&handle.state::<ScrollState>()) = None;
            if let Err(e) = result {
                actions::report_failure(&handle, &e);
            }
        });
    if let Err(e) = spawned {
        *state_lock(&app.state::<ScrollState>()) = None;
        return Err(e.to_string().into());
    }
    Ok(())
}

/// How long the buffered reader may take to send its own first frame.
const SETTLE_TIMEOUT: Duration = Duration::from_millis(500);

/// Starts the Stitcher from the reader every later frame will come from, and
/// says whether that is the buffered one. The buffered reader (AVCapture,
/// DXGI) and the synchronous one (xcap) do not give identical pixels for the
/// same screen, and the Stitcher never replaces a reference it cannot match,
/// so mixing them would turn away every frame of the session. When the
/// buffered reader has no frame of its own yet (Windows duplication on a
/// still screen), or draws the parked pointer into its frames (macOS
/// AVCapture), the whole session reads synchronously instead.
fn restart_stitch(
    buffered: &mut dyn frames::FrameSource,
    synchronous: &mut dyn frames::FrameSource,
) -> Result<(Stitcher, RgbaImage, bool), String> {
    let use_buffered = buffered.hides_pointer() && buffered.settle(SETTLE_TIMEOUT);
    let frame = if use_buffered {
        buffered.grab()?
    } else {
        synchronous.grab()?
    };
    Ok((
        Stitcher::new(frame.image.clone()),
        frame.image,
        use_buffered,
    ))
}

/// Hiding a window does not invalidate AVCapture/DXGI's latest-frame cache.
/// Bypass that cache entirely for the initial image and all obscured grabs.
/// Restore the controls on capture failure as well as success.
fn grab_clean(
    buffered: &mut dyn frames::FrameSource,
    synchronous: &mut dyn frames::FrameSource,
    obscured: bool,
    hide: impl FnOnce() -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<frames::Grabbed, String> {
    if !obscured {
        return buffered.grab();
    }
    if let Err(error) = hide() {
        // The request may have executed even if visibility confirmation failed.
        let _ = restore();
        return Err(error);
    }
    let grabbed = synchronous.grab();
    let restored = restore();
    match grabbed {
        Err(error) => Err(error),
        Ok(frame) => {
            restored?;
            Ok(frame)
        }
    }
}
fn hide_bar(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(scroll_bar::LABEL) {
        hide_and_wait(
            || window.hide().map_err(|e| e.to_string()),
            || window.is_visible().map_err(|e| e.to_string()),
        )?;
    }
    Ok(())
}
/// Off-main-thread Tauri hide() only enqueues WindowMessage::Hide. The
/// visibility getter round-trips through the UI event loop, so an invisible
/// reply acknowledges that the queued hide has actually executed. Do not grab
/// on an error or while the native window still reports itself visible.
fn hide_and_wait(
    hide: impl FnOnce() -> Result<(), String>,
    mut is_visible: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    hide()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while is_visible()? {
        if std::time::Instant::now() >= deadline {
            return Err("The scrolling capture bar did not hide before the capture".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Let the compositor repaint the uncovered area after native visibility
    // changes. This delay follows acknowledgement; it does not replace it.
    std::thread::sleep(Duration::from_millis(50));
    Ok(())
}
fn restore_bar(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(scroll_bar::LABEL) {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stitch::tests::frame;
    fn rejected_start_preserves_scroll() {
        let control = Control {
            id: 17,
            end: AtomicU8::new(0),
        };
        let mut bar = Some(ScrollBarState::new(17, (800, 1200), None));
        let before = bar.clone();
        // Both start paths use this guard before changing state, and the
        // overlay/restart handler must not report Busy over the running bar.
        let error = ensure_idle(false, true).unwrap_err();
        report_start_failure(error, |_| bar = None);
        assert_eq!(bar, before);
        assert_eq!(control.end.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn windows_pointer_target_preserves_negative_monitor_origins() {
        // A monitor left of and above the primary, with a region on it.
        let target = desktop_pointer_target((-1920, -1080), (300 + 400, 100 + 300));
        assert_eq!(target, (-1220, -680));
        // The frame reports coordinates relative to the captured region.
        let mut auto = AutoScroll::new((400, 300), true, 1.0);
        auto.observe_pointer(Some((target.0 - (-1920 + 300), target.1 - (-1080 + 100))));
        assert!(auto.reason.is_none());
    }

    #[test]
    fn recording_rejection_preserves_scrolling_bar() {
        rejected_start_preserves_scroll();
    }
    #[test]
    fn second_scroll_rejection_preserves_scrolling_bar() {
        rejected_start_preserves_scroll();
    }
    #[test]
    fn real_start_failures_are_still_reported() {
        let mut reported = None;
        report_start_failure(
            StartError::Failed("capture unavailable".into()),
            |message| reported = Some(message.to_owned()),
        );
        assert_eq!(reported.as_deref(), Some("capture unavailable"));
        assert_eq!(ensure_idle(true, false), Err(StartError::Busy));
        assert_eq!(ensure_idle(false, false), Ok(()));
    }
    struct TestSource<'a> {
        visible: &'a std::cell::Cell<bool>,
        cached: bool,
        calls: usize,
        fail: bool,
    }
    impl frames::FrameSource for TestSource<'_> {
        fn grab(&mut self) -> Result<frames::Grabbed, String> {
            self.calls += 1;
            if self.fail {
                return Err("grab failed".into());
            }
            // A buffered source can retain a bar-visible image indefinitely.
            let includes_bar = if self.cached {
                true
            } else {
                self.visible.get()
            };
            Ok(frames::Grabbed {
                image: RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([if includes_bar { 255 } else { 0 }, 0, 0, 255]),
                ),
                pointer: None,
            })
        }
    }
    #[test]
    fn initial_and_obscured_grabs_bypass_stale_video_frames() {
        let visible = std::cell::Cell::new(true);
        let mut buffered = TestSource {
            visible: &visible,
            cached: true,
            calls: 0,
            fail: false,
        };
        let mut synchronous = TestSource {
            visible: &visible,
            cached: false,
            calls: 0,
            fail: false,
        };
        for _ in 0..3 {
            let frame = grab_clean(
                &mut buffered,
                &mut synchronous,
                true,
                || {
                    visible.set(false);
                    Ok(())
                },
                || {
                    visible.set(true);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(frame.image.get_pixel(0, 0)[0], 0);
            assert!(visible.get());
        }
        assert_eq!(buffered.calls, 0);
        assert_eq!(synchronous.calls, 3);
    }
    #[test]
    fn queued_hide_must_execute_before_synchronous_capture() {
        use std::cell::{Cell, RefCell};
        use std::collections::VecDeque;

        for fail in [false, true] {
            let visible = Cell::new(true);
            // Model Tauri's UI queue: hide returns with the window still
            // visible. A visibility query drives/acknowledges queued work.
            let queue = RefCell::new(VecDeque::new());
            let queries = Cell::new(0);
            let mut buffered = TestSource {
                visible: &visible,
                cached: true,
                calls: 0,
                fail: false,
            };
            let mut synchronous = TestSource {
                visible: &visible,
                cached: false,
                calls: 0,
                fail,
            };
            let result = grab_clean(
                &mut buffered,
                &mut synchronous,
                true,
                || {
                    hide_and_wait(
                        || {
                            queue.borrow_mut().push_back(false);
                            assert!(visible.get(), "enqueueing hide must not hide immediately");
                            Ok(())
                        },
                        || {
                            let count = queries.get() + 1;
                            queries.set(count);
                            if count > 1 {
                                visible.set(queue.borrow_mut().pop_front().unwrap());
                            }
                            Ok(visible.get())
                        },
                    )
                },
                || {
                    assert!(!visible.get(), "capture must precede restoring controls");
                    visible.set(true);
                    Ok(())
                },
            );
            if fail {
                assert_eq!(result.err().as_deref(), Some("grab failed"));
            } else {
                assert_eq!(result.unwrap().image.get_pixel(0, 0)[0], 0);
            }
            assert_eq!(queries.get(), 2);
            assert!(queue.borrow().is_empty());
            assert_eq!(buffered.calls, 0);
            assert_eq!(synchronous.calls, 1);
            assert!(visible.get());
        }
    }
    #[test]
    fn controls_are_restored_after_synchronous_capture_failure() {
        let visible = std::cell::Cell::new(true);
        let mut buffered = TestSource {
            visible: &visible,
            cached: true,
            calls: 0,
            fail: false,
        };
        let mut synchronous = TestSource {
            visible: &visible,
            cached: false,
            calls: 0,
            fail: true,
        };
        let result = grab_clean(
            &mut buffered,
            &mut synchronous,
            true,
            || {
                visible.set(false);
                Ok(())
            },
            || {
                visible.set(true);
                Ok(())
            },
        );
        assert_eq!(result.err().as_deref(), Some("grab failed"));
        assert!(visible.get());
        assert_eq!(buffered.calls, 0);
    }
    #[test]
    fn a_failed_hide_never_reads_a_contaminated_frame() {
        let visible = std::cell::Cell::new(true);
        let mut buffered = TestSource {
            visible: &visible,
            cached: true,
            calls: 0,
            fail: false,
        };
        let mut synchronous = TestSource {
            visible: &visible,
            cached: false,
            calls: 0,
            fail: false,
        };
        let result = grab_clean(
            &mut buffered,
            &mut synchronous,
            true,
            || Err("hide failed".into()),
            || Ok(()),
        );
        assert_eq!(result.err().as_deref(), Some("hide failed"));
        assert_eq!(buffered.calls + synchronous.calls, 0);
    }

    struct PageSource {
        offset: u32,
        tint: u8,
        settled: bool,
        draws_pointer: bool,
    }
    impl frames::FrameSource for PageSource {
        fn settle(&mut self, _timeout: Duration) -> bool {
            self.settled
        }
        fn hides_pointer(&self) -> bool {
            !self.draws_pointer
        }
        fn grab(&mut self) -> Result<frames::Grabbed, String> {
            let mut image = frame(Axis::Vertical, self.offset, false);
            let tint = if self.settled { self.tint } else { 3 };
            for pixel in image.pixels_mut() {
                for channel in &mut pixel.0[..3] {
                    *channel = channel.saturating_add(tint);
                }
            }
            Ok(frames::Grabbed {
                image,
                pointer: None,
            })
        }
    }
    #[test]
    fn a_reference_from_the_other_reader_rejects_every_frame() {
        use frames::FrameSource;
        let mut synchronous = PageSource {
            offset: 0,
            tint: 3,
            settled: true,
            draws_pointer: false,
        };
        let mut buffered = PageSource {
            offset: 0,
            tint: 0,
            settled: true,
            draws_pointer: false,
        };
        // The first frame comes from the synchronous reader, later frames
        // from the buffered one: none of them line up with it.
        let mut stitch = Stitcher::new(synchronous.grab().unwrap().image);
        for offset in [10, 20, 30] {
            buffered.offset = offset;
            assert!(!stitch.push(buffered.grab().unwrap().image));
        }
        assert_eq!(stitch.image.height(), 80);
    }
    #[test]
    fn restarting_from_the_buffered_reader_lets_the_capture_grow() {
        use frames::FrameSource;
        let mut buffered = PageSource {
            offset: 0,
            tint: 0,
            settled: true,
            draws_pointer: false,
        };
        let mut synchronous = PageSource {
            offset: 0,
            tint: 3,
            settled: true,
            draws_pointer: false,
        };
        let (mut stitch, previous, use_buffered) =
            restart_stitch(&mut buffered, &mut synchronous).unwrap();
        assert!(use_buffered);
        assert_eq!(previous, frame(Axis::Vertical, 0, false));
        for (offset, height) in [(10, 90), (20, 100), (30, 110)] {
            buffered.offset = offset;
            assert!(stitch.push(buffered.grab().unwrap().image));
            assert_eq!(stitch.image.height(), height);
        }
    }
    #[test]
    fn an_unsettled_buffered_reader_leaves_the_session_synchronous() {
        use frames::FrameSource;
        // Windows duplication with no frame yet would hand back its GDI
        // fallback now and DXGI frames later: never mix the two.
        let mut buffered = PageSource {
            offset: 0,
            tint: 0,
            settled: false,
            draws_pointer: false,
        };
        let mut synchronous = PageSource {
            offset: 0,
            tint: 3,
            settled: true,
            draws_pointer: false,
        };
        let (mut stitch, _, use_buffered) =
            restart_stitch(&mut buffered, &mut synchronous).unwrap();
        assert!(!use_buffered);
        for (offset, height) in [(10, 90), (20, 100)] {
            synchronous.offset = offset;
            assert!(stitch.push(synchronous.grab().unwrap().image));
            assert_eq!(stitch.image.height(), height);
        }
    }
    #[test]
    fn a_reader_that_draws_the_pointer_leaves_the_session_synchronous() {
        use frames::FrameSource;
        // macOS AVCapture draws the parked pointer despite capturesCursor
        // off; joining its frames would bake the pointer into the capture.
        let mut buffered = PageSource {
            offset: 0,
            tint: 0,
            settled: true,
            draws_pointer: true,
        };
        let mut synchronous = PageSource {
            offset: 0,
            tint: 3,
            settled: true,
            draws_pointer: false,
        };
        let (_, previous, use_buffered) = restart_stitch(&mut buffered, &mut synchronous).unwrap();
        assert!(!use_buffered);
        assert_eq!(previous, synchronous.grab().unwrap().image);
    }
    #[test]
    fn content_that_moved_but_never_lined_up_is_not_called_unscrolled() {
        let mut auto = AutoScroll::new((0, 0), true, 1.0);
        // The page moves for a while, then stops at its end.
        for _ in 0..3 {
            assert!(!auto.at_end(false, false));
        }
        for _ in 0..4 {
            assert!(!auto.at_end(true, false));
        }
        assert!(!auto.at_end(true, false));
        assert_eq!(
            auto.reason,
            Some(
                "The page scrolled, but Grab-it could not join the views. Scroll by hand, then choose Done."
            )
        );
    }

    #[test]
    fn pointer_threshold_is_radial_and_pause_is_permanent() {
        let mut auto = AutoScroll::new((100, 100), true, 1.0);
        auto.observe_pointer(None);
        auto.observe_pointer(Some((108, 100)));
        assert!(auto.reason.is_none());
        auto.observe_pointer(Some((106, 106)));
        assert!(auto.reason.is_some());
        auto.observe_pointer(Some((100, 100)));
        for _ in 0..10 {
            assert!(!auto.at_end(true, true));
        }
        assert!(auto.reason.is_some());
    }
    #[test]
    fn mouse_moved_is_measured_in_points() {
        // At 2x, 8 points are 16 image pixels.
        let mut auto = AutoScroll::new((100, 100), true, 2.0);
        auto.observe_pointer(Some((116, 100)));
        assert!(auto.reason.is_none());
        auto.observe_pointer(Some((112, 112)));
        assert_eq!(
            auto.reason,
            Some("Mouse moved. Scroll by hand, then choose Done.")
        );
    }
    #[test]
    fn end_requires_five_consecutive_unchanged_wheel_steps() {
        let mut auto = AutoScroll::new((0, 0), true, 1.0);
        for _ in 0..4 {
            assert!(!auto.at_end(true, true));
        }
        assert!(!auto.at_end(false, true));
        for _ in 0..4 {
            assert!(!auto.at_end(true, true));
        }
        assert!(auto.at_end(true, true));
        let mut refused = AutoScroll::new((0, 0), false, 1.0);
        for _ in 0..10 {
            assert!(!refused.at_end(true, true));
        }
    }
    #[test]
    fn never_moved_capture_yields_to_manual_without_saving() {
        let mut auto = AutoScroll::new((0, 0), true, 1.0);
        let first = frame(Axis::Horizontal, 0, false);
        let mut stitch = Stitcher::new(first.clone());
        for _ in 0..4 {
            assert!(!stitch.push(first.clone()));
            assert!(!auto.at_end(true, stitch.axis.is_some()));
            assert!(auto.reason.is_none());
        }
        assert!(!auto.at_end(true, stitch.axis.is_some()));
        assert_eq!(
            auto.reason,
            Some("Nothing scrolled automatically. Scroll by hand, then choose Done.")
        );
        assert_eq!(stitch.image, first);
        // A horizontal gesture can still grow the image, but yielding to the
        // user is permanent: a later stall must wait for Done or Cancel.
        assert!(stitch.push(frame(Axis::Horizontal, 20, false)));
        for _ in 0..10 {
            assert!(!auto.at_end(true, stitch.axis.is_some()));
        }
    }
    #[test]
    fn wheel_follows_first_accepted_axis_and_direction() {
        let auto = AutoScroll::new((0, 0), true, 1.0);
        assert!(matches!(
            auto.wheel(None, None, 7),
            rdev::EventType::Wheel {
                delta_x: 0,
                delta_y: -7
            }
        ));
        // A step is never smaller than one unit.
        assert!(matches!(
            auto.wheel(None, None, 0),
            rdev::EventType::Wheel {
                delta_x: 0,
                delta_y: -1
            }
        ));
        for axis in [Axis::Vertical, Axis::Horizontal] {
            for reverse in [false, true] {
                let mut stitch = Stitcher::new(frame(axis, if reverse { 20 } else { 0 }, false));
                assert!(stitch.push(frame(axis, if reverse { 0 } else { 20 }, false)));
                let delta = if reverse { 5 } else { -5 };
                match auto.wheel(stitch.axis, stitch.reverse, 5) {
                    rdev::EventType::Wheel { delta_x, delta_y } => {
                        assert_eq!(
                            (delta_x, delta_y),
                            if axis == Axis::Vertical {
                                (0, delta)
                            } else {
                                (
                                    if cfg!(target_os = "macos") {
                                        delta
                                    } else {
                                        -delta
                                    },
                                    0,
                                )
                            }
                        );
                    }
                    _ => panic!("expected wheel event"),
                }
            }
        }
    }
    #[test]
    fn horizontal_wheel_continues_toward_new_content() {
        let auto = AutoScroll::new((0, 0), true, 1.0);
        for reverse in [false, true] {
            let mut stitch = Stitcher::new(frame(Axis::Horizontal, 20, false));
            let next = if reverse { 0 } else { 40 };
            assert!(stitch.push(frame(Axis::Horizontal, next, false)));
            let rdev::EventType::Wheel { delta_x, delta_y } =
                auto.wheel(stitch.axis, stitch.reverse, 3)
            else {
                panic!("expected horizontal wheel event");
            };
            // Interpret the native event: X11 button 7 / Windows positive
            // HWHEEL moves right; CGEvent's negative horizontal delta does so.
            let moves_right = if cfg!(target_os = "macos") {
                delta_x < 0
            } else {
                delta_x > 0
            };
            assert_eq!(moves_right, !reverse);
            assert_eq!(delta_y, 0);
            assert_eq!(delta_x.abs(), 3);
        }
    }
    #[test]
    fn step_is_a_third_of_the_area_along_the_axis() {
        // Vertical until an axis is accepted.
        assert_eq!(step_pixels(1200, 900, None), 300);
        assert_eq!(step_pixels(1200, 900, Some(Axis::Vertical)), 300);
        assert_eq!(step_pixels(1200, 900, Some(Axis::Horizontal)), 400);
        // Small areas still move.
        assert_eq!(step_pixels(2, 2, None), 1);
        assert_eq!(step_pixels(0, 0, Some(Axis::Horizontal)), 1);
    }
    #[test]
    fn macos_step_is_in_points() {
        assert_eq!(step_points(600, 2.0), 300);
        assert_eq!(step_points(300, 1.0), 300);
        assert_eq!(step_points(400, 1.5), 267);
        assert_eq!(step_points(1, 2.0), 1);
        // A scale that cannot divide counts as 1.
        assert_eq!(step_points(300, 0.0), 300);
        assert_eq!(step_points(300, f64::NAN), 300);
    }
    #[test]
    fn windows_and_x11_step_is_in_whole_notches() {
        // 900 image px at 1x is 900 logical px: nine notches.
        assert_eq!(step_notches(900, 1.0), 9);
        // At 2x the same area is 450 logical px.
        assert_eq!(step_notches(900, 2.0), 5);
        assert_eq!(step_notches(600, 1.5), 4);
        assert_eq!(step_notches(340, 1.0), 3);
        // Never fewer than one notch, however small the area.
        assert_eq!(step_notches(40, 1.0), 1);
        assert_eq!(step_notches(1, 2.0), 1);
        assert_eq!(step_notches(300, 0.0), 3);
    }
    #[test]
    fn step_uses_the_platform_unit_for_both_axes() {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            let pixels = step_pixels(1800, 1200, Some(axis));
            let expected = if cfg!(target_os = "macos") {
                step_points(pixels, 2.0)
            } else {
                step_notches(pixels, 2.0)
            };
            assert_eq!(step_amount(pixels, 2.0), expected);
        }
        assert_eq!(
            step_amount(step_pixels(1800, 1200, Some(Axis::Horizontal)), 2.0),
            if cfg!(target_os = "macos") { 300 } else { 3 }
        );
    }
}
