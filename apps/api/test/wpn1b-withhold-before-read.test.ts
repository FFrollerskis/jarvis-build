import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withholdFinanceFromCurrentModel } from "@jarvis/tool-gateway";
import { runWithModelScope } from "../../../modules/tool-gateway/src/model-scope.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import {
  BLANK_MODEL, CLOUD, FIN, LOCAL, OWNER, TENANT, UNKNOWN_MODEL, buildWorld, fakeDef, identity, run, seedConversationGraph, seedOpenLoops,
  type ModelArg, type ReadCounters, type World
} from "./support/n1b-finance-world.ts";

/**
 * WP-N1b fiks-runde 1 (FIX-7): tre ting mutantene fra gjennomgangene viste at ingen test låste.
 *  A. «VED UTFØRELSE, FØR verktøyet leser» (C23/C24): for de stiene der hele svaret holdes tilbake (kun merket) leses KILDEN ikke i det hele tatt for en sky-/ukjent modell - en spion i kilden (verdi-, selvdiagnose-, AI Mesh-, evolusjons-,
 *     infra-, kostnadskilden) viser null kall; lokal modell og eier leser den som før. Unntak (må lese for å bygge det ikke-finansielle svaret; finansinnholdet filtreres FØR det forlater tjenesten, bevist av kartleggingstabellen og
 *     orakel-testen): SLO-rapporten, kapabilitet/connector-status, kø/enkeltoppslag, forretnings-OS (SQL-hvitliste), tverr-kanal, senterbyggerne og `list_connector_maintenance` (leser kun vedlikeholdsloggen, aldri kostnadsdata).
 *  B. De to armene i `ExecutiveService` (kontrollflate og delegeringstavle) virker HVER for seg: det eksplisitte per-tjeneste-valget (dybdeforsvar, F-B1) UTEN sentral kontekst, og den sentrale lesningen UTEN valg (A53/A55).
 *  C. `centerResponse`/oversikten bruker `isCloudServed(modell) || sentral lesning`: leddene er EKVIVALENTE (C20/C21) - testen låser at de gir samme svar for alle modellformer, så det ene aldri kan løsne det andre.
 */
let db: H0Db;
let w: World;
const text = (r: { ok: boolean; reason?: string; data?: unknown }): string => JSON.stringify(r.ok ? r.data : { denied: r.reason });
const MODELS_WITHHELD: Array<[string, ModelArg]> = [["sky", CLOUD], ["ukjent leverandør", UNKNOWN_MODEL], ["blank leverandør", BLANK_MODEL]];
const MODELS_FULL: Array<[string, ModelArg]> = [["lokal modell", LOCAL], ["eierens rute (ingen modell)", undefined]];
const snapshot = (r: ReadCounters): ReadCounters => ({ ...r });

beforeAll(async () => {
  db = await startH0Db("n1bbefore");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  await seedOpenLoops(db.adminPool);
  await seedConversationGraph(db.adminPool);
  w = buildWorld({ pool: db.appPool, guard: true, realCenters: true });
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("A: kilden leses IKKE for sky/ukjent på stiene der hele svaret holdes tilbake (spion), men leses for lokal modell og eier", () => {
  const PATHS: Array<{ id: string; tool: string; action: string; counter: keyof ReadCounters }> = [
    { id: "R15 get_value_report", tool: "executive", action: "get_value_report", counter: "value" },
    { id: "R18 get_self_diagnosis", tool: "executive", action: "get_self_diagnosis", counter: "selfModel" },
    { id: "R19 get_ai_mesh_status", tool: "executive", action: "get_ai_mesh_status", counter: "aiMesh" },
    { id: "R20 get_evolution_report", tool: "executive", action: "get_evolution_report", counter: "evolution" },
    { id: "R25 get_infra_status", tool: "executive", action: "get_infra_status", counter: "infra" },
    { id: "R16 get_cost_overview", tool: "run_rate", action: "get_cost_overview", counter: "runRateReport" }
  ];
  for (const p of PATHS) {
    for (const [label, model] of MODELS_WITHHELD) {
      it(`${p.id}: ${label} - kilden er ikke lest (ingen kall til tjenesten/databasen), svaret er kun merket`, async () => {
        const before = snapshot(w.reads);
        const r = await run(w.gateway, p.tool, p.action, {}, model);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(w.reads[p.counter], `${p.id}: kilden ble lest for en sky-modell`).toBe(before[p.counter]);
        expect(text(r)).toContain('"finance_withheld":true');
      });
    }
    for (const [label, model] of MODELS_FULL) {
      it(`${p.id}: ${label} - kilden leses som før`, async () => {
        const before = snapshot(w.reads);
        const r = await run(w.gateway, p.tool, p.action, {}, model);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(w.reads[p.counter]).toBeGreaterThan(before[p.counter]);
        expect(text(r)).not.toContain("finance_withheld");
      });
    }
  }

  it("R22 list_connector_maintenance: sky/ukjent leser KUN vedlikeholdsloggen (aldri kostnadsrapporten); lokal modell og eier leser rapporten som før", async () => {
    for (const [label, model] of MODELS_WITHHELD) {
      const before = snapshot(w.reads);
      const r = await run(w.gateway, "run_rate", "list_connector_maintenance", {}, model);
      expect(r.ok, label).toBe(true);
      expect(w.reads.runRateReport, `${label}: kostnadsrapporten ble lest`).toBe(before.runRateReport);
      expect(w.reads.runRateMaintenance, label).toBe(before.runRateMaintenance + 1);
    }
    for (const [label, model] of MODELS_FULL) {
      const before = snapshot(w.reads);
      await run(w.gateway, "run_rate", "list_connector_maintenance", {}, model);
      expect(w.reads.runRateReport, label).toBe(before.runRateReport + 1);
      expect(w.reads.runRateMaintenance, label).toBe(before.runRateMaintenance);
    }
  });
});

describe("B: de to armene i ExecutiveService virker hver for seg (per-tjeneste-valget uten sentral kontekst; sentral lesning uten valg)", () => {
  const cloudScope = <T>(fn: () => T): T => runWithModelScope({ servingModel: CLOUD, cloud: true }, fn);
  const localScope = <T>(fn: () => T): T => runWithModelScope({ servingModel: LOCAL, cloud: false }, fn);
  const full = (x: unknown): boolean => JSON.stringify(x).includes("stripe") && JSON.stringify(x).includes(FIN.killReason);
  const none = (x: unknown): boolean => !JSON.stringify(x).includes("stripe") && !JSON.stringify(x).includes(FIN.killReason) && !JSON.stringify(x).includes("finance_vipps");
  const calls = (): number => w.financeCalls();

  it("kontrollflaten: ingen valg og ingen skop = FULL (lokal/eier); det eksplisitte valget ALENE (ingen sentral kontekst) holder tilbake; den sentrale lesningen ALENE (sky-skop, ingen valg) holder tilbake; lokalt skop = full", async () => {
    let before = calls();
    const plain = await w.service.getControlSurfaceStatus(identity);
    expect(full(plain) && plain.finance_kill_switch !== null, "uten valg og skop").toBe(true);
    expect(calls()).toBe(before + 1);

    before = calls();
    const explicit = await w.service.getControlSurfaceStatus(identity, { withholdFinance: true });
    expect(none(explicit), "kun det eksplisitte valget").toBe(true);
    expect(explicit.finance_kill_switch).toBeNull();
    expect(explicit.finance_kill_switch_withheld).toBe(true);
    expect(calls(), "det nøstede finansoppslaget ble utført").toBe(before);

    const central = await cloudScope(() => w.service.getControlSurfaceStatus(identity));
    expect(none(central), "kun den sentrale lesningen").toBe(true);
    expect(central.finance_kill_switch).toBeNull();
    expect(calls()).toBe(before);

    const local = await localScope(() => w.service.getControlSurfaceStatus(identity));
    expect(full(local), "lokalt skop").toBe(true);
  });

  it("delegeringstavlen: samme fire tilfeller", async () => {
    let before = calls();
    const plain = await w.service.getDelegationBoard(identity);
    expect(full(plain)).toBe(true);
    expect(calls()).toBe(before + 1);

    before = calls();
    const explicit = await w.service.getDelegationBoard(identity, { withholdFinance: true });
    expect(none(explicit) && explicit.finance_kill_switch_withheld === true && explicit.finance_kill_switch === null, "kun det eksplisitte valget").toBe(true);
    expect(JSON.stringify(explicit)).not.toContain(FIN.policyParam);
    expect(calls()).toBe(before);

    const central = await cloudScope(() => w.service.getDelegationBoard(identity));
    expect(none(central) && central.finance_kill_switch_withheld === true, "kun den sentrale lesningen").toBe(true);
    expect(calls()).toBe(before);

    expect(full(await localScope(() => w.service.getDelegationBoard(identity))), "lokalt skop").toBe(true);
  });

  it("oppmerksomhetskøen: det eksplisitte valget ALENE holder `spend`- og `infra`-situasjonene ute", async () => {
    const plain = JSON.stringify(await w.service.getAttentionQueue(identity));
    expect(plain).toContain("sit-spend-1");
    expect(plain).toContain("sit-infra-1");
    const explicit = JSON.stringify(await w.service.getAttentionQueue(identity, {}, { withholdFinance: true }));
    for (const m of ["sit-spend-1", "sit-spend-2", "sit-infra-1", "sit-infra-2", FIN.amount, FIN.infraTitle]) expect(explicit, m).not.toContain(m);
    expect(explicit).toContain("sit-pipe-1");
  });
});

describe("C: `isCloudServed(modell)` (per-kall) og den sentrale lesningen (skop) gir SAMME avgjørelse for alle modellformer (C20/C21: leddene i `centerResponse` er ekvivalente)", () => {
  it("batteri av modellformer: lokale leverandørnavn, sky, ukjent, blank, STORE bokstaver, mellomrom, ikke-objekter og `null`", async () => {
    let seen: boolean | undefined;
    w.gateway.register({ ...fakeDef("probe", "scope", null), transport: { async invoke() { seen = withholdFinanceFromCurrentModel(); return { data: { ok: true } }; } } });
    const FORMS: Array<[string, unknown]> = [
      ["sky", CLOUD], ["lokal gemma", LOCAL], ["ukjent", UNKNOWN_MODEL], ["blank", BLANK_MODEL], ["ollama", { provider: "ollama", model: "x" }], ["local_llm", { provider: "local_llm", model: "x" }], ["scripted", { provider: "scripted", model: "x" }],
      ["local_vision", { provider: "local_vision", model: "x" }], ["STORE bokstaver", { provider: "GEMMA_LOCAL", model: "x" }], ["mellomrom foran", { provider: " gemma_local", model: "x" }], ["provider: tall", { provider: 5, model: "x" }],
      ["tomt objekt", {}], ["tom streng", ""], ["null", null], ["streng", "gemma_local"], ["lokal uten model", { provider: "gemma_local" }]
    ];
    for (const [label, form] of FORMS) {
      seen = undefined;
      const r = await w.gateway.execute({ identity, tool_id: "probe", action: "scope", parameters: {}, idempotency_key: `k-${Math.random().toString(36).slice(2)}`, servingModel: form as never });
      expect(r.ok, label).toBe(true);
      expect(seen, `${label}: den sentrale lesningen`).toBe(w.service.isCloudServed(form as never));
    }
  });
});
