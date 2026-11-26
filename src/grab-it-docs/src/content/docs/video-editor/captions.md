---
title: Captions
description: Transcribe the speech in your recordings into captions on this computer, correct, retime and style them, then burn them into the export or save a subtitle file.
sidebar:
  order: 7
---

Captions make a narrated recording easy to follow with the sound off. **Transcribe** turns what's said in each recording of the video into timed captions, on your computer. You can then correct their words, move and resize them on the caption row, choose how they look, and burn them into the exported MP4 or save them as an SRT or WebVTT subtitle file.

## Transcribe

1. Click **Captions** in the top bar.
2. Click **Transcribe**.

Grab-it listens to each recording in the video that has no transcript yet, one after another, and shows its progress. Click **Cancel** to stop; recordings already transcribed keep their captions. The language is detected for you.

Grab-it listens to the microphone when the recording kept it apart, and otherwise to the recording's own sound. A recording with only system sound, or with no sound, shows **No sound to transcribe**. You can still add captions to it by hand.

### The speech model

The first time you transcribe, Grab-it needs its speech model, Whisper base, about 290 MB. **Transcribe** says its size before anything is downloaded. It downloads once, from Hugging Face, is checked against a checksum built into Grab-it, and is kept in Grab-it's app data folder for next time. Cancelling stops the download.

Transcribing runs entirely on your computer. Your recordings and their sound are never sent anywhere, and no [AI provider](/grab-it/ai/providers/) is used. See [Privacy](/grab-it/reference/privacy/).

### The transcript

Each recording's transcript is saved beside it as `<name>.transcript.json`, with the time of every word. It moves, and is deleted, with its recording in the [Library](/grab-it/library/).

Captions are made from the transcript: each is at most two lines of 42 characters and 6 seconds long, split between words. In a video narrower than 16:9 the text is smaller, and a caption too long for two lines there is shown smaller still. Their times are fitted to where the recording has speech, which follows it closely but not exactly, so a caption can show a little early or late: drag its edges on the caption row to retime it. Editing a caption never changes the transcript or the recording.

Clicking **Transcribe** again when the video already has captions asks first, then replaces them with fresh ones made from each recording's saved transcript: Whisper doesn't run again on a recording that already has one.

## The caption row

Captions sit on their own row under the timeline and the zoom row. Each shows its text. A caption follows the words it belongs to: trim, cut, move or duplicate a clip and its captions go with it, showing wherever those words play.

- **Select** a caption by clicking it. Its text shows in the top bar: type there to correct it.
- **Move** it by dragging it, and **resize** it by dragging its edges.
- **Add** one by double-clicking an empty stretch of the row over a clip. Captions can't be added over a gap.
- **Delete** the selected caption with **Delete caption** in the top bar, or press `Delete`.

Click an empty part of the row, or press `Esc`, to deselect it. Every change is one step you can undo.

## How they look

The **Captions** panel sets how every caption in the video looks:

- **Look**: **Box** (the default) puts white text on a dark box, **Outline** draws a dark edge around white text, and **Plain** shows white text with a soft shadow.
- **Size**: **Small**, **Medium** (the default) or **Large**. Captions scale with the video's height on widescreen video, and with its width on square and portrait video, so they fit across it. A long caption gets a little smaller to stay on two lines.
- **Position**: **Bottom** (the default) or **Top**, centred across the video.

The preview shows the caption under the playhead as the export will draw it. Each change is one step you can undo, and the style is kept with the video's other edits.

## Export

**Burn in captions** in the **Captions** panel is on by default: the export draws the captions into the MP4's picture, so they show in any player. Turn it off to export without them.

Captions aren't added to GIFs or screenshots, and the MP4 never gets a subtitle track you can switch off.

## Subtitle files

To give a player or a video site captions viewers can switch on and off, save them as a subtitle file:

1. Click **Captions** in the top bar.
2. Click **Save subtitles…**.
3. Choose where to save it. The name starts as the recording's, ending in `.srt`.

End the name in `.srt` for SubRip or `.vtt` for WebVTT; Grab-it writes the format the name asks for. The file's times match the exported MP4, so trims, cuts and gaps are already allowed for. A caption on a clip that plays twice is listed once for each time it plays. Empty captions are left out, and the look, size and position aren't saved in the file: the player chooses how subtitles look.

Saving subtitles doesn't need an export, and whether **Burn in captions** is on doesn't change the file. Burn the captions in and add the subtitle file too, and they show twice.
