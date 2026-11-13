/** Keys that only modify; pressing one alone does not finish a hotkey. */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

const NAMED_CODES: Record<string, string> = {
  PrintScreen: "PrintScreen",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
};

/** The main key of a hotkey, named as the global-shortcut parser expects. */
function keyName(code: string): string | null {
  if (code in NAMED_CODES) return NAMED_CODES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  return null;
}

export interface KeyPress {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Turns a key press into an accelerator like `Ctrl+Shift+S`, or null while
 * only modifiers are held or the key cannot be a hotkey. Uses the physical
 * key (`code`), so the result does not depend on the keyboard layout or on
 * Shift changing the character.
 */
export function acceleratorFromEvent(event: KeyPress, isMac = false): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = keyName(event.code);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push(isMac ? "Option" : "Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push(isMac ? "Cmd" : "Super");
  parts.push(key);
  return parts.join("+");
}

/** True on macOS, where hotkeys use Cmd and Option. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}
