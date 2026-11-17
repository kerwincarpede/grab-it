import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `HUB_ACTIVITY_EVENT` in src-tauri/src/hub.rs. */
export const HUB_ACTIVITY_EVENT = "hub-activity";

/** Mirrors `HubActivity` in src-tauri/src/hub.rs. */
export interface HubActivity {
  /** A recording is under way, counting down included. */
  recording: boolean;
  /** A step capture is under way. */
  steps: boolean;
}

export const IDLE: HubActivity = { recording: false, steps: false };

/** What is running now. */
export function hubActivity(): Promise<HubActivity> {
  return invoke<HubActivity>("hub_activity");
}

/** Calls `handler` each time a recording or a step capture starts or stops. */
export function onHubActivity(handler: (activity: HubActivity) => void): Promise<UnlistenFn> {
  return listen<HubActivity>(HUB_ACTIVITY_EVENT, (event) => handler(event.payload));
}
