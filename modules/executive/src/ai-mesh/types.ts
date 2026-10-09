/**
 * AI Mesh-status (UA-1 / WP-D4, JARVIS-033/036/078): ÉN hemmelighetsfri rapport per leverandør - konfigurert, frisk, siste feil, kost og p50-latens siste 7 døgn, parallell-delegerings-overhead - og
 * akseptansen «≥3 live providers med fallback». KUN lesing: rapporten og kilden bak den utfører aldri et modellkall (røyktesten `mesh-live-smoke.ts` er eierens, ikke rapportens). Tall kommer fra
 * eksisterende observerbarhet (leverandørhelse i prosessen + `cost_events`); aldri innhold, aldri nøkler (kun presence), aldri frie feilmeldinger utover en kort, redigert kode.
 * Ukjent er `null`/`UNKNOWN` - aldri «frisk».
 */
export type AiMeshProviderState = "NOT_CONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED" | "RATE_LIMITED" | "UNAVAILABLE";

/** Fra `cost_events` siste 7 døgn (tenant-RLS). `null` på leverandøren = databasen kunne ikke leses. */
export interface AiMeshUsage7d {
  /** Alle forsøk (også mislykkede rader). */
  calls: number;
  ok_calls: number;
  failed_calls: number;
  /** Vellykkede kall som ble betjent ETTER at en tidligere kandidat feilet (bevis på fallback). */
  fallback_ok_calls: number;
  cost_ore: number;
  tokens_in: number;
  tokens_out: number;
  p50_latency_ms: number | null;
  last_success_at: string | null;
}

export interface AiMeshRuntime {
  success: number;
  failures: number;
  consecutive_failures: number;
  p50_latency_ms: number | null;
  avg_latency_ms: number | null;
  p50_solo_latency_ms: number | null;
  p50_parallel_latency_ms: number | null;
  solo_samples: number;
  parallel_samples: number;
  /** p50 for kall som startet mens et annet leverandørkall pågikk minus p50 for kall som startet alene (ms). `null` med færre enn 3 prøver i en av gruppene. INDIKATIV: innholdet er ikke likt. */
  parallel_overhead_ms: number | null;
}

export interface AiMeshLastError {
  /** Feilklasse (`timeout`, `auth`, `rate_limit` …). */
  kind: string | null;
  /** Kort, redigert adapterkode (f.eks. `kimi_auth_401`) - aldri leverandørens frie tekst. */
  message: string | null;
  at: string | null;
}

export interface AiMeshProvider {
  provider: string;
  model: string;
  locality: "local" | "cloud";
  hosted_free_tier: boolean;
  capabilities: string[];
  /** Nøkkel/URL er satt (presence - aldri verdien). */
  configured: boolean;
  state: AiMeshProviderState;
  /** Frisk = `LIVE` akkurat nå (nylig bevist suksess). `CONFIGURED` (aldri bevist) og alt annet er ikke frisk. */
  healthy: boolean;
  runtime: AiMeshRuntime;
  last_error: AiMeshLastError | null;
  usage_7d: AiMeshUsage7d | null;
}

export interface AiMeshAcceptance {
  required_live: number;
  /** Konfigurerte leverandører (ikke testdobler) som er bevist live: `LIVE` nå, eller minst ett vellykket kall siste 7 døgn. */
  live_providers: number;
  live: string[];
  /** Vellykkede kall betjent etter at en tidligere kandidat feilet, summert siste 7 døgn. */
  fallback_ok_calls_7d: number;
  /** Fallback er også bevist i denne prosessen (en kandidat feilet og en annen svarte siden oppstart). */
  fallback_verified_in_process: boolean;
  verdict: "MET" | "NOT_MET" | "UNKNOWN";
  /** Hva som mangler (norsk, kort). Tom når verdict er MET. */
  missing: string[];
}

export interface AiMeshChain {
  candidates: string[];
  auto_fallback: boolean;
}

export interface AiMeshReport {
  as_of: string;
  /** Alltid false: rapporten gjør aldri et modellkall eller en endring. */
  acts: false;
  router: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  /** Standardkjeden for vanlig prat (`JARVIS_CHAT_CANDIDATES`); `null` når den ikke er koblet inn. */
  chain: AiMeshChain | null;
  providers: AiMeshProvider[];
  acceptance: AiMeshAcceptance;
  not_measured: string[];
  summary_no: string;
}
