import { useEffect, useMemo, useRef, useState } from "react";
import { recordingAudition, recordingPauses, type RecordingPauses } from "./api";
import { isGap, type Clip } from "./clips";
import { formatTime } from "./edits";
import {
  applyCuts,
  cutSequenceMs,
  cutsLength,
  INITIAL_TUNING,
  isValidCut,
  MIN_CUT_RANGE,
  NOISE_DB_RANGE,
  PAD_RANGE,
  proposeCuts,
  reasonLabel,
  soundLabel,
  type CutProposal,
  type CutTuning,
  type PauseSound,
  type ShownCut,
} from "./suggestions";

/** How much sound either side of a cut an audition plays. */
const AUDITION_CONTEXT_MS = 2000;
/** How long before the first chosen cut a preview starts. */
const PREVIEW_LEAD_MS = 2000;
/** How much of the sequence either side of one cut its own preview plays. */
const CUT_PREVIEW_CONTEXT_MS = 2000;

/** A length in seconds, as the tuning controls show it: "0.25 s". */
const seconds = (ms: number) => `${Number((ms / 1000).toFixed(2))} s`;

/** Where the heard pauses of `source` at threshold `noiseDb` are kept. */
const heardKey = (source: string, noiseDb: number) => `${noiseDb} ${source}`;

/** The proposals the clip track hatches while the panel is open, and the one the panel has in focus. */
export interface ShownCuts {
  cuts: ShownCut[];
  focusId: string | null;
}

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);

export interface SuggestEditsPanelProps {
  /** The sequence as saved, which proposals are made against. */
  clips: Clip[];
  /** The opened recording's file name. */
  own: string;
  /** Whether the saved sequence holds more than one clip, so ranges name their recording. */
  joined: boolean;
  /**
   * Whether the editor is playing a preview of the cuts. The editor owns
   * it, so an undo that ends the preview shows here too.
   */
  previewing: boolean;
  /**
   * Plays `next` in place of the sequence from `fromMs`, or ends the
   * preview with null. With `endMs` it plays at once and ends the preview
   * on its own once the playhead reaches `endMs` of `next`.
   */
  onPreview: (next: Clip[] | null, fromMs?: number, endMs?: number) => void;
  /** Keeps `next` as the sequence, as one undo entry. */
  onApply: (next: Clip[]) => void;
  onClose: () => void;
  /** Hears which proposals the clip track should hatch; null once the panel closes. */
  onShowCuts?: (shown: ShownCuts | null) => void;
  /** A proposal clicked on the clip track, to bring into focus; a new object each click. */
  focusRequest?: { id: string } | null;
}

/** The pauses of one recording, or why they could not be found. */
type Heard = { pauses: RecordingPauses } | { error: string };

/**
 * Suggest edits: cuts proposed at the recording's pauses, chosen one by
 * one, previewed together and applied in one undo entry; and the sound
 * around a cut played as recorded and as the export cleans it.
 */
export default function SuggestEditsPanel({ clips, own, joined, previewing, onPreview, onApply, onClose, onShowCuts, focusRequest = null }: SuggestEditsPanelProps) {
  const sources = useMemo(() => [...new Set(clips.filter((clip) => !isGap(clip)).map((clip) => clip.source))].sort(), [clips]);
  /** The pauses heard in each recording at each threshold listened at, by `heardKey`. */
  const [heard, setHeard] = useState<Record<string, Heard>>({});
  /** What each recording's pauses are heard in, which no threshold changes. */
  const [sounds, setSounds] = useState<Record<string, PauseSound>>({});
  // The tuning starts from the same values each time the panel opens.
  const [noiseDb, setNoiseDb] = useState(NOISE_DB_RANGE.initial);
  /** The threshold while its control moves; it is listened at once let go. */
  const [noiseDraft, setNoiseDraft] = useState(NOISE_DB_RANGE.initial);
  const [tuning, setTuning] = useState<CutTuning>(INITIAL_TUNING);
  /** Proposals unticked; every other one is chosen, so a retuned proposal starts ticked. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The cut whose own preview is playing, while `previewing`. */
  const [previewCutId, setPreviewCutId] = useState<string | null>(null);
  /** The audition playing, for the cut it was made for. */
  const [audition, setAudition] = useState<{ cutId: string; cleaned: boolean; url: string } | null>(null);
  /** The cut an audition is being prepared for. */
  const [auditionBusy, setAuditionBusy] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<{ cutId: string; text: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Counts audition requests, so only the latest one's sound is kept. */
  const auditionTicket = useRef(0);

  /**
   * Each recording is listened to once per threshold while the panel is
   * open: the listen ticket a request went out with, or "done".
   */
  const requested = useRef(new Map<string, number | "done">());
  /** Counts threshold changes, so a listen for one let go of is dropped when it comes back late. */
  const listenTicket = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      auditionTicket.current += 1;
    };
  }, []);
  useEffect(() => {
    const ticket = listenTicket.current;
    for (const source of sources) {
      const at = heardKey(source, noiseDb);
      const asked = requested.current.get(at);
      if (asked === "done" || asked === ticket) continue;
      requested.current.set(at, ticket);
      const keep = (found: Heard) => {
        if (!mounted.current) return;
        if (ticket !== listenTicket.current) {
          // The threshold moved on while this was heard; listen again if it comes back.
          if (requested.current.get(at) === ticket) requested.current.delete(at);
          return;
        }
        requested.current.set(at, "done");
        setHeard((known) => ({ ...known, [at]: found }));
        if ("pauses" in found) setSounds((known) => ({ ...known, [source]: found.pauses.sound }));
      };
      recordingPauses(source, noiseDb)
        .then((pauses) => keep({ pauses }))
        .catch((err: unknown) => keep({ error: errorText(err) }));
    }
  }, [sources, noiseDb]);

  const heardNow = (source: string) => heard[heardKey(source, noiseDb)] as Heard | undefined;
  const proposals = useMemo(
    () =>
      sources.flatMap((source) => {
        const found = heard[heardKey(source, noiseDb)] as Heard | undefined;
        if (!found || "error" in found) return [];
        return proposeCuts(clips, source, found.pauses.sound, found.pauses.pauses, found.pauses.pointer, tuning);
      }),
    [sources, heard, noiseDb, clips, tuning],
  );
  const loading = sources.some((source) => !heardNow(source));
  const errors = sources.flatMap((source) => {
    const found = heardNow(source);
    return found && "error" in found ? [`${source}: ${found.error}`] : [];
  });
  const selected = useMemo(() => proposals.filter((cut) => !dropped.has(cut.id) && isValidCut(clips, cut)), [proposals, dropped, clips]);
  const focus = proposals.find((cut) => cut.id === focusId) ?? selected[0] ?? proposals[0] ?? null;
  const focusSound = focus ? heardNow(focus.source) : undefined;
  const focusPauses = focusSound && "pauses" in focusSound ? focusSound.pauses : null;
  const ownSound = sounds[own] as PauseSound | undefined;
  // A recording with no voice has its cuts from the pointer, which no threshold changes.
  const thresholdOff = sources.length > 0 && sources.every((source) => sounds[source] === "system" || sounds[source] === "silent");

  // The clip track hatches the proposals while the panel is open.
  const focusedId = focus?.id ?? null;
  useEffect(() => {
    const chosenIds = new Set(selected.map((cut) => cut.id));
    onShowCuts?.({ cuts: proposals.map((cut) => ({ ...cut, chosen: chosenIds.has(cut.id) })), focusId: focusedId });
  }, [proposals, selected, focusedId, onShowCuts]);
  useEffect(() => () => onShowCuts?.(null), [onShowCuts]);

  // A proposal clicked on the clip track comes into focus, as a click on its row would.
  const [seenRequest, setSeenRequest] = useState(focusRequest);
  if (focusRequest !== seenRequest) {
    setSeenRequest(focusRequest);
    if (focusRequest && focusRequest.id !== focus?.id) {
      setAudition(null);
      setAuditionBusy(null);
      setAuditionError(null);
      setFocusId(focusRequest.id);
    }
  }
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    listRef.current?.querySelector('[data-focus="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [focusRequest]);

  // Once the editor ends a preview, no cut's own preview is playing.
  if (!previewing && previewCutId !== null) setPreviewCutId(null);

  // Only the focused cut's audition plays; another cut's is let go.
  const shownAudition = audition && audition.cutId === focus?.id ? audition : null;
  useEffect(
    () => () => {
      if (audition) URL.revokeObjectURL(audition.url);
    },
    [audition],
  );

  const toggle = (cut: CutProposal) => {
    const next = new Set(dropped);
    if (next.has(cut.id)) next.delete(cut.id);
    else next.add(cut.id);
    setDropped(next);
    if (previewing) stopPreview();
  };

  const startPreview = () => {
    if (selected.length === 0) return;
    const first = Math.min(...selected.map((cut) => cutSequenceMs(clips, cut) ?? 0));
    setPreviewCutId(null);
    onPreview(applyCuts(clips, selected), Math.max(0, first - PREVIEW_LEAD_MS));
  };

  /** Plays `cut` alone, ticked or not: from a little before it to a little after, its pause skipped. */
  const previewCut = (cut: CutProposal) => {
    const at = cutSequenceMs(clips, cut);
    if (at === null) return;
    setPreviewCutId(cut.id);
    onPreview(applyCuts(clips, [cut]), Math.max(0, at - CUT_PREVIEW_CONTEXT_MS), at + CUT_PREVIEW_CONTEXT_MS);
  };

  const stopPreview = () => onPreview(null);

  /** Listens again at the threshold the control was let go at. */
  const commitThreshold = () => {
    if (noiseDraft === noiseDb) return;
    listenTicket.current += 1;
    setNoiseDb(noiseDraft);
    if (previewing) stopPreview();
  };

  const retune = (next: Partial<CutTuning>) => {
    setTuning((now) => ({ ...now, ...next }));
    if (previewing) stopPreview();
  };

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
        {ownSound && <span className="suggest-sound">{soundLabel(ownSound)}</span>}
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="suggest-tuning" role="group" aria-label="Tuning">
        <label title={thresholdOff ? "This recording has no voice to pause: its cuts follow the pointer" : "How quiet sound must be to count as a pause. Listens again when let go"}>
          <span>Threshold</span>
          <input
            type="range"
            min={NOISE_DB_RANGE.min}
            max={NOISE_DB_RANGE.max}
            step={NOISE_DB_RANGE.step}
            value={noiseDraft}
            aria-label="Threshold"
            disabled={thresholdOff}
            aria-valuetext={`${noiseDraft} dB`}
            onChange={(event) => setNoiseDraft(Number(event.target.value))}
            onPointerUp={commitThreshold}
            onKeyUp={commitThreshold}
            onBlur={commitThreshold}
          />
          <output>{noiseDraft} dB</output>
        </label>
        <label title="The shortest stretch proposed for a cut, after its padding is kept">
          <span>Minimum cut</span>
          <input
            type="range"
            min={MIN_CUT_RANGE.min}
            max={MIN_CUT_RANGE.max}
            step={MIN_CUT_RANGE.step}
            value={tuning.minCutMs}
            aria-label="Minimum cut"
            aria-valuetext={seconds(tuning.minCutMs)}
            onChange={(event) => retune({ minCutMs: Number(event.target.value) })}
          />
          <output>{seconds(tuning.minCutMs)}</output>
        </label>
        <label title="How much of a pause is kept at each end of a cut, so speech is never clipped">
          <span>Keep padding</span>
          <input
            type="range"
            min={PAD_RANGE.min}
            max={PAD_RANGE.max}
            step={PAD_RANGE.step}
            value={tuning.padMs}
            aria-label="Keep padding"
            aria-valuetext={seconds(tuning.padMs)}
            onChange={(event) => retune({ padMs: Number(event.target.value) })}
          />
          <output>{seconds(tuning.padMs)}</output>
        </label>
      </div>
      {loading && <p role="status">Listening for pauses…</p>}
      {errors.map((error) => (
        <p key={error} role="alert">
          Could not listen for pauses in {error}
        </p>
      ))}
      {!loading && proposals.length === 0 && errors.length === 0 && <p>No pauses long enough to cut were found.</p>}
      {proposals.length > 0 && (
        <ul className="suggest-list" aria-label="Proposed cuts" ref={listRef}>
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
              {previewing && previewCutId === cut.id ? (
                <button type="button" className="text-button" onClick={stopPreview} aria-label={`Stop preview of ${range(cut)}`}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => previewCut(cut)}
                  disabled={!isValidCut(clips, cut)}
                  aria-label={`Preview ${range(cut)}`}
                  title="Play from 2 s before this cut to 2 s after it, with the pause skipped"
                >
                  Preview
                </button>
              )}
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
          {previewing && <span role="status">{previewCutId ? "Previewing one cut." : "Previewing: press Play to hear the chosen cuts."}</span>}
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
