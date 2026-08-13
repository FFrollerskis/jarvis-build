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
import {
  DailyBrief, EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport,
  TelegramCommandPoller, TelegramTransport, ToolGateway, buildStatusSource, calendarSource,
  emailSource, firstWaveTools, tasksSource
} from "@jarvis/tool-gateway";
import { OwnerControls } from "@jarvis/policy";
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
      generate: (identity) => dailyBrief.generate(identity as never),
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

  // BO-03: Tool Gateway m/live transporter (aktiveres av credentials i .env),
  // Daily Brief-kilder, morgenlevering og Telegram-kommandoer.
  const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
  for (const tool of firstWaveTools({
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(), telegram: new TelegramTransport()
  })) toolGateway.register(tool);
  const dailyBrief = new DailyBrief([
    tasksSource(pool), buildStatusSource(toolGateway),
    emailSource(toolGateway), calendarSource(toolGateway)
  ], pool);
  const ownerIdentity = {
    person_id: "person-tobias", tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
    memory_space_id: "personal", session_id: "sess-brief", device_id: "jarvis-core",
    channel: "api", auth_strength: "active"
  } as const;
  const sendTelegram = async (text: string) => {
    for (let i = 0; i < text.length; i += 3900) {
      await toolGateway.execute({ identity: ownerIdentity as never, tool_id: "telegram", action: "notify",
        parameters: { message: text.slice(i, i + 3900) } });
    }
  };
  const statusText = async () => {
    const gates = [...toolGateway.health.entries()].map(([k, v]) => `${k}:${v.state}`).join(" ");
    return `JARVIS STATUS
fase: v4.0 BO-03
connectors: ${gates || "ingen kall enda"}
porter: se docs/RUNTIME_GATES.md
neste: runtime-porter (Docker/credentials)`;
  };
  if (process.env["JARVIS_TELEGRAM_TOKEN"] && process.env["JARVIS_TELEGRAM_CHAT_ID"]) {
    new TelegramCommandPoller(process.env["JARVIS_TELEGRAM_TOKEN"], process.env["JARVIS_TELEGRAM_CHAT_ID"], {
      brief: async () => DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)),
      status: statusText
    }, sendTelegram).start();
    // Morgenlevering: konfigurerbar time (default 07); sjekk hvert minutt, lever én gang per dag.
    let lastDelivered = "";
    const hour = Number(process.env["JARVIS_BRIEF_HOUR"] ?? 7);
    setInterval(() => void (async () => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getHours() === hour && lastDelivered !== day) {
        lastDelivered = day;
        await sendTelegram(DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)));
      }
    })().catch(() => undefined), 60_000).unref();
  }
  return deps;
}

const deps = await buildDeps();
const server = createApiServer(deps);
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port, db: Boolean(deps) }));
});
