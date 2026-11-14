import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SettingsSection } from "../settings/api";

/** What the Grab-it window shows. Mirrors `MainView` in src-tauri/src/windows.rs. */
export type MainView = "library" | "settings" | "welcome";

const VIEWS: readonly MainView[] = ["library", "settings", "welcome"];

/** Mirrors `MAIN_NAVIGATE_EVENT` in src-tauri/src/windows.rs. */
export const MAIN_NAVIGATE_EVENT = "main-navigate";

/** The view in a `#/app/<view>` hash; the library when there is none. */
export function viewFromHash(hash: string): MainView {
  const view = hash.replace(/^#\/?/, "").split(/[?/]/)[1];
  return VIEWS.find((known) => known === view) ?? "library";
}

/** Called when the tray, the hub or a hotkey asks the window for a view. */
export function onNavigate(handler: (view: MainView) => void): Promise<UnlistenFn> {
  return listen<string>(MAIN_NAVIGATE_EVENT, (event) => {
    const view = VIEWS.find((known) => known === event.payload);
    if (view) handler(view);
  });
}

/** A capture the Grab-it window and the hub can start. */
export type CaptureKind = "region" | "window" | "screen" | "monitor" | "repeat" | "record" | "text" | "colour";

/** Starts a capture; the hub hides first so it is not in the shot. */
export function startCapture(kind: CaptureKind, options: { delaySeconds?: number; monitor?: number } = {}): Promise<void> {
  return invoke<void>("hub_capture", { kind, delaySeconds: options.delaySeconds, monitor: options.monitor });
}

/** Opens (or switches) the Grab-it window to `view`. */
export function openMain(view: MainView): Promise<void> {
  return invoke<void>("hub_open", { view });
}

export function checkForUpdates(): Promise<void> {
  return invoke<void>("hub_check_updates");
}

/** Where a sidebar item leads: the library (maybe one app) or a Settings page. */
export type Place = { view: "library"; app: string } | { view: "settings"; section: SettingsSection } | { view: "welcome" };
