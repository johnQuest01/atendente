#!/bin/sh
set -e
export URL="https://mayra-api.fly.dev/webhook/whatsapp/6b5d43ae937e6d2573e25b61f3c7dd78adb49483850c987f"
export EP="${ZAPI_BASE_URL}/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/update-every-webhooks"
echo "Endpoint: $EP"
echo "Webhook: $URL"
node <<'NODE'
const url = process.env.EP;
const webhook = process.env.URL;
const token = process.env.ZAPI_CLIENT_TOKEN;
fetch(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { 'Client-Token': token } : {}),
  },
  body: JSON.stringify({ value: webhook, notifySentByMe: true }),
}).then(async (r) => {
  const t = await r.text();
  console.log('HTTP', r.status, t.slice(0, 500));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
NODE
