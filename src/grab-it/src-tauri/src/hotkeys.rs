//! Global hotkeys for the captures, the two capture tools and the library.
//!
//! The defaults are Ctrl+Alt+PrintScreen for Capture & record…, PrintScreen,
//! Alt+PrintScreen and Ctrl+PrintScreen for region, window and screen,
//! Shift+PrintScreen to capture text, Ctrl+Shift+PrintScreen to pick a colour
//! Alt+Shift+PrintScreen to open the library and Ctrl+Alt+Shift+PrintScreen
//! for step capture; on macOS Cmd+Shift+A, Cmd+Shift+2, Cmd+Shift+W,
//! Cmd+Shift+F, Cmd+Shift+1, Cmd+Shift+9, Cmd+Shift+0 and Cmd+Shift+8. On Wayland they are bound through the GlobalShortcuts portal
//! (see `portal.rs`), since apps cannot grab keys there themselves.

use std::{
    collections::BTreeMap,
    str::FromStr,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcut, GlobalShortcutExt, Shortcut, ShortcutState,
};

use crate::rt::{AppHandle, TauriPlugin};
use crate::{
    actions::{self, Action},
    commands::{SettingsState, lock},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    /// Opens the overlay with a toolbar offering every capture mode.
    pub all_in_one: String,
    pub region: String,
    pub window: String,
    pub screen: String,
    /// Reads the text in a region and copies it.
    pub text: String,
    /// Copies the colour under the pointer.
    pub colour: String,
    /// Opens the Grab-it window on the library.
    pub library: String,
    /// Starts a step capture, or stops it and opens its guide. Settings
    /// from before step capture get the default.
    #[serde(default = "default_steps")]
    pub steps: String,
    /// Scrolling capture. Empty by default, and allowed to stay empty, which
    /// registers nothing; settings from before it load as empty.
    #[serde(default)]
    pub scroll: String,
}

/// The step capture hotkey's default.
pub fn default_steps() -> String {
    if cfg!(target_os = "macos") {
        "Cmd+Shift+8".into()
    } else {
        "Ctrl+Alt+Shift+PrintScreen".into()
    }
}

/// What a hotkey does: start a capture or capture tool, or open the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyAction {
    Capture(Action),
    Library,
}

/// Does what a hotkey press asks. Never blocks the caller.
pub fn run(app: &AppHandle, action: HotkeyAction) {
    match action {
        HotkeyAction::Capture(action) => actions::start_from_hotkey(app, action),
        HotkeyAction::Library => {
            // Off the calling thread: creating a window from inside an event
            // handler can deadlock.
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(err) = crate::windows::show_library(&app) {
                    eprintln!("Grab-it: {err}");
                }
            });
        }
    }
}

impl Default for Hotkeys {
    fn default() -> Self {
        if cfg!(target_os = "macos") {
            Self {
                all_in_one: "Cmd+Shift+A".into(),
                region: "Cmd+Shift+2".into(),
                window: "Cmd+Shift+W".into(),
                screen: "Cmd+Shift+F".into(),
                text: "Cmd+Shift+1".into(),
                colour: "Cmd+Shift+9".into(),
                library: "Cmd+Shift+0".into(),
                steps: default_steps(),
                scroll: String::new(),
            }
        } else {
            Self {
                all_in_one: "Ctrl+Alt+PrintScreen".into(),
                region: "PrintScreen".into(),
                window: "Alt+PrintScreen".into(),
                screen: "Ctrl+PrintScreen".into(),
                text: "Shift+PrintScreen".into(),
                colour: "Ctrl+Shift+PrintScreen".into(),
                library: "Alt+Shift+PrintScreen".into(),
                steps: default_steps(),
                scroll: String::new(),
            }
        }
    }
}

impl Hotkeys {
    /// Each hotkey with what it does and its name in Settings.
    pub fn entries(&self) -> [(HotkeyAction, &'static str, &str); 9] {
        use HotkeyAction::{Capture, Library};
        [
            (
                Capture(Action::AllInOne),
                "Capture & record…",
                self.all_in_one.as_str(),
            ),
            (Capture(Action::Region), "Region", self.region.as_str()),
            (Capture(Action::Window), "Window", self.window.as_str()),
            (Capture(Action::Screen), "Screen", self.screen.as_str()),
            (Capture(Action::Text), "Capture text", self.text.as_str()),
            (
                Capture(Action::Colour),
                "Pick a colour",
                self.colour.as_str(),
            ),
            (Library, "Open library", self.library.as_str()),
            (Capture(Action::Steps), "Step capture", self.steps.as_str()),
            (
                Capture(Action::Scroll),
                "Scrolling capture",
                self.scroll.as_str(),
            ),
        ]
    }

    /// Trims every hotkey and checks it parses and is not used twice.
    pub fn validated(&self) -> Result<Hotkeys, String> {
        let trimmed = Hotkeys {
            all_in_one: self.all_in_one.trim().to_owned(),
            region: self.region.trim().to_owned(),
            window: self.window.trim().to_owned(),
            screen: self.screen.trim().to_owned(),
            text: self.text.trim().to_owned(),
            colour: self.colour.trim().to_owned(),
            library: self.library.trim().to_owned(),
            steps: self.steps.trim().to_owned(),
            scroll: self.scroll.trim().to_owned(),
        };
        let mut seen: Vec<(Shortcut, &str)> = Vec::new();
        for (action, name, accelerator) in trimmed.entries() {
            if accelerator.is_empty() && action.may_be_empty() {
                continue;
            }
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

/// The registered hotkeys and what each one starts.
#[derive(Default)]
pub struct HotkeyState {
    bound: Mutex<Vec<(Shortcut, HotkeyAction)>>,
    labels: Mutex<BindingLabels>,
    /// Set while Settings records a hotkey, so pressing a current hotkey
    /// there records it instead of starting a capture.
    paused: AtomicBool,
    /// Set while a scrolling capture runs: Esc is registered to cancel it.
    escape: AtomicBool,
}

impl HotkeyState {
    fn bound(&self) -> std::sync::MutexGuard<'_, Vec<(Shortcut, HotkeyAction)>> {
        self.bound.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Platform-formatted shortcuts accepted by the system, keyed like Hotkeys.
pub type BindingLabels = BTreeMap<String, String>;

impl HotkeyAction {
    /// Hotkeys that have none by default and register nothing when empty.
    pub fn may_be_empty(self) -> bool {
        self == Self::Capture(Action::Scroll)
    }

    fn binding_key(self) -> Option<&'static str> {
        match self {
            Self::Capture(Action::AllInOne) => Some("allInOne"),
            Self::Capture(Action::Region) => Some("region"),
            Self::Capture(Action::Window) => Some("window"),
            Self::Capture(Action::Screen) => Some("screen"),
            Self::Capture(Action::Text) => Some("text"),
            Self::Capture(Action::Colour) => Some("colour"),
            Self::Capture(Action::Steps) => Some("steps"),
            Self::Capture(Action::Scroll) => Some("scroll"),
            Self::Library => Some("library"),
            Self::Capture(_) => None,
        }
    }
}

fn native_label(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(str::trim)
        .map(|key| {
            if cfg!(target_os = "macos") {
                match key.to_ascii_lowercase().as_str() {
                    "cmd" | "command" | "cmdorctrl" | "super" | "commandorcontrol" => "⌘",
                    "shift" => "⇧",
                    "alt" | "option" => "⌥",
                    "ctrl" | "control" => "⌃",
                    _ => key,
                }
            } else if key.eq_ignore_ascii_case("CmdOrCtrl")
                || key.eq_ignore_ascii_case("CommandOrControl")
            {
                "Ctrl"
            } else {
                key
            }
        })
        .collect::<Vec<_>>()
        .join(if cfg!(target_os = "macos") { "" } else { "+" })
}

#[tauri::command]
#[specta::specta]
pub fn effective_hotkeys(state: State<'_, HotkeyState>) -> BindingLabels {
    state
        .labels
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn binding_labels(bindings: Vec<(HotkeyAction, String)>) -> BindingLabels {
    bindings
        .into_iter()
        .filter_map(|(action, label)| {
            if label.trim().is_empty() {
                return None;
            }
            Some((action.binding_key()?.to_owned(), label))
        })
        .collect()
}

fn publish_labels(app: &AppHandle, bindings: Vec<(HotkeyAction, String)>) {
    let labels = binding_labels(bindings);
    if let Some(state) = app.try_state::<HotkeyState>() {
        *state.labels.lock().unwrap_or_else(|p| p.into_inner()) = labels.clone();
    }
    crate::tray::set_chooser_binding(app, labels.get("allInOne").map(String::as_str));
    let _ = app.emit("effective-hotkeys-changed", &labels);
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
    publish_labels(app, Vec::new());
    restore_escape(app);
}

/// Esc, which cancels a running scrolling capture.
fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// The global-shortcut plugin, when it is running; the IPC tests have none.
fn shortcuts(app: &AppHandle) -> Option<tauri::State<'_, GlobalShortcut<crate::rt::Rt>>> {
    app.try_state::<GlobalShortcut<crate::rt::Rt>>()
}

/// Runs `task` on the main thread, where [`apply`] and [`pause`] run and
/// the plugin registers shortcuts, so holding, releasing and restoring Esc
/// never interleave: each reads the flag and changes the registration in
/// one step.
fn on_main(app: &AppHandle, task: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    if let Err(err) = app.run_on_main_thread(move || task(&handle)) {
        eprintln!("Grab-it: could not change the Esc shortcut: {err}");
    }
}

/// Marks Esc as held by a running scrolling capture.
fn hold(state: &HotkeyState) {
    state.escape.store(true, Ordering::SeqCst);
}

/// Marks Esc as released; true when a capture held it.
fn release(state: &HotkeyState) -> bool {
    state.escape.swap(false, Ordering::SeqCst)
}

/// Whether a running scrolling capture holds Esc.
fn held(state: &HotkeyState) -> bool {
    state.escape.load(Ordering::SeqCst)
}

/// Registers Esc to cancel the scrolling capture that is starting. Its bar
/// never takes the focus, so the key would otherwise go to the page being
/// captured. A failure is logged: the bar's Cancel still works.
pub fn hold_escape(app: &AppHandle) {
    on_main(app, |app| {
        let Some(state) = app.try_state::<HotkeyState>() else {
            return;
        };
        hold(&state);
        register_escape(app);
    });
}

/// Releases Esc once the scrolling capture has ended, however it ended.
/// Queued on the main thread after any earlier hold, so a release never
/// undoes the next capture's Esc.
pub fn release_escape(app: &AppHandle) {
    on_main(app, |app| {
        let Some(state) = app.try_state::<HotkeyState>() else {
            return;
        };
        if !release(&state) {
            return;
        }
        if let Some(shortcuts) = shortcuts(app)
            && shortcuts.is_registered(escape())
            && let Err(err) = shortcuts.unregister(escape())
        {
            eprintln!("Grab-it: could not release Esc after the scrolling capture: {err}");
        }
    });
}

/// Registers Esc again after every hotkey was unregistered, while a
/// scrolling capture still runs. Queued on the main thread, so it sees a
/// release that happened while the hotkeys were being replaced.
fn restore_escape(app: &AppHandle) {
    on_main(app, |app| {
        if app
            .try_state::<HotkeyState>()
            .is_some_and(|state| held(&state))
        {
            register_escape(app);
        }
    });
}

fn register_escape(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return;
    }
    let Some(shortcuts) = shortcuts(app) else {
        return;
    };
    if shortcuts.is_registered(escape()) {
        return;
    }
    if let Err(err) = shortcuts.register(escape()) {
        eprintln!("Grab-it: could not register Esc to cancel the scrolling capture: {err}");
    }
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
#[specta::specta]
pub fn pause_hotkeys(app: AppHandle) {
    pause(&app);
}

#[tauri::command]
#[specta::specta]
pub fn resume_hotkeys(app: AppHandle) {
    resume(&app);
}

/// The global-shortcut plugin, dispatching presses to captures.
pub fn plugin() -> TauriPlugin {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            // Esc is only registered while a scrolling capture runs.
            if *shortcut == escape() {
                crate::scroll::cancel_running(app);
                return;
            }
            if is_paused(app) {
                return;
            }
            let action = app.try_state::<HotkeyState>().and_then(|state| {
                state
                    .bound()
                    .iter()
                    .find(|(s, _)| s == shortcut)
                    .map(|(_, action)| *action)
            });
            if let Some(action) = action {
                run(app, action);
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
    let mut labels = Vec::new();
    for (action, name, accelerator) in hotkeys.entries() {
        if accelerator.trim().is_empty() && action.may_be_empty() {
            continue;
        }
        let shortcut = match Shortcut::from_str(accelerator) {
            Ok(shortcut) => shortcut,
            Err(err) => {
                problems.push(format!("{name} hotkey `{accelerator}` is not valid: {err}"));
                continue;
            }
        };
        match shortcuts.register(shortcut) {
            Ok(()) => {
                bound.push((shortcut, action));
                labels.push((action, native_label(accelerator)));
            }
            Err(err) => problems.push(format!(
                "{name} hotkey `{accelerator}` could not be registered: {err}"
            )),
        }
    }
    if let Some(state) = app.try_state::<HotkeyState>() {
        *state.bound() = bound;
    }
    publish_labels(app, labels);
    restore_escape(app);
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
            let on_press = |action: HotkeyAction| {
                if !is_paused(&handle) {
                    run(&handle, action);
                }
            };
            let on_bound = |bindings| publish_labels(&handle, bindings);
            if let Err(err) = crate::portal::run_global_shortcuts(hotkeys, on_press, on_bound).await
            {
                eprintln!("Grab-it: {err}. Use the tray menu to capture.");
            }
            publish_labels(&handle, Vec::new());
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
    fn esc_is_held_only_while_a_scrolling_capture_runs() {
        let state = HotkeyState::default();
        assert!(!held(&state));
        // Nothing to release before a capture holds it.
        assert!(!release(&state));
        hold(&state);
        assert!(held(&state));
        assert!(release(&state));
        assert!(!held(&state));
        // A second release, from a session that already ended, does nothing.
        assert!(!release(&state));
    }

    #[test]
    fn esc_is_its_own_bare_key() {
        assert_eq!(escape(), Shortcut::new(None, Code::Escape));
        assert_ne!(escape(), Shortcut::from_str("Shift+Escape").unwrap());
    }

    #[test]
    fn defaults_are_valid_and_distinct() {
        let defaults = Hotkeys::default();
        assert_eq!(defaults.validated(), Ok(defaults.clone()));
        if cfg!(target_os = "macos") {
            assert_eq!(defaults.region, "Cmd+Shift+2");
            assert_eq!(defaults.all_in_one, "Cmd+Shift+A");
            assert_eq!(defaults.steps, "Cmd+Shift+8");
        } else {
            assert_eq!(defaults.all_in_one, "Ctrl+Alt+PrintScreen");
            assert_eq!(defaults.region, "PrintScreen");
            assert_eq!(defaults.window, "Alt+PrintScreen");
            assert_eq!(defaults.screen, "Ctrl+PrintScreen");
            assert_eq!(defaults.text, "Shift+PrintScreen");
            assert_eq!(defaults.colour, "Ctrl+Shift+PrintScreen");
            assert_eq!(defaults.library, "Alt+Shift+PrintScreen");
            assert_eq!(defaults.steps, "Ctrl+Alt+Shift+PrintScreen");
        }
        assert!(defaults.entries().iter().any(|(action, name, _)| *action
            == HotkeyAction::Capture(Action::Steps)
            && *name == "Step capture"));
    }

    #[test]
    fn hints_only_include_live_bindings_and_preserve_desktop_labels() {
        let bindings = binding_labels(vec![
            (
                HotkeyAction::Capture(Action::AllInOne),
                "Desktop shortcut A".into(),
            ),
            (HotkeyAction::Capture(Action::Screen), String::new()),
        ]);
        assert_eq!(
            bindings,
            BTreeMap::from([("allInOne".into(), "Desktop shortcut A".into())])
        );
        let expected = if cfg!(target_os = "macos") {
            "⌘⇧2"
        } else {
            "Ctrl+Shift+2"
        };
        assert_eq!(native_label("CmdOrCtrl+Shift+2"), expected);
    }

    #[test]
    fn scrolling_capture_has_no_hotkey_by_default_and_may_stay_empty() {
        let defaults = Hotkeys::default();
        assert_eq!(defaults.scroll, "");
        assert_eq!(defaults.validated().unwrap().scroll, "");
        let blank = Hotkeys {
            scroll: "  ".into(),
            ..Hotkeys::default()
        };
        assert_eq!(blank.validated().unwrap().scroll, "");
        // Settings from before scrolling capture load with it empty.
        let mut old = serde_json::to_value(Hotkeys::default()).unwrap();
        old.as_object_mut().unwrap().remove("scroll");
        let loaded: Hotkeys = serde_json::from_value(old).unwrap();
        assert_eq!(loaded.scroll, "");
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
            ..Hotkeys::default()
        };
        assert_eq!(
            duplicate.validated(),
            Err("Window and Region use the same hotkey.".into())
        );

        let tool_clash = Hotkeys {
            colour: Hotkeys::default().text,
            ..Hotkeys::default()
        };
        assert_eq!(
            tool_clash.validated(),
            Err("Pick a colour and Capture text use the same hotkey.".into())
        );

        let all_in_one_clash = Hotkeys {
            all_in_one: Hotkeys::default().region,
            ..Hotkeys::default()
        };
        assert_eq!(
            all_in_one_clash.validated(),
            Err("Region and Capture & record… use the same hotkey.".into())
        );

        let scroll_clash = Hotkeys {
            scroll: Hotkeys::default().region,
            ..Hotkeys::default()
        };
        assert_eq!(
            scroll_clash.validated(),
            Err("Scrolling capture and Region use the same hotkey.".into())
        );

        let library_clash = Hotkeys {
            library: Hotkeys::default().region,
            ..Hotkeys::default()
        };
        assert_eq!(
            library_clash.validated(),
            Err("Open library and Region use the same hotkey.".into())
        );
    }
}
