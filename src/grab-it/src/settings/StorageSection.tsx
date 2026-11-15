import { useEffect, useState } from "react";
import Dialog from "../app/Dialog";
import {
  STORAGE_KINDS,
  formatSize,
  libraryStorage,
  onLibraryChanged,
  type LibraryStorage,
} from "../library/api";
import {
  KEEP_CHOICES,
  REMOVALS,
  keepPhrase,
  keepsLess,
  type Removal,
  type Retention,
  type RetentionKind,
} from "./api";

interface Props {
  saved: Retention;
  disabled: boolean;
  /** Saves the Keep settings and how items are removed; resolves to whether they were saved. */
  onSave: (retention: Retention) => Promise<boolean>;
}

/** A shorter Keep setting waiting for the user to confirm what it removes. */
interface Pending {
  kind: RetentionKind;
  days: number;
  count: number;
  bytes: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** The select's value for a Keep setting: "" is forever. */
const keepValue = (days: number | null) => (days === null ? "" : String(days));

/**
 * Settings › Storage: how long each kind of item is kept, with what it holds
 * and what is due, and how cleanup removes items. A shorter Keep setting
 * that would remove items asks first.
 */
function StorageSection({ saved, disabled, onSave }: Props) {
  /** Null until read, or when sizes cannot be read: the rows then leave them out. */
  const [storage, setStorage] = useState<LibraryStorage | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [asking, setAsking] = useState(false);
  const savedKey = JSON.stringify(saved);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      libraryStorage(JSON.parse(savedKey) as Retention)
        .then((found) => {
          if (!cancelled) setStorage(found);
        })
        .catch(() => {
          // Without sizes the Keep settings still work.
        });
    };
    load();
    let unlisten: (() => void) | undefined;
    onLibraryChanged(load)
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => {
        // Without events the sizes stay as they were read.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [savedKey]);

  async function changeKeep(kind: RetentionKind, days: number | null) {
    const next: Retention = { ...saved, [kind]: days };
    if (days === null || !keepsLess(saved[kind], days)) {
      await onSave(next);
      return;
    }
    setAsking(true);
    let due: { count: number; bytes: number } | null = null;
    try {
      due = (await libraryStorage(next)).due?.[kind] ?? null;
    } catch {
      // Cannot tell what it removes: ask without the numbers.
    } finally {
      setAsking(false);
    }
    if (due !== null && due.count === 0) {
      await onSave(next);
      return;
    }
    setPending({ kind, days, count: due?.count ?? 0, bytes: due?.bytes ?? 0 });
  }

  async function confirm() {
    if (!pending) return;
    const next: Retention = { ...saved, [pending.kind]: pending.days };
    setPending(null);
    await onSave(next);
  }

  const off = disabled || asking || pending !== null;
  const pendingKind = pending && STORAGE_KINDS.find((item) => item.kind === pending.kind);
  const removal = REMOVALS.find((choice) => choice.value === saved.removal) ?? REMOVALS[0];

  return (
    <>
      <section aria-labelledby="keep-heading">
        <h2 className="group-heading" id="keep-heading">
          Keep
        </h2>
        <div className="group">
          {STORAGE_KINDS.map(({ kind, name, one, many }) => {
            const kept = saved[kind];
            const days = pending?.kind === kind ? pending.days : kept;
            const usage = storage?.[kind];
            const due = storage?.due?.[kind];
            return (
              <div className="row" key={kind}>
                <span className="row-text">
                  <label className="row-title storage-kind" htmlFor={`keep-${kind}`}>
                    <i className="storage-swatch" style={{ background: `var(--kind-${kind})` }} aria-hidden="true" />
                    {name}
                  </label>
                  {usage && (
                    <span className="row-hint" data-testid={`keep-${kind}-hint`}>
                      {plural(usage.count, one, many)} · {formatSize(usage.bytes)} ·{" "}
                      {kept === null ? (
                        "never removed"
                      ) : due && due.count > 0 ? (
                        <b className="storage-due">
                          {formatSize(due.bytes)} older than {keepPhrase(kept)}
                        </b>
                      ) : (
                        `nothing older than ${keepPhrase(kept)}`
                      )}
                    </span>
                  )}
                </span>
                <select
                  id={`keep-${kind}`}
                  className="row-field"
                  value={keepValue(days)}
                  disabled={off}
                  onChange={(event) =>
                    void changeKeep(kind, event.target.value === "" ? null : Number(event.target.value))
                  }
                >
                  {KEEP_CHOICES.map((choice) => (
                    <option key={keepValue(choice.days)} value={keepValue(choice.days)}>
                      {choice.title}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </section>
      <section aria-labelledby="cleanup-heading">
        <h2 className="group-heading" id="cleanup-heading">
          Cleanup
        </h2>
        <div className="group">
          <div className="row">
            <span className="row-text">
              <label className="row-title" htmlFor="storage-removal">
                Remove items by
              </label>
              <span className="row-hint">{removal.hint}</span>
            </span>
            <select
              id="storage-removal"
              className="row-field"
              value={saved.removal}
              disabled={off}
              onChange={(event) => void onSave({ ...saved, removal: event.target.value as Removal })}
            >
              {REMOVALS.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.title}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="row-text">
              <span className="row-title">Automatic cleanup</span>
              <span className="row-hint">
                Runs when Grab-it starts and once a day. Starred, tagged, noted and annotated items are never removed.
              </span>
            </span>
          </div>
        </div>
      </section>
      {pending && pendingKind && (
        <Dialog
          title={`Keep ${pendingKind.many} for ${keepPhrase(pending.days)}?`}
          className="confirm-dialog"
          onClose={() => setPending(null)}
        >
          <p className="confirm-body">
            {pending.count > 0
              ? `${plural(pending.count, pendingKind.one, pendingKind.many)} (${formatSize(pending.bytes)}) ${pending.count === 1 ? "is" : "are"} older and will be `
              : `${pendingKind.name} older than ${keepPhrase(pending.days)} will be `}
            {saved.removal === "permanent" ? "deleted permanently" : "moved to the Trash"} at the next cleanup.
          </p>
          <footer className="dialog-foot">
            <button type="button" className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" data-autofocus onClick={() => void confirm()}>
              Keep for {keepPhrase(pending.days)}
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

export default StorageSection;
