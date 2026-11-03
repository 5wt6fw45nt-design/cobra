import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { d1Shim } from '../scripts/d1-shim.js';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { createPayPal, decodeQr, PayPalError } from '../src/paypal.js';
import { budgetedAi, cleanEmail, normalizeDraft, transcribe } from '../src/ai.js';
import { verifyInitData, toCsv, toRow } from '../src/webapp.js';

const T0 = Date.UTC(2026, 9, 27, 10, 0); // 27 Oct 2026
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(120).fill(1)]);

// --- AI helpers ---

test('spoken emails become real emails', () => {
  assert.equal(cleanEmail('marta arroba gmail punto com'), 'marta@gmail.com');
  assert.equal(cleanEmail('John at Example dot co dot uk'), 'john@example.co.uk');
  assert.equal(cleanEmail(' <ana.lópez@correo.es>. '), 'ana.lopez@correo.es');
  assert.equal(cleanEmail('no tengo su correo'), null);
  assert.equal(cleanEmail(null), null);
});

test('drafts are normalized: cents, qty, currency, due date', () => {
  const ctx = { currency: 'EUR', today: '2026-10-27' };
  const d = normalizeDraft({ client_name: 'Marta <b>', client_email: 'marta arroba gmail punto com', items: [{ name: 'Logo', amount: '350', qty: 1 }, { name: 'Hours', amount: 40, qty: '2' }, { name: 'Free', amount: 0 }], currency: 'usd', due_days: 15 }, ctx);
  assert.deepEqual(d, {
    client_name: 'Marta b', client_email: 'marta@gmail.com',
    items: [{ name: 'Logo', cents: 35000, qty: 1 }, { name: 'Hours', cents: 4000, qty: 2 }],
    currency: 'USD', due_date: '2026-11-11', note: null,
  });
  assert.equal(normalizeDraft({ items: [{ amount: '1.500' }], currency: 'XYZ', due_date: '2020-01-01' }, ctx).items[0].cents, 150000);
  assert.equal(normalizeDraft({ items: [{ amount: 9 }], currency: 'XYZ', due_date: '2020-01-01' }, ctx).currency, 'EUR');
  assert.equal(normalizeDraft({ items: [{ amount: 9 }], due_date: '2020-01-01' }, ctx).due_date, null); // past dates are dropped
});

// --- PayPal client ---

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, headers: init.headers, body: init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body });
    const h = routes[`${init.method} ${path}`] ?? routes[path];
    if (!h) return new Response('{"name":"NOT_FOUND"}', { status: 404 });
    const out = typeof h === 'function' ? h(calls.at(-1)) : h;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

test('PayPal: OAuth token is cached and the invoice body is what Invoicing v2 expects', async () => {
  const { fn, calls } = fakeFetch({
    '/v1/oauth2/token': { access_token: 'A21', expires_in: 3600 },
    'POST /v2/invoicing/invoices': { id: 'INV2-AAAA', status: 'DRAFT', detail: { invoice_number: '0001' } },
    'POST /v2/invoicing/invoices/INV2-AAAA/send': { href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA' },
  });
  const pp = createPayPal({ base: 'https://api-m.sandbox.paypal.com', clientId: 'id', secret: 'sec' }, fn);
  const inv = await pp.createInvoice({
    client_name: 'Marta García López', client_email: 'marta@gmail.com', currency: 'EUR', invoice_date: '2026-10-27', due_date: '2026-11-11',
    invoicer: 'Augusto Design', note: 'Gracias', items: [{ name: 'Logo', cents: 35000, qty: 1 }],
  }, 'req-1');
  assert.deepEqual(inv, { id: 'INV2-AAAA', number: '0001', status: 'DRAFT' });
  const sent = await pp.sendInvoice('INV2-AAAA');
  assert.match(sent.payUrl, /INV2-AAAA/);

  assert.equal(calls.filter((c) => c.path === '/v1/oauth2/token').length, 1, 'token fetched once');
  assert.equal(calls[0].headers.authorization, `Basic ${btoa('id:sec')}`);
  const create = calls.find((c) => c.path === '/v2/invoicing/invoices');
  assert.equal(create.headers['paypal-request-id'], 'req-1');
  assert.equal(create.headers.authorization, 'Bearer A21');
  assert.deepEqual(create.body, {
    detail: { currency_code: 'EUR', invoice_date: '2026-10-27', note: 'Gracias', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-11' } },
    invoicer: { business_name: 'Augusto Design' },
    primary_recipients: [{ billing_info: { name: { given_name: 'Marta', surname: 'García López' }, email_address: 'marta@gmail.com' } }],
    items: [{ name: 'Logo', quantity: '1', unit_amount: { currency_code: 'EUR', value: '350.00' }, unit_of_measure: 'QUANTITY' }],
  });
  const send = calls.find((c) => c.path.endsWith('/send'));
  assert.deepEqual(send.body, { send_to_invoicer: false, send_to_recipient: true });
});

test('PayPal: errors carry the issue; the id is read from the self link too', async () => {
  const { fn } = fakeFetch({
    '/v1/oauth2/token': { access_token: 'T', expires_in: 3600 },
    'POST /v2/invoicing/invoices': () => new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INVALID_EMAIL', description: 'bad email' }] }), { status: 422 }),
    'GET /v2/invoicing/invoices/INV2-B': { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-B', status: 'SENT' },
  });
  const pp = createPayPal({ base: 'https://x.test', clientId: 'a', secret: 'b' }, fn);
  await assert.rejects(() => pp.createInvoice({ client_name: 'A', client_email: 'x', currency: 'USD', invoice_date: '2026-10-27', items: [{ name: 'a', cents: 100, qty: 1 }] }),
    (e) => e instanceof PayPalError && e.status === 422 && e.issue === 'INVALID_EMAIL');
  assert.equal((await pp.getInvoice('INV2-B')).status, 'SENT');
});

test('PayPal: QR comes back as PNG bytes from plain or multipart base64', () => {
  const b64 = Buffer.from(PNG).toString('base64');
  assert.deepEqual(decodeQr(b64), PNG);
  assert.deepEqual(decodeQr(`--abc\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--abc--`), PNG);
  assert.throws(() => decodeQr(Buffer.from('hello world, this is not an image at all, sorry, not a png either, nope nope nope nope nope nope').toString('base64')));
});

test('PayPal: webhook verification sends our webhook id and checks SUCCESS', async () => {
  const { fn, calls } = fakeFetch({
    '/v1/oauth2/token': { access_token: 'T', expires_in: 3600 },
    '/v1/notifications/verify-webhook-signature': { verification_status: 'SUCCESS' },
  });
  const pp = createPayPal({ base: 'https://x.test', clientId: 'a', secret: 'b', webhookId: 'WH-1' }, fn);
  const headers = new Headers({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'https://api.paypal.com/cert' });
  assert.equal(await pp.verifyWebhook(headers, { id: 'WH-EV' }), true);
  assert.equal(calls.at(-1).body.webhook_id, 'WH-1');
  assert.deepEqual(calls.at(-1).body.webhook_event, { id: 'WH-EV' });
  assert.equal(await createPayPal({ base: 'https://x.test', clientId: 'a', secret: 'b' }, fn).verifyWebhook(headers, {}), false, 'no webhook id → never trusted');
});

// --- Conversation ---

// What Llama would return for each sentence
const fakeNlu = async (_ai, text, ctx) => {
  const n = text.toLowerCase();
  if (/quien me debe|who owes/.test(n.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return { intent: 'debtors', draft: null, reply: '' };
  if (/cuanto he cobrado/.test(n.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return { intent: 'summary', draft: null, reply: '' };
  if (/marta/.test(n)) {
    const email = /marta@/.test(n) ? 'marta@gmail.com' : null;
    return { intent: 'invoice', lang: /^bill/.test(n) ? 'en' : /^factura/.test(n) ? 'es' : null, reply: '', draft: normalizeDraft({ client_name: 'Marta García', client_email: email, items: [{ name: 'Diseño del logo', amount: 350 }], due_days: 15 }, ctx) };
  }
  return { intent: 'chat', draft: null, reply: 'Hola 👋' };
};

function setup({ paidStatus = 'SENT' } = {}) {
  const cfg = { ...loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' }) };
  const db = createDb(d1Shim());
  const sent = [];
  let mid = 0;
  const api = {
    async call(method, params) {
      if (method === 'sendMessage') { sent.push(params); return { message_id: ++mid }; }
      if (method === 'editMessageText') { sent.push({ ...params, edited: true }); return true; }
      if (method === 'getFile') return { file_path: 'voice/1.oga' };
      return true;
    },
    async sendPhotoBytes(chatId, bytes, caption) { sent.push({ chat_id: chatId, photo: bytes.length, text: caption }); return {}; },
    fileUrl: (p) => `https://files/${p}`,
  };
  const pp = { calls: [], status: paidStatus };
  const paypal = {
    async createInvoice(d, reqId) { pp.calls.push(['create', d, reqId]); return { id: `INV2-${pp.calls.length}`, number: '0001', status: 'DRAFT' }; },
    async sendInvoice(id) { pp.calls.push(['send', id]); return { payUrl: `https://pay/${id}` }; },
    async getInvoice(id) { pp.calls.push(['get', id]); return { id, status: pp.status }; },
    async remindInvoice(id, o) { pp.calls.push(['remind', id, o]); return {}; },
    async recordPayment(id, o) { pp.calls.push(['pay', id, o]); return {}; },
    async qrCode(id) { pp.calls.push(['qr', id]); return PNG; },
  };
  let now = T0;
  const bot = createBot({
    api, db, cfg, paypal, clock: () => now,
    nlu: fakeNlu,
    fixer: async (_ai, d, text) => ({ ...d, items: d.items.map((it) => ({ ...it, cents: /400/.test(text) ? 40000 : it.cents })) }),
    reminderWriter: async (_ai, inv) => `Hola ${inv.client_name}, te recuerdo la factura.`,
    stt: async () => ({ text: 'Factura a Marta 350 euros por el logo', seconds: 5 }),
    http: async () => new Response(new Uint8Array([1, 2, 3])),
  });
  const ME = 42;
  const from = { id: ME, first_name: 'Augusto', language_code: 'es' };
  const msg = (text, extra = {}) => bot.handleUpdate({ message: { from, chat: { id: ME, type: 'private' }, text, ...extra } });
  const tap = (data, message_id = 1) => bot.handleUpdate({ callback_query: { id: 'c', from, data, message: { message_id, chat: { id: ME } } } });
  const last = () => sent.at(-1);
  const buttons = (m = last()) => (m.reply_markup?.inline_keyboard || []).flat();
  return { cfg, db, bot, sent, pp, msg, tap, last, buttons, ME, at: (t) => (now = t) };
}

test('voice/text → draft with buttons → send → PayPal invoice, client remembered', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros por el logo');
  assert.match(s.last().text, /Borrador de factura/);
  assert.match(s.last().text, /Marta García.*marta@gmail\.com/);
  assert.match(s.last().text, /350,00\s€/);
  assert.match(s.last().text, /11 nov 2026/);
  const send = s.buttons().find((b) => b.callback_data.startsWith('send:'));
  assert.ok(send, 'send button');
  assert.equal(s.pp.calls.length, 0, 'nothing reaches PayPal before the tap');

  await s.tap(send.callback_data);
  assert.deepEqual(s.pp.calls.map((c) => c[0]), ['create', 'send']);
  const [, d, reqId] = s.pp.calls[0];
  assert.equal(reqId, 'cobra-draft-1');
  assert.equal(d.invoicer, 'Augusto');
  assert.equal(d.invoice_date, '2026-10-27');
  assert.match(s.last().text, /Factura enviada/);
  assert.ok(s.buttons().some((b) => b.url === 'https://pay/INV2-1'));

  // Next time the email comes from the client book
  await s.msg('Otra a Marta 350 por el logo');
  assert.match(s.last().text, /marta@gmail\.com/);
  assert.ok(s.buttons().some((b) => b.callback_data.startsWith('send:')));
});

test('a missing email is asked for, spoken emails are understood', async () => {
  const s = setup();
  await s.msg('Factura a Marta 350 por el logo');
  assert.match(s.last().text, /correo de Marta García/);
  assert.ok(!s.buttons().some((b) => b.callback_data.startsWith('send:')), 'cannot send without email');
  await s.msg('esto no');
  assert.equal(s.last().text, 'Hola 👋'); // a sentence = they moved on: handled as a new message
  await s.msg('Factura a Marta 350 por el logo');
  await s.msg('martaarroba');
  assert.match(s.last().text, /no parece un correo/);
  await s.msg('marta arroba gmail punto com');
  assert.match(s.last().text, /marta@gmail\.com/);
  assert.ok(s.buttons().some((b) => b.callback_data.startsWith('send:')));
});

test('fix a draft by voice/text, and cancel', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  const id = s.buttons().find((b) => b.callback_data.startsWith('fix:')).callback_data.split(':')[1];
  await s.tap(`fix:${id}`);
  assert.match(s.last().text, /qué cambio/);
  await s.msg('que sean 400');
  assert.match(s.last().text, /400,00\s€/);
  await s.tap(`x:${id}`);
  assert.match(s.last().text, /descartado/);
  await s.tap(`send:${id}`);
  assert.match(s.last().text, /ya no está/);
  assert.equal(s.pp.calls.length, 0);
});

test('PayPal webhook: paid → instant alert, retries ignored, unknown invoices ignored', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await s.tap(s.buttons()[0].callback_data);
  const before = s.sent.length;
  const ev = { id: 'WH-1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-1', status: 'PAID' } } };
  assert.equal(await s.bot.handlePayPalEvent(ev), 'paid');
  assert.match(s.last().text, /Marta García te ha pagado 350,00\s€/);
  assert.equal(s.last().chat_id, s.ME);
  assert.equal(await s.bot.handlePayPalEvent(ev), 'duplicate');
  assert.equal(await s.bot.handlePayPalEvent({ ...ev, id: 'WH-2' }), 'unchanged');
  assert.equal(await s.bot.handlePayPalEvent({ id: 'WH-3', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-OTHER' } }), 'unknown-invoice');
  assert.equal(s.sent.length, before + 1, 'exactly one alert');
  assert.equal((await s.db.getInvoice(1, s.ME)).status, 'PAID');
});

test('who owes me → reminder written by AI, previewed, then sent through PayPal; QR', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await s.tap(s.buttons()[0].callback_data);
  s.at(T0 + 20 * 86_400_000); // 16 Nov: 5 days overdue

  await s.msg('💸 Quién me debe');
  assert.match(s.last().text, /1 factura sin pagar/);
  assert.match(s.last().text, /vencida hace 5 días/);
  const rem = s.buttons().find((b) => b.callback_data.startsWith('rem:'));
  await s.tap(rem.callback_data);
  assert.match(s.last().text, /Recordatorio para Marta García/);
  assert.ok(!s.pp.calls.some((c) => c[0] === 'remind'), 'not sent before confirming');
  await s.tap(s.buttons().find((b) => b.callback_data.startsWith('remok:')).callback_data);
  const remind = s.pp.calls.find((c) => c[0] === 'remind');
  assert.equal(remind[1], 'INV2-1');
  assert.match(remind[2].note, /te recuerdo/);
  assert.match(s.last().text, /Recordatorio enviado/);

  await s.tap('qr:1');
  assert.equal(s.last().photo, PNG.length);
  assert.match(s.last().text, /Escanea para pagar/);

  await s.msg('💸 Quién me debe');
  assert.match(s.last().text, /recordada/);
});

test('who owes me double-checks PayPal, so a missed webhook still shows as paid', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await s.tap(s.buttons()[0].callback_data);
  s.pp.status = 'PAID';
  await s.msg('¿quién me debe?');
  assert.match(s.last().text, /nadie te debe nada/);
  await s.msg('¿cuánto he cobrado este mes?');
  assert.match(s.last().text, /cobrado <b>350,00\s€<\/b> \(1\)/);
});

test('voice notes are transcribed and capped', async () => {
  const s = setup();
  await s.msg(undefined, { voice: { file_id: 'f', duration: 5 } });
  assert.match(s.last().text, /Borrador|correo de Marta/);
  await s.msg(undefined, { voice: { file_id: 'f', duration: 9999 } });
  assert.match(s.last().text, /un poco largo/);
});

test('replies follow the language of the message, and it sticks', async () => {
  const s = setup();
  await s.msg('Bill Marta, marta@gmail.com, 350 for the logo');
  assert.match(s.last().text, /Invoice draft/);
  assert.equal((await s.db.getUser(s.ME)).lang, 'en');
  await s.msg('Marta 350');
  assert.match(s.last().text, /What's|Invoice draft/, 'too short to tell: stays in English');
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  assert.match(s.last().text, /Borrador de factura/);
  assert.equal((await s.db.getUser(s.ME)).lang, 'es');
});

test('Whisper is left to detect the language', async () => {
  let input;
  await transcribe({ run: async (_m, i) => { input = i; return { text: 'hi' }; } }, new Uint8Array([1]));
  assert.equal('language' in input, false);
});

test('sandbox: simulate a payment through PayPal; only the owner, never in live mode', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await s.tap(s.buttons()[0].callback_data);
  assert.ok(s.buttons().some((b) => b.callback_data === 'sim:1'), 'offered after sending');

  await s.bot.handleUpdate({ callback_query: { id: 'c', from: { id: 99, first_name: 'Eve' }, data: 'sim:1', message: { message_id: 1, chat: { id: 99 } } } });
  assert.ok(!s.pp.calls.some((c) => c[0] === 'pay'), 'someone else cannot pay it');

  await s.tap('sim:1');
  const pay = s.pp.calls.find((c) => c[0] === 'pay');
  assert.deepEqual(pay.slice(1), ['INV2-1', { cents: 35000, currency: 'EUR', date: '2026-10-27' }]);
  assert.match(s.last().text, /Pago de prueba/);

  const live = setup();
  live.cfg.paypal.sandbox = false;
  await live.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await live.tap(live.buttons()[0].callback_data);
  assert.ok(!live.buttons().some((b) => b.callback_data === 'sim:1'), 'no button in live mode');
  await live.tap('sim:1');
  assert.ok(!live.pp.calls.some((c) => c[0] === 'pay'), 'ignored in live mode');
});

test('the clock warns once about overdue invoices and catches missed webhooks', async () => {
  const s = setup();
  await s.msg('Factura a Marta, marta@gmail.com, 350 euros');
  await s.tap(s.buttons()[0].callback_data);
  const before = s.sent.length;
  assert.equal(await s.bot.tick(T0 + 3_600_000), 'done');
  assert.equal(await s.bot.tick(T0 + 3_600_000), 'idle');
  assert.equal(s.sent.length, before, 'not due yet: nothing to say');

  const late = T0 + 20 * 86_400_000;
  await s.bot.tick(late);
  assert.match(s.last().text, /Marta García aún no ha pagado/);
  assert.ok(s.buttons().some((b) => b.callback_data === 'rem:1'));
  const warned = s.sent.length;
  await s.bot.tick(late + 3_600_000);
  assert.equal(s.sent.length, warned, 'only one warning per invoice');

  s.pp.status = 'PAID';
  await s.bot.tick(late + 7_200_000);
  assert.match(s.last().text, /te ha pagado/);
  const paid = s.sent.length;
  await s.bot.tick(late + 10_800_000);
  assert.equal(s.sent.length, paid, 'paid invoices are left alone');
});

async function signInitData(fields, token) {
  const enc = new TextEncoder();
  const mac = async (key, msg) => {
    const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = Buffer.from(await mac(await mac('WebAppData', token), check)).toString('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('Mini App: only initData signed with our token gets in, and it expires', async () => {
  const fields = { auth_date: '1000', query_id: 'q', user: JSON.stringify({ id: 42, first_name: 'Ana & Co' }) };
  const good = await signInitData(fields, 'TOKEN');
  assert.equal((await verifyInitData(good, 'TOKEN', 2000)).id, 42);
  assert.equal(await verifyInitData(good, 'OTHER', 2000), null);
  assert.equal(await verifyInitData(good.replace('42', '43'), 'TOKEN', 2000), null, 'tampered');
  assert.equal(await verifyInitData(good, 'TOKEN', 1000 + 90_000), null, 'expired');
  assert.equal(await verifyInitData('', 'TOKEN', 2000), null);
});

test('CSV: amounts stay numbers, commas are quoted, formulas are defused', () => {
  const row = toRow({ id: 1, number: '0001', client_name: '=HYPERLINK("x")', client_email: 'a@b.c', description: 'Logo, v2', amount_cents: 35050, currency: 'EUR', due_date: null, status: 'PAID', created_at: T0, paid_at: T0, pay_url: null });
  const [head, line] = toCsv([row]).split('\r\n');
  assert.match(head, /^number,client,email/);
  assert.match(line, /^0001,"'=HYPERLINK\(""x""\)",a@b\.c,"Logo, v2",350\.5,EUR,PAID,2026-10-27,,2026-10-27$/);
});

test('the daily AI budget is shared by all users and resets the next day', async () => {
  const kv = new Map();
  const db = { kvGet: async (k) => kv.get(k) ?? null, kvSet: async (k, v) => kv.set(k, String(v)) };
  let now = T0;
  let calls = 0;
  const ai = budgetedAi({ run: async () => ++calls }, db, 2, () => now);
  await ai.run('m', {});
  await ai.run('m', {});
  await assert.rejects(ai.run('m', {}), /budget/);
  assert.equal(calls, 2);
  now += 86_400_000;
  await ai.run('m', {});
  assert.equal(calls, 3);
});

test('settings: language and currency; English users get English', async () => {
  const s = setup();
  await s.msg('⚙️ Ajustes');
  assert.match(s.last().text, /Moneda: EUR/);
  await s.tap('cur:USD');
  assert.match(s.last().text, /Moneda: USD/);
  await s.tap('lang:en');
  assert.match(s.last().text, /Currency: USD/);
  await s.msg('hello');
  assert.equal(s.last().text, 'Hola 👋');
  await s.msg('❓ How it works');
  assert.match(s.last().text, /What I do/);
});
