//! Wayland: captures and hotkeys go through the XDG desktop portals, since
//! Wayland lets no app read the screen or grab keys on its own.

use std::fs;

use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut},
    screenshot::Screenshot,
};
use futures_util::StreamExt;
use image::RgbaImage;

use crate::{actions::Action, capture::CaptureMode, hotkeys::Hotkeys};

/// True when running in a Wayland session.
pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
}

/// Takes a screenshot through the Screenshot portal. `Ok(None)` when the
/// user cancelled the desktop's picker, which is not a failure.
///
/// Region, window and monitor captures are interactive, so the desktop's
/// own picker lets the user choose; a full-screen capture is not. The file
/// the portal writes is read and then removed, since Grab-it saves its own
/// copy in `originals/`.
pub async fn screenshot(mode: CaptureMode) -> Result<Option<RgbaImage>, String> {
    let interactive = !matches!(mode, CaptureMode::Screen);
    let response = Screenshot::request()
        .interactive(interactive)
        .modal(true)
        .send()
        .await
        .and_then(|request| request.response());
    let response = match response {
        Ok(response) => response,
        Err(err) if is_cancelled(&err) => return Ok(None),
        Err(err) => return Err(format!("the screenshot portal failed: {err}")),
    };
    let path = response
        .uri()
        .to_file_path()
        .map_err(|()| format!("the portal returned {}, not a file", response.uri()))?;
    let image = image::open(&path)
        .map_err(|err| format!("could not read the portal's screenshot: {err}"))?
        .to_rgba8();
    if let Err(err) = fs::remove_file(&path) {
        eprintln!(
            "Grab-it: could not remove the portal's copy {}: {err}",
            path.display()
        );
    }
    Ok(Some(image))
}

/// Asks the desktop's colour picker for a pixel's colour. `Ok(None)` when
/// the user cancelled.
pub async fn pick_colour() -> Result<Option<[u8; 3]>, String> {
    let picked = ashpd::desktop::Color::pick()
        .send()
        .await
        .and_then(|request| request.response());
    match picked {
        Ok(colour) => Ok(Some(
            [colour.red(), colour.green(), colour.blue()].map(channel_to_byte),
        )),
        Err(err) if is_cancelled(&err) => Ok(None),
        Err(err) => Err(format!("the colour picker portal failed: {err}")),
    }
}

/// True when a portal request ended because the user backed out of it.
fn is_cancelled(err: &ashpd::Error) -> bool {
    matches!(
        err,
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled)
    )
}

/// A portal colour channel (0.0 to 1.0) as a byte.
pub fn channel_to_byte(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Converts an accelerator like `Alt+PrintScreen` into the XDG shortcut
/// format the GlobalShortcuts portal expects, like `ALT+Print`.
pub fn portal_trigger(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part.trim().to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" | "COMMANDORCONTROL" | "CMDORCTRL" | "COMMANDORCTRL"
            | "CMDORCONTROL" => "CTRL".to_owned(),
            "ALT" | "OPTION" => "ALT".to_owned(),
            "SHIFT" => "SHIFT".to_owned(),
            "SUPER" | "CMD" | "COMMAND" | "META" => "LOGO".to_owned(),
            "PRINTSCREEN" | "PRINT" => "Print".to_owned(),
            _ => part.trim().to_owned(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Binds the hotkeys through the GlobalShortcuts portal and calls
/// `on_activated` with what each press starts. Runs until the session ends.
/// An error means the portal is missing or refused, and only the tray can
/// start captures.
pub async fn run_global_shortcuts<F>(hotkeys: Hotkeys, on_activated: F) -> Result<(), String>
where
    F: Fn(Action) + Send + 'static,
{
    let fail = |err: ashpd::Error| format!("the GlobalShortcuts portal is not available: {err}");
    let portal = GlobalShortcuts::new().await.map_err(fail)?;
    let session = portal.create_session().await.map_err(fail)?;
    let shortcuts: Vec<NewShortcut> = hotkeys
        .entries()
        .iter()
        .filter_map(|(action, _, accelerator)| {
            let trigger = portal_trigger(accelerator);
            Some(
                NewShortcut::new(shortcut_id(*action)?, description(*action))
                    .preferred_trigger(Some(trigger.as_str())),
            )
        })
        .collect();
    portal
        .bind_shortcuts(&session, &shortcuts, None)
        .await
        .and_then(|request| request.response())
        .map_err(fail)?;
    let mut activated = portal.receive_activated().await.map_err(fail)?;
    while let Some(event) = activated.next().await {
        if let Some(action) = action_for_id(event.shortcut_id()) {
            on_activated(action);
        }
    }
    Ok(())
}

/// The id a hotkey is bound under. Monitors have no hotkey.
fn shortcut_id(action: Action) -> Option<&'static str> {
    match action {
        Action::Region => Some("capture-region"),
        Action::Window => Some("capture-window"),
        Action::Screen => Some("capture-screen"),
        Action::Text => Some("capture-text"),
        Action::Colour => Some("pick-colour"),
        Action::Monitor(_) | Action::Repeat | Action::Record => None,
    }
}

/// What the desktop's shortcut settings call each hotkey.
fn description(action: Action) -> &'static str {
    match action {
        Action::Region | Action::Repeat => "Capture a region",
        Action::Window => "Capture a window",
        Action::Screen | Action::Monitor(_) => "Capture the screen",
        Action::Text => "Capture text",
        Action::Colour => "Pick a colour",
        Action::Record => "Record the screen",
    }
}

fn action_for_id(id: &str) -> Option<Action> {
    [
        Action::Region,
        Action::Window,
        Action::Screen,
        Action::Text,
        Action::Colour,
    ]
    .into_iter()
    .find(|action| shortcut_id(*action) == Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_become_portal_triggers() {
        assert_eq!(portal_trigger("PrintScreen"), "Print");
        assert_eq!(portal_trigger("Alt+PrintScreen"), "ALT+Print");
        assert_eq!(portal_trigger("Ctrl+Shift+S"), "CTRL+SHIFT+S");
        assert_eq!(portal_trigger("Super+2"), "LOGO+2");
    }

    #[test]
    fn colour_channels_become_bytes() {
        assert_eq!(channel_to_byte(0.0), 0);
        assert_eq!(channel_to_byte(1.0), 255);
        assert_eq!(channel_to_byte(0.5), 128);
        assert_eq!(channel_to_byte(7.0), 255);
        assert_eq!(channel_to_byte(-1.0), 0);
    }

    #[test]
    fn shortcut_ids_round_trip() {
        for (action, _, _) in Hotkeys::default().entries() {
            let id = shortcut_id(action).expect("every hotkey has an id");
            assert_eq!(action_for_id(id), Some(action));
        }
        assert_eq!(shortcut_id(Action::Monitor(0)), None);
        assert_eq!(action_for_id("other"), None);
    }
}
