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

/// A monitor's pixels, or the smoke tests' fixture in their place.
fn monitor_image(monitor: &Monitor, context: &str) -> Result<RgbaImage, String> {
    #[cfg(feature = "e2e")]
    if let Some(image) = fixture::stand_in(|| Ok((monitor.width()?, monitor.height()?))) {
        return image.map_err(|e| err(context, e));
    }
    monitor.capture_image().map_err(|e| err(context, e))
}

/// A window's pixels, or the smoke tests' fixture in their place.
fn window_image(window: &Window, context: &str) -> Result<RgbaImage, String> {
    #[cfg(feature = "e2e")]
    if let Some(image) = fixture::stand_in(|| Ok((window.width()?, window.height()?))) {
        return image.map_err(|e| err(context, e));
    }
    window.capture_image().map_err(|e| err(context, e))
}

/// Every monitor's info and image, captured as close together as possible.
pub fn capture_monitors() -> Result<Vec<(MonitorInfo, RgbaImage)>, String> {
    all_monitors()?
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let image = monitor_image(monitor, "could not capture the screen")?;
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
    monitor_image(monitor, "could not capture the monitor")
}

/// One window by id, including parts covered by other windows where the
/// platform allows it.
pub fn capture_window(id: u32) -> Result<RgbaImage, String> {
    let windows = Window::all().map_err(|e| err("could not list windows", e))?;
    let window = windows
        .into_iter()
        .find(|window| window.id().ok() == Some(id))
        .ok_or_else(|| "the window was closed".to_string())?;
    window_image(&window, "could not capture the window")
}

/// Smoke-test builds (the `e2e` feature): with `GRAB_IT_E2E_CAPTURE` set to
/// a PNG, every monitor and window capture returns that image, resized to
/// the size xcap reports, so the tests capture a known picture on any
/// display, Xvfb's included.
#[cfg(feature = "e2e")]
mod fixture {
    use std::path::Path;

    use image::{RgbaImage, imageops::FilterType};

    /// Names the PNG that stands in for the screen.
    pub const CAPTURE_VAR: &str = "GRAB_IT_E2E_CAPTURE";

    /// The fixture at the size `size` reports, or `None` when
    /// `GRAB_IT_E2E_CAPTURE` is unset and the screen should be read.
    pub fn stand_in(
        size: impl FnOnce() -> xcap::XCapResult<(u32, u32)>,
    ) -> Option<Result<RgbaImage, String>> {
        let path = std::env::var_os(CAPTURE_VAR).filter(|path| !path.is_empty())?;
        Some(
            size()
                .map_err(|e| e.to_string())
                .and_then(|(width, height)| load(Path::new(&path), width, height)),
        )
    }

    /// The PNG at `path`, resized to `width` × `height` when it differs.
    pub fn load(path: &Path, width: u32, height: u32) -> Result<RgbaImage, String> {
        if width == 0 || height == 0 {
            return Err(format!(
                "{CAPTURE_VAR}: nothing to capture at {width}×{height}"
            ));
        }
        let image = image::open(path)
            .map_err(|e| format!("{CAPTURE_VAR}: could not read {}: {e}", path.display()))?
            .to_rgba8();
        if image.dimensions() == (width, height) {
            return Ok(image);
        }
        Ok(image::imageops::resize(
            &image,
            width,
            height,
            FilterType::Triangle,
        ))
    }
}

/// The monitor of `monitors` that holds the point `x`, `y`.
pub fn monitor_at(monitors: &[MonitorInfo], x: f64, y: f64) -> Option<&MonitorInfo> {
    monitors.iter().find(|monitor| {
        contains(
            &Rect {
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
            },
            x,
            y,
        )
    })
}

/// What a click landed on.
#[derive(Debug, Clone, PartialEq)]
pub enum Hit {
    /// One of Grab-it's own windows or menus.
    Own,
    /// A menu, popover or other window above the ordinary ones, or one the
    /// window list does not hold.
    Popup,
    /// An ordinary app window.
    Window(WindowInfo),
    /// Part of the system shell that a click on a tray icon goes through.
    /// Only Windows reports it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Shell(Shell),
    /// No window: the desktop.
    Nothing,
}

/// The parts of the Windows shell clicked on the way to a tray icon's menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    /// A taskbar, with its notification area and the overflow chevron.
    Taskbar,
    /// The flyout of tray icons hidden behind the chevron.
    TrayOverflow,
}

/// The shell part a top-level window of class `class` is, if any.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn shell_of_class(class: &str) -> Option<Shell> {
    match class {
        "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" => Some(Shell::Taskbar),
        // Windows 10's flyout, then Windows 11's.
        "NotifyIconOverflowWindow" | "TopLevelWindowForOverflowXamlIsland" => {
            Some(Shell::TrayOverflow)
        }
        _ => None,
    }
}

/// A window for hit-testing: every visible one, Grab-it's own and popups
/// included, front to back.
#[derive(Debug, Clone, PartialEq)]
pub struct HitWindow {
    pub info: WindowInfo,
    pub own: bool,
    pub popup: bool,
}

/// What the front-most of `windows` holding `x`, `y` is.
pub fn classify(windows: &[HitWindow], x: f64, y: f64) -> Hit {
    match windows
        .iter()
        .find(|window| contains(&window.info.rect, x, y))
    {
        None => Hit::Nothing,
        Some(window) if window.own => Hit::Own,
        Some(window) if window.popup => Hit::Popup,
        Some(window) => Hit::Window(window.info.clone()),
    }
}

/// What the click at `x`, `y` in desktop coordinates landed on. Called as
/// soon as the click is seen, while a menu it landed on is still open.
pub fn hit_test(x: f64, y: f64) -> Hit {
    let own_pid = std::process::id();
    #[cfg(target_os = "macos")]
    {
        let windows: Vec<HitWindow> = mac::list()
            .into_iter()
            .filter(|window| window.alpha > 0.0 && window.rect.width > 0 && window.rect.height > 0)
            .map(|window| HitWindow {
                own: window.pid == own_pid,
                popup: window.layer != 0,
                info: WindowInfo {
                    id: window.id,
                    app_name: window.app_name,
                    title: window.title,
                    rect: window.rect,
                },
            })
            .collect();
        classify(&windows, x, y)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Popups the window list leaves out, found at the point itself.
        if let Some(hit) = native::popup_at(x, y, own_pid) {
            return hit;
        }
        let Ok(all) = Window::all() else {
            return Hit::Nothing;
        };
        let mut windows: Vec<(i32, HitWindow)> = all
            .iter()
            .filter(|window| !window.is_minimized().unwrap_or(false))
            .filter_map(|window| {
                let width = window.width().ok()?;
                let height = window.height().ok()?;
                if width == 0 || height == 0 {
                    return None;
                }
                let hit = HitWindow {
                    own: window.pid().ok() == Some(own_pid),
                    popup: false,
                    info: WindowInfo {
                        id: window.id().ok()?,
                        app_name: window.app_name().unwrap_or_default(),
                        title: window.title().unwrap_or_default(),
                        rect: Rect {
                            x: window.x().ok()?,
                            y: window.y().ok()?,
                            width,
                            height,
                        },
                    },
                };
                Some((window.z().unwrap_or(0), hit))
            })
            .collect();
        windows.sort_by_key(|(z, _)| std::cmp::Reverse(*z));
        let windows: Vec<HitWindow> = windows.into_iter().map(|(_, hit)| hit).collect();
        classify(&windows, x, y)
    }
}

/// Windows: the top-level window at the point, which holds menus that
/// xcap's list may not.
#[cfg(target_os = "windows")]
mod native {
    use windows::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetWindowThreadProcessId, WindowFromPoint,
        },
    };

    use super::{Hit, shell_of_class};

    pub fn popup_at(x: f64, y: f64, own_pid: u32) -> Option<Hit> {
        let point = POINT {
            x: x.round() as i32,
            y: y.round() as i32,
        };
        // SAFETY: these only read the window under a point and its owner.
        unsafe {
            let window = WindowFromPoint(point);
            if window.0.is_null() {
                return None;
            }
            let root = GetAncestor(window, GA_ROOT);
            let root = if root.0.is_null() { window } else { root };
            let mut pid = 0u32;
            GetWindowThreadProcessId(root, Some(&mut pid as *mut u32));
            if pid == own_pid {
                return Some(Hit::Own);
            }
            // A menu's own window class, which xcap's list leaves out, or
            // the taskbar and the tray's overflow flyout.
            let mut class = [0u16; 64];
            let len = windows::Win32::UI::WindowsAndMessaging::GetClassNameW(root, &mut class);
            let class = String::from_utf16_lossy(&class[..len.max(0) as usize]);
            if class == "#32768" {
                return Some(Hit::Popup);
            }
            shell_of_class(&class).map(Hit::Shell)
        }
    }
}

/// X11: an override-redirect window at the pointer (a menu or popover),
/// which xcap's list leaves out. Wayland has no step capture.
#[cfg(target_os = "linux")]
mod native {
    use x11rb::{
        connection::Connection as _,
        protocol::xproto::{AtomEnum, ConnectionExt as _},
    };

    use super::Hit;

    pub fn popup_at(_x: f64, _y: f64, own_pid: u32) -> Option<Hit> {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        // The pointer has barely moved since the click was seen.
        let child = conn.query_pointer(root).ok()?.reply().ok()?.child;
        if child == x11rb::NONE {
            return None;
        }
        let attributes = conn.get_window_attributes(child).ok()?.reply().ok()?;
        if !attributes.override_redirect {
            return None;
        }
        let atom = conn
            .intern_atom(false, b"_NET_WM_PID")
            .ok()?
            .reply()
            .ok()?
            .atom;
        let pid = conn
            .get_property(false, child, atom, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()
            .and_then(|reply| reply.value32().and_then(|mut values| values.next()));
        Some(if pid == Some(own_pid) {
            Hit::Own
        } else {
            Hit::Popup
        })
    }
}

fn contains(rect: &Rect, x: f64, y: f64) -> bool {
    let (left, top) = (f64::from(rect.x), f64::from(rect.y));
    x >= left && y >= top && x < left + f64::from(rect.width) && y < top + f64::from(rect.height)
}

/// The desktop as a selection finds it.
#[derive(Debug, Default)]
pub struct Desktop {
    /// The app and window the user was in.
    pub foreground: Foreground,
    /// The windows the overlay can pick, front to back, skipping Grab-it's
    /// own.
    pub windows: Vec<WindowInfo>,
    /// macOS: the active app's process, unless it is Grab-it, to give the
    /// focus back to when the overlay closes. `None` elsewhere.
    pub active_app: Option<u32>,
}

/// The windows the overlay can pick, and the app and window the user was
/// in.
///
/// On macOS this is one pass over the window server's list. xcap's
/// `Window` asks the window server for the whole list again for every
/// property it reads, so listing through it took about ten full lists per
/// window: hundreds of round trips the overlay waited on before it could
/// appear.
pub fn desktop() -> Desktop {
    #[cfg(target_os = "macos")]
    {
        let listed = mac::list();
        let active = mac::active_pid();
        let own_pid = std::process::id();
        Desktop {
            foreground: front_of(&listed, active),
            windows: pickable(listed, own_pid),
            active_app: active.filter(|pid| *pid != own_pid),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Desktop {
            foreground: foreground(),
            windows: windows(),
            active_app: None,
        }
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
    /// Whether the owner is a running app. Helpers such as JankyBorders draw
    /// click-through windows from processes that are not apps.
    is_app: bool,
}

/// The windows the overlay offers from `listed`: ordinary app windows that
/// can be seen, front to back, not Grab-it's own. Menu bar icons, the Dock,
/// Control Center and widgets are left out, so hovering never lands on a
/// small piece of the screen instead of the window under it. Windows whose
/// owner is not an app, such as window border outlines, are left out too,
/// so a capture is never filed under a helper process.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pickable(listed: Vec<ListedWindow>, own_pid: u32) -> Vec<WindowInfo> {
    listed
        .into_iter()
        .filter(|window| {
            window.layer == 0
                && window.alpha > 0.0
                && window.pid != own_pid
                && window.is_app
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
    use std::collections::HashMap;
    use std::ffi::c_void;

    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
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
        // Whether each owner is an app, looked up once per process.
        let mut apps: HashMap<i32, bool> = HashMap::new();
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
            let pid = int(dictionary, "kCGWindowOwnerPID").unwrap_or(-1);
            let is_app = pid >= 0
                && *apps.entry(pid).or_insert_with(|| {
                    NSRunningApplication::runningApplicationWithProcessIdentifier(pid).is_some()
                });
            listed.push(ListedWindow {
                id: id as u32,
                pid: pid as u32,
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
                is_app,
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

    #[cfg(feature = "e2e")]
    #[test]
    fn the_e2e_fixture_is_resized_to_the_reported_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.png");
        RgbaImage::from_pixel(4, 2, image::Rgba([10, 20, 30, 255]))
            .save(&path)
            .unwrap();

        let same = fixture::load(&path, 4, 2).unwrap();
        assert_eq!(same.dimensions(), (4, 2));
        let resized = fixture::load(&path, 8, 6).unwrap();
        assert_eq!(resized.dimensions(), (8, 6));
        assert_eq!(resized.get_pixel(7, 5), &image::Rgba([10, 20, 30, 255]));
        assert!(fixture::load(&path, 0, 6).is_err());
        assert!(fixture::load(&dir.path().join("missing.png"), 8, 6).is_err());
    }

    fn window(id: u32, x: i32, y: i32, width: u32, height: u32) -> WindowInfo {
        WindowInfo {
            id,
            app_name: format!("App {id}"),
            title: String::new(),
            rect: Rect {
                x,
                y,
                width,
                height,
            },
        }
    }

    #[test]
    fn the_front_window_under_the_point_is_found() {
        let ordinary = |info: WindowInfo| HitWindow {
            info,
            own: false,
            popup: false,
        };
        // Front to back: a small dialog over a large window.
        let windows = [
            ordinary(window(1, 100, 100, 200, 100)),
            ordinary(window(2, 0, 0, 800, 600)),
        ];
        let id = |x, y| match classify(&windows, x, y) {
            Hit::Window(window) => Some(window.id),
            _ => None,
        };
        assert_eq!(id(150.0, 150.0), Some(1));
        assert_eq!(id(50.5, 20.0), Some(2));
        // The right and bottom edges are outside.
        assert_eq!(id(800.0, 10.0), None);
        assert_eq!(id(-1.0, 10.0), None);
    }

    #[test]
    fn a_popup_over_a_large_window_is_told_apart() {
        let hit = |info: WindowInfo, own: bool, popup: bool| HitWindow { info, own, popup };
        // Front to back: a menu over the app's large window, and Grab-it's hub.
        let windows = [
            hit(window(9, 900, 0, 200, 200), true, false),
            hit(window(3, 100, 100, 180, 240), false, true),
            hit(window(2, 0, 0, 1600, 1000), false, false),
        ];
        assert_eq!(classify(&windows, 150.0, 150.0), Hit::Popup);
        assert_eq!(
            classify(&windows, 50.0, 50.0),
            Hit::Window(window(2, 0, 0, 1600, 1000))
        );
        assert_eq!(classify(&windows, 950.0, 50.0), Hit::Own);
        assert_eq!(classify(&windows, 5000.0, 50.0), Hit::Nothing);
    }

    #[test]
    fn the_taskbar_and_the_tray_overflow_are_told_apart() {
        assert_eq!(shell_of_class("Shell_TrayWnd"), Some(Shell::Taskbar));
        assert_eq!(
            shell_of_class("Shell_SecondaryTrayWnd"),
            Some(Shell::Taskbar)
        );
        assert_eq!(
            shell_of_class("NotifyIconOverflowWindow"),
            Some(Shell::TrayOverflow)
        );
        assert_eq!(
            shell_of_class("TopLevelWindowForOverflowXamlIsland"),
            Some(Shell::TrayOverflow)
        );
        assert_eq!(shell_of_class("Notepad"), None);
        assert_eq!(shell_of_class("#32768"), None);
    }

    #[test]
    fn the_monitor_under_the_point_is_found() {
        let monitor = |index: usize, x: i32| MonitorInfo {
            index,
            name: String::new(),
            x,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
            is_primary: index == 0,
        };
        let monitors = [monitor(0, 0), monitor(1, -1920)];
        assert_eq!(monitor_at(&monitors, -10.0, 5.0).map(|m| m.index), Some(1));
        assert_eq!(monitor_at(&monitors, 10.0, 5.0).map(|m| m.index), Some(0));
        assert!(monitor_at(&monitors, 10.0, 2000.0).is_none());
    }

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
            is_app: true,
        }
    }

    #[test]
    fn only_ordinary_visible_windows_of_other_apps_are_pickable() {
        let mut clear = listed(4, 20, 0, "Ghost");
        clear.alpha = 0.0;
        let mut empty = listed(5, 20, 0, "Empty");
        empty.rect.width = 0;
        let mut border = listed(8, 60, 0, "borders");
        border.title = String::new();
        border.is_app = false;
        let windows = [
            border,
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
