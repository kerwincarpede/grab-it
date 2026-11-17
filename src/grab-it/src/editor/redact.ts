/**
 * Finds private details in a capture's text, for Blur private details and
 * the Blur tool's word click. Works on the word boxes text recognition
 * reads (`OcrLine`), in capture pixels, so each match maps straight to a
 * `BlurShape` rect. Everything runs locally.
 */
import type { OcrLine } from "../library/api";
import { DEFAULT_PIXEL_SIZE, newId } from "./tools";
import type { BlurShape, Point, Rect, Style } from "./model";

/** The kinds of private detail Blur private details finds in text. */
export type DetailKind = "email" | "phone" | "card" | "address";

/** A word of the capture's text, where it sits in `TextIndex.text`. */
interface IndexedWord {
  line: number;
  start: number;
  end: number;
  rect: Rect;
}

/**
 * The capture's words joined into one string, a space between the words of
 * a line and a newline between lines, so patterns can run over it and map
 * back to boxes.
 */
interface TextIndex {
  text: string;
  words: IndexedWord[];
}

function indexText(lines: OcrLine[]): TextIndex {
  let text = "";
  const words: IndexedWord[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) text += "\n";
    line.words.forEach((word, wordIndex) => {
      if (wordIndex > 0) text += " ";
      const start = text.length;
      text += word.text;
      words.push({ line: lineIndex, start, end: text.length, rect: rectOf(word) });
    });
  });
  return { text, words };
}

function rectOf({ x, y, width, height }: Rect): Rect {
  return { x, y, width, height };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** One rect per line for the words overlapping text `[start, end)`: their union there. */
function rectsForSpan(index: TextIndex, start: number, end: number): Rect[] {
  const byLine = new Map<number, Rect>();
  for (const word of index.words) {
    if (word.start >= end || word.end <= start) continue;
    const seen = byLine.get(word.line);
    byLine.set(word.line, seen ? union(seen, word.rect) : word.rect);
  }
  return [...byLine.values()].filter((rect) => rect.width > 0 && rect.height > 0);
}

/** True when the digits of `number` pass the Luhn check card numbers carry. */
export function luhn(number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (digits.length === 0) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** 13 to 19 digits, in groups split by single spaces or dashes. */
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/**
 * International (`+44 20 7946 0958`) or local (`(555) 123-4567`,
 * `555.123.4567`) numbers; at least 7 digits are checked after matching.
 */
const PHONE = /(?<![\w+.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){1,5}(?![\w-])/g;
/** Dates and times look like phone numbers but are not private. */
const DATE_LIKE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;
/**
 * Street suffixes, capitalised or in capitals. UI words that end street
 * names too (Close, Row) are left out, so "Step 2 Click Close" is not one.
 */
const STREET_SUFFIXES = [
  "Street", "St", "Avenue", "Ave", "Road", "Rd", "Boulevard", "Blvd", "Lane", "Ln", "Drive", "Dr",
  "Court", "Ct", "Place", "Pl", "Way", "Terrace", "Ter", "Parkway", "Pkwy", "Highway", "Hwy",
  "Circle", "Cir", "Square", "Sq", "Crescent", "Cres", "Alley",
].flatMap((suffix) => [suffix, suffix.toUpperCase()]);
/** A space within a line, or one line break. */
const ADDRESS_GAP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*)`;
/** A capitalised street-name word, or an ordinal such as 5th. */
const STREET_WORD = String.raw`(?:[A-Z][\w.'-]*|\d+(?:st|nd|rd|th))`;
/**
 * A house number, one to four capitalised words of street name and a
 * capitalised suffix: `221B Baker Street`, `350 5th Avenue`. At most one
 * line break; see `findDetails`.
 */
const ADDRESS = new RegExp(
  String.raw`(?<![\w-])\d{1,6}[A-Za-z]?${ADDRESS_GAP}(?:${STREET_WORD}${ADDRESS_GAP}){1,4}(?:${STREET_SUFFIXES.join("|")})\b\.?`,
  "g",
);

/** The digits in `text`. */
function digitCount(text: string): number {
  return text.replace(/\D/g, "").length;
}

interface Span {
  kind: DetailKind;
  start: number;
  end: number;
}

function spans(text: string, pattern: RegExp, kind: DetailKind, keep: (match: string) => boolean): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || !keep(match[0])) continue;
    found.push({ kind, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** A private detail found in the capture's text, and the rects covering it. */
export interface Detail {
  kind: DetailKind;
  text: string;
  rects: Rect[];
}

/**
 * The emails, phone numbers, Luhn-checked card numbers and street addresses
 * in `lines`. A match spanning several words gets one rect per line, the
 * union of its words' boxes there. A number that is a card is not also a
 * phone number.
 */
export function findDetails(lines: OcrLine[]): Detail[] {
  const index = indexText(lines);
  const { text } = index;
  const emails = spans(text, EMAIL, "email", () => true);
  const cards = spans(text, CARD, "card", (match) => {
    const digits = digitCount(match);
    return digits >= 13 && digits <= 19 && luhn(match);
  });
  const taken = [...emails, ...cards];
  const phones = spans(text, PHONE, "phone", (match) => {
    const digits = digitCount(match);
    return digits >= 7 && digits <= 15 && !DATE_LIKE.test(match);
  }).filter((phone) => !taken.some((span) => overlaps(span, phone)));
  const addresses = spans(text, ADDRESS, "address", (match) => match.split("\n").length <= 2);
  return [...emails, ...cards, ...phones, ...addresses]
    .sort((a, b) => a.start - b.start)
    .map((span) => ({
      kind: span.kind,
      text: text.slice(span.start, span.end),
      rects: rectsForSpan(index, span.start, span.end),
    }))
    .filter((detail) => detail.rects.length > 0);
}

/** The text of a word without the punctuation OCR reads around it. */
export function bareWord(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The boxes of every word in `lines` holding `word` as a whole word,
 * ignoring case and the punctuation around it: `Pineapple,` matches
 * `pineapple`, `pineapples` does not.
 */
export function findWord(lines: OcrLine[], word: string): Rect[] {
  const bare = bareWord(word);
  if (bare === "") return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(bare)}(?![\\p{L}\\p{N}])`, "iu");
  return lines
    .flatMap((line) => line.words)
    .filter((candidate) => pattern.test(candidate.text))
    .map(rectOf)
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/** The word whose box holds `at`, or null when none does. */
export function wordAt(lines: OcrLine[], at: Point): string | null {
  for (const line of lines) {
    for (const word of line.words) {
      if (at.x >= word.x && at.x <= word.x + word.width && at.y >= word.y && at.y <= word.y + word.height) {
        return bareWord(word.text) === "" ? null : word.text;
      }
    }
  }
  return null;
}

/** How far a blur reaches past the box it covers, so letters' edges are hidden too. */
export const BLUR_PADDING = 2;

/** `rect` grown by `BLUR_PADDING` on every side, kept within `bounds` when given. */
export function padded(rect: Rect, bounds?: { width: number; height: number }): Rect {
  let x = rect.x - BLUR_PADDING;
  let y = rect.y - BLUR_PADDING;
  let right = rect.x + rect.width + BLUR_PADDING;
  let bottom = rect.y + rect.height + BLUR_PADDING;
  if (bounds) {
    x = Math.max(0, x);
    y = Math.max(0, y);
    right = Math.min(bounds.width, right);
    bottom = Math.min(bounds.height, bottom);
  }
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Ordinary Blur shapes over `rects`, as the Blur tool draws them; the same rect is covered once. */
export function blursFor(rects: Rect[], style: Style, bounds?: { width: number; height: number }): BlurShape[] {
  const seen = new Set<string>();
  const shapes: BlurShape[] = [];
  for (const rect of rects) {
    const box = padded(rect, bounds);
    const key = `${box.x},${box.y},${box.width},${box.height}`;
    if (seen.has(key) || box.width <= 0 || box.height <= 0) continue;
    seen.add(key);
    shapes.push({
      id: newId(),
      type: "blur",
      ...box,
      pixelSize: DEFAULT_PIXEL_SIZE,
      ...(style.blurMode === "blur" ? { mode: "blur" as const } : {}),
    });
  }
  return shapes;
}
