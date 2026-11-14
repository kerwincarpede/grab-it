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
