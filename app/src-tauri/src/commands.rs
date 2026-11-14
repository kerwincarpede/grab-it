//! Commands the frontend calls with `invoke`.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    hotkeys::{self, Hotkeys},
    settings::{EditorPreferences, PreferencesUpdate, Settings, SettingsStore},
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

/// Saves the capture and AI preferences. Without `ai`, the AI settings
/// are kept.
#[tauri::command]
pub fn set_preferences(
    preferences: PreferencesUpdate,
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Settings, String> {
    let mut store = lock(&state);
    let before = store.get().preferences.ai.clone();
    let settings = store
        .set_preferences(preferences)
        .map_err(|err| err.to_string())?;
    // Still locked, so the describing queue cannot start on a capture
    // that turning it on for new captures only skips.
    crate::ai::settings_saved(&app, &before, &settings.preferences.ai);
    Ok(settings)
}

/// The annotation editor's remembered colour, tool, widths and options.
#[tauri::command]
pub fn get_editor_preferences(state: State<'_, SettingsState>) -> EditorPreferences {
    lock(&state).get().editor.clone()
}

#[tauri::command]
pub fn set_editor_preferences(
    preferences: EditorPreferences,
    state: State<'_, SettingsState>,
) -> Result<EditorPreferences, String> {
    lock(&state)
        .set_editor_preferences(preferences)
        .map_err(|err| err.to_string())
}

/// Turns framing new captures with the last backdrop on or off.
#[tauri::command]
pub fn set_auto_backdrop(
    enabled: bool,
    state: State<'_, SettingsState>,
) -> Result<Settings, String> {
    lock(&state)
        .set_auto_backdrop(enabled)
        .map_err(|err| err.to_string())
}

/// Clears the one-time notice that Grab-it turned describing on.
#[tauri::command]
pub fn dismiss_ai_notice(state: State<'_, SettingsState>) -> Result<Settings, String> {
    lock(&state)
        .dismiss_ai_notice()
        .map_err(|err| err.to_string())
}

/// Opens a window or starts a capture by its `--open` name (`region`,
/// `settings`, `library`…), for the Welcome window's buttons.
#[tauri::command]
pub fn open_target(target: String, app: AppHandle) -> Result<(), String> {
    let target = crate::cli::parse_open_target(["grab-it", "--open", target.as_str()])
        .map_err(|err| err.to_string())?
        .ok_or("nothing to open")?;
    // Off the main thread: a window must not be created from inside a
    // synchronous command.
    std::thread::spawn(move || {
        if let Err(err) = crate::windows::open(&app, target) {
            eprintln!("Grab-it: {err}");
        }
    });
    Ok(())
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
