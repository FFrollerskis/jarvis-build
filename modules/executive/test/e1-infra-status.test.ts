import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import {
  ExecutiveService, ExecutiveTransport, INFRA_TARGETS, composeInfraStatus, executiveToolDefinitions,
  type InfraIncidentItem, type InfraMeasurements, type InfraStatusSource
} from "../src/index.ts";

/**
 * WP-E1 (UA-5, JARVIS-068): `ExecutiveService.getInfraStatus` + `executive.get_infra_status` (klasse A). DB-uavhengig: kilden og gatewayen er fakes. Beviser at ukjent aldri vises som frisk,
 * at «ingen hendelser» ikke blir en falsk trygghet når automatisk oppdagelse er AV, at en kilde som svikter gir `not_measured` (aldri 0/kast), og at ingen hemmeligheter eller hendelsestekst slipper ut.
 */
const NOW = new Date("2026-10-09T10:00:00.000Z");
const id: IdentityContext = { person_id: "p-owner", tenant_id: "tenant-A", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" };

function fakeGateway(opts: { tools?: string[]; secrets?: Record<string, boolean>; health?: Record<string, string>; secretsThrow?: boolean } = {}): ToolGateway {
  const tools = opts.tools ?? INFRA_TARGETS.map((t) => t.tool_id);
  const list = () => tools.map((tool_id) => ({ tool_id, action: "x", credential_ref: `REF_${tool_id}`, capability_class: "A" }));
  const health = new Map(Object.entries(opts.health ?? {}).map(([k, state]) => [k, { state, at: NOW.toISOString() }]));
  return { list, health, hasSecret: async (ref: string) => { if (opts.secretsThrow) throw new Error("vault nede"); return opts.secrets?.[ref] ?? true; } } as unknown as ToolGateway;
}

const item = (over: Partial<InfraIncidentItem> = {}): InfraIncidentItem => ({
  incident_id: "inc-1", title: "Utrulling feilet: a/b (main)", severity: "high", source_kind: "deployment", phase: "open", phase_no: "åpen", opened_at: NOW.toISOString(), last_seen_at: NOW.toISOString(),
  occurrence_count: 3, last_change: { at: NOW.toISOString(), actor_kind: "producer", to_phase_no: "åpen" }, evidence: { verified: 0, observed: 2, claimed: 1 }, ...over
});
const measurements = (over: Partial<InfraMeasurements> = {}): InfraMeasurements => ({
  incidents: { active: [item()], active_total: 1, by_phase: { open: 1 }, resolved_last_7d: 4 },
  last_changes: { cloudflare: { at: NOW.toISOString(), action: "create_dns_record", outcome: "SUCCESS" } },
  producer_runs: INFRA_PRODUCERS.map((producer) => ({ producer, last_status: "ok", last_started_at: new Date(NOW.getTime() - 60_000).toISOString(), consecutive_failures: 0, opened: 1, updated: 0, resolved: 0, suppressed: 0, last_error: null })),
  errors: [], ...over
});
const INFRA_PRODUCERS = ["scheduler", "deployment", "sentry", "slo", "provider", "infra_execution", "watchdog"];

function service(over: { gw?: ToolGateway; source?: InfraStatusSource; enabled?: boolean; mode?: () => Promise<string | null> } = {}) {
  const calls: string[] = [];
  const source: InfraStatusSource = over.source ?? { measure: async (tenant) => { calls.push(tenant); return measurements(); } };
  const svc = new ExecutiveService(over.gw ?? fakeGateway({ health: { cloudflare: "healthy" } }), {
    infra: { source, producers_enabled: over.enabled ?? true, producer_names: INFRA_PRODUCERS, producers_interval_ms: 300_000, ...(over.mode ? { mode: over.mode } : {}) }
  });
  return { svc, calls };
}

describe("composeInfraStatus", () => {
  it("skymål: sovende uten registrering/credential, ukjent uten helsemåling (aldri frisk), og helse -> ok/redusert/nede", () => {
    const facts = [
      { tool_id: "cloudflare", registered: true, configured: true, health: { state: "healthy", at: NOW.toISOString() } },
      { tool_id: "vercel", registered: true, configured: true, health: { state: "rate_limited", at: NOW.toISOString() } },
      { tool_id: "gce", registered: true, configured: true, health: { state: "auth_failed", at: NOW.toISOString() } },
      { tool_id: "docker", registered: true, configured: true, health: null },
      { tool_id: "langfuse", registered: true, configured: false, health: null },
      { tool_id: "infisical", registered: false, configured: false, health: null },
      { tool_id: "postgres_ops", registered: true, configured: null, health: null }
    ];
    const report = composeInfraStatus({ as_of: NOW, targets: facts, measurements: measurements(), producers_enabled: true, producers_interval_ms: 300_000, producer_names: INFRA_PRODUCERS, infra_mode: "NORMAL" });
    const state = Object.fromEntries(report.targets.map((t) => [t.id, t.state]));
    expect(state).toEqual({ cloudflare: "ok", vercel: "degraded", gcp: "down", docker: "unknown", langfuse: "dormant", infisical: "dormant", postgres: "unknown" });
    expect(report.targets.find((t) => t.id === "cloudflare")?.last_change).toMatchObject({ action: "create_dns_record", outcome: "SUCCESS" });
    expect(report.summary_no).toContain("Docker (NAS): ukjent");
    expect(report.summary_no).toContain("Langfuse (sporing): sovende");
  });

  it("automatisk oppdagelse AV: «ingen hendelser» får et uttrykkelig forbehold, og produsentene vises som disabled", () => {
    const report = composeInfraStatus({
      as_of: NOW, targets: [], measurements: measurements({ incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 } }), producers_enabled: false,
      producers_interval_ms: 300_000, producer_names: INFRA_PRODUCERS, infra_mode: null
    });
    expect(report.auto_detection).toBe(false);
    expect(report.summary_no).toContain("automatisk oppdagelse er AV");
    expect(report.summary_no).toContain("JARVIS_INCIDENT_PRODUCERS_ENABLED=true");
    expect(report.producers.every((p) => p.state === "disabled")).toBe(true);
    const on = composeInfraStatus({
      as_of: NOW, targets: [], measurements: measurements({ incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 } }), producers_enabled: true,
      producers_interval_ms: 300_000, producer_names: INFRA_PRODUCERS, infra_mode: null
    });
    expect(on.summary_no).toContain("Ingen åpne hendelser.");
    expect(on.summary_no).not.toContain("automatisk oppdagelse er AV");
  });

  it("produsenter: stille (>3x intervall), feilende og aldri kjørt vises som problem; en frisk kjøring gjør det ikke", () => {
    const old = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    const runs = measurements().producer_runs!.map((r) => (r.producer === "slo" ? { ...r, last_started_at: old } : r.producer === "provider" ? { ...r, last_status: "failed", consecutive_failures: 4, last_error: "x" } : r)).filter((r) => r.producer !== "sentry");
    const report = composeInfraStatus({ as_of: NOW, targets: [], measurements: measurements({ producer_runs: runs }), producers_enabled: true, producers_interval_ms: 300_000, producer_names: INFRA_PRODUCERS, infra_mode: null });
    const by = Object.fromEntries(report.producers.map((p) => [p.producer, p.state]));
    expect(by).toMatchObject({ slo: "stale", provider: "failed", sentry: "never_ran", scheduler: "ok" });
    expect(report.summary_no).toMatch(/Produsenter med problem: .*slo \(har stått stille\)/);
    expect(report.summary_no).toContain("provider (feilet 4 på rad)");
    expect(report.summary_no).toContain("sentry (har ikke kjørt)");
  });

  it("hendelser: sortert/avkortet, med fase, sannhetsmerking og siste endring; ikke-ok infra-modus vises", () => {
    const many = Array.from({ length: 25 }, (_, i) => item({ incident_id: `inc-${i}`, title: `H${i}` }));
    const report = composeInfraStatus({
      as_of: NOW, targets: [], measurements: measurements({ incidents: { active: many, active_total: 40, by_phase: { open: 30, mitigating: 10 }, resolved_last_7d: 2 } }),
      producers_enabled: true, producers_interval_ms: 300_000, producer_names: INFRA_PRODUCERS, infra_mode: "PAUSED"
    });
    expect(report.incidents?.active).toHaveLength(20);
    expect(report.incidents?.truncated).toBe(true);
    expect(report.summary_no).toContain("40 åpne hendelser");
    expect(report.summary_no).toContain("bekreftet 0/observert 2/påstått 1");
    expect(report.summary_no).toContain("og 35 til");
    expect(report.summary_no).toContain("Infrastrukturmodus: PAUSED");
  });
});

describe("ExecutiveService.getInfraStatus", () => {
  it("kilden kalles med tenanten fra kallet; helse og credential-presence komme fra gatewayen (aldri verdier)", async () => {
    const { svc, calls } = service({ gw: fakeGateway({ health: { cloudflare: "healthy", gce: "unavailable" }, secrets: { REF_langfuse: false } }), mode: async () => "DEGRADED" });
    const r = await svc.getInfraStatus("tenant-A");
    expect(calls).toEqual(["tenant-A"]);
    expect(r.infra_mode).toBe("DEGRADED");
    const by = Object.fromEntries(r.targets.map((t) => [t.id, t.state]));
    expect(by).toMatchObject({ cloudflare: "ok", gcp: "down", langfuse: "dormant" });
    expect(JSON.stringify(r)).not.toMatch(/REF_|secret|token|password/i); // aldri referansenavn eller verdier - kun «satt/ikke satt» som et ja/nei
  });

  it("uten kilde, med kilde som kaster, og med hvelv som feiler: aldri kastet feil, aldri 0/«frisk» - ærlig not_measured/ukjent", async () => {
    const none = await new ExecutiveService(fakeGateway()).getInfraStatus("tenant-A");
    expect(none.incidents).toBeNull();
    expect(none.not_measured.some((n) => n.includes("ingen kilde koblet inn"))).toBe(true);
    expect(none.summary_no).toContain("Åpne hendelser: kunne ikke leses.");
    const throwing = await service({ source: { measure: async () => { throw new Error("pg: password authentication failed for user x"); } } }).svc.getInfraStatus("tenant-A");
    expect(throwing.incidents).toBeNull();
    expect(JSON.stringify(throwing)).not.toContain("password authentication");
    const noVault = await service({ gw: fakeGateway({ secretsThrow: true, health: { cloudflare: "healthy" } }) }).svc.getInfraStatus("tenant-A");
    expect(noVault.targets.find((t) => t.id === "cloudflare")).toMatchObject({ state: "unknown", configured: null });
    const partial = await service({ source: { measure: async () => measurements({ incidents: null, last_changes: null, errors: ["åpne hendelser: lesingen feilet"] }) } }).svc.getInfraStatus("tenant-A");
    expect(partial.not_measured).toEqual(expect.arrayContaining(["åpne hendelser: lesingen feilet", "åpne hendelser: kunne ikke leses", "siste endring per skymål: journalen kunne ikke leses"]));
  });
});

describe("executive.get_infra_status (verktøyet)", () => {
  const defs = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGateway())));
  const def = defs.find((d) => d.action === "get_infra_status")!;

  it("er klasse A, har et strengt tomt skjema (ingen tenant/person/rom/parameter kan sendes inn)", () => {
    expect(def.capability_class).toBe("A");
    expect(def.input_schema.safeParse({}).success).toBe(true);
    for (const evil of [{ tenant_id: "annen" }, { person_id: "x" }, { memory_space: "health" }, { anything: 1 }]) expect(def.input_schema.safeParse(evil).success, JSON.stringify(evil)).toBe(false);
  });

  it("transporten bruker tenanten fra den betrodde konteksten - og feiler lukket uten kontekst", async () => {
    const { svc, calls } = service();
    const transport = new ExecutiveTransport(svc);
    const res = await transport.invoke("get_infra_status", {}, "", { identity: id } as never);
    expect(calls).toEqual(["tenant-A"]);
    expect((res.data as { auto_detection: boolean }).auto_detection).toBe(true);
    await expect(transport.invoke("get_infra_status", { tenant_id: "tenant-B" }, "", undefined)).rejects.toThrow("executive_missing_invocation_context");
    await transport.invoke("get_infra_status", { tenant_id: "tenant-B" }, "", { identity: id } as never);
    expect(calls).toEqual(["tenant-A", "tenant-A"]); // en parameter fra kallet blir aldri tenanten
  });
});
