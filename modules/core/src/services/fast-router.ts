/**
 * Fast Router v1 (CANONICAL_SPEC §4): deterministisk intentmatch i ren kode.
 * Kjente kommandoer skal ALDRI trenge en stor LLM - de rutes hit på
 * millisekunder. Rask bane hopper over LLM-en, aldri over Policy Gateway.
 */
export type FastIntent =
  | { kind: "system_status" }
  /** EV-1 (D-412): «hva er galt med deg» - kildebelagt selvdiagnose via Policy Gateway (aldri LLM). */
  | { kind: "self_diagnosis" }
  | { kind: "task_status"; task_id: string }
  | { kind: "create_task"; goal: string }
  | { kind: "cancel_task"; task_id: string }
  | { kind: "help" }
  /** Stedsbevisst: rommet kommer fra identitetskonteksten (site_id/room_id), aldri fra teksten alene. */
  | { kind: "home_light"; on: boolean };

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => FastIntent]> = [
  [/^(status|systemstatus)\s*$/i, () => ({ kind: "system_status" })],
  [
    /^(?:hva er galt(?: med deg)?(?: nå| akkurat nå)?|hva feiler(?: det)?(?: på deg)?|er du frisk|selv-?diagnose|diagnos(?:er|ér) deg|what'?s wrong(?: with you)?)\s*[?!.]*\s*$/i,
    () => ({ kind: "self_diagnosis" })
  ],
  [/^jobbstatus\s+(\S+)\s*$/i, (m) => ({ kind: "task_status", task_id: m[1] as string })],
  [/^opprett\s+jobb:?\s+(.+)$/i, (m) => ({ kind: "create_task", goal: (m[1] as string).trim() })],
  [/^avbryt\s+jobb\s+(\S+)\s*$/i, (m) => ({ kind: "cancel_task", task_id: m[1] as string })],
  [/^(hjelp|help)\s*$/i, () => ({ kind: "help" })],
  [/^(?:skru|slå) (på|av) lyset(?: her)?\s*$/i, (m) => ({ kind: "home_light", on: (m[1] as string).toLowerCase() === "på" })]
];

/** null = ingen kjent kommando; gå til intelligent bane (LLM). */
export function fastRoute(input: string): FastIntent | null {
  const text = input.trim();
  for (const [pattern, build] of PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return build(match);
    }
  }
  return null;
}
