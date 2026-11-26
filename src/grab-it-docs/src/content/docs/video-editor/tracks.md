---
title: Tracks and sound
description: See a recording's sound on its own track, unlink it from the picture, move it in time, and link it again.
sidebar:
  order: 7
---

The timeline shows the pictures and the sound on separate, named tracks. **Video 1** holds the clips in order. **Audio 1**, under it, holds each recording's sound as one clip. A recording without sound has no clip there.

## Linked sound

A recording's sound starts out linked to its picture. Linked clips have a coloured left edge and are edited together: split, trim, reorder, duplicate or delete the picture and its sound changes the same way, at the same moment. A trim moves both by the same amount, so when one of them can't go as far, neither does.

## Unlink, move and link again

1. Click the sound clip on **Audio 1**.
2. Click **Unlink** in the top bar.
3. Drag the sound clip left or right to move it in time.

While you drag, the clip snaps to the playhead, the edges of other clips and the start, when it comes within a few pixels of one. To turn snapping off, press `Shift` after you start dragging: `Shift` held as you press the clip adds it to the selection instead.

To link clips again, click one, `Shift`-click the others, and click **Link**. With one recording, clicking its sound clip is enough: its picture counts as selected too. Link needs two or more clips, at most one of them on **Video 1**. Linked clips play together, so sound linked to a picture moves to the picture's start, and sound clips linked only to each other move to the earliest one's start. If that would put a clip over another, nothing is linked and the status bar says why. Linked sound can't be dragged on its own: unlink it first.

With one recording, unlinked sound keeps playing at the same moment of the recording when you move its trim start.

## Rename a track

Double-click a track's name to rename it. Press `Enter` to keep the name or `Esc` to cancel.

## Split and delete with tracks

- **Split** with nothing selected cuts every track at the playhead. With a clip under the playhead selected, it cuts that clip and the clips linked to it; with a clip elsewhere selected, it cuts the clip under the playhead and its linked clips.
- **Delete** removes the selected clip with its linked sound, and moves everything after it up on every track. Deleting a gap closes it the same way. When that would cut into sound that isn't linked to the clip, nothing is deleted and the status bar says why: move or link that sound first.

## Hear and export it

When sound is unlinked or moved, the preview plays every sound clip at its place, all together, gaps included, and the pictures are muted. While you preview [suggested cuts](/grab-it/video-editor/suggest-edits/), the sound tracks show and play with the cuts too. [Export](/grab-it/video-editor/export/) mixes the same sound clips at the same places, so the new MP4 sounds like the preview. **Remove background noise** still applies to each clip's microphone.
