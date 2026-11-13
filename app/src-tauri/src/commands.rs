//! Commands the frontend calls with `invoke`.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    hotkeys::{self, Hotkeys},
    settings::{Preferences, Settings, SettingsStore},
};

pub type SettingsState = Mutex<SettingsStore>;

pub fn lock(state: &SettingsState) -> MutexGuard<'_, SettingsStore> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    lock(&state).get().clone()
}

#[tauri::command]
pub fn set_save_folder(
    path: String,
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Settings, String> {
    let settings = lock(&state)
        .set_save_folder(&path)
        .map_err(|err| err.to_string())?;
    // Captures already in the new folder join the library; older ones stay.
    crate::library::rescan_in_background(&app, settings.save_folder.clone());
    Ok(settings)
}

#[tauri::command]
pub fn set_preferences(
    preferences: Preferences,
    state: State<'_, SettingsState>,
) -> Result<Settings, String> {
    lock(&state)
        .set_preferences(preferences)
        .map_err(|err| err.to_string())
}

/// Whether Grab-it starts when the user signs in. The operating system
/// holds this, not `settings.json`, so it is asked each time.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|err| format!("could not read the start-up setting: {err}"))
}

/// Turns starting at sign-in on or off. Returns the setting as the system
/// now reports it.
#[tauri::command]
pub fn set_autostart(enabled: bool, app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let changed = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    changed.map_err(|err| format!("could not change the start-up setting: {err}"))?;
    launcher
        .is_enabled()
        .map_err(|err| format!("could not read the start-up setting: {err}"))
}

/// The saved settings and any hotkey the system would not register.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeysUpdate {
    pub settings: Settings,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn set_hotkeys(
    hotkeys: Hotkeys,
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<HotkeysUpdate, String> {
    let settings = lock(&state)
        .set_hotkeys(&hotkeys)
        .map_err(|err| err.to_string())?;
    let warnings = hotkeys::apply(&app, &settings.hotkeys);
    Ok(HotkeysUpdate { settings, warnings })
}
