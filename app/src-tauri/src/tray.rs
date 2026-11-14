//! The tray icon and its menu.

use std::time::Duration;

use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::{
    actions::{self, Action},
    hub, quick, screen, update, windows,
};

const TRAY_ID: &str = "main";
const RECORD_LABEL: &str = "Record GIF";
const STOP_LABEL: &str = "Stop recording";

/// The menu items whose text changes while Grab-it runs.
pub struct TrayItems {
    record: MenuItem<tauri::Wry>,
}

/// Makes the record item say what choosing it does now: start, or stop.
pub fn set_recording(app: &AppHandle, recording: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let label = if recording { STOP_LABEL } else { RECORD_LABEL };
        if let Err(err) = items.record.set_text(label) {
            eprintln!("Grab-it: could not update the tray menu: {err}");
        }
    }
}
const MENU_REGION: &str = "capture-region";
const MENU_WINDOW: &str = "capture-window";
const MENU_SCREEN: &str = "capture-screen";
const MENU_MONITOR_PREFIX: &str = "capture-monitor-";
const MENU_REPEAT: &str = "capture-repeat";
const MENU_RECORD: &str = "record-gif";
const MENU_TEXT: &str = "capture-text";
const MENU_COLOUR: &str = "pick-colour";
/// Timed captures are `timed-<region|screen>-<seconds>`.
const MENU_TIMED_PREFIX: &str = "timed-";
const MENU_LAST: &str = "last-capture";
const MENU_LIBRARY: &str = "library";
const MENU_SETTINGS: &str = "settings";
const MENU_WELCOME: &str = "welcome";
const MENU_UPDATES: &str = "check-updates";
const MENU_QUIT: &str = "quit";

/// The capture a menu item starts, if any.
fn action_for(id: &str) -> Option<Action> {
    match id {
        MENU_REGION => Some(Action::Region),
        MENU_WINDOW => Some(Action::Window),
        MENU_SCREEN => Some(Action::Screen),
        MENU_REPEAT => Some(Action::Repeat),
        MENU_RECORD => Some(Action::Record),
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

fn timed_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
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

fn monitor_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
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

/// Quits Grab-it, finishing a recording first so its GIF is complete.
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
    app.manage(TrayItems {
        record: record.clone(),
    });
    let text = MenuItem::with_id(app, MENU_TEXT, "Capture text", true, None::<&str>)?;
    let colour = MenuItem::with_id(app, MENU_COLOUR, "Pick a colour", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let last = MenuItem::with_id(app, MENU_LAST, "Show last capture", true, None::<&str>)?;
    let library = MenuItem::with_id(app, MENU_LIBRARY, "Open Grab-it…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    let welcome = MenuItem::with_id(app, MENU_WELCOME, "Shortcuts and tips…", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, MENU_UPDATES, "Check for updates…", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Grab-it", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &region,
            &window,
            &screen_item,
            &monitors,
            &repeat,
            &timed,
            &tools_separator,
            &record,
            &text,
            &colour,
            &separator,
            &last,
            &library,
            &settings,
            &welcome,
            &updates,
            &separator2,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Grab-it")
        .menu(&menu)
        // The click opens the hub; a right-click opens this menu.
        .show_menu_on_left_click(!CLICK_OPENS_HUB)
        .on_tray_icon_event(|tray, event| {
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
    fn menu_ids_map_to_captures() {
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
