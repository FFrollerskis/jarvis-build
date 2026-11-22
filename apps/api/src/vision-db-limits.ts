import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

/**
 * WP-G3 (D-465), mikro-runde 3 (review delta2 B LOW-E2): databasegrenser for VEDLIKEHOLDETS egne transaksjoner - uten å røre den delte `createPool` (modules/core/src/db/pool.ts).
 *
 * Problemet: poolen har ingen `statement_timeout`/`lock_timeout`. Et vedlikeholdskall som aldri returnerer (en forlatt tabell-lås, en hengt forbindelse) holdt «lett vedlikehold» fast for alltid: overlappsvakten
 * hoppet over alle senere tikk til prosessen ble startet på nytt, og bilder kunne bli stående forbi retensjonen. Vakten alene hjelper ikke - den må kunne slippes, og kallet må kunne FEILE.
 *
 * Løsningen er omfangsbasert og lokal for visjonskjøretiden: `limitedPool(pool)` gir en pool med nøyaktig samme grensesnitt, og `runWithDbLimits(limits, fn)` (AsyncLocalStorage) markerer at ALLE transaksjoner
 * som åpnes gjennom den poolen i `fn` sin asynkrone kjede - uansett hvilken tjeneste som åpner dem - starter med `SET LOCAL statement_timeout` og `SET LOCAL lock_timeout`. `SET LOCAL` gjelder kun den
 * transaksjonen: ingenting lekker til neste bruker av forbindelsen, og utenfor `runWithDbLimits` er poolen uendret (ingen grenser, ingen ekstra rundtur).
 *  - `pool.connect()`: forbindelsen pakkes slik at `client.query("BEGIN")` (`withMemoryTransaction`, `withTenantTransaction`) etterfølges av grensene, før noe annet i transaksjonen.
 *  - `pool.query(...)` (enkeltspørringer utenfor transaksjon, f.eks. `listAllTenantIds`): kjøres i en egen kort transaksjon med grensene. Utenfor omfanget gjennomføres kallet uendret.
 * En grense som slår til gir SQLSTATE `57014` (statement_timeout) eller `55P03` (lock_timeout): transaksjonen ruller tilbake som ved enhver annen feil, og sveipets per-space-isolasjon teller og logger feilen.
 * `0` betyr «ingen grense» (Postgres-standard) for den ene verdien.
 */
export interface DbLimits {
  /** Maksimal kjøretid per SQL-setning (ms). */
  statementTimeoutMs: number;
  /** Maksimal ventetid på en lås (ms). */
  lockTimeoutMs: number;
}

const MAX_LIMIT_MS = 2_147_483_647; // Postgres: heltall (int4) millisekunder
const scope = new AsyncLocalStorage<DbLimits>();
const BEGIN = /^\s*BEGIN\b/i;
type AnyCall = (...args: unknown[]) => unknown;

/** Kaster `vision_db_limits_invalid` for en ugyldig grense (heltall 0..2 147 483 647; 0 = ingen grense). Kjøres også ved oppstart, så en feilkonfigurasjon aldri først viser seg under en vedlikeholdskjøring. */
export function assertDbLimits(limits: DbLimits): void {
  for (const value of [limits.statementTimeoutMs, limits.lockTimeoutMs]) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT_MS) throw new Error("vision_db_limits_invalid");
  }
}

/** Kjør `fn` med databasegrenser for hver transaksjon som åpnes via en `limitedPool` i dens asynkrone kjede. Gyldige verdier: heltall 0..2 147 483 647 (0 = ingen grense). */
export function runWithDbLimits<T>(limits: DbLimits, fn: () => Promise<T>): Promise<T> {
  assertDbLimits(limits);
  return scope.run({ ...limits }, fn);
}

/** Grensene som gjelder akkurat nå (i en `runWithDbLimits`-kjede), ellers `undefined`. */
export function currentDbLimits(): DbLimits | undefined {
  return scope.getStore();
}

async function setLocalLimits(client: pg.PoolClient, limits: DbLimits): Promise<void> {
  // Heltall validert i assertLimits (ingen injeksjon mulig). Én enkel spørring med to setninger = én rundtur.
  await client.query(`SET LOCAL statement_timeout = ${limits.statementTimeoutMs}; SET LOCAL lock_timeout = ${limits.lockTimeoutMs}`);
}

function bound(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop, target) as unknown;
  return typeof value === "function" ? (value as AnyCall).bind(target) : value;
}

function limitClient(client: pg.PoolClient): pg.PoolClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return async (...args: unknown[]): Promise<unknown> => {
          const result = await (target.query as unknown as AnyCall).apply(target, args);
          const limits = scope.getStore();
          // `BEGIN` (også `BEGIN ISOLATION LEVEL ...`): grensene settes FØRST i transaksjonen, før tenant-/space-konteksten og selve arbeidet.
          if (limits !== undefined && typeof args[0] === "string" && BEGIN.test(args[0])) await setLocalLimits(target, limits);
          return result;
        };
      }
      return bound(target, prop);
    }
  });
}

/** En pool med samme grensesnitt som `pool`, som legger på `runWithDbLimits`-grensene i hver transaksjon åpnet innenfor omfanget. Uten omfang er den gjennomsiktig. */
export function limitedPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect") {
        return (...args: unknown[]): unknown => {
          if (args.length > 0) return (target.connect as unknown as AnyCall).apply(target, args); // callback-formen brukes ikke av visjonskoden: uendret
          return target.connect().then(limitClient);
        };
      }
      if (prop === "query") {
        return async (...args: unknown[]): Promise<unknown> => {
          const limits = scope.getStore();
          if (limits === undefined) return (target.query as unknown as AnyCall).apply(target, args);
          const client = await target.connect();
          try {
            await client.query("BEGIN");
            await setLocalLimits(client, limits);
            const result = await (client.query as unknown as AnyCall).apply(client, args);
            await client.query("COMMIT");
            return result;
          } catch (err) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        };
      }
      return bound(target, prop);
    }
  });
}
