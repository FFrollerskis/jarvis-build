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
// D-286 (Tobias direkte i chat, "alle" - alle tre foreslåtte tilnærminger
// til ubegrenset minnevekst, se D-286 i DECISIONS_AND_ASSUMPTIONS.md):
// fanger identitets-/relasjonsutsagn ("Pappa heter Henrik", "jeg bor i
// Oslo", "jobber som lærer") - PRESIST den kategorien fakta D-284/D-285 sin
// live-test beviste faktisk fungerer ende-til-ende. `hete?r?` (IKKE et
// strengt `\bheter\b`) tolererer whisper.cpp sine egne, allerede observerte
// STT-bøyningsfeil (D-285-loggen viste faktisk "Pappa, hete Henrik." -
// en `\bheter\b`-only-variant ville HELLER IKKE fanget den ekte, allerede
// vellykkede live-testen).
const RELATION = /\b(hete?r?|bor i|jobber (som|med|i|hos)|født|gift med|samboer med|har \d+ barn)\b/i;

export class RuleBasedExtractor implements ExtractionAdapter {
  async extract(text: string, space: MemorySpace, _trust: TrustLevel): Promise<MemoryCandidate[]> {
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 8);
    const candidates: MemoryCandidate[] = [];
    for (const sentence of sentences) {
      const type: MemoryType | undefined = PREFERENCE.test(sentence)
        ? "preference"
        : DECISION.test(sentence)
          ? "decision"
          : DATE.test(sentence)
            ? "episodic"
            : RELATION.test(sentence)
              ? "relation"
              : undefined;
      // D-286: FØR denne fiksen ble ALLE setninger over lengdeterskelen
      // (inkl. ren småprat som "Hei Charlie!"/"Takk, i like måte!") lagret
      // som type "semantic" - en reelt UBEGRENSET, ufiltrert skrivevei inn
      // i et permanent minne (se D-286 sitt funn: ingen opprydning/cap
      // fantes noe sted). Et eksplisitt, navngitt signalord kreves nå for
      // enhver kandidat - ingen catch-all lenger. Bevisst konservativt:
      // heller gå glipp av en sjelden, uskiltet fakta-setning enn å fylle
      // minnet med hverdagslig samtale-småprat.
      if (type === undefined) {
        continue;
      }
      const subject = sentence
        .toLowerCase()
        .replace(/[^a-zæøå0-9 ]/g, "")
        .split(/\s+/)
        .slice(0, 5)
        .join(".");
      candidates.push({ space, type, subject, content: sentence, confidence: 0.6 });
    }
    return candidates;
  }
}
