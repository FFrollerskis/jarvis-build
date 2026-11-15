import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  CloudflareApiError, ControlTargetHttpError, ToolGateway, UnsafeVendorUrlError, guardedFetch, isIndeterminateTransportError, jsonRequest, transportErrorKind,
  type ClassDNotification, type ClassDNotifier, type ToolDefinition, type ToolTransport
} from "../src/index.ts";

/**
 * WP-K review M1 (JARVIS-018): en transport-feil (`TimeoutError`/`AbortError`, nullstilt socket etter sending, `fetch failed`) på en IKKE-IDEMPOTENT klasse C/D-mutasjon var `failed` i ledgeren, så et
 * samme-nøkkel-replay re-armet raden og sendte POST-en en gang til (reviewerens exp2). Nå er utfallet UKJENT (`unverified`, aldri retry-bart med samme nøkkel). Feil som beviser at ingenting ble sendt
 * (DNS, tilkobling nektet, TLS, utrygg URL) forblir `failed`, og idempotente mutasjoner / klasse A / klasse B er uendret. Ekte embedded Postgres + EKTE socket-feil fra undici mot lokale servere.
 */
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-m1", memory_space_id: "personal", session_id: "sess-m1", device_id: "dev-pc", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async () => "fake-token-for-test" };

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpkm1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpkm1 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpkm1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-m1','M1','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-m1');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpkm1", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-m1"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const anySchema = { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"];
type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "m1", action: "send", description: "test", input_schema: anySchema, capability_class: "C", scopes: [], reversible: false, rollback_procedure: "manuell",
    idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 600, credential_ref: "M1_TOKEN", output_trust: "internal", transport
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

/** Transport som «sender» (teller) og så feiler med den oppgitte feilen - som en POST der svaret aldri kom frem. */
function flaky(makeError: () => unknown): { transport: ToolTransport; sends: () => number } {
  let sends = 0;
  return {
    transport: { invoke: async (action: string) => { if (action === "preflight") return { data: { ok: true } }; sends += 1; throw makeError(); } },
    sends: () => sends
  };
}

let toolSeq = 0;
async function runTwice(opts: { cls?: "C" | "D" | "B"; idem?: boolean; error: () => unknown; notifier?: ClassDNotifier }): Promise<{
  first: unknown; replay: unknown; sends: number; row: { status: string; postcondition_reason: string | null }; key: string; toolId: string
}> {
  const f = flaky(opts.error);
  const toolId = `m1-${(toolSeq += 1)}`;
  const key = `k-m1-${toolId}`;
  const cls = opts.cls ?? "C";
  const g = new ToolGateway(appPool, policy, secrets, undefined, undefined, opts.notifier ? { classDPipeline: { enforce: true, notifier: opts.notifier } } : undefined);
  g.register(def({
    tool_id: toolId, capability_class: cls, idempotent_external: opts.idem ?? false,
    ...(cls === "D" && opts.notifier ? { class_d_profile: "outbound_message" as const } : {})
  }, f.transport));
  const request = { identity, tool_id: toolId, action: "send", parameters: {}, idempotency_key: key };
  const first = await g.execute(request);
  const replay = await g.execute(request);
  const row = (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null };
  return { first, replay, sends: f.sends(), row, key, toolId };
}

const withCode = (message: string, code: string, name = "Error"): Error => Object.assign(new Error(message), { code, name });
const fetchFailed = (cause: unknown): TypeError => new TypeError("fetch failed", { cause });

describe("klassifisering av feilformen (ren funksjon)", () => {
  it("uavklarte feil (kan ha nådd leverandøren) er ukjent utfall", () => {
    const cases: Array<[string, unknown, string]> = [
      ["TimeoutError fra AbortSignal.timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
      ["AbortError", new DOMException("This operation was aborted", "AbortError"), "aborted"],
      ["fetch failed + ECONNRESET", fetchFailed(withCode("read ECONNRESET", "ECONNRESET")), "reset"],
      ["fetch failed + undici SocketError", fetchFailed(withCode("other side closed", "UND_ERR_SOCKET", "SocketError")), "reset"],
      ["fetch failed + EPIPE", fetchFailed(withCode("write EPIPE", "EPIPE")), "reset"],
      ["undici headers-timeout", fetchFailed(withCode("Headers Timeout Error", "UND_ERR_HEADERS_TIMEOUT", "HeadersTimeoutError")), "timeout"],
      ["fetch failed uten kjent årsak (konservativt)", new TypeError("fetch failed"), "network"],
      ["terminated", new TypeError("terminated"), "network"],
      ["AggregateError med ECONNRESET", fetchFailed(Object.assign(new AggregateError([withCode("reset", "ECONNRESET")], "x"), { code: undefined })), "reset"]
    ];
    for (const [label, error, kind] of cases) {
      expect(isIndeterminateTransportError(error), label).toBe(true);
      expect(transportErrorKind(error), label).toBe(kind);
    }
  });

  it("feil som BEVISER at ingenting ble sendt er ikke ukjent utfall (DNS, tilkobling nektet, TLS, utrygg URL, ordinære leverandørfeil)", () => {
    const cases: Array<[string, unknown]> = [
      ["ECONNREFUSED", fetchFailed(withCode("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED"))],
      ["ENOTFOUND", fetchFailed(withCode("getaddrinfo ENOTFOUND x.invalid", "ENOTFOUND"))],
      ["EAI_AGAIN", fetchFailed(withCode("getaddrinfo EAI_AGAIN", "EAI_AGAIN"))],
      ["connect-timeout", fetchFailed(withCode("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT"))],
      ["TLS: ugyldig sertifikat", fetchFailed(withCode("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"))],
      ["TLS: ERR_TLS_CERT_ALTNAME_INVALID", fetchFailed(withCode("Hostname mismatch", "ERR_TLS_CERT_ALTNAME_INVALID"))],
      ["utrygg URL", new UnsafeVendorUrlError("private_address")],
      ["ordinær leverandørfeil", new Error("github_api_error_422:Validation Failed")],
      ["ukjent verdi", "streng"],
      ["null", null]
    ];
    for (const [label, error] of cases) expect(isIndeterminateTransportError(error), label).toBe(false);
  });

  it("en feil som kaster fra getters, eller en sirkulær cause-kjede, får aldri klassifiseringen til å kaste", () => {
    const evil = { get name(): string { throw new Error("boom"); }, get code(): string { throw new Error("boom"); }, get message(): string { throw new Error("boom"); } };
    expect(() => isIndeterminateTransportError(evil)).not.toThrow();
    const a: { cause?: unknown; name: string } = { name: "Error" };
    a.cause = a;
    expect(() => isIndeterminateTransportError(a)).not.toThrow();
    expect(isIndeterminateTransportError(a)).toBe(false);
  });
});

describe("ledger: samme-nøkkel-replay sender ALDRI en ikke-idempotent klasse C/D-mutasjon to ganger etter en uavklart transportfeil (exp2)", () => {
  const indeterminate: Array<[string, () => unknown]> = [
    ["TimeoutError", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["AbortError", () => new DOMException("This operation was aborted", "AbortError")],
    ["fetch failed + ECONNRESET", () => fetchFailed(withCode("read ECONNRESET", "ECONNRESET"))],
    ["fetch failed uten årsak", () => new TypeError("fetch failed")]
  ];
  for (const cls of ["C", "D"] as const) {
    for (const [label, error] of indeterminate) {
      it(`klasse ${cls} + ${label}: første kall er ukjent utfall (unverified), replay utfører INGENTING og gir samme sanne resultat`, async () => {
        const r = await runTwice({ cls, error });
        expect(r.first).toMatchObject({ ok: false });
        expect(String((r.first as { reason: string }).reason)).toMatch(/^tool_failed:outcome_unknown:transport_(timeout|aborted|reset|network)$/);
        expect(r.row.status).toBe("unverified");
        expect(r.row.postcondition_reason).toBe("postcondition_unverified:tool_timeout_outcome_unknown");
        expect(r.replay).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
        expect(r.sends).toBe(1); // POST-en ble sendt NØYAKTIG én gang
      }, 30_000);
    }
  }

  it("feil som beviser at ingenting ble sendt (tilkobling nektet) forblir `failed`: replay re-armer og sender på nytt (uendret)", async () => {
    const r = await runTwice({ cls: "D", error: () => fetchFailed(withCode("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED")) });
    expect(r.row.status).toBe("failed");
    expect(r.sends).toBe(2);
    expect(String((r.first as { reason: string }).reason)).toContain("tool_failed:fetch failed");
  }, 30_000);

  it("en ordinær leverandørfeil (avvist av leverandøren) forblir `failed` (retry tillatt)", async () => {
    const r = await runTwice({ cls: "C", error: () => new Error("github_api_error_422:Validation Failed") });
    expect(r.row.status).toBe("failed");
    expect(r.sends).toBe(2);
  }, 30_000);

  it("IDEMPOTENTE mutasjoner (idempotent_external: true) er uendret: en uavklart transportfeil er `failed`, retry tillatt", async () => {
    const r = await runTwice({ cls: "C", idem: true, error: () => new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    expect(r.row.status).toBe("failed");
    expect(r.sends).toBe(2);
  }, 30_000);

  it("klasse B (varsler/intern bokføring) er bevisst uendret: `failed` (dokumentert i runbook), retry tillatt", async () => {
    const r = await runTwice({ cls: "B", error: () => new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    expect(r.row.status).toBe("failed");
    expect(r.sends).toBe(2);
  }, 30_000);

  it("klasse D under håndhevet pipeline: eieren varsles om UKJENT utfall (out-of-band), og replay sender ikke på nytt", async () => {
    const sent: ClassDNotification[] = [];
    const notifier: ClassDNotifier = { ready: () => true, notify: async (n) => { sent.push(n); } };
    const r = await runTwice({ cls: "D", error: () => fetchFailed(withCode("read ECONNRESET", "ECONNRESET")), notifier });
    expect(r.row.status).toBe("unverified");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tool_id: r.toolId, action: "send", outcome: "unknown", idempotency_key: r.key });
    expect(r.sends).toBe(1);
  }, 30_000);

  it("audit: tool.failed bærer outcome_unknown:true og en fast kode (aldri feilteksten fra leverandøren)", async () => {
    const r = await runTwice({ cls: "D", error: () => fetchFailed(withCode("read ECONNRESET to https://vendor.invalid/secret-path?token=abc", "ECONNRESET")) });
    const audit = (await adminPool.query(
      "SELECT reason, payload->>'outcome_unknown' AS unknown FROM audit_events WHERE tool_id = $1 AND type = 'tool.failed' ORDER BY audit_id LIMIT 1", [r.toolId]
    )).rows[0] as { reason: string; unknown: string };
    expect(audit).toEqual({ reason: "outcome_unknown:transport_reset", unknown: "true" });
  }, 30_000);
});

describe("EKTE socket-feil (undici mot lokale servere) gir samme klassifisering som de syntetiske formene", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const close of closers) await close(); });

  const listen = async <T extends Server | TcpServer>(server: T): Promise<{ server: T; port: number }> => {
    await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { (server as Server).closeAllConnections?.(); server.close(() => resolve()); }));
    return { server, port: (server.address() as AddressInfo).port };
  };

  it("serveren avbryter forbindelsen ETTER at forespørselen er sendt (socket nullstilt): ukjent utfall, replay sender ikke på nytt", async () => {
    let received = 0;
    const { port } = await listen(createTcpServer((socket) => { socket.once("data", () => { received += 1; socket.destroy(); }); }));
    // ekte fetch via en transport som muterer mot den lokale serveren
    const hits = { count: 0 };
    const real: ToolTransport = { invoke: async () => { hits.count += 1; await fetch(`http://127.0.0.1:${port}/mutate`, { method: "POST", body: "x" }); return {}; } };
    const g = new ToolGateway(appPool, policy, secrets);
    g.register(def({ tool_id: "m1-real-reset", capability_class: "D" }, real));
    const request = { identity, tool_id: "m1-real-reset", action: "send", parameters: {}, idempotency_key: "k-m1-real-reset" };
    const first = await g.execute(request);
    const replay = await g.execute(request);
    expect(first).toMatchObject({ ok: false });
    expect(String((first as { reason: string }).reason)).toMatch(/^tool_failed:outcome_unknown:transport_(reset|network)$/);
    expect(replay).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(hits.count).toBe(1);
    expect(received).toBe(1); // leverandøren (serveren) mottok forespørselen NØYAKTIG én gang
  }, 30_000);

  it("serveren svarer aldri (eget 150 ms-tak -> ekte TimeoutError): ukjent utfall, forespørselen sendes ikke på nytt", async () => {
    let received = 0;
    const { port } = await listen(createServer((req, res) => { received += 1; req.resume(); void res; /* svarer aldri */ }));
    const hits = { count: 0 };
    const real: ToolTransport = { invoke: async () => { hits.count += 1; await fetch(`http://127.0.0.1:${port}/mutate`, { method: "POST", body: "x", signal: AbortSignal.timeout(150) }); return {}; } };
    const g = new ToolGateway(appPool, policy, secrets);
    g.register(def({ tool_id: "m1-real-timeout", capability_class: "D", timeout_ms: 5_000 }, real));
    const request = { identity, tool_id: "m1-real-timeout", action: "send", parameters: {}, idempotency_key: "k-m1-real-timeout" };
    const first = await g.execute(request);
    const replay = await g.execute(request);
    expect(String((first as { reason: string }).reason)).toBe("tool_failed:outcome_unknown:transport_timeout");
    expect(replay).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(hits.count).toBe(1);
    expect(received).toBe(1);
  }, 30_000);

  it("tilkobling nektet (ingen lytter): ingenting ble sendt - forblir `failed` og kan prøves på nytt", async () => {
    const probe = await listen(createTcpServer());
    const closedPort = probe.port;
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));
    const hits = { count: 0 };
    const real: ToolTransport = { invoke: async () => { hits.count += 1; await fetch(`http://127.0.0.1:${closedPort}/mutate`, { method: "POST", body: "x" }); return {}; } };
    const g = new ToolGateway(appPool, policy, secrets);
    g.register(def({ tool_id: "m1-real-refused", capability_class: "D" }, real));
    const request = { identity, tool_id: "m1-real-refused", action: "send", parameters: {}, idempotency_key: "k-m1-real-refused" };
    await g.execute(request);
    await g.execute(request);
    const row = (await adminPool.query("SELECT status FROM tool_executions WHERE idempotency_key = 'k-m1-real-refused'")).rows[0] as { status: string };
    expect(row.status).toBe("failed");
    expect(hits.count).toBe(2);
  }, 30_000);
});

/**
 * Re-review (LOW 1): TRE former der leverandøren faktisk SVARTE, men transporten likevel kastet, ble regnet som «ikke sendt»/«ordinær feil» (`failed`), så et samme-nøkkel-replay sendte en ikke-idempotent POST en gang til
 * (reviewerens POST+303: 2 POST). Nå er utfallet UKJENT (`unverified`). Beviset er ekte HTTP: en lokal leverandørserver telles, `guardedFetch`/`jsonRequest`/`Response.json()` er de EKTE funksjonene, og gatewayen er ekte
 * (embedded Postgres, klasse D under håndhevet pipeline der det er relevant).
 */
describe("LOW 1: leverandøren SVARTE, men transporten kastet - klassifisering (ren funksjon)", () => {
  it("`unexpected_redirect_http_<status>` (301/302/303/307/308) er ukjent utfall med kind `redirect` - forespørselen ble SENDT og besvart; ANDRE `UnsafeVendorUrlError` (kastet FØR sending) er det ikke", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const err = new UnsafeVendorUrlError(`unexpected_redirect_http_${status}`);
      expect(isIndeterminateTransportError(err), String(status)).toBe(true);
      expect(transportErrorKind(err), String(status)).toBe("redirect");
    }
    for (const reason of ["dot_segment", "url_malformed", "url_not_plain_http_url", "normalization_changed_url", "file_id_unsafe", "id_invalid", "repo_invalid"]) {
      expect(isIndeterminateTransportError(new UnsafeVendorUrlError(reason)), reason).toBe(false);
    }
  });

  it("redirect-feilen gjenkjennes også når en transport pakker den inn (cause-kjeden), men ikke når en utrygg URL er pakket inn", () => {
    expect(isIndeterminateTransportError(new Error("vendor_failed", { cause: new UnsafeVendorUrlError("unexpected_redirect_http_303") }))).toBe(true);
    expect(transportErrorKind(new Error("vendor_failed", { cause: new UnsafeVendorUrlError("unexpected_redirect_http_303") }))).toBe("redirect");
    expect(isIndeterminateTransportError(new Error("vendor_failed", { cause: new UnsafeVendorUrlError("dot_segment") }))).toBe(false);
  });

  it("en feil som BÆRER en 2xx-`httpStatus` (leverandøren sa ja, transporten godtok ikke svaret) er ukjent utfall med kind `response`; 4xx (avvist) og 5xx (dokumentert grense) er det ikke", () => {
    const accepted: Array<[string, unknown]> = [
      ["ControlTargetHttpError non_json 200", new ControlTargetHttpError("infisical_invalid_response:non_json", 200, false)],
      ["ControlTargetHttpError response_too_large 200", new ControlTargetHttpError("response_too_large", 200, false)],
      ["CloudflareApiError non_json 200", new CloudflareApiError("cloudflare_invalid_response:non_json", 200, false)],
      ["CloudflareApiError success_flag_missing 201", new CloudflareApiError("cloudflare_error_201:success_flag_missing", 201, false)]
    ];
    for (const [label, error] of accepted) {
      expect(isIndeterminateTransportError(error), label).toBe(true);
      expect(transportErrorKind(error), label).toBe("response");
    }
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
      expect(isIndeterminateTransportError(new ControlTargetHttpError(`vendor_error_${status}:x`, status, false)), String(status)).toBe(false);
      expect(isIndeterminateTransportError(new CloudflareApiError(`cloudflare_error_${status}:x`, status, false)), `cf ${status}`).toBe(false);
    }
  });

  it("en `SyntaxError` fra JSON-parsing (`Response.json()`/`JSON.parse` på et 2xx-svar) er ukjent utfall med kind `response`; en `SyntaxError` som ikke gjelder JSON er det ikke", async () => {
    const parse = (text: string): unknown => { try { JSON.parse(text); } catch (error) { return error; } return undefined; };
    for (const text of ["<html>ok</html>", "", "{not json", "undefined", "OK", "{\"a\":1} trailing"]) {
      const error = parse(text);
      expect(error, text).toBeInstanceOf(SyntaxError);
      expect(isIndeterminateTransportError(error), text).toBe(true);
      expect(transportErrorKind(error), text).toBe("response");
    }
    const viaResponse = await new Response("<html>ok</html>", { status: 200 }).json().then(() => undefined, (error: unknown) => error);
    expect(isIndeterminateTransportError(viaResponse)).toBe(true);
    expect(isIndeterminateTransportError(new SyntaxError("Invalid regular expression: /(/: Unterminated group"))).toBe(false);
  });
});

interface VendorRequest { method: string; path: string; body: string }
const vendorClosers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of vendorClosers) await close(); });

/** Ekte lokal leverandørserver som teller hver forespørsel (metode, sti, kropp) og svarer med `respond`. */
async function startVendor(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; requests: VendorRequest[] }> {
  const requests: VendorRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vendorClosers.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

let realSeq = 0;
/** Kjører den samme ikke-idempotente mutasjonen to ganger med SAMME nøkkel mot en transport som gjør ekte HTTP. `invokes` teller kall inn i transporten (også de som aldri sendte noe). */
async function runTwiceReal(opts: { cls: "B" | "C" | "D"; idem?: boolean; mutate: () => Promise<void>; notifier?: ClassDNotifier }): Promise<{
  first: unknown; replay: unknown; invokes: number; row: { status: string; postcondition_reason: string | null }
}> {
  const toolId = `m1-low1-${(realSeq += 1)}`;
  const key = `k-${toolId}`;
  let invokes = 0;
  const transport: ToolTransport = { invoke: async () => { invokes += 1; await opts.mutate(); return {}; } };
  const g = new ToolGateway(appPool, policy, secrets, undefined, undefined, opts.notifier ? { classDPipeline: { enforce: true, notifier: opts.notifier } } : undefined);
  g.register(def({ tool_id: toolId, capability_class: opts.cls, idempotent_external: opts.idem ?? false, ...(opts.cls === "D" && opts.notifier ? { class_d_profile: "outbound_message" as const } : {}) }, transport));
  const request = { identity, tool_id: toolId, action: "send", parameters: {}, idempotency_key: key };
  const first = await g.execute(request);
  const replay = await g.execute(request);
  const row = (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null };
  return { first, replay, invokes, row };
}
const UNKNOWN_REPLAY = { ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" };

describe("LOW 1: EKTE HTTP mot en lokal leverandørserver - leverandøren svarte, men transporten kastet: ÉN POST, `unverified`, replay blokkert", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`klasse C, POST + ${status}: nøyaktig ÉN POST nådde leverandøren (redirect-målet får ingenting), raden er unverified og replayet sender ikke på nytt`, async () => {
      const vendor = await startVendor((_req, res) => { res.writeHead(status, { location: "/done" }); res.end(); });
      const r = await runTwiceReal({ cls: "C", mutate: async () => { await guardedFetch(`${vendor.base}/mutate`, { method: "POST", body: "x" }); } });
      expect(String((r.first as { reason: string }).reason)).toBe("tool_failed:outcome_unknown:transport_redirect");
      expect(r.row).toEqual({ status: "unverified", postcondition_reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
      expect(r.replay).toEqual(UNKNOWN_REPLAY);
      expect(vendor.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["POST /mutate"]); // aldri en andre POST, aldri en forespørsel til /done
      expect(r.invokes).toBe(1);
    }, 30_000);
  }

  it("klasse D under håndhevet pipeline, POST + 303 (reviewerens exp): én POST, `unverified`, replay blokkert og eieren varsles NØYAKTIG ÉN gang om UKJENT utfall", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(303, { location: "/done" }); res.end(); });
    const sent: ClassDNotification[] = [];
    const notifier: ClassDNotifier = { ready: () => true, notify: async (n) => { sent.push(n); } };
    const r = await runTwiceReal({ cls: "D", notifier, mutate: async () => { await guardedFetch(`${vendor.base}/mutate`, { method: "POST", body: "x" }); } });
    expect(String((r.first as { reason: string }).reason)).toBe("tool_failed:outcome_unknown:transport_redirect");
    expect(r.row.status).toBe("unverified");
    expect(r.replay).toEqual(UNKNOWN_REPLAY);
    expect(vendor.requests).toHaveLength(1);
    expect(r.invokes).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "send", outcome: "unknown" });
  }, 30_000);

  it("200-svar med uparserbar kropp (`await response.json()` -> SyntaxError): én POST, `unverified` (kind `response`), replay blokkert", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>ok</html>"); });
    const r = await runTwiceReal({ cls: "C", mutate: async () => { const res = await guardedFetch(`${vendor.base}/mutate`, { method: "POST", body: "x" }); await res.json(); } });
    expect(String((r.first as { reason: string }).reason)).toBe("tool_failed:outcome_unknown:transport_response");
    expect(r.row.status).toBe("unverified");
    expect(r.replay).toEqual(UNKNOWN_REPLAY);
    expect(vendor.requests).toHaveLength(1);
    expect(r.invokes).toBe(1);
  }, 30_000);

  it("`jsonRequest` (Infisical/Langfuse-klienten) mot 200 + ikke-JSON kaster `ControlTargetHttpError` med 2xx-status: én POST, `unverified`, replay blokkert", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("created, thanks"); });
    const r = await runTwiceReal({ cls: "C", mutate: async () => { await jsonRequest({ service: "vendor", method: "POST", url: `${vendor.base}/mutate`, body: { a: 1 }, secrets: [] }); } });
    expect(String((r.first as { reason: string }).reason)).toBe("tool_failed:outcome_unknown:transport_response");
    expect(r.row.status).toBe("unverified");
    expect(r.replay).toEqual(UNKNOWN_REPLAY);
    expect(vendor.requests).toHaveLength(1);
  }, 30_000);

  it("kontrast: klasse B (varsler) og IDEMPOTENTE mutasjoner er uendret også for de nye formene - POST + 303 og 200 + uparserbar kropp er `failed` og kan prøves på nytt (2 POST)", async () => {
    const redirecting = await startVendor((_req, res) => { res.writeHead(303, { location: "/done" }); res.end(); });
    const garbled = await startVendor((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>ok</html>"); });
    for (const variant of [{ cls: "B" as const, idem: false }, { cls: "C" as const, idem: true }]) {
      const viaRedirect = await runTwiceReal({ ...variant, mutate: async () => { await guardedFetch(`${redirecting.base}/mutate`, { method: "POST", body: "x" }); } });
      expect(viaRedirect.row.status, `${variant.cls}/${String(variant.idem)} 303`).toBe("failed");
      expect(String((viaRedirect.first as { reason: string }).reason)).toBe("tool_failed:unsafe_vendor_url:unexpected_redirect_http_303");
      expect(viaRedirect.invokes).toBe(2);
      const viaGarbage = await runTwiceReal({ ...variant, mutate: async () => { const res = await guardedFetch(`${garbled.base}/mutate`, { method: "POST", body: "x" }); await res.json(); } });
      expect(viaGarbage.row.status, `${variant.cls}/${String(variant.idem)} garbage`).toBe("failed");
      expect(viaGarbage.invokes).toBe(2);
    }
    expect(redirecting.requests).toHaveLength(4); // 2 varianter x 2 forsøk
    expect(garbled.requests).toHaveLength(4);
  }, 30_000);

  it("kontrast: en eksplisitt AVVISNING (422 fra leverandøren) er IKKE ukjent utfall - raden er `failed`, og samme nøkkel kan prøves på nytt (2 POST)", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(422, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "Validation Failed" })); });
    const r = await runTwiceReal({ cls: "C", mutate: async () => { await jsonRequest({ service: "vendor", method: "POST", url: `${vendor.base}/mutate`, body: { a: 1 }, secrets: [] }); } });
    expect(r.row.status).toBe("failed");
    expect(String((r.first as { reason: string }).reason)).toContain("tool_failed:vendor_error_422");
    expect(vendor.requests).toHaveLength(2);
    expect(r.invokes).toBe(2);
  }, 30_000);

  it("kontrast: en utrygg URL avvist FØR sending (`dot_segment`) sendte ingenting - raden er `failed` og ingen forespørsel nådde serveren", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(200); res.end("{}"); });
    const r = await runTwiceReal({ cls: "C", mutate: async () => { await guardedFetch(`${vendor.base}/files/../admin`, { method: "POST", body: "x" }); } });
    expect(r.row.status).toBe("failed");
    expect(String((r.first as { reason: string }).reason)).toBe("tool_failed:unsafe_vendor_url:dot_segment");
    expect(vendor.requests).toHaveLength(0);
    expect(r.invokes).toBe(2);
  }, 30_000);
});

describe("LOW 1: KJENT GRENSE (runbook §3 «ikke dekket») - festet så en senere endring må oppdatere dokumentasjonen", () => {
  it("en transport som selv omskriver en nettverksfeil til en NY Error uten `cause`/`code` er usynlig for klassifiseringen: `failed`, og replayet sender POST-en en gang til (2 POST)", async () => {
    const vendor = await startVendor((req, res) => { req.socket.destroy(); void res; }); // forespørselen mottas, så rives socketen
    const r = await runTwiceReal({
      cls: "C",
      mutate: async () => {
        try { await fetch(`${vendor.base}/mutate`, { method: "POST", body: "x" }); } catch { throw new Error("vendor_unreachable"); } // omskriving UTEN cause
      }
    });
    expect(r.row.status).toBe("failed");
    expect(vendor.requests).toHaveLength(2);
  }, 30_000);

  it("HTTP 5xx-svar på en mutasjon forblir `failed` (leverandøren svarte; en 5xx kan bety både «utført» og «ikke behandlet»): replayet sender på nytt (2 POST)", async () => {
    const vendor = await startVendor((_req, res) => { res.writeHead(502); res.end(); });
    const r = await runTwiceReal({
      cls: "C",
      mutate: async () => {
        const res = await guardedFetch(`${vendor.base}/mutate`, { method: "POST", body: "x" });
        if (!res.ok) throw new Error(`vendor_error_${res.status}`);
      }
    });
    expect(r.row.status).toBe("failed");
    expect(vendor.requests).toHaveLength(2);
  }, 30_000);
});
