//! The timed capture pill: a small window at the top centre of the display
//! under the pointer while a timed capture waits, counting down the
//! seconds left, with Start now and Cancel buttons (see src/timerbar/).
//!
//! It closes a moment before the capture starts on every platform, so it
//! is never in the image or the frozen overlay, even on X11 and Wayland,
//! which cannot leave a window out of a capture. It never takes focus, so
//! a menu opened for the capture stays open.
//!
//! Each countdown has a generation. Starting another one or pressing
//! Cancel moves the generation on, and a countdown that wakes to find it
//! is no longer current returns without touching the pill or capturing.
//! Start now marks the current countdown as skipped, and it captures as
//! soon as its pill has gone.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use tauri::Manager;

use crate::rt::AppHandle;
use crate::{
    record_bar::Display,
    steps_bar::{self, Pill},
};

pub const LABEL: &str = "timer-bar";
/// The window's size in points: the pill and the room for its shadow
/// around it (`.timerbar` padding in src/timerbar/timerbar.css).
const SIZE: (f64, f64) = (340.0, 66.0);
/// Delays shorter than this, such as the hub's wait for itself to hide,
/// start without a pill.
const SHORTEST: Duration = Duration::from_secs(1);
/// How long before the capture the pill closes, so it has gone from the
/// screen when the capture is taken.
const CLOSE_AHEAD: Duration = Duration::from_millis(150);
/// How long a replaced pill may take to go before the new one opens.
const CLOSE_WAIT: Duration = Duration::from_millis(500);

/// The current countdown. Moved on by each new countdown, by Cancel and by
/// a countdown as it finishes.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The countdown Start now was pressed for, so it ends early.
static SKIPPED: AtomicU64 = AtomicU64::new(0);
/// How often a countdown checks whether Start now was pressed.
const SKIP_POLL: Duration = Duration::from_millis(20);
/// Opening and closing the pill one at a time, so two countdowns never
/// make two windows with the same label.
static WINDOW: Mutex<()> = Mutex::new(());

/// Starts a new countdown, which becomes the current one.
fn begin(generation: &AtomicU64) -> u64 {
    generation.fetch_add(1, Ordering::SeqCst) + 1
}

/// Ends `countdown` if it is still current, so a Cancel that comes after
/// it no longer stops it. False when it was replaced or cancelled.
fn finish(generation: &AtomicU64, countdown: u64) -> bool {
    generation
        .compare_exchange(countdown, countdown + 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Stops whatever countdown is current, and returns the generation after
/// it, which a countdown started since would have moved on.
fn cancel(generation: &AtomicU64) -> u64 {
    generation.fetch_add(1, Ordering::SeqCst) + 1
}

/// Ends whatever countdown is current early, from Start now.
fn skip(generation: &AtomicU64, skipped: &AtomicU64) {
    skipped.store(generation.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// Waits until `deadline`, or until Start now is pressed for `countdown`.
/// True when it was.
fn wait_or_skip(skipped: &AtomicU64, countdown: u64, deadline: Instant) -> bool {
    loop {
        if skipped.load(Ordering::SeqCst) == countdown {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        std::thread::sleep(left.min(SKIP_POLL));
    }
}

/// The pill's top-left corner and size in physical pixels on `display`:
/// where the step capture pill opens.
pub fn placement(display: &Display) -> ((i32, i32), (u32, u32)) {
    steps_bar::placement_of(SIZE, display)
}

/// The pill's page, counting down to `ends` (ms since the Unix epoch).
fn route(ends: i64) -> String {
    format!("timerbar?ends={ends}")
}

/// Runs `run` after `delay` off the caller's thread. For a second or more
/// the pill counts it down, replacing any pill already open, and Cancel
/// stops `run` from being called.
pub fn after<F>(app: &AppHandle, delay: Duration, run: F)
where
    F: FnOnce(&AppHandle) + Send + 'static,
{
    let app = app.clone();
    if delay < SHORTEST {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            run(&app);
        });
        return;
    }
    let countdown = begin(&GENERATION);
    std::thread::spawn(move || {
        let ends = Instant::now() + delay;
        let ends_ms = crate::storage::now_ms() + delay.as_millis() as i64;
        show(&app, countdown, ends_ms);
        let closes = ends.checked_sub(CLOSE_AHEAD).unwrap_or(ends);
        let skipped = wait_or_skip(&SKIPPED, countdown, closes);
        if !finish(&GENERATION, countdown) {
            return;
        }
        close(&app, countdown + 1);
        // The pill needs as long to go after Start now as at the end.
        let starts = if skipped {
            Instant::now() + CLOSE_AHEAD
        } else {
            ends
        };
        std::thread::sleep(starts.saturating_duration_since(Instant::now()));
        run(&app);
    });
}

/// Opens the pill for `countdown` in place of any open one, unless a
/// newer countdown or Cancel came first.
fn show(app: &AppHandle, countdown: u64, ends: i64) {
    let _window = WINDOW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    replace(
        &GENERATION,
        countdown,
        || destroy_and_wait(app),
        || {
            let Some(display) = steps_bar::pointer_display(app) else {
                eprintln!("Grab-it: no display to show the timed capture pill on");
                return;
            };
            if let Err(err) = create(app, &display, ends) {
                eprintln!("Grab-it: could not show the timed capture pill: {err}");
            }
        },
    );
}

/// Swaps the open pill for `countdown`'s: `destroy` closes the open one
/// and `open` opens the new one. A countdown no longer current touches
/// neither, so it never closes a newer countdown's pill; it is checked
/// again after `destroy`, since it can be replaced while that waits.
fn replace(generation: &AtomicU64, countdown: u64, destroy: impl FnOnce(), open: impl FnOnce()) {
    if generation.load(Ordering::SeqCst) != countdown {
        return;
    }
    destroy();
    if generation.load(Ordering::SeqCst) != countdown {
        return;
    }
    open();
}

fn create(app: &AppHandle, display: &Display, ends: i64) -> tauri::Result<()> {
    steps_bar::open_pill(
        app,
        Pill {
            label: LABEL,
            route: route(ends),
            title: "Grab-it timed capture",
            size: SIZE,
        },
        display,
        placement(display),
    )
}

/// Closes the pill and waits for it to go, as the label is free only once
/// it has.
fn destroy_and_wait(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if let Err(err) = window.destroy() {
        eprintln!("Grab-it: could not close the timed capture pill: {err}");
        return;
    }
    let started = Instant::now();
    while app.get_webview_window(LABEL).is_some() && started.elapsed() < CLOSE_WAIT {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Closes the pill, if it is open, unless a countdown started since
/// `generation` opened it.
fn close(app: &AppHandle, generation: u64) {
    let _window = WINDOW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the timed capture pill: {err}");
    }
}

/// Stops the timed capture counting down, from the pill's Cancel. Once
/// the pill has closed the capture is under way and this does nothing.
#[tauri::command]
#[specta::specta]
pub fn timer_bar_cancel(app: AppHandle) {
    let generation = cancel(&GENERATION);
    // Off the calling thread: closing waits for the window lock.
    std::thread::spawn(move || close(&app, generation));
}

/// Ends the timed capture's countdown early, from the pill's Start now or
/// Enter, so it captures at once. Once the pill has closed the capture is
/// under way and this does nothing.
#[tauri::command]
#[specta::specta]
pub fn timer_bar_start_now() {
    skip(&GENERATION, &SKIPPED);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_now_ends_the_current_countdown_early() {
        let generation = AtomicU64::new(0);
        let skipped = AtomicU64::new(0);
        let countdown = begin(&generation);
        skip(&generation, &skipped);
        let began = Instant::now();
        assert!(wait_or_skip(
            &skipped,
            countdown,
            began + Duration::from_secs(60)
        ));
        assert!(began.elapsed() < Duration::from_secs(1));
        // Still current, so it goes on to capture.
        assert!(finish(&generation, countdown));
    }

    #[test]
    fn a_countdown_left_alone_waits_to_its_end() {
        let generation = AtomicU64::new(0);
        let skipped = AtomicU64::new(0);
        let countdown = begin(&generation);
        let deadline = Instant::now() + Duration::from_millis(30);
        assert!(!wait_or_skip(&skipped, countdown, deadline));
        assert!(Instant::now() >= deadline);
    }

    #[test]
    fn start_now_for_an_older_countdown_leaves_a_newer_one_alone() {
        let generation = AtomicU64::new(0);
        let skipped = AtomicU64::new(0);
        begin(&generation);
        skip(&generation, &skipped);
        let newer = begin(&generation);
        assert!(!wait_or_skip(&skipped, newer, Instant::now()));
    }
    use crate::record_bar::Area;

    fn display(work: Area, scale: f64) -> Display {
        Display {
            key: "DP-1".into(),
            work,
            scale,
        }
    }

    #[test]
    fn the_pill_opens_at_the_top_centre_of_the_work_area() {
        let work = Area {
            x: 0,
            y: 25,
            width: 1920,
            height: 1055,
        };
        let ((x, y), size) = placement(&display(work, 1.0));
        assert_eq!(size, (340, 66));
        assert_eq!(x, (1920 - 340) / 2);
        assert_eq!(y, 25 + 12);
    }

    #[test]
    fn the_pill_is_sized_and_placed_in_the_display_pixels() {
        let work = Area {
            x: 2560,
            y: 50,
            width: 5120,
            height: 2830,
        };
        let ((x, y), size) = placement(&display(work, 2.0));
        assert_eq!(size, (680, 132));
        assert_eq!(x, 2560 + (5120 - 680) / 2);
        assert_eq!(y, 50 + 24);
    }

    #[test]
    fn the_page_counts_down_to_the_end_time() {
        assert_eq!(route(1_700_000_010_000), "timerbar?ends=1700000010000");
    }

    #[test]
    fn a_countdown_left_alone_finishes() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        assert!(finish(&generation, countdown));
    }

    #[test]
    fn a_cancelled_countdown_does_not_finish() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        cancel(&generation);
        assert!(!finish(&generation, countdown));
    }

    #[test]
    fn a_newer_countdown_replaces_the_older_one() {
        let generation = AtomicU64::new(0);
        let older = begin(&generation);
        let newer = begin(&generation);
        assert!(!finish(&generation, older));
        assert!(finish(&generation, newer));
    }

    #[test]
    fn cancel_after_a_countdown_finished_changes_nothing() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        assert!(finish(&generation, countdown));
        cancel(&generation);
        // A countdown started afterwards is not affected by it.
        let next = begin(&generation);
        assert!(finish(&generation, next));
    }

    #[test]
    fn a_stale_countdown_leaves_the_newer_pill_alone() {
        let generation = AtomicU64::new(0);
        let older = begin(&generation);
        let newer = begin(&generation);
        let pills = std::cell::RefCell::new(Vec::new());
        // The newer countdown's thread reaches the pill first.
        replace(
            &generation,
            newer,
            || pills.borrow_mut().clear(),
            || pills.borrow_mut().push(newer),
        );
        let mut destroyed = false;
        let mut opened = false;
        replace(&generation, older, || destroyed = true, || opened = true);
        assert!(!destroyed && !opened);
        assert_eq!(pills.into_inner(), vec![newer]);
    }

    #[test]
    fn a_countdown_cancelled_before_its_pill_opens_touches_no_pill() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        cancel(&generation);
        let mut destroyed = false;
        let mut opened = false;
        replace(
            &generation,
            countdown,
            || destroyed = true,
            || opened = true,
        );
        assert!(!destroyed && !opened);
    }

    #[test]
    fn a_countdown_replaced_while_the_old_pill_closes_opens_none() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        let mut opened = false;
        replace(
            &generation,
            countdown,
            || {
                begin(&generation);
            },
            || opened = true,
        );
        assert!(!opened);
    }

    #[test]
    fn a_current_countdown_swaps_the_pill() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        let steps = std::cell::RefCell::new(Vec::new());
        replace(
            &generation,
            countdown,
            || steps.borrow_mut().push("destroy"),
            || steps.borrow_mut().push("open"),
        );
        assert_eq!(steps.into_inner(), vec!["destroy", "open"]);
    }

    #[test]
    fn a_countdown_finishes_only_once() {
        let generation = AtomicU64::new(0);
        let countdown = begin(&generation);
        assert!(finish(&generation, countdown));
        assert!(!finish(&generation, countdown));
    }
}
