import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2c fiks-runde 1 (LOW-5, M21): OPPKOBLINGEN av `reconcile`. Hovedinvarianten er at avstemmingen aldri kan nå skrive-verktøyet, og den ligger i `createPersonalWiring` (`actions.reconcile`), ikke i selve avstemmingsfunksjonen:
 * en oppkobling mot eksekutoren (`executePersonalAction`) ville gjort `/personal/actions/reconcile` til en retry-vei. Beviset: `actions.reconcile` slår opp journalraden på id (avstemmings-veien, kun SELECT), skriver aldri en ny rad,
 * og gatewayen får aldri et kall. Falsk pool (ingen database) og falsk gateway.
 */
const owner: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };
const ID = "pers-act-aaaaaaaa-1111-2222-3333-444444444444";

function fakePool(): { pool: never; sql: string[] } {
  const sql: string[] = [];
  const client = { query: async (text: string) => { sql.push(String(text)); return { rows: [], rowCount: 0 }; }, release: () => undefined };
  return { pool: { connect: async () => client, query: client.query } as never, sql };
}

function wire(env: Record<string, string>): { wiring: ReturnType<typeof createPersonalWiring>; sql: string[]; gatewayCalls: string[] } {
  const { pool, sql } = fakePool();
  const gatewayCalls: string[] = [];
  const gateway = { get: () => ({}), execute: async (r: { tool_id: string; action: string }) => { gatewayCalls.push(`${r.tool_id}.${r.action}`); return { ok: true, data: null }; } };
  return { wiring: createPersonalWiring({ env, pool, gateway: gateway as never, readSecret: async () => null }), sql, gatewayCalls };
}

describe("oppkoblingen av reconcile (createPersonalWiring)", () => {
  it("`actions.reconcile` er avstemmings-veien: den slår opp raden (SELECT på id), finner ingen (`personal_action_not_found`), skriver ALDRI en journalrad og kaller aldri gatewayen - og er en annen funksjon enn `run` (eksekutoren)", async () => {
    const { wiring, sql, gatewayCalls } = wire({ JARVIS_PERSONAL_HOME_CRITICAL: "on" });
    const actions = wiring.deps?.actions;
    expect(actions).toBeDefined();
    expect(typeof actions!.reconcile).toBe("function");
    expect(actions!.reconcile).not.toBe(actions!.run);
    const outcome = await actions!.reconcile(owner, { action_id: ID }).then(() => "ok", (e: Error) => e.message);
    expect(outcome).toBe("personal_action_not_found");
    const journal = sql.filter((s) => /personal_action_journal/.test(s));
    expect(journal.some((s) => /FROM personal_action_journal WHERE tenant_id = \$1 AND action_id = \$2/.test(s)), "radoppslaget på id").toBe(true);
    expect(journal.some((s) => /INSERT INTO personal_action_journal/.test(s)), "ingen ny rad").toBe(false);
    expect(journal.some((s) => /UPDATE personal_action_journal/.test(s)), "ingen endring når raden ikke finnes").toBe(false);
    expect(gatewayCalls, "ingen handling og ingen lesing når raden ikke finnes").toEqual([]);
  });

  it("en forespørsel som IKKE er en avstemming (ukjent handling, parametre, idempotensnøkkel) er aldri en handling: `actions.reconcile` avviser den som id-feil uten å røre databasen eller gatewayen", async () => {
    const { wiring, sql, gatewayCalls } = wire({ JARVIS_PERSONAL_HOME_CRITICAL: "on" });
    const reconcile = wiring.deps!.actions!.reconcile;
    const forged = { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: "k-0000-forged" } as never;
    await expect(reconcile(owner, forged)).rejects.toThrow("personal_action_reconcile_id_invalid");
    await expect(reconcile(owner, { action_id: "critical_lock" })).rejects.toThrow("personal_action_reconcile_id_invalid");
    expect(sql.filter((s) => /personal_action_journal/.test(s))).toEqual([]);
    expect(gatewayCalls).toEqual([]);
  });

  it("eier-assert gjelder også gjennom oppkoblingen: en delegat avvises (`personal_action_reconcile_owner_only`) FØR noe slås opp", async () => {
    const { wiring, sql, gatewayCalls } = wire({ JARVIS_PERSONAL_HOME_CRITICAL: "on" });
    await expect(wiring.deps!.actions!.reconcile({ ...owner, delegation_id: "deleg-1" }, { action_id: ID })).rejects.toThrow("personal_action_reconcile_owner_only");
    expect(sql).toEqual([]);
    expect(gatewayCalls).toEqual([]);
  });

  it("uten et domene-flagg finnes verken `actions` eller `reconcile` (rute 404), og med bil-flagget alene er avstemmingen også uten skrive-vei", async () => {
    expect(wire({}).wiring.deps).toBeUndefined();
    const car = wire({ JARVIS_PERSONAL_CAR: "on" });
    expect(typeof car.wiring.deps?.actions?.reconcile).toBe("function");
    await expect(car.wiring.deps!.actions!.reconcile(owner, { action_id: ID })).rejects.toThrow("personal_action_not_found");
    expect(car.gatewayCalls).toEqual([]);
  });
});
