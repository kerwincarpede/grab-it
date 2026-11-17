---
name: grab-it
description: Take screenshots and screen recordings of the user's screen, a display, a window or a region with Grab-it, turn videos into animated GIFs and contact sheets, and list the displays and windows to choose from. Use when you need to see what is on screen, check a UI you changed, show how something behaves over time, or attach a screenshot, recording or GIF.
---

# Grab-it

Grab-it is the screenshot and screen recording app running on this computer. Its command line asks
it to capture and prints one line of JSON per command. Errors go to stderr
with a non-zero exit code; read the message, it says what to do.

Run it by its full path:

```sh
"{{GRAB_IT}}" <command> [options]
```

Grab-it starts in the tray by itself when it is not running. The user must
have turned on **Settings › AI agents › Let AI agents use Grab-it**; until
then every command fails with a message saying so. Ask the user to turn it on
rather than looking for another way to capture.

## List what can be captured

```sh
"{{GRAB_IT}}" displays
# {"displays":[{"id":0,"name":"DELL U2720Q","x":0,"y":0,"width":2560,"height":1440,"scaleFactor":1.0,"primary":true}]}

"{{GRAB_IT}}" windows
# {"windows":[{"id":4194307,"app":"Firefox","title":"Docs","x":0,"y":25,"width":1280,"height":800}]}
```

Windows are listed front to back. Rectangles are desktop coordinates.

## Take a screenshot

```sh
"{{GRAB_IT}}" shot                          # every display
"{{GRAB_IT}}" shot --display 1              # one display, by id or name
"{{GRAB_IT}}" shot --window 4194307         # one window, by id
"{{GRAB_IT}}" shot --window Firefox         # the frontmost window whose app or title holds the text
"{{GRAB_IT}}" shot --region 0,0,800,600     # x,y,width,height in desktop coordinates
"{{GRAB_IT}}" shot --window Firefox --delay 2 --max-width 1280
# {"path":"/home/me/Pictures/Grab-it/originals/Grab-it 2026-11-17 09-00-00.png","width":1280,"height":800,"id":42}
```

- `--delay <seconds>` waits before capturing, up to 60.
- `--max-width <pixels>` scales the shot down to at most that width. Use it to
  keep images small enough to read back, such as `--max-width 1600`.

Open the file at `path` to look at it. Shots are saved in the user's Grab-it
Library tagged `agent`; they are not copied to the clipboard. Grab-it shows a
short "Captured by an agent" notice each time, so the user knows.

## Record the screen

```sh
"{{GRAB_IT}}" record --window Firefox --for 5
# {"path":"/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-00-00.mp4","durationMs":5012,"format":"mp4","id":43}

"{{GRAB_IT}}" record --region 0,0,1280,720 --cursor
# {"path":"/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-01-00.mp4","format":"mp4","recording":true}
# ... do what should be recorded, then:
"{{GRAB_IT}}" stop
# {"path":"/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-01-00.mp4","durationMs":8400,"format":"mp4","id":44}
```

`record` takes the same `--display`, `--window` and `--region` as `shot`.
With none, or `--screen`, it records the main display: a recording is of one
display.

- `--for <seconds>` stops after that long and prints the saved file. Without
  it, `record` prints the file it is writing to at once, and `stop` ends it
  and prints the saved file once it is written.
- `--format <mp4|gif>` records an MP4 (the default) or a GIF. A GIF stops by
  itself after a minute. Grab-it may save a GIF when ffmpeg is not ready yet:
  check `format` in the reply.
- `--fps <30|60>` sets an MP4's frames a second; 30 is the default.
- `--cursor` draws the pointer into the recording.

Recordings have no sound, webcam or countdown. Only one recording runs at a
time; the user can stop it from Grab-it's recording toolbar too, and `record
--for` then prints what was saved early. Recordings go in the Library tagged
`agent`, with a short "Recorded by an agent" notice.

## Make a GIF or a contact sheet of a video

Both work on any video file, such as a recording's `path`.

```sh
"{{GRAB_IT}}" gif "/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-00-00.mp4" --start 1 --end 4 --width 800
# {"path":"/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-02-00.gif","width":800,"height":450,"durationMs":3000,"id":45}

"{{GRAB_IT}}" frames "/home/me/Pictures/Grab-it/recordings/Grab-it 2026-11-17 09-00-00.mp4" --count 9
# {"path":"/home/me/Pictures/Grab-it/originals/Grab-it 2026-11-17 09-03-00.png","width":1464,"height":848,"frames":9,"id":46}
```

- `gif` options: `--start <seconds>` and `--end <seconds>` trim it, `--fps <n>`
  sets its frames a second (default 10, up to 50) and `--width <pixels>` its
  width (default the video's, up to 1280).
- `frames` makes one PNG of `--count` evenly spaced frames (default 12, up
  to 100) in a grid. You cannot watch a video, so look at a contact sheet to
  see what a recording shows, and send the user the GIF or the MP4.

Both need Grab-it's ffmpeg; while it is still being set up they fail with a
message saying to try again shortly.

## Limits

- On Wayland the desktop alone may read the screen, so `displays`, `windows`,
  `shot`, `record` and `stop` fail there with a message saying so. `gif` and
  `frames` still work.
- Capture only what the task needs: the user sees every capture in their
  Library.

Run `"{{GRAB_IT}}" help` for every option.
