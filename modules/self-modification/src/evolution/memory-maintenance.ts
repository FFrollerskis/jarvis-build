/**
 * EV-10 (Evolution Masterplan v1.2 kap. 17): Memory & Knowledge Self-Maintenance - målefunksjonene (rene). Gir FORSLAG (dedupe/merge, re-verifisering),
 * aldri sletting: irreversibel sletting har egen policy (UA-0 PRIVACY / UA-2 source delete). DEFERRED: planlagt komprimering/oppsummering og selve
 * utførelsen av merge-forslag. Personlige rettelser veier høyere enn slutninger, men er scopet per rom/tenant.
 */
export type MemorySourceKind = "owner_correction" | "owner_statement" | "tool" | "document" | "inference" | "external";

export interface MemoryFact {
  id: string;
  space: string;
  subject: string;
  content: string;
  source_kind: MemorySourceKind;
  trust: "trusted" | "internal" | "untrusted";
  observed_at: string;
  valid_to: string | null;
  /** Hvor mange ganger denne påstanden er sett fra ubetrodd kilde (repetisjon er ikke bevis). */
  untrusted_repeats?: number;
  /** Kilder som uavhengig har bekreftet påstanden (utenom den opprinnelige). */
  independent_confirmations?: number;
  has_conflict?: boolean;
}

const SOURCE_QUALITY: Record<MemorySourceKind, number> = { owner_correction: 1, owner_statement: 0.9, tool: 0.7, document: 0.6, inference: 0.4, external: 0.3 };
/** Halveringstid i dager per kilde: eksterne fakta blir gamle raskere enn eierens egne utsagn. */
const HALF_LIFE_DAYS: Record<MemorySourceKind, number> = { owner_correction: 730, owner_statement: 365, tool: 90, document: 180, inference: 60, external: 30 };

export function sourceQualityScore(f: Pick<MemoryFact, "source_kind" | "trust" | "independent_confirmations">): number {
  const base = SOURCE_QUALITY[f.source_kind];
  const trustFactor = f.trust === "trusted" ? 1 : f.trust === "internal" ? 0.9 : 0.6;
  const boost = Math.min(0.2, (f.independent_confirmations ?? 0) * 0.1);
  return Math.round(Math.min(1, base * trustFactor + boost) * 1000) / 1000;
}

/** Ferskhetsscore 0-1 (1 = ferskt). Utløpt (`valid_to` passert) er 0. */
export function freshnessScore(f: Pick<MemoryFact, "observed_at" | "valid_to" | "source_kind">, now: Date): number {
  if (f.valid_to !== null && new Date(f.valid_to).getTime() < now.getTime()) return 0;
  const ageDays = Math.max(0, (now.getTime() - new Date(f.observed_at).getTime()) / 86_400_000);
  return Math.round(Math.pow(0.5, ageDays / HALF_LIFE_DAYS[f.source_kind]) * 1000) / 1000;
}

export interface ReverifyDecision {
  id: string;
  reason: "expired" | "stale_external" | "stale_low_quality";
}

/** Utdaterte eksterne/lavkvalitets-fakta skal re-verifiseres FØR bruk. Eierens egne rettelser/utsagn re-verifiseres ikke automatisk. */
export function needsReverification(facts: readonly MemoryFact[], now: Date, thresholds = { stale: 0.4 }): ReverifyDecision[] {
  const out: ReverifyDecision[] = [];
  for (const f of facts) {
    const fresh = freshnessScore(f, now);
    if (f.valid_to !== null && fresh === 0) out.push({ id: f.id, reason: "expired" });
    else if (f.source_kind === "external" && fresh < thresholds.stale) out.push({ id: f.id, reason: "stale_external" });
    else if (f.source_kind === "inference" && fresh < thresholds.stale && sourceQualityScore(f) < 0.5) out.push({ id: f.id, reason: "stale_low_quality" });
  }
  return out;
}

export interface PoisoningFinding {
  id: string;
  reason: "repeated_untrusted_content" | "untrusted_claims_to_override_owner";
}

/**
 * Memory poisoning: gjentatt ubetrodd innhold blir ikke sannhet. Et faktum med mange ubetrodde repetisjoner og uten uavhengig bekreftelse
 * flagges; et ubetrodd faktum som motsier et eier-utsagn om samme emne flagges alltid (eierens ord vinner, scopet per rom).
 */
export function detectPoisoning(facts: readonly MemoryFact[], options: { repeat_threshold?: number } = {}): PoisoningFinding[] {
  const threshold = options.repeat_threshold ?? 3;
  const out: PoisoningFinding[] = [];
  const ownerBySubject = new Map<string, MemoryFact[]>();
  for (const f of facts) {
    if (f.source_kind === "owner_correction" || f.source_kind === "owner_statement") {
      const key = `${f.space}\u0000${f.subject}`;
      ownerBySubject.set(key, [...(ownerBySubject.get(key) ?? []), f]);
    }
  }
  for (const f of facts) {
    if (f.trust === "untrusted" && (f.untrusted_repeats ?? 0) >= threshold && (f.independent_confirmations ?? 0) === 0) out.push({ id: f.id, reason: "repeated_untrusted_content" });
    if (f.trust === "untrusted") {
      const owner = ownerBySubject.get(`${f.space}\u0000${f.subject}`) ?? [];
      if (owner.some((o) => o.content.trim().toLowerCase() !== f.content.trim().toLowerCase())) out.push({ id: f.id, reason: "untrusted_claims_to_override_owner" });
    }
  }
  return out;
}

export interface DedupeProposal {
  /** Beholdes. */
  keep: string;
  /** Foreslås slått sammen inn i `keep` (versjonert; aldri slettet av denne funksjonen). */
  merge: string[];
  space: string;
  reason: "identical_content";
  /** Alltid false: sletting/uopprettelig merge har egen policy og eierens godkjenning. */
  irreversible: false;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Duplikat-forslag innen samme rom: identisk innhold; den med høyest kildekvalitet (deretter nyest) beholdes. Kun forslag. */
export function proposeDedupe(facts: readonly MemoryFact[]): DedupeProposal[] {
  const groups = new Map<string, MemoryFact[]>();
  for (const f of facts) {
    const key = `${f.space}\u0000${norm(f.content)}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: DedupeProposal[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => sourceQualityScore(b) - sourceQualityScore(a) || b.observed_at.localeCompare(a.observed_at) || a.id.localeCompare(b.id));
    out.push({ keep: sorted[0]!.id, merge: sorted.slice(1).map((f) => f.id), space: sorted[0]!.space, reason: "identical_content", irreversible: false });
  }
  return out.sort((a, b) => a.keep.localeCompare(b.keep));
}
