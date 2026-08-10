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

const phone = process.argv[2] || '5511985319989';
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
const url = `${base}/${secrets.instanceId}/token/${secrets.token}/phone-exists/${phone}`;
const res = await fetch(url, { headers: { 'Client-Token': secrets.clientToken } });
const data = await res.json();
console.log(JSON.stringify(data));
const row = Array.isArray(data) ? data[0] : data;
const lid = String(row?.lid || '')
  .replace(/@lid$/i, '')
  .replace(/\D/g, '');
if (!lid) {
  console.log('NO_LID');
  process.exit(1);
}
await client.query(`UPDATE clients SET whatsapp_lid = $2 WHERE phone = $1`, [phone, lid]);
console.log('UPDATED', phone, lid);

// Move msgs from orphan (phone=lid) into Wender's open conversation if any.
const { rows: real } = await client.query(`SELECT id FROM clients WHERE phone = $1`, [phone]);
const { rows: orphan } = await client.query(`SELECT id FROM clients WHERE phone = $1`, [lid]);
if (real[0] && orphan[0] && real[0].id !== orphan[0].id) {
  const { rows: targetConv } = await client.query(
    `SELECT id FROM conversations WHERE client_id = $1 AND status <> 'closed' ORDER BY started_at DESC LIMIT 1`,
    [real[0].id],
  );
  const { rows: orphanConvs } = await client.query(`SELECT id FROM conversations WHERE client_id = $1`, [
    orphan[0].id,
  ]);
  for (const oc of orphanConvs) {
    if (targetConv[0]) {
      await client.query(`UPDATE messages_log SET conversation_id = $2 WHERE conversation_id = $1`, [
        oc.id,
        targetConv[0].id,
      ]);
      await client.query(`DELETE FROM conversations WHERE id = $1`, [oc.id]);
    } else {
      await client.query(`UPDATE conversations SET client_id = $2 WHERE id = $1`, [oc.id, real[0].id]);
    }
  }
  await client.query(`DELETE FROM clients WHERE id = $1`, [orphan[0].id]);
  console.log('MERGED orphan', lid, 'into', phone);
}
await client.end();
