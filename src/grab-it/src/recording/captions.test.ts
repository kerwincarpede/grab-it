import { describe, expect, it } from "vitest";
import {
  cueBox,
  fitCueLines,
  graphemes,
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
import { CAPTIONS_VERSION, parseEdits, serializeEdits } from "./edits";
import type { Clip } from "./clips";

const ids = () => {
  let n = 0;
  return () => `c${++n}`;
};

const words = (text: string, startMs: number, stepMs: number) =>
  text.split(" ").map((word, index) => ({ text: word, startMs: startMs + index * stepMs, endMs: startMs + (index + 1) * stepMs }));

describe("captions sidecar", () => {
  it("round-trips cues as the captions version and drops ones it does not understand", () => {
    const cue: Cue = { id: "a", startMs: 100, endMs: 900, text: "Hello there" };
    const sidecar = serializeEdits({ version: 1, captions: { burnIn: true, cues: [cue] } });
    expect(sidecar).toEqual({ version: CAPTIONS_VERSION, captions: { burnIn: true, cues: [cue] } });
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

  it("splits text written without spaces between characters, keeping the line and time limits", () => {
    // One 100-character "word" over 20 s, as Whisper gives a Chinese segment.
    const text = "这是一个很长的句子".repeat(12).slice(0, 100);
    const transcript = { version: 1, model: "whisper-base", language: "zh", segments: [{ startMs: 0, endMs: 20_000, text, words: [{ text: ` ${text}`, startMs: 0, endMs: 20_000 }] }] };
    const cues = cuesFromTranscript(transcript, "a.mp4", "a.mp4", ids());
    expect(cues.length).toBeGreaterThan(3);
    expect(cues.map((cue) => cue.text).join("")).toBe(text);
    for (const cue of cues) {
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(MAX_CUE_MS);
      expect(cue.text).not.toContain(" ");
      const lines = wrapLines(cue.text);
      expect(lines).not.toBeNull();
      expect(lines!.every((line) => Array.from(line).length <= MAX_LINE_CHARS)).toBe(true);
    }
    expect(wrapLines("字".repeat(50))).toEqual(["字".repeat(42), "字".repeat(8)]);
  });

  it("joins per-character words of unspaced text without spaces, and spaced words with one", () => {
    // As segments_from_steps gives them: one trimmed word per character.
    const words = ["你", "好", "世", "界"].map((text, index) => ({ text, startMs: index * 500, endMs: (index + 1) * 500 }));
    const zh = { version: 1, model: "whisper-base", language: "zh", segments: [{ startMs: 0, endMs: 2000, text: "你好世界", words }] };
    expect(cuesFromTranscript(zh, "a.mp4", "a.mp4", ids()).map((cue) => cue.text)).toEqual(["你好世界"]);
    const mixed = {
      ...zh,
      segments: [{ startMs: 0, endMs: 3000, text: "你好 Grab-it 世界", words: [...words.slice(0, 2), { text: "Grab-it", startMs: 1000, endMs: 2000 }, ...words.slice(2).map((word) => ({ ...word, startMs: word.startMs + 1000, endMs: word.endMs + 1000 }))] }],
    };
    expect(cuesFromTranscript(mixed, "a.mp4", "a.mp4", ids()).map((cue) => cue.text)).toEqual(["你好 Grab-it 世界"]);
  });

  it("keeps cues inside their segment and the recording, and makes none past its end", () => {
    // As a transcript saved before word times were placed: a 12 s recording
    // whose words run past both their segment and the recording.
    const segment = (startMs: number, endMs: number, words: [string, number, number][]) => ({
      startMs,
      endMs,
      text: words.map(([text]) => text).join(" "),
      words: words.map(([text, start, end]) => ({ text, startMs: start, endMs: end })),
    });
    const transcript: Transcript = {
      version: 1,
      model: "whisper-base",
      language: "en",
      segments: [
        segment(0, 5000, [["The", 1000, 5000], ["bananas", 5000, 5000], ["are", 5000, 5000]]),
        segment(8000, 15_000, [["Banana's", 8000, 14_160], ["are", 14_160, 14_160], ["yellow", 14_160, 15_000]]),
        segment(12_500, 14_000, [["gone", 12_500, 14_000]]),
      ],
    };
    const cues = cuesFromTranscript(transcript, "a.mp4", "a.mp4", ids(), 12_000);
    expect(cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([
      ["The bananas are", 0, 5000],
      ["Banana's are yellow", 8000, 12_000],
    ]);
    for (const cue of cues) expect(cue.endMs).toBeGreaterThan(cue.startMs);
  });

  it("spreads words that share a start over the time until the next, and joins a word with no time", () => {
    const transcript: Transcript = {
      version: 1,
      model: "m",
      language: "en",
      segments: [{ startMs: 0, endMs: 9000, text: "", words: [{ text: "one", startMs: 0, endMs: 0 }, { text: "two", startMs: 1000, endMs: 1000 }, { text: "three", startMs: 1000, endMs: 4000 }, { text: "four", startMs: 4000, endMs: 9000 }, { text: "five", startMs: 9000, endMs: 9000 }] }],
    };
    const cues = cuesFromTranscript(transcript, "a.mp4", "a.mp4", ids());
    expect(cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([
      ["one two three", 0, 4000],
      ["four five", 4000, 9000],
    ]);
  });

  it("keeps fitted words' own ends, so no cue covers the quiet between them", () => {
    // Fitted to voice at 0.5-1.5 s and 3.5-4.5 s, with quiet between.
    const before = words("The quick fox", 500, 1000 / 3).map((word, index) => (index === 2 ? { ...word, endMs: 1500 } : word));
    const after = words("jumps over it", 3500, 1000 / 3).map((word, index) => (index === 2 ? { ...word, endMs: 4500 } : word));
    const transcript: Transcript = {
      version: 1,
      model: "whisper-base",
      language: "en",
      segments: [{ startMs: 400, endMs: 4600, text: "The quick fox jumps over it", words: [...before, ...after] }],
    };
    const cues = cuesFromTranscript(transcript, "a.mp4", "a.mp4", ids());
    expect(cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([
      ["The quick fox", 500, 1500],
      ["jumps over it", 3500, 4500],
    ]);
    expect(cues.some((cue) => cue.startMs < 3500 && cue.endMs > 1500)).toBe(false);
  });

  it("wraps text into lines no longer than the limit", () => {
    expect(wrapLines("a ".repeat(30).trim())?.every((line) => line.length <= MAX_LINE_CHARS)).toBe(true);
    expect(wrapLines("word ".repeat(40))).toBeNull();
  });
});

describe("cues on the sequence", () => {
  const cue: Cue = { id: "q", startMs: 1000, endMs: 3000, text: "Hello" };
  const clips: Clip[] = [
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

  /** Measures as a font `em` wide per character does, at the font's size. */
  const sized = (em = 0.55) => {
    const fake = {
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * em * Number(/(\d+)px/.exec(fake.font)?.[1] ?? 0) }),
    };
    return fake;
  };

  it.each([
    ["16:9", 1920, 1080, 59],
    ["1:1", 1080, 1080, 33],
    ["9:16", 1080, 1920, 33],
  ])("keeps every line of a long cue inside a %s video, on two lines", (_, width, height, px) => {
    for (const size of ["small", "medium", "large"] as const) {
      const style = { ...DEFAULT_CAPTION_STYLE, size };
      const fake = sized();
      const text = "This caption is exactly as long as the line limit allows, twice over here";
      const { lines, fontPx } = fitCueLines(text, style, width, height, fake);
      if (size === "medium") expect(fontPx).toBe(px);
      expect(lines.join(" ")).toBe(text);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(fake.measureText(line).width).toBeLessThanOrEqual(width * 0.9);
      const box = cueBox(lines, style, width, height, fake, fontPx);
      expect(box.fontPx).toBe(fontPx);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.width).toBeLessThanOrEqual(Math.ceil(width * 0.9));
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
  });

  it("keeps a two-line Large cue at 16:9 on two balanced lines, stepping its font down", () => {
    const fake = sized();
    const text = "The quick brown fox jumps over a lazy dog.\nThen it runs off into the woods for good.";
    const { lines, fontPx } = fitCueLines(text.replace("\n", " "), { ...DEFAULT_CAPTION_STYLE, size: "large" }, 1920, 1080, fake);
    expect(lines).toHaveLength(2);
    expect(fontPx).toBeLessThan(81);
    expect(fontPx).toBeGreaterThanOrEqual(Math.round(81 * 0.6));
    expect(Math.min(...lines.map((line) => line.length))).toBeGreaterThan(30);
    for (const line of lines) expect(fake.measureText(line).width).toBeLessThanOrEqual(1920 * 0.9);
  });

  it("balances the lines of a paragraph so none is left with a short orphan", () => {
    const fake = sized();
    // 46 characters: too long for one line, wrapped greedily as 42 + 3.
    const { lines } = fitCueLines("The quick brown fox jumps over the lazy dogs, ok", DEFAULT_CAPTION_STYLE, 1920, 1080, fake);
    expect(lines).toHaveLength(2);
    expect(Math.min(...lines.map((line) => line.length))).toBeGreaterThan(15);
  });

  it("keeps a full CJK cue at 16:9 to two lines", () => {
    const fake = sized(1);
    const text = "我们今天来看一下这个新的功能怎么使用以及它可以帮助我们做什么事情".repeat(2);
    const { lines, fontPx } = fitCueLines(text, DEFAULT_CAPTION_STYLE, 1920, 1080, fake);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe(text);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(1);
    for (const line of lines) expect(fake.measureText(line).width).toBeLessThanOrEqual(1920 * 0.9);
    expect(fontPx).toBeLessThanOrEqual(59);
  });

  it("takes more lines once the font is as small as it goes", () => {
    const fake = sized(1);
    const text = "short words then Supercalifragilisticexpialidocious and a great many more words after it, far more than two lines hold";
    const { lines, fontPx } = fitCueLines(text, DEFAULT_CAPTION_STYLE, 400, 400, fake);
    // 12 px at 400 × 400 Medium, stepped down to its floor of 8 px.
    expect(fontPx).toBe(8);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(fake.measureText(line).width).toBeLessThanOrEqual(400 * 0.9);
    expect(lines.join(" ")).toBe(text);
  });

  it("keeps a cue's own line breaks", () => {
    const { lines } = fitCueLines("One\nTwo\nThree", DEFAULT_CAPTION_STYLE, 1920, 1080, sized());
    expect(lines).toEqual(["One", "Two", "Three"]);
  });

  it("breaks an over-wide word between graphemes, never inside an emoji or a combining sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const accented = "e\u0301";
    expect(graphemes(`a${family}${accented}`)).toEqual(["a", family, accented]);
    const word = `${family}${accented}`.repeat(40);
    const { lines } = fitCueLines(word, DEFAULT_CAPTION_STYLE, 400, 400, sized(1));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("\u0301")).toBe(false);
      expect(line.startsWith("\u200D")).toBe(false);
      expect(graphemes(line).every((each) => each === family || each === accented)).toBe(true);
    }
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
