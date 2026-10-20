// Shared design geometry: PURE functions, no DOM and no canvas, imported by the server renderer AND the browser editor.
// Coordinate system (the only one used anywhere): DESIGN PIXELS of the canvas, origin top-left, +x right, +y down.
// An element's frame is {x, y, w, h}: the UNROTATED box. Rotation is in degrees, clockwise, about the frame CENTRE. Editor workspace zoom never changes these numbers.
// Render order of every element: translate(centre) -> rotate -> translate(-w/2,-h/2), then clip (in the rotated local frame), then draw.

export const DOC_VERSION = 2;
export const CANVAS_PRESETS = { square: { w: 1080, h: 1080, name: 'Square 1:1' }, portrait: { w: 1080, h: 1350, name: 'Portrait 4:5' }, portrait34: { w: 1080, h: 1440, name: 'Portrait 3:4' }, landscape: { w: 1200, h: 675, name: 'Landscape 16:9' }, vertical: { w: 1080, h: 1920, name: 'Vertical 9:16' } };
export const LIMITS = { minCanvas: 64, maxCanvas: 4096, maxPixels: 16e6, maxElements: 60, minSize: 4, maxCoord: 20000, maxZoom: 20, minZoom: 0.05 };
const TYPES = new Set(['image', 'text', 'shape', 'gradient', 'badge']), FITS = new Set(['contain', 'cover', 'blur', 'manual']), FONTS = new Set(['head', 'sub', 'bold', 'small', 'badge']), ALIGNS = new Set(['left', 'center', 'right']);
const ROLES = new Set(['photo', 'logo', 'headline', 'subheadline', 'category', 'date', 'source', 'footer', 'url', 'badge', 'overlay', 'gradient', 'band', 'accent', 'decor']);
export const rad = d => (d * Math.PI) / 180;
export const normAngle = a => { let r = ((a % 360) + 360) % 360; if (r > 180) r -= 360; return r === -0 ? 0 : r; };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d);
const r3 = v => Math.round(v * 1000) / 1000;

export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export function rotatePoint(p, c, deg) { const a = rad(deg), cs = Math.cos(a), sn = Math.sin(a), dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs }; }
// the four corners of the rotated frame in design pixels: tl, tr, br, bl
export function corners(el) { const c = center(el), pts = [{ x: el.x, y: el.y }, { x: el.x + el.w, y: el.y }, { x: el.x + el.w, y: el.y + el.h }, { x: el.x, y: el.y + el.h }]; return pts.map(p => rotatePoint(p, c, el.rotation || 0)); }
export function bounds(el) { const cs = corners(el), xs = cs.map(p => p.x), ys = cs.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
export function pointInElement(p, el) { const q = rotatePoint(p, center(el), -(el.rotation || 0)); return q.x >= el.x && q.x <= el.x + el.w && q.y >= el.y && q.y <= el.y + el.h; }
export const toLocal = (p, el) => { const q = rotatePoint(p, center(el), -(el.rotation || 0)); return { x: q.x - el.x, y: q.y - el.y }; };

/* ---- how an image sits inside its frame (frame-local coordinates, origin = frame top-left) ----
   zoom is RELATIVE to the fit scale of the mode (1 = exactly contain/cover/manual size); ox/oy move the image inside the frame in design pixels.
   contain: whole image visible, aspect kept.  cover: frame filled, aspect kept, overflow cropped.  manual: the frame IS the image box (w×h as typed; stretched only if the aspect lock is off).
   blur: a blurred cover copy behind a contained sharp copy. */
export function imageRects(el, iw, ih) {
  const z = clamp(num(el.zoom, 1), LIMITS.minZoom, LIMITS.maxZoom), ox = num(el.ox, 0), oy = num(el.oy, 0), fit = el.fit || 'cover';
  const place = (dw, dh) => ({ x: (el.w - dw) / 2 + ox, y: (el.h - dh) / 2 + oy, w: dw, h: dh });
  const contain = () => { const s = Math.min(el.w / iw, el.h / ih) * z; return place(iw * s, ih * s); }, cover = (zz = z) => { const s = Math.max(el.w / iw, el.h / ih) * zz; return { x: (el.w - iw * s) / 2 + (zz === z ? ox : 0), y: (el.h - ih * s) / 2 + (zz === z ? oy : 0), w: iw * s, h: ih * s }; };
  if (fit === 'contain') return { fg: contain(), bg: null };
  if (fit === 'manual') return { fg: place(el.w * z, el.h * z), bg: null };
  if (fit === 'blur') return { fg: contain(), bg: cover(1) };
  return { fg: cover(), bg: null };
}
// device pixels per source pixel for the sharp copy of the image; > 1 means the photo is being enlarged
export const enlargement = (el, iw, ih) => { const r = imageRects(el, iw, ih).fg; return Math.max(r.w / iw, r.h / ih); };
export function resolutionWarning(el, iw, ih, exportScale = 1) { const e = enlargement(el, iw, ih) * exportScale; return e > 1.5 ? { code: 'photo_low_resolution', severity: 'warn', message: `The photo is enlarged ${e.toFixed(1)}× (${iw}×${ih}px source); it may look soft or pixelated at this size.` } : null; }

/* ---- resizing: handles are 'nw','n','ne','e','se','s','sw','w'; dx,dy are DESIGN-pixel pointer deltas since the drag started ---- */
const HANDLE = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
export function resizeBox(start, handle, dx, dy, { lockAspect = true, fromCenter = false, minW = LIMITS.minSize, minH = LIMITS.minSize, aspect = null } = {}) {
  const [sx, sy] = HANDLE[handle]; if (!sx && !sy) return { ...start };
  const rot = start.rotation || 0, d = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rot), f = fromCenter ? 2 : 1, ar = aspect || start.w / start.h;
  let nw = start.w + sx * d.x * f, nh = start.h + sy * d.y * f;
  if (lockAspect) {
    if (sx && sy) { const s = Math.abs(nw / start.w - 1) >= Math.abs(nh / start.h - 1) ? nw / start.w : nh / start.h; nw = start.w * s; nh = nw / ar; } else if (sx) nh = nw / ar; else nw = nh * ar;
    nw = Math.max(nw, minW, minH * ar); nh = nw / ar; // never smaller than the minimum (or inverted by a huge drag), aspect preserved
  } else { nw = Math.max(minW, nw); nh = Math.max(minH, nh); }
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return { ...start };
  const shift = fromCenter ? { x: 0, y: 0 } : { x: sx * (nw - start.w) / 2, y: sy * (nh - start.h) / 2 }, c0 = center(start), c1 = rotatePoint({ x: c0.x + shift.x, y: c0.y + shift.y }, c0, rot);
  return { ...start, x: r3(c1.x - nw / 2), y: r3(c1.y - nh / 2), w: r3(nw), h: r3(nh) };
}
// Rotating by dragging: angle of the pointer around the centre (0° = pointing up), optional snapping.
export const angleFromPointer = (el, p) => { const c = center(el); return normAngle((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90); };
export const snapAngle = (a, step = 15, tol = 4) => { const n = Math.round(a / step) * step; return Math.abs(a - n) <= tol ? normAngle(n) : normAngle(a); };

/* ---- snapping and alignment (on the rotated element's bounding box) ---- */
export function snapMove(el, canvas, others = [], guides = [], tol = 6) {
  if (!(tol > 0)) return { dx: 0, dy: 0, guides: [] }; // snapping switched off (the editor passes 0 while Alt is held)
  const b = bounds(el), xs = [{ at: 0 }, { at: canvas.w / 2 }, { at: canvas.w }, ...guides.filter(g => g.axis === 'x').map(g => ({ at: g.pos }))], ys = [{ at: 0 }, { at: canvas.h / 2 }, { at: canvas.h }, ...guides.filter(g => g.axis === 'y').map(g => ({ at: g.pos }))];
  for (const o of others) { const ob = bounds(o); xs.push({ at: ob.x }, { at: ob.x + ob.w / 2 }, { at: ob.x + ob.w }); ys.push({ at: ob.y }, { at: ob.y + ob.h / 2 }, { at: ob.y + ob.h }); }
  const pick = (mine, targets) => { let best = null; for (const m of mine) for (const t of targets) { const d = t.at - m; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t.at }; } return best; };
  const bx = pick([b.x, b.x + b.w / 2, b.x + b.w], xs), by = pick([b.y, b.y + b.h / 2, b.y + b.h], ys);
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides: [...(bx ? [{ axis: 'x', pos: bx.at }] : []), ...(by ? [{ axis: 'y', pos: by.at }] : [])] };
}
export function alignTo(el, canvas, how) { // moves the element so its (rotated) bounds touch the chosen canvas edge/centre
  const b = bounds(el); const t = { left: [-b.x, 0], hcenter: [canvas.w / 2 - (b.x + b.w / 2), 0], right: [canvas.w - (b.x + b.w), 0], top: [0, -b.y], vcenter: [0, canvas.h / 2 - (b.y + b.h / 2)], bottom: [0, canvas.h - (b.y + b.h)] }[how]; if (!t) return { ...el };
  return { ...el, x: r3(el.x + t[0]), y: r3(el.y + t[1]) };
}

/* ---- layers (array order = paint order, index 0 is the BACK layer; the editor lists them top-first) ---- */
export function moveLayer(els, id, how) {
  const i = els.findIndex(e => e.id === id); if (i < 0) return els; const a = [...els], [e] = a.splice(i, 1), j = how === 'front' ? a.length : how === 'back' ? 0 : how === 'forward' ? Math.min(a.length, i + 1) : Math.max(0, i - 1); a.splice(j, 0, e); return a;
}
export function reorderLayer(els, id, toIndex) { const i = els.findIndex(e => e.id === id); if (i < 0) return els; const a = [...els], [e] = a.splice(i, 1); a.splice(clamp(toIndex, 0, a.length), 0, e); return a; }
export const newId = (els, base = 'el') => { const used = new Set(els.map(e => e.id)); let n = 1; while (used.has(`${base}-${n}`)) n++; return `${base}-${n}`; };
export function duplicateLayer(els, id) { const i = els.findIndex(e => e.id === id); if (i < 0) return { elements: els, id: null }; const src = els[i], nid = newId(els, src.type), copy = { ...JSON.parse(JSON.stringify(src)), id: nid, name: `${src.name || src.type} copy`, x: src.x + 24, y: src.y + 24, locked: false }; delete copy.role; const a = [...els]; a.splice(i + 1, 0, copy); return { elements: a, id: nid }; }
export const removeLayer = (els, id) => els.filter(e => e.id !== id);
// topmost visible, unlocked element under a design-pixel point
export function hitTest(els, p) { for (let i = els.length - 1; i >= 0; i--) { const e = els[i]; if (e.visible !== false && !e.locked && pointInElement(p, e)) return e.id; } return null; }

/* ---- changing the canvas size without silently destroying the design ---- */
export function convertCanvas(doc, w, h, mode = 'scale') {
  const out = JSON.parse(JSON.stringify(doc)), sx = w / doc.canvas.w, sy = h / doc.canvas.h, s = Math.min(sx, sy); out.canvas = { ...out.canvas, w, h };
  if (mode === 'keep') return out; // positions and sizes stay as they are (they may now sit off-canvas)
  const ox = (w - doc.canvas.w * s) / 2, oy = (h - doc.canvas.h * s) / 2; // uniform scale, layout centred in the new canvas
  for (const e of out.elements) {
    const full = e.type === 'image' && e.role === 'photo' || e.role === 'overlay' || e.role === 'gradient' || e.role === 'band';
    if (mode === 'fit-image' && e.type === 'image' && e.role === 'photo') { Object.assign(e, { x: 0, y: 0, w, h, rotation: 0, ox: 0, oy: 0, zoom: 1 }); continue; }
    if (full && e.w >= doc.canvas.w - 1) { Object.assign(e, { x: r3(e.x * sx), w: r3(e.w * sx), y: r3(e.y * sy), h: r3(e.h * sy) }); continue; } // full-bleed layers keep bleeding
    e.x = r3(ox + e.x * s); e.y = r3(oy + e.y * s); e.w = r3(e.w * s); e.h = r3(e.h * s); if (e.size) e.size = r3(e.size * s); if (e.lineHeight) e.lineHeight = r3(e.lineHeight * s); if (e.ox) e.ox = r3(e.ox * s); if (e.oy) e.oy = r3(e.oy * s); if (e.radius) e.radius = r3(e.radius * s);
  }
  return out;
}
// Stories/Reels (9:16 and taller): Instagram's own interface covers about the top 14% and bottom 17%, so the safe area is narrower there.
export const safeArea = (canvas, f = 0.06) => { const tall = canvas.h / canvas.w >= 1.7, top = tall ? 0.14 : f, bottom = tall ? 0.17 : f, y = Math.round(canvas.h * top); return { x: Math.round(canvas.w * f), y, w: Math.round(canvas.w * (1 - 2 * f)), h: Math.round(canvas.h * (1 - bottom)) - y }; };

/* ---- validation of untrusted documents (saved JSON, request bodies) ---- */
const hexC = (c, d) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : d), str = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
export function sanitizeDoc(input) {
  if (!input || typeof input !== 'object' || input.version !== DOC_VERSION) throw new Error('not a version 2 design document');
  const cw = Math.round(num(input.canvas?.w, NaN)), ch = Math.round(num(input.canvas?.h, NaN)); if (!(cw >= LIMITS.minCanvas && cw <= LIMITS.maxCanvas && ch >= LIMITS.minCanvas && ch <= LIMITS.maxCanvas) || cw * ch > LIMITS.maxPixels) throw new Error('canvas size is out of range');
  if (!Array.isArray(input.elements) || input.elements.length > LIMITS.maxElements) throw new Error(`a design may have at most ${LIMITS.maxElements} elements`);
  const seen = new Set(), C = LIMITS.maxCoord, els = input.elements.map(raw => {
    if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) throw new Error('unknown element type'); const id = str(raw.id, 40); if (!/^[\w-]{1,40}$/.test(id) || seen.has(id)) throw new Error('element ids must be unique short names'); seen.add(id);
    const e = { id, type: raw.type, name: str(raw.name, 60) || raw.type, visible: raw.visible !== false, locked: raw.locked === true, x: clamp(num(raw.x, 0), -C, C), y: clamp(num(raw.y, 0), -C, C), w: clamp(num(raw.w, 100), LIMITS.minSize, C), h: clamp(num(raw.h, 100), LIMITS.minSize, C), rotation: normAngle(num(raw.rotation, 0)), opacity: clamp(num(raw.opacity, 1), 0, 1), lockAspect: raw.lockAspect !== false };
    if (raw.role) { if (!ROLES.has(raw.role)) throw new Error('unknown element role'); e.role = raw.role; }
    if (raw.type === 'image') Object.assign(e, { asset: raw.asset === 'photo' || raw.asset === 'logo' || raw.asset === null || raw.asset === undefined ? (raw.asset ?? null) : (Number.isInteger(raw.asset) && raw.asset > 0 ? raw.asset : (() => { throw new Error('invalid asset reference'); })()), fit: FITS.has(raw.fit) ? raw.fit : 'cover', zoom: clamp(num(raw.zoom, 1), LIMITS.minZoom, LIMITS.maxZoom), ox: clamp(num(raw.ox, 0), -C, C), oy: clamp(num(raw.oy, 0), -C, C), clip: raw.clip !== false, radius: clamp(num(raw.radius, 0), 0, 2000), grayscale: raw.grayscale === true, blur: clamp(num(raw.blur, 28), 0, 120), backing: raw.backing === true, pad: clamp(num(raw.pad, 0), 0, 500) });
    if (raw.type === 'text') Object.assign(e, { text: str(raw.text, 2000), font: FONTS.has(raw.font) ? raw.font : 'bold', size: clamp(num(raw.size, 40), 6, 600), lineHeight: clamp(num(raw.lineHeight, num(raw.size, 40) * 1.28), 6, 900), color: hexC(raw.color, '#ffffff'), accent: hexC(raw.accent, '#d62828'), align: ALIGNS.has(raw.align) ? raw.align : 'left', maxLines: Math.round(clamp(num(raw.maxLines, 0), 0, 50)), shrink: raw.shrink === true, middle: raw.middle === true, literal: raw.literal === true, baseline: clamp(num(raw.baseline, 0.82), 0.5, 1) });
    if (raw.type === 'shape') Object.assign(e, { fill: hexC(raw.fill, '#000000'), alpha: clamp(num(raw.alpha, 1), 0, 1), radius: clamp(num(raw.radius, 0), 0, 2000) });
    if (raw.type === 'gradient') Object.assign(e, { stops: (Array.isArray(raw.stops) ? raw.stops : []).slice(0, 8).map(s => ({ at: clamp(num(s.at, 0), 0, 1), color: hexC(s.color, '#000000'), alpha: clamp(num(s.alpha, 1), 0, 1) })) });
    if (raw.type === 'badge') Object.assign(e, { left: str(raw.left, 24), right: str(raw.right, 24), leftColor: hexC(raw.leftColor, '#d62828'), rightColor: hexC(raw.rightColor, '#1f4e8c'), textColor: hexC(raw.textColor, '#ffffff') });
    return e;
  });
  return { version: DOC_VERSION, canvas: { w: cw, h: ch, bg: hexC(input.canvas?.bg, '#0a0d12') }, elements: els, meta: { format: str(input.meta?.format, 20), safe: clamp(num(input.meta?.safe, 0.06), 0, 0.3) } };
}
