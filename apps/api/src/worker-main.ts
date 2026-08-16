// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport,
  MeshToolExecutor, meshToolDefinitions, ToolGateway, driveTransportsIfConfigured, firstWaveTools
} from "@jarvis/tool-gateway";
import { executiveHandler } from "./executive.ts";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import {
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner
} from "@jarvis/tasks";

// Q-21 (2026-08-15): fail-closed - en manglende/feilkonfigurert JARVIS_DB_USER, eller
// en superuser/BYPASSRLS-tilkobling, skal ALDRI la workeren starte videre stille.
function failStartup(err: unknown): never {
  console.error(JSON.stringify({ msg: "jarvis-worker startup_failed", error: (err as Error).message }));
  process.exit(1);
}
try {
  assertRuntimeCredentialsConfigured();
} catch (err) {
  failStartup(err);
}
const pool = createPool(configFromEnv());
try {
  await assertRuntimeRoleSafe(pool);
} catch (err) {
  failStartup(err);
}
const queue = new PgTaskQueue(pool);
const worker = new InProcessWorker(queue);

// BO-09 (§22): worker bruker AI Mesh gjennom ModelGateway med purpose -
// aldri provider-API direkte, aldri låst til én provider.
const gateway = new ModelGateway({
  pool,
  trace: traceSinkFromEnv("var/worker-traces.jsonl"),
  providers: [new OpenAiAdapter(), new AnthropicAdapter(), new GeminiAdapter(), new KimiAdapter(), new OllamaAdapter()]
});

// BO-11 (§29): worker-tool-mesh gjennom SAMME trusted Tool Gateway/Policy som api -
// ingen provider/tool-bypass. Kun ufarlige read-verktøy eksponeres (mesh-bridge).
const killSwitch = new KillSwitch();
const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
await deviceRegistry.refresh().catch(() => undefined);
// v4.0 sovereign-owner (BO-11.1 §2-funn): samme authority-wiring som api -
// uten denne kjørte workeren i legacy SCOPED-modus for owners D-kall.
const policy = new PolicyGateway({
  devices: deviceRegistry,
  nonces: new PgApprovalStore(pool),
  killSwitch,
  authority: {
    owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
    owner_tenants: [process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"]
  }
});
const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(), telegram: new TelegramTransport(),
  ...driveTransportsIfConfigured()
})) toolGateway.register(tool);
const workerIdentity = {
  person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
  tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
  memory_space_id: "personal", session_id: "sess-worker", device_id: "jarvis-core",
  channel: "api", auth_strength: "active"
} as const;

// Sandbox-jobber: DockerSandboxRunner på host-runtime (D-32-verifisert). I container
// er prosess-sandbox default (containeren selv er isolasjonsgrensen; ingen Docker-socket
// monteres inn). Velges eksplisitt via JARVIS_SANDBOX=docker|process.
const runner =
  process.env["JARVIS_SANDBOX"] === "docker" ? new DockerSandboxRunner() : new ProcessSandboxRunner();

// BO-11.1 §9: delt executive-handler (samme fil som api-workeren) - identisk
// kontrakt for samme kø: prompt → mesh, tools=true → tool-løkke, command → sandbox.
worker.register(
  "executive",
  executiveHandler({
    gateway,
    tools: { definitions: meshToolDefinitions(), executor: new MeshToolExecutor(toolGateway, workerIdentity) },
    sandbox: runner
  })
);

console.log(JSON.stringify({ msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name }));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
