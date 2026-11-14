import Dialog from "./Dialog";
import Logo from "./Logo";
import { CheckIcon } from "./icons";
import { progressLabel, releaseDay, type UpdateInfo, type UpdateStatus } from "./updates";

interface UpdateDialogProps {
  status: UpdateStatus;
  onClose: () => void;
  onInstall: () => void;
  onLater: () => void;
  onCheck: () => void;
}

function Changes({ info }: { info: UpdateInfo }) {
  const withItems = info.changes.filter((changes) => changes.items.length > 0);
  if (withItems.length === 0) {
    return <p className="update-none">This update brings fixes and small improvements.</p>;
  }
  return (
    <div className="update-changes">
      {withItems.map((changes) => (
        <section key={changes.version} aria-label={`Changes in ${changes.version}`}>
          <h3>
            <b>{changes.version}</b>
            {changes.version === info.version ? "What's new" : "Also included"}
          </h3>
          <ul>
            {changes.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Head({ title, lead, icon }: { title: string; lead: string; icon?: "ok" }) {
  return (
    <div className="update-head">
      {icon === "ok" ? (
        <span className="update-ok" aria-hidden="true">
          <CheckIcon size={20} />
        </span>
      ) : (
        <span className="mark" aria-hidden="true">
          <Logo size={22} />
        </span>
      )}
      <div>
        <p className="update-title">{title}</p>
        <p className="update-lead">{lead}</p>
      </div>
    </div>
  );
}

/** What the updater is doing, and the choices it needs from the user. */
function UpdateDialog({ status, onClose, onInstall, onLater, onCheck }: UpdateDialogProps) {
  let body;
  switch (status.state) {
    case "checking":
    case "idle":
      body = (
        <>
          <div className="update-head">
            <span className="spinner" aria-hidden="true" />
            <div>
              <p className="update-title">Checking for updates…</p>
              <p className="update-lead">You have {status.current}.</p>
            </div>
          </div>
          <footer className="dialog-foot">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </footer>
        </>
      );
      break;
    case "upToDate":
      body = (
        <>
          <Head icon="ok" title="Grab-it is up to date" lead={`${status.current} is the newest version.`} />
          <footer className="dialog-foot">
            <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
              OK
            </button>
          </footer>
        </>
      );
      break;
    case "available": {
      const day = releaseDay(status.info.date);
      body = (
        <>
          <Head
            title={`Grab-it ${status.info.version} is available`}
            lead={`You have ${status.info.current}.${day ? ` Released ${day}.` : ""}`}
          />
          <Changes info={status.info} />
          <footer className="dialog-foot">
            <span className="dialog-foot-note">Grab-it restarts to finish.</span>
            <button type="button" className="btn" onClick={onLater}>
              Later
            </button>
            <button type="button" className="btn btn-primary" data-autofocus onClick={onInstall}>
              Install and restart
            </button>
          </footer>
        </>
      );
      break;
    }
    case "installing": {
      const percent = status.total ? Math.min(100, (status.downloaded * 100) / status.total) : null;
      body = (
        <>
          <Head title={`Installing Grab-it ${status.info.version}`} lead="Grab-it restarts by itself when it's done." />
          <div
            className="update-progress"
            role="progressbar"
            aria-label="Download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? undefined : Math.round(percent)}
          >
            <i style={{ width: percent === null ? "35%" : `${percent}%` }} className={percent === null ? "is-unknown" : ""} />
          </div>
          <p className="update-meta">
            <span>{progressLabel(status.downloaded, status.total)}</span>
            {percent !== null && <span>{Math.round(percent)}%</span>}
          </p>
        </>
      );
      break;
    }
    case "failed":
      body = (
        <>
          <Head
            title={status.info ? "Couldn't update Grab-it" : "Couldn't check for updates"}
            lead={status.info ? `Grab-it ${status.info.version} did not install. You still have ${status.info.current}.` : "Check your connection and try again."}
          />
          <p className="update-error">{status.message}</p>
          <footer className="dialog-foot">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn-primary" data-autofocus onClick={status.info ? onInstall : onCheck}>
              Try again
            </button>
          </footer>
        </>
      );
      break;
  }
  return (
    <Dialog title="Updates" hideTitle className="update-dialog" onClose={onClose}>
      {body}
    </Dialog>
  );
}

export default UpdateDialog;
