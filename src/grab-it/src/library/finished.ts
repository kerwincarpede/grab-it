import { copyImage, pinImage } from "../editor/api";
import { renderCapture } from "../editor/renderCapture";
import { copyShot, pinShot, shotAnnotations, shotImage, type Shot } from "./api";

/* A capture marked up in the editor is copied and pinned as the editor
   gives it, with its edits, so a blurred detail never leaks from the
   Library. Captures without edits keep the direct path. */

type Edited = Pick<Shot, "id" | "editedAt">;

/** Whether the shot has saved edits: an annotations sidecar on disk. */
export function hasEdits(shot: Edited): boolean {
  return typeof shot.editedAt === "number";
}

/** A capture drawn with its saved edits, as PNG bytes. */
export async function renderShot(id: number): Promise<Uint8Array> {
  const [png, saved] = await Promise.all([shotImage(id), shotAnnotations(id)]);
  return renderCapture(png, saved.annotations, saved.scaleFactor);
}

/** Copies the shot as it is finished: with its edits when it has any, else the original. */
export async function copyFinished(shot: Edited): Promise<void> {
  if (!hasEdits(shot)) return copyShot(shot.id);
  await copyImage(await renderShot(shot.id));
}

/** Pins the shot as it is finished: with its edits when it has any, else the original. */
export async function pinFinished(shot: Edited): Promise<void> {
  if (!hasEdits(shot)) return pinShot(shot.id);
  await pinImage(await renderShot(shot.id));
}
