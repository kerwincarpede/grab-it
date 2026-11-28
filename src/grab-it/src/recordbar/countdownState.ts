import { useState } from "react";

/** The most seconds a countdown ending at `ends` has shown, so its ring knows how full it began. */
export function useCountdownTotal(ends: number | null, left: number): number {
  const [seen, setSeen] = useState({ ends, total: left });
  if (seen.ends !== ends || left > seen.total) {
    // Adjusted while rendering, as React suggests for state that follows a prop.
    const next = { ends, total: seen.ends !== ends ? left : Math.max(seen.total, left) };
    setSeen(next);
    return next.total;
  }
  return seen.total;
}

/** A pressed key that should act on the bar, not on a focused button or field. */
export function isBareKey(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !target?.closest?.("button, input, select, textarea");
}
