import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatElapsed } from "../quick/api";
import { isRecording, type Shot } from "./api";
import {
  CopyIcon,
  EditIcon,
  ExternalIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
  LinkIcon,
  PinIcon,
  PlayIcon,
  SparkleIcon,
  StarIcon,
  TextIcon,
  TrashIcon,
} from "./icons";

/** Everything the right-click menu can do to a shot. */
export type ShotMenuAction =
  | "open"
  | "play"
  | "openExternal"
  | "copy"
  | "copyText"
  | "copyPath"
  | "pin"
  | "keep"
  | "redescribe"
  | "reveal"
  | "openFolder"
  | "details"
  | "delete";

interface Entry {
  action: ShotMenuAction;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** Asks again in place before running: the label it shows the second time. */
  confirm?: string;
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
function shotMenuRows(shot: Shot, { aiOff }: { aiOff: boolean }): Row[] {
  const recording = isRecording(shot);
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
  const remove: Entry = {
    action: "delete",
    label: "Delete…",
    icon: <TrashIcon />,
    danger: true,
    confirm: "Click again to delete",
  };
  if (recording) {
    return [
      { action: "play", label: "Play", icon: <PlayIcon /> },
      ...(shot.kind === "video" ? [{ action: "open", label: "Edit in recording editor", icon: <EditIcon /> } as Entry] : []),
      "separator",
      ...files,
      "separator",
      keep,
      { action: "details", label: "Show details", icon: <InfoIcon /> },
      "separator",
      remove,
    ];
  }
  return [
    { action: "open", label: "Open in editor", icon: <EditIcon /> },
    { action: "openExternal", label: "Open in default app", icon: <ExternalIcon /> },
    "separator",
    { action: "copy", label: "Copy image", icon: <CopyIcon /> },
    { action: "copyText", label: "Copy text in image", icon: <TextIcon /> },
    { action: "pin", label: "Pin to screen", icon: <PinIcon /> },
    "separator",
    ...files,
    "separator",
    keep,
    ...(aiOff ? [] : [{ action: "redescribe", label: "Describe again", icon: <SparkleIcon /> } as Entry]),
    { action: "details", label: "Show details", icon: <InfoIcon /> },
    "separator",
    remove,
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

interface ShotMenuProps {
  shot: Shot;
  /** Where it opened, in viewport pixels. */
  x: number;
  y: number;
  aiOff: boolean;
  /** A small preview for the header. */
  preview: ReactNode;
  onAction: (shot: Shot, action: ShotMenuAction) => void;
  onClose: () => void;
}

/** The right-click menu for one shot in the Library. */
export function ShotMenu({ shot, x, y, aiOff, preview, onAction, onClose }: ShotMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  const rows = shotMenuRows(shot, { aiOff });
  const entries = rows.filter((row): row is Entry => row !== "separator");
  const [active, setActive] = useState(0);
  const [armed, setArmed] = useState<ShotMenuAction | null>(null);

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

  function run(entry: Entry) {
    if (entry.confirm && armed !== entry.action) {
      setArmed(entry.action);
      return;
    }
    onClose();
    onAction(shot, entry.action);
  }

  function move(index: number) {
    setActive((index + entries.length) % entries.length);
    setArmed(null);
  }

  function onKeyDown(event: globalThis.KeyboardEvent) {
    // While open the menu has the keyboard, whatever has focus (a right
    // click leaves it on the tile in some webviews).
    event.stopPropagation();
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
      aria-activedescendant={`shot-menu-${entries[active]?.action}`}
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
        const mine = order.get(row.action) ?? 0;
        const confirming = armed === row.action;
        return (
          <div
            key={row.action}
            id={`shot-menu-${row.action}`}
            role="menuitem"
            className={`shot-menu-item${mine === active ? " is-active" : ""}${row.danger ? " is-danger" : ""}${confirming ? " is-confirming" : ""}`}
            onMouseEnter={() => {
              setActive(mine);
              if (armed && armed !== row.action) setArmed(null);
            }}
            onClick={() => run(row)}
          >
            {row.icon}
            <span className="shot-menu-label">{confirming ? row.confirm : row.label}</span>
          </div>
        );
      })}
    </div>
  );
}
