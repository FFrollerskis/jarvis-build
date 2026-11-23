import { describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, type IdentityContext } from "@jarvis/contracts";
import { CONTROL_ACTION_ALLOWED, CONTROL_ACTION_ENDPOINTS, ControlCenterRegistry, explainControlCenterNo, type ControlCenterReport, type ControlSection } from "@jarvis/executive";
import type { ToolDefinition } from "@jarvis/tool-gateway";
import { createAuthorityCenter, summarizeManifest } from "../src/control-center/authority.ts";
import { registerControlCenters } from "../src/control-center/register.ts";
import { actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H0 Authority Center - ENHETSTESTER (ekte SQL/RLS bevises i wph0-authority-center-db.test.ts):
 *  1. seksjoner og status: eier-autoritet, enheter (tilbakekall = revoke_device, aldri på egen enhet), delegert autonomi, brytere, pauser, risikoklasser, policyer, eksterne grenser, bekreftelser;
 *  2. ukjent ≠ i orden: en kilde som ikke kan leses gjør tilstanden UKJENT (kill switch «av» antas aldri);
 *  3. handlingene: kun eksisterende ruter, speiler rutenes allowlist, step-up-merke = rutens krav, risikoklasse = verktøyets;
 *  4. kun lesing, identitets-/tenant-bundet, og ingen innhold (autonomi-parametre, bekreftelsesparametre, nøkler) leses i det hele tatt.
 */
const NOW = new Date("2026-10-09T12:00:00.000Z");
const H = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const me: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "dev-current", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();
const AUTHORITY = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };

interface Scenario {
  authority?: typeof AUTHORITY | null;
  kill?: { reason: string; actor_person_id: string | null; changed_at: string } | null | Error;
  frozen?: Array<{ connector_id: string; changed_at: string; actor_person_id?: string | null }>;
  revoked?: Array<{ credential_ref: string; changed_at: string; actor_person_id?: string | null }>;
  controlsFail?: Error;
  infra?: "absent" | "error" | { mode: "NORMAL" | "DEGRADED" | "PAUSED"; in_sync?: boolean; shared_readable?: boolean; shared_mode?: "DEGRADED" | "PAUSED" | null };
  devices?: Array<Record<string, unknown>> | Error;
  policies?: Array<Record<string, unknown>> | Error;
  situationDomains?: string[];
  healthPolicies?: number;
  pauses?: Array<Record<string, unknown>> | Error;
  finance?: Array<Record<string, unknown>> | Error;
  confirmations?: Array<Record<string, unknown>> | Error;
  env?: Record<string, string | undefined>;
  flags?: { class_d_pipeline_enforced: boolean; credential_binding_active: boolean } | "absent";
}

const dev = (device_id: string, person_id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  device_id, person_id, kind: "web", created_at: ago(100 * H), revoked_at: null, role: person_id === "person-owner" ? "owner" : "member", active_grants: 1, last_grant_at: ago(2 * H), ...over
});

function build(scn: Scenario = {}): { pool: ScriptedPool; run: () => Promise<ControlCenterReport> } {
  const rules: ScriptedRule[] = [
    { match: /FROM devices d/, rows: scn.devices ?? [dev("dev-current", "person-owner"), dev("dev-phone", "person-owner"), dev("dev-delegate", "person-delegate", { active_grants: 2 }), dev("dev-old", "person-owner", { revoked_at: ago(50 * H), active_grants: 0 })] },
    { match: /SELECT DISTINCT domain FROM situations/, rows: (scn.situationDomains ?? ["finance", "support"]).map((domain) => ({ domain })) },
    { match: /AS n FROM situation_autonomy_policies/, rows: [{ n: scn.healthPolicies ?? 0 }] },
    { match: /FROM situation_autonomy_policies/, rows: scn.policies ?? [{ memory_space_id: "business", domain: "finance", tool_id: "finance_spend", action: "sync_internal_spend", enabled: true, updated_at: ago(30 * H) }] },
    { match: /FROM situation_domain_pauses/, rows: scn.pauses ?? [] },
    { match: /FROM finance_kill_switch/, rows: scn.finance ?? [] },
    { match: /FROM action_confirmations/, rows: scn.confirmations ?? [] }
  ];
  const pool = new ScriptedPool(rules);
  const infra = scn.infra ?? { mode: "NORMAL" };
  const flags = scn.flags === "absent" ? undefined : (scn.flags ?? { class_d_pipeline_enforced: true, credential_binding_active: true });
  const center = createAuthorityCenter({
    pool: pool.asPool(),
    env: scn.env ?? {},
    ...(scn.authority === null ? {} : { authority: scn.authority ?? AUTHORITY }),
    toolGateway: {
      list: () => defs, get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a),
      ...(flags === undefined ? {} : { policyFlags: () => flags })
    },
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (scn.controlsFail) throw scn.controlsFail; return (scn.frozen ?? []).map((f) => ({ reason: "x", actor_person_id: "person-owner", ...f })); },
      listRevokedCredentialsDurable: async () => (scn.revoked ?? []).map((r) => ({ reason: "x", actor_person_id: "person-owner", ...r }))
    },
    killSwitch: { currentStateDurable: async () => { if (scn.kill instanceof Error) throw scn.kill; return scn.kill ?? null; } },
    ...(infra === "absent" ? {} : {
      infraGate: {
        statusDurable: async () => {
          if (infra === "error") throw new Error("boom");
          const state = { mode: infra.mode, at: ago(H) };
          return { state, local: { mode: "NORMAL" as const, at: ago(H) }, shared: infra.shared_mode ? { mode: infra.shared_mode, at: ago(H) } : null, shared_readable: infra.shared_readable ?? true, in_sync: infra.in_sync ?? true };
        }
      }
    })
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  return { pool, run: async () => (await registry.report("authority", me)) as ControlCenterReport };
}

const section = (r: ControlCenterReport, id: string): ControlSection => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`mangler seksjon ${id}`);
  return s;
};
const item = (r: ControlCenterReport, sectionId: string, id: string) => {
  const i = section(r, sectionId).items.find((x) => x.id === id);
  if (!i) throw new Error(`mangler element ${sectionId}/${id}`);
  return i;
};
const actionIds = (r: ControlCenterReport): string[] => r.actions.map((a) => a.id);

describe("seksjonene og eier-/delegert autoritet", () => {
  it("alle ni seksjoner finnes i fast rekkefølge, målt og kildeforankret", async () => {
    const r = await build().run();
    expect(r.sections.map((s) => s.id)).toEqual(["authority", "devices", "autonomy", "switches", "pauses", "risk_classes", "policies", "external", "confirmations"]);
    for (const s of r.sections) {
      expect(s.source.length, s.id).toBeGreaterThan(8);
      expect(s.measured, s.id).toBe(true);
      expect(s.observed_at, s.id).toBe(NOW.toISOString());
    }
    expect(r.sensitivity).toBe("PRIVATE");
  });

  it("eier-autoritet konfigurert: OK, din modus er SOVEREIGN; ikke konfigurert: WARN og SCOPED (aldri en antatt suveren modus)", async () => {
    const ok = await build().run();
    expect(item(ok, "authority", "owner")).toMatchObject({ status: "OK", facts: { configured: true, owner_tenants: 1, viewer_mode: "SOVEREIGN" } });
    const none = await build({ authority: null }).run();
    expect(item(none, "authority", "owner")).toMatchObject({ status: "WARN", facts: { configured: false, viewer_mode: "SCOPED" } });
    expect(item(none, "authority", "owner").detail_no).toContain("IKKE konfigurert");
  });

  it("delegater arver aldri eier-autoritet: regelen vises, og andre personers aktive enheter/grants telles", async () => {
    const r = await build().run();
    expect(item(r, "authority", "delegates").facts).toMatchObject({ rule: "delegation_id => SCOPED", other_person_devices: 1, other_person_active_grants: 2 });
    expect(section(r, "authority").summary_no).toContain("1 aktive enheter tilhører andre enn deg");
  });

  it("enheter: delegert enhet merkes, tilbakekalt enhet vises, og tilbakekall (revoke_device) tilbys aldri på DENNE enheten eller en allerede tilbakekalt enhet", async () => {
    const r = await build().run();
    expect(item(r, "devices", "dev-delegate").facts).toMatchObject({ delegated: true, active_grants: 2, current_device: false });
    expect(item(r, "devices", "dev-delegate").detail_no).toContain("annen person");
    expect(item(r, "devices", "dev-current").facts).toMatchObject({ current_device: true });
    expect(item(r, "devices", "dev-current").detail_no).toContain("DENNE enheten");
    expect(item(r, "devices", "dev-old").facts).toMatchObject({ revoked: true });
    const ids = actionIds(r).filter((x) => x.startsWith("authority.revoke_device:"));
    expect(ids.sort()).toEqual(["authority.revoke_device:dev-delegate", "authority.revoke_device:dev-phone"]);
    const a = r.actions.find((x) => x.id === "authority.revoke_device:dev-delegate")!;
    expect(a).toMatchObject({ endpoint: "/executive/mutate", body: { action: "revoke_device", parameters: { device_id: "dev-delegate" } }, risk_class: "C", requires_step_up: true, reversible: false, section_id: "devices", item_id: "dev-delegate" });
    expect(a.rollback_no).toContain("Kan ikke angres");
  });

  it("enhetsoversikt som ikke kan leses er en egen UKJENT-seksjon (measured:false), og delegat-tellingen blir ukjent (null), ikke 0", async () => {
    // JARVIS_GITHUB_REPO satt: ellers er kodejobb-allowlisten tom (WARN, fail-closed) og ville vært verste status i stedet for den uleste enhetsoversikten
    const r = await build({ devices: new Error("boom"), env: { JARVIS_GITHUB_REPO: "tsworkflow/jarvisbuild" } }).run();
    expect(section(r, "devices")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(item(r, "authority", "delegates").facts).toMatchObject({ other_person_devices: null, other_person_active_grants: null });
    expect(section(r, "authority").status).toBe("UNKNOWN");
    expect(r.status).toBe("UNKNOWN");
  });

  it("delegert autonomi: kun handlingens NAVN og risikoklasse vises; pauset domene gir WARN; health-rommet telles uten å listes", async () => {
    const r = await build({ pauses: [{ domain: "finance", paused_by: "person-owner", paused_at: ago(3 * H) }], healthPolicies: 2 }).run();
    const p = item(r, "autonomy", "business:finance");
    expect(p.status).toBe("WARN");
    expect(p.detail_no).toContain("PAUSET");
    expect(p.facts).toMatchObject({ tool: "finance_spend", action: "sync_internal_spend", enabled: true, domain_paused: true, risk_class: "B" });
    expect(section(r, "autonomy").summary_no).toContain("2 i health-rommet (isolert, ikke listet)");
    const clean = await build().run();
    expect(item(clean, "autonomy", "business:finance").status).toBe("OK");
  });
});

describe("globale brytere", () => {
  it("kill switch av: OK og «Aktiver kill switch» (D, uten step-up, kan angres); aktiv: FAIL, summary roper, og «Opphev» krever step-up", async () => {
    const off = await build().run();
    expect(item(off, "switches", "kill_switch")).toMatchObject({ status: "OK", facts: { active: false } });
    expect(off.actions.find((a) => a.id === "authority.kill_switch.activate")).toMatchObject({ endpoint: "/executive/mutate", body: { action: "activate_kill_switch" }, risk_class: "D", requires_step_up: false, reversible: true, item_id: "kill_switch" });
    expect(actionIds(off)).not.toContain("authority.kill_switch.deactivate");

    const on = await build({ kill: { reason: "hemmelig begrunnelse med sk-ant-api03-ABCDEFGHIJKLMNOP", actor_person_id: "person-owner", changed_at: ago(2 * H) } }).run();
    expect(item(on, "switches", "kill_switch")).toMatchObject({ status: "FAIL", facts: { active: true, activated_by: "person-owner" } });
    expect(section(on, "switches").summary_no).toContain("KILL SWITCH ER AKTIV");
    expect(on.actions.find((a) => a.id === "authority.kill_switch.deactivate")).toMatchObject({ body: { action: "deactivate_kill_switch" }, risk_class: "D", requires_step_up: true });
    expect(actionIds(on)).not.toContain("authority.kill_switch.activate");
    expect(on.status).toBe("FAIL");
    expect(JSON.stringify(on)).not.toContain("hemmelig begrunnelse");
    expect(JSON.stringify(on)).not.toContain("sk-ant");
  });

  it("kill switch som ikke kan leses er UKJENT (aldri «av»); stans tilbys fortsatt, opphev gjør det ikke", async () => {
    const r = await build({ kill: new Error("connect ECONNREFUSED 10.0.0.9:5432") }).run();
    expect(item(r, "switches", "kill_switch").status).toBe("UNKNOWN");
    expect(item(r, "switches", "kill_switch").detail_no).toContain("behandles ikke som «av»");
    expect(actionIds(r)).toContain("authority.kill_switch.activate");
    expect(actionIds(r)).not.toContain("authority.kill_switch.deactivate");
    expect(JSON.stringify(r)).not.toContain("10.0.0.9");
  });

  it("finans-nødbryter: aktiv gir WARN + «Opphev» (D, step-up); av gir «Aktiver» (D, uten step-up); uleselig er UKJENT", async () => {
    const off = await build().run();
    expect(item(off, "switches", "finance_kill_switch").status).toBe("OK");
    expect(off.actions.find((a) => a.id === "authority.finance_kill_switch.enable")).toMatchObject({ body: { action: "enable_finance_kill_switch" }, risk_class: "D", requires_step_up: false });
    const on = await build({ finance: [{ enabled: true, enabled_at: ago(4 * H) }] }).run();
    expect(item(on, "switches", "finance_kill_switch")).toMatchObject({ status: "WARN", facts: { enabled: true } });
    expect(on.actions.find((a) => a.id === "authority.finance_kill_switch.disable")).toMatchObject({ body: { action: "disable_finance_kill_switch" }, requires_step_up: true });
    const bad = await build({ finance: new Error("x") }).run();
    expect(item(bad, "switches", "finance_kill_switch").status).toBe("UNKNOWN");
    expect(actionIds(bad).filter((x) => x.startsWith("authority.finance_kill_switch"))).toEqual([]);
  });

  it("infra-modus: NORMAL OK; PAUSED/DEGRADED/ikke i synk gir WARN; uleselig delt modus og manglende port er UKJENT", async () => {
    expect(item(await build({ infra: { mode: "NORMAL" } }).run(), "switches", "infra_mode").status).toBe("OK");
    expect(item(await build({ infra: { mode: "PAUSED", shared_mode: "PAUSED" } }).run(), "switches", "infra_mode")).toMatchObject({ status: "WARN", facts: { mode: "PAUSED" } });
    expect(item(await build({ infra: { mode: "DEGRADED", shared_mode: "DEGRADED" } }).run(), "switches", "infra_mode").detail_no).toContain("klasse D blokkert");
    const unsynced = await build({ infra: { mode: "PAUSED", in_sync: false } }).run();
    expect(item(unsynced, "switches", "infra_mode").status).toBe("WARN");
    expect(item(unsynced, "switches", "infra_mode").detail_no).toContain("IKKE i synk");
    expect(item(await build({ infra: { mode: "NORMAL", shared_readable: false, in_sync: false } }).run(), "switches", "infra_mode").status).toBe("UNKNOWN");
    expect(item(await build({ infra: "error" }).run(), "switches", "infra_mode").status).toBe("UNKNOWN");
    expect(item(await build({ infra: "absent" }).run(), "switches", "infra_mode").status).toBe("UNKNOWN");
  });
});

describe("pauser og tilbakekall", () => {
  it("«alle domener» står alltid først; kjente domener kommer fra autonomi, situasjoner og pauser; hvert aktivt domene kan pauses (C, uten step-up)", async () => {
    const r = await build({ situationDomains: ["support", "finance"], pauses: [{ domain: "sales", paused_by: "person-owner", paused_at: ago(H) }] }).run();
    const ids = section(r, "pauses").items.map((i) => i.id).filter((i) => i.startsWith("domain:"));
    expect(new Set(ids)).toEqual(new Set(["domain:*", "domain:finance", "domain:support", "domain:sales"]));
    expect(ids[0]).toBe("domain:sales"); // verste først (WARN) - men «alle domener» finnes alltid
    expect(actionIds(r)).toContain("authority.pause:*");
    const pause = r.actions.find((a) => a.id === "authority.pause:finance")!;
    expect(pause).toMatchObject({ endpoint: "/executive/mutate", body: { action: "pause_domain", parameters: { domain: "finance" } }, risk_class: "C", requires_step_up: false, reversible: true });
    const all = r.actions.find((a) => a.id === "authority.pause:*")!;
    expect(all.description_no).toContain("HELE Situation Engine");
  });

  it("pauset domene tilbyr GJENOPPTA (step-up) i stedet for pause; «alle domener» pauset gjør alle domener WARN uten egne pause-knapper", async () => {
    const one = await build({ pauses: [{ domain: "finance", paused_by: "person-owner", paused_at: ago(H) }] }).run();
    expect(item(one, "pauses", "domain:finance").status).toBe("WARN");
    expect(actionIds(one)).toContain("authority.resume:finance");
    expect(actionIds(one)).not.toContain("authority.pause:finance");
    expect(one.actions.find((a) => a.id === "authority.resume:finance")).toMatchObject({ body: { action: "resume_domain", parameters: { domain: "finance" } }, requires_step_up: true });

    const all = await build({ pauses: [{ domain: "*", paused_by: "person-owner", paused_at: ago(H) }] }).run();
    expect(item(all, "pauses", "domain:support").status).toBe("WARN");
    expect(item(all, "pauses", "domain:support").detail_no).toContain("alle domener");
    expect(actionIds(all)).toContain("authority.resume:*");
    expect(actionIds(all)).not.toContain("authority.pause:support");
    expect(actionIds(all)).not.toContain("authority.pause:*");
  });

  it("frosne connectorer og tilbakekalte credentials vises med gjenoppta/gjenopprett (C, step-up) - også mål utenfor connector-registeret", async () => {
    const r = await build({
      frozen: [{ connector_id: "github", changed_at: ago(5 * H) }, { connector_id: "model:anthropic", changed_at: ago(H) }],
      revoked: [{ credential_ref: "JARVIS_EMAIL_TOKEN", changed_at: ago(7 * H) }]
    }).run();
    expect(item(r, "pauses", "frozen:model:anthropic").status).toBe("WARN");
    expect(item(r, "pauses", "revoked:JARVIS_EMAIL_TOKEN").facts).toMatchObject({ credential_ref: "JARVIS_EMAIL_TOKEN" });
    expect(r.actions.find((a) => a.id === "authority.unfreeze:model:anthropic")).toMatchObject({ body: { action: "unfreeze_connector", parameters: { connector_id: "model:anthropic" } }, risk_class: "C", requires_step_up: true });
    expect(r.actions.find((a) => a.id === "authority.restore:JARVIS_EMAIL_TOKEN")).toMatchObject({ body: { action: "restore_credential", parameters: { credential_ref: "JARVIS_EMAIL_TOKEN" } }, requires_step_up: true });
    expect(section(r, "pauses").summary_no).toContain("aktive pauser/tilbakekall");
  });

  it("pauser/frysinger som ikke kan leses gjør seksjonen UKJENT og sier det (aldri «ingen pauser»)", async () => {
    const r1 = await build({ pauses: new Error("boom") }).run();
    expect(section(r1, "pauses").status).toBe("UNKNOWN");
    expect(section(r1, "pauses").summary_no).toContain("behandles ikke som «ingen pauser»");
    const r2 = await build({ controlsFail: new Error("boom") }).run();
    expect(section(r2, "pauses").status).toBe("UNKNOWN");
    expect(section(r2, "pauses").summary_no).toContain("frys/tilbakekall");
  });
});

describe("risikoklasser fra manifestet", () => {
  it("A-D telles fra de registrerte handlingene; klasse D står aldri på en modellflate; invariantene holder", async () => {
    const r = await build().run();
    const total = defs.length;
    const sum = (["A", "B", "C", "D"] as const).reduce((a, c) => a + Number(item(r, "risk_classes", c).facts?.["actions"]), 0);
    expect(sum).toBe(total);
    expect(item(r, "risk_classes", "D")).toMatchObject({ status: "OK", facts: { on_model_surface: 0 } });
    expect(Number(item(r, "risk_classes", "A").facts?.["on_model_surface"])).toBeGreaterThan(0);
    expect(item(r, "risk_classes", "invariants")).toMatchObject({ status: "OK", facts: { violations: 0, registered_actions: total } });
    expect(section(r, "risk_classes").summary_no).toContain("ikke om eieren har kapabiliteten");
  });

  it("summarizeManifest melder invariantbrudd (en klasse B-handling merket som kontroll ville brutt minimumsklassen)", () => {
    const broken: ToolDefinition[] = defs.map((d) => (d.tool_id === "owner_controls" && d.action === "freeze_connector" ? { ...d, capability_class: "A" as const } : d));
    const m = summarizeManifest(broken);
    expect(m.violations.length).toBeGreaterThan(0);
    expect(m.violations.join(" ")).toContain("owner_controls.freeze_connector");
  });
});

describe("policyer og eksterne begrensninger", () => {
  it("kostnadsbudsjett: standardgrenser OK; eier-overstyring (JARVIS_BUDGET_APPROVED) WARN; ugyldig rekkefølge FAIL", async () => {
    const def = await build().run();
    expect(item(def, "policies", "budget")).toMatchObject({ status: "OK", facts: { warn_ore: 100_000, approval_ore: 200_000, hard_limit_ore: 300_000, spend_approved: false } });
    expect(item(def, "policies", "budget").detail_no).toContain("1000 kr");
    const approved = await build({ env: { JARVIS_BUDGET_APPROVED: "true" } }).run();
    expect(item(approved, "policies", "budget").status).toBe("WARN");
    expect(item(approved, "policies", "budget").detail_no).toContain("EIER-OVERSTYRING AKTIV");
    const invalid = await build({ env: { JARVIS_COST_WARN_ORE: "500000", JARVIS_COST_APPROVAL_ORE: "200000" } }).run();
    expect(item(invalid, "policies", "budget").status).toBe("FAIL");
  });

  it("dagstak: standard 30 kr, 0 = ingen tak (sies tydelig)", async () => {
    expect(item(await build().run(), "policies", "tool_turn_cap").facts).toMatchObject({ daily_cap_ore: 3000 });
    const none = await build({ env: { JARVIS_TOOL_TURN_DAILY_CAP_ORE: "0" } }).run();
    expect(item(none, "policies", "tool_turn_cap").detail_no).toContain("Ingen tak");
  });

  it("harde porter lest fra gatewayen: av gir FAIL/WARN, manglende måling er UKJENT", async () => {
    const on = await build().run();
    expect(item(on, "policies", "class_d_pipeline").status).toBe("OK");
    expect(item(on, "policies", "credential_binding").status).toBe("OK");
    const off = await build({ flags: { class_d_pipeline_enforced: false, credential_binding_active: false } }).run();
    expect(item(off, "policies", "class_d_pipeline").status).toBe("FAIL");
    expect(item(off, "policies", "credential_binding").status).toBe("WARN");
    const unknown = await build({ flags: "absent" }).run();
    expect(item(unknown, "policies", "class_d_pipeline").status).toBe("UNKNOWN");
    expect(item(unknown, "policies", "credential_binding").status).toBe("UNKNOWN");
  });

  it("step-up, auto-godkjenning og infra-mål speiler koden/konfigurasjonen", async () => {
    const r = await build({ env: { JARVIS_MEMORY_AUTO_APPROVE: "false", JARVIS_DOCKER_MUTATION_TARGETS: "jarvis-api,jarvis-worker", JARVIS_GCE_MUTATION_TARGETS: "europe-west1-b/vm1" } }).run();
    expect(item(r, "policies", "step_up").facts).toMatchObject({ channels: "web, desktop, api, mobile" });
    expect(String(item(r, "policies", "step_up").facts?.["exempt_actions"])).toContain("freeze_connector");
    expect(item(r, "policies", "memory_auto_approve")).toMatchObject({ facts: { auto_approve: false } });
    expect(item(r, "policies", "infra_targets").facts).toMatchObject({ docker_targets: 2, gce_targets: 1 });
    expect(item(await build().run(), "policies", "infra_targets").detail_no).toContain("fail-closed");
  });

  it("GitHub-repo-låsen: standard-repo låst OK; åpnet for andre repo WARN; ugyldig kode-allowlist FAIL; destinasjonsverter listes", async () => {
    const def = await build().run();
    expect(item(def, "external", "github_repo")).toMatchObject({ status: "OK", facts: { repo: CANONICAL_GITHUB_REPO, other_repos_allowed: false } });
    const custom = await build({ env: { JARVIS_GITHUB_REPO: "eier/mitt-repo", JARVIS_GITHUB_ALLOW_OTHER_REPOS: "true", JARVIS_DESTINATION_HOST_ALLOWLIST: "jira.firma.no, *.grafana.net ,", JARVIS_GIT_ALLOWED_REPOS: "eier/mitt-repo" } }).run();
    expect(item(custom, "external", "github_repo")).toMatchObject({ status: "WARN", facts: { repo: "eier/mitt-repo", other_repos_allowed: true } });
    expect(item(custom, "external", "destination_hosts").facts).toMatchObject({ hosts: 2, list: "jira.firma.no, *.grafana.net" });
    expect(item(custom, "external", "code_job_repos")).toMatchObject({ status: "OK", facts: { repos: 1 } });
    const bad = await build({ env: { JARVIS_GIT_ALLOWED_REPOS: "ikke et repo" } }).run();
    expect(item(bad, "external", "code_job_repos").status).toBe("FAIL");
    expect(item(def, "external", "destination_hosts").detail_no).toContain("lukket");
  });
});

describe("åpne bekreftelser", () => {
  it("ventende bekreftelse gir WARN (venter på deg), utløpt gir OK; ingen parametre/sammendrag leses; ingen handlinger (godkjenning skjer andre steder)", async () => {
    const { run, pool } = build({
      confirmations: [
        { confirmation_id: "conf-1", tool_id: "email", action: "send", created_at: ago(2 * H), expires_at: new Date(NOW.getTime() + 3 * H).toISOString(), taint_reasons: ["untrusted_output:email.read_inbox"] },
        { confirmation_id: "conf-2", tool_id: "github", action: "merge_pr", created_at: ago(30 * H), expires_at: ago(6 * H), taint_reasons: [] }
      ]
    });
    const r = await run();
    expect(item(r, "confirmations", "conf-1")).toMatchObject({ status: "WARN", facts: { tool: "email", action: "send", expired: false } });
    expect(item(r, "confirmations", "conf-2")).toMatchObject({ status: "OK", facts: { expired: true } });
    expect(section(r, "confirmations").summary_no).toContain("1 bekreftelser venter");
    expect(r.actions.filter((a) => a.section_id === "confirmations")).toEqual([]);
    const sql = pool.queries.find((q) => /FROM action_confirmations/.test(q.sql))!.sql;
    for (const forbidden of ["parameters", "summary", "binding_hash", "nonce", "result"]) expect(sql, forbidden).not.toContain(forbidden);
    expect(section(await build().run(), "confirmations").summary_no).toContain("Ingen bekreftelser venter");
  });

  it("bekreftelser som ikke kan leses er en UKJENT-seksjon (measured:false)", async () => {
    const r = await build({ confirmations: new Error("boom") }).run();
    expect(section(r, "confirmations")).toMatchObject({ status: "UNKNOWN", measured: false });
  });
});

describe("handlinger, kun lesing og innholdsvern", () => {
  it("hver handling: lukket endepunkt, navn på rutens allowlist, step-up-merke = rutens krav (også stepUpDenial), risikoklasse = verktøyets, aldri identitet/hemmelighet i kroppen, unik id", async () => {
    const r = await build({
      kill: { reason: "x", actor_person_id: "person-owner", changed_at: ago(H) },
      finance: [{ enabled: true, enabled_at: ago(H) }],
      pauses: [{ domain: "finance", paused_by: "person-owner", paused_at: ago(H) }],
      frozen: [{ connector_id: "github", changed_at: ago(H) }], revoked: [{ credential_ref: "JARVIS_EMAIL_TOKEN", changed_at: ago(H) }]
    }).run();
    expect(r.actions.length).toBeGreaterThan(8);
    expect(new Set(actionIds(r)).size).toBe(r.actions.length);
    for (const a of r.actions) {
      expect((CONTROL_ACTION_ENDPOINTS as readonly string[]).includes(a.endpoint), a.id).toBe(true);
      const name = String(a.body["action"]);
      expect(CONTROL_ACTION_ALLOWED[a.endpoint], a.id).toContain(name);
      const params = (a.body["parameters"] ?? {}) as Record<string, unknown>;
      for (const forbidden of ["tenant_id", "person_id", "actor_person_id", "owner_person_id", "session_id", "value", "grant_token"]) expect(params, `${a.id}:${forbidden}`).not.toHaveProperty(forbidden);
      expect(a.requires_step_up, a.id).toBe(actionRequiresStepUp(name));
      expect(stepUpDenial({ auth_strength: "bearer" as never, channel: "web" }, name) === undefined, a.id).toBe(!a.requires_step_up);
      expect(a.risk_class, a.id).toBe(defs.find((d) => d.tool_id === "executive" && d.action === name)?.capability_class);
      expect(a.section_id, a.id).toBeDefined();
      expect(a.item_id, a.id).toBeDefined();
    }
    // en klasse D-handling bærer aldri typed-confirm-navnet i kroppen (det er UI-ets sak), men er merket D
    expect(r.actions.filter((a) => a.risk_class === "D").map((a) => a.body["action"]).sort()).toEqual(["deactivate_kill_switch", "disable_finance_kill_switch"]);
  });

  it("alle spørringer er SELECT; tenant-spørringer kjører under identitetens tenant; autonomi leses i alle rom UTEN health, health i sitt eget; pauser leses globalt", async () => {
    const { pool, run } = build();
    await run();
    for (const q of pool.queries) expect(q.sql.trim().toUpperCase().startsWith("SELECT"), q.sql.slice(0, 60)).toBe(true);
    const tenantQueries = pool.queries.filter((q) => /FROM devices|finance_kill_switch|action_confirmations|situation_autonomy_policies|FROM situations/.test(q.sql));
    expect(tenantQueries.length).toBe(6);
    for (const q of tenantQueries) expect(q.tenant, q.sql.slice(0, 50)).toBe("tenant-owner");
    const autonomy = pool.queries.filter((q) => /situation_autonomy_policies|FROM situations/.test(q.sql));
    const spaces = new Set(autonomy.map((q) => q.spaces));
    expect(spaces).toEqual(new Set(["personal,business,project,home,guest,shared", "health"]));
    const healthOnly = autonomy.filter((q) => q.spaces === "health");
    expect(healthOnly).toHaveLength(1);
    expect(healthOnly[0]!.sql).toContain("count(*)");
    const pauses = pool.queries.filter((q) => /situation_domain_pauses/.test(q.sql));
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.tenant).toBeNull();
  });

  it("innholdsvern i selve SQL-en: aldri nøkler, token, autonomi-parametre eller begrunnelsestekst", async () => {
    const { pool, run } = build();
    await run();
    const all = pool.queries.map((q) => q.sql).join("\n");
    expect(all).not.toContain("public_key_pem");
    expect(all).not.toContain("grant_id");
    expect(all).not.toContain("device_key_fingerprint");
    const autonomySql = pool.queries.find((q) => /FROM situation_autonomy_policies WHERE/.test(q.sql) && !/count\(/.test(q.sql))!.sql;
    expect(autonomySql).not.toContain("parameters");
    const pauseSql = pool.queries.find((q) => /situation_domain_pauses/.test(q.sql))!.sql;
    expect(pauseSql).not.toContain("reason");
  });

  it("«hvorfor?»-forklaringen nevner kill switch og pauser uten begrunnelsestekst", async () => {
    const r = await build({ kill: { reason: "privat grunn", actor_person_id: "person-owner", changed_at: ago(H) }, pauses: [{ domain: "finance", paused_by: "person-owner", paused_at: ago(H) }] }).run();
    const text = explainControlCenterNo(r);
    expect(text).toContain("Kill switch");
    expect(text).toContain("finance");
    expect(text).not.toContain("privat grunn");
  });

  it("registerControlCenters kobler Authority Center kun med verktøygateway, eier-kontroller OG kill switch", () => {
    const pool = new ScriptedPool([]).asPool();
    const gw = { list: () => defs, get: () => undefined, hasSecret: async () => false, health: new Map() } as never;
    const oc = { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] };
    const ks = { currentStateDurable: async () => null };
    const full = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(full, { pool, env: {}, toolGateway: gw, ownerControls: oc, killSwitch: ks });
    expect(full.list().map((c) => c.id)).toEqual(["integration", "authority"]);
    const noKill = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(noKill, { pool, env: {}, toolGateway: gw, ownerControls: oc });
    expect(noKill.list().map((c) => c.id)).toEqual(["integration"]);
    const none = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(none, { pool, env: {} });
    expect(none.list()).toEqual([]);
  });
});
