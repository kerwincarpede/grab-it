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

use crate::{
    hotkeys::Hotkeys,
    keychain::{KeyStore, OsKeyStore},
};

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
/// The default vision model, as Ollama names it: small enough to pull and run
/// on a laptop. A model already in settings.json is kept.
pub const DEFAULT_AI_MODEL: &str = "qwen3-vl:4b";

/// Who describes captures. Mirrors `AiProvider` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiProvider {
    /// The user's own `claude` CLI, run headlessly (see `ai_cli.rs`).
    ClaudeCode,
    /// The user's own `codex` CLI, run headlessly (see `ai_cli.rs`).
    Codex,
    /// An OpenAI-compatible `/chat/completions` endpoint.
    Endpoint,
}

impl AiProvider {
    /// What the user calls the provider in messages.
    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Endpoint => "an OpenAI-compatible endpoint",
        }
    }
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

/// Where the endpoint API key is kept. Mirrors `ApiKeyStorage` in
/// src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiKeyStorage {
    /// The OS credential store (see `keychain.rs`); settings.json has no key.
    Keychain,
    /// settings.json, because this system has no credential store that works.
    #[default]
    SettingsFile,
}

/// How captures are described by a vision model (see `ai.rs`). Off by
/// default: nothing leaves the machine until the user turns it on, or
/// Grab-it turns it on once because Claude Code or Codex is installed (see
/// [`SettingsStore::enable_cli_provider`]). Mirrors `AiPreferences` in
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
    /// The endpoint's model.
    pub model: String,
    /// The model Claude Code is asked for: an alias such as `haiku` or a
    /// full model name. Empty means [`CLAUDE_CODE_MODEL`].
    pub claude_model: String,
    /// The model Codex is asked for. Empty means the one configured for
    /// Codex itself.
    pub codex_model: String,
    /// Sent as `Authorization: Bearer <key>` when set. Kept where
    /// `api_key_storage` says, so settings.json only has it without a
    /// keychain.
    pub api_key: Option<String>,
    /// Captures that existed when describing was turned on are skipped.
    pub new_captures_only: bool,
    /// Text captures are read again by the same model, which fixes what
    /// OCR misread and lays out JSON, code and tables (see `tidy.rs`).
    /// Only while describing is on: that is when captures may be sent.
    pub tidy_text: bool,
    /// Grab-it turned describing on by itself and the Library has not yet
    /// said so. Only Grab-it sets it; dismissing the notice clears it.
    pub notice_pending: bool,
    /// Where `api_key` is kept. Only the [`SettingsStore`] sets it: the
    /// frontend's copy is ignored and settings.json never has it.
    #[serde(skip_deserializing)]
    pub api_key_storage: ApiKeyStorage,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: None,
            endpoint: DEFAULT_AI_ENDPOINT.into(),
            model: DEFAULT_AI_MODEL.into(),
            claude_model: CLAUDE_CODE_MODEL.into(),
            codex_model: String::new(),
            api_key: None,
            new_captures_only: true,
            tidy_text: true,
            notice_pending: false,
            api_key_storage: ApiKeyStorage::default(),
        }
    }
}

/// The model Claude Code is asked for unless the user picks another, by
/// its alias.
pub const CLAUDE_CODE_MODEL: &str = "haiku";
/// The longest model name kept; anything longer is cut.
const MAX_CLI_MODEL_CHARS: usize = 100;

/// A model name as typed: trimmed, without spaces or quotes, at most
/// [`MAX_CLI_MODEL_CHARS`] long. Empty when nothing usable is left.
fn clean_model(model: &str) -> String {
    model
        .trim()
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '"' && *ch != '\'')
        .take(MAX_CLI_MODEL_CHARS)
        .collect()
}

impl AiSettings {
    /// Whether text captures are tidied up by the model.
    pub fn tidies_text(&self) -> bool {
        self.enabled && self.tidy_text
    }

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

    /// The model Claude Code is asked for.
    pub fn claude_model(&self) -> String {
        let model = clean_model(&self.claude_model);
        if model.is_empty() {
            CLAUDE_CODE_MODEL.into()
        } else {
            model
        }
    }

    /// The model Codex is asked for; None leaves it to Codex's own config.
    pub fn codex_model(&self) -> Option<String> {
        Some(clean_model(&self.codex_model)).filter(|model| !model.is_empty())
    }

    /// The model recorded beside each description.
    pub fn model_label(&self) -> String {
        match self.provider() {
            AiProvider::ClaudeCode => format!("claude-code/{}", self.claude_model()),
            // Without a model of its own, Codex uses whichever the user
            // configured for it.
            AiProvider::Codex => match self.codex_model() {
                Some(model) => format!("codex/{model}"),
                None => "codex".into(),
            },
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
            claude_model: clean_model(&self.claude_model),
            codex_model: clean_model(&self.codex_model),
            api_key,
            new_captures_only: self.new_captures_only,
            tidy_text: self.tidy_text,
            notice_pending: self.notice_pending,
            api_key_storage: self.api_key_storage,
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
    /// How text without a pill is drawn: `outline` or `shadow`, by the
    /// frontend's `TextStyle`; absent for plain text. Ignored while
    /// `text_background` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_style: Option<String>,
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
    /// New captures start with their mouse pointer shown in the editor and
    /// drawn into the copy made at capture time. Set from the Settings
    /// window; the editor's own saves keep it. Off when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_pointer: Option<bool>,
    /// Backdrops saved by name in the editor's backdrop panel. Set with
    /// [`SettingsStore::set_backdrop_presets`]; the editor's other saves
    /// keep them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backdrop_presets: Vec<BackdropPreset>,
    /// Colours saved beside the built-in swatches, as `#rrggbb`, oldest
    /// first. Set with [`SettingsStore::set_favorite_colors`]; the editor's
    /// other saves keep them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub favorite_colors: Vec<String>,
}

/// The most backdrop presets kept; any after these are dropped.
pub const MAX_BACKDROP_PRESETS: usize = 24;

/// The most favourite colours kept; any after these are dropped. Mirrors
/// `MAX_FAVORITE_COLORS` in src/settings/api.ts.
pub const MAX_FAVORITE_COLORS: usize = 8;

/// Favourite colours as they are kept: only `#rrggbb` values, lower-cased,
/// each once, and at most [`MAX_FAVORITE_COLORS`].
fn keep_favorite_colors<'a>(colors: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for color in colors {
        let is_hex = color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !is_hex {
            continue;
        }
        let color = color.to_ascii_lowercase();
        if !kept.contains(&color) {
            kept.push(color);
        }
        if kept.len() == MAX_FAVORITE_COLORS {
            break;
        }
    }
    kept
}

/// A backdrop saved under a name. Mirrors `BackdropPreset` in
/// src/settings/api.ts. Names need not be unique; `id` tells presets apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackdropPreset {
    pub id: String,
    pub name: String,
    /// The backdrop as the editor writes it in a sidecar. Kept as JSON:
    /// the editor checks each field when it reads it back.
    pub backdrop: serde_json::Value,
}

impl BackdropPreset {
    /// Reads one stored preset: `None` unless it has a text `id` and
    /// `name` and an object `backdrop`.
    fn from_stored(value: &serde_json::Value) -> Option<Self> {
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        let backdrop = value
            .get("backdrop")
            .filter(|backdrop| backdrop.is_object())?;
        Some(Self {
            id: text("id")?,
            name: text("name")?,
            backdrop: backdrop.clone(),
        })
    }

    /// Presets as they are kept: only those with an object backdrop, and
    /// at most [`MAX_BACKDROP_PRESETS`].
    fn keep(presets: Vec<Self>) -> Vec<Self> {
        presets
            .into_iter()
            .filter(|preset| preset.backdrop.is_object())
            .take(MAX_BACKDROP_PRESETS)
            .collect()
    }
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
            text_style: text("textStyle"),
            blur_mode: text("blurMode"),
            backdrop: value
                .get("backdrop")
                .filter(|backdrop| backdrop.is_object())
                .cloned(),
            auto_backdrop: flag("autoBackdrop"),
            show_pointer: flag("showPointer"),
            backdrop_presets: value
                .get("backdropPresets")
                .and_then(serde_json::Value::as_array)
                .map(|presets| {
                    presets
                        .iter()
                        .filter_map(BackdropPreset::from_stored)
                        .take(MAX_BACKDROP_PRESETS)
                        .collect()
                })
                .unwrap_or_default(),
            favorite_colors: value
                .get("favoriteColors")
                .and_then(serde_json::Value::as_array)
                .map(|colors| {
                    keep_favorite_colors(colors.iter().filter_map(serde_json::Value::as_str))
                })
                .unwrap_or_default(),
        }
    }
}

/// The Grab-it window's text size, as a percentage: it zooms the whole
/// window, text, buttons and thumbnails alike.
pub const MIN_TEXT_SCALE: u32 = 85;
pub const MAX_TEXT_SCALE: u32 = 130;
/// Slightly larger than the page's own size, which reads small on most
/// screens.
pub const DEFAULT_TEXT_SCALE: u32 = 110;

/// How far one ⌘+ or ⌘− moves the text size, as the slider's own step.
pub const TEXT_SCALE_STEP: u32 = 5;

/// A text size keyboard shortcut: ⌘+, ⌘− or ⌘0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextSizeStep {
    Bigger,
    Smaller,
    /// Back to [`DEFAULT_TEXT_SCALE`].
    Reset,
}

/// `percent` held to what the slider offers.
fn clamp_text_scale(percent: u32) -> u32 {
    percent.clamp(MIN_TEXT_SCALE, MAX_TEXT_SCALE)
}

/// Which corner of the screen the popup after a capture sits in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupCorner {
    BottomLeft,
    #[default]
    BottomRight,
    TopLeft,
    TopRight,
}

/// The longest the popup can be asked to stay, in seconds.
pub const MAX_POPUP_SECONDS: u32 = 60;

/// How Grab-it looks. Mirrors `Appearance` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    /// How big the Grab-it window draws everything, in percent.
    pub text_scale: u32,
    /// The same for the menu bar hub, whose window grows to match.
    pub hub_scale: u32,
    pub popup_corner: PopupCorner,
    /// How long the popup stays, in seconds; 0 keeps it until it is closed.
    pub popup_seconds: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            text_scale: DEFAULT_TEXT_SCALE,
            hub_scale: DEFAULT_TEXT_SCALE,
            popup_corner: PopupCorner::BottomRight,
            popup_seconds: 8,
        }
    }
}

impl Appearance {
    /// The Grab-it window's zoom.
    pub fn zoom(&self) -> f64 {
        f64::from(clamp_text_scale(self.text_scale)) / 100.0
    }

    /// The Grab-it window's text size after `step`. A size off the slider's
    /// steps, from an edited settings file, moves to the next step along.
    pub fn stepped(self, step: TextSizeStep) -> Self {
        let scale = clamp_text_scale(self.text_scale);
        let text_scale = match step {
            TextSizeStep::Bigger => (scale / TEXT_SCALE_STEP + 1) * TEXT_SCALE_STEP,
            TextSizeStep::Smaller => {
                scale.div_ceil(TEXT_SCALE_STEP).saturating_sub(1) * TEXT_SCALE_STEP
            }
            TextSizeStep::Reset => DEFAULT_TEXT_SCALE,
        };
        Self {
            text_scale: clamp_text_scale(text_scale),
            ..self
        }
    }

    /// The menu bar hub's zoom.
    pub fn hub_zoom(&self) -> f64 {
        f64::from(clamp_text_scale(self.hub_scale)) / 100.0
    }

    /// Read from the settings file: anything it cannot use keeps its default.
    fn from_stored(value: serde_json::Value) -> Self {
        let defaults = Self::default();
        let field = |key: &str| value.get(key).cloned();
        Self {
            text_scale: field("textScale")
                .and_then(|v| v.as_u64())
                .map(|percent| clamp_text_scale(percent.min(u64::from(u32::MAX)) as u32))
                .unwrap_or(defaults.text_scale),
            hub_scale: field("hubScale")
                .and_then(|v| v.as_u64())
                .map(|percent| clamp_text_scale(percent.min(u64::from(u32::MAX)) as u32))
                .unwrap_or(defaults.hub_scale),
            popup_corner: field("popupCorner")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.popup_corner),
            popup_seconds: field("popupSeconds")
                .and_then(|v| v.as_u64())
                .map(|seconds| seconds.min(u64::from(MAX_POPUP_SECONDS)) as u32)
                .unwrap_or(defaults.popup_seconds),
        }
    }
}

/// What recordings are saved as.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingFormat {
    /// An animated GIF, silent and at most a minute long.
    Gif,
    /// An H.264 MP4, encoded by ffmpeg (see ffmpeg.rs).
    #[default]
    Mp4,
}

impl RecordingFormat {
    /// The file extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Gif => "gif",
            Self::Mp4 => "mp4",
        }
    }
}

/// How good an MP4 looks, and so how big it is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingQuality {
    Low,
    Medium,
    #[default]
    High,
}

impl RecordingQuality {
    /// The MP4 bitrate, as bits per pixel of each frame.
    pub fn bits_per_pixel(self) -> f64 {
        match self {
            Self::Low => 0.05,
            Self::Medium => 0.1,
            Self::High => 0.2,
        }
    }
}

/// The frame rates an MP4 can be recorded at.
pub const RECORDING_FPS: [u32; 2] = [30, 60];

/// The seconds a recording can count down before it starts; 0 starts at
/// once. Mirrors `RECORDING_COUNTDOWNS` in src/settings/api.ts.
pub const RECORDING_COUNTDOWNS: [u32; 4] = [0, 3, 5, 10];

/// What sound an MP4 records.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingAudio {
    /// Silent.
    #[default]
    None,
    /// The chosen microphone (see audio.rs).
    Microphone,
    /// What the computer plays (see audio.rs). Not offered on macOS
    /// before 13.
    System,
    /// The chosen microphone and what the computer plays, mixed into one
    /// track.
    Both,
}

impl RecordingAudio {
    /// Whether the microphone is recorded.
    pub fn microphone(self) -> bool {
        matches!(self, Self::Microphone | Self::Both)
    }

    /// Whether what the computer plays is recorded.
    pub fn system(self) -> bool {
        matches!(self, Self::System | Self::Both)
    }
}

/// The webcam bubble's outline while recording (see webcam.rs). Mirrors
/// `WebcamShape` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebcamShape {
    /// A square with smooth, continuous corners. Saved as `rounded` before
    /// it was drawn as a squircle.
    #[default]
    #[serde(alias = "rounded")]
    Squircle,
    /// A circle.
    Round,
    /// Portrait: a round top on a square base with soft corners.
    Arch,
    /// A tall capsule.
    Pill,
    /// Landscape, 16:10, with soft corners.
    Wide,
    /// A soft outline that slowly changes.
    Blob,
}

impl WebcamShape {
    /// The name the settings file and the bubble's page use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Squircle => "squircle",
            Self::Round => "round",
            Self::Arch => "arch",
            Self::Pill => "pill",
            Self::Wide => "wide",
            Self::Blob => "blob",
        }
    }
}

/// What the Record overlay's setup toolbar records: a dragged region, a
/// picked window's area or a whole display. Mirrors `RecordingSource` in
/// src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSource {
    #[default]
    Region,
    Window,
    Screen,
}

/// How screen recordings are made. Mirrors `RecordingSettings` in
/// src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordingSettings {
    pub format: RecordingFormat,
    /// MP4 only.
    pub quality: RecordingQuality,
    /// An MP4's frames a second: one of [`RECORDING_FPS`]. A GIF is about
    /// ten frames a second whatever this says.
    pub fps: u32,
    /// Whether the pointer is drawn into the recording.
    pub show_cursor: bool,
    /// Whether a fading ring is drawn where each click lands.
    pub show_clicks: bool,
    /// Whether the keys pressed are drawn as a label at the bottom centre.
    pub show_keystrokes: bool,
    /// MP4 only: a GIF is always silent.
    pub audio: RecordingAudio,
    /// The microphone recorded, by the id `audio::microphones` lists it
    /// with. None records the system's default microphone.
    pub microphone: Option<String>,
    /// Whether the webcam is shown in a bubble on screen, and so recorded
    /// with it.
    pub show_webcam: bool,
    /// The camera in the bubble, by the `deviceId` the webview lists it
    /// with. None shows the system's default camera.
    pub camera: Option<String>,
    pub webcam_shape: WebcamShape,
    /// Whether the bubble shows the camera mirrored, as a mirror would, so
    /// pointing at the screen points the right way in the recording.
    pub mirror_webcam: bool,
    /// Seconds counted down on the recording toolbar before the first
    /// frame: one of [`RECORDING_COUNTDOWNS`].
    pub countdown: u32,
    /// The source the Record overlay opens on: the one used last.
    pub source: RecordingSource,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            format: RecordingFormat::default(),
            quality: RecordingQuality::default(),
            fps: RECORDING_FPS[0],
            show_cursor: true,
            show_clicks: false,
            show_keystrokes: false,
            audio: RecordingAudio::default(),
            microphone: None,
            show_webcam: false,
            camera: None,
            webcam_shape: WebcamShape::default(),
            mirror_webcam: true,
            countdown: 0,
            source: RecordingSource::default(),
        }
    }
}

impl RecordingSettings {
    /// Read from the settings file: anything it cannot use keeps its default.
    fn from_stored(value: serde_json::Value) -> Self {
        let defaults = Self::default();
        let field = |key: &str| value.get(key).cloned();
        Self {
            format: field("format")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.format),
            quality: field("quality")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.quality),
            fps: field("fps")
                .and_then(|v| serde_json::from_value::<u32>(v).ok())
                .filter(|fps| RECORDING_FPS.contains(fps))
                .unwrap_or(defaults.fps),
            show_cursor: field("showCursor")
                .and_then(|v| v.as_bool())
                .unwrap_or(defaults.show_cursor),
            show_clicks: field("showClicks")
                .and_then(|v| v.as_bool())
                .unwrap_or(defaults.show_clicks),
            show_keystrokes: field("showKeystrokes")
                .and_then(|v| v.as_bool())
                .unwrap_or(defaults.show_keystrokes),
            audio: field("audio")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.audio),
            microphone: field("microphone")
                .and_then(|v| v.as_str().map(str::to_owned))
                .filter(|name| !name.is_empty()),
            show_webcam: field("showWebcam")
                .and_then(|v| v.as_bool())
                .unwrap_or(defaults.show_webcam),
            camera: field("camera")
                .and_then(|v| v.as_str().map(str::to_owned))
                .filter(|id| !id.is_empty()),
            webcam_shape: field("webcamShape")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.webcam_shape),
            mirror_webcam: field("mirrorWebcam")
                .and_then(|v| v.as_bool())
                .unwrap_or(defaults.mirror_webcam),
            countdown: field("countdown")
                .and_then(|v| serde_json::from_value::<u32>(v).ok())
                .filter(|seconds| RECORDING_COUNTDOWNS.contains(seconds))
                .unwrap_or(defaults.countdown),
            source: field("source")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(defaults.source),
        }
    }
}

/// How cleanup removes items older than their Keep setting. Mirrors
/// `Removal` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Removal {
    /// To the system Trash, where they can be restored.
    #[default]
    Trash,
    /// Deleted for good.
    Permanent,
}

/// How long each kind of item is kept, in days; `None` keeps it forever.
/// Mirrors `Retention` in src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Retention {
    pub image: Option<u32>,
    pub gif: Option<u32>,
    pub video: Option<u32>,
    pub removal: Removal,
}

impl Retention {
    /// How many days items of `kind` are kept; `None` is forever.
    pub fn days(&self, kind: crate::library::ShotKind) -> Option<u32> {
        match kind {
            crate::library::ShotKind::Image => self.image,
            crate::library::ShotKind::Gif => self.gif,
            crate::library::ShotKind::Video => self.video,
        }
    }

    /// Read from the settings file: anything it cannot use keeps its
    /// default, and zero days, which would remove everything, is forever.
    fn from_stored(value: serde_json::Value) -> Self {
        let defaults = Self::default();
        let days = |key: &str| {
            value
                .get(key)
                .and_then(|v| serde_json::from_value::<u32>(v.clone()).ok())
                .filter(|days| *days > 0)
        };
        Self {
            image: days("image"),
            gif: days("gif"),
            video: days("video"),
            removal: value
                .get("removal")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(defaults.removal),
        }
    }
}

/// Where the macOS Permissions page (the Welcome window's first step) has
/// got to. No system API says whether Screen Recording or Input Monitoring
/// were ever asked for, so Grab-it remembers it. Kept outside
/// [`Preferences`], so saving any other settings carries it over.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionSetup {
    /// Allow all has asked for Screen Recording and Input Monitoring.
    pub asked: bool,
    /// Allow all ran and setup is not finished: until Skip for now or
    /// Continue, each launch reopens the Welcome window.
    pub resume: bool,
}

impl PermissionSetup {
    /// Read from the settings file: anything it cannot use is false.
    fn from_stored(value: serde_json::Value) -> Self {
        let flag = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        Self {
            asked: flag("asked"),
            resume: flag("resume"),
        }
    }
}

/// Which releases Grab-it updates to. Mirrors `UpdateChannel` in
/// src/settings/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    /// Releases the owner has promoted. Every copy starts here.
    #[default]
    Stable,
    /// Every merge to main, as soon as it is built.
    Edge,
}

impl UpdateChannel {
    /// Read from the settings file: anything it does not know is Stable.
    fn from_stored(value: serde_json::Value) -> Self {
        serde_json::from_value(value).unwrap_or_default()
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
    /// macOS: Grab-it has a Dock icon that opens its window. Off, it lives
    /// in the menu bar only. Other systems ignore it.
    pub show_in_dock: bool,
    /// Text size and the popup's place and time on screen.
    pub appearance: Appearance,
    /// What screen recordings are saved as.
    pub recording: RecordingSettings,
    /// How long items are kept and how cleanup removes them.
    #[serde(default)]
    pub retention: Retention,
    /// The macOS Permissions page's progress.
    #[serde(default)]
    pub permissions: PermissionSetup,
    /// Settings › AI agents: the grab-it command line may capture. Off, the
    /// control connection refuses every request.
    #[serde(default)]
    pub agent_access: bool,
    /// Settings › Updates: which releases the updater checks.
    #[serde(default)]
    pub update_channel: UpdateChannel,
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
            show_in_dock: true,
            appearance: Appearance::default(),
            recording: RecordingSettings::default(),
            retention: Retention::default(),
            permissions: PermissionSetup::default(),
            agent_access: false,
            update_channel: UpdateChannel::Stable,
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
    show_in_dock: Option<bool>,
    /// Read leniently by [`Appearance::from_stored`].
    appearance: Option<serde_json::Value>,
    /// Read leniently by [`RecordingSettings::from_stored`].
    recording: Option<serde_json::Value>,
    /// Read leniently by [`Retention::from_stored`].
    retention: Option<serde_json::Value>,
    /// Read leniently by [`PermissionSetup::from_stored`].
    permissions: Option<serde_json::Value>,
    agent_access: Option<bool>,
    /// Read leniently by [`UpdateChannel::from_stored`].
    update_channel: Option<serde_json::Value>,
}

/// Hotkeys on disk; a missing or empty one keeps its default.
#[derive(Debug, Default, Deserialize)]
struct StoredHotkeys {
    #[serde(rename = "allInOne")]
    all_in_one: Option<String>,
    region: Option<String>,
    window: Option<String>,
    screen: Option<String>,
    text: Option<String>,
    colour: Option<String>,
    library: Option<String>,
    steps: Option<String>,
}

impl StoredHotkeys {
    fn merge_onto(self, defaults: Hotkeys) -> Hotkeys {
        let pick = |stored: Option<String>, default: String| {
            stored
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default)
        };
        Hotkeys {
            all_in_one: pick(self.all_in_one, defaults.all_in_one),
            region: pick(self.region, defaults.region),
            window: pick(self.window, defaults.window),
            screen: pick(self.screen, defaults.screen),
            text: pick(self.text, defaults.text),
            colour: pick(self.colour, defaults.colour),
            library: pick(self.library, defaults.library),
            steps: pick(self.steps, defaults.steps),
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
            show_in_dock: self.show_in_dock.unwrap_or(defaults.show_in_dock),
            appearance: self
                .appearance
                .map(Appearance::from_stored)
                .unwrap_or(defaults.appearance),
            recording: self
                .recording
                .map(RecordingSettings::from_stored)
                .unwrap_or(defaults.recording),
            retention: self
                .retention
                .map(Retention::from_stored)
                .unwrap_or(defaults.retention),
            permissions: self
                .permissions
                .map(PermissionSetup::from_stored)
                .unwrap_or(defaults.permissions),
            agent_access: self.agent_access.unwrap_or(defaults.agent_access),
            update_channel: self
                .update_channel
                .map(UpdateChannel::from_stored)
                .unwrap_or(defaults.update_channel),
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

/// The file's shape as it is written: [`Settings`] without where the API
/// key is kept, and without the key itself when the keychain holds it.
/// The read side is [`StoredSettings`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsOnDisk<'a> {
    save_folder: &'a Path,
    hotkeys: &'a Hotkeys,
    after_capture: AfterCapture,
    copy_to_clipboard: bool,
    ai: AiOnDisk<'a>,
    editor: &'a EditorPreferences,
    show_in_dock: bool,
    appearance: Appearance,
    recording: &'a RecordingSettings,
    retention: Retention,
    permissions: PermissionSetup,
    agent_access: bool,
    update_channel: UpdateChannel,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiOnDisk<'a> {
    enabled: bool,
    provider: Option<AiProvider>,
    endpoint: &'a str,
    model: &'a str,
    claude_model: &'a str,
    codex_model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<&'a str>,
    new_captures_only: bool,
    tidy_text: bool,
    notice_pending: bool,
}

impl<'a> SettingsOnDisk<'a> {
    fn new(settings: &'a Settings) -> Self {
        // Every field named, so a new one cannot be left out by mistake.
        let AiSettings {
            enabled,
            provider,
            endpoint,
            model,
            claude_model,
            codex_model,
            api_key,
            new_captures_only,
            tidy_text,
            notice_pending,
            api_key_storage,
        } = &settings.preferences.ai;
        Self {
            save_folder: &settings.save_folder,
            hotkeys: &settings.hotkeys,
            after_capture: settings.preferences.after_capture,
            copy_to_clipboard: settings.preferences.copy_to_clipboard,
            ai: AiOnDisk {
                enabled: *enabled,
                provider: *provider,
                endpoint,
                model,
                claude_model,
                codex_model,
                api_key: match api_key_storage {
                    ApiKeyStorage::Keychain => None,
                    ApiKeyStorage::SettingsFile => api_key.as_deref(),
                },
                new_captures_only: *new_captures_only,
                tidy_text: *tidy_text,
                notice_pending: *notice_pending,
            },
            editor: &settings.editor,
            show_in_dock: settings.show_in_dock,
            appearance: settings.appearance,
            recording: &settings.recording,
            retention: settings.retention,
            permissions: settings.permissions,
            agent_access: settings.agent_access,
            update_channel: settings.update_channel,
        }
    }
}

/// Writes settings to `path`, creating its directory. The file is replaced
/// in one step, so a crash never leaves it half written. The API key is
/// left out when `api_key_storage` says the keychain holds it.
pub fn save(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut json = serde_json::to_string_pretty(&SettingsOnDisk::new(settings))?;
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

/// The current settings, the file they live in and the keychain that
/// holds the API key.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    current: Settings,
    /// No settings file existed when the store was opened.
    first_run: bool,
    keys: Box<dyn KeyStore>,
    /// The keychain worked when the store was opened, so it may hold a key
    /// that clearing the key must remove.
    keychain_worked: bool,
}

impl SettingsStore {
    /// Loads settings from `path`, with the API key in the OS keychain.
    pub fn open(path: PathBuf, defaults: Settings) -> Self {
        Self::open_with_keys(path, defaults, Box::new(OsKeyStore))
    }

    /// Loads settings from `path`, and the API key from `keys`. An
    /// unreadable file is reported and the defaults are used; the file is
    /// only overwritten on the next change. A key still in settings.json is
    /// moved into `keys`; when `keys` does not work it stays in the file.
    pub fn open_with_keys(path: PathBuf, defaults: Settings, keys: Box<dyn KeyStore>) -> Self {
        let first_run = !path.exists();
        let current = load(&path, defaults.clone()).unwrap_or_else(|err| {
            eprintln!(
                "Grab-it: using default settings, could not read {}: {err}",
                path.display()
            );
            defaults
        });
        let mut store = Self {
            path,
            current,
            first_run,
            keys,
            keychain_worked: false,
        };
        store.load_api_key();
        store
    }

    /// Reads the API key from the keychain, or moves the one settings.json
    /// has into it. Settings from before the keychain, or from a system
    /// without one, have the key in the file.
    fn load_api_key(&mut self) {
        let stored = match self.keys.get() {
            Ok(stored) => {
                self.keychain_worked = true;
                stored
            }
            Err(err) => {
                eprintln!("Grab-it: keeping the API key in settings.json, no keychain: {err}");
                self.current.preferences.ai.api_key_storage = ApiKeyStorage::SettingsFile;
                return;
            }
        };
        let in_file = self
            .current
            .preferences
            .ai
            .api_key
            .clone()
            .filter(|key| !key.trim().is_empty());
        let Some(key) = in_file else {
            self.current.preferences.ai.api_key = stored;
            self.current.preferences.ai.api_key_storage = ApiKeyStorage::Keychain;
            return;
        };
        // The file's key is the newer one: a keychain key beside it is
        // left from before the keychain stopped working.
        if stored.as_deref() != Some(key.as_str())
            && let Err(err) = self.keys.set(&key)
        {
            eprintln!("Grab-it: keeping the API key in settings.json, could not move it: {err}");
            self.current.preferences.ai.api_key_storage = ApiKeyStorage::SettingsFile;
            return;
        }
        self.current.preferences.ai.api_key_storage = ApiKeyStorage::Keychain;
        // Rewritten without the key. Should that fail, the key is in both
        // places and the next start tries again.
        if let Err(err) = save(&self.path, &self.current) {
            eprintln!("Grab-it: could not remove the API key from settings.json: {err}");
        }
    }

    /// Stores `key`, the API key being saved, where `api_key_storage`
    /// says. Returns where it now is: should the keychain fail to store a
    /// key, it goes into settings.json instead of being lost.
    ///
    /// Clearing the key removes it from the keychain too, even after a
    /// fallback to settings.json, as the next start would read a key left
    /// there back. When the keychain worked but cannot remove it now, the
    /// save fails rather than seeming to clear the key.
    fn store_api_key(&self, key: Option<&str>) -> Result<ApiKeyStorage, SettingsError> {
        let current = &self.current.preferences.ai;
        if current.api_key.as_deref() == key {
            return Ok(current.api_key_storage);
        }
        let Some(key) = key else {
            return match self.keys.delete() {
                Ok(()) => Ok(current.api_key_storage),
                Err(err) if self.keychain_worked => Err(SettingsError::Invalid(format!(
                    "Could not remove the API key from the keychain: {err}"
                ))),
                // Never reached this session: nothing of this session's is
                // in it to remove.
                Err(_) => Ok(current.api_key_storage),
            };
        };
        if current.api_key_storage == ApiKeyStorage::SettingsFile {
            return Ok(ApiKeyStorage::SettingsFile);
        }
        match self.keys.set(key) {
            Ok(()) => Ok(ApiKeyStorage::Keychain),
            Err(err) => {
                eprintln!(
                    "Grab-it: keeping the API key in settings.json, the keychain failed: {err}"
                );
                Ok(ApiKeyStorage::SettingsFile)
            }
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
        preferences.ai.api_key_storage = self.store_api_key(preferences.ai.api_key.as_deref())?;
        let next = Settings {
            preferences,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Turns describing on with `provider`, a CLI provider, for new
    /// captures only, and asks for the one-time notice, when the user never
    /// turned describing on. Finding its CLI is up to the caller. Returns
    /// the AI settings from before, when they changed; once a provider is
    /// set this never changes anything again.
    pub fn enable_cli_provider(
        &mut self,
        provider: AiProvider,
    ) -> Result<Option<AiSettings>, SettingsError> {
        let before = self.current.preferences.ai.clone();
        if !before.never_enabled() {
            return Ok(None);
        }
        let mut next = self.current.clone();
        next.preferences.ai = AiSettings {
            enabled: true,
            provider: Some(provider),
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
    /// Settings window, and presets and favourite colours have their own
    /// saves, so the editor's saves never change them.
    pub fn set_editor_preferences(
        &mut self,
        editor: EditorPreferences,
    ) -> Result<EditorPreferences, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                auto_backdrop: self.current.editor.auto_backdrop,
                show_pointer: self.current.editor.show_pointer,
                backdrop_presets: self.current.editor.backdrop_presets.clone(),
                favorite_colors: self.current.editor.favorite_colors.clone(),
                ..editor
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.editor.clone())
    }

    /// Replaces the saved backdrop presets with `presets`, keeping the rest
    /// of the editor's choices. Returns the presets as kept.
    pub fn set_backdrop_presets(
        &mut self,
        presets: Vec<BackdropPreset>,
    ) -> Result<Vec<BackdropPreset>, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                backdrop_presets: BackdropPreset::keep(presets),
                ..self.current.editor.clone()
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.editor.backdrop_presets.clone())
    }

    /// Replaces the saved favourite colours with `colors`, keeping the rest
    /// of the editor's choices. Returns the colours as kept.
    pub fn set_favorite_colors(
        &mut self,
        colors: Vec<String>,
    ) -> Result<Vec<String>, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                favorite_colors: keep_favorite_colors(colors.iter().map(String::as_str)),
                ..self.current.editor.clone()
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.editor.favorite_colors.clone())
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

    /// Turns showing the pointer in new captures on or off, keeping the
    /// rest of the editor's choices.
    pub fn set_show_pointer(&mut self, enabled: bool) -> Result<Settings, SettingsError> {
        let next = Settings {
            editor: EditorPreferences {
                show_pointer: Some(enabled),
                ..self.current.editor.clone()
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes how Grab-it looks. Applying the text size is up to the
    /// caller; the popup reads its corner and time when it next shows.
    pub fn set_appearance(&mut self, appearance: Appearance) -> Result<Settings, SettingsError> {
        let next = Settings {
            appearance: Appearance {
                text_scale: clamp_text_scale(appearance.text_scale),
                hub_scale: clamp_text_scale(appearance.hub_scale),
                popup_seconds: appearance.popup_seconds.min(MAX_POPUP_SECONDS),
                ..appearance
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes how screen recordings are made. Getting ffmpeg ready for MP4
    /// is up to the caller.
    pub fn set_recording(
        &mut self,
        recording: RecordingSettings,
    ) -> Result<Settings, SettingsError> {
        if !RECORDING_FPS.contains(&recording.fps) {
            return Err(SettingsError::Invalid(format!(
                "recordings can be 30 or 60 fps, not {}",
                recording.fps
            )));
        }
        if !RECORDING_COUNTDOWNS.contains(&recording.countdown) {
            return Err(SettingsError::Invalid(format!(
                "a recording can count down 0, 3, 5 or 10 seconds, not {}",
                recording.countdown
            )));
        }
        let next = Settings {
            recording: RecordingSettings {
                microphone: recording.microphone.filter(|name| !name.is_empty()),
                camera: recording.camera.filter(|id| !id.is_empty()),
                ..recording
            },
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes how long each kind of item is kept and how cleanup removes
    /// them. Running cleanup is up to the caller.
    pub fn set_retention(&mut self, retention: Retention) -> Result<Settings, SettingsError> {
        if [retention.image, retention.gif, retention.video].contains(&Some(0)) {
            return Err(SettingsError::Invalid(
                "items are kept for at least a day".into(),
            ));
        }
        let next = Settings {
            retention,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Shows or hides the Dock icon (macOS). Applying it is up to the caller.
    pub fn set_show_in_dock(&mut self, enabled: bool) -> Result<Settings, SettingsError> {
        let next = Settings {
            show_in_dock: enabled,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Lets the grab-it command line capture, or stops it.
    pub fn set_agent_access(&mut self, enabled: bool) -> Result<Settings, SettingsError> {
        let next = Settings {
            agent_access: enabled,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Changes which releases the updater checks. Checking the new channel
    /// is up to the caller.
    pub fn set_update_channel(
        &mut self,
        channel: UpdateChannel,
    ) -> Result<Settings, SettingsError> {
        let next = Settings {
            update_channel: channel,
            ..self.current.clone()
        };
        save(&self.path, &next)?;
        self.current = next;
        Ok(self.current.clone())
    }

    /// Records the macOS Permissions page's progress.
    pub fn set_permission_setup(
        &mut self,
        permissions: PermissionSetup,
    ) -> Result<Settings, SettingsError> {
        if self.current.permissions == permissions {
            return Ok(self.current.clone());
        }
        let next = Settings {
            permissions,
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
    use crate::keychain::MemoryKeyStore;
    use tempfile::TempDir;

    /// A store on a system without a keychain, so the API key stays in
    /// settings.json as it did before the keychain. The keychain's own
    /// tests use [`SettingsStore::open_with_keys`].
    fn open_store(path: PathBuf, defaults: Settings) -> SettingsStore {
        SettingsStore::open_with_keys(path, defaults, Box::new(MemoryKeyStore::unavailable()))
    }

    /// The `ai` section of the settings file as written.
    fn ai_on_disk(path: &Path) -> serde_json::Value {
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        json["ai"].clone()
    }

    /// Endpoint settings with `api_key`.
    fn with_key(api_key: Option<&str>) -> Preferences {
        Preferences {
            ai: AiSettings {
                enabled: true,
                provider: Some(AiProvider::Endpoint),
                endpoint: "https://api.openai.com/v1".into(),
                model: "gpt-5-mini".into(),
                api_key: api_key.map(str::to_owned),
                ..AiSettings::default()
            },
            ..Preferences::default()
        }
    }

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
            show_in_dock: false,
            appearance: Appearance::default(),
            recording: RecordingSettings {
                format: RecordingFormat::Gif,
                quality: RecordingQuality::Low,
                fps: 60,
                show_cursor: false,
                show_clicks: true,
                show_keystrokes: true,
                audio: RecordingAudio::Microphone,
                microphone: Some("USB Microphone".into()),
                show_webcam: true,
                camera: Some("3f9a1c".into()),
                webcam_shape: WebcamShape::Arch,
                mirror_webcam: false,
                countdown: 5,
                source: RecordingSource::Screen,
            },
            retention: Retention {
                image: None,
                gif: Some(90),
                video: Some(30),
                removal: Removal::Permanent,
            },
            permissions: PermissionSetup {
                asked: true,
                resume: true,
            },
            agent_access: true,
            update_channel: UpdateChannel::Edge,
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap(), settings);
    }

    #[test]
    fn agent_access_is_off_by_default_and_remembered() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert!(!defaults(&dir).agent_access);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        assert!(!store.get().agent_access);
        assert!(store.set_agent_access(true).unwrap().agent_access);
        assert!(load(&path, defaults(&dir)).unwrap().agent_access);
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["agentAccess"], true);
        // A file from before the setting existed keeps it off.
        fs::write(&path, r#"{"showInDock": false}"#).unwrap();
        assert!(!load(&path, defaults(&dir)).unwrap().agent_access);
    }

    #[test]
    fn update_channel_is_stable_by_default_and_remembered() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert_eq!(defaults(&dir).update_channel, UpdateChannel::Stable);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        assert_eq!(store.get().update_channel, UpdateChannel::Stable);
        assert_eq!(
            store
                .set_update_channel(UpdateChannel::Edge)
                .unwrap()
                .update_channel,
            UpdateChannel::Edge
        );
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().update_channel,
            UpdateChannel::Edge
        );
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["updateChannel"], "edge");
        // A file from before the setting existed stays on Stable.
        fs::write(&path, r#"{"showInDock": false}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.update_channel, UpdateChannel::Stable);
        assert!(!loaded.show_in_dock);
        // A channel this build does not know is read as Stable, and the
        // rest of the file still loads.
        fs::write(
            &path,
            r#"{"showInDock": false, "updateChannel": "nightly"}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.update_channel, UpdateChannel::Stable);
        assert!(!loaded.show_in_dock);
    }

    #[test]
    fn dock_icon_is_on_by_default_and_remembered() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert!(defaults(&dir).show_in_dock);
        let mut store = SettingsStore::open(path.clone(), defaults(&dir));
        assert!(!store.set_show_in_dock(false).unwrap().show_in_dock);
        assert!(!load(&path, defaults(&dir)).unwrap().show_in_dock);
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["showInDock"], false);
    }

    #[test]
    fn appearance_is_saved_capped_and_read_leniently() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        assert_eq!(store.get().appearance, Appearance::default());
        let saved = store
            .set_appearance(Appearance {
                text_scale: 400,
                hub_scale: 50,
                popup_corner: PopupCorner::TopRight,
                popup_seconds: 500,
            })
            .unwrap()
            .appearance;
        assert_eq!(saved.popup_seconds, MAX_POPUP_SECONDS);
        assert_eq!(saved.text_scale, MAX_TEXT_SCALE);
        assert_eq!(saved.hub_scale, MIN_TEXT_SCALE);
        assert_eq!(Appearance::default().zoom(), 1.1);
        assert_eq!(load(&path, defaults(&dir)).unwrap().appearance, saved);
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::json!({"textScale": 130, "hubScale": 85, "popupCorner": "topRight", "popupSeconds": 60})
        );

        // One bad value keeps its default; the rest still load.
        fs::write(
            &path,
            r#"{"appearance": {"textScale": "huge", "popupCorner": "topLeft", "popupSeconds": -3}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().appearance;
        assert_eq!(loaded.text_scale, DEFAULT_TEXT_SCALE);
        assert_eq!(loaded.popup_corner, PopupCorner::TopLeft);
        assert_eq!(loaded.popup_seconds, 8);
    }

    #[test]
    fn text_size_steps_by_the_slider_step_within_its_range() {
        let at = |text_scale| Appearance {
            text_scale,
            ..Appearance::default()
        };
        let step = |text_scale, step| at(text_scale).stepped(step).text_scale;
        assert_eq!(step(110, TextSizeStep::Bigger), 115);
        assert_eq!(step(110, TextSizeStep::Smaller), 105);
        assert_eq!(step(MAX_TEXT_SCALE, TextSizeStep::Bigger), MAX_TEXT_SCALE);
        assert_eq!(step(MIN_TEXT_SCALE, TextSizeStep::Smaller), MIN_TEXT_SCALE);
        assert_eq!(
            step(MIN_TEXT_SCALE, TextSizeStep::Reset),
            DEFAULT_TEXT_SCALE
        );
        // Off the steps: on to the next one, not a full step past it.
        assert_eq!(step(112, TextSizeStep::Bigger), 115);
        assert_eq!(step(112, TextSizeStep::Smaller), 110);
        // Only the text size changes.
        let hub = Appearance {
            hub_scale: 90,
            popup_seconds: 3,
            ..Appearance::default()
        };
        assert_eq!(
            hub.stepped(TextSizeStep::Bigger),
            Appearance {
                text_scale: 115,
                ..hub
            }
        );
    }

    #[test]
    fn recordings_default_to_high_quality_mp4() {
        let dir = TempDir::new().unwrap();
        let recording = defaults(&dir).recording;
        assert_eq!(recording.format, RecordingFormat::Mp4);
        assert_eq!(recording.quality, RecordingQuality::High);
        assert_eq!(RecordingFormat::Mp4.extension(), "mp4");
        assert_eq!(RecordingFormat::Gif.extension(), "gif");
        assert_eq!(RecordingQuality::Low.bits_per_pixel(), 0.05);
        assert_eq!(RecordingQuality::Medium.bits_per_pixel(), 0.1);
        assert_eq!(RecordingQuality::High.bits_per_pixel(), 0.2);
        assert_eq!(
            serde_json::to_value(recording).unwrap(),
            serde_json::json!({
                "format": "mp4",
                "quality": "high",
                "fps": 30,
                "showCursor": true,
                "showClicks": false,
                "showKeystrokes": false,
                "audio": "none",
                "microphone": null,
                "showWebcam": false,
                "camera": null,
                "webcamShape": "squircle",
                "mirrorWebcam": true,
                "countdown": 0,
                "source": "region",
            })
        );
    }

    #[test]
    fn recordings_are_silent_by_default_and_remember_the_microphone() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let recording = defaults(&dir).recording;
        assert_eq!(recording.audio, RecordingAudio::None);
        assert_eq!(recording.microphone, None);

        let mut store = open_store(path.clone(), defaults(&dir));
        let chosen = RecordingSettings {
            audio: RecordingAudio::Microphone,
            microphone: Some("alsa_input.usb-Blue_Yeti-00.analog-stereo".into()),
            ..RecordingSettings::default()
        };
        assert_eq!(
            store.set_recording(chosen.clone()).unwrap().recording,
            chosen
        );
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording, chosen);

        // An empty name is the system's default microphone.
        let blank = RecordingSettings {
            microphone: Some(String::new()),
            ..chosen.clone()
        };
        assert_eq!(
            store.set_recording(blank).unwrap().recording.microphone,
            None
        );

        // An unknown source or a wrong type keeps its default.
        fs::write(
            &path,
            r#"{"recording": {"audio": "speakers", "microphone": 7}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert_eq!(loaded.audio, RecordingAudio::None);
        assert_eq!(loaded.microphone, None);
        fs::write(
            &path,
            r#"{"recording": {"audio": "microphone", "microphone": "Mic"}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert_eq!(loaded.audio, RecordingAudio::Microphone);
        assert_eq!(loaded.microphone.as_deref(), Some("Mic"));
    }

    #[test]
    fn system_sound_is_recorded_alone_or_with_the_microphone() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        for (stored, audio) in [
            ("system", RecordingAudio::System),
            ("both", RecordingAudio::Both),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                &path,
                format!(r#"{{"recording": {{"audio": "{stored}"}}}}"#),
            )
            .unwrap();
            assert_eq!(load(&path, defaults(&dir)).unwrap().recording.audio, audio);
            assert_eq!(serde_json::to_value(audio).unwrap(), stored);
        }
        let records = |audio: RecordingAudio| (audio.microphone(), audio.system());
        assert_eq!(records(RecordingAudio::None), (false, false));
        assert_eq!(records(RecordingAudio::Microphone), (true, false));
        assert_eq!(records(RecordingAudio::System), (false, true));
        assert_eq!(records(RecordingAudio::Both), (true, true));
    }

    #[test]
    fn recording_is_saved_and_read_leniently() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        // A file from before recording settings existed records MP4.
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"showInDock": false}"#).unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().recording,
            RecordingSettings::default()
        );

        let mut store = open_store(path.clone(), defaults(&dir));
        let chosen = RecordingSettings {
            format: RecordingFormat::Gif,
            quality: RecordingQuality::Medium,
            fps: 60,
            show_cursor: false,
            show_clicks: true,
            ..RecordingSettings::default()
        };
        assert_eq!(
            store.set_recording(chosen.clone()).unwrap().recording,
            chosen
        );
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording, chosen);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json["recording"],
            serde_json::json!({
                "format": "gif",
                "quality": "medium",
                "fps": 60,
                "showCursor": false,
                "showClicks": true,
                "showKeystrokes": false,
                "audio": "none",
                "microphone": null,
                "showWebcam": false,
                "camera": null,
                "webcamShape": "squircle",
                "mirrorWebcam": true,
                "countdown": 0,
                "source": "region",
            })
        );
        assert_eq!(json["showInDock"], false);

        // One bad value keeps its default; the other still loads.
        fs::write(
            &path,
            r#"{"recording": {"format": "webm", "quality": "low"}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert_eq!(loaded.format, RecordingFormat::Mp4);
        assert_eq!(loaded.quality, RecordingQuality::Low);
        assert_eq!(loaded.fps, 30);
        assert!(loaded.show_cursor);
        assert!(!loaded.show_clicks);
        assert!(!loaded.show_keystrokes);
    }

    #[test]
    fn webcam_is_off_by_default_and_remembered() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let recording = defaults(&dir).recording;
        assert!(!recording.show_webcam);
        assert_eq!(recording.camera, None);
        assert_eq!(recording.webcam_shape, WebcamShape::Squircle);
        assert!(recording.mirror_webcam);
        for (shape, name) in [
            (WebcamShape::Squircle, "squircle"),
            (WebcamShape::Round, "round"),
            (WebcamShape::Arch, "arch"),
            (WebcamShape::Pill, "pill"),
            (WebcamShape::Wide, "wide"),
            (WebcamShape::Blob, "blob"),
        ] {
            assert_eq!(shape.as_str(), name);
            assert_eq!(serde_json::to_value(shape).unwrap(), name);
        }

        let mut store = open_store(path.clone(), defaults(&dir));
        let chosen = RecordingSettings {
            show_webcam: true,
            camera: Some("c0ffee".into()),
            webcam_shape: WebcamShape::Pill,
            mirror_webcam: false,
            ..RecordingSettings::default()
        };
        assert_eq!(
            store.set_recording(chosen.clone()).unwrap().recording,
            chosen
        );
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording, chosen);

        // An empty id is the system's default camera.
        let blank = RecordingSettings {
            camera: Some(String::new()),
            ..chosen
        };
        assert_eq!(store.set_recording(blank).unwrap().recording.camera, None);

        // An unknown shape or a wrong type keeps its default.
        fs::write(
            &path,
            r#"{"recording": {"showWebcam": "yes", "camera": 3, "webcamShape": "star", "mirrorWebcam": "no"}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert!(!loaded.show_webcam);
        assert_eq!(loaded.camera, None);
        assert_eq!(loaded.webcam_shape, WebcamShape::Squircle);
        assert!(loaded.mirror_webcam);
        // A shape saved as "rounded" is the squircle that replaced it.
        fs::write(
            &path,
            r#"{"recording": {"showWebcam": true, "camera": "cam", "webcamShape": "rounded", "mirrorWebcam": false}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert!(loaded.show_webcam);
        assert_eq!(loaded.camera.as_deref(), Some("cam"));
        assert_eq!(loaded.webcam_shape, WebcamShape::Squircle);
        assert!(!loaded.mirror_webcam);
    }

    #[test]
    fn a_countdown_is_off_by_default_and_one_of_the_offered_lengths() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert_eq!(defaults(&dir).recording.countdown, 0);
        let mut store = open_store(path.clone(), defaults(&dir));
        let three = RecordingSettings {
            countdown: 3,
            ..RecordingSettings::default()
        };
        assert_eq!(store.set_recording(three).unwrap().recording.countdown, 3);
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording.countdown, 3);
        let odd = RecordingSettings {
            countdown: 7,
            ..RecordingSettings::default()
        };
        assert!(store.set_recording(odd).is_err());
        fs::write(&path, r#"{"recording": {"countdown": 4}}"#).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording.countdown, 0);
    }

    #[test]
    fn the_record_source_starts_on_region_and_remembers_the_last_one() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert_eq!(defaults(&dir).recording.source, RecordingSource::Region);
        let mut store = open_store(path.clone(), defaults(&dir));
        let window = RecordingSettings {
            source: RecordingSource::Window,
            ..RecordingSettings::default()
        };
        assert_eq!(
            store.set_recording(window).unwrap().recording.source,
            RecordingSource::Window
        );
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().recording.source,
            RecordingSource::Window
        );
        fs::write(&path, r#"{"recording": {"source": "screen"}}"#).unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().recording.source,
            RecordingSource::Screen
        );
        // An unknown source keeps the default.
        fs::write(&path, r#"{"recording": {"source": "tab"}}"#).unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().recording.source,
            RecordingSource::Region
        );
    }

    #[test]
    fn recording_frame_rate_is_30_or_60() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // An unknown rate or a wrong type keeps its default.
        fs::write(&path, r#"{"recording": {"fps": 24, "showCursor": "no"}}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().recording;
        assert_eq!(loaded.fps, 30);
        assert!(loaded.show_cursor);
        fs::write(&path, r#"{"recording": {"fps": 60}}"#).unwrap();
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording.fps, 60);

        let mut store = open_store(path.clone(), defaults(&dir));
        let odd = RecordingSettings {
            fps: 25,
            ..RecordingSettings::default()
        };
        assert!(store.set_recording(odd).is_err());
        assert_eq!(load(&path, defaults(&dir)).unwrap().recording.fps, 60);
    }

    #[test]
    fn retention_keeps_everything_forever_in_the_trash_by_default() {
        let dir = TempDir::new().unwrap();
        let retention = defaults(&dir).retention;
        assert_eq!(
            retention,
            Retention {
                image: None,
                gif: None,
                video: None,
                removal: Removal::Trash,
            }
        );
    }

    #[test]
    fn an_older_settings_file_without_retention_keeps_everything() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"showInDock": false, "recording": {"fps": 60}}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.retention, Retention::default());
        assert!(!loaded.show_in_dock);
    }

    #[test]
    fn retention_is_read_leniently() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"retention": {"image": 0, "gif": "soon", "video": 30, "removal": "shred"}}"#,
        )
        .unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().retention,
            Retention {
                video: Some(30),
                ..Retention::default()
            }
        );
    }

    #[test]
    fn retention_is_saved_and_kept_whole() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        let chosen = Retention {
            image: Some(365),
            gif: Some(90),
            video: Some(7),
            removal: Removal::Permanent,
        };
        assert_eq!(store.set_retention(chosen).unwrap().retention, chosen);
        assert_eq!(load(&path, defaults(&dir)).unwrap().retention, chosen);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json["retention"],
            serde_json::json!({ "image": 365, "gif": 90, "video": 7, "removal": "permanent" })
        );
    }

    #[test]
    fn retention_of_zero_days_is_refused() {
        let dir = TempDir::new().unwrap();
        let mut store = open_store(settings_path(&dir), defaults(&dir));
        let zero = Retention {
            gif: Some(0),
            ..Retention::default()
        };
        assert!(store.set_retention(zero).is_err());
        assert_eq!(store.get().retention, Retention::default());
    }

    #[test]
    fn permission_setup_is_off_by_default_and_read_leniently() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        assert_eq!(defaults(&dir).permissions, PermissionSetup::default());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"permissions": {"asked": true, "resume": "yes"}}"#,
        )
        .unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().permissions,
            PermissionSetup {
                asked: true,
                resume: false,
            }
        );
    }

    #[test]
    fn permission_setup_is_saved() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        let setup = PermissionSetup {
            asked: true,
            resume: true,
        };
        assert_eq!(
            store.set_permission_setup(setup).unwrap().permissions,
            setup
        );
        assert_eq!(load(&path, defaults(&dir)).unwrap().permissions, setup);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json["permissions"],
            serde_json::json!({ "asked": true, "resume": true })
        );
    }

    #[test]
    fn set_preferences_and_other_saves_keep_the_permission_setup() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        let setup = PermissionSetup {
            asked: true,
            resume: true,
        };
        store.set_permission_setup(setup).unwrap();
        let updated = store
            .set_preferences(Preferences {
                after_capture: AfterCapture::Editor,
                ..Preferences::default()
            })
            .unwrap();
        assert_eq!(updated.permissions, setup);
        // A frontend that never heard of it saves without it.
        let update: PreferencesUpdate =
            serde_json::from_str(r#"{"afterCapture": "nothing", "copyToClipboard": false}"#)
                .unwrap();
        assert_eq!(store.set_preferences(update).unwrap().permissions, setup);
        assert_eq!(store.set_show_in_dock(false).unwrap().permissions, setup);
        assert_eq!(load(&path, defaults(&dir)).unwrap().permissions, setup);
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
        let store = open_store(path.clone(), defaults(&dir));
        assert_eq!(store.get(), &defaults(&dir));
        // The unreadable file is left alone until the user changes a setting.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn set_save_folder_creates_the_folder_and_persists() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
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
        let mut store = open_store(settings_path(&dir), defaults(&dir));
        let folder = dir.path().join("Trimmed");
        let input = format!("  {}  ", folder.display());
        assert_eq!(store.set_save_folder(&input).unwrap().save_folder, folder);
    }

    #[test]
    fn set_save_folder_rejects_empty_and_relative_paths() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));

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
        // Settings from before All-in-one get its default.
        assert_eq!(loaded.hotkeys.all_in_one, Hotkeys::default().all_in_one);
        // ...and so do those from before step capture.
        assert_eq!(loaded.hotkeys.steps, Hotkeys::default().steps);
        assert_eq!(
            loaded.hotkeys.steps,
            if cfg!(target_os = "macos") {
                "Cmd+Shift+8"
            } else {
                "Ctrl+Alt+Shift+PrintScreen"
            }
        );
    }

    #[test]
    fn the_all_in_one_hotkey_is_read_and_written_as_all_in_one() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"hotkeys": {"allInOne": "Ctrl+Shift+A"}}"#).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.hotkeys.all_in_one, "Ctrl+Shift+A");
        let value = serde_json::to_value(&loaded.hotkeys).unwrap();
        assert_eq!(value["allInOne"], "Ctrl+Shift+A");
    }

    #[test]
    fn set_hotkeys_persists_and_keeps_the_folder() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
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
        let mut store = open_store(path.clone(), defaults(&dir));
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
        let mut store = open_store(path.clone(), defaults(&dir));
        assert!(store.is_first_run());
        store.finish_first_run().unwrap();
        assert!(!store.is_first_run());
        assert_eq!(load(&path, defaults(&dir)).unwrap(), defaults(&dir));

        // The next launch finds the file: not a first run.
        let again = open_store(path, defaults(&dir));
        assert!(!again.is_first_run());
    }

    #[test]
    fn set_hotkeys_rejects_duplicates_without_writing() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
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
        // Tidying text is on, but only works once AI is.
        assert!(ai.tidy_text);
        assert!(!ai.tidies_text());
        assert!(
            AiSettings {
                enabled: true,
                ..ai.clone()
            }
            .tidies_text()
        );
        assert_eq!(ai.endpoint, "http://localhost:11434/v1");
        assert_eq!(ai.model, "qwen3-vl:4b");
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
    fn a_saved_model_survives_the_new_default() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"ai": {"enabled": true, "provider": "endpoint", "model": "qwen2.5vl:7b"}}"#,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap().preferences.ai;
        assert_eq!(loaded.model, "qwen2.5vl:7b");
        assert_ne!(DEFAULT_AI_MODEL, "qwen2.5vl:7b");
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
                "model": "qwen3-vl:4b",
                "claudeModel": "haiku",
                "codexModel": "",
                "apiKey": null,
                "newCapturesOnly": true,
                "tidyText": true,
                "noticePending": false,
                "apiKeyStorage": "settingsFile",
            })
        );
    }

    #[test]
    fn set_preferences_without_ai_keeps_the_current_ai_settings() {
        let dir = TempDir::new().unwrap();
        let mut store = open_store(settings_path(&dir), defaults(&dir));
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
        let mut store = open_store(path.clone(), defaults(&dir));
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
                claude_model: " claude-sonnet-4-5 ".into(),
                codex_model: " \"gpt 5\" ".into(),
                api_key: Some("  ".into()),
                new_captures_only: false,
                tidy_text: false,
                notice_pending: false,
                api_key_storage: ApiKeyStorage::Keychain,
            }))
            .unwrap();
        let ai = &updated.preferences.ai;
        // Model names are kept without spaces or quotes.
        assert_eq!(ai.claude_model, "claude-sonnet-4-5");
        assert_eq!(ai.codex_model, "gpt5");
        assert_eq!(ai.endpoint, "https://api.example.com/v1");
        assert_eq!(ai.model, "gpt-4o-mini");
        assert_eq!(ai.api_key, None);
        // Where the key is kept is the store's to say, not the caller's.
        assert_eq!(ai.api_key_storage, ApiKeyStorage::SettingsFile);
        // Turning tidying off is kept, and saved.
        assert!(!ai.tidy_text);
        assert!(!ai.tidies_text());
        assert!(
            !load(&path, defaults(&dir))
                .unwrap()
                .preferences
                .ai
                .tidy_text
        );

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
        let mut store = open_store(settings_path(&dir), defaults(&dir));
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
        let picked = AiSettings {
            provider: Some(AiProvider::ClaudeCode),
            claude_model: "opus".into(),
            ..AiSettings::default()
        };
        assert_eq!(picked.model_label(), "claude-code/opus");
        let codex = AiSettings {
            provider: Some(AiProvider::Codex),
            codex_model: "gpt-5-mini".into(),
            ..AiSettings::default()
        };
        assert_eq!(codex.model_label(), "codex/gpt-5-mini");
        assert_eq!(
            AiSettings {
                claude_model: " ".into(),
                ..AiSettings::default()
            }
            .claude_model(),
            "haiku"
        );
        let codex = store
            .set_preferences(Preferences {
                ai: AiSettings {
                    provider: Some(AiProvider::Codex),
                    ..ai.clone()
                },
                ..Preferences::default()
            })
            .unwrap();
        assert_eq!(codex.preferences.ai.provider(), AiProvider::Codex);
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
        let codex = read(r#"{"ai": {"enabled": true, "provider": "codex"}}"#);
        assert_eq!(codex.provider, Some(AiProvider::Codex));
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
        let mut store = open_store(path.clone(), defaults(&dir));

        let before = store.enable_cli_provider(AiProvider::ClaudeCode).unwrap();

        assert_eq!(before, Some(AiSettings::default()));
        let ai = load(&path, defaults(&dir)).unwrap().preferences.ai;
        assert!(ai.enabled);
        assert_eq!(ai.provider, Some(AiProvider::ClaudeCode));
        assert!(ai.new_captures_only);
        assert!(ai.notice_pending);
        // The endpoint fields are kept for whoever switches back.
        assert_eq!(ai.endpoint, DEFAULT_AI_ENDPOINT);
        assert_eq!(
            store.enable_cli_provider(AiProvider::ClaudeCode).unwrap(),
            None
        );

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
        assert_eq!(
            store.enable_cli_provider(AiProvider::ClaudeCode).unwrap(),
            None
        );
        assert!(!store.get().preferences.ai.enabled);
    }

    #[test]
    fn codex_is_turned_on_the_same_way() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));

        let before = store.enable_cli_provider(AiProvider::Codex).unwrap();

        assert_eq!(before, Some(AiSettings::default()));
        let ai = load(&path, defaults(&dir)).unwrap().preferences.ai;
        assert!(ai.enabled);
        assert_eq!(ai.provider, Some(AiProvider::Codex));
        assert!(ai.new_captures_only);
        assert!(ai.notice_pending);
        assert_eq!(ai.model_label(), "codex");
        // Once set, neither CLI changes it.
        assert_eq!(
            store.enable_cli_provider(AiProvider::ClaudeCode).unwrap(),
            None
        );
        assert_eq!(store.get().preferences.ai.provider, Some(AiProvider::Codex));
    }

    #[test]
    fn an_existing_endpoint_user_is_not_switched() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"ai": {"enabled": true, "model": "llava"}}"#).unwrap();
        let mut store = open_store(path.clone(), defaults(&dir));
        assert_eq!(
            store.enable_cli_provider(AiProvider::ClaudeCode).unwrap(),
            None
        );
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
        let mut store = open_store(path.clone(), defaults(&dir));
        store.enable_cli_provider(AiProvider::ClaudeCode).unwrap();
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

    #[test]
    fn the_api_key_is_saved_in_the_keychain_and_not_the_file() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let keys = MemoryKeyStore::default();
        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));

        let updated = store.set_preferences(with_key(Some(" sk-1 "))).unwrap();

        assert_eq!(keys.stored().as_deref(), Some("sk-1"));
        let ai = &updated.preferences.ai;
        assert_eq!(ai.api_key.as_deref(), Some("sk-1"));
        assert_eq!(ai.api_key_storage, ApiKeyStorage::Keychain);
        let on_disk = ai_on_disk(&path);
        assert_eq!(on_disk.get("apiKey"), None, "{on_disk}");
        assert_eq!(on_disk.get("apiKeyStorage"), None, "{on_disk}");
        assert_eq!(on_disk["model"], "gpt-5-mini");
        // The frontend is told where the key is.
        let json = serde_json::to_value(&updated).unwrap();
        assert_eq!(json["ai"]["apiKey"], "sk-1");
        assert_eq!(json["ai"]["apiKeyStorage"], "keychain");

        // The next start reads it back from the keychain.
        let again =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        assert_eq!(again.get(), &updated);

        // Clearing the key removes it from the keychain.
        let cleared = store.set_preferences(with_key(None)).unwrap();
        assert_eq!(cleared.preferences.ai.api_key, None);
        assert_eq!(keys.stored(), None);
        assert_eq!(ai_on_disk(&path).get("apiKey"), None);
    }

    #[test]
    fn saving_other_settings_leaves_the_keychain_alone() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let keys = MemoryKeyStore::default();
        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        store.set_preferences(with_key(Some("sk-1"))).unwrap();
        // Saves that keep the key never touch the keychain, so one that
        // stopped working costs them nothing.
        keys.set_broken(true);
        let mut same = with_key(Some("sk-1"));
        same.after_capture = AfterCapture::Editor;
        let updated = store.set_preferences(same).unwrap();
        assert_eq!(
            updated.preferences.ai.api_key_storage,
            ApiKeyStorage::Keychain
        );
        store
            .set_save_folder(dir.path().join("Shots").to_str().unwrap())
            .unwrap();
        assert_eq!(ai_on_disk(&path).get("apiKey"), None);
    }

    #[test]
    fn a_key_in_the_file_moves_into_the_keychain_on_start() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"copyToClipboard": false, "ai": {"enabled": true, "model": "llava", "apiKey": "sk-old"}}"#,
        )
        .unwrap();
        // A key left in the keychain from before is replaced by the file's.
        let keys = MemoryKeyStore::with_key("sk-stale");

        let store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));

        assert_eq!(keys.stored().as_deref(), Some("sk-old"));
        let ai = &store.get().preferences.ai;
        assert_eq!(ai.api_key.as_deref(), Some("sk-old"));
        assert_eq!(ai.api_key_storage, ApiKeyStorage::Keychain);
        let on_disk = ai_on_disk(&path);
        assert_eq!(on_disk.get("apiKey"), None, "{on_disk}");
        // The rest of the file is kept.
        assert_eq!(on_disk["model"], "llava");
        assert_eq!(on_disk["enabled"], true);
        assert!(
            !load(&path, defaults(&dir))
                .unwrap()
                .preferences
                .copy_to_clipboard
        );
        assert!(!store.is_first_run());

        // Started again, the key comes from the keychain alone.
        let again = SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys));
        assert_eq!(
            again.get().preferences.ai.api_key.as_deref(),
            Some("sk-old")
        );
    }

    #[test]
    fn opening_without_a_key_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let store = SettingsStore::open_with_keys(
            path.clone(),
            defaults(&dir),
            Box::new(MemoryKeyStore::with_key("sk-1")),
        );
        assert!(store.is_first_run());
        assert!(!path.exists());
        assert_eq!(store.get().preferences.ai.api_key.as_deref(), Some("sk-1"));

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"ai": {"enabled": true, "model": "llava"}}"#).unwrap();
        SettingsStore::open_with_keys(
            path.clone(),
            defaults(&dir),
            Box::new(MemoryKeyStore::default()),
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"ai": {"enabled": true, "model": "llava"}}"#
        );
    }

    #[test]
    fn without_a_keychain_the_key_stays_in_the_file() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = r#"{"ai": {"enabled": true, "model": "llava", "apiKey": "sk-old"}}"#;
        fs::write(&path, text).unwrap();
        let keys = MemoryKeyStore::unavailable();

        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));

        let ai = &store.get().preferences.ai;
        assert_eq!(ai.api_key.as_deref(), Some("sk-old"));
        assert_eq!(ai.api_key_storage, ApiKeyStorage::SettingsFile);
        // Nothing was moved, so nothing was rewritten.
        assert_eq!(fs::read_to_string(&path).unwrap(), text);

        let updated = store.set_preferences(with_key(Some("sk-new"))).unwrap();
        assert_eq!(
            updated.preferences.ai.api_key_storage,
            ApiKeyStorage::SettingsFile
        );
        assert_eq!(ai_on_disk(&path)["apiKey"], "sk-new");
        assert_eq!(ai_on_disk(&path).get("apiKeyStorage"), None);
        assert_eq!(keys.stored(), None);
        let json = serde_json::to_value(&updated).unwrap();
        assert_eq!(json["ai"]["apiKeyStorage"], "settingsFile");
    }

    #[test]
    fn a_keychain_that_fails_on_save_keeps_the_key_in_the_file() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let keys = MemoryKeyStore::default();
        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        assert_eq!(
            store.get().preferences.ai.api_key_storage,
            ApiKeyStorage::Keychain
        );
        keys.set_broken(true);

        let updated = store.set_preferences(with_key(Some("sk-1"))).unwrap();

        assert_eq!(
            updated.preferences.ai.api_key_storage,
            ApiKeyStorage::SettingsFile
        );
        assert_eq!(ai_on_disk(&path)["apiKey"], "sk-1");
        // Working again at the next start, the key moves into it.
        keys.set_broken(false);
        let again =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        assert_eq!(keys.stored().as_deref(), Some("sk-1"));
        assert_eq!(again.get().preferences.ai.api_key.as_deref(), Some("sk-1"));
        assert_eq!(ai_on_disk(&path).get("apiKey"), None);
    }

    #[test]
    fn a_cleared_key_that_the_keychain_cannot_remove_fails_the_save() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let keys = MemoryKeyStore::default();
        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        store.set_preferences(with_key(Some("sk-1"))).unwrap();
        keys.set_broken(true);

        assert!(matches!(
            store.set_preferences(with_key(None)),
            Err(SettingsError::Invalid(_))
        ));

        // Nothing changed, so the key the user still sees is the one used.
        assert_eq!(store.get().preferences.ai.api_key.as_deref(), Some("sk-1"));
        assert_eq!(keys.stored().as_deref(), Some("sk-1"));
        // Working again, clearing removes it and it does not come back.
        keys.set_broken(false);
        store.set_preferences(with_key(None)).unwrap();
        assert_eq!(keys.stored(), None);
        let again =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        assert_eq!(again.get().preferences.ai.api_key, None);
    }

    #[test]
    fn clearing_a_key_after_a_fallback_removes_the_keychains_copy() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let keys = MemoryKeyStore::default();
        let mut store =
            SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys.clone()));
        store.set_preferences(with_key(Some("sk-1"))).unwrap();
        // The keychain fails once: sk-2 goes into the file, sk-1 stays behind.
        keys.set_broken(true);
        let fell_back = store.set_preferences(with_key(Some("sk-2"))).unwrap();
        assert_eq!(
            fell_back.preferences.ai.api_key_storage,
            ApiKeyStorage::SettingsFile
        );
        keys.set_broken(false);

        store.set_preferences(with_key(None)).unwrap();

        assert_eq!(keys.stored(), None);
        assert_eq!(ai_on_disk(&path).get("apiKey"), None);
        let again = SettingsStore::open_with_keys(path.clone(), defaults(&dir), Box::new(keys));
        assert_eq!(again.get().preferences.ai.api_key, None);
    }

    #[test]
    fn without_a_keychain_the_key_can_still_be_cleared() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = SettingsStore::open_with_keys(
            path.clone(),
            defaults(&dir),
            Box::new(MemoryKeyStore::unavailable()),
        );
        store.set_preferences(with_key(Some("sk-1"))).unwrap();
        let cleared = store.set_preferences(with_key(None)).unwrap();
        assert_eq!(cleared.preferences.ai.api_key, None);
        assert_eq!(ai_on_disk(&path).get("apiKey"), None);
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
            text_style: Some("outline".into()),
            blur_mode: Some("blur".into()),
            backdrop: Some(serde_json::json!({
                "fill": "aurora", "padding": 48, "radius": 36, "shadow": true, "aspect": "16:9"
            })),
            auto_backdrop: None,
            show_pointer: None,
            backdrop_presets: Vec::new(),
            favorite_colors: Vec::new(),
        }
    }

    fn preset(id: &str, name: &str) -> BackdropPreset {
        BackdropPreset {
            id: id.into(),
            name: name.into(),
            backdrop: serde_json::json!({
                "fill": "ocean", "padding": 40, "radius": 12, "shadow": true
            }),
        }
    }

    #[test]
    fn editor_preferences_round_trip_beside_the_other_settings() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
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
        assert_eq!(json["editor"]["textStyle"], "outline");
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
                    "textStyle": 3,
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
        let mut store = open_store(path.clone(), defaults(&dir));
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
    fn show_pointer_is_off_until_set_and_kept_by_the_editor() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        assert_eq!(store.get().editor.show_pointer, None);

        let updated = store.set_show_pointer(true).unwrap();
        assert_eq!(updated.editor.show_pointer, Some(true));
        let saved = store.set_editor_preferences(editor_preferences()).unwrap();
        assert_eq!(saved.show_pointer, Some(true));
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"]["showPointer"], true);

        store.set_show_pointer(false).unwrap();
        assert_eq!(
            load(&path, defaults(&dir)).unwrap().editor.show_pointer,
            Some(false)
        );
    }

    #[test]
    fn auto_backdrop_is_set_by_settings_and_kept_by_the_editor() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
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

    #[test]
    fn backdrop_presets_are_read_key_by_key() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r##"{"editor": {"color": "#e5484d", "backdropPresets": [
                {"id": "p1", "name": "House", "backdrop": {"fill": "ocean", "padding": 40, "radius": 12, "shadow": true}},
                {"id": "p2", "name": "No backdrop", "backdrop": "ocean"},
                {"id": 3, "name": "Bad id", "backdrop": {}},
                {"name": "No id", "backdrop": {}},
                "junk"
            ]}}"##,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.backdrop_presets, vec![preset("p1", "House")]);
        assert_eq!(loaded.editor.color.as_deref(), Some("#e5484d"));

        // A list that is not a list costs only the presets.
        fs::write(
            &path,
            r##"{"editor": {"color": "#e5484d", "backdropPresets": {"id": "p1"}}}"##,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert!(loaded.editor.backdrop_presets.is_empty());
        assert_eq!(loaded.editor.color.as_deref(), Some("#e5484d"));
    }

    #[test]
    fn at_most_24_backdrop_presets_are_read() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let presets: Vec<_> = (0..30)
            .map(|i| preset(&format!("p{i}"), &format!("Preset {i}")))
            .collect();
        let text = serde_json::json!({"editor": {"backdropPresets": presets}}).to_string();
        fs::write(&path, text).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.backdrop_presets.len(), MAX_BACKDROP_PRESETS);
        assert_eq!(loaded.editor.backdrop_presets[0].id, "p0");
    }

    #[test]
    fn the_editors_saves_keep_the_backdrop_presets() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        store
            .set_backdrop_presets(vec![preset("p1", "House")])
            .unwrap();

        // The editor saves its choices without the presets; they stay.
        let saved = store.set_editor_preferences(editor_preferences()).unwrap();
        assert_eq!(saved.backdrop_presets, vec![preset("p1", "House")]);
        assert_eq!(saved.color, editor_preferences().color);
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.backdrop_presets, vec![preset("p1", "House")]);
    }

    #[test]
    fn set_backdrop_presets_replaces_the_whole_list() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        store.set_editor_preferences(editor_preferences()).unwrap();
        store.set_auto_backdrop(true).unwrap();

        let kept = store
            .set_backdrop_presets(vec![preset("p1", "House"), preset("p2", "House")])
            .unwrap();
        assert_eq!(kept, vec![preset("p1", "House"), preset("p2", "House")]);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"]["backdropPresets"][1]["id"], "p2");
        assert_eq!(
            json["editor"]["backdropPresets"][0]["backdrop"]["fill"],
            "ocean"
        );

        let kept = store
            .set_backdrop_presets(vec![preset("p2", "Renamed")])
            .unwrap();
        assert_eq!(kept, vec![preset("p2", "Renamed")]);
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(
            loaded.editor.backdrop_presets,
            vec![preset("p2", "Renamed")]
        );
        // The editor's other choices and auto-apply are kept.
        assert_eq!(loaded.editor.backdrop, editor_preferences().backdrop);
        assert_eq!(loaded.editor.auto_backdrop, Some(true));

        // Deleting the last one leaves no key behind.
        assert!(store.set_backdrop_presets(Vec::new()).unwrap().is_empty());
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"].get("backdropPresets"), None);
    }

    #[test]
    fn set_backdrop_presets_keeps_at_most_24_with_object_backdrops() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path, defaults(&dir));
        let mut presets = vec![BackdropPreset {
            backdrop: serde_json::json!("ocean"),
            ..preset("bad", "Bad")
        }];
        presets.extend((0..30).map(|i| preset(&format!("p{i}"), "Preset")));
        let kept = store.set_backdrop_presets(presets).unwrap();
        assert_eq!(kept.len(), MAX_BACKDROP_PRESETS);
        assert_eq!(kept[0].id, "p0");
    }

    #[test]
    fn favorite_colors_are_read_key_by_key() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r##"{"editor": {"color": "#e5484d", "favoriteColors": ["#FF8800", 3, "red", "#ff8800", "#123abc"]}}"##,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.favorite_colors, vec!["#ff8800", "#123abc"]);
        assert_eq!(loaded.editor.color.as_deref(), Some("#e5484d"));

        // A list of the wrong type costs only the favourites.
        fs::write(
            &path,
            r##"{"editor": {"color": "#e5484d", "favoriteColors": "#ff8800"}}"##,
        )
        .unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert!(loaded.editor.favorite_colors.is_empty());
        assert_eq!(loaded.editor.color.as_deref(), Some("#e5484d"));
    }

    #[test]
    fn at_most_8_favorite_colors_are_read() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let colors: Vec<String> = (0..12).map(|i| format!("#0000{i:02x}")).collect();
        let text = serde_json::json!({"editor": {"favoriteColors": colors}}).to_string();
        fs::write(&path, text).unwrap();
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.favorite_colors, colors[..MAX_FAVORITE_COLORS]);
    }

    #[test]
    fn the_editors_saves_keep_the_favorite_colors() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        store.set_favorite_colors(vec!["#ff8800".into()]).unwrap();

        // The editor saves its choices without the favourites; they stay.
        let saved = store.set_editor_preferences(editor_preferences()).unwrap();
        assert_eq!(saved.favorite_colors, vec!["#ff8800"]);
        assert_eq!(saved.color, editor_preferences().color);
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.favorite_colors, vec!["#ff8800"]);
    }

    #[test]
    fn set_favorite_colors_replaces_the_whole_list() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path.clone(), defaults(&dir));
        store.set_editor_preferences(editor_preferences()).unwrap();
        store
            .set_backdrop_presets(vec![preset("p1", "House")])
            .unwrap();

        let kept = store
            .set_favorite_colors(vec!["#ff8800".into(), "#123ABC".into()])
            .unwrap();
        assert_eq!(kept, vec!["#ff8800", "#123abc"]);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"]["favoriteColors"][1], "#123abc");

        let kept = store.set_favorite_colors(vec!["#123abc".into()]).unwrap();
        assert_eq!(kept, vec!["#123abc"]);
        let loaded = load(&path, defaults(&dir)).unwrap();
        assert_eq!(loaded.editor.favorite_colors, vec!["#123abc"]);
        // The editor's other choices and the presets are kept.
        assert_eq!(loaded.editor.color, editor_preferences().color);
        assert_eq!(loaded.editor.backdrop_presets, vec![preset("p1", "House")]);

        // Removing the last one leaves no key behind.
        assert!(store.set_favorite_colors(Vec::new()).unwrap().is_empty());
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["editor"].get("favoriteColors"), None);
    }

    #[test]
    fn set_favorite_colors_keeps_at_most_8_distinct_hex_colours() {
        let dir = TempDir::new().unwrap();
        let path = settings_path(&dir);
        let mut store = open_store(path, defaults(&dir));
        let mut colors = vec![
            "not a colour".to_owned(),
            "#ggg000".to_owned(),
            "#ff8800".to_owned(),
            "#FF8800".to_owned(),
        ];
        colors.extend((0..12).map(|i| format!("#0000{i:02x}")));
        let kept = store.set_favorite_colors(colors).unwrap();
        assert_eq!(kept.len(), MAX_FAVORITE_COLORS);
        assert_eq!(kept[0], "#ff8800");
        assert_eq!(kept[1], "#000000");
    }
}
