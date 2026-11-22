import { useEffect, useMemo, useRef, useState } from "react";
import { recordingAudition, recordingPauses, type RecordingPauses } from "./api";
import { isGap, type Clip } from "./clips";
import { formatTime } from "./edits";
import { applyCuts, cutSequenceMs, cutsLength, isValidCut, proposeCuts, reasonLabel, soundLabel, type CutProposal } from "./suggestions";
import type { CursorPath } from "./zooms";

/** How much sound either side of a cut an audition plays. */
const AUDITION_CONTEXT_MS = 2000;
/** How long before the first chosen cut a preview starts. */
const PREVIEW_LEAD_MS = 2000;

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);

export interface SuggestEditsPanelProps {
  /** The sequence as saved, which proposals are made against. */
  clips: Clip[];
  /** The opened recording's file name. */
  own: string;
  /** Whether the sequence holds more than one clip, so ranges name their recording. */
  joined: boolean;
  cursorOf: (source: string) => CursorPath | null;
  /** Plays `next` in place of the sequence from `fromMs`, or ends the preview with null. */
  onPreview: (next: Clip[] | null, fromMs?: number) => void;
  /** Keeps `next` as the sequence, as one undo entry. */
  onApply: (next: Clip[]) => void;
  onClose: () => void;
}

/** The pauses of one recording, or why they could not be found. */
type Heard = { pauses: RecordingPauses } | { error: string };

/**
 * Suggest edits: cuts proposed at the recording's pauses, chosen one by
 * one, previewed together and applied in one undo entry; and the sound
 * around a cut played as recorded and as the export cleans it.
 */
export default function SuggestEditsPanel({ clips, own, joined, cursorOf, onPreview, onApply, onClose }: SuggestEditsPanelProps) {
  const sources = useMemo(() => [...new Set(clips.filter((clip) => !isGap(clip)).map((clip) => clip.source))].sort(), [clips]);
  const [heard, setHeard] = useState<Record<string, Heard>>({});
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [audition, setAudition] = useState<{ cleaned: boolean; url: string } | null>(null);
  const [auditionBusy, setAuditionBusy] = useState(false);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewRef = useRef(onPreview);
  useEffect(() => {
    previewRef.current = onPreview;
  });

  // Each recording is listened to once while the panel is open.
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const source of sources) {
      if (requested.current.has(source)) continue;
      requested.current.add(source);
      recordingPauses(source)
        .then((pauses) => mounted.current && setHeard((known) => ({ ...known, [source]: { pauses } })))
        .catch((err: unknown) => mounted.current && setHeard((known) => ({ ...known, [source]: { error: errorText(err) } })));
    }
  }, [sources]);

  const proposals = useMemo(
    () =>
      sources.flatMap((source) => {
        const found = heard[source];
        if (!found || "error" in found) return [];
        return proposeCuts(clips, source, found.pauses.sound, found.pauses.pauses, cursorOf(source));
      }),
    [sources, heard, clips, cursorOf],
  );
  const loading = sources.some((source) => !heard[source]);
  const errors = sources.flatMap((source) => {
    const found = heard[source];
    return found && "error" in found ? [`${source}: ${found.error}`] : [];
  });
  // Every proposal starts chosen.
  const selected = proposals.filter((cut) => (chosen ? chosen.has(cut.id) : true) && isValidCut(clips, cut));
  const focus = proposals.find((cut) => cut.id === focusId) ?? selected[0] ?? proposals[0] ?? null;
  const focusSound = focus ? heard[focus.source] : undefined;
  const focusPauses = focusSound && "pauses" in focusSound ? focusSound.pauses : null;
  const ownSound = heard[own];

  // Leaving the panel mid-preview ends the preview.
  const previewingRef = useRef(false);
  useEffect(() => {
    previewingRef.current = previewing;
  }, [previewing]);
  useEffect(
    () => () => {
      if (previewingRef.current) previewRef.current(null);
    },
    [],
  );
  useEffect(
    () => () => {
      if (audition) URL.revokeObjectURL(audition.url);
    },
    [audition],
  );

  const toggle = (cut: CutProposal) => {
    const next = new Set(chosen ?? proposals.map((each) => each.id));
    if (next.has(cut.id)) next.delete(cut.id);
    else next.add(cut.id);
    setChosen(next);
    if (previewing) stopPreview();
  };

  const startPreview = () => {
    if (selected.length === 0) return;
    const first = Math.min(...selected.map((cut) => cutSequenceMs(clips, cut) ?? 0));
    onPreview(applyCuts(clips, selected), Math.max(0, first - PREVIEW_LEAD_MS));
    setPreviewing(true);
  };

  const stopPreview = () => {
    onPreview(null);
    setPreviewing(false);
  };

  const apply = () => {
    if (selected.length === 0) return;
    previewingRef.current = false;
    setPreviewing(false);
    onApply(applyCuts(clips, selected));
    onClose();
  };

  const listen = async (cleaned: boolean) => {
    if (!focus) return;
    audioRef.current?.pause();
    setAuditionBusy(true);
    setAuditionError(null);
    try {
      const blob = await recordingAudition(focus.source, Math.max(0, focus.startMs - AUDITION_CONTEXT_MS), focus.endMs + AUDITION_CONTEXT_MS, cleaned);
      setAudition({ cleaned, url: URL.createObjectURL(blob) });
    } catch (err) {
      setAuditionError(errorText(err));
    } finally {
      setAuditionBusy(false);
    }
  };

  const stopAudition = () => {
    audioRef.current?.pause();
    setAudition(null);
  };

  const range = (cut: CutProposal) => `${joined || cut.source !== own ? `${cut.source} ` : ""}${formatTime(cut.startMs)}–${formatTime(cut.endMs)}`;

  return (
    <section
      className="recording-suggest-panel"
      aria-label="Suggested edits"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (previewing) stopPreview();
          else onClose();
        }
      }}
    >
      <header>
        <strong>Suggested edits</strong>
        {ownSound && "pauses" in ownSound && <span className="suggest-sound">{soundLabel(ownSound.pauses.sound)}</span>}
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </header>
      {loading && <p role="status">Listening for pauses…</p>}
      {errors.map((error) => (
        <p key={error} role="alert">
          Could not listen for pauses in {error}
        </p>
      ))}
      {!loading && proposals.length === 0 && errors.length === 0 && <p>No pauses long enough to cut were found.</p>}
      {proposals.length > 0 && (
        <ul className="suggest-list" aria-label="Proposed cuts">
          {proposals.map((cut) => (
            <li key={cut.id} data-focus={focus?.id === cut.id ? "true" : undefined}>
              <label>
                <input type="checkbox" checked={selected.some((each) => each.id === cut.id)} onChange={() => toggle(cut)} />
                <span className="suggest-reason">{reasonLabel(cut.reason)}</span>
              </label>
              <button type="button" className="suggest-range" onClick={() => setFocusId(cut.id)} aria-label={`Listen around ${range(cut)}`}>
                {range(cut)}
              </button>
              <span className="suggest-length">{formatTime(cut.endMs - cut.startMs)}</span>
            </li>
          ))}
        </ul>
      )}
      {proposals.length > 0 && (
        <div className="bar-group">
          {previewing ? (
            <button type="button" className="text-button" onClick={stopPreview}>
              Stop preview
            </button>
          ) : (
            <button type="button" className="text-button" onClick={startPreview} disabled={selected.length === 0} title="Play the sequence with the chosen cuts, without changing it">
              Preview
            </button>
          )}
          <button type="button" className="text-button" data-primary="true" onClick={apply} disabled={selected.length === 0}>
            Apply {selected.length} {selected.length === 1 ? "cut" : "cuts"} ({formatTime(cutsLength(selected))})
          </button>
          {previewing && <span role="status">Previewing: press Play to hear the chosen cuts.</span>}
        </div>
      )}
      {focus && (
        <div className="suggest-audition" role="group" aria-label="Audio audition">
          <span>Listen around {range(focus)}</span>
          {focusPauses?.sound === "silent" || focusPauses?.sound === undefined ? (
            <span>{focusPauses ? "This recording has no sound." : ""}</span>
          ) : (
            <>
              <button type="button" className="text-button" aria-pressed={audition?.cleaned === false} disabled={auditionBusy} onClick={() => void listen(false)}>
                Original
              </button>
              <button
                type="button"
                className="text-button"
                aria-pressed={audition?.cleaned === true}
                disabled={auditionBusy || !focusPauses.canClean}
                title={focusPauses.canClean ? "As the export removes background noise" : "The microphone was recorded together with other sound, so it cannot be cleaned"}
                onClick={() => void listen(true)}
              >
                Cleaned
              </button>
              {audition && (
                <button type="button" className="text-button" onClick={stopAudition}>
                  Stop
                </button>
              )}
            </>
          )}
          {auditionBusy && <span role="status">Preparing…</span>}
          {auditionError && <span role="alert">{auditionError}</span>}
          {audition && <audio ref={audioRef} src={audition.url} autoPlay aria-label={audition.cleaned ? "Cleaned audio" : "Original audio"} />}
        </div>
      )}
    </section>
  );
}
