// AES-256-GCM for tokens at rest. The key lives in .env (TOKEN_KEY), never in the database, API responses or logs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const key = () => { const k = process.env.TOKEN_KEY; if (!/^[0-9a-f]{64}$/i.test(k ?? '')) throw new Error('TOKEN_KEY is missing or not 64 hex chars'); return Buffer.from(k, 'hex'); };
export const encrypt = plain => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv), ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
export const decrypt = enc => { if (!enc?.startsWith('v1:')) throw new Error('unrecognised token format'); const b = Buffer.from(enc.slice(3), 'base64'), d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
