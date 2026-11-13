//! Creating and focusing the app's windows.

use std::{
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{actions, cli::OpenTarget, editor::EditorState, hotkeys, pin, quick};

pub const SETTINGS_LABEL: &str = "settings";
pub const LIBRARY_LABEL: &str = "library";
pub const WELCOME_LABEL: &str = "welcome";
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
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
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
    window.set_focus()?;
    Ok(())
}

/// Shows the Settings window, creating it on first use.
pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html#/settings".into()),
    )
    .title("Grab-it Settings")
    .inner_size(640.0, 720.0)
    .min_inner_size(480.0, 480.0)
    .center()
    .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Closed while recording a hotkey: give the hotkeys back.
        if matches!(event, WindowEvent::Destroyed) {
            hotkeys::resume(&handle);
        }
    });
    Ok(())
}

/// Shows the Library window, creating it on first use.
pub fn show_library(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LIBRARY_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        LIBRARY_LABEL,
        WebviewUrl::App("index.html#/library".into()),
    )
    .title("Grab-it Library")
    .inner_size(1100.0, 720.0)
    .min_inner_size(560.0, 400.0)
    .center()
    .build()?;
    Ok(())
}

/// Shows the Welcome window: what Grab-it does and its hotkeys. Opened by
/// itself on the first launch, and from the tray afterwards.
pub fn show_welcome(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WELCOME_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        WELCOME_LABEL,
        WebviewUrl::App("index.html#/welcome".into()),
    )
    .title("Welcome to Grab-it")
    .inner_size(620.0, 720.0)
    .min_inner_size(480.0, 480.0)
    .center()
    .build()?;
    Ok(())
}
