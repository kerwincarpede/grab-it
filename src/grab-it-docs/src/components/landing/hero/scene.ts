// The hero demo's markup: a sample dashboard on a desktop, Grab-it's capture
// overlay with its magnifier, the Quick Access card and the image editor, all
// drawn in a fixed 1280×720 world that player.ts scales to fit. The HTML is
// built at build time, and it already shows the finished arrow in the editor,
// so the hero has a poster frame before (or without) JavaScript.
import { ARROW_FROM, ARROW_TO, ED, IMG } from './timeline';

const icon = (d: string, s = 18) =>
	`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const I = {
	select: '<path d="M6 3l12 8-5.5 1.4L10 18z"/>',
	pan: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
	arrow: '<path d="M6 18L18 6M9 6h9v9"/>',
	line: '<path d="M5 19L19 5"/>',
	rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
	ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
	pen: '<path d="M3 17c3-6 5-6 7-2s4 4 6-1 3-5 5-3"/>',
	text: '<path d="M5 6h14M12 6v13"/>',
	step: '<circle cx="12" cy="12" r="8"/><path d="M11 9.5l1.5-1V16"/>',
	highlight: '<path d="M14 4l6 6-8 8H6v-6zM4 21h7"/>',
	blur: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
	spotlight: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="4"/>',
	crop: '<path d="M6 2v16h16M2 6h16v16"/>',
	undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
	redo: '<path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/>',
	resize: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
	backdrop: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7" y="9" width="10" height="6" rx="1"/>',
	pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
	copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
	copyText: '<path d="M4 6h10M9 6v12M14 13h6M17 13v6"/>',
	export: '<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>',
	check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
};

/** Bar heights as a share of the chart's 190px, oldest first. The last is this week. */
export const BARS = [0.4, 0.48, 0.44, 0.58, 0.62, 0.55, 0.72, 0.95];
const WEEKS = ['Sep 29', 'Oct 6', 'Oct 13', 'Oct 20', 'Oct 27', 'Nov 3', 'Nov 10', 'This week'];

function dashboard() {
	const bars = BARS.map(
		(h, i) =>
			`<div class="b${i === 7 ? ' hi' : ''}" style="left:${40 + i * 110}px;height:${Math.round(h * 190)}px"></div><div class="xl" style="left:${40 + i * 110}px">${WEEKS[i]}</div>`,
	).join('');
	return `<div class="d-win">
<div class="d-bar"><i></i><i></i><i></i><span>sales-overview.html</span></div>
<div class="d-body">
<div class="d-head"><div><div class="d-eyebrow">Juniper Roasters</div><div class="d-h1">Weekly sales</div></div><div class="d-btn">Share</div></div>
<div class="d-kpis">
<div class="d-kpi"><span>Orders</span><b>3,482</b><em class="up">▲ 9.1%</em></div>
<div class="d-kpi"><span>Average basket</span><b>$18.40</b><em class="up">▲ 2.6%</em></div>
<div class="d-kpi"><span>Refunds</span><b>1.2%</b><em class="dn">▲ 0.3%</em></div>
</div>
<div class="d-chart"><div class="d-ct">Orders per week</div><div class="d-cs">Last 8 weeks</div>${bars}<div class="d-val">1,204</div></div>
<div class="d-foot">Signed in as sam@example.com · Long Street store</div>
</div></div>`;
}

const desktop = () => `<div class="wall"></div>${dashboard()}`;
/** The captured region: a copy of the desktop, cropped to the selection. */
const capture = () => `<div class="cap"><div class="cap-in">${desktop()}</div></div>`;

/** The editor's Classic arrow: a straight shaft and a filled head. */
export function arrowGeometry(sx: number, sy: number, ex: number, ey: number) {
	const dx = ex - sx;
	const dy = ey - sy;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const hl = Math.min(24, len * 0.6);
	const hw = 11;
	const bx = ex - ux * hl;
	const by = ey - uy * hl;
	const f = (n: number) => n.toFixed(1);
	return {
		shaft: `M${f(sx)} ${f(sy)}L${f(bx + ux * 2)} ${f(by + uy * 2)}`,
		head: `${f(ex)},${f(ey)} ${f(bx - uy * hw)},${f(by + ux * hw)} ${f(bx + uy * hw)},${f(by - ux * hw)}`,
	};
}

/** An arrow layer, drawn finished, with origin at (ox, oy) in the world. */
function arrowLayer(cls: string, w: number, h: number, ox: number, oy: number) {
	const g = arrowGeometry(ARROW_FROM[0] - ox, ARROW_FROM[1] - oy, ARROW_TO[0] - ox, ARROW_TO[1] - oy);
	return `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
<g class="arw"><path class="shaft" d="${g.shaft}" stroke="#ef4444" stroke-width="5" stroke-linecap="round" fill="none"/><polygon class="head" points="${g.head}" fill="#ef4444"/></g>
<g class="hdl" opacity="0"><circle r="6.5"/><circle r="6.5"/><circle r="6.5"/></g></svg>`;
}

function overlay() {
	return `<div class="ov">
<div class="dim"></div><div class="dim"></div><div class="dim"></div><div class="dim"></div>
<div class="sel"><i class="c-tl"></i><i class="c-tr"></i><i class="c-bl"></i><i class="c-br"></i></div>
<div class="size">0 × 0</div>
<div class="hint"><span>Drag to capture</span><span><kbd>Shift</kbd>Square</span><span><kbd>Space</kbd>Move</span><span><kbd>Esc</kbd>Cancel</span></div>
<div class="mag"><div class="mag-view"><div class="mag-inner">${desktop()}</div><div class="mag-grid"></div><div class="mag-c"></div></div><div class="mag-info"><i></i><span class="hex">#F3F4F7</span><span class="xy">0, 0</span></div></div>
</div>`;
}

function quickAccess() {
	return `<div class="qa">
<div class="qa-thumb">${capture()}</div>
<div class="qa-t">${icon(I.check, 16)}Copied and saved</div>
<div class="qa-s">Grab-it 2026-11-19 10-42-07.png</div>
<div class="qa-b" style="left:14px;width:70px">${icon(I.copy, 15)}Copy</div>
<div class="qa-b ann" style="left:90px;width:98px">${icon(I.pencil, 15)}Annotate</div>
<div class="qa-b" style="left:194px;width:58px">Pin</div>
<div class="qa-b" style="left:258px;width:40px">${icon(I.folder, 15)}</div>
</div>`;
}

function editor() {
	const swatches = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#ffffff', '#ec4899'];
	const tools = ['select', 'pan', 'arrow', 'line', 'rect', 'ellipse', 'pen', 'text', 'step', 'highlight', 'blur', 'spotlight', 'crop'] as const;
	return `<div class="ed">
<div class="ed-bar"><i></i><i></i><i></i><span>Grab-it 2026-11-19 at 10.42.07.png · Grab-it Editor</span></div>
<div class="ed-top">
${swatches.map((c, i) => `<span class="sw${i === 0 ? ' on' : ''}" style="left:${18 + i * 30}px;background:${c}"></span>`).join('')}
<span class="ed-w" style="left:274px"><i></i>4px</span>
<span class="ed-ic" style="left:340px">${icon(I.undo)}</span><span class="ed-ic" style="left:372px">${icon(I.redo)}</span>
<span class="ed-tb" style="left:420px">${icon(I.resize, 16)}Resize</span>
<span class="ed-tb" style="left:516px">${icon(I.backdrop, 16)}Backdrop</span>
<span class="ed-tb" style="left:850px;width:60px">${icon(I.pin, 16)}Pin</span>
<span class="ed-tb copy" style="left:914px;width:70px">${icon(I.copy, 16)}Copy</span>
<span class="ed-tb" style="left:988px;width:100px">${icon(I.copyText, 16)}Copy text</span>
<span class="ed-tb ex" style="left:1092px;width:96px">${icon(I.export, 16)}Export…</span>
</div>
<div class="ed-rail">${tools.map((n, i) => `<span class="tl${i === 2 ? ' on' : ''}" style="top:${12 + i * 40}px">${icon(I[n])}</span>`).join('')}</div>
<div class="ed-canvas"></div>
<div class="ed-img">${capture()}</div>
${arrowLayer('ed-svg', 1200, 664, ED.x, ED.y)}
<div class="ed-tip">Arrow <kbd>A</kbd></div>
<div class="ed-toast">${icon(I.check, 16)}Copied to clipboard</div>
<div class="ed-status"><span>Grab-it 2026-11-19 at 10.42.07.png</span><span>1920 × 648</span><span class="grow"></span><span class="saved">Annotations saved</span><span>100%</span></div>
</div>`;
}

const pointer = () => `<div class="ripple"></div>
<div class="ptr"><svg class="p-arrow" width="24" height="28" viewBox="0 0 24 28" aria-hidden="true"><path d="M3 2v19.5l5.3-4.8 3.6 8 3.4-1.5-3.5-7.8h7.2z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg><svg class="p-cross" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 1v10M14 17v10M1 14h10M17 14h10" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M14 1.5v9.5M14 17v9.5M1.5 14H11M17 14h9.5" stroke="#111" stroke-width="1.4" stroke-linecap="round"/></svg></div>`;

/** A capture as a thick slab: a face and four sides, so it has depth when it tilts. */
const slab = (cls: string, withArrow: boolean) =>
	`<div class="slab-shadow ${cls}-shadow"></div><div class="slab ${cls}"><div class="side s-t"></div><div class="side s-b"></div><div class="side s-l"></div><div class="side s-r"></div><div class="face">${capture()}${withArrow ? arrowLayer('slab-svg', 960, 324, IMG.x, IMG.y) : ''}</div></div>`;

/** Everything inside the stage. */
export function sceneHTML() {
	return `<div class="void"></div><div class="scaler"><div class="cam"><div class="rig">
<div class="plane desk">${desktop()}${overlay()}${quickAccess()}<div class="flash"></div></div>
<div class="plane edp">${editor()}</div>
${slab('cap', false)}${slab('fin', true)}
${pointer()}
</div></div></div>
<div class="hud"><kbd>PrtSc</kbd><span>or ⌘ ⇧ 2 on a Mac</span></div>`;
}
