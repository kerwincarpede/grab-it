import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./library.css";
import {
  FIELD_LABELS,
  NO_FILTERS,
  PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  buildQuery,
  deleteShot,
  filterOptions,
  formatCapturedAt,
  isSearching,
  listShots,
  ocrStatus,
  onLibraryChanged,
  onOcrStatus,
  openShot,
  parseTags,
  retryOcr,
  searchShots,
  setShotNotes,
  setShotTags,
  shotThumbnail,
  type FilterOptions,
  type Filters,
  type OcrStatus,
  type SearchHit,
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

/** Where the search words were found in a result, matches highlighted. */
function Snippet({ hit }: { hit: SearchHit }) {
  if (!hit.field || hit.snippet.length === 0) return null;
  return (
    <span className="shot-snippet">
      <span className="shot-snippet-field">{FIELD_LABELS[hit.field]}: </span>
      {hit.snippet.map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </span>
  );
}

/** Model download progress and the OCR queue, while there is something to say. */
function OcrBanner({ status, onRetry }: { status: OcrStatus; onRetry: () => void }) {
  switch (status.state) {
    case "downloading": {
      const percent = status.total > 0 ? Math.floor((status.downloaded * 100) / status.total) : 0;
      return (
        <div className="ocr-status" role="status">
          <span>Downloading text recognition models… {percent}%</span>
          <progress aria-label="Model download" max={status.total} value={status.downloaded} />
        </div>
      );
    }
    case "working":
      return (
        <div className="ocr-status" role="status">
          Reading text in {status.pending === 1 ? "1 capture" : `${status.pending} captures`}…
        </div>
      );
    case "failed":
      return (
        <div className="ocr-status ocr-status-error" role="status">
          <span>{status.message}</span>
          <button type="button" className="secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** Keeps the current choice listed even if no capture has it any more. */
function withCurrent(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [current, ...values] : values;
}

interface SearchBarProps {
  text: string;
  filters: Filters;
  options: FilterOptions;
  active: boolean;
  onText: (text: string) => void;
  onSubmit: () => void;
  onFilters: (filters: Filters) => void;
  onClear: () => void;
}

/** The search box and filter bar. */
function SearchBar({ text, filters, options, active, onText, onSubmit, onFilters, onClear }: SearchBarProps) {
  const set = (change: Partial<Filters>) => onFilters({ ...filters, ...change });
  return (
    <div className="library-search" role="search">
      <input
        type="search"
        className="library-search-box"
        aria-label="Search captures"
        placeholder="Search text in images, tags, notes, apps and windows"
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
      />
      <div className="library-filters">
        <select aria-label="Filter by app" value={filters.app} onChange={(event) => set({ app: event.target.value })}>
          <option value="">All apps</option>
          {withCurrent(options.apps, filters.app).map((app) => (
            <option key={app} value={app}>
              {app}
            </option>
          ))}
        </select>
        <select aria-label="Filter by tag" value={filters.tag} onChange={(event) => set({ tag: event.target.value })}>
          <option value="">All tags</option>
          {withCurrent(options.tags, filters.tag).map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <label className="library-date">
          From
          <input
            type="date"
            aria-label="Captured from"
            value={filters.fromDate}
            max={filters.toDate || undefined}
            onChange={(event) => set({ fromDate: event.target.value })}
          />
        </label>
        <label className="library-date">
          To
          <input
            type="date"
            aria-label="Captured to"
            value={filters.toDate}
            min={filters.fromDate || undefined}
            onChange={(event) => set({ toDate: event.target.value })}
          />
        </label>
        {active && (
          <button type="button" className="secondary" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
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

function byShot(hits: SearchHit[]): Record<number, SearchHit> {
  const found: Record<number, SearchHit> = {};
  for (const hit of hits) found[hit.shot.id] = hit;
  return found;
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
  // The search box as typed, and as searched once typing pauses.
  const [text, setText] = useState("");
  const [searchedText, setSearchedText] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [options, setOptions] = useState<FilterOptions>({ apps: [], tags: [] });
  const [optionReloads, setOptionReloads] = useState(0);
  // Where each result matched, by shot id; empty when not searching.
  const [hits, setHits] = useState<Record<number, SearchHit>>({});
  const [ocr, setOcr] = useState<OcrStatus>({ state: "idle" });
  const query = useMemo(() => buildQuery(searchedText, filters), [searchedText, filters]);
  const searching = isSearching(query);
  const lastQuery = useRef("");

  useEffect(() => {
    const timer = setTimeout(() => setSearchedText(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    // A new search starts again from one page; a reload keeps what is shown.
    const key = JSON.stringify(query);
    if (lastQuery.current !== key) {
      lastQuery.current = key;
      shownCount.current = PAGE_SIZE;
    }
    const limit = Math.max(PAGE_SIZE, shownCount.current);
    const request = isSearching(query)
      ? searchShots(query, 0, limit).then((page) => ({
          shots: page.hits.map((hit) => hit.shot),
          total: page.total,
          hits: page.hits,
        }))
      : listShots(0, limit).then((page) => ({ shots: page.shots, total: page.total, hits: [] as SearchHit[] }));
    request
      .then((page) => {
        if (cancelled) return;
        shownCount.current = Math.max(PAGE_SIZE, page.shots.length);
        setShots(page.shots);
        setTotal(page.total);
        setHits(byShot(page.hits));
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads, query]);

  useEffect(() => {
    let cancelled = false;
    filterOptions()
      .then((found) => {
        if (!cancelled) setOptions(found);
      })
      .catch(() => {
        // The filters still offer what is selected.
      });
    return () => {
      cancelled = true;
    };
  }, [reloads, optionReloads]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    ocrStatus()
      .then((status) => {
        if (!cancelled) setOcr(status);
      })
      .catch(() => {
        // Without a status the Library just shows no OCR progress.
      });
    onOcrStatus(setOcr)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // As above: no live OCR progress.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
      const page = searching
        ? await searchShots(query, shots.length, PAGE_SIZE).then((found) => ({
            shots: found.hits.map((hit) => hit.shot),
            total: found.total,
            hits: found.hits,
          }))
        : await listShots(shots.length, PAGE_SIZE).then((found) => ({ ...found, hits: [] as SearchHit[] }));
      shownCount.current = Math.max(PAGE_SIZE, shots.length + page.shots.length);
      setShots((current) => {
        const known = new Set(current.map((shot) => shot.id));
        return [...current, ...page.shots.filter((shot) => !known.has(shot.id))];
      });
      setHits((current) => ({ ...current, ...byShot(page.hits) }));
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
    // Its tags may be new to the tag filter.
    setOptionReloads((count) => count + 1);
  }

  function retry() {
    setOcr({ state: "idle" });
    retryOcr().catch((err: unknown) => setError(errorMessage(err)));
  }

  function clearSearch() {
    setText("");
    setSearchedText("");
    setFilters(NO_FILTERS);
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
            {searching
              ? total === 1
                ? "1 result"
                : `${total} results`
              : total === 1
                ? "1 capture"
                : `${total} captures`}
          </span>
        )}
      </header>
      <SearchBar
        text={text}
        filters={filters}
        options={options}
        active={searching || text.length > 0}
        onText={setText}
        onSubmit={() => setSearchedText(text)}
        onFilters={setFilters}
        onClear={clearSearch}
      />
      <OcrBanner status={ocr} onRetry={retry} />
      {error && (
        <p role="alert" className="status status-error">
          {error}
        </p>
      )}
      <div className="library-body">
        <section className="library-grid-area" aria-label="Captures">
          {loaded && shots.length === 0 && (
            <p className="library-empty">
              {searching
                ? "No captures match. Try fewer words or other filters."
                : "No captures yet. Capture with a hotkey or from the tray menu."}
            </p>
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
                  {hits[shot.id] && <Snippet hit={hits[shot.id]} />}
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
