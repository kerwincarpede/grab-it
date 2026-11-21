import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { commands, type ExportStep, type GuideInfo, type GuideStep } from "../app/bindings";
import { EXPORT_FORMATS, exportName, type GuideFormat } from "./model";

/** What the Guide window shows: `GuideInfo` in src-tauri/src/steps.rs. */
export type { GuideInfo };

/** One flattened step for export or copy: base64 PNG. `ExportStep` in src-tauri/src/steps.rs. */
export type { ExportStep };

export function guideInfo(): Promise<GuideInfo> {
  return commands.guideInfo();
}

export function guideImage(capture: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("guide_image", { capture });
}

/** Writes the steps in order; Rust renumbers each capture's badge. */
export async function saveGuide(steps: GuideStep[]): Promise<void> {
  await commands.guideSave(steps);
}

export async function openInEditor(capture: string): Promise<void> {
  await commands.guideOpenEditor(capture);
}

export async function exportGuide(format: GuideFormat, path: string, steps: ExportStep[]): Promise<void> {
  await commands.guideExport(format, path, steps);
}

export async function copyGuide(steps: ExportStep[]): Promise<void> {
  await commands.guideCopy(steps);
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
