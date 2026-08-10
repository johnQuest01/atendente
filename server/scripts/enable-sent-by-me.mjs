import pg from 'pg';
import crypto from 'node:crypto';

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
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows } = await client.query(
  `SELECT webhook_token, base_url, secrets_encrypted FROM whatsapp_connections WHERE is_active LIMIT 1`,
);
const row = rows[0];
const secrets = JSON.parse(decryptSecret(row.secrets_encrypted, process.env.ENCRYPTION_KEY));
const base = (row.base_url || 'https://api.z-api.io/instances').replace(/\/+$/, '');
const webhook = `https://mayra-api.fly.dev/webhook/whatsapp/${row.webhook_token}`;

async function put(path, body) {
  const url = `${base}/${secrets.instanceId}/token/${secrets.token}/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': secrets.clientToken,
    },
    body: JSON.stringify(body),
  });
  console.log(path, res.status, (await res.text()).slice(0, 200));
}

await put('update-every-webhooks', { value: webhook, notifySentByMe: true });
await put('update-notify-sent-by-me', { notifySentByMe: true });
await client.end();
