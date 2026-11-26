/**
 * WP-PGA / PG1: den FROSSE øvre grensen for `config/program/baseline.json` (se `baseline.ts`). En baseline-oppføring som ikke står her er vekst og gir rød test/CLI i begge moduser.
 * Listen er tom: første fyll av indeksen etterlot ingen kjente brudd. Å legge en id hit er en bevisst, synlig endring som krever en navngitt beslutning (og en tilsvarende oppføring med begrunnelse
 * i baseline.json). Listen skal aldri vokse for å slippe unna et nytt brudd: rett bruddet (registrer komponenten/tabellen/hendelsen i skjerven).
 */
export const BASELINE_ORIGIN: readonly string[] = Object.freeze([]);
