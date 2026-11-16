import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatElapsed } from "../quick/api";
import { isRecording, parseTags, splitFileName, type Shot } from "./api";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyFileIcon,
  CopyIcon,
  DeleteForeverIcon,
  DuplicateIcon,
  EditIcon,
  ExportIcon,
  ExternalIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
  LinkIcon,
  OpenWithIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  RenameIcon,
  SparkleIcon,
  StarIcon,
  TagIcon,
  TextIcon,
  TrashIcon,
} from "./icons";

/** Everything the right-click menu can do to a shot. */
export type ShotMenuAction =
  | "open"
  | "play"
  | "openExternal"
  | "openWith"
  | "copy"
  | "copyFile"
  | "copyText"
  | "copyPath"
  | "pin"
  | "keep"
  | "redescribe"
  | "reveal"
  | "openFolder"
  | "details"
  | "rename"
  | "duplicate"
  | "export"
  | "tags"
  | "trash"
  | "delete";

interface Entry {
  action: ShotMenuAction;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** Asks again in place before running: the label it shows the second time. */
  confirm?: string;
  /** Opens a submenu beside it rather than running. */
  submenu?: boolean;
}

type Row = Entry | "separator";

/** Where the file manager is called on this system, for "Show in …". */
function fileManager(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac/i.test(platform)) return "Finder";
  if (/Windows/i.test(platform)) return "Explorer";
  return "file manager";
}

/** The menu's rows for `shot`, separators between groups. */
function shotMenuRows(shot: Shot, { aiOff, openWith }: { aiOff: boolean; openWith: boolean }): Row[] {
  const recording = isRecording(shot);
  // Only where the system has its own app chooser to show.
  const chooser: Entry[] = openWith ? [{ action: "openWith", label: "Open with…", icon: <OpenWithIcon /> }] : [];
  const edit: Row[] = [
    { action: "rename", label: "Rename…", icon: <RenameIcon /> },
    { action: "duplicate", label: "Duplicate", icon: <DuplicateIcon /> },
    { action: "export", label: "Export…", icon: <ExportIcon /> },
  ];
  const copyFile: Entry = { action: "copyFile", label: "Copy as file", icon: <CopyFileIcon /> };
  const tags: Entry = { action: "tags", label: "Add tag", icon: <TagIcon />, submenu: true };
  const keep: Entry = {
    action: "keep",
    label: shot.keep ? "Stop keeping forever" : "Keep forever",
    icon: <StarIcon filled={shot.keep === true} />,
  };
  const files: Row[] = [
    { action: "reveal", label: `Show in ${fileManager()}`, icon: <FolderIcon /> },
    { action: "openFolder", label: "Open containing folder", icon: <FolderOpenIcon /> },
    { action: "copyPath", label: "Copy file path", icon: <LinkIcon /> },
  ];
  // The Trash first: it can be undone there. Deleting for good asks again.
  const remove: Row[] = [
    { action: "trash", label: "Move to Trash", icon: <TrashIcon /> },
    {
      action: "delete",
      label: "Delete permanently…",
      icon: <DeleteForeverIcon />,
      danger: true,
      confirm: "Click again to delete for good",
    },
  ];
  if (recording) {
    return [
      { action: "play", label: "Play", icon: <PlayIcon /> },
      ...(shot.kind === "video" ? [{ action: "open", label: "Edit in recording editor", icon: <EditIcon /> } as Entry] : []),
      ...chooser,
      "separator",
      copyFile,
      "separator",
      ...edit,
      "separator",
      ...files,
      "separator",
      tags,
      keep,
      { action: "details", label: "Show details", icon: <InfoIcon /> },
      "separator",
      ...remove,
    ];
  }
  return [
    { action: "open", label: "Open in editor", icon: <EditIcon /> },
    { action: "openExternal", label: "Open in default app", icon: <ExternalIcon /> },
    ...chooser,
    "separator",
    { action: "copy", label: "Copy image", icon: <CopyIcon /> },
    copyFile,
    { action: "copyText", label: "Copy text in image", icon: <TextIcon /> },
    { action: "pin", label: "Pin to screen", icon: <PinIcon /> },
    "separator",
    ...edit,
    "separator",
    ...files,
    "separator",
    tags,
    keep,
    ...(aiOff ? [] : [{ action: "redescribe", label: "Describe again", icon: <SparkleIcon /> } as Entry]),
    { action: "details", label: "Show details", icon: <InfoIcon /> },
    "separator",
    ...remove,
  ];
}

/** What the menu's header says under the title. */
function headerMeta(shot: Shot): string {
  if (isRecording(shot)) {
    return [
      shot.kind === "gif" ? "GIF" : "Video",
      shot.durationMs != null ? formatElapsed(shot.durationMs) : null,
      shot.bytes != null ? formatBytes(shot.bytes) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return ["Screenshot", shot.width > 0 ? `${shot.width} × ${shot.height}` : null, shot.app].filter(Boolean).join(" · ");
}

/** The gap the menu keeps from the window's edges. */
const EDGE = 8;

/** How wide the Add tag submenu is, as library.css draws it. */
const SUBMENU_WIDTH = 210;

/** How many tags the Add tag submenu suggests besides the shot's own. */
const SUGGESTED_TAGS = 8;

interface ShotMenuProps {
  shot: Shot;
  /** Where it opened, in viewport pixels. */
  x: number;
  y: number;
  aiOff: boolean;
  /** Offer Open with…: the system can ask which app to use. */
  openWith?: boolean;
  /** A small preview for the header. */
  preview: ReactNode;
  onAction: (shot: Shot, action: ShotMenuAction) => void;
  /** Renames the shot's file to `name` (without its extension); rejects with why it could not. */
  onRename: (shot: Shot, name: string) => Promise<void>;
  /** Tags the Add tag submenu offers besides the shot's own, most used first. */
  tagOptions?: string[];
  /** Saves the shot's tags as `tags`; rejects with why it could not. */
  onTags?: (shot: Shot, tags: string[]) => Promise<void>;
  onClose: () => void;
}

/** What a rejected rename or tag save says, for the line under it. */
function failure(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return fallback;
}

const hasTag = (tags: string[], tag: string) => tags.some((item) => item.toLowerCase() === tag.toLowerCase());

/** The right-click menu for one shot in the Library. */
export function ShotMenu({
  shot,
  x,
  y,
  aiOff,
  openWith = false,
  preview,
  onAction,
  onRename,
  tagOptions = [],
  onTags,
  onClose,
}: ShotMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const tagField = useRef<HTMLInputElement>(null);
  const tagsItem = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  const rows = shotMenuRows(shot, { aiOff, openWith });
  const entries = rows.filter((row): row is Entry => row !== "separator");
  const [active, setActive] = useState(0);
  const [armed, setArmed] = useState<ShotMenuAction | null>(null);
  /** Rename… turned its row into a name field: what is typed there. */
  const [draft, setDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const renaming = draft !== null;
  const { stem, extension } = splitFileName(shot.fileName);

  /** The tags the submenu has set while its saves are still landing; then the shot's own. */
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const tags = optimistic ?? shot.tags;
  /** The submenu's rows while it is open, so unchecking a tag leaves its row. */
  const [tagRows, setTagRows] = useState<string[] | null>(null);
  const tagsOpen = tagRows !== null;
  /** The submenu row the keyboard is on; the last is New tag…, and -1 is none. */
  const [tagActive, setTagActive] = useState(-1);
  /** New tag… turned its row into a field: what is typed there. */
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const typingTag = tagDraft !== null;
  const [subPosition, setSubPosition] = useState<{ top: number; left: boolean }>({ top: 0, left: false });
  const tagCount = tagRows?.length ?? 0;
  const tagSaves = useRef<Promise<unknown>>(Promise.resolve());
  const pendingTags = useRef(0);

  useEffect(() => {
    if (typingTag) tagField.current?.focus({ preventScroll: true });
  }, [typingTag]);

  // Beside the Add tag row, on whichever side has room, and kept inside the window.
  useLayoutEffect(() => {
    if (!tagsOpen || !root.current || !tagsItem.current) return;
    const menu = root.current.getBoundingClientRect();
    const height = submenu.current?.getBoundingClientRect().height ?? 0;
    const left = menu.right + SUBMENU_WIDTH > window.innerWidth - EDGE;
    let top = tagsItem.current.offsetTop - 4;
    const overflow = menu.top + top + height - (window.innerHeight - EDGE);
    if (overflow > 0) top = Math.max(EDGE - menu.top, top - overflow);
    setSubPosition({ top, left });
  }, [tagsOpen, tagCount]);

  useEffect(() => {
    if (!renaming) return;
    nameField.current?.focus({ preventScroll: true });
    nameField.current?.select();
  }, [renaming]);

  // Kept inside the window: flipped left or up when it would run off an edge.
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const room = { w: window.innerWidth, h: window.innerHeight };
    let left = x;
    let top = y;
    if (left + width > room.w - EDGE) left = Math.max(EDGE, x - width);
    if (top + height > room.h - EDGE) top = Math.max(EDGE, room.h - EDGE - height);
    setPosition({ left, top, ready: true });
  }, [x, y]);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  // Closed by a press outside it, scrolling, resizing or leaving the window.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onScroll = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function openTags(active: number) {
    if (!tagsOpen) setTagRows([...tags, ...tagOptions.filter((tag) => !hasTag(tags, tag)).slice(0, SUGGESTED_TAGS)]);
    setTagActive(active);
    setArmed(null);
  }

  function closeTags() {
    setTagRows(null);
    setTagActive(-1);
    setTagDraft(null);
    setTagError(null);
    root.current?.focus({ preventScroll: true });
  }

  /** Saves `next` as the shot's tags, one save at a time, in order. */
  function saveTags(next: string[]) {
    if (!onTags) return;
    setOptimistic(next);
    setTagError(null);
    pendingTags.current += 1;
    tagSaves.current = tagSaves.current
      .then(() => onTags(shot, next))
      .catch((err: unknown) => setTagError(failure(err, "Could not save the tags.")))
      .finally(() => {
        pendingTags.current -= 1;
        // Once every save has landed the shot says what was saved.
        if (pendingTags.current === 0) setOptimistic(null);
      });
  }

  function toggleTag(tag: string) {
    saveTags(hasTag(tags, tag) ? tags.filter((item) => item.toLowerCase() !== tag.toLowerCase()) : [...tags, tag]);
  }

  function startNewTag() {
    setTagActive(tagRows?.length ?? 0);
    setTagError(null);
    setTagDraft("");
  }

  function cancelNewTag() {
    setTagDraft(null);
    root.current?.focus({ preventScroll: true });
  }

  function saveNewTag() {
    if (tagDraft === null) return;
    const added: string[] = [];
    for (const tag of parseTags(tagDraft)) {
      if (!hasTag(tags, tag) && !hasTag(added, tag)) added.push(tag);
    }
    setTagDraft(null);
    root.current?.focus({ preventScroll: true });
    if (added.length === 0) return;
    // A tag offered but not checked yet is checked rather than listed twice.
    const rows = tagRows ?? [];
    const listed = [...rows, ...added.filter((tag) => !hasTag(rows, tag))];
    setTagRows(listed);
    setTagActive(listed.length);
    saveTags([...tags, ...added]);
  }

  /** Runs the submenu row at `index`: toggles a tag, or New tag… opens its field. */
  function runTag(index: number) {
    const rows = tagRows ?? [];
    if (index === rows.length) startNewTag();
    else if (rows[index] !== undefined) toggleTag(rows[index]);
  }

  function onTagKeyDown(event: globalThis.KeyboardEvent) {
    const count = (tagRows?.length ?? 0) + 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setTagActive((tagActive + 1 + count) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        setTagActive((Math.max(tagActive, 0) - 1 + count) % count);
        break;
      case "Home":
        event.preventDefault();
        setTagActive(0);
        break;
      case "End":
        event.preventDefault();
        setTagActive(count - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        runTag(tagActive);
        break;
      case "ArrowLeft":
      case "Escape":
        // Back to the menu, which stays open.
        event.preventDefault();
        closeTags();
        break;
      case "Tab":
        event.preventDefault();
        onClose();
        break;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          const rows = tagRows ?? [];
          const letter = event.key.toLowerCase();
          for (let step = 1; step <= rows.length; step++) {
            const index = (Math.max(tagActive, 0) + step) % rows.length;
            if (rows[index].toLowerCase().startsWith(letter)) {
              setTagActive(index);
              break;
            }
          }
        }
    }
  }

  function run(entry: Entry) {
    if (entry.submenu) {
      openTags(0);
      return;
    }
    if (entry.action === "rename") {
      if (tagsOpen) closeTags();
      setArmed(null);
      setRenameError(null);
      setDraft(stem);
      return;
    }
    if (entry.confirm && armed !== entry.action) {
      setArmed(entry.action);
      return;
    }
    onClose();
    onAction(shot, entry.action);
  }

  function cancelRename() {
    setDraft(null);
    setRenameError(null);
    root.current?.focus({ preventScroll: true });
  }

  function saveRename() {
    if (draft === null || saving) return;
    const name = draft.trim();
    if (!name) {
      setRenameError("Give it a name.");
      return;
    }
    if (name === stem) {
      onClose();
      return;
    }
    setSaving(true);
    onRename(shot, name).then(
      () => onClose(),
      (err: unknown) => {
        setSaving(false);
        setRenameError(failure(err, "Could not rename it."));
        nameField.current?.focus({ preventScroll: true });
      },
    );
  }

  function move(index: number) {
    setActive((index + entries.length) % entries.length);
    setArmed(null);
    if (tagsOpen) closeTags();
  }

  function onKeyDown(event: globalThis.KeyboardEvent) {
    if (renaming) {
      // The name field types; Enter saves and Escape goes back to the menu.
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") saveRename();
        else cancelRename();
      }
      return;
    }
    if (tagDraft !== null) {
      // The tag field types; Enter adds the tag and Escape goes back to the submenu.
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") saveNewTag();
        else cancelNewTag();
      }
      return;
    }
    // While open the menu has the keyboard, whatever has focus (a right
    // click leaves it on the tile in some webviews).
    event.stopPropagation();
    // The submenu has the keyboard once a row in it is active; opened by
    // hovering, it waits for the right arrow.
    if (tagsOpen && tagActive >= 0) {
      onTagKeyDown(event);
      return;
    }
    if (tagsOpen && event.key === "ArrowRight") {
      event.preventDefault();
      setTagActive(0);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(active + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(active - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(entries.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (entries[active]?.submenu) openTags(0);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (entries[active]) run(entries[active]);
        break;
      case "Escape":
        // Marked handled so the Library does not also close the details.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        event.preventDefault();
        onClose();
        break;
      case "Shift":
      case "Control":
      case "Alt":
      case "Meta":
        break;
      default:
        event.preventDefault();
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          // Type a letter to jump to the next entry starting with it.
          const letter = event.key.toLowerCase();
          for (let step = 1; step <= entries.length; step++) {
            const index = (active + step) % entries.length;
            if (entries[index].label.toLowerCase().startsWith(letter)) {
              move(index);
              break;
            }
          }
        }
    }
  }

  const keyHandler = useRef(onKeyDown);
  useEffect(() => {
    keyHandler.current = onKeyDown;
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  const order = new Map(entries.map((entry, at) => [entry.action, at]));
  return (
    <div
      ref={root}
      role="menu"
      aria-label={`Actions for ${shot.fileName}`}
      aria-activedescendant={
        renaming || typingTag
          ? undefined
          : tagsOpen && tagActive >= 0
            ? `shot-menu-tag-${tagActive}`
            : `shot-menu-${entries[active]?.action}`
      }
      tabIndex={-1}
      className={`shot-menu${position.ready ? " is-ready" : ""}`}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="shot-menu-head" aria-hidden="true">
        <span className={`shot-menu-thumb${isRecording(shot) ? " is-recording" : ""}`}>{preview}</span>
        <span className="shot-menu-title">
          <span className="shot-menu-name">{shot.windowTitle || shot.fileName}</span>
          <span className="shot-menu-meta">{headerMeta(shot)}</span>
        </span>
      </div>
      {rows.map((row, rowIndex) => {
        if (row === "separator") return <div key={`sep-${rowIndex}`} role="separator" className="shot-menu-sep" />;
        if (row.action === "rename" && draft !== null) {
          return (
            <div key="rename" className="shot-menu-rename" role="none">
              <div className={`shot-menu-rename-row${renameError ? " is-invalid" : ""}`}>
                {row.icon}
                <input
                  ref={nameField}
                  className="shot-menu-rename-input"
                  aria-label="New name"
                  aria-invalid={renameError ? true : undefined}
                  aria-describedby={renameError ? "shot-menu-rename-error" : undefined}
                  value={draft}
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setRenameError(null);
                  }}
                />
                {extension && <span className="shot-menu-rename-ext">{extension}</span>}
              </div>
              {renameError && (
                <div id="shot-menu-rename-error" className="shot-menu-rename-error" role="alert">
                  {renameError}
                </div>
              )}
            </div>
          );
        }
        const mine = order.get(row.action) ?? 0;
        const confirming = armed === row.action;
        const expanded = row.submenu && tagsOpen;
        return (
          <div
            key={row.action}
            ref={row.submenu ? tagsItem : undefined}
            id={`shot-menu-${row.action}`}
            role="menuitem"
            aria-haspopup={row.submenu ? "menu" : undefined}
            aria-expanded={row.submenu ? tagsOpen : undefined}
            className={`shot-menu-item${mine === active ? " is-active" : ""}${row.danger ? " is-danger" : ""}${confirming ? " is-confirming" : ""}${expanded ? " is-expanded" : ""}`}
            onMouseEnter={() => {
              setActive(mine);
              if (armed && armed !== row.action) setArmed(null);
              if (row.submenu && !renaming) openTags(-1);
              else if (!row.submenu && tagsOpen && !typingTag) closeTags();
            }}
            onClick={() => run(row)}
          >
            {row.icon}
            <span className="shot-menu-label">{confirming ? row.confirm : row.label}</span>
            {row.submenu && (
              <span className="shot-menu-more">
                <ChevronRightIcon />
              </span>
            )}
          </div>
        );
      })}
      {tagRows && (
        <div
          ref={submenu}
          role="menu"
          aria-label="Tags"
          className={`shot-menu shot-menu-sub is-ready${subPosition.left ? " is-left" : ""}`}
          style={{ top: subPosition.top }}
        >
          {tagRows.map((tag, index) => {
            const checked = hasTag(tags, tag);
            return (
              <div
                key={tag.toLowerCase()}
                id={`shot-menu-tag-${index}`}
                role="menuitemcheckbox"
                aria-checked={checked}
                className={`shot-menu-item${index === tagActive ? " is-active" : ""}`}
                onMouseEnter={() => setTagActive(index)}
                onClick={() => runTag(index)}
              >
                <span className="shot-menu-check">{checked && <CheckIcon />}</span>
                <span className="shot-menu-label">{tag}</span>
              </div>
            );
          })}
          {tagRows.length > 0 && <div role="separator" className="shot-menu-sep" />}
          {!typingTag ? (
            <div
              id={`shot-menu-tag-${tagRows.length}`}
              role="menuitem"
              className={`shot-menu-item${tagActive === tagRows.length ? " is-active" : ""}`}
              onMouseEnter={() => setTagActive(tagRows.length)}
              onClick={startNewTag}
            >
              <PlusIcon />
              <span className="shot-menu-label">New tag…</span>
            </div>
          ) : (
            <div className="shot-menu-rename" role="none">
              <div className="shot-menu-rename-row">
                <TagIcon />
                <input
                  ref={tagField}
                  className="shot-menu-rename-input"
                  aria-label="New tag"
                  placeholder="Tag name"
                  value={tagDraft ?? ""}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setTagDraft(event.target.value)}
                />
              </div>
            </div>
          )}
          {tagError && (
            <div className="shot-menu-rename-error" role="alert">
              {tagError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
