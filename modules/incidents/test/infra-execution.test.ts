import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolDefinition, type ToolTransport } from "@jarvis/tool-gateway";
import { attemptRecovery } from "../src/recovery.ts";
import { executeInfraMutation, getInfraExecution } from "../src/infra-execution.ts";

/**
 * D-105 (UA-5 kriterium 3): EKTE embedded-Postgres + EN EKTE `ToolGateway`
 * wired mot en in-memory Docker-simulator (samme "ekte mekanisme, fake
 * ytterste transport"-presedens som D-104s recovery.test.ts). Beviser
 * byggeordrens §U-punkter 11-24: before/after-snapshot, deterministisk diff,
 * fire-state operasjonelt utfall, ekte recovery MOT before_state (ikke bare
 * "HTTP 200 = suksess"), sentinel-sikkerhetsnektelse GJENNOM hele pipelinen,
 * pause/degrade/kill-switch-håndhevelse for docker-tool_id-et, og eksplisitt
 * tenant-isolasjon for eksekusjons-/recovery-journalen.
 */

const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT_A = "tenant-infra-a";
const TENANT_B = "tenant-infra-b";

const identityA: IdentityContext = {
  person_id: "person-owner-a", tenant_id: TENANT_A, memory_space_id: "business",
  session_id: "sess-infra-a", device_id: "dev-1", channel: "api", auth_strength: "active"
};
const identityB: IdentityContext = {
  person_id: "person-owner-b", tenant_id: TENANT_B, memory_space_id: "business",
  session_id: "sess-infra-b", device_id: "dev-2", channel: "api", auth_strength: "active"
};

interface FakeContainer {
  id: string; image: string; status: string; health: string | null; started_at: string; created_at: string; restart_count: number;
}

/** In-memory Docker-daemon - navn->tilstand. Speiler den EKTE `docker-transport.ts` sin JSON-form/nektelsessemantikk. */
class FakeDockerTransport implements ToolTransport {
  readonly containers = new Map<string, FakeContainer>();
  failRedeploy = false;
  /** Simulerer et kall som TEKNISK lykkes (HTTP-nivå) men lander på FEIL image - byggeordrens §K: "Do not define rollback as successful merely because the provider call returned HTTP 200". */
  landOnWrongImage: string | null = null;
  unavailable = false;
  private counter = 0;

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (this.unavailable) throw new Error("docker_daemon_unreachable");
    if (action === "list_containers") {
      return { data: [...this.containers.values()] as unknown as JsonValue };
    }
    if (action === "inspect_container") {
      const name = parameters["name"] as string;
      const c = this.containers.get(name);
      if (!c) return { data: null };
      return { data: { ...c } as unknown as JsonValue };
    }
    if (action === "get_logs") {
      return { data: [{ timestamp: "2026-01-01T00:00:00.000Z", message: "startup ok TOKEN=abc123secretvalue" }] as unknown as JsonValue };
    }
    if (action === "redeploy_container") {
      const name = parameters["name"] as string;
      const image = parameters["image"] as string;
      if (!name.startsWith("jarvis-sentinel-")) throw new Error(`docker_redeploy_refused_unsafe_target:${name}`);
      if (this.failRedeploy) throw new Error("docker_run_failed:simulated_outage");
      const id = `c-${(this.counter++).toString(36)}`;
      const actualImage = this.landOnWrongImage ?? image;
      const state: FakeContainer = { id, image: actualImage, status: "running", health: null, started_at: new Date().toISOString(), created_at: new Date().toISOString(), restart_count: 0 };
      this.containers.set(name, state);
      return { external_id: id, data: { ...state } as unknown as JsonValue };
    }
    throw new Error(`unsupported_fake_action:${action}`);
  }
}

function dockerToolDefinitions(transport: ToolTransport): ToolDefinition[] {
  const record = (fields: Record<string, z.ZodTypeAny>) => z.object(fields).passthrough() as unknown as ToolDefinition["input_schema"];
  const base = { scopes: [], idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN", output_trust: "untrusted" as const, transport };
  return [
    { tool_id: "docker", action: "list_containers", description: "test", input_schema: record({}), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    { tool_id: "docker", action: "inspect_container", description: "test", input_schema: record({ name: z.string() }), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    { tool_id: "docker", action: "get_logs", description: "test", input_schema: record({ name: z.string() }), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    {
      tool_id: "docker", action: "redeploy_container", description: "test", input_schema: record({ name: z.string(), image: z.string() }),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "docker.redeploy_container med before_state.image",
      idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN",
      output_trust: "internal" as const, transport, preflight_action: "inspect_container"
    }
  ];
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-infra-exec-"));
  epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_infra_exec LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_infra_exec");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','InfraA','business'), ('${TENANT_B}','InfraB','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-owner-a','OwnerA'), ('person-owner-b','OwnerB');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner-a','${TENANT_A}'), ('person-owner-b','${TENANT_B}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_infra_exec", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function buildGateway(transport: FakeDockerTransport, opts: { infraGate?: InfraExecutionGate; controls?: import("@jarvis/policy").OwnerControls } = {}): ToolGateway {
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
    ...(opts.infraGate ? { infraGate: opts.infraGate, infraToolIds: new Set(["docker"]) } : {}),
    ...(opts.controls ? { controls: opts.controls } : {}),
    authority: { owner_person_id: identityA.person_id, owner_tenants: [identityA.tenant_id, identityB.tenant_id] }
  });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-docker-bin" };
  const gateway = new ToolGateway(appPool, policy, secrets, opts.controls);
  for (const def of dockerToolDefinitions(transport)) gateway.register(def);
  return gateway;
}

describe("D-105: kritisk infra-eksekusjonsjournal v2 (EKTE ToolGateway, in-memory Docker-simulator)", () => {
  it("A: FØRSTE deploy (ingen tidligere container) - before_state=null, after_state fanget, SUCCESS, recovery_available=false (ingen tidligere tilstand å gjenopprette)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-a", target_image: "alpine:3.20", idempotency_key: "infra-key-a"
    });
    expect(execution.before_state).toBeNull();
    expect(execution.after_state).not.toBeNull();
    expect(execution.verification_outcome).toBe("SUCCESS");
    expect(execution.recovery_available).toBe(false);
    expect(execution.state_diff).toBeNull(); // ingen sammenlignbar before - ALDRI et fabrikkert diff
  });

  it("B: ANDRE deploy (ekte tidligere tilstand) - before_state fanget, diff viser FAKTISK image-endring, recovery_available=true", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-b", target_image: "alpine:3.19", idempotency_key: "infra-key-b1"
    });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-b", target_image: "alpine:3.20", idempotency_key: "infra-key-b2"
    });
    expect(execution.before_state).toMatchObject({ image: "alpine:3.19" });
    expect(execution.after_state).toMatchObject({ image: "alpine:3.20" });
    expect(execution.verification_outcome).toBe("SUCCESS");
    expect(execution.recovery_available).toBe(true);
    expect(execution.state_diff).toMatchObject({ changed: { image: { before: "alpine:3.19", after: "alpine:3.20" } } });
    expect(execution.recovery_plan).toContain("alpine:3.19");
  });

  it("C: mislykket underliggende docker-kall gir EKSPLISITT FAILED, ALDRI fabrikkert SUCCESS", async () => {
    const transport = new FakeDockerTransport();
    transport.failRedeploy = true;
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-c", target_image: "alpine:3.20", idempotency_key: "infra-key-c"
    });
    expect(execution.verification_outcome).toBe("FAILED");
  });

  it("D: kallet lykkes teknisk men lander på FEIL image - EKSPLISITT PARTIAL, ikke SUCCESS (§K: HTTP 200 er ikke nok)", async () => {
    const transport = new FakeDockerTransport();
    transport.landOnWrongImage = "alpine:UNEXPECTED";
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-d", target_image: "alpine:3.20", idempotency_key: "infra-key-d"
    });
    expect(execution.verification_outcome).toBe("PARTIAL");
  });

  it("E: sentinel-sikkerhetsnektelsen håndheves GJENNOM HELE pipelinen (ikke bare i transporten isolert) - ikke-sentinel-mål gir FAILED", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "production-database", target_image: "postgres:16", idempotency_key: "infra-key-e"
    });
    expect(execution.verification_outcome).toBe("FAILED");
    expect(transport.containers.has("production-database")).toBe(false);
  });

  it("F: ekte recovery MOT before_state - redeployer tilbake til FAKTISK forrige image, reinspiserer for å VERIFISERE (ikke bare stole på at kallet returnerte ok)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-f", target_image: "alpine:3.19", idempotency_key: "infra-key-f1"
    });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-f", target_image: "alpine:3.20", idempotency_key: "infra-key-f2"
    });
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-f2",
      parameters: { name: "jarvis-sentinel-f", image: "alpine:3.20" }, execution_id: execution.execution_id
    });
    expect(recovery.status).toBe("SUCCESS");
    expect(transport.containers.get("jarvis-sentinel-f")?.image).toBe("alpine:3.19"); // FAKTISK gjenopprettet
    expect(recovery.recovery_of_execution_id).toBe(execution.execution_id); // §K: peker TILBAKE til opprinnelig eksekusjon
  });

  it("G: recovery-kallet lykkes teknisk, men REINSPEKSJONEN viser feil image - EKSPLISITT PARTIAL, ikke fabrikkert SUCCESS", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-g", target_image: "alpine:3.19", idempotency_key: "infra-key-g1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-g", target_image: "alpine:3.20", idempotency_key: "infra-key-g2"
    });
    transport.landOnWrongImage = "alpine:STILL-WRONG"; // recovery-forsøket lander OGSÅ feil
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-g2",
      parameters: { name: "jarvis-sentinel-g", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("PARTIAL");
  });

  it("H: recovery-kallet feiler direkte - EKSPLISITT FAILED", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-h", target_image: "alpine:3.19", idempotency_key: "infra-key-h1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-h", target_image: "alpine:3.20", idempotency_key: "infra-key-h2"
    });
    transport.failRedeploy = true;
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-h2",
      parameters: { name: "jarvis-sentinel-h", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("FAILED");
  });

  it("I: InfraExecutionGate PAUSED blokkerer nye docker-mutasjoner (samme håndhevelse som github)", async () => {
    const transport = new FakeDockerTransport();
    const infraGate = new InfraExecutionGate();
    const gateway = buildGateway(transport, { infraGate });
    infraGate.pause("incident response");
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-i", target_image: "alpine:3.20", idempotency_key: "infra-key-i"
    });
    expect(execution.verification_outcome).toBe("FAILED");
    expect(transport.containers.has("jarvis-sentinel-i")).toBe(false);
  });

  it("J: lese-diagnostikk (docker.inspect_container, klasse A) forblir TILGJENGELIG mens PAUSED - kun mutasjon (klasse D) blokkeres", async () => {
    const transport = new FakeDockerTransport();
    const infraGate = new InfraExecutionGate();
    const gateway = buildGateway(transport, { infraGate });
    infraGate.pause("incident response");
    const result = await gateway.execute({ identity: identityA, tool_id: "docker", action: "inspect_container", parameters: { name: "anything" } });
    expect(result.ok).toBe(true); // klasse A - ALDRI blokkert av PAUSED
  });

  it("K: FROSSET connector blokkerer docker-recovery identisk med enhver annen mutasjon", async () => {
    const { OwnerControls } = await import("@jarvis/policy");
    const transport = new FakeDockerTransport();
    const killSwitch = new KillSwitch();
    const controls = new OwnerControls(killSwitch);
    const gateway = buildGateway(transport, { controls });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-k", target_image: "alpine:3.19", idempotency_key: "infra-key-k1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-k", target_image: "alpine:3.20", idempotency_key: "infra-key-k2"
    });
    controls.freezeConnector("docker");
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-k2",
      parameters: { name: "jarvis-sentinel-k", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("FAILED");
  });

  it("L: KillSwitch forblir overordnet InfraExecutionGate for docker (samme presedens som github i D-104)", async () => {
    const transport = new FakeDockerTransport();
    const infraGate = new InfraExecutionGate(); // NORMAL - ikke selv blokkerende
    const killSwitch = new KillSwitch();
    killSwitch.activate("test");
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
      infraGate, infraToolIds: new Set(["docker"]),
      authority: { owner_person_id: identityA.person_id, owner_tenants: [identityA.tenant_id] }
    });
    const secrets: SecretProvider = { name: "fake", get: async () => "fake-docker-bin" };
    const gateway = new ToolGateway(appPool, policy, secrets);
    for (const def of dockerToolDefinitions(transport)) gateway.register(def);
    const result = await gateway.execute({ identity: identityA, tool_id: "docker", action: "inspect_container", parameters: { name: "x" } });
    expect(result.ok).toBe(false); // klasse A blokkert av KillSwitch (ALDRI av InfraExecutionGate alene)
  });

  it("M: TENANT-ISOLASJON - tenant B kan IKKE lese tenant A sin infra_executions-rad", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-m", target_image: "alpine:3.20", idempotency_key: "infra-key-m"
    });
    const asOwner = await getInfraExecution(appPool, TENANT_A, execution.execution_id);
    expect(asOwner).not.toBeNull();
    const asOtherTenant = await getInfraExecution(appPool, TENANT_B, execution.execution_id);
    expect(asOtherTenant).toBeNull();
  });

  it("N: TENANT-ISOLASJON - tenant B kan IKKE trigge recovery mot tenant A sin idempotency_key (before_state utilgjengelig på tvers av tenant -> UNKNOWN, ALDRI lekket/gjettet)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-n", target_image: "alpine:3.19", idempotency_key: "infra-key-n1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-n", target_image: "alpine:3.20", idempotency_key: "infra-key-n2"
    });
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityB, {
      tenant_id: TENANT_B, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-n2",
      parameters: { name: "jarvis-sentinel-n", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("UNKNOWN"); // tenant B ser INGEN before_state for tenant A sin nøkkel
  });
});
