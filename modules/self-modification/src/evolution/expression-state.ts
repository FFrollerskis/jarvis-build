import type { PersonalityProfile, SliderKey } from "./personality.ts";

/**
 * EV-14 (Evolution Masterplan v1.2 kap. 21): midlertidig uttrykkstilstand («mood») uten å late som følelser (ren funksjon). Presenteres som
 * STIL/tilstand - aldri biologiske følelser. Tilstanden avtar mot basispersonligheten, og kundevendt profil er eier-låst (kan ikke løses opp av
 * kontekst). Rører aldri safety, sannferdighet eller tillatelser.
 */
export type ExpressionContext = "incident" | "casual_private" | "customer_call" | "deep_research" | "default";
export type Verbosity = "low" | "normal" | "high";

export interface ExpressionState {
  context: ExpressionContext;
  humor: number;
  seriousness: number;
  curiosity: number;
  challenge: number;
  verbosity: Verbosity;
  /** Norsk stilbeskrivelse. Aldri følelsesord. */
  label_no: string;
}

export function deriveExpressionState(context: ExpressionContext, base: Pick<PersonalityProfile, "sliders" | "mode">): ExpressionState {
  const s = base.sliders;
  const locked = base.mode !== "internal";
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  switch (context) {
    case "incident":
      return { context, humor: 0, seriousness: 100, curiosity: clamp(s.curiosity * 0.5), challenge: clamp(s.counterargument), verbosity: "low", label_no: "stil: alvorlig og kort" };
    case "customer_call":
      return { context, humor: clamp(Math.min(s.humor, 10)), seriousness: 80, curiosity: clamp(s.curiosity * 0.5), challenge: clamp(s.counterargument * 0.5), verbosity: "low", label_no: "stil: profesjonell og kortfattet" };
    case "casual_private":
      // Kundevendt/profesjonell/sensitiv profil kan ikke gjøres mer leken av kontekst.
      if (locked) return { context, humor: s.humor, seriousness: 70, curiosity: s.curiosity, challenge: s.counterargument, verbosity: "normal", label_no: "stil: avmålt (profilen er låst)" };
      return { context, humor: clamp(s.humor + 20), seriousness: clamp(40), curiosity: s.curiosity, challenge: s.counterargument, verbosity: "normal", label_no: "stil: avslappet og leken innen profilen" };
    case "deep_research":
      return { context, humor: clamp(s.humor * 0.5), seriousness: 70, curiosity: clamp(s.curiosity + 25), challenge: clamp(s.counterargument + 25), verbosity: "high", label_no: "stil: nysgjerrig og utfordrende" };
    default:
      return { context: "default", humor: s.humor, seriousness: 50, curiosity: s.curiosity, challenge: s.counterargument, verbosity: "normal", label_no: "stil: vanlig" };
  }
}

/** Tilstanden avtar mot basis (halveringstid i minutter). */
export function decayTowardBase(state: ExpressionState, base: Pick<PersonalityProfile, "sliders">, minutesElapsed: number, halfLifeMinutes = 30): ExpressionState {
  const keep = Math.pow(0.5, Math.max(0, minutesElapsed) / halfLifeMinutes);
  const mix = (cur: number, b: number) => Math.round(b + (cur - b) * keep);
  const baseSeriousness = 50;
  const done = keep < 0.1;
  return {
    ...state,
    humor: mix(state.humor, base.sliders.humor),
    seriousness: mix(state.seriousness, baseSeriousness),
    curiosity: mix(state.curiosity, base.sliders.curiosity),
    challenge: mix(state.challenge, base.sliders.counterargument),
    verbosity: done ? "normal" : state.verbosity,
    label_no: done ? "stil: vanlig" : state.label_no
  };
}

/** Følelsesord som ikke skal brukes om Jarvis' uttrykkstilstand. Brukes av tester og en vakt i presentasjonslaget. */
export const FORBIDDEN_FEELING_WORDS: readonly string[] = ["glad", "trist", "sint", "redd", "føler", "følelse", "lykkelig", "deprimert", "bekymret", "stolt"];

export function presentationIsSafe(label: string): boolean {
  const lower = label.toLowerCase();
  return !FORBIDDEN_FEELING_WORDS.some((w) => lower.includes(w));
}

export type { SliderKey };
