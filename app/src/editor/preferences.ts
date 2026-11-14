import type { EditorPreferences } from "../settings/api";
import { COLORS, TOOLS, widthKind, type BlurMode, type Style, type Tool, type Widths } from "./model";

/** Wait this long after the last change before saving the editor preferences. */
export const PREFERENCES_DELAY_MS = 300;

/** The choices the editor remembers between sessions. */
export interface EditorChoices {
  tool: Tool;
  /** Colour, fill, text background and blur style; widths live in `widths`. */
  style: Pick<Style, "color" | "fill" | "background" | "blurMode">;
  widths: Widths;
}

export const DEFAULT_CHOICES: EditorChoices = { tool: "arrow", style: { color: COLORS[0] }, widths: {} };

/** The largest width kept from the settings file; anything bigger is a mistake. */
const MAX_STORED_WIDTH = 200;

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/**
 * The stored preferences as editor choices. Each value is checked on its
 * own: anything missing or not understood (a tool from a newer version, a
 * width of zero) keeps today's default. Crop is never restored, since it
 * hides the backdrop of a capture that was just opened.
 */
export function fromPreferences(stored: EditorPreferences | null | undefined): EditorChoices {
  const prefs = stored ?? {};
  const tool = TOOLS.find((entry) => entry.tool === prefs.tool && entry.tool !== "crop")?.tool ?? DEFAULT_CHOICES.tool;
  const style: EditorChoices["style"] = { color: isHex(prefs.color) ? prefs.color.toLowerCase() : DEFAULT_CHOICES.style.color };
  if (prefs.fill === true) style.fill = true;
  if (prefs.textBackground === true) style.background = true;
  if (prefs.blurMode === "blur" || prefs.blurMode === "pixelate") style.blurMode = prefs.blurMode as BlurMode;
  const widths: Widths = {};
  for (const [name, width] of Object.entries(prefs.widths ?? {})) {
    const entry = TOOLS.find((candidate) => candidate.tool === name);
    if (!entry || !widthKind(entry.tool)) continue;
    if (typeof width !== "number" || !Number.isFinite(width) || width < 1 || width > MAX_STORED_WIDTH) continue;
    widths[entry.tool] = Math.round(width);
  }
  return { tool, style, widths };
}

/** The editor choices as they are stored; options that are off are left out. */
export function toPreferences(choices: EditorChoices): EditorPreferences {
  const widths: Record<string, number> = {};
  for (const [tool, width] of Object.entries(choices.widths)) {
    if (typeof width === "number") widths[tool] = Math.round(width);
  }
  return {
    color: choices.style.color,
    tool: choices.tool,
    widths,
    fill: Boolean(choices.style.fill),
    textBackground: Boolean(choices.style.background),
    blurMode: choices.style.blurMode ?? "pixelate",
  };
}
