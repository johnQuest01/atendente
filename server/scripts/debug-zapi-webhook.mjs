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
  `SELECT label, webhook_token, base_url, secrets_encrypted FROM whatsapp_connections WHERE is_active`,
);
const row = rows[0];
const secrets = JSON.parse(decryptSecret(row.secrets_encrypted, process.env.ENCRYPTION_KEY));
console.log('label', row.label);
console.log('base_url_db', row.base_url);
console.log('instanceId', secrets.instanceId);
console.log('token_prefix', String(secrets.token || '').slice(0, 8));
console.log('hasClientToken', Boolean(secrets.clientToken));
console.log('clientToken_prefix', String(secrets.clientToken || '').slice(0, 8));
console.log('env_instance', process.env.ZAPI_INSTANCE_ID);
console.log('env_base', process.env.ZAPI_BASE_URL);
console.log('same_instance', secrets.instanceId === process.env.ZAPI_INSTANCE_ID);

const webhook = `https://mayra-api.fly.dev/webhook/whatsapp/${row.webhook_token}`;
const bases = [
  row.base_url,
  process.env.ZAPI_BASE_URL,
  'https://api.z-api.io/instances',
  'https://api.z-api.io',
].filter(Boolean);

const paths = [
  'update-every-webhooks',
  'update-webhook-received',
  'update-webhook-delivery',
  'update-webhook-disconnected',
  'update-webhook-message-status',
];

for (const base of [...new Set(bases)]) {
  for (const path of paths) {
    const url = `${base.replace(/\/+$/, '')}/${secrets.instanceId}/token/${secrets.token}/${path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': secrets.clientToken || process.env.ZAPI_CLIENT_TOKEN || '',
      },
      body: JSON.stringify({ value: webhook, notifySentByMe: true }),
    });
    const text = await res.text();
    console.log(`\n${res.status} ${path} @ ${base}`);
    console.log(text.slice(0, 200));
  }
}

await client.end();
