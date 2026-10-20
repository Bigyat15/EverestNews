// Test harness ONLY (run by tools/editor-check/run.mjs): real routes + real renderer on an isolated in-memory DB, no authentication, fixture story. Never run against production data.
import http from 'node:http'; import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const P = fileURLToPath(new URL('../../', import.meta.url)); const tmp = mkdtempSync(path.join(tmpdir(), 'edh-'));
process.env.DB_PATH = ':memory:'; process.env.DATA_DIR = tmp; process.env.TOKEN_KEY = 'c'.repeat(64);
const { db } = await import(P + 'src/db.js'); const { newsRoute } = await import(P + 'src/news_routes.js'); const { graphicRoute } = await import(P + 'src/graphic_routes.js'); const { createCanvas } = await import(P + 'node_modules/@napi-rs/canvas/index.js');
const c = createCanvas(1600, 900), x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 1600, 900); g.addColorStop(0, '#c0392b'); g.addColorStop(.5, '#27ae60'); g.addColorStop(1, '#2980b9'); x.fillStyle = g; x.fillRect(0, 0, 1600, 900); x.fillStyle = '#fff'; x.fillRect(700, 300, 200, 300); x.fillStyle = '#000'; x.font = '60px sans-serif'; x.fillText('PHOTO', 640, 200);
const buf = c.toBuffer('image/png'), pth = path.join(tmp, 'p.png'); writeFileSync(pth, buf); const ts = new Date().toISOString();
const cid = Number(db.prepare('INSERT INTO clusters(created_at,category) VALUES(?,?)').run(ts, 'politics').lastInsertRowid);
const aid = Number(db.prepare('INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('photo', cid, pth, 'p.png', 'image/png', buf.length, 1600, 900, 'x'.repeat(64), ts, 'test').lastInsertRowid);
db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=?').run(aid, cid);
const art = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?)').run('https://h.test/1', 'https://h.test/1', 't', 'k1', 'ne', 's', ts, ts, ts, cid).lastInsertRowid);
db.prepare("INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,graphic_headline,graphic_description,bundle_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(cid, art, 'ne_original', 'ne', 'approved', ts, '{}', '', 'कैलालीमा बाढीले बगाएको [[मोहना पुल]] बन्ने', '४५ मिलियनको ठेक्का सम्झौता', 'story-' + cid);
const A = { '/admin/': ['admin/index.html', 'text/html'], '/admin/app.js': ['admin/app.js', 'text/javascript'], '/admin/style.css': ['admin/style.css', 'text/css'], '/admin/editor.js': ['admin/editor.js', 'text/javascript'], '/admin/design_geom.js': ['src/design_geom.js', 'text/javascript'], '/admin/design_editor_core.js': ['src/design_editor_core.js', 'text/javascript'], '/admin/design_history.js': ['src/design_history.js', 'text/javascript'] };
const body = req => new Promise(ok => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch { ok({}); } }); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); try {
    if (A[url.pathname]) { res.writeHead(200, { 'content-type': A[url.pathname][1] + '; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:" }); return res.end(readFileSync(P + A[url.pathname][0])); }
    if (url.pathname === '/static/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
    if (url.pathname.startsWith('/api/')) { const r = (await graphicRoute(req, url, body)) ?? (await newsRoute(req, url, body)); if (!r) { res.writeHead(404); return res.end('{}'); } if (r.body?.raw || r.raw) { res.writeHead(200, { 'content-type': r.mime }); return res.end(r.raw); } res.writeHead(r.code, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r.body)); }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(3599, '127.0.0.1', () => console.log('harness on 3599 cluster', cid));
