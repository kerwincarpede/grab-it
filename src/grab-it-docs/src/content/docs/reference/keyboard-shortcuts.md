---
title: Keyboard shortcuts
description: Every Grab-it hotkey on Windows, Linux and macOS, and the keys in the capture overlay, scrolling capture, editor, video editor, pins, Guide window and Library.
sidebar:
  order: 1
---

## Hotkeys

These work from any app, while Grab-it is running.

| Action | Windows & Linux | macOS |
| --- | --- | --- |
| Open or dismiss **Capture & record…** | `Ctrl + Alt + PrintScreen` | `⌘ ⇧ A` |
| Capture a region (or click a window) | `PrintScreen` | `⌘ ⇧ 2` |
| Capture a window | `Alt + PrintScreen` | `⌘ ⇧ W` |
| Capture every monitor | `Ctrl + PrintScreen` | `⌘ ⇧ F` |
| Capture text | `Shift + PrintScreen` | `⌘ ⇧ 1` |
| Pick a colour | `Ctrl + Shift + PrintScreen` | `⌘ ⇧ 9` |
| Start or stop a [step capture](/grab-it/capture/step-capture/) | `Ctrl + Alt + Shift + PrintScreen` | `⌘ ⇧ 8` |
| Open the Library | `Alt + Shift + PrintScreen` | `⌘ ⇧ 0` |

In the hub, use `Tab` or `Shift Tab` to focus an action and `Enter` or `Space` to choose it. This also works for **Repeat last region**, the delays under **Timed** and individual monitors under **Monitor**. In the Library, open **More captures** and use the arrow keys to move between options.

The global chooser shortcut cancels an open chooser. Press it again to reopen. During recording, it stops the recording. On Wayland the desktop provides its own capture picker.

Don't like these? Change them in [Settings → Hotkeys](/grab-it/reference/settings/#hotkeys): click a field and press the keys you want. If another app already uses a hotkey, Settings tells you, and the tray menu always works. **Shortcuts and tips** in the Grab-it window's sidebar shows your current hotkeys at any time.

On Linux with Wayland, your desktop binds the hotkeys and may ask you to confirm them the first time.

## Capture overlay

While you're picking an area to capture or record:

| Key | What it does |
| --- | --- |
| `Esc` | Cancel. In Capture & record…, the first `Esc` leaves the toolbar if you're in it |
| Hold `Shift` while dragging | Make the selection a square |
| Hold `Space` while dragging | Move the selection instead of resizing it |
| `Enter` | Capture (or record) the adjusted selection, in Capture & record… and Record |
| `Enter` | In Capture & record…: capture the window under the pointer in **Window**, or copy the colour under it in **Colour** |
| `Tab`, then `←` `→` | In Capture & record…: move into the toolbar, then between the buttons of a group |
| `1` to `7` | In Capture & record…: Region, Window, Screen, Text, Colour, Record, Scroll |
| `8` | In Capture & record…: step the timer through off, 3, 5 and 10 seconds, or Record's countdown |
| `1` to `3` | When recording, in Record and in Capture & record…'s **Record**: record a region, a window or the screen |
| `Enter` | In **Scroll**: start the scrolling capture of the held area |

## Scrolling capture

While a [scrolling capture](/grab-it/capture/scrolling/) runs:

| Key | What it does |
| --- | --- |
| `Esc` | Cancel the capture and throw the image away, as **Cancel** on the capture bar does |

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
| `K` | Callout |
| `N` | Step (numbered badge) |
| `G` | Stamp (icons, pointers, keys and emoji) |
| `H` | Highlighter |
| `B` | Blur |
| `S` | Spotlight |
| `C` | Crop |
| `X` | Cut out |

Tap a tool key to switch to it. Hold it instead, and the old tool comes back when you let go.

**Drawing and editing**

| Key | What it does |
| --- | --- |
| `1` to `7` | Pick a colour swatch, in the order of the bar |
| `I` | Pick a colour from the capture with the eyedropper; click to use it |
| `[` and `]` | Thinner and thicker (smaller and bigger for text, steps and stamps) |
| Hold `⌘` and drag | Draw a rectangle, whatever the tool |
| Hold `⌥` (`Alt`) and drag | Draw an arrow, whatever the tool |
| Hold `Shift` while drawing | Keep lines and arrows to 45° steps, and boxes square (a square crop too) |
| Hold `Shift` while turning a stamp | Turn it in 15° steps |
| Hold `⌥` (`Alt`) while cropping | Turn off snapping to edges |
| Hold `⌥` (`Alt`) while cutting out | Turn off snapping to edges |
| Hold `Space` and drag | Pan around the capture |
| Arrow keys | Nudge the selected shape 1 pixel; with `Shift`, 10 pixels |
| `Delete` or `Backspace` | Delete the selected shape |
| `⌘ D` | Duplicate the selected shape |
| `⌘ ⌥ ]` and `⌘ ⌥ [` | Bring the selected shape or image forward, and send it backward |
| `⌘ V` | Paste an image from the clipboard (see [Add images](/grab-it/image-editor/add-images/)) |
| `Esc` | Put the eyedropper away; otherwise deselect, and close any open panel |

**The whole capture**

| Key | What it does |
| --- | --- |
| `⌘ Z` | Undo |
| `⌘ ⇧ Z` or `⌘ Y` | Redo |
| `⌘ C` | Copy the capture with its annotations |
| `⌘ Enter` | Copy and close |
| `⌘ [` and `⌘ ]` | Rotate left and right |
| `←` and `→` with no annotation selected | Open the previous (newer) and next (older) capture in the Library |
| `⌥ ←` and `⌥ →` (`Alt` on Windows and Linux) | Step through captures, including while an annotation is selected |

See [Mark it up](/grab-it/image-editor/mark-it-up/) for what each tool does.

## Video editor

`⌘` on macOS is `Ctrl` on Windows and Linux.

| Key | What it does |
| --- | --- |
| `Space` | Play and pause |
| `⌘` + scroll on the timeline | Zoom it in or out at the pointer |
| `⌘ Z` | Undo the last trim, clip, split, backdrop or zoom change |
| `⌘ ⇧ Z` or `⌘ Y` | Redo |
| Arrow keys on a trim handle | Move it 0.1 seconds; with `Shift`, 1 second |
| `Home` and `End` on a trim handle | Move it to the start or end |
| `←` and `→` on a zoom | Move it 0.1 seconds; with `Shift`, 1 second |
| `Delete` or `Backspace` on a zoom | Remove it |
| `Esc` on a zoom | Deselect it |
| `⌥ ←` and `⌥ →` (`Alt` on Windows and Linux) on a clip | Move it earlier or later in the sequence |
| `S` | Split every track at the playhead, or, with a clip selected, the clip under the playhead and its linked clips |
| `Shift`-click a clip | Add it to the selection, to **Link** |
| Press `Shift` after starting to drag a sound clip | Turn snapping off |
| `⌘ D` on a clip | Duplicate it |
| `Delete` or `Backspace` on a clip | Delete it and close the space, unless it's the last |
| `⇧ Delete` on a clip | Delete it and leave a gap, unless it's the last |
| `Delete` or `Backspace` on a gap | Close it |
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

## Guide window

| Key | What it does |
| --- | --- |
| `⌘ Z` (`Ctrl Z` on Windows and Linux) | Bring back the last deleted step. Inside a description, it undoes your typing instead. |
| `Esc` | Close a step's large image |

See [The Guide window](/grab-it/capture/step-capture/#the-guide-window).

## Grab-it window and Library

| Key | What it does |
| --- | --- |
| `/` | Jump to search |
| `Enter` in search | Search now |
| `Esc` | Clear the search, or close the details |
| Arrow keys | Move between tiles |
| Arrow keys in the details | Show the previous capture (`←` `↑`) or the next one (`→` `↓`) |
| `⌘ Enter` | Open the selected tile (macOS only: this one is not `Ctrl` on Windows and Linux, so double-click the tile there) |
| `⌘ ,` | Open Settings |
| `⌘ +`, `⌘ −`, `⌘ 0` | Bigger text, smaller text, default text size |
| In **Tags**: `Enter`, `,` | Add a tag |
| In **Tags**: `Backspace` | Remove the last tag |
