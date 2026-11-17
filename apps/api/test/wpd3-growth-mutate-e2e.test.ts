import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { GrowthWriteJournal, createGrowthWriteTransports, growthOpIndex, growthWriteConfigFromEnv, growthWriteSpecs, growthWriteToolDefinitions } from "@jarvis/growth";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-D3 review L7 (D-459): ENDE-TIL-ENDE over HTTP for `/growth/mutate`, `/growth/read` og `/growth/writes/list` mot den EKTE API-serveren (`createApiServer`), den EKTE `ToolGateway` (policy, eier-binding, klasse D-kjede,
 * ledger) og EKTE Postgres (RLS som ikke-superbruker) - kun leverandøren (Google Ads) er en lokal, tilstandsfull falsk. Grant-verifiseringen (`grants.verify`) er det eneste som er en testdobbel: signaturbeviset selv er
 * dekket av `d131-authority-hardening-e2e` og `part3-step-up`; alt ETTER grant-et (eier-porten, step-up, målautorisasjon, journal, utfall) kjører ekte. Bevist: rekkefølgen grant -> eier -> step-up -> kjede, at en svak økt/gjest/
 * feil kanal aldri når leverandøren, utført endring + journal + varsel, replay uten ny mutasjon, ukjent utfall over HTTP, og at lese-ruten kun når klasse A.
 */
const TENANT = "tenant-wpd3-e2e";
const OWNER = "person-wpd3-e2e-owner";
const GUEST = "person-wpd3-e2e-guest";
const CID = "1234567890";

/** token -> grant (samme form som `GrantVerification`): signert eier fra web/desktop, svakere økter, andre kanaler og en gjest. */
const GRANTS: Record<string, { person_id: string; tenant_id: string; memory_space: string; session_id: string; device_id: string; channel: string; auth_strength: string }> = {
  "owner-signed": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-own", device_id: "dev-own", channel: "web", auth_strength: "signed" },
  "owner-desktop": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-own2", device_id: "dev-own", channel: "desktop", auth_strength: "signed" },
  "owner-active": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-act", device_id: "dev-own", channel: "web", auth_strength: "active" },
  "owner-telegram": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-tg", device_id: "dev-own", channel: "telegram", auth_strength: "signed" },
  "owner-voice": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-vo", device_id: "dev-own", channel: "voice", auth_strength: "signed" },
  "guest-signed": { person_id: GUEST, tenant_id: TENANT, memory_space: "business", session_id: "s-gu", device_id: "dev-gu", channel: "web", auth_strength: "signed" }
};

/** Minimal tilstandsfull Google Ads-falsk (kampanje 101 med dagsbudsjett) som registrerer alle forespørsler. */
class MiniGoogleAds {
  micros = 500_000_000;
  status = "ENABLED";
  destroyMutations = false;
  readonly requests: Array<{ path: string; body: Record<string, any> }> = [];
  baseUrl = "";
  private server: Server | undefined;
  mutations = (): number => this.requests.filter((r) => r.path.endsWith(":mutate")).length;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: Record<string, any> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        this.requests.push({ path, body });
        res.setHeader("content-type", "application/json");
        if (path === `/v25/customers/${CID}/googleAds:search`) {
          const found = /campaign\.id = 101/.test(String(body["query"] ?? ""));
          res.end(JSON.stringify({ results: found ? [{ campaign: { id: "101", name: "Sommerkampanje", status: this.status, servingStatus: "SERVING", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC" }, campaignBudget: { id: "11", amountMicros: String(this.micros), explicitlyShared: false }, customer: { currencyCode: "NOK" } }] : [] }));
          return;
        }
        if (path === `/v25/customers/${CID}/campaignBudgets:mutate`) {
          this.micros = Number(body["operations"][0].update.amountMicros);
          if (this.destroyMutations) { req.socket.destroy(); return; }
          res.end(JSON.stringify({ results: [{ resourceName: body["operations"][0].update.resourceName }] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { status: "NOT_FOUND", message: "no route" } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve())); }
}

let stopPg: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let url = "";
let close: () => Promise<void>;
const vendor = new MiniGoogleAds();
const notifications: ClassDNotification[] = [];
let keySeq = 0;
const uniqKey = (p: string): string => `${p}-e2e-${(keySeq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd3-e2e-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopPg = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd3_e2e LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd3_e2e");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPD3 e2e', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${GUEST}', 'Gjest');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}'), ('${GUEST}', '${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd3_e2e", password: "pw2" });
  await vendor.start();

  const config = growthWriteConfigFromEnv({ JARVIS_GROWTH_WRITE_PLATFORMS: "google_ads", JARVIS_GROWTH_WRITE_TARGETS: "google_ads:123-456-7890", JARVIS_GROWTH_CREATIVE_URL_HOSTS: "example.test" });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT] } });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-credential-for-test" };
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (n) => { notifications.push(n); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const transports = createGrowthWriteTransports(config, {
    readSecret: async () => null, env: {}, googleAccessToken: async () => "fake-access-token", sleep: async () => undefined, financeKillSwitch: async () => false, baseUrls: { google_ads: vendor.baseUrl }
  });
  for (const def of growthWriteToolDefinitions(config, transports)) gateway.register(def);

  const deps = {
    grants: { verify: async (token: string) => (GRANTS[token] ? { ok: true, grant: GRANTS[token] } : { ok: false, reason: "grant_invalid" }) },
    identity: {
      resolveIdentity: async (i: Record<string, string>) => ({
        ok: true,
        identity: { person_id: i["person_id"], tenant_id: i["tenant_id"], memory_space_id: i["memory_space"], session_id: i["session_id"], device_id: i["device_id"], channel: i["channel"], auth_strength: i["auth_strength"] }
      })
    },
    incidents: { pool: appPool },
    ownerGate: (identity: { person_id: string; tenant_id: string }) => identity.person_id === OWNER && identity.tenant_id === TENANT,
    growthWrites: { executor: { pool: appPool, gateway, journal: new GrowthWriteJournal(appPool), index: growthOpIndex(growthWriteSpecs(config)) }, writes: true, experiments: false }
  } as unknown as ApiDeps;
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
}, 240_000);

afterAll(async () => {
  await close?.();
  await vendor.stop();
  await appPool?.end();
  await adminPool?.end();
  await stopPg?.();
}, 120_000);

beforeEach(() => {
  vendor.requests.length = 0; vendor.micros = 500_000_000; vendor.status = "ENABLED"; vendor.destroyMutations = false; notifications.length = 0;
});

type Json = Record<string, any>;
const post = async (path: string, body: unknown): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
};
const budget = (token: string, amount: number, extra: Json = {}) =>
  post("/growth/mutate", { grant_token: token, provider: "google_ads", action: "set_campaign_budget", parameters: { customer_id: CID, campaign_id: "101", amount_ore: amount }, idempotency_key: uniqKey("budget"), ...extra });

describe("A: forespørselens form og portene FØR leverandøren (rekkefølge: grant -> eier -> step-up -> kjede)", () => {
  it("uten grant 401, ugyldig grant 403, identitetsfelt/ukjent felt 400 - ingenting sendes", async () => {
    expect((await post("/growth/mutate", { provider: "google_ads", action: "pause_campaign", parameters: {}, idempotency_key: "route-probe-0001" })).status).toBe(401);
    expect((await budget("ugyldig-grant", 40_000)).status).toBe(403);
    const identity = await post("/growth/mutate", { grant_token: "owner-signed", provider: "google_ads", action: "pause_campaign", parameters: {}, idempotency_key: "route-probe-0002", tenant_id: "x" });
    expect(identity.status).toBe(400);
    expect(identity.body["error"]).toBe("identity_field_forbidden");
    expect((await post("/growth/mutate", { grant_token: "owner-signed", provider: "google_ads", action: "pause_campaign", parameters: {}, idempotency_key: "route-probe-0003", ekstra: 1 })).status).toBe(400);
    expect(vendor.requests).toHaveLength(0);
  });

  it("gjest (ikke eier) nektes; svak økt, Telegram og tale nektes av step-up - og leverandøren får ingenting", async () => {
    const guest = await budget("guest-signed", 40_000);
    expect(guest.status).toBe(403);
    expect(guest.body["error"]).toBe("owner_required");
    for (const [token, reason] of [["owner-active", "step_up_required:signed_device_session"], ["owner-telegram", "step_up_required:channel_telegram_not_allowed"], ["owner-voice", "step_up_required:channel_voice_not_allowed"]] as const) {
      const res = await budget(token, 40_000);
      expect(res.status, token).toBe(403);
      expect(res.body["error"], token).toBe("step_up_required");
      expect(res.body["reason"], token).toBe(reason);
    }
    expect(vendor.requests).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});

describe("B: eierens signerte økt - utført, journalført, varslet og idempotent over HTTP", () => {
  it("budsjett NED: 200 SUCCESS med journalrad (applied, klasse D, før/etter), leverandøren er endret, eieren varslet; replay med samme nøkkel gir `replayed` uten ny mutasjon", async () => {
    const key = uniqKey("e2e-budget");
    const first = await budget("owner-signed", 40_000, { idempotency_key: key });
    expect(first.status).toBe(200);
    const exec = first.body["execution"];
    expect(exec).toMatchObject({ outcome: "SUCCESS", replayed: false });
    expect(exec.write).toMatchObject({ status: "applied", risk_class: "D", provider: "google_ads", action: "set_campaign_budget", actor_person_id: OWNER, source: "owner_route", session_id: "s-own" });
    expect(exec.write.before_state).toMatchObject({ budget_amount_micros: 500_000_000 });
    expect(exec.write.after_state).toMatchObject({ budget_amount_micros: 400_000_000 });
    expect(vendor.micros).toBe(400_000_000);
    expect(vendor.mutations()).toBe(1);
    expect(notifications.map((n) => `${n.tool_id}.${n.action}:${n.outcome}`)).toEqual(["growth_googleads.set_campaign_budget:executed"]);
    const replay = await budget("owner-desktop", 40_000, { idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body["execution"]).toMatchObject({ outcome: "SUCCESS", replayed: true });
    expect(replay.body["execution"].write.write_id).toBe(exec.write.write_id);
    expect(vendor.mutations()).toBe(1);
    // samme nøkkel for NOE ANNET er en eksplisitt konflikt (400), aldri det lagrede resultatet
    const conflict = await budget("owner-signed", 20_000, { idempotency_key: key });
    expect(conflict.status).toBe(400);
    expect(conflict.body).toMatchObject({ error: "growth_write_rejected", reason: "growth_write_idempotency_conflict" });
  });

  it("mål utenfor eierens liste, ukjent handling og ugyldig nøkkel: avvist uten at noe sendes (egne feilkoder vises, øvrig er generisk)", async () => {
    const foreign = await post("/growth/mutate", { grant_token: "owner-signed", provider: "google_ads", action: "pause_campaign", parameters: { customer_id: "9999999999", campaign_id: "101" }, idempotency_key: uniqKey("foreign") });
    expect(foreign.status).toBe(200);
    expect(foreign.body["execution"]).toMatchObject({ outcome: "FAILED", reason: "growth_target_not_authorized" });
    expect((await post("/growth/mutate", { grant_token: "owner-signed", provider: "google_ads", action: "format_disk", parameters: {}, idempotency_key: uniqKey("unknown") })).body).toMatchObject({ error: "growth_write_rejected", reason: "growth_write_unknown_action:format_disk" });
    expect((await post("/growth/mutate", { grant_token: "owner-signed", provider: "google_ads", action: "pause_campaign", parameters: { customer_id: CID, campaign_id: "101" }, idempotency_key: "kort" })).body).toMatchObject({ error: "growth_write_rejected", reason: "growth_write_idempotency_key_invalid" });
    expect(vendor.requests).toHaveLength(0);
  });

  it("UTFALL UKJENT over HTTP: leverandøren endret budsjettet og rev socketen -> 200 UNKNOWN med journalrad `outcome_unknown` og varsel; replay sender aldri på nytt", async () => {
    vendor.destroyMutations = true;
    const key = uniqKey("e2e-unknown");
    const res = await budget("owner-signed", 40_000, { idempotency_key: key });
    expect(res.status).toBe(200);
    expect(res.body["execution"]).toMatchObject({ outcome: "UNKNOWN", reason: "tool_failed:outcome_unknown:google_ads_transport_reset" });
    expect(res.body["execution"].write.status).toBe("outcome_unknown");
    expect(vendor.micros).toBe(400_000_000);
    expect(notifications.map((n) => n.outcome)).toEqual(["unknown"]);
    vendor.destroyMutations = false;
    const replay = await budget("owner-signed", 40_000, { idempotency_key: key });
    expect(replay.body["execution"]).toMatchObject({ outcome: "UNKNOWN", replayed: true });
    expect(vendor.mutations()).toBe(1);
  });
});

describe("C: lese- og journalrutene", () => {
  it("/growth/read når kun klasse A i skrive-familien: lesing er merket `untrusted`; en skrivehandling (eller ukjent) nektes; gjest nektes", async () => {
    const read = await post("/growth/read", { grant_token: "owner-signed", provider: "google_ads", action: "get_campaign_state", parameters: { customer_id: CID, campaign_id: "101" } });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, output_trust: "untrusted" });
    expect(read.body["data"]).toMatchObject({ campaign_id: "101", budget_amount_micros: 500_000_000 });
    expect(vendor.mutations()).toBe(0);
    const write = await post("/growth/read", { grant_token: "owner-signed", provider: "google_ads", action: "set_campaign_budget", parameters: { customer_id: CID, campaign_id: "101", amount_ore: 1 } });
    expect(write.status).toBe(400);
    expect(write.body["error"]).toBe("growth_read_unknown_action");
    expect((await post("/growth/read", { grant_token: "guest-signed", provider: "google_ads", action: "get_campaign_state", parameters: { customer_id: CID, campaign_id: "101" } })).status).toBe(403);
    const denied = await post("/growth/read", { grant_token: "owner-signed", provider: "google_ads", action: "get_campaign_state", parameters: { customer_id: "9999999999", campaign_id: "101" } });
    expect(denied.body).toMatchObject({ ok: false, reason: "growth_target_not_authorized" });
  });

  it("/growth/writes/list gir eierens journal (filtrerbar på status), aldri andre; gjest nektes; ugyldig status 400", async () => {
    await budget("owner-signed", 30_000);
    const all = await post("/growth/writes/list", { grant_token: "owner-signed", limit: 50 });
    expect(all.status).toBe(200);
    expect((all.body["writes"] as Json[]).length).toBeGreaterThan(0);
    for (const w of all.body["writes"] as Json[]) expect(w["tenant_id"]).toBe(TENANT);
    const applied = await post("/growth/writes/list", { grant_token: "owner-signed", status: "applied" });
    expect((applied.body["writes"] as Json[]).every((w) => w["status"] === "applied")).toBe(true);
    const unknown = await post("/growth/writes/list", { grant_token: "owner-signed", status: "outcome_unknown" });
    expect((unknown.body["writes"] as Json[]).every((w) => w["status"] === "outcome_unknown")).toBe(true);
    expect((await post("/growth/writes/list", { grant_token: "guest-signed" })).status).toBe(403);
    expect((await post("/growth/writes/list", { grant_token: "owner-signed", status: "nonsens" })).status).toBe(400);
  });
});
