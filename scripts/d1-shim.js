// Imita la API de Cloudflare D1 con node:sqlite, para tests y para `npm run check`.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function d1Shim(path = ':memory:') {
  const db = new DatabaseSync(path);
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (sql, args = []) => {
    const st = db.prepare(sql);
    return {
      bind: (...a) => stmt(sql, a),
      run: async () => {
        const r = st.run(...args);
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
    };
  };
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}
