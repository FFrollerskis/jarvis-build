/**
 * WP-H2 (UA-11 Admin Control Center): kontrakten for golden-suite-knappen. Selve suiten (`apps/api/src/golden-suite.ts`, WP-B/D-452) bor i API-appen; executive-pakken kjenner kun denne SMALE porten, så
 * pakken aldri importerer app-kode (samme retning som `tasks`/`value` i `ExecutiveServiceOptions`).
 *
 * Suiten er DETERMINISTISK og LESENDE: den kaller rene regler (klassifisering, ruting, verktøyutvalg, skjerming, repo-lås, radar-sone, bundne bekreftelser) mot stubber - ingen modell, ingen database, ingen
 * nettverkskall, ingen skriving. Resultatet er tall, oppgave-id-er og to digester (aldri innhold).
 */
export interface GoldenSuiteRunResult {
  /** Når kjøringen startet (ISO). */
  ran_at: string;
  duration_ms: number;
  suite_id: string;
  suite_version: number;
  /** SHA-256 (hex) over selve suitedefinisjonen (oppgaver, terskler) - samme digest som `assertNotEasier`-vakten låser. Endres kun når suiten endres. */
  suite_digest: string;
  /** SHA-256 (hex) over resultatet (suite-digest, antall kjørt/bestått, ikke-bestått og hoppet-over-id-er, red team, hard stopp) - uten tidspunkt og varighet, så to kjøringer av samme kode gir samme digest. */
  result_digest: string;
  /** Oppgaver i suiten. */
  total: number;
  /** Oppgaver som faktisk ble kjørt (resten er hoppet over fordi verktøyflaten ikke var tilgjengelig). */
  ran: number;
  passed: number;
  /** Ikke-bestått (oppgave-id). */
  failed: string[];
  /** Ikke kjørt (oppgave-id) - IKKE målt, verken bestått eller strøket. */
  skipped: string[];
  red_team: Array<{ category: string; attempts: number; breaches: number }>;
  /** Et enkelt brudd i en red team-kategori er en hard stopp. */
  hard_stop: boolean;
  /** Red team-kategorier uten dekning. */
  uncovered: string[];
  /** Var chat-flatens verktøyutvalg tilgjengelig (ellers er utvalgsoppgavene hoppet over)? */
  surface_available: boolean;
  /** ALLTID 0: suiten har ingen modellvei (strukturelt - den importerer ingen modellgateway). */
  model_calls: 0;
}

export interface GoldenSuiteControl {
  /** Kjører suiten (én kjøring om gangen: et kall mens en kjøring pågår får samme resultat). Kaster aldri for en enkeltoppgave - en feilet oppgave teller som ikke bestått. */
  run(): Promise<GoldenSuiteRunResult>;
  /** Siste kjøring i DENNE prosessen, eller null (ingenting lagres på disk; nullstilles ved omstart). */
  last(): GoldenSuiteRunResult | null;
}
