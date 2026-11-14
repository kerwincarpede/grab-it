#!/bin/bash
# Counts the overlay window's frames that actually reach the display while
# the bench drives it. Usage: presented.sh [switches] [runs]
set -u
# A running Grab-it Dev shares the bench's identifier: it would take the
# bench's `--open region` triggers and open an overlay on the user's screen.
if pgrep -x grab-it >/dev/null; then
  echo "Quit every running Grab-it (and Grab-it Dev) first: $(pgrep -lx grab-it | tr '\n' ' ')" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
B="${GRAB_IT_BIN:-$ROOT/app/src-tauri/target/release/grab-it}"
OUT="${BENCH_OUT:-${TMPDIR:-/tmp}/grab-it-bench}"
mkdir -p "$OUT"
[ -x "$OUT/presented" ] || swiftc -O "$HERE/presented.swift" -o "$OUT/presented" 2>/dev/null
for i in $(seq 1 "${2:-2}"); do
  # GRAB_IT_OVERLAY_BENCH must be set (even to "") or the bench never starts.
  GRAB_IT_OVERLAY_BENCH="${1:-}" "$B" > "$OUT/presented-$i.log" 2>&1 < /dev/null &
  pid=$!
  sleep 4
  echo "run $i: $("$OUT/presented" 8 "$B" $pid 2>/dev/null | head -1)"
  kill $pid; wait $pid 2>/dev/null; sleep 1
done
