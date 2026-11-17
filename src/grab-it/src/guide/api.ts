import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { EXPORT_FORMATS, exportName, type GuideFormat } from "./model";

/** Mirrors `GuideInfo` in src-tauri/src/steps.rs. */
export interface GuideInfo {
  path: string;
  title: string;
  steps: { capture: string; description: string; annotations: unknown; exists: boolean }[];
}

/** One flattened step for export or copy: base64 PNG. */
export interface ExportStep {
  description: string;
  png: string;
}

export function guideInfo(): Promise<GuideInfo> {
  return invoke<GuideInfo>("guide_info");
}

export function guideImage(capture: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("guide_image", { capture });
}

/** Writes the steps in order; Rust renumbers each capture's badge. */
export function saveGuide(steps: { capture: string; description: string }[]): Promise<void> {
  return invoke<void>("guide_save", { steps });
}

export function openInEditor(capture: string): Promise<void> {
  return invoke<void>("guide_open_editor", { capture });
}

export function exportGuide(format: GuideFormat, path: string, steps: ExportStep[]): Promise<void> {
  return invoke<void>("guide_export", { format, path, steps });
}

export function copyGuide(steps: ExportStep[]): Promise<void> {
  return invoke<void>("guide_copy", { steps });
}

/** Called when a step's description arrives from the AI. */
export function onGuideChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("guide-changed", () => handler());
}

/** Asks where to export, or null when cancelled. */
export async function chooseExportPath(title: string, format: GuideFormat): Promise<string | null> {
  const entry = EXPORT_FORMATS.find((candidate) => candidate.format === format);
  const picked = await save({
    title: "Export guide",
    defaultPath: exportName(title, format),
    filters: entry ? [{ name: entry.label, extensions: [entry.extension] }] : [],
  });
  return picked ?? null;
}
