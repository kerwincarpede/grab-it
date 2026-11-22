//! Calls the app's commands through Tauri's IPC, on the mock runtime, the
//! way a page's `invoke` reaches them: arguments are deserialized from JSON,
//! states are looked up and the reply is serialized back. They catch a
//! command whose JSON shape, saved state or error message changes.
//!
//! Every test builds the real handler list ([`crate::invoke_handler`]) and
//! states ([`crate::manage_states`]) over a temporary folder. ffmpeg, OCR
//! and AI describing are left unmanaged, so none of them ever starts, and
//! the settings store has an in-memory keychain. Nothing here needs a
//! display or the network.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use image::RgbaImage;
use serde_json::{Value, json};
use tauri::{
    App, Manager, WebviewUrl, WebviewWindowBuilder,
    http::{HeaderMap, HeaderValue},
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets},
    webview::InvokeRequest,
};
use tempfile::TempDir;

use crate::{
    capture::{self, ORIGINALS_DIR},
    editor::EditorState,
    keychain::MemoryKeyStore,
    library::{
        self, AiDescription, LibraryState, MAX_PAGE, THUMBNAIL_EDITED_HEADER, THUMBNAIL_ID_HEADER,
        THUMBS_DIR,
    },
    ocr::OcrLine,
    record::RECORDINGS_DIR,
    rt::WebviewWindow,
    settings::{SETTINGS_FILE, Settings, SettingsStore},
};

/// The mock webview's label: neither `main` nor `hub`, so commands that
/// resize or zoom those windows find nothing to change.
const LABEL: &str = "ipc-test";

/// The page's origin, which Tauri checks a request against.
const APP_URL: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

/// The longest a test waits for work a command started in the background.
const WAIT: Duration = Duration::from_secs(10);

/// The app built on the mock runtime with one webview, over a temporary
/// folder holding the settings file, the Library database and the save
/// folder.
struct Harness {
    webview: WebviewWindow,
    app: App<MockRuntime>,
    /// Dropped last. A background thread's handle keeps the Library open
    /// after `app` drops, so a test must wait for any background work it
    /// starts, such as set_save_folder's rescan, before it ends.
    dir: TempDir,
}

impl Harness {
    /// A first run: no settings file yet.
    fn new() -> Self {
        Self::with_settings_file(None)
    }

    /// Starts from `stored` as the settings file, as a later run would.
    fn with_stored(stored: Value) -> Self {
        Self::with_settings_file(Some(stored))
    }

    fn with_settings_file(stored: Option<Value>) -> Self {
        let dir = TempDir::new().expect("a temporary folder");
        let settings_file = settings_file(dir.path());
        if let Some(stored) = stored {
            fs::create_dir_all(settings_file.parent().unwrap()).unwrap();
            fs::write(&settings_file, stored.to_string()).unwrap();
        }
        let store = SettingsStore::open_with_keys(
            settings_file,
            Settings::defaults(dir.path()),
            Box::new(MemoryKeyStore::default()),
        );
        let app = crate::manage_states(mock_builder())
            .manage(crate::clipboard_sound::Preference::new(
                store.get().copy_sound,
            ))
            .manage(Mutex::new(store))
            .manage(library::open_for_app(&dir.path().join("data")))
            .invoke_handler(crate::invoke_handler())
            .build(mock_context(noop_assets()))
            .expect("the app builds on the mock runtime");
        let webview = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::default())
            .build()
            .expect("a mock webview");
        Self { webview, app, dir }
    }

    /// The folder new captures go to before any test changes it.
    fn default_save_folder(&self) -> PathBuf {
        Settings::defaults(self.dir.path()).save_folder
    }

    fn settings_file(&self) -> PathBuf {
        settings_file(self.dir.path())
    }

    /// The settings file as written, parsed.
    fn saved(&self) -> Value {
        let text = fs::read_to_string(self.settings_file()).expect("the settings file");
        serde_json::from_str(&text).expect("valid JSON in the settings file")
    }

    /// Puts a file where the settings file's folder should be, so every
    /// save fails with an I/O error.
    fn break_saving(&self) {
        let folder = self.settings_file().parent().unwrap().to_owned();
        if folder.exists() {
            fs::remove_dir_all(&folder).unwrap();
        }
        fs::write(&folder, "not a folder").unwrap();
    }

    /// Calls `cmd` with `body` and `headers` as a page would, returning the
    /// reply as it was sent.
    fn call(
        &self,
        cmd: &str,
        body: InvokeBody,
        headers: HeaderMap,
    ) -> Result<InvokeResponseBody, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: APP_URL.parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.into(),
        };
        get_ipc_response(&self.webview, request)
    }

    /// Calls `cmd` with `args` as a page would.
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.call(cmd, InvokeBody::Json(args), HeaderMap::new())
            .map(|body| body.deserialize::<Value>().expect("a JSON reply"))
    }

    /// Calls `cmd` with raw bytes as its body and `headers`, as a page
    /// sending an image does.
    fn invoke_raw(&self, cmd: &str, bytes: Vec<u8>, headers: HeaderMap) -> Result<Value, Value> {
        self.call(cmd, InvokeBody::Raw(bytes), headers)
            .map(|body| body.deserialize::<Value>().expect("a JSON reply"))
    }

    /// The bytes a call that must succeed sends back as a
    /// `tauri::ipc::Response`.
    fn bytes(&self, cmd: &str, args: Value) -> Vec<u8> {
        match self.call(cmd, InvokeBody::Json(args), HeaderMap::new()) {
            Ok(InvokeResponseBody::Raw(bytes)) => bytes,
            Ok(InvokeResponseBody::Json(json)) => {
                panic!("{cmd} sent JSON instead of bytes: {json}")
            }
            Err(err) => panic!("{cmd} failed: {err}"),
        }
    }

    /// The reply of a call that must succeed.
    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.invoke(cmd, args)
            .unwrap_or_else(|err| panic!("{cmd} failed: {err}"))
    }

    /// The message of a call that must fail.
    fn err(&self, cmd: &str, args: Value) -> String {
        match self.invoke(cmd, args) {
            Ok(reply) => panic!("{cmd} succeeded with {reply}"),
            Err(Value::String(message)) => message,
            Err(other) => panic!("{cmd} failed without a message: {other}"),
        }
    }

    /// The settings as `get_settings` returns them.
    fn settings(&self) -> Value {
        self.ok("get_settings", json!({}))
    }

    /// How many items the Library holds.
    fn library_total(&self) -> u32 {
        self.app
            .state::<LibraryState>()
            .lock()
            .list(0, MAX_PAGE)
            .expect("the Library lists")
            .total
    }
}

fn settings_file(dir: &Path) -> PathBuf {
    dir.join("config").join(SETTINGS_FILE)
}

/// Waits until `done`, failing the test after [`WAIT`].
fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Writes a small PNG into `save_folder`'s originals, as a capture would.
fn seed_capture(save_folder: &Path, name: &str) {
    let originals = save_folder.join(ORIGINALS_DIR);
    fs::create_dir_all(&originals).unwrap();
    RgbaImage::new(8, 6).save(originals.join(name)).unwrap();
}

/// The keys of a JSON object, sorted.
fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value
        .as_object()
        .expect("a JSON object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys
}

/// A Tauri error for an argument the command could not read.
fn assert_invalid_arg(message: &str, cmd: &str, arg: &str) {
    assert!(
        message.contains(cmd) && message.contains(arg),
        "expected an invalid `{arg}` for {cmd}, got: {message}"
    );
}

// get_settings and set_save_folder

#[test]
fn get_settings_returns_the_settings_shape() {
    let h = Harness::new();
    let settings = h.settings();
    assert_eq!(
        keys(&settings),
        [
            "afterCapture",
            "agentAccess",
            "ai",
            "appearance",
            "copySound",
            "copyToClipboard",
            "editor",
            "hotkeys",
            "permissions",
            "recording",
            "retention",
            "saveFolder",
            "showInDock",
            "updateChannel",
        ]
    );
    assert_eq!(
        settings["saveFolder"],
        json!(h.default_save_folder().to_string_lossy())
    );
    assert_eq!(settings["afterCapture"], "quickAccess");
    assert_eq!(settings["copyToClipboard"], true);
    assert_eq!(settings["copySound"], false);
    assert_eq!(settings["ai"]["enabled"], false);
    assert_eq!(settings["updateChannel"], "stable");
    assert_eq!(
        keys(&settings["hotkeys"]),
        [
            "allInOne", "colour", "library", "region", "screen", "steps", "text", "window",
        ]
    );
    assert_eq!(
        keys(&settings["appearance"]),
        ["hubScale", "popupCorner", "popupSeconds", "textScale"]
    );
    assert_eq!(settings["appearance"]["textScale"], 110);
    assert_eq!(settings["recording"]["format"], "mp4");
    assert_eq!(settings["recording"]["fps"], 30);
    assert_eq!(
        settings["retention"],
        json!({ "image": null, "gif": null, "video": null, "removal": "trash" })
    );
    assert_eq!(settings["editor"], json!({}));
    // Reading writes nothing.
    assert!(!h.settings_file().exists());
}

#[test]
fn get_settings_reads_the_settings_file() {
    let h = Harness::with_stored(json!({
        "afterCapture": "editor",
        "agentAccess": true,
        "appearance": { "textScale": 125 },
    }));
    let settings = h.settings();
    assert_eq!(settings["afterCapture"], "editor");
    assert_eq!(settings["agentAccess"], true);
    assert_eq!(settings["appearance"]["textScale"], 125);
    assert_eq!(settings["appearance"]["popupSeconds"], 8);
}

#[test]
fn set_save_folder_saves_and_rescans_the_new_folder() {
    let h = Harness::new();
    let folder = h.dir.path().join("elsewhere");
    seed_capture(&folder, "seed.png");
    assert_eq!(h.library_total(), 0);

    let settings = h.ok(
        "set_save_folder",
        json!({ "path": folder.to_string_lossy() }),
    );
    assert_eq!(settings["saveFolder"], json!(folder.to_string_lossy()));
    assert_eq!(h.settings()["saveFolder"], settings["saveFolder"]);
    assert_eq!(h.saved()["saveFolder"], settings["saveFolder"]);
    // The rescan runs in the background; it must finish before the
    // temporary folder goes.
    wait_for("the rescan to add the capture", || h.library_total() == 1);
}

#[test]
fn set_save_folder_creates_a_missing_folder() {
    let h = Harness::new();
    // A rescan of the new, empty folder would change nothing that could be
    // waited for. A Library row whose file is gone is dropped by a rescan
    // of any folder, so the one rescan below always changes the Library,
    // and the test waits for it before the temporary folder goes.
    let old = h.dir.path().join("old");
    seed_capture(&old, "seed.png");
    h.app
        .state::<LibraryState>()
        .rescan(&old, None)
        .expect("the old folder rescans");
    assert_eq!(h.library_total(), 1);
    fs::remove_file(old.join(ORIGINALS_DIR).join("seed.png")).unwrap();

    let folder = h.dir.path().join("new").join("captures");
    h.ok(
        "set_save_folder",
        json!({ "path": folder.to_string_lossy() }),
    );
    assert!(folder.is_dir());
    wait_for("the rescan to drop the missing capture", || {
        h.library_total() == 0
    });
}

#[test]
fn set_save_folder_refuses_an_invalid_folder() {
    let h = Harness::new();
    assert_eq!(
        h.err("set_save_folder", json!({ "path": "  " })),
        "Choose a save folder."
    );
    assert_eq!(
        h.err("set_save_folder", json!({ "path": "relative/captures" })),
        "The save folder must be a full path, not `relative/captures`."
    );
    assert_invalid_arg(
        &h.err("set_save_folder", json!({})),
        "set_save_folder",
        "path",
    );
    assert_eq!(
        h.settings()["saveFolder"],
        json!(h.default_save_folder().to_string_lossy())
    );
    assert!(!h.settings_file().exists());
}

#[test]
fn set_save_folder_reports_a_failed_save() {
    let h = Harness::new();
    h.break_saving();
    let folder = h.dir.path().join("elsewhere");
    let message = h.err(
        "set_save_folder",
        json!({ "path": folder.to_string_lossy() }),
    );
    assert!(!message.is_empty());
    assert_eq!(
        h.settings()["saveFolder"],
        json!(h.default_save_folder().to_string_lossy())
    );
}

// set_preferences, set_appearance, step_text_size, set_recording,
// set_retention, set_show_in_dock and set_agent_access

#[test]
fn copy_sound_defaults_off_and_saves_independently() {
    let h = Harness::with_stored(json!({
        "copyToClipboard": false,
        "afterCapture": "editor",
        "agentAccess": true,
    }));
    let preference = h.app.state::<crate::clipboard_sound::Preference>();
    let mut expected = h.settings();
    assert_eq!(expected["copySound"], false);
    assert!(!preference.enabled());
    expected["copySound"] = json!(true);
    assert_eq!(h.ok("set_copy_sound", json!({ "enabled": true })), expected);
    let saved = h.saved();
    assert_eq!(saved["copySound"], true);
    assert!(preference.enabled());

    h.break_saving();
    assert!(
        !h.err("set_copy_sound", json!({ "enabled": false }))
            .is_empty()
    );
    assert!(preference.enabled());

    let reloaded = Harness::with_stored(saved);
    assert_eq!(reloaded.settings()["copySound"], true);
    assert_eq!(
        reloaded.ok("set_copy_sound", json!({ "enabled": false }))["copySound"],
        false,
    );
    assert_eq!(reloaded.saved()["copySound"], false);
    assert_eq!(reloaded.saved()["copyToClipboard"], false);
    assert_eq!(reloaded.saved()["afterCapture"], "editor");
    assert_eq!(reloaded.saved()["agentAccess"], true);
}

#[test]
fn preview_and_pending_copy_sounds_are_suppressed_during_recording_and_pause() {
    for paused_at in [None, Some(1)] {
        let h = Harness::new();
        let app = h.app.handle();
        let before_start = crate::record::playback_ticket(app).unwrap();
        crate::record::mark_test_recording(app, paused_at);
        assert!(crate::record::playback_ticket(app).is_none());
        assert!(!crate::record::playback_current(app, before_start));
        assert_eq!(
            h.err("preview_copy_sound", json!({})),
            "The copy sound is unavailable while recording.",
        );
    }
}

#[test]
fn recording_start_cancels_an_output_drain() {
    let h = Harness::new();
    let app = h.app.handle();
    let ticket = crate::record::playback_ticket(app).unwrap();
    let (begin, started) = std::sync::mpsc::channel();
    let (finish, ended) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        scope.spawn(move || {
            begin.send(()).unwrap();
            let played = crate::record::wait_for_playback(app, ticket, Duration::from_secs(10));
            finish.send(played).unwrap();
        });
        started.recv().unwrap();
        crate::record::mark_test_recording(app, None);
        assert!(!ended.recv_timeout(Duration::from_secs(3)).unwrap());
    });
}

#[test]
fn set_preferences_without_ai_keeps_the_ai_settings() {
    let h = Harness::new();
    let before = h.settings()["ai"].clone();
    let settings = h.ok(
        "set_preferences",
        json!({ "preferences": { "afterCapture": "nothing", "copyToClipboard": false } }),
    );
    assert_eq!(settings["afterCapture"], "nothing");
    assert_eq!(settings["copyToClipboard"], false);
    assert_eq!(settings["ai"], before);
    let saved = h.saved();
    assert_eq!(saved["afterCapture"], "nothing");
    assert_eq!(saved["copyToClipboard"], false);
    assert_eq!(saved["ai"]["enabled"], false);
}

#[test]
fn set_preferences_saves_ai_settings_left_off() {
    let h = Harness::new();
    let settings = h.ok(
        "set_preferences",
        json!({ "preferences": {
            "afterCapture": "editor",
            "copyToClipboard": true,
            "ai": {
                "enabled": false,
                "provider": "endpoint",
                "endpoint": "http://localhost:1234/v1/",
                "model": "  vision  ",
            },
        } }),
    );
    let ai = &settings["ai"];
    assert_eq!(ai["enabled"], false);
    assert_eq!(ai["endpoint"], "http://localhost:1234/v1");
    assert_eq!(ai["model"], "vision");
    assert_eq!(h.saved()["ai"]["endpoint"], "http://localhost:1234/v1");
}

#[test]
fn set_preferences_refuses_invalid_preferences() {
    let h = Harness::new();
    // Refused before describing could turn on.
    assert_eq!(
        h.err(
            "set_preferences",
            json!({ "preferences": {
                "afterCapture": "editor",
                "copyToClipboard": true,
                "ai": { "enabled": true, "provider": "endpoint", "endpoint": "ftp://x", "model": "m" },
            } }),
        ),
        "The AI endpoint must start with http:// or https://, not `ftp://x`."
    );
    assert_eq!(
        h.err(
            "set_preferences",
            json!({ "preferences": {
                "afterCapture": "editor",
                "copyToClipboard": true,
                "ai": { "enabled": true, "provider": "endpoint", "endpoint": "http://x", "model": " " },
            } }),
        ),
        "Choose an AI model."
    );
    assert_invalid_arg(
        &h.err(
            "set_preferences",
            json!({ "preferences": { "afterCapture": "sideways", "copyToClipboard": true } }),
        ),
        "set_preferences",
        "preferences",
    );
    let settings = h.settings();
    assert_eq!(settings["afterCapture"], "quickAccess");
    assert_eq!(settings["ai"]["enabled"], false);
    assert!(!h.settings_file().exists());
}

#[test]
fn set_appearance_saves_within_the_limits() {
    let h = Harness::new();
    let settings = h.ok(
        "set_appearance",
        json!({ "appearance": {
            "textScale": 200,
            "hubScale": 10,
            "popupCorner": "topLeft",
            "popupSeconds": 600,
        } }),
    );
    assert_eq!(
        settings["appearance"],
        json!({ "textScale": 130, "hubScale": 85, "popupCorner": "topLeft", "popupSeconds": 60 })
    );
    assert_eq!(h.saved()["appearance"], settings["appearance"]);
    assert_eq!(h.settings()["appearance"], settings["appearance"]);
}

#[test]
fn set_appearance_refuses_an_unknown_corner() {
    let h = Harness::new();
    assert_invalid_arg(
        &h.err(
            "set_appearance",
            json!({ "appearance": { "popupCorner": "middle" } }),
        ),
        "set_appearance",
        "appearance",
    );
    h.break_saving();
    assert!(
        !h.err(
            "set_appearance",
            json!({ "appearance": { "textScale": 90 } })
        )
        .is_empty()
    );
    assert_eq!(h.settings()["appearance"]["textScale"], 110);
}

#[test]
fn step_text_size_steps_and_resets() {
    let h = Harness::new();
    let bigger = h.ok("step_text_size", json!({ "step": "bigger" }));
    assert_eq!(bigger["appearance"]["textScale"], 115);
    assert_eq!(h.saved()["appearance"]["textScale"], 115);
    let smaller = h.ok("step_text_size", json!({ "step": "smaller" }));
    assert_eq!(smaller["appearance"]["textScale"], 110);
    h.ok("step_text_size", json!({ "step": "smaller" }));
    let reset = h.ok("step_text_size", json!({ "step": "reset" }));
    assert_eq!(reset["appearance"]["textScale"], 110);
    assert_eq!(h.saved()["appearance"]["textScale"], 110);
}

#[test]
fn step_text_size_stops_at_the_largest_size() {
    let h = Harness::new();
    h.ok(
        "set_appearance",
        json!({ "appearance": { "textScale": 130 } }),
    );
    // Nothing changes, so nothing is saved: a broken save goes unnoticed.
    h.break_saving();
    let settings = h.ok("step_text_size", json!({ "step": "bigger" }));
    assert_eq!(settings["appearance"]["textScale"], 130);
}

#[test]
fn step_text_size_refuses_an_unknown_step() {
    let h = Harness::new();
    assert_invalid_arg(
        &h.err("step_text_size", json!({ "step": "huge" })),
        "step_text_size",
        "step",
    );
    h.break_saving();
    assert!(
        !h.err("step_text_size", json!({ "step": "bigger" }))
            .is_empty()
    );
    assert_eq!(h.settings()["appearance"]["textScale"], 110);
}

#[test]
fn set_recording_saves_the_recording_settings() {
    let h = Harness::new();
    let settings = h.ok(
        "set_recording",
        json!({ "recording": {
            "format": "gif",
            "fps": 60,
            "countdown": 3,
            "microphone": "",
            "camera": "cam-1",
            "webcamShape": "rounded",
            "source": "screen",
        } }),
    );
    let recording = &settings["recording"];
    assert_eq!(recording["format"], "gif");
    assert_eq!(recording["fps"], 60);
    assert_eq!(recording["countdown"], 3);
    assert_eq!(recording["microphone"], Value::Null);
    assert_eq!(recording["camera"], "cam-1");
    assert_eq!(recording["webcamShape"], "squircle");
    assert_eq!(recording["source"], "screen");
    assert_eq!(h.saved()["recording"], *recording);
}

#[test]
fn set_recording_refuses_unsupported_settings() {
    let h = Harness::new();
    assert_eq!(
        h.err("set_recording", json!({ "recording": { "fps": 24 } })),
        "recordings can be 30 or 60 fps, not 24"
    );
    assert_eq!(
        h.err("set_recording", json!({ "recording": { "countdown": 7 } })),
        "a recording can count down 0, 3, 5 or 10 seconds, not 7"
    );
    assert_invalid_arg(
        &h.err("set_recording", json!({ "recording": { "format": "avi" } })),
        "set_recording",
        "recording",
    );
    assert_eq!(h.settings()["recording"]["fps"], 30);
    assert!(!h.settings_file().exists());
}

#[test]
fn set_retention_saves_how_long_items_are_kept() {
    let h = Harness::new();
    let settings = h.ok(
        "set_retention",
        json!({ "retention": { "image": 30, "video": 7, "removal": "permanent" } }),
    );
    assert_eq!(
        settings["retention"],
        json!({ "image": 30, "gif": null, "video": 7, "removal": "permanent" })
    );
    assert_eq!(h.saved()["retention"], settings["retention"]);
}

#[test]
fn set_retention_keeps_items_at_least_a_day() {
    let h = Harness::new();
    assert_eq!(
        h.err("set_retention", json!({ "retention": { "gif": 0 } })),
        "items are kept for at least a day"
    );
    assert_invalid_arg(
        &h.err(
            "set_retention",
            json!({ "retention": { "removal": "shred" } }),
        ),
        "set_retention",
        "retention",
    );
    assert_eq!(h.settings()["retention"]["gif"], Value::Null);
    assert!(!h.settings_file().exists());
}

#[test]
fn set_show_in_dock_saves_the_choice() {
    let h = Harness::new();
    let settings = h.ok("set_show_in_dock", json!({ "enabled": false }));
    assert_eq!(settings["showInDock"], false);
    assert_eq!(h.saved()["showInDock"], false);
    assert_invalid_arg(
        &h.err("set_show_in_dock", json!({ "enabled": "yes" })),
        "set_show_in_dock",
        "enabled",
    );
    h.break_saving();
    assert!(
        !h.err("set_show_in_dock", json!({ "enabled": true }))
            .is_empty()
    );
    assert_eq!(h.settings()["showInDock"], false);
}

#[test]
fn set_last_export_folder_keeps_the_chosen_absolute_path() {
    let h = Harness::new();
    let folder = json!(h.dir.path().join("exports"));
    let settings = h.ok("set_last_export_folder", json!({ "folder": folder }));
    assert_eq!(settings["lastExportFolder"], folder);
    assert_eq!(h.saved()["lastExportFolder"], folder);
    assert!(
        !h.err("set_last_export_folder", json!({ "folder": "relative" }))
            .is_empty()
    );
    assert_eq!(h.settings()["lastExportFolder"], folder);
}

#[test]
fn set_agent_access_saves_the_switch() {
    let h = Harness::new();
    let settings = h.ok("set_agent_access", json!({ "enabled": true }));
    assert_eq!(settings["agentAccess"], true);
    assert_eq!(h.saved()["agentAccess"], true);
    assert_invalid_arg(
        &h.err("set_agent_access", json!({})),
        "set_agent_access",
        "enabled",
    );
    h.break_saving();
    assert!(
        !h.err("set_agent_access", json!({ "enabled": false }))
            .is_empty()
    );
    assert_eq!(h.settings()["agentAccess"], true);
}

// get/set_editor_preferences, set_backdrop_presets, set_favorite_colors,
// set_auto_backdrop, set_show_pointer and dismiss_ai_notice

#[test]
fn editor_preferences_round_trip() {
    let h = Harness::new();
    assert_eq!(h.ok("get_editor_preferences", json!({})), json!({}));
    let preferences = json!({
        "color": "#ff0000",
        "tool": "arrow",
        "widths": { "arrow": 4, "text": 24 },
        "fill": true,
        "blurMode": "blur",
        "backdrop": { "kind": "gradient" },
    });
    let saved = h.ok(
        "set_editor_preferences",
        json!({ "preferences": preferences }),
    );
    assert_eq!(saved, preferences);
    assert_eq!(h.ok("get_editor_preferences", json!({})), preferences);
    assert_eq!(h.saved()["editor"], preferences);
}

#[test]
fn set_editor_preferences_keeps_what_settings_owns() {
    let h = Harness::new();
    h.ok("set_auto_backdrop", json!({ "enabled": true }));
    h.ok("set_favorite_colors", json!({ "colors": ["#123456"] }));
    let saved = h.ok(
        "set_editor_preferences",
        json!({ "preferences": {
            "tool": "rect",
            "autoBackdrop": false,
            "favoriteColors": [],
        } }),
    );
    assert_eq!(
        saved,
        json!({ "tool": "rect", "autoBackdrop": true, "favoriteColors": ["#123456"] })
    );
}

#[test]
fn set_editor_preferences_refuses_invalid_preferences() {
    let h = Harness::new();
    assert_invalid_arg(
        &h.err(
            "set_editor_preferences",
            json!({ "preferences": { "widths": { "arrow": -1 } } }),
        ),
        "set_editor_preferences",
        "preferences",
    );
    h.break_saving();
    assert!(
        !h.err(
            "set_editor_preferences",
            json!({ "preferences": { "tool": "arrow" } }),
        )
        .is_empty()
    );
    assert_eq!(h.ok("get_editor_preferences", json!({})), json!({}));
}

#[test]
fn set_backdrop_presets_keeps_presets_with_a_backdrop() {
    let h = Harness::new();
    let kept = h.ok(
        "set_backdrop_presets",
        json!({ "presets": [
            { "id": "a", "name": "Sunset", "backdrop": { "kind": "gradient" } },
            { "id": "b", "name": "Broken", "backdrop": "not an object" },
        ] }),
    );
    assert_eq!(
        kept,
        json!([{ "id": "a", "name": "Sunset", "backdrop": { "kind": "gradient" } }])
    );
    assert_eq!(h.settings()["editor"]["backdropPresets"], kept);
    assert_eq!(h.saved()["editor"]["backdropPresets"], kept);
}

#[test]
fn set_backdrop_presets_refuses_a_preset_without_a_name() {
    let h = Harness::new();
    assert_invalid_arg(
        &h.err(
            "set_backdrop_presets",
            json!({ "presets": [{ "id": "a", "backdrop": {} }] }),
        ),
        "set_backdrop_presets",
        "presets",
    );
    h.break_saving();
    assert!(
        !h.err("set_backdrop_presets", json!({ "presets": [] }))
            .is_empty()
    );
}

#[test]
fn set_favorite_colors_keeps_distinct_hex_colours() {
    let h = Harness::new();
    let kept = h.ok(
        "set_favorite_colors",
        json!({ "colors": ["#FF0000", "red", "#ff0000", "#00ff00", "#12345"] }),
    );
    assert_eq!(kept, json!(["#ff0000", "#00ff00"]));
    assert_eq!(h.settings()["editor"]["favoriteColors"], kept);
    assert_eq!(h.saved()["editor"]["favoriteColors"], kept);
}

#[test]
fn set_favorite_colors_refuses_a_colour_that_is_not_a_list() {
    let h = Harness::new();
    assert_invalid_arg(
        &h.err("set_favorite_colors", json!({ "colors": "red" })),
        "set_favorite_colors",
        "colors",
    );
    h.break_saving();
    assert!(
        !h.err("set_favorite_colors", json!({ "colors": ["#000000"] }))
            .is_empty()
    );
}

#[test]
fn set_auto_backdrop_saves_the_switch() {
    let h = Harness::new();
    let settings = h.ok("set_auto_backdrop", json!({ "enabled": true }));
    assert_eq!(settings["editor"]["autoBackdrop"], true);
    assert_eq!(h.saved()["editor"]["autoBackdrop"], true);
    assert_invalid_arg(
        &h.err("set_auto_backdrop", json!({ "enabled": 1 })),
        "set_auto_backdrop",
        "enabled",
    );
    h.break_saving();
    assert!(
        !h.err("set_auto_backdrop", json!({ "enabled": false }))
            .is_empty()
    );
    assert_eq!(h.settings()["editor"]["autoBackdrop"], true);
}

#[test]
fn set_show_pointer_saves_the_switch() {
    let h = Harness::new();
    let settings = h.ok("set_show_pointer", json!({ "enabled": true }));
    assert_eq!(settings["editor"]["showPointer"], true);
    assert_eq!(h.saved()["editor"]["showPointer"], true);
    assert_invalid_arg(
        &h.err("set_show_pointer", json!({})),
        "set_show_pointer",
        "enabled",
    );
    h.break_saving();
    assert!(
        !h.err("set_show_pointer", json!({ "enabled": false }))
            .is_empty()
    );
    assert_eq!(h.settings()["editor"]["showPointer"], true);
}

#[test]
fn dismiss_ai_notice_clears_the_notice() {
    // Describing stays off: only the notice is pending.
    let h = Harness::with_stored(json!({ "ai": { "noticePending": true } }));
    assert_eq!(h.settings()["ai"]["noticePending"], true);
    let settings = h.ok("dismiss_ai_notice", json!({}));
    assert_eq!(settings["ai"]["noticePending"], false);
    assert_eq!(settings["ai"]["enabled"], false);
    assert_eq!(h.saved()["ai"]["noticePending"], false);
}

#[test]
fn dismiss_ai_notice_without_a_notice_writes_nothing() {
    let h = Harness::new();
    let settings = h.ok("dismiss_ai_notice", json!({}));
    assert_eq!(settings["ai"]["noticePending"], false);
    assert!(!h.settings_file().exists());
}

#[test]
fn dismiss_ai_notice_reports_a_failed_save() {
    let h = Harness::with_stored(json!({ "ai": { "noticePending": true } }));
    h.break_saving();
    assert!(!h.err("dismiss_ai_notice", json!({})).is_empty());
    assert_eq!(h.settings()["ai"]["noticePending"], true);
}

// The Library: captures and sidecars seeded in the save folder

/// When the seeded invoice was captured, as its `meta.json` says.
const INVOICE_CAPTURED_AT: &str = "2020-01-02T03:04:05+00:00";
/// [`INVOICE_CAPTURED_AT`] in milliseconds since the Unix epoch.
const INVOICE_CAPTURED_MS: i64 = 1_577_934_245_000;

/// The items [`Harness::seed`] put in the Library.
struct Seeded {
    /// The save folder, as the Library spells its paths.
    folder: PathBuf,
    /// `invoice.png`: 8 × 6 with a `meta.json` (Firefox, "Quarterly
    /// report", captured in 2020 at a scale of 2), OCR text and an AI
    /// description.
    invoice: i64,
    /// `plain.png`: 8 × 6, no sidecars, waiting for OCR.
    plain: i64,
    /// `recordings/clip.gif`: a GIF recording.
    clip: i64,
}

impl Seeded {
    fn originals(&self) -> PathBuf {
        self.folder.join(ORIGINALS_DIR)
    }

    fn invoice_path(&self) -> PathBuf {
        self.originals().join("invoice.png")
    }

    fn plain_path(&self) -> PathBuf {
        self.originals().join("plain.png")
    }
}

/// The OCR lines seeded for the invoice, as `library_words` sends them.
fn invoice_lines() -> Value {
    json!([{
        "text": "Total 42",
        "x": 1, "y": 2, "width": 6, "height": 2,
        "words": [
            { "text": "Total", "x": 1, "y": 2, "width": 3, "height": 2 },
            { "text": "42", "x": 5, "y": 2, "width": 2, "height": 2 },
        ],
    }])
}

impl Harness {
    /// Writes two captures, a sidecar and a GIF recording into the save
    /// folder, indexes them as a rescan does, and stores OCR text and an
    /// AI description for the invoice as the queues would.
    fn seed(&self) -> Seeded {
        let folder = self.default_save_folder();
        let originals = folder.join(ORIGINALS_DIR);
        fs::create_dir_all(&originals).unwrap();
        write_png(&originals.join("invoice.png"), 8, 6);
        fs::write(
            capture::meta_path(&originals.join("invoice.png")),
            json!({
                "version": 1,
                "capturedAt": INVOICE_CAPTURED_AT,
                "mode": "region",
                "app": "Firefox",
                "windowTitle": "Quarterly report",
                "width": 8,
                "height": 6,
                "scaleFactor": 2.0,
            })
            .to_string(),
        )
        .unwrap();
        write_png(&originals.join("plain.png"), 8, 6);
        let recordings = folder.join(RECORDINGS_DIR);
        fs::create_dir_all(&recordings).unwrap();
        RgbaImage::new(4, 4)
            .save(recordings.join("clip.gif"))
            .unwrap();

        let library = self.app.state::<LibraryState>();
        let report = library.rescan(&folder, None).expect("the rescan");
        assert_eq!(report.added, 3);
        let folder = fs::canonicalize(&folder).unwrap();
        let id = |path: PathBuf| {
            library
                .lock()
                .id_for_path(&path)
                .unwrap()
                .unwrap_or_else(|| panic!("{} is in the Library", path.display()))
        };
        let seeded = Seeded {
            invoice: id(folder.join(ORIGINALS_DIR).join("invoice.png")),
            plain: id(folder.join(ORIGINALS_DIR).join("plain.png")),
            clip: id(folder.join(RECORDINGS_DIR).join("clip.gif")),
            folder,
        };
        let lines: Vec<OcrLine> = serde_json::from_value(invoice_lines()).unwrap();
        let mut library = library.lock();
        library.set_ocr_lines(seeded.invoice, &lines).unwrap();
        library
            .set_ai_description(
                seeded.invoice,
                &AiDescription {
                    description: "An invoice in a browser.".into(),
                    category: "receipt".into(),
                    tags: vec!["receipt".into(), "paper".into()],
                },
                "test-model",
            )
            .unwrap();
        seeded
    }

    /// The shot `id` as `library_list` sends it.
    fn listed(&self, id: i64) -> Value {
        let page = self.ok("library_list", json!({ "offset": 0, "limit": MAX_PAGE }));
        page["shots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|shot| shot["id"] == id)
            .unwrap_or_else(|| panic!("shot {id} is not listed"))
            .clone()
    }

    /// Opens the mock webview as the editor of `capture`.
    fn edit(&self, capture: &Path) {
        self.app
            .state::<EditorState>()
            .insert(LABEL, capture.to_owned());
    }
}

/// Writes a blank `width` × `height` PNG at `path`.
fn write_png(path: &Path, width: u32, height: u32) {
    RgbaImage::new(width, height).save(path).unwrap();
}

/// `width` × `height` PNG bytes, as a page sends a drawn image.
fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut png = std::io::Cursor::new(Vec::new());
    RgbaImage::new(width, height)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    png.into_inner()
}

/// The size of the image in `bytes`.
fn dimensions(bytes: &[u8]) -> (u32, u32) {
    let image = image::load_from_memory(bytes).expect("an image");
    (image.width(), image.height())
}

/// A path as the commands send it.
fn path_json(path: &Path) -> Value {
    json!(path.to_string_lossy())
}

/// Fails unless `message` starts with `prefix`.
fn assert_starts_with(message: &str, prefix: &str) {
    assert!(
        message.starts_with(prefix),
        "expected a message starting with {prefix:?}, got: {message}"
    );
}

const NO_SHOT: &str = "no capture with id 999 in the library";
const NOT_A_RECORDING: &str = "That works on screenshots, not recordings.";

// library_list, library_set_tags, library_remove_ai_tag, library_set_keep
// and library_set_notes

#[test]
fn library_list_returns_the_shot_shape() {
    let h = Harness::new();
    let seeded = h.seed();
    let page = h.ok("library_list", json!({ "offset": 0, "limit": 50 }));
    assert_eq!(keys(&page), ["offset", "shots", "total"]);
    assert_eq!(page["offset"], 0);
    assert_eq!(page["total"], 3);
    let shots = page["shots"].as_array().unwrap();
    assert_eq!(shots.len(), 3);
    // Newest first: the invoice was captured in 2020.
    let invoice = &shots[2];
    assert_eq!(invoice["id"], seeded.invoice);
    assert_eq!(
        keys(invoice),
        [
            "aiCategory",
            "aiDescription",
            "aiTags",
            "app",
            "bytes",
            "capturedAt",
            "durationMs",
            "editedAt",
            "fileName",
            "height",
            "id",
            "keep",
            "kind",
            "mode",
            "notes",
            "path",
            "tags",
            "thumbPath",
            "thumbStale",
            "width",
            "windowTitle",
        ]
    );
    let path = seeded.invoice_path();
    assert_eq!(invoice["kind"], "image");
    assert_eq!(invoice["path"], path_json(&path));
    assert_eq!(invoice["fileName"], "invoice.png");
    let thumb = seeded.folder.join(THUMBS_DIR).join("invoice.png");
    assert_eq!(invoice["thumbPath"], path_json(&thumb));
    assert!(thumb.is_file());
    assert_eq!(invoice["capturedAt"], INVOICE_CAPTURED_MS);
    assert_eq!(invoice["mode"], "region");
    assert_eq!(invoice["app"], "Firefox");
    assert_eq!(invoice["windowTitle"], "Quarterly report");
    assert_eq!(
        (&invoice["width"], &invoice["height"]),
        (&json!(8), &json!(6))
    );
    assert_eq!(invoice["bytes"], fs::metadata(&path).unwrap().len());
    assert_eq!(invoice["durationMs"], Value::Null);
    assert_eq!(invoice["tags"], json!([]));
    assert_eq!(invoice["notes"], "");
    assert_eq!(invoice["aiDescription"], "An invoice in a browser.");
    assert_eq!(invoice["aiCategory"], "receipt");
    assert_eq!(invoice["aiTags"], json!(["paper", "receipt"]));
    assert_eq!(invoice["keep"], false);
    assert_eq!(invoice["editedAt"], Value::Null);
    assert_eq!(invoice["thumbStale"], false);

    let plain = h.listed(seeded.plain);
    assert_eq!(plain["mode"], Value::Null);
    assert_eq!(plain["app"], Value::Null);
    assert_eq!(plain["aiTags"], json!([]));
    let clip = h.listed(seeded.clip);
    assert_eq!(clip["kind"], "gif");
    assert_eq!(clip["fileName"], "clip.gif");
    assert_eq!((&clip["width"], &clip["height"]), (&json!(4), &json!(4)));
}

#[test]
fn library_list_pages_through_the_shots() {
    let h = Harness::new();
    let seeded = h.seed();
    let page = h.ok("library_list", json!({ "offset": 2, "limit": 1 }));
    assert_eq!(page["offset"], 2);
    assert_eq!(page["total"], 3);
    assert_eq!(page["shots"].as_array().unwrap().len(), 1);
    assert_eq!(page["shots"][0]["id"], seeded.invoice);
    // A limit of 0 still lists one.
    let page = h.ok("library_list", json!({ "offset": 0, "limit": 0 }));
    assert_eq!(page["shots"].as_array().unwrap().len(), 1);
    let past = h.ok("library_list", json!({ "offset": 10, "limit": 5 }));
    assert_eq!(past["shots"], json!([]));
    assert_eq!(past["total"], 3);
    assert_invalid_arg(
        &h.err("library_list", json!({ "offset": 0 })),
        "library_list",
        "limit",
    );
    assert_invalid_arg(
        &h.err("library_list", json!({ "offset": -1, "limit": 5 })),
        "library_list",
        "offset",
    );
}

#[test]
fn library_set_tags_replaces_the_tags() {
    let h = Harness::new();
    let seeded = h.seed();
    let shot = h.ok(
        "library_set_tags",
        json!({ "id": seeded.plain, "tags": [" Work ", "work", "", "Q1   report"] }),
    );
    assert_eq!(shot["id"], seeded.plain);
    assert_eq!(shot["tags"], json!(["Q1 report", "Work"]));
    assert_eq!(h.listed(seeded.plain)["tags"], shot["tags"]);
    let cleared = h.ok(
        "library_set_tags",
        json!({ "id": seeded.plain, "tags": [] }),
    );
    assert_eq!(cleared["tags"], json!([]));
    assert_eq!(
        h.err("library_set_tags", json!({ "id": 999, "tags": ["x"] })),
        NO_SHOT
    );
    assert_invalid_arg(
        &h.err(
            "library_set_tags",
            json!({ "id": seeded.plain, "tags": "x" }),
        ),
        "library_set_tags",
        "tags",
    );
}

#[test]
fn library_remove_ai_tag_takes_one_ai_tag_off() {
    let h = Harness::new();
    let seeded = h.seed();
    let shot = h.ok(
        "library_remove_ai_tag",
        json!({ "id": seeded.invoice, "tag": "RECEIPT" }),
    );
    assert_eq!(shot["aiTags"], json!(["paper"]));
    assert_eq!(shot["aiDescription"], "An invoice in a browser.");
    assert_eq!(h.listed(seeded.invoice)["aiTags"], json!(["paper"]));
    // A tag it does not have changes nothing.
    let same = h.ok(
        "library_remove_ai_tag",
        json!({ "id": seeded.invoice, "tag": "missing" }),
    );
    assert_eq!(same["aiTags"], json!(["paper"]));
    assert_eq!(
        h.err(
            "library_remove_ai_tag",
            json!({ "id": 999, "tag": "paper" })
        ),
        NO_SHOT
    );
    assert_invalid_arg(
        &h.err("library_remove_ai_tag", json!({ "id": seeded.invoice })),
        "library_remove_ai_tag",
        "tag",
    );
}

#[test]
fn library_set_keep_stars_and_unstars() {
    let h = Harness::new();
    let seeded = h.seed();
    let shot = h.ok(
        "library_set_keep",
        json!({ "id": seeded.clip, "keep": true }),
    );
    assert_eq!(shot["keep"], true);
    assert_eq!(h.listed(seeded.clip)["keep"], true);
    let shot = h.ok(
        "library_set_keep",
        json!({ "id": seeded.clip, "keep": false }),
    );
    assert_eq!(shot["keep"], false);
    assert_eq!(
        h.err("library_set_keep", json!({ "id": 999, "keep": true })),
        NO_SHOT
    );
    assert_invalid_arg(
        &h.err(
            "library_set_keep",
            json!({ "id": seeded.clip, "keep": "yes" }),
        ),
        "library_set_keep",
        "keep",
    );
}

#[test]
fn library_set_notes_saves_the_notes() {
    let h = Harness::new();
    let seeded = h.seed();
    let shot = h.ok(
        "library_set_notes",
        json!({ "id": seeded.invoice, "notes": "Paid in March" }),
    );
    assert_eq!(shot["notes"], "Paid in March");
    assert_eq!(h.listed(seeded.invoice)["notes"], "Paid in March");
    assert_eq!(
        h.err("library_set_notes", json!({ "id": 999, "notes": "x" })),
        NO_SHOT
    );
    assert_invalid_arg(
        &h.err("library_set_notes", json!({ "id": "first", "notes": "x" })),
        "library_set_notes",
        "id",
    );
}

// library_rename, library_duplicate, library_delete and library_export

#[test]
fn library_rename_moves_the_file_and_its_sidecars() {
    let h = Harness::new();
    let seeded = h.seed();
    let old = seeded.invoice_path();
    let shot = h.ok(
        "library_rename",
        json!({ "id": seeded.invoice, "name": "  March invoice.PNG " }),
    );
    let new = seeded.originals().join("March invoice.png");
    assert_eq!(shot["id"], seeded.invoice);
    assert_eq!(shot["fileName"], "March invoice.png");
    assert_eq!(shot["path"], path_json(&new));
    let thumb = seeded.folder.join(THUMBS_DIR).join("March invoice.png");
    assert_eq!(shot["thumbPath"], path_json(&thumb));
    assert!(new.is_file() && !old.exists());
    assert!(capture::meta_path(&new).is_file());
    assert!(!capture::meta_path(&old).exists());
    assert!(thumb.is_file());
    assert_eq!(shot["app"], "Firefox");
    assert_eq!(h.listed(seeded.invoice)["path"], shot["path"]);

    // Its own name again changes nothing.
    let same = h.ok(
        "library_rename",
        json!({ "id": seeded.invoice, "name": "March invoice" }),
    );
    assert_eq!(same["path"], shot["path"]);
}

#[test]
fn library_rename_refuses_bad_and_taken_names() {
    let h = Harness::new();
    let seeded = h.seed();
    let rename = |name: &str| {
        h.err(
            "library_rename",
            json!({ "id": seeded.invoice, "name": name }),
        )
    };
    assert_eq!(rename("  "), "Give it a name.");
    assert_eq!(
        rename("a/b"),
        "A name can't contain / \\ : * ? \" < > | or control characters."
    );
    assert_eq!(rename(".hidden"), "A name can't start with a dot.");
    assert_eq!(rename("CON"), "Windows keeps that name for itself.");
    assert_eq!(rename(&"x".repeat(201)), "That name is too long.");
    assert_eq!(rename("plain"), "There is already a file called plain.png.");
    assert!(seeded.invoice_path().is_file());
    assert_eq!(h.listed(seeded.invoice)["fileName"], "invoice.png");
    assert_eq!(
        h.err("library_rename", json!({ "id": 999, "name": "x" })),
        NO_SHOT
    );
    assert_invalid_arg(
        &h.err("library_rename", json!({ "id": seeded.invoice })),
        "library_rename",
        "name",
    );

    fs::remove_file(seeded.plain_path()).unwrap();
    assert_eq!(
        h.err("library_rename", json!({ "id": seeded.plain, "name": "x" })),
        format!("{} no longer exists", seeded.plain_path().display())
    );
}

#[test]
fn library_duplicate_copies_the_file_tags_and_notes() {
    let h = Harness::new();
    let seeded = h.seed();
    h.ok(
        "library_set_tags",
        json!({ "id": seeded.invoice, "tags": ["work"] }),
    );
    h.ok(
        "library_set_notes",
        json!({ "id": seeded.invoice, "notes": "Paid" }),
    );
    let copy = h.ok("library_duplicate", json!({ "id": seeded.invoice }));
    let path = seeded.originals().join("invoice copy.png");
    assert_ne!(copy["id"], seeded.invoice);
    assert_eq!(copy["fileName"], "invoice copy.png");
    assert_eq!(copy["path"], path_json(&path));
    assert_eq!(copy["tags"], json!(["work"]));
    assert_eq!(copy["notes"], "Paid");
    assert_eq!(copy["capturedAt"], INVOICE_CAPTURED_MS);
    assert_eq!(copy["app"], "Firefox");
    assert!(path.is_file());
    assert!(capture::meta_path(&path).is_file());
    assert!(seeded.invoice_path().is_file());
    assert_eq!(h.library_total(), 4);

    let second = h.ok("library_duplicate", json!({ "id": seeded.invoice }));
    assert_eq!(second["fileName"], "invoice copy 2.png");
    assert_eq!(h.err("library_duplicate", json!({ "id": 999 })), NO_SHOT);
    assert_invalid_arg(
        &h.err("library_duplicate", json!({})),
        "library_duplicate",
        "id",
    );
    fs::remove_file(seeded.plain_path()).unwrap();
    assert_eq!(
        h.err("library_duplicate", json!({ "id": seeded.plain })),
        format!("{} no longer exists", seeded.plain_path().display())
    );
}

#[test]
fn library_delete_removes_the_file_its_sidecars_and_row() {
    let h = Harness::new();
    let seeded = h.seed();
    let path = seeded.invoice_path();
    let thumb = seeded.folder.join(THUMBS_DIR).join("invoice.png");
    assert!(thumb.is_file());
    assert_eq!(
        h.ok("library_delete", json!({ "id": seeded.invoice })),
        Value::Null
    );
    assert!(!path.exists());
    assert!(!capture::meta_path(&path).exists());
    assert!(!thumb.exists());
    assert_eq!(h.library_total(), 2);
    assert!(seeded.plain_path().is_file());
    assert_eq!(
        h.err("library_delete", json!({ "id": seeded.invoice })),
        format!("no capture with id {} in the library", seeded.invoice)
    );
    assert_invalid_arg(
        &h.err("library_delete", json!({ "id": null })),
        "library_delete",
        "id",
    );
}

#[test]
fn library_export_writes_the_chosen_format() {
    let h = Harness::new();
    let seeded = h.seed();
    let out = h.dir.path().join("exports");
    fs::create_dir_all(&out).unwrap();

    let jpg = out.join("invoice.jpg");
    let written = h.ok(
        "library_export",
        json!({ "id": seeded.invoice, "target": jpg.to_string_lossy() }),
    );
    assert_eq!(written, path_json(&jpg));
    let image = image::open(&jpg).expect("a JPEG");
    assert_eq!((image.width(), image.height()), (8, 6));

    // A folder gets the shot's own name, then a numbered one.
    let first = h.ok(
        "library_export",
        json!({ "id": seeded.invoice, "target": out.to_string_lossy() }),
    );
    assert_eq!(first, path_json(&out.join("invoice.png")));
    assert_eq!(
        fs::read(out.join("invoice.png")).unwrap(),
        fs::read(seeded.invoice_path()).unwrap()
    );
    let second = h.ok(
        "library_export",
        json!({ "id": seeded.invoice, "target": out.to_string_lossy() }),
    );
    assert_eq!(second, path_json(&out.join("invoice 2.png")));

    let gif = out.join("clip.gif");
    h.ok(
        "library_export",
        json!({ "id": seeded.clip, "target": gif.to_string_lossy() }),
    );
    assert_eq!(
        fs::read(&gif).unwrap(),
        fs::read(seeded.folder.join(RECORDINGS_DIR).join("clip.gif")).unwrap()
    );
}

#[test]
fn library_export_refuses_bad_targets() {
    let h = Harness::new();
    let seeded = h.seed();
    let out = h.dir.path().join("exports");
    fs::create_dir_all(&out).unwrap();
    let export = |id: i64, target: &Path| {
        h.err(
            "library_export",
            json!({ "id": id, "target": target.to_string_lossy() }),
        )
    };
    assert_eq!(
        export(seeded.invoice, &out.join("invoice.bmp")),
        "A screenshot exports as .png, .jpg or .webp: give the file one of those names."
    );
    assert_eq!(
        export(seeded.clip, &out.join("clip.mp4")),
        "A recording is exported as it is: give the file a .gif name."
    );
    let meta = capture::meta_path(&seeded.invoice_path());
    let before = fs::read(&meta).unwrap();
    assert_eq!(
        export(seeded.invoice, &meta),
        "export would overwrite the original capture; choose another file"
    );
    assert_eq!(fs::read(&meta).unwrap(), before);
    assert_eq!(export(999, &out.join("x.png")), NO_SHOT);
    assert_invalid_arg(
        &h.err("library_export", json!({ "id": seeded.invoice })),
        "library_export",
        "target",
    );
    assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
}

// library_image, library_thumbnail, library_save_thumbnail, library_text,
// library_words, library_shot_id and library_open_with_supported

#[test]
fn library_image_sends_the_original_bytes() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.bytes("library_image", json!({ "id": seeded.invoice })),
        fs::read(seeded.invoice_path()).unwrap()
    );
    assert_eq!(
        h.err("library_image", json!({ "id": seeded.clip })),
        NOT_A_RECORDING
    );
    assert_eq!(h.err("library_image", json!({ "id": 999 })), NO_SHOT);
    fs::remove_file(seeded.plain_path()).unwrap();
    assert_eq!(
        h.err("library_image", json!({ "id": seeded.plain })),
        format!("{} no longer exists", seeded.plain_path().display())
    );
}

#[test]
fn library_thumbnail_sends_the_thumbnail_png() {
    let h = Harness::new();
    let seeded = h.seed();
    let thumb = h.bytes("library_thumbnail", json!({ "id": seeded.invoice }));
    assert_eq!(dimensions(&thumb), (8, 6));
    assert_eq!(
        thumb,
        fs::read(seeded.folder.join(THUMBS_DIR).join("invoice.png")).unwrap()
    );
    // A missing thumbnail is made again.
    let plain_thumb = seeded.folder.join(THUMBS_DIR).join("plain.png");
    fs::remove_file(&plain_thumb).unwrap();
    let made = h.bytes("library_thumbnail", json!({ "id": seeded.plain }));
    assert_eq!(dimensions(&made), (8, 6));
    assert!(plain_thumb.is_file());
    assert_eq!(h.err("library_thumbnail", json!({ "id": 999 })), NO_SHOT);

    // An edited capture's thumbnail is drawn by the Library, never made
    // from the original.
    fs::write(
        capture::annotations_path(&seeded.plain_path()),
        json!({ "version": 1, "shapes": [] }).to_string(),
    )
    .unwrap();
    fs::remove_file(&plain_thumb).unwrap();
    assert_eq!(
        h.err("library_thumbnail", json!({ "id": seeded.plain })),
        "the edited capture has no thumbnail yet"
    );
    assert!(!plain_thumb.exists());
}

/// The headers `library_save_thumbnail` reads.
fn thumbnail_headers(id: Option<i64>, edited_at: Option<i64>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(id) = id {
        headers.insert(THUMBNAIL_ID_HEADER, HeaderValue::from(id));
    }
    if let Some(edited_at) = edited_at {
        headers.insert(THUMBNAIL_EDITED_HEADER, HeaderValue::from(edited_at));
    }
    headers
}

#[test]
fn library_save_thumbnail_saves_the_drawn_thumbnail() {
    let h = Harness::new();
    let seeded = h.seed();
    // Drawn long before the edits, so the thumbnail is surely stale.
    fs::File::options()
        .write(true)
        .open(seeded.folder.join(THUMBS_DIR).join("invoice.png"))
        .and_then(|thumb| {
            thumb.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
        })
        .unwrap();
    fs::write(
        capture::annotations_path(&seeded.invoice_path()),
        json!({ "version": 1, "shapes": [{ "kind": "arrow" }] }).to_string(),
    )
    .unwrap();
    let edited_at = h.ok("library_annotations", json!({ "id": seeded.invoice }))["editedAt"]
        .as_i64()
        .expect("when the edits were saved");
    let before = h.listed(seeded.invoice);
    assert_eq!(before["editedAt"], edited_at);
    assert_eq!(before["thumbStale"], true);

    let saved = h.invoke_raw(
        "library_save_thumbnail",
        png_bytes(4, 3),
        thumbnail_headers(Some(seeded.invoice), Some(edited_at)),
    );
    assert_eq!(saved, Ok(Value::Null));
    let shot = h.listed(seeded.invoice);
    assert_eq!(shot["thumbStale"], false);
    assert_eq!(shot["editedAt"], edited_at);
    let thumb = h.bytes("library_thumbnail", json!({ "id": seeded.invoice }));
    assert_eq!(dimensions(&thumb), (4, 3));
}

#[test]
fn library_save_thumbnail_refuses_bad_requests() {
    let h = Harness::new();
    let seeded = h.seed();
    let sidecar = capture::annotations_path(&seeded.invoice_path());
    fs::write(&sidecar, json!({ "version": 1, "shapes": [] }).to_string()).unwrap();
    let edited_at = h.ok("library_annotations", json!({ "id": seeded.invoice }))["editedAt"]
        .as_i64()
        .unwrap();
    let thumb = seeded.folder.join(THUMBS_DIR).join("invoice.png");
    let before = fs::read(&thumb).unwrap();
    let save =
        |headers: HeaderMap| match h.invoke_raw("library_save_thumbnail", png_bytes(4, 3), headers)
        {
            Err(Value::String(message)) => message,
            other => panic!("library_save_thumbnail did not fail with a message: {other:?}"),
        };
    assert_eq!(
        save(thumbnail_headers(None, Some(edited_at))),
        "missing the capture's id"
    );
    assert_eq!(
        save(thumbnail_headers(Some(seeded.invoice), None)),
        "missing when the edits were saved"
    );
    assert_eq!(
        save(thumbnail_headers(Some(seeded.clip), Some(edited_at))),
        NOT_A_RECORDING
    );
    assert_eq!(save(thumbnail_headers(Some(999), Some(edited_at))), NO_SHOT);
    // Drawn from edits that were saved again since.
    assert_eq!(
        save(thumbnail_headers(
            Some(seeded.invoice),
            Some(edited_at - 1_000)
        )),
        "the capture was edited again while it was drawn"
    );
    let json_body = h.call(
        "library_save_thumbnail",
        InvokeBody::Json(json!({})),
        thumbnail_headers(Some(seeded.invoice), Some(edited_at)),
    );
    assert_eq!(json_body.err(), Some(json!("expected image bytes")));
    assert_eq!(fs::read(&thumb).unwrap(), before);
}

#[test]
fn library_text_says_how_far_ocr_has_got() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.ok("library_text", json!({ "id": seeded.invoice })),
        json!({ "state": "read", "text": "Total 42" })
    );
    assert_eq!(
        h.ok("library_text", json!({ "id": seeded.plain })),
        json!({ "state": "waiting" })
    );
    h.app
        .state::<LibraryState>()
        .lock()
        .mark_ocr_failed(seeded.plain)
        .unwrap();
    assert_eq!(
        h.ok("library_text", json!({ "id": seeded.plain })),
        json!({ "state": "failed" })
    );
    // A recording is never read: it has no text.
    assert_eq!(
        h.ok("library_text", json!({ "id": seeded.clip })),
        json!({ "state": "read", "text": "" })
    );
    assert_eq!(h.err("library_text", json!({ "id": 999 })), NO_SHOT);
}

#[test]
fn library_words_sends_the_word_boxes() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.ok("library_words", json!({ "id": seeded.invoice })),
        invoice_lines()
    );
    assert_eq!(
        h.ok("library_words", json!({ "id": seeded.plain })),
        Value::Null
    );
    assert_eq!(
        h.ok("library_words", json!({ "id": seeded.clip })),
        Value::Null
    );
    assert_eq!(h.err("library_words", json!({ "id": 999 })), NO_SHOT);
}

#[test]
fn library_shot_id_finds_a_capture_by_path() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.ok(
            "library_shot_id",
            json!({ "path": seeded.invoice_path().to_string_lossy() })
        ),
        seeded.invoice
    );
    // Another spelling of the same file.
    let roundabout = seeded
        .originals()
        .join("..")
        .join(ORIGINALS_DIR)
        .join("plain.png");
    assert_eq!(
        h.ok(
            "library_shot_id",
            json!({ "path": roundabout.to_string_lossy() })
        ),
        seeded.plain
    );
    let unknown = seeded.originals().join("unknown.png");
    assert_eq!(
        h.ok(
            "library_shot_id",
            json!({ "path": unknown.to_string_lossy() })
        ),
        Value::Null
    );
    assert_invalid_arg(
        &h.err("library_shot_id", json!({})),
        "library_shot_id",
        "path",
    );
}

#[test]
fn library_open_with_supported_says_whether_a_chooser_exists() {
    let h = Harness::new();
    assert_eq!(
        h.ok("library_open_with_supported", json!({})),
        cfg!(any(target_os = "linux", target_os = "windows"))
    );
}

// library_search, library_sidebar, library_filter_options and
// library_storage

#[test]
fn library_search_finds_words_with_a_snippet() {
    let h = Harness::new();
    let seeded = h.seed();
    let page = h.ok(
        "library_search",
        json!({ "query": { "text": "quart" }, "offset": 0, "limit": 20 }),
    );
    assert_eq!(keys(&page), ["hits", "offset", "total"]);
    assert_eq!(page["total"], 1);
    assert_eq!(page["offset"], 0);
    let hit = &page["hits"][0];
    assert_eq!(keys(hit), ["field", "shot", "snippet"]);
    assert_eq!(hit["shot"]["id"], seeded.invoice);
    assert_eq!(hit["shot"]["aiTags"], json!(["paper", "receipt"]));
    assert_eq!(hit["field"], "windowTitle");
    let parts = hit["snippet"].as_array().unwrap();
    assert!(parts.iter().all(|part| keys(part) == ["hit", "text"]));
    assert!(
        parts
            .iter()
            .any(|part| part["hit"] == true && part["text"] == "Quarterly"),
        "the snippet marks the match: {parts:?}"
    );

    let by_text = h.ok(
        "library_search",
        json!({ "query": { "text": "total" }, "offset": 0, "limit": 20 }),
    );
    assert_eq!(by_text["hits"][0]["field"], "text");
    let none = h.ok(
        "library_search",
        json!({ "query": { "text": "zebra" }, "offset": 0, "limit": 20 }),
    );
    assert_eq!(none, json!({ "hits": [], "offset": 0, "total": 0 }));
}

#[test]
fn library_search_filters_without_words() {
    let h = Harness::new();
    let seeded = h.seed();
    let search = |query: Value| {
        h.ok(
            "library_search",
            json!({ "query": query, "offset": 0, "limit": 20 }),
        )
    };
    let ids = |page: &Value| -> Vec<Value> {
        page["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["shot"]["id"].clone())
            .collect()
    };
    let all = search(json!({}));
    assert_eq!(all["total"], 3);
    assert_eq!(all["hits"][0]["field"], Value::Null);
    assert_eq!(all["hits"][0]["snippet"], json!([]));
    assert_eq!(
        ids(&search(json!({ "kind": "recording" }))),
        [json!(seeded.clip)]
    );
    assert_eq!(search(json!({ "kind": "image" }))["total"], 2);
    assert_eq!(
        ids(&search(json!({ "app": "Firefox" }))),
        [json!(seeded.invoice)]
    );
    assert_eq!(
        ids(&search(json!({ "tag": "RECEIPT" }))),
        [json!(seeded.invoice)]
    );
    assert_eq!(
        ids(&search(json!({ "category": "receipt" }))),
        [json!(seeded.invoice)]
    );
    assert_eq!(
        ids(&search(json!({ "to": INVOICE_CAPTURED_MS + 1 }))),
        [json!(seeded.invoice)]
    );
    assert_eq!(
        search(json!({ "from": INVOICE_CAPTURED_MS + 1 }))["total"],
        2
    );
    assert_invalid_arg(
        &h.err(
            "library_search",
            json!({ "query": { "from": "yesterday" }, "offset": 0, "limit": 20 }),
        ),
        "library_search",
        "query",
    );
    assert_invalid_arg(
        &h.err("library_search", json!({ "query": {}, "offset": 0 })),
        "library_search",
        "limit",
    );
}

#[test]
fn library_sidebar_counts_apps_and_tags() {
    let h = Harness::new();
    assert_eq!(
        h.ok("library_sidebar", json!({})),
        json!({ "total": 0, "recordings": 0, "apps": [], "tags": [] })
    );
    let seeded = h.seed();
    h.ok(
        "library_set_tags",
        json!({ "id": seeded.plain, "tags": ["paper", "work"] }),
    );
    assert_eq!(
        h.ok("library_sidebar", json!({})),
        json!({
            "total": 3,
            "recordings": 1,
            "apps": [{ "name": "Firefox", "count": 1 }],
            "tags": [
                { "name": "paper", "count": 2 },
                { "name": "receipt", "count": 1 },
                { "name": "work", "count": 1 },
            ],
        })
    );
}

#[test]
fn library_filter_options_lists_apps_tags_and_categories() {
    let h = Harness::new();
    assert_eq!(
        h.ok("library_filter_options", json!({})),
        json!({ "apps": [], "tags": [], "categories": [] })
    );
    let seeded = h.seed();
    h.ok(
        "library_set_tags",
        json!({ "id": seeded.plain, "tags": ["Work", "Paper"] }),
    );
    let options = h.ok("library_filter_options", json!({}));
    assert_eq!(options["apps"], json!(["Firefox"]));
    assert_eq!(options["categories"], json!(["receipt"]));
    let tags: Vec<String> = options["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tag| tag.as_str().unwrap().to_lowercase())
        .collect();
    assert_eq!(tags, ["paper", "receipt", "work"]);
}

#[test]
fn library_storage_sizes_each_kind_and_what_is_due() {
    let h = Harness::new();
    let seeded = h.seed();
    let size = |path: &Path| fs::metadata(path).unwrap().len();
    let invoice = size(&seeded.invoice_path());
    let plain = size(&seeded.plain_path());
    let clip = size(&seeded.folder.join(RECORDINGS_DIR).join("clip.gif"));

    let storage = h.ok("library_storage", json!({}));
    assert_eq!(keys(&storage), ["disk", "due", "gif", "image", "video"]);
    assert_eq!(
        storage["image"],
        json!({ "count": 2, "bytes": invoice + plain })
    );
    assert_eq!(storage["gif"], json!({ "count": 1, "bytes": clip }));
    assert_eq!(storage["video"], json!({ "count": 0, "bytes": 0 }));
    assert_eq!(keys(&storage["disk"]), ["free", "total"]);
    assert!(storage["disk"]["total"].as_u64().unwrap() > 0);
    // Kept forever by default: nothing is due.
    let nothing = json!({ "count": 0, "bytes": 0 });
    assert_eq!(
        storage["due"],
        json!({ "image": nothing, "gif": nothing, "video": nothing })
    );

    // Kept a day: only the invoice, from 2020, is old enough.
    let day = h.ok(
        "library_storage",
        json!({ "candidate": { "image": 1, "gif": 1 } }),
    );
    assert_eq!(day["due"]["image"], json!({ "count": 1, "bytes": invoice }));
    assert_eq!(day["due"]["gif"], nothing);
    // Starred, it is protected.
    h.ok(
        "library_set_keep",
        json!({ "id": seeded.invoice, "keep": true }),
    );
    let kept = h.ok("library_storage", json!({ "candidate": { "image": 1 } }));
    assert_eq!(kept["due"]["image"], nothing);
    // Zero days, as Purge now asks, is every unprotected item.
    let purge = h.ok("library_storage", json!({ "candidate": { "image": 0 } }));
    assert_eq!(purge["due"]["image"], json!({ "count": 1, "bytes": plain }));
    // Tagged, it is protected too.
    h.ok(
        "library_set_tags",
        json!({ "id": seeded.plain, "tags": ["work"] }),
    );
    let tagged = h.ok("library_storage", json!({ "candidate": { "image": 0 } }));
    assert_eq!(tagged["due"]["image"], nothing);

    assert_invalid_arg(
        &h.err(
            "library_storage",
            json!({ "candidate": { "removal": "shred" } }),
        ),
        "library_storage",
        "candidate",
    );
}

// editor_info, editor_save_annotations and library_annotations

#[test]
fn editor_info_describes_the_editors_capture() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.err("editor_info", json!({})),
        "this window is not an editor"
    );
    h.edit(&seeded.invoice_path());
    assert_eq!(
        h.ok("editor_info", json!({})),
        json!({
            "path": seeded.invoice_path().to_string_lossy(),
            "fileName": "invoice.png",
            "annotations": null,
            "scaleFactor": 2.0,
            "pointer": null,
        })
    );
    h.edit(&seeded.plain_path());
    let plain = h.ok("editor_info", json!({}));
    assert_eq!(plain["fileName"], "plain.png");
    assert_eq!(plain["scaleFactor"], Value::Null);
}

#[test]
fn editor_save_annotations_round_trips_the_sidecar() {
    let h = Harness::new();
    let seeded = h.seed();
    let path = seeded.invoice_path();
    let original = fs::read(&path).unwrap();
    h.edit(&path);
    assert_eq!(
        h.ok("library_annotations", json!({ "id": seeded.invoice })),
        json!({ "annotations": null, "scaleFactor": 2.0, "editedAt": null })
    );
    let annotations = json!({
        "version": 1,
        "shapes": [{ "kind": "arrow", "from": [1, 1], "to": [5, 4] }],
        "backdrop": { "kind": "gradient" },
    });
    assert_eq!(
        h.ok(
            "editor_save_annotations",
            json!({ "annotations": annotations })
        ),
        Value::Null
    );
    let sidecar = capture::annotations_path(&path);
    let saved: Value = serde_json::from_str(&fs::read_to_string(&sidecar).unwrap()).unwrap();
    assert_eq!(saved, annotations);
    assert_eq!(h.ok("editor_info", json!({}))["annotations"], annotations);

    let read = h.ok("library_annotations", json!({ "id": seeded.invoice }));
    assert_eq!(keys(&read), ["annotations", "editedAt", "scaleFactor"]);
    assert_eq!(read["annotations"], annotations);
    assert_eq!(read["scaleFactor"], 2.0);
    let edited_at = read["editedAt"].as_i64().expect("when it was saved");
    let shot = h.listed(seeded.invoice);
    assert_eq!(shot["editedAt"], edited_at);
    // The original is never written.
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn editor_save_annotations_refuses_an_unknown_sidecar() {
    let h = Harness::new();
    let seeded = h.seed();
    let path = seeded.invoice_path();
    assert_eq!(
        h.err(
            "editor_save_annotations",
            json!({ "annotations": { "version": 1, "shapes": [] } }),
        ),
        "this window is not an editor"
    );
    h.edit(&path);
    assert_eq!(
        h.err(
            "editor_save_annotations",
            json!({ "annotations": { "version": 2, "shapes": [] } }),
        ),
        "unsupported annotations version 2"
    );
    assert_eq!(
        h.err(
            "editor_save_annotations",
            json!({ "annotations": { "version": 1 } }),
        ),
        "annotations need a `shapes` list"
    );
    assert_invalid_arg(
        &h.err("editor_save_annotations", json!({})),
        "editor_save_annotations",
        "annotations",
    );
    assert!(!capture::annotations_path(&path).exists());
}

#[test]
fn library_annotations_refuses_what_it_cannot_read() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.err("library_annotations", json!({ "id": seeded.clip })),
        NOT_A_RECORDING
    );
    assert_eq!(h.err("library_annotations", json!({ "id": 999 })), NO_SHOT);
    // A broken sidecar is an error, so the original is never passed off as
    // edited, and the editor refuses it too.
    let sidecar = capture::annotations_path(&seeded.invoice_path());
    fs::write(&sidecar, "{ not json").unwrap();
    let unparsable = format!("could not parse {}: ", sidecar.display());
    assert_starts_with(
        &h.err("library_annotations", json!({ "id": seeded.invoice })),
        &unparsable,
    );
    h.edit(&seeded.invoice_path());
    assert_starts_with(&h.err("editor_info", json!({})), &unparsable);
    fs::write(&sidecar, json!({ "version": 9, "shapes": [] }).to_string()).unwrap();
    assert_eq!(
        h.err("library_annotations", json!({ "id": seeded.invoice })),
        "unsupported annotations version 9"
    );
}

// editor_image, editor_asset_image, editor_backdrop_image,
// editor_add_image_file and save_backdrop_preset_image

#[test]
fn editor_image_sends_the_original_bytes() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.err("editor_image", json!({})),
        "this window is not an editor"
    );
    h.edit(&seeded.invoice_path());
    assert_eq!(
        h.bytes("editor_image", json!({})),
        fs::read(seeded.invoice_path()).unwrap()
    );
    fs::remove_file(seeded.invoice_path()).unwrap();
    assert_starts_with(
        &h.err("editor_image", json!({})),
        &format!("could not open {}: ", seeded.invoice_path().display()),
    );
}

#[test]
fn editor_add_image_file_copies_the_image_beside_the_capture() {
    let h = Harness::new();
    let seeded = h.seed();
    let dropped = h.dir.path().join("logo.png");
    write_png(&dropped, 3, 2);
    assert_eq!(
        h.err(
            "editor_add_image_file",
            json!({ "path": dropped.to_string_lossy() })
        ),
        "this window is not an editor"
    );
    h.edit(&seeded.invoice_path());
    let name = h.ok(
        "editor_add_image_file",
        json!({ "path": dropped.to_string_lossy() }),
    );
    let name = name.as_str().expect("the copy's file name");
    assert!(
        name.starts_with("logo-") && name.ends_with(".png"),
        "unexpected name {name}"
    );
    let assets = capture::assets_dir(&seeded.invoice_path());
    assert_eq!(
        fs::read(assets.join(name)).unwrap(),
        fs::read(&dropped).unwrap()
    );
    assert_eq!(
        h.bytes("editor_asset_image", json!({ "name": name })),
        fs::read(&dropped).unwrap()
    );

    let text = h.dir.path().join("notes.txt");
    fs::write(&text, "not an image").unwrap();
    assert_eq!(
        h.err(
            "editor_add_image_file",
            json!({ "path": text.to_string_lossy() })
        ),
        "the image must be a PNG, JPEG, WebP or GIF image"
    );
    let missing = h.dir.path().join("missing.png");
    assert_starts_with(
        &h.err(
            "editor_add_image_file",
            json!({ "path": missing.to_string_lossy() }),
        ),
        &format!("could not open {}: ", missing.display()),
    );
    assert_eq!(fs::read_dir(&assets).unwrap().count(), 1);
}

#[test]
fn editor_asset_image_reads_only_the_captures_own_images() {
    let h = Harness::new();
    let seeded = h.seed();
    assert_eq!(
        h.err("editor_asset_image", json!({ "name": "logo.png" })),
        "this window is not an editor"
    );
    h.edit(&seeded.invoice_path());
    assert_eq!(
        h.err("editor_asset_image", json!({ "name": "missing.png" })),
        "the added image is missing"
    );
    let outside = format!("..{}plain.png", std::path::MAIN_SEPARATOR);
    assert_eq!(
        h.err("editor_asset_image", json!({ "name": outside })),
        "not an image added to this capture"
    );
    assert_eq!(
        h.err(
            "editor_asset_image",
            json!({ "name": seeded.plain_path().to_string_lossy() })
        ),
        "not an image added to this capture"
    );
    assert_invalid_arg(
        &h.err("editor_asset_image", json!({})),
        "editor_asset_image",
        "name",
    );
}

#[test]
fn editor_backdrop_image_reads_only_images() {
    let h = Harness::new();
    let picked = h.dir.path().join("backdrop.png");
    write_png(&picked, 5, 5);
    assert_eq!(
        h.bytes(
            "editor_backdrop_image",
            json!({ "path": picked.to_string_lossy() })
        ),
        fs::read(&picked).unwrap()
    );
    let text = h.dir.path().join("backdrop.txt");
    fs::write(&text, "not an image").unwrap();
    assert_eq!(
        h.err(
            "editor_backdrop_image",
            json!({ "path": text.to_string_lossy() })
        ),
        "the backdrop image must be a PNG, JPEG, WebP or GIF image"
    );
    let missing = h.dir.path().join("missing.png");
    assert_starts_with(
        &h.err(
            "editor_backdrop_image",
            json!({ "path": missing.to_string_lossy() }),
        ),
        &format!("could not open {}: ", missing.display()),
    );
}

#[test]
fn save_backdrop_preset_image_refuses_a_missing_file() {
    // Only the failure is tested: a success would write into the real app
    // data folder, which the mock runtime does not redirect.
    let h = Harness::new();
    let missing = h.dir.path().join("missing.png");
    let message = h.err(
        "save_backdrop_preset_image",
        json!({ "path": missing.to_string_lossy() }),
    );
    // Refused when the source is read, before anything is written.
    assert_starts_with(&message, &format!("could not open {}: ", missing.display()));
}

/// Tauri's reply to a command no handler has.
fn not_found(cmd: &str) -> String {
    format!("Command {cmd} not found")
}

#[test]
fn an_unknown_command_is_not_found() {
    let h = Harness::new();
    assert_eq!(
        h.err("no_such_command", json!({})),
        not_found("no_such_command")
    );
}

#[test]
fn byte_commands_reach_their_handler() {
    let h = Harness::new();
    // Called without the window, capture or arguments they need, each byte
    // command fails with its own message. Sent to the typed handler instead,
    // it would come back as not found.
    for cmd in crate::BYTE_COMMANDS {
        let message = h.err(cmd, json!({}));
        assert_ne!(
            message,
            not_found(cmd),
            "{cmd} was not routed to its handler"
        );
    }
}
