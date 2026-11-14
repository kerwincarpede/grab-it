import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirrors `AfterCapture` in src-tauri/src/settings.rs. */
export type AfterCapture = "quickAccess" | "editor" | "nothing";

/** Mirrors `Preferences` in src-tauri/src/settings.rs. */
export interface Preferences {
  afterCapture: AfterCapture;
  copyToClipboard: boolean;
  ai: AiPreferences;
}

/** Mirrors `AiPreferences` in src-tauri/src/settings.rs: the vision model that describes captures. */
export interface AiPreferences {
  enabled: boolean;
  /** An OpenAI-compatible API base URL, such as Ollama's. */
  endpoint: string;
  model: string;
  /** Only cloud providers need one. */
  apiKey: string | null;
  /** Leave captures from before AI descriptions were turned on alone. */
  newCapturesOnly: boolean;
}

/** What the backend starts with. */
export const DEFAULT_AI_PREFERENCES: AiPreferences = {
  enabled: false,
  endpoint: "http://localhost:11434/v1",
  model: "qwen2.5vl:7b",
  apiKey: null,
  newCapturesOnly: true,
};

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
}

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface Settings extends Preferences {
  saveFolder: string;
  hotkeys: Hotkeys;
  editor?: EditorPreferences;
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
  region: string;
  window: string;
  screen: string;
  /** Reads the text in a region and copies it. */
  text: string;
  /** Copies the colour under the pointer. */
  colour: string;
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

/** Asks the AI endpoint about the saved model; resolves to what it says, or rejects with why not. */
export function testAiConnection(): Promise<string> {
  return invoke<string>("ai_test_connection");
}

/** Queues every capture to be described again. */
export function redescribeAll(): Promise<void> {
  return invoke<void>("ai_redescribe_all");
}
