/**
 * Oppstart av embedded Postgres med FENCED LEIE og PROTOKOLLBEVIS (D-141 B).
 *
 * ------------------------------------------------------------------------
 * HVORFOR EN TCP-FORBINDELSE IKKE ER ET BEVIS
 * ------------------------------------------------------------------------
 *
 * D-137 fant at Postgres behandler en DELVIS bind-feil som ikke-fatal: den
 * binder IPv6 og unix-socketen, logger
 *
 *     could not bind IPv4 address "127.0.0.1": Address already in use
 *
 * og melder likevel `database system is ready to accept connections`.
 *
 * D-139 svarte med aa kreve en faktisk TCP-forbindelse til 127.0.0.1. Det var et
 * skritt i riktig retning, men beviste feil ting. En vellykket `connect()` sier
 * bare at NOEN lytter - ikke at det er VAAR Postgres. Nettopp derfor beviste
 * D-139 sin egen test at en generisk `net.createServer()` tilfredsstilte kravet.
 * Det er check-to-bind-motstanderen i ren form:
 *
 *     1. vi prober porten            -> ledig
 *     2. en fremmed lytter binder    -> IPv4 er tatt
 *     3. Postgres starter            -> IPv6 + socket, IPv4 feiler, "ready"
 *     4. TCP-proben lykkes           -> mot den FREMMEDE lytteren
 *     5. migrasjonene kobler til     -> og snakker med feil motpart
 *
 * Derfor er verdiktet her et EKTE PostgreSQL-protokollbevis: startup-pakke,
 * autentisering med instansens egne credentials, og en sporring som svarer paa
 * hvem serveren faktisk er. En generisk TCP-lytter kommer ikke forbi punkt én.
 *
 * ------------------------------------------------------------------------
 * HVA BEVISET FAKTISK SLAAR FAST
 * ------------------------------------------------------------------------
 *
 *   `inet_server_addr() = 127.0.0.1`  IPv4-socketen - ikke IPv6, ikke unix.
 *                                     Det er noeyaktig bindingen D-137 mistet.
 *   `inet_server_port() = leid port`  samme port som leien vaar gjelder.
 *   autentisering lykkes              en fremmed Postgres med andre credentials
 *                                     slipper ikke gjennom.
 *   `pg_postmaster_start_time()`      postmasteren ble startet av OSS, ikke en
 *                                     klynge som allerede laa der.
 *
 * Feiler noe av dette, stoppes instansen, KUN vaar egen leie frigjoeres, porten
 * utelukkes, og vi gaar bundet videre til neste kandidat.
 */

import { connect, createServer } from "node:net";

import pg from "pg";

import { acquirePortLease, type AcquireOptions, type PortLease } from "./port-lease.ts";

/**
 * Det minimum av `embedded-postgres` denne modulen trenger.
 *
 * Bevisst strukturell: `@jarvis/core` skal ikke dra inn embedded-postgres som
 * avhengighet bare for aa kunne typebeskrive den.
 */
export interface EmbeddedPostgresLike {
  initialise(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

/** Credentials proben bruker. Maa vaere de instansen faktisk ble startet med. */
export interface PostgresIdentity {
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Standarden de aller fleste kallstedene allerede bruker.
 *
 * Et avvik her er ikke stille: proben feiler autentisering, instansen forkastes,
 * og feilmeldingen navngir credentials-settet. Kallsteder med andre credentials
 * sender dem eksplisitt.
 */
export const DEFAULT_PROBE_IDENTITY: PostgresIdentity = Object.freeze({
  user: "postgres",
  password: "pw",
  database: "postgres"
});

export interface PostgresIdentityProof {
  readonly port: number;
  readonly server_addr: string;
  readonly server_port: number;
  readonly postmaster_start_time_ms: number;
  readonly server_version: string;
  readonly attempts: number;
}

/**
 * `retryable` skiller "ikke oppe ENDA" fra "ikke VAAR".
 *
 * Forskjellen er avgjoerende: det foerste skal vi vente ut, det andre skal aldri
 * kunne vente seg til et ja.
 */
export class PostgresIdentityError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "PostgresIdentityError";
  }
}

/** Tilstander som betyr "serveren er ikke ferdig oppe", ikke "feil server". */
const RETRYABLE_SYSCALL = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH"]);
const RETRYABLE_SQLSTATE = new Set(["57P03", "53300", "08000", "08001", "08004", "08006"]);

function classify(err: unknown): PostgresIdentityError {
  if (err instanceof PostgresIdentityError) return err;
  const e = err as { code?: string; message?: string };
  const code = typeof e?.code === "string" ? e.code : "";
  const message = String(e?.message ?? err);
  // En timeout kan vaere en Postgres som fortsatt starter - ELLER en fremmed
  // lytter som tar imot socketen og aldri svarer paa startup-pakken. Begge
  // taaler aa bli proevd om igjen; tidsbudsjettet avgjoer naar vi gir opp.
  const retryable =
    RETRYABLE_SYSCALL.has(code) ||
    RETRYABLE_SQLSTATE.has(code) ||
    /timeout|timed out|terminated unexpectedly|Connection terminated/i.test(message);
  return new PostgresIdentityError((code ? code + ": " : "") + message, retryable);
}

/**
 * Er noe allerede bundet til 127.0.0.1 paa denne porten?
 *
 * `exclusive: true` slaar av portdeling, slik at svaret gjelder IPv4 spesifikt.
 * Dette er et FILTER som sparer oss for en unoedvendig initdb - ALDRI verdiktet.
 * En check-then-close-probe er per definisjon utdatert i det den returnerer;
 * sannheten kommer fra `assertPostgresIdentityIPv4` etter at serveren staar.
 */
export async function ipv4PortIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    const done = (free: boolean) => {
      server.removeAllListeners();
      try {
        server.close(() => resolve(free));
      } catch {
        resolve(free);
      }
    };
    server.once("error", () => done(false));
    server.once("listening", () => done(true));
    try {
      server.listen({ port, host: "127.0.0.1", exclusive: true });
    } catch {
      done(false);
    }
  });
}

/**
 * Lytter NOEN paa 127.0.0.1:port?
 *
 * Beholdt som diagnostikk - den skiller "ingenting der" fra "noe der som ikke er
 * Postgres" i feilmeldingene. Den er aldri et selvstendig klar-verdikt.
 */
export function tcpReachableIPv4(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface IdentityProbeOptions {
  /** Samlet tidsbudsjett for aa faa et gyldig bevis. */
  readonly timeoutMs?: number;
  /**
   * Tidspunktet VI startet instansen. En postmaster som ble startet foer dette
   * er noen andres klynge, ikke vaar.
   */
  readonly notBeforeMs?: number;
  /** Slingringsmonn for klokkeopploesning mellom klient og server. */
  readonly clockToleranceMs?: number;
}

/**
 * Krev et EKTE PostgreSQL-identitetsbevis paa 127.0.0.1:port, eller kast.
 *
 * Retry gjelder KUN tilstander som betyr "ikke oppe enda". En fremmed identitet
 * - feil credentials, feil database, feil adresse, feil port, en postmaster
 * eldre enn oss - er endelig med én gang. Den skal ikke kunne vente seg til et
 * ja mens tidsbudsjettet renner ut.
 */
export async function assertPostgresIdentityIPv4(
  port: number,
  identity: PostgresIdentity = DEFAULT_PROBE_IDENTITY,
  options: IdentityProbeOptions = {}
): Promise<PostgresIdentityProof> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clockToleranceMs = options.clockToleranceMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = "(ingen forsoek rakk aa kjoere)";

  while (Date.now() < deadline) {
    attempts++;
    const remaining = Math.max(500, deadline - Date.now());
    const budget = Math.min(5_000, remaining);
    const client = new pg.Client({
      host: "127.0.0.1",
      port,
      user: identity.user,
      password: identity.password,
      database: identity.database,
      application_name: "jarvis-pg-identity-probe",
      connectionTimeoutMillis: budget,
      query_timeout: budget,
      statement_timeout: budget,
      ssl: false
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      const res = await client.query(
        "SELECT host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port, " +
          "extract(epoch from pg_postmaster_start_time()) * 1000 AS started_at_ms, version() AS server_version"
      );
      const row = (res.rows[0] ?? {}) as Record<string, unknown>;

      // IPv4-socketen spesifikt. En unix-socket eller IPv6-forbindelse ville gitt
      // noe annet her - og det er noeyaktig bindingen D-137 mistet uten aa si fra.
      const serverAddr = String(row["server_addr"] ?? "");
      if (serverAddr !== "127.0.0.1") {
        throw new PostgresIdentityError(
          "serveren rapporterer inet_server_addr() = " + (serverAddr || "(null)") + ", ikke 127.0.0.1. " +
            "Forbindelsen gaar ikke over IPv4-loopback.",
          false
        );
      }

      const serverPort = Number(row["server_port"]);
      if (!Number.isInteger(serverPort) || serverPort !== port) {
        throw new PostgresIdentityError(
          "serveren rapporterer inet_server_port() = " + String(row["server_port"]) + ", ikke den leide porten " + port + ".",
          false
        );
      }

      const startedAtMs = Number(row["started_at_ms"]);
      if (!Number.isFinite(startedAtMs)) {
        throw new PostgresIdentityError("serveren ga ingen lesbar pg_postmaster_start_time().", false);
      }
      if (options.notBeforeMs !== undefined && startedAtMs < options.notBeforeMs - clockToleranceMs) {
        throw new PostgresIdentityError(
          "postmasteren paa port " + port + " ble startet " + new Date(startedAtMs).toISOString() + ", altsaa FOER vi startet " +
            "vaar egen instans (" + new Date(options.notBeforeMs).toISOString() + "). Dette er en fremmed klynge.",
          false
        );
      }

      return {
        port,
        server_addr: serverAddr,
        server_port: serverPort,
        postmaster_start_time_ms: startedAtMs,
        server_version: String(row["server_version"] ?? ""),
        attempts
      };
    } catch (err) {
      const classified = classify(err);
      last = classified.message;
      if (!classified.retryable) {
        throw new PostgresIdentityError(
          "PostgreSQL-identitetsbeviset paa 127.0.0.1:" + port + " ble AVVIST (" + identity.user + "@" + identity.database +
            ", forsoek " + attempts + "): " + classified.message,
          false
        );
      }
    } finally {
      try {
        await client.end();
      } catch {
        // Proben er ferdig; en feil under nedrigging endrer ingen verdikt.
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  const reachable = await tcpReachableIPv4(port, 1_000);
  throw new Error(
    "Postgres meldte klar, men leverte INTET gyldig PostgreSQL-identitetsbevis paa IPv4 127.0.0.1:" + port + " etter " +
      attempts + " forsoek (" + timeoutMs + " ms). TCP-naboen svarte: " +
      (reachable
        ? "JA - noe lytter der, men det snakker ikke PostgreSQL med vaare credentials (check-to-bind-motstanderen, D-141 B.3)"
        : "NEI - ingenting lytter paa IPv4; dette er den delvise bind-feilen fra D-137") +
      ". Siste feil: " + last + ". Feiler lukket."
  );
}

export interface LeasedEmbeddedPostgres<T extends EmbeddedPostgresLike> {
  readonly postgres: T;
  readonly port: number;
  readonly lease: PortLease;
  /** Beviset denne instansen faktisk besto. */
  readonly proof: PostgresIdentityProof;
  /** Stopper Postgres og frigjoer KUN vaar egen leie. Idempotent. */
  stop(): Promise<void>;
}

export interface StartOptions extends AcquireOptions {
  /** Hvor mange kandidatporter vi proever foer vi feiler lukket. */
  readonly attempts?: number;
  /** Samlet tidsbudsjett for identitetsbeviset per kandidat. */
  readonly verifyTimeoutMs?: number;
  /** Credentials instansen faktisk startes med. Standard: `DEFAULT_PROBE_IDENTITY`. */
  readonly identity?: PostgresIdentity;
  /** Slingringsmonn for klokkeopploesning i postmaster-alderssjekken. */
  readonly clockToleranceMs?: number;
}

/**
 * Start embedded Postgres paa en FENCED leid port og bevis at det er VAAR
 * Postgres som svarer paa IPv4.
 *
 * `factory` faar den leide porten og returnerer instansen. Livssyklusen rundt er
 * bundet: hver avvist kandidat stopper sin egen instans, frigjoer KUN sin egen
 * leie, utelukkes permanent, og neste forsoek gjoer dermed reell framgang.
 */
export async function startLeasedEmbeddedPostgres<T extends EmbeddedPostgresLike>(
  factory: (port: number) => T | Promise<T>,
  options: StartOptions = {}
): Promise<LeasedEmbeddedPostgres<T>> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 30_000;
  const identity = options.identity ?? DEFAULT_PROBE_IDENTITY;
  const problems: string[] = [];
  /**
   * Porter dette kallet allerede har forkastet.
   *
   * Uten denne var "en pre-okkupert kandidat hoppes over" bare sannsynlig: hvert
   * `acquirePortLease` starter sitt eget sveip, saa porten som nettopp feilet
   * kunne deles ut igjen med det samme.
   */
  const rejected = new Set<number>([...(options.exclude ?? [])]);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const lease = acquirePortLease({ ...options, exclude: rejected });

    if (!(await ipv4PortIsFree(lease.port))) {
      // Allerede bundet av noe utenfor leienavnerommet vaart. Hopp over foer vi
      // bruker tid paa en initdb vi uansett ville forkastet.
      problems.push("port " + lease.port + ": allerede bundet paa IPv4 foer oppstart");
      rejected.add(lease.port);
      lease.release();
      continue;
    }

    let postgres: T;
    const notBeforeMs = Date.now();
    try {
      postgres = await factory(lease.port);
    } catch (err) {
      lease.release();
      throw err;
    }

    try {
      await postgres.initialise();
      await postgres.start();
      const proof = await assertPostgresIdentityIPv4(lease.port, identity, {
        timeoutMs: verifyTimeoutMs,
        notBeforeMs,
        ...(options.clockToleranceMs === undefined ? {} : { clockToleranceMs: options.clockToleranceMs })
      });

      let stopped = false;
      return {
        postgres,
        port: lease.port,
        lease,
        proof,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try {
            await postgres.stop();
          } finally {
            lease.release();
          }
        }
      };
    } catch (err) {
      // B.2: stopp DENNE instansen, frigjoer KUN dens egen leie, og gjoer bundet
      // framgang til en annen, ikke-utelukket kandidat.
      problems.push("port " + lease.port + ": " + (err as Error).message);
      rejected.add(lease.port);
      try {
        await postgres.stop();
      } catch {
        // Instansen kan allerede vaere nede; leien frigjoeres uansett.
      }
      lease.release();
      continue;
    }
  }

  throw new Error(
    "Fikk ikke startet embedded Postgres med verifisert PostgreSQL-identitet paa IPv4 etter " + attempts + " forsoek. " +
      "Feiler lukket. Detaljer: " + (problems.join(" | ") || "(ingen)")
  );
}
