// Layered social-graphic editor (browser glue). All geometry and every editing rule lives in the shared modules (design_geom, design_editor_core, design_history),
// which the server's renderer and the tests also use; this file only turns pointer/keyboard events into those calls and draws the panels.
// Units: every position and size shown here is in DESIGN PIXELS of the canvas. The workspace zoom only scales the view; it never changes a stored number.
import * as G from '/admin/design_geom.js';
import * as C from '/admin/design_editor_core.js';
import { createHistory } from '/admin/design_history.js';

export async function editor(ctx, id) {
  const { api, esc, toast, fail, main } = ctx, q = new URLSearchParams(location.hash.split('?')[1] || ''), lang = q.get('lang') || '', $ = s => main.querySelector(s);
  main.innerHTML = '<div class="mut" style="padding:30px">Loading the editor…</div>';
  const dctx = await api('design/' + id + (lang ? '?lang=' + lang : '')), dr = dctx.draft, assets = Object.fromEntries(dctx.assets.map(a => [a.id, a]));
  const gfx = dctx.graphics.filter(g => (g.draft_id ?? null) === (dr?.id ?? null) && g.spec?.version === 2);
  let tplId = +q.get('template') || dctx.templates[0]?.id, serverDoc = await api(`design/${id}/doc?lang=${lang}&template_id=${tplId}`), tplMeta = serverDoc.template;
  const opened = gfx[0] ?? null, startDoc = opened ? G.sanitizeDoc(opened.spec) : serverDoc.doc;
  const S = { hist: createHistory(startDoc), sel: null, hover: null, zoom: 1, rulers: false, guidesOn: true, safe: true, snap: true, guides: [], snapGuides: [], mode: null, space: false, saving: false, error: '', seq: 0, base: null, lastPreview: null, nudge: 1, bigNudge: 10, warnings: [], tname: tplMeta.name, conflict: null };
  const curBase = () => dctx.graphics.filter(g => (g.draft_id ?? null) === (dr?.id ?? null) && g.format === (S.hist.doc.meta.format || 'custom')).map(g => g.id).sort((a, b) => b - a)[0] ?? null;
  S.base = curBase();
  const doc = () => S.hist.doc, el = () => (S.sel ? C.getEl(doc(), S.sel) : null), W = () => doc().canvas.w, H = () => doc().canvas.h;
  const rolesText = ['headline', 'subheadline', 'category', 'date', 'source'];

  main.innerHTML = `<div class="ed" id="ed">
    <div class="ed-top">
      <a href="#/story/${id}" class="btn" title="Back to the story">← Back</a>
      <input id="tn" class="ed-name" aria-label="Template name" value="${esc(S.tname)}" maxlength="60">
      <span class="ed-sep"></span><button id="undo" title="Undo (Ctrl/⌘ Z)">↶</button><button id="redo" title="Redo (Ctrl/⌘ Shift Z)">↷</button>
      <span class="ed-sep"></span><span class="mut" title="Workspace zoom only changes the view, not the design">View</span><button id="zo" title="Zoom out">−</button><span id="zl" class="ed-zl">100%</span><button id="zi" title="Zoom in">+</button><button id="zf" title="Fit canvas to the screen">Fit</button>
      <span class="ed-sep"></span><label class="ed-tg"><input type="checkbox" id="trul"> Rulers</label><label class="ed-tg"><input type="checkbox" id="tgui" checked> Guides</label><label class="ed-tg"><input type="checkbox" id="tsaf" checked> Safe area</label><label class="ed-tg" title="Hold Alt while dragging to snap off temporarily"><input type="checkbox" id="tsnap" checked> Snap</label>
      <span class="ed-sep"></span><select id="csz" aria-label="Canvas size">${Object.entries(G.CANVAS_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)} · ${p.w}×${p.h}</option>`).join('')}<option value="custom">Custom…</option></select>
      <select id="cmode" aria-label="When the size changes"><option value="scale">Scale layout</option><option value="keep">Keep positions</option><option value="fit-image">Fit image</option><option value="reset">Reset to template</option></select><button id="capply">Apply size</button>
      <span class="ed-grow"></span><span id="ss" class="ed-status" role="status"></span>
      <button id="prev">Preview</button><button id="exp">Export</button><button class="pri" id="save" title="Save (Ctrl/⌘ S)">Save graphic</button>
      <select id="tmenu" aria-label="Template actions"><option value="">Template…</option><option value="new">Save as new template</option><option value="update">Update this template</option><option value="dup">Duplicate template</option><option value="versions">Restore an earlier version</option></select><button id="revert" class="ghost">Revert</button>
    </div>
    <div id="eban"></div>
    <div class="ed-body"><aside class="ed-left" id="el" aria-label="Layers"></aside><section class="ed-mid"><div class="ed-view" id="ev" tabindex="-1"><div class="ed-stage" id="es"><img id="eb" alt="Design preview" draggable="false"><svg id="eo" aria-label="Design canvas"></svg></div></div><div id="ewarn" class="ed-warn"></div></section><aside class="ed-right" id="er" aria-label="Properties"></aside></div>
  </div>`;
  const stage = $('#es'), svg = $('#eo'), view = $('#ev'), eb = $('#eb');
  $('#csz').value = Object.entries(G.CANVAS_PRESETS).find(([, p]) => p.w === W() && p.h === H())?.[0] ?? 'custom';

  /* ---------- workspace ---------- */
  const setZoom = z => { S.zoom = G.clamp(z, 0.1, 4); stage.style.width = W() * S.zoom + 'px'; stage.style.height = H() * S.zoom + 'px'; $('#zl').textContent = Math.round(S.zoom * 100) + '%'; draw(); };
  const fit = () => setZoom(Math.min((view.clientWidth - 48) / W(), (view.clientHeight - 48) / H()));
  const toDesign = e => { const r = svg.getBoundingClientRect(); return { x: ((e.clientX - r.left) * W()) / r.width, y: ((e.clientY - r.top) * H()) / r.height }; };

  /* ---------- drawing the editor-only overlay (never part of an export) ---------- */
  const line = (x1, y1, x2, y2, c, w, dash = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''} vector-effect="non-scaling-stroke"/>`;
  const poly = (pts, c, w, dash = '', fill = 'none') => `<polygon points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="${fill}" stroke="${c}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''} vector-effect="non-scaling-stroke"/>`;
  function draw() {
    const w = W(), h = H(), z = S.zoom; svg.setAttribute('viewBox', `0 0 ${w} ${h}`); let s = '';
    if (S.safe) { const a = G.safeArea(doc().canvas, doc().meta.safe ?? 0.06); s += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="none" stroke="#19b3a6" stroke-width="1" stroke-dasharray="6 5" vector-effect="non-scaling-stroke"/>`; }
    if (S.rulers) { const step = z < 0.4 ? 200 : z < 0.8 ? 100 : 50, fs = 11 / z; for (let x = 0; x <= w; x += step) s += line(x, 0, x, 10 / z, '#888', 1) + `<text x="${x + 2 / z}" y="${22 / z}" font-size="${fs}" fill="#666">${x}</text>`; for (let y = 0; y <= h; y += step) s += line(0, y, 10 / z, y, '#888', 1) + `<text x="${12 / z}" y="${y + 12 / z}" font-size="${fs}" fill="#666">${y}</text>`; }
    if (S.guidesOn) for (const g of S.guides) s += g.axis === 'x' ? line(g.pos, 0, g.pos, h, '#9b59b6', 1, '4 3') : line(0, g.pos, w, g.pos, '#9b59b6', 1, '4 3');
    for (const g of S.snapGuides) s += g.axis === 'x' ? line(g.pos, 0, g.pos, h, '#ff2d55', 1.5) : line(0, g.pos, w, g.pos, '#ff2d55', 1.5);
    const hov = S.hover && S.hover !== S.sel ? C.getEl(doc(), S.hover) : null; if (hov) s += poly(G.corners(hov), '#3b82f6', 1, '4 3');
    const e = el();
    if (e) {
      const locked = e.locked || e.visible === false; s += poly(G.corners(e), locked ? '#999' : '#2563eb', 1.5, locked ? '5 4' : '');
      if (!locked) { const { points, radius } = C.handlePoints(e, z); s += line(...[(points.n.x), (points.n.y), (points.rotate.x), (points.rotate.y)], '#2563eb', 1);
        for (const [k, p] of Object.entries(points)) s += k === 'rotate' ? `<circle cx="${p.x}" cy="${p.y}" r="${radius * 0.9}" fill="#fff" stroke="#2563eb" stroke-width="1.5" vector-effect="non-scaling-stroke" data-h="rotate" style="cursor:grab"/>` : `<rect x="${p.x - radius / 2}" y="${p.y - radius / 2}" width="${radius}" height="${radius}" fill="#fff" stroke="#2563eb" stroke-width="1.5" vector-effect="non-scaling-stroke" data-h="${k}" style="cursor:${k.length === 2 ? (k === 'nw' || k === 'se' ? 'nwse-resize' : 'nesw-resize') : (k === 'n' || k === 's' ? 'ns-resize' : 'ew-resize')}"/>`; }
    }
    svg.innerHTML = s;
  }

  /* ---------- the live preview comes from the SERVER renderer, i.e. the same code as the export ---------- */
  let pt; const schedulePreview = (now = false) => { clearTimeout(pt); pt = setTimeout(async () => { const my = ++S.seq, scale = G.clamp(S.zoom * (window.devicePixelRatio || 1), 0.35, 1);
    try { const r = await api('graphics/preview-doc', { method: 'POST', body: { doc: doc(), cluster_id: id, scale, photoAssetId: dctx.lead_asset_id } }); if (my !== S.seq) return; S.lastPreview = r; eb.src = 'data:image/png;base64,' + r.png; S.warnings = r.warnings; showWarn(); }
    catch (x) { if (x !== ctx.AUTH && my === S.seq) { S.error = x.message; showWarn(); } } }, now ? 0 : 90); };
  const showWarn = () => { const e = el(), extra = e ? [C.unlockedWarning(e)].filter(Boolean).map(m => ({ severity: 'warn', message: m })) : [], all = [...extra, ...S.warnings.filter(w => w.severity !== 'info')];
    $('#ewarn').innerHTML = (S.error ? `<div class="err">${esc(S.error)}</div>` : '') + (all.map(w => `<div class="${w.severity === 'error' ? 'err' : 'mut'}">⚠ ${esc(w.message)}</div>`).join('') || '<div class="mut">No layout warnings.</div>') + `<div class="mut">Canvas ${W()}×${H()} design pixels. Positions and sizes are in design pixels; view zoom does not change them.</div>`; };

  /* ---------- layers ---------- */
  function renderLayers() {
    const rows = C.layerRows(doc());
    $('#el').innerHTML = `<div class="side-h">Layers</div><div class="row" style="margin:6px 0"><button data-add="text">+ Text</button><button data-add="shape">+ Shape</button><button data-add="gradient">+ Gradient</button><button data-upload="1" title="Upload your own image (PNG, JPEG or WebP, up to 12 MB)">⬆ Upload image…</button><input type="file" id="upf" accept="image/png,image/jpeg,image/webp" hidden><select data-add="image"><option value="">+ Image…</option>${dctx.assets.filter(a => a.kind === 'logo' || a.cluster_id === id).map(a => `<option value="${a.id}">${a.kind} #${a.id} · ${a.width}×${a.height}</option>`).join('')}</select></div>
    <div id="lrows">${rows.map((r, i) => `<div class="lr ${r.id === S.sel ? 'on' : ''} ${r.visible ? '' : 'off'}" draggable="true" data-id="${esc(r.id)}" data-i="${i}"><button data-a="vis" title="${r.visible ? 'Hide' : 'Show'}" aria-label="Toggle visibility">${r.visible ? '👁' : '·'}</button><button data-a="lock" title="${r.locked ? 'Unlock' : 'Lock'}" aria-label="Toggle lock">${r.locked ? '🔒' : '🔓'}</button><span class="ln" data-a="name" title="Double-click to rename">${esc(r.name)}</span><span class="mut lt">${esc(r.type)}</span>
      <span class="la"><button data-a="fwd" title="Forward">▲</button><button data-a="bwd" title="Backward">▼</button><button data-a="front" title="Bring to front">⤒</button><button data-a="back" title="Send to back">⤓</button><button data-a="dup" title="Duplicate (Ctrl/⌘ D)">⧉</button><button data-a="del" title="Delete">🗑</button></span></div>`).join('')}</div>
    ${dctx.reference_images?.length ? `<div class="side-h" style="margin-top:14px">Images in the source reports</div><div class="mut" style="font-size:11px">Reference only until you confirm you may use one.</div><div class="row">${dctx.reference_images.map(r => `<div style="width:72px"><img src="${ctx.isrc ? ctx.isrc(r.id, 160) : ''}" width="72" height="54" alt="" loading="lazy" style="object-fit:cover"><div class="mut" style="font-size:10px">${esc(r.source)}${r.generic ? ' · <b style="color:var(--red)">default image?</b>' : ''}</div><button data-adopt="${r.id}" data-generic="${r.generic ? 1 : ''}" style="font-size:11px;padding:1px 5px">Use…</button></div>`).join('')}</div>` : ''}<div class="side-h" style="margin-top:14px">Saved versions</div>${gfx.length ? gfx.slice(0, 8).map(g => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--rule)"><img src="/api/graphics/${g.id}/file" alt="" style="width:44px;height:44px;object-fit:cover"><span class="mut" style="flex:1">${ctx.rel(g.created_at)}${g.status === 'current' ? ' · current' : ''}${g.stale ? ' · text outdated' : ''}</span><button data-open="${g.id}">Open</button></div>`).join('') : '<div class="mut">Nothing saved yet.</div>'}`;
  }

  /* ---------- properties ---------- */
  const num = (k, label, v, step = 1, extra = '') => `<label class="ed-f">${label}<input type="number" data-p="${k}" value="${Math.round(v * 100) / 100}" step="${step}" ${extra}></label>`;
  function renderProps() {
    const e = el(), box = $('#er'); if (!e) { box.innerHTML = `<div class="side-h">Properties</div><div class="mut">Select a layer on the canvas or in the list. Drag to move; corner handles resize; the round handle rotates. Arrow keys nudge (Shift = ${S.bigNudge} px).</div><div class="row" style="margin-top:10px"><label class="ed-f">Nudge px<input type="number" id="nud" value="${S.nudge}" min="0.1" step="0.5"></label><label class="ed-f">Shift nudge<input type="number" id="nud2" value="${S.bigNudge}" min="1" step="1"></label></div>
      <div class="side-h" style="margin-top:14px">Guides</div><div class="row"><select id="gax"><option value="x">Vertical at X</option><option value="y">Horizontal at Y</option></select><input type="number" id="gpos" value="${Math.round(W() / 2)}" style="width:80px"><button id="gadd">Add</button></div>${S.guides.map((g, i) => `<div class="row mut">${g.axis === 'x' ? 'X' : 'Y'} = ${g.pos} <button data-gdel="${i}">×</button></div>`).join('')}`; return; }
    const locked = e.locked ? '<div class="err">This layer is locked: unlock it in the Layers list to edit its position or size.</div>' : '', ro = e.locked ? 'disabled' : '', a = assets[e.asset] ?? (e.type === 'image' && e.role === 'photo' ? assets[dctx.lead_asset_id] : null);
    let s = `<div class="side-h">${esc(e.name)} <span class="mut">${esc(e.type)}</span></div>${locked}<div class="mut" style="font-size:11px">Design pixels · origin top-left of the canvas · rotation about the centre</div>
      <div class="ed-grid">${num('x', 'X', e.x, 1, ro)}${num('y', 'Y', e.y, 1, ro)}${num('w', 'Width', e.w, 1, ro + ' min="4"')}${num('h', 'Height', e.h, 1, ro + ' min="4"')}</div>
      <div class="row" style="margin:6px 0"><button data-p-toggle="lockAspect" class="${e.lockAspect ? 'pri' : ''}" aria-pressed="${e.lockAspect}" title="Keep width and height proportional">${e.lockAspect ? '🔒 Aspect locked' : '🔓 Aspect unlocked'}</button>${!e.lockAspect && e.type === 'image' ? '<span class="err" style="padding:2px 6px">may stretch</span>' : ''}</div>
      <div class="ed-grid">${num('rotation', 'Rotation °', e.rotation, 1, ro)}<label class="ed-f">Opacity <b data-v="opacity">${Math.round(e.opacity * 100)}%</b><input type="range" data-p="opacity" data-live min="0" max="1" step="0.01" value="${e.opacity}"></label></div>
      <div class="row" style="margin:6px 0">${[['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']].map(([k, t]) => `<button data-al="${k}" title="Align ${k}" ${ro}>${t}</button>`).join('')}<button data-p-reset="rotation" ${ro}>Reset rotation</button></div>`;
    if (e.type === 'image') {
      const en = a ? G.enlargement(e, a.width, a.height) : null;
      s += `<div class="side-h" style="margin-top:10px">Image</div><label class="ed-f">Fit<select data-p="fit"><option value="cover" ${e.fit === 'cover' ? 'selected' : ''}>Cover (fill frame)</option><option value="contain" ${e.fit === 'contain' ? 'selected' : ''}>Contain (whole image)</option><option value="blur" ${e.fit === 'blur' ? 'selected' : ''}>Blurred background</option><option value="manual" ${e.fit === 'manual' ? 'selected' : ''}>Manual (frame = image size)</option></select></label>
      <label class="ed-f">Image zoom <b data-v="zoom">${(+e.zoom).toFixed(2)}×</b><input type="range" data-p="zoom" data-live min="0.1" max="5" step="0.01" value="${e.zoom}"></label><div class="mut" style="font-size:11px">1.00× = the fitted size for the chosen fit mode (not the view zoom).</div>
      <div class="ed-grid">${num('zoom', 'Zoom (number)', e.zoom, 0.05)}${num('ox', 'Offset X', e.ox, 1)}${num('oy', 'Offset Y', e.oy, 1)}${num('radius', 'Corner radius', e.radius ?? 0, 1, 'min="0"')}</div>
      ${e.fit === 'blur' ? num('blur', 'Blur amount', e.blur ?? 28, 1, 'min="0" max="120"') : ''}
      <div class="row"><label class="ed-tg"><input type="checkbox" data-p="clip" ${e.clip ? 'checked' : ''}> Clip to frame</label><label class="ed-tg"><input type="checkbox" data-p="grayscale" ${e.grayscale ? 'checked' : ''}> Black &amp; white</label><label class="ed-tg" title="A white rounded card behind the image, useful for dark logos on dark photos"><input type="checkbox" data-p="backing" ${e.backing ? 'checked' : ''}> White card behind</label></div>
      <div class="row" style="margin-top:6px"><button data-ip="fit">Fit to frame</button><button data-ip="fill">Fill frame</button><button data-ip="original">Original size</button><button data-ip="center">Centre in frame</button><button data-ip="reset">Reset transform</button></div>
      ${a ? `<div class="mut" style="margin-top:6px">Original file ${a.width}×${a.height}px (never modified). Shown at ${en.toFixed(2)}× ${en > 1.5 ? '<b style="color:var(--red)">· enlarged: may look soft</b>' : en > 1 ? '· slightly enlarged' : '· sharp'}.${a.rights_note ? '' : ' <b style="color:var(--red)">No permission recorded.</b>'}</div>` : '<div class="mut" style="margin-top:6px">No image assigned: choose one under Layers → “+ Image…”.</div>'}`;
    } else if (e.type === 'text') {
      s += `<div class="side-h" style="margin-top:10px">Text</div><label class="ed-f">Content (wrap words in [[ ]] to highlight)<textarea data-p="text" data-live rows="4">${esc(e.text)}</textarea></label>
      <div class="ed-grid"><label class="ed-f">Font<select data-p="font">${['head', 'sub', 'bold', 'small', 'badge'].map(f => `<option ${f === e.font ? 'selected' : ''}>${f}</option>`).join('')}</select></label>${num('size', 'Size', e.size, 1, 'min="6"')}${num('lineHeight', 'Line height', e.lineHeight, 1, 'min="6"')}<label class="ed-f">Align<select data-p="align">${['left', 'center', 'right'].map(f => `<option ${f === e.align ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label class="ed-f">Colour<input type="color" data-p="color" value="${e.color}"></label><label class="ed-f">Highlight<input type="color" data-p="accent" value="${e.accent}"></label>${num('maxLines', 'Max lines (0 = any)', e.maxLines ?? 0, 1, 'min="0"')}</div><label class="ed-tg"><input type="checkbox" data-p="shrink" ${e.shrink ? 'checked' : ''}> Shrink to fit the box</label>`;
    } else if (e.type === 'shape') s += `<div class="side-h" style="margin-top:10px">Shape</div><div class="ed-grid"><label class="ed-f">Fill<input type="color" data-p="fill" value="${e.fill}"></label>${num('alpha', 'Fill opacity', e.alpha, 0.05, 'min="0" max="1"')}${num('radius', 'Corner radius', e.radius ?? 0, 1, 'min="0"')}</div>`;
    else if (e.type === 'badge') s += `<div class="side-h" style="margin-top:10px">Badge</div><div class="ed-grid"><label class="ed-f">Left text<input data-p="left" value="${esc(e.left)}"></label><label class="ed-f">Right text<input data-p="right" value="${esc(e.right)}"></label><label class="ed-f">Left colour<input type="color" data-p="leftColor" value="${e.leftColor}"></label><label class="ed-f">Right colour<input type="color" data-p="rightColor" value="${e.rightColor}"></label></div>`;
    else if (e.type === 'gradient') s += `<div class="side-h" style="margin-top:10px">Gradient (top → bottom)</div>${e.stops.map((st, i) => `<div class="row"><label class="ed-f">At<input type="number" data-stop="${i}" data-sk="at" value="${st.at}" step="0.05" min="0" max="1" style="width:70px"></label><input type="color" data-stop="${i}" data-sk="color" value="${st.color}"><label class="ed-f">Opacity<input type="number" data-stop="${i}" data-sk="alpha" value="${st.alpha}" step="0.05" min="0" max="1" style="width:70px"></label></div>`).join('')}`;
    box.innerHTML = s;
  }
  const syncProps = () => { const e = el(); if (!e) return; for (const inp of main.querySelectorAll('#er [data-p]')) { if (inp === document.activeElement || inp.type === 'checkbox') continue; const k = inp.dataset.p; if (k in e && inp.tagName === 'INPUT') inp.value = inp.type === 'number' ? Math.round(+e[k] * 100) / 100 : e[k]; } for (const b of main.querySelectorAll('#er [data-v]')) { const k = b.dataset.v; b.textContent = k === 'opacity' ? Math.round(e.opacity * 100) + '%' : (+e[k]).toFixed(2) + '×'; } };
  const status = () => { $('#ss').textContent = S.saving ? 'Saving…' : S.error && /save/i.test(S.error) ? 'Save failed' : S.hist.dirty ? '● Unsaved changes' : '✓ Saved'; $('#ss').className = 'ed-status ' + (S.hist.dirty ? 'dirty' : ''); $('#undo').disabled = !S.hist.canUndo; $('#redo').disabled = !S.hist.canRedo; };
  const all = (preview = true) => { draw(); renderLayers(); renderProps(); status(); showWarn(); if (preview) schedulePreview(); };
  const commit = d => { S.hist.commit(d); all(); }; const live = d => { S.hist.update(d); draw(); syncProps(); status(); schedulePreview(); };
  const select = sid => { S.sel = sid; renderLayers(); renderProps(); draw(); showWarn(); };

  /* ---------- pointer interaction on the canvas ---------- */
  svg.addEventListener('pointerdown', e => {
    if (e.button === 2) return; svg.setPointerCapture(e.pointerId);
    if (e.button === 1 || S.space) { S.mode = { type: 'pan', x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop }; e.preventDefault(); return; }
    const p = toDesign(e), cur = el(), h = cur && !cur.locked && cur.visible !== false ? C.hitHandle(cur, p, S.zoom) : null;
    if (h) { S.hist.begin(); S.mode = { type: h === 'rotate' ? 'rotate' : 'resize', handle: h, start: { ...cur }, p0: p }; return; }
    const inside = cur && !cur.locked && cur.visible !== false && G.pointInElement(p, cur) && !(e.ctrlKey || e.metaKey); // a drag inside the selected layer moves it even if another layer is stacked above; Ctrl/⌘+click picks the topmost layer
    const hit = inside ? cur.id : G.hitTest(doc().elements, p); if (!hit) { select(null); return; } if (hit !== S.sel) select(hit);
    S.hist.begin(); S.mode = { type: 'move', start: { ...C.getEl(doc(), hit) }, p0: p };
  });
  svg.addEventListener('pointermove', e => {
    const m = S.mode;
    if (!m) { const hov = G.hitTest(doc().elements, toDesign(e)); if (hov !== S.hover) { S.hover = hov; draw(); } return; }
    if (m.type === 'pan') { view.scrollLeft = m.sl - (e.clientX - m.x); view.scrollTop = m.st - (e.clientY - m.y); return; }
    const p = toDesign(e), dx = p.x - m.p0.x, dy = p.y - m.p0.y; let patch;
    if (m.type === 'move') { const r = C.dragMove(m.start, dx, dy, { canvas: doc().canvas, others: doc().elements, guides: S.guides, snap: S.snap && !e.altKey, axisLock: e.shiftKey, tol: 6 / S.zoom }); patch = r.patch; S.snapGuides = r.guides; }
    else if (m.type === 'resize') patch = C.dragResize(m.start, m.handle, dx, dy, { shift: e.shiftKey, alt: e.altKey }); else patch = C.dragRotate(m.start, p, { snap: e.shiftKey });
    live(C.replaceEl(doc(), m.start.id, patch));
  });
  const finish = cancel => { const m = S.mode; if (!m) return; S.mode = null; S.snapGuides = []; if (m.type !== 'pan') { if (cancel) S.hist.cancel(); else S.hist.end(); } all(); };
  svg.addEventListener('pointerup', () => finish(false)); svg.addEventListener('pointercancel', () => finish(true)); svg.addEventListener('lostpointercapture', () => S.mode && finish(false));
  svg.addEventListener('dblclick', () => { const e = el(); if (e?.type === 'text') { const t = $('#er [data-p="text"]'); t?.focus(); } });
  view.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });

  /* ---------- keyboard (never while typing) ---------- */
  const typing = t => !!t?.closest?.('input,textarea,select,[contenteditable="true"]');
  const onKey = e => {
    if (e.key === ' ' && !typing(e.target)) { S.space = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
    const a = C.keyAction({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, typing: typing(e.target) }, { nudge: S.nudge, bigNudge: S.bigNudge }); if (!a) return;
    if (a.type === 'escape') { if (S.mode) finish(true); else if (S.hist.active) { S.hist.cancel(); all(); } else select(null); return; }
    e.preventDefault();
    if (a.type === 'undo') { S.hist.undo(); if (S.sel && !el()) S.sel = null; all(); } else if (a.type === 'redo') { S.hist.redo(); if (S.sel && !el()) S.sel = null; all(); } else if (a.type === 'save') save();
    else if (a.type === 'duplicate' && S.sel) duplicate(S.sel); else if (a.type === 'delete' && S.sel) del(S.sel); else if (a.type === 'nudge' && S.sel) commitNudge(a.dx, a.dy);
  };
  let nudgeTimer; const commitNudge = (dx, dy) => { if (!S.hist.active) S.hist.begin(); S.hist.update(C.nudge(doc(), S.sel, dx, dy)); draw(); syncProps(); schedulePreview(); clearTimeout(nudgeTimer); nudgeTimer = setTimeout(() => { S.hist.end(); status(); }, 400); }; // a burst of arrow presses is one undo step
  const onKeyUp = e => { if (e.key === ' ') { S.space = false; view.style.cursor = ''; } };
  document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKeyUp);
  const onBlur = () => { S.space = false; if (S.mode) finish(true); }; window.addEventListener('blur', onBlur); // lost focus mid-drag: cancel safely

  /* ---------- actions ---------- */
  const duplicate = sid => { const r = G.duplicateLayer(doc().elements, sid); if (!r.id) return; commit({ ...doc(), elements: r.elements }); select(r.id); };
  const del = sid => { const e = C.getEl(doc(), sid); if (!e || !confirm(`Delete “${e.name}”? You can undo this.`)) return; S.sel = null; commit({ ...doc(), elements: G.removeLayer(doc().elements, sid) }); };
  $('#el').addEventListener('click', ev => {
    const t = ev.target, row = t.closest('.lr'), add = t.dataset?.add;
    if (t.dataset?.upload) { $('#upf').click(); return; }
    if (t.dataset?.adopt) { (async () => { const rights = prompt('Describe the licence or permission you hold for this image (it is stored with the image):'); if (!rights) return; try { await api(`story/${id}/adopt-image`, { method: 'POST', body: { article_id: +t.dataset.adopt, rights_note: rights, confirm_generic: !!t.dataset.generic && confirm('This looks like the publisher’s default image. Use it anyway?') } }); toast('Image added to this story'); if (window.__cleanup) { window.__cleanup(); window.__cleanup = null; } await editor(ctx, id); } catch (x) { fail(x); } })(); return; } if (t.dataset?.open) { const g = gfx.find(x => x.id === +t.dataset.open); if (g) { commit(G.sanitizeDoc(g.spec)); S.base = curBase(); toast('Opened that saved version (not saved again until you press Save)'); } return; }
    if (add && add !== 'image') { const e = C.defaultElement(add, doc().canvas, doc().elements); commit({ ...doc(), elements: [...doc().elements, e] }); select(e.id); return; }
    if (!row) return; const sid = row.dataset.id, a = t.dataset?.a;
    if (a === 'vis' || a === 'lock') commit(C.toggleProp(doc(), sid, a === 'vis' ? 'visible' : 'locked')); else if (['fwd', 'bwd', 'front', 'back'].includes(a)) commit({ ...doc(), elements: G.moveLayer(doc().elements, sid, { fwd: 'forward', bwd: 'backward', front: 'front', back: 'back' }[a]) });
    else if (a === 'dup') duplicate(sid); else if (a === 'del') del(sid); else select(sid);
  });
  $('#el').addEventListener('change', async ev => {
    const t = ev.target; if (t.id !== 'upf' || !t.files[0]) return; const f = t.files[0]; t.value = '';
    if (!confirm(`Use “${f.name}”?\n\nOnly continue if you own this image or have permission to use it. This is recorded with the image.`)) return;
    try {
      const r = await ctx.uploadAsset(f, 'photo', id, 'uploader confirmed ownership or permission (custom upload in the layered editor)'); const fresh = await api('design/' + id + (lang ? '?lang=' + lang : '')); dctx.assets = fresh.assets; dctx.lead_asset_id = fresh.lead_asset_id; for (const a of fresh.assets) assets[a.id] = a;
      const asLead = confirm('Make this the story’s lead image?\n\nOK = yes: the website article and every graphic of this story will use it.\nCancel = add it as an extra layer on this graphic only.');
      if (asLead) { await api(`story/${id}/lead-image`, { method: 'POST', body: { asset_id: r.id } }); dctx.lead_asset_id = r.id; const ph = doc().elements.find(e => e.type === 'image' && e.role === 'photo'); if (ph) { commit(C.replaceEl(doc(), ph.id, { asset: r.id, fit: 'cover', zoom: 1, ox: 0, oy: 0 })); select(ph.id); } else { const e = C.defaultElement('image', doc().canvas, doc().elements, { asset: r.id, role: 'photo', x: 0, y: 0, w: W(), h: H(), name: 'Article image' }); commit({ ...doc(), elements: [e, ...doc().elements] }); select(e.id); } toast(`Lead image set (${r.width}×${r.height})`); }
      else { const w = Math.min(r.width, W() * 0.6), e = C.defaultElement('image', doc().canvas, doc().elements, { asset: r.id, w, h: Math.round(w * r.height / r.width), fit: 'cover', name: `Custom image #${r.id}` }); commit({ ...doc(), elements: [...doc().elements, e] }); select(e.id); toast(`Image added as a layer (${r.width}×${r.height})`); }
    } catch (x) { fail(x); }
  });
  $('#el').addEventListener('change', ev => { const t = ev.target; if (t.dataset?.add === 'image' && t.value) { const a = assets[+t.value], e = C.defaultElement('image', doc().canvas, doc().elements, { asset: +t.value, w: Math.min(a.width, 400), h: Math.round(Math.min(a.width, 400) * a.height / a.width), fit: 'cover', name: `${a.kind === 'logo' ? 'Logo' : 'Image'} #${a.id}`, ...(a.kind === 'logo' ? { role: 'logo', fit: 'contain', clip: false } : {}) }); t.value = ''; commit({ ...doc(), elements: [...doc().elements, e] }); select(e.id); } });
  $('#el').addEventListener('dblclick', ev => { const n = ev.target.closest('[data-a="name"]'); if (!n) return; const sid = n.closest('.lr').dataset.id, v = prompt('Rename layer', C.getEl(doc(), sid).name); if (v !== null) commit(C.renameLayer(doc(), sid, v)); });
  let dragId = null; const lr = $('#el');
  lr.addEventListener('dragstart', ev => { const r = ev.target.closest?.('.lr'); if (!r) return; dragId = r.dataset.id; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', dragId); });
  lr.addEventListener('dragover', ev => { if (dragId && ev.target.closest('.lr')) { ev.preventDefault(); ev.target.closest('.lr').classList.add('over'); } }); lr.addEventListener('dragleave', ev => ev.target.closest?.('.lr')?.classList.remove('over'));
  lr.addEventListener('drop', ev => { const r = ev.target.closest('.lr'); if (!r || !dragId) return; ev.preventDefault(); const to = +r.dataset.i, id0 = dragId; dragId = null; commit(C.dropLayer(doc(), id0, to)); });
  lr.addEventListener('dragend', () => { dragId = null; });

  const props = $('#er');
  props.addEventListener('input', ev => { const t = ev.target; if (t.dataset?.live === undefined || !S.sel) return; if (!S.hist.active) S.hist.begin(); const r = C.applyProp(doc(), S.sel, t.dataset.p, t.type === 'range' ? t.value : t.value); if (!r.error) live(r.doc); });
  props.addEventListener('change', ev => {
    const t = ev.target, e = el(); if (t.id === 'nud') { S.nudge = Math.max(0.1, +t.value || 1); return; } if (t.id === 'nud2') { S.bigNudge = Math.max(1, +t.value || 10); return; }
    if (t.dataset?.stop !== undefined && e) { const stops = e.stops.map((s, i) => (i === +t.dataset.stop ? { ...s, [t.dataset.sk]: t.dataset.sk === 'color' ? t.value : +t.value } : s)); commit(C.replaceEl(doc(), e.id, { stops })); return; }
    if (!e || t.dataset?.p === undefined) return; if (S.hist.active && t.dataset.live !== undefined) { S.hist.end(); all(); return; }
    let v = t.type === 'checkbox' ? t.checked : t.value; const r = C.applyProp(doc(), e.id, t.dataset.p, v); if (r.error) { toast(r.error, true); renderProps(); return; } commit(r.doc);
  });
  props.addEventListener('click', ev => {
    const t = ev.target, e = el(); if (t.id === 'gadd') { const pos = +$('#gpos').value; if (Number.isFinite(pos)) { S.guides.push({ axis: $('#gax').value, pos }); all(false); } return; } if (t.dataset?.gdel !== undefined) { S.guides.splice(+t.dataset.gdel, 1); all(false); return; } if (!e) return;
    if (t.dataset.pToggle) commit(C.replaceEl(doc(), e.id, { [t.dataset.pToggle]: !e[t.dataset.pToggle] })); else if (t.dataset.pReset) commit(C.replaceEl(doc(), e.id, { [t.dataset.pReset]: 0 }));
    else if (t.dataset.al) commit(C.replaceEl(doc(), e.id, (({ x, y }) => ({ x, y }))(G.alignTo(e, doc().canvas, t.dataset.al)))); else if (t.dataset.ip) { const a = assets[e.asset] ?? assets[dctx.lead_asset_id]; if (a) commit(C.replaceEl(doc(), e.id, C.imagePreset(e, t.dataset.ip, a.width, a.height, doc().canvas))); }
  });

  /* ---------- toolbar ---------- */
  $('#undo').onclick = () => { S.hist.undo(); if (S.sel && !el()) S.sel = null; all(); }; $('#redo').onclick = () => { S.hist.redo(); if (S.sel && !el()) S.sel = null; all(); };
  $('#zo').onclick = () => setZoom(S.zoom / 1.2); $('#zi').onclick = () => setZoom(S.zoom * 1.2); $('#zf').onclick = fit;
  $('#trul').onchange = e => { S.rulers = e.target.checked; draw(); }; $('#tgui').onchange = e => { S.guidesOn = e.target.checked; draw(); }; $('#tsaf').onchange = e => { S.safe = e.target.checked; draw(); }; $('#tsnap').onchange = e => { S.snap = e.target.checked; };
  $('#tn').oninput = e => { S.tname = e.target.value; };
  $('#csz').onchange = e => { const p = G.CANVAS_PRESETS[e.target.value]; if (p && p.h / p.w >= 1.7) { $('#cmode').value = 'reset'; toast('For 9:16 the template’s own Story layout is used (it keeps text inside Instagram’s safe zones). You can undo it.'); } }; // scaling a 4:5 layout leaves dead space and ignores the Stories interface
  $('#capply').onclick = async () => {
    let key = $('#csz').value, w, h; if (key === 'custom') { const v = prompt('Canvas size as WIDTH×HEIGHT in pixels (64–4096)', `${W()}x${H()}`); const m = String(v || '').match(/^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i); if (!m) return; w = +m[1]; h = +m[2]; } else ({ w, h } = G.CANVAS_PRESETS[key]);
    const mode = $('#cmode').value; if (w < 64 || h < 64 || w > 4096 || h > 4096 || w * h > 16e6) return toast('That canvas size is out of range.', true);
    try { if (mode === 'reset') { if (!confirm('Replace the current layout with the template’s own layout for this size? You can undo this.')) return; const r = await api(`design/${id}/doc?lang=${lang}&template_id=${tplId}&format=${key}`); commit(r.doc); } else { const d = G.convertCanvas(doc(), w, h, mode); d.meta = { ...d.meta, format: key }; commit(d); }
      S.base = curBase(); S.sel = null; fit(); all(); } catch (x) { fail(x); }
  };
  async function save(asCopy = false) {
    if (S.saving) return; S.saving = true; S.error = ''; S.conflict = null; status(); const btn = $('#save'); btn.disabled = true;
    try { const r = await api('graphics', { method: 'POST', body: { cluster_id: id, draft_id: dr?.id ?? null, doc: doc(), template_id: tplId, strict: true, base_graphic_id: asCopy ? S.conflict?.current ?? S.base : S.base, outFormat: 'png', photoAssetId: dctx.lead_asset_id } });
      S.hist.markSaved(); S.base = r.id; toast(r.unapproved ? 'Saved — note: the draft is not approved yet' : 'Graphic saved'); $('#eban').innerHTML = ''; S.lastSaved = r.id; return r.id; }
    catch (x) { if (x === ctx.AUTH) return; S.error = 'Save failed: ' + x.message; if (/newer version/.test(x.message)) $('#eban').innerHTML = `<div class="err ed-ban">${esc(x.message)} <button id="copysave">Save over it anyway</button> <button id="reloadnew">Reload newest</button></div>`; else toast(S.error, true); }
    finally { S.saving = false; btn.disabled = false; status(); showWarn(); }
  }
  $('#save').onclick = () => save();
  $('#eban').addEventListener('click', async ev => { if (ev.target.id === 'copysave') { const g = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.base = g.graphics.filter(x => (x.draft_id ?? null) === (dr?.id ?? null) && x.format === (doc().meta.format || 'custom')).map(x => x.id).sort((a, b) => b - a)[0] ?? null; $('#eban').innerHTML = ''; save(); } else if (ev.target.id === 'reloadnew') { S.hist.markSaved(); location.reload(); } });
  $('#exp').onclick = async () => { const gid = await save(); if (!gid) return; const a = document.createElement('a'); a.href = `/api/graphics/${gid}/file?download=1`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); };
  $('#prev').onclick = async () => { const m = document.createElement('div'); m.className = 'ed-modal'; m.innerHTML = '<div class="ed-mbox"><div class="row"><b>Preview at export size</b><span class="ed-grow"></span><button id="mc">Close</button></div><div id="mi" class="mut">Rendering…</div></div>'; document.body.appendChild(m); const close = () => m.remove(); m.querySelector('#mc').onclick = close; m.onclick = e => e.target === m && close();
    try { const r = await api('graphics/preview-doc', { method: 'POST', body: { doc: doc(), cluster_id: id, scale: 1, photoAssetId: dctx.lead_asset_id } }); m.querySelector('#mi').innerHTML = `<img alt="Full-size preview" src="data:image/png;base64,${r.png}" style="max-width:100%;max-height:78vh"><div class="mut">${r.width}×${r.height}px — this is the renderer that produces the export.</div>`; } catch (x) { m.querySelector('#mi').textContent = x.message; } };
  $('#revert').onclick = () => { if (!S.hist.dirty || confirm('Discard all changes since the last save?')) { S.hist.reset(startDoc); S.sel = null; S.base = curBase(); all(); fit(); } };
  $('#tmenu').onchange = async ev => {
    const v = ev.target.value; ev.target.value = ''; if (!v) return;
    try {
      if (v === 'new') { const r = await api('templates', { method: 'POST', body: { name: S.tname, spec: doc() } }).catch(async x => { if (!/already exists/.test(x.message)) throw x; if (!confirm(`${x.message}\n\nReplace the existing template?`)) return null; return api('templates', { method: 'POST', body: { name: S.tname, spec: doc(), overwrite: true, expected_updated_at: tplMeta.updated_at } }); }); if (r) { tplId = r.id; tplMeta = { ...tplMeta, id: r.id, name: S.tname, updated_at: r.updated_at }; toast('Template saved'); } }
      else if (v === 'update') { if (!confirm(`Update the shared template “${tplMeta.name}”? Every story that uses it will open with this layout.`)) return; const r = await api(`templates/${tplId}`, { method: 'PUT', body: { name: S.tname, spec: doc(), expected_updated_at: tplMeta.updated_at } }); tplMeta.updated_at = r.updated_at; toast('Template updated (the previous version is kept)'); }
      else if (v === 'dup') { const r = await api(`templates/${tplId}/duplicate`, { method: 'POST', body: {} }); toast(`Duplicated as “${r.name}”`); }
      else if (v === 'versions') { const vs = await api(`templates/${tplId}/versions`); if (!vs.length) return toast('No earlier versions yet'); const pick = prompt('Restore which version?\n' + vs.map(x => `${x.version}: ${x.saved_at}`).join('\n')); if (!pick) return; const r = await api(`templates/${tplId}/restore`, { method: 'POST', body: { version: +pick, expected_updated_at: tplMeta.updated_at } }); tplMeta.updated_at = r.updated_at; const fresh = await api(`design/${id}/doc?lang=${lang}&template_id=${tplId}`); commit(fresh.doc); toast('Earlier version restored'); }
    } catch (x) { fail(x); }
  };

  /* ---------- lifecycle ---------- */
  window.__guard = () => !S.hist.dirty || confirm('You have unsaved changes in the graphic editor. Leave without saving?');
  window.onbeforeunload = () => (S.hist.dirty ? 'Unsaved changes' : undefined);
  window.__cleanup = () => { document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); window.onbeforeunload = null; window.__guard = null; clearTimeout(pt); clearTimeout(nudgeTimer); };
  if (opened?.stale) $('#eban').innerHTML = `<div class="err ed-ban">The text in your saved design differs from the current draft. <button id="refresh">Use the draft’s text</button></div>`;
  $('#eban').addEventListener('click', ev => { if (ev.target.id === 'refresh') { const fresh = serverDoc.doc, d = JSON.parse(JSON.stringify(doc())); for (const e of d.elements) if (e.type === 'text' && rolesText.includes(e.role)) { const f = fresh.elements.find(x => x.role === e.role && x.type === 'text'); if (f) e.text = f.text; } commit(d); $('#eban').innerHTML = ''; } });
  all(false); requestAnimationFrame(() => { fit(); schedulePreview(true); });
}
