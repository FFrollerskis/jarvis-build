import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requestDigest, type IdentityContext, type JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ToolGateway, assertRequestDigestModeValid, digestForRequest, judgeKeyReuse, requestDigestMode, shortFingerprint,
  type ClassDNotification, type ClassDNotifier, type RequestDigestMode, type ToolDefinition, type ToolTransport
} from "../src/index.ts";

/**
 * WP-T1 K3/K4 (JARVIS-102): `request_digest`, `idempotency_key_reuse_mismatch` og nøkkelkravet - gjennom EN EKTE `ToolGateway` mot embedded Postgres.
 * Moduser: `off` (standard) skal være identisk med main (ingen digest lagres, ingen ny kolonne leses, ingen revisjonsrad, samme-nøkkel-med-annen-nyttelast gir fortsatt det lagrede resultatet),
 * `observe` kjører som før men loggfører «ville avvist», `enforce` avviser og utfører ALDRI.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
const TENANT = "tenant-t1";
const OWNER = "person-owner";
const identity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-t1", device_id: "dev-t1", channel: "api", auth_strength: "active" };
const secrets = { name: "t", get: async () => "cred" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1dg-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_t1dg LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_t1dg");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','T1','person'), ('tenant-t1b','T1B','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner'), ('person-other','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('person-other','${TENANT}');
  `);
  appPool = createPool({ ...base, user: "jarvis_t1dg", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined },
    nonces: { consume: async () => true },
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

afterEach(() => vi.unstubAllEnvs());

/** Teller utføringer per handling; `preflight` er en lesing og teller ikke som mutasjon. */
class Counter implements ToolTransport {
  mutations = 0;
  reads = 0;
  gate: Promise<void> | undefined;
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action === "preflight") { this.reads += 1; return { data: { ok: true } }; }
    this.mutations += 1;
    if (this.gate !== undefined) await this.gate;
    return { external_id: `ext-${this.mutations}` };
  }
}

type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "t1c", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "C", scopes: [], reversible: true, rollback_procedure: "manuelt", idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 10_000,
    credential_ref: "T1_TOKEN", output_trust: "internal", transport
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

function gateway(mode: RequestDigestMode | undefined, defs: ToolDefinition[], extra: { notifier?: ClassDNotifier; pool?: pg.Pool } = {}): ToolGateway {
  const g = new ToolGateway(extra.pool ?? appPool, policy, secrets, undefined, undefined, {
    ...(mode !== undefined ? { requestDigestMode: mode } : {}),
    ...(extra.notifier ? { classDPipeline: { enforce: true, notifier: extra.notifier } } : {})
  });
  for (const d of defs) g.register(d);
  return g;
}

const newKey = (): string => `k-${randomUUID()}`;
const run = (g: ToolGateway, key: string | undefined, parameters: Record<string, JsonValue>, who: IdentityContext = identity, tool = "t1c", action = "mutate") =>
  g.execute({ identity: who, tool_id: tool, action, parameters, ...(key !== undefined ? { idempotency_key: key } : {}) });
const rowOf = async (key: string) =>
  (await adminPool.query("SELECT tool_id, action, status, request_digest, external_id, postcondition_reason FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, key])).rows[0] as
    { tool_id: string; action: string; status: string; request_digest: string | null; external_id: string | null; postcondition_reason: string | null } | undefined;
const auditRows = async (type: string, toolId = "t1c") =>
  (await adminPool.query("SELECT type, decision, reason, payload FROM audit_events WHERE tenant_id = $1 AND tool_id = $2 AND type = $3 ORDER BY at", [TENANT, toolId, type])).rows as Array<{ type: string; decision: string | null; reason: string | null; payload: Record<string, unknown> }>;
/** Revisjonsrader av en type for AKKURAT denne nøkkelen (radene bærer kun et kort avtrykk av nøkkelen). */
const auditForKey = async (type: string, key: string) =>
  (await adminPool.query("SELECT type, decision, reason, capability_class, payload FROM audit_events WHERE tenant_id = $1 AND type = $2 AND payload->>'key_fp' = $3 ORDER BY at", [TENANT, type, shortFingerprint(key)])).rows as
    Array<{ type: string; decision: string | null; reason: string | null; capability_class: string | null; payload: Record<string, unknown> }>;
const digestOf = (parameters: Record<string, JsonValue>, tool = "t1c", action = "mutate", person = OWNER, exclude?: readonly string[]): string =>
  requestDigest({ tool_id: tool, action, parameters, tenant_id: TENANT, person_id: person, ...(exclude ? { exclude_parameters: exclude } : {}) });
/** Setter inn en eldre rad direkte (som en rad skrevet før migrasjon 153 eller under modus off). */
async function seedRow(key: string, status: string, digest: string | null, tool = "t1c", action = "mutate", reason: string | null = null): Promise<void> {
  await adminPool.query(
    "INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, request_digest, postcondition_reason, external_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [TENANT, key, tool, action, status, digest, reason, status === "succeeded" ? "ext-seeded" : null]
  );
}

describe("A: moduser og oppstartsvakt (rene funksjoner)", () => {
  it("kun eksakt observe/enforce slår på (store/små bokstaver og mellomrom ignoreres); alt annet er off", () => {
    for (const [raw, mode] of [["observe", "observe"], ["enforce", "enforce"], [" Enforce ", "enforce"], ["OBSERVE", "observe"], ["off", "off"], ["", "off"], ["on", "off"], ["true", "off"], ["enforced", "off"], ["observ", "off"], ["1", "off"]] as const) {
      expect(requestDigestMode({ JARVIS_TOOL_REQUEST_DIGEST: raw }), raw).toBe(mode);
    }
    expect(requestDigestMode({})).toBe("off");
  });

  it("oppstartsvakten kaster for en satt, ukjent verdi (typo), men ikke for tom/usatt/off/observe/enforce", () => {
    for (const bad of ["enforced", "on", "true", "observer", "1"]) expect(() => assertRequestDigestModeValid({ JARVIS_TOOL_REQUEST_DIGEST: bad }), bad).toThrow(/jarvis_tool_request_digest_invalid/);
    for (const ok of ["", "off", "observe", "enforce", " ENFORCE "]) expect(() => assertRequestDigestModeValid({ JARVIS_TOOL_REQUEST_DIGEST: ok }), ok).not.toThrow();
    expect(() => assertRequestDigestModeValid({})).not.toThrow();
  });

  it("judgeKeyReuse: lik digest = match; ulik = mismatch; NULL = legacy kun når verktøy OG handling er like, ellers mismatch", () => {
    const d1 = "a".repeat(64);
    const d2 = "b".repeat(64);
    expect(judgeKeyReuse({ tool_id: "t", action: "a", request_digest: d1 }, { tool_id: "t", action: "a", digest: d1 })).toBe("match");
    expect(judgeKeyReuse({ tool_id: "t", action: "a", request_digest: d1 }, { tool_id: "t", action: "a", digest: d2 })).toBe("mismatch");
    expect(judgeKeyReuse({ tool_id: "t", action: "a", request_digest: null }, { tool_id: "t", action: "a", digest: d2 })).toBe("legacy");
    expect(judgeKeyReuse({ tool_id: "t", action: "a", request_digest: null }, { tool_id: "t", action: "b", digest: d2 })).toBe("mismatch");
    expect(judgeKeyReuse({ tool_id: "t", action: "a", request_digest: null }, { tool_id: "u", action: "a", digest: d2 })).toBe("mismatch");
  });

  it("digestForRequest feiler aldri (kode i stedet for kast) og bærer verdien aldri", () => {
    const ok = digestForRequest({ tool_id: "t", action: "a", parameters: { x: 1 }, tenant_id: "tn", person_id: "p" });
    expect(ok).toEqual({ ok: true, digest: requestDigest({ tool_id: "t", action: "a", parameters: { x: 1 }, tenant_id: "tn", person_id: "p" }) });
    expect(digestForRequest({ tool_id: "t", action: "a", parameters: { x: Number.NaN }, tenant_id: "tn", person_id: "p" })).toEqual({ ok: false, code: "non_finite_number" });
    expect(digestForRequest({ tool_id: "", action: "a", parameters: {}, tenant_id: "tn", person_id: "p" })).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("B: modus off (standard) = main", () => {
  it("samme nøkkel med ANNEN nyttelast gir fortsatt det lagrede resultatet (JARVIS-102 bevart i off): én mutasjon, deduplicated:true, ingen digest lagret, ingen revisjonsrad", async () => {
    const t = new Counter();
    const g = gateway("off", [def({}, t)]);
    const key = newKey();
    const first = await run(g, key, { amount: 1 });
    expect(first).toMatchObject({ ok: true, deduplicated: false });
    const second = await run(g, key, { amount: 999 });
    expect(second).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(1);
    expect((await rowOf(key))?.request_digest).toBeNull();
    for (const type of ["tool.idempotency_key_reuse_mismatch", "tool.idempotency_key_reuse_observed", "tool.idempotency_legacy_row", "tool.idempotency_key_missing_observed", "tool.request_digest_invalid_observed"]) {
      expect(await auditForKey(type, key), type).toEqual([]);
    }
  });

  it("ingen digest beregnes og ingen ny kolonne leses/skrives: SQL-en er den gamle (INSERT uten request_digest, SELECT uten tool_id/request_digest)", async () => {
    const sql: string[] = [];
    const spy = {
      connect: async () => {
        const client = await appPool.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => { if (typeof a[0] === "string") sql.push(a[0]); return original(...a); };
        return client;
      }
    } as unknown as pg.Pool;
    const t = new Counter();
    const g = gateway("off", [def({}, t)], { pool: spy });
    const key = newKey();
    await run(g, key, { amount: 1 });
    await run(g, key, { amount: 1 });
    const text = sql.join("\n");
    expect(text).toContain("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state)");
    expect(text).toContain("SELECT external_id, status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1");
    expect(text).not.toContain("request_digest");
  });

  it("en forespørsel som ikke kan få digest (Infinity passerer Policy Gateway sitt skjema) kjører som før i off - ingen RequestDigestError, ingen avvisning", async () => {
    const t = new Counter();
    const g = gateway("off", [def({}, t)]);
    const key = newKey();
    expect(await run(g, key, { amount: Number.POSITIVE_INFINITY })).toMatchObject({ ok: true });
    expect(t.mutations).toBe(1);
    expect((await rowOf(key))?.request_digest).toBeNull();
  });

  it("NaN stoppes av Policy Gateway (`invalid_tool_call`) i ALLE moduser - før og etter WP-T1 (digesten er ikke første forsvar)", async () => {
    for (const mode of ["off", "observe", "enforce"] as const) {
      const t = new Counter();
      const g = gateway(mode, [def({}, t)]);
      expect(await run(g, newKey(), { amount: Number.NaN }), mode).toEqual({ ok: false, reason: "invalid_tool_call" });
      expect(t.mutations).toBe(0);
    }
  });

  it("et manglende nøkkelkrav (`required` uten nøkkel) er ikke i bruk i off: utføres uten ledger", async () => {
    const t = new Counter();
    const g = gateway("off", [def({ idempotency: "required" }, t)]);
    expect(await run(g, undefined, { a: 1 })).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(1);
  });

  it("modus leses fra miljøet når ingen eksplisitt modus er gitt (JARVIS_TOOL_REQUEST_DIGEST ved hvert kall); standard er off", async () => {
    const t = new Counter();
    const g = gateway(undefined, [def({}, t)]);
    const k1 = newKey();
    await run(g, k1, { a: 1 });
    expect((await rowOf(k1))?.request_digest).toBeNull();
    vi.stubEnv("JARVIS_TOOL_REQUEST_DIGEST", "enforce");
    const k2 = newKey();
    await run(g, k2, { a: 1 });
    expect((await rowOf(k2))?.request_digest).toBe(digestOf({ a: 1 }));
    expect(await run(g, k2, { a: 2 })).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
  });
});

describe("C: modus observe - kjører som før, men loggfører «ville avvist»", () => {
  it("digesten lagres på nye rader (kanonisk, uavhengig av nøkkelrekkefølge og idempotency_key i parametrene)", async () => {
    const g = gateway("observe", [def({}, new Counter())]);
    const key = newKey();
    await run(g, key, { b: [1, { y: 2, x: 1 }], a: "tekst", idempotency_key: key });
    expect((await rowOf(key))?.request_digest).toBe(digestOf({ a: "tekst", b: [1, { x: 1, y: 2 }] }));
  });

  it("samme nøkkel + SAMME forespørsel (annen nøkkelrekkefølge): deduplicated, ingen observasjonsrad", async () => {
    const t = new Counter();
    const g = gateway("observe", [def({}, t)]);
    const key = newKey();
    await run(g, key, { a: 1, b: 2 });
    expect(await run(g, key, { b: 2, a: 1 })).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(1);
    expect(await auditForKey("tool.idempotency_key_reuse_observed", key)).toEqual([]);
    expect(await auditForKey("tool.idempotency_legacy_row", key)).toEqual([]);
  });

  it("samme nøkkel + ANNEN nyttelast: kjører som main (lagret resultat, deduplicated:true, én mutasjon) MEN en observasjonsrad (ALLOW, would_reject) er skrevet", async () => {
    const t = new Counter();
    const g = gateway("observe", [def({}, t)]);
    const key = newKey();
    await run(g, key, { amount: 1 });
    const second = await run(g, key, { amount: 2 });
    expect(second).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(1);
    const rows = await auditForKey("tool.idempotency_key_reuse_observed", key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "ALLOW", reason: "idempotency_key_reuse_mismatch" });
    expect(rows[0]?.payload).toMatchObject({ mode: "observe", would_reject: true, stored_tool_id: "t1c", stored_action: "mutate", stored_status: "succeeded" });
  });

  it("legacy-rad (NULL-digest) med samme verktøy/handling: som main + en `tool.idempotency_legacy_row`-rad; med annen handling: observert mismatch", async () => {
    const t = new Counter();
    const g = gateway("observe", [def({}, t), def({ action: "mutate2" }, t)]);
    const key = newKey();
    await seedRow(key, "succeeded", null);
    expect(await run(g, key, { a: 1 })).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(0);
    expect(await auditForKey("tool.idempotency_legacy_row", key)).toHaveLength(1);
    const key2 = newKey();
    await seedRow(key2, "succeeded", null);
    expect(await run(g, key2, { a: 1 }, identity, "t1c", "mutate2")).toMatchObject({ ok: true, deduplicated: true });
    const observed = await auditForKey("tool.idempotency_key_reuse_observed", key2);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload).toMatchObject({ would_reject: true, stored_digest_fp: null });
  });

  it("en forespørsel som ikke kan få digest (Infinity): kjører, raden får NULL, og en `tool.request_digest_invalid_observed`-rad skrives", async () => {
    const t = new Counter();
    const g = gateway("observe", [def({}, t)]);
    const key = newKey();
    expect(await run(g, key, { amount: Number.POSITIVE_INFINITY })).toMatchObject({ ok: true });
    expect((await rowOf(key))?.request_digest).toBeNull();
    const rows = await auditForKey("tool.request_digest_invalid_observed", key);
    expect(rows.map((r) => [r.reason, r.decision])).toEqual([["request_digest_invalid:non_finite_number", "ALLOW"]]);
  });

  it("nøkkelkravet: `required` uten nøkkel kjører (uten ledger) men gir `tool.idempotency_key_missing_observed`", async () => {
    const t = new Counter();
    const g = gateway("observe", [def({ tool_id: "t1req", idempotency: "required" }, t)]);
    expect(await run(g, undefined, { a: 1 }, identity, "t1req")).toMatchObject({ ok: true });
    expect(t.mutations).toBe(1);
    const rows = await auditRows("tool.idempotency_key_missing_observed", "t1req");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ decision: "ALLOW", reason: "idempotency_key_required" });
  });

  it("en feil i observasjons-revisjonen bryter aldri kallet (best-effort)", async () => {
    const t = new Counter();
    let connects = 0;
    // Første tilkobling (observasjonens revisjonsrad) feiler; resten (selve kallet) går mot den ekte databasen.
    const flaky = { connect: async () => { connects += 1; if (connects === 1) throw new Error("pool_down"); return appPool.connect(); } } as unknown as pg.Pool;
    const g = gateway("observe", [def({ tool_id: "t1req2", idempotency: "required" }, t)], { pool: flaky });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await run(g, undefined, { a: 1 }, identity, "t1req2");
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    errors.mockRestore();
    expect(result).toMatchObject({ ok: true });
    expect(t.mutations).toBe(1);
    expect(logged).toContain("tool_observation_audit_failed");
  });
});

describe("D: modus enforce - avviser, og utfører ALDRI", () => {
  it("lik forespørsel = deduplicated (én mutasjon); stabil mot nøkkelrekkefølge og idempotency_key i parametrene", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t)]);
    const key = newKey();
    expect(await run(g, key, { a: 1, nested: { y: 2, x: 1 } })).toMatchObject({ ok: true, deduplicated: false });
    expect(await run(g, key, { nested: { x: 1, y: 2 }, a: 1, idempotency_key: "annet-i-parametrene" })).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(1);
  });

  it("ANNEN nyttelast: `idempotency_key_reuse_mismatch` (ikke ok, ikke deduplicated), transporten kalles ikke igjen, raden er urørt, og en DENY-revisjonsrad er skrevet", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t)]);
    const key = newKey();
    await run(g, key, { amount: 100 });
    const before = await rowOf(key);
    const second = await run(g, key, { amount: 200 });
    expect(second).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(t.mutations).toBe(1);
    expect(await rowOf(key)).toEqual(before);
    expect(before?.status).toBe("succeeded");
    expect(before?.request_digest).toBe(digestOf({ amount: 100 }));
    const rows = await auditForKey("tool.idempotency_key_reuse_mismatch", key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "DENY", reason: "idempotency_key_reuse_mismatch", capability_class: "C" });
    expect(rows[0]?.payload).toMatchObject({ mode: "enforce", stored_status: "succeeded", stored_tool_id: "t1c", stored_action: "mutate" });
  });

  it("revisjonsraden bærer aldri nøkkelen, parametrene eller en full digest (kun korte avtrykk)", async () => {
    const g = gateway("enforce", [def({}, new Counter())]);
    const key = `k-${randomUUID()}-hemmelig-markor`;
    await run(g, key, { memo: "sensitiv-tekst-1" });
    await run(g, key, { memo: "sensitiv-tekst-2" });
    const all = (await adminPool.query("SELECT payload::text AS p, coalesce(reason, '') AS r FROM audit_events WHERE tenant_id = $1 AND type = 'tool.idempotency_key_reuse_mismatch'", [TENANT])).rows as Array<{ p: string; r: string }>;
    const text = all.map((r) => `${r.p} ${r.r}`).join("\n");
    expect(text).not.toContain("hemmelig-markor");
    expect(text).not.toContain("sensitiv-tekst");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("verktøy, handling, tenant-aktør (person) og hver parameter inngår: annen handling, annet verktøy og annen person under samme nøkkel avvises", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t), def({ action: "mutate2" }, t), def({ tool_id: "t1d" }, t), def({ capability_class: "B", tool_id: "t1b" }, t)]);
    const key = newKey();
    await run(g, key, { a: 1 });
    expect(await run(g, key, { a: 1 }, identity, "t1c", "mutate2")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(await run(g, key, { a: 1 }, identity, "t1d", "mutate")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    // Annen person i SAMME tenant (klasse B: ingen mandatkrav) - samme nøkkel og parametre er likevel en annen forespørsel.
    const keyB = newKey();
    const other: IdentityContext = { ...identity, person_id: "person-other", session_id: "sess-other" };
    expect(await run(g, keyB, { a: 1 }, identity, "t1b")).toMatchObject({ ok: true, deduplicated: false });
    expect(await run(g, keyB, { a: 1 }, other, "t1b")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(await run(g, keyB, { a: 1 }, identity, "t1b")).toMatchObject({ ok: true, deduplicated: true });
    expect(t.mutations).toBe(2);
  });

  it("avvises UAVHENGIG av radens status: unverified, failed (ingen re-arm), reserved (ikke «in flight»-svaret) - transporten kalles aldri", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t)]);
    for (const status of ["unverified", "failed", "reserved", "succeeded"]) {
      const key = newKey();
      await seedRow(key, status, digestOf({ amount: 1 }), "t1c", "mutate", status === "unverified" ? "postcondition_unverified:no_provider_id" : null);
      expect(await run(g, key, { amount: 2 }), status).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
      expect((await rowOf(key))?.status, status).toBe(status);
    }
    expect(t.mutations).toBe(0);
  });

  it("samme digest beholder de eksisterende statusgrenene: unverified = lagret årsak, reserved = in flight, failed = re-arm og utfør, succeeded = deduplicated", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t)]);
    const same = { amount: 1 };
    const unverified = newKey(); await seedRow(unverified, "unverified", digestOf(same), "t1c", "mutate", "postcondition_unverified:no_provider_id");
    expect(await run(g, unverified, same)).toEqual({ ok: false, reason: "postcondition_unverified:no_provider_id" });
    const reserved = newKey(); await seedRow(reserved, "reserved", digestOf(same));
    expect(await run(g, reserved, same)).toEqual({ ok: false, reason: "execution_in_flight_or_outcome_unknown" });
    const succeeded = newKey(); await seedRow(succeeded, "succeeded", digestOf(same));
    expect(await run(g, succeeded, same)).toMatchObject({ ok: true, deduplicated: true, external_id: "ext-seeded" });
    expect(t.mutations).toBe(0);
    const failed = newKey(); await seedRow(failed, "failed", digestOf(same), "t1c", "mutate", "tool_failed:x");
    expect(await run(g, failed, same)).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(1);
    expect((await rowOf(failed))?.status).toBe("succeeded");
    expect((await rowOf(failed))?.request_digest).toBe(digestOf(same));
  });

  it("legacy-rad (NULL): samme verktøy/handling = som i dag (+ loggført); ANNEN handling eller annet verktøy = sikkert avvik og avvises", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t), def({ action: "mutate2" }, t), def({ tool_id: "t1d" }, t)]);
    const key = newKey();
    await seedRow(key, "succeeded", null);
    expect(await run(g, key, { x: 1 })).toMatchObject({ ok: true, deduplicated: true, external_id: "ext-seeded" });
    expect(await run(g, key, { x: 2 })).toMatchObject({ ok: true, deduplicated: true }); // nyttelasten kan ikke sammenlignes (ingen digest lagret)
    expect(await run(g, key, { x: 1 }, identity, "t1c", "mutate2")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(await run(g, key, { x: 1 }, identity, "t1d", "mutate")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(t.mutations).toBe(0);
    expect(await auditForKey("tool.idempotency_legacy_row", key)).toHaveLength(2);
  });

  it("samtidige kall med samme nøkkel og ULIK nyttelast: nøyaktig ÉN utføres, den andre får idempotency_key_reuse_mismatch (uavhengig av tidsluken)", async () => {
    const t = new Counter();
    let release!: () => void;
    t.gate = new Promise<void>((resolve) => { release = resolve; });
    const g = gateway("enforce", [def({}, t)]);
    const key = newKey();
    const first = run(g, key, { amount: 1 });
    // La første kall nå reservasjonen og stå midt i leverandørkallet.
    for (let i = 0; i < 200 && t.mutations === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(t.mutations).toBe(1);
    expect(await run(g, key, { amount: 2 })).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(await run(g, key, { amount: 1 })).toEqual({ ok: false, reason: "execution_in_flight_or_outcome_unknown" });
    release();
    expect(await first).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(1);
  });

  it("en forespørsel som ikke er ren JSON (men passerer Policy Gateway) avvises FØR noe skjer: request_digest_invalid:<kode>, ingen ledger-rad, ingen mutasjon, `tool.denied` med koden", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({ tool_id: "t1inv" }, t)]);
    class Marker { value = 1; }
    const lone = String.fromCharCode(0xd800);
    const deep = (n: number): Record<string, JsonValue> => { let o: Record<string, JsonValue> = { leaf: 1 }; for (let i = 0; i < n; i += 1) o = { k: o }; return o; };
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: () => 1 }) as Record<string, JsonValue>;
    const cases: Array<[Record<string, JsonValue>, string]> = [
      [{ a: Number.POSITIVE_INFINITY }, "non_finite_number"],
      [{ a: Number.NEGATIVE_INFINITY }, "non_finite_number"],
      [{ a: `x${lone}y` }, "lone_surrogate"],
      [{ a: new Marker() as unknown as JsonValue }, "unsupported_type"],
      [{ a: accessor }, "unsupported_type"],
      [deep(70), "too_deep"]
    ];
    for (const [params, code] of cases) {
      const key = newKey();
      expect(await run(g, key, params, identity, "t1inv"), code).toEqual({ ok: false, reason: `request_digest_invalid:${code}` });
      expect(await rowOf(key)).toBeUndefined();
    }
    expect(t.mutations).toBe(0);
    const denied = await auditRows("tool.denied", "t1inv");
    expect(denied.map((r) => r.reason)).toEqual(expect.arrayContaining(["request_digest_invalid:non_finite_number", "request_digest_invalid:lone_surrogate", "request_digest_invalid:unsupported_type", "request_digest_invalid:too_deep"]));
  });

  it("klasse A (ren lesing) har ingen ledger og dermed ingen digest, selv med nøkkel og `required`-feilmerking", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({ tool_id: "t1read", capability_class: "A", idempotency: "required" }, t)]);
    const key = newKey();
    expect(await run(g, key, { q: Number.POSITIVE_INFINITY }, identity, "t1read")).toMatchObject({ ok: true });
    expect(await run(g, undefined, { q: 1 }, identity, "t1read")).toMatchObject({ ok: true });
    expect(await rowOf(key)).toBeUndefined();
  });

  it("per-definisjon-utelatelse: en endring KUN i et utelatt felt gir ikke mismatch (og ikke i digesten), en endring i et annet felt gir", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({ tool_id: "t1sec", digest_exclude_parameters: ["value"] }, t)]);
    const key = newKey();
    await run(g, key, { ref: "R", value: "s1" }, identity, "t1sec");
    expect((await rowOf(key))?.request_digest).toBe(digestOf({ ref: "R" }, "t1sec", "mutate", OWNER));
    expect(await run(g, key, { ref: "R", value: "s2" }, identity, "t1sec")).toMatchObject({ ok: true, deduplicated: true });
    expect(await run(g, key, { ref: "R2", value: "s1" }, identity, "t1sec")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
  });

  it("tenant-isolasjon: samme nøkkel i en ANNEN tenant er en egen rad (ingen mismatch på tvers)", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({}, t)]);
    const key = newKey();
    await run(g, key, { a: 1 });
    await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, 'tenant-t1b') ON CONFLICT DO NOTHING", [OWNER]);
    const gb = new ToolGateway(appPool, new PolicyGateway({ devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: ["tenant-t1b"] } }), secrets, undefined, undefined, { requestDigestMode: "enforce" });
    gb.register(def({}, t));
    expect(await run(gb, key, { a: 999 }, { ...identity, tenant_id: "tenant-t1b" })).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(2);
  });
});

describe("E: nøkkelkravet (K4) i enforce", () => {
  it("`required` uten nøkkel (også tom streng) avvises `idempotency_key_required` FØR noe utføres; med nøkkel går det", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({ tool_id: "t1req", idempotency: "required" }, t)]);
    expect(await run(g, undefined, { a: 1 }, identity, "t1req")).toEqual({ ok: false, reason: "idempotency_key_required" });
    expect(await run(g, "", { a: 1 }, identity, "t1req")).toEqual({ ok: false, reason: "idempotency_key_required" });
    expect(t.mutations).toBe(0);
    const denied = await auditRows("tool.denied", "t1req");
    expect(denied.filter((r) => r.reason === "idempotency_key_required").length).toBe(2);
    expect(await run(g, newKey(), { a: 1 }, identity, "t1req")).toMatchObject({ ok: true });
    expect(t.mutations).toBe(1);
  });

  it("`optional`, `none` og uten felt krever ikke nøkkel (som i dag): kallet utføres uten ledger", async () => {
    const t = new Counter();
    const g = gateway("enforce", [def({ tool_id: "t1o", idempotency: "optional" }, t), def({ tool_id: "t1n", idempotency: "none" }, t), def({ tool_id: "t1u" }, t)]);
    for (const tool of ["t1o", "t1n", "t1u"]) expect(await run(g, undefined, { a: 1 }, identity, tool), tool).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(3);
  });

  it("nødbrytere og selvgjenopprettings-handlinger krever ALDRI nøkkel, selv om en definisjon er (feil)merket `required`", async () => {
    const t = new Counter();
    const g = gateway("enforce", [
      def({ tool_id: "executive", action: "deactivate_kill_switch", capability_class: "D", idempotency: "required" }, t),
      def({ tool_id: "owner_controls", action: "restore_credential", capability_class: "C", idempotency: "required" }, t)
    ]);
    expect(await run(g, undefined, {}, identity, "executive", "deactivate_kill_switch")).toMatchObject({ ok: true });
    expect(await run(g, undefined, { credential_ref: "X" }, identity, "owner_controls", "restore_credential")).toMatchObject({ ok: true });
    expect(t.mutations).toBe(2);
    expect((await auditRows("tool.denied", "executive")).filter((r) => r.reason === "idempotency_key_required")).toEqual([]);
  });

  it("klasse D under håndhevet pipeline: den eksisterende `class_d_idempotency_key_required` har forrang (samme kode som før), og et avvist duplikat sender ikke eier-varsel", async () => {
    const t = new Counter();
    const notifier = new FakeNotifier();
    const dDef = def({ tool_id: "t1d2", capability_class: "D", idempotency: "required", preflight_action: "preflight", preflight_requires_target: true, postcondition_predicate: (after) => (after as { ok?: boolean }).ok === true }, t);
    const g = gateway("enforce", [dDef], { notifier });
    expect(await run(g, undefined, { a: 1 }, identity, "t1d2")).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    const key = newKey();
    expect(await run(g, key, { a: 1 }, identity, "t1d2")).toMatchObject({ ok: true, deduplicated: false });
    const notified = notifier.sent.length;
    expect(notified).toBe(1);
    expect(await run(g, key, { a: 2 }, identity, "t1d2")).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(notifier.sent.length).toBe(notified);
    expect(t.mutations).toBe(1);
  });
});
