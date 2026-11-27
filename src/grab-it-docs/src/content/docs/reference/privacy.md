---
title: Privacy
description: What stays on your computer, and the few things Grab-it sends over the internet.
sidebar:
  order: 8
---

Grab-it has no account, no analytics and no tracking. Your captures stay on your computer unless you choose an AI provider in the cloud.

## What stays on your computer

- **Your captures and recordings**: files in your save folder.
- **The Library**: its index, thumbnails, tags and notes, in Grab-it's app data folder and your save folder.
- **Reading text in images**, and reading QR codes and barcodes. Grab-it does this on your computer: on macOS and Windows with the text recognition built into the system, which runs on your computer, and on Linux, or when Windows has no text recognition for your languages, with its own models.
- **Settings**: `settings.json` in Grab-it's app data folder. An endpoint API key goes in your system keychain instead, where there is one, stored for that endpoint's address only.

## What goes over the internet

| What | When | Where to |
| --- | --- | --- |
| Update check | Shortly after Grab-it starts, then every few hours, when you click **Check for updates…** or the refresh button next to the version, and when you switch update channel | GitHub: the latest Grab-it release on Stable; on Edge, GitHub’s releases API to find the newest published version, then that version’s update manifest |
| ffmpeg | Once, the first time you record an MP4, if your computer has no ffmpeg that works (not on macOS) | A pinned FFmpeg-Builds release on GitHub, checked against a checksum built into Grab-it |
| Speech model (Whisper base, about 290 MB) | Once, the first time you click **Transcribe** in the video editor's [Captions](/grab-it/video-editor/captions/), after it says the size | Hugging Face: `onnx-community/whisper-base` at a pinned revision (`27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c`), checked against checksums built into Grab-it |
| Your screenshots, with their text, app and window title | Only with AI descriptions on, for each capture described or text tidied, and for each click in a [step capture](/grab-it/capture/step-capture/): its screenshot with the step's badge drawn on it | Your chosen [AI provider](/grab-it/ai/providers/#what-goes-where) |
| The capture open in the editor, the text read in it with its positions, and your request | Each time you press **Suggest** in [Annotate with AI](/grab-it/ai/annotate/), with a provider chosen | Your chosen [AI provider](/grab-it/ai/providers/#what-goes-where) |

**Show in folder**, **Open link** on a scanned QR code, **Send feedback** in the tray menu, and the links in Grab-it open in your own apps and browser, and only when you click them. **Send feedback** puts your Grab-it version and system (such as *Linux x86_64 (Wayland)*) in the GitHub form's address; nothing is sent until you submit the form.

## AI

AI integration is off until you choose a provider in **Settings → AI integration** and press **Save**. Grab-it never turns it on by itself. **Test connection** sends only a small test image built into Grab-it, never one of your captures, and saves nothing; Settings names where it goes before you press it. **List models** asks the endpoint which models it offers, with your API key if you typed one, and sends no image. Your screenshots go:

- **Claude Code**: to Anthropic, under your Claude account.
- **Codex**: to OpenAI, under your ChatGPT or OpenAI account.
- **An endpoint on your computer**, such as LM Studio or Ollama: nowhere.
- **A cloud endpoint**: to that provider. OpenRouter passes them on to the provider of the model you chose.

Turn off **Use an AI provider** in **Settings → AI integration** and nothing more is sent. See [AI](/grab-it/ai/).

## AI agents

[AI agents](/grab-it/ai/agents/) can take screenshots only after you turn on **Settings → AI integration → Let AI agents use Grab-it**; it's off by default. The commands reach only the Grab-it running as you, on this computer: through a socket file only you can open on Linux and macOS, and a pipe only you can connect to on Windows. Every screenshot an agent takes shows a notice and is tagged **agent** in your Library. Grab-it sends nothing over the internet for them; what the agent does with a screenshot is up to the agent.

## Recordings

Microphone, system sound and webcam are off by default, and recorded only when you turn them on in [Settings → Recording](/grab-it/reference/settings/#recording). **Show keystrokes** draws the keys you press into the recording. On macOS, keys typed into a password field are left out; on Windows and Linux they aren't, so turn it off before you type a password.

[Suggest edits](/grab-it/video-editor/suggest-edits/) listens for pauses and plays its **Original** and **Cleaned** auditions on your computer, with Grab-it's own ffmpeg and noise model. The sound is never sent anywhere.

[Captions](/grab-it/video-editor/captions/) are transcribed on your computer with the downloaded speech model. Your recordings, their sound and their transcripts are never sent anywhere, and no AI provider is used.
