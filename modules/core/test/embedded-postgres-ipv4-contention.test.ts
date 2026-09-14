import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPostgresBoundIPv4,
  candidateWindow,
  ipv4PortIsFree,
  readEphemeralRange,
  startLeasedEmbeddedPostgres,
  type CandidateWindow
} from "../src/testing/index.ts";

/**
 * D-139 A - OBLIGATORISK PORTBEVIS MOT EKTE POSTGRES.
 *
 * `embedded-postgres-port-lease.test.ts` beviser leien som mekanisme. Denne
 * filen beviser at mekanismen faktisk holder naar EKTE postgres-prosesser
 * kjemper om de samme portene samtidig - og, viktigst, at den delvise
 * IPv4-bind-feilen fra D-137 ikke lenger kan slippe gjennom som "ready".
 *
 * Hver `EmbeddedPostgres` er sin egen OS-prosess. Aa starte flere av dem
 * samtidig er derfor ekte flerprosess-kontensjon, ikke en simulering.
 */

const openedServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openedServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        })
    )
  );
});

function occupyIpv4(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      openedServers.push(server);
      resolve(server);
    });
  });
}

async function startOne(label: string, options: Parameters<typeof startLeasedEmbeddedPostgres>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-${label}-`));
  return await startLeasedEmbeddedPostgres(
    (port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }),
    options
  );
}

describe("A.2: samtidige EKTE postgres-instanser faar unike, faktisk bundne IPv4-porter", () => {
  const CONCURRENT = 5;
  const ROUNDS = 2;

  it(
    `${CONCURRENT} samtidige instanser x ${ROUNDS} runder: unike porter, ekte klientforbindelser`,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const started = await Promise.all(
          Array.from({ length: CONCURRENT }, (_, i) => startOne(`race-${round}-${i}`))
        );
        try {
          const ports = started.map((s) => s.port);
          // Ingen to instanser fikk samme port.
          expect(new Set(ports).size).toBe(CONCURRENT);

          // Og hver av dem tar faktisk imot en EKTE klientforbindelse paa IPv4.
          // Det er dette D-137 ikke kunne love: `start()` hadde allerede
          // resolvet mens 127.0.0.1 ikke var bundet i det hele tatt.
          for (const s of started) {
            const pool = new pg.Pool({ host: "127.0.0.1", port: s.port, database: "postgres", user: "postgres", password: "pw" });
            pool.on("error", () => undefined);
            try {
              const res = await pool.query("SELECT inet_server_port() AS port");
              expect(Number(res.rows[0].port)).toBe(s.port);
            } finally {
              await pool.end();
            }
          }
        } finally {
          await Promise.all(started.map((s) => s.stop()));
        }
      }
    },
    600_000
  );
});

describe("A.2: en PRE-OKKUPERT kandidatport hoppes over - aldri falsk ready", () => {
  it("starter paa en annen port naar foerste kandidat allerede er bundet paa IPv4", async () => {
    const base = candidateWindow(readEphemeralRange());
    const occupiedPort = base.low;
    const window: CandidateWindow = { low: base.low, high: base.low + 3, proven: base.proven, basis: base.basis };

    await occupyIpv4(occupiedPort);
    expect(await ipv4PortIsFree(occupiedPort)).toBe(false);

    // Sveipet begynner deterministisk paa den opptatte porten.
    const started = await startOne("preoccupied", {
      window,
      pickCandidate: (w, attempt) => w.low + attempt
    });
    try {
      expect(started.port).not.toBe(occupiedPort);
      expect(started.port).toBeGreaterThan(occupiedPort);
      // Og den vi faktisk fikk, svarer for ekte.
      await assertPostgresBoundIPv4(started.port, 10_000);
    } finally {
      await started.stop();
    }
  }, 300_000);

  it("feiler LUKKET naar HELE vinduet er pre-okkupert - starter aldri postgres blindt", async () => {
    const base = candidateWindow(readEphemeralRange());
    const window: CandidateWindow = { low: base.low + 10, high: base.low + 12, proven: base.proven, basis: base.basis };
    for (let p = window.low; p <= window.high; p++) await occupyIpv4(p);

    await expect(
      startOne("all-occupied", { window, attempts: 3, pickCandidate: (w, attempt) => w.low + (attempt % (w.high - w.low + 1)) })
    ).rejects.toThrow(/Feiler lukket/);
  }, 300_000);
});

describe("A.2: IPv4-verifikasjonen er selve beviset, ikke start()", () => {
  it("assertPostgresBoundIPv4 kaster med D-137-diagnosen naar ingen lytter", async () => {
    const base = candidateWindow(readEphemeralRange());
    const silentPort = base.high; // ingen starter noe her
    await expect(assertPostgresBoundIPv4(silentPort, 1_500)).rejects.toThrow(/lytter IKKE paa IPv4/);
    await expect(assertPostgresBoundIPv4(silentPort, 1_500)).rejects.toThrow(/D-137/);
  }, 60_000);

  it("assertPostgresBoundIPv4 gaar gjennom naar noen FAKTISK lytter", async () => {
    const base = candidateWindow(readEphemeralRange());
    const port = base.high - 1;
    await occupyIpv4(port);
    await expect(assertPostgresBoundIPv4(port, 5_000)).resolves.toBeUndefined();
  }, 60_000);
});
