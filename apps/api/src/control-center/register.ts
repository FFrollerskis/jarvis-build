// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { ControlCenterRegistry } from "@jarvis/executive";
import { createAiCenter, type AiCenterDeps } from "./ai.ts";
import { createAuthorityCenter, type AuthorityCenterDeps } from "./authority.ts";
import { createIntegrationCenter, type IntegrationCenterDeps } from "./integration.ts";
import type { ControlCenterPool } from "./shared.ts";

export type { ControlCenterPool } from "./shared.ts";

/**
 * WP-H0 (UA-11 Admin Control Center): ÉN plass der kontrollsentrene kobles til registeret. Hvert senter er en `ControlCenterDefinition` (se `@jarvis/executive` sin `control-center/types.ts`) i sin
 * EGEN fil i denne mappen (`integration.ts`, `authority.ts`, `ai.ts`, ...), slik at flere byggeagenter kan legge til sentre uten å røre hverandres filer.
 *
 * KROKPUNKT FOR NYE SENTRE (Finance, Memory, Agent, Operations, Value, Privacy, Security): legg til én linje i `registerControlCenters()` under, og utvid `ControlCenterWiring` med det senteret trenger
 * (additivt). Agent Center: bruk `agents.ts` (`readActiveTasks`, `activeTaskRows` med avbryt-handlingen) i stedet for en egen jobbleser, så to sentre aldri viser samme jobb med to ulike knapper.
 *
 * VALUE-KROKPUNKT (WP-C4 er IKKE på main ennå; sjekket mot origin/main 2026-10-09): verdirapporten bygges i grenen `claude/wp-c4-value-center` (`ExecutiveService.getValueReport(tenantId)` →
 * `ValueReport` med verdiløkker V1-V5, Builder Loop-beredskap og V5-forslag, `modules/executive/src/value/*`). Når den er merget: (1) legg til `valueReport?: (tenantId: string) => Promise<ValueReport>` i
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
