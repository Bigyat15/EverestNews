// Drives the layered editor in a real Chrome (headless) through the DevTools protocol against the harness. Needs Google Chrome; not part of `npm test`.
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url'; import path from 'node:path'; import { writeFileSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SP = process.argv[2], sleep = ms => new Promise(r => setTimeout(r, ms)); const prof = mkdtempSync(tmpdir() + '/chr-');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${prof}`, '--window-size=1500,950', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (list.find(t => t.type === 'page')) break; } catch {} await sleep(250); }
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(), logs = [], dialogs = []; ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Page.javascriptDialogOpening') { dialogs.push(d.params.type + ':' + d.params.message.slice(0, 60)); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type + ': ' + d.params.args.map(a => a.value ?? a.description).join(' ')); else if (d.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed'); return r.result.result.value; };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${SP}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const results = []; const check = (name, ok, info = '') => { results.push([ok, name, info]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };
// design coordinates -> viewport coordinates through the SVG's own box
const pt = async (x, y) => ev(`(()=>{const r=document.querySelector('#eo').getBoundingClientRect(),vb=document.querySelector('#eo').viewBox.baseVal;return {x:r.left+${x}*r.width/vb.width,y:r.top+${y}*r.height/vb.height}})()`);
const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const drag = async (from, to, steps = 8, mods = 0) => { const a = await pt(...from), b = await pt(...to); await mouse('mousePressed', a.x, a.y, { modifiers: mods }); for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { modifiers: mods }); await sleep(15); } await mouse('mouseReleased', b.x, b.y, { modifiers: mods }); await sleep(120); };
const key = async (k, mod = 0, code = k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mod, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : ({ ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Delete: 46, Escape: 27 }[k] || 0) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mod }); await sleep(150); };
const prop = k => ev(`(()=>{const i=document.querySelector('#er [data-p="${k}"]');return i?+i.value:null})()`);
const rows = () => ev(`[...document.querySelectorAll('#lrows .lr')].map(r=>r.querySelector('.ln').textContent)`);
const selName = () => ev(`document.querySelector('#el .lr.on .ln')?.textContent ?? null`);
try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:3599/admin/#/editor/1?lang=ne' });
  for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('#eb')?.src?.startsWith('data:image/png')`).catch(() => false)) break; await sleep(250); }
  await sleep(500); await shot('01-loaded');
  const r0 = await rows(); check('editor loads with layers listed (top first) and the server preview image', r0.length >= 10 && await ev(`document.querySelector('#eb').naturalWidth>100`), r0.slice(0, 4).join(' | '));
  check('toolbar shows saved state and undo is disabled at start', (await ev(`document.querySelector('#ss').textContent`)).includes('Saved') && await ev(`document.querySelector('#undo').disabled`));
  // select the photo by clicking the canvas (only the photo, backdrop and overlay cover the upper area; overlay/gradient above it are hit first, so click via the layers list too)
  await ev(`[...document.querySelectorAll('#lrows .lr')].find(r=>r.querySelector('.ln').textContent==='Article image').click()`); await sleep(150);
  check('selecting a layer shows its properties in design pixels', (await selName()) === 'Article image' && (await prop('w')) === 1080, `w=${await prop('w')} h=${await prop('h')} zoom=${await prop('zoom')}`);
  // make the photo a movable frame: Manual fit, smaller size
  const w0 = await prop('w'), h0 = await prop('h');
  await ev(`(()=>{const i=document.querySelector('#er [data-p="w"]');i.value=600;i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(200);
  const w1 = await prop('w'), h1 = await prop('h'); check('numeric width with the aspect lock on updates height proportionally', Math.abs(h1 / w1 - h0 / w0) < 0.01, `w=${w1} h=${h1}`);
  await ev(`(()=>{const i=document.querySelector('#er [data-p="x"]');i.value=200;i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(100); await ev(`(()=>{const i=document.querySelector('#er [data-p="y"]');i.value=150;i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(300);
  check('numeric X/Y entry', (await prop('x')) === 200 && (await prop('y')) === 150);
  await ev(`document.querySelector('#tsnap').click()`); // snapping off for an exact drag
  // drag the photo from a point inside it (design 500,400 is inside the 200..800 x 150..900 frame, above the overlay layers which were left in place) -> use the selected element
  const before = [await prop('x'), await prop('y')]; await drag([500, 500], [560, 540]); const after = [await prop('x'), await prop('y')];
  check('dragging on the canvas moves the selected image by the pointer delta (design pixels)', Math.abs(after[0] - before[0] - 60) <= 2 && Math.abs(after[1] - before[1] - 40) <= 2, `${before} -> ${after}`);
  await key('z', 4); const undone = [await prop('x'), await prop('y')]; check('one undo reverts the whole drag', undone[0] === before[0] && undone[1] === before[1], `${undone}`); await key('z', 4 | 8); const redone = [await prop('x'), await prop('y')]; check('redo re-applies it', redone[0] === after[0] && redone[1] === after[1]);
  await key('ArrowRight'); await key('ArrowRight'); await key('ArrowDown', 8); await sleep(500); check('arrow keys nudge (1 px; Shift = 10 px)', (await prop('x')) === after[0] + 2 && (await prop('y')) === after[1] + 10, `${await prop('x')},${await prop('y')}`);
  // rotation: numeric then handle drag
  await ev(`(()=>{const i=document.querySelector('#er [data-p="rotation"]');i.value=15;i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(300); check('numeric rotation', (await prop('rotation')) === 15);
  const rh = await ev(`(()=>{const h=document.querySelector('#eo [data-h="rotate"]'),r=h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); await mouse('mousePressed', rh.x, rh.y); for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', rh.x + i * 14, rh.y + i * 6); await sleep(15); } await mouse('mouseReleased', rh.x + 84, rh.y + 36); await sleep(300); const ang = await prop('rotation'); check('dragging the rotation handle changes the angle', ang !== 15, `rotation=${ang}`);
  await shot('02-rotated-selected');
  // layers: lock, hide, order
  const row = n => `[...document.querySelectorAll('#lrows .lr')].find(r=>r.querySelector('.ln').textContent==='${n}')`;
  const xBefore = await prop('x'); await ev(`${row('Article image')}.querySelector('[data-a="lock"]').click()`); await sleep(150); await drag([500, 500], [600, 600]); await sleep(100); await ev(`${row('Article image')}.click()`); await sleep(150); const xl = await prop('x'); check('a locked layer cannot be dragged', xl === xBefore, `x ${xBefore} -> ${xl}`);
  await ev(`${row('Article image')}.querySelector('[data-a="lock"]').click()`); await sleep(100); await ev(`${row('Article image')}.click()`); await sleep(100);
  const order0 = await rows(); await ev(`${row('Article image')}.querySelector('[data-a="front"]').click()`); await sleep(200); const order1 = await rows(); check('bring to front puts the layer first in the list', order1[0] === 'Article image' && order0[0] !== 'Article image', order1.slice(0, 3).join(' | '));
  await key('z', 4); await sleep(200); check('layer order change is undoable', (await rows())[0] === order0[0]);
  await ev(`${row('Article image')}.querySelector('[data-a="vis"]').click()`); await sleep(500); const hiddenPix = await ev(`document.querySelector('#lrows .lr.off .ln')?.textContent`); check('hiding a layer greys it in the list', hiddenPix === 'Article image'); await ev(`${row('Article image')}.querySelector('[data-a="vis"]').click()`); await sleep(300);
  // image controls
  await ev(`document.querySelector('#er [data-ip="original"]').click()`); await sleep(300); check('"Original size" sets the frame to the image\'s own proportions (16:9) with the lock on', Math.abs((await prop('w')) / (await prop('h')) - 1600 / 900) < 0.02, `${await prop('w')}x${await prop('h')}`);
  // custom upload: pick a file, accept the permission prompts, expect it to become the story's lead image
  { const { createCanvas } = await import(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules/@napi-rs/canvas/index.js')); const c = createCanvas(900, 700), x = c.getContext('2d'); x.fillStyle = '#8e44ad'; x.fillRect(0, 0, 900, 700); x.fillStyle = '#f1c40f'; x.fillRect(300, 200, 300, 300); const up = path.join(SP, 'custom-upload.png'); writeFileSync(up, c.toBuffer('image/png'));
    const before = (await (await fetch('http://127.0.0.1:3599/api/design/1?lang=ne')).json()).lead_asset_id; const doc = await send('DOM.getDocument'); const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#upf' });
    check('the layers panel has an Upload image button and a file picker', await ev(`!!document.querySelector('[data-upload]') && !!document.querySelector('#upf')`));
    await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [up] }); await sleep(2500); const after = (await (await fetch('http://127.0.0.1:3599/api/design/1?lang=ne')).json()); const a = after.assets.find(x => x.id === after.lead_asset_id);
    check('uploading a custom image stores it and (when confirmed) makes it the lead image, original size kept', after.lead_asset_id !== before && a && a.width === 900 && a.height === 700 && /permission/.test(a.rights_note || ''), `lead ${before} -> ${after.lead_asset_id}, ${a?.width}x${a?.height}`);
    await ev(`[...document.querySelectorAll('#lrows .lr')].find(r=>r.querySelector('.ln').textContent==='Article image').click()`); await sleep(300); await shot('05-custom-upload'); }
  // save
  await ev(`document.querySelector('#save').click()`); for (let i = 0; i < 40; i++) { if ((await ev(`document.querySelector('#ss').textContent`)).includes('Saved')) break; await sleep(250); }
  const saved = await (await fetch('http://127.0.0.1:3599/api/design/1?lang=ne')).json(); const g = saved.graphics.find(x => x.status === 'current'); check('Save writes an editable graphic and the status returns to Saved', !!g && g.spec?.version === 2 && (await ev(`document.querySelector('#ss').textContent`)).includes('Saved'), g ? `graphic #${g.id} ${g.width}x${g.height}` : 'none');
  await shot('03-saved'); await ev(`document.querySelector('#undo').click()`); await sleep(200); check('editing after a save shows the unsaved indicator', (await ev(`document.querySelector('#ss').textContent`)).includes('Unsaved'));
  // reopen
  await send('Page.navigate', { url: 'http://127.0.0.1:3599/admin/#/editor/1?lang=ne' }); await send('Page.reload'); for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('#eb')?.src?.startsWith('data:image/png')`).catch(() => false)) break; await sleep(250); } await sleep(400);
  await ev(`[...document.querySelectorAll('#lrows .lr')].find(r=>r.querySelector('.ln').textContent==='Article image').click()`); await sleep(200); check('reopening restores the saved layout', (await prop('w')) > 0 && Math.abs((await prop('w')) / (await prop('h')) - 1600 / 900) < 0.02, `w=${await prop('w')} h=${await prop('h')} x=${await prop('x')} rot=${await prop('rotation')}`);
  await shot('04-reopened'); const img = await ev(`document.querySelector('#eb').naturalWidth`); check('preview image is the server-rendered design', img > 100, `naturalWidth ${img}`);
  // pipeline page with the speed panel
  await send('Page.navigate', { url: 'http://127.0.0.1:3599/admin/#/pipeline' }); for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#speed')`).catch(() => false)) break; await sleep(250); } await sleep(300); await shot('06-pipeline');
  check('the Pipeline page shows the speed panel (backlog, stage timings, providers)', await ev(`(()=>{const t=document.querySelector('#speed')?.textContent||'';return /Backlog/.test(t)&&/Detected → live/.test(t)&&/AI writing/.test(t)})()`), (await ev(`document.querySelector('#speed')?.textContent.slice(0,120)`)) ?? 'missing');
  check('leaving with unsaved changes asked for confirmation (guard)', dialogs.some(d => /beforeunload|unsaved/i.test(d)), dialogs.join(' | '));
  check('no console errors or exceptions', logs.length === 0, logs.slice(0, 4).join(' || '));
} catch (e) { console.log('DRIVER ERROR', e.message); await shot('99-error').catch(() => {}); logs.length && console.log(logs.join('\n')); } finally { ws.close(); chrome.kill(); }
const bad = results.filter(r => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} browser checks passed`); process.exit(0);
