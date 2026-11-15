import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it } from "vitest";
import SettingsWindow from "./SettingsWindow";
import { camera, fakeMedia, type FakeMedia } from "../webcam/testMedia";
import {
  DEFAULT_AI_PREFERENCES,
  DEFAULT_RECORDING,
  DEFAULT_RETENTION,
  isLocalEndpoint,
  keystrokesHint,
  listCameras,
  type AiPreferences,
  type FfmpegStatus,
  type Microphone,
  type RecordingSettings,
  type Retention,
} from "./api";

const MB = 1024 * 1024;
const GB = 1024 * MB;

type KindName = "image" | "gif" | "video";

const DEFAULT_HOTKEYS = {
  allInOne: "Ctrl+Alt+PrintScreen",
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
  text: "Shift+PrintScreen",
  colour: "Ctrl+Shift+PrintScreen",
  library: "Alt+Shift+PrintScreen",
};

interface Backend {
  /** Undefined: the system cannot say, and `get_autostart` fails. */
  autostart?: boolean;
  afterCapture: string;
  copyToClipboard: boolean;
  ai: AiPreferences;
  /** What `ai_test_connection` answers; a thrown error when it starts with "error:". */
  testResult: string;
  /** Where `ai_clis` finds Claude Code; null when it is not installed. */
  claudePath: string | null;
  /** Where `ai_clis` finds Codex; null when it is not installed. */
  codexPath: string | null;
  /** The editor section's auto-apply flag. */
  autoBackdrop?: boolean;
  appearance?: unknown;
  recording?: RecordingSettings;
  retention: Retention;
  /** Each kind's count and size, as `library_storage` reads them. */
  usage: Record<KindName, { count: number; bytes: number }>;
  /** What is older than any Keep setting and not protected, by kind; `library_storage` counts it as due when the kind is not kept forever. */
  older: Record<KindName, { count: number; bytes: number }>;
  /** `library_storage` fails, as an older backend without it would. */
  storageFails?: boolean;
  /** What `ffmpeg_status` answers. */
  ffmpeg: FfmpegStatus;
  /** What `ffmpeg_retry` answers. */
  ffmpegAfterRetry: FfmpegStatus;
  /** What `recording_microphones` answers. */
  microphones: Microphone[];
  /** What `recording_system_audio` answers. */
  systemSound: boolean;
  saveFolder: string;
  hotkeys: typeof DEFAULT_HOTKEYS;
  hotkeyWarnings: string[];
  picked: string | null;
  setError?: string;
  calls: { cmd: string; payload?: InvokeArgs }[];
}

function mockBackend(initial: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    afterCapture: "quickAccess",
    copyToClipboard: true,
    ai: { ...DEFAULT_AI_PREFERENCES },
    testResult: "qwen3-vl:4b (4.4B, Q4_K_M)",
    claudePath: "/usr/local/bin/claude",
    codexPath: "/opt/homebrew/bin/codex",
    saveFolder: "/home/me/Pictures/Grab-it",
    picked: "/data/Shots",
    hotkeys: { ...DEFAULT_HOTKEYS },
    hotkeyWarnings: [],
    ffmpeg: { state: "ready", path: "/usr/bin/ffmpeg", encoder: "libopenh264" },
    ffmpegAfterRetry: { state: "downloading", downloaded: 0, total: 0 },
    microphones: [],
    systemSound: true,
    retention: { ...DEFAULT_RETENTION },
    usage: {
      image: { count: 1102, bytes: 412 * MB },
      gif: { count: 96, bytes: 1.1 * GB },
      video: { count: 86, bytes: 4.7 * GB },
    },
    older: {
      image: { count: 0, bytes: 0 },
      gif: { count: 12, bytes: 255 * MB },
      video: { count: 72, bytes: 3.7 * GB },
    },
    calls: [],
    ...initial,
  };
  const settings = () => ({
    saveFolder: backend.saveFolder,
    hotkeys: backend.hotkeys,
    afterCapture: backend.afterCapture,
    copyToClipboard: backend.copyToClipboard,
    ai: backend.ai,
    editor: backend.autoBackdrop === undefined ? {} : { autoBackdrop: backend.autoBackdrop },
    appearance: backend.appearance,
    recording: backend.recording,
    retention: backend.retention,
  });
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return settings();
      case "set_appearance":
        backend.appearance = (payload as { appearance: unknown }).appearance;
        return settings();
      case "set_recording":
        backend.recording = (payload as { recording: RecordingSettings }).recording;
        return settings();
      case "set_retention":
        if (backend.setError) throw backend.setError;
        backend.retention = (payload as { retention: Retention }).retention;
        return settings();
      case "library_storage": {
        if (backend.storageFails) throw new Error("unexpected command library_storage");
        const retention = (payload as { candidate?: Retention } | undefined)?.candidate ?? backend.retention;
        // Zero days, as Purge now asks, is everything unprotected.
        const due = (kind: KindName) =>
          retention[kind] === null
            ? { count: 0, bytes: 0 }
            : retention[kind] === 0
              ? backend.usage[kind]
              : backend.older[kind];
        return {
          ...backend.usage,
          disk: { free: 100 * GB, total: 500 * GB },
          due: { image: due("image"), gif: due("gif"), video: due("video") },
        };
      }
      case "library_clean_up": {
        const { retention } = payload as { retention?: Retention };
        const removed = (kind: KindName) => (retention?.[kind] === 0 ? backend.usage[kind] : { count: 0, bytes: 0 });
        const kinds: KindName[] = ["image", "gif", "video"];
        return {
          count: kinds.reduce((sum, kind) => sum + removed(kind).count, 0),
          bytes: kinds.reduce((sum, kind) => sum + removed(kind).bytes, 0),
        };
      }
      case "ffmpeg_status":
        return backend.ffmpeg;
      case "ffmpeg_retry":
        backend.ffmpeg = backend.ffmpegAfterRetry;
        return backend.ffmpeg;
      case "recording_microphones":
        return backend.microphones;
      case "recording_system_audio":
        return backend.systemSound;
      case "get_autostart":
        if (backend.autostart === undefined) throw "not supported";
        return backend.autostart;
      case "set_autostart":
        if (backend.setError) throw backend.setError;
        backend.autostart = (payload as { enabled: boolean }).enabled;
        return backend.autostart;
      case "set_preferences": {
        if (backend.setError) throw backend.setError;
        const { preferences } = payload as {
          preferences: { afterCapture: string; copyToClipboard: boolean; ai: AiPreferences };
        };
        backend.afterCapture = preferences.afterCapture;
        backend.copyToClipboard = preferences.copyToClipboard;
        backend.ai = preferences.ai;
        return settings();
      }
      case "ai_test_connection":
        if (backend.testResult.startsWith("error:")) throw backend.testResult.slice(6).trim();
        return backend.testResult;
      case "ai_redescribe_all":
        return null;
      case "ai_clis":
        return { claudeCode: backend.claudePath, codex: backend.codexPath };
      case "set_auto_backdrop":
        if (backend.setError) throw backend.setError;
        backend.autoBackdrop = (payload as { enabled: boolean }).enabled;
        return settings();
      case "plugin:dialog|open":
        return backend.picked;
      case "set_save_folder": {
        if (backend.setError) throw backend.setError;
        backend.saveFolder = (payload as { path: string }).path;
        return settings();
      }
      case "set_hotkeys": {
        if (backend.setError) throw backend.setError;
        backend.hotkeys = (payload as { hotkeys: typeof DEFAULT_HOTKEYS }).hotkeys;
        return {
          settings: settings(),
          warnings: backend.hotkeyWarnings,
        };
      }
      case "pause_hotkeys":
      case "resume_hotkeys":
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }, { shouldMockEvents: true });
  return backend;
}

const commands = (backend: Backend) => backend.calls.map((call) => call.cmd);

describe("SettingsWindow", () => {
  it("shows the current save folder", async () => {
    mockBackend();
    render(<SettingsWindow />);
    const input = await screen.findByLabelText("Save folder");
    expect(await screen.findByDisplayValue("/home/me/Pictures/Grab-it")).toBe(input);
    expect(screen.getByRole("button", { name: "Change…" })).toBeEnabled();
  });

  it("changes the save folder to the picked folder", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByDisplayValue("/data/Shots")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Save folder updated.");
    const dialog = backend.calls.find((call) => call.cmd === "plugin:dialog|open");
    expect(dialog?.payload).toMatchObject({
      options: { directory: true, defaultPath: "/home/me/Pictures/Grab-it" },
    });
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "set_save_folder", payload: { path: "/data/Shots" } });
  });

  it("keeps the folder when the dialog is cancelled", async () => {
    const backend = mockBackend({ picked: null });
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(screen.getByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
    expect(commands(backend)).not.toContain("set_save_folder");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("shows the error when the folder cannot be used", async () => {
    mockBackend({ setError: "Permission denied (os error 13)" });
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByText("Permission denied (os error 13)")).toBe(
      screen.getByRole("status"),
    );
    expect(screen.getByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
  });

  it("shows what happens after a capture and saves a new choice at once", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const quick = await screen.findByRole("radio", { name: /Show Quick Access/ });
    await waitFor(() => expect(quick).toBeChecked());
    expect(screen.getByRole("switch", { name: /Copy every capture/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /Open the editor/ }));

    await waitFor(() => expect(screen.getByRole("radio", { name: /Open the editor/ })).toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(backend.calls[backend.calls.length - 1]).toEqual({
      cmd: "set_preferences",
      payload: { preferences: { afterCapture: "editor", copyToClipboard: true, ai: DEFAULT_AI_PREFERENCES } },
    });
  });

  it("turns copying to the clipboard off, keeping the other choice", async () => {
    const backend = mockBackend({ afterCapture: "nothing" });
    render(<SettingsWindow />);
    const copy = await screen.findByRole("switch", { name: /Copy every capture/ });
    await waitFor(() => expect(copy).toBeEnabled());

    await userEvent.click(copy);

    await waitFor(() => expect(copy).not.toBeChecked());
    expect(backend.calls[backend.calls.length - 1].payload).toEqual({
      preferences: { afterCapture: "nothing", copyToClipboard: false, ai: DEFAULT_AI_PREFERENCES },
    });
  });

  it("keeps the choice and says why when a preference cannot be saved", async () => {
    mockBackend({ setError: "disk full" });
    render(<SettingsWindow />);
    const quick = await screen.findByRole("radio", { name: /Show Quick Access/ });
    await waitFor(() => expect(quick).toBeChecked());

    await userEvent.click(screen.getByRole("radio", { name: /Do nothing/ }));

    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(quick).toBeChecked();
  });

  it("turns framing new captures with the last backdrop on and off", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("switch", { name: /Frame new captures with the last backdrop/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "set_auto_backdrop", payload: { enabled: true } });
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(backend.autoBackdrop).toBe(false);
  });

  it("shows auto-apply as it is saved", async () => {
    mockBackend({ autoBackdrop: true });
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("switch", { name: /Frame new captures with the last backdrop/ });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("turns starting at sign-in on", async () => {
    const backend = mockBackend({ autostart: false });
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("switch", { name: /Start Grab-it when you sign in/ });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "set_autostart", payload: { enabled: true } });
  });

  it("leaves the start-up toggle out where the system cannot say", async () => {
    mockBackend();
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");
    expect(screen.queryByRole("switch", { name: /Start Grab-it/ })).not.toBeInTheDocument();
  });

  it("shows the current hotkeys", async () => {
    mockBackend();
    render(<SettingsWindow />);
    expect(await screen.findByLabelText("Region")).toHaveValue("PrintScreen");
    expect(screen.getByLabelText("Window")).toHaveValue("Alt+PrintScreen");
    expect(screen.getByLabelText("Screen")).toHaveValue("Ctrl+PrintScreen");
    expect(screen.getByLabelText("Open library")).toHaveValue("Alt+Shift+PrintScreen");
    expect(screen.getByLabelText("All-in-one")).toHaveValue("Ctrl+Alt+PrintScreen");
    expect(screen.getByRole("button", { name: "Save hotkeys" })).toBeDisabled();
  });

  it("records a new hotkey and saves it", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    await userEvent.click(region);
    await userEvent.keyboard("{Control>}{Shift>}[KeyR]{/Shift}{/Control}");

    expect(region).toHaveValue("Ctrl+Shift+R");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(await screen.findByText("Hotkeys updated.")).toBe(screen.getByRole("status"));
    expect(backend.calls[backend.calls.length - 1]).toEqual({
      cmd: "set_hotkeys",
      payload: { hotkeys: { ...DEFAULT_HOTKEYS, region: "Ctrl+Shift+R" } },
    });
    expect(screen.getByRole("button", { name: "Save hotkeys" })).toBeDisabled();
  });

  it("reverts unsaved hotkey changes", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const screenField = await screen.findByLabelText("Screen");

    await userEvent.click(screenField);
    await userEvent.keyboard("[F9]");
    expect(screenField).toHaveValue("F9");
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));

    expect(screenField).toHaveValue("Ctrl+PrintScreen");
    expect(commands(backend)).not.toContain("set_hotkeys");
  });

  it("shows hotkeys the system would not register", async () => {
    mockBackend({ hotkeyWarnings: ["Region hotkey `F9` could not be registered: taken"] });
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    await userEvent.click(region);
    await userEvent.keyboard("[F9]");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(
      await screen.findByText("Region hotkey `F9` could not be registered: taken"),
    ).toBeInTheDocument();
  });

  it("shows why hotkeys were rejected and keeps the draft", async () => {
    mockBackend({ setError: "Window and Region use the same hotkey." });
    render(<SettingsWindow />);
    const windowField = await screen.findByLabelText("Window");

    await userEvent.click(windowField);
    await userEvent.keyboard("[PrintScreen]");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(await screen.findByText("Window and Region use the same hotkey.")).toBeInTheDocument();
    expect(windowField).toHaveValue("PrintScreen");
  });

  it("records PrintScreen from key up, as Windows sends no key down for it", async () => {
    mockBackend({ hotkeys: { ...DEFAULT_HOTKEYS, region: "F9" } });
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    fireEvent.keyUp(region, { key: "PrintScreen", code: "PrintScreen" });
    expect(region).toHaveValue("PrintScreen");

    fireEvent.keyUp(region, { key: "PrintScreen", code: "PrintScreen", altKey: true });
    expect(region).toHaveValue("Alt+PrintScreen");

    // Repeated key-up-only presses keep recording.
    fireEvent.keyUp(region, { key: "PrintScreen", code: "PrintScreen", ctrlKey: true });
    expect(region).toHaveValue("Ctrl+PrintScreen");
  });

  it("keeps the key down PrintScreen combination when the modifier is released first", async () => {
    mockBackend({ hotkeys: { ...DEFAULT_HOTKEYS, window: "F9" } });
    render(<SettingsWindow />);
    const windowField = await screen.findByLabelText("Window");

    fireEvent.keyDown(windowField, { key: "PrintScreen", code: "PrintScreen", altKey: true });
    expect(windowField).toHaveValue("Alt+PrintScreen");

    fireEvent.keyUp(windowField, { key: "PrintScreen", code: "PrintScreen" });
    expect(windowField).toHaveValue("Alt+PrintScreen");

    // The next press with no key down falls back to key up again.
    fireEvent.keyUp(windowField, { key: "PrintScreen", code: "PrintScreen", ctrlKey: true });
    expect(windowField).toHaveValue("Ctrl+PrintScreen");
  });

  it("pauses the global hotkeys while a hotkey field has focus", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    await userEvent.click(region);
    expect(commands(backend).filter((cmd) => cmd.endsWith("_hotkeys"))).toEqual([
      "pause_hotkeys",
    ]);

    // Moving to another hotkey field keeps them paused.
    await userEvent.tab();
    expect(screen.getByLabelText("Window")).toHaveFocus();
    expect(commands(backend)).not.toContain("resume_hotkeys");

    // Pressing the current Screen hotkey records it rather than capturing.
    await userEvent.keyboard("{Control>}[PrintScreen]{/Control}");
    expect(screen.getByLabelText("Window")).toHaveValue("Ctrl+PrintScreen");

    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(commands(backend).filter((cmd) => cmd.endsWith("_hotkeys"))).toEqual([
        "pause_hotkeys",
        "resume_hotkeys",
      ]),
    );
  });

  it("resumes the global hotkeys when Settings closes mid-recording", async () => {
    const backend = mockBackend();
    const { unmount } = render(<SettingsWindow />);
    await userEvent.click(await screen.findByLabelText("Screen"));

    unmount();

    await waitFor(() => expect(commands(backend)).toContain("resume_hotkeys"));
  });
});

describe("SettingsWindow AI descriptions", () => {
  const lastPreferences = (backend: Backend) =>
    (backend.calls.filter((call) => call.cmd === "set_preferences").pop()?.payload as { preferences: unknown })
      ?.preferences;

  it("shows the saved AI settings with the privacy note", async () => {
    mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, apiKey: "sk-secret" } });
    render(<SettingsWindow />);

    const toggle = await screen.findByRole("switch", { name: /Describe captures with AI/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("http://localhost:11434/v1");
    expect(screen.getByLabelText("Model")).toHaveValue("qwen3-vl:4b");
    expect(screen.getByLabelText("Preset")).toHaveValue("ollama");
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue("sk-secret");
    expect(screen.getByText(/Only cloud providers need one/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Only describe new captures/ })).toBeChecked();
    // Tidying text is on, but waits for AI to be turned on.
    const tidy = screen.getByRole("switch", { name: /Tidy up captured text/ });
    expect(tidy).toBeChecked();
    expect(tidy).toBeDisabled();
    expect(screen.getByText(/nothing leaves this computer; a cloud endpoint receives your screenshots/)).toBeInTheDocument();
    // Nothing to re-describe while it is off.
    expect(screen.getByRole("button", { name: "Re-describe all…" })).toBeDisabled();
  });

  it("saves the toggles at once, keeping the other preferences", async () => {
    const backend = mockBackend({ afterCapture: "editor" });
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("switch", { name: /Describe captures with AI/ });
    await waitFor(() => expect(toggle).toBeEnabled());

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(lastPreferences(backend)).toEqual({
      afterCapture: "editor",
      copyToClipboard: true,
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true },
    });

    const newOnly = screen.getByRole("switch", { name: /Only describe new captures/ });
    await waitFor(() => expect(newOnly).toBeEnabled());
    await userEvent.click(newOnly);
    await waitFor(() => expect(newOnly).not.toBeChecked());
    expect(backend.ai).toEqual({ ...DEFAULT_AI_PREFERENCES, enabled: true, newCapturesOnly: false });
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");

    const tidy = screen.getByRole("switch", { name: /Tidy up captured text/ });
    await waitFor(() => expect(tidy).toBeEnabled());
    await userEvent.click(tidy);
    await waitFor(() => expect(tidy).not.toBeChecked());
    expect(backend.ai).toEqual({ ...DEFAULT_AI_PREFERENCES, enabled: true, newCapturesOnly: false, tidyText: false });
  });

  it("saves a cloud endpoint, model and key", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true } });
    render(<SettingsWindow />);
    const endpoint = await screen.findByLabelText("Endpoint URL");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, " https://api.openai.com/v1 ");
    await userEvent.clear(screen.getByLabelText("Model"));
    await userEvent.type(screen.getByLabelText("Model"), "gpt-4o-mini");
    await userEvent.type(screen.getByLabelText("API key"), "sk-123");
    await userEvent.click(save);

    await waitFor(() =>
      expect(backend.ai).toEqual({
        ...DEFAULT_AI_PREFERENCES,
        enabled: true,
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-123",
      }),
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(endpoint).toHaveValue("https://api.openai.com/v1");
  });

  it("fills in the endpoint and model from a preset, saving them with Save", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "endpoint" } });
    render(<SettingsWindow />);
    const preset = await screen.findByLabelText("Preset");
    await waitFor(() => expect(preset).toBeEnabled());
    expect(screen.getByRole("option", { name: "Custom" })).toBeInTheDocument();
    expect(within(preset).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Custom",
      "Ollama",
      "OpenAI",
      "Anthropic",
      "OpenRouter",
    ]);

    await userEvent.selectOptions(preset, "OpenRouter");

    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("https://openrouter.ai/api/v1");
    expect(screen.getByLabelText("Model")).toHaveValue("openai/gpt-5-mini");
    expect(preset).toHaveValue("openrouter");
    // Only filled in: nothing is saved until Save.
    expect(commands(backend)).not.toContain("set_preferences");
    expect(screen.getByText(/a cloud endpoint receives your screenshots/)).toHaveClass("ai-privacy-cloud");

    await userEvent.type(screen.getByLabelText("API key"), "sk-or-1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(backend.ai).toEqual({
        ...DEFAULT_AI_PREFERENCES,
        enabled: true,
        provider: "endpoint",
        endpoint: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5-mini",
        apiKey: "sk-or-1",
      }),
    );
  });

  it("shows Custom once the model is the user's own, and fills each preset's model", async () => {
    mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "endpoint" } });
    render(<SettingsWindow />);
    const preset = await screen.findByLabelText("Preset");
    await waitFor(() => expect(preset).toBeEnabled());
    expect(preset).toHaveValue("ollama");

    const model = screen.getByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "llava:13b");
    expect(preset).toHaveValue("");

    await userEvent.selectOptions(preset, "OpenAI");
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("https://api.openai.com/v1");
    expect(model).toHaveValue("gpt-5-mini");
    await userEvent.selectOptions(preset, "Anthropic");
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("https://api.anthropic.com/v1");
    expect(model).toHaveValue("claude-haiku-5-5");

    // Back to Ollama brings back the default local model.
    await userEvent.selectOptions(preset, "Ollama");
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("http://localhost:11434/v1");
    expect(model).toHaveValue("qwen3-vl:4b");
    expect(screen.getByText(/nothing leaves this computer/)).not.toHaveClass("ai-privacy-cloud");
  });

  it("says the key is kept in the keychain when there is one", async () => {
    mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, apiKey: "sk-secret", apiKeyStorage: "keychain" } });
    render(<SettingsWindow />);

    const hint = await screen.findByTestId("ai-api-key-hint");
    expect(hint).toHaveTextContent("kept in your system keychain, not in Grab-it's settings file");
    expect(hint).not.toHaveTextContent("plain text");
    expect(screen.getByLabelText("API key")).toHaveValue("sk-secret");
  });

  it("says the key is kept in plain text in the settings file without a keychain", async () => {
    mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, apiKeyStorage: "settingsFile" } });
    render(<SettingsWindow />);

    const hint = await screen.findByTestId("ai-api-key-hint");
    expect(hint).toHaveTextContent("no keychain Grab-it can use, so it is kept in plain text in Grab-it's settings file");
    expect(hint).toHaveTextContent("Only cloud providers need one");
  });

  it("saves an emptied key as none", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, apiKey: "sk-old" } });
    render(<SettingsWindow />);
    await userEvent.clear(await screen.findByLabelText("API key"));
    await userEvent.type(screen.getByLabelText("Model"), "{Enter}");
    await waitFor(() => expect(backend.ai.apiKey).toBeNull());
  });

  it("tests the connection, saving what was typed first", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const model = await screen.findByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "llava:13b");

    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText("Connected: qwen3-vl:4b (4.4B, Q4_K_M)")).toBeInTheDocument();
    const order = commands(backend).filter((cmd) => cmd === "set_preferences" || cmd === "ai_test_connection");
    expect(order).toEqual(["set_preferences", "ai_test_connection"]);
    expect(backend.ai.model).toBe("llava:13b");
  });

  it("shows why the connection test failed", async () => {
    const backend = mockBackend({ testResult: "error: could not connect to http://localhost:11434/v1" });
    render(<SettingsWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/could not connect to http:\/\/localhost:11434/)).toHaveClass("ai-result-error");
    // Nothing was typed, so nothing was saved.
    expect(commands(backend)).not.toContain("set_preferences");
  });

  it("re-describes every capture after confirmation", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true } });
    render(<SettingsWindow />);
    const start = await screen.findByRole("button", { name: "Re-describe all…" });
    await waitFor(() => expect(start).toBeEnabled());

    await userEvent.click(start);
    expect(commands(backend)).not.toContain("ai_redescribe_all");
    await userEvent.click(screen.getByRole("button", { name: "Re-describe all" }));

    await waitFor(() => expect(commands(backend)).toContain("ai_redescribe_all"));
    expect(await screen.findByText(/Describing every capture again/)).toBeInTheDocument();
  });

  it("picks Claude Code at once, hiding the endpoint's fields", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true } });
    render(<SettingsWindow />);
    const claude = await screen.findByRole("radio", { name: /Claude Code/ });
    expect(screen.getByRole("radio", { name: /OpenAI-compatible endpoint/ })).toBeChecked();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    await waitFor(() => expect(claude).toBeEnabled());

    await userEvent.click(claude);

    await waitFor(() => expect(claude).toBeChecked());
    expect(backend.ai).toEqual({ ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "claudeCode" });
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    // Its own model instead, saved with Save.
    expect(screen.getByLabelText("Model")).toHaveValue("haiku");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Claude Code sends your screenshots.*to Anthropic/)).toHaveClass("ai-privacy-cloud");
    expect(screen.queryByTestId("ai-missing")).not.toBeInTheDocument();

    // Back to the endpoint, with what it had.
    await userEvent.click(screen.getByRole("radio", { name: /OpenAI-compatible endpoint/ }));
    await waitFor(() => expect(backend.ai.provider).toBe("endpoint"));
    expect(await screen.findByLabelText("Endpoint URL")).toHaveValue("http://localhost:11434/v1");
  });

  it("shows a stored endpoint user without a provider as using the endpoint", async () => {
    mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: null } });
    render(<SettingsWindow />);
    expect(await screen.findByRole("radio", { name: /OpenAI-compatible endpoint/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Claude Code/ })).not.toBeChecked();
  });

  it("says when Claude Code is chosen but not installed", async () => {
    const backend = mockBackend({
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "claudeCode" },
      claudePath: null,
    });
    render(<SettingsWindow />);
    expect(await screen.findByTestId("ai-missing")).toHaveTextContent(/cannot find Claude Code/);
    expect(commands(backend)).toContain("ai_clis");

    // Not a worry for someone using an endpoint.
    await userEvent.click(screen.getByRole("radio", { name: /OpenAI-compatible endpoint/ }));
    await waitFor(() => expect(screen.queryByTestId("ai-missing")).not.toBeInTheDocument());
  });

  it("saves another model for Claude Code and Codex", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "claudeCode" } });
    render(<SettingsWindow />);
    const model = await screen.findByLabelText("Model");
    await waitFor(() => expect(model).toBeEnabled());
    await userEvent.clear(model);
    await userEvent.type(model, "sonnet");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.ai.claudeModel).toBe("sonnet"));
    expect(backend.ai.provider).toBe("claudeCode");

    await userEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    await waitFor(() => expect(backend.ai.provider).toBe("codex"));
    await userEvent.type(screen.getByLabelText("Model"), "gpt-5-mini{Enter}");
    await waitFor(() => expect(backend.ai.codexModel).toBe("gpt-5-mini"));
    expect(backend.ai.claudeModel).toBe("sonnet");
  });

  it("tests Claude Code without saving anything first", async () => {
    const backend = mockBackend({
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "claudeCode" },
      testResult: "Claude Code (haiku) answered.",
    });
    render(<SettingsWindow />);
    const test = await screen.findByRole("button", { name: "Test connection" });
    await waitFor(() => expect(test).toBeEnabled());
    await userEvent.click(test);
    expect(await screen.findByText("Connected: Claude Code (haiku) answered.")).toBeInTheDocument();
    expect(commands(backend)).not.toContain("set_preferences");
  });

  it("picks Codex at once, saying where screenshots go", async () => {
    const backend = mockBackend({ ai: { ...DEFAULT_AI_PREFERENCES, enabled: true } });
    render(<SettingsWindow />);
    const codex = await screen.findByRole("radio", { name: /^Codex/ });
    await waitFor(() => expect(codex).toBeEnabled());

    await userEvent.click(codex);

    await waitFor(() => expect(codex).toBeChecked());
    expect(backend.ai).toEqual({ ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "codex" });
    expect(screen.getByRole("radio", { name: /Claude Code/ })).not.toBeChecked();
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveAttribute("placeholder", "Codex default");
    expect(screen.getByText(/Codex sends your screenshots.*to OpenAI/)).toHaveClass("ai-privacy-cloud");
    expect(screen.queryByTestId("ai-missing")).not.toBeInTheDocument();
  });

  it("says when Codex is chosen but not installed", async () => {
    mockBackend({
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "codex" },
      codexPath: null,
    });
    render(<SettingsWindow />);
    expect(await screen.findByTestId("ai-missing")).toHaveTextContent(/cannot find Codex: there is no codex command/);

    // Claude Code is installed, so choosing it clears the warning.
    await userEvent.click(screen.getByRole("radio", { name: /Claude Code/ }));
    await waitFor(() => expect(screen.queryByTestId("ai-missing")).not.toBeInTheDocument());
  });

  it("tests Codex without saving anything first", async () => {
    const backend = mockBackend({
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true, provider: "codex" },
      testResult: "Codex answered.",
    });
    render(<SettingsWindow />);
    const test = await screen.findByRole("button", { name: "Test connection" });
    await waitFor(() => expect(test).toBeEnabled());
    await userEvent.click(test);
    expect(await screen.findByText("Connected: Codex answered.")).toBeInTheDocument();
    expect(commands(backend)).not.toContain("set_preferences");
  });

  it("tells local endpoints from cloud ones", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalEndpoint("http://[::1]:8080")).toBe(true);
    expect(isLocalEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLocalEndpoint("not a url")).toBe(false);
  });
});

describe("SettingsWindow appearance", () => {
  it("saves the text sizes on release, and the popup's corner and time at once", async () => {
    const backend = mockBackend({ appearance: { textScale: 110, hubScale: 110, popupCorner: "bottomLeft", popupSeconds: 8 } });
    render(<SettingsWindow section="appearance" />);
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeInTheDocument();
    const window = await screen.findByRole("slider", { name: "Grab-it window" });
    await waitFor(() => expect(window).toBeEnabled());
    expect(window).toHaveValue("110");
    expect(screen.getByText("110%", { selector: ".scale-value[data-for='text-scale']" })).toBeInTheDocument();

    // Dragging shows the value; letting go saves it.
    fireEvent.change(window, { target: { value: "125" } });
    expect(screen.getByText("125%", { selector: ".scale-value[data-for='text-scale']" })).toBeInTheDocument();
    expect(backend.appearance).toMatchObject({ textScale: 110 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(backend.appearance).toMatchObject({ textScale: 125 }));

    const hub = screen.getByRole("slider", { name: "Menu bar hub" });
    await waitFor(() => expect(hub).toBeEnabled());
    fireEvent.change(hub, { target: { value: "95" } });
    fireEvent.keyUp(hub, { key: "ArrowLeft" });
    await waitFor(() => expect(backend.appearance).toMatchObject({ hubScale: 95 }));

    const topRight = screen.getByRole("radio", { name: "Top right" });
    await waitFor(() => expect(topRight).toBeEnabled());
    await userEvent.click(topRight);
    await waitFor(() => expect(topRight).toBeChecked());
    const seconds = screen.getByLabelText("Show it for");
    await waitFor(() => expect(seconds).toBeEnabled());
    await userEvent.selectOptions(seconds, "Until I close it");

    await waitFor(() =>
      expect(backend.appearance).toEqual({ textScale: 125, hubScale: 95, popupCorner: "topRight", popupSeconds: 0 }),
    );
  });
});

describe("SettingsWindow text size shortcuts", () => {
  it("moves the slider when a keyboard shortcut changes the text size", async () => {
    mockBackend({ appearance: { textScale: 110, hubScale: 110, popupCorner: "bottomLeft", popupSeconds: 8 } });
    render(<SettingsWindow section="appearance" />);
    const window = await screen.findByRole("slider", { name: "Grab-it window" });
    await waitFor(() => expect(window).toBeEnabled());
    expect(window).toHaveValue("110");
    expect(screen.getByText(/⌘\+, ⌘− and ⌘0 change it too|Ctrl\+\+, Ctrl\+− and Ctrl\+0 change it too/)).toBeInTheDocument();
    await emit("appearance-changed", { textScale: 115, hubScale: 110, popupCorner: "bottomLeft", popupSeconds: 8 });
    await waitFor(() => expect(window).toHaveValue("115"));
    expect(screen.getByText("115%", { selector: ".scale-value[data-for='text-scale']" })).toBeInTheDocument();
  });
});

describe("SettingsWindow recording", () => {
  it("records MP4 at high quality by default and saves a change at once", async () => {
    const backend = mockBackend();
    render(<SettingsWindow section="recording" />);
    expect(screen.getByRole("heading", { level: 1, name: "Recording" })).toBeInTheDocument();
    expect(screen.getByText("Changes save as you make them.")).toBeInTheDocument();
    const mp4 = await screen.findByRole("radio", { name: "MP4 video" });
    await waitFor(() => expect(mp4).toBeEnabled());
    expect(mp4).toBeChecked();
    expect(screen.getByRole("radio", { name: "High" })).toBeChecked();
    expect(await screen.findByText("Ready. Videos are encoded with libopenh264 by /usr/bin/ffmpeg.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Medium" }));
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, format: "mp4", quality: "medium", fps: 30, showCursor: true }));

    // A GIF has no quality to pick and needs no ffmpeg.
    await userEvent.click(screen.getByRole("radio", { name: "GIF" }));
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, format: "gif", quality: "medium", fps: 30, showCursor: true }));
    expect(screen.queryByRole("radio", { name: "Medium" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "60 fps" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("ffmpeg-status")).not.toBeInTheDocument();
  });

  it("records at 30 fps with the cursor by default and saves frame rate and cursor at once", async () => {
    const backend = mockBackend();
    render(<SettingsWindow section="recording" />);
    const thirty = await screen.findByRole("radio", { name: "30 fps" });
    await waitFor(() => expect(thirty).toBeEnabled());
    expect(thirty).toBeChecked();
    const cursor = screen.getByRole("switch", { name: /Show cursor/ });
    expect(cursor).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "60 fps" }));
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, format: "mp4", quality: "high", fps: 60, showCursor: true }));
    expect(screen.getByRole("radio", { name: "60 fps" })).toBeChecked();

    await userEvent.click(cursor);
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, format: "mp4", quality: "high", fps: 60, showCursor: false }));
    expect(screen.getByRole("switch", { name: /Show cursor/ })).not.toBeChecked();
  });

  it("leaves clicks and keystrokes out by default and saves either at once", async () => {
    const backend = mockBackend();
    render(<SettingsWindow section="recording" />);
    const clicks = await screen.findByRole("switch", { name: /Show clicks/ });
    await waitFor(() => expect(clicks).toBeEnabled());
    const keystrokes = screen.getByRole("switch", { name: /Show keystrokes/ });
    expect(clicks).not.toBeChecked();
    expect(keystrokes).not.toBeChecked();
    // jsdom is not a Mac: the hint says passwords cannot be told apart.
    expect(screen.getByText(keystrokesHint(false))).toBeInTheDocument();

    await userEvent.click(clicks);
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showClicks: true }));
    expect(screen.getByRole("switch", { name: /Show clicks/ })).toBeChecked();

    await waitFor(() => expect(screen.getByRole("switch", { name: /Show keystrokes/ })).toBeEnabled());
    await userEvent.click(screen.getByRole("switch", { name: /Show keystrokes/ }));
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showClicks: true, showKeystrokes: true }));
    expect(screen.getByRole("switch", { name: /Show keystrokes/ })).toBeChecked();

    await waitFor(() => expect(screen.getByRole("switch", { name: /Show clicks/ })).toBeEnabled());
    await userEvent.click(screen.getByRole("switch", { name: /Show clicks/ }));
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showKeystrokes: true }));
  });

  it("says which platforms can leave out passwords from keystrokes", () => {
    expect(keystrokesHint(true)).toMatch(/except while you type a password/);
    expect(keystrokesHint(true)).toMatch(/Input Monitoring/);
    expect(keystrokesHint(false)).toMatch(/cannot tell when you type a password/);
  });

  it("offers Show clicks and Show keystrokes for a GIF too", async () => {
    mockBackend({ recording: { ...DEFAULT_RECORDING, format: "gif", showClicks: true, showKeystrokes: true } });
    render(<SettingsWindow section="recording" />);
    const clicks = await screen.findByRole("switch", { name: /Show clicks/ });
    await waitFor(() => expect(clicks).toBeEnabled());
    expect(clicks).toBeChecked();
    expect(screen.getByRole("switch", { name: /Show keystrokes/ })).toBeChecked();
  });

  it("offers Show cursor for a GIF too", async () => {
    mockBackend({ recording: { ...DEFAULT_RECORDING, format: "gif", fps: 60, showCursor: false } });
    render(<SettingsWindow section="recording" />);
    const cursor = await screen.findByRole("switch", { name: /Show cursor/ });
    await waitFor(() => expect(cursor).toBeEnabled());
    expect(cursor).not.toBeChecked();
    expect(screen.queryByRole("radio", { name: "60 fps" })).not.toBeInTheDocument();
  });

  it("shows the ffmpeg download's progress", async () => {
    mockBackend({ ffmpeg: { state: "downloading", downloaded: 25, total: 100 } });
    render(<SettingsWindow section="recording" />);
    expect(await screen.findByText("Downloading ffmpeg… 25%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "ffmpeg download" })).toHaveAttribute("value", "25");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers Retry when ffmpeg could not be set up", async () => {
    const backend = mockBackend({ ffmpeg: { state: "failed", message: "could not download ffmpeg: offline" } });
    render(<SettingsWindow section="recording" />);
    expect(await screen.findByText(/Could not set up ffmpeg: could not download ffmpeg: offline/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Downloading ffmpeg… 0.0 MB")).toBeInTheDocument();
    expect(commands(backend)).toContain("ffmpeg_retry");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("says which ffmpeg and encoder record MP4", async () => {
    mockBackend({ ffmpeg: { state: "ready", path: "/opt/homebrew/bin/ffmpeg", encoder: "h264_videotoolbox" } });
    render(<SettingsWindow section="recording" />);
    expect(
      await screen.findByText("Ready. Videos are encoded with h264_videotoolbox by /opt/homebrew/bin/ffmpeg."),
    ).toBeInTheDocument();
  });

  it("says how to install ffmpeg where it cannot be downloaded, and looks again on Retry", async () => {
    const backend = mockBackend({
      ffmpeg: { state: "notInstalled", install: "brew install ffmpeg" },
      ffmpegAfterRetry: { state: "checking" },
    });
    render(<SettingsWindow section="recording" />);
    const command = await screen.findByText("brew install ffmpeg");
    expect(command.tagName).toBe("CODE");
    expect(screen.getByTestId("ffmpeg-status")).toHaveTextContent(
      "MP4 needs ffmpeg. Install it with brew install ffmpeg, then press Retry. Until then, recordings are saved as GIFs.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Finding the best video encoder…")).toBeInTheDocument();
    expect(commands(backend)).toContain("ffmpeg_retry");
  });
  it("records no sound by default and records the system default microphone when Microphone is chosen", async () => {
    const backend = mockBackend({
      microphones: [
        { id: "alsa_input.pci-analog-stereo", name: "Built-in Audio", isDefault: true },
        { id: "alsa_input.usb-yeti", name: "Yeti Stereo Microphone", isDefault: false },
      ],
    });
    render(<SettingsWindow section="recording" />);
    const audio = await screen.findByRole("combobox", { name: "Audio" });
    await waitFor(() => expect(audio).toBeEnabled());
    expect(audio).toHaveValue("none");
    expect(screen.queryByRole("combobox", { name: "Microphone" })).not.toBeInTheDocument();

    await userEvent.selectOptions(audio, "microphone");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, audio: "microphone", microphone: null }));
    const microphone = await screen.findByRole("combobox", { name: "Microphone" });
    await waitFor(() => expect(microphone).toBeEnabled());
    expect(microphone).toHaveValue("");
    expect(screen.getByRole("option", { name: "System default (Built-in Audio)" })).toBeInTheDocument();
    expect(commands(backend)).toContain("recording_microphones");

    await userEvent.selectOptions(microphone, "Yeti Stereo Microphone");
    await waitFor(() =>
      expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, audio: "microphone", microphone: "alsa_input.usb-yeti" }),
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Microphone" }), "System default (Built-in Audio)");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, audio: "microphone", microphone: null }));
  });

  it("records system sound alone or mixed with the microphone", async () => {
    const backend = mockBackend({
      microphones: [{ id: "alsa_input.pci-analog-stereo", name: "Built-in Audio", isDefault: true }],
    });
    render(<SettingsWindow section="recording" />);
    const audio = await screen.findByRole("combobox", { name: "Audio" });
    await waitFor(() => expect(audio).toBeEnabled());
    expect(await screen.findByRole("option", { name: "System sound" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Microphone and system sound" })).toBeInTheDocument();
    expect(commands(backend)).toContain("recording_system_audio");

    await userEvent.selectOptions(audio, "system");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, audio: "system", microphone: null }));
    // System sound alone has no microphone to pick.
    expect(screen.queryByRole("combobox", { name: "Microphone" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Audio" }), "both");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, audio: "both", microphone: null }));
    const microphone = await screen.findByRole("combobox", { name: "Microphone" });
    await waitFor(() => expect(microphone).toBeEnabled());
    expect(screen.getByRole("option", { name: "System default (Built-in Audio)" })).toBeInTheDocument();
  });

  it("hides System and Both where system sound cannot be recorded", async () => {
    mockBackend({ systemSound: false });
    render(<SettingsWindow section="recording" />);
    const audio = await screen.findByRole("combobox", { name: "Audio" });
    await waitFor(() => expect(audio).toBeEnabled());
    expect(screen.getByRole("option", { name: "Microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "System sound" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microphone and system sound" })).not.toBeInTheDocument();
  });

  it("still shows a saved Both where system sound cannot be recorded", async () => {
    mockBackend({ systemSound: false, recording: { ...DEFAULT_RECORDING, audio: "both" } });
    render(<SettingsWindow section="recording" />);
    const audio = await screen.findByRole("combobox", { name: "Audio" });
    await waitFor(() => expect(audio).toBeEnabled());
    expect(audio).toHaveValue("both");
    expect(screen.queryByRole("option", { name: "System sound" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Microphone" })).toBeInTheDocument();
  });

  it("disables Audio and the microphone for a GIF", async () => {
    mockBackend({ recording: { ...DEFAULT_RECORDING, format: "gif", audio: "microphone", microphone: "Mic" } });
    render(<SettingsWindow section="recording" />);
    const audio = await screen.findByRole("combobox", { name: "Audio" });
    await screen.findByText("GIFs are silent. Choose MP4 video to record sound.");
    expect(audio).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Microphone" })).toBeDisabled();
  });

  it("keeps a chosen microphone that is not connected", async () => {
    mockBackend({
      recording: { ...DEFAULT_RECORDING, audio: "microphone", microphone: "USB Headset" },
      microphones: [{ id: "Built-in Microphone", name: "Built-in Microphone", isDefault: true }],
    });
    render(<SettingsWindow section="recording" />);
    const microphone = await screen.findByRole("combobox", { name: "Microphone" });
    await waitFor(() => expect(microphone).toBeEnabled());
    expect(microphone).toHaveValue("USB Headset");
    expect(screen.getByRole("option", { name: "USB Headset (not connected)" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Built-in Microphone" })).toBeInTheDocument();
  });
});

describe("SettingsWindow webcam", () => {
  let media: FakeMedia | null = null;

  afterEach(() => {
    media?.restore();
    media = null;
  });

  it("leaves the webcam out by default, and asks for the camera when it is turned on", async () => {
    media = fakeMedia({
      // Names and ids are hidden until a camera has been allowed.
      devices: [camera("", "")],
      devicesAfterOpen: [camera("cam-front", "FaceTime HD Camera"), camera("cam-usb", "USB Webcam")],
    });
    const backend = mockBackend();
    render(<SettingsWindow section="recording" />);
    const webcam = await screen.findByRole("switch", { name: /Show webcam/ });
    await waitFor(() => expect(webcam).toBeEnabled());
    expect(webcam).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Webcam shape" })).not.toBeInTheDocument();
    expect(media.requests).toEqual([]);

    await userEvent.click(webcam);
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showWebcam: true }));
    const picker = await screen.findByRole("combobox", { name: "Camera" });
    expect(await screen.findByRole("option", { name: "USB Webcam" })).toBeInTheDocument();
    expect(media.requests).toHaveLength(1);
    // The camera opened to ask is closed straight away.
    expect(media.stopped).toBe(1);
    await waitFor(() => expect(picker).toBeEnabled());
    expect(picker).toHaveValue("");

    await userEvent.selectOptions(picker, "USB Webcam");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showWebcam: true, camera: "cam-usb" }));

    const shape = screen.getByRole("combobox", { name: "Webcam shape" });
    await waitFor(() => expect(shape).toBeEnabled());
    expect(shape).toHaveValue("round");
    await userEvent.selectOptions(shape, "Rounded square");
    await waitFor(() =>
      expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showWebcam: true, camera: "cam-usb", webcamShape: "rounded" }),
    );

    await waitFor(() => expect(screen.getByRole("combobox", { name: "Camera" })).toBeEnabled());
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Camera" }), "System default");
    await waitFor(() => expect(backend.recording).toEqual({ ...DEFAULT_RECORDING, showWebcam: true, webcamShape: "rounded" }));
  });

  it("lists the cameras without asking when the webcam is already on, and keeps a camera that is gone", async () => {
    media = fakeMedia({ devices: [camera("cam-front", "FaceTime HD Camera")] });
    mockBackend({ recording: { ...DEFAULT_RECORDING, showWebcam: true, camera: "cam-old", webcamShape: "rounded" } });
    render(<SettingsWindow section="recording" />);
    const picker = await screen.findByRole("combobox", { name: "Camera" });
    expect(await screen.findByRole("option", { name: "FaceTime HD Camera" })).toBeInTheDocument();
    expect(picker).toHaveValue("cam-old");
    expect(screen.getByRole("option", { name: "Saved camera (not connected)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Webcam shape" })).toHaveValue("rounded");
    expect(media.requests).toEqual([]);
  });

  it("offers only the system default where the window cannot list cameras", async () => {
    mockBackend({ recording: { ...DEFAULT_RECORDING, showWebcam: true } });
    render(<SettingsWindow section="recording" />);
    const picker = await screen.findByRole("combobox", { name: "Camera" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["System default"]);
  });
});

describe("listCameras", () => {
  let media: FakeMedia | null = null;

  afterEach(() => {
    media?.restore();
    media = null;
  });

  it("numbers cameras whose names are hidden and leaves out other devices", async () => {
    media = fakeMedia({
      devices: [camera("a", ""), { kind: "audioinput", deviceId: "mic", label: "Mic" }, camera("b", "Desk Cam")],
    });
    expect(await listCameras()).toEqual([
      { id: "a", name: "Camera 1" },
      { id: "b", name: "Desk Cam" },
    ]);
  });

  it("keeps the numbered names when the camera is refused", async () => {
    media = fakeMedia({ devices: [camera("a", "")], fail: { name: "NotAllowedError" } });
    expect(await listCameras(true)).toEqual([{ id: "a", name: "Camera 1" }]);
    expect(media.requests).toHaveLength(1);
  });

  it("is empty where the window has no media devices", async () => {
    expect(await listCameras(true)).toEqual([]);
  });
});

describe("SettingsWindow storage", () => {
  const kept: Retention = { image: null, gif: 90, video: 30, removal: "trash" };

  it("shows each kind's Keep setting with its count, size and what is due", async () => {
    mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("Changes save as you make them.")).toBeInTheDocument();

    const screenshots = await screen.findByLabelText("Screenshots");
    expect(screenshots).toHaveValue("");
    expect(screen.getByLabelText("GIFs")).toHaveValue("90");
    expect(screen.getByLabelText("Videos")).toHaveValue("30");
    expect(await screen.findByTestId("keep-image-hint")).toHaveTextContent("1,102 screenshots · 412 MB · never removed");
    expect(screen.getByTestId("keep-gif-hint")).toHaveTextContent("96 GIFs · 1.1 GB · 255 MB older than 90 days");
    expect(screen.getByTestId("keep-video-hint")).toHaveTextContent("86 videos · 4.7 GB · 3.7 GB older than 30 days");
    expect(within(screenshots).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "For 1 week",
      "For 30 days",
      "For 90 days",
      "For 1 year",
      "Forever",
    ]);
    expect(screen.getByLabelText("Remove items by")).toHaveValue("trash");
    expect(screen.getByText(/Starred, tagged, noted and annotated items are never removed/)).toBeInTheDocument();
  });

  it("keeps everything forever in the Trash when the settings say nothing", async () => {
    mockBackend();
    render(<SettingsWindow section="storage" />);
    expect(await screen.findByLabelText("Videos")).toHaveValue("");
    expect(screen.getByLabelText("Remove items by")).toHaveValue("trash");
  });

  it("saves a longer Keep setting at once", async () => {
    const backend = mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    const gifs = await screen.findByLabelText("GIFs");
    await waitFor(() => expect(gifs).toBeEnabled());

    await userEvent.selectOptions(gifs, "Forever");

    await waitFor(() => expect(backend.retention).toEqual({ ...kept, gif: null }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("keep-gif-hint")).toHaveTextContent("never removed"));
  });

  it("asks before a shorter Keep setting removes items, then saves it", async () => {
    const backend = mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    const videos = await screen.findByLabelText("Videos");
    await waitFor(() => expect(videos).toBeEnabled());

    await userEvent.selectOptions(videos, "For 1 week");

    const dialog = await screen.findByRole("dialog", { name: "Keep videos for 1 week?" });
    expect(dialog).toHaveTextContent("72 videos (3.7 GB) are older and will be moved to the Trash at the next cleanup.");
    expect(commands(backend)).not.toContain("set_retention");
    const asked = backend.calls.filter((call) => call.cmd === "library_storage").pop();
    expect(asked?.payload).toEqual({ candidate: { ...kept, video: 7 } });

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep for 1 week" }));

    await waitFor(() => expect(backend.retention).toEqual({ ...kept, video: 7 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Videos")).toHaveValue("7"));
  });

  it("says a permanent delete in the confirmation", async () => {
    mockBackend({ retention: { ...kept, removal: "permanent" } });
    render(<SettingsWindow section="storage" />);
    const gifs = await screen.findByLabelText("GIFs");
    await waitFor(() => expect(gifs).toBeEnabled());

    await userEvent.selectOptions(gifs, "For 30 days");

    const dialog = await screen.findByRole("dialog", { name: "Keep GIFs for 30 days?" });
    expect(dialog).toHaveTextContent("12 GIFs (255 MB) are older and will be deleted permanently at the next cleanup.");
  });

  it("keeps the setting when the confirmation is cancelled", async () => {
    const backend = mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    const videos = await screen.findByLabelText("Videos");
    await waitFor(() => expect(videos).toBeEnabled());

    await userEvent.selectOptions(videos, "For 1 week");
    const dialog = await screen.findByRole("dialog", { name: "Keep videos for 1 week?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(commands(backend)).not.toContain("set_retention");
    expect(screen.getByLabelText("Videos")).toHaveValue("30");
  });

  it("saves a shorter Keep setting at once when it removes nothing", async () => {
    const backend = mockBackend();
    render(<SettingsWindow section="storage" />);
    const screenshots = await screen.findByLabelText("Screenshots");
    await waitFor(() => expect(screenshots).toBeEnabled());

    await userEvent.selectOptions(screenshots, "For 1 year");

    await waitFor(() => expect(backend.retention).toEqual({ ...DEFAULT_RETENTION, image: 365 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("keep-image-hint")).toHaveTextContent("nothing older than 1 year"));
  });

  it("saves how items are removed", async () => {
    const backend = mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    const removal = await screen.findByLabelText("Remove items by");
    await waitFor(() => expect(removal).toBeEnabled());

    await userEvent.selectOptions(removal, "Deleting permanently");

    await waitFor(() => expect(backend.retention).toEqual({ ...kept, removal: "permanent" }));
    expect(await screen.findByText(/gone for good/)).toBeInTheDocument();
  });

  it("purges the picked kinds now, whatever the Keep settings say", async () => {
    const backend = mockBackend({ retention: kept });
    render(<SettingsWindow section="storage" />);
    const purge = await screen.findByRole("button", { name: "Purge…" });
    await waitFor(() => expect(purge).toBeEnabled());

    await userEvent.click(purge);

    const dialog = await screen.findByRole("dialog", { name: "Purge now" });
    await waitFor(() =>
      expect(dialog).toHaveTextContent("Removes 1,284 items (6.2 GB) now, whatever your Keep settings say."),
    );
    expect(within(dialog).getByRole("checkbox", { name: "Screenshots" })).toBeChecked();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Screenshots" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "GIFs" }));
    expect(dialog).toHaveTextContent("Removes 86 items (4.7 GB) now");

    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    await screen.findByRole("dialog", { name: "Cleanup done" });
    const run = backend.calls.find((call) => call.cmd === "library_clean_up");
    expect(run?.payload).toEqual({
      removal: "trash",
      confirmed: { count: 86, bytes: 4.7 * GB },
      retention: { image: null, gif: null, video: 0, removal: "trash" },
    });
    expect(backend.retention).toEqual(kept);
  });

  it("still sets Keep when sizes cannot be read", async () => {
    mockBackend({ storageFails: true });
    render(<SettingsWindow section="storage" />);
    const gifs = await screen.findByLabelText("GIFs");
    await waitFor(() => expect(gifs).toBeEnabled());
    expect(screen.queryByTestId("keep-gif-hint")).not.toBeInTheDocument();
  });
});
