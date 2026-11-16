---
title: Keyboard shortcuts
description: Every Grab-it hotkey on Windows, Linux and macOS, and the keys in the capture overlay, editor, video editor, pins and Library.
sidebar:
  order: 1
---

## Hotkeys

These work from any app, while Grab-it is running.

| Action | Windows & Linux | macOS |
| --- | --- | --- |
| All-in-one: pick any mode from a toolbar | `Ctrl + Alt + PrintScreen` | `⌘ ⇧ A` |
| Capture a region (or click a window) | `PrintScreen` | `⌘ ⇧ 2` |
| Capture a window | `Alt + PrintScreen` | `⌘ ⇧ W` |
| Capture every monitor | `Ctrl + PrintScreen` | `⌘ ⇧ F` |
| Capture text | `Shift + PrintScreen` | `⌘ ⇧ 1` |
| Pick a colour | `Ctrl + Shift + PrintScreen` | `⌘ ⇧ 9` |
| Open the Library | `Alt + Shift + PrintScreen` | `⌘ ⇧ 0` |

**Record**, **Repeat last region**, **Timed capture** and **Choose a monitor** have no hotkey of their own; start them from the tray menu, from All-in-one, or from the [command line](/grab-it/reference/command-line/).

Don't like these? Change them in [Settings → Hotkeys](/grab-it/reference/settings/#hotkeys): click a field and press the keys you want. If another app already uses a hotkey, Settings tells you, and the tray menu always works. **Shortcuts and tips** in the Grab-it window's sidebar shows your current hotkeys at any time.

On Linux with Wayland, your desktop binds the hotkeys and may ask you to confirm them the first time.

## Capture overlay

While you're picking an area to capture or record:

| Key | What it does |
| --- | --- |
| `Esc` | Cancel |
| Hold `Shift` while dragging | Make the selection a square |
| Hold `Space` while dragging | Move the selection instead of resizing it |
| `Enter` | Capture (or record) the adjusted selection, in All-in-one and Record |
| `1` to `7` | In All-in-one: Region, Window, Screen, Text, Colour, Record, Scroll |
| `8` | In All-in-one: step the timer through off, 3, 5 and 10 seconds |
| `1` to `3` | When recording: Region, Window, Screen |

## Image editor

`⌘` on macOS is `Ctrl` on Windows and Linux.

**Tools**

| Key | Tool |
| --- | --- |
| `V` | Select |
| `M` | Pan |
| `A` | Arrow |
| `L` | Line |
| `R` | Rectangle |
| `E` | Ellipse |
| `P` | Freehand |
| `T` | Text |
| `N` | Step (numbered badge) |
| `H` | Highlighter |
| `B` | Blur |
| `S` | Spotlight |
| `C` | Crop |

Tap a tool key to switch to it. Hold it instead, and the old tool comes back when you let go.

**Drawing and editing**

| Key | What it does |
| --- | --- |
| `1` to `7` | Pick a colour swatch, in the order of the bar |
| `[` and `]` | Thinner and thicker (smaller and bigger for text and steps) |
| Hold `⌘` and drag | Draw a rectangle, whatever the tool |
| Hold `⌥` (`Alt`) and drag | Draw an arrow, whatever the tool |
| Hold `Shift` while drawing | Keep lines and arrows to 45° steps, and boxes square (a square crop too) |
| Hold `⌥` (`Alt`) while cropping | Turn off snapping to edges |
| Hold `Space` and drag | Pan around the capture |
| Arrow keys | Nudge the selected shape 1 pixel; with `Shift`, 10 pixels |
| `Delete` or `Backspace` | Delete the selected shape |
| `⌘ D` | Duplicate the selected shape |
| `Esc` | Deselect, and close any open panel |

**The whole capture**

| Key | What it does |
| --- | --- |
| `⌘ Z` | Undo |
| `⌘ ⇧ Z` or `⌘ Y` | Redo |
| `⌘ C` | Copy the capture with its annotations |
| `⌘ Enter` | Copy and close |
| `⌘ [` and `⌘ ]` | Rotate left and right |

See [Mark it up](/grab-it/image-editor/mark-it-up/) for what each tool does.

## Video editor

| Key | What it does |
| --- | --- |
| `Space` | Play and pause |
| Arrow keys on a trim handle | Move it 0.1 seconds; with `Shift`, 1 second |
| `Home` and `End` on a trim handle | Move it to the start or end |
| `←` and `→` on a zoom | Move it 0.1 seconds; with `Shift`, 1 second |
| `Delete` or `Backspace` on a zoom | Remove it |
| `Esc` on a zoom | Deselect it |
| Arrow keys in the zoom area | Move the zoomed-in area; with `Shift`, ten times as far |

Double-click the zoom track to add a zoom. See [Video editor](/grab-it/video-editor/).

## Pins

| Key | What it does |
| --- | --- |
| `Esc`, or double-click | Close the pin |
| `+` and `-`, or scroll | Bigger and smaller |
| `⌘` + scroll | Fade it in and out |
| `⌘ C` | Copy it |
| Arrow keys | Move it 1 pixel; with `Shift`, 10 pixels |

## Grab-it window and Library

| Key | What it does |
| --- | --- |
| `/` | Jump to search |
| `Enter` in search | Search now |
| `Esc` | Clear the search, or close the details |
| Arrow keys | Move between tiles |
| `⌘ Enter` | Open the selected tile (macOS only: this one is not `Ctrl` on Windows and Linux, so double-click the tile there) |
| `⌘ ,` | Open Settings |
| `⌘ +`, `⌘ −`, `⌘ 0` | Bigger text, smaller text, default text size |
| In **Tags**: `Enter`, `,` | Add a tag |
| In **Tags**: `Backspace` | Remove the last tag |
