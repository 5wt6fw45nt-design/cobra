// Cobra's conversation: voice/text → invoice draft → PayPal invoice, payment alerts, reminders, QR, monthly totals.

import { T, esc, draftCard, mainKeyboard, total, describe } from './render.js';
import { message } from './telegram.js';
import { transcribe, understand, applyFix, writeReminder, cleanEmail } from './ai.js';
import { PayPalError } from './paypal.js';
import { CURRENCIES } from './config.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const firstName = (name) => String(name).split(' ')[0];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();

export function createBot({ api, db, cfg, paypal, ai = null, clock = Date.now, http = (...a) => fetch(...a), stt = transcribe, nlu = understand, fixer = applyFix, reminderWriter = writeReminder }) {
  const reply = (chatId, text, extra = {}) => api.call('sendMessage', message(chatId, text, extra));
  const edit = (chatId, messageId, text, extra = {}) =>
    api.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra })
      .catch(() => reply(chatId, text, extra));
  const ctxOf = async (u, now) => ({ today: ymd(now), currency: u.currency, lang: u.lang, clients: await db.clientNames(u.id) });
  const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

  // Buttons on the persistent keyboard, in both languages
  const BUTTONS = new Map();
  for (const lang of ['en', 'es']) {
    const t = T(lang);
    BUTTONS.set(t.btnOwed, 'owed'); BUTTONS.set(t.btnMonth, 'month'); BUTTONS.set(t.btnHelp, 'help'); BUTTONS.set(t.btnSettings, 'settings');
  }

  // --- drafts ---

  /** Fills a missing email from the client book, then shows the draft (or asks for what is missing). */
  async function showDraft(chatId, u, draft, heard, now, statusId = null) {
    const t = T(u.lang);
    const say = (text, extra) => (statusId ? edit(chatId, statusId, text, extra) : reply(chatId, text, extra));
    if (!draft.client_name) return say(t.noClient);
    if (!draft.items.length) return say(t.noAmount(draft.client_name));
    if (!draft.client_email) {
      const known = await db.findClient(u.id, draft.client_name);
      if (known) { draft.client_email = known.email; draft.client_name = known.name; }
    }
    await db.pruneDrafts(u.id, now - 7 * DAY);
    const id = await db.addDraft(u.id, draft, heard, now);
    if (!draft.client_email) {
      await db.setPending(u.id, `email:${id}`);
      return say(`${draftCard(draft, u.lang)}\n\n${t.askEmail(draft.client_name)}`, kb([[{ text: t.btnCancel, callback_data: `x:${id}` }]]));
    }
    await db.setPending(u.id, null);
    return say(draftCard(draft, u.lang), draftButtons(u.lang, id));
  }

  const draftButtons = (lang, id) => {
    const t = T(lang);
    return kb([[{ text: t.btnSend, callback_data: `send:${id}` }], [{ text: t.btnFix, callback_data: `fix:${id}` }, { text: t.btnCancel, callback_data: `x:${id}` }]]);
  };

  async function refreshDraft(chatId, u, draftId, data) {
    await db.updateDraft(draftId, data);
    if (!data.client_email) {
      await db.setPending(u.id, `email:${draftId}`);
      return reply(chatId, `${draftCard(data, u.lang)}\n\n${T(u.lang).askEmail(data.client_name)}`, kb([[{ text: T(u.lang).btnCancel, callback_data: `x:${draftId}` }]]));
    }
    await db.setPending(u.id, null);
    return reply(chatId, draftCard(data, u.lang), draftButtons(u.lang, draftId));
  }

  /** Creates the PayPal invoice for a draft and emails it to the client. */
  async function sendDraft(chatId, messageId, u, draftId, now) {
    const t = T(u.lang);
    const dr = await db.getDraft(draftId, u.id);
    if (!dr) return edit(chatId, messageId, t.gone);
    const d = dr.data;
    if (!d.client_email) return refreshDraft(chatId, u, draftId, d);
    if (!cfg.paypal.clientId) return reply(chatId, t.notConfigured);
    await edit(chatId, messageId, `${draftCard(d, u.lang)}\n\n${t.sending}`);
    try {
      // If a previous attempt created the invoice but failed to send it, reuse it instead of billing twice.
      if (!d.paypal_id) {
        const created = await paypal.createInvoice({ ...d, invoice_date: ymd(now), invoicer: u.business_name || u.first_name || null }, `cobra-draft-${draftId}`);
        d.paypal_id = created.id;
        d.number = created.number;
        await db.updateDraft(draftId, d);
      }
      const { payUrl: linkFromSend } = await paypal.sendInvoice(d.paypal_id, { note: d.note || undefined });
      let payUrl = linkFromSend;
      if (!payUrl) payUrl = (await paypal.getInvoice(d.paypal_id).catch(() => null))?.detail?.metadata?.recipient_view_url || null;
      const inv = {
        user_id: u.id, paypal_id: d.paypal_id, number: d.number || null, client_name: d.client_name, client_email: d.client_email,
        description: describe(d.items), amount_cents: total(d.items), currency: d.currency, due_date: d.due_date, pay_url: payUrl, created_at: now,
      };
      const id = await db.addInvoice(inv);
      await db.saveClient(u.id, d.client_name, d.client_email, now);
      await db.deleteDraft(draftId);
      const rows = [[{ text: t.btnQr, callback_data: `qr:${id}` }]];
      if (payUrl) rows.push([{ text: t.btnPayLink, url: payUrl }]);
      if (cfg.paypal.sandbox) rows.push([{ text: t.btnSimulate(firstName(inv.client_name)), callback_data: `sim:${id}` }]);
      return edit(chatId, messageId, t.sent(inv, u.lang), kb(rows));
    } catch (e) {
      console.error('[send]', e.message);
      const msg = e instanceof PayPalError && e.status < 500 ? t.ppFail(e.message) : t.ppDown;
      return reply(chatId, msg, draftButtons(u.lang, draftId));
    }
  }

  // --- invoices ---

  /** Asks PayPal for the real status of unpaid invoices (in case a webhook was missed). */
  async function syncUnpaid(u, list, now) {
    const still = [];
    for (const inv of list.slice(0, 10)) {
      const pp = await paypal.getInvoice(inv.paypal_id).catch(() => null);
      const st = pp?.status;
      if (st === 'PAID' || st === 'MARKED_AS_PAID') await db.setStatus(inv.id, 'PAID', now);
      else if (st === 'CANCELLED') await db.setStatus(inv.id, 'CANCELLED', now);
      else still.push(inv);
    }
    return still.concat(list.slice(10));
  }

  async function sendOwed(chatId, u, now) {
    const t = T(u.lang);
    const list = await syncUnpaid(u, await db.unpaid(u.id), now);
    if (!list.length) return reply(chatId, t.noneOwed, { reply_markup: mainKeyboard(u.lang) });
    const today = ymd(now);
    const lines = [t.owedTitle(list.length), ''];
    const rows = [];
    for (const inv of list) {
      const d = inv.due_date ? daysBetween(today, inv.due_date) : null;
      const when = d === null ? '' : d < 0 ? ` · ${t.overdue(-d)}` : ` · ${t.dueIn(d)}`;
      lines.push(`• <b>${esc(inv.client_name)}</b> · ${new Intl.NumberFormat(u.lang === 'es' ? 'es-ES' : 'en-US', { style: 'currency', currency: inv.currency }).format(inv.amount_cents / 100)} · ${esc(inv.description)}${when}${inv.reminded_at ? ` · 🔔 ${t.reminded}` : ''}`);
      if (rows.length < 8) {
        rows.push([{ text: t.btnRemind(firstName(inv.client_name)), callback_data: `rem:${inv.id}` }, { text: '📱 QR', callback_data: `qr:${inv.id}` }]);
        if (cfg.paypal.sandbox) rows.push([{ text: t.btnSimulate(firstName(inv.client_name)), callback_data: `sim:${inv.id}` }]);
      }
    }
    return reply(chatId, lines.join('\n'), kb(rows));
  }

  /** Sandbox only: lets anyone try the whole cycle without PayPal's test logins. The alert still comes from the real webhook. */
  async function simulatePayment(chatId, u, invId, now) {
    const t = T(u.lang);
    if (!cfg.paypal.sandbox) return null;
    const inv = await db.getInvoice(invId, u.id);
    if (!inv) return reply(chatId, t.gone);
    if (inv.status !== 'SENT') return reply(chatId, t.alreadyPaid(inv));
    try {
      await paypal.recordPayment(inv.paypal_id, { cents: inv.amount_cents, currency: inv.currency, date: ymd(now) });
      return reply(chatId, t.simulated);
    } catch (e) {
      console.error('[simulate]', e.message);
      return reply(chatId, e instanceof PayPalError && e.status < 500 ? t.ppFail(e.message) : t.ppDown);
    }
  }

  async function sendMonth(chatId, u, now) {
    const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const rows = await db.totals(u.id, start);
    const unpaid = (await db.unpaid(u.id)).length;
    return reply(chatId, T(u.lang).month(rows.filter((r) => r.billed_n || r.paid_n), unpaid, u.lang), { reply_markup: mainKeyboard(u.lang) });
  }

  async function previewReminder(chatId, u, invId, now) {
    const t = T(u.lang);
    const inv = await db.getInvoice(invId, u.id);
    if (!inv || inv.status !== 'SENT') return reply(chatId, inv ? t.alreadyPaid(inv) : t.gone);
    const pp = await paypal.getInvoice(inv.paypal_id).catch(() => null);
    if (pp?.status === 'PAID' || pp?.status === 'MARKED_AS_PAID') {
      await db.setStatus(inv.id, 'PAID', now);
      return reply(chatId, t.alreadyPaid(inv));
    }
    const days = inv.due_date ? Math.max(0, daysBetween(inv.due_date, ymd(now))) : 0;
    const note = await reminderWriter(ai, { ...inv, days_overdue: days }, u.lang);
    await db.kvSet(`remnote:${inv.id}`, note);
    return reply(chatId, t.reminderPreview(inv, note), kb([[{ text: t.btnSendReminder, callback_data: `remok:${inv.id}` }, { text: t.btnNotNow, callback_data: 'noop' }]]));
  }

  async function sendReminder(chatId, messageId, u, invId, now) {
    const t = T(u.lang);
    const inv = await db.getInvoice(invId, u.id);
    if (!inv || inv.status !== 'SENT') return edit(chatId, messageId, inv ? t.alreadyPaid(inv) : t.gone);
    const note = (await db.kvGet(`remnote:${inv.id}`)) || undefined;
    try {
      await paypal.remindInvoice(inv.paypal_id, { note });
      await db.markReminded(inv.id, now);
      return edit(chatId, messageId, t.reminderSent(inv));
    } catch (e) {
      console.error('[remind]', e.message);
      return reply(chatId, e instanceof PayPalError && e.status < 500 ? t.ppFail(e.message) : t.ppDown);
    }
  }

  async function sendQr(chatId, u, invId) {
    const t = T(u.lang);
    const inv = await db.getInvoice(invId, u.id);
    if (!inv) return reply(chatId, t.gone);
    if (inv.status !== 'SENT') return reply(chatId, t.alreadyPaid(inv));
    try {
      const png = await paypal.qrCode(inv.paypal_id);
      return api.sendPhotoBytes(chatId, png, t.qrCaption(inv, u.lang));
    } catch (e) {
      console.error('[qr]', e.message);
      return reply(chatId, t.ppDown);
    }
  }

  // --- settings ---

  async function sendSettings(chatId, u, messageId = null) {
    const t = T(u.lang);
    const rows = [
      [{ text: t.btnLang, callback_data: `lang:${u.lang === 'es' ? 'en' : 'es'}` }],
      CURRENCIES.map((c) => ({ text: c === u.currency ? `• ${c}` : c, callback_data: `cur:${c}` })),
      [{ text: t.btnBusiness, callback_data: 'biz' }],
    ];
    return messageId ? edit(chatId, messageId, t.settings(u), kb(rows)) : reply(chatId, t.settings(u), kb(rows));
  }

  // --- input ---

  /** Everything the user says (typed or transcribed) ends here. */
  async function handleText(chatId, u, text, now, statusId = null) {
    const t = T(u.lang);
    const say = (s, extra) => (statusId ? edit(chatId, statusId, s, extra) : reply(chatId, s, extra));

    // Answers to a question we asked
    const [kind, ref] = String(u.pending || '').split(':');
    if (kind === 'email') {
      const dr = await db.getDraft(Number(ref), u.id);
      const email = cleanEmail(text);
      if (dr && email) {
        if (statusId) await api.call('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
        return refreshDraft(chatId, u, dr.id, { ...dr.data, client_email: email });
      }
      if (dr && !/\s/.test(text.trim())) return say(t.badEmail);
      await db.setPending(u.id, null); // they moved on: treat it as a new message
    } else if (kind === 'fix') {
      const dr = await db.getDraft(Number(ref), u.id);
      if (dr) {
        const fixed = await fixer(ai, dr.data, text, await ctxOf(u, now));
        if (!fixed) return say(t.aiFail);
        if (statusId) await api.call('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
        return refreshDraft(chatId, u, dr.id, { ...fixed, paypal_id: undefined });
      }
      await db.setPending(u.id, null);
    } else if (kind === 'business') {
      await db.setBusiness(u.id, text.trim().slice(0, 80));
      await db.setPending(u.id, null);
      return say(t.saved);
    }

    const a = await nlu(ai, text, await ctxOf(u, now));
    if (!a) return say(t.aiFail);
    if (a.intent === 'invoice') return showDraft(chatId, u, a.draft, text, now, statusId);
    if (statusId) await api.call('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
    if (a.intent === 'debtors') return sendOwed(chatId, u, now);
    if (a.intent === 'summary') return sendMonth(chatId, u, now);
    if (a.intent === 'help') return reply(chatId, t.help, { reply_markup: mainKeyboard(u.lang) });
    return reply(chatId, esc(a.reply || t.help), { reply_markup: mainKeyboard(u.lang) });
  }

  async function handleVoice(msg, u, now) {
    const t = T(u.lang);
    const chatId = msg.chat.id;
    const v = msg.voice || msg.audio || msg.video_note;
    if ((v.duration || 0) > cfg.maxAudioSeconds) return reply(chatId, t.tooLong(cfg.maxAudioSeconds));
    const key = `secs:${u.id}:${ymd(now)}`;
    const used = Number(await db.kvGet(key)) || 0;
    if (used >= cfg.audioSecondsPerDay) return reply(chatId, t.quota);
    const status = await reply(chatId, t.thinking);
    try {
      const file = await api.call('getFile', { file_id: v.file_id });
      const bytes = await (await http(api.fileUrl(file.file_path))).arrayBuffer();
      const heard = await stt(ai, bytes, u.lang);
      await db.kvSet(key, used + Math.max(1, heard.seconds || v.duration || 1));
      if (!heard.text) return edit(chatId, status.message_id, t.aiFail);
      return handleText(chatId, u, heard.text, now, status.message_id);
    } catch (e) {
      console.error('[voice]', e.message);
      return edit(chatId, status.message_id, t.aiFail);
    }
  }

  async function handleCallback(q, now) {
    const chatId = q.message?.chat?.id;
    const messageId = q.message?.message_id;
    await api.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!chatId) return;
    let u = await db.upsertUser(q.from, now);
    const t = T(u.lang);
    const [cmd, arg] = String(q.data || '').split(':');
    const id = Number(arg);
    switch (cmd) {
      case 'send': return sendDraft(chatId, messageId, u, id, now);
      case 'fix': {
        if (!(await db.getDraft(id, u.id))) return edit(chatId, messageId, t.gone);
        await db.setPending(u.id, `fix:${id}`);
        return reply(chatId, t.askFix);
      }
      case 'x': {
        await db.deleteDraft(id);
        await db.setPending(u.id, null);
        return edit(chatId, messageId, t.cancelled);
      }
      case 'rem': return previewReminder(chatId, u, id, now);
      case 'remok': return sendReminder(chatId, messageId, u, id, now);
      case 'qr': return sendQr(chatId, u, id);
      case 'sim': return simulatePayment(chatId, u, id, now);
      case 'lang': {
        await db.setLang(u.id, arg === 'es' ? 'es' : 'en');
        u = await db.getUser(u.id);
        await reply(chatId, T(u.lang).saved, { reply_markup: mainKeyboard(u.lang) });
        return sendSettings(chatId, u, messageId);
      }
      case 'cur': {
        if (CURRENCIES.includes(arg)) await db.setCurrency(u.id, arg);
        return sendSettings(chatId, await db.getUser(u.id), messageId);
      }
      case 'biz': {
        await db.setPending(u.id, 'business');
        return reply(chatId, t.askBusiness);
      }
      case 'noop': return api.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
      default: return null;
    }
  }

  async function handleMessage(msg, now) {
    if (msg.chat?.type !== 'private' || !msg.from) return;
    const chatId = msg.chat.id;
    const u = await db.upsertUser(msg.from, now);
    const t = T(u.lang);
    if (msg.voice || msg.audio || msg.video_note) return handleVoice(msg, u, now);
    const text = String(msg.text || '').trim();
    if (!text) return reply(chatId, t.help, { reply_markup: mainKeyboard(u.lang) });
    if (/^\/start\b/.test(text)) {
      await db.setPending(u.id, null);
      return reply(chatId, t.welcome(msg.from.first_name), { reply_markup: mainKeyboard(u.lang) });
    }
    const action = BUTTONS.get(text) || { '/owed': 'owed', '/month': 'month', '/help': 'help', '/settings': 'settings' }[text.split(/[\s@]/)[0]];
    if (action) {
      await db.setPending(u.id, null);
      if (action === 'owed') return sendOwed(chatId, u, now);
      if (action === 'month') return sendMonth(chatId, u, now);
      if (action === 'settings') return sendSettings(chatId, u);
      return reply(chatId, t.help, { reply_markup: mainKeyboard(u.lang) });
    }
    return handleText(chatId, u, text, now);
  }

  // --- PayPal webhooks ---

  /** Handles a verified PayPal webhook event. Returns what happened, for logs and tests. */
  async function handlePayPalEvent(ev) {
    const now = clock();
    if (!ev?.id || await db.seenEvent(ev.id, ev.event_type || '', now)) return 'duplicate';
    const res = ev.resource?.invoice || ev.resource || {};
    const inv = res.id ? await db.invoiceByPayPal(res.id) : null;
    if (!inv) return 'unknown-invoice';
    const status = { 'INVOICING.INVOICE.PAID': 'PAID', 'INVOICING.INVOICE.CANCELLED': 'CANCELLED', 'INVOICING.INVOICE.REFUNDED': 'REFUNDED' }[ev.event_type];
    if (!status) return 'ignored';
    if (!(await db.setStatus(inv.id, status, now))) return 'unchanged';
    const u = await db.getUser(inv.user_id);
    const t = T(u?.lang);
    const text = status === 'PAID' ? t.paid(inv, u?.lang) : status === 'CANCELLED' ? t.invCancelled(inv, u?.lang) : t.refunded(inv, u?.lang);
    await reply(inv.user_id, text).catch((e) => console.error('[notify]', e.message));
    return status.toLowerCase();
  }

  /** Called every minute by the clock; works once an hour. Catches missed webhooks and warns once about each overdue invoice. */
  async function tick(now) {
    const slot = String(Math.floor(now / HOUR));
    if (await db.kvGet('tick:slot') === slot) return 'idle';
    await db.kvSet('tick:slot', slot);
    const today = ymd(now);
    for (const inv of await db.openInvoices(12)) {
      const st = (await paypal.getInvoice(inv.paypal_id).catch(() => null))?.status;
      const u = await db.getUser(inv.user_id);
      const t = T(u?.lang);
      if (st === 'PAID' || st === 'MARKED_AS_PAID') {
        if (await db.setStatus(inv.id, 'PAID', now)) await reply(inv.user_id, t.paid(inv, u?.lang)).catch((e) => console.error('[tick]', e.message));
      } else if (st === 'CANCELLED') {
        await db.setStatus(inv.id, 'CANCELLED', now);
      } else if (st && inv.due_date && inv.due_date < today && !(await db.kvGet(`overdue:${inv.id}`))) {
        await db.kvSet(`overdue:${inv.id}`, today);
        await reply(inv.user_id, t.overdueAlert(inv, u?.lang), kb([[{ text: t.btnRemind(firstName(inv.client_name)), callback_data: `rem:${inv.id}` }]])).catch((e) => console.error('[tick]', e.message));
      }
    }
    return 'done';
  }

  return {
    tick,
    async handleUpdate(update) {
      const now = clock();
      if (update.message) return handleMessage(update.message, now);
      if (update.callback_query) return handleCallback(update.callback_query, now);
      return null;
    },
    handlePayPalEvent,
    commands: [
      { command: 'owed', description: 'Who owes me / Quién me debe' },
      { command: 'month', description: 'This month / Este mes' },
      { command: 'settings', description: 'Settings / Ajustes' },
      { command: 'help', description: 'How it works / Cómo funciona' },
    ],
  };
}
