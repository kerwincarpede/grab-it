//! User settings, stored as `settings.json` in the app data directory.
//!
//! Missing keys fall back to their defaults and unknown keys are ignored, so
//! settings files from other versions still load.

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::hotkeys::Hotkeys;

pub const SETTINGS_FILE: &str = "settings.json";
pub const DEFAULT_FOLDER_NAME: &str = "Grab-it";

/// What Grab-it shows once a capture is saved.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AfterCapture {
    /// A small floating preview in the corner with Copy, Annotate, Pin…
    #[default]
    QuickAccess,
    /// Straight into the annotation editor.
    Editor,
    /// Nothing: the capture is saved (and copied) silently.
    Nothing,
}

/// The choices on the Settings window's Capture section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub after_capture: AfterCapture,
    /// Copy every capture to the clipboard as it is saved.
    pub copy_to_clipboard: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            after_capture: AfterCapture::default(),
            copy_to_clipboard: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Where new captures are saved. Holds `originals/` and `thumbs/`.
    pub save_folder: PathBuf,
    /// Global hotkeys for region, window and screen captures.
    pub hotkeys: Hotkeys,
    #[serde(flatten)]
    pub preferences: Preferences,
}

impl Settings {
    /// The defaults: captures go to `<pictures>/Grab-it`, with the
    /// platform's default hotkeys.
    pub fn defaults(pictures_dir: &Path) -> Self {
        Self {
            save_folder: pictures_dir.join(DEFAULT_FOLDER_NAME),
            hotkeys: Hotkeys::default(),
            preferences: Preferences::default(),
        }
    }
}

/// The file's shape on disk, with every key optional.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    save_folder: Option<PathBuf>,
    hotkeys: Option<StoredHotkeys>,
    after_capture: Option<AfterCapture>,
    copy_to_clipboard: Option<bool>,
}

/// Hotkeys on disk; a missing or empty one keeps its default.
#[derive(Debug, Default, Deserialize)]
struct StoredHotkeys {
    region: Option<String>,
    window: Option<String>,
    screen: Option<String>,
    text: Option<String>,
    colour: Option<String>,
}

impl StoredHotkeys {
    fn merge_onto(self, defaults: Hotkeys) -> Hotkeys {
        let pick = |stored: Option<String>, default: String| {
            stored
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default)
        };
        Hotkeys {
            region: pick(self.region, defaults.region),
            window: pick(self.window, defaults.window),
            screen: pick(self.screen, defaults.screen),
            text: pick(self.text, defaults.text),
            colour: pick(self.colour, defaults.colour),
        }
    }
}

impl StoredSettings {
    fn merge_onto(self, defaults: Settings) -> Settings {
        Settings {
            save_folder: self
                .save_folder
                .filter(|folder| !folder.as_os_str().is_empty())
                .unwrap_or(defaults.save_folder),
            hotkeys: match self.hotkeys {
                Some(stored) => stored.merge_onto(defaults.hotkeys),
                None => defaults.hotkeys,
            },
            preferences: Preferences {
                after_capture: self
                    .after_capture
                    .unwrap_or(defaults.preferences.after_capture),
                copy_to_clipboard: self
                    .copy_to_clipboard
                    .unwrap_or(defaults.preferences.copy_to_clipboard),
            },
        }
    }
}

#[derive(Debug)]
pub enum SettingsError {
    Io(io::Error),
    Parse(serde_json::Error),
    Invalid(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "{err}"),
            Self::Parse(err) => write!(f, "settings file is not valid: {err}"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SettingsError {}

impl From<io::Error> for SettingsError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for SettingsError {
    fn from(err: serde_json::Error) -> Self {
        Self::Parse(err)
    }
}

/// Reads settings from `path`. A missing file gives `defaults`.
pub fn load(path: &Path, defaults: Settings) -> Result<Settings, SettingsError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(defaults),
        Err(err) => return Err(err.into()),
    };
    let stored: StoredSettings = serde_json::from_str(&text)?;
    Ok(stored.merge_onto(defaults))
}

/// Writes settings to `path`, creating its directory. The file is replaced
/// in one step, so a crash never leaves it half written.
pub fn save(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut json = serde_json::to_string_pretty(settings)?;
    json.push('\n');
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Checks a save folder typed or picked by the user.
pub fn validate_save_folder(input: &str) -> Result<PathBuf, SettingsError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(SettingsError::Invalid("Choose a save folder.".into()));
    }
    let folder = PathBuf::from(trimmed);
    if !folder.is_absolute() {
        return Err(SettingsError::Invalid(format!(
            "The save folder must be a full path, not `{trimmed}`."
        )));
    }
    Ok(folder)
}

/// The current settings and the file they live in.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    current: Settings,
    /// No settings file existed when the store was opened.
    first_run: bool,
}

impl SettingsStore {
    /// Loads settings from `path`. An unreadable file is reported and the
    /// defaults are used; the file is only overwritten on the next change.
    pub fn open(path: PathBuf, defaults: Settings) -> Self {
        let first_run = !path.exists();
        let current = load(&path, defaults.clone()).unwrap_or_else(|err| {
            eprintln!(
                "Grab-it: using default settings, could not read {}: {err}",
                path.display()
            );
            defaults
        });
        Self {
            path,
            current,
            first_run,
        }
    }

    /// True the first time Grab-it runs for this user, until
    /// [`Self::finish_first_run`] has written the settings file.
    pub fn is_first_run(&self) -> bool {
        self.first_run
    }

    /// Writes the settings file so the next launch is not a first run.
    pub fn finish_first_run(&mut self) -> Result<(), SettingsError> {
        if self.first_run {
            save(&self.path, &self.current)?;
            self.first_run = false;
        }
        Ok(())
    }

    pub fn get(&self) -> &Settings {
        &self.current
    }

    /// Changes where new captures are saved. The folder is created if needed.
    /// Existing captures are not moved.
    pub fn set_save_folder(&mut self, input: &str) -> Result<Settings, SettingsError> {
        let folder = validate_save_folder(input)?;
        fs::create_dir_all(&folder)?;
        let next = Settings {
            save_folder: folder,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes what happens after a capture.
    pub fn set_preferences(&mut self, preferences: Preferences) -> Result<Settings, SettingsError> {
        let next = Settings {
            preferences,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes the capture hotkeys after checking them. Registering them is
    /// up to the caller.
    pub fn set_hotkeys(&mut self, hotkeys: &Hotkeys) -> Result<Settings, SettingsError> {
        let hotkeys = hotkeys.validated().map_err(SettingsError::Invalid)?;
        let next = Settings {
            hotkeys,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn defaults(dir: &TempDir) -> Settings {
        Settings::defaults(&dir.path().join("Pictures"))
    }

    fn settings_path(dir: &TempDir) -> PathBuf {
        dir.path().join("data").join(SETTINGS_FILE)
    }

    #[test]
    fn default_save_folder_is_grab_it_in_pictures() {
        let settings = Settings::defaults(Path::new("/home/me/Pictures"));
        assert_eq!(
            settings.save_folder,
            PathBuf::from("/home/me/Pictures/Grab-it")
        );
    }

    #[test]
    fn missing_file_loads_defaults() {
        let dir = TempDir::new().unwrap();
        let loaded = load(&settings_path(&dir), defaults(&dir)).unwrap();
        assert_eq!(loaded, defaults(&dir));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let settings = Settings {
            save_folder: dir.path().join("Shots"),
            hotkeys: Hotkeys {
                region: "Ctrl+Shift+R".into(),
                ..Hotkeys::default()
            },
            preferences: Preferences {
                after_capture: AfterCapture::Nothing,
                copy_to_clipboard: false,
            },
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap(), settings);
    }

    #[test]
    fn saved_file_uses_camel_case_keys() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        save(&path, &defaults(&dir)).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(value.get("saveFolder").is_some(), "{value}");
        assert!(value["hotkeys"].get("region").is_some(), "{value}");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn missing_and_unknown_keys_are_tolerated() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"futureKey": 3}"#).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap(), defaults(&dir));
    }

    #[test]
    fn empty_save_folder_falls_back_to_default() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"saveFolder": ""}"#).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap(), defaults(&dir));
    }

    #[test]
    fn corrupt_file_is_an_error_and_the_store_uses_defaults() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(matches!(
            load(&path, defaults(&dir)),
            Err(SettingsError::Parse(_))
        ));
        let store = SettingsStore::open(path.clone(), defaults(&dir));
        assert_eq!(store.get(), &defaults(&dir));
        // The unreadable file is left alone until the user changes a setting.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn set_save_folder_creates_the_folder_and_persists() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        let folder = dir.path().join("New").join("Captures");

        let updated = store.set_save_folder(folder.to_str().unwrap()).unwrap();

        assert_eq!(updated.save_folder, folder);
        assert!(folder.is_dir());
        assert_eq!(store.get().save_folder, folder);
        assert_eq!(load(&path, defaults(&dir)).unwrap().save_folder, folder);
    }

    #[test]
    fn set_save_folder_trims_whitespace() {
        let dir = TempDir::new().unwrap();
        let mut store = SettingsStore::open(settings_path(&dir), defaults(&dir));
        let folder = dir.path().join("Trimmed");
        let input = format!("  {}  ", folder.display());
        assert_eq!(store.set_save_folder(&input).unwrap().save_folder, folder);
    }

    #[test]
    fn set_save_folder_rejects_empty_and_relative_paths() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));

        for input in ["", "   ", "relative/folder"] {
            assert!(matches!(
                store.set_save_folder(input),
                Err(SettingsError::Invalid(_))
            ));
        }
        assert_eq!(store.get(), &defaults(&dir));
        assert!(!path.exists(), "a rejected change must not write settings");
    }

    #[test]
    fn missing_and_empty_hotkeys_keep_their_defaults() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"hotkeys": {"region": "Ctrl+Shift+R", "window": " "}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.hotkeys.region, "Ctrl+Shift+R");
        assert_eq!(loaded.hotkeys.window, Hotkeys::default().window);
        assert_eq!(loaded.hotkeys.screen, Hotkeys::default().screen);
    }

    #[test]
    fn set_hotkeys_persists_and_keeps_the_folder() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        let hotkeys = Hotkeys {
            screen: " Ctrl+Shift+F ".into(),
            ..Hotkeys::default()
        };

        let updated = store.set_hotkeys(&hotkeys).unwrap();

        assert_eq!(updated.hotkeys.screen, "Ctrl+Shift+F");
        assert_eq!(updated.save_folder, defaults(&dir).save_folder);
        assert_eq!(load(&path, defaults(&dir)).unwrap(), updated);
    }

    #[test]
    fn preferences_default_to_quick_access_and_copying() {
        let dir = TempDir::new().unwrap();
        let settings = defaults(&dir);
        assert_eq!(
            settings.preferences.after_capture,
            AfterCapture::QuickAccess
        );
        assert!(settings.preferences.copy_to_clipboard);
        // A settings file from before these existed keeps the defaults.
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"saveFolder": "/data/shots"}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.preferences, Preferences::default());
        assert_eq!(loaded.save_folder, PathBuf::from("/data/shots"));
    }

    #[test]
    fn set_preferences_persists_beside_the_other_settings() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        let updated = store
            .set_preferences(Preferences {
                after_capture: AfterCapture::Editor,
                copy_to_clipboard: false,
            })
            .unwrap();
        assert_eq!(updated.preferences.after_capture, AfterCapture::Editor);
        assert_eq!(load(&path, defaults(&dir)).unwrap(), updated);
        // Flattened into the top level, in the frontend's spelling.
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["afterCapture"], "editor");
        assert_eq!(json["copyToClipboard"], false);
        assert!(json["hotkeys"]["text"].is_string());
    }

    #[test]
    fn the_first_run_ends_once_the_file_is_written() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        assert!(store.is_first_run());
        store.finish_first_run().unwrap();
        assert!(!store.is_first_run());
        assert_eq!(load(&path, defaults(&dir)).unwrap(), defaults(&dir));

        // The next launch finds the file: not a first run.
        let again = SettingsStore::open(path, defaults(&dir));
        assert!(!again.is_first_run());
    }

    #[test]
    fn set_hotkeys_rejects_duplicates_without_writing() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        let hotkeys = Hotkeys {
            window: Hotkeys::default().region,
            ..Hotkeys::default()
        };
        assert!(matches!(
            store.set_hotkeys(&hotkeys),
            Err(SettingsError::Invalid(_))
        ));
        assert!(!path.exists());
    }
}
