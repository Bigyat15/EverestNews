// Renders a version-2 design document. This is the ONLY renderer used for the editor preview, the preview button and the export:
// the same function with the same document gives the same pixels (preview may use scale<1 for speed; geometry is identical).
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { F, wrap, drawLines, parseHighlight, renderGraphic, DEFAULT_SPEC, FONT_FAMILIES } from './render.js';
import { BRAND } from './brand.js';
import { DOC_VERSION, imageRects, resolutionWarning, sanitizeDoc, CANVAS_PRESETS, rad } from './design_geom.js';

const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const hasFonts = () => { const fams = new Set(GlobalFonts.families.map(f => f.family)); return FONT_FAMILIES.filter(f => !fams.has(f)); };

function grayscale(cv) { const c = cv.getContext('2d'), d = c.getImageData(0, 0, cv.width, cv.height), p = d.data; for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = g; } c.putImageData(d, 0, 0); }

function drawImageElement(ctx, el, img, scale, warnings) {
  const { fg, bg } = imageRects(el, img.width, img.height), gray = el.grayscale;
  const paint = (c, ox, oy) => { // ox/oy: where the frame origin sits inside the target
    if (bg) { // deterministic blur: shrink the cover copy and stretch it back with smoothing
      const k = Math.max(1, 1 + el.blur / 4), sw = Math.max(8, Math.round(bg.w / k)), sh = Math.max(8, Math.round(bg.h / k)), t = createCanvas(sw, sh), tc = t.getContext('2d'); tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high'; tc.drawImage(img, 0, 0, sw, sh);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(t, ox + bg.x, oy + bg.y, bg.w, bg.h);
    }
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(img, ox + fg.x, oy + fg.y, fg.w, fg.h);
  };
  if (!gray) return paint(ctx, 0, 0);
  const ux = Math.min(0, fg.x, bg?.x ?? 0), uy = Math.min(0, fg.y, bg?.y ?? 0), ex = Math.max(el.w, fg.x + fg.w, bg ? bg.x + bg.w : 0), ey = Math.max(el.h, fg.y + fg.h, bg ? bg.y + bg.h : 0);
  const t = createCanvas(Math.max(1, Math.ceil((ex - ux) * scale)), Math.max(1, Math.ceil((ey - uy) * scale))), tc = t.getContext('2d'); tc.scale(scale, scale); paint(tc, -ux, -uy); grayscale(t); ctx.drawImage(t, ux, uy, t.width / scale, t.height / scale);
}

function drawText(ctx, el, warnings) {
  let size = el.size, lh = el.lineHeight, lines, words = parseHighlight(el.text);
  ctx.font = F[el.font](size);
  if (el.literal) { ctx.font = F[el.font](size); ctx.textBaseline = el.middle ? 'middle' : 'alphabetic'; ctx.fillStyle = el.color; const m = ctx.measureText(el.text).width, x = el.align === 'center' ? (el.w - m) / 2 : el.align === 'right' ? el.w - m : 0; ctx.fillText(el.text, x, el.middle ? el.h / 2 + 1 : el.baseline * lh); return { size, lines: 1 }; } // one line exactly as typed (spacing kept)
  for (;;) { ctx.font = F[el.font](size); lines = wrap(ctx, words, el.w); const over = (el.maxLines && lines.length > el.maxLines && !el.shrink) ? false : lines.length * lh <= el.h + 0.5 || !el.shrink; if (over || size <= 8) break; size -= 2; lh = Math.round(lh * (size / (size + 2))); }
  if (el.maxLines && lines.length > el.maxLines) { lines = lines.slice(0, el.maxLines); const last = lines.at(-1).words; last.push({ w: '…', segs: [{ t: '…', hi: false }], m: ctx.measureText('…').width }); warnings.push({ code: 'text_truncated', severity: 'warn', message: `"${el.name}" is longer than ${el.maxLines} lines and was shortened with “…”.`, id: el.id }); }
  if (lines.length * lh > el.h + 1 && !el.shrink) warnings.push({ code: 'text_overflow', severity: 'warn', message: `"${el.name}" is taller than its box.`, id: el.id });
  ctx.font = F[el.font](size); ctx.textBaseline = el.middle ? 'middle' : 'alphabetic'; const sp = ctx.measureText(' ').width;
  lines.forEach((ln, i) => {
    const total = ln.words.reduce((a, wd) => a + wd.m, 0) + sp * Math.max(0, ln.words.length - 1); let cx = el.align === 'center' ? (el.w - total) / 2 : el.align === 'right' ? el.w - total : 0; const by = el.middle ? el.h / 2 + 1 : (i + el.baseline) * lh;
    for (const wd of ln.words) { for (const sg of wd.segs ?? [{ t: wd.w, hi: wd.hi }]) { ctx.fillStyle = sg.hi ? el.accent : el.color; ctx.fillText(sg.t, cx, by); cx += ctx.measureText(sg.t).width; } cx += sp; }
  });
  return { size, lines: lines.length };
}

function drawBadge(ctx, el, metrics) { // same drawing as the classic template, in the element's local frame
  const fs = el.h / 1.7, pad = fs * 0.55, skew = fs * 0.35, bh = el.h; ctx.font = F.badge(fs); const lw = el.left ? ctx.measureText(el.left).width + pad * 2 : 0, rw = el.right ? ctx.measureText(el.right).width + pad * 2 : 0;
  const para = (x, wd, color, text) => { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x + skew, 0); ctx.lineTo(x + wd + skew, 0); ctx.lineTo(x + wd, bh); ctx.lineTo(x, bh); ctx.closePath(); ctx.fill(); ctx.fillStyle = el.textColor; ctx.textBaseline = 'middle'; ctx.fillText(text, x + pad + skew / 2, bh / 2 + fs * 0.04); };
  if (lw) para(0, lw, el.leftColor, el.left); if (rw) para(lw, rw, el.rightColor, el.right); metrics.badgeWidth = lw + rw + skew;
}

// assets: { byRef(ref) -> absolute path | null }  (ref: 'photo' | 'logo' | numeric asset id)
export async function renderDoc(input, assets = {}, { scale = 1, outFormat = 'png', dryRun = false } = {}) {
  const doc = sanitizeDoc(input), { w, h, bg } = doc.canvas, warnings = [], metrics = { elements: {} }, cache = new Map();
  scale = Math.min(2, Math.max(0.1, +scale || 1)); const missingFonts = hasFonts(); if (missingFonts.length) warnings.push({ code: 'font_missing', severity: 'warn', message: `Fonts not available: ${missingFonts.join(', ')}; text falls back to a default font.` });
  const load = async ref => { const key = String(ref); if (!cache.has(key)) { const p = await assets.byRef?.(ref); cache.set(key, p ? loadImage(p).catch(() => null) : null); } return cache.get(key); };
  const canvas = createCanvas(Math.round(w * scale), Math.round(h * scale)), ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  for (const el of doc.elements) {
    if (!el.visible) continue;
    ctx.save(); ctx.globalAlpha = el.opacity; ctx.translate(el.x + el.w / 2, el.y + el.h / 2); ctx.rotate(rad(el.rotation)); ctx.translate(-el.w / 2, -el.h / 2); // one transform order for every element
    try {
      const clipRect = () => { ctx.beginPath(); if (el.radius) ctx.roundRect(0, 0, el.w, el.h, Math.min(el.radius, el.w / 2, el.h / 2)); else ctx.rect(0, 0, el.w, el.h); ctx.clip(); };
      if (el.type === 'image') {
        const img = await load(el.asset ?? (el.role === 'logo' ? 'logo' : 'photo'));
        if (!img) { if (el.role === 'logo') { ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.beginPath(); ctx.roundRect(0, 0, el.w, el.h, 10); ctx.fill(); ctx.fillStyle = '#111'; let lf = Math.round(el.h * 0.3); ctx.font = F.bold(lf); while (ctx.measureText(BRAND.toUpperCase()).width > el.w - 28 && lf > 8) ctx.font = F.bold(--lf); ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(BRAND.toUpperCase(), el.w / 2, el.h / 2 + 1); ctx.textAlign = 'left'; warnings.push({ code: 'logo_placeholder', severity: 'info', message: 'Placeholder logo in use.', id: el.id }); } else { ctx.fillStyle = '#1b2433'; ctx.fillRect(0, 0, el.w, el.h); warnings.push({ code: 'image_missing', severity: 'warn', message: `"${el.name}" has no usable image.`, id: el.id }); } }
        else if (el.backing) { // logo card: white rounded backing, the image contained inside it with padding
          const pad = el.pad || Math.round(Math.min(el.w, el.h) * 0.1); ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.beginPath(); ctx.roundRect(0, 0, el.w, el.h, Math.min(10, el.w / 2, el.h / 2)); ctx.fill();
          ctx.save(); ctx.translate(pad, pad); drawImageElement(ctx, { ...el, w: Math.max(1, el.w - 2 * pad), h: Math.max(1, el.h - 2 * pad), fit: 'contain', zoom: 1, ox: 0, oy: 0 }, img, scale, warnings); ctx.restore(); metrics.elements[el.id] = { source: [img.width, img.height] };
        } else { if (el.clip) clipRect(); drawImageElement(ctx, el, img, scale, warnings); const rw = resolutionWarning(el, img.width, img.height, scale); if (rw) warnings.push({ ...rw, id: el.id }); metrics.elements[el.id] = { source: [img.width, img.height] }; }
      } else if (el.type === 'text') { metrics.elements[el.id] = drawText(ctx, el, warnings); }
      else if (el.type === 'shape') { ctx.fillStyle = rgba(el.fill, el.alpha); ctx.beginPath(); if (el.radius) ctx.roundRect(0, 0, el.w, el.h, Math.min(el.radius, el.w / 2, el.h / 2)); else ctx.rect(0, 0, el.w, el.h); ctx.fill(); }
      else if (el.type === 'gradient') { const g = ctx.createLinearGradient(0, 0, 0, el.h); for (const s of el.stops) g.addColorStop(s.at, rgba(s.color, s.alpha)); ctx.fillStyle = g; ctx.fillRect(0, 0, el.w, el.h); }
      else if (el.type === 'badge') { const m = {}; drawBadge(ctx, el, m); metrics.elements[el.id] = m; }
    } finally { ctx.restore(); }
  }
  if (!doc.elements.some(e => e.visible && e.role === 'headline' && e.text?.trim())) warnings.push({ code: 'headline_empty', severity: 'warn', message: 'No visible headline text.' });
  const base = { width: canvas.width, height: canvas.height, designWidth: w, designHeight: h, warnings, metrics };
  if (dryRun) return { ...base, image: null, mime: null };
  return { ...base, image: outFormat === 'jpeg' ? await canvas.encode('jpeg', 92) : await canvas.encode('png'), mime: outFormat === 'jpeg' ? 'image/jpeg' : 'image/png' };
}

/* ---- converting a classic (v1) design into an editable document: geometry comes from the classic renderer itself, so the first render matches ---- */
let n = 0; const mk = (type, role, name, o) => ({ id: `${type}-${++n}`, type, role, name, visible: true, locked: false, rotation: 0, opacity: 1, lockAspect: true, ...o });
export async function docFromSpec(input, { photoPath = null, photoAsset = 'photo', logoPath = null, logoAsset = 'logo' } = {}) {
  n = 0; const spec = { ...DEFAULT_SPEC, ...input, colors: { ...DEFAULT_SPEC.colors, ...input.colors }, photo: { ...DEFAULT_SPEC.photo, ...input.photo } };
  const r = await renderGraphic(spec, { photoPath, logoPath, dryRun: true }), L = r.layout, { w, h } = L, col = L.col ?? { accent: '#d62828', text: '#ffffff', sub: '#d4d4d4', badge2: spec.colors.badge2 }, els = [];
  if (L.photo) { const sc = L.photo.dw / L.photo.iw; els.push(mk('image', 'photo', 'Article image', { x: 0, y: 0, w, h, asset: photoAsset, fit: 'cover', zoom: L.photo.z, ox: L.photo.x - (w - L.photo.dw) / 2, oy: L.photo.y - (h - L.photo.dh) / 2, clip: true, radius: 0, grayscale: L.photo.gray, blur: 28 })); void sc; }
  else els.push(mk('shape', 'photo', 'Backdrop', { x: 0, y: 0, w, h, fill: '#141a25', alpha: 1, radius: 0 }));
  if (L.overlay) els.push(mk('shape', 'overlay', 'Darken overlay', { x: 0, y: 0, w, h, fill: '#000000', alpha: L.overlay, radius: 0 }));
  els.push(mk('gradient', 'gradient', 'Text gradient', { x: 0, y: L.grad.y0, w, h: h - L.grad.y0, stops: [{ at: 0, color: '#08080a', alpha: 0 }, { at: (L.grad.y1 - L.grad.y0) / (h - L.grad.y0), color: '#08080a', alpha: 0.96 }, { at: 1, color: '#08080a', alpha: 0.96 }] }));
  els.push(mk('shape', 'band', 'Footer band', { x: 0, y: h * L.band, w, h: h * (1 - L.band), fill: '#08080a', alpha: 0.96, radius: 0 }));
  if (L.logo) { if (L.logo.image) els.push(mk('image', 'logo', 'Brand logo', { x: L.logo.x, y: L.logo.y, w: L.logo.w, h: L.logo.h, asset: logoAsset, fit: 'contain', zoom: 1, ox: 0, oy: 0, clip: false, radius: 0, backing: false, pad: 0 })); else els.push(mk('image', 'logo', 'Brand logo', { x: L.logo.x, y: L.logo.y, w: L.logo.w, h: L.logo.h, asset: null, fit: 'contain', zoom: 1, ox: 0, oy: 0, clip: false, radius: 0 })); }
  if (L.cat) { els.push(mk('shape', 'category', 'Category tag', { x: L.cat.x, y: L.cat.y, w: L.cat.w, h: L.cat.h, fill: col.accent, alpha: 1, radius: 0 })); els.push(mk('text', 'category', 'Category text', { x: L.cat.x + 14, y: L.cat.y, w: L.cat.w - 14, h: L.cat.h, text: L.cat.text, font: 'small', size: L.cat.size, lineHeight: L.cat.h, color: '#ffffff', accent: '#ffffff', align: 'left', middle: true, literal: true, baseline: 0.82 })); }
  if (L.head) els.push(mk('text', 'headline', 'Headline', { x: L.head.x, y: L.head.y, w: L.head.w, h: L.head.lines * L.head.lh, text: spec.headline, font: 'head', size: L.head.size, lineHeight: L.head.lh, color: col.text, accent: col.accent, align: 'left', baseline: 0.82 }));
  if (L.bar) els.push(mk('shape', 'accent', 'Accent bar', { x: L.bar.x, y: L.bar.y, w: L.bar.w, h: L.bar.h, fill: col.text, alpha: 1, radius: 0 }));
  if (L.sub) els.push(mk('text', 'subheadline', 'Supporting text', { x: L.sub.x, y: L.sub.y, w: L.sub.w, h: L.sub.lines * L.sub.lh, text: spec.subheadline.replace(/\[\[|\]\]/g, ''), font: 'sub', size: L.sub.size, lineHeight: L.sub.lh, color: col.sub, accent: col.sub, align: 'left', maxLines: 2, baseline: 0.8 }));
  if (L.badge) els.push(mk('badge', 'badge', 'Badge', { x: L.badge.x, y: L.badge.y, w: L.badge.w, h: L.badge.h, left: L.badge.left, right: L.badge.right, leftColor: col.accent, rightColor: col.badge2, textColor: '#ffffff' }));
  if (L.foot) {
    const f = L.foot, lhOf = s => Math.round(s * 1.3), box = (size, base, text, role, name, o) => mk('text', role, name, { x: o.x, y: base - lhOf(size) * 0.82, w: o.w, h: lhOf(size), text, font: o.font, size, lineHeight: lhOf(size), color: o.color, accent: o.color, align: o.align, literal: true, baseline: 0.82 });
    const meta = [spec.dateText, spec.sourceText].filter(Boolean).join('  ·  '), shift = f.url ? f.size * 1.1 : 0;
    if (spec.footerText) els.push(box(f.size, f.base - shift, spec.footerText + '  ›', 'footer', 'Footer text', { x: w - f.mx - w * 0.5, w: w * 0.5, font: 'bold', color: '#f2f2f2', align: 'right' }));
    if (spec.urlText) els.push(box(Math.round(f.size * 0.6), f.base, spec.urlText.toUpperCase(), 'url', 'Website text', { x: w - f.mx - w * 0.5, w: w * 0.5, font: 'small', color: '#9a9a9a', align: 'right' }));
    if (meta) els.push(box(Math.round(f.size * 0.78), f.base - shift, meta, 'date', 'Date / source', { x: f.mx, w: w * 0.5, font: 'small', color: '#b5b5b5', align: 'left' }));
  }
  const preset = Object.entries(CANVAS_PRESETS).find(([, p]) => p.w === w && p.h === h)?.[0] ?? 'custom';
  return sanitizeDoc({ version: DOC_VERSION, canvas: { w, h, bg: '#0a0d12' }, elements: els, meta: { format: preset, safe: 0.06 } });
}
