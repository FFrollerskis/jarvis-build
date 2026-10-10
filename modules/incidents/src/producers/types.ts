import type { MemorySpace } from "@jarvis/contracts";
import type { ResolveByCheckInput } from "../service.ts";
import type { IncidentFact, IncidentProducerName, IncidentRecord } from "../types.ts";

/**
 * WP-E1 (JARVIS-068): en deterministisk incident-PRODUSENT. Den OBSERVERER fakta Jarvis allerede har (bakgrunnsjobber, utrullinger, tjenestemål, connector-helse, journalførte
 * infra-eksekusjoner, Sentry, vakthundsjekker) og REGISTRERER dem som hendelser - ingenting annet. Ingen modell, ingen reparasjon, ingen skriving mot noe eksternt system
 * (reparasjon er fortsatt bak `InfraExecutionGate`/klasse D). Produsenten foreslår; `runIncidentProducers()` + `IncidentService` avgjør hva som faktisk skrives
 * (dedupe, tak, demping, aktør-regler).
 */
export interface ProducerContext {
  tenantId: string;
  memorySpace: MemorySpace;
  now: Date;
}

/** En betingelse produsenten har RE-MÅLT og funnet borte (ikke «ikke sett på en stund»). */
export interface ProducerClearing {
  /** Emnet (uten `<kilde>:`-prefikset) til den aktive hendelsen som er løst. */
  subject: string;
  check: Omit<ResolveByCheckInput, "reason"> & { reason?: string };
}

export interface ProducerObservation {
  /** Betingelser som er til stede NÅ. */
  present: IncidentFact[];
  /** Aktive hendelser fra denne produsenten som er positivt re-målt som borte. Alt som ikke står her røres ikke. */
  cleared: ProducerClearing[];
  /** Satt når produsenten bevisst ikke har noe å observere (ikke konfigurert / ingen ferske data): kjøringen registreres som `skipped`, ingenting åpnes og ingenting løses. */
  skipped?: string;
}

export interface IncidentProducer {
  readonly name: IncidentProducerName;
  /**
   * `active` er produsentens egne aktive hendelser; den skal re-måle akkurat disse. Kaster produsenten (kilden er nede), registreres kjøringen som `failed` og INGENTING løses -
   * en utilgjengelig kilde er aldri «betingelsen er borte».
   */
  observe(ctx: ProducerContext, active: ReadonlyArray<Pick<IncidentRecord, "incident_id" | "dedupe_key" | "last_seen_at" | "opened_at">>): Promise<ProducerObservation>;
}

/** Emnet i en aktiv hendelses fingeravtrykk (`<kilde>:<emne>` -> `<emne>`). */
export function subjectOf(producer: IncidentProducerName, dedupeKey: string | null): string | null {
  const prefix = `${producer}:`;
  return dedupeKey !== null && dedupeKey.startsWith(prefix) ? dedupeKey.slice(prefix.length) : null;
}

export interface ProducerRunSummary {
  producer: IncidentProducerName;
  status: "ok" | "failed" | "skipped";
  facts_seen: number;
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
  error?: string;
}
