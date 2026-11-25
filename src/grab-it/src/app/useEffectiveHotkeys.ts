import { useEffect, useState } from "react";
import { effectiveHotkeys, onEffectiveHotkeys, type BindingLabels } from "./api";

/**
 * Stops a listener without letting a failure escape. Tauri's unlisten is
 * async, so it can reject after the caller has moved on, for example when the
 * window unmounts before the subscription resolves and the event plugin is gone.
 */
function release(stop: () => unknown): void {
  try {
    void Promise.resolve(stop()).catch(() => {});
  } catch {
    // Nothing is left to stop.
  }
}

/** Current bindings, including desktop shortcut changes while a menu is open. */
export function useEffectiveHotkeys(): BindingLabels {
  const [labels, setLabels] = useState<BindingLabels>({});
  useEffect(() => {
    let disposed = false;
    let changed = false;
    let unlisten: (() => void) | undefined;
    async function subscribe() {
      try {
        const stop = await onEffectiveHotkeys((next) => {
          if (!disposed) {
            changed = true;
            setLabels(next);
          }
        });
        if (disposed) {
          release(stop);
          return;
        }
        unlisten = stop;
      } catch {
        // The initial read still works when events are unavailable.
      }
      const found = await effectiveHotkeys();
      if (!disposed && !changed) setLabels(found ?? {});
    }
    void subscribe().catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) release(unlisten);
    };
  }, []);
  return labels;
}
