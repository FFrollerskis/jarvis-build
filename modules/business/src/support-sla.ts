/**
 * WP-D2 (JARVIS-082): svarfrist («SLA») for supportsaker, utledet fra faktiske data. `support_ticket_overdue` leste tidligere kun `next_response_due_at`/`next_action_due_at`,
 * som ingen produksjonskode noensinne satte - regelen kunne aldri slå ut. Den utleder nå fristen fra siste UBESVARTE kundemelding (`support_ticket_events`) + et vindu per
 * prioritet. Vinduene er KALIBRERINGSFORSLAG (NEEDS_TOBIAS) og kan overstyres med `JARVIS_SUPPORT_SLA_HOURS` eller slås av (`off` - da gjelder kun eksplisitte frister).
 * Kalenderstimer (ikke kontortid) - bevisst enkelt og forklarbart; kontortid er en senere, eksplisitt beslutning.
 */
export interface SupportSlaPolicy {
  urgent: number;
  high: number;
  normal: number;
  low: number;
}

export type SupportPriority = keyof SupportSlaPolicy;

/** Forslag (NEEDS_TOBIAS): urgent 4 t, high 8 t, normal 24 t, low 72 t. */
export const DEFAULT_SUPPORT_SLA_HOURS: Readonly<SupportSlaPolicy> = Object.freeze({ urgent: 4, high: 8, normal: 24, low: 72 });

export const MAX_SUPPORT_SLA_HOURS = 720; // 30 dager
const KEYS: readonly SupportPriority[] = ["urgent", "high", "normal", "low"];

export class SupportSlaConfigError extends Error {
  constructor(detail: string) {
    super(`support_sla_config_invalid: ${detail}`);
    this.name = "SupportSlaConfigError";
  }
}

/**
 * Leser `JARVIS_SUPPORT_SLA_HOURS`. Tom/ikke satt = forslagene; `off` = av (`null`); ellers `urgent=4,high=8,normal=24,low=72` (delvis overstyring er lov, resten får forslagene).
 * Ugyldig verdi KASTER (fail closed ved oppstart) - aldri en stille standard. Høyere prioritet kan aldri ha lengre frist enn lavere (urgent <= high <= normal <= low).
 */
export function parseSupportSlaHours(raw: string | undefined | null): SupportSlaPolicy | null {
  if (raw === undefined || raw === null || raw.trim() === "") return { ...DEFAULT_SUPPORT_SLA_HOURS };
  if (raw.trim().toLowerCase() === "off") return null;
  const policy: SupportSlaPolicy = { ...DEFAULT_SUPPORT_SLA_HOURS };
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) throw new SupportSlaConfigError(`«${part.trim()}» må ha formen prioritet=timer`);
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!(KEYS as readonly string[]).includes(key)) throw new SupportSlaConfigError(`ukjent prioritet «${key}» (gyldige: ${KEYS.join(", ")})`);
    if (seen.has(key)) throw new SupportSlaConfigError(`${key} er oppgitt flere ganger`);
    seen.add(key);
    if (!/^\d{1,3}$/.test(value)) throw new SupportSlaConfigError(`${key}: timer må være et heltall`);
    const hours = Number(value);
    if (hours < 1 || hours > MAX_SUPPORT_SLA_HOURS) throw new SupportSlaConfigError(`${key}: timer må være 1-${MAX_SUPPORT_SLA_HOURS}`);
    policy[key as SupportPriority] = hours;
  }
  for (let i = 0; i < KEYS.length - 1; i += 1) {
    const higher = KEYS[i] as SupportPriority;
    const lower = KEYS[i + 1] as SupportPriority;
    if (policy[higher] > policy[lower]) throw new SupportSlaConfigError(`høyere prioritet kan ikke ha lengre frist: ${higher}=${policy[higher]} > ${lower}=${policy[lower]}`);
  }
  return policy;
}
