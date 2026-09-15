import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, homeAssistantTools, type ToolDefinition, type ToolTransport } from "@jarvis/tool-gateway";

/**
 * Q-34 (funnet 2026-09-09, D-130 - UA-8 akseptansekriterium 3): en klasse D-
 * mutasjon var fail-closed på et ukjent mål KUN som en TILFELDIGHET av at
 * preflight-transporten kastet for det ukjente målet - en (like plausibel)
 * transport som i stedet lykkes med `data: null` lot mutasjonen rapportere
 * `ok: true` mot et mål som aldri fantes. Reviewen krevde EN cross-domene-
 * audit-slice FØR en generisk `gateway.ts`-fiks, fordi minst ett eksisterende
 * klasse D-verktøy (`docker.redeploy_container`, D-105) har en LEGITIM
 * "målet finnes ikke ennå" preflight-utfall som en generisk "null = avvis"
 * -regel ville ha ødelagt.
 *
 * Denne filen beviser tre ting, ikke bare én:
 *   A. Den GENERISKE mekanismen i `gateway.ts` (opt-in via
 *      `preflight_requires_target`, default UENDRET oppførsel).
 *   B. AUDIT-EN SOM KODE: enhver EKSISTERENDE klasse D + `preflight_action`-
 *      kombinasjon i de FAKTISKE produksjonsdefinisjonene har gjort et
 *      EKSPLISITT true/false-valg - ingen ny kombinasjon kan smette forbi
 *      denne testen uten at NOEN eksplisitt tar stilling til den (se skjema
 *      under). Dette er selve "aldri en stille utelatelse"-garantien.
 *   C. Konkret, per-domene ATFERD gjennom den EKTE `ToolGateway.execute()`-
 *      pipelinen: Home Assistant (se egen fil, `home-assistant-critical-
 *      action.test.ts`, F), Docker (stop/start avvist, redeploy fortsatt
 *      tillatt), og GitHub (defense-in-depth for et domene der den ekte
 *      transporten allerede kaster).
 */

/**
 * Skjemaet et EKSISTERENDE klasse D + `preflight_action`-verktøy har gjort et
 * eksplisitt, revidert valg for. `true` = et null/undefined preflight-resultat
 * betyr STRUKTURELT "mål finnes ikke" for AKKURAT denne handlingen (bevist i
 * en kode-kommentar ved definisjonen). `false` = et null/undefined resultat
 * ER en gyldig, forventet tilstand for AKKURAT denne handlingen (i dag kun
 * `docker.redeploy_container`, D-105 - førstegangs-deploy).
 *
 * Legger noen til en NY klasse D-handling med `preflight_action` uten å
 * legge den til her: testen B under FEILER, og tvinger et eksplisitt valg -
 * det er hele poenget, ikke en glipp å fikse ved å bare utvide listen blindt.
 */
const AUDITED_CLASS_D_PREFLIGHT_DECISIONS: ReadonlyArray<{ tool_id: string; action: string; requires_target: boolean }> = [
  { tool_id: "home-assistant", action: "lock_set", requires_target: true },
  { tool_id: "home-assistant", action: "alarm_set", requires_target: true },
  { tool_id: "drive", action: "delete_permanent", requires_target: true },
  { tool_id: "drive", action: "create_permission", requires_target: true },
  { tool_id: "drive", action: "update_permission", requires_target: true },
  { tool_id: "drive", action: "delete_permission", requires_target: true },
  { tool_id: "github", action: "merge_pr", requires_target: true },
  { tool_id: "github", action: "delete_branch", requires_target: true },
  { tool_id: "docker", action: "redeploy_container", requires_target: false },
  { tool_id: "docker", action: "stop_container", requires_target: true },
  { tool_id: "docker", action: "start_container", requires_target: true }
];

describe("B: audit-as-code - ALLE eksisterende klasse D + preflight_action-verktøy har et EKSPLISITT, revidert valg", () => {
  const allDefinitions: ToolDefinition[] = [...homeAssistantTools(), ...firstWaveTools()];
  const classDWithPreflight = allDefinitions.filter((d) => d.capability_class === "D" && d.preflight_action);

  it("ingen klasse D + preflight_action-verktøy er UDOKUMENTERT (mangler i revisjonslisten over)", () => {
    const audited = new Set(AUDITED_CLASS_D_PREFLIGHT_DECISIONS.map((a) => `${a.tool_id}:${a.action}`));
    const undocumented = classDWithPreflight
      .map((d) => `${d.tool_id}:${d.action}`)
      .filter((key) => !audited.has(key));
    expect(undocumented).toEqual([]);
  });

  it("revisjonslisten selv er ikke stale - hvert oppførte verktøy finnes fortsatt som klasse D + preflight_action", () => {
    const actual = new Set(classDWithPreflight.map((d) => `${d.tool_id}:${d.action}`));
    const stale = AUDITED_CLASS_D_PREFLIGHT_DECISIONS.map((a) => `${a.tool_id}:${a.action}`).filter((key) => !actual.has(key));
    expect(stale).toEqual([]);
  });

  it("hvert revidert verktøys FAKTISKE `preflight_requires_target`-felt matcher det dokumenterte valget", () => {
    for (const audit of AUDITED_CLASS_D_PREFLIGHT_DECISIONS) {
      const def = classDWithPreflight.find((d) => d.tool_id === audit.tool_id && d.action === audit.action);
      expect(def, `${audit.tool_id}:${audit.action} finnes ikke som klasse D + preflight_action`).toBeDefined();
      expect(Boolean(def?.preflight_requires_target), `${audit.tool_id}:${audit.action}`).toBe(audit.requires_target);
    }
  });
});

/** Minimal fake for de generiske A/C-testene - ETT enkelt preflight-svar, ingen tilstand. */
class ScriptedTransport implements ToolTransport {
  calls: string[] = [];
  /** `"absent"` = intet `data`-felt i det hele tatt (som en transport som glemmer det, ikke bare `null`). */
  constructor(private readonly preflightData: JsonValue | null | "absent") {}
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "preflight") {
      if (this.preflightData === "absent") return {};
      return { data: this.preflightData };
    }
    return { external_id: "ext-1" };
  }
}

function genericToolDef(overrides: Partial<ToolDefinition>, transport: ToolTransport): ToolDefinition {
  return {
    tool_id: "generic-q34", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "n/a",
    idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60,
    credential_ref: "Q34_TEST_TOKEN", output_trust: "internal", transport,
    preflight_action: "preflight",
    ...overrides
  };
}

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-q34", device_id: "dev-pc", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-q34-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_q34 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_q34");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_q34", password: "pw2" });
  policy = new PolicyGateway({
    devices: { publicKeyFor: () => undefined },
    nonces: { consume: async () => true },
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: den generiske mekanismen i gateway.ts", () => {
  it("preflight_requires_target=true + preflight lykkes med data:null -> DENY preflight_target_not_found, mutasjon ALDRI kalt", async () => {
    const transport = new ScriptedTransport(null);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    gateway.register(genericToolDef({ preflight_requires_target: true }, transport));

    const result = await gateway.execute({ identity, tool_id: "generic-q34", action: "mutate", parameters: {} });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("preflight_target_not_found");
    expect(transport.calls).toEqual(["preflight"]);
  });

  it("preflight_requires_target=true + preflight lykkes uten data-felt i det hele tatt -> samme DENY", async () => {
    const transport = new ScriptedTransport("absent");
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    gateway.register(genericToolDef({ preflight_requires_target: true }, transport));

    const result = await gateway.execute({ identity, tool_id: "generic-q34", action: "mutate", parameters: {} });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("preflight_target_not_found");
  });

  it("preflight_requires_target=true + preflight lykkes med en DEFINERT (om enn 'tom') verdi -> mutasjonen fortsetter", async () => {
    const transport = new ScriptedTransport({ items: [] }); // f.eks. drive read_permissions sin tomme-men-definerte liste
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    gateway.register(genericToolDef({ preflight_requires_target: true }, transport));

    const result = await gateway.execute({ identity, tool_id: "generic-q34", action: "mutate", parameters: {} });

    expect(result.ok).toBe(true);
    expect(transport.calls).toEqual(["preflight", "mutate", "preflight"]);
  });

  it("preflight_requires_target IKKE satt (default) + preflight lykkes med data:null -> UENDRET (gammel oppførsel bevart, docker.redeploy_container-moteksempelet)", async () => {
    const transport = new ScriptedTransport(null);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    gateway.register(genericToolDef({}, transport)); // flagget utelatt med vilje

    const result = await gateway.execute({ identity, tool_id: "generic-q34", action: "mutate", parameters: {} });

    expect(result.ok).toBe(true);
  });

  it("preflight_requires_target=true på klasse C (ikke D) -> IKKE håndhevet (Q-34 gjelder eksplisitt kun klasse D, se doc-kommentaren i gateway.ts)", async () => {
    const transport = new ScriptedTransport(null);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    gateway.register(genericToolDef({ capability_class: "C", preflight_requires_target: true }, transport));

    const result = await gateway.execute({ identity, tool_id: "generic-q34", action: "mutate", parameters: {} });

    expect(result.ok).toBe(true);
  });
});

describe("C: konkret atferd per domene gjennom den EKTE ToolGateway.execute()-pipelinen", () => {
  class FakeDockerTransport implements ToolTransport {
    calls: string[] = [];
    constructor(private readonly containerExists: boolean) {}
    async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
      this.calls.push(action);
      if (action === "inspect_container") {
        return this.containerExists ? { data: { status: "running" } } : { data: null };
      }
      return { data: { status: action === "stop_container" ? "exited" : action === "start_container" ? "running" : "running" } };
    }
  }

  it("docker.stop_container mot en container som IKKE finnes -> DENY, docker stop/start ALDRI kalt (Q-34 reell lukking - preflight avviser FØR subprosess-kallet)", async () => {
    const transport = new FakeDockerTransport(false);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    for (const tool of firstWaveTools({ docker: transport })) gateway.register(tool);

    const result = await gateway.execute({ identity, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-sentinel-ghost" } });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("preflight_target_not_found");
    expect(transport.calls).toEqual(["inspect_container"]);
  });

  it("docker.start_container mot en container som IKKE finnes -> samme DENY", async () => {
    const transport = new FakeDockerTransport(false);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    for (const tool of firstWaveTools({ docker: transport })) gateway.register(tool);

    const result = await gateway.execute({ identity, tool_id: "docker", action: "start_container", parameters: { name: "jarvis-sentinel-ghost" } });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("preflight_target_not_found");
  });

  it("docker.redeploy_container mot et mål som IKKE finnes ennå -> FORTSATT tillatt (D-105 førstegangs-deploy er ikke berørt av Q-34-lukkingen)", async () => {
    const transport = new FakeDockerTransport(false);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    for (const tool of firstWaveTools({ docker: transport }, { dockerMutationTargets: new Set(["jarvis-sentinel-x"]) })) gateway.register(tool);

    const result = await gateway.execute({
      identity, tool_id: "docker", action: "redeploy_container", parameters: { name: "jarvis-sentinel-x", image: "alpine:3.20" }
    });

    expect(result.ok).toBe(true);
  });

  it("docker.stop_container mot en EKSISTERENDE container -> fortsatt tillatt (positiv kontroll - fikser ikke fail-alltid)", async () => {
    const transport = new FakeDockerTransport(true);
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    for (const tool of firstWaveTools({ docker: transport })) gateway.register(tool);

    const result = await gateway.execute({ identity, tool_id: "docker", action: "stop_container", parameters: { name: "jarvis-sentinel-x" } });

    expect(result.ok).toBe(true);
  });

  it("github.merge_pr - defense-in-depth: OM en fremtidig transport-endring lot get_pull_request svare null i stedet for å kaste, avviser gatewayen FORTSATT (i dag rent hypotetisk - den ekte transporten kaster allerede)", async () => {
    class NullOnNotFoundGithub implements ToolTransport {
      calls: string[] = [];
      async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
        this.calls.push(action);
        if (action === "get_pull_request") return { data: null };
        return { external_id: "1" };
      }
    }
    const transport = new NullOnNotFoundGithub();
    const gateway = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
    for (const tool of firstWaveTools({ github: transport })) gateway.register(tool);

    const result = await gateway.execute({
      identity, tool_id: "github", action: "merge_pr", parameters: { repo: "org/repo", pr_number: "999" }
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("preflight_target_not_found");
    expect(transport.calls).toEqual(["get_pull_request"]);
  });
});
