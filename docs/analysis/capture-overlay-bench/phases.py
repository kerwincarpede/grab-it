# Per-phase medians from a bench log: fps, misses, and CPU of WindowServer /
# WebKit GPU process / app during hover (2.9 s) and drag (3.0 s).
import json, re, sys, statistics as st
for log in sys.argv[1:]:
    runs = []; cur = None; pending = None
    for l in open(log):
        if l.startswith("BENCH {"):
            d = json.loads(l[6:]); pending = d
        elif l.startswith("BENCHCPU") and pending is not None:
            c = {k: float(v) for k, v in re.findall(r"(\w+)=([\d.]+)", l)}
            if "open" in pending: cur = {"open": pending["open"], "c0": c}; runs.append(cur)
            elif cur is not None:
                prev = cur.get("clast", cur["c0"])
                cur[pending["phase"]] = (pending, {k: round((c[k] - prev[k]) * 1000) for k in c})
                cur["clast"] = c
            pending = None
    med = lambda xs: round(st.median(xs), 1) if xs else None
    name = log.split("bench-")[-1].replace(".log", "")
    for ph in ("hover", "drag"):
        rs = [r[ph] for r in runs if ph in r]
        if not rs: print(f"{name:14s} {ph} NO DATA"); continue
        print(f"{name:14s} {ph:5s} n={len(rs)} fps={med([r[0]['fps'] for r in rs])} p95={med([r[0]['frameP95'] for r in rs])} max={max(r[0]['frameMax'] for r in rs)} missed={sum(r[0]['missed'] for r in rs)} "
              f"style={med([r[0]['renderPerFrame'] for r in rs])} | WS={med([r[1]['ws'] for r in rs])}ms GPU={med([r[1]['gpu'] for r in rs])}ms app={med([r[1]['app'] for r in rs])}ms")
    if runs: print(f"{name:14s} open  " + " ".join(f"{k}={med([r['open'].get(k,0) for r in runs])}" for k in runs[0]['open']))
