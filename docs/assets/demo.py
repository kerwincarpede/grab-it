"""Generate docs/assets/demo.svg, the animated Grab-it demo. The README shows
docs/assets/demo.gif, which docs/assets/demo_gif.py renders from this SVG.

Run from the repository root:  python3 docs/assets/demo.py docs/assets/demo.svg

Everything is driven by CSS keyframes sharing one cycle of T seconds, so the SVG
also plays inside an <img>. Times below are in seconds into that cycle.

The story, one chapter per caption at the bottom:
  1. Capture        All-in-one toolbar, drag a region, exact size, Quick Access card
  2. Mark it up     arrow, box, steps, blur, a note and a backdrop, then copy
  3. Copy text      read the code off a screen share, tidied up by AI
  4. Record & edit  record the screen, trim it, zoom in on the click, export
  5. Find it again  search the Library by the text inside a capture, AI details
"""
import math
import random
import sys

T = 32.0  # seconds per loop
W, H = 960, 620  # card size; the "screen" is the top 960x540

css = []
body = []


def P(s):
    return s / T * 100


def kf(name, frames, sel=None, ease=None):
    """Keyframes from (seconds, declarations) pairs; the first and last values are held to the ends."""
    fr = list(frames)
    if fr[0][0] > 0:
        fr.insert(0, (0, fr[0][1]))
    if fr[-1][0] < T:
        fr.append((T, fr[-1][1]))
    for a, b in zip(fr, fr[1:]):
        assert b[0] > a[0], (name, a, b)
    css.append(f"@keyframes {name}{{" + "".join(f"{P(s):.3f}%{{{d}}}" for s, d in fr) + "}")
    if sel:
        timing = f";animation-timing-function:{ease}" if ease else ""
        css.append(f"{sel}{{animation:{name} {T}s infinite both{timing}}}")
    return name


def show(sel, name, wins, fade=.3, off="opacity:0", on="opacity:1", ease=None):
    """Visible during each (start, end) window, fading over `fade` seconds at each edge."""
    fr = []
    swap = fade <= .05  # a quick swap: be fully shown at a and until b, so no frame shows neither
    for a, b in wins:
        fr += [(0, on)] if a <= 0 else [(a - fade, off), (a, on)] if swap else [(a, off), (a + fade, on)]
        fr += [(T, on)] if b >= T else [(b, on), (b + fade, off)] if swap else [(b - fade, on), (b, off)]
    kf(name, fr, sel, ease)


def tr(x, y, s=None):
    t = f"translate({x:.1f}px,{y:.1f}px)"
    if s is not None:
        t += f" scale({s})"
    return f"transform:{t}"


ripples = []


def click(x, y, t, color="#fff"):
    """A ring that grows out of (x, y) at time t."""
    i = len(ripples)
    ripples.append(f'<circle id="rp{i}" cx="{x:.1f}" cy="{y:.1f}" r="18" fill="none" stroke="{color}" stroke-width="3"/>')
    css.append(f"#rp{i}{{transform-origin:{x:.1f}px {y:.1f}px}}")
    kf(f"rp{i}", [(t - .02, "opacity:0;transform:scale(.3)"), (t + .04, "opacity:.95;transform:scale(.4)"),
                  (t + .6, "opacity:0;transform:scale(2.1)")], f"#rp{i}")


FONT = 't'
MONO = 'font-family="JetBrains Mono,SF Mono,Menlo,Consolas,monospace"'


# ======================================================================= desktop
def dashboard():
    """The app window being captured and recorded (desktop coordinates)."""
    bars = [52, 70, 61, 88, 79, 112, 150]
    b = []
    for i, h in enumerate(bars):
        x = 286 + i * 34
        fill = "#4c8dff" if i == len(bars) - 1 else "#c9d6f2"
        b.append(f'<rect x="{x}" y="{366 - h}" width="22" height="{h}" rx="4" fill="{fill}"/>')
    return f"""
<g id="dash">
  <rect x="140" y="58" width="684" height="404" rx="12" fill="#ffffff"/>
  <path d="M152 58h660a12 12 0 0 1 12 12v22H140V70a12 12 0 0 1 12-12z" fill="#eef0f5"/>
  <circle cx="160" cy="75" r="5.5" fill="#ff5f57"/><circle cx="178" cy="75" r="5.5" fill="#febc2e"/><circle cx="196" cy="75" r="5.5" fill="#28c840"/>
  <text x="482" y="80" class="t" font-size="12" fill="#6b7280" text-anchor="middle">Launch HQ</text>
  <rect x="140" y="92" width="100" height="370" fill="#f6f7fb"/>
  <rect x="156" y="112" width="56" height="8" rx="4" fill="#4c8dff"/>
  <rect x="156" y="136" width="66" height="8" rx="4" fill="#d6dae3"/>
  <rect x="156" y="160" width="48" height="8" rx="4" fill="#d6dae3"/>
  <rect x="156" y="184" width="60" height="8" rx="4" fill="#d6dae3"/>
  <text x="262" y="124" class="t b" font-size="17" fill="#1f2328">Launch dashboard</text>
  <rect x="262" y="150" width="280" height="230" rx="10" fill="#fff" stroke="#e4e7ee"/>
  <text x="280" y="178" class="t" font-size="12" fill="#6b7280">Weekly signups</text>
  <text x="280" y="218" class="t b" font-size="30" fill="#1f2328">12,480</text>
  <rect x="392" y="198" width="48" height="22" rx="11" fill="#dcfce7"/>
  <text x="416" y="213" class="t b" font-size="11.5" fill="#15803d" text-anchor="middle">+38%</text>
  {''.join(b)}
  <rect x="556" y="150" width="244" height="230" rx="10" fill="#fff" stroke="#e4e7ee"/>
  <text x="574" y="178" class="t b" font-size="14" fill="#1f2328">Release v2.0</text>
  <text x="574" y="206" class="t" font-size="11" fill="#6b7280">Notify</text>
  <rect x="574" y="214" width="208" height="28" rx="6" fill="#f9fafb" stroke="#d6dae3"/>
  <text x="584" y="233" class="t" font-size="12.5" fill="#1f2328">sam.rivera@acme.co</text>
  <rect x="574" y="256" width="150" height="7" rx="3.5" fill="#e4e7ee"/>
  <rect x="574" y="272" width="120" height="7" rx="3.5" fill="#e4e7ee"/>
  <rect x="574" y="318" width="106" height="32" rx="8" fill="#1f2328"/>
  <text x="627" y="339" class="t b" font-size="13" fill="#fff" text-anchor="middle">Ship it</text>
  <rect x="140" y="400" width="684" height="1" fill="#eef0f5"/>
  <text x="262" y="432" class="t" font-size="11.5" fill="#9aa3b2">Last deploy 12 minutes ago · all checks passed</text>
</g>"""


def logo(x, y, s=1.0, color="#fff"):
    """Grab-it glyph: viewfinder corners around a dot."""
    return f"""<g transform="translate({x} {y}) scale({s})" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round">
<path d="M-8 -3v-5h5M3 -8h5v5M8 3v5h-5M-3 8h-5v-5"/><circle r="2.6" fill="{color}" stroke="none"/></g>"""


body.append(f"""
<g id="desk">
  <rect width="960" height="540" fill="url(#wall)"/>
  <circle cx="120" cy="470" r="180" fill="#ff6ac1" opacity=".18" filter="url(#soft)"/>
  <circle cx="860" cy="80" r="200" fill="#3ddc97" opacity=".14" filter="url(#soft)"/>
  <rect x="140" y="62" width="684" height="404" rx="12" fill="#000" opacity=".35" filter="url(#shadow)"/>
  {dashboard()}
  <rect y="508" width="960" height="32" fill="#0b0d12" opacity=".72"/>
  <text x="928" y="529" class="t" font-size="12" fill="#e6e8ee" text-anchor="end">9:41</text>
  <circle cx="852" cy="524" r="4" fill="#9aa3b2"/><circle cx="870" cy="524" r="4" fill="#9aa3b2"/>
  <circle id="trayglow" cx="830" cy="524" r="12" fill="#4c8dff"/>{logo(830, 524, .72, "#e6e8ee")}
</g>""")
show("#trayglow", "trayglow", [(.7, 1.9)], fade=.4, on="opacity:.9")

# ================================================================ 1. capture ===
# The All-in-one shortcut.
caps = [("Ctrl", 74), ("Alt", 62), ("PrtSc", 96)]
gap = 30
x = -(sum(w for _, w in caps) + gap * (len(caps) - 1)) / 2
keyparts = []
for i, (label, w) in enumerate(caps):
    keyparts.append(f"""<g class="cap"><rect x="{x}" y="-30" width="{w}" height="58" rx="12" fill="#f4f5f8"/>
<rect x="{x}" y="-30" width="{w}" height="52" rx="12" fill="#fff"/>
<text x="{x + w / 2}" y="2" class="t b" font-size="19" fill="#1f2328" text-anchor="middle">{label}</text></g>""")
    if i < len(caps) - 1:
        keyparts.append(f'<text x="{x + w + gap / 2}" y="2" class="t b" font-size="20" fill="#fff" text-anchor="middle">+</text>')
    x += w + gap
body.append(f"""
<g id="keys"><g transform="translate(480 262)">
  <rect x="-150" y="-50" width="300" height="120" rx="20" fill="#0b0d12" opacity=".55"/>
  {''.join(keyparts)}
  <text y="52" class="t" font-size="12" fill="#c9ceda" text-anchor="middle">All-in-one  ·  ⌘ ⇧ A on a Mac</text>
</g></g>""")
css.append("#keys{transform-origin:480px 262px}")
kf("keys", [(.15, "opacity:0;transform:scale(.7)"), (.45, "opacity:1;transform:scale(1.04)"), (.6, "opacity:1;transform:scale(1)"),
            (1.15, "opacity:1;transform:scale(1)"), (1.45, "opacity:0;transform:scale(1.15)")], "#keys")
kf("press", [(.7, "transform:translateY(0)"), (.8, "transform:translateY(5px)"), (.98, "transform:translateY(0)")], "#keys .cap")

# Dimmed, frozen screen (used by Capture and by Copy text).
body.append('<rect id="dim" width="960" height="540" fill="#05070c"/>')
show("#dim", "dim", [(1.15, 3.95), (12.95, 14.75)], fade=.15, on="opacity:.55")

# Selection for the capture.
SX, SY, SW, SH = 252, 138, 560, 254
handles = "".join(f'<rect x="{hx - 4}" y="{hy - 4}" width="8" height="8" rx="1.5" fill="#fff" stroke="#0090ff" stroke-width="1.5"/>'
                  for hx in (SX, SX + SW / 2, SX + SW) for hy in (SY, SY + SH / 2, SY + SH)
                  if (hx, hy) != (SX + SW / 2, SY + SH / 2))
body.append(f"""
<g id="sel">
  <rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="#fff" opacity=".16"/>
  <rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="none" stroke="#0090ff" stroke-width="2"/>
</g>
<g id="handles">{handles}</g>""")
css.append(f"#sel{{transform-origin:{SX}px {SY}px}}")
kf("sel", [(1.8, "opacity:0;transform:scale(0)"), (1.82, "opacity:1;transform:scale(0)"),
           (2.9, "opacity:1;transform:scale(1)"), (3.8, "opacity:1;transform:scale(1)"),
           (3.95, "opacity:0;transform:scale(1)")], "#sel", "ease-in-out")
show("#handles", "handles", [(2.95, 3.95)], fade=.15)

# Size chip with exact size and ratio locks, above the selection.
CHX, CHY = SX, SY - 42
chip = [f'<rect x="{CHX}" y="{CHY}" width="368" height="32" rx="9" fill="#16181d" stroke="#2c313b"/>',
        f'<rect x="{CHX + 6}" y="{CHY + 6}" width="48" height="20" rx="5" fill="#23262d"/>',
        f'<text x="{CHX + 30}" y="{CHY + 20}" class="t" font-size="12" fill="#e6e8ee" text-anchor="middle">1120</text>',
        f'<text x="{CHX + 62}" y="{CHY + 20}" class="t" font-size="12" fill="#8b93a1" text-anchor="middle">×</text>',
        f'<rect x="{CHX + 70}" y="{CHY + 6}" width="42" height="20" rx="5" fill="#23262d"/>',
        f'<text x="{CHX + 91}" y="{CHY + 20}" class="t" font-size="12" fill="#e6e8ee" text-anchor="middle">508</text>',
        f'<text x="{CHX + 118}" y="{CHY + 20}" class="t" font-size="11" fill="#8b93a1">px</text>',
        f'<rect x="{CHX + 138}" y="{CHY + 5}" width="40" height="22" rx="6" fill="#0090ff"/>']
for lx, lab in [(CHX + 158, "Free"), (CHX + 198, "16:9"), (CHX + 234, "4:3"), (CHX + 266, "1:1")]:
    chip.append(f'<text x="{lx}" y="{CHY + 20}" class="t b" font-size="12" fill="#e6e8ee" text-anchor="middle">{lab}</text>')
chip.append(f'<text x="{CHX + 290}" y="{CHY + 20}" class="t b" font-size="12" fill="#e6e8ee">Capture</text>')
chip.append(f'<text x="{CHX + 342}" y="{CHY + 20}" {MONO} font-size="10" fill="#8b93a1">⏎</text>')
body.append(f'<g id="chip">{"".join(chip)}</g>')
show("#chip", "chip", [(3.0, 3.95)], fade=.2)

# Enter key press.
body.append(f"""<g id="enter"><g transform="translate({SX + SW / 2} {SY + SH / 2})">
  <rect x="-46" y="-24" width="92" height="50" rx="11" fill="#f4f5f8"/><rect x="-46" y="-24" width="92" height="44" rx="11" fill="#fff"/>
  <text y="5" class="t b" font-size="17" fill="#1f2328" text-anchor="middle">Enter</text></g></g>""")
css.append(f"#enter{{transform-origin:{SX + SW / 2}px {SY + SH / 2}px}}")
kf("enter", [(3.3, "opacity:0;transform:scale(.7)"), (3.48, "opacity:1;transform:scale(1.05)"),
             (3.6, "opacity:1;transform:scale(.94)"), (3.75, "opacity:1;transform:scale(1)"),
             (3.9, "opacity:0;transform:scale(1.2)")], "#enter")

# Selection for Copy text, over the code on the screen share (drawn later, but defined here).
TX, TY, TW, TH = 168, 112, 506, 164

body.append(f"""
<g id="sel2">
  <rect x="{TX}" y="{TY}" width="{TW}" height="{TH}" fill="#fff" opacity=".12"/>
  <rect x="{TX}" y="{TY}" width="{TW}" height="{TH}" fill="none" stroke="#0090ff" stroke-width="2"/>
</g>
<g id="scan" clip-path="url(#scanclip)">
  <rect id="scanbar" x="{TX - 60}" y="{TY}" width="60" height="{TH}" fill="url(#scangrad)"/>
</g>""")
css.append(f"#sel2{{transform-origin:{TX}px {TY}px}}")
kf("sel2", [(13.5, "opacity:0;transform:scale(0)"), (13.52, "opacity:1;transform:scale(0)"),
            (14.2, "opacity:1;transform:scale(1)"), (14.6, "opacity:1;transform:scale(1)"),
            (14.75, "opacity:0;transform:scale(1)")], "#sel2", "ease-in-out")
kf("scanbar", [(14.22, "transform:translateX(0)"), (14.7, f"transform:translateX({TW + 60}px)")], "#scanbar", "ease-in-out")

# All-in-one toolbar.
MODES = [("Region", "1"), ("Window", "2"), ("Screen", "3"), ("Text", "4"), ("Colour", "5"), ("Record", "6"), ("Timer off", "7")]
ARIAL = {"a": 556, "e": 556, "f": 278, "g": 556, "i": 222, "l": 222, "m": 833, "n": 556, "o": 556, "r": 333, "t": 278,
         "u": 556, "w": 722, "x": 500, "d": 556, "c": 500, " ": 278, "R": 722, "W": 944, "S": 667, "T": 611, "C": 722}


def text_w(s, size):
    """Rough width of s in a Helvetica/Arial-like font."""
    return sum(ARIAL.get(ch, 556) for ch in s) * size / 1000


widths = [round(30 + text_w(m, 12.5) + 30) for m, _ in MODES]
tb_w = sum(widths) + 4 * (len(MODES) - 1) + 12
tb_x = 480 - tb_w / 2
TB_Y = 12


def mode_icon(name, cx, cy):
    s = 'fill="none" stroke="#e6e8ee" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
    if name == "Region":
        return f'<path {s} d="M{cx-6} {cy-2}v-4h4M{cx+2} {cy-6}h4v4M{cx+6} {cy+2}v4h-4M{cx-2} {cy+6}h-4v-4"/>'
    if name == "Window":
        return f'<rect {s} x="{cx-7}" y="{cy-5.5}" width="14" height="11" rx="2"/><path {s} d="M{cx-7} {cy-2}h14"/>'
    if name == "Screen":
        return f'<rect {s} x="{cx-7}" y="{cy-6}" width="14" height="9.5" rx="1.5"/><path {s} d="M{cx-3} {cy+6.5}h6M{cx} {cy+3.5}v3"/>'
    if name == "Text":
        return f'<path {s} d="M{cx-6} {cy-5}h12M{cx} {cy-5}v11"/>'
    if name == "Colour":
        return f'<path {s} d="M{cx-5} {cy+6}l1-4 7-7 3 3-7 7z"/>'
    if name == "Record":
        return f'<circle {s} cx="{cx}" cy="{cy}" r="6"/>'
    return f'<circle {s} cx="{cx}" cy="{cy + 1}" r="6"/><path {s} d="M{cx} {cy - 2}v3M{cx - 2} {cy - 7}h4"/>'


tb = [f'<rect x="{tb_x}" y="{TB_Y}" width="{tb_w}" height="36" rx="11" fill="#16181d" stroke="#2c313b"/>']
mx = tb_x + 6
mode_x = {}
for (m, n), w in zip(MODES, widths):
    mode_x[m] = (mx, w)
    mx += w + 4
for m in ("Region", "Text"):
    hx, hw = mode_x[m]
    tb.append(f'<rect id="hl{m}" x="{hx}" y="{TB_Y + 4}" width="{hw}" height="28" rx="8" fill="#0090ff"/>')
for (m, n), w in zip(MODES, widths):
    hx, _ = mode_x[m]
    cy = TB_Y + 18
    tb.append(mode_icon(m, hx + 16, cy))
    tb.append(f'<text x="{hx + 30}" y="{cy + 4.5}" class="t" font-size="12.5" fill="#f3f4f7">{m}</text>')
    tb.append(f'<rect x="{hx + w - 22}" y="{cy - 8}" width="15" height="16" rx="4" fill="#ffffff" opacity=".14"/>')
    tb.append(f'<text x="{hx + w - 14.5}" y="{cy + 4}" class="t" font-size="10.5" fill="#c9ceda" text-anchor="middle">{n}</text>')


def hint(id_, text, width):
    return (f'<g id="{id_}"><rect x="{480 - width / 2}" y="{TB_Y + 44}" width="{width}" height="26" rx="8" fill="#16181d" opacity=".92"/>'
            f'<text x="480" y="{TB_Y + 61}" class="t" font-size="12" fill="#e6e8ee" text-anchor="middle">{text}</text></g>')


tb.append(hint("hint1", "Drag over an area, or click a window. Enter captures.", 336))
tb.append(hint("hint2", "Drag over the text to copy it.", 200))
body.append(f'<g id="aio">{"".join(tb)}</g>')
kf("aio", [(1.2, "opacity:0;transform:translateY(-60px)"), (1.55, "opacity:1;transform:translateY(0)"),
           (3.75, "opacity:1;transform:translateY(0)"), (3.95, "opacity:0;transform:translateY(0)"),
           (12.95, "opacity:0;transform:translateY(-60px)"), (13.3, "opacity:1;transform:translateY(0)"),
           (14.55, "opacity:1;transform:translateY(0)"), (14.75, "opacity:0;transform:translateY(0)")],
   "#aio", "cubic-bezier(.2,.9,.3,1.1)")
show("#hlRegion", "hlRegion", [(0, 13.55)], fade=.15)
show("#hlText", "hlText", [(13.45, T)], fade=.15)
show("#hint1", "hint1", [(0, 13.55)], fade=.15)
show("#hint2", "hint2", [(13.45, T)], fade=.15)

# Crosshair with magnifier (Capture) and a plain one (Copy text).
body.append("""
<g id="xh">
  <path d="M0 -14v10M0 4v10M-14 0h10M4 0h10" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  <g transform="translate(26 26)">
    <circle r="30" fill="#ffffff"/>
    <clipPath id="mag"><circle r="28"/></clipPath>
    <g clip-path="url(#mag)">
      <rect x="-28" y="-28" width="56" height="56" fill="#e7ecf7"/>
      <rect x="-28" y="-6" width="56" height="34" fill="#4c8dff"/>
      <path d="M-28 -21h56M-28 -14h56M-28 -7h56M-28 0h56M-28 7h56M-28 14h56M-28 21h56M-21 -28v56M-14 -28v56M-7 -28v56M0 -28v56M7 -28v56M14 -28v56M21 -28v56" stroke="#000" stroke-opacity=".12" stroke-width="1"/>
      <rect x="-3.5" y="-3.5" width="7" height="7" fill="none" stroke="#e5484d" stroke-width="1.6"/>
    </g>
    <circle r="29" fill="none" stroke="#0090ff" stroke-width="2"/>
  </g>
</g>
<g id="xh2"><path d="M0 -14v10M0 4v10M-14 0h10M4 0h10" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
<path d="M-1 -14v10M-1 4v10M-14 -1h10M4 -1h10" stroke="#000" stroke-opacity=".35" stroke-width="1"/></g>""")
kf("xh", [(1.45, f"opacity:0;{tr(SX - 60, SY - 40)}"), (1.6, f"opacity:1;{tr(SX - 60, SY - 40)}"),
          (1.8, f"opacity:1;{tr(SX, SY)}"), (2.9, f"opacity:1;{tr(SX + SW, SY + SH)}"),
          (3.05, f"opacity:0;{tr(SX + SW, SY + SH)}")], "#xh", "ease-in-out")
kf("xh2", [(13.2, f"opacity:0;{tr(TX - 50, TY - 40)}"), (13.3, f"opacity:1;{tr(TX - 50, TY - 40)}"),
           (13.5, f"opacity:1;{tr(TX, TY)}"), (14.2, f"opacity:1;{tr(TX + TW, TY + TH)}"),
           (14.35, f"opacity:0;{tr(TX + TW, TY + TH)}")], "#xh2", "ease-in-out")

body.append('<rect id="flash" width="960" height="540" fill="#fff"/>')
kf("flash", [(3.8, "opacity:0"), (3.85, "opacity:.9"), (4.1, "opacity:0")], "#flash")

# Quick Access card.
QX, QY = 18, 352
qa_scale = 0.33
body.append(f"""
<g id="qa">
  <rect x="{QX}" y="{QY + 4}" width="216" height="142" rx="14" fill="#000" opacity=".35" filter="url(#shadow)"/>
  <rect x="{QX}" y="{QY}" width="216" height="142" rx="14" fill="#1b1e25" stroke="#2c313b"/>
  <g clip-path="url(#qaclip)"><g transform="translate({QX + 16} {QY + 14}) scale({qa_scale}) translate({-SX} {-SY})"><use href="#dash"/></g></g>
  <rect x="{QX + 16}" y="{QY + 14}" width="{SW * qa_scale:.1f}" height="{SH * qa_scale:.1f}" rx="6" fill="none" stroke="#3a404c"/>
  <g class="t b" font-size="11.5" text-anchor="middle">
    <rect x="{QX + 16}" y="{QY + 104}" width="56" height="26" rx="7" fill="#2a2f39"/><text x="{QX + 44}" y="{QY + 121}" fill="#e6e8ee">Copy</text>
    <rect x="{QX + 78}" y="{QY + 104}" width="74" height="26" rx="7" fill="#0090ff"/><text x="{QX + 115}" y="{QY + 121}" fill="#fff">Annotate</text>
    <rect x="{QX + 158}" y="{QY + 104}" width="42" height="26" rx="7" fill="#2a2f39"/><text x="{QX + 179}" y="{QY + 121}" fill="#e6e8ee">Pin</text>
  </g>
</g>""")
kf("qa", [(4.0, "opacity:0;transform:translateX(-250px)"), (4.05, "opacity:1;transform:translateX(-250px)"),
          (4.45, "opacity:1;transform:translateX(0)"), (5.45, "opacity:1;transform:translateX(0)"),
          (5.7, "opacity:0;transform:translateX(0)")], "#qa", "cubic-bezier(.2,.9,.3,1.2)")
QA_ANNOTATE = (QX + 115, QY + 117)
click(*QA_ANNOTATE, 5.1)

# =============================================================== 3. copy text ==
# A screen share in a video call: the code is pixels, so it can't be selected.
CODE = [
    [("{", "#d4d4d4")],
    [('  "release"', "#9cdcfe"), (": ", "#d4d4d4"), ('"v2.0"', "#ce9178"), (",", "#d4d4d4")],
    [('  "channel"', "#9cdcfe"), (": ", "#d4d4d4"), ('"stable"', "#ce9178"), (",", "#d4d4d4")],
    [('  "rollout"', "#9cdcfe"), (": { ", "#d4d4d4"), ('"percent"', "#9cdcfe"), (": ", "#d4d4d4"), ("25", "#b5cea8"),
     (", ", "#d4d4d4"), ('"regions"', "#9cdcfe"), (": [", "#d4d4d4"), ('"eu"', "#ce9178"), (", ", "#d4d4d4"),
     ('"us"', "#ce9178"), ("] },", "#d4d4d4")],
    [('  "notify"', "#9cdcfe"), (": [", "#d4d4d4"), ('"sam.rivera@acme.co"', "#ce9178"), ("],", "#d4d4d4")],
    [('  "freeze"', "#9cdcfe"), (": ", "#d4d4d4"), ('"2026-11-20T17:00Z"', "#ce9178")],
    [("}", "#d4d4d4")],
]
code_lines = []
for i, parts in enumerate(CODE):
    y = 136 + i * 21
    spans = "".join(f'<tspan fill="{c}">{t.replace(" ", "&#160;")}</tspan>' for t, c in parts)
    code_lines.append(f'<text x="168" y="{y + 4}" {MONO} font-size="11" fill="#5c6370" text-anchor="end">{i + 1}</text>')
    code_lines.append(f'<text x="182" y="{y + 4}" {MONO} font-size="13">{spans}</text>')
people = []
for i, (name, col) in enumerate([("Priya (presenting)", "#7b5cff"), ("Sam", "#30a46c"), ("You", "#f5a524")]):
    px = 140 + i * 150
    people.append(f'<rect x="{px}" y="452" width="140" height="26" rx="8" fill="#1b1e25"/>'
                  f'<circle cx="{px + 15}" cy="465" r="7" fill="{col}"/>'
                  f'<text x="{px + 28}" y="469.5" class="t" font-size="11.5" fill="#c9ceda">{name}</text>')
share = f"""
<g id="share">
  <rect x="112" y="40" width="736" height="452" rx="12" fill="#000" opacity=".45" filter="url(#shadow)"/>
  <rect x="112" y="36" width="736" height="452" rx="12" fill="#0b0c0f"/>
  <path d="M124 36h712a12 12 0 0 1 12 12v18H112V48a12 12 0 0 1 12-12z" fill="#202329"/>
  <circle cx="132" cy="51" r="5.5" fill="#ff5f57"/><circle cx="150" cy="51" r="5.5" fill="#febc2e"/><circle cx="168" cy="51" r="5.5" fill="#28c840"/>
  <text x="480" y="55.5" class="t" font-size="12" fill="#9aa3b2" text-anchor="middle">Weekly sync  ·  Priya is sharing her screen</text>
  <rect x="132" y="78" width="696" height="362" rx="6" fill="#1e1f24"/>
  <rect x="132" y="78" width="696" height="24" rx="6" fill="#18191d"/>
  <rect x="132" y="96" width="696" height="6" fill="#18191d"/>
  <rect x="140" y="80" width="104" height="22" fill="#1e1f24"/>
  <text x="152" y="95" class="t" font-size="11.5" fill="#e6e8ee">config.json</text>
  <rect x="132" y="102" width="44" height="338" fill="#1a1b1f"/>
  {''.join(code_lines)}
  <text x="182" y="304" {MONO} font-size="13" fill="#5c6370">// ship once the freeze lifts</text>
  {''.join(people)}
</g>"""
body.insert(1, share)  # just above the desktop, so the dim layer covers it
show("#share", "share", [(12.1, 16.6)], fade=.25)

TC_X, TC_Y = 18, 282
tidy = ["{", '  "release": "v2.0",', '  "channel": "stable",', '  "rollout": {', '    "percent": 25,',
        '    "regions": ["eu", "us"]', "  },", '  "notify": ["sam.rivera@acme.co"],', '  "freeze": "2026-11-20T17:00Z"', "}"]
tidy_lines = "".join(f'<text x="{TC_X + 16}" y="{TC_Y + 64 + i * 14.5}" {MONO} font-size="10.5" fill="#d4d4d4">{l.replace(" ", "&#160;")}</text>'
                     for i, l in enumerate(tidy))
body.append(f"""
<g id="tcard">
  <rect x="{TC_X}" y="{TC_Y + 4}" width="300" height="222" rx="14" fill="#000" opacity=".35" filter="url(#shadow)"/>
  <rect x="{TC_X}" y="{TC_Y}" width="300" height="222" rx="14" fill="#1b1e25" stroke="#2c313b"/>
  <circle cx="{TC_X + 26}" cy="{TC_Y + 25}" r="9" fill="#30a46c"/>
  <path d="M{TC_X + 21.5} {TC_Y + 25}l3 3 5-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="{TC_X + 42}" y="{TC_Y + 29.5}" class="t b" font-size="13" fill="#f3f4f7">Text copied</text>
  <g id="tidy">
    <rect x="{TC_X + 176}" y="{TC_Y + 14}" width="110" height="22" rx="11" fill="#7b5cff" opacity=".22"/>
    <text x="{TC_X + 231}" y="{TC_Y + 29}" class="t b" font-size="11" fill="#c4b5ff" text-anchor="middle">✦ Tidied by AI</text>
  </g>
  <rect x="{TC_X + 12}" y="{TC_Y + 46}" width="276" height="162" rx="8" fill="#14161b"/>
  {tidy_lines}
</g>""")
kf("tcard", [(14.75, "opacity:0;transform:translateX(-320px)"), (14.8, "opacity:1;transform:translateX(-320px)"),
             (15.2, "opacity:1;transform:translateX(0)"), (16.35, "opacity:1;transform:translateX(0)"),
             (16.6, "opacity:0;transform:translateX(0)")], "#tcard", "cubic-bezier(.2,.9,.3,1.15)")
css.append(f"#tidy{{transform-origin:{TC_X + 231}px {TC_Y + 25}px}}")
kf("tidy", [(15.35, "opacity:0;transform:scale(.6)"), (15.55, "opacity:1;transform:scale(1.12)"),
            (15.7, "opacity:1;transform:scale(1)")], "#tidy")

# ================================================================== 4. record ==
body.append("""
<g id="recframe" fill="none" stroke="#e5484d">
  <rect x="134" y="52" width="696" height="416" rx="14" stroke-width="1.6" stroke-dasharray="7 5"/>
  <path d="M134 74v-8a14 14 0 0 1 14-14h8M808 52h8a14 14 0 0 1 14 14v8M830 446v8a14 14 0 0 1-14 14h-8M156 468h-8a14 14 0 0 1-14-14v-8"
        stroke-width="3.5" stroke-linecap="round"/>
</g>""")
show("#recframe", "recframe", [(16.65, 19.15)], fade=.2)

RB_X, RB_Y, RB_W = 334, 472, 292
rec_times = "".join(f'<text id="rt{i}" x="{RB_X + 50}" y="{RB_Y + 23}" {MONO} font-size="14" font-weight="700" fill="#f3f4f7">0:0{i}</text>'
                    for i in range(3))
STOP = (RB_X + 252, RB_Y + 18)
body.append(f"""
<g id="recbar">
  <rect x="{RB_X}" y="{RB_Y + 3}" width="{RB_W}" height="36" rx="18" fill="#000" opacity=".4" filter="url(#shadow)"/>
  <rect x="{RB_X}" y="{RB_Y}" width="{RB_W}" height="36" rx="18" fill="#111317" stroke="#2c313b"/>
  <g fill="#5c6370"><circle cx="{RB_X + 16}" cy="{RB_Y + 13}" r="1.4"/><circle cx="{RB_X + 16}" cy="{RB_Y + 18}" r="1.4"/><circle cx="{RB_X + 16}" cy="{RB_Y + 23}" r="1.4"/>
  <circle cx="{RB_X + 21}" cy="{RB_Y + 13}" r="1.4"/><circle cx="{RB_X + 21}" cy="{RB_Y + 18}" r="1.4"/><circle cx="{RB_X + 21}" cy="{RB_Y + 23}" r="1.4"/></g>
  <circle id="recdot" cx="{RB_X + 37}" cy="{RB_Y + 18}" r="6" fill="#ff4b4b"/>
  {rec_times}
  <rect x="{RB_X + 94}" y="{RB_Y + 9}" width="1" height="18" fill="#3a404c"/>
  <g fill="none" stroke="#e6e8ee" stroke-width="1.6" stroke-linecap="round">
    <rect x="{RB_X + 107}" y="{RB_Y + 9}" width="7" height="12" rx="3.5"/><path d="M{RB_X + 104} {RB_Y + 17}a6.5 6.5 0 0 0 13 0M{RB_X + 110.5} {RB_Y + 24}v3"/>
  </g>
  <g fill="#7b8cff"><rect x="{RB_X + 123}" y="{RB_Y + 20}" width="3" height="6" rx="1"/><rect x="{RB_X + 128}" y="{RB_Y + 16}" width="3" height="10" rx="1"/>
  <rect x="{RB_X + 133}" y="{RB_Y + 12}" width="3" height="14" rx="1" opacity=".35"/></g>
  <g fill="#e6e8ee"><rect x="{RB_X + 150}" y="{RB_Y + 12}" width="3" height="12" rx="1"/><rect x="{RB_X + 156}" y="{RB_Y + 12}" width="3" height="12" rx="1"/></g>
  <text x="{RB_X + 166}" y="{RB_Y + 22.5}" class="t" font-size="13" fill="#e6e8ee">Pause</text>
  <rect x="{RB_X + 216}" y="{RB_Y + 4}" width="72" height="28" rx="14" fill="#ff4b4b"/>
  <rect x="{RB_X + 228}" y="{RB_Y + 13.5}" width="9" height="9" rx="2" fill="#fff"/>
  <text x="{RB_X + 243}" y="{RB_Y + 22.5}" class="t b" font-size="13" fill="#fff">Stop</text>
</g>""")
kf("recbar", [(16.6, "opacity:0;transform:translateY(40px)"), (16.95, "opacity:1;transform:translateY(0)"),
              (19.1, "opacity:1;transform:translateY(0)"), (19.35, "opacity:0;transform:translateY(0)")],
   "#recbar", "cubic-bezier(.2,.9,.3,1.15)")
show("#rt0", "rt0", [(0, 17.85)], fade=.02)
show("#rt1", "rt1", [(17.85, 18.85)], fade=.02)
show("#rt2", "rt2", [(18.85, T)], fade=.02)
kf("recdot", [(17.0, "opacity:1"), (17.4, "opacity:.25"), (17.8, "opacity:1"), (18.2, "opacity:.25"), (18.6, "opacity:1"),
              (19.0, "opacity:.25")], "#recdot", "ease-in-out")
click(627, 334, 18.2, "#f5a524")
click(*STOP, 18.95)

# ================================================================ 2. mark it up =
# Annotations are in desktop coordinates; the editor shows the capture scaled.
K = 1.3
CX, CY = 156, 118


def ed(x, y):
    """Desktop coordinates -> editor coordinates."""
    return CX + (x - SX) * K, CY + (y - SY) * K


TOOLS = ["arrow", "rect", "step", "blur", "text", "backdrop"]
RAIL_Y0, RAIL_STEP = 70, 46


def tool_icon(name, cx, cy):
    s = 'fill="none" stroke="#c9ceda" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    if name == "arrow":
        return f'<path {s} d="M{cx-8} {cy+8}L{cx+7} {cy-7}M{cx-1} {cy-8}h9v9"/>'
    if name == "rect":
        return f'<rect {s} x="{cx-9}" y="{cy-7}" width="18" height="14" rx="3"/>'
    if name == "step":
        return (f'<circle cx="{cx}" cy="{cy}" r="9" fill="#c9ceda"/>'
                f'<text x="{cx}" y="{cy+4.5}" class="t b" font-size="12" fill="#1b1e25" text-anchor="middle">1</text>')
    if name == "blur":
        out = []
        for i in range(3):
            for j in range(3):
                op = [".9", ".45", ".7"][(i + j) % 3]
                out.append(f'<rect x="{cx-9+i*6}" y="{cy-9+j*6}" width="6" height="6" fill="#c9ceda" opacity="{op}"/>')
        return "".join(out)
    if name == "text":
        return f'<text x="{cx}" y="{cy+6}" class="t b" font-size="18" fill="#c9ceda" text-anchor="middle">T</text>'
    return (f'<rect x="{cx-10}" y="{cy-9}" width="20" height="18" rx="4" fill="url(#bd)"/>'
            f'<rect x="{cx-5}" y="{cy-4}" width="10" height="8" rx="1.5" fill="#fff"/>')


rail = "".join(tool_icon(t, 32, RAIL_Y0 + i * RAIL_STEP) for i, t in enumerate(TOOLS))
AR_START, AR_C, AR_END = (468, 168), (548, 196), (566, 312)


def qlen(p0, p1, p2, n=200):
    L, prev = 0, p0
    for i in range(1, n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        L += math.dist(prev, (x, y))
        prev = (x, y)
    return L


arrow_len = qlen(AR_START, AR_C, AR_END)
ang = math.atan2(AR_END[1] - AR_C[1], AR_END[0] - AR_C[0])


def head(p, a, size=13):
    l = (p[0] - size * math.cos(a - .45), p[1] - size * math.sin(a - .45))
    r = (p[0] - size * math.cos(a + .45), p[1] - size * math.sin(a + .45))
    return f"M{l[0]:.1f} {l[1]:.1f}L{p[0]} {p[1]}L{r[0]:.1f} {r[1]:.1f}"


RX, RY, RW, RH = 270, 188, 182, 40
rect_len = 2 * (RW + RH)
random.seed(7)
blur_blocks = []
for i in range(13):
    for j in range(2):
        g = random.choice(["#d4dae6", "#c3cbdb", "#e3e7ef", "#b8c2d6", "#cdd4e2"])
        blur_blocks.append(f'<rect x="{574 + i * 16}" y="{214 + j * 14}" width="16" height="14" fill="{g}"/>')

annotations = f"""
<g id="annots" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <g id="blur" stroke="none">{''.join(blur_blocks)}</g>
  <rect id="a-rect" x="{RX}" y="{RY}" width="{RW}" height="{RH}" rx="8" stroke="#e5484d" stroke-width="3"
        stroke-dasharray="{rect_len:.0f}" stroke-dashoffset="{rect_len:.0f}"/>
  <path id="a-arrow" d="M{AR_START[0]} {AR_START[1]}Q{AR_C[0]} {AR_C[1]} {AR_END[0]} {AR_END[1]}" stroke="#e5484d" stroke-width="4"
        stroke-dasharray="{arrow_len:.0f}" stroke-dashoffset="{arrow_len:.0f}"/>
  <path id="a-head" d="{head(AR_END, ang)}" stroke="#e5484d" stroke-width="4"/>
  <g id="s1" stroke="none"><circle cx="{RX}" cy="{RY}" r="12" fill="#e5484d" stroke="#fff" stroke-width="2"/>
    <text x="{RX}" y="{RY + 4.5}" class="t b" font-size="13" fill="#fff" text-anchor="middle">1</text></g>
  <g id="s2" stroke="none"><circle cx="696" cy="334" r="12" fill="#e5484d" stroke="#fff" stroke-width="2"/>
    <text x="696" y="338.5" class="t b" font-size="13" fill="#fff" text-anchor="middle">2</text></g>
  <g id="a-text" stroke="none">
    <rect x="586" y="250" width="132" height="32" rx="7" fill="#fff3a8"/>
    <text x="652" y="272" class="t b" font-size="15" fill="#e5484d" text-anchor="middle">Ship it today!</text>
  </g>
</g>"""

cap_w, cap_h = SW * K, SH * K
mid = (CX + cap_w / 2, CY + cap_h / 2)
BD_SCALE = 0.8
bw, bh = cap_w * BD_SCALE + 84, cap_h * BD_SCALE + 84
COPY_BTN = (845, 20)
body.append(f"""
<g id="ed">
  <rect width="960" height="540" fill="#14161b"/>
  <rect x="64" y="40" width="896" height="500" fill="url(#dots)"/>
  <rect width="960" height="40" fill="#1b1e25"/>
  <rect y="39" width="960" height="1" fill="#2c313b"/>
  {logo(22, 20, .78, "#4c8dff")}
  <text x="40" y="25" class="t" font-size="12.5" fill="#c9ceda">Grab-it 2026-11-15 09-41-07.png</text>
  <g class="t b" font-size="12" text-anchor="middle">
    <rect x="752" y="8" width="54" height="24" rx="7" fill="#2a2f39"/><text x="779" y="24" fill="#e6e8ee">Pin</text>
    <rect id="copybtn" x="812" y="8" width="66" height="24" rx="7" fill="#0090ff"/><text x="845" y="24" fill="#fff">Copy</text>
    <rect x="884" y="8" width="64" height="24" rx="7" fill="#2a2f39"/><text x="916" y="24" fill="#e6e8ee">Export</text>
  </g>
  <rect y="40" width="64" height="500" fill="#1b1e25"/>
  <rect x="63" y="40" width="1" height="500" fill="#2c313b"/>
  <rect id="railsel" x="12" y="{RAIL_Y0 - 20}" width="40" height="40" rx="10" fill="#0090ff"/>
  {rail}
  <g id="bdwrap">
    <rect x="{mid[0] - bw / 2:.1f}" y="{mid[1] - bh / 2:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="18" fill="url(#bd)"/>
  </g>
  <g id="capwrap">
    <rect id="capshadow" x="{CX}" y="{CY + 10}" width="{cap_w:.1f}" height="{cap_h:.1f}" rx="12" fill="#000" opacity=".5" filter="url(#shadow)"/>
    <g clip-path="url(#capclip)">
      <g transform="translate({CX} {CY}) scale({K}) translate({-SX} {-SY})">
        <use href="#dash"/>
        {annotations}
      </g>
    </g>
  </g>
  <g id="toast">
    <rect x="356" y="56" width="248" height="38" rx="19" fill="#1f2328" stroke="#3a404c"/>
    <circle cx="382" cy="75" r="10" fill="#30a46c"/>
    <path d="M377 75l3.5 3.5 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="400" y="80" class="t b" font-size="13.5" fill="#fff">Copied. Paste it anywhere</text>
  </g>
</g>""")
kf("ed", [(5.5, "opacity:0"), (5.7, "opacity:1"), (12.2, "opacity:1"), (12.4, "opacity:0")], "#ed")

# When each tool is picked on the rail.
PICK = {"arrow": 5.7, "rect": 6.75, "step": 7.35, "blur": 7.95, "text": 8.6, "backdrop": 9.45}
frames, prev = [], 0
for i, t in enumerate(TOOLS):
    frames += [(PICK[t] - .15, f"transform:translateY({prev}px)"), (PICK[t], f"transform:translateY({i * RAIL_STEP}px)")]
    prev = i * RAIL_STEP
kf("railsel", frames, "#railsel", "cubic-bezier(.3,1.4,.5,1)")


def draw(sel, name, length, a, b):
    kf(name, [(a, f"stroke-dashoffset:{length:.0f}"), (b, "stroke-dashoffset:0")], sel, "ease-in-out")


def pop(sel, name, at, origin, rot=0):
    css.append(f"{sel}{{transform-origin:{origin[0]}px {origin[1]}px}}")
    r = f" rotate({rot}deg)" if rot else ""
    kf(name, [(at, f"opacity:0;transform:scale(0){r}"), (at + .18, f"opacity:1;transform:scale(1.25){r}"),
              (at + .32, f"opacity:1;transform:scale(1){r}")], sel)


draw("#a-arrow", "arrow", arrow_len, 5.95, 6.55)
kf("ahead", [(6.5, "opacity:0"), (6.58, "opacity:1")], "#a-head")
draw("#a-rect", "rect", rect_len, 6.85, 7.3)
pop("#s1", "s1", 7.45, (RX, RY))
pop("#s2", "s2", 7.8, (696, 334))
css.append("#blur{transform-origin:574px 214px}")
kf("blur", [(8.05, "opacity:1;transform:scaleX(0)"), (8.5, "opacity:1;transform:scaleX(1)")], "#blur", "ease-in-out")
pop("#a-text", "atext", 8.75, (652, 266), rot=-3)

css.append(f"#capwrap,#bdwrap{{transform-origin:{mid[0]:.1f}px {mid[1]:.1f}px}}")
kf("capwrap", [(9.55, "transform:scale(1)"), (10.0, f"transform:scale({BD_SCALE})")], "#capwrap", "cubic-bezier(.3,1.3,.5,1)")
kf("bdwrap", [(9.6, "opacity:0;transform:scale(.9)"), (10.05, "opacity:1;transform:scale(1)")], "#bdwrap", "cubic-bezier(.3,1.3,.5,1)")
kf("capshadow", [(9.6, "opacity:0"), (10.05, "opacity:1")], "#capshadow")
kf("toast", [(10.7, "opacity:0;transform:translateY(-30px)"), (11.0, "opacity:1;transform:translateY(0)")],
   "#toast", "cubic-bezier(.2,1.4,.4,1)")
css.append("#copybtn{transform-origin:845px 20px}")
kf("copybtn", [(10.55, "transform:scale(1)"), (10.62, "transform:scale(.88)"), (10.75, "transform:scale(1.08)"),
               (10.85, "transform:scale(1)")], "#copybtn")
click(*COPY_BTN, 10.6)

# ============================================================ 4b. video editor ==
VX, VY, KV = 244, 104, 472 / 684  # where the recording sits in the preview, and its scale
VW, VH = 472, 404 * KV
BX0, BY0, BX1, BY1 = VX - 30, VY - 26, VX + VW + 30, VY + VH + 26
TL0, TL1, TL_Y = 190, 930, 446
TRIM = 248
ZS0, ZS1 = 440, 760
PLAY = (36, TL_Y + 12)
EXPORT = (904, 49)
PB0, PB1 = 20.55, 22.75  # playback: playhead from TRIM to TL1


def at_x(x):
    return PB0 + (x - TRIM) / (TL1 - TRIM) * (PB1 - PB0)


SHIP = (VX + (627 - 140) * KV, VY + (334 - 58) * KV)
times = [("0:00.4", 0, PB0 + .3), ("0:01.0", PB0 + .3, PB0 + .8), ("0:01.8", PB0 + .8, PB0 + 1.3),
         ("0:02.6", PB0 + 1.3, PB0 + 1.8), ("0:03.4", PB0 + 1.8, PB1), ("0:04.0", PB1, T)]
time_txt = "".join(f'<text id="vt{i}" x="58" y="{TL_Y + 16.5}" {MONO} font-size="11.5" fill="#c9ceda">{t}<tspan fill="#6b7280"> / 0:04.0</tspan></text>'
                   for i, (t, _, _) in enumerate(times))
body.append(f"""
<g id="ve">
  <rect width="960" height="540" fill="#0f1115"/>
  <rect width="960" height="30" fill="#1b1e25"/>
  {logo(18, 15, .66, "#4c8dff")}
  <text x="480" y="19.5" class="t" font-size="12" fill="#9aa3b2" text-anchor="middle">Grab-it 2026-11-15 09-41-12.mp4 – Recording Editor</text>
  <rect y="30" width="960" height="38" fill="#16181d"/>
  <rect y="67" width="960" height="1" fill="#2c313b"/>
  <g fill="none" stroke="#e6e8ee" stroke-width="1.5"><rect x="18" y="42" width="14" height="13" rx="3"/><rect x="21.5" y="45.5" width="7" height="6" rx="1"/></g>
  <text x="40" y="53.5" class="t" font-size="12.5" fill="#e6e8ee">Backdrop</text><circle cx="100" cy="49" r="3" fill="#4c8dff"/>
  <rect x="114" y="38" width="1" height="22" fill="#2c313b"/>
  <g fill="none" stroke="#e6e8ee" stroke-width="1.5" stroke-linecap="round"><circle cx="133" cy="48" r="5.5"/><path d="M137 52l4 4M130.5 48h5M133 45.5v5"/></g>
  <text x="147" y="53.5" class="t" font-size="12.5" fill="#e6e8ee">Zoom</text>
  <g id="zoomctl">
    <rect x="196" y="38" width="1" height="22" fill="#2c313b"/>
    <rect x="210" y="38" width="128" height="22" rx="6" fill="#23262d"/>
    <rect x="212" y="40" width="54" height="18" rx="5" fill="#2f3440"/>
    <text x="239" y="53" class="t" font-size="11" fill="#9aa3b2" text-anchor="middle">Area</text>
    <rect x="266" y="40" width="70" height="18" rx="5" fill="#6e56cf"/>
    <text x="301" y="53" class="t b" font-size="11" fill="#fff" text-anchor="middle">Follow cursor</text>
    <text x="352" y="53" class="t" font-size="11.5" fill="#9aa3b2">Scale</text>
    <rect x="388" y="47" width="90" height="4" rx="2" fill="#2f3440"/><rect x="388" y="47" width="30" height="4" rx="2" fill="#6e56cf"/>
    <circle cx="418" cy="49" r="6" fill="#fff"/>
    <text x="488" y="53" class="t b" font-size="11.5" fill="#e6e8ee">2×</text>
  </g>
  <rect id="exportbtn" x="864" y="37" width="80" height="24" rx="7" fill="#0090ff"/>
  <text x="904" y="53.5" class="t b" font-size="12.5" fill="#fff" text-anchor="middle">Export</text>
  <rect x="{BX0}" y="{BY0}" width="{BX1 - BX0}" height="{BY1 - BY0}" rx="4" fill="url(#bd2)"/>
  <rect x="{VX}" y="{VY + 8}" width="{VW}" height="{VH:.1f}" rx="10" fill="#000" opacity=".45" filter="url(#shadow)"/>
  <g clip-path="url(#vclip)">
    <g id="vzoom">
      <g transform="translate({VX} {VY}) scale({KV:.4f}) translate(-140 -58)">
        <use href="#dash"/>
        <circle id="vring" cx="627" cy="334" r="22" fill="none" stroke="#f5a524" stroke-width="4"/>
        <g id="vcur"><path d="M0 0v21l5.2-5 3.6 8.4 3.8-1.6-3.6-8.2H16z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></g>
      </g>
    </g>
  </g>
  <rect y="430" width="960" height="86" fill="#14161b"/>
  <rect y="430" width="960" height="1" fill="#2c313b"/>
  <circle cx="{PLAY[0]}" cy="{PLAY[1]}" r="13" fill="#23262d"/>
  <path id="playico" d="M{PLAY[0] - 4} {PLAY[1] - 6}v12l10-6z" fill="#e6e8ee"/>
  <g id="pauseico" fill="#e6e8ee"><rect x="{PLAY[0] - 5}" y="{PLAY[1] - 6}" width="3.5" height="12" rx="1"/><rect x="{PLAY[0] + 1.5}" y="{PLAY[1] - 6}" width="3.5" height="12" rx="1"/></g>
  {time_txt}
  <rect x="{TL0}" y="{TL_Y}" width="{TL1 - TL0}" height="24" rx="6" fill="#262c3b" stroke="#4c8dff" stroke-width="1.5"/>
  <g fill="#3a4560">{''.join(f'<rect x="{x}" y="{TL_Y + 8}" width="2" height="8" rx="1"/>' for x in range(TL0 + 30, TL1 - 10, 38))}</g>
  <rect id="trimdim" x="{TL0}" y="{TL_Y}" width="{TRIM - TL0}" height="24" rx="6" fill="#05070c" opacity=".7"/>
  <g id="lhandle"><rect x="{TL0}" y="{TL_Y - 2}" width="10" height="28" rx="3" fill="#4c8dff"/><rect x="{TL0 + 4}" y="{TL_Y + 7}" width="2" height="10" rx="1" fill="#fff"/></g>
  <rect x="{TL1 - 10}" y="{TL_Y - 2}" width="10" height="28" rx="3" fill="#4c8dff"/><rect x="{TL1 - 6}" y="{TL_Y + 7}" width="2" height="10" rx="1" fill="#fff"/>
  <rect x="{ZS0}" y="{TL_Y + 32}" width="{ZS1 - ZS0}" height="20" rx="6" fill="#6e56cf"/>
  <text x="{(ZS0 + ZS1) / 2}" y="{TL_Y + 46}" class="t b" font-size="11" fill="#fff" text-anchor="middle">2× Cursor</text>
  <rect id="playhead" x="{TRIM - 1}" y="{TL_Y - 7}" width="2" height="38" rx="1" fill="#fff"/>
  <rect id="exprog" x="{TL0}" y="{TL_Y + 58}" width="{TL1 - TL0}" height="3" rx="1.5" fill="#4c8dff"/>
  <rect y="516" width="960" height="24" fill="#1b1e25"/>
  <text x="16" y="532" class="t" font-size="11.5" fill="#9aa3b2">Grab-it 2026-11-15 09-41-12.mp4</text>
  <text id="clip0" x="236" y="532" class="t" font-size="11.5" fill="#9aa3b2">Clip 0:04.0</text>
  <text id="clip1" x="236" y="532" class="t" font-size="11.5" fill="#9aa3b2">Clip 0:03.7</text>
  <text x="316" y="532" class="t" font-size="11.5" fill="#9aa3b2">Output 1920×1080</text>
  <text id="st0" x="944" y="532" class="t" font-size="11.5" fill="#9aa3b2" text-anchor="end">Edits saved</text>
  <text id="st1" x="944" y="532" class="t" font-size="11.5" fill="#9aa3b2" text-anchor="end">Exporting… 64%</text>
  <text id="st2" x="944" y="532" class="t b" font-size="11.5" fill="#3ddc97" text-anchor="end">Exported  ·  Grab-it 2026-11-15 09-41-12 (edited).mp4</text>
</g>""")
kf("ve", [(19.3, "opacity:0"), (19.5, "opacity:1"), (23.99, "opacity:1"), (24.0, "opacity:0")], "#ve")
show("#zoomctl", "zoomctl", [(at_x(ZS0), at_x(ZS1) + .3)], fade=.15)
for i, (_, a, b) in enumerate(times):
    show(f"#vt{i}", f"vt{i}", [(a, b)], fade=.02)
show("#playico", "playico", [(0, PB0), (PB1, T)], fade=.02)
show("#pauseico", "pauseico", [(PB0, PB1)], fade=.02)
TRIM_A, TRIM_B = 19.85, 20.25
kf("lhandle", [(TRIM_A, f"transform:translateX({TL0 - TRIM}px)"), (TRIM_B, "transform:translateX(0)")], "#lhandle", "ease-in-out")
css.append(f"#trimdim{{transform-origin:{TL0}px 0}}")
kf("trimdim", [(TRIM_A, "transform:scaleX(0)"), (TRIM_B, "transform:scaleX(1)")], "#trimdim", "ease-in-out")
kf("playhead", [(TRIM_A, f"transform:translateX({TL0 - TRIM}px)"), (TRIM_B, "transform:translateX(0)"),
                (PB0, "transform:translateX(0)"), (PB1, f"transform:translateX({TL1 - TRIM}px)")], "#playhead", "linear")
show("#clip0", "clip0", [(0, TRIM_B)], fade=.02)
show("#clip1", "clip1", [(TRIM_B, T)], fade=.02)
z0, z1 = at_x(ZS0), at_x(ZS1)
css.append(f"#vzoom{{transform-origin:{SHIP[0]:.1f}px {SHIP[1]:.1f}px}}")
kf("vzoom", [(z0, "transform:scale(1)"), (z0 + .35, "transform:scale(2)"), (z1 - .35, "transform:scale(2)"),
             (z1, "transform:scale(1)")], "#vzoom", "ease-in-out")
kf("vcur", [(PB0, f"opacity:1;{tr(500, 236)}"), (PB0 + .75, f"opacity:1;{tr(627, 334)}")], "#vcur", "cubic-bezier(.45,0,.3,1)")
vclick = PB0 + .95
css.append("#vring{transform-origin:627px 334px}")
kf("vring", [(vclick - .02, "opacity:0;transform:scale(.4)"), (vclick + .04, "opacity:1;transform:scale(.5)"),
             (vclick + .6, "opacity:0;transform:scale(1.6)")], "#vring")
click(*PLAY, 20.5)
click(*EXPORT, 23.05)
css.append(f"#exprog{{transform-origin:{TL0}px 0}}")
kf("exprog", [(23.1, "opacity:1;transform:scaleX(0)"), (23.5, "opacity:1;transform:scaleX(1)"), (23.6, "opacity:0;transform:scaleX(1)")],
   "#exprog", "ease-in-out")
show("#st0", "st0", [(0, 23.1)], fade=.02)
show("#st1", "st1", [(23.1, 23.5)], fade=.02)
show("#st2", "st2", [(23.5, T)], fade=.05)

# ============================================================ 5. find it again ==
def tile_bg(x, y, w, h, fill):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}"/>'


def th_dash(x, y, w, h, cid):
    s = w / 684
    return (tile_bg(x, y, w, h, "#e9edf5") +
            f'<g clip-path="url(#{cid})"><g transform="translate({x} {y + (h - 404 * s) / 2:.1f}) scale({s:.4f}) translate(-140 -58)"><use href="#dash"/></g></g>')


def th_code(x, y, w, h, cid):
    out = [tile_bg(x, y, w, h, "#1e1f24"), f'<rect x="{x}" y="{y}" width="{w * .18:.0f}" height="{h}" rx="6" fill="#18191d"/>']
    random.seed(3)
    for i in range(8):
        lx = x + w * .24 + (i % 3) * 8
        cols = ["#c586c0", "#9cdcfe", "#ce9178", "#dcdcaa", "#6a9955"]
        cx = lx
        for j in range(random.randint(1, 3)):
            ww = random.randint(12, 34)
            out.append(f'<rect x="{cx:.0f}" y="{y + 12 + i * 11}" width="{ww}" height="5" rx="2" fill="{random.choice(cols)}"/>')
            cx += ww + 4
    return "".join(out)


def th_chat(x, y, w, h, cid):
    out = [tile_bg(x, y, w, h, "#ffffff"), f'<rect x="{x}" y="{y}" width="{w * .22:.0f}" height="{h}" rx="6" fill="#3f0e40"/>']
    for i, (ww, c) in enumerate([(80, "#e8e8ec"), (58, "#e8e8ec"), (96, "#e8e8ec"), (70, "#e8e8ec")]):
        yy = y + 14 + i * 22
        out.append(f'<circle cx="{x + w * .22 + 14}" cy="{yy + 4}" r="6" fill="{["#f5a524", "#30a46c", "#4c8dff", "#e5484d"][i]}"/>')
        out.append(f'<rect x="{x + w * .22 + 26}" y="{yy - 2}" width="34" height="5" rx="2" fill="#1f2328"/>')
        out.append(f'<rect x="{x + w * .22 + 26}" y="{yy + 6}" width="{ww}" height="5" rx="2" fill="{c}"/>')
    return "".join(out)


def th_receipt(x, y, w, h, cid, big=False):
    k = w / 164
    dx, dw = x + w * .2, w * .6
    out = [tile_bg(x, y, w, h, "#e8ebf0"),
           f'<rect x="{dx:.1f}" y="{y + 8 * k:.1f}" width="{dw:.1f}" height="{h - 8 * k:.1f}" rx="{2 * k:.1f}" fill="#fff"/>',
           f'<text x="{dx + 8 * k:.1f}" y="{y + 22 * k:.1f}" class="t b" font-size="{8.5 * k:.1f}" fill="#1f2328">INVOICE</text>',
           f'<text x="{dx + dw - 8 * k:.1f}" y="{y + 22 * k:.1f}" class="t b" font-size="{6 * k:.1f}" fill="#4c8dff" text-anchor="end">ACME Cloud</text>',
           f'<text x="{dx + 8 * k:.1f}" y="{y + 31 * k:.1f}" class="t" font-size="{5 * k:.1f}" fill="#6b7280">INV-2026-0312 · March 2026</text>']
    for i, (l, r) in enumerate([("Compute", "$860.00"), ("Storage", "$312.00"), ("Support", "$112.00")]):
        yy = y + (44 + i * 10) * k
        out.append(f'<text x="{dx + 8 * k:.1f}" y="{yy:.1f}" class="t" font-size="{5.2 * k:.1f}" fill="#4b5563">{l}</text>')
        out.append(f'<text x="{dx + dw - 8 * k:.1f}" y="{yy:.1f}" class="t" font-size="{5.2 * k:.1f}" fill="#4b5563" text-anchor="end">{r}</text>')
    out.append(f'<rect x="{dx + 8 * k:.1f}" y="{y + 75 * k:.1f}" width="{dw - 16 * k:.1f}" height="{.8 * k:.1f}" fill="#d6dae3"/>')
    out.append(f'<text x="{dx + 8 * k:.1f}" y="{y + 86 * k:.1f}" class="t b" font-size="{6 * k:.1f}" fill="#1f2328">Total</text>')
    out.append(f'<text x="{dx + dw - 8 * k:.1f}" y="{y + 86 * k:.1f}" class="t b" font-size="{6 * k:.1f}" fill="#1f2328" text-anchor="end">$1,284.00</text>')
    return f'<g clip-path="url(#{cid})">{"".join(out)}</g>'


def th_figma(x, y, w, h, cid):
    return (tile_bg(x, y, w, h, "#2c2c2c") +
            f'<rect x="{x + 30}" y="{y + 14}" width="{w - 60}" height="{h - 28}" rx="3" fill="#fff"/>'
            f'<rect x="{x + 40}" y="{y + 24}" width="44" height="8" rx="3" fill="#1f2328"/>'
            f'<rect x="{x + 40}" y="{y + 38}" width="84" height="5" rx="2" fill="#d6dae3"/>'
            f'<rect x="{x + 40}" y="{y + 47}" width="64" height="5" rx="2" fill="#d6dae3"/>'
            f'<rect x="{x + 40}" y="{y + 62}" width="50" height="14" rx="7" fill="#7b5cff"/>'
            f'<rect x="{x + 28}" y="{y + 12}" width="{w - 56}" height="{h - 24}" rx="3" fill="none" stroke="#0d99ff" stroke-width="1.2"/>')


def th_term(x, y, w, h, cid):
    out = [tile_bg(x, y, w, h, "#0b0d10")]
    lines = [("$ npm run build", "#e6e8ee"), ("vite v6.2 building…", "#8b93a1"), ("✓ 412 modules", "#3ddc97"),
             ("dist/index.js  84 kB", "#8b93a1"), ("built in 1.9s", "#3ddc97")]
    for i, (t, c) in enumerate(lines):
        out.append(f'<text x="{x + 10}" y="{y + 18 + i * 15}" {MONO} font-size="8.5" fill="{c}">{t}</text>')
    return "".join(out)


def th_rec(x, y, w, h, cid):
    return (th_dash(x, y, w, h, cid) + f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="#000" opacity=".35"/>'
            f'<circle cx="{x + w / 2}" cy="{y + h / 2}" r="15" fill="#fff" opacity=".92"/>'
            f'<path d="M{x + w / 2 - 4} {y + h / 2 - 7}v14l11-7z" fill="#1f2328"/>'
            f'<rect x="{x + w - 40}" y="{y + h - 22}" width="32" height="15" rx="5" fill="#000" opacity=".7"/>'
            f'<text x="{x + w - 24}" y="{y + h - 11}" class="t b" font-size="9.5" fill="#fff" text-anchor="middle">0:04</text>')


def th_error(x, y, w, h, cid):
    return (tile_bg(x, y, w, h, "#d9dde6") +
            f'<rect x="{x + 26}" y="{y + 18}" width="{w - 52}" height="{h - 36}" rx="6" fill="#fff"/>'
            f'<circle cx="{x + 44}" cy="{y + 40}" r="9" fill="#e5484d"/>'
            f'<text x="{x + 44}" y="{y + 44.5}" class="t b" font-size="12" fill="#fff" text-anchor="middle">!</text>'
            f'<rect x="{x + 60}" y="{y + 34}" width="62" height="6" rx="3" fill="#1f2328"/>'
            f'<rect x="{x + 60}" y="{y + 45}" width="48" height="5" rx="2.5" fill="#c3cbdb"/>'
            f'<rect x="{x + w - 74}" y="{y + 62}" width="40" height="14" rx="4" fill="#4c8dff"/>')


GX0, GY0, TWD, THT, GAPX, ROWH = 224, 136, 164, 104, 14, 164
TILES = [(th_dash, "Launch dashboard", "Chrome · 9:41"), (th_code, "release.ts", "Code · 9:30"),
         (th_chat, "#launch", "Slack · 9:12"), (th_rec, "Recording", "Grab-it · 9:43"),
         (th_receipt, "Billing · ACME Cloud", "Chrome · Yesterday"), (th_figma, "Onboarding flow", "Figma · Yesterday"),
         (th_term, "npm run build", "Terminal · Yesterday"), (th_error, "Couldn't sync", "Settings · Monday")]
MATCH = 4
tiles = []
tile_clips = []
for i, (fn, title, meta) in enumerate(TILES):
    x = GX0 + (i % 4) * (TWD + GAPX)
    y = GY0 + (i // 4) * ROWH
    cid = f"tc{i}"
    tile_clips.append(f'<clipPath id="{cid}"><rect x="{x}" y="{y}" width="{TWD}" height="{THT}" rx="6"/></clipPath>')
    extra = ""
    if i == MATCH:
        extra = f"""<g id="snip">
  <text x="{x}" y="{y + THT + 34}" class="t" font-size="10.5" fill="#8b93a1">Text in image:</text>
  <rect x="{x + 70}" y="{y + THT + 24}" width="40" height="14" rx="3" fill="#4c8dff" opacity=".35"/>
  <text x="{x + 72}" y="{y + THT + 34}" class="t" font-size="10.5" fill="#e6e8ee">Invoice INV-2026-0312</text>
  <rect x="{x}" y="{y + THT + 42}" width="62" height="17" rx="8.5" fill="#30a46c" opacity=".2"/>
  <text x="{x + 31}" y="{y + THT + 54}" class="t" font-size="10.5" fill="#7ee2b0" text-anchor="middle">receipt ✦</text>
  <rect x="{x + 68}" y="{y + THT + 42}" width="52" height="17" rx="8.5" fill="#4c8dff" opacity=".2"/>
  <text x="{x + 94}" y="{y + THT + 54}" class="t" font-size="10.5" fill="#9cc0ff" text-anchor="middle">acme ✦</text>
</g>"""
    tiles.append(f"""<g id="tile{i}">
  <g clip-path="url(#{cid})">{fn(x, y, TWD, THT, cid)}</g>
  <rect x="{x}" y="{y}" width="{TWD}" height="{THT}" rx="6" fill="none" stroke="#2c313b"/>
  <text x="{x}" y="{y + THT + 18}" class="t b" font-size="12" fill="#e6e8ee">{title}</text>
  <text id="meta{i}" x="{x}" y="{y + THT + 34}" class="t" font-size="10.5" fill="#8b93a1">{meta}</text>
  {extra}
</g>""")


def side_item(y, label, count, icon_col, sel=False):
    bg = f'<rect x="10" y="{y - 15}" width="180" height="28" rx="7" fill="#23262d"/>' if sel else ""
    return (bg + f'<circle cx="28" cy="{y - 1}" r="5" fill="{icon_col}"/>'
            f'<text x="42" y="{y + 3.5}" class="t" font-size="12.5" fill="#e6e8ee">{label}</text>'
            f'<text x="178" y="{y + 3.5}" class="t" font-size="11.5" fill="#6b7280" text-anchor="end">{count}</text>')


side = [side_item(64, "All captures", "248", "#4c8dff", True), side_item(94, "Recordings", "12", "#e5484d"),
        '<text x="20" y="134" class="t b" font-size="10.5" fill="#6b7280" letter-spacing=".6">APPS</text>',
        side_item(158, "Chrome", "96", "#f5a524"), side_item(186, "Figma", "41", "#a56bff"),
        side_item(214, "Terminal", "37", "#9aa3b2"), side_item(242, "Slack", "24", "#3ddc97"),
        '<text x="20" y="282" class="t b" font-size="10.5" fill="#6b7280" letter-spacing=".6">TAGS</text>',
        side_item(306, "release", "31", "#4c8dff"), side_item(334, "bug", "18", "#e5484d"),
        side_item(362, "receipt ✦", "9", "#30a46c"), side_item(390, "design", "7", "#a56bff")]

QUERY = "invoice"
TYPE_A = 24.6
typed = "".join(f'<text id="q{i}" x="502" y="42" class="t" font-size="13" fill="#f3f4f7">{QUERY[:i + 1]}</text>'
                for i in range(len(QUERY)))

panel = f"""<g id="panel">
  <rect x="600" y="64" width="360" height="476" fill="#16181d"/>
  <rect x="600" y="64" width="1" height="476" fill="#2c313b"/>
  <rect x="600" y="64" width="360" height="1" fill="#2c313b"/>
  <text x="620" y="90" class="t b" font-size="14" fill="#f3f4f7">Billing · ACME Cloud</text>
  <text x="620" y="107" class="t" font-size="11" fill="#8b93a1">Chrome · Yesterday at 16:02 · 1440 × 900</text>
  <path d="M928 80l10 10M938 80l-10 10" stroke="#8b93a1" stroke-width="1.6" stroke-linecap="round"/>
  {th_receipt(620, 118, 320, 150, "tcbig")}
  <g class="t b" font-size="11.5" text-anchor="middle">
    <rect x="620" y="278" width="58" height="26" rx="7" fill="#0090ff"/><text x="649" y="295" fill="#fff">Edit</text>
    <rect x="684" y="278" width="58" height="26" rx="7" fill="#2a2f39"/><text x="713" y="295" fill="#e6e8ee">Copy</text>
    <rect x="748" y="278" width="80" height="26" rx="7" fill="#2a2f39"/><text x="788" y="295" fill="#e6e8ee">Copy text</text>
    <rect x="834" y="278" width="46" height="26" rx="7" fill="#2a2f39"/><text x="857" y="295" fill="#e6e8ee">Pin</text>
  </g>
  <text x="620" y="330" class="t" font-size="11" fill="#8b93a1">Category</text>
  <text x="700" y="330" class="t b" font-size="11.5" fill="#e6e8ee">Receipt</text>
  <text x="620" y="356" class="t" font-size="11" fill="#8b93a1">Description <tspan fill="#c4b5ff">✦</tspan></text>
  <text x="620" y="376" class="t" font-size="12" fill="#e6e8ee">An ACME Cloud invoice for March 2026 with</text>
  <text x="620" y="393" class="t" font-size="12" fill="#e6e8ee">three line items, $1,284.00 in total.</text>
  <text x="620" y="422" class="t" font-size="11" fill="#8b93a1">Tags</text>
  <rect x="620" y="430" width="66" height="20" rx="10" fill="#30a46c" opacity=".2"/>
  <text x="653" y="444" class="t" font-size="11" fill="#7ee2b0" text-anchor="middle">receipt ✦</text>
  <rect x="692" y="430" width="56" height="20" rx="10" fill="#4c8dff" opacity=".2"/>
  <text x="720" y="444" class="t" font-size="11" fill="#9cc0ff" text-anchor="middle">acme ✦</text>
  <rect x="754" y="430" width="64" height="20" rx="10" fill="#f5a524" opacity=".2"/>
  <text x="786" y="444" class="t" font-size="11" fill="#ffd38a" text-anchor="middle">expenses</text>
  <text x="620" y="476" class="t" font-size="11" fill="#8b93a1">Notes</text>
  <rect x="620" y="484" width="320" height="30" rx="7" fill="#1f2228" stroke="#2c313b"/>
  <text x="630" y="503" class="t" font-size="12" fill="#e6e8ee">Expense before Friday</text>
</g>"""

body.append(f"""
<g id="lib">
  <rect width="960" height="540" fill="#111317"/>
  <rect width="200" height="540" fill="#16181d"/>
  <rect x="199" width="1" height="540" fill="#2c313b"/>
  <circle cx="22" cy="22" r="5.5" fill="#ff5f57"/><circle cx="40" cy="22" r="5.5" fill="#febc2e"/><circle cx="58" cy="22" r="5.5" fill="#28c840"/>
  {''.join(side)}
  <rect x="10" y="488" width="180" height="1" fill="#2c313b"/>
  <text x="20" y="514" class="t" font-size="12" fill="#9aa3b2">Settings</text>
  <text x="224" y="44" class="t b" font-size="18" fill="#f3f4f7">All captures</text>
  <text id="cnt0" x="342" y="44" class="t" font-size="13" fill="#6b7280">248</text>
  <text id="cnt1" x="342" y="44" class="t" font-size="13" fill="#6b7280">1 result</text>
  <rect id="search" x="476" y="22" width="300" height="30" rx="8" fill="#1b1e25" stroke="#2c313b"/>
  <rect id="searchfocus" x="476" y="22" width="300" height="30" rx="8" fill="none" stroke="#4c8dff" stroke-width="1.5"/>
  <g fill="none" stroke="#8b93a1" stroke-width="1.5" stroke-linecap="round"><circle cx="490" cy="36" r="5"/><path d="M494 40l4 4"/></g>
  <text id="ph" x="502" y="42" class="t" font-size="13" fill="#6b7280">Search text, tags, apps…</text>
  {typed}
  <rect x="788" y="22" width="152" height="30" rx="8" fill="#5b7cfa"/>
  <path d="M802 33v-4h4M816 29h4v4M820 41v4h-4M806 45h-4v-4" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
  <text x="828" y="42" class="t b" font-size="12.5" fill="#fff">New capture</text>
  <g class="t" font-size="12" text-anchor="middle">
    <rect x="224" y="70" width="270" height="28" rx="8" fill="#16181d" stroke="#2c313b"/>
    <rect x="227" y="73" width="70" height="22" rx="6" fill="#2a2f39"/><text x="262" y="88.5" fill="#f3f4f7">Any time</text>
    <text x="330" y="88.5" fill="#9aa3b2">Today</text><text x="389" y="88.5" fill="#9aa3b2">7 days</text><text x="452" y="88.5" fill="#9aa3b2">30 days</text>
    <rect x="504" y="70" width="76" height="28" rx="8" fill="#16181d" stroke="#2c313b"/><text x="542" y="88.5" fill="#c9ceda">Filters</text>
  </g>
  <text id="sec0" x="224" y="124" class="t b" font-size="13" fill="#c9ceda">Today</text>
  <text id="sec1" x="224" y="124" class="t b" font-size="13" fill="#c9ceda">Best matches</text>
  {''.join(tiles)}
  {panel}
</g>""")
LIB_IN, LIB_OUT = 23.8, 30.25
kf("lib", [(LIB_IN, "opacity:0"), (LIB_IN + .2, "opacity:1"), (LIB_OUT - .01, "opacity:1"), (LIB_OUT, "opacity:0")], "#lib")
show("#ph", "ph", [(0, TYPE_A)], fade=.02)
for i in range(len(QUERY)):
    a = TYPE_A + i * .12
    b = TYPE_A + (i + 1) * .12 if i < len(QUERY) - 1 else T
    show(f"#q{i}", f"q{i}", [(a, b)], fade=.02)
SEARCH = (600, 37)
click(*SEARCH, 24.4, "#4c8dff")
show("#searchfocus", "searchfocus", [(24.4, T)], fade=.1)
RESULTS = TYPE_A + len(QUERY) * .12 + .1
show("#cnt0", "cnt0", [(0, RESULTS)], fade=.05)
show("#cnt1", "cnt1", [(RESULTS, T)], fade=.05)
show("#sec0", "sec0", [(0, RESULTS)], fade=.05)
show("#sec1", "sec1", [(RESULTS, T)], fade=.05)
for i in range(len(TILES)):
    if i == MATCH:
        continue
    x = GX0 + (i % 4) * (TWD + GAPX) + TWD / 2
    y = GY0 + (i // 4) * ROWH + THT / 2
    css.append(f"#tile{i}{{transform-origin:{x}px {y}px}}")
    kf(f"tile{i}", [(RESULTS + i * .03, "opacity:1;transform:scale(1)"), (RESULTS + .3 + i * .03, "opacity:0;transform:scale(.9)")],
       f"#tile{i}", "ease-in")
kf(f"tile{MATCH}", [(RESULTS + .25, "transform:translateY(0)"), (RESULTS + .65, f"transform:translateY({-ROWH}px)")],
   f"#tile{MATCH}", "cubic-bezier(.3,1.2,.5,1)")
show(f"#meta{MATCH}", "metam", [(0, RESULTS + .5)], fade=.1)
show("#snip", "snip", [(RESULTS + .55, T)], fade=.25)
MATCH_TILE = (GX0 + TWD / 2, GY0 + THT / 2)
PANEL_IN = RESULTS + 1.55
click(*MATCH_TILE, PANEL_IN - .1)
kf("panel", [(PANEL_IN, "transform:translateX(360px)"), (PANEL_IN + .4, "transform:translateX(0)")], "#panel", "cubic-bezier(.2,.9,.3,1)")

# ================================================================== end card ==
body.append("""
<g id="end">
  <rect width="960" height="540" fill="#0d1016"/>
  <circle cx="300" cy="420" r="220" fill="#7b5cff" opacity=".22" filter="url(#soft)"/>
  <circle cx="700" cy="120" r="200" fill="#4c8dff" opacity=".2" filter="url(#soft)"/>
  <g transform="translate(480 196) scale(3.4)" fill="none" stroke="url(#bd)" stroke-width="2.4" stroke-linecap="round">
    <path d="M-8 -3v-5h5M3 -8h5v5M8 3v5h-5M-3 8h-5v-5"/><circle r="2.6" fill="#7b5cff" stroke="none"/></g>
  <text x="480" y="300" class="t b" font-size="46" fill="#f3f4f7" text-anchor="middle">Grab-it</text>
  <text x="480" y="338" class="t" font-size="17" fill="#c9ceda" text-anchor="middle">Capture it, mark it up, record it, find it again.</text>
  <text x="480" y="370" class="t" font-size="13" fill="#8b93a1" text-anchor="middle">Free and open source for Windows, macOS and Linux</text>
</g>""")
END_IN = 30.0
kf("end", [(END_IN, "opacity:0"), (END_IN + .2, "opacity:1"), (T - .2, "opacity:1"), (T, "opacity:0")], "#end")

# ================================================================== cursor ====
body.append("".join(ripples))
body.append("""
<g id="cur">
  <path d="M0 0v21l5.2-5 3.6 8.4 3.8-1.6-3.6-8.2H16z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
</g>""")
HANDLE_Y = TL_Y + 12
cur = [
    (4.2, (SX + SW, SY + SH), 0), (4.3, (SX + SW, SY + SH), 1),
    (4.95, QA_ANNOTATE, 1), (5.2, QA_ANNOTATE, 1),
    (5.75, ed(*AR_START), 1), (5.95, ed(*AR_START), 1), (6.55, ed(*AR_END), 1),
    (6.8, ed(RX, RY), 1), (6.85, ed(RX, RY), 1), (7.3, ed(RX + RW, RY + RH), 1),
    (7.45, ed(RX, RY), 1), (7.8, ed(696, 334), 1),
    (8.0, ed(574, 228), 1), (8.05, ed(574, 228), 1), (8.5, ed(782, 228), 1),
    (8.75, ed(652, 266), 1), (9.1, ed(652, 266), 1),
    (9.4, (32, RAIL_Y0 + 5 * RAIL_STEP), 1), (9.55, (32, RAIL_Y0 + 5 * RAIL_STEP), 1),
    (10.45, COPY_BTN, 1), (12.0, COPY_BTN, 1), (12.3, COPY_BTN, 0),
    (14.3, (TX + TW, TY + TH), 0), (14.35, (TX + TW, TY + TH), 1),
    (16.7, (TX + TW, TY + TH), 1), (17.4, (500, 236), 1), (17.6, (500, 236), 1), (18.1, (627, 334), 1),
    (18.25, (627, 334), 1), (18.85, STOP, 1), (19.4, STOP, 1),
    (19.75, (TL0 + 5, HANDLE_Y), 1), (TRIM_A, (TL0 + 5, HANDLE_Y), 1), (TRIM_B, (TRIM - 5, HANDLE_Y), 1),
    (20.45, PLAY, 1), (20.55, PLAY, 1), (21.0, (520, 500), 1),
    (22.5, (520, 500), 1), (22.98, EXPORT, 1), (23.8, EXPORT, 1),
    (24.35, SEARCH, 1), (24.6, SEARCH, 1), (24.9, (690, 70), 1),
    (RESULTS + .9, (690, 70), 1), (PANEL_IN - .15, MATCH_TILE, 1), (PANEL_IN + .3, MATCH_TILE, 1),
    (PANEL_IN + 1.2, (872, 334), 1), (END_IN, (872, 334), 1), (END_IN + .3, (872, 334), 0),
]
kf("cur", [(t, f"opacity:{o};{tr(x, y)}") for t, (x, y), o in cur], "#cur", "cubic-bezier(.45,0,.3,1)")

# ================================================================ captions ====
CHAPTERS = [("Capture", 0, 5.4), ("Mark it up", 5.4, 12.3), ("Copy text", 12.3, 16.6),
            ("Record and edit", 16.6, 23.8), ("Find it again", 23.8, T)]
caps_svg = []
for i, (label, a, b) in enumerate(CHAPTERS):
    x = 96 + i * 192
    caps_svg.append(f"""<g id="ch{i}">
  <rect x="{x - 88}" y="560" width="176" height="40" rx="20" class="pill"/>
  <circle cx="{x - 64}" cy="580" r="12" class="num"/>
  <text x="{x - 64}" y="584.5" class="t b numt" font-size="12.5" text-anchor="middle">{i + 1}</text>
  <text x="{x - 44}" y="585" class="t b lab" font-size="14">{label}</text>
</g>""")
    show(f"#ch{i}", f"ch{i}", [(a, b)], fade=.25, off="opacity:.38")
    show(f"#ch{i} .num", f"ch{i}n", [(a, b)], fade=.25, off="fill:#1d2129", on="fill:#0090ff")
captions = f'<g id="steps">{"".join(caps_svg)}</g>'
progress = '<rect id="prog" x="0" y="617" width="960" height="3" fill="url(#bd)"/>'
kf("prog", [(0, "transform:scaleX(0)"), (T, "transform:scaleX(1)")], "#prog", "linear")

# ================================================================== output ====
defs = f"""
<defs>
  <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#7a4b94"/></linearGradient>
  <linearGradient id="bd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset=".55" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff6ac1"/></linearGradient>
  <linearGradient id="bd2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ddc97"/><stop offset=".5" stop-color="#4c8dff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient>
  <linearGradient id="scangrad" x1="0" x2="1"><stop offset="0" stop-color="#4c8dff" stop-opacity="0"/><stop offset=".85" stop-color="#4c8dff" stop-opacity=".45"/><stop offset="1" stop-color="#9cc0ff" stop-opacity=".95"/></linearGradient>
  <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="9" cy="9" r="1" fill="#2a2e37"/></pattern>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
  <clipPath id="screen"><rect width="960" height="540" rx="16"/></clipPath>
  <clipPath id="capclip"><rect x="{CX}" y="{CY}" width="{cap_w:.1f}" height="{cap_h:.1f}" rx="10"/></clipPath>
  <clipPath id="qaclip"><rect x="{QX + 16}" y="{QY + 14}" width="{SW * qa_scale:.1f}" height="{SH * qa_scale:.1f}" rx="6"/></clipPath>
  <clipPath id="scanclip"><rect x="{TX}" y="{TY}" width="{TW}" height="{TH}"/></clipPath>
  <clipPath id="vclip"><rect x="{VX}" y="{VY}" width="{VW}" height="{VH:.1f}" rx="10"/></clipPath>
  <clipPath id="tcbig"><rect x="620" y="118" width="320" height="150" rx="6"/></clipPath>
  {''.join(tile_clips)}
</defs>"""

style = """
.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif}
.b{font-weight:700}
.pill{fill:#1d2129;stroke:#2c313b}
.lab{fill:#f3f4f7}
.numt{fill:#fff}
#prog{transform-origin:0 0}
@media (prefers-reduced-motion:reduce){*{animation-delay:-9.9s!important;animation-play-state:paused!important}}
""" + "\n".join(css)

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc">
<title id="title">Grab-it in action</title>
<desc id="desc">Capture part of the screen from the All-in-one toolbar, annotate it with an arrow, a box, numbered steps, a blur and a note on a gradient backdrop, and copy it. Copy the code off a screen share as text, tidied up by AI. Record the screen, trim the recording, zoom in on a click and export it. Then search the Library for "invoice" to find a receipt by the text inside it, with an AI description and tags.</desc>
<style>{style}</style>
{defs}
<rect width="{W}" height="{H}" rx="20" fill="#0d1016"/>
<g clip-path="url(#screen)">
{''.join(body)}
</g>
<rect width="960" height="540" rx="16" fill="none" stroke="#2c313b"/>
{captions}
{progress}
</svg>
"""
open(sys.argv[1], "w").write(svg)
print(f"wrote {sys.argv[1]} ({len(svg) // 1024} KB)")
