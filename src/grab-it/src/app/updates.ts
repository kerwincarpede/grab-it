import { commands, type Changes_Serialize, type UpdateInfo_Serialize, type UpdateStatus_Serialize } from "./bindings";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `UPDATE_STATUS_EVENT` in src-tauri/src/update.rs. */
export const UPDATE_STATUS_EVENT = "update-status";

/** What one version brought. Generated from `Changes` in src-tauri/src/update.rs. */
export type UpdateChanges = Changes_Serialize;

/** The update on offer. Generated from `UpdateInfo` in src-tauri/src/update.rs. */
export type UpdateInfo = UpdateInfo_Serialize;

/** Generated from `UpdateStatus` in src-tauri/src/update.rs. */
export type UpdateStatus = UpdateStatus_Serialize;

export interface UpdateEvent {
  status: UpdateStatus;
  /** The user asked (checked or installed): show the Updates dialog. */
  show: boolean;
}

export function updateStatus(): Promise<UpdateStatus> {
  return commands.updateStatus();
}

/** Checks now; the result arrives as an event with `show` set. */
export function checkForUpdate(): Promise<void> {
  return commands.updateCheck();
}

export async function installUpdate(): Promise<void> {
  await commands.updateInstall();
}

/** Not now: automatic checks stop asking about this version. */
export function updateLater(): Promise<void> {
  return commands.updateLater();
}

export function onUpdateStatus(handler: (event: UpdateEvent) => void): Promise<UnlistenFn> {
  return listen<UpdateEvent>(UPDATE_STATUS_EVENT, (event) => handler(event.payload));
}

/** The update on offer, while there is one. */
export function pendingUpdate(status: UpdateStatus | null): UpdateInfo | null {
  if (!status) return null;
  if (status.state === "available" || status.state === "installing") return status.info;
  if (status.state === "failed") return status.info;
  return null;
}

/** The version this copy runs, whatever the state. */
export function currentVersion(status: UpdateStatus | null): string | null {
  if (!status) return null;
  return "info" in status && status.info ? status.info.current : "current" in status ? status.current : null;
}

/** "12 November", or null without a date. */
export function releaseDay(date: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/** "18.2 of 28.4 MB" */
export function progressLabel(downloaded: number, total: number | null): string {
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  return total ? `${mb(downloaded)} of ${mb(total)} MB` : `${mb(downloaded)} MB`;
}
