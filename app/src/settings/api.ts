import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirrors `AfterCapture` in src-tauri/src/settings.rs. */
export type AfterCapture = "quickAccess" | "editor" | "nothing";

/** Mirrors `Preferences` in src-tauri/src/settings.rs. */
export interface Preferences {
  afterCapture: AfterCapture;
  copyToClipboard: boolean;
  ai: AiPreferences;
}

/** Mirrors `AiProvider` in src-tauri/src/settings.rs: who describes captures. */
export type AiProvider = "claudeCode" | "codex" | "endpoint";

/** Mirrors `ApiKeyStorage` in src-tauri/src/settings.rs: where the endpoint API key is kept. */
export type ApiKeyStorage = "keychain" | "settingsFile";

/** Mirrors `AiSettings` in src-tauri/src/settings.rs: the vision model that describes captures. */
export interface AiPreferences {
  enabled: boolean;
  /**
   * Null until a provider was picked, or Grab-it picked Claude Code or Codex
   * because it is installed; it then works as "endpoint" (see {@link aiProvider}).
   */
  provider: AiProvider | null;
  /** An OpenAI-compatible API base URL, such as Ollama's. Only the endpoint provider uses it. */
  endpoint: string;
  /** Only the endpoint provider uses it. */
  model: string;
  /** The model Claude Code is asked for: an alias (haiku, sonnet, opus) or a full name. Empty means haiku. */
  claudeModel: string;
  /** The model Codex is asked for. Empty means the one set up in Codex itself. */
  codexModel: string;
  /** Only cloud providers need one. */
  apiKey: string | null;
  /** Leave captures from before AI descriptions were turned on alone. */
  newCapturesOnly: boolean;
  /** Text captures are read again by the same AI, which fixes OCR mistakes and lays out JSON, code and tables. Only while {@link enabled}. */
  tidyText: boolean;
  /** Grab-it turned describing on by itself and the Library has not said so yet. Only the backend changes it. */
  noticePending: boolean;
  /** Where {@link apiKey} is kept: the OS keychain, or settings.json when there is none. Only the backend changes it. */
  apiKeyStorage: ApiKeyStorage;
}

/** What the backend starts with. */
export const DEFAULT_AI_PREFERENCES: AiPreferences = {
  enabled: false,
  provider: null,
  endpoint: "http://localhost:11434/v1",
  model: "qwen3-vl:4b",
  claudeModel: "haiku",
  codexModel: "",
  apiKey: null,
  newCapturesOnly: true,
  tidyText: true,
  noticePending: false,
  apiKeyStorage: "settingsFile",
};

/** The provider describing uses: an unset one is the endpoint, as in `AiSettings::provider`. */
export function aiProvider(ai: Pick<AiPreferences, "provider"> | null | undefined): AiProvider {
  return ai?.provider ?? "endpoint";
}

/** The providers in the order Settings lists them. */
export const AI_PROVIDERS: { value: AiProvider; title: string; hint: string }[] = [
  {
    value: "claudeCode",
    title: "Claude Code",
    hint: "Uses the claude command you already have and are signed in to. Nothing to set up or download.",
  },
  {
    value: "codex",
    title: "Codex",
    hint: "Uses the codex command you already have and are signed in to. Nothing to set up or download.",
  },
  {
    value: "endpoint",
    title: "OpenAI-compatible endpoint",
    hint: "Ollama or LM Studio on this computer, or a cloud API such as OpenAI or OpenRouter.",
  },
];

/** Claude Code's model aliases, offered as suggestions. */
export const CLAUDE_MODELS: { value: string; hint: string }[] = [
  { value: "haiku", hint: "Fastest and cheapest" },
  { value: "sonnet", hint: "More detail" },
  { value: "opus", hint: "Most capable, slowest" },
];

/** An OpenAI-compatible API the endpoint provider can be pointed at in one step. */
export interface EndpointPreset {
  /** Stable key for the preset menu. */
  id: string;
  name: string;
  endpoint: string;
  /** A vision model the API offers; the user can type another. */
  model: string;
}

/** The endpoint presets in the order Settings lists them. Ollama's matches {@link DEFAULT_AI_PREFERENCES}. */
export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { id: "ollama", name: "Ollama", endpoint: DEFAULT_AI_PREFERENCES.endpoint, model: DEFAULT_AI_PREFERENCES.model },
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-5-mini" },
  { id: "anthropic", name: "Anthropic", endpoint: "https://api.anthropic.com/v1", model: "claude-haiku-5-5" },
  { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-5-mini" },
];

/** The preset an endpoint and model are, or null when they are the user's own. */
export function matchingPreset(endpoint: string, model: string): EndpointPreset | null {
  return ENDPOINT_PRESETS.find((preset) => preset.endpoint === endpoint && preset.model === model) ?? null;
}

/** A provider's name as messages show it. */
export function providerName(provider: AiProvider): string {
  if (provider === "claudeCode") return "Claude Code";
  if (provider === "codex") return "Codex";
  return "the AI endpoint";
}

/** Mirrors `AiClis` in src-tauri/src/ai.rs: where each AI CLI was found, or null when it is not installed. */
export interface AiClis {
  claudeCode: string | null;
  codex: string | null;
}

/** Looks for the AI CLIs Grab-it can run. */
export function aiClis(): Promise<AiClis> {
  return invoke<AiClis>("ai_clis");
}

/** Whether an endpoint URL points at this computer, so screenshots stay on it. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Mirrors `EditorPreferences` in src-tauri/src/settings.rs: the annotation
 * editor's remembered choices. Any key may be missing; the editor checks
 * each value and uses its own default otherwise.
 */
export interface EditorPreferences {
  /** `#rrggbb`. */
  color?: string;
  /** The last tool picked (`Tool` in editor/model.ts). */
  tool?: string;
  /** Each tool's own width in pixels: stroke width, text font size or step badge size. */
  widths?: Record<string, number>;
  fill?: boolean;
  textBackground?: boolean;
  /** `BlurMode` in editor/model.ts. */
  blurMode?: string;
  /** The last backdrop picked (`Backdrop` in editor/model.ts); checked by the editor as it reads it. */
  backdrop?: unknown;
  /** Frame captures that have no annotations yet with `backdrop`. Set from Settings; the editor never writes it. */
  autoBackdrop?: boolean;
  /** Backdrops saved by name. Set with `setBackdropPresets`; the editor's other saves keep them. */
  backdropPresets?: BackdropPreset[];
}

/** Mirrors `MAX_BACKDROP_PRESETS` in src-tauri/src/settings.rs. */
export const MAX_BACKDROP_PRESETS = 24;

/**
 * Mirrors `BackdropPreset` in src-tauri/src/settings.rs: a backdrop saved
 * under a name. Names need not be unique; `id` tells presets apart.
 */
export interface BackdropPreset<B = unknown> {
  id: string;
  name: string;
  /** `Backdrop` in editor/model.ts; checked by the editor as it reads it. */
  backdrop: B;
}

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface Settings extends Preferences {
  saveFolder: string;
  hotkeys: Hotkeys;
  editor?: EditorPreferences;
  /** macOS: a Dock icon that opens the Grab-it window. */
  showInDock?: boolean;
  appearance?: Appearance;
  recording?: RecordingSettings;
}

/** Mirrors `PopupCorner` in src-tauri/src/settings.rs. */
export type PopupCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight";

/** Mirrors `Appearance` in src-tauri/src/settings.rs. */
export interface Appearance {
  /** How big the Grab-it window draws everything, in percent. */
  textScale: number;
  /** The same for the menu bar hub. */
  hubScale: number;
  popupCorner: PopupCorner;
  /** How long the popup stays, in seconds; 0 keeps it until it is closed. */
  popupSeconds: number;
}

export const DEFAULT_APPEARANCE: Appearance = { textScale: 110, hubScale: 110, popupCorner: "bottomRight", popupSeconds: 8 };

/** The text size sliders, in percent. Mirrors `MIN_TEXT_SCALE` and `MAX_TEXT_SCALE` in src-tauri/src/settings.rs. */
export const TEXT_SCALE = { min: 85, max: 130, step: 5 };

/** Mirrors `TextSizeStep` in src-tauri/src/settings.rs: ⌘+, ⌘− and ⌘0. */
export type TextSizeStep = "bigger" | "smaller" | "reset";

/** The text size step a key press asks for, if any: ⌘+ (or ⌘=), ⌘− and ⌘0, with Ctrl off macOS. */
export function textSizeStep(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): TextSizeStep | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  switch (event.key) {
    case "+":
    case "=":
      return "bigger";
    case "-":
    case "_":
      return "smaller";
    case "0":
      return "reset";
    default:
      return null;
  }
}

/** Saves the Grab-it window's text size a step bigger, smaller or back to the default, easing the window to it. */
export function stepTextSize(step: TextSizeStep): Promise<Settings> {
  return invoke<Settings>("step_text_size", { step });
}

/** Mirrors `APPEARANCE_CHANGED_EVENT` in src-tauri/src/commands.rs. */
export const APPEARANCE_CHANGED_EVENT = "appearance-changed";

/** Called when a keyboard shortcut changes the text size. */
export function onAppearanceChanged(handler: (appearance: Appearance) => void): Promise<UnlistenFn> {
  return listen<Appearance>(APPEARANCE_CHANGED_EVENT, (event) => handler(event.payload));
}

export const POPUP_CORNERS: { value: PopupCorner; title: string }[] = [
  { value: "topLeft", title: "Top left" },
  { value: "topRight", title: "Top right" },
  { value: "bottomLeft", title: "Bottom left" },
  { value: "bottomRight", title: "Bottom right" },
];

/** How long the popup can stay; 0 is "until I close it". */
export const POPUP_SECONDS = [3, 5, 8, 12, 20, 30, 0];

export function setAppearance(appearance: Appearance): Promise<Settings> {
  return invoke<Settings>("set_appearance", { appearance });
}

/** Mirrors `RecordingFormat` in src-tauri/src/settings.rs. */
export type RecordingFormat = "gif" | "mp4";

/** Mirrors `RecordingQuality` in src-tauri/src/settings.rs. */
export type RecordingQuality = "low" | "medium" | "high";

/** Mirrors `RecordingSettings::fps` in src-tauri/src/settings.rs: an MP4's frames a second. */
export type RecordingFps = 30 | 60;

/**
 * Mirrors `RecordingAudio` in src-tauri/src/settings.rs: what sound an MP4 records. `system` is what the
 * computer plays; `both` mixes it with the microphone.
 */
export type RecordingAudio = "none" | "microphone" | "system" | "both";

/**
 * Mirrors `RecordingSource` in src-tauri/src/settings.rs: what the Record overlay records, a dragged region, a
 * picked window's area or a whole display.
 */
export type RecordingSource = "region" | "window" | "screen";

/** Mirrors `RecordingSettings` in src-tauri/src/settings.rs. */
export interface RecordingSettings {
  format: RecordingFormat;
  /** MP4 only. */
  quality: RecordingQuality;
  /** MP4 only; a GIF is about 10 fps. */
  fps: RecordingFps;
  /** Draws the pointer into the recording. */
  showCursor: boolean;
  /** Draws a fading ring where each click lands. */
  showClicks: boolean;
  /** Draws the keys pressed as a label at the bottom centre. */
  showKeystrokes: boolean;
  /** MP4 only; a GIF is silent. */
  audio: RecordingAudio;
  /** The `Microphone.id` recorded; null records the system's default microphone. */
  microphone: string | null;
  /** Shows the webcam in a bubble on screen while recording, so it is recorded too. */
  showWebcam: boolean;
  /** The `Camera.id` shown; null shows the system's default camera. */
  camera: string | null;
  /** The bubble's outline. */
  webcamShape: WebcamShape;
  /** Seconds counted down on the recording toolbar before it starts: one of `RECORDING_COUNTDOWNS`. */
  countdown: number;
  /** The source the Record overlay opens on: the one used last. */
  source: RecordingSource;
}

/** Mirrors `RECORDING_COUNTDOWNS` in src-tauri/src/settings.rs; 0 starts at once. */
export const RECORDING_COUNTDOWNS = [0, 3, 5, 10] as const;

export const DEFAULT_RECORDING: RecordingSettings = {
  format: "mp4",
  quality: "high",
  fps: 30,
  showCursor: true,
  showClicks: false,
  showKeystrokes: false,
  audio: "none",
  microphone: null,
  showWebcam: false,
  camera: null,
  webcamShape: "round",
  countdown: 0,
  source: "region",
};

/**
 * The Show keystrokes hint. Only macOS can tell when a password is being typed
 * (secure input), so keys typed then are left out; elsewhere they are not.
 */
export function keystrokesHint(isMac: boolean): string {
  return isMac
    ? "Shows the keys you press at the bottom of the recording, except while you type a password. macOS asks for Input Monitoring the first time."
    : "Shows the keys you press at the bottom of the recording. Grab-it cannot tell when you type a password here, so turn this off first.";
}

export const RECORDING_FORMATS: { value: RecordingFormat; title: string; hint: string }[] = [
  { value: "mp4", title: "MP4 video", hint: "Smooth video with no time limit, small enough to share." },
  { value: "gif", title: "GIF", hint: "Plays anywhere an image does. Silent, about 10 fps, and at most a minute." },
];

export const RECORDING_QUALITIES: { value: RecordingQuality; title: string }[] = [
  { value: "low", title: "Low" },
  { value: "medium", title: "Medium" },
  { value: "high", title: "High" },
];

export const RECORDING_FPS: { value: RecordingFps; title: string }[] = [
  { value: 30, title: "30 fps" },
  { value: 60, title: "60 fps" },
];

export const RECORDING_AUDIO: { value: RecordingAudio; title: string }[] = [
  { value: "none", title: "None" },
  { value: "microphone", title: "Microphone" },
  { value: "system", title: "System sound" },
  { value: "both", title: "Microphone and system sound" },
];

/** The choices that record what the computer plays, which macOS before 13 cannot. */
export function recordsSystemSound(audio: RecordingAudio): boolean {
  return audio === "system" || audio === "both";
}

/** The choices that record the microphone. */
export function recordsMicrophone(audio: RecordingAudio): boolean {
  return audio === "microphone" || audio === "both";
}

/** Mirrors `WebcamShape` in src-tauri/src/settings.rs. */
export type WebcamShape = "round" | "rounded";

export const WEBCAM_SHAPES: { value: WebcamShape; title: string }[] = [
  { value: "round", title: "Round" },
  { value: "rounded", title: "Rounded square" },
];

/** A camera the webview can show. */
export interface Camera {
  /** What `RecordingSettings.camera` saves to pick it: the webview's `deviceId`. */
  id: string;
  name: string;
}

/**
 * The cameras the webview offers, named "Camera 1", "Camera 2" and so on
 * where it hides their names, as it does until a camera has been allowed.
 * With `ask`, a camera is opened for a moment when names are hidden, which
 * asks for the permission where the system wants one and then reveals them.
 */
export async function listCameras(ask = false): Promise<Camera[]> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media || typeof media.enumerateDevices !== "function") return [];
  const read = async () => (await media.enumerateDevices()).filter((device) => device.kind === "videoinput");
  let devices = await read();
  if (ask && devices.some((device) => device.label === "") && typeof media.getUserMedia === "function") {
    try {
      const stream = await media.getUserMedia({ video: true, audio: false });
      for (const track of stream.getTracks()) track.stop();
      devices = await read();
    } catch {
      // Refused or no camera: the list keeps its numbered names.
    }
  }
  return devices
    .filter((device) => device.deviceId !== "")
    .map((device, index) => ({ id: device.deviceId, name: device.label || `Camera ${index + 1}` }));
}

export function setRecording(recording: RecordingSettings): Promise<Settings> {
  return invoke<Settings>("set_recording", { recording });
}

/** Mirrors `MicrophoneInfo` in src-tauri/src/audio.rs. */
export interface Microphone {
  /** What `RecordingSettings.microphone` saves to pick it. */
  id: string;
  name: string;
  isDefault: boolean;
}

/** Whether what the computer plays can be recorded here: on Windows, Linux and macOS 13 or later. */
export function systemSoundAvailable(): Promise<boolean> {
  return invoke<boolean>("recording_system_audio");
}

/** The microphones that can be recorded. On Linux, empty until ffmpeg is ready, which lists them. */
export function listMicrophones(): Promise<Microphone[]> {
  return invoke<Microphone[]>("recording_microphones");
}

/** Mirrors `FfmpegStatus` in src-tauri/src/ffmpeg.rs: whether MP4 can be recorded yet. */
export type FfmpegStatus =
  | { state: "missing" }
  /** `total` is 0 until the server says. */
  | { state: "downloading"; downloaded: number; total: number }
  | { state: "checking" }
  /** `path` is the ffmpeg in use: one already installed, or the one Grab-it downloaded. */
  | { state: "ready"; path: string; encoder: string }
  /** None is installed and none can be downloaded here; `install` is the command that installs one. */
  | { state: "notInstalled"; install: string | null }
  | { state: "failed"; message: string };

/** Mirrors `FFMPEG_STATUS_EVENT` in src-tauri/src/ffmpeg.rs. */
export const FFMPEG_STATUS_EVENT = "ffmpeg-status";

export function ffmpegStatus(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("ffmpeg_status");
}

/** Looks for ffmpeg again, downloading it or finding an encoder; resolves to the status as it starts. */
export function retryFfmpeg(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("ffmpeg_retry");
}

export function onFfmpegStatus(handler: (status: FfmpegStatus) => void): Promise<UnlistenFn> {
  return listen<FfmpegStatus>(FFMPEG_STATUS_EVENT, (event) => handler(event.payload));
}

/** Settings, split into the pages of the Grab-it window's sidebar. */
export type SettingsSection = "general" | "appearance" | "capture" | "editor" | "recording" | "ai" | "hotkeys";

export const SETTINGS_SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "general", title: "General" },
  { id: "appearance", title: "Appearance" },
  { id: "capture", title: "After a capture" },
  { id: "editor", title: "Editor" },
  { id: "recording", title: "Recording" },
  { id: "ai", title: "AI descriptions" },
  { id: "hotkeys", title: "Hotkeys" },
];

/** Only macOS has a Dock. */
export function hasDock(): boolean {
  return /Mac/.test(navigator.userAgent);
}

/** Shows or hides the Dock icon; resolves to the settings as saved. */
export function setShowInDock(enabled: boolean): Promise<Settings> {
  return invoke<Settings>("set_show_in_dock", { enabled });
}

/** What each choice after a capture does, in the order Settings lists them. */
export const AFTER_CAPTURE_CHOICES: { value: AfterCapture; title: string; hint: string }[] = [
  {
    value: "quickAccess",
    title: "Show Quick Access",
    hint: "A small preview in the corner with Copy, Annotate, Pin and more. It goes away by itself.",
  },
  {
    value: "editor",
    title: "Open the editor",
    hint: "Go straight to annotating every capture.",
  },
  {
    value: "nothing",
    title: "Do nothing",
    hint: "Save quietly. Find the capture in the Library or the tray's Show last capture.",
  },
];

/** Mirrors `Hotkeys` in src-tauri/src/hotkeys.rs: accelerator strings. */
export interface Hotkeys {
  /** Opens the capture overlay with a toolbar offering every mode. */
  allInOne: string;
  region: string;
  window: string;
  screen: string;
  /** Reads the text in a region and copies it. */
  text: string;
  /** Copies the colour under the pointer. */
  colour: string;
  /** Opens the Grab-it window on the library. */
  library: string;
}

/** Mirrors `HotkeysUpdate` in src-tauri/src/commands.rs. */
export interface HotkeysUpdate {
  settings: Settings;
  /** Hotkeys the system would not register, for example because another app holds them. */
  warnings: string[];
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function setSaveFolder(path: string): Promise<Settings> {
  return invoke<Settings>("set_save_folder", { path });
}

export function setPreferences(preferences: Preferences): Promise<Settings> {
  return invoke<Settings>("set_preferences", { preferences });
}

export function getEditorPreferences(): Promise<EditorPreferences> {
  return invoke<EditorPreferences>("get_editor_preferences");
}

export function setEditorPreferences(preferences: EditorPreferences): Promise<EditorPreferences> {
  return invoke<EditorPreferences>("set_editor_preferences", { preferences });
}

/** Replaces the saved backdrop presets; resolves to them as kept. */
export function setBackdropPresets<B>(presets: BackdropPreset<B>[]): Promise<BackdropPreset[]> {
  return invoke<BackdropPreset[]>("set_backdrop_presets", { presets });
}

/** Turns framing new captures with the last backdrop on or off. */
export function setAutoBackdrop(enabled: boolean): Promise<Settings> {
  return invoke<Settings>("set_auto_backdrop", { enabled });
}

/** Whether Grab-it starts when the user signs in; the system holds this. */
export function getAutostart(): Promise<boolean> {
  return invoke<boolean>("get_autostart");
}

/** Turns starting at sign-in on or off; resolves to the setting as it now is. */
export function setAutostart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_autostart", { enabled });
}

export function setHotkeys(hotkeys: Hotkeys): Promise<HotkeysUpdate> {
  return invoke<HotkeysUpdate>("set_hotkeys", { hotkeys });
}

/**
 * Stops the global hotkeys while a hotkey field records, so pressing a
 * current hotkey there records it instead of starting a capture.
 */
export function pauseHotkeys(): Promise<void> {
  return invoke<void>("pause_hotkeys");
}

/** Registers the saved hotkeys again after {@link pauseHotkeys}. */
export function resumeHotkeys(): Promise<void> {
  return invoke<void>("resume_hotkeys");
}

/** Asks the user for a folder. Resolves to null when they cancel. */
export async function chooseFolder(defaultPath?: string): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title: "Choose where Grab-it saves captures",
  });
  return typeof picked === "string" ? picked : null;
}

/** Asks the saved provider's model to answer; resolves to what it says, or rejects with why not. */
export function testAiConnection(): Promise<string> {
  return invoke<string>("ai_test_connection");
}

/** Queues every capture to be described again. */
export function redescribeAll(): Promise<void> {
  return invoke<void>("ai_redescribe_all");
}
