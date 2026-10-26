// Cloudflare Worker: Telegram calls /webhook, PayPal calls /paypal/webhook.

import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createApi } from './telegram.js';
import { createPayPal } from './paypal.js';
import { createBot } from './bot.js';

function build(env) {
  const cfg = loadConfig(env);
  const db = createDb(env.DB);
  const api = createApi(cfg.token);
  const paypal = createPayPal(cfg.paypal);
  const bot = createBot({ api, db, cfg, paypal, ai: env.AI });
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

    // Once after each deploy: Telegram webhook + command menu, PayPal webhook. /setup?secret=WEBHOOK_SECRET
    if (url.pathname === '/setup') {
      if (!secretOk(env, url)) return new Response('forbidden', { status: 403 });
      const { api, bot, paypal } = build(env);
      await api.call('setWebhook', { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
      await api.call('setMyCommands', { commands: bot.commands });
      const paypalWebhookId = await paypal.ensureWebhook(`${url.origin}/paypal/webhook`).catch((e) => `error: ${e.message}`);
      return Response.json({ telegram: await api.call('getWebhookInfo'), paypalWebhookId, next: 'wrangler secret put PAYPAL_WEBHOOK_ID (with the id above), if it changed' });
    }

    return new Response('Cobra · talk to Telegram, get paid with PayPal', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
