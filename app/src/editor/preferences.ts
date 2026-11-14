import { MAX_BACKDROP_PRESETS, type BackdropPreset, type EditorPreferences } from "../settings/api";
import { COLORS, TOOLS, widthKind, type Backdrop, type BlurMode, type Style, type Tool, type Widths } from "./model";
import { parseBackdrop } from "./sidecar";

/** Wait this long after the last change before saving the editor preferences. */
export const PREFERENCES_DELAY_MS = 300;

/** The choices the editor remembers between sessions. */
export interface EditorChoices {
  tool: Tool;
  /** Colour, fill, text background and blur style; widths live in `widths`. */
  style: Pick<Style, "color" | "fill" | "background" | "blurMode">;
  widths: Widths;
  /** The last backdrop picked: new backdrops start from it. */
  backdrop: Backdrop | null;
  /**
   * Frame captures without annotations with `backdrop`. Read only: the
   * Settings window sets it, and saving the editor's choices keeps it.
   */
  autoBackdrop?: boolean;
  /**
   * The backdrops saved by name; absent when there are none. Read only:
   * presets are saved on their own, with `setBackdropPresets`.
   */
  backdropPresets?: SavedBackdrop[];
}

/** A backdrop preset, its backdrop checked. */
export type SavedBackdrop = BackdropPreset<Backdrop>;

export const DEFAULT_CHOICES: EditorChoices = { tool: "arrow", style: { color: COLORS[0] }, widths: {}, backdrop: null };

/** The largest width kept from the settings file; anything bigger is a mistake. */
const MAX_STORED_WIDTH = 200;

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/**
 * The stored backdrop presets, each checked as a sidecar's backdrop is. A
 * preset whose id, name or backdrop is not understood is dropped on its own;
 * at most `MAX_BACKDROP_PRESETS` are kept.
 */
export function parseBackdropPresets(value: unknown): SavedBackdrop[] {
  if (!Array.isArray(value)) return [];
  const presets: SavedBackdrop[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, backdrop } = entry as Record<string, unknown>;
    const parsed = parseBackdrop(backdrop);
    if (typeof id !== "string" || typeof name !== "string" || !parsed) continue;
    presets.push({ id, name, backdrop: parsed });
  }
  return presets.slice(0, MAX_BACKDROP_PRESETS);
}

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
  const choices: EditorChoices = { tool, style, widths, backdrop: parseBackdrop(prefs.backdrop) };
  if (prefs.autoBackdrop === true) choices.autoBackdrop = true;
  const presets = parseBackdropPresets(prefs.backdropPresets);
  if (presets.length > 0) choices.backdropPresets = presets;
  return choices;
}

/** The editor choices as they are stored; options that are off are left out, and so are `autoBackdrop` and the presets. */
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
    ...(choices.backdrop ? { backdrop: choices.backdrop } : {}),
  };
}

/** "Preset N" for the next preset: one more than there are, skipping any name taken. */
export function presetName(presets: SavedBackdrop[]): string {
  const taken = new Set(presets.map((preset) => preset.name));
  let n = presets.length + 1;
  while (taken.has(`Preset ${n}`)) n += 1;
  return `Preset ${n}`;
}
