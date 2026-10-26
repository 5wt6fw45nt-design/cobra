// Minimal Telegram Bot API client. No libraries: just fetch.

export function createApi(token, fetchFn = fetch) {
  const base = `https://api.telegram.org/bot${token}/`;
  async function call(method, params = {}) {
    const res = await fetchFn(base + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.ok) return data.result;
    const err = new Error(`${method}: ${data.description}`);
    err.code = data.error_code;
    throw err;
  }
  /** sendPhoto with raw bytes (multipart), e.g. a QR code PNG. */
  async function sendPhotoBytes(chatId, bytes, caption, extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'qr.png');
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    const data = await (await fetchFn(base + 'sendPhoto', { method: 'POST', body: form })).json();
    if (!data.ok) throw new Error(`sendPhoto: ${data.description}`);
    return data.result;
  }
  return { call, sendPhotoBytes, fileUrl: (path) => `https://api.telegram.org/file/bot${token}/${path}` };
}

export const message = (chatId, text, extra = {}) => ({
  chat_id: chatId,
  text,
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  ...extra,
});
