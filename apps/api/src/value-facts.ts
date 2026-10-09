// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { parseDeclaredValueGates, type FollowUpPushPolicy, type ValueRuntimeFacts } from "@jarvis/executive";
import type { Ev0BootStatus } from "./ev0-boot.ts";

/**
 * WP-C4: kjøretidsfaktaene Value Center-rapporten trenger (hvilke løkker som faktisk er på, EV-0-status, kill switch, erklærte porter). Alt er flagg og tilstand - aldri innhold. Lesing av miljøet skjer HER (én gang
 * per kall) slik at `ExecutiveService` forblir fri for `process.env`.
 *
 * `JARVIS_V5_PROPOSALS_ENABLED`: kun den eksakte verdien `true` slår V5-forslag på (standard AV). Forslag utfører aldri noe (se `ops-proposals.ts`).
 * `JARVIS_VALUE_VERIFIED_GATES`: porter EIEREN erklærer verifisert (`D-32`, `WORKER_ISOLATION`). Kode utleder dem aldri; de påvirker kun beredskapsvurderingen av V3, som aldri kan aktivere noe.
 */
export function v5ProposalsEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["JARVIS_V5_PROPOSALS_ENABLED"]?.trim() === "true";
}

const pad = (h: number): string => String(h).padStart(2, "0");

export interface ValueFactsDeps {
  env: Readonly<Record<string, string | undefined>>;
  push: FollowUpPushPolicy;
  /** Er Telegram (token + chat) konfigurert i denne kjøringen? Styrer både V1-levering og V2-kanal. */
  deliveryConfigured: () => boolean;
  ev0Status: () => Ev0BootStatus | null;
  /** `OwnerControls.getControlState().kill_switch.active`. Kaster/avvises -> ukjent (null). */
  killSwitchActive: () => Promise<boolean>;
}

/** Bygger faktaene. Feil i en enkeltkilde gir `null` (ukjent) for akkurat den delen - aldri en kastet feil og aldri en gjetning. */
export async function buildValueRuntimeFacts(deps: ValueFactsDeps): Promise<ValueRuntimeFacts> {
  const ev0 = deps.ev0Status();
  const kill = await deps.killSwitchActive().then((v) => v, () => null);
  const configured = deps.deliveryConfigured();
  return {
    v1_delivery_configured: configured,
    v2_push: {
      enabled: deps.push.enabled, channel_configured: configured, max_per_day: deps.push.max_messages_per_day,
      quiet_hours: `${pad(deps.push.quiet_start_hour)}-${pad(deps.push.quiet_end_hour)}`
    },
    v5_proposals_enabled: v5ProposalsEnabled(deps.env),
    ev0: {
      constitution_verified: ev0 === null ? null : ev0.constitution.status === "verified",
      ledger_ok: ev0 === null ? null : ev0.ledger.status === "ok" ? true : ev0.ledger.status === "broken" ? false : null
    },
    kill_switch_active: kill,
    declared_gates: parseDeclaredValueGates(deps.env["JARVIS_VALUE_VERIFIED_GATES"])
  };
}
