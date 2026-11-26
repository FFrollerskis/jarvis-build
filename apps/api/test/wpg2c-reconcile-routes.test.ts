import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, personalActionIndex, type ReconcileOutcome } from "@jarvis/tool-gateway";
import { handlePersonalRoute, type PersonalActionsDeps, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2c (D-483, Q-73 pkt 10): `POST /personal/actions/reconcile` - rutegrensene (funksjonelt, med spioner): rekkefølgen grant -> KUN eier -> step-up -> avstemming (en port som avviser hindrer ALLE senere steg), kun `action_id` i kroppen,
 * bevisste feilkoder med riktig status (aldri en intern feiltekst), responsens form, og at wiringen faktisk kobler avstemmingen (ikke et nytt verktøy, ingen modellflate).
 */
const owner: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };
const ACTION_ID = "pers-act-aaaaaaaa-1111-2222-3333-444444444444";

const outcome = (over: Partial<ReconcileOutcome> = {}): ReconcileOutcome => ({
  action: { action_id: ACTION_ID, status: "applied", reconcile_attempts: 1 } as never, resolution: "applied", basis: "postcondition_observed", observed: { entity_id: "lock.a", state: "locked", settled: true, usable: true }, replayed: false, ...over
});

function harness(opts: { body?: Record<string, unknown>; authed?: boolean; owner?: boolean; stepUp?: string | undefined; reconcile?: (identity: IdentityContext, input: { action_id: string }) => Promise<ReconcileOutcome> } = {}) {
  const calls: string[] = [];
  const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  const authedKeys: Array<readonly string[]> = [];
  const reconcile = vi.fn(async (identity: IdentityContext, input: { action_id: string }) => { calls.push("reconcile"); return (opts.reconcile ?? (async () => outcome()))(identity, input); });
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  const actions: PersonalActionsDeps = {
    executor: { pool: {} as never, gateway: { execute: vi.fn(async () => { calls.push("gateway.execute"); return { ok: true }; }), get: () => ({}) } as never, journal: {} as never, index },
    domains: new Map([["home", { toolId: "home-assistant", readAction: HOME_CRITICAL_READ_ACTION }]]),
    run: (async () => { calls.push("run"); throw new Error("reconcile skal aldri utføre en handling"); }) as never,
    reconcile: reconcile as never
  };
  const ctx: PersonalRouteContext = {
    req: { method: "POST" } as never, res: {} as never, url: new URL("/personal/actions/reconcile", "http://localhost"), deps: { actions },
    authed: async (keys) => { calls.push("authed"); authedKeys.push(keys); return opts.authed === false ? null : { identity: owner, body: opts.body ?? { action_id: ACTION_ID } }; },
    requireOwner: async (_identity, subject) => { calls.push(`requireOwner:${subject.tool_id}.${subject.action}`); if (opts.owner === false) { responses.push({ status: 403, body: { error: "owner_required" } }); return false; } return true; },
    stepUpDenial: (_identity, action) => { calls.push(`stepUp:${action}`); return opts.stepUp; },
    json: (status, b) => { responses.push({ status, body: b as Record<string, unknown> }); }, requestId: () => "req-1",
    fieldString: (b, k) => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw new Error(`malformed:${k}`); return v; },
    fieldOptionalString: (b, k) => (typeof b[k] === "string" ? (b[k] as string) : undefined),
    fieldRecord: (b, k) => b[k] as Record<string, unknown>, fieldOptionalNumber: () => undefined,
    domainFailure: (status, code) => { responses.push({ status, body: { error: code, generic: true } }); }
  };
  return { ctx, calls, responses, reconcile, authedKeys };
}

describe("A: rekkefølge og porter - grant -> eier -> step-up -> avstemming", () => {
  it("lykkes med eier + signert økt: kroppen tillater KUN `action_id` (aldri identitet, domene eller parametre), identiteten er grantets, og svaret har avstemmingens form med `output_trust: untrusted`", async () => {
    const h = harness();
    expect(await handlePersonalRoute(h.ctx)).toBe(true);
    expect(h.calls).toEqual(["authed", "requireOwner:personal.actions_reconcile", "stepUp:personal_actions_reconcile", "reconcile"]);
    expect(h.authedKeys).toEqual([["action_id"]]);
    expect(h.reconcile).toHaveBeenCalledWith(owner, { action_id: ACTION_ID });
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]).toMatchObject({
      status: 200,
      body: { reconciliation: { resolution: "applied", basis: "postcondition_observed", replayed: false, output_trust: "untrusted", observed_state: { state: "locked" }, action: { action_id: ACTION_ID, status: "applied" } } }
    });
  });

  it("uten gyldig grant, uten eier og uten signert økt stanser den første avvisende porten ALLE senere steg (reconcile kalles aldri, aldri en gateway- eller handlingsvei)", async () => {
    const noGrant = harness({ authed: false });
    await handlePersonalRoute(noGrant.ctx);
    expect(noGrant.calls).toEqual(["authed"]);

    const notOwner = harness({ owner: false });
    await handlePersonalRoute(notOwner.ctx);
    expect(notOwner.calls).toEqual(["authed", "requireOwner:personal.actions_reconcile"]);
    expect(notOwner.responses[0]).toMatchObject({ status: 403, body: { error: "owner_required" } });

    const weak = harness({ stepUp: "signed_device_session_required" });
    await handlePersonalRoute(weak.ctx);
    expect(weak.calls).toEqual(["authed", "requireOwner:personal.actions_reconcile", "stepUp:personal_actions_reconcile"]);
    expect(weak.responses[0]).toMatchObject({ status: 403, body: { error: "step_up_required", reason: "signed_device_session_required", request_id: "req-1" } });
    for (const h of [noGrant, notOwner, weak]) { expect(h.reconcile).not.toHaveBeenCalled(); expect(h.calls).not.toContain("run"); expect(h.calls).not.toContain("gateway.execute"); }
  });

  it("`action_id` mangler/er ikke en streng: avvises av feltlesingen (ingenting avstemmes); ruten kaller aldri `run` (en handling) og aldri gatewayen selv (lesingen skjer inni avstemmingen)", async () => {
    const h = harness({ body: {} });
    await expect(handlePersonalRoute(h.ctx)).rejects.toThrow("malformed:action_id");
    expect(h.reconcile).not.toHaveBeenCalled();
    const ok = harness();
    await handlePersonalRoute(ok.ctx);
    expect(ok.calls).not.toContain("run");
    expect(ok.calls).not.toContain("gateway.execute");
  });
});

describe("B: feilkoder - kun våre egne, med riktig status; alt annet er generisk (aldri en intern feiltekst)", () => {
  const cases: Array<[string, number]> = [
    ["personal_action_reconcile_id_invalid", 400], ["personal_action_reconcile_owner_only", 403], ["personal_action_not_found", 404], ["personal_action_not_reconcilable", 409], ["personal_action_domain_not_enabled", 409], ["personal_action_target_busy", 409]
  ];
  for (const [code, status] of cases) {
    it(`${code} -> ${status} med koden i svaret`, async () => {
      const h = harness({ reconcile: async () => { throw new Error(code); } });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status, body: { error: "personal_action_rejected", reason: code, request_id: "req-1" } }]);
    });
  }

  it("en uventet feil (database, intern tekst med hemmelighet) gir 500 `personal_action_reconcile_failed` via domainFailure - meldingen når aldri svaret; en feil med en kode som ligner våre, men ikke er en av dem, behandles likedan", async () => {
    for (const message of ["connection refused postgres://user:hunter2@db/jarvis", "personal_action_secret_internal:token-123", "personal_action_target_busy_and_more"]) {
      const h = harness({ reconcile: async () => { throw new Error(message); } });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status: 500, body: { error: "personal_action_reconcile_failed", generic: true } }]);
      expect(JSON.stringify(h.responses)).not.toContain("hunter2");
      expect(JSON.stringify(h.responses)).not.toContain("token-123");
    }
  });

  it("alle utfall (`applied`/`failed`/`unknown`/`already_terminal`) leveres som 200 med begrunnelsen; en rad som forblir ukjent er et NORMALT svar, ikke en feil", async () => {
    for (const resolution of ["applied", "failed", "unknown", "already_terminal"] as const) {
      const h = harness({ reconcile: async () => outcome({ resolution, basis: `basis_${resolution}`, replayed: resolution === "already_terminal", observed: resolution === "already_terminal" ? null : { state: "x" } }) });
      await handlePersonalRoute(h.ctx);
      expect(h.responses[0]).toMatchObject({ status: 200, body: { reconciliation: { resolution, basis: `basis_${resolution}`, replayed: resolution === "already_terminal" } } });
    }
  });
});

describe("C: oppkoblingen - avstemmingen er kun en eier-rute (ingen modellflate, ingen nytt verktøy, ingen nytt flagg)", () => {
  it("med et personlig-flagg på har rute-avhengighetene en `reconcile` (ikke bare `run`); verktøylisten har INGEN avstemmings-handling (kun de eksisterende lese-/skrive-handlingene), og uten flagg finnes ingenting", () => {
    for (const env of [{ JARVIS_PERSONAL_HOME_CRITICAL: "on" }, { JARVIS_PERSONAL_CAR: "on" }, { JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_CAR: "on" }]) {
      const wiring = createPersonalWiring({ env, pool: {} as never, gateway: {} as never, readSecret: async () => null });
      expect(typeof wiring.deps?.actions?.reconcile, JSON.stringify(env)).toBe("function");
      expect(typeof wiring.deps?.actions?.run).toBe("function");
      expect(wiring.tools.map((t) => t.action).filter((a) => /reconcile/i.test(a)), "ingen verktøy for avstemming").toEqual([]);
    }
    const off = createPersonalWiring({ env: {}, pool: {} as never, gateway: {} as never, readSecret: async () => null });
    expect(off.deps).toBeUndefined();
    expect(off.tools).toEqual([]);
  });
});
