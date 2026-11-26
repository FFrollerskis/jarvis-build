// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { DEFAULT_PROFILES, classifyContentSensitivity, type ToolExecutor } from "@jarvis/model-gateway";
import type { ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import { screenKnowledgeClaimResult, screenKnowledgeSearchResult } from "./cloud-knowledge-screen.ts";

/**
 * D-449 (Q-50, revisjonsfunn): en delegert jobb på skyruten sender VERKTØYRESULTATENE videre til skymodellen. Minnesøket (`memory.search`) returnerer alle aktive treff i minnerommet uten filter, også elementer
 * merket `special` og helse-rommet - data som aldri skal til en skymodell (D-378). Chatten klassifiserer det omgivende minnet FØR turen (`memory_sensitivities`), men et eksplisitt søk midt i en verktøyrunde
 * ble aldri klassifisert på nytt. Denne porten gjør det for jobber: et minnetreff holdes TILBAKE fra skymodellen med mindre det er positivt trygt (fail-closed):
 *  - `sensitivity` må være eksplisitt `normal` eller `sensitive` (`special` og alt ukjent/manglende holdes tilbake). Unntak: sammendrag (`kind: "summary"`) har ingen slik kolonne, men tar aldri med `special`-minner
 *    (`summaries.ts`) og klassifiseres på tekst. Gjennomgang nr. 2 fant at relasjons-/lenketreff manglet feltet (rettet i `retriever.ts`) - og en manglende verdi regnes derfor ikke lenger som «ufarlig».
 *  - rommet må være kjent og ikke gjøre treffet `SECRET_RESTRICTED` (helse-rommet).
 *  - all tekst treffet bærer klassifiseres: emne, innhold, nøkkelord OG tidligere versjoner (`versions[].content`; en oppdatering regner ikke om sensitiviteten, så en gammel versjon kan bære helsetekst
 *    selv om elementet står som `normal`).
 * Modellen får beskjed om at noe ble holdt tilbake (aldri innholdet).
 *
 * Avgrensning (ærlig, se D-449 og Q-52): `memory.search` er det eneste bakgrunnsverktøyet med STRUKTURERTE sensitivitetsmerker. E-post, kalender og GitHub har ingen slike merker, og en stikkordsskanning av hele
 * resultatene ville gitt mange falske treff (en GitHub-liste fra dette repoet inneholder rutinemessig ord som «gjeld» og «lønn» i grennavn og tittel) og gjort hovedbruken (PR-lister) ubrukelig. De har derfor
 * samme oppførsel som chattens verktøyturer (D-431). Å utvide skjermingen til tekstskanning av alle resultater er et eget valg for eieren (Q-52). Selve tekstklassifiseringen er stikkordsbasert og smal (Q-52).
 */

/** Verktøykilden (`tool_id.action`) som skjermes. */
export const SCREENED_MEMORY_SOURCE = "memory.search";
/** Modellens navn på samme verktøy (mesh-bridge): brukes kun hvis en executor ikke setter `source`. */
const SCREENED_MEMORY_TOOL_NAME = "search_my_memory";
/** WP-D1 (UA-2): kunnskapssøket har strukturerte sensitivitetsmerker per treff og skjermes av `cloud-knowledge-screen.ts`. Mesh-navnet er `${tool_id}__${action}` (chattens lese-nivå). */
export const SCREENED_KNOWLEDGE_SOURCE = "knowledge.search";
const SCREENED_KNOWLEDGE_TOOL_NAME = "knowledge__search";
/** Q-26: påstandsverifisering har egen form (`{ found, status, claim, notice }`) og egen port, men samme prinsipp. */
export const SCREENED_CLAIM_SOURCE = "knowledge.get_claim_status";
const SCREENED_CLAIM_TOOL_NAME = "knowledge__get_claim_status";

/**
 * Hvert verktøy på bakgrunnsflaten er enten skjermet (strukturerte merker) eller bevisst vurdert som «samme som chattens verktøyturer». Låst av en test mot `SURFACE_TOOL_GRANTS.background`:
 * et nytt bakgrunnsverktøy (også en ny GitHub-handling) MÅ klassifiseres her før skyruten får lese det.
 */
export const CLOUD_SCREEN_COVERAGE: Readonly<Record<string, "screened" | "reviewed_parity_with_chat">> = {
  "memory.search": "screened",
  // WP-D1: står på chattens lese-nivå (web_chat/voice), IKKE på bakgrunnsflaten - men chattens verktøyturer går til skymodeller (D-431) og resultatene skjermes av samme port.
  "knowledge.search": "screened",
  "knowledge.get_claim_status": "screened",
  "email.read_inbox": "reviewed_parity_with_chat",
  "calendar.read_events": "reviewed_parity_with_chat",
  "executive.get_capability_status": "reviewed_parity_with_chat",
  "github.read_issues": "reviewed_parity_with_chat",
  "github.get_branch": "reviewed_parity_with_chat",
  "github.get_commit": "reviewed_parity_with_chat",
  "github.get_pull_request": "reviewed_parity_with_chat",
  "github.list_branches": "reviewed_parity_with_chat",
  "github.list_pull_requests": "reviewed_parity_with_chat",
  "github.list_workflow_jobs": "reviewed_parity_with_chat",
  "github.list_workflow_runs": "reviewed_parity_with_chat",
  "github.read_repo_meta": "reviewed_parity_with_chat"
};

export function isReviewedBackgroundTool(toolId: string, action: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLOUD_SCREEN_COVERAGE, `${toolId}.${action}`);
}

/**
 * Feltene et minnetreff fra `MemoryRetriever.search()` har i dag (`RetrievedItem`). Et ukjent felt kunne bære tekst ingen har klassifisert, så et treff med ukjente felt holdes tilbake (fail-closed) - og en test
 * mot ekte retriever-utdata feiler FØR det blir et driftsproblem hvis retrieveren får et nytt felt, så valget gjøres bevisst her.
 */
export const KNOWN_MEMORY_ITEM_FIELDS: ReadonlySet<string> = new Set([
  "memory_item_id", "kind", "subject", "content", "type", "space", "valid_from", "valid_to", "has_conflict", "importance", "observed_at",
  "keywords", "sensitivity", "source", "score", "via", "versions"
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Indre felt (gjennomgang nr. 3, L2): `source` og hvert element i `versions` kan heller ikke bære ukjente felt med uklassifisert tekst. */
const KNOWN_SOURCE_FIELDS: ReadonlySet<string> = new Set(["kind", "ref", "trust_level"]);
const KNOWN_VERSION_FIELDS: ReadonlySet<string> = new Set(["version", "content", "valid_from", "valid_to"]);
const onlyKnownKeys = (value: Record<string, unknown>, known: ReadonlySet<string>): boolean => Object.keys(value).every((key) => known.has(key));

/** Ett minnetreff kan til skymodellen kun hvis det er positivt trygt (se filhodet). Ukjent form = ikke trygt. */
function memoryItemIsCloudSafe(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (Object.keys(item).some((key) => !KNOWN_MEMORY_ITEM_FIELDS.has(key))) return false;
  const { space, sensitivity, subject, content, keywords, versions, source } = item;
  if (typeof space !== "string" || space === "" || typeof subject !== "string" || typeof content !== "string") return false;
  const explicit = sensitivity === "normal" || sensitivity === "sensitive";
  const summaryWithoutColumn = item["kind"] === "summary" && sensitivity === undefined;
  if (!explicit && !summaryWithoutColumn) return false;
  if (keywords !== undefined && !(Array.isArray(keywords) && keywords.every((k) => typeof k === "string"))) return false;
  if (versions !== undefined && !(Array.isArray(versions) && versions.every((v) => isRecord(v) && typeof v["content"] === "string" && onlyKnownKeys(v, KNOWN_VERSION_FIELDS)))) return false;
  if (source !== undefined && !(isRecord(source) && onlyKnownKeys(source, KNOWN_SOURCE_FIELDS) && Object.values(source).every((v) => typeof v === "string"))) return false;
  const texts = [
    subject,
    content,
    ...((keywords as string[] | undefined) ?? []),
    ...((versions as Array<{ content: string }> | undefined) ?? []).map((v) => v.content),
    ...(source !== undefined ? [(source as Record<string, string>)["ref"] ?? ""] : [])
  ];
  // `special` er allerede avvist over (kun `normal`/`sensitive` er eksplisitt trygge), så sensitivity-merket trenger ikke gå gjennom klassifiseringen på nytt; rommet og ALL tekst gjør det.
  return classifyContentSensitivity({ memory_spaces: [space], texts }).sensitivity !== "SECRET_RESTRICTED";
}

export interface CloudScreenOutcome {
  result: ToolResultMessage;
  /** Antall minnetreff (eller 1 for et helt resultat) som ble holdt tilbake. 0 = resultatet er urørt. */
  withheld: number;
}

const WITHHELD_ALL_NOTE =
  "Minnesøket ble holdt tilbake fra denne modellen fordi resultatet ikke kunne kontrolleres for følsomt innhold. Svar uten minnet og si at minnet ikke ble lest.";

/**
 * Skjermer ETT verktøyresultat før det kan nå skymodellen. Urørt (samme objekt) når ingenting er holdt tilbake. Et minnesøk uten kjent listeform (f.eks. et avkortet forhåndsvisningsobjekt, der treffene
 * ikke lar seg skille fra hverandre) holdes tilbake i sin helhet - fail-closed. Det samme gjelder et FEILET minnesøk som likevel bærer en liste (ingen kode produserer det i dag; en feil skal bare ha en forklaring).
 */
export function screenToolResultForCloud(out: ToolResultMessage, toolName?: string): CloudScreenOutcome {
  // WP-D1: kunnskapssøket har sin egen form (`{ results: [...], notice }`) og sin egen port.
  if (out.source === SCREENED_KNOWLEDGE_SOURCE || (out.source === undefined && toolName === SCREENED_KNOWLEDGE_TOOL_NAME)) return screenKnowledgeSearchResult(out);
  if (out.source === SCREENED_CLAIM_SOURCE || (out.source === undefined && toolName === SCREENED_CLAIM_TOOL_NAME)) return screenKnowledgeClaimResult(out);
  const isMemorySearch = out.source === SCREENED_MEMORY_SOURCE || (out.source === undefined && toolName === SCREENED_MEMORY_TOOL_NAME);
  if (!isMemorySearch || out.output === null || out.output === undefined) return { result: out, withheld: 0 };
  if (!out.success) {
    return Array.isArray(out.output) ? { result: { ...out, output: { withheld_count: 1, note: WITHHELD_ALL_NOTE } }, withheld: 1 } : { result: out, withheld: 0 };
  }
  if (!Array.isArray(out.output)) return { result: { ...out, output: { withheld_count: 1, note: WITHHELD_ALL_NOTE } }, withheld: 1 };
  const kept = out.output.filter(memoryItemIsCloudSafe);
  const withheld = out.output.length - kept.length;
  if (withheld === 0) return { result: out, withheld: 0 };
  return {
    result: {
      ...out,
      output: {
        results: kept,
        withheld_count: withheld,
        note: `${withheld} minnetreff ble holdt tilbake fra denne modellen fordi de er merket som særlig sensitive eller ikke kunne kontrolleres. Si at noe ble holdt tilbake hvis det påvirker svaret.`
      }
    },
    withheld
  };
}

/**
 * Pakker en executor slik at hvert resultat skjermes før modellen ser det. `onWithheld` kalles kun når noe ble holdt tilbake (aldri med innhold).
 * `appliesTo` (valgfri) begrenser skjermingen til kall der svaret faktisk går til en skymodell: chatten (#228) bruker `servedByCloudModel`, slik at den lokale modellen - som har lov til å se alt - ikke mister minnetreff.
 */
export function cloudScreenedExecutor(
  inner: ToolExecutor,
  onWithheld?: (info: { tool: string; withheld: number }) => void,
  appliesTo?: (call: ToolCallRequest) => boolean
): ToolExecutor {
  return {
    execute: async (call, ctx) => {
      const out = await inner.execute(call, ctx);
      if (appliesTo !== undefined && !appliesTo(call)) return out;
      const screened = screenToolResultForCloud(out, call.tool_name);
      if (screened.withheld > 0) onWithheld?.({ tool: out.source ?? call.tool_name, withheld: screened.withheld });
      return screened.result;
    }
  };
}

/**
 * #228 (D-450): leverandørene som er registrert som LOKALE (`locality: "local"` i modellregisteret) får se alt; alt annet - sky, hostet gratis-tier og leverandører som ikke står i registeret - regnes som sky (fail-closed,
 * motsatt av `cloudToolTurnsAllowed`, som regner en ukjent leverandør som lokal for sin egen "ikke sky"-vurdering: her er spørsmålet hva som kan lekke, og da er ukjent = sky).
 */
// WP-G4b K4 (D-484): leses PER KALL fra profilene (ikke et sett frosset ved import): oppstartsvakten for lokale endepunkter (`local-model-endpoints.ts`) kan sette en identitet med ugyldig/offentlig URL til `cloud` på SELVE
// profilen etter at denne filen er lastet, og alle lokalitetsavgjørelser (også `financeLockServedLocally`) følger det. Uten vakten (flagg AV) er resultatet byte-likt det frosne settet.
export function servedByCloudModel(call: Pick<ToolCallRequest, "provider">): boolean {
  return !DEFAULT_PROFILES.some((profile) => profile.provider === call.provider && profile.locality === "local");
}

/** Merknaden i chatten (bak svaret) når minnetreff ble holdt tilbake fra en skymodell. Samme tekst som for jobber, men med blank linje foran slik rutemerknadene i chatten har. */
export function chatWithheldNote(): string {
  return `\n\n${jobWithheldNote()}`;
}

/**
 * Merknaden som legges FORAN jobbens svar når treff ble holdt tilbake (foran, fordi leveringsvisningen avkorter svarteksten bakfra, `ChatJobs.toView`). Leveres til samtalen som data, så teksten
 * må selv ikke inneholde ord sensitivitetsklassifiseringen reagerer på (samme vakt som `localOnlyNote`); låst av en test.
 */
export function jobWithheldNote(): string {
  return "(Deler av minnesøket ble holdt tilbake fra skymodellen fordi treffene er merket som særlig sensitive eller ikke kunne kontrolleres, så svaret kan mangle noe.)";
}

/**
 * WP-D1: samme merknad for kunnskapssøket (dokumenter/notater/vedlegg/referater). Egen prefiks i `SYSTEM_NOTE_PREFIXES` (tool-turn-route.ts), så merknaden fjernes strukturelt fra historikken før den
 * klassifiseres og sendes til noen modell. Teksten må selv ikke inneholde ord sensitivitetsklassifiseringen reagerer på (låst av en test); ingen parenteser inne i teksten (se `stripSystemNotes`).
 */
export function chatKnowledgeWithheldNote(): string {
  return "\n\n(Deler av kunnskapssøket ble holdt tilbake fra skymodellen fordi treffene er merket som særlig sensitive eller ikke kunne kontrolleres, så svaret kan mangle noe. Skriv «kun lokale modeller» i spørsmålet hvis du vil ha dem med.)";
}
