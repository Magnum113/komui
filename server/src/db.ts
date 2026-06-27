import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppConfig } from "./config";

export type Db = ReturnType<typeof createDb>;

export function createDb(config: AppConfig) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: config.NODE_ENV === "test",
    application_name: "komui-backend",
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS + 1_000,
    idle_in_transaction_session_timeout: 5_000,
  });

  async function query<T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ) {
    return pool.query<T>(text, values);
  }

  async function withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    query,
    withTransaction,
    async ping() {
      const result = await query<{ ok: number; database_name: string }>(
        "select 1 as ok, current_database() as database_name",
      );
      return result.rows[0];
    },
    async close() {
      await pool.end();
    },
  };
}
