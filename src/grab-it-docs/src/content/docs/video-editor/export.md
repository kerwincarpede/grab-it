---
title: Export
description: Save the edited recording as a new MP4, and what stays untouched.
sidebar:
  order: 4
---

Click **Export** at the right of the top bar to render your trim, backdrop and zooms into a new MP4.

## Where it saves

The export goes beside the recording, in the `recordings` folder of your save folder, named after it:

```
Grab-it 2026-03-07 09-05-01.mp4            the recording
Grab-it 2026-03-07 09-05-01 (edited).mp4   the first export
Grab-it 2026-03-07 09-05-01 (edited 2).mp4 the next one
```

Each export makes a new file, so exporting again never replaces an earlier export, and never the recording itself.

When it's done, the status bar says **Exported** and the file name, and the Quick Access card shows the new video, ready to play, show in its folder or edit. It's in your [Library](/grab-it/library/) too.

## What's in it

- Only the part between the [trim handles](/grab-it/video-editor/timeline-and-trim/#trim).
- The [backdrop](/grab-it/video-editor/backdrop/), at the size the status bar shows as **Output**.
- The [zooms](/grab-it/video-editor/zooms/), eased exactly as in the preview.
- The recording's sound, trimmed to match.

It keeps the recording's frame rate, and uses the **Quality** in **Settings → Recording**.

## Progress

While it exports, playback pauses, **Backdrop**, **Zoom** and **Export** are greyed out, a bar under the timeline fills up, and the status bar counts up, like **Exporting… 42%**. A long recording can take a while; the editor stays open and you can use the rest of Grab-it meanwhile.

If the export fails, the status bar says why and nothing is left behind. Exporting needs ffmpeg, as MP4 recording does: if it isn't ready yet, the status bar asks you to check **Settings → Recording** and export again.

## The original stays untouched

The editor never changes your recording. Your edits live in a small file beside it, named after it with `.edits.json` on the end:

```
Grab-it 2026-03-07 09-05-01.mp4
Grab-it 2026-03-07 09-05-01.edits.json   your trim, backdrop and zooms
Grab-it 2026-03-07 09-05-01.cursor.json  where the pointer was, for Follow cursor
Grab-it 2026-03-07 09-05-01.sound.m4a    the microphone and system sound, kept apart
```

The edits file is saved every time you change something, so closing the editor loses nothing: open the recording again and your trim, backdrop and zooms are back. To start over, delete the `.edits.json` file. Delete the `.cursor.json` file and **Follow cursor** zooms can no longer follow the pointer. The `.sound.m4a` file is there only for recordings made with the microphone. Delete it from a recording made with both the microphone and system sound, and the editor shows its sound as **Mixed sound**.

:::note
If a newer version of Grab-it wrote an edits file this one can't read, the editor says so and won't save over it, so the newer edits aren't lost.
:::
