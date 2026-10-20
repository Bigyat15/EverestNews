import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, now, log } from './db.js';
import { enqueue } from './worker.js';
import { aiRoute } from './ai_routes.js';
import { newsRoute } from './news_routes.js';
import { graphicRoute } from './graphic_routes.js';
import { pubRoute } from './pub_routes.js';
import { socialRoute } from './social_routes.js';
import { thumbnail } from './imgcache.js';
import { handleSite } from './site.js';
import { clusterNew, mergeClusters, tokens } from './cluster.js';
import { view, rankClusters, getWeights, DEFAULT_WEIGHTS, categorize } from './rank.js';

const PASS = process.env.ADMIN_PASSWORD, SECRET = process.env.SESSION_SECRET;
const sign = v => createHmac('sha256', SECRET).update(v).digest('hex');
const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = () => { const exp = String(Date.now() + 7 * 864e5); return `${exp}.${sign(exp)}`; };
const authed = req => { const m = /(?:^|;\s*)sid=([\d.a-f]+)/.exec(req.headers.cookie || ''); if (!m) return false; const [exp, sig] = m[1].split('.'); return sig && Date.now() < +exp && eq(sig, sign(exp)); };
const fails = new Map(); // ip -> {n, until}: crude login throttle

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:" }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('bad json')); } }); });

const routes = {
  'GET /api/sources': () => db.prepare('SELECT *, (SELECT COUNT(*) FROM articles a WHERE a.source_id=sources.id) AS stories, (SELECT status FROM jobs j WHERE j.source_id=sources.id AND status IN (\'queued\',\'running\')) AS job FROM sources ORDER BY id').all(),
  'GET /api/stories': (req, url) => {
    const q = `%${url.searchParams.get('q') || ''}%`, src = +url.searchParams.get('source') || null, lang = url.searchParams.get('lang') || null;
    return db.prepare(`SELECT a.id,a.title,a.url,a.language,a.summary,a.published_at,a.fetched_at,a.image_url,a.extraction_status,a.workflow_status,s.name AS source,
      (SELECT COUNT(*) FROM articles b WHERE b.title_key=a.title_key AND b.id<>a.id) AS dup_titles
      FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.title LIKE ? AND (? IS NULL OR a.source_id=?) AND (? IS NULL OR a.language=?)
      ORDER BY COALESCE(a.published_at,a.fetched_at) DESC LIMIT 200`).all(q, src, src, lang, lang);
  },
  'GET /api/top': (req, url) => { clusterNew(); const v = view(url.searchParams.get('view') || 'now'); if (!v) throw new Error('unknown view'); return v; },
  'GET /api/clusters': () => { clusterNew(); return rankClusters().filter(c => c.articles.length > 1).sort((a, b) => b.sources - a.sources || (a.latest < b.latest ? 1 : -1)); },
  'GET /api/candidates': () => db.prepare(`SELECT c.id,c.score,c.reason,a.title at,a.url au,sa.name asrc,b.title bt,b.url bu,sb.name bsrc,a.cluster_id ac,b.cluster_id bc
    FROM cluster_candidates c JOIN articles a ON a.id=c.a_id JOIN articles b ON b.id=c.b_id JOIN sources sa ON sa.id=a.source_id JOIN sources sb ON sb.id=b.source_id
    WHERE c.status='pending' ORDER BY c.score DESC`).all(),
  'GET /api/weights': () => ({ weights: getWeights(), defaults: DEFAULT_WEIGHTS }),
  'GET /api/logs': () => db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all(),
  'GET /api/stats': () => ({ stories: db.prepare('SELECT COUNT(*) n FROM articles').get().n, dupTitles: db.prepare('SELECT COUNT(*) n FROM (SELECT title_key FROM articles GROUP BY title_key HAVING COUNT(*)>1)').get().n }),
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = req.socket.remoteAddress, f = fails.get(ip);
      if (f && f.n >= 5 && Date.now() < f.until) return send(res, 429, { error: 'Too many attempts, wait a minute' });
      const { password = '' } = await readBody(req);
      if (!eq(String(password), PASS)) { fails.set(ip, { n: (f?.n || 0) + 1, until: Date.now() + 60000 }); return send(res, 401, { error: 'Wrong password' }); }
      fails.delete(ip); const https = req.headers['x-forwarded-proto'] === 'https' || /^https:/.test(process.env.PUBLIC_BASE_URL || ''); // behind TLS the session cookie must be Secure
      res.setHeader('set-cookie', `sid=${token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${https ? '; Secure' : ''}`); return send(res, 200, { ok: true });
    }
    if (url.pathname === '/healthz') { // liveness for monitors: no secrets, no content, just "is the database up and is the worker beating"
      const hb = db.prepare("SELECT value FROM settings WHERE key='worker_heartbeat'").get(), age = hb ? (Date.now() - Date.parse(JSON.parse(hb.value))) / 1000 : null, worker = age == null ? 'never' : age <= (+process.env.HEALTH_WORKER_MAX_AGE_S || 180) ? 'ok' : 'stale';
      res.writeHead(worker === 'ok' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ status: worker === 'ok' ? 'ok' : 'degraded', db: 'ok', worker }));
    }
    // editorial app lives under /admin; everything that is not /api or /img is the public website
    // the editor modules in src/ are the SAME files the server-side renderer imports (one geometry for preview and export)
    const ADMIN = { '/admin': ['admin/index.html', 'text/html'], '/admin/': ['admin/index.html', 'text/html'], '/admin/app.js': ['admin/app.js', 'text/javascript'], '/admin/style.css': ['admin/style.css', 'text/css'], '/admin/editor.js': ['admin/editor.js', 'text/javascript'],
      '/admin/design_geom.js': ['src/design_geom.js', 'text/javascript'], '/admin/design_editor_core.js': ['src/design_editor_core.js', 'text/javascript'], '/admin/design_history.js': ['src/design_history.js', 'text/javascript'] };
    if (ADMIN[url.pathname]) { res.setHeader('cache-control', 'no-cache'); res.setHeader('x-robots-tag', 'noindex'); return send(res, 200, readFileSync(ADMIN[url.pathname][0]), ADMIN[url.pathname][1]); }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/img/')) {
      const r = await handleSite(req.method, url, req.headers, req.socket.remoteAddress); res.writeHead(r.status, r.headers); return res.end(r.body);
    }
    if (!authed(req)) return send(res, 401, { error: 'login required' });
    if (req.method === 'POST' && url.pathname === '/api/logout') { res.setHeader('set-cookie', 'sid=; Max-Age=0; Path=/'); return send(res, 200, { ok: true }); }
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sources\/(\d+)\/fetch$/))) {
      enqueue(+m[1]); db.prepare("UPDATE jobs SET run_at=? WHERE source_id=? AND status='queued'").run(now(), +m[1]);
      log('manual_fetch', `source ${m[1]}`); return send(res, 200, { queued: true });
    }
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/api\/sources\/(\d+)$/))) {
      const b = await readBody(req), interval = Math.round(+b.interval_min);
      if ('interval_min' in b && !(interval >= 5 && interval <= 1440)) return send(res, 400, { error: 'interval must be 5-1440 minutes' });
      if ('interval_min' in b) db.prepare('UPDATE sources SET interval_min=? WHERE id=?').run(interval, +m[1]);
      if ('feed_url' in b) {
        let u; try { u = new URL(String(b.feed_url).trim()); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return send(res, 400, { error: 'feed_url must be a valid http(s) URL' }); }
        db.prepare("UPDATE sources SET feed_url=?,status='unchecked',fail_count=0,last_error=NULL,last_http=NULL,final_url=NULL WHERE id=?").run(u.href, +m[1]);
        enqueue(+m[1]); db.prepare("UPDATE jobs SET run_at=? WHERE source_id=? AND status='queued'").run(now(), +m[1]);
      }
      if ('fulltext_enabled' in b) db.prepare('UPDATE sources SET fulltext_enabled=? WHERE id=?').run(b.fulltext_enabled ? 1 : 0, +m[1]);
      if ('auto_images' in b) { const note = String(b.auto_images_note ?? '').trim().slice(0, 300); if (b.auto_images && note.length < 8) return send(res, 400, { error: 'State the basis on which you use this publisher’s images (permission, licence or editorial decision), at least a short sentence; it is stored with every image.' }); db.prepare('UPDATE sources SET auto_images=?, auto_images_note=? WHERE id=?').run(b.auto_images ? 1 : 0, b.auto_images ? note : null, +m[1]); }
      if ('enabled' in b) db.prepare('UPDATE sources SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, +m[1]);
      log('source_edit', `source ${m[1]} ${JSON.stringify(b)}`); return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/clusters\/(\d+)$/))) {
      const arts = db.prepare('SELECT a.id,a.title,a.url,a.summary,a.published_at,a.fetched_at,a.language,a.extraction_status,s.name source FROM articles a JOIN sources s ON s.id=a.source_id WHERE cluster_id=? ORDER BY COALESCE(published_at,fetched_at)').all(+m[1]);
      if (!arts.length) return send(res, 404, { error: 'not found' });
      const tk = arts.map(a => tokens(a.title));
      // words appearing in only this report's headline = where the reporting differs
      return send(res, 200, arts.map((a, i) => ({ ...a, onlyHere: [...tk[i]].filter(w => tk.every((o, j) => j === i || !o.has(w))) })));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/clusters\/(\d+)\/action$/))) {
      const id = +m[1], b = await readBody(req), set = (col, v) => db.prepare(`UPDATE clusters SET ${col}=? WHERE id=?`).run(v, id);
      if ('pinned' in b) set('pinned', b.pinned ? 1 : 0);
      if ('rejected' in b) set('rejected', b.rejected ? 1 : 0);
      if ('priority' in b) { const p = Math.round(+b.priority); if (!(p >= 0 && p <= 3)) return send(res, 400, { error: 'priority 0-3' }); set('priority', p); }
      if ('category' in b) { if (b.category && !/^[a-z]{3,12}$/.test(b.category)) return send(res, 400, { error: 'bad category' }); set('category', b.category || null); }
      log('cluster_action', `cluster ${id} ${JSON.stringify(b)}`); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/candidates\/(\d+)$/))) {
      const { decision } = await readBody(req), c = db.prepare("SELECT * FROM cluster_candidates WHERE id=? AND status='pending'").get(+m[1]);
      if (!c || !['merge', 'separate'].includes(decision)) return send(res, 400, { error: 'invalid' });
      if (decision === 'merge') { const a = db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(c.a_id).cluster_id, bb = db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(c.b_id).cluster_id; if (a !== bb) mergeClusters(bb, a); } // transactional itself; may refuse (409)
      db.prepare('UPDATE cluster_candidates SET status=? WHERE id=?').run(decision === 'merge' ? 'merged' : 'separate', c.id);
      log('candidate', `${c.id} ${decision}`); return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && url.pathname === '/api/weights') {
      const b = await readBody(req), w = {};
      for (const k of Object.keys(DEFAULT_WEIGHTS)) { const v = +b[k]; if (!(v >= 0 && v <= 100)) return send(res, 400, { error: `${k} must be 0-100` }); w[k] = v; }
      db.prepare("INSERT INTO settings(key,value) VALUES('rank_weights',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(w)); log('weights', JSON.stringify(w)); return send(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/api\/sources\/(\d+)\/credibility$/))) {
      const v = +(await readBody(req)).credibility; if (!(v >= 0 && v <= 1)) return send(res, 400, { error: 'credibility 0-1' });
      db.prepare('UPDATE sources SET credibility=? WHERE id=?').run(v, +m[1]); return send(res, 200, { ok: true });
    }
    let im;
    if (req.method === 'GET' && (im = url.pathname.match(/^\/img\/(\d+)$/))) {
      try {
        const t = await thumbnail(+im[1], url.searchParams.get('w')), etag = `"${t.key}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/webp', etag, 'cache-control': 'private, max-age=604800, immutable', 'x-content-type-options': 'nosniff', 'x-cache': t.hit ? 'HIT' : 'MISS' }); return res.end(t.buf);
      } catch (e) { res.writeHead(e.status || 502, { 'cache-control': 'private, max-age=60' }); return res.end(); }
    }
    const ai = await aiRoute(req, url, readBody) || await newsRoute(req, url, readBody) || await graphicRoute(req, url, readBody) || await pubRoute(req, url, readBody) || await socialRoute(req, url, readBody);
    if (ai?.raw) { res.writeHead(ai.code, { 'content-type': ai.mime, 'content-disposition': ai.name ? `attachment; filename="${ai.name}"` : 'inline', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=60' }); return res.end(ai.raw); }
    if (ai) return send(res, ai.code, ai.body);
    const h = routes[`${req.method} ${url.pathname}`];
    return h ? send(res, 200, h(req, url)) : send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}).listen(+process.env.PORT || 3000, '127.0.0.1', () => console.log(`Everest News on http://127.0.0.1:${process.env.PORT || 3000} (admin password is in .env)`));
