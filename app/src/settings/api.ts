import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface Settings {
  saveFolder: string;
  hotkeys: Hotkeys;
}

/** Mirrors `Hotkeys` in src-tauri/src/hotkeys.rs: accelerator strings. */
export interface Hotkeys {
  region: string;
  window: string;
  screen: string;
}

/** Mirrors `HotkeysUpdate` in src-tauri/src/commands.rs. */
export interface HotkeysUpdate {
  settings: Settings;
  /** Hotkeys the system would not register, for example because another app holds them. */
  warnings: string[];
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function setSaveFolder(path: string): Promise<Settings> {
  return invoke<Settings>("set_save_folder", { path });
}

export function setHotkeys(hotkeys: Hotkeys): Promise<HotkeysUpdate> {
  return invoke<HotkeysUpdate>("set_hotkeys", { hotkeys });
}

/** Asks the user for a folder. Resolves to null when they cancel. */
export async function chooseFolder(defaultPath?: string): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title: "Choose where Grab-it saves captures",
  });
  return typeof picked === "string" ? picked : null;
}
