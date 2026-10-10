import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  CloudflareTransport, InfisicalTransport, LangfuseTransport, PostgresOpsTransport, ToolGateway, cloudflareToolDefinitions, infisicalToolDefinitions, langfuseToolDefinitions,
  parsePostgresOpsConfig, redactVendorText, vendorText, vendorTimestamp, type ClassDNotification, type PgOpsClient, type SecretProvider
} from "../src/index.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";
import { FakeInfisical } from "./support/fake-infisical.ts";
import { FakeLangfuse } from "./support/fake-langfuse.ts";
import { HOSTILE_SHORT, HOSTILE_TEXT, leaksHostile } from "./support/hostile.ts";

/**
 * Gjennomgang av PR #324 (M1): LEVERANDØRENS FRITEKST SLIPPER IKKE UVASKET UT AV TRANSPORTEN.
 *
 * Funnet (bekreftet med kjøring): Infisicals `lastRotationJobError` ble bare kuttet til 160 tegn - en rotasjonsfeil som siterer en tilkoblingsstreng med passord og et Bearer-token kom urørt gjennom
 * `get_rotation`, og `rotate_secrets` (preflight) skrev den inn i `tool_executions.before_state` OG `audit_events`. De opprinnelige testene fanget det ikke fordi fake-serverne bare hadde harmløs tekst.
 *
 * Her har ALLE fake-serverne (Infisical, Cloudflare, Langfuse) og Postgres-klienten FIENDTLIGE seed-verdier (URL med passord, Bearer, ghp_, sk-, JWT, PEM - se `support/hostile.ts`), kjørt gjennom den EKTE
 * `ToolGateway` mot ekte Postgres (embedded). Bevist: ingen rå hemmelighet i verktøysvar, `tool_executions` (alle kolonner) eller `audit_events` (alle kolonner), og at redigeringen faktisk skjedde
 * (`[REDACTED:…]` er synlig - ikke bare at feltet forsvant).
 */
const TENANT = "tenant-e1-m1";
const owner: IdentityContext = { person_id: "person-e1-m1", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-m1", device_id: "dev-m1", channel: "api", auth_strength: "signed" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let cf: FakeCloudflare;
let inf: FakeInfisical;
let lf: FakeLangfuse;
let zoneId: string;
let n = 0;
const uniq = (p: string): string => `${p}-${(n += 1)}-${hex32().slice(0, 8)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-m1-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1_m1 LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_m1;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('${owner.person_id}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${owner.person_id}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_m1", password: "pw2" });
  cf = new FakeCloudflare();
  inf = new FakeInfisical();
  lf = new FakeLangfuse();
  await Promise.all([cf.start(), inf.start(), lf.start()]);
  zoneId = cf.addZone("example.org");
}, 240_000);

afterAll(async () => {
  await Promise.all([cf?.stop(), inf?.stop(), lf?.stop()]);
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function makeGateway(rotationIds: string[]): { gateway: ToolGateway; notifications: ClassDNotification[] } {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(["cloudflare", "infisical", "langfuse"]),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const creds: Record<string, string> = { JARVIS_CLOUDFLARE_API_TOKEN: cf.token, LANGFUSE_SECRET_KEY: lf.secretKey, INFISICAL_CLIENT_SECRET: inf.clientSecret };
  const secrets: SecretProvider = { name: "fake", get: async (ref) => creds[ref] ?? null };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const sleep = async (): Promise<void> => undefined;
  const cfT = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep });
  const lfT = new LangfuseTransport({ baseUrl: async () => lf.baseUrl, publicKey: async () => lf.publicKey, sleep });
  const infT = new InfisicalTransport({ baseUrl: async () => inf.baseUrl, clientId: async () => inf.clientId, projectId: async () => inf.projectId, environment: async () => inf.environment, sleep });
  for (const d of [
    ...cloudflareToolDefinitions(cfT, { mutationZones: new Set([zoneId]) }),
    ...langfuseToolDefinitions(lfT),
    ...infisicalToolDefinitions(infT, { rotationIds: new Set(rotationIds) })
  ]) gateway.register(d);
  return { gateway, notifications };
}

/** ALT som kan ha fått tekst fra en leverandør og som lever videre: ledger (alle kolonner) og revisjon (alle kolonner). */
async function persisted(): Promise<string> {
  const ledger = (await admin.query("SELECT * FROM tool_executions")).rows;
  const audit = (await admin.query("SELECT * FROM audit_events")).rows;
  return JSON.stringify([ledger, audit]);
}
const json = (v: unknown): string => JSON.stringify(v);

describe("A: redactVendorText / vendorText / vendorTimestamp", () => {
  it("fjerner alle hemmelighetskategorier, også fra en tekst med linjeskift (PEM), og beholder resten lesbar", () => {
    const out = redactVendorText(HOSTILE_TEXT, 4000);
    expect(leaksHostile(out)).toEqual([]);
    expect(out).toContain("[REDACTED:url_credentials]");
    expect(out).toContain("[REDACTED:private_key]");
    expect(out).toContain("[REDACTED:jwt]");
    expect(out).toContain("rotation failed: could not connect");
    expect(out).not.toMatch(/\n/);
    for (const [kind, value] of Object.entries(HOSTILE_SHORT)) expect(leaksHostile(redactVendorText(`x ${value} y`)), kind).toEqual([]);
  });

  it("skanner FØR kutting: en hemmelighet som krysser kutt-grensen blir ikke igjen som et halvt token", () => {
    // 30 tegn polstring + GitHub-token (40 tegn): kuttet ved 50 ville gitt «ghp_QQQQQQQQQQ» (14 tegn) som ikke lenger matcher noe mønster.
    const text = `${"a".repeat(30)} ghp_${"Q".repeat(36)}`;
    const out = redactVendorText(text, 50);
    expect(out).not.toMatch(/ghp_Q/);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(redactVendorText(`${"a".repeat(30)} ghp_${"Q".repeat(36)}`, 400)).toContain("[REDACTED:github_token]");
  });

  it("kutter alltid til `max`, tåler ikke-strenger, og vendorTimestamp godtar kun rene tidsstempler", () => {
    expect(redactVendorText("x".repeat(5000), 100)).toHaveLength(100);
    expect(vendorText(undefined)).toBeNull();
    expect(vendorText(42)).toBeNull();
    expect(vendorText({ a: 1 })).toBeNull();
    expect(vendorText("  mellomrom   og\n\tlinjer  ", 50)).toBe("mellomrom og linjer");
    for (const ok of ["2026-10-09T12:00:00.000Z", "2026-10-09T12:00:00Z", "2026-10-09", "2026-10-09 12:00:00+02:00"]) expect(vendorTimestamp(ok), ok).toBe(ok);
    for (const bad of [HOSTILE_SHORT.github, "2026-10-09T12:00:00Z Bearer abcdefghijklmnopqrstuvwxyz", "nå", "", 5, null, `2026-10-09T12:00:00Z${"x".repeat(60)}`]) expect(vendorTimestamp(bad), String(bad)).toBeNull();
  });
});

describe("B: Infisical - last_error og øvrig fritekst når aldri verktøysvar, tool_executions eller audit_events", () => {
  it("get_rotation / list_secret_rotations: `last_error`, navn og status er redigert (mens id-er og tidsstempler er uendret)", async () => {
    inf.rotations.clear();
    const r = inf.seedRotation({ name: `rot ${HOSTILE_SHORT.github}`, rotationStatus: `ok ${HOSTILE_SHORT.bearer}`, lastRotationJobError: HOSTILE_TEXT });
    const { gateway } = makeGateway([r.id]);
    const one = await gateway.execute({ identity: owner, tool_id: "infisical", action: "get_rotation", parameters: { rotation_id: r.id } });
    const list = await gateway.execute({ identity: owner, tool_id: "infisical", action: "list_secret_rotations", parameters: {} });
    for (const res of [one, list]) {
      expect(res.ok).toBe(true);
      expect(leaksHostile(json(res))).toEqual([]);
    }
    expect(one.ok && (one.data as { last_error: string }).last_error).toContain("[REDACTED:");
    expect(one.ok && (one.data as { last_error: string }).last_error.length).toBeLessThanOrEqual(160);
    expect(one.ok && (one.data as { id: string }).id).toBe(r.id);
    expect(one.ok && (one.data as { name: string }).name).toContain("[REDACTED:github_token]");
  });

  it("rotate_secrets (klasse D): preflight-snapshotet (before_state) og revisjonen inneholder aldri en rå hemmelighet fra last_error", async () => {
    inf.rotations.clear();
    const r = inf.seedRotation({ rotationStatus: "success", lastRotationJobError: HOSTILE_TEXT, name: HOSTILE_SHORT.url });
    const { gateway, notifications } = makeGateway([r.id]);
    const key = uniq("m1-rot");
    const res = await gateway.execute({ identity: owner, tool_id: "infisical", action: "rotate_secrets", parameters: { rotation_id: r.id }, idempotency_key: key });
    expect(res.ok).toBe(true);
    expect(leaksHostile(json(res))).toEqual([]);
    const row = (await admin.query("SELECT before_state, after_state FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { before_state: { last_error: string } | null };
    expect(row.before_state?.last_error).toContain("[REDACTED:");
    const dump = await persisted();
    expect(leaksHostile(dump)).toEqual([]);
    expect(leaksHostile(json(notifications))).toEqual([]);
  });

  it("en rotasjon som FEILER med fiendtlig feiltekst, og en NY rotasjon som i preflight ser den feilen: aldri rå tekst i svar, ledger eller revisjon", async () => {
    inf.rotations.clear();
    inf.rotationFails = true;
    inf.rotationErrorText = HOSTILE_TEXT;
    try {
      const r = inf.seedRotation({ rotationStatus: "success" });
      const { gateway } = makeGateway([r.id]);
      const failed = await gateway.execute({ identity: owner, tool_id: "infisical", action: "rotate_secrets", parameters: { rotation_id: r.id }, idempotency_key: uniq("m1-rotfail") });
      expect(failed.ok).toBe(false);
      expect(leaksHostile(json(failed))).toEqual([]);
      // Kontroll: fakens rotasjon HAR nå den rå teksten (så testen under ikke er vakuøs)...
      expect(JSON.stringify([...inf.rotations.values()])).toContain("SuperSecretPw");
      inf.rotationFails = false;
      // ...og neste rotasjon leser den feilede tilstanden i preflight (before_state) - den skal være redigert der.
      const key = uniq("m1-rotretry");
      const retry = await gateway.execute({ identity: owner, tool_id: "infisical", action: "rotate_secrets", parameters: { rotation_id: r.id }, idempotency_key: key });
      expect(retry.ok).toBe(true);
      const before = (await admin.query("SELECT before_state FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { before_state: { rotation_status: string; last_error: string } };
      expect(before.before_state.rotation_status).toBe("failed");
      expect(before.before_state.last_error).toContain("[REDACTED:");
      expect(leaksHostile(await persisted())).toEqual([]);
    } finally {
      inf.rotationFails = false;
      inf.rotationErrorText = "upstream rejected credentials for supabase";
    }
  });

  it("fiendtlig /api/status-melding og HTTP-feil med fiendtlig melding (alle kategorier) går gjennom samme redigering: feilmelding -> `tool_failed:*` -> revisjon", async () => {
    inf.rotations.clear();
    const { gateway } = makeGateway([]);
    inf.statusBody = { message: HOSTILE_SHORT.github, emailConfigured: true, redisConfigured: true, inviteOnlySignup: false };
    const health = await gateway.execute({ identity: owner, tool_id: "infisical", action: "get_health", parameters: {} });
    inf.statusBody = { date: "2026-10-09T12:00:00.000Z", message: "Ok", emailConfigured: false, inviteOnlySignup: true, redisConfigured: true };
    expect(health.ok).toBe(true);
    expect(leaksHostile(json(health))).toEqual([]);
    expect(json(health)).toContain("[REDACTED:github_token]");
    // 400 (ikke 401: den utløser en ny innlogging) med hemmeligheten FØRST i meldingen, slik at selv det avkortede `reason` (80 tegn) ville avslørt en uredigert verdi.
    for (const [kind, value] of Object.entries(HOSTILE_SHORT)) {
      inf.failNext(/GET \/api\/v3\/secrets\/raw/, 400, 1, value);
      const failed = await gateway.execute({ identity: owner, tool_id: "infisical", action: "list_secret_metadata", parameters: {} });
      expect(failed.ok, kind).toBe(false);
      expect(failed.ok ? "" : failed.reason, kind).toMatch(/^tool_failed:infisical_error_400:/);
      expect(leaksHostile(json(failed)), kind).toEqual([]);
    }
    expect(leaksHostile(await persisted())).toEqual([]);
  });
});

describe("C: Cloudflare - feilmeldinger og visningstekster", () => {
  it("en mutasjon som avvises av Cloudflare med fiendtlig feilmelding (alle kategorier): `tool_failed:*`, ledger og revisjon har aldri den rå teksten", async () => {
    const { gateway } = makeGateway([]);
    for (const [kind, value] of Object.entries(HOSTILE_SHORT)) {
      cf.failNext(new RegExp(`PATCH /zones/${zoneId}/settings/ssl`), 400, { success: false, errors: [{ code: 1006, message: value }], messages: [], result: null });
      const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "update_zone_setting", parameters: { zone_id: zoneId, setting_id: "ssl", value: "strict" }, idempotency_key: uniq("m1-cf") });
      expect(res.ok, kind).toBe(false);
      expect(res.ok ? "" : res.reason, kind).toMatch(/^tool_failed:cloudflare_error_400:1006:/);
      expect(leaksHostile(json(res)), kind).toEqual([]);
    }
    expect(leaksHostile(await persisted())).toEqual([]);
  });

  it("preflight som feiler med fiendtlig melding (klasse D er fail-closed): `preflight_failed:*` er redigert", async () => {
    const { gateway } = makeGateway([]);
    cf.failNext(new RegExp(`GET /zones/${zoneId}/settings/ssl`), 400, { success: false, errors: [{ code: 1006, message: HOSTILE_SHORT.github }], messages: [], result: null });
    const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "update_zone_setting", parameters: { zone_id: zoneId, setting_id: "ssl", value: "full" }, idempotency_key: uniq("m1-cfpre") });
    expect(res.ok ? "" : res.reason).toMatch(/^preflight_failed:cloudflare_error_400:1006:/);
    expect(res.ok).toBe(false);
    expect(leaksHostile(json(res))).toEqual([]);
    expect(leaksHostile(await persisted())).toEqual([]);
  });

  it("lesing: konto-/plan-/rolle-/token-/audit-tekster og statuser er redigert; tidsstempelfelt kan ikke bære tekst", async () => {
    const { gateway } = makeGateway([]);
    cf.accountName = HOSTILE_SHORT.bearer;
    cf.planName = HOSTILE_SHORT.github;
    cf.roles = [{ id: "r1", name: HOSTILE_SHORT.openai, description: HOSTILE_TEXT }];
    cf.apiTokens = [{ id: "t1", name: HOSTILE_SHORT.url, status: `active ${HOSTILE_SHORT.github}`, expires_on: HOSTILE_SHORT.jwt, last_used_on: `2026-10-09T12:00:00Z ${HOSTILE_SHORT.github}` }];
    cf.auditEvents = [{ id: "e1", action: { type: HOSTILE_SHORT.github, result: HOSTILE_SHORT.bearer, time: HOSTILE_SHORT.jwt }, resource: { type: HOSTILE_SHORT.openai, id: "x", product: HOSTILE_SHORT.url }, actor: { type: HOSTILE_SHORT.github }, zone: { name: HOSTILE_SHORT.bearer } }];
    try {
      const results = [
        await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "get_zone", parameters: { zone_id: zoneId } }),
        await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "list_zones", parameters: {} }),
        await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "list_account_roles", parameters: {} }),
        await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "list_api_tokens", parameters: {} }),
        await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "list_audit_logs", parameters: {} })
      ];
      for (const res of results) {
        expect(res.ok).toBe(true);
        expect(leaksHostile(json(res))).toEqual([]);
      }
      expect(json(results[0])).toContain("[REDACTED:");
      const tokenResult = results[3];
      const token = tokenResult?.ok ? (tokenResult.data as { tokens: Array<{ expires_on: unknown; last_used_on: unknown }> }).tokens[0] : undefined;
      expect(token?.expires_on).toBeNull();
      expect(token?.last_used_on).toBeNull();
    } finally {
      cf.accountName = "Test account";
      cf.planName = "Free";
      cf.roles = [];
      cf.apiTokens = [];
      cf.auditEvents = [];
    }
  });

  it("konfigurasjonsdata eieren selv skriver (DNS-innhold) redigeres IKKE - det er gjenopprettingsgrunnlaget (dokumentert begrensning)", async () => {
    const { gateway } = makeGateway([]);
    const record = cf.seedDns(zoneId, { type: "TXT", name: "cfg.example.org", content: "token=abcdefghijklmnop" });
    const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "get_dns_record", parameters: { zone_id: zoneId, record_id: record } });
    expect(res.ok && (res.data as { content: string }).content).toContain("token=abcdefghijklmnop");
  });
});

describe("D: Langfuse - status, versjon, prosjekt-/organisasjonsnavn og feilmeldinger", () => {
  it("fiendtlig helse-/prosjektsvar og feilmelding når aldri verktøysvar, ledger eller revisjon (token-formet `version` forkastes)", async () => {
    const { gateway } = makeGateway([]);
    lf.healthBody = { status: HOSTILE_SHORT.github, version: HOSTILE_SHORT.github };
    lf.projects = [{ id: "proj-1", name: HOSTILE_SHORT.url, organization: { id: "org-1", name: HOSTILE_SHORT.bearer } }];
    lf.daily = [{ date: HOSTILE_SHORT.github, countTraces: 1, countObservations: 2, totalCost: 0.1 }, { date: "2026-10-08", countTraces: 3, countObservations: 4, totalCost: 0.2 }];
    try {
      const health = await gateway.execute({ identity: owner, tool_id: "langfuse", action: "get_health", parameters: {} });
      const project = await gateway.execute({ identity: owner, tool_id: "langfuse", action: "get_project", parameters: {} });
      const counts = await gateway.execute({ identity: owner, tool_id: "langfuse", action: "get_trace_counts", parameters: {} });
      for (const res of [health, project, counts]) {
        expect(res.ok).toBe(true);
        expect(leaksHostile(json(res))).toEqual([]);
      }
      expect(health.ok && (health.data as { version: unknown }).version).toBeNull();
      expect(counts.ok && (counts.data as { days: Array<{ date: unknown }> }).days.map((d) => d.date)).toEqual([null, "2026-10-08"]);
      for (const [kind, value] of Object.entries(HOSTILE_SHORT)) {
        lf.failNext(/GET \/api\/public\/projects/, 400, 1, value);
        const failed = await gateway.execute({ identity: owner, tool_id: "langfuse", action: "get_project", parameters: {} });
        expect(failed.ok, kind).toBe(false);
        expect(failed.ok ? "" : failed.reason, kind).toMatch(/^tool_failed:langfuse_error_400:/);
        expect(leaksHostile(json(failed)), kind).toEqual([]);
      }
      expect(leaksHostile(await persisted())).toEqual([]);
    } finally {
      lf.healthBody = { status: "OK", version: "2.95.11" };
    }
  });
});

describe("E: Postgres-drift - feilmelding og klient-satt fritekst", () => {
  const dsn = "postgresql://ops_m1:opsSecretPw-9981@127.0.0.1:5432/jarvis_test";

  function fakeClient(opts: { connectError?: Error; rows?: Record<string, unknown[]> }): PgOpsClient {
    return {
      connect: async () => { if (opts.connectError) throw opts.connectError; },
      end: async () => undefined,
      query: async (sql: string) => {
        if (/current_user::text AS me/.test(sql)) return { rows: [{ me: "ops_m1", db: "jarvis_test", monitor: true, super: false }] as never[], rowCount: 1 };
        if (/max_connections/.test(sql)) return { rows: [{ n: "100" }] as never[], rowCount: 1 };
        if (/FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY/.test(sql)) return { rows: (opts.rows?.["conn"] ?? []) as never[], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
  }

  it("en Postgres-feil som siterer DSN, passord og andre hemmeligheter (hemmeligheten FØRST i meldingen, så selv de 120 første tegnene ville avslørt den): feilmeldingen har aldri en rå hemmelighet", async () => {
    for (const [kind, value] of Object.entries(HOSTILE_SHORT)) {
      const err = Object.assign(new Error(`${value} while connecting to ${dsn}: password opsSecretPw-9981 rejected`), { code: "XX000" });
      const t = new PostgresOpsTransport({ config: parsePostgresOpsConfig(), createClient: () => fakeClient({ connectError: err }) });
      const thrown = await t.invoke("get_connections", {}, dsn).then(() => null, (e: Error) => e);
      expect(thrown, kind).toBeInstanceOf(Error);
      expect(thrown!.message, kind).toMatch(/^postgres_ops_error:XX000:/);
      expect(leaksHostile(thrown!.message), kind).toEqual([]);
      expect(thrown!.message, kind).not.toContain("opsSecretPw-9981");
      expect(thrown!.message.length, kind).toBeLessThan(200);
    }
  });

  it("`application_name` er klient-satt fritekst: redigert i tilkoblingsoversikten", async () => {
    const rows = { conn: [{ datname: "jarvis_test", usename: "app", application_name: HOSTILE_SHORT.github, state: "active", n: 3 }, { datname: "jarvis_test", usename: "app", application_name: "jarvis-api", state: "idle", n: 2 }] };
    const t = new PostgresOpsTransport({ config: parsePostgresOpsConfig(), createClient: () => fakeClient({ rows }) });
    const out = await t.invoke("get_connections", {}, dsn);
    expect(leaksHostile(json(out.data as JsonValue))).toEqual([]);
    expect(json(out.data)).toContain("jarvis-api");
    expect(json(out.data)).toContain("[REDACTED:github_token]");
  });
});
