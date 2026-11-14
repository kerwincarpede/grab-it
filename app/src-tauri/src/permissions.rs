//! macOS Screen Recording and Microphone permissions. Without the first,
//! captures come back with only the desktop wallpaper, so Grab-it checks
//! first and offers to open System Settings. The second is asked for before
//! a recording with Audio set to Microphone; its prompt shows Info.plist's
//! `NSMicrophoneUsageDescription`. Other platforms need no permission.

use tauri::AppHandle;

/// Returns true when capturing may go ahead. On macOS, without permission,
/// asks the system to register Grab-it and offers to open System Settings.
#[cfg(target_os = "macos")]
pub fn ensure_screen_capture(app: &AppHandle) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    const SETTINGS_URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

    // SAFETY: both functions take no arguments and only query or request
    // the permission; they are safe to call from any thread.
    if unsafe { CGPreflightScreenCaptureAccess() } {
        return true;
    }
    // Adds Grab-it to the Screen Recording list, so the user can tick it.
    // SAFETY: as above.
    let _ = unsafe { CGRequestScreenCaptureAccess() };

    app.dialog()
        .message(
            "Grab-it needs the Screen Recording permission to capture your screen.\n\n\
             Turn on Grab-it under Privacy & Security → Screen Recording, then try again. \
             macOS may ask you to restart Grab-it.",
        )
        .title("Allow screen recording")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open System Settings".into(),
            "Not Now".into(),
        ))
        .show(|open| {
            if open && let Err(err) = std::process::Command::new("open").arg(SETTINGS_URL).spawn() {
                eprintln!("Grab-it: could not open System Settings: {err}");
            }
        });
    false
}

/// Returns true when capturing may go ahead. Only macOS asks for permission.
#[cfg(not(target_os = "macos"))]
pub fn ensure_screen_capture(_app: &AppHandle) -> bool {
    true
}

/// How long the system's microphone prompt is waited for.
#[cfg(target_os = "macos")]
const MICROPHONE_PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Returns true when the microphone may be recorded. On macOS the first
/// time, asks the user and waits for the answer, so call this off the main
/// thread. Once refused, offers to open System Settings instead.
#[cfg(target_os = "macos")]
pub fn ensure_microphone(app: &AppHandle) -> bool {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    const SETTINGS_URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

    // SAFETY: a constant AVFoundation exports.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return false;
    };
    // SAFETY: AVMediaTypeAudio is one of the two media types it takes.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    if status == AVAuthorizationStatus::Authorized {
        return true;
    }
    if status == AVAuthorizationStatus::NotDetermined {
        let (sender, answer) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = sender.send(granted.as_bool());
        });
        // SAFETY: as above; the handler may be called on any thread, and
        // only sends on a channel.
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
        return answer
            .recv_timeout(MICROPHONE_PROMPT_TIMEOUT)
            .unwrap_or(false);
    }

    app.dialog()
        .message(
            "Grab-it needs the Microphone permission to record sound with your screen.\n\n\
             Turn on Grab-it under Privacy & Security → Microphone, then record again. \
             Until then, recordings are saved without sound.",
        )
        .title("Allow the microphone")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open System Settings".into(),
            "Not Now".into(),
        ))
        .show(|open| {
            if open && let Err(err) = std::process::Command::new("open").arg(SETTINGS_URL).spawn() {
                eprintln!("Grab-it: could not open System Settings: {err}");
            }
        });
    false
}

/// Returns true when the microphone may be recorded. Only macOS asks.
#[cfg(not(target_os = "macos"))]
pub fn ensure_microphone(_app: &AppHandle) -> bool {
    true
}
