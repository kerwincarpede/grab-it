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

/** Mirrors `AiProvider` in src-tauri/src/settings.rs: who describes captures. */
export type AiProvider = "claudeCode" | "codex" | "endpoint";

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
  /** Only cloud providers need one. */
  apiKey: string | null;
  /** Leave captures from before AI descriptions were turned on alone. */
  newCapturesOnly: boolean;
  /** Grab-it turned describing on by itself and the Library has not said so yet. Only the backend changes it. */
  noticePending: boolean;
}

/** What the backend starts with. */
export const DEFAULT_AI_PREFERENCES: AiPreferences = {
  enabled: false,
  provider: null,
  endpoint: "http://localhost:11434/v1",
  model: "qwen3-vl:4b",
  apiKey: null,
  newCapturesOnly: true,
  noticePending: false,
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
    hint: "Uses the claude command you already have and are signed in to, with the Haiku model. Nothing to set up or download.",
  },
  {
    value: "codex",
    title: "Codex",
    hint: "Uses the codex command you already have and are signed in to, with the model you set up for it. Nothing to set up or download.",
  },
  {
    value: "endpoint",
    title: "OpenAI-compatible endpoint",
    hint: "Ollama or LM Studio on this computer, or a cloud API such as OpenAI or OpenRouter.",
  },
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
