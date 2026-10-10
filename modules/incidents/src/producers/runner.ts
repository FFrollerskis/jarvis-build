import type { MemorySpace } from "@jarvis/contracts";
import { redactSecrets } from "../redact.ts";
import { incidentDedupeKey, type IncidentService } from "../service.ts";
import type { IncidentProducer, ProducerRunSummary } from "./types.ts";
import type { ProducerRunStore } from "./run-store.ts";

/**
 * WP-E1 (JARVIS-068): kjører produsentene for ÉN tenant og ÉN minne-rom, hver isolert (en feilende produsent stopper aldri de andre) og hver registrert i `incident_producer_runs`.
 * Dette er det ENE stedet fakta blir til hendelser:
 *  - `present` -> `IncidentService.openFromFact()` (dedupe, regresjon, demping, tak),
 *  - `cleared` -> `IncidentService.resolveByCheck()` (nytt VERIFIED bevis fra re-måling + overgang atomisk), og aldri for et emne som samtidig observeres som til stede,
 *  - kaster produsenten (kilden er nede/tidsavbrudd) løses INGENTING og kjøringen registreres som `failed` - en utilgjengelig kilde er aldri «betingelsen er borte».
 * Ingen reparasjon utføres her; dette er observasjon + registrering.
 */
const MAX_FACTS_PER_RUN = 50;
const MAX_CLEARINGS_PER_RUN = 50;
const DEFAULT_PRODUCER_TIMEOUT_MS = 30_000;

export interface RunProducersDeps {
  incidents: IncidentService;
  runs: ProducerRunStore;
  now?: () => Date;
  timeoutMs?: number;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`producer_timeout_${ms}ms`)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const describeError = (err: unknown): string => redactSecrets(err instanceof Error ? `${err.name}:${err.message}` : "unknown_error").slice(0, 200);

export async function runIncidentProducers(
  deps: RunProducersDeps,
  tenantId: string,
  memorySpace: MemorySpace,
  producers: readonly IncidentProducer[]
): Promise<ProducerRunSummary[]> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PRODUCER_TIMEOUT_MS;
  const summaries: ProducerRunSummary[] = [];
  for (const producer of producers) {
    const startedAt = now();
    const summary: ProducerRunSummary = { producer: producer.name, status: "ok", facts_seen: 0, opened: 0, updated: 0, resolved: 0, suppressed: 0 };
    // Å registrere starten er best-effort: feiler lagringen, kjøres produsenten likevel (og feilen vises når finish() også feiler).
    await deps.runs.start(tenantId, producer.name, startedAt).catch(() => undefined);
    const errors: string[] = [];
    try {
      const active = await deps.incidents.listActiveBySource(tenantId, memorySpace, producer.name);
      const observation = await withTimeout(producer.observe({ tenantId, memorySpace, now: startedAt }, active), timeoutMs);
      if (observation.skipped !== undefined) {
        summary.status = "skipped";
        summary.error = observation.skipped;
        await deps.runs.finish(tenantId, producer.name, now(), summary).catch(() => undefined);
        summaries.push(summary);
        continue;
      }
      summary.facts_seen = observation.present.length;
      const presentKeys = new Set<string>();
      for (const fact of observation.present.slice(0, MAX_FACTS_PER_RUN)) {
        try {
          if (fact.source_kind !== producer.name) throw new Error("producer_fact_kind_mismatch");
          presentKeys.add(incidentDedupeKey(fact.source_kind, fact.subject));
          const result = await deps.incidents.openFromFact(tenantId, memorySpace, fact);
          if (result.action === "opened" || result.action === "reopened") summary.opened += 1;
          else if (result.action === "updated") summary.updated += 1;
          else summary.suppressed += 1;
        } catch (err) {
          errors.push(describeError(err));
        }
      }
      summary.suppressed += Math.max(0, observation.present.length - MAX_FACTS_PER_RUN);
      const byKey = new Map(active.map((i) => [i.dedupe_key, i]));
      for (const clearing of observation.cleared.slice(0, MAX_CLEARINGS_PER_RUN)) {
        try {
          const key = incidentDedupeKey(producer.name, clearing.subject);
          const incident = byKey.get(key);
          if (!incident || presentKeys.has(key)) continue; // ikke vår aktive hendelse, eller faktumet observeres fortsatt
          const resolved = await deps.incidents.resolveByCheck(tenantId, memorySpace, incident.incident_id, {
            ...clearing.check,
            reason: clearing.check.reason ?? `betingelsen er re-målt som borte (${producer.name}:${clearing.subject})`
          });
          if (resolved?.status === "resolved") summary.resolved += 1;
        } catch (err) {
          errors.push(describeError(err));
        }
      }
    } catch (err) {
      errors.push(describeError(err));
    }
    if (errors.length > 0) {
      summary.status = "failed";
      summary.error = errors[0]!;
    }
    await deps.runs.finish(tenantId, producer.name, now(), summary).catch((err) => {
      summary.status = "failed";
      summary.error = summary.error ?? describeError(err);
    });
    summaries.push(summary);
  }
  return summaries;
}
