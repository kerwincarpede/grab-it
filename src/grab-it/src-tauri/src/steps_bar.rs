//! The step capture pill: a small window at the top centre of the display
//! under the pointer while a step capture runs, saying so, with a Stop
//! button (see src/stepsbar/). It opens when a step capture starts and
//! closes when it stops.
//!
//! Like the recording toolbar it is kept out of screen captures where the
//! system allows (`content_protected`), so it is not in the steps' frames.
//! X11 has no such thing. Clicks on it are Grab-it's own, which step
//! capture never takes as steps.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::record_bar::{self, Display};

pub const LABEL: &str = "steps-bar";
/// The window's size in points: the pill and the room for its shadow
/// around it (`.stepsbar` padding in src/stepsbar/stepsbar.css).
const SIZE: (f64, f64) = (236.0, 56.0);

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// The pill's top-left corner and size in physical pixels on `display`:
/// at the top centre of its work area, the spot the recording toolbar
/// opens at when it has none saved.
pub fn placement(display: &Display) -> ((i32, i32), (u32, u32)) {
    let scale = valid_scale(display.scale);
    let size = (
        (SIZE.0 * scale).round() as u32,
        (SIZE.1 * scale).round() as u32,
    );
    (record_bar::position_at(None, size, display), size)
}

/// The display the pointer is on, else the primary one, else the first.
fn pointer_display(app: &AppHandle) -> Option<Display> {
    let monitors = app.available_monitors().unwrap_or_default();
    let listed = crate::screen::monitors().unwrap_or_default();
    listed
        .iter()
        .find(|monitor| record_bar::pointer_on(app, monitor))
        .and_then(|monitor| record_bar::monitor_for(monitor, &monitors))
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned())
        .map(|monitor| record_bar::display_of(&monitor))
}

/// Opens the pill, unless it is open already. Call this off the main
/// thread.
pub fn show(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    let Some(display) = pointer_display(app) else {
        eprintln!("Grab-it: no display to show the step capture pill on");
        return;
    };
    if let Err(err) = create(app, &display) {
        eprintln!("Grab-it: could not show the step capture pill: {err}");
    }
}

fn create(app: &AppHandle, display: &Display) -> tauri::Result<()> {
    let scale = valid_scale(display.scale);
    let (position, size) = placement(display);
    let window =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/stepsbar".into()))
            .title("Grab-it step capture")
            .inner_size(SIZE.0, SIZE.1)
            .decorations(false)
            // See-through, so only the rounded pill shows.
            .transparent(true)
            // As the recording toolbar: GTK keeps a window that may not be
            // resized no smaller than the webview's minimum.
            .resizable(cfg!(target_os = "linux"))
            .min_inner_size(1.0, 1.0)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            // Left out of screen captures where the system allows, so it is
            // not in the steps.
            .content_protected(true)
            // It must not pull the keyboard away from the task being shown.
            .focused(false)
            .shadow(false)
            .visible(false)
            .build()?;
    let position = PhysicalPosition::new(position.0, position.1);
    let size = PhysicalSize::new(size.0, size.1);
    // Sized before it is placed, and on macOS in the display's points, as
    // the recording toolbar is (see `record_bar::place`).
    #[cfg(target_os = "macos")]
    {
        let (position, size) = crate::overlay::logical_frame(position, size, scale);
        window.set_size(size)?;
        window.set_position(position)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        window.set_size(size)?;
        window.set_position(position)?;
    }
    window.show()?;
    Ok(())
}

/// Closes the pill, if it is open.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the step capture pill: {err}");
    }
}

/// Stops the step capture under way from the pill's Stop. As from the
/// keyboard: the click landed on Grab-it, which step capture never takes,
/// so no step before it is dropped as a stopping click.
#[tauri::command]
pub fn steps_bar_stop(app: AppHandle) {
    if crate::steps::is_running() {
        crate::steps::toggle(&app, crate::steps::Trigger::Keys);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(size, (236, 56));
        assert_eq!(x, (1920 - 236) / 2);
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
        assert_eq!(size, (472, 112));
        assert_eq!(x, 2560 + (5120 - 472) / 2);
        assert_eq!(y, 50 + 24);
    }

    #[test]
    fn the_pill_stays_inside_a_work_area_smaller_than_it() {
        let work = Area {
            x: -400,
            y: 0,
            width: 200,
            height: 40,
        };
        let ((x, y), _) = placement(&display(work, 1.0));
        assert_eq!((x, y), (-400, 0));
    }

    #[test]
    fn a_scale_that_is_not_a_number_counts_as_one() {
        let work = Area {
            x: 0,
            y: 0,
            width: 1000,
            height: 800,
        };
        let (_, size) = placement(&display(work, f64::NAN));
        assert_eq!(size, (236, 56));
    }
}
