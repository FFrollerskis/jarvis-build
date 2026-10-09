/**
 * WP-D1 (UA-2, Q-26 / D-63): Knowledge Verification / Truth Promotion - REN logikk (ingen database, ingen nettverk, ingen modell, ingen klokke utenom `now` som sendes inn).
 *
 * Invarianten (OPEN_QUESTIONS Q-26): Jarvis forfremmer aldri nylig web-researchet informasjon direkte til etablert kunnskap. Tilstandsmaskin
 *   UNKNOWN -> RESEARCHING -> PROVISIONAL -> VERIFIED | DISPUTED
 * Permanent kunnskap krever FLERE UAVHENGIGE kilder - tre kopier av samme oppstrøms-påstand teller ALDRI som tre uavhengige kilder (uavhengighetsnøkkel = opprinnelig oppstrøms-kilde/domene),
 * preferanse for primærkilder, motstrid-/adversarial søk (enhver motstridende evidens gir DISPUTED), ferskhet/tidsstempel, proveniens, konfidens og re-verifiseringsfrist for tidssensitive fakta.
 * Ukjent blir ALDRI stille sannhet: en påstand uten registrert verifisering er UNKNOWN, og det eneste veien inn i VERIFIED går gjennom PROVISIONAL og regelen under.
 *
 * VERIFIED-regelen: minst N uavhengige støttende kilder (N konfigurerbar 2..10, standard 2) OG (minst én primærkilde ELLER minst 3 uavhengige kilder) OG ingen motstridende evidens.
 * Konfidens er INFORMATIV (utledet av evidensen) og aldri en port - kun statusen er det.
 *
 * Promotering til etablert kunnskap/minne er KUN et FORSLAG (`buildPromotionProposal` -> `MemoryWriter.propose()` -> karantene, D-367) - denne modulen skriver aldri til minnet.
 */

import { stripControlAndInvisible } from "./knowledge-hits.ts";

export const CLAIM_STATUSES = ["UNKNOWN", "RESEARCHING", "PROVISIONAL", "VERIFIED", "DISPUTED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type EvidenceStance = "supports" | "contradicts";

export const MIN_INDEPENDENT_SOURCES_FLOOR = 2;
export const MIN_INDEPENDENT_SOURCES_CEILING = 10;
export const DEFAULT_MIN_INDEPENDENT_SOURCES = 2;
/** Uten primærkilde kreves minst så mange uavhengige kilder. */
export const INDEPENDENT_SOURCES_WITHOUT_PRIMARY = 3;
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 365;
export const DEFAULT_REVERIFY_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

export class InvalidClaimPolicyError extends Error {
  constructor(readonly reason: string) {
    super(`invalid_claim_policy:${reason}`);
    this.name = "InvalidClaimPolicyError";
  }
}

export class InvalidClaimTransitionError extends Error {
  constructor(readonly from: ClaimStatus, readonly to: ClaimStatus | "evidence", readonly reason: string) {
    super(`invalid_claim_transition:${from}->${to}:${reason}`);
    this.name = "InvalidClaimTransitionError";
  }
}

export interface VerificationPolicy {
  /** N uavhengige kilder for VERIFIED. 2..10 (heltall). */
  min_independent_sources: number;
  /** Tidssensitiv påstand: evidens må være FERSK (publisert innenfor `max_evidence_age_days`, hentet innenfor `reverify_after_days`), og VERIFIED har en re-verifiseringsfrist. */
  time_sensitive: boolean;
  max_evidence_age_days: number;
  reverify_after_days: number;
}

/** Fail-closed validering: en ugyldig grense kaster (aldri en stille klemming som svekker regelen). */
export function normalizeVerificationPolicy(input: Partial<VerificationPolicy> = {}): VerificationPolicy {
  const n = input.min_independent_sources ?? DEFAULT_MIN_INDEPENDENT_SOURCES;
  if (!Number.isInteger(n) || n < MIN_INDEPENDENT_SOURCES_FLOOR || n > MIN_INDEPENDENT_SOURCES_CEILING) {
    throw new InvalidClaimPolicyError(`min_independent_sources_must_be_${MIN_INDEPENDENT_SOURCES_FLOOR}_to_${MIN_INDEPENDENT_SOURCES_CEILING}`);
  }
  const maxAge = input.max_evidence_age_days ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 3650) throw new InvalidClaimPolicyError("max_evidence_age_days_must_be_1_to_3650");
  const reverify = input.reverify_after_days ?? DEFAULT_REVERIFY_AFTER_DAYS;
  if (!Number.isInteger(reverify) || reverify < 1 || reverify > 365) throw new InvalidClaimPolicyError("reverify_after_days_must_be_1_to_365");
  return { min_independent_sources: n, time_sensitive: input.time_sensitive === true, max_evidence_age_days: maxAge, reverify_after_days: reverify };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Uavhengighetsnøkkel
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Toleddede «andrenivå»-domener der det registrerbare domenet har tre etiketter (co.uk, com.au ...). Liten, bevisst liste - ingen Public Suffix List (ingen ny avhengighet). */
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go"]);

/** Registrerbart domene for en vert (heuristikk uten Public Suffix List): `www.vg.no` -> `vg.no`, `news.bbc.co.uk` -> `bbc.co.uk`, IP-adresse -> hele adressen. */
export function registrableDomain(host: string): string {
  const clean = host.replace(/\.$/, "").replace(/^www\d*\./, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean.includes(":")) return clean; // IP-adresse: hele adressen er opphavet
  const labels = clean.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] as string;
  const sld = labels[labels.length - 2] as string;
  return tld.length === 2 && SECOND_LEVEL_LABELS.has(sld) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

/**
 * Normaliserer en kilde-/opphavsreferanse til en stabil UAVHENGIGHETSNØKKEL:
 *  - URL -> registrerbart domene (`https://www.vg.no/a/1` og `https://vg.no/b/2` er SAMME kilde),
 *  - ren domene-streng (`ntb.no`) -> samme domenenøkkel som en URL til domenet (en deklarert oppstrøms-kilde og selve primærkilden faller sammen),
 *  - `doi:`/`arxiv:`-referanser -> selve identifikatoren,
 *  - kunnskapsdokument-id (`kd-...`) -> `doc:<id>`,
 *  - annen fritekst («NTB», «Statistisk sentralbyrå») -> `origin:<slug>`.
 * Tom/ugyldig input kaster - en evidens uten identifiserbart opphav kan aldri telle som uavhengig.
 */
export function normalizeOriginKey(raw: string): string {
  const s = raw.normalize("NFKC").trim().toLowerCase();
  if (s.length === 0 || s.length > 500) throw new InvalidClaimPolicyError("origin_empty_or_too_long");
  if (/^https?:\/\//.test(s)) {
    let host: string;
    try {
      host = new URL(s).hostname;
    } catch {
      throw new InvalidClaimPolicyError("origin_url_invalid");
    }
    if (host.length === 0) throw new InvalidClaimPolicyError("origin_url_invalid");
    return registrableDomain(host);
  }
  const ident = /^(doi|arxiv):\s*(\S+)$/.exec(s);
  if (ident) return `${ident[1]}:${ident[2]}`;
  if (/^kd-[a-z0-9-]+$/.test(s)) return `doc:${s}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && !/\s/.test(s)) return registrableDomain(s);
  const slug = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, "-");
  if (slug.length === 0) throw new InvalidClaimPolicyError("origin_empty_after_normalization");
  return `origin:${slug.slice(0, 180)}`;
}

/**
 * Uavhengighetsnøkkelen for en evidensrad: den DEKLARERTE oppstrøms-kilden (`upstream_origin`, den opprinnelige påstandens utgiver - f.eks. nyhetsbyrået en gjengivelse siterer) hvis oppgitt, ellers
 * kilden selv. Tre gjengivelser av samme byråsak gir dermed tre rader med SAMME nøkkel = ÉN uavhengig kilde. Begrensning (ærlig): systemet kan ikke OPPDAGE at to ulike domener har samme eier eller
 * siterer samme kilde - det avhenger av at den som legger inn evidensen deklarerer opphavet.
 */
export function deriveIndependenceKey(input: { source_ref: string; upstream_origin?: string | null | undefined }): string {
  const declared = input.upstream_origin?.trim();
  return normalizeOriginKey(declared !== undefined && declared !== "" ? declared : input.source_ref);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Evaluering av evidens
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ClaimEvidence {
  stance: EvidenceStance;
  independence_key: string;
  is_primary: boolean;
  /** Når kilden selv publiserte/oppdaterte (mangler ofte). */
  published_at: Date | null;
  /** Når Jarvis hentet/sjekket kilden. */
  retrieved_at: Date;
  retracted: boolean;
}

export interface EvidenceEvaluation {
  /** Antall UAVHENGIGE støttende kilder som teller (distinkte nøkler, etter ferskhet og selvmotsigelse). */
  independent_support: number;
  supporting_keys: string[];
  has_primary_support: boolean;
  /** Antall distinkte motstridende kilder (ikke-tilbaketrukket). */
  contradicting_count: number;
  contradicting_keys: string[];
  /** Støttende rader som IKKE teller: for gamle/uten dato på en tidssensitiv påstand, ikke nylig sjekket, eller fra en kilde som også motsier. */
  excluded: { stale: number; undated: number; self_contradicting: number };
  /** `independent_support >= N` og (primærkilde ELLER >= 3 uavhengige). Sier ingenting om motstrid. */
  rule_met: boolean;
  /** Tidligste `retrieved_at + reverify_after_days` blant tellende støtte (kun tidssensitiv), ellers null: når støtten først eldes ut. */
  support_expires_at: Date | null;
  /** 0..1, informativt. */
  confidence: number;
  /** Kategorikoder (aldri tekst) for hvorfor resultatet ble som det ble. */
  reasons: string[];
}

const WEIGHT_PRIMARY = 0.6;
const WEIGHT_SECONDARY = 0.35;

function bestWeightPerKey(entries: Array<{ key: string; primary: boolean }>): number[] {
  const best = new Map<string, number>();
  for (const entry of entries) {
    const w = entry.primary ? WEIGHT_PRIMARY : WEIGHT_SECONDARY;
    best.set(entry.key, Math.max(best.get(entry.key) ?? 0, w));
  }
  return [...best.values()];
}
const complementProduct = (weights: number[]): number => 1 - weights.reduce((acc, w) => acc * (1 - w), 1);

/**
 * Ren evaluering. Regler (alle deterministiske):
 *  - tilbaketrukket evidens ignoreres helt;
 *  - støtte telles per UAVHENGIGHETSNØKKEL (maks én per nøkkel, uansett antall kopier);
 *  - tidssensitiv påstand: støtte teller kun hvis `published_at` finnes og ikke er eldre enn `max_evidence_age_days`, OG kilden er sjekket innenfor `reverify_after_days` (re-verifisering krever at kildene hentes på nytt);
 *  - en nøkkel som både støtter og motsier telles IKKE som støtte (selvmotsigelse er motstrid);
 *  - enhver ikke-tilbaketrukket motstridende kilde teller som motstrid, uavhengig av ferskhet (konservativt; eieren kan trekke den tilbake med begrunnelse).
 */
export function evaluateEvidence(evidence: readonly ClaimEvidence[], policy: VerificationPolicy, now: Date): EvidenceEvaluation {
  const live = evidence.filter((e) => !e.retracted);
  const contradictingKeys = [...new Set(live.filter((e) => e.stance === "contradicts").map((e) => e.independence_key))].sort();
  const contradictingSet = new Set(contradictingKeys);
  const excluded = { stale: 0, undated: 0, self_contradicting: 0 };
  const counted: ClaimEvidence[] = [];
  for (const e of live) {
    if (e.stance !== "supports") continue;
    if (contradictingSet.has(e.independence_key)) {
      excluded.self_contradicting += 1;
      continue;
    }
    if (policy.time_sensitive) {
      if (e.published_at === null) {
        excluded.undated += 1;
        continue;
      }
      const ageMs = now.getTime() - e.published_at.getTime();
      const sinceCheckMs = now.getTime() - e.retrieved_at.getTime();
      if (ageMs > policy.max_evidence_age_days * DAY_MS || sinceCheckMs > policy.reverify_after_days * DAY_MS) {
        excluded.stale += 1;
        continue;
      }
    }
    counted.push(e);
  }
  const keys = [...new Set(counted.map((e) => e.independence_key))].sort();
  const primaryKeys = new Set(counted.filter((e) => e.is_primary).map((e) => e.independence_key));
  const hasPrimary = primaryKeys.size > 0;
  const independent = keys.length;
  const ruleMet = independent >= policy.min_independent_sources && (hasPrimary || independent >= INDEPENDENT_SOURCES_WITHOUT_PRIMARY);

  const support = complementProduct(bestWeightPerKey(counted.map((e) => ({ key: e.independence_key, primary: e.is_primary }))));
  const contraWeights = bestWeightPerKey(live.filter((e) => e.stance === "contradicts").map((e) => ({ key: e.independence_key, primary: e.is_primary })));
  const contra = complementProduct(contraWeights);
  const confidence = Math.round(Math.min(1, Math.max(0, support * (1 - contra))) * 1000) / 1000;

  const reasons: string[] = [];
  if (independent === 0) reasons.push("no_counted_support");
  else if (independent < policy.min_independent_sources) reasons.push("too_few_independent_sources");
  else if (!hasPrimary && independent < INDEPENDENT_SOURCES_WITHOUT_PRIMARY) reasons.push("no_primary_source");
  if (ruleMet) reasons.push("verification_rule_met");
  if (contradictingKeys.length > 0) reasons.push("contradicting_evidence");
  if (excluded.stale > 0) reasons.push("stale_evidence_excluded");
  if (excluded.undated > 0) reasons.push("undated_evidence_excluded");
  if (excluded.self_contradicting > 0) reasons.push("self_contradicting_source_excluded");
  const duplicateCopies = counted.length - independent;
  if (duplicateCopies > 0) reasons.push("duplicate_copies_counted_once");

  const supportExpiresAt =
    policy.time_sensitive && counted.length > 0
      ? new Date(Math.min(...counted.map((e) => e.retrieved_at.getTime())) + policy.reverify_after_days * DAY_MS)
      : null;

  return {
    independent_support: independent,
    supporting_keys: keys,
    has_primary_support: hasPrimary,
    contradicting_count: contradictingKeys.length,
    contradicting_keys: contradictingKeys,
    excluded,
    rule_met: ruleMet,
    support_expires_at: supportExpiresAt,
    confidence,
    reasons
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Tilstandsmaskinen
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** De ENESTE lovlige overgangene. Ingenting fører tilbake til UNKNOWN, og VERIFIED nås kun fra PROVISIONAL. */
export const ALLOWED_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  UNKNOWN: ["RESEARCHING"],
  RESEARCHING: ["PROVISIONAL", "DISPUTED"],
  PROVISIONAL: ["RESEARCHING", "VERIFIED", "DISPUTED"],
  VERIFIED: ["PROVISIONAL", "DISPUTED"],
  DISPUTED: ["PROVISIONAL", "RESEARCHING"]
};

export function isAllowedTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Korteste lovlige vei `from` -> `to` (eksklusive `from`, inklusive `to`); tom når de er like. Kaster når ingen vei finnes. */
export function transitionPath(from: ClaimStatus, to: ClaimStatus): ClaimStatus[] {
  if (from === to) return [];
  const queue: Array<{ status: ClaimStatus; path: ClaimStatus[] }> = [{ status: from, path: [] }];
  const seen = new Set<ClaimStatus>([from]);
  while (queue.length > 0) {
    const { status, path } = queue.shift() as { status: ClaimStatus; path: ClaimStatus[] };
    for (const next of ALLOWED_TRANSITIONS[status]) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ status: next, path: nextPath });
    }
  }
  throw new InvalidClaimTransitionError(from, to, "no_allowed_path");
}

/** UNKNOWN -> RESEARCHING: eneste vei ut av UNKNOWN. */
export function startResearchStatus(current: ClaimStatus): ClaimStatus {
  if (current !== "UNKNOWN") throw new InvalidClaimTransitionError(current, "RESEARCHING", "research_already_started");
  return "RESEARCHING";
}

export interface ClaimSnapshot {
  status: ClaimStatus;
  verified_at: Date | null;
  reverify_by: Date | null;
}

export interface ReduceResult {
  status: ClaimStatus;
  /** Trinnene som ble tatt (aldri hopp over en tilstand), tom når statusen er uendret. */
  path: ClaimStatus[];
  evaluation: EvidenceEvaluation;
  verified_at: Date | null;
  reverify_by: Date | null;
}

/**
 * Evaluerer evidensen og flytter påstanden til den statusen evidensen berettiger - trinn for trinn langs de lovlige overgangene. Målet er ALLTID avledet av evidensen, aldri satt utenfra:
 *  - motstridende evidens (ikke tilbaketrukket)  -> DISPUTED
 *  - ellers VERIFIED-regelen oppfylt             -> VERIFIED (via PROVISIONAL)
 *  - ellers noe tellende støtte                  -> PROVISIONAL
 *  - ellers (ingenting som teller)               -> RESEARCHING (letingen fortsetter; aldri tilbake til UNKNOWN, aldri stille sannhet)
 * En påstand i UNKNOWN kan ikke ha evidens (research må startes først): evidens på UNKNOWN kaster.
 */
export function reduceClaim(snapshot: ClaimSnapshot, evidence: readonly ClaimEvidence[], policy: VerificationPolicy, now: Date): ReduceResult {
  if (snapshot.status === "UNKNOWN") {
    if (evidence.length > 0) throw new InvalidClaimTransitionError("UNKNOWN", "evidence", "research_not_started");
    return { status: "UNKNOWN", path: [], evaluation: evaluateEvidence([], policy, now), verified_at: null, reverify_by: null };
  }
  const evaluation = evaluateEvidence(evidence, policy, now);
  let target: ClaimStatus;
  if (evaluation.contradicting_count > 0) target = "DISPUTED";
  else if (evaluation.rule_met) target = "VERIFIED";
  else if (evaluation.independent_support > 0) target = "PROVISIONAL";
  else target = "RESEARCHING";
  const path = transitionPath(snapshot.status, target);
  const enteredVerified = target === "VERIFIED" && snapshot.status !== "VERIFIED";
  const verifiedAt = target === "VERIFIED" ? (enteredVerified ? now : snapshot.verified_at ?? now) : snapshot.verified_at;
  // Re-verifiseringsfrist (kun tidssensitiv): når den tidligste tellende støtten eldes ut - aldri senere enn evidensen selv er fersk.
  const reverifyBy = target === "VERIFIED" && policy.time_sensitive ? evaluation.support_expires_at : null;
  return { status: target, path, evaluation, verified_at: verifiedAt, reverify_by: reverifyBy };
}

export interface ClaimRowView {
  status: ClaimStatus;
  reverify_by: Date | null;
}

/**
 * Status slik den VISES. En VERIFIED påstand hvis re-verifiseringsfrist er passert regnes ikke lenger som verifisert: den vises som PROVISIONAL med `reverification_due` (inntil kildene er sjekket på
 * nytt og regelen igjen er oppfylt). Dette gjelder allerede ved lesing - ikke først når en sveip har rukket å lagre overgangen.
 */
export function effectiveClaimStatus(row: ClaimRowView, now: Date): { status: ClaimStatus; reverification_due: boolean } {
  if (row.status === "VERIFIED" && row.reverify_by !== null && now.getTime() > row.reverify_by.getTime()) {
    return { status: "PROVISIONAL", reverification_due: true };
  }
  return { status: row.status, reverification_due: false };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Forslag til promotering (aldri en skriving)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PromotionProposal {
  subject: string;
  content: string;
  type: "semantic";
}

const PROPOSAL_MAX_SUBJECT = 120;
const PROPOSAL_MAX_CONTENT = 1000;
const CLAIM_IN_PROPOSAL_MAX = 650;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * Forslaget som sendes til minnets KARANTENE (`memory.propose`, D-367): påstanden + hvorfor den regnes som verifisert (antall uavhengige kilder, primærkilde, nøkler, dato), slik at eieren ser
 * grunnlaget når han godkjenner. Kaster hvis påstanden ikke er VERIFIED akkurat nå - ukjent/foreløpig/omstridt kan aldri foreslås som etablert kunnskap.
 */
export function buildPromotionProposal(input: {
  claim_text: string;
  status: ClaimStatus;
  reverification_due: boolean;
  evaluation: Pick<EvidenceEvaluation, "independent_support" | "has_primary_support" | "supporting_keys">;
  verified_at: Date | null;
}): PromotionProposal {
  if (input.status !== "VERIFIED" || input.reverification_due) throw new InvalidClaimTransitionError(input.status, "VERIFIED", "only_verified_claims_can_be_proposed");
  const claim = input.claim_text.replace(/\s+/g, " ").trim();
  const date = input.verified_at ? input.verified_at.toISOString().slice(0, 10) : "ukjent dato";
  const basis =
    `[Verifisert ${date}: ${input.evaluation.independent_support} uavhengige kilder${input.evaluation.has_primary_support ? ", inkl. primærkilde" : ""}` +
    `; kilder: ${input.evaluation.supporting_keys.slice(0, 6).join(", ")}]`;
  const subject = stripControlAndInvisible(clip(`verifisert: ${claim}`, PROPOSAL_MAX_SUBJECT));
  const content = clip(`${clip(claim, CLAIM_IN_PROPOSAL_MAX)} ${basis}`, PROPOSAL_MAX_CONTENT);
  return { subject, content, type: "semantic" };
}
