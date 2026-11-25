//! Windows 11's "Use the Print screen key to open screen capture" setting.
//!
//! While it is on, Windows opens its own screen capture on a bare
//! `PrintScreen` too, so a Grab-it hotkey on that key takes turns with it.
//! The welcome hotkeys page and Settings → Capture hotkeys ask
//! [`printscreen_conflict`] when they open and show a notice whose buttons
//! call [`printscreen_fix`] and [`printscreen_open_settings`]. The setting
//! is the `PrintScreenKeyForSnippingEnabled` value under
//! `HKCU\Control Panel\Keyboard`; only 1 counts as on. Other systems never
//! report a conflict.

use std::str::FromStr;

use tauri::{Manager, State};
use tauri_plugin_global_shortcut::{Code, Shortcut};

use crate::commands::{SettingsState, lock};
use crate::hotkeys::Hotkeys;
use crate::rt::AppHandle;

/// The Windows Settings page with the Print screen switch.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const SETTINGS_URI: &str = "ms-settings:easeofaccess-keyboard";

/// True when `accelerator` is `PrintScreen` with no modifier, the one
/// combination Windows' screen capture also takes.
pub fn is_bare_print_screen(accelerator: &str) -> bool {
    Shortcut::from_str(accelerator.trim())
        .is_ok_and(|shortcut| shortcut.key == Code::PrintScreen && shortcut.mods.is_empty())
}

/// True when any of `hotkeys` is a bare `PrintScreen`.
pub fn uses_bare_print_screen(hotkeys: &Hotkeys) -> bool {
    hotkeys
        .entries()
        .iter()
        .any(|(_, _, accelerator)| is_bare_print_screen(accelerator))
}

/// A conflict: Windows' setting is on and a Grab-it hotkey is a bare
/// `PrintScreen`.
fn conflicts(windows_setting_on: bool, hotkeys: &Hotkeys) -> bool {
    windows_setting_on && uses_bare_print_screen(hotkeys)
}

fn saved_hotkeys(state: &State<'_, SettingsState>) -> Hotkeys {
    lock(state).get().hotkeys.clone()
}

#[cfg(target_os = "windows")]
mod win {
    use windows::{
        Win32::{
            Foundation::{ERROR_SUCCESS, LPARAM, WPARAM},
            System::Registry::{
                HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD, RegGetValueW, RegSetKeyValueW,
            },
            UI::WindowsAndMessaging::{
                HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
            },
        },
        core::{PCWSTR, w},
    };

    const KEY: PCWSTR = w!("Control Panel\\Keyboard");
    const VALUE: PCWSTR = w!("PrintScreenKeyForSnippingEnabled");

    /// How long each window gets to take the settings change, in ms.
    const BROADCAST_TIMEOUT_MS: u32 = 2000;

    /// True when the value is 1. A missing or unreadable value is off.
    pub fn setting_on() -> bool {
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `data` and `size` outlive the call, and `size` is the
        // byte length of `data`, which RRF_RT_REG_DWORD fills.
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                KEY,
                VALUE,
                RRF_RT_REG_DWORD,
                None,
                Some((&raw mut data).cast()),
                Some(&raw mut size),
            )
        };
        result == ERROR_SUCCESS && data == 1
    }

    /// Sets the value to 0 and tells running apps the settings changed.
    pub fn turn_off() -> Result<(), String> {
        let data: u32 = 0;
        // SAFETY: `data` outlives the call and is the 4 bytes a REG_DWORD
        // holds.
        let result = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                KEY,
                VALUE,
                REG_DWORD.0,
                Some((&raw const data).cast()),
                std::mem::size_of::<u32>() as u32,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(format!(
                "Could not change the Windows setting (error {}).",
                result.0
            ));
        }
        // SAFETY: a broadcast with no pointers in it; SMTO_ABORTIFHUNG and
        // the timeout keep a hung window from holding it up.
        let _ = unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                BROADCAST_TIMEOUT_MS,
                None,
            )
        };
        Ok(())
    }
}

/// Whether Windows' setting is on, read fresh each time.
fn windows_setting_on() -> bool {
    #[cfg(target_os = "windows")]
    {
        win::setting_on()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// True when Windows' Print screen setting is on and a Grab-it hotkey is a
/// bare `PrintScreen`, so the two take turns. Always false off Windows.
#[tauri::command]
#[specta::specta]
pub fn printscreen_conflict(state: State<'_, SettingsState>) -> bool {
    conflicts(windows_setting_on(), &saved_hotkeys(&state))
}

/// Use PrintScreen for Grab-it: turns Windows' setting off, tells running
/// apps, and returns whether the conflict is still there. Does nothing off
/// Windows.
/// Off the main thread, since the broadcast waits on every top-level window.
#[tauri::command(async)]
#[specta::specta]
pub fn printscreen_fix(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    win::turn_off()?;
    Ok(conflicts(
        windows_setting_on(),
        &saved_hotkeys(&app.state::<SettingsState>()),
    ))
}

/// Opens Windows Settings on the page with the Print screen switch. Does
/// nothing off Windows.
#[tauri::command]
#[specta::specta]
pub fn printscreen_open_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(SETTINGS_URI, None::<&str>)
            .map_err(|err| format!("Could not open Windows Settings: {err}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bare_print_screen_matches() {
        assert!(is_bare_print_screen("PrintScreen"));
        assert!(is_bare_print_screen(" PrintScreen "));
        assert!(!is_bare_print_screen("Alt+PrintScreen"));
        assert!(!is_bare_print_screen("Ctrl+Alt+PrintScreen"));
        assert!(!is_bare_print_screen("Shift+PrintScreen"));
        assert!(!is_bare_print_screen("Cmd+Shift+2"));
        assert!(!is_bare_print_screen(""));
        assert!(!is_bare_print_screen("not a key"));
    }

    fn windows_defaults() -> Hotkeys {
        Hotkeys {
            all_in_one: "Ctrl+Alt+PrintScreen".into(),
            region: "PrintScreen".into(),
            window: "Alt+PrintScreen".into(),
            screen: "Ctrl+PrintScreen".into(),
            text: "Shift+PrintScreen".into(),
            colour: "Ctrl+Shift+PrintScreen".into(),
            library: "Alt+Shift+PrintScreen".into(),
            steps: "Ctrl+Alt+Shift+PrintScreen".into(),
            scroll: String::new(),
        }
    }

    #[test]
    fn the_windows_defaults_conflict_while_the_setting_is_on() {
        assert!(conflicts(true, &windows_defaults()));
        assert!(!conflicts(false, &windows_defaults()));
    }

    #[test]
    fn combinations_with_print_screen_do_not_conflict() {
        let hotkeys = Hotkeys {
            region: "Ctrl+Shift+R".into(),
            ..windows_defaults()
        };
        assert!(!conflicts(true, &hotkeys));
    }

    #[test]
    fn a_bare_print_screen_on_any_hotkey_conflicts() {
        let hotkeys = Hotkeys {
            region: "Ctrl+Shift+R".into(),
            scroll: "PrintScreen".into(),
            ..windows_defaults()
        };
        assert!(conflicts(true, &hotkeys));
    }
}
