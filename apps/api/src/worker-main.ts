// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  EnvSecretProvider, FallbackSecretProvider, GithubRateLimitController, GithubTransport, GmailTransport,
  GoogleCalendarTransport, TelegramTransport, MeshToolExecutor, meshToolDefinitions, PgGithubRateLimitStore,
  ToolGateway, driveTransportsIfConfigured, firstWaveTools
} from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "@jarvis/business";
import { SupportService, SupportTransport } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { ConsentEnforcementService, ConsentService, ConsentTransport } from "@jarvis/consent";
import { GoogleAdsTransport, GrowthService, GrowthTransport, marketingMemoryBriefSource } from "@jarvis/growth";
import { executiveHandler } from "./executive.ts";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import {
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner
} from "@jarvis/tasks";
import { KnowledgeSourceRegistry, emailIngestHandler } from "@jarvis/knowledge";
import { LocalHashEmbedding } from "@jarvis/memory";

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
  providers: [
    new OpenAiAdapter(),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    new GemmaHostedAdapter(),
    new LocalOpenAiCompatibleAdapter(),
    new KimiAdapter(),
    new OllamaAdapter()
  ]
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
const toolGateway = new ToolGateway(
  pool, policy,
  new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
  new OwnerControls(killSwitch)
);
const businessService = new BusinessService(pool);
// UA-3 next slice (D-53): samme OpenLoopService-wiring som api - workeren sin
// mesh-tool-executor maa kunne kalle de nye business-handlingene identisk.
const openLoopService = new OpenLoopService(pool);
// UA-3 profiling/scoring-slice (D-61): samme ScoringService-wiring som api -
// workeren sin mesh-tool-executor maa kunne kalle score-handlingene identisk.
const scoringService = new ScoringService(pool);
// UA-3 Native Jarvis Support Core (D-66): samme SupportService-wiring som api -
// workeren sin mesh-tool-executor maa kunne kalle support.*-handlingene identisk.
const supportService = new SupportService(pool);
// UA-3 Native Jarvis Contracts Core (D-71): samme AgreementsService-wiring
// som apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne
// kalle contract.*-handlingene identisk.
const agreementsService = new AgreementsService(pool);
// D-91 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts.
const consentService = new ConsentService(pool);
// D-92 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts -
// konstrueres FØR growthService slik at den kan injiseres valgfritt.
const consentEnforcementService = new ConsentEnforcementService(pool, consentService);
// UA-4 Native Jarvis Growth Core (D-74): samme GrowthService-wiring som
// apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne kalle
// growth.*-handlingene identisk. D-92: consentEnforcementService injisert
// identisk med apps/api/src/main.ts.
const growthService = new GrowthService(pool, consentEnforcementService);
// D-97: identisk wiring-mønster som apps/api/src/main.ts - SAMME pool, altsaa
// SAMME delte github_rate_limit_state-rad paa tvers av api/worker-prosessene.
const githubRateLimitController = new GithubRateLimitController(
  new PgGithubRateLimitStore(pool), "JARVIS_GITHUB_TOKEN",
  (event) => console.warn(`[github-rate-limit] ${event.transition} -> ${event.state}${event.retryAt ? ` retry_at=${event.retryAt.toISOString()} source=${event.source}` : ""}`)
);
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(githubRateLimitController), telegram: new TelegramTransport(),
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans gis til
  // BusinessTransport slik at sync_business_events kan kalle Gmail/Calendar
  // - identisk wiring-mønster som apps/api/src/main.ts.
  // D-90 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts -
  // marketingMemoryBriefSource(growthService) injisert her (app-laget), ikke i
  // @jarvis/business (ville vært sirkulært, se business-os-integration.ts).
  business: new BusinessTransport(
    businessService, openLoopService, pool, toolGateway, scoringService,
    [marketingMemoryBriefSource(growthService)]
  ),
  // Identisk wiring-mønster som apps/api/src/main.ts - lazy SupportEmailService.
  support: new SupportTransport(supportService, businessService, toolGateway),
  contract: new AgreementsTransport(agreementsService),
  growth: new GrowthTransport(growthService),
  // UA-4 Google Ads-slice (D-83): identisk wiring-mønster som apps/api/src/main.ts.
  googleads: new GoogleAdsTransport(growthService),
  // D-91 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts.
  consent: new ConsentTransport(consentService, consentEnforcementService),
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

// UA-2 P1B-A (D-43 §5): e-post-vedlegg-ingestion som en durable jobb - SAMME
// worker/kø-infrastruktur som "executive" over, ingen parallell mekanisme.
// Statisk, env-drevet ÉN-instans-registry (samme "eksplisitt, ingen implisitt
// default"-prinsipp som ua2-p1a-live.ts sin egen registry-bruk) - owner sin
// egen postkasse, personal memory space. gateway (ModelGateway) tilfredsstiller
// VisionCompleter strukturelt (complete()-metoden), ingen ny AI Mesh-vei.
const knowledgeRegistry = new KnowledgeSourceRegistry([
  {
    source_type: "email_attachment",
    tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
    memory_space_id: "personal",
    source_instance_id: "email:inbox",
    account: process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com"
  }
]);
worker.register(
  "knowledge-ingest-email",
  emailIngestHandler({
    pool, toolGateway, embeddings: new LocalHashEmbedding(), visionGateway: gateway, registry: knowledgeRegistry
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
