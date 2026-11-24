---
title: Join recordings
description: Add other recordings after the one you opened, put them in order, trim each one, and export them as one video.
sidebar:
  order: 5
---

The video editor can join several recordings into one video. Add recordings after the one you opened, put them in the order you want, and cut the start and end of each. The preview plays them one after another, and Export saves them as one MP4.

## Add a recording

1. Move the playhead into the clip the new recording should follow.
2. Click **Recording** in the top bar.
3. Pick an MP4 in the recordings folder or one of its month folders. The file picker starts in the recordings folder.

The recording joins right after the clip under the playhead, whole. You can join MP4s from any month or from directly inside `recordings` as long as they share the same save folder.

## The clips on the timeline

Once there's more than one clip, the timeline shows the clips end to end, each named after its recording and as long as the part you keep. Click a clip to select it.

- **Trim a clip**: drag its left or right edge. You can only trim within that recording, and you can drag an edge back out to restore what you cut. Each clip is at least half a second long.
- **Reorder**: drag a clip to a new place, or select it and press `Alt + ←` or `Alt + →` (`⌥ ←` or `⌥ →` on macOS).
- **Remove a clip**: select it and press `Delete` or `Backspace`. The last clip can't be removed.

Every change is one step you can [undo](/grab-it/video-editor/#undo-and-redo).

## Zooms and the backdrop

Each zoom belongs to the recording it was added on, and moves with its clip when you reorder. If you trim a clip so a zoom falls outside the part you keep, the zoom is hidden. It comes back when you restore that part.

The backdrop applies to the whole video.

## Different sizes

The recording you opened sets the video's size and frame rate, whatever order the clips are in. A recording of a different size is scaled to fit inside the same space, centred, with black bars on the sides or top and bottom.

## Where the join is saved

The clips and their order are saved in the edits file beside the recording you opened, so the editor opens the joined sequence again next time. None of the recordings is changed, and the Library gets nothing new until you export.

If a recording you joined is moved or deleted, its clip shows as **Missing** and **Export** is turned off. Remove that clip, or put the file back where it was.

## Export

Export renders the clips in order into one new MP4 beside the recording you opened, each with its own zooms, pointer and sound. Clips cut straight from one to the next, with no transition. A recording without sound is silent for its clip. See [Export](/grab-it/video-editor/export/).
