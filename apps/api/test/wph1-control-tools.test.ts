import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CLOUD_WITHHELD_CENTERS, CONTROL_CENTER_IDS, CONTROL_CENTER_READ_ACTIONS, CONTROL_CENTER_READ_TOOLS, ControlCenterRegistry, EXECUTION_GUARDED_RESTRICTED_KEYS, ExecutiveService, ExecutiveTransport, controlItem, controlSection,
  controlCenterForReadAction, executiveToolDefinitions, isCloudWithheldCenter, withheldCenterData, type ControlCenterDefinition, type ControlCenterReport
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MemorySearchTransport, OPTIONAL_TIER_KEYS, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants, buildToolManifest,
  KnowledgeSearchTransport, chatReadTierMeshTools, firstWaveTools, homeAssistantTools, inferEffect, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, scopeFieldsOf, selectSurfaceTools,
  financeToolIntent, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { CONTROL_CENTER_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { activeRestrictedControlTools, controlCentersWithTools, financeIntentOptions, safeRef } from "../src/control-center/shared.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * WP-H1/H2: de per-senter lese-verktøyene (`executive.get_<senter>_center`) er klasse A, ren lesing, uten identitetsfelt i skjemaet; står KUN på web-chatten (aldri tale/Telegram/bakgrunn/koding), ikke i det
 * minimale `MODEL_SURFACE_ALLOWLIST` eller handlings-/delegeringsnivået; har EGEN fail-closed port (eier + signert enhetsøkt - også uten register, i motsetning til `get_control_center`); og en SKYmodell får
 * aldri finansrapporten (gjennomgang M2: holdt tilbake VED UTFØRELSE, også på en tur der utvalget ikke valgte verktøyet; en lokal modell og siden får hele rapporten, D-378 punkt 2). Verktøytabellen
 * (`CONTROL_CENTER_READ_TOOLS`) er ÉN kilde; tool-gateway-listene (tier, manifest, tale-unntak) speiler den og låses her.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const keyOf = (action: string): string => `executive.${action}`;
const TOOLS = CONTROL_CENTER_READ_TOOLS;

/** Alle sentrene med et eget lese-verktøy - i produksjon registreres verktøyene KUN for sentrene hvis flagg er på (`enabledControlCenters`, gjennomgang M1); testene under har dem alle på med mindre noe annet er sagt. */
const ALL_CENTERS = TOOLS.map((t) => t.center);

function productionDefinitions(registry?: ControlCenterRegistry, centers: ReadonlyArray<(typeof TOOLS)[number]["center"]> = ALL_CENTERS): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, registry ? { controlCenters: registry } : {})), { controlCenters: centers }),
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
    expect(TOOLS.map((t) => t.action)).toEqual(["get_finance_center", "get_memory_center", "get_agent_center"]);
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

describe("gjennomgang M1: verktøyene registreres KUN for sentre med flagget på (flagg AV er identisk med main)", () => {
  const actionsOf = (list: ToolDefinition[]): string[] => list.filter((d) => d.tool_id === "executive" && /_center$/.test(d.action)).map((d) => d.action).sort();
  const rateOf = (list: ToolDefinition[], action: string): number | undefined => list.find((d) => d.tool_id === "executive" && d.action === action)?.rate_limit_per_minute;

  it("ingen flagg på: INGEN `get_<senter>_center` finnes (kun H0-verktøyet `get_control_center`), og `get_control_center` har main sin rate-grense (30/min, arvet fra read())", () => {
    const none = productionDefinitions(ownerOnly, []);
    expect(actionsOf(none)).toEqual(["get_control_center"]);
    expect(rateOf(none, "get_control_center")).toBe(30);
    // utelatt valg = ingen sentre på (standard for alle eksisterende kallere)
    const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const defaults = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw)));
    expect(actionsOf(defaults)).toEqual(["get_control_center"]);
    expect(rateOf(defaults, "get_control_center")).toBe(30);
  });

  it("kun de slåtte-på sentrene får verktøy; rate-grensen på `get_control_center` heves (120/min) først når minst ett senter er på", () => {
    const one = productionDefinitions(ownerOnly, ["memory"]);
    expect(actionsOf(one)).toEqual(["get_control_center", "get_memory_center"]);
    expect(rateOf(one, "get_control_center")).toBe(120);
    expect(rateOf(one, "get_memory_center")).toBe(30);
    expect(actionsOf(productionDefinitions(ownerOnly, ["finance", "agent"]))).toEqual(["get_agent_center", "get_control_center", "get_finance_center"]);
  });

  it("OPTIONAL_TIER_KEYS er nøyaktig nøklene til tabellen (ingen mer, ingen mindre) - og alle står i web-chattens lese-nivå", () => {
    expect([...OPTIONAL_TIER_KEYS].sort()).toEqual(TOOLS.map((t) => keyOf(t.action)).sort());
    for (const key of OPTIONAL_TIER_KEYS) expect(CHAT_READ_TIER.some((g) => `${g.tool_id}.${g.action}` === key), key).toBe(true);
  });

  it("oppstartsvaktene godtar at disse (og KUN disse) mangler: ingen flagg på → manifest, lese-nivå og modellflate er gyldige uten dem", () => {
    const none = productionDefinitions(ownerOnly, []);
    const noneGw = { list: () => none } as unknown as ToolGateway;
    expect(() => assertManifestInvariants(buildToolManifest(none))).not.toThrow();
    expect(() => assertChatReadTier(noneGw)).not.toThrow();
    expect(() => resolveModelToolSurface(noneGw, { includeChatReadTier: true })).not.toThrow();
    // ... men en ANNEN manglende lese-nøkkel feiler fortsatt (unntaket er smalt, ikke «alt som mangler er greit»)
    const withoutSlo = none.filter((d) => !(d.tool_id === "executive" && d.action === "get_slo_report"));
    expect(() => assertChatReadTier({ list: () => withoutSlo } as unknown as ToolGateway)).toThrow(/executive:get_slo_report: ikke registrert/);
    expect(() => assertManifestInvariants(buildToolManifest(withoutSlo))).toThrow(/executive\.get_slo_report/);
  });

  it("er et av verktøyene registrert, kontrolleres det som alle andre: klasse B eller et skrive-lignende handlingsnavn stopper oppstarten", () => {
    const base = productionDefinitions(ownerOnly, ["memory"]);
    const tampered = base.map((d) => (d.tool_id === "executive" && d.action === "get_memory_center" ? { ...d, capability_class: "B" as const } : d));
    expect(() => assertChatReadTier({ list: () => tampered } as unknown as ToolGateway)).toThrow(/executive:get_memory_center: klasse B/);
  });

  it("utvalg og lese-nivå ser aldri et uregistrert verktøy: flaten uten flagg har ingen av dem, og flaten med flagg har dem", () => {
    const none = productionDefinitions(ownerOnly, []);
    const on = productionDefinitions(ownerOnly, ALL_CENTERS);
    const surfaceKeys = (list: ToolDefinition[]): string[] => resolveModelToolSurface({ list: () => list } as unknown as ToolGateway, { includeChatReadTier: true }).map((m) => `${m.tool_id}.${m.action}`);
    for (const t of TOOLS) {
      expect(surfaceKeys(none), t.action).not.toContain(keyOf(t.action));
      expect(surfaceKeys(on), t.action).toContain(keyOf(t.action));
    }
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

  it("Finans-beskrivelsen sier ærlig at en skymodell IKKE får rapporten (SECRET_RESTRICTED, D-378) - og lover ikke «beløp er utelatt»", () => {
    const d = defOf("get_finance_center").description;
    expect(d).toContain("SECRET_RESTRICTED");
    expect(d).toMatch(/skymodell får IKKE rapporten/);
    expect(d).toMatch(/lokal modell og kontrollsiden får den/);
    expect(d).not.toContain("Beløp er utelatt");
  });

  it("ingen verktøy har høyere rate-grense enn 30/min bortsett fra get_control_center (120/min med sentre på - siden gjør 1 + antall sentre kall)", () => {
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

/** Lokale leverandører slik leverandørregisteret ser dem (samme sett som `servedByCloudModel` i apps/api bygger på) - kun brukt av testkoblingen under. */
const LOCAL_PROVIDERS = new Set(["gemma_local", "local_llm", "ollama", "scripted"]);
const CLOUD = { servingModel: { provider: "anthropic", model: "test" } };
const LOCAL = { servingModel: { provider: "gemma_local", model: "test" } };

function transportWith(centers: ControlCenterDefinition[], options: { servedLocally?: boolean } = { servedLocally: true }): ExecutiveTransport {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
  for (const c of centers) registry.register(c);
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry, ...(options.servedLocally === true ? { servedLocally: (m: { provider: string }) => LOCAL_PROVIDERS.has(m.provider) } : {}) }));
}
type Data = { found: boolean; summary_no: string; explanation_no?: string; report?: ControlCenterReport; center?: string; withheld?: boolean };
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

  it("EXP1 (reviewerens eksperiment): en SKYmodell på en tur der utvalget IKKE valgte verktøyet får «holdt tilbake» fra begge verktøyene - ingen rapport, ingen seksjoner, ingen fakta, ingen id-er", async () => {
    const t = transportWith([money("finance")]);
    for (const [action, params] of [["get_finance_center", {}], ["get_control_center", { center: "finance" }]] as const) {
      const d = await call(t, action, params, CLOUD);
      expect(d, action).toMatchObject({ found: true, withheld: true, center: "finance" });
      expect(d.report, action).toBeUndefined();
      expect(d.summary_no).toContain("SECRET_RESTRICTED");
      expect(d.summary_no).toContain("/control");
      expect(d.explanation_no).toBe(d.summary_no);
      const text = JSON.stringify(d);
      for (const leak of ["amount_ore", "daily_cap_ore", "150000", "state", "settled", "Seksjon", "Rad", "i1", "s1"]) expect(text, `${action}: ${leak}`).not.toContain(leak);
      expect(Object.keys(d).sort(), action).toEqual(["center", "explanation_no", "found", "summary_no", "withheld"]);
    }
  });

  it("UTEN modell i løkka (siden) og med en LOKAL modell får Finans hele rapporten, inkl. beløp i øre (D-378 punkt 2: kun skyen er utestengt) - via begge verktøyene", async () => {
    const t = transportWith([money("finance")]);
    for (const [label, ctx] of [["siden (ingen modell)", {}], ["lokal modell", LOCAL]] as const) {
      for (const [action, params] of [["get_finance_center", {}], ["get_control_center", { center: "finance" }]] as const) {
        const d = await call(t, action, params, ctx);
        expect(d.found, `${label} ${action}`).toBe(true);
        expect(d.withheld, `${label} ${action}`).toBeUndefined();
        expect(factKeys(d.report), `${label} ${action}`).toEqual(expect.arrayContaining(["amount_ore", "daily_cap_ore", "count", "state"]));
      }
    }
  });

  it("FAIL-CLOSED: en ukjent leverandør - og en transport uten `servedLocally` - regnes som sky, selv for en lokal leverandør", async () => {
    const t = transportWith([money("finance")]);
    for (const provider of ["ukjent", "openai", "", "ANTHROPIC"]) {
      expect((await call(t, "get_finance_center", {}, { servingModel: { provider, model: "x" } })).withheld, provider).toBe(true);
    }
    const noLocality = transportWith([money("finance")], { servedLocally: false });
    expect((await call(noLocality, "get_finance_center", {}, LOCAL)).withheld).toBe(true);
    expect(factKeys((await call(noLocality, "get_finance_center")).report)).toContain("amount_ore"); // siden er upåvirket
  });

  it("`servedLocally` som kaster regnes som sky (FAIL-CLOSED)", async () => {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
    registry.register(money("finance"));
    const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const service = new ExecutiveService(fakeGw, { controlCenters: registry, servedLocally: () => { throw new Error("boom"); } });
    expect(service.isCloudServed({ provider: "gemma_local", model: "x" })).toBe(true);
    expect(service.isCloudServed(undefined)).toBe(false);
  });

  it("oversikten til en SKYmodell holder Finans tilbake: ikke bygget, ikke i `centers`, `withheld` satt, samlet status regnes uten den; lokal modell og siden får alle", async () => {
    const memory: ControlCenterDefinition = { ...money("ai"), id: "memory", title_no: "Minne" };
    const t = transportWith([money("finance"), memory]);
    type Overview = { centers: Array<{ center: string }>; unregistered: string[]; withheld?: string[]; summary_no: string };
    const cloud = (await call(t, "get_control_center", {}, CLOUD)) as unknown as Overview;
    expect(cloud.withheld).toEqual(["finance"]);
    expect(cloud.centers.map((c) => c.center)).toEqual(["memory"]);
    expect(cloud.unregistered).not.toContain("finance");
    expect(cloud.summary_no).toContain("Holdt tilbake fra denne modellen");
    expect(JSON.stringify(cloud)).not.toContain("amount_ore");
    for (const ctx of [{}, LOCAL]) {
      const full = (await call(t, "get_control_center", {}, ctx)) as unknown as Overview;
      expect(full.withheld).toBeUndefined();
      expect(full.centers.map((c) => c.center).sort()).toEqual(["finance", "memory"]);
    }
  });

  it("et senter som IKKE er registrert gir fortsatt det ærlige «ikke koblet inn» til en skymodell - aldri en «holdt tilbake»-merknad for noe som ikke finnes", async () => {
    const t = transportWith([]);
    const one = await call(t, "get_control_center", { center: "finance" }, CLOUD);
    expect(one).toEqual({ found: false, center: "finance", summary_no: "Dette kontrollsenteret er ikke koblet inn ennå, så ingenting kan vurderes." });
    expect(((await call(t, "get_control_center", {}, CLOUD)) as unknown as { withheld?: string[] }).withheld).toBeUndefined();
  });

  it("H0-sentrene er uendret: AI-senterets `*_ore`-fakta (grenser og kost) når fortsatt en skymodell - kun senteret i CLOUD_WITHHELD_CENTERS holdes tilbake", async () => {
    const t = transportWith([money("ai")]);
    const keys = factKeys((await call(t, "get_control_center", { center: "ai" }, CLOUD)).report);
    expect(keys).toEqual(expect.arrayContaining(["amount_ore", "daily_cap_ore"]));
    expect(CLOUD_WITHHELD_CENTERS).toEqual(["finance"]);
    expect(isCloudWithheldCenter("finance")).toBe(true);
    for (const id of CONTROL_CENTER_IDS.filter((c) => c !== "finance")) expect(isCloudWithheldCenter(id), id).toBe(false);
  });

  it("`withheldCenterData` har ingen tall og ingen innhold - kun hvorfor og hva eieren kan gjøre; verktøynøkkelen står i EXECUTION_GUARDED_RESTRICTED_KEYS", () => {
    const d = withheldCenterData("finance", "Finans");
    expect(Object.keys(d).sort()).toEqual(["center", "explanation_no", "found", "summary_no", "withheld"]);
    expect(String(d["summary_no"])).toContain("finansdata er SECRET_RESTRICTED (D-378)");
    expect([...EXECUTION_GUARDED_RESTRICTED_KEYS]).toEqual(["executive.get_finance_center"]);
    // hvert senter som holdes tilbake har sitt lese-verktøy i den guardede mengden
    for (const center of CLOUD_WITHHELD_CENTERS) {
      const tool = TOOLS.find((x) => x.center === center);
      expect(tool && EXECUTION_GUARDED_RESTRICTED_KEYS.has(keyOf(tool.action)), center).toBe(true);
    }
  });

  it("transporten uten invocation-context feiler lukket (som alle executive-handlinger)", async () => {
    const t = transportWith([money("finance")]);
    await expect(t.invoke("get_finance_center", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});

describe("gjennomgang L5: `avstemming` er flertydig - kun finanskontekstene velger Finans-senteret (og låser turen lokalt)", () => {
  // Kun senter-verktøyene + minnesøket som kandidater: intensjonen testes isolert (andre finansord som «bank»/«konto» treffer Neonomics-familien og kunne fortrengt senteret innenfor verktøybudsjettet).
  const surface = resolveModelToolSurface(gw, { includeChatReadTier: true }).filter((m) => (m.tool_id === "executive" && TOOLS.some((t) => t.action === m.action)) || (m.tool_id === "memory" && m.action === "search"));
  const picked = (text: string) => selectSurfaceTools("web_chat", text, surface);
  const keys = (text: string) => picked(text).selected.map((m) => `${m.tool_id}.${m.action}`);

  it("kandidatflaten er nøyaktig de tre senter-verktøyene + minnesøket (testen er ikke tom)", () => {
    expect(surface.map((m) => `${m.tool_id}.${m.action}`).sort()).toEqual([...TOOLS.map((t) => keyOf(t.action)), "memory.search"].sort());
  });

  it("finansavstemming velger Finans-senteret: bankavstemming, avstemming av bank/konto/regnskap/betalinger, avstemmingsfunn og avstemmingskjøring", () => {
    for (const msg of ["hvordan går bankavstemmingen", "vis kontoavstemming", "er regnskapsavstemmingen ferdig", "avstemming av bank", "avstemmingen mot regnskapet", "avstemming av betalinger", "hva er avstemmingsfunn", "når var siste avstemmingskjøring", "hva er status på finans"]) {
      expect(keys(msg), msg).toContain(keyOf("get_finance_center"));
      expect(picked(msg).min_sensitivity, msg).toBe("SECRET_RESTRICTED");
    }
  });

  it("«avstemming» i andre betydninger (votering, forventninger, tidsplan) velger IKKE senteret og låser ikke turen - modellen beholder minnesøket", () => {
    for (const msg of ["jeg trenger en avstemming av styret", "avstemmingen blant medlemmene", "vi må ha en avstemming av forventninger", "avstemming mellom teamene", "hvordan går avstemmingen", "vis meg avstemningen fra styremøtet"]) {
      expect(keys(msg), msg).toEqual(["memory.search"]);
      expect(picked(msg).min_sensitivity, msg).toBeUndefined();
    }
  });
});

describe("gjennomgang L5: `financeToolIntent` (den delegerte jobb-veien) følger Finans-senterets intensjon når senteret er på", () => {
  it("uten valg (flaggene AV) er svaret main sitt: senterets ord alene gjør ingenting - jobb-veien er uendret", () => {
    for (const msg of ["vis finanssenteret", "hva er avstemmingsfunn", "er det betalinger med ukjent utfall", "hva sier minnesenteret"]) expect(financeToolIntent(msg), msg).toBe(false);
    expect(financeToolIntent("hva er saldoen på kontoen")).toBe(true); // de eksisterende finansordene (D-381) er uendret
  });

  it("med Finans-verktøyet registrert holder senterets egne ord også en delegert jobb lokal (paritet med chatten, som låser turen lokalt)", () => {
    const options = { restrictedTools: ["executive.get_finance_center"] };
    for (const msg of ["vis finanssenteret", "hva er status på finans", "når var siste avstemmingskjøring", "er det betalinger med ukjent utfall", "lag en rapport om betalingsintensjonene"]) expect(financeToolIntent(msg, options), msg).toBe(true);
    for (const msg of ["jeg trenger en avstemming av styret", "hva sier minnesenteret", "lag en rapport om GitHub-sakene"]) expect(financeToolIntent(msg, options), msg).toBe(false);
  });

  it("kun UTVALGSLÅSTE verktøy teller: et ikke-låst senter-verktøy (Minne) eller et ukjent nøkkelnavn i `restrictedTools` gjør ingenting", () => {
    expect(financeToolIntent("hva sier minnesenteret", { restrictedTools: ["executive.get_memory_center"] })).toBe(false);
    expect(financeToolIntent("vis finanssenteret", { restrictedTools: ["executive.get_does_not_exist"] })).toBe(false);
    expect(financeToolIntent("vis finanssenteret", { restrictedTools: [] })).toBe(false);
  });

  it("apps/api leser valget fra miljøet: Finans-flagget PÅ gir verktøynøkkelen (og kun den), AV gir ingenting - kun den eksakte verdien «on» teller", () => {
    expect(activeRestrictedControlTools({})).toEqual([]);
    expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.finance]: "on" })).toEqual(["executive.get_finance_center"]);
    expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "on" })).toEqual([]);
    for (const value of ["true", "1", "ON", "yes", ""]) expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.finance]: value }), value).toEqual([]);
    expect(financeIntentOptions({})).toEqual({ restrictedTools: [] });
    expect(financeToolIntent("vis finanssenteret", financeIntentOptions({ [CONTROL_CENTER_FLAGS.finance]: "on" }))).toBe(true);
    expect(financeToolIntent("vis finanssenteret", financeIntentOptions({}))).toBe(false);
  });
});

describe("gjennomgang L5: et verktøy for et senter som ikke er registrert finnes ikke (og listes ikke som tilgjengelig i get_capability_status)", () => {
  const owner2 = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
  const capabilityActions = async (centers: ReturnType<typeof controlCentersWithTools>): Promise<string[]> => {
    const list = productionDefinitions(createControlCenterRegistry({ authority: owner2 }), centers);
    const gateway = { list: () => list, health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const service = new ExecutiveService(gateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...CHAT_READ_TIER, ...CHAT_ACT_TIER] });
    const status = await service.getCapabilityStatus();
    return status.chat_accessible_tools.find((t) => t.tool_id === "executive")?.actions ?? [];
  };

  it("`controlCentersWithTools`: flagg PÅ og registrert senter = verktøy; flagg PÅ uten registrering (manglende avhengighet) = ingen verktøy; flagg AV = ingen verktøy", () => {
    const registry = createControlCenterRegistry({ authority: owner2 });
    // Finans krever verktøyregisteret (`toolGateway`) og registreres ikke uten; Minne krever ingenting ekstra.
    registerControlCenters(registry, { pool: {} as never, env: { [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "off" } });
    expect(registry.has("finance")).toBe(false);
    expect(registry.has("memory")).toBe(true);
    expect(controlCentersWithTools({ [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "off" }, registry)).toEqual(["memory"]);
    expect(controlCentersWithTools({}, registry)).toEqual([]);
  });

  it("get_capability_status lister kun verktøy for registrerte sentre: Finans (flagg på, ikke registrert) står IKKE som tilgjengelig, Minne (registrert) gjør det", async () => {
    const registry = createControlCenterRegistry({ authority: owner2 });
    const env = { [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on" };
    registerControlCenters(registry, { pool: {} as never, env });
    const actions = await capabilityActions(controlCentersWithTools(env, registry));
    expect(actions).toContain("get_memory_center");
    expect(actions).not.toContain("get_finance_center");
    expect(actions).not.toContain("get_agent_center");
    expect(await capabilityActions([])).toEqual(expect.not.arrayContaining(["get_memory_center", "get_finance_center", "get_agent_center"]));
  });
});

describe("gjennomgang L5: `safeRef` - id-er fra databasen går gjennom samme filter som kategorinavn, med unik reserve", () => {
  it("egne id-er (bank-co-<uuid>, fin-rec-<uuid>) passerer uendret", () => {
    for (const id of ["bank-co-3f2b8a52-6b4e-4c5a-9d21-0a1b2c3d4e5f", "fin-rec-3f2b8a52-6b4e-4c5a-9d21-0a1b2c3d4e5f", "bc-a-active", "run_1.2:3"]) expect(safeRef(id, "ukjent-1"), id).toBe(id);
  });

  it("tegn utenfor tillatt sett, lengde over 60, tokenlignende løper (24+ bokstaver/tall), tomt og ikke-tekst gir reserveverdien - aldri «annet», aldri verdien selv", () => {
    for (const bad of ["med mellomrom", "<script>x</script>", "x".repeat(61), "q".repeat(24), `bank-co-${"a".repeat(30)}`, "", null, undefined, 42, { a: 1 }]) {
      expect(safeRef(bad, "ukjent-7"), String(bad)).toBe("ukjent-7");
    }
    expect(safeRef("annet", "ukjent-2")).toBe("ukjent-2");
  });
});
