import type { IdentityContext, JsonValue } from "@jarvis/contracts";

/**
 * WP-H0 (UA-11 Admin Control Center, masterplan v4.0 kap. 21 / UA-11-akseptanse): DELT KONTRAKT for de ti kontrollsentrene.
 *
 * Kontrakten er bevisst LITEN og STABIL - flere byggeagenter bygger resten av sentrene (Finance, Memory, Agent, Operations, Value, Privacy, Security) på nøyaktig disse typene,
 * og webflaten (`apps/web/control.html`) leser dem uten byggesteg. Endringer her er en kontraktsendring: legg til felt, aldri fjern eller omdøp (WP-H0 er eneste eier av formen).
 *
 * Fem prinsipper kontrakten håndhever (registeret og `composeControlCenterReport` gjør dem til strukturelle garantier, ikke konvensjon):
 *  1. KILDEFORANKRING: hver seksjon oppgir hvilken tabell/kilde tallene kommer fra (`source`) og når de ble målt (`observed_at`). Kun antall, kategorier og tidsstempler - aldri innhold
 *     (minne, e-post, meldingstekst) og aldri hemmelige verdier (credential-REFERANSER og navn er greit, verdier aldri).
 *  2. ÆRLIG UKJENT: en seksjon som ikke kan måles har `measured: false` og status `UNKNOWN` - aldri `OK` ved feil. `OK` på senternivå krever at ALLE seksjoner er målt og OK.
 *  3. INGEN NYE SKRIVEVEIER: `actions` PEKER på eksisterende, grant-autentiserte POST-ruter (`/executive/mutate`, `/owner-controls/connector-credentials`, ...). Et kontrollsenter utfører
 *     aldri selv noe; webflaten sender handlingen til den eksisterende ruten, som håndhever step-up, Policy Gateway, klasse D-pipelinen og revisjon som før.
 *  4. DETERMINISTISK FORKLARING: `explainControlCenterNo` gir en kort norsk forklaring av hvorfor noe er WARN/FAIL/UNKNOWN fra rapportens egne felt - ingen LLM.
 *  5. EIER-KUN: registeret leverer bare rapporter til den suverene eieren (se `ControlCenterRegistry`); rapportene inneholder konfigurasjonsmetadata og er derfor merket `sensitivity: "PRIVATE"`.
 */

/** De ti sentrene fra masterplan v4.0 kap. 21 (linje 888-905). Id-ene er stabile API-verdier (rute-parameter, verktøyparameter, nøkkel i webflaten). */
export const CONTROL_CENTER_IDS = [
  "integration", "authority", "ai", "finance", "memory", "agent", "operations", "value", "privacy", "security"
] as const;

/**
 * WP-B3 (D-475, EV-22): TILLEGGSSENTRE utenfor masterplanens ti. Masterplanens ti (`CONTROL_CENTER_IDS`) er uendret (og telles fortsatt som «N av 10»); et tilleggssenter er alltid valgfritt og finnes KUN når
 * eierens flagg er på: det listes aldri som «ikke koblet inn», teller ikke i «av 10», og er ikke et gyldig `center`-valg for verktøyskjemaet eller ruten før flagget er på - så med flagget AV er alt som på main.
 */
export const EXTENSION_CONTROL_CENTER_IDS = ["evolution"] as const;
export type ExtensionControlCenterId = (typeof EXTENSION_CONTROL_CENTER_IDS)[number];
export type ControlCenterId = (typeof CONTROL_CENTER_IDS)[number] | ExtensionControlCenterId;
/** Alle kjente sentre i visningsrekkefølge: masterplanens ti, deretter tilleggssentrene. */
export const ALL_CONTROL_CENTER_IDS: readonly ControlCenterId[] = [...CONTROL_CENTER_IDS, ...EXTENSION_CONTROL_CENTER_IDS];

/** Kjent senter-id (masterplanens ti OG tilleggssentre). Om et tilleggssenter er PÅ avgjøres av flagget/registeret, ikke av denne funksjonen. */
export function isControlCenterId(value: unknown): value is ControlCenterId {
  return typeof value === "string" && (ALL_CONTROL_CENTER_IDS as readonly string[]).includes(value);
}

export function isExtensionControlCenterId(value: unknown): value is ExtensionControlCenterId {
  return typeof value === "string" && (EXTENSION_CONTROL_CENTER_IDS as readonly string[]).includes(value);
}

/**
 * Samlet status. Rangering (verst til best): FAIL > WARN > UNKNOWN > OK.
 * UNKNOWN rangerer over OK fordi «ikke målt» aldri skal kunne lese som «i orden»; et kjent problem (WARN/FAIL) rangerer over UNKNOWN fordi det er faktisk bevist.
 */
export const CONTROL_STATUSES = ["OK", "WARN", "FAIL", "UNKNOWN"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

/** Måleverdi i et element: kun skalarer (aldri nøstede objekter/lister, så ingenting kan smugle innhold med). */
export type ControlFactValue = string | number | boolean | null;

/** ÉN rad i en seksjon (f.eks. én connector, én leverandør, én jobb). */
export interface ControlItem {
  /** Stabil id innen seksjonen (f.eks. connector-id) - brukes til å knytte handlinger til raden. */
  id: string;
  /** Visningsnavn. */
  label: string;
  status: ControlStatus;
  /** Kort norsk forklaring - kun antall/kategorier/tidsstempler. */
  detail_no?: string;
  /** Tallfestede kildedata. */
  facts?: Record<string, ControlFactValue>;
  /** Når akkurat denne raden ble målt (ISO), eller null når raden ikke har eget tidspunkt. */
  observed_at?: string | null;
}

/** En seksjon i et kontrollsenter. */
export interface ControlSection {
  id: string;
  title_no: string;
  status: ControlStatus;
  /** `false` = kilden kunne ikke leses/måles. Status er da ALLTID `UNKNOWN` (håndheves av `controlSection`). */
  measured: boolean;
  /** Én setning på norsk. */
  summary_no: string;
  items: ControlItem[];
  /** Hvor tallene kommer fra (tabell/kilde), f.eks. `cost_events` eller `connector-registeret (presence + siste helse; aldri verdier)`. */
  source: string;
  /** Når seksjonen ble målt (ISO), eller null når den ikke kunne måles. */
  observed_at: string | null;
}

/** Risikoklasser A-D styrer HVORDAN en handling utføres (preflight/readback/audit/godkjenning), aldri OM eieren har kapabiliteten (D-41). */
export type ControlRiskClass = "A" | "B" | "C" | "D";

/**
 * Eksisterende, grant-autentiserte POST-ruter en handling kan peke på. Listen er lukket: en handling mot en rute utenfor listen avvises ved konstruksjon (`controlAction`),
 * og webflaten sender aldri noe annet sted. Nye ruter krever en bevisst utvidelse her OG en gjennomgang av ruten (step-up, revisjon).
 */
export const CONTROL_ACTION_ENDPOINTS = [
  "/executive/mutate",
  "/owner-controls/connector-credentials"
] as const;
export type ControlActionEndpoint = (typeof CONTROL_ACTION_ENDPOINTS)[number];

/** Nøklene (utenom `grant_token`) hver rute aksepterer i kroppen - `controlAction` avviser alt annet, og ruten avviser det samme (`grantBodyOrReject`). */
export const CONTROL_ACTION_BODY_KEYS: Readonly<Record<ControlActionEndpoint, readonly string[]>> = {
  "/executive/mutate": ["action", "parameters"],
  "/owner-controls/connector-credentials": ["action", "parameters"]
};

/**
 * Hvilke `action`-verdier en handling kan bære per rute. Listene SPEILER rutenes egne hardkodede allowlister i `apps/api/src/server.ts` (en test låser likheten, så en knapp aldri peker på en handling
 * ruten ville avvist). `null` = ruten har ingen `action`-nøkkel i kroppen. `set_connector_credential` er BEVISST utelatt: kontrollsentre håndterer aldri hemmeligheter (å lime inn en ny verdi skjer i dashbordet).
 */
export const CONTROL_ACTION_ALLOWED: Readonly<Record<ControlActionEndpoint, readonly string[] | null>> = {
  "/executive/mutate": [
    "pause_domain", "resume_domain", "resolve_situation",
    "activate_kill_switch", "deactivate_kill_switch",
    "freeze_connector", "unfreeze_connector",
    "revoke_credential", "restore_credential", "revoke_device",
    "enable_finance_kill_switch", "disable_finance_kill_switch",
    "cancel_task",
    // WP-H2 (additivt): `revoke_autonomy_binding` (klasse C, eier-kun + step-up; kun med JARVIS_CONTROL_AUTONOMY_REVOKE=on) og `run_golden_suite` (klasse A, lesende selvtest; kun med JARVIS_CONTROL_GOLDEN_SUITE=on).
    "revoke_autonomy_binding", "run_golden_suite",
    // WP-B3 (D-475, EV-23; additivt): `record_evolution_decision` (klasse C, eier + signert enhet + step-up; KUN registrering i revisjonssporet, ingen virkning; kun med JARVIS_CONTROL_EVOLUTION_APPROVAL=on).
    "record_evolution_decision"
  ],
  "/owner-controls/connector-credentials": ["test_connector"]
};

/**
 * ÉN handling eieren kan utføre fra kontrollflaten. Rene data - utførelsen skjer ved at webflaten POSTer `{ grant_token, ...body }` til `endpoint`.
 */
export interface ControlAction {
  /** Stabil id, unik i rapporten (f.eks. `integration.freeze:github`). */
  id: string;
  /** Knappetekst på norsk. */
  label: string;
  /** Eksisterende rute (se `CONTROL_ACTION_ENDPOINTS`). */
  endpoint: ControlActionEndpoint;
  /** Kroppen som sendes til `endpoint`, uten `grant_token` (f.eks. `{ action, parameters }`). Aldri identitetsfelt - ruten avviser dem. */
  body: Record<string, JsonValue>;
  risk_class: ControlRiskClass;
  /** `true` når ruten krever step-up (signert enhetsøkt på web/desktop/api/mobile). Webflaten viser det tydelig FØR eieren trykker. */
  requires_step_up: boolean;
  /** `true` når en annen eksisterende handling angrer denne (se `rollback_no`). */
  reversible: boolean;
  /** Hva handlingen gjør - vises i bekreftelsesdialogen. */
  description_no: string;
  /** Hvordan handlingen angres (vises i bekreftelsesdialogen), når `reversible`. */
  rollback_no?: string;
  /** Knytter handlingen til en seksjon/rad (webflaten viser den ved raden). */
  section_id?: string;
  item_id?: string;
}

/** Rapporten for ETT senter. `status` og `summary_no` utledes av `composeControlCenterReport` - en bygger kan ikke påstå en bedre status enn seksjonene gir. */
export interface ControlCenterReport {
  center: ControlCenterId;
  title_no: string;
  generated_at: string;
  status: ControlStatus;
  /** Rapporten er eierens konfigurasjonsmetadata - aldri offentlig. */
  sensitivity: "PRIVATE";
  sections: ControlSection[];
  actions: ControlAction[];
  summary_no: string;
}

/** Det en senterbygger leverer; registeret gjør det til en `ControlCenterReport`. */
export interface ControlCenterParts {
  sections: ControlSection[];
  actions: ControlAction[];
}

export interface ControlCenterBuildContext {
  /** Den betrodde identiteten fra `ToolInvocationContext` (D-68) - aldri fra parametre. All databaselesing skjer under denne identitetens tenant (RLS). */
  identity: IdentityContext;
  now: Date;
  /**
   * WP-H2 (gjennomgang M2): rapporten skal til en SKYmodell (`ExecutiveService.isCloudServed`, håndhevet ved utførelse i transporten). Et senter som har FINANSAVLEDET tilstand utenfor Finans-senteret
   * (Sikkerhet: finans-nødbryteren; Drift: finansjobbene) utelater den da - HELT, ikke bare i teksten - så seksjonsstatus, tellinger og sammendrag ikke bærer den. Utelatt/`false` = hele rapporten
   * (siden uten modell i løkka og en lokal modell, D-378 punkt 2). Senteret setter ALDRI dette selv; kun registeret fra transportens trusted kontekst.
   */
  restrictFinance?: boolean;
}

/** Valg ved bygging av en rapport (trusted lag, aldri fra modell-parametre). */
export interface ControlCenterBuildOptions {
  restrictFinance?: boolean;
}

/**
 * Et kontrollsenter. En bygger kan feile (kaste) eller være treg: registeret gjør det til en `UNKNOWN`-rapport, aldri til en feil som velter oversikten.
 * Hold `build` til lesing av EKSISTERENDE kilder - kontrollsentre skriver ingenting.
 */
export interface ControlCenterDefinition {
  id: ControlCenterId;
  title_no: string;
  description_no: string;
  build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts>;
}

/** Kort sammendrag av én seksjon i oversikten. */
export interface ControlSectionSummary {
  id: string;
  title_no: string;
  status: ControlStatus;
  measured: boolean;
  summary_no: string;
}

export interface ControlCenterSummary {
  center: ControlCenterId;
  title_no: string;
  description_no: string;
  status: ControlStatus;
  generated_at: string;
  sections: ControlSectionSummary[];
  action_count: number;
  summary_no: string;
}

/** Oversikt over ALLE ti sentrene: bygde (registrert) og ikke-bygde (`unregistered`) - et senter som ikke finnes sies å ikke finnes. */
export interface ControlCenterOverview {
  generated_at: string;
  /** Verste status blant de registrerte sentrene; `UNKNOWN` når ingen er registrert. */
  status: ControlStatus;
  sensitivity: "PRIVATE";
  centers: ControlCenterSummary[];
  /** Sentre fra masterplanen som ikke er koblet inn ennå. */
  unregistered: ControlCenterId[];
  /** Gjennomgang M2: registrerte sentre som er HOLDT TILBAKE fra mottakeren (en skymodell får ikke finans, D-378) - ikke bygget, ikke i `centers`, ikke i samlet status. Utelatt når ingenting er holdt tilbake. */
  withheld?: ControlCenterId[];
  summary_no: string;
}
