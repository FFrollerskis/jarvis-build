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
  const pool = new pg.Pool({ ...config, max: 10 });
  // pg-beste-praksis (BO-11.1): en idle klient som termineres av serveren
  // (restart/failover/nedkobling, FATAL 57P01) emitterer 'error' på poolen -
  // uhåndtert kræsjer det hele prosessen. Neste query får uansett frisk klient.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ msg: "pg_pool_idle_client_error", error: err.message.slice(0, 120) }));
  });
  return pool;
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
