import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthIntakeError, HealthIntakeService, type HealthIntakeIdentity } from "../src/intake.ts";
import { HealthService } from "../src/service.ts";
import { validateHealthObservation } from "../src/validation.ts";

/**
 * WP-G2 fiks-runde (review B, MEDIUM-2): ETT ugyldig `observed_at` (`2026-09-31T10:00:00Z`, `x 2026-10-15`) passerte JS `Date.parse`, men Postgres avviste castet MIDT i transaksjonen: hele batchen ble rullet tilbake (de gyldige søsknene
 * også) og ruten ga 500 - appen ville sendt den samme giftige batchen på nytt for evig. Nå valideres hver tidsstempel STRENGT (ISO 8601 med sone, gyldig dato, plausibelt vindu) FØR transaksjonen, og batchen avvises med 400 og en
 * indeksliste (aldri verdiene). Retensjonen her er 365 dager (byggerens anbefaling Q-G2-4): med et kort vindu ble de samme strengene misvisende `expired` i stedet for å nå databasen.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let intake: HealthIntakeService;
const TENANT = "t-hlt-ts";
const P1 = "p-hlt-ts-1";
const id = (n: number): string => `0000BBBB-0000-4000-8000-${String(n).padStart(12, "0")}`;
const who: HealthIntakeIdentity = { tenant_id: TENANT, person_id: P1, session_id: "sess-ts", device_id: "iphone-1", channel: "mobile" };
const recent = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const FIXED_AT = recent(3);
const sample = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ metric_type: "heart_rate", value: 72, unit: "bpm", observed_at: recent(2), external_sample_id: id(n), ...overrides });
const count = async (): Promise<number> => ((await admin.query("SELECT count(*)::int AS n FROM health_metric_observations WHERE tenant_id = $1", [TENANT])).rows[0] as { n: number }).n;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-hlt-ts-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_hlt_ts_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_hlt_ts_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Timestamps','person');
    INSERT INTO people (person_id, display_name) VALUES ('${P1}','P1');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${P1}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_hlt_ts_test", password: "pw2" });
  intake = new HealthIntakeService(app);
  await new HealthService(app).setRetentionPolicy(TENANT, { retention_days: 365, actor_person_id: P1 });
}, 240_000);

afterAll(async () => { await app?.end(); await admin?.end(); await stop?.(); }, 120_000);

const POISON = ["2026-09-31T10:00:00Z", "2026-06-31T10:00:00Z", "2026-02-30T10:00:00Z", "x 2026-10-15", "2026-10-15 junk", "Oct 15 2026 10:00 whatever", "2026-10-15", "2026-10-15T10:00:00", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "1999-12-31T23:59:59Z"];

describe("A: en ugyldig `observed_at` avviser hele batchen FØR transaksjonen (ingen databasefeil, ingen halvt innlest batch)", () => {
  for (const bad of POISON) {
    it(`${JSON.stringify(bad)}: avvist med \`invalid_timestamps\` og indeks 1; INGEN rad lagres (heller ikke de gyldige søsknene), og en feilfri batch går gjennom etterpå`, async () => {
      const before = await count();
      const fixed = { observed_at: FIXED_AT }; // samme innhold hver gang: en gjentatt prøve er `duplicate`, ikke `conflict`
      const err = await intake.ingestBatch(who, { samples: [sample(1, fixed), sample(2, { observed_at: bad }), sample(3, fixed)] }).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(HealthIntakeError);
      expect((err as HealthIntakeError).code).toBe("invalid_timestamps");
      expect((err as HealthIntakeError).indexes).toEqual([1]);
      expect(await count()).toBe(before);
      const ok = await intake.ingestBatch(who, { samples: [sample(1, fixed), sample(3, fixed)] });
      expect(ok.counts.created + ok.counts.duplicate).toBe(2);
    });
  }

  it("flere ugyldige: alle indeksene listes (maks 250, aldri verdiene); gyldige former (Z, offset, millisekunder) godtas", async () => {
    const err = await intake.ingestBatch(who, { samples: [sample(10, { observed_at: "2026-09-31T10:00:00Z" }), sample(11), sample(12, { observed_at: "x 2026-10-15" })] }).catch((e: unknown) => e);
    expect((err as HealthIntakeError).indexes).toEqual([0, 2]);
    expect(JSON.stringify(err)).not.toContain("2026-09-31");
    const now = Date.now();
    const forms = [new Date(now - 3_600_000).toISOString(), new Date(now - 7_200_000).toISOString().replace("Z", "+00:00"), new Date(now - 10_800_000 + 3_600_000).toISOString().replace(/\.\d+Z$/, ".123+01:00")];
    const ok = await intake.ingestBatch(who, { samples: forms.map((observed_at, i) => sample(20 + i, { observed_at })) });
    expect(ok.counts.created).toBe(3);
  });

  it("en manglende/ikke-streng `observed_at` er en vanlig per-prøve-feil (`invalid`), ikke en batch-avvisning - og påvirker ikke de andre", async () => {
    const r = await intake.ingestBatch(who, { samples: [sample(30), sample(31, { observed_at: 12345 }), (() => { const s = sample(32); delete s["observed_at"]; return s; })()] });
    expect(r.counts).toMatchObject({ created: 1, invalid: 2 });
    expect(r.results.map((x) => x.reason)).toEqual([undefined, "invalid_observed_at", "invalid_observed_at"]);
  });
});

describe("B: samme strenge regel for enkeltinntaket (validateHealthObservation)", () => {
  it("tidsstempel uten sone, med ugyldig dato eller utenfor vinduet avvises; et gyldig godtas", () => {
    const base = { metric_type: "heart_rate", value: 72, unit: "bpm", source_type: "apple_health" };
    for (const bad of POISON) expect(validateHealthObservation({ ...base, observed_at: bad }), bad).toMatchObject({ ok: false, field: "observed_at" });
    expect(validateHealthObservation({ ...base, observed_at: recent(1) })).toMatchObject({ ok: true });
  });
});
