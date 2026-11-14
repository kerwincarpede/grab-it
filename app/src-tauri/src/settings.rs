//! User settings, stored as `settings.json` in the app data directory.
//!
//! Missing keys fall back to their defaults and unknown keys are ignored, so
//! settings files from other versions still load.

use std::{
    collections::BTreeMap,
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

/// The default OpenAI-compatible endpoint: a local Ollama.
pub const DEFAULT_AI_ENDPOINT: &str = "http://localhost:11434/v1";
/// The default vision model, as Ollama names it.
pub const DEFAULT_AI_MODEL: &str = "qwen2.5vl:7b";

/// Who describes captures. Mirrors `AiProvider` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiProvider {
    /// The user's own `claude` CLI, run headlessly (see `ai_cli.rs`).
    ClaudeCode,
    /// An OpenAI-compatible `/chat/completions` endpoint.
    Endpoint,
}

/// Reads a stored provider leniently: one this version does not know, from
/// a newer Grab-it, is read as none rather than costing the settings file.
fn lenient_provider<'de, D>(deserializer: D) -> Result<Option<AiProvider>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// How captures are described by a vision model (see `ai.rs`). Off by
/// default: nothing leaves the machine until the user turns it on, or
/// Grab-it turns it on once because Claude Code is installed (see
/// [`SettingsStore::enable_claude_code`]). Mirrors `AiPreferences` in
/// src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub enabled: bool,
    /// Who describes captures. None until a provider was picked or Grab-it
    /// picked one; it then works as [`AiProvider::Endpoint`], which is what
    /// settings from before providers existed used.
    #[serde(deserialize_with = "lenient_provider")]
    pub provider: Option<AiProvider>,
    /// An OpenAI-compatible base URL; `/chat/completions` is appended.
    pub endpoint: String,
    pub model: String,
    /// Sent as `Authorization: Bearer <key>` when set.
    pub api_key: Option<String>,
    /// Captures that existed when describing was turned on are skipped.
    pub new_captures_only: bool,
    /// Grab-it turned describing on by itself and the Library has not yet
    /// said so. Only Grab-it sets it; dismissing the notice clears it.
    pub notice_pending: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: None,
            endpoint: DEFAULT_AI_ENDPOINT.into(),
            model: DEFAULT_AI_MODEL.into(),
            api_key: None,
            new_captures_only: true,
            notice_pending: false,
        }
    }
}

/// The model Claude Code is asked for, by its alias.
pub const CLAUDE_CODE_MODEL: &str = "haiku";

impl AiSettings {
    /// The provider describing uses: an unset one is the endpoint.
    pub fn provider(&self) -> AiProvider {
        self.provider.unwrap_or(AiProvider::Endpoint)
    }

    /// Whether the user never turned describing on: no provider was ever
    /// picked and it is off. Settings with describing on but no provider
    /// are an endpoint user's from before providers existed.
    pub fn never_enabled(&self) -> bool {
        self.provider.is_none() && !self.enabled
    }

    /// The model recorded beside each description.
    pub fn model_label(&self) -> String {
        match self.provider() {
            AiProvider::ClaudeCode => format!("claude-code/{CLAUDE_CODE_MODEL}"),
            AiProvider::Endpoint => self.model.clone(),
        }
    }

    /// Trims the fields, drops a trailing `/` from the endpoint and an empty
    /// key. Turned on with an endpoint, the endpoint must be an http(s) URL
    /// and the model set; the CLI providers use neither.
    pub fn validated(&self) -> Result<Self, SettingsError> {
        let endpoint = self.endpoint.trim().trim_end_matches('/').to_owned();
        let model = self.model.trim().to_owned();
        let api_key = self
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        if self.enabled && self.provider() == AiProvider::Endpoint {
            let lower = endpoint.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return Err(SettingsError::Invalid(format!(
                    "The AI endpoint must start with http:// or https://, not `{endpoint}`."
                )));
            }
            if model.is_empty() {
                return Err(SettingsError::Invalid("Choose an AI model.".into()));
            }
        }
        Ok(Self {
            enabled: self.enabled,
            provider: self.provider,
            endpoint,
            model,
            api_key,
            new_captures_only: self.new_captures_only,
            notice_pending: self.notice_pending,
        })
    }
}

/// The choices on the Settings window's Capture and AI sections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub after_capture: AfterCapture,
    /// Copy every capture to the clipboard as it is saved.
    pub copy_to_clipboard: bool,
    /// Describing captures with a vision model.
    #[serde(default)]
    pub ai: AiSettings,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            after_capture: AfterCapture::default(),
            copy_to_clipboard: true,
            ai: AiSettings::default(),
        }
    }
}

/// What `set_preferences` takes: [`Preferences`], where a missing `ai`
/// keeps the current AI settings (frontends from before it existed).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesUpdate {
    pub after_capture: AfterCapture,
    pub copy_to_clipboard: bool,
    #[serde(default)]
    pub ai: Option<AiSettings>,
}

impl PreferencesUpdate {
    fn apply_to(self, current: &Preferences) -> Preferences {
        Preferences {
            after_capture: self.after_capture,
            copy_to_clipboard: self.copy_to_clipboard,
            ai: self.ai.unwrap_or_else(|| current.ai.clone()),
        }
    }
}

impl From<Preferences> for PreferencesUpdate {
    fn from(preferences: Preferences) -> Self {
        Self {
            after_capture: preferences.after_capture,
            copy_to_clipboard: preferences.copy_to_clipboard,
            ai: Some(preferences.ai),
        }
    }
}

/// The annotation editor's remembered choices, saved as they change and
/// restored when it opens. Every key is optional: the editor uses its own
/// default for anything missing, and checks each value it reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreferences {
    /// The drawing colour, as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The last tool picked, by its frontend name (`arrow`, `rect`…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Each tool's own width in pixels: the stroke width, or the font size
    /// for text and the badge size for steps.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub widths: BTreeMap<String, u32>,
    /// Rectangles and ellipses are filled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<bool>,
    /// Text sits on a coloured pill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_background: Option<bool>,
    /// `pixelate` or `blur`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur_mode: Option<String>,
    /// The last backdrop picked, as the editor writes it in a sidecar. Kept
    /// as JSON: the editor checks each field when it reads it back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<serde_json::Value>,
    /// Frame captures that have no annotations yet with `backdrop`. Set
    /// from the Settings window; the editor's own saves keep it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_backdrop: Option<bool>,
}

impl EditorPreferences {
    /// Reads the stored `editor` section key by key. A key with the wrong
    /// type is dropped on its own, so one bad value never costs the rest of
    /// the settings file.
    fn from_stored(value: serde_json::Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        let flag = |key: &str| value.get(key).and_then(serde_json::Value::as_bool);
        let widths = value
            .get("widths")
            .and_then(serde_json::Value::as_object)
            .map(|widths| {
                widths
                    .iter()
                    .filter_map(|(tool, width)| {
                        let width = u32::try_from(width.as_u64()?).ok()?;
                        Some((tool.clone(), width))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            color: text("color"),
            tool: text("tool"),
            widths,
            fill: flag("fill"),
            text_background: flag("textBackground"),
            blur_mode: text("blurMode"),
            backdrop: value
                .get("backdrop")
                .filter(|backdrop| backdrop.is_object())
                .cloned(),
            auto_backdrop: flag("autoBackdrop"),
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
    /// The annotation editor's remembered style and tool.
    pub editor: EditorPreferences,
}

impl Settings {
    /// The defaults: captures go to `<pictures>/Grab-it`, with the
    /// platform's default hotkeys.
    pub fn defaults(pictures_dir: &Path) -> Self {
        Self {
            save_folder: pictures_dir.join(DEFAULT_FOLDER_NAME),
            hotkeys: Hotkeys::default(),
            preferences: Preferences::default(),
            editor: EditorPreferences::default(),
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
    ai: Option<AiSettings>,
    /// Read leniently by [`EditorPreferences::from_stored`].
    editor: Option<serde_json::Value>,
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
                ai: self.ai.unwrap_or(defaults.preferences.ai),
            },
            editor: match self.editor {
                Some(stored) => EditorPreferences::from_stored(stored),
                None => defaults.editor,
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

    /// Changes what happens after a capture and how captures are described.
    pub fn set_preferences(
        &mut self,
        update: impl Into<PreferencesUpdate>,
    ) -> Result<Settings, SettingsError> {
        let mut preferences = update.into().apply_to(&self.current.preferences);
        preferences.ai = preferences.ai.validated()?;
        // The notice belongs to Grab-it: a Settings window opened before it
        // was set, or dismissed, must not bring it back or clear it.
        preferences.ai.notice_pending = self.current.preferences.ai.notice_pending;
        let next = Settings {
            preferences,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Turns describing on with Claude Code, for new captures only, and
    /// asks for the one-time notice, when the user never turned describing
    /// on. Finding `claude` is up to the caller. Returns the AI settings
    /// from before, when they changed; once a provider is set this never
    /// changes anything again.
    pub fn enable_claude_code(&mut self) -> Result<Option<AiSettings>, SettingsError> {
        let before = self.current.preferences.ai.clone();
        if !before.never_enabled() {
            return Ok(None);
        }
        let mut next = self.current.clone();
        next.preferences.ai = AiSettings {
            enabled: true,
            provider: Some(AiProvider::ClaudeCode),
            new_captures_only: true,
            notice_pending: true,
            ..before.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(Some(before))
    }

    /// Clears the one-time notice that describing was turned on.
    pub fn dismiss_ai_notice(&mut self) -> Result<Settings, SettingsError> {
        if self.current.preferences.ai.notice_pending {
            let mut next = self.current.clone();
            next.preferences.ai.notice_pending = false;
            save(&self.path, &next)?;
            self.current = next;
        }
        Ok(self.current.clone())
    }

    /// Remembers the annotation editor's choices. Auto-apply belongs to the
    /// Settings window, so the editor's saves never change it.
    pub fn set_editor_preferences(
        &mut self,
        editor: EditorPreferences,
    ) -> Result<EditorPreferences, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                auto_backdrop: self.current.editor.auto_backdrop,
                ..editor
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.editor.clone())
    }

    /// Turns framing new captures with the last backdrop on or off,
    /// keeping the rest of the editor's choices.
    pub fn set_auto_backdrop(&mut self, enabled: bool) -> Result<Settings, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                auto_backdrop: Some(enabled),
                ..self.current.editor.clone()
            },
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
                ai: AiSettings {
                    enabled: true,
                    model: "llava".into(),
                    api_key: Some("sk-test".into()),
                    ..AiSettings::default()
                },
            },
            editor: EditorPreferences {
                color: Some("#0090ff".into()),
                ..EditorPreferences::default()
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
                ai: AiSettings::default(),
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

    #[test]
    fn ai_is_off_by_default_and_old_files_keep_it_off() {
        let dir = TempDir::new().unwrap();
        let ai = defaults(&dir).preferences.ai;
        assert!(!ai.enabled);
        assert_eq!(ai.endpoint, "http://localhost:11434/v1");
        assert_eq!(ai.model, "qwen2.5vl:7b");
        assert_eq!(ai.api_key, None);
        assert!(ai.new_captures_only);

        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"copyToClipboard": false}"#).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap().preferences.ai, ai);
        // A partial `ai` keeps the defaults for the rest.
        fs::write(&path, r#"{"ai": {"enabled": true, "model": "llava"}}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().preferences.ai;
        assert!(loaded.enabled);
        assert_eq!(loaded.model, "llava");
        assert_eq!(loaded.endpoint, "http://localhost:11434/v1");
    }

    #[test]
    fn ai_settings_serialize_in_the_frontends_spelling() {
        let dir = TempDir::new().unwrap();
        let json = serde_json::to_value(defaults(&dir)).unwrap();
        assert_eq!(
            json["ai"],
            serde_json::json!({
                "enabled": false,
                "provider": null,
                "endpoint": "http://localhost:11434/v1",
                "model": "qwen2.5vl:7b",
                "apiKey": null,
                "newCapturesOnly": true,
                "noticePending": false,
            })
        );
    }

    #[test]
    fn set_preferences_without_ai_keeps_the_current_ai_settings() {
        let dir = TempDir::new().unwrap();
        let mut store = SettingsStore::open(settings_path(&dir), defaults(&dir));
        let ai = AiSettings {
            enabled: true,
            model: "llava".into(),
            ..AiSettings::default()
        };
        store
            .set_preferences(Preferences {
                ai: ai.clone(),
                ..Preferences::default()
            })
            .unwrap();
        let update: PreferencesUpdate =
            serde_json::from_str(r#"{"afterCapture": "editor", "copyToClipboard": true}"#).unwrap();
        let updated = store.set_preferences(update).unwrap();
        assert_eq!(updated.preferences.after_capture, AfterCapture::Editor);
        assert_eq!(updated.preferences.ai, ai);
    }

    #[test]
    fn ai_settings_are_tidied_and_checked_when_on() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        let with = |ai: AiSettings| Preferences {
            ai,
            ..Preferences::default()
        };
        let updated = store
            .set_preferences(with(AiSettings {
                enabled: true,
                provider: Some(AiProvider::Endpoint),
                endpoint: " https://api.example.com/v1/ ".into(),
                model: " gpt-4o-mini ".into(),
                api_key: Some("  ".into()),
                new_captures_only: false,
                notice_pending: false,
            }))
            .unwrap();
        let ai = &updated.preferences.ai;
        assert_eq!(ai.endpoint, "https://api.example.com/v1");
        assert_eq!(ai.model, "gpt-4o-mini");
        assert_eq!(ai.api_key, None);

        for bad in [
            AiSettings {
                enabled: true,
                endpoint: "localhost:11434".into(),
                ..AiSettings::default()
            },
            AiSettings {
                enabled: true,
                model: " ".into(),
                ..AiSettings::default()
            },
        ] {
            assert!(matches!(
                store.set_preferences(with(bad)),
                Err(SettingsError::Invalid(_))
            ));
        }
        // Off, anything goes: it is not used.
        store
            .set_preferences(with(AiSettings {
                endpoint: String::new(),
                ..AiSettings::default()
            }))
            .unwrap();
    }

    #[test]
    fn the_cli_providers_need_no_endpoint_or_model() {
        let dir = TempDir::new().unwrap();
        let mut store = SettingsStore::open(settings_path(&dir), defaults(&dir));
        let updated = store
            .set_preferences(Preferences {
                ai: AiSettings {
                    enabled: true,
                    provider: Some(AiProvider::ClaudeCode),
                    endpoint: String::new(),
                    model: " ".into(),
                    ..AiSettings::default()
                },
                ..Preferences::default()
            })
            .unwrap();
        let ai = &updated.preferences.ai;
        assert_eq!(ai.provider(), AiProvider::ClaudeCode);
        assert_eq!(ai.model_label(), "claude-code/haiku");
        // The same fields are refused for an endpoint.
        assert!(matches!(
            store.set_preferences(Preferences {
                ai: AiSettings {
                    provider: Some(AiProvider::Endpoint),
                    ..ai.clone()
                },
                ..Preferences::default()
            }),
            Err(SettingsError::Invalid(_))
        ));
    }

    #[test]
    fn providers_are_read_leniently_and_default_to_the_endpoint() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let read = |text: &str| {
            fs::write(&path, text).unwrap();
            load(&path, defaults(&dir)).unwrap().preferences.ai
        };
        let claude = read(r#"{"ai": {"enabled": true, "provider": "claudeCode"}}"#);
        assert_eq!(claude.provider, Some(AiProvider::ClaudeCode));
        let old = read(r#"{"ai": {"enabled": true, "model": "llava"}}"#);
        assert_eq!(old.provider, None);
        assert_eq!(old.provider(), AiProvider::Endpoint);
        assert_eq!(old.model_label(), "llava");
        // A provider from a newer Grab-it costs neither the file nor the rest.
        let newer = read(r#"{"ai": {"enabled": true, "provider": "someday", "model": "x"}}"#);
        assert_eq!(newer.provider, None);
        assert_eq!(newer.model, "x");
        assert!(newer.enabled);
    }

    #[test]
    fn never_enabled_means_no_provider_and_off() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let never = |text: &str| {
            fs::write(&path, text).unwrap();
            load(&path, defaults(&dir))
                .unwrap()
                .preferences
                .ai
                .never_enabled()
        };
        assert!(defaults(&dir).preferences.ai.never_enabled());
        assert!(never(r#"{"copyToClipboard": true}"#));
        assert!(never(r#"{"ai": {"enabled": false, "model": "llava"}}"#));
        // An endpoint user from before providers existed is left alone.
        assert!(!never(r#"{"ai": {"enabled": true}}"#));
        // So is anyone who picked a provider, on or off.
        assert!(!never(
            r#"{"ai": {"enabled": false, "provider": "endpoint"}}"#
        ));
        assert!(!never(
            r#"{"ai": {"enabled": false, "provider": "claudeCode"}}"#
        ));
    }

    #[test]
    fn claude_code_is_turned_on_once_for_new_captures_with_a_notice() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));

        let before = store.enable_claude_code().unwrap();

        assert_eq!(before, Some(AiSettings::default()));
        let ai = load(&path, defaults(&dir)).unwrap().preferences.ai;
        assert!(ai.enabled);
        assert_eq!(ai.provider, Some(AiProvider::ClaudeCode));
        assert!(ai.new_captures_only);
        assert!(ai.notice_pending);
        // The endpoint fields are kept for whoever switches back.
        assert_eq!(ai.endpoint, DEFAULT_AI_ENDPOINT);
        assert_eq!(store.enable_claude_code().unwrap(), None);

        // Turned off afterwards, it stays off.
        store
            .set_preferences(Preferences {
                ai: AiSettings {
                    enabled: false,
                    ..ai.clone()
                },
                ..Preferences::default()
            })
            .unwrap();
        assert_eq!(store.enable_claude_code().unwrap(), None);
        assert!(!store.get().preferences.ai.enabled);
    }

    #[test]
    fn an_existing_endpoint_user_is_not_switched() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"ai": {"enabled": true, "model": "llava"}}"#).unwrap();
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        assert_eq!(store.enable_claude_code().unwrap(), None);
        assert_eq!(store.get().preferences.ai.provider, None);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"ai": {"enabled": true, "model": "llava"}}"#
        );
    }

    #[test]
    fn the_notice_is_kept_by_settings_saves_and_cleared_by_dismissing() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        store.enable_claude_code().unwrap();
        let mut stale = store.get().preferences.clone();
        stale.ai.notice_pending = false;
        stale.after_capture = AfterCapture::Editor;
        assert!(
            store
                .set_preferences(stale)
                .unwrap()
                .preferences
                .ai
                .notice_pending
        );

        let dismissed = store.dismiss_ai_notice().unwrap();
        assert!(!dismissed.preferences.ai.notice_pending);
        assert!(
            !load(&path, defaults(&dir))
                .unwrap()
                .preferences
                .ai
                .notice_pending
        );
        let mut stale = store.get().preferences.clone();
        stale.ai.notice_pending = true;
        assert!(
            !store
                .set_preferences(stale)
                .unwrap()
                .preferences
                .ai
                .notice_pending
        );
    }

    fn editor_preferences() -> EditorPreferences {
        EditorPreferences {
            color: Some("#30a46c".into()),
            tool: Some("rect".into()),
            widths: BTreeMap::from([
                ("arrow".to_owned(), 8),
                ("text".to_owned(), 48),
                ("step".to_owned(), 24),
            ]),
            fill: Some(true),
            text_background: Some(false),
            blur_mode: Some("blur".into()),
            backdrop: Some(serde_json::json!({
                "fill": "aurora", "padding": 48, "radius": 36, "shadow": true, "aspect": "16:9"
            })),
            auto_backdrop: None,
        }
    }

    #[test]
    fn editor_preferences_round_trip_beside_the_other_settings() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        store
            .set_preferences(Preferences {
                after_capture: AfterCapture::Editor,
                copy_to_clipboard: false,
                ..Preferences::default()
            })
            .unwrap();

        let saved = store.set_editor_preferences(editor_preferences()).unwrap();

        assert_eq!(saved, editor_preferences());
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor, editor_preferences());
        // The other settings are kept.
        assert_eq!(loaded.preferences.after_capture, AfterCapture::Editor);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"]["textBackground"], false);
        assert_eq!(json["editor"]["blurMode"], "blur");
        assert_eq!(json["editor"]["widths"]["text"], 48);
        assert_eq!(json["editor"]["backdrop"]["aspect"], "16:9");
    }

    #[test]
    fn a_file_without_an_editor_section_loads_empty_editor_preferences() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"saveFolder": "/data/shots", "afterCapture": "nothing"}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor, EditorPreferences::default());
        assert_eq!(loaded.preferences.after_capture, AfterCapture::Nothing);
    }

    #[test]
    fn empty_editor_preferences_write_an_empty_section() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        save(&path, &defaults(&dir)).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"], serde_json::json!({}));
    }

    #[test]
    fn partial_and_mistyped_editor_keys_keep_the_rest() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r##"{
                "hotkeys": {"region": "Ctrl+Shift+R"},
                "editor": {
                    "color": "#e5484d",
                    "fill": "yes",
                    "widths": {"arrow": 6, "line": -2, "rect": 2.5, "text": "big"},
                    "backdrop": {"fill": "ocean"},
                    "autoBackdrop": "on"
                }
            }"##,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(
            loaded.editor,
            EditorPreferences {
                color: Some("#e5484d".into()),
                widths: BTreeMap::from([("arrow".to_owned(), 6)]),
                // The editor checks the backdrop's fields itself.
                backdrop: Some(serde_json::json!({"fill": "ocean"})),
                ..EditorPreferences::default()
            }
        );
        assert_eq!(loaded.hotkeys.region, "Ctrl+Shift+R");
    }

    #[test]
    fn an_editor_section_that_is_not_an_object_is_ignored() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"editor": 3, "copyToClipboard": false}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor, EditorPreferences::default());
        assert!(!loaded.preferences.copy_to_clipboard);
    }

    #[test]
    fn changing_other_settings_keeps_the_editor_preferences() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        store.set_editor_preferences(editor_preferences()).unwrap();
        store
            .set_save_folder(dir.path().join("Elsewhere").to_str().unwrap())
            .unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().editor,
            editor_preferences()
        );
    }

    #[test]
    fn a_backdrop_that_is_not_an_object_is_dropped() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = r#"{"editor": {"backdrop": "ocean", "autoBackdrop": true}}"#;
        fs::write(&path, text).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.backdrop, None);
        assert_eq!(loaded.editor.auto_backdrop, Some(true));
    }

    #[test]
    fn auto_backdrop_is_set_by_settings_and_kept_by_the_editor() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        store.set_editor_preferences(editor_preferences()).unwrap();

        let updated = store.set_auto_backdrop(true).unwrap();
        assert_eq!(updated.editor.auto_backdrop, Some(true));
        // The editor's other choices are kept.
        assert_eq!(updated.editor.backdrop, editor_preferences().backdrop);

        // The editor saves without the flag; it stays on.
        let saved = store
            .set_editor_preferences(EditorPreferences {
                color: Some("#0090ff".into()),
                ..editor_preferences()
            })
            .unwrap();
        assert_eq!(saved.auto_backdrop, Some(true));
        assert_eq!(saved.color.as_deref(), Some("#0090ff"));

        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.auto_backdrop, Some(true));
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"]["autoBackdrop"], true);

        store.set_auto_backdrop(false).unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().editor.auto_backdrop,
            Some(false)
        );
    }
}
