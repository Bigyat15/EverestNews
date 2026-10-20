// Where does the time go? Everything here is computed from timestamps already stored on edition jobs and AI calls: nothing extra is logged, and no payloads or secrets are involved.
import { db } from './db.js';

export const percentile = (arr, p) => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const stat = a => ({ n: a.filter(Number.isFinite).length, median: percentile(a, 0.5), p95: percentile(a, 0.95), avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : null });
const sec = (iso1, iso0) => (Date.parse(iso1) - Date.parse(iso0)) / 1000;

export function pipelineMetrics(hours = 24, nowMs = Date.now()) {
  const cut = new Date(nowMs - hours * 36e5).toISOString(), nowIso = new Date(nowMs).toISOString();
  const jobs = db.prepare("SELECT * FROM edition_jobs WHERE COALESCE(published_at,finished_at,updated_at)>=? OR status IN ('queued','generating')").all(cut), pub = jobs.filter(j => j.status === 'published' && j.published_at && j.published_at >= cut);
  const due = jobs.filter(j => j.status === 'queued' && j.run_at <= nowIso), waiting = jobs.filter(j => j.status === 'queued' && j.run_at > nowIso), oldest = due.map(j => sec(nowIso, j.created_at)).sort((a, b) => b - a)[0] ?? null;
  const calls = db.prepare('SELECT provider, model, ok, ms FROM ai_usage WHERE at>=? AND provider IS NOT NULL').all(cut), by = {};
  for (const c of calls) { const k = `${c.provider}/${c.model}`; (by[k] ??= { provider: c.provider, model: c.model, calls: 0, ok: 0, ms: [] }); by[k].calls++; by[k].ok += c.ok; if (c.ms != null && c.ok) by[k].ms.push(c.ms / 1000); }
  const done = jobs.filter(j => j.finished_at && j.finished_at >= cut), hb = db.prepare("SELECT value FROM settings WHERE key='worker_heartbeat'").get(), beat = hb ? JSON.parse(hb.value) : null;
  return {
    window_hours: hours, at: nowIso, worker_heartbeat_age_s: beat ? Math.round(sec(nowIso, beat)) : null,
    backlog: { queued_due: due.length, queued_waiting: waiting.length, generating: jobs.filter(j => j.status === 'generating').length, oldest_due_age_s: oldest == null ? null : Math.round(oldest), needs_review: jobs.filter(j => j.status === 'needs_review').length },
    published: { count: pub.length, last_at: pub.map(j => j.published_at).sort().at(-1) ?? null,
      detection_to_publication_s: stat(pub.map(j => sec(j.published_at, j.detected_at ?? j.created_at))), queue_wait_s: stat(pub.filter(j => j.first_started_at).map(j => sec(j.first_started_at, j.created_at))),
      extract_s: stat(pub.map(j => j.extract_ms / 1000).filter(Number.isFinite)), generate_s: stat(pub.map(j => j.generate_ms / 1000).filter(Number.isFinite)), validate_s: stat(pub.map(j => j.validate_ms / 1000).filter(Number.isFinite)), publish_s: stat(pub.map(j => j.publish_ms / 1000).filter(Number.isFinite)) },
    outcomes: { published: done.filter(j => j.status === 'published').length, needs_review: done.filter(j => j.status === 'needs_review').length, failed: done.filter(j => j.status === 'failed').length, by_reason: Object.fromEntries(Object.entries(done.filter(j => j.status !== 'published').reduce((m, j) => (m[j.reason_code ?? j.status] = (m[j.reason_code ?? j.status] ?? 0) + 1, m), {}))), retries: jobs.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0) },
    providers: Object.values(by).map(v => ({ provider: v.provider, model: v.model, calls: v.calls, ok_rate: v.calls ? +(v.ok / v.calls).toFixed(2) : null, latency_s: stat(v.ms) })).sort((a, b) => b.calls - a.calls),
  };
}
