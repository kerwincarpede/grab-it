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
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets},
    webview::InvokeRequest,
};
use tempfile::TempDir;

use crate::{
    capture::ORIGINALS_DIR,
    keychain::MemoryKeyStore,
    library::{self, LibraryState, MAX_PAGE},
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

    /// Calls `cmd` with `args` as a page would.
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: APP_URL.parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        };
        get_ipc_response(&self.webview, request)
            .map(|body| body.deserialize::<Value>().expect("a JSON reply"))
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
