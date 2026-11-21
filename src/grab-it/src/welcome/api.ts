import { commands } from "../app/bindings";

/** Opens a window or starts a capture by its `--open` name. */
export async function openTarget(target: string): Promise<void> {
  await commands.openTarget(target);
}
