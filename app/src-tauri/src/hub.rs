//! The menu bar hub: a small window under the tray icon with the capture
//! buttons, the latest captures and a way into the Grab-it window. Clicking
//! the tray icon opens it; the full menu stays on a right-click.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    actions::{self, Action},
    screen, tray, update,
    windows::{self, MainView},
};

pub const LABEL: &str = "hub";
/// Emitted to the hub each time it is shown, so it can refresh.
pub const HUB_SHOWN_EVENT: &str = "hub-shown";

/// The hub's size in logical pixels.
const WIDTH: f64 = 320.0;
const HEIGHT: f64 = 540.0;
/// The gap between the tray icon and the hub, in logical pixels.
const GAP: f64 = 6.0;
/// A capture waits this long after the hub hides, so it is not in the shot.
const HIDE_SETTLE: Duration = Duration::from_millis(180);
/// A tray click this soon after the hub hid on losing focus was the click
/// that took the focus away: it closes the hub rather than reopening it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

/// When the hub last hid because it lost focus.
#[derive(Default)]
pub struct HubState {
    hidden_at: Mutex<Option<Instant>>,
}

/// Opens the hub under `anchor` (the tray icon's rectangle), or closes it.
pub fn toggle(app: &AppHandle, anchor: Option<Rect>) {
    let just_hidden = app
        .state::<HubState>()
        .hidden_at
        .lock()
        .map(|at| at.is_some_and(|at| at.elapsed() < REOPEN_GUARD))
        .unwrap_or(false);
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) || just_hidden {
            let _ = window.hide();
            return;
        }
        place(app, &window, anchor);
        let _ = window.emit(HUB_SHOWN_EVENT, ());
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if let Err(err) = create(app, anchor) {
        eprintln!("Grab-it: could not open the menu bar hub: {err}");
    }
}

fn create(app: &AppHandle, anchor: Option<Rect>) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/hub".into()))
        .title("Grab-it")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(true)
        .visible(false)
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
            if let Ok(mut at) = handle.state::<HubState>().hidden_at.lock() {
                *at = Some(Instant::now());
            }
        }
    });
    #[cfg(target_os = "macos")]
    round_corners(&window)?;
    place(app, &window, anchor);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// The hub's corner radius, in points. Matches `.hub` in src/hub/hub.css.
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 12.0;

/// macOS: rounds the hub like a menu. The window is made see-through and
/// its content clipped to rounded corners, so this needs no private API;
/// the shadow is then redrawn to follow the new shape.
#[cfg(target_os = "macos")]
fn round_corners(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use objc2::runtime::AnyObject;

    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread. Each selector is a documented NSWindow, NSView,
        // NSColor or CALayer method with the argument types given.
        unsafe {
            let clear: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), clearColor];
            let _: () = objc2::msg_send![ns_window, setOpaque: false];
            let _: () = objc2::msg_send![ns_window, setBackgroundColor: clear];
            let view: *mut AnyObject = objc2::msg_send![ns_window, contentView];
            if view.is_null() {
                return;
            }
            let _: () = objc2::msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = objc2::msg_send![view, layer];
            if layer.is_null() {
                return;
            }
            let _: () = objc2::msg_send![layer, setCornerRadius: CORNER_RADIUS];
            let _: () = objc2::msg_send![layer, setMasksToBounds: true];
            let _: () = objc2::msg_send![ns_window, invalidateShadow];
        }
    })
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Puts the hub under the tray icon (or above it, when the tray is at the
/// bottom of the screen, as on Windows), inside the icon's monitor.
fn place(app: &AppHandle, window: &WebviewWindow, anchor: Option<Rect>) {
    let Some(anchor) = anchor else {
        let _ = window.center();
        return;
    };
    let position = anchor.position.to_physical::<f64>(1.0);
    let size = anchor.size.to_physical::<f64>(1.0);
    let Some(monitor) = app
        .monitor_from_point(position.x, position.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        let _ = window.center();
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let screen = monitor.size();
    let origin = monitor.position();
    let (x, y) = hub_position(
        Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        (WIDTH * scale, HEIGHT * scale),
        GAP * scale,
        Bounds {
            x: f64::from(area.position.x),
            y: f64::from(area.position.y),
            width: f64::from(area.size.width),
            height: f64::from(area.size.height),
        },
        f64::from(origin.y) + f64::from(screen.height) / 2.0,
    );
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Where the hub's top-left corner goes, in physical pixels: centred on
/// the icon, below it when the icon is in the top half of the screen and
/// above it otherwise, and kept inside the work area.
fn hub_position(
    icon: Bounds,
    (width, height): (f64, f64),
    gap: f64,
    area: Bounds,
    screen_middle: f64,
) -> (f64, f64) {
    let centred = icon.x + icon.width / 2.0 - width / 2.0;
    let max_x = (area.x + area.width - width - gap).max(area.x);
    let x = centred.clamp(area.x + gap, max_x);
    let below = icon.y + icon.height / 2.0 < screen_middle;
    let y = if below {
        (icon.y + icon.height + gap).max(area.y + gap)
    } else {
        (icon.y - height - gap).min(area.y + area.height - height - gap)
    };
    (x, y)
}

/// Starts a capture from the hub once it has hidden. `kind` is `region`,
/// `window`, `screen`, `monitor`, `repeat`, `record`, `text` or `colour`.
#[tauri::command]
pub fn hub_capture(
    kind: String,
    delay_seconds: Option<u64>,
    monitor: Option<usize>,
    app: AppHandle,
) -> Result<(), String> {
    let action = match kind.as_str() {
        "region" => Action::Region,
        "window" => Action::Window,
        "screen" => Action::Screen,
        "monitor" => Action::Monitor(monitor.ok_or("which monitor?")?),
        "repeat" => Action::Repeat,
        "record" => Action::Record,
        "text" => Action::Text,
        "colour" => Action::Colour,
        other => return Err(format!("unknown capture: {other}")),
    };
    hide(&app);
    let delay = HIDE_SETTLE + Duration::from_secs(delay_seconds.unwrap_or(0).min(60));
    actions::start_after(&app, action, delay);
    Ok(())
}

/// A monitor the hub offers to capture.
#[derive(Debug, Clone, Serialize)]
pub struct HubMonitor {
    index: usize,
    label: String,
}

#[tauri::command]
pub fn hub_monitors() -> Vec<HubMonitor> {
    screen::monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| HubMonitor {
            index: monitor.index,
            label: tray::monitor_label(monitor),
        })
        .collect()
}

/// Opens the Grab-it window on `view`: `library`, `settings` or `welcome`.
#[tauri::command]
pub fn hub_open(view: String, app: AppHandle) -> Result<(), String> {
    let view = match view.as_str() {
        "library" => MainView::Library,
        "settings" => MainView::Settings,
        "welcome" => MainView::Welcome,
        other => return Err(format!("unknown view: {other}")),
    };
    hide(&app);
    // Off the main thread: a window must not be created from inside a
    // synchronous command.
    std::thread::spawn(move || {
        if let Err(err) = windows::show_main(&app, view) {
            eprintln!("Grab-it: {err}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn hub_check_updates(app: AppHandle) {
    hide(&app);
    update::user_check(&app);
}

#[tauri::command]
pub fn hub_quit(app: AppHandle) {
    hide(&app);
    tray::quit(&app);
}

#[tauri::command]
pub fn hub_hide(app: AppHandle) {
    hide(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Bounds = Bounds {
        x: 0.0,
        y: 50.0,
        width: 3000.0,
        height: 1900.0,
    };

    fn icon(x: f64, y: f64) -> Bounds {
        Bounds {
            x,
            y,
            width: 50.0,
            height: 50.0,
        }
    }

    #[test]
    fn hub_hangs_under_a_menu_bar_icon() {
        let (x, y) = hub_position(icon(2000.0, 0.0), (720.0, 984.0), 12.0, AREA, 1000.0);
        assert_eq!(x, 2025.0 - 360.0);
        assert_eq!(y, 62.0);
    }

    #[test]
    fn hub_stays_on_screen_near_the_right_edge() {
        let (x, _) = hub_position(icon(2950.0, 0.0), (720.0, 984.0), 12.0, AREA, 1000.0);
        assert_eq!(x, 3000.0 - 720.0 - 12.0);
    }

    #[test]
    fn hub_sits_above_a_taskbar_icon() {
        let area = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        let (_, y) = hub_position(icon(1700.0, 1046.0), (360.0, 492.0), 6.0, area, 540.0);
        assert_eq!(y, 1040.0 - 492.0 - 6.0);
    }
}
