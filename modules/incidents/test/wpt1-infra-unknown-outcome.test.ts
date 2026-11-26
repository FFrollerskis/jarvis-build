import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, isAcceptedButUnverifiedReason, isUnknownOutcomeReason, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { executeInfraMutation } from "../src/infra-execution.ts";
import { infraExecutionProducer, infraExecutionSeverity } from "../src/producers/infra-execution.ts";

/**
 * WP-T1 K6 (JARVIS-105): infra-journalen og hendelsene når et utfall er UKJENT.
 *  (1) Docker-journalen skrev et akseptert-men-uverifisert utfall (`postcondition_mismatch`, `postcondition_unverified:readback_failed`; ledger `unverified`) som FAILED. Nå UNKNOWN, med før-/etter-tilstand og recovery bevart.
 *  (2) En ukjent KLASSE D-infra-handling åpnet en `normal` hendelse. Nå `high` (FAILED var og er `high`; PARTIAL og lavere klasser er uendret `normal`).
 * Gjennom den EKTE ToolGateway og de EKTE produksjons-Docker-definisjonene (med sine postcondition-predikater og målautorisasjon), mot embedded Postgres.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const T = "tenant-t1k6";
const identity: IdentityContext = { person_id: "person-owner-k6", tenant_id: T, memory_space_id: "business", session_id: "sess-k6", device_id: "dev-k6", channel: "api", auth_strength: "active" };

interface FakeContainer { id: string; image: string; status: string }
class K6Docker implements ToolTransport {
  readonly containers = new Map<string, FakeContainer>();
  mutated = false;
  landOnImage: string | null = null;
  stickRunning = false;
  failRun = false;
  readbackFailsAfterMutation = false;
  private n = 0;
  seed(name: string, image: string, status = "running"): void { this.containers.set(name, { id: `c-${this.n++}`, image, status }); }
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const name = parameters["name"] as string;
    if (action === "inspect_container") {
      if (this.readbackFailsAfterMutation && this.mutated) throw new Error("docker_inspect_failed:simulated");
      const c = this.containers.get(name);
      return { data: c ? ({ ...c } as unknown as JsonValue) : null };
    }
    if (action === "redeploy_container") {
      if (this.failRun) throw new Error("docker_run_failed:simulated_outage");
      this.mutated = true;
      const c: FakeContainer = { id: `c-${this.n++}`, image: this.landOnImage ?? (parameters["image"] as string), status: "running" };
      this.containers.set(name, c);
      return { external_id: c.id, data: { ...c } as unknown as JsonValue };
    }
    if (action === "stop_container") {
      this.mutated = true;
      const c = this.containers.get(name)!;
      const next = { ...c, status: this.stickRunning ? c.status : "exited" };
      this.containers.set(name, next);
      return { external_id: c.id, data: { ...next } as unknown as JsonValue };
    }
    throw new Error(`unsupported:${action}`);
  }
}

const SENTINEL = ["jarvis-sentinel-k6a", "jarvis-sentinel-k6b", "jarvis-sentinel-k6c", "jarvis-sentinel-k6d", "jarvis-sentinel-k6e", "jarvis-sentinel-k6f"];
function buildGateway(transport: ToolTransport): ToolGateway {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: identity.person_id, owner_tenants: [T] } });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-docker-bin" };
  const gateway = new ToolGateway(app, policy, secrets);
  // De EKTE produksjonsdefinisjonene (predikater, preflight, målautorisasjon), kun med en fake transport.
  for (const def of firstWaveTools({ docker: transport }, { dockerMutationTargets: new Set(SENTINEL) }).filter((d) => d.tool_id === "docker")) gateway.register(def);
  return gateway;
}
const ledgerStatus = async (key: string): Promise<string | undefined> =>
  ((await admin.query("SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [T, key])).rows[0] as { status: string } | undefined)?.status;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1k6-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_t1k6 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_t1k6");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}', 'K6', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('person-owner-k6', 'Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner-k6', '${T}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_t1k6", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("K6 (1): akseptert-men-uverifisert utfall journalføres som UNKNOWN, ikke FAILED", () => {
  it("redeploy lander på feil image: gatewayen svarer `postcondition_mismatch` -> UNKNOWN med før-tilstand, etter-tilstand og recovery bevart (var FAILED uten bevis)", async () => {
    const transport = new K6Docker();
    transport.seed(SENTINEL[0]!, "alpine:3.19");
    transport.landOnImage = "alpine:UNEXPECTED";
    const execution = await executeInfraMutation({ pool: app, gateway: buildGateway(transport) }, identity, {
      tenant_id: T, target: SENTINEL[0]!, action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "k6-a"
    });
    expect(execution.verification_outcome).toBe("UNKNOWN");
    expect((execution.provider_receipt as { reason: string }).reason).toBe("postcondition_mismatch");
    expect(execution.before_state).toMatchObject({ image: "alpine:3.19" });
    expect(execution.after_state).toMatchObject({ image: "alpine:UNEXPECTED" });
    expect(execution.recovery_available).toBe(true);
    expect(execution.recovery_plan).toContain("alpine:3.19");
    expect(await ledgerStatus("k6-a")).toBe("unverified");
  });

  it("stop_container som ikke stopper (predikatet feiler): UNKNOWN, før-tilstand bevart", async () => {
    const transport = new K6Docker();
    transport.seed(SENTINEL[1]!, "alpine:3.19", "running");
    transport.stickRunning = true;
    const execution = await executeInfraMutation({ pool: app, gateway: buildGateway(transport) }, identity, { tenant_id: T, target: SENTINEL[1]!, action: "stop_container", idempotency_key: "k6-b" });
    expect(execution.verification_outcome).toBe("UNKNOWN");
    expect((execution.provider_receipt as { reason: string }).reason).toBe("postcondition_mismatch");
    expect(execution.before_state).toMatchObject({ status: "running" });
    expect(execution.recovery_available).toBe(true);
    expect(execution.recovery_plan).toContain("start_container");
  });

  it("readback feiler etter mutasjonen (`postcondition_unverified:readback_failed`): UNKNOWN, etter-tilstand er null (aldri gjettet), før-tilstand og recovery bevart", async () => {
    const transport = new K6Docker();
    transport.seed(SENTINEL[2]!, "alpine:3.19");
    transport.readbackFailsAfterMutation = true;
    const execution = await executeInfraMutation({ pool: app, gateway: buildGateway(transport) }, identity, {
      tenant_id: T, target: SENTINEL[2]!, action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "k6-c"
    });
    expect(execution.verification_outcome).toBe("UNKNOWN");
    expect((execution.provider_receipt as { reason: string }).reason).toBe("postcondition_unverified:readback_failed");
    expect(execution.after_state).toBeNull();
    expect(execution.before_state).toMatchObject({ image: "alpine:3.19" });
    expect(execution.recovery_available).toBe(true);
    expect(transport.containers.get(SENTINEL[2]!)?.image).toBe("alpine:3.20"); // handlingen ble faktisk utført: derfor kan den IKKE kalles FAILED
  });

  it("en gjentatt nøkkel gir samme journalrad (ingen ny utførelse) også for et uverifisert utfall", async () => {
    const transport = new K6Docker();
    transport.seed(SENTINEL[3]!, "alpine:3.19");
    transport.landOnImage = "alpine:WRONG";
    const gateway = buildGateway(transport);
    const input = { tenant_id: T, target: SENTINEL[3]!, action: "redeploy_container" as const, target_image: "alpine:3.20", idempotency_key: "k6-d" };
    const first = await executeInfraMutation({ pool: app, gateway }, identity, input);
    const again = await executeInfraMutation({ pool: app, gateway }, identity, input);
    expect(again.execution_id).toBe(first.execution_id);
    expect(first.verification_outcome).toBe("UNKNOWN");
  });

  it("REGRESJON: en ekte leverandørfeil er fortsatt FAILED (ingenting utført), en verifisert redeploy er SUCCESS, og et ikke-autorisert mål er FAILED", async () => {
    const failing = new K6Docker();
    failing.failRun = true;
    const failed = await executeInfraMutation({ pool: app, gateway: buildGateway(failing) }, identity, { tenant_id: T, target: SENTINEL[4]!, action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "k6-e1" });
    expect(failed.verification_outcome).toBe("FAILED");
    expect(await ledgerStatus("k6-e1")).toBe("failed");

    const ok = new K6Docker();
    ok.seed(SENTINEL[5]!, "alpine:3.19");
    const success = await executeInfraMutation({ pool: app, gateway: buildGateway(ok) }, identity, { tenant_id: T, target: SENTINEL[5]!, action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "k6-e2" });
    expect(success.verification_outcome).toBe("SUCCESS");

    const denied = await executeInfraMutation({ pool: app, gateway: buildGateway(new K6Docker()) }, identity, { tenant_id: T, target: "not-authorised-target", action: "stop_container", idempotency_key: "k6-e3" });
    expect(denied.verification_outcome).toBe("FAILED");
    expect(await ledgerStatus("k6-e3")).toBeUndefined();
  });

  it("klassifiseringen: `isAcceptedButUnverifiedReason` dekker postcondition_*-årsakene og ingenting annet; `isUnknownOutcomeReason` er uendret", () => {
    for (const reason of ["postcondition_mismatch", "postcondition_unverified:readback_failed", "postcondition_unverified:target_missing", "postcondition_unverified:predicate_error", "postcondition_unverified:no_provider_id", "postcondition_unverified:replayed"]) {
      expect(isAcceptedButUnverifiedReason(reason), reason).toBe(true);
    }
    for (const reason of ["tool_failed:docker_run_failed", "preflight_failed:x", "class_d_pipeline_incomplete:postcondition", "credential_unavailable", "invalid_parameters", "target_not_authorized", ""]) {
      expect(isAcceptedButUnverifiedReason(reason), reason).toBe(false);
    }
    // `isUnknownOutcomeReason` er uendret: `postcondition_mismatch`/`readback_failed` er IKKE «ukjent» der (andre forbrukere er festet til den).
    expect(isUnknownOutcomeReason("postcondition_mismatch")).toBe(false);
    expect(isUnknownOutcomeReason("postcondition_unverified:readback_failed")).toBe(false);
    expect(isUnknownOutcomeReason("tool_failed:tool_timeout")).toBe(true);
  });
});

describe("K6 (2): ukjent klasse D-infra-handling åpner en `high` hendelse", () => {
  it("alvorlighetsregelen: FAILED = high; UNKNOWN + klasse D = high; PARTIAL, UNKNOWN + klasse C og SUCCESS = normal", () => {
    expect(infraExecutionSeverity("FAILED", "D")).toBe("high");
    expect(infraExecutionSeverity("FAILED", "C")).toBe("high");
    expect(infraExecutionSeverity("UNKNOWN", "D")).toBe("high");
    expect(infraExecutionSeverity("UNKNOWN", "C")).toBe("normal");
    expect(infraExecutionSeverity("UNKNOWN", "B")).toBe("normal");
    expect(infraExecutionSeverity("PARTIAL", "D")).toBe("normal");
    expect(infraExecutionSeverity("PARTIAL", "C")).toBe("normal");
    expect(infraExecutionSeverity("SUCCESS", "D")).toBe("normal");
  });

  it("produsenten: journalrader (ekte, fra K6 (1)) og seedede rader gir riktig alvorlighet, fortsatt én hendelse per eksekusjon", async () => {
    const seed = (id: string, outcome: string, risk: string) => admin.query(
      `INSERT INTO infra_executions (execution_id, tenant_id, target, provider, tool_id, action, risk_class, idempotency_key, requested_operation, recovery_plan, verification_outcome, recovery_available, created_at)
       VALUES ($1, $2, 'web-1', 'docker', 'docker', 'redeploy_container', $3, $4, 'op', 'plan', $5, true, now() - interval '1 hour')`, [id, T, risk, `idem-${id}`, outcome]
    );
    await seed("k6p-unknown-d", "UNKNOWN", "D");
    await seed("k6p-unknown-c", "UNKNOWN", "C");
    await seed("k6p-partial-d", "PARTIAL", "D");
    await seed("k6p-failed-c", "FAILED", "C");
    await seed("k6p-success-d", "SUCCESS", "D");
    const observation = await infraExecutionProducer({ pool: app }).observe({ tenantId: T, memorySpace: "business", now: new Date() }, []);
    const bySubject = new Map(observation.present.map((f) => [f.subject, f.severity]));
    expect(bySubject.get("k6p-unknown-d")).toBe("high");
    expect(bySubject.get("k6p-unknown-c")).toBe("normal");
    expect(bySubject.get("k6p-partial-d")).toBe("normal");
    expect(bySubject.get("k6p-failed-c")).toBe("high");
    expect(bySubject.has("k6p-success-d")).toBe(false);
    // De ekte journalradene fra (1): UNKNOWN av en klasse D-handling (docker) -> high.
    const realUnknown = (await admin.query(`SELECT execution_id FROM infra_executions WHERE tenant_id = $1 AND idempotency_key = 'k6-a'`, [T])).rows[0] as { execution_id: string };
    expect(bySubject.get(realUnknown.execution_id)).toBe("high");
  });
});
