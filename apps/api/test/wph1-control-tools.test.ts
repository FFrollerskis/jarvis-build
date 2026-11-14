import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_CENTER_IDS, CONTROL_CENTER_READ_ACTIONS, CONTROL_CENTER_READ_TOOLS, ControlCenterRegistry, ExecutiveService, ExecutiveTransport, controlItem, controlSection,
  controlCenterForReadAction, executiveToolDefinitions, stripMoneyFacts, type ControlCenterDefinition, type ControlCenterReport
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MemorySearchTransport, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants, buildToolManifest,
  KnowledgeSearchTransport, chatReadTierMeshTools, firstWaveTools, homeAssistantTools, inferEffect, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, scopeFieldsOf, selectSurfaceTools,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * WP-H1/H2: de per-senter lese-verktøyene (`executive.get_<senter>_center`) er klasse A, ren lesing, uten identitetsfelt i skjemaet; står KUN på web-chatten (aldri tale/Telegram/bakgrunn/koding), ikke i det
 * minimale `MODEL_SURFACE_ALLOWLIST` eller handlings-/delegeringsnivået; har EGEN fail-closed port (eier + signert enhetsøkt - også uten register, i motsetning til `get_control_center`); og svaret til en
 * modell har ingen pengebeløp fra Finans-senteret. Verktøytabellen (`CONTROL_CENTER_READ_TOOLS`) er ÉN kilde; tool-gateway-listene (tier, manifest, tale-unntak) speiler den og låses her.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const keyOf = (action: string): string => `executive.${action}`;
const TOOLS = CONTROL_CENTER_READ_TOOLS;

function productionDefinitions(registry?: ControlCenterRegistry): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, registry ? { controlCenters: registry } : {}))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const ownerOnly = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
const defs = productionDefinitions(ownerOnly);
const gw = { list: () => defs } as unknown as ToolGateway;
const defOf = (action: string, list: ToolDefinition[] = defs): ToolDefinition => list.find((d) => `${d.tool_id}.${d.action}` === keyOf(action)) as ToolDefinition;

describe("tabellen er den eneste kilden", () => {
  it("hvert senter i tabellen er et kjent senter (H0-sentrene har ikke et eget verktøy), og handlingsnavnene er stabile og unike", () => {
    // H1-verktøyene står først og er uendret (WP-H2 la til fire til bakerst - se wph2-control-tools.test.ts for hele tabellen).
    expect(TOOLS.map((t) => t.action).slice(0, 3)).toEqual(["get_finance_center", "get_memory_center", "get_agent_center"]);
    expect(new Set(TOOLS.map((t) => t.action)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(CONTROL_CENTER_IDS as readonly string[]).toContain(t.center);
      expect(t.action).toBe(`get_${t.center}_center`);
      expect(controlCenterForReadAction(t.action)).toBe(t.center);
    }
    expect(controlCenterForReadAction("get_ai_center")).toBeUndefined();
    expect(controlCenterForReadAction("get_control_center")).toBeUndefined();
  });

  it("alle verktøy i tabellen er registrert i executive-definisjonene - og INGEN annen `*_center`-handling finnes uten å stå i tabellen", () => {
    for (const t of TOOLS) expect(defOf(t.action), t.action).toBeDefined();
    const centerActions = defs.filter((d) => d.tool_id === "executive" && /_center$/.test(d.action)).map((d) => d.action).sort();
    expect(centerActions).toEqual(["get_control_center", ...CONTROL_CENTER_READ_ACTIONS].sort());
  });
});

describe("registrering og risiko", () => {
  for (const t of TOOLS) {
    it(`${t.action}: klasse A, reversibel lesing, uten identitetsfelt, strengt og parameterløst skjema`, () => {
      const def = defOf(t.action);
      expect(def.capability_class).toBe("A");
      expect(def.reversible).toBe(true);
      expect(inferEffect(def.tool_id, def.action)).toBe("read");
      expect(scopeFieldsOf(def)).toEqual([]);
      const parse = (p: Record<string, unknown>) => def.input_schema.safeParse(p).success;
      expect(parse({})).toBe(true);
      for (const bad of [{ center: "finance" }, { tenant_id: "t" }, { person_id: "p" }, { action: "freeze_connector" }, { extra: 1 }]) expect(parse(bad), JSON.stringify(bad)).toBe(false);
    });

    it(`${t.action}: beskrivelsen sier lesing, eier + signert enhet og at ukjent er ukjent`, () => {
      const d = defOf(t.action).description;
      expect(d).toContain("KUN lesing");
      expect(d).toMatch(/Kun eieren får svar, og kun fra en signert enhetsøkt/);
      expect(d).toMatch(/ukjent vises som ukjent/);
      expect(d).not.toMatch(/\b(pause|tilbakekall|aktiver|slett)\w* (nå|umiddelbart)/i);
    });
  }

  it("Finans-beskrivelsen sier at beløp er utelatt til modellen; ingen verktøy har høyere rate-grense enn 30/min bortsett fra get_control_center (120/min - siden gjør 1 + antall sentre kall)", () => {
    expect(defOf("get_finance_center").description).toContain("Beløp er utelatt");
    for (const t of TOOLS) expect(defOf(t.action).rate_limit_per_minute, t.action).toBe(30);
    expect(defOf("get_control_center").rate_limit_per_minute).toBe(120);
  });
});

describe("modellflaten: kun web-chatten, aldri tale/Telegram/bakgrunn/koding", () => {
  for (const t of TOOLS) {
    it(`${t.action}: står én gang i CHAT_READ_TIER - og ikke i MODEL_SURFACE_ALLOWLIST, handlingsnivået eller delegeringsnivået`, () => {
      expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === keyOf(t.action))).toHaveLength(1);
      for (const tier of [MODEL_SURFACE_ALLOWLIST, CHAT_ACT_TIER, CHAT_DELEGATE_TIER]) expect(tier.some((g) => `${g.tool_id}.${g.action}` === keyOf(t.action))).toBe(false);
    });

    it(`${t.action}: manifestet har den som klasse A/read på kun web_chat, intern sone`, () => {
      const entry = buildToolManifest(defs).get(keyOf(t.action));
      expect(entry).toMatchObject({ risk: "A", effect: "read", owner: "jarvis_core", data_zone: "internal" });
      expect(entry?.surfaces).toEqual(["web_chat"]);
      for (const surface of ["voice", "telegram", "background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === keyOf(t.action)), surface).toBe(false);
    });
  }

  it("sensitivitet: Finans er `restricted` (finansdomenet), Minne og Agenter er `private`; resten av executive-lesingene beholder sine merker", () => {
    const manifest = buildToolManifest(defs);
    expect(manifest.get(keyOf("get_finance_center"))?.sensitivity).toBe("restricted");
    expect(manifest.get(keyOf("get_memory_center"))?.sensitivity).toBe("private");
    expect(manifest.get(keyOf("get_agent_center"))?.sensitivity).toBe("private");
    expect(manifest.get("executive.get_control_center")?.sensitivity).toBe("private");
    expect(manifest.get("executive.get_slo_report")?.sensitivity).toBe("public");
  });

  it("boot-invariantene (manifest og lese-nivå) holder, og modellen ser et strengt skjema uten egenskaper", () => {
    expect(() => assertManifestInvariants(buildToolManifest(defs))).not.toThrow();
    expect(() => assertChatReadTier(gw)).not.toThrow();
    expect(() => resolveModelToolSurface(gw, { includeChatReadTier: true })).not.toThrow();
    const mapped = chatReadTierMeshTools(defs, CHAT_READ_TIER, "read");
    for (const t of TOOLS) {
      const m = mapped.find((x) => `${x.tool_id}.${x.action}` === keyOf(t.action));
      expect(m?.def.name).toBe(`executive__${t.action}`);
      expect((m?.def.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(Object.keys((m?.def.input_schema as { properties?: object }).properties ?? {})).toEqual([]);
    }
  });
});

describe("utvalg per melding", () => {
  const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });
  const picked = (text: string, s: "web_chat" | "voice" = "web_chat") => selectSurfaceTools(s, text, surface);
  const keys = (text: string, s: "web_chat" | "voice" = "web_chat") => picked(text, s).selected.map((m) => `${m.tool_id}.${m.action}`);

  it("eksplisitte senterspørsmål gir det aktuelle verktøyet - og kun det senteret", () => {
    expect(keys("vis finanssenteret")).toContain(keyOf("get_finance_center"));
    expect(keys("hva er status på finans")).toContain(keyOf("get_finance_center"));
    expect(keys("er det noen betalinger med ukjent utfall")).toContain(keyOf("get_finance_center"));
    expect(keys("hva sier minnesenteret")).toContain(keyOf("get_memory_center"));
    expect(keys("hva ligger i karantene")).toContain(keyOf("get_memory_center"));
    expect(keys("vis styringsjournalen med proveniens")).toContain(keyOf("get_memory_center"));
    expect(keys("vis agentsenteret")).toContain(keyOf("get_agent_center"));
    expect(keys("hvilke agenter kjører akkurat nå")).toContain(keyOf("get_agent_center"));
    expect(keys("vis kjørende jobber")).toContain(keyOf("get_agent_center"));
    expect(keys("vis finanssenteret")).not.toContain(keyOf("get_memory_center"));
    expect(keys("vis agentsenteret")).not.toContain(keyOf("get_finance_center"));
  });

  it("småprat og urelaterte meldinger får ingen av dem; «kontrollsentrene» alene gir fortsatt get_control_center (H0 uendret) og låser ikke turen", () => {
    for (const msg of ["hei", "hva er klokka", "snakk om været", "hvem er kunden min", "hva husker du om meg"]) {
      for (const t of TOOLS) expect(keys(msg), `${msg} → ${t.action}`).not.toContain(keyOf(t.action));
    }
    const overview = picked("vis kontrollsentrene");
    expect(overview.selected.map((m) => `${m.tool_id}.${m.action}`)).toContain("executive.get_control_center");
    expect(overview.min_sensitivity).toBeUndefined();
  });

  it("å velge Finans-senteret låser turen lokalt (SECRET_RESTRICTED, som finance_*); Minne og Agenter gjør det ikke", () => {
    expect(picked("vis finanssenteret").min_sensitivity).toBe("SECRET_RESTRICTED");
    expect(picked("hva er status på finans").min_sensitivity).toBe("SECRET_RESTRICTED");
    expect(picked("vis minnesenteret").min_sensitivity).toBeUndefined();
    expect(picked("vis agentsenteret").min_sensitivity).toBeUndefined();
  });

  it("en stemmeflate som velger verktøy per melding får aldri noen av dem, uansett hva som sies", () => {
    for (const msg of ["vis finanssenteret", "hva sier minnesenteret", "vis agentsenteret og hvilke agenter kjører"]) {
      for (const t of TOOLS) expect(keys(msg, "voice"), `${msg} → ${t.action}`).not.toContain(keyOf(t.action));
    }
  });
});

describe("lese-porten: eier OG signert enhetsøkt, FAIL-CLOSED også uten register", () => {
  const NON_OWNERS: ReadonlyArray<readonly [string, IdentityContext]> = [
    ["annen person i eierens tenant", { ...owner, person_id: "person-member" }],
    ["delegat (eierens person_id MED delegation_id)", { ...owner, delegation_id: "deleg-1" }],
    ["gjest", { ...owner, person_id: "person-guest", memory_space_id: "guest" }],
    ["eierens person i en annen tenant", { ...owner, tenant_id: "tenant-annen" }],
    ["annen person i annen tenant", { ...owner, person_id: "person-x", tenant_id: "tenant-y" }]
  ];

  for (const t of TOOLS) {
    it(`${t.action}: eieren fra en signert enhetsøkt slipper gjennom`, () => {
      expect(defOf(t.action).parameterAuthorizer?.({}, owner)).toEqual({ allowed: true, reason: "owner" });
    });

    it(`${t.action}: alle ikke-eiere nektes med eier-årsaken - selv med signert økt`, () => {
      for (const [label, identity] of NON_OWNERS) expect(defOf(t.action).parameterAuthorizer?.({}, identity), label).toEqual({ allowed: false, reason: "control_center_owner_only" });
    });

    it(`${t.action}: eieren uten signert økt (passiv/aktiv, også på tale/Telegram) nektes med en tydelig årsak`, () => {
      for (const auth_strength of ["passive", "active"] as const) {
        for (const channel of ["web", "voice", "telegram", "api"] as const) {
          expect(defOf(t.action).parameterAuthorizer?.({}, { ...owner, auth_strength, channel }), `${auth_strength}/${channel}`).toEqual({ allowed: false, reason: "control_center_requires_signed_device_session" });
        }
      }
    });

    it(`${t.action}: FAIL-CLOSED uten register og med et register uten eier-predikat - i motsetning til get_control_center, som slipper gjennom uten register`, () => {
      expect(defOf(t.action, productionDefinitions()).parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
      expect(defOf(t.action, productionDefinitions(new ControlCenterRegistry())).parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
      expect(defOf("get_control_center", productionDefinitions()).parameterAuthorizer?.({}, owner)).toEqual({ allowed: true, reason: "no_control_centers" });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Responsen (transporten): samme register, ærlig «ikke koblet inn», og ingen pengebeløp til en modell
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const money = (id: "finance" | "ai"): ControlCenterDefinition => ({
  id, title_no: id === "finance" ? "Finans" : "AI", description_no: "test",
  build: async () => ({
    sections: [controlSection({
      id: "s1", title_no: "Seksjon", source: "test", summary_no: "1 rad",
      items: [controlItem({ id: "i1", label: "Rad", status: "OK", detail_no: "ingen beløp i teksten", facts: { count: 2, amount_ore: 150_000, daily_cap_ore: 5_000, state: "settled" } })]
    })],
    actions: []
  })
});

function transportWith(centers: ControlCenterDefinition[]): ExecutiveTransport {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
  for (const c of centers) registry.register(c);
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry }));
}
type Data = { found: boolean; summary_no: string; explanation_no?: string; report?: ControlCenterReport; center?: string };
const call = async (t: ExecutiveTransport, action: string, params: Record<string, string> = {}, ctx: Record<string, unknown> = {}): Promise<Data> =>
  ((await t.invoke(action, params, "cred", { identity: owner, ...ctx } as never)).data) as unknown as Data;
const factKeys = (r: ControlCenterReport | undefined): string[] => (r?.sections ?? []).flatMap((s) => s.items.flatMap((i) => Object.keys(i.facts ?? {})));

describe("responsen", () => {
  it("et senter som ikke er koblet inn (flagget er av) gir et ærlig, strukturert `found: false` - aldri en tom «i orden» og aldri et kastet unntak", async () => {
    const t = transportWith([]);
    for (const tool of TOOLS) {
      const data = await call(t, tool.action);
      expect(data).toMatchObject({ found: false, center: tool.center });
      expect(data.summary_no).toContain("ikke koblet inn");
    }
  });

  it("med registeret: samme rapport som get_control_center {center}, summary_no og explanation_no først", async () => {
    const t = transportWith([money("finance")]);
    const viaTool = await call(t, "get_finance_center");
    const viaCenter = await call(t, "get_control_center", { center: "finance" });
    expect(viaTool.found).toBe(true);
    expect(Object.keys(viaTool)).toEqual(["found", "summary_no", "explanation_no", "report"]);
    expect(viaTool.report?.sections).toEqual(viaCenter.report?.sections);
    expect(viaTool.explanation_no).toContain("Finans");
  });

  it("UTEN modell i løkka (siden) får Finans hele rapporten, inkl. beløp i øre; MED en modell (servingModel) er alle `*_ore`-fakta fjernet - via begge verktøyene", async () => {
    const t = transportWith([money("finance")]);
    const model = { servingModel: { provider: "anthropic", model: "test" } };
    expect(factKeys((await call(t, "get_finance_center")).report)).toEqual(expect.arrayContaining(["amount_ore", "daily_cap_ore"]));
    expect(factKeys((await call(t, "get_control_center", { center: "finance" })).report)).toContain("amount_ore");
    for (const [action, params] of [["get_finance_center", {}], ["get_control_center", { center: "finance" }]] as const) {
      const keys = factKeys((await call(t, action, params, model)).report);
      expect(keys, action).toEqual(expect.arrayContaining(["count", "state"]));
      expect(keys.filter((k) => /_ore$/.test(k)), action).toEqual([]);
    }
  });

  it("H0-sentrene er uendret: AI-senterets `*_ore`-fakta (grenser og kost) når fortsatt modellen", async () => {
    const t = transportWith([money("ai")]);
    const keys = factKeys((await call(t, "get_control_center", { center: "ai" }, { servingModel: { provider: "anthropic", model: "test" } })).report);
    expect(keys).toEqual(expect.arrayContaining(["amount_ore", "daily_cap_ore"]));
  });

  it("stripMoneyFacts rører kun Finans, muterer aldri inndata og beholder alt annet", () => {
    const report = { center: "finance", sections: [{ items: [{ facts: { a_ore: 1, b: 2 } }, { label: "uten fakta" }] }] } as unknown as ControlCenterReport;
    const out = stripMoneyFacts(report);
    expect(out.sections[0]?.items[0]?.facts).toEqual({ b: 2 });
    expect(out.sections[0]?.items[1]).toEqual({ label: "uten fakta" });
    expect(report.sections[0]?.items[0]?.facts).toEqual({ a_ore: 1, b: 2 });
    const other = { ...report, center: "memory" } as ControlCenterReport;
    expect(stripMoneyFacts(other)).toBe(other);
  });

  it("transporten uten invocation-context feiler lukket (som alle executive-handlinger)", async () => {
    const t = transportWith([money("finance")]);
    await expect(t.invoke("get_finance_center", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});
