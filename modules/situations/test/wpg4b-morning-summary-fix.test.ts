import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import type { ToolResult } from "@jarvis/tool-gateway";
import { MORNING_SUMMARY_CATCH_UP_MS, MorningSummaryService } from "../src/morning-summary.ts";
import { IN_FLIGHT_OR_UNKNOWN_OUTCOME, classifyDelivery } from "../src/morning-summary-delivery.ts";
import { OWNER, TENANT_A, TENANT_B, identity, startG4Db, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4b fiks-runde 1, K5-hull fra review A (LOW-1) og mutant M58:
 *  - FIX-4b / M58: grensene for natten er [start, slutt): akkurat START teller, akkurat SLUTT teller IKKE (`opened_at < slutt`, ikke `<=`).
 *  - FIX-11 (i): ved samtidige `deliver` for samme natt faar KUN den som faktisk sendte `sent` (ellers over-teller loepernes `morning_summaries`); de som taper kappløpet faar `already_sent`. Ett transportkall.
 *  - FIX-11 (ii): en ren transportfeil paa klasse B (ECONNRESET) er IKKE et ukjent utfall for gatewayen: ledgeren staar som `failed`, og et nytt tikk sender paa nytt (maks ett ekstra sammendrag; lavrisiko, dokumentert).
 *    Krasj (`reserved`) og gateway-tidsavbrudd (`unverified`) sendes derimot ALDRI paa nytt. Testene pinner baade det som gjelder og det som ikke gjelder.
 */
const at = (iso: string): number => Date.parse(iso);
const MORNING = at("2026-11-20T06:05:00.000Z");
const NIGHT_END = at("2026-11-20T06:00:00.000Z");
const NIGHT_START = at("2026-11-19T22:00:00.000Z");

let db: G4Db;
beforeAll(async () => { db = await startG4Db("wpg4b_msfix"); }, 240_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); await db.adminPool.query("DELETE FROM situation_domain_pauses"); });

const setQuiet = () => db.engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, actor_person_id: OWNER });
const heldRow = (key: string, over: Record<string, unknown> = {}) => {
  const r = { domain: "vision", stage: "remember", priority: "normal", status: "open", opened_at: new Date(at("2026-11-20T02:00:00.000Z")).toISOString(), last_notified_at: null, tenant: TENANT_A, space: "home", ...over };
  return db.adminPool.query(
    `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason, status, opened_at, last_notified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'SKAL-ALDRI-LEKKE',$8,$9,$10)`,
    [`s-${key}`, r.tenant, r.space, r.domain, key, r.stage, r.priority, r.status, r.opened_at, r.last_notified_at]
  );
};
const svc = () => new MorningSummaryService(db.appPool);
const id = () => identity(TENANT_A, "home");
const ledger = async (): Promise<Array<{ status: string }>> => (await db.adminPool.query(`SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key LIKE 'situation-morning-summary:%' ORDER BY executed_at`, [TENANT_A])).rows as never;

describe("FIX-4b / M58: grensene for natten er [start, slutt) (eksakte grenser, 1 ms)", () => {
  it("akkurat start teller, 1 ms foer start teller ikke, akkurat SLUTT teller IKKE, 1 ms foer slutt teller; annet domene/stadium/prioritet/status/varslet/tenant/rom teller ikke", async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["at-start", { opened_at: new Date(NIGHT_START).toISOString() }, true],
      ["before-start", { opened_at: new Date(NIGHT_START - 1).toISOString() }, false],
      ["at-end", { opened_at: new Date(NIGHT_END).toISOString() }, false],
      ["end-1ms", { opened_at: new Date(NIGHT_END - 1).toISOString() }, true],
      ["domain-home", { domain: "home" }, false],
      ["domain-health", { domain: "health" }, false],
      ["stage-inform", { stage: "inform" }, false],
      ["stage-suggest", { stage: "suggest" }, false],
      ["prio-low", { priority: "low" }, false],
      ["prio-high", { priority: "high" }, true],
      ["resolved", { status: "resolved" }, false],
      ["notified", { last_notified_at: new Date(NIGHT_END - 3_600_000).toISOString() }, false],
      ["other-tenant", { tenant: TENANT_B }, false],
      ["other-space", { space: "business" }, false]
    ];
    for (const [name, over, counts] of cases) {
      await db.reset();
      await setQuiet();
      await heldRow(`k-${name}`, over);
      const { gateway, telegram } = db.newGateway();
      const res = await svc().deliver(TENANT_A, "home", gateway, id(), MORNING);
      expect(res.status, name).toBe(counts ? "sent" : "nothing_to_report");
      expect(telegram.messages.length, name).toBe(counts ? 1 : 0);
    }
  });
});

describe("FIX-11 (i): `classifyDelivery` (rent): kun kallet som faktisk sendte er `sent`", () => {
  const ok = (deduplicated: boolean): ToolResult => ({ ok: true, output_trust: "internal", deduplicated });
  it("utfoert nå = sent; deduplisert (vinneren hadde bekreftet) og «i flukt/ukjent utfall» = already_sent; alt annet = failed", () => {
    expect(classifyDelivery(ok(false))).toBe("sent");
    expect(classifyDelivery(ok(true))).toBe("already_sent");
    expect(classifyDelivery({ ok: false, reason: IN_FLIGHT_OR_UNKNOWN_OUTCOME })).toBe("already_sent");
    expect(IN_FLIGHT_OR_UNKNOWN_OUTCOME).toBe("execution_in_flight_or_outcome_unknown"); // gatewayens faste avslagsgrunn (gateway.ts)
    for (const reason of ["kill_switch_active", "tool_timeout", "policy_denied:x", "postcondition_unverified", "transport_error", ""]) expect(classifyDelivery({ ok: false, reason }), reason).toBe("failed");
  });
});

describe("FIX-11 (i): samtidige deliver for samme natt - nøyaktig ett `sent`, ett transportkall", () => {
  it("4 samtidige: ETT `sent`, resten `already_sent`; ett transportkall; ledgeren har ÉN rad `succeeded`", async () => {
    await setQuiet();
    await heldRow("conc");
    const { gateway, telegram } = db.newGateway();
    // gjoer transporten treg saa de samtidige kallene faktisk overlapper (taperne moeter en rad som er `reserved` eller `succeeded`)
    const original = telegram.invoke.bind(telegram);
    telegram.invoke = async (action: string, parameters: Record<string, JsonValue>) => { await new Promise((r) => setTimeout(r, 60)); return original(action, parameters); };
    for (let round = 0; round < 3; round += 1) {
      await db.adminPool.query(`DELETE FROM tool_executions WHERE tenant_id = $1`, [TENANT_A]);
      telegram.calls.length = 0;
      const out = await Promise.all([1, 2, 3, 4].map(() => svc().deliver(TENANT_A, "home", gateway, id(), MORNING)));
      const statuses = out.map((o) => o.status).sort();
      expect(statuses, `runde ${round}`).toEqual(["already_sent", "already_sent", "already_sent", "sent"]);
      expect(telegram.calls, `runde ${round}`).toHaveLength(1);
      expect(await ledger()).toEqual([{ status: "succeeded" }]);
    }
  });

  it("et tikk etter at meldingen er sendt gir `already_sent` (ingen ny melding), og en senere natt gir en ny", async () => {
    await setQuiet();
    await heldRow("again");
    const { gateway, telegram } = db.newGateway();
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING)).status).toBe("sent");
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING + 60_000)).status).toBe("already_sent");
    expect(telegram.calls).toHaveLength(1);
  });
});

describe("FIX-11 (ii): hva som sendes paa nytt og hva som ALDRI sendes paa nytt (ærlig, pinnet)", () => {
  const swap = (gateway: ReturnType<G4Db["newGateway"]>["gateway"], over: Partial<ToolDefinition>) => gateway.register({ ...gateway.get("telegram", "notify")!, ...over } as ToolDefinition);

  it("ren transportfeil (ECONNRESET) paa klasse B: ledger `failed`, neste tikk sender paa nytt (ETT ekstra forsoek; dokumentert begrensning, ikke et ukjent utfall for gatewayen)", async () => {
    await setQuiet();
    await heldRow("econn");
    const { gateway } = db.newGateway();
    let calls = 0;
    swap(gateway, { transport: { async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { calls += 1; throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); } } as ToolTransport });
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING)).status).toBe("failed");
    expect(await ledger()).toEqual([{ status: "failed" }]);
    // transporten er frisk igjen: neste tikk sender (og kun det)
    swap(gateway, { transport: { async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { calls += 1; return { external_id: "ok-1" }; } } as ToolTransport });
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING + 60_000)).status).toBe("sent");
    expect(calls).toBe(2);
    expect(await ledger()).toEqual([{ status: "succeeded" }]);
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING + 120_000)).status).toBe("already_sent");
    expect(calls).toBe(2);
  });

  it("gateway-tidsavbrudd = ukjent utfall: ledger `unverified`, sendes ALDRI paa nytt", async () => {
    await setQuiet();
    await heldRow("timeout");
    const { gateway } = db.newGateway();
    let calls = 0;
    swap(gateway, { timeout_ms: 150, transport: { async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { calls += 1; return new Promise(() => undefined); } } as ToolTransport });
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING)).status).toBe("failed");
    expect(await ledger()).toEqual([{ status: "unverified" }]);
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING + 60_000)).status).toBe("already_sent");
    expect(calls).toBe(1);
  });

  it("krasj midt i sendingen (raden staar som `reserved`): sendes ALDRI paa nytt", async () => {
    await setQuiet();
    await heldRow("crash");
    const { gateway, telegram } = db.newGateway();
    await db.adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state) VALUES ($1, $2, 'telegram', 'notify', 'reserved', '{}'::jsonb)`,
      [TENANT_A, `situation-morning-summary:${TENANT_A}:home:${new Date(NIGHT_END).toISOString()}`]
    );
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), MORNING)).status).toBe("already_sent");
    expect(telegram.calls).toHaveLength(0);
  });

  it("etterfyllingsgrensen er uendret: akkurat 12 t etter slutt sendes, +1 ms er `outside_window`", async () => {
    await setQuiet();
    await heldRow("window");
    const { gateway } = db.newGateway();
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), NIGHT_END + MORNING_SUMMARY_CATCH_UP_MS + 1)).status).toBe("outside_window");
    expect((await svc().deliver(TENANT_A, "home", gateway, id(), NIGHT_END + MORNING_SUMMARY_CATCH_UP_MS)).status).toBe("sent");
  });
});
