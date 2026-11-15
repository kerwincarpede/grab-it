import { useEffect, type RefObject } from "react";

/** Closes a popover on a click outside `root` while `open`. */
export function useOutsideClick(root: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [root, open, close]);
}
