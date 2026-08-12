import pg from "pg";

/**
 * Tilkobling konfigureres utelukkende via miljø/parametre - ingen hardkodede
 * maskiner eller stier (D-20: flyttbart mellom dev-PC, UGREEN-NAS og senere noder).
 */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env["JARVIS_DB_HOST"] ?? "127.0.0.1",
    port: Number(env["JARVIS_DB_PORT"] ?? 5432),
    database: env["JARVIS_DB_NAME"] ?? "jarvis",
    user: env["JARVIS_DB_USER"] ?? "jarvis_app",
    ...(env["JARVIS_DB_PASSWORD"] !== undefined ? { password: env["JARVIS_DB_PASSWORD"] } : {})
  };
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({ ...config, max: 10 });
}

/**
 * Kjør fn i en transaksjon med tenant-kontekst satt for RLS.
 * `SET LOCAL` gjelder kun transaksjonen - ingen lekkasje mellom kall i poolen.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
