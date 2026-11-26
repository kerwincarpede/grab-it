import { describe, expect, it } from "vitest";
import {
  cueBox,
  cueShowings,
  cuesFromTranscript,
  DEFAULT_CAPTION_STYLE,
  MAX_CUE_MS,
  MAX_LINE_CHARS,
  moveCueWithin,
  parseCaptions,
  resizeCueWithin,
  serializeCaptions,
  showingAt,
  wrapLines,
  type Cue,
  type Transcript,
} from "./captions";
import { parseEdits, serializeEdits } from "./edits";

const ids = () => {
  let n = 0;
  return () => `c${++n}`;
};

const words = (text: string, startMs: number, stepMs: number) =>
  text.split(" ").map((word, index) => ({ text: word, startMs: startMs + index * stepMs, endMs: startMs + (index + 1) * stepMs }));

describe("captions sidecar", () => {
  it("round-trips cues as version 5 and drops ones it does not understand", () => {
    const cue: Cue = { id: "a", startMs: 100, endMs: 900, text: "Hello there" };
    const sidecar = serializeEdits({ version: 1, captions: { burnIn: true, cues: [cue] } });
    expect(sidecar).toEqual({ version: 5, captions: { burnIn: true, cues: [cue] } });
    expect(parseEdits(sidecar)).toEqual(sidecar);
    const parsed = parseCaptions({ burnIn: false, cues: [cue, { id: "b", startMs: 5, endMs: 5, text: "x" }, { id: "c", startMs: 0, endMs: 1 }] });
    expect(parsed).toEqual({ burnIn: false, cues: [cue] });
  });

  it("keeps the default look out of the sidecar and reads unknown looks as the default", () => {
    expect(serializeCaptions({ burnIn: true, cues: [] })).toBeUndefined();
    expect(serializeEdits({ version: 1, captions: { burnIn: false, cues: [] } })).toEqual({ version: 1, captions: { burnIn: false, cues: [] } });
    expect(parseCaptions({ cues: [], style: { look: "neon", size: "large", position: "top" } })?.style).toEqual({ look: "box", size: "large", position: "top" });
    expect(parseCaptions([])).toBeUndefined();
  });
});

describe("cues from a transcript", () => {
  it("splits a segment at word times into at most two 42-character lines", () => {
    const text = "this is a long sentence that keeps going on and on until it needs more than two lines of captions to show";
    const transcript: Transcript = { version: 1, model: "whisper-base", language: "en", segments: [{ startMs: 0, endMs: 5000, text, words: words(text, 0, 200) }] };
    const cues = cuesFromTranscript(transcript, "own.mp4", "own.mp4", ids());
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.source).toBeUndefined();
      expect(wrapLines(cue.text)).not.toBeNull();
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(MAX_CUE_MS);
    }
    expect(cues.map((cue) => cue.text).join(" ")).toBe(text);
    expect(cues[1].startMs).toBe(cues[0].endMs);
  });

  it("splits at 6 s and tags another recording's cues", () => {
    const transcript: Transcript = { version: 1, model: "m", language: "en", segments: [{ startMs: 0, endMs: 9000, text: "slow words here", words: words("slow words here", 0, 3000) }] };
    const cues = cuesFromTranscript(transcript, "2026-11/b.mp4", "a.mp4", ids());
    expect(cues.map((cue) => [cue.text, cue.startMs, cue.endMs, cue.source])).toEqual([
      ["slow words", 0, 6000, "2026-11/b.mp4"],
      ["here", 6000, 9000, "2026-11/b.mp4"],
    ]);
  });

  it("spreads a segment without word times", () => {
    const transcript: Transcript = { version: 1, model: "m", language: "en", segments: [{ startMs: 1000, endMs: 2000, text: " Hi all ", words: [] }] };
    expect(cuesFromTranscript(transcript, "a.mp4", "a.mp4", ids())).toEqual([{ id: "c1", startMs: 1000, endMs: 2000, text: "Hi all" }]);
  });

  it("wraps text into lines no longer than the limit", () => {
    expect(wrapLines("a ".repeat(30).trim())?.every((line) => line.length <= MAX_LINE_CHARS)).toBe(true);
    expect(wrapLines("word ".repeat(40))).toBeNull();
  });
});

describe("cues on the sequence", () => {
  const cue: Cue = { id: "q", startMs: 1000, endMs: 3000, text: "Hello" };
  const clips = [
    { id: "one", source: "a.mp4", startMs: 0, endMs: 2000 },
    { id: "gap", source: "", startMs: 0, endMs: 500, gap: true },
    { id: "two", source: "a.mp4", startMs: 1500, endMs: 4000 },
  ];

  it("shows a cue in every clip playing its time, clipped to the clip", () => {
    const shown = cueShowings([cue, { id: "r", source: "b.mp4", startMs: 0, endMs: 500, text: "Elsewhere" }], clips, "a.mp4", true);
    expect(shown.map((each) => [each.key, each.index, each.startMs, each.endMs])).toEqual([
      ["q@one", 0, 1000, 2000],
      ["q@two", 2, 2500, 4000],
    ]);
    expect(showingAt(shown, 2200)).toBeNull();
    expect(showingAt(shown, 3000)?.key).toBe("q@two");
  });

  it("shows cues at their own time without a joined sequence", () => {
    expect(cueShowings([cue], [], "a.mp4", false).map((each) => [each.startMs, each.endMs])).toEqual([[1000, 3000]]);
  });

  it("moves and resizes a cue inside its room", () => {
    expect(moveCueWithin(cue, 3500, 0, 4000)).toMatchObject({ startMs: 2000, endMs: 4000 });
    expect(resizeCueWithin(cue, "end", 1100, 0, 4000)).toMatchObject({ endMs: 1300 });
    expect(resizeCueWithin(cue, "start", -50, 200, 4000)).toMatchObject({ startMs: 200 });
  });
});

describe("painting a cue", () => {
  const measure = { font: "", measureText: (text: string) => ({ width: text.length * 10 }) };

  it("centres the box at the bottom by default and at the top when asked", () => {
    const bottom = cueBox(["Hello"], DEFAULT_CAPTION_STYLE, 1000, 500, measure);
    expect(bottom.x + bottom.width / 2).toBeCloseTo(500, 0);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(500);
    expect(bottom.y).toBeGreaterThan(250);
    const top = cueBox(["Hello"], { ...DEFAULT_CAPTION_STYLE, position: "top" }, 1000, 500, measure);
    expect(top.y).toBeLessThan(100);
  });

  it("grows with size and never leaves the video", () => {
    const small = cueBox(["Hi"], { ...DEFAULT_CAPTION_STYLE, size: "small" }, 1000, 500, measure);
    const large = cueBox(["Hi"], { ...DEFAULT_CAPTION_STYLE, size: "large" }, 1000, 500, measure);
    expect(large.height).toBeGreaterThan(small.height);
    const wide = cueBox(["x".repeat(500)], DEFAULT_CAPTION_STYLE, 300, 200, measure);
    expect(wide.x).toBe(0);
    expect(wide.width).toBeLessThanOrEqual(300);
  });
});
