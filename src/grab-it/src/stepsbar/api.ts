import { invoke } from "@tauri-apps/api/core";

/** Stops the step capture under way and opens its guide. */
export function stopSteps(): Promise<void> {
  return invoke<void>("steps_bar_stop");
}
