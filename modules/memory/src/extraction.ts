import type { MemorySpace, TrustLevel } from "@jarvis/contracts";

export type MemoryType =
  | "semantic" | "episodic" | "preference" | "procedure" | "relation"
  | "project" | "operational" | "decision" | "commitment";

export interface MemoryCandidate {
  space: MemorySpace;
  type: MemoryType;
  /** Kanonisk emne for dedup/versjonering, f.eks. "tobias.favorittfarge". */
  subject: string;
  content: string;
  confidence: number;
  observed_at?: string;
  entities?: Array<{ kind: string; name: string }>;
}

/**
 * Uttrekk bak adapter: LLM-assistert uttrekk (billig modell via Model Gateway)
 * kobles på samme grensesnitt senere; regelbasert uttrekk er deterministisk
 * fallback og test-implementasjon. Untrusted kilde påvirker ALDRI uttrekkets
 * tillitsnivå - det arves fra kilden, ikke fra innholdet.
 */
export interface ExtractionAdapter {
  extract(text: string, space: MemorySpace, trust: TrustLevel): Promise<MemoryCandidate[]>;
}

const PREFERENCE = /\b(liker|foretrekker|elsker|hater|vil helst)\b/i;
const DECISION = /\b(besluttet|bestemte|vedtatt|valgte)\b/i;
const DATE = /\b(\d{1,2}\.\s?\w+|\d{4}-\d{2}-\d{2}|i går|i dag|i fjor)\b/i;

export class RuleBasedExtractor implements ExtractionAdapter {
  async extract(text: string, space: MemorySpace, _trust: TrustLevel): Promise<MemoryCandidate[]> {
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 8);
    return sentences.map((sentence) => {
      const type: MemoryType = PREFERENCE.test(sentence)
        ? "preference"
        : DECISION.test(sentence)
          ? "decision"
          : DATE.test(sentence)
            ? "episodic"
            : "semantic";
      const subject = sentence
        .toLowerCase()
        .replace(/[^a-zæøå0-9 ]/g, "")
        .split(/\s+/)
        .slice(0, 5)
        .join(".");
      return { space, type, subject, content: sentence, confidence: 0.6 };
    });
  }
}
