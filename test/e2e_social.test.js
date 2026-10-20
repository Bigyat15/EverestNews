// Real server + real worker processes (isolated data dir), MOCK social adapter. Nothing is posted anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';

const dir = mkdtempSync(path.join(tmpdir(), 'e2es-')), PORT = 4900 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`, PASS = 'e2e-social-pass';
const ENV = { ...process.env, DATA_DIR: dir, DB_PATH: path.join(dir, 's.db'), PORT: String(PORT), ADMIN_PASSWORD: PASS, SOCIAL_MOCK: '1', SOCIAL_BACKOFF_BASE_MS: '80', WORKER_IDLE_MS: '120', HEARTBEAT_MS: '300', HEALTH_WORKER_MAX_AGE_S: '3', TOKEN_KEY: 'b'.repeat(64) };
let server, worker, cookie = '', sql; const sleep = ms => new Promise(r => setTimeout(r, ms)); const now = new Date().toISOString();
const api = async (p, o = {}) => { const r = await fetch(B + '/api/' + p, { ...o, headers: { 'content-type': 'application/json', cookie }, body: o.body && JSON.stringify(o.body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const waitFor = async (fn, ms = 12000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await sleep(100); } };
const startWorker = () => { worker = spawn(process.execPath, ['src/worker.js'], { env: ENV, stdio: 'ignore' }); };

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('server did not start')), 15000); server.stdout.on('data', d => String(d).includes('on http') && (clearTimeout(t), ok())); });
  sql = new DatabaseSync(ENV.DB_PATH); sql.exec('PRAGMA busy_timeout=5000; UPDATE sources SET enabled=0'); // the test worker must not touch the real internet
  cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) })).headers.get('set-cookie').split(';')[0];
  startWorker();
});
after(() => { server?.kill(); worker?.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

let n = 0;
async function approvedStoryWithGraphic() {
  n++; const cid = Number(sql.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(now).lastInsertRowid);
  const aid = Number(sql.prepare("INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id,image_checked_at) VALUES(1,?,?,?,?,'en','s',?,?,?,?,?)").run('https://x.test/' + n, 'https://x.test/' + n, 't', 'k' + n, now, now, now, cid, now).lastInsertRowid);
  const headline = 'सामाजिक सञ्जाल परीक्षण शीर्षक ' + n;
  const did = Number(sql.prepare(`INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,headline_options,rec_idx,flags,final_headline,final_body,final_caption,approved_at) VALUES(?,?, 'x','ne','approved',?,'{}','S: https://x.test','[]',0,'[]',?,?,?,?)`).run(cid, aid, now, headline, 'शरीर पाठ', 'पोस्टको क्याप्सन', now).lastInsertRowid);
  const c = createCanvas(900, 700); c.getContext('2d').fillRect(0, 0, 900, 700);
  const up = await fetch(`${B}/api/assets?kind=photo&cluster_id=${cid}&name=p.png&rights=mine`, { method: 'POST', headers: { cookie }, body: c.toBuffer('image/png') }); const photo = (await up.json()).id;
  const g = await api('graphics', { method: 'POST', body: { cluster_id: cid, draft_id: did, spec: { headline, format: 'square' }, photoAssetId: photo, outFormat: 'jpeg' } }); assert.equal(g.status, 200, JSON.stringify(g.json));
  return { cid, did, gid: g.json.id, headline };
}

test('platforms: real ones are listed as not configured and cannot be connected; tokens never leave the server', async () => {
  const pl = (await api('social/platforms')).json; assert.ok(pl.find(p => p.id === 'mock')); for (const id of ['facebook', 'instagram', 'x']) { const p = pl.find(x => x.id === id); assert.equal(p.configured, false); assert.equal(p.realAdapterImplemented, false); assert.ok(p.missingEnv.length); }
  const c = await api('social/connect/facebook', { method: 'POST', body: {} }); assert.equal(c.status, 409); assert.deepEqual(c.json.missingEnv, ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET']);
  assert.equal((await api('social/accounts')).json.accounts.length, 0, 'no account was created by the failed connect');
  const m = await api('social/accounts/mock', { method: 'POST', body: { display_name: 'E2E Page' } }); assert.equal(m.status, 200);
  const acc = await api('social/accounts'); assert.equal(acc.json.accounts[0].isTest, true); assert.ok(!JSON.stringify(acc.json).toLowerCase().includes('token_enc')); assert.ok(!JSON.stringify(acc.json).includes('mock-token'));
  for (const p of ['social/accounts', 'posts', 'social/platforms']) assert.equal((await fetch(`${B}/api/${p}`)).status, 401);
});

test('full path with real server + worker: validate → create → approve → schedule → published; duplicates refused', async () => {
  const f = await approvedStoryWithGraphic(), acct = (await api('social/accounts')).json.accounts[0].id;
  const v = await api('posts/validate', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'क्याप्सन' }] } }); assert.equal(v.json.gate.ok, true);
  const bad = await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: '' }] } }); assert.equal(bad.status, 422);
  const c = await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'पोस्टको क्याप्सन' }] } }); assert.equal(c.status, 200); const id = c.json.id;
  assert.equal((await api(`posts/${id}/schedule`, { method: 'POST', body: {} })).status, 409, 'cannot schedule before approval');
  assert.equal((await api(`posts/${id}/approve`, { method: 'POST', body: {} })).status, 200); await sleep(400); assert.equal((await api(`posts/${id}`)).json.targets[0].status, 'pending', 'approved posts are not sent');
  assert.equal((await api(`posts/${id}/schedule`, { method: 'POST', body: {} })).status, 200);
  const done = await waitFor(async () => { const p = (await api(`posts/${id}`)).json; return p.state === 'published' && p; }); assert.match(done.targets[0].platform_url, /^https:\/\/mock\.invalid\//); assert.ok(done.targets[0].published_at); assert.equal(done.targets[0].isTest, true);
  const dup = await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'x' }] } }); assert.equal(dup.status, 409); assert.match(dup.json.error, /already posted/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM mock_remote').get().n, 1);
});

test('scheduled delivery waits for its time (real worker); retries with backoff then succeeds once', async () => {
  const f = await approvedStoryWithGraphic(), acct = (await api('social/accounts')).json.accounts[0].id;
  const id = (await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'later [mock:recoverable]' }] } })).json.id;
  await api(`posts/${id}/approve`, { method: 'POST', body: {} }); const when = new Date(Date.now() + 1500).toISOString(); await api(`posts/${id}/schedule`, { method: 'POST', body: { scheduled_at: when } });
  await sleep(600); assert.equal((await api(`posts/${id}`)).json.targets[0].status, 'queued', 'not sent before its time'); const done = await waitFor(async () => { const p = (await api(`posts/${id}`)).json; return p.state === 'published' && p; });
  assert.equal(done.targets[0].attempts, 3); assert.ok(Date.parse(done.targets[0].published_at) >= Date.parse(when) - 50); assert.equal(sql.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=(SELECT idempotency_key FROM post_targets WHERE post_id=?)').get(id).n, 1);
});

test('worker killed mid-delivery: restart resolves it without a duplicate post', async () => {
  const f = await approvedStoryWithGraphic(), acct = (await api('social/accounts')).json.accounts[0].id;
  const id = (await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'crash' }] } })).json.id; await api(`posts/${id}/approve`, { method: 'POST', body: {} });
  worker.kill('SIGKILL'); await sleep(300); await api(`posts/${id}/schedule`, { method: 'POST', body: {} });
  // simulate: the platform accepted the post, then the worker died before recording it
  const t = sql.prepare('SELECT * FROM post_targets WHERE post_id=?').get(id); sql.prepare("UPDATE post_targets SET status='publishing',attempts=1,updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(t.id); sql.prepare("UPDATE posts SET state='publishing' WHERE id=?").run(id);
  sql.prepare('INSERT INTO mock_remote(key,account_id,caption,url,at) VALUES(?,?,?,?,?)').run(t.idempotency_key, acct, 'crash', 'https://mock.invalid/accepted-before-crash', now);
  const before = sql.prepare('SELECT COUNT(*) n FROM mock_remote').get().n; startWorker();
  const done = await waitFor(async () => { const p = (await api(`posts/${id}`)).json; return p.state === 'published' && p; }); assert.equal(done.targets[0].platform_url, 'https://mock.invalid/accepted-before-crash'); assert.equal(sql.prepare('SELECT COUNT(*) n FROM mock_remote').get().n, before, 'no second post was made');
});

test('outdated graphic is blocked by the API and by the worker', async () => {
  const f = await approvedStoryWithGraphic(), acct = (await api('social/accounts')).json.accounts[0].id;
  const id = (await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'stale test' }] } })).json.id; await api(`posts/${id}/approve`, { method: 'POST', body: {} });
  await api(`posts/${id}/schedule`, { method: 'POST', body: { scheduled_at: new Date(Date.now() + 1200).toISOString() } });
  sql.prepare("UPDATE drafts SET final_headline='पूर्ण नयाँ अनुमोदित शीर्षक' WHERE id=?").run(f.did); // the editor changes the approved headline after scheduling
  const p = await waitFor(async () => { const x = (await api(`posts/${id}`)).json; return x.state === 'failed' && x; }); assert.match(p.targets[0].error, /outdated/); assert.equal(sql.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=(SELECT idempotency_key FROM post_targets WHERE post_id=?)').get(id).n, 0);
  assert.equal((await api('posts', { method: 'POST', body: { draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: acct, caption: 'x' }] } })).status, 409, 'API also refuses new posts with the outdated graphic');
});

test('four competing worker processes deliver 20 due targets exactly once each (claims are exclusive across processes)', async () => {
  const f = await approvedStoryWithGraphic(); await api('social/limits', { method: 'PUT', body: { max_accounts: 100 } });
  worker.kill('SIGKILL'); await sleep(200);
  const accts = []; for (let i = 0; i < 20; i++) accts.push((await api('social/accounts/mock', { method: 'POST', body: { display_name: 'race-' + i } })).json.id);
  const pid = Number(sql.prepare("INSERT INTO posts(cluster_id,draft_id,graphic_id,state,approved_at,scheduled_at,created_at,updated_at) VALUES(?,?,?,'scheduled',?,?,?,?)").run(f.cid, f.did, f.gid, now, now, now, now).lastInsertRowid);
  for (const a of accts) sql.prepare("INSERT INTO post_targets(post_id,account_id,caption,status,next_run_at,idempotency_key,updated_at) VALUES(?,?,?,'queued',?,?,?)").run(pid, a, 'race', new Date(Date.now() - 1000).toISOString(), 'race-key-' + pid + '-' + a, now);
  const before = sql.prepare('SELECT COUNT(*) n FROM mock_remote').get().n, extra = [0, 1, 2, 3].map(() => spawn(process.execPath, ['src/worker.js'], { env: { ...ENV, WORKER_IDLE_MS: '30' }, stdio: 'ignore' }));
  try {
    await waitFor(async () => sql.prepare("SELECT COUNT(*) n FROM post_targets WHERE post_id=? AND status='published'").get(pid).n === 20, 30000);
    const rows = sql.prepare('SELECT attempts,error,error_kind FROM post_targets WHERE post_id=?').all(pid); assert.ok(rows.every(r => r.attempts === 1), 'every target was attempted exactly once: ' + JSON.stringify(rows.filter(r => r.attempts !== 1)) + ' | log: ' + JSON.stringify(sql.prepare("SELECT detail FROM audit WHERE kind='target_error' ORDER BY id DESC LIMIT 3").all()));
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM mock_remote').get().n - before, 20);
  } finally { extra.forEach(w => w.kill('SIGKILL')); startWorker(); }
});

test('/healthz reports a live worker as ok and a dead one as degraded (503); it leaks nothing', async () => {
  const hz = async () => { const r = await fetch(B + '/healthz'); return { status: r.status, j: await r.json() }; };
  const live = await waitFor(async () => { const h = await hz(); return h.status === 200 && h; }); assert.deepEqual(live.j, { status: 'ok', db: 'ok', worker: 'ok' });
  worker.kill('SIGKILL'); const dead = await waitFor(async () => { const h = await hz(); return h.status === 503 && h; }, 15000); assert.deepEqual(dead.j, { status: 'degraded', db: 'ok', worker: 'stale' });
  startWorker(); await waitFor(async () => (await hz()).status === 200, 15000);
  assert.ok(!JSON.stringify(live.j).match(/key|token|password|secret/i));
});
