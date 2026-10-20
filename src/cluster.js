import { db, now } from './db.js';

export const AUTO = 0.55, REVIEW = 0.35, WINDOW_H = 72;
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'is', 'at', 'by', 'as', 'with', 'को', 'मा', 'ले', 'र', 'का', 'की', 'लाई', 'छ', 'हो', 'यो', 'ने']);
export const tokens = t => new Set(t.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(w => (w.length > 1 || /\p{N}/u.test(w)) && !STOP.has(w)));
export function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; }
const nums = s => [...s].filter(w => /\p{N}/u.test(w)).sort().join(',');

// Different figures in two otherwise-similar headlines suggest distinct developments -> never auto-merge.
export function compare(a, b) {
  const j = jaccard(a, b), na = nums(a), nb = nums(b);
  return { score: j, conflict: !!(na && nb && na !== nb) };
}

export function clusterNew() {
  const pending = db.prepare('SELECT id,source_id,title,title_key,language,COALESCE(published_at,fetched_at) t FROM articles WHERE cluster_id IS NULL AND ignore_reason IS NULL ORDER BY t').all();
  const upd = db.prepare('UPDATE articles SET cluster_id=?,duplicate_of=? WHERE id=?');
  const newCluster = () => Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(now()).lastInsertRowid);
  const cand = db.prepare('INSERT OR IGNORE INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,?,?)');
  const audit = db.prepare('INSERT INTO duplicate_decisions(at,article_id,cluster_id,other_article_id,other_cluster_id,action,score,reason) VALUES(?,?,?,?,?,?,?,?)');
  const cache = new Map(); const tk = a => cache.get(a.id) ?? (cache.set(a.id, tokens(a.title)), cache.get(a.id));
  db.exec('BEGIN');
  try {
    for (const a of pending) {
      const since = new Date(Date.parse(a.t) - WINDOW_H * 36e5).toISOString();
      const pool = db.prepare(`SELECT id,source_id,title,title_key,language,cluster_id FROM articles WHERE cluster_id IS NOT NULL AND ignore_reason IS NULL AND id<>? AND COALESCE(published_at,fetched_at)>=?`).all(a.id, since);
      const sameLang = pool.filter(p => p.language === a.language), cross = pool.filter(p => p.language !== a.language);
      const same = sameLang.find(p => p.source_id === a.source_id && p.title_key === a.title_key);
      if (same) { upd.run(same.cluster_id, same.id, a.id); audit.run(now(), a.id, same.cluster_id, same.id, null, 'duplicate_of', 1, 'same source, same headline'); continue; }
      let best = null; const ta = tk(a);
      for (const p of sameLang) { if (p.source_id === a.source_id) continue; const c = compare(ta, tk(p)); if (!best || c.score > best.score) best = { ...c, p }; }
      if (best && best.score >= AUTO && !best.conflict) { upd.run(best.p.cluster_id, null, a.id); audit.run(now(), a.id, best.p.cluster_id, best.p.id, null, 'joined', best.score, 'headline overlap'); }
      else {
        const cid = newCluster(); upd.run(cid, null, a.id);
        audit.run(now(), a.id, cid, null, null, 'new_cluster', best?.score ?? 0, best && best.score >= REVIEW ? 'near match held for review' : 'no match');
        // Cross-language coverage: scripts differ so headlines cannot be compared; identical figures in the same window are only a hint -> review, never auto-merge.
        const na = nums(ta);
        const x = na && cross.find(p => nums(tk(p)) === na);
        if (x) { cand.run(a.id, x.id, 0.4, 'possible cross-language coverage (same figures)'); audit.run(now(), a.id, cid, x.id, x.cluster_id, 'review_candidate', 0.4, 'cross-language, same figures'); }
        if (best && best.score >= REVIEW) cand.run(a.id, best.p.id, best.score, best.conflict ? 'similar headline but different numbers' : 'partial headline overlap');
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return pending.length;
}

// Moves every record that points at the dropped story onto the kept one. Refuses when both stories are already live in the same edition,
// because that would publish two articles for one event.
export function mergeClusters(keep, drop) {
  const clash = db.prepare('SELECT a.lang FROM publications a JOIN publications b ON a.lang=b.lang WHERE a.cluster_id=? AND b.cluster_id=?').get(keep, drop);
  if (clash) throw Object.assign(new Error(`Both stories already have a ${clash.lang === 'ne' ? 'Nepali' : 'English'} article on the website. Unpublish one before merging.`), { status: 409 });
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM ai_jobs WHERE cluster_id=? AND status IN ('queued','running')").run(drop);
    db.prepare("DELETE FROM selections WHERE cluster_id=? AND EXISTS (SELECT 1 FROM selections WHERE cluster_id=? AND status='selected')").run(drop, keep); // one selection per story
    for (const t of ['articles', 'drafts', 'graphics', 'assets', 'ai_jobs', 'publications', 'selections']) db.prepare(`UPDATE ${t} SET cluster_id=? WHERE cluster_id=?`).run(keep, drop);
    db.prepare('UPDATE clusters SET pinned=MAX(pinned,(SELECT pinned FROM clusters WHERE id=?)) WHERE id=?').run(drop, keep);
    db.prepare('DELETE FROM clusters WHERE id=?').run(drop); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
