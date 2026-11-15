//! Clicks and key presses while a recording with Show clicks or Show
//! keystrokes runs, for the overlays drawn into its frames
//! (frame_overlays.rs).
//!
//! rdev's `listen` hooks global input: an event tap on macOS, low-level
//! hooks on Windows and XRecord on X11. Wayland gives no such access, and
//! recording is not offered there. `listen` never returns once it runs and
//! can run only once in a process, so its thread is started by the first
//! recording that wants it and kept; each recording connects to it with a
//! [`Capture`], and between recordings it hands events to no one.
//!
//! Key labels come from Grab-it's own table ([`KeyStyle::label`]), not from
//! rdev's layout-dependent names: `⌘ ⇧ 4` on macOS, `Ctrl Shift 4` elsewhere.
//! On macOS no key is kept while secure input is on, as it is while a
//! password field has the focus. Elsewhere that cannot be told.

use std::{
    sync::{Mutex, MutexGuard, mpsc},
    time::{Duration, Instant},
};

use rdev::{Button, EventType, Key};

/// How long starting the listener waits to see whether it failed at once,
/// as it does without permission or without the X RECORD extension.
const START_TIMEOUT: Duration = Duration::from_millis(300);

/// One click or key press.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputEvent {
    pub at: Instant,
    pub kind: InputKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputKind {
    /// A mouse button went down, wherever the pointer is.
    Click,
    /// A key went down: the modifiers held and the key, as shown.
    Keys(String),
}

/// How keys are written: macOS symbols, or words elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStyle {
    Mac,
    /// Words, with the name of the logo key: `Win` or `Super`.
    Words {
        logo: &'static str,
    },
}

/// The modifier keys, in the order they are shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Modifier {
    Meta,
    Control,
    Alt,
    Shift,
}

/// The order modifiers are written in. macOS puts ⌘ first, as in `⌘ ⇧ 4`;
/// elsewhere the logo key comes last, as in `Ctrl Shift Win`.
const MAC_ORDER: [Modifier; 4] = [
    Modifier::Meta,
    Modifier::Control,
    Modifier::Alt,
    Modifier::Shift,
];
const WORDS_ORDER: [Modifier; 4] = [
    Modifier::Control,
    Modifier::Alt,
    Modifier::Shift,
    Modifier::Meta,
];

fn modifier(key: Key) -> Option<Modifier> {
    match key {
        Key::MetaLeft | Key::MetaRight => Some(Modifier::Meta),
        Key::ControlLeft | Key::ControlRight => Some(Modifier::Control),
        Key::Alt | Key::AltGr => Some(Modifier::Alt),
        Key::ShiftLeft | Key::ShiftRight => Some(Modifier::Shift),
        _ => None,
    }
}

impl KeyStyle {
    /// This platform's style.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "windows") {
            Self::Words { logo: "Win" }
        } else {
            Self::Words { logo: "Super" }
        }
    }

    fn modifier_name(self, modifier: Modifier) -> &'static str {
        match (self, modifier) {
            (Self::Mac, Modifier::Meta) => "⌘",
            (Self::Mac, Modifier::Control) => "⌃",
            (Self::Mac, Modifier::Alt) => "⌥",
            (Self::Mac, Modifier::Shift) => "⇧",
            (Self::Words { logo }, Modifier::Meta) => logo,
            (Self::Words { .. }, Modifier::Control) => "Ctrl",
            (Self::Words { .. }, Modifier::Alt) => "Alt",
            (Self::Words { .. }, Modifier::Shift) => "Shift",
        }
    }

    /// How `key` is written, or None for a key that is not shown: a
    /// modifier on its own, Fn, the media keys, or one rdev cannot name.
    pub fn key_name(self, key: Key) -> Option<&'static str> {
        let mac = self == Self::Mac;
        let pick = |symbol: &'static str, word: &'static str| if mac { symbol } else { word };
        Some(match key {
            Key::KeyA => "A",
            Key::KeyB => "B",
            Key::KeyC => "C",
            Key::KeyD => "D",
            Key::KeyE => "E",
            Key::KeyF => "F",
            Key::KeyG => "G",
            Key::KeyH => "H",
            Key::KeyI => "I",
            Key::KeyJ => "J",
            Key::KeyK => "K",
            Key::KeyL => "L",
            Key::KeyM => "M",
            Key::KeyN => "N",
            Key::KeyO => "O",
            Key::KeyP => "P",
            Key::KeyQ => "Q",
            Key::KeyR => "R",
            Key::KeyS => "S",
            Key::KeyT => "T",
            Key::KeyU => "U",
            Key::KeyV => "V",
            Key::KeyW => "W",
            Key::KeyX => "X",
            Key::KeyY => "Y",
            Key::KeyZ => "Z",
            Key::Num0 | Key::Kp0 => "0",
            Key::Num1 | Key::Kp1 => "1",
            Key::Num2 | Key::Kp2 => "2",
            Key::Num3 | Key::Kp3 => "3",
            Key::Num4 | Key::Kp4 => "4",
            Key::Num5 | Key::Kp5 => "5",
            Key::Num6 | Key::Kp6 => "6",
            Key::Num7 | Key::Kp7 => "7",
            Key::Num8 | Key::Kp8 => "8",
            Key::Num9 | Key::Kp9 => "9",
            Key::BackQuote => "`",
            Key::Minus | Key::KpMinus => "-",
            Key::Equal => "=",
            Key::KpPlus => "+",
            Key::KpMultiply => "*",
            Key::KpDivide => "/",
            Key::LeftBracket => "[",
            Key::RightBracket => "]",
            Key::SemiColon => ";",
            Key::Quote => "'",
            Key::BackSlash | Key::IntlBackslash => "\\",
            Key::Comma => ",",
            Key::Dot => ".",
            Key::Slash => "/",
            Key::F1 => "F1",
            Key::F2 => "F2",
            Key::F3 => "F3",
            Key::F4 => "F4",
            Key::F5 => "F5",
            Key::F6 => "F6",
            Key::F7 => "F7",
            Key::F8 => "F8",
            Key::F9 => "F9",
            Key::F10 => "F10",
            Key::F11 => "F11",
            Key::F12 => "F12",
            Key::F13 => "F13",
            Key::F14 => "F14",
            Key::F15 => "F15",
            Key::F16 => "F16",
            Key::F17 => "F17",
            Key::F18 => "F18",
            Key::F19 => "F19",
            Key::F20 => "F20",
            Key::F21 => "F21",
            Key::F22 => "F22",
            Key::F23 => "F23",
            Key::F24 => "F24",
            Key::Return | Key::KpReturn => pick("↩", "Enter"),
            Key::Backspace => pick("⌫", "Backspace"),
            Key::Delete | Key::KpDelete => pick("⌦", "Delete"),
            Key::Tab => pick("⇥", "Tab"),
            Key::Escape => pick("esc", "Esc"),
            Key::Space => "Space",
            Key::CapsLock => pick("⇪", "Caps Lock"),
            Key::LeftArrow => pick("←", "Left"),
            Key::RightArrow => pick("→", "Right"),
            Key::UpArrow => pick("↑", "Up"),
            Key::DownArrow => pick("↓", "Down"),
            Key::Home => pick("↖", "Home"),
            Key::End => pick("↘", "End"),
            Key::PageUp => pick("⇞", "Page Up"),
            Key::PageDown => pick("⇟", "Page Down"),
            Key::Insert => "Insert",
            Key::PrintScreen => "Print Screen",
            Key::ScrollLock => "Scroll Lock",
            Key::Pause => "Pause",
            Key::NumLock => "Num Lock",
            _ => return None,
        })
    }

    /// The label for `key` pressed while `held` modifiers are down, such
    /// as `⌘ ⇧ 4` or `Ctrl Shift 4`. None for a key that is not shown.
    fn label(self, held: &Held, key: Key) -> Option<String> {
        let name = self.key_name(key)?;
        let order = match self {
            Self::Mac => MAC_ORDER,
            Self::Words { .. } => WORDS_ORDER,
        };
        let mut parts: Vec<&str> = order
            .iter()
            .filter(|modifier| held.is_down(**modifier))
            .map(|modifier| self.modifier_name(*modifier))
            .collect();
        parts.push(name);
        Some(parts.join(" "))
    }
}

/// The modifier keys down, counting left and right apart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Held(Vec<Key>);

impl Held {
    fn press(&mut self, key: Key) {
        if !self.0.contains(&key) {
            self.0.push(key);
        }
    }

    fn release(&mut self, key: Key) {
        self.0.retain(|held| *held != key);
    }

    fn is_down(&self, wanted: Modifier) -> bool {
        self.0.iter().any(|key| modifier(*key) == Some(wanted))
    }
}

/// Turns rdev's events into clicks and labelled key presses.
#[derive(Debug, Clone)]
pub struct Collector {
    clicks: bool,
    keys: bool,
    style: KeyStyle,
    held: Held,
    events: Vec<InputEvent>,
}

impl Collector {
    pub fn new(clicks: bool, keys: bool, style: KeyStyle) -> Self {
        Self {
            clicks,
            keys,
            style,
            held: Held::default(),
            events: Vec::new(),
        }
    }

    /// Takes in one event received at `at`. `secure_input` says whether
    /// the system is keeping key presses private, as it does while a
    /// password is typed: then no key is kept, though modifiers are still
    /// followed so the next label is right.
    pub fn add(&mut self, event: &EventType, at: Instant, secure_input: bool) {
        match *event {
            EventType::ButtonPress(Button::Left | Button::Right | Button::Middle)
                if self.clicks =>
            {
                self.events.push(InputEvent {
                    at,
                    kind: InputKind::Click,
                });
            }
            EventType::KeyPress(key) if modifier(key).is_some() => self.held.press(key),
            EventType::KeyRelease(key) if modifier(key).is_some() => self.held.release(key),
            EventType::KeyPress(key) if self.keys && !secure_input => {
                if let Some(label) = self.style.label(&self.held, key) {
                    self.events.push(InputEvent {
                        at,
                        kind: InputKind::Keys(label),
                    });
                }
            }
            _ => {}
        }
    }

    /// The events collected since the last call.
    pub fn take(&mut self) -> Vec<InputEvent> {
        std::mem::take(&mut self.events)
    }
}

/// Whether macOS is keeping key presses private: secure input is on while
/// a password field has the focus.
#[cfg(target_os = "macos")]
pub fn secure_input() -> bool {
    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn IsSecureEventInputEnabled() -> u8;
    }
    // SAFETY: takes nothing and only reports a flag.
    unsafe { IsSecureEventInputEnabled() != 0 }
}

/// Other platforms cannot tell when a password is being typed.
#[cfg(not(target_os = "macos"))]
pub fn secure_input() -> bool {
    false
}

/// Where the listener's events go: the recording connected to it, if any.
static SINK: Mutex<Option<Collector>> = Mutex::new(None);
/// Whether rdev's listener thread is running.
static LISTENING: Mutex<bool> = Mutex::new(false);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A recording's connection to the listener. Dropping it disconnects.
pub struct Capture(());

impl Capture {
    /// Connects to the listener, starting it the first time, and collects
    /// clicks when `clicks` and key presses when `keys`.
    pub fn start(clicks: bool, keys: bool) -> Result<Self, String> {
        listen()?;
        *lock(&SINK) = Some(Collector::new(clicks, keys, KeyStyle::current()));
        Ok(Self(()))
    }

    /// The clicks and key presses since the last call.
    pub fn take(&self) -> Vec<InputEvent> {
        lock(&SINK)
            .as_mut()
            .map(Collector::take)
            .unwrap_or_default()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        *lock(&SINK) = None;
    }
}

/// Starts rdev's listener on a thread of its own, unless it runs already.
fn listen() -> Result<(), String> {
    let mut listening = lock(&LISTENING);
    if *listening {
        return Ok(());
    }
    // macOS: key names are looked up on the main thread, not the tap's.
    #[cfg(target_os = "macos")]
    rdev::set_is_main_thread(false);
    let (failed, failure) = mpsc::channel();
    std::thread::Builder::new()
        .name("grab-it-input".into())
        .spawn(move || {
            let result = rdev::listen(|event| {
                let at = Instant::now();
                let mut sink = lock(&SINK);
                if let Some(collector) = sink.as_mut() {
                    // Only asked for a key press, which is all it guards.
                    let secure =
                        matches!(event.event_type, EventType::KeyPress(_)) && secure_input();
                    collector.add(&event.event_type, at, secure);
                }
            });
            // It stopped (or never started): the next recording tries again.
            *lock(&LISTENING) = false;
            let why = match result {
                Ok(()) => "the input listener stopped".to_owned(),
                Err(err) => format!("could not watch the mouse and keyboard: {err:?}"),
            };
            let _ = failed.send(why);
        })
        .map_err(|err| format!("could not start the input listener: {err}"))?;
    *listening = true;
    drop(listening);
    // A listener that cannot start fails at once; one that runs blocks.
    match failure.recv_timeout(START_TIMEOUT) {
        Ok(why) => Err(why),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: KeyStyle = KeyStyle::Words { logo: "Super" };

    fn labels(collector: &mut Collector) -> Vec<String> {
        collector
            .take()
            .into_iter()
            .filter_map(|event| match event.kind {
                InputKind::Keys(label) => Some(label),
                InputKind::Click => None,
            })
            .collect()
    }

    fn press(collector: &mut Collector, keys: &[Key], secure: bool) {
        let at = Instant::now();
        for key in keys {
            collector.add(&EventType::KeyPress(*key), at, secure);
        }
        for key in keys.iter().rev() {
            collector.add(&EventType::KeyRelease(*key), at, secure);
        }
    }

    #[test]
    fn shortcuts_are_written_as_symbols_on_macos_and_words_elsewhere() {
        let shortcut = [Key::MetaLeft, Key::ShiftLeft, Key::Num4];
        let mut mac = Collector::new(false, true, KeyStyle::Mac);
        press(&mut mac, &shortcut, false);
        assert_eq!(labels(&mut mac), ["⌘ ⇧ 4"]);

        let mut linux = Collector::new(false, true, WORDS);
        press(
            &mut linux,
            &[Key::ControlLeft, Key::ShiftRight, Key::Num4],
            false,
        );
        press(&mut linux, &shortcut, false);
        assert_eq!(labels(&mut linux), ["Ctrl Shift 4", "Shift Super 4"]);

        let mut windows = Collector::new(false, true, KeyStyle::Words { logo: "Win" });
        press(
            &mut windows,
            &[Key::MetaRight, Key::ShiftLeft, Key::KeyS],
            false,
        );
        assert_eq!(labels(&mut windows), ["Shift Win S"]);
    }

    #[test]
    fn every_modifier_has_its_place() {
        let all = [
            Key::ShiftLeft,
            Key::Alt,
            Key::ControlRight,
            Key::MetaLeft,
            Key::Return,
        ];
        let mut mac = Collector::new(false, true, KeyStyle::Mac);
        press(&mut mac, &all, false);
        assert_eq!(labels(&mut mac), ["⌘ ⌃ ⌥ ⇧ ↩"]);
        let mut words = Collector::new(false, true, WORDS);
        press(&mut words, &all, false);
        assert_eq!(labels(&mut words), ["Ctrl Alt Shift Super Enter"]);
    }

    #[test]
    fn special_keys_have_names_and_media_keys_none() {
        assert_eq!(KeyStyle::Mac.key_name(Key::Backspace), Some("⌫"));
        assert_eq!(WORDS.key_name(Key::Backspace), Some("Backspace"));
        assert_eq!(KeyStyle::Mac.key_name(Key::Escape), Some("esc"));
        assert_eq!(WORDS.key_name(Key::PageDown), Some("Page Down"));
        assert_eq!(KeyStyle::Mac.key_name(Key::LeftArrow), Some("←"));
        assert_eq!(WORDS.key_name(Key::LeftArrow), Some("Left"));
        assert_eq!(WORDS.key_name(Key::Kp7), Some("7"));
        assert_eq!(WORDS.key_name(Key::F13), Some("F13"));
        assert_eq!(WORDS.key_name(Key::VolumeUp), None);
        assert_eq!(WORDS.key_name(Key::Unknown(999)), None);
        assert_eq!(WORDS.key_name(Key::ShiftLeft), None);
    }

    #[test]
    fn a_modifier_alone_shows_nothing_and_released_ones_drop_out() {
        let mut collector = Collector::new(false, true, WORDS);
        press(&mut collector, &[Key::ControlLeft], false);
        assert!(labels(&mut collector).is_empty());
        // Ctrl+C, then C on its own: Ctrl was released in between.
        press(&mut collector, &[Key::ControlLeft, Key::KeyC], false);
        press(&mut collector, &[Key::KeyC], false);
        assert_eq!(labels(&mut collector), ["Ctrl C", "C"]);
        // Left and right Shift are held apart: letting one go keeps Shift.
        let at = Instant::now();
        collector.add(&EventType::KeyPress(Key::ShiftLeft), at, false);
        collector.add(&EventType::KeyPress(Key::ShiftRight), at, false);
        collector.add(&EventType::KeyRelease(Key::ShiftLeft), at, false);
        collector.add(&EventType::KeyPress(Key::KeyA), at, false);
        assert_eq!(labels(&mut collector), ["Shift A"]);
    }

    #[test]
    fn keys_typed_under_secure_input_are_left_out() {
        let mut collector = Collector::new(true, true, KeyStyle::Mac);
        press(&mut collector, &[Key::KeyH, Key::KeyI], false);
        // A password: secure input is on, so nothing of it is kept, though
        // the Shift held across it is still followed.
        let at = Instant::now();
        collector.add(&EventType::KeyPress(Key::ShiftLeft), at, true);
        collector.add(&EventType::KeyPress(Key::KeyP), at, true);
        collector.add(&EventType::KeyRelease(Key::KeyP), at, true);
        // Clicks are not keystrokes: they are still shown.
        collector.add(&EventType::ButtonPress(Button::Left), at, true);
        collector.add(&EventType::KeyPress(Key::KeyW), at, false);
        let events = collector.take();
        let kinds: Vec<_> = events.into_iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            [
                InputKind::Keys("H".into()),
                InputKind::Keys("I".into()),
                InputKind::Click,
                InputKind::Keys("⇧ W".into()),
            ]
        );
    }

    #[test]
    fn only_what_was_asked_for_is_collected() {
        let at = Instant::now();
        let mut clicks = Collector::new(true, false, WORDS);
        clicks.add(&EventType::KeyPress(Key::KeyA), at, false);
        clicks.add(&EventType::ButtonPress(Button::Right), at, false);
        // Releases, side buttons, moves and the wheel are not clicks.
        clicks.add(&EventType::ButtonRelease(Button::Right), at, false);
        clicks.add(&EventType::ButtonPress(Button::Unknown(8)), at, false);
        clicks.add(&EventType::MouseMove { x: 1.0, y: 2.0 }, at, false);
        clicks.add(
            &EventType::Wheel {
                delta_x: 0,
                delta_y: 1,
            },
            at,
            false,
        );
        assert_eq!(
            clicks.take(),
            [InputEvent {
                at,
                kind: InputKind::Click
            }]
        );
        assert!(clicks.take().is_empty());

        let mut keys = Collector::new(false, true, WORDS);
        keys.add(&EventType::ButtonPress(Button::Left), at, false);
        keys.add(&EventType::KeyPress(Key::KeyA), at, false);
        assert_eq!(labels(&mut keys), ["A"]);
    }

    #[test]
    fn this_platform_has_a_style() {
        let style = KeyStyle::current();
        if cfg!(target_os = "macos") {
            assert_eq!(style, KeyStyle::Mac);
        } else {
            assert!(matches!(style, KeyStyle::Words { .. }));
            // Elsewhere a password cannot be told from other typing.
            assert!(!secure_input());
        }
    }
}
