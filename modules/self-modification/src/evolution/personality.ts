/**
 * EV-13 (Evolution Masterplan v1.2 kap. 20): Personality Engine 2.0 - versjonert konfigurasjonslag SEPARERT fra safety, sannferdighet og
 * tillatelser (ren validering). Kundevendt drift er eier-låst som standard. Justeringer kan kun røre TONE; ukjente nøkler (alt som kan ligne
 * safety/permissions) avvises. DEFERRED: lagring i `config/charlie-personality.json` (E1-allowlist), UI/eier-aksept og tilbakemeldingsinnhenting.
 */
export const SLIDER_KEYS = ["humor", "sarcasm", "edge", "energy", "directness", "talkativeness", "curiosity", "initiative", "counterargument", "formality"] as const;
export type SliderKey = (typeof SLIDER_KEYS)[number];
/** Tone-nøkler A/B-eksperimenter og tilbakemelding kan påvirke. `initiative`/`curiosity` styrer handlingslyst og er IKKE tone-only. */
export const TONE_ONLY_KEYS: readonly SliderKey[] = ["humor", "sarcasm", "energy", "directness", "talkativeness", "formality"];
export type Swearing = "off" | "low" | "medium" | "high";
export type PersonalityMode = "internal" | "customer_facing" | "professional" | "sensitive";

export interface PersonalityProfile {
  version: number;
  mode: PersonalityMode;
  sliders: Record<SliderKey, number>;
  swearing: Swearing;
  max_response_tokens: number;
  /** Prioriteringsvekt (0-1) - ikke følelse. */
  interest_weights: Record<string, number>;
  /** Eier-lås per slider. */
  locks: Partial<Record<SliderKey | "swearing", boolean>>;
  /** Eierens tillatte intervall per slider. */
  owner_ranges: Partial<Record<SliderKey, readonly [number, number]>>;
  /** Kundevendt: live profil endres kun med eierens aksept. */
  owner_accepted_live: boolean;
}

export type ChangeSource = "explicit_feedback" | "inferred" | "experiment" | "owner";

export interface AdjustmentRequest {
  changes: Partial<Record<SliderKey, number>> & { swearing?: Swearing };
  source: ChangeSource;
  /** Kun for `inferred`: tillit (0-1) og antall uavhengige observasjoner. */
  confidence?: number;
  observations?: number;
}

export interface AdjustmentResult {
  applied: Partial<Record<SliderKey, number>> & { swearing?: Swearing };
  rejected: Array<{ key: string; reason: string }>;
  profile: PersonalityProfile;
}

const DELTA_LIMIT: Record<ChangeSource, number> = { explicit_feedback: 30, inferred: 10, experiment: 15, owner: 100 };
const LOCKED_DOWN_MODES: ReadonlySet<PersonalityMode> = new Set(["customer_facing", "professional", "sensitive"]);

export function defaultProfile(mode: PersonalityMode = "internal"): PersonalityProfile {
  const locked = LOCKED_DOWN_MODES.has(mode);
  return {
    version: 1, mode,
    sliders: { humor: locked ? 10 : 40, sarcasm: locked ? 0 : 20, edge: 0, energy: 50, directness: 60, talkativeness: 40, curiosity: 50, initiative: 40, counterargument: 40, formality: locked ? 70 : 30 },
    swearing: "off", max_response_tokens: 600, interest_weights: {},
    locks: locked ? Object.fromEntries([...SLIDER_KEYS, "swearing"].map((k) => [k, true])) as PersonalityProfile["locks"] : {},
    owner_ranges: {}, owner_accepted_live: !locked
  };
}

const isSlider = (k: string): k is SliderKey => (SLIDER_KEYS as readonly string[]).includes(k);

/**
 * Anvender en justering. Regler: ukjente nøkler avvises; låste nøkler og låste moduser (kundevendt/profesjonell/sensitiv) kan ikke endres av
 * annet enn eier; `edge` og banning er av i låste moduser; eksperimenter kun tone; avledede preferanser krever tillit og flere observasjoner;
 * hvert steg er begrenset av delta-grense; verdier klemmes til eierens intervall. Returnerer en NY profil med økt versjon (aldri mutasjon).
 */
export function adjustProfile(profile: PersonalityProfile, req: AdjustmentRequest): AdjustmentResult {
  const rejected: AdjustmentResult["rejected"] = [];
  const applied: AdjustmentResult["applied"] = {};
  const next: PersonalityProfile = { ...profile, sliders: { ...profile.sliders }, interest_weights: { ...profile.interest_weights } };
  const lockedMode = LOCKED_DOWN_MODES.has(profile.mode);
  const ownerOnlyBlocked = lockedMode && req.source !== "owner";
  if (req.source === "inferred" && ((req.confidence ?? 0) < 0.7 || (req.observations ?? 0) < 3)) {
    return { applied, rejected: Object.keys(req.changes).map((key) => ({ key, reason: "inferred_needs_confidence_and_observations" })), profile };
  }
  for (const [k, v] of Object.entries(req.changes)) {
    if (k === "swearing") {
      if (req.source !== "owner") { rejected.push({ key: k, reason: profile.locks.swearing === true ? "locked" : "swearing_requires_explicit_owner_setting" }); continue; }
      if (lockedMode && v !== "off") { rejected.push({ key: k, reason: "swearing_off_in_locked_modes" }); continue; }
      next.swearing = v as Swearing;
      applied.swearing = v as Swearing;
      continue;
    }
    if (!isSlider(k)) { rejected.push({ key: k, reason: "unknown_key_not_tone" }); continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) { rejected.push({ key: k, reason: "out_of_range" }); continue; }
    if (ownerOnlyBlocked) { rejected.push({ key: k, reason: "locked_mode_owner_only" }); continue; }
    if (profile.locks[k] === true && req.source !== "owner") { rejected.push({ key: k, reason: "locked" }); continue; }
    if (req.source === "experiment" && !TONE_ONLY_KEYS.includes(k)) { rejected.push({ key: k, reason: "experiment_tone_only" }); continue; }
    if (k === "edge" && lockedMode) { rejected.push({ key: k, reason: "edge_disabled_in_locked_modes" }); continue; }
    const current = profile.sliders[k];
    let target = Math.max(current - DELTA_LIMIT[req.source], Math.min(current + DELTA_LIMIT[req.source], v));
    const range = profile.owner_ranges[k];
    if (range) target = Math.max(range[0], Math.min(range[1], target));
    if (target !== v) rejected.push({ key: k, reason: target === current ? "no_change_after_limits" : "clamped_by_delta_or_range" });
    if (target !== current) { next.sliders[k] = target; applied[k] = target; }
  }
  if (Object.keys(applied).length === 0) return { applied, rejected, profile };
  next.version = profile.version + 1;
  return { applied, rejected, profile: next };
}

/** Avledet preferanse får decay mot basisverdi (halveringstid i dager) - ingen permanent endring fra en tilfeldig samtale. */
export function decayInferred(current: number, base: number, daysSince: number, halfLifeDays = 14): number {
  const keep = Math.pow(0.5, Math.max(0, daysSince) / halfLifeDays);
  return Math.round(base + (current - base) * keep);
}

export interface ProfileHistory {
  versions: PersonalityProfile[];
}

export function appendVersion(h: ProfileHistory, p: PersonalityProfile): ProfileHistory {
  return { versions: [...h.versions, JSON.parse(JSON.stringify(p)) as PersonalityProfile] };
}

/** Tilbakerulling lager en NY versjon med gamle verdier (historikken er append-only). */
export function rollbackTo(h: ProfileHistory, version: number): ProfileHistory {
  const target = h.versions.find((p) => p.version === version);
  const latest = h.versions[h.versions.length - 1];
  if (!target || !latest) throw new Error("personality_version_not_found");
  return appendVersion(h, { ...target, sliders: { ...target.sliders }, version: latest.version + 1 });
}
