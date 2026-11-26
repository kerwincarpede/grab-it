import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { onFfmpegStatus } from "../settings/api";
import { recordingWaveform, type AudioKind } from "./api";
import type { Clip } from "./clips";
import type { Trim } from "./edits";
import WaveformLane from "./WaveformLane";
import { laneKinds, laneSegments, peaksKey, type LaneSegment, type LaneView, type PeaksState } from "./waveform";

/** The lanes' height in px: the least, the most, and at first. */
export const MIN_LANE_HEIGHT = 24;
export const MAX_LANE_HEIGHT = 120;
export const DEFAULT_LANE_HEIGHT = 40;
/** How far the arrow keys resize the lanes. */
const LANE_KEY_STEP = 8;

const clampHeight = (height: number) => Math.round(Math.min(MAX_LANE_HEIGHT, Math.max(MIN_LANE_HEIGHT, height)));

interface WaveformLanesProps {
  /** The sequence on screen, drafts and previews included. */
  clips: Clip[];
  /** Whether the timeline is the joined sequence's, else the opened recording's own time. */
  joined: boolean;
  /** The timeline's length in ms. */
  durationMs: number;
  /** The trim on screen; unjoined, the ends outside it are dimmed. */
  trim: Trim;
  /** Each recording's sound sources by kind, or null until known. */
  audioOf: (source: string) => readonly AudioKind[] | null;
  /** What each kind's lane is called, and its tooltip. */
  nameOf: (kind: AudioKind) => string;
  hintOf?: (kind: AudioKind) => string | undefined;
  /**
   * The stretch of track the timeline shows and its width, at the rows'
   * scale (the timeline view's `track`); nothing is drawn before it is known.
   */
  view: LaneView | null;
}

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);

/**
 * A waveform lane for each kind of sound any clip has, under the zoom row,
 * and a separator under them that drags, or takes the arrow keys, to
 * change their height. Each recording source's peaks are asked for once
 * while the editor is open; those that failed are asked for again when
 * ffmpeg becomes ready, as before then every request fails.
 */
export default function WaveformLanes({ clips, joined, durationMs, trim, audioOf, nameOf, hintOf, view }: WaveformLanesProps) {
  const [peaks, setPeaks] = useState<Record<string, PeaksState>>({});
  const requested = useRef(new Set<string>());
  /** Requests that failed, dropped from `requested` to ask again once ffmpeg is ready. */
  const failed = useRef(new Set<string>());
  /** Bumped to ask again for the peaks that failed. */
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(DEFAULT_LANE_HEIGHT);
  const drag = useRef<{ y: number; height: number } | null>(null);

  // Kept the same from render to render until a lane's clips change, so
  // the lanes redraw only when what they show does, not on every frame
  // the editor plays.
  const lanesKey = JSON.stringify(laneKinds(clips, audioOf).map((kind) => ({ kind, segments: laneSegments(clips, kind, audioOf, joined, durationMs, trim) })));
  const lanes = useMemo(() => JSON.parse(lanesKey) as { kind: AudioKind; segments: LaneSegment[] }[], [lanesKey]);
  const peaksOf = useCallback((segment: LaneSegment) => peaks[peaksKey(segment.source, segment.audio)], [peaks]);
  const startMs = view?.startMs ?? 0;
  const endMs = view?.endMs ?? durationMs;
  const viewWidth = view?.width ?? 0;
  const shown = useMemo<LaneView>(() => ({ startMs, endMs, width: viewWidth }), [startMs, endMs, viewWidth]);
  const wanted = [...new Set(lanes.flatMap((lane) => lane.segments.map((segment) => JSON.stringify([segment.source, segment.audio]))))].sort().join("\n");

  useEffect(() => {
    if (!wanted) return;
    for (const entry of wanted.split("\n")) {
      const [source, audio] = JSON.parse(entry) as [string, number];
      const key = peaksKey(source, audio);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setPeaks((known) => ({ ...known, [key]: { status: "loading" } }));
      let loading: Promise<Uint8Array>;
      try {
        loading = recordingWaveform(source, audio);
      } catch (err) {
        loading = Promise.reject(err);
      }
      loading
        .then((found) => setPeaks((known) => ({ ...known, [key]: { status: "ready", peaks: found } })))
        .catch((err: unknown) => {
          failed.current.add(key);
          setPeaks((known) => ({ ...known, [key]: { status: "failed", error: errorText(err) } }));
        });
    }
  }, [wanted, attempt]);

  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    const listening = (() => {
      try {
        return onFfmpegStatus((status) => {
          if (status.state !== "ready" || failed.current.size === 0) return;
          for (const key of failed.current) requested.current.delete(key);
          failed.current.clear();
          setAttempt((n) => n + 1);
        });
      } catch (err) {
        return Promise.reject(err);
      }
    })();
    listening
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);

  if (lanes.length === 0) return null;

  const startResize = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { y: event.clientY, height };
  };
  const resize = (event: PointerEvent<HTMLElement>) => {
    if (drag.current) setHeight(clampHeight(drag.current.height + event.clientY - drag.current.y));
  };
  const endResize = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    drag.current = null;
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    let next: number;
    switch (event.key) {
      case "ArrowUp":
        next = height - LANE_KEY_STEP;
        break;
      case "ArrowDown":
        next = height + LANE_KEY_STEP;
        break;
      case "Home":
        next = MIN_LANE_HEIGHT;
        break;
      case "End":
        next = MAX_LANE_HEIGHT;
        break;
      default:
        return;
    }
    event.preventDefault();
    setHeight(clampHeight(next));
  };

  return (
    <div className="waveform-lanes">
      {lanes.map(({ kind, segments }) => (
        <WaveformLane
          key={kind}
          kind={kind}
          label={nameOf(kind)}
          hint={hintOf?.(kind)}
          segments={segments}
          peaksOf={peaksOf}
          view={shown}
          height={height}
        />
      ))}
      <div
        className="waveform-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Waveform height"
        aria-valuemin={MIN_LANE_HEIGHT}
        aria-valuemax={MAX_LANE_HEIGHT}
        aria-valuenow={height}
        title="Drag to change the waveforms' height"
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={keys}
      />
    </div>
  );
}
