import { invoke } from "@tauri-apps/api/core";

/** When the countdown ends, in ms since the Unix epoch, from the page's hash (`#/timerbar?ends=…`). */
export function endsFromHash(hash: string): number | null {
  const query = hash.split("?")[1] ?? "";
  const ends = Number(new URLSearchParams(query).get("ends") ?? Number.NaN);
  return Number.isFinite(ends) ? ends : null;
}

/** The whole seconds left until `ends`, rounded up and never below 1, as the recording toolbar counts. */
export function secondsLeft(ends: number | null, now: number): number {
  if (ends === null) return 1;
  return Math.max(1, Math.ceil((ends - now) / 1000));
}

/** Stops the timed capture counting down, so it does not start. */
export function cancelTimer(): Promise<void> {
  return invoke<void>("timer_bar_cancel");
}
