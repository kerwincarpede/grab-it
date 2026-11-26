---
title: Tracks and sound
description: Add video and audio tracks, lay recordings over each other, unlink a recording's sound and move it in time, and lock tracks you don't want changed.
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

## Add and remove tracks

Click **Track** in the top bar, then **Add video track** or **Add audio track**. A new video track goes above the others; a new audio track goes at the bottom. An empty track you added has **Remove** beside its name. **Video 1** and **Audio 1** always stay.

## Lay one recording over another

1. Add a video track, or click the name of one you added, so it is chosen.
2. Move the playhead to where the recording should start.
3. Click **Recording** and pick it.

The recording goes on the chosen track at the playhead, with its sound linked on the first audio track that has room, or on a new one. Drag a clip onto another track of its kind to move it there. Clips never overlap on one track: a move or a placement that would is refused.

Where video tracks overlap, the highest one shows and covers the ones under it completely. Where no video track has a clip, the picture is black. The export ends with the last video clip, and every sound clip under it plays, mixed together.

## Rename and lock a track

- Double-click a track's name to rename it. Press `Enter` to keep the name or `Esc` to cancel.
- Click **Lock** beside a track's name to keep it as it is. Splitting at the playhead, deleting and [suggested cuts](/grab-it/video-editor/suggest-edits/) leave a locked track alone, and its clips can't be selected or dragged. **Video 1** has its own **Lock** above its clips; while it is locked its clips can't be trimmed, moved or deleted. Click **Locked** to unlock a track.

## Split and delete with tracks

- **Split** with nothing selected cuts every eligible clip at the playhead. With a clip under the playhead selected, it cuts that clip and the clips linked to it; with a clip elsewhere selected, it cuts the clip under the playhead and its linked clips. If a clip at the playhead is locked, its linked clips are left whole too.
- **Delete** removes the selected clip with its linked sound, and moves everything after it up on every unlocked track. Deleting a gap closes it the same way. When that would cut into sound that isn't linked to the clip, nothing is deleted and the status bar says why: move or link that sound first.

## Hear and export it

When sound is unlinked or moved, the preview plays every sound clip at its place, all together, gaps included, and the pictures are muted. While you preview [suggested cuts](/grab-it/video-editor/suggest-edits/), the sound tracks show and play with the cuts too. [Export](/grab-it/video-editor/export/) mixes the same sound clips at the same places, so the new MP4 sounds like the preview. **Remove background noise** still applies to each clip's microphone.
