// Hearing and understanding, with Cloudflare Workers AI:
//  1. Whisper turns a voice note into text.
//  2. Llama turns text into an intent plus a structured invoice draft (or edits an existing draft).

import { CURRENCIES } from './config.js';

export const STT = '@cf/openai/whisper-large-v3-turbo';
export const LLM = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const b64 = (bytes) => {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Audio bytes → { text, seconds }. Whisper detects the language itself: people switch. Throws on failure. */
export async function transcribe(ai, bytes) {
  const out = await ai.run(STT, { audio: b64(bytes), vad_filter: true });
  return { text: String(out?.text || '').trim(), seconds: Math.round(Number(out?.transcription_info?.duration || 0)) };
}

/** "marta arroba gmail punto com" / "john at example dot com" → "marta@gmail.com". Returns null if it is not an email. */
export function cleanEmail(s) {
  if (!s) return null;
  let t = String(s).toLowerCase().trim()
    .replace(/\s+(arroba|at)\s+/g, '@').replace(/\s+(punto|dot)\s+/g, '.')
    .replace(/\s+(guion bajo|underscore)\s+/g, '_').replace(/\s+(guion|dash|hyphen)\s+/g, '-')
    .replace(/[\s<>()"'«»]/g, '').replace(/[.,;:]+$/, '');
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t) ? t : null;
}

const SYSTEM = ({ today, currency, lang, clients }) => `You are Cobra, a Telegram assistant that creates and sends PayPal invoices for freelancers.
The user usually speaks ${lang === 'es' ? 'Spanish' : 'English'}, but they may switch: always follow the language of this message. Today is ${today}. Their default currency is ${currency}.
Classify the message:
- "invoice": they want to bill/charge/invoice someone ("factura a Marta 300 euros por el logo", "bill John $500 for the website", "cóbrale a Pedro 50 de la clase").
- "debtors": they ask who owes them, what is unpaid or overdue ("¿quién me debe?", "what's pending?").
- "summary": they ask how much they earned/collected/billed in a period ("¿cuánto he cobrado este mes?").
- "help": they ask what you do or how to use you.
- "chat": greetings, thanks, jokes, anything else. Answer in "reply".
Return ONLY JSON:
{"intent": "invoice"|"debtors"|"summary"|"help"|"chat",
 "language": "es" or "en", the language of this message; null if it is too short to tell (only a name, a number, "ok"),
 "client_name": "person or company to bill, as said",
 "client_email": "email if said (spoken emails like 'marta arroba gmail punto com' → marta@gmail.com), else null",
 "items": [{"name": "short description of the work, in the language of this message, capitalized", "amount": number (unit price, no symbols), "qty": number}],
 "currency": "ISO code if they said one (euros → EUR, dollars → USD, pounds → GBP, pesos → MXN), else null",
 "due_days": number of days to pay if said ("en 15 días", "net 30"), else null,
 "due_date": "YYYY-MM-DD if they said a date ('before Friday', 'el 30 de noviembre'), else null",
 "note": "message to the client if they dictated one, else null",
 "reply": "only for chat: one or two friendly sentences in the language of this message; never invent facts"}
Rules:
- Several things for the same client are several items. "two hours at 40" → {"amount": 40, "qty": 2}.
- Numbers said in words become numbers ("trescientos cincuenta" → 350, "one fifty" → 150).
- Never invent an email, an amount or a client. Leave null what was not said.
- Speech-to-text makes mistakes: fix obvious ones from context, without inventing.${clients.length ? `\n- Known clients (reuse the exact spelling if it matches): ${clients.join(', ')}.` : ''}`;

const FIX = ({ today, currency, lang }) => `You are Cobra. The user is correcting an invoice draft. Today is ${today}. Default currency ${currency}. User language: ${lang === 'es' ? 'Spanish' : 'English'}.
You get the current draft as JSON and the user's correction. Apply ONLY what they change and keep everything else.
Return ONLY the full updated draft as JSON with the same keys:
{"client_name", "client_email", "items": [{"name", "amount", "qty"}], "currency", "due_date": "YYYY-MM-DD or null", "note"}
Spoken emails ('arroba', 'at', 'punto', 'dot') become real emails. Numbers in words become numbers.`;

const num = (x) => {
  const n = typeof x === 'number' ? x : Number(String(x ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Cleans what Llama returned into a safe draft shape (amounts in cents). */
export function normalizeDraft(d, { currency, today }) {
  const items = (Array.isArray(d?.items) ? d.items : [])
    .map((it) => ({ name: String(it?.name || '').trim().slice(0, 120), cents: Math.round((num(it?.amount) ?? 0) * 100), qty: Math.max(1, Math.round(num(it?.qty) || 1)) }))
    .filter((it) => it.cents > 0)
    .slice(0, 10)
    .map((it) => ({ ...it, name: it.name || 'Services' }));
  let due = /^\d{4}-\d{2}-\d{2}$/.test(d?.due_date || '') && d.due_date >= today ? d.due_date : null;
  const days = num(d?.due_days);
  if (!due && days && days > 0 && days <= 365) due = addDays(today, days);
  const cur = String(d?.currency || '').toUpperCase();
  return {
    client_name: String(d?.client_name || '').replace(/[<>]/g, '').trim().slice(0, 80),
    client_email: cleanEmail(d?.client_email),
    items,
    currency: CURRENCIES.includes(cur) ? cur : currency,
    due_date: due,
    note: d?.note ? String(d.note).replace(/[<>]/g, '').trim().slice(0, 400) : null,
  };
}

/** Workers AI with a daily limit for the whole bot: the free quota is shared with other Workers on the account. */
export function budgetedAi(ai, db, limit, clock = Date.now) {
  return {
    async run(model, input) {
      const key = `aicalls:${new Date(clock()).toISOString().slice(0, 10)}`;
      const used = Number(await db.kvGet(key)) || 0;
      if (used >= limit) throw new Error('daily AI budget reached');
      await db.kvSet(key, used + 1);
      return ai.run(model, input);
    },
  };
}

export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function askJson(ai, system, user, maxTokens = 600) {
  const out = await ai.run(LLM, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: String(user).slice(0, 4000) }],
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  });
  const d = typeof out?.response === 'string' ? JSON.parse(out.response) : out?.response;
  return d && typeof d === 'object' ? d : null;
}

/** Text → { intent, lang, draft, reply }. Returns null if the AI fails. */
export async function understand(ai, text, ctx) {
  try {
    const d = await askJson(ai, SYSTEM(ctx), text);
    if (!d) return null;
    const intent = ['invoice', 'debtors', 'summary', 'help', 'chat'].includes(d.intent) ? d.intent : 'chat';
    return { intent, lang: ['es', 'en'].includes(d.language) ? d.language : null, draft: intent === 'invoice' ? normalizeDraft(d, ctx) : null, reply: String(d.reply || '').slice(0, 400) };
  } catch (e) {
    console.error('[understand]', e.message);
    return null;
  }
}

/** Applies a spoken/typed correction to a draft. Returns the new draft or null. */
export async function applyFix(ai, draft, correction, ctx) {
  try {
    const current = { ...draft, items: draft.items.map((it) => ({ name: it.name, amount: it.cents / 100, qty: it.qty })) };
    const d = await askJson(ai, FIX(ctx), `Draft: ${JSON.stringify(current)}\nCorrection: ${correction}`);
    return d ? normalizeDraft(d, ctx) : null;
  } catch (e) {
    console.error('[fix]', e.message);
    return null;
  }
}

/** A short, polite reminder note for an overdue invoice, in the user's language. */
export async function writeReminder(ai, inv, lang) {
  const fallback = lang === 'es'
    ? `Hola ${inv.client_name}, te recuerdo la factura de ${inv.description}. Si ya la has pagado, ignora este mensaje. ¡Gracias!`
    : `Hi ${inv.client_name}, just a friendly reminder about the invoice for ${inv.description}. If you've already paid, please ignore this. Thanks!`;
  try {
    const d = await askJson(ai, `Write a short, warm, professional payment reminder (max 3 sentences) in ${lang === 'es' ? 'Spanish' : 'English'} for a freelancer's client. No placeholders, no amounts unless given, no threats. Return JSON {"note": "..."}`,
      `Client: ${inv.client_name}. Work: ${inv.description}. Days overdue: ${inv.days_overdue}.`, 200);
    const note = String(d?.note || '').trim();
    return note.length > 20 && note.length < 600 ? note : fallback;
  } catch {
    return fallback;
  }
}
