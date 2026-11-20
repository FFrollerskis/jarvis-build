import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  BrowserGatewayTransport, CloudflareTransport, DockerTransport, GceTransport, GithubTransport, GmailTransport, HomeAssistantTransport, McpZapierTransport,
  PostgresOpsTransport, SlackTransport, TelegramTransport, ToolGateway, currentCallSignal, parsePostgresOpsConfig, resetGoogleAccessTokenCache,
  type PgOpsClient, type ToolDefinition, type ToolInvocationContext, type ToolResult, type ToolTransport, type SecretProvider
} from "../src/index.ts";
import { FakeCloudflare } from "./support/fake-cloudflare.ts";

/**
 * WP-K (D-471, JARVIS-018) - GATEWAY-NIVÅ, per transportfamilie, mot ekte embedded Postgres (ledger) og ekte transportklasser:
 *   1. et tidsavbrudd AVBRYTER den pågående forespørselen (signalet på `fetch`/prosessen/tilkoblingen er `aborted`, ikke bare løftet avvist),
 *   2. en ikke-idempotent POST sendes ALDRI på nytt etter tidsavbruddet - verken av en retry-løkke (429-backoff), en poll-løkke eller en replay med samme nøkkel,
 *   3. raden står som `unverified` (utfall ukjent) og en replay utfører ingenting.
 * Leverandørene med fast vertsnavn (Google, GitHub, Slack, Telegram, Zapier) kjøres mot en stubbet global `fetch` som HENGER til signalet avbrytes (samme som en ekte hengende socket);
 * de med konfigurerbar base-URL (Home Assistant, Cloudflare) kjøres mot en EKTE lokal HTTP-server der avbruddet sees som en lukket socket. Primitivene: `wpk-call-signal.test.ts`.
 */
const TENANT = "tenant-wpk18";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "personal",
  session_id: "sess-wpk18", device_id: "jarvis-voice-live", channel: "voice", auth_strength: "active"
};

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk18-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpk18 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpk18");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','WPK18','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias') ON CONFLICT DO NOTHING;
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_wpk18", password: "pw2", max: 10 });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------------------------- harness

interface FetchCall { url: string; method: string; signal: AbortSignal | undefined }
const calls: FetchCall[] = [];
type Reply = Response | "hang";

/** Stubber global `fetch`. `"hang"` = svar kommer aldri; forespørselen avvises KUN når signalet avbrytes (uten signal henger den for alltid - den gamle feilen). */
function stubFetch(reply: (call: FetchCall) => Reply | Promise<Reply>): void {
  calls.length = 0;
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
    const call: FetchCall = { url: String(input), method: (init.method ?? "GET").toUpperCase(), signal: init.signal ?? undefined };
    calls.push(call);
    return Promise.resolve(reply(call)).then((r) => {
      if (r !== "hang") return r;
      return new Promise<Response>((_, reject) => {
        const s = init.signal;
        if (!s) return;
        if (s.aborted) { reject(s.reason); return; }
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    });
  });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const isToken = (call: FetchCall): boolean => call.url.startsWith("https://oauth2.googleapis.com/token");
const tokenReply = (): Response => json({ access_token: "fake-access-token-for-test", expires_in: 3600 });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function def(partial: Pick<ToolDefinition, "tool_id" | "action" | "transport"> & Partial<ToolDefinition>): ToolDefinition {
  return {
    description: "wpk-018 test", input_schema: z.record(z.string(), z.any()) as unknown as ToolDefinition["input_schema"], capability_class: "C", scopes: ["test"],
    reversible: false, rollback_procedure: "manuell kontroll", idempotent_external: false, timeout_ms: 150, rate_limit_per_minute: 1000,
    credential_ref: "WPK_TEST_CREDENTIAL", output_trust: "untrusted", ...partial
  };
}

function gatewayWith(defs: ToolDefinition[], secrets: Record<string, string> = {}): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const provider: SecretProvider = { name: "test", async get(ref) { return secrets[ref] ?? "fake-credential-for-test"; } };
  const gateway = new ToolGateway(appPool, policy, provider);
  for (const d of defs) gateway.register(d);
  return gateway;
}

const run = (gateway: ToolGateway, tool: string, action: string, parameters: Record<string, JsonValue>, key?: string): Promise<ToolResult> =>
  gateway.execute({ identity, tool_id: tool, action, parameters, ...(key ? { idempotency_key: key } : {}) });
const rowOf = async (key: string) =>
  (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;
const expectTimedOut = (result: ToolResult): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/tool_timeout/);
};

beforeEach(() => {
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "fake-client-id-for-test");
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "fake-client-secret-for-test");
  resetGoogleAccessTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------------------------------------------- kontrakten

describe("A: kontrakten mellom gatewayen og transporten", () => {
  it("transporten får signalet som 5. parameter OG som ambient kontekst (samme objekt); det avbrytes ikke ved suksess", async () => {
    let explicit: AbortSignal | undefined;
    let ambient: AbortSignal | undefined;
    const transport: ToolTransport = {
      async invoke(_a, _p, _c, _ctx, signal) { explicit = signal; ambient = currentCallSignal(); return { external_id: "ok-1" }; }
    };
    const result = await run(gatewayWith([def({ tool_id: "t", action: "go", transport })]), "t", "go", {});
    expect(result.ok).toBe(true);
    expect(explicit).toBeInstanceOf(AbortSignal);
    expect(ambient).toBe(explicit);
    await sleep(250); // lenger enn timeout_ms: en fullført kall avbrytes aldri i ettertid
    expect(explicit?.aborted).toBe(false);
  });

  it("tidsavbruddet avbryter signalet med Error('tool_timeout') og utfallet er UKJENT (unverified), aldri en vanlig leverandørfeil som kan prøves på nytt", async () => {
    let seen: AbortSignal | undefined;
    const transport: ToolTransport = { async invoke(_a, _p, _c, _ctx, signal) { seen = signal; return new Promise(() => undefined); } };
    const key = `k-${randomUUID()}`;
    const result = await run(gatewayWith([def({ tool_id: "t", action: "go", transport })]), "t", "go", {}, key);
    expectTimedOut(result);
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as Error).message).toBe("tool_timeout");
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("en transport som feiler SAMTIDIG med tidsavbruddet (avviser med abort-årsaken) klassifiseres fortsatt som ukjent utfall, ikke som en feil som kan prøves på nytt", async () => {
    const transport: ToolTransport = {
      async invoke(_a, _p, _c, _ctx, signal) {
        return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("annen_feil_tekst")), { once: true }));
      }
    };
    const key = `k-${randomUUID()}`;
    const result = await run(gatewayWith([def({ tool_id: "t", action: "go", transport })]), "t", "go", {}, key);
    expectTimedOut(result);
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("readback (etter-lesing) får sin egen frist og signal, og et hengende readback avbrytes", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let n = 0;
    const transport: ToolTransport = {
      async invoke(action, _p, _c, _ctx, signal) {
        n += 1;
        signals.push(signal);
        if (action === "read_state" && n === 3) return new Promise(() => undefined); // readback henger
        return action === "read_state" ? { data: { state: "x" } } : { external_id: "done-1" };
      }
    };
    const started = Date.now();
    const result = await run(gatewayWith([def({ tool_id: "t", action: "do", transport, preflight_action: "read_state" })]), "t", "do", {});
    expect(result.ok).toBe(true); // klasse C: uleselig readback blir bevis-hull, ikke en feilet handling
    expect(Date.now() - started).toBeLessThan(2000);
    expect(n).toBe(3);
    expect(signals[2]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false); // selve handlingen lyktes og avbrytes ikke
  });

  it("et NØSTET kall startes aldri på vegne av et ytre kall som er tidsavbrutt (caller_call_aborted), men fungerer normalt mens det ytre kallet lever", async () => {
    let nestedAfterAbort: ToolResult | undefined;
    let nestedBefore: ToolResult | undefined;
    let innerCalls = 0;
    let innerSaw: AbortSignal | undefined;
    const holder: { gateway?: ToolGateway } = {};
    const inner: ToolTransport = { async invoke(_a, _p, _c, _ctx, signal) { innerCalls += 1; innerSaw = currentCallSignal() ?? signal; return { external_id: "inner-1" }; } };
    const outer: ToolTransport = {
      async invoke(action, _p, _c, _ctx, signal) {
        if (action === "fast") {
          nestedBefore = await holder.gateway!.execute({ identity, tool_id: "inner", action: "send", parameters: {} });
          return { external_id: "outer-fast" };
        }
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true })); // vent til tidsavbruddet
        nestedAfterAbort = await holder.gateway!.execute({ identity, tool_id: "inner", action: "send", parameters: {} });
        return { external_id: "outer-late" };
      }
    };
    const gateway = gatewayWith([
      def({ tool_id: "outer", action: "fast", transport: outer, timeout_ms: 2000 }),
      def({ tool_id: "outer", action: "slow", transport: outer }),
      def({ tool_id: "inner", action: "send", transport: inner })
    ]);
    holder.gateway = gateway;
    expect((await run(gateway, "outer", "fast", {})).ok).toBe(true);
    expect(nestedBefore?.ok).toBe(true);
    expect(innerCalls).toBe(1);
    const callsBefore = innerCalls;
    expect(innerSaw).toBeInstanceOf(AbortSignal); // det nøstede kallet fikk sitt EGET signal

    expectTimedOut(await run(gateway, "outer", "slow", {}));
    await vi.waitFor(() => expect(nestedAfterAbort).toBeDefined(), { timeout: 2000 });
    expect(nestedAfterAbort?.ok).toBe(false);
    if (nestedAfterAbort && !nestedAfterAbort.ok) expect(nestedAfterAbort.reason).toBe("caller_call_aborted");
    expect(innerCalls).toBe(callsBefore); // mutasjonen ble aldri forsøkt
    const denied = await adminPool.query("SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'tool.denied' AND tool_id = 'inner' ORDER BY audit_id DESC LIMIT 1", [TENANT]);
    expect((denied.rows[0] as { reason: string }).reason).toBe("caller_call_aborted");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- familier

describe("B: Google-familien (Gmail/Calendar/Drive/Sheets/GCE/Ads deler googleAccessToken)", () => {
  it("Gmail send (POST) henger: forespørselen avbrytes, sendes ikke på nytt, raden er unverified og en replay utfører ingenting", async () => {
    stubFetch((call) => (isToken(call) ? tokenReply() : "hang"));
    const gateway = gatewayWith([def({ tool_id: "email", action: "send", transport: new GmailTransport("test@example.com") })]);
    const key = `k-${randomUUID()}`;
    const parameters = { to: "mottaker@example.com", subject: "Hei", body: "Tekst" };
    const started = Date.now();
    expectTimedOut(await run(gateway, "email", "send", parameters, key));
    expect(Date.now() - started).toBeLessThan(2000);
    const sends = () => calls.filter((c) => c.url.endsWith("/messages/send"));
    expect(sends()).toHaveLength(1);
    await vi.waitFor(() => expect(sends()[0]!.signal?.aborted).toBe(true), { timeout: 1000 });
    expect((await rowOf(key))?.status).toBe("unverified");
    const replay = await run(gateway, "email", "send", parameters, key);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toMatch(/tool_timeout_outcome_unknown/);
    await sleep(300);
    expect(sends()).toHaveLength(1);
  });

  it("Gmail read_inbox: et hengende KALL SENERE I KJEDEN (første melding etter listen) avbrytes også - ikke bare første forespørsel", async () => {
    stubFetch((call) => (isToken(call) ? tokenReply() : call.url.includes("/messages?") ? json({ messages: [{ id: "m1" }] }) : "hang"));
    const gateway = gatewayWith([def({ tool_id: "email", action: "read_inbox", transport: new GmailTransport("test@example.com"), capability_class: "A" })]);
    expectTimedOut(await run(gateway, "email", "read_inbox", { max: 5 }));
    const message = calls.filter((c) => c.url.includes("/messages/m1"));
    expect(message).toHaveLength(1);
    await vi.waitFor(() => expect(message[0]!.signal?.aborted).toBe(true), { timeout: 1000 });
    await sleep(200);
    expect(calls.filter((c) => c.url.includes("/messages/m1"))).toHaveLength(1);
  });

  it("det delte token-endepunktet henger: kalleren slippes fri ved eget tidsavbrudd, men utvekslingen er ikke bundet til kallets signal", async () => {
    stubFetch((call) => (isToken(call) ? "hang" : json({})));
    const gateway = gatewayWith([def({ tool_id: "email", action: "read_inbox", transport: new GmailTransport("test@example.com"), capability_class: "A" })]);
    const started = Date.now();
    expectTimedOut(await run(gateway, "email", "read_inbox", { max: 1 }));
    expect(Date.now() - started).toBeLessThan(2000);
    const token = calls.filter(isToken);
    expect(token).toHaveLength(1);
    expect(token[0]!.signal?.aborted).toBe(false); // egen 45 s-grense, ikke kallets signal
  });

  it("GCE reset_instance: POST lyktes, poll-løkken STOPPER ved tidsavbrudd (ingen flere GET mot operasjonen), og ingen ny reset sendes", async () => {
    stubFetch((call) => {
      if (isToken(call)) return tokenReply();
      if (call.method === "POST") return json({ name: "op-1" });
      return json({ status: "RUNNING" });
    });
    const gateway = gatewayWith([def({ tool_id: "gce", action: "reset_instance", transport: new GceTransport("fake-project", 400), timeout_ms: 200 })]);
    const key = `k-${randomUUID()}`;
    expectTimedOut(await run(gateway, "gce", "reset_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, key));
    await sleep(900); // lenger enn poll-intervallet (400 ms) x2: en levende poll-løkke ville fortsatt ringt
    const posts = calls.filter((c) => c.method === "POST" && !isToken(c));
    const polls = calls.filter((c) => c.method === "GET");
    expect(posts).toHaveLength(1);
    expect(polls).toHaveLength(1); // kun den ene FØR tidsavbruddet
    expect((await rowOf(key))?.status).toBe("unverified");
  });
});

describe("C: GitHub og Zapier (retry-løkker med backoff)", () => {
  it("GitHub POST som får 429 med Retry-After sover IKKE videre etter tidsavbruddet: forsøk 2 ville gått ut etter 1 s - det gjør det aldri", async () => {
    stubFetch(() => json({ message: "rate limited" }, 429, { "retry-after": "1" }));
    const gateway = gatewayWith([def({ tool_id: "github", action: "create_issue", transport: new GithubTransport() })]);
    const started = Date.now();
    expectTimedOut(await run(gateway, "github", "create_issue", { repo: "owner/repo", title: "t", body: "b" }, `k-${randomUUID()}`));
    expect(Date.now() - started).toBeLessThan(900); // gatewayen svarer ved tidsavbruddet (150 ms), ikke etter ventingen
    await sleep(1300); // forbi Retry-After (1 s): en levende retry-løkke ville nå ha sendt forsøk 2
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("GitHub-hengende POST avbrytes (signalet på forespørselen), og 5xx på en mutasjon gjentas aldri uansett", async () => {
    stubFetch(() => "hang");
    const gateway = gatewayWith([def({ tool_id: "github", action: "create_issue", transport: new GithubTransport() })]);
    expectTimedOut(await run(gateway, "github", "create_issue", { repo: "owner/repo", title: "t" }));
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true), { timeout: 1000 });
    expect(calls).toHaveLength(1);
    stubFetch(() => json({ message: "nede" }, 503));
    const failed = await run(gateway, "github", "create_issue", { repo: "owner/repo", title: "t" });
    expect(failed.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("Zapier call_tool: 429 -> backoff (500 ms) -> tidsavbrudd under ventingen: ingen andre POST, heller ikke etter at backoff-tiden er passert", async () => {
    stubFetch(() => json({ error: "rate" }, 429));
    const url = "https://mcp.zapier.com/api/mcp/s/fake-token-for-test/mcp";
    const gateway = gatewayWith([def({ tool_id: "zapier", action: "call_tool", transport: new McpZapierTransport() })], { WPK_TEST_CREDENTIAL: url });
    expectTimedOut(await run(gateway, "zapier", "call_tool", { tool_name: "send_mail", arguments: "{}" }, `k-${randomUUID()}`));
    await sleep(900);
    expect(calls).toHaveLength(1);
  });

  it("Zapier call_tool henger: forespørselen avbrytes via det SAMMENSATTE signalet (eget 45 s-tak + kallsignal), ingen retry", async () => {
    stubFetch(() => "hang");
    const url = "https://mcp.zapier.com/api/mcp/s/fake-token-for-test/mcp";
    const gateway = gatewayWith([def({ tool_id: "zapier", action: "call_tool", transport: new McpZapierTransport() })], { WPK_TEST_CREDENTIAL: url });
    expectTimedOut(await run(gateway, "zapier", "call_tool", { tool_name: "send_mail", arguments: "{}" }, `k-${randomUUID()}`));
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true), { timeout: 1000 });
    await sleep(700);
    expect(calls).toHaveLength(1);
  });
});

describe("D: meldingsfamilien (Slack, Telegram) - POST som sender en melding", () => {
  it("Slack notify og Telegram notify henger: avbrutt, én forespørsel, unverified", async () => {
    stubFetch(() => "hang");
    const gateway = gatewayWith([
      def({ tool_id: "slack", action: "notify", transport: new SlackTransport() }),
      def({ tool_id: "telegram", action: "notify", transport: new TelegramTransport("12345") })
    ]);
    for (const [tool, params] of [["slack", { channel: "C1", message: "hei" }], ["telegram", { message: "hei" }]] as const) {
      const key = `k-${randomUUID()}`;
      const before = calls.length;
      expectTimedOut(await run(gateway, tool, "notify", params, key));
      expect(calls.length - before).toBe(1);
      await vi.waitFor(() => expect(calls[before]!.signal?.aborted).toBe(true), { timeout: 1000 });
      expect((await rowOf(key))?.status).toBe("unverified");
    }
    await sleep(250);
    expect(calls).toHaveLength(2);
  });
});

describe("E: konfigurerbar base-URL - EKTE lokal server (avbruddet sees som lukket socket)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("Home Assistant light_set: POST henger -> serveren ser socketen lukkes, nøyaktig én forespørsel, unverified", async () => {
    const requests: string[] = [];
    const closed: string[] = [];
    server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      requests.push(key);
      res.on("close", () => { if (!res.writableEnded) closed.push(key); });
      // aldri svar
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transport = new HomeAssistantTransport(async () => base, async () => ({ home: { stue: { light: "light.stue" } } }));
    const gateway = gatewayWith([def({ tool_id: "home_assistant", action: "light_set", transport, timeout_ms: 200 })]);
    const key = `k-${randomUUID()}`;
    expectTimedOut(await run(gateway, "home_assistant", "light_set", { site_id: "home", room_id: "stue", on: true }, key));
    await vi.waitFor(() => expect(closed).toEqual(["POST /api/services/light/turn_on"]), { timeout: 2000 });
    await sleep(300);
    expect(requests).toEqual(["POST /api/services/light/turn_on"]);
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("Cloudflare (lesing) som får 429 med Retry-After sover ikke videre etter tidsavbruddet: forsøk 2 ville gått ut etter 1 s - det gjør det aldri", async () => {
    const cf = new FakeCloudflare();
    await cf.start();
    try {
      cf.rateLimitNext(5, 1);
      const transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId });
      const gateway = gatewayWith([def({ tool_id: "cloudflare", action: "list_zones", transport, capability_class: "A", timeout_ms: 250 })], { WPK_TEST_CREDENTIAL: cf.token });
      const started = Date.now();
      expectTimedOut(await run(gateway, "cloudflare", "list_zones", {}));
      expect(Date.now() - started).toBeLessThan(900);
      await sleep(1300); // forbi Retry-After (1 s): en levende retry-løkke ville nå ha sendt forsøk 2
      expect(cf.requests).toHaveLength(1);
    } finally {
      await cf.stop();
    }
  });
});

describe("F: prosess- og tilkoblingstransporter med EGEN I/O (må koble signalet selv)", () => {
  it("Docker: tidsavbruddet dreper docker-prosessen (SIGKILL) og neste steg i flertrinns-handlingen startes ikke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wpk18-docker-"));
    const bin = join(dir, "fake-docker.sh");
    const pidFile = join(dir, "pid");
    const log = join(dir, "log");
    await writeFile(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho $$ >> "${pidFile}"\nexec sleep 30\n`, "utf8");
    await chmod(bin, 0o755);
    const gateway = gatewayWith([def({ tool_id: "docker", action: "redeploy_container", transport: new DockerTransport(20_000), timeout_ms: 400 })], { WPK_TEST_CREDENTIAL: bin });
    const key = `k-${randomUUID()}`;
    const started = Date.now();
    expectTimedOut(await run(gateway, "docker", "redeploy_container", { name: "sentinel-wpk", image: "alpine:3" }, key));
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number((await readFile(pidFile, "utf8")).trim().split("\n")[0]);
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 3000 }); // prosessen er borte (ikke sovende i 30 s)
    await sleep(300);
    const invocations = (await readFile(log, "utf8")).trim().split("\n");
    expect(invocations).toHaveLength(1); // kun `rm -f` startet; `run -d` ble aldri forsøkt
    expect(invocations[0]).toMatch(/^rm -f/);
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("Postgres-drift: avbrudd lukker tilkoblingen og ingen flere spørringer startes", async () => {
    const queries: string[] = [];
    let ended = 0;
    let rejectHanging: ((e: Error) => void) | undefined;
    const client: PgOpsClient = {
      async connect() { return undefined; },
      async query(sql: string) {
        queries.push(sql);
        if (/^SET /.test(sql)) return { rows: [], rowCount: null } as never;
        if (/current_user/.test(sql)) return { rows: [{ me: "jarvis_ops", db: "jarvis", monitor: true, super: false }], rowCount: 1 } as never;
        return new Promise((_, reject) => { rejectHanging = reject; }) as never; // diagnostikk-spørringen henger
      },
      async end() { ended += 1; rejectHanging?.(new Error("Connection terminated")); }
    };
    const transport = new PostgresOpsTransport({ config: parsePostgresOpsConfig({ databases: "jarvis" }), createClient: () => client });
    const gateway = gatewayWith([def({ tool_id: "postgres_ops", action: "get_connections", transport, capability_class: "A" })], { WPK_TEST_CREDENTIAL: "postgres://jarvis_ops@127.0.0.1:5432/jarvis" });
    const started = Date.now();
    expectTimedOut(await run(gateway, "postgres_ops", "get_connections", {}));
    expect(Date.now() - started).toBeLessThan(2000);
    await vi.waitFor(() => expect(ended).toBeGreaterThanOrEqual(1), { timeout: 1000 });
    const countAtAbort = queries.length;
    await sleep(200);
    expect(queries).toHaveLength(countAtAbort);
  });

  it("nettleser-gatewayen (eget 30 s-tak): det EKSPLISITTE signalet avbryter forespørselen, også uten ambient kontekst", async () => {
    stubFetch(() => "hang");
    const transport = new BrowserGatewayTransport("x".repeat(40));
    const c = new AbortController();
    const pending = transport.invoke("navigate", { url: "https://example.com" }, "http://browser-gateway:3030", { identity } as ToolInvocationContext, c.signal);
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.signal?.aborted).toBe(false);
    c.abort(new Error("tool_timeout"));
    await assertion;
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("nettleser-gatewayen via gatewayen: tidsavbrudd avbryter forespørselen, ingen retry", async () => {
    stubFetch(() => "hang");
    const gateway = gatewayWith([def({ tool_id: "browser", action: "navigate", transport: new BrowserGatewayTransport("x".repeat(40)), capability_class: "A" })], { WPK_TEST_CREDENTIAL: "http://browser-gateway:3030" });
    expectTimedOut(await run(gateway, "browser", "navigate", { url: "https://example.com" }));
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true), { timeout: 1000 });
    expect(calls).toHaveLength(1);
  });
});
