// Deterministic social-graphic renderer. No AI image model: exact text, local fonts, same output for same input.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BRAND } from './brand.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const reg = (file, fam) => GlobalFonts.registerFromPath(path.join(FONT_DIR, file), fam);
reg('NotoSansDevanagari-ExtraBold.ttf', 'DevaXB'); reg('NotoSansDevanagari-Bold.ttf', 'DevaB'); reg('NotoSansDevanagari-Medium.ttf', 'DevaM');
reg('RedHatDisplay-Black.ttf', 'RHDBlack'); reg('RedHatDisplay-Bold.ttf', 'RHDBold'); reg('RedHatDisplay-BoldItalic.ttf', 'RHDBoldItalic'); reg('RedHatDisplay-Italic.ttf', 'RHDItalic');
// Latin glyphs come from Red Hat Display, Devanagari falls through to Noto Sans Devanagari.
export const F = { head: s => `${s}px "RHDBlack", "DevaXB"`, sub: s => `${s}px "RHDItalic", "DevaM"`, bold: s => `${s}px "RHDBold", "DevaB"`, badge: s => `${s}px "RHDBoldItalic", "DevaXB"`, small: s => `${s}px "RHDBold", "DevaM"` };

export const FORMATS = { portrait: { w: 1080, h: 1350, name: 'Portrait 4:5' }, square: { w: 1080, h: 1080, name: 'Square 1:1' }, landscape: { w: 1200, h: 675, name: 'Landscape 16:9' }, vertical: { w: 1080, h: 1920, name: 'Story / Reel 9:16' } };
// Per-format layout rules (fractions of canvas): where the text stack may start, margins and type sizes.
const LAYOUT = {
  portrait: { margin: 0.085, minTop: 0.50, head: [66, 40], maxLines: 5, sub: 29, textW: 0.82, badge: 0.034, gradFrom: 0.38 },
  square: { margin: 0.08, minTop: 0.42, head: [60, 36], maxLines: 4, sub: 26, textW: 0.84, badge: 0.036, gradFrom: 0.30 },
  landscape: { margin: 0.06, minTop: 0.26, head: [46, 30], maxLines: 3, sub: 22, textW: 0.80, badge: 0.050, gradFrom: 0.20 },
  // 9:16 Stories/Reels: Instagram covers about the top 14% (profile bar) and bottom 17% (reply bar), so logo/tag sit below it and the text stack ends above it
  vertical: { margin: 0.085, minTop: 0.40, head: [76, 46], maxLines: 6, sub: 33, textW: 0.82, badge: 0.028, gradFrom: 0.30, top: 0.15, bottom: 0.18, band: 0.82 },
};
export const DEFAULT_SPEC = {
  format: 'portrait', headline: '', subheadline: '', badgeLeft: 'BREAKING', badgeRight: 'NEWS', badgeAlign: 'center',
  category: '', dateText: '', sourceText: '', footerText: '', urlText: '',
  colors: { accent: '#d62828', badge2: '#1f4e8c', text: '#ffffff', sub: '#d4d4d4' },
  photo: { zoom: 1, fx: 0.5, fy: 0.5, grayscale: true, overlay: 0.12 },
};
export const FONT_FAMILIES = ['DevaXB', 'DevaB', 'DevaM', 'RHDBlack', 'RHDBold', 'RHDBoldItalic', 'RHDItalic'];
const SUPPORTED = /^[\p{Script=Devanagari}\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}‌‍​\n]*$/u;
const hex = c => /^#[0-9a-f]{6}$/i.test(c) ? c : null;

// "[[red words]]" marks highlighted spans. A token is one whitespace-delimited word made of coloured segments,
// so highlighting part of a word does not insert a gap.
export function parseHighlight(text) {
  const tokens = []; let hi = false, glue = false;
  for (const part of String(text).split(/(\[\[|\]\])/)) {
    if (part === '[[') { hi = true; continue; } if (part === ']]') { hi = false; continue; } if (!part) continue;
    const pieces = part.split(/(\s+)/);
    for (const pc of pieces) {
      if (!pc) continue; if (/^\s+$/.test(pc)) { glue = false; continue; }
      if (glue && tokens.length) tokens.at(-1).segs.push({ t: pc, hi }); else tokens.push({ segs: [{ t: pc, hi }] });
      glue = true;
    }
  }
  return tokens.map(k => ({ segs: k.segs, w: k.segs.map(x => x.t).join(''), hi: k.segs.every(x => x.hi) }));
}
export function wrap(ctx, words, maxW) {
  const sp = ctx.measureText(' ').width, lines = []; let cur = [], width = 0;
  for (const wd of words) {
    const m = wd.segs.reduce((a, x) => a + ctx.measureText(x.t).width, 0);
    if (cur.length && width + sp + m > maxW) { lines.push({ words: cur, width }); cur = []; width = 0; }
    width += (cur.length ? sp : 0) + m; cur.push({ ...wd, m });
  }
  if (cur.length) lines.push({ words: cur, width });
  return lines;
}
export function drawLines(ctx, lines, x, y, lh, color, accent) {
  const sp = ctx.measureText(' ').width; ctx.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => { let cx = x; for (const wd of ln.words) { for (const sg of wd.segs ?? [{ t: wd.w, hi: wd.hi }]) { ctx.fillStyle = sg.hi ? accent : color; ctx.fillText(sg.t, cx, y + i * lh); cx += ctx.measureText(sg.t).width; } cx += sp; } });
}

export async function renderGraphic(input, { photoPath, logoPath, outFormat = 'png', dryRun = false } = {}) {
  const spec = { ...DEFAULT_SPEC, ...input, colors: { ...DEFAULT_SPEC.colors, ...input.colors }, photo: { ...DEFAULT_SPEC.photo, ...input.photo } };
  const fmt = FORMATS[spec.format] ? spec.format : 'portrait', { w, h } = FORMATS[fmt], L = LAYOUT[fmt], warnings = [];
  const warn = (code, severity, message) => warnings.push({ code, severity, message });
  const col = { accent: hex(spec.colors.accent) || '#d62828', badge2: hex(spec.colors.badge2) || '#1f4e8c', text: hex(spec.colors.text) || '#ffffff', sub: hex(spec.colors.sub) || '#d4d4d4' };
  const layout = { w, h, fmt }; // geometry of every drawn piece, so a classic design can be converted to an editable one exactly
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  const allText = [spec.headline, spec.subheadline, spec.badgeLeft, spec.badgeRight, spec.category, spec.dateText, spec.sourceText, spec.footerText, spec.urlText].join(' ');
  if (!SUPPORTED.test(allText)) warn('unsupported_characters', 'error', 'Text contains characters outside Devanagari/Latin; they may render as empty boxes.');
  if (!spec.headline.trim()) warn('headline_empty', 'error', 'Headline is empty.');

  /* 1. photo (cover-fit with zoom + focus point), or a plain dark backdrop */
  if (photoPath) {
    const img = await loadImage(photoPath), z = Math.min(4, Math.max(1, +spec.photo.zoom || 1));
    const scale = Math.max(w / img.width, h / img.height) * z, dw = img.width * scale, dh = img.height * scale;
    const fx = Math.min(1, Math.max(0, +spec.photo.fx)), fy = Math.min(1, Math.max(0, +spec.photo.fy));
    const x = Math.min(0, Math.max(w - dw, w / 2 - fx * dw)), y = Math.min(0, Math.max(h - dh, h / 2 - fy * dh));
    layout.photo = { x, y, dw, dh, z, iw: img.width, ih: img.height, gray: !!spec.photo.grayscale };
    if (scale > 1.5) warn('photo_low_resolution', 'warn', `Photo is enlarged ${scale.toFixed(1)}× to fill the frame (${img.width}×${img.height}px); it may look soft.`);
    if (spec.photo.grayscale) {
      const t = createCanvas(w, h), tc = t.getContext('2d'); tc.drawImage(img, x, y, dw, dh);
      const d = tc.getImageData(0, 0, w, h), p = d.data;
      for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = g; }
      ctx.putImageData(d, 0, 0);
    } else ctx.drawImage(img, x, y, dw, dh);
  } else { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b2433'); g.addColorStop(1, '#0a0d12'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); warn('no_photo', 'warn', 'No photo selected — upload a photo you are authorised to use.'); }
  const ov = Math.min(0.7, Math.max(0, +spec.photo.overlay || 0)); layout.overlay = ov; layout.grad = { y0: h * L.gradFrom, y1: h * (L.band ?? 0.86) }; layout.band = L.band ?? 0.86; if (ov) { ctx.fillStyle = `rgba(0,0,0,${ov})`; ctx.fillRect(0, 0, w, h); }
  const band = L.band ?? 0.86, grad = ctx.createLinearGradient(0, h * L.gradFrom, 0, h * band); grad.addColorStop(0, 'rgba(8,8,10,0)'); grad.addColorStop(1, 'rgba(8,8,10,0.96)'); ctx.fillStyle = grad; ctx.fillRect(0, h * L.gradFrom, w, h);
  ctx.fillStyle = 'rgb(8,8,10)'; ctx.globalAlpha = 0.96; ctx.fillRect(0, h * band, w, h * (1 - band)); ctx.globalAlpha = 1;

  const mx = Math.round(w * L.margin), textW = w * L.textW - 24;

  /* 2. logo (or a clear placeholder) top-right inside safe margins */
  const topY = L.top ? Math.round(h * L.top) : mx * 0.7, lbw = w * 0.26, lbh = h * (fmt === 'landscape' ? 0.12 : fmt === 'vertical' ? 0.05 : 0.075);
  if (logoPath) { // the real logo is drawn directly on the graphic (no card behind it)
    const lg = await loadImage(logoPath), H = h * (fmt === 'landscape' ? 0.16 : fmt === 'vertical' ? 0.075 : 0.105), ar = lg.width / lg.height;
    let ih = H, iw = ih * ar; const maxW = w * 0.34; if (iw > maxW) { iw = maxW; ih = iw / ar; }
    const cx = w - mx - iw; ctx.drawImage(lg, cx, topY, iw, ih);
    layout.logo = { image: true, x: cx, y: topY, w: iw, h: ih, pad: 0, backing: false };
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.94)'; const bx = w - mx - lbw, by = topY; ctx.beginPath(); ctx.roundRect(bx, by, lbw, lbh, 10); ctx.fill();
    ctx.fillStyle = '#111'; let lf = Math.round(lbh * 0.3); ctx.font = F.bold(lf); while (ctx.measureText(BRAND.toUpperCase()).width > lbw - 28 && lf > 8) ctx.font = F.bold(--lf);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(BRAND.toUpperCase(), bx + lbw / 2, by + lbh / 2 + 1); ctx.textAlign = 'left'; layout.logo = { image: false, x: bx, y: by, w: lbw, h: lbh, size: lf, text: BRAND.toUpperCase() };
    warn('logo_placeholder', 'info', 'Placeholder logo in use — upload your ' + BRAND + ' logo.');
  }
  if (spec.category.trim()) { // category tag, top-left
    ctx.font = F.small(Math.round(h * (fmt === 'landscape' ? 0.034 : 0.021))); const cw = ctx.measureText(spec.category).width + 28, ch = Math.round(h * (fmt === 'landscape' ? 0.07 : 0.045));
    ctx.fillStyle = col.accent; ctx.fillRect(mx, topY, cw, ch); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(spec.category, mx + 14, topY + ch / 2 + 1); layout.cat = { x: mx, y: topY, w: cw, h: ch, size: Math.round(h * (fmt === 'landscape' ? 0.034 : 0.021)), text: spec.category };
  }

  /* 3. text stack, laid out from the bottom up so nothing collides */
  const bottom = h - Math.round(h * (L.bottom ?? 0.045));
  const footerFont = Math.round(h * (fmt === 'landscape' ? 0.036 : 0.026)); ctx.font = F.bold(footerFont);
  const metaLine = [spec.dateText, spec.sourceText].filter(Boolean).join('  ·  ');
  let y = bottom;
  const footerH = footerFont * (spec.urlText ? 2.3 : 1.2);
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#f2f2f2';
  layout.foot = { size: footerFont, mx, base: y, url: !!spec.urlText };
  if (spec.footerText) { ctx.textAlign = 'right'; ctx.font = F.bold(footerFont); ctx.fillText(spec.footerText + '  ›', w - mx, y - (spec.urlText ? footerFont * 1.1 : 0)); }
  if (spec.urlText) { ctx.textAlign = 'right'; ctx.font = F.small(Math.round(footerFont * 0.6)); ctx.fillStyle = '#9a9a9a'; ctx.fillText(spec.urlText.toUpperCase(), w - mx, y); }
  if (metaLine) { ctx.textAlign = 'left'; ctx.font = F.small(Math.round(footerFont * 0.78)); ctx.fillStyle = '#b5b5b5'; ctx.fillText(metaLine, mx, y - (spec.urlText ? footerFont * 1.1 : 0)); }
  ctx.textAlign = 'left'; y -= footerH + h * 0.012;

  // subheadline
  let subLines = [], subLh = 0;
  if (spec.subheadline.trim()) {
    const fs = L.sub; ctx.font = F.sub(fs); subLh = Math.round(fs * 1.42); subLines = wrap(ctx, parseHighlight(spec.subheadline.replace(/\[\[|\]\]/g, '')), textW);
    if (subLines.length > 2) { subLines = subLines.slice(0, 2); const last = subLines[1].words; last.push({ w: '…', segs: [{ t: '…', hi: false }], m: ctx.measureText('…').width }); warn('subheadline_truncated', 'warn', 'Subheadline is longer than two lines and was shortened with “…”.'); }
    y -= subLines.length * subLh + h * 0.012;
  }
  const subTopY = y; layout.sub = subLines.length ? { x: mx + 24, y: subTopY, lh: subLh, size: L.sub, w: textW, lines: subLines.length } : null;
  // headline: shrink to fit between the badge and the footer; warn instead of silently overflowing
  const badgeH = Math.round(h * L.badge * 1.7), gap = Math.round(h * 0.022), words = parseHighlight(spec.headline), minTop = h * L.minTop;
  let size = L.head[0], lines, lh;
  for (; ; size -= 2) {
    ctx.font = F.head(size); lh = Math.round(size * 1.28); lines = wrap(ctx, words, textW - 18);
    const fits = lines.length <= L.maxLines && (subTopY - lines.length * lh - gap - badgeH) >= minTop;
    if (fits || size <= L.head[1]) { if (!fits && words.length) warn('headline_overflow', 'error', `Headline does not fit at the minimum readable size (${L.head[1]}px, ${lines.length} lines). Shorten it.`); break; }
  }
  if (size < L.head[0] * 0.8 && !warnings.some(x => x.code === 'headline_overflow')) warn('headline_small', 'warn', `Headline was reduced to ${size}px to fit (from ${L.head[0]}px).`);
  const headBottom = subTopY - gap * (subLines.length ? 0.9 : 0.4), headTop = headBottom - lines.length * lh;
  layout.head = { x: mx + 24, y: headTop, w: textW - 18, size, lh, lines: lines.length }; layout.bar = { x: mx, y: headTop + 6, w: Math.max(4, Math.round(w * 0.004)), h: lines.length * lh - 8 }; layout.col = col;
  ctx.font = F.head(size); drawLines(ctx, lines, mx + 24, headTop + lh * 0.82, lh, col.text, col.accent);
  ctx.fillStyle = col.text; ctx.fillRect(mx, headTop + 6, Math.max(4, Math.round(w * 0.004)), lines.length * lh - 8); // accent bar
  if (subLines.length) { ctx.font = F.sub(L.sub); drawLines(ctx, subLines, mx + 24, subTopY + subLh * 0.8, subLh, col.sub, col.sub); }

  /* 4. slanted two-part badge */
  if (spec.badgeLeft || spec.badgeRight) {
    const fs = Math.round(h * L.badge), pad = fs * 0.55, skew = fs * 0.35; ctx.font = F.badge(fs);
    const lw = spec.badgeLeft ? ctx.measureText(spec.badgeLeft).width + pad * 2 : 0, rw = spec.badgeRight ? ctx.measureText(spec.badgeRight).width + pad * 2 : 0, bh = Math.round(fs * 1.7);
    const bx = spec.badgeAlign === 'left' ? mx : (w - (lw + rw)) / 2, by = headTop - gap - bh;
    const para = (x, wd, color, text) => { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x + skew, by); ctx.lineTo(x + wd + skew, by); ctx.lineTo(x + wd, by + bh); ctx.lineTo(x, by + bh); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + pad + skew / 2, by + bh / 2 + fs * 0.04); };
    layout.badge = { x: bx, y: by, h: bh, w: lw + rw, fs, left: spec.badgeLeft, right: spec.badgeRight };
    if (lw) para(bx, lw, col.accent, spec.badgeLeft); if (rw) para(bx + lw, rw, col.badge2, spec.badgeRight);
  }
  if (dryRun) return { image: null, mime: null, width: w, height: h, warnings, metrics: { headlineFont: size, headlineLines: lines.length }, layout }; // layout check only
  const png = outFormat === 'jpeg' ? await canvas.encode('jpeg', 90) : await canvas.encode('png');
  return { image: png, mime: outFormat === 'jpeg' ? 'image/jpeg' : 'image/png', width: w, height: h, warnings, metrics: { headlineFont: size, headlineLines: lines.length }, layout };
}
