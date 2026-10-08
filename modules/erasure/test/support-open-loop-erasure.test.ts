import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { BusinessService, OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/support-pakkeavhengighet) - samme
// begrunnelse som `ua3-native-support-live.ts` (modules/business/scripts/):
// unngaar en formell pakkeavhengighet @jarvis/erasure -> @jarvis/support kun
// for en testfil, og unngaar enhver risiko for en sirkulær grafendring.
import { SupportService } from "../../support/src/service.ts";

/**
 * UA-3 Native Support Core HOST FIX #1 (D-67, ekte host-funn run_id
 * 60f0d682/5457c59a): Q-20-erasure av en support-ticket krasjet mot
 * `business_open_loops_ticket_id_fkey` naar en support-tilknyttet open-loop
 * (`business_open_loops.ticket_id`, 024_support.sql) fortsatt pekte til
 * ticketen som skulle slettes. Root cause: (a) `jarvis_app` hadde ALDRI faatt
 * `GRANT DELETE` paa `business_open_loops` (fikset i EGEN migrasjon
 * `025_business_open_loops_ticket_grant.sql` - IKKE en redigering av
 * allerede kjørte 020/024, se migrasjonskommentaren); (b) selve erasure-
 * PLANEN (`modules/erasure/src/plan.ts`) slettet ALDRI support-tilknyttede
 * open-loops i det hele tatt. Fikset ved aa slette dem FØRST, SNEVERT
 * avgrenset til `ticket_id IS NOT NULL` (rører ALDRI andre loop_type-er som
 * `overdue_followup`/`stalled_opportunity` - generell business_open_loops-
 * erasure er FORTSATT en separat, udokumentert-utvidet, pre-eksisterende
 * gap, se OPEN_QUESTIONS.md Q-25 punkt 9).
 *
 * Denne suiten (byggeordrens §11 A-I) beviser FIKSEN mot en EKTE embedded
 * Postgres via den EKTE `ErasureService.executeErasure()`-APIen (samme
 * mønster som `erasure-service.test.ts` og `modules/erasure/scripts/
 * q20-erasure-live.ts`) - ALDRI raa ad-hoc DELETE-setninger.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let support: SupportService;
let openLoops: OpenLoopService;
let business: BusinessService;

const TENANT_A = "tenant-sup-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-sup-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sup-erasure-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // §O-mønster (samme som erasure-service.test.ts): garantert non-bypass
  // rolle - ALDRI superbruker. Beviser samtidig at 025-migrasjonens GRANT
  // DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen.
  await adminPool.query("CREATE ROLE jarvis_sup_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Sup Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-sup-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  support = new SupportService(appPool);
  openLoops = new OpenLoopService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("D: schema-drevet FK-audit - business_open_loops er DET ENESTE eksterne avhengighetspunktet mot support_tickets/support_ticket_events", () => {
  it("information_schema viser INGEN andre tabeller med en FK inn mot support_tickets/support_ticket_events enn business_open_loops (og support_ticket_events sin egen selv-referanse)", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table, kcu.column_name AS dependent_column, ccu.table_name AS target_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND ccu.table_name IN ('support_tickets', 'support_ticket_events')
    `);
    // Q-44 (D-435): FK-ene er nå (tenant_id, id)-komposittnøkler, så information_schema gir to rader per FK (én per kolonne) - tell avhengige TABELLER.
    const external = [...new Set(
      (rows as Array<{ dependent_table: string; target_table: string }>)
        .filter((r) => !(r.dependent_table === "support_ticket_events" && r.target_table === "support_tickets"))
        .map((r) => r.dependent_table)
    )];
    expect(external).toEqual(["business_open_loops"]);
  });
});

describe("A/B/C/D: erasure av en support-ticket med en LINKET open-loop lykkes, sletter loopen (ikke bare nuller den), sletter events, ingen FK-brudd", () => {
  it("executeErasure fjerner ticket + events + den support-linkede open-loopen - INGEN FK-feil", async () => {
    const sentinel = `SentinelSupErase${randomUUID().replace(/-/g, "")}`;
    const ticket = await support.createTicket(TENANT_A, "business", { subject: sentinel });
    // Forfalt frist -> detectOverdueSupportTickets oppretter en EKTE linket open-loop.
    await support.setNextResponseDue(TENANT_A, "business", ticket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");

    // Merk: en forfalt, uassignert ticket trigger BÅDE "support_ticket_overdue"
    // OG "support_ticket_unassigned" i samme sveip (§18/§14) - filtrer på den
    // spesifikke typen denne testen faktisk setter opp, ikke bare ticket_id.
    const linkedLoops = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).filter(
      (l: BusinessOpenLoop) => l.ticket_id === ticket.ticket_id
    );
    expect(linkedLoops.length).toBeGreaterThanOrEqual(1);
    const linkedBefore = linkedLoops.find((l) => l.loop_type === "support_ticket_overdue");
    expect(linkedBefore).toBeDefined();
    const linkedOpenLoopId = linkedBefore!.open_loop_id;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-sup-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // §D: INGEN FK-brudd - ville rapportert "failed" ved en regresjon.

    // §B: den LINKEDE open-loop-raden er FAKTISK BORTE (slettet, ikke nullet/orphaned).
    const linkedGone = await adminPool.query("SELECT 1 FROM business_open_loops WHERE open_loop_id = $1", [linkedOpenLoopId]);
    expect(linkedGone.rowCount).toBe(0);
    // Sterkere bevis: INGEN business_open_loops-rad peker til denne ticketen
    // lenger i det hele tatt (verken "overdue" ELLER "unassigned"-loopen).
    const anyLinkedGone = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE ticket_id = $1", [ticket.ticket_id]);
    expect((anyLinkedGone.rows[0] as { n: number }).n).toBe(0);

    // §A: selve ticketen er borte.
    const ticketGone = await support.getTicket(TENANT_A, "business", ticket.ticket_id);
    expect(ticketGone).toBeNull();

    // §C: events er borte.
    const eventsGone = await adminPool.query("SELECT 1 FROM support_ticket_events WHERE ticket_id = $1", [ticket.ticket_id]);
    expect(eventsGone.rowCount).toBe(0);
  });
});

describe("D (utvidet): ingen dinglende FK-referanse noe sted i tenanten etter erasure", () => {
  it("ingen business_open_loops-rad i tenanten peker til en support_tickets-rad som ikke finnes", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM business_open_loops bol
       WHERE bol.tenant_id = $1 AND bol.ticket_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM support_tickets st WHERE st.ticket_id = bol.ticket_id)`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("E: en erasert ticket kan ikke gjenoppstaa - ny ingress paa samme kunde/tenant gir en HELT NY ticket_id", () => {
  it("re-innsending etter erasure oppretter en NY ticket (ticket_created: true), aldri en gjenbruk av den slettede", async () => {
    const sentinel = `SentinelNoResurrect${randomUUID().replace(/-/g, "")}`;
    const ticket = await support.createTicket(TENANT_A, "business", {
      subject: sentinel, source_type: "gmail", source_instance_id: "acct-erase", source_thread_id: `thread-${randomUUID()}`
    });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const erased = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-sup-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(erased.status).toBe("completed");

    // §E: SAMME (tenant, kilde, thread) - hasTicketForThread MAA nå returnere false
    // (den gamle raden er faktisk borte), saa en ny ingest oppretter en FRISK ticket.
    const stillLinked = await support.hasTicketForThread(TENANT_A, "business", "gmail", "acct-erase", `thread-does-not-exist-${randomUUID()}`);
    expect(stillLinked).toBe(false);

    const ingestResult = await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-erase",
      source_thread_id: `thread-new-${randomUUID()}`, source_message_id: `msg-${randomUUID()}`,
      subject: "Ny henvendelse", summary: "Ny kunde-melding etter erasure", is_from_customer: true,
      entity_resolution: "unmatched"
    });
    expect(ingestResult.ticket_created).toBe(true);
    expect(ingestResult.ticket.ticket_id).not.toBe(ticket.ticket_id);
  });
});

describe("F/G: urelaterte open-loops og urelatert business-data er UPAAVIRKET av en support-scoped erasure", () => {
  it("en urelatert (ikke-ticket-tilknyttet) open-loop og en urelatert followup forblir uendret", async () => {
    const sentinel = `SentinelUnrelated${randomUUID().replace(/-/g, "")}`;
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: sentinel, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.followup_id === followup.followup_id
    );
    expect(unrelatedBefore).toBeDefined();
    expect(unrelatedBefore!.ticket_id).toBeNull();

    // Et NYTT ticket-scenario i SAMME sveip, for aa bevise at scopingen (kun
    // ticket_id IS NOT NULL) faktisk diskriminerer mellom de to loop-typene.
    const ticket = await support.createTicket(TENANT_A, "business", { subject: `${sentinel}-ticket` });
    await support.setNextResponseDue(TENANT_A, "business", ticket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-sup-erase-unrelated-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    // §F: den urelaterte (followup-)loopen finnes FORTSATT, uendret.
    const unrelatedAfter = await openLoops.readOpenLoop(TENANT_A, "business", unrelatedBefore!.open_loop_id);
    expect(unrelatedAfter).not.toBeNull();
    expect(unrelatedAfter!.open_loop_id).toBe(unrelatedBefore!.open_loop_id);

    // §G: den urelaterte business_followups-raden er urørt (business_followups
    // er ikke engang registrert i erasure-planen - se plan.ts-kommentaren).
    const followupStillThere = await adminPool.query("SELECT 1 FROM business_followups WHERE followup_id = $1", [followup.followup_id]);
    expect(followupStillThere.rowCount).toBe(1);
  });
});

describe("I: erasure-ledgeren for denne scopen forblir append-only/idempotent (samme kontrakt som eksisterende Q-20-suite)", () => {
  it("samme request_id kjørt to ganger paa et support-scoped erasure er idempotent - ingen dobbel sletting, ingen feil andre gang", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Idempotent sup erasure" });
    await support.setNextResponseDue(TENANT_A, "business", ticket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-sup-erase-idem-${randomUUID()}`;
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
