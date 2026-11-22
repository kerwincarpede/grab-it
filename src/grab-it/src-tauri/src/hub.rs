//! The menu bar hub: a small window under the tray icon with the capture
//! buttons, the latest captures and a way into the Grab-it window. Clicking
//! the tray icon opens it; the full menu stays on a right-click.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Emitter, Manager, Rect, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::rt::{AppHandle, WebviewWindow};
use crate::windows::E2eBrowserArgs;
use crate::{
    actions::{self, Action},
    screen, tray, update,
    windows::{self, MainView},
};

pub const LABEL: &str = "hub";
/// Emitted to the hub each time it is shown, so it can refresh.
pub const HUB_SHOWN_EVENT: &str = "hub-shown";
/// Emitted to the hub with a [`HubActivity`] when a recording or a step
/// capture starts or stops. Mirrors `HUB_ACTIVITY_EVENT` in src/hub/api.ts.
pub const HUB_ACTIVITY_EVENT: &str = "hub-activity";

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
        let zoom = zoom(app);
        place(app, &window, anchor, zoom);
        let _ = window.emit(HUB_SHOWN_EVENT, ());
        let _ = window.show();
        let _ = focus(&window);
        return;
    }
    if let Err(err) = create(app, anchor) {
        eprintln!("Grab-it: could not open the menu bar hub: {err}");
    }
}

/// The hub's zoom from Settings → Appearance.
fn zoom(app: &AppHandle) -> f64 {
    app.try_state::<crate::commands::SettingsState>()
        .map(|state| crate::commands::lock(&state).get().appearance.hub_zoom())
        .unwrap_or_else(|| crate::settings::Appearance::default().hub_zoom())
}

/// Sizes the hub for `zoom` and draws its page at that zoom, so a larger
/// text size gets a larger window rather than a cut-off menu.
fn apply_zoom(window: &WebviewWindow, zoom: f64) -> tauri::Result<()> {
    window.set_size(tauri::LogicalSize::new(WIDTH * zoom, HEIGHT * zoom))?;
    window.set_zoom(zoom)?;
    #[cfg(target_os = "macos")]
    windows::round_corners(window, CORNER_RADIUS * zoom)?;
    Ok(())
}

/// Applies a changed hub size to the hub, when it exists.
pub fn resize(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = apply_zoom(&window, zoom(app))
    {
        eprintln!("Grab-it: could not resize the menu bar hub: {err}");
    }
}

fn create(app: &AppHandle, anchor: Option<Rect>) -> tauri::Result<()> {
    let zoom = zoom(app);
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/hub".into()))
        .e2e_browser_args()
        .title("Grab-it")
        .inner_size(WIDTH * zoom, HEIGHT * zoom)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(true)
        .visible(false);
    // Not focused: wry activates Grab-it for a focused webview as it is
    // made. `panel::focus` gives the page the keyboard instead.
    #[cfg(target_os = "macos")]
    let builder = builder.focused(false);
    let window = builder.build()?;
    // A panel, so opening the hub does not activate Grab-it and bring the
    // library or Settings forward with it. It still hides when another app
    // or window takes the focus.
    #[cfg(target_os = "macos")]
    crate::panel::make_panel(&window)?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
            if let Ok(mut at) = handle.state::<HubState>().hidden_at.lock() {
                *at = Some(Instant::now());
            }
        }
    });
    apply_zoom(&window, zoom)?;
    place(app, &window, anchor, zoom);
    window.show()?;
    focus(&window)
}

/// Gives the shown hub the keyboard, on macOS without activating Grab-it
/// ([`crate::panel`]).
fn focus(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return crate::panel::focus(window);
    #[cfg(not(target_os = "macos"))]
    window.set_focus()
}

/// The hub's corner radius at actual size, in points. Matches `.hub` in
/// src/hub/hub.css, which zooms with the page.
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 12.0;

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Puts the hub under the tray icon (or above it, when the tray is at the
/// bottom of the screen, as on Windows), inside the icon's monitor.
fn place(app: &AppHandle, window: &WebviewWindow, anchor: Option<Rect>, zoom: f64) {
    let Some(anchor) = anchor else {
        let _ = window.center();
        return;
    };
    let position = anchor.position.to_physical::<f64>(1.0);
    let size = anchor.size.to_physical::<f64>(1.0);
    let icon = Bounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if !place_under(app, window, icon, zoom) {
        let _ = window.center();
    }
}

/// macOS: the icon's rect is in physical pixels at the icon window's scale,
/// which Grab-it is not told, while monitors are looked up in logical points.
/// So the display is picked per its own scale, and the hub is placed in
/// points on it.
#[cfg(target_os = "macos")]
fn place_under(app: &AppHandle, window: &WebviewWindow, icon: Bounds, zoom: f64) -> bool {
    let monitors = app.available_monitors().unwrap_or_default();
    let displays: Vec<Display> = monitors.iter().map(display_of).collect();
    let monitor = match icon_display(icon, &displays) {
        Some(index) => monitors[index].clone(),
        None => match app.primary_monitor().ok().flatten() {
            Some(monitor) => monitor,
            None => return false,
        },
    };
    let display = display_of(&monitor);
    let scale = display.scale;
    let area = monitor.work_area();
    let area = Bounds {
        x: f64::from(area.position.x) / scale,
        y: f64::from(area.position.y) / scale,
        width: f64::from(area.size.width) / scale,
        height: f64::from(area.size.height) / scale,
    };
    let icon = Bounds {
        x: icon.x / scale,
        y: icon.y / scale,
        width: icon.width / scale,
        height: icon.height / scale,
    };
    let (x, y) = hub_position(
        icon,
        (WIDTH * zoom, HEIGHT * zoom),
        GAP,
        area,
        display.bounds.y + display.bounds.height / 2.0,
    );
    let _ = window.set_position(tauri::LogicalPosition::new(x.round(), y.round()));
    true
}

/// Windows and Linux: the icon's rect and the monitors are both in physical
/// pixels, so the hub is placed in pixels.
#[cfg(not(target_os = "macos"))]
fn place_under(app: &AppHandle, window: &WebviewWindow, icon: Bounds, zoom: f64) -> bool {
    let Some(monitor) = app
        .monitor_from_point(icon.x, icon.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return false;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let screen = monitor.size();
    let origin = monitor.position();
    let (x, y) = hub_position(
        icon,
        (WIDTH * zoom * scale, HEIGHT * zoom * scale),
        GAP * scale,
        Bounds {
            x: f64::from(area.position.x),
            y: f64::from(area.position.y),
            width: f64::from(area.size.width),
            height: f64::from(area.size.height),
        },
        f64::from(origin.y) + f64::from(screen.height) / 2.0,
    );
    let _ = window.set_position(tauri::PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ));
    true
}

/// A display's frame in logical points, and its scale.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Display {
    bounds: Bounds,
    scale: f64,
}

#[cfg(target_os = "macos")]
fn display_of(monitor: &tauri::Monitor) -> Display {
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    Display {
        bounds: Bounds {
            x: f64::from(position.x) / scale,
            y: f64::from(position.y) / scale,
            width: f64::from(size.width) / scale,
            height: f64::from(size.height) / scale,
        },
        scale,
    }
}

/// Which of `displays` holds the menu-bar icon whose rect `icon` is in
/// physical pixels at the scale of the display it is on. A display is a
/// candidate when the icon's centre, in its points, lies across its width;
/// of those, the one whose top is nearest the icon wins, since an
/// auto-hidden menu bar puts the icon just above its display.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn icon_display(icon: Bounds, displays: &[Display]) -> Option<usize> {
    let centre = icon.x + icon.width / 2.0;
    displays
        .iter()
        .enumerate()
        .filter(|(_, display)| {
            let x = centre / display.scale;
            x >= display.bounds.x && x < display.bounds.x + display.bounds.width
        })
        .map(|(index, display)| (index, (icon.y / display.scale - display.bounds.y).abs()))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(index, _)| index)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Where the hub's top-left corner goes, in the units of its arguments
/// (physical pixels, or points on macOS): centred on
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
/// `allInOne`, `window`, `screen`, `monitor`, `repeat`, `record`, `text`, `colour` or `steps`.
#[tauri::command]
#[specta::specta]
pub fn hub_capture(
    kind: String,
    delay_seconds: Option<u64>,
    monitor: Option<usize>,
    app: AppHandle,
) -> Result<(), String> {
    if kind == "steps" {
        // Started or stopped once the hub is hidden; the clicks that opened
        // it and pressed the button are not steps.
        hide(&app);
        std::thread::spawn(move || {
            std::thread::sleep(HIDE_SETTLE);
            crate::steps::toggle(&app, crate::steps::Trigger::Click);
        });
        return Ok(());
    }
    let action = match kind.as_str() {
        "allInOne" => Action::AllInOne,
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
    // Every capture, Capture & record included, starts once the hub has
    // hidden and the window under it has the focus. Claiming the chooser
    // while the hub was still hiding left it unopened on macOS when the
    // Library was open.
    hide(&app);
    // A timed capture's countdown covers the hub hiding, so its pill
    // counts the whole seconds asked for.
    let delay = match delay_seconds.unwrap_or(0).min(60) {
        0 => HIDE_SETTLE,
        seconds => Duration::from_secs(seconds),
    };
    actions::start_after(&app, action, delay);
    Ok(())
}

/// What is running, so the hub's Record and Step capture items can say
/// Stop. Mirrors `HubActivity` in src/hub/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct HubActivity {
    /// A recording is under way, counting down included.
    recording: bool,
    /// A step capture is under way.
    steps: bool,
}

fn activity(app: &AppHandle) -> HubActivity {
    HubActivity {
        recording: crate::record::session(app).is_some(),
        steps: crate::steps::is_running(),
    }
}

/// Tells an open hub that a recording or a step capture started or
/// stopped, so it updates at once.
pub fn activity_changed(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, HUB_ACTIVITY_EVENT, activity(app));
    }
}

#[tauri::command]
#[specta::specta]
pub fn hub_activity(app: AppHandle) -> HubActivity {
    activity(&app)
}

/// A monitor the hub offers to capture.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct HubMonitor {
    index: usize,
    label: String,
}

#[tauri::command]
#[specta::specta]
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

/// Opens the Grab-it window on `view`: `library`, `settings`,
/// `ai-settings` (Settings at AI integration) or `welcome`.
#[tauri::command]
#[specta::specta]
pub fn hub_open(view: String, app: AppHandle) -> Result<(), String> {
    let view = match view.as_str() {
        "library" => MainView::Library,
        "settings" => MainView::Settings,
        "ai-settings" => MainView::AiSettings,
        "welcome" => MainView::Welcome,
        other => return Err(format!("unknown view: {other}")),
    };
    // Off the main thread: a window must not be created from inside a
    // synchronous command. The hub hides only once the window is up: hiding
    // Grab-it's only focused window first lets macOS make another app active,
    // and from the background Grab-it may not get to bring the window forward.
    std::thread::spawn(move || {
        if let Err(err) = windows::show_main(&app, view) {
            eprintln!("Grab-it: {err}");
        }
        hide(&app);
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn hub_check_updates(app: AppHandle) {
    hide(&app);
    update::user_check(&app);
}

#[tauri::command]
#[specta::specta]
pub fn hub_quit(app: AppHandle) {
    hide(&app);
    tray::quit(&app);
}

#[tauri::command]
#[specta::specta]
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

    /// The displays in #206, in points: two Retina DELLs side by side with
    /// the menu bar on the left one, and a scale-1 LG above both.
    fn displays_206() -> Vec<Display> {
        let display = |x, y, width, height, scale| Display {
            bounds: Bounds {
                x,
                y,
                width,
                height,
            },
            scale,
        };
        vec![
            display(0.0, 0.0, 3008.0, 1692.0, 2.0),
            display(3008.0, 0.0, 3008.0, 1692.0, 2.0),
            display(1640.0, -1080.0, 2560.0, 1080.0, 1.0),
        ]
    }

    /// The menu-bar icon's rect in physical pixels at scale 2, at `y`.
    fn icon_206(y: f64) -> Bounds {
        Bounds {
            x: 4080.0,
            y,
            width: 70.0,
            height: 54.0,
        }
    }

    #[test]
    fn the_icon_is_on_the_main_display_with_the_menu_bar_shown() {
        assert_eq!(icon_display(icon_206(0.0), &displays_206()), Some(0));
    }

    #[test]
    fn the_icon_is_on_the_main_display_with_the_menu_bar_hidden() {
        assert_eq!(icon_display(icon_206(-54.0), &displays_206()), Some(0));
    }

    #[test]
    fn no_display_holds_an_icon_off_every_display() {
        let icon = Bounds {
            x: 20000.0,
            ..icon_206(0.0)
        };
        assert_eq!(icon_display(icon, &displays_206()), None);
        assert_eq!(icon_display(icon_206(0.0), &[]), None);
    }

    #[test]
    fn hub_centres_under_the_icon_in_points() {
        let displays = displays_206();
        let display = displays[icon_display(icon_206(-54.0), &displays).unwrap()];
        let scale = display.scale;
        let icon = icon_206(-54.0);
        let icon = Bounds {
            x: icon.x / scale,
            y: icon.y / scale,
            width: icon.width / scale,
            height: icon.height / scale,
        };
        let (x, y) = hub_position(
            icon,
            (WIDTH, HEIGHT),
            GAP,
            display.bounds,
            display.bounds.y + display.bounds.height / 2.0,
        );
        assert_eq!(x, 2040.0 + 35.0 / 2.0 - WIDTH / 2.0);
        assert_eq!(y, GAP);
        assert!(x >= 0.0 && x + WIDTH <= 3008.0);
    }
}
