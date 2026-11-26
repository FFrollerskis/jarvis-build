import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidEnvValueError } from "@jarvis/contracts";
import { DB_CONNECT_TIMEOUT_DEFAULT_MS, connectionTimeoutFromEnv, createPool, withTenantTransaction, type DbConfig } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * WP-G2c (D-483, JARVIS-113 d / JARVIS-115 e, Q-73 pkt 14): `createPool` har nå et tidsavbrudd for å FÅ en forbindelse (`connectionTimeoutMillis`). Før hang hvert kall uten øvre grense når poolen (max 10) var tom
 * (G2 delta-review B INFO-B: 1 504 ms med poolen opptatt; ubegrenset i verste fall; G2 NY-1: en dødlås der alle forbindelser ventet på hverandre ble aldri en synlig feil).
 *  A. env-parsing (ren funksjon): standard, `0` = ingen grense, grenser, ugyldig = oppstartsfeil.
 *  B. ekte Postgres: (i) full pool gir en tydelig, RASK feil (også via `query` og `withTenantTransaction`) og poolen er hel etterpå, (ii) normal bruk er uendret (kø som blir betjent, standardverdier), (iii) feilen lekker ikke
 *     passord/bruker/database/vert/port - verken for en full pool eller en forbindelse som aldri kommer opp (en lytter som aldri svarer), `0` = ingen grense (gammel oppførsel).
 *  C. vakt: variabelen står i `SERVICE_ENV` for ALLE tjenestene som lager en pool (api, worker, migrate), i compose og i `.env.example`; hver produksjonsfil som kaller `createPool` er med i tjenestekartet (en ny uten kart feller testen).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SENTINEL_PASSWORD = "sentinel-not-a-secret"; // en oppdiktet, distinkt streng som aldri skal dukke opp i en feilmelding (ikke en ekte hemmelighet)
const SENTINEL_USER = "jarvis_wpg2c_sentinel_user";

let stopPg: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let config: DbConfig;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g2c-pool-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopPg = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" }, { JARVIS_DB_CONNECT_TIMEOUT_MS: "0" });
  admin.on("error", () => undefined);
  await admin.query(`CREATE ROLE ${SENTINEL_USER} LOGIN PASSWORD '${SENTINEL_PASSWORD}'`);
  config = { host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: SENTINEL_USER, password: SENTINEL_PASSWORD };
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await stopPg?.();
}, 120_000);

const poolOf = (timeoutMs: string | undefined): pg.Pool => {
  const pool = createPool(config, timeoutMs === undefined ? {} : { JARVIS_DB_CONNECT_TIMEOUT_MS: timeoutMs });
  pool.on("error", () => undefined);
  return pool;
};

/** Holder alle 10 forbindelser i poolen (poolen er full: neste `connect()` må vente). */
async function exhaust(pool: pg.Pool): Promise<pg.PoolClient[]> {
  const held = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
  expect(pool.totalCount).toBe(10);
  expect(pool.idleCount).toBe(0);
  return held;
}

const settle = async (p: Promise<unknown>): Promise<{ ok: boolean; error?: Error; ms: number }> => {
  const started = Date.now();
  try {
    await p;
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error as Error, ms: Date.now() - started };
  }
};

/** Alt en feil kan bære ut (melding, stakk, JSON, Node-inspeksjon inkl. `cause`-kjeden): ingen del av tilkoblingen eller passordet. */
function surface(error: Error): string {
  return [error.message, error.stack ?? "", JSON.stringify(error, Object.getOwnPropertyNames(error)), inspect(error, { depth: 8, showHidden: true })].join("\n");
}
function expectNoConnectionDetails(error: Error, ...ports: number[]): void {
  const text = surface(error);
  for (const secret of [SENTINEL_PASSWORD, SENTINEL_USER, "jarvis_test", "127.0.0.1", String(config.port), ...ports.map(String), "postgres://", "postgresql://"]) expect(text, secret).not.toContain(secret);
}

describe("A: connectionTimeoutFromEnv (ren funksjon)", () => {
  it("usatt og blank gir standarden (30 000 ms, generøst); `0` = ingen grense; 1000-600000 godtas", () => {
    expect(DB_CONNECT_TIMEOUT_DEFAULT_MS).toBe(30_000);
    expect(connectionTimeoutFromEnv({})).toBe(30_000);
    expect(connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: "" })).toBe(30_000); // `KEY=` i .env / compose `${X:-}`
    expect(connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: "   " })).toBe(30_000);
    expect(connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: "0" })).toBe(0);
    expect(connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: " 0 " })).toBe(0);
    for (const ok of ["1000", "2500", "30000", "600000"]) expect(connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: ok })).toBe(Number(ok));
  });

  it("ugyldig verdi STOPPER oppstarten (aldri en stille standard og aldri en for lav grense som gir falske feil): under 1000, over 600000, brøk, negativt, ikke-tall, `00`", () => {
    for (const bad of ["1", "5", "999", "600001", "1.5", "-1", "-0", "abc", "30s", "00", "0x10", "NaN", "Infinity"]) {
      expect(() => connectionTimeoutFromEnv({ JARVIS_DB_CONNECT_TIMEOUT_MS: bad }), bad).toThrow(InvalidEnvValueError);
    }
  });

  it("createPool bruker verdien: standard uten env, eksplisitt verdi, `0`; poolen er fortsatt `max: 10` og feilhåndtereren for idle-klienter er på plass", () => {
    const standard = createPool(config, {});
    const custom = createPool(config, { JARVIS_DB_CONNECT_TIMEOUT_MS: "4200" });
    const unlimited = createPool(config, { JARVIS_DB_CONNECT_TIMEOUT_MS: "0" });
    try {
      const optionsOf = (p: pg.Pool): { max: number; connectionTimeoutMillis: number } => (p as unknown as { options: { max: number; connectionTimeoutMillis: number } }).options;
      expect(optionsOf(standard)).toMatchObject({ max: 10, connectionTimeoutMillis: 30_000 });
      expect(optionsOf(custom)).toMatchObject({ max: 10, connectionTimeoutMillis: 4_200 });
      expect(optionsOf(unlimited)).toMatchObject({ max: 10, connectionTimeoutMillis: 0 });
      expect(standard.listenerCount("error")).toBe(1);
    } finally {
      void standard.end(); void custom.end(); void unlimited.end();
    }
    expect(() => createPool(config, { JARVIS_DB_CONNECT_TIMEOUT_MS: "12" })).toThrow(InvalidEnvValueError);
  });
});

describe("B: ekte Postgres", () => {
  it("(i) en full pool: connect(), query() og withTenantTransaction() gir en tydelig feil RASKT (omtrent fristen, ikke hengende), uten tilkoblingsdetaljer; poolen er hel etterpå og køen er tom", async () => {
    const pool = poolOf("1000");
    const held = await exhaust(pool);
    try {
      const connect = await settle(pool.connect());
      const query = await settle(pool.query("SELECT 1"));
      const tx = await settle(withTenantTransaction(pool, "tenant-g2c", async (c) => c.query("SELECT 1")));
      for (const r of [connect, query, tx]) {
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/timeout exceeded when trying to connect/);
        expect(r.ms, "fristen er 1000 ms: ikke før (feilen skal ikke komme umiddelbart) og ikke mye etter").toBeGreaterThanOrEqual(900);
        expect(r.ms).toBeLessThan(4_000);
        expectNoConnectionDetails(r.error as Error);
      }
      expect(pool.waitingCount, "de timede ut kallene er fjernet fra køen").toBe(0);
    } finally {
      for (const c of held) c.release();
    }
    // Poolen er ikke forgiftet: forbindelsene er tilbake og et nytt kall går gjennom umiddelbart.
    expect((await pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
    expect(pool.totalCount).toBeLessThanOrEqual(10);
    await pool.end();
  }, 30_000);

  it("(ii) normal bruk er uendret: kall som må VENTE på en ledig forbindelse (30 samtidige mot 10) blir alle betjent når forbindelser frigis innen fristen; standardpoolen kan brukes som før", async () => {
    const pool = poolOf("5000");
    const held = await exhaust(pool);
    const waiting = Array.from({ length: 30 }, (_v, i) => pool.query("SELECT $1::int AS n", [i]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pool.waitingCount, "30 kall venter i køen").toBe(30);
    for (const c of held) c.release();
    const results = await Promise.all(waiting);
    expect(results.map((r) => (r.rows[0] as { n: number }).n)).toEqual(Array.from({ length: 30 }, (_v, i) => i));
    expect(pool.waitingCount).toBe(0);
    await pool.end();

    const standard = poolOf(undefined);
    expect((await standard.query("SELECT 41 + 1 AS answer")).rows[0]).toEqual({ answer: 42 });
    await withTenantTransaction(standard, "tenant-g2c", async (c) => {
      expect(((await c.query("SELECT current_setting('jarvis.tenant_id') AS t")).rows[0] as { t: string }).t).toBe("tenant-g2c");
    });
    await standard.end();
  }, 30_000);

  it("`0` = INGEN grense (gammel oppførsel): et kall mot en full pool venter og blir betjent først når en forbindelse frigis", async () => {
    const pool = poolOf("0");
    const held = await exhaust(pool);
    const waiting = pool.query("SELECT 7 AS n");
    let state = "pending";
    void waiting.then(() => { state = "resolved"; }, () => { state = "rejected"; });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(state, "etter 2,5 s er kallet fortsatt i kø (ingen frist)").toBe("pending");
    held[0]?.release();
    expect(((await waiting).rows[0] as { n: number }).n).toBe(7);
    for (const c of held.slice(1)) c.release();
    await pool.end();
  }, 30_000);

  it("(iii) en NY forbindelse som aldri kommer opp (en lytter som tar imot TCP og aldri svarer) gir også en rask feil uten passord, bruker, database, vert eller port", async () => {
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => { sockets.push(socket); socket.on("error", () => undefined); });
    await new Promise<void>((resolveListen) => silent.listen(0, "127.0.0.1", resolveListen));
    const port = (silent.address() as { port: number }).port;
    const pool = createPool({ ...config, port }, { JARVIS_DB_CONNECT_TIMEOUT_MS: "1000" });
    pool.on("error", () => undefined);
    try {
      const r = await settle(pool.connect());
      expect(r.ok).toBe(false);
      expect(r.ms).toBeGreaterThanOrEqual(900);
      expect(r.ms).toBeLessThan(5_000);
      expect(r.error?.message).toMatch(/timeout|terminated/i);
      expectNoConnectionDetails(r.error as Error, port);
      expect(pool.totalCount, "den døde klienten er fjernet fra poolen").toBe(0);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
      await pool.end().catch(() => undefined);
    }
  }, 30_000);
});

describe("C: vakt - variabelen når ALLE tjenester som lager en pool", () => {
  const NAME = "JARVIS_DB_CONNECT_TIMEOUT_MS";
  /** Hver produksjonsfil som kaller `createPool(` -> tjenesten (compose) den kjører i. CLI-ene kjøres med `docker compose run/exec` mot api-/migrate-bildet og får dermed den tjenestens miljø. */
  const POOL_OWNERS: Readonly<Record<string, string>> = {
    "apps/api/src/main.ts": "api",
    "apps/api/src/product-usage-main.ts": "api",
    "apps/api/src/enroll-ticket-main.ts": "api",
    "apps/api/src/provision-business-tenant-main.ts": "api",
    "apps/api/src/worker-main.ts": "worker",
    "apps/api/src/migrate-main.ts": "migrate",
    "modules/core/src/db/migrator.ts": "migrate"
  };

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "dist", "test", "scripts", ".git"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) productionFiles(full, out);
      else if (/\.(ts|mjs)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  it("hver produksjonsfil som kaller createPool er i tjenestekartet (en ny uten kart feller testen), og kartets tjenester har variabelen i SERVICE_ENV", () => {
    const callers = ["apps", "modules", "packages"].flatMap((r) => productionFiles(join(ROOT, r)))
      .filter((f) => /\bcreatePool\(/.test(readFileSync(f, "utf8")) && !f.endsWith(join("db", "pool.ts")))
      .map((f) => relative(ROOT, f).replaceAll("\\", "/")).sort();
    expect(callers.length).toBeGreaterThan(3); // sanity: skanneren finner noe
    expect(callers, "kartlegg tjenesten til en NY pool-oppretter i POOL_OWNERS (og sørg for at tjenesten har variabelen i SERVICE_ENV)").toEqual(Object.keys(POOL_OWNERS).sort());
    for (const service of new Set(Object.values(POOL_OWNERS))) expect((SERVICE_ENV as Record<string, string[]>)[service], service).toContain(NAME);
  });

  it("tjenester uten pool (voice, browser) får den ikke; compose har variabelen som ren videresending for api, worker og migrate; .env.example dokumenterer den; env-parsingen står i pool.ts", () => {
    for (const service of ["voice", "browser"]) expect((SERVICE_ENV as Record<string, string[]>)[service], service).not.toContain(NAME);
    const compose = readFileSync(join(ROOT, "infra/local/docker-compose.yml"), "utf8");
    const forwarded = compose.split("\n").filter((l) => l.trim() === `${NAME}: "\${${NAME}:-}"`);
    expect(forwarded.length, "api + worker + migrate").toBe(3);
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).toMatch(new RegExp(`^# ${NAME}=30000$`, "m"));
    expect(readFileSync(join(ROOT, "modules/core/src/db/pool.ts"), "utf8")).toContain(`envInt("${NAME}"`);
  });

  it("den delte semaforen i G4 (`advisory-lock.ts`) er uendret: ingen tidsavbrudd-/pool-endring der (kun createPool er rørt)", () => {
    const source = readFileSync(join(ROOT, "modules/situations/src/advisory-lock.ts"), "utf8");
    expect(source).not.toContain("connectionTimeoutMillis");
    expect(source).not.toContain("JARVIS_DB_CONNECT_TIMEOUT_MS");
  });
});
