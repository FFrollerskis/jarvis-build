import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { PolicyDeniedError, isPolicyDenied } from "@jarvis/tool-gateway";
import { CommsTransport, OutboundFunnel, ProviderRejectedError, createContentHasher, parseSendParams, type ParsedOutbound } from "../src/index.ts";
import { TENANT_A, TEST_PEPPER } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g4), comms-siden: Jarvis' EGNE avslag kastet fra trakten/transporten er `PolicyDeniedError` (samme melding som før), så de aldri teller mot connector-helse. Beviser (a) typen på hvert kastested i `funnel.execute`
 * og `CommsTransport` mot ekte Postgres. Selve helse-effekten gjennom ToolGateway er bevist i `modules/tool-gateway/test/wpg1c-policy-denied-health.test.ts` (paritet for alt annet) og i `legacy-notify-guard.test.ts` (e2e).
 */
let chain: Chain;
const SMS = "+4791000000";
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const sendRaw = (recipient: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ request_id: chain.key("req"), channel: "sms", account_ref: SMS, recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS, ...over });
const parsed = (raw: Record<string, unknown>): ParsedOutbound => {
  const r = parseSendParams(raw);
  if (!r.ok) throw new Error(`parse: ${r.code}`);
  return r.value;
};
const exec = (p: ParsedOutbound) => chain.funnel.execute(chain.ctx, p, "fake-token-for-test");
const message = async (p: Promise<unknown>): Promise<{ type: boolean; message: string }> => {
  const err = await p.then(() => null, (e: unknown) => e);
  return { type: isPolicyDenied(err), message: (err as Error).message };
};

beforeAll(async () => {
  chain = await startChain("g1cpd", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" }, { lenientToolLimits: true });
  await authorizeAll(chain, [["sms", SMS, "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("funnel.execute: Jarvis' egne avslag er PolicyDeniedError (samme melding som før)", () => {
  it("policy-avslag (avmeldt mottaker) -> `comms_policy_denied:recipient_opted_out`", async () => {
    const n = chain.phone();
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: n })).ok).toBe(true);
    expect(await message(exec(parsed(sendRaw(n))))).toEqual({ type: true, message: "comms_policy_denied:recipient_opted_out" });
  });

  it("taket nådd i `beginAttempt` (20 samtidige sendinger til samme kalde mottaker; policyens tørrkjøring slipper alle gjennom, taket treffer i den atomiske tellingen) -> ALLE avslag er `PolicyDeniedError` med `comms_policy_denied:<takkode>`", async () => {
    const n = chain.phone();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => exec(parsed(sendRaw(n)))));
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as Error);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const err of rejected) {
      expect(isPolicyDenied(err), err.message).toBe(true);
      expect(err.message).toMatch(/^comms_policy_denied:.*rate_limit_cold_recipient_day/);
    }
  });

  it("gjenspilling av en feilet id -> `comms_request_id_burned_use_a_new_key`, og samme id med en annen forespørsel -> `idempotency_key_collision`", async () => {
    const n = chain.phone();
    const p = parsed(sendRaw(n));
    // leverandøren avviser entydig: raden blir `failed`, og id-en er brent
    const adapter = chain.twilio as unknown as { send: unknown };
    const original = adapter.send;
    adapter.send = async () => { throw new ProviderRejectedError("twilio", "21211"); };
    try { await exec(p).catch(() => undefined); } finally { adapter.send = original; }
    expect(((await chain.db.admin.query("SELECT status FROM comms_outbound_log WHERE tenant_id = $1 AND request_id = $2", [TENANT_A, p.request_id])).rows[0] as { status: string }).status).toBe("failed");
    expect(await message(exec(p))).toEqual({ type: true, message: "comms_request_id_burned_use_a_new_key" });
    // samme id med en ANNEN forespørsel er en kollisjon (aldri `dedup`)
    expect(await message(exec(parsed({ ...sendRaw(n), request_id: p.request_id, text: "En helt annen tekst" })))).toEqual({ type: true, message: "idempotency_key_collision" });
  });

  it("manglende pepper på en gjenspilling -> `comms_policy_denied:content_hash_key_unavailable`", async () => {
    const n = chain.phone();
    const p = parsed(sendRaw(n));
    await exec(p);
    let pepper: string | null = TEST_PEPPER;
    const noPepper = new OutboundFunnel({ store: chain.store, graph: chain.graph, adapters: { twilio: chain.twilio }, config: chain.config, clock: chain.now, contentHasher: async () => createContentHasher(pepper) });
    pepper = null;
    expect(await message(noPepper.execute(chain.ctx, p, "fake-token-for-test"))).toEqual({ type: true, message: "comms_policy_denied:content_hash_key_unavailable" });
  });
});

describe("CommsTransport: Jarvis' egne avslag er PolicyDeniedError", () => {
  it("en lesing mot en IKKE-autorisert konto -> `comms_account_not_authorized` (teksten inneholder «auth» og ble tidligere klassifisert `auth_failed` i connector-helse), og et rom utenfor de tillatte -> `comms_space_not_allowed`", async () => {
    const transport = new CommsTransport({ funnel: chain.funnel, store: chain.store });
    const params: Record<string, JsonValue> = { channel: "slack", account_ref: "T0ZZZZZZZZ", channel_id: "C0AAAAAAAA", thread_ts: "1731850000.000100" };
    expect(await message(transport.invoke("read_thread", params, "cred", { identity: chain.owner }))).toEqual({ type: true, message: "comms_account_not_authorized" });
    expect(await message(transport.invoke("list_accounts", {}, "cred", { identity: { ...chain.owner, memory_space_id: "health" } }))).toEqual({ type: true, message: "comms_space_not_allowed" });
    // andre feil er IKKE policy-avslag (ingen omklassifisering): manglende kontekst er en vanlig feil
    expect(await message(transport.invoke("list_accounts", {}, "cred", {} as never))).toMatchObject({ type: false, message: "comms_missing_invocation_context" });
  });

  it("PolicyDeniedError er en vanlig Error for alle som fanger (instanceof Error, name og melding)", () => {
    const e = new PolicyDeniedError("comms_policy_denied:x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PolicyDeniedError");
    expect(isPolicyDenied(e)).toBe(true);
  });
});
