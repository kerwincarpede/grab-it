import { acceleratorKeys } from "../settings/accelerator";

const MAC_KEYS: Record<string, string> = {
  Cmd: "⌘",
  Command: "⌘",
  CmdOrCtrl: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
  Ctrl: "⌃",
  Control: "⌃",
};

/** A hotkey as a short label: `⌘⇧2` on a Mac, `Ctrl+Shift+F` elsewhere. */
export function shortcutLabel(accelerator: string, mac = /Mac/.test(navigator.userAgent)): string {
  const keys = acceleratorKeys(accelerator);
  return mac ? keys.map((key) => MAC_KEYS[key] ?? key).join("") : keys.join("+");
}

/** A hotkey's keys one by one, as symbols on a Mac: `["⌘", "⇧", "2"]`. */
export function keyCaps(accelerator: string, mac = /Mac/.test(navigator.userAgent)): string[] {
  const keys = acceleratorKeys(accelerator);
  return mac ? keys.map((key) => MAC_KEYS[key] ?? key) : keys;
}
