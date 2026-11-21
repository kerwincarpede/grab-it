//! macOS Screen Recording, Microphone and Input Monitoring permissions.
//! Without the first, captures come back with only the desktop wallpaper,
//! so Grab-it checks first and offers to open System Settings. The second
//! is asked for before a recording with Audio set to Microphone; its prompt
//! shows Info.plist's `NSMicrophoneUsageDescription`. The third is asked
//! for before a recording with Show clicks or Show keystrokes, whose input
//! hooks (input.rs) see nothing without it. Other platforms need no
//! permission.
//!
//! The Welcome window's Permissions page asks for all of them, and the
//! camera, at the first launch (the `permission_*` commands below); the
//! `ensure_*` checks stay as the fallback for anything not granted then.

use std::sync::atomic::AtomicBool;

use serde::Serialize;
use tauri::Manager;

use crate::rt::AppHandle;
use crate::{
    commands::{SettingsState, lock},
    settings::PermissionSetup,
};

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

    const SETTINGS_URL: &str = Permission::ScreenRecording.settings_url();

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

    const SETTINGS_URL: &str = Permission::Microphone.settings_url();

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

/// Returns true when global mouse and keyboard events may be watched. On
/// macOS, without Input Monitoring, asks the system for it, which shows
/// its prompt the first time, and offers to open System Settings.
#[cfg(target_os = "macos")]
pub fn ensure_input_monitoring(app: &AppHandle) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    const SETTINGS_URL: &str = Permission::InputMonitoring.settings_url();

    // SAFETY: both functions take no arguments and only query or request
    // the permission; they are safe to call from any thread.
    if unsafe { CGPreflightListenEventAccess() } {
        return true;
    }
    // Shows the system's prompt the first time, and adds Grab-it to the
    // Input Monitoring list so the user can tick it.
    // SAFETY: as above.
    if unsafe { CGRequestListenEventAccess() } {
        return true;
    }

    app.dialog()
        .message(
            "Grab-it needs the Input Monitoring permission to show your clicks and \
             keystrokes in recordings.\n\n\
             Turn on Grab-it under Privacy & Security → Input Monitoring, then record again. \
             macOS may ask you to restart Grab-it. Until then, recordings are saved \
             without clicks or keystrokes.",
        )
        .title("Allow input monitoring")
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

/// Returns true when global mouse and keyboard events may be watched. Only
/// macOS asks.
#[cfg(not(target_os = "macos"))]
pub fn ensure_input_monitoring(_app: &AppHandle) -> bool {
    true
}

/// The permissions the Permissions page lists, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    ScreenRecording,
    InputMonitoring,
    Microphone,
    Camera,
}

impl Permission {
    /// Its pane in System Settings → Privacy & Security.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub const fn settings_url(self) -> &'static str {
        match self {
            Self::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Self::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            Self::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Self::Camera => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
            }
        }
    }
}

/// Where one permission stands. Mirrors `Access` in src/welcome/permissions.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Access {
    Allowed,
    /// Asked for and not granted, or (Screen Recording and Input
    /// Monitoring) granted but not seen until Grab-it restarts.
    Off,
    NotAsked,
}

/// What `permission_status` reports. Mirrors `PermissionStatus` in
/// src/welcome/permissions.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub screen_recording: Access,
    pub input_monitoring: Access,
    pub microphone: Access,
    pub camera: Access,
    /// Allow all ran and setup is not finished.
    pub resume: bool,
    /// Allow all ran since Grab-it started, so a grant of Screen Recording
    /// or Input Monitoring only shows after a restart. Unlike `resume`, a
    /// restart clears it.
    pub asked_this_launch: bool,
}

impl PermissionStatus {
    /// Every permission allowed: what systems without them report.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    const ALL_ALLOWED: Self = Self {
        screen_recording: Access::Allowed,
        input_monitoring: Access::Allowed,
        microphone: Access::Allowed,
        camera: Access::Allowed,
        resume: false,
        asked_this_launch: false,
    };
}

/// True when launch should open the Welcome window: Screen Recording, which
/// every capture needs, is not allowed, or Allow all ran and setup is waiting
/// to be finished after a restart. Microphone, Camera and Input Monitoring
/// never asked for do not reopen it, so Skip for now sticks: the per-feature
/// checks ask for those when a feature first needs them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn should_open_welcome(status: &PermissionStatus) -> bool {
    status.screen_recording != Access::Allowed || status.resume
}

/// Allow all ran in this process.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static ASKED_THIS_LAUNCH: AtomicBool = AtomicBool::new(false);

fn setup(app: &AppHandle) -> PermissionSetup {
    lock(&app.state::<SettingsState>()).get().permissions
}

fn save_setup(app: &AppHandle, change: impl FnOnce(&mut PermissionSetup)) {
    let state = app.state::<SettingsState>();
    let mut store = lock(&state);
    let mut next = store.get().permissions;
    change(&mut next);
    if let Err(err) = store.set_permission_setup(next) {
        eprintln!("Grab-it: could not write the settings file: {err}");
    }
}

/// Where each permission stands, without asking for any.
pub fn status(app: &AppHandle) -> PermissionStatus {
    let setup = setup(app);
    #[cfg(target_os = "macos")]
    {
        let cg = |granted: bool| match (granted, setup.asked) {
            (true, _) => Access::Allowed,
            (false, true) => Access::Off,
            (false, false) => Access::NotAsked,
        };
        PermissionStatus {
            screen_recording: cg(mac::screen_recording_granted()),
            input_monitoring: cg(mac::input_monitoring_granted()),
            microphone: mac::media_access(mac::Media::Audio),
            camera: mac::media_access(mac::Media::Video),
            resume: setup.resume,
            asked_this_launch: ASKED_THIS_LAUNCH.load(std::sync::atomic::Ordering::Relaxed),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = setup;
        PermissionStatus::ALL_ALLOWED
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo,
    };

    use super::Access;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    /// How long each of the system's prompts is waited for.
    const PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

    #[derive(Clone, Copy)]
    pub enum Media {
        Audio,
        Video,
    }

    fn media_type(media: Media) -> Option<&'static AVMediaType> {
        // SAFETY: constants AVFoundation exports.
        unsafe {
            match media {
                Media::Audio => AVMediaTypeAudio,
                Media::Video => AVMediaTypeVideo,
            }
        }
    }

    pub fn screen_recording_granted() -> bool {
        // SAFETY: takes no arguments and only queries the permission.
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn input_monitoring_granted() -> bool {
        // SAFETY: as above.
        unsafe { CGPreflightListenEventAccess() }
    }

    /// Shows the Screen Recording and Input Monitoring prompts, which add
    /// Grab-it to each list. Neither waits for an answer, and a grant is
    /// only seen once Grab-it restarts.
    pub fn request_screen_and_input() {
        // SAFETY: both take no arguments and only request the permission;
        // they are safe to call from any thread.
        unsafe {
            if !CGPreflightScreenCaptureAccess() {
                let _ = CGRequestScreenCaptureAccess();
            }
            if !CGPreflightListenEventAccess() {
                let _ = CGRequestListenEventAccess();
            }
        }
    }

    pub fn media_access(media: Media) -> Access {
        let Some(kind) = media_type(media) else {
            return Access::Off;
        };
        // SAFETY: AVMediaTypeAudio and AVMediaTypeVideo are the two media
        // types it takes.
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(kind) };
        if status == AVAuthorizationStatus::Authorized {
            Access::Allowed
        } else if status == AVAuthorizationStatus::NotDetermined {
            Access::NotAsked
        } else {
            Access::Off
        }
    }

    /// Shows the system's prompt for `media` when it was never asked for,
    /// and waits for the answer, as `ensure_microphone` does.
    pub fn request_media(media: Media) {
        if media_access(media) != Access::NotAsked {
            return;
        }
        let Some(kind) = media_type(media) else {
            return;
        };
        let (sender, answer) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = sender.send(granted.as_bool());
        });
        // SAFETY: as above; the handler may be called on any thread, and
        // only sends on a channel.
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(kind, &handler) };
        let _ = answer.recv_timeout(PROMPT_TIMEOUT);
    }

    /// Captures one pixel of the screen and throws it away. On macOS 15
    /// and later, the first capture through the older APIs shows the alert
    /// asking to let Grab-it bypass the system private window picker, even
    /// with Screen Recording on; no API asks for it ahead of time, so this
    /// shows it now instead of on the first real capture.
    pub fn prime_capture() {
        use std::ffi::c_void;

        use objc2_core_foundation::{CGPoint, CGRect, CGSize};

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGWindowListCreateImage(
                bounds: CGRect,
                list_option: u32,
                window_id: u32,
                image_option: u32,
            ) -> *mut c_void;
            fn CGImageRelease(image: *mut c_void);
        }

        /// kCGWindowListOptionOnScreenOnly.
        const ON_SCREEN_ONLY: u32 = 1 << 0;
        /// kCGNullWindowID.
        const NULL_WINDOW_ID: u32 = 0;
        /// kCGWindowImageDefault.
        const IMAGE_DEFAULT: u32 = 0;

        if !screen_recording_granted() {
            return;
        }
        let pixel = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: 1.0,
                height: 1.0,
            },
        };
        // SAFETY: takes plain values and returns a new image, or null,
        // which the caller owns; CGImageRelease accepts null.
        unsafe {
            let image =
                CGWindowListCreateImage(pixel, ON_SCREEN_ONLY, NULL_WINDOW_ID, IMAGE_DEFAULT);
            CGImageRelease(image);
        }
    }
}

/// Asks for every permission, then reports where they stand. Blocks while
/// the Microphone and Camera prompts wait for answers, so call this off the
/// main thread.
pub fn request_all(app: &AppHandle) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        // Remembered first, so quitting during a prompt still resumes setup.
        save_setup(app, |setup| setup.resume = true);
        ASKED_THIS_LAUNCH.store(true, std::sync::atomic::Ordering::Relaxed);
        mac::request_media(mac::Media::Audio);
        mac::request_media(mac::Media::Video);
        save_setup(app, |setup| setup.asked = true);
        // Together, so both are answered before the one restart.
        mac::request_screen_and_input();
    }
    status(app)
}

/// Where each permission stands, for the Permissions page, which polls it.
#[tauri::command]
#[specta::specta]
pub fn permission_status(app: AppHandle) -> PermissionStatus {
    status(&app)
}

/// Allow all: asks for each permission in turn.
#[tauri::command]
#[specta::specta]
pub async fn permission_request_all(app: AppHandle) -> Result<PermissionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || request_all(&app))
        .await
        .map_err(|err| err.to_string())
}

/// Setup reopened after Allow all's restart with nothing missing: one
/// throwaway capture, so macOS 15+ shows its window-picker alert now rather
/// than on the first real capture. Does nothing without Screen Recording,
/// or off macOS.
#[tauri::command]
#[specta::specta]
pub async fn permission_prime_capture() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        mac::prime_capture();
    })
    .await
    .map_err(|err| err.to_string())
}

/// Skip for now or Continue: launches stop reopening the Welcome window for
/// an unfinished setup.
#[tauri::command]
#[specta::specta]
pub fn permission_finish(app: AppHandle) {
    save_setup(&app, |setup| setup.resume = false);
}

/// Restarts Grab-it, so it sees Screen Recording and Input Monitoring.
#[tauri::command]
#[specta::specta]
pub fn permission_restart(app: AppHandle) {
    app.restart();
}

/// Opens `permission`'s pane in System Settings. Only macOS has one.
#[tauri::command]
#[specta::specta]
pub fn permission_open_settings(permission: Permission) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(permission.settings_url())
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Could not open System Settings: {err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Ok(())
    }
}

/// Synthetic scrolling needs Accessibility on macOS. The system prompt is
/// asynchronous: until a grant is visible, this capture remains manual.
#[cfg(target_os = "macos")]
pub fn ensure_accessibility(_app: &AppHandle) -> bool {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        static kAXTrustedCheckOptionPrompt: *const c_void;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }
    // SAFETY: the key and value are immortal framework constants. Null
    // callbacks leave them unretained, valid for this dictionary's lifetime.
    // Release the owned dictionary after the synchronous trust query.
    unsafe {
        let key = kAXTrustedCheckOptionPrompt;
        let value = kCFBooleanTrue;
        let options = CFDictionaryCreate(
            std::ptr::null(),
            &key,
            &value,
            1,
            std::ptr::null(),
            std::ptr::null(),
        );
        if options.is_null() {
            return false;
        }
        let trusted = AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
        trusted
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_accessibility(_app: &AppHandle) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTHING_ASKED: PermissionStatus = PermissionStatus {
        screen_recording: Access::NotAsked,
        input_monitoring: Access::NotAsked,
        microphone: Access::NotAsked,
        camera: Access::NotAsked,
        resume: false,
        asked_this_launch: false,
    };

    #[test]
    fn welcome_opens_while_nothing_was_asked() {
        assert!(should_open_welcome(&NOTHING_ASKED));
    }

    #[test]
    fn welcome_stays_shut_once_everything_is_allowed() {
        assert!(!should_open_welcome(&PermissionStatus::ALL_ALLOWED));
    }

    #[test]
    fn welcome_opens_while_screen_recording_is_off() {
        let status = PermissionStatus {
            screen_recording: Access::Off,
            ..PermissionStatus::ALL_ALLOWED
        };
        assert!(should_open_welcome(&status));
    }

    #[test]
    fn welcome_opens_while_screen_recording_was_never_asked() {
        let status = PermissionStatus {
            screen_recording: Access::NotAsked,
            ..PermissionStatus::ALL_ALLOWED
        };
        assert!(should_open_welcome(&status));
    }

    #[test]
    fn microphone_camera_or_input_monitoring_never_asked_does_not_reopen_it() {
        let status = PermissionStatus {
            input_monitoring: Access::NotAsked,
            microphone: Access::NotAsked,
            camera: Access::NotAsked,
            ..PermissionStatus::ALL_ALLOWED
        };
        assert!(!should_open_welcome(&status));
    }

    #[test]
    fn a_declined_microphone_camera_or_input_monitoring_does_not_reopen_it() {
        let status = PermissionStatus {
            input_monitoring: Access::Off,
            microphone: Access::Off,
            camera: Access::Off,
            ..PermissionStatus::ALL_ALLOWED
        };
        assert!(!should_open_welcome(&status));
    }

    #[test]
    fn welcome_reopens_to_finish_setup_after_the_restart() {
        let status = PermissionStatus {
            resume: true,
            ..PermissionStatus::ALL_ALLOWED
        };
        assert!(should_open_welcome(&status));
    }

    #[test]
    fn status_is_sent_in_the_frontends_spelling() {
        let json = serde_json::to_value(NOTHING_ASKED).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "screenRecording": "notAsked",
                "inputMonitoring": "notAsked",
                "microphone": "notAsked",
                "camera": "notAsked",
                "resume": false,
                "askedThisLaunch": false,
            })
        );
    }
}
