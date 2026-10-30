// Cobra · settings from the Worker environment.

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'MXN', 'CAD', 'AUD'];

export function loadConfig(vars = globalThis.process?.env ?? {}) {
  const env = (k, d) => vars[k] ?? d;
  const live = env('PAYPAL_ENV', 'sandbox') === 'live';
  return {
    token: env('BOT_TOKEN', ''),
    paypal: {
      base: live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
      clientId: env('PAYPAL_CLIENT_ID', ''),
      secret: env('PAYPAL_CLIENT_SECRET', ''),
      webhookId: env('PAYPAL_WEBHOOK_ID', ''),
      sandbox: !live,
    },
    maxAudioSeconds: Number(env('MAX_AUDIO_SECONDS', 120)), // invoices are short; keeps the free Workers AI quota safe
    audioSecondsPerDay: Number(env('AUDIO_SECONDS_PER_DAY', 300)),
    aiCallsPerDay: Number(env('AI_CALLS_PER_DAY', 80)), // whole bot, all users
    maxAmount: Number(env('MAX_AMOUNT', 100000)),
  };
}
