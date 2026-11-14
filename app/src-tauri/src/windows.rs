//! Creating and focusing the app's windows.

use std::{
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
};

use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::{actions, cli::OpenTarget, editor::EditorState, hotkeys, pin, quick};

/// The Grab-it window: library, Settings, shortcuts and tips.
pub const MAIN_LABEL: &str = "main";
/// Emitted to the Grab-it window, with a [`MainView`] name, to switch views.
pub const MAIN_NAVIGATE_EVENT: &str = "main-navigate";
/// Editor windows are labelled `editor-<n>`.
pub const EDITOR_LABEL_PREFIX: &str = "editor-";

/// Shows the window for an `--open` target.
pub fn open(app: &AppHandle, target: OpenTarget) -> tauri::Result<()> {
    match target {
        OpenTarget::Settings => show_settings(app),
        OpenTarget::Library => show_library(app),
        OpenTarget::Welcome => show_welcome(app),
        OpenTarget::Region => {
            actions::start(app, actions::Action::Region);
            Ok(())
        }
        OpenTarget::Text => {
            actions::start(app, actions::Action::Text);
            Ok(())
        }
        OpenTarget::Colour => {
            actions::start(app, actions::Action::Colour);
            Ok(())
        }
        OpenTarget::Repeat => {
            actions::start(app, actions::Action::Repeat);
            Ok(())
        }
        OpenTarget::Record => {
            actions::start(app, actions::Action::Record);
            Ok(())
        }
        OpenTarget::Editor(path) => match existing_file(&path) {
            Some(path) => show_editor(app, &path),
            None => Ok(()),
        },
        OpenTarget::Quick(path) => {
            if let Some(path) = existing_file(&path) {
                let size = image::image_dimensions(&path).unwrap_or_default();
                quick::show(app, quick::QuickItem::capture(&path, size, false));
            }
            Ok(())
        }
        OpenTarget::Pin(path) => {
            if let Some(path) = existing_file(&path)
                && let Err(err) = pin::open(app, &path, false)
            {
                eprintln!("Grab-it: {err}");
            }
            Ok(())
        }
    }
}

/// The full path of a file named on the command line, or `None` (after
/// saying so) when there is no such file.
fn existing_file(path: &Path) -> Option<std::path::PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(path) if path.is_file() => Some(path),
        _ => {
            eprintln!("Grab-it: no capture at {}", path.display());
            None
        }
    }
}

/// Opens `capture` in an editor window, or focuses the one already showing it.
pub fn show_editor(app: &AppHandle, capture: &Path) -> tauri::Result<()> {
    static NEXT_EDITOR: AtomicU32 = AtomicU32::new(1);

    let state = app.state::<EditorState>();
    if let Some(window) = state
        .label_for(capture)
        .and_then(|label| app.get_webview_window(&label))
    {
        return bring_to_front(&window);
    }

    let label = format!(
        "{EDITOR_LABEL_PREFIX}{}",
        NEXT_EDITOR.fetch_add(1, Ordering::Relaxed)
    );
    // Registered before the page loads so `editor_info` finds it.
    state.insert(&label, capture.to_path_buf());
    let file_name = capture
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/editor".into()))
            .title(format!("{file_name} - Grab-it Editor"))
            .inner_size(1100.0, 760.0)
            .min_inner_size(640.0, 420.0)
            .center()
            .build();
    let window = match window {
        Ok(window) => window,
        Err(err) => {
            state.remove(&label);
            return Err(err);
        }
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app.state::<EditorState>().remove(&label);
        }
    });
    bring_to_front(&window)
}

/// What the main window shows. Mirrors `MainView` in src/app/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainView {
    Library,
    Settings,
    Welcome,
}

impl MainView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Settings => "settings",
            Self::Welcome => "welcome",
        }
    }
}

/// Shows the Grab-it window on `view`, creating it on first use. It holds
/// the library, Settings and the shortcuts, so there is one window to find.
pub fn show_main(app: &AppHandle, view: MainView) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        window.emit(MAIN_NAVIGATE_EVENT, view.as_str())?;
        return bring_to_front(&window);
    }
    let builder = WebviewWindowBuilder::new(
        app,
        MAIN_LABEL,
        WebviewUrl::App(format!("index.html#/app/{}", view.as_str()).into()),
    )
    .title("Grab-it")
    .inner_size(1180.0, 760.0)
    .min_inner_size(720.0, 480.0)
    .center();
    // On macOS the sidebar runs to the top and holds the window buttons;
    // the page marks where the window can be dragged.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    let zoom = app
        .try_state::<crate::commands::SettingsState>()
        .map(|state| crate::commands::lock(&state).get().appearance.zoom())
        .unwrap_or_else(|| crate::settings::Appearance::default().zoom());
    if let Err(err) = window.set_zoom(zoom) {
        eprintln!("Grab-it: could not set the text size: {err}");
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Closed while recording a hotkey in Settings: give the hotkeys back.
        if matches!(event, WindowEvent::Destroyed) {
            hotkeys::resume(&handle);
        }
    });
    bring_to_front(&window)
}

/// Shows `window` in front of every app's windows, not just Grab-it's, and
/// makes Grab-it the active app.
///
/// Grab-it lives in the menu bar, so it is usually in the background when a
/// window is asked for. Becoming the active app is what makes macOS, and
/// window managers that follow focus such as AeroSpace, switch to the space
/// or workspace the window is on rather than leaving it out of sight there.
pub fn bring_to_front(window: &WebviewWindow) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    #[cfg(target_os = "macos")]
    activate(window)?;
    Ok(())
}

/// macOS: activates Grab-it with all its windows and orders `window` front.
///
/// `set_focus` asks to activate only through `NSApp`, which newer macOS may
/// turn down for an app in the background; asking the app's
/// `NSRunningApplication` as well, and ordering the window front regardless,
/// brings it forward even then.
#[cfg(target_os = "macos")]
fn activate(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2::runtime::AnyObject;

    /// `NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps`.
    const ACTIVATE_ALL_IGNORING_OTHERS: usize = 1 | 2;

    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: on the main thread, with this window's live NSWindow; each
        // selector is a documented NSRunningApplication or NSWindow method
        // with the argument and return types given.
        unsafe {
            let running: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSRunningApplication), currentApplication];
            if !running.is_null() {
                let _: bool =
                    objc2::msg_send![running, activateWithOptions: ACTIVATE_ALL_IGNORING_OTHERS];
            }
            let none: *mut AnyObject = std::ptr::null_mut();
            let _: () = objc2::msg_send![ns_window, makeKeyAndOrderFront: none];
            let _: () = objc2::msg_send![ns_window, orderFrontRegardless];
        }
    })
}

/// Draws the Grab-it window at `zoom` (1.0 is actual size), when it is open.
pub fn apply_zoom(app: &AppHandle, zoom: f64) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL)
        && let Err(err) = window.set_zoom(zoom)
    {
        eprintln!("Grab-it: could not set the text size: {err}");
    }
}

/// Shows the Grab-it window on Settings.
pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Settings)
}

/// Shows the Grab-it window on the library.
pub fn show_library(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Library)
}

/// Shows the Grab-it window on the shortcuts and tips. Opened by itself on
/// the first launch, and from the tray afterwards.
pub fn show_welcome(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Welcome)
}

/// Gives Grab-it a Dock icon, or takes it away (macOS only).
pub fn apply_dock_icon(app: &AppHandle, show: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if show {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(err) = app.set_activation_policy(policy) {
            eprintln!("Grab-it: could not change the Dock icon: {err}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, show);
}
