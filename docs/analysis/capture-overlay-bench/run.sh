#!/bin/bash
# Runs the overlay bench (bench.patch applied, release binary built) and
# prints medians. See ../capture-overlay-performance.md.
#
# Usage: run.sh <label> <switches> [runs]
#   switches: comma-separated, "" for none. cap60, png, noloupe, nolensdraw,
#             nodim, noguides, noblend, nobackdrop, noselection, noimage, nohint
# Logs go to $BENCH_OUT (default: $TMPDIR/grab-it-bench).
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
LABEL="$1"; OFF="$2"; RUNS="${3:-3}"
LOG="$OUT/bench-$LABEL.log"; : > "$LOG"
GRAB_IT_TRACE_OVERLAY=1 GRAB_IT_OVERLAY_BENCH="$OFF" "$B" >> "$LOG" 2>&1 < /dev/null &
pid=$!
sleep 4 # spare overlays are made 400 ms after startup
before=$(python3 "$HERE/cpu.py" $pid)
for i in $(seq 1 "$RUNS"); do
  echo "--- run $i" >> "$LOG"
  "$B" --open region >/dev/null 2>&1
  for _ in $(seq 1 60); do # wait for the drag report
    [ "$(grep -c '"phase":"drag"' "$LOG")" -ge "$i" ] && break
    sleep 0.25
  done
  sleep 1.5
done
after=$(python3 "$HERE/cpu.py" $pid)
echo "CPU $RUNS $before $after" >> "$LOG"
kill $pid; wait $pid 2>/dev/null
python3 - "$LOG" "$LABEL" <<'PY'
import json, sys, statistics as st
log, label = sys.argv[1], sys.argv[2]
rows = {"hover": [], "drag": []}; opens = []; cpu = None
for l in open(log):
    if l.startswith("BENCH "):
        d = json.loads(l[6:])
        if "phase" in d: rows[d["phase"]].append(d)
        else: opens.append(d["open"])
    elif l.startswith("CPU "):
        _, n, *v = l.split(); n = int(n); v = list(map(float, v)); k = len(v) // 2
        names = ["app", "webcontent", "gpu", "windowserver"]
        cpu = " ".join(f"{names[i]}={round((v[k+i]-v[i])/n*1000)}ms" for i in range(k))
med = lambda xs: round(st.median(xs), 1) if xs else None
keys = ["fps", "frameP50", "frameP95", "frameMax", "missed", "moves",
        "scriptPerMove", "scriptP95", "renderPerFrame", "renderP95"]
for ph, rs in rows.items():
    if not rs: print(label, ph, "NO DATA"); continue
    print(f"{label:14s} {ph:5s} n={len(rs)} " + " ".join(f"{k}={med([r[k] for r in rs])}" for k in keys))
if cpu: print(f"{label:14s} cpu/run {cpu}")
if opens:
    print(f"{label:14s} open  " + " ".join(f"{k}={med([o.get(k, 0) for o in opens])}" for k in opens[0]))
PY
