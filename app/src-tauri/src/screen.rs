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

/// The windows the overlay can pick, front to back, skipping Grab-it's
/// own, and the app and window the user was in.
///
/// On macOS this is one pass over the window server's list. xcap's
/// `Window` asks the window server for the whole list again for every
/// property it reads, so listing through it took about ten full lists per
/// window: hundreds of round trips the overlay waited on before it could
/// appear.
pub fn windows_and_foreground() -> (Foreground, Vec<WindowInfo>) {
    #[cfg(target_os = "macos")]
    {
        let listed = mac::list();
        let active = mac::active_pid();
        let foreground = front_of(&listed, active);
        (foreground, pickable(listed, std::process::id()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        (foreground(), windows())
    }
}

/// Visible, non-minimized windows, front to back, skipping Grab-it's own.
#[cfg(not(target_os = "macos"))]
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
    #[cfg(target_os = "macos")]
    {
        front_of(&mac::list(), mac::active_pid())
    }
    #[cfg(not(target_os = "macos"))]
    {
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
}

/// A window as the window server lists it, front to back.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct ListedWindow {
    id: u32,
    pid: u32,
    /// The window's level: 0 for an ordinary app window; the menu bar, its
    /// icons, the Dock, Control Center and widgets sit on higher levels.
    layer: i32,
    /// 0 for a fully transparent window, 1 for an opaque one.
    alpha: f64,
    app_name: String,
    title: String,
    rect: Rect,
}

/// The windows the overlay offers from `listed`: ordinary app windows that
/// can be seen, front to back, not Grab-it's own. Menu bar icons, the Dock,
/// Control Center and widgets are left out, so hovering never lands on a
/// small piece of the screen instead of the window under it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pickable(listed: Vec<ListedWindow>, own_pid: u32) -> Vec<WindowInfo> {
    listed
        .into_iter()
        .filter(|window| {
            window.layer == 0
                && window.alpha > 0.0
                && window.pid != own_pid
                && window.rect.width > 0
                && window.rect.height > 0
        })
        .map(|window| WindowInfo {
            id: window.id,
            app_name: window.app_name,
            title: window.title,
            rect: window.rect,
        })
        .collect()
}

/// The app and title of the active app's front window: an ordinary window
/// if it has one, else any of its windows. Unknown without an active app,
/// or when it shows no window (the desktop is focused).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn front_of(listed: &[ListedWindow], active_pid: Option<u32>) -> Foreground {
    let Some(pid) = active_pid else {
        return Foreground::default();
    };
    let own = listed.iter().filter(|window| window.pid == pid);
    let front = own
        .clone()
        .find(|window| window.layer == 0)
        .or_else(|| own.clone().next());
    let non_empty = |text: &str| (!text.is_empty()).then(|| text.to_owned());
    match front {
        Some(window) => Foreground {
            app: non_empty(&window.app_name),
            window_title: non_empty(&window.title),
        },
        None => Foreground::default(),
    }
}

/// The window server's list, read once. The calls are the ones xcap makes
/// for each property, here made once per window instead.
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2_app_kit::NSWorkspace;
    use objc2_core_foundation::{CFDictionary, CFNumber, CFNumberType, CFString, CGRect};
    use objc2_core_graphics::{
        CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
    };
    use objc2_foundation::{NSNumber, NSString};

    use super::ListedWindow;
    use crate::capture::Rect;

    /// The value under `key`, or null when the window has none.
    fn value(dictionary: &CFDictionary, key: &str) -> *const c_void {
        let key = CFString::from_str(key);
        let key_ref = key.as_ref() as *const CFString;
        // SAFETY: `key_ref` is a live CFString, as CFDictionary keys are.
        unsafe { dictionary.value(key_ref.cast()) }
    }

    fn number<T: Default>(dictionary: &CFDictionary, key: &str, kind: CFNumberType) -> Option<T> {
        let number = value(dictionary, key) as *const CFNumber;
        if number.is_null() {
            return None;
        }
        let mut out = T::default();
        // SAFETY: the window server stores numbers under these keys, and
        // `kind` matches `T` at every call site.
        let read = unsafe { (*number).value(kind, (&mut out as *mut T).cast()) };
        read.then_some(out)
    }

    fn int(dictionary: &CFDictionary, key: &str) -> Option<i32> {
        number(dictionary, key, CFNumberType::IntType)
    }

    fn string(dictionary: &CFDictionary, key: &str) -> String {
        let string = value(dictionary, key) as *const CFString;
        if string.is_null() {
            return String::new();
        }
        // SAFETY: the window server stores strings under these keys.
        unsafe { (*string).to_string() }
    }

    fn bounds(dictionary: &CFDictionary) -> Option<CGRect> {
        let bounds = value(dictionary, "kCGWindowBounds") as *const CFDictionary;
        if bounds.is_null() {
            return None;
        }
        let mut rect = CGRect::default();
        // SAFETY: `kCGWindowBounds` holds a rect's dictionary form, and
        // `rect` is a valid place to write it.
        let read = unsafe { CGRectMakeWithDictionaryRepresentation(Some(&*bounds), &mut rect) };
        read.then_some(rect)
    }

    /// Every window on screen, front to back, apart from desktop icons and
    /// windows that cannot be captured, which xcap leaves out too.
    pub(super) fn list() -> Vec<ListedWindow> {
        let Some(windows) = CGWindowListCopyWindowInfo(
            CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
            0,
        ) else {
            return Vec::new();
        };
        let mut listed = Vec::new();
        for i in 0..windows.count() {
            // SAFETY: `i` is within the array, whose items are dictionaries.
            let dictionary = unsafe { windows.value_at_index(i) } as *const CFDictionary;
            if dictionary.is_null() {
                continue;
            }
            // SAFETY: not null, and kept alive by `windows`.
            let dictionary = unsafe { &*dictionary };
            if int(dictionary, "kCGWindowSharingState") == Some(0) {
                continue;
            }
            let (Some(id), Some(rect)) = (int(dictionary, "kCGWindowNumber"), bounds(dictionary))
            else {
                continue;
            };
            let app_name = string(dictionary, "kCGWindowOwnerName");
            let title = string(dictionary, "kCGWindowName");
            if title == "StatusIndicator" && app_name == "Window Server" {
                continue;
            }
            listed.push(ListedWindow {
                id: id as u32,
                pid: int(dictionary, "kCGWindowOwnerPID").unwrap_or(-1) as u32,
                layer: int(dictionary, "kCGWindowLayer").unwrap_or(0),
                alpha: number(dictionary, "kCGWindowAlpha", CFNumberType::DoubleType)
                    .unwrap_or(1.0),
                app_name,
                title,
                rect: Rect {
                    x: rect.origin.x as i32,
                    y: rect.origin.y as i32,
                    width: rect.size.width as u32,
                    height: rect.size.height as u32,
                },
            });
        }
        listed
    }

    /// The active app's process, as xcap's `is_focused` reads it:
    /// `activeApplication` follows the focus as it changes, where
    /// `frontmostApplication` may not off the main thread.
    #[allow(deprecated, unused_unsafe)]
    pub(super) fn active_pid() -> Option<u32> {
        let pid_key = NSString::from_str("NSApplicationProcessIdentifier");
        // SAFETY: the same calls xcap makes; the dictionary's values are
        // Foundation objects.
        unsafe {
            NSWorkspace::sharedWorkspace()
                .activeApplication()
                .and_then(|dictionary| dictionary.valueForKey(&pid_key))
                .and_then(|pid| pid.downcast::<NSNumber>().ok())
                .map(|pid| pid.intValue() as u32)
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(id: u32, pid: u32, layer: i32, app_name: &str) -> ListedWindow {
        ListedWindow {
            id,
            pid,
            layer,
            alpha: 1.0,
            app_name: app_name.into(),
            title: format!("window {id}"),
            rect: Rect {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
        }
    }

    #[test]
    fn only_ordinary_visible_windows_of_other_apps_are_pickable() {
        let mut clear = listed(4, 20, 0, "Ghost");
        clear.alpha = 0.0;
        let mut empty = listed(5, 20, 0, "Empty");
        empty.rect.width = 0;
        let windows = [
            listed(1, 30, 25, "Control Center"),
            listed(2, 10, 0, "Grab-it"),
            listed(3, 20, 0, "Safari"),
            clear,
            empty,
            listed(6, 40, 20, "Dock"),
            listed(7, 50, 0, "Finder"),
        ];
        let ids: Vec<u32> = pickable(windows.to_vec(), 10)
            .iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(ids, vec![3, 7]);
    }

    #[test]
    fn the_foreground_is_the_active_apps_front_ordinary_window() {
        let windows = [
            listed(1, 20, 3, "Safari"),
            listed(2, 30, 0, "Notes"),
            listed(3, 20, 0, "Safari"),
        ];
        assert_eq!(
            front_of(&windows, Some(20)),
            Foreground {
                app: Some("Safari".into()),
                window_title: Some("window 3".into()),
            }
        );
        // Only a floating panel: that is the app's front window.
        assert_eq!(
            front_of(&windows[..1], Some(20)).window_title.as_deref(),
            Some("window 1")
        );
    }

    #[test]
    fn no_foreground_without_an_active_app_on_screen() {
        let windows = [listed(1, 20, 0, "Safari")];
        assert_eq!(front_of(&windows, None), Foreground::default());
        assert_eq!(front_of(&windows, Some(99)), Foreground::default());
    }
}
