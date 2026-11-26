import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { firstWaveTools, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import { guardLegacyNotifyTransport, legacyNotifyTarget, optOutHash, recipientHint, type CommsChannel } from "../src/index.ts";
import { OWNER, TENANT_A, TENANT_B } from "./support/harness.ts";
import { startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g5, Q-72 pkt 12): STOP-vakt for de eldre `twilio`/`telnyx`/`whatsapp`/`slack`/`discord`-`notify`-verktøyene (klasse C, vilkårlig mottaker). Den SMALLESTE endringen som gjør en avmeldt mottaker uten rekkevidde der:
 * en transport-dekoratør som slår opp tenant-bred avmelding (samme `optOutHash` som den nye policyen og webhooks) rett før `notify`. Ingen nye tak, ingen journal. Alt mot ekte Postgres og den ekte ToolGateway-kjeden for e2e-delen.
 */
let chain: Chain;
const hashFor = (tenant: string, channel: CommsChannel, recipient: string): string => optOutHash(tenant, channel, recipient);
/** En Discord-snowflake bygget ved kjøring (aldri en bokstavelig ID-lignende streng i kildekoden; samme konvensjon som `policy.test.ts`). */
const snowflake = (digit: string): string => digit.repeat(18);

interface Recorder extends ToolTransport { readonly calls: Array<{ action: string; parameters: Record<string, JsonValue> }> }
const recorder = (): Recorder => {
  const calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  return { calls, async invoke(action, parameters) { calls.push({ action, parameters }); return { external_id: `ext-${calls.length}`, data: { delivered: true } }; } };
};
const ctx = (tenantId: string): ToolInvocationContext => ({ identity: { person_id: OWNER, tenant_id: tenantId, memory_space_id: "business", session_id: "sess-ln", device_id: "dev-ln", channel: "api", auth_strength: "signed" } });
const optOut = (tenant: string, channel: CommsChannel, recipient: string, source: "inbound_stop_keyword" | "owner_recorded" = "owner_recorded") =>
  chain.store.recordOptOut(tenant, "business", { channel, recipient_hash: hashFor(tenant, channel, recipient), recipient_hint: recipientHint(channel, recipient), source, recorded_by: OWNER });

beforeAll(async () => {
  // Marginen 0 = ren sekvensmodell (en START løfter alt med lavere sekvens): denne testen legger inn en STOP og straks en START og forventer at START løfter. Tie-marginen (STOP vinner innenfor 5 s) er bevist i `stop-start-overlap.test.ts`.
  chain = await startChain("g1cln", {}, { lenientToolLimits: true, startTieMarginMs: 0 });
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("legacyNotifyTarget: hvem en `notify` går til (ren funksjon)", () => {
  it("telefon (twilio/telnyx -> sms, whatsapp), Slack (uppercase) og Discord normaliseres til samme form som policyen og webhooks bruker", () => {
    expect(legacyNotifyTarget("twilio", { to: "+4799001122", message: "x" })).toEqual({ channel: "sms", recipient: "+4799001122" });
    expect(legacyNotifyTarget("telnyx", { to: "+47 99 00 11 22", message: "x" })).toEqual({ channel: "sms", recipient: "+4799001122" });
    expect(legacyNotifyTarget("whatsapp", { to: "0047 99 00 11 22", message: "x" })).toEqual({ channel: "whatsapp", recipient: "+4799001122" });
    expect(legacyNotifyTarget("slack", { channel: "c0aaaaaaaa", message: "x" })).toEqual({ channel: "slack", recipient: "C0AAAAAAAA" });
    expect(legacyNotifyTarget("discord", { channel_id: snowflake("1"), message: "x" })).toEqual({ channel: "discord", recipient: snowflake("1") });
  });

  it("alt vakten ikke kan normalisere (kanalnavn, nummer uten landkode, ikke-streng) og alle andre verktøy gir null - transporten validerer selv", () => {
    expect(legacyNotifyTarget("slack", { channel: "#general", message: "x" })).toBeNull();
    expect(legacyNotifyTarget("twilio", { to: "99001122", message: "x" })).toBeNull();
    expect(legacyNotifyTarget("twilio", { to: 4799001122, message: "x" })).toBeNull();
    expect(legacyNotifyTarget("twilio", { message: "x" })).toBeNull();
    expect(legacyNotifyTarget("telegram", { to: "+4799001122" })).toBeNull();
    expect(legacyNotifyTarget("email", { to: "a@b.no" })).toBeNull();
  });
});

describe("guardLegacyNotifyTransport: enhetstester med en falsk lagring", () => {
  const store = (opted: (tenant: string, hash: string) => boolean | Error) => ({
    seen: [] as Array<[string, string]>,
    async isOptedOut(tenant: string, hash: string): Promise<boolean> { this.seen.push([tenant, hash]); const r = opted(tenant, hash); if (r instanceof Error) throw r; return r; }
  });

  it("andre tool_id-er pakkes ikke inn (samme objekt), og andre handlinger enn `notify` rører aldri lagringen", async () => {
    const inner = recorder();
    const s = store(() => true);
    expect(guardLegacyNotifyTransport("telegram", inner, { store: s })).toBe(inner);
    expect(guardLegacyNotifyTransport("email", inner, { store: s })).toBe(inner);
    const guarded = guardLegacyNotifyTransport("twilio", inner, { store: s });
    expect(guarded).not.toBe(inner);
    for (const action of ["get_account_info", "read_messages", "list_channels"]) await guarded.invoke(action, { to: "+4799001122" }, "cred", ctx(TENANT_A));
    expect(s.seen).toEqual([]);
    expect(inner.calls.map((c) => c.action)).toEqual(["get_account_info", "read_messages", "list_channels"]);
  });

  it("avmeldt: kaster PolicyDeniedError (`comms_policy_denied:recipient_opted_out`) UTEN å kalle transporten; nøkkelen er den samme hashen som policyen bruker", async () => {
    const inner = recorder();
    const s = store(() => true);
    const guarded = guardLegacyNotifyTransport("twilio", inner, { store: s });
    await expect(guarded.invoke("notify", { to: "+47 99 00 11 22", message: "hei" }, "cred", ctx(TENANT_A))).rejects.toThrow("comms_policy_denied:recipient_opted_out");
    expect(inner.calls).toEqual([]);
    expect(s.seen).toEqual([[TENANT_A, hashFor(TENANT_A, "sms", "+4799001122")]]);
  });

  it("ikke avmeldt: transporten kalles NØYAKTIG én gang med uendrede argumenter og resultatet returneres uendret", async () => {
    const inner = recorder();
    const guarded = guardLegacyNotifyTransport("whatsapp", inner, { store: store(() => false) });
    const params = { to: "+4799001122", message: "hei" };
    const out = await guarded.invoke("notify", params, "cred", ctx(TENANT_A));
    expect(inner.calls).toEqual([{ action: "notify", parameters: params }]);
    expect(out).toEqual({ external_id: "ext-1", data: { delivered: true } });
  });

  it("uparsbar mottaker slippes videre uten oppslag (ingen avmeldingsrad kan finnes for en uparsbar identifikator)", async () => {
    const inner = recorder();
    const s = store(() => true);
    const guarded = guardLegacyNotifyTransport("slack", inner, { store: s });
    await guarded.invoke("notify", { channel: "#general", message: "hei" }, "cred", ctx(TENANT_A));
    expect(s.seen).toEqual([]);
    expect(inner.calls).toHaveLength(1);
  });

  it("oppslaget feiler: FEILER LUKKET (`opt_out_check_unavailable`), transporten kalles ikke, og loggen har kun en fast kode (ingen mottaker, ingen feiltekst)", async () => {
    const inner = recorder();
    const warnings: Array<Record<string, unknown>> = [];
    const guarded = guardLegacyNotifyTransport("telnyx", inner, { store: store(() => new Error("connection to +4799001122 refused")), warn: (e) => warnings.push(e) });
    await expect(guarded.invoke("notify", { to: "+4799001122", message: "hei" }, "cred", ctx(TENANT_A))).rejects.toThrow("comms_policy_denied:opt_out_check_unavailable");
    expect(inner.calls).toEqual([]);
    expect(warnings).toEqual([{ msg: "comms_legacy_notify_optout_check_failed", tool: "telnyx" }]);
    expect(JSON.stringify(warnings)).not.toContain("4799001122");
  });

  it("webhook-tenanten sjekkes i tillegg til identitetens tenant (en innkommende STOP skrives dit); uten ekstra tenant sees den ikke", async () => {
    const inner = recorder();
    const optedIn = (tenant: string) => tenant === TENANT_B;
    const withExtra = guardLegacyNotifyTransport("twilio", inner, { store: store((t) => optedIn(t)), extraTenants: () => [TENANT_B] });
    await expect(withExtra.invoke("notify", { to: "+4799001122", message: "hei" }, "cred", ctx(TENANT_A))).rejects.toThrow("recipient_opted_out");
    const without = guardLegacyNotifyTransport("twilio", inner, { store: store((t) => optedIn(t)) });
    await without.invoke("notify", { to: "+4799001122", message: "hei" }, "cred", ctx(TENANT_A));
    expect(inner.calls).toHaveLength(1);
    // samme tenant to ganger slås sammen (ett oppslag)
    const s = store(() => false);
    await guardLegacyNotifyTransport("twilio", recorder(), { store: s, extraTenants: () => [TENANT_A] }).invoke("notify", { to: "+4799001122", message: "hei" }, "cred", ctx(TENANT_A));
    expect(s.seen).toHaveLength(1);
  });
});

describe("e2e: de eldre notify-verktøyene gjennom den ekte ToolGateway og den ekte avmeldingsregisteret", () => {
  const sinks = { twilio: recorder(), telnyx: recorder(), whatsapp: recorder(), slack: recorder(), discord: recorder() };
  const NUM = "+4799110011";
  const run = (tool_id: keyof typeof sinks, parameters: Record<string, JsonValue>) => chain.gateway.execute({ identity: chain.owner, tool_id, action: "notify", parameters, idempotency_key: chain.key("ln") });
  const reasonOf = (r: Awaited<ReturnType<typeof run>>): string => JSON.stringify(r);

  beforeAll(() => {
    const guarded = Object.fromEntries((Object.keys(sinks) as Array<keyof typeof sinks>).map((id) => [id, guardLegacyNotifyTransport(id, sinks[id], { store: chain.store })])) as Record<string, ToolTransport>;
    for (const tool of firstWaveTools(guarded)) if (tool.action === "notify" && tool.tool_id in sinks) chain.gateway.register({ ...tool, rate_limit_per_minute: 1_000_000 });
  });

  it("UTEN avmeldingsrad er oppførselen uendret: alle fem verktøyene når transporten med de oppgitte parameterne og resultatet kommer uendret tilbake", async () => {
    const targets: Array<[keyof typeof sinks, Record<string, JsonValue>]> = [
      ["twilio", { to: NUM, message: "hei" }], ["telnyx", { to: NUM, message: "hei" }], ["whatsapp", { to: NUM, message: "hei" }],
      ["slack", { channel: "C0BBBBBBBB", message: "hei" }], ["discord", { channel_id: snowflake("2"), message: "hei" }]
    ];
    for (const [id, parameters] of targets) {
      const r = await run(id, parameters);
      expect(r.ok, `${id}: ${reasonOf(r)}`).toBe(true);
      expect(sinks[id].calls.at(-1), id).toEqual({ action: "notify", parameters });
    }
    expect(chain.gateway.health.get("twilio")?.state).toBe("healthy");
  });

  it("en eierregistrert avmelding (telefon) stopper twilio, telnyx OG whatsapp til samme nummer (navnerommet `tel`); et annet nummer og et annet verktøy er upåvirket; helsen røres ikke", async () => {
    const blockedNum = "+4799220022";
    await optOut(TENANT_A, "sms", blockedNum);
    const before = { twilio: sinks.twilio.calls.length, telnyx: sinks.telnyx.calls.length, whatsapp: sinks.whatsapp.calls.length };
    const health = chain.gateway.health.get("telnyx")?.state;
    for (const id of ["twilio", "telnyx", "whatsapp"] as const) {
      const r = await run(id, { to: blockedNum, message: "hei" });
      expect(r.ok, id).toBe(false);
      expect(reasonOf(r), id).toContain("comms_policy_denied:recipient_opted_out");
    }
    expect({ twilio: sinks.twilio.calls.length, telnyx: sinks.telnyx.calls.length, whatsapp: sinks.whatsapp.calls.length }).toEqual(before);
    expect(chain.gateway.health.get("telnyx")?.state, "policy-avslag er ikke en leverandørfeil (g4)").toBe(health);
    // et annet nummer og et annet verktøy går gjennom
    expect((await run("twilio", { to: "+4799330033", message: "hei" })).ok).toBe(true);
    expect((await run("slack", { channel: "C0CCCCCCCC", message: "hei" })).ok).toBe(true);
  });

  it("mottakerens eget stopp-ord (inbound) stopper den, og en START (lift) åpner den igjen", async () => {
    const num = "+4799440044";
    await optOut(TENANT_A, "sms", num, "inbound_stop_keyword");
    expect((await run("twilio", { to: num, message: "hei" })).ok).toBe(false);
    await chain.store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: hashFor(TENANT_A, "sms", num) });
    expect((await run("twilio", { to: num, message: "hei" })).ok).toBe(true);
  });

  it("Slack og Discord: en avmelding på kanal-id-en stopper `slack.notify` (uavhengig av store/små bokstaver) og `discord.notify`", async () => {
    await optOut(TENANT_A, "slack", "C0DDDDDDDD");
    await optOut(TENANT_A, "discord", snowflake("3"));
    const slack = await run("slack", { channel: "c0dddddddd", message: "hei" });
    expect(slack.ok).toBe(false);
    expect(reasonOf(slack)).toContain("recipient_opted_out");
    const discord = await run("discord", { channel_id: snowflake("3"), message: "hei" });
    expect(discord.ok).toBe(false);
    expect(reasonOf(discord)).toContain("recipient_opted_out");
    expect((await run("discord", { channel_id: snowflake("4"), message: "hei" })).ok).toBe(true);
  });
});
