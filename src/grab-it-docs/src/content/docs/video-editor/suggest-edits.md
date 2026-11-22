---
title: Suggest edits
description: Let Grab-it find the pauses in a recording, preview the cuts it proposes, and compare the sound before and after noise removal.
sidebar:
  order: 6
---

**Suggest edits** in the top bar looks for the pauses in your recording and proposes a cut for each. Nothing changes until you apply the cuts you choose, and applying them is one step you can undo.

Everything happens on your computer: Grab-it listens to the sound with its own copy of ffmpeg, and nothing is sent anywhere.

## How pauses are found

- **With a microphone**, a pause is a stretch of at least about a second where the sound stays quiet and the pointer stays still. When the microphone was recorded on its own, only your voice counts, so music or system sounds playing at the same time don't hide a pause.
- **When the microphone wasn't kept on its own**, for example recorded together with system sound, the whole track is listened to.
- **In a silent recording**, or one with only system sound, a pause is where the pointer rests for at least two seconds.

Each cut keeps a quarter of a second of the pause at both ends, so words are never clipped. Stretches you've already cut aren't proposed again, and a cut is never proposed if it would leave less than half a second of a clip.

## Choose, preview and apply

The panel under the timeline lists each proposed cut with its reason, its range in the recording and how long it is. Every cut starts chosen; untick the ones to keep.

- **Preview** plays the sequence as it would be with the chosen cuts, starting just before the first one. Press **Play** to hear it. **Stop preview**, closing the panel, `Esc` or **Undo** puts the timeline back as it was. Other edits and **Export** wait until the preview ends, so nothing you haven't applied is ever saved.
- **Apply** removes the chosen cuts together, closing each gap. The timeline then shows the recording as [clips](/grab-it/video-editor/join-recordings/), and **Undo** brings it all back in one step.

## Original and Cleaned

Click a cut's range to listen around it, two seconds either side:

- **Original** plays the sound as it was recorded.
- **Cleaned** plays it with background noise removed from the microphone, exactly as [Export](/grab-it/video-editor/export/#remove-background-noise) does with **Remove background noise** on.

**Cleaned** is offered only when the microphone was recorded on its own. A recording whose microphone wasn't kept apart can only be played as it is, and a silent recording has nothing to play. Choosing another cut stops the sound of the one before.
