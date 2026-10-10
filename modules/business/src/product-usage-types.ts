/**
 * WP-D2 (UA-3 Business OS, «churn/product usage», mandat D-450): produktbruk-hendelser fra Tobias' egne produkter, som kilde for deterministiske churn-signaler.
 *
 * PERSONVERN (UA3_BUSINESS_DPIA.md «Produktbruk og churn»): en hendelse bærer KUN pseudonyme referanser (`account_ref`, `user_ref` - avsenderen hasher selv), en
 * funksjonsnøkkel, et tidspunkt og et antall. Ingen navn, e-post, telefon, IP eller fritekst kan lagres: ukjente felt/kolonner avvises, og referanser som ser ut som
 * e-post/telefonnummer/IP avvises (`isPseudonymousRef`). Hendelsene brukes UTELUKKENDE til intern forretningsprioritering (kunde-nivå, aldri person-nivå).
 */

export type UsageEventKind = "usage" | "billing_status";

/** Én validert hendelse. For `billing_status` er `quantity` antall forfalte fakturaer (0 = ingen), og `feature`/`user_ref` er ikke tillatt. */
export interface NormalizedUsageEvent {
  /** Avsenderens egen, unike id - grunnlaget for idempotens og replay-vern (samme id = samme hendelse, aldri to ganger). */
  external_event_id: string;
  kind: UsageEventKind;
  account_ref: string;
  user_ref: string | null;
  feature: string | null;
  quantity: number;
  /** ISO 8601 (UTC). */
  occurred_at: string;
}

export interface RejectedUsageEvent {
  /** 1-basert posisjon i kilden (linje for JSONL/CSV, indeks+1 for webhook). */
  position: number;
  reason: string;
}

export interface ParsedUsageBatch {
  accepted: NormalizedUsageEvent[];
  rejected: RejectedUsageEvent[];
}

/**
 * Grensesnittet en kilde for produktbruk implementerer: den eier KUN avlesing + normalisering (signatur, filformat), aldri lagring. Lagring og idempotens eies av
 * `ProductUsageService`, slik at webhook, filimport og en fremtidig pull-adapter deler nøyaktig samme valideringer og personvernregler.
 * `I` er kildens rå inndata (`Buffer`/`string`/…); `parse` kaster ikke på enkelthendelser (de rapporteres som `rejected`), men på ugyldig HELE inndata.
 */
export interface ProductUsageSource<I = unknown> {
  /** Lagres på hver hendelse (`product_usage_events.source_id`): `webhook` eller `import:<etikett>`. Inngår i idempotensnøkkelen. */
  readonly source_id: string;
  parse(input: I, nowMs: number): ParsedUsageBatch;
}

export const USAGE_LIMITS = {
  /** Maks hendelser per webhook-kall. */
  webhook_max_events: 500,
  /** Maks rå kropp for webhook (byte). Rå-kroppsgrensen i HTTP-laget er den ENDELIGE; denne er forsvar i dybden. */
  webhook_max_bytes: 512 * 1024,
  /** Maks rader/linjer per filimport og maks filstørrelse (byte). */
  import_max_events: 50_000,
  import_max_bytes: 10 * 1024 * 1024,
  /** Eldre hendelser avvises (og slettes av oppbevaringssveipet). */
  max_age_days: 400,
  /** Hendelser fra fremtiden (klokkeforskjell) tolereres opp til dette. */
  max_future_ms: 5 * 60_000,
  usage_max_quantity: 100_000,
  billing_max_overdue: 1_000
} as const;

export class UsageImportError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UsageImportError";
  }
}
