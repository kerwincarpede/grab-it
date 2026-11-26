import { describe, expect, it } from "vitest";
import { parseEdits, serializeEdits } from "./edits";
import { clipsOf, gapOf, sequenceDuration, withClips, type Clip } from "./clips";
import { applyCuts, cleanSpans, cutSequenceMs, INITIAL_TUNING, intersect, isValidCut, MIN_CUT_RANGE, PAD_RANGE, proposeCuts, soundLabel, stillSpans, type CutProposal } from "./suggestions";
import type { CursorPath } from "./zooms";

const OWN = "own.mp4";
const whole: Clip[] = [{ id: "own", source: OWN, startMs: 0, endMs: 12_000 }];
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};
const cut = (startMs: number, endMs: number, clipId = "own", source = OWN): CutProposal => ({ id: `${clipId}:${startMs}`, clipId, source, startMs, endMs, reason: "pause" });

/** A pointer path at 10 fps: still at one point for `still` frames, moving for the rest. */
function path(frames: number, still: [number, number]): CursorPath {
  const points: [number, number][] = [];
  for (let index = 0; index < frames; index++) {
    points.push(index >= still[0] && index < still[1] ? [0.5, 0.5] : [(index % 2) * 0.5, 0.2]);
  }
  return { fps: 10, points };
}

describe("cleanSpans", () => {
  it("drops invalid ranges and merges overlaps", () => {
    expect(
      cleanSpans([
        { startMs: 5000, endMs: 4000 },
        { startMs: -10, endMs: 200 },
        { startMs: Number.NaN, endMs: 3 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 1500, endMs: 2500 },
      ]),
    ).toEqual([{ startMs: 1000, endMs: 2500 }]);
  });

  it("intersects two lists", () => {
    expect(intersect([{ startMs: 0, endMs: 5000 }], [{ startMs: 1000, endMs: 2000 }, { startMs: 4000, endMs: 8000 }])).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
    ]);
  });
});

describe("stillSpans", () => {
  it("finds where the pointer stays put", () => {
    expect(stillSpans(path(100, [20, 60]))).toEqual([{ startMs: 2000, endMs: 5900 }]);
  });

  it("is null without a pointer path", () => {
    expect(stillSpans(null)).toBeNull();
    expect(stillSpans({ fps: 0, points: [[0, 0]] })).toBeNull();
  });
});

describe("proposeCuts", () => {
  it("cuts a pause, keeping a little of it at both ends", () => {
    expect(proposeCuts(whole, OWN, "microphone", [{ startMs: 3000, endMs: 6000 }], null, INITIAL_TUNING)).toEqual([{ id: "own:3250", clipId: "own", source: OWN, startMs: 3250, endMs: 5750, reason: "pause" }]);
  });

  it("leaves pauses where the pointer moves", () => {
    const cursor = path(120, [40, 75]);
    expect(proposeCuts(whole, OWN, "mixed", [{ startMs: 3000, endMs: 8000 }], cursor, INITIAL_TUNING)).toEqual([{ id: "own:4250", clipId: "own", source: OWN, startMs: 4250, endMs: 7150, reason: "pause" }]);
  });

  it("cuts a pause the pointer rests through, padded only at its ends", () => {
    // 15 s at 10 fps: still over the pauses at 2–4.5 s and 11–13 s, moving over the one at 6.5–9 s.
    const resting = (index: number) => (index >= 20 && index < 45) || (index >= 110 && index < 130);
    const points = Array.from({ length: 150 }, (_, index): [number, number] => (resting(index) ? [0.5, 0.5] : [(index % 2) * 0.5, 0.2]));
    const clips: Clip[] = [{ id: "own", source: OWN, startMs: 0, endMs: 15_000 }];
    const pauses = [
      { startMs: 2000, endMs: 4500 },
      { startMs: 6500, endMs: 9000 },
      { startMs: 11_000, endMs: 13_000 },
    ];
    expect(proposeCuts(clips, OWN, "microphone", pauses, { fps: 10, points }, INITIAL_TUNING)).toEqual([
      { id: "own:2250", clipId: "own", source: OWN, startMs: 2250, endMs: 4150, reason: "pause" },
      { id: "own:11250", clipId: "own", source: OWN, startMs: 11_250, endMs: 12_650, reason: "pause" },
    ]);
  });

  it("follows the pointer alone in a silent demonstration", () => {
    const proposals = proposeCuts(whole, OWN, "silent", [], path(120, [30, 80]), INITIAL_TUNING);
    expect(proposals).toEqual([{ id: "own:3250", clipId: "own", source: OWN, startMs: 3250, endMs: 7650, reason: "idle" }]);
    expect(proposeCuts(whole, OWN, "silent", [], null, INITIAL_TUNING)).toEqual([]);
  });

  it("treats system sound alone as no voice to pause", () => {
    expect(proposeCuts(whole, OWN, "system", [{ startMs: 3000, endMs: 6000 }], null, INITIAL_TUNING)).toEqual([]);
  });

  it("never proposes stretches already cut, nor leaves a sliver of a clip", () => {
    const clips: Clip[] = [
      { id: "a", source: OWN, startMs: 0, endMs: 3000 },
      gapOf("g", 1000),
      { id: "b", source: OWN, startMs: 7000, endMs: 12_000 },
    ];
    const pauses = [
      { startMs: 2000, endMs: 8000 },
      { startMs: 9000, endMs: 11_900 },
    ];
    expect(proposeCuts(clips, OWN, "microphone", pauses, null, INITIAL_TUNING)).toEqual([]);
    expect(proposeCuts(clips, OWN, "microphone", [{ startMs: 8000, endMs: 10_500 }], null, INITIAL_TUNING)).toEqual([{ id: "b:8250", clipId: "b", source: OWN, startMs: 8250, endMs: 10_250, reason: "pause" }]);
  });

  it("proposes shorter cuts at the lowest Minimum cut and only long ones at the highest", () => {
    const pauses = [
      { startMs: 1000, endMs: 2100 },
      { startMs: 4000, endMs: 9600 },
    ];
    const lowest = { ...INITIAL_TUNING, minCutMs: MIN_CUT_RANGE.min };
    expect(proposeCuts(whole, OWN, "microphone", pauses, null, lowest).map((each) => [each.startMs, each.endMs])).toEqual([
      [1250, 1850],
      [4250, 9350],
    ]);
    const highest = { ...INITIAL_TUNING, minCutMs: MIN_CUT_RANGE.max };
    expect(proposeCuts(whole, OWN, "microphone", pauses, null, highest).map((each) => [each.startMs, each.endMs])).toEqual([[4250, 9350]]);
    // The bound is the cut after padding: 5.1 s of pause leaves a 4.1 s cut at the highest padding.
    const padded = { minCutMs: MIN_CUT_RANGE.max, padMs: PAD_RANGE.max };
    expect(proposeCuts(whole, OWN, "microphone", [{ startMs: 4000, endMs: 9100 }], null, padded)).toEqual([]);
  });

  it("keeps none of a pause at the lowest Keep padding and half a second at the highest", () => {
    const pauses = [{ startMs: 3000, endMs: 6000 }];
    expect(proposeCuts(whole, OWN, "microphone", pauses, null, { ...INITIAL_TUNING, padMs: PAD_RANGE.min })).toEqual([{ id: "own:3000", clipId: "own", source: OWN, startMs: 3000, endMs: 6000, reason: "pause" }]);
    expect(proposeCuts(whole, OWN, "microphone", pauses, null, { ...INITIAL_TUNING, padMs: PAD_RANGE.max })).toEqual([{ id: "own:3500", clipId: "own", source: OWN, startMs: 3500, endMs: 5500, reason: "pause" }]);
  });

  it("still leaves at least MIN_CLIP_MS of a clip at the lowest padding and Minimum cut", () => {
    const tightest = { minCutMs: MIN_CUT_RANGE.min, padMs: PAD_RANGE.min };
    const spans = (pauses: { startMs: number; endMs: number }[]) => proposeCuts(whole, OWN, "microphone", pauses, null, tightest).map((each) => [each.startMs, each.endMs]);
    // A cut may take a clip's very start or end...
    expect(spans([{ startMs: 0, endMs: 900 }])).toEqual([[0, 900]]);
    expect(spans([{ startMs: 11_400, endMs: 12_000 }])).toEqual([[11_400, 12_000]]);
    // ...but never leave a sliver shorter than half a second before or after it.
    expect(spans([{ startMs: 300, endMs: 1200 }])).toEqual([]);
    expect(spans([{ startMs: 11_000, endMs: 11_700 }])).toEqual([]);
    expect(spans([{ startMs: 500, endMs: 1100 }])).toEqual([[500, 1100]]);
  });

  it("starts from the values Suggest edits always used", () => {
    expect(INITIAL_TUNING).toEqual({ minCutMs: 1200, padMs: 250 });
  });

  it("skips short pauses and other recordings", () => {
    expect(proposeCuts(whole, OWN, "microphone", [{ startMs: 3000, endMs: 4000 }], null, INITIAL_TUNING)).toEqual([]);
    expect(proposeCuts(whole, "other.mp4", "microphone", [{ startMs: 3000, endMs: 6000 }], null, INITIAL_TUNING)).toEqual([]);
  });
});

describe("applyCuts", () => {
  it("removes each cut, closing the stretch it took", () => {
    const next = applyCuts(whole, [cut(8000, 10_000), cut(2000, 4000)], ids());
    expect(next).toEqual([
      { id: "own", source: OWN, startMs: 0, endMs: 2000 },
      { id: "n1", source: OWN, startMs: 4000, endMs: 8000 },
      { id: "n2", source: OWN, startMs: 10_000, endMs: 12_000 },
    ]);
    expect(sequenceDuration(next)).toBe(8000);
  });

  it("skips a cut that no longer lies inside a clip", () => {
    const clips: Clip[] = [{ id: "a", source: OWN, startMs: 0, endMs: 5000 }];
    expect(isValidCut(clips, cut(4000, 6000, "a"))).toBe(false);
    expect(isValidCut(clips, cut(1000, 2000, "gone"))).toBe(false);
    expect(applyCuts(clips, [cut(4000, 6000, "a"), cut(7000, 6000, "a"), cut(1000, 2000, "gone")])).toEqual(clips);
  });

  it("never removes the last stretch that plays a recording", () => {
    expect(applyCuts(whole, [cut(0, 12_000)])).toEqual(whole);
  });

  it("finds where a cut begins in the sequence", () => {
    const clips: Clip[] = [gapOf("g", 1000), { id: "a", source: OWN, startMs: 2000, endMs: 9000 }];
    expect(cutSequenceMs(clips, cut(3000, 5000, "a"))).toBe(2000);
    expect(cutSequenceMs(clips, cut(0, 1000, "a"))).toBeNull();
  });

  it("cuts the duplicate it was proposed on, not the first clip of the same stretch", () => {
    const clips: Clip[] = [
      { id: "a", source: OWN, startMs: 0, endMs: 6000 },
      { id: "b", source: OWN, startMs: 0, endMs: 6000 },
    ];
    const proposals = proposeCuts(clips, OWN, "microphone", [{ startMs: 2000, endMs: 4000 }], null, INITIAL_TUNING);
    expect(proposals.map((each) => each.clipId)).toEqual(["a", "b"]);
    const second = proposals[1];
    expect(cutSequenceMs(clips, second)).toBe(8250);
    expect(applyCuts(clips, [second], ids())).toEqual([
      { id: "a", source: OWN, startMs: 0, endMs: 6000 },
      { id: "b", source: OWN, startMs: 0, endMs: 2250 },
      { id: "n1", source: OWN, startMs: 3750, endMs: 6000 },
    ]);
  });

  it("follows a clip into the part an earlier cut left", () => {
    const clips: Clip[] = [
      { id: "a", source: OWN, startMs: 0, endMs: 12_000 },
      { id: "b", source: OWN, startMs: 0, endMs: 12_000 },
    ];
    expect(applyCuts(clips, [cut(2000, 4000, "b"), cut(8000, 10_000, "b")], ids())).toEqual([
      { id: "a", source: OWN, startMs: 0, endMs: 12_000 },
      { id: "b", source: OWN, startMs: 0, endMs: 2000 },
      { id: "n1", source: OWN, startMs: 4000, endMs: 8000 },
      { id: "n2", source: OWN, startMs: 10_000, endMs: 12_000 },
    ]);
  });

  it("is kept in the sidecar and reopened as the same clips", () => {
    const next = applyCuts(whole, [cut(3250, 5750)], ids());
    const reopened = parseEdits(JSON.parse(JSON.stringify(serializeEdits(withClips({ version: 1 }, next, OWN, 12_000)))));
    expect(clipsOf(reopened, OWN, 12_000)).toEqual(next);
  });
});

describe("soundLabel", () => {
  it("tells isolated, mixed and silent recordings apart", () => {
    expect(soundLabel("microphone")).toMatch(/Original and Cleaned/);
    expect(soundLabel("mixed")).toMatch(/only the original/);
    expect(soundLabel("silent")).toMatch(/Silent/);
  });
});
