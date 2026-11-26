import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport, type ControlItem } from "@jarvis/executive";
import type { ToolDefinition } from "@jarvis/tool-gateway";
import { createAuthorityCenter } from "../src/control-center/authority.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-S1 K6: eieren ser enhetstypen serveren har satt (og hvem som bestemte den) i enhetslisten i Autoritet-senteret, så gjennomgangen FØR `enforce` kan gjøres uten SQL. Kun fakta og tekst: statusen på enhetene er uendret.
 */
const NOW = new Date("2026-11-26T12:00:00.000Z");
const me: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "dev-current", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();
const base = (device_id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  device_id, person_id: "person-owner", kind: "web", created_at: NOW.toISOString(), revoked_at: null, role: "owner", active_grants: 0, last_grant_at: null, ...over
});

async function devicesItems(rows: Array<Record<string, unknown>>): Promise<ControlItem[]> {
  const rules: ScriptedRule[] = [
    { match: /FROM devices d/, rows },
    { match: /SELECT DISTINCT domain FROM situations/, rows: [] }, { match: /AS n FROM situation_autonomy_policies/, rows: [{ n: 0 }] }, { match: /FROM situation_autonomy_policies/, rows: [] },
    { match: /FROM situation_domain_pauses/, rows: [] }, { match: /FROM finance_kill_switch/, rows: [] }, { match: /FROM action_confirmations/, rows: [] }
  ];
  const pool = new ScriptedPool(rules);
  const center = createAuthorityCenter({
    pool: pool.asPool(), env: {}, authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] },
    toolGateway: { list: () => defs, get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a), policyFlags: () => ({ class_d_pipeline_enforced: true, credential_binding_active: true }) },
    ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] },
    killSwitch: { currentStateDurable: async () => null }
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  const report = (await registry.report("authority", me)) as ControlCenterReport;
  return report.sections.find((s) => s.id === "devices")?.items ?? [];
}

describe("WP-S1: enhetslisten i Autoritet-senteret viser type og kilde", () => {
  it("type, kilde og step-up-evne står i fakta og tekst; en gammel `legacy_unknown` får en tydelig oppfordring; statusen er uendret (OK)", async () => {
    const items = await devicesItems([
      base("dev-phone", { device_kind: "iphone", device_kind_source: "enrollment_ticket" }),
      base("dev-watch", { device_kind: "watch", device_kind_source: "legacy_label" }),
      base("dev-old", { device_kind: "legacy_unknown", device_kind_source: "unclassified", kind: "phone" })
    ]);
    const by = (id: string): ControlItem => items.find((i) => i.id === id) as ControlItem;
    expect(by("dev-phone").facts).toMatchObject({ device_kind: "iphone", device_kind_source: "enrollment_ticket", step_up_capable: true });
    expect(by("dev-watch").facts).toMatchObject({ device_kind: "watch", device_kind_source: "legacy_label", step_up_capable: false });
    expect(by("dev-old").facts).toMatchObject({ device_kind: "legacy_unknown", device_kind_source: "unclassified", step_up_capable: false, kind: "phone" });
    expect(by("dev-phone").detail_no).toContain("type iphone (enrollment_ticket)");
    expect(by("dev-watch").detail_no).toContain("type watch (legacy_label)");
    expect(by("dev-old").detail_no).toMatch(/type legacy_unknown \(unclassified\) - kan ikke gi step-up i enforce, rull inn på nytt med type/);
    for (const id of ["dev-phone", "dev-watch", "dev-old"]) expect(by(id).status, id).toBe("OK");
  });

  it("rader uten type (eldre fixturer/kilder) vises som før: ingen type-fakta og ingen ekstra tekst", async () => {
    const [item] = await devicesItems([base("dev-plain")]);
    expect(item?.facts).not.toHaveProperty("device_kind");
    expect(item?.facts).not.toHaveProperty("step_up_capable");
    expect(item?.detail_no).not.toMatch(/type /);
  });
});
