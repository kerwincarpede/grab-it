import type { Settings_Serialize } from "../app/bindings";
import { DEFAULT_AI_PREFERENCES, DEFAULT_APPEARANCE, DEFAULT_RECORDING, DEFAULT_RETENTION } from "../settings/api";

/** Settings as `get_settings` sends them: the backend's defaults, with `overrides`. */
export function testSettings(overrides: Partial<Settings_Serialize> = {}): Settings_Serialize {
  return {
    saveFolder: "/home/me/Pictures/Grab-it",
    hotkeys: {
      allInOne: "Ctrl+Alt+PrintScreen",
      region: "PrintScreen",
      window: "Alt+PrintScreen",
      screen: "Ctrl+PrintScreen",
      text: "Shift+PrintScreen",
      colour: "Ctrl+Shift+PrintScreen",
      library: "Alt+Shift+PrintScreen",
      steps: "Ctrl+Alt+Shift+PrintScreen",
    },
    afterCapture: "quickAccess",
    copyToClipboard: true,
    ai: DEFAULT_AI_PREFERENCES,
    editor: {},
    showInDock: false,
    appearance: DEFAULT_APPEARANCE,
    recording: DEFAULT_RECORDING,
    retention: DEFAULT_RETENTION,
    permissions: { asked: true, resume: false },
    agentAccess: false,
    updateChannel: "stable",
    ...overrides,
  };
}
