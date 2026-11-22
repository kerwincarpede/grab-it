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
  /**
   * Whether the editor is playing a preview of the cuts. The editor owns
   * it, so an undo that ends the preview shows here too.
   */
  previewing: boolean;
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
export default function SuggestEditsPanel({ clips, own, joined, cursorOf, previewing, onPreview, onApply, onClose }: SuggestEditsPanelProps) {
  const sources = useMemo(() => [...new Set(clips.filter((clip) => !isGap(clip)).map((clip) => clip.source))].sort(), [clips]);
  const [heard, setHeard] = useState<Record<string, Heard>>({});
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The audition playing, for the cut it was made for. */
  const [audition, setAudition] = useState<{ cutId: string; cleaned: boolean; url: string } | null>(null);
  /** The cut an audition is being prepared for. */
  const [auditionBusy, setAuditionBusy] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<{ cutId: string; text: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Counts audition requests, so only the latest one's sound is kept. */
  const auditionTicket = useRef(0);

  // Each recording is listened to once while the panel is open.
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      auditionTicket.current += 1;
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

  // Only the focused cut's audition plays; another cut's is let go.
  const shownAudition = audition && audition.cutId === focus?.id ? audition : null;
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
  };

  const stopPreview = () => onPreview(null);

  const apply = () => {
    if (selected.length === 0) return;
    onApply(applyCuts(clips, selected));
    onClose();
  };

  const listen = async (cleaned: boolean) => {
    if (!focus) return;
    const cut = focus;
    const ticket = ++auditionTicket.current;
    audioRef.current?.pause();
    setAudition(null);
    setAuditionBusy(cut.id);
    setAuditionError(null);
    const current = () => ticket === auditionTicket.current && mounted.current;
    try {
      const blob = await recordingAudition(cut.source, Math.max(0, cut.startMs - AUDITION_CONTEXT_MS), cut.endMs + AUDITION_CONTEXT_MS, cleaned);
      if (current()) setAudition({ cutId: cut.id, cleaned, url: URL.createObjectURL(blob) });
    } catch (err) {
      if (current()) setAuditionError({ cutId: cut.id, text: errorText(err) });
    } finally {
      if (current()) setAuditionBusy(null);
    }
  };

  /** Moves the audition to cut `id`, letting go of any sound for another. */
  const focusOn = (id: string) => {
    if (id === focus?.id) return;
    auditionTicket.current += 1;
    audioRef.current?.pause();
    setAudition(null);
    setAuditionBusy(null);
    setAuditionError(null);
    setFocusId(id);
  };

  const stopAudition = () => {
    auditionTicket.current += 1;
    audioRef.current?.pause();
    setAudition(null);
    setAuditionBusy(null);
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
              <button type="button" className="suggest-range" onClick={() => focusOn(cut.id)} aria-label={`Listen around ${range(cut)}`}>
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
              <button type="button" className="text-button" aria-pressed={shownAudition?.cleaned === false} disabled={auditionBusy !== null} onClick={() => void listen(false)}>
                Original
              </button>
              <button
                type="button"
                className="text-button"
                aria-pressed={shownAudition?.cleaned === true}
                disabled={auditionBusy !== null || !focusPauses.canClean}
                title={focusPauses.canClean ? "As the export removes background noise" : "The microphone was recorded together with other sound, so it cannot be cleaned"}
                onClick={() => void listen(true)}
              >
                Cleaned
              </button>
              {shownAudition && (
                <button type="button" className="text-button" onClick={stopAudition}>
                  Stop
                </button>
              )}
            </>
          )}
          {auditionBusy === focus.id && <span role="status">Preparing…</span>}
          {auditionError?.cutId === focus.id && <span role="alert">{auditionError.text}</span>}
          {shownAudition && <audio ref={audioRef} src={shownAudition.url} autoPlay aria-label={shownAudition.cleaned ? "Cleaned audio" : "Original audio"} />}
        </div>
      )}
    </section>
  );
}
