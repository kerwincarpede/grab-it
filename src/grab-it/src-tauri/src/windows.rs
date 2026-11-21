//! Creating and focusing the app's windows.

use std::{
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::rt::{AppHandle, WebviewWindow};
use crate::{
    actions, cli::OpenTarget, editor::EditorState, hotkeys, pin, quick,
    recording_editor::RecordingEditorState,
};

/// Smoke-test builds on Windows: keeps the browser arguments msedgedriver
/// sets in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, its
/// `--remote-debugging-port` among them. The arguments wry passes in their
/// place would replace them, and msedgedriver could not attach. Every
/// webview builder calls it, since WebView2 wants one set of arguments per
/// process. Other builds keep the builder as it is.
pub trait E2eBrowserArgs {
    #[must_use]
    fn e2e_browser_args(self) -> Self;
}

impl<R: Runtime, M: Manager<R>> E2eBrowserArgs for WebviewWindowBuilder<'_, R, M> {
    fn e2e_browser_args(self) -> Self {
        #[cfg(all(feature = "e2e", target_os = "windows"))]
        if let Ok(args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            && !args.trim().is_empty()
        {
            return self.additional_browser_args(&with_wry_browser_args(&args));
        }
        self
    }
}

/// The features wry turns off when nothing sets the browser arguments.
#[cfg(all(feature = "e2e", any(target_os = "windows", test)))]
const WRY_DISABLED_FEATURES: &str = "msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// `args` with wry's turned-off features added to theirs, in one
/// `--disable-features`, since Chromium reads only the last one.
#[cfg(all(feature = "e2e", any(target_os = "windows", test)))]
fn with_wry_browser_args(args: &str) -> String {
    const SWITCH: &str = "--disable-features=";
    let mut features: Vec<&str> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    let mut position = None;
    for arg in args.split_whitespace() {
        match arg.strip_prefix(SWITCH) {
            Some(value) => {
                position.get_or_insert(rest.len());
                features.extend(value.split(',').filter(|name| !name.is_empty()));
            }
            None => rest.push(arg),
        }
    }
    for name in WRY_DISABLED_FEATURES.split(',') {
        if !features.contains(&name) {
            features.push(name);
        }
    }
    let disable = format!("{SWITCH}{}", features.join(","));
    rest.insert(position.unwrap_or(rest.len()), &disable);
    rest.join(" ")
}

/// The Grab-it window: library, Settings, shortcuts and tips.
pub const MAIN_LABEL: &str = "main";
/// Emitted to the Grab-it window, with a [`MainView`] name, to switch views.
pub const MAIN_NAVIGATE_EVENT: &str = "main-navigate";
/// Editor windows are labelled `editor-<n>`.
pub const EDITOR_LABEL_PREFIX: &str = "editor-";
/// Recording editor windows are labelled `recording-<n>`.
pub const RECORDING_LABEL_PREFIX: &str = "recording-";

/// Shows the window for an `--open` target.
pub fn open(app: &AppHandle, target: OpenTarget) -> tauri::Result<()> {
    match target {
        OpenTarget::Settings => show_settings(app),
        OpenTarget::Library => show_library(app),
        OpenTarget::Welcome => show_welcome(app),
        OpenTarget::Region => {
            actions::start(app, actions::Action::Region);
            Ok(())
        }
        OpenTarget::AllInOne => {
            actions::start(app, actions::Action::AllInOne);
            Ok(())
        }
        OpenTarget::Text => {
            actions::start(app, actions::Action::Text);
            Ok(())
        }
        OpenTarget::Colour => {
            actions::start(app, actions::Action::Colour);
            Ok(())
        }
        OpenTarget::Repeat => {
            actions::start(app, actions::Action::Repeat);
            Ok(())
        }
        OpenTarget::Record => {
            actions::start(app, actions::Action::Record);
            Ok(())
        }
        OpenTarget::Steps => {
            actions::start(app, actions::Action::Steps);
            Ok(())
        }
        OpenTarget::Guide(path) => match existing_file(&path) {
            Some(path) => crate::steps::show_guide(app, &path),
            None => Ok(()),
        },
        OpenTarget::Editor(path) => match existing_file(&path) {
            Some(path) => show_editor(app, &path),
            None => Ok(()),
        },
        OpenTarget::Quick(path) => {
            if let Some(path) = existing_file(&path) {
                let size = image::image_dimensions(&path).unwrap_or_default();
                quick::show(app, quick::QuickItem::capture(&path, size, false));
            }
            Ok(())
        }
        OpenTarget::Pin(path) => {
            if let Some(path) = existing_file(&path)
                && let Err(err) = pin::open(app, &path, false)
            {
                eprintln!("Grab-it: {err}");
            }
            Ok(())
        }
    }
}

/// The full path of a file named on the command line, or `None` (after
/// saying so) when there is no such file.
fn existing_file(path: &Path) -> Option<std::path::PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(path) if path.is_file() => Some(path),
        _ => {
            eprintln!("Grab-it: no capture at {}", path.display());
            None
        }
    }
}

/// The Guide window, which edits and exports a step capture's guide.
pub const GUIDE_LABEL: &str = "guide";

/// Shows the Guide window titled after `title`, reloading it when it is
/// already open so it shows the guide now chosen (see `steps::show_guide`).
pub fn show_guide(app: &AppHandle, title: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(GUIDE_LABEL) {
        window.set_title(&format!("{title} - Grab-it Guide"))?;
        window.eval("window.location.reload()")?;
        return bring_to_front(&window);
    }
    WebviewWindowBuilder::new(
        app,
        GUIDE_LABEL,
        WebviewUrl::App("index.html#/guide".into()),
    )
    .e2e_browser_args()
    .title(format!("{title} - Grab-it Guide"))
    .inner_size(900.0, 760.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .build()
    .map(|_| ())
}

/// Opens `capture` in an editor window, or focuses the one already showing it.
pub fn show_editor(app: &AppHandle, capture: &Path) -> tauri::Result<()> {
    static NEXT_EDITOR: AtomicU32 = AtomicU32::new(1);

    let state = app.state::<EditorState>();
    if let Some(window) = state
        .label_for(capture)
        .and_then(|label| app.get_webview_window(&label))
    {
        return bring_to_front(&window);
    }

    let label = format!(
        "{EDITOR_LABEL_PREFIX}{}",
        NEXT_EDITOR.fetch_add(1, Ordering::Relaxed)
    );
    // Registered before the page loads so `editor_info` finds it.
    state.insert(&label, capture.to_path_buf());
    let file_name = capture
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/editor".into()))
            .e2e_browser_args()
            .title(format!("{file_name} - Grab-it Editor"))
            .inner_size(1100.0, 760.0)
            .min_inner_size(640.0, 420.0)
            .center()
            .build();
    let window = match window {
        Ok(window) => window,
        Err(err) => {
            state.remove(&label);
            return Err(err);
        }
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app.state::<EditorState>().remove(&label);
        }
    });
    bring_to_front(&window)
}

/// Opens the MP4 `recording` in a recording editor window, or focuses the
/// one already showing it.
pub fn show_recording_editor(app: &AppHandle, recording: &Path) -> tauri::Result<()> {
    static NEXT_RECORDING: AtomicU32 = AtomicU32::new(1);

    let state = app.state::<RecordingEditorState>();
    if let Some(window) = state
        .label_for(recording)
        .and_then(|label| app.get_webview_window(&label))
    {
        return bring_to_front(&window);
    }

    let label = format!(
        "{RECORDING_LABEL_PREFIX}{}",
        NEXT_RECORDING.fetch_add(1, Ordering::Relaxed)
    );
    // Registered before the page loads so `recording_info` finds it.
    state.insert(&label, recording.to_path_buf());
    let file_name = recording
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/recording".into()))
            .e2e_browser_args()
            .title(format!("{file_name} - Grab-it Recording Editor"))
            .inner_size(1100.0, 760.0)
            .min_inner_size(640.0, 460.0)
            .center()
            .build();
    let window = match window {
        Ok(window) => window,
        Err(err) => {
            state.remove(&label);
            return Err(err);
        }
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app.state::<RecordingEditorState>().remove(&label);
        }
    });
    bring_to_front(&window)
}

/// What the main window shows. Mirrors `MainView` in src/app/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainView {
    Library,
    Settings,
    Welcome,
}

impl MainView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Settings => "settings",
            Self::Welcome => "welcome",
        }
    }
}

/// Shows the Grab-it window on `view`, creating it on first use. It holds
/// the library, Settings and the shortcuts, so there is one window to find.
pub fn show_main(app: &AppHandle, view: MainView) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        window.emit(MAIN_NAVIGATE_EVENT, view.as_str())?;
        return bring_to_front(&window);
    }
    let builder = WebviewWindowBuilder::new(
        app,
        MAIN_LABEL,
        WebviewUrl::App(format!("index.html#/app/{}", view.as_str()).into()),
    )
    .e2e_browser_args()
    .title("Grab-it")
    .inner_size(1180.0, 760.0)
    .min_inner_size(720.0, 480.0)
    .center();
    // Settings → Recording lists the cameras for Show webcam.
    let builder = crate::webcam::allow_camera(builder);
    // On macOS the sidebar runs to the top and holds the window buttons;
    // the page marks where the window can be dragged.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    if let Err(err) = crate::webcam::enable_media_streams(&window) {
        eprintln!("Grab-it: could not let Settings list the cameras: {err}");
    }
    let zoom = app
        .try_state::<crate::commands::SettingsState>()
        .map(|state| crate::commands::lock(&state).get().appearance.zoom())
        .unwrap_or_else(|| crate::settings::Appearance::default().zoom());
    set_zoom_now(&window, zoom);
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Closed while recording a hotkey in Settings: give the hotkeys back.
        if matches!(event, WindowEvent::Destroyed) {
            hotkeys::resume(&handle);
        }
    });
    bring_to_front(&window)
}

/// Shows `window` in front of every app's windows, not just Grab-it's, and
/// makes Grab-it the active app.
///
/// Grab-it lives in the menu bar, so it is usually in the background when a
/// window is asked for. Becoming the active app is what makes macOS, and
/// window managers that follow focus such as AeroSpace, switch to the space
/// or workspace the window is on rather than leaving it out of sight there.
pub fn bring_to_front(window: &WebviewWindow) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    #[cfg(target_os = "macos")]
    activate(window)?;
    Ok(())
}

/// macOS: activates Grab-it with all its windows and orders `window` front.
///
/// `set_focus` asks to activate only through `NSApp`, which newer macOS may
/// turn down for an app in the background; asking the app's
/// `NSRunningApplication` as well, and ordering the window front regardless,
/// brings it forward even then.
#[cfg(target_os = "macos")]
fn activate(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2::runtime::AnyObject;

    /// `NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps`.
    const ACTIVATE_ALL_IGNORING_OTHERS: usize = 1 | 2;

    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: on the main thread, with this window's live NSWindow; each
        // selector is a documented NSRunningApplication or NSWindow method
        // with the argument and return types given.
        unsafe {
            let running: *mut AnyObject =
                objc2::msg_send![objc2::class!(NSRunningApplication), currentApplication];
            if !running.is_null() {
                let _: bool =
                    objc2::msg_send![running, activateWithOptions: ACTIVATE_ALL_IGNORING_OTHERS];
            }
            let none: *mut AnyObject = std::ptr::null_mut();
            let _: () = objc2::msg_send![ns_window, makeKeyAndOrderFront: none];
            let _: () = objc2::msg_send![ns_window, orderFrontRegardless];
        }
    })
}

/// Draws the Grab-it window at `zoom` (1.0 is actual size), when it is open.
pub fn apply_zoom(app: &AppHandle, zoom: f64) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let (from, generation) = {
        let mut shown = lock_zoom();
        shown.generation += 1;
        (shown.zoom, shown.generation)
    };
    if from.is_none_or(|from| (from - zoom).abs() < 1e-3) {
        set_zoom_now(&window, zoom);
        return;
    }
    let from = from.unwrap_or(zoom);
    // Each frame is a message to the main thread, so the steps run here.
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            let progress = (start.elapsed().as_secs_f64() / ZOOM_EASE.as_secs_f64()).min(1.0);
            let step = eased_zoom(from, zoom, progress);
            {
                let mut shown = lock_zoom();
                // A newer size took over from here.
                if shown.generation != generation {
                    return;
                }
                // Set under the lock, so an older step cannot land after a newer one.
                if let Err(err) = window.set_zoom(step) {
                    eprintln!("Grab-it: could not set the text size: {err}");
                    return;
                }
                shown.zoom = Some(step);
            }
            if progress >= 1.0 {
                return;
            }
            std::thread::sleep(ZOOM_FRAME);
        }
    });
}

/// How long the Grab-it window takes to ease to a new text size.
const ZOOM_EASE: Duration = Duration::from_millis(180);
/// About one frame of a 60 Hz screen.
const ZOOM_FRAME: Duration = Duration::from_millis(16);

/// The zoom the Grab-it window shows, so the next ease starts from where the
/// last one got to, and which ease is the current one.
struct ShownZoom {
    zoom: Option<f64>,
    generation: u64,
}

static SHOWN_ZOOM: Mutex<ShownZoom> = Mutex::new(ShownZoom {
    zoom: None,
    generation: 0,
});

fn lock_zoom() -> std::sync::MutexGuard<'static, ShownZoom> {
    SHOWN_ZOOM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sets the Grab-it window's zoom at once, stopping any ease under way.
fn set_zoom_now(window: &WebviewWindow, zoom: f64) {
    let mut shown = lock_zoom();
    shown.generation += 1;
    match window.set_zoom(zoom) {
        Ok(()) => shown.zoom = Some(zoom),
        Err(err) => eprintln!("Grab-it: could not set the text size: {err}"),
    }
}

/// The zoom `progress` (0 to 1) of the way from `from` to `to`, easing out:
/// quick at first, settling gently on the new size.
fn eased_zoom(from: f64, to: f64, progress: f64) -> f64 {
    let progress = progress.clamp(0.0, 1.0);
    let eased = 1.0 - (1.0 - progress).powi(3);
    from + (to - from) * eased
}

/// Shows the Grab-it window on Settings.
pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Settings)
}

/// Shows the Grab-it window on the library.
pub fn show_library(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Library)
}

/// Shows the Grab-it window on the shortcuts and tips. Opened by itself on
/// the first launch, and from the tray afterwards.
pub fn show_welcome(app: &AppHandle) -> tauri::Result<()> {
    show_main(app, MainView::Welcome)
}

/// Gives Grab-it a Dock icon, or takes it away (macOS only).
pub fn apply_dock_icon(app: &AppHandle, show: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if show {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(err) = app.set_activation_policy(policy) {
            eprintln!("Grab-it: could not change the Dock icon: {err}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, show);
}

/// macOS: rounds a borderless window (the hub, the Quick Access card) like
/// a menu. The window is made see-through and
/// its content clipped to rounded corners, so this needs no private API;
/// the shadow is then redrawn to follow the new shape.
#[cfg(target_os = "macos")]
pub fn round_corners(window: &WebviewWindow, radius: f64) -> tauri::Result<()> {
    use objc2::runtime::AnyObject;

    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: `ns_window` is this window's live NSWindow, used on the
        // main thread. Each selector is a documented NSWindow, NSView,
        // NSColor or CALayer method with the argument types given.
        unsafe {
            let clear: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), clearColor];
            let _: () = objc2::msg_send![ns_window, setOpaque: false];
            let _: () = objc2::msg_send![ns_window, setBackgroundColor: clear];
            let view: *mut AnyObject = objc2::msg_send![ns_window, contentView];
            if view.is_null() {
                return;
            }
            let _: () = objc2::msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = objc2::msg_send![view, layer];
            if layer.is_null() {
                return;
            }
            let _: () = objc2::msg_send![layer, setCornerRadius: radius];
            let _: () = objc2::msg_send![layer, setMasksToBounds: true];
            let _: () = objc2::msg_send![ns_window, invalidateShadow];
        }
    })
}

#[cfg(test)]
mod tests {
    use super::eased_zoom;

    #[test]
    fn the_zoom_eases_out_from_the_old_size_to_the_new() {
        assert_eq!(eased_zoom(1.1, 1.2, 0.0), 1.1);
        assert_eq!(eased_zoom(1.1, 1.2, 1.0), 1.2);
        // Most of the way there by half time, and never past it.
        let half = eased_zoom(1.0, 2.0, 0.5);
        assert!((half - 1.875).abs() < 1e-9, "{half}");
        assert_eq!(eased_zoom(1.0, 2.0, 1.5), 2.0);
        // Smaller works the same way down.
        assert!(eased_zoom(1.2, 1.1, 0.5) < 1.2 && eased_zoom(1.2, 1.1, 0.5) > 1.1);
    }

    #[cfg(feature = "e2e")]
    #[test]
    fn msedgedriver_browser_args_keep_the_features_wry_turns_off() {
        use super::with_wry_browser_args;

        assert_eq!(
            with_wry_browser_args(
                "--enable-automation --disable-features=IgnoreDuplicateNavs,Prewarm --remote-debugging-port=0"
            ),
            "--enable-automation \
             --disable-features=IgnoreDuplicateNavs,Prewarm,msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --remote-debugging-port=0"
        );
        // No switch of their own: wry's is added. One already named once is not repeated.
        assert_eq!(
            with_wry_browser_args("--remote-debugging-port=0"),
            "--remote-debugging-port=0 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
        );
        assert_eq!(
            with_wry_browser_args("--disable-features=msPdfOOUI  --disable-features=Prewarm"),
            "--disable-features=msPdfOOUI,Prewarm,msWebOOUI,msSmartScreenProtection"
        );
    }
}
