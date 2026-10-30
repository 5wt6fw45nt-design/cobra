// D1 access. Few queries per request (the free plan allows 50 per invocation).

export const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function createDb(d1) {
  const run = (sql, ...a) => d1.prepare(sql).bind(...a).run();
  const first = (sql, ...a) => d1.prepare(sql).bind(...a).first();
  const all = async (sql, ...a) => (await d1.prepare(sql).bind(...a).all()).results;

  return {
    async upsertUser(from, now) {
      const lang = String(from.language_code || '').startsWith('es') ? 'es' : 'en';
      await run(
        `INSERT INTO users (id, first_name, lang, currency, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_seen = excluded.last_seen`,
        from.id, from.first_name ?? null, lang, lang === 'es' ? 'EUR' : 'USD', now, now,
      );
      return first('SELECT * FROM users WHERE id = ?', from.id);
    },
    getUser: (id) => first('SELECT * FROM users WHERE id = ?', id),
    setPending: (id, p) => run('UPDATE users SET pending = ? WHERE id = ?', p, id),
    setLang: (id, lang) => run('UPDATE users SET lang = ? WHERE id = ?', lang, id),
    setCurrency: (id, c) => run('UPDATE users SET currency = ? WHERE id = ?', c, id),
    setBusiness: (id, name) => run('UPDATE users SET business_name = ? WHERE id = ?', name, id),

    clientNames: async (userId) => (await all('SELECT name FROM clients WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30', userId)).map((r) => r.name),
    findClient: (userId, name) => first('SELECT * FROM clients WHERE user_id = ? AND name_key = ?', userId, nameKey(name)),
    saveClient: (userId, name, email, now) => run(
      `INSERT INTO clients (user_id, name_key, name, email, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, name_key) DO UPDATE SET name = excluded.name, email = excluded.email, updated_at = excluded.updated_at`,
      userId, nameKey(name), name, email, now,
    ),

    async addDraft(userId, data, heard, now) {
      const r = await run('INSERT INTO drafts (user_id, data, heard, created_at) VALUES (?, ?, ?, ?)', userId, JSON.stringify(data), heard ?? null, now);
      return r.meta.last_row_id;
    },
    async getDraft(id, userId) {
      const r = await first('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, userId);
      return r ? { ...r, data: JSON.parse(r.data) } : null;
    },
    updateDraft: (id, data) => run('UPDATE drafts SET data = ? WHERE id = ?', JSON.stringify(data), id),
    deleteDraft: (id) => run('DELETE FROM drafts WHERE id = ?', id),
    /** Old drafts nobody confirmed (older than a week) are dropped. */
    pruneDrafts: (userId, before) => run('DELETE FROM drafts WHERE user_id = ? AND created_at < ?', userId, before),

    async addInvoice(i) {
      const r = await run(
        `INSERT INTO invoices (user_id, paypal_id, number, client_name, client_email, description, amount_cents, currency, due_date, status, pay_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?)`,
        i.user_id, i.paypal_id, i.number, i.client_name, i.client_email, i.description, i.amount_cents, i.currency, i.due_date, i.pay_url, i.created_at,
      );
      return r.meta.last_row_id;
    },
    getInvoice: (id, userId) => first('SELECT * FROM invoices WHERE id = ? AND user_id = ?', id, userId),
    invoiceByPayPal: (pid) => first('SELECT * FROM invoices WHERE paypal_id = ?', pid),
    /** Moves an invoice to a final status once. Returns true if it changed. */
    async setStatus(id, status, now) {
      const r = await run(`UPDATE invoices SET status = ?, paid_at = CASE WHEN ? = 'PAID' THEN ? ELSE paid_at END WHERE id = ? AND status <> ?`, status, status, now, id, status);
      return r.meta.changes > 0;
    },
    markReminded: (id, now) => run('UPDATE invoices SET reminded_at = ? WHERE id = ?', now, id),
    unpaid: (userId) => all("SELECT * FROM invoices WHERE user_id = ? AND status = 'SENT' ORDER BY COALESCE(due_date, '9999') ASC, id ASC LIMIT 30", userId),
    openInvoices: (limit) => all("SELECT * FROM invoices WHERE status = 'SENT' ORDER BY COALESCE(due_date, '9999') ASC, id ASC LIMIT ?", limit),
    invoices: (userId, limit = 500) => all('SELECT * FROM invoices WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit),
    /** Totals per currency paid and billed since a timestamp. */
    totals: (userId, since) => all(
      `SELECT currency,
              SUM(CASE WHEN status = 'PAID' AND paid_at >= ? THEN amount_cents ELSE 0 END) AS paid,
              SUM(CASE WHEN status = 'PAID' AND paid_at >= ? THEN 1 ELSE 0 END) AS paid_n,
              SUM(CASE WHEN created_at >= ? AND status <> 'CANCELLED' THEN amount_cents ELSE 0 END) AS billed,
              SUM(CASE WHEN created_at >= ? AND status <> 'CANCELLED' THEN 1 ELSE 0 END) AS billed_n
       FROM invoices WHERE user_id = ? GROUP BY currency`, since, since, since, since, userId),

    /** Records a webhook event id. Returns false if we already processed it (PayPal retries). */
    async seenEvent(id, type, now) {
      const r = await run('INSERT OR IGNORE INTO events (id, type, received_at) VALUES (?, ?, ?)', id, type, now);
      return r.meta.changes === 0;
    },

    kvGet: async (k) => (await first('SELECT v FROM kv WHERE k = ?', k))?.v ?? null,
    kvSet: (k, v) => run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE kv.v IS NOT excluded.v', k, String(v)),
  };
}
