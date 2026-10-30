// Mini App backend: who is asking (signed by Telegram), their invoices, CSV export.

const enc = new TextEncoder();
const MAX_AGE = 86_400; // seconds an initData stays valid

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Checks Telegram's signature on initData. Returns the user, or null if it isn't genuine. */
export async function verifyInitData(initData, botToken, nowSeconds = Date.now() / 1000) {
  const params = new URLSearchParams(String(initData || ''));
  const hash = params.get('hash');
  if (!hash || !botToken) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const signed = hex(await hmac(await hmac('WebAppData', botToken), check));
  if (signed !== hash) return null;
  if (nowSeconds - Number(params.get('auth_date')) > MAX_AGE) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

export const toRow = (i) => ({
  id: i.id, number: i.number, client: i.client_name, email: i.client_email, description: i.description,
  amount: i.amount_cents / 100, currency: i.currency, due: i.due_date, status: i.status,
  created: new Date(i.created_at).toISOString().slice(0, 10),
  paid: i.paid_at ? new Date(i.paid_at).toISOString().slice(0, 10) : null, payUrl: i.pay_url,
});

// A leading = + - @ would run as a formula when the accountant opens the file.
const cell = (v) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows) {
  const cols = ['number', 'client', 'email', 'description', 'amount', 'currency', 'status', 'created', 'due', 'paid'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}
