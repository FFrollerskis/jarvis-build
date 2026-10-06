import type { SloDefinition } from "./types.ts";

/**
 * EV-2: SLO-katalogen. Målverdiene er FORSLAG (utledet av hva en lokal 8B-modell på én 8 GB GPU realistisk leverer, målt på NAS 2026-10-06) -
 * IKKE eier-godkjente tjenestenivåer. Eieren justerer dem her (kode + beslutning); en SLO uten nok data er UNKNOWN, aldri OK.
 * Områdene i planen som ennå ikke har en datakilde (Voice, mobil, forretningsflyter, hallusinasjon/eval-score, brukerkorrigering) står i
 * `SLO_NOT_MEASURED` med årsak - ikke stille utelatt.
 */
export const SLO_CATALOG: readonly SloDefinition[] = [
  { id: "chat_success", label: "Chat: svar lykkes", series: "model:CHAT", metric: "success_rate", target: 0.95, window_hours: 24, min_samples: 10 },
  { id: "chat_ttft_p95", label: "Chat: tid til første token (p95)", series: "model:CHAT", metric: "ttft_p95_ms", target: 15_000, window_hours: 24, min_samples: 10 },
  { id: "chat_latency_p95", label: "Chat: total svartid (p95)", series: "model:CHAT", metric: "p95_ms", target: 60_000, window_hours: 24, min_samples: 10 },
  { id: "background_success", label: "Bakgrunnsmodell: kall lykkes", series: "model:BACKGROUND", metric: "success_rate", target: 0.9, window_hours: 24, min_samples: 10 },
  { id: "tools_success", label: "Verktøy: utførelser lykkes", series: "tools", metric: "success_rate", target: 0.9, window_hours: 24, min_samples: 10 },
  { id: "jobs_success", label: "Jobber: fullføres", series: "jobs", metric: "success_rate", target: 0.9, window_hours: 168, min_samples: 3 }
];

export const SLO_NOT_MEASURED: readonly string[] = [
  "Voice (tale): ingen latens-/suksessmåling lagres ennå",
  "Mobil/Watch: ingen telemetri finnes ennå",
  "Forretningsflyter (løst oppgave, brukerkorrigering): ingen utfallsmåling finnes ennå",
  "Hallusinasjon/eval-score: venter på EV-4 (Evaluation Lab)",
  "Dataskvalitet i health-/guest-minne: bevisst ikke målt (rommene er isolert)"
];

/** Driftterskler. Konservative: hellere ingen alarm enn støy; krever nok data i BEGGE vinduer. */
export const DRIFT_THRESHOLDS = {
  recent_hours: 24,
  baseline_days: 7,
  min_recent_samples: 10,
  min_baseline_samples: 30,
  /** Absolutt fall i suksessrate (0.10 = 10 prosentpoeng). */
  success_drop: 0.1,
  /** Relativ økning i p95/ttft/kost per kall. */
  latency_increase: 0.5,
  cost_increase: 0.5,
  /** Minste absolutte endring for å unngå alarm på bagateller. */
  min_latency_delta_ms: 2_000,
  min_cost_delta_ore: 1
} as const;

/** Terskler for dataskvalitetsalarmer (antall rader). */
export const DATA_QUALITY_THRESHOLDS = {
  stale_quarantine_days: 14
} as const;
