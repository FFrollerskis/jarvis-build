// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { ControlCenterRegistry } from "@jarvis/executive";

/**
 * WP-H0 (UA-11 Admin Control Center): ÉN plass der kontrollsentrene kobles til registeret. Hvert senter er en `ControlCenterDefinition` (se `@jarvis/executive` sin `control-center/types.ts`) i sin
 * EGEN fil i denne mappen (`integration.ts`, `authority.ts`, `ai.ts`, ...), slik at flere byggeagenter kan legge til sentre uten å røre hverandres filer.
 *
 * KROKPUNKT FOR NYE SENTRE (Finance, Memory, Agent, Operations, Value, Privacy, Security): legg til én linje i `registerControlCenters()` under, og utvid `ControlCenterWiring` med det senteret trenger
 * (additivt). Value-senteret (WP-C4) registreres her med id `value` når verdiløkke-rapporten finnes på main - til da står `value` i oversiktens `unregistered`-liste.
 *
 * `main.ts` bygger `ControlCenterWiring` ÉN gang fra de allerede konstruerte tjenestene (ingen nye instanser, ingen ny tilkobling). Sentrene leser kun eksisterende kilder; de skriver ingenting.
 */
export type ControlCenterPool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

export interface ControlCenterWiring {
  /** App-rollens pool. All tenant-lesing skjer via `withTenantTransaction` under identitetens tenant (RLS). */
  pool: ControlCenterPool;
  /** Miljøet sentrene leser konfigurasjon fra (injiserbart for tester). Verdier av hemmelige variabler leses ALDRI - kun om de er satt. */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

export function registerControlCenters(registry: ControlCenterRegistry, wiring: ControlCenterWiring): void {
  void registry;
  void wiring;
  // Sentrene registreres her, ett per linje, etterhvert som de bygges (WP-H0: Integration, Authority, AI).
}
