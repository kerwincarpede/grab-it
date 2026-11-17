---
name: grab-it
description: Take screenshots of the user's screen, a display, a window or a region with Grab-it, and list the displays and windows to choose from. Use when you need to see what is on screen, check a UI you changed, or attach a screenshot.
---

# Grab-it

Grab-it is the screenshot app running on this computer. Its command line asks
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

## Limits

- On Wayland the desktop alone may read the screen, so these commands fail
  there with a message saying so.
- Capture only what the task needs: the user sees every capture in their
  Library.

Run `"{{GRAB_IT}}" help` for every option.
