import { describe, expect, it } from "vitest";
import type { OcrLine } from "../library/api";
import { DEFAULT_STYLE } from "./model";
import { BLUR_PADDING, bareWord, blursFor, findDetails, findWord, luhn, padded, wordAt } from "./redact";

const WORD_HEIGHT = 10;
const LINE_GAP = 20;

/** Lines of text laid out left to right, each word 10px per character, 5px apart. */
function lines(...texts: string[]): OcrLine[] {
  return texts.map((text, row) => {
    const y = row * LINE_GAP;
    let x = 0;
    const words = text.split(" ").map((word) => {
      const box = { text: word, x, y, width: word.length * 10, height: WORD_HEIGHT };
      x += box.width + 5;
      return box;
    });
    const last = words[words.length - 1];
    return { text, x: 0, y, width: last.x + last.width, height: WORD_HEIGHT, words };
  });
}

describe("luhn", () => {
  it("accepts valid card numbers and rejects others", () => {
    expect(luhn("4111 1111 1111 1111")).toBe(true);
    expect(luhn("5500-0000-0000-0004")).toBe(true);
    expect(luhn("4111 1111 1111 1112")).toBe(false);
    expect(luhn("")).toBe(false);
  });
});

describe("findDetails", () => {
  it("finds an email and covers just its word", () => {
    const found = findDetails(lines("Write to jane.doe@example.com today"));
    expect(found).toEqual([
      { kind: "email", text: "jane.doe@example.com", rects: [{ x: 80, y: 0, width: 200, height: WORD_HEIGHT }] },
    ]);
  });

  it("finds international and local phone numbers of at least 7 digits", () => {
    const found = findDetails(lines("Call +44 20 7946 0958 now", "or (555) 123-4567", "desk 555.0100", "room 42"));
    expect(found.map((detail) => [detail.kind, detail.text])).toEqual([
      ["phone", "+44 20 7946 0958"],
      ["phone", "(555) 123-4567"],
      ["phone", "555.0100"],
    ]);
    // A number of several words is one rect: the union of its words.
    expect(found[0].rects).toEqual([{ x: 45, y: 0, width: 145, height: WORD_HEIGHT }]);
  });

  it("skips dates and short numbers", () => {
    expect(findDetails(lines("Saved 2026-11-17 at 09:00", "Order 12345"))).toEqual([]);
  });

  it("finds Luhn-checked card numbers with spaces or dashes as one match", () => {
    const found = findDetails(lines("Card 4111 1111 1111 1111", "Card 5500-0000-0000-0004", "Ref 4111 1111 1111 1112"));
    expect(found.map((detail) => [detail.kind, detail.text])).toEqual([
      ["card", "4111 1111 1111 1111"],
      ["card", "5500-0000-0000-0004"],
    ]);
    expect(found[0].rects).toEqual([{ x: 45, y: 0, width: 175, height: WORD_HEIGHT }]);
  });

  it("finds street addresses with a number, a name and a suffix", () => {
    const found = findDetails(lines("Ship to 221B Baker Street, London", "1600 Pennsylvania Ave NW", "the 3 little pigs"));
    expect(found.map((detail) => [detail.kind, detail.text])).toEqual([
      ["address", "221B Baker Street"],
      ["address", "1600 Pennsylvania Ave"],
    ]);
  });

  it("finds addresses with an ordinal or in capitals", () => {
    const found = findDetails(lines("Meet at 350 5th Avenue", "12 HIGH ST"));
    expect(found.map((detail) => detail.text)).toEqual(["350 5th Avenue", "12 HIGH ST"]);
  });

  it.each([
    ["Saved 2 files to Drive"],
    ["Step 2 Click Close"],
    ["You have 3 new messages in your drive"],
    ["all 4 of them went that way"],
    ["Inbox 12", "Settings", "Close"],
    ["Inbox 12", "Archive", "Shared", "Drive"],
  ])("does not take ordinary text for an address: %s", (...texts: string[]) => {
    expect(findDetails(lines(...texts))).toEqual([]);
  });

  it("gives a match across two lines one rect per line", () => {
    const found = findDetails(lines("at 10 Downing", "Street please"));
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("address");
    expect(found[0].rects).toEqual([
      { x: 25, y: 0, width: 95, height: WORD_HEIGHT },
      { x: 0, y: LINE_GAP, width: 60, height: WORD_HEIGHT },
    ]);
  });

  it("finds nothing in ordinary text", () => {
    expect(findDetails(lines("Order pineapple today"))).toEqual([]);
    expect(findDetails([])).toEqual([]);
  });
});

describe("findWord", () => {
  const text = lines("Pineapple, pineapples and PINEAPPLE", "more pineapple");

  it("matches whole words, ignoring case and surrounding punctuation", () => {
    expect(findWord(text, "pineapple")).toEqual([
      { x: 0, y: 0, width: 100, height: WORD_HEIGHT },
      { x: 245, y: 0, width: 90, height: WORD_HEIGHT },
      { x: 45, y: LINE_GAP, width: 90, height: WORD_HEIGHT },
    ]);
    expect(findWord(text, "Pineapple,")).toHaveLength(3);
  });

  it("matches nothing for punctuation alone", () => {
    expect(findWord(text, "...")).toEqual([]);
    expect(bareWord("(hello!)")).toBe("hello");
  });

  it("finds the word under a point", () => {
    expect(wordAt(text, { x: 50, y: 5 })).toBe("Pineapple,");
    expect(wordAt(text, { x: 50, y: LINE_GAP + 5 })).toBe("pineapple");
    expect(wordAt(text, { x: 1000, y: 5 })).toBeNull();
  });
});

describe("blursFor", () => {
  it("makes padded Blur shapes, one per distinct rect, kept within the capture", () => {
    const rect = { x: 0, y: 10, width: 20, height: 10 };
    const shapes = blursFor([rect, rect], { ...DEFAULT_STYLE, blurMode: "blur" }, { width: 100, height: 100 });
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({
      type: "blur",
      mode: "blur",
      x: 0,
      y: 10 - BLUR_PADDING,
      width: 20 + BLUR_PADDING,
      height: 10 + 2 * BLUR_PADDING,
    });
    expect(blursFor([rect], DEFAULT_STYLE)[0].mode).toBeUndefined();
  });

  it("pads without bounds on every side", () => {
    expect(padded({ x: 10, y: 10, width: 5, height: 5 })).toEqual({
      x: 10 - BLUR_PADDING,
      y: 10 - BLUR_PADDING,
      width: 5 + 2 * BLUR_PADDING,
      height: 5 + 2 * BLUR_PADDING,
    });
  });
});
