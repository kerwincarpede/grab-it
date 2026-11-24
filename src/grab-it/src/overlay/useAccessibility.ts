import { useEffect, useState } from "react";
import { commands } from "../app/bindings";

/** How often a blocked check is asked again, so a grant in System Settings shows. */
export const RECHECK_MS = 1000;

/**
 * Whether automatic scrolling is allowed, asked without a prompt. While it
 * is not, it is asked again every second and when the page gets the focus
 * back, so allowing it in System Settings shows without reopening Scroll.
 */
export function useAccessibility(enabled: boolean): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      Promise.resolve(commands.accessibilityStatus())
        .then((value) => {
          if (!live) return;
          const yes = value === true;
          setAllowed(yes);
          if (!yes) timer = setTimeout(check, RECHECK_MS);
        })
        .catch(() => {
          if (live) setAllowed(true);
        });
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [enabled]);
  return allowed;
}
