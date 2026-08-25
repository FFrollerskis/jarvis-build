// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  DockerTransport, EnvSecretProvider, FallbackSecretProvider, GithubRateLimitController, GithubTransport, GmailTransport,
  GoogleCalendarTransport, TelegramTransport, MeshToolExecutor, meshToolDefinitions, PgGithubRateLimitStore,
  ToolGateway, driveTransportsIfConfigured, firstWaveTools, parseDockerMutationTargets
} from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "@jarvis/business";
import { SupportService, SupportTransport } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { FinanceService, FinanceTransport, type FikenCredentials, type FikenCredentialsProvider } from "@jarvis/finance";
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
  ArtifactStore,
  ClaudeCodeAgent,
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner,
  createCodingHandler,
  withSecretRedaction
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
    // D-106: samme lokal-Gemma-registrering som apps/api/src/main.ts - se der for full begrunnelse.
    new LocalOpenAiCompatibleAdapter(
      process.env["JARVIS_GEMMA_LOCAL_URL"],
      process.env["JARVIS_GEMMA_LOCAL_MODEL"] ?? "gemma-local",
      undefined,
      "gemma_local"
    ),
    new KimiAdapter(),
    new OllamaAdapter()
  ]
});

// BO-11 (§29): worker-tool-mesh gjennom SAMME trusted Tool Gateway/Policy som api -
// ingen provider/tool-bypass. Kun ufarlige read-verktøy eksponeres (mesh-bridge).
const killSwitch = new KillSwitch();
// D-104 (UA-5 Production Operations Control Plane v1): SAMME infra-gate-
// wiring-mønster som apps/api/src/main.ts. ÆRLIG begrensning (uendret fra
// den allerede eksisterende `killSwitch`/`OwnerControls`-arkitekturen):
// dette er en EGEN, prosess-lokal `InfraExecutionGate`-instans - en pause
// utløst via api-prosessens `/infra/pause`-HTTP-rute endrer IKKE denne
// workerprosessens egen gate-tilstand (ingen cross-process-synkronisering
// bygget denne sliceen - se D-104 i DECISIONS_AND_ASSUMPTIONS.md).
const infraGate = new InfraExecutionGate();
// D-105: "docker" lagt til (samme rasjonale som apps/api/src/main.ts).
const infraToolIds = new Set(["github", "docker"]);
const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
await deviceRegistry.refresh().catch(() => undefined);
// v4.0 sovereign-owner (BO-11.1 §2-funn): samme authority-wiring som api -
// uten denne kjørte workeren i legacy SCOPED-modus for owners D-kall.
const policy = new PolicyGateway({
  devices: deviceRegistry,
  nonces: new PgApprovalStore(pool),
  killSwitch,
  infraGate,
  infraToolIds,
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
// UA-6 Finance & Spend Integrity Gateway (D-107): identisk wiring-mønster
// som apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne
// kalle finance.*-handlingene identisk.
const financeService = new FinanceService(pool);
const fikenCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    const refreshToken = process.env["JARVIS_FIKEN_REFRESH_TOKEN"];
    const companySlug = process.env["JARVIS_FIKEN_COMPANY_SLUG"];
    if (!refreshToken || !companySlug) return null;
    return { refreshToken, companySlug };
  }
};
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
  // UA-6 Finance & Spend Integrity Gateway (D-107): identisk wiring-mønster som apps/api/src/main.ts.
  finance: new FinanceTransport(financeService, fikenCredentialsProvider),
  // D-91 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts.
  consent: new ConsentTransport(consentService, consentEnforcementService),
  // D-105: samme wiring-mønster som apps/api/src/main.ts.
  docker: new DockerTransport(),
  ...driveTransportsIfConfigured()
}, {
  // D-105 host-fix: samme wiring-mønster som apps/api/src/main.ts.
  dockerMutationTargets: parseDockerMutationTargets(process.env["JARVIS_DOCKER_MUTATION_TARGETS"])
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

// D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
// EKTE `ClaudeCodeAgent` (D-96/D-100/D-101, live-kvalitetsverifisert) - ALDRI
// `ScriptedCodingAgent` (kun test-fixture) i produksjon, ALDRI en ny/parallell
// CLI-adapter eller kodejobb-pipeline. Uten `JARVIS_CLAUDE_BIN` kaster
// `ClaudeCodeAgent.modify()` allerede en typet `claude_code_not_configured`-
// feil FØR noe forsøkes (D-96, uendret her) - kodejobb-kapabiliteten blir da
// strukturelt utilgjengelig PER JOBB, ALDRI en stille fabrikkert fiks (Q-26).
// `EnvSecretProvider` (SAMME sekret-arkitektur som resten av appen - ingen ny
// hemmelighet-lagringsmekanisme) injiserer `ANTHROPIC_API_KEY` KUN i
// sandboxens egen, rene prosess-env (`jobEnv`) - ALDRI arvet fra denne
// worker-prosessen, ALDRI i en prompt/logg/artefakt/audit-post.
// `github: {gateway: toolGateway}` gjenbruker DEN SAMME, allerede D-97-
// throttling-bevisste ToolGateway-instansen (INGEN direkte GitHub-HTTP-vei) -
// PR-publisering skjer derfor KUN naar jobbkontraktens EGEN `allowed_tools`
// eksplisitt lister "github" (D-95, uendret). `identityFor` bruker jobbens
// EGEN `owner_person_id`/`tenant_id` (ALDRI en fast worker-identitet) - dette
// er PÅKREVD for at PolicyGateway sin SOVEREIGN-eiermodus (BO-11.1) skal
// evaluere korrekt for klasse C (push_branch/create_pr): en identitet som
// ikke matcher `authority.owner_person_id` ville falt tilbake til et
// mandat-krav som produksjonen aldri konfigurerer. `withSecretRedaction`
// (D-102, forsvar-i-dybden) fjerner ethvert kjent hemmelig-formet argument
// fra en kastet feilmelding FØR den noensinne når `tasks.last_error` - dekker
// det usannsynlige, men ikke strukturelt umulige tilfellet at Claude Code-
// CLI-en (en ekstern subprosess, utenfor Jarvis sin kontroll) selv ekko'er
// sin egen miljøvariabel i stdout/stderr.
worker.register(
  "coding",
  withSecretRedaction(
    createCodingHandler({
      sandbox: runner,
      agent: new ClaudeCodeAgent(),
      artifacts: new ArtifactStore(pool),
      policy,
      identityFor: (task) => ({
        ...workerIdentity,
        person_id: task.contract.owner_person_id,
        tenant_id: task.tenant_id,
        session_id: "sess-coding"
      }),
      claudeCodeCredential: { secretProvider: new EnvSecretProvider() },
      // D-103 (Blokker B): SAMME EnvSecretProvider-arkitektur, HELT ATSKILT
      // secret-referanse (default "JARVIS_GITHUB_TOKEN") fra claudeCodeCredential
      // over ("ANTHROPIC_API_KEY") - git clone/push får nå eksplisitt,
      // ephemer transport-autentisering i stedet for å avhenge av ambient
      // vertsmaskin-tilstand (Git Credential Manager e.l.). Mangler tokenet:
      // jobben feiler FØR clone forsøkes (`git_auth_unavailable`), ALDRI et
      // stille fall til uautentisert git.
      gitAuth: { secretProvider: new EnvSecretProvider() },
      github: { gateway: toolGateway }
    }),
    [process.env["ANTHROPIC_API_KEY"], process.env["JARVIS_GITHUB_TOKEN"]]
  )
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
