import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { log } from './log.js';

// BIGINT columns (Telegram ids, serial ids) fit safely into JS numbers (< 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;

/**
 * Neon: sslmode/channel_binding query params are dropped and expressed as pg options instead
 * (pg treats sslmode=require as verify-full and ignores channel_binding).
 */
function poolConfig(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  url.search = '';
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname); // tests / local Postgres
  return {
    connectionString: url.toString(),
    ssl: !local, // verify-full with system CAs
    enableChannelBinding: !local, // == channel_binding=require
    application_name: 'pdb_bot',
    max: 5,
    idleTimeoutMillis: 30_000, // close idle sockets before Neon suspends the compute (5 min)
    connectionTimeoutMillis: 20_000, // waking a suspended compute can take a moment
    query_timeout: 20_000, // server-side statement_timeout can't be set through the pooler
    keepAlive: true,
    maxLifetimeSeconds: 300,
  };
}

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool(poolConfig(databaseUrl));
  // Idle clients get terminated when Neon suspends; without a listener this would crash the process.
  pool.on('error', (err) => log.warn('db', 'idle client error', { error: err.message }));
  return pool;
}

/** Neon's direct (non-pooler) endpoint: recommended for DDL/migrations. */
export function directUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.hostname = url.hostname.replace('-pooler.', '.');
  return url.toString();
}

export async function migrate(databaseUrl: string): Promise<void> {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client(poolConfig(directUrl(databaseUrl)));
  await client.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent boots (Render overlaps old/new instances during a deploy).
    await client.query('SELECT pg_advisory_xact_lock(8734466823)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, dir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      log.info('db', `applied migration ${file}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}
