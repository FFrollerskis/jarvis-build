import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, ExecutiveAccessDeniedError, ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MODEL_SURFACE_QUARANTINE_WRITES, SURFACE_TOOL_GRANTS, assertManifestInvariants, buildToolManifest, inferEffect,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { EXECUTIVE_MUTATE_ACTIONS } from "../src/server.ts";
import { STEP_UP_EXEMPT_ACTIONS, actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";

/**
 * WP-H0 / JARVIS-087: `executive.cancel_task` - kontrollsenterets avbryt-handling for en bakgrunnsjobb/agent. Et gjennomslag til den EKSISTERENDE kanselleringsveien (`TaskService.cancel`), ikke ny
 * kanselleringslogikk. Enhetstestene her låser: registreringen (klasse B, strengt skjema, ikke angrebar), at den ALDRI står på en modellflate, at den er EIER-KUN (fail-closed), at den er en
 * stopp-handling uten step-up, og tjenestens gjennomslag. Mot ekte Postgres og ekte ToolGateway: wph0-cancel-task-db.test.ts.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const KEY = "executive.cancel_task";

function defsWith(service: ExecutiveService): ToolDefinition[] {
  return executiveToolDefinitions(new ExecutiveTransport(service));
}
const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
// Gjennomgang av PR #316 (M-2): samme fabrikk som main.ts bruker (eier-predikat fra en AuthorityConfig, redigering av hemmeligheter fast) - ikke et eget predikat i testen.
const ownerOnly = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
const def = defsWith(new ExecutiveService(fakeGw, { controlCenters: ownerOnly })).find((d) => `${d.tool_id}.${d.action}` === KEY) as ToolDefinition;

describe("registrering", () => {
  it("er klasse B (som tasks.cancel_task selv), effekt write, ikke angrebar, og krever eier-port", () => {
    expect(def).toBeDefined();
    expect(def.capability_class).toBe("B");
    expect(def.scopes).toEqual(["executive.write"]);
    expect(def.reversible).toBe(false);
    expect(def.rollback_procedure).toContain("send den inn på nytt");
    expect(inferEffect(def.tool_id, def.action)).toBe("write");
    expect(def.parameterAuthorizer).toBeTypeOf("function");
  });

  it("skjemaet er strengt: kun en ikke-tom task_id (maks 100 tegn); ingen identitetsfelt, ingen ekstra felt", () => {
    const ok = (p: Record<string, unknown>) => def.input_schema.safeParse(p).success;
    expect(ok({ task_id: "task-123" })).toBe(true);
    for (const bad of [{}, { task_id: "" }, { task_id: 5 }, { task_id: "x".repeat(101) }, { task_id: "t", tenant_id: "andre" }, { task_id: "t", person_id: "p" }, { task_id: "t", force: true }, { task_ids: ["a"] }]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("står i den lukkede mutasjonslisten (15 handlinger: 13 + WP-H2 revoke_autonomy_binding og run_golden_suite), og er en stopp-handling uten step-up (resten av listen uendret)", () => {
    expect(EXECUTIVE_MUTATE_ACTIONS).toHaveLength(15);
    expect(EXECUTIVE_MUTATE_ACTIONS).toContain("cancel_task");
    expect(STEP_UP_EXEMPT_ACTIONS.has("cancel_task")).toBe(true);
    expect(actionRequiresStepUp("cancel_task")).toBe(false);
    expect(stepUpDenial({ auth_strength: "passive", channel: "telegram" }, "cancel_task")).toBeUndefined();
    // å GJENOPPTA/gjenopprette krever fortsatt step-up (uendret)
    for (const a of ["unfreeze_connector", "resume_domain", "restore_credential", "revoke_device", "deactivate_kill_switch"]) expect(actionRequiresStepUp(a), a).toBe(true);
    // WP-H2: de to nye handlingene krever BEGGE step-up (signert enhet) - ingen av dem er en stopp-handling i unntaksmengden
    for (const a of ["revoke_autonomy_binding", "run_golden_suite"]) { expect(actionRequiresStepUp(a), a).toBe(true); expect(STEP_UP_EXEMPT_ACTIONS.has(a), a).toBe(false); }
  });
});

describe("aldri en modellflate", () => {
  const defs = defsWith(new ExecutiveService(fakeGw, { controlCenters: ownerOnly }));

  it("står ikke i noe modellnivå (minimumssettet, lese-, handlings-, delegerings- eller karantenenivået)", () => {
    for (const tier of [MODEL_SURFACE_ALLOWLIST, CHAT_READ_TIER, CHAT_ACT_TIER, CHAT_DELEGATE_TIER, MODEL_SURFACE_QUARANTINE_WRITES]) {
      expect(tier.some((g) => `${g.tool_id}.${g.action}` === KEY)).toBe(false);
    }
    for (const [surface, grants] of Object.entries(SURFACE_TOOL_GRANTS)) expect(grants.some((g) => `${g.tool_id}.${g.action}` === KEY), surface).toBe(false);
  });

  it("manifestet har ingen flater for den, og boot-invariantene holder", () => {
    const manifest = buildToolManifest(defs);
    expect(manifest.get(KEY)).toMatchObject({ risk: "B", effect: "write", surfaces: [], owner: "jarvis_core" });
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
  });
});

describe("eier-kun port (fail-closed)", () => {
  it("eieren slipper gjennom; en annen person og en delegat nektes", () => {
    expect(def.parameterAuthorizer?.({ task_id: "t" }, owner)).toEqual({ allowed: true, reason: "owner" });
    expect(def.parameterAuthorizer?.({ task_id: "t" }, { ...owner, person_id: "person-annen" })).toEqual({ allowed: false, reason: "control_center_owner_only" });
    expect(def.parameterAuthorizer?.({ task_id: "t" }, { ...owner, delegation_id: "deleg" })).toEqual({ allowed: false, reason: "control_center_owner_only" });
  });

  it("uten eier-predikat (eller uten register) nektes alle", () => {
    const noPredicate = defsWith(new ExecutiveService(fakeGw, { controlCenters: new ControlCenterRegistry() })).find((d) => `${d.tool_id}.${d.action}` === KEY) as ToolDefinition;
    expect(noPredicate.parameterAuthorizer?.({ task_id: "t" }, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
    // i motsetning til LESINGEN av kontrollsentrene (som slipper gjennom uten register fordi det ikke er noe å lekke) er en SKRIVEhandling fail-closed også uten register
    const noRegistry = defsWith(new ExecutiveService(fakeGw)).find((d) => `${d.tool_id}.${d.action}` === KEY) as ToolDefinition;
    expect(noRegistry.parameterAuthorizer?.({ task_id: "t" }, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
    const readDef = defsWith(new ExecutiveService(fakeGw)).find((d) => d.action === "get_control_center") as ToolDefinition;
    expect(readDef.parameterAuthorizer?.({}, owner).allowed).toBe(true);
  });

  it("ingen annen executive-handling enn kontrollsenter-lesingen, driftsstatusen og avbryt har fått en slik port ved et uhell", () => {
    const withPort = defsWith(new ExecutiveService(fakeGw, { controlCenters: ownerOnly })).filter((d) => d.parameterAuthorizer !== undefined).map((d) => d.action).sort();
    // `get_infra_status` fikk BEVISST samme lese-port som kontrollsentrene i gjennomgangen av PR #324 (L4/M3): eier + signert enhetsøkt, fail-closed (se `e1-review-l4-infra-status-gate.test.ts`).
    expect(withPort).toEqual(["cancel_task", "get_control_center", "get_infra_status"]);
  });
});

describe("tjenestens gjennomslag", () => {
  const transportFor = (service: ExecutiveService) => new ExecutiveTransport(service);

  it("kaller den injiserte kanselleringsveien med den uendrede identiteten og task_id, og gir utfallet videre", async () => {
    const seen: Array<{ identity: IdentityContext; taskId: string }> = [];
    const service = new ExecutiveService(fakeGw, {
      tasks: { cancel: async (identity, taskId) => { seen.push({ identity, taskId }); return { ok: true, value: { cancelled: true, outcome: "requested" } }; } }
    });
    const out = await transportFor(service).invoke("cancel_task", { task_id: "task-1" }, "x", { identity: owner });
    expect(out).toEqual({ external_id: "task-1", data: { task_id: "task-1", cancelled: true, outcome: "requested" } });
    expect(seen).toEqual([{ identity: owner, taskId: "task-1" }]);
  });

  it("ikke avbrytbar (ferdig/pauset/ukjent) er et ærlig svar, ikke en feil: cancelled:false med utfallet", async () => {
    const service = new ExecutiveService(fakeGw, { tasks: { cancel: async () => ({ ok: true, value: { cancelled: false, outcome: "not_cancellable" } }) } });
    const out = await transportFor(service).invoke("cancel_task", { task_id: "task-2" }, "x", { identity: owner });
    expect(out.data).toEqual({ task_id: "task-2", cancelled: false, outcome: "not_cancellable" });
  });

  it("et avslag fra policy kastes (blir ok:false på det ytre kallet), aldri en stille ok", async () => {
    const service = new ExecutiveService(fakeGw, { tasks: { cancel: async () => ({ ok: false, reason: "kill_switch_active" }) } });
    await expect(transportFor(service).invoke("cancel_task", { task_id: "task-3" }, "x", { identity: owner })).rejects.toBeInstanceOf(ExecutiveAccessDeniedError);
    await expect(transportFor(service).invoke("cancel_task", { task_id: "task-3" }, "x", { identity: owner })).rejects.toThrow("kill_switch_active");
  });

  it("uten injisert kanselleringsvei feiler handlingen høyt; manglende/tom task_id og manglende kontekst avvises", async () => {
    const bare = transportFor(new ExecutiveService(fakeGw));
    await expect(bare.invoke("cancel_task", { task_id: "task-4" }, "x", { identity: owner })).rejects.toThrow("executive_tasks_not_configured");
    const wired = transportFor(new ExecutiveService(fakeGw, { tasks: { cancel: async () => ({ ok: true, value: { cancelled: true, outcome: "cancelled" } }) } }));
    await expect(wired.invoke("cancel_task", {}, "x", { identity: owner })).rejects.toThrow("missing_parameter:task_id");
    await expect(wired.invoke("cancel_task", { task_id: "" }, "x", { identity: owner })).rejects.toThrow("missing_parameter:task_id");
    await expect(wired.invoke("cancel_task", { task_id: "t" }, "x")).rejects.toThrow("executive_missing_invocation_context");
  });
});
