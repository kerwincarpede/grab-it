//! Windows: the frozen screen, on show the moment it is captured.
//!
//! The capture overlay's page needs a few hundred milliseconds to receive
//! and decode a frozen monitor. While the overlay waited for that, the
//! desktop stayed live, so moving content jumped back to the older frame
//! when the overlay appeared. Each monitor is instead copied into a bitmap
//! and shown at once in a bare window of its own, which the see-through
//! overlay is then laid over.

use std::{
    ffi::c_void,
    sync::{Arc, Mutex, MutexGuard, Once, mpsc},
    time::Duration,
};

use ::windows::{
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM},
        Graphics::{
            Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute},
            Gdi::{
                AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, BitBlt,
                CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject,
                GdiFlush, GetWindowDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC, SRCCOPY, SelectObject,
            },
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, GetDesktopWindow, RegisterClassW,
            SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, ShowWindow,
            ULW_ALPHA, UpdateLayeredWindow, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        },
    },
    core::{PCWSTR, w},
};
use image::RgbaImage;

use crate::rt::AppHandle;
use crate::{capture::bgra_to_rgba, screen::MonitorInfo};

/// The window class of a frozen screen.
const CLASS: PCWSTR = w!("GrabItFrozenScreen");

/// How long the main thread may take to put a frozen screen up. Past that
/// the monitors are captured without one.
const SHOW_TIMEOUT: Duration = Duration::from_secs(1);

/// A monitor's pixels as GDI copied them: 32 bits each, blue first, the top
/// row first.
struct Shot {
    dc: HDC,
    bitmap: HBITMAP,
    /// What `dc` held before `bitmap`, put back before `dc` is deleted.
    previous: HGDIOBJ,
    bits: *const u8,
    width: i32,
    height: i32,
}

// SAFETY: GDI objects do not belong to the thread that made them. Once
// `take` returns nothing draws into the bitmap again: the capture thread
// only reads its pixels and the main thread only copies from its DC.
unsafe impl Send for Shot {}
// SAFETY: as above; every use after `take` is a read.
unsafe impl Sync for Shot {}

impl Shot {
    /// Copies `monitor` off the screen, as xcap does, but into a bitmap
    /// that can be shown again without another copy.
    fn take(monitor: &MonitorInfo) -> Result<Self, String> {
        let width = i32::try_from(monitor.width).unwrap_or(0);
        let height = i32::try_from(monitor.height).unwrap_or(0);
        if width <= 0 || height <= 0 {
            return Err("a monitor has no size".into());
        }
        // SAFETY: the desktop window's DC is released below, on every path.
        unsafe {
            let desktop = GetDesktopWindow();
            let screen = GetWindowDC(Some(desktop));
            if screen.is_invalid() {
                return Err("could not read the screen".into());
            }
            let shot = Self::blank(screen, width, height).and_then(|shot| {
                BitBlt(
                    shot.dc,
                    0,
                    0,
                    width,
                    height,
                    Some(screen),
                    monitor.x,
                    monitor.y,
                    SRCCOPY,
                )
                .map_err(|err| format!("could not capture the screen: {err}"))?;
                // The pixels are read directly, so GDI must have written them.
                let _ = GdiFlush();
                Ok(shot)
            });
            ReleaseDC(Some(desktop), screen);
            shot
        }
    }

    /// An empty bitmap of the size given, in a DC like `screen`.
    ///
    /// # Safety
    /// `screen` must be a live DC.
    unsafe fn blank(screen: HDC, width: i32, height: i32) -> Result<Self, String> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative: rows run top to bottom.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: `screen` is live, and the DC made here is deleted when
        // the bitmap cannot be made, or by `Drop` once it is selected.
        unsafe {
            let dc = CreateCompatibleDC(Some(screen));
            if dc.is_invalid() {
                return Err("could not make a bitmap for the screen".into());
            }
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(bitmap) if !bits.is_null() => bitmap,
                Ok(bitmap) => {
                    let _ = DeleteObject(bitmap.into());
                    let _ = DeleteDC(dc);
                    return Err("could not make a bitmap for the screen".into());
                }
                Err(err) => {
                    let _ = DeleteDC(dc);
                    return Err(format!("could not make a bitmap for the screen: {err}"));
                }
            };
            let previous = SelectObject(dc, bitmap.into());
            Ok(Self {
                dc,
                bitmap,
                previous,
                bits: bits.cast(),
                width,
                height,
            })
        }
    }

    /// The pixels as the rest of Grab-it keeps a frozen monitor.
    fn to_rgba(&self) -> Result<RgbaImage, String> {
        let (width, height) = (self.width as u32, self.height as u32);
        let length = width as usize * height as usize * 4;
        // SAFETY: the bitmap holds `width` by `height` 32-bit pixels at
        // `bits`, lives as long as `self`, and is no longer written to.
        let bgra = unsafe { std::slice::from_raw_parts(self.bits, length) };
        RgbaImage::from_raw(width, height, bgra_to_rgba(bgra))
            .ok_or_else(|| "could not read the captured screen".to_string())
    }
}

impl Drop for Shot {
    fn drop(&mut self) {
        // SAFETY: made in `blank` and owned by `self` alone.
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// A frozen screen's window, as the number its handle is: a handle itself
/// may not cross threads.
type Handle = isize;

fn hwnd(handle: Handle) -> HWND {
    HWND(handle as *mut c_void)
}

#[derive(Default)]
struct Windows {
    /// Set when the selection is over: a frozen screen still on its way to
    /// the main thread is then not shown.
    closed: bool,
    /// Each window with the index of its monitor.
    shown: Vec<(usize, Handle)>,
}

/// The frozen screens on show. They go when this is closed or dropped.
pub struct Freeze {
    app: AppHandle,
    windows: Arc<Mutex<Windows>>,
}

fn lock(windows: &Mutex<Windows>) -> MutexGuard<'_, Windows> {
    windows.lock().unwrap_or_else(|p| p.into_inner())
}

impl Freeze {
    fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            windows: Arc::default(),
        }
    }

    /// Puts `shot` on screen over `monitor`, on the main thread, and waits
    /// for it: the overlays come later and must find it there.
    fn show(&self, monitor: &MonitorInfo, shot: &Arc<Shot>) -> Result<(), String> {
        let (done, shown) = mpsc::channel();
        let windows = Arc::clone(&self.windows);
        let (monitor, shot) = (monitor.clone(), Arc::clone(shot));
        self.app
            .run_on_main_thread(move || {
                let mut windows = lock(&windows);
                let result = if windows.closed {
                    Err("the selection ended".to_string())
                } else {
                    show(&monitor, &shot).map(|handle| windows.shown.push((monitor.index, handle)))
                };
                let _ = done.send(result);
            })
            .map_err(|err| err.to_string())?;
        shown
            .recv_timeout(SHOW_TIMEOUT)
            .map_err(|_| "the frozen screen took too long to show".to_string())?
    }

    /// A way to put the frozen screens under their overlays that does not
    /// keep them up, for use once the session's lock is let go.
    pub fn order(&self) -> Order {
        Order(Arc::clone(&self.windows))
    }

    /// Takes the frozen screens down. Safe to call again.
    pub fn close(&self) {
        let windows = Arc::clone(&self.windows);
        // Windows are destroyed by the thread that made them. With the app
        // on its way out there is no main thread left to ask, and the
        // windows go with the process.
        let _ = self.app.run_on_main_thread(move || {
            let mut windows = lock(&windows);
            windows.closed = true;
            for (_, handle) in windows.shown.drain(..) {
                // SAFETY: a window this thread made in `show`.
                unsafe {
                    let _ = DestroyWindow(hwnd(handle));
                }
            }
        });
    }
}

impl Drop for Freeze {
    fn drop(&mut self) {
        self.close();
    }
}

/// The order of the frozen screens among the other windows
/// ([`Freeze::order`]).
pub struct Order(Arc<Mutex<Windows>>);

impl Order {
    /// Keeps the frozen screen of the monitor numbered `monitor` directly
    /// under its overlay, `above`. Both stay on top of other windows, and
    /// the frozen screen was made last, which would otherwise put it in
    /// front. Call on the main thread, once the overlay is showing.
    pub fn keep_under(&self, monitor: usize, above: *mut c_void) {
        let windows = lock(&self.0);
        for &(_, handle) in windows.shown.iter().filter(|(index, _)| *index == monitor) {
            // SAFETY: both are live windows of this thread. A failure
            // leaves the order as it was.
            unsafe {
                let _ = SetWindowPos(
                    hwnd(handle),
                    Some(HWND(above)),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
}

/// Captures every monitor, putting each on screen as it is captured. The
/// images are what [`crate::screen::capture_monitors`] returns.
///
/// The frozen screens stay up until the returned [`Freeze`] is closed or
/// dropped, which an error here does on the way out.
pub fn capture_monitors(
    app: &AppHandle,
) -> Result<(Vec<(MonitorInfo, RgbaImage)>, Freeze), String> {
    let monitors = crate::screen::monitors()?;
    let freeze = Freeze::new(app);
    // Every monitor is on show before any is converted, so the last one
    // is not kept waiting by the others.
    let mut shots = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let shot = Arc::new(Shot::take(&monitor)?);
        freeze.show(&monitor, &shot)?;
        shots.push((monitor, shot));
    }
    let frames = shots
        .into_iter()
        .map(|(monitor, shot)| shot.to_rgba().map(|image| (monitor, image)))
        .collect::<Result<Vec<_>, String>>()?;
    Ok((frames, freeze))
}

/// Shows and hides `window` in one frame, without the fade Windows gives a
/// window that appears or goes. The capture overlay covers the screen, so
/// its fade was the whole desktop dimming and brightening.
pub fn without_transitions(window: *mut c_void) {
    set_transitions(window, false);
}

/// Turns the fade Windows gives `window` as it appears or goes on or off.
/// Scroll capture turns the Quick Access card's off while it runs, so a
/// hidden card is gone from the very next frame instead of fading out in it.
pub fn set_transitions(window: *mut c_void, enabled: bool) {
    // `BOOL` is a 32-bit integer.
    let disabled: i32 = i32::from(!enabled);
    // SAFETY: `window` is a live window, and the value is read before the
    // call returns. A failure only keeps the window as it was.
    unsafe {
        let _ = DwmSetWindowAttribute(
            HWND(window),
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&raw const disabled).cast(),
            size_of::<i32>() as u32,
        );
    }
}

/// The app's module, with the frozen screens' window class registered.
fn instance() -> Result<HINSTANCE, String> {
    static REGISTER: Once = Once::new();
    // SAFETY: a null name asks for the module of the running program.
    let instance: HINSTANCE = unsafe { GetModuleHandleW(PCWSTR::null()) }
        .map_err(|err| err.to_string())?
        .into();
    REGISTER.call_once(|| {
        // SAFETY: the class name is static, and `window_proc` lives as
        // long as the program. A failure shows when the window is made.
        // The class has no cursor, so the pointer keeps the shape it had
        // over the window that was captured.
        unsafe {
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassW(&raw const class);
        }
    });
    Ok(instance)
}

/// A frozen screen only shows its picture: it takes the clicks that land on
/// it before its overlay is up, and does nothing with them.
unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: called by Windows with a live window and its message.
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// Makes a window over `monitor` holding `shot` and shows it without taking
/// the focus, so menus and tooltips stay as they were captured. On the main
/// thread, which runs the windows' messages.
fn show(monitor: &MonitorInfo, shot: &Shot) -> Result<Handle, String> {
    let instance = instance()?;
    // SAFETY: the window is made, drawn and shown on this thread, and
    // `shot` outlives the call that copies from it.
    unsafe {
        let window = CreateWindowExW(
            // Layered, so it holds the picture itself and is right in the
            // first frame it shows. A tool window stays out of the taskbar.
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            CLASS,
            w!("Grab-it frozen screen"),
            WS_POPUP,
            monitor.x,
            monitor.y,
            shot.width,
            shot.height,
            None,
            None,
            Some(instance),
            None,
        )
        .map_err(|err| format!("could not make the frozen screen: {err}"))?;
        without_transitions(window.0);
        let place = POINT {
            x: monitor.x,
            y: monitor.y,
        };
        let size = SIZE {
            cx: shot.width,
            cy: shot.height,
        };
        let origin = POINT::default();
        // Fully opaque, and the bitmap's own alpha is not used: GDI leaves
        // it unset.
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: 0,
        };
        if let Err(err) = UpdateLayeredWindow(
            window,
            None,
            Some(&raw const place),
            Some(&raw const size),
            Some(shot.dc),
            Some(&raw const origin),
            COLORREF(0),
            Some(&raw const blend),
            ULW_ALPHA,
        ) {
            let _ = DestroyWindow(window);
            return Err(format!("could not draw the frozen screen: {err}"));
        }
        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
        Ok(window.0 as Handle)
    }
}
