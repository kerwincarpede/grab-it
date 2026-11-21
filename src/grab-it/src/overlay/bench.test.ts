import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchEnabled,
  benchMark,
  benchSpan,
  benchSwitch,
  parseSwitches,
  phaseStats,
  runBench,
  setupBench,
  takeOpenMarks,
  type PhaseSamples,
} from "./bench";

/** Fakes the backend, with `config` as `GRAB_IT_OVERLAY_BENCH`; returns the commands called. */
function mockBench(config: string | null): string[] {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "overlay_bench_config") return config;
    throw new Error(`unexpected command ${cmd}`);
  });
  return calls;
}

const benchStyle = () => document.getElementById("overlay-bench-style");

afterEach(() => {
  benchStyle()?.remove();
  window.location.hash = "";
  takeOpenMarks();
});

describe("benchEnabled", () => {
  it("is on only for an overlay the backend opened for the bench", () => {
    expect(benchEnabled("#/overlay")).toBe(false);
    expect(benchEnabled("#/overlay?instant")).toBe(false);
    expect(benchEnabled("#/overlay?bench")).toBe(true);
    expect(benchEnabled("#/overlay?instant&bench")).toBe(true);
  });
});

describe("parseSwitches", () => {
  it("reads comma-separated switches, ignoring spaces and empty ones", () => {
    expect([...parseSwitches("")]).toEqual([]);
    expect([...parseSwitches("noloupe, probe,,raw ")]).toEqual(["noloupe", "probe", "raw"]);
  });
});

describe("setupBench", () => {
  it("turns on the switches the backend was started with", async () => {
    const calls = mockBench("noloupe, probe,nodim");

    await expect(setupBench("#/overlay?instant&bench")).resolves.toBe(true);

    expect(calls).toEqual(["overlay_bench_config"]);
    expect(benchSwitch("noloupe")).toBe(true);
    expect(benchSwitch("probe")).toBe(true);
    expect(benchSwitch("lazy")).toBe(false);
    // Switches that are styles hide what they name.
    expect(benchStyle()?.textContent).toContain(".overlay-dim{display:none!important}");
  });

  it("runs with no switches when the variable is empty", async () => {
    mockBench("");

    await expect(setupBench("#/overlay?bench")).resolves.toBe(true);

    expect(benchSwitch("noloupe")).toBe(false);
    expect(benchStyle()).toBeNull();
  });

  it("stays off, asking the backend nothing, without the bench flag", async () => {
    mockBench("noloupe");
    await setupBench("#/overlay?bench");
    const calls = mockBench("noloupe");

    await expect(setupBench("#/overlay?instant")).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(benchSwitch("noloupe")).toBe(false);
  });

  it("stays off when the backend has no bench configured", async () => {
    mockBench(null);

    await expect(setupBench("#/overlay?bench")).resolves.toBe(false);

    expect(benchSwitch("noloupe")).toBe(false);
  });
});

describe("benchMark and benchSpan", () => {
  it("record nothing without the bench flag", () => {
    window.location.hash = "#/overlay?instant";

    benchMark("start");
    benchMark("decoded");
    benchSpan("backdropMs", 12);

    expect(takeOpenMarks()).toEqual({});
  });

  it("record marks after the start and spans as they are, once", () => {
    window.location.hash = "#/overlay?instant&bench";

    benchMark("start");
    benchSpan("backdropMs", 12.34);
    const open = takeOpenMarks();

    expect(open).toEqual({ start: 0, backdropMs: 12.3 });
    expect(takeOpenMarks()).toEqual({});
  });
});

describe("phaseStats", () => {
  const samples = (overrides: Partial<PhaseSamples> = {}): PhaseSamples => ({
    phase: "drag",
    elapsed: 40.4,
    moves: 4,
    // Intervals of 8, 8, 14 and 8 ms: one frame missed, starting 16 ms in.
    frameTimes: [0, 8, 16, 30, 38],
    scripts: [1, 0, 2, 1],
    // The first is a warm-up and left out.
    renders: [9, 1, 2, 3],
    anims: 0,
    behind: { ".overlay-guide-y": [1, 4] },
    ...overrides,
  });

  it("sums up frame, script and render times", () => {
    expect(phaseStats(samples())).toEqual({
      phase: "drag",
      ms: 40,
      moves: 4,
      frames: 5,
      fps: 105.3,
      frameP50: 8,
      frameP95: 14,
      frameMax: 14,
      missed: 1,
      scriptPerMove: 1,
      scriptP95: 2,
      renderPerFrame: 2,
      renderP95: 3,
      maxAt: 16,
      scriptMax: 2,
      renderMax: 3,
      anims: 0,
      behind: { ".overlay-guide-y": "1/4" },
    });
  });

  it("reports zeros for a phase that drew one frame or none", () => {
    for (const frameTimes of [[], [5]]) {
      const stats = phaseStats(
        samples({ frameTimes, scripts: [], renders: [], moves: 0, behind: {} }),
      );

      expect(stats).toMatchObject({
        frames: frameTimes.length,
        fps: 0,
        frameP50: 0,
        frameMax: 0,
        missed: 0,
        maxAt: 0,
        scriptPerMove: 0,
        renderMax: 0,
        behind: {},
      });
    }
  });
});

describe("runBench", () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("replays a hover and a drag, logs each, then presses Esc", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame", "performance"] });
    // jsdom has no Web Animations.
    Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
    const lines: string[] = [];
    mockIPC((cmd, payload) => {
      if (cmd === "overlay_bench_config") return "";
      if (cmd === "overlay_bench_log") {
        lines.push((payload as { line: string }).line);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    window.location.hash = "#/overlay?bench";
    await setupBench();
    benchMark("start");
    const target = document.createElement("div");
    document.body.appendChild(target);
    const moves: number[] = [];
    target.addEventListener("mousemove", (event) => moves.push(event.buttons));
    const presses = vi.fn();
    target.addEventListener("mousedown", presses);
    const keys: string[] = [];
    const onKey = (event: KeyboardEvent) => keys.push(event.key);
    window.addEventListener("keydown", onKey);

    const done = runBench(target);
    await vi.advanceTimersByTimeAsync(7000);
    await done;

    window.removeEventListener("keydown", onKey);
    target.remove();
    const [open, hover, drag] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(open).toMatchObject({ open: { start: 0 }, off: [] });
    expect(hover).toMatchObject({ phase: "hover", anims: 0 });
    expect(drag).toMatchObject({ phase: "drag", anims: 0 });
    // Moves at 120 Hz: about 300 over the hover's 2.5 s, then the drag's with the button held.
    expect(hover.moves).toBeGreaterThan(250);
    expect(moves.filter((buttons) => buttons === 0)).toHaveLength(hover.moves as number);
    expect(moves.filter((buttons) => buttons === 1)).toHaveLength(drag.moves as number);
    expect(presses).toHaveBeenCalledTimes(1);
    expect(keys).toEqual(["Escape"]);
  });
});
