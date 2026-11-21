import { commands, type Permission, type PermissionStatus } from "../app/bindings";

/** Where macOS stands on each permission; generated from the Rust types in src-tauri/src/permissions.rs. */
export type { Access, Permission, PermissionStatus } from "../app/bindings";

export const PERMISSIONS: readonly Permission[] = ["screenRecording", "inputMonitoring", "microphone", "camera"];

/** macOS only sees these two granted once Grab-it restarts. */
export const NEEDS_RESTART: readonly Permission[] = ["screenRecording", "inputMonitoring"];

/**
 * Something the Permissions page is for: Screen Recording is off, or a
 * permission was never asked for. Launch reopens setup on less, only while
 * Screen Recording is not allowed (`should_open_welcome`). A null status, as
 * off macOS or from a backend without the command, is nothing missing.
 */
export function permissionsMissing(status: PermissionStatus | null | undefined): boolean {
  if (!status) return false;
  return status.screenRecording !== "allowed" || PERMISSIONS.some((permission) => status[permission] === "notAsked");
}

/** Where each permission stands, without asking for any. */
export function permissionStatus(): Promise<PermissionStatus | null> {
  return commands.permissionStatus();
}

/** Allow all: shows each system prompt in turn, resolving once all are answered. */
export function requestAllPermissions(): Promise<PermissionStatus | null> {
  return commands.permissionRequestAll();
}

/**
 * One throwaway capture after Allow all's restart, so macOS 15+ shows its
 * "bypass the system private window picker" alert during setup rather than
 * on the first real capture. Does nothing without Screen Recording, or off
 * macOS.
 */
export async function primeScreenCapture(): Promise<void> {
  await commands.permissionPrimeCapture();
}

/** Skip for now or Continue: launches stop reopening setup. */
export function finishPermissions(): Promise<void> {
  return commands.permissionFinish();
}

/** Restarts Grab-it, so macOS lets it use what was just turned on. */
export function restartForPermissions(): Promise<void> {
  return commands.permissionRestart();
}

/** Opens `permission`'s pane in System Settings → Privacy & Security. */
export async function openPermissionSettings(permission: Permission): Promise<void> {
  await commands.permissionOpenSettings(permission);
}
