import pg from "pg";
import { envInt } from "@jarvis/contracts";

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

/**
 * WP-G2c (D-483, JARVIS-113 d / JARVIS-115 e, Q-73 pkt 14): TIDSAVBRUDD FOR Å FÅ EN FORBINDELSE fra den delte poolen (`connectionTimeoutMillis`).
 * Før: poolen har `max: 10` og INGEN grense for ventetiden - ved generell uttømming (en annen tjeneste som holder forbindelser, en hengende transaksjon, en dødlås som G2 NY-1 viste) ventet hvert nytt kall uten
 * øvre grense, og feilen ble aldri synlig. Nå gir et kall som ikke får en forbindelse innen fristen en tydelig, rask feil (`timeout exceeded when trying to connect` for en full pool,
 * `Connection terminated due to connection timeout` når en NY forbindelse ikke kommer opp) - uten tilkoblingsstreng, vert eller passord i meldingen - og kalleren kan svare/logge i stedet for å henge.
 *
 * STANDARD 30 000 ms er bevisst GENERØS: forbindelser holdes kun mens en transaksjon kjører (leverandørkall, modellkall og readback holder ingen pool-forbindelse, gatewayen er bygget slik: JARVIS-022), normale
 * transaksjoner tar millisekunder til sekunder, og 30 s er også fristen G4 gir `domain_lock_busy`. Tunge, men normale jobber (sveip, migrasjoner, eksport) får dermed aldri falske feil, men en pool som er tom i et halvt minutt
 * er en feil som SKAL bli synlig. `JARVIS_DB_CONNECT_TIMEOUT_MS=0` = INGEN grense (gammel oppførsel); ellers 1000-600000 ms. Tom/usatt = standarden; en ugyldig verdi STOPPER oppstarten (`envInt`, samme
 * semantikk som øvrige tallvariabler: aldri en stille standard). Gjelder KUN å få en forbindelse - en spørring som allerede kjører avbrytes ikke. `modules/situations/src/advisory-lock.ts` (prosess-lokal semafor, G4) er uendret.
 */
export const DB_CONNECT_TIMEOUT_DEFAULT_MS = 30_000;
export const DB_CONNECT_TIMEOUT_BOUNDS = { min: 1_000, max: 600_000 } as const;

/** Tidsavbruddet (ms) fra miljøet: `0` = ingen grense, ellers 1000-600000, usatt/blank = `DB_CONNECT_TIMEOUT_DEFAULT_MS`. Kaster `InvalidEnvValueError` ved en ugyldig verdi. */
export function connectionTimeoutFromEnv(env: Record<string, string | undefined> = process.env): number {
  if (env["JARVIS_DB_CONNECT_TIMEOUT_MS"]?.trim() === "0") return 0;
  return envInt("JARVIS_DB_CONNECT_TIMEOUT_MS", DB_CONNECT_TIMEOUT_DEFAULT_MS, DB_CONNECT_TIMEOUT_BOUNDS, env);
}

export function createPool(config: DbConfig, env: Record<string, string | undefined> = process.env): pg.Pool {
  const pool = new pg.Pool({ ...config, max: 10, connectionTimeoutMillis: connectionTimeoutFromEnv(env) });
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
