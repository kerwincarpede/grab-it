//! Global hotkeys for the three capture modes.
//!
//! The defaults are PrintScreen, Alt+PrintScreen and Ctrl+PrintScreen for
//! region, window and screen; on macOS Cmd+Shift+2, Cmd+Shift+W and
//! Cmd+Shift+F. On Wayland they are bound through the GlobalShortcuts portal
//! (see `portal.rs`), since apps cannot grab keys there themselves.

use std::{
    str::FromStr,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{
    actions,
    capture::CaptureMode,
    commands::{SettingsState, lock},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub region: String,
    pub window: String,
    pub screen: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        if cfg!(target_os = "macos") {
            Self {
                region: "Cmd+Shift+2".into(),
                window: "Cmd+Shift+W".into(),
                screen: "Cmd+Shift+F".into(),
            }
        } else {
            Self {
                region: "PrintScreen".into(),
                window: "Alt+PrintScreen".into(),
                screen: "Ctrl+PrintScreen".into(),
            }
        }
    }
}

impl Hotkeys {
    fn entries(&self) -> [(CaptureMode, &'static str, &str); 3] {
        [
            (CaptureMode::Region, "Region", self.region.as_str()),
            (CaptureMode::Window, "Window", self.window.as_str()),
            (CaptureMode::Screen, "Screen", self.screen.as_str()),
        ]
    }

    /// Trims every hotkey and checks it parses and is not used twice.
    pub fn validated(&self) -> Result<Hotkeys, String> {
        let trimmed = Hotkeys {
            region: self.region.trim().to_owned(),
            window: self.window.trim().to_owned(),
            screen: self.screen.trim().to_owned(),
        };
        let mut seen: Vec<(Shortcut, &str)> = Vec::new();
        for (_, name, accelerator) in trimmed.entries() {
            if accelerator.is_empty() {
                return Err(format!("Choose a hotkey for {name}."));
            }
            let shortcut = Shortcut::from_str(accelerator)
                .map_err(|_| format!("`{accelerator}` is not a valid hotkey for {name}."))?;
            if let Some((_, other)) = seen.iter().find(|(s, _)| *s == shortcut) {
                return Err(format!("{name} and {other} use the same hotkey."));
            }
            seen.push((shortcut, name));
        }
        Ok(trimmed)
    }
}

/// The registered hotkeys and the capture each one starts.
#[derive(Default)]
pub struct HotkeyState {
    bound: Mutex<Vec<(Shortcut, CaptureMode)>>,
    /// Set while Settings records a hotkey, so pressing a current hotkey
    /// there records it instead of starting a capture.
    paused: AtomicBool,
}

impl HotkeyState {
    fn bound(&self) -> std::sync::MutexGuard<'_, Vec<(Shortcut, CaptureMode)>> {
        self.bound.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn is_paused(app: &AppHandle) -> bool {
    app.try_state::<HotkeyState>()
        .is_some_and(|state| state.paused.load(Ordering::SeqCst))
}

/// Stops the hotkeys from starting captures while Settings records one.
///
/// Outside Wayland the shortcuts are unregistered too, since the system
/// would otherwise keep the keys from ever reaching the Settings window.
pub fn pause(app: &AppHandle) {
    let Some(state) = app.try_state::<HotkeyState>() else {
        return;
    };
    if state.paused.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return;
    }
    if let Err(err) = app.global_shortcut().unregister_all() {
        eprintln!("Grab-it: could not pause hotkeys: {err}");
    }
    state.bound().clear();
}

/// Undoes [`pause`], registering the saved hotkeys again.
pub fn resume(app: &AppHandle) {
    let Some(state) = app.try_state::<HotkeyState>() else {
        return;
    };
    if !state.paused.swap(false, Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return;
    }
    let Some(settings) = app.try_state::<SettingsState>() else {
        return;
    };
    let hotkeys = lock(&settings).get().hotkeys.clone();
    for problem in apply(app, &hotkeys) {
        eprintln!("Grab-it: {problem}");
    }
}

#[tauri::command]
pub fn pause_hotkeys(app: AppHandle) {
    pause(&app);
}

#[tauri::command]
pub fn resume_hotkeys(app: AppHandle) {
    resume(&app);
}

/// The global-shortcut plugin, dispatching presses to captures.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed || is_paused(app) {
                return;
            }
            let mode = app.try_state::<HotkeyState>().and_then(|state| {
                state
                    .bound()
                    .iter()
                    .find(|(s, _)| s == shortcut)
                    .map(|(_, mode)| *mode)
            });
            if let Some(mode) = mode {
                actions::start(app, actions::Action::from_mode(mode));
            }
        })
        .build()
}

/// Replaces the registered hotkeys. Returns one message per hotkey that
/// could not be registered, for example because another app holds it.
pub fn apply(app: &AppHandle, hotkeys: &Hotkeys) -> Vec<String> {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return vec![
            "On Wayland your desktop binds Grab-it's hotkeys. Restart Grab-it to offer the new ones, then confirm them in your desktop's shortcut settings."
                .into(),
        ];
    }

    let shortcuts = app.global_shortcut();
    if let Err(err) = shortcuts.unregister_all() {
        eprintln!("Grab-it: could not clear hotkeys: {err}");
    }
    let mut problems = Vec::new();
    let mut bound = Vec::new();
    for (mode, name, accelerator) in hotkeys.entries() {
        let shortcut = match Shortcut::from_str(accelerator) {
            Ok(shortcut) => shortcut,
            Err(err) => {
                problems.push(format!("{name} hotkey `{accelerator}` is not valid: {err}"));
                continue;
            }
        };
        match shortcuts.register(shortcut) {
            Ok(()) => bound.push((shortcut, mode)),
            Err(err) => problems.push(format!(
                "{name} hotkey `{accelerator}` could not be registered: {err}"
            )),
        }
    }
    if let Some(state) = app.try_state::<HotkeyState>() {
        *state.bound() = bound;
    }
    problems
}

/// Registers the hotkeys at startup: through the portal on Wayland, else
/// through the global-shortcut plugin. Failures are logged; the tray still
/// starts every capture.
pub fn start(app: &AppHandle, hotkeys: &Hotkeys) {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        let handle = app.clone();
        let hotkeys = hotkeys.clone();
        tauri::async_runtime::spawn(async move {
            let on_press = move |mode: CaptureMode| {
                if !is_paused(&handle) {
                    actions::start(&handle, actions::Action::from_mode(mode));
                }
            };
            if let Err(err) = crate::portal::run_global_shortcuts(hotkeys, on_press).await {
                eprintln!("Grab-it: {err}. Use the tray menu to capture.");
            }
        });
        return;
    }

    for problem in apply(app, hotkeys) {
        eprintln!("Grab-it: {problem}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_distinct() {
        let defaults = Hotkeys::default();
        assert_eq!(defaults.validated(), Ok(defaults.clone()));
        if cfg!(target_os = "macos") {
            assert_eq!(defaults.region, "Cmd+Shift+2");
        } else {
            assert_eq!(defaults.region, "PrintScreen");
            assert_eq!(defaults.window, "Alt+PrintScreen");
            assert_eq!(defaults.screen, "Ctrl+PrintScreen");
        }
    }

    #[test]
    fn hotkeys_are_trimmed() {
        let hotkeys = Hotkeys {
            region: "  Ctrl+Shift+R ".into(),
            ..Hotkeys::default()
        };
        assert_eq!(hotkeys.validated().unwrap().region, "Ctrl+Shift+R");
    }

    #[test]
    fn empty_invalid_and_duplicate_hotkeys_are_rejected() {
        let empty = Hotkeys {
            window: " ".into(),
            ..Hotkeys::default()
        };
        assert_eq!(empty.validated(), Err("Choose a hotkey for Window.".into()));

        let invalid = Hotkeys {
            screen: "Ctrl+Nope".into(),
            ..Hotkeys::default()
        };
        assert!(invalid.validated().unwrap_err().contains("Ctrl+Nope"));

        let duplicate = Hotkeys {
            region: "Ctrl+Shift+S".into(),
            window: "shift+ctrl+s".into(),
            screen: "PrintScreen".into(),
        };
        assert_eq!(
            duplicate.validated(),
            Err("Window and Region use the same hotkey.".into())
        );
    }
}
