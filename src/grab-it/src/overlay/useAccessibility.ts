import { useEffect, useState } from "react";
import { commands } from "../app/bindings";

/** Whether automatic scrolling is allowed, asked once without a prompt. */
export function useAccessibility(enabled: boolean): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.resolve(commands.accessibilityStatus())
      .then((value) => {
        if (live) setAllowed(value === true);
      })
      .catch(() => {
        if (live) setAllowed(true);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return allowed;
}
