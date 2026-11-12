//! Creating and focusing the app's windows.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::cli::OpenTarget;

pub const SETTINGS_LABEL: &str = "settings";

/// Shows the window for an `--open` target.
pub fn open(app: &AppHandle, target: OpenTarget) -> tauri::Result<()> {
    match target {
        OpenTarget::Settings => show_settings(app),
    }
}

/// Shows the Settings window, creating it on first use.
pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html#/settings".into()),
    )
    .title("Grab-it Settings")
    .inner_size(560.0, 300.0)
    .min_inner_size(420.0, 260.0)
    .center()
    .build()?;
    Ok(())
}
