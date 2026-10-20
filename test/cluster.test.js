import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { db } = await import('../src/db.js');
const { clusterNew, tokens, compare } = await import('../src/cluster.js');
const { view, rankClusters } = await import('../src/rank.js');

const ins = db.prepare(`INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
const add = (src, title, ageMin, lang = 'en') => { const t = new Date(Date.now() - ageMin * 60000).toISOString(); ins.run(src, 'https://x/' + Math.random(), 'https://x/' + Math.random(), title, title.toLowerCase(), lang, 'summary text', t, t, t); };

test('different numbers block auto-merge; same event merges; same source dup links', () => {
  add(1, 'Flood in Kailali kills 5 people, rescue continues', 30);
  add(2, 'Flood in Kailali kills 5 people as rescue continues', 20);
  add(3, 'Flood in Kailali kills 9 people, rescue continues', 10);
  add(1, 'Flood in Kailali kills 5 people, rescue continues', 5);
  clusterNew();
  const c = db.prepare('SELECT id,cluster_id,duplicate_of FROM articles ORDER BY id').all();
  assert.equal(c[0].cluster_id, c[1].cluster_id, 'same event merged');
  assert.notEqual(c[2].cluster_id, c[0].cluster_id, 'different casualty figure kept apart');
  assert.equal(c[3].cluster_id, c[0].cluster_id); assert.equal(c[3].duplicate_of, c[0].id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cluster_candidates WHERE status='pending'").get().n, 1, 'uncertain pair queued for human review');
});
test('same-source duplicate does not add a source to corroboration', () => {
  const c = rankClusters().find(x => x.articles.length === 3); assert.equal(c.sources, 2);
});
test('rejected clusters leave top views; breaking needs 2+ sources', () => {
  const top = view('now'); assert.ok(top.length >= 2); assert.ok(top[0].factors.length >= 6);
  assert.deepEqual(view('breaking').map(c => c.sources).filter(n => n < 2), []);
  db.prepare('UPDATE clusters SET rejected=1').run(); assert.equal(view('now').length, 0); assert.ok(view('dups').length >= 2);
});
