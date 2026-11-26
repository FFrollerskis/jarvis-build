import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SituationsTransport, autonomyBindBlocker, situationsToolDefinitions } from "@jarvis/situations";
import {
  AUTONOMY_FORBIDDEN_NAMESPACES, assertManifestInvariants, autonomyBindabilityOf, buildToolManifest, firstWaveTools, homeAssistantTools,
  type ToolDefinition
} from "@jarvis/tool-gateway";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-G4b K1 (D-484, Q-75 pkt 11, JARVIS-115 m): bindbarhet til autonom ACT er en egenskap per verktøydefinisjon (default-deny). Denne vakten feller at et NYTT verktøy blir bindbart uten at definisjonen sier det, og at en
 * definisjon erklærer seg bindbar uten at det er en bevisst, pinnet beslutning:
 *  1. Sveip over ALLE produksjonsdefinisjonene (første bølge, Home Assistant, executive, owner_controls, kunnskap, situations): vaktens svar er BINDBAR hvis og bare hvis definisjonen erklærer det med en gyldig begrunnelse
 *     OG handlingen ikke står i et fysisk navnerom. Ingen navnerom-/verktøyliste i vakten kan åpne noe definisjonen ikke åpner.
 *  2. Den PINNEDE listen over bindbare handlinger (i dag tre: eierens egen varselkanal og to bokføringshandlinger i Jarvis' egen kanoniske DB). Å legge til en fjerde er en endring av DENNE testen med en beslutning.
 *  3. Kildeskanning: `autonomy_bindable:` tilordnes ingen annen sted i produksjonskoden enn de tre definisjonene (en ny definisjon i en annen fil, et nytt flaggstyrt verktøy, feller testen).
 */
const PINNED_BINDABLE = ["business.assign_open_loop", "business.create_followup", "telegram.notify"];

function allDefinitions(): ToolDefinition[] {
  return [
    ...productionToolDefinitions(),
    ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never), { autonomyExpiry: true }),
    ...homeAssistantTools({ invoke: async () => ({}) } as never),
    ...firstWaveTools({})
  ];
}

describe("1: sveip over produksjonsdefinisjonene - bindbar hvis og bare hvis definisjonen erklærer det (og ikke fysisk)", () => {
  const unique = new Map<string, ToolDefinition>();
  for (const def of allDefinitions()) unique.set(`${def.tool_id}.${def.action}`, def);
  const defs = [...unique.values()];
  const lookup = (t: string, a: string) => unique.get(`${t}.${a}`);

  it("sveipet er reelt (mange definisjoner, også fysiske, klasse D og step-up)", () => {
    expect(defs.length).toBeGreaterThan(300);
    expect(defs.some((d) => d.tool_id === "home-assistant")).toBe(true);
    expect(defs.some((d) => d.capability_class === "D" && d.step_up_required !== true)).toBe(true);
    expect(defs.some((d) => d.tool_id === "make" && d.action === "run_scenario")).toBe(true);
    expect(defs.some((d) => d.tool_id === "n8n" && d.action === "activate_workflow")).toBe(true);
  });

  it("vaktens svar følger NØYAKTIG definisjonen: `null` ⟺ erklært med gyldig begrunnelse og ikke et fysisk navnerom", () => {
    for (const def of defs) {
      const key = `${def.tool_id}.${def.action}`;
      const declared = autonomyBindabilityOf(def) !== null;
      const physical = AUTONOMY_FORBIDDEN_NAMESPACES.has(def.tool_id);
      expect(autonomyBindBlocker(def.tool_id, def.action, lookup) === null, key).toBe(declared && !physical);
    }
  });

  it("det som kunne bindes til et hjemmedomene i dag uten step-up (make.run_scenario, n8n.activate_workflow, klasse D uten step-up) er IKKE bindbart", () => {
    for (const [t, a] of [["make", "run_scenario"], ["n8n", "activate_workflow"]] as const) expect(autonomyBindBlocker(t, a, lookup), `${t}.${a}`).toMatchObject({ code: "action_not_bindable" });
    const classDWithoutStepUp = defs.filter((d) => d.capability_class === "D" && d.step_up_required !== true);
    expect(classDWithoutStepUp.length).toBeGreaterThan(0);
    for (const d of classDWithoutStepUp) expect(autonomyBindBlocker(d.tool_id, d.action, lookup)?.code, `${d.tool_id}.${d.action}`).toMatch(/not_bindable$/);
  });

  it("manifestinvariantene holder for hele sveipet (inkludert de tre erklæringene)", () => {
    expect(() => assertManifestInvariants(buildToolManifest(defs), { ignoreUnregisteredGrants: true })).not.toThrow();
  });
});

describe("2: den PINNEDE listen over bindbare handlinger", () => {
  it("nøyaktig tre produksjonsdefinisjoner erklærer seg bindbare, hver med en begrunnelse", () => {
    const declared = firstWaveTools({}).filter((d) => d.autonomy_bindable !== undefined);
    expect(declared.map((d) => `${d.tool_id}.${d.action}`).sort()).toEqual(PINNED_BINDABLE);
    for (const d of declared) {
      expect(autonomyBindabilityOf(d)?.reason.length ?? 0, `${d.tool_id}.${d.action}`).toBeGreaterThanOrEqual(60);
      expect(d.capability_class === "D" || d.step_up_required === true, `${d.tool_id}.${d.action}`).toBe(false);
    }
    expect(declared.find((d) => d.tool_id === "telegram")?.autonomy_bindable?.reason).toMatch(/EGEN/);
  });
});

describe("3: kildeskanning - `autonomy_bindable` tilordnes kun i de tre pinnede definisjonene", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test" || name === "dist" || name === "scripts") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith(".ts") || name.endsWith(".mjs")) out.push(full);
    }
    return out;
  };
  const sources = [...walk(join(ROOT, "modules")), ...walk(join(ROOT, "apps"))].filter((f) => f.includes(`${join("", "src")}/`) || f.includes("/src/"));
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("tilordninger (`autonomy_bindable: {`) finnes kun i integrations.ts, nøyaktig tre", () => {
    const assignments = sources
      .map((file) => ({ file: relative(ROOT, file), hits: (strip(readFileSync(file, "utf8")).match(/\bautonomy_bindable\s*:\s*[{A-Za-z"'`]/g) ?? []).length }))
      .filter((r) => r.hits > 0);
    // typen i gateway.ts (`autonomy_bindable?: AutonomyBindability`) har `?:` og telles ikke; manifestet leser feltet (`def.autonomy_bindable !== undefined`), og tilordner det ikke.
    const nonType = assignments.filter((r) => r.file !== "modules/tool-gateway/src/tool-manifest.ts");
    expect(nonType).toEqual([{ file: "modules/tool-gateway/src/integrations.ts", hits: 3 }]);
  });

  it("vakten (`autonomy-guard.ts`) har ingen verktøy-id-liste utover de fysiske navnerommene", () => {
    const code = strip(readFileSync(join(ROOT, "modules/situations/src/autonomy-guard.ts"), "utf8"));
    for (const word of ["telegram", "business", "make", "n8n", "email", "github", "docker", "gce", "zapier", "slack", "test_"]) expect(code, word).not.toMatch(new RegExp(`["'\`]${word}`));
  });
});
