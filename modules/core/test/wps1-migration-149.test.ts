import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KINDS, DEVICE_KIND_SOURCES, deviceKindFromLegacyLabel } from "@jarvis/contracts";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 K1: migrasjon 149 OPPOVER fra main-skjemaet (alle migrasjoner før 149) med eksisterende enheter, en ubrukt billett og et grant. Beviser at (a) ingen eksisterende rad brytes (den eldre `kind`-etiketten er
 * uendret), (b) klassifiseringen SQL gjør er NØYAKTIG den samme som `deviceKindFromLegacyLabel` i kode (differensial over mange etiketter), (c) hver klassifisering er revidert, (d) CHECK-invariantene og
 * databasevakten finnes etterpå, og (e) en rå INSERT uten type blir `legacy_unknown` (minste tillit).
 */
const MIGRATIONS = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const TENANT = "tenant-s1m";
const PERSON = "person-s1m";
const PERSON_2 = "person-s1m-2";

const LABELS = [
  "web", "WEB", "  web  ", "Web", "iphone", " iPhone ", "watch", "WATCH", "service", "voice", "mac", "windows", "api_client", "telegram_gateway", "voice_gateway", "web_browser",
  "phone", "pc", "mobile", "desktop-agent", "api", "", "   ", "legacy_unknown", "web\n", "web\t", "web browser", "iphone2", "service ", "x".repeat(300), "we" + String.fromCodePoint(0x200b) + "b", "WEB_BROWSER"
];

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1m-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  // 1) «main-skjemaet»: alle migrasjoner FØR 149 (en midlertidig katalog med kopier; ingenting slettes).
  const before = await mkdtemp(join(tmpdir(), "jarvis-mig-before149-"));
  for (const file of (await readdir(MIGRATIONS)).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) < 149)) await copyFile(join(MIGRATIONS, file), join(before, file));
  await mkdir(before, { recursive: true });
  const first = await runMigrations(admin, before);
  expect(first.some((f) => f.startsWith("149_"))).toBe(false);
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1M', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1M Person'), ('${PERSON_2}', 'S1M Person 2');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}'), ('${PERSON_2}', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1m', '${TENANT}', 'personal');`);
  for (const [i, label] of LABELS.entries()) {
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, $4, $5)", [`dev-s1m-${i}`, TENANT, i % 2 === 0 ? PERSON : PERSON_2, label, i % 5 === 0 ? null : `pem-${i}`]);
  }
  // en tilbakekalt enhet og en uten nøkkel får også en klassifisering (revisjonen skal dekke ALLE rader)
  await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, revoked_at, revoked_reason) VALUES ('dev-s1m-revoked', $1, $2, 'web', NULL, now(), 'test')", [TENANT, PERSON]);
  await admin.query("INSERT INTO device_enrollment_tickets (ticket_id, tenant_id, person_id, expires_at) VALUES ('ticket-s1m-pending', $1, $2, now() + interval '10 minutes')", [TENANT, PERSON]);
  // 2) oppover fra main-skjemaet: KUN 149 (og eventuelt senere) gjenstår
  const applied = await runMigrations(admin);
  expect(applied.some((f) => f.startsWith("149_"))).toBe(true);
}, 300_000);

afterAll(async () => { await admin?.end(); await stop?.(); }, 120_000);

describe("WP-S1 K1: migrasjon 149 oppover fra main-skjemaet", () => {
  it("(a) den eldre `kind`-etiketten er BYTE-uendret for alle rader, og antall rader er uendret (ingen eksisterende rad brytes)", async () => {
    const rows = (await admin.query("SELECT device_id, kind FROM devices WHERE device_id LIKE 'dev-s1m-%' AND device_id <> 'dev-s1m-revoked' ORDER BY device_id")).rows;
    expect(rows).toHaveLength(LABELS.length);
    for (const [i, label] of LABELS.entries()) expect(rows.find((r) => r.device_id === `dev-s1m-${i}`)?.kind, JSON.stringify(label)).toBe(label);
  });

  it("(b) SQL-klassifiseringen er NØYAKTIG `deviceKindFromLegacyLabel` for hver etikett (kilde: legacy_label for kjente, unclassified ellers)", async () => {
    for (const [i, label] of LABELS.entries()) {
      const expected = deviceKindFromLegacyLabel(label);
      const row = (await admin.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = $1", [`dev-s1m-${i}`])).rows[0];
      expect(row, JSON.stringify(label)).toEqual({ device_kind: expected.device_kind, device_kind_source: expected.mapped ? "legacy_label" : "unclassified" });
    }
    // sanity: etikettene dekker BÅDE kjente og ukjente (testen er ikke tom)
    const kinds = new Set(LABELS.map((l) => deviceKindFromLegacyLabel(l).device_kind));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    expect(kinds.has("legacy_unknown")).toBe(true);
  });

  it("(b2) tilbakekalte enheter og enheter uten nøkkel klassifiseres også (`web` -> web_browser), og typen er alltid en gyldig lukket verdi", async () => {
    expect((await admin.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = 'dev-s1m-revoked'")).rows[0]).toEqual({ device_kind: "web_browser", device_kind_source: "legacy_label" });
    const all = (await admin.query("SELECT DISTINCT device_kind FROM devices")).rows.map((r) => r.device_kind as string);
    for (const k of all) expect((DEVICE_KINDS as readonly string[]).includes(k), k).toBe(true);
  });

  it("(c) HVER klassifisering er revidert (én rad per enhet, `device.kind_classified`) med type, kilde og den gamle etiketten (avkortet), og revisjonen er system-handling", async () => {
    const devicesTotal = (await admin.query("SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1", [TENANT])).rows[0].n as number;
    const audit = (await admin.query("SELECT device_id, reason, payload, actor_kind, process FROM audit_events WHERE tenant_id = $1 AND type = 'device.kind_classified'", [TENANT])).rows;
    expect(audit).toHaveLength(devicesTotal);
    for (const row of audit) {
      expect(row.actor_kind).toBe("system");
      expect(row.process).toBe("migrate-149");
      expect(["migration_149_legacy_label", "migration_149_unclassified"]).toContain(row.reason);
      expect(row.payload.legacy_kind.length).toBeLessThanOrEqual(64);
    }
    const one = audit.find((r) => r.device_id === "dev-s1m-1"); // "WEB" -> web_browser
    expect(one?.payload).toMatchObject({ device_kind: "web_browser", device_kind_source: "legacy_label", legacy_kind: "WEB" });
  });

  it("(d) en ubrukt billett får `legacy_unknown` (enheten rulles inn uten step-up-evne til eieren utsteder en ny billett med type); CHECK avviser en ukjent billett-type", async () => {
    expect((await admin.query("SELECT device_kind FROM device_enrollment_tickets WHERE ticket_id = 'ticket-s1m-pending'")).rows[0]).toEqual({ device_kind: "legacy_unknown" });
    await expect(admin.query("UPDATE device_enrollment_tickets SET device_kind = 'phone' WHERE ticket_id = 'ticket-s1m-pending'")).rejects.toThrow(/device_enrollment_tickets_device_kind_ck/);
  });

  it("(e) CHECK-invariantene og databasevakten finnes etter oppgraderingen; en rå INSERT uten type blir `legacy_unknown`/`unclassified`", async () => {
    const constraints = (await admin.query("SELECT conname FROM pg_constraint WHERE conrelid = 'devices'::regclass AND conname LIKE 'devices_device_kind%'")).rows.map((r) => r.conname as string).sort();
    expect(constraints).toEqual(["devices_device_kind_ck", "devices_device_kind_source_consistent_ck", "devices_device_kind_source_ck"].sort());
    const trigger = (await admin.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'devices'::regclass AND NOT tgisinternal AND tgname = 'devices_kind_guard'")).rows;
    expect(trigger).toHaveLength(1);
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-s1m-raw', $1, $2, 'phone')", [TENANT, PERSON]);
    expect((await admin.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = 'dev-s1m-raw'")).rows[0]).toEqual({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
    await expect(admin.query("UPDATE devices SET device_kind = 'iphone', device_kind_source = 'enrollment_ticket' WHERE device_id = 'dev-s1m-raw'")).rejects.toThrow(/device_kind_change_not_authorized/);
  });

  it("(e2) CHECK-ene HÅNDHEVER den lukkede listen og kilde-invarianten (ikke bare finnes), og listene i SQL er NØYAKTIG listene i koden", async () => {
    const ins = (id: string, kind: string, source: string) =>
      admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, device_kind, device_kind_source) VALUES ($1, $2, $3, 'x', $4, $5)", [id, TENANT, PERSON, kind, source]);
    await expect(ins("dev-s1m-c1", "phone", "legacy_label")).rejects.toThrow(/devices_device_kind_ck/);
    await expect(ins("dev-s1m-c2", "IPHONE", "legacy_label")).rejects.toThrow(/devices_device_kind_ck/);
    await expect(ins("dev-s1m-c3", "iphone", "magic")).rejects.toThrow(/devices_device_kind_source_ck/);
    await expect(ins("dev-s1m-c4", "legacy_unknown", "enrollment_ticket")).rejects.toThrow(/devices_device_kind_source_consistent_ck/);
    await expect(ins("dev-s1m-c5", "iphone", "unclassified")).rejects.toThrow(/devices_device_kind_source_consistent_ck/);
    for (const kind of DEVICE_KINDS) await ins(`dev-s1m-ok-${kind}`, kind, kind === "legacy_unknown" ? "unclassified" : "legacy_label");
    // SQL-listene = TS-listene (en ny type i koden uten migrasjon, eller omvendt, feller testen)
    const literals = async (name: string): Promise<string[]> => {
      const def = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1", [name])).rows[0]?.d as string;
      return [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
    };
    expect(await literals("devices_device_kind_ck")).toEqual([...DEVICE_KINDS].sort());
    expect(await literals("device_enrollment_tickets_device_kind_ck")).toEqual([...DEVICE_KINDS].sort());
    expect(await literals("devices_device_kind_source_ck")).toEqual([...DEVICE_KIND_SOURCES].sort());
  });

  it("(f) migrasjonen er ferdig anvendt og kan ikke anvendes på nytt (checksum låst, ingen nye revisjonsrader ved omkjøring)", async () => {
    const before = (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE type = 'device.kind_classified'")).rows[0].n as number;
    expect(await runMigrations(admin)).toEqual([]);
    expect((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE type = 'device.kind_classified'")).rows[0].n).toBe(before);
    const row = (await admin.query("SELECT checksum FROM schema_migrations WHERE name = '149_device_kind_channel_binding.sql'")).rows[0];
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
