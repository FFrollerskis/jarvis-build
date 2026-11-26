import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { localHour, parseFollowUpPushPolicy, type FollowUpPushPolicy, type PushSendGuard } from "@jarvis/executive";
import { InMemoryDeviceRegistry, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { TelegramTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { createAuditLedger, createPushCorrelator, createPushSendGuard, startFollowUpPush, type FollowUpPushHandle } from "../src/follow-up-push.ts";

/**
 * WP-P3 K5 (JARVIS-054-resten): oppfølgingsvarselet (`follow-up-push.ts`) skrev `followup.push_reserved`/`push_sent|failed|unknown` som `person_id:"system"` UTEN `task_id`/`trace_id`, og `telegram.notify` gjennom
 * gatewayen likeså - «hva skjedde kl. 03:17?» kunne ikke knyttes til tikket. Nå får hvert tikk en korrelasjon (`task_id` = `sched:v2-push:<UTC-dato>`, stabil per dag; `trace_id` unik per tikk, også på tvers av
 * omstarter samme dag) som leveres som getter til ledgeren og avsenderen og videre til `gateway.execute({ task_id, trace_id })`. Porten `FollowUpLedgerPort` er uendret. Ekte `ToolGateway`/`PolicyGateway`/
 * `TelegramTransport` og ekte Postgres som app-rolle (som wpc4-gateway-testen); kun leverandørens HTTP (`fetch`) er en mock. Identiteten er fortsatt `system` for ledger-radene (ingen falsk prinsipal).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let graph: ConversationGraphService;
let seq = 0;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OWNER = "person-tobias";
const TOKEN = "123456:TEST-TOKEN-SKAL-ALDRI-I-LOGG";
const CHAT = "424242";
const SAFE_ID = /^[A-Za-z0-9:._-]+$/;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpp3push-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpp3push LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_wpp3push");
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, 'Tobias') ON CONFLICT DO NOTHING", [OWNER]);
  app = createPool({ ...base, user: "jarvis_wpp3push", password: "pw2" });
  graph = new ConversationGraphService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

afterEach(() => vi.unstubAllGlobals());

interface World { tenant: string; identity: IdentityContext; delivered: string[]; gateway: ToolGateway; guard: PushSendGuard; handles: FollowUpPushHandle[] }

/** Samme kjede som `main.ts`: PolicyGateway (eier-autoritet), OwnerControls, ToolGateway med credential-binding og den ekte `telegram.notify`-definisjonen; Telegram-HTTP er mocket. */
async function makeWorld(): Promise<World> {
  const tenant = `tenant-wpp3push-${++seq}`;
  await admin.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $1, 'person')", [tenant]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, $2)", [OWNER, tenant]);
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const infraGate = new InfraExecutionGate();
  const infraToolIds = new Set(["github", "docker"]);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch, controls, infraGate, infraToolIds, authority: { owner_person_id: OWNER, owner_tenants: [tenant] }
  });
  const secrets: SecretProvider = { name: "test", async get(ref) { return ref === "JARVIS_TELEGRAM_TOKEN" ? TOKEN : null; } };
  const gateway = new ToolGateway(app, policy, secrets, controls, undefined, { credentialBinding: { owner_person_id: OWNER, owner_tenants: [tenant], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) } });
  for (const tool of firstWaveTools({ telegram: new TelegramTransport(async () => CHAT) })) {
    if (tool.tool_id === "telegram" && tool.action === "notify") gateway.register(tool);
  }
  const delivered: string[] = [];
  vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    delivered.push(String(body.text));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + delivered.length } }), { status: 200 });
  });
  const identity: IdentityContext = { person_id: OWNER, tenant_id: tenant, memory_space_id: "personal", session_id: `sess-sys-brief-${tenant}`, device_id: "jarvis-core", channel: "api", auth_strength: "active" };
  return { tenant, identity, delivered, gateway, guard: createPushSendGuard({ killSwitch, controls, infraGate, infraToolIds }), handles: [] };
}

const policyOf = (over: Partial<FollowUpPushPolicy> = {}): FollowUpPushPolicy => {
  const h = localHour(new Date(), "Europe/Oslo");
  return { ...parseFollowUpPushPolicy({ JARVIS_V2_PUSH_ENABLED: "true" }), min_gap_minutes: 0, quiet_start_hour: (h + 12) % 24, quiet_end_hour: (h + 13) % 24, ...over };
};

/** Flyttbar klokke: den virkelige tiden + `offset` (radene i revisjonssporet får databasens `now()`, så planleggerens klokke må ikke ligge BAK dem - ellers gir minsteavstanden `min_gap`). */
function runner(world: World, policy: FollowUpPushPolicy, clock: { offset: number }, opts: { gateway?: Pick<ToolGateway, "execute"> } = {}) {
  const handle = startFollowUpPush({
    pool: app, graph, gateway: opts.gateway ?? world.gateway, ownerIdentity: world.identity, policy, guard: world.guard,
    now: () => new Date(Date.now() + clock.offset), log: () => undefined, tickMs: 3_600_000
  });
  world.handles.push(handle);
  return handle;
}
const done = (world: World): void => { for (const h of world.handles) h.stop(); };
const dateAt = (clock: { offset: number }): string => new Date(Date.now() + clock.offset).toISOString().slice(0, 10);
/** Godtatte task_id-er for en dato målt før OG etter en handling (tåler et midnattsskifte midt i testen). */
const taskIdsFor = (before: string, after: string): string[] => [...new Set([before, after])].map((d) => `sched:v2-push:${d}`);

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const followup = (tenant: string, label: string, dueOffsetMs: number, title: string) =>
  admin.query(
    `INSERT INTO business_followups (followup_id, tenant_id, memory_space_id, title, reason, next_action, due_at, priority, status) VALUES ($1,$2,'business',$3,'grunn','neste',$4,'normal','open')`,
    [`${tenant}-${label}`, tenant, title, iso(dueOffsetMs)]
  );

interface Row { audit_id: string; type: string; person_id: string; actor_kind: string | null; tool_id: string | null; task_id: string | null; trace_id: string | null; payload: Record<string, unknown> }
const rowsOf = async (tenant: string, where: string): Promise<Row[]> =>
  (await admin.query(`SELECT audit_id::text, type, person_id, actor_kind, tool_id, task_id, trace_id, payload FROM audit_events WHERE tenant_id = $1 AND (${where}) ORDER BY audit_id`, [tenant])).rows as Row[];
const ledgerRows = (tenant: string) => rowsOf(tenant, "type LIKE 'followup.push_%'");
const gatewayRows = (tenant: string) => rowsOf(tenant, "tool_id = 'telegram' AND type LIKE 'tool.%'");

describe("WP-P3 K5: oppfølgingsvarselet bærer task_id/trace_id i ledger-radene OG i gatewayens rader", () => {
  it("ETT sendende tikk: ALLE followup.push_*-rader og gatewayens telegram-rad har task_id = sched:v2-push:<UTC-dato> og samme trace_id; ledger-radene er fortsatt `system`", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const clock = { offset: 0 };
    const h = runner(w, policyOf(), clock);
    try {
      const before = dateAt(clock);
      expect(await h.tick()).toMatchObject({ sent: true });
      const accepted = taskIdsFor(before, dateAt(clock));
      expect(w.delivered).toHaveLength(1);
      const ledger = await ledgerRows(w.tenant);
      expect(ledger.map((r) => r.type)).toEqual(["followup.push_reserved", "followup.push_sent"]);
      const gw = await gatewayRows(w.tenant);
      expect(gw.length).toBeGreaterThanOrEqual(1);
      const traceIds = new Set([...ledger, ...gw].map((r) => r.trace_id));
      expect(traceIds.size).toBe(1); // samme tikk = samme trace_id på tvers av ledger og gateway
      for (const r of [...ledger, ...gw]) {
        expect(accepted, `${r.type} task_id`).toContain(r.task_id);
        expect(r.trace_id, `${r.type} trace_id`).toMatch(/^sched-v2-push-\d{4}-\d{2}-\d{2}-a\d+$/);
        expect(r.task_id).toMatch(SAFE_ID);
        expect(r.trace_id).toMatch(SAFE_ID);
      }
      for (const r of ledger) {
        expect(r.person_id).toBe("system"); // identiteten er uendret: ingen falsk prinsipal
        expect(r.actor_kind).toBe("system");
        expect(r.tool_id).toBe("telegram");
      }
    } finally { done(w); }
  });

  it("gatewayen får task_id/trace_id i execute-kallet (samme verdier som ledger-radene), og kun disse to korrelasjonsfeltene", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const calls: Array<Record<string, unknown>> = [];
    const spy: Pick<ToolGateway, "execute"> = { execute: async (req) => { calls.push(req as unknown as Record<string, unknown>); return w.gateway.execute(req); } };
    const clock = { offset: 0 };
    const h = runner(w, policyOf(), clock, { gateway: spy });
    try {
      expect(await h.tick()).toMatchObject({ sent: true });
      expect(calls).toHaveLength(1);
      const ledger = await ledgerRows(w.tenant);
      expect(ledger[0]!.task_id).not.toBeNull();
      expect(calls[0]).toMatchObject({ tool_id: "telegram", action: "notify", task_id: ledger[0]!.task_id, trace_id: ledger[0]!.trace_id });
      expect(Object.keys(calls[0]!).sort()).toEqual(["action", "idempotency_key", "identity", "parameters", "task_id", "tool_id", "trace_id"]);
    } finally { done(w); }
  });

  it("tre tikk SAMME dag (to i samme løper, ett etter en omstart: ny løper uten delt teller) deler task_id og har ulik trace_id; ledger- og gateway-radene til hvert tikk deler SIN trace_id", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const clock = { offset: 0 };
    const first = runner(w, policyOf(), clock);
    try {
      expect(await first.tick()).toMatchObject({ sent: true });
      await followup(w.tenant, "beta", -1 * DAY, "Sak Beta");
      expect(await first.tick()).toMatchObject({ sent: true }); // fast klokke: samme sekund som forrige tikk
      await followup(w.tenant, "gamma", -1 * DAY, "Sak Gamma");
      first.stop();
      clock.offset += 15 * MIN; // omstart: en NY løper (ingen delt teller) et kvarter senere samme dag
      const restarted = runner(w, policyOf(), clock);
      expect(await restarted.tick()).toMatchObject({ sent: true });
      expect(w.delivered).toHaveLength(3);
      const reserved = (await ledgerRows(w.tenant)).filter((r) => r.type === "followup.push_reserved");
      expect(reserved).toHaveLength(3);
      expect(reserved.every((r) => r.task_id !== null && r.trace_id !== null)).toBe(true);
      // task_id er stabil per UTC-dag (unntatt hvis testen krysser et midnattsskifte): maks to ulike, og lik for tikkene som deler dato
      expect(new Set(reserved.map((r) => r.task_id)).size).toBeLessThanOrEqual(2);
      expect(new Set(reserved.slice(0, 2).map((r) => r.task_id)).size).toBeLessThanOrEqual(2);
      expect(new Set(reserved.map((r) => r.trace_id)).size).toBe(3);
      // hvert tikks ledger- og gateway-rader deler SIN trace_id (ingen rad kan knyttes til feil tikk)
      const gw = await gatewayRows(w.tenant);
      expect(new Set(gw.map((r) => r.trace_id))).toEqual(new Set(reserved.map((r) => r.trace_id)));
    } finally { done(w); }
  });

  it("neste døgn gir en NY task_id (stabil per UTC-dag, ikke per prosess)", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const clock = { offset: 0 };
    const h = runner(w, policyOf(), clock);
    try {
      const day0 = dateAt(clock);
      expect(await h.tick()).toMatchObject({ sent: true });
      const day0After = dateAt(clock);
      await followup(w.tenant, "beta", -1 * DAY, "Sak Beta");
      clock.offset += 26 * HOUR; // alltid en annen UTC-dato
      const day1 = dateAt(clock);
      expect(await h.tick()).toMatchObject({ sent: true });
      const day1After = dateAt(clock);
      const reserved = (await ledgerRows(w.tenant)).filter((r) => r.type === "followup.push_reserved");
      expect(reserved).toHaveLength(2);
      expect(taskIdsFor(day0, day0After)).toContain(reserved[0]!.task_id);
      expect(taskIdsFor(day1, day1After)).toContain(reserved[1]!.task_id);
      expect(reserved[0]!.task_id).not.toBe(reserved[1]!.task_id);
    } finally { done(w); }
  });

  it("settle-radene (`push_failed`/`push_unknown`) får også korrelasjonen: en avvist sending og et ukjent utfall bærer samme task_id/trace_id som reservasjonen", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const clock = { offset: 0 };
    const failing: Pick<ToolGateway, "execute"> = { execute: async () => ({ ok: false, reason: "tool_failed:telegram_error_502" }) as never };
    const h = runner(w, policyOf(), clock, { gateway: failing });
    try {
      expect(await h.tick()).toMatchObject({ sent: false, reason: "send_unknown" });
      const ledger = await ledgerRows(w.tenant);
      expect(ledger.map((r) => r.type)).toEqual(["followup.push_reserved", "followup.push_unknown"]);
      expect(ledger[0]!.task_id).toMatch(/^sched:v2-push:\d{4}-\d{2}-\d{2}$/);
      expect(ledger[1]!.task_id).toBe(ledger[0]!.task_id);
      expect(ledger[1]!.trace_id).toBe(ledger[0]!.trace_id);
      expect(ledger[1]!.trace_id).not.toBeNull();
    } finally { done(w); }
  });

  it("flagget AV skriver fortsatt ingenting (verken ledger- eller gateway-rader, ingen korrelasjon), og en ledger UTEN korrelasjons-getter er byte-identisk med før (task_id/trace_id = NULL)", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const off = runner(w, { ...policyOf(), enabled: false }, { offset: 0 });
    try {
      expect(await off.tick()).toEqual({ sent: false, reason: "disabled" });
      expect(await rowsOf(w.tenant, "true")).toEqual([]);
    } finally { done(w); }
    const bare = createAuditLedger({ pool: app, tenantId: w.tenant, sessionId: "bare" });
    const decision = await bare.claim((state) => ({ send: true, message_key: "v2-push:bare", item_keys: ["k:bare"], items: [{ source_kind: "business_followup", source_id: "x" }], reason: "ok", state } as never));
    expect(decision).toMatchObject({ send: true });
    const rows = await ledgerRows(w.tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "followup.push_reserved", task_id: null, trace_id: null });
  });
});

describe("WP-P3 K5: tikk-korrelatoren (ren funksjon)", () => {
  const at = (iso: string) => () => new Date(iso);

  it("task_id er `sched:v2-push:<UTC-dato>`, trace_id `sched-v2-push-<dato>-a<n>`: kun tegn fra det trygge mønsteret", () => {
    const c = createPushCorrelator(at("2026-11-26T03:17:09.500Z"))();
    expect(c).toEqual({ task_id: "sched:v2-push:2026-11-26", trace_id: `sched-v2-push-2026-11-26-a${3 * 3600 + 17 * 60 + 9 + 1}` });
    expect(c.task_id).toMatch(SAFE_ID);
    expect(c.trace_id).toMatch(SAFE_ID);
  });

  it("strengt økende `n` i samme prosess selv med FAST klokke (samme sekund): ulik trace_id, lik task_id", () => {
    const next = createPushCorrelator(at("2026-11-26T10:00:00.000Z"));
    const a = next(); const b = next(); const c = next();
    expect(new Set([a.trace_id, b.trace_id, c.trace_id]).size).toBe(3);
    expect(new Set([a.task_id, b.task_id, c.task_id]).size).toBe(1);
  });

  it("en omstart samme dag (ny korrelator, senere klokke) gir en annen trace_id enn tikkene før omstarten, og samme task_id", () => {
    const before = createPushCorrelator(at("2026-11-26T10:00:00.000Z"))();
    const after = createPushCorrelator(at("2026-11-26T10:15:00.000Z"))();
    expect(after.task_id).toBe(before.task_id);
    expect(after.trace_id).not.toBe(before.trace_id);
  });

  it("UTC-døgnskifte: ny task_id, og `n` starter på nytt (ingen dragning fra gårsdagen)", () => {
    let now = new Date("2026-11-26T23:59:59.000Z");
    const next = createPushCorrelator(() => now);
    const late = next();
    now = new Date("2026-11-27T00:00:01.000Z");
    const early = next();
    expect(early.task_id).toBe("sched:v2-push:2026-11-27");
    expect(early.task_id).not.toBe(late.task_id);
    expect(early.trace_id).toBe("sched-v2-push-2026-11-27-a2");
  });
});
