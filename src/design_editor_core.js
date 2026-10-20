// The editor's interaction logic as PURE functions (no DOM): what a drag, a numeric entry, a key press or a preset does to a document.
// The browser code in admin/editor.js only translates pointer/keyboard events into these calls, which is what the tests exercise.
import * as G from './design_geom.js';

export const replaceEl = (doc, id, patch) => ({ ...doc, elements: doc.elements.map(e => (e.id === id ? { ...e, ...patch } : e)) });
export const getEl = (doc, id) => doc.elements.find(e => e.id === id) ?? null;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const r2 = v => Math.round(v * 100) / 100;

// A typed value in the properties panel. Returns { doc, error }: invalid input never changes the document.
export function applyProp(doc, id, key, raw, { minSize = G.LIMITS.minSize } = {}) {
  const el = getEl(doc, id); if (!el) return { doc, error: 'no such element' };
  const v = typeof raw === 'string' && raw.trim() === '' ? NaN : +raw; const same = (error) => ({ doc, error });
  if (['x', 'y', 'ox', 'oy'].includes(key)) { if (!finite(v)) return same('Enter a number.'); return { doc: replaceEl(doc, id, { [key]: r2(G.clamp(v, -G.LIMITS.maxCoord, G.LIMITS.maxCoord)) }) }; }
  if (key === 'w' || key === 'h') {
    if (!finite(v) || v <= 0) return same('Size must be a positive number.'); const nv = Math.max(minSize, Math.min(G.LIMITS.maxCoord, v));
    if (!el.lockAspect) return { doc: replaceEl(doc, id, { [key]: r2(nv) }) };
    const ar = el.w / el.h, w = key === 'w' ? nv : nv * ar, h = key === 'h' ? nv : nv / ar, c = G.center(el); // proportional; grows around the centre so the element does not jump
    if (w < minSize || h < minSize) return same(`Smallest size is ${minSize} px.`);
    return { doc: replaceEl(doc, id, { w: r2(w), h: r2(h), x: r2(c.x - w / 2), y: r2(c.y - h / 2) }) };
  }
  if (key === 'rotation') { if (!finite(v)) return same('Enter an angle in degrees.'); return { doc: replaceEl(doc, id, { rotation: r2(G.normAngle(v)) }) }; }
  if (key === 'opacity') { if (!finite(v)) return same('Enter a number between 0 and 1.'); return { doc: replaceEl(doc, id, { opacity: G.clamp(v, 0, 1) }) }; }
  if (key === 'zoom') { if (!finite(v) || v <= 0) return same('Zoom must be a positive number.'); return { doc: replaceEl(doc, id, { zoom: G.clamp(v, G.LIMITS.minZoom, G.LIMITS.maxZoom) }) }; }
  if (key === 'lockAspect') return { doc: replaceEl(doc, id, { lockAspect: !!raw }) };
  return { doc: replaceEl(doc, id, { [key]: raw }) }; // fit, clip, radius, colours, text ... (validated again by the server)
}

// Dragging an element. start = the element as it was when the pointer went down; dx/dy are DESIGN-pixel deltas (screen delta / workspace zoom).
export function dragMove(start, dx, dy, { canvas, others = [], guides = [], snap = true, axisLock = false, tol = 6 } = {}) {
  if (start.locked) return { patch: {}, guides: [] };
  if (axisLock) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  let moved = { ...start, x: start.x + dx, y: start.y + dy }, g = [];
  if (snap) { const s = G.snapMove(moved, canvas, others.filter(o => o.id !== start.id && o.visible !== false), guides, tol); moved = { ...moved, x: moved.x + s.dx, y: moved.y + s.dy }; g = s.guides; }
  return { patch: { x: r2(moved.x), y: r2(moved.y) }, guides: g };
}
// shift inverts the aspect lock for this drag; alt resizes from the centre
export function dragResize(start, handle, dx, dy, { shift = false, alt = false } = {}) {
  if (start.locked) return {}; const lock = shift ? !start.lockAspect : !!start.lockAspect, r = G.resizeBox(start, handle, dx, dy, { lockAspect: lock, fromCenter: alt });
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}
export const dragRotate = (start, point, { snap = false } = {}) => { if (start.locked) return {}; const a = G.angleFromPointer(start, point); return { rotation: r2(snap ? G.snapAngle(a, 15, 7.5) : a) }; };

// Where the 8 resize handles and the rotation handle sit (design pixels), for drawing and hit-testing
export function handlePoints(el, zoom, { handle = 8, rotateDistance = 30 } = {}) {
  const c = G.center(el), rot = el.rotation || 0, mid = (x, y) => G.rotatePoint({ x, y }, c, rot), r = {
    nw: mid(el.x, el.y), n: mid(el.x + el.w / 2, el.y), ne: mid(el.x + el.w, el.y), e: mid(el.x + el.w, el.y + el.h / 2), se: mid(el.x + el.w, el.y + el.h), s: mid(el.x + el.w / 2, el.y + el.h), sw: mid(el.x, el.y + el.h), w: mid(el.x, el.y + el.h / 2),
    rotate: G.rotatePoint({ x: el.x + el.w / 2, y: el.y - rotateDistance / zoom }, c, rot),
  }; return { points: r, radius: handle / zoom };
}
export function hitHandle(el, p, zoom, opts = {}) { const { points, radius } = handlePoints(el, zoom, opts); for (const [k, q] of Object.entries(points)) if (Math.hypot(p.x - q.x, p.y - q.y) <= radius * 1.4) return k; return null; }

// Keyboard: returns an action or null. Typing in a field is never intercepted.
export function keyAction(e, { nudge = 1, bigNudge = 10 } = {}) {
  if (e.typing) return null; const mod = e.ctrl || e.meta, k = e.key;
  if (mod && k.toLowerCase() === 'z') return { type: e.shift ? 'redo' : 'undo' }; if (mod && k.toLowerCase() === 'y') return { type: 'redo' };
  if (mod && k.toLowerCase() === 's') return { type: 'save' }; if (mod && k.toLowerCase() === 'd') return { type: 'duplicate' };
  if (k === 'Delete' || k === 'Backspace') return { type: 'delete' }; if (k === 'Escape') return { type: 'escape' };
  const step = e.shift ? bigNudge : nudge, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
  return d ? { type: 'nudge', dx: d[0], dy: d[1] } : null;
}
export function nudge(doc, id, dx, dy) { const el = getEl(doc, id); if (!el || el.locked || el.visible === false) return doc; return replaceEl(doc, id, { x: r2(el.x + dx), y: r2(el.y + dy) }); }

// Image buttons. iw/ih = the original file's size; nothing here touches the file.
export function imagePreset(el, preset, iw, ih, canvas) {
  const reset = { zoom: 1, ox: 0, oy: 0 };
  if (preset === 'fit') return { fit: 'contain', ...reset }; if (preset === 'fill') return { fit: 'cover', ...reset }; if (preset === 'blur') return { fit: 'blur', ...reset };
  if (preset === 'original') { const s = Math.min(1, canvas.w / iw, canvas.h / ih), w = iw * s, h = ih * s, c = G.center(el); return { fit: 'manual', ...reset, lockAspect: true, w: r2(w), h: r2(h), x: r2(c.x - w / 2), y: r2(c.y - h / 2) }; } // natural size (reduced only if it would not fit the canvas)
  if (preset === 'reset') return { ...reset, rotation: 0 };
  if (preset === 'center') return { ox: 0, oy: 0 };
  return {};
}
export function defaultElement(type, canvas, els, extra = {}) {
  const id = G.newId(els, type), base = { id, type, name: { text: 'Text', shape: 'Rectangle', image: 'Image', gradient: 'Gradient' }[type] ?? type, visible: true, locked: false, rotation: 0, opacity: 1, lockAspect: true };
  const cx = canvas.w / 2, cy = canvas.h / 2;
  if (type === 'text') return { ...base, x: r2(cx - 300), y: r2(cy - 40), w: 600, h: 80, text: 'New text', font: 'bold', size: 48, lineHeight: 62, color: '#ffffff', accent: '#d62828', align: 'left', baseline: 0.82, lockAspect: false, ...extra };
  if (type === 'shape') return { ...base, x: r2(cx - 150), y: r2(cy - 100), w: 300, h: 200, fill: '#d62828', alpha: 1, radius: 0, lockAspect: false, ...extra };
  if (type === 'image') return { ...base, x: r2(cx - 200), y: r2(cy - 150), w: 400, h: 300, asset: null, fit: 'cover', zoom: 1, ox: 0, oy: 0, clip: true, radius: 0, grayscale: false, blur: 28, ...extra };
  if (type === 'gradient') return { ...base, x: 0, y: r2(canvas.h * 0.5), w: canvas.w, h: r2(canvas.h * 0.5), stops: [{ at: 0, color: '#000000', alpha: 0 }, { at: 1, color: '#000000', alpha: 0.9 }], lockAspect: false, ...extra };
  return base;
}
// Layers panel model: listed top-first; reordering by drop position
export const layerRows = doc => [...doc.elements].reverse().map((e, i, a) => ({ id: e.id, name: e.name, type: e.type, role: e.role ?? null, visible: e.visible !== false, locked: !!e.locked, index: a.length - 1 - i }));
export const dropLayer = (doc, id, rowIndexTopFirst) => ({ ...doc, elements: G.reorderLayer(doc.elements, id, doc.elements.length - 1 - rowIndexTopFirst) });
export const renameLayer = (doc, id, name) => replaceEl(doc, id, { name: String(name ?? '').trim().slice(0, 60) || getEl(doc, id)?.name });
export const toggleProp = (doc, id, key) => { const el = getEl(doc, id); return el ? replaceEl(doc, id, { [key]: key === 'visible' ? el.visible === false : !el[key] }) : doc; };
export const unlockedWarning = el => (el.type === 'image' && !el.lockAspect ? 'Aspect lock is off: the image can be stretched.' : '');
