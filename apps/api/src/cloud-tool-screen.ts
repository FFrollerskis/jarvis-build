// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { classifyContentSensitivity, type ToolExecutor } from "@jarvis/model-gateway";
import type { ToolResultMessage } from "@jarvis/provider-adapters";

/**
 * D-449 (Q-50, revisjonsfunn): en delegert jobb på skyruten sender VERKTØYRESULTATENE videre til skymodellen. Minnesøket (`memory.search`) returnerer alle aktive treff i jobbens minnerom uten
 * filter, også elementer merket `special` og helse-rommet - data som aldri skal til en skymodell (D-378). Chatten klassifiserer det omgivende minnet FØR turen (`memory_sensitivities`), men et
 * eksplisitt søk midt i en verktøyrunde ble aldri klassifisert på nytt. Denne porten gjør det for jobber: et minnetreff som er `special`, ligger i helse-rommet eller selv klassifiseres som
 * `SECRET_RESTRICTED` (helse/økonomi/hemmeligheter i teksten) holdes TILBAKE fra skymodellen, og modellen får beskjed om at noe ble holdt tilbake (aldri innholdet).
 *
 * Avgrensning (ærlig, se D-449 og Q-52): `memory.search` er det eneste bakgrunnsverktøyet med STRUKTURERTE sensitivitetsmerker. E-post, kalender og GitHub har ingen slike merker, og en
 * stikkordsskanning av hele resultatene ville gitt mange falske treff (en GitHub-liste fra dette repoet inneholder rutinemessig ord som «gjeld» og «lønn» i grennavn og tittel) og gjort
 * hovedbruken (PR-lister) ubrukelig. De har derfor samme oppførsel som chattens verktøyturer (D-431). Å utvide skjermingen til tekstskanning av alle resultater er et eget valg for eieren (Q-52).
 */

/** Verktøykilden (`tool_id.action`) som skjermes. */
export const SCREENED_MEMORY_SOURCE = "memory.search";
/** Modellens navn på samme verktøy (mesh-bridge): brukes kun hvis en executor ikke setter `source`. */
const SCREENED_MEMORY_TOOL_NAME = "search_my_memory";

/**
 * Hvert verktøy på bakgrunnsflaten er enten skjermet (strukturerte merker) eller bevisst vurdert som «samme som chattens verktøyturer». Låst av en test mot `SURFACE_TOOL_GRANTS.background`:
 * et nytt bakgrunnsverktøy MÅ klassifiseres her før skyruten får lese det (GitHub-lesing er vurdert som gruppe, se `isReviewedBackgroundTool`).
 */
export const CLOUD_SCREEN_COVERAGE: Readonly<Record<string, "screened" | "reviewed_parity_with_chat">> = {
  "memory.search": "screened",
  "email.read_inbox": "reviewed_parity_with_chat",
  "calendar.read_events": "reviewed_parity_with_chat",
  "executive.get_capability_status": "reviewed_parity_with_chat"
};

export function isReviewedBackgroundTool(toolId: string, action: string): boolean {
  return `${toolId}.${action}` in CLOUD_SCREEN_COVERAGE || toolId === "github";
}

/** Ett minnetreff kan til skymodellen kun hvis rommet er kjent og hverken merket, rommet eller teksten gjør det til `SECRET_RESTRICTED`. Ukjent form = ikke trygt. */
function memoryItemIsCloudSafe(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const rec = item as Record<string, unknown>;
  const space = rec["space"];
  if (typeof space !== "string" || space === "") return false;
  const texts = [rec["subject"], rec["content"]].filter((value): value is string => typeof value === "string");
  const sensitivities = typeof rec["sensitivity"] === "string" ? [rec["sensitivity"]] : [];
  return classifyContentSensitivity({ memory_spaces: [space], memory_sensitivities: sensitivities, texts }).sensitivity !== "SECRET_RESTRICTED";
}

export interface CloudScreenOutcome {
  result: ToolResultMessage;
  /** Antall minnetreff (eller 1 for et helt resultat) som ble holdt tilbake. 0 = resultatet er urørt. */
  withheld: number;
}

/**
 * Skjermer ETT verktøyresultat før det kan nå skymodellen. Urørt (samme objekt) når ingenting er holdt tilbake. Et minnesøk uten kjent listeform (f.eks. et avkortet forhåndsvisningsobjekt, der treffene
 * ikke lar seg skille fra hverandre) holdes tilbake i sin helhet - fail-closed.
 */
export function screenToolResultForCloud(out: ToolResultMessage, toolName?: string): CloudScreenOutcome {
  const isMemorySearch = out.source === SCREENED_MEMORY_SOURCE || (out.source === undefined && toolName === SCREENED_MEMORY_TOOL_NAME);
  if (!isMemorySearch || !out.success || out.output === null || out.output === undefined) return { result: out, withheld: 0 };
  if (!Array.isArray(out.output)) {
    return {
      result: {
        ...out,
        output: { withheld_count: 1, note: "Minnesøket ble holdt tilbake fra denne modellen fordi resultatet ikke kunne kontrolleres for følsomt innhold. Svar uten minnet og si at minnet ikke ble lest." }
      },
      withheld: 1
    };
  }
  const kept = out.output.filter(memoryItemIsCloudSafe);
  const withheld = out.output.length - kept.length;
  if (withheld === 0) return { result: out, withheld: 0 };
  return {
    result: {
      ...out,
      output: {
        results: kept,
        withheld_count: withheld,
        note: `${withheld} minnetreff ble holdt tilbake fra denne modellen fordi de er merket som særlig sensitive. Si at noe ble holdt tilbake hvis det påvirker svaret.`
      }
    },
    withheld
  };
}

/** Pakker en executor slik at hvert resultat skjermes før modellen ser det. `onWithheld` kalles kun når noe ble holdt tilbake (aldri med innhold). */
export function cloudScreenedExecutor(inner: ToolExecutor, onWithheld?: (info: { tool: string; withheld: number }) => void): ToolExecutor {
  return {
    execute: async (call, ctx) => {
      const out = await inner.execute(call, ctx);
      const screened = screenToolResultForCloud(out, call.tool_name);
      if (screened.withheld > 0) onWithheld?.({ tool: out.source ?? call.tool_name, withheld: screened.withheld });
      return screened.result;
    }
  };
}

/**
 * Merknaden som legges FORAN jobbens svar når treff ble holdt tilbake (foran, fordi leveringsvisningen avkorter svarteksten bakfra, `ChatJobs.toView`). Leveres til samtalen som data, så teksten
 * må selv ikke inneholde ord sensitivitetsklassifiseringen reagerer på (samme vakt som `localOnlyNote`); låst av en test.
 */
export function jobWithheldNote(): string {
  return "(Deler av minnesøket ble holdt tilbake fra skymodellen fordi treffene er merket som særlig sensitive eller ikke kunne kontrolleres, så svaret kan mangle noe.)";
}
