/**
 * Oppstart av embedded Postgres med LEIE og VERIFISERT IPv4-binding (D-139 A.2).
 *
 * Feilen D-137 dokumenterte, men ikke lukket, var at Postgres behandler en
 * DELVIS bind-feil som ikke-fatal. Den binder IPv6 og unix-socketen, logger
 *
 *     could not bind IPv4 address "127.0.0.1": Address already in use
 *
 * og melder likevel `database system is ready to accept connections`.
 * `EmbeddedPostgres.start()` ser ready-meldingen og resolver. En klient som
 * kobler til 127.0.0.1 faar da ECONNREFUSED langt nede i migrasjonene.
 *
 * Derfor er `start()` ALDRI beviset her. Beviset er en faktisk TCP-forbindelse
 * til 127.0.0.1 paa den leide porten. Foerst naar den er etablert faar kallende
 * kode fortsette; feiler den, stoppes instansen, leien frigjoeres, og en ny
 * kandidat proeves - bounded. En pre-okkupert kandidatport blir dermed hoppet
 * over uten noen gang aa gi falsk "ready".
 */

import { connect, createServer } from "node:net";

import { acquirePortLease, type AcquireOptions, type PortLease } from "./port-lease.ts";

/**
 * Det minimum av `embedded-postgres` denne modulen trenger.
 *
 * Bevisst strukturell: `@jarvis/core` skal ikke dra inn embedded-postgres som
 * avhengighet bare for aa kunne typebeskrive den (D-139 A.4).
 */
export interface EmbeddedPostgresLike {
  initialise(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface LeasedEmbeddedPostgres<T extends EmbeddedPostgresLike> {
  readonly postgres: T;
  readonly port: number;
  readonly lease: PortLease;
  /** Stopper Postgres og frigjoer KUN vaar egen leie. Idempotent. */
  stop(): Promise<void>;
}

export interface StartOptions extends AcquireOptions {
  /** Hvor mange kandidatporter vi proever foer vi feiler lukket. */
  readonly attempts?: number;
  /** Samlet tidsbudsjett for aa faa en IPv4-forbindelse etter `start()`. */
  readonly verifyTimeoutMs?: number;
}

/**
 * Er noe allerede bundet til 127.0.0.1 paa denne porten?
 *
 * `exclusive: true` slaar av portdeling, slik at svaret gjelder IPv4 spesifikt.
 * Dette er et FILTER, ikke eksklusivitetsmekanismen - D-139 A.2 er tydelig paa
 * at en check-then-close-probe alene ikke holder. Eksklusiviteten kommer fra
 * leien; den endelige sannheten fra `assertPostgresBoundIPv4`.
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

/** En enkelt TCP-forbindelse til 127.0.0.1:port. Lykkes den, LYTTER noen der. */
function tryConnectIpv4(port: number, timeoutMs: number): Promise<boolean> {
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

/**
 * Krev at Postgres FAKTISK lytter paa IPv4 127.0.0.1:port.
 *
 * Kaster med en presis melding naar den ikke gjoer det, slik at feilen dukker
 * opp her - der aarsaken er - i stedet for som ECONNREFUSED inne i en
 * migrasjon flere lag unna.
 */
export async function assertPostgresBoundIPv4(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (await tryConnectIpv4(port, 2_000)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    "Postgres meldte klar, men lytter IKKE paa IPv4 127.0.0.1:" + port + " etter " + attempts + " forsoek " +
      "(" + timeoutMs + " ms). Dette er den delvise bind-feilen fra D-137: postgres binder IPv6/unix-socket, " +
      "logger `could not bind IPv4 address` og melder likevel ready. Feiler lukket."
  );
}

/**
 * Start embedded Postgres paa en LEID port og bevis at IPv4 er bundet.
 *
 * `factory` faar den leide porten og returnerer instansen. Alt annet ved
 * oppsettet er uendret; det eneste som er nytt er allokerings-livssyklusen.
 */
export async function startLeasedEmbeddedPostgres<T extends EmbeddedPostgresLike>(
  factory: (port: number) => T | Promise<T>,
  options: StartOptions = {}
): Promise<LeasedEmbeddedPostgres<T>> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 30_000;
  const problems: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const lease = acquirePortLease(options);

    if (!(await ipv4PortIsFree(lease.port))) {
      // Pre-okkupert av noe utenfor vaart leienavnerom. Hopp over - aldri start
      // Postgres her, for da ville vi faatt nettopp den falske ready-en.
      problems.push("port " + lease.port + ": allerede bundet paa IPv4 foer oppstart");
      lease.release();
      continue;
    }

    let postgres: T;
    try {
      postgres = await factory(lease.port);
    } catch (err) {
      lease.release();
      throw err;
    }

    try {
      await postgres.initialise();
      await postgres.start();
      await assertPostgresBoundIPv4(lease.port, verifyTimeoutMs);
    } catch (err) {
      problems.push("port " + lease.port + ": " + (err as Error).message);
      try {
        await postgres.stop();
      } catch {
        // Instansen kan allerede vaere nede; leien frigjoeres uansett.
      }
      lease.release();
      continue;
    }

    let stopped = false;
    return {
      postgres,
      port: lease.port,
      lease,
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
  }

  throw new Error(
    "Fikk ikke startet embedded Postgres med verifisert IPv4-binding etter " + attempts + " forsoek. " +
      "Feiler lukket. Detaljer: " + (problems.join(" | ") || "(ingen)")
  );
}
