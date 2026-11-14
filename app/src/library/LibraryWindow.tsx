import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./library.css";
import {
  CLI_NAMES,
  DATE_PRESETS,
  FIELD_LABELS,
  NO_FILTERS,
  PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  aiStatus,
  buildQuery,
  categoryLabel,
  clearAiDescription,
  copyShot,
  dayLabel,
  deleteShot,
  dismissAiNotice,
  filterOptions,
  formatCapturedAt,
  formatTime,
  allTags,
  groupByDay,
  isSearching,
  listShots,
  ocrStatus,
  onAiStatus,
  onLibraryChanged,
  onOcrStatus,
  openSettings,
  openShot,
  pendingAiNotice,
  pinShot,
  redescribeShot,
  retryOcr,
  revealShot,
  searchShots,
  setShotNotes,
  removeAiTag,
  setShotTags,
  type AiStatus,
  type CliProvider,
  type FilterOptions,
  type Filters,
  type OcrStatus,
  type SearchHit,
  type Shot,
} from "./api";
import { ChipSelect, DateChip, FilterMenu, TagEditor } from "./controls";
import {
  AppIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  GridLargeIcon,
  GridSmallIcon,
  ImageIcon,
  PinIcon,
  LayersIcon,
  SearchIcon,
  SparkleIcon,
  TagIcon,
  TrashIcon,
} from "./icons";
import { useInView, useThumbnail } from "./thumbnails";
import { ChevronDownIcon, ChevronUpIcon } from "../app/icons";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, index) => tag === b[index]);

/** Cache key for a shot's thumbnail: a re-saved file gets a fresh one. */
const thumbKey = (shot: Shot) => `${shot.id}:${shot.path}`;

const ROW_HEIGHT_KEY = "grab-it.library.rowHeight";
const ROW_HEIGHT = { min: 120, max: 340, initial: 200 };

function readRowHeight(): number {
  try {
    const saved = Number(localStorage.getItem(ROW_HEIGHT_KEY));
    if (saved >= ROW_HEIGHT.min && saved <= ROW_HEIGHT.max) return saved;
  } catch {
    // Storage may be unavailable; use the default.
  }
  return ROW_HEIGHT.initial;
}

/** A shot's thumbnail, fetched only once it nears the viewport. */
function Thumbnail({ shot, className = "" }: { shot: Shot; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref);
  const { url, failed } = useThumbnail(shot.id, thumbKey(shot), near);
  const [shown, setShown] = useState(false);
  return (
    <div ref={ref} className={`thumb ${className}${url && shown ? " is-loaded" : ""}`}>
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" onLoad={() => setShown(true)} />
      ) : failed ? (
        <span className="thumb-failed">
          <ImageIcon />
          No preview
        </span>
      ) : null}
    </div>
  );
}

/** Where the search words were found in a result, matches highlighted. */
function Snippet({ hit }: { hit: SearchHit }) {
  if (!hit.field || hit.snippet.length === 0) return null;
  return (
    <span className="tile-snippet">
      <span className="tile-snippet-field">{FIELD_LABELS[hit.field]}: </span>
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
          <span className="spinner" aria-hidden="true" />
          <span>Downloading text recognition models… {percent}%</span>
          <progress aria-label="Model download" max={status.total} value={status.downloaded} />
        </div>
      );
    }
    case "working":
      return (
        <div className="ocr-status" role="status">
          <span className="spinner" aria-hidden="true" />
          Reading text in {status.pending === 1 ? "1 capture" : `${status.pending} captures`}…
        </div>
      );
    case "failed":
      return (
        <div className="ocr-status ocr-status-error" role="status">
          <span>{status.message}</span>
          <button type="button" className="pill-button" onClick={onRetry}>
            Retry
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** The command each CLI provider runs, for the user to try in a terminal. */
const CLI_COMMANDS: Record<CliProvider, string> = { claudeCode: "claude", codex: "codex" };

/** The AI describer's progress, or why it stopped, while there is something to say. */
function AiBanner({ status, onSettings }: { status: AiStatus; onSettings: () => void }) {
  if (status.state === "working") {
    const current = Math.min(status.done + 1, status.total);
    return (
      <div className="ocr-status ai-status" role="status">
        <SparkleIcon />
        <span>{status.total > 0 ? `Describing ${current} of ${status.total}…` : "Describing captures…"}</span>
        {status.total > 0 && <progress aria-label="Descriptions" max={status.total} value={status.done} />}
      </div>
    );
  }
  if (status.state === "error") {
    return (
      <div className="ocr-status ocr-status-error ai-status" role="status">
        <span>Could not describe captures{status.error ? `: ${status.error}` : "."}</span>
        <span className="hint">
          {status.provider === "claudeCode" || status.provider === "codex"
            ? `Is ${CLI_NAMES[status.provider]} installed and signed in? Run ${CLI_COMMANDS[status.provider]} in a terminal to check, or choose another provider in Settings.`
            : "Is the AI endpoint running? Check its URL and model in Settings."}
        </span>
        <button type="button" className="pill-button" onClick={onSettings}>
          Open Settings
        </button>
      </div>
    );
  }
  return null;
}

/** Where each CLI provider sends screenshots, for the notice. */
const CLI_DESTINATIONS: Record<CliProvider, string> = {
  claudeCode: "Anthropic under your Claude account",
  codex: "OpenAI under your ChatGPT or OpenAI account",
};

/** Says once that Grab-it turned on AI descriptions with `provider`, until dismissed. */
function AiNotice({
  provider,
  onSettings,
  onDismiss,
}: {
  provider: CliProvider;
  onSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="ocr-status ai-status ai-notice" role="status">
      <SparkleIcon />
      <span>
        {CLI_NAMES[provider]} now describes your new captures, so you can search for what they show. Their screenshots
        go to {CLI_DESTINATIONS[provider]}.
      </span>
      <button type="button" className="pill-button" onClick={onSettings}>
        Open Settings
      </button>
      <button type="button" className="error-dismiss" aria-label="Dismiss AI notice" onClick={onDismiss}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

/** The capture's AI category as a small chip. */
function CategoryChip({ category }: { category: string }) {
  return <span className="category-chip">{categoryLabel(category)}</span>;
}

interface ToolbarProps {
  text: string;
  filters: Filters;
  options: FilterOptions;
  active: boolean;
  rowHeight: number;
  onFilters: (filters: Filters) => void;
  onClear: () => void;
  onRowHeight: (height: number) => void;
  /** The app filter lives elsewhere (the Grab-it window's sidebar). */
  hideAppFilter?: boolean;
  /** What "today" is for the time switch. */
  now: number;
}

/** The date presets on the time switch, with their short names; the Filter menu has the rest. */
const QUICK_DATES: { id: string; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
];

interface SearchFieldProps {
  text: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onText: (text: string) => void;
  onSubmit: () => void;
}

function SearchField({ text, searchRef, onText, onSubmit }: SearchFieldProps) {
  return (
    <div className="search-field" role="search">
      <SearchIcon />
      <input
        ref={searchRef}
        type="search"
        aria-label="Search captures"
        placeholder="Search text, tags, notes"
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape" && text) {
            event.stopPropagation();
            onText("");
          }
        }}
      />
      {text ? (
        <button type="button" className="search-clear" aria-label="Clear search text" onClick={() => onText("")}>
          <CloseIcon size={13} />
        </button>
      ) : (
        <kbd aria-hidden="true">/</kbd>
      )}
    </div>
  );
}

/** The time switch, one Filter menu for the rest, and the thumbnail size. */
function Toolbar(props: ToolbarProps) {
  const { filters, options, active, rowHeight, now } = props;
  const set = (change: Partial<Filters>) => props.onFilters({ ...filters, ...change });
  const ranges = QUICK_DATES.map((quick) => ({
    ...quick,
    range: DATE_PRESETS.find((preset) => preset.id === quick.id)!.range(now),
  }));
  const anyTime = !filters.fromDate && !filters.toDate;
  const quickOn = ranges.some(({ range }) => range.fromDate === filters.fromDate && range.toDate === filters.toDate);
  const count =
    (!props.hideAppFilter && filters.app ? 1 : 0) +
    (filters.tag ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (!anyTime && !quickOn ? 1 : 0);
  return (
    <div className="toolbar" role="group" aria-label="Filter bar">
      <div className="segmented-bar">
        <button type="button" aria-pressed={anyTime} onClick={() => set({ fromDate: "", toDate: "" })}>
          Any time
        </button>
        {ranges.map(({ id, label, range }) => (
          <button
            key={id}
            type="button"
            aria-pressed={range.fromDate === filters.fromDate && range.toDate === filters.toDate}
            onClick={() => set(range)}
          >
            {label}
          </button>
        ))}
      </div>
      <FilterMenu count={count}>
        {!props.hideAppFilter && (
          <div className="filter-row">
            <span className="filter-label">App</span>
            <ChipSelect
              label="Filter by app"
              icon={<AppIcon />}
              allLabel="All apps"
              value={filters.app}
              options={options.apps}
              onChange={(app) => set({ app })}
            />
          </div>
        )}
        <div className="filter-row">
          <span className="filter-label">Tag</span>
          <ChipSelect
            label="Filter by tag"
            icon={<TagIcon />}
            allLabel="All tags"
            value={filters.tag}
            options={options.tags}
            onChange={(tag) => set({ tag })}
          />
        </div>
        <div className="filter-row">
          <span className="filter-label">Category</span>
          <ChipSelect
            label="Filter by category"
            icon={<LayersIcon />}
            allLabel="All categories"
            value={filters.category}
            options={options.categories ?? []}
            format={categoryLabel}
            onChange={(category) => set({ category })}
          />
        </div>
        <div className="filter-row">
          <span className="filter-label">Dates</span>
          <DateChip
            fromDate={filters.fromDate}
            toDate={filters.toDate}
            idleLabel="Any dates"
            quickPresets={QUICK_DATES.map((preset) => preset.id)}
            onChange={(range) => set(range)}
          />
        </div>
      </FilterMenu>
      {active && (
        <button type="button" className="chip chip-clear" onClick={props.onClear}>
          Clear
        </button>
      )}
      <label className="zoom" title="Thumbnail size">
        <GridSmallIcon />
        <input
          type="range"
          aria-label="Thumbnail size"
          min={ROW_HEIGHT.min}
          max={ROW_HEIGHT.max}
          step={10}
          value={rowHeight}
          style={{ "--zoom-fill": `${((rowHeight - ROW_HEIGHT.min) * 100) / (ROW_HEIGHT.max - ROW_HEIGHT.min)}%` } as CSSProperties}
          onChange={(event) => props.onRowHeight(Number(event.target.value))}
        />
        <GridLargeIcon />
      </label>
    </div>
  );
}

interface TileProps {
  shot: Shot;
  hit: SearchHit | undefined;
  selected: boolean;
  index: number;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  onAction: (shot: Shot, action: "copy" | "pin") => void;
}

/** One capture in the grid; actions appear on hover. */
const Tile = memo(function Tile({ shot, hit, selected, index, onSelect, onOpen, onAction }: TileProps) {
  const style = { "--i": Math.min(index, 18) } as CSSProperties;
  const tags = allTags(shot);
  return (
    <li className={`tile${selected ? " is-selected" : ""}`} style={style}>
      <button
        type="button"
        className="tile-main"
        data-shot-id={shot.id}
        aria-pressed={selected}
        aria-label={shot.fileName}
        title="Double-click to open in the editor"
        onClick={() => onSelect(shot.id)}
        onDoubleClick={() => onOpen(shot.id)}
      >
        <span className="tile-frame">
          <Thumbnail shot={shot} />
        </span>
        <span className="tile-caption">
          <span className="tile-title">{shot.windowTitle || shot.fileName}</span>
          <span className="tile-meta">{[shot.app, formatTime(shot.capturedAt)].filter(Boolean).join(" · ")}</span>
          {hit && <Snippet hit={hit} />}
          {tags.length > 0 && (
            <span className="tile-tags">
              {tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      <span className="tile-actions">
        <button type="button" className="tile-action" aria-label={`Copy ${shot.fileName}`} title="Copy to the clipboard" onClick={() => onAction(shot, "copy")}>
          <CopyIcon />
        </button>
        <button type="button" className="tile-action" aria-label={`Edit ${shot.fileName}`} title="Open in editor" onClick={() => onOpen(shot.id)}>
          <EditIcon />
        </button>
        <button type="button" className="tile-action" aria-label={`Pin ${shot.fileName}`} title="Pin to screen" onClick={() => onAction(shot, "pin")}>
          <PinIcon />
        </button>
      </span>
    </li>
  );
});

interface DetailsProps {
  shot: Shot;
  /** AI descriptions are turned off in Settings. */
  aiOff: boolean;
  onUpdated: (shot: Shot) => void;
  onDeleted: (id: number) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
  /** Moves to the capture before (-1) or after (1), when there is one. */
  onStep: (delta: -1 | 1) => void;
  canStep: { back: boolean; forward: boolean };
}

/** The selected shot: open, tag, annotate with notes or delete it. */
function ShotDetails({ shot, aiOff, onUpdated, onDeleted, onError, onNotice, onClose, onStep, canStep }: DetailsProps) {
  // Local so quick successive edits build on each other before the saves land.
  const [tags, setTags] = useState(shot.tags);
  const [notes, setNotes] = useState(shot.notes);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  function saveTags(next: string[]) {
    if (sameTags(next, tags)) return;
    setTags(next);
    // One save at a time, in order.
    saving.current = saving.current.then(() =>
      setShotTags(shot.id, next)
        .then(onUpdated)
        .catch((err: unknown) => onError(errorMessage(err))),
    );
  }

  async function saveNotes() {
    if (notes === shot.notes) return;
    try {
      onUpdated(await setShotNotes(shot.id, notes));
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  /** Runs a one-click action, saying so briefly when it leaves nothing to see. */
  async function act(action: (id: number) => Promise<void>, done?: string) {
    try {
      await action(shot.id);
      if (done) onNotice(done);
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function redescribe() {
    try {
      await redescribeShot(shot.id);
      onNotice("Describing again. The new description shows up here when it is ready.");
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function clearAi() {
    try {
      await clearAiDescription(shot.id);
      onUpdated({ ...shot, aiDescription: null, aiCategory: null, aiTags: [] });
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  async function removeAi(tag: string) {
    try {
      onUpdated(await removeAiTag(shot.id, tag));
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  const aiTags = shot.aiTags ?? [];
  const described = !!shot.aiDescription || !!shot.aiCategory || aiTags.length > 0;

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

  const when = formatCapturedAt(shot.capturedAt);
  return (
    <aside className="details" aria-label="Capture details">
      <div className="details-top">
        <span className="details-heading">Details</span>
        <button type="button" className="icon-button" aria-label="Previous capture" disabled={!canStep.back} onClick={() => onStep(-1)}>
          <ChevronUpIcon size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Next capture" disabled={!canStep.forward} onClick={() => onStep(1)}>
          <ChevronDownIcon size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="details-scroll">
        <button
          type="button"
          className="details-preview"
          title="Open in the editor"
          tabIndex={-1}
          aria-hidden="true"
          onDoubleClick={() => void act(openShot)}
        >
          <Thumbnail shot={shot} />
        </button>

        <div className="details-body">
          <div>
            <h2 title={shot.path}>{shot.windowTitle || shot.fileName}</h2>
            <p className="details-sub">{[shot.app, when].filter(Boolean).join(" · ")}</p>
          </div>

          <div className="details-actions">
            <button type="button" className="btn btn-primary" aria-label="Open in editor" onClick={() => void act(openShot)}>
              <EditIcon />
              Edit
            </button>
            <button type="button" className="btn" onClick={() => void act(copyShot, "Copied to the clipboard")}>
              <CopyIcon />
              Copy
            </button>
            <button type="button" className="btn btn-icon" aria-label="Pin" title="Pin to screen" onClick={() => void act(pinShot)}>
              <PinIcon />
            </button>
            <button type="button" className="btn btn-icon" aria-label="Show in folder" title="Show in folder" onClick={() => void act(revealShot)}>
              <FolderIcon />
            </button>
          </div>

          <dl className="details-meta">
            <dt>File</dt>
            <dd title={shot.path}>{shot.fileName}</dd>
            {shot.windowTitle && shot.app && (
              <>
                <dt>Window</dt>
                <dd title={shot.windowTitle}>{shot.windowTitle}</dd>
              </>
            )}
            <dt>Size</dt>
            <dd>
              {shot.width} × {shot.height}
            </dd>
            {shot.aiCategory && (
              <>
                <dt>Category</dt>
                <dd>
                  <CategoryChip category={shot.aiCategory} />
                </dd>
              </>
            )}
          </dl>

          <section className="details-block" aria-label="AI description">
            <h3 className="details-label">
              <SparkleIcon />
              Description
              <span className="details-label-actions">
                <button type="button" className="link-button" aria-label="Re-describe" disabled={aiOff} onClick={() => void redescribe()}>
                  Redo
                </button>
                <button
                  type="button"
                  className="link-button link-muted"
                  aria-label="Clear AI description"
                  disabled={!described}
                  onClick={() => void clearAi()}
                >
                  Clear
                </button>
              </span>
            </h3>
            {shot.aiDescription ? (
              <p className="details-ai-text">{shot.aiDescription}</p>
            ) : (
              <p className="hint">
                {aiOff ? "Turn on AI descriptions in Settings to describe captures." : "Not described yet."}
              </p>
            )}
          </section>

          <div className="details-block">
            <label className="details-label" htmlFor="shot-tags">
              <TagIcon />
              Tags
            </label>
            <TagEditor tags={tags} onChange={saveTags} aiTags={aiTags} onRemoveAiTag={(tag) => void removeAi(tag)} />
            {aiTags.some((tag) => !tags.some((own) => own.toLowerCase() === tag.toLowerCase())) && (
              <p className="details-note">
                <span aria-hidden="true">✦</span> Added by AI. Remove any you don't want.
              </p>
            )}
          </div>

          <div className="details-block">
            <label className="details-label" htmlFor="shot-notes">
              Notes
            </label>
            <textarea
              id="shot-notes"
              rows={3}
              value={notes}
              placeholder="Add a note…"
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => void saveNotes()}
            />
          </div>

          <div className={`details-delete${confirming ? " is-confirming" : ""}`}>
            {confirming ? (
              <>
                <span>Delete this capture and its annotations?</span>
                <div className="details-delete-buttons">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                    Delete permanently
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="link-button link-danger" onClick={() => setConfirming(true)}>
                <TrashIcon />
                Delete…
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Shimmering placeholders while the first page loads. */
function Skeleton() {
  const aspects = [1.6, 1.2, 1.9, 0.9, 1.4, 1.7, 1.1, 2.1, 1.3, 1.5];
  return (
    <div className="day" aria-hidden="true">
      <div className="day-header">
        <span className="skeleton-line" />
      </div>
      <ul className="grid">
        {aspects.map((aspect, index) => (
          <li key={index} className="tile tile-skeleton" style={{ "--a": aspect } as CSSProperties}>
            <span className="thumb" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        <span className="empty-card empty-card-1" />
        <span className="empty-card empty-card-2" />
        <span className="empty-card empty-card-3">{searching ? <SearchIcon /> : <SparkleIcon />}</span>
      </div>
      <p className="empty-title">{searching ? "Nothing matches" : "Your library is empty"}</p>
      <p className="empty-text">
        {searching
          ? "No captures match. Try fewer words or other filters."
          : "No captures yet. Capture with a hotkey or from the tray menu."}
      </p>
    </div>
  );
}

function byShot(hits: SearchHit[]): Record<number, SearchHit> {
  const found: Record<number, SearchHit> = {};
  for (const hit of hits) found[hit.shot.id] = hit;
  return found;
}

/** The tile to move to from `from` with an arrow key, by on-screen position. */
function neighbour(tiles: HTMLElement[], from: HTMLElement, key: string): HTMLElement | null {
  const index = tiles.indexOf(from);
  if (key === "ArrowLeft") return tiles[index - 1] ?? null;
  if (key === "ArrowRight") return tiles[index + 1] ?? null;
  const box = from.getBoundingClientRect();
  const centre = box.left + box.width / 2;
  const down = key === "ArrowDown";
  let best: HTMLElement | null = null;
  let bestRow = Infinity;
  let bestDistance = Infinity;
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    const rowGap = down ? rect.top - box.bottom : box.top - rect.bottom;
    if (rowGap < -2) continue;
    const distance = Math.abs(rect.left + rect.width / 2 - centre);
    if (rowGap < bestRow - 2 || (Math.abs(rowGap - bestRow) <= 2 && distance < bestDistance)) {
      best = tile;
      bestRow = rowGap;
      bestDistance = distance;
    }
  }
  return best;
}

interface LibraryWindowProps {
  /** The heading; "Library" by default. */
  title?: string;
  /**
   * Set when the Grab-it window's sidebar picks the app: the filter bar
   * then leaves it out, and changes to it (Clear) are passed up.
   */
  appFilter?: string;
  onAppFilter?: (app: string) => void;
  /** As `appFilter`, for the tag the sidebar picks. */
  tagFilter?: string;
  onTagFilter?: (tag: string) => void;
  /** Shown at the end of the title bar (the Grab-it window's New capture button). */
  toolbarEnd?: ReactNode;
}

function LibraryWindow({
  title = "Library",
  appFilter,
  onAppFilter,
  tagFilter,
  onTagFilter,
  toolbarEnd,
}: LibraryWindowProps = {}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  const [rowHeight, setRowHeight] = useState(readRowHeight);
  const [scrolled, setScrolled] = useState(false);
  // "Today" and "Yesterday" are relative to when the list last loaded.
  const [now, setNow] = useState(Date.now);
  // How many shots are shown, so a reload keeps every loaded page.
  const shownCount = useRef(PAGE_SIZE);
  const loadingMoreRef = useRef(false);
  // The search box as typed, and as searched once typing pauses.
  const [text, setText] = useState("");
  const [searchedText, setSearchedText] = useState("");
  const [ownFilters, setOwnFilters] = useState<Filters>(NO_FILTERS);
  const filters = useMemo(() => {
    let merged = ownFilters;
    if (appFilter !== undefined) merged = { ...merged, app: appFilter };
    if (tagFilter !== undefined) merged = { ...merged, tag: tagFilter };
    return merged;
  }, [ownFilters, appFilter, tagFilter]);
  const setFilters = useCallback(
    (next: Filters) => {
      if (appFilter !== undefined && next.app !== appFilter) onAppFilter?.(next.app);
      if (tagFilter !== undefined && next.tag !== tagFilter) onTagFilter?.(next.tag);
      setOwnFilters(next);
    },
    [appFilter, onAppFilter, tagFilter, onTagFilter],
  );
  const [options, setOptions] = useState<FilterOptions>({ apps: [], tags: [], categories: [] });
  // Null until the backend says; the AI actions then stay available.
  const [ai, setAi] = useState<AiStatus | null>(null);
  // Grab-it turned AI descriptions on by itself and has not said so yet.
  const [aiNotice, setAiNotice] = useState<CliProvider | null>(null);
  const [optionReloads, setOptionReloads] = useState(0);
  // Where each result matched, by shot id; empty when not searching.
  const [hits, setHits] = useState<Record<number, SearchHit>>({});
  const [ocr, setOcr] = useState<OcrStatus>({ state: "idle" });
  const query = useMemo(() => buildQuery(searchedText, filters), [searchedText, filters]);
  const searching = isSearching(query);
  const lastQuery = useRef("");
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearchedText(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    try {
      localStorage.setItem(ROW_HEIGHT_KEY, String(rowHeight));
    } catch {
      // Not remembered; fine.
    }
  }, [rowHeight]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    // A new search starts again from one page; a reload keeps what is shown.
    const key = JSON.stringify(query);
    const isNew = lastQuery.current !== key;
    if (isNew) {
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
        setNow(Date.now());
        if (isNew) scroller.current?.scrollTo?.({ top: 0 });
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
    let previous: AiStatus["state"] | null = null;
    aiStatus()
      .then((status) => {
        if (cancelled) return;
        previous ??= status.state;
        setAi(status);
      })
      .catch(() => {
        // Without a status the Library just shows no AI progress.
      });
    onAiStatus((status) => {
      // A finished run may have described shots on screen; show the new descriptions.
      if (previous === "working" && status.state !== "working") setReloads((count) => count + 1);
      previous = status.state;
      setAi(status);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // As above: no live AI progress.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Asked again whenever the AI status changes: Grab-it may turn describing
  // on just after the Library opens, and Settings may turn it off.
  const aiState = ai?.state;
  const aiProvider = ai?.provider;
  useEffect(() => {
    let cancelled = false;
    pendingAiNotice()
      .then((pending) => {
        if (!cancelled) setAiNotice(pending);
      })
      .catch(() => {
        // Without the settings there is just no notice.
      });
    return () => {
      cancelled = true;
    };
  }, [aiState, aiProvider]);

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

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const offset = shots.length;
      const page = searching
        ? await searchShots(query, offset, PAGE_SIZE).then((found) => ({
            shots: found.hits.map((hit) => hit.shot),
            total: found.total,
            hits: found.hits,
          }))
        : await listShots(offset, PAGE_SIZE).then((found) => ({ ...found, hits: [] as SearchHit[] }));
      shownCount.current = Math.max(PAGE_SIZE, offset + page.shots.length);
      setShots((current) => {
        const known = new Set(current.map((shot) => shot.id));
        return [...current, ...page.shots.filter((shot) => !known.has(shot.id))];
      });
      setHits((current) => ({ ...current, ...byShot(page.hits) }));
      setTotal(page.total);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [shots.length, searching, query]);

  const hasMore = loaded && shots.length < total;
  const latestLoadMore = useRef(loadMore);
  const canLoadMore = useRef(false);
  useEffect(() => {
    latestLoadMore.current = loadMore;
    canLoadMore.current = hasMore && !error;
  });

  // Infinite scroll: fetch the next page well before the end comes into view.
  // Re-observing after each page re-checks, so a tall window keeps filling.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (canLoadMore.current && entries.some((entry) => entry.isIntersecting)) void latestLoadMore.current();
      },
      { root: scroller.current, rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shots.length, hasMore]);

  // "/" jumps to search; Escape closes the details.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable]");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchBox.current?.focus();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function updated(shot: Shot) {
    setError(null);
    setShots((current) => current.map((item) => (item.id === shot.id ? shot : item)));
    // Its tags may be new to the tag filter.
    setOptionReloads((count) => count + 1);
  }

  function dismissNotice() {
    setAiNotice(null);
    dismissAiNotice().catch((err: unknown) => setError(errorMessage(err)));
  }

  function showSettings() {
    openSettings().catch((err: unknown) => setError(errorMessage(err)));
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
    setNotice({ text: "Capture deleted", key: Date.now() });
  }

  const open = useCallback((id: number) => {
    openShot(id).catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const tileAction = useCallback((shot: Shot, action: "copy" | "pin") => {
    const run = action === "copy" ? copyShot : pinShot;
    run(shot.id)
      .then(() => {
        if (action === "copy") setNotice({ text: "Copied to the clipboard", key: Date.now() });
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const from = (event.target as HTMLElement).closest<HTMLElement>(".tile-main");
    if (!from || !scroller.current) return;
    if (event.key === "Enter" && event.metaKey) {
      open(Number(from.dataset.shotId));
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const tiles = [...scroller.current.querySelectorAll<HTMLElement>(".tile-main")];
    const next = neighbour(tiles, from, event.key);
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: "nearest" });
    setSelectedId(Number(next.dataset.shotId));
  }

  // Text searches are ranked by relevance, so they stay in one run; otherwise by day.
  const groups = useMemo(
    () => (query.text ? [{ day: -1, items: shots }] : groupByDay(shots)),
    [shots, query.text],
  );
  const selectedIndex = shots.findIndex((shot) => shot.id === selectedId);
  const selected = selectedIndex >= 0 ? shots[selectedIndex] : null;

  function step(delta: -1 | 1) {
    const next = shots[selectedIndex + delta];
    if (!next) return;
    setSelectedId(next.id);
    scroller.current
      ?.querySelector<HTMLElement>(`[data-shot-id="${next.id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }
  let tileIndex = 0;

  return (
    <main className="library" style={{ "--row-h": `${rowHeight}px` } as CSSProperties}>
      <header className={`library-top${scrolled ? " is-scrolled" : ""}`}>
        <div className="library-bar" data-tauri-drag-region>
          <div className="library-title" data-tauri-drag-region>
            <h1>{title}</h1>
            {loaded && (
              <span className="count-pill">
                {searching
                  ? total === 1
                    ? "1 result"
                    : `${total} results`
                  : total === 1
                    ? "1 capture"
                    : `${total} captures`}
              </span>
            )}
          </div>
          <SearchField text={text} searchRef={searchBox} onText={setText} onSubmit={() => setSearchedText(text)} />
          {toolbarEnd}
        </div>
        <Toolbar
          text={text}
          filters={filters}
          options={options}
          active={searching || text.length > 0}
          rowHeight={rowHeight}
          onFilters={setFilters}
          onClear={clearSearch}
          onRowHeight={setRowHeight}
          hideAppFilter={appFilter !== undefined}
          now={now}
        />
        <OcrBanner status={ocr} onRetry={retry} />
        {aiNotice && (
          <AiNotice
            provider={aiNotice}
            onSettings={() => {
              dismissNotice();
              showSettings();
            }}
            onDismiss={dismissNotice}
          />
        )}
        {ai && <AiBanner status={ai} onSettings={showSettings} />}
        {error && (
          <p role="alert" className="error-pill">
            {error}
            <button type="button" className="error-dismiss" aria-label="Dismiss error" onClick={() => setError(null)}>
              <CloseIcon size={12} />
            </button>
          </p>
        )}
      </header>

      <div className="library-body">
        <div className="library-main">
        <section
          className="library-scroll"
          aria-label="Captures"
          ref={scroller}
          onKeyDown={onGridKeyDown}
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
        >
          {!loaded && !error && <Skeleton />}
          {loaded && shots.length === 0 && <EmptyState searching={searching} />}
          {groups.map((group) => {
            const label = group.day < 0 ? { title: "Best matches", subtitle: null } : dayLabel(group.day, now);
            return (
              <section key={group.day} className="day" aria-label={label.title}>
                <h2 className="day-header">
                  <span className="day-title">{label.title}</span>
                  {label.subtitle && <span className="day-subtitle">{label.subtitle}</span>}
                  <span className="day-count">{group.items.length}</span>
                </h2>
                <ul className="grid">
                  {group.items.map((shot) => (
                    <Tile
                      key={thumbKey(shot)}
                      shot={shot}
                      hit={hits[shot.id]}
                      selected={shot.id === selectedId}
                      index={tileIndex++}
                      onSelect={setSelectedId}
                      onOpen={open}
                      onAction={tileAction}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <div ref={sentinel} className="library-end">
            {hasMore && (
              <button type="button" className="pill-button" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            {loaded && !hasMore && shots.length > PAGE_SIZE / 2 && (
              <span className="library-fin">
                <SparkleIcon /> That's everything
              </span>
            )}
          </div>
        </section>
        {scrolled && (
          <button
            type="button"
            className="to-top"
            aria-label="Back to top"
            onClick={() => scroller.current?.scrollTo({ top: 0, behavior: "smooth" })}
          >
            ↑
          </button>
        )}
        </div>
        {selected && (
          <ShotDetails
            key={selected.id}
            shot={selected}
            aiOff={ai?.state === "off"}
            onUpdated={updated}
            onDeleted={deleted}
            onError={setError}
            onNotice={(message) => setNotice({ text: message, key: Date.now() })}
            onClose={() => setSelectedId(null)}
            canStep={{ back: selectedIndex > 0, forward: selectedIndex < shots.length - 1 }}
            onStep={step}
          />
        )}
      </div>
      {notice && (
        <div key={notice.key} className="toast" role="status">
          {notice.text}
        </div>
      )}
    </main>
  );
}

export default LibraryWindow;
