// Retention: keeps the 50 GB VPS from filling up. Never touches anything that is live or referenced.
import { unlinkSync, existsSync } from 'node:fs';
import { db, now, log } from './db.js';
const days = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? +JSON.parse(r.value) : d; };
const ago = n => new Date(Date.now() - n * 864e5).toISOString();
export function cleanup() {
  const out = { graphics: 0, jobs: 0, audit: 0, drafts: 0 };
  // superseded graphics (older versions of an export) that no publication or post uses
  for (const g of db.prepare(`SELECT id,path FROM graphics WHERE status='superseded' AND created_at<? AND id NOT IN (SELECT graphic_id FROM publications WHERE graphic_id IS NOT NULL) AND id NOT IN (SELECT graphic_id FROM posts WHERE graphic_id IS NOT NULL)`).all(ago(days('retain_graphics_days', 30)))) {
    try { if (existsSync(g.path)) unlinkSync(g.path); } catch {} db.prepare('DELETE FROM graphics WHERE id=?').run(g.id); out.graphics++;
  }
  const j = ago(days('retain_jobs_days', 14));
  out.jobs = db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND COALESCE(finished_at,run_at)<?").run(j).changes + db.prepare("DELETE FROM ai_jobs WHERE status IN ('done','failed') AND COALESCE(finished_at,created_at)<?").run(j).changes;
  out.audit = db.prepare('DELETE FROM audit WHERE at<?').run(ago(days('retain_audit_days', 90))).changes;
  out.drafts = db.prepare("DELETE FROM drafts WHERE status='superseded' AND created_at<? AND id NOT IN (SELECT draft_id FROM publications) AND id NOT IN (SELECT draft_id FROM posts) AND id NOT IN (SELECT draft_id FROM graphics WHERE draft_id IS NOT NULL)").run(ago(days('retain_drafts_days', 60))).changes;
  if (out.graphics + out.jobs + out.audit + out.drafts) log('cleanup', JSON.stringify(out));
  return out;
}
