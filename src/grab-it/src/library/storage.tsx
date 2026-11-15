import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  STORAGE_KINDS,
  cleanUp,
  dueTotal,
  formatSize,
  libraryStorage,
  onCleanupDone,
  onCleanupProgress,
  stopCleanUp,
  storageTotal,
  type Cleaned,
  type CleanupProgress,
  type LibraryStorage,
  type ShotKind,
} from "./api";
import { useOutsideClick } from "./useOutsideClick";
import Dialog from "../app/Dialog";
import { getSettings, type Removal } from "../settings/api";

const kindColor = (kind: ShotKind) => `var(--kind-${kind})`;

/** "7%": a share of `total`, rounded. */
function share(part: number, total: number): string {
  return `${total > 0 ? Math.round((part / total) * 100) : 0}%`;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

interface RingProps {
  storage: LibraryStorage;
  /** The viewBox's width and height. */
  size: number;
  radius: number;
  width: number;
  /** The space left between arcs. */
  gap: number;
  /** Stripe the end of each arc as long as its kind's share due for cleanup. */
  striped?: boolean;
  className?: string;
  onArcEnter?: (kind: ShotKind, event: MouseEvent<SVGCircleElement>) => void;
  onArcLeave?: () => void;
}

interface Arc {
  kind: ShotKind;
  /** Where the arc starts along the ring. */
  start: number;
  length: number;
  /** How much of its end is due for cleanup. */
  due: number;
}

/** One arc per kind with any size, each as long as its share of the library. */
function ringArcs(storage: LibraryStorage, circumference: number, gap: number): Arc[] {
  const total = storageTotal(storage);
  const parts = STORAGE_KINDS.filter(({ kind }) => storage[kind].bytes > 0);
  const shares = parts.map(({ kind }) => (storage[kind].bytes / total) * circumference);
  return parts.map(({ kind }, index) => {
    const length = Math.max(shares[index] - (parts.length > 1 ? gap : 0), 0.5);
    const due = Math.min(((storage.due?.[kind].bytes ?? 0) / total) * circumference, length);
    return { kind, start: shares.slice(0, index).reduce((sum, share) => sum + share, 0), length, due };
  });
}

/** A ring with one arc per kind, as long as its share of the library. */
function Ring({ storage, size, radius, width, gap, striped = false, className, onArcEnter, onArcLeave }: RingProps) {
  // Pattern ids must be unique on the page and plain enough for url(#…).
  const hatch = `storage-hatch-${useId().replace(/[^\w-]/g, "")}`;
  const circumference = 2 * Math.PI * radius;
  const centre = size / 2;
  const ring = { cx: centre, cy: centre, r: radius, fill: "none", strokeWidth: width, transform: `rotate(-90 ${centre} ${centre})` };
  return (
    <svg className={className} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      {striped && (
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="storage-hatch" width="3" height="6" />
          </pattern>
        </defs>
      )}
      <circle className="storage-track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={width} />
      {ringArcs(storage, circumference, gap).map(({ kind, start, length, due }) => (
        <g key={kind}>
          <circle
            className="storage-arc"
            data-kind={kind}
            {...ring}
            strokeDasharray={`${length} ${circumference}`}
            strokeDashoffset={-start}
            style={{ stroke: kindColor(kind) }}
            onMouseEnter={onArcEnter && ((event) => onArcEnter(kind, event))}
            onMouseMove={onArcEnter && ((event) => onArcEnter(kind, event))}
            onMouseLeave={onArcLeave}
          />
          {striped && due > 0.5 && (
            <circle
              className="storage-arc-due"
              data-kind={kind}
              {...ring}
              stroke={`url(#${hatch})`}
              strokeDasharray={`${due} ${circumference}`}
              strokeDashoffset={-(start + length - due)}
              pointerEvents="none"
            />
          )}
        </g>
      ))}
    </svg>
  );
}

/** The donut in the popover, with the total in its middle and a tooltip per arc. */
function Donut({ storage }: { storage: LibraryStorage }) {
  const [tip, setTip] = useState<{ kind: ShotKind; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const total = storageTotal(storage);
  const label = STORAGE_KINDS.map(({ kind, name }) => `${name} ${formatSize(storage[kind].bytes)}`).join(", ");
  const tipKind = tip && STORAGE_KINDS.find(({ kind }) => kind === tip.kind);
  return (
    <div className="storage-donut" ref={box} role="img" aria-label={`Storage by type: ${label}`}>
      <Ring
        storage={storage}
        size={136}
        radius={56}
        width={16}
        gap={3}
        striped
        onArcEnter={(kind, event) => {
          const rect = box.current?.getBoundingClientRect();
          setTip({ kind, x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
        }}
        onArcLeave={() => setTip(null)}
      />
      <div className="storage-donut-centre">
        <b>{formatSize(total)}</b>
        <span>used</span>
      </div>
      {tip && tipKind && (
        <div className="storage-tip" role="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <b>
            {tipKind.name} · {formatSize(storage[tip.kind].bytes)}
          </b>
          <span>
            {plural(storage[tip.kind].count, tipKind.one, tipKind.many)} · {share(storage[tip.kind].bytes, total)} of
            the library
          </span>
          {(storage.due?.[tip.kind].bytes ?? 0) > 0 && (
            <span>{formatSize(storage.due?.[tip.kind].bytes ?? 0)} due for cleanup</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The save folder's disk: the library's kinds, then everything else on it. */
function DiskMeter({ storage }: { storage: LibraryStorage }) {
  const { disk } = storage;
  if (!disk || disk.total <= 0) return null;
  const total = storageTotal(storage);
  const other = Math.max(0, disk.total - disk.free - total);
  const parts = [
    ...STORAGE_KINDS.map(({ kind, name }) => ({ key: kind, name, bytes: storage[kind].bytes, color: kindColor(kind) })),
    { key: "other", name: "Other files", bytes: other, color: "var(--storage-other)" },
  ].filter((part) => part.bytes > 0);
  return (
    <div className="storage-disk">
      <div className="storage-disk-top">
        <span>This disk</span>
        <span>
          <b>{formatSize(total)}</b> of {formatSize(disk.total)} · {formatSize(disk.free)} free
        </span>
      </div>
      <div
        className="storage-meter"
        role="meter"
        aria-label="Grab-it's share of this disk"
        aria-valuemin={0}
        aria-valuemax={disk.total}
        aria-valuenow={total}
        aria-valuetext={`${formatSize(total)} of ${formatSize(disk.total)}, ${formatSize(disk.free)} free`}
      >
        {parts.map((part) => (
          <i
            key={part.key}
            title={`${part.name} · ${formatSize(part.bytes)}`}
            style={{ width: `${Math.max((part.bytes / disk.total) * 100, 0.8)}%`, background: part.color }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The running cleanup's progress, automatic or from the Clean up dialog,
 * from its events; null while none runs.
 */
function useCleanupProgress(): CleanupProgress | null {
  const [progress, setProgress] = useState<CleanupProgress | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stops: UnlistenFn[] = [];
    const keep = (listening: Promise<UnlistenFn>) =>
      listening
        .then((stop) => (cancelled ? stop() : stops.push(stop)))
        .catch(() => {
          // Without events there is no progress to show.
        });
    void keep(onCleanupProgress(setProgress));
    void keep(onCleanupDone(() => setProgress(null)));
    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
    };
  }, []);
  return progress;
}

/** A thin bar filling as a cleanup goes through its items. */
function CleanupBar({ progress, label }: { progress: CleanupProgress; label: string }) {
  const filled = progress.total > 0 ? Math.min(progress.done / progress.total, 1) : 0;
  return (
    <div
      className="cleanup-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <i style={{ width: `${filled * 100}%` }} />
    </div>
  );
}

function stopRunning() {
  stopCleanUp().catch(() => {
    // It ends by itself; there is nothing more to do.
  });
}

/**
 * The popover's footer: an automatic cleanup's progress while one runs,
 * otherwise what Clean up would free. Older backends that do not say what
 * is due leave it out.
 */
function StorageFoot({ storage, progress, onCleanUp }: { storage: LibraryStorage; progress: CleanupProgress | null; onCleanUp: () => void }) {
  if (progress) {
    return (
      <div className="storage-foot is-running">
        <div className="storage-foot-top">
          <b>
            Cleaning up · {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
          </b>
          <span>{formatSize(progress.bytes)} removed</span>
        </div>
        <CleanupBar progress={progress} label="Cleanup progress" />
        <div className="storage-foot-actions">
          <button type="button" className="btn btn-small" onClick={stopRunning}>
            Stop
          </button>
        </div>
      </div>
    );
  }
  const due = dueTotal(storage);
  if (!due) return null;
  return (
    <div className="storage-foot">
      <span className="storage-foot-text">
        {due.count > 0 ? (
          <>
            Cleanup frees <b>{formatSize(due.bytes)}</b> · {plural(due.count, "item", "items")}
          </>
        ) : (
          "Nothing is older than your Keep settings"
        )}
      </span>
      <button type="button" className="btn btn-primary btn-small" disabled={due.count === 0} onClick={onCleanUp}>
        Clean up
      </button>
    </div>
  );
}

interface StoragePillProps {
  /** How many items the Library lists. */
  count: number;
  /** Changes whenever the library may have changed, to measure it again. */
  version: number;
  /** Opens the Clean up dialog, which reads what is due afresh. */
  onCleanUp: () => void;
  /** Opens Settings on its Storage page. */
  onOpenSettings: () => void;
}

/**
 * The count of items and their size, with a small ring by kind, that opens
 * the Storage popover. Until the size is known, or when it cannot be read,
 * just the count.
 */
export function StoragePill({ count, version, onCleanUp, onOpenSettings }: StoragePillProps) {
  const [storage, setStorage] = useState<LibraryStorage | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  const progress = useCleanupProgress();
  useOutsideClick(root, open, close);

  useEffect(() => {
    let cancelled = false;
    libraryStorage()
      .then((found) => {
        if (!cancelled) setStorage(found);
      })
      .catch(() => {
        // Without sizes the pill still says how many items there are.
      });
    return () => {
      cancelled = true;
    };
    // Measured again on opening too: Keep settings may have changed, or items
    // aged past them, since the library last changed.
  }, [version, open]);

  const countText = count === 1 ? "1 capture" : `${count} captures`;
  if (!storage) return <span className="count-pill">{countText}</span>;
  const total = storageTotal(storage);

  /** Closes the popover, handing focus back to the pill for when what it opens closes. */
  function leave(then: () => void) {
    setOpen(false);
    button.current?.focus();
    then();
  }

  return (
    <div
      className="storage-menu"
      ref={root}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="storage-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Ring className="storage-ring-mini" storage={storage} size={16} radius={6} width={3} gap={1} />
        <span>{countText}</span>
        <span aria-hidden="true">·</span>
        <b>{formatSize(total)}</b>
      </button>
      {open && (
        <div className="popover storage-popover" role="dialog" aria-label="Storage">
          <div className="storage-head">
            <h2>Storage</h2>
            <button type="button" className="link-button storage-settings-link" onClick={() => leave(onOpenSettings)}>
              Storage settings…
            </button>
          </div>
          <div className="storage-body">
            <Donut storage={storage} />
            <ul className="storage-legend" aria-label="Storage by type">
              {STORAGE_KINDS.map(({ kind, name, one, many }) => {
                const due = storage.due?.[kind].bytes ?? 0;
                return (
                  <li key={kind} className="storage-legend-row">
                    <i className="storage-dot" style={{ background: kindColor(kind) }} aria-hidden="true" />
                    <span className="storage-legend-name">{name}</span>
                    <span className="storage-legend-size">{formatSize(storage[kind].bytes)}</span>
                    <span className="storage-legend-sub">
                      {plural(storage[kind].count, one, many)} · {share(storage[kind].bytes, total)}
                      {due > 0 && <em> · {formatSize(due)} due</em>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <DiskMeter storage={storage} />
          <StorageFoot storage={storage} progress={progress} onCleanUp={() => leave(onCleanUp)} />
        </div>
      )}
    </div>
  );
}

const REMOVAL_CHOICES: { value: Removal; title: string; hint: string }[] = [
  { value: "trash", title: "Move to Trash", hint: "You can restore them. Space is freed when you empty the Trash." },
  { value: "permanent", title: "Delete permanently", hint: "Frees the space now. This can't be undone." },
];

type Step = "choose" | "confirm" | "running" | "done";

/** How a finished cleanup went. */
interface Outcome {
  cleaned: Cleaned;
  removal: Removal;
  /** Due items still in the library because Stop ended the run early. */
  left: number;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Cleanup failed.";
}

interface CleanUpDialogProps {
  onClose: () => void;
}

const NOTHING_DUE = { count: 0, bytes: 0 };

/**
 * Clean up: asks whether to move what is due to the Trash or delete it for
 * good (Settings' choice first), asks again before deleting for good, then
 * shows progress with Stop, and what went.
 */
export function CleanUpDialog({ onClose }: CleanUpDialogProps) {
  /** What is due, read when the dialog opens and again after a failed run; null until read. */
  const [storage, setStorage] = useState<LibraryStorage | null>(null);
  const due = (storage && dueTotal(storage)) ?? NOTHING_DUE;
  const [saved, setSaved] = useState<Removal | null>(null);
  const [picked, setPicked] = useState<Removal | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const [running, setRunning] = useState<Removal>("trash");
  const [stopping, setStopping] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useCleanupProgress();
  const latest = useRef<CleanupProgress | null>(null);
  const stopAsked = useRef(false);
  const alive = useRef(true);
  const body = useRef<HTMLDivElement>(null);
  const removal = picked ?? saved ?? "trash";

  useEffect(() => {
    if (live) latest.current = live;
  }, [live]);

  /** Reads what is due again, after a run that failed or found more due than shown. */
  async function measure() {
    try {
      const found = await libraryStorage();
      if (alive.current) setStorage(found);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    }
  }

  useEffect(() => {
    alive.current = true;
    libraryStorage()
      .then((found) => {
        if (alive.current) setStorage(found);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(errorMessage(err));
      });
    getSettings()
      .then((settings) => {
        if (alive.current) setSaved(settings?.retention?.removal ?? "trash");
      })
      .catch(() => {
        // Moving to the Trash is chosen until the user picks.
      });
    return () => {
      alive.current = false;
    };
  }, []);

  // Each step puts focus on its own first action.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  async function start(how: Removal) {
    setRunning(how);
    setStep("running");
    setError(null);
    setStopping(false);
    stopAsked.current = false;
    latest.current = null;
    try {
      // The backend removes nothing when more is due than this.
      const cleaned = await cleanUp(how, due);
      if (!alive.current) return;
      // Set by progress events while it ran, which TypeScript cannot see.
      const last = latest.current as CleanupProgress | null;
      const total = last?.total ?? due.count;
      setOutcome({ cleaned, removal: how, left: stopAsked.current ? Math.max(0, total - cleaned.count) : 0 });
      setStep("done");
    } catch (err) {
      if (!alive.current) return;
      setError(errorMessage(err));
      setStep("choose");
      // Show what is due now before the user confirms again.
      await measure();
    }
  }

  function askStop() {
    stopAsked.current = true;
    setStopping(true);
    stopRunning();
  }

  const items = plural(due.count, "item", "items");
  const progress = live ?? { done: 0, total: due.count, bytes: 0 };
  const title =
    step === "choose"
      ? "Clean up storage"
      : step === "confirm"
        ? `Delete ${items} permanently?`
        : step === "running"
          ? running === "trash"
            ? "Moving to the Trash…"
            : "Deleting permanently…"
          : outcome && outcome.left > 0
            ? "Stopped"
            : "Cleanup done";

  return (
    <Dialog
      title={title}
      className={`clean-up-dialog is-${step}`}
      // A running cleanup finishes or stops first.
      onClose={step === "running" ? () => {} : onClose}
    >
      <div className="clean-up-body" ref={body}>
        {step === "choose" && (
          <>
            <p className="clean-up-text">
              {storage
                ? `${items} (${formatSize(due.bytes)}) ${due.count === 1 ? "is" : "are"} older than your Keep settings.`
                : "Checking what is older than your Keep settings…"}
            </p>
            <ul className="clean-up-kinds" aria-label="Due for cleanup">
              {STORAGE_KINDS.filter(({ kind }) => (storage?.due?.[kind].count ?? 0) > 0).map(({ kind, one, many }) => (
                <li key={kind}>
                  <i className="storage-dot" style={{ background: kindColor(kind) }} aria-hidden="true" />
                  <span>{plural(storage?.due?.[kind].count ?? 0, one, many)}</span>
                  <span className="clean-up-kind-size">{formatSize(storage?.due?.[kind].bytes ?? 0)}</span>
                </li>
              ))}
            </ul>
            <fieldset className="clean-up-choices">
              <legend className="visually-hidden">How to remove them</legend>
              {REMOVAL_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className={`clean-up-choice${removal === choice.value ? " is-on" : ""}${choice.value === "permanent" ? " is-danger" : ""}`}
                >
                  <input
                    type="radio"
                    name="clean-up-removal"
                    value={choice.value}
                    checked={removal === choice.value}
                    onChange={() => setPicked(choice.value)}
                  />
                  <span>
                    <span className="clean-up-choice-title">{choice.title}</span>
                    <span className="clean-up-choice-hint">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error && (
              <p role="alert" className="clean-up-error">
                {error}
              </p>
            )}
            <div className="clean-up-actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                disabled={due.count === 0}
                onClick={() => (removal === "trash" ? void start("trash") : setStep("confirm"))}
              >
                {removal === "trash" ? "Move to Trash" : "Continue…"}
              </button>
            </div>
          </>
        )}
        {step === "confirm" && (
          <>
            <p className="clean-up-text">
              {formatSize(due.bytes)} will be deleted from this computer. They won't go to the Trash, and this can't be
              undone.
            </p>
            <div className="clean-up-actions">
              <button type="button" className="btn" data-autofocus onClick={() => setStep("choose")}>
                Back
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void start("permanent")}>
                Delete permanently
              </button>
            </div>
          </>
        )}
        {step === "running" && (
          <>
            <p className="clean-up-text">
              {progress.done.toLocaleString()} of {plural(progress.total, "item", "items")} · {formatSize(progress.bytes)}{" "}
              of {formatSize(due.bytes)}
            </p>
            <CleanupBar progress={progress} label="Cleanup progress" />
            <div className="clean-up-actions">
              <button type="button" className="btn" data-autofocus disabled={stopping} onClick={askStop}>
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </div>
          </>
        )}
        {step === "done" && outcome && (
          <>
            <p className="clean-up-text">
              {plural(outcome.cleaned.count, "item", "items")}{" "}
              {outcome.removal === "trash" ? "moved to the Trash" : "deleted"} · {formatSize(outcome.cleaned.bytes)}
              {outcome.removal === "permanent" && " freed"}
              {outcome.left > 0 && ` · ${outcome.left.toLocaleString()} left`}
            </p>
            <div className="clean-up-actions">
              <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
