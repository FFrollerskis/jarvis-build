import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ToolGateway, authorizeDockerTarget, type DockerMutationAction, type SecretProvider, type ToolDefinition, type ToolTransport
} from "@jarvis/tool-gateway";
import { attemptRecovery } from "../src/recovery.ts";
import { executeInfraMutation, getInfraExecution } from "../src/infra-execution.ts";

/**
 * D-105 (UA-5 kriterium 3) + D-105 host-fix (D-41-korreksjon): EKTE embedded-
 * Postgres + EN EKTE `ToolGateway` wired mot en in-memory Docker-simulator
 * (samme "ekte mekanisme, fake ytterste transport"-presedens som D-104s
 * recovery.test.ts). Beviser byggeordrens §U-punkter 11-24 OG host-fix-
 * ordrens §18-testmatrise: before/after-snapshot, deterministisk diff, fire-
 * state operasjonelt utfall, ekte recovery MOT before_state (ikke bare "HTTP
 * 200 = suksess"), EIER-KONFIGURERT produksjons-mål-autorisasjon (§3/§4/§5 -
 * IKKE lenger et transport-nivå sentinel-only-forbud), pause/degrade/frys/
 * kill-switch-håndhevelse for docker-tool_id-et (utvidet til nye handlinger),
 * sovereign-eier-autoritet UTEN manuell godkjenning, og eksplisitt tenant-
 * isolasjon for eksekusjons-/recovery-journalen.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
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

/** In-memory Docker-daemon - navn->tilstand. Speiler den EKTE `docker-transport.ts` sin JSON-form. TRANSPORTEN selv håndhever INGEN mål-autorisasjon (D-105 host-fix) - kun ToolDefinition.parameterAuthorizer, samme som produksjonskoden. */
class FakeDockerTransport implements ToolTransport {
  readonly containers = new Map<string, FakeContainer>();
  failRedeploy = false;
  /** WP-K (delta-review L-1): containeren ER startet (tilstanden endres), men transporten kaster `outcome_unknown:` bagen (inspect feilet ETTER `docker run -d`) - utfallet er UKJENT. */
  unknownAfterRedeploy = false;
  failStop = false;
  failStart = false;
  /** Simulerer et kall som TEKNISK lykkes (HTTP-nivå) men lander på FEIL image - byggeordrens §K: "Do not define rollback as successful merely because the provider call returned HTTP 200". */
  landOnWrongImage: string | null = null;
  unavailable = false;
  private counter = 0;

  /** Testhjelper: seed en container DIREKTE (ikke via invoke()) - simulerer en EKTE, allerede kjørende produksjonscontainer FØR testen starter (samme rolle som en ekte docker-daemon sin eksisterende tilstand). */
  seed(name: string, image: string, status: "running" | "exited" = "running"): void {
    this.containers.set(name, {
      id: `c-${(this.counter++).toString(36)}`, image, status, health: null,
      started_at: new Date().toISOString(), created_at: new Date().toISOString(), restart_count: 0
    });
  }

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
      if (this.failRedeploy) throw new Error("docker_run_failed:simulated_outage");
      const id = `c-${(this.counter++).toString(36)}`;
      const actualImage = this.landOnWrongImage ?? image;
      const state: FakeContainer = { id, image: actualImage, status: "running", health: null, started_at: new Date().toISOString(), created_at: new Date().toISOString(), restart_count: 0 };
      this.containers.set(name, state);
      if (this.unknownAfterRedeploy) throw new Error("outcome_unknown:docker_post_deploy_inspect_failed");
      return { external_id: id, data: { ...state } as unknown as JsonValue };
    }
    if (action === "stop_container") {
      const name = parameters["name"] as string;
      if (this.failStop) throw new Error("docker_stop_failed:simulated_outage");
      const existing = this.containers.get(name);
      if (!existing) throw new Error("docker_stop_failed:no_such_container");
      const state: FakeContainer = { ...existing, status: this.landOnWrongImage ? existing.status : "exited" };
      this.containers.set(name, state);
      return { external_id: state.id, data: { ...state } as unknown as JsonValue };
    }
    if (action === "start_container") {
      const name = parameters["name"] as string;
      if (this.failStart) throw new Error("docker_start_failed:simulated_outage");
      const existing = this.containers.get(name);
      if (!existing) throw new Error("docker_start_failed:no_such_container");
      const state: FakeContainer = { ...existing, status: this.landOnWrongImage ? existing.status : "running" };
      this.containers.set(name, state);
      return { external_id: state.id, data: { ...state } as unknown as JsonValue };
    }
    throw new Error(`unsupported_fake_action:${action}`);
  }
}

/** D-105 host-fix: SPEILER de EKTE ToolDefinitions i integrations.ts (inkl. `parameterAuthorizer` via den EKTE `authorizeDockerTarget()`) - IKKE en forenklet fake-versjon av autorisasjonslogikken. */
function dockerToolDefinitions(transport: ToolTransport, dockerMutationTargets: ReadonlySet<string> = new Set()): ToolDefinition[] {
  const record = (fields: Record<string, z.ZodTypeAny>) => z.object(fields).passthrough() as unknown as ToolDefinition["input_schema"];
  const base = { scopes: [], idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN", output_trust: "untrusted" as const, transport };
  const authorizer = (action: DockerMutationAction) => (parameters: Record<string, JsonValue>) => {
    const name = parameters["name"];
    if (typeof name !== "string") return { allowed: false, reason: "missing_name_parameter" };
    return authorizeDockerTarget(action, name, dockerMutationTargets);
  };
  return [
    { tool_id: "docker", action: "list_containers", description: "test", input_schema: record({}), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    { tool_id: "docker", action: "inspect_container", description: "test", input_schema: record({ name: z.string() }), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    { tool_id: "docker", action: "get_logs", description: "test", input_schema: record({ name: z.string() }), capability_class: "A", reversible: true, rollback_procedure: "n/a", ...base },
    {
      tool_id: "docker", action: "redeploy_container", description: "test", input_schema: record({ name: z.string(), image: z.string() }),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "docker.redeploy_container med before_state.image",
      idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN",
      output_trust: "internal" as const, transport, preflight_action: "inspect_container", parameterAuthorizer: authorizer("redeploy_container")
    },
    {
      tool_id: "docker", action: "stop_container", description: "test", input_schema: record({ name: z.string() }),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "docker.start_container",
      idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN",
      output_trust: "internal" as const, transport, preflight_action: "inspect_container", parameterAuthorizer: authorizer("stop_container")
    },
    {
      tool_id: "docker", action: "start_container", description: "test", input_schema: record({ name: z.string() }),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "docker.stop_container",
      idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_DOCKER_BIN",
      output_trust: "internal" as const, transport, preflight_action: "inspect_container", parameterAuthorizer: authorizer("start_container")
    }
  ];
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-infra-exec-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
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
  await stopEmbeddedPostgres?.();
}, 120_000);

function buildGateway(
  transport: FakeDockerTransport,
  opts: {
    infraGate?: InfraExecutionGate; controls?: import("@jarvis/policy").OwnerControls;
    dockerMutationTargets?: ReadonlySet<string>; ownerTenants?: string[];
  } = {}
): ToolGateway {
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
    ...(opts.infraGate ? { infraGate: opts.infraGate, infraToolIds: new Set(["docker"]) } : {}),
    ...(opts.controls ? { controls: opts.controls } : {}),
    authority: { owner_person_id: identityA.person_id, owner_tenants: opts.ownerTenants ?? [identityA.tenant_id, identityB.tenant_id] }
  });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-docker-bin" };
  const gateway = new ToolGateway(appPool, policy, secrets, opts.controls);
  for (const def of dockerToolDefinitions(transport, opts.dockerMutationTargets)) gateway.register(def);
  return gateway;
}

describe("D-105: kritisk infra-eksekusjonsjournal v2 (EKTE ToolGateway, in-memory Docker-simulator)", () => {
  it("A: FØRSTE deploy (ingen tidligere container) - before_state=null, after_state fanget, SUCCESS, recovery_available=false (ingen tidligere tilstand å gjenopprette)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-sentinel-a"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-a", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-a"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-b", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-b1"
    });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-b", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-b2"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-c", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-c"
    });
    expect(execution.verification_outcome).toBe("FAILED");
  });

  it("C2 (WP-K delta-review L-1): UKJENT utfall etter akseptert redeploy (`outcome_unknown:...`, ledger `unverified`) journalføres som UNKNOWN - ikke FAILED - og før-tilstanden/recovery bevares; en gjentatt nøkkel gir samme rad uten ny utførelse", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-sentinel-c2", "alpine:3.19");
    transport.unknownAfterRedeploy = true;
    const gateway = buildGateway(transport);
    const input = { tenant_id: TENANT_A, target: "jarvis-sentinel-c2", action: "redeploy_container" as const, target_image: "alpine:3.20", idempotency_key: "infra-key-c2" };
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, input);
    expect(execution.verification_outcome).toBe("UNKNOWN");
    expect((execution.provider_receipt as { reason: string }).reason).toBe("tool_failed:outcome_unknown:docker_post_deploy_inspect_failed");
    expect(execution.before_state).toMatchObject({ image: "alpine:3.19" }); // ledgerens før-tilstand (preflight kjørte)
    expect(execution.recovery_available).toBe(true);
    expect(execution.recovery_plan).toContain("alpine:3.19");
    const ledger = (await adminPool.query("SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT_A, "infra-key-c2"])).rows[0] as { status: string };
    expect(ledger.status).toBe("unverified");
    const again = await executeInfraMutation({ pool: appPool, gateway }, identityA, input);
    expect(again.execution_id).toBe(execution.execution_id);
  });

  it("D: kallet lykkes teknisk men lander på FEIL image - EKSPLISITT PARTIAL, ikke SUCCESS (§K: HTTP 200 er ikke nok)", async () => {
    const transport = new FakeDockerTransport();
    transport.landOnWrongImage = "alpine:UNEXPECTED";
    const gateway = buildGateway(transport);
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-d", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-d"
    });
    expect(execution.verification_outcome).toBe("PARTIAL");
  });

  it("E: redeploy_container mot et ikke-sentinel mål er FORTSATT DEFERRED for produksjon SELV OM målet er eier-konfigurert (§13 i host-fix-ordren) - gir FAILED", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["production-database"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "production-database", action: "redeploy_container", target_image: "postgres:16", idempotency_key: "infra-key-e"
    });
    expect(execution.verification_outcome).toBe("FAILED");
    expect(transport.containers.has("production-database")).toBe(false);
  });

  it("F: ekte recovery MOT before_state - redeployer tilbake til FAKTISK forrige image, reinspiserer for å VERIFISERE (ikke bare stole på at kallet returnerte ok)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-f", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-f1"
    });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-f", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-f2"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-g", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-g1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-g", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-g2"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-h", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-h1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-h", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-h2"
    });
    transport.failRedeploy = true;
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-h2",
      parameters: { name: "jarvis-sentinel-h", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("FAILED");
  });

  it("H2 (JARVIS-068/TSK-033): recovery mot et ANNET containernavn enn den journalførte eksekusjonen nektes (recovery_target_mismatch) - ingen container røres", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-h2", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-h2-1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-h2", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-h2-2"
    });
    transport.seed("jarvis-sentinel-other", "alpine:9.9", "running");
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-h2-2",
      parameters: { name: "jarvis-sentinel-other", image: "alpine:3.20" } // kallerens mål er ikke eksekusjonens mål
    });
    expect(recovery.status).toBe("FAILED");
    expect(recovery.recovery_result).toMatchObject({ reason: "recovery_target_mismatch" });
    expect(transport.containers.get("jarvis-sentinel-other")?.image).toBe("alpine:9.9"); // urørt
    expect(transport.containers.get("jarvis-sentinel-h2")?.image).toBe("alpine:3.20"); // heller ikke det opprinnelige målet ble rullet tilbake
  });

  it("I: InfraExecutionGate PAUSED blokkerer nye docker-mutasjoner (samme håndhevelse som github)", async () => {
    const transport = new FakeDockerTransport();
    const infraGate = new InfraExecutionGate();
    const gateway = buildGateway(transport, { infraGate });
    infraGate.pause("incident response");
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-i", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-i"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-k", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-k1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-k", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-k2"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-m", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-m"
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
      tenant_id: TENANT_A, target: "jarvis-sentinel-n", action: "redeploy_container", target_image: "alpine:3.19", idempotency_key: "infra-key-n1"
    });
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-n", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-n2"
    });
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityB, {
      tenant_id: TENANT_B, tool_id: "docker", action: "redeploy_container", idempotency_key: "infra-key-n2",
      parameters: { name: "jarvis-sentinel-n", image: "alpine:3.20" }
    });
    expect(recovery.status).toBe("UNKNOWN"); // tenant B ser INGEN before_state for tenant A sin nøkkel
  });
});

describe("D-105 host-fix (D-41-korreksjon): eier-konfigurert produksjons-mål-autorisasjon for stop_container/start_container", () => {
  it("O: KONFIGURERT produksjonsmål + stop_container -> SUCCESS (ekte kjøretilstandsendring, ingen konfigurasjon å miste)", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "stop_container", idempotency_key: "infra-key-o"
    });
    expect(execution.verification_outcome).toBe("SUCCESS");
    expect(execution.before_state).toMatchObject({ status: "running" });
    expect(execution.after_state).toMatchObject({ status: "exited" });
    expect(execution.recovery_plan).toContain("start_container");
  });

  it("P: UKONFIGURERT produksjonsmål + stop_container -> FAILED (fail-closed), containeren FORBLIR urørt", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-worker-1", "jarvis-worker:v1", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) }); // worker IKKE i settet
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-worker-1", action: "stop_container", idempotency_key: "infra-key-p"
    });
    expect(execution.verification_outcome).toBe("FAILED");
    expect(transport.containers.get("jarvis-worker-1")?.status).toBe("running"); // urørt
  });

  it("Q: KONFIGURERT mål + start_container mot en IKKE-kjørende container -> SUCCESS", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "exited");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "start_container", idempotency_key: "infra-key-q"
    });
    expect(execution.verification_outcome).toBe("SUCCESS");
    expect(execution.recovery_plan).toContain("stop_container");
  });

  it("R: recovery for stop_container - gjenoppretter til FAKTISK before-tilstand (running), reinspiserer for å verifisere", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "stop_container", idempotency_key: "infra-key-r"
    });
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "stop_container", idempotency_key: "infra-key-r",
      parameters: { name: "jarvis-api-1" }, execution_id: execution.execution_id
    });
    expect(recovery.status).toBe("SUCCESS");
    expect(transport.containers.get("jarvis-api-1")?.status).toBe("running");
    expect(recovery.recovery_of_execution_id).toBe(execution.execution_id);
  });

  it("S: recovery for start_container (opprinnelig NEDE) - gjenoppretter til FAKTISK before-tilstand (exited)", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "exited");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "start_container", idempotency_key: "infra-key-s"
    });
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "start_container", idempotency_key: "infra-key-s",
      parameters: { name: "jarvis-api-1" }, execution_id: execution.execution_id
    });
    expect(recovery.status).toBe("SUCCESS");
    expect(transport.containers.get("jarvis-api-1")?.status).toBe("exited");
  });

  it("T: recovery-reinspeksjonen viser FEIL kjøretilstand - EKSPLISITT PARTIAL, ikke fabrikkert SUCCESS", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "stop_container", idempotency_key: "infra-key-t"
    });
    transport.landOnWrongImage = "irrelevant-but-truthy"; // FakeDockerTransport: gjør at stop/start-simuleringen IKKE endrer status
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "stop_container", idempotency_key: "infra-key-t",
      parameters: { name: "jarvis-api-1" }, execution_id: execution.execution_id
    });
    expect(recovery.status).toBe("PARTIAL");
  });

  it("U: SOVEREIGN eier - klasse D stop_container mot et KONFIGURERT mål utføres UTEN godkjenningsobjekt (ingen tvunget menneskelig godkjenning innført)", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const result = await gateway.execute({
      identity: identityA, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-api-1" }, idempotency_key: "infra-key-u"
    }); // INGEN `approval`-felt sendt
    expect(result.ok).toBe(true);
  });

  it("V: en identitet UTENFOR owner_tenants (ikke sovereign) NEKTES på AUTORITETS-nivå for stop_container - target-autorisasjon utvider ALDRI hvem som har myndighet, kun HVILKE mål en allerede-autorisert aktør kan nå", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    // owner_tenants inneholder KUN tenant A denne gangen - tenant B er en scoped/delegert tenant.
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]), ownerTenants: [identityA.tenant_id] });
    const result = await gateway.execute({
      identity: identityB, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-api-1" }, idempotency_key: "infra-key-v"
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("class_d_missing_approval");
    expect(transport.containers.get("jarvis-api-1")?.status).toBe("running"); // urørt
  });

  it("W: DEGRADED blokkerer klasse D stop_container mot et KONFIGURERT produksjonsmål (samme håndhevelse som redeploy_container)", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const infraGate = new InfraExecutionGate();
    const gateway = buildGateway(transport, { infraGate, dockerMutationTargets: new Set(["jarvis-api-1"]) });
    infraGate.degrade("elevated risk");
    const result = await gateway.execute({
      identity: identityA, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-api-1" }, idempotency_key: "infra-key-w"
    });
    expect(result.ok).toBe(false);
    expect(transport.containers.get("jarvis-api-1")?.status).toBe("running"); // urørt
  });

  it("X: KillSwitch blokkerer klasse D stop_container mot et KONFIGURERT produksjonsmål", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const killSwitch = new KillSwitch();
    killSwitch.activate("test");
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
      authority: { owner_person_id: identityA.person_id, owner_tenants: [identityA.tenant_id] }
    });
    const secrets: SecretProvider = { name: "fake", get: async () => "fake-docker-bin" };
    const gateway = new ToolGateway(appPool, policy, secrets);
    for (const def of dockerToolDefinitions(transport, new Set(["jarvis-api-1"]))) gateway.register(def);
    const result = await gateway.execute({
      identity: identityA, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-api-1" }, idempotency_key: "infra-key-x"
    });
    expect(result.ok).toBe(false);
    expect(transport.containers.get("jarvis-api-1")?.status).toBe("running"); // urørt
  });

  it("Y: FROSSET connector blokkerer stop_container-recovery for produksjonsmål identisk med enhver annen mutasjon", async () => {
    const { OwnerControls } = await import("@jarvis/policy");
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const killSwitch = new KillSwitch();
    const controls = new OwnerControls(killSwitch);
    const gateway = buildGateway(transport, { controls, dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "stop_container", idempotency_key: "infra-key-y"
    });
    controls.freezeConnector("docker");
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, tool_id: "docker", action: "stop_container", idempotency_key: "infra-key-y",
      parameters: { name: "jarvis-api-1" }, execution_id: execution.execution_id
    });
    expect(recovery.status).toBe("FAILED");
  });

  it("Z: TENANT-ISOLASJON holder OGSÅ for produksjonsmål - konfigurasjon er nødvendigvis vert-nivå (Docker-containere er ikke tenant-partisjonert), men eksekusjons-/recovery-JOURNALEN forblir strengt tenant-partisjonert: tenant B sin egen mutasjon mot SAMME konfigurerte mål oppretter en EGEN rad, tenant A kan ikke lese den", async () => {
    const transport = new FakeDockerTransport();
    transport.seed("jarvis-api-1", "jarvis-api:v42", "running");
    const gateway = buildGateway(transport, { dockerMutationTargets: new Set(["jarvis-api-1"]) });
    const executionA = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-api-1", action: "stop_container", idempotency_key: "infra-key-z-a"
    });
    const executionB = await executeInfraMutation({ pool: appPool, gateway }, identityB, {
      tenant_id: TENANT_B, target: "jarvis-api-1", action: "start_container", idempotency_key: "infra-key-z-b"
    });
    expect(executionA.execution_id).not.toBe(executionB.execution_id);
    const bReadByA = await getInfraExecution(appPool, TENANT_A, executionB.execution_id);
    expect(bReadByA).toBeNull();
    const aReadByB = await getInfraExecution(appPool, TENANT_B, executionA.execution_id);
    expect(aReadByB).toBeNull();
  });
});

describe("D-398 (JARVIS-094): journal-idempotens og nøkkelkollisjon", () => {
  it("retry med SAMME nøkkel/mål/handling returnerer den eksisterende journalraden - ingen UNIQUE-krasj, ingen ny rad", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    const input = { tenant_id: TENANT_A, target: "jarvis-sentinel-idem", action: "redeploy_container" as const, target_image: "alpine:3.20", idempotency_key: "infra-key-idem-1" };
    const first = await executeInfraMutation({ pool: appPool, gateway }, identityA, input);
    const again = await executeInfraMutation({ pool: appPool, gateway }, identityA, input);
    expect(again.execution_id).toBe(first.execution_id);
    const { rows } = await adminPool.query("SELECT count(*)::int AS n FROM infra_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT_A, input.idempotency_key]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("samme nøkkel for et ANNET mål/en annen handling => eksplisitt infra_idempotency_key_conflict (aldri stille gjenbruk)", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-conf-a", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-conflict"
    });
    await expect(executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-conf-b", action: "stop_container", idempotency_key: "infra-key-conflict"
    })).rejects.toThrow("infra_idempotency_key_conflict");
  });

  it("nøkkelen allerede brukt av en ANNEN handling i tool_executions => UNKNOWN (ikke SUCCESS), med key_collision i kvitteringen", async () => {
    const transport = new FakeDockerTransport();
    const gateway = buildGateway(transport);
    await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-kc", action: "redeploy_container", target_image: "alpine:3.20", idempotency_key: "infra-key-kc-0"
    });
    // Bruk en nøkkel direkte mot gatewayen (ingen journalrad) for en annen handling...
    await gateway.execute({ identity: identityA, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-sentinel-kc" }, idempotency_key: "infra-key-kc-shared" });
    // ...og gjenbruk SAMME nøkkel til en redeploy: gatewayen dedupliserer, men tool_executions-raden tilhører stop_container.
    const execution = await executeInfraMutation({ pool: appPool, gateway }, identityA, {
      tenant_id: TENANT_A, target: "jarvis-sentinel-kc", action: "redeploy_container", target_image: "alpine:3.21", idempotency_key: "infra-key-kc-shared"
    });
    expect(execution.verification_outcome).not.toBe("SUCCESS");
    expect(execution.before_state).toBeNull();
    expect(execution.after_state).toBeNull();
    expect(JSON.stringify(execution.provider_receipt)).toContain("key_collision");
  });
});
