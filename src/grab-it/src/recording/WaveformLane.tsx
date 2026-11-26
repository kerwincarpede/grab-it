import { useEffect, useRef } from "react";
import type { AudioKind } from "./api";
import { BAR_PX, layoutLane, type LaneSegment, type LaneView, type PeaksState } from "./waveform";

interface WaveformLaneProps {
  kind: AudioKind;
  /** The lane's name, as the status bar names the kind. */
  label: string;
  /** Why the lane is named so, as a tooltip; for Mixed sound. */
  hint?: string;
  /** Each clip's stretch of this kind of sound. */
  segments: LaneSegment[];
  /** What is known of a segment's recording's peaks. */
  peaksOf: (segment: LaneSegment) => PeaksState | undefined;
  /** The stretch of track the timeline shows, and its width. */
  view: LaneView;
  /** The lane's height in px. */
  height: number;
}

/** A colour token from the editor's theme, read where the lane is drawn. */
const token = (element: Element, name: string, fallback: string) => getComputedStyle(element).getPropertyValue(name).trim() || fallback;

/**
 * One kind of sound across the timeline: each clip's own recording's
 * peaks at its place, and nothing over gaps or clips without that kind.
 * The canvas covers the track the timeline shows and stays over it while
 * the timeline scrolls. A placeholder shows until the peaks arrive, and
 * "Waveform unavailable" when they cannot be read, beside the lane's name
 * so they stay in view with it.
 */
export default function WaveformLane({ kind, label, hint, segments, peaksOf, view, height }: WaveformLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { bars, spans } = layoutLane(segments, peaksOf, view);
  // Said for the whole lane, whatever part of it is scrolled into view.
  const states = segments.map(peaksOf);
  const failed = states.find((state) => state?.status === "failed");
  const loading = !failed && states.some((state) => state?.status !== "ready");
  const width = Math.max(0, Math.floor(view.width));

  useEffect(() => {
    const canvas = canvasRef.current;
    // Nothing to draw before the view is measured.
    if (width <= 0) return;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Each clip's stretch, so a quiet clip still shows where it is.
    ctx.fillStyle = token(canvas, "--ed-surface", "#1e2128");
    for (const span of spans) ctx.fillRect(span.x, 0, span.width, height);
    const accent = token(canvas, "--ed-accent", "#4c8dff");
    const middle = height / 2;
    for (const bar of bars) {
      const tall = Math.max(1, bar.height * (height - 4));
      ctx.globalAlpha = bar.dim ? 0.35 : 1;
      ctx.fillStyle = accent;
      ctx.fillRect(bar.x, middle - tall / 2, BAR_PX - 1, tall);
    }
    ctx.globalAlpha = 1;
  });

  const state = failed ? "failed" : loading ? "loading" : "ready";
  return (
    <div className="waveform-lane" role="group" aria-label={`${label} waveform`} data-testid={`waveform-${kind}`} data-state={state} style={{ height }}>
      <div className="waveform-view" style={{ width }}>
        <canvas ref={canvasRef} className="waveform-canvas" data-bars={bars.length} style={{ width, height }} />
        <div className="waveform-tags">
          <span className="waveform-label" title={hint}>
            {label}
          </span>
          {failed?.status === "failed" ? (
            <span className="waveform-status" title={failed.error}>
              Waveform unavailable
            </span>
          ) : (
            loading && <span className="waveform-status waveform-placeholder">Reading sound…</span>
          )}
        </div>
      </div>
    </div>
  );
}
