//! macOS Screen Recording permission. Without it, captures come back with
//! only the desktop wallpaper, so Grab-it checks first and offers to open
//! System Settings. Other platforms need no permission.

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
