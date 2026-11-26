import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport, type ControlSection } from "@jarvis/executive";
import { DEFAULT_RETENTION_DAYS, DEFAULT_SNAPSHOT_RETENTION_DAYS, VisionService } from "@jarvis/vision";
import { seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { DocReader, createPrivacyCenter } from "../src/control-center/privacy.ts";
import { buildVisionSection, readVisionRetention, type PrivacyVisionSource } from "../src/control-center/privacy-vision.ts";
import type { VisionStatusReport } from "../src/vision-routes.ts";

/**
 * WP-G3b (D-485), K2: Syn-kortets SQL mot EKTE Postgres som EKTE app-rolle (NOSUPERUSER/NOBYPASSRLS, RLS gjelder):
 *  - kun egen tenant (tenant-RLS) og aldri health (isolert), kun lesing (ingen rad endres av å bygge senteret);
 *  - kortet viser de vinduene eieren faktisk har satt (via tjenesten som eier-ruten bruker), og standardene ellers.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;

const NOW = new Date();
const idT = (): IdentityContext => ({ person_id: T.owner, tenant_id: T.tenant, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" });
const idT2 = (): IdentityContext => ({ person_id: T2.owner, tenant_id: T2.tenant, memory_space_id: "personal", session_id: "s2", device_id: "d2", channel: "web", auth_strength: "signed" });
const status = (): VisionStatusReport => ({
  poller: { enabled: false }, maintenance: { light: null, full: null, light_run: { running_since: null, skipped_ticks: 0, abandoned_runs: 0 } },
  ingest: { inventory_label_invalid: 0, inventory_label_rejected: 0, last_inventory_skip_at: null }, storage: { maintenance_enabled: false, writing_enabled: false }, classifier: false, embeddings: false
});
const source: PrivacyVisionSource = { status, defaults: { retention_days: DEFAULT_RETENTION_DAYS, snapshot_retention_days: DEFAULT_SNAPSHOT_RETENTION_DAYS } };

async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(createPrivacyCenter({ pool: db.app, env: {}, repoRoot: "/finnes/ikke/her", docReader: new DocReader(), vision: source }));
  return (await registry.report("privacy", identity)) as ControlCenterReport;
}
const card = (r: ControlCenterReport): ControlSection => r.sections.find((s) => s.id === "vision") as ControlSection;
const rowCounts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of ["vision_retention_policies", "audit_events", "vision_event_observations", "vision_snapshots", "vision_cameras"]) out[t] = Number((await db.admin.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

beforeAll(async () => {
  db = await startVisionDb("g3bpv");
  T = await seedTenant(db, "g3bpv-t1");
  T2 = await seedTenant(db, "g3bpv-t2");
  vision = new VisionService(db.app);
  // Eieren setter vinduene slik eier-ruten gjør det (tjenesten med revisjon); health og en annen tenant settes av admin (RLS-grenser).
  await vision.applyRetentionPolicy(T.tenant, "home", { retention_days: 17, snapshot_retention_days: 5 }, { actor_person_id: T.owner, audit: true, confirm_shortening: true }); // 30/7 -> 17/5 forkorter: bekreftet
  await vision.applyRetentionPolicy(T.tenant, "personal", { retention_days: 61, snapshot_retention_days: null }, { actor_person_id: T.owner, audit: true });
  await db.admin.query(`INSERT INTO vision_retention_policies (tenant_id, memory_space_id, retention_days, snapshot_retention_days, actor_person_id) VALUES ($1, 'health', 123, 4, $2)`, [T.tenant, T.owner]);
  await db.admin.query(`INSERT INTO vision_retention_policies (tenant_id, memory_space_id, retention_days, snapshot_retention_days, actor_person_id) VALUES ($1, 'home', 211, 33, $2)`, [T2.tenant, T2.owner]);
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

describe("readVisionRetention som app-rolle (RLS)", () => {
  it("egen tenant, alle rom unntatt health, sortert på rom - dager og tidspunkt, ingenting annet", async () => {
    const rows = await readVisionRetention(db.app, T.tenant);
    expect(rows.map((r) => r.memory_space)).toEqual(["home", "personal"]);
    expect(rows[0]).toMatchObject({ memory_space: "home", retention_days: 17, snapshot_retention_days: 5 });
    expect(rows[1]).toMatchObject({ memory_space: "personal", retention_days: 61, snapshot_retention_days: null });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["memory_space", "retention_days", "snapshot_retention_days", "updated_at"]);
      expect(new Date(row.updated_at as string).toISOString()).toBe(row.updated_at);
    }
    expect(rows.map((r) => r.retention_days)).toEqual([17, 61]); // hverken health-raden (123) eller den andre tenantens rad (211)
    expect(JSON.stringify(rows)).not.toMatch(/actor|g3bpv/); // ingen aktør eller tenant-id
  });

  it("den andre tenanten ser KUN sin egen rad (A leser aldri B), og en tenant uten rader får ingen", async () => {
    const rows2 = await readVisionRetention(db.app, T2.tenant);
    expect(rows2).toEqual([expect.objectContaining({ memory_space: "home", retention_days: 211, snapshot_retention_days: 33 })]);
    expect(await readVisionRetention(db.app, "tenant-uten-rader")).toEqual([]);
  });
});

describe("hele senteret mot ekte DB: kortet viser det eieren har satt, isolert per tenant, og senteret skriver ingenting", () => {
  it("eier A: standardene + home 17/5 og personal 61/standard; verken health, B sin rad eller aktør/tenant-navn", async () => {
    const before = await rowCounts();
    const r = await report(idT());
    expect(await rowCounts()).toEqual(before); // kun lesing
    const section = card(r);
    expect(section).toMatchObject({ id: "vision", measured: true });
    expect(section.items.find((i) => i.id === "retention_default")).toMatchObject({ facts: { retention_days: 30, snapshot_retention_days: 7 } });
    expect(section.items.find((i) => i.id === "retention:home")).toMatchObject({ status: "OK", facts: { retention_days: 17, snapshot_retention_days: 5, effective_snapshot_retention_days: 5 } });
    expect(section.items.find((i) => i.id === "retention:personal")).toMatchObject({ facts: { retention_days: 61, snapshot_retention_days: null, effective_snapshot_retention_days: 7 } });
    expect(section.items.some((i) => i.id === "retention:health")).toBe(false);
    const daysShown = section.items.map((i) => i.facts?.["retention_days"]).filter((d) => d !== undefined);
    expect(daysShown).toEqual(expect.arrayContaining([30, 17, 61]));
    expect(daysShown).not.toContain(123); // health er isolert
    expect(daysShown).not.toContain(211); // den andre tenantens rad
    expect(JSON.stringify(section)).not.toMatch(new RegExp(`${T.owner}|${T.tenant}|${T2.owner}|${T2.tenant}`));
  });

  it("eier B ser sin egen rad og aldri A sine", async () => {
    const section = card(await report(idT2()));
    expect(section.items.find((i) => i.id === "retention:home")).toMatchObject({ facts: { retention_days: 211, snapshot_retention_days: 33 } });
    expect(section.items.some((i) => i.id === "retention:personal")).toBe(false);
    const daysShown = section.items.map((i) => i.facts?.["retention_days"]).filter((d) => d !== undefined);
    expect([...daysShown].sort()).toEqual([211, 30].sort()); // standard (30) og egen rad (211) - aldri A sine
    expect(JSON.stringify(section)).not.toMatch(new RegExp(`${T.owner}|${T.tenant}|${T2.owner}|${T2.tenant}`));
  });

  it("en endring gjort gjennom eier-veien (tjenesten) vises ved neste bygging; en gjenspilling endrer ingenting", async () => {
    await vision.applyRetentionPolicy(T.tenant, "home", { retention_days: 40, snapshot_retention_days: 5 }, { actor_person_id: T.owner, audit: true });
    expect(card(await report(idT())).items.find((i) => i.id === "retention:home")).toMatchObject({ facts: { retention_days: 40, snapshot_retention_days: 5 } });
    const again = await vision.applyRetentionPolicy(T.tenant, "home", { retention_days: 40, snapshot_retention_days: 5 }, { actor_person_id: T.owner, audit: true });
    expect(again.changed).toBe(false);
  });

  it("selve byggingen av kortet med den ekte poolen gir en målt seksjon uten feil (og uten at helsebildet er koblet: poller av = OK)", async () => {
    const section = await buildVisionSection({ source, pool: db.app, tenantId: T.tenant, nowMs: NOW.getTime(), nowIso: NOW.toISOString() });
    expect(section.measured).toBe(true);
    expect(section.items.find((i) => i.id === "poller")).toMatchObject({ status: "OK", facts: { enabled: false } });
    expect(section.items.find((i) => i.id === "maintenance_light")?.status).toBe("UNKNOWN"); // ikke kjørt ennå
  });
});
