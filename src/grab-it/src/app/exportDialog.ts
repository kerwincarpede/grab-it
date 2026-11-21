import { dirname, join } from "@tauri-apps/api/path";
import { save, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { getSettings, setLastExportFolder } from "../settings/api";

/** Opens in the folder last chosen in any export dialog, or in the capture save folder. */
export async function chooseExportFile(name: string, options: Omit<SaveDialogOptions, "defaultPath">): Promise<string | null> {
  const { lastExportFolder, saveFolder } = await getSettings();
  const defaultPath = await join(lastExportFolder ?? saveFolder, name);
  const chosen = await save({ ...options, defaultPath });
  if (chosen) {
    // A failure to remember the preference should still let this export proceed.
    try {
      await setLastExportFolder(await dirname(chosen));
    } catch (error) {
      console.warn("Could not remember the export folder", error);
    }
  }
  return chosen;
}
