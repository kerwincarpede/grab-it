"""Generate docs/assets/demo.svg, the animated Grab-it demo. The README shows
docs/assets/demo.gif, which docs/assets/demo_gif.py renders from this SVG.

Run from the repository root:  python3 docs/assets/demo.py docs/assets/demo.svg

Everything is driven by CSS keyframes sharing one 14 s cycle, so GitHub plays
it inside an <img>. Percentages below are of that cycle.
"""
import math
import random
import sys

T = 14  # seconds per loop
W, H = 960, 620  # card size; the "screen" is the top 960x540

# Selection on the desktop, in desktop coordinates.
SX, SY, SW, SH = 252, 138, 560, 254
# Where the capture sits in the editor: scale and top-left.
K = 1.3
CX, CY = 156, 118


def ed(x, y):
    """Desktop coordinates -> editor coordinates."""
    return CX + (x - SX) * K, CY + (y - SY) * K


css = []
body = []


def kf(name, frames):
    lines = [f"@keyframes {name}{{"]
    for pct, decl in frames:
        lines.append(f"{pct}%{{{decl}}}")
    lines.append("}")
    css.append("".join(lines))
    return name


def anim(sel, name, extra=""):
    css.append(f"{sel}{{animation:{name} {T}s infinite both;{extra}}}")


def tr(x, y, s=None):
    t = f"translate({x:.1f}px,{y:.1f}px)"
    if s is not None:
        t += f" scale({s})"
    return f"transform:{t}"


# ---------------------------------------------------------------- desktop ---
def dashboard():
    """The app window being captured (desktop coordinates)."""
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
  <rect x="140" y="452" width="100" height="10" fill="#f6f7fb"/>
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
</g>"""


def logo(x, y, s=1.0, color="#fff"):
    """Grab-it glyph: viewfinder corners around a dot."""
    return f"""<g transform="translate({x} {y}) scale({s})" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round">
<path d="M-8 -3v-5h5M3 -8h5v5M8 3v5h-5M-3 8h-5v-5"/><circle r="2.6" fill="{color}" stroke="none"/></g>"""


desktop = f"""
<g id="desk">
  <rect width="960" height="540" fill="url(#wall)"/>
  <circle cx="120" cy="470" r="180" fill="#ff6ac1" opacity=".18" filter="url(#soft)"/>
  <circle cx="860" cy="80" r="200" fill="#3ddc97" opacity=".14" filter="url(#soft)"/>
  <rect x="140" y="62" width="684" height="404" rx="12" fill="#000" opacity=".35" filter="url(#shadow)"/>
  {dashboard()}
  <rect y="508" width="960" height="32" fill="#0b0d12" opacity=".72"/>
  <text x="928" y="529" class="t" font-size="12" fill="#e6e8ee" text-anchor="end">9:41</text>
  <circle cx="852" cy="524" r="4" fill="#9aa3b2"/><circle cx="870" cy="524" r="4" fill="#9aa3b2"/>
  <g id="tray"><circle cx="830" cy="524" r="12" fill="#4c8dff" opacity="0"/>{logo(830, 524, .72, "#e6e8ee")}</g>
</g>"""
body.append(desktop)

# Hotkey keycap.
body.append(f"""
<g id="key">
  <rect x="-62" y="-36" width="124" height="80" rx="16" fill="#0b0d12" opacity=".45"/>
  <g id="cap"><rect x="-58" y="-42" width="116" height="78" rx="14" fill="#f4f5f8"/>
  <rect x="-58" y="-42" width="116" height="70" rx="14" fill="#ffffff"/>
  <text y="0" class="t b" font-size="24" fill="#1f2328" text-anchor="middle">PrtSc</text>
  <text y="20" class="t" font-size="10.5" fill="#6b7280" text-anchor="middle">or ⌘ ⇧ 2</text></g>
</g>""")
css.append("#key{transform:translate(480px,262px)}")
kf("key", [(0, "opacity:0;transform:translate(480px,262px) scale(.6)"),
           (2.5, "opacity:0;transform:translate(480px,262px) scale(.6)"),
           (4.5, "opacity:1;transform:translate(480px,262px) scale(1.06)"),
           (5.5, "opacity:1;transform:translate(480px,262px) scale(1)"),
           (8.5, "opacity:1;transform:translate(480px,262px) scale(1)"),
           (10.5, "opacity:0;transform:translate(480px,262px) scale(1.25)"),
           (100, "opacity:0;transform:translate(480px,262px) scale(1.25)")])
anim("#key", "key")
kf("press", [(0, "transform:translateY(0)"), (6, "transform:translateY(0)"), (6.8, "transform:translateY(6px)"),
             (7.8, "transform:translateY(0)"), (100, "transform:translateY(0)")])
anim("#cap", "press")
kf("tray", [(0, "opacity:0"), (6.5, "opacity:0"), (7.5, "opacity:.9"), (12, "opacity:0"), (100, "opacity:0")])
anim("#tray circle:first-child", "tray")

# ------------------------------------------------------------ selection ---
body.append(f"""
<g id="dim"><rect width="960" height="540" fill="#05070c" opacity=".55"/></g>
<g id="sel">
  <rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="#fff" opacity=".16"/>
  <rect x="{SX}" y="{SY}" width="{SW}" height="{SH}" fill="none" stroke="#0090ff" stroke-width="2"/>
</g>
<g id="dims"><rect x="{SX + SW - 92}" y="{SY + SH + 10}" width="92" height="24" rx="6" fill="#0090ff"/>
<text x="{SX + SW - 46}" y="{SY + SH + 26}" class="t b" font-size="12" fill="#fff" text-anchor="middle">{SW} × {SH}</text></g>
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
</g>""")
kf("dim", [(0, "opacity:0"), (9.5, "opacity:0"), (11.5, "opacity:1"), (28, "opacity:1"), (29, "opacity:0"), (100, "opacity:0")])
anim("#dim", "dim")
css.append(f"#sel{{transform-origin:{SX}px {SY}px}}")
kf("sel", [(0, "opacity:0;transform:scale(0)"), (13, "opacity:0;transform:scale(0)"),
           (13.2, "opacity:1;transform:scale(0)"),
           (24, "opacity:1;transform:scale(1)"), (28, "opacity:1;transform:scale(1)"),
           (29, "opacity:0;transform:scale(1)"), (100, "opacity:0;transform:scale(1)")])
anim("#sel", "sel", "animation-timing-function:ease-in-out")
kf("dims", [(0, "opacity:0"), (23.5, "opacity:0"), (25, "opacity:1"), (28, "opacity:1"), (29, "opacity:0"), (100, "opacity:0")])
anim("#dims", "dims")
kf("xh", [(0, f"opacity:0;{tr(SX - 60, SY - 40)}"), (10.5, f"opacity:0;{tr(SX - 60, SY - 40)}"),
          (11.5, f"opacity:1;{tr(SX - 60, SY - 40)}"), (13, f"opacity:1;{tr(SX, SY)}"),
          (24, f"opacity:1;{tr(SX + SW, SY + SH)}"), (28, f"opacity:1;{tr(SX + SW, SY + SH)}"),
          (28.5, f"opacity:0;{tr(SX + SW, SY + SH)}"), (100, f"opacity:0;{tr(SX + SW, SY + SH)}")])
anim("#xh", "xh", "animation-timing-function:ease-in-out")

body.append('<rect id="flash" width="960" height="540" fill="#fff"/>')
kf("flash", [(0, "opacity:0"), (28.6, "opacity:0"), (29.2, "opacity:.95"), (32, "opacity:0"), (100, "opacity:0")])
anim("#flash", "flash")

# ---------------------------------------------------------- quick access ---
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
    <rect id="annbtn" x="{QX + 78}" y="{QY + 104}" width="74" height="26" rx="7" fill="#0090ff"/><text x="{QX + 115}" y="{QY + 121}" fill="#fff">Annotate</text>
    <rect x="{QX + 158}" y="{QY + 104}" width="42" height="26" rx="7" fill="#2a2f39"/><text x="{QX + 179}" y="{QY + 121}" fill="#e6e8ee">Pin</text>
  </g>
</g>
<circle id="ripple" cx="{QX + 115}" cy="{QY + 117}" r="20" fill="none" stroke="#fff" stroke-width="3"/>""")
kf("qa", [(0, "opacity:0;transform:translateX(-250px)"), (30.5, "opacity:0;transform:translateX(-250px)"),
          (31, "opacity:1;transform:translateX(-250px)"), (34, "opacity:1;transform:translateX(0)"),
          (43, "opacity:1;transform:translateX(0)"), (45, "opacity:0;transform:translateX(0)"),
          (100, "opacity:0;transform:translateX(0)")])
anim("#qa", "qa", "animation-timing-function:cubic-bezier(.2,.9,.3,1.2)")
css.append(f"#ripple{{transform-origin:{QX + 115}px {QY + 117}px}}")
kf("ripple", [(0, "opacity:0;transform:scale(.3)"), (39.6, "opacity:0;transform:scale(.3)"),
              (40, "opacity:.9;transform:scale(.4)"), (42.5, "opacity:0;transform:scale(2.2)"),
              (100, "opacity:0;transform:scale(2.2)")])
anim("#ripple", "ripple")

# ---------------------------------------------------------------- editor ---
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
    if name == "backdrop":
        return (f'<rect x="{cx-10}" y="{cy-9}" width="20" height="18" rx="4" fill="url(#bd)"/>'
                f'<rect x="{cx-5}" y="{cy-4}" width="10" height="8" rx="1.5" fill="#fff"/>')


rail = "".join(tool_icon(t, 32, RAIL_Y0 + i * RAIL_STEP) for i, t in enumerate(TOOLS))

# Annotations, in desktop coordinates (they live inside the scaled capture).
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
  <path id="a-under" d="M592 288q30 -6 60 0t60 -2" stroke="#e5484d" stroke-width="3" stroke-dasharray="125" stroke-dashoffset="125"/>
</g>"""

cap_w, cap_h = SW * K, SH * K
mid = (CX + cap_w / 2, CY + cap_h / 2)  # (520, 283.1)
BD_SCALE = 0.8
bw, bh = cap_w * BD_SCALE + 84, cap_h * BD_SCALE + 84

editor = f"""
<g id="ed">
  <rect width="960" height="540" fill="#14161b"/>
  <rect x="64" y="40" width="896" height="500" fill="url(#dots)"/>
  <rect width="960" height="40" fill="#1b1e25"/>
  <rect y="39" width="960" height="1" fill="#2c313b"/>
  {logo(22, 20, .78, "#4c8dff")}
  <text x="40" y="25" class="t" font-size="12.5" fill="#c9ceda">Grab-it 2026-11-14 09-41-07.png</text>
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
    <rect id="bd-bg" x="{mid[0] - bw / 2:.1f}" y="{mid[1] - bh / 2:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="18" fill="url(#bd)"/>
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
    <rect x="352" y="56" width="256" height="38" rx="19" fill="#1f2328" stroke="#3a404c"/>
    <circle cx="378" cy="75" r="10" fill="#30a46c"/>
    <path d="M373 75l3.5 3.5 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="396" y="80" class="t b" font-size="13.5" fill="#fff">Copied! Paste it anywhere</text>
  </g>
</g>"""
body.append(editor)

css.append("#ed{transform-origin:480px 290px}")
kf("ed", [(0, "opacity:0;transform:scale(.9)"), (43, "opacity:0;transform:scale(.9)"),
          (46.5, "opacity:1;transform:scale(1)"), (96, "opacity:1;transform:scale(1)"),
          (99.5, "opacity:0;transform:scale(1.02)"), (100, "opacity:0;transform:scale(1.02)")])
anim("#ed", "ed", "animation-timing-function:cubic-bezier(.2,.8,.2,1)")

# Phase windows for each tool (start%, end%).
PH = {"arrow": (48, 55), "rect": (55, 61), "step": (61, 66), "blur": (66, 71), "text": (71, 77), "backdrop": (77, 84)}
frames = [(0, "transform:translateY(0)")]
prev = 0
for i, t in enumerate(TOOLS):
    a, b = PH[t]
    frames += [(a - 1.2, f"transform:translateY({prev}px)"), (a - 0.2, f"transform:translateY({i * RAIL_STEP}px)")]
    prev = i * RAIL_STEP
frames += [(96, f"transform:translateY({prev}px)"), (99, f"transform:translateY(0px)"), (100, "transform:translateY(0px)")]
kf("railsel", frames)
anim("#railsel", "railsel", "animation-timing-function:cubic-bezier(.3,1.4,.5,1)")


def draw(sel, name, length, a, b):
    kf(name, [(0, f"stroke-dashoffset:{length:.0f}"), (a, f"stroke-dashoffset:{length:.0f}"),
              (b, "stroke-dashoffset:0"), (100, "stroke-dashoffset:0")])
    anim(sel, name, "animation-timing-function:ease-in-out")


def pop(sel, name, at, origin, rot=0):
    css.append(f"{sel}{{transform-origin:{origin[0]}px {origin[1]}px}}")
    r = f" rotate({rot}deg)" if rot else ""
    kf(name, [(0, f"opacity:0;transform:scale(0){r}"), (at, f"opacity:0;transform:scale(0){r}"),
              (at + 1.2, f"opacity:1;transform:scale(1.25){r}"), (at + 2.2, f"opacity:1;transform:scale(1){r}"),
              (100, f"opacity:1;transform:scale(1){r}")])
    anim(sel, name)


def fadein(sel, name, a, b):
    kf(name, [(0, "opacity:0"), (a, "opacity:0"), (b, "opacity:1"), (100, "opacity:1")])
    anim(sel, name)


draw("#a-arrow", "arrow", arrow_len, 49, 53.5)
fadein("#a-head", "ahead", 53.3, 53.8)
draw("#a-rect", "rect", rect_len, 56, 59.5)
pop("#s1", "s1", 61.5, (RX, RY))
pop("#s2", "s2", 63.5, (696, 334))
# Blur: blocks reveal left to right as the cursor drags across.
css.append("#blur{transform-origin:574px 214px}")
kf("blur", [(0, "opacity:0;transform:scaleX(0)"), (67, "opacity:1;transform:scaleX(0)"),
            (70, "opacity:1;transform:scaleX(1)"), (100, "opacity:1;transform:scaleX(1)")])
anim("#blur", "blur", "animation-timing-function:ease-in-out")
pop("#a-text", "atext", 72, (652, 266), rot=-3)
draw("#a-under", "under", 125, 74.5, 76.5)

# Backdrop: capture shrinks, gradient frame and shadow appear behind it.
css.append(f"#capwrap,#bdwrap{{transform-origin:{mid[0]:.1f}px {mid[1]:.1f}px}}")
kf("capwrap", [(0, "transform:scale(1)"), (78, "transform:scale(1)"), (81, f"transform:scale({BD_SCALE})"),
               (100, f"transform:scale({BD_SCALE})")])
anim("#capwrap", "capwrap", "animation-timing-function:cubic-bezier(.3,1.3,.5,1)")
kf("bdwrap", [(0, "opacity:0;transform:scale(.9)"), (78.5, "opacity:0;transform:scale(.9)"),
              (81.5, "opacity:1;transform:scale(1)"), (100, "opacity:1;transform:scale(1)")])
anim("#bdwrap", "bdwrap", "animation-timing-function:cubic-bezier(.3,1.3,.5,1)")
fadein("#capshadow", "capshadow", 78.5, 81.5)

kf("toast", [(0, "opacity:0;transform:translateY(-30px)"), (85, "opacity:0;transform:translateY(-30px)"),
             (87, "opacity:1;transform:translateY(0)"), (100, "opacity:1;transform:translateY(0)")])
anim("#toast", "toast", "animation-timing-function:cubic-bezier(.2,1.4,.4,1)")
css.append("#copybtn{transform-origin:845px 20px}")
kf("copybtn", [(0, "transform:scale(1)"), (84, "transform:scale(1)"), (84.6, "transform:scale(.88)"),
               (85.4, "transform:scale(1.08)"), (86.2, "transform:scale(1)"), (100, "transform:scale(1)")])
anim("#copybtn", "copybtn")

# ---------------------------------------------------------------- cursor ---
# Pointer path through the whole story (screen coordinates).
qa_btn = (QX + 115, QY + 117)
cur_frames = [
    (0, (520, 330), 0), (31, (520, 330), 0), (32, (520, 330), 1),
    (38.5, qa_btn, 1), (40, qa_btn, 1), (43, qa_btn, 0),
    (47, ed(*AR_START), 0), (48.5, ed(*AR_START), 1), (49, ed(*AR_START), 1),
    (53.5, ed(*AR_END), 1),
    (55.5, ed(RX, RY), 1), (56, ed(RX, RY), 1), (59.5, ed(RX + RW, RY + RH), 1),
    (61.3, ed(RX, RY), 1), (63.3, ed(696, 334), 1),
    (66.5, ed(574, 228), 1), (67, ed(574, 228), 1), (70, ed(782, 228), 1),
    (71.8, ed(652, 266), 1), (74.5, ed(592, 288), 1), (76.5, ed(712, 286), 1),
    (78, (32, RAIL_Y0 + 5 * RAIL_STEP), 1), (80, (32, RAIL_Y0 + 5 * RAIL_STEP), 1),
    (84, (845, 20), 1), (88, (845, 20), 1), (90, (845, 20), 0), (100, (845, 20), 0),
]
kf("cur", [(p, f"opacity:{o};{tr(x, y)}") for p, (x, y), o in cur_frames])
anim("#cur", "cur", "animation-timing-function:cubic-bezier(.45,0,.3,1)")

# ---------------------------------------------------------------- confetti --
COLORS = ["#4c8dff", "#ff6ac1", "#3ddc97", "#f5a524", "#a56bff", "#ff5e7e", "#7fd8e8", "#fff3a8"]
confetti = []
random.seed(11)
ox, oy = 480, 300
for i in range(56):
    c = COLORS[i % len(COLORS)]
    shape = (f'<rect x="-6" y="-3" width="12" height="6" rx="1.5" fill="{c}"/>' if i % 3
             else f'<circle r="4.6" fill="{c}"/>')
    confetti.append(f'<g class="cf" id="cf{i}">{shape}</g>')
    a = random.uniform(0, 2 * math.pi)
    v = random.uniform(140, 420)
    dx, dy = math.cos(a) * v, math.sin(a) * v * 0.55 - 60
    rot = random.choice([-1, 1]) * random.randint(240, 720)
    start = 86 + random.uniform(0, 0.8)
    kf(f"cf{i}", [
        (0, f"opacity:0;transform:translate({ox}px,{oy}px) rotate(0)"),
        (start, f"opacity:0;transform:translate({ox}px,{oy}px) rotate(0)"),
        (start + 0.3, f"opacity:1;transform:translate({ox}px,{oy}px) rotate(0)"),
        (start + 2.4, f"opacity:1;transform:translate({ox + dx:.0f}px,{oy + dy:.0f}px) rotate({rot / 2:.0f}deg)"),
        (start + 7.5, f"opacity:0;transform:translate({ox + dx * 1.25:.0f}px,{oy + dy + 260:.0f}px) rotate({rot}deg)"),
        (100, f"opacity:0;transform:translate({ox + dx * 1.25:.0f}px,{oy + dy + 260:.0f}px) rotate({rot}deg)"),
    ])
    css.append(f"#cf{i}{{animation:cf{i} {T}s infinite both;animation-timing-function:cubic-bezier(.15,.7,.4,1)}}")
body.append(f'<g id="confetti">{"".join(confetti)}</g>')

body.append("""
<g id="cur">
  <path d="M0 0v21l5.2-5 3.6 8.4 3.8-1.6-3.6-8.2H16z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
</g>""")

# --------------------------------------------------------------- captions --
STEPS = [("1", "Press PrtSc", 0, 11), ("2", "Drag to grab", 11, 30), ("3", "Mark it up", 30, 84),
         ("4", "Paste anywhere", 84, 100)]
cap = []
xs = [130, 360, 600, 830]
for i, ((n, label, a, b), x) in enumerate(zip(STEPS, xs)):
    cap.append(f"""<g id="st{i}">
  <rect x="{x - 96}" y="560" width="192" height="40" rx="20" class="pill"/>
  <circle cx="{x - 72}" cy="580" r="12" class="num"/>
  <text x="{x - 72}" y="584.5" class="t b numt" font-size="12.5" text-anchor="middle">{n}</text>
  <text x="{x - 52}" y="585" class="t b lab" font-size="14.5">{label}</text>
</g>""")
    def onoff(off, on):
        if a == 0:
            return [(0, on), (b - .4, on), (b, off), (99.4, off), (100, on)]
        if b == 100:
            return [(0, off), (a, off), (a + .6, on), (99.4, on), (100, off)]
        return [(0, off), (a, off), (a + .6, on), (b - .4, on), (b, off), (100, off)]
    kf(f"st{i}p", onoff("opacity:.38", "opacity:1"))
    anim(f"#st{i}", f"st{i}p")
    kf(f"st{i}h", onoff("fill:#1d2129", "fill:#0090ff"))
    anim(f"#st{i} .num", f"st{i}h")
body.append(f'<g id="steps">{"".join(cap)}</g>')
body.append('<rect id="prog" x="0" y="617" width="960" height="3" fill="url(#bd)"/>')
kf("prog", [(0, "transform:scaleX(0)"), (100, "transform:scaleX(1)")])
anim("#prog", "prog", "animation-timing-function:linear")

# ----------------------------------------------------------------- output --
defs = f"""
<defs>
  <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#7a4b94"/></linearGradient>
  <linearGradient id="bd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset=".55" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff6ac1"/></linearGradient>
  <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="9" cy="9" r="1" fill="#2a2e37"/></pattern>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
  <clipPath id="screen"><rect width="960" height="540" rx="16"/></clipPath>
  <clipPath id="capclip"><rect x="{CX}" y="{CY}" width="{cap_w:.1f}" height="{cap_h:.1f}" rx="10"/></clipPath>
  <clipPath id="qaclip"><rect x="{QX + 16}" y="{QY + 14}" width="{SW * qa_scale:.1f}" height="{SH * qa_scale:.1f}" rx="6"/></clipPath>
</defs>"""

style = """
.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif}
.b{font-weight:700}
.pill{fill:#1d2129;stroke:#2c313b}
.lab{fill:#f3f4f7}
.numt{fill:#fff}
#prog{transform-origin:0 0}
@media (prefers-reduced-motion:reduce){*{animation-delay:-12.6s!important;animation-play-state:paused!important}}
""" + "\n".join(css)

screen_parts = body[:-2]  # everything except the step captions + progress bar
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc">
<title id="title">Grab-it in action</title>
<desc id="desc">Press PrtSc, drag over part of the screen, annotate the capture with an arrow, a box, numbered steps, a blur and a note, add a gradient backdrop, then copy it to paste anywhere.</desc>
<style>{style}</style>
{defs}
<rect width="{W}" height="{H}" rx="20" fill="#0d1016"/>
<g clip-path="url(#screen)">
{''.join(screen_parts)}
</g>
<rect width="960" height="540" rx="16" fill="none" stroke="#2c313b"/>
{body[-2]}
{body[-1]}
</svg>
"""
open(sys.argv[1], "w").write(svg)
print(f"wrote {sys.argv[1]} ({len(svg) // 1024} KB)")
