import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ExecutiveService, INFRA_TARGETS } from "@jarvis/executive";
import { IncidentService, ProducerRunStore } from "@jarvis/incidents";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { createInfraStatusSource } from "../src/infra-status-source.ts";

/**
 * WP-E1 (UA-5, JARVIS-068): driftsstatus-kilden mot EKTE Postgres som app-rollen. Beviser fase/alvorlighet/sannhetsmerking/siste endring, siste journalførte endring per skymål, produsent-helse,
 * RLS-isolasjon mellom tenanter og minne-rom - og at verken bevistekst, årsaker eller andre fritekstfelt forlater databasen.
 */
const A = "tenant-e1st-a";
const B = "tenant-e1st-b";
const LEAK_CANARY = "kanarifugl-evidenstekst-skal-ikke-vises";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let incidents: IncidentService;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1st-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1st LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_test_e1st");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','business'), ('${B}','B','business')`);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('p-e1st','Eier')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1st", password: "pw2" });
  incidents = new IncidentService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("createInfraStatusSource", () => {
  it("åpne hendelser: fase, alvorlighet (kritisk først), sannhetsmerking, siste endring og antall - uten bevistekst; løste telles separat", async () => {
    const produced = await incidents.openFromFact(A, "business", {
      source_kind: "deployment", subject: "acme/web@main", title: "Utrulling feilet: acme/web (main)", severity: "high", observed_at: new Date().toISOString(),
      evidence: { source_type: "deployment", source_ref: "dep-1", summary: LEAK_CANARY }
    });
    if (produced.action !== "opened") throw new Error("forventet opened");
    await incidents.addEvidence(A, "business", produced.incident.incident_id, { source_type: "log", summary: LEAK_CANARY, observed_at: new Date().toISOString() });
    const check = await incidents.addEvidence(A, "business", produced.incident.incident_id, { source_type: "log", summary: LEAK_CANARY, observed_at: new Date().toISOString(), asserted_by: "check" });
    await incidents.verifyEvidence(A, "business", check.evidence_id, { verified_by: "independent_probe", basis: LEAK_CANARY });
    const manual = await incidents.createIncident(A, "business", { title: "Manuell kritisk", severity: "critical", owner_person_id: null as never });
    await incidents.transition(A, "business", manual.incident_id, "repair_proposed", { kind: "repair" }, { reason: LEAK_CANARY, evidence_ref: "task-1" });
    const done = await incidents.createIncident(A, "business", { title: "Løst for lenge siden" });
    await incidents.transition(A, "business", done.incident_id, "resolved", { kind: "owner", person_id: "p-e1st" }, { reason: "ferdig" });

    const m = await createInfraStatusSource(app).measure(A);
    expect(m.incidents).not.toBeNull();
    const active = m.incidents!.active;
    expect(active[0]).toMatchObject({ title: "Manuell kritisk", severity: "critical", phase: "mitigating", phase_no: "avbøting foreslått", last_change: { actor_kind: "repair", to_phase_no: "avbøting foreslått" } });
    const dep = active.find((i) => i.source_kind === "deployment")!;
    expect(dep).toMatchObject({ severity: "high", phase_no: "åpen", occurrence_count: 1, evidence: { verified: 1, observed: 1, claimed: 1 } });
    expect(m.incidents!.active_total).toBe(2);
    expect(active.some((i) => i.title === "Løst for lenge siden")).toBe(false);
    expect(m.incidents!.resolved_last_7d).toBe(1);
    expect(m.incidents!.by_phase["mitigating"]).toBeGreaterThanOrEqual(1);
    // Ingen fritekst (bevis/årsak/grunnlag) i svaret.
    expect(JSON.stringify(m)).not.toContain("kanarifugl");
  });

  it("siste journalførte endring per skymål, og produsentenes helse", async () => {
    await admin.query(
      `INSERT INTO infra_executions (execution_id, tenant_id, target, provider, tool_id, action, risk_class, idempotency_key, requested_operation, recovery_plan, verification_outcome, created_at)
       VALUES ('ie-old', $1, 'z1', 'cloudflare', 'cloudflare', 'create_dns_record', 'D', 'k1', 'op', 'plan', 'FAILED', now() - interval '2 hours'),
              ('ie-new', $1, 'z1', 'cloudflare', 'cloudflare', 'delete_dns_record', 'D', 'k2', 'op', 'plan', 'SUCCESS', now() - interval '1 hour'),
              ('ie-pg', $1, 'jarvis', 'postgres_ops', 'postgres_ops', 'cancel_query', 'D', 'k3', 'op', 'plan', 'PARTIAL', now()),
              ('ie-other', $2, 'z9', 'cloudflare', 'cloudflare', 'create_dns_record', 'D', 'k4', 'op', 'plan', 'SUCCESS', now())`,
      [A, B]
    );
    const runs = new ProducerRunStore(app);
    await runs.start(A, "slo", new Date());
    await runs.finish(A, "slo", new Date(), { status: "failed", error: "kilde nede", facts_seen: 0, opened: 0, updated: 0, resolved: 0, suppressed: 0 });
    const m = await createInfraStatusSource(app).measure(A);
    expect(m.last_changes?.["cloudflare"]).toMatchObject({ action: "delete_dns_record", outcome: "SUCCESS" });
    expect(m.last_changes?.["postgres_ops"]).toMatchObject({ action: "cancel_query", outcome: "PARTIAL" });
    expect(m.last_changes?.["docker"]).toBeUndefined();
    expect(m.producer_runs).toEqual([expect.objectContaining({ producer: "slo", last_status: "failed", consecutive_failures: 1, last_error: "kilde nede" })]);
  });

  it("RLS: en annen tenant ser verken hendelser, endringer eller produsent-helse; hendelser utenfor business-rommet leses ikke", async () => {
    await incidents.createIncident(B, "business", { title: "Kun tenant B" });
    await incidents.createIncident(A, "personal", { title: "Personlig rom - ikke driftsstatus" });
    const a = await createInfraStatusSource(app).measure(A);
    const b = await createInfraStatusSource(app).measure(B);
    expect(a.incidents!.active.some((i) => i.title === "Kun tenant B")).toBe(false);
    expect(a.incidents!.active.some((i) => i.title.startsWith("Personlig rom"))).toBe(false);
    expect(b.incidents!.active.map((i) => i.title)).toEqual(["Kun tenant B"]);
    expect(b.last_changes?.["cloudflare"]).toMatchObject({ action: "create_dns_record" }); // B sin egen eksekusjon, ikke A sin
    expect(b.producer_runs).toEqual([]);
    expect(a.errors.some((e) => e.includes("business"))).toBe(true);
  });

  it("hele kjeden: ExecutiveService.getInfraStatus over den ekte kilden gir en lesbar norsk oppsummering uten hemmeligheter", async () => {
    const gateway = { list: () => INFRA_TARGETS.map((t) => ({ tool_id: t.tool_id, credential_ref: `REF_${t.tool_id}` })), health: new Map([["cloudflare", { state: "healthy", at: new Date().toISOString() }]]), hasSecret: async (ref: string) => ref === "REF_cloudflare" } as unknown as ToolGateway;
    const svc = new ExecutiveService(gateway, { infra: { source: createInfraStatusSource(app), producers_enabled: true, producer_names: ["slo", "scheduler"], producers_interval_ms: 300_000, mode: async () => "NORMAL" } });
    const r = await svc.getInfraStatus(A);
    expect(r.targets.find((t) => t.id === "cloudflare")).toMatchObject({ state: "ok", last_change: { action: "delete_dns_record" } });
    expect(r.targets.find((t) => t.id === "docker")?.state).toBe("dormant");
    expect(r.producers.find((p) => p.producer === "slo")?.state).toBe("failed");
    expect(r.producers.find((p) => p.producer === "scheduler")?.state).toBe("never_ran");
    expect(r.summary_no).toContain("åpne hendelser");
    expect(r.summary_no).toContain("Cloudflare (DNS/WAF): ok");
    expect(JSON.stringify(r)).not.toMatch(/kanarifugl|REF_/);
  });
});
