import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Permission` in src-tauri/src/permissions.rs. */
export type Permission = "screenRecording" | "inputMonitoring" | "microphone" | "camera";

/** Mirrors `Access` in src-tauri/src/permissions.rs. */
export type Access = "allowed" | "off" | "notAsked";

/** Mirrors `PermissionStatus` in src-tauri/src/permissions.rs. */
export interface PermissionStatus {
  screenRecording: Access;
  inputMonitoring: Access;
  microphone: Access;
  camera: Access;
  /** Allow all ran and setup is not finished. */
  resume: boolean;
  /** Allow all ran since Grab-it started: Screen Recording and Input Monitoring wait for a restart. */
  askedThisLaunch?: boolean;
}

export const PERMISSIONS: readonly Permission[] = ["screenRecording", "inputMonitoring", "microphone", "camera"];

/** macOS only sees these two granted once Grab-it restarts. */
export const NEEDS_RESTART: readonly Permission[] = ["screenRecording", "inputMonitoring"];

/**
 * Something the Permissions page is for, as `PermissionStatus::missing`
 * decides: Screen Recording is off, or a permission was never asked for. A
 * null status, as off macOS or from a backend without the command, is
 * nothing missing.
 */
export function permissionsMissing(status: PermissionStatus | null | undefined): boolean {
  if (!status) return false;
  return status.screenRecording !== "allowed" || PERMISSIONS.some((permission) => status[permission] === "notAsked");
}

/** Where each permission stands, without asking for any. */
export function permissionStatus(): Promise<PermissionStatus | null> {
  return invoke<PermissionStatus | null>("permission_status");
}

/** Allow all: shows each system prompt in turn, resolving once all are answered. */
export function requestAllPermissions(): Promise<PermissionStatus | null> {
  return invoke<PermissionStatus | null>("permission_request_all");
}

/**
 * One throwaway capture after Allow all's restart, so macOS 15+ shows its
 * "bypass the system private window picker" alert during setup rather than
 * on the first real capture. Does nothing without Screen Recording, or off
 * macOS.
 */
export function primeScreenCapture(): Promise<void> {
  return invoke<void>("permission_prime_capture");
}

/** Skip for now or Continue: launches stop reopening setup. */
export function finishPermissions(): Promise<void> {
  return invoke<void>("permission_finish");
}

/** Restarts Grab-it, so macOS lets it use what was just turned on. */
export function restartForPermissions(): Promise<void> {
  return invoke<void>("permission_restart");
}

/** Opens `permission`'s pane in System Settings → Privacy & Security. */
export function openPermissionSettings(permission: Permission): Promise<void> {
  return invoke<void>("permission_open_settings", { permission });
}
