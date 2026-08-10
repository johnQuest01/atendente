const base = process.env.ZAPI_BASE_URL;
const instance = process.env.ZAPI_INSTANCE_ID;
const token = process.env.ZAPI_TOKEN;
const clientToken = process.env.ZAPI_CLIENT_TOKEN;
const webhook =
  'https://mayra-api.fly.dev/webhook/whatsapp/6b5d43ae937e6d2573e25b61f3c7dd78adb49483850c987f';
const url = `${base}/${instance}/token/${token}/update-every-webhooks`;
console.log('PUT', url);
console.log('value', webhook);
const res = await fetch(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    ...(clientToken ? { 'Client-Token': clientToken } : {}),
  },
  body: JSON.stringify({ value: webhook, notifySentByMe: true }),
});
const text = await res.text();
console.log('HTTP', res.status, text.slice(0, 500));
process.exit(res.ok ? 0 : 1);
