import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROBE_IDENTITY,
  assertPostgresIdentityIPv4,
  candidateWindow,
  highestEpoch,
  ipv4PortIsFree,
  readEphemeralRange,
  readLeaseDirId,
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
 *
 * D-142 A.3 legger til den andre halvdelen av fencingen: en fillei kan ikke rive
 * socketen ut av en gammel prosess, saa det er RESSURSprotokollen som maa si nei
 * naar en utloept, men fortsatt kjoerende eier staar i veien - og motsatt, en
 * eier som ble fenced MENS postgres startet, faar ikke levere beviset sitt.
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
            expect(s.lease.fenced).toBe(false);
            expect(s.lease.verifyOwnership().ok).toBe(true);
            expect(existsSync(s.lease.file)).toBe(true);
          }
        } finally {
          await Promise.all(started.map((s) => s.stop()));
        }
        for (const s of started) {
          expect(s.lease.released).toBe(true);
          // D-142 A.1: nedstenging SLETTER ikke leien - den etterlater en
          // gravstein, slik at epoken for porten aldri kan deles ut paa nytt.
          expect(existsSync(s.lease.file)).toBe(true);
          const doc = JSON.parse(readFileSync(s.lease.file, "utf8")) as { state: string; epoch: number };
          expect(doc.state).toBe("released");
          expect(doc.epoch).toBe(s.lease.epoch);
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

        // B.2: KUN offerets egen leie ble frigjort. Etter D-142 A.1 betyr
        // "frigjort" en GRAVSTEIN, ikke en sletting: ingen HOLDT leie ligger
        // igjen for den forkastede porten, epoken dens er brukt opp for godt,
        // og vaar egen leie staar.
        const victimLeases = readdirSync(leaseDir).filter((n) => n.startsWith(victim + "."));
        expect(victimLeases.length).toBeLessThanOrEqual(1);
        for (const name of victimLeases) {
          expect((JSON.parse(readFileSync(join(leaseDir, name), "utf8")) as { state: string }).state).toBe("released");
        }
        expect(existsSync(started.lease.file)).toBe(true);
        expect(started.lease.verifyOwnership().ok).toBe(true);
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

describe("D-143 A: DELT leiekatalog - en fjern eier fences aldri bort, og ressursen deles aldri", () => {
  it(
    "offer og raider i SAMME leiekatalog: raideren feiler lukket, offeret er byte-identisk, eid OG sporbart",
    async () => {
      // ÉN katalog for begge. Dette er poenget: D-142 brukte to uavhengige
      // leiekataloger, og beviste dermed ikke at en raider som FAKTISK ser
      // offerets leie lar den staa.
      const leaseDir = mkdtempSync(join(tmpdir(), "jarvis-lease-d143-shared-"));
      const started = await startOne("d143-victim", { leaseDir, hostId: "victim-host" });

      try {
        const port = started.port;
        expect(await realClientQuery(port)).toBe(port);
        const victimLeaseBefore = readFileSync(started.lease.file, "utf8");

        // Raideren deler katalogen og ser en leie eid av en ANNEN vert.
        // Under D-141/D-142 kunne en utloept heartbeat gjort denne reclaimable.
        await expect(
          startOne("d143-raider", {
            leaseDir,
            hostId: "raider-host",
            window: { low: port, high: port, proven: true, basis: "d143" },
            attempts: 1,
            verifyTimeoutMs: 5_000
          })
        ).rejects.toThrow(/held_remote_owner_fail_closed/);

        // Og med klokken en TIME foran: fortsatt nei. Klokkeskjev gir ingen rett.
        await expect(
          startOne("d143-raider-skew", {
            leaseDir,
            hostId: "raider-host",
            window: { low: port, high: port, proven: true, basis: "d143" },
            attempts: 1,
            verifyTimeoutMs: 5_000,
            now: () => Date.now() + 3_600_000
          })
        ).rejects.toThrow(/held_remote_owner_fail_closed/);

        // Offeret: byte-identisk leie, fortsatt eier, og fortsatt en EKTE
        // spoerrbar database. Ingen av de to raiderne roerte ressursen.
        expect(readFileSync(started.lease.file, "utf8")).toBe(victimLeaseBefore);
        expect(started.lease.fenced).toBe(false);
        expect(started.lease.verifyOwnership().ok).toBe(true);
        expect(await realClientQuery(port)).toBe(port);

        // Hoeyvannsmerket har ikke flyttet seg: ingen epoke ble brent paa et
        // forsoek som aldri skulle vaert tillatt.
        expect(readdirSync(leaseDir).filter((n) => n.startsWith(port + "."))).toEqual([`${port}.1.lease`]);
      } finally {
        await started.stop();
        rmSync(leaseDir, { recursive: true, force: true });
      }
    },
    900_000
  );

  it(
    "blir VI fenced mens postgres starter, forkastes kandidaten - et bevis tatt uten eierskap teller ikke",
    async () => {
      const leaseDir = mkdtempSync(join(tmpdir(), "jarvis-lease-a3-self-"));
      const base = candidateWindow(readEphemeralRange());
      // Fire kandidater, ikke to: fabrikken kjoerer bare for kandidater som
      // faktisk var ledige, saa et vindu uten slark ville gjort testen avhengig
      // av at ingen andre paa verten holder noen av portene.
      const window: CandidateWindow = { low: base.low + 70, high: base.low + 73, proven: base.proven, basis: base.basis };
      const fencedPorts: number[] = [];

      const started = await startLeasedEmbeddedPostgres(
        async (port) => {
          // Foerste kandidat: en gyldig overtakelse skjer MENS vi starter opp.
          // Fabrikken kjoerer etter at leien er tatt, saa fencingen staar lenge
          // foer identitetsbeviset i det hele tatt kan tas.
          if (fencedPorts.length === 0) {
            fencedPorts.push(port);
            const current = highestEpoch(leaseDir, port);
            writeFileSync(
              join(leaseDir, `${port}.${current.epoch + 1}.lease`),
              JSON.stringify({
                v: 3,
                port,
                epoch: current.epoch + 1,
                dir_id: readLeaseDirId(leaseDir),
                state: "held",
                owner: { pid: process.pid, uuid: "gyldig-etterfoelger", host: hostname(), acquired_at_ms: Date.now() },
                heartbeat_at_ms: Date.now(),
                ttl_ms: 600_000,
                released_at_ms: null
              })
            );
          }
          const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-a3-self-${port}-`));
          return new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false });
        },
        {
          leaseDir,
          window,
          attempts: 4,
          verifyTimeoutMs: 30_000,
          pickCandidate: (w, attempt) => w.low + (attempt % (w.high - w.low + 1))
        }
      );

      try {
        // Kandidat 1 ble forkastet fordi VI var fenced, ikke fordi postgres feilet.
        expect(fencedPorts).toHaveLength(1);
        expect(started.port).not.toBe(fencedPorts[0]);
        // Og den vi endte paa er baade bevist ekte OG faktisk vaar.
        expect(started.proof.server_port).toBe(started.port);
        expect(await realClientQuery(started.port)).toBe(started.port);
        expect(started.lease.verifyOwnership().ok).toBe(true);
      } finally {
        await started.stop();
        rmSync(leaseDir, { recursive: true, force: true });
      }
    },
    900_000
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
