import { z } from "zod";

/**
 * UA-1: stabil purpose-taksonomi for AI Mesh. Brukes til routing, kost og
 * metrikk - bevisst lite sett (BO-08 §33), utvides kun med begrunnelse.
 */
export const ModelPurposeSchema = z.enum([
  "CHAT",
  "QUICK_CLASSIFICATION",
  "SUMMARIZE",
  "EXTRACT",
  "CODE",
  "REASON",
  "PLAN",
  "RESEARCH",
  "CRITIQUE",
  "VISION",
  "BACKGROUND"
]);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

/** Routing-modes (BO-08 §9): parallellisme/critic er eksplisitte valg, aldri default. */
export const RouterModeSchema = z.enum([
  "AUTO",
  "FAST",
  "QUALITY",
  "CHEAP",
  "LOCAL",
  "SPECIFIC_PROVIDER",
  "CRITIC"
]);
export type RouterMode = z.infer<typeof RouterModeSchema>;

/** Kompakte, auditerbare reason codes (BO-08 §17) - aldri LLM-genererte forklaringer. */
export const RoutingReasonSchema = z.enum([
  "OWNER_OVERRIDE",
  "LOW_LATENCY",
  "LOW_COST",
  "REASONING_REQUIRED",
  "VISION_REQUIRED",
  "LOCAL_REQUIRED",
  "STRUCTURED_REQUIRED",
  "PRIMARY_UNHEALTHY",
  "RATE_LIMIT_FALLBACK",
  "CRITIC_REQUIRED",
  "DEFAULT_BALANCED",
  "ONLY_AVAILABLE",
  /** D-79 AI Mesh Gemma-first: sensitivitet ekskluderte gratis-tier-hostede kandidater. */
  "PRIVACY_RESTRICTED",
  /** D-79: sensitiv + lokal modell tilgjengelig - lokal foretrekkes fremfor sky (D-23). */
  "PRIVACY_PREFERS_LOCAL",
  /** D-106: `paid_models_allowed=false` ekskluderte betalte/sky-kandidater fra planen. */
  "PAID_MODELS_DISABLED",
  /** D-106: eier-preferanserekkefølge (§"bruk Gemma") - første konfigurerte/kvalifiserte vant. */
  "PROVIDER_PREFERENCE",
  /**
   * D-106 HOST-FIX (produksjonsherding, Defekt C): AUTO-scoringen endte i et
   * EKSAKT poengmessig uavgjort mellom en lokal og en betalt/sky-kandidat -
   * en deterministisk, registrerings-rekkefølge-uavhengig lokal-preferanse-
   * tiebreak avgjorde til fordel for den lokale kandidaten (se
   * `AUTO_LOCAL_TIE_BREAK_BONUS` i `router.ts`). ALDRI brukt til å overstyre
   * en reell kvalitets-/kost-forskjell - kun eksakte uavgjort.
   */
  "LOCAL_PREFERRED_ON_TIE"
]);
export type RoutingReason = z.infer<typeof RoutingReasonSchema>;

/**
 * D-79 (AI Mesh Gemma-first kost-/personvernarkitektur): eksplisitt data-
 * sensitivitetsklassifisering for modell-ruting - oppfyller D-23 sitt aldri
 * implementerte "Model Gateway-ruting per space fra fase 3"-mandat. Feltet er
 * VALGFRITT på `RouteInput`/`CompleteInput` (§23 migrasjonssikkerhet): når
 * kalleren ikke oppgir sensitivitet, filtreres INGENTING nytt bort (identisk
 * med ruting FØR denne beslutningen - ingen stille atferdsendring for
 * eksisterende kall). Kalleren MÅ eksplisitt sette feltet for at
 * personvernvernet skal tre i kraft - se D-79 §3/§11 for gjenstående
 * kablings-gap (bakgrunnsjobber klassifiserer ikke automatisk ennå).
 */
export const DataSensitivitySchema = z.enum([
  "PUBLIC_OR_LOW_SENSITIVITY",
  "PRIVATE",
  "BUSINESS_CONFIDENTIAL",
  "SECRET_RESTRICTED"
]);
export type DataSensitivity = z.infer<typeof DataSensitivitySchema>;
