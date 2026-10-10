import { describe, expect, it } from "vitest";
import {
  CHAT_READ_TIER,
  chatReadTierMeshTools,
  firstWaveTools,
  homeAssistantTools,
  selectSurfaceTools,
  type MeshToolMapping
} from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M1): AI Mesh-spørsmål («er Kimi oppe?») skal velge executive-verktøyene, men de nakne ordene `kimi`, `hermes`, `fallback` og `hvilke modeller` skal IKKE - de traff vanlig prat
 * («Jeg møtte Kimi i går …»), utvalget valgte da `executive.*`, turen var ikke lenger «kun minne-reserve» og D-431 sendte den til skymodellen. Utvalget testes her over den ekte `selectSurfaceTools`; at ruten faktisk forblir lokal
 * testes mot samtalemotoren i `apps/api/test/wpd4-ai-mesh-intent-route.test.ts`.
 */
const stub = (tool_id: string, action: string, kind: "read" | "act" = "read"): MeshToolMapping => ({
  def: { name: `${tool_id}__${action}`, description: `${tool_id}.${action}`, input_schema: { type: "object", properties: {}, additionalProperties: false } },
  tool_id,
  action,
  kind
});
// Verktøyene executive/memory/tasks/run_rate registreres i api-prosessen (ikke i `firstWaveTools`): her som skall med riktige id-er, så utvalget får sin ekte kandidatliste.
const defs = firstWaveTools({}, { additionalTools: homeAssistantTools({ invoke: async () => ({}) } as never) });
const surface: MeshToolMapping[] = [
  stub("memory", "search"),
  ...CHAT_READ_TIER.filter((g) => g.tool_id === "executive" || g.tool_id === "run_rate").map((g) => stub(g.tool_id, g.action)),
  stub("tasks", "delegate_background_task"),
  ...chatReadTierMeshTools(defs, CHAT_READ_TIER, "read")
];
const idsFor = (text: string): Set<string> => new Set(selectSurfaceTools("web_chat", text, surface).selected.map((m) => m.tool_id));

describe("M1: nakne navn og ord velger ikke executive", () => {
  // De fire fra gjennomgangen + 12 til. Ingen av dem har ord som velger noe annet verktøy, så utvalget skal bare være minne-reserven.
  const ORDINARY: string[] = [
    "Jeg møtte Kimi i går og vi spiste middag",
    "Hermes er en fin lommebok-merkevare",
    "Hva er en fallback i JavaScript?",
    "hvilke modeller av bil bør jeg kjøpe",
    "hva er en fallback-plan for ferien",
    "Kimi har bursdag på lørdag, hva kan jeg gi henne?",
    "Hermes-vesken til mamma er av skinn",
    "hvilke modeller finnes det av Volvo XC60?",
    "Hva betyr fallback på norsk?",
    "hvilken modell er best til å bygge modellfly?",
    "Kjenner du Hermes, den greske guden?",
    "Fallback-planen for turen er at vi tar bussen hvis det regner",
    "Kimi og jeg gikk en lang tur i skogen",
    "Hva er forskjellen på en fallback og en default i programmering?",
    "Er Hermes en gud eller en helt?",
    "Har du møtt Kimi før?"
  ];

  it.each(ORDINARY)("«%s» → ikke executive, kun minne-reserven", (text) => {
    const selected = selectSurfaceTools("web_chat", text, surface).selected;
    expect(selected.map((m) => m.tool_id), text).not.toContain("executive");
    // Kun minne-reserven: det er dette `isMemoryReserveOnly` bruker for å holde turen lokal (D-431).
    expect([...new Set(selected.map((m) => m.tool_id))], text).toEqual(["memory"]);
  });

  it("holder minst 14 forskjellige setninger (de fire fra gjennomgangen + 10 til)", () => {
    expect(new Set(ORDINARY).size).toBeGreaterThanOrEqual(14);
  });
});

describe("M1: legitime AI Mesh-spørsmål velger fortsatt executive", () => {
  const LEGIT: string[] = [
    "hvordan står AI-mesh-en?",
    "er Kimi oppe?",
    "hvilke leverandører er konfigurert?",
    "hvilken modell er reserve?",
    "Er Hermes nede?",
    "Kimi er nede, ikke sant?",
    "hva er status på modellene dine?",
    "hvilke modeller bruker du?",
    "hva er fallback-kjeden?",
    "fungerer Kimi?",
    "hvordan går det med Hermes-modellen?",
    "viser du modellstatus?",
    "hva er reservemodellen din?",
    "hvilken modell snakker jeg med?",
    "hvordan er modellkjeden satt opp?",
    "hvilke ai-modeller har du?",
    "AI mesh status",
    "hvilke leverandører er oppe akkurat nå?",
    "er kimi-nøkkelen satt?",
    "Kimi k3 eller Hermes - hvem svarer?"
  ];

  it.each(LEGIT)("«%s» → executive er med", (text) => {
    expect(idsFor(text).has("executive"), text).toBe(true);
    expect(selectSurfaceTools("web_chat", text, surface).selected.map((m) => `${m.tool_id}.${m.action}`), text).toContain("executive.get_ai_mesh_status");
  });

  it("de eksisterende selvdiagnose-ordene er uendret (de er ikke rørt)", () => {
    for (const text of ["hva er galt med deg?", "er du treg i dag?", "hva har du lært?", "ytelse og tjenestemål", "er alt ok med deg"]) {
      expect(idsFor(text).has("executive"), text).toBe(true);
    }
  });

  it("småprat får fortsatt ingen verktøy (D-415/D-424 går foran)", () => {
    expect(selectSurfaceTools("web_chat", "hei", surface).selected).toEqual([]);
  });
});
