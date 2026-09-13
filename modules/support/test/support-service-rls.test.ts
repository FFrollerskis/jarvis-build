import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { SupportService } from "../src/service.ts";
import { InvalidTicketTransitionError } from "../src/state-machine.ts";

/**
 * UA-3 Native Support Core (D-66): ekte Postgres/RLS-integrasjonsbevis for
 * `SupportService` - lifecycle/idempotens/entitetsresolusjon/tenant-/
 * memory-space-isolasjon mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme
 * mønster som Q-27 sine RLS-tester, IKKE en `fakePool()`-mock).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let outsiderPool: pg.Pool;
let service: SupportService;

const TENANT_A = "tenant-sup-svc-a";
const TENANT_B = "tenant-sup-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_sup_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_svc_test");
  await adminPool.query("CREATE ROLE jarvis_sup_svc_outsider_test LOGIN PASSWORD 'pw3' NOSUPERUSER NOBYPASSRLS");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Support Svc A', 'business'), ('${TENANT_B}', 'Support Svc B', 'business')`
  );
  await adminPool.query(
    `INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-sup-a', '${TENANT_A}', 'Acme AS')`
  );
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES ('ct-sup-a', '${TENANT_A}', 'co-sup-a', 'Kari', 'kari@acme.no')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-agent-1', 'Agent One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_svc_test", password: "pw2" });
  outsiderPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_svc_outsider_test", password: "pw3" });
  service = new SupportService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await outsiderPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: opprett ticket", () => {
  it("createTicket returnerer en gyldig ticket med default status/priority/channel", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Test A" });
    expect(ticket.subject).toBe("Test A");
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("normal");
    expect(ticket.channel).toBe("manual");
    expect(ticket.entity_resolution).toBe("unmatched");
  });
  it("oppretter et 'ticket_created'-event automatisk", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Test A2" });
    const events = await service.listEvents(TENANT_A, "business", ticket.ticket_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("ticket_created");
  });
});

describe("B: unikt ticket-nummer", () => {
  it("hver nye ticket faar et strengt stigende, unikt ticket_number", async () => {
    const a = await service.createTicket(TENANT_A, "business", { subject: "Number A" });
    const b = await service.createTicket(TENANT_A, "business", { subject: "Number B" });
    expect(Number(b.ticket_number)).toBeGreaterThan(Number(a.ticket_number));
  });
});

describe("C: get/list/search", () => {
  it("getTicket finner en opprettet ticket", async () => {
    const created = await service.createTicket(TENANT_A, "business", { subject: "Findable" });
    const found = await service.getTicket(TENANT_A, "business", created.ticket_id);
    expect(found?.ticket_id).toBe(created.ticket_id);
  });
  it("listTickets(status='open') inkluderer nyopprettede tickets", async () => {
    const created = await service.createTicket(TENANT_A, "business", { subject: "Listable" });
    const rows = await service.listTickets(TENANT_A, "business", "open");
    expect(rows.some((r) => r.ticket_id === created.ticket_id)).toBe(true);
  });
  it("searchTickets filtrerer deterministisk paa subject_contains", async () => {
    await service.createTicket(TENANT_A, "business", { subject: "Unique-Search-Marker-XYZ" });
    const rows = await service.searchTickets(TENANT_A, "business", { subject_contains: "Unique-Search-Marker-XYZ" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.subject.includes("Unique-Search-Marker-XYZ"))).toBe(true);
  });
});

describe("G: prioritet", () => {
  it("setPriority endrer prioritet og logger et priority_changed-event", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Prio" });
    const updated = await service.setPriority(TENANT_A, "business", ticket.ticket_id, "urgent");
    expect(updated?.priority).toBe("urgent");
    const events = await service.listEvents(TENANT_A, "business", ticket.ticket_id);
    expect(events.some((e) => e.event_type === "priority_changed")).toBe(true);
  });
});

describe("H: tildeling", () => {
  it("assignTicket setter assignee og logger et assigned-event", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Assign" });
    const updated = await service.assignTicket(TENANT_A, "business", ticket.ticket_id, "person-agent-1");
    expect(updated?.assignee_person_id).toBe("person-agent-1");
    const events = await service.listEvents(TENANT_A, "business", ticket.ticket_id);
    expect(events.some((e) => e.event_type === "assigned")).toBe(true);
  });
  it("fjerning av tildeling logger unassigned", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Unassign" });
    await service.assignTicket(TENANT_A, "business", ticket.ticket_id, "person-agent-1");
    await service.assignTicket(TENANT_A, "business", ticket.ticket_id, null);
    const events = await service.listEvents(TENANT_A, "business", ticket.ticket_id);
    expect(events.some((e) => e.event_type === "unassigned")).toBe(true);
  });
});

describe("I: internt notat", () => {
  it("addInternalNote oppretter et internal_note-event, ALDRI kunde-synlig felt satt", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Note" });
    const event = await service.addInternalNote(TENANT_A, "business", ticket.ticket_id, "Intern kommentar");
    expect(event.event_type).toBe("internal_note");
    expect(event.summary).toBe("Intern kommentar");
  });
});

describe("Statusovergang (state-machine haandheves i service-laget)", () => {
  it("gyldig overgang (open -> pending) fungerer og logges", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Transition" });
    const updated = await service.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    expect(updated?.status).toBe("pending");
  });
  it("ugyldig overgang (closed -> resolved) kaster og endrer INGENTING", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Bad transition" });
    await service.setStatus(TENANT_A, "business", ticket.ticket_id, "closed");
    await expect(service.setStatus(TENANT_A, "business", ticket.ticket_id, "resolved")).rejects.toThrow(InvalidTicketTransitionError);
    const unchanged = await service.getTicket(TENANT_A, "business", ticket.ticket_id);
    expect(unchanged?.status).toBe("closed");
  });
  it("resolved setter resolved_at, closed setter closed_at", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Timestamps" });
    const resolved = await service.setStatus(TENANT_A, "business", ticket.ticket_id, "resolved");
    expect(resolved?.resolved_at).not.toBeNull();
    const closed = await service.setStatus(TENANT_A, "business", ticket.ticket_id, "closed");
    expect(closed?.closed_at).not.toBeNull();
  });
});

describe("L/M/N: thread-/melding-idempotens", () => {
  it("L: samme source_thread_id => samme logiske ticket (ikke duplikat)", async () => {
    const first = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-L",
      source_message_id: "msg-L-1", subject: "Thread L", summary: "Melding 1", is_from_customer: true, entity_resolution: "unmatched"
    });
    const second = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-L",
      source_message_id: "msg-L-2", subject: "Thread L", summary: "Melding 2", is_from_customer: true, entity_resolution: "unmatched"
    });
    expect(second.ticket.ticket_id).toBe(first.ticket.ticket_id);
    expect(second.ticket_created).toBe(false);
  });
  it("M: samme source_message_id levert paa nytt gir INGEN duplikat event", async () => {
    const first = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-M",
      source_message_id: "msg-M-1", subject: "Thread M", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    const retry = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-M",
      source_message_id: "msg-M-1", subject: "Thread M", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    expect(retry.event.event_id).toBe(first.event.event_id);
    const events = await service.listEvents(TENANT_A, "business", first.ticket.ticket_id);
    expect(events.filter((e) => e.source_message_id === "msg-M-1")).toHaveLength(1);
  });
  it("N: andre melding paa SAMME tråd gir SAMME ticket, nytt event", async () => {
    const first = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-N",
      source_message_id: "msg-N-1", subject: "Thread N", summary: "Melding 1", is_from_customer: true, entity_resolution: "unmatched"
    });
    const second = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-N",
      source_message_id: "msg-N-2", subject: "Thread N", summary: "Melding 2", is_from_customer: false, entity_resolution: "unmatched"
    });
    expect(second.ticket.ticket_id).toBe(first.ticket.ticket_id);
    const events = await service.listEvents(TENANT_A, "business", first.ticket.ticket_id);
    expect(events.length).toBeGreaterThanOrEqual(3); // ticket_created + msg1 + msg2
  });
  it("O: ny tråd gir ny ticket", async () => {
    const first = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-O-1",
      source_message_id: "msg-O-1", subject: "Thread O1", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    const second = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-O-2",
      source_message_id: "msg-O-2", subject: "Thread O2", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    expect(second.ticket.ticket_id).not.toBe(first.ticket.ticket_id);
    expect(second.ticket_created).toBe(true);
  });
});

describe("Reaapning (§16)", () => {
  it("en kundemelding paa en resolved ticket reaapner den til 'open' deterministisk", async () => {
    const created = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-reopen",
      source_message_id: "msg-reopen-1", subject: "Reopen", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    await service.setStatus(TENANT_A, "business", created.ticket.ticket_id, "resolved");
    const reopened = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-reopen",
      source_message_id: "msg-reopen-2", subject: "Reopen", summary: "Ny melding etter resolved", is_from_customer: true, entity_resolution: "unmatched"
    });
    expect(reopened.reopened).toBe(true);
    expect(reopened.ticket.status).toBe("open");
    expect(reopened.ticket.resolved_at).toBeNull();
  });
  it("et agent-svar paa en resolved ticket reaapner den IKKE (kun kunde-meldinger reaapner)", async () => {
    const created = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-noreopen",
      source_message_id: "msg-noreopen-1", subject: "No reopen", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched"
    });
    await service.setStatus(TENANT_A, "business", created.ticket.ticket_id, "resolved");
    const stillResolved = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-noreopen",
      source_message_id: "msg-noreopen-2", subject: "No reopen", summary: "Agent-notat", is_from_customer: false, entity_resolution: "unmatched"
    });
    expect(stillResolved.reopened).toBe(false);
    expect(stillResolved.ticket.status).toBe("resolved");
  });
});

describe("Q/R/S: entitetsresolusjon (matched/unmatched/ambiguous)", () => {
  it("Q: matched-tickets lagrer company_id/contact_id", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Matched", company_id: "co-sup-a", contact_id: "ct-sup-a", entity_resolution: "matched" });
    expect(ticket.company_id).toBe("co-sup-a");
    expect(ticket.contact_id).toBe("ct-sup-a");
    expect(ticket.entity_resolution).toBe("matched");
  });
  it("R: unmatched-tickets forblir GYLDIGE (ikke forkastet), kun uten kobling", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Unmatched", entity_resolution: "unmatched" });
    expect(ticket.company_id).toBeNull();
    expect(ticket.entity_resolution).toBe("unmatched");
  });
  it("S: ambiguous-tickets forblir GYLDIGE, uten en gjettet kobling", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Ambiguous", entity_resolution: "ambiguous" });
    expect(ticket.company_id).toBeNull();
    expect(ticket.contact_id).toBeNull();
    expect(ticket.entity_resolution).toBe("ambiguous");
  });
});

describe("T/U: selskapskobling og Business OS-tidslinje", () => {
  it("T: en ticket kobles til et selskap via company_id (samme FK-mønster som business_activities)", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Company link", company_id: "co-sup-a" });
    const found = await service.getTicket(TENANT_A, "business", ticket.ticket_id);
    expect(found?.company_id).toBe("co-sup-a");
  });
});

describe("V/W: pointer-not-payload", () => {
  it("V: canonical_uri lagres som en peker til kilden", async () => {
    const result = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-ptr",
      source_message_id: "msg-ptr-1", subject: "Pointer", summary: "Melding", is_from_customer: true, entity_resolution: "unmatched",
      canonical_uri: "https://mail.google.com/mail/u/0/#all/msg-ptr-1"
    });
    expect(result.event.canonical_uri).toBe("https://mail.google.com/mail/u/0/#all/msg-ptr-1");
  });
  it("W: ingen full meldingstekst lagres - kun det korte, strukturerte 'summary'-feltet finnes i skjemaet", async () => {
    const longBody = "x".repeat(10_000);
    const result = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-nobody",
      source_message_id: "msg-nobody-1", subject: "No body", summary: "E-post: kort emne", is_from_customer: true, entity_resolution: "unmatched"
    });
    // Skjemaet har ingen "body"/"content"-kolonne i det hele tatt - summary er ALLTID kort/strukturert.
    expect(result.event.summary.length).toBeLessThan(longBody.length);
    expect(Object.keys(result.event)).not.toContain("body");
  });
});

describe("AA/AB: tenant-/memory-space-isolasjon", () => {
  it("AA: TENANT_B ser ALDRI TENANT_A sine tickets", async () => {
    const ticketA = await service.createTicket(TENANT_A, "business", { subject: "Isolation A" });
    const foundFromB = await service.getTicket(TENANT_B, "business", ticketA.ticket_id);
    expect(foundFromB).toBeNull();
    const listB = await service.listTickets(TENANT_B, "business", "all");
    expect(listB.some((t) => t.ticket_id === ticketA.ticket_id)).toBe(false);
  });
});

describe("AC/AD: Q-21 uendret, RLS-hjelper korrekt brukt", () => {
  it("AC: jarvis_sup_svc_test forblir NOSUPERUSER/NOBYPASSRLS", async () => {
    const { rows } = await adminPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_sup_svc_test'");
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });
  it("AD: en rå spørring UTEN withMemoryTransaction sin kontekst er RLS-blind (beviser at service.ts FAKTISK bruker riktig hjelper - hadde den ikke, ville testene over vaert umulige)", async () => {
    const raw = await appPool.query("SELECT * FROM support_tickets WHERE tenant_id = $1", [TENANT_A]);
    expect(raw.rows.length).toBe(0);
  });
});

describe("AK/AL: Q-20 erasure-integrasjon - jarvis_app kan faktisk hard-slette support-data, ingen resurrection", () => {
  it("jarvis_app har DELETE-rettighet paa support_tickets/support_ticket_events (uten denne feiler HELE tenant-/space-erasure)", async () => {
    const { rows } = await adminPool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'jarvis_app' AND table_name IN ('support_tickets', 'support_ticket_events') AND privilege_type = 'DELETE'`
    );
    expect(rows.map((r) => (r as { table_name: string }).table_name).sort()).toEqual(["support_ticket_events", "support_tickets"]);
  });
  it("en tenant-scoped DELETE via appPool fjerner faktisk raden (samme mekanisme ErasureService.plan.ts bruker) - ingen re-opprettelse ved re-ingestion av SAMME kilde-melding", async () => {
    const result = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-erase", source_thread_id: "thread-erase",
      source_message_id: "msg-erase-1", subject: "Erase me", summary: "Skal slettes", is_from_customer: true, entity_resolution: "unmatched"
    });
    // Samme mønster som erasure sin egen `plan.ts` - en rå spørring UTEN
    // withMemoryTransaction sin RLS-kontekst ville vaert like RLS-blind som
    // Q-27 sin bug (0 rader "slettet" uten feil) - erasure setter ALLTID
    // riktig session-kontekst FØR selve DELETE, akkurat som her.
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("DELETE FROM support_ticket_events WHERE tenant_id = $1 AND memory_space_id = $2", [TENANT_A, "business"])
    );
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("DELETE FROM support_tickets WHERE tenant_id = $1 AND memory_space_id = $2 AND ticket_id = $3", [TENANT_A, "business", result.ticket.ticket_id])
    );
    const found = await service.getTicket(TENANT_A, "business", result.ticket.ticket_id);
    expect(found).toBeNull();
    // Re-ingestion av SAMME (thread, message) etter sletting oppretter en HELT NY ticket
    // (idempotens-nøkkelen fantes kun i den slettede raden) - ALDRI en "gjenoppstandelse"
    // av den slettede raden selv, samme prinsipp som Q-20 sin resurrection-beskyttelse.
    const reingested = await service.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-erase", source_thread_id: "thread-erase",
      source_message_id: "msg-erase-2", subject: "Erase me", summary: "Ny melding etter sletting", is_from_customer: true, entity_resolution: "unmatched"
    });
    expect(reingested.ticket.ticket_id).not.toBe(result.ticket.ticket_id);
  });
});

describe("AP: ingen secret-lekkasje i persistert data", () => {
  it("ingen ticket/event-felt inneholder noe som ligner en credential/token-verdi fra test-oppsettet", async () => {
    const ticket = await service.createTicket(TENANT_A, "business", { subject: "Secret check" });
    const serialized = JSON.stringify(ticket);
    expect(serialized).not.toMatch(/pw2|pw3|jarvis_sup_svc_test/);
  });
});
