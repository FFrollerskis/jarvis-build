import { CONNECTOR_REGISTRY } from "./connector-registry.ts";
import { isFinancialNamespace } from "./tool-manifest.ts";

/**
 * WP-N1b (JARVIS-116 a, Q-76 pkt 7, Q-64 pkt 2; K2): FELLES byggeklosser for «hold tilbake finansAVLEDET innhold ved UTFØRELSE». Utførelseslåsen (N1, K6) dekker `finance`/`finance_*`-verktøyene; denne modulen er det de ØVRIGE
 * stiene en modell kan kalle (forretnings-OS, executive-statusverktøyene, kontrollsentrene, kost-/verdirapportene) bruker når en sky-/ukjent modell betjener kallet (sentral lesning: `withholdFinanceFromCurrentModel()`, `model-scope.ts`):
 *  - ÉTT nøytralt, innholdsfritt merke (`financeWithheldMarker`): `finance_withheld: true` + en kort norsk merknad UTEN sifre, id-er, tellinger eller leverandørnavn (låst av `wpn1b-finance-withheld-note.test.ts`).
 *    Merket settes ALLTID for en sky-/ukjent modell (uavhengig av om det finnes noe finansavledet å holde tilbake), så merket selv aldri røper om finansdata finnes.
 *  - gjenkjenning av finanskoblinger og -legitimasjon (`isFinanceConnectorId`, `isFinanceCredentialRef`) utledet av SAMME connector-register som resten av systemet (`category: "finance"`) + finans-navnerommene
 *    (`isFinancialNamespace`), FAIL-CLOSED på ordstammene (en referanse som nevner en finansleverandør regnes som finansavledet selv om registeret ikke kjenner den).
 *  - situasjonsdomenene som er finansavledede (`spend`): `situations`-broen (`domainForLoopType`) legger ALLE finans-løkketypene og AI-kostnads-spiken i dette domenet; en test pinner at settet her og broen er enige.
 */

/** Den korte merknaden modellen får i stedet for finansavledet innhold. Ingen sifre, id-er, tellinger eller leverandørnavn (testet). */
export const FINANCE_WITHHELD_NOTE_NO =
  "Finansavledet innhold (beløp, kostnad, finanstilkoblinger og økonomivarsler) er holdt tilbake fra denne modellen, fordi økonomidata kun går til en lokal modell. " +
  "Ikke trekk noen slutning om økonomi ut fra det som mangler i svaret, og ikke gjett. Si det kort til Tobias, og at han kan se det på kontrollsiden eller spørre den lokale modellen.";

export interface FinanceWithheldMarker {
  finance_withheld: true;
  note_no: string;
}

/** Merket som legges i et svar til en sky-/ukjent modell. Alltid det samme (konstant tekst), så det aldri bærer noe fra dataene. */
export function financeWithheldMarker(): FinanceWithheldMarker {
  return { finance_withheld: true, note_no: FINANCE_WITHHELD_NOTE_NO };
}

const FINANCE_CONNECTORS = CONNECTOR_REGISTRY.filter((c) => c.category === "finance");
const FINANCE_CONNECTOR_IDS: ReadonlySet<string> = new Set(FINANCE_CONNECTORS.map((c) => c.id));
/** `live_test.tool_id` til finanskoblingene (`finance`, `finance_stripe`, ...): verktøy-id-en en frys av koblingen rammer. */
const FINANCE_CONNECTOR_TOOL_IDS: ReadonlySet<string> = new Set(FINANCE_CONNECTORS.flatMap((c) => (c.live_test !== undefined ? [c.live_test.tool_id] : [])));
const FINANCE_CREDENTIAL_REFS: ReadonlySet<string> = new Set(FINANCE_CONNECTORS.flatMap((c) => [...c.credential_refs, ...(c.optional_credential_refs ?? [])]));
/** Ordstammer som aldri hører til noe annet enn finans-/betalingsleverandørene (fail-closed for referanser/id-er registeret ikke kjenner). */
const FINANCE_STEM = /(^|[^a-z])(finance|finans|stripe|vipps|fiken|neonomics|wallester|payment|bank)([^a-z]|$)/i;

/** Er dette en verktøy-id i finans-navnerommene (`finance`, `finance_*`)? Samme regel som utførelseslåsen (`isFinancialNamespace`). */
export function isFinanceToolId(toolId: string): boolean {
  return typeof toolId === "string" && isFinancialNamespace(toolId);
}

/**
 * Er connector-/verktøy-id-en finansavledet? Kilder: finanskoblingene i registeret (`category: "finance"`: id-ene OG verktøy-id-ene deres), finans-navnerommene, og (fail-closed) enhver id som nevner en finansleverandør.
 * Ikke-strenger regnes som finansavledet (kan ikke avgjøres).
 */
export function isFinanceConnectorId(id: unknown): boolean {
  if (typeof id !== "string") return true;
  const trimmed = id.trim();
  if (trimmed === "") return false;
  return FINANCE_CONNECTOR_IDS.has(trimmed) || FINANCE_CONNECTOR_TOOL_IDS.has(trimmed) || isFinancialNamespace(trimmed) || FINANCE_STEM.test(trimmed);
}

/** Er credential-referansen finansavledet? Referansene til finanskoblingene (også valgfrie) og, fail-closed, alt som nevner en finansleverandør. Ikke-strenger regnes som finansavledet. */
export function isFinanceCredentialRef(ref: unknown): boolean {
  if (typeof ref !== "string") return true;
  const trimmed = ref.trim();
  if (trimmed === "") return false;
  return FINANCE_CREDENTIAL_REFS.has(trimmed) || FINANCE_STEM.test(trimmed);
}

/**
 * Situasjonsdomener som er finansavledede. `situations`-broen (`domainForLoopType`) legger ALLE finans-løkketypene (inkl. markedsutgift) i `spend`, og AI-kostnads-spiken (`spend_anomaly:ai_cost`) har samme domene -
 * så `reason`/`inform_message` for en slik situasjon bærer beløp, leverandør eller AI-kost. Domenenavnet leses fra data og sammenlignes eksakt (store/små bokstaver og mellomrom normaliseres fail-closed).
 */
export const FINANCE_DERIVED_SITUATION_DOMAINS: ReadonlySet<string> = new Set(["spend"]);

export function isFinanceDerivedSituationDomain(domain: unknown): boolean {
  return typeof domain !== "string" || FINANCE_DERIVED_SITUATION_DOMAINS.has(domain.trim().toLowerCase());
}
