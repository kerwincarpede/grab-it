//! The tray icon and its menu.

use std::{
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tauri::{
    Manager,
    menu::{Menu, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::rt::{AppHandle, MenuItem, Submenu};
use crate::{
    actions::{self, Action},
    feedback, hub, pin, quick, screen, update, windows,
};

const TRAY_ID: &str = "main";
const RECORD_LABEL: &str = "Record";
const STOP_LABEL: &str = "Stop recording";
const STEPS_LABEL: &str = "Step capture";
const STOP_STEPS_LABEL: &str = "Stop step capture";
const TOOLTIP: &str = "Grab-it";
const STEPS_TOOLTIP: &str = "Grab-it — step capture on";

/// When the pointer was over the icon, as its hover events tell it. Linux
/// trays report none, so it stays empty there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Hover {
    /// When the latest stretch over the icon began.
    since: Option<Instant>,
    /// The latest event that saw the pointer over the icon.
    last: Option<Instant>,
    /// When the pointer left the icon, ending that stretch.
    left: Option<Instant>,
}

/// How long before the first hover event a click still counts as on the
/// icon: the event can arrive after the click that caused it, so a click
/// is only judged once this has passed.
pub const HOVER_LEAD: Duration = Duration::from_millis(100);
/// How long after the latest hover event the pointer is still taken to be
/// over the icon. Leave can be missed, so hover runs out.
const HOVER_LIMIT: Duration = Duration::from_secs(10);

static HOVER: Mutex<Hover> = Mutex::new(Hover {
    since: None,
    last: None,
    left: None,
});

fn hover() -> MutexGuard<'static, Hover> {
    HOVER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Hover {
    /// An event at `now` saw the pointer over the icon.
    fn over(&mut self, now: Instant) {
        if self.since.is_none() || self.left.is_some() {
            self.since = Some(now);
            self.left = None;
        }
        self.last = Some(now);
    }

    /// The pointer left the icon at `now`.
    fn leave(&mut self, now: Instant) {
        self.left = Some(now);
    }
}

/// Whether a click at `at` was on the icon by `hover`'s account.
fn over_icon(hover: &Hover, at: Instant) -> bool {
    let (Some(since), Some(last)) = (hover.since, hover.last) else {
        return false;
    };
    since.saturating_duration_since(at) <= HOVER_LEAD
        && hover.left.is_none_or(|left| at < left)
        && at.saturating_duration_since(last) <= HOVER_LIMIT
}

/// Whether the pointer was over the tray icon at `at`, so a step capture
/// can leave out clicks on the icon that the window list does not report
/// as Grab-it's. Always false on Linux, whose trays report no hover.
pub fn pointer_over_icon(at: Instant) -> bool {
    over_icon(&hover(), at)
}

/// Forgets the icon's hover, so a stretch from before a step capture
/// cannot make it skip a click.
pub fn reset_hover() {
    *hover() = Hover::default();
}

/// The menu items whose text or state changes while Grab-it runs.
pub struct TrayItems {
    chooser: MenuItem,
    record: MenuItem,
    steps: MenuItem,
    unlock: MenuItem,
}

/// Shows the global shortcut without installing a competing menu accelerator.
pub fn set_chooser_binding(app: &AppHandle, binding: Option<&str>) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let mut title = String::from("Capture && record…");
        if let Some(label) = binding {
            title.push_str("    ");
            title.push_str(&label.replace('&', "&&"));
        }
        let _ = items.chooser.set_text(title);
    }
}

/// Makes the step capture item say what choosing it does now, the
/// icon's tooltip say whether one runs, and an open hub show it.
pub fn set_steps(app: &AppHandle, running: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let label = if running {
            STOP_STEPS_LABEL
        } else {
            STEPS_LABEL
        };
        if let Err(err) = items.steps.set_text(label) {
            eprintln!("Grab-it: could not update the tray menu: {err}");
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = if running { STEPS_TOOLTIP } else { TOOLTIP };
        if let Err(err) = tray.set_tooltip(Some(tooltip)) {
            eprintln!("Grab-it: could not update the tray tooltip: {err}");
        }
    }
    hub::activity_changed(app);
}

/// Makes the record item say what choosing it does now: start, or stop,
/// and an open hub show it.
pub fn set_recording(app: &AppHandle, recording: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let label = if recording { STOP_LABEL } else { RECORD_LABEL };
        if let Err(err) = items.record.set_text(label) {
            eprintln!("Grab-it: could not update the tray menu: {err}");
        }
    }
    hub::activity_changed(app);
}

/// Enables Unlock pinned captures while any pin is locked.
pub fn set_unlock_enabled(app: &AppHandle, enabled: bool) {
    if let Some(items) = app.try_state::<TrayItems>()
        && let Err(err) = items.unlock.set_enabled(enabled)
    {
        eprintln!("Grab-it: could not update the tray menu: {err}");
    }
}
const MENU_ALL_IN_ONE: &str = "all-in-one";
const MENU_REGION: &str = "capture-region";
const MENU_WINDOW: &str = "capture-window";
const MENU_SCREEN: &str = "capture-screen";
const MENU_MONITOR_PREFIX: &str = "capture-monitor-";
const MENU_REPEAT: &str = "capture-repeat";
const MENU_RECORD: &str = "record-gif";
const MENU_STEPS: &str = "step-capture";
const MENU_TEXT: &str = "capture-text";
const MENU_COLOUR: &str = "pick-colour";
/// Timed captures are `timed-<region|screen>-<seconds>`.
const MENU_TIMED_PREFIX: &str = "timed-";
const MENU_UNLOCK: &str = "unlock-pins";
const MENU_LAST: &str = "last-capture";
const MENU_LIBRARY: &str = "library";
const MENU_SETTINGS: &str = "settings";
const MENU_WELCOME: &str = "welcome";
const MENU_UPDATES: &str = "check-updates";
const MENU_REPORT_PROBLEM: &str = "feedback-problem";
const MENU_SUGGEST_IDEA: &str = "feedback-idea";
const MENU_QUIT: &str = "quit";

/// The capture a menu item starts, if any.
fn action_for(id: &str) -> Option<Action> {
    match id {
        MENU_ALL_IN_ONE => Some(Action::AllInOne),
        MENU_REGION => Some(Action::Region),
        MENU_WINDOW => Some(Action::Window),
        MENU_SCREEN => Some(Action::Screen),
        MENU_REPEAT => Some(Action::Repeat),
        MENU_RECORD => Some(Action::Record),
        MENU_STEPS => Some(Action::Steps),
        MENU_TEXT => Some(Action::Text),
        MENU_COLOUR => Some(Action::Colour),
        _ => id
            .strip_prefix(MENU_MONITOR_PREFIX)
            .and_then(|index| index.parse().ok())
            .map(Action::Monitor),
    }
}

/// The capture and delay a Timed capture item starts, if `id` is one.
fn timed_action_for(id: &str) -> Option<(Action, Duration)> {
    let (what, seconds) = id.strip_prefix(MENU_TIMED_PREFIX)?.split_once('-')?;
    let action = match what {
        "region" => Action::Region,
        "screen" => Action::Screen,
        _ => return None,
    };
    let seconds: u64 = seconds.parse().ok()?;
    Some((action, Duration::from_secs(seconds)))
}

fn timed_submenu(app: &AppHandle) -> tauri::Result<Submenu> {
    let submenu = Submenu::new(app, "Timed capture", true)?;
    for (what, label, seconds) in [
        ("region", "Region", 3),
        ("region", "Region", 5),
        ("region", "Region", 10),
        ("screen", "Screen", 5),
    ] {
        let item = MenuItem::with_id(
            app,
            format!("{MENU_TIMED_PREFIX}{what}-{seconds}"),
            format!("{label} in {seconds} seconds"),
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    Ok(submenu)
}

/// Send feedback: each item opens a GitHub issue form in the browser.
fn feedback_submenu(app: &AppHandle) -> tauri::Result<Submenu> {
    let problem = MenuItem::with_id(
        app,
        MENU_REPORT_PROBLEM,
        "Report a problem…",
        true,
        None::<&str>,
    )?;
    let idea = MenuItem::with_id(
        app,
        MENU_SUGGEST_IDEA,
        "Suggest an idea…",
        true,
        None::<&str>,
    )?;
    Submenu::with_items(app, "Send feedback", true, &[&problem, &idea])
}

/// The Monitor submenu's label for one monitor.
pub fn monitor_label(monitor: &screen::MonitorInfo) -> String {
    let primary = if monitor.is_primary { ", primary" } else { "" };
    format!(
        "{}. {} ({}×{}{primary})",
        monitor.index + 1,
        monitor.name,
        monitor.width,
        monitor.height
    )
}

fn monitor_submenu(app: &AppHandle) -> tauri::Result<Submenu> {
    let submenu = Submenu::new(app, "Monitor", true)?;
    // On Wayland xcap may not list monitors; the portal then lets the user
    // pick one interactively, so a single item is offered.
    let monitors = screen::monitors().unwrap_or_default();
    if monitors.is_empty() {
        let item = MenuItem::with_id(
            app,
            format!("{MENU_MONITOR_PREFIX}0"),
            "Choose a monitor…",
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    for monitor in &monitors {
        let item = MenuItem::with_id(
            app,
            format!("{MENU_MONITOR_PREFIX}{}", monitor.index),
            monitor_label(monitor),
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    Ok(submenu)
}

/// Quits Grab-it, finishing a recording first so its file is complete.
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        crate::record::stop_and_wait(&app);
        app.exit(0);
    });
}

/// Whether a left click on the icon opens the hub. Linux trays do not
/// report clicks, so there the click opens the menu.
const CLICK_OPENS_HUB: bool = cfg!(not(target_os = "linux"));

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let all_in_one = MenuItem::with_id(
        app,
        MENU_ALL_IN_ONE,
        "Capture && record…",
        true,
        None::<&str>,
    )?;
    let region = MenuItem::with_id(app, MENU_REGION, "Capture region", true, None::<&str>)?;
    let window = MenuItem::with_id(app, MENU_WINDOW, "Capture window", true, None::<&str>)?;
    let screen_item = MenuItem::with_id(
        app,
        MENU_SCREEN,
        "Capture screen (all monitors)",
        true,
        None::<&str>,
    )?;
    let monitors = monitor_submenu(app)?;
    let repeat = MenuItem::with_id(app, MENU_REPEAT, "Repeat last region", true, None::<&str>)?;
    let timed = timed_submenu(app)?;
    let tools_separator = PredefinedMenuItem::separator(app)?;
    // One item for both: choosing it during a recording stops the recording.
    let record = MenuItem::with_id(app, MENU_RECORD, RECORD_LABEL, true, None::<&str>)?;
    // Choosing it during a step capture stops it and opens the guide.
    let steps = MenuItem::with_id(app, MENU_STEPS, STEPS_LABEL, true, None::<&str>)?;
    let text = MenuItem::with_id(app, MENU_TEXT, "Capture text", true, None::<&str>)?;
    let colour = MenuItem::with_id(app, MENU_COLOUR, "Pick a colour", true, None::<&str>)?;
    // Disabled until a pin is locked: a locked pin takes no clicks, so this
    // is how it is unlocked.
    let unlock = MenuItem::with_id(
        app,
        MENU_UNLOCK,
        "Unlock pinned captures",
        false,
        None::<&str>,
    )?;
    app.manage(TrayItems {
        chooser: all_in_one.clone(),
        record: record.clone(),
        steps: steps.clone(),
        unlock: unlock.clone(),
    });
    let bindings = crate::hotkeys::effective_hotkeys(app.state());
    set_chooser_binding(app, bindings.get("allInOne").map(String::as_str));
    let separator = PredefinedMenuItem::separator(app)?;
    let last = MenuItem::with_id(app, MENU_LAST, "Show last capture", true, None::<&str>)?;
    let library = MenuItem::with_id(app, MENU_LIBRARY, "Open Grab-it…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    let welcome = MenuItem::with_id(app, MENU_WELCOME, "Shortcuts and tips…", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, MENU_UPDATES, "Check for updates…", true, None::<&str>)?;
    let feedback_menu = feedback_submenu(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Grab-it", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &region,
            &all_in_one,
            &window,
            &screen_item,
            &monitors,
            &repeat,
            &timed,
            &tools_separator,
            &record,
            &steps,
            &text,
            &colour,
            &unlock,
            &separator,
            &last,
            &library,
            &settings,
            &welcome,
            &updates,
            &feedback_menu,
            &separator2,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TOOLTIP)
        .menu(&menu)
        // The click opens the hub; a right-click opens this menu.
        .show_menu_on_left_click(!CLICK_OPENS_HUB)
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Enter { .. }
                | TrayIconEvent::Move { .. }
                | TrayIconEvent::Click { .. } => hover().over(Instant::now()),
                TrayIconEvent::Leave { .. } => hover().leave(Instant::now()),
                _ => {}
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
                && CLICK_OPENS_HUB
            {
                hub::toggle(tray.app_handle(), Some(rect));
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SETTINGS => {
                if let Err(err) = windows::show_settings(app) {
                    eprintln!("Grab-it: could not open Settings: {err}");
                }
            }
            MENU_WELCOME => {
                if let Err(err) = windows::show_welcome(app) {
                    eprintln!("Grab-it: could not open the welcome window: {err}");
                }
            }
            MENU_UPDATES => update::user_check(app),
            MENU_REPORT_PROBLEM => feedback::open(app, feedback::Form::Problem),
            MENU_SUGGEST_IDEA => feedback::open(app, feedback::Form::Idea),
            MENU_UNLOCK => pin::unlock_all(app),
            MENU_LIBRARY => {
                if let Err(err) = windows::show_library(app) {
                    eprintln!("Grab-it: could not open the Library: {err}");
                }
            }
            MENU_LAST => {
                // Off the main thread: the card may need a new window.
                let app = app.clone();
                std::thread::spawn(move || {
                    if !quick::show_last(&app) {
                        quick::show(
                            &app,
                            quick::QuickItem::Notice {
                                title: "No capture yet".into(),
                                message: "Your next capture will show up here.".into(),
                            },
                        );
                    }
                });
            }
            MENU_QUIT => self::quit(app),
            id => {
                if let Some((action, delay)) = timed_action_for(id) {
                    actions::start_after(app, action, delay);
                } else if id == MENU_STEPS {
                    // The clicks on the tray are seen by the session too.
                    crate::steps::toggle(app, crate::steps::Trigger::Click);
                } else if let Some(action) = action_for(id) {
                    actions::start(app, action);
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_count_as_on_the_icon_only_while_hovered() {
        let start = Instant::now();
        let at = |millis: u64| start + Duration::from_millis(millis);
        let mut hover = Hover::default();
        // No hover yet.
        assert!(!over_icon(&hover, at(1000)));

        hover.over(at(1000));
        hover.over(at(1500));
        assert_eq!(hover.since, Some(at(1000)));
        // An open stretch takes clicks in it.
        assert!(over_icon(&hover, at(1000)));
        assert!(over_icon(&hover, at(2000)));
        // A click up to 100 ms before the first event counts, not earlier.
        assert!(over_icon(&hover, at(900)));
        assert!(!over_icon(&hover, at(899)));
        // Hover runs out 10 s after the latest event.
        assert!(over_icon(&hover, at(11_500)));
        assert!(!over_icon(&hover, at(11_501)));

        hover.leave(at(3000));
        assert!(over_icon(&hover, at(2999)));
        assert!(!over_icon(&hover, at(3000)));
        assert!(!over_icon(&hover, at(4000)));

        // Coming back opens a new stretch; the gap is not on the icon.
        hover.over(at(5000));
        assert_eq!(hover.since, Some(at(5000)));
        assert_eq!(hover.left, None);
        assert!(!over_icon(&hover, at(4000)));
        assert!(over_icon(&hover, at(4950)));
        assert!(over_icon(&hover, at(5200)));
    }

    #[test]
    fn menu_ids_map_to_captures() {
        assert_eq!(action_for(MENU_ALL_IN_ONE), Some(Action::AllInOne));
        assert_eq!(action_for(MENU_STEPS), Some(Action::Steps));
        assert_eq!(action_for(MENU_REGION), Some(Action::Region));
        assert_eq!(action_for(MENU_WINDOW), Some(Action::Window));
        assert_eq!(action_for(MENU_SCREEN), Some(Action::Screen));
        assert_eq!(action_for("capture-monitor-2"), Some(Action::Monitor(2)));
        assert_eq!(action_for("capture-monitor-x"), None);
        assert_eq!(action_for(MENU_SETTINGS), None);
        assert_eq!(action_for(MENU_LIBRARY), None);
        assert_eq!(action_for(MENU_REPEAT), Some(Action::Repeat));
        assert_eq!(action_for(MENU_RECORD), Some(Action::Record));
        assert_eq!(action_for(MENU_TEXT), Some(Action::Text));
        assert_eq!(action_for(MENU_COLOUR), Some(Action::Colour));
        assert_eq!(action_for(MENU_LAST), None);
        assert_eq!(action_for(MENU_UPDATES), None);
        assert_eq!(action_for(MENU_UNLOCK), None);
        assert_eq!(action_for(MENU_REPORT_PROBLEM), None);
        assert_eq!(action_for(MENU_SUGGEST_IDEA), None);
        assert_eq!(timed_action_for(MENU_REPORT_PROBLEM), None);
        assert_eq!(timed_action_for(MENU_SUGGEST_IDEA), None);
    }

    #[test]
    fn timed_ids_carry_the_capture_and_the_delay() {
        assert_eq!(
            timed_action_for("timed-region-3"),
            Some((Action::Region, Duration::from_secs(3)))
        );
        assert_eq!(
            timed_action_for("timed-screen-5"),
            Some((Action::Screen, Duration::from_secs(5)))
        );
        assert_eq!(timed_action_for("timed-window-5"), None);
        assert_eq!(timed_action_for("timed-region-soon"), None);
        assert_eq!(timed_action_for(MENU_REGION), None);
        // A timed item is not also an immediate capture.
        assert_eq!(action_for("timed-region-3"), None);
    }

    #[test]
    fn monitor_labels_count_from_one() {
        let monitor = screen::MonitorInfo {
            index: 0,
            name: "DP-1".into(),
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
            scale_factor: 1.0,
            is_primary: true,
        };
        assert_eq!(monitor_label(&monitor), "1. DP-1 (2560×1440, primary)");
    }
}
