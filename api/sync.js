// Masroufi cloud sync — Vercel Serverless Function
// Storage: Upstash Redis (Vercel → Storage → "Upstash for Redis", connected to this project).
// No accounts: each user holds a secret 20-char sync code. Only its SHA-256 hash is used as the key.
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CODE_RE = /^[A-HJ-NP-Z2-9]{20}$/;
const MAX_BYTES = 3 * 1024 * 1024;
const TTL = 60 * 60 * 24 * 730; // data kept 2 years after last sync

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Atomic compare-and-set on the revision number
const CAS = `
local rev = tonumber(redis.call('GET', KEYS[1]) or '0')
if rev ~= tonumber(ARGV[1]) then return {0, rev} end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[1], rev + 1, 'EX', ARGV[3])
return {1, rev + 1}`;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return send(res, 503, { error: 'storage_not_configured' });

  const code = String(req.headers['x-sync-code'] || '').toUpperCase();
  if (!CODE_RE.test(code)) return send(res, 400, { error: 'bad_code' });
  const id = crypto.createHash('sha256').update('masroufi:' + code).digest('hex');
  const kRev = 'm:' + id + ':rev', kDoc = 'm:' + id + ':doc';

  try {
    if (req.method === 'GET') {
      const [rev, doc] = await redis(['MGET', kRev, kDoc]);
      return send(res, 200, { rev: Number(rev || 0), data: doc ? JSON.parse(doc) : null });
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const baseRev = Number(body.baseRev);
      if (!Number.isInteger(baseRev) || baseRev < 0 || !body.data || !Array.isArray(body.data.expenses))
        return send(res, 400, { error: 'bad_body' });
      const doc = JSON.stringify(body.data);
      if (Buffer.byteLength(doc) > MAX_BYTES) return send(res, 413, { error: 'too_large' });

      const [ok, rev] = await redis(['EVAL', CAS, '2', kRev, kDoc, String(baseRev), doc, String(TTL)]);
      if (ok === 1) return send(res, 200, { rev: Number(rev) });
      const cur = await redis(['GET', kDoc]);
      return send(res, 409, { rev: Number(rev), data: cur ? JSON.parse(cur) : null });
    }

    if (req.method === 'DELETE') {
      await redis(['DEL', kRev, kDoc]);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    console.error('sync error', e);
    return send(res, 500, { error: 'server_error' });
  }
};
