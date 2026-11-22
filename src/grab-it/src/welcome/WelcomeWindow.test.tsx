import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { acceleratorKeys } from "../settings/accelerator";
import type { PermissionStatus } from "../app/bindings";
import { DEFAULT_AI_PREFERENCES, type AiPreferences } from "../settings/api";
import { mockCommands } from "../test/mockCommands";
import { testSettings } from "../test/settingsFixture";
import WelcomeWindow from "./WelcomeWindow";

// Keep AI subscriptions local to this component test. Late subscription cleanup
// must not call Tauri internals after the shared setup clears the IPC mocks.
const aiEvents = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock("../library/api", () => ({
  onAiStatus: async (callback: () => void) => {
    aiEvents.listeners.add(callback);
    return () => { aiEvents.listeners.delete(callback); };
  },
}));

const HOTKEYS = {
  allInOne: "Ctrl+Alt+PrintScreen",
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
  text: "Shift+PrintScreen",
  colour: "Ctrl+Shift+PrintScreen",
  library: "Alt+Shift+PrintScreen",
  steps: "Ctrl+Alt+Shift+PrintScreen",
};

const NOTHING_ASKED: PermissionStatus = {
  screenRecording: "notAsked",
  inputMonitoring: "notAsked",
  microphone: "notAsked",
  camera: "notAsked",
  resume: false,
  askedThisLaunch: false,
};

/** Just after Allow all: macOS shows the two restart permissions as off until Grab-it restarts. */
const WAITING_FOR_RESTART: PermissionStatus = {
  screenRecording: "off",
  inputMonitoring: "off",
  microphone: "allowed",
  camera: "allowed",
  resume: true,
  askedThisLaunch: false,
};

const ALL_ALLOWED: PermissionStatus = {
  screenRecording: "allowed",
  inputMonitoring: "allowed",
  microphone: "allowed",
  camera: "allowed",
  resume: false,
  askedThisLaunch: false,
};

function mockBackend(
  options: {
    failSettings?: boolean;
    failOpen?: string;
    ai?: Partial<AiPreferences>;
    /** What permission_status reports; everything allowed, as off macOS, by default. */
    permissions?: PermissionStatus;
    failPermissions?: boolean;
    /** What permission_status reports once Allow all has run. */
    afterAllowAll?: PermissionStatus;
  } = {},
) {
  return mockCommands(
    {
      permission_status: () => {
        if (options.failPermissions) throw "no status";
        return options.permissions ?? ALL_ALLOWED;
      },
      permission_request_all: () => {
        if (options.afterAllowAll) options.permissions = options.afterAllowAll;
        return options.permissions ?? ALL_ALLOWED;
      },
      effective_hotkeys: () => (options.failSettings ? {} : HOTKEYS),
      get_settings: () => {
        if (options.failSettings) throw "no settings";
        return testSettings({ saveFolder: "/shots", hotkeys: HOTKEYS, ai: { ...DEFAULT_AI_PREFERENCES, ...options.ai } });
      },
      open_target: () => {
        if (options.failOpen) throw options.failOpen;
        return null;
      },
    },
    { shouldMockEvents: true, otherwise: () => null },
  );
}

describe("WelcomeWindow", () => {
  it("lists what each hotkey does with the user's own keys", async () => {
    mockBackend();
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();

    const text = (await screen.findByLabelText("Shift+PrintScreen")).closest("li") as HTMLElement;
    expect(within(text).getByText("Capture text")).toBeInTheDocument();
    const colour = screen.getByLabelText("Ctrl+Shift+PrintScreen");
    expect(within(colour).getAllByText(/Ctrl|Shift|PrintScreen/)).toHaveLength(3);
    const library = screen.getByLabelText("Alt+Shift+PrintScreen").closest("li") as HTMLElement;
    expect(within(library).getByText("Open the library")).toBeInTheDocument();
    const allInOne = screen.getByLabelText("Ctrl+Alt+PrintScreen").closest("li") as HTMLElement;
    expect(within(allInOne).getByText("Capture & record…")).toBeInTheDocument();
  });

  it("mentions AI descriptions only while Claude Code describes captures", async () => {
    mockBackend({ ai: { enabled: true, provider: "claudeCode" } });
    const { unmount } = render(<WelcomeWindow />);
    expect(await screen.findByText(/Claude Code describes each new capture/)).toBeInTheDocument();
    unmount();

    for (const ai of [
      { enabled: false, provider: "claudeCode" },
      // The provider is on, but it describes nothing.
      { enabled: true, provider: "claudeCode", automaticDescriptions: false },
      { enabled: true, provider: null },
      undefined,
    ] as (Partial<AiPreferences> | undefined)[]) {
      mockBackend({ ai });
      const view = render(<WelcomeWindow />);
      await screen.findByLabelText("Shift+PrintScreen");
      expect(screen.queryByText(/Claude Code describes/)).not.toBeInTheDocument();
      // Otherwise it says AI integration is optional and off until set up.
      expect(screen.getByText(/Optional and off until you choose a provider in Settings/)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("swaps in the Claude Code tip when describing turns on after it opened", async () => {
    const options: { ai?: object } = {};
    mockBackend(options);
    render(<WelcomeWindow />);
    await screen.findByLabelText("Shift+PrintScreen");
    expect(screen.queryByText(/Claude Code describes/)).not.toBeInTheDocument();

    options.ai = { enabled: true, provider: "claudeCode" };
    await act(async () => {
      for (const listener of aiEvents.listeners) listener();
    });
    expect(await screen.findByText(/Claude Code describes each new capture/)).toBeInTheDocument();
  });

  it("still explains itself when the hotkeys cannot be read", async () => {
    const calls = mockBackend({ failSettings: true });
    render(<WelcomeWindow />);
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("get_settings"));
    expect(await screen.findByText("Capture a region")).toBeInTheDocument();
    expect(screen.getByText("Quick Access")).toBeInTheDocument();
  });

  it.each([
    ["Capture a region now", "region"],
    ["Open Settings", "settings"],
    ["Open the Library", "library"],
  ])("%s opens %s", async (name, target) => {
    const calls = mockBackend();
    render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "open_target", payload: { target } }));
  });

  it("says so when something cannot be opened", async () => {
    mockBackend({ failOpen: "could not open Settings" });
    render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(await screen.findByText("could not open Settings")).toBeInTheDocument();
  });
});

/** The row for `title` on the Permissions page. */
function row(title: string): HTMLElement {
  return screen.getByText(title).closest("li") as HTMLElement;
}

describe("WelcomeWindow's Permissions page", () => {
  it("opens on the hotkeys when everything is allowed, as off macOS", async () => {
    const calls = mockBackend({ permissions: ALL_ALLOWED });
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Set up Grab-it" })).not.toBeInTheDocument();
    expect(calls.map((call) => call.cmd)).not.toContain("permission_finish");
  });

  it("opens on the hotkeys when the status cannot be read", async () => {
    mockBackend({ failPermissions: true });
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
  });

  it("opens on the hotkeys when nothing is missing, and finishes a setup waiting for that", async () => {
    const calls = mockBackend({ permissions: { ...ALL_ALLOWED, inputMonitoring: "off", camera: "off", resume: true } });
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("permission_finish"));
    // Brings up macOS's window-picker alert now, not on the first real capture.
    expect(calls.map((call) => call.cmd)).toContain("permission_prime_capture");
  });

  it("makes no throwaway capture unless setup resumes with nothing missing", async () => {
    for (const permissions of [ALL_ALLOWED, NOTHING_ASKED, WAITING_FOR_RESTART]) {
      const calls = mockBackend({ permissions });
      const view = render(<WelcomeWindow />);
      await screen.findByRole("heading", { name: /Welcome to Grab-it|Set up Grab-it/ });
      expect(calls.map((call) => call.cmd)).not.toContain("permission_prime_capture");
      view.unmount();
    }
  });

  it("lists every permission as not asked yet before Allow all", async () => {
    mockBackend({ permissions: NOTHING_ASKED });
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Set up Grab-it" })).toBeInTheDocument();
    for (const title of ["Screen Recording", "Input Monitoring", "Microphone", "Camera"]) {
      expect(within(row(title)).getByText("Not asked yet")).toBeInTheDocument();
    }
    expect(within(row("Screen Recording")).getByText(/Required/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart Grab-it" })).not.toBeInTheDocument();
    expect(screen.queryByText(/private window picker/)).not.toBeInTheDocument();
  });

  it("opens while only Screen Recording is off", async () => {
    mockBackend({ permissions: { ...ALL_ALLOWED, screenRecording: "off" } });
    render(<WelcomeWindow />);
    expect(await screen.findByRole("heading", { name: "Set up Grab-it" })).toBeInTheDocument();
    expect(within(row("Screen Recording")).getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("asks for everything, then offers one restart while Screen Recording and Input Monitoring wait for it", async () => {
    const calls = mockBackend({ permissions: { ...NOTHING_ASKED }, afterAllowAll: WAITING_FOR_RESTART });
    render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow all" }));

    const restart = await screen.findByRole("button", { name: "Restart Grab-it" });
    expect(calls.map((call) => call.cmd)).toContain("permission_request_all");
    for (const title of ["Screen Recording", "Input Monitoring"]) {
      expect(within(row(title)).getByText("Turn on in System Settings")).toBeInTheDocument();
    }
    for (const title of ["Microphone", "Camera"]) {
      expect(within(row(title)).getByText("Allowed")).toBeInTheDocument();
    }
    expect(screen.getByText(/only lets Grab-it use them after a restart/)).toBeInTheDocument();
    expect(screen.getByText(/may ask to let Grab-it bypass the system private window picker/)).toBeInTheDocument();
    expect(screen.getByText(/Allow For One Month: macOS asks again about once a month/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow all" })).not.toBeInTheDocument();

    await userEvent.click(within(row("Input Monitoring")).getByRole("button", { name: /Open System Settings for/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "permission_open_settings", payload: { permission: "inputMonitoring" } }),
    );

    await userEvent.click(restart);
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("permission_restart"));
    expect(calls.map((call) => call.cmd)).not.toContain("permission_finish");
  });

  it("still offers Restart Grab-it when reopened after Allow all", async () => {
    const calls = mockBackend({
      permissions: { ...NOTHING_ASKED },
      afterAllowAll: { ...WAITING_FOR_RESTART, askedThisLaunch: true },
    });
    const first = render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow all" }));
    await screen.findByRole("button", { name: "Restart Grab-it" });
    first.unmount();

    render(<WelcomeWindow />);
    const restart = await screen.findByRole("button", { name: "Restart Grab-it" });
    expect(within(row("Screen Recording")).getByText("Turn on in System Settings")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    await userEvent.click(restart);
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("permission_restart"));
    expect(calls.map((call) => call.cmd)).not.toContain("permission_finish");
  });

  it("offers Continue once Allow all leaves nothing waiting for a restart", async () => {
    const calls = mockBackend({
      permissions: { ...NOTHING_ASKED },
      afterAllowAll: { ...ALL_ALLOWED, microphone: "off", resume: true },
    });
    render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow all" }));

    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
    expect(calls.map((call) => call.cmd)).toContain("permission_finish");
  });

  it("shows a declined permission as off with a way to System Settings", async () => {
    const calls = mockBackend({ permissions: { ...ALL_ALLOWED, screenRecording: "off", camera: "off" } });
    render(<WelcomeWindow />);
    await screen.findByRole("heading", { name: "Set up Grab-it" });
    expect(within(row("Microphone")).getByText("Allowed")).toBeInTheDocument();
    expect(within(row("Camera")).getByText("Off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();

    await userEvent.click(within(row("Camera")).getByRole("button", { name: "Open System Settings for Camera" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "permission_open_settings", payload: { permission: "camera" } }),
    );
    // Turning on the camera needs no restart.
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();

    // Screen Recording does.
    await userEvent.click(
      within(row("Screen Recording")).getByRole("button", { name: "Open System Settings for Screen Recording" }),
    );
    expect(await screen.findByRole("button", { name: "Restart Grab-it" })).toBeInTheDocument();
  });

  it("Skip for now finishes setup and goes to the hotkeys", async () => {
    const calls = mockBackend({ permissions: NOTHING_ASKED });
    render(<WelcomeWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
    expect(calls.map((call) => call.cmd)).toContain("permission_finish");
    expect(calls.map((call) => call.cmd)).not.toContain("permission_request_all");
  });

  it("follows answers as they arrive by polling the status", async () => {
    const options = { permissions: { ...NOTHING_ASKED } as PermissionStatus };
    const calls = mockBackend(options);
    render(<WelcomeWindow />);
    await screen.findByRole("heading", { name: "Set up Grab-it" });

    options.permissions = { ...NOTHING_ASKED, microphone: "allowed" };
    await waitFor(() => expect(within(row("Microphone")).getByText("Allowed")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(calls.filter((call) => call.cmd === "permission_status").length).toBeGreaterThan(1);
  });

  it("says so when Grab-it cannot restart", async () => {
    mockCommands(
      {
        permission_status: () => WAITING_FOR_RESTART,
        permission_request_all: () => WAITING_FOR_RESTART,
        permission_restart: () => {
          throw "could not restart";
        },
      },
      { shouldMockEvents: true, otherwise: () => null },
    );
    render(<WelcomeWindow />);
    await screen.findByRole("heading", { name: "Set up Grab-it" });
    // Already asked: Continue, until System Settings is opened for one that needs a restart.
    await userEvent.click(within(row("Screen Recording")).getByRole("button", { name: /Open System Settings for/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Restart Grab-it" }));
    expect(await screen.findByText("could not restart")).toBeInTheDocument();
  });
});

describe("acceleratorKeys", () => {
  it("splits an accelerator into its keys", () => {
    expect(acceleratorKeys("Ctrl+Shift+PrintScreen")).toEqual(["Ctrl", "Shift", "PrintScreen"]);
    expect(acceleratorKeys("PrintScreen")).toEqual(["PrintScreen"]);
    expect(acceleratorKeys("")).toEqual([]);
  });
});
