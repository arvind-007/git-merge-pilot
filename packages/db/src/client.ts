import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Schema = typeof schema;
/** Drizzle database handle with the full schema (relational `db.query.*` API enabled). */
export type Database = NodePgDatabase<Schema>;
/** A transaction handle; usable anywhere a Database is expected for queries. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either a database or a transaction. */
export type DbOrTx = Database | Transaction;

export interface CreateDbOptions {
  /** Max pool size (default 10). */
  max?: number;
  /** Application name reported to Postgres (default "git-merge-pilot"). */
  applicationName?: string;
  /** Idle client timeout in ms (default 30s). */
  idleTimeoutMillis?: number;
  /** Connection timeout in ms (default 10s). */
  connectionTimeoutMillis?: number;
  /** Optional hook for pool-level errors (idle client errors would otherwise crash the process). */
  onPoolError?: (err: Error) => void;
}

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

// Return int8 (bigint) and numeric as JS numbers: GitHub ids fit in 2^53 and costs are small.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)) as number);

/** Creates a pooled Drizzle client. Call `close()` on shutdown. */
export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'git-merge-pilot',
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });
  pool.on('error', (err) => {
    options.onPoolError?.(err);
  });
  const db = drizzle(pool, { schema });
  let closed = false;
  return {
    db,
    pool,
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
