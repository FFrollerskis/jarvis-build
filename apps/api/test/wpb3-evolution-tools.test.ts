import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CLOUD_WITHHELD_CENTERS, CONTROL_CENTER_IDS, CONTROL_CENTER_READ_TOOLS, EXECUTION_GUARDED_RESTRICTED_KEYS, ExecutiveService, ExecutiveTransport, controlCenterForReadAction, executiveToolDefinitions,
  isCloudWithheldCenter, withheldCenterData, type ControlCenterId
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { EXTERNAL_GATES, evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import {
  CHAT_READ_TIER, KnowledgeSearchTransport, MemorySearchTransport, OPTIONAL_TIER_KEYS, buildToolManifest, chatReadTierMeshTools, financeToolIntent, firstWaveTools, homeAssistantTools, isSelectionLockedTool,
  knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, selectSurfaceTools, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createEvolutionCenter } from "../src/control-center/evolution.ts";
import { CONTROL_CENTER_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { activeRestrictedControlTools, controlCentersWithTools, enabledControlCenters, financeIntentOptions } from "../src/control-center/shared.ts";
import { RunRateTransport, runRateToolDefinitions, type RunRateReport } from "../src/run-rate.ts";
import { ScriptedPool } from "./support/scripted-pool.ts";

/**
 * WP-B3 (D-475, EV-22) verktøylaget for Evolusjon-senteret (`executive.get_evolution_center`):
 *  1. FLAGG AV = main: verktøyet finnes ikke, `get_control_center` har samme skjema/beskrivelse/rate-grense som main, og utvalget over hele produksjonsflaten er uendret;
 *  2. FLAGG PÅ: kun dette ene verktøyet kommer til, med eier + signert-økt-port, klasse A, `restricted`, utvalgslåst lokalt og IKKE på tale;
 *  3. KOSTNAD I ØRE (strengeste regel, Q-64): en SKYmodell får aldri senteret (holdt tilbake VED UTFØRELSE - også via `get_control_center` og oversikten, også for en ukjent leverandør); lokal modell og siden får alt;
 *  4. UTVALG: smalt, kun evolusjonssenter-/endringsregister-/kostmodell-ord - hverdagsord og «hvordan utvikler du deg» velger det ikke og låser ikke turen.
 */
const EVOLUTION_ACTION = "get_evolution_center";
const KEY = `executive.${EVOLUTION_ACTION}`;
const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const CLOUD = { provider: "anthropic", model: "claude-sonnet-4" };
const LOCAL = { provider: "gemma_local", model: "gemma" };
/** Tall som aldri skal nå en skymodell: bygget så de er lette å søke etter. */
const SPENT = 987_654;
const PROJECTED = 876_543;

const keyOf = (m: { tool_id: string; action: string }): string => `${m.tool_id}.${m.action}`;
const defsFor = (centers: ReadonlyArray<ControlCenterId>, extra: Parameters<typeof executiveToolDefinitions>[1] = {}): ToolDefinition[] =>
  executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), { controlCenters: centers, ...extra });
const executiveOnly = (defs: ToolDefinition[]): ToolDefinition[] => defs.filter((d) => d.tool_id === "executive");
/** JSON-skjemaet MODELLEN faktisk ser for `get_control_center` (samme omforming som chatflaten bruker): `center` er en enum av de gyldige id-ene. */
const asJson = (def: ToolDefinition | undefined): { properties: { center: { enum: string[] } } } => {
  if (!def) throw new Error("verktøyet finnes ikke");
  const mapping = chatReadTierMeshTools([def], CHAT_READ_TIER, "read").find((m) => keyOf(m) === "executive.get_control_center");
  if (!mapping) throw new Error("get_control_center står ikke på chat-lese-nivået");
  return mapping.def.input_schema as never;
};

function runRate(): RunRateReport {
  return {
    as_of: NOW.toISOString(), totals: { today_ore: 765_432, last_7d_ore: 654_321, last_30d_ore: 543_210, projected_month_ore: PROJECTED }, cloud_share_30d: 0.5, by_provider: [], by_purpose: [],
    daily: [], maintenance: { minutes_30d: 0, by_connector: [], recent: [] }, value_loop: { brief_days_30d: 1 }, not_measured: ["STT/TTS-kostnad (stemme) er ikke registrert i cost_events"], summary_no: "x"
  };
}
const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>(EXTERNAL_GATES.slice(0, 1)) };

/** Et ekte Evolusjon-senter (ikke en probe) bak det ekte registeret og ExecutiveService - med kostnad i øre (`SPENT`, `PROJECTED`) i kildene. */
function liveTransport(options: { register?: boolean; servedLocally?: (m: { provider: string; model: string }) => boolean } = {}): ExecutiveTransport {
  const pool = new ScriptedPool([{ match: /date_trunc\('month', now\(\)\)/, rows: [{ spent: SPENT }] }]);
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] }, now: () => NOW });
  if (options.register !== false) {
    registry.register(createEvolutionCenter({
      pool: pool.asPool(), env: {}, evolutionReport: async () => ({ as_of: NOW.toISOString(), sections: [{ ev: "EV-3", title_no: "Radar", mode: "observe", status: "OK", summary_no: "ok", findings: [], source: "x", observed_at: NOW.toISOString() }] }),
      readiness: async () => evaluateAllReadiness(FACTS), runRate: { report: async () => runRate() }, reportTenantId: "tenant-owner"
    }));
  }
  return new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry, servedLocally: options.servedLocally ?? ((m) => m.provider === "gemma_local") }));
}
type Out = { found?: boolean; withheld?: boolean; center?: string; summary_no?: string; report?: { sections: Array<{ id: string }> }; centers?: Array<{ center: string }>; withheld_list?: string[]; unregistered?: string[] };
async function call(t: ExecutiveTransport, action: string, parameters: Record<string, string> = {}, servingModel?: { provider: string; model: string }): Promise<Out> {
  return (await t.invoke(action, parameters, "cred", { identity: owner, ...(servingModel ? { servingModel } : {}) } as never)).data as unknown as Out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Tabellen og flagg AV = main
// ---------------------------------------------------------------------------------------------------------------------
describe("1. tabellen og flagg AV: verktøyet og skjemaet finnes ikke, og `get_control_center` er uendret fra main", () => {
  it("tabellen har Evolusjon sist (de syv første er uendret), knyttet til tilleggssenteret, og beskrivelsen sier kostmodell, skymodell-regelen og kun lesing", () => {
    const row = CONTROL_CENTER_READ_TOOLS[CONTROL_CENTER_READ_TOOLS.length - 1];
    expect(row).toMatchObject({ center: "evolution", action: EVOLUTION_ACTION });
    expect(controlCenterForReadAction(EVOLUTION_ACTION)).toBe("evolution");
    expect(row?.description).toContain("kostmodellen");
    expect(row?.description).toContain("SECRET_RESTRICTED");
    expect(row?.description).toContain("skymodell får IKKE rapporten");
    expect(row?.description).toContain("KUN lesing");
    expect(row?.description).toContain("ingenting aktiveres");
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(t.action).toBe(`get_${t.center}_center`);
  });

  it("uten flagg (ingen `controlCenters`): ingen `get_evolution_center`; `get_control_center` har de ti id-ene, main sin beskrivelse (ingen tilleggssenter nevnt) og rate-grensen 30", () => {
    const defs = executiveOnly(defsFor([]));
    expect(defs.find((d) => d.action === EVOLUTION_ACTION)).toBeUndefined();
    const gcc = defs.find((d) => d.action === "get_control_center") as ToolDefinition;
    expect(asJson(gcc).properties.center.enum).toEqual([...CONTROL_CENTER_IDS]);
    expect(gcc.description).not.toMatch(/tilleggssenter|evolusjon/i);
    expect(gcc.rate_limit_per_minute).toBe(30);
    // `center: "evolution"` er ikke et gyldig valg uten flagg (skjemaet avviser det, som et hvilket som helst ukjent navn)
    const parse = (center: unknown): boolean => gcc.input_schema.safeParse({ center }).success;
    expect(parse("evolution")).toBe(false);
    expect(parse("security")).toBe(true);
    expect(parse(undefined)).toBe(true);
  });

  it("et annet senters flagg (f.eks. Drift) endrer verken verktøy eller skjema for Evolusjon: skjemaet får `evolution` KUN når Evolusjon-verktøyet er registrert", () => {
    const withOps = executiveOnly(defsFor(["operations"]));
    expect(withOps.find((d) => d.action === EVOLUTION_ACTION)).toBeUndefined();
    const gccOps = withOps.find((d) => d.action === "get_control_center") as ToolDefinition;
    expect(asJson(gccOps).properties.center.enum).toEqual([...CONTROL_CENTER_IDS]);
    expect(gccOps.description).not.toMatch(/tilleggssenter/i);
    expect(gccOps.rate_limit_per_minute).toBe(120);
  });

  it("med Evolusjon-flagget: nøyaktig ÉN ny handling, `evolution` er et gyldig `center`-valg, beskrivelsen nevner tilleggssenteret, og rate-grensen er 120", () => {
    const base = executiveOnly(defsFor([])).map((d) => d.action);
    const on = executiveOnly(defsFor(["evolution"]));
    expect(on.map((d) => d.action).filter((a) => !base.includes(a))).toEqual([EVOLUTION_ACTION]);
    const gcc = on.find((d) => d.action === "get_control_center") as ToolDefinition;
    expect(asJson(gcc).properties.center.enum).toEqual([...CONTROL_CENTER_IDS, "evolution"]);
    expect(gcc.description).toContain("Tilleggssenter (kun når slått på): evolusjon.");
    expect(gcc.rate_limit_per_minute).toBe(120);
    const parse = (center: unknown): boolean => gcc.input_schema.safeParse({ center }).success;
    expect(parse("evolution")).toBe(true);
    expect(parse("evolusjon")).toBe(false);
  });

  it("verktøyet er klasse A, har ingen parametre (ingen identitetsfelt), og har en EGEN fail-closed port (eier + signert økt) - også uten register", () => {
    const def = executiveOnly(defsFor(["evolution"])).find((d) => d.action === EVOLUTION_ACTION) as ToolDefinition;
    expect(def.capability_class).toBe("A");
    expect(def.scopes).toEqual(["executive.read"]);
    expect(def.output_trust).toBe("internal");
    expect(def.rate_limit_per_minute).toBe(30);
    expect(Object.keys((def.input_schema as unknown as { shape: Record<string, unknown> }).shape)).toEqual([]);
    expect(typeof def.parameterAuthorizer).toBe("function");
    // uten register (eier-predikatet mangler) slipper porten INGEN gjennom
    expect(def.parameterAuthorizer?.({}, owner)).toMatchObject({ allowed: false, reason: "control_center_owner_check_not_configured" });
  });

  it("flaggene: `enabledControlCenters`/`controlCentersWithTools`/`activeRestrictedControlTools` kjenner Evolusjon KUN når flagget er eksakt «on» og senteret er registrert", () => {
    expect(enabledControlCenters({})).toEqual([]);
    expect(enabledControlCenters({ [CONTROL_CENTER_FLAGS.evolution]: "true" })).toEqual([]);
    expect(enabledControlCenters({ [CONTROL_CENTER_FLAGS.evolution]: "on" })).toEqual(["evolution"]);
    expect(activeRestrictedControlTools({})).toEqual([]);
    expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.evolution]: "on" })).toEqual([KEY]);
    expect(financeIntentOptions({})).toEqual({ restrictedTools: [] });
    const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
    expect(controlCentersWithTools({ [CONTROL_CENTER_FLAGS.evolution]: "on" }, registry)).toEqual([]);
    registerControlCenters(registry, { pool: new ScriptedPool([]).asPool(), env: { [CONTROL_CENTER_FLAGS.evolution]: "on" }, evolutionReport: async () => ({ sections: [] }) });
    expect(controlCentersWithTools({ [CONTROL_CENTER_FLAGS.evolution]: "on" }, registry)).toEqual(["evolution"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Manifest, flater og utvalg
// ---------------------------------------------------------------------------------------------------------------------
function surfaceFor(centers: ReadonlyArray<ControlCenterId>) {
  const defs = firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...defsFor(centers),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
  return { defs, surface: resolveModelToolSurface({ list: () => defs } as unknown as ToolGateway, { includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true }) };
}
interface SelectionOut { selected: string[]; dropped_count: number; dropped_sha256: string; schema_tokens: number; min_sensitivity: string | null }
interface Baseline { surface_keys: string[]; cases: Array<{ text: string; recent?: string[]; web_chat: SelectionOut; voice: SelectionOut }> }
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/wph1-main-selection-baseline.json", import.meta.url)), "utf8")) as Baseline;

describe("2. manifest, flater og utvalg", () => {
  const { defs, surface: on } = surfaceFor(["evolution"]);
  const { surface: off } = surfaceFor([]);

  it("manifestet: effekt read, sensitivitet `restricted`, klasse A - utvalgslåst lokalt og står på web-chatten, men ALDRI på tale", () => {
    const manifest = buildToolManifest(defs);
    const entry = manifest.get(KEY);
    expect(entry).toBeDefined();
    expect(entry?.effect).toBe("read");
    expect(entry?.sensitivity).toBe("restricted");
    expect(entry?.risk).toBe("A");
    expect(entry?.owner).toBe("jarvis_core");
    expect(entry?.output_trust).toBe("internal");
    expect(entry?.scope_fields).toEqual([]);
    expect(entry?.surfaces).toContain("web_chat");
    expect(entry?.surfaces).not.toContain("voice");
    expect(isSelectionLockedTool("executive", EVOLUTION_ACTION)).toBe(true);
    expect(OPTIONAL_TIER_KEYS.has(KEY)).toBe(true);
    expect(EXECUTION_GUARDED_RESTRICTED_KEYS.has(KEY)).toBe(true);
    expect(CLOUD_WITHHELD_CENTERS).toContain("evolution");
  });

  it("flaten uten flagg har IKKE verktøyet; med flagget kommer nøyaktig dette ene til (og kandidatflaten uten flagg er main sin)", () => {
    expect(off.map(keyOf)).not.toContain(KEY);
    expect(off.map(keyOf).sort()).toEqual(baseline.surface_keys);
    expect(on.map(keyOf).filter((k) => !off.map(keyOf).includes(k))).toEqual([KEY]);
  });

  const POSITIVE = ["vis evolusjonssenteret", "hva sier evolusjonssenteret", "evolusjons-senter status", "vis endringsregisteret", "hva sier kostmodellen", "hvilke sovende deler finnes", "vis evolusjonsberedskap", "godkjenn evolusjonsforslag", "evolusjonskontroll"];
  it("SMALT utvalg: de eksplisitte frasene velger Evolusjon-senteret og låser turen lokalt (SECRET_RESTRICTED); med flagget AV velges det aldri", () => {
    for (const text of POSITIVE) {
      const sel = selectSurfaceTools("web_chat", text, on);
      expect(sel.selected.map(keyOf), text).toContain(KEY);
      expect(sel.min_sensitivity, text).toBe("SECRET_RESTRICTED");
      expect(selectSurfaceTools("web_chat", text, off).selected.map(keyOf), `${text} (flagg av)`).not.toContain(KEY);
      // tale får aldri kontrollsentrene (L-4): verktøyet er ikke på talekandidatene
      expect(selectSurfaceTools("voice", text, on).selected.map(keyOf), `${text} (tale)`).not.toContain(KEY);
    }
  });

  it("hverdagsord og de eksisterende evolusjonsfrasene velger IKKE senteret og låser ikke turen: «hvordan utvikler du deg», «evolusjon», «endringsforslag i kontrakten», biologi, kostholdsmodell …", () => {
    for (const text of ["hvordan utvikler du deg", "evolusjon", "hva har du lært", "evolusjonsrapport", "jeg har et endringsforslag til kontrakten", "hva sier Darwin om evolusjon i biologi", "jeg vil ha en ny kostholdsplan", "hva er min kostnad i dag", "vis verdisenteret", "vis sikkerhetssenteret", "hva er status på driften"]) {
      const sel = selectSurfaceTools("web_chat", text, on);
      expect(sel.selected.map(keyOf), text).not.toContain(KEY);
    }
    // «vis verdisenteret» låser fortsatt lokalt (Verdi), men av sin EGEN grunn - Evolusjon er ikke med
    expect(selectSurfaceTools("web_chat", "vis sikkerhetssenteret", on).min_sensitivity).toBeUndefined();
  });

  it("med KUN Evolusjon-flagget på er utvalget for ALLE baselinefraser (begge flater) identisk med ren main: samme verktøy i samme rekkefølge og samme sensitivitetslås - ingen frase endrer seg", () => {
    const diffs: string[] = [];
    const tokenDeltas = new Set<number>();
    for (const c of baseline.cases) {
      for (const surface of ["web_chat", "voice"] as const) {
        const sel = selectSurfaceTools(surface, c.text, on, c.recent ? { recent_owner_messages: c.recent } : {});
        const want = c[surface];
        if (JSON.stringify(sel.selected.map(keyOf)) !== JSON.stringify(want.selected) || (sel.min_sensitivity ?? null) !== want.min_sensitivity) diffs.push(`${surface}: «${c.text}»`);
        // Verktøyet er ett kandidatnavn til på web-chatten (valgt bort her): ett droppet navn mer, aldri flere. Tale har det ikke.
        expect(sel.dropped.length - want.dropped_count, `${surface}: «${c.text}» droppede`).toBe(surface === "web_chat" ? 1 : 0);
        // Skjematokens: `get_control_center` får `evolution` i enumen og en setning i beskrivelsen når senteret er på (en liten, tilsiktet økning kun for fraser som velger akkurat det verktøyet).
        const delta = sel.schema_tokens - want.schema_tokens;
        if (delta !== 0) {
          tokenDeltas.add(delta);
          expect(sel.selected.map(keyOf), `${surface}: «${c.text}» tokens`).toContain("executive.get_control_center");
          expect(delta, `${surface}: «${c.text}»`).toBeGreaterThan(0);
          expect(delta, `${surface}: «${c.text}»`).toBeLessThanOrEqual(25);
        }
      }
    }
    expect(baseline.cases.length).toBeGreaterThanOrEqual(95);
    expect(diffs).toEqual([]);
    // ÉN konstant økning (samme verktøy, samme tillegg) - ikke tilfeldig støy
    expect(tokenDeltas.size).toBeLessThanOrEqual(1);
  });

  it("uten noe flagg er utvalget (inkl. skjematokens og antall droppede) bit-for-bit lik main for ALLE baselinefraser på begge flater", () => {
    for (const c of baseline.cases) {
      for (const surface of ["web_chat", "voice"] as const) {
        const sel = selectSurfaceTools(surface, c.text, off, c.recent ? { recent_owner_messages: c.recent } : {});
        const want = c[surface];
        expect({ selected: sel.selected.map(keyOf), dropped_count: sel.dropped.length, schema_tokens: sel.schema_tokens, min_sensitivity: sel.min_sensitivity ?? null }, `${surface}: «${c.text}»`)
          .toEqual({ selected: want.selected, dropped_count: want.dropped_count, schema_tokens: want.schema_tokens, min_sensitivity: want.min_sensitivity });
      }
    }
  });

  it("en DELEGERT jobb: `financeToolIntent` holder en jobb med Evolusjon-ord lokal KUN når senteret er på (`restrictedTools`); med flagget AV er svaret nøyaktig som på main", () => {
    expect(financeToolIntent("vis evolusjonssenteret")).toBe(false);
    expect(financeToolIntent("vis evolusjonssenteret", financeIntentOptions({}))).toBe(false);
    expect(financeToolIntent("vis evolusjonssenteret", financeIntentOptions({ [CONTROL_CENTER_FLAGS.evolution]: "on" }))).toBe(true);
    expect(financeToolIntent("hvordan utvikler du deg", financeIntentOptions({ [CONTROL_CENTER_FLAGS.evolution]: "on" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Kostnad i øre: holdt tilbake fra skymodeller VED UTFØRELSE
// ---------------------------------------------------------------------------------------------------------------------
describe("3. kostnad i øre (strengeste regel, Q-64): en skymodell får ALDRI Evolusjon-senteret - lokal modell og siden får alt", () => {
  const SECRET_NUMBERS = [String(SPENT), String(PROJECTED), "765432", "654321", "543210"];

  it("skymodell: `get_evolution_center` gir kun «holdt tilbake»-merknaden (ingen seksjoner, ingen tall), og senteret BYGGES ikke engang", async () => {
    const out = await call(liveTransport(), EVOLUTION_ACTION, {}, CLOUD);
    expect(out.withheld).toBe(true);
    expect(out.found).toBe(true);
    expect(out.center).toBe("evolution");
    expect(out.report).toBeUndefined();
    expect(out.summary_no).toContain("Evolusjon-kontrollsenteret holdes tilbake fra denne modellen");
    expect(out.summary_no).toContain("kostmodellen (EV-16)");
    expect(out.summary_no).toContain("SECRET_RESTRICTED, D-378");
    expect(Object.keys(out).sort()).toEqual(["center", "explanation_no", "found", "summary_no", "withheld"]);
    for (const n of SECRET_NUMBERS) expect(JSON.stringify(out), n).not.toContain(n);
  });

  it("også via `get_control_center {center: \"evolution\"}` (verktøyet er ikke valgt av utvalget): en skymodell får merknaden, ikke rapporten", async () => {
    const out = await call(liveTransport(), "get_control_center", { center: "evolution" }, CLOUD);
    expect(out.withheld).toBe(true);
    expect(out.report).toBeUndefined();
    for (const n of SECRET_NUMBERS) expect(JSON.stringify(out), n).not.toContain(n);
  });

  it("oversikten (`get_control_center` uten senter) bygges for en skymodell UTEN Evolusjon: den står i `withheld`, ikke i `centers`, teller ikke i status og røper ingen tall", async () => {
    const out = (await call(liveTransport(), "get_control_center", {}, CLOUD)) as unknown as { withheld?: string[]; centers: Array<{ center: string }>; summary_no: string; unregistered: string[] };
    expect(out.withheld).toEqual(["evolution"]);
    expect(out.centers.map((c) => c.center)).not.toContain("evolution");
    expect(out.unregistered).not.toContain("evolution");
    expect(out.summary_no).toContain("Holdt tilbake fra denne modellen (SECRET_RESTRICTED, D-378): Evolusjon.");
    expect(out.summary_no).toContain("pluss 1 tilleggssenter: Evolusjon");
    for (const n of SECRET_NUMBERS) expect(JSON.stringify(out), n).not.toContain(n);
  });

  it("ukjent leverandør, en `servedLocally` som kaster og en tjeneste uten `servedLocally` regnes som SKY (fail-closed)", async () => {
    for (const servedLocally of [() => { throw new Error("kaster"); }, undefined]) {
      const t = liveTransport({ ...(servedLocally ? { servedLocally } : {}) });
      const out = await call(t, EVOLUTION_ACTION, {}, { provider: "ukjent_leverandor", model: "m" });
      expect(out.withheld, String(servedLocally)).toBe(true);
    }
    const noLocal = new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: (() => { const r = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } }); r.register(createEvolutionCenter({ pool: new ScriptedPool([]).asPool(), env: {}, evolutionReport: async () => ({ sections: [] }) })); return r; })() }));
    expect((await call(noLocal, EVOLUTION_ACTION, {}, LOCAL)).withheld).toBe(true);
  });

  it("LOKAL modell og siden (ingen modell i løkka) får hele rapporten - inkl. kostmodellen med øre i måledata", async () => {
    const t = liveTransport();
    for (const [label, model] of [["lokal modell", LOCAL], ["siden", undefined]] as const) {
      const out = await call(t, EVOLUTION_ACTION, {}, model);
      expect(out.withheld, label).toBeUndefined();
      expect(out.report?.sections.map((s) => s.id), label).toEqual(["ports", "dormant", "ledger", "cost_model"]);
      expect(JSON.stringify(out), label).toContain(String(SPENT));
      expect(JSON.stringify(out), label).toContain(String(PROJECTED));
    }
    // samme innhold via get_control_center {center}
    const viaGcc = await call(t, "get_control_center", { center: "evolution" });
    expect(viaGcc.report?.sections).toHaveLength(4);
  });

  it("et senter som IKKE er registrert (flagg AV) gir det ærlige «ikke koblet inn» også til en skymodell - aldri en «holdt tilbake»-merknad for noe som ikke finnes", async () => {
    const t = liveTransport({ register: false });
    expect(await call(t, "get_control_center", { center: "evolution" }, CLOUD)).toEqual({ found: false, center: "evolution", summary_no: "Dette kontrollsenteret er ikke koblet inn ennå, så ingenting kan vurderes." });
    expect(await call(t, EVOLUTION_ACTION, {}, CLOUD)).toEqual({ found: false, center: "evolution", summary_no: "Dette kontrollsenteret er ikke koblet inn ennå, så ingenting kan vurderes." });
    expect(((await call(t, "get_control_center", {}, CLOUD)) as unknown as { withheld?: unknown }).withheld).toBeUndefined();
  });

  it("`withheldCenterData` for Evolusjon har ingen tall og ingen innhold; Evolusjon er holdt tilbake som Verdi og Finans, og ingen av masterplanens øvrige sentre er det", () => {
    const d = withheldCenterData("evolution", "Evolusjon");
    expect(Object.keys(d).sort()).toEqual(["center", "explanation_no", "found", "summary_no", "withheld"]);
    expect(String(d["summary_no"])).toContain("Q-64");
    expect(isCloudWithheldCenter("evolution")).toBe(true);
    for (const id of CONTROL_CENTER_IDS.filter((c) => c !== "finance" && c !== "value")) expect(isCloudWithheldCenter(id), id).toBe(false);
  });

  it("kontroll: de andre sentrene påvirkes ikke - Verdi og Finans holdes fortsatt tilbake, og et senter som ikke er et tilleggssenter har sitt eget verktøy uendret", () => {
    expect([...CLOUD_WITHHELD_CENTERS]).toEqual(["finance", "value", "evolution"]);
    expect([...EXECUTION_GUARDED_RESTRICTED_KEYS].sort()).toEqual(["executive.get_evolution_center", "executive.get_finance_center", "executive.get_value_center"]);
  });
});
