// Platform adapters. Only the MOCK adapter can publish, and only when SOCIAL_MOCK=1 (tests / dry runs).
// Facebook, Instagram and X are described here (limits, required credentials) but their real API adapters are NOT implemented yet:
// they can never report an account as connected or a post as published.
import { db, now } from './db.js';

export class PublishError extends Error { constructor(message, kind = 'recoverable', retryAfterMs) { super(message); this.kind = kind; this.retryAfterMs = retryAfterMs; } }

// Limits are as generally documented; re-verify against the platform's current docs when each real adapter is written.
export const PLATFORMS = {
  facebook: { label: 'Facebook Page', maxCaption: 63206, needsImage: false, imageFormats: ['png', 'jpeg'], env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'], note: 'Needs a Meta app with page publishing permission and an app review.' },
  instagram: { label: 'Instagram professional account', maxCaption: 2200, maxHashtags: 30, needsImage: true, imageFormats: ['jpeg'], env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'], note: 'Needs a Meta app, a professional account linked to a Facebook Page, and content-publishing permission. JPEG images only.' },
  x: { label: 'X', maxCaption: 280, needsImage: false, imageFormats: ['png', 'jpeg'], env: ['X_CLIENT_ID', 'X_CLIENT_SECRET'], note: 'Needs an X developer app with write access.' },
  mock: { label: 'TEST account (mock — nothing is really posted)', maxCaption: 2200, needsImage: true, imageFormats: ['png', 'jpeg'], env: [], mockOnly: true, note: 'Dry-run target for testing the workflow.' },
};
export const mockEnabled = () => process.env.SOCIAL_MOCK === '1';
export const platformInfo = id => { const p = PLATFORMS[id], missing = p.env.filter(k => !process.env[k]); return { id, ...p, missingEnv: missing, configured: p.mockOnly ? mockEnabled() : false, credentialsPresent: !missing.length && !p.mockOnly, realAdapterImplemented: false }; };

// Test-only simulation tokens in the caption, active only with SOCIAL_MOCK=1:
//   [mock:recoverable] fails the first 2 attempts with a temporary error; [mock:down] always fails temporarily; [mock:permanent]; [mock:auth]; [mock:ratelimit] (retry-after hint)
const mock = {
  idempotent: true,
  async lookup(key) { const r = db.prepare('SELECT * FROM mock_remote WHERE key=?').get(key); return r ? { platformPostId: 'mock_' + r.key.slice(0, 10), url: r.url } : null; },
  async publish({ account, caption, idempotencyKey, attempt }) {
    if (!mockEnabled()) throw new PublishError('Mock adapter is disabled (SOCIAL_MOCK is not 1)', 'permanent');
    if (caption.includes('[mock:permanent]')) throw new PublishError('Platform rejected the post (simulated permanent error)', 'permanent');
    if (caption.includes('[mock:auth]')) throw new PublishError('Access token expired (simulated)', 'auth');
    if (caption.includes('[mock:ratelimit]') && attempt < 2) throw new PublishError('Rate limited (simulated)', 'recoverable', 5);
    if (caption.includes('[mock:down]')) throw new PublishError('Platform unavailable (simulated)', 'recoverable');
    if (caption.includes('[mock:recoverable]') && attempt < 3) throw new PublishError('Temporary platform error (simulated)', 'recoverable');
    const url = `https://mock.invalid/${account.id}/${idempotencyKey.slice(0, 10)}`;
    db.prepare('INSERT OR IGNORE INTO mock_remote(key,account_id,caption,url,at) VALUES(?,?,?,?,?)').run(idempotencyKey, account.id, caption, url, now());
    return { platformPostId: 'mock_' + idempotencyKey.slice(0, 10), url };
  },
};
// Real platforms: honest stubs. They never succeed.
const notImplemented = platform => ({ idempotent: false, async publish() { throw new PublishError(`The ${PLATFORMS[platform].label} adapter is not implemented yet; nothing was posted.`, 'permanent'); } });
export const adapterFor = account => (account.adapter === 'mock' ? mock : notImplemented(account.platform));
