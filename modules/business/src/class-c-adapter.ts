/**
 * WP-AUTH2a (K3): klasse C-adapter for `business.update_lead_status`. Jarvis EIER tilstanden (JARVIS_CANONICAL): adapteren bruker den eksisterende lesehandlingen `business.inspect_lead`
 * (`BusinessPipelineService.inspect`, allerede handlingens `preflight_action`: saneret snapshot uten fritekst) og de SAMME konstantene som tjenesten (`LEAD_STATUSES`, `LEAD_TERMINAL`).
 *   - mål-/kapabilitetsbevis: tenant, lead-ID og en kjent målstatus (tjenesten avviser ukjent status; her skjer det FØR noe reserveres);
 *   - preflight: leaden finnes (`inspect_lead` gir `null` når den ikke gjør det);
 *   - etterkontroll: `inspect_lead` viser den ønskede statusen, og `closed` følger tjenestens regel (terminal status setter lukketidspunkt, ellers nullstilles det);
 *   - rollback: sett statusen tilbake til forrige verdi via samme handling (ingen lovlig-overgangs-tabell for leads: alle statuser kan settes, også gjenåpning).
 * Endringsloggen (`business_change_log`) holder tjenestens egen før-/etter-tilstand; denne adapteren gir gatewayens uavhengige readback og rollback-plan.
 */
import type { JsonValue } from "@jarvis/contracts";
import type { ClassCAdapter, ClassCReads } from "@jarvis/tool-gateway";
import { LEAD_STATUSES, LEAD_TERMINAL } from "./pipeline-service.ts";

type Obj = Record<string, JsonValue>;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isStatus = (value: unknown): value is string => typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);

function leadOf(reads: ClassCReads): Obj | null {
  const result = reads["lead"];
  if (result === undefined || !result.ok) return null;
  const d = result.data;
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Obj) : null;
}

function readParams(p: Record<string, JsonValue>): Record<string, JsonValue> {
  return { tenant_id: p["tenant_id"] ?? null, ...(p["memory_space"] !== undefined ? { memory_space: p["memory_space"] } : {}), lead_id: p["lead_id"] ?? null };
}

const stateOf = (lead: Obj): Obj => ({ status: typeof lead["status"] === "string" ? lead["status"] : null, closed: typeof lead["closed_at"] === "string" });

export const businessUpdateLeadStatusAdapter: ClassCAdapter = {
  key: "business.update_lead_status",

  validate: (p) => (!nonEmpty(p["tenant_id"]) ? "tenant_id_missing" : !nonEmpty(p["lead_id"]) ? "lead_id_missing" : !isStatus(p["status"]) ? "status_unknown" : null),

  before: {
    reads: (p) => [{ id: "lead", action: "inspect_lead", parameters: readParams(p) }],
    judge(p, reads) {
      const lead = leadOf(reads);
      if (lead === null) return { block: "lead_not_found" };
      if (!isStatus(lead["status"])) return { block: "unknown_current_status" };
      return { block: null, warnings: lead["status"] === p["status"] ? ["status_unchanged"] : [] };
    },
    snapshot(_p, reads) {
      const lead = leadOf(reads) ?? {};
      return { state: stateOf(lead), context: { lead_id: typeof lead["lead_id"] === "string" ? lead["lead_id"] : null, title_sha256_12: typeof lead["title_sha256_12"] === "string" ? lead["title_sha256_12"] : null } };
    }
  },

  after: {
    reads: (p) => [{ id: "lead", action: "inspect_lead", parameters: readParams(p) }],
    snapshot(_p, _m, reads) {
      const lead = leadOf(reads);
      if (lead === null) throw new Error("class_c_business_lead_unreadable");
      return { state: stateOf(lead), context: { lead_id: typeof lead["lead_id"] === "string" ? lead["lead_id"] : null, title_sha256_12: typeof lead["title_sha256_12"] === "string" ? lead["title_sha256_12"] : null } };
    }
  },

  expect: (p) => [
    { path: "status", op: "equals", value: String(p["status"]) },
    { path: "closed", op: "equals", value: LEAD_TERMINAL.has(String(p["status"])) }
  ],

  rollback(p, _m, before) {
    const was = before.state["status"];
    if (was === p["status"]) return { kind: "none", steps: [], note: "Leaden hadde allerede den ønskede statusen; ingenting ble endret." };
    if (!isStatus(was)) return { kind: "manual", steps: [], note: "Forrige status var ukjent; se endringsloggen (business_change_log)." };
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "business", action: "update_lead_status", parameters: { ...readParams(p), status: was } }],
      note: "Sett leaden tilbake til forrige status (lukketidspunkt og grunn følger tjenestens regler)."
    };
  }
};

export const businessClassCAdapters = (): ClassCAdapter[] => [businessUpdateLeadStatusAdapter];
