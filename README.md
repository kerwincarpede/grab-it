<div align="center">

# Grab-it

### Capture it. Mark it. Paste it.

**The fast, free screenshot and screen recording tool for Windows, macOS and Linux.**<br>
One key to capture, a few clicks to explain, and it's already on your clipboard.

<br>

<a href="https://github.com/kerwincarpede/grab-it/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download-Windows-0090ff?style=for-the-badge&logo=windows&logoColor=white"></a>
<a href="https://github.com/kerwincarpede/grab-it/releases/latest"><img alt="Download for macOS" src="https://img.shields.io/badge/Download-macOS-7b5cff?style=for-the-badge&logo=apple&logoColor=white"></a>
<a href="https://github.com/kerwincarpede/grab-it/releases/latest"><img alt="Download for Linux" src="https://img.shields.io/badge/Download-Linux-ff6ac1?style=for-the-badge&logo=linux&logoColor=white"></a>

<a href="https://github.com/kerwincarpede/grab-it/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kerwincarpede/grab-it?label=latest&color=30a46c"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>

<br><br>

<img src="docs/assets/demo.gif" alt="Animation in five parts. Capture: the Capture & record… toolbar opens, a region is dragged and sized, and the capture lands on the Quick Access card. Mark it up: an arrow, a box, numbered steps, a blur and a note are added, the capture goes on a gradient backdrop and is copied. Copy text: the code on a screen share is selected and copied as text, tidied up by AI. Record and edit: the screen is recorded, then trimmed in the video editor with a zoom that follows the cursor, and exported. Find it again: searching the Library for invoice finds a receipt by the text inside it, with an AI description and tags." width="100%">

**[Get started in 2 minutes](https://kerwincarpede.github.io/grab-it/get-started/)**

</div>

---

## Why Grab-it?

Explaining something on screen shouldn't take ten steps and three apps. With Grab-it it takes about three seconds:

1. **Press `PrintScreen`** (or `⌘ ⇧ 2` on a Mac).
2. **Drag** over what you want to share.
3. **Paste.** It's already on your clipboard.

Want to point something out first? Click **Annotate** on the card that pops up. Need to show it moving? Record it. Took it last month? Search for the words in it.

## What you can do

<table>
<tr>
<td width="50%" valign="top">

### Capture anything
A region, a window, one monitor or all of them, with a magnifier for pixel-perfect edges. The **Capture & record…** toolbar (`Ctrl Alt PrintScreen`, `⌘ ⇧ A`) opens from the tray, hub or Library. Press the shortcut again to dismiss it. While it’s open, keys `1`–`7` choose a mode and `8` cycles the timer. Press `Enter` to confirm a held selection. Repeat your last region in one click, or pick any colour off the screen.

</td>
<td width="50%" valign="top">

### Mark it up
Arrows, boxes, numbered steps, text, highlights, freehand, spotlights and stamps (check marks, pointers, keys and emoji), each one keystroke away. Blur or pixelate anything private, crop, then put it on a gradient with padding, rounded corners and a shadow. Your original is never changed, so you can reopen a capture and move that arrow weeks later.

</td>
</tr>
<tr>
<td valign="top">

### Copy text off the screen
Drag over text you can't select, in an image, a video, a screen share or an error dialog, and it's on your clipboard. QR codes and barcodes are read too. With AI turned on, misread characters are fixed and JSON, code and tables come out properly laid out.

</td>
<td valign="top">

### Record your screen
Record a region, a window or a whole display as an MP4 or a GIF. Add your microphone, the sound your computer plays, a webcam bubble, and rings for clicks and labels for the keys you press.

</td>
</tr>
<tr>
<td valign="top">

### Polish the recording
Trim the start and end, zoom in on an area or follow the pointer with smooth easing, and put the video on a backdrop in any shape, from 16:9 to 9:16. Export a new MP4; the recording itself is left as it was.

</td>
<td valign="top">

### Find it again
The Library keeps every screenshot and recording, grouped by day. Search by the words *inside* an image, a QR code's link, the app, tags, notes or date. Text recognition runs on your computer, never in the cloud.

</td>
</tr>
<tr>
<td valign="top">

### Let AI describe it
Grab-it can write a short description, a category and tags for each capture, so you can search for what it *shows*. It uses an AI you already have: [Claude Code](https://claude.com/claude-code), Codex, or any OpenAI-compatible model, including one running on your own computer. Turn it off any time.

</td>
<td valign="top">

### Keep it handy, keep it tidy
Pin a capture above your other windows as a reference while you work. Choose how long captures are kept, star the ones to keep forever, and see how much space your Library uses.

</td>
</tr>
</table>

## Get it

Grab-it is free and open source.

**macOS and Linux:** install and open it with one command:

```sh
curl -fsSL https://kerwincarpede.github.io/grab-it/install.sh | sh
```

**Homebrew (macOS):**

```sh
brew install --cask kerwincarpede/tap/grab-it
```

**Windows, or to install by hand:**

1. Download the installer for your computer from the **[latest release](https://github.com/kerwincarpede/grab-it/releases/latest)**.
2. Follow the **[Grab-it guide](https://kerwincarpede.github.io/grab-it/)**. It covers installing on Windows, macOS and Linux, your first capture, editing screenshots and recordings, and every shortcut.

Grab-it keeps itself up to date: it checks for new releases and asks before installing one.

| Guide | What's in it |
| --- | --- |
| [Getting started](https://kerwincarpede.github.io/grab-it/get-started/) | Install Grab-it and take your first annotated screenshot |
| [Recording](https://kerwincarpede.github.io/grab-it/recording/) | Record your screen, then trim, zoom and export it |
| [Library](https://kerwincarpede.github.io/grab-it/library/) | Search, tags, notes and copying text from old captures |
| [Keyboard shortcuts](https://kerwincarpede.github.io/grab-it/reference/keyboard-shortcuts/) | Every hotkey, on every platform |
| [Troubleshooting](https://kerwincarpede.github.io/grab-it/reference/troubleshooting/) | Fixes for the most common hiccups |
| [Developing Grab-it](docs/development.md) | Build from source, run the checks, and contribute |

## Contributing

Bug reports, ideas and pull requests are all welcome. [Open an issue](https://github.com/kerwincarpede/grab-it/issues) to get started, and see [Developing Grab-it](docs/development.md) to build it locally. Grab-it is made with Rust and [Tauri](https://tauri.app/).

## License

[MIT](LICENSE). Grab-it ships the [ocrs](https://github.com/robertknight/ocrs) text-recognition models, which are under their own licence: Ocrs models (https://github.com/robertknight/ocrs-models), trained on the HierText dataset by Google Research. Licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). See [`ocr-models/LICENSE.md`](src/grab-it/src-tauri/ocr-models/LICENSE.md). It also ships the [UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) RFB-320 face-detection model, under the [MIT licence](src/grab-it/src-tauri/face-models/LICENSE.md), for Blur private details, the [beguiling-drafter](https://github.com/GregorR/rnnoise-models) RNNoise model, which its author places outside copyright (see [`noise-models/LICENSE.md`](src/grab-it/src-tauri/noise-models/LICENSE.md)), for Remove background noise, Google's [MediaPipe selfie segmentation](https://huggingface.co/onnx-community/mediapipe_selfie_segmentation) model, under the [Apache License 2.0](src/grab-it/src-tauri/segmentation-models/LICENSE.md), for the webcam's Blur and Colour backgrounds, and emoji from [Noto Emoji](https://github.com/googlefonts/noto-emoji) under the [Apache License 2.0](src/grab-it/src/editor/stamps/LICENSE) for stamps.
