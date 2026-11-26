// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext } from "@jarvis/contracts";
import { scanForSecrets } from "@jarvis/core";
import { ControlCenterRegistry, type ControlRiskClass, type GoldenSuiteControl, type InfraStatusReport, type ValueReport } from "@jarvis/executive";
import { claudeBudgetConfigFromEnv, type ClaudeBudgetConfig } from "@jarvis/model-gateway";
import { resolveAuthorityMode, type AuthorityConfig } from "@jarvis/policy";
import type { ReadinessVerdict } from "@jarvis/self-modification";
import type { BackupStatusRead } from "../backup-status.ts";
import type { Ev0BootStatus } from "../ev0-boot.ts";
import { actionRequiresStepUp } from "../step-up.ts";
import { visionFlagsFromEnv } from "../vision-flags.ts";
import { createAgentCenter } from "./agent.ts";
import { createAiCenter, type AiCenterDeps } from "./ai.ts";
import { createAuthorityCenter, type AuthorityCenterDeps } from "./authority.ts";
import { createEvolutionCenter, type EvolutionReportRead } from "./evolution.ts";
import { createFinanceCenter } from "./finance.ts";
import { createIntegrationCenter, type IntegrationCenterDeps } from "./integration.ts";
import { createMemoryCenter } from "./memory.ts";
import { createOperationsCenter } from "./operations.ts";
import { createPrivacyCenter } from "./privacy.ts";
import type { PrivacyVisionSource } from "./privacy-vision.ts";
import { createSecurityCenter } from "./security.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, flagOn, type ControlCenterPool } from "./shared.ts";
import { createValueCenter } from "./value.ts";

export type { ControlCenterPool } from "./shared.ts";

/**
 * Gjennomgang av PR #316 (M-2) - EIER-PORTEN OG SISTE FORSVARSLINJE ER ÉN FABRIKK, brukt av BÅDE `main.ts` og testene.
 *
 * Tidligere satt `main.ts` sammen eier-predikatet (`resolveAuthorityMode(...) === "SOVEREIGN"`) og redigereren (`scanForSecrets`) inline, og INGEN test låste den koblingen: å endre predikatet til
 * `!== "DENIED"` (`resolveAuthorityMode` returnerer aldri DENIED, så alle SCOPED-identiteter ville sluppet inn) eller redigereren til `(t) => t` ga fortsatt grønne tester. Konsekvens hvis koblingen glir:
 * enhver innrullert person kunne lest sentrene og kalt `executive.cancel_task` (klasse B, uten step-up).
 *
 * Nå: `ownerPredicate(authority)` er eneste sted predikatet finnes, bygget fra DEN SAMME `AuthorityConfig`-en som `PolicyGateway` får; `createControlCenterRegistry` er eneste måte produksjonskoden lager
 * registeret på, og redigereren (`scanForSecrets`) er FAST der - den er ikke en parameter, så `main.ts` kan ikke overstyre den (registeret avviser i tillegg enhver redigerer som ikke redigerer,
 * `isEffectiveRedactor`). Wiring-testen (`wph0-control-wiring.test.ts`) leser `main.ts` som tekst og kjører ikke-eier-identiteter mot registeret.
 */
export function ownerPredicate(authority: AuthorityConfig): (identity: IdentityContext) => boolean {
  return (identity) => resolveAuthorityMode(authority, identity) === "SOVEREIGN";
}

// Flaggobjektene (`CONTROL_CENTER_FLAGS`, `CONTROL_FEATURE_FLAGS`) bor i `shared.ts` og re-eksporteres her (se kommentaren der): `main.ts` leser dem derfra, så importlinjen fra denne fabrikken forblir uendret.
export { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS };

/** Redigerer hemmeligheter i alle menneskelesbare strenger i en rapport (siste forsvarslinje). FAST: ikke en parameter noe sted. */
const redactSecrets = (text: string): string => scanForSecrets(text).text;

export interface ControlCenterRegistryWiring {
  /** Samme eier-autoritetskonfigurasjon som `PolicyGateway` (ett objekt i `main.ts`). Ingen redigerer og ingen eier-predikat kan oppgis her. */
  authority: AuthorityConfig;
  now?: () => Date;
  buildTimeoutMs?: number;
}

/** Eneste måte produksjonskoden lager kontrollsenter-registeret på. Fail-closed: en eier-konfigurasjon uten eier-person eller uten eier-tenant gir ingen eier (og avvises ved oppstart). */
export function createControlCenterRegistry(wiring: ControlCenterRegistryWiring): ControlCenterRegistry {
  const { authority } = wiring;
  if (typeof authority?.owner_person_id !== "string" || authority.owner_person_id.trim() === "") throw new Error("control_center_authority_missing_owner_person");
  if (!Array.isArray(authority.owner_tenants) || authority.owner_tenants.length === 0 || authority.owner_tenants.some((t) => typeof t !== "string" || t.trim() === "")) {
    throw new Error("control_center_authority_missing_owner_tenant");
  }
  return new ControlCenterRegistry({
    isOwner: ownerPredicate(authority),
    redact: redactSecrets,
    ...(wiring.now !== undefined ? { now: wiring.now } : {}),
    ...(wiring.buildTimeoutMs !== undefined ? { buildTimeoutMs: wiring.buildTimeoutMs } : {})
  });
}

/**
 * WP-H0 (UA-11 Admin Control Center): ÉN plass der kontrollsentrene kobles til registeret. Hvert senter er en `ControlCenterDefinition` (se `@jarvis/executive` sin `control-center/types.ts`) i sin
 * EGEN fil i denne mappen (`integration.ts`, `authority.ts`, `ai.ts`, ...), slik at flere byggeagenter kan legge til sentre uten å røre hverandres filer.
 *
 * KROKPUNKT FOR NYE SENTRE (Operations, Value, Privacy, Security - H2): legg til én linje i `registerControlCenters()` under, og utvid `ControlCenterWiring` med det senteret trenger
 * (additivt). WP-H1 koblet inn Finance (`finance.ts`), Memory (`memory.ts`) og Agent (`agent.ts`, som bruker `agents.ts`: `readActiveTasks`/`activeTaskRows` med avbryt-handlingen, så to sentre aldri viser
 * samme jobb med to ulike knapper) - hver bak sitt flagg i `CONTROL_CENTER_FLAGS`.
 *
 * WP-H2 koblet inn Drift (`operations.ts`), Verdi (`value.ts`), Personvern (`privacy.ts`) og Sikkerhet (`security.ts`) - hver bak sitt flagg i `CONTROL_CENTER_FLAGS`. Drift og Verdi leser rapportene til `ExecutiveService`
 * (`getInfraStatus`/`getValueReport`, WP-E1/WP-C4) gjennom LATE funksjoner i `ControlCenterWiring` (tjenesten bygges etter sentrene i `main.ts`); de lager ingen egen kobling og har ingen egne handlinger.
 * Til sammen er alle ti sentre fra masterplan kap. 21 koblet inn bak flagg - et senter uten flagg (eller uten sine avhengigheter) står i oversiktens `unregistered`-liste («ikke koblet inn», aldri «i orden»).
 *
 * `main.ts` bygger `ControlCenterWiring` ÉN gang fra de allerede konstruerte tjenestene (ingen nye instanser, ingen ny tilkobling). Sentrene leser kun eksisterende kilder; de skriver ingenting.
 */
export interface ControlCenterWiring {
  /** App-rollens pool. All tenant-lesing skjer via `withTenantTransaction` under identitetens tenant (RLS). */
  pool: ControlCenterPool;
  /** Miljøet sentrene leser konfigurasjon fra (injiserbart for tester). Verdier av hemmelige variabler leses ALDRI - kun om de er satt. */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  /** Integration Center: den ene ToolGateway-instansen (presence, helse, verktøyregister) og eier-kontrollene (frosset/tilbakekalt). Uten disse registreres ikke senteret (det står da som «ikke koblet inn»). */
  toolGateway?: IntegrationCenterDeps["toolGateway"] & AuthorityCenterDeps["toolGateway"];
  ownerControls?: IntegrationCenterDeps["ownerControls"];
  /** Authority Center: eier-autoritetskonfigurasjonen (samme objekt som Policy Gateway), kill switch og infra-porten. Uten `killSwitch` registreres ikke Authority Center. */
  authority?: AuthorityCenterDeps["authority"];
  killSwitch?: AuthorityCenterDeps["killSwitch"];
  infraGate?: AuthorityCenterDeps["infraGate"];
  /** WP-K (JARVIS-053): status for den varige policy-journalen. Utelatt (journalen er AV) = ingen ekstra rad i Authority Center. */
  policyAudit?: AuthorityCenterDeps["policyAudit"];
  /** Modellmeshens kompakte status (leverandørhelse) - gir modellleverandørene i Integration Center og AI Center en helse. */
  meshStatus?: IntegrationCenterDeps["meshStatus"];
  /** AI Center: ModelGateway (kun lesing: leverandørvisning, mesh, rådgivermodus). Uten gatewayen, verktøyregisteret og eier-kontrollene registreres ikke senteret. */
  modelGateway?: AiCenterDeps["gateway"];
  /** AI Center: run-rate (D-421), AI-rådets begrenser, evolusjonsrapporten (EV-12) og taket for samtidige bakgrunnsjobber. Utelatt = den delen står som ukjent. */
  runRate?: AiCenterDeps["runRate"];
  councilLimiter?: AiCenterDeps["councilLimiter"];
  /** Evolusjonsrapporten (D-452). Brukes av AI-senteret (EV-12) og, fra WP-B3 (D-475), av Evolusjon-senteret (portstatus). */
  evolutionReport?: EvolutionReportRead;
  maxActiveJobs?: AiCenterDeps["maxActiveJobs"];
  /** WP-B3 (D-475) Evolusjon-senteret: strukturerte beredskapsvurderinger for de sovende delene (`createEvolutionReadinessProvider`), EV-0-oppstartsresultatet og tenanten rapportleverandøren er bundet til (eierens). Utelatt = den delen er UKJENT. */
  evolutionReadiness?: () => Promise<readonly ReadinessVerdict[]>;
  ev0Status?: () => Ev0BootStatus | null;
  evolutionTenantId?: string;
  /** WP-H2 Value Center: `ExecutiveService.getValueReport` (lat - tjenesten bygges etter sentrene). Uten den registreres ikke Verdi-senteret. */
  valueReport?: (tenantId: string) => Promise<ValueReport>;
  /** WP-H2 Operations Center: `ExecutiveService.getInfraStatus` (lat). Uten den registreres ikke Drift-senteret. */
  infraStatus?: (tenantId: string) => Promise<InfraStatusReport>;
  /** WP-H2 Operations Center: backup-statusfilen (`backupStatusSourceFromEnv()`); utelatt = backup og restore-øvelser er UKJENT. */
  backupStatus?: () => Promise<BackupStatusRead>;
  /** WP-H2 Operations Center: når API-prosessen startet (prosess-oppetid). */
  processStartedAt?: () => Date;
  /** WP-H2 Security Center: golden-suite-kjøreren. Brukes KUN med `JARVIS_CONTROL_GOLDEN_SUITE=on`. */
  goldenSuite?: GoldenSuiteControl;
  /**
   * WP-G3b (D-485): Syn-kortet i Personvern-senteret (kun lesing; lat status fordi kjøretiden bygges etter sentrene). `main.ts` gir den KUN med JARVIS_VISION_ENABLED=on, og `registerControlCenters` sjekker flagget en gang til:
   * uten begge (og uten Personvern-flagget) finnes ikke kortet, og senteret er byte-identisk med main.
   */
  vision?: PrivacyVisionSource;
  /**
   * WP-N1b fiks-runde 1 (FIX-1): `true` KUN med begrenset-vakten PÅ (satt fra `main.ts`). Sikkerhet-senteret bygget for en skymodell holder da finanskoblinger/-credentials og `spend`-pausen ute av listene og tellingene.
   * Utelatt (vakten AV) = nøyaktig H2-oppførselen (main) - nøkkelen settes ikke engang.
   */
  financeGuard?: true;
}

/** Lat oppslag av klassen til en registrert executive-handling: `undefined` når verktøyet ikke (ennå/lenger) er registrert i gatewayen - aldri en gjettet klasse. Kaster aldri. */
function riskClassOf(gateway: { get(toolId: string, action: string): { capability_class: ControlRiskClass } | undefined }, action: string): () => ControlRiskClass | undefined {
  return () => {
    try {
      return gateway.get("executive", action)?.capability_class;
    } catch {
      return undefined;
    }
  };
}

/**
 * WP-B4 (D-476): Claude-kreditten fra miljøet, eller `undefined` når flagget (`JARVIS_CLAUDE_BUDGET_USD`) er AV. En UGYLDIG verdi stopper oppstarten i `main.ts` (samme parser, før gatewayen bygges) - kommer vi hit med en,
 * viser senteret heller ingenting enn å kaste (kontrollsentrene er kun lesing og skal aldri kunne velte byggingen av en side).
 */
export function claudeBudgetFromEnv(env: Readonly<Record<string, string | undefined>>): ClaudeBudgetConfig | undefined {
  try {
    return claudeBudgetConfigFromEnv(env) ?? undefined;
  } catch {
    return undefined;
  }
}

export function registerControlCenters(registry: ControlCenterRegistry, wiring: ControlCenterWiring): void {
  // Sentrene registreres her, ett per linje, etterhvert som de bygges. Et senter uten sine avhengigheter registreres IKKE (ærlig «ikke koblet inn», aldri en tom OK).
  const claudeBudget = claudeBudgetFromEnv(wiring.env);
  if (wiring.toolGateway && wiring.ownerControls) {
    registry.register(createIntegrationCenter({
      pool: wiring.pool, toolGateway: wiring.toolGateway, ownerControls: wiring.ownerControls,
      ...(wiring.meshStatus ? { meshStatus: wiring.meshStatus } : {})
    }));
  }
  if (wiring.modelGateway && wiring.toolGateway && wiring.ownerControls) {
    registry.register(createAiCenter({
      pool: wiring.pool, env: wiring.env, gateway: wiring.modelGateway, ownerControls: wiring.ownerControls, toolGateway: wiring.toolGateway,
      ...(wiring.runRate ? { runRate: wiring.runRate } : {}),
      ...(wiring.councilLimiter ? { councilLimiter: wiring.councilLimiter } : {}),
      ...(wiring.evolutionReport ? { evolutionReport: wiring.evolutionReport } : {}),
      ...(wiring.maxActiveJobs !== undefined ? { maxActiveJobs: wiring.maxActiveJobs } : {}),
      ...(claudeBudget !== undefined ? { claudeBudget } : {})
    }));
  }
  if (wiring.toolGateway && wiring.ownerControls && wiring.killSwitch) {
    registry.register(createAuthorityCenter({
      pool: wiring.pool, env: wiring.env, toolGateway: wiring.toolGateway, ownerControls: wiring.ownerControls, killSwitch: wiring.killSwitch,
      ...(wiring.authority ? { authority: wiring.authority } : {}),
      ...(wiring.infraGate ? { infraGate: wiring.infraGate } : {}),
      ...(wiring.policyAudit ? { policyAudit: wiring.policyAudit } : {}),
      // WP-H2: per-binding tilbakekall-knapp i Autoritet-senteret - kun med JARVIS_CONTROL_AUTONOMY_REVOKE=on (uten flagg er senteret uendret fra H0).
      ...(flagOn(wiring.env, CONTROL_FEATURE_FLAGS.autonomyRevoke) ? { autonomyRevoke: true } : {})
    }));
  }
  // WP-H1: Finans, Minne og Agenter - hver bak sitt flagg (AV som standard), kun lesing av eksisterende tabeller. Uten verktøyregisteret (risikoklasse for knappene) registreres ikke Finans/Agenter.
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.finance) && wiring.toolGateway) registry.register(createFinanceCenter({ pool: wiring.pool, toolGateway: wiring.toolGateway }));
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.memory)) registry.register(createMemoryCenter({ pool: wiring.pool, env: wiring.env }));
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.agent) && wiring.toolGateway) registry.register(createAgentCenter({ pool: wiring.pool, toolGateway: wiring.toolGateway }));
  // WP-H2: Drift, Verdi, Personvern og Sikkerhet - hver bak sitt flagg (AV som standard), kun lesing av eksisterende kilder. Et senter uten sine avhengigheter registreres IKKE (ærlig «ikke koblet inn»).
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.operations) && wiring.infraStatus) {
    registry.register(createOperationsCenter({
      pool: wiring.pool, infraStatus: wiring.infraStatus,
      ...(wiring.backupStatus ? { backupStatus: wiring.backupStatus } : {}),
      ...(wiring.processStartedAt ? { processStartedAt: wiring.processStartedAt } : {}),
      ...(wiring.maxActiveJobs !== undefined ? { maxActiveJobs: wiring.maxActiveJobs } : {})
    }));
  }
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.value) && wiring.valueReport) registry.register(createValueCenter({ valueReport: wiring.valueReport }));
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.privacy)) {
    registry.register(createPrivacyCenter({
      pool: wiring.pool, env: wiring.env,
      // WP-G3b (D-485): Syn-kortet finnes KUN når kilden er gitt OG hovedbryteren `JARVIS_VISION_ENABLED` er eksakt `on` (samme tolkning som resten av UA-9: `visionFlagsFromEnv`).
      ...(wiring.vision !== undefined && visionFlagsFromEnv(wiring.env as NodeJS.ProcessEnv).enabled ? { vision: wiring.vision } : {})
    }));
  }
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.security) && wiring.toolGateway && wiring.ownerControls && wiring.killSwitch) {
    registry.register(createSecurityCenter({
      pool: wiring.pool, toolGateway: wiring.toolGateway, ownerControls: wiring.ownerControls, killSwitch: wiring.killSwitch,
      ...(wiring.financeGuard === true ? { financeGuard: true } : {}),
      ...(flagOn(wiring.env, CONTROL_FEATURE_FLAGS.goldenSuite) && wiring.goldenSuite ? { goldenSuite: wiring.goldenSuite } : {})
    }));
  }
  // WP-B3 (D-475, EV-22): Evolusjon (tilleggssenter utenfor de ti) bak eget flagg (AV som standard). Uten evolusjonsrapporten (portstatus) registreres det IKKE (ærlig «ikke koblet inn»); kun lesing av eksisterende kilder.
  if (flagOn(wiring.env, CONTROL_CENTER_FLAGS.evolution) && wiring.evolutionReport) {
    registry.register(createEvolutionCenter({
      pool: wiring.pool, env: wiring.env, evolutionReport: wiring.evolutionReport,
      ...(wiring.evolutionReadiness ? { readiness: wiring.evolutionReadiness } : {}),
      ...(wiring.ev0Status ? { ev0Status: wiring.ev0Status } : {}),
      ...(wiring.runRate ? { runRate: wiring.runRate } : {}),
      ...(wiring.evolutionTenantId !== undefined ? { reportTenantId: wiring.evolutionTenantId } : {}),
      // WP-B3 (EV-23): «Registrer avgjørelse»-knappene per forslag - kun med JARVIS_CONTROL_EVOLUTION_APPROVAL=on (og kun når verktøyet faktisk er registrert i gatewayen, sjekkes ved bygging). Uten flagg er senteret uendret fra EV-22.
      // Risikoklassen slås opp LATT (verktøyene registreres i gatewayen etter sentrene i `main.ts`); step-up-kravet utledes av den ene `STEP_UP_EXEMPT_ACTIONS`-mengden, aldri av en kopi.
      ...(flagOn(wiring.env, CONTROL_FEATURE_FLAGS.evolutionApproval) && wiring.toolGateway
        ? { approval: { risk_class: riskClassOf(wiring.toolGateway, "record_evolution_decision"), requires_step_up: actionRequiresStepUp("record_evolution_decision") } }
        : {})
    }));
  }
}
