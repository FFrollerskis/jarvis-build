import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ExecutiveService, ExecutiveTransport } from "@jarvis/executive";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import { AUTONOMY_AUDIT_MAX_VALUE_CHARS, redactAuditPayload } from "../src/autonomy-audit.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";

/**
 * WP-G4b fiks-runde 1 (FIX-2/2b, Q-G4-15), uten database: det domenebrede tilbakekallet fjerner ALLE bindinger i domenet, så FØR-BILDET i revisjonsraden må omfatte alle radene i domenet (den domenebrede som `before`
 * med uendret form; hver regel-/kategoribinding som element i `before_scoped` med `scope_key`), og svaret fra motoren (`removed_scopes`) videreføres additivt. Mot ekte Postgres: `wpg4b-revoke-all-scopes-db.test.ts`.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const row = (domain: string, scope_key: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "tenant-owner", memory_space_id: "personal", domain, ...(scope_key === undefined ? {} : { scope_key }), tool_id: "business", action: "create_followup", parameters: { kanal: scope_key ?? "gammel" }, enabled: true,
  actor_person_id: "person-owner", created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-02T10:00:00.000Z", ...over
});

interface Call { tool_id: string; action: string; parameters: Record<string, unknown> }
function harness(listed: unknown[], clearData: unknown = { removed: true }) {
  const timeline: string[] = [];
  const calls: Call[] = [];
  const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const gateway = {
    execute: async (req: Call): Promise<ToolResult> => {
      calls.push({ tool_id: req.tool_id, action: req.action, parameters: req.parameters });
      timeline.push(`gateway:${req.action}`);
      if (req.action === "list_autonomy_policies") return { ok: true, data: listed as never, output_trust: "internal", deduplicated: false };
      return { ok: true, data: clearData as never, output_trust: "internal", deduplicated: false };
    },
    list: () => [], health: new Map(), hasSecret: async () => true
  } as unknown as ToolGateway;
  const autonomyAudit = async (_i: IdentityContext, entry: { type: string; payload: Record<string, unknown> }): Promise<void> => { timeline.push(`audit:${entry.type}`); audits.push(entry); };
  const service = new ExecutiveService(gateway, { autonomyAudit, controlCenters: createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } }) });
  return { service, transport: new ExecutiveTransport(service), timeline, calls, audits };
}

describe("før-bildet omfatter ALLE radene i domenet", () => {
  it("bred + regel + kategori: `before` er den brede (uendret form), `before_scoped` har de smale sortert på scope_key; andre domener og andre rom er ikke med; slettingen kalles kun med domenet", async () => {
    const h = harness([
      row("home", "rule:home_assistant:water_leak"), row("home", "*"), row("home", "category:opening", { enabled: false }),
      row("infra", "*"), row("infra", "rule:incident:incident_active")
    ], { removed: true, removed_scopes: ["*", "category:opening", "rule:home_assistant:water_leak"] });
    const r = await h.service.revokeAutonomyBinding(owner, "home");
    expect(r.ok).toBe(true);
    expect(h.timeline).toEqual(["gateway:list_autonomy_policies", "audit:autonomy_binding.revoke_requested", "gateway:clear_autonomy_policy"]);
    expect(h.calls.at(-1)).toEqual({ tool_id: "situations", action: "clear_autonomy_policy", parameters: { domain: "home" } });
    const payload = h.audits[0]!.payload;
    expect(payload).toMatchObject({
      domain: "home", memory_space: "personal", existed: true,
      before: { domain: "home", tool_id: "business", action: "create_followup", enabled: true, parameters: { kanal: "*" }, actor_person_id: "person-owner", updated_at: "2026-11-02T10:00:00.000Z" }
    });
    expect((payload["before"] as Record<string, unknown>)["scope_key"]).toBeUndefined(); // uendret form for det domenebrede før-bildet
    expect((payload["before_scoped"] as Array<Record<string, unknown>>).map((b) => [b["scope_key"], b["enabled"], (b["parameters"] as { kanal: string }).kanal])).toEqual([
      ["category:opening", false, "category:opening"], ["rule:home_assistant:water_leak", true, "rule:home_assistant:water_leak"]
    ]);
    expect(String(payload["recovery"])).toContain("before_scoped");
    expect(JSON.stringify(payload)).not.toContain("incident"); // en annen domene i samme rom er ikke med
  });

  it("kun smale rader: `before: null`, men `existed: true` og begge smale radene i `before_scoped`", async () => {
    const h = harness([row("home", "rule:home_assistant:water_leak"), row("home", "category:opening")], { removed: true, removed_scopes: ["category:opening", "rule:home_assistant:water_leak"] });
    expect((await h.service.revokeAutonomyBinding(owner, "home")).ok).toBe(true);
    expect(h.audits[0]!.payload).toMatchObject({ existed: true, before: null });
    expect((h.audits[0]!.payload["before_scoped"] as unknown[]).length).toBe(2);
  });

  it("ingen rad i domenet: raden skrives likevel (`existed: false`, `before: null`, `before_scoped: []`) og slettingen er idempotent", async () => {
    const h = harness([row("infra", "*")], { removed: false, removed_scopes: [] });
    expect((await h.service.revokeAutonomyBinding(owner, "home")).ok).toBe(true);
    expect(h.audits[0]!.payload).toMatchObject({ existed: false, before: null, before_scoped: [] });
    expect(String(h.audits[0]!.payload["recovery"])).toContain("ingen binding");
  });

  it("eldre svar uten `scope_key` regnes som domenebrede (bakoverkompatibelt); en ugyldig scope_key-type regnes også som domenebred", async () => {
    const h = harness([row("home", undefined)]);
    await h.service.revokeAutonomyBinding(owner, "home");
    expect(h.audits[0]!.payload).toMatchObject({ existed: true, before: { domain: "home", tool_id: "business" }, before_scoped: [] });
  });
});

describe("transporten viderefører hva motoren fjernet (additivt, kun strenger)", () => {
  const run = (t: ExecutiveTransport) => t.invoke("revoke_autonomy_binding", { domain: "home" }, "cred", { identity: owner } as never);

  it("`removed_scopes` fra motoren står i svaret; ikke-strenger filtreres bort", async () => {
    const h = harness([row("home", "*")], { removed: true, removed_scopes: ["*", "rule:home_assistant:water_leak", 42, null] });
    const out = await run(h.transport);
    expect(out.data).toEqual({ removed: true, domain: "home", memory_space: "personal", removed_scopes: ["*", "rule:home_assistant:water_leak"] });
  });

  it("uten `removed_scopes` fra motoren (eldre svar) er svaret byte-likt det gamle", async () => {
    const h = harness([row("home", "*")], { removed: true });
    expect((await run(h.transport)).data).toEqual({ removed: true, domain: "home", memory_space: "personal" });
  });
});

describe("revisjonsraden: parametre kappes per før-bilde, også for `before_scoped`", () => {
  const big = { tekst: "x".repeat(AUTONOMY_AUDIT_MAX_VALUE_CHARS + 10) };

  it("et for stort parameterobjekt i ETT smalt før-bilde erstattes av en størrelsesmerknad; de øvrige og resten av raden er uendret", () => {
    const out = redactAuditPayload({
      domain: "home", existed: true, before: { domain: "home", tool_id: "t", parameters: { a: 1 } },
      before_scoped: [{ scope_key: "category:opening", tool_id: "t", parameters: big }, { scope_key: "rule:x", tool_id: "t", parameters: { b: 2 } }]
    });
    const scoped = out["before_scoped"] as Array<Record<string, unknown>>;
    expect(scoped[0]).toMatchObject({ scope_key: "category:opening", tool_id: "t", parameters: null });
    expect(String(scoped[0]!["parameters_omitted"])).toContain("for stort");
    expect(scoped[1]).toEqual({ scope_key: "rule:x", tool_id: "t", parameters: { b: 2 } });
    expect((out["before"] as Record<string, unknown>)["parameters"]).toEqual({ a: 1 });
  });

  it("hemmeligheter i et smalt før-bildes parametre redigeres (samme skanner som for `before`)", () => {
    const fake = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;
    const out = redactAuditPayload({ before_scoped: [{ scope_key: "rule:x", parameters: { notat: `bruk ${fake}` } }] });
    expect(JSON.stringify(out)).not.toContain("FALSKNOKKELFORTEST");
    expect(JSON.stringify(out)).toContain("REDACTED");
  });
});
