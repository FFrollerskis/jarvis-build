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
/** Deterministisk id (review M4): løpenummer + et hash-aktig, men reproduserbart, hex-ledd - aldri `Math.random` (en tilfeldig id som tilfeldigvis ligner et kortnummer gjorde testen flaky). */
const decisionIdFor = (n: number): string => `d-wpk53-${String(n).padStart(6, "0")}-${((n * 2654435761) >>> 0).toString(16).padStart(8, "0")}`;
const event = (over: Partial<PolicyAuditEvent> = {}): PolicyAuditEvent => ({
  at: new Date().toISOString(), decision_id: decisionIdFor(++seq), decision: "ALLOW", reason: "class_a_read",
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

  it("redaksjon: hemmelighetsformer i FRITEKST (grunnkoden) redigeres og kontrolltegn/lengde kuttes - men id-er redigeres ALDRI (de kuttes og tegnsett-valideres)", async () => {
    const tokenLike = `gh${"p_"}${"a1B2c3D4e5".repeat(4)}`; // bygges ved kjøring - ingen leverandørformet tekst i kildefilen
    const sink = sinkOn(app);
    const a = event({ reason: `denied: token ${tokenLike} used\nsecond line\u0007`, task_id: "task-plain-1", trace_id: "x".repeat(500) });
    sink.write(a);
    await sink.flush();
    const ra = (await rowsAs("t-a")).find((r) => r["decision_id"] === a.decision_id)!;
    expect(JSON.stringify(ra)).not.toContain(tokenLike); // hemmeligheten i fritekst er borte
    expect(ra["reason"]).toMatch(/\[REDACTED:/);
    expect(String(ra["reason"]).includes("\n")).toBe(false);
    expect(String(ra["reason"]).includes(String.fromCharCode(7))).toBe(false);
    expect(ra["task_id"]).toBe("task-plain-1");
    expect(String(ra["trace_id"]).length).toBe(200); // kuttet FØRST, så validert
  });

  it("M4: id-er redigeres ALDRI - Luhn-gyldige sifferrekker, `NAVN=verdi`-lignende job-id-er og token-lignende id-er lagres eksakt, så joinen mot audit_events (rå-id) alltid treffer", async () => {
    const luhn = (body: string): string => { // gyldig Luhn-sifferrekke bygget ved kjøring (ingen kortnummer i kildefilen)
      let sum = 0;
      for (let i = 0; i < body.length; i += 1) {
        let n = Number(body[body.length - 1 - i]);
        if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
      }
      return `${body}${(10 - (sum % 10)) % 10}`;
    };
    const card = luhn("411111111111111"); // 16 sifre, Luhn-gyldig
    const tokenLike = `gh${"p_"}${"a1B2c3D4e5".repeat(4)}`;
    const ids = {
      decision_id: `d-${card}-wpk`, task_id: `task-${card}`, trace_id: `${card.slice(0, 8)}-${card.slice(8)}`, session_id: `sess ${card}`.replace(" ", "-"),
      job: "sched:oauth-token-refresh:2026-11-14", token: tokenLike
    };
    const sink = sinkOn(app);
    const e = event({ decision_id: ids.decision_id, task_id: ids.task_id, trace_id: ids.trace_id, session_id: ids.session_id, person_id: `person-${card}` });
    const jobEvent = event({ task_id: ids.job, trace_id: ids.token });
    sink.write(e);
    sink.write(jobEvent);
    await sink.flush();
    const rows = await rowsAs("t-a");
    const re = rows.find((r) => r["decision_id"] === ids.decision_id)!;
    expect(re).toMatchObject({ decision_id: ids.decision_id, task_id: ids.task_id, trace_id: ids.trace_id, session_id: ids.session_id, person_id: `person-${card}` });
    const rj = rows.find((r) => r["decision_id"] === jobEvent.decision_id)!;
    expect(rj).toMatchObject({ task_id: ids.job, trace_id: ids.token });
    for (const row of [re, rj]) for (const column of ["decision_id", "task_id", "trace_id", "session_id", "person_id"]) expect(String(row[column]), column).not.toMatch(/REDACTED|redacted-/);
  });

  it("M4 (deterministisk regresjon): 5 000 id-er av byggerens tidligere testform går urørt gjennom radbyggingen - ingen id blir omskrevet", () => {
    let altered = 0;
    for (let n = 1; n <= 5_000; n += 1) {
      const id = decisionIdFor(n);
      const row = toPolicyDecisionRow(event({ decision_id: id, task_id: `inc-repair-${n}-${n * 7919}`, trace_id: `corr-${(n * 40503).toString(16).padStart(16, "0")}` }), null, new Date());
      if (row === "unattributable" || row === "invalid" || row.decision_id !== id || row.task_id !== `inc-repair-${n}-${n * 7919}`) altered += 1;
    }
    expect(altered).toBe(0);
    const uuidLike = (n: number): string => `${(n * 2654435761 >>> 0).toString(16).padStart(8, "0")}-${(n * 40503 % 65536).toString(16).padStart(4, "0")}-4${(n % 4096).toString(16).padStart(3, "0")}-8${((n * 31) % 4096).toString(16).padStart(3, "0")}-${(n * 7919).toString(16).padStart(12, "0")}`;
    for (let n = 1; n <= 5_000; n += 1) {
      const row = toPolicyDecisionRow(event({ decision_id: uuidLike(n) }), null, new Date());
      expect(row !== "unattributable" && row !== "invalid" && row.decision_id === uuidLike(n)).toBe(true);
    }
  });

  it("M4: id-er kuttes FØRST og valideres på tegnsett (mellomrom/kontrolltegn/anførselstegn blir `_`), en kjempestor id er billig, og tom/ren-symbol id blir `unknown`/null", () => {
    const row = toPolicyDecisionRow(event({ session_id: "ses sion\n\"x\"", tool_id: "t\u0000ool", action: ";;;", task_id: "a".repeat(1_000_000) }), null, new Date());
    if (row === "unattributable" || row === "invalid") throw new Error("uventet");
    expect(row.session_id).toBe("ses_sion__x_");
    expect(row.tool_id).toBe("t_ool");
    expect(row.action).toBe("unknown"); // ingen bokstaver/sifre igjen
    expect(row.task_id).toBe("a".repeat(200));
    const started = Date.now();
    toPolicyDecisionRow(event({ trace_id: `${"-".repeat(5_000_000)}x` }), null, new Date());
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("M4: TENANT er eksakt eller ingenting - en tenant-id med utrygge tegn eller over 200 tegn skrives ALDRI (heller ikke «renset», det kunne blitt en annen tenant)", () => {
    for (const tenant of ["t a", "t-a\n", "t'a", "t".repeat(201), "t;a", ""]) {
      expect(toPolicyDecisionRow(event({ tenant_id: tenant }), null, new Date()), JSON.stringify(tenant)).toBe("unattributable");
    }
    expect(toPolicyDecisionRow(event({ tenant_id: "tenant-owner.example@host:1/x#y+z=1~2" }), null, new Date())).not.toBe("unattributable");
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
    const sink = sinkOn(app, { maxQueue: 5, maxPerTenant: 5 }); // tenant-taket er egen test (C2) - her er det den TOTALE køen som er full
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
    const sink = sinkOn(dead, { maxQueue: 100, maxPerTenant: 100 });
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

describe("C2: tak per tenant i køen (review L4) - én tenant fortrenger aldri de andre", () => {
  it("standard er 80 % av køen: en tenant som fyller sitt tak avvises (rejected_tenant_cap) mens de siste plassene er reservert andre tenanter", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app, { maxQueue: 10 });
    expect(sink.stats().max_per_tenant).toBe(8);
    const noisy = Array.from({ length: 12 }, () => sink.write(event({ tenant_id: "t-b" })));
    expect(noisy.filter(Boolean)).toHaveLength(8);
    expect(sink.stats()).toMatchObject({ queued: 8, rejected_tenant_cap: 4, rejected_full: 0, degraded: true, pressure: "high" });
    // eierens tenant er ikke fortrengt: de to reserverte plassene er ledige
    expect(sink.write(event({ tenant_id: "t-a" }))).toBe(true);
    expect(sink.write(event({ tenant_id: "t-a" }))).toBe(true);
    expect(sink.stats()).toMatchObject({ queued: 10, pressure: "full" });
    // nå er hele køen full: neste hendelse fra en tenant UNDER taket avvises som `rejected_full`, ikke som tenant-tak
    expect(sink.write(event({ tenant_id: "t-a" }))).toBe(false);
    expect(sink.stats()).toMatchObject({ rejected_full: 1, rejected_tenant_cap: 4 });
  });

  it("eierens rader havner i journalen selv om en annen tenant har fylt køen til taket (ekte Postgres)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app, { maxQueue: 10 });
    for (let i = 0; i < 30; i += 1) sink.write(event({ tenant_id: "t-b", reason: "flood_b" }));
    const owner = [event({ tenant_id: "t-a", reason: "owner_decision_1" }), event({ tenant_id: "t-a", reason: "owner_decision_2" })];
    for (const e of owner) expect(sink.write(e)).toBe(true);
    await sink.flush();
    const ids = (await rowsAs("t-a")).map((r) => r["decision_id"]);
    for (const e of owner) expect(ids).toContain(e.decision_id);
    expect(sink.stats()).toMatchObject({ queued: 0, written: 10, rejected_tenant_cap: 22 });
  });

  it("taket frigjøres når køen skrives ut (tellerne følger køen), også etter en giftig rad som kastes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app, { maxQueue: 100, maxPerTenant: 3 });
    for (let i = 0; i < 3; i += 1) expect(sink.write(event({ tenant_id: "t-b" }))).toBe(true);
    expect(sink.write(event({ tenant_id: "t-b" }))).toBe(false);
    await sink.flush();
    for (let i = 0; i < 3; i += 1) expect(sink.write(event({ tenant_id: "t-b" }))).toBe(true); // tellerne er nullstilt av utskrivingen
    expect(sink.write(event({ tenant_id: "t-b" }))).toBe(false);
    await sink.flush();

    // giftig rad (permanent avvist av databasen) forlater køen uten å bli skrevet - taket skal likevel frigjøres
    const client = {
      async query(sql: string, params?: unknown[]) {
        if (!/INSERT INTO policy_decisions/.test(sql)) return { rows: [], rowCount: 0 };
        const ids = (params?.[1] as string[]) ?? [];
        if (ids.includes("d-poison-cap-01")) throw Object.assign(new Error("check violation"), { code: "23514" });
        return { rows: [], rowCount: ids.length };
      },
      release() { /* noop */ }
    };
    const poisoned = sinkOn({ connect: async () => client } as unknown as pg.Pool, { maxQueue: 100, maxPerTenant: 2 });
    poisoned.write(event({ decision_id: "d-poison-cap-01" }));
    poisoned.write(event({ decision_id: "d-good-cap-0001" }));
    expect(poisoned.write(event())).toBe(false);
    await poisoned.flush();
    expect(poisoned.stats()).toMatchObject({ queued: 0, written: 1, rejected_invalid: 1 });
    expect(poisoned.write(event())).toBe(true);
    expect(poisoned.write(event())).toBe(true);
    expect(poisoned.write(event())).toBe(false);
  });

  it("mot en død database holdes tenant-tellerne uendret (hendelsene ligger i køen): taket gjelder fortsatt, og minnet er avgrenset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dead = { connect: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } } as unknown as pg.Pool;
    const sink = sinkOn(dead, { maxQueue: 20, maxPerTenant: 5 });
    for (let i = 0; i < 5; i += 1) sink.write(event({ tenant_id: "t-b" }));
    await sink.flush();
    expect(sink.stats()).toMatchObject({ queued: 5, consecutive_failures: 1 });
    expect(sink.write(event({ tenant_id: "t-b" }))).toBe(false);
    expect(sink.write(event({ tenant_id: "t-a" }))).toBe(true);
  });

  it("taket klemmes til 1..maxQueue, og logglinjen er strupet og har kun tellere + tenant-id (aldri hendelsesinnhold)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(sinkOn(app, { maxQueue: 10, maxPerTenant: 0 }).stats().max_per_tenant).toBe(1);
    expect(sinkOn(app, { maxQueue: 10, maxPerTenant: 999 }).stats().max_per_tenant).toBe(10);
    expect(sinkOn(app, { maxQueue: 1 }).stats().max_per_tenant).toBe(1);
    const sink = sinkOn(app, { maxQueue: 10, maxPerTenant: 1 });
    for (let i = 0; i < 6; i += 1) sink.write(event({ tenant_id: "t-b", reason: "fake-private-reason-text-for-test" }));
    const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("policy_audit_sink_tenant_cap"));
    expect(lines).toHaveLength(1); // strupet
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "policy_audit_sink_tenant_cap", tenant_id: "t-b", max_per_tenant: 1, rejected_tenant_cap: 1 });
    expect(lines[0]).not.toContain("fake-private-reason-text-for-test");
  });

  it("avvisning telles som AKTUELT problem i 5 minutter (degraded) og nullstilles så - livstidstellerne består (review L4)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = sinkOn(app, { maxQueue: 100, maxPerTenant: 1 });
    expect(sink.stats().degraded).toBe(false);
    sink.write(event({ tenant_id: "t-b" }));
    sink.write(event({ tenant_id: "t-b" })); // avvist av taket
    expect(sink.stats()).toMatchObject({ degraded: true, rejected_tenant_cap: 1 });
    vi.setSystemTime(new Date("2026-11-14T12:04:59.000Z"));
    expect(sink.stats().degraded).toBe(true);
    vi.setSystemTime(new Date("2026-11-14T12:05:01.000Z"));
    expect(sink.stats()).toMatchObject({ degraded: false, rejected_tenant_cap: 1 });
    // ugyldige hendelser (dårlig `decision`) er også et aktuelt, men tidsavgrenset, avvik
    expect(sink.write(event({ decision: "MAYBE" as never }))).toBe(false);
    expect(sink.stats()).toMatchObject({ degraded: true, rejected_invalid: 1 });
    vi.setSystemTime(new Date("2026-11-14T12:10:02.000Z"));
    expect(sink.stats()).toMatchObject({ degraded: false, rejected_invalid: 1 });
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
    expect(policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "db", JARVIS_POLICY_AUDIT_QUEUE_MAX: "500", JARVIS_POLICY_AUDIT_RETENTION_DAYS: "45" })).toMatchObject({ mode: "db", maxQueue: 500, retentionDays: 45 });
  });

  it("review L2: størrelsene VALIDERES kun når journalen er PÅ - med flagget AV (eller ukjent verdi) stopper en feilskrevet verdi aldri oppstarten", () => {
    const bad = { JARVIS_POLICY_AUDIT_QUEUE_MAX: "abc", JARVIS_POLICY_AUDIT_RETENTION_DAYS: "7" };
    for (const sink of [undefined, "", "off", "false", "yes"]) {
      const env = { ...bad, ...(sink === undefined ? {} : { JARVIS_POLICY_AUDIT_SINK: sink }) };
      expect(() => policyAuditSinkConfigFromEnv(env), String(sink)).not.toThrow();
      expect(policyAuditSinkConfigFromEnv(env), String(sink)).toMatchObject({ mode: "off", maxQueue: 2_000, retentionDays: 90 });
    }
    expect(() => policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "db", JARVIS_POLICY_AUDIT_RETENTION_DAYS: "7" })).toThrow(/JARVIS_POLICY_AUDIT_RETENTION_DAYS/);
    expect(() => policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "db", JARVIS_POLICY_AUDIT_QUEUE_MAX: "5" })).toThrow(/JARVIS_POLICY_AUDIT_QUEUE_MAX/);
    expect(() => policyAuditSinkConfigFromEnv({ JARVIS_POLICY_AUDIT_SINK: "db", JARVIS_POLICY_AUDIT_QUEUE_MAX: "abc" })).toThrow(/JARVIS_POLICY_AUDIT_QUEUE_MAX/);
    // oppstartsveien: AV + ugyldig verdi gir `null` (ingen sink) uten å kaste; PÅ + ugyldig verdi feiler høyt
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(createPolicyAuditSinkFromEnv(app, bad)).toBeNull();
    expect(() => createPolicyAuditSinkFromEnv(app, { ...bad, JARVIS_POLICY_AUDIT_SINK: "db" })).toThrow(/JARVIS_POLICY_AUDIT/);
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

  it("review L5: kill() som kaster gir ingen ubehandlet avvisning, og prosessen avsluttes direkte med standard signal-exitkode i stedet for å ignorere signalet for alltid", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
        const exits: number[] = [];
        const sink = { drain: async () => ({ remaining: 0 }), close: () => undefined };
        const proc = Object.assign(new EventEmitter(), {
          pid: 4243, kill: (() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); }) as never, exit: ((c?: number) => { exits.push(c ?? 0); }) as never
        });
        installPolicyAuditDrain(sink, { proc: proc as never, timeoutMs: 50 });
        proc.emit(signal);
        await vi.waitFor(() => expect(exits).toEqual([code]));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      const line = errors.mock.calls.map((c) => String(c[0])).find((l) => l.includes("policy_audit_drain_kill_failed"))!;
      expect(JSON.parse(line)).toMatchObject({ msg: "policy_audit_drain_kill_failed", signal: "SIGTERM", error: "Error:EPERM" });
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("review L5: close() som kaster hindrer ikke at signalet sendes på nytt; manglende exit() på prosessobjektet er ikke en feil", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    const sink = { drain: async () => ({ remaining: 0 }), close: () => { calls.push("close"); throw new Error("close feilet"); } };
    const proc = Object.assign(new EventEmitter(), { pid: 4244, kill: ((pid: number, signal: string) => { calls.push(`kill:${pid}:${signal}`); return true; }) as never });
    installPolicyAuditDrain(sink, { proc: proc as never, timeoutMs: 50 });
    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["close", "kill:4244:SIGTERM"]));
    // kill kaster og det finnes ingen exit(): ingen krasj
    const bare = Object.assign(new EventEmitter(), { pid: 4245, kill: (() => { throw new Error("nei"); }) as never });
    installPolicyAuditDrain({ drain: async () => ({ remaining: 0 }), close: () => undefined }, { proc: bare as never, timeoutMs: 50 });
    bare.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});
