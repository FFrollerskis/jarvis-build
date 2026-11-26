import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type ClassDNotification, type ClassDNotifier, type ToolTransport } from "@jarvis/tool-gateway";
import { BusinessService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";
import { SupportTransport } from "../src/transport.ts";
import { SupportEmailService } from "../src/email-ingress.ts";
import type { IngestMessageInput } from "../src/types.ts";

/**
 * WP-P3 K3 (JARVIS-104, Q-63 pkt 8): `SupportEmailService.reply()` på et MANUELT ticket (`source_type:"native"`, ingen kildeinstans/-tråd) opprettet tidligere et NYTT «skygge-ticket» (oppslaget på
 * (kilde, instans, tråd) traff ikke), og svar-hendelsen og returverdiene havnet der - mot doc-kommentaren («ÉN hendelse på DENNE ticketen»). Nå bærer `reply()` det interne feltet `ticket_id`, og
 * `ingestMessage` leser da raden på (tenant_id, ticket_id) under RLS/rom, kaster `support_ticket_not_found` hvis den mangler og OPPRETTER ALDRI. Feltet leses aldri fra verktøyets `parameters`.
 * Ekte `ToolGateway` med HÅNDHEVET klasse D-pipeline, ekte `PolicyGateway`, ekte `SupportService`/`SupportTransport`, embedded Postgres som app-rolle; kun e-postleveransen er en teller (som low6-testen).
 */
const TENANT = "tenant-p3-104";
const OTHER = "tenant-p3-104-other";
const ACCOUNT = "konto-p3-104@example.test";
const EMAIL_REF = "JARVIS_EMAIL_TOKEN";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-p3-104", device_id: "dev-p3-104", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async (ref: string): Promise<string | null> => (ref === EMAIL_REF ? "fake-token-for-test" : null) };

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-p3-104-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_support_p3_104 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_support_p3_104");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Support P3 104','business'), ('${OTHER}','Support P3 104 annen','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-p3-104-business','${TENANT}','business'), ('ms-p3-104-project','${TENANT}','project'), ('ms-p3-104-other','${OTHER}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_support_p3_104", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

/** Simulerer et krasj ETTER at e-posten er sendt men FØR svaret er registrert (samme mønster som low6). */
class FlakySupport extends SupportService {
  failNextIngest = false;
  override async ingestMessage(...args: Parameters<SupportService["ingestMessage"]>): ReturnType<SupportService["ingestMessage"]> {
    if (this.failNextIngest) { this.failNextIngest = false; throw new Error("simulated_crash_after_send"); }
    return super.ingestMessage(...args);
  }
}

function countingEmail(behaviour: (call: number) => { external_id?: string; data?: JsonValue }): { transport: ToolTransport; sends: () => number } {
  let sends = 0;
  return { transport: { invoke: async (action: string) => { if (action !== "send") return {}; sends += 1; return behaviour(sends); } }, sends: () => sends };
}

function build(email: ToolTransport = new FakeTransport()) {
  const notices: ClassDNotification[] = [];
  const notifier: ClassDNotifier = { ready: () => true, notify: async (n) => { notices.push(n); } };
  const support = new FlakySupport(appPool);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier } });
  const transport = new SupportTransport(support, new BusinessService(appPool), gateway);
  for (const tool of firstWaveTools({ support: transport, email })) gateway.register(tool);
  const emailService = new SupportEmailService(gateway, new BusinessService(appPool), support, ACCOUNT, []);
  return { gateway, support, transport, emailService, notices };
}
type Built = ReturnType<typeof build>;

const replyInput = (key: string) => ({ to: "kunde@example.test", subject: "Re: P3 104", body: "Svar", idempotency_key: key });
const manualTicket = (support: SupportService, subject = "Manuelt P3 104") => support.createTicket(TENANT, "business", { subject });
const countTickets = async (tenant = TENANT): Promise<number> => (await adminPool.query("SELECT count(*)::int AS n FROM support_tickets WHERE tenant_id = $1", [tenant])).rows[0].n as number;
const countEvents = async (tenant: string, ticketId: string): Promise<number> => (await adminPool.query("SELECT count(*)::int AS n FROM support_ticket_events WHERE tenant_id = $1 AND ticket_id = $2", [tenant, ticketId])).rows[0].n as number;
const typesOf = async (t: Built, ticketId: string): Promise<string[]> => (await t.support.listEvents(TENANT, "business", ticketId)).map((e) => e.event_type);
const only = (types: string[], type: string): number => types.filter((x) => x === type).length;

let threadSeq = 0;
/** Et tråd-forankret ticket (som fra Gmail-ingress). */
async function threadTicket(support: SupportService, instance = "acct-p3-104"): Promise<{ ticketId: string; thread: string }> {
  threadSeq += 1;
  const thread = `thread-p3-104-${threadSeq}`;
  const result = await support.ingestMessage(TENANT, "business", {
    channel: "email", source_type: "gmail", source_instance_id: instance, source_thread_id: thread, source_message_id: `msg-p3-104-${threadSeq}`,
    subject: `P3 104 tråd ${threadSeq}`, summary: "Kunde skriver", is_from_customer: true, entity_resolution: "unmatched"
  });
  return { ticketId: result.ticket.ticket_id, thread };
}

describe("K3: reply() på et MANUELT ticket havner på DENNE ticketen (aldri et nytt skygge-ticket)", () => {
  it("antall tickets er uendret; result.ticket og result.event er originalen; originalen har nøyaktig ÉN agent_reply", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-1" }));
    const t = build(email.transport);
    const manual = await manualTicket(t.support);
    expect(manual).toMatchObject({ source_type: "native", source_instance_id: null, source_thread_id: null, channel: "manual" });
    const before = await countTickets();
    const result = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-a"));
    expect(result.sent).toBe(true);
    expect(email.sends()).toBe(1);
    expect(await countTickets()).toBe(before); // FØR fiksen: +1 (et «skygge-ticket» med source_thread_id = originalens id)
    expect(result.ticket?.ticket_id).toBe(manual.ticket_id);
    expect(result.event.ticket_id).toBe(manual.ticket_id);
    expect(result.event.event_type).toBe("agent_reply");
    const types = await typesOf(t, manual.ticket_id);
    expect(only(types, "agent_reply")).toBe(1);
    expect(only(types, "ticket_created")).toBe(1);
    // ingen ticket peker på originalen som sin tråd (skygge-tickets bruker ticket-id som tråd)
    expect((await adminPool.query("SELECT count(*)::int AS n FROM support_tickets WHERE tenant_id = $1 AND source_thread_id = $2", [TENANT, manual.ticket_id])).rows[0].n).toBe(0);
  }, 60_000);

  it("retry med samme nøkkel sender IKKE på nytt, gir samme hendelse, og lager verken ticket eller hendelse", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-2" }));
    const t = build(email.transport);
    const manual = await manualTicket(t.support);
    const first = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-b"));
    const before = await countTickets();
    const eventsBefore = await countEvents(TENANT, manual.ticket_id);
    const again = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-b"));
    expect(again).toMatchObject({ sent: true });
    expect(again.event.event_id).toBe(first.event.event_id);
    expect(again.ticket?.ticket_id).toBe(manual.ticket_id);
    expect(email.sends()).toBe(1);
    expect(await countTickets()).toBe(before);
    expect(await countEvents(TENANT, manual.ticket_id)).toBe(eventsBefore);
    expect(only(await typesOf(t, manual.ticket_id), "agent_reply")).toBe(1);
  }, 60_000);

  it("mislykket sending gir ÉN internal_note på originalen (ikke agent_reply, ikke nytt ticket), og en retry med samme nøkkel sender og registrerer agent_reply på originalen", async () => {
    const email = countingEmail((call) => { if (call === 1) throw new Error("provider_outage"); return { external_id: "gmail-p3-3" }; });
    const t = build(email.transport);
    const manual = await manualTicket(t.support);
    const before = await countTickets();
    const failed = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-c"));
    expect(failed.sent).toBe(false);
    expect(failed.ticket?.ticket_id).toBe(manual.ticket_id);
    expect(failed.event).toMatchObject({ ticket_id: manual.ticket_id, event_type: "internal_note" });
    expect(await countTickets()).toBe(before);
    let types = await typesOf(t, manual.ticket_id);
    expect(only(types, "internal_note")).toBe(1);
    expect(only(types, "agent_reply")).toBe(0);
    const retried = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-c"));
    expect(retried.sent).toBe(true);
    expect(retried.event).toMatchObject({ ticket_id: manual.ticket_id, event_type: "agent_reply" });
    expect(email.sends()).toBe(2);
    expect(await countTickets()).toBe(before);
    types = await typesOf(t, manual.ticket_id);
    expect(only(types, "agent_reply")).toBe(1);
    expect(only(types, "internal_note")).toBe(1); // bevisene for det mislykkede forsøket bevares
  }, 60_000);

  it("krasj ETTER sending men FØR registrering: retry sender ikke på nytt (ledger) og registrerer svaret på originalen", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-4" }));
    const t = build(email.transport);
    const manual = await manualTicket(t.support);
    const before = await countTickets();
    t.support.failNextIngest = true;
    await expect(t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-crash"))).rejects.toThrow("simulated_crash_after_send");
    expect(email.sends()).toBe(1);
    expect(only(await typesOf(t, manual.ticket_id), "agent_reply")).toBe(0);
    const retried = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-crash"));
    expect(retried).toMatchObject({ sent: true });
    expect(retried.event.ticket_id).toBe(manual.ticket_id);
    expect(email.sends()).toBe(1);
    expect(await countTickets()).toBe(before);
    expect(only(await typesOf(t, manual.ticket_id), "agent_reply")).toBe(1);
  }, 60_000);

  it("L-4: SAMME kallernøkkel på to MANUELLE tickets sender begge, ÉN agent_reply per ticket, og ingen skygge-tickets", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-5" }));
    const t = build(email.transport);
    const a = await manualTicket(t.support, "Manuelt A");
    const b = await manualTicket(t.support, "Manuelt B");
    const before = await countTickets();
    const first = await t.emailService.reply(TENANT, "business", identity, a.ticket_id, replyInput("p3-k3-shared"));
    const second = await t.emailService.reply(TENANT, "business", identity, b.ticket_id, replyInput("p3-k3-shared"));
    expect(first.sent && second.sent).toBe(true);
    expect(email.sends()).toBe(2);
    expect(first.event.ticket_id).toBe(a.ticket_id);
    expect(second.event.ticket_id).toBe(b.ticket_id);
    expect(first.event.event_id).not.toBe(second.event.event_id);
    expect(await countTickets()).toBe(before);
    expect(only(await typesOf(t, a.ticket_id), "agent_reply")).toBe(1);
    expect(only(await typesOf(t, b.ticket_id), "agent_reply")).toBe(1);
    // identiske retries sender ikke på nytt
    await t.emailService.reply(TENANT, "business", identity, a.ticket_id, replyInput("p3-k3-shared"));
    await t.emailService.reply(TENANT, "business", identity, b.ticket_id, replyInput("p3-k3-shared"));
    expect(email.sends()).toBe(2);
  }, 90_000);

  it("hele ruten (`support.reply` gjennom ToolGateway med håndhevet klasse D): svaret havner på det manuelle ticketet, ett ticket mindre enn før fiksen, eieren varslet én gang", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-6" }));
    const t = build(email.transport);
    const manual = await manualTicket(t.support);
    const before = await countTickets();
    const result = await t.gateway.execute({
      identity, tool_id: "support", action: "reply",
      parameters: { tenant_id: TENANT, memory_space: "business", ticket_id: manual.ticket_id, ...replyInput("p3-k3-gw") }
    });
    expect(result).toMatchObject({ ok: true });
    const data = (result as { ok: true; data?: { ticket?: { ticket_id?: string }; event?: { ticket_id?: string; event_type?: string } } }).data;
    expect(data?.ticket?.ticket_id).toBe(manual.ticket_id);
    expect(data?.event).toMatchObject({ ticket_id: manual.ticket_id, event_type: "agent_reply" });
    expect(email.sends()).toBe(1);
    expect(await countTickets()).toBe(before);
    expect(only(await typesOf(t, manual.ticket_id), "agent_reply")).toBe(1);
    expect(t.notices.filter((n) => n.tool_id === "email" && n.outcome === "executed")).toHaveLength(1);
  }, 60_000);

  it("tråd-forankret ticket er uendret: svaret registreres på samme ticket (ingen nytt ticket), og kildeinstansen til hendelsen er ticketens egen", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-7" }));
    const t = build(email.transport);
    const { ticketId } = await threadTicket(t.support);
    const before = await countTickets();
    const result = await t.emailService.reply(TENANT, "business", identity, ticketId, replyInput("p3-k3-thread"));
    expect(result.sent).toBe(true);
    expect(result.event).toMatchObject({ ticket_id: ticketId, event_type: "agent_reply", source_type: "gmail", source_instance_id: "acct-p3-104" });
    expect(await countTickets()).toBe(before);
    expect(only(await typesOf(t, ticketId), "agent_reply")).toBe(1);
  }, 60_000);

  it("hendelsens dedupe-nøkkel for et MANUELT ticket er uendret: kildeinstans = kontoens e-post, source_message_id = reply:<ticket>:<nøkkel>", async () => {
    const t = build(countingEmail(() => ({ external_id: "gmail-p3-8" })).transport);
    const manual = await manualTicket(t.support);
    const result = await t.emailService.reply(TENANT, "business", identity, manual.ticket_id, replyInput("p3-k3-key"));
    expect(result.event).toMatchObject({ source_type: "native", source_instance_id: ACCOUNT, source_message_id: `reply:${manual.ticket_id}:p3-k3-key` });
  }, 60_000);
});

describe("K3: ingestMessage med internt `ticket_id` leser raden (tenant, id) under RLS/rom og OPPRETTER ALDRI", () => {
  const input = (extra: Partial<IngestMessageInput> = {}): IngestMessageInput => ({
    channel: "manual", source_type: "native", source_instance_id: ACCOUNT, source_thread_id: "ignorert-trad", source_message_id: `msg-p3-ing-${Math.random().toString(36).slice(2, 10)}`,
    subject: "P3 ingest", summary: "Notat", is_from_customer: false, entity_resolution: "unmatched", ...extra
  });

  it("finnes ikke -> `support_ticket_not_found`, INGEN ny ticket og ingen hendelse (opprettes aldri)", async () => {
    const support = new SupportService(appPool);
    const before = await countTickets();
    await expect(support.ingestMessage(TENANT, "business", input({ ticket_id: "sup-tk-finnes-ikke" }))).rejects.toThrow("support_ticket_not_found");
    expect(await countTickets()).toBe(before);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM support_ticket_events WHERE tenant_id = $1 AND source_instance_id = $2 AND summary = 'Notat'", [TENANT, ACCOUNT])).rows[0].n).toBe(0);
  }, 60_000);

  it("en TOM `ticket_id` er et oppslag som ikke finnes (ikke «uten ticket_id»): `support_ticket_not_found`, ingen ny ticket og ingen hendelse - heller ikke når (kilde, instans, tråd) peker på et eksisterende ticket", async () => {
    const support = new SupportService(appPool);
    const { ticketId, thread } = await threadTicket(support);
    const before = await countTickets();
    const events = await countEvents(TENANT, ticketId);
    // tråden finnes: uten id-vakten ville meldingen blitt festet til det tråd-forankrede ticketet
    await expect(support.ingestMessage(TENANT, "business", input({ ticket_id: "", source_type: "gmail", source_instance_id: "acct-p3-104", source_thread_id: thread }))).rejects.toThrow("support_ticket_not_found");
    // tråden finnes ikke: uten id-vakten ville det blitt opprettet et nytt (skygge-)ticket
    await expect(support.ingestMessage(TENANT, "business", input({ ticket_id: "", source_thread_id: "trad-finnes-ikke-p3" }))).rejects.toThrow("support_ticket_not_found");
    expect(await countTickets()).toBe(before);
    expect(await countEvents(TENANT, ticketId)).toBe(events);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM support_ticket_events WHERE tenant_id = $1 AND source_instance_id = $2 AND summary = 'Notat'", [TENANT, ACCOUNT])).rows[0].n).toBe(0);
  }, 60_000);

  it("`reply()` med tom ticket-id: `support_ticket_not_found` FØR noe sendes (ingen sending, ingen nye tickets)", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-p3-tom-id" }));
    const t = build(email.transport);
    const before = await countTickets();
    await expect(t.emailService.reply(TENANT, "business", identity, "", replyInput("p3-tom-id"))).rejects.toThrow("support_ticket_not_found");
    expect(email.sends()).toBe(0);
    expect(await countTickets()).toBe(before);
  }, 60_000);

  it("annen tenant og annet rom: `support_ticket_not_found` uten hendelse (RLS + eksplisitt tenant-filter)", async () => {
    const support = new SupportService(appPool);
    const manual = await manualTicket(support);
    const events = await countEvents(TENANT, manual.ticket_id);
    const ticketsOther = await countTickets(OTHER);
    await expect(support.ingestMessage(OTHER, "business", input({ ticket_id: manual.ticket_id }))).rejects.toThrow("support_ticket_not_found");
    await expect(support.ingestMessage(TENANT, "project", input({ ticket_id: manual.ticket_id }))).rejects.toThrow("support_ticket_not_found");
    expect(await countEvents(TENANT, manual.ticket_id)).toBe(events);
    expect(await countEvents(OTHER, manual.ticket_id)).toBe(0);
    expect(await countTickets(OTHER)).toBe(ticketsOther);
  }, 60_000);

  it("tenant-filteret er EKSPLISITT, ikke bare RLS: en tjeneste uten RLS (admin-pool) finner heller ikke en annen tenants ticket", async () => {
    const support = new SupportService(appPool);
    const manual = await manualTicket(support);
    const noRls = new SupportService(adminPool); // superbruker omgår RLS: kun `WHERE tenant_id = $1` beskytter nå
    await expect(noRls.ingestMessage(OTHER, "business", input({ ticket_id: manual.ticket_id }))).rejects.toThrow("support_ticket_not_found");
    expect(await countEvents(OTHER, manual.ticket_id)).toBe(0);
    expect(await countEvents(TENANT, manual.ticket_id)).toBe(1); // kun `ticket_created`
  }, 60_000);

  it("`ticket_id` går foran tråd-oppslaget: hendelsen havner på den navngitte ticketen selv om (kilde, instans, tråd) peker på en ANNEN ticket", async () => {
    const support = new SupportService(appPool);
    const a = await threadTicket(support);
    const b = await threadTicket(support);
    const before = await countTickets();
    const eventsA = await countEvents(TENANT, a.ticketId);
    const eventsB = await countEvents(TENANT, b.ticketId);
    const result = await support.ingestMessage(TENANT, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-p3-104", source_thread_id: b.thread, source_message_id: "msg-p3-prec", subject: "Prioritet", summary: "Til A",
      is_from_customer: false, entity_resolution: "unmatched", ticket_id: a.ticketId
    });
    expect(result.ticket.ticket_id).toBe(a.ticketId);
    expect(result.event.ticket_id).toBe(a.ticketId);
    expect(result).toMatchObject({ ticket_created: false, event_created: true });
    expect(await countTickets()).toBe(before);
    expect(await countEvents(TENANT, a.ticketId)).toBe(eventsA + 1);
    expect(await countEvents(TENANT, b.ticketId)).toBe(eventsB); // tråd-oppslaget (B) brukes ikke når `ticket_id` er satt
  }, 60_000);

  it("uten `ticket_id` er atferden uendret: samme tråd -> samme ticket, ny tråd -> NYTT ticket (ingress)", async () => {
    const support = new SupportService(appPool);
    const { ticketId, thread } = await threadTicket(support);
    const again = await support.ingestMessage(TENANT, "business", input({ channel: "email", source_type: "gmail", source_instance_id: "acct-p3-104", source_thread_id: thread, is_from_customer: true }));
    expect(again).toMatchObject({ ticket_created: false });
    expect(again.ticket.ticket_id).toBe(ticketId);
    const fresh = await support.ingestMessage(TENANT, "business", input({ channel: "email", source_type: "gmail", source_instance_id: "acct-p3-104", source_thread_id: `${thread}-ny`, is_from_customer: true }));
    expect(fresh.ticket_created).toBe(true);
    expect(fresh.ticket.ticket_id).not.toBe(ticketId);
  }, 60_000);
});

describe("K3: `ticket_id` leses ALDRI fra verktøyets `parameters` (modellflaten)", () => {
  const params = (ticketId: string, thread: string): Record<string, JsonValue> => ({
    tenant_id: TENANT, memory_space: "business", channel: "email", source_type: "gmail", source_instance_id: "acct-p3-104", source_thread_id: thread, source_message_id: `msg-p3-param-${thread}`,
    subject: "P3 parameter", summary: "Forsøk på å flytte meldingen", is_from_customer: false, ticket_id: ticketId
  });

  it("transporten `support.ingest_message` ignorerer `parameters.ticket_id`: meldingen følger tråden (nytt ticket), det manuelle ticketet får ingen hendelse", async () => {
    const t = build();
    const manual = await manualTicket(t.support);
    const eventsBefore = await countEvents(TENANT, manual.ticket_id);
    const result = await t.transport.invoke("ingest_message", params(manual.ticket_id, "thread-p3-param-1"), "", { identity });
    const data = result.data as { ticket: { ticket_id: string }; event: { ticket_id: string }; ticket_created: boolean };
    expect(data.ticket.ticket_id).not.toBe(manual.ticket_id);
    expect(data.event.ticket_id).toBe(data.ticket.ticket_id);
    expect(data.ticket_created).toBe(true);
    expect(await countEvents(TENANT, manual.ticket_id)).toBe(eventsBefore);
  }, 60_000);

  it("gjennom ToolGateway nektes også et ekstra `ticket_id` av det strenge skjemaet, og det manuelle ticketet får ingen hendelse", async () => {
    const t = build();
    const manual = await manualTicket(t.support);
    const eventsBefore = await countEvents(TENANT, manual.ticket_id);
    const before = await countTickets();
    const result = await t.gateway.execute({ identity, tool_id: "support", action: "ingest_message", parameters: params(manual.ticket_id, "thread-p3-param-2") });
    expect(result.ok).toBe(false);
    expect(await countEvents(TENANT, manual.ticket_id)).toBe(eventsBefore);
    expect(await countTickets()).toBe(before);
  }, 60_000);
});
