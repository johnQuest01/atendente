/**
 * Preenche clients.whatsapp_lid via Z-API phone-exists para contatos recentes
 * com número E.164 (não órfãos LID).
 */
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

const { rows: conns } = await client.query(
  `SELECT base_url, secrets_encrypted FROM whatsapp_connections WHERE is_active AND provider='zapi' LIMIT 1`,
);
const secrets = JSON.parse(decryptSecret(conns[0].secrets_encrypted, process.env.ENCRYPTION_KEY));
const base = (conns[0].base_url || 'https://api.z-api.io/instances').replace(/\/+$/, '');

const { rows: clients } = await client.query(
  `SELECT id, phone, name FROM clients
    WHERE whatsapp_lid IS NULL
      AND phone ~ '^[0-9]+$'
      AND length(phone) BETWEEN 10 AND 13
      AND phone LIKE '55%'
    ORDER BY last_contact_at DESC NULLS LAST
    LIMIT 40`,
);

let ok = 0;
for (const c of clients) {
  const url = `${base}/${secrets.instanceId}/token/${secrets.token}/phone-exists/${c.phone}`;
  const res = await fetch(url, {
    headers: { 'Client-Token': secrets.clientToken },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log('fail parse', c.phone, text.slice(0, 80));
    continue;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const lidRaw = row?.lid;
  if (!row?.exists || !lidRaw) {
    console.log('no lid', c.phone, c.name);
    continue;
  }
  const lid = String(lidRaw).replace(/@lid$/i, '').replace(/\D/g, '');
  await client.query(`UPDATE clients SET whatsapp_lid = $2 WHERE id = $1`, [c.id, lid]);
  console.log('linked', c.name || c.phone, '→', lid);
  ok += 1;
  await new Promise((r) => setTimeout(r, 200));
}

console.log('done', ok, '/', clients.length);
await client.end();
