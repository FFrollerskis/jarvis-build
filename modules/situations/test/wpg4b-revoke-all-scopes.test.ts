import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { SituationAutonomyUnauthorizedError, SituationEngine } from "../src/service.ts";
import { NOW, OWNER, TENANT_A, TENANT_B, identity, record, startG4Db, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4b fiks-runde 1, FIX-2/2b (Q-G4-15 lukket): et DOMENEBREDT tilbakekall (`clearAutonomyPolicy` uten skop; det «Tilbakekall autonomi»-knappen og `executive.revoke_autonomy_binding` gjør) fjerner ALLE bindingsrader i
 * (tenant, rom, domene) i samme transaksjon, under domenelåsen. Før fiksen slettet det kun den brede raden: taket (en avslått/utløpt bred rad) forsvant da, og aktive regel-/kategoribindinger begynte å utføre igjen uten ny eierhandling.
 * Akseptanse: etter et domenebredt tilbakekall kan INGEN binding i domenet utføre noe før eieren eksplisitt har gitt en ny. Et tilbakekall MED skop (`rule`/`category`) fjerner fortsatt akkurat den ene raden og lar den brede stå.
 */
const DOOR = "home_assistant:door_open_too_long";
const LEAK = "home_assistant:water_leak";
const ROW_RULE = `rule:${DOOR}`;
const ROW_CAT = "category:opening";

type RowState = "active" | "disabled" | "expired";

class Spy implements ToolTransport {
  calls = 0;
  async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { this.calls += 1; return { external_id: `x-${this.calls}` }; }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
/** Første kall blir stående «i flukt» (holder domenelåsen) til testen åpner porten; hver hendelse logges i EN felles rekkefølge, så rekkefølgen kan sammenlignes uten klokke. */
class GatedSpy implements ToolTransport {
  calls = 0;
  readonly started = deferred();
  readonly gate = deferred();
  constructor(private readonly order: string[]) {}
  async invoke(): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls += 1;
    this.order.push(`call:${this.calls}:start`);
    if (this.calls === 1) {
      this.started.resolve();
      await this.gate.promise;
    }
    this.order.push(`call:${this.calls}:end`);
    return { external_id: `x-${this.calls}` };
  }
}
const toolDef = (tool_id: string, transport: ToolTransport): ToolDefinition => ({
  tool_id, action: "act", description: "t", input_schema: record({ situation_id: z.string().optional() }), capability_class: "B", scopes: [], reversible: true, rollback_procedure: "angre", idempotent_external: false,
  timeout_ms: 5000, rate_limit_per_minute: 100000, credential_ref: "TEST_TOKEN", output_trust: "internal", transport, autonomy_bindable: TEST_BINDABLE
} as ToolDefinition);

describe("FIX-2/2b: domenebredt tilbakekall fjerner ALLE bindinger i domenet (ekte Postgres, ekte motor og gateway)", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_revoke"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  /** Tre verktøy, ett per skop, slik at det alltid er synlig HVILKEN binding som utførte. */
  function world() {
    const built = db.newGateway();
    const spies = { rule: new Spy(), cat: new Spy(), dom: new Spy() };
    built.gateway.register(toolDef("rv_rule", spies.rule));
    built.gateway.register(toolDef("rv_cat", spies.cat));
    built.gateway.register(toolDef("rv_dom", spies.dom));
    return { ...built, spies };
  }
  const total = (w: ReturnType<typeof world>): number => w.spies.rule.calls + w.spies.cat.calls + w.spies.dom.calls;

  /** Direkte SQL, slik at også en UTLØPT rad kan opprettes (bind-API-et nekter en utløpstid i fortiden). */
  const insertRow = (scope: string, tool_id: string, state: RowState, over: { space?: string; tenant?: string; domain?: string } = {}) => db.adminPool.query(
    `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id, expires_at, scope_key)
     VALUES ($1,$2,$3,$4,'act','{"situation_id":"{{situation_id}}"}'::jsonb,$5,$6,$7,$8)`,
    [over.tenant ?? TENANT_A, over.space ?? "home", over.domain ?? "home", tool_id, state !== "disabled", OWNER, state === "expired" ? new Date(Date.now() - 3_600_000).toISOString() : null, scope]
  );
  const seedDoorSituation = async (key: string) =>
    (await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: key, priority: "high", confidence: 0.9, reason: "r", rule_key: DOOR }, NOW)).situation;
  const scopes = async (space = "home", tenant = TENANT_A): Promise<string[]> => (await db.engine.listAutonomyPolicies(tenant, space as never)).map((p) => `${p.domain}/${p.scope_key}`).sort();
  const sweep = (w: ReturnType<typeof world>) => db.engine.autoActPending(TENANT_A, "home", w.gateway, identity(TENANT_A, "home"));
  const revokeDomain = (domain = "home", space = "home", tenant = TENANT_A) => db.engine.clearAutonomyPolicy(tenant, space as never, domain, OWNER);

  for (const broad of ["active", "disabled", "expired"] as const) {
    it(`bred rad ${broad} + aktiv regelrad: før tilbakekallet er utfallet (utfører/tak) som designet; ETTER det utfører INGENTING (regelraden er også borte)`, async () => {
      const w = world();
      await insertRow("*", "rv_dom", broad);
      await insertRow(ROW_RULE, "rv_rule", "active");
      await seedDoorSituation(`home:revoke:${broad}`);
      // før tilbakekallet: en aktiv bred rad lar regelbindingen utføre (regel > domene); en avslått/utløpt bred rad er et TAK (ingenting utføres)
      await sweep(w);
      expect(w.spies.rule.calls, `før clear (${broad})`).toBe(broad === "active" ? 1 : 0);
      expect(w.spies.dom.calls, `før clear (${broad}): regel > domene`).toBe(0);
      w.spies.rule.calls = 0;
      // en NY situasjon (en annen detection_key) så ikke claimen fra første sveip hindrer utførelse
      await seedDoorSituation(`home:revoke:${broad}:2`);
      expect(await revokeDomain()).toBe(true);
      expect(await scopes()).toEqual([]);
      const res = await sweep(w);
      expect(res).toMatchObject({ attempted: 0, succeeded: 0 });
      expect(total(w), `etter clear (${broad}): regelbindingen er borte og ingenting utfører`).toBe(0);
    });
  }

  it("PB4: bred rad + regelrad (bindet via motoren, begge aktive); et domenebredt tilbakekall stopper også regelbindingen (attempted = 0)", async () => {
    const { gateway, actuator } = db.newGateway();
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }] } }, { person_id: OWNER, session_id: "s" });
    const params = { situation_id: "{{situation_id}}" };
    await db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: params } as never, OWNER);
    await db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: params, rule: DOOR } as never, OWNER);
    await seedDoorSituation("home:revoke:pb4");
    expect(await revokeDomain()).toBe(true);
    expect(await scopes()).toEqual([]);
    const res = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(res.attempted).toBe(0);
    expect(actuator.calls.filter((c) => c.action === "close")).toEqual([]);
  });

  it("kun smale rader (ingen bred rad): et domenebredt tilbakekall fjerner regel- OG kategoribindingen; ingenting utfører etterpå", async () => {
    const w = world();
    await insertRow(ROW_RULE, "rv_rule", "active");
    await insertRow(ROW_CAT, "rv_cat", "active");
    await insertRow("category:leak", "rv_cat", "disabled");
    await seedDoorSituation("home:revoke:narrow-only");
    expect(await scopes()).toEqual(["home/category:leak", `home/${ROW_CAT}`, `home/${ROW_RULE}`]);
    expect(await revokeDomain()).toBe(true);
    expect(await scopes()).toEqual([]);
    expect(await sweep(w)).toMatchObject({ attempted: 0 });
    expect(total(w)).toBe(0);
    // idempotent: et nytt tilbakekall finner ingenting
    expect(await revokeDomain()).toBe(false);
  });

  it("ny binding krever eksplisitt eierhandling: etter tilbakekallet gir først en NY `set_autonomy_policy` autonomi igjen (ingenting gjenoppstår av seg selv)", async () => {
    const w = world();
    await insertRow("*", "rv_dom", "disabled");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await seedDoorSituation("home:revoke:rebind");
    await revokeDomain();
    expect(await sweep(w)).toMatchObject({ attempted: 0 });
    await db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "rv_rule", action: "act", parameters: { situation_id: "{{situation_id}}" }, rule: DOOR } as never, OWNER);
    expect(await sweep(w)).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(w.spies.rule.calls).toBe(1);
  });

  it("tilbakekall MED skop fjerner akkurat den ene raden og lar den brede (og de andre smale) stå; den brede utfører fortsatt for resten", async () => {
    const w = world();
    await insertRow("*", "rv_dom", "active");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await insertRow(ROW_CAT, "rv_cat", "active");
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER, { rule: DOOR })).toBe(true);
    expect(await scopes()).toEqual([`home/${ROW_CAT}`, "home/*"].sort());
    // regelraden er borte: kategorien (opening) gjelder nå for døren
    await seedDoorSituation("home:revoke:scoped-1");
    await sweep(w);
    expect(w.spies.cat.calls).toBe(1);
    expect(w.spies.rule.calls).toBe(0);
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER, { category: "opening" })).toBe(true);
    expect(await scopes()).toEqual(["home/*"]);
    // en rad som ikke finnes: false, ingenting røres
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER, { category: "opening" })).toBe(false);
    expect(await scopes()).toEqual(["home/*"]);
    // den brede utfører for en regel uten egen binding
    const leak = (await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: "home:revoke:leak", priority: "high", confidence: 0.9, reason: "r", rule_key: LEAK }, NOW)).situation;
    expect(leak.rule_key).toBe(LEAK);
    await sweep(w);
    expect(w.spies.dom.calls).toBeGreaterThanOrEqual(1);
  });

  it("isolasjon: kun (tenant, rom, domene) til tilbakekallet røres; andre domener, andre rom og en annen tenant står urørt", async () => {
    await insertRow("*", "rv_dom", "active");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await insertRow("*", "rv_dom", "active", { domain: "infra" });
    await insertRow("*", "rv_dom", "active", { space: "business" });
    await insertRow(ROW_RULE, "rv_rule", "active", { space: "business" });
    await insertRow(ROW_RULE, "rv_rule", "active", { tenant: TENANT_B });
    expect(await revokeDomain()).toBe(true);
    expect(await scopes("home")).toEqual(["infra/*"]);
    expect(await scopes("business")).toEqual([`home/${ROW_RULE}`, "home/*"].sort());
    expect(await scopes("home", TENANT_B)).toEqual([`home/${ROW_RULE}`]);
  });

  it("isolasjonen hviler ikke på radnivåsikkerhet (RLS) alene: en tilkobling UTEN RLS (eierrollen) fjerner med domenebredt tilbakekall fortsatt kun (tenant, rom, domene) - SQL-filtrene er et eget lag", async () => {
    await insertRow("*", "rv_dom", "active");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await insertRow("*", "rv_dom", "active", { domain: "infra" });
    await insertRow("*", "rv_dom", "active", { space: "business" });
    await insertRow(ROW_RULE, "rv_rule", "active", { space: "business" });
    await insertRow(ROW_RULE, "rv_rule", "active", { tenant: TENANT_B });
    // Samme motor, men på superuser-poolen: RLS gjelder ikke, så KUN `WHERE tenant_id AND memory_space_id AND domain` holder de andre radene urørt.
    const noRls = new SituationEngine(db.adminPool, db.domainPauses, { owner_person_id: OWNER });
    expect(await noRls.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER)).toBe(true);
    expect(await scopes("home")).toEqual(["infra/*"]);
    expect(await scopes("business")).toEqual([`home/${ROW_RULE}`, "home/*"].sort());
    expect(await scopes("home", TENANT_B)).toEqual([`home/${ROW_RULE}`]);
  });

  it("`clearAutonomyPolicyScopes` oppgir NØYAKTIG hvilke skop som ble fjernet (sortert), også for et skopet tilbakekall; tom liste når ingenting fantes", async () => {
    await insertRow("*", "rv_dom", "active");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await insertRow(ROW_CAT, "rv_cat", "disabled");
    expect(await db.engine.clearAutonomyPolicyScopes(TENANT_A, "home", "home", OWNER, { category: "opening" })).toEqual([ROW_CAT]);
    expect(await db.engine.clearAutonomyPolicyScopes(TENANT_A, "home", "home", OWNER)).toEqual(["*", ROW_RULE]);
    expect(await db.engine.clearAutonomyPolicyScopes(TENANT_A, "home", "home", OWNER)).toEqual([]);
  });

  it("kun eieren kan tilbakekalle: en annen aktør avvises og ingen rad røres (heller ikke de smale)", async () => {
    await insertRow("*", "rv_dom", "active");
    await insertRow(ROW_RULE, "rv_rule", "active");
    await expect(db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", "person-g4-other")).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    await expect(db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", undefined)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    expect(await scopes()).toEqual([`home/${ROW_RULE}`, "home/*"].sort());
  });

  /** FIX-B (delta-review, mutant D08: `[domain]` -> `[]` i `clearAutonomyPolicyScopes`): domenelåsen er det som gjør at et tilbakekall ikke kan kappløpe med et auto-ACT-kall i flukt. */
  it("tilbakekall under et PÅGÅENDE auto-ACT-kall venter på domenelåsen: clear returnerer først ETTER at kallet er ferdig, og INGEN kall starter etter at clear har returnert", async () => {
    const order: string[] = [];
    const spy = new GatedSpy(order);
    const built = db.newGateway();
    built.gateway.register(toolDef("lock_tool", spy));
    await insertRow("*", "lock_tool", "active");
    await insertRow(ROW_RULE, "lock_tool", "active");
    for (let i = 0; i < 4; i++) await seedDoorSituation(`home:lock:${i}`);
    const sweepP = db.engine.autoActPending(TENANT_A, "home", built.gateway, identity(TENANT_A, "home"));
    await spy.started.promise; // første kall er i flukt og holder domenelåsen (porten er lukket)
    expect(order).toEqual(["call:1:start"]);
    let cleared = false;
    const clearP = db.engine.clearAutonomyPolicyScopes(TENANT_A, "home", "home", OWNER).then((removed) => { cleared = true; order.push("clear:returned"); return removed; });
    // Uten domenelåsen ville tilbakekallet vært ferdig på noen få millisekunder (én DELETE); med den står det og venter så lenge kallet er i flukt.
    await new Promise((r) => setTimeout(r, 400));
    expect(cleared, "clear venter på domenelåsen mens kallet er i flukt").toBe(false);
    expect(order, "ingenting er skjedd siden det første kallet startet").toEqual(["call:1:start"]);
    expect(await scopes(), "radene står fortsatt: tilbakekallet har ikke kjørt").toEqual([`home/${ROW_RULE}`, "home/*"].sort());
    spy.gate.resolve(); // kallet blir ferdig, låsen frigjøres
    expect(await clearP).toEqual(["*", ROW_RULE]);
    await sweepP;
    const returned = order.indexOf("clear:returned");
    expect(order.indexOf("call:1:end"), "det pågående kallet ble ferdig FØR clear returnerte").toBeGreaterThan(-1);
    expect(order.indexOf("call:1:end")).toBeLessThan(returned);
    expect(order.slice(returned + 1).filter((e) => e.endsWith(":start")), "INGEN kall starter etter at clear har returnert").toEqual([]);
    const callsAtClear = spy.calls;
    expect(callsAtClear).toBeLessThanOrEqual(2); // det i-flukt-kallet, og høyst ett som rakk låsen før clear (låsen er ikke ordnet av testen)
    expect(await scopes()).toEqual([]);
    // et nytt sveip etterpå: ingen binding, ingen utførelse
    await seedDoorSituation("home:lock:after");
    expect(await db.engine.autoActPending(TENANT_A, "home", built.gateway, identity(TENANT_A, "home"))).toMatchObject({ attempted: 0, succeeded: 0 });
    expect(spy.calls).toBe(callsAtClear);
  });
});
