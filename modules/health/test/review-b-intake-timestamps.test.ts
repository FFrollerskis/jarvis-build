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
import { isPlausibleObservedAt, validateHealthObservation } from "../src/validation.ts";

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

/**
 * Fiks-runde 2 (delta-review B, M2 DELVIS): offset +16:00..+23:59 (også `+1600`) slapp gjennom validatoren, men Postgres gir 22009 («time zone displacement out of range») og HELE batchen rullet tilbake med en rå pg-feil og 500 (336 av 1092 godtatte
 * fuzz-strenger). Nå avvises |offset| > 14:00 i ALLE former (`Z`, ±HH, ±HHMM, ±HH:MM) FØR transaksjonen, og testen under beviser mot ekte Postgres at ingen streng validatoren godtar kan gi 22009.
 */
describe("C: tidssone-forskyvning > 14:00 avvises FØR transaksjonen (aldri 22009 midt i batchen)", () => {
  const BASE = "2020-06-15T10:00:00"; // godt etter år 2000 og godt før «nå»: kun forskyvningen avgjør
  const pad = (n: number): string => String(n).padStart(2, "0");

  /** Alle former for hver forskyvning fra -23:59 til +23:59 (minutt for minutt): ±HH:MM, ±HHMM og (hele timer) ±HH. */
  function allOffsets(): Array<{ text: string; minutes: number }> {
    const out: Array<{ text: string; minutes: number }> = [];
    for (let total = -(23 * 60 + 59); total <= 23 * 60 + 59; total += 1) {
      const sign = total < 0 ? "-" : "+";
      const abs = Math.abs(total);
      const hh = pad(Math.floor(abs / 60));
      const mm = pad(abs % 60);
      out.push({ text: `${sign}${hh}:${mm}`, minutes: total }, { text: `${sign}${hh}${mm}`, minutes: total });
      if (abs % 60 === 0) out.push({ text: `${sign}${hh}`, minutes: total });
    }
    return out;
  }

  it("validatoren godtar NØYAKTIG forskyvninger innenfor ±14:00 (±HH:MM og ±HHMM; ±HH godtas ikke av zod i det hele tatt, men uansett aldri over 14:00), og hver streng den godtar kan Postgres lese (ingen 22009-vei); Z godtas", async () => {
    const accepted: string[] = [];
    for (const { text, minutes } of allOffsets()) {
      const value = `${BASE}${text}`;
      const ok = isPlausibleObservedAt(value);
      if (/^[+-]\d{2}$/.test(text)) expect(ok && Math.abs(minutes) > 14 * 60, value).toBe(false); // kun timer: godtatt eller ikke, aldri over grensen
      else expect(ok, value).toBe(Math.abs(minutes) <= 14 * 60);
      if (ok) accepted.push(value);
    }
    expect(isPlausibleObservedAt(`${BASE}Z`)).toBe(true);
    accepted.push(`${BASE}Z`, `${BASE}.123456Z`, `${BASE}.5+14:00`);
    expect(accepted.length).toBeGreaterThan(3_000);
    // Én spørring over alle godtatte strenger: Postgres kaster 22009/22007 hvis NOEN ikke kan leses.
    const { rowCount } = await admin.query("SELECT x::timestamptz FROM unnest($1::text[]) AS x", [accepted]);
    expect(rowCount).toBe(accepted.length);
  }, 120_000);

  it("rotårsaken er reell: Postgres AVVISER +16:00 og +23:59 (22009) - derfor må validatoren stoppe dem; og minuttdelen over 59 avvises", async () => {
    for (const bad of [`${BASE}+16:00`, `${BASE}+1600`, `${BASE}-23:59`, `${BASE}+23`]) {
      expect(await admin.query("SELECT $1::timestamptz", [bad]).then(() => "ok", (e: { code?: string }) => e.code), bad).toBe("22009");
      expect(isPlausibleObservedAt(bad), bad).toBe(false);
    }
    for (const bad of [`${BASE}+01:60`, `${BASE}+0175`, `${BASE}-05:99`]) expect(isPlausibleObservedAt(bad), bad).toBe(false);
  });

  /** Et NYLIG instant (1 time siden) uttrykt med den gitte forskyvningen: vindu og fremtidssjekk passerer, så INSERT-castet i databasen faktisk nås (en gammel dato ble `expired` før databasen). */
  const recentWith = (offset: string): string => {
    const sign = offset.startsWith("-") ? -1 : 1;
    const num = offset.slice(1).replace(":", "");
    const minutes = sign * (Number(num.slice(0, 2)) * 60 + Number(num.slice(2) || "0"));
    const instant = Date.now() - 3_600_000;
    return `${new Date(instant + minutes * 60_000).toISOString().slice(0, 19)}${offset}`;
  };

  it("hele veien (reviewerens repro): en batch med `+16:00`/`+23:00` avvises med `invalid_timestamps` og indeksen - ingen databasefeil, ingen halvt innlest batch, og de gyldige søsknene lagres ikke; enkeltinntaket avviser også", async () => {
    const before = await count();
    const fixed = { observed_at: FIXED_AT };
    for (const offset of ["+16:00", "+23:00", "+1600", "-17:30"]) {
      const err = await intake.ingestBatch(who, { samples: [sample(40, fixed), sample(41, { observed_at: recentWith(offset) }), sample(42, fixed)] }).catch((e: unknown) => e);
      expect(err, offset).toBeInstanceOf(HealthIntakeError);
      expect((err as HealthIntakeError).code).toBe("invalid_timestamps");
      expect((err as HealthIntakeError).indexes).toEqual([1]);
    }
    expect(await count()).toBe(before);
    const base = { metric_type: "heart_rate", value: 72, unit: "bpm", source_type: "apple_health" };
    expect(validateHealthObservation({ ...base, observed_at: `${BASE}+16:00` })).toMatchObject({ ok: false, field: "observed_at" });
    expect(validateHealthObservation({ ...base, observed_at: recent(1) })).toMatchObject({ ok: true });
    const ok = await intake.ingestBatch(who, { samples: [sample(40, { observed_at: recentWith("+14:00") })] });
    expect(ok.counts).toMatchObject({ created: 1 }); // +14:00 (grensen) er gyldig og når databasen uten feil
  });
});
