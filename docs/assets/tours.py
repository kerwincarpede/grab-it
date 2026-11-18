"""Generate the tour animations on the docs site's landing page, one SVG per tour.

Run from the repository root:  python3 docs/assets/tours.py

Writes src/grab-it-docs/src/components/landing/tours/{capture,editor,video,library}.svg.
Each is a short loop of the real app at work, drawn like the README demo
(docs/assets/demo.py) and sharing its pieces from docs/assets/animkit.py.
"""
import math
import random
import sys
from pathlib import Path

from animkit import (MONO, Anim, chooser_toolbar, dashboard, head, logo, mode_icon, qlen, text_w, th_code, th_dash, th_figma,
                     th_receipt, th_rec, th_term, tile_bg, tr)

W, H = 720, 450
OUT = Path(__file__).resolve().parents[2] / "src/grab-it-docs/src/components/landing/tours"

CURSOR = '<path d="M0 0v21l5.2-5 3.6 8.4 3.8-1.6-3.6-8.2H16z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>'
CROSS = ('<path d="M0 -14v10M0 4v10M-14 0h10M4 0h10" stroke="#fff" stroke-width="2" stroke-linecap="round"/>'
         '<path d="M-1 -14v10M-1 4v10M-14 -1h10M4 -1h10" stroke="#000" stroke-opacity=".35" stroke-width="1"/>')
RED = "#e5484d"

# The dashboard window on the desktop: the README's, a little smaller.
DK, DX0, DY0 = .92, 45.5, 36


def D(x, y):
    """Dashboard coordinates -> desktop coordinates."""
    return DX0 + (x - 140) * DK, DY0 + (y - 58) * DK


DASH_ON_DESK = f'<g transform="translate({DX0} {DY0}) scale({DK}) translate(-140 -58)"><use href="#dash"/></g>'
DESK_BOX = (*D(140, 58), 684 * DK, 404 * DK)  # x, y, w, h of the window

BASE_DEFS = """
  <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#7a4b94"/></linearGradient>
  <linearGradient id="bd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset=".55" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff6ac1"/></linearGradient>
  <linearGradient id="bd2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ddc97"/><stop offset=".5" stop-color="#4c8dff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient>
  <linearGradient id="bd3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset="1" stop-color="#ff5e7e"/></linearGradient>
  <linearGradient id="bd4" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#5eead4"/></linearGradient>
  <linearGradient id="bd5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#475569"/></linearGradient>
  <linearGradient id="scangrad" x1="0" x2="1"><stop offset="0" stop-color="#4c8dff" stop-opacity="0"/><stop offset=".85" stop-color="#4c8dff" stop-opacity=".45"/><stop offset="1" stop-color="#9cc0ff" stop-opacity=".95"/></linearGradient>
  <radialGradient id="face" cx=".5" cy=".38" r=".7"><stop offset="0" stop-color="#f3c7a4"/><stop offset="1" stop-color="#c98d6b"/></radialGradient>
  <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1" fill="#2a2e37"/></pattern>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="36"/></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="12"/></filter>"""

STYLE = """
.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif}
.b{font-weight:700}
"""


def write(name, A, title, desc, defs="", poster=0.0):
    """Wrap the animation in its SVG and write it. `poster` is the moment shown when motion is reduced."""
    style = STYLE + f"@media (prefers-reduced-motion:reduce){{*{{animation-delay:-{poster}s!important;animation-play-state:paused!important}}}}\n" + "\n".join(A.css)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc" data-loop="{A.T}" data-poster="{poster}">
<title id="title">{title}</title>
<desc id="desc">{desc}</desc>
<style>{style}</style>
<defs>{BASE_DEFS}{defs}{dashboard()}</defs>
<rect width="{W}" height="{H}" fill="#0d1016"/>
{''.join(A.body)}
{''.join(A.ripples)}
<g id="cur">{CURSOR}</g>
</svg>
"""
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.svg").write_text(svg)
    print(f"wrote {OUT / name}.svg ({len(svg) // 1024} KB)")


def cursor(A, points, ease="cubic-bezier(.45,0,.3,1)"):
    """The pointer's path: (seconds, (x, y), opacity)."""
    A.kf("cur", [(t, f"opacity:{o};{tr(x, y)}") for t, (x, y), o in points], "#cur", ease)


def desktop(A, extra=""):
    A.body.append(f"""
<g id="desk">
  <rect width="{W}" height="{H}" fill="url(#wall)"/>
  <circle cx="90" cy="400" r="150" fill="#ff6ac1" opacity=".18" filter="url(#soft)"/>
  <circle cx="650" cy="60" r="170" fill="#3ddc97" opacity=".14" filter="url(#soft)"/>
  <rect x="{DESK_BOX[0]}" y="{DESK_BOX[1] + 5}" width="{DESK_BOX[2]}" height="{DESK_BOX[3]}" rx="11" fill="#000" opacity=".35" filter="url(#shadow)"/>
  {DASH_ON_DESK}
  {extra}
  <rect y="424" width="{W}" height="26" fill="#0b0d12" opacity=".72"/>
  <text x="702" y="441" class="t" font-size="11" fill="#e6e8ee" text-anchor="end">9:41</text>
  <circle cx="632" cy="437" r="3.5" fill="#9aa3b2"/><circle cx="648" cy="437" r="3.5" fill="#9aa3b2"/>
  {logo(612, 437, .62, "#e6e8ee")}
</g>""")


def keycaps(A, name, wins, label="Capture &amp; record…  ·  ⌘ ⇧ A on a Mac", cx=360, cy=210):
    """Ctrl + Alt + PrtSc, popping in and pressed once in each (start, end) window."""
    caps = [("Ctrl", 66), ("Alt", 56), ("PrtSc", 86)]
    gap = 26
    x = -(sum(w for _, w in caps) + gap * (len(caps) - 1)) / 2
    parts = []
    for i, (lab, w) in enumerate(caps):
        parts.append(f'<g class="cap"><rect x="{x}" y="-27" width="{w}" height="52" rx="11" fill="#f4f5f8"/>'
                     f'<rect x="{x}" y="-27" width="{w}" height="47" rx="11" fill="#fff"/>'
                     f'<text x="{x + w / 2}" y="2" class="t b" font-size="17" fill="#1f2328" text-anchor="middle">{lab}</text></g>')
        if i < len(caps) - 1:
            parts.append(f'<text x="{x + w + gap / 2}" y="2" class="t b" font-size="18" fill="#fff" text-anchor="middle">+</text>')
        x += w + gap
    A.body.append(f"""<g id="{name}"><g transform="translate({cx} {cy})">
  <rect x="-134" y="-44" width="268" height="108" rx="18" fill="#0b0d12" opacity=".6"/>
  {''.join(parts)}
  <text y="47" class="t" font-size="11" fill="#c9ceda" text-anchor="middle">{label}</text></g></g>""")
    A.css.append(f"#{name}{{transform-origin:{cx}px {cy}px}}")
    fr, pr = [], []
    for a, b in wins:
        fr += [(a, "opacity:0;transform:scale(.7)"), (a + .25, "opacity:1;transform:scale(1.04)"), (a + .38, "opacity:1;transform:scale(1)"),
               (b - .25, "opacity:1;transform:scale(1)"), (b, "opacity:0;transform:scale(1.15)")]
        p = a + .5
        pr += [(p, "transform:translateY(0)"), (p + .08, "transform:translateY(4px)"), (p + .25, "transform:translateY(0)")]
    A.kf(name, fr, f"#{name}")
    A.kf(name + "p", pr, f"#{name} .cap")


def key_badge(A, name, label, x, y, t):
    """A single key, pressed at time t."""
    w = max(30, text_w(label, 14) + 20)
    A.body.append(f'<g id="{name}"><rect x="{x - w / 2}" y="{y - 18}" width="{w}" height="36" rx="8" fill="#f4f5f8"/>'
                  f'<rect x="{x - w / 2}" y="{y - 18}" width="{w}" height="32" rx="8" fill="#fff"/>'
                  f'<text x="{x}" y="{y + 3}" class="t b" font-size="14" fill="#1f2328" text-anchor="middle">{label}</text></g>')
    A.css.append(f"#{name}{{transform-origin:{x}px {y}px}}")
    A.kf(name, [(t - .2, "opacity:0;transform:scale(.6)"), (t, "opacity:1;transform:scale(1.08)"), (t + .12, "opacity:1;transform:scale(.94)"),
                (t + .55, "opacity:1;transform:scale(1)"), (t + .75, "opacity:0;transform:scale(1.1)")], f"#{name}")


TB_SCALE = .72


def toolbar(A, wins, states, y=8):
    """Capture &amp; record…'s toolbar, drawn at TB_SCALE. wins: when it is on screen. states: [(picked mode,
    chooser_toolbar options, [(start, end)])], one drawing each, shown in its windows. Returns, for each
    state, every mode's and ratio's (x, width) on the canvas."""
    cx, out, placed = W / 2, [], []
    for i, (picked, options, _) in enumerate(states):
        svg, _, width, places = chooser_toolbar(cx, y, picked, **options)
        assert width * TB_SCALE < W - 10, width
        out.append(f'<g id="tb{i}"><g transform="translate({cx} {y}) scale({TB_SCALE}) translate({-cx} {-y})">{svg}</g></g>')
        placed.append({k: (cx + (x - cx) * TB_SCALE, w * TB_SCALE) for k, (x, w) in places.items()})
    A.body.append(f'<g id="aio">{"".join(out)}</g>')
    fr = []
    for a, b in wins:
        fr += [(a, "opacity:0;transform:translateY(-50px)"), (a + .3, "opacity:1;transform:translateY(0)"),
               (b - .2, "opacity:1;transform:translateY(0)"), (b, "opacity:0;transform:translateY(0)")]
    A.kf("aio", fr, "#aio", "cubic-bezier(.2,.9,.3,1.1)")
    for i, (_, _, ws) in enumerate(states):
        A.show(f"#tb{i}", f"tb{i}", ws, fade=.08)
    return placed


def card(x, y, w, h, inner, id_):
    return (f'<g id="{id_}"><rect x="{x}" y="{y + 4}" width="{w}" height="{h}" rx="13" fill="#000" opacity=".35" filter="url(#shadow)"/>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="13" fill="#1b1e25" stroke="#2c313b"/>{inner}</g>')


def slide_in(A, id_, a, b, dx=-300):
    A.kf(id_, [(a, f"opacity:0;transform:translateX({dx}px)"), (a + .05, f"opacity:1;transform:translateX({dx}px)"),
               (a + .45, "opacity:1;transform:translateX(0)"), (b - .25, "opacity:1;transform:translateX(0)"),
               (b, "opacity:0;transform:translateX(0)")], f"#{id_}", "cubic-bezier(.2,.9,.3,1.15)")


def check_icon(x, y, col="#30a46c"):
    return (f'<circle cx="{x}" cy="{y}" r="8.5" fill="{col}"/>'
            f'<path d="M{x - 4} {y}l2.8 2.8 4.8-5.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')


def reset_cover(A, a, fill="#0d1016"):
    """A cover that hides the jump from the loop's end back to its start."""
    A.body.append(f'<rect id="reset" width="{W}" height="{H}" fill="{fill}"/>')
    A.kf("reset", [(.0, "opacity:1"), (.3, "opacity:0"), (a, "opacity:0"), (A.T, "opacity:1")], "#reset")


def qr(x, y, size, seed=5):
    """A QR-looking code: three finder squares around random modules."""
    random.seed(seed)
    n = 25
    c = size / n
    cells = []
    finder = lambda i, j: any(0 <= i - a < 7 and 0 <= j - b < 7 for a, b in ((0, 0), (0, n - 7), (n - 7, 0)))
    for i in range(n):
        for j in range(n):
            if not finder(i, j) and random.random() < .48:
                cells.append(f'<rect x="{x + j * c:.1f}" y="{y + i * c:.1f}" width="{c + .3:.1f}" height="{c + .3:.1f}"/>')
    for a, b in ((0, 0), (0, n - 7), (n - 7, 0)):
        fx, fy = x + b * c, y + a * c
        cells.append(f'<rect x="{fx + c / 2:.1f}" y="{fy + c / 2:.1f}" width="{6 * c:.1f}" height="{6 * c:.1f}" fill="none" stroke="#111" stroke-width="{c:.1f}"/>'
                     f'<rect x="{fx + 2 * c:.1f}" y="{fy + 2 * c:.1f}" width="{3 * c:.1f}" height="{3 * c:.1f}"/>')
    return f'<rect x="{x - 6}" y="{y - 6}" width="{size + 12}" height="{size + 12}" rx="4" fill="#fff"/><g fill="#111">{"".join(cells)}</g>'


# ============================================================ 1. capture ======
def tour_capture():
    A = Anim(17.0)
    # A beta invite with a QR code, beside the dashboard.
    QX, QY, QS = 548, 238, 92
    invite = f"""<g>
  <rect x="520" y="196" width="168" height="214" rx="10" fill="#000" opacity=".35" filter="url(#shadow)"/>
  <rect x="520" y="192" width="168" height="214" rx="10" fill="#f7f7fa"/>
  <path d="M530 192h148a10 10 0 0 1 10 10v12H520v-12a10 10 0 0 1 10-10z" fill="#e6e8ee"/>
  <circle cx="533" cy="203" r="4" fill="#ff5f57"/><circle cx="546" cy="203" r="4" fill="#febc2e"/><circle cx="559" cy="203" r="4" fill="#28c840"/>
  <text x="604" y="232" class="t b" font-size="12.5" fill="#1f2328" text-anchor="middle">Join the beta</text>
  {qr(QX + 8, QY + 6, QS - 16)}
  <text x="604" y="356" class="t" font-size="10.5" fill="#6b7280" text-anchor="middle">Scan with your phone</text>
  <rect x="556" y="368" width="96" height="24" rx="7" fill="#1f2328"/>
  <text x="604" y="384" class="t b" font-size="11" fill="#fff" text-anchor="middle">Request access</text>
</g>"""
    desktop(A, invite)

    keycaps(A, "keys", [(.2, 1.45), (6.55, 7.6), (10.85, 11.9)])
    A.body.append(f'<rect id="dim" width="{W}" height="{H}" fill="#05070c"/>')
    A.show("#dim", "dim", [(1.3, 4.65), (7.45, 9.65), (11.75, 14.1)], fade=.15, on="opacity:.5")

    # Region: drag around a card, then lock 4:3 around the centre.
    SX, SY, SW, SH = 142, 104, 292, 244
    RH = SW * 3 / 4
    dy = (SH - RH) / 2
    A.body.append(f"""<g id="sel"><rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="#fff" fill-opacity=".14"
  stroke="#0090ff" stroke-width="2" vector-effect="non-scaling-stroke"/></g>""")
    A.css.append(f"#sel{{transform-origin:{SX}px {SY}px}}")
    A.kf("sel", [(2.0, "opacity:0;transform:scale(0)"), (2.02, "opacity:1;transform:scale(0)"),
                 (2.9, "opacity:1;transform:scale(1)"), (3.55, "opacity:1;transform:translate(0,0) scale(1,1)"),
                 (3.8, f"opacity:1;transform:translate(0,{dy:.1f}px) scale(1,{RH / SH:.4f})"),
                 (4.5, f"opacity:1;transform:translate(0,{dy:.1f}px) scale(1,{RH / SH:.4f})"),
                 (4.65, f"opacity:0;transform:translate(0,{dy:.1f}px) scale(1,{RH / SH:.4f})")], "#sel", "ease-in-out")

    def handles(id_, y0, h):
        pts = [(hx, hy) for hx in (SX, SX + SW / 2, SX + SW) for hy in (y0, y0 + h / 2, y0 + h) if (hx, hy) != (SX + SW / 2, y0 + h / 2)]
        return f'<g id="{id_}">' + "".join(f'<rect x="{hx - 3.5}" y="{hy - 3.5}" width="7" height="7" rx="1.5" fill="#fff" stroke="#0090ff" stroke-width="1.4"/>' for hx, hy in pts) + "</g>"

    A.body.append(handles("hd0", SY, SH) + handles("hd1", SY + dy, RH))
    A.show("#hd0", "hd0", [(2.95, 3.55)], fade=.1)
    A.show("#hd1", "hd1", [(3.8, 4.65)], fade=.1)

    # The size and ratios are in the toolbar's middle section while the region is held; 4:3 is clicked there.
    key_badge(A, "enter", "Enter", SX + SW / 2, SY + SH / 2, 4.3)

    # Copy text, here the link inside a QR code.
    TX, TY, TW, TH = QX - 6, QY - 6, QS + 12, QS + 12
    A.body.append(f"""<g id="sel2"><rect x="{TX}" y="{TY}" width="{TW}" height="{TH}" fill="#fff" fill-opacity=".12" stroke="#0090ff" stroke-width="2"/></g>
<g clip-path="url(#scanclip)"><rect id="scanbar" x="{TX - 50}" y="{TY}" width="50" height="{TH}" fill="url(#scangrad)"/></g>""")
    A.css.append(f"#sel2{{transform-origin:{TX}px {TY}px}}")
    A.kf("sel2", [(8.25, "opacity:0;transform:scale(0)"), (8.27, "opacity:1;transform:scale(0)"),
                  (8.85, "opacity:1;transform:scale(1)"), (9.5, "opacity:1;transform:scale(1)"), (9.65, "opacity:0;transform:scale(1)")],
         "#sel2", "ease-in-out")
    A.kf("scanbar", [(8.9, "transform:translateX(0)"), (9.35, f"transform:translateX({TW + 50}px)")], "#scanbar", "ease-in-out")

    # Colour: a loupe over the tallest bar.
    BAR = D(492 + 11, 250)
    loupe = ['<circle r="40" fill="#fff"/>', '<g clip-path="url(#loupeclip)">',
             '<rect x="-40" y="-40" width="80" height="80" fill="#ffffff"/>',
             '<rect x="-40" y="-14" width="80" height="54" fill="#4c8dff"/>',
             '<rect x="-40" y="-14" width="10" height="54" fill="#c9d6f2"/>']
    grid = "".join(f"M-40 {v}h80M{v} -40v80" for v in range(-40, 41, 8))
    loupe += [f'<path d="{grid}" stroke="#000" stroke-opacity=".1" stroke-width="1"/>', '</g>',
              '<rect x="-4" y="-4" width="8" height="8" fill="none" stroke="#111" stroke-width="1.6"/>',
              '<circle r="39" fill="none" stroke="#0090ff" stroke-width="2.5"/>',
              '<rect x="-36" y="46" width="72" height="20" rx="6" fill="#16181d"/>',
              f'<text y="60" {MONO} font-size="11" fill="#f3f4f7" text-anchor="middle">#4C8DFF</text>']
    A.body.append(f'<g id="loupe">{"".join(loupe)}</g>')
    A.kf("loupe", [(12.25, f"opacity:0;{tr(BAR[0] - 120, BAR[1] - 60)}"), (12.35, f"opacity:1;{tr(BAR[0] - 120, BAR[1] - 60)}"),
                   (13.1, f"opacity:1;{tr(*BAR)}"), (13.7, f"opacity:1;{tr(*BAR)}"), (13.85, f"opacity:0;{tr(*BAR)}")],
         "#loupe", "cubic-bezier(.45,0,.3,1)")

    placed = toolbar(A, [(1.35, 4.65), (7.45, 9.65), (11.75, 14.1)],
                     [("Region", {"main": "Capture"}, [(0, 2.95), (4.65, 8.0)]),
                      ("Region", {"main": "Capture", "ready": True, "size": (1016, 848)}, [(2.95, 3.6)]),
                      ("Region", {"main": "Capture", "ready": True, "size": (1016, 762), "ratio": "4:3"}, [(3.6, 4.65)]),
                      ("Text", {"main": "Copy text", "timer": None}, [(8.0, 8.85)]),
                      ("Text", {"main": "Copy text", "ready": True, "timer": None}, [(8.85, 12.15)]),
                      ("Colour", {"main": "Copy colour", "ready": True, "timer": None, "colour": "#4C8DFF"}, [(12.15, A.T)])])
    rx, rw = placed[1]["4:3"]
    R43 = (rx + rw / 2, 8 + 20 * TB_SCALE)
    A.click(*R43, 3.55)
    for lab, t, m in (("4", 7.95, "Text"), ("5", 12.1, "Colour")):
        hx, hw = placed[0][m]
        key_badge(A, f"k{lab}", lab, hx + hw / 2, 92, t)

    A.body.append(f'<rect id="flash" width="{W}" height="{H}" fill="#fff"/>')
    A.kf("flash", [(4.6, "opacity:0"), (4.65, "opacity:.9"), (4.9, "opacity:0")], "#flash")

    # Quick Access card for the screenshot.
    qx, qy, qs = 16, 300, .3
    qa = card(qx, qy, 200, 112, f"""
  <g clip-path="url(#qaclip)"><g transform="translate({qx + 12} {qy + 10}) scale({qs})"><g transform="translate({-SX} {-SY - dy:.1f})">
    <rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="#2b3a67"/>{DASH_ON_DESK}</g></g></g>
  <rect x="{qx + 12}" y="{qy + 10}" width="{SW * qs}" height="{RH * qs}" rx="5" fill="none" stroke="#3a404c"/>
  <text x="{qx + 128}" y="{qy + 28}" class="t b" font-size="11.5" fill="#f3f4f7">Copied</text>
  <text x="{qx + 128}" y="{qy + 44}" class="t" font-size="10" fill="#8b93a1">1016 × 762</text>
  <g class="t b" font-size="10.5" text-anchor="middle">
    <rect x="{qx + 12}" y="{qy + 78}" width="50" height="24" rx="6" fill="#2a2f39"/><text x="{qx + 37}" y="{qy + 94}" fill="#e6e8ee">Copy</text>
    <rect x="{qx + 67}" y="{qy + 78}" width="70" height="24" rx="6" fill="#0090ff"/><text x="{qx + 102}" y="{qy + 94}" fill="#fff">Annotate</text>
    <rect x="{qx + 142}" y="{qy + 78}" width="46" height="24" rx="6" fill="#2a2f39"/><text x="{qx + 165}" y="{qy + 94}" fill="#e6e8ee">Pin</text>
  </g>""", "qa")
    A.body.append(qa)
    slide_in(A, "qa", 4.8, 6.6)

    # Codes: the link in the QR code.
    tc = card(16, 316, 300, 96, f"""
  {check_icon(36, 338)}
  <text x="52" y="342" class="t b" font-size="12" fill="#f3f4f7">QR code copied</text>
  <rect x="28" y="352" width="276" height="24" rx="6" fill="#14161b"/>
  <text x="38" y="368" {MONO} font-size="11" fill="#9cc0ff">https://acme.co/beta/7F3K-Q2</text>
  <g class="t b" font-size="10.5" text-anchor="middle">
    <rect x="28" y="382" width="78" height="22" rx="6" fill="#0090ff"/><text x="67" y="397" fill="#fff">Open link</text>
    <rect x="112" y="382" width="74" height="22" rx="6" fill="#2a2f39"/><text x="149" y="397" fill="#e6e8ee">Copy text</text>
  </g>""", "tcard")
    A.body.append(tc)
    slide_in(A, "tcard", 9.65, 11.0)

    cc = card(16, 330, 236, 82, f"""
  {check_icon(36, 352)}
  <text x="52" y="356" class="t b" font-size="12" fill="#f3f4f7">Colour copied</text>
  <rect x="28" y="368" width="34" height="34" rx="8" fill="#4c8dff" stroke="#fff" stroke-opacity=".25"/>
  <text x="72" y="382" {MONO} font-size="12" fill="#f3f4f7">#4C8DFF</text>
  <text x="72" y="398" {MONO} font-size="10.5" fill="#8b93a1">rgb(76, 141, 255)</text>""", "ccard")
    A.body.append(cc)
    slide_in(A, "ccard", 14.05, 16.4)

    # Pointer and crosshairs.
    A.body.append(f'<g id="xh">{CROSS}</g>')
    A.kf("xh", [(1.8, f"opacity:0;{tr(SX - 40, SY - 30)}"), (1.85, f"opacity:1;{tr(SX - 40, SY - 30)}"), (2.0, f"opacity:1;{tr(SX, SY)}"),
                (2.9, f"opacity:1;{tr(SX + SW, SY + SH)}"), (3.0, f"opacity:0;{tr(SX + SW, SY + SH)}"),
                (8.05, f"opacity:0;{tr(TX - 40, TY - 30)}"), (8.1, f"opacity:1;{tr(TX - 40, TY - 30)}"), (8.27, f"opacity:1;{tr(TX, TY)}"),
                (8.85, f"opacity:1;{tr(TX + TW, TY + TH)}"), (8.95, f"opacity:0;{tr(TX + TW, TY + TH)}")], "#xh", "ease-in-out")
    QA_ANN = (qx + 102, qy + 90)
    cursor(A, [(3.0, (SX + SW, SY + SH), 0), (3.05, (SX + SW, SY + SH), 1), (3.45, R43, 1), (3.95, R43, 1),
               (4.25, (SX + SW - 30, SY + SH - 20), 1), (4.6, (SX + SW - 30, SY + SH - 20), 1), (5.4, QA_ANN, 1), (6.4, QA_ANN, 1),
               (6.6, QA_ANN, 0), (8.95, (TX + TW, TY + TH), 0), (9.0, (TX + TW, TY + TH), 1), (10.0, (67, 393), 1),
               (11.2, (67, 393), 1), (11.4, (67, 393), 0)])
    write("capture", A, "Capture &amp; record…",
          "The Capture &amp; record… toolbar opens over a frozen screen. A region is dragged out, locked to 4:3 in the toolbar and captured to the Quick Access card. "
          "Then Text mode reads the link in a QR code, and Colour mode picks the blue of a chart bar with a magnifying loupe.",
          defs=f'<clipPath id="scanclip"><rect x="{TX}" y="{TY}" width="{TW}" height="{TH}"/></clipPath>'
               f'<clipPath id="loupeclip"><circle r="38"/></clipPath>'
               f'<clipPath id="qaclip"><rect x="{qx + 12}" y="{qy + 10}" width="{SW * qs}" height="{RH * qs}" rx="5"/></clipPath>',
          poster=4.2)



# ============================================================= 2. editor ======
RAIL = ["V", "M", None, "A", "L", "R", "E", "P", None, "T", "N", "H", None, "B", "S", None, "C"]
RAIL_STEP, RAIL_Y0 = 22, 74


def rail_icon(key, cx, cy):
    s = 'fill="none" stroke="#c9ceda" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
    return {
        "V": f'<path {s} d="M{cx-4} {cy-6}l9 4-4 1.5-1.5 4z"/>',
        "M": f'<path {s} d="M{cx} {cy-7}v14M{cx-7} {cy}h14M{cx-2} {cy-5}l2-2 2 2M{cx-2} {cy+5}l2 2 2-2M{cx-5} {cy-2}l-2 2 2 2M{cx+5} {cy-2}l2 2-2 2"/>',
        "A": f'<path {s} d="M{cx-6} {cy+6}L{cx+6} {cy-6}M{cx} {cy-6}h6v6"/>',
        "L": f'<path {s} d="M{cx-6} {cy+6}L{cx+6} {cy-6}"/>',
        "R": f'<rect {s} x="{cx-7}" y="{cy-5}" width="14" height="10" rx="2"/>',
        "E": f'<ellipse {s} cx="{cx}" cy="{cy}" rx="7" ry="5"/>',
        "P": f'<path {s} d="M{cx-7} {cy+3}c3-8 5 4 8-2s4-3 6-4"/>',
        "T": f'<path {s} d="M{cx-5} {cy-6}h10M{cx} {cy-6}v12"/>',
        "N": f'<circle {s} cx="{cx}" cy="{cy}" r="6.5"/><path {s} d="M{cx-1} {cy-2}l1.5-1.5v7"/>',
        "H": f'<path {s} d="M{cx-6} {cy+7}h12M{cx-4} {cy+3}l7-9 3 2-7 9h-3z"/>',
        "B": f'<path {s} d="M{cx} {cy-7}c3 4 5 6 5 9a5 5 0 0 1-10 0c0-3 2-5 5-9z"/>',
        "S": f'<rect {s} x="{cx-7}" y="{cy-6}" width="14" height="12" rx="2"/><rect {s} x="{cx-3}" y="{cy-2}" width="6" height="4" rx="1"/>',
        "C": f'<path {s} d="M{cx-4} {cy-7}v11h11M{cx-7} {cy-4}h11v11"/>',
    }[key]


def tour_editor():
    A = Anim(15.0)
    SX, SY, SW, SH = 252, 138, 560, 254  # the capture, in dashboard coordinates (the README's)
    K = 1.05
    cw, ch = SW * K, SH * K
    CX, CY = 36 + (684 - cw) / 2, 58 + (368 - ch) / 2
    mid = (CX + cw / 2, CY + ch / 2)

    def ed(x, y):
        return CX + (x - SX) * K, CY + (y - SY) * K

    # Rail and top bar, as in the app.
    rail, ys, y = [], {}, RAIL_Y0
    for key in RAIL:
        if key is None:
            rail.append(f'<rect x="9" y="{y - 6}" width="18" height="1" fill="#2c313b"/>')
            y += 8
            continue
        ys[key] = y
        rail.append(rail_icon(key, 18, y))
        y += RAIL_STEP
    colours = ["#e5484d", "#f5a524", "#30a46c", "#4c8dff", "#a56bff", "#1f2328", "#ffffff", "#ff6ac1"]
    dots = "".join(f'<circle cx="{16 + i * 17}" cy="41" r="6" fill="{c}" stroke="#ffffff" stroke-opacity=".18"/>' for i, c in enumerate(colours))
    ic = 'fill="none" stroke="#c9ceda" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
    BACKDROP_BTN = (378, 41)
    COPY = (571, 41)
    A.body.append(f"""
<g id="ed">
  <rect width="{W}" height="{H}" fill="#14161b"/>
  <rect x="36" y="58" width="684" height="368" fill="url(#dots)"/>
  <rect width="{W}" height="24" fill="#1b1e25"/>
  <circle cx="14" cy="12" r="4.5" fill="#ff5f57"/><circle cx="28" cy="12" r="4.5" fill="#febc2e"/><circle cx="42" cy="12" r="4.5" fill="#28c840"/>
  <text x="{W / 2}" y="16" class="t b" font-size="10.5" fill="#9aa3b2" text-anchor="middle">Grab-it 2026-11-15 09-41-07.png – Grab-it Editor</text>
  <rect y="24" width="{W}" height="34" fill="#16181d"/>
  <rect y="57" width="{W}" height="1" fill="#2c313b"/>
  <circle cx="16" cy="41" r="9" fill="none" stroke="#e5484d" stroke-width="1.5"/>
  {dots}
  <rect x="150" y="31" width="1" height="20" fill="#2c313b"/>
  <path {ic} d="M168 37h8a4 4 0 0 1 0 8h-5M168 37l3-3M168 37l3 3"/>
  <path {ic} opacity=".4" d="M196 37h-8a4 4 0 0 0 0 8h5M196 37l-3-3M196 37l-3 3"/>
  <path {ic} opacity=".4" d="M209 36h10M211 36v10h6V36M213 34h2"/>
  <rect x="230" y="31" width="1" height="20" fill="#2c313b"/>
  <path {ic} d="M246 46a6 6 0 1 1 6-6M252 36v4h-4"/>
  <path {ic} d="M268 34v14M264 38l-4 8h4zM272 38l4 8h-4z"/>
  <rect x="288" y="31" width="1" height="20" fill="#2c313b"/>
  <path {ic} d="M300 46l8-8M304 38h4v4M300 41v5h5"/>
  <text x="314" y="45" class="t" font-size="11.5" fill="#e6e8ee">Resize</text>
  <rect id="bdbtnbg" x="352" y="31" width="80" height="20" rx="6" fill="#2a2f39"/>
  <rect {ic} x="360" y="35" width="12" height="11" rx="2.5"/><rect {ic} x="363" y="38" width="6" height="5" rx="1"/>
  <text x="378" y="45" class="t" font-size="11.5" fill="#e6e8ee">Backdrop</text>
  <path {ic} d="M512 35l4 4-6 6M510 39l4 4M508 47l3-3"/>
  <text x="522" y="45" class="t" font-size="11.5" fill="#e6e8ee">Pin</text>
  <rect id="copybg" x="548" y="31" width="50" height="20" rx="6" fill="#2a2f39"/>
  <rect {ic} x="555" y="36" width="8" height="9" rx="1.5"/><path {ic} d="M558 36v-2h7v9h-2"/>
  <text x="569" y="45" class="t" font-size="11.5" fill="#e6e8ee">Copy</text>
  <path {ic} d="M610 36h8M614 36v9M620 42h4M620 45h3"/>
  <text x="628" y="45" class="t" font-size="11.5" fill="#e6e8ee">Copy text</text>
  <rect x="{W - 62}" y="30" width="54" height="22" rx="6" fill="#4c8dff"/>
  <text x="{W - 35}" y="45" class="t b" font-size="11.5" fill="#fff" text-anchor="middle">Export…</text>
  <rect y="58" width="36" height="368" fill="#1b1e25"/>
  <rect x="35" y="58" width="1" height="368" fill="#2c313b"/>
  <rect id="railsel" x="6" y="{ys['V'] - 10}" width="24" height="20" rx="5" fill="#4c8dff"/>
  {''.join(rail)}
  <rect y="426" width="{W}" height="24" fill="#1b1e25"/>
  <rect y="426" width="{W}" height="1" fill="#2c313b"/>
  <text x="12" y="442" class="t" font-size="10.5" fill="#9aa3b2">Grab-it 2026-11-15 09-41-07.png</text>
  <text x="200" y="442" class="t" font-size="10.5" fill="#9aa3b2">1120 × 508</text>
  <text id="sb0" x="{W - 60}" y="442" class="t" font-size="10.5" fill="#9aa3b2" text-anchor="end">Annotations saved</text>
  <text id="sb1" x="{W - 60}" y="442" class="t" font-size="10.5" fill="#9aa3b2" text-anchor="end">Copied to the clipboard.</text>
  <text x="{W - 12}" y="442" class="t" font-size="10.5" fill="#9aa3b2" text-anchor="end">100%</text>
</g>""")

    # When each tool is picked, by its key.
    picks = [("A", .5), ("R", 1.75), ("N", 2.75), ("H", 3.75), ("B", 4.65), ("S", 5.6), ("T", 6.6)]
    fr, prev = [], ys["V"]
    for key, t in picks:
        fr += [(t - .12, f"transform:translateY(0px) translateY({prev - ys['V']}px)"), (t, f"transform:translateY(0px) translateY({ys[key] - ys['V']}px)")]
        prev = ys[key]
    fr += [(7.35, f"transform:translateY(0px) translateY({prev - ys['V']}px)"), (7.5, "transform:translateY(0px) translateY(0px)")]
    A.kf("railsel", fr, "#railsel", "cubic-bezier(.3,1.4,.5,1)")
    for i, (key, t) in enumerate(picks):
        key_badge(A, f"kb{i}", key, 62, ys[key], t)

    # The capture and its annotations, in dashboard coordinates.
    AR0, ARC, AR1 = (468, 168), (548, 196), (566, 312)
    alen = qlen(AR0, ARC, AR1)
    ang = math.atan2(AR1[1] - ARC[1], AR1[0] - ARC[0])
    RX, RY, RW, RH = 270, 188, 182, 40
    rlen = 2 * (RW + RH)
    random.seed(7)
    blur = "".join(f'<rect x="{574 + i * 16}" y="{214 + j * 14}" width="16" height="14" fill="{random.choice(["#d4dae6", "#c3cbdb", "#e3e7ef", "#b8c2d6", "#cdd4e2"])}"/>'
                   for i in range(13) for j in range(2))
    SPOT = (550, 144, 256, 242)
    spot_path = (f"M{SX} {SY}h{SW}v{SH}h{-SW}z"
                 f"M{SPOT[0] + 10} {SPOT[1]}h{SPOT[2] - 20}a10 10 0 0 1 10 10v{SPOT[3] - 20}a10 10 0 0 1-10 10h{-(SPOT[2] - 20)}a10 10 0 0 1-10-10v{-(SPOT[3] - 20)}a10 10 0 0 1 10-10z")
    annots = f"""
<g id="blur">{blur}</g>
<path id="hl" d="M572 173h118" stroke="#f5d90a" stroke-opacity=".5" stroke-width="18" stroke-linecap="round" stroke-dasharray="118" stroke-dashoffset="118"/>
<path id="spot" d="{spot_path}" fill="#05070c" fill-opacity=".5" fill-rule="evenodd"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
  <rect id="a-rect" x="{RX}" y="{RY}" width="{RW}" height="{RH}" rx="8" stroke="{RED}" stroke-width="3" stroke-dasharray="{rlen:.0f}" stroke-dashoffset="{rlen:.0f}"/>
  <path id="a-arrow" d="M{AR0[0]} {AR0[1]}Q{ARC[0]} {ARC[1]} {AR1[0]} {AR1[1]}" stroke="{RED}" stroke-width="4" stroke-dasharray="{alen:.0f}" stroke-dashoffset="{alen:.0f}"/>
  <path id="a-head" d="{head(AR1, ang)}" stroke="{RED}" stroke-width="4"/>
</g>
<g id="s1"><circle cx="{RX}" cy="{RY}" r="12" fill="{RED}" stroke="#fff" stroke-width="2"/><text x="{RX}" y="{RY + 4.5}" class="t b" font-size="13" fill="#fff" text-anchor="middle">1</text></g>
<g id="s2"><circle cx="696" cy="334" r="12" fill="{RED}" stroke="#fff" stroke-width="2"/><text x="696" y="338.5" class="t b" font-size="13" fill="#fff" text-anchor="middle">2</text></g>
<g id="note"><rect x="586" y="250" width="132" height="32" rx="7" fill="#fff3a8"/><text x="652" y="272" class="t b" font-size="15" fill="{RED}" text-anchor="middle">Ship it today!</text></g>"""
    bw, bh = cw + 40, ch + 40
    A.body.append(f"""
<g clip-path="url(#canvas)">
  <g id="bdwrap"><rect id="bdrect" x="{mid[0] - bw / 2:.1f}" y="{mid[1] - bh / 2:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="14" fill="url(#bd)"/></g>
  <g id="capwrap">
    <rect id="capshadow" x="{CX}" y="{CY + 8}" width="{cw:.1f}" height="{ch:.1f}" rx="10" fill="#000" opacity=".5" filter="url(#shadow)"/>
    <g clip-path="url(#capclip)"><g transform="translate({CX:.1f} {CY:.1f}) scale({K}) translate({-SX} {-SY})"><use href="#dash"/>{annots}</g></g>
  </g>
</g>""")

    def draw(sel, name, length, a, b):
        A.kf(name, [(a, f"stroke-dashoffset:{length:.0f}"), (b, "stroke-dashoffset:0")], sel, "ease-in-out")

    def pop(sel, name, at, origin, rot=0):
        A.css.append(f"{sel}{{transform-origin:{origin[0]}px {origin[1]}px}}")
        r = f" rotate({rot}deg)" if rot else ""
        A.kf(name, [(at, f"opacity:0;transform:scale(0){r}"), (at + .18, f"opacity:1;transform:scale(1.25){r}"), (at + .32, f"opacity:1;transform:scale(1){r}")], sel)

    draw("#a-arrow", "arrow", alen, .75, 1.35)
    A.kf("ahead", [(1.3, "opacity:0"), (1.38, "opacity:1")], "#a-head")
    draw("#a-rect", "rect", rlen, 2.0, 2.45)
    pop("#s1", "s1", 2.95, (RX, RY))
    pop("#s2", "s2", 3.3, (696, 334))
    draw("#hl", "hl", 118, 3.95, 4.35)
    A.css.append("#blur{transform-origin:574px 214px}")
    A.kf("blur", [(4.85, "opacity:1;transform:scaleX(0)"), (5.25, "opacity:1;transform:scaleX(1)")], "#blur", "ease-in-out")
    A.kf("spot", [(5.85, "opacity:0"), (6.2, "opacity:1")], "#spot")
    pop("#note", "note", 6.85, (652, 266), rot=-3)

    # Backdrop: open the panel, pick a gradient, add padding.
    PX, PY = 352, 60
    sw_fills = ["url(#bd)", "url(#bd2)", "url(#bd3)", "url(#bd4)", "url(#bd5)", "#f4f5f8", "#1f2328", "#ffd166"]
    sw = "".join(f'<rect x="{PX + 14 + (i % 4) * 34}" y="{PY + 50 + (i // 4) * 34}" width="28" height="28" rx="7" fill="{f}"/>' for i, f in enumerate(sw_fills))
    PAD0, PAD1 = PX + 90, PX + 150
    A.body.append(f"""
<g id="panel">
  <rect x="{PX}" y="{PY + 4}" width="170" height="214" rx="11" fill="#000" opacity=".4" filter="url(#shadow)"/>
  <rect x="{PX}" y="{PY}" width="170" height="214" rx="11" fill="#1b1e25" stroke="#2c313b"/>
  <text x="{PX + 14}" y="{PY + 24}" class="t b" font-size="12" fill="#f3f4f7">Backdrop</text>
  <text x="{PX + 14}" y="{PY + 42}" class="t" font-size="10" fill="#8b93a1">Gradients</text>
  {sw}
  <rect id="swsel" x="{PX + 11}" y="{PY + 47}" width="34" height="34" rx="9" fill="none" stroke="#fff" stroke-width="2"/>
  <text x="{PX + 14}" y="{PY + 136}" class="t" font-size="10.5" fill="#c9ceda">Padding</text>
  <rect x="{PX + 14}" y="{PY + 146}" width="142" height="4" rx="2" fill="#2f3440"/>
  <rect id="padfill" x="{PX + 14}" y="{PY + 146}" width="{PAD1 - PX - 14}" height="4" rx="2" fill="#4c8dff"/>
  <circle id="padknob" cx="{PAD0}" cy="{PY + 148}" r="6.5" fill="#fff"/>
  <text x="{PX + 14}" y="{PY + 172}" class="t" font-size="10.5" fill="#c9ceda">Corner radius</text>
  <rect x="{PX + 14}" y="{PY + 182}" width="142" height="4" rx="2" fill="#2f3440"/><rect x="{PX + 14}" y="{PY + 182}" width="52" height="4" rx="2" fill="#4c8dff"/>
  <circle cx="{PX + 66}" cy="{PY + 184}" r="6.5" fill="#fff"/>
  <text x="{PX + 14}" y="{PY + 204}" class="t" font-size="10.5" fill="#c9ceda">Shadow</text>
  <rect x="{PX + 128}" y="{PY + 194}" width="28" height="15" rx="7.5" fill="#30a46c"/><circle cx="{PX + 148}" cy="{PY + 201.5}" r="5.5" fill="#fff"/>
</g>""")
    A.css.append(f"#panel{{transform-origin:{PX + 26}px {PY}px}}")
    A.kf("panel", [(7.55, "opacity:0;transform:scale(.92)"), (7.75, "opacity:1;transform:scale(1)"), (9.6, "opacity:1;transform:scale(1)"),
                   (9.75, "opacity:0;transform:scale(.96)")], "#panel", "cubic-bezier(.2,.9,.3,1.1)")
    A.show("#bdbtnbg", "bdbtnbg", [(7.5, 9.7)], fade=.1, on="opacity:1;fill:#3a4152", off="opacity:1;fill:#2a2f39")
    A.kf("swsel", [(8.15, "opacity:0"), (8.2, "opacity:1")], "#swsel")
    SWATCH = (PX + 28, PY + 64)
    A.click(*SWATCH, 8.15)
    A.kf("padknob", [(8.85, "transform:translateX(0)"), (9.3, f"transform:translateX({PAD1 - PAD0}px)")], "#padknob", "ease-in-out")
    A.css.append(f"#padfill{{transform-origin:{PX + 14}px 0}}")
    A.kf("padfill", [(8.85, f"transform:scaleX({(PAD0 - PX - 14) / (PAD1 - PX - 14):.3f})"), (9.3, "transform:scaleX(1)")], "#padfill", "ease-in-out")
    A.css.append(f"#capwrap,#bdwrap{{transform-origin:{mid[0]:.1f}px {mid[1]:.1f}px}}")
    A.kf("capwrap", [(8.2, "transform:scale(1)"), (8.6, "transform:scale(.84)"), (8.85, "transform:scale(.84)"), (9.3, "transform:scale(.76)")],
         "#capwrap", "cubic-bezier(.3,1.2,.5,1)")
    A.kf("bdwrap", [(8.2, "opacity:0;transform:scale(.88)"), (8.6, "opacity:1;transform:scale(.96)")], "#bdwrap", "cubic-bezier(.3,1.2,.5,1)")
    A.kf("capshadow", [(8.2, "opacity:0"), (8.6, "opacity:1")], "#capshadow")

    # Copy.
    A.click(*COPY, 10.25)
    A.show("#copybg", "copybg", [(10.2, 10.6)], fade=.1, on="opacity:1;fill:#4c8dff", off="opacity:1;fill:#2a2f39")
    A.show("#sb0", "sb0", [(0, 10.3)], fade=.02)
    A.show("#sb1", "sb1", [(10.3, A.T)], fade=.02)
    A.body.append(f"""<g id="toast"><rect x="{W / 2 - 104 + 18}" y="70" width="208" height="32" rx="16" fill="#1f2328" stroke="#3a404c"/>
  {check_icon(W / 2 - 104 + 38, 86)}<text x="{W / 2 - 104 + 54}" y="90.5" class="t b" font-size="12" fill="#fff">Copied. Paste it anywhere</text></g>""")
    A.kf("toast", [(10.35, "opacity:0;transform:translateY(-20px)"), (10.6, "opacity:1;transform:translateY(0)")], "#toast", "cubic-bezier(.2,1.4,.4,1)")

    cursor(A, [(0, ed(*AR0), 1), (.75, ed(*AR0), 1), (1.35, ed(*AR1), 1),
               (1.9, ed(RX, RY), 1), (2.0, ed(RX, RY), 1), (2.45, ed(RX + RW, RY + RH), 1),
               (2.9, ed(RX, RY), 1), (3.25, ed(696, 334), 1),
               (3.85, ed(572, 173), 1), (3.95, ed(572, 173), 1), (4.35, ed(690, 173), 1),
               (4.8, ed(574, 228), 1), (4.85, ed(574, 228), 1), (5.25, ed(782, 228), 1),
               (5.8, ed(*SPOT[:2]), 1), (5.85, ed(*SPOT[:2]), 1), (6.2, ed(SPOT[0] + SPOT[2], SPOT[1] + SPOT[3]), 1),
               (6.8, ed(652, 266), 1), (7.1, ed(652, 266), 1), (7.5, BACKDROP_BTN, 1), (7.6, BACKDROP_BTN, 1),
               (8.1, SWATCH, 1), (8.2, SWATCH, 1), (8.8, (PAD0, PY + 148), 1), (8.85, (PAD0, PY + 148), 1),
               (9.3, (PAD1, PY + 148), 1), (9.55, (PAD1 + 40, PY + 250), 1), (10.15, COPY, 1), (14.0, COPY, 1)])
    A.click(*BACKDROP_BTN, 7.5)
    reset_cover(A, 14.4, fill="#14161b")
    write("editor", A, "The image editor",
          "Tools are picked by their keys: an arrow is drawn, a box and numbered steps mark the numbers, a highlighter, a blur over an email "
          "and a spotlight on the release card, then a note. The Backdrop panel puts the screenshot on a gradient with more padding, and Copy copies it.",
          defs=f'<clipPath id="canvas"><rect x="36" y="58" width="684" height="368"/></clipPath>'
               f'<clipPath id="capclip"><rect x="{CX:.1f}" y="{CY:.1f}" width="{cw:.1f}" height="{ch:.1f}" rx="8"/></clipPath>',
          poster=7.3)


# ============================================================== 3. video =======
def tour_video():
    A = Anim(19.0)
    desktop(A)
    keycaps(A, "keys", [(.2, 1.25)])
    A.body.append(f'<rect id="dim" width="{W}" height="{H}" fill="#05070c"/>')
    A.show("#dim", "dim", [(1.1, 3.25)], fade=.15, on="opacity:.5")
    wx, wy, ww, wh = DESK_BOX
    A.body.append(f'<rect id="winhl" x="{wx}" y="{wy}" width="{ww}" height="{wh}" rx="11" fill="#4c8dff" fill-opacity=".14" stroke="#4c8dff" stroke-width="2.5"/>')
    A.show("#winhl", "winhl", [(2.35, 3.25)], fade=.12)

    # Record stays in the Capture &amp; record… toolbar: Region, Window and Screen pick what to record,
    # its options fill the middle, the countdown takes the Timer's place and the main button is a red Record.
    ic = 'fill="none" stroke="#e6e8ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
    rec = {"timer": "3 s", "timer_on": True, "main": "Record"}
    on = {"clicks", "keys"}
    placed = toolbar(A, [(1.1, 3.25)], [("Region", {"main": "Capture"}, [(0, 1.45)]),
                                        ("Record", {**rec, "record": {"source": "Region", "on": on}}, [(1.45, 1.9)]),
                                        ("Record", {**rec, "record": {"source": "Window", "on": on}}, [(1.9, 2.55)]),
                                        ("Record", {**rec, "ready": True, "record": {"source": "Window", "on": on}},
                                         [(2.55, A.T)])])
    hx, hw_ = placed[0]["Record"]
    key_badge(A, "k6", "6", hx + hw_ / 2, 104, 1.4)
    wbx, wbw = placed[1]["Window"]
    WINDOW_BTN = (wbx + wbw / 2, 8 + 20 * TB_SCALE)
    mx, mw = placed[3]["main"]
    REC = (mx + mw / 2, 8 + 20 * TB_SCALE)

    # Countdown, then the recording.
    cx, cy = wx + ww / 2, wy + wh / 2
    for i, n in enumerate("321"):
        t = 3.35 + i * .5
        A.body.append(f'<g id="cd{i}"><circle cx="{cx}" cy="{cy}" r="46" fill="#0b0d12" opacity=".7"/>'
                      f'<text x="{cx}" y="{cy + 17}" class="t b" font-size="48" fill="#fff" text-anchor="middle">{n}</text></g>')
        A.css.append(f"#cd{i}{{transform-origin:{cx}px {cy}px}}")
        A.kf(f"cd{i}", [(t, "opacity:0;transform:scale(.6)"), (t + .1, "opacity:1;transform:scale(1)"), (t + .42, "opacity:1;transform:scale(1)"),
                        (t + .5, "opacity:0;transform:scale(1.2)")], f"#cd{i}")
    REC_A, REC_B = 4.85, 8.0
    A.body.append(f"""<g id="recframe" fill="none" stroke="{RED}">
  <rect x="{wx - 5}" y="{wy - 5}" width="{ww + 10}" height="{wh + 10}" rx="14" stroke-width="1.5" stroke-dasharray="6 4"/></g>""")
    A.show("#recframe", "recframe", [(REC_A - .2, REC_B)], fade=.15)
    # The webcam bubble: on the screen, so it's in the recording too (dashboard coordinates).
    CAM = (760, 400)
    cam = (f'<circle cx="{CAM[0]}" cy="{CAM[1]}" r="40" fill="#3a4152" stroke="#fff" stroke-width="4"/>'
           f'<clipPath id="camclip"><circle cx="{CAM[0]}" cy="{CAM[1]}" r="38"/></clipPath>'
           f'<g clip-path="url(#camclip)"><rect x="{CAM[0] - 40}" y="{CAM[1] - 40}" width="80" height="80" fill="#5b6b8c"/>'
           f'<ellipse cx="{CAM[0]}" cy="{CAM[1] + 40}" rx="30" ry="22" fill="#2f3a52"/>'
           f'<circle cx="{CAM[0]}" cy="{CAM[1] - 4}" r="15" fill="url(#face)"/>'
           f'<path d="M{CAM[0] - 16} {CAM[1] - 8}q2-16 16-16t16 14q-6-6-16-6t-16 8z" fill="#3b2a20"/></g>')
    A.body.append(f'<g id="cam"><g transform="translate({DX0} {DY0}) scale({DK}) translate(-140 -58)">{cam}</g></g>')
    A.show("#cam", "cam", [(REC_A, REC_B)], fade=.2)
    KEYS = D(482, 360)
    A.body.append(f'<g id="keys2"><rect x="{KEYS[0] - 30}" y="{KEYS[1] - 16}" width="60" height="28" rx="8" fill="#0b0d12" opacity=".78"/>'
                  f'<text x="{KEYS[0]}" y="{KEYS[1] + 3}" class="t b" font-size="14" fill="#fff" text-anchor="middle">⌘ S</text></g>')
    A.show("#keys2", "keys2", [(6.3, 7.1)], fade=.15)

    RB_W = 250
    rbx, rby = W / 2 - RB_W / 2, 416
    times = "".join(f'<text id="rt{i}" x="{rbx + 44}" y="{rby + 20}" {MONO} font-size="13" font-weight="700" fill="#f3f4f7">0:0{i}</text>' for i in range(4))
    STOP = (rbx + RB_W - 38, rby + 15)
    A.body.append(f"""<g id="recbar">
  <rect x="{rbx}" y="{rby}" width="{RB_W}" height="30" rx="15" fill="#111317" stroke="#2c313b"/>
  <circle id="recdot" cx="{rbx + 28}" cy="{rby + 15}" r="5.5" fill="#ff4b4b"/>
  <g fill="#5c6370"><circle cx="{rbx + 12}" cy="{rby + 11}" r="1.2"/><circle cx="{rbx + 12}" cy="{rby + 15}" r="1.2"/><circle cx="{rbx + 12}" cy="{rby + 19}" r="1.2"/>
  <circle cx="{rbx + 16}" cy="{rby + 11}" r="1.2"/><circle cx="{rbx + 16}" cy="{rby + 15}" r="1.2"/><circle cx="{rbx + 16}" cy="{rby + 19}" r="1.2"/></g>
  {times}
  <rect x="{rbx + 84}" y="{rby + 8}" width="1" height="14" fill="#3a404c"/>
  <g fill="#e6e8ee"><rect x="{rbx + 96}" y="{rby + 10}" width="3" height="10" rx="1"/><rect x="{rbx + 101}" y="{rby + 10}" width="3" height="10" rx="1"/></g>
  <text x="{rbx + 110}" y="{rby + 19.5}" class="t" font-size="11.5" fill="#e6e8ee">Pause</text>
  <text x="{rbx + 156}" y="{rby + 19.5}" class="t b" font-size="12" fill="#9aa3b2">···</text>
  <rect x="{rbx + RB_W - 70}" y="{rby + 3}" width="64" height="24" rx="12" fill="#ff4b4b"/>
  <rect x="{rbx + RB_W - 60}" y="{rby + 11}" width="8" height="8" rx="1.5" fill="#fff"/>
  <text x="{rbx + RB_W - 47}" y="{rby + 19.5}" class="t b" font-size="11.5" fill="#fff">Stop</text>
</g>""")
    A.kf("recbar", [(REC_A - .2, "opacity:0;transform:translateY(30px)"), (REC_A + .1, "opacity:1;transform:translateY(0)"),
                    (REC_B - .2, "opacity:1;transform:translateY(0)"), (REC_B, "opacity:0;transform:translateY(0)")], "#recbar", "ease-out")
    for i in range(4):
        A.show(f"#rt{i}", f"rt{i}", [(REC_A + i if i else 0, REC_A + i + 1 if i < 3 else A.T)], fade=.02)
    BAR, SHIP = D(503, 250), D(627, 334)
    A.click(*BAR, 5.65, "#f5a524")
    A.click(*SHIP, 7.05, "#f5a524")
    A.click(*STOP, 7.75)

    # Quick Access card for the recording.
    qx, qy = 16, 300
    qs = 176 / 684
    A.body.append(card(qx, qy, 230, 114, f"""
  <g clip-path="url(#qaclip)"><g transform="translate({qx + 12} {qy + 12}) scale({qs:.4f}) translate(-140 -58)"><use href="#dash"/>{cam}</g>
  <rect x="{qx + 12}" y="{qy + 12}" width="96" height="57" fill="#000" opacity=".3"/></g>
  <circle cx="{qx + 60}" cy="{qy + 40}" r="13" fill="#fff" opacity=".92"/><path d="M{qx + 56} {qy + 34}v12l10-6z" fill="#1f2328"/>
  <text x="{qx + 118}" y="{qy + 28}" class="t b" font-size="11.5" fill="#f3f4f7">Recording</text>
  <text x="{qx + 118}" y="{qy + 44}" class="t" font-size="10" fill="#8b93a1">0:04 · 3.1 MB · MP4</text>
  <g class="t b" font-size="10.5" text-anchor="middle">
    <rect x="{qx + 12}" y="{qy + 80}" width="52" height="24" rx="6" fill="#0090ff"/><text x="{qx + 38}" y="{qy + 96}" fill="#fff">Edit</text>
    <rect x="{qx + 70}" y="{qy + 80}" width="98" height="24" rx="6" fill="#2a2f39"/><text x="{qx + 119}" y="{qy + 96}" fill="#e6e8ee">Show in folder</text>
  </g>""", "qa"))
    slide_in(A, "qa", 8.05, 9.4)
    EDIT = (qx + 38, qy + 92)
    A.click(*EDIT, 8.95)

    # ---- the video editor
    VE_IN = 9.15
    VX, VY, VW = 170, 86, 380
    KV = VW / 684
    VH = 404 * KV
    TL0, TL1, TLY = 150, 700, 352
    TRIM = 192
    def pv(x, y):
        return VX + (x - 140) * KV, VY + (y - 58) * KV
    tl_x = lambda sec: TL0 + sec / 4.0 * (TL1 - TL0)
    SEEK, ZS0 = 196, 330
    ZS1 = ZS0 + 1.6 / 4.0 * (TL1 - TL0)
    PB0, PB1 = 11.75, 14.75
    def at_x(x):
        return PB0 + (x - SEEK) / (TL1 - SEEK) * (PB1 - PB0)
    z0, z1 = at_x(ZS0), at_x(ZS1)
    vpath = [(PB0, (430, 300)), (z0 + .15, (503, 250)), (z0 + .55, (503, 250)), (z1 - .3, (627, 334)), (PB1, (627, 334))]
    vcur = "".join([])
    zoom_origin = [(t, f"transform-origin:{pv(*p)[0]:.1f}px {pv(*p)[1]:.1f}px") for t, p in vpath]
    times = [("0:00.3", 0, PB0 + .4), ("0:00.9", PB0 + .4, PB0 + 1.0), ("0:01.7", PB0 + 1.0, PB0 + 1.6),
             ("0:02.5", PB0 + 1.6, PB0 + 2.2), ("0:03.3", PB0 + 2.2, PB1), ("0:04.0", PB1, A.T)]
    time_txt = "".join(f'<text id="vt{i}" x="42" y="{TLY + 14}" {MONO} font-size="10.5" fill="#c9ceda">{t}<tspan fill="#6b7280"> / 0:04.0</tspan></text>'
                       for i, (t, _, _) in enumerate(times))
    ZOOM_BTN, FOLLOW, EXPORT, PLAY = (106, 40), (300, 40), (W - 40, 40), (24, TLY + 10)
    A.body.append(f"""
<g id="ve">
  <rect width="{W}" height="{H}" fill="#0f1115"/>
  <rect width="{W}" height="24" fill="#1b1e25"/>
  <circle cx="14" cy="12" r="4.5" fill="#ff5f57"/><circle cx="28" cy="12" r="4.5" fill="#febc2e"/><circle cx="42" cy="12" r="4.5" fill="#28c840"/>
  <text x="{W / 2}" y="16" class="t b" font-size="10.5" fill="#9aa3b2" text-anchor="middle">Grab-it 2026-11-15 09-41-12.mp4 – Grab-it Recording Editor</text>
  <rect y="24" width="{W}" height="32" fill="#16181d"/><rect y="55" width="{W}" height="1" fill="#2c313b"/>
  <rect {ic} x="14" y="34" width="12" height="11" rx="2.5"/><rect {ic} x="17" y="37" width="6" height="5" rx="1"/>
  <text x="32" y="44" class="t" font-size="11.5" fill="#e6e8ee">Backdrop</text><circle cx="86" cy="40" r="2.5" fill="#4c8dff"/>
  <rect x="94" y="30" width="1" height="20" fill="#2c313b"/>
  <g {ic}><circle cx="110" cy="39" r="4.5"/><path d="M113.5 42.5l3.5 3.5M108 39h4M110 37v4"/></g>
  <text x="122" y="44" class="t" font-size="11.5" fill="#e6e8ee">Zoom</text>
  <g id="zctl">
    <rect x="160" y="30" width="1" height="20" fill="#2c313b"/>
    <rect x="172" y="30" width="186" height="20" rx="6" fill="#23262d"/>
    <rect id="zarea" x="174" y="32" width="50" height="16" rx="5" fill="#6e56cf"/>
    <rect id="zfollow" x="226" y="32" width="130" height="16" rx="5" fill="#6e56cf"/>
    <text x="199" y="44" class="t" font-size="10.5" fill="#e6e8ee" text-anchor="middle">Area</text>
    <text x="291" y="44" class="t" font-size="10.5" fill="#e6e8ee" text-anchor="middle">Follow cursor</text>
    <text x="370" y="44" class="t" font-size="10.5" fill="#9aa3b2">Scale</text>
    <rect x="404" y="38" width="70" height="4" rx="2" fill="#2f3440"/><rect x="404" y="38" width="24" height="4" rx="2" fill="#6e56cf"/>
    <circle cx="428" cy="40" r="5.5" fill="#fff"/><text x="482" y="44" class="t b" font-size="10.5" fill="#e6e8ee">2×</text>
  </g>
  <rect x="{W - 72}" y="29" width="62" height="22" rx="6" fill="#4c8dff"/>
  <text x="{W - 41}" y="44" class="t b" font-size="11.5" fill="#fff" text-anchor="middle">Export</text>
  <rect x="{VX - 24}" y="{VY - 24}" width="{VW + 48}" height="{VH + 48:.1f}" rx="3" fill="url(#bd2)"/>
  <rect x="{VX}" y="{VY + 6}" width="{VW}" height="{VH:.1f}" rx="8" fill="#000" opacity=".45" filter="url(#shadow)"/>
  <g clip-path="url(#vclip)"><g id="vzoom"><g transform="translate({VX} {VY}) scale({KV:.4f}) translate(-140 -58)">
    <use href="#dash"/>{cam}
    <g id="vkeys"><rect x="452" y="344" width="60" height="28" rx="8" fill="#0b0d12" opacity=".78"/><text x="482" y="363" class="t b" font-size="14" fill="#fff" text-anchor="middle">⌘ S</text></g>
    <circle id="vr0" cx="503" cy="250" r="22" fill="none" stroke="#f5a524" stroke-width="4"/>
    <circle id="vr1" cx="627" cy="334" r="22" fill="none" stroke="#f5a524" stroke-width="4"/>
    <g id="vcur">{CURSOR}</g>
  </g></g></g>
  <rect y="340" width="{W}" height="86" fill="#14161b"/><rect y="340" width="{W}" height="1" fill="#2c313b"/>
  <circle cx="{PLAY[0]}" cy="{PLAY[1]}" r="11" fill="#23262d"/>
  <path id="playico" d="M{PLAY[0] - 3.5} {PLAY[1] - 5}v10l8.5-5z" fill="#e6e8ee"/>
  <g id="pauseico" fill="#e6e8ee"><rect x="{PLAY[0] - 4.5}" y="{PLAY[1] - 5}" width="3" height="10" rx="1"/><rect x="{PLAY[0] + 1.5}" y="{PLAY[1] - 5}" width="3" height="10" rx="1"/></g>
  {time_txt}
  <rect x="{TL0}" y="{TLY}" width="{TL1 - TL0}" height="20" rx="5" fill="#262c3b" stroke="#4c8dff" stroke-width="1.4"/>
  <g fill="#3a4560">{''.join(f'<rect x="{x}" y="{TLY + 7}" width="2" height="6" rx="1"/>' for x in range(TL0 + 24, TL1 - 8, 30))}</g>
  <rect id="trimdim" x="{TL0}" y="{TLY}" width="{TRIM - TL0}" height="20" rx="5" fill="#05070c" opacity=".7"/>
  <g id="lh"><rect x="{TL0}" y="{TLY - 2}" width="8" height="24" rx="3" fill="#4c8dff"/><rect x="{TL0 + 3}" y="{TLY + 6}" width="2" height="8" rx="1" fill="#fff"/></g>
  <rect x="{TL1 - 8}" y="{TLY - 2}" width="8" height="24" rx="3" fill="#4c8dff"/><rect x="{TL1 - 5}" y="{TLY + 6}" width="2" height="8" rx="1" fill="#fff"/>
  <g id="zseg"><rect x="{ZS0}" y="{TLY + 28}" width="{ZS1 - ZS0:.1f}" height="18" rx="5" fill="#6e56cf"/>
    <text id="zl0" x="{(ZS0 + ZS1) / 2:.1f}" y="{TLY + 41}" class="t b" font-size="10" fill="#fff" text-anchor="middle">2× Area</text>
    <text id="zl1" x="{(ZS0 + ZS1) / 2:.1f}" y="{TLY + 41}" class="t b" font-size="10" fill="#fff" text-anchor="middle">2× Cursor</text></g>
  <rect id="playhead" x="-1" y="{TLY - 6}" width="2" height="32" rx="1" fill="#fff"/>
  <rect id="exprog" x="{TL0}" y="{TLY + 54}" width="{TL1 - TL0}" height="3" rx="1.5" fill="#4c8dff"/>
  <rect y="426" width="{W}" height="24" fill="#1b1e25"/>
  <text x="12" y="442" class="t" font-size="10.5" fill="#9aa3b2">Grab-it 2026-11-15 09-41-12.mp4</text>
  <text id="cl0" x="204" y="442" class="t" font-size="10.5" fill="#9aa3b2">Clip 0:04.0</text>
  <text id="cl1" x="204" y="442" class="t" font-size="10.5" fill="#9aa3b2">Clip 0:03.7</text>
  <text x="276" y="442" class="t" font-size="10.5" fill="#9aa3b2">Output 1920×1080</text>
  <text id="es0" x="{W - 12}" y="442" class="t" font-size="10.5" fill="#9aa3b2" text-anchor="end">Edits saved</text>
  <text id="es1" x="{W - 12}" y="442" class="t" font-size="10.5" fill="#9aa3b2" text-anchor="end">Exporting… 58%</text>
  <text id="es2" x="{W - 12}" y="442" class="t b" font-size="10.5" fill="#3ddc97" text-anchor="end">Exported  ·  Grab-it 2026-11-15 09-41-12 (edited).mp4</text>
</g>""")
    A.kf("ve", [(VE_IN, "opacity:0"), (VE_IN + .25, "opacity:1")], "#ve")
    TRIM_A, TRIM_B = 9.75, 10.15
    ZADD, ZFOL = 10.85, 11.25
    A.kf("lh", [(TRIM_A, f"transform:translateX(0)"), (TRIM_B, f"transform:translateX({TRIM - TL0}px)")], "#lh", "ease-in-out")
    A.css.append(f"#trimdim{{transform-origin:{TL0}px 0}}")
    A.kf("trimdim", [(TRIM_A, "transform:scaleX(0)"), (TRIM_B, "transform:scaleX(1)")], "#trimdim", "ease-in-out")
    A.kf("playhead", [(TRIM_A, f"transform:translateX({TL0}px)"), (TRIM_B, f"transform:translateX({TRIM}px)"),
                      (10.45, f"transform:translateX({TRIM}px)"), (10.5, f"transform:translateX({ZS0}px)"),
                      (11.45, f"transform:translateX({ZS0}px)"), (11.5, f"transform:translateX({SEEK}px)"),
                      (PB0, f"transform:translateX({SEEK}px)"), (PB1, f"transform:translateX({TL1}px)")], "#playhead", "linear")
    A.css.append(f"#zseg{{transform-origin:{ZS0}px {TLY + 37}px}}")
    A.kf("zseg", [(ZADD, "opacity:0;transform:scaleX(.2)"), (ZADD + .25, "opacity:1;transform:scaleX(1)")], "#zseg", "cubic-bezier(.2,1.3,.4,1)")
    A.show("#zctl", "zctl", [(ZADD, 11.5)], fade=.12)
    A.show("#zarea", "zarea", [(0, ZFOL)], fade=.03)
    A.show("#zfollow", "zfollow", [(ZFOL, A.T)], fade=.03)
    A.show("#zl0", "zl0", [(0, ZFOL)], fade=.03)
    A.show("#zl1", "zl1", [(ZFOL, A.T)], fade=.03)
    A.show("#cl0", "cl0", [(0, TRIM_B)], fade=.02)
    A.show("#cl1", "cl1", [(TRIM_B, A.T)], fade=.02)
    for i, (_, a, b) in enumerate(times):
        A.show(f"#vt{i}", f"vt{i}", [(a, b)], fade=.02)
    A.show("#playico", "playico", [(0, PB0), (PB1, A.T)], fade=.02)
    A.show("#pauseico", "pauseico", [(PB0, PB1)], fade=.02)
    # Follow cursor: the view scales up around the pointer and moves with it.
    A.kf("vzoom", [(z0, f"transform:scale(1);{zoom_origin[0][1]}"), (z0 + .3, "transform:scale(2)"), (z1 - .3, "transform:scale(2)"), (z1, "transform:scale(1)")],
         "#vzoom", "ease-in-out")
    A.kf("vzoomo", zoom_origin, None)
    A.css.append("#vzoom{animation:vzoom %ss infinite both ease-in-out,vzoomo %ss infinite both cubic-bezier(.45,0,.3,1)}" % (A.T, A.T))
    A.kf("vcur", [(t, tr(*p)) for t, p in vpath], "#vcur", "cubic-bezier(.45,0,.3,1)")
    for i, (p, t) in enumerate((((503, 250), z0 + .4), ((627, 334), z1 - .2))):
        A.css.append(f"#vr{i}{{transform-origin:{p[0]}px {p[1]}px}}")
        A.kf(f"vr{i}", [(t - .02, "opacity:0;transform:scale(.4)"), (t + .04, "opacity:1;transform:scale(.5)"), (t + .55, "opacity:0;transform:scale(1.6)")], f"#vr{i}")
    A.show("#vkeys", "vkeys", [(z1 - .7, z1 - .1)], fade=.1)
    A.click(*ZOOM_BTN, ZADD - .05)
    A.click(*FOLLOW, ZFOL - .05)
    A.click(SEEK, TLY + 10, 11.45)
    A.click(*PLAY, PB0 - .05)
    A.click(*EXPORT, 15.1)
    A.css.append(f"#exprog{{transform-origin:{TL0}px 0}}")
    A.kf("exprog", [(15.15, "opacity:1;transform:scaleX(0)"), (15.75, "opacity:1;transform:scaleX(1)"), (15.85, "opacity:0;transform:scaleX(1)")], "#exprog", "ease-in-out")
    A.show("#es0", "es0", [(0, 15.15)], fade=.02)
    A.show("#es1", "es1", [(15.15, 15.75)], fade=.02)
    A.show("#es2", "es2", [(15.75, A.T)], fade=.05)

    cursor(A, [(1.6, (520, 300), 0), (1.65, (520, 300), 1), (1.85, WINDOW_BTN, 1), (2.0, WINDOW_BTN, 1), (2.45, (330, 240), 1), (2.6, (330, 240), 1),
               (2.95, REC, 1), (3.15, REC, 1), (3.3, (330, 260), 1), (5.1, (330, 260), 1), (5.55, BAR, 1), (6.4, BAR, 1), (6.95, SHIP, 1),
               (7.15, SHIP, 1), (7.65, STOP, 1), (8.3, STOP, 1), (8.85, EDIT, 1), (9.2, EDIT, 1), (9.6, (TL0 + 4, TLY + 10), 1),
               (TRIM_A, (TL0 + 4, TLY + 10), 1), (TRIM_B, (TRIM + 4, TLY + 10), 1), (10.45, (ZS0, TLY + 10), 1), (10.55, (ZS0, TLY + 10), 1),
               (ZADD - .1, ZOOM_BTN, 1), (ZADD + .05, ZOOM_BTN, 1), (ZFOL - .1, FOLLOW, 1), (ZFOL + .05, FOLLOW, 1),
               (11.42, (SEEK, TLY + 10), 1), (11.5, (SEEK, TLY + 10), 1), (PB0 - .1, PLAY, 1), (PB0 + .2, PLAY, 1), (12.3, (60, 400), 1),
               (14.7, (60, 400), 1), (15.05, EXPORT, 1), (18.2, EXPORT, 1)])
    A.click(*WINDOW_BTN, 1.9)
    A.click(330, 240, 2.55)
    A.click(*REC, 3.1)
    reset_cover(A, 18.4)
    write("video", A, "Recording and the video editor",
          "Record is picked on the Capture &amp; record… toolbar, which turns Region, Window and Screen into what to record and shows the recording options in the same toolbar. "
          "A window is chosen with clicks and keys on, and a countdown starts the recording. "
          "Clicks show as rings and a shortcut as a key label. In the video editor the start is trimmed, a zoom is added and set to follow the cursor, "
          "playback zooms in on each click, and Export saves a new MP4.",
          defs=f'<clipPath id="vclip"><rect x="{VX}" y="{VY}" width="{VW}" height="{VH:.1f}" rx="8"/></clipPath>'
               f'<clipPath id="qaclip"><rect x="{qx + 12}" y="{qy + 12}" width="96" height="57" rx="5"/></clipPath>',
          poster=13.0)


# ============================================================ 4. library =======
def tour_library():
    A = Anim(15.0)
    SBW = 150
    GX0, GY0, TW_, TH_, GAP, ROWH = 166, 112, 172, 98, 12, 160
    TILES = [(th_dash, "Launch dashboard", "Chrome · 9:41"), (th_rec, "Recording", "Grab-it · 9:43"),
             (th_code, "release.ts", "Code · 9:30"), (th_receipt, "Billing · ACME Cloud", "Chrome · Yesterday"),
             (th_term, "npm run build", "Terminal · Yesterday"), (th_figma, "Onboarding flow", "Figma · Monday")]
    MATCH, REC = 3, 1

    def slot(i):
        return GX0 + (i % 3) * (TW_ + GAP), GY0 + (i // 3) * ROWH

    def chips(x, y, items):
        out, cx = [], x
        for label, col, txt in items:
            w = text_w(label, 10) + 16
            out.append(f'<rect x="{cx}" y="{y}" width="{w:.0f}" height="16" rx="8" fill="{col}" opacity=".22"/>'
                       f'<text x="{cx + w / 2:.1f}" y="{y + 11.5}" class="t" font-size="10" fill="{txt}" text-anchor="middle">{label}</text>')
            cx += w + 5
        return "".join(out)

    GREEN, BLUE, AMBER, PURPLE = ("#30a46c", "#7ee2b0"), ("#4c8dff", "#9cc0ff"), ("#f5a524", "#ffd38a"), ("#a56bff", "#d4bfff")
    tiles, clips = [], []
    for i, (fn, title, meta) in enumerate(TILES):
        x, y = slot(i)
        clips.append(f'<clipPath id="tc{i}"><rect x="{x}" y="{y}" width="{TW_}" height="{TH_}" rx="6"/></clipPath>')
        extra = ""
        if i == 0:
            extra = (f'<g id="shim"><rect x="{x}" y="{y}" width="{TW_}" height="{TH_}" rx="6" fill="#0b0d12" opacity=".55"/>'
                     f'<rect x="{x + TW_ / 2 - 50}" y="{y + TH_ / 2 - 11}" width="100" height="22" rx="11" fill="#16181d"/>'
                     f'<text x="{x + TW_ / 2}" y="{y + TH_ / 2 + 4}" class="t" font-size="10.5" fill="#d4bfff" text-anchor="middle">✦ Describing…</text></g>'
                     f'<g id="ai0">{chips(x, y + TH_ + 38, [("dashboard ✦", *BLUE), ("launch ✦", *PURPLE)])}</g>')
        if i == MATCH:
            extra = (f'<g id="snip"><text x="{x}" y="{y + TH_ + 30}" class="t" font-size="10" fill="#8b93a1">Text in image:</text>'
                     f'<rect x="{x + 67}" y="{y + TH_ + 20}" width="38" height="14" rx="3" fill="#4c8dff" opacity=".35"/>'
                     f'<text x="{x + 69}" y="{y + TH_ + 30}" class="t" font-size="10" fill="#e6e8ee">Invoice INV-2026-0312</text>'
                     f'{chips(x, y + TH_ + 38, [("receipt ✦", *GREEN), ("acme ✦", *BLUE)])}</g>')
        if i == REC:
            extra = (f'<g id="hover"><rect x="{x}" y="{y}" width="{TW_}" height="{TH_}" rx="6" fill="#000" opacity=".25"/>'
                     + "".join(f'<rect x="{x + 8 + j * 52}" y="{y + TH_ - 30}" width="48" height="22" rx="6" fill="#16181d" opacity=".95"/>'
                               f'<text x="{x + 32 + j * 52}" y="{y + TH_ - 15}" class="t b" font-size="10" fill="#e6e8ee" text-anchor="middle">{lab}</text>'
                               for j, lab in enumerate(["Play", "Edit", "Folder"])) + '</g>')
        tiles.append(f"""<g id="tile{i}"><g clip-path="url(#tc{i})">{fn(x, y, TW_, TH_, f"tc{i}")}</g>
  <rect x="{x}" y="{y}" width="{TW_}" height="{TH_}" rx="6" fill="none" stroke="#2c313b"/>
  <text x="{x}" y="{y + TH_ + 16}" class="t b" font-size="11.5" fill="#e6e8ee">{title}</text>
  <text id="meta{i}" x="{x}" y="{y + TH_ + 30}" class="t" font-size="10" fill="#8b93a1">{meta}</text>{extra}</g>""")

    def side(y, label, count, col, id_=None):
        return (f'<g{f" id={chr(34)}{id_}{chr(34)}" if id_ else ""}><circle cx="22" cy="{y - 1}" r="4.5" fill="{col}"/>'
                f'<text x="34" y="{y + 3}" class="t" font-size="11.5" fill="#e6e8ee">{label}</text>'
                f'<text x="{SBW - 12}" y="{y + 3}" class="t" font-size="10.5" fill="#6b7280" text-anchor="end">{count}</text></g>')

    QUERY, TAG = "invoice", "expenses"
    T_TYPE, T_TAG = 2.5, 5.9
    typed = "".join(f'<text id="q{i}" x="350" y="35" class="t" font-size="12" fill="#f3f4f7">{QUERY[:i + 1]}</text>' for i in range(len(QUERY)))
    PX = 420
    tagtyped = "".join(f'<text id="g{i}" x="{PX + 142}" y="376" class="t" font-size="11" fill="#f3f4f7">{TAG[:i + 1]}</text>' for i in range(len(TAG)))
    panel = f"""<g id="panel">
  <rect x="{PX}" y="52" width="{W - PX}" height="398" fill="#16181d"/><rect x="{PX}" y="52" width="1" height="398" fill="#2c313b"/>
  <text x="{PX + 16}" y="76" class="t b" font-size="13" fill="#f3f4f7">Billing · ACME Cloud</text>
  <text x="{PX + 16}" y="92" class="t" font-size="10" fill="#8b93a1">Chrome · Yesterday at 16:02 · 1440 × 900</text>
  <path d="M{W - 26} 66l9 9M{W - 17} 66l-9 9" stroke="#8b93a1" stroke-width="1.5" stroke-linecap="round"/>
  <g clip-path="url(#pclip)">{th_receipt(PX + 16, 102, 268, 120, "pclip")}</g>
  <g class="t b" font-size="10.5" text-anchor="middle">
    <rect x="{PX + 16}" y="232" width="48" height="22" rx="6" fill="#0090ff"/><text x="{PX + 40}" y="247" fill="#fff">Edit</text>
    <rect x="{PX + 69}" y="232" width="50" height="22" rx="6" fill="#2a2f39"/><text x="{PX + 94}" y="247" fill="#e6e8ee">Copy</text>
    <rect id="ctbtn" x="{PX + 124}" y="232" width="72" height="22" rx="6" fill="#2a2f39"/><text x="{PX + 160}" y="247" fill="#e6e8ee">Copy text</text>
    <rect x="{PX + 201}" y="232" width="40" height="22" rx="6" fill="#2a2f39"/><text x="{PX + 221}" y="247" fill="#e6e8ee">Pin</text>
  </g>
  <text x="{PX + 16}" y="276" class="t" font-size="10" fill="#8b93a1">Category</text>
  <text x="{PX + 86}" y="276" class="t b" font-size="10.5" fill="#e6e8ee">Receipt</text>
  <text x="{PX + 16}" y="298" class="t" font-size="10" fill="#8b93a1">Description <tspan fill="#c4b5ff">✦</tspan></text>
  <text x="{PX + 16}" y="315" class="t" font-size="11" fill="#e6e8ee">An ACME Cloud invoice for March 2026 with</text>
  <text x="{PX + 16}" y="330" class="t" font-size="11" fill="#e6e8ee">three line items, $1,284.00 in total.</text>
  <text x="{PX + 16}" y="354" class="t" font-size="10" fill="#8b93a1">Tags</text>
  {chips(PX + 16, 364, [("receipt ✦", *GREEN), ("acme ✦", *BLUE)])}
  <g id="newtag">{chips(PX + 140, 364, [("expenses", *AMBER)])}</g>
  <rect id="taginput" x="{PX + 136}" y="362" width="96" height="20" rx="5" fill="none" stroke="#4c8dff"/>
  {tagtyped}
  <text x="{PX + 16}" y="404" class="t" font-size="10" fill="#8b93a1">Notes</text>
  <rect x="{PX + 16}" y="412" width="268" height="26" rx="6" fill="#1f2228" stroke="#2c313b"/>
  <text x="{PX + 24}" y="429" class="t" font-size="11" fill="#6b7280">Add a note</text>
</g>"""
    A.body.append(f"""
<g id="lib">
  <rect width="{W}" height="{H}" fill="#111317"/>
  <rect width="{SBW}" height="{H}" fill="#16181d"/><rect x="{SBW - 1}" width="1" height="{H}" fill="#2c313b"/>
  <circle cx="16" cy="16" r="4.5" fill="#ff5f57"/><circle cx="30" cy="16" r="4.5" fill="#febc2e"/><circle cx="44" cy="16" r="4.5" fill="#28c840"/>
  <rect id="selAll" x="8" y="38" width="{SBW - 16}" height="24" rx="6" fill="#23262d"/>
  <rect id="selRec" x="8" y="64" width="{SBW - 16}" height="24" rx="6" fill="#23262d"/>
  {side(54, "All captures", "248", "#4c8dff")}{side(80, "Recordings", "12", RED)}
  <text x="14" y="114" class="t b" font-size="9.5" fill="#6b7280" letter-spacing=".6">APPS</text>
  {side(136, "Chrome", "96", "#f5a524")}{side(158, "Figma", "41", "#a56bff")}{side(180, "Terminal", "37", "#9aa3b2")}
  <text x="14" y="214" class="t b" font-size="9.5" fill="#6b7280" letter-spacing=".6">TAGS</text>
  {side(236, "release", "31", "#4c8dff")}{side(258, "bug", "18", RED)}{side(280, "receipt ✦", "9", "#30a46c")}
  <rect x="8" y="410" width="{SBW - 16}" height="1" fill="#2c313b"/>
  <text x="14" y="432" class="t" font-size="11" fill="#9aa3b2">Settings</text>
  <text id="hd0" x="166" y="36" class="t b" font-size="16" fill="#f3f4f7">All captures</text>
  <text id="hd1" x="166" y="36" class="t b" font-size="16" fill="#f3f4f7">Recordings</text>
  <text id="n0" x="268" y="36" class="t" font-size="11.5" fill="#6b7280">248</text>
  <text id="n1" x="268" y="36" class="t" font-size="11.5" fill="#6b7280">1 result</text>
  <text id="n2" x="258" y="36" class="t" font-size="11.5" fill="#6b7280">12</text>
  <rect x="326" y="16" width="230" height="28" rx="7" fill="#1b1e25" stroke="#2c313b"/>
  <rect id="sfocus" x="326" y="16" width="230" height="28" rx="7" fill="none" stroke="#4c8dff" stroke-width="1.5"/>
  <g fill="none" stroke="#8b93a1" stroke-width="1.4" stroke-linecap="round"><circle cx="339" cy="29" r="4.5"/><path d="M342.5 32.5l3.5 3.5"/></g>
  <text id="ph" x="350" y="35" class="t" font-size="12" fill="#6b7280">Search text, tags, notes</text>
  {typed}
  <rect x="566" y="16" width="140" height="28" rx="7" fill="#5b7cfa"/>
  <path d="M579 26v-4h4M591 22h4v4M595 32v4h-4M583 36h-4v-4" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
  <text x="603" y="34" class="t b" font-size="11.5" fill="#fff">New capture</text>
  <g class="t" font-size="11" text-anchor="middle">
    <rect x="166" y="56" width="240" height="24" rx="7" fill="#16181d" stroke="#2c313b"/>
    <rect x="169" y="59" width="60" height="18" rx="5" fill="#2a2f39"/><text x="199" y="72" fill="#f3f4f7">Any time</text>
    <text x="256" y="72" fill="#9aa3b2">Today</text><text x="306" y="72" fill="#9aa3b2">7 days</text><text x="362" y="72" fill="#9aa3b2">30 days</text>
  </g>
  <text id="sec0" x="166" y="102" class="t b" font-size="12" fill="#c9ceda">Today</text>
  <text id="sec1" x="166" y="102" class="t b" font-size="12" fill="#c9ceda">Best matches</text>
  <g id="st0"><text x="706" y="102" class="t" font-size="10.5" fill="#c4b5ff" text-anchor="end">✦ Describing 1 of 1…</text></g>
  <g id="st1"><text x="706" y="102" class="t" font-size="10.5" fill="#7ee2b0" text-anchor="end">✦ Every capture is described</text></g>
  {''.join(tiles)}
  {panel}
</g>""")
    A.show("#shim", "shim", [(0, 1.7)], fade=.2)
    A.css.append(f"#ai0{{transform-origin:{GX0}px {GY0 + TH_ + 46}px}}")
    A.kf("ai0", [(1.65, "opacity:0;transform:scale(.6)"), (1.85, "opacity:1;transform:scale(1.06)"), (1.95, "opacity:1;transform:scale(1)")], "#ai0")
    A.show("#st0", "st0", [(0, 1.7)], fade=.1)
    A.show("#st1", "st1", [(1.7, 3.3)], fade=.1)
    SEARCH = (440, 30)
    A.click(*SEARCH, 2.3, "#4c8dff")
    CLEAR = 9.75
    A.show("#sfocus", "sfocus", [(2.3, CLEAR)], fade=.1)
    A.show("#ph", "ph", [(0, T_TYPE), (CLEAR, A.T)], fade=.02)
    for i in range(len(QUERY)):
        a = T_TYPE + i * .11
        A.show(f"#q{i}", f"q{i}", [(a, T_TYPE + (i + 1) * .11 if i < len(QUERY) - 1 else CLEAR)], fade=.02)
    RES = T_TYPE + len(QUERY) * .11 + .15
    REC_T = 10.6
    A.show("#hd0", "hd0", [(0, REC_T)], fade=.03)
    A.show("#hd1", "hd1", [(REC_T, A.T)], fade=.03)
    A.show("#n0", "n0", [(0, RES), (CLEAR, REC_T)], fade=.03)
    A.show("#n1", "n1", [(RES, CLEAR)], fade=.03)
    A.show("#n2", "n2", [(REC_T, A.T)], fade=.03)
    A.show("#sec0", "sec0", [(0, RES), (CLEAR, A.T)], fade=.03)
    A.show("#sec1", "sec1", [(RES, CLEAR)], fade=.03)
    A.show("#selAll", "selAll", [(0, REC_T)], fade=.05)
    A.show("#selRec", "selRec", [(REC_T, A.T)], fade=.05)
    for i in range(len(TILES)):
        x, y = slot(i)
        A.css.append(f"#tile{i}{{transform-origin:{x + TW_ / 2}px {y + TH_ / 2}px}}")
        off, on = "opacity:0;transform:scale(.92)", "opacity:1;transform:scale(1)"
        if i == MATCH:
            dx, dy = GX0 - x, GY0 - y
            A.kf(f"tile{i}", [(RES + .2, on), (RES + .55, f"opacity:1;transform:translate({dx}px,{dy}px)"),
                              (CLEAR, f"opacity:1;transform:translate({dx}px,{dy}px)"), (CLEAR + .35, on),
                              (REC_T, on), (REC_T + .25, off)], f"#tile{i}", "cubic-bezier(.3,1.1,.5,1)")
        elif i == REC:
            dx, dy = GX0 - x, GY0 - y
            A.kf(f"tile{i}", [(RES, on), (RES + .25, off), (CLEAR + .1, off), (CLEAR + .4, on),
                              (REC_T + .15, on), (REC_T + .5, f"opacity:1;transform:translate({dx}px,{dy}px)")], f"#tile{i}", "ease-in-out")
        else:
            A.kf(f"tile{i}", [(RES + i * .02, on), (RES + .25 + i * .02, off), (CLEAR + .1, off), (CLEAR + .4, on),
                              (REC_T, on), (REC_T + .25, off)], f"#tile{i}", "ease-in-out")
    A.show(f"#meta{MATCH}", "metam", [(0, RES + .4), (CLEAR, A.T)], fade=.1)
    A.show("#snip", "snip", [(RES + .45, CLEAR)], fade=.2)
    A.show("#hover", "hover", [(11.3, A.T)], fade=.15)

    TILE0 = (GX0 + TW_ / 2, GY0 + TH_ / 2)
    P_IN = 4.55
    A.click(*TILE0, P_IN - .1)
    A.kf("panel", [(P_IN, f"transform:translateX({W - PX}px)"), (P_IN + .35, "transform:translateX(0)"),
                   (CLEAR - .05, "transform:translateX(0)"), (CLEAR + .3, f"transform:translateX({W - PX}px)")], "#panel", "cubic-bezier(.2,.9,.3,1)")
    TAGIN = (PX + 184, 372)
    A.click(*TAGIN, T_TAG - .2, "#4c8dff")
    A.show("#taginput", "taginput", [(T_TAG - .2, T_TAG + len(TAG) * .09 + .25)], fade=.08)
    for i in range(len(TAG)):
        a = T_TAG + i * .09
        b = T_TAG + (i + 1) * .09 if i < len(TAG) - 1 else T_TAG + len(TAG) * .09 + .25
        A.show(f"#g{i}", f"g{i}", [(a, b)], fade=.02)
    ENTER_T = T_TAG + len(TAG) * .09 + .25
    key_badge(A, "kenter", "Enter", PX + 184, 340, ENTER_T)
    A.css.append(f"#newtag{{transform-origin:{PX + 170}px 372px}}")
    A.kf("newtag", [(ENTER_T, "opacity:0;transform:scale(.6)"), (ENTER_T + .18, "opacity:1;transform:scale(1.08)"), (ENTER_T + .3, "opacity:1;transform:scale(1)")], "#newtag")
    COPYTEXT = (PX + 160, 243)
    A.click(*COPYTEXT, 7.75)
    A.show("#ctbtn", "ctbtn", [(7.7, 8.1)], fade=.1, on="opacity:1;fill:#4c8dff", off="opacity:1;fill:#2a2f39")
    A.body.append(f"""<g id="toast"><rect x="{(166 + 420) / 2 - 80}" y="396" width="160" height="30" rx="15" fill="#1f2328" stroke="#3a404c"/>
  {check_icon((166 + 420) / 2 - 60, 411)}<text x="{(166 + 420) / 2 - 44}" y="415.5" class="t b" font-size="11.5" fill="#fff">Text copied</text></g>""")
    A.kf("toast", [(7.8, "opacity:0;transform:translateY(16px)"), (8.05, "opacity:1;transform:translateY(0)"), (9.2, "opacity:1;transform:translateY(0)"),
                   (9.45, "opacity:0;transform:translateY(0)")], "#toast", "cubic-bezier(.2,1.3,.4,1)")
    key_badge(A, "kesc", "Esc", 600, 88, CLEAR - .1)
    RECS = (60, 80)
    A.click(*RECS, REC_T - .05)
    cursor(A, [(0, (560, 300), 1), (1.9, (560, 300), 1), (2.25, SEARCH, 1), (2.6, SEARCH, 1), (3.0, (520, 90), 1),
               (P_IN - .5, (520, 90), 1), (P_IN - .15, TILE0, 1), (P_IN + .3, TILE0, 1), (T_TAG - .35, TAGIN, 1), (T_TAG + .9, TAGIN, 1),
               (7.65, COPYTEXT, 1), (8.4, COPYTEXT, 1), (9.0, (360, 300), 1), (REC_T - .45, (360, 300), 1), (REC_T - .1, RECS, 1),
               (REC_T + .3, RECS, 1), (11.2, (GX0 + 60, GY0 + 50), 1), (14.4, (GX0 + 60, GY0 + 50), 1)])
    reset_cover(A, 14.4, fill="#111317")
    write("library", A, "The Library and AI",
          "A new capture is described by AI and gets its tags. Searching for invoice finds a receipt by the text inside it. Its details show the AI "
          "description, category and tags; a tag is added and its text is copied. Then the Recordings filter shows the recordings, with Play and Edit on hover.",
          defs="".join(clips) + '<clipPath id="pclip"><rect x="436" y="102" width="268" height="120" rx="6"/></clipPath>',
          poster=5.5)

if __name__ == "__main__":
    which = sys.argv[1:] or ["capture", "editor", "video", "library"]
    for name in which:
        globals()[f"tour_{name}"]()
