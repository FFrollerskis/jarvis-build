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

/**
 * Q-21 (UA-2 P0 host-blocker, 2026-08-15): dette er RUNTIME-config - den appen
 * (api/worker og andre normale prosesser) faktisk kobler til databasen med.
 * MÅ ALDRI være en superbruker/BYPASSRLS-rolle - default-navnet er derfor en
 * ekte bootstrappbar LOGIN-rolle (`jarvis_runtime`, se services/runtime-role.ts),
 * IKKE `jarvis_app` (som er en NOLOGIN gruppe-rolle, 005_rls.sql - kan aldri
 * logges inn med direkte).
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env["JARVIS_DB_HOST"] ?? "127.0.0.1",
    port: Number(env["JARVIS_DB_PORT"] ?? 5432),
    database: env["JARVIS_DB_NAME"] ?? "jarvis",
    user: env["JARVIS_DB_USER"] ?? "jarvis_runtime",
    ...(env["JARVIS_DB_PASSWORD"] !== undefined ? { password: env["JARVIS_DB_PASSWORD"] } : {})
  };
}

/**
 * Q-21: ADMIN-config - KUN for migrasjoner/bootstrap (`migrate-main.ts`), ALDRI
 * for løpende app-runtime. Samme credential-par docker-compose sin Postgres-
 * container selv bootstrapper med (POSTGRES_USER/PASSWORD), allerede i
 * `.env.example`.
 */
export function adminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env["JARVIS_DB_HOST"] ?? "127.0.0.1",
    port: Number(env["JARVIS_DB_PORT"] ?? 5432),
    database: env["JARVIS_DB_NAME"] ?? "jarvis",
    user: env["JARVIS_DB_ADMIN_USER"] ?? "postgres",
    ...(env["JARVIS_DB_ADMIN_PASSWORD"] !== undefined ? { password: env["JARVIS_DB_ADMIN_PASSWORD"] } : {})
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
