---
title: Timeline and trim
description: Play, pause and seek a recording, cut its start and end, and split, duplicate and delete parts of it.
sidebar:
  order: 1
---

The bottom of the editor has the play button, the time (`0:04.2 / 0:31.7`, to a tenth of a second) and the timeline.

## Play and seek

- Press `Space`, click the play button, or click the video to play and pause.
- Click or drag along the timeline to move the playhead and show that frame.

Playback runs only over the part you keep: it stops at the trimmed end, and pressing play there starts again from the trimmed start. The playhead can't be moved into the trimmed-away parts.

`Space` plays and pauses unless a button, slider or field has the keyboard; press `Tab` away or click the video first.

## Trim

The handles at each end of the timeline set where the clip starts and ends. The parts outside them are dimmed, and are left out of the export.

- **Drag a handle** to move it. The preview shows the frame at the handle as you drag, so you can find the exact moment.
- **With the keyboard**, click or `Tab` to a handle, then use the arrow keys to move it a tenth of a second, or a whole second with `Shift`. `Home` and `End` move it all the way to the start or the end.

The handle's tooltip shows its time. The status bar shows how long the trimmed clip is.

A clip is at least half a second long: the handles stop that close together. To keep the whole recording again, drag both handles back to the ends.

The trim is saved when you let go of a handle, like every other edit, and the editor opens at the trimmed start next time. To put the handles back where they were, [undo](/grab-it/video-editor/#undo-and-redo) the trim.

## Split, duplicate and delete

To cut a mistake out of the middle of a recording, split it on each side of the mistake and delete the part in between.

- **Split** in the top bar, or `S`, cuts the clip under the playhead in two at the playhead. Each part is at least half a second long, so **Split** is off closer than that to either end of a clip. After the first split the timeline shows the clips end to end, as when you [join recordings](/grab-it/video-editor/join-recordings/).
- Click a clip to select it. **Duplicate**, or `Ctrl D` (`⌘ D` on macOS), puts a copy of it right after it.
- **Delete**, or `Delete`, removes the selected clip and closes up the space it leaves, so what came after moves up.
- **Leave gap**, or `Shift Delete`, removes the selected clip and leaves a gap of the same length, so everything after it stays where it was.

A gap shows on the timeline as an empty block. It plays as the backdrop with a black video box and no sound, in the preview and in the export. Click a gap to select it, and press `Delete` or click **Delete** to close it. Gaps side by side become one gap.

The last clip can't be deleted. Zooms stay on the moment of the recording they were made on, whatever you split, copy or delete. Each of these edits is saved at once, and you can [undo](/grab-it/video-editor/#undo-and-redo) it.

## Sound

The status bar names the recording's sound:

- **Microphone · System sound**, or just one of them, when the recording [kept its sound apart](/grab-it/recording/options/#sound-kept-apart).
- **Mixed sound** when the microphone and system sound are mixed into one track, so they can only be edited together. Recordings made before Grab-it kept the sound apart show this, and so does one whose separate sound file couldn't be saved. Hover over it to see why.
- Nothing for a silent recording.

## Keys

| Key | Where | What it does |
| --- | --- | --- |
| `Space` | Anywhere but a control | Play or pause |
| `←` `→` (`↑` `↓`) | A trim handle | Move it 0.1 s |
| `Shift` + arrow | A trim handle | Move it 1 s |
| `Home` / `End` | A trim handle | Move it to the start or end |
| `←` `→` | A zoom | Move it 0.1 s, or 1 s with `Shift` |
| `Delete` / `Backspace` | A zoom | Delete it |
| `Esc` | A zoom | Deselect it |
| Arrow keys | The zoom area | Move it a little, or more with `Shift` |
| `S` | Anywhere but a control | Split the clip under the playhead |
| `Alt` + `←` `→` | A clip | Move it earlier or later |
| `Ctrl D` (`⌘ D`) | A clip | Duplicate it |
| `Delete` / `Backspace` | A clip | Delete it and close the space, unless it's the last |
| `Shift Delete` | A clip | Delete it and leave a gap, unless it's the last |
| `Delete` / `Backspace` | A gap | Close it |
| `Esc` | The backdrop panel | Close it |

See [Zooms](/grab-it/video-editor/zooms/) for the zoom row, and [Join recordings](/grab-it/video-editor/join-recordings/) for clips.
