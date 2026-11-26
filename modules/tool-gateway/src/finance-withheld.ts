import { CONNECTOR_REGISTRY } from "./connector-registry.ts";
import type { ToolTransport } from "./gateway.ts";
import { withholdFinanceFromCurrentModel } from "./model-scope.ts";
import { isFinancialNamespace } from "./tool-manifest.ts";

/**
 * WP-N1b (JARVIS-116 a, Q-76 pkt 7, Q-64 pkt 2; K2): FELLES byggeklosser for «hold tilbake finansAVLEDET innhold ved UTFØRELSE». Utførelseslåsen (N1, K6) dekker `finance`/`finance_*`-verktøyene; denne modulen er det de ØVRIGE
 * stiene en modell kan kalle (forretnings-OS, executive-statusverktøyene, kontrollsentrene, kost-/verdirapportene) bruker når en sky-/ukjent modell betjener kallet (sentral lesning: `withholdFinanceFromCurrentModel()`, `model-scope.ts`):
 *  - ÉTT nøytralt, innholdsfritt merke (`financeWithheldMarker`): `finance_withheld: true` + en kort norsk merknad UTEN sifre, id-er, tellinger eller leverandørnavn (låst av `wpn1b-finance-withheld-note.test.ts`).
 *    Merket settes ALLTID for en sky-/ukjent modell (uavhengig av om det finnes noe finansavledet å holde tilbake), så merket selv aldri røper om finansdata finnes.
 *  - gjenkjenning av finanskoblinger og -legitimasjon (`isFinanceConnectorId`, `isFinanceCredentialRef`) utledet av SAMME connector-register som resten av systemet (`category: "finance"`) + finans-navnerommene
 *    (`isFinancialNamespace`), FAIL-CLOSED på ordstammene (en referanse som nevner en finansleverandør regnes som finansavledet selv om registeret ikke kjenner den). Svartelisten alene er IKKE nok for fritekst-id-er som eieren skriver
 *    (`bankid`, `regnskap`, `sparebank1`, ...): der brukes TILLATELSESLISTEN `isKnownNonFinanceConnectorId`/`isKnownNonFinanceCredentialRef` (fiks-runde 2, FIX-A): kun en id registeret kjenner som ikke-finans slipper til en sky-/ukjent modell.
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

const NON_FINANCE_CONNECTORS = CONNECTOR_REGISTRY.filter((c) => c.category !== "finance");
/** Id-ene (og live-test-verktøy-id-ene) til ALLE ikke-finanskoblinger i registeret: den KJENTE ikke-finans-mengden (en tillatelsesliste, ikke en svarteliste). */
const KNOWN_NON_FINANCE_CONNECTOR_IDS: ReadonlySet<string> = new Set(NON_FINANCE_CONNECTORS.flatMap((c) => [c.id, ...(c.live_test !== undefined ? [c.live_test.tool_id] : [])]));
/** Credential-referansene (også de valgfrie) til ALLE ikke-finanskoblinger i registeret. */
const KNOWN_NON_FINANCE_CREDENTIAL_REFS: ReadonlySet<string> = new Set(NON_FINANCE_CONNECTORS.flatMap((c) => [...c.credential_refs, ...(c.optional_credential_refs ?? [])]));

/**
 * WP-N1b fiks-runde 2 (FIX-A, «ukjent = finansavledet», Q-64 pkt 1 / D-477): en TILLATELSESLISTE for FRITEKST-id-er (`connector_maintenance_log.connector_id`, `owner_controls.freeze_connector`: begge fri tekst skrevet av eieren).
 * `isFinanceConnectorId` er en SVARTELISTE (registerets finanskoblinger + ordstammer): den fanger aldri `bankid`, `regnskap`, `stripeapi`, `sparebank1`, `paypal`, `klarna`, `tripletex`, `visma`, `faktura`, `mystripe` o.l., som verken står i
 * registeret eller har stammen som eget ord. Her er svaret motsatt: en id er KJENT ikke-finans KUN når den er EKSAKT en id (eller live-test-verktøy-id) til en ikke-finanskobling i connector-registeret OG heller ikke treffer svartelisten.
 * Alt annet (ukjent navn, annen skrivemåte, ikke-streng, tom streng) regnes som finansavledet og holdes tilbake fra en sky-/ukjent modell; lokal modell og eier ser alt som før. Strengt eksakt treff (ingen trim/små bokstaver): gatewayen
 * sammenligner frosne id-er eksakt, så `GitHub`/` github` er en ANNEN, ukjent id.
 */
export function isKnownNonFinanceConnectorId(id: unknown): boolean {
  return typeof id === "string" && KNOWN_NON_FINANCE_CONNECTOR_IDS.has(id) && !isFinanceConnectorId(id);
}

/** Samme tillatelsesliste for credential-referanser (`owner_controls` tilbakekall: fri tekst): kun en EKSAKT referanse til en ikke-finanskobling i registeret (også valgfrie) er kjent; alt annet er finansavledet for en sky-/ukjent modell. */
export function isKnownNonFinanceCredentialRef(ref: unknown): boolean {
  return typeof ref === "string" && KNOWN_NON_FINANCE_CREDENTIAL_REFS.has(ref) && !isFinanceCredentialRef(ref);
}

/**
 * Situasjonsdomener som er finansavledede. `situations`-broen (`domainForLoopType`) legger ALLE finans-løkketypene (inkl. markedsutgift) i `spend`, og AI-kostnads-spiken (`spend_anomaly:ai_cost`) har samme domene -
 * så `reason`/`inform_message` for en slik situasjon bærer beløp, leverandør eller AI-kost. Domenenavnet leses fra data og sammenlignes eksakt (store/små bokstaver og mellomrom normaliseres fail-closed).
 */
export const FINANCE_DERIVED_SITUATION_DOMAINS: ReadonlySet<string> = new Set(["spend"]);

/**
 * WP-N1b fiks-runde 1 (FIX-2): situasjonsdomenene som holdes tilbake HELT fra oppmerksomhetskøen for sky/ukjent modell: `spend` (finansavledet: begrunnelsen er løkketeksten) og `infra`. En `infra`-situasjon bærer hendelsestittelen i `reason`
 * (`mapIncidentToCandidate`: «Tilkobling svikter: <tilkobling>», «Bakgrunnsjobben <jobb> ga opp» fra `providerProducer`/`schedulerProducer`) - den kan navngi finanskoblinger og finansjobber, og situasjonsraden har INGEN strukturert kilde
 * (kun `infra_incident:<id>` og tittelteksten) å bevise ikke-finans mot. En tekstfilter på tittelen er ikke nok (ukjent = finans), så hele domenet holdes tilbake; lokal modell og eier ser alt.
 */
export const CLOUD_WITHHELD_ATTENTION_DOMAINS: ReadonlySet<string> = new Set(["spend", "infra"]);

/** Skal situasjoner i dette domenet holdes tilbake fra oppmerksomhetskøen for en sky-/ukjent modell? FAIL-CLOSED: et domene som ikke er en streng regnes som tilbakeholdt. */
export function isCloudWithheldAttentionDomain(domain: unknown): boolean {
  return typeof domain !== "string" || CLOUD_WITHHELD_ATTENTION_DOMAINS.has(domain.trim().toLowerCase());
}

export function isFinanceDerivedSituationDomain(domain: unknown): boolean {
  return typeof domain !== "string" || FINANCE_DERIVED_SITUATION_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * WP-N1b fiks-runde 1 (FIX-6): pakker en LEVERANDØRtransport (uten å endre den) slik at et kall som betjenes av en sky-/ukjent modell får KUN det nøytrale merket og leverandøren ALDRI kalles (ingen forespørsel ut, ingen lesing). Brukes på
 * leverandørhandlinger hvis svar er en penge-/saldoverdi (`telnyx.get_account_info`: kontoens saldo, `GET /v2/balance`), som er finansavledet metadata (Q-64 pkt 1, strengeste regel). Lokal modell, eierens ruter (ingen modell: `/connectors`-
 * livetesten bruker nettopp `get_account_info`) og vakten AV (ingen sentral kontekst) gir det ordinære svaret fra leverandøren, uendret. Lesingen er den SENTRALE (`withholdFinanceFromCurrentModel`): per-kall-kode, aldri delt arbeid.
 */
export function withheldFromCloudTransport(inner: ToolTransport): ToolTransport {
  return {
    async invoke(action, parameters, credential, context, signal) {
      if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as never };
      return inner.invoke(action, parameters, credential, context, signal);
    }
  };
}
