// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { ControlCenterRegistry } from "@jarvis/executive";
import { createAuthorityCenter, type AuthorityCenterDeps } from "./authority.ts";
import { createIntegrationCenter, type IntegrationCenterDeps } from "./integration.ts";
import type { ControlCenterPool } from "./shared.ts";

export type { ControlCenterPool } from "./shared.ts";

/**
 * WP-H0 (UA-11 Admin Control Center): ÉN plass der kontrollsentrene kobles til registeret. Hvert senter er en `ControlCenterDefinition` (se `@jarvis/executive` sin `control-center/types.ts`) i sin
 * EGEN fil i denne mappen (`integration.ts`, `authority.ts`, `ai.ts`, ...), slik at flere byggeagenter kan legge til sentre uten å røre hverandres filer.
 *
 * KROKPUNKT FOR NYE SENTRE (Finance, Memory, Agent, Operations, Value, Privacy, Security): legg til én linje i `registerControlCenters()` under, og utvid `ControlCenterWiring` med det senteret trenger
 * (additivt). Value-senteret (WP-C4) registreres her med id `value` når verdiløkke-rapporten finnes på main - til da står `value` i oversiktens `unregistered`-liste.
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
}

export function registerControlCenters(registry: ControlCenterRegistry, wiring: ControlCenterWiring): void {
  // Sentrene registreres her, ett per linje, etterhvert som de bygges. Et senter uten sine avhengigheter registreres IKKE (ærlig «ikke koblet inn», aldri en tom OK).
  if (wiring.toolGateway && wiring.ownerControls) {
    registry.register(createIntegrationCenter({
      pool: wiring.pool, toolGateway: wiring.toolGateway, ownerControls: wiring.ownerControls,
      ...(wiring.meshStatus ? { meshStatus: wiring.meshStatus } : {})
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
