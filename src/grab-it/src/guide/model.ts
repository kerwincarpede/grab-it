import type { Annotations, Shape } from "../editor/model";
import { parseAnnotations } from "../editor/sidecar";

/** One step as the Guide window holds it. */
export interface GuideStep {
  /** The capture's path from the save folder. */
  capture: string;
  description: string;
  /** The capture's annotations; empty when it has none or they cannot be read. */
  annotations: Annotations;
  /** False when the capture's file is gone. */
  exists: boolean;
}

/** The export formats, in the order the menu lists them. */
export const EXPORT_FORMATS = [
  { format: "markdown", label: "Markdown", extension: "md" },
  { format: "html", label: "HTML", extension: "html" },
  { format: "docx", label: "Word document", extension: "docx" },
  { format: "pptx", label: "PowerPoint deck", extension: "pptx" },
] as const;

export type GuideFormat = (typeof EXPORT_FORMATS)[number]["format"];

/** Reads a sidecar sent by `guide_info`, falling back to an empty one. */
export function readAnnotations(value: unknown): Annotations {
  try {
    return parseAnnotations(value);
  } catch {
    return parseAnnotations(null);
  }
}

/** `steps` with the step at `from` moved to `to`. Out of range leaves it as is. */
export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  const next = [...steps];
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** `steps` without the one at `index`. Its capture stays in the Library. */
export function removeStep<T>(steps: readonly T[], index: number): T[] {
  return steps.filter((_, at) => at !== index);
}

/**
 * The annotations with each guide badge (a step shape with a number)
 * numbered `number`, as saving writes them, so thumbnails match at once.
 */
export function numbered(annotations: Annotations, number: number): Annotations {
  let changed = false;
  const shapes = annotations.shapes.map((shape): Shape => {
    if (shape.type !== "step" || shape.number === undefined || shape.number === number) return shape;
    changed = true;
    return { ...shape, number };
  });
  return changed ? { ...annotations, shapes } : annotations;
}

/** What `guide_save` writes: each step's capture and description, in order. */
export function savedSteps(steps: readonly GuideStep[]): { capture: string; description: string }[] {
  return steps.map(({ capture, description }) => ({ capture, description: description.trim() }));
}

/**
 * Takes in descriptions that arrived (from the AI) while the window was
 * open: a step the user has edited keeps their text.
 */
export function mergeDescriptions(
  steps: readonly GuideStep[],
  arrived: readonly { capture: string; description: string }[],
  edited: ReadonlySet<string>,
): GuideStep[] {
  const latest = new Map(arrived.map((step) => [step.capture, step.description]));
  return steps.map((step) => {
    const description = latest.get(step.capture);
    return description === undefined || edited.has(step.capture) || description === step.description ? step : { ...step, description };
  });
}

/** Base64 for a step's flattened PNG, as the export commands take it. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** The file name an export offers: the guide's title with the format's extension. */
export function exportName(title: string, format: GuideFormat): string {
  const extension = EXPORT_FORMATS.find((entry) => entry.format === format)?.extension ?? "md";
  return `${title || "Grab-it Guide"}.${extension}`;
}
