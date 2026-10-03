import { describe, expect, it } from "vitest";
import {
  SURFACES,
  SURFACE_LIMITS,
  SURFACE_TOOL_GRANTS,
  allMeshTools,
  createTurnContext,
  curatedReadOnlyMeshTools,
  estimateSchemaTokens,
  firstWaveTools,
  selectSurfaceTools,
  surfaceForChannel,
  type ToolGateway
} from "../src/index.ts";

/** Del 3 (JARVIS-028/002): deterministisk per-flate utvalg, hard allowlist etter utvalg, og målte skjema-tokens med regresjonsterskel. */
const mappings = curatedReadOnlyMeshTools();
const keyOf = (m: { tool_id: string; action: string }) => `${m.tool_id}.${m.action}`;

describe("utvalg per intensjon", () => {
  it("kun relevante verktøy velges; uten treff velges bare memory.search", () => {
    expect(selectSurfaceTools("web_chat", "Hva står i kalenderen i dag?", mappings).selected.map(keyOf)).toEqual(["calendar.read_events"]);
    expect(selectSurfaceTools("web_chat", "har jeg fått noen e-poster?", mappings).selected.map(keyOf)).toEqual(["email.read_inbox"]);
    expect(selectSurfaceTools("web_chat", "snakk om været", mappings).selected.map(keyOf)).toEqual(["memory.search"]);
  });
  it("oversikts-spørsmål gir lese-verktøyene, men ikke hele settet", () => {
    const sel = selectSurfaceTools("web_chat", "gi meg en oversikt over hva som skjer", mappings).selected.map(keyOf);
    expect(sel).toEqual(expect.arrayContaining(["email.read_inbox", "calendar.read_events", "github.read_issues"]));
    expect(sel).not.toContain("memory.propose");
  });
  it("memory.propose velges kun på web_chat og kun ved eksplisitt «husk»-intensjon", () => {
    expect(selectSurfaceTools("web_chat", "husk at jeg liker kaffe", mappings).selected.map(keyOf)).toContain("memory.propose");
    for (const s of ["voice", "telegram", "background"] as const) {
      expect(selectSurfaceTools(s, "husk at jeg liker kaffe", mappings).selected.map(keyOf)).not.toContain("memory.propose");
    }
  });
});

describe("hard allowlist per flate", () => {
  it("ingen flate kan noensinne få et verktøy utenfor sin tildeling - selv om kandidatlisten inneholder ALT i registeret", () => {
    const registry = firstWaveTools({});
    const everything = allMeshTools({ list: () => registry } as unknown as ToolGateway);
    expect(everything.length).toBeGreaterThan(300);
    for (const surface of SURFACES) {
      const granted = new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`));
      for (const text of ["send e-post til noen", "slett alt", "betal faktura", "kalender i dag", "oversikt", "husk dette", "kill switch", "github issue"]) {
        const sel = selectSurfaceTools(surface, text, everything);
        for (const m of sel.selected) expect(granted.has(keyOf(m)), `${surface}/${text}: ${keyOf(m)}`).toBe(true);
        expect(sel.selected.length).toBeLessThanOrEqual(SURFACE_LIMITS[surface].max_tools_per_round);
        expect(sel.schema_tokens).toBeLessThanOrEqual(SURFACE_LIMITS[surface].max_schema_tokens);
      }
    }
  });
  it("coding har ingen gateway-verktøy", () => {
    expect(selectSurfaceTools("coding", "kjør tester", mappings).selected).toEqual([]);
  });
});

describe("skjema-tokens: målt og med regresjonsterskel (JARVIS-028)", () => {
  it("hele registeret ville kostet tusenvis av tokens per runde; dagens flater er under en liten, fast terskel", () => {
    const registry = firstWaveTools({});
    const everything = allMeshTools({ list: () => registry } as unknown as ToolGateway);
    const fullRegistryTokens = estimateSchemaTokens(everything.map((m) => m.def));
    const currentSurfaceTokens = estimateSchemaTokens(mappings.map((m) => m.def));
    // Dokumentert måling (se PHASE_3_GATE): fullt register er > 20x flaten modellen faktisk får.
    expect(fullRegistryTokens).toBeGreaterThan(currentSurfaceTokens * 20);
    // Regresjonsterskler: en utvidelse av modellflaten som sprenger disse er en bevisst beslutning (oppdater terskel + ledger).
    expect(currentSurfaceTokens).toBeLessThanOrEqual(900);
    for (const surface of SURFACES) {
      const worst = selectSurfaceTools(surface, "oversikt husk e-post kalender github status minne", mappings);
      expect(worst.schema_tokens).toBeLessThanOrEqual(SURFACE_LIMITS[surface].max_schema_tokens);
    }
    console.info(JSON.stringify({ msg: "d3_schema_tokens", full_registry_tokens: fullRegistryTokens, model_surface_tokens: currentSurfaceTokens, registry_actions: everything.length }));
  });
});

describe("turn-kontekst", () => {
  it("tale er tainted fra første stund; web/telegram ikke; taint kan aldri fjernes", () => {
    expect(createTurnContext("voice", "x").taint.tainted).toBe(true);
    expect(createTurnContext("web_chat", "x").taint.tainted).toBe(false);
    const t = createTurnContext("telegram", "x");
    t.taint.mark("a");
    expect(t.taint.tainted).toBe(true);
    expect(t.taint.reasons).toEqual(["a"]);
  });
  it("kanal→flate", () => {
    expect(surfaceForChannel("voice")).toBe("voice");
    expect(surfaceForChannel("telegram")).toBe("telegram");
    expect(surfaceForChannel("system")).toBe("background");
    expect(surfaceForChannel("web")).toBe("web_chat");
    expect(surfaceForChannel("mobile")).toBe("web_chat");
  });
});
