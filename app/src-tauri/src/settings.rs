//! User settings, stored as `settings.json` in the app data directory.
//!
//! Missing keys fall back to their defaults and unknown keys are ignored, so
//! settings files from other versions still load.

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";
pub const DEFAULT_FOLDER_NAME: &str = "Grab-it";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Where new captures are saved. Holds `originals/` and `thumbs/`.
    pub save_folder: PathBuf,
}

impl Settings {
    /// The defaults: captures go to `<pictures>/Grab-it`.
    pub fn defaults(pictures_dir: &Path) -> Self {
        Self {
            save_folder: pictures_dir.join(DEFAULT_FOLDER_NAME),
        }
    }
}

/// The file's shape on disk, with every key optional.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    save_folder: Option<PathBuf>,
}

impl StoredSettings {
    fn merge_onto(self, defaults: Settings) -> Settings {
        Settings {
            save_folder: self
                .save_folder
                .filter(|folder| !folder.as_os_str().is_empty())
                .unwrap_or(defaults.save_folder),
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
}

impl SettingsStore {
    /// Loads settings from `path`. An unreadable file is reported and the
    /// defaults are used; the file is only overwritten on the next change.
    pub fn open(path: PathBuf, defaults: Settings) -> Self {
        let current = load(&path, defaults.clone()).unwrap_or_else(|err| {
            eprintln!(
                "Grab-it: using default settings, could not read {}: {err}",
                path.display()
            );
            defaults
        });
        Self { path, current }
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
}
