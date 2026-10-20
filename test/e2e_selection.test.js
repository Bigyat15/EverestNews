// A REAL worker process, an isolated database, windows shortened to 3 seconds so the real scheduler can be observed in a test.
// (In production the window is 60 minutes aligned to :00 Nepal time; the code path is identical.) Fixture stories only; no feeds, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'e2esel-')), DB = path.join(dir, 's.db');
const ENV = { ...process.env, DATA_DIR: dir, DB_PATH: DB, TOKEN_KEY: 'e'.repeat(64), SELECT_WINDOW_MIN: '0.05', SELECT_GRACE_MIN: '0', SELECT_TZ_OFFSET_MIN: '0', SELECT_CHECK_MS: '200', SELECT_MIN_SCORE: '0', SELECT_LATENESS_H: '24', WORKER_IDLE_MS: '100', HEARTBEAT_MS: '300' };
let worker, sql; const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 25000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting for the worker'); await sleep(100); } };
const start = () => { worker = spawn(process.execPath, ['src/worker.js'], { env: ENV, stdio: 'ignore' }); };
before(() => { spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], { env: ENV }); sql = new DatabaseSync(DB); sql.exec('PRAGMA busy_timeout=5000; UPDATE sources SET enabled=0'); start(); });
after(() => { worker?.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });
let n = 0;
function story(title) { n++; const t = new Date().toISOString(), cid = Number(sql.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(t).lastInsertRowid);
  for (const sid of [1, 2]) sql.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sid, `https://s${sid}.test/${n}`, `https://s${sid}.test/${n}`, title, 'k' + n + sid, 'ne', title + ' विस्तृत विवरण नेपालको काठमाडौंमा आज सरकारले जानकारी दियो।', t, t, t, cid); return cid; }
const rows = () => sql.prepare('SELECT * FROM selections ORDER BY slot_start').all();

test('a real worker process selects the story of each closed window, exactly once, across a hard kill and restart', async () => {
  const a = story('सरकारले पहिलो निर्णय गर्‍यो अल्फा'); const first = await waitFor(() => rows().find(r => r.cluster_id === a));
  assert.equal(first.status, 'selected'); assert.ok(Date.parse(first.slot_end) - Date.parse(first.slot_start) === 3000, 'the window length is the configured one'); assert.ok(first.slot_end <= new Date().toISOString(), 'it was decided only after the window had closed');
  const b = story('सरकारले दोस्रो निर्णय गर्‍यो बिटा'); const second = await waitFor(() => rows().find(r => r.cluster_id === b)); assert.notEqual(second.slot_start, first.slot_start, 'a different window, a different story');
  // hard kill; the worker is down for several windows
  worker.kill('SIGKILL'); const snapshot = JSON.stringify(rows().filter(r => r.status === 'selected').map(r => [r.slot_start, r.cluster_id])); await sleep(9000);
  const c = story('सरकारले तेस्रो निर्णय गर्‍यो गामा'); start();
  const third = await waitFor(() => rows().find(r => r.cluster_id === c)); assert.equal(third.status, 'selected');
  const after = rows(); assert.ok(after.filter(r => r.status === 'missed').length >= 1, 'windows that passed while the worker was down are recorded as missed'); assert.ok(after.filter(r => r.status === 'missed').every(r => r.cluster_id === null), 'a missed window is never back-filled with a stale story');
  assert.equal(JSON.stringify(after.filter(r => r.status === 'selected' && [a, b].includes(r.cluster_id)).map(r => [r.slot_start, r.cluster_id])), snapshot, 'earlier decisions are unchanged by the restart');
  const perCluster = sql.prepare("SELECT cluster_id, COUNT(*) n FROM selections WHERE status='selected' GROUP BY cluster_id").all(); assert.ok(perCluster.every(r => r.n === 1), 'no story was selected twice'); assert.equal(new Set(after.map(r => r.slot_start)).size, after.length, 'no window was decided twice');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications').get().n + sql.prepare('SELECT COUNT(*) n FROM posts').get().n + sql.prepare('SELECT COUNT(*) n FROM drafts').get().n, 0, 'selection alone publishes, posts and drafts nothing (approval gate untouched, auto-draft off)');
});
