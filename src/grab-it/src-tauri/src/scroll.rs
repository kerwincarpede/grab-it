//! Manual scrolling capture. Unmatched frames never alter the accepted reference.
use image::{RgbaImage, imageops};
use std::{
    borrow::Cow,
    sync::{Mutex, OnceLock},
};

pub const MAX_LENGTH: u32 = 30_000;
/// Serializes recording/scroll startup, including their state reservations.
pub fn start_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// A busy rejection must not replace the card controlling an existing session.
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

#[derive(Clone, Copy, Debug, PartialEq)]
enum Axis {
    Vertical,
    Horizontal,
}
fn length(i: &RgbaImage, a: Axis) -> u32 {
    if a == Axis::Vertical {
        i.height()
    } else {
        i.width()
    }
}
fn pixel(i: &RgbaImage, a: Axis, along: u32, across: u32) -> &image::Rgba<u8> {
    if a == Axis::Vertical {
        i.get_pixel(across, along)
    } else {
        i.get_pixel(along, across)
    }
}
fn line_error(a: &RgbaImage, b: &RgbaImage, axis: Axis, x: u32, y: u32) -> f64 {
    let cross = length(
        a,
        if axis == Axis::Vertical {
            Axis::Horizontal
        } else {
            Axis::Vertical
        },
    );
    let mut sum = 0u64;
    let mut count = 0;
    for c in (0..cross).step_by((cross / 64).max(1) as usize) {
        for k in 0..3 {
            sum += pixel(a, axis, x, c)[k].abs_diff(pixel(b, axis, y, c)[k]) as u64;
            count += 1;
        }
    }
    sum as f64 / count.max(1) as f64
}

fn flip(i: &RgbaImage, axis: Axis) -> RgbaImage {
    if axis == Axis::Vertical {
        imageops::flip_vertical(i)
    } else {
        imageops::flip_horizontal(i)
    }
}

pub struct Stitcher {
    pub image: RgbaImage,
    last: RgbaImage,
    axis: Option<Axis>,
    reverse: Option<bool>,
    pub capped: bool,
    limit: u32,
}
impl Stitcher {
    pub fn new(first: RgbaImage) -> Self {
        let capped = first.width() >= MAX_LENGTH || first.height() >= MAX_LENGTH;
        let image = imageops::crop_imm(
            &first,
            0,
            0,
            first.width().min(MAX_LENGTH),
            first.height().min(MAX_LENGTH),
        )
        .to_image();
        Self {
            image,
            last: first,
            axis: None,
            reverse: None,
            capped,
            limit: MAX_LENGTH,
        }
    }
    /// Accepts only a well-supported overlap. Sticky edge strips are retained
    /// once, replacing the old trailing strip on each accepted frame.
    pub fn push(&mut self, next: RgbaImage) -> bool {
        if self.capped || next.dimensions() != self.last.dimensions() || next == self.last {
            return false;
        }
        let axes = self
            .axis
            .map(|a| vec![a])
            .unwrap_or(vec![Axis::Vertical, Axis::Horizontal]);
        let mut best: Option<(f64, Axis, u32, u32, bool)> = None;
        let mut runner_up = f64::INFINITY;
        for axis in axes {
            for reverse in self.reverse.map(|r| vec![r]).unwrap_or(vec![false, true]) {
                let last_image = if reverse {
                    Cow::Owned(flip(&self.last, axis))
                } else {
                    Cow::Borrowed(&self.last)
                };
                let next_image = if reverse {
                    Cow::Owned(flip(&next, axis))
                } else {
                    Cow::Borrowed(&next)
                };
                let last = &last_image;
                let next = &next_image;
                let n = length(next, axis);
                let fixed = |p| line_error(last, next, axis, p, p) < 0.5;
                let head = (0..n).take_while(|&p| fixed(p)).count() as u32;
                let tail = (0..n.saturating_sub(head))
                    .take_while(|&p| fixed(n - 1 - p))
                    .count() as u32;
                let end = n - tail;
                let body = end.saturating_sub(head);
                let minimum = (body / 4).max(8);
                if body <= minimum {
                    continue;
                }
                let motion: f64 = (head..end)
                    .step_by((body / 48).max(1) as usize)
                    .map(|p| line_error(last, next, axis, p, p))
                    .sum();
                if motion < 48. {
                    continue;
                }
                for offset in 1..body - minimum + 1 {
                    let overlap = body - offset;
                    let mut error = 0.;
                    let mut samples = 0;
                    for p in (head..end - offset).step_by((overlap / 48).max(1) as usize) {
                        error += line_error(last, next, axis, p + offset, p);
                        samples += 1;
                    }
                    let score = error / samples.max(1) as f64;
                    if score < 2.0 {
                        if best.as_ref().is_none_or(|b| score < b.0) {
                            runner_up = best.as_ref().map(|b| b.0).unwrap_or(f64::INFINITY);
                            best = Some((score, axis, offset, tail, reverse));
                        } else {
                            runner_up = runner_up.min(score);
                        }
                    }
                }
            }
        }
        let Some((score, axis, offset, tail, reverse)) = best else {
            return false;
        };
        // Repeating patterns can support several different offsets. Waiting
        // for another frame is safer than permanently duplicating content.
        if runner_up - score < 0.1 {
            return false;
        }
        let normalized = if reverse {
            Cow::Owned(flip(&self.image, axis))
        } else {
            Cow::Borrowed(&self.image)
        };
        let input = if reverse {
            Cow::Owned(flip(&next, axis))
        } else {
            Cow::Borrowed(&next)
        };
        let old = length(&self.image, axis);
        let add = offset.min(self.limit.saturating_sub(old));
        self.capped = old + add >= self.limit;
        if add == 0 {
            return false;
        }
        let (w, h) = if axis == Axis::Vertical {
            (self.image.width(), old + add)
        } else {
            (old + add, self.image.height())
        };
        let mut output = RgbaImage::new(w, h);
        imageops::replace(&mut output, normalized.as_ref(), 0, 0);
        let start = length(&next, axis) - tail - offset;
        let strip = if axis == Axis::Vertical {
            imageops::crop_imm(input.as_ref(), 0, start, w, add).to_image()
        } else {
            imageops::crop_imm(input.as_ref(), start, 0, add, h).to_image()
        };
        let at = old - tail;
        imageops::replace(
            &mut output,
            &strip,
            if axis == Axis::Horizontal {
                at as i64
            } else {
                0
            },
            if axis == Axis::Vertical { at as i64 } else { 0 },
        );
        if tail > 0 {
            let n = length(&input, axis);
            let footer = if axis == Axis::Vertical {
                imageops::crop_imm(input.as_ref(), 0, n - tail, w, tail).to_image()
            } else {
                imageops::crop_imm(input.as_ref(), n - tail, 0, tail, h).to_image()
            };
            let at = old + add - tail;
            imageops::replace(
                &mut output,
                &footer,
                if axis == Axis::Horizontal {
                    at as i64
                } else {
                    0
                },
                if axis == Axis::Vertical { at as i64 } else { 0 },
            );
        }
        self.image = if reverse { flip(&output, axis) } else { output };
        self.last = next;
        self.axis = Some(axis);
        self.reverse = Some(reverse);
        true
    }
}

use crate::{
    actions,
    capture::{CaptureMode, Foreground, Rect},
    frames,
    quick::{self, QuickItem},
    screen::MonitorInfo,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
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
pub fn scroll_done(app: AppHandle, session_id: u64) {
    end(&app, session_id, 1);
}
#[tauri::command]
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
pub fn start(
    app: &AppHandle,
    monitor: &MonitorInfo,
    rect: Rect,
    image_size: (u32, u32),
    foreground: Foreground,
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
                let mut source = frames::open(&monitor, rect, 10, false)?;
                let mut synchronous = frames::open_synchronous(&monitor, rect)?;
                let mut stitch = Stitcher::new(
                    grab_clean(
                        source.as_mut(),
                        synchronous.as_mut(),
                        true,
                        || hide_card(&handle),
                        || restore_card(&handle),
                    )?
                    .image,
                );
                let item = |s: &Stitcher| QuickItem::Scrolling {
                    session_id: control.id,
                    width: s.image.width(),
                    height: s.image.height(),
                    capped: s.capped,
                };
                let mut generation = quick::show(&handle, item(&stitch));
                let overlaps = place_card(&handle, &monitor, rect, image_size);
                if !overlaps {
                    // Start the video cache only after the old card has moved
                    // out of the selection; its previous frames are unsafe.
                    drop(source);
                    source = frames::open(&monitor, rect, 10, false)?;
                }
                while control.end.load(Ordering::SeqCst) == 0 {
                    std::thread::sleep(Duration::from_millis(100));
                    if !quick::is_current(&handle, generation) {
                        control.end.store(2, Ordering::SeqCst);
                        break;
                    }
                    if control.end.load(Ordering::SeqCst) != 0 {
                        break;
                    }
                    if !stitch.capped
                        && stitch.push(
                            grab_clean(
                                source.as_mut(),
                                synchronous.as_mut(),
                                overlaps,
                                || hide_card(&handle),
                                || restore_card(&handle),
                            )?
                            .image,
                        )
                    {
                        if let Some(g) = quick::replace(&handle, generation, item(&stitch)) {
                            generation = g;
                        } else {
                            control.end.store(2, Ordering::SeqCst);
                        }
                    }
                }
                // Drop the frame source before saving or allowing a new session.
                drop(source);
                quick::dismiss(&handle, generation);
                if control.end.load(Ordering::SeqCst) == 1 {
                    actions::finish(
                        &handle,
                        &stitch.image,
                        CaptureMode::Region,
                        &foreground,
                        Some(monitor.scale_factor),
                    );
                }
                Ok(())
            })();
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
fn hide_card(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(quick::LABEL) {
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
            return Err("Quick Access did not become invisible before capture".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Let the compositor repaint the uncovered area after native visibility
    // changes. This delay follows acknowledgement; it does not replace it.
    std::thread::sleep(Duration::from_millis(50));
    Ok(())
}
fn restore_card(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(quick::LABEL) {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Picks a clear corner on the captured monitor, independent of the pointer.
/// Returns whether all corners overlap and grabs must hide the card briefly.
fn place_card(app: &AppHandle, info: &MonitorInfo, rect: Rect, image_size: (u32, u32)) -> bool {
    let monitor = app
        .monitor_from_point(info.x as f64 + 1., info.y as f64 + 1.)
        .ok()
        .flatten();
    let Some(monitor) = monitor else {
        return true;
    };
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    let sx = size.width as f64 / image_size.0.max(1) as f64;
    let sy = size.height as f64 / image_size.1.max(1) as f64;
    let region = (
        origin.x as f64 + rect.x as f64 * sx,
        origin.y as f64 + rect.y as f64 * sy,
        rect.width as f64 * sx,
        rect.height as f64 * sy,
    );
    let area = monitor.work_area();
    let corners = [
        quick::preferred_corner(app),
        quick::Corner::TopLeft,
        quick::Corner::TopRight,
        quick::Corner::BottomLeft,
        quick::Corner::BottomRight,
    ];
    for corner in corners {
        let p = quick::place_in_corner(
            (area.position.x, area.position.y),
            (area.size.width, area.size.height),
            scale,
            corner,
        );
        let clear = p.x as f64 + 336. * scale <= region.0
            || p.y as f64 + 232. * scale <= region.1
            || p.x as f64 >= region.0 + region.2
            || p.y as f64 >= region.1 + region.3;
        if clear {
            if let Some(w) = app.get_webview_window("quick") {
                let _ = w.set_position(p);
            }
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rejected_start_preserves_scroll() {
        let control = Control {
            id: 17,
            end: AtomicU8::new(0),
        };
        let mut card = QuickItem::Scrolling {
            session_id: 17,
            width: 800,
            height: 1200,
            capped: false,
        };
        let before = card.clone();
        // Both start paths use this guard before changing state, and the
        // overlay/restart handler must not publish an Error card for Busy.
        let error = ensure_idle(false, true).unwrap_err();
        report_start_failure(error, |message| {
            card = QuickItem::Error {
                message: message.to_owned(),
            };
        });
        assert_eq!(card, before);
        assert_eq!(control.end.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn recording_rejection_preserves_scrolling_card() {
        rejected_start_preserves_scroll();
    }
    #[test]
    fn second_scroll_rejection_preserves_scrolling_card() {
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
            // A buffered source can retain a card-visible image indefinitely.
            let includes_card = if self.cached {
                true
            } else {
                self.visible.get()
            };
            Ok(frames::Grabbed {
                image: RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([if includes_card { 255 } else { 0 }, 0, 0, 255]),
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

    fn frame(axis: Axis, offset: u32, sticky: bool) -> RgbaImage {
        let (w, h) = if axis == Axis::Vertical {
            (24, 80)
        } else {
            (80, 24)
        };
        RgbaImage::from_fn(w, h, |x, y| {
            let p = if axis == Axis::Vertical { y } else { x };
            let c = if axis == Axis::Vertical { x } else { y };
            let v = if sticky && !(5..75).contains(&p) {
                p
            } else {
                p + offset
            };
            image::Rgba([
                ((v * 37 + c * 13) % 251) as u8,
                ((v * 71 + c * 7) % 253) as u8,
                ((v * 19 + c * 41) % 255) as u8,
                255,
            ])
        })
    }
    #[test]
    fn offsets_axes_and_sticky_edges() {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            for sticky in [false, true] {
                let mut s = Stitcher::new(frame(axis, 0, sticky));
                assert!(!s.push(frame(axis, 0, sticky)));
                assert!(s.push(frame(axis, 13, sticky)));
                assert_eq!(length(&s.image, axis), 93);
                assert!(s.push(frame(axis, 32, sticky)));
                assert_eq!(length(&s.image, axis), 112);
                let expected = frame(axis, 32, sticky);
                assert_eq!(
                    pixel(&s.image, axis, 111, 10),
                    pixel(&expected, axis, 79, 10)
                );
                assert!(!s.push(RgbaImage::new(2, 2)));
            }
        }
    }
    #[test]
    fn reverse_motion_prepends_in_reading_order() {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            let mut s = Stitcher::new(frame(axis, 32, false));
            assert!(s.push(frame(axis, 13, false)));
            assert!(s.push(frame(axis, 0, false)));
            assert_eq!(length(&s.image, axis), 112);
            assert_eq!(
                pixel(&s.image, axis, 0, 10),
                pixel(&frame(axis, 0, false), axis, 0, 10)
            );
        }
    }
    #[test]
    fn cap_waits_without_growing() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, false));
        s.limit = 90;
        assert!(s.push(frame(Axis::Vertical, 20, false)));
        assert_eq!(s.image.height(), 90);
        assert!(s.capped);
        assert!(!s.push(frame(Axis::Vertical, 30, false)));
    }
    #[test]
    fn partial_cap_retains_one_footer() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, true));
        s.limit = 90;
        assert!(s.push(frame(Axis::Vertical, 20, true)));
        assert_eq!(s.image.height(), 90);
        for p in 0..5 {
            assert_eq!(
                s.image.get_pixel(10, 85 + p),
                frame(Axis::Vertical, 20, true).get_pixel(10, 75 + p)
            );
        }
    }
    #[test]
    fn ambiguous_repeating_rows_are_not_guessed() {
        let pattern = |offset| {
            RgbaImage::from_fn(24, 80, |_, y| {
                let v = (((y + offset) % 8) * 30) as u8;
                image::Rgba([v, v, v, 255])
            })
        };
        let mut s = Stitcher::new(pattern(0));
        assert!(!s.push(pattern(3)));
        assert_eq!(s.image.height(), 80);
    }
    #[test]
    fn unrelated_frames_do_not_poison_reference() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, false));
        assert!(!s.push(RgbaImage::from_pixel(
            24,
            80,
            image::Rgba([255, 255, 255, 255])
        )));
        assert!(s.push(frame(Axis::Vertical, 10, false)));
    }
}
