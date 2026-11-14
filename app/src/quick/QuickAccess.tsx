import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./quick.css";
import {
  describeText,
  dismissAfter,
  formatBytes,
  formatElapsed,
  onQuickChanged,
  quickAction,
  quickInfo,
  quickThumbnail,
  recordStop,
  type QuickAction,
  type QuickItem,
  type QuickShown,
} from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** 16px stroke icons; decorative, the buttons carry the names. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 4 4H6l4-4Z" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  check: <path d="M5 12.5 10 17.5 19 7" />,
};

function useThumbnail(item: QuickItem | null): string | null {
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  const path = item?.kind === "capture" ? item.path : null;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let made: string | null = null;
    quickThumbnail()
      .then((bytes) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        made = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setLoaded({ path, url: made });
      })
      .catch(() => {
        // The card still offers its actions without a preview.
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  // A thumbnail still loading for the previous capture is not this one's.
  return loaded && loaded.path === path ? loaded.url : null;
}

/** The time since `startedAt`, ticking while a recording runs. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/**
 * The Quick Access card: what was just captured, with the next steps one
 * click away. It dismisses itself after a few seconds; resting the pointer
 * on it keeps it.
 */
function QuickAccess() {
  const [current, setCurrent] = useState<QuickShown | null>(null);
  const item = current?.item ?? null;
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  /** Bumped for each new item, restarting the dismiss timer and its bar. */
  const [shown, setShown] = useState(0);
  /** An action is under way; a second click must not start another. */
  const busy = useRef(false);
  /** What the card shows, for reading outside a render. */
  const latest = useRef<QuickShown | null>(null);
  const thumbnail = useThumbnail(item);
  const elapsed = useElapsed(item?.kind === "recording" ? item.startedAt : null);
  const [stopping, setStopping] = useState(false);

  const show = useCallback((next: QuickShown | null) => {
    // The window is reused after a dismissal: it can act again.
    busy.current = false;
    latest.current = next;
    setCurrent(next);
    setFlash(null);
    setError(null);
    setStopping(false);
    setShown((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    quickInfo()
      .then((loaded) => {
        if (!cancelled) show(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    onQuickChanged((next) => {
      if (!cancelled) show(next);
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        // An item set while the subscription was being made sent its event
        // to nobody: read once more now that events arrive.
        return quickInfo().then((fresh) => {
          if (cancelled || fresh === null) return;
          if (latest.current?.generation !== fresh.generation) show(fresh);
        });
      })
      .catch(() => {
        // Without events the card still shows what it opened with.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [show]);

  const run = useCallback((action: QuickAction, done?: string) => {
    const target = latest.current;
    if (!target || busy.current) return;
    // Copy and Show in folder leave the card up and may be repeated; the
    // others end it, so a double-click must not run them twice.
    const ends = action !== "copy" && action !== "reveal";
    if (ends) busy.current = true;
    setError(null);
    quickAction(action, target.generation)
      .then(() => {
        // A newer item arrived meanwhile: this result is not about it.
        if (latest.current !== target) return;
        if (done) setFlash(done);
        if (ends) {
          // The card is now hidden but keeps its page: clear it, so the
          // next card does not open on this one's content for a frame.
          latest.current = null;
          setCurrent(null);
          // A hidden window gets no mouse-leave; do not stay "hovered".
          setHovered(false);
        }
      })
      .catch((err: unknown) => {
        if (latest.current !== target) return;
        busy.current = false;
        setError(errorMessage(err));
      });
  }, []);

  const lifetime = item ? dismissAfter(item, current?.seconds ?? 8) : null;
  const paused = hovered || error !== null;
  useEffect(() => {
    if (lifetime === null || paused) return;
    const timer = window.setTimeout(() => run("close"), lifetime);
    return () => window.clearTimeout(timer);
  }, [lifetime, paused, shown, flash, run]);

  const close = (
    <button type="button" className="quick-close" aria-label="Dismiss" title="Dismiss" onClick={() => run("close")}>
      <Icon>{ICONS.close}</Icon>
    </button>
  );
  const timerBar = lifetime !== null && (
    <div
      key={`${shown}:${flash ?? ""}`}
      className="quick-timer"
      style={{ animationDuration: `${lifetime}ms`, animationPlayState: paused ? "paused" : "running" }}
    />
  );
  const hover = { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) };

  if (!item) {
    // Dismissed, or not yet told what to show: an empty card, unless
    // something went wrong on the way.
    return (
      <main className="quick quick-message" data-testid="quick" {...hover}>
        {error && (
          <>
            <p role="alert">{error}</p>
            {close}
          </>
        )}
      </main>
    );
  }

  if (item.kind === "capture") {
    const badge = flash ?? (item.copied ? "Copied" : null);
    return (
      <main className="quick quick-capture" data-testid="quick" {...hover}>
        <button
          type="button"
          className="quick-preview"
          aria-label={`Annotate ${item.fileName}`}
          title="Click to annotate"
          onClick={() => run("edit")}
        >
          {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
          <span className="quick-size">
            {item.width} × {item.height}
          </span>
        </button>
        {badge && (
          <span className="quick-badge" role="status">
            <Icon>{ICONS.check}</Icon>
            {badge}
          </span>
        )}
        {close}
        {error ? (
          <p className="quick-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="quick-actions" role="toolbar" aria-label="Capture actions">
            <button type="button" onClick={() => run("copy", "Copied")} title="Copy to the clipboard">
              <Icon>{ICONS.copy}</Icon>
              Copy
            </button>
            <button type="button" onClick={() => run("edit")} title="Open in the editor">
              <Icon>{ICONS.edit}</Icon>
              Annotate
            </button>
            <button type="button" onClick={() => run("pin")} title="Float above other windows">
              <Icon>{ICONS.pin}</Icon>
              Pin
            </button>
            <button type="button" className="icon-only" aria-label="Show in folder" title="Show in folder" onClick={() => run("reveal")}>
              <Icon>{ICONS.folder}</Icon>
            </button>
            <button type="button" className="icon-only danger" aria-label="Delete" title="Delete this capture" onClick={() => run("delete")}>
              <Icon>{ICONS.trash}</Icon>
            </button>
          </div>
        )}
        {timerBar}
      </main>
    );
  }

  if (item.kind === "recording") {
    const stop = () => {
      setStopping(true);
      recordStop().catch((err: unknown) => {
        setStopping(false);
        setError(errorMessage(err));
      });
    };
    return (
      <main className="quick quick-message quick-recording" data-testid="quick" {...hover}>
        <span className="quick-rec-dot" aria-hidden="true" />
        <div className="quick-body" role="status">
          <p className="quick-title">{stopping ? "Saving…" : "Recording"}</p>
          <p className="quick-detail quick-elapsed">
            {formatElapsed(elapsed)} of {formatElapsed(item.maxSeconds * 1000)}
          </p>
          {error && <p className="quick-detail quick-error-text">{error}</p>}
        </div>
        <button type="button" className="quick-stop" onClick={stop} disabled={stopping}>
          Stop
        </button>
      </main>
    );
  }

  if (item.kind === "recorded") {
    return (
      <main className="quick quick-message quick-recorded" data-testid="quick" {...hover}>
        <div className="quick-body" role="status">
          <p className="quick-title">
            <Icon>{ICONS.check}</Icon> GIF saved
          </p>
          <p className="quick-detail">
            {formatElapsed(item.durationMs)} · {formatBytes(item.bytes)}
          </p>
          <p className="quick-detail quick-file" title={item.path}>
            {item.fileName}
          </p>
          {error && <p className="quick-detail quick-error-text">{error}</p>}
          <div className="quick-inline-actions">
            <button type="button" onClick={() => run("reveal")}>
              <Icon>{ICONS.folder}</Icon>
              Show in folder
            </button>
            <button type="button" className="danger" onClick={() => run("delete")}>
              <Icon>{ICONS.trash}</Icon>
              Delete
            </button>
          </div>
        </div>
        {close}
        {timerBar}
      </main>
    );
  }

  if (item.kind === "colour") {
    return (
      <main className="quick quick-colour" data-testid="quick" {...hover}>
        <span className="quick-swatch" style={{ background: item.hex }} aria-hidden="true" />
        <div className="quick-body" role="status">
          <p className="quick-title">{item.hex}</p>
          <p className="quick-detail">{item.rgb}</p>
          <p className="quick-detail">
            <Icon>{ICONS.check}</Icon> Copied to the clipboard
          </p>
        </div>
        {close}
        {timerBar}
      </main>
    );
  }

  if (item.kind === "text") {
    return (
      <main className="quick quick-text" data-testid="quick" {...hover}>
        <div className="quick-body" role="status">
          <p className="quick-title">
            <Icon>{ICONS.check}</Icon> Text copied
          </p>
          <p className="quick-detail">{describeText(item.text)}</p>
        </div>
        <pre className="quick-text-preview">{item.text}</pre>
        {close}
        {timerBar}
      </main>
    );
  }

  const title = item.kind === "notice" ? item.title : item.kind === "error" ? "Capture failed" : item.message;
  return (
    <main className={`quick quick-message quick-${item.kind}`} data-testid="quick" {...hover}>
      {item.kind === "working" && <span className="quick-spinner" aria-hidden="true" />}
      <div className="quick-body" role={item.kind === "error" ? "alert" : "status"}>
        <p className="quick-title">{title}</p>
        {item.kind !== "working" && <p className="quick-detail">{item.message}</p>}
      </div>
      {close}
      {timerBar}
    </main>
  );
}

export default QuickAccess;
