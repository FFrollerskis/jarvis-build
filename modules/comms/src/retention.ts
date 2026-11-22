import type { MemorySpace } from "@jarvis/contracts";
import { InvalidCommsConfigError } from "./config.ts";

/**
 * WP-G1 fiks-runde B-M6: retensjonssveipet for kommunikasjonsdata (innkommende hendelser, journalrader, møter). Tre feil ble rettet:
 *  1. Sveipet var en `setInterval` på 6 timer UTEN kjøring ved oppstart - en prosess som restartes oftere enn hver 6. time slettet aldri noe. Nå kjører det UMIDDELBART ved oppstart og deretter hver 6. time.
 *  2. Kun eierens tenants ble sveipet, og `JARVIS_COMMS_TENANT_ID` (tenanten webhook-hendelsene skrives til) ble ikke validert mot dem - hendelser i en tenant utenfor listen ble aldri slettet. Nå MÅ webhook-tenanten være en av eierens
 *     tenants (ellers stopper oppstarten - en feilkonfigurasjon som ville skrevet personopplysninger til en tenant ingen sveiper), og den er alltid med.
 *  3. Oppkoblingen var utestet. Logikken bor nå her, uavhengig av database og klokke (injiserte `purge`/timer), slik at hver del kan bevises.
 */
export const RETENTION_INTERVAL_MS = 6 * 3_600_000;
/** Rommene kommunikasjon kan skje i (helse/hjem/gjest er aldri mål for kommunikasjon). */
export const RETENTION_SPACES: readonly MemorySpace[] = ["business", "personal", "project", "shared"];

/** Hvilke tenants skal sveipes? Eierens tenants; webhook-tenanten (hvis satt) MÅ være blant dem. Ingen duplikater. */
export function retentionTenants(ownerTenants: readonly string[], webhookTenantId: string | null): string[] {
  if (webhookTenantId !== null && !ownerTenants.includes(webhookTenantId)) {
    throw new InvalidCommsConfigError("JARVIS_COMMS_TENANT_ID", "må være en av eierens tenants (ellers sveipes aldri hendelsene som skrives dit)");
  }
  return [...new Set(ownerTenants)];
}

export interface RetentionDeps {
  readonly tenants: readonly string[];
  readonly spaces?: readonly MemorySpace[];
  /** Sletter utløpte rader for én tenant og ett rom. */
  readonly purge: (tenantId: string, space: MemorySpace) => Promise<unknown>;
  readonly warn?: (event: Record<string, unknown>) => void;
}

/** Ett sveip over alle tenants og rom. En feil på ett (tenant, rom) logges (kode, aldri tekst) og stopper aldri de andre. */
export async function runRetentionSweep(deps: RetentionDeps): Promise<{ attempted: number; failed: number }> {
  let attempted = 0;
  let failed = 0;
  for (const tenantId of deps.tenants) {
    for (const space of deps.spaces ?? RETENTION_SPACES) {
      attempted += 1;
      try {
        await deps.purge(tenantId, space);
      } catch (err) {
        failed += 1;
        deps.warn?.({ msg: "comms_retention_sweep_failed", error: err instanceof Error ? err.message.slice(0, 80) : "unknown" });
      }
    }
  }
  return { attempted, failed };
}

/** Starter sveipet: kjører UMIDDELBART (ikke avventet - oppstarten blokkeres ikke) og deretter hver `intervalMs`. Timeren holder aldri prosessen i live (`unref`). Returnerer en stopper og løftet for første kjøring. */
export function startRetentionSweep(deps: RetentionDeps & { intervalMs?: number }): { stop(): void; first: Promise<{ attempted: number; failed: number }> } {
  const run = (): Promise<{ attempted: number; failed: number }> => runRetentionSweep(deps);
  const first = run();
  const timer = setInterval(() => void run(), deps.intervalMs ?? RETENTION_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), first };
}
