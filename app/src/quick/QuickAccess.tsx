import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./quick.css";
import {
  codeFormats,
  describeCodes,
  describeText,
  dismissAfter,
  firstLink,
  formatBytes,
  formatElapsed,
  formatName,
  isStructured,
  onQuickChanged,
  quickAction,
  quickInfo,
  quickThumbnail,
  recordStop,
  type QuickAction,
  type QuickItem,
  type QuickShown,
} from "./api";
import { copyShotText, hasShotText, textCopied, watchShotText, type ShotText } from "../library/api";

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
  text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  link: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
};

/**
 * The library id and stored OCR text of the capture at `path`, looked up
 * when it changes and again whenever the library does. Null until known, and
 * for a capture the library does not know.
 */
function useStoredText(path: string | null): { id: number; text: ShotText } | null {
  // Kept with the path it is for, so a new capture never shows the last one's text.
  const [stored, setStored] = useState<{ path: string; id: number; text: ShotText } | null>(null);
  useEffect(() => {
    if (!path) return;
    return watchShotText(path, (id, text) => setStored(id !== null && text ? { path, id, text } : null));
  }, [path]);
  return stored !== null && stored.path === path ? stored : null;
}

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
  const stored = useStoredText(item?.kind === "capture" ? item.path : null);

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
    // Copying and Show in folder leave the card up and may be repeated;
    // the others end it, so a double-click must not run them twice.
    const ends = action !== "copy" && action !== "copyOriginal" && action !== "copyText" && action !== "reveal";
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

  /** Copies the capture's stored OCR text; the card stays up, as for Copy. */
  const copyText = useCallback((id: number) => {
    const target = latest.current;
    if (!target) return;
    setError(null);
    copyShotText(id)
      .then((text) => {
        if (latest.current === target) setFlash(textCopied(text));
      })
      .catch((err: unknown) => {
        if (latest.current === target) setError(errorMessage(err));
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
        <div className="quick-stage">
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
          {stored?.text.state === "waiting" ? (
            <button type="button" className="quick-copy-text" disabled>
              Reading text…
            </button>
          ) : (
            stored &&
            hasShotText(stored.text) && (
              <button
                type="button"
                className="quick-copy-text"
                onClick={() => copyText(stored.id)}
                title="Copy the text in the capture"
              >
                <Icon>{ICONS.text}</Icon>
                Copy text
              </button>
            )
          )}
        </div>
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
            {item.maxSeconds === undefined
              ? formatElapsed(elapsed)
              : `${formatElapsed(elapsed)} of ${formatElapsed(item.maxSeconds * 1000)}`}
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
            <Icon>{ICONS.check}</Icon> {item.format === "mp4" ? "Video saved" : "GIF saved"}
          </p>
          {item.fallback && <p className="quick-detail quick-fallback">{item.fallback}</p>}
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
    const tidy = item.tidy;
    const done = tidy?.state === "done" ? tidy : null;
    // Something else was copied while the AI was reading: the tidied text waits for Copy.
    const waiting = done !== null && !done.copied;
    const format = done ? formatName(done.format, done.language) : null;
    const showActions = item.original !== undefined || waiting || flash !== null;
    return (
      <main className="quick quick-text" data-testid="quick" {...hover}>
        <div className="quick-body" role="status">
          <p className="quick-title">
            {waiting && flash === null ? (
              "Text tidied"
            ) : (
              <>
                <Icon>{ICONS.check}</Icon> {flash ?? "Text copied"}
              </>
            )}
          </p>
          {/* The AI's progress takes the count's place, leaving the preview room. */}
          {!tidy && <p className="quick-detail">{describeText(item.text)}</p>}
          {tidy?.state === "working" && (
            <p className="quick-detail quick-tidy" data-testid="quick-tidy">
              <span className="quick-spinner is-small" aria-hidden="true" />
              {tidy.by} is tidying it up…
            </p>
          )}
          {done && (
            <p className="quick-detail quick-tidy" data-testid="quick-tidy" title={describeText(item.text)}>
              {done.changed ? `Tidied by ${done.by}` : `Checked by ${done.by}`}
              {format && ` · ${format}`}
            </p>
          )}
          {tidy?.state === "failed" && (
            <p className="quick-detail quick-tidy quick-error-text" data-testid="quick-tidy" title={tidy.message}>
              {tidy.by} could not tidy it up
            </p>
          )}
        </div>
        <pre className={`quick-text-preview${isStructured(done?.format) ? " is-code" : ""}`}>{item.text}</pre>
        {error && (
          <p className="quick-detail quick-error-text" role="alert">
            {error}
          </p>
        )}
        {showActions && (
          <div className="quick-inline-actions quick-text-actions" role="toolbar" aria-label="Text actions">
            <button type="button" onClick={() => run("copy", "Copied")} title="Copy this text">
              <Icon>{ICONS.copy}</Icon>
              Copy
            </button>
            {item.original !== undefined && (
              <button
                type="button"
                onClick={() => run("copyOriginal", "Copied as read")}
                title="Copy the text as OCR read it, before tidying"
              >
                Copy as read
              </button>
            )}
          </div>
        )}
        {close}
        {timerBar}
      </main>
    );
  }

  if (item.kind === "code") {
    const link = firstLink(item.codes);
    const hasText = item.text.trim().length > 0;
    return (
      <main className="quick quick-text quick-code" data-testid="quick" {...hover}>
        <div className="quick-body" role="status">
          <p className="quick-title">
            <Icon>{ICONS.check}</Icon> {flash ?? describeCodes(item.codes)}
          </p>
          <p className="quick-detail">{codeFormats(item.codes)}</p>
        </div>
        <pre className="quick-text-preview is-code" data-testid="quick-codes">
          {item.codes.map((code) => code.value).join("\n")}
        </pre>
        {error && (
          <p className="quick-detail quick-error-text" role="alert">
            {error}
          </p>
        )}
        <div className="quick-inline-actions quick-text-actions" role="toolbar" aria-label="Code actions">
          <button
            type="button"
            onClick={() => run("copy", "Copied")}
            title={item.codes.length === 1 ? "Copy the code's value" : "Copy every code's value, one per line"}
          >
            <Icon>{ICONS.copy}</Icon>
            Copy
          </button>
          {hasText && (
            <button type="button" onClick={() => run("copyText", "Text copied")} title="Copy the text around the code">
              Copy text
            </button>
          )}
          {link !== null && (
            <button type="button" onClick={() => run("openLink")} title={`Open ${link} in your browser`}>
              <Icon>{ICONS.link}</Icon>
              Open link
            </button>
          )}
        </div>
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
