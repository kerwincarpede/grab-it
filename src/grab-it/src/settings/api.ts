import {
  commands,
  type AfterCapture,
  type AiProvider,
  type PopupCorner,
  type RecordingAudio,
  type RecordingFormat,
  type RecordingQuality,
  type Removal,
  type TextSizeStep,
  type UpdateChannel,
  type AgentSkill as GeneratedAgentSkill,
  type AiClis_Serialize,
  type AiSettings_Serialize,
  type Appearance_Serialize,
  type BackdropPreset as GeneratedBackdropPreset,
  type Camera as GeneratedCamera,
  type EditorPreferences_Deserialize,
  type EditorPreferences_Serialize,
  type FfmpegStatus_Serialize,
  type Hotkeys_Serialize,
  type HotkeysUpdate_Serialize,
  type MicrophoneInfo,
  type Preferences_Serialize,
  type RecordingSettings_Serialize,
  type Retention_Serialize,
  type Settings_Serialize,
  type WebcamShape_Serialize,
} from "../app/bindings";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export type {
  AfterCapture,
  AiProvider,
  ApiKeyStorage,
  PopupCorner,
  RecordingAudio,
  RecordingFormat,
  RecordingQuality,
  RecordingSource,
  Removal,
  TextSizeStep,
  UpdateChannel,
} from "../app/bindings";

/** `Preferences` in src-tauri/src/settings.rs. */
export type Preferences = Preferences_Serialize;

/** `AiSettings` in src-tauri/src/settings.rs: the vision model that describes captures. */
export type AiPreferences = AiSettings_Serialize;

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

/** `AiClis` in src-tauri/src/ai.rs: where each AI CLI was found, or null when it is not installed. */
export type AiClis = AiClis_Serialize;

/** Looks for the AI CLIs Grab-it can run. */
export function aiClis(): Promise<AiClis> {
  return commands.aiClis();
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
 * `EditorPreferences` in src-tauri/src/settings.rs: the annotation
 * editor's remembered choices. Any key may be missing; the editor checks
 * each value and uses its own default otherwise.
 * The backend keeps `backdrop` and each preset's backdrop as opaque JSON;
 * the editor checks them as it reads them, so they are `unknown` here.
 */
export type EditorPreferences = Omit<EditorPreferences_Serialize, "backdrop" | "backdropPresets"> & {
  backdrop?: unknown;
  backdropPresets?: BackdropPreset[];
};

/** Mirrors `MAX_BACKDROP_PRESETS` in src-tauri/src/settings.rs. */
export const MAX_BACKDROP_PRESETS = 24;

/** Mirrors `MAX_FAVORITE_COLORS` in src-tauri/src/settings.rs. */
export const MAX_FAVORITE_COLORS = 8;

/**
 * `BackdropPreset` in src-tauri/src/settings.rs: a backdrop saved under a
 * name. Names need not be unique; `id` tells presets apart. `backdrop` is
 * `Backdrop` in editor/model.ts, checked by the editor as it reads it.
 */
export type BackdropPreset<B = unknown> = Omit<GeneratedBackdropPreset, "backdrop"> & { backdrop: B };

/** `Settings` in src-tauri/src/settings.rs. */
export type Settings = Omit<Settings_Serialize, "editor"> & { editor: EditorPreferences };

/** The update channels in the order Settings lists them. */
export const UPDATE_CHANNELS: { value: UpdateChannel; title: string; hint: string }[] = [
  {
    value: "stable",
    title: "Stable",
    hint: "Get updates after they’ve been tried on Edge.",
  },
  {
    value: "edge",
    title: "Edge",
    hint: "Get new features and fixes sooner. You may run into bugs.",
  },
];

/** `Retention` in src-tauri/src/settings.rs: days each kind is kept, null for forever. */
export type Retention = Retention_Serialize;

/** The kinds a Keep setting is for. */
export type RetentionKind = "image" | "gif" | "video";

export const DEFAULT_RETENTION: Retention = { image: null, gif: null, video: null, removal: "trash" };

/** The Keep choices, shortest first, as the Storage page lists them. */
export const KEEP_CHOICES: { days: number | null; title: string; phrase: string }[] = [
  { days: 7, title: "For 1 week", phrase: "1 week" },
  { days: 30, title: "For 30 days", phrase: "30 days" },
  { days: 90, title: "For 90 days", phrase: "90 days" },
  { days: 365, title: "For 1 year", phrase: "1 year" },
  { days: null, title: "Forever", phrase: "forever" },
];

/** "1 week", "90 days": how long a Keep setting keeps items, in a sentence. */
export function keepPhrase(days: number): string {
  return KEEP_CHOICES.find((choice) => choice.days === days)?.phrase ?? `${days} ${days === 1 ? "day" : "days"}`;
}

/** Whether keeping for `next` days removes items `previous` kept: it is shorter. */
export function keepsLess(previous: number | null, next: number | null): boolean {
  return next !== null && (previous === null || next < previous);
}

export const REMOVALS: { value: Removal; title: string; hint: string }[] = [
  {
    value: "trash",
    title: "Moving to the Trash",
    hint: "You can restore items from the Trash. Their space is freed when you empty it. Clean up in the Library asks each time.",
  },
  {
    value: "permanent",
    title: "Deleting permanently",
    hint: "Items are gone for good and their space is freed at once. Clean up in the Library asks each time.",
  },
];

/** Saves how long each kind is kept and how items are removed; resolves to the settings as saved. */
export function setRetention(retention: Retention): Promise<Settings> {
  return commands.setRetention(retention);
}

/** `Appearance` in src-tauri/src/settings.rs. */
export type Appearance = Appearance_Serialize;

export const DEFAULT_APPEARANCE: Appearance = { textScale: 110, hubScale: 110, popupCorner: "bottomRight", popupSeconds: 8 };

/** The text size sliders, in percent. Mirrors `MIN_TEXT_SCALE` and `MAX_TEXT_SCALE` in src-tauri/src/settings.rs. */
export const TEXT_SCALE = { min: 85, max: 130, step: 5 };

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
  return commands.stepTextSize(step);
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
  return commands.setAppearance(appearance);
}

/** Mirrors `RecordingSettings::fps` in src-tauri/src/settings.rs: an MP4's frames a second. */
export type RecordingFps = 30 | 60;

/** `RecordingSettings` in src-tauri/src/settings.rs. */
export type RecordingSettings = RecordingSettings_Serialize;

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
  removeNoise: false,
  showWebcam: false,
  camera: null,
  webcamShape: "squircle",
  mirrorWebcam: true,
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

/** `WebcamShape` in src-tauri/src/settings.rs, as the backend sends it. */
export type WebcamShape = WebcamShape_Serialize;

export const WEBCAM_SHAPES: { value: WebcamShape; title: string }[] = [
  { value: "squircle", title: "Squircle" },
  { value: "round", title: "Round" },
  { value: "arch", title: "Arch" },
  { value: "pill", title: "Pill" },
  { value: "wide", title: "Wide" },
  { value: "blob", title: "Blob (moves)" },
];

/** A camera the webview can show: `Camera` in src-tauri/src/webcam.rs. `id` is the webview's `deviceId`. */
export type Camera = GeneratedCamera;

/** The cameras the webview listed, and whether it gave each one its real name. */
export interface CameraListing {
  cameras: Camera[];
  /** At least one camera was listed, and none had its name hidden. */
  named: boolean;
}

/**
 * The cameras the webview offers, named "Camera 1", "Camera 2" and so on
 * where it hides their names, as it does until a camera has been allowed.
 * With `ask`, a camera is opened for a moment when names are hidden, which
 * asks for the permission where the system wants one and then reveals them.
 */
export async function listCameras(ask = false): Promise<CameraListing> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media || typeof media.enumerateDevices !== "function") return { cameras: [], named: false };
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
  return {
    cameras: devices
      .filter((device) => device.deviceId !== "")
      .map((device, index) => ({ id: device.deviceId, name: device.label || `Camera ${index + 1}` })),
    named: devices.length > 0 && devices.every((device) => device.label !== "" && device.deviceId !== ""),
  };
}

/** The cameras last listed with their names, remembered across restarts; empty when none were. */
export function knownCameras(): Promise<Camera[]> {
  return commands.knownCameras();
}

/** Remembers `cameras` for {@link knownCameras}. */
export function rememberCameras(cameras: Camera[]): Promise<void> {
  return commands.rememberCameras(cameras).then(() => undefined);
}

/**
 * Remembers `listing` when every camera in it had its name, so the setup
 * toolbar can name them without turning a camera on. A listing with a
 * hidden name keeps what was remembered.
 */
export async function rememberListing(listing: CameraListing): Promise<void> {
  if (listing.named) await rememberCameras(listing.cameras);
}

export function setRecording(recording: RecordingSettings): Promise<Settings> {
  return commands.setRecording(recording);
}

/** `MicrophoneInfo` in src-tauri/src/audio.rs. `id` is what `RecordingSettings.microphone` saves. */
export type Microphone = MicrophoneInfo;

/** Whether what the computer plays can be recorded here: on Windows, Linux and macOS 13 or later. */
export function systemSoundAvailable(): Promise<boolean> {
  return commands.recordingSystemAudio();
}

/** The microphones that can be recorded. On Linux, empty until ffmpeg is ready, which lists them. */
export function listMicrophones(): Promise<Microphone[]> {
  return commands.recordingMicrophones();
}

/** `FfmpegStatus` in src-tauri/src/ffmpeg.rs: whether MP4 can be recorded yet. */
export type FfmpegStatus = FfmpegStatus_Serialize;

/** Mirrors `FFMPEG_STATUS_EVENT` in src-tauri/src/ffmpeg.rs. */
export const FFMPEG_STATUS_EVENT = "ffmpeg-status";

export function ffmpegStatus(): Promise<FfmpegStatus> {
  return commands.ffmpegStatus();
}

/** Looks for ffmpeg again, downloading it or finding an encoder; resolves to the status as it starts. */
export function retryFfmpeg(): Promise<FfmpegStatus> {
  return commands.ffmpegRetry();
}

export function onFfmpegStatus(handler: (status: FfmpegStatus) => void): Promise<UnlistenFn> {
  return listen<FfmpegStatus>(FFMPEG_STATUS_EVENT, (event) => handler(event.payload));
}

/** Settings, split into the pages of the Grab-it window's sidebar. */
export type SettingsSection =
  | "general"
  | "appearance"
  | "capture"
  | "editor"
  | "recording"
  | "storage"
  | "ai"
  | "agents"
  | "hotkeys";

export const SETTINGS_SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "general", title: "General" },
  { id: "appearance", title: "Appearance" },
  { id: "capture", title: "After a capture" },
  { id: "editor", title: "Editor" },
  { id: "recording", title: "Recording" },
  { id: "storage", title: "Storage" },
  { id: "ai", title: "AI integration" },
  { id: "hotkeys", title: "Hotkeys" },
];

/** Only macOS has a Dock. */
export function hasDock(): boolean {
  return /Mac/.test(navigator.userAgent);
}

/** Shows or hides the Dock icon; resolves to the settings as saved. */
export function setShowInDock(enabled: boolean): Promise<Settings> {
  return commands.setShowInDock(enabled);
}

/** Remembers the chosen folder across export dialogs. */
export function setLastExportFolder(folder: string): Promise<Settings> {
  return commands.setLastExportFolder(folder);
}

/** Lets the grab-it command line capture, or stops it; resolves to the settings as saved. */
export function setAgentAccess(enabled: boolean): Promise<Settings> {
  return commands.setAgentAccess(enabled);
}

/**
 * Switches between Stable and Edge; resolves to the settings as saved. The
 * backend forgets the update the old channel offered and checks the new one.
 */
export function setUpdateChannel(channel: UpdateChannel): Promise<Settings> {
  return commands.setUpdateChannel(channel);
}

/** `AgentSkill` in src-tauri/src/agent.rs: where the agent skill is installed. */
export type AgentSkill = GeneratedAgentSkill;

/** Where the agent skill is installed. */
export function agentSkillStatus(): Promise<AgentSkill> {
  return commands.agentSkillStatus();
}

/** Writes the agent skill into ~/.agents/skills and ~/.claude/skills; resolves to where it is now. */
export function installAgentSkill(): Promise<AgentSkill> {
  return commands.installAgentSkill();
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

/** `Hotkeys` in src-tauri/src/hotkeys.rs: accelerator strings. */
export type Hotkeys = Hotkeys_Serialize;

/** `HotkeysUpdate` in src-tauri/src/commands.rs; `warnings` are hotkeys the system would not register. */
export type HotkeysUpdate = Omit<HotkeysUpdate_Serialize, "settings"> & { settings: Settings };

export function getSettings(): Promise<Settings> {
  return commands.getSettings();
}

export function setSaveFolder(path: string): Promise<Settings> {
  return commands.setSaveFolder(path);
}

export function setPreferences(preferences: Preferences): Promise<Settings> {
  return commands.setPreferences(preferences);
}

export function getEditorPreferences(): Promise<EditorPreferences> {
  return commands.getEditorPreferences();
}

export function setEditorPreferences(preferences: EditorPreferences): Promise<EditorPreferences> {
  return commands.setEditorPreferences(
    // The backdrop is the editor's own JSON, which the backend stores untouched.
    preferences as unknown as EditorPreferences_Deserialize,
  );
}

/** Replaces the saved backdrop presets; resolves to them as kept. */
export function setBackdropPresets<B>(presets: BackdropPreset<B>[]): Promise<BackdropPreset[]> {
  return commands.setBackdropPresets(
    // Each backdrop is the editor's own JSON, which the backend stores untouched.
    presets as unknown as GeneratedBackdropPreset[],
  );
}

/** Replaces the saved favourite colours; resolves to them as kept. */
export function setFavoriteColors(colors: string[]): Promise<string[]> {
  return commands.setFavoriteColors(colors);
}

/** Turns framing new captures with the last backdrop on or off. */
export function setAutoBackdrop(enabled: boolean): Promise<Settings> {
  return commands.setAutoBackdrop(enabled);
}

/** Turns showing the pointer in new captures on or off. */
export function setShowPointer(enabled: boolean): Promise<Settings> {
  return commands.setShowPointer(enabled);
}

/** Whether Grab-it starts when the user signs in; the system holds this. */
export function getAutostart(): Promise<boolean> {
  return commands.getAutostart();
}

/** Turns starting at sign-in on or off; resolves to the setting as it now is. */
export function setAutostart(enabled: boolean): Promise<boolean> {
  return commands.setAutostart(enabled);
}

export function setHotkeys(hotkeys: Hotkeys): Promise<HotkeysUpdate> {
  return commands.setHotkeys(hotkeys);
}

/**
 * Stops the global hotkeys while a hotkey field records, so pressing a
 * current hotkey there records it instead of starting a capture.
 */
export function pauseHotkeys(): Promise<void> {
  return commands.pauseHotkeys();
}

/** Registers the saved hotkeys again after {@link pauseHotkeys}. */
export function resumeHotkeys(): Promise<void> {
  return commands.resumeHotkeys();
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
export function testAiConnection(draft: AiPreferences): Promise<string> {
  return commands.aiTestConnection(draft);
}

/** Queues every capture to be described again. */
export function redescribeAll(): Promise<void> {
  return commands.aiRedescribeAll().then(() => undefined);
}

export function aiCaptureCount(): Promise<number> {
  return commands.aiCaptureCount();
}
