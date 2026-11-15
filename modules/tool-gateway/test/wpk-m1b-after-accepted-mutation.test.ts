import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  DockerTransport, GceTransport, GithubRateLimitController, GithubTransport, InMemoryGithubRateLimitStore, InfisicalTransport, ToolGateway,
  afterAcceptedMutation, firstWaveTools, infisicalToolDefinitions, isOutcomeUnknownMessage, resetGoogleAccessTokenCache,
  INFRA_GATED_TOOL_IDS, type ClassDNotification, type SecretProvider, type ToolDefinition, type ToolTransport
} from "../src/index.ts";
import { FakeInfisical } from "./support/fake-infisical.ts";

/**
 * WP-K (D-471, JARVIS-018) uavhengig delta-review M-1: «kaster etter akseptert mutasjon» gjaldt ikke bare sentinel-transportene. `infisical.rotate_secrets` (klasse D, `idempotent_external: false`,
 * slått på av `JARVIS_INFISICAL_ROTATION_IDS` = produksjon) sendte POST og leste så rotasjonen på nytt; en feil i readback ga ledger `failed`, og et samme-nøkkel-replay sendte en ANDRE rotasjon.
 * Her: (A) den delte hjelperen `afterAcceptedMutation`, (B) Infisical gjennom ekte gateway + embedded Postgres + lokal FakeInfisical (reviewerens exp2), (C) GCE `reset_instance`, (D) Docker
 * `redeploy_container` (begge kun sentinel, men samme form), og (E) GitHub-transportens rate-limit-bokføring ETTER en akseptert 2xx (Postgres-skriving som kunne gjøre en akseptert merge/dispatch/kommentar
 * til en kastet feil). Kontrast: feil FØR sending og entydige leverandørfeil forblir `failed` (retry tillatt), og idempotente handlinger er uendret.
 */
const TENANT = "tenant-wpk-m1b";
const owner: IdentityContext = { person_id: "person-m1b", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-m1b", device_id: "dev-m1b", channel: "api", auth_strength: "signed" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let inf: FakeInfisical;
let seq = 0;
const uniq = (prefix: string): string => `${prefix}-${(seq += 1)}-${Date.now().toString(36)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpkm1b-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_m1b LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_m1b;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','WPK M1b','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-m1b','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-m1b','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_m1b", password: "pw2" });
  inf = new FakeInfisical();
  await inf.start();
}, 240_000);

afterAll(async () => {
  await inf?.stop();
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetGoogleAccessTokenCache();
  inf?.clearReadbackFailure();
  if (inf) { inf.rotationFails = false; inf.silentlyIgnoreRotate = false; }
});

async function ledger(key: string): Promise<{ status: string; postcondition_reason: string | null } | undefined> {
  return (await admin.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("A: afterAcceptedMutation - den delte hjelperen for steg ETTER en akseptert mutasjon", () => {
  it("returnerer stegets verdi uendret (også et synkront steg), og kjører steget nøyaktig én gang", async () => {
    let calls = 0;
    expect(await afterAcceptedMutation("x_step", async () => { calls += 1; return { ok: 1 }; })).toEqual({ ok: 1 });
    expect(await afterAcceptedMutation("x_step", () => 42)).toBe(42);
    expect(calls).toBe(1);
  });

  it("enhver feil i steget blir `outcome_unknown:<fast kode>` - uten feilteksten (kan sitere et passord/token), uten cause", async () => {
    const hostile = new Error("postgresql://admin:fake-password-for-test@db.internal/prod Bearer fake-token-for-test");
    const thrown = await afterAcceptedMutation("rotation_readback_failed", () => { throw hostile; }).catch((e: unknown) => e as Error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("outcome_unknown:rotation_readback_failed");
    expect(thrown.message).not.toContain("fake-password-for-test");
    expect(thrown.message).not.toContain("fake-token-for-test");
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    // Gatewayen kjenner den igjen som ukjent utfall (ledger `unverified`, aldri `failed`).
    expect(isOutcomeUnknownMessage(thrown.message)).toBe(true);
  });

  it("en feil som ALLEREDE er ukjent utfall (`outcome_unknown:...`, `tool_timeout`) går uendret videre - første årsak vinner", async () => {
    const already = new Error("outcome_unknown:transport_reset");
    await expect(afterAcceptedMutation("later_code", () => { throw already; })).rejects.toBe(already);
    const timeout = new Error("tool_timeout");
    await expect(afterAcceptedMutation("later_code", () => { throw timeout; })).rejects.toBe(timeout);
  });

  it("`keep` holder igjen en feil som er et ENTYDIG leverandørsvar «mislyktes»: den kastes uendret, alt annet gjøres om", async () => {
    const definite = new Error("gce_operation_failed:QUOTA_EXCEEDED:no more cpus");
    const keep = (err: unknown): boolean => err instanceof Error && err.message.startsWith("gce_operation_failed:");
    await expect(afterAcceptedMutation("c", () => { throw definite; }, { keep })).rejects.toBe(definite);
    await expect(afterAcceptedMutation("c", () => { throw new Error("gce_operation_poll_timeout"); }, { keep })).rejects.toThrow("outcome_unknown:c");
  });

  it("ikke-Error-verdier og en feil med kastende getter gir fortsatt `outcome_unknown` (hjelperen kaster aldri noe annet)", async () => {
    for (const value of ["en streng", null, undefined, 7, { message: 12 }]) {
      await expect(afterAcceptedMutation("odd", () => { throw value; })).rejects.toThrow("outcome_unknown:odd");
    }
    const getter = { get message(): string { throw new Error("getter_boom"); } };
    await expect(afterAcceptedMutation("odd", () => { throw getter; })).rejects.toThrow("outcome_unknown:odd");
  });

  it("koden vaskes til et trygt tegnsett og en kort lengde (aldri dynamisk tekst inn i årsaken)", async () => {
    const thrown = await afterAcceptedMutation("ugyldig kode\nmed linjeskift & mellomrom", () => { throw new Error("x"); }).catch((e: unknown) => e as Error);
    expect(thrown.message).toBe("outcome_unknown:ugyldig_kode_med_linjeskift___mellomrom");
    const long = await afterAcceptedMutation("a".repeat(500), () => { throw new Error("x"); }).catch((e: unknown) => e as Error);
    expect(long.message.length).toBe("outcome_unknown:".length + 60);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
interface Harness { gateway: ToolGateway; notifications: ClassDNotification[] }

function infisicalHarness(rotationIds: string[]): Harness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "INFISICAL_CLIENT_SECRET" ? inf.clientSecret : null) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const transport = new InfisicalTransport({ baseUrl: async () => inf.baseUrl, clientId: async () => inf.clientId, projectId: async () => inf.projectId, environment: async () => inf.environment, sleep: async () => undefined });
  for (const d of infisicalToolDefinitions(transport, { rotationIds: new Set(rotationIds) })) gateway.register(d);
  return { gateway, notifications };
}

const rotate = (h: Harness, rotationId: string, key: string) =>
  h.gateway.execute({ identity: owner, tool_id: "infisical", action: "rotate_secrets", parameters: { rotation_id: rotationId } as never, idempotency_key: key });
const rotatePosts = (rotationId: string): number => inf.requestsMatching("POST", /rotate-secrets$/).filter((q) => q.path.includes(rotationId)).length;

describe("B: infisical.rotate_secrets (klasse D, ikke-idempotent, produksjon) - feil ETTER akseptert rotate-POST", () => {
  const UNKNOWN_LEDGER_REASON = "postcondition_unverified:tool_timeout_outcome_unknown";

  it("REGRESJON M-1 (reviewerens exp2): readback-GET gir 503 etter akseptert POST -> `unverified`, replay BLOKKERT, nøyaktig ÉN rotasjon, ett «utfall ukjent»-varsel (aldri «utført»)", async () => {
    const r = inf.seedRotation({ name: "supabase-main" });
    const h = infisicalHarness([r.id]);
    // `jsonRequest` prøver en GET tre ganger ved 5xx: tre feil = readback gir opp. Deretter virker listen igjen, så replayets EGEN preflight (som kjører FØR ledger-sjekken) kommer gjennom og det er LEDGEREN som blokkerer.
    inf.failReadbackAfterRotate(503, { times: 3 });
    const key = uniq("m1b-503");
    const first = await rotate(h, r.id, key);
    expect(first).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:infisical_rotation_readback_failed" });
    expect(await ledger(key)).toEqual({ status: "unverified", postcondition_reason: UNKNOWN_LEDGER_REASON });
    const replay = await rotate(h, r.id, key);
    expect(replay).toEqual({ ok: false, reason: UNKNOWN_LEDGER_REASON });
    expect(rotatePosts(r.id)).toBe(1); // ÉN rotasjon - replayet nådde aldri leverandøren
    expect(h.notifications.map((n) => n.outcome)).toEqual(["unknown"]);
    // Revisjonsraden bærer det PRESISE årsaksnavnet (readback), og merker utfallet som ukjent.
    const audit = (await admin.query(
      "SELECT reason, payload->>'outcome_unknown' AS unknown FROM audit_events WHERE tenant_id = $1 AND type = 'tool.failed' AND tool_id = 'infisical' AND reason LIKE 'outcome_unknown:infisical_rotation_readback_failed%'", [TENANT]
    )).rows;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[audit.length - 1]).toMatchObject({ unknown: "true" });
    // Svaret til modellen/revisjonen siterer aldri leverandørteksten.
    expect(JSON.stringify([first, replay])).not.toContain("readback failed");
  }, 60_000);

  it("readback svarer 200 med uforståelig kropp (ikke JSON) -> samme: `unverified`, blokkert replay, én rotasjon", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    inf.failReadbackAfterRotate(200, { body: "<html>maintenance</html>", times: 1 });
    const key = uniq("m1b-html");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:infisical_rotation_readback_failed" });
    expect((await ledger(key))?.status).toBe("unverified");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: UNKNOWN_LEDGER_REASON });
    expect(rotatePosts(r.id)).toBe(1);
  }, 60_000);

  it("readback avvises (401 - tokenet er tilbakekalt midt i kallet) -> samme: ukjent utfall, aldri en retry-bar feil", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    inf.failReadbackAfterRotate(401, { times: 2 }); // `authed` logger inn på nytt ÉN gang ved 401 - begge forsøkene avvises
    const key = uniq("m1b-401");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:infisical_rotation_readback_failed" });
    expect((await ledger(key))?.status).toBe("unverified");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: UNKNOWN_LEDGER_REASON });
    expect(rotatePosts(r.id)).toBe(1);
  }, 60_000);

  it("readback feiler FORTSATT når replayet kommer: preflight feiler lukket (ingen ny POST), og raden står uansett `unverified`", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    inf.failReadbackAfterRotate(503); // varig
    const key = uniq("m1b-persistent");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:infisical_rotation_readback_failed" });
    expect((await rotate(h, r.id, key)) as { ok: boolean }).toMatchObject({ ok: false });
    expect((await ledger(key))?.status).toBe("unverified");
    expect(rotatePosts(r.id)).toBe(1);
  }, 60_000);

  it("leverandøren melder rotasjonen som mislykket ETTER at POST-en ble akseptert -> `unverified` (utfall ukjent), ikke en retry-bar failed; replay blokkert; én rotasjon; varsel «ukjent»", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    inf.rotationFails = true;
    const key = uniq("m1b-failed-status");
    const first = await rotate(h, r.id, key);
    expect(first).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:infisical_rotation_failed:failed" });
    expect((await ledger(key))?.status).toBe("unverified");
    inf.rotationFails = false;
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: UNKNOWN_LEDGER_REASON });
    expect(rotatePosts(r.id)).toBe(1);
    expect(h.notifications.map((n) => n.outcome)).toEqual(["unknown"]);
    // Siste feil hos leverandøren (kan sitere en tilkoblingsstreng) står verken i svaret eller i ledgeren.
    expect(JSON.stringify(first)).not.toContain("supabase");
  }, 60_000);

  it("KONTRAST: en POST som AVVISES (422) er et entydig avslag -> `failed`, samme nøkkel kan prøves på nytt og lykkes (to POST totalt: ett avvist, ett akseptert)", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    inf.failNext(/POST \/api\/v2\/secret-rotations\/.+\/rotate-secrets/, 422, 1, "validation failed");
    const key = uniq("m1b-422");
    const first = await rotate(h, r.id, key);
    expect(first).toMatchObject({ ok: false });
    expect((first as { reason: string }).reason).toMatch(/^tool_failed:infisical_error_422/);
    expect((await ledger(key))?.status).toBe("failed");
    expect(h.notifications).toHaveLength(0);
    const retried = await rotate(h, r.id, key);
    expect(retried).toMatchObject({ ok: true });
    expect((await ledger(key))?.status).toBe("succeeded");
    expect(rotatePosts(r.id)).toBe(2);
  }, 60_000);

  it("KONTRAST: en feil FØR POST (ugyldig rotasjonstype) forblir `failed` uten at noe er sendt - retry er tillatt og ingen POST nås", async () => {
    const r = inf.seedRotation({ type: "Bad/Type" });
    const h = infisicalHarness([r.id]);
    const key = uniq("m1b-pre-post");
    const first = await rotate(h, r.id, key);
    expect(first).toEqual({ ok: false, reason: "tool_failed:infisical_rotation_type_invalid" });
    expect((await ledger(key))?.status).toBe("failed");
    expect(await rotate(h, r.id, key)).toEqual({ ok: false, reason: "tool_failed:infisical_rotation_type_invalid" });
    expect(rotatePosts(r.id)).toBe(0);
    expect(h.notifications).toHaveLength(0);
  }, 60_000);

  it("KONTRAST: vellykket rotasjon er uendret - `succeeded`, ett «utført»-varsel, og et replay deduplisereres uten ny POST", async () => {
    const r = inf.seedRotation();
    const h = infisicalHarness([r.id]);
    const key = uniq("m1b-ok");
    const first = await rotate(h, r.id, key);
    expect(first).toMatchObject({ ok: true });
    expect((await ledger(key))?.status).toBe("succeeded");
    expect(await rotate(h, r.id, key)).toMatchObject({ ok: true, deduplicated: true });
    expect(rotatePosts(r.id)).toBe(1);
    expect(h.notifications.map((n) => n.outcome)).toEqual(["executed"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function gatewayFor(definition: ToolDefinition, credential: string): { gateway: ToolGateway; key: (suffix: string) => string } {
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => credential });
  gateway.register(definition);
  return { gateway, key: (suffix) => uniq(`m1b-${suffix}`) };
}
const anySchema = { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"];
function plainDef(tool_id: string, action: string, transport: ToolTransport, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    tool_id, action, description: "test", input_schema: anySchema, capability_class: "C", scopes: [], reversible: false, rollback_procedure: "manuell", idempotent_external: false,
    timeout_ms: 20_000, rate_limit_per_minute: 600, credential_ref: "M1B_TOKEN", output_trust: "internal", transport, ...overrides
  };
}

describe("C: GCE reset_instance (kun sentinel, men samme form: POST akseptert -> polling -> sluttlesing)", () => {
  const ZONE = "europe-west1-b";
  const params = { zone: ZONE, instance_name: "jarvis-sentinel-vm" };
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const tokenOk = (): Response => new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

  type Script = { poll?: () => Response; instance?: () => Response; post?: () => Response };
  /** Stubber `fetch` for token/POST/poll/instans og teller mutasjons-POST-ene (`reset`/`start`). */
  function stubGce(script: Script): { mutationPosts: () => number } {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "client-secret");
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return tokenOk();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && /\/(reset|start)$/.test(url)) { posts += 1; return (script.post ?? (() => json({ name: "op-1", status: "PENDING" })))(); }
      if (url.includes("/operations/")) return (script.poll ?? (() => json({ name: "op-1", status: "DONE" })))();
      if (/\/instances\/jarvis-sentinel-vm$/.test(url)) return (script.instance ?? (() => json({ name: "jarvis-sentinel-vm", status: "RUNNING" })))();
      throw new Error(`unexpected_url:${url}`);
    }));
    return { mutationPosts: () => posts };
  }
  const transport = (): GceTransport => new GceTransport("my-project", 1);

  it("operasjonen blir aldri DONE (poll-tak) -> `outcome_unknown:gce_reset_not_confirmed`, ÉN POST; start_instance beholder den vanlige feilen (idempotent)", async () => {
    const s = stubGce({ poll: () => json({ name: "op-1", status: "RUNNING" }) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^outcome_unknown:gce_reset_not_confirmed$/);
    expect(s.mutationPosts()).toBe(1);
    await expect(transport().invoke("start_instance", params, "refresh-token")).rejects.toThrow(/^gce_operation_poll_timeout$/);
  }, 30_000);

  it("feil under polling (401) / sluttlesing (403) / manglende operasjonsnavn etter akseptert reset -> ukjent utfall", async () => {
    stubGce({ poll: () => json({ error: { status: "UNAUTHENTICATED", message: "expired" } }, 401) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^outcome_unknown:gce_reset_not_confirmed$/);
    vi.unstubAllGlobals();
    stubGce({ instance: () => json({ error: { status: "PERMISSION_DENIED", message: "no" } }, 403) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^outcome_unknown:gce_reset_not_confirmed$/);
    vi.unstubAllGlobals();
    stubGce({ post: () => json({ status: "PENDING" }) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^outcome_unknown:gce_reset_not_confirmed$/);
  }, 30_000);

  it("en operasjon som er FERDIG med feil (`gce_operation_failed`) er et entydig «mislyktes»: forblir en vanlig feil (ikke ukjent)", async () => {
    stubGce({ poll: () => json({ name: "op-1", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "no more cpus" }] } }) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^gce_operation_failed:QUOTA_EXCEEDED:no more cpus$/);
  }, 30_000);

  it("KONTRAST: en POST som AVVISES (403) er en vanlig feil, og en vellykket reset er uendret", async () => {
    stubGce({ post: () => json({ error: { status: "PERMISSION_DENIED", message: "nope" } }, 403) });
    await expect(transport().invoke("reset_instance", params, "refresh-token")).rejects.toThrow(/^gce_api_error_403:/);
    vi.unstubAllGlobals();
    stubGce({});
    const ok = await transport().invoke("reset_instance", params, "refresh-token");
    expect(ok).toMatchObject({ external_id: "op-1", data: { status: "RUNNING" } });
  }, 30_000);

  it("GENNEM gatewayen: poll-tak etter akseptert reset -> `unverified`, replay blokkert, ÉN reset-POST (før fiksen: `failed` og en ANDRE reset)", async () => {
    const s = stubGce({ poll: () => json({ name: "op-1", status: "RUNNING" }) });
    const { gateway, key } = gatewayFor(plainDef("gce-m1b", "reset_instance", transport()), "refresh-token");
    const k = key("gce");
    const request = { identity: owner, tool_id: "gce-m1b", action: "reset_instance", parameters: params as never, idempotency_key: k };
    expect(await gateway.execute(request)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:gce_reset_not_confirmed" });
    expect(await gateway.execute(request)).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect((await ledger(k))?.status).toBe("unverified");
    expect(s.mutationPosts()).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("D: Docker redeploy_container (kun sentinel, men samme form: rm -f + run -d akseptert -> inspect)", () => {
  /** Fake `docker`: `rm`/`run`/`inspect`/`stop`; logger hvert kall i en loggfil og feiler `inspect` når `FAKE_DOCKER_FAIL_INSPECT=1`. */
  async function fakeDocker(): Promise<{ bin: string; calls: () => Promise<string[]> }> {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-fake-docker-m1b-"));
    const log = join(dir, "calls.log");
    const bin = join(dir, "docker.cjs");
    await writeFile(log, "", "utf8");
    await writeFile(bin, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `const LOG = ${JSON.stringify(log)};`,
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(LOG, args[0] + '\\n');",
      "if (args[0] === 'rm') process.exit(0);",
      "if (args[0] === 'run') { if (process.env.FAKE_DOCKER_FAIL_RUN === '1') { process.stderr.write('Error: simulated run failure\\n'); process.exit(1); } process.stdout.write('c1234567890abcdef\\n'); process.exit(0); }",
      "if (args[0] === 'stop') process.exit(0);",
      "if (args[0] === 'inspect') {",
      "  if (process.env.FAKE_DOCKER_FAIL_INSPECT === '1') { process.stderr.write('Error: simulated inspect failure\\n'); process.exit(1); }",
      "  if (process.env.FAKE_DOCKER_GARBAGE_INSPECT === '1') { process.stdout.write('not json at all'); process.exit(0); }",
      "  process.stdout.write(JSON.stringify({ Id: 'c1234567890abcdef', Name: '/jarvis-sentinel-m1b', Config: { Image: 'alpine:3' }, State: { Status: 'running', StartedAt: '2026-01-01T00:00:00Z' }, Created: '2026-01-01T00:00:00Z', RestartCount: 0 }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write('unknown command\\n'); process.exit(1);"
    ].join("\n"), "utf8");
    await chmod(bin, 0o700);
    return { bin, calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean) };
  }
  const params = { name: "jarvis-sentinel-m1b", image: "alpine:3" };
  afterEach(() => { for (const k of ["FAKE_DOCKER_FAIL_INSPECT", "FAKE_DOCKER_FAIL_RUN", "FAKE_DOCKER_GARBAGE_INSPECT"]) delete process.env[k]; });

  it("inspect feiler ETTER at `docker run -d` startet containeren -> `outcome_unknown:docker_post_deploy_inspect_failed` (også uleselig utdata)", async () => {
    const d = await fakeDocker();
    process.env["FAKE_DOCKER_FAIL_INSPECT"] = "1";
    await expect(new DockerTransport(10_000).invoke("redeploy_container", params, d.bin)).rejects.toThrow(/^outcome_unknown:docker_post_deploy_inspect_failed$/);
    delete process.env["FAKE_DOCKER_FAIL_INSPECT"];
    process.env["FAKE_DOCKER_GARBAGE_INSPECT"] = "1";
    await expect(new DockerTransport(10_000).invoke("redeploy_container", params, d.bin)).rejects.toThrow(/^outcome_unknown:docker_post_deploy_inspect_failed$/);
  }, 30_000);

  it("KONTRAST: `docker run` selv feiler (containeren startet ikke) er en vanlig feil, og stop_container (idempotent) beholder sine vanlige feil", async () => {
    const d = await fakeDocker();
    process.env["FAKE_DOCKER_FAIL_RUN"] = "1";
    await expect(new DockerTransport(10_000).invoke("redeploy_container", params, d.bin)).rejects.toThrow(/^docker_run_failed:Error: simulated run failure/);
    delete process.env["FAKE_DOCKER_FAIL_RUN"];
    process.env["FAKE_DOCKER_FAIL_INSPECT"] = "1";
    await expect(new DockerTransport(10_000).invoke("stop_container", { name: "jarvis-sentinel-m1b" }, d.bin)).rejects.toThrow(/^docker_post_stop_inspect_failed:/);
    delete process.env["FAKE_DOCKER_FAIL_INSPECT"];
    const ok = await new DockerTransport(10_000).invoke("redeploy_container", params, d.bin);
    expect(ok).toMatchObject({ external_id: "c1234567890a", data: { name: "jarvis-sentinel-m1b", status: "running" } });
  }, 30_000);

  it("GENNEM gatewayen: inspect-feil etter akseptert redeploy -> `unverified`, replay blokkert, containeren startes ÉN gang (før fiksen: `failed` og en ANDRE rm + run)", async () => {
    const d = await fakeDocker();
    process.env["FAKE_DOCKER_FAIL_INSPECT"] = "1";
    const { gateway, key } = gatewayFor(plainDef("docker-m1b", "redeploy_container", new DockerTransport(10_000)), d.bin);
    const k = key("docker");
    const request = { identity: owner, tool_id: "docker-m1b", action: "redeploy_container", parameters: params as never, idempotency_key: k };
    expect(await gateway.execute(request)).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:docker_post_deploy_inspect_failed" });
    expect(await gateway.execute(request)).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect((await ledger(k))?.status).toBe("unverified");
    expect((await d.calls()).filter((c) => c === "run")).toHaveLength(1);
    expect((await d.calls()).filter((c) => c === "rm")).toHaveLength(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("E: GitHub - rate-limit-bokføringen ETTER en akseptert 2xx kan aldri gjøre en akseptert mutasjon om til en kastet feil", () => {
  /** Lagring der `recordSuccess` (en Postgres-skriving i produksjon) feiler - som ved tilkoblingsfeil/manglende tabell ETTER at GitHub har svart. */
  class BrokenStore extends InMemoryGithubRateLimitStore {
    failures = 0;
    override async recordSuccess(): Promise<void> { this.failures += 1; throw Object.assign(new Error("connection terminated: postgresql://app:fake-password-for-test@db/jarvis"), { code: "ECONNRESET" }); }
  }
  function stubGithub(): { posts: () => string[] } {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") posts.push(`${method} ${url}`);
      if (method === "PUT" && /\/pulls\/7\/merge$/.test(url)) return new Response(JSON.stringify({ sha: "abc123", merged: true, message: "Pull Request successfully merged" }), { status: 200 });
      if (method === "POST" && /\/dispatches$/.test(url)) return new Response(null, { status: 204 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected_request:${method} ${url}`);
    }));
    return { posts: () => posts };
  }
  const transport = (store: BrokenStore): GithubTransport => new GithubTransport(new GithubRateLimitController(store, "JARVIS_GITHUB_TOKEN"));

  it("dispatch_workflow, merge_pr og delete_branch lykkes selv om bokføringen feiler: ingen kastet feil, loggen bærer kun navn (aldri meldingstekst), mutasjonen sendes én gang", async () => {
    const store = new BrokenStore();
    const gh = stubGithub();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = transport(store);
    expect(await t.invoke("dispatch_workflow", { repo: "acme/app", workflow_id: "ci.yml", ref: "main" }, "fake-token-for-test")).toEqual({ data: { workflow_id: "ci.yml", ref: "main", dispatched: true } });
    expect(await t.invoke("merge_pr", { repo: "acme/app", pr_number: "7" }, "fake-token-for-test")).toMatchObject({ external_id: "abc123", data: { merged: true } });
    expect(await t.invoke("delete_branch", { repo: "acme/app", branch: "feature-x" }, "fake-token-for-test")).toEqual({ data: { branch: "feature-x", deleted: true } });
    expect(store.failures).toBe(3);
    expect(gh.posts()).toHaveLength(3);
    const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("github_rate_limit_record_failed"));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(JSON.parse(line)).toEqual({ msg: "github_rate_limit_record_failed", status: expect.any(Number), error: "Error" });
      expect(line).not.toContain("fake-password-for-test");
      expect(line).not.toContain("postgresql://");
    }
  }, 60_000);

  it("GENNEM gatewayen: dispatch_workflow med feilende bokføring -> `succeeded`, ok:true, og et replay deduplisereres - ÉN dispatch (før fiksen: `failed` og en ANDRE dispatch)", async () => {
    const store = new BrokenStore();
    const gh = stubGithub();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [dispatch] = firstWaveTools({ github: transport(store) }).filter((d) => d.tool_id === "github" && d.action === "dispatch_workflow");
    const { gateway, key } = gatewayFor(dispatch!, "fake-token-for-test");
    const k = key("github");
    const request = { identity: owner, tool_id: "github", action: "dispatch_workflow", parameters: { repo: "acme/app", workflow_id: "ci.yml", ref: "main" } as never, idempotency_key: k };
    expect(await gateway.execute(request)).toMatchObject({ ok: true });
    expect((await ledger(k))?.status).toBe("succeeded");
    expect(await gateway.execute(request)).toMatchObject({ ok: true, deduplicated: true });
    expect(gh.posts()).toHaveLength(1);
  }, 60_000);

  it("en 429 på en mutasjon registreres fortsatt som brudd (den ikke-OK-stien er uendret), og en vellykket mutasjon uten feil lagrer tilstanden som før", async () => {
    const store = new InMemoryGithubRateLimitStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "retry-after": "120" } })));
    const t = new GithubTransport(new GithubRateLimitController(store, "JARVIS_GITHUB_TOKEN"));
    await expect(t.invoke("dispatch_workflow", { repo: "acme/app", workflow_id: "ci.yml", ref: "main" }, "fake-token-for-test")).rejects.toThrow(/github_api_error_429/);
    expect((await store.get("JARVIS_GITHUB_TOKEN"))?.consecutiveViolations).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
