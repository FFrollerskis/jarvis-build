import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROBE_IDENTITY,
  assertPostgresIdentityIPv4,
  candidateWindow,
  ipv4PortIsFree,
  readEphemeralRange,
  startLeasedEmbeddedPostgres,
  type CandidateWindow
} from "../src/testing/index.ts";

/**
 * D-141 B - OBLIGATORISK POSTGRESQL-IDENTITETSBEVIS.
 *
 * D-139 krevde en TCP-forbindelse til 127.0.0.1 etter `start()`. Den forrige
 * utgaven av DENNE filen beviste samtidig at en generisk `net.createServer()`
 * tilfredsstilte kravet - altsaa at verdiktet ikke sa noe om HVEM som svarte.
 * Det gjoer check-to-bind-motstanderen mulig:
 *
 *     probe sier ledig -> fremmed lytter binder -> postgres binder bare IPv6 og
 *     melder likevel ready -> TCP-proben lykkes mot den FREMMEDE lytteren.
 *
 * Her snus det: den generiske lytteren er naa et NEGATIVT kontrolltilfelle, og
 * alle positive kontroller bruker ekte PostgreSQL med ekte klientsporringer.
 */

/**
 * En motstander vi selv har bundet: serveren OG socketene den tok imot.
 *
 * Socketene maa foelges eksplisitt. `net.Server.close()` slutter bare aa ta imot
 * NYE forbindelser og venter paa at de aapne skal lukkes av seg selv - og
 * identitetsproben etterlater seg per definisjon halvferdige handshakes mot
 * nettopp disse motstanderne. Uten sporingen henger opprydningen til den
 * tidsavbrytes. (`closeAllConnections()` finnes kun paa http.Server.)
 */
interface Adversary {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

const adversaries: Adversary[] = [];

function track(server: Server): Adversary {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  const adversary: Adversary = { server, sockets };
  adversaries.push(adversary);
  return adversary;
}

afterEach(async () => {
  await Promise.all(
    adversaries.splice(0).map(
      ({ server, sockets }) =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close(() => resolve());
        })
    )
  );
});

function occupyIpv4(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    track(server);
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
  });
}

/** En lytter som tar imot socketen og aldri svarer - den verste motstanderen. */
function occupySilentIpv4(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Ingen svar paa startup-pakken. En bar TCP-probe ville kalt dette "ready".
    const server = createServer();
    track(server);
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
  });
}

async function startOne(label: string, options: Parameters<typeof startLeasedEmbeddedPostgres>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-${label}-`));
  return await startLeasedEmbeddedPostgres(
    (port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }),
    options
  );
}

/** En EKTE klientsporring - ikke en TCP-connect - mot den porten vi fikk. */
async function realClientQuery(port: number): Promise<number> {
  const pool = new pg.Pool({ host: "127.0.0.1", port, database: "postgres", user: "postgres", password: "pw" });
  pool.on("error", () => undefined);
  try {
    const res = await pool.query("SELECT inet_server_port() AS port");
    return Number((res.rows[0] as { port: unknown }).port);
  } finally {
    await pool.end();
  }
}

describe("B.4: samtidige EKTE postgres-instanser - unike porter, ekte klientsporringer", () => {
  const CONCURRENT = 5;
  const ROUNDS = 2;

  it(
    `${CONCURRENT} samtidige instanser x ${ROUNDS} runder: unike porter og protokollbevis for HVER av dem`,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const started = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => startOne(`race-${round}-${i}`)));
        try {
          const ports = started.map((s) => s.port);
          expect(new Set(ports).size).toBe(CONCURRENT);

          for (const s of started) {
            // Beviset helperen selv krevde foer den slapp instansen videre.
            expect(s.proof.server_addr).toBe("127.0.0.1");
            expect(s.proof.server_port).toBe(s.port);
            expect(s.proof.server_version).toMatch(/PostgreSQL/);

            // Og en uavhengig, EKTE klientsporring bekrefter det samme.
            expect(await realClientQuery(s.port)).toBe(s.port);

            // Leien holdes i HELE databasens levetid, ikke bare gjennom oppstart.
            expect(s.lease.released).toBe(false);
            expect(existsSync(s.lease.file)).toBe(true);
          }
        } finally {
          await Promise.all(started.map((s) => s.stop()));
        }
        for (const s of started) {
          expect(s.lease.released).toBe(true);
          expect(existsSync(s.lease.file)).toBe(false);
        }
      }
    },
    900_000
  );
});

describe("B.1/B.4: en generisk TCP-lytter tilfredsstiller IKKE PostgreSQL-klarhet", () => {
  it("en vanlig net-server som svarer paa connect blir AVVIST", async () => {
    const base = candidateWindow(readEphemeralRange());
    const port = base.low + 40;
    await occupyIpv4(port);
    // En bar TCP-probe ville sagt ja her. Det er noeyaktig defekten.
    expect(await ipv4PortIsFree(port)).toBe(false);

    await expect(assertPostgresIdentityIPv4(port, DEFAULT_PROBE_IDENTITY, { timeoutMs: 4_000 })).rejects.toThrow(
      /INTET gyldig PostgreSQL-identitetsbevis/
    );
  }, 60_000);

  it("en TAUS lytter som aldri svarer paa startup-pakken blir AVVIST, og feilen navngir motstanderen", async () => {
    const base = candidateWindow(readEphemeralRange());
    const port = base.low + 41;
    await occupySilentIpv4(port);

    await expect(assertPostgresIdentityIPv4(port, DEFAULT_PROBE_IDENTITY, { timeoutMs: 6_000 })).rejects.toThrow(
      /noe lytter der, men det snakker ikke PostgreSQL/
    );
  }, 60_000);

  it("ingenting som lytter gir D-137-diagnosen, ikke motstander-diagnosen", async () => {
    const base = candidateWindow(readEphemeralRange());
    const port = base.high; // ingen starter noe her
    await expect(assertPostgresIdentityIPv4(port, DEFAULT_PROBE_IDENTITY, { timeoutMs: 2_500 })).rejects.toThrow(
      /ingenting lytter paa IPv4; dette er den delvise bind-feilen fra D-137/
    );
  }, 60_000);
});

describe("B.3: check-to-bind-motstanderen - fremmed lytter binder ETTER at proben sa ledig", () => {
  it(
    "helperen avviser den okkuperte kandidaten og gjoer BUNDET framgang til en annen port",
    async () => {
      const base = candidateWindow(readEphemeralRange());
      const window: CandidateWindow = { low: base.low + 50, high: base.low + 53, proven: base.proven, basis: base.basis };
      const victim = window.low;
      // Egen leiemappe: assertsjonen under gjelder DENNE kjoeringens leier, ikke
      // det som maatte ligge i den delte standardmappen.
      const leaseDir = mkdtempSync(join(tmpdir(), "jarvis-ambush-leases-"));

      let ambushed = false;

      const started = await startLeasedEmbeddedPostgres(
        async (port) => {
          // Vi er HER fordi `ipv4PortIsFree(port)` nettopp sa ledig. Motstanderen
          // binder i noeyaktig det vinduet - foer postgres faar bundet IPv4.
          if (port === victim && !ambushed) {
            ambushed = true;
            await occupySilentIpv4(port);
          }
          const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-ambush-${port}-`));
          return new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false });
        },
        {
          leaseDir,
          window,
          attempts: 4,
          verifyTimeoutMs: 8_000,
          pickCandidate: (w, attempt) => w.low + (attempt % (w.high - w.low + 1))
        }
      );

      try {
        expect(ambushed).toBe(true);
        // Den okkuperte kandidaten ble forkastet...
        expect(started.port).not.toBe(victim);
        // ...og den vi endte paa er bevist ekte, med en uavhengig klientsporring.
        expect(started.proof.server_addr).toBe("127.0.0.1");
        expect(started.proof.server_port).toBe(started.port);
        expect(await realClientQuery(started.port)).toBe(started.port);

        // B.2: KUN offerets egen leie ble frigjort - ingen leie ligger igjen for
        // den forkastede porten, og vaar egen staar.
        expect(readdirSync(leaseDir).filter((n) => n.startsWith(victim + "."))).toEqual([]);
        expect(existsSync(started.lease.file)).toBe(true);
      } finally {
        await started.stop();
        rmSync(leaseDir, { recursive: true, force: true });
      }
    },
    900_000
  );

  it(
    "hele vinduet pre-okkupert: feiler LUKKET i stedet for aa starte postgres blindt",
    async () => {
      const base = candidateWindow(readEphemeralRange());
      const window: CandidateWindow = { low: base.low + 60, high: base.low + 62, proven: base.proven, basis: base.basis };
      for (let p = window.low; p <= window.high; p++) await occupyIpv4(p);

      await expect(
        startOne("all-occupied", { window, attempts: 3, pickCandidate: (w, attempt) => w.low + (attempt % (w.high - w.low + 1)) })
      ).rejects.toThrow(/Feiler lukket/);
    },
    300_000
  );
});

describe("B.1: identiteten - ikke bare tilstedevaerelsen - avgjoer", () => {
  it(
    "FEIL credentials mot en EKTE postgres blir avvist umiddelbart, ikke ventet ut",
    async () => {
      const started = await startOne("identity");
      try {
        const t0 = Date.now();
        await expect(
          assertPostgresIdentityIPv4(started.port, { user: "postgres", password: "helt-feil-passord", database: "postgres" }, { timeoutMs: 30_000 })
        ).rejects.toThrow(/ble AVVIST/);
        // Endelig med én gang: en fremmed identitet skal ikke kunne vente seg til
        // et ja mens tidsbudsjettet renner ut.
        expect(Date.now() - t0).toBeLessThan(20_000);
      } finally {
        await started.stop();
      }
    },
    600_000
  );

  it(
    "en postmaster som ble startet FOER oss er en fremmed klynge",
    async () => {
      const started = await startOne("foreign-cluster");
      try {
        // Ekte server, ekte credentials - men vi later som vi startet vaar egen
        // instans lenge etterpaa. Det er en annen klynge, og den skal avvises.
        await expect(
          assertPostgresIdentityIPv4(started.port, DEFAULT_PROBE_IDENTITY, {
            timeoutMs: 10_000,
            notBeforeMs: Date.now() + 3_600_000,
            clockToleranceMs: 1_000
          })
        ).rejects.toThrow(/fremmed klynge/);

        // Uten den kunstige referansen er den samme serveren gyldig.
        const proof = await assertPostgresIdentityIPv4(started.port, DEFAULT_PROBE_IDENTITY, { timeoutMs: 10_000 });
        expect(proof.server_port).toBe(started.port);
      } finally {
        await started.stop();
      }
    },
    600_000
  );
});
