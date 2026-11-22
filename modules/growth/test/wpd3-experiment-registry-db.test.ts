import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { ExperimentRegistryService, type Provenance } from "../src/experiments/registry-service.ts";
import { GrowthService } from "../src/service.ts";

/**
 * WP-D3 (D-459): eksperimentregister v2 mot EKTE Postgres/RLS (NOSUPERUSER/NOBYPASSRLS-rolle, samme mønster som `service-rls.test.ts`). Bevist: plan/variant/observasjon/utfall,
 * idempotens, proveniens på hver rad, tenant- og space-isolasjon (også gjennom komposittnøklene), uforanderlige utfall, utledning fra Jarvis' egne spend-/attribusjonsrader og
 * at et avsluttet eksperiment ikke kan endres.
 */
let stopPg: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let registry: ExperimentRegistryService;
let growth: GrowthService;
const A = "tenant-d3-reg-a";
const B = "tenant-d3-reg-b";
const OWNER: Provenance = { source: "owner", actor_person_id: "person-d3-owner", task_id: "task-d3-1", session_id: "sess-d3-1" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d3-reg-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopPg = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d3_reg LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_d3_reg");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}', 'D3 A', 'business'), ('${B}', 'D3 B', 'business')`);
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-d3-owner', 'D3 Owner')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_d3_reg", password: "pw2" });
  registry = new ExperimentRegistryService(appPool);
  growth = new GrowthService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopPg?.();
}, 120_000);

async function runningExperiment(tenant = A, campaignId?: string) {
  const e = await growth.createExperiment(tenant, "business", { name: `Eksperiment ${Math.random().toString(36).slice(2, 8)}`, hypothesis: "Overskrift B gir høyere CTR", ...(campaignId ? { campaign_id: campaignId } : {}) });
  await growth.setExperimentStatus(tenant, "business", e.experiment_id, "running");
  return e;
}
const PLAN = { primary_metric: "ctr" as const, window_start: "2026-10-01", window_end: "2026-10-14" };
async function withVariants(experimentId: string, tenant = A) {
  const control = await registry.addVariant(tenant, "business", experimentId, { variant_key: "control", label: "Dagens annonse", variant_kind: "creative", is_control: true, status: "live" }, OWNER);
  const b = await registry.addVariant(tenant, "business", experimentId, { variant_key: "b", label: "Ny overskrift", variant_kind: "creative", status: "live" }, OWNER);
  return { control, b };
}
const obs = (variantId: string, day: string, impressions: number, clicks: number, extra: Record<string, number> = {}, tenant = A) =>
  registry.recordObservation(tenant, "business", variantId, { observed_on: day, impressions, clicks, ...extra }, OWNER);

describe("A: plan", () => {
  it("setPlan er idempotent per eksperiment (én rad), leder retningen fra metrikken og bærer proveniens", async () => {
    const e = await runningExperiment();
    const first = await registry.setPlan(A, "business", e.experiment_id, PLAN, OWNER);
    const second = await registry.setPlan(A, "business", e.experiment_id, { ...PLAN, primary_metric: "cpa", min_effect_pct: 10 }, { ...OWNER, task_id: "task-d3-2" });
    expect(second.plan_id).toBe(first.plan_id);
    expect(second.primary_metric).toBe("cpa");
    expect(second.metric_direction).toBe("lower_is_better");
    expect(second.task_id).toBe("task-d3-2");
    expect(first.source).toBe("owner");
    expect(first.actor_person_id).toBe("person-d3-owner");
    expect(first.session_id).toBe("sess-d3-1");
    const rows = await adminPool.query("SELECT count(*)::int AS n FROM marketing_experiment_plans WHERE experiment_id = $1", [e.experiment_id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("avviser ugyldig metrikk, dato, vindu, konfidensnivå og terskler FØR noe skrives", async () => {
    const e = await runningExperiment();
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, primary_metric: "mrr" as never }, OWNER)).rejects.toThrow("experiment_invalid_metric");
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, window_start: "2026-13-40" }, OWNER)).rejects.toThrow("experiment_invalid_date:window_start");
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, window_start: "2026-10-20" }, OWNER)).rejects.toThrow("experiment_invalid_window");
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, confidence_level: 0.5 }, OWNER)).rejects.toThrow("experiment_invalid_confidence_level");
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, min_effect_pct: -1 }, OWNER)).rejects.toThrow("experiment_invalid_min_effect_pct");
    await expect(registry.setPlan(A, "business", e.experiment_id, { ...PLAN, min_impressions_per_variant: -5 }, OWNER)).rejects.toThrow("experiment_invalid_count");
    expect(await registry.getPlan(A, "business", e.experiment_id)).toBeNull();
  });

  it("DB-en avviser også en plan med feil retning for metrikken (CHECK), selv ved et direkte INSERT", async () => {
    const e = await runningExperiment();
    await expect(withMemoryTransaction(appPool, A, ["business"], (c) => c.query(
      `INSERT INTO marketing_experiment_plans (plan_id, tenant_id, experiment_id, primary_metric, metric_direction, window_start, window_end, source) VALUES ('p-bad', $1, $2, 'ctr', 'lower_is_better', '2026-10-01', '2026-10-02', 'owner')`,
      [A, e.experiment_id]
    ))).rejects.toThrow();
  });

  it("tenant-isolasjon: tenant B kan ikke sette plan på tenant A sitt eksperiment, og ser det ikke", async () => {
    const e = await runningExperiment(A);
    await registry.setPlan(A, "business", e.experiment_id, PLAN, OWNER);
    await expect(registry.setPlan(B, "business", e.experiment_id, PLAN, OWNER)).rejects.toThrow("experiment_not_found");
    expect(await registry.getPlan(B, "business", e.experiment_id)).toBeNull();
  });

  it("et avsluttet eksperiment kan ikke få ny plan, nye varianter eller nye observasjoner", async () => {
    const e = await runningExperiment();
    await registry.setPlan(A, "business", e.experiment_id, { ...PLAN, min_impressions_per_variant: 0 }, OWNER);
    const { control } = await withVariants(e.experiment_id);
    await growth.setExperimentStatus(A, "business", e.experiment_id, "abandoned");
    await expect(registry.setPlan(A, "business", e.experiment_id, PLAN, OWNER)).rejects.toThrow("experiment_closed:abandoned");
    await expect(registry.addVariant(A, "business", e.experiment_id, { variant_key: "c", label: "C", variant_kind: "creative" }, OWNER)).rejects.toThrow("experiment_closed:abandoned");
    await expect(obs(control.variant_id, "2026-10-02", 100, 5)).rejects.toThrow("experiment_closed:abandoned");
  });
});

describe("B: varianter", () => {
  it("legger til kontroll og utfordrer; samme nøkkel og en andre kontroll avvises med stabile feilkoder", async () => {
    const e = await runningExperiment();
    const { control, b } = await withVariants(e.experiment_id);
    expect(control.is_control).toBe(true);
    expect(b.is_control).toBe(false);
    await expect(registry.addVariant(A, "business", e.experiment_id, { variant_key: "b", label: "Dobbel", variant_kind: "creative" }, OWNER)).rejects.toThrow("experiment_variant_key_exists");
    await expect(registry.addVariant(A, "business", e.experiment_id, { variant_key: "c", label: "Annen kontroll", variant_kind: "creative", is_control: true }, OWNER)).rejects.toThrow("experiment_control_exists");
    expect((await registry.listVariants(A, "business", e.experiment_id)).map((v) => v.variant_key)).toEqual(["b", "control"]);
  });

  it("validerer nøkkel, label, pekere og kreativ-størrelse", async () => {
    const e = await runningExperiment();
    const base = { label: "L", variant_kind: "creative" as const };
    await expect(registry.addVariant(A, "business", e.experiment_id, { ...base, variant_key: "Stor Bokstav" }, OWNER)).rejects.toThrow("experiment_invalid_variant_key");
    await expect(registry.addVariant(A, "business", e.experiment_id, { ...base, variant_key: "x", label: "" }, OWNER)).rejects.toThrow("experiment_invalid_label");
    await expect(registry.addVariant(A, "business", e.experiment_id, { ...base, variant_key: "x", external_ref: "med mellomrom og ; semikolon" }, OWNER)).rejects.toThrow("experiment_invalid_external_ref");
    await expect(registry.addVariant(A, "business", e.experiment_id, { ...base, variant_key: "x", creative: { headlines: ["a".repeat(9000)] } }, OWNER)).rejects.toThrow("experiment_creative_too_large");
  });

  it("komposittnøkkel: en variant kan ikke peke på en annen tenants kampanje (heller ikke ved kjent id)", async () => {
    const campaignB = await growth.createCampaign(B, "business", { channel: "google_ads", name: "B-kampanje" });
    const e = await runningExperiment(A);
    await expect(registry.addVariant(A, "business", e.experiment_id, { variant_key: "x", label: "X", variant_kind: "creative", campaign_id: campaignB.campaign_id }, OWNER)).rejects.toThrow("experiment_campaign_not_found");
    await expect(registry.addVariant(A, "business", e.experiment_id, { variant_key: "y", label: "Y", variant_kind: "creative", campaign_id: "finnes-ikke" }, OWNER)).rejects.toThrow("experiment_campaign_not_found");
  });

  it("en variant med kampanje gir en tidslinjehendelse og bærer pekeren (pointer-not-payload)", async () => {
    const campaign = await growth.createCampaign(A, "business", { channel: "google_ads", name: "Variantkampanje" });
    const e = await runningExperiment(A, campaign.campaign_id);
    const v = await registry.addVariant(A, "business", e.experiment_id, { variant_key: "ad1", label: "Annonse 1", variant_kind: "creative", campaign_id: campaign.campaign_id, channel: "google_ads", external_ref: "googleads:customers/1234567890/adGroupAds/11~22" }, OWNER);
    expect(v.external_ref).toBe("googleads:customers/1234567890/adGroupAds/11~22");
    const events = await growth.listEvents(A, "business", campaign.campaign_id);
    expect(events.some((x) => x.event_type === "experiment_variant_added" && (x.metadata as { variant_key?: string }).variant_key === "ad1")).toBe(true);
  });

  it("setVariantStatus oppdaterer kun i egen tenant", async () => {
    const e = await runningExperiment();
    const { b } = await withVariants(e.experiment_id);
    expect((await registry.setVariantStatus(A, "business", b.variant_id, "paused"))!.status).toBe("paused");
    expect(await registry.setVariantStatus(B, "business", b.variant_id, "retired")).toBeNull();
    await expect(registry.setVariantStatus(A, "business", b.variant_id, "slettet" as never)).rejects.toThrow("experiment_invalid_variant_status");
  });
});

describe("C: observasjoner", () => {
  it("idempotent per (variant, dag, kilde): samme dag oppdaterer SAMME rad; en annen kilde er en egen rad", async () => {
    const e = await runningExperiment();
    const { control } = await withVariants(e.experiment_id);
    const first = await obs(control.variant_id, "2026-10-02", 1000, 20);
    const again = await obs(control.variant_id, "2026-10-02", 1100, 22);
    expect(again.observation_id).toBe(first.observation_id);
    expect(again.impressions).toBe("1100");
    const csv = await registry.recordObservation(A, "business", control.variant_id, { observed_on: "2026-10-02", impressions: 1200, clicks: 24, source_type: "csv_import" }, { ...OWNER, source: "import" });
    expect(csv.observation_id).not.toBe(first.observation_id);
    expect(csv.source).toBe("import");
    expect((await registry.listObservations(A, "business", e.experiment_id)).length).toBe(2);
  });

  it("validerer dato og tellinger (negative, ikke-heltall, urealistisk store)", async () => {
    const e = await runningExperiment();
    const { control } = await withVariants(e.experiment_id);
    await expect(obs(control.variant_id, "2026-02-30", 1, 0)).rejects.toThrow("experiment_invalid_date:observed_on");
    await expect(obs(control.variant_id, "2026-10-02", -1, 0)).rejects.toThrow("experiment_invalid_count:impressions");
    await expect(obs(control.variant_id, "2026-10-02", 1.5, 0)).rejects.toThrow("experiment_invalid_count:impressions");
    await expect(obs(control.variant_id, "2026-10-02", 10, 0, { spend_ore: 10 ** 13 })).rejects.toThrow("experiment_invalid_count:spend_ore");
    await expect(obs("finnes-ikke", "2026-10-02", 1, 0)).rejects.toThrow("experiment_variant_not_found");
  });

  it("tenant-isolasjon: tenant B kan ikke registrere tall på tenant A sin variant", async () => {
    const e = await runningExperiment();
    const { control } = await withVariants(e.experiment_id);
    await expect(obs(control.variant_id, "2026-10-02", 100, 1, {}, B)).rejects.toThrow("experiment_variant_not_found");
  });

  it("komposittnøkkel: en observasjon kan ikke pekes på en variant fra et ANNET eksperiment (direkte INSERT feiler)", async () => {
    const e1 = await runningExperiment();
    const e2 = await runningExperiment();
    const v1 = await registry.addVariant(A, "business", e1.experiment_id, { variant_key: "control", label: "C", variant_kind: "creative", is_control: true }, OWNER);
    await expect(withMemoryTransaction(appPool, A, ["business"], (c) => c.query(
      `INSERT INTO marketing_experiment_observations (observation_id, tenant_id, experiment_id, variant_id, observed_on, source_type, source) VALUES ('o-bad', $1, $2, $3, '2026-10-02', 'manual', 'owner')`,
      [A, e2.experiment_id, v1.variant_id]
    ))).rejects.toThrow();
  });

  it("RLS: tenant B og feil memory space ser ingen av rader tenant A har skrevet", async () => {
    const e = await runningExperiment();
    const { control } = await withVariants(e.experiment_id);
    await obs(control.variant_id, "2026-10-03", 500, 10);
    for (const table of ["marketing_experiment_plans", "marketing_experiment_variants", "marketing_experiment_observations", "marketing_experiment_outcomes"]) {
      const asB = await withMemoryTransaction(appPool, B, ["business"], (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(asB.rows[0].n, table).toBe(0);
      const wrongSpace = await withMemoryTransaction(appPool, A, ["personal"], (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(wrongSpace.rows[0].n, table).toBe(0);
    }
    const asA = await withMemoryTransaction(appPool, A, ["business"], (c) => c.query("SELECT count(*)::int AS n FROM marketing_experiment_observations"));
    expect(asA.rows[0].n).toBeGreaterThan(0);
  });
});

describe("D: utledning fra Jarvis' egne rader (spend -> klikk -> lead -> kunde -> omsetning, kampanjenivå)", () => {
  it("utleder observasjoner fra utgiftsrader og vunne, tilskrevne muligheter; hopper over utenlandsk valuta; idempotent", async () => {
    const campaign = await growth.createCampaign(A, "business", { channel: "google_ads", name: "Utledet kampanje" });
    const e = await runningExperiment(A, campaign.campaign_id);
    const v = await registry.addVariant(A, "business", e.experiment_id, { variant_key: "kamp", label: "Kampanjevariant", variant_kind: "budget", campaign_id: campaign.campaign_id }, OWNER);
    await growth.recordSpendEvent(A, "business", campaign.campaign_id, { event_date: "2026-10-05", spend_amount_ore: 50_000, clicks: 400, impressions: 20_000, source_type: "provider_sync" });
    await growth.recordSpendEvent(A, "business", campaign.campaign_id, { event_date: "2026-10-05", spend_amount_ore: 49_000, clicks: 390, impressions: 19_000, source_type: "manual" }); // lavere tillit - skal ikke dobbelttelles
    await growth.recordSpendEvent(A, "business", campaign.campaign_id, { event_date: "2026-10-06", spend_amount_ore: 10_000, clicks: 80, impressions: 4000, currency: "USD", source_type: "provider_sync" });
    await adminPool.query(`INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, title, stage, value_ore, closed_at) VALUES ('opp-d3-1', $1, 'business', 'Vunnet', 'won', 250000, '2026-10-05T14:00:00Z')`, [A]);
    await growth.attributeToCampaign(A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-d3-1" });

    const first = await registry.deriveObservationsFromCampaign(A, "business", v.variant_id, { from: "2026-10-01", to: "2026-10-10" }, OWNER);
    expect(first.days_written).toBe(1);
    expect(first.days_skipped_foreign_currency).toBe(1);
    const row = first.observations[0]!;
    expect(row).toMatchObject({ observed_on: "2026-10-05", source_type: "derived_from_campaign", impressions: "20000", clicks: "400", conversions: "1", spend_ore: "50000", revenue_ore: "250000", source_pointer: `campaign:${campaign.campaign_id}`, source: "owner" });
    const second = await registry.deriveObservationsFromCampaign(A, "business", v.variant_id, { from: "2026-10-01", to: "2026-10-10" }, OWNER);
    expect(second.observations[0]!.observation_id).toBe(row.observation_id);
    expect((await registry.listObservations(A, "business", e.experiment_id)).length).toBe(1);
  });

  it("krever en kampanje på varianten og en gyldig periode", async () => {
    const e = await runningExperiment();
    const { control } = await withVariants(e.experiment_id);
    await expect(registry.deriveObservationsFromCampaign(A, "business", control.variant_id, { from: "2026-10-01", to: "2026-10-02" }, OWNER)).rejects.toThrow("experiment_variant_has_no_campaign");
    await expect(registry.deriveObservationsFromCampaign(A, "business", control.variant_id, { from: "2026-10-05", to: "2026-10-02" }, OWNER)).rejects.toThrow("experiment_invalid_window");
  });
});

describe("E: evaluering og utfall", () => {
  async function scenario(clicksB: number) {
    const e = await runningExperiment();
    await registry.setPlan(A, "business", e.experiment_id, { ...PLAN, min_impressions_per_variant: 1000 }, OWNER);
    const { control, b } = await withVariants(e.experiment_id);
    for (const day of ["2026-10-02", "2026-10-03"]) {
      await obs(control.variant_id, day, 5000, 100);
      await obs(b.variant_id, day, 5000, clicksB / 2);
    }
    return { e, control, b };
  }

  it("evaluate leser (lagrer ingenting) og gir en deterministisk vinner med digest; samme data gir samme digest", async () => {
    const { e, b } = await scenario(300);
    const r1 = await registry.evaluate(A, "business", e.experiment_id);
    const r2 = await registry.evaluate(A, "business", e.experiment_id);
    expect(r1.evaluation.verdict).toBe("winner");
    expect(r1.evaluation.winner_variant_id).toBe(b.variant_id);
    expect(r1.evaluation_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.evaluation_digest).toBe(r1.evaluation_digest);
    expect((await registry.listOutcomes(A, "business", e.experiment_id)).length).toBe(0);
  });

  it("per (variant, dag) teller kun kilden med høyest tillit - en manuell og en importert rad for samme dag dobbelttelles aldri", async () => {
    const { e, control } = await scenario(300);
    await registry.recordObservation(A, "business", control.variant_id, { observed_on: "2026-10-02", impressions: 5000, clicks: 100, source_type: "csv_import" }, { ...OWNER, source: "import" });
    const { evaluation } = await registry.evaluate(A, "business", e.experiment_id);
    expect(evaluation.variants.find((v) => v.is_control)!.totals.impressions).toBe(10_000);
  });

  it("observasjoner utenfor planens vindu teller ikke", async () => {
    const { e, control } = await scenario(300);
    await obs(control.variant_id, "2026-09-01", 999_999, 99_999);
    const { evaluation } = await registry.evaluate(A, "business", e.experiment_id);
    expect(evaluation.variants.find((v) => v.is_control)!.totals.impressions).toBe(10_000);
  });

  it("recordOutcome(rule): avslutter eksperimentet med deterministisk oppsummering, er idempotent og bærer proveniens", async () => {
    const { e, b } = await scenario(300);
    const r = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule", rationale: "Automatisk avgjørelse etter vindu" }, OWNER);
    expect(r.replayed).toBe(false);
    expect(r.outcome.verdict).toBe("winner");
    expect(r.outcome.winner_variant_id).toBe(b.variant_id);
    expect(r.outcome.evaluation_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.outcome.evidence.owner_override).toBe(false);
    expect(r.outcome.actor_person_id).toBe("person-d3-owner");
    expect(r.outcome.task_id).toBe("task-d3-1");
    expect(r.experiment.status).toBe("concluded");
    expect(r.experiment.result_summary).toContain("Vinner: b");
    // Gjenta: eksperimentet er avsluttet -> avvises (idempotent replay skjer før avslutning ved samme digest, men status er nå terminal).
    await expect(registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule" }, OWNER)).rejects.toThrow("experiment_closed:concluded");
    expect((await registry.listOutcomes(A, "business", e.experiment_id)).length).toBe(1);
  });

  it("inconclusive endrer ikke status, og gjentatt registrering av SAMME evaluering gir samme rad (replay)", async () => {
    const e = await runningExperiment();
    await registry.setPlan(A, "business", e.experiment_id, { ...PLAN, min_impressions_per_variant: 100_000 }, OWNER);
    const { control, b } = await withVariants(e.experiment_id);
    await obs(control.variant_id, "2026-10-02", 1000, 20);
    await obs(b.variant_id, "2026-10-02", 1000, 40);
    const first = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule" }, OWNER);
    expect(first.outcome.verdict).toBe("inconclusive");
    expect(first.experiment.status).toBe("running");
    const again = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule" }, OWNER);
    expect(again.replayed).toBe(true);
    expect(again.outcome.outcome_id).toBe(first.outcome.outcome_id);
    // Nye data gir en ny digest og dermed et nytt utfall - det gamle står urørt (append-only).
    await obs(b.variant_id, "2026-10-03", 1000, 41);
    const third = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule" }, OWNER);
    expect(third.replayed).toBe(false);
    expect((await registry.listOutcomes(A, "business", e.experiment_id)).length).toBe(2);
  });

  it("owner kan overstyre (merkes), men kan ikke velge en vinner utenfor eksperimentet, og rule-utfall må være lik evalueringen", async () => {
    const { e, control, b } = await scenario(300);
    const other = await runningExperiment();
    const foreign = await registry.addVariant(A, "business", other.experiment_id, { variant_key: "z", label: "Z", variant_kind: "creative" }, OWNER);
    await expect(registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "owner", verdict: "winner", winner_variant_id: foreign.variant_id }, OWNER)).rejects.toThrow("experiment_winner_not_in_experiment");
    await expect(registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "owner" }, OWNER)).rejects.toThrow("experiment_owner_outcome_requires_verdict");
    await expect(registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "owner", verdict: "no_winner", winner_variant_id: b.variant_id }, OWNER)).rejects.toThrow("experiment_winner_only_with_winner_verdict");
    await expect(registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule", verdict: "no_winner" }, OWNER)).rejects.toThrow("experiment_rule_outcome_must_match_evaluation");
    const r = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "owner", verdict: "winner", winner_variant_id: control.variant_id, rationale: "Beholder dagens annonse av merkevarehensyn" }, OWNER);
    expect(r.outcome.evidence.owner_override).toBe(true);
    expect(r.outcome.decided_by).toBe("owner");
  });

  it("abandoned forlater eksperimentet; winner krever et løpende eksperiment (draft kan ikke avsluttes)", async () => {
    const draft = await growth.createExperiment(A, "business", { name: "Utkast" });
    await registry.setPlan(A, "business", draft.experiment_id, PLAN, OWNER);
    await registry.addVariant(A, "business", draft.experiment_id, { variant_key: "control", label: "C", variant_kind: "creative", is_control: true }, OWNER);
    await registry.addVariant(A, "business", draft.experiment_id, { variant_key: "b", label: "B", variant_kind: "creative" }, OWNER);
    await expect(registry.recordOutcome(A, "business", draft.experiment_id, { decided_by: "owner", verdict: "no_winner" }, OWNER)).rejects.toThrow("invalid_experiment_transition:draft->concluded");
    const ab = await registry.recordOutcome(A, "business", draft.experiment_id, { decided_by: "owner", verdict: "abandoned", rationale: "Kampanjen ble stoppet" }, OWNER);
    expect(ab.experiment.status).toBe("abandoned");
  });

  it("utfall er uforanderlige for runtime-rollen: UPDATE nektes, og tenant B ser ikke raden", async () => {
    const { e } = await scenario(300);
    const r = await registry.recordOutcome(A, "business", e.experiment_id, { decided_by: "rule" }, OWNER);
    await expect(withMemoryTransaction(appPool, A, ["business"], (c) => c.query(`UPDATE marketing_experiment_outcomes SET rationale = 'omskrevet' WHERE outcome_id = $1`, [r.outcome.outcome_id]))).rejects.toThrow(/permission denied/);
    expect(await registry.listOutcomes(B, "business", e.experiment_id)).toEqual([]);
  });

  it("DB-en krever vinner-variant hvis og bare hvis verdikt er winner (CHECK)", async () => {
    const { e } = await scenario(300);
    await expect(withMemoryTransaction(appPool, A, ["business"], (c) => c.query(
      `INSERT INTO marketing_experiment_outcomes (outcome_id, tenant_id, experiment_id, verdict, primary_metric, evidence, evaluation_digest, decided_by, source)
       VALUES ('o-bad', $1, $2, 'winner', 'ctr', '{}'::jsonb, $3, 'owner', 'owner')`, [A, e.experiment_id, "a".repeat(64)]
    ))).rejects.toThrow();
  });
});

describe("F: kreativ-intelligens over registerets data", () => {
  it("rangering, slitasje og kreativ-lint leser registerets egne rader", async () => {
    const e = await runningExperiment();
    await registry.setPlan(A, "business", e.experiment_id, { ...PLAN, window_end: "2026-10-31" }, OWNER);
    const control = await registry.addVariant(A, "business", e.experiment_id, { variant_key: "control", label: "C", variant_kind: "creative", is_control: true, channel: "google_ads", creative: { headlines: ["Én", "To"], descriptions: ["Beskrivelse"], final_url: "http://example.com" } }, OWNER);
    const b = await registry.addVariant(A, "business", e.experiment_id, { variant_key: "b", label: "B", variant_kind: "creative" }, OWNER);
    for (let d = 1; d <= 14; d++) {
      const day = `2026-10-${String(d).padStart(2, "0")}`;
      await obs(control.variant_id, day, 10_000, d <= 7 ? 300 : 200);
      await obs(b.variant_id, day, 10_000, 250);
    }
    const ranking = await registry.rankVariants(A, "business", e.experiment_id);
    expect(ranking.metric).toBe("ctr");
    expect(ranking.ranking[0]!.variant_key).toBe("b");
    expect((await registry.creativeFatigue(A, "business", control.variant_id)).status).toBe("fatigued");
    expect((await registry.creativeFatigue(A, "business", b.variant_id)).status).toBe("healthy");
    const lint = await registry.lintVariant(A, "business", control.variant_id);
    expect(lint.platform).toBe("google_ads");
    expect(lint.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["too_few_headlines", "too_few_descriptions", "final_url_not_https"]));
    expect((await registry.lintVariant(A, "business", b.variant_id)).issues[0]!.code).toBe("no_lint_rules_for_channel");
    const report = await registry.report(A, "business", e.experiment_id);
    expect((report["evaluation"] as { verdict: string }).verdict).toBeDefined();
    expect(JSON.stringify(report)).not.toContain("http://example.com"); // rapporten gjentar aldri kreativ-innhold
  });
});
