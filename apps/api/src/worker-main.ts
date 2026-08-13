// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import { ModelPurposeSchema } from "@jarvis/contracts";
import {
  EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport,
  MeshToolExecutor, meshToolDefinitions, ToolGateway, firstWaveTools
} from "@jarvis/tool-gateway";
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

const pool = createPool(configFromEnv());
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
const policy = new PolicyGateway({ devices: deviceRegistry, nonces: new PgApprovalStore(pool), killSwitch });
const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(), telegram: new TelegramTransport()
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

// Executive-jobber: eksplisitt kommando → sandbox (D-32-mønsteret);
// prompt → AI Mesh via ModelGateway (purpose fra jobben, default BACKGROUND);
// ellers kvitteres målet (styringsjobb uten sideeffekter).
worker.register("executive", async (task, ctx) => {
  const input = task.contract.input.data as {
    command?: string[];
    timeout_ms?: number;
    prompt?: string;
    purpose?: string;
  };
  if (input.prompt) {
    await ctx.assertNotCancelled();
    const purpose = ModelPurposeSchema.safeParse(input.purpose);
    const meshInput = {
      tenant_id: task.tenant_id,
      task_id: task.task_id,
      purpose: purpose.success ? purpose.data : ("BACKGROUND" as const),
      request: { messages: [{ role: "user" as const, content: input.prompt }], max_tokens: 1024 }
    };
    // BO-11 (§29): tools=true gir modellen mesh-verktøy via trusted executor.
    const result = (input as { tools?: boolean }).tools
      ? await gateway.completeWithTools(meshInput, {
          tools: meshToolDefinitions(),
          executor: new MeshToolExecutor(toolGateway, workerIdentity)
        })
      : await gateway.complete(meshInput);
    return {
      text: result.text.slice(0, 4000),
      provider: result.provider,
      model: result.model,
      tool_rounds: (result.metadata?.["tool_rounds"] as number | undefined) ?? 0,
      tokens: { in: result.usage.input_tokens, out: result.usage.output_tokens }
    };
  }
  if (!input.command || input.command.length === 0) {
    return { echo: task.contract.goal, done_at: new Date().toISOString() };
  }
  const sb = await runner.create();
  try {
    await ctx.assertNotCancelled();
    const res = sb.exec(input.command[0] as string, input.command.slice(1), input.timeout_ms ?? 60_000);
    if (res.code !== 0) {
      throw new Error(`sandbox_exit_${res.code}: ${res.stderr.slice(0, 200)}`);
    }
    return { stdout: res.stdout.slice(0, 4000), code: res.code, sandbox: runner.name };
  } finally {
    await sb.dispose();
  }
});

console.log(JSON.stringify({ msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name }));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
