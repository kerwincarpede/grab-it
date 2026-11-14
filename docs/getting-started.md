# Getting started with Grab-it

Welcome! This guide takes you from download to your first annotated screenshot in about two minutes, then shows you the rest of what Grab-it can do.

- [1. Install](#1-install)
- [2. Your first capture](#2-your-first-capture)
- [3. Mark it up](#3-mark-it-up)
- [4. Find it again later](#4-find-it-again-later)
- [More tricks](#more-tricks)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)

---

## 1. Install

Grab the installer for your computer from the **[latest release](https://github.com/kerwincarpede/grab-it/releases/latest)** (scroll down to *Assets*).

| Your computer | Download | |
| --- | --- | --- |
| **Windows** 10 or 11 | `Grab-it_<version>_x64-setup.exe` | Recommended. The `.msi` works too. |
| **macOS** on Apple silicon (M1 or later) | `Grab-it_<version>_aarch64.dmg` | |
| **Linux**: Ubuntu, Debian, Mint, Pop!_OS | `Grab-it_<version>_amd64.deb` | |
| **Linux**: Fedora, openSUSE, RHEL | `Grab-it-<version>-1.x86_64.rpm` | |
| **Linux**: anything else | `Grab-it_<version>_amd64.AppImage` | Runs without installing. |

> [!NOTE]
> Grab-it isn't signed with a paid developer certificate yet, so Windows and macOS warn you the first time you open it. That's expected. The steps below get you past it.

### Windows

1. Double-click `Grab-it_<version>_x64-setup.exe`.
2. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. Follow the installer. Grab-it starts when it finishes.

### macOS

1. Open the `.dmg` and drag **Grab-it** into **Applications**.
2. Open Grab-it from Applications. macOS says it can't verify the developer: click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Grab-it. Confirm, and Grab-it opens.

   *Comfortable with Terminal?* This does the same thing in one line:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Grab-it.app
   ```

4. The first time you capture, macOS asks for **Screen Recording** permission. Grab-it offers to open the right page in System Settings. Turn it on for Grab-it, then quit and reopen Grab-it.

### Linux

**Debian / Ubuntu:**

```sh
sudo apt install ./Grab-it_*_amd64.deb
```

**Fedora / openSUSE:**

```sh
sudo dnf install ./Grab-it-*.x86_64.rpm      # or: sudo zypper install ./Grab-it-*.rpm
```

**AppImage:**

```sh
chmod +x Grab-it_*_amd64.AppImage
./Grab-it_*_amd64.AppImage
```

Then launch **Grab-it** from your app menu.

> [!TIP]
> Grab-it lives in the system tray. On GNOME, the tray needs the *AppIndicator and KStatusNotifierItem Support* extension. Ubuntu includes it already; on Fedora, install `gnome-shell-extension-appindicator`.

### Updates

Once installed, Grab-it keeps itself up to date. About half a minute after it starts, and every few hours after that, it checks for a new release and asks before installing it, listing what's new since your version. Choose **Install and Restart**, or **Later** to be asked again the next time Grab-it starts. **Check for updates…** in the tray menu checks right away.

Updates install the same kind of package you installed: the `.deb` or `.rpm` asks for your password, like `apt` or `dnf` would.

---

## 2. Your first capture

When Grab-it starts it **doesn't open a big window**. It sits quietly in your system tray (menu bar on macOS), ready when you need it. The very first time, a short **Welcome** window lists your hotkeys and has a **Capture a region now** button. Give it a try.

1. **Press `PrintScreen`** (on macOS: **`⌘ ⇧ 2`**). The screen freezes and dims.
2. **Drag** over the part you want. A magnifier shows the exact pixel under your pointer, so you can line things up perfectly.
   - Or just **click a window** to grab the whole window.
   - Hold **Shift** for a perfect square, or **Space** to move the selection around.
   - **Esc** or right-click cancels.
3. **Let go.** That's it! 🎉

Your capture is now:

- **on your clipboard**, ready to paste into Slack, an email, a doc or a ticket,
- **saved** as a PNG in `Pictures/Grab-it`, and
- shown on a **Quick Access** card in the corner of your screen.

### The Quick Access card

The card offers what you most likely want next:

| Button | What it does |
| --- | --- |
| **Copy** | Copies the capture again |
| **Annotate** | Opens it in the editor (clicking the preview does too) |
| **Pin** | Floats it above your other windows |
| 📁 / 🗑 | Shows it in its folder, or deletes it |

The card fades away on its own after a few seconds. Rest your pointer on it to keep it around. Missed it? The tray's **Show last capture** brings it back.

---

## 3. Mark it up

Click **Annotate** and the editor opens. Pick a tool from the rail on the left, or press its key:

| Tool | Key | Great for |
| --- | --- | --- |
| Arrow | `A` | "Click here" |
| Rectangle / Ellipse | `R` / `E` | Boxing in the important bit (can be filled) |
| Line / Freehand | `L` / `P` | Underlines and doodles |
| Text | `T` | Notes and labels, with an optional background |
| Step | `N` | Numbered steps (1, 2, 3…) for how-to guides |
| Highlighter | `H` | Highlighting text |
| Blur | `B` | Hiding emails, names and passwords (pixelated or smooth) |
| Spotlight | `S` | Dimming everything except what matters |
| Crop | `C` | Trimming the edges, free or to a ratio (Original, 16:9, 4:3, 1:1, 9:16) |
| Select / Pan | `V` / `M` | Moving things around |

**Make it pretty:** turn on the **Backdrop** to put your screenshot on a gradient or solid colour, with padding, rounded corners and a soft shadow. Perfect for slides, docs and social posts.

**Turn, flip and resize:** the top bar's **Rotate left** and **Rotate right** buttons turn the screenshot a quarter turn, and **Flip horizontal** and **Flip vertical** mirror it. Your annotations and crop move with the image, and text and step numbers stay upright. **Resize** sets a new width or height (the aspect ratio stays locked) or a percentage, from 10% to 400%; the status bar shows the output size. Each change is one step you can undo.

**Handy keys while editing:**

- `Ctrl/⌘ + D` duplicates the selected shape.
- Arrow keys nudge it (hold `Shift` for bigger steps).
- With **Crop**, pick a ratio in the top bar to keep the crop to that shape (picking one reshapes a crop you already drew). Drag the crop to move it, or its handles to resize it. Hold `Shift` for a square Free crop. Crop edges snap to the image borders and to strong edges in the screenshot, such as window borders and panels; hold `Alt/⌥` while you drag to crop without snapping.
- `[` and `]` make lines thinner or thicker.
- `Ctrl/⌘ + [` and `Ctrl/⌘ + ]` rotate the screenshot left and right.
- `Ctrl/⌘ + C` copies the finished image.
- `Ctrl/⌘ + Enter` copies and closes the editor in one go.

When you're done, **Copy** it, **Export…** it to a file, or **Pin** it. Your edits are saved automatically and you can change them any time. The original screenshot is never altered.

---

## 4. Find it again later

Click the Grab-it icon in the menu bar or tray and choose **Open Grab-it** (or click its Dock icon on a Mac) to see every capture, newest first. The sidebar lists the apps you've captured from; pick one to see only its captures.

The search box finds captures by **the text inside the image**, as well as by tags, notes, the app you captured, and its window title. Remember a word that was in that error message or receipt? Type it:

- `inv 2026` finds a receipt that says "Invoice 2026-03". Each word matches the start of a word.
- Search also finds what a **QR code or barcode** in a capture holds, such as the link in a QR code or the number under a barcode.
- Narrow things down by **app** in the sidebar, or by **tag** or **date range** in the filter bar.
- Select a capture to open it in the editor, copy it, pin it, or add **tags** and **notes**.
- **Copy the text in a capture** with the text button (a "T" in a frame) on its tile or in its details. The details also show all the text Grab-it found, so you can select and copy just part of it. This works for any capture, including full-screen ones, long after you took it.

> [!NOTE]
> Reading the text in images happens on your computer, never in the cloud. The first time it's needed, Grab-it downloads a small text-recognition model (about 12 MB), and the Library shows the progress.

### AI descriptions

If you have [Claude Code](https://claude.com/claude-code) installed, Grab-it uses it to describe each new capture: a sentence or two, a category and a few tags, so you can search for what a screenshot *shows* and filter by category. It turns this on by itself the first time it finds Claude Code, and the Library says so once. Those screenshots go to Anthropic under your Claude account.

The same AI tidies up **Capture text**. The text is copied the moment it's read, then the AI reads it again from the image. It fixes what was misread, and lays out JSON (valid and indented), code (with its indentation) and tables (as Markdown). The tidied text replaces what was copied, unless you've copied something else since. **Copy as read** on the card gets the original back. Turn it off under **Tidy up captured text**.

To turn it off, or use another provider such as a local [Ollama](https://ollama.com) model that keeps everything on your computer, open **Settings** → **AI descriptions**. Without Claude Code but with [Codex](https://developers.openai.com/codex/cli) installed, Grab-it uses Codex the same way, and those screenshots go to OpenAI under your ChatGPT or OpenAI account. With neither, describing stays off until you turn it on there.

---

## More tricks

Click the Grab-it icon in the menu bar or tray for all of these. On Windows and macOS the click opens a small panel with a button for each capture, your latest captures, and links to the Grab-it window and Settings; right-click for the full menu. On Linux the click opens the menu.

| | |
| --- | --- |
| 📌 **Pin** | Float a capture above everything else as a reference while you work. Drag it around, scroll (or press `+`/`-`) to resize, double-click or `Esc` to close. |
| 🔤 **Capture text** | Drag over anything on screen, even text in an image or video, and the text is copied, ready to paste. With [AI](#ai-descriptions) on, it's then tidied up: misread characters are fixed, and JSON, code and tables come out properly laid out. Drag over a QR code or barcode and its contents are copied instead (see below). |
| 🔳 **Scan a code** | Use **Capture text** on a QR code or barcode, no phone needed. Its contents are copied, one per line when there are several, and the card shows what it found. **Copy text** copies the words around the code instead, and **Open link** opens a web link in your browser. Grab-it never opens a link unless you click. |
| 🎨 **Pick a colour** | Click any pixel to copy its colour as a hex code like `#4C8DFF`. |
| 🎞️ **Record GIF** | Record a region or window as an animated GIF, for up to a minute. Click **Stop** on the card (or in the tray) when you're done. |
| ⏱️ **Timed capture** | Wait 3, 5 or 10 seconds before capturing, so you have time to open a menu or hover a tooltip. |
| 🔁 **Repeat last region** | Capture the exact same area again, without dragging. |
| 🖥️ **Capture screen / Monitor** | Grab every monitor at once, or just one. |

---

## Keyboard shortcuts

| Action | Windows & Linux | macOS |
| --- | --- | --- |
| Capture a region (or click a window) | `PrintScreen` | `⌘ ⇧ 2` |
| Capture a window | `Alt + PrintScreen` | `⌘ ⇧ W` |
| Capture every monitor | `Ctrl + PrintScreen` | `⌘ ⇧ F` |
| Capture text | `Shift + PrintScreen` | `⌘ ⇧ 1` |
| Pick a colour | `Ctrl + Shift + PrintScreen` | `⌘ ⇧ 9` |

Don't like these? Change them in **Settings**: click a shortcut and press the keys you want. If another app already uses a shortcut, Settings tells you, and the tray menu always works.

**Shortcuts and tips** in the Grab-it window's sidebar shows your current shortcuts at any time.

---

## Settings

Open **Settings** from the gear in the Grab-it panel, or from the Grab-it window's sidebar, to change:

- **Hotkeys**: any shortcut you like.
- **After a capture**: show the Quick Access card (the default), jump straight into the editor, or do nothing.
- **Copy to clipboard**: on by default; turn it off if you'd rather not.
- **Save folder**: where captures go (default `Pictures/Grab-it`). Earlier captures stay where they are and stay in your Library.
- **Start Grab-it when you sign in**: so it's always ready.
- **AI descriptions**: on or off, and who describes your captures: Claude Code, Codex or an OpenAI-compatible endpoint. **Test connection** checks it works.
- **Show Grab-it in the Dock** (macOS): on by default; turn it off to keep Grab-it in the menu bar only.

---

## Troubleshooting

**I can't see Grab-it anywhere.**
It runs in the menu bar or system tray. Look for its icon near the clock (on Windows, check the **^** overflow arrow). On a Mac it's also in the Dock unless you turned that off. Opening Grab-it again from your app menu opens the Grab-it window.

**My PrintScreen key opens a different screenshot tool.**
Another app (or the operating system) has claimed that key. Either pick a different shortcut in Grab-it's **Settings**, or turn off the other tool's shortcut. On Windows 11, turn off the *Print screen key* option (it opens the Snipping Tool) under **Settings → Accessibility → Keyboard**.

**macOS captures only show my wallpaper, or nothing.**
Grab-it needs **Screen Recording** permission. Open **System Settings → Privacy & Security → Screen Recording**, turn on Grab-it, then quit and reopen it.

**On Linux (Wayland), the desktop asks me to pick an area itself.**
That's normal on Wayland: only the desktop is allowed to read the screen, so captures go through its own screenshot picker. *Repeat last region* and *Record GIF* aren't available there. If your desktop doesn't support global shortcuts for apps, use the tray menu.

**macOS captures show only my wallpaper again after an update.**
Updating from an older version can make macOS treat the updated app as a new one, once. Turn Grab-it off and on again under **System Settings → Privacy & Security → Screen Recording** (or remove it with **−** and add it back), then reopen it. Later updates keep the permission.

**Searching doesn't find text in an old capture.**
Grab-it reads captures one at a time in the background, newest first, so give it a moment. If the text-recognition download failed, the Library shows a **Retry** button.

Still stuck? [Open an issue](https://github.com/kerwincarpede/grab-it/issues/new) and tell us what happened.

---

Want to build Grab-it yourself or contribute? See [Developing Grab-it](development.md).
