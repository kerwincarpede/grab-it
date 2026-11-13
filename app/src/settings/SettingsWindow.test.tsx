import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import SettingsWindow from "./SettingsWindow";

const DEFAULT_HOTKEYS = {
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
  text: "Shift+PrintScreen",
  colour: "Ctrl+Shift+PrintScreen",
};

interface Backend {
  afterCapture: string;
  copyToClipboard: boolean;
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
  });
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return settings();
      case "set_preferences": {
        if (backend.setError) throw backend.setError;
        const { preferences } = payload as { preferences: { afterCapture: string; copyToClipboard: boolean } };
        backend.afterCapture = preferences.afterCapture;
        backend.copyToClipboard = preferences.copyToClipboard;
        return settings();
      }
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
      payload: { preferences: { afterCapture: "editor", copyToClipboard: true } },
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
      preferences: { afterCapture: "nothing", copyToClipboard: false },
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
