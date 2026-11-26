/**
 * Captions: timed cues made from a recording's transcript, which users
 * retime and correct. Cues keep their recording's time, like zooms, and
 * show in every clip that plays their time, so a duplicated clip shows its
 * captions in each copy. Editing a cue never changes the transcript.
 *
 * `paintCue` draws a cue as the preview shows it and as the export burns
 * it in: the export sends each painted cue as a PNG overlay.
 */
import { clipLength, clipStarts, isGap, type Clip } from "./clips";

export type CaptionLook = "box" | "outline" | "plain";
export type CaptionSize = "small" | "medium" | "large";
export type CaptionPosition = "bottom" | "top";

export interface CaptionStyle {
  look: CaptionLook;
  size: CaptionSize;
  position: CaptionPosition;
}

export interface Cue {
  id: string;
  /** The recordings-folder reference of the cue's recording; absent for the sidecar's own. */
  source?: string;
  /** In the source recording's time. */
  startMs: number;
  endMs: number;
  text: string;
}

/** The sidecar's `captions`. */
export interface Captions {
  /** Whether the MP4 export burns the cues in. */
  burnIn: boolean;
  cues: Cue[];
  /** Absent: Box, Medium, Bottom. */
  style?: CaptionStyle;
}

/** A transcript sidecar, `<recording>.transcript.json`. Mirrors `Transcript` in src-tauri/src/transcribe.rs. */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
}
export interface Transcript {
  version: number;
  model: string;
  /** None when nothing was heard. */
  language: string | null;
  segments: TranscriptSegment[];
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = { look: "box", size: "medium", position: "bottom" };
/** The longest a cue's line may be, in characters. */
export const MAX_LINE_CHARS = 42;
export const MAX_CUE_LINES = 2;
/** The longest a cue made from a transcript lasts. */
export const MAX_CUE_MS = 6000;
export const MIN_CUE_MS = 300;
export const DEFAULT_CUE_MS = 2000;

const LOOKS: CaptionLook[] = ["box", "outline", "plain"];
const SIZES: CaptionSize[] = ["small", "medium", "large"];
const POSITIONS: CaptionPosition[] = ["bottom", "top"];

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

let nextCueId = 0;
export function newCueId(): string {
  nextCueId += 1;
  return `c${Date.now().toString(36)}${nextCueId.toString(36)}`;
}

export const emptyCaptions = (): Captions => ({ burnIn: true, cues: [] });

export const styleOf = (captions: Captions | undefined): CaptionStyle => captions?.style ?? DEFAULT_CAPTION_STYLE;

function parseStyle(value: unknown): CaptionStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const style = value as Record<string, unknown>;
  const pick = <T extends string>(list: T[], at: unknown, fallback: T): T => (list.includes(at as T) ? (at as T) : fallback);
  return {
    look: pick(LOOKS, style.look, DEFAULT_CAPTION_STYLE.look),
    size: pick(SIZES, style.size, DEFAULT_CAPTION_STYLE.size),
    position: pick(POSITIONS, style.position, DEFAULT_CAPTION_STYLE.position),
  };
}

/**
 * Reads the sidecar's `captions`; undefined when absent. Cues that are not
 * understood are dropped, the rest sorted by source and start.
 */
export function parseCaptions(value: unknown): Captions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  const cues: Cue[] = [];
  for (const entry of Array.isArray(doc.cues) ? doc.cues : []) {
    if (!entry || typeof entry !== "object") continue;
    const cue = entry as Record<string, unknown>;
    if (!isNum(cue.startMs) || !isNum(cue.endMs) || typeof cue.text !== "string" || cue.startMs < 0 || cue.endMs <= cue.startMs) continue;
    cues.push({
      id: typeof cue.id === "string" && cue.id ? cue.id : newCueId(),
      ...(typeof cue.source === "string" && cue.source ? { source: cue.source } : {}),
      startMs: Math.round(cue.startMs),
      endMs: Math.round(cue.endMs),
      text: cue.text,
    });
  }
  const style = parseStyle(doc.style);
  return { burnIn: doc.burnIn !== false, cues: sortCues(cues), ...(style ? { style } : {}) };
}

export const sortCues = (cues: Cue[]) => [...cues].sort((a, b) => a.startMs - b.startMs || (a.source ?? "").localeCompare(b.source ?? ""));

/** The JSON written to the sidecar; undefined when there is nothing to keep. */
export function serializeCaptions(captions: Captions | undefined): Captions | undefined {
  if (!captions || (captions.cues.length === 0 && captions.burnIn && !captions.style)) return undefined;
  return {
    burnIn: captions.burnIn,
    cues: captions.cues.map((cue) => ({
      id: cue.id,
      ...(cue.source ? { source: cue.source } : {}),
      startMs: Math.round(cue.startMs),
      endMs: Math.round(cue.endMs),
      text: cue.text,
    })),
    ...(captions.style ? { style: { ...captions.style } } : {}),
  };
}

// --- From a transcript ---------------------------------------------------------

/**
 * `text` broken at spaces into at most `maxLines` lines of `maxChars`; null
 * when it does not fit. A word longer than a line, such as text in a script
 * written without spaces, is broken between characters.
 */
export function wrapLines(text: string, maxChars = MAX_LINE_CHARS, maxLines = MAX_CUE_LINES): string[] | null {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean).flatMap((each) => chunks(each, maxChars))) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Array.from(last).length + 1 + Array.from(word).length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length <= maxLines ? lines : null;
}

/** `word` cut into pieces of at most `size` characters. */
function chunks(word: string, size: number): string[] {
  const chars = Array.from(word);
  if (chars.length <= size) return [word];
  const pieces: string[] = [];
  for (let at = 0; at < chars.length; at += size) pieces.push(chars.slice(at, at + size).join(""));
  return pieces;
}

/** Lines to paint: wrapped at `MAX_LINE_CHARS`, however many there are, and kept line breaks. */
export function cueLines(text: string): string[] {
  return text
    .split("\n")
    .flatMap((part) => wrapLines(part, MAX_LINE_CHARS, Number.POSITIVE_INFINITY) ?? [])
    .filter((line) => line.length > 0);
}

/**
 * The cues for a transcript: each segment split at word times so a cue
 * holds at most two 42-character lines and lasts at most 6 s. A segment
 * without words splits evenly by its text. Each cue is tagged with
 * `source`, untagged when that is the sidecar's own recording.
 */
export function cuesFromTranscript(transcript: Transcript, source: string, own: string, makeId: () => string = newCueId): Cue[] {
  const tag = source === own ? {} : { source };
  const cues: Cue[] = [];
  for (const segment of transcript.segments) {
    const words: Piece[] = (segment.words.length > 0 ? segment.words : spreadWords(segment)).flatMap(piecesOf);
    let group: Piece[] = [];
    const flush = () => {
      const text = joinPieces(group);
      if (text) {
        const startMs = Math.max(segment.startMs, group[0].startMs);
        const endMs = Math.max(startMs + 1, Math.min(segment.endMs, group[group.length - 1].endMs));
        cues.push({ id: makeId(), ...tag, startMs: Math.round(startMs), endMs: Math.round(endMs), text });
      }
      group = [];
    };
    for (const word of words) {
      if (group.length > 0) {
        const text = joinPieces([...group, word]);
        if (wrapLines(text) === null || word.endMs - group[0].startMs > MAX_CUE_MS) flush();
      }
      group.push(word);
    }
    if (group.length > 0) flush();
  }
  return sortCues(cues);
}

/** A word, or one character of a word written without spaces; `glued` ones follow the one before with no space. */
interface Piece extends TranscriptWord {
  glued: boolean;
}

/** Scripts written without spaces between words: Thai, Lao, Myanmar, Khmer, Japanese kana and CJK ideographs. */
const UNSPACED = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/u;

/**
 * `word` as pieces cues can split between: itself, or, for text written
 * without spaces or longer than a line, each of its characters, its time
 * spread evenly over them.
 */
function piecesOf(word: TranscriptWord): Piece[] {
  const text = word.text.trim();
  const chars = Array.from(text);
  if (!UNSPACED.test(text) && chars.length <= MAX_LINE_CHARS) return [{ ...word, text, glued: false }];
  const step = (word.endMs - word.startMs) / Math.max(1, chars.length);
  return chars.map((char, index) => ({
    text: char,
    startMs: word.startMs + step * index,
    endMs: word.startMs + step * (index + 1),
    glued: index > 0,
  }));
}

/**
 * The text of `pieces`, spaced between words but not inside one, nor
 * between words of a script written without spaces: the transcript's
 * words are trimmed, so two such words meeting are joined as written.
 */
const joinPieces = (pieces: Piece[]) =>
  pieces
    .filter((piece) => piece.text)
    .reduce((text, piece) => (text === "" ? piece.text : piece.glued || runsOn(text, piece.text) ? text + piece.text : `${text} ${piece.text}`), "");

/** Whether `next` follows `text` with no space: both meet in a script written without spaces. */
const runsOn = (text: string, next: string) => {
  const chars = Array.from(text);
  return UNSPACED.test(chars[chars.length - 1] ?? "") && UNSPACED.test(Array.from(next)[0] ?? "");
};

/** A segment's words spread evenly over it, for a segment without word times. */
function spreadWords(segment: TranscriptSegment): TranscriptWord[] {
  const texts = segment.text.split(/\s+/).filter(Boolean);
  const step = (segment.endMs - segment.startMs) / Math.max(1, texts.length);
  return texts.map((text, index) => ({ text, startMs: segment.startMs + index * step, endMs: segment.startMs + (index + 1) * step }));
}

// --- On the sequence ---------------------------------------------------------

/** One showing of a cue: in clip `index`, at sequence time `startMs`..`endMs`. */
export interface CueShowing {
  cue: Cue;
  index: number;
  /** A key unique on the row: the cue and the clip. */
  key: string;
  startMs: number;
  endMs: number;
}

export const cueOnSource = (cue: Cue, source: string, own: string) => (cue.source ?? own) === source;

/**
 * Where each cue shows on the sequence: in every clip playing its time,
 * clipped to the clip. Without a joined sequence (`joined` false), each
 * cue on `own` shows at its own time.
 */
export function cueShowings(cues: Cue[], clips: Clip[], own: string, joined: boolean): CueShowing[] {
  if (!joined) {
    return cues.filter((cue) => cueOnSource(cue, own, own)).map((cue) => ({ cue, index: 0, key: cue.id, startMs: cue.startMs, endMs: cue.endMs }));
  }
  const starts = clipStarts(clips);
  const shown: CueShowing[] = [];
  clips.forEach((clip, index) => {
    if (isGap(clip)) return;
    for (const cue of cues) {
      if (!cueOnSource(cue, clip.source, own) || cue.endMs <= clip.startMs || cue.startMs >= clip.endMs) continue;
      const offset = starts[index] - clip.startMs;
      shown.push({
        cue,
        index,
        key: `${cue.id}@${clip.id}`,
        startMs: Math.max(starts[index], cue.startMs + offset),
        endMs: Math.min(starts[index] + clipLength(clip), cue.endMs + offset),
      });
    }
  });
  return shown.sort((a, b) => a.startMs - b.startMs);
}

/** The showing at sequence time `ms`, if any. */
export const showingAt = (showings: CueShowing[], ms: number) => showings.find((each) => ms >= each.startMs && ms < each.endMs) ?? null;

/** `cue` tagged with `source`, untagged when that is the sidecar's own recording. */
export function tagCue(cue: Cue, source: string, own: string): Cue {
  const rest = { ...cue };
  delete rest.source;
  return source === own ? rest : { ...rest, source };
}

/** Replaces cue `cue.id`, keeping the list sorted. */
export const replaceCue = (cues: Cue[], cue: Cue) => sortCues(cues.map((each) => (each.id === cue.id ? cue : each)));

export const removeCue = (cues: Cue[], id: string) => cues.filter((cue) => cue.id !== id);

/** `cue` moved to start at `startMs` (source time), keeping its length, inside `low`..`high`. */
export function moveCueWithin(cue: Cue, startMs: number, low: number, high: number): Cue {
  const length = cue.endMs - cue.startMs;
  const start = Math.round(clamp(startMs, low, Math.max(low, high - length)));
  return { ...cue, startMs: start, endMs: start + length };
}

/** One edge of `cue` moved to `ms`, keeping it `MIN_CUE_MS` long and inside `low`..`high`. */
export function resizeCueWithin(cue: Cue, edge: "start" | "end", ms: number, low: number, high: number): Cue {
  return edge === "start"
    ? { ...cue, startMs: Math.round(clamp(ms, low, cue.endMs - MIN_CUE_MS)) }
    : { ...cue, endMs: Math.round(clamp(ms, cue.startMs + MIN_CUE_MS, high)) };
}

// --- Painting ---------------------------------------------------------------

/** The text height for each size, as a share of the video's height. */
const SIZE_SHARE: Record<CaptionSize, number> = { small: 0.04, medium: 0.055, large: 0.075 };
/** Space between the cue and the video's edge, as a share of its height. */
const MARGIN_SHARE = 0.05;

export interface CueBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something that measures text, as a canvas does. */
interface Measure {
  measureText(text: string): { width: number };
  font: string;
}

/** The font for a cue on a video `videoHeight` tall. */
export const cueFont = (style: CaptionStyle, videoHeight: number) => `600 ${Math.max(8, Math.round(videoHeight * SIZE_SHARE[style.size]))}px system-ui, -apple-system, "Segoe UI", sans-serif`;

/**
 * Where a cue sits on a video `width` by `height`: centred, at the bottom
 * or top, with its lines and padding. Whole pixels, inside the video.
 */
export function cueBox(lines: string[], style: CaptionStyle, width: number, height: number, measure: Measure): CueBox & { fontPx: number; padding: number; lineHeight: number } {
  const fontPx = Math.max(8, Math.round(height * SIZE_SHARE[style.size]));
  measure.font = cueFont(style, height);
  const padding = Math.round(fontPx * 0.4);
  const lineHeight = Math.round(fontPx * 1.25);
  const textWidth = Math.max(0, ...lines.map((line) => Number(measure.measureText(line).width) || 0));
  const boxWidth = Math.min(width, Math.ceil(textWidth + padding * 2));
  const boxHeight = Math.min(height, lineHeight * lines.length + padding * 2);
  const margin = Math.round(height * MARGIN_SHARE);
  const x = Math.max(0, Math.round((width - boxWidth) / 2));
  const y = style.position === "top" ? Math.min(margin, height - boxHeight) : Math.max(0, height - margin - boxHeight);
  return { x, y, width: Math.max(1, boxWidth), height: Math.max(1, boxHeight), fontPx, padding, lineHeight };
}

/**
 * Paints `text` onto a canvas the size of its box and returns where that
 * box sits on a video `width` by `height`. Null for empty text.
 */
export function paintCue(text: string, style: CaptionStyle, width: number, height: number, canvas: HTMLCanvasElement): CueBox | null {
  const lines = cueLines(text);
  const ctx = canvas.getContext("2d");
  if (lines.length === 0 || !ctx) return null;
  const box = cueBox(lines, style, width, height, ctx);
  canvas.width = box.width;
  canvas.height = box.height;
  ctx.clearRect(0, 0, box.width, box.height);
  if (style.look === "box") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
    ctx.fillRect(0, 0, box.width, box.height);
  }
  ctx.font = cueFont(style, height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  lines.forEach((line, row) => {
    const y = box.padding + box.lineHeight * row + box.lineHeight / 2;
    if (style.look === "outline") {
      ctx.lineWidth = Math.max(2, box.fontPx / 6);
      ctx.strokeStyle = "#000";
      ctx.strokeText(line, box.width / 2, y);
    }
    if (style.look === "plain") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
      ctx.shadowBlur = Math.max(2, box.fontPx / 8);
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(line, box.width / 2, y);
    ctx.shadowBlur = 0;
  });
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** How the caption row names a cue. */
export const cueLabel = (cue: Cue) => (cue.text.trim() ? cue.text.trim() : "Empty caption");

/** A cue painted as a PNG and where it sits on a video `width` by `height`; null for empty text or no canvas. */
export async function cuePng(text: string, style: CaptionStyle, width: number, height: number): Promise<{ box: CueBox; png: Uint8Array } | null> {
  const canvas = document.createElement("canvas");
  const box = paintCue(text, style, width, height, canvas);
  if (!box) return null;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not draw a caption");
  return { box, png: new Uint8Array(await blob.arrayBuffer()) };
}
