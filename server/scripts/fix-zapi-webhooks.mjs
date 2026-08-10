/**
 * Aponta os webhooks da Z-API para a URL com token.
 * Preferência: credenciais da conexão no banco; fallback: ZAPI_* do .env/Fly.
 */
import pg from 'pg';
import crypto from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!DATABASE_URL || !PUBLIC_BASE_URL) {
  console.error('Faltam DATABASE_URL ou PUBLIC_BASE_URL');
  process.exit(1);
}

function resolveKey(raw) {
  for (const enc of ['base64', 'hex']) {
    const buf = Buffer.from(raw, enc);
    if (buf.length === 32) return buf;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function decryptSecret(payload, keyRaw) {
  const key = resolveKey(keyRaw);
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('formato inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function configure({ instanceId, token, clientToken, baseUrl, url, label }) {
  const base = (baseUrl || 'https://api.z-api.io').replace(/\/+$/, '');
  const endpoint = `${base}/instances/${instanceId}/token/${token}/update-every-webhooks`;
  console.log(`→ ${label}: ${url}`);
  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(clientToken ? { 'Client-Token': clientToken } : {}),
    },
    body: JSON.stringify({ value: url, notifySentByMe: true }),
  });
  const text = await res.text();
  console.log(`  HTTP ${res.status}: ${text.slice(0, 400)}`);
  return res.ok;
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(
  `SELECT id, label, webhook_token, secrets_encrypted, base_url
     FROM whatsapp_connections
    WHERE is_active = true AND provider = 'zapi'
    ORDER BY updated_at DESC`,
);

let okAny = false;
for (const row of rows) {
  const url = `${PUBLIC_BASE_URL}/webhook/whatsapp/${row.webhook_token}`;
  let secrets = {};
  if (row.secrets_encrypted && ENCRYPTION_KEY) {
    try {
      secrets = JSON.parse(decryptSecret(row.secrets_encrypted, ENCRYPTION_KEY));
    } catch (e) {
      console.warn(`Decrypt falhou para ${row.label}: ${e.message} — usando ZAPI_* do env`);
    }
  }
  const instanceId = secrets.instanceId || process.env.ZAPI_INSTANCE_ID;
  const token = secrets.token || process.env.ZAPI_TOKEN;
  const clientToken = secrets.clientToken || process.env.ZAPI_CLIENT_TOKEN;
  const baseUrl = row.base_url || process.env.ZAPI_BASE_URL || 'https://api.z-api.io';
  if (!instanceId || !token) {
    console.error(`Credenciais incompletas: ${row.label}`);
    continue;
  }
  okAny = (await configure({ instanceId, token, clientToken, baseUrl, url, label: row.label })) || okAny;
}

await client.end();
process.exit(okAny ? 0 : 1);
