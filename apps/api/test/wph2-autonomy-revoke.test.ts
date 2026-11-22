import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import { AUTONOMY_AUDIT_MAX_VALUE_CHARS, redactAuditPayload, redactAuditValue } from "../src/autonomy-audit.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";

/**
 * WP-H2 gjennomgang L1 (uten database): `revoke_autonomy_binding` er en UOPPRETTELIG sletting. Tre krav, alle fail-closed og alle deterministiske i kode:
 *  1. step-up på GATEWAY-nivå (`step_up_required: true` på verktøydefinisjonen, WP-F1-mekanismen) - ikke bare i ruten;
 *  2. FØR slettingen leses bindingen og en revisjonsrad MED FØR-BILDET (domene, tool_id, action, enabled, parametre) skrives og committes;
 *  3. kan bindingen ikke leses, kan raden ikke skrives eller mangler skriveren, utføres INGEN sletting.
 * Beviset mot en ekte database (rekkefølge i `audit_events`, ekte step-up i gatewayen, rom- og tenantisolasjon) ligger i `wph2-autonomy-revoke-db.test.ts`.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };

interface Call { tool_id: string; action: string; parameters: Record<string, unknown> }
/** En gateway som svarer kontrollert per handling og husker rekkefølgen av kall (revisjonsskriveren og gatewayen deler ÉN tidslinje). */
function harness(opts: { list?: ToolResult; clear?: ToolResult; auditThrows?: boolean; withAudit?: boolean } = {}) {
  const timeline: string[] = [];
  const calls: Call[] = [];
  const gateway = {
    execute: async (req: { tool_id: string; action: string; parameters: Record<string, unknown> }): Promise<ToolResult> => {
      calls.push({ tool_id: req.tool_id, action: req.action, parameters: req.parameters });
      timeline.push(`gateway:${req.tool_id}.${req.action}`);
      if (req.action === "list_autonomy_policies") return opts.list ?? { ok: true, data: [], output_trust: "internal", deduplicated: false };
      if (req.action === "clear_autonomy_policy") return opts.clear ?? { ok: true, data: { removed: true }, output_trust: "internal", deduplicated: false };
      return { ok: false, reason: "unexpected_call" };
    },
    list: () => [], health: new Map(), hasSecret: async () => true
  } as unknown as ToolGateway;
  const audits: Array<{ type: string; tool_id: string; action: string; payload: Record<string, unknown> }> = [];
  const autonomyAudit = async (_identity: IdentityContext, entry: { type: string; tool_id: string; action: string; payload: Record<string, unknown> }): Promise<void> => {
    timeline.push(`audit:${entry.type}`);
    if (opts.auditThrows === true) throw new Error("audit_db_down");
    audits.push(entry);
  };
  const service = new ExecutiveService(gateway, opts.withAudit === false ? {} : { autonomyAudit });
  return { service, timeline, calls, audits };
}
const binding = {
  tenant_id: "tenant-owner", memory_space_id: "personal", domain: "sales", tool_id: "business", action: "create_followup", parameters: { channel: "kort-verdi", n: 3 }, enabled: true,
  actor_person_id: "person-owner", created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-02T10:00:00.000Z"
};
const list = (rows: unknown[]): ToolResult => ({ ok: true, data: rows as never, output_trust: "internal", deduplicated: false });

describe("L1: gateway-nivå step-up på verktøydefinisjonen", () => {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
  const defs = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService({} as unknown as ToolGateway, { controlCenters: registry })), { goldenSuite: true, autonomyRevoke: true });
  const def = (action: string) => defs.find((d) => d.tool_id === "executive" && d.action === action)!;

  it("revoke_autonomy_binding: klasse C, uopprettelig og `step_up_required: true`; golden-suite (lesende) har ikke step-up-kravet i gatewayen (men eier + signert økt-porten)", () => {
    expect(def("revoke_autonomy_binding")).toMatchObject({ capability_class: "C", reversible: false, step_up_required: true });
    expect(def("run_golden_suite").step_up_required).toBeUndefined();
  });

  it("rollback-teksten peker på før-bildet i revisjonsraden (ikke på «parametrene lagres ikke»)", () => {
    expect(def("revoke_autonomy_binding").rollback_procedure).toContain("autonomy_binding.revoke_requested");
    expect(def("revoke_autonomy_binding").rollback_procedure).not.toContain("lagres ikke");
  });
});

describe("L1: før-bildet skrives og committes FØR slettingen", () => {
  it("rekkefølgen er: les bindingen -> skriv revisjonsraden -> slett; raden har domene, tool_id, action, enabled, parametre og hvem som satte bindingen", async () => {
    const h = harness({ list: list([binding, { ...binding, domain: "support", tool_id: "support" }]) });
    const result = await h.service.revokeAutonomyBinding(owner, "sales");
    expect(result.ok).toBe(true);
    expect(h.timeline).toEqual(["gateway:situations.list_autonomy_policies", "audit:autonomy_binding.revoke_requested", "gateway:situations.clear_autonomy_policy"]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ type: "autonomy_binding.revoke_requested", tool_id: "executive", action: "revoke_autonomy_binding" });
    expect(h.audits[0]!.payload).toMatchObject({
      domain: "sales", memory_space: "personal", existed: true,
      before: { domain: "sales", tool_id: "business", action: "create_followup", enabled: true, parameters: { channel: "kort-verdi", n: 3 }, actor_person_id: "person-owner", updated_at: "2026-11-02T10:00:00.000Z" }
    });
    expect(JSON.stringify(h.audits[0]!.payload)).not.toContain("support"); // en annen binding i samme rom er ikke med
    expect(h.calls.find((c) => c.action === "clear_autonomy_policy")?.parameters).toEqual({ domain: "sales" });
  });

  it("en binding som ikke finnes: raden skrives likevel (`existed: false`, `before: null`) og slettingen er idempotent", async () => {
    const h = harness({ list: list([{ ...binding, domain: "andre" }]), clear: { ok: true, data: { removed: false }, output_trust: "internal", deduplicated: false } });
    const result = await h.service.revokeAutonomyBinding(owner, "sales");
    expect(result.ok).toBe(true);
    expect(h.audits[0]!.payload).toMatchObject({ existed: false, before: null });
    expect(h.timeline.at(-1)).toBe("gateway:situations.clear_autonomy_policy");
  });
});

describe("L1: FAIL-CLOSED - ingen sletting uten et skrevet før-bilde", () => {
  it("revisjonsskriveren kaster: INGEN sletting, avvist med `autonomy_audit_write_failed`", async () => {
    const h = harness({ list: list([binding]), auditThrows: true });
    expect(await h.service.revokeAutonomyBinding(owner, "sales")).toEqual({ ok: false, reason: "autonomy_audit_write_failed" });
    expect(h.calls.map((c) => c.action)).toEqual(["list_autonomy_policies"]);
  });

  it("revisjonsskriveren er ikke koblet inn: INGEN lesing og INGEN sletting, avvist med `autonomy_audit_not_configured`", async () => {
    const h = harness({ list: list([binding]), withAudit: false });
    expect(await h.service.revokeAutonomyBinding(owner, "sales")).toEqual({ ok: false, reason: "autonomy_audit_not_configured" });
    expect(h.calls).toEqual([]);
  });

  it("før-bildet kan ikke leses (gatewayen avslår lesingen eller svarer med uventet form): INGEN revisjonsrad og INGEN sletting", async () => {
    const denied = harness({ list: { ok: false, reason: "policy_denied:kill_switch" } });
    expect(await denied.service.revokeAutonomyBinding(owner, "sales")).toEqual({ ok: false, reason: "before_image_unreadable:policy_denied:kill_switch" });
    expect(denied.audits).toEqual([]);
    expect(denied.calls.map((c) => c.action)).toEqual(["list_autonomy_policies"]);
    const odd = harness({ list: { ok: true, data: { ikke: "en liste" } as never, output_trust: "internal", deduplicated: false } });
    expect(await odd.service.revokeAutonomyBinding(owner, "sales")).toEqual({ ok: false, reason: "before_image_unreadable:unexpected_shape" });
    expect(odd.calls.map((c) => c.action)).toEqual(["list_autonomy_policies"]);
  });

  it("slettingen avslås av gatewayen (ikke eier i motoren): resultatet er gatewayens avslag - raden er skrevet (forsøket er revisjonsverdig), men ingenting er slettet", async () => {
    const h = harness({ list: list([binding]), clear: { ok: false, reason: "tool_failed:situation_autonomy_unauthorized" } });
    expect(await h.service.revokeAutonomyBinding(owner, "sales")).toEqual({ ok: false, reason: "tool_failed:situation_autonomy_unauthorized" });
    expect(h.audits).toHaveLength(1);
  });
});

describe("L1: revisjonsraden redigeres (hemmeligheter) og er ikke et lager", () => {
  const FAKE = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;

  it("hver streng (blader og nøkler) går gjennom hemmelighetsskanneren, også nøstet", () => {
    const out = redactAuditValue({ note: `bruk ${FAKE} her`, nested: { liste: [FAKE, "ufarlig"] }, [FAKE]: "verdi" }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("FALSKNOKKELFORTEST");
    expect(JSON.stringify(out)).toContain("ufarlig");
    expect(JSON.stringify(out)).toContain("REDACTED");
  });

  it("dybde og bredde kappes; tall/boolsk/null beholdes; ukjente typer blir null", () => {
    let deep: unknown = "bunn";
    for (let i = 0; i < 12; i += 1) deep = { ned: deep };
    expect(JSON.stringify(redactAuditValue(deep))).toContain("avkortet");
    expect(redactAuditValue([1, true, null, undefined, () => 1])).toEqual([1, true, null, null, null]);
    expect((redactAuditValue(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });

  it("et for stort parameterobjekt i før-bildet erstattes av en størrelsesmerknad (resten av før-bildet er uendret)", () => {
    const big = { tekst: "x".repeat(AUTONOMY_AUDIT_MAX_VALUE_CHARS + 10) };
    const out = redactAuditPayload({ domain: "sales", existed: true, before: { domain: "sales", tool_id: "business", action: "a", enabled: true, parameters: big } });
    const before = out["before"] as Record<string, unknown>;
    expect(before["parameters"]).toBeNull();
    expect(String(before["parameters_omitted"])).toContain("for stort");
    expect(before["tool_id"]).toBe("business");
    const small = redactAuditPayload({ before: { parameters: { a: 1 } } });
    expect((small["before"] as Record<string, unknown>)["parameters"]).toEqual({ a: 1 });
  });
});
