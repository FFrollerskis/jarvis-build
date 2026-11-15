import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  InfisicalTransport, ToolGateway, afterAcceptedMutation, infisicalToolDefinitions, isOutcomeUnknownMessage, INFRA_GATED_TOOL_IDS, type ClassDNotification, type SecretProvider
} from "../src/index.ts";
import { FakeInfisical } from "./support/fake-infisical.ts";

/**
 * WP-K (D-471, JARVIS-018) uavhengig delta-review M-1: «kaster etter akseptert mutasjon» gjaldt ikke bare sentinel-transportene. `infisical.rotate_secrets` (klasse D, `idempotent_external: false`,
 * slått på av `JARVIS_INFISICAL_ROTATION_IDS` = produksjon) sendte POST og leste så rotasjonen på nytt; en feil i readback ga ledger `failed`, og et samme-nøkkel-replay sendte en ANDRE rotasjon.
 * Her: (A) den delte hjelperen `afterAcceptedMutation` og (B) Infisical gjennom ekte gateway + embedded Postgres + lokal FakeInfisical (reviewerens exp2). Kontrast: feil FØR sending og entydige
 * leverandørfeil forblir `failed` (retry tillatt). (GCE/Docker/GitHub-revisjonen ligger i neste commit.)
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
