// PayPal REST client: OAuth2 client credentials, Invoicing v2 and webhook signature checks.
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/ · https://developer.paypal.com/api/rest/webhooks/

export class PayPalError extends Error {
  constructor(status, body) {
    const issue = body?.details?.[0]?.issue || body?.name || body?.error || 'ERROR';
    const desc = body?.details?.[0]?.description || body?.message || body?.error_description || '';
    super(`PayPal ${status} ${issue}${desc ? `: ${desc}` : ''}`);
    this.status = status;
    this.issue = issue;
    this.body = body;
  }
}

/** 350 → "350.00"; 12.5 → "12.50". Amounts travel as cents internally. */
export const money = (cents) => (cents / 100).toFixed(2);

export function createPayPal({ base, clientId, secret, webhookId }, fetchFn = (...a) => fetch(...a)) {
  let token = null; // { value, exp } cached per isolate

  async function accessToken() {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const res = await fetchFn(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, body);
    token = { value: body.access_token, exp: Date.now() + (body.expires_in || 300) * 1000 };
    return token.value;
  }

  async function request(method, path, payload, { raw = false, requestId = null } = {}) {
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    };
    if (requestId) headers['paypal-request-id'] = requestId; // idempotency: a retried send never bills twice
    const res = await fetchFn(`${base}${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (raw && res.ok) return res;
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new PayPalError(res.status, body);
    return body;
  }

  /** The invoice id lives in the body (return=representation) or at the end of the self link. */
  const idOf = (body) => body?.id || String(body?.href || body?.links?.find((l) => l.rel === 'self')?.href || '').split('/').pop() || null;

  return {
    accessToken,

    /**
     * Creates a draft invoice. `d` = { invoicer, client_name, client_email, items:[{name, cents, qty}], currency, due_date, note, number }
     * Returns { id, number, status }.
     */
    async createInvoice(d, requestId) {
      const [given, ...rest] = String(d.client_name || '').trim().split(/\s+/);
      const body = {
        detail: {
          currency_code: d.currency,
          ...(d.number ? { invoice_number: d.number } : {}),
          invoice_date: d.invoice_date,
          ...(d.note ? { note: d.note } : {}),
          payment_term: d.due_date ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: d.due_date } : { term_type: 'DUE_ON_RECEIPT' },
        },
        ...(d.invoicer ? { invoicer: { business_name: d.invoicer } } : {}),
        primary_recipients: [{
          billing_info: {
            ...(given ? { name: { given_name: given, ...(rest.length ? { surname: rest.join(' ') } : {}) } } : {}),
            email_address: d.client_email,
          },
        }],
        items: d.items.map((it) => ({
          name: it.name.slice(0, 200),
          quantity: String(it.qty || 1),
          unit_amount: { currency_code: d.currency, value: money(it.cents) },
          unit_of_measure: 'QUANTITY',
        })),
      };
      const out = await request('POST', '/v2/invoicing/invoices', body, { requestId });
      return { id: idOf(out), number: out?.detail?.invoice_number || null, status: out?.status || 'DRAFT' };
    },

    /** Sends the invoice by email from PayPal. Returns the payer link when PayPal gives it. */
    async sendInvoice(id, { subject, note } = {}) {
      const out = await request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
        send_to_invoicer: false,
        send_to_recipient: true,
        ...(subject ? { subject } : {}),
        ...(note ? { note } : {}),
      }, { requestId: `send-${id}` });
      return { payUrl: out?.href || out?.links?.find((l) => l.rel === 'payer-view')?.href || null };
    },

    getInvoice: (id) => request('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`),

    remindInvoice: (id, { subject, note } = {}) => request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      send_to_invoicer: false,
      send_to_recipient: true,
      ...(subject ? { subject } : {}),
      ...(note ? { note } : {}),
    }),

    cancelInvoice: (id, { note } = {}) => request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      send_to_invoicer: false,
      send_to_recipient: true,
      ...(note ? { note } : {}),
    }),

    /**
     * QR code for paying in person. PayPal answers with the PNG base64-encoded, sometimes wrapped
     * in a multipart body; we accept both and return raw PNG bytes.
     */
    async qrCode(id, size = 400) {
      const res = await request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/generate-qr-code`, { width: size, height: size, action: 'pay' }, { raw: true });
      return decodeQr(await res.text());
    },

    /** Verifies a webhook with PayPal (signature, cert and our webhook id). */
    async verifyWebhook(headers, event) {
      if (!webhookId) return false;
      const h = (k) => headers.get(k);
      const out = await request('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event,
      });
      return out?.verification_status === 'SUCCESS';
    },

    /** Registers our webhook URL for invoice events (run once from /setup). Returns its id. */
    async ensureWebhook(url) {
      const list = await request('GET', '/v1/notifications/webhooks');
      const found = (list.webhooks || []).find((w) => w.url === url);
      if (found) return found.id;
      const out = await request('POST', '/v1/notifications/webhooks', {
        url,
        event_types: ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED'].map((name) => ({ name })),
      });
      return out.id;
    },
  };
}

/** PNG bytes from PayPal's QR response (plain base64 or a multipart part holding base64). */
export function decodeQr(text) {
  const candidates = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]{100,}$/.test(l));
  const b64 = candidates.length ? candidates.join('') : String(text).replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('QR: not a PNG');
  return bytes;
}
