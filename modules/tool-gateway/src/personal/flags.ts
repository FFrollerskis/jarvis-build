/**
 * WP-G2 (D-464, UA-8 Personal Digital Twin): ALLE flagg og konfigurasjonsnavn for personlig-domenet på ett sted.
 *
 * Regelen (CLAUDE.md regel 2/10, BUILDER_COMMON §1): alt nytt er DORMANT/AV som standard. Kun den EKSAKTE verdien `on` slår et flagg på (ingen «true»/«1»/«yes» - samme disiplin som
 * kontrollsenter- og vekstflaggene). Uten flagg finnes verken verktøy, ruter, tabellbruk eller bakgrunnsjobber: verktøylister, utvalg, intents, rate-grenser og ruter er identiske med main.
 *
 * Navnene MÅ stå i `SERVICE_ENV.api` (`infra/local/service-env.mjs`) og i den genererte compose-blokken, ellers når en verdi i `.env` aldri containeren og flagget er stille virkningsløst. En vakttest
 * (`wpg2-flags-wiring.test.ts`) låser at hvert navn her står begge steder - og at ingen av dem er satt som standard.
 */
export const PERSONAL_FLAG_NAMES = {
  /** P1a: kritiske hjemmehandlinger (lås, alarm, garasjeport/cover, ventil, bryter, scene/skript, klima-modus) med mål-allowlist, klasse D-kjede, readback og journal. */
  homeCritical: "JARVIS_PERSONAL_HOME_CRITICAL",
  /** P1b: bil-handlinger bak `CarAdapter` (lås/lås opp, klima-forvarming, lading). Uten en bil-adapter (ingen leverandør valgt, D-64) feiler hver handling lukket. */
  car: "JARVIS_PERSONAL_CAR",
  /** P1c: familie/delte rom (medlemmer, roller, invitasjoner, per-medlem deling, «på vegne av», delte lister/kalender). */
  family: "JARVIS_PERSONAL_FAMILY",
  /** P1d: enhetssignert helse-inntak (rute `/personal/health/*` registreres KUN med flagget på). */
  healthIngest: "JARVIS_PERSONAL_HEALTH_INGEST",
  /** P2e: Apple Kalender/Påminnelser/Kontakter via CalDAV/CardDAV (iCloud) som eier-kun ruter `/personal/dav/*` (aldri verktøy). Live er `BLOCKED_EXTERNAL` (eieren lager det app-spesifikke passordet). */
  appleDav: "JARVIS_PERSONAL_APPLE_DAV",
  /** P2f: personlig økonomi - KUN lesing (rute `/personal/finance/read`, `personal`-rommet) fra Jarvis' kanoniske banktabeller. Aldri betaling, aldri et verktøy. */
  financeRead: "JARVIS_PERSONAL_FINANCE_READ",
  /** RESERVERT, INGEN EFFEKT (`BUILT_UNWIRED`, se `status.ts`): P2g kontekstavledninger (rene funksjoner i `@jarvis/context`); sesjonskontinuitet er eksisterende og uendret. */
  context: "JARVIS_PERSONAL_CONTEXT"
} as const;

export type PersonalFlagName = (typeof PERSONAL_FLAG_NAMES)[keyof typeof PERSONAL_FLAG_NAMES];

/**
 * Ikke-hemmelig konfigurasjon (eksakte, eier-valgte id-er og tall) som hører til flaggene. Tom/manglende = ingenting er tillatt (fail-closed).
 *  - `*_TARGETS`: eierens EGNE entitets-/kjøretøy-id-er (mål-allowlist, kommaseparert, eksakt match, ingen jokertegn). Tom liste = ingen mutasjon er tillatt.
 *  - `*_SETTLE_MS`: hvor lenge transporten venter på at et fysisk utstyr når en sluttilstand før utfallet regnes som UKJENT (begrenset til et trygt intervall).
 */
export const PERSONAL_CONFIG_NAMES = {
  homeTargets: "JARVIS_PERSONAL_HOME_TARGETS",
  homeSettleMs: "JARVIS_PERSONAL_HOME_SETTLE_MS",
  carTargets: "JARVIS_PERSONAL_CAR_TARGETS",
  carSettleMs: "JARVIS_PERSONAL_CAR_SETTLE_MS",
  /** Eierens allowlist av CalDAV/CardDAV-samlinger (`navn=https://vert/sti/`, slag fra navnet; ikke passord). Tom/ugyldig = ingenting kan nås. */
  appleDavAccounts: "JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS"
} as const;

/** Vault-referanser (aldri verdier) som personlig-domenet leser via `SecretProvider`. De er HEMMELIGHETER og redigeres bort fra alle logger, journaler og modellsvar. */
export const PERSONAL_SECRET_REFS = {
  /** Alarmpanelets kode (PIN) hvis panelet krever den. Sendes kun til Home Assistant, aldri i journal/varsel/logg. */
  homeAlarmCode: "JARVIS_PERSONAL_HOME_ALARM_CODE",
  /** Primær-credential for bil-leverandøren (vendor-nøytralt navn; en ekte adapter kan lese flere referanser selv). Uten leverandør finnes ingen verdi: handlingene feiler lukket (`credential_unavailable`). */
  carCredential: "JARVIS_PERSONAL_CAR_CREDENTIAL",
  /** iCloud-brukernavn og app-spesifikt passord for CalDAV/CardDAV (eieren lager passordet selv, D-108). */
  appleDavUser: "JARVIS_PERSONAL_APPLE_DAV_USER",
  appleDavAppPassword: "JARVIS_PERSONAL_APPLE_DAV_APP_PASSWORD"
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Eksakt `on` (ingen andre verdier slår noe på). */
export function personalFlagOn(env: Env, name: PersonalFlagName): boolean {
  return env[name] === "on";
}

/** Alle navn som må videresendes til api-containeren (flagg + ikke-hemmelig konfigurasjon + vault-referansene som api-prosessen leser). Brukes av vakttesten. */
export const PERSONAL_API_ENV_NAMES: readonly string[] = [
  ...Object.values(PERSONAL_FLAG_NAMES), ...Object.values(PERSONAL_CONFIG_NAMES), ...Object.values(PERSONAL_SECRET_REFS)
];

/** Heltall i [min, max]; alt annet (manglende, ikke-tall, utenfor intervallet) gir `fallback`. Aldri en stille klemming til en farlig verdi. */
export function boundedInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : fallback;
}
