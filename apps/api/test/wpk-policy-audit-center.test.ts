import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { PolicyAuditSinkStats } from "@jarvis/core";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import type { PolicyAuditStats } from "@jarvis/policy";
import type { ToolDefinition } from "@jarvis/tool-gateway";
import { createAuthorityCenter, type AuthorityCenterDeps } from "../src/control-center/authority.ts";
import { registerControlCenters } from "../src/control-center/register.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool } from "./support/scripted-pool.ts";

/**
 * WP-K (D-471, JARVIS-053): Authority Center viser den varige policy-journalen KUN når den er PÅ (`policyAudit` oppgitt). AV = ingen ekstra rad (seksjonen er uendret); PÅ = OK/WARN/UNKNOWN etter hva
 * som faktisk er målt, kun tellere og sikre etiketter. Pluss statiske wiring-vakter: flagget er AV som standard i begge prosesser, sinken kobles bare inn når den finnes, og compose/manifestet bærer variablene.
 */
const NOW = new Date("2026-11-14T12:00:00.000Z");
const me: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "dev-current", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const sinkStats = (over: Partial<PolicyAuditSinkStats> = {}): PolicyAuditSinkStats => ({
  mode: "db", queued: 0, max_queue: 2_000, pressure: "ok", written: 120, rejected_full: 0, rejected_invalid: 0, skipped_unattributable: 0, flush_failures: 0, consecutive_failures: 0,
  last_failure_at: null, last_failure: null, last_written_at: NOW.toISOString(), degraded: false, ...over
});
const gatewayStats = (over: Partial<PolicyAuditStats> = {}): PolicyAuditStats => ({
  sink: "external", in_memory: 0, dropped_in_memory: 0, sink_failures: 0, sink_rejected: 0, last_failure_at: null, last_failure: null, ...over
});

async function policies(policyAudit?: AuthorityCenterDeps["policyAudit"]): Promise<ControlCenterReport["sections"][number]["items"]> {
  const center = createAuthorityCenter({
    pool: new ScriptedPool([]).asPool(),
    env: {},
    authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] },
    toolGateway: { list: () => defs, get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a), policyFlags: () => ({ class_d_pipeline_enforced: true, credential_binding_active: true }) },
    ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] },
    killSwitch: { currentStateDurable: async () => null },
    ...(policyAudit ? { policyAudit } : {})
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  const report = (await registry.report("authority", me)) as ControlCenterReport;
  return report.sections.find((s) => s.id === "policies")!.items;
}

describe("Authority Center: den varige policy-journalen", () => {
  it("AV (policyAudit utelatt): ingen ekstra rad - seksjonen er uendret", async () => {
    const ids = (await policies()).map((i) => i.id);
    expect(ids).toEqual(["budget", "tool_turn_cap", "class_d_pipeline", "credential_binding", "step_up", "memory_auto_approve", "infra_targets"]);
    expect(ids).not.toContain("policy_audit");
  });

  it("PÅ og frisk: OK med tellere (skrevet/i kø), uten avgjørelsesinnhold", async () => {
    const item = (await policies(() => ({ gateway: gatewayStats(), sink: sinkStats({ queued: 3 }) }))).find((i) => i.id === "policy_audit")!;
    expect(item.status).toBe("OK");
    expect(item.detail_no).toContain("120 skrevet");
    expect(item.detail_no).toContain("3 i kø");
    expect(item.facts).toMatchObject({ queued: 3, written: 120, rejected_full: 0, gateway_sink_failures: 0 });
  });

  it("mottrykk (full kø) og mislykkede skrivinger gir WARN med tallene og den sikre feiletiketten - og sier at avgjørelsene er uendret", async () => {
    const item = (await policies(() => ({
      gateway: gatewayStats({ sink_rejected: 7 }),
      sink: sinkStats({ queued: 2_000, pressure: "full", rejected_full: 7, flush_failures: 4, consecutive_failures: 4, last_failure: "Error:ECONNREFUSED", degraded: true })
    }))).find((i) => i.id === "policy_audit")!;
    expect(item.status).toBe("WARN");
    expect(item.detail_no).toContain("full");
    expect(item.detail_no).toContain("7 avvist");
    expect(item.detail_no).toContain("Error:ECONNREFUSED");
    expect(item.detail_no).toContain("Avgjørelsene er uendret");
    expect(item.facts).toMatchObject({ rejected_full: 7, flush_failures: 4, consecutive_failures: 4, gateway_sink_rejected: 7 });
    for (const value of Object.values(item.facts ?? {})) expect(["string", "number", "boolean"].includes(typeof value) || value === null).toBe(true);
  });

  it("tapte avgjørelser uten aktiv feil (rejected_invalid/gateway-feil) er også WARN; en leser som kaster er UNKNOWN, aldri OK", async () => {
    const lost = (await policies(() => ({ gateway: gatewayStats({ sink_failures: 1 }), sink: sinkStats() }))).find((i) => i.id === "policy_audit")!;
    expect(lost.status).toBe("WARN");
    const broken = (await policies(() => { throw new Error("boom"); })).find((i) => i.id === "policy_audit")!;
    expect(broken.status).toBe("UNKNOWN");
  });

  it("registerControlCenters videresender policyAudit kun når den finnes", async () => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registerControlCenters(registry, {
      pool: new ScriptedPool([]).asPool(), env: {}, toolGateway: { list: () => defs, get: () => undefined } as never,
      ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] } as never,
      killSwitch: { currentStateDurable: async () => null },
      policyAudit: () => ({ gateway: gatewayStats(), sink: sinkStats() })
    });
    const report = (await registry.report("authority", me)) as ControlCenterReport;
    expect(report.sections.find((s) => s.id === "policies")!.items.map((i) => i.id)).toContain("policy_audit");
  });
});

describe("wiring-vakt: AV som standard, ingenting kobles uten flagget", () => {
  const MAIN = readFileSync(join(HERE, "..", "src", "main.ts"), "utf8");
  const WORKER = readFileSync(join(HERE, "..", "src", "worker-main.ts"), "utf8");

  it("begge prosessene lager sinken fra miljøet og gir den til PolicyGateway KUN når den finnes (ellers uendret ringbuffer)", () => {
    for (const [name, src] of [["main", MAIN], ["worker-main", WORKER]] as const) {
      expect(src, name).toMatch(/const policyAuditSink = createPolicyAuditSinkFromEnv\(pool\);/);
      expect(src, name).toMatch(/if \(policyAuditSink\) installPolicyAuditDrain\(policyAuditSink\);/);
      expect(src, name).toMatch(/\.\.\.\(policyAuditSink \? \{ auditSink: policyAuditSink\.write \} : \{\}\)/);
    }
  });

  it("retensjonssveipet er kun registrert når journalen er PÅ, og er en EGEN jobb (egen claim/retry/helse)", () => {
    const at = MAIN.indexOf('"policy-decision-retention-sweep"');
    expect(at).toBeGreaterThan(0);
    const guard = MAIN.lastIndexOf("if (policyAuditSink) {", at);
    expect(guard).toBeGreaterThan(0);
    expect(at - guard).toBeLessThan(400);
    expect(WORKER).not.toContain("policy-decision-retention-sweep"); // sveipet kjører kun i api (som det øvrige oppbevaringssveipet)
  });

  it("variablene når containerne: api får alle tre, worker kun sink + kø-tak (retensjonen kjører i api); compose er generert fra manifestet", () => {
    const manifest = readFileSync(join(ROOT, "infra", "local", "service-env.mjs"), "utf8");
    const compose = readFileSync(join(ROOT, "infra", "local", "docker-compose.yml"), "utf8");
    for (const name of ["JARVIS_POLICY_AUDIT_SINK", "JARVIS_POLICY_AUDIT_QUEUE_MAX", "JARVIS_POLICY_AUDIT_RETENTION_DAYS"]) expect(manifest, name).toContain(`"${name}"`);
    const block = (service: string): string => {
      const start = compose.indexOf(`(SERVICE_ENV.${service})`);
      const next = compose.indexOf("# GENERERT fra", start + 10);
      return compose.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ["JARVIS_POLICY_AUDIT_SINK", "JARVIS_POLICY_AUDIT_QUEUE_MAX", "JARVIS_POLICY_AUDIT_RETENTION_DAYS"]) expect(block("api"), `api ${name}`).toContain(`${name}: "\${${name}:-}"`);
    expect(block("worker")).toContain('JARVIS_POLICY_AUDIT_SINK: "${JARVIS_POLICY_AUDIT_SINK:-}"');
    expect(block("worker")).toContain('JARVIS_POLICY_AUDIT_QUEUE_MAX: "${JARVIS_POLICY_AUDIT_QUEUE_MAX:-}"');
    expect(block("worker")).not.toContain("JARVIS_POLICY_AUDIT_RETENTION_DAYS");
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).toContain("# JARVIS_POLICY_AUDIT_SINK=off");
  });
});
