import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import { BLANK_MODEL, CLOUD, LOCAL, OWNER, TENANT, UNKNOWN_MODEL, buildWorld, run, seedConversationGraph, type ModelArg, type World } from "./support/n1b-finance-world.ts";
import { FINANCE_DERIVED_LOOP_TYPE } from "@jarvis/business";

/**
 * WP-N1b fiks-runde 1: ALLE 27 løkketyper ende-til-ende (egen seeding, egne markører, EGEN uavhengig finansliste utledet fra situasjonsbroen `domainForLoopType` -> `spend`, ikke fra klassifiseringstabellen som testes):
 * sky/ukjent/blank ser nøyaktig de 15 ikke-finans-typene; lokal og eier ser alle 27 - for `list_open_loops`, `get_attention_queue`, `read_open_loop` (hver id), ukebrief (`by_type`), kalibrering og tverr-kanal-køen.
 */
const ALL_TYPES = [
  "overdue_followup", "stalled_opportunity", "support_ticket_needs_reply", "support_ticket_overdue", "support_ticket_unassigned", "support_ticket_waiting_internal",
  "contract_renewal_due", "contract_termination_deadline", "contract_obligation_due", "contract_review_required", "marketing_spend_anomaly", "payment_intent_anomaly",
  "payment_intent_reconciliation_mismatch", "finance_spend_unexpected", "finance_spend_amount_deviation", "finance_recurring_charge_missing", "finance_recurring_charge_duplicate",
  "finance_spend_correction_conflict", "bank_transaction_unmatched", "bank_consent_attention", "card_anomaly_attention", "finance_procurement_missing", "product_item_needs_triage",
  "product_item_high_priority_stalled", "operations_task_overdue", "operations_task_escalation_needed", "customer_churn_risk"
] as const;
// UAVHENGIG liste: typene `domainForLoopType` (open-loop-bridge.ts:42-54) legger i domenet `spend`
const SPEND = new Set(["marketing_spend_anomaly", "payment_intent_anomaly", "payment_intent_reconciliation_mismatch", "finance_spend_unexpected", "finance_spend_amount_deviation", "finance_recurring_charge_missing",
  "finance_recurring_charge_duplicate", "finance_spend_correction_conflict", "bank_transaction_unmatched", "bank_consent_attention", "card_anomaly_attention", "finance_procurement_missing"]);

let db: H0Db; let on: World;
const mark = (t: string): string => `LOOPMARK-${t}-KR-98765`;
const id = (t: string): string => `typ-loop-${t}`;
const MODELS_W: Array<[string, ModelArg]> = [["sky", CLOUD], ["ukjent", UNKNOWN_MODEL], ["blank", BLANK_MODEL]];
const MODELS_F: Array<[string, ModelArg]> = [["lokal", LOCAL], ["eier", undefined]];
const text = (r: { ok: boolean; reason?: string; data?: unknown }): string => JSON.stringify(r.ok ? r.data : { denied: r.reason });

beforeAll(async () => {
  db = await startH0Db("n1btypes");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  for (const t of ALL_TYPES) {
    await db.adminPool.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, next_action, priority, status, opened_at)
       VALUES ($1, $2, 'business', $3, $4, $5, $6, 'normal', 'open', now() - interval '2 days')`, [id(t), TENANT, t, `${t}:${id(t)}`, mark(t), `neste-${t}`]);
  }
  await seedConversationGraph(db.adminPool).catch(() => undefined);
  on = buildWorld({ pool: db.appPool, guard: true });
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("uavhengig klassifisering: den ENE finanslisten i koden == `spend`-domenet i situasjonsbroen", () => {
  it("FINANCE_DERIVED_LOOP_TYPE (true) == spend-listen (12), og alle 27 typer er klassifisert", () => {
    const fromCode = ALL_TYPES.filter((t) => FINANCE_DERIVED_LOOP_TYPE[t]);
    expect(new Set(fromCode)).toEqual(SPEND);
    expect(Object.keys(FINANCE_DERIVED_LOOP_TYPE).sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe("ende-til-ende over ALLE løkketyper", () => {
  const readers: Array<[string, string, string, Record<string, unknown>]> = [
    ["list_open_loops", "business", "list_open_loops", { tenant_id: TENANT }], ["list_open_loops(all)", "business", "list_open_loops", { tenant_id: TENANT, status: "all" }], ["get_attention_queue", "business", "get_attention_queue", { tenant_id: TENANT }],
    ["cross_channel_attention", "conversation_graph", "read_cross_channel_attention", {}]
  ];
  for (const [label, tool, action, params] of readers) {
    for (const [mname, model] of MODELS_W) {
      it(`${label} / ${mname}: kun ikke-finanstyper (15) - ingen markører for de 12 finanstypene`, async () => {
        const t = text(await run(on.gateway, tool, action, params, model));
        for (const type of ALL_TYPES) {
          if (SPEND.has(type)) expect(t, `${type} lekker`).not.toContain(mark(type));
          else expect(t, `${type} mangler`).toContain(mark(type));
        }
        expect(t).toContain("finance_withheld");
      });
    }
    for (const [mname, model] of MODELS_F) {
      it(`${label} / ${mname}: ALLE 27 løkker`, async () => {
        const t = text(await run(on.gateway, tool, action, params, model));
        for (const type of ALL_TYPES) expect(t, `${type} mangler`).toContain(mark(type));
      });
    }
  }
  it("read_open_loop for hver av de 27 id-ene: finans = KUN merket for sky; ikke-finans = fullt; lokal/eier alt (ferskt gateway per modell: rate limit)", async () => {
    for (const [mname, model] of [...MODELS_W, ...MODELS_F] as Array<[string, ModelArg]>) {
      const w = buildWorld({ pool: db.appPool, guard: true });
      const cloud = MODELS_W.some(([n]) => n === mname);
      for (const type of ALL_TYPES) {
        const t = text(await run(w.gateway, "business", "read_open_loop", { tenant_id: TENANT, open_loop_id: id(type) }, model));
        if (cloud && SPEND.has(type)) { expect(t, `${type}/${mname}`).not.toContain(mark(type)); expect(t).not.toContain(id(type)); expect(t).toContain("finance_withheld"); }
        else expect(t, `${type}/${mname}`).toContain(mark(type));
      }
    }
  });
  it("ukebrief by_type: sky ser ingen av de 12 finanstypene (hverken nøkkel eller tall); lokal ser alle 27", async () => {
    for (const [, model] of MODELS_W) {
      const r = await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "weekly" }, model);
      const d = r.data as { by_type: Record<string, unknown>; still_open: number; opened_loops: number };
      for (const type of ALL_TYPES) expect(type in d.by_type, `${type}`).toBe(!SPEND.has(type));
      expect(d.still_open).toBe(ALL_TYPES.length - SPEND.size);
      expect(d.opened_loops).toBe(ALL_TYPES.length - SPEND.size);
    }
    const full = (await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "weekly" }, LOCAL)).data as { by_type: Record<string, unknown>; still_open: number };
    expect(Object.keys(full.by_type).length).toBe(ALL_TYPES.length);
    expect(full.still_open).toBe(ALL_TYPES.length);
  });
  it("kalibrering: sky ser ingen finanstyper i by_type/utfall", async () => {
    for (const [, model] of MODELS_W) {
      const t = text(await run(on.gateway, "business", "get_calibration_report", { tenant_id: TENANT }, model));
      for (const type of SPEND) expect(t, type).not.toContain(type);
    }
  });
});
