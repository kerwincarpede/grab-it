//! The tray icon and its menu.

use tauri::{
    AppHandle,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
};

use crate::{
    actions::{self, Action},
    screen, windows,
};

const TRAY_ID: &str = "main";
const MENU_REGION: &str = "capture-region";
const MENU_WINDOW: &str = "capture-window";
const MENU_SCREEN: &str = "capture-screen";
const MENU_MONITOR_PREFIX: &str = "capture-monitor-";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";

/// The capture a menu item starts, if any.
fn action_for(id: &str) -> Option<Action> {
    match id {
        MENU_REGION => Some(Action::Region),
        MENU_WINDOW => Some(Action::Window),
        MENU_SCREEN => Some(Action::Screen),
        _ => id
            .strip_prefix(MENU_MONITOR_PREFIX)
            .and_then(|index| index.parse().ok())
            .map(Action::Monitor),
    }
}

/// The Monitor submenu's label for one monitor.
fn monitor_label(monitor: &screen::MonitorInfo) -> String {
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

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let region = MenuItem::with_id(app, MENU_REGION, "Region", true, None::<&str>)?;
    let window = MenuItem::with_id(app, MENU_WINDOW, "Window", true, None::<&str>)?;
    let screen_item = MenuItem::with_id(
        app,
        MENU_SCREEN,
        "Screen (all monitors)",
        true,
        None::<&str>,
    )?;
    let monitors = monitor_submenu(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Grab-it", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &region,
            &window,
            &screen_item,
            &monitors,
            &separator,
            &settings,
            &separator2,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Grab-it")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SETTINGS => {
                if let Err(err) = windows::show_settings(app) {
                    eprintln!("Grab-it: could not open Settings: {err}");
                }
            }
            MENU_QUIT => app.exit(0),
            id => {
                if let Some(action) = action_for(id) {
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
