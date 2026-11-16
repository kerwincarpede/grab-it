//! macOS: windows that take the keyboard without making Grab-it the active
//! app, and giving the focus back to the app the user was in.
//!
//! `set_focus` makes a window key with `makeKeyAndOrderFront:` and then
//! activates Grab-it. Activating Grab-it brings its other windows forward
//! too (the library, Settings, the editor), and window managers that follow
//! the focus, such as AeroSpace, move to that window or switch to its
//! workspace. The capture overlay and the menu bar hub only need the
//! keyboard, so they are made non-activating panels ([`make_panel`]), the
//! kind Spotlight uses: key while another app stays active.
//!
//! AppKit only honours `NSWindowStyleMaskNonactivatingPanel` on an
//! `NSPanel`, and Tauri makes every window a `TaoWindow`, a plain
//! `NSWindow`. The window's class is swapped for [`PANEL_CLASS`], an
//! `NSPanel` subclass, as `tauri-nspanel` does. `NSPanel` adds no instance
//! variables to `NSWindow`, so tao's own state after them stays where tao
//! reads it; the window becomes a `TaoWindow` again just before it is freed,
//! so tao's `dealloc` drops that state.

use std::sync::OnceLock;

use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
use tauri::{AppHandle, WebviewWindow};

/// The `NSPanel` subclass overlays and the hub become.
const PANEL_CLASS: &std::ffi::CStr = c"GrabItPanel";
/// The class Tauri's windows have, which [`make_panel`] replaces.
const TAO_CLASS: &std::ffi::CStr = c"TaoWindow";

/// `NSWindowStyleMaskNonactivatingPanel`.
const NONACTIVATING_PANEL: usize = 1 << 7;
/// `NSApplicationActivateIgnoringOtherApps`. macOS 14 ignores it, and
/// activates the app when the active one yields to it instead.
const ACTIVATE_IGNORING_OTHERS: usize = 1 << 1;

unsafe extern "C" {
    /// The runtime's own `object_setClass`. objc2's wrapper asserts that both
    /// classes have the same instance size, which a `TaoWindow`, with its
    /// state after `NSWindow`'s, and [`PANEL_CLASS`] do not.
    fn object_setClass(object: *mut AnyObject, class: *const AnyClass) -> *const AnyClass;
}

/// The panel class, defined on first use. `None` where AppKit has no
/// `NSPanel` or the name is taken.
fn panel_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(PANEL_CLASS, AnyClass::get(c"NSPanel")?)?;
        // SAFETY: each function has the signature of the method it
        // implements: `canBecomeKeyWindow` and `canBecomeMainWindow` return a
        // BOOL, `cancelOperation:` takes the sender, `dealloc` takes nothing.
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                yes as extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                no as extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
            );
            builder.add_method(
                sel!(cancelOperation:),
                ignore as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
            );
            builder.add_method(
                sel!(dealloc),
                dealloc as unsafe extern "C-unwind" fn(*mut AnyObject, Sel),
            );
        }
        Some(builder.register())
    })
}

/// A borderless window can be key only when its class says so. The page
/// needs the keyboard: Esc, and the toolbar's shortcuts.
extern "C-unwind" fn yes(_: *mut AnyObject, _: Sel) -> Bool {
    Bool::YES
}

extern "C-unwind" fn no(_: *mut AnyObject, _: Sel) -> Bool {
    Bool::NO
}

/// A panel closes itself on an Esc the page leaves alone. The overlay and
/// the hub handle Esc themselves, and a closed hub would be gone for good,
/// so Esc does here what it did before: nothing.
extern "C-unwind" fn ignore(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {}

/// Frees the window as the `TaoWindow` it was made as.
///
/// SAFETY: called by the runtime as `dealloc`, on a window [`make_panel`]
/// changed from a `TaoWindow`.
unsafe extern "C-unwind" fn dealloc(this: *mut AnyObject, cmd: Sel) {
    let Some(tao) = AnyClass::get(TAO_CLASS) else {
        return;
    };
    let Some(method) = tao.instance_method(cmd) else {
        return;
    };
    // SAFETY: the window was a `TaoWindow` before `make_panel` changed it,
    // and `TaoWindow`'s `dealloc` takes no arguments.
    unsafe {
        object_setClass(this, tao);
        let tao_dealloc: unsafe extern "C-unwind" fn(*mut AnyObject, Sel) =
            std::mem::transmute(method.implementation());
        tao_dealloc(this, cmd);
    }
}

/// `window`'s NSWindow, or null.
fn ns_window(window: &WebviewWindow) -> *mut AnyObject {
    window
        .ns_window()
        .map(|ns_window| ns_window.cast::<AnyObject>())
        .unwrap_or(std::ptr::null_mut())
}

/// Turns `window` into a non-activating panel, queued on the main thread
/// ahead of whatever is asked of the window next. A window that is not a
/// plain `TaoWindow` (Tauri changed, or the panel class could not be made)
/// is left alone, and [`focus`] activates Grab-it for it as before.
pub fn make_panel(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let ns_window = ns_window(&target);
        let (Some(tao), Some(panel)) = (AnyClass::get(TAO_CLASS), panel_class()) else {
            return;
        };
        if ns_window.is_null() {
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread. Its class is only changed from `TaoWindow`, whose
        // instance variables come after NSWindow's, to an NSPanel subclass,
        // which adds none, overrides nothing tao relies on, and changes it
        // back before the window is freed. The selectors are documented
        // NSWindow and NSResponder methods with the types given, apart from
        // `_setPreventsActivation:`, which is only sent where it exists.
        unsafe {
            if !std::ptr::eq((*ns_window).class(), tao) {
                return;
            }
            object_setClass(ns_window, panel);
            // Changing the style mask can drop the first responder, and with
            // it the keyboard, as tao notes where it changes one.
            let responder: *mut AnyObject = msg_send![ns_window, firstResponder];
            let mask: usize = msg_send![ns_window, styleMask];
            let _: () = msg_send![ns_window, setStyleMask: mask | NONACTIVATING_PANEL];
            if !responder.is_null() {
                let _: Bool = msg_send![ns_window, makeFirstResponder: responder];
            }
            // What the style does to a panel made with it. Set after the
            // panel was made, AppKit may not pass it on to the window server,
            // and then a click on the panel still activates Grab-it.
            let can_prevent: Bool = msg_send![
                ns_window,
                respondsToSelector: sel!(_setPreventsActivation:)
            ];
            if can_prevent.as_bool() {
                let _: () = msg_send![ns_window, _setPreventsActivation: Bool::YES];
            }
            // Made as a window, so it is already off; a panel's default is on.
            let _: () = msg_send![ns_window, setHidesOnDeactivate: Bool::NO];
        }
    })
}

/// Gives `window`, already shown, the keyboard: a panel without activating
/// Grab-it, any other window by activating it, as `set_focus` does.
pub fn focus(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    // Queued, like `show`, so the class is read after `make_panel` changed it.
    window.run_on_main_thread(move || {
        let ns_window = ns_window(&target);
        let Some(panel) = AnyClass::get(PANEL_CLASS) else {
            let _ = target.set_focus();
            return;
        };
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread; both selectors are documented NSWindow methods.
        unsafe {
            if ns_window.is_null() || !std::ptr::eq((*ns_window).class(), panel) {
                let _ = target.set_focus();
                return;
            }
            let _: () = msg_send![ns_window, orderFrontRegardless];
            let _: () = msg_send![ns_window, makeKeyWindow];
        }
    })
}

/// Makes the app with process `pid` active again, if Grab-it took over
/// from it. Grab-it is only active then when something activated it after
/// all: a window that could not become a panel, or a click macOS let
/// through. Otherwise the app the user was in never stopped being active,
/// and nothing is done.
pub fn reactivate(app: &AppHandle, pid: u32) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        // SAFETY: on the main thread. Each selector is a documented
        // NSApplication or NSRunningApplication method with the argument and
        // return types given; `yieldActivationToApplication:` (macOS 14) is
        // only sent where it exists.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            if ns_app.is_null() {
                return;
            }
            let active: Bool = msg_send![ns_app, isActive];
            if !active.as_bool() {
                return;
            }
            let running: *mut AnyObject = msg_send![
                objc2::class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid
            ];
            if running.is_null() {
                return;
            }
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
