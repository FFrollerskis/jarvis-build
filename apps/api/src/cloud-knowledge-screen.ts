// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { MemorySpaceSchema } from "@jarvis/contracts";
import { CLAIM_REPORT_CLAIM_FIELDS, CLAIM_REPORT_EVIDENCE_FIELDS, CLAIM_REPORT_FIELDS, CLAIM_STATUSES, KNOWLEDGE_HIT_FIELDS } from "@jarvis/knowledge";
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q-26: knowledge.get_claim_status
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

const KNOWN_CLAIM_STATUSES: ReadonlySet<string> = new Set(CLAIM_STATUSES);
/** Toppnivåfeltene i en påstandsrapport fra tjenesten. `withheld_count`/`note` hører til den allerede skjermede formen (egen, nøyaktig gjenkjenning i `screenKnowledgeClaimResult`) og er IKKE tillatt ved siden av en rapport. */
const REPORT_FIELDS: ReadonlySet<string> = new Set([...CLAIM_REPORT_FIELDS].filter((field) => field !== "withheld_count" && field !== "note"));
const MAX_REPORT_EVIDENCE = 20;
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function claimEvidenceIsWellFormed(evidence: unknown): evidence is Record<string, unknown> {
  if (!isRecord(evidence) || !onlyKnownKeys(evidence, CLAIM_REPORT_EVIDENCE_FIELDS)) return false;
  return (
    (evidence["stance"] === "supports" || evidence["stance"] === "contradicts") && isString(evidence["source_ref"]) && isString(evidence["independence_key"]) && typeof evidence["is_primary"] === "boolean" &&
    isNullableString(evidence["published_at"]) && isString(evidence["retrieved_at"]) && isNullableString(evidence["excerpt"]) && typeof evidence["retracted"] === "boolean"
  );
}

/**
 * En påstandsrapport kan til skymodellen kun hvis den er positivt trygg (samme «positivt trygt, ellers tilbake»-prinsipp som kunnskapstreffene): kjent form uten ukjente felt, påstanden er `normal`/`sensitive`
 * (aldri `special`), rommet er kjent og ikke helse-rommet, og ALL tekst (påstand, utdrag, kildereferanser, uavhengighetsnøkler) klassifiseres på nytt. En ikke-funnet påstand (`found: false`, `claim: null`) bærer
 * ingen tekst og slippes igjennom.
 */
export function claimReportIsCloudSafe(report: unknown): boolean {
  if (!isRecord(report) || !onlyKnownKeys(report, REPORT_FIELDS)) return false;
  if (typeof report["found"] !== "boolean" || !isString(report["status"]) || !KNOWN_CLAIM_STATUSES.has(report["status"]) || !isString(report["notice"])) return false;
  const claim = report["claim"];
  if (report["found"] === false) return claim === null && report["status"] === "UNKNOWN";
  if (!isRecord(claim) || !onlyKnownKeys(claim, CLAIM_REPORT_CLAIM_FIELDS)) return false;
  for (const field of ["claim_id", "claim_text", "memory_space"] as const) if (!isString(claim[field]) || claim[field] === "") return false;
  if (!isString(claim["status"]) || !KNOWN_CLAIM_STATUSES.has(claim["status"]) || claim["status"] !== report["status"]) return false;
  if (!MemorySpaceSchema.safeParse(claim["memory_space"]).success) return false;
  if (claim["sensitivity"] !== "normal" && claim["sensitivity"] !== "sensitive") return false;
  if (claim["trust_level"] !== "untrusted" && claim["trust_level"] !== "internal") return false;
  for (const field of ["reverification_due", "time_sensitive", "has_primary_support"] as const) if (typeof claim[field] !== "boolean") return false;
  for (const field of ["min_independent_sources", "independent_support", "contradicting_count", "confidence"] as const) {
    if (typeof claim[field] !== "number" || !Number.isFinite(claim[field] as number)) return false;
  }
  for (const field of ["verified_at", "reverify_by", "researching_since"] as const) if (!isNullableString(claim[field])) return false;
  if (claim["promotion_status"] !== "none" && claim["promotion_status"] !== "proposed") return false;
  const evidence = claim["evidence"];
  if (!Array.isArray(evidence) || evidence.length > MAX_REPORT_EVIDENCE || !evidence.every(claimEvidenceIsWellFormed)) return false;
  const texts = [claim["claim_text"] as string];
  for (const e of evidence as Array<Record<string, unknown>>) {
    texts.push(e["source_ref"] as string, e["independence_key"] as string);
    if (isString(e["excerpt"])) texts.push(e["excerpt"]);
  }
  return classifyContentSensitivity({ memory_spaces: [claim["memory_space"] as string], texts }).sensitivity !== "SECRET_RESTRICTED";
}

const WITHHELD_CLAIM_NOTE =
  "Påstandsverifiseringen ble holdt tilbake fra denne modellen fordi resultatet er merket som særlig sensitivt eller ikke kunne kontrolleres. Svar uten den og si at verifiseringsstatusen ikke ble lest.";

/** Skjermer ETT `knowledge.get_claim_status`-resultat. Samme objekt når ingenting holdes tilbake; idempotent (et allerede skjermet resultat har bare `withheld_count` og `note`). */
export function screenKnowledgeClaimResult(out: ToolResultMessage): KnowledgeScreenOutcome {
  const whole = (): KnowledgeScreenOutcome => ({ result: { ...out, output: { withheld_count: 1, note: WITHHELD_CLAIM_NOTE } }, withheld: 1 });
  if (out.output === null || out.output === undefined) return { result: out, withheld: 0 };
  if (!out.success) {
    // En feil skal bare ha en forklaring; bærer den likevel en påstandsrapport, holdes den tilbake.
    return isRecord(out.output) && ("claim" in out.output || "found" in out.output) ? whole() : { result: out, withheld: 0 };
  }
  const output = out.output;
  // Idempotent: KUN vår egen allerede-skjermede form (nøyaktig disse to feltene med nøyaktig denne merknaden) slipper gjennom - en vilkårlig `note` er ukjent tekst og holdes tilbake.
  if (isRecord(output) && Object.keys(output).length === 2 && output["withheld_count"] === 1 && output["note"] === WITHHELD_CLAIM_NOTE) return { result: out, withheld: 0 };
  return claimReportIsCloudSafe(output) ? { result: out, withheld: 0 } : whole();
}
