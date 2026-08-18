import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { BusinessService, OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/agreements
// pakkeavhengighet kun for en testfil) - samme presedens som
// support-open-loop-erasure.test.ts sin import av SupportService.
import { AgreementsService } from "../../agreements/src/service.ts";

/**
 * UA-3 Native Jarvis Contracts Core (D-71) Q-20/Q-27: erasure av en kontrakt
 * med en LINKET open-loop (`business_open_loops.contract_id`,
 * 026_contracts.sql) - SAMME lærdom/presedens som HOST FIX #1 (D-67) for
 * `ticket_id`, allerede løst FØRST i selve `plan.ts` denne gangen (ingen
 * separat host-runde nødvendig for dette). Beviser FK-ordren
 * (contract_events/contract_obligations/contract_versions FØR contracts,
 * business_open_loops FØR contracts) mot en EKTE embedded Postgres via den
 * EKTE `ErasureService.executeErasure()`-APIen.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let agreements: AgreementsService;
let openLoops: OpenLoopService;
let business: BusinessService;

const TENANT_A = "tenant-agr-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-agr-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-agr-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // Garantert non-bypass rolle - beviser samtidig at 026-migrasjonens
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen.
  await adminPool.query("CREATE ROLE jarvis_agr_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_agr_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Agr Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-agr-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_agr_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  agreements = new AgreementsService(appPool);
  openLoops = new OpenLoopService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: schema-drevet FK-audit - business_open_loops er DET ENESTE eksterne avhengighetspunktet mot contracts", () => {
  it("information_schema viser INGEN andre tabeller med en FK inn mot contracts enn business_open_loops (og contract_events/contract_obligations/contract_versions sine egne)", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table, ccu.table_name AS target_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'contracts'
    `);
    const known = new Set(["business_open_loops", "contract_events", "contract_obligations", "contract_versions"]);
    const unexpected = (rows as Array<{ dependent_table: string }>).filter((r) => !known.has(r.dependent_table));
    expect(unexpected).toHaveLength(0);
    expect((rows as Array<{ dependent_table: string }>).some((r) => r.dependent_table === "business_open_loops")).toBe(true);
  });
});

describe("B/C/D/E: erasure av en kontrakt med versjon/forpliktelse/LINKET open-loop lykkes, ingen FK-brudd", () => {
  it("executeErasure fjerner kontrakt + versjoner + forpliktelser + events + den kontrakt-linkede open-loopen", async () => {
    const sentinel = `SentinelAgrErase${randomUUID().replace(/-/g, "")}`;
    const contract = await agreements.createContract(TENANT_A, "business", { title: sentinel });
    await agreements.addVersion(TENANT_A, "business", contract.contract_id, { summary: "V1" });
    const obligation = await agreements.addObligation(TENANT_A, "business", contract.contract_id, { description: "Forpliktelse" });
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "approved");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "active");
    await agreements.setTerminationDeadline(TENANT_A, "business", contract.contract_id, new Date(Date.now() + 3 * 86_400_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");

    const linkedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.contract_id === contract.contract_id
    );
    expect(linkedBefore).toBeDefined();
    const linkedOpenLoopId = linkedBefore!.open_loop_id;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-agr-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon.

    // §D: den linkede open-loop-raden er FAKTISK BORTE.
    const linkedGone = await adminPool.query("SELECT 1 FROM business_open_loops WHERE open_loop_id = $1", [linkedOpenLoopId]);
    expect(linkedGone.rowCount).toBe(0);
    const anyLinkedGone = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE contract_id = $1", [contract.contract_id]);
    expect((anyLinkedGone.rows[0] as { n: number }).n).toBe(0);

    // §B: selve kontrakten er borte.
    const contractGone = await agreements.getContract(TENANT_A, "business", contract.contract_id);
    expect(contractGone).toBeNull();

    // §C: versjoner/forpliktelser/events er borte.
    const versionsGone = await adminPool.query("SELECT 1 FROM contract_versions WHERE contract_id = $1", [contract.contract_id]);
    expect(versionsGone.rowCount).toBe(0);
    const obligationsGone = await adminPool.query("SELECT 1 FROM contract_obligations WHERE obligation_id = $1", [obligation.obligation_id]);
    expect(obligationsGone.rowCount).toBe(0);
    const eventsGone = await adminPool.query("SELECT 1 FROM contract_events WHERE contract_id = $1", [contract.contract_id]);
    expect(eventsGone.rowCount).toBe(0);
  });
});

describe("D (utvidet): ingen dinglende FK-referanse noe sted i tenanten etter erasure", () => {
  it("ingen business_open_loops-rad i tenanten peker til en contracts-rad som ikke finnes", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM business_open_loops bol
       WHERE bol.tenant_id = $1 AND bol.contract_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.contract_id = bol.contract_id)`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("E: en erasert kontrakt kan ikke gjenoppstaa - en ny kontrakt faar en HELT NY contract_id", () => {
  it("en ny kontrakt opprettet etter erasure faar en ny id, aldri en gjenbruk av den slettede", async () => {
    const sentinel = `SentinelNoResurrectAgr${randomUUID().replace(/-/g, "")}`;
    const contract = await agreements.createContract(TENANT_A, "business", { title: sentinel });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const erased = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-agr-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(erased.status).toBe("completed");

    const gone = await agreements.getContract(TENANT_A, "business", contract.contract_id);
    expect(gone).toBeNull();

    const fresh = await agreements.createContract(TENANT_A, "business", { title: sentinel });
    expect(fresh.contract_id).not.toBe(contract.contract_id);
    const freshEvents = await agreements.listEvents(TENANT_A, "business", fresh.contract_id);
    expect(freshEvents).toHaveLength(1); // KUN "contract_created" - ingen historikk overlevde fra den slettede kontrakten.
  });
});

describe("F/G: urelaterte open-loops og urelatert business-data er UPAAVIRKET av en contract-scoped erasure", () => {
  it("en urelatert (ikke-kontrakt-tilknyttet) open-loop og en urelatert followup forblir uendret", async () => {
    const sentinel = `SentinelUnrelatedAgr${randomUUID().replace(/-/g, "")}`;
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: sentinel, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.followup_id === followup.followup_id
    );
    expect(unrelatedBefore).toBeDefined();
    expect(unrelatedBefore!.contract_id).toBeNull();

    const contract = await agreements.createContract(TENANT_A, "business", {
      title: `${sentinel}-contract`, renewal_date: new Date(Date.now() + 5 * 86_400_000).toISOString()
    });
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "approved");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "active");
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-agr-erase-unrelated-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    // §F: den urelaterte (followup-)loopen finnes FORTSATT, uendret.
    const unrelatedAfter = await openLoops.readOpenLoop(TENANT_A, "business", unrelatedBefore!.open_loop_id);
    expect(unrelatedAfter).not.toBeNull();

    // §G: den urelaterte business_followups-raden er urørt.
    const followupStillThere = await adminPool.query("SELECT 1 FROM business_followups WHERE followup_id = $1", [followup.followup_id]);
    expect(followupStillThere.rowCount).toBe(1);
  });
});

describe("H: idempotens - samme request_id kjørt to ganger paa et contract-scoped erasure gir samme resultat", () => {
  it("andre kjøring er en idempotent replay, ingen dobbel sletting, ingen feil", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Idempotent agr erasure" });
    await agreements.addObligation(TENANT_A, "business", contract.contract_id, { description: "X", due_at: new Date(Date.now() - 3_600_000).toISOString() });
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-agr-erase-idem-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});
