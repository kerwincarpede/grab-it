import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import SettingsWindow from "./SettingsWindow";
import { DEFAULT_AI_PREFERENCES, isLocalEndpoint, type AiPreferences } from "./api";

const DEFAULT_HOTKEYS = {
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
  text: "Shift+PrintScreen",
  colour: "Ctrl+Shift+PrintScreen",
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
  /** The editor section's auto-apply flag. */
  autoBackdrop?: boolean;
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
    testResult: "qwen2.5vl:7b (7.6B, Q4_K_M)",
    claudePath: "/usr/local/bin/claude",
    saveFolder: "/home/me/Pictures/Grab-it",
    picked: "/data/Shots",
    hotkeys: { ...DEFAULT_HOTKEYS },
    hotkeyWarnings: [],
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
  });
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return settings();
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
        return { claudeCode: backend.claudePath };
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
  });
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
    expect(screen.getByRole("checkbox", { name: /Copy every capture/ })).toBeChecked();

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
    const copy = await screen.findByRole("checkbox", { name: /Copy every capture/ });
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
    const toggle = await screen.findByRole("checkbox", { name: /Frame new captures with the last backdrop/ });
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
    const toggle = await screen.findByRole("checkbox", { name: /Frame new captures with the last backdrop/ });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("turns starting at sign-in on", async () => {
    const backend = mockBackend({ autostart: false });
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("checkbox", { name: /Start Grab-it when you sign in/ });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "set_autostart", payload: { enabled: true } });
  });

  it("leaves the start-up toggle out where the system cannot say", async () => {
    mockBackend();
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");
    expect(screen.queryByRole("checkbox", { name: /Start Grab-it/ })).not.toBeInTheDocument();
  });

  it("shows the current hotkeys", async () => {
    mockBackend();
    render(<SettingsWindow />);
    expect(await screen.findByLabelText("Region")).toHaveValue("PrintScreen");
    expect(screen.getByLabelText("Window")).toHaveValue("Alt+PrintScreen");
    expect(screen.getByLabelText("Screen")).toHaveValue("Ctrl+PrintScreen");
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

    const toggle = await screen.findByRole("checkbox", { name: /Describe captures with AI/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("http://localhost:11434/v1");
    expect(screen.getByLabelText("Model")).toHaveValue("qwen2.5vl:7b");
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue("sk-secret");
    expect(screen.getByText(/Only cloud providers need one/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Only describe new captures/ })).toBeChecked();
    expect(screen.getByText(/nothing leaves this computer; a cloud endpoint receives your screenshots/)).toBeInTheDocument();
    // Nothing to re-describe while it is off.
    expect(screen.getByRole("button", { name: "Re-describe all…" })).toBeDisabled();
  });

  it("saves the toggles at once, keeping the other preferences", async () => {
    const backend = mockBackend({ afterCapture: "editor" });
    render(<SettingsWindow />);
    const toggle = await screen.findByRole("checkbox", { name: /Describe captures with AI/ });
    await waitFor(() => expect(toggle).toBeEnabled());

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(lastPreferences(backend)).toEqual({
      afterCapture: "editor",
      copyToClipboard: true,
      ai: { ...DEFAULT_AI_PREFERENCES, enabled: true },
    });

    const newOnly = screen.getByRole("checkbox", { name: /Only describe new captures/ });
    await waitFor(() => expect(newOnly).toBeEnabled());
    await userEvent.click(newOnly);
    await waitFor(() => expect(newOnly).not.toBeChecked());
    expect(backend.ai).toEqual({ ...DEFAULT_AI_PREFERENCES, enabled: true, newCapturesOnly: false });
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
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

    expect(await screen.findByText("Connected: qwen2.5vl:7b (7.6B, Q4_K_M)")).toBeInTheDocument();
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
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
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

  it("tells local endpoints from cloud ones", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalEndpoint("http://[::1]:8080")).toBe(true);
    expect(isLocalEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLocalEndpoint("not a url")).toBe(false);
  });
});
