// Cloudflare Worker: Telegram calls /webhook, PayPal calls /paypal/webhook.

import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createApi } from './telegram.js';
import { createPayPal } from './paypal.js';
import { createBot } from './bot.js';
import { budgetedAi } from './ai.js';
import { MINI_APP } from './miniapp.js';
import { verifyInitData, toRow, toCsv } from './webapp.js';

function build(env) {
  const cfg = loadConfig(env);
  const db = createDb(env.DB);
  const api = createApi(cfg.token);
  const paypal = createPayPal(cfg.paypal);
  const bot = createBot({ api, db, cfg, paypal, ai: budgetedAi(env.AI, db, cfg.aiCallsPerDay) });
  return { cfg, db, api, paypal, bot };
}

const secretOk = (env, url) => env.WEBHOOK_SECRET && url.searchParams.get('secret') === env.WEBHOOK_SECRET;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const update = await req.json();
      // Answer Telegram at once; PayPal and the AI can take a few seconds.
      ctx.waitUntil(build(env).bot.handleUpdate(update).catch((e) => console.error('[update]', e)));
      return new Response('ok');
    }

    if (url.pathname === '/paypal/webhook' && req.method === 'POST') {
      const { paypal, bot } = build(env);
      const event = await req.json().catch(() => null);
      if (!event) return new Response('bad request', { status: 400 });
      const ok = await paypal.verifyWebhook(req.headers, event).catch((e) => { console.error('[pp-verify]', e.message); return false; });
      if (!ok) return new Response('invalid signature', { status: 401 });
      const result = await bot.handlePayPalEvent(event);
      console.log('[pp-event]', event.event_type, event.id, result);
      return new Response('ok');
    }

    if (url.pathname === '/app') return new Response(MINI_APP, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if ((url.pathname === '/app/data' || url.pathname === '/app/export') && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const who = await verifyInitData(body?.initData, env.BOT_TOKEN);
      if (!who) return new Response('forbidden', { status: 403 });
      const { db, api } = build(env);
      const rows = (await db.invoices(who.id)).map(toRow);
      if (url.pathname === '/app/data') return Response.json({ rows, lang: (await db.getUser(who.id))?.lang });
      await api.sendTextFile(who.id, toCsv(rows), `cobra-invoices-${new Date().toISOString().slice(0, 10)}.csv`, '📊 Cobra');
      return new Response('ok');
    }

    // A shared clock Worker calls this every minute through a service binding.
    if (url.pathname === '/tick' && req.method === 'POST') {
      if (!env.RELOJ_SECRET || req.headers.get('x-reloj-secret') !== env.RELOJ_SECRET) return new Response('forbidden', { status: 403 });
      return new Response(await build(env).bot.tick(Date.now()));
    }

    // Once after each deploy: Telegram webhook + command menu, PayPal webhook. /setup?secret=WEBHOOK_SECRET
    if (url.pathname === '/setup') {
      if (!secretOk(env, url)) return new Response('forbidden', { status: 403 });
      const { api, bot, paypal } = build(env);
      try {
        await api.call('setWebhook', { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
        await api.call('setMyCommands', { commands: bot.commands });
        await api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: '📊 Invoices', web_app: { url: `${url.origin}/app` } } });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502 });
      }
      const paypalWebhookId = await paypal.ensureWebhook(`${url.origin}/paypal/webhook`).catch((e) => `error: ${e.message}`);
      return Response.json({ telegram: await api.call('getWebhookInfo'), paypalWebhookId, next: 'wrangler secret put PAYPAL_WEBHOOK_ID (with the id above), if it changed' });
    }

    return new Response('Cobra · talk to Telegram, get paid with PayPal', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
