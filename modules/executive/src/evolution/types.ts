/**
 * Evolution Observatory (HF2 Evolution v1.2, WP-B, D-452): ÉN samlet rapport over portene i Evolution-motoren (EV-0…EV-23), slik de står NÅ. Kun OBSERVASJON: rapporten og portene bak den utfører aldri en
 * endring (`acts` er alltid `false`) - selvendring er fortsatt frosset (D-397) og aktivering av noe sovende krever en navngitt D-beslutning. Tallene kommer fra eksisterende observerbarhet
 * (cost_events, scheduler_state, minne, endringsregisteret, connector-status); aldri innhold, aldri hemmelige verdier.
 */
export type EvolutionStatus =
  /** Målt, og ingenting å merke seg. */
  | "OK"
  /** Målt, og eier bør se på noe (eller en port står i veien for aktivering). */
  | "ATTENTION"
  /** Kunne ikke måles (kilde mangler eller feilet) - aldri tolket som «frisk». */
  | "UNKNOWN"
  /** Bygget, men bevisst ikke aktivert; `findings` forteller hva som mangler for å aktivere (ingen kodevei utfører noe). */
  | "DORMANT";

export type EvolutionMode = "observe" | "dormant";

export interface EvolutionSection {
  /** `EV-16` o.l. (kan være flere, `EV-0/EV-8`). */
  ev: string;
  title_no: string;
  mode: EvolutionMode;
  status: EvolutionStatus;
  /** Én setning på norsk. */
  summary_no: string;
  /** Korte norske linjer (antall/kategorier). Aldri innhold fra minne/e-post, aldri hemmelige verdier. */
  findings: string[];
  /** Hvor tallene kommer fra. */
  source: string;
  observed_at: string | null;
}

export interface EvolutionReport {
  as_of: string;
  /** Alltid false: observatoriet utfører aldri en handling. */
  acts: false;
  sections: EvolutionSection[];
  summary_no: string;
}
