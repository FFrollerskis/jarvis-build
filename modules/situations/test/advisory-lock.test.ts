import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withDomainAdvisoryLocks } from "../src/advisory-lock.ts";

/**
 * D-222: `withDomainAdvisoryLocks()` sin `finally`-blokk hadde
 * `.catch(() => undefined)` rundt `pg_advisory_unlock` - en unlock-feil
 * forsvant sporløst OG den pooled klienten ble likevel returnert til poolen
 * via `client.release()`, med session-nivå-låsen fortsatt holdt av
 * akkurat den underliggende tilkoblingen. Denne suiten fantes ikke
 * tidligere - selve unlock-feil-stien var utestet.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let pool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgadvlock-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  pool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  pool.on("error", () => undefined);
}, 120_000);

afterAll(async () => { await pool?.end(); await stopEmbeddedPostgres?.(); }, 120_000);

describe("D-222: withDomainAdvisoryLocks() sitt unlock-feil-sikkerhetsnett", () => {
  it("en unlock-feil logges strukturert (domain+error) OG låsen frigis likevel reelt (ekte unlock kjøres FØR simulert feil returneres)", async () => {
    const domain = "d222-test-domain";
    const faultyPool = {
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        // @ts-expect-error - test-only monkeypatch: kun pg_advisory_unlock rigges, alt annet uendret
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
            client.query = originalQuery; // restaurer FØR avvisning
            // Samme TO presisjoner som D-221 (erasure-service.test.ts T/U):
            // (1) `.reject()`, ALDRI `throw` - kildekoden kjeder `.catch()` DIREKTE
            //     på dette kallet, ekte `pg`-klienter kaster aldri synkront.
            // (2) Selve unlocken må FORTSATT faktisk kjøres mot ekte Postgres FØRST -
            //     ellers leveres denne pooled klienten tilbake til `pool` med
            //     session-nivå-låsen fortsatt holdt, som ville korrumpert enhver
            //     senere test som gjenbruker nøyaktig denne tilkoblingen.
            return originalQuery(sql, args[1] as unknown[]).then(
              () => Promise.reject(new Error("simulated_unlock_failure")),
              () => Promise.reject(new Error("simulated_unlock_failure"))
            );
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(withDomainAdvisoryLocks(faultyPool, [domain], async () => "ok")).resolves.toBe("ok");

      const line = errorSpy.mock.calls.map(([l]) => l as string).find((l) => l.includes("domain_advisory_unlock_failed"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string) as { msg: string; domain: string; error: string };
      expect(parsed.msg).toBe("domain_advisory_unlock_failed");
      expect(parsed.domain).toBe(domain);
      expect(parsed.error).toContain("simulated_unlock_failure");
    } finally {
      errorSpy.mockRestore();
    }

    // Regresjonsvakt: en ANNEN, senere kjøring for SAMME domene skal ikke
    // blokkeres av en lås som "glemte" å slippe - beviser at den EKTE
    // unlocken faktisk ble utført FØR den simulerte feilen ble returnert
    // (en ekte hengende session-lås ville latt denne henge på ubestemt tid).
    await expect(
      withDomainAdvisoryLocks(pool, [domain], async () => "ok-again")
    ).resolves.toBe("ok-again");
  });

  it("vellykket unlock: INGEN feil logges (regresjonsvakt - fiksen legger ikke til støy på den lykkelige stien)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withDomainAdvisoryLocks(pool, ["d222-happy-domain"], async () => "ok");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
