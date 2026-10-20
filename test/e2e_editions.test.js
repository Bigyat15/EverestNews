// A REAL worker process, an isolated database and a MOCK model served over HTTP: both editions are generated and published without any hourly pick,
// and the queue survives a hard kill in the middle of generation. Fixture stories only; no feeds, no network, no social account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as F from './fixtures/content.js';

const dir = mkdtempSync(path.join(tmpdir(), 'e2eed-')), DB = path.join(dir, 'e.db'); let worker, sql, srv, slow = true, hits = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 25000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting for the worker'); await sleep(100); } };
before(async () => {
  srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', async () => { hits++; const body = JSON.parse(b), ne = /Target edition language: Nepali/.test(body.messages.at(-1).content); if (slow) await sleep(4000);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ source_assessment: { sufficient: true, gaps: [] }, facts: F.FACTS, quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], edition: { ...(ne ? F.NE_ED : F.EN_ED), headline: /Second story/.test(body.messages.at(-1).content) ? (ne ? 'संसद्ले नयाँ सडक सुरक्षा नियम पारित गर्‍यो' : 'Parliament approves new road safety rules') : (ne ? F.NE_ED : F.EN_ED).headline } }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const ENV = { ...process.env, DATA_DIR: dir, DB_PATH: DB, TOKEN_KEY: 'e'.repeat(64), OPENROUTER_API_KEY: 'k', WORKER_IDLE_MS: '150', WORKER_SHUTDOWN_MS: '1500', SELECT_CHECK_MS: '3600000' }; globalThis.ENV = ENV;
  spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], { env: ENV }); sql = new DatabaseSync(DB); sql.exec('PRAGMA busy_timeout=5000; UPDATE sources SET enabled=0');
  sql.prepare("INSERT INTO settings(key,value) VALUES('ai',?)").run(JSON.stringify({ base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test/model', max_tokens: 6000 }));
  sql.prepare('UPDATE sources SET ai_policy=? WHERE id=1').run(JSON.stringify({ aiInput: null, checkedAt: new Date().toISOString() })); // robots policy cached: no network from the worker
});
const start = () => { worker = spawn(process.execPath, ['src/worker.js'], { env: globalThis.ENV, stdio: 'ignore' }); };
after(() => { worker?.kill(); srv?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test('real worker: a new story is published in BOTH editions with no hourly pick, and survives a hard kill mid-generation', async () => {
  const t = new Date().toISOString(); sql.prepare("INSERT INTO settings(key,value) VALUES('auto_publish','true'),('auto_publish_from',?)").run(JSON.stringify(new Date(Date.now() - 1000).toISOString()));
  const cid = Number(sql.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(t).lastInsertRowid);
  sql.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,full_text,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('https://x.test/1', 'https://x.test/1', F.EN_TITLE, 'k1', 'en', F.EN_SUMMARY, F.EN_TEXT, t, t, t, cid);
  start();
  await waitFor(() => sql.prepare("SELECT 1 FROM edition_jobs WHERE cluster_id=? AND status='generating'").get(cid)); // the queue row exists and the worker is inside a model request
  worker.kill('SIGKILL'); await sleep(300); assert.equal(sql.prepare("SELECT COUNT(*) n FROM publications").get().n, 0, 'nothing was published by the interrupted run');
  assert.ok(sql.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=?").get(cid).n === 2, 'the queue persisted across the kill');
  slow = false; start();
  await waitFor(() => sql.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=? AND status='published'").get(cid).n === 2);
  const pubs = sql.prepare("SELECT lang,status,published_at FROM publications WHERE cluster_id=? ORDER BY lang").all(cid); assert.deepEqual(pubs.map(p => p.lang), ['en', 'ne']); assert.ok(pubs.every(p => p.status === 'published' && p.published_at));
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM selections WHERE status='selected'").get().n, 0, 'website publication happened without any hourly selection'); assert.equal(sql.prepare('SELECT COUNT(*) n FROM posts').get().n, 0, 'and without any social post');
  await sleep(1500); assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(cid).n, 2, 'still exactly one article per edition');
});

test('graceful shutdown: SIGTERM in the middle of generation hands the edition back to the queue (no attempt burned), and a restart finishes it', async () => {
  slow = true; const t = new Date().toISOString(), cid = Number(sql.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(t).lastInsertRowid);
  sql.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,full_text,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('https://x.test/2', 'https://x.test/2', 'Second story ' + F.EN_TITLE, 'k2', 'en', F.EN_SUMMARY, F.EN_TEXT, t, t, t, cid);
  sql.prepare("INSERT INTO settings(key,value) VALUES('auto_publish_from',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(new Date(Date.now() - 1000).toISOString()));
  await waitFor(() => sql.prepare("SELECT 1 FROM edition_jobs WHERE cluster_id=? AND status='generating'").get(cid));
  const exited = new Promise(r => worker.once('exit', (code, sig) => r({ code, sig }))); worker.kill('SIGTERM'); const ex = await Promise.race([exited, sleep(12000).then(() => 'still running')]);
  assert.notEqual(ex, 'still running', 'the worker stops by itself after SIGTERM'); assert.equal(ex.code, 0, 'a clean exit');
  const rows = sql.prepare('SELECT status, attempts FROM edition_jobs WHERE cluster_id=?').all(cid); assert.equal(rows.length, 2); assert.ok(rows.every(r => r.status === 'queued' && r.attempts === 0), JSON.stringify(rows));
  slow = false; start(); await waitFor(() => sql.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=? AND status='published'").get(cid).n === 2); assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(cid).n, 2, 'both editions live after the restart, once each');
});
