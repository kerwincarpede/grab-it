import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface Settings {
  saveFolder: string;
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function setSaveFolder(path: string): Promise<Settings> {
  return invoke<Settings>("set_save_folder", { path });
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
