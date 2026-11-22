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
import { chooseExportFile } from "../app/exportDialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./library.css";
import {
  CLI_NAMES,
  cleanedText,
  DATE_PRESETS,
  FIELD_LABELS,
  NO_FILTERS,
  PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  aiStatus,
  baseName,
  buildQuery,
  categoryLabel,
  clearAiDescription,
  copyShot,
  copyShotFile,
  dayLabel,
  deleteShot,
  dismissAiNotice,
  duplicateShot,
  exportFilters,
  exportPath,
  exportShot,
  filterOptions,
  formatCapturedAt,
  formatTime,
  allTags,
  groupByDay,
  isRecording,
  isSearching,
  itemCount,
  listShots,
  ocrStatus,
  onAiStatus,
  onLibraryChanged,
  onLibraryCleaned,
  onOcrStatus,
  openSettings,
  openShot,
  pendingAiNotice,
  playShot,
  copyShotText,
  copyShotPath,
  openShotExternally,
  openShotFolder,
  openShotWith,
  openWithSupported,
  redescribeShot,
  renameShot,
  revealShot,
  searchShots,
  setShotKeep,
  setShotNotes,
  removeAiTag,
  setShotTags,
  shotText,
  splitFileName,
  suggestedTags,
  textCopied,
  trashShot,
  type AiStatus,
  type CliProvider,
  type FilterOptions,
  type Filters,
  type KindFilter,
  type OcrStatus,
  type SearchHit,
  type Shot,
  type ShotText,
} from "./api";
import { ChipSelect, DateChip, FilterMenu, TagEditor } from "./controls";
import {
  AppIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  FilmIcon,
  FolderIcon,
  GridLargeIcon,
  GridSmallIcon,
  ImageIcon,
  PinIcon,
  PlayIcon,
  LayersIcon,
  SearchIcon,
  SparkleIcon,
  StarIcon,
  TagIcon,
  TextIcon,
  TrashIcon,
} from "./icons";
import { useInView, useThumbnail } from "./thumbnails";
import { copyFinished, pinFinished } from "./finished";
import { tagStyle } from "./tagColor";
import { DETAILS_WIDTH, clampDetailsWidth } from "./detailsWidth";
import { CleanUpDialog, StoragePill } from "./storage";
import { ShotMenu, type ShotMenuAction } from "./ShotMenu";
import type { SettingsSection } from "../settings/api";
import { ChevronDownIcon, ChevronUpIcon } from "../app/icons";
import { formatBytes, formatElapsed } from "../quick/api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** Runs `run` on each of `items` in turn, carrying on past failures; says which worked and why the rest did not. */
async function eachShot(items: Shot[], run: (item: Shot) => Promise<unknown>): Promise<{ done: Shot[]; errors: string[] }> {
  const done: Shot[] = [];
  const errors: string[] = [];
  for (const item of items) {
    try {
      await run(item);
      done.push(item);
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  return { done, errors };
}

/**
 * One error for a bulk action some items failed: `what` says what could not
 * be done to "2 of 5 items", and the first reason follows.
 */
function bulkFailure(errors: string[], total: number, what: (items: string) => string): string {
  return `Could not ${what(`${errors.length} of ${itemCount(total)}`)}: ${errors[0]}`;
}

/** How a click on a tile selects: Ctrl/Cmd toggles it, Shift selects the range from the last one clicked. */
interface SelectHow {
  toggle: boolean;
  range: boolean;
}

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, index) => tag === b[index]);


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

const DETAILS_WIDTH_KEY = "grab-it.library.detailsWidth";
function readDetailsWidth(): number {
  try {
    const saved = Number(localStorage.getItem(DETAILS_WIDTH_KEY));
    if (saved >= DETAILS_WIDTH.min && saved <= DETAILS_WIDTH.max) return saved;
  } catch {
    // Storage may be unavailable; use the default.
  }
  return DETAILS_WIDTH.initial;
}

/** The grab line on the details' left edge: drag, arrow keys, or double-click to reset. */
function DetailsResizer({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number; room: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** The width the details and grid share: the details' parent. */
  const roomOf = (element: Element) => element.closest(".library-body")?.clientWidth || Infinity;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details"
      aria-valuemin={DETAILS_WIDTH.min}
      aria-valuemax={DETAILS_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={`details-resizer${dragging ? " is-dragging" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width, room: roomOf(event.currentTarget) };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        // The handle sits on the left edge, so dragging left widens.
        onWidth(clampDetailsWidth(start.width + start.x - event.clientX, start.room));
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={(event) => onWidth(clampDetailsWidth(DETAILS_WIDTH.initial, roomOf(event.currentTarget)))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const room = roomOf(event.currentTarget);
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = width + step;
        else if (event.key === "ArrowRight") next = width - step;
        else if (event.key === "Home") next = DETAILS_WIDTH.min;
        else if (event.key === "End") next = DETAILS_WIDTH.max;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onWidth(clampDetailsWidth(next, room));
      }}
    >
      <span className="details-grip" aria-hidden="true" />
    </div>
  );
}

/** A shot's thumbnail, fetched only once it nears the viewport. */
function Thumbnail({ shot, className = "" }: { shot: Shot; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref);
  const { url, failed } = useThumbnail(shot, near);
  const [shown, setShown] = useState(false);
  return (
    <div ref={ref} className={`thumb ${className}${url && shown ? " is-loaded" : ""}`}>
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" onLoad={() => setShown(true)} />
      ) : failed && isRecording(shot) ? (
        // An MP4's preview waits for ffmpeg; the play badge says what it is.
        <span className="thumb-failed">
          <FilmIcon size={28} />
        </span>
      ) : failed ? (
        <span className="thumb-failed">
          <ImageIcon />
          No preview
        </span>
      ) : null}
    </div>
  );
}

/** "Video" or "GIF", for a recording. */
function recordingLabel(shot: Shot): string {
  return shot.kind === "gif" ? "GIF" : "Video";
}

/** The play badge and length over a recording's preview. */
function RecordingBadges({ shot }: { shot: Shot }) {
  if (!isRecording(shot)) return null;
  return (
    <>
      <span className="rec-play" aria-hidden="true">
        <PlayIcon size={14} />
      </span>
      {shot.durationMs != null && <span className="rec-length">{formatElapsed(shot.durationMs)}</span>}
    </>
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

/** The OCR queue, or why it cannot read text, while there is something to say. */
function OcrBanner({ status }: { status: OcrStatus }) {
  switch (status.state) {
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
          <span className="hint">The text recognition models ship with Grab-it. Reinstall it to restore them.</span>
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
  /** As `hideAppFilter`, for captures or recordings. */
  hideKindFilter?: boolean;
  /** What "today" is for the time switch. */
  now: number;
}

const KIND_OPTIONS: KindFilter[] = ["image", "recording"];

function kindLabel(kind: string): string {
  return kind === "recording" ? "Recordings" : "Screenshots";
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
    (!props.hideKindFilter && filters.kind ? 1 : 0) +
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
        {!props.hideKindFilter && (
          <div className="filter-row">
            <span className="filter-label">Type</span>
            <ChipSelect
              label="Filter by type"
              icon={<FilmIcon />}
              allLabel="Everything"
              value={filters.kind ?? ""}
              options={KIND_OPTIONS}
              format={kindLabel}
              onChange={(kind) => set({ kind: kind as KindFilter | "" })}
            />
          </div>
        )}
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

/** What double-clicking a tile does, by kind. */
const OPEN_HINTS = {
  image: "Double-click to open in the editor",
  video: "Double-click to open in the recording editor",
  gif: "Double-click to play",
} as const;

interface TileProps {
  shot: Shot;
  hit: SearchHit | undefined;
  selected: boolean;
  index: number;
  onSelect: (id: number, how: SelectHow) => void;
  onOpen: (id: number) => void;
  onAction: (shot: Shot, action: TileAction) => void;
  /** Stars or unstars the shot Keep forever. */
  onKeep: (shot: Shot) => void;
  /** Its right-click menu is open. */
  menuOpen: boolean;
  /** Opens its right-click menu at a point in the window. */
  onMenu: (shot: Shot, x: number, y: number, from: HTMLElement) => void;
}

/** "Keep forever" or "Starred: kept forever", for the star's tooltip. */
const keepTitle = (shot: Shot) => (shot.keep ? "Kept forever: cleanup never removes it" : "Keep forever");

/** One capture in the grid; actions appear on hover, the star too until it is on. */
const Tile = memo(function Tile({ shot, hit, selected, index, onSelect, onOpen, onAction, onKeep, menuOpen, onMenu }: TileProps) {
  const style = { "--i": Math.min(index, 18) } as CSSProperties;
  const tags = allTags(shot);
  const recording = isRecording(shot);
  const meta = recording ? [recordingLabel(shot), formatTime(shot.capturedAt)] : [shot.app, formatTime(shot.capturedAt)];
  return (
    <li
      className={`tile${selected ? " is-selected" : ""}${recording ? " is-recording" : ""}${menuOpen ? " is-menu-open" : ""}`}
      style={style}
      onContextMenu={(event) => {
        event.preventDefault();
        const main = event.currentTarget.querySelector<HTMLElement>(".tile-main") ?? event.currentTarget;
        // The menu key and Shift+F10 give no pointer position: open by the tile.
        if (event.clientX === 0 && event.clientY === 0) {
          const box = main.getBoundingClientRect();
          onMenu(shot, box.left + 12, box.top + 12, main);
        } else {
          onMenu(shot, event.clientX, event.clientY, main);
        }
      }}
    >
      <button
        type="button"
        className="tile-main"
        data-shot-id={shot.id}
        aria-pressed={selected}
        aria-haspopup="menu"
        aria-label={shot.fileName}
        // No tooltip over its own menu.
        title={menuOpen ? undefined : OPEN_HINTS[shot.kind ?? "image"]}
        onClick={(event) => {
          // A double-click's second click: its first click already selected, and may have moved the grid.
          if (event.detail > 1) return;
          onSelect(shot.id, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
        }}
        // Shift-click selects tiles, not the text in them.
        onMouseDown={(event) => {
          if (event.shiftKey) event.preventDefault();
        }}
        onDoubleClick={() => onOpen(shot.id)}
      >
        <span className="tile-frame">
          <Thumbnail shot={shot} />
          <RecordingBadges shot={shot} />
        </span>
        <span className="tile-caption">
          <span className="tile-title">{shot.windowTitle || shot.fileName}</span>
          <span className="tile-meta">{meta.filter(Boolean).join(" · ")}</span>
          {hit && <Snippet hit={hit} />}
          {tags.length > 0 && (
            <span className="tile-tags">
              {tags.map((tag) => (
                <span key={tag} className="tag" style={tagStyle(tag)}>
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        className={`tile-star${shot.keep ? " is-on" : ""}`}
        aria-label={`Keep ${shot.fileName} forever`}
        aria-pressed={shot.keep === true}
        title={keepTitle(shot)}
        onClick={() => onKeep(shot)}
      >
        <StarIcon filled={shot.keep === true} />
      </button>
      {recording ? (
        <span className="tile-actions">
          <button type="button" className="tile-action" aria-label={`Play ${shot.fileName}`} title="Play" onClick={() => onAction(shot, "play")}>
            <PlayIcon />
          </button>
          {shot.kind === "video" && (
            <button type="button" className="tile-action" aria-label={`Edit ${shot.fileName}`} title="Open in the recording editor" onClick={() => onOpen(shot.id)}>
              <EditIcon />
            </button>
          )}
          <button type="button" className="tile-action" aria-label={`Show ${shot.fileName} in its folder`} title="Show in folder" onClick={() => onAction(shot, "reveal")}>
            <FolderIcon />
          </button>
        </span>
      ) : (
        <span className="tile-actions">
          <button type="button" className="tile-action" aria-label={`Copy ${shot.fileName}`} title="Copy to the clipboard" onClick={() => onAction(shot, "copy")}>
            <CopyIcon />
          </button>
          <button
            type="button"
            className="tile-action"
            aria-label={`Copy the text in ${shot.fileName}`}
            title="Copy the text in this image"
            onClick={() => onAction(shot, "text")}
          >
            <TextIcon />
          </button>
          <button type="button" className="tile-action" aria-label={`Edit ${shot.fileName}`} title="Open in editor" onClick={() => onOpen(shot.id)}>
            <EditIcon />
          </button>
          <button type="button" className="tile-action" aria-label={`Pin ${shot.fileName}`} title="Pin to screen" onClick={() => onAction(shot, "pin")}>
            <PinIcon />
          </button>
        </span>
      )}
    </li>
  );
});

type TileAction = "copy" | "text" | "pin" | "play" | "reveal";

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
  /** The pane's width in pixels, set by dragging its left edge. */
  width: number;
  onWidth: (width: number) => void;
}

/**
 * The text OCR found in `shot`; null while it loads. Asked again whenever
 * the shot is refreshed, which happens when OCR reads it.
 */
function useShotText(shot: Shot): ShotText | null {
  const [loaded, setLoaded] = useState<{ shot: Shot; text: ShotText } | null>(null);
  useEffect(() => {
    let cancelled = false;
    shotText(shot.id)
      .then((text) => {
        if (!cancelled) setLoaded({ shot, text });
      })
      .catch(() => {
        // Without it the section only offers Copy, which still works.
      });
    return () => {
      cancelled = true;
    };
  }, [shot]);
  // Text still loading for the previous shot is not this one's.
  return loaded && loaded.shot.id === shot.id ? loaded.text : null;
}

/** The selected shot: open, tag, annotate with notes or delete it. */
function ShotDetails({ shot, aiOff, onUpdated, onDeleted, onError, onNotice, onClose, onStep, canStep, width, onWidth }: DetailsProps) {
  // Local so quick successive edits build on each other before the saves land.
  const [tags, setTags] = useState(shot.tags);
  const [notes, setNotes] = useState(shot.notes);
  /** Tag saves still landing. */
  const [tagSaves, setTagSaves] = useState(0);
  // Tags changed elsewhere, as from the right-click menu, show here too,
  // once this pane's own saves have landed.
  const [shownTags, setShownTags] = useState(shot.tags);
  if (shownTags !== shot.tags) {
    setShownTags(shot.tags);
    if (tagSaves === 0 && !sameTags(shot.tags, tags)) setTags(shot.tags);
  }
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const text = useShotText(shot);
  const [copyingText, setCopyingText] = useState(false);

  async function copyText() {
    setCopyingText(true);
    try {
      onNotice(textCopied(await copyShotText(shot.id)));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setCopyingText(false);
    }
  }

  function saveTags(next: string[]) {
    if (sameTags(next, tags)) return;
    setTags(next);
    setTagSaves((count) => count + 1);
    // One save at a time, in order.
    saving.current = saving.current.then(() =>
      setShotTags(shot.id, next)
        .then(onUpdated)
        .catch((err: unknown) => onError(errorMessage(err)))
        .finally(() => setTagSaves((count) => count - 1)),
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

  async function toggleKeep() {
    try {
      onUpdated(await setShotKeep(shot.id, !shot.keep));
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
  const recording = isRecording(shot);
  const video = shot.kind === "video";
  return (
    <aside className="details" aria-label={recording ? "Recording details" : "Capture details"} style={{ width }}>
      <DetailsResizer width={width} onWidth={onWidth} />
      <div className="details-top">
        <span className="details-heading">Details</span>
        <button
          type="button"
          className={`icon-button details-star${shot.keep ? " is-on" : ""}`}
          aria-label="Keep forever"
          aria-pressed={shot.keep === true}
          title={keepTitle(shot)}
          onClick={() => void toggleKeep()}
        >
          <StarIcon filled={shot.keep === true} size={15} />
        </button>
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
          className={`details-preview${recording ? " is-recording" : ""}`}
          title={recording ? "Double-click to play" : "Open in the editor"}
          tabIndex={-1}
          aria-hidden="true"
          onDoubleClick={() => void act(recording ? playShot : openShot)}
        >
          <Thumbnail shot={shot} />
          <RecordingBadges shot={shot} />
        </button>

        <div className="details-body">
          <div>
            <h2 title={shot.path}>{shot.windowTitle || shot.fileName}</h2>
            <p className="details-sub">{[recording ? recordingLabel(shot) : shot.app, when].filter(Boolean).join(" · ")}</p>
          </div>

          {recording ? (
            <div className="details-actions">
              {video && (
                <button type="button" className="btn btn-primary" aria-label="Open in the recording editor" onClick={() => void act(openShot)}>
                  <EditIcon />
                  Edit
                </button>
              )}
              <button type="button" className={`btn${video ? "" : " btn-primary"}`} onClick={() => void act(playShot)}>
                <PlayIcon />
                Play
              </button>
              <button type="button" className="btn btn-icon" aria-label="Show in folder" title="Show in folder" onClick={() => void act(revealShot)}>
                <FolderIcon />
              </button>
            </div>
          ) : (
            <div className="details-actions">
              <button type="button" className="btn btn-primary" aria-label="Open in editor" onClick={() => void act(openShot)}>
                <EditIcon />
                Edit
              </button>
              <button type="button" className="btn" onClick={() => void act(() => copyFinished(shot), "Copied to the clipboard")}>
                <CopyIcon />
                Copy
              </button>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="Copy text"
                title="Copy the text in this image"
                disabled={copyingText}
                onClick={() => void copyText()}
              >
                <TextIcon />
              </button>
              <button type="button" className="btn btn-icon" aria-label="Pin" title="Pin to screen" onClick={() => void act(() => pinFinished(shot))}>
                <PinIcon />
              </button>
              <button type="button" className="btn btn-icon" aria-label="Show in folder" title="Show in folder" onClick={() => void act(revealShot)}>
                <FolderIcon />
              </button>
            </div>
          )}

          <dl className="details-meta">
            <dt>File</dt>
            <dd title={shot.path}>{shot.fileName}</dd>
            {shot.windowTitle && shot.app && (
              <>
                <dt>Window</dt>
                <dd title={shot.windowTitle}>{shot.windowTitle}</dd>
              </>
            )}
            {shot.width > 0 && (
              <>
                <dt>Size</dt>
                <dd>
                  {shot.width} × {shot.height}
                </dd>
              </>
            )}
            {recording && shot.durationMs != null && (
              <>
                <dt>Length</dt>
                <dd>{formatElapsed(shot.durationMs)}</dd>
              </>
            )}
            {recording && shot.bytes != null && (
              <>
                <dt>File size</dt>
                <dd>{formatBytes(shot.bytes)}</dd>
              </>
            )}
            {shot.aiCategory && (
              <>
                <dt>Category</dt>
                <dd>
                  <CategoryChip category={shot.aiCategory} />
                </dd>
              </>
            )}
          </dl>

          {!recording && (
            <section className="details-block" aria-label="Text in image">
              <h3 className="details-label">
                <TextIcon />
                Text in image
                <span className="details-label-actions">
                  <button
                    type="button"
                    className="link-button"
                    aria-label="Copy the text"
                    disabled={copyingText || (text?.state === "read" && text.text.trim() === "")}
                    onClick={() => void copyText()}
                  >
                    {copyingText ? "Reading…" : "Copy"}
                  </button>
                </span>
              </h3>
              {text?.state === "read" && text.text.trim() !== "" && (
                // Selectable, to copy just part of it.
                <pre className="details-text" tabIndex={0} aria-label="Text found in the image">
                  {text.text}
                </pre>
              )}
              {text?.state === "read" && text.text.trim() === "" && <p className="hint">No text found in this image.</p>}
              {text?.state === "waiting" && <p className="hint">Not read yet. Copy reads it now.</p>}
              {text?.state === "failed" && <p className="hint">The text could not be read. Copy tries again.</p>}
            </section>
          )}

          {!recording && (
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
          )}

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
                <span>{recording ? "Delete this recording and its edits?" : "Delete this capture and its annotations?"}</span>
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
  /** As `appFilter`, for captures or recordings only. */
  kindFilter?: KindFilter | "";
  onKindFilter?: (kind: KindFilter | "") => void;
  /** Shown at the end of the title bar (the Grab-it window's New capture button). */
  toolbarEnd?: ReactNode;
  /**
   * Opens Settings on a page, as the Grab-it window does in its own dialog;
   * without it the Settings window opens.
   */
  onOpenSettings?: (section: SettingsSection) => void;
}

function LibraryWindow({
  title = "Library",
  appFilter,
  onAppFilter,
  tagFilter,
  onTagFilter,
  kindFilter,
  onKindFilter,
  toolbarEnd,
  onOpenSettings,
}: LibraryWindowProps = {}) {
  const [shots, setShots] = useState<Shot[]>([]);
  /** Whether the Clean up dialog is open. */
  const [cleaning, setCleaning] = useState(false);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  /** The selected shots' ids, in the order they were selected; the details show while there is one. */
  const [selection, setSelection] = useState<number[]>([]);
  /** The tile a Shift-click selects the range from: the last one clicked without Shift. */
  const anchor = useRef<number | null>(null);
  /** The shot whose right-click menu is open, and where. */
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  /** The tile the menu opened from, to give focus back to. */
  const menuFrom = useRef<HTMLElement | null>(null);
  /** Whether the system can ask which app to open a file with; Open with… is hidden until it says. */
  const [canOpenWith, setCanOpenWith] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [rowHeight, setRowHeight] = useState(readRowHeight);
  const [detailsWidth, setDetailsWidth] = useState(readDetailsWidth);
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
    if (kindFilter !== undefined) merged = { ...merged, kind: kindFilter };
    return merged;
  }, [ownFilters, appFilter, tagFilter, kindFilter]);
  const setFilters = useCallback(
    (next: Filters) => {
      if (appFilter !== undefined && next.app !== appFilter) onAppFilter?.(next.app);
      if (tagFilter !== undefined && next.tag !== tagFilter) onTagFilter?.(next.tag);
      if (kindFilter !== undefined && (next.kind ?? "") !== kindFilter) onKindFilter?.(next.kind ?? "");
      setOwnFilters(next);
    },
    [appFilter, onAppFilter, tagFilter, onTagFilter, kindFilter, onKindFilter],
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
    try {
      localStorage.setItem(DETAILS_WIDTH_KEY, String(detailsWidth));
    } catch {
      // Not remembered; fine.
    }
  }, [detailsWidth]);

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

  // An automatic cleanup says what it removed; the list reloads on the
  // library change that follows.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onLibraryCleaned((cleaned) => setNotice({ text: cleanedText(cleaned), key: Date.now() }))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Without events the Library just does not say what cleanup removed.
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

  useEffect(() => {
    let live = true;
    openWithSupported().then((supported) => {
      if (live) setCanOpenWith(supported);
    });
    return () => {
      live = false;
    };
  }, []);

  // "/" jumps to search; Escape closes the details.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable]");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchBox.current?.focus();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        setSelection([]);
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

  function showStorageSettings() {
    if (onOpenSettings) onOpenSettings("storage");
    else showSettings();
  }

  function clearSearch() {
    setText("");
    setSearchedText("");
    setFilters(NO_FILTERS);
  }

  function deleted(id: number, trashed = false) {
    const gone = shots.find((shot) => shot.id === id);
    setError(null);
    setShots((current) => current.filter((shot) => shot.id !== id));
    setTotal((count) => Math.max(0, count - 1));
    setSelection((current) => current.filter((item) => item !== id));
    const what = gone && isRecording(gone) ? "Recording" : "Capture";
    setNotice({ text: trashed ? `${what} moved to the Trash` : `${what} deleted`, key: Date.now() });
  }

  /** Renames a shot's file from its menu; rejects with the backend's reason, which the menu shows. */
  const rename = useCallback(async (shot: Shot, name: string) => {
    const renamed = await renameShot(shot.id, name);
    setError(null);
    setShots((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
    setNotice({ text: `Renamed to ${renamed.fileName}`, key: Date.now() });
  }, []);

  /** The shots as shown, for selecting a range and for bulk tag saves that build on each other. */
  const shownShots = useRef(shots);
  useEffect(() => {
    shownShots.current = shots;
  });

  /** Selects `id` alone, or nothing. */
  const selectOnly = useCallback((id: number | null) => {
    anchor.current = id;
    setSelection(id === null ? [] : [id]);
  }, []);

  const select = useCallback((id: number, how: SelectHow) => {
    const from = anchor.current;
    if (how.range && from !== null) {
      const order = shownShots.current.map((item) => item.id);
      const start = order.indexOf(from);
      const end = order.indexOf(id);
      if (start >= 0 && end >= 0) {
        const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
        // Ctrl/Cmd+Shift adds the range to what is selected; Shift alone selects just it.
        setSelection((current) => (how.toggle ? [...current, ...range.filter((item) => !current.includes(item))] : range));
        return;
      }
    }
    anchor.current = id;
    if (how.toggle) {
      setSelection((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    } else {
      setSelection([id]);
    }
  }, []);

  const open = useCallback((id: number) => {
    openShot(id).catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  /**
   * The tile a double-click's first click landed on. That click opens the details, which can
   * narrow the grid and move another tile under the pointer before the second click.
   */
  const pressed = useRef<number | null>(null);
  const pressTile = useCallback(
    (id: number, how: SelectHow) => {
      pressed.current = id;
      select(id, how);
    },
    [select],
  );
  const openTile = useCallback((id: number) => open(pressed.current ?? id), [open]);

  const toggleKeep = useCallback((shot: Shot) => {
    setShotKeep(shot.id, !shot.keep).then(
      (saved) => setShots((current) => current.map((item) => (item.id === saved.id ? saved : item))),
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  const tileAction = useCallback((shot: Shot, action: TileAction) => {
    const notice = (text: string) => setNotice({ text, key: Date.now() });
    const failed = (err: unknown) => setError(errorMessage(err));
    if (action === "copy") copyFinished(shot).then(() => notice("Copied to the clipboard"), failed);
    else if (action === "text") copyShotText(shot.id).then((text) => notice(textCopied(text)), failed);
    else if (action === "play") playShot(shot.id).catch(failed);
    else if (action === "reveal") revealShot(shot.id).catch(failed);
    else pinFinished(shot).catch(failed);
  }, []);

  const openMenu = useCallback((shot: Shot, x: number, y: number, from: HTMLElement) => {
    menuFrom.current = from;
    setMenu({ id: shot.id, x, y });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    const from = menuFrom.current;
    menuFrom.current = null;
    // Back to the tile, unless a click outside already moved focus on.
    if (from?.isConnected && (document.activeElement === document.body || document.activeElement?.closest(".shot-menu"))) {
      from.focus({ preventScroll: true });
    }
  }, []);

  /** Asks where to export a shot and exports it there; resolves to the path written, or null when cancelled. */
  async function exportAs(shot: Shot): Promise<string | null> {
    const filters = exportFilters(shot);
    const { stem } = splitFileName(shot.fileName);
    const chosen = await chooseExportFile(`${stem}.${filters[0].extensions[0]}`, { filters });
    if (!chosen) return null;
    const written = await exportShot(shot.id, exportPath(chosen, filters));
    setError(null);
    return written;
  }

  /** Saves tags set from the menu's Add tag submenu; rejects with the backend's reason so the menu can show it. */
  async function saveMenuTags(shot: Shot, tags: string[]) {
    updated(await setShotTags(shot.id, tags));
  }

  /** Takes shots that are gone from the list and the selection, saying how many went. */
  function removedMany(gone: Shot[], trashed: boolean) {
    if (gone.length === 0) return;
    const ids = new Set(gone.map((item) => item.id));
    setShots((current) => current.filter((item) => !ids.has(item.id)));
    setTotal((count) => Math.max(0, count - gone.length));
    setSelection((current) => current.filter((item) => !ids.has(item)));
    const what = itemCount(gone.length);
    setNotice({ text: trashed ? `${what} moved to the Trash` : `${what} deleted`, key: Date.now() });
  }

  /** Adds and removes tags on each of `items`, from the bulk menu's Add tag submenu; rejects saying how many failed. */
  async function saveBulkTags(items: Shot[], change: { add: string[]; remove: string[] }) {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const { errors } = await eachShot(items, async (item) => {
      // The latest tags, as an earlier save may have changed them.
      const current = shownShots.current.find((found) => found.id === item.id) ?? item;
      const kept = current.tags.filter((tag) => !change.remove.some((removed) => same(removed, tag)));
      const next = [...kept, ...change.add.filter((tag) => !kept.some((had) => same(had, tag)))];
      if (sameTags(next, current.tags)) return;
      const saved = await setShotTags(current.id, next);
      shownShots.current = shownShots.current.map((found) => (found.id === saved.id ? saved : found));
      updated(saved);
    });
    if (errors.length > 0) throw new Error(bulkFailure(errors, items.length, (what) => `tag ${what}`));
  }

  /** Runs a bulk menu action on every selected shot, one at a time; partial failures become one error. */
  async function bulkAction(items: Shot[], action: ShotMenuAction) {
    const say = (text: string) => setNotice({ text, key: Date.now() });
    const report = (errors: string[], what: (items: string) => string) => {
      if (errors.length > 0) setError(bulkFailure(errors, items.length, what));
      else setError(null);
    };
    switch (action) {
      case "trash": {
        const { done, errors } = await eachShot(items, (item) => trashShot(item.id));
        removedMany(done, true);
        report(errors, (what) => `move ${what} to the Trash`);
        break;
      }
      case "delete": {
        const { done, errors } = await eachShot(items, (item) => deleteShot(item.id));
        removedMany(done, false);
        report(errors, (what) => `delete ${what}`);
        break;
      }
      case "keep": {
        // All kept already: stop keeping them all; otherwise keep them all.
        const keep = !items.every((item) => item.keep === true);
        const { errors } = await eachShot(
          items.filter((item) => (item.keep === true) !== keep),
          async (item) => {
            const saved = await setShotKeep(item.id, keep);
            setShots((current) => current.map((found) => (found.id === saved.id ? saved : found)));
          },
        );
        report(errors, (what) => (keep ? `keep ${what} forever` : `stop keeping ${what} forever`));
        break;
      }
      case "export": {
        let folder: string | string[] | null;
        try {
          folder = await openDialog({ directory: true, title: `Export ${itemCount(items.length)} to` });
        } catch (err) {
          setError(errorMessage(err));
          return;
        }
        if (typeof folder !== "string") return;
        const target = folder;
        // Each goes in the folder under its own name, numbered when the name is taken.
        const { done, errors } = await eachShot(items, (item) => exportShot(item.id, target));
        if (done.length > 0) say(`Exported ${itemCount(done.length)} to ${baseName(target)}`);
        report(errors, (what) => `export ${what}`);
        break;
      }
      default:
        // Add tag is a submenu; see `saveBulkTags`. The bulk menu offers nothing else.
        break;
    }
  }

  function menuAction(shot: Shot, action: ShotMenuAction) {
    const say = (text: string) => setNotice({ text, key: Date.now() });
    const failed = (err: unknown) => setError(errorMessage(err));
    switch (action) {
      case "open":
        open(shot.id);
        break;
      case "play":
        tileAction(shot, "play");
        break;
      case "openExternal":
        openShotExternally(shot.id).catch(failed);
        break;
      case "openWith":
        openShotWith(shot.id).catch(failed);
        break;
      case "rename":
        // Edited in the menu itself; see `rename`.
        break;
      case "duplicate":
        duplicateShot(shot.id).then((copy) => {
          setError(null);
          say(`Duplicated as ${copy.fileName}`);
          setReloads((count) => count + 1);
        }, failed);
        break;
      case "trash":
        trashShot(shot.id).then(() => deleted(shot.id, true), failed);
        break;
      case "copy":
        tileAction(shot, "copy");
        break;
      case "copyOriginal":
        copyShot(shot.id).then(() => say("Copied the original image"), failed);
        break;
      case "copyText":
        tileAction(shot, "text");
        break;
      case "copyPath":
        copyShotPath(shot.id).then(() => say("Copied the file path"), failed);
        break;
      case "copyFile":
        copyShotFile(shot.id).then(() => say("Copied as a file"), failed);
        break;
      case "export":
        exportAs(shot).then((written) => {
          if (written) say(`Exported to ${baseName(written)}`);
        }, failed);
        break;
      case "tags":
        // A submenu in the menu itself; see `saveMenuTags`.
        break;
      case "pin":
        tileAction(shot, "pin");
        break;
      case "keep":
        toggleKeep(shot);
        break;
      case "redescribe":
        redescribeShot(shot.id).then(() => say("Describing again"), failed);
        break;
      case "reveal":
        tileAction(shot, "reveal");
        break;
      case "openFolder":
        openShotFolder(shot.id).catch(failed);
        break;
      case "details":
        selectOnly(shot.id);
        break;
      case "delete":
        deleteShot(shot.id).then(() => deleted(shot.id), failed);
        break;
    }
  }

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
    selectOnly(Number(next.dataset.shotId));
  }

  // Text searches are ranked by relevance, so they stay in one run; otherwise by day.
  const groups = useMemo(
    () => (query.text ? [{ day: -1, items: shots }] : groupByDay(shots)),
    [shots, query.text],
  );
  const selectedIds = useMemo(() => new Set(selection), [selection]);
  // In the order shown, as the bulk actions run.
  const selectedShots = useMemo(() => shots.filter((shot) => selectedIds.has(shot.id)), [shots, selectedIds]);
  // The details are for one shot: they hide while several are selected.
  const selected = selectedShots.length === 1 ? selectedShots[0] : null;
  const selectedIndex = selected ? shots.indexOf(selected) : -1;
  // Looked up afresh so the menu follows changes (Keep forever) and goes with a deleted shot.
  const menuShot = menu ? shots.find((shot) => shot.id === menu.id) ?? null : null;
  // Right-clicking inside a multi-selection acts on all of it; anywhere else, on the one shot.
  const menuSelection = menu && selectedIds.has(menu.id) && selectedShots.length > 1 ? selectedShots : undefined;
  // Every tag in the library, those on the most loaded shots first.
  const menuTags = useMemo(() => suggestedTags(options.tags, shots, [], options.tags.length), [options.tags, shots]);

  function step(delta: -1 | 1) {
    const next = shots[selectedIndex + delta];
    if (!next) return;
    selectOnly(next.id);
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
            {loaded &&
              (searching ? (
                <span className="count-pill">{total === 1 ? "1 result" : `${total} results`}</span>
              ) : (
                <StoragePill
                  count={total}
                  version={reloads}
                  onCleanUp={() => setCleaning(true)}
                  onOpenSettings={showStorageSettings}
                />
              ))}
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
          hideKindFilter={kindFilter !== undefined}
          now={now}
        />
        <OcrBanner status={ocr} />
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
          // The webview's own menu (Reload, Inspect Element) has nothing for the Library.
          onContextMenu={(event) => event.preventDefault()}
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
                      key={`${shot.id}:${shot.path}`}
                      shot={shot}
                      hit={hits[shot.id]}
                      selected={selectedIds.has(shot.id)}
                      index={tileIndex++}
                      onSelect={pressTile}
                      onOpen={openTile}
                      onAction={tileAction}
                      onKeep={toggleKeep}
                      menuOpen={menu?.id === shot.id}
                      onMenu={openMenu}
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
            onClose={() => selectOnly(null)}
            canStep={{ back: selectedIndex > 0, forward: selectedIndex < shots.length - 1 }}
            onStep={step}
            width={detailsWidth}
            onWidth={setDetailsWidth}
          />
        )}
      </div>
      {notice && (
        <div key={notice.key} className="toast" role="status">
          {notice.text}
        </div>
      )}
      {menu && menuShot && (
        <ShotMenu
          key={`${menu.id}:${menu.x}:${menu.y}`}
          shot={menuShot}
          x={menu.x}
          y={menu.y}
          aiOff={ai?.state === "off"}
          openWith={canOpenWith}
          preview={<Thumbnail shot={menuShot} />}
          onAction={menuAction}
          onRename={rename}
          tagOptions={menuTags}
          onTags={saveMenuTags}
          selection={menuSelection}
          onBulkAction={(items, action) => void bulkAction(items, action)}
          onBulkTags={saveBulkTags}
          onClose={closeMenu}
        />
      )}
      {cleaning && <CleanUpDialog onClose={() => setCleaning(false)} />}
    </main>
  );
}

export default LibraryWindow;
