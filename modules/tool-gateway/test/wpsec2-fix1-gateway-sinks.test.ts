import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type ClassDNotifier, type ToolDefinition, type ToolTransport } from "../src/index.ts";

/**
 * WP-SEC2 fiks-runde 1 (review B, M1 + M3): ATFERDSTEST av hvert sted i `ToolGateway` der leverandørtekst lagres, returneres eller logges. Før var 10 av 11 `clipRedacted`-steder (og det 12., `health.detail`) kun dekket av at
 * kildeteksten inneholdt riktig streng - en mutant som byttet `clipRedacted(msg, 80)` mot `msg.slice(0, 80)` overlevde. Her kaster en transport/DB en feil med et SYNTETISK token (bygget sammensatt ved kjøring), og ALLE lagrings-
 * og retursteder sjekkes: `result.reason`, `health.detail`, `audit_events.reason`, `tool_executions.postcondition_reason`, `console.error`. Ekte embedded Postgres, ingen nett.
 */
const TOKEN = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";
const LEAK_PARTS = [TOKEN, TOKEN.slice(0, 12), "Zx3Qk9Lm2Vb7"];
const MARK = "[REDACTED:github_token]";
const clean = (value: unknown, label: string): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const part of LEAK_PARTS) expect(text, `${label} lekker «${part}»`).not.toContain(part);
};

class ScriptTransport implements ToolTransport {
  calls: string[] = [];
  /** Handlinger som kaster en feil med tokenet (første kall `ok`, så kast, når `failAfter` er satt). */
  failOn = new Set<string>();
  failAfter: Record<string, number> = {};
  private counts = new Map<string, number>();
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    const n = (this.counts.get(action) ?? 0) + 1;
    this.counts.set(action, n);
    if (this.failOn.has(action) && n > (this.failAfter[action] ?? 0)) throw new Error(`401 Bad credentials: ${TOKEN} rejected`);
    if (action === "read") return { data: { phase: "before" } };
    return { external_id: "ext-1" };
  }
}

function def(overrides: Partial<ToolDefinition>, transport: ToolTransport): ToolDefinition {
  const base = {
    tool_id: "fix1-gen", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) },
    capability_class: "D", scopes: [], reversible: false, rollback_procedure: "manuell rutine",
    idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 600, credential_ref: "FIX1_REF",
    output_trust: "internal", transport, preflight_action: "read", preflight_requires_target: true,
    postcondition_predicate: () => true
  };
  return { ...base, ...overrides } as unknown as ToolDefinition;
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  constructor(private readonly fail = false) {}
  ready() { return true; }
  async notify(n: ClassDNotification) {
    if (this.fail) throw new Error(`telegram 502 ${TOKEN}`);
    this.sent.push(n);
  }
}

/** En pool som feiler (med en feil som bærer tokenet) for spørringer der `fault(sql)` gir en feilmelding. */
function faultyPool(real: pg.Pool, fault: (sql: string) => string | null): pg.Pool {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "connect") {
        return async (...args: unknown[]) => {
          const client = await (target.connect as (...a: unknown[]) => Promise<pg.PoolClient>)(...args);
          return new Proxy(client, {
            get(c, p) {
              if (p === "query") {
                return async (...q: unknown[]) => {
                  const first = q[0];
                  const sql = typeof first === "string" ? first : String((first as { text?: string } | undefined)?.text ?? "");
                  const message = fault(sql);
                  if (message !== null) throw new Error(message);
                  return (c.query as (...a: unknown[]) => unknown)(...q);
                };
              }
              const value = Reflect.get(c, p) as unknown;
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(c) : value;
            }
          });
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  });
}

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let counter = 0;
const nextKey = (prefix: string): string => `${prefix}-${Date.now()}-${(counter += 1)}`;
const TENANT = "tenant-fix1";
const identity: IdentityContext = { person_id: "person-owner", tenant_id: TENANT, memory_space_id: "home", session_id: "sess-fix1", device_id: "dev-pc", channel: "api", auth_strength: "active" };
const secrets = { name: "t", get: async () => "cred" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fix1-gw-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fix1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fix1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Fix1','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-owner','Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_fix1", password: "pw2" });
  policy = new PolicyGateway({ devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(), authority: { owner_person_id: "person-owner", owner_tenants: [TENANT] } });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

afterEach(() => vi.restoreAllMocks());

function gw(notifier: ClassDNotifier, pool: pg.Pool = appPool): ToolGateway {
  return new ToolGateway(pool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier } });
}
const run = (g: ToolGateway, key: string, tool = "fix1-gen") => g.execute({ identity, tool_id: tool, action: "mutate", parameters: {}, idempotency_key: key });
const ledger = async (key: string) => (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;
const auditRows = async (tool: string) => (await adminPool.query("SELECT type, reason, payload FROM audit_events WHERE tenant_id = $1 AND tool_id = $2 ORDER BY audit_id", [TENANT, tool])).rows as Array<{ type: string; reason: string | null; payload: unknown }>;
const consoleText = (spy: ReturnType<typeof vi.spyOn>): string => spy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

describe("B-M1/GW2/GW3/GW6: en leverandørfeil med token (transporten kaster) lagres/returneres aldri uredigert", () => {
  it("result.reason, health.detail (B-M1), audit_events.reason, ledgerens postcondition_reason og varselet er redigert; klassifiseringen (401 -> auth_failed) er uendret", async () => {
    const t = new ScriptTransport();
    t.failOn.add("mutate");
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({ tool_id: "fix1-fail" }, t));
    const key = nextKey("f1");
    const r = await run(g, key, "fix1-fail");
    expect(r.ok).toBe(false);
    clean(r, "result");
    expect((r as { reason: string }).reason).toBe(`tool_failed:401 Bad credentials: ${MARK} rejected`);
    const health = g.health.get("fix1-fail");
    clean(health, "health");
    expect(health).toMatchObject({ state: "auth_failed", detail: `401 Bad credentials: ${MARK} rejected` });
    const row = await ledger(key);
    expect(row?.status).toBe("failed");
    clean(row, "ledger");
    const audit = await auditRows("fix1-fail");
    expect(audit.some((a) => a.type === "tool.failed")).toBe(true);
    clean(audit, "audit");
    clean(n.sent, "varsel");
  });
  it("health.detail når tokenet krysser 60-tegnsgrensen: skann FØRST (ingen delvis token), og rate_limited/unavailable er uendret", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    t.failOn.add("mutate");
    // «x…x <token>» der tokenet begynner på tegn 41: et kutt FØR skanning ville latt 19 token-tegn stå igjen
    const original = t.invoke.bind(t);
    t.invoke = async (action: string) => { if (action === "mutate") throw new Error(`${"x".repeat(40)} ${TOKEN}`); return original(action); };
    g.register(def({ tool_id: "fix1-cross" }, t));
    await run(g, nextKey("f1b"), "fix1-cross");
    const health = g.health.get("fix1-cross");
    clean(health, "health");
    expect(health?.state).toBe("unavailable");
    expect(String(health?.detail).length).toBeLessThanOrEqual(60);
    t.invoke = async (action: string) => { if (action === "mutate") throw new Error(`429 rate limit exceeded for ${TOKEN}`); return original(action); };
    g.register(def({ tool_id: "fix1-rate" }, t));
    await run(g, nextKey("f1c"), "fix1-rate");
    expect(g.health.get("fix1-rate")).toMatchObject({ state: "rate_limited" });
    clean(g.health.get("fix1-rate"), "health rate");
  });
});

describe("GW1: klasse D preflight som kaster (preflight_failed) returnerer ingen token", () => {
  it("preflight-feilen med token gir `preflight_failed:` uten token, og transporten mutérer aldri", async () => {
    const t = new ScriptTransport();
    t.failOn.add("read");
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "fix1-pre" }, t));
    const r = await run(g, nextKey("f2"), "fix1-pre");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason.startsWith("preflight_failed:")).toBe(true);
    clean(r, "preflight");
    expect(t.calls).not.toContain("mutate");
  });
});

describe("GW4/GW5: ledger-finalize som feiler to ganger - både DB-feilen (loggen) og leverandørfeilen (returen) er redigert", () => {
  it("en feil fra DB og fra transporten, begge med token: console.error og result.reason er redigert", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = new ScriptTransport();
    t.failOn.add("mutate");
    const g = gw(new FakeNotifier(), faultyPool(appPool, (sql) => (/UPDATE tool_executions SET status = \$2/.test(sql) ? `db connection lost for ${TOKEN}` : null)));
    g.register(def({ tool_id: "fix1-fin" }, t));
    const r = await run(g, nextKey("f3"), "fix1-fin");
    expect(r.ok).toBe(false);
    clean(r, "result");
    expect((r as { reason: string }).reason).toBe(`tool_failed:401 Bad credentials: ${MARK} rejected`);
    const logged = consoleText(errorSpy);
    expect(logged).toContain("tool_ledger_finalize_failed");
    clean(logged, "console.error");
    expect(logged).toContain(MARK); // feilen er der, men redigert
    expect(g.health.get("fix1-fin")).toMatchObject({ state: "degraded", detail: "ledger_finalize_failed" });
  });
});

describe("GW7: re-validering etter re-arm som kaster", () => {
  it("preflight som kaster i re-valideringen gir `preflight_failed:` uten token (og ledger-raden frigis uten token)", async () => {
    const t = new ScriptTransport();
    t.failOn.add("read");
    t.failAfter["read"] = 1; // første lesing OK, den ferske re-lesingen kaster
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "fix1-rearm", preflight_validator: () => null }, t));
    const key = nextKey("f7");
    await adminPool.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state) VALUES ($1, $2, 'fix1-rearm', 'mutate', 'reserved', '{}'::jsonb)", [TENANT, key]);
    // samtidig kall feiler MELLOM replay-peeken (ser `reserved`) og ledger-porten: raden blir `failed` -> re-arm uten validering -> ny validering på fersk tilstand
    const target = g as unknown as { peekLedgerStatus: (tenantId: string, k: string) => Promise<string | null> };
    const original = target.peekLedgerStatus.bind(g);
    target.peekLedgerStatus = async (tenantId, k) => {
      const status = await original(tenantId, k);
      await adminPool.query("UPDATE tool_executions SET status = 'failed' WHERE idempotency_key = $1", [k]);
      return status;
    };
    const r = await run(g, key, "fix1-rearm");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason.startsWith("preflight_failed:")).toBe(true);
    clean(r, "rearm");
    clean(await ledger(key), "rearm-ledger");
    expect(t.calls).not.toContain("mutate");
  });
});

describe("GW8/GW9: frigivelse av ledger-reservasjon (white-box: private metode, kalt direkte med tekst som bærer tokenet)", () => {
  type Releaser = { releaseLedgerReservation: (tenantId: string, key: string, reason: string) => Promise<void> };
  it("GW8: årsaken som lagres i ledgeren er redigert", async () => {
    const g = gw(new FakeNotifier());
    const key = nextKey("f8");
    await adminPool.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state) VALUES ($1, $2, 'fix1-rel', 'mutate', 'reserved', '{}'::jsonb)", [TENANT, key]);
    await (g as unknown as Releaser).releaseLedgerReservation(TENANT, key, `rearm_preflight_failed:upstream said ${TOKEN}`);
    const row = await ledger(key);
    expect(row?.status).toBe("failed");
    clean(row, "release-ledger");
    expect(row?.postcondition_reason).toContain(MARK);
  });
  it("GW9: feiler frigivelsen selv (DB-feil med token), er loggen redigert", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gw(new FakeNotifier(), faultyPool(appPool, (sql) => (/UPDATE tool_executions SET status = 'failed'/.test(sql) ? `could not serialize access ${TOKEN}` : null)));
    await (g as unknown as Releaser).releaseLedgerReservation(TENANT, nextKey("f9"), "årsak");
    const logged = consoleText(errorSpy);
    expect(logged).toContain("tool_ledger_release_failed");
    clean(logged, "console.error");
    expect(logged).toContain(MARK);
  });
});

describe("GW10/GW11: klasse D-varsling som feiler (leverandørfeil med token) - audit og connector-helse er redigert", () => {
  it("notify() kaster: handlingen er utført (notified=false), `tool.class_d_notification_failed`-raden og health[class_d_notifier] har ingen token", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier(true));
    g.register(def({ tool_id: "fix1-notify" }, t));
    const r = await run(g, nextKey("f10"), "fix1-notify");
    expect(r.ok).toBe(true);
    expect((r as { notified?: boolean }).notified).toBe(false);
    const rows = (await auditRows("fix1-notify")).filter((a) => a.type === "tool.class_d_notification_failed");
    expect(rows.length).toBeGreaterThan(0);
    clean(rows, "notify-audit");
    expect(rows[0]?.reason).toContain(MARK);
    const health = g.health.get("class_d_notifier");
    clean(health, "notifier-health");
    expect(health).toMatchObject({ state: "degraded" });
    expect(health?.detail).toContain(MARK);
  });
});

describe("GW12: avslag der selve audit-skrivingen feiler - loggen har ingen token", () => {
  it("ukjent verktøy -> deny() -> writeAudit kaster (DB-feil med token): console.error er redigert", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gw(new FakeNotifier(), faultyPool(appPool, (sql) => (/INSERT INTO audit_events/.test(sql) ? `audit sink down ${TOKEN}` : null)));
    const r = await g.execute({ identity, tool_id: "finnes-ikke", action: "mutate", parameters: {}, idempotency_key: nextKey("f12") });
    expect(r.ok).toBe(false);
    const logged = consoleText(errorSpy);
    expect(logged).toContain("tool_denied_audit_write_failed");
    clean(logged, "console.error");
    expect(logged).toContain(MARK);
  });
});
