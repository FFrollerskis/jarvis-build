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
import { FakeTransport, ToolGateway, firstWaveTools, type ClassDNotification, type ClassDNotifier, type ToolResult, type ToolTransport } from "@jarvis/tool-gateway";
import { BusinessService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";
import { SupportTransport } from "../src/transport.ts";
import { replyEventSourceMessageId, replySendIdempotencyKey } from "../src/email-ingress.ts";

/**
 * Re-review LOW 6 (FINNES PÅ main, ikke WP-K): `SupportEmailService.reply()` kalte det nøstede `email.send` (klasse D) UTEN `idempotency_key`. Med produksjonsinnstillingen `classDPipeline.enforce: true`
 * (main.ts:408, worker-main.ts:205) nekter gatewayen da hver ekte `support.reply` med `class_d_idempotency_key_required`, og INGEN e-post sendes. Eksisterende tester brukte enten en fake gateway eller
 * `enforce: false`, så feilen var usynlig. Her: ekte `ToolGateway` med HÅNDHEVET klasse D-pipeline (og varsler), ekte `PolicyGateway` (eier), ekte `SupportService`/`SupportTransport`, embedded Postgres som
 * app-rolle; kun selve e-postleveransen er en fake-transport som teller.
 */
const TENANT = "tenant-support-low6";
const EMAIL_REF = "JARVIS_EMAIL_TOKEN";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-support-low6", device_id: "dev-support-low6", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async (ref: string): Promise<string | null> => (ref === EMAIL_REF ? "fake-token-for-test" : null) };

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-low6-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_support_low6_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_support_low6_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Support LOW 6','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-support-low6-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_support_low6_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

/** Simulerer et krasj ETTER at e-posten er sendt men FØR svaret er registrert som ticket-hendelse (en retry må da ikke sende på nytt). */
class FlakySupport extends SupportService {
  failNextIngest = false;
  override async ingestMessage(...args: Parameters<SupportService["ingestMessage"]>): ReturnType<SupportService["ingestMessage"]> {
    if (this.failNextIngest) { this.failNextIngest = false; throw new Error("simulated_crash_after_send"); }
    return super.ingestMessage(...args);
  }
}

function build(email: ToolTransport = new FakeTransport()): {
  gateway: ToolGateway; support: FlakySupport; email: ToolTransport; notices: ClassDNotification[]
} {
  const notices: ClassDNotification[] = [];
  const notifier: ClassDNotifier = { ready: () => true, notify: async (n) => { notices.push(n); } };
  const support = new FlakySupport(appPool);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  // HÅNDHEVET klasse D-pipeline, slik produksjon kjører den (main.ts/worker-main.ts).
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier } });
  const supportTransport = new SupportTransport(support, new BusinessService(appPool), gateway);
  for (const tool of firstWaveTools({ support: supportTransport, email })) gateway.register(tool);
  return { gateway, support, email, notices };
}

/** Teller faktiske leveranser (kall til `email.send` i transporten). */
function countingEmail(behaviour: (call: number) => { external_id?: string; data?: JsonValue }): { transport: ToolTransport; sends: () => number } {
  let sends = 0;
  return { transport: { invoke: async (action: string) => { if (action !== "send") return {}; sends += 1; return behaviour(sends); } }, sends: () => sends };
}

async function reply(gateway: ToolGateway, ticketId: string, key: string, outerKey?: string): Promise<ToolResult> {
  return gateway.execute({
    identity, tool_id: "support", action: "reply",
    parameters: { tenant_id: TENANT, memory_space: "business", ticket_id: ticketId, to: "kunde@example.no", subject: "Re: LOW 6", body: "Svar", idempotency_key: key },
    ...(outerKey !== undefined ? { idempotency_key: outerKey } : {})
  });
}

/** En ticket fra en innkommende kunde-e-post (tråd-forankret): svaret registreres da på DENNE ticketen (som i produksjon via Gmail-ingress). */
let threadSeq = 0;
async function newTicket(support: SupportService): Promise<string> {
  threadSeq += 1;
  const result = await support.ingestMessage(TENANT, "business", {
    channel: "email", source_type: "gmail", source_instance_id: "acct-low6", source_thread_id: `thread-low6-${threadSeq}`, source_message_id: `msg-low6-${threadSeq}`,
    subject: `LOW 6 sak ${threadSeq}`, summary: "Kunde skriver", is_from_customer: true, entity_resolution: "unmatched"
  });
  return result.ticket.ticket_id;
}

const agentReplies = async (support: SupportService, ticketId: string): Promise<number> =>
  (await support.listEvents(TENANT, "business", ticketId)).filter((e) => e.event_type === "agent_reply").length;
const sendLedger = async (ticketId: string, key: string): Promise<Array<{ status: string; postcondition_reason: string | null }>> =>
  (await adminPool.query(
    "SELECT status, postcondition_reason FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'email' AND action = 'send' AND idempotency_key = $2", [TENANT, replySendIdempotencyKey(ticketId, key)]
  )).rows as Array<{ status: string; postcondition_reason: string | null }>;

describe("nøkkelen for det nøstede email.send er deterministisk, aldri tilfeldig, og kolliderer ikke med det ytre kallets nøkkel", () => {
  it("samme (ticket, nøkkel) gir alltid samme nøkkel; ulik ticket eller ulik nøkkel gir en annen; den er aldri lik kallerens rå nøkkel (eget navnerom)", () => {
    const key = replySendIdempotencyKey("sup-tk-1", "reply-1");
    expect(replySendIdempotencyKey("sup-tk-1", "reply-1")).toBe(key);
    expect(replySendIdempotencyKey("sup-tk-2", "reply-1")).not.toBe(key);
    expect(replySendIdempotencyKey("sup-tk-1", "reply-2")).not.toBe(key);
    expect(key).not.toBe("reply-1");
    expect(key.startsWith("support-reply:")).toBe(true);
  });
});

describe("support.reply med HÅNDHEVET klasse D-pipeline (produksjonsinnstillingen)", () => {
  it("sender nøyaktig ÉN e-post (ikke class_d_idempotency_key_required): ledger-raden for email.send er `succeeded` under den avledede nøkkelen, ÉN agent_reply, eieren varslet én gang", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-msg-1" }));
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    const result = await reply(t.gateway, ticketId, "reply-low6-a");
    expect(result).toMatchObject({ ok: true });
    expect(email.sends()).toBe(1);
    expect(await sendLedger(ticketId, "reply-low6-a")).toEqual([{ status: "succeeded", postcondition_reason: null }]);
    expect(await agentReplies(t.support, ticketId)).toBe(1);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ tool_id: "email", action: "send", outcome: "executed", idempotency_key: replySendIdempotencyKey(ticketId, "reply-low6-a") });
  }, 60_000);

  it("et IDENTISK gjentatt svar (samme idempotency_key) sender ikke en gang til, og gir samme vellykkede resultat", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-msg-2" }));
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    const first = await reply(t.gateway, ticketId, "reply-low6-b");
    const again = await reply(t.gateway, ticketId, "reply-low6-b");
    expect(first).toMatchObject({ ok: true });
    expect(again).toMatchObject({ ok: true });
    expect(email.sends()).toBe(1);
    expect(await agentReplies(t.support, ticketId)).toBe(1);
  }, 60_000);

  it("det ytre kallets egen idempotency_key kan være LIK parameteren `idempotency_key` uten at det nøstede sendekallet kolliderer med den ytre ledger-raden (reservert) - e-posten sendes likevel én gang", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-msg-3" }));
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    const result = await reply(t.gateway, ticketId, "same-key-everywhere", "same-key-everywhere");
    expect(result).toMatchObject({ ok: true });
    expect(email.sends()).toBe(1);
    expect(await agentReplies(t.support, ticketId)).toBe(1);
  }, 60_000);

  it("krasj ETTER sending men FØR svaret er registrert: en retry sender IKKE på nytt (ledgeren for email.send er `succeeded` -> deduplicert) og registrerer svaret", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-msg-4" }));
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    t.support.failNextIngest = true;
    const crashed = await reply(t.gateway, ticketId, "reply-low6-crash");
    expect(crashed).toMatchObject({ ok: false });
    expect(email.sends()).toBe(1); // e-posten GIKK ut
    expect(await agentReplies(t.support, ticketId)).toBe(0); // men ingen hendelse ble lagret
    const retried = await reply(t.gateway, ticketId, "reply-low6-crash");
    expect(retried).toMatchObject({ ok: true });
    expect(email.sends()).toBe(1); // IKKE sendt en gang til
    expect(await agentReplies(t.support, ticketId)).toBe(1);
    expect(await sendLedger(ticketId, "reply-low6-crash")).toEqual([{ status: "succeeded", postcondition_reason: null }]);
  }, 60_000);

  it("avvist av leverandøren (ingen bivirkning): samme nøkkel kan prøves på nytt og lykkes (D-396 uendret) - to forsøk i transporten, én levert e-post", async () => {
    const email = countingEmail((call) => { if (call === 1) throw new Error("provider_outage"); return { external_id: "gmail-msg-5" }; });
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    const failed = await reply(t.gateway, ticketId, "reply-low6-retry");
    expect(failed).toMatchObject({ ok: false });
    expect(await agentReplies(t.support, ticketId)).toBe(0);
    expect((await sendLedger(ticketId, "reply-low6-retry"))[0]?.status).toBe("failed");
    const retried = await reply(t.gateway, ticketId, "reply-low6-retry");
    expect(retried).toMatchObject({ ok: true });
    expect(email.sends()).toBe(2);
    expect(await agentReplies(t.support, ticketId)).toBe(1);
    expect((await sendLedger(ticketId, "reply-low6-retry"))[0]?.status).toBe("succeeded");
  }, 60_000);

  it("UKJENT utfall (leverandøren kan ha sendt): en retry med samme nøkkel sender ALDRI på nytt, og eieren er varslet om det ukjente utfallet", async () => {
    const email = countingEmail(() => { throw new Error("outcome_unknown:test_transport_lost_response"); });
    const t = build(email.transport);
    const ticketId = await newTicket(t.support);
    const first = await reply(t.gateway, ticketId, "reply-low6-unknown");
    const retried = await reply(t.gateway, ticketId, "reply-low6-unknown");
    expect(first).toMatchObject({ ok: false });
    expect(retried).toMatchObject({ ok: false });
    expect(email.sends()).toBe(1);
    expect((await sendLedger(ticketId, "reply-low6-unknown"))[0]?.status).toBe("unverified");
    expect(t.notices.filter((n) => n.outcome === "unknown")).toHaveLength(1);
    expect(await agentReplies(t.support, ticketId)).toBe(0); // aldri registrert som sendt
  }, 60_000);
});

describe("delta-review L-4: hendelsesnøkkelen for et sendt svar er scopet på ticket (samme kallernøkkel på to tickets = to svar, ikke en stille drop)", () => {
  it("nøkkelen er deterministisk, har ticket-id i seg og skiller to tickets med samme kallernøkkel", () => {
    expect(replyEventSourceMessageId("sup-tk-1", "k")).toBe("reply:sup-tk-1:k");
    expect(replyEventSourceMessageId("sup-tk-1", "k")).toBe(replyEventSourceMessageId("sup-tk-1", "k"));
    expect(replyEventSourceMessageId("sup-tk-2", "k")).not.toBe(replyEventSourceMessageId("sup-tk-1", "k"));
  });

  it("SAMME kallernøkkel på TO ulike tickets (samme kildetype/instans) sender to e-poster og gir ETT agent_reply per ticket; et identisk gjentatt svar på hver ticket sender IKKE på nytt", async () => {
    const email = countingEmail(() => ({ external_id: "gmail-msg-l4" }));
    const t = build(email.transport);
    const ticketA = await newTicket(t.support);
    const ticketB = await newTicket(t.support);
    expect(ticketB).not.toBe(ticketA);
    const first = await reply(t.gateway, ticketA, "reply-l4-shared");
    const second = await reply(t.gateway, ticketB, "reply-l4-shared"); // samme kallernøkkel, annen ticket: FØR fiksen `ok: true` med 0 sendinger
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(email.sends()).toBe(2);
    expect(await agentReplies(t.support, ticketA)).toBe(1);
    expect(await agentReplies(t.support, ticketB)).toBe(1);
    expect(await sendLedger(ticketA, "reply-l4-shared")).toEqual([{ status: "succeeded", postcondition_reason: null }]);
    expect(await sendLedger(ticketB, "reply-l4-shared")).toEqual([{ status: "succeeded", postcondition_reason: null }]);
    // Identiske retries på HVER ticket: fortsatt ingen ny sending og ingen nye hendelser.
    expect(await reply(t.gateway, ticketA, "reply-l4-shared")).toMatchObject({ ok: true });
    expect(await reply(t.gateway, ticketB, "reply-l4-shared")).toMatchObject({ ok: true });
    expect(email.sends()).toBe(2);
    expect(await agentReplies(t.support, ticketA)).toBe(1);
    expect(await agentReplies(t.support, ticketB)).toBe(1);
  }, 90_000);
});
