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
  "ONLY_AVAILABLE"
]);
export type RoutingReason = z.infer<typeof RoutingReasonSchema>;
