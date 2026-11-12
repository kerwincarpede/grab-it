//! Grabbing pixels with xcap on X11, Windows and macOS.

use image::RgbaImage;
use xcap::{Monitor, Window};

use crate::capture::{Foreground, Rect, Tile, stitch};

/// A monitor as xcap reports it, in desktop coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// A visible window, in desktop coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub rect: Rect,
}

fn err(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn monitor_info(index: usize, monitor: &Monitor) -> Result<MonitorInfo, String> {
    let read = |e: xcap::XCapError| err("could not read a monitor", e);
    Ok(MonitorInfo {
        index,
        name: monitor
            .name()
            .unwrap_or_else(|_| format!("Monitor {}", index + 1)),
        x: monitor.x().map_err(read)?,
        y: monitor.y().map_err(read)?,
        width: monitor.width().map_err(read)?,
        height: monitor.height().map_err(read)?,
        scale_factor: monitor.scale_factor().map(f64::from).unwrap_or(1.0),
        is_primary: monitor.is_primary().unwrap_or(false),
    })
}

fn all_monitors() -> Result<Vec<Monitor>, String> {
    let monitors = Monitor::all().map_err(|e| err("could not list monitors", e))?;
    if monitors.is_empty() {
        return Err("no monitors found".into());
    }
    Ok(monitors)
}

/// Lists the monitors, in xcap's order. Indexes are stable for one session.
pub fn monitors() -> Result<Vec<MonitorInfo>, String> {
    all_monitors()?
        .iter()
        .enumerate()
        .map(|(index, monitor)| monitor_info(index, monitor))
        .collect()
}

/// Every monitor's info and image, captured as close together as possible.
pub fn capture_monitors() -> Result<Vec<(MonitorInfo, RgbaImage)>, String> {
    all_monitors()?
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let image = monitor
                .capture_image()
                .map_err(|e| err("could not capture the screen", e))?;
            Ok((monitor_info(index, monitor)?, image))
        })
        .collect()
}

/// All monitors stitched into one image.
pub fn capture_all() -> Result<RgbaImage, String> {
    let frames = capture_monitors()?;
    let tiles: Vec<Tile<'_>> = frames
        .iter()
        .map(|(info, image)| Tile {
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
            image,
        })
        .collect();
    stitch(&tiles).ok_or_else(|| "no monitors found".into())
}

/// One monitor, by its index in [`monitors`].
pub fn capture_monitor(index: usize) -> Result<RgbaImage, String> {
    let monitors = all_monitors()?;
    let monitor = monitors
        .get(index)
        .ok_or_else(|| format!("monitor {} is no longer connected", index + 1))?;
    monitor
        .capture_image()
        .map_err(|e| err("could not capture the monitor", e))
}

/// One window by id, including parts covered by other windows where the
/// platform allows it.
pub fn capture_window(id: u32) -> Result<RgbaImage, String> {
    let windows = Window::all().map_err(|e| err("could not list windows", e))?;
    let window = windows
        .into_iter()
        .find(|window| window.id().ok() == Some(id))
        .ok_or_else(|| "the window was closed".to_string())?;
    window
        .capture_image()
        .map_err(|e| err("could not capture the window", e))
}

/// Visible, non-minimized windows, front to back, skipping Grab-it's own.
pub fn windows() -> Vec<WindowInfo> {
    let own_pid = std::process::id();
    let Ok(all) = Window::all() else {
        return Vec::new();
    };
    let mut windows: Vec<(i32, WindowInfo)> = all
        .iter()
        .filter(|window| !window.is_minimized().unwrap_or(false))
        .filter(|window| window.pid().ok() != Some(own_pid))
        .filter_map(|window| {
            let width = window.width().ok()?;
            let height = window.height().ok()?;
            if width == 0 || height == 0 {
                return None;
            }
            let info = WindowInfo {
                id: window.id().ok()?,
                app_name: window.app_name().unwrap_or_default(),
                title: window.title().unwrap_or_default(),
                rect: Rect {
                    x: window.x().ok()?,
                    y: window.y().ok()?,
                    width,
                    height,
                },
            };
            Some((window.z().unwrap_or(0), info))
        })
        .collect();
    // Higher z is closer to the front.
    windows.sort_by_key(|(z, _)| std::cmp::Reverse(*z));
    windows.into_iter().map(|(_, info)| info).collect()
}

/// The focused window's app and title, if the platform reports one.
pub fn foreground() -> Foreground {
    let own_pid = std::process::id();
    let focused = Window::all().ok().and_then(|all| {
        all.into_iter().find(|window| {
            window.is_focused().unwrap_or(false) && window.pid().ok() != Some(own_pid)
        })
    });
    let non_empty = |text: String| (!text.is_empty()).then_some(text);
    match focused {
        Some(window) => Foreground {
            app: window.app_name().ok().and_then(non_empty),
            window_title: window.title().ok().and_then(non_empty),
        },
        None => Foreground::default(),
    }
}

/// The app and title for a window picked in the overlay.
pub fn foreground_of(window: &WindowInfo) -> Foreground {
    let non_empty = |text: &str| (!text.is_empty()).then(|| text.to_owned());
    Foreground {
        app: non_empty(&window.app_name),
        window_title: non_empty(&window.title),
    }
}
