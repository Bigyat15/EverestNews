// Separate long-running process: persistent queue in SQLite survives restarts.
import { db, now, log } from './db.js';
import { fetchSource } from './feeds.js';
import { clusterNew } from './cluster.js';
import { runAiJob } from './editorial.js';
import { enrichBatch } from './images.js';
import { warmBatch } from './imgcache.js';
import { runPublishJob, recoverPublishing } from './social.js';
import { cleanup } from './cleanup.js';
import { backfillImages } from './graphic_routes.js';
import { runEditionPool, queueNewStories, inFlight } from './editions.js';
import { wake, sleepOrWake } from './wake.js';
import { prepareAll } from './social_drafts.js';
import { runSelection, ensureDraftRequested } from './selection.js';

const BASE_BACKOFF_MIN = 5, MAX_BACKOFF_MIN = 360;

export function enqueue(sourceId, runAt = now()) {
  return db.prepare("INSERT OR IGNORE INTO jobs(source_id,run_at) VALUES(?,?)").run(sourceId, runAt).changes;
}
function tick() {
  // schedule enabled sources that have no pending job (first run, or after restart)
  for (const s of db.prepare("SELECT id FROM sources WHERE enabled=1 AND id NOT IN (SELECT source_id FROM jobs WHERE status IN ('queued','running'))").all()) {
    const last = db.prepare('SELECT interval_min,last_checked_at,fail_count FROM sources WHERE id=?').get(s.id);
    enqueue(s.id, last.last_checked_at ? new Date(Date.parse(last.last_checked_at) + nextDelayMin(last) * 60000).toISOString() : now());
  }
}
const nextDelayMin = s => s.fail_count ? Math.min(BASE_BACKOFF_MIN * 2 ** (s.fail_count - 1), MAX_BACKOFF_MIN) : s.interval_min;

// Feed polling: one due source at a time, and the moment new stories exist both of their editions are queued and the edition workers are woken.
export async function runFetchJob() {
  const job = db.prepare("SELECT j.* FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='queued' AND j.run_at<=? ORDER BY j.run_at LIMIT 1").get(now());
  if (!job) return false;
  db.prepare("UPDATE jobs SET status='running',started_at=?,attempts=attempts+1 WHERE id=?").run(now(), job.id);
  try {
    const r = await fetchSource(job.source_id);
    clusterNew(); queueNewStories(); wake(); // a new story starts processing now: it does not wait for the next poll, the hourly pick or any other story
    db.prepare("UPDATE jobs SET status='done',finished_at=?,result=? WHERE id=?").run(now(), JSON.stringify(r), job.id);
  } catch (e) {
    db.prepare("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?").run(now(), e.message, job.id);
  }
  return true;
}
export const housekeeping = async () => (await backfillImages()) || (await runAiJob()) || (await enrichBatch()) || (await warmBatch());
export const editionConcurrency = () => Math.max(1, Math.min(8, Math.round(+process.env.WORKER_EDITION_CONCURRENCY || +JSON.parse(db.prepare("SELECT value FROM settings WHERE key='edition_concurrency'").get()?.value ?? 'null') || 3)));

if (import.meta.url === `file://${process.argv[1]}`) {
  // a job left 'running' means the process died mid-fetch: requeue it
  db.exec("UPDATE jobs SET status='queued' WHERE status='running'; UPDATE ai_jobs SET status='queued' WHERE status='running'; UPDATE edition_jobs SET status='queued' WHERE status='generating'"); // one worker process: anything 'generating' belongs to the process that just died
  log('worker', 'started'); recoverPublishing().then(n => n && log('worker', `resolved ${n} interrupted deliveries`)).catch(e => log('worker_error', e.message));
  const idle = +process.env.WORKER_IDLE_MS || 2000; let stopping = false; const stop = () => stopping;
  const beat = () => db.prepare("INSERT INTO settings(key,value) VALUES('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(now()));
  beat(); const hb = setInterval(() => { try { beat(); } catch {} }, +process.env.HEARTBEAT_MS || 10000);
  const loop = (name, fn) => (async () => { while (!stop()) { let ran = false; try { ran = await fn(); } catch (e) { log('worker_error', `${name}: ${e.message}`); } if (!ran && !stop()) await sleepOrWake(idle); } })();
  let lastSel = 0, lastRecover = Date.now(), lastClean = 0;
  const loops = [
    loop('feeds', async () => { tick(); return runFetchJob(); }), // slow or failing sources never delay editions or social work
    runEditionPool({ concurrency: editionConcurrency(), stop, idleMs: idle }).catch(e => log('worker_error', `editions: ${e.message}`)),
    loop('social', async () => { // hourly pick, social drafts, deliveries: entirely separate from website publishing
      if (Date.now() - lastSel > (+process.env.SELECT_CHECK_MS || 15000)) { lastSel = Date.now(); runSelection(); ensureDraftRequested(); await prepareAll(); }
      if (Date.now() - lastRecover > 30000) { lastRecover = Date.now(); await recoverPublishing(); } if (Date.now() - lastClean > 864e5) { lastClean = Date.now(); cleanup(); }
      return runPublishJob();
    }),
    loop('housekeeping', housekeeping),
  ];
  const shutdown = async sig => { // finish what is running, hand back what is not, exit
    if (stopping) return; stopping = true; log('worker', `${sig}: stopping, waiting for ${inFlight.size} edition(s)`); wake(); clearInterval(hb); const deadline = Date.now() + (+process.env.WORKER_SHUTDOWN_MS || 25000);
    while (inFlight.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    for (const id of inFlight) db.prepare("UPDATE edition_jobs SET status='queued',attempts=MAX(0,attempts-1),stage=NULL,updated_at=? WHERE id=? AND status='generating'").run(now(), id);
    db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run(); log('worker', 'stopped'); process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT')); void loops;
}
