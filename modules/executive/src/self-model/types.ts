/**
 * EV-1 (D-412, Evolution Masterplan v1.2 kap. 8): Self Model - ærlig, kildebelagt selvforståelse. Hver verdi bærer `status`, `source` og
 * `observed_at`. `UNKNOWN` er en førsteklasses status: ukjent er aldri «bra» (samme disiplin som `health: null` på en connector som aldri er kalt).
 * Ingen påstand om bevissthet eller følelser - dette er systembevissthet: hva som kjører, hva som virker, hva som er galt, og hva Jarvis ikke kan.
 */
export type SelfStatus = "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface Observation {
  status: SelfStatus;
  /** Hvor målingen kom fra (modul/tabell/endepunkt) - aldri «modellen mener». */
  source: string;
  /** ISO-tidspunkt for målingen, eller null når ingen måling finnes. */
  observed_at: string | null;
  /** Kort norsk forklaring. Ingen hemmeligheter, ingen råverdier fra credentials. */
  detail: string;
  /** Valgfrie målte tall/felt (kun ikke-sensitive). */
  data?: Record<string, string | number | boolean | null>;
}

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** Nøkkelen til observasjonen (f.eks. `database`, `provider:gemma_local`). */
  area: string;
  message: string;
  source: string;
  observed_at: string | null;
}

export interface SelfDiagnosis {
  as_of: string;
  /** `OK` kun når ingen kritisk del er DOWN/DEGRADED/UNKNOWN. Ukjent kritisk del gir `UNKNOWN`, aldri `OK`. */
  overall: SelfStatus;
  findings: Finding[];
  observations: Record<string, Observation>;
  /** Områder uten måling (ingen leser, leseren feilet, eller bevisst ikke bygget ennå). */
  unknown: string[];
  limitations: Limitation[];
}

export type LimitationKind = "policy" | "technical" | "deferred" | "unverified";

export interface Limitation {
  id: string;
  /** Norsk setning: hva Jarvis IKKE kan eller ikke har bevist. */
  statement: string;
  kind: LimitationKind;
  /** Hvor begrensningen håndheves/er dokumentert (fil, beslutning, tabell). */
  source_ref: string;
}
