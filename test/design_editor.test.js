// What the editor does with pointer drags, typed values, key presses and buttons (pure core; the browser glue only forwards events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/design_editor_core.js';
import * as G from '../src/design_geom.js';
import { createHistory } from '../src/design_history.js';

const canvas = { w: 400, h: 300 };
const img = (o = {}) => ({ id: 'photo-1', type: 'image', name: 'Article image', role: 'photo', visible: true, locked: false, x: 100, y: 80, w: 200, h: 100, rotation: 0, opacity: 1, lockAspect: true, fit: 'manual', zoom: 1, ox: 0, oy: 0, clip: true, ...o });
const doc = (els) => ({ version: 2, canvas: { ...canvas, bg: '#000000' }, elements: els });

test('numeric X/Y entry: exact values, negatives, rejects text and blanks without changing anything', () => {
  const d = doc([img()]); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'x', '12.5').doc, 'photo-1').x, 12.5); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'y', '-40').doc, 'photo-1').y, -40);
  for (const bad of ['abc', '', '  ', 'NaN', 'Infinity']) { const r = C.applyProp(d, 'photo-1', 'x', bad); assert.ok(r.error, bad); assert.equal(r.doc, d, 'the document is untouched by invalid input'); }
});
test('numeric width/height: proportional when locked (around the centre), independent when unlocked, never zero or negative', () => {
  const d = doc([img()]); let r = C.getEl(C.applyProp(d, 'photo-1', 'w', '400').doc, 'photo-1'); assert.deepEqual([r.w, r.h], [400, 200]); assert.deepEqual([r.x + r.w / 2, r.y + r.h / 2], [200, 130], 'does not jump');
  r = C.getEl(C.applyProp(d, 'photo-1', 'h', '50').doc, 'photo-1'); assert.deepEqual([r.w, r.h], [100, 50]); const u = doc([img({ lockAspect: false })]); r = C.getEl(C.applyProp(u, 'photo-1', 'w', '300').doc, 'photo-1'); assert.deepEqual([r.w, r.h], [300, 100]);
  for (const bad of ['0', '-5', 'x', '']) assert.ok(C.applyProp(d, 'photo-1', 'w', bad).error, bad); assert.equal(C.getEl(C.applyProp(u, 'photo-1', 'w', '1').doc, 'photo-1').w, G.LIMITS.minSize, 'clamped to the configured minimum');
  const tinyLocked = C.applyProp(doc([img({ w: 200, h: 4 })]), 'photo-1', 'h', '3'); assert.ok(tinyLocked.error || C.getEl(tinyLocked.doc, 'photo-1').h >= G.LIMITS.minSize);
});
test('numeric rotation, opacity, zoom: normalised, clamped and validated', () => {
  const d = doc([img()]); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'rotation', '370').doc, 'photo-1').rotation, 10); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'rotation', '-90').doc, 'photo-1').rotation, -90); assert.ok(C.applyProp(d, 'photo-1', 'rotation', 'left').error);
  assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'opacity', '7').doc, 'photo-1').opacity, 1); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'opacity', '0.4').doc, 'photo-1').opacity, 0.4); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'zoom', '1.75').doc, 'photo-1').zoom, 1.75); assert.ok(C.applyProp(d, 'photo-1', 'zoom', '0').error); assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'zoom', '9999').doc, 'photo-1').zoom, G.LIMITS.maxZoom);
  assert.equal(C.getEl(C.applyProp(d, 'photo-1', 'lockAspect', false).doc, 'photo-1').lockAspect, false); assert.match(C.unlockedWarning({ type: 'image', lockAspect: false }), /stretched/); assert.equal(C.unlockedWarning(img()), '');
});
test('drag and drop movement is exact, grouped into one undo step, snaps, axis-locks, and ignores locked layers', () => {
  const h = createHistory(doc([img(), { ...img({ id: 'o', x: 0, y: 0, w: 50, h: 50 }) }])), start = C.getEl(h.doc, 'photo-1'); h.begin(); let guides;
  for (let i = 1; i <= 20; i++) { const m = C.dragMove(start, i * 3, i * 2, { canvas, snap: false }); guides = m.guides; h.update(C.replaceEl(h.doc, 'photo-1', m.patch)); } h.end();
  assert.deepEqual([C.getEl(h.doc, 'photo-1').x, C.getEl(h.doc, 'photo-1').y], [160, 120]); h.undo(); assert.deepEqual([C.getEl(h.doc, 'photo-1').x, C.getEl(h.doc, 'photo-1').y], [100, 80], 'twenty pointer moves = one undo');
  const snapped = C.dragMove(start, 98, 0, { canvas, snap: true }); assert.equal(snapped.patch.x, 100 + 98 + 2 - 0, 'right edge or centre pulls to the canvas centre guide'); assert.ok(snapped.guides.length >= 1); const free = C.dragMove(start, 98, 0, { canvas, snap: false }); assert.equal(free.patch.x, 198, 'snapping can be switched off for precision');
  assert.equal(C.dragMove(start, 30, 5, { canvas, snap: false, axisLock: true }).patch.y, 80, 'shift locks to the dominant axis'); assert.deepEqual(C.dragMove({ ...start, locked: true }, 30, 30, { canvas }).patch, {}, 'a locked layer cannot be dragged');
  const away = C.dragMove(start, -500, -500, { canvas, snap: false }); assert.deepEqual([away.patch.x, away.patch.y], [-400, -420], 'dragging off the canvas is allowed');
});
test('resize handles: the lock is the default, shift inverts it, alt resizes from the centre, locked layers refuse', () => {
  const el = img(), se = C.dragResize(el, 'se', 40, 0); assert.equal(se.w / se.h, 2); const free = C.dragResize(el, 'se', 40, 0, { shift: true }); assert.deepEqual([free.w, free.h], [240, 100], 'shift unlocks'); const un = img({ lockAspect: false }), locked = C.dragResize(un, 'se', 40, 0, { shift: true }); assert.equal(locked.w / locked.h, 2, 'shift locks an unlocked element');
  const c = C.dragResize(el, 'se', 40, 0, { alt: true }); assert.equal(c.x + c.w / 2, 200); assert.deepEqual(C.dragResize({ ...el, locked: true }, 'se', 40, 0), {}); const side = C.dragResize(el, 'e', 60, 0, { shift: true }); assert.deepEqual([side.w, side.h], [260, 100]);
});
test('rotation handle: angle follows the pointer, optional snapping, locked layers refuse', () => {
  const el = img(), c = G.center(el); const r = C.dragRotate(el, { x: c.x + 100, y: c.y }); assert.equal(r.rotation, 90); assert.equal(C.dragRotate(el, { x: c.x + 100, y: c.y - 5 }, { snap: true }).rotation, 90, 'snaps to 15° steps near them'); assert.deepEqual(C.dragRotate({ ...el, locked: true }, { x: 0, y: 0 }), {});
  const { points } = C.handlePoints({ ...el, rotation: 90 }, 1); const q = points.rotate; assert.ok(q.x > c.x, 'the rotation handle turns with the element'); assert.equal(C.hitHandle(img(), { x: 300, y: 180 }, 1), 'se'); assert.equal(C.hitHandle(img(), { x: 200, y: 50 }, 1), 'rotate'); assert.equal(C.hitHandle(img(), { x: 200, y: 130 }, 1), null);
  const z = C.handlePoints(img(), 0.5); assert.equal(z.radius, 16, 'handles keep their on-screen size at any workspace zoom');
});
test('keyboard: shortcuts map to actions, nudging uses small/large steps, typing in a field is never intercepted', () => {
  const k = (key, o = {}) => C.keyAction({ key, ...o }); assert.deepEqual(k('z', { ctrl: true }), { type: 'undo' }); assert.deepEqual(k('z', { meta: true, shift: true }), { type: 'redo' }); assert.deepEqual(k('y', { ctrl: true }), { type: 'redo' }); assert.deepEqual(k('s', { ctrl: true }), { type: 'save' }); assert.deepEqual(k('d', { meta: true }), { type: 'duplicate' }); assert.deepEqual(k('Delete'), { type: 'delete' }); assert.deepEqual(k('Escape'), { type: 'escape' });
  assert.deepEqual(k('ArrowLeft'), { type: 'nudge', dx: -1, dy: 0 }); assert.deepEqual(k('ArrowDown', { shift: true }), { type: 'nudge', dx: 0, dy: 10 }); assert.deepEqual(C.keyAction({ key: 'ArrowUp' }, { nudge: 0.5, bigNudge: 25 }), { type: 'nudge', dx: 0, dy: -0.5 }); assert.deepEqual(C.keyAction({ key: 'ArrowUp', shift: true }, { nudge: 0.5, bigNudge: 25 }), { type: 'nudge', dx: 0, dy: -25 }, 'configurable increments');
  for (const key of ['Delete', 'Backspace', 'ArrowLeft', 'z', 's']) assert.equal(C.keyAction({ key, ctrl: true, typing: true }), null, 'typing: ' + key); assert.equal(k('q'), null);
  const d = doc([img()]); assert.equal(C.getEl(C.nudge(d, 'photo-1', 1, -10), 'photo-1').x, 101); assert.equal(C.nudge(doc([img({ locked: true })]), 'photo-1', 5, 5).elements[0].x, 100, 'locked: no nudge'); assert.equal(C.nudge(doc([img({ visible: false })]), 'photo-1', 5, 5).elements[0].x, 100);
});
test('image buttons: fit, fill, blurred background, original size, reset, centre - none of them touch the file', () => {
  const el = img({ fit: 'manual', zoom: 2, ox: 30, oy: -10, rotation: 20 }); assert.deepEqual(C.imagePreset(el, 'fit', 800, 600, canvas), { fit: 'contain', zoom: 1, ox: 0, oy: 0 }); assert.deepEqual(C.imagePreset(el, 'fill', 800, 600, canvas), { fit: 'cover', zoom: 1, ox: 0, oy: 0 }); assert.equal(C.imagePreset(el, 'blur', 800, 600, canvas).fit, 'blur');
  const o = C.imagePreset(el, 'original', 800, 600, canvas); assert.deepEqual([o.w, o.h, o.fit, o.lockAspect], [400, 300, 'manual', true], 'original size, reduced only when it would not fit the canvas'); const small = C.imagePreset(el, 'original', 200, 100, canvas); assert.deepEqual([small.w, small.h], [200, 100], 'a small image is never enlarged by "original size"'); assert.equal(C.imagePreset(el, 'reset', 800, 600, canvas).rotation, 0); assert.deepEqual(C.imagePreset(el, 'center', 800, 600, canvas), { ox: 0, oy: 0 }); assert.deepEqual(C.imagePreset(el, 'nonsense', 1, 1, canvas), {});
});
test('layers panel: top-first rows, drag reorder, rename, visibility/lock toggles, duplicate and delete, order matches paint order', () => {
  const els = ['a', 'b', 'c'].map(id => ({ id, type: 'shape', name: id.toUpperCase(), visible: true, locked: false, x: 0, y: 0, w: 10, h: 10, rotation: 0 })), d = doc(els);
  assert.deepEqual(C.layerRows(d).map(r => r.id), ['c', 'b', 'a'], 'the top layer is listed first'); assert.deepEqual(C.dropLayer(d, 'a', 0).elements.map(e => e.id), ['b', 'c', 'a'], 'dropping on the first row brings it to the front'); assert.deepEqual(C.dropLayer(d, 'c', 2).elements.map(e => e.id), ['c', 'a', 'b'], 'dropping on the last row sends it to the back');
  assert.equal(C.getEl(C.renameLayer(d, 'a', '  Hero photo '), 'a').name, 'Hero photo'); assert.equal(C.getEl(C.renameLayer(d, 'a', '   '), 'a').name, 'A', 'an empty name keeps the old one'); assert.equal(C.getEl(C.toggleProp(d, 'a', 'visible'), 'a').visible, false); assert.equal(C.getEl(C.toggleProp(C.toggleProp(d, 'a', 'visible'), 'a', 'visible'), 'a').visible, true); assert.equal(C.getEl(C.toggleProp(d, 'b', 'locked'), 'b').locked, true);
  const dup = G.duplicateLayer(d.elements, 'b'); assert.deepEqual(dup.elements.map(e => e.id), ['a', 'b', dup.id, 'c']); assert.deepEqual(G.removeLayer(d.elements, 'a').map(e => e.id), ['b', 'c']);
});
test('new elements, undo/redo of editor operations, and a canvas-size change keep the design recoverable', () => {
  const h = createHistory(doc([img()])), add = C.defaultElement('text', canvas, h.doc.elements); h.commit({ ...h.doc, elements: [...h.doc.elements, add] }); assert.equal(h.doc.elements.length, 2); assert.ok(G.sanitizeDoc(h.doc), 'created elements are valid documents'); for (const t of ['shape', 'image', 'gradient']) assert.ok(G.sanitizeDoc({ ...h.doc, elements: [C.defaultElement(t, canvas, [])] }), t);
  h.commit(C.applyProp(h.doc, 'photo-1', 'rotation', '45').doc); h.commit(C.toggleProp(h.doc, 'photo-1', 'locked')); assert.equal(C.getEl(h.doc, 'photo-1').locked, true); h.undo(); assert.equal(C.getEl(h.doc, 'photo-1').locked, false); h.undo(); assert.equal(C.getEl(h.doc, 'photo-1').rotation, 0); h.redo(); assert.equal(C.getEl(h.doc, 'photo-1').rotation, 45);
  const before = JSON.stringify(h.doc); h.commit(G.convertCanvas(h.doc, 1080, 1350, 'scale')); assert.equal(h.doc.canvas.h, 1350); h.undo(); assert.equal(JSON.stringify(h.doc), before, 'a canvas-size change is one reversible step');
});
