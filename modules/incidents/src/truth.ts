import type { DiagnosisSource, EvidenceAssertedBy, EvidenceStatus, EvidenceVerifiedBy } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): SANNHETSTYPE-REGIMET for hendelsesbevis og -diagnoser. Før dette var `status` et fritt felt avsenderen selv kunne sette (også `VERIFIED`), så «VERIFIED» betydde
 * «noen påsto det». Nå:
 *
 *   UNVERIFIED  = PÅSTÅTT. Eier, modell eller ekstern tekst har sagt det; ingenting er kontrollert.
 *   PROVISIONAL = OBSERVERT av deterministisk kode (produsent/kontroll) fra en Jarvis-intern kilde, én måling - sannsynlig, ikke bekreftet.
 *   VERIFIED    = BEKREFTET av en deterministisk kontroll eller en uavhengig kilde. Grunnlaget (`verified_by` + `verification_basis` + `verified_at`) lagres med statusen.
 *
 * Reglene er rene funksjoner (ingen I/O, ingen LLM) og håndheves i tillegg av CHECK-begrensninger og triggere i migrasjon 097 - en rå SQL-skriving fra app-rollen kan ikke omgå dem.
 * Prinsippet: INGEN avsender kan etablere sannhet om sin egen påstand. VERIFIED oppstår aldri ved innsetting; det oppstår kun gjennom `IncidentService.verifyEvidence()`, som kalles av
 * korrelasjonen (deployment-treff), av en produsents gjentatte måling (`source_recheck`) eller av en uavhengig probe.
 */
export class TruthRegimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TruthRegimeError";
  }
}

export const EVIDENCE_ASSERTERS: readonly EvidenceAssertedBy[] = ["owner", "producer", "check", "model"];
export const EVIDENCE_VERIFIERS: readonly EvidenceVerifiedBy[] = ["correlation_deployment_match", "source_recheck", "independent_probe"];

const isAsserter = (v: unknown): v is EvidenceAssertedBy => typeof v === "string" && (EVIDENCE_ASSERTERS as readonly string[]).includes(v);
const isVerifier = (v: unknown): v is EvidenceVerifiedBy => typeof v === "string" && (EVIDENCE_VERIFIERS as readonly string[]).includes(v);

/**
 * Status et NYTT bevis får ved innsetting. `requested` er det avsenderen ba om (eller ikke ba om).
 *  - Ingen avsender kan be om VERIFIED ved innsetting.
 *  - modell: alltid UNVERIFIED (ber den om mer, avvises det - aldri en stille nedgradering som skjuler forsøket).
 *  - eier: UNVERIFIED (standard) eller PROVISIONAL («jeg mener det er sannsynlig»); den nedre grensen er eierens egen påstand.
 *  - produsent/kontroll: PROVISIONAL (standard - deterministisk observasjon); UNVERIFIED kan oppgis eksplisitt.
 */
export function initialEvidenceStatus(assertedBy: unknown, requested?: EvidenceStatus): EvidenceStatus {
  if (!isAsserter(assertedBy)) throw new TruthRegimeError("truth_unknown_asserter");
  if (requested === "VERIFIED") throw new TruthRegimeError("truth_verified_requires_deterministic_basis");
  if (requested !== undefined && requested !== "UNVERIFIED" && requested !== "PROVISIONAL") throw new TruthRegimeError("truth_unknown_status");
  switch (assertedBy) {
    case "model":
      if (requested !== undefined && requested !== "UNVERIFIED") throw new TruthRegimeError("truth_model_cannot_raise_status");
      return "UNVERIFIED";
    case "owner":
      return requested ?? "UNVERIFIED";
    default:
      return requested ?? "PROVISIONAL";
  }
}

/**
 * Kan et eksisterende bevis forfremmes til VERIFIED? Kun med et navngitt deterministisk grunnlag og en ikke-tom begrunnelse; modellskrevet bevis kan aldri forfremmes (et nytt bevis fra
 * kontrollen er veien); et allerede VERIFIED bevis er endelig (idempotent no-op, aldri omskrevet).
 */
export function assertCanVerify(current: { status: EvidenceStatus; asserted_by: EvidenceAssertedBy }, verifiedBy: unknown, basis: unknown): "promote" | "already_verified" {
  if (!isVerifier(verifiedBy)) throw new TruthRegimeError("truth_unknown_verifier");
  if (typeof basis !== "string" || basis.trim().length === 0 || basis.length > 300) throw new TruthRegimeError("truth_verification_basis_required");
  if (current.asserted_by === "model") throw new TruthRegimeError("truth_model_evidence_cannot_be_verified");
  return current.status === "VERIFIED" ? "already_verified" : "promote";
}

/**
 * Status en NY diagnose får. `supportingStatuses` er statusene til de oppgitte STØTTE-bevisene.
 *  - modell-assistert: alltid UNVERIFIED (en hypotese er aldri sannhet).
 *  - eier: UNVERIFIED (standard) eller PROVISIONAL - aldri VERIFIED (en eier-konklusjon er en påstand).
 *  - deterministisk: VERIFIED kun når minst ett støttebevis er VERIFIED; ellers avvises forsøket (aldri en stille nedgradering). Standard er UNVERIFIED (uendret fra før regimet).
 */
export function initialDiagnosisStatus(source: DiagnosisSource, requested: EvidenceStatus | undefined, supportingStatuses: readonly EvidenceStatus[]): EvidenceStatus {
  if (requested !== undefined && requested !== "UNVERIFIED" && requested !== "PROVISIONAL" && requested !== "VERIFIED") throw new TruthRegimeError("truth_unknown_status");
  switch (source) {
    case "model_assisted":
      if (requested !== undefined && requested !== "UNVERIFIED") throw new TruthRegimeError("truth_model_cannot_raise_status");
      return "UNVERIFIED";
    case "owner":
      if (requested === "VERIFIED") throw new TruthRegimeError("truth_verified_requires_deterministic_basis");
      return requested ?? "UNVERIFIED";
    case "deterministic":
      if (requested === "VERIFIED" && !supportingStatuses.includes("VERIFIED")) throw new TruthRegimeError("truth_verified_diagnosis_needs_verified_evidence");
      return requested ?? "UNVERIFIED";
    default:
      throw new TruthRegimeError("truth_unknown_diagnosis_source");
  }
}

/** Norsk ord for sannhetsstatusen - samme ordvalg overalt (rapport, postmortem, status). */
export function truthLabelNo(status: EvidenceStatus): string {
  switch (status) {
    case "VERIFIED": return "bekreftet";
    case "PROVISIONAL": return "observert, ikke bekreftet";
    default: return "påstått";
  }
}
