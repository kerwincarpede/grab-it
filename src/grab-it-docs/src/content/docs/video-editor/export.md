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

- Only the part between the [trim handles](/grab-it/video-editor/timeline-and-trim/#trim), or, once you [join recordings](/grab-it/video-editor/join-recordings/), each clip's kept part, in order.
- The [backdrop](/grab-it/video-editor/backdrop/), at the size the status bar shows as **Output**.
- The [zooms](/grab-it/video-editor/zooms/), eased exactly as in the preview.
- The recording's sound, trimmed to match, with background noise removed from the microphone when [Remove background noise](#remove-background-noise) is on. Joined clips each bring their own sound, and a recording without any is silent for its clip.

It keeps the frame rate of the recording you opened, and uses the **Quality** in **Settings → Recording**.

## Remove background noise

The sound wave icon in the top bar cleans fan hum, keyboard clatter and room noise from the microphone when you export. Only the microphone is cleaned: system sound is left as it is. It starts on when the recording was made with [Remove background noise](/grab-it/recording/options/#remove-background-noise), and off otherwise. Turn it off to export the microphone as it was heard, or on to clean a recording made without it. The choice is saved with your edits, and **Undo** takes it back.

The noise is removed only in the export. The preview plays the recording as it was made, so you won't hear the change until you play the exported video.

With joined recordings, the one choice applies to every clip that keeps its microphone apart. Other clips export with the sound they were recorded with. The icon is turned off when no clip can be cleaned: recordings made before Grab-it kept the microphone apart, recordings without a microphone, and recordings whose `.sound.m4a` file was deleted.

## Progress

Playback pauses during export. The panel under the timeline shows a progress bar and the percentage of frames written. You can use the rest of Grab-it while the editor works.

Click **Cancel** to stop the export. Grab-it removes the unfinished file and the status bar says **Export cancelled**. You can keep editing or export again.

If the export fails, the status bar says why and nothing is left behind. Exporting needs ffmpeg, as MP4 recording does: if it isn't ready yet, the status bar asks you to check **Settings → Recording** and export again.

## The original stays untouched

The editor never changes your recording. Your edits live in a small file beside it, named after it with `.edits.json` on the end:

```
Grab-it 2026-03-07 09-05-01.mp4
Grab-it 2026-03-07 09-05-01.edits.json   your trim, backdrop, zooms and noise removal
Grab-it 2026-03-07 09-05-01.cursor.json  where the pointer was, for Follow cursor
Grab-it 2026-03-07 09-05-01.sound.m4a    the microphone and system sound, kept apart
```

The edits file is saved every time you change something, so closing the editor loses nothing: open the recording again and your trim, backdrop and zooms are back. To start over, delete the `.edits.json` file. Delete the `.cursor.json` file and **Follow cursor** zooms can no longer follow the pointer. The `.sound.m4a` file is there only for recordings made with the microphone, and holds its sound before any noise was removed. Delete it and **Remove background noise** can no longer be changed for that recording, and a recording made with both the microphone and system sound shows its sound as **Mixed sound**.

:::note
If a newer version of Grab-it wrote an edits file this one can't read, the editor says so and won't save over it, so the newer edits aren't lost.
:::
