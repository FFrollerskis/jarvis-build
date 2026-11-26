/**
 * WP-AUTH2a (K3): klasse C-adapter for `growth.set_campaign_status` (kampanjens livssyklus: draft/active/paused/ended). Jarvis EIER tilstanden (JARVIS_CANONICAL): adapteren bruker den ekte, deterministiske
 * tilstandsmaskinen (`canTransitionCampaign`/`CAMPAIGN_TRANSITIONS`) - ingen kopi av overgangstabellen - og den eksisterende lesehandlingen `growth.get_campaign` (`GrowthTransport`).
 *   - mål-/kapabilitetsbevis: tenant, kampanje-ID og en kjent målstatus;
 *   - preflight: kampanjen finnes, nåstatus er kjent og overgangen er lovlig (ellers `invalid_transition:<fra>_to_<til>` FØR noe reserveres - samme avslag tjenesten ville gitt, men med bevis og uten kall);
 *   - etterkontroll: `get_campaign` viser den ønskede statusen;
 *   - rollback: tilbake til forrige status via samme handling, kun når tilstandsmaskinen tillater overgangen tilbake (ellers manuell prosedyre med de lovlige overgangene).
 * `started_at`/`ended_at` settes av tjenesten som bivirkning og står i `context` (bevis), ikke i sammenligningen.
 */
import type { JsonValue } from "@jarvis/contracts";
import type { ClassCAdapter, ClassCReads } from "@jarvis/tool-gateway";
import { CAMPAIGN_TRANSITIONS, canTransitionCampaign } from "./state-machine.ts";
import type { CampaignStatus } from "./types.ts";

type Obj = Record<string, JsonValue>;
const STATUSES = Object.keys(CAMPAIGN_TRANSITIONS) as CampaignStatus[];
const isStatus = (value: unknown): value is CampaignStatus => typeof value === "string" && (STATUSES as string[]).includes(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function campaignOf(reads: ClassCReads): Obj | null {
  const result = reads["campaign"];
  if (result === undefined || !result.ok) return null;
  const d = result.data;
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Obj) : null;
}

/** Scope-feltene gatewayen allerede har bundet til identiteten, videreført uendret til lesingen (samme som mutasjonen). */
function readParams(p: Record<string, JsonValue>): Record<string, JsonValue> {
  return { tenant_id: p["tenant_id"] ?? null, ...(p["memory_space"] !== undefined ? { memory_space: p["memory_space"] } : {}), campaign_id: p["campaign_id"] ?? null };
}

const stringOrNull = (value: JsonValue | undefined): string | null => (typeof value === "string" ? value : null);

export const growthSetCampaignStatusAdapter: ClassCAdapter = {
  key: "growth.set_campaign_status",

  validate: (p) => (!nonEmpty(p["tenant_id"]) ? "tenant_id_missing" : !nonEmpty(p["campaign_id"]) ? "campaign_id_missing" : !isStatus(p["status"]) ? "status_unknown" : null),

  before: {
    reads: (p) => [{ id: "campaign", action: "get_campaign", parameters: readParams(p) }],
    judge(p, reads) {
      const campaign = campaignOf(reads);
      if (campaign === null) return { block: "campaign_not_found" };
      if (!isStatus(campaign["status"])) return { block: "unknown_current_status" };
      const from = campaign["status"];
      const to = p["status"] as CampaignStatus;
      if (!canTransitionCampaign(from, to)) return { block: `invalid_transition:${from}_to_${to}` };
      return { block: null, warnings: from === to ? ["status_unchanged"] : [] };
    },
    snapshot(_p, reads) {
      const campaign = campaignOf(reads) ?? {};
      return {
        state: { status: stringOrNull(campaign["status"]) },
        context: { started_at: stringOrNull(campaign["started_at"]), ended_at: stringOrNull(campaign["ended_at"]), budget_amount_ore: stringOrNull(campaign["budget_amount_ore"]) }
      };
    }
  },

  after: {
    reads: (p) => [{ id: "campaign", action: "get_campaign", parameters: readParams(p) }],
    snapshot(_p, _m, reads) {
      const campaign = campaignOf(reads);
      if (campaign === null) throw new Error("class_c_growth_campaign_unreadable");
      return { state: { status: stringOrNull(campaign["status"]) }, context: { started_at: stringOrNull(campaign["started_at"]), ended_at: stringOrNull(campaign["ended_at"]), budget_amount_ore: stringOrNull(campaign["budget_amount_ore"]) } };
    }
  },

  expect: (p) => [{ path: "status", op: "equals", value: String(p["status"]) }],

  rollback(p, _m, before) {
    const was = before.state["status"];
    const now = String(p["status"]);
    if (was === now) return { kind: "none", steps: [], note: "Kampanjen hadde allerede den ønskede statusen; ingenting ble endret." };
    if (!isStatus(was)) return { kind: "manual", steps: [], note: "Forrige status var ukjent; undersøk kampanjehistorikken." };
    if (!canTransitionCampaign(now as CampaignStatus, was)) {
      return { kind: "manual", steps: [], note: `Overgangen ${now} til ${was} er ikke lovlig i livssyklusen (fra ${now}: ${CAMPAIGN_TRANSITIONS[now as CampaignStatus]?.join(", ") ?? "ingen"}); bruk en administrativ korreksjon.` };
    }
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "growth", action: "set_campaign_status", parameters: { ...readParams(p), status: was } }],
      note: "Sett kampanjen tilbake til forrige status."
    };
  }
};

export const growthClassCAdapters = (): ClassCAdapter[] => [growthSetCampaignStatusAdapter];
