import { useEffect, useState } from "react";
import { effectiveHotkeys, onEffectiveHotkeys, type BindingLabels } from "./api";

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
          stop();
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
      unlisten?.();
    };
  }, []);
  return labels;
}
