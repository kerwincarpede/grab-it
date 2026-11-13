//! Commands the frontend calls with `invoke`.

use std::sync::{Mutex, MutexGuard};

use tauri::State;

use crate::settings::{Settings, SettingsStore};

pub type SettingsState = Mutex<SettingsStore>;

fn lock(state: &SettingsState) -> MutexGuard<'_, SettingsStore> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    lock(&state).get().clone()
}

#[tauri::command]
pub fn set_save_folder(path: String, state: State<'_, SettingsState>) -> Result<Settings, String> {
    lock(&state)
        .set_save_folder(&path)
        .map_err(|err| err.to_string())
}
