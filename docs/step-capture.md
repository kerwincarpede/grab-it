# Step capture and the Guide window

Step capture turns doing a task into a how-to guide. While it runs, every click saves the window under the pointer as a normal capture, with a numbered step badge where you clicked and a short description of the step. Stopping opens the Guide window, where you reorder, edit and delete the steps, then export or copy the guide.

## Start and stop

- **Tray:** choose **Step capture**. While it runs the item reads **Stop step capture**.
- **Hotkey:** <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>8</kbd> on macOS, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>PrintScreen</kbd> elsewhere. Press it again to stop. Change it under **Settings → Hotkeys → Step capture**.
- **Hub:** **Step capture** under the capture tools.
- **Command line:** `grab-it --open steps` starts one, and running it again stops it.

Step capture watches the mouse across the whole desktop. On macOS it asks for **Input Monitoring** the first time, as Show clicks does for recordings. It is not available on Wayland, where apps cannot watch clicks, and it cannot run during a recording.

## What each click saves

- The frame is taken as soon as the button goes down, so it shows the screen just before the click. Saving happens in the background and never delays the next click's frame.
- Grab-it captures the window under the pointer. When you click a menu, a popover or a window smaller than 400 × 300 points, such as a small dialog, it captures the whole monitor instead, for context.
- Clicks on Grab-it's own windows and menus are not steps. When you stop from the tray or the hub, the click that opened it is left out too.
- Each step is an ordinary capture in `originals/`, listed in the Library like any other. Steps are not copied to the clipboard and do not open Quick Access.
- The badge sits where you clicked and shows the step's place in the guide. Open the capture in the editor to move it or add more marks.
- A double click counts as one step. A click within 24 pixels of the previous step's badge, in the same window, on a screen that has barely changed, is skipped as a repeat.

## Descriptions

With [AI descriptions](https://kerwincarpede.github.io/grab-it/ai/descriptions/) turned on, the chosen provider writes one short instruction for each step, such as "Click Save in the toolbar." Until it answers, or when AI is off, a step reads `Click in <app>`. Every description stays editable, and one you have edited is never replaced.

## The Guide window

Stopping a step capture opens its guide. Each step shows its capture with its badge and any edits made in the editor, and its description.

- **Move up** and **Move down** reorder the steps. Their badges are renumbered to match.
- Edit a description in place; it is saved when you leave the field.
- **Delete** removes a step from the guide only. Its capture stays in the Library.
- **Open in editor** opens the step's capture in the editor. Reopen the guide afterwards to see your changes in the export.
- **Export** writes the guide as:
  - **Markdown:** `<name>.md`, with its images in a `<name> images/` folder beside it (`step-01.png` onwards).
  - **HTML:** one file, with its images inside it.
  - **Word document** (`.docx`): a numbered heading for each step, with its image below.
  - **PowerPoint deck** (`.pptx`): a title slide, then one slide per step with its description and image.
- **Copy** puts the guide on the clipboard as formatted text with its images, and as plain Markdown text for apps that take only text.

## Where guides are kept

Each guide is a file in the save folder: `guides/Grab-it Guide YYYY-MM-DD HH-MM-SS.guide.json`. It lists the steps in order, each with its capture's path from the save folder and its description:

```json
{
  "version": 1,
  "steps": [
    { "capture": "originals/Grab-it 2026-11-17 09-30-12.png", "description": "Open the File menu." }
  ]
}
```

To open a guide again, run `grab-it --open guide "<path to the .guide.json>"`. A Guides section in the Library is planned.
