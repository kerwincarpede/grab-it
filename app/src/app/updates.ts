import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `UPDATE_STATUS_EVENT` in src-tauri/src/update.rs. */
export const UPDATE_STATUS_EVENT = "update-status";

export interface UpdateChanges {
  version: string;
  items: string[];
}

export interface UpdateInfo {
  current: string;
  version: string;
  /** RFC 3339, when the release says. */
  date: string | null;
  /** Newest first. */
  changes: UpdateChanges[];
}

/** Mirrors `UpdateStatus` in src-tauri/src/update.rs. */
export type UpdateStatus =
  | { state: "idle"; current: string }
  | { state: "checking"; current: string }
  | { state: "upToDate"; current: string; checkedAt: number }
  | { state: "available"; info: UpdateInfo; declined: boolean }
  | { state: "installing"; info: UpdateInfo; downloaded: number; total: number | null }
  | { state: "failed"; current: string; message: string; info: UpdateInfo | null };

export interface UpdateEvent {
  status: UpdateStatus;
  /** The user asked (checked or installed): show the Updates dialog. */
  show: boolean;
}

export function updateStatus(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("update_status");
}

/** Checks now; the result arrives as an event with `show` set. */
export function checkForUpdate(): Promise<void> {
  return invoke<void>("update_check");
}

export function installUpdate(): Promise<void> {
  return invoke<void>("update_install");
}

/** Not now: automatic checks stop asking about this version. */
export function updateLater(): Promise<void> {
  return invoke<void>("update_later");
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
