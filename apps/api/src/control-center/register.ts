// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext } from "@jarvis/contracts";
import { scanForSecrets } from "@jarvis/core";
import { ControlCenterRegistry } from "@jarvis/executive";
import { resolveAuthorityMode, type AuthorityConfig } from "@jarvis/policy";
import { createAiCenter, type AiCenterDeps } from "./ai.ts";
import { createAuthorityCenter, type AuthorityCenterDeps } from "./authority.ts";
import { createIntegrationCenter, type IntegrationCenterDeps } from "./integration.ts";
import type { ControlCenterPool } from "./shared.ts";

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
 * KROKPUNKT FOR NYE SENTRE (Finance, Memory, Agent, Operations, Value, Privacy, Security): legg til én linje i `registerControlCenters()` under, og utvid `ControlCenterWiring` med det senteret trenger
 * (additivt). Agent Center: bruk `agents.ts` (`readActiveTasks`, `activeTaskRows` med avbryt-handlingen) i stedet for en egen jobbleser, så to sentre aldri viser samme jobb med to ulike knapper.
 *
 * VALUE-KROKPUNKT (WP-C4 ER på main, merget 2026-10-09; koblingen hit er bevisst utsatt til H1/H2): verdirapporten kommer fra `ExecutiveService.getValueReport(tenantId)` → `ValueReport` med verdiløkker V1-V5,
 * Builder Loop-beredskap og V5-forslag (`modules/executive/src/value/*`; `main.ts` gir tjenesten `value: { source, facts }`). Når den kobles: (1) legg til `valueReport?: (tenantId: string) => Promise<ValueReport>` i
 * `ControlCenterWiring`, (2) lag `value.ts` i denne mappen (`createValueCenter`: én seksjon per verdiløkke, `measured` fra rapporten, ingen egne handlinger - V2-push og V5-forslag har egne brytere), og
 * (3) registrer den her med id `value`. Til da står `value` i oversiktens `unregistered`-liste (aldri «i orden»).
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
  /** Modellmeshens kompakte status (leverandørhelse) - gir modellleverandørene i Integration Center og AI Center en helse. */
  meshStatus?: IntegrationCenterDeps["meshStatus"];
  /** AI Center: ModelGateway (kun lesing: leverandørvisning, mesh, rådgivermodus). Uten gatewayen, verktøyregisteret og eier-kontrollene registreres ikke senteret. */
  modelGateway?: AiCenterDeps["gateway"];
  /** AI Center: run-rate (D-421), AI-rådets begrenser, evolusjonsrapporten (EV-12) og taket for samtidige bakgrunnsjobber. Utelatt = den delen står som ukjent. */
  runRate?: AiCenterDeps["runRate"];
  councilLimiter?: AiCenterDeps["councilLimiter"];
  evolutionReport?: AiCenterDeps["evolutionReport"];
  maxActiveJobs?: AiCenterDeps["maxActiveJobs"];
}

export function registerControlCenters(registry: ControlCenterRegistry, wiring: ControlCenterWiring): void {
  // Sentrene registreres her, ett per linje, etterhvert som de bygges. Et senter uten sine avhengigheter registreres IKKE (ærlig «ikke koblet inn», aldri en tom OK).
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
      ...(wiring.maxActiveJobs !== undefined ? { maxActiveJobs: wiring.maxActiveJobs } : {})
    }));
  }
  if (wiring.toolGateway && wiring.ownerControls && wiring.killSwitch) {
    registry.register(createAuthorityCenter({
      pool: wiring.pool, env: wiring.env, toolGateway: wiring.toolGateway, ownerControls: wiring.ownerControls, killSwitch: wiring.killSwitch,
      ...(wiring.authority ? { authority: wiring.authority } : {}),
      ...(wiring.infraGate ? { infraGate: wiring.infraGate } : {})
    }));
  }
}
