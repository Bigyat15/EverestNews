import { db, now } from './db.js';
import { PLATFORMS, platformInfo, mockEnabled } from './social_adapters.js';
import { Refusal, composeCaption, defaultCaption, createPost, approvePost, schedulePost, cancelPost, retryTarget, markPublishedManually, connectMockAccount, disconnectAccount, checkPublishable, validateTarget, maxAccounts, setMaxAccounts } from './social.js';
import { currentHeadline } from './headline.js';
import * as SD from './social_drafts.js';

const accountView = a => ({ id: a.id, platform: a.platform, label: PLATFORMS[a.platform]?.label ?? a.platform, isTest: a.adapter === 'mock', display_name: a.display_name, status: a.status, token_expires_at: a.token_expires_at, last_error: a.last_error, created_at: a.created_at }); // never includes the token
function postView(p) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(p.draft_id), g = p.graphic_id ? db.prepare('SELECT id,format,mime,bytes,status FROM graphics WHERE id=?').get(p.graphic_id) : null, gate = checkPublishable(p);
  return { id: p.id, cluster_id: p.cluster_id, draft_id: p.draft_id, headline: d ? (d.status === 'approved' ? d.final_headline : currentHeadline(d)) : '', lang: d?.lang, state: p.state, scheduled_at: p.scheduled_at, approved_at: p.approved_at, created_at: p.created_at,
    graphic: g, gate: { ok: gate.ok, problems: gate.problems },
    targets: db.prepare('SELECT t.id,t.account_id,t.caption,t.status,t.attempts,t.next_run_at,t.platform_post_id,t.platform_url,t.error,t.error_kind,t.published_at,a.display_name,a.platform,a.adapter FROM post_targets t JOIN social_accounts a ON a.id=t.account_id WHERE t.post_id=? ORDER BY t.id').all(p.id).map(t => ({ ...t, isTest: t.adapter === 'mock', adapter: undefined })) };
}
const R = [
  ['GET', /^\/api\/social\/platforms$/, () => Object.keys(PLATFORMS).filter(id => id !== 'mock' || mockEnabled()).map(platformInfo)],
  ['GET', /^\/api\/social\/accounts$/, () => ({ accounts: db.prepare('SELECT * FROM social_accounts ORDER BY id').all().map(accountView), max: maxAccounts(), used: db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE status<>'disconnected'").get().n })],
  ['POST', /^\/api\/social\/accounts\/mock$/, ({ body }) => ({ id: connectMockAccount(body.display_name) })],
  ['POST', /^\/api\/social\/connect\/(\w+)$/, ({ m }) => {
    const id = m[1]; if (!PLATFORMS[id] || PLATFORMS[id].mockOnly) throw new Refusal('Unknown platform.', 404); const info = platformInfo(id);
    if (info.missingEnv.length) throw new Refusal(`${info.label} is not configured. Add ${info.missingEnv.join(' and ')} to .env (from the platform's developer console), then restart.`, 409, { missingEnv: info.missingEnv, note: info.note });
    throw new Refusal(`Credentials for ${info.label} are present, but its authorization flow and publishing adapter are not implemented yet. No account was connected.`, 501, { note: info.note });
  }],
  ['DELETE', /^\/api\/social\/accounts\/(\d+)$/, ({ m }) => { disconnectAccount(+m[1]); return { ok: true }; }],
  ['PUT', /^\/api\/social\/limits$/, ({ body }) => { const n = Math.round(+body.max_accounts); if (!(n >= 1 && n <= 100)) throw new Refusal('max_accounts must be 1-100', 400); setMaxAccounts(n); return { ok: true }; }],
  ['POST', /^\/api\/posts\/validate$/, ({ body: b }) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(+b.draft_id); if (!d) throw new Refusal('Draft not found.', 404);
    const gate = checkPublishable({ draft_id: d.id, graphic_id: b.graphic_id ? +b.graphic_id : null });
    return { gate: { ok: gate.ok, problems: gate.problems }, targets: (b.targets || []).map(t => { const a = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(+t.account_id); if (!a) return { account_id: +t.account_id, issues: [{ severity: 'error', message: 'Account not found.' }] }; const c = composeCaption(d, t.caption ?? defaultCaption(d, a.platform)); return { account_id: a.id, final_caption: c.caption, issues: [...validateTarget(a, c.caption, gate.graphic), ...(c.linked ? [] : [{ severity: 'warn', message: 'No article link: publish the article on the website first (and set PUBLIC_BASE_URL) so the caption can link to it.' }])] }; }) };
  }],
  ['POST', /^\/api\/posts$/, ({ body }) => ({ id: createPost(body) })],
  ['GET', /^\/api\/posts$/, ({ url }) => { const st = url.searchParams.get('state'); return db.prepare(`SELECT * FROM posts ${st ? 'WHERE state=?' : ''} ORDER BY COALESCE(scheduled_at,created_at) DESC LIMIT 100`).all(...(st ? [st] : [])).map(postView); }],
  ['GET', /^\/api\/posts\/(\d+)$/, ({ m }) => { const p = db.prepare('SELECT * FROM posts WHERE id=?').get(+m[1]); if (!p) throw new Refusal('Post not found.', 404); return postView(p); }],
  ['POST', /^\/api\/posts\/(\d+)\/approve$/, ({ m }) => { approvePost(+m[1]); return { ok: true }; }],
  ['POST', /^\/api\/posts\/(\d+)\/schedule$/, ({ m, body }) => ({ scheduled_at: schedulePost(+m[1], body.scheduled_at || null) })],
  ['POST', /^\/api\/posts\/(\d+)\/cancel$/, ({ m }) => { cancelPost(+m[1]); return { ok: true }; }],
  ['POST', /^\/api\/post-targets\/(\d+)\/retry$/, ({ m, body }) => { retryTarget(+m[1], { confirmUnknown: !!body.confirm }); return { ok: true }; }],
  ['POST', /^\/api\/post-targets\/(\d+)\/mark-published$/, ({ m, body }) => { markPublishedManually(+m[1], body.url); return { ok: true }; }],
];
R.push(
  ['GET', /^\/api\/social-drafts$/, () => SD.listSocialDrafts()],
  ['POST', /^\/api\/social-drafts\/(\d+)\/approve$/, ({ m }) => { SD.approve(+m[1]); return { ok: true }; }],
  ['POST', /^\/api\/social-drafts\/(\d+)\/reject$/, ({ m, body }) => { SD.reject(+m[1], body.reason); return { ok: true }; }],
  ['POST', /^\/api\/social-drafts\/(\d+)\/regenerate$/, async ({ m }) => { await SD.regenerate(+m[1]); return { ok: true }; }],
  ['PUT', /^\/api\/social-drafts\/(\d+)$/, ({ m, body }) => { SD.editCaption(+m[1], body.caption); return { ok: true }; }],
  ['POST', /^\/api\/social-drafts\/(\d+)\/deliver$/, ({ m, body }) => ({ scheduled_at: SD.deliver(+m[1], (body.account_ids || []).map(Number)) })],
);
export async function socialRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    try { const r = await fn({ m, url, body: method === 'GET' || method === 'DELETE' ? {} : await readBody(req) }); return { code: 200, body: r }; }
    catch (e) { if (e instanceof Refusal) return { code: e.status, body: { error: e.message, problems: e.problems, issues: e.issues, missingEnv: e.missingEnv, note: e.note } }; throw e; }
  }
  return null;
}
