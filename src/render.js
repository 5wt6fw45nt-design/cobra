// Every text Cobra says, in English and Spanish, plus formatting helpers.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const fmtMoney = (cents, currency, lang) =>
  new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', { style: 'currency', currency }).format(cents / 100);

export const fmtDate = (ymd, lang) => (ymd
  ? new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd}T12:00:00Z`))
  : null);

export const total = (items) => items.reduce((s, it) => s + it.cents * it.qty, 0);

export const describe = (items) => items.map((it) => (it.qty > 1 ? `${it.name} ×${it.qty}` : it.name)).join(', ').slice(0, 200);

const EN = {
  btnOwed: '💸 Who owes me',
  btnMonth: '📊 This month',
  btnHelp: '❓ How it works',
  btnSettings: '⚙️ Settings',
  welcome: (name) => `Hi ${esc(name || 'there')}! I'm <b>Cobra</b> 🧾🎙️\n\nI bill your clients and chase payments for you, with <b>PayPal</b>. Just send me a voice note or a text like:\n\n<i>“Bill Marta Garcia, marta@example.com, 350 dollars for the logo design, due in 15 days.”</i>\n\nI'll show you the invoice first. Nothing is sent until you tap ✅.`,
  help: `<b>What I do</b>\n\n🎙️ <b>Send a voice note or a text</b> saying who to bill, how much and for what. I prepare a PayPal invoice and show it to you.\n✅ Tap <b>Send</b> and PayPal emails it to your client. They pay with PayPal or card.\n💸 I tell you <b>the moment you're paid</b>.\n🔔 <b>Who owes me</b> lists unpaid invoices; I can write and send a polite reminder.\n📱 Need to get paid in person? I make a <b>QR code</b>.\n📊 <b>This month</b>: what you billed and collected.\n\nI remember your clients' emails, so next time just say “bill Marta 200 for the banner”.`,
  thinking: '🎙️ Listening…',
  draftTitle: '🧾 <b>Invoice draft</b>',
  to: 'To',
  totalL: 'Total',
  due: 'Due',
  onReceipt: 'on receipt',
  note: 'Note',
  btnSend: '✅ Send with PayPal',
  btnFix: '✏️ Fix',
  btnCancel: '❌ Cancel',
  askEmail: (name) => `What's ${esc(name || 'the client')}'s email? Type it or say it.`,
  badEmail: "That doesn't look like an email. Try again, e.g. <code>marta@example.com</code>.",
  askFix: 'Tell me what to change (by voice or text), e.g. “make it 400” or “due next Friday”.',
  noClient: 'Who should I bill? Tell me the client\'s name, the amount and what it\'s for.',
  noAmount: (name) => `How much should I bill ${esc(name || 'them')}, and for what?`,
  sending: '⏳ Creating the invoice on PayPal…',
  sent: (inv, lang) => `✅ <b>Invoice sent</b> to ${esc(inv.client_email)} via PayPal.\n${fmtMoney(inv.amount_cents, inv.currency, lang)} · ${esc(inv.description)}\n\nI'll tell you the moment it's paid.`,
  btnQr: '📱 QR to pay in person',
  btnPayLink: '🔗 Payment page',
  cancelled: 'Draft discarded. 👍',
  gone: 'That draft is no longer available. Send me a new one.',
  paid: (inv, lang) => `💸 <b>${esc(inv.client_name)} paid you ${fmtMoney(inv.amount_cents, inv.currency, lang)}</b>\n${esc(inv.description)}`,
  invCancelled: (inv, lang) => `🚫 The invoice to ${esc(inv.client_name)} (${fmtMoney(inv.amount_cents, inv.currency, lang)}) was cancelled.`,
  refunded: (inv, lang) => `↩️ The payment from ${esc(inv.client_name)} (${fmtMoney(inv.amount_cents, inv.currency, lang)}) was refunded.`,
  noneOwed: '🎉 Nobody owes you anything right now.',
  owedTitle: (n) => `💸 <b>${n} unpaid invoice${n === 1 ? '' : 's'}</b>`,
  overdue: (d) => `⚠️ ${d} day${d === 1 ? '' : 's'} overdue`,
  dueIn: (d) => (d === 0 ? 'due today' : `due in ${d} day${d === 1 ? '' : 's'}`),
  reminded: 'reminded',
  btnRemind: (name) => `🔔 Remind ${name}`,
  reminderPreview: (inv, note) => `🔔 <b>Reminder for ${esc(inv.client_name)}</b>\nPayPal will email this along with the invoice link:\n\n<i>${esc(note)}</i>`,
  btnSendReminder: '✅ Send reminder',
  btnNotNow: 'Not now',
  reminderSent: (inv) => `🔔 Reminder sent to ${esc(inv.client_email)}.`,
  alreadyPaid: (inv) => `✅ Good news: ${esc(inv.client_name)} already paid that one.`,
  month: (rows, unpaidN, lang) => {
    if (!rows.length) return `📊 <b>This month</b>\n\nNo invoices yet. Send me a voice note to bill your first client.`;
    const lines = rows.map((r) => `• ${r.currency}: collected <b>${fmtMoney(r.paid, r.currency, lang)}</b> (${r.paid_n}) · billed ${fmtMoney(r.billed, r.currency, lang)} (${r.billed_n})`);
    return `📊 <b>This month</b>\n\n${lines.join('\n')}${unpaidN ? `\n\n⏳ ${unpaidN} still unpaid.` : ''}`;
  },
  qrCaption: (inv, lang) => `📱 Scan to pay ${fmtMoney(inv.amount_cents, inv.currency, lang)} · ${esc(inv.description)}`,
  settings: (u) => `⚙️ <b>Settings</b>\n\nLanguage: ${u.lang === 'es' ? 'Español' : 'English'}\nCurrency: ${u.currency}\nName on invoices: ${esc(u.business_name || u.first_name || '—')}`,
  btnLang: '🌐 Español',
  btnBusiness: '🏷️ Name on invoices',
  askBusiness: 'What name should your clients see on the invoices? (your name or your business)',
  saved: 'Saved ✅',
  aiFail: "Sorry, I couldn't understand that one. Could you say it again, or type it?",
  tooLong: (s) => `That audio is a bit long. Keep it under ${Math.round(s / 60)} min: who, how much and what for is enough.`,
  quota: 'You have used today\'s voice minutes. You can still type, it works the same.',
  ppFail: (msg) => `PayPal said no: <code>${esc(msg)}</code>\nThe draft is still here, you can fix it and try again.`,
  ppDown: 'PayPal is not answering right now. Your draft is safe, try again in a minute.',
  notConfigured: 'PayPal is not connected yet (missing API keys).',
};

const ES = {
  ...EN,
  btnOwed: '💸 Quién me debe',
  btnMonth: '📊 Este mes',
  btnHelp: '❓ Cómo funciona',
  btnSettings: '⚙️ Ajustes',
  welcome: (name) => `¡Hola, ${esc(name || '')}! Soy <b>Cobra</b> 🧾🎙️\n\nFacturo a tus clientes y persigo los pagos por ti, con <b>PayPal</b>. Mándame un audio o un texto como:\n\n<i>«Factura a Marta García, marta@ejemplo.com, 350 euros por el diseño del logo, a pagar en 15 días.»</i>\n\nPrimero te enseño la factura. No se envía nada hasta que pulses ✅.`,
  help: `<b>Qué hago</b>\n\n🎙️ <b>Mándame un audio o un texto</b> diciendo a quién facturas, cuánto y por qué. Preparo una factura de PayPal y te la enseño.\n✅ Pulsa <b>Enviar</b> y PayPal se la manda por correo a tu cliente. Paga con PayPal o con tarjeta.\n💸 Te aviso <b>en cuanto te pagan</b>.\n🔔 <b>Quién me debe</b> te enseña lo pendiente; puedo escribir y mandar un recordatorio amable.\n📱 ¿Te pagan en persona? Te hago un <b>código QR</b>.\n📊 <b>Este mes</b>: lo facturado y lo cobrado.\n\nMe acuerdo del correo de tus clientes: la próxima vez basta con «factura a Marta 200 por el banner».`,
  thinking: '🎙️ Escuchando…',
  draftTitle: '🧾 <b>Borrador de factura</b>',
  to: 'Para',
  totalL: 'Total',
  due: 'Vence',
  onReceipt: 'al recibirla',
  note: 'Nota',
  btnSend: '✅ Enviar con PayPal',
  btnFix: '✏️ Corregir',
  btnCancel: '❌ Cancelar',
  askEmail: (name) => `¿Cuál es el correo de ${esc(name || 'tu cliente')}? Escríbelo o dímelo.`,
  badEmail: 'Eso no parece un correo. Prueba otra vez, por ejemplo <code>marta@ejemplo.com</code>.',
  askFix: 'Dime qué cambio (por audio o por texto), por ejemplo «que sean 400» o «que venza el viernes».',
  noClient: '¿A quién facturo? Dime el nombre del cliente, el importe y por qué es.',
  noAmount: (name) => `¿Cuánto le facturo a ${esc(name || 'tu cliente')} y por qué?`,
  sending: '⏳ Creando la factura en PayPal…',
  sent: (inv, lang) => `✅ <b>Factura enviada</b> a ${esc(inv.client_email)} con PayPal.\n${fmtMoney(inv.amount_cents, inv.currency, lang)} · ${esc(inv.description)}\n\nTe aviso en cuanto te paguen.`,
  btnQr: '📱 QR para cobrar en persona',
  btnPayLink: '🔗 Página de pago',
  cancelled: 'Borrador descartado. 👍',
  gone: 'Ese borrador ya no está. Mándame uno nuevo.',
  paid: (inv, lang) => `💸 <b>${esc(inv.client_name)} te ha pagado ${fmtMoney(inv.amount_cents, inv.currency, lang)}</b>\n${esc(inv.description)}`,
  invCancelled: (inv, lang) => `🚫 Se ha cancelado la factura a ${esc(inv.client_name)} (${fmtMoney(inv.amount_cents, inv.currency, lang)}).`,
  refunded: (inv, lang) => `↩️ Se ha devuelto el pago de ${esc(inv.client_name)} (${fmtMoney(inv.amount_cents, inv.currency, lang)}).`,
  noneOwed: '🎉 Ahora mismo nadie te debe nada.',
  owedTitle: (n) => `💸 <b>${n} factura${n === 1 ? '' : 's'} sin pagar</b>`,
  overdue: (d) => `⚠️ vencida hace ${d} día${d === 1 ? '' : 's'}`,
  dueIn: (d) => (d === 0 ? 'vence hoy' : `vence en ${d} día${d === 1 ? '' : 's'}`),
  reminded: 'recordada',
  btnRemind: (name) => `🔔 Recordar a ${name}`,
  reminderPreview: (inv, note) => `🔔 <b>Recordatorio para ${esc(inv.client_name)}</b>\nPayPal le mandará esto por correo junto al enlace de la factura:\n\n<i>${esc(note)}</i>`,
  btnSendReminder: '✅ Enviar recordatorio',
  btnNotNow: 'Ahora no',
  reminderSent: (inv) => `🔔 Recordatorio enviado a ${esc(inv.client_email)}.`,
  alreadyPaid: (inv) => `✅ Buenas noticias: ${esc(inv.client_name)} ya pagó esa.`,
  month: (rows, unpaidN, lang) => {
    if (!rows.length) return `📊 <b>Este mes</b>\n\nTodavía no hay facturas. Mándame un audio para facturar a tu primer cliente.`;
    const lines = rows.map((r) => `• ${r.currency}: cobrado <b>${fmtMoney(r.paid, r.currency, lang)}</b> (${r.paid_n}) · facturado ${fmtMoney(r.billed, r.currency, lang)} (${r.billed_n})`);
    return `📊 <b>Este mes</b>\n\n${lines.join('\n')}${unpaidN ? `\n\n⏳ ${unpaidN} sin pagar todavía.` : ''}`;
  },
  qrCaption: (inv, lang) => `📱 Escanea para pagar ${fmtMoney(inv.amount_cents, inv.currency, lang)} · ${esc(inv.description)}`,
  settings: (u) => `⚙️ <b>Ajustes</b>\n\nIdioma: ${u.lang === 'es' ? 'Español' : 'English'}\nMoneda: ${u.currency}\nNombre en las facturas: ${esc(u.business_name || u.first_name || '—')}`,
  btnLang: '🌐 English',
  btnBusiness: '🏷️ Nombre en las facturas',
  askBusiness: '¿Qué nombre quieres que vean tus clientes en las facturas? (el tuyo o el de tu negocio)',
  saved: 'Guardado ✅',
  aiFail: 'Perdona, no lo he entendido. ¿Me lo repites o me lo escribes?',
  tooLong: (s) => `Ese audio es un poco largo. Con menos de ${Math.round(s / 60)} min basta: a quién, cuánto y por qué.`,
  quota: 'Has gastado los minutos de audio de hoy. Puedes escribirme, funciona igual.',
  ppFail: (msg) => `PayPal ha dicho que no: <code>${esc(msg)}</code>\nEl borrador sigue aquí: puedes corregirlo y volver a intentarlo.`,
  ppDown: 'PayPal no responde ahora mismo. Tu borrador está a salvo, prueba en un minuto.',
  notConfigured: 'PayPal aún no está conectado (faltan las claves de la API).',
};

export const T = (lang) => (lang === 'es' ? ES : EN);

/** The invoice draft card. */
export function draftCard(d, lang) {
  const t = T(lang);
  const lines = [t.draftTitle, ''];
  lines.push(`${t.to}: <b>${esc(d.client_name || '?')}</b>${d.client_email ? ` · ${esc(d.client_email)}` : ''}`);
  for (const it of d.items) lines.push(`• ${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ''} · ${fmtMoney(it.cents * it.qty, d.currency, lang)}`);
  lines.push(`${t.totalL}: <b>${fmtMoney(total(d.items), d.currency, lang)}</b>`);
  lines.push(`${t.due}: ${d.due_date ? fmtDate(d.due_date, lang) : t.onReceipt}`);
  if (d.note) lines.push(`${t.note}: <i>${esc(d.note)}</i>`);
  return lines.join('\n');
}

export const mainKeyboard = (lang) => {
  const t = T(lang);
  return { keyboard: [[{ text: t.btnOwed }, { text: t.btnMonth }], [{ text: t.btnHelp }, { text: t.btnSettings }]], resize_keyboard: true, is_persistent: true };
};
