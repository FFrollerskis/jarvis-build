// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  ContextBuilder,
  DeviceService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionService,
  configFromEnv,
  createPool,
  runMigrations
} from "@jarvis/core";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { JsonlTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { AnthropicAdapter, OllamaAdapter, OpenAiAdapter, ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { LocalHashEmbedding, MemoryRetriever } from "@jarvis/memory";
import { DailyBrief, buildStatusSource, tasksSource } from "@jarvis/tool-gateway";
import { ConversationEngine } from "./conversation.ts";
import { createApiServer, type ApiDeps } from "./server.ts";

const port = Number(process.env["JARVIS_API_PORT"] ?? 3010);

async function buildDeps(): Promise<ApiDeps | undefined> {
  if (!process.env["JARVIS_DB_PASSWORD"] && !process.env["JARVIS_DB_HOST"]) {
    console.log(JSON.stringify({ msg: "ingen databasekonfig - starter i helse-modus" }));
    return undefined;
  }
  const pool = createPool(configFromEnv());
  // Migrasjoner kjøres av admin-bruker i drift; her antas app-bruker å ha skjema fra før.
  if (process.env["JARVIS_DB_RUN_MIGRATIONS"] === "true") {
    await runMigrations(pool);
  }
  const trace = new JsonlTraceSink(process.env["JARVIS_TRACE_FILE"] ?? "var/traces.jsonl");
  const killSwitch = new KillSwitch();
  // Enhetsregister fra databasen (fase 8): godkjenninger verifiseres mot registrerte enhetsnøkler.
  const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
  await deviceRegistry.refresh().catch(() => undefined);
  setInterval(() => void deviceRegistry.refresh().catch(() => undefined), 30_000).unref();
  const policy = new PolicyGateway({
    devices: deviceRegistry,
    nonces: new PgApprovalStore(pool),
    killSwitch
  });
  const queue = new PgTaskQueue(pool);
  const worker = new InProcessWorker(queue);
  worker.register("executive", async (task) => ({ echo: task.contract.goal, done_at: new Date().toISOString() }));
  const gateway = new ModelGateway({
    pool,
    trace,
    providers: [new AnthropicAdapter(), new OpenAiAdapter(), new OllamaAdapter(), new ScriptedAdapter()],
    budget: {
      warn_ore: 100_000,
      approval_ore: 200_000,
      hard_limit_ore: 300_000,
      spend_approved: process.env["JARVIS_BUDGET_APPROVED"] === "true"
    }
  });
  const deps: ApiDeps = {
    identity: new IdentityService(pool),
    devices: new DeviceService(pool),
    brief: {
      generate: (identity) =>
        new DailyBrief([tasksSource(pool), buildStatusSource(null)], pool).generate(identity as never),
      render: (artifact) => DailyBrief.render(artifact as never)
    },
    sessions: new SessionService(pool),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(pool),
      context: new ContextBuilder(pool),
      gateway,
      tasks: new TaskService(pool, queue, policy),
      worker,
      trace,
      memory: new MemoryRetriever(pool, new LocalHashEmbedding())
    })
  };
  setInterval(() => void worker.drain().catch(() => undefined), 2_000).unref();
  return deps;
}

const deps = await buildDeps();
const server = createApiServer(deps);
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port, db: Boolean(deps) }));
});
