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
import { classifyNotifyFailure, localHour, parseFollowUpPushPolicy, type FollowUpPushPolicy, type PushSendGuard } from "@jarvis/executive";
import { InMemoryDeviceRegistry, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { TelegramTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { createPushSendGuard, createTelegramNotifier, startFollowUpPush, type FollowUpPushHandle } from "../src/follow-up-push.ts";

/**
 * WP-C4, H1 (gjennomgang av PR #312): push-løperen mot den EKTE `ToolGateway`, `PolicyGateway`, `TelegramTransport` og ekte Postgres som app-rolle - kun leverandørens HTTP (`fetch`) er en mock. De eksisterende DB-testene bruker en fake
 * gateway som returnerer `postcondition_unverified:*` for tidsavbrudd; den ekte gatewayen returnerer `tool_failed:tool_timeout`, `tool_failed:telegram_error_502` og `tool_failed:fetch failed` for utfall der Telegram HAR mottatt
 * meldingen. Her bevises, for hver slik sti, at pushen leverer HØYST ÉN melding per forfallsperiode, at døgngrense (3) og minsteavstand (60 min) holder, at et stanset system ikke gir forsøk, og at tabellen reason -> frigi/behold
 * (`classifyNotifyFailure`) stemmer med strengene gatewayen faktisk produserer.
 * Klokken til planleggeren injiseres (`now`), mens revisjonsradene får databasens `now()`; derfor flyttes «tid» framover relativt til nå, og rolig tid legges 12 timer unna den virkelige timen.
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

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpc4gw-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpc4gw LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_wpc4gw");
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, 'Tobias') ON CONFLICT DO NOTHING", [OWNER]);
  app = createPool({ ...base, user: "jarvis_wpc4gw", password: "pw2" });
  graph = new ConversationGraphService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Verden: ekte gateway + ekte transport + fetch-mock
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Mode =
  | { kind: "ok" }
  /** Telegram LAGRER meldingen og svarer deretter med en feilstatus (typisk 502 fra en proxy foran Telegram). */
  | { kind: "status_after_delivery"; status: number }
  /** Telegram lagrer meldingen, men forbindelsen brytes før svaret når fram (`fetch failed`). */
  | { kind: "reset_after_delivery" }
  /** Telegram leverer FØRST etter `ms` (etter at gatewayens egen frist er gått ut), og svarer 200. */
  | { kind: "slow_delivery"; ms: number }
  /** Telegram avviser kallet uten å lage en melding. */
  | { kind: "status_no_delivery"; status: number }
  /** Nettverksfeil FØR noe når Telegram. */
  | { kind: "throw_no_delivery"; error: () => Error }
  /** 200 OK og levert, men svarkroppen er ikke JSON. */
  | { kind: "bad_json_after_delivery" };

interface Wire {
  mode: Mode;
  delivered: string[];
  calls: number;
  urls: string[];
}

function installFetch(wire: Wire): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    wire.calls += 1;
    wire.urls.push(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    expect(body.chat_id).toBe(CHAT); // mottakeren er alltid eierens konfigurerte chat
    const deliver = (): void => { wire.delivered.push(String(body.text)); };
    const ok = (): Response => new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + wire.delivered.length } }), { status: 200 });
    const mode = wire.mode;
    switch (mode.kind) {
      case "ok": deliver(); return ok();
      case "status_after_delivery": deliver(); return new Response("bad gateway", { status: mode.status });
      case "reset_after_delivery": deliver(); throw new TypeError("fetch failed");
      case "slow_delivery": await new Promise((r) => setTimeout(r, mode.ms)); deliver(); return ok();
      case "status_no_delivery": return new Response(JSON.stringify({ ok: false }), { status: mode.status });
      case "throw_no_delivery": throw mode.error();
      case "bad_json_after_delivery": deliver(); return new Response("<html>ikke json</html>", { status: 200 });
    }
  });
}

interface World {
  tenant: string;
  identity: IdentityContext;
  wire: Wire;
  killSwitch: KillSwitch;
  controls: OwnerControls;
  infraGate: InfraExecutionGate;
  gateway: ToolGateway;
  guard: PushSendGuard;
  handles: FollowUpPushHandle[];
}

const mkTenant = async (): Promise<string> => {
  const id = `tenant-pushgw-${++seq}`;
  await admin.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $1, 'person')", [id]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, $2)", [OWNER, id]);
  return id;
};
const identityFor = (tenant: string, over: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: OWNER, tenant_id: tenant, memory_space_id: "personal", session_id: `sess-sys-brief-${tenant}`, device_id: "jarvis-core", channel: "api", auth_strength: "active", ...over
});

/** Bygger den samme kjeden som `main.ts`: PolicyGateway (med eier-autoritet), OwnerControls, ToolGateway med credential-binding og den ekte `telegram.notify`-definisjonen. */
async function makeWorld(opts: { gatewayTimeoutMs?: number; token?: string | null; chatId?: string | null; mode?: Mode; registerTelegram?: boolean; infraIncludesTelegram?: boolean } = {}): Promise<World> {
  const tenant = await mkTenant();
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const infraGate = new InfraExecutionGate();
  const infraToolIds = opts.infraIncludesTelegram === true ? new Set(["github", "docker", "telegram"]) : new Set(["github", "docker"]);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch, controls, infraGate, infraToolIds,
    authority: { owner_person_id: OWNER, owner_tenants: [tenant] }
  });
  const token = opts.token === undefined ? TOKEN : opts.token;
  const secrets: SecretProvider = { name: "test", async get(ref) { return ref === "JARVIS_TELEGRAM_TOKEN" ? token : null; } };
  const gateway = new ToolGateway(app, policy, secrets, controls, undefined, { credentialBinding: { owner_person_id: OWNER, owner_tenants: [tenant], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) } });
  const chatId = opts.chatId === undefined ? CHAT : opts.chatId;
  if (opts.registerTelegram !== false) {
    for (const tool of firstWaveTools({ telegram: new TelegramTransport(async () => chatId) })) {
      if (tool.tool_id === "telegram" && tool.action === "notify") gateway.register(opts.gatewayTimeoutMs !== undefined ? { ...tool, timeout_ms: opts.gatewayTimeoutMs } : tool);
    }
  }
  const wire: Wire = { mode: opts.mode ?? { kind: "ok" }, delivered: [], calls: 0, urls: [] };
  installFetch(wire);
  return { tenant, identity: identityFor(tenant), wire, killSwitch, controls, infraGate, gateway, guard: createPushSendGuard({ killSwitch, controls, infraGate, infraToolIds }), handles: [] };
}

/** Åpen policy: ingen minsteavstand, rolig tid 12 timer unna den virkelige timen (klokken flyttes høyst et døgn og litt). */
const policyOf = (over: Partial<FollowUpPushPolicy> = {}): FollowUpPushPolicy => {
  const h = localHour(new Date(), "Europe/Oslo");
  return { ...parseFollowUpPushPolicy({ JARVIS_V2_PUSH_ENABLED: "true" }), min_gap_minutes: 0, quiet_start_hour: (h + 12) % 24, quiet_end_hour: (h + 13) % 24, ...over };
};

/** Startet løper med flyttbar klokke: `clock.offset` (ms) legges til den virkelige tiden. */
function runner(world: World, policy: FollowUpPushPolicy, opts: { guard?: PushSendGuard; gateway?: Pick<ToolGateway, "execute"> } = {}) {
  const clock = { offset: 0 };
  const logs: Array<Record<string, unknown>> = [];
  const handle = startFollowUpPush({
    pool: app, graph, gateway: opts.gateway ?? world.gateway, ownerIdentity: world.identity, policy, guard: opts.guard ?? world.guard,
    now: () => new Date(Date.now() + clock.offset), log: (e) => { logs.push(e); }, tickMs: 3_600_000
  });
  world.handles.push(handle);
  return { clock, logs, handle, tick: () => handle.tick() };
}
const done = (world: World): void => { for (const h of world.handles) h.stop(); };

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const followup = (tenant: string, label: string, dueOffsetMs: number, title: string) =>
  admin.query(
    `INSERT INTO business_followups (followup_id, tenant_id, memory_space_id, title, reason, next_action, due_at, priority, status) VALUES ($1,$2,'business',$3,'grunn','neste',$4,'normal','open')`,
    [`${tenant}-${label}`, tenant, title, iso(dueOffsetMs)]
  );
const auditTypes = async (tenant: string, like: string): Promise<string[]> =>
  (await admin.query("SELECT type FROM audit_events WHERE tenant_id = $1 AND type LIKE $2 ORDER BY audit_id", [tenant, like])).rows.map((r: { type: string }) => r.type);
const ledgerTypes = (tenant: string) => auditTypes(tenant, "followup.push_%");
const execRow = async (key: string) =>
  (await admin.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;
const count = (texts: readonly string[], needle: string): number => texts.filter((t) => t.includes(needle)).length;
const label = (r: Awaited<ReturnType<FollowUpPushHandle["tick"]>>): string => (r.sent ? "sent" : r.reason);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// H1: høyst én levert melding per forfallsperiode, uansett hvordan leverandørkallet ender
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("WP-C4 H1 - ekte gateway: usikkert utfall sender aldri samme sak to ganger", () => {
  it("S1: Telegram mottar meldingen men svarer 502 - tre tikk gir ÉN levert melding (før rettelsen: tre identiske)", async () => {
    const w = await makeWorld({ mode: { kind: "status_after_delivery", status: 502 } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown", settled: true });
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(w.wire.delivered).toHaveLength(1);
      expect(w.wire.calls).toBe(1);
      expect(await ledgerTypes(w.tenant)).toEqual(["followup.push_reserved", "followup.push_unknown"]);
      // gatewayen selv ville gjenutført kallet (raden står som 'failed' = re-armbar) - det er pushen som ikke ber om det
      const reserved = (await admin.query("SELECT payload->>'message_key' AS k FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_reserved'", [w.tenant])).rows[0] as { k: string };
      expect((await execRow(reserved.k))?.status).toBe("failed");
      const unknown = (await admin.query("SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_unknown'", [w.tenant])).rows[0] as { reason: string };
      expect(unknown.reason).toBe("tool_failed:telegram_error_502");
    } finally { done(w); }
  });

  it("S2: nettverksbrudd ETTER sending (fetch failed) - tre tikk gir ÉN levert melding (før: to)", async () => {
    const w = await makeWorld({ mode: { kind: "reset_after_delivery" } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown" });
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(w.wire.delivered).toHaveLength(1);
      expect(w.wire.calls).toBe(1);
    } finally { done(w); }
  });

  it("S10: gateway-timeout (Telegram leverer ETTER fristen), så en NY forfalt sak - «Sak Alfa» sendes aldri en gang til, bare «Sak Beta» (før: Alfa to ganger med ulik idempotensnøkkel)", async () => {
    const w = await makeWorld({ gatewayTimeoutMs: 80, mode: { kind: "slow_delivery", ms: 300 } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown", settled: true });
      const unknown = (await admin.query("SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_unknown'", [w.tenant])).rows[0] as { reason: string };
      expect(unknown.reason).toBe("tool_failed:tool_timeout"); // den ekte gatewayen: «tool_failed», ikke «postcondition_unverified»
      await vi.waitFor(() => expect(w.wire.delivered).toHaveLength(1), { timeout: 5000 }); // Telegram leverte likevel
      await followup(w.tenant, "beta", -1 * DAY, "Sak Beta");
      w.wire.mode = { kind: "ok" };
      expect(await r.tick()).toMatchObject({ sent: true });
      expect(w.wire.delivered).toHaveLength(2);
      expect(count(w.wire.delivered, "Sak Alfa")).toBe(1);
      expect(count(w.wire.delivered, "Sak Beta")).toBe(1);
      expect(w.wire.delivered[1]).not.toContain("Sak Alfa");
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
    } finally { done(w); }
  });

  it.each([500, 502, 503, 504, 520])("5xx (%i) - både MED og UTEN levering sendes ingenting to ganger (en tapt påminnelse er restrisikoen, en duplikat er det ikke)", async (status) => {
    for (const kind of ["status_after_delivery", "status_no_delivery"] as const) {
      const w = await makeWorld({ mode: { kind, status } });
      await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
      const r = runner(w, policyOf());
      try {
        expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown" });
        for (let i = 0; i < 3; i += 1) expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
        expect(w.wire.calls, `${kind} ${status}`).toBe(1);
        expect(w.wire.delivered.length, `${kind} ${status}`).toBe(kind === "status_after_delivery" ? 1 : 0);
      } finally { done(w); }
    }
  });

  it("200 OK med levert melding men svarkropp som ikke er JSON (tool_failed:<parse-feil>) - ingen ny sending", async () => {
    const w = await makeWorld({ mode: { kind: "bad_json_after_delivery" } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown" });
      expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(w.wire.delivered).toHaveLength(1);
    } finally { done(w); }
  });

  it("gatewayens ledger-rad står som 'reserved' (utfall ukjent, f.eks. etter et krasj): execution_in_flight_or_outcome_unknown beholder reservasjonen - ingen ny sending", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    // Den ekte gatewayen, men raden for pushens idempotensnøkkel er allerede reservert (som om et tidligere kall krasjet midt i flukt).
    const inFlight: Pick<ToolGateway, "execute"> = {
      async execute(req) {
        await admin.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, 'telegram', 'notify', 'reserved') ON CONFLICT DO NOTHING", [w.tenant, req.idempotency_key]);
        return w.gateway.execute(req);
      }
    };
    const r = runner(w, policyOf(), { gateway: inFlight });
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_unknown", settled: true });
      const unknown = (await admin.query("SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_unknown'", [w.tenant])).rows[0] as { reason: string };
      expect(unknown.reason).toBe("execution_in_flight_or_outcome_unknown");
      for (let i = 0; i < 3; i += 1) expect(await r.tick()).toEqual({ sent: false, reason: "nothing_new" });
      expect(w.wire.calls).toBe(0); // en tapt påminnelse er restrisikoen - aldri en duplikat
    } finally { done(w); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Døgngrense og minsteavstand holder når utfallet er usikkert
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("WP-C4 H1 - ekte gateway: døgngrense (3) og minsteavstand (60 min) omgås ikke av usikre utfall", () => {
  it("minsteavstand: etter en 502-med-levering gir en NY forfalt sak min_gap innen 60 min, og sendes først etter 61 min - og da uten den første saken", async () => {
    const w = await makeWorld({ mode: { kind: "status_after_delivery", status: 502 } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf({ min_gap_minutes: 60 }));
    try {
      expect(label(await r.tick())).toBe("send_unknown");
      await followup(w.tenant, "beta", -1 * DAY, "Sak Beta");
      r.clock.offset = 30 * MIN;
      expect(label(await r.tick())).toBe("min_gap");
      expect(w.wire.calls).toBe(1);
      r.clock.offset = 61 * MIN;
      expect(label(await r.tick())).toBe("send_unknown");
      expect(count(w.wire.delivered, "Sak Alfa")).toBe(1);
      expect(count(w.wire.delivered, "Sak Beta")).toBe(1);
      expect(w.wire.delivered[1]).not.toContain("Sak Alfa");
    } finally { done(w); }
  });

  it("døgngrense: tre usikre meldinger i løpet av dagen fyller kvoten - den fjerde nektes (rate_limited) og fetch kalles aldri mer; neste døgn åpner igjen", async () => {
    const w = await makeWorld({ mode: { kind: "status_after_delivery", status: 502 } });
    const r = runner(w, policyOf({ min_gap_minutes: 60, max_messages_per_day: 3 }));
    try {
      const results: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        await followup(w.tenant, `s${i}`, -(i + 1) * DAY, `Sak nummer ${i}`);
        r.clock.offset = i * 61 * MIN;
        results.push(label(await r.tick()));
      }
      expect(results).toEqual(["send_unknown", "send_unknown", "send_unknown", "rate_limited", "rate_limited"]);
      expect(w.wire.calls).toBe(3);
      expect(w.wire.delivered).toHaveLength(3);
      r.clock.offset = 26 * HOUR; // de tre første meldingene er nå eldre enn 24 t
      expect(label(await r.tick())).toBe("send_unknown");
      expect(w.wire.calls).toBe(4);
      expect(count(w.wire.delivered, "Sak nummer 1")).toBeLessThanOrEqual(1);
      expect(count(w.wire.delivered, "Sak nummer 2")).toBeLessThanOrEqual(1);
    } finally { done(w); }
  });

  it("hver sak leveres høyst én gang over en hel uke med vedvarende 5xx-med-levering (96 kopier i døgnet før rettelsen)", async () => {
    const w = await makeWorld({ mode: { kind: "status_after_delivery", status: 502 } });
    await followup(w.tenant, "alfa", -1 * HOUR, "Sak Alfa");
    const r = runner(w, policyOf({ min_gap_minutes: 60, max_messages_per_day: 20 }));
    try {
      for (let minute = 0; minute <= 3 * 24 * 60; minute += 15) { // tikk hvert kvarter i tre døgn
        r.clock.offset = minute * MIN;
        await r.tick();
      }
      expect(count(w.wire.delivered, "Sak Alfa")).toBe(1);
      expect(w.wire.calls).toBe(1);
    } finally { done(w); }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Bevist «ikke sendt»: frigis, men med tak og backoff (M1)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("WP-C4 M1 - ekte gateway: bevist avvist sending frigis med backoff og tak", () => {
  it.each([400, 401, 403, 404, 429])("HTTP %i fra Telegram (ingen melding opprettet): tre forsøk med SAMME idempotensnøkkel, så attempts_exhausted - ikke 96 kall i døgnet (S4)", async (status) => {
    const w = await makeWorld({ mode: { kind: "status_no_delivery", status } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(label(await r.tick())).toBe("send_failed");
      expect(label(await r.tick())).toBe("backoff"); // rett etter: 15 min backoff
      r.clock.offset = 16 * MIN;
      expect(label(await r.tick())).toBe("send_failed");
      r.clock.offset = 16 * MIN + 30 * MIN;
      expect(label(await r.tick())).toBe("backoff"); // 60 min etter andre feil
      r.clock.offset = 16 * MIN + 61 * MIN;
      expect(label(await r.tick())).toBe("send_failed"); // tredje forsøk
      for (const hours of [2, 6, 11, 20]) {
        r.clock.offset = hours * HOUR;
        expect(label(await r.tick())).toBe("attempts_exhausted");
      }
      expect(w.wire.calls).toBe(3);
      expect(w.wire.delivered).toEqual([]);
      expect(r.handle.status()).toMatchObject({ last_result: "attempts_exhausted", attempts_exhausted_message: expect.stringMatching(/^v2-push:[0-9a-f]{40}$/) });
      expect(r.logs.filter((l) => l["result"] === "attempts_exhausted")).toHaveLength(1);
      const types = await ledgerTypes(w.tenant);
      expect(types.filter((t) => t === "followup.push_reserved")).toHaveLength(3);
      expect(types.filter((t) => t === "followup.push_failed")).toHaveLength(3);
      // alle tre forsøk brukte nøyaktig én idempotensnøkkel (gatewayen re-armerer 'failed'-raden)
      const keys = (await admin.query("SELECT DISTINCT payload->>'message_key' AS k FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_reserved'", [w.tenant])).rows as Array<{ k: string }>;
      expect(keys).toHaveLength(1);
      expect((await execRow(keys[0]!.k))?.status).toBe("failed");
    } finally { done(w); }
  });

  it("når feilen rettes (Telegram tar imot igjen) etter et døgn, leveres saken nøyaktig én gang", async () => {
    const w = await makeWorld({ mode: { kind: "status_no_delivery", status: 403 } });
    await followup(w.tenant, "alfa", -1 * HOUR, "Sak Alfa");
    const r = runner(w, policyOf({ stale_overdue_days: 30 }));
    try {
      for (const minutes of [0, 16, 16 + 61]) { r.clock.offset = minutes * MIN; await r.tick(); }
      expect(w.wire.calls).toBe(3);
      w.wire.mode = { kind: "ok" };
      r.clock.offset = 6 * HOUR;
      expect(label(await r.tick())).toBe("attempts_exhausted"); // fortsatt stille innenfor døgnet, selv om Telegram nå virker
      r.clock.offset = 25 * HOUR;
      expect(label(await r.tick())).toBe("sent");
      expect(w.wire.delivered).toHaveLength(1);
      r.clock.offset = 26 * HOUR;
      expect(label(await r.tick())).toBe("nothing_new");
    } finally { done(w); }
  });

  it("manglende chat-id (kastes før noen forespørsel): bevist ikke sendt, fetch kalles aldri, og forsøkene har tak", async () => {
    const w = await makeWorld({ chatId: null });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      expect(label(await r.tick())).toBe("send_failed");
      const failed = (await admin.query("SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'followup.push_failed'", [w.tenant])).rows[0] as { reason: string };
      expect(failed.reason).toBe("tool_failed:telegram_chat_id_not_configured");
      for (const minutes of [16, 16 + 61]) { r.clock.offset = minutes * MIN; expect(label(await r.tick())).toBe("send_failed"); }
      r.clock.offset = 3 * HOUR;
      expect(label(await r.tick())).toBe("attempts_exhausted");
      expect(w.wire.calls).toBe(0);
    } finally { done(w); }
  });

  it("race: stoppsjekken er åpen, men kill switch slås på før gatewayen kalles - gatewayen avslår (kill_switch_active), forsøket frigis, og saken leveres ÉN gang etter at bryteren er av", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    w.killSwitch.activate("test");
    const r = runner(w, policyOf(), { guard: { blocked: async () => null } }); // en stoppsjekk som ikke fanger det (løpet mellom sjekk og kall)
    try {
      expect(await r.tick()).toMatchObject({ sent: false, reason: "send_failed" });
      expect(w.wire.calls).toBe(0);
      expect(await auditTypes(w.tenant, "tool.denied")).toEqual(["tool.denied"]);
      w.killSwitch.deactivate();
      r.clock.offset = 20 * MIN;
      expect(label(await r.tick())).toBe("sent");
      r.clock.offset = 40 * MIN;
      expect(label(await r.tick())).toBe("nothing_new");
      expect(w.wire.delivered).toHaveLength(1);
    } finally { done(w); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Stopp FØR reservasjon med de ekte bryterne
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("WP-C4 M1(a) - ekte bryterne stanser løperen før noe reserveres", () => {
  it("kill switch på: seks tikk gir ingen push-rader, ingen tool.denied, ingen tool.failed, ingen fetch (S3) - og straks etter at bryteren er av sendes meldingen", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    w.killSwitch.activate("test");
    const r = runner(w, policyOf());
    try {
      for (let i = 0; i < 6; i += 1) expect(await r.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "kill_switch_active" });
      expect(w.wire.calls).toBe(0);
      expect(await ledgerTypes(w.tenant)).toEqual([]);
      expect(await auditTypes(w.tenant, "tool.%")).toEqual([]);
      expect(r.handle.status()).toMatchObject({ last_result: "send_blocked", blocked_by: "kill_switch_active" });
      w.killSwitch.deactivate();
      expect(label(await r.tick())).toBe("sent");
      expect(w.wire.delivered).toHaveLength(1);
    } finally { done(w); }
  });

  it("frosset connector `telegram` og tilbakekalt credential stanser også før reservasjon, og slippes igjen ved gjenoppretting", async () => {
    const w = await makeWorld();
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      w.controls.freezeConnector("telegram");
      expect(await r.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "connector_frozen" });
      w.controls.unfreezeConnector("telegram");
      w.controls.revokeCredential("JARVIS_TELEGRAM_TOKEN");
      expect(await r.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "credential_revoked" });
      expect(w.wire.calls).toBe(0);
      expect(await ledgerTypes(w.tenant)).toEqual([]);
      w.controls.restoreCredential("JARVIS_TELEGRAM_TOKEN");
      expect(label(await r.tick())).toBe("sent");
    } finally { done(w); }
  });

  it("infra-modus PAUSED stanser løperen bare når telegram er blant infra-verktøyene (ellers er det et no-op, som i PolicyGateway)", async () => {
    const off = await makeWorld();
    await followup(off.tenant, "alfa", -2 * DAY, "Sak Alfa");
    off.infraGate.pause("test");
    const rOff = runner(off, policyOf());
    const on = await makeWorld({ infraIncludesTelegram: true });
    await followup(on.tenant, "alfa", -2 * DAY, "Sak Alfa");
    on.infraGate.pause("test");
    const rOn = runner(on, policyOf());
    try {
      expect(label(await rOff.tick())).toBe("sent");
      expect(await rOn.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "infra_paused" });
    } finally { done(off); done(on); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Kontrakt: tabellen reason -> frigi/behold stemmer med strengene den EKTE gatewayen produserer
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("WP-C4 H1 - kontrakt: strengene den ekte gatewayen gir, klassifisert", () => {
  const MSG = "Oppfølging fra Jarvis: 1 sak trenger deg.";
  const notify = (w: World, key: string, identity: IdentityContext = w.identity) => createTelegramNotifier({ gateway: w.gateway, identity }).notify(MSG, { idempotency_key: key });
  const reasonOf = async (outcome: Promise<Awaited<ReturnType<ReturnType<typeof createTelegramNotifier>["notify"]>>>): Promise<string> => {
    const o = await outcome;
    if (o.ok) throw new Error("forventet ikke-ok");
    return o.reason;
  };
  const NOT_SENT = "not_sent";

  it("avslag FØR transport (kill switch, frys, tilbakekalt/manglende credential, annen identitet, ukjent verktøy, ugyldige parametre, rate limit, infra-pause) er alle bevist «ikke sendt» - og fetch ble aldri kalt", async () => {
    const seen = new Map<string, string>();
    const record = (expected: string, got: string) => { seen.set(expected, got); expect(got).toBe(expected); };

    let w = await makeWorld();
    w.killSwitch.activate("test");
    record("kill_switch_active", await reasonOf(notify(w, "k1")));
    w = await makeWorld();
    w.controls.freezeConnector("telegram");
    record("connector_frozen", await reasonOf(notify(w, "k2")));
    w = await makeWorld();
    w.controls.revokeCredential("JARVIS_TELEGRAM_TOKEN");
    record("credential_revoked", await reasonOf(notify(w, "k3")));
    w = await makeWorld({ token: null });
    record("credential_unavailable", await reasonOf(notify(w, "k4")));
    w = await makeWorld();
    record("credential_not_bound_to_identity", await reasonOf(notify(w, "k5", identityFor(w.tenant, { person_id: "person-fremmed" }))));
    w = await makeWorld({ registerTelegram: false });
    record("unknown_tool", await reasonOf(notify(w, "k6")));
    w = await makeWorld();
    const tooLong = await w.gateway.execute({ identity: w.identity, tool_id: "telegram", action: "notify", parameters: { message: "x".repeat(4001) }, idempotency_key: "k7" });
    record("invalid_parameters", tooLong.ok ? "ok" : tooLong.reason);
    w = await makeWorld({ infraIncludesTelegram: true });
    w.infraGate.pause("test");
    record("infra_paused", await reasonOf(notify(w, "k8")));
    w = await makeWorld();
    let last = "";
    for (let i = 0; i < 21; i += 1) { const o = await notify(w, `rl-${i}`); if (!o.ok) last = o.reason; }
    record("rate_limited", last);
    // svak autentisering for en annen enn eieren, uten credential-binding: policyen avslår klasse B (egen gateway uten binding)
    const bare = await makeWorld();
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [bare.tenant] } });
    const unbound = new ToolGateway(app, policy, { name: "test", async get() { return TOKEN; } });
    for (const tool of firstWaveTools({ telegram: new TelegramTransport(async () => CHAT) })) if (tool.tool_id === "telegram" && tool.action === "notify") unbound.register(tool);
    const passive = await unbound.execute({ identity: identityFor(bare.tenant, { person_id: "person-fremmed", auth_strength: "passive" }), tool_id: "telegram", action: "notify", parameters: { message: MSG }, idempotency_key: "k9" });
    record("class_b_requires_active_auth", passive.ok ? "ok" : passive.reason);

    expect(bare.wire.calls).toBe(0);
    for (const [reason] of seen) expect(classifyNotifyFailure(reason), reason).toBe(NOT_SENT);
    expect([...seen.keys()].sort()).toEqual(["class_b_requires_active_auth", "connector_frozen", "credential_not_bound_to_identity", "credential_revoked", "credential_unavailable", "infra_paused", "invalid_parameters", "kill_switch_active", "rate_limited", "unknown_tool"]);
  });

  it("avslag FRA transporten som beviser at ingenting gikk ut (chat-id mangler, ugyldig URL/token, Telegram 400/401/403/404/429) er «ikke sendt»", async () => {
    let w = await makeWorld({ chatId: null });
    expect(await reasonOf(notify(w, "t1"))).toBe("tool_failed:telegram_chat_id_not_configured");
    expect(w.wire.calls).toBe(0);
    w = await makeWorld({ token: "ugyldig token/med mellomrom og skråstrek" });
    const unsafe = await reasonOf(notify(w, "t2"));
    expect(unsafe).toMatch(/^tool_failed:unsafe_vendor_url:/);
    expect(w.wire.calls).toBe(0);
    for (const status of [400, 401, 403, 404, 429]) {
      w = await makeWorld({ mode: { kind: "status_no_delivery", status } });
      expect(await reasonOf(notify(w, `t-${status}`))).toBe(`tool_failed:telegram_error_${status}`);
    }
    for (const reason of ["tool_failed:telegram_chat_id_not_configured", unsafe, ...[400, 401, 403, 404, 429].map((s) => `tool_failed:telegram_error_${s}`)]) expect(classifyNotifyFailure(reason), reason).toBe(NOT_SENT);
  });

  it("utfall der meldingen KAN ha gått ut (5xx, nettverksbrudd, fetch-frist, gateway-frist, ugyldig svar, gjentatt kall etter frist, rad i flukt) er alle «ukjent» - behold reservasjonen", async () => {
    const reasons: string[] = [];
    for (const status of [500, 502, 503, 504]) {
      const w = await makeWorld({ mode: { kind: "status_after_delivery", status } });
      reasons.push(await reasonOf(notify(w, `u-${status}`)));
    }
    let w = await makeWorld({ mode: { kind: "reset_after_delivery" } });
    reasons.push(await reasonOf(notify(w, "u-reset")));
    w = await makeWorld({ mode: { kind: "throw_no_delivery", error: () => new DOMException("The operation was aborted due to timeout", "TimeoutError") } });
    reasons.push(await reasonOf(notify(w, "u-abort")));
    w = await makeWorld({ mode: { kind: "bad_json_after_delivery" } });
    reasons.push(await reasonOf(notify(w, "u-json")));
    w = await makeWorld({ gatewayTimeoutMs: 60, mode: { kind: "slow_delivery", ms: 250 } });
    reasons.push(await reasonOf(notify(w, "u-timeout")));
    reasons.push(await reasonOf(notify(w, "u-timeout"))); // gjentatt kall med samme nøkkel etter frist -> gatewayen gjengir utfallet «ukjent»
    await vi.waitFor(() => expect(w.wire.delivered).toHaveLength(1), { timeout: 5000 });
    w = await makeWorld();
    await admin.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, 'u-flight', 'telegram', 'notify', 'reserved')", [w.tenant]);
    reasons.push(await reasonOf(notify(w, "u-flight")));

    expect(reasons).toEqual([
      "tool_failed:telegram_error_500", "tool_failed:telegram_error_502", "tool_failed:telegram_error_503", "tool_failed:telegram_error_504",
      "tool_failed:fetch failed", "tool_failed:The operation was aborted due to timeout", expect.stringMatching(/^tool_failed:.*JSON/i),
      "tool_failed:tool_timeout", "postcondition_unverified:tool_timeout_outcome_unknown", "execution_in_flight_or_outcome_unknown"
    ]);
    for (const reason of reasons) expect(classifyNotifyFailure(reason), reason).toBe("unknown");
  });

  it("ingen hemmeligheter: verken token, chat-id eller meldingstekst finnes i revisjonsspor eller logg etter en feilsekvens", async () => {
    const w = await makeWorld({ mode: { kind: "status_after_delivery", status: 502 } });
    await followup(w.tenant, "alfa", -2 * DAY, "Sak Alfa");
    const r = runner(w, policyOf());
    try {
      await r.tick();
      const rows = await admin.query("SELECT type, reason, payload, tool_id, action FROM audit_events WHERE tenant_id = $1", [w.tenant]);
      const everything = JSON.stringify([rows.rows, r.logs, r.handle.status()]);
      for (const secret of [TOKEN, "TEST-TOKEN", `chat_id`, "Sak Alfa"]) expect(everything).not.toContain(secret);
      expect(w.wire.urls.every((u) => u.startsWith("https://api.telegram.org/bot"))).toBe(true);
    } finally { done(w); }
  });
});
