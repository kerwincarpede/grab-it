//! The scrolling capture bar: a pill window shown while a scrolling capture
//! runs (see src/scrollbar/), with a progress stripe, the image's length so
//! far, a live preview of its newest part, a message, Done and Cancel, and
//! Saving… once Done is chosen.
//!
//! Like the step capture pill it is kept out of screen captures where the
//! system allows (`content_protected`), so it can stay on screen over the
//! area. X11 has no such thing: there it moves outside the area as the
//! recording toolbar does (`record_bar::clear_of`), and with no room it is
//! hidden for each grab.

use std::sync::Mutex;

use base64::{Engine, prelude::BASE64_STANDARD};
use image::{RgbaImage, imageops};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::capture::Rect;
use crate::record_bar::{self, Area, Display};
use crate::rt::AppHandle;
use crate::screen::MonitorInfo;
use crate::steps_bar::{Pill, open_pill, placement_of};
use crate::stitch::{Axis, MAX_LENGTH};

pub const LABEL: &str = "scroll-bar";
/// Sent to the bar with each new [`ScrollBarState`].
pub const STATE_EVENT: &str = "scroll-bar-state";
/// The window's size in points: the pill and the room for its shadow
/// (`.scrollbar` padding in src/scrollbar/scrollbar.css).
const SIZE: (f64, f64) = (580.0, 132.0);
/// The live preview's largest size, in pixels.
const PREVIEW: (u32, u32) = (240, 96);

/// What the bar shows. Mirrors `ScrollBarState` in src/scrollbar/api.ts.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScrollBarState {
    pub session_id: u64,
    pub width: u32,
    pub height: u32,
    /// The image's length along the scroll axis, in pixels.
    pub length: u32,
    /// How far the image is toward its length limit, from 0 to 1.
    pub progress: f64,
    pub capped: bool,
    pub auto_scrolling: bool,
    /// What to do now, or why automatic scrolling stopped.
    pub message: Option<String>,
    /// Done was chosen and the image is being saved.
    pub saving: bool,
    /// The newest part of the image as a PNG data URL, up to 240 px wide.
    pub preview: Option<String>,
}

impl ScrollBarState {
    /// The state for an image of `size`, growing along `axis`.
    pub fn new(session_id: u64, size: (u32, u32), axis: Option<Axis>) -> Self {
        let length = if axis == Some(Axis::Horizontal) {
            size.0
        } else {
            size.1
        };
        Self {
            session_id,
            width: size.0,
            height: size.1,
            length,
            progress: (f64::from(length) / f64::from(MAX_LENGTH)).clamp(0.0, 1.0),
            capped: false,
            auto_scrolling: false,
            message: None,
            saving: false,
            preview: None,
        }
    }
}

/// The bar's latest state, for a page that loads after it was sent.
#[derive(Default)]
pub struct ScrollBarStore(Mutex<Option<ScrollBarState>>);

fn store(app: &AppHandle) -> Option<std::sync::MutexGuard<'_, Option<ScrollBarState>>> {
    app.try_state::<ScrollBarStore>()
        .map(|state| state.inner().0.lock().unwrap_or_else(|p| p.into_inner()))
}

/// The newest end of `image` along `axis` (the start when `reverse`), cut
/// to the preview's shape and scaled to fit it.
pub fn preview_image(image: &RgbaImage, axis: Option<Axis>, reverse: bool) -> RgbaImage {
    let (w, h) = image.dimensions();
    let (pw, ph) = PREVIEW;
    let crop = if axis == Some(Axis::Horizontal) {
        // As much width as the preview's shape allows for the full height.
        let along = ((u64::from(h) * u64::from(pw)) / u64::from(ph)).min(u64::from(w)) as u32;
        let x = if reverse { 0 } else { w - along };
        imageops::crop_imm(image, x, 0, along.max(1), h).to_image()
    } else {
        let along = ((u64::from(w) * u64::from(ph)) / u64::from(pw)).min(u64::from(h)) as u32;
        let y = if reverse { 0 } else { h - along };
        imageops::crop_imm(image, 0, y, w, along.max(1)).to_image()
    };
    let (cw, ch) = crop.dimensions();
    let scale = (f64::from(pw) / f64::from(cw.max(1))).min(f64::from(ph) / f64::from(ch.max(1)));
    if scale >= 1.0 {
        return crop;
    }
    let size = (
        ((f64::from(cw) * scale).round() as u32).max(1),
        ((f64::from(ch) * scale).round() as u32).max(1),
    );
    imageops::thumbnail(&crop, size.0, size.1)
}

/// [`preview_image`] as a PNG data URL.
pub fn preview_url(image: &RgbaImage, axis: Option<Axis>, reverse: bool) -> Option<String> {
    let preview = preview_image(image, axis, reverse);
    let mut png = Vec::new();
    preview
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(png)
    ))
}

/// The capture area in desktop pixels: `rect` is in the monitor's frozen
/// image pixels, `image_size` that image's size.
fn area_on(monitor: &tauri::Monitor, rect: Rect, image_size: (u32, u32)) -> Area {
    let origin = monitor.position();
    let size = monitor.size();
    let sx = f64::from(size.width) / f64::from(image_size.0.max(1));
    let sy = f64::from(size.height) / f64::from(image_size.1.max(1));
    Area {
        x: origin.x + (f64::from(rect.x) * sx).round() as i32,
        y: origin.y + (f64::from(rect.y) * sy).round() as i32,
        width: (f64::from(rect.width) * sx).round() as u32,
        height: (f64::from(rect.height) * sy).round() as u32,
    }
}

fn overlaps(position: (i32, i32), size: (u32, u32), area: Area) -> bool {
    position.0 < area.x + area.width as i32
        && area.x < position.0 + size.0 as i32
        && position.1 < area.y + area.height as i32
        && area.y < position.1 + size.1 as i32
}

/// A window's top-left corner and size, in physical pixels.
pub type Placement = ((i32, i32), (u32, u32));

/// Where the bar opens on `display`: the top centre of its work area, moved
/// outside `area` when it would cover it. Also says whether it still covers
/// the area there, which only matters where the system cannot keep it out
/// of captures.
pub fn placement(display: &Display, area: Area) -> (Placement, bool) {
    let (position, size) = placement_of(SIZE, display);
    let position = record_bar::clear_of(position, size, area, display.work, display.scale);
    ((position, size), overlaps(position, size, area))
}

/// Whether the bar must be hidden for each grab: only where the system
/// cannot leave it out of captures (X11), and only when it covers the area.
pub fn hides_for_grabs(covers_area: bool) -> bool {
    cfg!(target_os = "linux") && covers_area
}

/// Opens the bar for a capture of `rect` on `monitor` with `state`. Returns
/// whether it has to be hidden for each grab. Call this off the main thread.
pub fn show(
    app: &AppHandle,
    monitor: &MonitorInfo,
    rect: Rect,
    image_size: (u32, u32),
    state: ScrollBarState,
) -> Result<bool, String> {
    if let Some(mut stored) = store(app) {
        *stored = Some(state);
    }
    close(app);
    let monitors = app.available_monitors().unwrap_or_default();
    let Some(found) = record_bar::monitor_for(monitor, &monitors) else {
        return Err("no display to show the scrolling capture bar on".into());
    };
    let display = record_bar::display_of(found);
    let area = area_on(found, rect, image_size);
    let (place, covers) = placement(&display, area);
    open_pill(
        app,
        Pill {
            label: LABEL,
            route: "scrollbar".into(),
            title: "Grab-it scrolling capture",
            size: SIZE,
        },
        &display,
        place,
    )
    .map_err(|err| format!("could not show the scrolling capture bar: {err}"))?;
    Ok(hides_for_grabs(covers))
}

/// Whether the bar is still open; closing it ends the capture.
pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Sends `state` to the bar.
pub fn update(app: &AppHandle, state: ScrollBarState) {
    if let Some(mut stored) = store(app) {
        *stored = Some(state.clone());
    }
    if let Err(err) = app.emit_to(LABEL, STATE_EVENT, state) {
        eprintln!("Grab-it: could not update the scrolling capture bar: {err}");
    }
}

/// Closes the bar, if it is open.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the scrolling capture bar: {err}");
    }
}

/// Forgets the last state once the session is over.
pub fn clear(app: &AppHandle) {
    if let Some(mut stored) = store(app) {
        *stored = None;
    }
}

/// The bar's latest state, for its page as it loads.
#[tauri::command]
#[specta::specta]
pub fn scroll_bar_state(app: AppHandle) -> Option<ScrollBarState> {
    store(&app).and_then(|stored| stored.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(work: Area, scale: f64) -> Display {
        Display {
            key: "DP-1".into(),
            work,
            scale,
        }
    }
    const WORK: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    #[test]
    fn the_bar_opens_at_the_top_centre_clear_of_a_small_area() {
        let area = Area {
            x: 300,
            y: 400,
            width: 600,
            height: 400,
        };
        let (((x, y), size), covers) = placement(&display(WORK, 1.0), area);
        assert_eq!(size, (580, 132));
        assert_eq!((x, y), ((1920 - 580) / 2, 12));
        assert!(!covers);
    }

    #[test]
    fn the_bar_moves_outside_an_area_under_the_top_centre() {
        let area = Area {
            x: 400,
            y: 0,
            width: 1100,
            height: 700,
        };
        let ((position, size), covers) = placement(&display(WORK, 1.0), area);
        assert!(!covers);
        assert!(!overlaps(position, size, area));
    }

    #[test]
    fn an_area_that_fills_the_display_leaves_the_bar_over_it() {
        let ((position, size), covers) = placement(&display(WORK, 1.0), WORK);
        assert!(covers);
        assert!(overlaps(position, size, WORK));
        // Only X11 hides it for each grab; elsewhere it is kept out of captures.
        assert_eq!(hides_for_grabs(covers), cfg!(target_os = "linux"));
        assert!(!hides_for_grabs(false));
    }

    #[test]
    fn the_preview_shows_the_newest_end_up_to_240_px_wide() {
        // A tall image: red at the top, blue at the bottom.
        let image = RgbaImage::from_fn(1200, 6000, |_, y| {
            if y < 3000 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            }
        });
        let forward = preview_image(&image, Some(Axis::Vertical), false);
        assert_eq!(forward.dimensions(), (240, 96));
        assert_eq!(forward.get_pixel(120, 48)[2], 255);
        let reverse = preview_image(&image, Some(Axis::Vertical), true);
        assert_eq!(reverse.get_pixel(120, 48)[0], 255);
        let wide = RgbaImage::new(6000, 400);
        let (w, h) = preview_image(&wide, Some(Axis::Horizontal), false).dimensions();
        assert!(w <= 240 && h <= 96);
        // A small image is shown as it is.
        assert_eq!(
            preview_image(&RgbaImage::new(100, 40), None, false).dimensions(),
            (100, 40)
        );
        assert!(
            preview_url(&image, None, false)
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn progress_is_the_length_over_the_limit() {
        let state = ScrollBarState::new(3, (800, 15_000), Some(Axis::Vertical));
        assert_eq!(state.length, 15_000);
        assert!((state.progress - 0.5).abs() < 1e-9);
        let wide = ScrollBarState::new(3, (60_000, 800), Some(Axis::Horizontal));
        assert_eq!(wide.progress, 1.0);
    }
}
