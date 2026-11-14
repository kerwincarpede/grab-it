import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./app.css";
import {
  ChevronDownIcon,
  ColourIcon,
  GridIcon,
  KeyboardIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  SlidersIcon,
  TextIcon,
  WindowIcon,
} from "./icons";
import { onNavigate, startCapture, type CaptureKind, type MainView } from "./api";
import Dialog from "./Dialog";
import SettingsDialog from "./SettingsDialog";
import UpdateDialog from "./UpdateDialog";
import {
  checkForUpdate,
  currentVersion,
  installUpdate,
  onUpdateStatus,
  pendingUpdate,
  updateLater,
  updateStatus,
  type UpdateStatus,
} from "./updates";
import LibraryWindow from "../library/LibraryWindow";
import WelcomeWindow from "../welcome/WelcomeWindow";
import { getSettings, type SettingsSection } from "../settings/api";
import { onLibraryChanged, sidebarSummary, type SidebarSummary } from "../library/api";
import { tagStyle } from "../library/tagColor";
import { shortcutLabel } from "../hub/keys";

/** The other captures, under the New capture button. */
const MORE_CAPTURES: { kind: CaptureKind; title: string; icon: ReactNode }[] = [
  { kind: "window", title: "Capture window", icon: <WindowIcon /> },
  { kind: "screen", title: "Capture screen", icon: <ScreenIcon /> },
  { kind: "record", title: "Record GIF", icon: <RecordIcon /> },
  { kind: "text", title: "Capture text", icon: <TextIcon /> },
  { kind: "colour", title: "Pick a colour", icon: <ColourIcon /> },
];

/** Which dialog is over the window, if any. */
type Open = { kind: "settings"; section: SettingsSection } | { kind: "welcome" } | { kind: "updates" } | null;

/** The library filter the sidebar sets. */
interface Place {
  app: string;
  tag: string;
}

const EVERYTHING: Place = { app: "", tag: "" };

function dialogFor(view: MainView): Open {
  if (view === "settings") return { kind: "settings", section: "general" };
  if (view === "welcome") return { kind: "welcome" };
  return null;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

interface NavItemProps {
  current?: boolean;
  icon: ReactNode;
  count?: number;
  hint?: string;
  children: ReactNode;
  onClick: () => void;
}

function NavItem({ current = false, icon, count, hint, children, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      className={`nav-item${current ? " is-current" : ""}`}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="nav-label">{children}</span>
      {count !== undefined && (
        <span className="nav-count" aria-hidden="true">
          {count}
        </span>
      )}
      {hint && (
        <kbd className="nav-count" aria-hidden="true">
          {hint}
        </kbd>
      )}
    </button>
  );
}

/** The New capture button and its menu of the other captures. */
function CaptureButton({ hotkey, onError }: { hotkey: string | null; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  function capture(kind: CaptureKind) {
    setOpen(false);
    startCapture(kind).catch((err: unknown) => onError(errorMessage(err)));
  }

  return (
    <div className="capture-split" ref={box}>
      <button type="button" className="capture-main" title="Capture a region" onClick={() => capture("region")}>
        <RegionIcon size={15} />
        New capture
        {hotkey && (
          <kbd className="capture-key" aria-hidden="true">
            {shortcutLabel(hotkey)}
          </kbd>
        )}
      </button>
      <button
        type="button"
        className="capture-more"
        aria-label="More captures"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="capture-menu" role="menu">
          {MORE_CAPTURES.map(({ kind, title, icon }) => (
            <button type="button" role="menuitem" key={kind} onClick={() => capture(kind)}>
              {icon}
              {title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The version, or the update waiting to be installed. */
function UpdateSlot({ status, onOpen, onCheck }: { status: UpdateStatus | null; onOpen: () => void; onCheck: () => void }) {
  const pending = pendingUpdate(status);
  if (pending && status?.state === "installing") {
    const percent = status.total ? Math.round((status.downloaded * 100) / status.total) : null;
    return (
      <button type="button" className="update-card" onClick={onOpen}>
        <span className="update-card-text">
          <b>Installing {pending.version}</b>
          <small>{percent === null ? "Downloading…" : `${percent}% downloaded`}</small>
        </span>
      </button>
    );
  }
  if (pending) {
    return (
      <div className="update-card">
        <span className="update-card-text">
          <b>Update available</b>
          <small>Version {pending.version}</small>
        </span>
        <button type="button" className="btn btn-primary btn-small" onClick={onOpen}>
          View
        </button>
      </div>
    );
  }
  const version = currentVersion(status);
  return (
    <p className="version">
      <span className="version-dot" aria-hidden="true" />
      {version && <span>v{version}</span>}
      {status?.state === "upToDate" ? (
        <span className="version-note">Up to date</span>
      ) : (
        <button type="button" className="link-button version-note" disabled={status?.state === "checking"} onClick={onCheck}>
          {status?.state === "checking" ? "Checking…" : "Check for updates"}
        </button>
      )}
    </p>
  );
}

/**
 * The Grab-it window: the library, with apps and tags down the side, and
 * Settings, the welcome and updates in dialogs over it.
 */
function AppWindow({ initialView = "library" }: { initialView?: MainView }) {
  const [place, setPlace] = useState<Place>(EVERYTHING);
  const [open, setOpen] = useState<Open>(() => dialogFor(initialView));
  const [summary, setSummary] = useState<SidebarSummary | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regionHotkey, setRegionHotkey] = useState<string | null>(null);

  // Read again whenever a dialog closes, so a hotkey changed in Settings shows.
  const settingsOpen = open?.kind === "settings";
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setRegionHotkey(settings?.hotkeys?.region || null);
      })
      .catch(() => {
        // The button works without its hotkey label.
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onNavigate((view) => setOpen(dialogFor(view)))
      .then((stop) => (disposed ? stop() : (unlisten = stop)))
      .catch(() => {
        // Outside Tauri (tests) there is nothing to listen to.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const load = () =>
      sidebarSummary()
        .then((found) => {
          if (!cancelled && Array.isArray(found?.apps)) setSummary(found);
        })
        .catch(() => {
          // The sidebar still offers every capture.
        });
    void load();
    onLibraryChanged(() => void load())
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    updateStatus()
      .then((status) => {
        if (!cancelled && status?.state) setUpdate(status);
      })
      .catch(() => {});
    onUpdateStatus(({ status, show }) => {
      setUpdate(status);
      if (show) setOpen({ kind: "updates" });
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ⌘, opens Settings, as in every Mac app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen({ kind: "settings", section: "general" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickApp = useCallback((app: string) => setPlace((was) => ({ ...was, app })), []);
  const pickTag = useCallback((tag: string) => setPlace((was) => ({ ...was, tag })), []);
  const close = useCallback(() => setOpen(null), []);

  function run(action: () => Promise<void>) {
    action().catch((err: unknown) => setError(errorMessage(err)));
  }

  const apps = summary?.apps ?? [];
  const tags = summary?.tags ?? [];
  const everything = place.app === "" && place.tag === "";
  const title = place.app || (place.tag ? `Tagged ${place.tag}` : "All captures");

  return (
    <div className="app-window">
      <nav className="sidebar" aria-label="Grab-it">
        <div className="sidebar-top" data-tauri-drag-region />
        <NavItem current={everything} icon={<GridIcon size={15} />} count={summary?.total} onClick={() => setPlace(EVERYTHING)}>
          All captures
        </NavItem>

        {apps.length > 0 && <h2 className="nav-heading">Apps</h2>}
        {apps.map(({ name, count }) => (
          <NavItem
            key={name}
            current={place.app === name}
            icon={
              <span className="app-letter" aria-hidden="true">
                {[...name.trim()][0]?.toUpperCase() ?? "?"}
              </span>
            }
            count={count}
            onClick={() => setPlace({ app: name, tag: "" })}
          >
            {name}
          </NavItem>
        ))}

        {tags.length > 0 && <h2 className="nav-heading">Tags</h2>}
        {tags.length > 0 && (
          <div className="tag-cloud">
            {tags.map(({ name }) => (
              <button
                key={name}
                type="button"
                className="tag-link"
                style={tagStyle(name)}
                aria-pressed={place.tag.toLowerCase() === name.toLowerCase()}
                onClick={() => setPlace({ app: "", tag: place.tag === name ? "" : name })}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-foot">
          <NavItem icon={<KeyboardIcon size={15} />} onClick={() => setOpen({ kind: "welcome" })}>
            Shortcuts and tips
          </NavItem>
          <NavItem icon={<SlidersIcon size={15} />} hint="⌘," onClick={() => setOpen({ kind: "settings", section: "general" })}>
            Settings
          </NavItem>
          <UpdateSlot status={update} onOpen={() => setOpen({ kind: "updates" })} onCheck={() => run(checkForUpdate)} />
        </div>
      </nav>

      <div className="app-content">
        {error && (
          <p role="alert" className="app-error">
            {error}
            <button type="button" className="link-button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </p>
        )}
        <LibraryWindow
          title={title}
          appFilter={place.app}
          onAppFilter={pickApp}
          tagFilter={place.tag}
          onTagFilter={pickTag}
          toolbarEnd={<CaptureButton hotkey={regionHotkey} onError={setError} />}
        />
      </div>

      {open?.kind === "settings" && (
        <SettingsDialog section={open.section} onSection={(section) => setOpen({ kind: "settings", section })} onClose={close} />
      )}
      {open?.kind === "welcome" && (
        <Dialog title="Welcome to Grab-it" hideTitle className="welcome-dialog" onClose={close}>
          <WelcomeWindow onClose={close} />
        </Dialog>
      )}
      {open?.kind === "updates" && update && (
        <UpdateDialog
          status={update}
          onClose={close}
          onCheck={() => run(checkForUpdate)}
          onInstall={() => run(installUpdate)}
          onLater={() => {
            close();
            run(updateLater);
          }}
        />
      )}
    </div>
  );
}

export default AppWindow;
