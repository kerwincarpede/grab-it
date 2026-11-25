import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SettingsSection } from "../settings/api";
import { commands } from "./bindings";

/** What the Grab-it window shows. Mirrors `MainView` in src-tauri/src/windows.rs. */
export type MainView = "library" | "settings" | "ai-settings" | "welcome";

const VIEWS: readonly MainView[] = ["library", "settings", "ai-settings", "welcome"];

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
export type CaptureKind = "allInOne" | "region" | "window" | "screen" | "monitor" | "repeat" | "record" | "text" | "colour" | "steps" | "scroll";

/** `BindingLabels` in hotkeys.rs, keyed by capture. Missing actions have no registered shortcut. */
export type BindingLabels = Partial<Record<CaptureKind | "library", string>>;

export function effectiveHotkeys(): Promise<BindingLabels> {
  return commands.effectiveHotkeys();
}

export function onEffectiveHotkeys(handler: (labels: BindingLabels) => void): Promise<UnlistenFn> {
  return listen<BindingLabels>("effective-hotkeys-changed", ({ payload }) => handler(payload));
}

/** Starts a capture; the hub hides first so it is not in the shot. */
export function startCapture(kind: CaptureKind, options: { delaySeconds?: number; monitor?: number } = {}): Promise<void> {
  return commands.hubCapture(kind, options.delaySeconds ?? null, options.monitor ?? null).then(() => undefined);
}

/** Opens (or switches) the Grab-it window to `view`. */
export function openMain(view: MainView): Promise<void> {
  return commands.hubOpen(view).then(() => undefined);
}

export function checkForUpdates(): Promise<void> {
  return commands.hubCheckUpdates();
}

/** Where a sidebar item leads: the library (maybe one app) or a Settings page. */
export type Place = { view: "library"; app: string } | { view: "settings"; section: SettingsSection } | { view: "welcome" };

/**
 * True when Windows' "Use the Print screen key to open screen capture" is
 * on and a Grab-it hotkey is a bare PrintScreen, so the two take turns.
 * Always false off Windows.
 */
export function printScreenConflict(): Promise<boolean> {
  return commands.printscreenConflict();
}

/** Turns Windows' Print screen setting off, then resolves to whether the conflict is still there. */
export function fixPrintScreen(): Promise<boolean> {
  return commands.printscreenFix();
}

/** Opens the Windows Settings page with the Print screen switch. */
export async function openPrintScreenSettings(): Promise<void> {
  await commands.printscreenOpenSettings();
}
