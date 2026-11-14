import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import "./app.css";
import Logo from "./Logo";
import {
  ChevronDownIcon,
  ColourIcon,
  GearIcon,
  GridIcon,
  KeyboardIcon,
  PenIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  SparkleIcon,
  TextIcon,
  WindowIcon,
} from "./icons";
import { checkForUpdates, onNavigate, startCapture, type CaptureKind, type MainView, type Place } from "./api";
import LibraryWindow from "../library/LibraryWindow";
import SettingsWindow from "../settings/SettingsWindow";
import WelcomeWindow from "../welcome/WelcomeWindow";
import { getSettings, SETTINGS_SECTIONS, type SettingsSection } from "../settings/api";
import { filterOptions, onLibraryChanged } from "../library/api";
import { shortcutLabel } from "../hub/keys";

/** The other captures, under the Capture region button. */
const MORE_CAPTURES: { kind: CaptureKind; title: string; icon: ReactNode }[] = [
  { kind: "window", title: "Capture window", icon: <WindowIcon /> },
  { kind: "screen", title: "Capture screen", icon: <ScreenIcon /> },
  { kind: "record", title: "Record GIF", icon: <RecordIcon /> },
  { kind: "text", title: "Capture text", icon: <TextIcon /> },
  { kind: "colour", title: "Pick a colour", icon: <ColourIcon /> },
];

/** Each Settings page's icon and tint in the sidebar. */
const SECTION_ICONS: Record<SettingsSection, { tint: string; icon: ReactNode }> = {
  general: { tint: "gray", icon: <GearIcon size={14} /> },
  capture: { tint: "blue", icon: <RegionIcon size={14} /> },
  editor: { tint: "pink", icon: <PenIcon size={14} /> },
  ai: { tint: "purple", icon: <SparkleIcon size={14} /> },
  hotkeys: { tint: "green", icon: <KeyboardIcon size={14} /> },
};

/** The tints an app's chip can take; the app's name picks one, so it never changes. */
const APP_TINTS = ["amber", "orange", "green", "blue", "purple", "pink", "teal", "violet", "red", "gray"];

function appTint(app: string): string {
  let hash = 0;
  for (const char of app) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return APP_TINTS[hash % APP_TINTS.length];
}

/** A tinted chip with an icon or a letter, for the sidebar. */
function Chip({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <span className={`icon-chip tint-${tint}`} aria-hidden="true">
      {children}
    </span>
  );
}

function placeFor(view: MainView): Place {
  if (view === "settings") return { view: "settings", section: "general" };
  if (view === "welcome") return { view: "welcome" };
  return { view: "library", app: "" };
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

interface NavItemProps {
  current: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
}

function NavItem({ current, icon, children, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      className={`nav-item${current ? " is-current" : ""}`}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="nav-label">{children}</span>
    </button>
  );
}

/** The Capture region button and its menu of the other captures. */
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
      <button type="button" className="capture-main cta" title="Capture a region" onClick={() => capture("region")}>
        <RegionIcon />
        New capture
        {hotkey && (
          <kbd className="cta-key" aria-hidden="true">
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
        <ChevronDownIcon size={14} />
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

/**
 * The Grab-it window: one place for the library, Settings and the
 * shortcuts, with the logo and a capture button always in view.
 */
function AppWindow({ initialView = "library" }: { initialView?: MainView }) {
  const [place, setPlace] = useState<Place>(() => placeFor(initialView));
  const [apps, setApps] = useState<string[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regionHotkey, setRegionHotkey] = useState<string | null>(null);

  // Read again on every move, so a hotkey changed in Settings shows here too.
  useEffect(() => {
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
  }, [place.view]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onNavigate((view) => setPlace((current) => (current.view === view ? current : placeFor(view))))
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
      filterOptions()
        .then((options) => {
          if (!cancelled && Array.isArray(options?.apps)) setApps(options.apps);
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
    getVersion()
      .then((found) => setVersion(typeof found === "string" ? found : null))
      .catch(() => {});
  }, []);

  const pickApp = useCallback((app: string) => setPlace({ view: "library", app }), []);

  function checkUpdates() {
    checkForUpdates().catch((err: unknown) => setError(errorMessage(err)));
  }

  return (
    <div className="app-window">
      <nav className="sidebar" aria-label="Grab-it">
        <div className="brand">
          <Logo size={32} />
          <span className="brand-name">Grab-it</span>
        </div>
        <CaptureButton hotkey={regionHotkey} onError={setError} />

        <h2 className="nav-heading">Library</h2>
        <NavItem
          current={place.view === "library" && place.app === ""}
          icon={
            <Chip tint="blue">
              <GridIcon size={14} />
            </Chip>
          }
          onClick={() => pickApp("")}
        >
          All captures
        </NavItem>
        {apps.length > 0 && <h2 className="nav-heading">Apps</h2>}
        {apps.map((app) => (
          <NavItem
            key={app}
            current={place.view === "library" && place.app === app}
            icon={<Chip tint={appTint(app)}>{[...app.trim()][0]?.toUpperCase() ?? "?"}</Chip>}
            onClick={() => pickApp(app)}
          >
            {app}
          </NavItem>
        ))}

        <h2 className="nav-heading">Settings</h2>
        {SETTINGS_SECTIONS.map(({ id, title }) => (
          <NavItem
            key={id}
            current={place.view === "settings" && place.section === id}
            icon={<Chip tint={SECTION_ICONS[id].tint}>{SECTION_ICONS[id].icon}</Chip>}
            onClick={() => setPlace({ view: "settings", section: id })}
          >
            {title}
          </NavItem>
        ))}

        <div className="sidebar-foot">
          <NavItem
            current={place.view === "welcome"}
            icon={
              <Chip tint="teal">
                <KeyboardIcon size={14} />
              </Chip>
            }
            onClick={() => setPlace({ view: "welcome" })}
          >
            Shortcuts and tips
          </NavItem>
          <p className="version">
            <span className="version-dot" aria-hidden="true" />
            {version && <span className="mono">v{version}</span>}
            <button type="button" className="link-button" onClick={checkUpdates}>
              Check for updates
            </button>
          </p>
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
        {place.view === "library" && (
          <LibraryWindow title={place.app || "All captures"} appFilter={place.app} onAppFilter={pickApp} />
        )}
        {place.view === "settings" && <SettingsWindow key={place.section} section={place.section} />}
        {place.view === "welcome" && <WelcomeWindow />}
      </div>
    </div>
  );
}

export default AppWindow;
