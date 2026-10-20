// Pure geometry, layers, history and document validation for the layered graphic editor. No canvas, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/design_geom.js';
import { createHistory } from '../src/design_history.js';

const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);
const box = (o = {}) => ({ x: 100, y: 100, w: 200, h: 100, rotation: 0, ...o });
const el = (id, o = {}) => ({ id, type: 'shape', name: id, visible: true, locked: false, x: 0, y: 0, w: 100, h: 100, rotation: 0, ...o });

test('resize with the aspect lock keeps proportions from corner and side handles', () => {
  let r = G.resizeBox(box(), 'se', 40, 0, { lockAspect: true }); assert.deepEqual([r.x, r.y, r.w, r.h], [100, 100, 240, 120]); near(r.w / r.h, 2);
  r = G.resizeBox(box(), 'e', 50, 0, { lockAspect: true }); near(r.w, 250); near(r.h, 125); near(r.y, 100 - 12.5 + 0, 0.01 + 12.5); // grows about the centre line
  r = G.resizeBox(box(), 'nw', -20, -10, { lockAspect: true }); near(r.w / r.h, 2); near(r.x + r.w, 300); near(r.y + r.h, 200); // the opposite corner stays put
});
test('resize with the lock off changes width and height independently', () => {
  const r = G.resizeBox(box(), 'se', 40, 10, { lockAspect: false }); assert.deepEqual([r.w, r.h], [240, 110]); const s = G.resizeBox(box(), 's', 999, 30, { lockAspect: false }); assert.deepEqual([s.w, s.h], [200, 130], 'a side handle moves one dimension only');
});
test('resize never produces zero, negative or invalid dimensions', () => {
  const r = G.resizeBox(box(), 'se', -5000, -5000, { lockAspect: false }); assert.deepEqual([r.w, r.h], [G.LIMITS.minSize, G.LIMITS.minSize]); const l = G.resizeBox(box(), 'se', -5000, -5000, { lockAspect: true }); assert.ok(l.w >= G.LIMITS.minSize && l.h >= G.LIMITS.minSize); near(l.w / l.h, 2);
  assert.deepEqual(G.resizeBox(box(), 'se', NaN, Infinity), box(), 'invalid input leaves the box unchanged'); assert.equal(G.resizeBox(box(), 'se', 10, 10, { minW: 150, minH: 150, lockAspect: false }).w, 210);
});
test('resizing from the centre keeps the centre fixed', () => {
  const r = G.resizeBox(box(), 'se', 40, 0, { lockAspect: true, fromCenter: true }); near(r.x + r.w / 2, 200); near(r.y + r.h / 2, 150); near(r.w, 280);
});
test('resizing a rotated box keeps the opposite corner fixed in design space', () => {
  const b = box({ rotation: 30 }), before = G.corners(b)[0], r = G.resizeBox(b, 'se', 30, 20, { lockAspect: false }), after = G.corners({ ...r, rotation: 30 })[0]; near(before.x, after.x); near(before.y, after.y);
});
test('rotation: centre is the transform origin, corners and bounds follow, hit testing is rotated', () => {
  const b = { x: 0, y: 0, w: 100, h: 50, rotation: 90 }, bb = G.bounds(b); assert.deepEqual([bb.x, bb.y, bb.w, bb.h].map(Math.round), [25, -25, 50, 100]); const c = G.center(b); assert.deepEqual([c.x, c.y], [50, 25]);
  assert.equal(G.pointInElement({ x: 50, y: -20 }, b), true, 'inside the rotated frame'); assert.equal(G.pointInElement({ x: 5, y: 5 }, b), false, 'inside the unrotated frame only');
  near(G.normAngle(370), 10); near(G.normAngle(-190), 170); assert.equal(G.normAngle(180), 180); near(G.angleFromPointer({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: -100 }), 0); near(G.angleFromPointer({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 50 }), 90);
  assert.equal(G.snapAngle(14, 15, 4), 15); assert.equal(G.snapAngle(20, 15, 4), 20, 'outside the tolerance: no snap');
});
test('negative positions are allowed and canvas boundary alignment uses the rotated bounds', () => {
  const e = { x: -40, y: -10, w: 100, h: 50, rotation: 0 }; assert.equal(G.alignTo(e, { w: 400, h: 300 }, 'left').x, 0); assert.equal(G.alignTo(e, { w: 400, h: 300 }, 'right').x, 300); assert.equal(G.alignTo(e, { w: 400, h: 300 }, 'hcenter').x, 150); assert.equal(G.alignTo(e, { w: 400, h: 300 }, 'bottom').y, 250);
  const r = { x: 0, y: 0, w: 100, h: 50, rotation: 90 }, a = G.alignTo(r, { w: 400, h: 300 }, 'left'), bb = G.bounds(a); near(bb.x, 0);
  const d = G.sanitizeDoc({ version: 2, canvas: { w: 400, h: 300 }, elements: [{ id: 'a', type: 'shape', x: -250, y: -9e9, w: 50, h: 50 }] }); assert.equal(d.elements[0].x, -250, 'off-canvas positions are valid'); assert.equal(d.elements[0].y, -G.LIMITS.maxCoord, 'but absurd ones are clamped');
});
test('snapping: to canvas edges/centre and other elements; zero tolerance disables it', () => {
  const canvas = { w: 400, h: 300 }; let s = G.snapMove(el('a', { x: 148, y: 100, w: 100, h: 50 }), canvas); assert.equal(s.dx, 2, 'centre x 198 -> 200'); assert.ok(s.guides.some(g => g.axis === 'x' && g.pos === 200));
  s = G.snapMove(el('a', { x: 3, y: 100, w: 100, h: 50 }), canvas); assert.equal(s.dx, -3); s = G.snapMove(el('a', { x: 60, y: 100, w: 100, h: 50 }), canvas, [el('b', { x: 162, y: 250, w: 60, h: 20 })]); assert.equal(s.dx, 2, 'right edge to the other element left edge');
  s = G.snapMove(el('a', { x: 148, y: 100, w: 100, h: 50 }), canvas, [], [], 0); assert.deepEqual([s.dx, s.dy, s.guides.length], [0, 0, 0]); s = G.snapMove(el('a', { x: 80, y: 60, w: 50, h: 50 }), canvas, [], [{ axis: 'x', pos: 82 }]); assert.equal(s.dx, 2, 'user guide');
});
test('layers: order operations, reorder, visibility and lock in hit testing, duplicate, delete', () => {
  const a = el('a'), b = el('b'), c = el('c'), ids = l => l.map(e => e.id).join('');
  assert.equal(ids(G.moveLayer([a, b, c], 'a', 'forward')), 'bac'); assert.equal(ids(G.moveLayer([a, b, c], 'c', 'backward')), 'acb'); assert.equal(ids(G.moveLayer([a, b, c], 'a', 'front')), 'bca'); assert.equal(ids(G.moveLayer([a, b, c], 'c', 'back')), 'cab'); assert.equal(ids(G.moveLayer([a, b, c], 'c', 'forward')), 'abc', 'already on top');
  assert.equal(ids(G.reorderLayer([a, b, c], 'a', 2)), 'bca'); assert.equal(ids(G.reorderLayer([a, b, c], 'zz', 0)), 'abc');
  const stack = [el('bottom'), el('top')]; assert.equal(G.hitTest(stack, { x: 10, y: 10 }), 'top', 'topmost wins'); assert.equal(G.hitTest([el('bottom'), el('top', { locked: true })], { x: 10, y: 10 }), 'bottom', 'locked layers are never picked'); assert.equal(G.hitTest([el('bottom'), el('top', { visible: false })], { x: 10, y: 10 }), 'bottom'); assert.equal(G.hitTest(stack, { x: 500, y: 500 }), null);
  const d = G.duplicateLayer([{ ...a, role: 'headline', locked: true }, b], 'a'); assert.equal(d.elements.length, 3); assert.equal(d.elements[1].id, d.id); assert.notEqual(d.id, 'a'); assert.equal(d.elements[1].x, 24); assert.equal(d.elements[1].role, undefined); assert.equal(d.elements[1].locked, false, 'a copy is editable'); assert.equal(ids(G.removeLayer([a, b, c], 'b')), 'ac');
});
test('image rects: contain, cover, manual, blur; zoom and offsets are relative to the fit scale', () => {
  const f = { w: 200, h: 100, zoom: 1, ox: 0, oy: 0 }; let r = G.imageRects({ ...f, fit: 'contain' }, 400, 400); assert.deepEqual([r.fg.w, r.fg.h, r.fg.x, r.fg.y], [100, 100, 50, 0]); assert.equal(r.bg, null);
  r = G.imageRects({ ...f, fit: 'cover' }, 400, 400); assert.deepEqual([r.fg.w, r.fg.h, r.fg.x, r.fg.y], [200, 200, 0, -50]);
  r = G.imageRects({ ...f, fit: 'cover', zoom: 2, ox: 10 }, 400, 400); assert.deepEqual([r.fg.w, r.fg.h, r.fg.x], [400, 400, -100 + 10]);
  r = G.imageRects({ ...f, fit: 'manual', zoom: 1.5 }, 400, 400); assert.deepEqual([r.fg.w, r.fg.h], [300, 150], 'manual: the frame is the image box');
  r = G.imageRects({ ...f, fit: 'blur' }, 400, 400); assert.deepEqual([r.fg.w, r.fg.h], [100, 100]); assert.deepEqual([r.bg.w, r.bg.h], [200, 200], 'blurred backdrop covers the frame');
});
test('image fitting across ratios: wide image in a portrait frame, portrait image in landscape, square image anywhere', () => {
  const wide = G.imageRects({ w: 1080, h: 1350, fit: 'cover', zoom: 1 }, 1600, 900).fg; assert.equal(wide.h, 1350); near(wide.w, 1350 * 1600 / 900); assert.ok(wide.x < 0, 'cropped left/right');
  const wideContain = G.imageRects({ w: 1080, h: 1350, fit: 'contain', zoom: 1 }, 1600, 900).fg; assert.equal(wideContain.w, 1080); near(wideContain.h, 1080 * 900 / 1600); assert.ok(wideContain.y > 0, 'letterboxed top/bottom');
  const tall = G.imageRects({ w: 1200, h: 675, fit: 'cover', zoom: 1 }, 900, 1600).fg; assert.equal(tall.w, 1200); assert.ok(tall.h > 675 && tall.y < 0);
  for (const [w, h] of [[1080, 1080], [1080, 1350], [1200, 675], [1080, 1920]]) { const c = G.imageRects({ w, h, fit: 'cover', zoom: 1 }, 800, 800).fg; assert.ok(c.w >= w - 0.01 && c.h >= h - 0.01, `square fills ${w}x${h}`); }
});
test('resolution warnings explain enlargement and stay quiet for sharp images', () => {
  const e = { w: 1080, h: 1350, fit: 'cover', zoom: 1 }; assert.match(G.resolutionWarning(e, 500, 500).message, /enlarged/); assert.equal(G.resolutionWarning(e, 3000, 3000), null); assert.ok(G.enlargement({ ...e, zoom: 2 }, 3000, 3000) > G.enlargement(e, 3000, 3000), 'zoom increases enlargement'); assert.ok(G.resolutionWarning(e, 1500, 1500, 2), 'a 2x export needs more pixels');
});
test('changing the canvas: keep / scale / fit-image never silently destroy the design', () => {
  const doc = { version: 2, canvas: { w: 1080, h: 1080, bg: '#000000' }, elements: [el('photo', { type: 'image', role: 'photo', x: 0, y: 0, w: 1080, h: 1080 }), el('t', { type: 'text', x: 100, y: 800, w: 400, h: 100, size: 50 })] };
  const kept = G.convertCanvas(doc, 1080, 1350, 'keep'); assert.equal(kept.canvas.h, 1350); assert.deepEqual(kept.elements.map(e => [e.x, e.y, e.w, e.h]), doc.elements.map(e => [e.x, e.y, e.w, e.h]));
  const sc = G.convertCanvas(doc, 1200, 675, 'scale'); const t = sc.elements[1]; near(t.w, 400 * (675 / 1080)); assert.ok(t.x > 100 * (675 / 1080), 'layout is centred in the wider canvas'); near(t.size, 50 * (675 / 1080)); assert.equal(sc.elements[0].w, 1200, 'the full-bleed photo keeps bleeding');
  const fit = G.convertCanvas(doc, 1080, 1920, 'fit-image'); assert.deepEqual([fit.elements[0].x, fit.elements[0].y, fit.elements[0].w, fit.elements[0].h], [0, 0, 1080, 1920]); assert.equal(doc.canvas.h, 1080, 'the input is not mutated'); assert.deepEqual(G.safeArea({ w: 1000, h: 1000 }, 0.1), { x: 100, y: 100, w: 800, h: 800 });
});
test('documents from outside are validated: ids, types, ranges, canvas, assets', () => {
  const ok = { version: 2, canvas: { w: 400, h: 300 }, elements: [{ id: 'a', type: 'image', x: 'abc', y: Infinity, w: -5, h: 0, rotation: 725, opacity: 9, zoom: 1e9, asset: 12, fit: 'weird' }] }, d = G.sanitizeDoc(ok), e = d.elements[0];
  assert.equal(e.x, 0); assert.equal(e.y, 0); assert.equal(e.w, G.LIMITS.minSize); assert.equal(e.h, G.LIMITS.minSize); assert.equal(e.rotation, 5); assert.equal(e.opacity, 1); assert.equal(e.zoom, G.LIMITS.maxZoom); assert.equal(e.fit, 'cover'); assert.equal(e.asset, 12);
  for (const bad of [null, { version: 1 }, { ...ok, canvas: { w: 10, h: 10 } }, { ...ok, canvas: { w: 4096, h: 4096 } }, { ...ok, elements: [{ id: 'a b', type: 'shape' }] }, { ...ok, elements: [{ id: 'a', type: 'script' }] }, { ...ok, elements: [{ id: 'a', type: 'shape' }, { id: 'a', type: 'shape' }] }, { ...ok, elements: [{ id: 'a', type: 'image', asset: '../../etc/passwd' }] }, { ...ok, elements: Array.from({ length: 61 }, (_, i) => ({ id: 'e' + i, type: 'shape' })) }, { ...ok, elements: [{ id: 'a', type: 'shape', role: 'evil' }] }]) assert.throws(() => G.sanitizeDoc(bad));
  const t = G.sanitizeDoc({ version: 2, canvas: { w: 400, h: 300 }, elements: [{ id: 't', type: 'text', text: '<img src=x onerror=1>\u0000ok', color: 'red', font: 'comic' }] }).elements[0]; assert.equal(t.text, '<img src=x onerror=1>ok'); assert.equal(t.color, '#ffffff'); assert.equal(t.font, 'bold');
  assert.deepEqual(G.sanitizeDoc(G.sanitizeDoc(ok)), G.sanitizeDoc(ok), 'sanitising is idempotent');
});
test('history: a drag is one undo step; undo/redo; cancel; limit; dirty tracking', () => {
  const h = createHistory({ n: 0 }); assert.equal(h.dirty, false); h.begin(); for (let i = 1; i <= 50; i++) h.update({ n: i }); h.end(); assert.equal(h.doc.n, 50); assert.equal(h.canUndo, true); h.undo(); assert.equal(h.doc.n, 0, 'fifty pointer moves undo in ONE step'); assert.equal(h.canUndo, false); h.redo(); assert.equal(h.doc.n, 50); assert.equal(h.dirty, true);
  h.commit({ n: 60 }); h.commit({ n: 60 }); h.undo(); assert.equal(h.doc.n, 50, 'identical commits add nothing'); h.begin(); h.update({ n: 99 }); h.cancel(); assert.equal(h.doc.n, 50, 'Escape restores the pre-drag state'); h.begin(); h.update({ n: 51 }); h.undo(); assert.equal(h.doc.n, 50, 'undo during a drag cancels it');
  h.markSaved(); assert.equal(h.dirty, false); h.commit({ n: 70 }); assert.equal(h.dirty, true); h.undo(); assert.equal(h.dirty, false, 'back at the saved state'); h.commit({ n: 71 }); assert.equal(h.canRedo, false, 'a new change clears redo');
  const small = createHistory(0, { limit: 3 }); for (let i = 1; i <= 10; i++) small.commit(i); let steps = 0; while (small.canUndo) { small.undo(); steps++; } assert.equal(steps, 3); h.begin(); h.update({ n: 5 }); h.end(); h.reset({ n: 1 }); assert.equal(h.canUndo, false); assert.equal(h.dirty, false);
});
