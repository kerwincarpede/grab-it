//! Creating and focusing the app's windows.

use std::{
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
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
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Closed while recording a hotkey in Settings: give the hotkeys back.
        if matches!(event, WindowEvent::Destroyed) {
            hotkeys::resume(&handle);
        }
    });
    window.set_focus()?;
    Ok(())
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
