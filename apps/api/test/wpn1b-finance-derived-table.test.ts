import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import {
  BLANK_MODEL, CLOUD, FIN, KEEP, LOCAL, LOOP_IDS, OWNER, TENANT, UNKNOWN_MODEL, buildWorld, fakeDef, run, seedConversationGraph, seedOpenLoops,
  type ModelArg, type World
} from "./support/n1b-finance-world.ts";
import { CENTER_ROWS, ROWS } from "./support/n1b-rows.ts";

/**
 * WP-N1b (JARVIS-116 a, Q-76 pkt 7, Q-64 pkt 2; K2 + K4 a/c): KARTLEGGINGEN av avledet finansmetadata utenfor `finance*`-låsen, kjørt mot den EKTE koden (ekte Postgres som app-rolle, ekte `ToolGateway` med utførelseslås og
 * sentral modellkontekst, ekte `BusinessTransport`/`ExecutiveService`/`RunRateService`). Hver rad er en sti en modell kan kalle der finansavledet innhold kan bæres uten å være et `finance*`-verktøy:
 *  - SKYMODELL, ukjent leverandør og blank leverandør (fail-closed) får IKKE finansmarkørene, men får det ikke-finansielle innholdet (`keep`) og et nøytralt, innholdsfritt «holdt tilbake»-merke;
 *  - LOKAL modell og eierens ruter (ingen modell i løkka) får HELE innholdet, uten merke (D-378 pkt 2);
 *  - FLAGG AV (ingen lås): en skymodell får alt som før (identisk med main) - kontrollen som også viser at hullet fantes.
 * Den røde kjøringen mot main-koden (før fiksene) er dokumentert i runbooken og sluttrapporten.
 */
let db: H0Db;
let on: World;
let off: World;

const MODELS_WITHHELD: Array<[string, ModelArg]> = [["sky", CLOUD], ["ukjent leverandør", UNKNOWN_MODEL], ["blank leverandør", BLANK_MODEL]];
const MODELS_FULL: Array<[string, ModelArg]> = [["lokal modell", LOCAL], ["eierens rute (ingen modell)", undefined]];

beforeAll(async () => {
  db = await startH0Db("n1btab");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  await seedOpenLoops(db.adminPool);
  await seedConversationGraph(db.adminPool);
  on = buildWorld({ pool: db.appPool, guard: true });
  off = buildWorld({ pool: db.appPool, guard: false });
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const text = (r: { ok: boolean; reason?: string; data?: unknown }): string => JSON.stringify(r.ok ? r.data : { denied: r.reason });


beforeAll(async () => {
  // connector- og helsetilstand for R09/R10, kostnadsrader for R16 og vedlikeholdslogg for R22 (admin-pool: kun testdata)
  for (const world of [on, off]) {
    world.gateway.register(fakeDef("finance_stripe", "get_balance", { available: 1 }));
    (world.gateway.health as Map<string, unknown>).set("finance_stripe", { state: "auth_failed", at: "2026-11-25T09:00:00.000Z", detail: "N1B-HEALTH-DETAIL" });
    (world.gateway.health as Map<string, unknown>).set("github", { state: "healthy", at: "2026-11-25T09:00:00.000Z" });
  }
  await db.adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success) VALUES ($1, 'model_call', 77123, 'anthropic', 'claude', 'CHAT', true)", [TENANT]);
  for (const [connector, reason, minutes] of [["stripe", "N1B-VEDLIKEHOLD-STRIPE", 30], ["neonomics", "N1B-VEDLIKEHOLD-NEONOMICS", 20], ["github", "N1B-VEDLIKEHOLD-GITHUB", 10]] as const) {
    await db.adminPool.query("INSERT INTO connector_maintenance_log (tenant_id, connector_id, event_kind, minutes, reason, recorded_by) VALUES ($1, $2, 'manual_fix', $3, $4, 'test')", [TENANT, connector, minutes, reason]);
  }
});

describe("K2-tabellen: hver rad - sky/ukjent/blank = tilbakeholdt, lokal og eier = full, flagg AV = som main", () => {
  for (const row of ROWS) {
    describe(`${row.id} ${row.path}`, () => {
      for (const [label, model] of MODELS_WITHHELD) {
        it(`${label}: ingen finansmarkører, det vanlige innholdet er bevart, og det nøytrale merket står der`, async () => {
          const r = await run(on.gateway, row.tool, row.action, row.params ?? {}, model);
          expect(r.ok, JSON.stringify(r)).toBe(true);
          const t = text(r);
          for (const m of row.finance) expect(t, `lekket: ${m}`).not.toContain(m);
          for (const m of row.keep ?? []) expect(t, `mangler: ${m}`).toContain(m);
          if (row.marker !== undefined) expect(t).toContain(`"${row.marker}":true`);
        });
      }
      for (const [label, model] of MODELS_FULL) {
        it(`${label}: HELE innholdet (alle finansmarkører og det vanlige), uten «holdt tilbake»-merke`, async () => {
          const r = await run(on.gateway, row.tool, row.action, row.params ?? {}, model);
          expect(r.ok, JSON.stringify(r)).toBe(true);
          const t = text(r);
          for (const m of row.finance) expect(t, `mangler: ${m}`).toContain(m);
          for (const m of row.keep ?? []) expect(t, `mangler: ${m}`).toContain(m);
          expect(t).not.toContain('"finance_withheld"');
          expect(t).not.toContain('"withheld":true');
        });
      }
      it("FLAGG AV (ingen lås, ingen sentral kontekst): en skymodell får alt som før - identisk med main, uten merke", async () => {
        const r = await run(off.gateway, row.tool, row.action, row.params ?? {}, CLOUD);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const t = text(r);
        for (const m of row.finance) expect(t, `mangler: ${m}`).toContain(m);
        expect(t).not.toContain('"finance_withheld"');
      });
    });
  }
});

describe("K2: kontrollsentrene Autoritet, Integrasjoner og AI (EKTE byggere via registerControlCenters) - holdes tilbake HELT fra sky/ukjent kun med vakten på", () => {
  let onC: World;
  let offC: World;
  beforeAll(async () => {
    await db.adminPool.query("INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_by_person_id, enabled_at, reason) VALUES ($1, true, $2, now(), 'privat')", [TENANT, OWNER]);
    onC = buildWorld({ pool: db.appPool, guard: true, realCenters: true });
    offC = buildWorld({ pool: db.appPool, guard: false, realCenters: true });
  }, 120_000);

  for (const row of CENTER_ROWS) {
    describe(`${row.id} executive.get_control_center {center: ${row.center}}`, () => {
      for (const [label, model] of MODELS_WITHHELD) {
        it(`${label}: holdt tilbake (found + withheld + nøytral tekst), ingen finansmarkører`, async () => {
          const r = await run(onC.gateway, "executive", "get_control_center", { center: row.center }, model);
          expect(r.ok, JSON.stringify(r)).toBe(true);
          const t = text(r);
          expect(t).toContain('"withheld":true');
          expect(t).toContain(`"center":"${row.center}"`);
          for (const m of row.finance) expect(t, `lekket: ${m}`).not.toContain(m);
          expect(t).not.toContain('"sections"');
        });
      }
      for (const [label, model] of MODELS_FULL) {
        it(`${label}: hele rapporten (seksjoner og finansmarkører), uten «holdt tilbake»`, async () => {
          const r = await run(onC.gateway, "executive", "get_control_center", { center: row.center }, model);
          expect(r.ok, JSON.stringify(r)).toBe(true);
          const t = text(r);
          expect(t).toContain('"sections"');
          expect(t).not.toContain('"withheld":true');
          for (const m of row.finance.slice(0, 1)) expect(t, `mangler: ${m}`).toContain(m);
        });
      }
      it("FLAGG AV: en skymodell får rapporten som på main (ingen lås, ingen sentral kontekst)", async () => {
        const r = await run(offC.gateway, "executive", "get_control_center", { center: row.center }, CLOUD);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(text(r)).toContain('"sections"');
        expect(text(r)).not.toContain('"withheld":true');
      });
    });
  }

  it("R23 oversikten (get_control_center uten center): skyen får de tre sentrene i `withheld` (ikke bygget, ingen tellinger eller tilstand); lokal modell og eier får alle tre bygget", async () => {
    for (const [label, model] of MODELS_WITHHELD) {
      const r = await run(onC.gateway, "executive", "get_control_center", {}, model);
      const d = r.data as { centers: unknown[]; withheld?: string[] };
      expect(d.centers, label).toEqual([]);
      expect([...(d.withheld ?? [])].sort(), label).toEqual(["ai", "authority", "integration"]);
      for (const m of ["Stripe", "Finans-nødbryter", "77123"]) expect(text(r), `${label}: ${m}`).not.toContain(m);
    }
    for (const [label, model] of MODELS_FULL) {
      const d = (await run(onC.gateway, "executive", "get_control_center", {}, model)).data as { centers: Array<{ center: string }>; withheld?: string[] };
      expect(d.centers.map((c) => c.center).sort(), label).toEqual(["ai", "authority", "integration"]);
      expect(d.withheld, label).toBeUndefined();
    }
    const off = (await run(offC.gateway, "executive", "get_control_center", {}, CLOUD)).data as { centers: unknown[]; withheld?: string[] };
    expect(off.centers.length).toBe(3);
    expect(off.withheld).toBeUndefined();
  });
});

describe("K2: presiseringer", () => {
  it("DAGSBRIEF: for en skymodell rykker de vanlige løkkene opp når finansløkkene er ute (oppfølgingen og saken er begge med), og antall punkter røper ikke at noe er fjernet", async () => {
    const cloud = text(await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "daily" }, CLOUD));
    expect(cloud).toContain(KEEP.followup);
    expect(cloud).toContain(KEEP.ticket);
    const full = text(await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "daily" }, LOCAL));
    expect(full).toContain(FIN.vendor);
  });

  it("UKEBRIEF: antall (opened/resolved/still_open) og by_type bygges på resten for sky - aldri en sum som inkluderer finansløkker; lokal modell og eier får alle (6 åpne, 1 løst finansløkke)", async () => {
    const cloud = (await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "weekly" }, CLOUD)).data as { opened_loops: number; resolved_loops: number; still_open: number; by_type: Record<string, unknown>; rendered: string };
    expect(cloud.still_open).toBe(2);
    expect(cloud.opened_loops).toBe(2);
    expect(cloud.resolved_loops).toBe(0);
    expect(Object.keys(cloud.by_type).sort()).toEqual(["overdue_followup", "support_ticket_overdue"]);
    for (const model of [LOCAL, undefined] as const) {
      const full = (await run(on.gateway, "business", "get_business_brief", { tenant_id: TENANT, period: "weekly" }, model)).data as { opened_loops: number; resolved_loops: number; still_open: number; by_type: Record<string, unknown> };
      expect(full.still_open).toBe(6);
      expect(full.opened_loops).toBe(7);
      expect(full.resolved_loops).toBe(1);
      expect(Object.keys(full.by_type)).toContain("payment_intent_reconciliation_mismatch");
    }
  });

  it("IKKE-FINANS-løkker er uendret for sky: read_open_loop på en vanlig løkke gir hele raden (med external_id), og en ukjent id gir `null` som før - ingen merke på enkeltoppslag av vanlige løkker", async () => {
    const ok = await run(on.gateway, "business", "read_open_loop", { tenant_id: TENANT, open_loop_id: LOOP_IDS.ok1 }, CLOUD);
    expect(ok.ok).toBe(true);
    expect(text(ok)).toContain(KEEP.followup);
    expect(text(ok)).not.toContain("finance_withheld");
    const missing = await run(on.gateway, "business", "read_open_loop", { tenant_id: TENANT, open_loop_id: "finnes-ikke" }, CLOUD);
    expect(missing).toMatchObject({ ok: true, data: null });
  });

  it("enkeltoppslag av en finansløkke gir KUN merket: ingen id, ingen felt (verken i data eller i en ekstern id)", async () => {
    const r = await run(on.gateway, "business", "read_open_loop", { tenant_id: TENANT, open_loop_id: LOOP_IDS.fin1 }, CLOUD);
    expect(r.data).toEqual({ finance_withheld: true, note_no: expect.any(String) });
    expect(text(r)).not.toContain(LOOP_IDS.fin1);
  });

  it("løkketypene i koden er NØYAKTIG de databasen tillater (CHECK-regelen) - en ny DB-type uten klassifisering feller denne testen", async () => {
    const def = (await db.adminPool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'business_open_loops_loop_type_check'")).rows[0].d as string;
    const dbTypes = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string).sort();
    const { FINANCE_DERIVED_LOOP_TYPE } = await import("@jarvis/business");
    expect(Object.keys(FINANCE_DERIVED_LOOP_TYPE).sort()).toEqual(dbTypes);
  });

  it("SAMTIDIGHET: 100 samtidige kall til de ekte transportene med blandede modeller og verktøy - hvert svar følger sin egen modell (ingen kryssing mellom forespørsler)", async () => {
    const calls: Array<[string, string, Record<string, unknown>, string]> = [
      ["business", "list_open_loops", { tenant_id: TENANT }, FIN.vendor],
      ["executive", "get_attention_queue", {}, FIN.amount],
      ["executive", "get_connector_status", {}, "Stripe"],
      ["executive", "get_control_surface_status", {}, FIN.killReason],
      ["business", "get_attention_queue", { tenant_id: TENANT }, FIN.spendCategory]
    ];
    const models: Array<[ModelArg, boolean]> = [[CLOUD, true], [LOCAL, false], [undefined, false], [UNKNOWN_MODEL, true], [BLANK_MODEL, true]];
    const fresh = buildWorld({ pool: db.appPool, guard: true }); // egen gateway: egne rate-teller (30 per minutt per handling), 20 kall per handling her
    const jobs = Array.from({ length: 100 }, (_, i) => ({ call: calls[i % calls.length] as (typeof calls)[number], m: models[(i * 3 + (i >> 1)) % models.length] as (typeof models)[number] }));
    const results = await Promise.all(jobs.map(async (j, i) => {
      await new Promise((r) => setTimeout(r, (i * 7) % 11));
      return run(fresh.gateway, j.call[0], j.call[1], j.call[2], j.m[0]);
    }));
    results.forEach((r, i) => {
      const j = jobs[i] as (typeof jobs)[number];
      expect(r.ok, `${i} ${j.call[1]}`).toBe(true);
      if (j.m[1]) expect(text(r), `${i} ${j.call[1]} skal ikke ha ${j.call[3]}`).not.toContain(j.call[3]);
      else expect(text(r), `${i} ${j.call[1]} skal ha ${j.call[3]}`).toContain(j.call[3]);
    });
    expect(jobs.filter((j) => j.m[1]).length).toBeGreaterThan(30);
    expect(jobs.filter((j) => !j.m[1]).length).toBeGreaterThan(30);
  });
});
