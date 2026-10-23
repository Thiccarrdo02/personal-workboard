// Minimal Cloudflare D1 stand-in backed by node:sqlite, for running the Worker in tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  const prepare = sql => {
    let params = [];
    const statement = {
      bind(...values) {
        params = values;
        return statement;
      },
      async first(column) {
        const row = db.prepare(sql).get(...params);
        if (!row) return null;
        return column ? row[column] : { ...row };
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...params).map(row => ({ ...row })), meta: {} };
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      }
    };
    return statement;
  };

  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    sqlite: db
  };
}
