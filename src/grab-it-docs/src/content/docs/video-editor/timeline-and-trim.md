---
title: Timeline and trim
description: Play, pause and seek a recording, and cut its start and end.
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

The trim is saved when you let go of a handle, like every other edit, and the editor opens at the trimmed start next time.

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
| `Esc` | The backdrop panel | Close it |

See [Zooms](/grab-it/video-editor/zooms/) for the zoom row.
