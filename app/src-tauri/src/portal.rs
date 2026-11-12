//! Wayland: captures and hotkeys go through the XDG desktop portals, since
//! Wayland lets no app read the screen or grab keys on its own.

use std::fs;

use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut},
    screenshot::Screenshot,
};
use futures_util::StreamExt;
use image::RgbaImage;

use crate::{capture::CaptureMode, hotkeys::Hotkeys};

/// True when running in a Wayland session.
pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
}

/// Takes a screenshot through the Screenshot portal.
///
/// Region, window and monitor captures are interactive, so the desktop's
/// own picker lets the user choose; a full-screen capture is not. The file
/// the portal writes is read and then removed, since Grab-it saves its own
/// copy in `originals/`.
pub async fn screenshot(mode: CaptureMode) -> Result<RgbaImage, String> {
    let interactive = !matches!(mode, CaptureMode::Screen);
    let response = Screenshot::request()
        .interactive(interactive)
        .modal(true)
        .send()
        .await
        .and_then(|request| request.response())
        .map_err(|err| format!("the screenshot portal failed: {err}"))?;
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
    Ok(image)
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
/// `on_activated` with the mode for each press. Runs until the session ends.
/// An error means the portal is missing or refused, and only the tray can
/// start captures.
pub async fn run_global_shortcuts<F>(hotkeys: Hotkeys, on_activated: F) -> Result<(), String>
where
    F: Fn(CaptureMode) + Send + 'static,
{
    let fail = |err: ashpd::Error| format!("the GlobalShortcuts portal is not available: {err}");
    let portal = GlobalShortcuts::new().await.map_err(fail)?;
    let session = portal.create_session().await.map_err(fail)?;
    let triggers = [
        (CaptureMode::Region, "Capture a region", hotkeys.region),
        (CaptureMode::Window, "Capture a window", hotkeys.window),
        (CaptureMode::Screen, "Capture the screen", hotkeys.screen),
    ];
    let shortcuts: Vec<NewShortcut> = triggers
        .iter()
        .map(|(mode, description, accelerator)| {
            let trigger = portal_trigger(accelerator);
            NewShortcut::new(shortcut_id(*mode), *description)
                .preferred_trigger(Some(trigger.as_str()))
        })
        .collect();
    portal
        .bind_shortcuts(&session, &shortcuts, None)
        .await
        .and_then(|request| request.response())
        .map_err(fail)?;
    let mut activated = portal.receive_activated().await.map_err(fail)?;
    while let Some(event) = activated.next().await {
        if let Some(mode) = mode_for_id(event.shortcut_id()) {
            on_activated(mode);
        }
    }
    Ok(())
}

fn shortcut_id(mode: CaptureMode) -> &'static str {
    match mode {
        CaptureMode::Region => "capture-region",
        CaptureMode::Window => "capture-window",
        CaptureMode::Screen | CaptureMode::Monitor => "capture-screen",
    }
}

fn mode_for_id(id: &str) -> Option<CaptureMode> {
    match id {
        "capture-region" => Some(CaptureMode::Region),
        "capture-window" => Some(CaptureMode::Window),
        "capture-screen" => Some(CaptureMode::Screen),
        _ => None,
    }
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
    fn shortcut_ids_round_trip() {
        for mode in [
            CaptureMode::Region,
            CaptureMode::Window,
            CaptureMode::Screen,
        ] {
            assert_eq!(mode_for_id(shortcut_id(mode)), Some(mode));
        }
        assert_eq!(mode_for_id("other"), None);
    }
}
