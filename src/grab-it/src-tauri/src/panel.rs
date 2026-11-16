//! macOS: windows that take the keyboard without making Grab-it the active
//! app.
//!
//! `set_focus` makes a window key with `makeKeyAndOrderFront:` and then
//! activates Grab-it. Activating Grab-it brings its other windows forward
//! too (the library, Settings, the editor), and window managers that follow
//! the focus, such as AeroSpace, move to that window or switch to its
//! workspace. The capture overlay and the menu bar hub only need the
//! keyboard, so they are made non-activating ([`make_panel`]), as Spotlight
//! is: key while another app stays active.
//!
//! AppKit keeps that behaviour for an `NSPanel` with
//! `NSWindowStyleMaskNonactivatingPanel`, and Tauri's windows are plain
//! `NSWindow`s. Changing their class, as `tauri-nspanel` does, is not safe
//! here: WebKit observes the window, so its class is already one Key-Value
//! Observing made, which keeps its own state for it. Instead a marked
//! window is made to behave as such a panel does:
//!
//! - AppKit's private `_isNonactivatingPanel`, which every `NSWindow` has
//!   and an `NSPanel` answers from its style mask, answers yes, so making
//!   it key does not activate Grab-it, and `_setPreventsActivation:` stops a
//!   click on it from doing so.
//! - It cannot become the main window, and has no style but borderless, so
//!   the accessibility API reports it as neither a standard window nor a
//!   dialog. AeroSpace manages those, and moves the focus to another window
//!   when one closes.
//!
//! Where macOS has neither private method, nothing changes, and [`focus`]
//! activates Grab-it as before. The webview must not be made focused
//! either: wry activates the app as it makes a focused one.

use std::{ffi::c_void, sync::OnceLock};

use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
    sel,
};
use tauri::{AppHandle, WebviewWindow};

/// `NSApplicationActivateIgnoringOtherApps`. macOS 14 ignores it, and
/// activates an app when the active one yields to it instead.
const ACTIVATE_IGNORING_OTHERS: usize = 1 << 1;
/// `NSWindowStyleMaskBorderless`.
const BORDERLESS: usize = 0;
/// `OBJC_ASSOCIATION_ASSIGN`: the mark holds a class, which is never freed.
const ASSIGN: usize = 0;

/// Tells the windows [`make_panel`] marked apart: the address is the key.
static MARK: u8 = 0;

unsafe extern "C" {
    fn objc_setAssociatedObject(
        object: *mut AnyObject,
        key: *const c_void,
        value: *mut AnyObject,
        policy: usize,
    );
    fn objc_getAssociatedObject(object: *mut AnyObject, key: *const c_void) -> *mut AnyObject;
    fn class_getInstanceMethod(class: *const AnyClass, sel: Sel) -> *mut c_void;
    fn method_setImplementation(method: *mut c_void, imp: Imp) -> Option<Imp>;
}

type Getter = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool;

/// The implementations [`install`] replaced, which every window Grab-it
/// has not marked still gets.
static NONACTIVATING_ORIGINAL: OnceLock<Getter> = OnceLock::new();
static MAIN_ORIGINAL: OnceLock<Getter> = OnceLock::new();
/// Whether [`install`] replaced both.
static INSTALLED: OnceLock<bool> = OnceLock::new();

fn is_marked(window: *mut AnyObject) -> bool {
    // SAFETY: `window` is a live object; reading an association sends it no
    // message.
    !unsafe { objc_getAssociatedObject(window, (&raw const MARK).cast()) }.is_null()
}

/// `_isNonactivatingPanel` for every window: yes for a marked one, else
/// what AppKit says.
///
/// SAFETY: called by the runtime as `-[NSWindow _isNonactivatingPanel]`.
unsafe extern "C-unwind" fn is_nonactivating_panel(this: *mut AnyObject, cmd: Sel) -> Bool {
    if is_marked(this) {
        return Bool::YES;
    }
    match NONACTIVATING_ORIGINAL.get() {
        // SAFETY: the method's own implementation, with its own arguments.
        Some(original) => unsafe { original(this, cmd) },
        None => Bool::NO,
    }
}

/// `canBecomeMainWindow` for Tauri's windows: no for a marked one, as for a
/// panel, else what tao says. AppKit reports a window that can become main
/// as a standard window.
///
/// SAFETY: called by the runtime as `-[TaoWindow canBecomeMainWindow]`.
unsafe extern "C-unwind" fn can_become_main(this: *mut AnyObject, cmd: Sel) -> Bool {
    if is_marked(this) {
        return Bool::NO;
    }
    match MAIN_ORIGINAL.get() {
        // SAFETY: the method's own implementation, with its own arguments.
        Some(original) => unsafe { original(this, cmd) },
        None => Bool::NO,
    }
}

/// Points `class`'s `sel`, a BOOL getter, at `with`, keeping the old one in
/// `original` first.
///
/// SAFETY: on the main thread; `sel` returns a BOOL and takes no arguments.
unsafe fn replace(class: &AnyClass, sel: Sel, with: Getter, original: &OnceLock<Getter>) -> bool {
    // SAFETY: as the caller promises; `with` has the method's signature.
    unsafe {
        let method = class_getInstanceMethod(class, sel);
        if method.is_null() {
            return false;
        }
        let old = method_setImplementation(method, std::mem::transmute::<Getter, Imp>(with));
        match old {
            Some(old) => original
                .set(std::mem::transmute::<Imp, Getter>(old))
                .is_ok(),
            None => false,
        }
    }
}

/// Replaces `_isNonactivatingPanel`, and `canBecomeMainWindow` where
/// `ns_window`'s class finds it (tao's own), once. False where AppKit has
/// neither, or no `_setPreventsActivation:` to go with them.
///
/// SAFETY: on the main thread, with a live NSWindow.
unsafe fn install(ns_window: *mut AnyObject) -> bool {
    *INSTALLED.get_or_init(|| {
        let Some(window) = AnyClass::get(c"NSWindow") else {
            return false;
        };
        if window
            .instance_method(sel!(_setPreventsActivation:))
            .is_none()
        {
            return false;
        }
        // SAFETY: on the main thread, before any window is marked; both are
        // BOOL getters, and the replacements call the originals for every
        // window but Grab-it's own.
        unsafe {
            let class = (*ns_window).class();
            replace(
                class,
                sel!(canBecomeMainWindow),
                can_become_main,
                &MAIN_ORIGINAL,
            ) && replace(
                window,
                sel!(_isNonactivatingPanel),
                is_nonactivating_panel,
                &NONACTIVATING_ORIGINAL,
            )
        }
    })
}

/// `window`'s NSWindow, or null.
fn ns_window(window: &WebviewWindow) -> *mut AnyObject {
    window
        .ns_window()
        .map(|ns_window| ns_window.cast::<AnyObject>())
        .unwrap_or(std::ptr::null_mut())
}

/// Makes `window` take the keyboard without activating Grab-it, queued on
/// the main thread ahead of whatever is asked of the window next.
pub fn make_panel(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let ns_window = ns_window(&target);
        // SAFETY: on the main thread, with this window's live NSWindow.
        if ns_window.is_null() || !unsafe { install(ns_window) } {
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread. `install` checked that `_setPreventsActivation:`
        // exists; it takes a BOOL. The mark is a class, which outlives it.
        unsafe {
            let _: () = msg_send![ns_window, _setPreventsActivation: Bool::YES];
            // Nothing but borderless: with any other style (tao gives a window
            // without decorations a full-size content view), AppKit reports
            // it as a dialog. Changing the style can drop the first
            // responder, and with it the keyboard, as tao notes where it
            // changes one.
            let responder: *mut AnyObject = msg_send![ns_window, firstResponder];
            let _: () = msg_send![ns_window, setStyleMask: BORDERLESS];
            if !responder.is_null() {
                let _: Bool = msg_send![ns_window, makeFirstResponder: responder];
            }
            let mark: *const AnyClass = objc2::class!(NSObject);
            objc_setAssociatedObject(
                ns_window,
                (&raw const MARK).cast(),
                mark.cast_mut().cast(),
                ASSIGN,
            );
        }
    })
}

/// Gives `window`, already shown, the keyboard: a marked one without
/// activating Grab-it, any other by activating it, as `set_focus` does.
pub fn focus(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    // Queued, like `show`, so the mark is read after `make_panel` set it.
    window.run_on_main_thread(move || {
        let ns_window = ns_window(&target);
        if ns_window.is_null() || !is_marked(ns_window) {
            let _ = target.set_focus();
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread; both selectors are documented NSWindow methods.
        unsafe {
            let _: () = msg_send![ns_window, orderFrontRegardless];
            let _: () = msg_send![ns_window, makeKeyWindow];
        }
        // Keys go to the page. wry only does this for a webview made focused,
        // which would activate Grab-it.
        let _ = target.with_webview(|webview| {
            let web_view = webview.inner().cast::<AnyObject>();
            let ns_window = webview.ns_window().cast::<AnyObject>();
            if web_view.is_null() || ns_window.is_null() {
                return;
            }
            // SAFETY: the window's live NSWindow and WKWebView, used on the
            // main thread, where `with_webview` runs.
            unsafe {
                let _: Bool = msg_send![ns_window, makeFirstResponder: web_view];
            }
        });
    })
}

/// Makes `previous`, the app that was active before the overlay opened,
/// active again if Grab-it is the active app: something activated it after
/// all (a window that could not be marked, or a click macOS let through).
/// Otherwise the app the user was in never stopped being active, and
/// nothing is done.
pub fn reactivate(app: &AppHandle, previous: u32) {
    let Ok(previous) = i32::try_from(previous) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        // SAFETY: on the main thread. Each selector is a documented
        // NSApplication, NSWorkspace or NSRunningApplication method with the
        // argument and return types given; `yieldActivationToApplication:`
        // (macOS 14) is only sent where it exists.
        unsafe {
            // Not `NSApp.isActive`: that is also true while a marked window is
            // key, with another app in front.
            let workspace: *mut AnyObject = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
            let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
            if front.is_null() {
                return;
            }
            let front_pid: i32 = msg_send![front, processIdentifier];
            if i64::from(front_pid) != i64::from(std::process::id()) {
                return;
            }
            let running: *mut AnyObject = msg_send![
                objc2::class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: previous
            ];
            if running.is_null() {
                return;
            }
            let ns_app: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            let can_yield: Bool = msg_send![
                ns_app,
                respondsToSelector: sel!(yieldActivationToApplication:)
            ];
            if can_yield.as_bool() {
                let _: () = msg_send![ns_app, yieldActivationToApplication: running];
            }
            let _: bool = msg_send![running, activateWithOptions: ACTIVATE_IGNORING_OTHERS];
        }
    });
}
