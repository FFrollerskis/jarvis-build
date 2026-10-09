import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, type ToolGateway } from "@jarvis/tool-gateway";
import type { IdentityContext } from "@jarvis/contracts";
import {
  ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ValueMeasurement, type ValueMeasurementSet, type ValueRuntimeFacts, type SloReport
} from "../src/index.ts";

/** WP-C4: `ExecutiveService.getValueReport` + `executive.get_value_report` (klasse A). DB-uavhengig: kilden og faktaene er fakes. */
const NOW = "2026-10-09T10:00:00.000Z";
const WINDOWS = { d7: { from: "2026-10-02T22:00:00.000Z", to: NOW }, d30: { from: "2026-09-09T22:00:00.000Z", to: NOW } };
const id: IdentityContext = { person_id: "p-owner", tenant_id: "tenant-A", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" };
const GITHUB = CONNECTOR_REGISTRY.find((c) => c.id === "github");

function gateway(opts: { githubConfigured?: boolean; githubHealth?: string | null } = {}): ToolGateway {
  const refs = new Set(opts.githubConfigured === false ? [] : GITHUB?.credential_refs ?? []);
  const health = new Map<string, { state: string; at: string }>();
  if (opts.githubHealth !== undefined && opts.githubHealth !== null) health.set("github", { state: opts.githubHealth, at: NOW });
  return { list: () => [], hasSecret: async (ref: string) => refs.has(ref), health } as unknown as ToolGateway;
}

const FACTS: ValueRuntimeFacts = {
  v1_delivery_configured: true, v2_push: { enabled: false, channel_configured: true, max_per_day: 3, quiet_hours: "22-07" }, v5_proposals_enabled: false,
  ev0: { constitution_verified: true, ledger_ok: true }, kill_switch_active: false, declared_gates: ["D-32", "WORKER_ISOLATION"]
};
const measured = (idv: string, now: number): ValueMeasurement => ({ id: idv, state: "measured", now });
const slo = (statuses: Array<"OK" | "BREACH" | "UNKNOWN">): SloReport => ({
  as_of: NOW, drift: null, data_quality: null, not_measured: [],
  slos: statuses.map((status, i) => ({ id: i === 0 ? "chat_success" : `s${i}`, label: "x", status, value: null, target: 1, metric: "success_rate" as const, samples: 0, window_hours: 24, source: "t", observed_at: NOW, detail: "" }))
});
function service(over: { measurements?: ValueMeasurement[]; facts?: ValueRuntimeFacts | (() => never); source?: () => Promise<ValueMeasurementSet>; slo?: SloReport; gw?: ToolGateway; selfModel?: boolean } = {}) {
  const calls: string[] = [];
  const svc = new ExecutiveService(over.gw ?? gateway({ githubHealth: "healthy" }), {
    value: {
      source: { measure: async (tenant) => { calls.push(tenant); return over.source ? over.source() : { windows: WINDOWS, measurements: over.measurements ?? [] }; } },
      facts: (typeof over.facts === "function" ? over.facts : () => over.facts ?? FACTS) as never
    },
    ...(over.slo ? { slo: { report: async () => over.slo as SloReport } } : {}),
    ...(over.selfModel ? { selfModel: { readers: { backup: async () => ({ status: "DEGRADED" as const, source: "t", observed_at: NOW, detail: "gammel" }) }, limitations: { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] } } } : {})
  });
  return { svc, calls };
}

describe("getValueReport", () => {
  it("uten value-kilde: alt er ikke målbart (aldri 0) og løkkene V1/V2 er «ukjent»", async () => {
    const r = await new ExecutiveService(gateway()).getValueReport("tenant-A");
    expect(r.metrics.every((m) => m.state === "not_measurable")).toBe(true);
    expect(r.metrics.every((m) => m.now === null && m.last_7d === null && m.last_30d === null)).toBe(true);
    expect(r.windows).toBeNull();
    expect(r.loops[0]).toMatchObject({ id: "V1", state: "unknown" });
    expect(r.not_measured.some((n) => n.includes("ingen kilde koblet inn"))).toBe(true);
    expect(r.summary_no).toContain("Vinduene (siste 7 og 30 døgn) kunne ikke fastslås");
  });

  it("kilden kalles med tenanten fra kallet, og målingene kommer gjennom (med vinduene)", async () => {
    const { svc, calls } = service({ measurements: [{ id: "v1.briefs_generated", state: "measured", last_7d: 7, last_30d: 20 }] });
    const r = await svc.getValueReport("tenant-A");
    expect(calls).toEqual(["tenant-A"]);
    expect(r.metrics.find((m) => m.id === "v1.briefs_generated")).toMatchObject({ state: "measured", last_7d: 7, last_30d: 20 });
    expect(r.windows).toEqual(WINDOWS);
    expect(r.time_zone).toBe("Europe/Oslo");
  });

  it("kilden som kaster gir ikke-målbar overalt - tjenesten kaster aldri", async () => {
    const { svc } = service({ source: async () => { throw new Error("db nede: password authentication failed for user x"); } });
    const r = await svc.getValueReport("tenant-A");
    expect(r.metrics.every((m) => m.state === "not_measurable")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("password authentication");
    expect(r.not_measured.some((n) => n.includes("kilden er utilgjengelig: målingen feilet"))).toBe(true);
  });

  it("faktaene som kaster (synkront eller asynkront) gir ukjente løkker og fail-closed V3 - ikke en kastet feil", async () => {
    for (const facts of [() => { throw new Error("sync"); }, (async () => { throw new Error("async"); }) as never]) {
      const { svc } = service({ facts: facts as never, measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) });
      const r = await svc.getValueReport("tenant-A");
      expect(r.loops[0]?.state).toBe("unknown");
      expect(r.builder_loop.ready_for_owner_decision).toBe(false);
      expect(r.builder_loop.requirements.find((q) => q.id === "change_freeze_off")).toMatchObject({ met: false, unknown: true });
    }
  });

  it("V3-beredskap: alt teknisk på plass gir «klar for eierens beslutning», men aktiveringsbeslutningen er false", async () => {
    const { svc } = service({ measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK", "UNKNOWN"]) });
    const r = await svc.getValueReport("tenant-A");
    expect(r.builder_loop.ready_for_owner_decision).toBe(true);
    expect(r.builder_loop.activation_decision).toBe(false);
    expect(r.builder_loop.missing.map((m) => m.id)).toEqual(["owner_decision:V3"]);
    expect(r.summary_no).toContain("6 av 6 tekniske krav er oppfylt");
  });

  it("change freeze: åpen hendelse, brutt SLO, kill switch og manglende observerbarhet gir hver for seg ikke-klar; ukjent hendelsestall er fail-closed", async () => {
    const base = { measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) };
    const cases: Array<[string, Parameters<typeof service>[0]]> = [
      ["åpen hendelse", { ...base, measurements: [measured("ops.incidents_open_now", 2)] }],
      ["brutt SLO", { ...base, slo: slo(["BREACH"]) }],
      ["kill switch", { ...base, facts: { ...FACTS, kill_switch_active: true } }],
      ["ingen observerbarhet", { ...base, slo: slo(["UNKNOWN", "UNKNOWN"]) }],
      ["hendelser ikke målbare", { ...base, measurements: [{ id: "ops.incidents_open_now", state: "not_measurable", reason_no: "feil" }] }],
      ["kill switch ukjent", { ...base, facts: { ...FACTS, kill_switch_active: null } }]
    ];
    for (const [name, over] of cases) {
      const r = await service(over).svc.getValueReport("tenant-A");
      expect(r.builder_loop.ready_for_owner_decision, name).toBe(false);
      expect(r.builder_loop.requirements.find((q) => q.id === "change_freeze_off")?.met, name).toBe(false);
    }
  });

  it("GitHub-tilkoblingen: frisk -> oppfylt; usunn -> ikke; satt opp men aldri kalt -> ukjent; ikke konfigurert -> ikke oppfylt", async () => {
    const run = async (opts: Parameters<typeof gateway>[0]) => (await service({ gw: gateway(opts), measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) }).svc.getValueReport("tenant-A")).builder_loop.requirements.find((q) => q.id === "github_connector_healthy");
    expect(await run({ githubHealth: "healthy" })).toMatchObject({ met: true, unknown: false });
    expect(await run({ githubHealth: "degraded" })).toMatchObject({ met: false, unknown: false });
    expect(await run({ githubHealth: null })).toMatchObject({ met: false, unknown: true });
    expect(await run({ githubConfigured: false })).toMatchObject({ met: false, unknown: false });
  });

  it("tilkoblingsstatus som ikke kan leses gir ukjent GitHub-krav (null), ikke «ikke konfigurert»", async () => {
    const broken = { list: () => [], hasSecret: async () => { throw new Error("hvelv nede"); }, health: new Map() } as unknown as ToolGateway;
    const r = await service({ gw: broken, measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) }).svc.getValueReport("tenant-A");
    expect(r.builder_loop.requirements.find((q) => q.id === "github_connector_healthy")).toMatchObject({ met: false, unknown: true });
  });

  it("kostnadsgrense: uten V5 slås KUN GitHubs credential-referanser opp i hvelvet (ikke hele connector-registeret); med V5 på leses hele registeret", async () => {
    const looked: string[] = [];
    const counting = { list: () => [], hasSecret: async (ref: string) => { looked.push(ref); return true; }, health: new Map([["github", { state: "healthy", at: NOW }]]) } as unknown as ToolGateway;
    await service({ gw: counting, measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) }).svc.getValueReport("tenant-A");
    // WP-C3: GitHub har også en VALGFRI credential-ref (App-privatnøkkelen) som `listConnectorStatus` slår opp; begge er GitHubs egne referanser.
    const githubRefs = [...(GITHUB?.credential_refs ?? []), ...(GITHUB?.optional_credential_refs ?? [])];
    expect(new Set(looked)).toEqual(new Set(githubRefs));
    expect(looked.length).toBe(githubRefs.length);
    looked.length = 0;
    await service({ gw: counting, selfModel: true, slo: slo(["OK"]), facts: { ...FACTS, v5_proposals_enabled: true } }).svc.getValueReport("tenant-A");
    expect(looked.length).toBeGreaterThan(githubRefs.length * 5);
  });

  it("D-32/worker-isolasjon kommer KUN fra erklærte porter, aldri fra noe kode kan utlede", async () => {
    const { svc } = service({ facts: { ...FACTS, declared_gates: [] }, measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) });
    const r = await svc.getValueReport("tenant-A");
    expect(r.builder_loop.missing.map((m) => m.id)).toEqual(expect.arrayContaining(["gate:D-32", "gate:WORKER_ISOLATION"]));
    expect(r.builder_loop.ready_for_owner_decision).toBe(false);
  });

  it("V5: AV som standard gir ingen forslag og leser ikke selvdiagnosen; PÅ gir forslag fra målingene - fortsatt kun forslag", async () => {
    const off = await service({ selfModel: true, slo: slo(["OK"]) }).svc.getValueReport("tenant-A");
    expect(off.ops_proposals).toEqual({ enabled: false, proposals: [], skipped_no: ["forslag er av (JARVIS_V5_PROPOSALS_ENABLED er ikke true)"] });
    const on = await service({ selfModel: true, slo: slo(["OK"]), facts: { ...FACTS, v5_proposals_enabled: true }, measurements: [measured("ops.tasks_waiting_over_15m_now", 9)] }).svc.getValueReport("tenant-A");
    expect(on.ops_proposals.enabled).toBe(true);
    expect(on.ops_proposals.proposals.map((p) => p.id)).toEqual(["run_backup:nas", "restart_service:worker"]);
    for (const p of on.ops_proposals.proposals) expect(p.executes).toBe(false);
    expect(on.summary_no).toContain("FORSLAG (ingenting er utført");
  });

  it("V5 PÅ med connector med svak helse foreslår testen på nytt (kun GitHub er konfigurert i fakegatewayen)", async () => {
    const r = await service({ gw: gateway({ githubHealth: "degraded" }), selfModel: true, slo: slo(["OK"]), facts: { ...FACTS, v5_proposals_enabled: true } }).svc.getValueReport("tenant-A");
    expect(r.ops_proposals.proposals.map((p) => p.id)).toContain("rerun_connector_test:github");
  });

  it("rapporten er ren JSON (kan serialiseres uten tap): ingen Set/Map/funksjoner", async () => {
    const r = await service({ measurements: [measured("ops.incidents_open_now", 0)], slo: slo(["OK"]) }).svc.getValueReport("tenant-A");
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("executive.get_value_report (verktøy og transport)", () => {
  const { svc } = service({ measurements: [{ id: "tasks.created", state: "measured", last_7d: 3, last_30d: 8 }] });
  const transport = new ExecutiveTransport(svc);
  const def = executiveToolDefinitions(transport).find((d) => d.action === "get_value_report");

  it("er registrert som ren lesing: klasse A, scope executive.read, intern output, reversibel/idempotent, ingen inndata", () => {
    expect(def).toBeDefined();
    expect(def).toMatchObject({ tool_id: "executive", capability_class: "A", scopes: ["executive.read"], reversible: true, idempotent_external: true, output_trust: "internal" });
    expect(def?.input_schema.safeParse({}).success).toBe(true);
  });

  it("skjemaet er strengt og har ingen identitetsfelt: tenant_id/person_id/memory_space kan ikke sendes inn", () => {
    for (const bad of [{ tenant_id: "tenant-B" }, { person_id: "x" }, { memory_space: "health" }, { anything: 1 }]) expect(def?.input_schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("transporten leser tenanten fra den betrodde konteksten - aldri fra parametre", async () => {
    const seen: string[] = [];
    const spy = new ExecutiveService(gateway(), { value: { source: { measure: async (t) => { seen.push(t); return { windows: WINDOWS, measurements: [] }; } }, facts: () => FACTS } });
    const t = new ExecutiveTransport(spy);
    const out = await t.invoke("get_value_report", { tenant_id: "tenant-EVIL" }, "tok", { identity: id } as never);
    expect(seen).toEqual(["tenant-A"]);
    expect((out.data as { summary_no: string }).summary_no).toContain("Verdi-rapport for Jarvis");
  });

  it("manglende kontekst feiler lukket", async () => {
    await expect(transport.invoke("get_value_report", {}, "tok")).rejects.toThrow("executive_missing_invocation_context");
  });
});
