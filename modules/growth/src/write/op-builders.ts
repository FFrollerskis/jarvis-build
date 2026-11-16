import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { killSwitchOpen, type OpSpec } from "./tool-factory.ts";
import { asObj, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): felles byggeklosser for handlingstabellene (pause/aktiver/fjern følger samme mønster hos alle plattformene). Risikoklassen er STATISK per handling:
 *  - pause_* = C (reduserer utgift, reverserbar),
 *  - enable_* = D for kampanje/annonsegruppe/annonse (STARTER utgift; krever åpen finans-nødbryter), C for nøkkelord (utgiften er uansett avgrenset av budsjettet),
 *  - remove_/delete_* = D, ikke reverserbar (leverandørens «REMOVED»/«DELETED» er terminalt),
 *  - budsjett-/budhandlinger = D (retningsbestemt: opp krever åpen nødbryter, ned er alltid tillatt - Finance Integrity Gateway er revisjon/avstemming, ALDRI et beløpstak).
 */
export interface PauseEnableConfig {
  /** `campaign` | `ad_group` | `ad` | `ad_set` | `keyword` ... (blir suffiks i handlingsnavnet). */
  noun: string;
  /** Menneskelig etikett til beskrivelse og varsel (`Google Ads-kampanje`). */
  label: string;
  stateAction: string;
  targetParam: string;
  shape: z.ZodRawShape;
  scopes: string[];
  statusOf: (state: JsonValue, p: Params) => string | null;
  /** Statuser det ikke går an å komme tilbake fra (REMOVED/DELETED/ARCHIVED). */
  terminal: readonly string[];
  paused: string;
  active: string;
  ref: (p: Params) => string;
  enableRisk?: "C" | "D";
  rollbackPause?: string;
  rollbackEnable?: string;
  /** Ekstra målsjekk (f.eks. at kampanjen tilhører riktig konto). */
  targetCheck?: (state: JsonValue, p: Params) => boolean;
}

export function pauseEnableOps(c: PauseEnableConfig): OpSpec[] {
  const live = (s: JsonValue, p: Params): boolean => {
    const status = c.statusOf(s, p);
    return status !== null && !c.terminal.includes(status);
  };
  const common = { shape: c.shape, targetParam: c.targetParam, stateAction: c.stateAction, scopes: c.scopes, target: c.ref, ...(c.targetCheck ? { targetCheck: c.targetCheck } : {}) };
  return [
    {
      ...common, action: `pause_${c.noun}`, risk: "C", spend: "reduces",
      description: `Pause ${c.label} (reduserer utgift; kan reverseres med enable_${c.noun})`,
      rollback: c.rollbackPause ?? `enable_${c.noun} med samme id gjenoppretter før-tilstanden (status før pausen er journalført)`,
      validate: (s, p) => (live(s, p) ? null : "target_removed_or_unreadable"),
      noop: (s, p) => c.statusOf(s, p) === c.paused,
      post: (a, p) => c.statusOf(a, p) === c.paused,
      summary: (_s, p) => `${c.label}: pause ${c.ref(p)}`
    },
    {
      ...common, action: `enable_${c.noun}`, risk: c.enableRisk ?? "D", spend: "starts",
      description: `Aktiver ${c.label} (STARTER utgift: krever åpen finans-nødbryter; kan reverseres med pause_${c.noun})`,
      rollback: c.rollbackEnable ?? `pause_${c.noun} med samme id stopper utgiften igjen (status før aktiveringen er journalført)`,
      validate: (s, p) => (live(s, p) ? null : "target_removed_or_unreadable"),
      noop: (s, p) => c.statusOf(s, p) === c.active,
      post: (a, p) => c.statusOf(a, p) === c.active,
      summary: (_s, p) => `${c.label}: AKTIVER ${c.ref(p)} (starter utgift)`
    }
  ];
}

export interface RemoveConfig {
  action: string;
  label: string;
  stateAction: string;
  targetParam: string;
  shape: z.ZodRawShape;
  scopes: string[];
  statusOf: (state: JsonValue, p: Params) => string | null;
  /** Statusverdier som betyr «fjernet» (flere hos plattformer som skiller DELETED/REMOVED). */
  removed: readonly string[];
  ref: (p: Params) => string;
  risk?: "C" | "D";
  rollback: string;
  /** `true` når objektet forsvinner helt hos leverandøren etter fjerning (readback svarer «finnes ikke» = suksess). */
  absentIsDone?: boolean;
  /** Pengeeffekt (standard `reduces`: annonse-/kampanjefjerning stopper utgift). `none` for ting uten utgift (nettstedskart, nøkkelhendelse, video, svar på omtale). */
  spend?: "reduces" | "none";
  targetCheck?: (state: JsonValue, p: Params) => boolean;
}

export function removeOp(c: RemoveConfig): OpSpec {
  return {
    action: c.action, risk: c.risk ?? "D", spend: c.spend ?? "reduces", irreversible: true, idempotentExternal: true,
    description: `Fjern ${c.label} PERMANENT (leverandørens fjernet-status er terminal og kan ikke angres)`,
    shape: c.shape, targetParam: c.targetParam, stateAction: c.stateAction, scopes: c.scopes, target: c.ref, rollback: c.rollback,
    ...(c.targetCheck ? { targetCheck: c.targetCheck } : {}), ...(c.absentIsDone === true ? { absentIsDone: true } : {}),
    noop: (s, p) => { const st = c.statusOf(s, p); return st !== null && c.removed.includes(st); },
    post: (a, p) => { const st = c.statusOf(a, p); return st !== null && c.removed.includes(st); },
    summary: (_s, p) => `${c.label}: FJERN ${c.ref(p)} (kan ikke angres)`
  };
}

/** Retningsbestemt beløpsendring: ned/lik er alltid tillatt; opp krever BEKREFTET åpen finans-nødbryter (fail-closed ved ukjent tilstand). */
export function directionalAmountCheck(state: JsonValue, currentMicros: number | null, nextMicros: number, expectedMicros?: number): string | null {
  if (currentMicros === null) return "current_amount_unreadable";
  if (expectedMicros !== undefined && expectedMicros !== currentMicros) return "precondition_changed";
  if (nextMicros > currentMicros && !killSwitchOpen(state)) return "finance_kill_switch_active_or_unknown";
  return null;
}

/** Trygg lesing av en nøstet verdi fra en tilstand (leverandørdata er ubetrodd: alltid defensivt). */
export const stateField = (state: JsonValue, key: string): JsonValue | undefined => asObj(state)[key] as JsonValue | undefined;

/** Leverandørtekst i tilstand: kontrolltegn fjernet, lengde begrenset. Teksten er DATA - aldri instruks (se `redactVendorText` i journalen). */
export function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/gu, " ").replace(/ {2,}/g, " ").trim();
  return Array.from(flat).slice(0, max).join("");
}
