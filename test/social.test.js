// Workflow tests against the MOCK adapter. They prove our gating, queueing, retry, idempotency and recovery logic.
// They say nothing about Facebook/Instagram/X themselves, whose real adapters are not implemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
Object.assign(process.env, { DB_PATH: ':memory:', SOCIAL_MOCK: '1', TOKEN_KEY: 'a'.repeat(64), SOCIAL_BACKOFF_BASE_MS: '1' });
const { createCanvas } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const S = await import('../src/social.js');
const { encrypt, decrypt } = await import('../src/secrets.js');
S.setMaxAccounts(100);
const dir = mkdtempSync(path.join(tmpdir(), 'soc-')); const sleep = ms => new Promise(r => setTimeout(r, ms));
const pngFile = (name, mime = 'png') => { const p = path.join(dir, name), c = createCanvas(200, 200); c.getContext('2d').fillRect(0, 0, 200, 200); writeFileSync(p, c.toBuffer(mime === 'jpeg' ? 'image/jpeg' : 'image/png')); return p; };
const ts = new Date().toISOString(); let n = 0;
function story({ approved = true, graphic = 'png', headline = 'अनुमोदित शीर्षक', photoRights = 'mine' } = {}) {
  n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts).lastInsertRowid);
  const aid = Number(db.prepare("INSERT INTO articles(source_id,url,canon_url,title,title_key,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?)").run('https://s/' + n, 'https://s/' + n, 't', 'k' + n, ts, ts, cid).lastInsertRowid);
  const did = Number(db.prepare(`INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,headline_options,rec_idx,flags,final_headline,final_body,final_caption) VALUES(?,?, 'x','ne',?,?,'{}','x','[]',0,'[]',?,?,?)`).run(cid, aid, approved ? 'approved' : 'needs_review', ts, headline, 'body', 'क्याप्सन #नेपाल').lastInsertRowid);
  let gid = null;
  if (graphic) {
    const asset = Number(db.prepare("INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES('photo',?,?,?,?,1,500,500,'x',?,?)").run(cid, 'x', 'p.png', 'image/png', ts, photoRights).lastInsertRowid);
    const file = pngFile(`g${n}.${graphic === 'jpeg' ? 'jpg' : 'png'}`, graphic);
    gid = Number(db.prepare("INSERT INTO graphics(cluster_id,draft_id,photo_asset_id,spec,headline_snapshot,path,format,mime,width,height,bytes,created_at) VALUES(?,?,?, '{}',?,?,'portrait',?,200,200,1000,?)").run(cid, did, asset, headline, file, graphic === 'jpeg' ? 'image/jpeg' : 'image/png', ts).lastInsertRowid);
  }
  return { cid, did, gid, headline };
}
const account = name => S.connectMockAccount(name);
const tgt = id => db.prepare('SELECT * FROM post_targets WHERE id=?').get(id), tOf = pid => db.prepare('SELECT * FROM post_targets WHERE post_id=?').all(pid);
const pState = id => db.prepare('SELECT state FROM posts WHERE id=?').get(id).state;
// run due deliveries; keep going while a retry is due within the next 60 ms, but never wait for far-future schedules
const drain = async () => { for (let i = 0; i < 300; i++) { if (await S.runPublishJob()) continue; if (!db.prepare("SELECT 1 FROM post_targets WHERE status='queued' AND next_run_at<=?").get(new Date(Date.now() + 60).toISOString())) break; await sleep(10); } };
const full = (f, accts, caption) => { const id = S.createPost({ draft_id: f.did, graphic_id: f.gid, targets: accts.map(a => ({ account_id: a, caption })) }); S.approvePost(id); return id; };

test('gates: unapproved draft, outdated graphic, replaced graphic and unlicensed photo are all refused', () => {
  const a = account('gates'), u = story({ approved: false }); assert.throws(() => S.createPost({ draft_id: u.did, graphic_id: u.gid, targets: [{ account_id: a, caption: 'x' }] }), /not approved/);
  const f = story(); db.prepare("UPDATE drafts SET final_headline='बदलिएको शीर्षक' WHERE id=?").run(f.did);
  assert.throws(() => S.createPost({ draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: a, caption: 'x' }] }), /outdated/);
  const r = story({ photoRights: '' }); assert.throws(() => S.createPost({ draft_id: r.did, graphic_id: r.gid, targets: [{ account_id: a, caption: 'x' }] }), /usage permission/);
  const g = story(); db.prepare("UPDATE graphics SET status='superseded' WHERE id=?").run(g.gid); assert.throws(() => S.createPost({ draft_id: g.did, graphic_id: g.gid, targets: [{ account_id: a, caption: 'x' }] }), /replaced/);
});
test('platform rules: caption length, image requirement and format are validated per account', () => {
  const acct = db.prepare('SELECT * FROM social_accounts LIMIT 1').get(), f = story();
  const mk = (platform) => ({ ...acct, platform, adapter: 'mock', status: 'connected' }), g = db.prepare('SELECT * FROM graphics WHERE id=?').get(f.gid);
  assert.ok(S.validateTarget(mk('x'), 'क'.repeat(281), g).some(i => /280/.test(i.message))); assert.ok(!S.validateTarget(mk('x'), 'क'.repeat(280), g).some(i => i.severity === 'error'));
  assert.ok(S.validateTarget(mk('instagram'), 'hello', null).some(i => /requires an image/.test(i.message))); assert.ok(S.validateTarget(mk('instagram'), 'hello', g).some(i => /JPEG/.test(i.message)), 'PNG refused for Instagram');
  const jg = db.prepare('SELECT * FROM graphics WHERE id=?').get(story({ graphic: 'jpeg' }).gid); assert.ok(!S.validateTarget(mk('instagram'), 'hello #a', jg).some(i => i.severity === 'error'));
  assert.ok(S.validateTarget(mk('instagram'), Array.from({ length: 31 }, (_, i) => '#t' + i).join(' '), jg).some(i => /hashtags/.test(i.message)));
  assert.ok(S.validateTarget({ ...mk('x'), status: 'expired' }, 'hi', null).some(i => /reconnect/.test(i.message))); assert.ok(S.validateTarget(mk('x'), '   ', null).some(i => /empty/.test(i.message)));
});
test('happy path: approve → schedule → publish; platform id and url come from the adapter; no second delivery; repost is blocked', async () => {
  const a = account('happy'), f = story(), id = full(f, [a], 'सामान्य क्याप्सन'); assert.equal(pState(id), 'approved'); await drain(); assert.equal(tgt(tOf(id)[0].id).status, 'pending', 'approved is not scheduled: nothing is sent');
  S.schedulePost(id); await drain(); const t = tOf(id)[0]; assert.equal(t.status, 'published'); assert.match(t.platform_post_id, /^mock_/); assert.match(t.platform_url, /^https:\/\/mock\.invalid\//); assert.equal(pState(id), 'published');
  const n0 = db.prepare('SELECT COUNT(*) n FROM mock_remote').get().n; await drain(); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote').get().n, n0, 'nothing delivered twice');
  assert.throws(() => S.createPost({ draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: a, caption: 'again' }] }), /already posted/);
  assert.ok(S.createPost({ draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: a, caption: 'again' }], repost: true }), 'explicit override allowed');
});
test('workflow order is enforced: cannot schedule unapproved posts, approve twice, or approve with a stale graphic', () => {
  const a = account('order'), f = story(), id = S.createPost({ draft_id: f.did, graphic_id: f.gid, targets: [{ account_id: a, caption: 'x' }] });
  assert.throws(() => S.schedulePost(id), /approve it first/); S.approvePost(id); assert.throws(() => S.approvePost(id), /only a draft/);
  db.prepare("UPDATE drafts SET final_headline='नयाँ' WHERE id=?").run(f.did); assert.throws(() => S.schedulePost(id), /outdated/, 'gate re-checked at scheduling');
});
test('scheduled posts wait for their time, then go out', async () => {
  const a = account('later'), f = story(), id = full(f, [a], 'later'); S.schedulePost(id, new Date(Date.now() + 60000).toISOString()); await drain(); assert.equal(tgt(tOf(id)[0].id).status, 'queued', 'not due yet');
  db.prepare("UPDATE post_targets SET next_run_at=? WHERE post_id=?").run(new Date(Date.now() - 1000).toISOString(), id); await drain(); assert.equal(tgt(tOf(id)[0].id).status, 'published');
  assert.throws(() => S.schedulePost(full(story(), [a], 'x'), 'not-a-date'), /Invalid/);
});
test('recoverable failures retry with backoff and deliver exactly once (idempotency)', async () => {
  const a = account('flaky'), f = story(), id = full(f, [a], 'کچھ [mock:recoverable]'.replace('کچھ', 'क्याप्सन')); S.schedulePost(id); await drain();
  const t = tOf(id)[0]; assert.equal(t.status, 'published'); assert.equal(t.attempts, 3, 'succeeded on the 3rd attempt'); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=?').get(t.idempotency_key).n, 1);
  const rl = full(story(), [a], 'क्याप्सन [mock:ratelimit]'); S.schedulePost(rl); await S.runPublishJob(); const first = tOf(rl)[0]; assert.equal(first.status, 'queued'); assert.ok(Date.parse(first.next_run_at) - Date.now() < 1000, 'retry-after hint honoured (5 ms in the mock)'); await drain(); assert.equal(tOf(rl)[0].status, 'published');
});
test('permanent failure is final; auth failure expires the account and retry works after reconnecting', async () => {
  const a = account('perm'), id = full(story(), [a], 'x [mock:permanent]'); S.schedulePost(id); await drain(); let t = tOf(id)[0]; assert.equal(t.status, 'failed'); assert.equal(t.attempts, 1, 'no retries'); assert.equal(t.error_kind, 'permanent'); assert.equal(pState(id), 'failed');
  assert.throws(() => S.retryTarget(t.id), /permanent/);
  const b = account('auth'), ia = full(story(), [b], 'x [mock:auth]'); S.schedulePost(ia); await drain(); t = tOf(ia)[0]; assert.equal(t.status, 'failed'); assert.equal(t.error_kind, 'auth');
  assert.equal(db.prepare('SELECT status FROM social_accounts WHERE id=?').get(b).status, 'expired'); assert.throws(() => S.retryTarget(t.id), /Reconnect/);
  db.prepare("UPDATE social_accounts SET status='connected' WHERE id=?").run(b); db.prepare("UPDATE post_targets SET caption='x' WHERE id=?").run(t.id); S.retryTarget(t.id); await drain(); assert.equal(tgt(t.id).status, 'published'); assert.equal(pState(ia), 'published');
});
test('gives up after the maximum attempts, says so, and allows a manual retry', async () => {
  const a = account('hopeless'), id = full(story(), [a], 'x [mock:down]'); S.schedulePost(id); await drain(); const t = tOf(id)[0];
  assert.equal(t.status, 'failed'); assert.equal(t.attempts, 5); assert.match(t.error, /gave up after 5 attempts/); assert.equal(t.error_kind, 'recoverable'); assert.equal(pState(id), 'failed');
  db.prepare("UPDATE post_targets SET caption='x' WHERE id=?").run(t.id); S.retryTarget(t.id); await drain(); assert.equal(tgt(t.id).status, 'published', 'manual retry gets a fresh set of attempts');
});
test('a graphic that becomes outdated AFTER scheduling is never published', async () => {
  const a = account('latecheck'), f = story(), id = full(f, [a], 'x'); S.schedulePost(id, new Date(Date.now() + 30).toISOString());
  db.prepare("UPDATE drafts SET final_headline='अर्कै शीर्षक' WHERE id=?").run(f.did); await sleep(40); await drain();
  const t = tOf(id)[0]; assert.equal(t.status, 'failed'); assert.match(t.error, /outdated/); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=?').get(t.idempotency_key).n, 0, 'nothing reached the platform');
});
test('crash recovery never double-posts: delivered → published; undelivered → requeued; platform without idempotency → unknown, needs a human', async () => {
  const a = account('crash'), f1 = story(), id1 = full(f1, [a], 'x'); S.schedulePost(id1); const t1 = tOf(id1)[0];
  db.prepare("INSERT INTO mock_remote(key,account_id,caption,url,at) VALUES(?,?,?,?,?)").run(t1.idempotency_key, a, 'x', 'https://mock.invalid/already', ts); db.prepare("UPDATE post_targets SET status='publishing',updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(t1.id);
  const f2 = story(), id2 = full(f2, [a], 'y'); S.schedulePost(id2); const t2 = tOf(id2)[0]; db.prepare("UPDATE post_targets SET status='publishing',updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(t2.id);
  const fb = Number(db.prepare("INSERT INTO social_accounts(platform,adapter,display_name,external_id,status,created_at,updated_at) VALUES('facebook','facebook','Fake FB','fb1','connected',?,?)").run(ts, ts).lastInsertRowid);
  const f3 = story(), id3 = Number(db.prepare("INSERT INTO posts(cluster_id,draft_id,graphic_id,state,created_at,updated_at) VALUES(?,?,?, 'publishing',?,?)").run(f3.cid, f3.did, f3.gid, ts, ts).lastInsertRowid);
  const t3 = Number(db.prepare("INSERT INTO post_targets(post_id,account_id,caption,status,idempotency_key,updated_at) VALUES(?,?,?,'publishing','k-fb','2000-01-01T00:00:00.000Z')").run(id3, fb, 'z').lastInsertRowid);
  const live = story(), idl = full(live, [account('live-worker')], 'x'); S.schedulePost(idl); db.prepare("UPDATE post_targets SET status='publishing',updated_at=? WHERE post_id=?").run(new Date().toISOString(), idl);
  assert.equal(await S.recoverPublishing(), 3, 'only the three stale deliveries are touched'); assert.equal(tOf(idl)[0].status, 'publishing', 'a fresh in-flight delivery (live worker) is left alone');
  db.prepare("UPDATE post_targets SET status='cancelled' WHERE post_id=?").run(idl);
  assert.equal(tgt(t1.id).status, 'published'); assert.equal(tgt(t1.id).platform_url, 'https://mock.invalid/already'); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=?').get(t1.idempotency_key).n, 1);
  assert.equal(tgt(t2.id).status, 'queued'); assert.equal(tgt(t3).status, 'unknown'); assert.throws(() => S.retryTarget(t3), /unknown/); assert.throws(() => S.markPublishedManually(t3, 'nope'), /URL/);
  S.markPublishedManually(t3, 'https://example.com/p/1'); assert.equal(tgt(t3).status, 'published'); await drain(); assert.equal(tgt(t2.id).status, 'published');
});
test('concurrent workers cannot deliver the same target twice', async () => {
  const a = account('race'), id = full(story(), [a], 'race'); S.schedulePost(id); const before = db.prepare('SELECT COUNT(*) n FROM mock_remote').get().n;
  const results = await Promise.all([S.runPublishJob(), S.runPublishJob(), S.runPublishJob()]); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote').get().n, before + 1); assert.equal(tOf(id)[0].attempts, 1); assert.ok(results.includes(true));
});
test('cancel stops a scheduled post; disconnecting an account cancels its queued deliveries', async () => {
  const a = account('cancel'), b = account('disc'), id = full(story(), [a, b], 'x'); S.schedulePost(id, new Date(Date.now() + 3600e3).toISOString()); S.disconnectAccount(b);
  const ts_ = tOf(id); assert.equal(ts_.find(t => t.account_id === b).status, 'cancelled'); assert.equal(db.prepare('SELECT token_enc FROM social_accounts WHERE id=?').get(b).token_enc, null, 'token wiped');
  S.cancelPost(id); assert.ok(tOf(id).every(t => t.status === 'cancelled')); assert.equal(pState(id), 'cancelled'); db.prepare("UPDATE post_targets SET next_run_at='2000-01-01T00:00:00Z'").run(); await drain(); assert.ok(tOf(id).every(t => t.status === 'cancelled'));
  assert.throws(() => S.cancelPost(id), /cannot be cancelled/);
});
test('partial success is reported as partial; each account has its own status', async () => {
  const ok = account('p-ok'), bad = account('p-bad'), id = full(story(), [ok, bad], 'x'); db.prepare("UPDATE post_targets SET caption='x [mock:permanent]' WHERE post_id=? AND account_id=?").run(id, bad); S.schedulePost(id); await drain();
  assert.equal(pState(id), 'partial'); assert.deepEqual(tOf(id).map(t => t.status).sort(), ['failed', 'published']);
});
test('tokens are encrypted at rest, round-trip, never exposed, and tampering is detected', () => {
  const row = db.prepare("SELECT token_enc FROM social_accounts WHERE display_name='happy'").get(); assert.ok(row.token_enc.startsWith('v1:')); assert.ok(!row.token_enc.includes('mock-token')); assert.equal(decrypt(row.token_enc), 'mock-token');
  assert.notEqual(encrypt('same'), encrypt('same'), 'random IV'); const bad = row.token_enc.slice(0, -4) + 'AAAA'; assert.throws(() => decrypt(bad)); assert.throws(() => decrypt('plain'));
});
test('account limit is configurable and enforced', () => {
  const used = db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE status<>'disconnected'").get().n; S.setMaxAccounts(used); assert.throws(() => account('one-too-many'), /limit/); S.setMaxAccounts(used + 1); assert.ok(account('fits')); S.setMaxAccounts(100);
});
test('mock accounts are refused unless SOCIAL_MOCK=1; real platforms can never be connected by the stubs', async () => {
  process.env.SOCIAL_MOCK = '0'; assert.throws(() => account('disabled'), /disabled/); process.env.SOCIAL_MOCK = '1';
  const { adapterFor } = await import('../src/social_adapters.js'); await assert.rejects(adapterFor({ adapter: 'facebook', platform: 'facebook' }).publish({}), /not implemented/);
});

test('retention removes only old, unreferenced leftovers', async () => {
  const { cleanup } = await import('../src/cleanup.js'); const old = '2000-01-01T00:00:00.000Z', f1 = story(), f2 = story(), f3 = story(), a = account('retain');
  S.createPost({ draft_id: f3.did, graphic_id: f3.gid, targets: [{ account_id: a, caption: 'x' }] }); // f3's graphic is used by a post (created while it was current)
  const file = pngFile('old.png'); db.prepare("UPDATE graphics SET status='superseded',created_at=?,path=? WHERE id IN (?,?,?)").run(old, file, f1.gid, f2.gid, f3.gid);
  db.prepare("INSERT INTO publications(cluster_id,lang,draft_id,headline,body,attribution,graphic_id,published_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(f2.cid, 'ne', f2.did, 'h', 'b', '[]', f2.gid, ts, ts); // f2's graphic is used by a live article
  db.prepare("INSERT INTO audit(at,kind,detail) VALUES(?,?,?)").run(old, 'x', 'ancient'); db.prepare("INSERT INTO audit(at,kind,detail) VALUES(?,?,?)").run(ts, 'x', 'recent');
  const r = cleanup(); assert.equal(r.graphics, 1, 'only the unreferenced old graphic'); assert.ok(!db.prepare('SELECT 1 FROM graphics WHERE id=?').get(f1.gid)); assert.ok(db.prepare('SELECT 1 FROM graphics WHERE id=?').get(f2.gid)); assert.ok(db.prepare('SELECT 1 FROM graphics WHERE id=?').get(f3.gid));
  assert.ok(!db.prepare("SELECT 1 FROM audit WHERE detail='ancient'").get()); assert.ok(db.prepare("SELECT 1 FROM audit WHERE detail='recent'").get()); assert.ok(db.prepare('SELECT 1 FROM drafts WHERE id=?').get(f1.did), 'approved drafts are never deleted');
});
