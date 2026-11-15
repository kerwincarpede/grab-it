//! The recorded-area outline: while a recording runs, a see-through
//! window around the recorded area draws a thin dashed red edge with solid
//! corner brackets, and the big countdown number in its middle before the
//! first frame (see src/recordframe/).
//!
//! The window is the recorded area grown by [`MARGIN`] on every side, and
//! the page draws only in that margin, so the outline never lands in the
//! video even where the window cannot be left out of it. Clicks pass
//! straight through it. A window's area is drawn with rounded corners; a
//! whole display has no room around it, so it gets only brackets in its
//! corners, inside the area: Windows and macOS leave the window out of the
//! capture (`content_protected`), and elsewhere the brackets go once the
//! countdown ends, so they are not recorded.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::{capture::Rect, screen::MonitorInfo, settings::RecordingSource};

pub const LABEL: &str = "record-frame";
/// The room around the recorded area that the outline is drawn in, in points.
const MARGIN: f64 = 6.0;

/// How the outline is drawn. Mirrors `FrameShape` in src/recordframe/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// A dragged region: a square dashed edge with brackets.
    Region,
    /// A picked window's area: the edge and brackets rounded at its corners.
    Window,
    /// A whole display: brackets in its corners only.
    Screen,
}

impl Shape {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Region => "region",
            Self::Window => "window",
            Self::Screen => "screen",
        }
    }
}

/// The outline for a recording of `rect` of a monitor's image of
/// `image_size` pixels, picked from the setup toolbar's `source`: the
/// Window and Screen sources reach the backend as a plain rectangle, so a
/// rectangle covering the whole image is a display whatever was picked.
pub fn shape_for(rect: Rect, image_size: (u32, u32), source: RecordingSource) -> Shape {
    let whole = rect.x <= 0
        && rect.y <= 0
        && i64::from(rect.x) + i64::from(rect.width) >= i64::from(image_size.0)
        && i64::from(rect.y) + i64::from(rect.height) >= i64::from(image_size.1);
    if whole {
        return Shape::Screen;
    }
    match source {
        RecordingSource::Window => Shape::Window,
        RecordingSource::Region | RecordingSource::Screen => Shape::Region,
    }
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// The room around the area for `shape` at `scale`, in physical pixels:
/// none around a whole display, which has nothing beyond it to draw on.
fn margin_px(shape: Shape, scale: f64) -> u32 {
    match shape {
        Shape::Screen => 0,
        Shape::Region | Shape::Window => (MARGIN * valid_scale(scale)).round() as u32,
    }
}

/// The window's top-left corner and size, in physical pixels, for an area
/// at `origin` of `size` with `margin` pixels all round it.
pub fn frame_around(origin: (i32, i32), size: (u32, u32), margin: u32) -> ((i32, i32), (u32, u32)) {
    (
        (origin.0 - margin as i32, origin.1 - margin as i32),
        (size.0 + 2 * margin, size.1 + 2 * margin),
    )
}

/// The page, told the shape, the margin in CSS pixels and whether the
/// window is left out of the capture, so it needs nothing else to draw.
fn page_url(shape: Shape, margin: f64, protected: bool) -> String {
    format!(
        "index.html#/recordframe?shape={}&margin={}&protected={}",
        shape.as_str(),
        margin,
        if protected { 1 } else { 0 }
    )
}

/// Opens the outline around `rect`, an area of `monitor`'s image of
/// `image_size` pixels, drawn as `shape`. An outline already open (a
/// recording started again on the same area) stays. Call this off the
/// main thread.
pub fn show(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    shape: Shape,
) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        return;
    }
    if let Err(err) = create(app, monitor, image_size, rect, shape) {
        eprintln!("Grab-it: could not show the recorded area's outline: {err}");
    }
}

fn create(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    shape: Shape,
) -> tauri::Result<()> {
    let placements = app.available_monitors().unwrap_or_default();
    let (origin, size) = crate::overlay::placement_for(monitor, &placements);
    let (area_origin, area_size) = crate::webcam::screen_area(
        rect,
        image_size,
        (origin.x, origin.y),
        (size.width, size.height),
    );
    let scale = valid_scale(monitor.scale_factor);
    let margin = margin_px(shape, scale);
    let (position, frame_size) = frame_around(area_origin, area_size, margin);
    let protected = cfg!(any(target_os = "macos", target_os = "windows"));
    let url = page_url(shape, f64::from(margin) / scale, protected);
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("Grab-it recorded area")
        // Built at its size: GTK keeps a window that may not be resized at
        // the size it was built with, and ignores a later set_size.
        .inner_size(
            f64::from(frame_size.0) / scale,
            f64::from(frame_size.1) / scale,
        )
        .decorations(false)
        // See-through, so only the outline shows.
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // Left out of screen captures where the system allows.
        .content_protected(true)
        // The outline must not pull the keyboard away from what is recorded.
        .focused(false)
        .shadow(false)
        .visible(false)
        .build()?;
    // Sized again in physical pixels, for a monitor whose scale differs
    // from the one the window was built on, and before it is placed:
    // macOS resizes a window around its bottom-left corner (see overlay.rs).
    window.set_size(PhysicalSize::new(frame_size.0, frame_size.1))?;
    window.set_position(PhysicalPosition::new(position.0, position.1))?;
    window.show()?;
    // Clicks pass straight through to what is recorded. Set once it is
    // shown: GTK applies it to the window the system has made by then.
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

/// Closes the outline, if it is open.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the recorded area's outline: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_whole_display_is_a_screen_whatever_was_picked() {
        let size = (2560, 1440);
        let whole = rect(0, 0, 2560, 1440);
        assert_eq!(
            shape_for(whole, size, RecordingSource::Screen),
            Shape::Screen
        );
        assert_eq!(
            shape_for(whole, size, RecordingSource::Region),
            Shape::Screen
        );
        assert_eq!(
            shape_for(whole, size, RecordingSource::Window),
            Shape::Screen
        );
    }

    #[test]
    fn a_part_of_the_display_is_a_window_or_a_region() {
        let size = (2560, 1440);
        let part = rect(100, 80, 1280, 720);
        assert_eq!(
            shape_for(part, size, RecordingSource::Window),
            Shape::Window
        );
        assert_eq!(
            shape_for(part, size, RecordingSource::Region),
            Shape::Region
        );
        assert_eq!(
            shape_for(part, size, RecordingSource::Screen),
            Shape::Region
        );
        // A window filling the display's width but not its height.
        assert_eq!(
            shape_for(rect(0, 40, 2560, 1400), size, RecordingSource::Window),
            Shape::Window
        );
    }

    #[test]
    fn the_window_grows_by_the_margin_on_every_side() {
        assert_eq!(
            frame_around((100, 50), (1280, 720), 6),
            ((94, 44), (1292, 732))
        );
        assert_eq!(
            frame_around((0, 0), (1920, 1080), 0),
            ((0, 0), (1920, 1080))
        );
    }

    #[test]
    fn the_margin_grows_with_the_scale_and_is_none_round_a_display() {
        assert_eq!(margin_px(Shape::Region, 1.0), 6);
        assert_eq!(margin_px(Shape::Window, 2.0), 12);
        assert_eq!(margin_px(Shape::Region, f64::NAN), 6);
        assert_eq!(margin_px(Shape::Screen, 2.0), 0);
    }

    #[test]
    fn the_page_is_told_the_shape_margin_and_protection() {
        assert_eq!(
            page_url(Shape::Window, 6.0, true),
            "index.html#/recordframe?shape=window&margin=6&protected=1"
        );
        assert_eq!(
            page_url(Shape::Screen, 0.0, false),
            "index.html#/recordframe?shape=screen&margin=0&protected=0"
        );
    }
}
