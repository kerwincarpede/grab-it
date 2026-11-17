---
title: Pointer
description: Show, hide, move or resize the mouse pointer in a screenshot.
sidebar:
  order: 29
---

Grab-it saves the mouse pointer with each screenshot, kept apart from the picture. In the editor you choose whether it shows, where it sits and how big it is. Showing where the pointer is helps explain a step; one in the wrong place no longer spoils the shot.

## Show or hide it

Click **Pointer** in the toolbar to show or hide the pointer. The button is greyed out when the capture has no pointer: one taken before this feature, one where the pointer was outside the captured area, or one taken where Grab-it can't read the pointer (see below).

New captures start with the pointer hidden. Turn on **Show the pointer in new captures** in [Settings](/grab-it/reference/settings/) under **Editor** to have it shown from the start.

## Move and resize it

With [Select](/grab-it/image-editor/select/), click the pointer to select it:

- Drag it to move it.
- Drag a corner to make it bigger or smaller. It keeps its proportions.
- Press `Delete` to hide it. Click **Pointer** to bring it back.

Undo covers every change to the pointer.

## What uses it

Copy, Export and Pin use the pointer as you left it: shown or hidden, where you put it and at the size you chose. Your changes are saved with your other edits, so they're still there when you open the capture again.

The original screenshot never has the pointer drawn in, and nor do Library thumbnails, Quick Access cards or pins of the saved file, just as they don't show your annotations. With **Show the pointer in new captures** on, the copy that goes to the clipboard when you capture has the pointer drawn in.

## Where it works

- **Windows**, **macOS** and **Linux on X11**: every Region, Window, Screen, Monitor, Repeat last region and timed capture saves the pointer.
- **Linux on Wayland**: no. The desktop's screenshot doesn't hand over the pointer.
