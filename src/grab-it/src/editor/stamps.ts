import { textSize } from "./orient";

/**
 * Every bundled stamp, by the name a sidecar stores. Icons are drawn from
 * path data in the stamp's colour; cursors and emoji are SVG files in
 * `stamps/` that keep their own colours; the keycap is a drawn cap with a
 * typed label. Emoji are from Noto Emoji (Apache 2.0, `stamps/LICENSE`),
 * named `emoji-<codepoint>` after Noto's `emoji_u<codepoint>.svg`.
 */

export type StampKind = "icon" | "cursor" | "emoji" | "keycap";

/**
 * One part of an icon, on a 24px grid. `stroke` is a line in the stamp's
 * colour with a white edge, `fill` an area in the colour with a white edge,
 * and `mark` a line on top in the colour's contrast (the warning's "!").
 */
export interface IconPart {
  d: string;
  paint: "stroke" | "fill" | "mark";
}

export interface StampDef {
  name: string;
  /** Names the stamp in the picker. */
  label: string;
  kind: StampKind;
  /** Icons: what is drawn, on a 24px grid. */
  parts?: IconPart[];
  /** Cursors and emoji: the bundled SVG. */
  url?: string;
  /** Width over height. A keycap's depends on its label (see `stampBox`). */
  ratio: number;
}

/** The bundled SVGs as URLs, by file name. */
const FILES = import.meta.glob<string>("./stamps/*.svg", { eager: true, query: "?url", import: "default" });
const fileUrl = (file: string): string | undefined => FILES[`./stamps/${file}`];

const ICONS: StampDef[] = [
  { name: "check", label: "Check mark", kind: "icon", ratio: 1, parts: [{ d: "M4.5 12.5l5 5L19.5 6.5", paint: "stroke" }] },
  { name: "cross", label: "Cross", kind: "icon", ratio: 1, parts: [{ d: "M6 6l12 12M18 6L6 18", paint: "stroke" }] },
  {
    name: "warning",
    label: "Warning",
    kind: "icon",
    ratio: 1,
    parts: [
      { d: "M12 2.5L22.5 20.5H1.5Z", paint: "fill" },
      { d: "M12 9v5M12 17.2v.01", paint: "mark" },
    ],
  },
  {
    name: "question",
    label: "Question mark",
    kind: "icon",
    ratio: 1,
    parts: [
      { d: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z", paint: "fill" },
      { d: "M9.2 9.3a2.9 2.9 0 1 1 4.2 2.6c-.9.5-1.4 1.1-1.4 2.1M12 17.3v.01", paint: "mark" },
    ],
  },
  {
    name: "star",
    label: "Star",
    kind: "icon",
    ratio: 1,
    parts: [{ d: "M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z", paint: "fill" }],
  },
];

const CURSORS: StampDef[] = [
  { name: "cursor-arrow", label: "Arrow pointer", kind: "cursor", ratio: 22 / 32, url: fileUrl("cursor-arrow.svg") },
  { name: "cursor-hand", label: "Hand pointer", kind: "cursor", ratio: 28 / 32, url: fileUrl("cursor-hand.svg") },
  { name: "cursor-text", label: "Text pointer", kind: "cursor", ratio: 16 / 32, url: fileUrl("cursor-text.svg") },
];

export const KEYCAP: StampDef = { name: "keycap", label: "Key", kind: "keycap", ratio: 1 };

/** Codepoint (as Noto names its file), the emoji and its name. */
const EMOJI_LIST: [string, string, string][] = [
  ["1f44d", "👍", "Thumbs up"],
  ["1f44e", "👎", "Thumbs down"],
  ["1f44f", "👏", "Clapping hands"],
  ["1f64c", "🙌", "Raised hands"],
  ["1f64f", "🙏", "Folded hands"],
  ["1f440", "👀", "Eyes"],
  ["1f389", "🎉", "Party popper"],
  ["1f525", "🔥", "Fire"],
  ["2764", "❤️", "Red heart"],
  ["2b50", "⭐", "Star"],
  ["2705", "✅", "Check mark button"],
  ["274c", "❌", "Cross mark"],
  ["26a0", "⚠️", "Warning"],
  ["2753", "❓", "Question mark"],
  ["2757", "❗", "Exclamation mark"],
  ["1f4a1", "💡", "Light bulb"],
  ["1f680", "🚀", "Rocket"],
  ["1f41b", "🐛", "Bug"],
  ["1f512", "🔒", "Locked"],
  ["1f511", "🔑", "Key"],
  ["1f4cc", "📌", "Pushpin"],
  ["1f4ce", "📎", "Paperclip"],
  ["1f5d1", "🗑️", "Wastebasket"],
  ["270f", "✏️", "Pencil"],
  ["1f600", "😀", "Grinning face"],
  ["1f602", "😂", "Face with tears of joy"],
  ["1f60d", "😍", "Smiling face with heart-eyes"],
  ["1f914", "🤔", "Thinking face"],
  ["1f622", "😢", "Crying face"],
  ["1f631", "😱", "Face screaming in fear"],
];

const EMOJI: StampDef[] = EMOJI_LIST.map(([codepoint, , label]) => ({
  name: `emoji-${codepoint}`,
  label,
  kind: "emoji",
  ratio: 1,
  url: fileUrl(`emoji_u${codepoint}.svg`),
}));

/** Every bundled stamp, in picker order. */
export const STAMPS: StampDef[] = [...ICONS, ...CURSORS, KEYCAP, ...EMOJI];

const BY_NAME = new Map(STAMPS.map((stamp) => [stamp.name, stamp]));

/** The bundled stamp called `name`, or undefined for one this version does not have. */
export function stampDef(name: string): StampDef | undefined {
  return BY_NAME.get(name);
}

export function isStampName(name: unknown): name is string {
  return typeof name === "string" && BY_NAME.has(name);
}

/** Icons and the keycap take the stamp colour; cursors and emoji keep their own. */
export function takesColor(name: string): boolean {
  const kind = stampDef(name)?.kind;
  return kind === "icon" || kind === "keycap";
}

/** Common keys, offered as ready-labelled keycaps in the picker. */
export const KEYCAP_PRESETS = ["Ctrl", "Shift", "Alt", "⌘", "⌥", "Enter", "Esc", "Tab", "Space", "←", "→", "↑", "↓"];

/** The longest keycap label kept. */
export const MAX_KEYCAP_LABEL = 40;

/**
 * What the Stamp tool places: a stamp's name, and for a keycap preset its
 * label. A keycap without a label asks for one when it is placed.
 */
export interface StampPick {
  name: string;
  label?: string;
}

/** The stamp picked when nothing else has been. */
export const DEFAULT_STAMP = "check";

/** A pick as one string, as the picker and the editor preferences hold it: the name, or `keycap:<label>`. */
export function pickId(pick: StampPick): string {
  return pick.name === KEYCAP.name && pick.label ? `${KEYCAP.name}:${pick.label}` : pick.name;
}

/** The pick a `pickId` string stands for, or null when it names no bundled stamp. */
export function stampPick(id: unknown): StampPick | null {
  if (typeof id !== "string") return null;
  const prefix = `${KEYCAP.name}:`;
  if (id.startsWith(prefix)) {
    const label = id.slice(prefix.length);
    return label.trim() && label.length <= MAX_KEYCAP_LABEL ? { name: KEYCAP.name, label } : null;
  }
  return isStampName(id) ? { name: id } : null;
}

/** The picker's sections, each a list of pick ids. */
export const PICKER_SECTIONS: { label: string; ids: string[] }[] = [
  { label: "Icons", ids: ICONS.map((stamp) => stamp.name) },
  { label: "Pointers", ids: CURSORS.map((stamp) => stamp.name) },
  { label: "Keys", ids: [KEYCAP.name, ...KEYCAP_PRESETS.map((label) => pickId({ name: KEYCAP.name, label }))] },
  { label: "Emoji", ids: EMOJI.map((stamp) => stamp.name) },
];

/** A keycap's label size, padding and face, as parts of its height. */
export const KEYCAP_FONT = 0.45;
const KEYCAP_PADDING = 0.3;

/** A keycap's width over height: square for a short label, wider for a long one. */
export function keycapRatio(label: string | undefined): number {
  const text = label ?? "";
  if (!text) return 1;
  // Text width grows with the font size, so the ratio is the same at any size.
  const width = (textSize(text, 100).width / 100) * KEYCAP_FONT + KEYCAP_PADDING * 2;
  return Math.max(1, width);
}

/** The box a stamp covers, in capture pixels, before it is rotated: `size` is its longer side. */
export function stampBox(shape: { name: string; size: number; label?: string }): { width: number; height: number } {
  const def = stampDef(shape.name);
  const ratio = def?.kind === "keycap" ? keycapRatio(shape.label) : (def?.ratio ?? 1);
  return ratio >= 1 ? { width: shape.size, height: shape.size / ratio } : { width: shape.size * ratio, height: shape.size };
}

/** Names a picker entry: a stamp's label, "Ctrl key" for a keycap preset, "Blank key" for the keycap you type. */
export function pickLabel(id: string): string {
  const pick = stampPick(id);
  const def = pick ? stampDef(pick.name) : undefined;
  if (!pick || !def) return id;
  if (def.kind === "keycap") return pick.label ? `${pick.label} key` : "Blank key";
  return def.kind === "emoji" ? `${def.label} emoji` : def.label;
}
