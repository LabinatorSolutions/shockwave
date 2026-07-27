// Postgres connection + a transaction helper. The API's private backend.
//
// A single Pool for the process. On boot we ensure the schema exists (init.sql
// runs via Postgres's initdb on a fresh volume, but we also apply it here so a
// bare DATABASE_URL against an existing empty DB works too — idempotent).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

// node-pg returns bigint (int8, OID 20) as a STRING to avoid precision loss. All
// our bigints are epoch-ms timestamps (< 2^53), and the desktop compares them as
// numbers, so parse them back to Number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type DB = pg.Pool;

export function makePool(url: string): DB {
  return new Pool({ connectionString: url, max: 10 });
}

// The drizzle query layer over the pool. store.ts is written against this; the
// schema (schema.ts) is the source of truth for the tables.
export function getDb(pool: DB) {
  return drizzle(pool, { schema });
}
export type Db = ReturnType<typeof getDb>;

export async function ensureSchema(pool: DB): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server.js sits at api/dist; init.sql is at api/init.sql
  const sqlPath = process.env.INIT_SQL || path.resolve(here, '..', 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
}

// Run fn inside a transaction on a dedicated client (BEGIN/COMMIT, ROLLBACK on
// throw). better-sqlite3's synchronous db.transaction becomes this.
export async function tx<T>(pool: DB, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
}
