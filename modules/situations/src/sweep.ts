import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { BusinessOpenLoop } from "@jarvis/business";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { mapOpenLoopToCandidate } from "./open-loop-bridge.ts";
import { SituationDetectionKeyConflictError, type SituationEngine } from "./service.ts";
import type { AutoActResult, InformDeliveryResult } from "./types.ts";

/**
 * UA-10 P1 AKTIVERING (D-160): den periodiske sveipen som gjør motoren
 * LEVENDE. Én syklus per (tenant, space) i FAST rekkefølge:
 *
 *   1. INGEST   - hver åpen `business_open_loop` -> `evaluateCandidate()`
 *                 via den rene broen (open-loop-bridge.ts). Idempotent:
 *                 samme loop => samme situasjon.
 *   2. RESOLVE  - situasjoner hvis kilde-loop er løst, løses.
 *   3. DELIVER  - ventende INFORM/SUGGEST-varsler leveres (evidens-først,
 *                 én per syklus-nøkkel).
 *   4. AUTO-ACT - situasjoner i `suggest` med en AKTIVERT eier-policy for
 *                 domenet -> `actOn()`. Uten policy skjer INGENTING her.
 *
 * Feilisolasjon på TRE nivåer (samme disiplin som `runOpenLoopSweepForAllTenants`):
 * én loop som kaster velter ikke resten av ingest-en, ett steg som kaster
 * velter ikke de neste stegene (tellinger + `errors[]`), og én tenant
 * velter aldri de andre.
 *
 * Tenant-katalogen leses via den DELTE, RLS-trygge `listBusinessTenantIds()`
 * (Q-27/D-65) - aldri en rå spørring mot `tenants`.
 */

/** Det minimale `OpenLoopService`-utsnittet sveipen trenger - et interface, så testene kan gi en ren fake uten embedded Postgres for orkestreringsbeviset. */
export interface OpenLoopReader {
  listOpenLoops(tenantId: string, memorySpace: MemorySpace, status: "open" | "resolved" | "all"): Promise<BusinessOpenLoop[]>;
}

export interface SituationSweepDeps {
  openLoops: OpenLoopReader;
  engine: SituationEngine;
  gateway: ToolGateway;
  /** Identiteten leveranse og auto-ACT kjører under - MÅ ha `tenant_id`/`memory_space_id` lik sveipens (motoren avviser ellers, fail-closed). */
  identity: IdentityContext;
  now?: () => number;
}

export interface SituationSweepResult {
  ingested: number;
  /** Kandidater som ble avvist av `evaluateCandidate()` fordi den lagrede situasjonens identitet er en annen (aldri stille overskrevet). */
  identity_conflicts: number;
  resolved_from_source: number;
  delivery: InformDeliveryResult;
  auto_act: AutoActResult;
  /** Korte, sanerte feilbeskrivelser per steg - aldri hemmeligheter/rådata. */
  errors: string[];
}

const emptyDelivery = (): InformDeliveryResult => ({ delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0 });
const emptyAutoAct = (): AutoActResult => ({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
const describe = (err: unknown): string => (err instanceof Error ? `${err.name}:${err.message.slice(0, 120)}` : "unknown_error");

export async function runSituationSweep(tenantId: string, memorySpace: MemorySpace, deps: SituationSweepDeps): Promise<SituationSweepResult> {
  const result: SituationSweepResult = {
    ingested: 0,
    identity_conflicts: 0,
    resolved_from_source: 0,
    delivery: emptyDelivery(),
    auto_act: emptyAutoAct(),
    errors: []
  };
  const now = deps.now ?? Date.now;

  // 1. INGEST
  try {
    const openLoops = await deps.openLoops.listOpenLoops(tenantId, memorySpace, "open");
    for (const loop of openLoops) {
      try {
        await deps.engine.evaluateCandidate(tenantId, memorySpace, mapOpenLoopToCandidate(loop), now());
        result.ingested += 1;
      } catch (err) {
        if (err instanceof SituationDetectionKeyConflictError) {
          result.identity_conflicts += 1;
        } else {
          result.errors.push(`ingest:${loop.open_loop_id}:${describe(err)}`);
        }
      }
    }
  } catch (err) {
    result.errors.push(`ingest:${describe(err)}`);
  }

  // 2. RESOLVE
  try {
    const resolvedLoops = await deps.openLoops.listOpenLoops(tenantId, memorySpace, "resolved");
    result.resolved_from_source = await deps.engine.resolveForResolvedSources(
      tenantId,
      memorySpace,
      resolvedLoops.map((loop) => loop.open_loop_id)
    );
  } catch (err) {
    result.errors.push(`resolve:${describe(err)}`);
  }

  // 3. DELIVER
  try {
    result.delivery = await deps.engine.deliverPendingInformNotifications(tenantId, memorySpace, deps.gateway, deps.identity);
  } catch (err) {
    result.errors.push(`deliver:${describe(err)}`);
  }

  // 4. AUTO-ACT
  try {
    result.auto_act = await deps.engine.autoActPending(tenantId, memorySpace, deps.gateway, deps.identity);
  } catch (err) {
    result.errors.push(`auto_act:${describe(err)}`);
  }

  return result;
}

/**
 * Arkitekt-review runde 1 på PR #86 (5229219808, funn 3): `runSituationSweep()`
 * fanger leveranse-/auto-ACT-feil i `errors[]` og resolver normalt, og den
 * første scheduler-wiringen kastet resultatet med `.then(() => undefined)` -
 * evidensmismatch, leveransefeil eller auto-ACT-feil ble dermed bokført som
 * en vellykket daglig jobb (`scheduler_state.completed_at` satt), uten
 * varsel og uten fail-closed-signal.
 *
 * Nå: scheduler-grensen KASTER på ethvert usunt resultat. `DailyScheduler.
 * start()` kaller `markCompleted()` KUN etter at `deliver()` resolvet, så en
 * kastet feil lar dagens `scheduler_state`-rad stå med `completed_at IS NULL`
 * - en VARIG, observerbar "ikke fullført"-tilstand - og en strukturert
 * `situation_sweep_failed`-logglinje skrives for alarmering. Bevist i
 * `activation.test.ts` med en EKTE `DailyScheduler` mot embedded Postgres.
 *
 * Usunt = for minst én tenant: ikke-tom `errors[]`, `identity_conflicts > 0`
 * (en situasjon kunne ikke oppdateres - stille drift), `delivery.
 * evidence_mismatch > 0` (sikkerhetsrelevant: fremmed bevis under en
 * varsel-nøkkel), eller `delivery.pending > 0` (et varsel ble IKKE levert
 * denne syklusen). `auto_act.denied`/`skipped` er ÆRLIGE, forventede utfall
 * (eskalert situasjon / pauset domene) og teller ikke som sveipefeil.
 */
export interface SituationSweepUnhealthyTenant {
  tenant_id: string;
  errors: string[];
  identity_conflicts: number;
  evidence_mismatch: number;
  pending_deliveries: number;
}

export class SituationSweepFailedError extends Error {
  constructor(public readonly unhealthy: readonly SituationSweepUnhealthyTenant[]) {
    super(`situation_sweep_failed:${unhealthy.map((u) => u.tenant_id).join(",")}`);
    this.name = "SituationSweepFailedError";
  }
}

/** Ren funksjon: det usunne utsnittet av ett sveip-resultat, eller `null` når alt er sunt. */
export function unhealthySituationSweep(tenantId: string, result: SituationSweepResult): SituationSweepUnhealthyTenant | null {
  const unhealthy =
    result.errors.length > 0 ||
    result.identity_conflicts > 0 ||
    result.delivery.evidence_mismatch > 0 ||
    result.delivery.pending > 0;
  if (!unhealthy) return null;
  return {
    tenant_id: tenantId,
    errors: [...result.errors],
    identity_conflicts: result.identity_conflicts,
    evidence_mismatch: result.delivery.evidence_mismatch,
    pending_deliveries: result.delivery.pending
  };
}

/**
 * Scheduler-grensen: kast `SituationSweepFailedError` (etter én strukturert
 * logglinje) hvis noen tenant er usunn - ellers returner stille. Brukes som
 * `.then(assertSituationSweepHealthy)` på `runSituationSweepForAllTenants()`.
 */
export function assertSituationSweepHealthy(results: Record<string, SituationSweepResult>): void {
  const unhealthy: SituationSweepUnhealthyTenant[] = [];
  for (const [tenantId, result] of Object.entries(results)) {
    const item = unhealthySituationSweep(tenantId, result);
    if (item) unhealthy.push(item);
  }
  if (unhealthy.length === 0) return;
  console.error(JSON.stringify({ msg: "situation_sweep_failed", tenants: unhealthy }));
  throw new SituationSweepFailedError(unhealthy);
}

export interface SituationSweepAllDeps {
  openLoops: OpenLoopReader;
  engine: SituationEngine;
  gateway: ToolGateway;
  /** Bygger sveipe-identiteten for ÉN tenant - eierens identitet i sveipens space. En tenant eieren ikke er autorisert for avvises av PolicyGateway inne i `execute()` (fail-closed), aldri av en stille utelatelse her. */
  identityFor: (tenantId: string, memorySpace: MemorySpace) => IdentityContext;
  memorySpace?: MemorySpace;
  now?: () => number;
}

export async function runSituationSweepForAllTenants(pool: pg.Pool, deps: SituationSweepAllDeps): Promise<Record<string, SituationSweepResult>> {
  const memorySpace = deps.memorySpace ?? "business";
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, SituationSweepResult> = {};
  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await runSituationSweep(tenantId, memorySpace, {
        openLoops: deps.openLoops,
        engine: deps.engine,
        gateway: deps.gateway,
        identity: deps.identityFor(tenantId, memorySpace),
        ...(deps.now ? { now: deps.now } : {})
      });
    } catch (err) {
      // Én tenant sin sveip-feil skal aldri velte hele sveipet for andre tenants.
      results[tenantId] = {
        ingested: 0,
        identity_conflicts: 0,
        resolved_from_source: 0,
        delivery: emptyDelivery(),
        auto_act: emptyAutoAct(),
        errors: [`tenant:${describe(err)}`]
      };
    }
  }
  return results;
}
