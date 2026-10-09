// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { MemorySpaceSchema } from "@jarvis/contracts";
import { KNOWLEDGE_HIT_FIELDS } from "@jarvis/knowledge";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import type { ToolResultMessage } from "@jarvis/provider-adapters";
import { KNOWLEDGE_SOURCE_KINDS } from "@jarvis/tool-gateway";

/**
 * WP-D1 (UA-2, D-449/D-451): skyskjermen for kunnskapstreff. Et verktøyresultat som går til en SKYMODELL skjermes kun pålitelig når det bærer STRUKTURERTE sensitivitetsmerker (stikkordsskanning
 * av hele resultater gir mange falske treff, Q-52). `knowledge.search` bærer dem per treff (`sensitivity`, `memory_space`, `trust_level`, se `KnowledgeHit`), og dette er porten som bruker dem - på
 * samme «positivt trygt, ellers tilbake»-måte som minnesøket (`memoryItemIsCloudSafe`):
 *  - `sensitivity` må være eksplisitt `normal` eller `sensitive` (`special` og alt ukjent/manglende holdes tilbake),
 *  - `memory_space` må være et KJENT rom og ikke gjøre treffet `SECRET_RESTRICTED` (helse-rommet),
 *  - all tekst treffet bærer (tittel, utdrag, lenke, entitetsnavn) klassifiseres på nytt - merket kan være regnet ut med et eldre ordforråd,
 *  - treff med ukjente felt (også inni `entities[]`), feil typer eller en ukjent kildetype holdes tilbake: et nytt felt eller en ny kildetype kan bære uklassifisert tekst, og valget skal gjøres bevisst her.
 * Hele resultatet holdes tilbake når formen ikke er den kjente (`{ results: [...], notice? }`, ev. allerede skjermet med `withheld_count`/`note`) - også et avkortet forhåndsvisningsobjekt (treffene lar seg
 * da ikke skille fra hverandre). Modellen får beskjed om at noe ble holdt tilbake (aldri innholdet).
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKnownKeys = (value: Record<string, unknown>, known: ReadonlySet<string>): boolean => Object.keys(value).every((key) => known.has(key));

/** Toppnivåfeltene i et søkeresultat. `withheld_count`/`note` finnes når resultatet allerede er skjermet én gang (skjermen er idempotent). */
const KNOWN_RESULT_FIELDS: ReadonlySet<string> = new Set(["results", "notice", "withheld_count", "note"]);
const KNOWN_ENTITY_FIELDS: ReadonlySet<string> = new Set(["kind", "name"]);
const REQUIRED_STRING_FIELDS = ["document_id", "source_kind", "title", "snippet", "uri", "memory_space", "observed_at"] as const;
const KNOWN_SOURCE_KINDS: ReadonlySet<string> = new Set(KNOWLEDGE_SOURCE_KINDS);

/** Ett kunnskapstreff kan til skymodellen kun hvis det er positivt trygt (se filhodet). Ukjent form = ikke trygt. */
export function knowledgeHitIsCloudSafe(hit: unknown): boolean {
  if (!isRecord(hit)) return false;
  if (!onlyKnownKeys(hit, KNOWLEDGE_HIT_FIELDS)) return false;
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = hit[field];
    if (typeof value !== "string" || (field !== "title" && field !== "snippet" && value === "")) return false;
  }
  const { source_kind, memory_space, sensitivity, trust_level, score, modified_at, entities } = hit;
  if (!KNOWN_SOURCE_KINDS.has(source_kind as string)) return false;
  if (!MemorySpaceSchema.safeParse(memory_space).success) return false;
  if (sensitivity !== "normal" && sensitivity !== "sensitive") return false;
  if (trust_level !== "untrusted" && trust_level !== "internal") return false;
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  if (!("modified_at" in hit) || (modified_at !== null && typeof modified_at !== "string")) return false;
  const entityNames: string[] = [];
  if (entities !== undefined) {
    if (!Array.isArray(entities)) return false;
    for (const entity of entities) {
      if (!isRecord(entity) || !onlyKnownKeys(entity, KNOWN_ENTITY_FIELDS) || typeof entity["kind"] !== "string" || typeof entity["name"] !== "string") return false;
      entityNames.push(entity["name"]);
    }
  }
  const texts = [hit["title"] as string, hit["snippet"] as string, hit["uri"] as string, ...entityNames];
  // `special` er allerede avvist over; rommet og ALL tekst klassifiseres likevel (helse-rommet, og tekst som det eldre ordforrådet ikke fanget).
  return classifyContentSensitivity({ memory_spaces: [memory_space as string], texts }).sensitivity !== "SECRET_RESTRICTED";
}

export interface KnowledgeScreenOutcome {
  result: ToolResultMessage;
  /** Antall treff (eller 1 for et helt resultat) som ble holdt tilbake. 0 = resultatet er urørt (samme objekt). */
  withheld: number;
}

const WITHHELD_ALL_NOTE =
  "Kunnskapssøket ble holdt tilbake fra denne modellen fordi resultatet ikke kunne kontrolleres for følsomt innhold. Svar uten dokumentene og si at kunnskapsbasen ikke ble lest.";

/** Skjermer ETT `knowledge.search`-resultat. Samme objekt når ingenting holdes tilbake. */
export function screenKnowledgeSearchResult(out: ToolResultMessage): KnowledgeScreenOutcome {
  const whole = (): KnowledgeScreenOutcome => ({ result: { ...out, output: { withheld_count: 1, note: WITHHELD_ALL_NOTE } }, withheld: 1 });
  if (out.output === null || out.output === undefined) return { result: out, withheld: 0 };
  if (!out.success) {
    // En feil skal bare ha en forklaring; bærer den likevel en liste med treff, holdes den tilbake.
    return Array.isArray(out.output) || (isRecord(out.output) && "results" in out.output) ? whole() : { result: out, withheld: 0 };
  }
  const output = out.output;
  if (!isRecord(output) || !Array.isArray(output["results"]) || !onlyKnownKeys(output, KNOWN_RESULT_FIELDS)) return whole();
  if (output["notice"] !== undefined && typeof output["notice"] !== "string") return whole();
  const alreadyWithheld = output["withheld_count"];
  if (alreadyWithheld !== undefined && !(typeof alreadyWithheld === "number" && Number.isInteger(alreadyWithheld) && alreadyWithheld >= 0)) return whole();
  if (output["note"] !== undefined && typeof output["note"] !== "string") return whole();
  const results = output["results"] as unknown[];
  const kept = results.filter(knowledgeHitIsCloudSafe);
  const withheld = results.length - kept.length;
  if (withheld === 0) return { result: out, withheld: 0 };
  return {
    result: {
      ...out,
      output: {
        ...output,
        results: kept,
        withheld_count: (typeof alreadyWithheld === "number" ? alreadyWithheld : 0) + withheld,
        note: `${withheld} kunnskapstreff ble holdt tilbake fra denne modellen fordi de er merket som særlig sensitive eller ikke kunne kontrolleres. Si at noe ble holdt tilbake hvis det påvirker svaret.`
      }
    },
    withheld
  };
}
