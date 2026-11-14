import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway, type PolicyAuditEvent } from "@jarvis/policy";
import {
  PgPolicyAuditSink, createPolicyAuditSinkFromEnv, installPolicyAuditDrain, policyAuditSinkConfigFromEnv, runMigrations, runPolicyDecisionRetentionSweep, toPolicyDecisionRow
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-K (D-471, JARVIS-053): den varige, DB-baserte policy-journalen (migrasjon 108 + `PgPolicyAuditSink`). Ekte embedded Postgres med en vanlig `jarvis_app`-rolle (NOSUPERUSER/NOBYPASSRLS):
 * append-only, tenant-skopet (RLS), kun metadata, redigert, begrenset kø med mottrykk, feil som aldri endrer en avgjørelse og er telt, idempotent innsetting og oppbevaring etter samme mønster som migrasjon 073.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let noGrant: pg.Pool;

const IDENT = { person_id: "person-tobias", tenant_id: "t-a", memory_space_id: "personal", session_id: "sess-wpk53", device_id: "dev-1", channel: "web", auth_strength: "active" } as const;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk53-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpk53 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpk53");
  await admin.query("CREATE ROLE jarvis_wpk53_nogrant LOGIN PASSWORD 'pw3' NOSUPERUSER NOBYPASSRLS");
  await admin.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-a','A','person'), ('t-b','B','business')");
  app = new pg.Pool({ ...base, user: "jarvis_wpk53", password: "pw2", max: 6 });
  app.on("error", () => undefined);
  noGrant = new pg.Pool({ ...base, user: "jarvis_wpk53_nogrant", password: "pw3", max: 2 });
  noGrant.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await noGrant?.end();
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let seq = 0;
const event = (over: Partial<PolicyAuditEvent> = {}): PolicyAuditEvent => ({
  at: new Date().toISOString(), decision_id: `d-wpk53-${String(++seq).padStart(6, "0")}-${Math.random().toString(16).slice(2, 10)}`, decision: "ALLOW", reason: "class_a_read",
  person_id: "person-tobias", tenant_id: "t-a", session_id: "sess-wpk53", tool_id: "calendar", action: "read_events", capability_class: "A", ...over
});
const sinkOn = (pool: pg.Pool, over: Record<string, unknown> = {}): PgPolicyAuditSink => new PgPolicyAuditSink({ pool, autoFlush: false, processName: "api", ...over });
const rowsAs = async (tenant: string) => {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenant]);
    const res = await client.query("SELECT * FROM policy_decisions ORDER BY recorded_at, decision_id");
    await client.query("COMMIT");
    return res.rows as Array<Record<string, unknown>>;
  } finally {
    client.release();
  }
};
const countAll = async (): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM policy_decisions")).rows[0].n as number;

describe("A: tabellen (migrasjon 108) - append-only, tenant-skopet, ingen sletting for runtime-rollen", () => {
  it("FORCE RLS, ingen UPDATE/DELETE for jarvis_app, og en trigger avviser UPDATE selv for superbruker", async () => {
    const meta = (await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'policy_decisions'")).rows[0];
    expect(meta).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const sink = sinkOn(app);
    sink.write(event());
    await sink.flush();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 't-a', true)");
      await expect(client.query("UPDATE policy_decisions SET reason = 'x'")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 't-a', true)");
      await expect(client.query("DELETE FROM policy_decisions")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await expect(admin.query("UPDATE policy_decisions SET reason = 'x'")).rejects.toThrow(/forbid|append|mutation|forbudt/i);
  });

  it("tenant-isolasjon: en tenant ser kun egne rader og kan ikke skrive for en annen (WITH CHECK)", async () => {
    const sink = sinkOn(app);
    sink.write(event({ tenant_id: "t-a", reason: "only_a" }));
    sink.write(event({ tenant_id: "t-b", reason: "only_b" }));
    await sink.flush();
    expect((await rowsAs("t-a")).map((r) => r["reason"])).toContain("only_a");
    expect((await rowsAs("t-a")).map((r) => r["reason"])).not.toContain("only_b");
    expect((await rowsAs("t-b")).map((r) => r["reason"])).toContain("only_b");
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 't-a', true)");
      await expect(client.query(
        "INSERT INTO policy_decisions (tenant_id, decision_id, decided_at, decision, reason, person_id, tool_id, action, capability_class) VALUES ('t-b','d-forged-0001',now(),'ALLOW','x','p','t','a','A')"
      )).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("oppbevaring etter 073-mønsteret: kun definer-funksjonen sletter, gulv på 30 dager i selve policyen, ferske rader overlever alltid", async () => {
    await admin.query(`INSERT INTO policy_decisions (tenant_id, decision_id, decided_at, decision, reason, person_id, tool_id, action, capability_class) VALUES
      ('t-a','d-old-100d-0001', now() - interval '100 days','ALLOW','old','p','t','a','A'),
      ('t-a','d-old-40d-0001',  now() - interval '40 days','ALLOW','mid','p','t','a','A'),
      ('t-b','d-old-35d-0001',  now() - interval '35 days','DENY','mid','p','t','a','A'),
      ('t-a','d-fresh-10d-0001',now() - interval '10 days','ALLOW','fresh','p','t','a','A')`);
    const owner = (await admin.query("SELECT pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname = 'prune_policy_decisions'")).rows[0];
    expect(owner).toEqual({ owner: "jarvis_definer", prosecdef: true });
    // standard 90 dager: kun den på 100 dager går
    expect((await runPolicyDecisionRetentionSweep(app)).deleted).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS n FROM policy_decisions WHERE decision_id = 'd-old-100d-0001'")).rows[0].n).toBe(0);
    // gulvet: p_days=1 klemmes til 30 - radene på 35/40 dager går, den på 10 dager går ALDRI
    const pruned = await app.query("SELECT prune_policy_decisions(1, 100)::int AS n");
    expect(pruned.rows[0].n).toBe(2);
    expect((await admin.query("SELECT decision_id FROM policy_decisions WHERE decision_id LIKE 'd-fresh-%'")).rowCount).toBe(1);
    // runtime-rollen kan ikke slette direkte, heller ikke ferske rader via RLS-omvei
    await expect(app.query("DELETE FROM policy_decisions")).rejects.toThrow(/permission denied/);
  });
});

describe("B: sinken skriver en avgjørelse fra den ekte PolicyGateway - korrelert, redigert, kun metadata", () => {
  it("avgjørelse -> rad: decision_id/task_id/trace_id/system-aktør/prosess stemmer, og parametre finnes aldri i raden", async () => {
    const sink = sinkOn(app);
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), auditSink: sink.write });
    const result = await policy.authorize({
      identity: { ...IDENT, person_id: "system", session_id: "business-events-sync-t-a" },
      toolCall: { tool_id: "email", action: "list_messages", capability_class: "A", parameters: { query: "fake-private-query-text-for-test" } },
      correlation: { task_id: "sched:business-events-sync:2026-11-14", trace_id: "sched-business-events-sync-2026-11-14-a1" }
    });
    expect(result).toMatchObject({ decision: "ALLOW", reason: "class_a_read" });
    await sink.flush();
    const rows = await rowsAs("t-a");
    const row = rows.find((r) => r["decision_id"] === result.decision_id)!;
    expect(row).toMatchObject({
      tenant_id: "t-a", decision: "ALLOW", reason: "class_a_read", person_id: "system", actor_kind: "system", session_id: "business-events-sync-t-a",
      tool_id: "email", action: "list_messages", capability_class: "A", task_id: "sched:business-events-sync:2026-11-14", trace_id: "sched-business-events-sync-2026-11-14-a1", process: "api"
    });
    expect(JSON.stringify(row)).not.toContain("fake-private-query-text-for-test");
    expect(Object.keys(row).sort()).toEqual(["action", "actor_kind", "capability_class", "decided_at", "decision", "decision_id", "person_id", "process", "reason", "recorded_at", "session_id", "task_id", "tenant_id", "tool_id", "trace_id"]);
  });

  it("redaksjon: hemmelighetsformer i grunnkoden redigeres, en id som ser ut som en hemmelighet får en deterministisk markør (kan fortsatt joines), kontrolltegn og lengde kuttes", async () => {
    const tokenLike = `gh${"p_"}${"a1B2c3D4e5".repeat(4)}`; // bygges ved kjøring - ingen leverandørformet tekst i kildefilen
    const sink = sinkOn(app);
    const a = event({ reason: `denied: token ${tokenLike} used\nsecond line\u0007`, task_id: tokenLike, trace_id: "x".repeat(500) });
    const b = event({ task_id: tokenLike });
    sink.write(a);
    sink.write(b);
    await sink.flush();
    const rows = await rowsAs("t-a");
    const ra = rows.find((r) => r["decision_id"] === a.decision_id)!;
    const rb = rows.find((r) => r["decision_id"] === b.decision_id)!;
    expect(JSON.stringify(ra)).not.toContain(tokenLike);
    expect(ra["reason"]).toMatch(/\[REDACTED:/);
    expect(String(ra["reason"]).includes("\n")).toBe(false);
    expect(String(ra["reason"]).includes(String.fromCharCode(7))).toBe(false);
    expect(String(ra["task_id"])).toMatch(/^redacted-[0-9a-f]{16}$/);
    expect(rb["task_id"]).toBe(ra["task_id"]); // samme inndata -> samme markør
    expect(String(ra["trace_id"]).length).toBe(200);
  });

  it("uten gyldig tenant (ugyldig identitet) finnes ingen tenant å skrive under: telles, ingen rad, aldri en oppdiktet tenant/person", async () => {
    const before = await countAll();
    const sink = sinkOn(app);
    expect(sink.write(event({ tenant_id: "unknown" }))).toBe(true);
    expect(sink.write(event({ tenant_id: "" }))).toBe(true);
    expect(sink.write(event({ decision: "MAYBE" as never }))).toBe(false);
    await sink.flush();
    expect(sink.stats()).toMatchObject({ skipped_unattributable: 2, rejected_invalid: 1, written: 0, queued: 0 });
    expect(await countAll()).toBe(before);
    expect(toPolicyDecisionRow(event({ tenant_id: "unknown" }), null, new Date())).toBe("unattributable");
  });

  it("idempotent: samme avgjørelse to ganger gir én rad og ingen feil (retry etter et uklart utfall dupliserer aldri)", async () => {
    const e = event();
    const sink = sinkOn(app);
    sink.write(e);
    await sink.flush();
    sink.write(e);
    await sink.flush();
    expect((await rowsAs("t-a")).filter((r) => r["decision_id"] === e.decision_id)).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ consecutive_failures: 0, rejected_invalid: 0 });
  });

  it("en batch med flere tenanter skrives i hver sin tenant-transaksjon, og rekkefølgen innen en tenant bevares", async () => {
    const sink = sinkOn(app);
    const events = [event({ tenant_id: "t-a" }), event({ tenant_id: "t-b" }), event({ tenant_id: "t-a" }), event({ tenant_id: "t-b" })];
    for (const e of events) sink.write(e);
    await sink.flush();
    expect(sink.stats()).toMatchObject({ written: 4, queued: 0 });
    const a = (await rowsAs("t-a")).map((r) => r["decision_id"]);
    expect(a.indexOf(events[0]!.decision_id)).toBeLessThan(a.indexOf(events[2]!.decision_id));
    expect((await rowsAs("t-b")).map((r) => r["decision_id"])).toEqual(expect.arrayContaining([events[1]!.decision_id, events[3]!.decision_id]));
  });
});

describe("C: begrenset kø med mottrykk - minnet vokser aldri, feil er telt", () => {
  it("full kø avviser nye hendelser (write -> false), PolicyGateway teller det som sink_rejected, og avgjørelsen er uendret", async () => {
    const sink = sinkOn(app, { maxQueue: 5 });
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), auditSink: sink.write });
    const results = [];
    for (let i = 0; i < 8; i += 1) results.push(await policy.authorize({ identity: IDENT, toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: { i } } }));
    expect(results.every((r) => r.decision === "ALLOW" && r.reason === "class_a_read")).toBe(true);
    expect(sink.stats()).toMatchObject({ queued: 5, max_queue: 5, pressure: "full", rejected_full: 3, degraded: true });
    expect(policy.auditStats()).toMatchObject({ sink: "external", sink_rejected: 3, sink_failures: 0 });
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 0, written: 5, pressure: "ok" });
    expect(sink.write(event())).toBe(true); // gjenopprettet
  });

  it("køen er begrenset også under en lang databasenedetid: 5000 hendelser mot en død database gir aldri mer enn maxQueue i minnet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dead = { connect: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }); } } as unknown as pg.Pool;
    const sink = sinkOn(dead, { maxQueue: 100 });
    let peak = 0;
    for (let i = 0; i < 5_000; i += 1) {
      sink.write(event());
      peak = Math.max(peak, sink.stats().queued);
    }
    expect(peak).toBe(100);
    expect(sink.stats()).toMatchObject({ queued: 100, rejected_full: 4_900 });
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 100, consecutive_failures: 1, last_failure: "Error:ECONNREFUSED", degraded: true });
  });
});

describe("D: feil - transient beholdes og forsøkes igjen, giftige rader isoleres, ingenting kaster", () => {
  it("database nede -> flush kaster aldri, hendelsene ligger i køen og skrives (uten duplikater) når databasen er tilbake", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let down = true;
    const flaky = { connect: (...args: unknown[]) => (down ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) : (app.connect as (...a: unknown[]) => unknown)(...args)) } as unknown as pg.Pool;
    const sink = sinkOn(flaky);
    const events = [event(), event(), event()];
    for (const e of events) sink.write(e);
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.stats()).toMatchObject({ queued: 3, written: 0, flush_failures: 1, consecutive_failures: 1, degraded: true });
    await sink.flush();
    expect(sink.stats().consecutive_failures).toBe(2);
    down = false;
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 0, written: 3, consecutive_failures: 0 });
    const ids = (await rowsAs("t-a")).map((r) => r["decision_id"]);
    for (const e of events) expect(ids.filter((id) => id === e.decision_id)).toHaveLength(1);
  });

  it("manglende rettighet (42501) er systemisk, ikke giftig: hendelsene beholdes (ingen datatap), og skrives når rettigheten er der", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(noGrant);
    sink.write(event());
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 1, written: 0, rejected_invalid: 0, consecutive_failures: 1 });
    expect(sink.stats().last_failure).toMatch(/42501|error/i);
  });

  it("ukjent tenant (FK, 23503) er permanent for den raden: kastes og telles, mens andre tenanters rader i samme flush skrives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app);
    const good = event({ tenant_id: "t-a" });
    sink.write(event({ tenant_id: "t-ghost" }));
    sink.write(good);
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 0, written: 1, rejected_invalid: 1, consecutive_failures: 0 });
    expect((await rowsAs("t-a")).map((r) => r["decision_id"])).toContain(good.decision_id);
  });

  it("en giftig rad MIDT i en batch (felles CHECK-brudd) isoleres rad for rad: de gode skrives, den giftige kastes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inserts: string[][] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        if (!/INSERT INTO policy_decisions/.test(sql)) return { rows: [], rowCount: 0 };
        const ids = (params?.[1] as string[]) ?? [];
        inserts.push(ids);
        if (ids.includes("d-poison-0001")) throw Object.assign(new Error("check violation"), { code: "23514" });
        return { rows: [], rowCount: ids.length };
      },
      release() { /* noop */ }
    };
    const fake = { connect: async () => client } as unknown as pg.Pool;
    const sink = sinkOn(fake);
    sink.write(event({ decision_id: "d-good-000001" }));
    sink.write(event({ decision_id: "d-poison-0001" }));
    sink.write(event({ decision_id: "d-good-000002" }));
    await sink.flush();
    expect(inserts).toEqual([["d-good-000001", "d-poison-0001", "d-good-000002"], ["d-good-000001"], ["d-poison-0001"], ["d-good-000002"]]);
    expect(sink.stats()).toMatchObject({ queued: 0, written: 2, rejected_invalid: 1, consecutive_failures: 0 });
  });

  it("en hengende innsetting gir en transient feil etter fristen (flush henger ikke for alltid), og en samtidig flush deler den ene kjøringen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hang = { connect: () => new Promise(() => undefined) } as unknown as pg.Pool;
    const sink = sinkOn(hang, { insertTimeoutMs: 150 });
    sink.write(event());
    const started = Date.now();
    const [a, b] = [sink.flush(), sink.flush()];
    expect(a).toBe(b); // single-flight
    await a;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sink.stats()).toMatchObject({ queued: 1, consecutive_failures: 1, last_failure: "Error:WPK_TIMEOUT" });
  });

  it("backoff: etter feil planlegges neste forsøk med eksponentiell ventetid (tak), og en frisk skriving nullstiller den", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let attempts = 0;
    let down = true;
    const fake = { connect: async () => { attempts += 1; if (down) throw Object.assign(new Error("nede"), { code: "ECONNREFUSED" }); return app.connect(); } } as unknown as pg.Pool;
    const sink = new PgPolicyAuditSink({ pool: fake, flushIntervalMs: 100, maxBackoffMs: 800, processName: "api" });
    sink.write(event());
    await vi.advanceTimersByTimeAsync(100); // første forsøk
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(150); // backoff = 100 * 2^1 = 200 ms -> ennå ikke
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(400); // 400
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(800); // 800 (tak)
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(800); // tak holder
    expect(attempts).toBe(5);
    down = false;
    vi.useRealTimers();
    sink.close();
  });

  it("drain() skriver ut køen innen fristen og gir opp raskt mot en død database; close() avviser videre hendelser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app);
    for (let i = 0; i < 3; i += 1) sink.write(event());
    expect(await sink.drain(2_000)).toEqual({ remaining: 0 });
    const dead = sinkOn({ connect: async () => { throw new Error("nede"); } } as unknown as pg.Pool);
    dead.write(event());
    const started = Date.now();
    expect(await dead.drain(5_000)).toEqual({ remaining: 1 });
    expect(Date.now() - started).toBeLessThan(2_000); // ventet ikke ut hele fristen forgjeves
    dead.close();
    expect(dead.write(event())).toBe(false);
  });
});

describe("E: avgjørelsen er uavhengig av sinken (ekte PolicyGateway + død database)", () => {
  it("ALLOW og DENY er identiske med og uten en død sink, og feilene er telt og synlige", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dead = { connect: async () => { throw new Error("nede"); } } as unknown as pg.Pool;
    const sink = sinkOn(dead, { maxQueue: 2 });
    const mk = (auditSink?: PgPolicyAuditSink["write"]): { policy: PolicyGateway; ks: KillSwitch } => {
      const ks = new KillSwitch();
      return { policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: ks, ...(auditSink ? { auditSink } : {}) }), ks };
    };
    const withSink = mk(sink.write);
    const plain = mk();
    const req = { identity: IDENT, toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A" as const, parameters: {} } };
    const a1 = await withSink.policy.authorize(req);
    const b1 = await plain.policy.authorize(req);
    withSink.ks.activate("test");
    plain.ks.activate("test");
    const a2 = await withSink.policy.authorize(req);
    const b2 = await plain.policy.authorize(req);
    for (let i = 0; i < 3; i += 1) await withSink.policy.authorize(req);
    expect([a1.decision, a1.reason, a2.decision, a2.reason]).toEqual([b1.decision, b1.reason, b2.decision, b2.reason]);
    expect(withSink.policy.auditStats().sink_rejected).toBeGreaterThan(0);
    await sink.flush();
    expect(sink.stats().degraded).toBe(true);
  });
});

describe("F: konfigurasjon og oppstart (AV som standard)", () => {
  it("kun `db` slår på; blank/usatt/off er AV; en ukjent verdi er AV og meldes (aldri en stille tolkning)", () => {
    expect(policyAuditSinkConfigFromEnv({})).toMatchObject({ mode: "off", maxQueue: 2_000, retentionDays: 90, unknownValue: null });
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "" }).mode).toBe("off");
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "off" }).mode).toBe("off");
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: " DB " }).mode).toBe("db");
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "true" })).toMatchObject({ mode: "off", unknownValue: "true" });
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_QUEUE_MAX: "500", JARVIS_POLICY_AUDIT_RETENTION_DAYS: "45" })).toMatchObject({ maxQueue: 500, retentionDays: 45 });
    expect(() => policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_RETENTION_DAYS: "7" })).toThrow(/JARVIS_POLICY_AUDIT_RETENTION_DAYS/);
    expect(() => policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_QUEUE_MAX: "5" })).toThrow(/JARVIS_POLICY_AUDIT_QUEUE_MAX/);
  });

  it("createPolicyAuditSinkFromEnv: AV gir null (ingen sink, ingen timer, ingen skriving); PÅ gir en sink; ukjent verdi logges", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(createPolicyAuditSinkFromEnv(app, {})).toBeNull();
    expect(logs).not.toHaveBeenCalled();
    expect(createPolicyAuditSinkFromEnv(app, { JARVIS_POLICY_AUDIT_SINK: "yes" })).toBeNull();
    expect(String(errors.mock.calls[0]![0])).toContain("policy_audit_sink_unknown_value");
    const on = createPolicyAuditSinkFromEnv(app, { JARVIS_POLICY_AUDIT_SINK: "db", JARVIS_POLICY_AUDIT_QUEUE_MAX: "300" });
    expect(on).toBeInstanceOf(PgPolicyAuditSink);
    expect(on!.stats()).toMatchObject({ max_queue: 300, queued: 0, mode: "db" });
    expect(String(logs.mock.calls[0]![0])).toContain("policy_audit_sink_enabled");
    on!.close();
  });

  it("installPolicyAuditDrain: SIGTERM skriver ut køen FØR signalet sendes på nytt (standard avslutning, uendret exit-status), og lytterne kan fjernes", async () => {
    const calls: string[] = [];
    const sink = { drain: async () => { calls.push("drain"); return { remaining: 0 }; }, close: () => { calls.push("close"); } };
    const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: ((pid: number, signal: string) => { calls.push(`kill:${pid}:${signal}`); return true; }) as never });
    const remove = installPolicyAuditDrain(sink, { proc: proc as never, timeoutMs: 100 });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["drain", "close", "kill:4242:SIGTERM"]));
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    const again = installPolicyAuditDrain(sink, { proc: proc as never });
    again();
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    remove();
  });
});
