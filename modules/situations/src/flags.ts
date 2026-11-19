/**
 * WP-G4 (D-466): ALLE flagg og konfigurasjonsnavn for det samlede hendelsesabonnementet (UA-10) på ett sted.
 *
 * Regelen (CLAUDE.md regel 2/10, BUILDER_COMMON §1): alt nytt er DORMANT/AV som standard. Kun den EKSAKTE verdien `on` slår et flagg på (ingen «true»/«1»/«yes»). Uten `JARVIS_SITUATION_SIGNALS=on` finnes verken verktøy,
 * løper, tabellbruk eller bakgrunnsjobb, og verktøylister, utvalg, intents, rate-grenser, ruter og det daglige sveipet er identiske med main.
 *
 * Navnene MÅ stå i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), i den genererte compose-blokken og i `.env.example`, ellers når en verdi i `.env` aldri containeren og flagget er stille virkningsløst.
 * Vakttesten `wpg4-flags-wiring.test.ts` låser det, og at ingen av dem er satt som standard og at ingen når worker/voice/browser.
 *
 * Underflaggene gjelder KUN under hovedbryteren (hovedbryter av = alt av). De begrensede kildene (helse, kamera) har hvert sitt eksplisitte flagg: å slå på hovedbryteren alene leser ingen begrensede data.
 */
export const SITUATION_FLAG_NAMES = {
  /** Hovedbryter: abonnementsregister, inntaksbuss, hendelsesløper (tikk), kontrollhandlinger på `situations`-verktøyet og signallogg. */
  signals: "JARVIS_SITUATION_SIGNALS",
  /** Hjem-kilden: Home Assistant-tilstander (dør/port åpen for lenge, lekkasje, alarm, strøm) via den eksisterende HA-connectoren (ny LESE-handling `read_state_detail`). */
  home: "JARVIS_SITUATION_HOME",
  /** Kamera-kilden: leser strukturerte hendelser fra `vision_event_observations` (WP-G3). Begrenset data: innholdsfri tekst, ingen ACT. */
  vision: "JARVIS_SITUATION_VISION",
  /** Helse-kilden: avvik fra eierens egen baseline (WP-G2-inntaket). Begrenset data: kun avledede signaler, ingen verdier i tekst/logg, ingen ACT. */
  health: "JARVIS_SITUATION_HEALTH",
  /** Hendelsesregisteret (UA-5) i «sanntid» via bussen (samme bro som det daglige sveipet; samme hendelsesnøkkel, ingen duplikater). */
  incidents: "JARVIS_SITUATION_INCIDENTS",
  /** Modellassistert vurdering (kategori/forklaring/løft remember -> inform) via `ModelGateway`. Aldri ACT alene; lokal modell for begrensede data. */
  modelAssist: "JARVIS_SITUATION_MODEL_ASSIST",
  /** Tilbakemeldingslæring: eierens «nyttig/støy» justerer terskler innenfor harde grenser (revisjonsmerket, tilbakestillbart). Ingen regel-/kodeendring. */
  feedback: "JARVIS_SITUATION_FEEDBACK"
} as const;

export type SituationFlagName = (typeof SITUATION_FLAG_NAMES)[keyof typeof SITUATION_FLAG_NAMES];

/** Ikke-hemmelig tallkonfigurasjon. Satt-men-ugyldig STOPPER oppstarten (`envInt`); tom = standard. */
export const SITUATION_CONFIG_NAMES = {
  /** Tikkintervall i sekunder (standard 60; 15-3600). */
  intervalSeconds: "JARVIS_SITUATION_BUS_INTERVAL_SECONDS",
  /** Oppbevaring av signalloggen i dager (standard 30; 7-365). */
  logRetentionDays: "JARVIS_SITUATION_LOG_RETENTION_DAYS"
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Eksakt `on` (ingen andre verdier slår noe på). */
export function situationFlagOn(env: Env, name: SituationFlagName): boolean {
  return env[name] === "on";
}

export interface SituationFlags {
  signals: boolean;
  home: boolean;
  vision: boolean;
  health: boolean;
  incidents: boolean;
  modelAssist: boolean;
  feedback: boolean;
}

/** Underflagg gjelder KUN under hovedbryteren: er hovedbryteren av, er alt av - uansett underflagg. */
export function situationFlagsFromEnv(env: Env): SituationFlags {
  const signals = situationFlagOn(env, SITUATION_FLAG_NAMES.signals);
  const sub = (name: SituationFlagName): boolean => signals && situationFlagOn(env, name);
  return {
    signals, home: sub(SITUATION_FLAG_NAMES.home), vision: sub(SITUATION_FLAG_NAMES.vision), health: sub(SITUATION_FLAG_NAMES.health),
    incidents: sub(SITUATION_FLAG_NAMES.incidents), modelAssist: sub(SITUATION_FLAG_NAMES.modelAssist), feedback: sub(SITUATION_FLAG_NAMES.feedback)
  };
}

/** Alle navn som må videresendes til api-containeren. Brukes av vakttesten. */
export const SITUATION_API_ENV_NAMES: readonly string[] = [...Object.values(SITUATION_FLAG_NAMES), ...Object.values(SITUATION_CONFIG_NAMES)];

/** Heltall i [min, max]; alt annet (manglende, ikke-tall, utenfor intervallet) gir `fallback`. Aldri en stille klemming til en farlig verdi. */
export function boundedInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : fallback;
}
