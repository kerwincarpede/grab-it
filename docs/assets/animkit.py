"""Shared pieces of Grab-it's animated SVGs: the README demo (demo.py) and the
docs site's tour animations (tours.py).

Every animation is one SVG driven by CSS keyframes that share a cycle of T
seconds, so it also plays inside an <img>. Times are in seconds into that cycle.
"""
import math
import random


class Anim:
    """The keyframes and markup of one animation, `T` seconds long."""

    def __init__(self, T):
        self.T = T
        self.css = []
        self.body = []
        self.ripples = []

    def P(self, s):
        return s / self.T * 100

    def kf(self, name, frames, sel=None, ease=None):
        """Keyframes from (seconds, declarations) pairs; the first and last values are held to the ends."""
        T = self.T
        fr = list(frames)
        if fr[0][0] > 0:
            fr.insert(0, (0, fr[0][1]))
        if fr[-1][0] < T:
            fr.append((T, fr[-1][1]))
        for a, b in zip(fr, fr[1:]):
            assert b[0] > a[0], (name, a, b)
        self.css.append(f"@keyframes {name}{{" + "".join(f"{self.P(s):.3f}%{{{d}}}" for s, d in fr) + "}")
        if sel:
            timing = f";animation-timing-function:{ease}" if ease else ""
            self.css.append(f"{sel}{{animation:{name} {T}s infinite both{timing}}}")
        return name

    def show(self, sel, name, wins, fade=.3, off="opacity:0", on="opacity:1", ease=None):
        """Visible during each (start, end) window, fading over `fade` seconds at each edge."""
        T = self.T
        fr = []
        swap = fade <= .05  # a quick swap: shown from exactly a until exactly b, so no moment shows two or none
        for a, b in wins:
            fr += [(0, on)] if a <= 0 else [(a - .001, off), (a, on)] if swap else [(a, off), (a + fade, on)]
            fr += [(T, on)] if b >= T else [(b - .001, on), (b, off)] if swap else [(b - fade, on), (b, off)]
        self.kf(name, fr, sel, ease)

    def click(self, x, y, t, color="#fff"):
        """A ring that grows out of (x, y) at time t."""
        i = len(self.ripples)
        self.ripples.append(f'<circle id="rp{i}" cx="{x:.1f}" cy="{y:.1f}" r="18" fill="none" stroke="{color}" stroke-width="3"/>')
        self.css.append(f"#rp{i}{{transform-origin:{x:.1f}px {y:.1f}px}}")
        self.kf(f"rp{i}", [(t - .02, "opacity:0;transform:scale(.3)"), (t + .04, "opacity:.95;transform:scale(.4)"),
                           (t + .6, "opacity:0;transform:scale(2.1)")], f"#rp{i}")


def tr(x, y, s=None):
    t = f"translate({x:.1f}px,{y:.1f}px)"
    if s is not None:
        t += f" scale({s})"
    return f"transform:{t}"


MONO = 'font-family="JetBrains Mono,SF Mono,Menlo,Consolas,monospace"'


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


ARIAL = {"a": 556, "e": 556, "f": 278, "g": 556, "i": 222, "l": 222, "m": 833, "n": 556, "o": 556, "r": 333, "t": 278,
         "u": 556, "w": 722, "x": 500, "d": 556, "c": 500, " ": 278, "R": 722, "W": 944, "S": 667, "T": 611, "C": 722}


def text_w(s, size):
    """Rough width of s in a Helvetica/Arial-like font."""
    return sum(ARIAL.get(ch, 556) for ch in s) * size / 1000


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
    if name == "Scroll":
        return f'<rect {s} x="{cx-6}" y="{cy-7}" width="12" height="14" rx="2"/><path {s} d="M{cx} {cy-4}v8m-3-3 3 3 3-3"/>'
    if name == "Record":
        return f'<circle {s} cx="{cx}" cy="{cy}" r="6"/>'
    return f'<circle {s} cx="{cx}" cy="{cy + 1}" r="6"/><path {s} d="M{cx} {cy - 2}v3M{cx - 2} {cy - 7}h4"/>'


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


def qlen(p0, p1, p2, n=200):
    L, prev = 0, p0
    for i in range(1, n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        L += math.dist(prev, (x, y))
        prev = (x, y)
    return L


def head(p, a, size=13):
    l = (p[0] - size * math.cos(a - .45), p[1] - size * math.sin(a - .45))
    r = (p[0] - size * math.cos(a + .45), p[1] - size * math.sin(a + .45))
    return f"M{l[0]:.1f} {l[1]:.1f}L{p[0]} {p[1]}L{r[0]:.1f} {r[1]:.1f}"


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

CHOOSER_MODES = [("Region", "1"), ("Window", "2"), ("Screen", "3"), None,
                 ("Text", "4"), ("Colour", "5"), ("Record", "6"), ("Scroll", "7")]


def chooser_toolbar(cx, y, picked, main=None, ready=False, size=None, ratio="Free", timer="Timer", timer_on=False,
                    colour=None, record=None):
    """Capture &amp; record…'s one toolbar, centred on cx with its top at y: modes 1–3 and 4–7, the
    picked one labelled in a grey pill, then the selection's size and ratios when `size` is (w, h),
    or the hex value when `colour` is, the Timer (None hides it), the main button (dimmed until `ready`;
    None hides it) and ×.
    With Record picked, `record` is {"source": "Region" | "Window" | "Screen", "on": {"sound", "clicks",
    "keys"} that are on}: the source is a grey pill too, Record's dot is red, the middle holds the format,
    the microphone and webcam as icons and the three toggles, the Timer is the countdown and the main
    button is red.
    Returns (svg, left x, width, {mode: (x, width)})."""
    h, bh, pad, gap = 40, 30, 5, 2
    labelled = {picked} | ({record["source"]} if record else set())
    parts = []  # (kind, payload, width)
    for mode in CHOOSER_MODES:
        if mode is None:
            parts.append(("sep", None, 9))
            continue
        name, _ = mode
        w = round(28 + text_w(name, 12.5) + 24) if name in labelled else 44
        parts.append(("mode", mode, w))
    if record:
        parts.append(("sep", None, 9))
        parts.append(("chip", "MP4 · 30 fps", round(text_w("MP4 · 30 fps", 12) + 30)))
        parts.append(("iconchip", "mic", 38))
        parts.append(("iconchip", "cam", 38))
        parts.append(("sep", None, 9))
        for toggle in ("sound", "clicks", "keys"):
            parts.append(("toggle", toggle, 30))
        parts.append(("sep", None, 9))
    elif size:
        parts.append(("sep", None, 9))
        parts.append(("field", str(size[0]), 44))
        parts.append(("times", None, 10))
        parts.append(("field", str(size[1]), 40))
        parts.append(("unit", None, 18))
        for lab in ("Free", "16:9", "4:3", "1:1"):
            parts.append(("ratio", lab, round(text_w(lab, 12) + 16)))
        parts.append(("sep", None, 9))
    elif colour:
        parts.append(("sep", None, 9))
        parts.append(("colour", colour, round(28 + text_w(colour, 12) * 1.15)))
        parts.append(("sep", None, 9))
    else:
        parts.append(("space", None, 8))
    if timer is not None:
        parts.append(("timer", timer, round(26 + text_w(timer, 12.5) + 24)))
    if main is not None:
        parts.append(("main", main, round(16 + text_w(main, 12.5) * 1.05 + 30 + (12 if record else 0))))
    parts.append(("cancel", None, 30))
    width = pad * 2 + sum(w for _, _, w in parts) + gap * (len(parts) - 1)
    left = cx - width / 2
    cy = y + h / 2
    out = [f'<rect x="{left}" y="{y}" width="{width}" height="{h}" rx="{h / 2}" fill="#101113" stroke="#2a2c31"/>']
    places = {}
    x = left + pad
    for kind, data, w in parts:
        top = cy - bh / 2
        if kind == "sep":
            out.append(f'<rect x="{x + w / 2 - .5}" y="{cy - 9}" width="1" height="18" fill="#2a2c31"/>')
        elif kind == "mode":
            name, key = data
            places[name] = (x, w)
            if name in labelled:
                out.append(f'<rect x="{x}" y="{top}" width="{w}" height="{bh}" rx="{bh / 2}" fill="#34373f"/>')
                out.append(mode_icon(name, x + 15, cy))
                out.append(f'<text x="{x + 28}" y="{cy + 4.5}" class="t" font-size="12.5" fill="#fff">{name}</text>')
            else:
                out.append(mode_icon(name, x + 14, cy))
            if name == "Record" and record:
                out.append(f'<circle cx="{x + 15}" cy="{cy}" r="2.6" fill="#ff4d4f"/>')
            out.append(f'<rect x="{x + w - 21}" y="{cy - 8}" width="15" height="16" rx="4" fill="#ffffff" opacity=".12"/>')
            out.append(f'<text x="{x + w - 13.5}" y="{cy + 4}" class="t" font-size="10.5" fill="#c9ceda" text-anchor="middle">{key}</text>')
        elif kind == "field":
            out.append(f'<rect x="{x}" y="{cy - 12}" width="{w}" height="24" rx="6" fill="#1c1e22" stroke="#2e3036"/>')
            out.append(f'<text x="{x + w - 6}" y="{cy + 4.5}" class="t" font-size="12" fill="#fff" text-anchor="end">{data}</text>')
        elif kind == "times":
            out.append(f'<text x="{x + w / 2}" y="{cy + 4.5}" class="t" font-size="12" fill="#8b93a1" text-anchor="middle">×</text>')
        elif kind == "unit":
            out.append(f'<text x="{x + 2}" y="{cy + 4}" class="t" font-size="11" fill="#8b93a1">px</text>')
        elif kind == "chip":
            places[data] = (x, w)
            out.append(f'<rect x="{x}" y="{cy - 12}" width="{w}" height="24" rx="12" fill="#ffffff" fill-opacity=".06"/>')
            out.append(f'<text x="{x + 10}" y="{cy + 4.5}" class="t" font-size="12" fill="#e6e8ee">{data}</text>')
            out.append(f'<path d="M{x + w - 15} {cy - 1.5}l3 3 3-3" fill="none" stroke="#8b93a1" stroke-width="1.4" stroke-linecap="round"/>')
        elif kind == "iconchip":
            places[data] = (x, w)
            ic = 'fill="none" stroke="#e6e8ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
            out.append(f'<rect x="{x}" y="{cy - 12}" width="{w}" height="24" rx="12" fill="#ffffff" fill-opacity=".06"/>')
            ix = x + 13
            if data == "mic":
                out.append(f'<rect {ic} x="{ix - 2.5}" y="{cy - 6}" width="5" height="8" rx="2.5"/>'
                           f'<path {ic} d="M{ix - 5} {cy}a5 5 0 0 0 10 0M{ix} {cy + 5}v2"/>')
            else:
                out.append(f'<rect {ic} x="{ix - 6}" y="{cy - 4}" width="9" height="8" rx="2"/>'
                           f'<path {ic} d="M{ix + 3} {cy - 1.5}l3.5-2v7l-3.5-2"/>')
            out.append(f'<path d="M{x + w - 14} {cy - 1.5}l3 3 3-3" fill="none" stroke="#8b93a1" stroke-width="1.4" stroke-linecap="round"/>')
        elif kind == "toggle":
            places[data] = (x, w)
            ic = 'fill="none" stroke="#e6e8ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
            if data in record["on"]:
                out.append(f'<rect x="{x}" y="{top}" width="{w}" height="{bh}" rx="{bh / 2}" fill="#34373f"/>')
            tx = x + w / 2
            if data == "sound":
                out.append(f'<path {ic} d="M{tx - 6} {cy - 2}h3l4-3v10l-4-3h-3zM{tx + 3} {cy - 2}a3.5 3.5 0 0 1 0 5"/>')
            elif data == "clicks":
                out.append(f'<path {ic} d="M{tx - 4} {cy - 6}l8 4-3 1-1 3zM{tx + 4} {cy + 2}l3 3"/>')
            else:
                out.append(f'<rect {ic} x="{tx - 7}" y="{cy - 5}" width="14" height="10" rx="2"/>'
                           f'<path {ic} d="M{tx - 4} {cy - 2}h1M{tx} {cy - 2}h1M{tx + 4} {cy - 2}h1M{tx - 3} {cy + 2}h6"/>')
        elif kind == "colour":
            out.append(f'<rect x="{x + 4}" y="{cy - 7}" width="14" height="14" rx="4" fill="{data}" stroke="#fff" stroke-opacity=".25"/>')
            out.append(f'<text x="{x + 24}" y="{cy + 4.5}" {MONO} font-size="12" fill="#e6e8ee">{data}</text>')
        elif kind == "ratio":
            places[data] = (x, w)
            if data == ratio:
                out.append(f'<rect x="{x}" y="{cy - 12}" width="{w}" height="24" rx="12" fill="#34373f"/>')
            out.append(f'<text x="{x + w / 2}" y="{cy + 4.5}" class="t" font-size="12" fill="#e6e8ee" text-anchor="middle">{data}</text>')
        elif kind == "timer":
            if timer_on:
                out.append(f'<rect x="{x}" y="{top}" width="{w}" height="{bh}" rx="{bh / 2}" fill="#34373f"/>')
            out.append(mode_icon("Timer", x + 14, cy))
            out.append(f'<text x="{x + 26}" y="{cy + 4.5}" class="t" font-size="12.5" fill="#e6e8ee">{data}</text>')
            out.append(f'<rect x="{x + w - 21}" y="{cy - 8}" width="15" height="16" rx="4" fill="#ffffff" opacity=".12"/>')
            out.append(f'<text x="{x + w - 13.5}" y="{cy + 4}" class="t" font-size="10.5" fill="#c9ceda" text-anchor="middle">8</text>')
        elif kind == "main":
            places["main"] = (x, w)
            tone = "#ff4d4f" if record else "#2f81f7"
            glow = f' stroke="{tone}" stroke-opacity=".3" stroke-width="3"' if ready else ""
            out.append(f'<rect x="{x}" y="{top}" width="{w}" height="{bh}" rx="{bh / 2}" fill="{tone}" opacity="{1 if ready else .35}"{glow}/>')
            lx = x + 14
            if record:
                out.append(f'<circle cx="{x + 16}" cy="{cy}" r="4" fill="#fff" opacity="{1 if ready else .6}"/>')
                lx = x + 26
            out.append(f'<text x="{lx}" y="{cy + 4.5}" class="t b" font-size="12.5" fill="#fff" opacity="{1 if ready else .6}">{data}</text>')
            out.append(f'<text x="{x + w - 15}" y="{cy + 4}" {MONO} font-size="10" fill="#fff" opacity=".7" text-anchor="middle">⏎</text>')
        elif kind == "cancel":
            out.append(f'<path d="M{x + 11} {cy - 4}l8 8M{x + 19} {cy - 4}l-8 8" stroke="#8b93a1" stroke-width="1.6" stroke-linecap="round"/>')
        x += w + gap
    return "".join(out), left, width, places
