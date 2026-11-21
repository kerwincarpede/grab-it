// The overlay bench: with `GRAB_IT_OVERLAY_BENCH` set (even to ""), the
// backend opens overlays at `#/overlay?bench`, and once its image is
// painted the page replays a 120 Hz hover sweep and a drag and reports
// frame timing through `overlay_bench_log`, then cancels. Without the flag
// nothing here calls the backend or records anything. See
// docs/analysis/capture-overlay-performance.md.
//
// The bench's commands are called from here rather than from api.ts: they
// exist only for the bench and nothing else in the overlay uses them.
import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import { routeHasFlag } from "../routes";

/** The overlay was opened for the bench (`#/overlay?bench`). */
export function benchEnabled(hash: string = window.location.hash): boolean {
  return routeHasFlag(hash, "bench");
}

/** The switches the bench runs with, once `setupBench` has found it on. */
let switches: ReadonlySet<string> | null = null;
/** Page-side timestamps of opening the overlay, in ms. */
let marks: Record<string, number> = {};
/** How long steps of opening the overlay took, in ms. */
let spans: Record<string, number> = {};

/** `GRAB_IT_OVERLAY_BENCH`'s comma-separated switches. */
export function parseSwitches(config: string): Set<string> {
  return new Set(
    config
      .split(",")
      .map((switchName) => switchName.trim())
      .filter(Boolean),
  );
}

/** The bench is running with `name` among its switches. */
export function benchSwitch(name: string): boolean {
  return switches?.has(name) ?? false;
}

/** Notes when a step of opening the overlay happened. */
export function benchMark(name: string) {
  if (benchEnabled()) marks[name] = performance.now();
}

/** Notes how long a step of opening the overlay took. */
export function benchSpan(name: string, ms: number) {
  if (benchEnabled()) spans[name] = ms;
}

/** Styles that switch one suspect off, by switch name. */
const CSS: Record<string, string> = {
  noblend: ".overlay-guide{mix-blend-mode:normal!important}",
  noguides: ".overlay-guide{display:none!important}",
  noselection: ".overlay-frame,.overlay-window{display:none!important}",
  nodim: ".overlay-dim{display:none!important}",
  // Puts back the 0.01ms transition App.css used to give every element
  // under Reduce Motion, to cost it on its own.
  leak: ".overlay,.overlay *{transition:all 0.01ms!important}",
  nowillchange:
    ".overlay-dim-piece,.overlay-frame-edge,.overlay-frame-tick,.overlay-frame .overlay-label{will-change:auto!important}",
  nobackdrop: ".overlay-backdrop{display:none!important}",
  nohint: ".overlay-hint{display:none!important}",
  noimage: ".overlay-image{display:none!important}",
};

const STYLE_ID = "overlay-bench-style";

/**
 * Loads the bench's switches and applies those that are styles. Resolves to
 * false, having called nothing, when the overlay was not opened for the
 * bench.
 */
export async function setupBench(hash: string = window.location.hash): Promise<boolean> {
  switches = null;
  document.getElementById(STYLE_ID)?.remove();
  if (!benchEnabled(hash)) return false;
  const config = await invoke<string | null>("overlay_bench_config").catch(() => null);
  if (config === null) return false;
  switches = parseSwitches(config);
  const css = [...switches].map((name) => CSS[name] ?? "").filter(Boolean).join("\n");
  if (css) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  return true;
}

/** Makes the overlay's window opaque, for the `opaque` switch. */
export function benchOpaque(): Promise<void> {
  return invoke<void>("overlay_bench_opaque").catch(() => {});
}

function benchLog(line: unknown): Promise<void> {
  return invoke<void>("overlay_bench_log", { line: JSON.stringify(line) }).catch(() => {});
}

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** What one phase of the bench measured, as `overlay_bench_log` prints it. */
export interface PhaseStats {
  phase: string;
  ms: number;
  moves: number;
  frames: number;
  fps: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** Frames longer than 1.5 vsyncs at 120 Hz. */
  missed: number;
  /** Mean JS per pointer move (handler + React render + commit + effects). */
  scriptPerMove: number;
  scriptP95: number;
  /** Mean rendering work per frame: rAF callback to the next task (style, layout, paint). */
  renderPerFrame: number;
  renderP95: number;
  /** When the longest frame started, in ms into the phase. */
  maxAt: number;
  /** The worst single move. */
  scriptMax: number;
  /** The worst single style pass. */
  renderMax: number;
  /** Transitions and animations running halfway through: none should be. */
  anims: number;
  /**
   * With `probe`, per piece that follows the pointer: frames that painted it
   * away from the latest pointer position, of the frames drawn.
   */
  behind: Record<string, string>;
}

/**
 * Where each piece that follows the pointer is about to be painted, as the
 * x it should share with the pointer. Read from the computed style, so a
 * transition holding a piece back shows up.
 */
const PROBES: Record<string, (el: HTMLElement) => number> = {
  ".overlay-guide-y": (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).e,
  ".overlay-selection:not(.overlay-window)": (el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.left) + parseFloat(style.width);
  },
  ".overlay-frame-edge:nth-child(4)": (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).e,
  ".overlay-dim-piece:nth-child(4)": (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).e,
};

/** 120 Hz, as a ProMotion pointer delivers moves. */
const SLOT_MS = 1000 / 120;

async function runPhase(
  phase: string,
  target: Element,
  ms: number,
  path: (t: number) => { x: number; y: number },
  buttons: number,
): Promise<PhaseStats> {
  // `probe`: of the frames drawn, how many painted each piece somewhere
  // other than at the latest pointer position. Costs a style read per frame,
  // so not on by default.
  const probing = benchSwitch("probe");
  // `raw`: moves are dispatched as the browser dispatches them, leaving it
  // to the page when it renders. Otherwise each is flushed at once.
  const raw = benchSwitch("raw");
  let lastX: number | null = null;
  const behind: Record<string, [number, number]> = {};
  const frameTimes: number[] = [];
  const renders: number[] = [];
  const scripts: number[] = [];
  let running = true;
  const channel = new MessageChannel();
  let rafAt = 0;
  channel.port1.onmessage = () => renders.push(performance.now() - rafAt);
  const onFrame = (ts: number) => {
    if (!running) return;
    frameTimes.push(ts);
    if (probing && lastX !== null) {
      for (const [selector, paintedX] of Object.entries(PROBES)) {
        // The tint only ends at the pointer while a region is dragged.
        if (buttons === 0 && selector.startsWith(".overlay-dim")) continue;
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) continue;
        const seen = (behind[selector] ??= [0, 0]);
        seen[1]++;
        if (Math.abs(paintedX(el) - lastX) > 0.5) seen[0]++;
      }
    }
    rafAt = performance.now();
    channel.port2.postMessage(0);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

  const start = performance.now();
  let moves = 0;
  let anims = 0;
  setTimeout(() => {
    anims = document.getAnimations().length;
  }, ms / 2);
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = performance.now() - start;
      if (t >= ms) return resolve();
      const p = path(t / ms);
      const ev = new MouseEvent("mousemove", { clientX: p.x, clientY: p.y, buttons, bubbles: true });
      const s0 = performance.now();
      lastX = ev.clientX;
      if (raw) target.dispatchEvent(ev);
      else flushSync(() => target.dispatchEvent(ev));
      scripts.push(performance.now() - s0);
      moves++;
      // The next 120 Hz slot from the start, as a pointer would deliver it.
      const next = Math.ceil((performance.now() - start + 0.01) / SLOT_MS) * SLOT_MS;
      setTimeout(step, Math.max(0, start + next - performance.now()));
    };
    step();
  });
  running = false;
  const elapsed = performance.now() - start;
  channel.port1.close();

  const intervals = frameTimes.slice(1).map((t, i) => t - frameTimes[i]);
  let maxAt = 0;
  intervals.forEach((interval, i) => {
    if (interval > intervals[maxAt]) maxAt = i;
  });
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const sortedScripts = [...scripts].sort((a, b) => a - b);
  const sortedRenders = renders.slice(1).sort((a, b) => a - b);
  const span = frameTimes.length > 1 ? frameTimes[frameTimes.length - 1] - frameTimes[0] : 0;
  return {
    phase,
    ms: Math.round(elapsed),
    moves,
    frames: frameTimes.length,
    fps: span > 0 ? r1((intervals.length / span) * 1000) : 0,
    frameP50: r1(pct(sortedIntervals, 0.5)),
    frameP95: r1(pct(sortedIntervals, 0.95)),
    frameMax: r1(sortedIntervals[sortedIntervals.length - 1] ?? 0),
    missed: intervals.filter((i) => i > 1.5 * SLOT_MS).length,
    scriptPerMove: r1(mean(scripts)),
    scriptP95: r1(pct(sortedScripts, 0.95)),
    renderPerFrame: r1(mean(sortedRenders)),
    renderP95: r1(pct(sortedRenders, 0.95)),
    maxAt: frameTimes.length > 1 ? Math.round(frameTimes[maxAt] - frameTimes[0]) : 0,
    scriptMax: r1(sortedScripts[sortedScripts.length - 1] ?? 0),
    renderMax: r1(sortedRenders[sortedRenders.length - 1] ?? 0),
    anims,
    behind: Object.fromEntries(
      Object.entries(behind).map(([selector, [late, all]]) => [selector, `${late}/${all}`]),
    ),
  };
}

/**
 * Replays the hover sweep and the drag on `target` (the `.overlay`
 * element), logs each, then presses Esc. Call once the image is painted.
 */
export async function runBench(target: Element) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const base = marks.start ?? 0;
  const open: Record<string, number> = {};
  for (const [name, at] of Object.entries(marks)) open[name] = r1(at - base);
  for (const [name, ms] of Object.entries(spans)) open[name] = r1(ms);
  await benchLog({ open, viewport: [w, h, window.devicePixelRatio], off: [...(switches ?? [])] });
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Hover: a zig-zag sweep over the whole screen, crossing many windows.
  const hover = await runPhase(
    "hover",
    target,
    2500,
    (t) => {
      const rows = 5;
      const row = Math.min(rows - 1, Math.floor(t * rows));
      const f = t * rows - row;
      const x = row % 2 === 0 ? f : 1 - f;
      return { x: 40 + x * (w - 80), y: 60 + ((row + 0.5) / rows) * (h - 120) };
    },
    0,
  );
  void benchLog(hover);
  // Drag: press near the top left, then sweep the corner around the screen.
  const anchor = { x: 150, y: 150 };
  target.dispatchEvent(
    new MouseEvent("mousedown", {
      clientX: anchor.x,
      clientY: anchor.y,
      button: 0,
      buttons: 1,
      bubbles: true,
    }),
  );
  const drag = await runPhase(
    "drag",
    target,
    3000,
    (t) => {
      const a = t * Math.PI * 4;
      return {
        x: anchor.x + 40 + (w - anchor.x - 120) * (0.5 + 0.5 * Math.sin(a)),
        y: anchor.y + 40 + (h - anchor.y - 120) * (0.5 + 0.5 * Math.sin(a * 0.75 + 1)),
      };
    },
    1,
  );
  await benchLog(drag);
  marks = {};
  spans = {};
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
