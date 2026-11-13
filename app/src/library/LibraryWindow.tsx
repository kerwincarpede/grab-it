import { useEffect, useRef, useState, type FormEvent } from "react";
import "./library.css";
import {
  PAGE_SIZE,
  deleteShot,
  formatCapturedAt,
  listShots,
  onLibraryChanged,
  openShot,
  parseTags,
  setShotNotes,
  setShotTags,
  shotThumbnail,
  type Shot,
} from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, index) => tag === b[index]);

/** A shot's thumbnail, fetched as bytes and shown through a blob URL. */
function Thumbnail({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    shotThumbnail(id)
      .then((bytes) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        created = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);

  if (url) return <img className="shot-thumb" src={url} alt="" draggable={false} />;
  return <div className="shot-thumb shot-thumb-empty">{failed ? "No preview" : ""}</div>;
}

interface DetailsProps {
  shot: Shot;
  onUpdated: (shot: Shot) => void;
  onDeleted: (id: number) => void;
  onError: (message: string) => void;
}

/** The selected shot: open, tag, annotate with notes or delete it. */
function ShotDetails({ shot, onUpdated, onDeleted, onError }: DetailsProps) {
  const [tagsText, setTagsText] = useState(shot.tags.join(", "));
  const [notes, setNotes] = useState(shot.notes);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function saveTags() {
    const tags = parseTags(tagsText);
    if (sameTags(tags, shot.tags)) return;
    try {
      const updated = await setShotTags(shot.id, tags);
      onUpdated(updated);
      setTagsText(updated.tags.join(", "));
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function saveNotes() {
    if (notes === shot.notes) return;
    try {
      onUpdated(await setShotNotes(shot.id, notes));
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function open() {
    try {
      await openShot(shot.id);
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteShot(shot.id);
      onDeleted(shot.id);
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
      setConfirming(false);
    }
  }

  function submitTags(event: FormEvent) {
    event.preventDefault();
    void saveTags();
  }

  const source = [shot.app, shot.windowTitle].filter(Boolean).join(" — ");

  return (
    <aside className="shot-details" aria-label="Capture details">
      <h2 title={shot.path}>{shot.fileName}</h2>
      <dl>
        <dt>Captured</dt>
        <dd>{formatCapturedAt(shot.capturedAt)}</dd>
        {source && (
          <>
            <dt>From</dt>
            <dd>{source}</dd>
          </>
        )}
        <dt>Size</dt>
        <dd>
          {shot.width} × {shot.height}
        </dd>
      </dl>
      <button type="button" onClick={() => void open()}>
        Open in editor
      </button>

      <form className="field" onSubmit={submitTags}>
        <label htmlFor="shot-tags">Tags</label>
        <input
          id="shot-tags"
          value={tagsText}
          placeholder="bug, design, receipts"
          onChange={(event) => setTagsText(event.target.value)}
          onBlur={() => void saveTags()}
        />
        <p className="hint">Separate tags with commas. Press Enter to save.</p>
      </form>

      <div className="field">
        <label htmlFor="shot-notes">Notes</label>
        <textarea
          id="shot-notes"
          rows={4}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => void saveNotes()}
        />
      </div>

      <div className="shot-delete">
        {confirming ? (
          <>
            <span>Delete this capture and its annotations?</span>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Delete permanently
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
    </aside>
  );
}

function LibraryWindow() {
  const [shots, setShots] = useState<Shot[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  // How many shots are shown, so a reload keeps every loaded page.
  const shownCount = useRef(PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    listShots(0, Math.max(PAGE_SIZE, shownCount.current))
      .then((page) => {
        if (cancelled) return;
        shownCount.current = Math.max(PAGE_SIZE, page.shots.length);
        setShots(page.shots);
        setTotal(page.total);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onLibraryChanged(() => setReloads((count) => count + 1))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Without events the Library still works; it just does not refresh itself.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await listShots(shots.length, PAGE_SIZE);
      shownCount.current = Math.max(PAGE_SIZE, shots.length + page.shots.length);
      setShots((current) => {
        const known = new Set(current.map((shot) => shot.id));
        return [...current, ...page.shots.filter((shot) => !known.has(shot.id))];
      });
      setTotal(page.total);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function updated(shot: Shot) {
    setError(null);
    setShots((current) => current.map((item) => (item.id === shot.id ? shot : item)));
  }

  function deleted(id: number) {
    setError(null);
    setShots((current) => current.filter((shot) => shot.id !== id));
    setTotal((count) => Math.max(0, count - 1));
    setSelectedId(null);
  }

  function open(id: number) {
    openShot(id).catch((err: unknown) => setError(errorMessage(err)));
  }

  const selected = shots.find((shot) => shot.id === selectedId) ?? null;

  return (
    <main className="library">
      <header className="library-header">
        <h1>Library</h1>
        {loaded && (
          <span className="hint">
            {total === 1 ? "1 capture" : `${total} captures`}
          </span>
        )}
      </header>
      {error && (
        <p role="alert" className="status status-error">
          {error}
        </p>
      )}
      <div className="library-body">
        <section className="library-grid-area" aria-label="Captures">
          {loaded && shots.length === 0 && (
            <p className="library-empty">No captures yet. Capture with a hotkey or from the tray menu.</p>
          )}
          <ul className="library-grid">
            {shots.map((shot) => (
              <li key={`${shot.id}:${shot.path}`}>
                <button
                  type="button"
                  className="shot-card"
                  aria-pressed={shot.id === selectedId}
                  aria-label={shot.fileName}
                  title="Double-click to open in the editor"
                  onClick={() => setSelectedId(shot.id)}
                  onDoubleClick={() => open(shot.id)}
                >
                  <Thumbnail id={shot.id} />
                  <span className="shot-caption">
                    <span className="shot-date">{formatCapturedAt(shot.capturedAt)}</span>
                    {shot.app && <span className="shot-app">{shot.app}</span>}
                  </span>
                  {shot.tags.length > 0 && (
                    <span className="shot-tags">
                      {shot.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {shots.length < total && (
            <button type="button" className="secondary library-more" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
        {selected && (
          <ShotDetails
            key={selected.id}
            shot={selected}
            onUpdated={updated}
            onDeleted={deleted}
            onError={setError}
          />
        )}
      </div>
    </main>
  );
}

export default LibraryWindow;
