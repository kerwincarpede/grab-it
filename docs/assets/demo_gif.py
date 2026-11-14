"""Render docs/assets/demo.svg to docs/assets/demo.gif, the looping demo in the README.

Run from the repository root:  python3 docs/assets/demo_gif.py docs/assets/demo.svg docs/assets/demo.gif

Needs Chrome (or Chromium or Edge) and ffmpeg. Set CHROME to the browser binary
if it is not found. Takes about a minute. Each frame is the SVG paused at one moment of its loop and
screenshotted by headless Chrome; ffmpeg joins the frames into a GIF that
repeats forever.
"""
import argparse
import base64
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CARD = "#0d1016"  # the card's own fill, painted behind its rounded corners

BROWSERS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge",
]


def find_browser():
    for name in [os.environ.get("CHROME"), *BROWSERS]:
        if name and (os.path.isfile(name) or shutil.which(name)):
            return name
    sys.exit("No Chrome, Chromium or Edge found. Set CHROME to the browser binary.")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("svg", type=Path)
    ap.add_argument("gif", type=Path)
    ap.add_argument("--fps", type=int, default=20, choices=[10, 20, 25, 50],
                    help="frames per second; a GIF times its frames in hundredths of a second (default 20)")
    ap.add_argument("--scale", type=float, default=1.0, help="pixels per SVG unit (default 1)")
    ap.add_argument("--frames", type=Path, help="also keep the PNG frames in this folder")
    args = ap.parse_args()

    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        sys.exit("ffmpeg and ffprobe not found.")
    browser = find_browser()

    svg = args.svg.read_text()
    width, height = (float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg).groups())
    loop = float(re.search(r"animation:\w+ ([\d.]+)s infinite", svg).group(1))
    count = round(loop * args.fps)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        frames = args.frames or tmp
        frames.mkdir(parents=True, exist_ok=True)
        workers = min(os.cpu_count() or 4, 8)
        profiles = queue.Queue()  # one browser profile per worker, so they can run side by side
        for i in range(workers):
            profiles.put(tmp / f"profile{i}")

        def shoot(i):
            # A negative delay on a paused animation shows it that far into its loop.
            pause = f"<style>*{{animation-delay:-{i / args.fps:.4f}s!important;animation-play-state:paused!important}}</style>"
            # Shown as an <img> on an opaque page, as the README shows it: every frame is then
            # fully opaque, which the GIF encoder needs to store only what changed since the last.
            data = base64.b64encode(svg.replace("</svg>", pause + "</svg>").encode()).decode()
            frame = tmp / f"{i:04d}.html"
            frame.write_text(f'<body style="margin:0;background:{CARD}">'
                             f'<img style="display:block" width="{width:.0f}" height="{height:.0f}"'
                             f' src="data:image/svg+xml;base64,{data}">')
            shot = frames / f"{i:04d}.png"
            profile = profiles.get()
            try:
                # A busy machine now and then makes Chrome exit without a screenshot, so try again.
                for _ in range(5):
                    run = subprocess.run(
                        [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
                         f"--user-data-dir={profile}", f"--force-device-scale-factor={args.scale}",
                         f"--window-size={width:.0f},{height:.0f}",
                         f"--screenshot={shot}", frame.as_uri()],
                        capture_output=True, text=True, timeout=120)
                    if shot.is_file() and shot.stat().st_size:
                        break
                else:
                    raise RuntimeError(f"Chrome did not render frame {i}:\n{run.stderr.strip()}")
            finally:
                profiles.put(profile)
            frame.unlink()

        with ThreadPoolExecutor(workers) as pool:
            for done, _ in enumerate(pool.map(shoot, range(count)), 1):
                print(f"\rframe {done}/{count}", end="", flush=True)
        print()

        # One palette for the whole loop, and ordered dithering: pixels that do not change
        # between frames then stay identical, so they cost almost nothing and do not shimmer.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(args.fps), "-i", str(frames / "%04d.png"),
             "-frames:v", str(count), "-filter_complex",
             "[0:v]format=rgb24,split[a][b];[a]palettegen=stats_mode=full[p];"
             "[b][p]paletteuse=dither=bayer:bayer_scale=2:diff_mode=rectangle",
             "-loop", "0", str(args.gif)],  # -loop 0 repeats forever
            check=True)

    made = int(subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(args.gif)],
        check=True, capture_output=True, text=True).stdout.strip())
    if made != count:
        sys.exit(f"{args.gif} has {made} frames, expected {count}.")
    print(f"wrote {args.gif} ({count} frames, {args.gif.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
