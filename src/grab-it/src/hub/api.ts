import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type HubActivity, type HubMonitor } from "../app/bindings";

export type { HubActivity, HubMonitor } from "../app/bindings";

/** Mirrors `HUB_ACTIVITY_EVENT` in src-tauri/src/hub.rs. */
export const HUB_ACTIVITY_EVENT = "hub-activity";

export const IDLE: HubActivity = { recording: false, steps: false };

/** What is running now. */
export function hubActivity(): Promise<HubActivity> {
  return commands.hubActivity();
}

/** Calls `handler` each time a recording or a step capture starts or stops. */
export function onHubActivity(handler: (activity: HubActivity) => void): Promise<UnlistenFn> {
  return listen<HubActivity>(HUB_ACTIVITY_EVENT, (event) => handler(event.payload));
}

/** The displays the hub offers to capture, numbered as the system numbers them. */
export function hubMonitors(): Promise<HubMonitor[]> {
  return commands.hubMonitors();
}

/** Hides the hub. */
export function hideHub(): Promise<void> {
  return commands.hubHide();
}

/** Quits Grab-it. */
export function quitApp(): Promise<void> {
  return commands.hubQuit();
}
