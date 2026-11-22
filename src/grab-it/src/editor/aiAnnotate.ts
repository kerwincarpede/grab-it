/**
 * Annotate with AI: asks the provider chosen in Settings → AI integration
 * for boxes, arrows and labels as the user describes them
 * (`editor_annotate` in src-tauri/src/annotate.rs), and turns its
 * suggestions into ordinary shapes. Suggestions are only previewed until
 * applied; applying adds them all in one undo step, and the sidecar saves
 * them like any other edit.
 */
import { commands } from "../app/bindings";
import { rectsThroughCuts, shiftValue } from "./cut";
import type { Annotations, Cut, LineShape, Point, Rect, Shape, Style, TextShape } from "./model";
import { newId, textLook, textLookFields } from "./tools";

/** What `editor_annotate` answers: `AnnotateOutcome` in src-tauri/src/annotate.rs. */
export type AnnotateOutcome = Awaited<ReturnType<typeof commands.editorAnnotate>>;
/** One suggestion, in the original capture's pixels: `Suggestion` in src-tauri/src/annotate.rs. */
export type AiSuggestion = Extract<AnnotateOutcome, { state: "suggested" }>["suggestions"][number];

/** Asks for suggestions for the editor's capture; rejects with the provider's error. */
export function requestAnnotations(instruction: string): Promise<AnnotateOutcome> {
  return commands.editorAnnotate(instruction);
}

type Size = { width: number; height: number };

/** About how wide a character of label text is, per pixel of font size. */
const CHAR_WIDTH = 0.6;
/** About how tall a label is, per pixel of font size. */
const LINE_HEIGHT = 1.3;

/** A point on the original capture in the pixels of the joined image, through every cut in order. */
export function pointThroughCuts(point: Point, cuts: Cut[] | undefined): Point {
  return (cuts ?? []).reduce(
    (at, cut) => (cut.axis === "x" ? { ...at, x: shiftValue(at.x, cut) } : { ...at, y: shiftValue(at.y, cut) }),
    point,
  );
}

/** Where a label of `text` at `at` fits inside `bounds`, by its estimated size; at `at` when it cannot fit. */
export function fitLabel(at: Point, text: string, fontSize: number, bounds: Size | null): Point {
  if (!bounds) return at;
  const width = Math.max(...text.split("\n").map((line) => line.length)) * fontSize * CHAR_WIDTH;
  const height = text.split("\n").length * fontSize * LINE_HEIGHT;
  const x = Math.max(0, Math.min(at.x, bounds.width - width));
  const y = Math.max(0, Math.min(at.y, bounds.height - height));
  return { x: Math.round(x), y: Math.round(y) };
}

/** The styles each kind of suggestion is drawn with: what the Rectangle, Arrow and Text tools would use now. */
export interface SuggestionStyles {
  rect: Style;
  arrow: Style;
  text: Style;
}

/** A suggestion on preview, by the id its shape keeps while it is previewed and once applied. */
export interface PendingSuggestion {
  id: string;
  suggestion: AiSuggestion;
}

/** Gives each suggestion the id its shape keeps. */
export function pendingSuggestions(suggestions: AiSuggestion[]): PendingSuggestion[] {
  return suggestions.map((suggestion) => ({ id: newId(), suggestion }));
}

/**
 * The suggestions, kept in the original capture's pixels, as shapes on the
 * joined image through the capture's cuts as they are now, drawn with the
 * current tool styles. A box or arrow a cut took away is dropped while
 * that cut is there. `bounds` is the joined image's size, which labels are
 * kept inside.
 */
export function suggestionShapes(pending: PendingSuggestion[], styles: SuggestionStyles, cuts: Cut[] | undefined, bounds: Size | null): Shape[] {
  return pending.flatMap(({ id, suggestion }): Shape[] => {
    // The bindings let a number be null (Rust's NaN); such a suggestion is dropped.
    if (!finite(suggestion)) return [];
    switch (suggestion.kind) {
      case "rect": {
        const [rect] = rectsThroughCuts([rectOf(suggestion)], cuts);
        if (!rect) return [];
        const { color, strokeWidth, fill } = styles.rect;
        return [{ id, type: "rect", color, strokeWidth, ...rect, ...(fill ? { fill: true } : {}) }];
      }
      case "arrow": {
        const from = pointThroughCuts({ x: suggestion.x1, y: suggestion.y1 }, cuts);
        const to = pointThroughCuts({ x: suggestion.x2, y: suggestion.y2 }, cuts);
        if (Math.hypot(to.x - from.x, to.y - from.y) < 3) return [];
        const { color, strokeWidth, arrowStyle } = styles.arrow;
        const arrow: LineShape = {
          id,
          type: "arrow",
          color,
          strokeWidth,
          points: [from.x, from.y, to.x, to.y].map(Math.round),
          ...(arrowStyle && arrowStyle !== "classic" ? { arrowStyle } : {}),
        };
        return [arrow];
      }
      case "text": {
        const fontSize = styles.text.fontSize ?? 30;
        const at = fitLabel(pointThroughCuts({ x: suggestion.x, y: suggestion.y }, cuts), suggestion.text, fontSize, bounds);
        const text: TextShape = {
          id,
          type: "text",
          color: styles.text.color,
          x: at.x,
          y: at.y,
          text: suggestion.text,
          fontSize,
          ...textLookFields(textLook(styles.text)),
        };
        return [text];
      }
    }
  });
}

type Finite<T> = { [K in keyof T]: Exclude<T[K], null> };

/** Whether every coordinate of `suggestion` is a finite number. */
function finite(suggestion: AiSuggestion): suggestion is Finite<AiSuggestion> {
  return Object.values(suggestion).every((value) => typeof value !== "number" ? value !== null : Number.isFinite(value));
}

function rectOf(suggestion: Rect): Rect {
  return {
    x: Math.round(suggestion.x),
    y: Math.round(suggestion.y),
    width: Math.round(suggestion.width),
    height: Math.round(suggestion.height),
  };
}

/** `doc` with `shapes` added on top: one commit, so one undo step. */
export function applySuggestions(doc: Annotations, shapes: Shape[]): Annotations {
  return shapes.length === 0 ? doc : { ...doc, shapes: [...doc.shapes, ...shapes] };
}

/** What the panel says once suggestions came back. */
export function suggestedMessage(count: number, skipped: number, by: string): string {
  const found = count === 0 ? `${by} suggested nothing to add.` : `${by} suggested ${count} ${count === 1 ? "shape" : "shapes"}.`;
  if (skipped === 0) return found;
  return `${found} ${skipped} more could not be placed, so ${skipped === 1 ? "it was" : "they were"} left out.`;
}
