import { useLayoutEffect, useState } from "react";
import "./stepsbar.css";
import { StopIcon } from "../app/icons";
import { stopSteps } from "./api";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The pill shown while a step capture runs (src-tauri/src/steps_bar.rs):
 * says so, with a Stop that ends it and opens the guide.
 */
function StepsBar() {
  const [stopping, setStopping] = useState(false);

  // The window is see-through: only the pill may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("stepsbar-clear");
    return () => document.documentElement.classList.remove("stepsbar-clear");
  }, []);

  function stop() {
    // Once: the pill closes as the capture stops.
    setStopping(true);
    stopSteps().catch((err: unknown) => {
      console.error(`Grab-it: ${errorText(err)}`);
      setStopping(false);
    });
  }

  return (
    <main className="stepsbar">
      <div className="stepsbar-pill">
        <span className="stepsbar-dot" aria-hidden="true" />
        <span className="stepsbar-label">Step capture</span>
        <button type="button" className="stepsbar-stop" title="Stop and open the guide" disabled={stopping} onClick={stop}>
          <StopIcon size={13} />
          <span>Stop</span>
        </button>
      </div>
    </main>
  );
}

export default StepsBar;
