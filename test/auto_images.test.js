// Automatic use of source images: opt-in per publisher, same safeguards as the manual route, provenance recorded, originals kept byte for byte.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'ai-'));
Object.assign(process.env, { DB_PATH: ':memory:', DATA_DIR: dir, TOKEN_KEY: 'c'.repeat(64) });
const { createCanvas } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const { autoAdoptImage, backfillImages, attachLeadToPublications } = await import('../src/graphic_routes.js');
const { _setFetcher } = await import('../src/imgcache.js');
const { _setRobotsFetcher } = await import('../src/robots.js');

const png = (w, h, col = '#336699') => { const c = createCanvas(w, h), x = c.getContext('2d'); x.fillStyle = col; x.fillRect(0, 0, w, h); return c.toBuffer('image/png'); };
let fetched = [], robots = 'User-agent: *\nDisallow:\n', files = {}; const ts = () => new Date().toISOString(); let n = 0;
_setFetcher(async u => { fetched.push(u); const b = files[u]; return b ? { status: 200, buf: b, type: 'image/png' } : { status: 404, buf: Buffer.alloc(0), type: 'text/plain' }; });
const setRobots = txt => { robots = txt; _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from(robots) })); }; // re-registering also clears the robots cache
setRobots(robots);
function story({ auto = 1, img = 'https://pub.test/p1.png', buf = png(800, 600), note = 'Ratopati permits use with credit' } = {}) {
  n++; db.prepare("UPDATE sources SET auto_images=?, auto_images_note=? WHERE id=1").run(auto, auto ? note : null); const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid);
  const url = img ? `${img.replace(/\.png$/, '')}-${n}.png` : null; if (url) files[url] = buf;
  const aid = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id,image_url) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('https://pub.test/a' + n, 'https://pub.test/a' + n, 't', 'k' + n, 'ne', 's', ts(), ts(), ts(), cid, url).lastInsertRowid); return { cid, aid, url, buf };
}
const lead = cid => db.prepare('SELECT lead_asset_id l FROM clusters WHERE id=?').get(cid).l;
beforeEach(() => { fetched = []; setRobots('User-agent: *\nDisallow:\n'); });

test('nothing is fetched or stored for a publisher that was not switched on', async () => {
  const st = story({ auto: 0 }); const r = await autoAdoptImage(st.cid); assert.equal(r.adopted, false); assert.match(r.reason, /switched on/); assert.equal(fetched.length, 0); assert.equal(lead(st.cid), null); assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 0);
});
test('a switched-on publisher: the report image becomes the story lead image with provenance, and the original bytes are kept exactly', async () => {
  const st = story(); const r = await autoAdoptImage(st.cid); assert.equal(r.adopted, true); const a = db.prepare('SELECT * FROM assets WHERE id=?').get(r.id);
  assert.equal(lead(st.cid), r.id); assert.equal(a.cluster_id, st.cid); assert.equal(a.origin_article_id, st.aid); assert.equal(a.origin_url, st.url); assert.match(a.rights_note, /Automatic use switched on/); assert.match(a.rights_note, /permits use with credit/); assert.deepEqual([a.width, a.height], [800, 600]);
  assert.ok(readFileSync(a.path).equals(st.buf), 'the stored file IS the downloaded file (no re-encoding)'); assert.equal(a.sha256, createHash('sha256').update(st.buf).digest('hex'));
  const again = await autoAdoptImage(st.cid); assert.equal(again.adopted, false); assert.equal(again.id, r.id); assert.equal(fetched.length, 1, 'a story that already has a lead image is never fetched or changed again');
});
test('the same safeguards as the manual route: robots.txt, size, unreadable images, publisher default images', async () => {
  setRobots('User-agent: *\nDisallow: /'); let st = story(); assert.equal((await autoAdoptImage(st.cid)).adopted, false); assert.equal(lead(st.cid), null); assert.equal(fetched.length, 0, 'robots refusal: the image is never requested');
  setRobots('User-agent: *\nDisallow:\n'); st = story({ buf: png(200, 150) }); const small = await autoAdoptImage(st.cid); assert.equal(small.adopted, false); assert.match(small.reason, /too small/); assert.equal(lead(st.cid), null);
  st = story({ buf: Buffer.from('<html>not an image</html>') }); assert.equal((await autoAdoptImage(st.cid)).adopted, false); st = story({ img: null }); assert.match((await autoAdoptImage(st.cid)).reason, /no report/);
  const dflt = 'https://pub.test/default-logo.png'; files[dflt] = png(800, 600); const g = []; for (let i = 0; i < 5; i++) { n++; db.prepare('UPDATE sources SET auto_images=1, auto_images_note=? WHERE id=1').run('basis text here'); const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid); db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id,image_url) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('https://pub.test/d' + n, 'https://pub.test/d' + n, 't', 'kd' + n, 'ne', 's', ts(), ts(), ts(), cid, dflt); g.push(cid); }
  const r = await autoAdoptImage(g[0]); assert.equal(r.adopted, false); assert.match(r.reason, /default image/);
});
test('published editions without a photo get one once the publisher is on; each story is tried at most every 6 hours', async () => {
  const st = story({ auto: 0 }); db.prepare("INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution) VALUES(?,?,?,?,?,?,'{}','')").run(st.cid, st.aid, 'ne_original', 'ne', 'approved', ts()); const did = db.prepare('SELECT id FROM drafts WHERE cluster_id=?').get(st.cid).id;
  for (const lang of ['ne', 'en']) db.prepare("INSERT INTO publications(cluster_id,lang,draft_id,headline,summary,body,category,status,published_at,updated_at,attribution) VALUES(?,?,?,'h','s','b','national','published',?,?,'[]')").run(st.cid, lang, did, ts(), ts());
  assert.equal(await backfillImages(), 0, 'publisher off: nothing happens'); db.prepare("UPDATE sources SET auto_images=1, auto_images_note='permission on file' WHERE id=1").run(); db.prepare('UPDATE clusters SET image_tried_at=NULL WHERE id=?').run(st.cid);
  assert.equal(await backfillImages(), 1); const pubs = db.prepare('SELECT photo_asset_id,photo_credit FROM publications WHERE cluster_id=?').all(st.cid); assert.ok(pubs.every(p => p.photo_asset_id === lead(st.cid) && p.photo_credit), 'both editions use the one lead image with a credit'); assert.equal(await backfillImages(), 0);
  const noImg = story(); delete files[noImg.url]; db.prepare('UPDATE sources SET auto_images=1, auto_images_note=? WHERE id=1').run('permission on file'); db.prepare("INSERT INTO publications(cluster_id,lang,draft_id,headline,summary,body,category,status,published_at,updated_at,attribution) VALUES(?,?,?,'h','s','b','national','published',?,?,'[]')").run(noImg.cid, 'en', did, ts(), ts()); await backfillImages(); const f0 = fetched.length; await backfillImages(); await backfillImages(); assert.equal(fetched.length, f0, 'no repeated fetches within 6 hours'); assert.ok(db.prepare('SELECT image_tried_at t FROM clusters WHERE id=?').get(noImg.cid).t, 'a failed attempt is remembered, so it is not repeated every tick');
  assert.equal(attachLeadToPublications(st.cid), 0, 'attaching is idempotent');
});
