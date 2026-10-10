import { classifyContentSensitivity } from "@jarvis/model-gateway";

/**
 * WP-D1 (UA-2): STRUKTURERT sensitivitetsmerke for kunnskapstreff. D-449/D-451 slo fast at kun strukturerte merker kan skjermes pålitelig mot en
 * skymodell (stikkordsskanning av hele verktøyresultater gir mange falske treff), og at et verktøy uten slike merker derfor ikke kan stå «screened».
 * Kunnskapstreff bærer derfor samme tre-delte merke som minneelementer (`memory_items.sensitivity`): `normal` | `sensitive` | `special`.
 *
 *  - `special`  = helse-rommet, hemmeligheter (nøkler, PIN, engangskoder), helse- og økonomistikkord (samme ordforråd som ruteren, Q-52) - ALDRI til skymodell.
 *  - `sensitive` = privat/forretning (kontrakter, kunder, privat-hint) - tillatt til skymodell på samme vilkår som annet privat innhold (D-431), men merket.
 *  - `normal`   = ingen signaler. Kun mulig når kildekonfigurasjonen eksplisitt senker gulvet (f.eks. et offentlig dokumentasjons-repo): standard er `sensitive`.
 *
 * Sensitiviteten er det STRENGESTE av (a) kildens gulv (`default_sensitivity` i `JARVIS_KNOWLEDGE_SOURCES`, ellers `sensitive`), (b) klassifiseringen av
 * tittel + innhold ved synkronisering (lagret på raden) og (c) klassifiseringen av tittel + innhold NÅR treffet leveres (ordforrådet vokser, og en rad lagret
 * før en utvidelse skal ikke slippe forbi). Merket kan aldri senkes av en senere, mer harmløs tekst.
 */
export const KNOWLEDGE_SENSITIVITIES = ["normal", "sensitive", "special"] as const;
export type KnowledgeSensitivity = (typeof KNOWLEDGE_SENSITIVITIES)[number];

/** Tillit til innholdet i et treff. `untrusted` (standard) = data fra e-post/web/dokumenter som aldri kan være instruks; `internal` = eierens egne notater, satt av eieren i kildekonfigurasjonen. Aldri `trusted`. */
export const KNOWLEDGE_TRUST_LEVELS = ["untrusted", "internal"] as const;
export type KnowledgeTrustLevel = (typeof KNOWLEDGE_TRUST_LEVELS)[number];

const RANK: Readonly<Record<KnowledgeSensitivity, number>> = { normal: 0, sensitive: 1, special: 2 };

/** Det strengeste av verdiene (udefinerte ignoreres). Uten noen verdi: `sensitive` (privat som standard, aldri `normal` ved en feil). */
export function stricterKnowledgeSensitivity(...values: ReadonlyArray<KnowledgeSensitivity | undefined>): KnowledgeSensitivity {
  let best: KnowledgeSensitivity | undefined;
  for (const value of values) {
    if (value !== undefined && (best === undefined || RANK[value] > RANK[best])) best = value;
  }
  return best ?? "sensitive";
}

/** Fail-closed parsing: kun de tre kjente verdiene; alt annet (feil kasus, tall, tom streng) er `undefined`, ALDRI en gjetning. */
export function parseKnowledgeSensitivity(value: unknown): KnowledgeSensitivity | undefined {
  return typeof value === "string" && (KNOWLEDGE_SENSITIVITIES as readonly string[]).includes(value) ? (value as KnowledgeSensitivity) : undefined;
}

export function parseKnowledgeTrustLevel(value: unknown): KnowledgeTrustLevel | undefined {
  return typeof value === "string" && (KNOWLEDGE_TRUST_LEVELS as readonly string[]).includes(value) ? (value as KnowledgeTrustLevel) : undefined;
}

export interface KnowledgeSensitivityDecision {
  sensitivity: KnowledgeSensitivity;
  /** Kategorier (aldri tekst) som løftet nivået - samme `reasons` som `classifyContentSensitivity`. */
  reasons: string[];
}

/**
 * Klassifiserer tekst i et memory space. Helse-rommet er alltid `special`; ellers avgjør kun INNHOLDET (samme regel som `itemSensitivity` for minne):
 * hemmelighet/helse/økonomi ⇒ `special`, privat-/forretningssignal ⇒ `sensitive`, ellers `normal`. `floor` (kildens gulv) kan bare løfte, aldri senke.
 */
export function classifyKnowledgeSensitivity(input: {
  memory_space: string;
  texts: ReadonlyArray<string>;
  floor?: KnowledgeSensitivity | undefined;
}): KnowledgeSensitivityDecision {
  const decision = classifyContentSensitivity({
    texts: [...input.texts],
    ...(input.memory_space === "health" ? { memory_spaces: ["health"] } : {})
  });
  const fromText: KnowledgeSensitivity =
    decision.sensitivity === "SECRET_RESTRICTED" ? "special" : decision.sensitivity === "PRIVATE" || decision.sensitivity === "BUSINESS_CONFIDENTIAL" ? "sensitive" : "normal";
  const sensitivity = input.floor === undefined ? fromText : stricterKnowledgeSensitivity(fromText, input.floor);
  return { sensitivity, reasons: decision.reasons };
}
