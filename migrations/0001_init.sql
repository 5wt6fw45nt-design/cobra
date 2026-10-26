-- Cobra: users, clients, drafts, invoices, processed PayPal events, kv.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,                  -- Telegram user id
  first_name TEXT,
  lang TEXT NOT NULL DEFAULT 'en',         -- 'en' | 'es'
  currency TEXT NOT NULL DEFAULT 'USD',
  business_name TEXT,                      -- shown as the invoicer on PayPal invoices
  pending TEXT,                            -- what the next text message answers: 'email:<draftId>' | 'fix:<draftId>' | 'business'
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  user_id INTEGER NOT NULL,
  name_key TEXT NOT NULL,                  -- normalized name, for "bill Marta again"
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name_key)
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  data TEXT NOT NULL,                      -- JSON: client_name, client_email, items, currency, due_date, note
  heard TEXT,                              -- what the user said (transcript), for context on corrections
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_user ON drafts (user_id);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  paypal_id TEXT UNIQUE,                   -- INV2-XXXX-...
  number TEXT,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  due_date TEXT,                           -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'SENT',     -- SENT | PAID | CANCELLED | REFUNDED
  pay_url TEXT,                            -- payer view link
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  reminded_at INTEGER
);
CREATE INDEX IF NOT EXISTS invoices_user ON invoices (user_id, status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,                     -- PayPal webhook event id (dedupe retries)
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
