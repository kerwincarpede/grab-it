import { test } from "vitest";
import * as clips from "./clips";
import type { Clip } from "./clips";
import type { Zoom } from "./zooms";

// Taken from the module once: calling through the test runner's export
// getters on every iteration would time the getters as well.
const { clipStarts, moveClip, parseClips, sequenceDuration, splitClip, toSequence, toSource, zoomOwners } = clips;

const OWN = "own.mp4";
const SOURCES = [OWN, "second.mp4", "third.mp4", "fourth.mp4"];

/** A sequence of 200 clips of four recordings, with a gap after every tenth. */
const CLIPS: Clip[] = Array.from({ length: 200 }, (_, i): Clip => {
  if (i % 10 === 9) return { id: `g${i}`, source: "", startMs: 0, endMs: 1500, gap: true };
  const startMs = (i * 7919) % 60_000;
  return { id: `c${i}`, source: SOURCES[i % SOURCES.length], startMs, endMs: startMs + 2000 + (i % 13) * 500 };
});

/** 400 zooms spread over the four recordings, half of them untagged (on `OWN`). */
const ZOOMS: Zoom[] = Array.from({ length: 400 }, (_, i): Zoom => {
  const startMs = (i * 4513) % 70_000;
  return {
    id: `z${i}`,
    ...(i % 2 === 0 ? {} : { source: SOURCES[i % SOURCES.length] }),
    startMs,
    endMs: startMs + 1500,
    scale: 2,
    focus: { kind: "cursor" },
  };
});

const DURATION = sequenceDuration(CLIPS);
/** The clips as a sidecar stores them. */
const SAVED = JSON.parse(JSON.stringify(CLIPS.map((clip) => (clip.gap ? { id: clip.id, gapMs: clip.endMs } : clip)))) as unknown;

test("recording/clips", async ({ bench }) => {
  await bench("scrub 1000 times across 200 clips", () => {
    for (let i = 0; i < 1000; i++) {
      const at = toSource(CLIPS, (i / 1000) * DURATION);
      if (at) toSequence(CLIPS, at.index, at.sourceMs);
    }
  }).run();

  await bench("clip starts and zoom owners of 200 clips", () => {
    clipStarts(CLIPS);
    zoomOwners(CLIPS, ZOOMS, OWN);
  }).run();

  await bench("split and move 100 times", () => {
    let sequence = CLIPS;
    for (let i = 0; i < 100; i++) {
      const index = (i * 37) % sequence.length;
      const clip = sequence[index];
      sequence = splitClip(sequence, index, (clip.startMs + clip.endMs) / 2, `s${i}`);
      sequence = moveClip(sequence, `s${i}`, (i * 53) % sequence.length);
    }
  }).run();

  await bench("read 200 saved clips", () => parseClips(SAVED, 3)).run();
});
