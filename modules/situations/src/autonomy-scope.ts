import type { JsonValue } from "@jarvis/contracts";
import { RULE_CATEGORY, RULES, SCOPE_CATEGORIES, ruleByKey } from "./signal-types.ts";

/**
 * WP-G4b K2 (D-484, Q-75 pkt 7, JARVIS-115 a): autonomi-bindingen kan skopes til EN REGEL eller EN KATEGORI i stedet for hele domenet. REN logikk (ingen I/O) som motoren, simuleringen og testene deler.
 *
 *  - Skopnøkkelen (`scope_key`, migrasjon 148): `*` = hele domenet (alle regler; ALLE eksisterende bindinger), `rule:<kilde>:<hendelsestype>` (en regel i det lukkede regelregisteret) eller `category:<navn>` (en lukket kategori).
 *    Skopet må høre til bindingens EGET domene (en regel/kategori fra et annet domene avvises ved binding), og kun de lukkede settene finnes (ingen jokertegn, ingen fritekst).
 *  - PRESEDENS: regel > kategori > domene. Den MEST SPESIFIKKE raden som finnes avgjør - også når den er avslått eller utløpt (da er det et eksplisitt UNNTAK: ingen autonomi for akkurat den regelen/kategorien, aldri et stille
 *    fall tilbake til den bredere bindingen).
 *  - TAK: en smalere binding kan aldri gi mer enn den brede. Er den domenebrede bindingen (`*`) AVSLÅTT eller UTLØPT, er alle smalere bindinger i domenet uvirksomme (eierens «stopp» på domenenivå vinner). Finnes det ingen domenebred
 *    binding, er det ikke noe tak: en regelbinding alene gir autonomi for akkurat den regelen og ingenting annet i domenet.
 *  - Kobling situasjon -> regel: `situations.rule_key` (regelen som VANT, satt av inntaksbussen); `null` (de eldre sveipene) = ingen regel, kun en domenebred binding gjelder.
 *  - Alle øvrige vakter gjelder uendret for HVERT skop: fysiske navnerom er stengt, K1 (`autonomy_bindable`), NEVER_ACT-domener, pause, ferskhet, claim-vakt og D-kjeden.
 */
export const DOMAIN_WIDE_SCOPE = "*";

/** Kastet ved binding for et skop som ikke finnes i de lukkede settene eller ikke hører til bindingens domene. Stabil kode, aldri innhold. */
export class SituationAutonomyScopeError extends Error {
  constructor(public readonly detail: string) {
    super(`situation_autonomy_scope_invalid:${detail}`);
    this.name = "SituationAutonomyScopeError";
  }
}

export interface AutonomyScopeInput {
  /** En regel i regelregisteret, f.eks. `home_assistant:door_open_too_long`. */
  rule?: string | undefined;
  /** En lukket kategori, f.eks. `opening`, `leak`, `alarm`. */
  category?: string | undefined;
}

/**
 * Bygger skopnøkkelen og validerer den mot de LUKKEDE settene og bindingens domene. `*` når ingen av delene er oppgitt (bakoverkompatibelt). Kaster `SituationAutonomyScopeError` (fail-closed) ved alt uklart.
 */
export function scopeKeyFor(domain: string, scope: AutonomyScopeInput | undefined): string {
  const rule = scope?.rule;
  const category = scope?.category;
  if (rule === undefined && category === undefined) return DOMAIN_WIDE_SCOPE;
  if (rule !== undefined && category !== undefined) throw new SituationAutonomyScopeError("rule_and_category_are_exclusive");
  if (rule !== undefined) {
    const def = typeof rule === "string" ? ruleByKey(rule) : undefined;
    if (def === undefined) throw new SituationAutonomyScopeError("unknown_rule");
    if (def.domain !== domain) throw new SituationAutonomyScopeError("rule_not_in_domain");
    return `rule:${def.rule_key}`;
  }
  if (typeof category !== "string" || !SCOPE_CATEGORIES.includes(category)) throw new SituationAutonomyScopeError("unknown_category");
  const inDomain = RULES.some((r) => r.domain === domain && RULE_CATEGORY[r.rule_key] === category);
  if (!inDomain) throw new SituationAutonomyScopeError("category_not_in_domain");
  return `category:${category}`;
}

/** Les skopnøkkelen tilbake (for visning og simulering). `null` = ugyldig form (en rad skrevet utenom applikasjonen). */
export function describeScope(scopeKey: string): { kind: "domain" } | { kind: "rule"; rule: string } | { kind: "category"; category: string } | null {
  if (scopeKey === DOMAIN_WIDE_SCOPE) return { kind: "domain" };
  if (scopeKey.startsWith("rule:")) return { kind: "rule", rule: scopeKey.slice("rule:".length) };
  if (scopeKey.startsWith("category:")) return { kind: "category", category: scopeKey.slice("category:".length) };
  return null;
}

/** En bindingsrad slik presedensen ser den. `active` = aktivert OG ikke utløpt, målt av DATABASEKLOKKEN (aldri prosessklokken). */
export interface EffectivePolicyRow {
  scope_key: string;
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  active: boolean;
}

export type EffectiveBinding =
  | { kind: "binding"; row: EffectivePolicyRow; specificity: "rule" | "category" | "domain" }
  | { kind: "none"; reason: "no_binding" | "specific_binding_inactive" | "domain_binding_inactive" };

/**
 * REN presedens. `rows` = ALLE bindingsrader for (tenant, rom, domene); `ruleKey` = regelen som vant for situasjonen (`situations.rule_key`) eller `null`.
 *  1. Domenebred rad som ikke er aktiv -> TAKET: ingenting i domenet (`domain_binding_inactive`).
 *  2. Regelrad for situasjonens regel -> avgjør (aktiv = bindingen, ellers `specific_binding_inactive`).
 *  3. Kategorirad for regelens kategori -> avgjør (samme).
 *  4. Domenebred aktiv rad -> bindingen. 5. Ellers `no_binding`.
 * Deterministisk og uten sideeffekt; en ukjent/ugyldig skopnøkkel i `rows` ignoreres (den kan aldri matche).
 */
export function pickEffectiveBinding(rows: readonly EffectivePolicyRow[], ruleKey: string | null): EffectiveBinding {
  const byScope = new Map<string, EffectivePolicyRow>();
  for (const row of rows) byScope.set(row.scope_key, row);
  const broad = byScope.get(DOMAIN_WIDE_SCOPE);
  if (broad !== undefined && !broad.active) return { kind: "none", reason: "domain_binding_inactive" };
  if (ruleKey !== null) {
    const ruleRow = byScope.get(`rule:${ruleKey}`);
    if (ruleRow !== undefined) return ruleRow.active ? { kind: "binding", row: ruleRow, specificity: "rule" } : { kind: "none", reason: "specific_binding_inactive" };
    const category = RULE_CATEGORY[ruleKey];
    const categoryRow = category === undefined ? undefined : byScope.get(`category:${category}`);
    if (categoryRow !== undefined) return categoryRow.active ? { kind: "binding", row: categoryRow, specificity: "category" } : { kind: "none", reason: "specific_binding_inactive" };
  }
  if (broad !== undefined) return { kind: "binding", row: broad, specificity: "domain" };
  return { kind: "none", reason: "no_binding" };
}
