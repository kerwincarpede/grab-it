import type { ReactNode } from "react";
import {
  ColourIcon,
  PhotoIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  ScrollIcon,
  TextIcon,
  WindowIcon,
} from "../app/icons";
import type { CaptureKind } from "../app/api";

/**
 * Capture & record's modes, in the order of their number keys. Screen
 * captures as soon as it is picked; the others say what the next selection
 * is for.
 */
export type Tool = "region" | "window" | "screen" | "text" | "color" | "record" | "scroll";

export interface ToolInfo {
  tool: Tool;
  label: string;
  icon: ReactNode;
  /** Its own global shortcut's capture kind, if it has one. */
  hotkey?: CaptureKind;
  /** One line on what it does, for its tooltip. */
  use: string;
}

/** What to capture (keys 1 to 3), then the tools (4 to 7). */
export const TARGETS: ToolInfo[] = [
  { tool: "region", label: "Region", icon: <RegionIcon />, hotkey: "region", use: "Drag an area, or click a window." },
  { tool: "window", label: "Window", icon: <WindowIcon />, hotkey: "window", use: "Click a window, or press Enter for the one under the pointer." },
  { tool: "screen", label: "Screen", icon: <ScreenIcon />, hotkey: "screen", use: "Captures every monitor at once." },
];
export const TOOL_ITEMS: ToolInfo[] = [
  { tool: "text", label: "Text", icon: <TextIcon />, hotkey: "text", use: "Drag over text or a code to copy it." },
  { tool: "color", label: "Colour", icon: <ColourIcon />, hotkey: "colour", use: "Click a pixel, or press Enter, to copy its colour." },
  { tool: "record", label: "Record", icon: <RecordIcon />, hotkey: "record", use: "Choose what to record, then start a recording." },
  { tool: "scroll", label: "Scroll", icon: <ScrollIcon />, use: "Choose an area or window and stitch it as it scrolls." },
];
export const TOOLS: ToolInfo[] = [...TARGETS, ...TOOL_ITEMS];

/**
 * The toolbar's five modes, in the order shown. Capture's targets are
 * Region, Window and Screen; Record picks among the same three.
 */
export type Mode = "capture" | "record" | "text" | "color" | "scroll";

export interface ModeInfo {
  mode: Mode;
  label: string;
  icon: ReactNode;
  hotkey?: CaptureKind;
  use: string;
}

const toolInfo = (tool: Tool) => TOOL_ITEMS.find((each) => each.tool === tool) as ToolInfo;

export const MODES: ModeInfo[] = [
  { mode: "capture", label: "Capture", icon: <PhotoIcon />, hotkey: "region", use: "Captures a region, a window or the screen." },
  ...(["record", "text", "color", "scroll"] as const).map((mode) => {
    const { label, icon, hotkey, use } = toolInfo(mode);
    return { mode, label, icon, hotkey, use };
  }),
];

/** The mode a tool belongs to: Region, Window and Screen are Capture's. */
export function modeOf(tool: Tool): Mode {
  return tool === "region" || tool === "window" || tool === "screen" ? "capture" : tool;
}

/** The Timer's settings in seconds, in the order a click steps through them. */
export const TIMER_STEPS = [0, 3, 5, 10];
/** The Timer's number key, after the modes'. */
export const TIMER_KEY = TOOLS.length + 1;

/** Capture & record's aspect ratio presets: width over height, or none. */
export type RatioId = "free" | "16:9" | "4:3" | "1:1";
export const RATIOS: { id: RatioId; label: string; value: number | null }[] = [
  { id: "free", label: "Free", value: null },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "1:1", label: "1:1", value: 1 },
];

/**
 * How much room the toolbar has: all labels (`wide`), unselected modes as
 * icon and key (`compact`), the ratios in one menu as well (`folded`), and
 * the middle section on a second row, with the actions wrapping too when
 * even one row of modes and actions is too wide (`stacked`).
 *
 * The widths are what one row needs with a region held, from the sizes in
 * overlay.css, plus the 32 px the toolbar keeps from the screen's edges:
 * about 1380 px with every label, 1110 px with modes as icons, 1050 px
 * with the ratios folded. Without a held region the row is narrower, so
 * these err towards the smaller layout.
 */
export type ToolbarLayout = "wide" | "compact" | "folded" | "stacked";

export function toolbarLayout(width: number): ToolbarLayout {
  if (width < 1080) return "stacked";
  if (width < 1180) return "folded";
  if (width < 1440) return "compact";
  return "wide";
}
