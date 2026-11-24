---
title: Step capture
description: Click through a task and get a numbered how-to guide, then reorder, edit and export it as Markdown, HTML, Word or PowerPoint.
sidebar:
  order: 11
---

Step capture turns doing a task into a how-to guide. While it runs, every click saves the window under the pointer as a normal capture, with a numbered step badge where you clicked and a short description of the step. Stopping opens the **Guide** window, where you reorder, edit and delete the steps, then export or copy the guide.

## Start and stop

| From | Do this |
| --- | --- |
| The tray | Choose **Step capture**. While it runs the item reads **Stop step capture**. |
| A hotkey | Press `Ctrl + Alt + Shift + PrintScreen` (on macOS `⌘ ⇧ 8`), and again to stop. Change it in [Settings → Hotkeys](/grab-it/reference/settings/#hotkeys). |
| The hub | Click **Step capture**. While it runs the item reads **Stop step capture**, in red with a pulsing dot. |
| The pill | Click **Stop** on the **Step capture** pill. |
| The [command line](/grab-it/reference/command-line/) | `grab-it --open steps` starts one, and running it again stops it. |

While a step capture runs, a small **Step capture** pill with a **Stop** button sits at the top centre of the display the pointer was on when it started, and the tray icon's tooltip reads **Grab-it — step capture on**. On Windows and macOS the pill is left out of the steps' captures. X11 can't keep a window out of captures, so there it shows in any step whose frame covers it. Clicking the pill isn't a step.

Step capture watches the mouse across the whole desktop. On macOS it asks for **Input Monitoring** the first time, as **Show clicks** does for recordings. It can't run during a recording, and a recording can't start during a step capture.

:::note
Step capture isn't available on [Wayland](/grab-it/capture/wayland/), where apps can't watch clicks. Use an X11 session.
:::

## What each click saves

- The frame is taken as soon as the button goes down, so it shows the screen just before the click. Saving happens in the background and never delays the next click's frame.
- Grab-it captures the window under the pointer. When you click a menu, a popover or a window smaller than 400 × 300 points, such as a small dialog, it captures the whole monitor instead, for context.
- Clicks on Grab-it's own windows and menus aren't steps. When you stop from the tray or the hub, the clicks that opened it are left out too.
- Each step is an ordinary capture that follows your [Save folder settings](/grab-it/reference/settings/#general) and appears in the Library. Steps aren't copied to the clipboard and don't open Quick Access.
- The badge sits where you clicked and shows the step's place in the guide. Open the capture in the editor to move it or add more marks.
- A double click counts as one step. A click within 24 pixels of the last step's badge, in the same window, on a screen that has barely changed, is skipped as a repeat.

## Descriptions

With [AI descriptions](/grab-it/ai/descriptions/) on, your chosen provider writes one short instruction for each step, such as *Click Save in the toolbar.* Each step's screenshot, with its badge, is sent to that provider (see [Privacy](/grab-it/reference/privacy/)). Until it answers, or with AI descriptions off, a step reads *Click in* and the app's name. Every description stays editable, and one you've edited is never replaced.

## The Guide window

Stopping a step capture opens its guide. Each step shows its capture, with its badge and any edits made in the editor, and its description.

| To | Do this |
| --- | --- |
| Reorder the steps | **Move up** and **Move down**. The badges are renumbered to match. |
| Change a description | Edit it in place. It's saved when you leave the field. |
| See a step's image large | Click the image. Press `Esc` or click outside it to close it. |
| Remove a step | **Delete**. The step leaves the guide only; its capture stays in the Library. |
| Bring a deleted step back | **Undo** in the notice that appears, or press `⌘ Z` (`Ctrl Z` on Windows and Linux). Each press brings back the last step you deleted, in its old place, while the Guide window is open. |
| Mark up a step | **Open in editor**. Reopen the guide afterwards to see your changes in the export. |
| Copy the guide | **Copy** puts it on the clipboard as formatted text with its images, and as Markdown text for apps that take only text. |

The image editor, Library and guide share the last folder you chose for export. The first time, the dialog opens in your Grab-it save folder.

**Export** writes the guide as:

| Format | What you get |
| --- | --- |
| **Markdown** | `<name>.md`, with its images in a `<name> images` folder beside it (`step-01.png` onwards) |
| **HTML** | One `.html` file, with its images inside it |
| **Word document** | A `.docx` with a numbered heading for each step and its image below |
| **PowerPoint deck** | A `.pptx` with a title slide, then one slide per step with its description and image |

## Open a guide again

Each guide is saved in your save folder as `guides/Grab-it Guide YYYY-MM-DD HH-MM-SS.guide.json`. To open one again, run:

```sh
grab-it --open guide ~/Pictures/Grab-it/guides/"Grab-it Guide 2026-11-17 09-30-00.guide.json"
```

See [Where Grab-it is](/grab-it/reference/command-line/#where-grab-it-is) for the full path to `grab-it` on your system.
