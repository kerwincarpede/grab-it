import { useEffect, useState, type ReactNode } from "react";
import Logo from "../app/Logo";
import { CameraIcon, CheckIcon, ClickIcon, MicIcon, OpenIcon, ScreenIcon } from "../app/icons";
import {
  finishPermissions,
  NEEDS_RESTART,
  openPermissionSettings,
  PERMISSIONS,
  permissionStatus,
  requestAllPermissions,
  restartForPermissions,
  type Permission,
  type PermissionStatus,
} from "./permissions";

/** How often the page asks where each permission stands while it is shown. */
export const POLL_MS = 1000;

const ROWS: Record<Permission, { title: string; detail: string; icon: ReactNode; required?: boolean }> = {
  screenRecording: {
    title: "Screen Recording",
    detail: "Captures and recordings of your screen.",
    icon: <ScreenIcon />,
    required: true,
  },
  inputMonitoring: {
    title: "Input Monitoring",
    detail: "Your clicks and keystrokes in recordings.",
    icon: <ClickIcon />,
  },
  microphone: { title: "Microphone", detail: "Your voice in recordings.", icon: <MicIcon /> },
  camera: { title: "Camera", detail: "The webcam bubble in recordings.", icon: <CameraIcon /> },
};

function message(err: unknown): string {
  return typeof err === "string" ? err : "Something went wrong.";
}

/**
 * The Welcome window's first step on macOS: one Allow all button fires each
 * system prompt, the rows follow the answers, and Restart Grab-it appears
 * when macOS needs one before it lets Grab-it see the screen or the input.
 */
function PermissionsPage({ initial, inDialog, onDone }: { initial: PermissionStatus; inDialog: boolean; onDone: () => void }) {
  const [status, setStatus] = useState(initial);
  const [asking, setAsking] = useState(false);
  // Allow all ran, or System Settings was opened for Screen Recording or
  // Input Monitoring, here: a grant there only shows after a restart.
  const [restartPending, setRestartPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      permissionStatus()
        .then((next) => {
          if (!cancelled && next) setStatus(next);
        })
        .catch(() => {
          // The next poll tries again.
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const nothingAskedYet = !restartPending && PERMISSIONS.some((permission) => status[permission] === "notAsked");
  const waitingForRestart = restartPending && NEEDS_RESTART.some((permission) => status[permission] !== "allowed");

  function allowAll() {
    setError(null);
    setAsking(true);
    setRestartPending(true);
    requestAllPermissions()
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setAsking(false));
  }

  function openSettings(permission: Permission) {
    setError(null);
    if (NEEDS_RESTART.includes(permission)) setRestartPending(true);
    openPermissionSettings(permission).catch((err: unknown) => setError(message(err)));
  }

  function finish() {
    setError(null);
    // Done either way: launches only reopen setup a little too often.
    finishPermissions()
      .catch(() => undefined)
      .finally(onDone);
  }

  function restart() {
    setError(null);
    restartForPermissions().catch((err: unknown) => setError(message(err)));
  }

  function state(permission: Permission): ReactNode {
    const access = status[permission];
    if (access === "allowed") {
      return (
        <span className="perm-state perm-allowed">
          <CheckIcon size={14} />
          Allowed
        </span>
      );
    }
    if (access === "notAsked") {
      return <span className="perm-state">{asking ? "Asking…" : "Not asked yet"}</span>;
    }
    if (restartPending && NEEDS_RESTART.includes(permission)) {
      return (
        <span className="perm-state perm-todo">
          Turn on in System Settings
          <button
            type="button"
            className="btn btn-small"
            aria-label={`Open System Settings for ${ROWS[permission].title}`}
            onClick={() => openSettings(permission)}
          >
            Open
          </button>
        </span>
      );
    }
    return (
      <span className="perm-state perm-off">
        Off
        <button
          type="button"
          className="link-button"
          aria-label={`Open System Settings for ${ROWS[permission].title}`}
          onClick={() => openSettings(permission)}
        >
          Open System Settings
          <OpenIcon />
        </button>
      </span>
    );
  }

  let main: ReactNode;
  if (nothingAskedYet || asking) {
    main = (
      <button type="button" className="btn btn-primary" data-autofocus disabled={asking} onClick={allowAll}>
        {asking ? "Asking…" : "Allow all"}
      </button>
    );
  } else if (waitingForRestart) {
    main = (
      <button type="button" className="btn btn-primary" data-autofocus onClick={restart}>
        Restart Grab-it
      </button>
    );
  } else {
    main = (
      <button type="button" className="btn btn-primary" data-autofocus onClick={finish}>
        Continue
      </button>
    );
  }
  const offersSkip = nothingAskedYet || asking || waitingForRestart;

  return (
    <main className={inDialog ? "welcome in-dialog" : "window welcome"}>
      <header className="welcome-head">
        <span className="mark" aria-hidden="true">
          <Logo size={24} />
        </span>
        <div>
          <h1>Set up Grab-it</h1>
          <p className="welcome-lead">macOS asks before an app can see your screen or hear you.</p>
        </div>
      </header>

      <section className="perm-body" aria-label="Permissions">
        <ul className="welcome-list perm-list">
          {PERMISSIONS.map((permission) => {
            const { title, detail, icon, required } = ROWS[permission];
            return (
              <li className="welcome-row perm-row" key={permission} data-permission={permission}>
                {icon}
                <span className="welcome-text">
                  <span className="welcome-title">
                    {title}
                    {required && <span className="perm-required"> · Required</span>}
                  </span>
                  <span className="welcome-detail">{detail}</span>
                </span>
                {state(permission)}
              </li>
            );
          })}
        </ul>
        {waitingForRestart && (
          <p className="perm-note">
            Turn on Grab-it under Screen Recording and Input Monitoring, then restart it: macOS only lets Grab-it use
            them after a restart.
          </p>
        )}
      </section>

      {error && (
        <p className="status status-error" role="status">
          {error}
        </p>
      )}

      <footer className="dialog-foot welcome-foot">
        {offersSkip && (
          <button type="button" className="link-button dialog-foot-note" onClick={finish}>
            Skip for now
          </button>
        )}
        {main}
      </footer>
    </main>
  );
}

export default PermissionsPage;
