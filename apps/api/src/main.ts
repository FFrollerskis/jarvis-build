// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import "./normalize-env.ts";
import { executiveQueueOwner } from "./queue-owner.ts";
import { parseDailyCapOre, parseToolTurnRoute, resolveJobToolTurnRoute } from "./tool-turn-route.ts";
import { parseChatCandidates, unknownChainMembers } from "./chat-candidates.ts";
import { parseCouncilProposals } from "./council-proposals.ts";
import { fileURLToPath } from "node:url";
import { lookup as dnsLookup } from "node:dns/promises";
import { checkEv0Boot, getLastEv0BootStatus, logEv0Boot } from "./ev0-boot.ts";
import { assertNoSweepFailures, envHour, envInt, envPort, failOnSweepFailures, systemIdentity } from "@jarvis/contracts";
import { ownerConfigOrExit, ownerTenantsOrExit } from "./owner.ts";
import { buildSelfModelReaders } from "./self-model-readers.ts";
import { backupStatusSourceFromEnv } from "./backup-status.ts";
import { startUptimeHeartbeat } from "./heartbeat-sender.ts";
import {
  ChannelSessionAuthority,
  ContextBuilder,
  DeviceEnrollmentService,
  DeviceService,
  SessionGrantService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionService,
  TelegramOwnerAuthority,
  VoiceSessionAuthority,
  assertRuntimeCredentialsConfigured,
  assertRuntimeRoleSafe,
  configFromEnv,
  createPolicyAuditSinkFromEnv,
  createPool,
  ConfirmationStore,
  installPolicyAuditDrain,
  policyAuditSinkConfigFromEnv,
  runMigrationsAsAdmin,
  runOperationalRetentionSweep,
  runPolicyDecisionRetentionSweep,
  withTenantTransaction,
  writeAudit
} from "@jarvis/core";
import { InfraExecutionGate, KillSwitch, PolicyGateway, createPgInfraModeStore, type AuthorityConfig } from "@jarvis/policy";
import { DeploymentService, DiagnosisService, INCIDENT_PRODUCER_NAMES, IncidentService } from "@jarvis/incidents";
import { ClaimVerificationService, KnowledgeRetriever, createKnowledgeClaimsPort } from "@jarvis/knowledge";
import {
  AiCouncil,
  CapabilityRegistry,
  ClaudeBudgetEnforcer,
  CouncilAutoTriggerLimiter,
  DEFAULT_PROFILES,
  PROFILES_WITH_LOCAL_VISION,
  assertProvidersHaveExplicitPricing,
  claudeBudgetConfigFromEnv,
  pricingFromEnv,
  ModelGateway,
  InteractivePriorityGate,
  budgetConfigFromEnv,
  dailySpentOre,
  traceSinkFromEnv
} from "@jarvis/model-gateway";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  HermesAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService, allowedReposFromEnv } from "@jarvis/tasks";
import {
  LlmExtractionAdapter,
  createEmbeddingProviderFromEnv,
  runMemoryProfileSweepForAllTenants,
  runMemoryReembedSweepForAllTenants,
  runMemoryResensitizeSweepForAllTenants,
  resensitizeModeFromEnv,
  type ResensitizeSweepSummary,
  MemoryRetriever,
  MemoryWriter,
  SummaryService,
  runMemoryRetentionSweepForAllTenants
} from "@jarvis/memory";
import {
  DailyBrief, DockerTransport, EnvSecretProvider, FallbackSecretProvider, GceTransport, McpZapierTransport, BrowserGatewayTransport, GithubTransport, createGitHubAuth,
  CHAT_ACT_TIER, CHAT_READ_TIER, GmailTransport, GoogleCalendarTransport, InfisicalSecretProvider, MemorySearchTransport, CouncilProposalGate, MeshToolExecutor, assertManifestInvariants, buildToolManifest, describeSurfaceCatalog, memoryToolDefinitions, selectSurfaceTools,
  KnowledgeSearchTransport, knowledgeToolDefinitions,
  MODEL_SURFACE_ALLOWLIST, MODEL_SURFACE_QUARANTINE_WRITES, resolveModelToolSurface, PgGithubRateLimitStore,
  PgTelegramOffsetStore, TelegramCommandPoller, createTurnContext, jobIdentityFor, telegramClassDNotifier, TelegramTransport, SlackTransport, DiscordTransport, TwilioTransport, BraveSearchTransport, SentryTransport, GoogleMapsTransport, GoogleSheetsTransport, TavilyTransport, ExaTransport, GooglePlacesTransport, GoogleRoutesTransport, GrafanaTransport, PrometheusTransport, DropboxTransport, NotionTransport, OneDriveTransport, MicrosoftOutlookTransport, N8nTransport, SpotifyTransport, WhatsAppTransport, MakeTransport, OpenAIImagesTransport, TelnyxTransport, RunwayTransport, KlingTransport, GoogleVeoTransport, HiggsfieldTransport, TodoistTransport, TrelloTransport, JiraTransport, LinearTransport, HubSpotTransport, PipedriveTransport, ToolGateway, VercelTransport, HomeAssistantTransport, MicrosoftGraphAuth, homeAssistantTools, buildStatusSource, calendarSource, driveTransportsIfConfigured,
  emailSource, firstWaveTools, parseDockerMutationTargets, parseGceMutationTargets, tasksSource, schedulerSource, DailyScheduler, runConnectorHealthSweep,
  CONNECTOR_REGISTRY, FORBIDDEN_MODEL_TOOL_IDS, listConnectorStatus,
  CloudflareTransport, INFRA_GATED_TOOL_IDS, cloudControlToolDefinitions, parseCloudflareMutationZones,
  InfisicalTransport, LangfuseTransport, PostgresOpsTransport, parseInfisicalRotationIds, parsePostgresOpsConfig,
  configureGoogleOAuthClientSource, createVaultFirstConfigReader, primeGoogleDriveCredentialCheck
} from "@jarvis/tool-gateway";
import {
  BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessEventSyncService, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ProductUsageService,
  ScoringService, isWeeklyBriefDay, parseSupportSlaHours, runBusinessEventSyncForAllTenants, runBusinessWeeklyBriefForAllTenants,
  runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants
} from "@jarvis/business";
import { SupportEmailService, SupportService, SupportTransport, runSupportInboxSyncForAllTenants } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { ProductService, ProductTransport } from "@jarvis/product";
import { OperationsService, OperationsTransport } from "@jarvis/operations";
import { LocationService, runLocationRetentionSweepForAllTenants } from "@jarvis/location";
import { HealthService, runHealthRetentionSweepForAllTenants } from "@jarvis/health";
import { VisionService, runVisionRetentionSweepForAllTenants } from "@jarvis/vision";
import { buildVisionRuntime, verifyVisionEndpoints, visionAdapterFromEnv } from "./vision-runtime.ts";
import {
  DomainPauseRegistry, SituationEngine, SituationsTransport, assertSituationSweepHealthy, runSituationSweepForAllTenants,
  situationsToolDefinitions
} from "@jarvis/situations";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions, parseFollowUpPushPolicy, renderSelfDiagnosisNo, type SelfDiagnosis } from "@jarvis/executive";
import { GovernanceService, GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import {
  FinanceService, FinanceTransport, SpendService, SpendTransport, StripeFinanceTransport, VippsFinanceTransport,
  BankingService, NeonomicsFinanceTransport, runNeonomicsSweepForAllTenants,
  CardService, WallesterFinanceTransport, runWallesterSweepForAllTenants, createRsaJwtSigner,
  type WallesterCredentials, type WallesterCredentialsProvider,
  type NeonomicsCredentials, type NeonomicsCredentialsProvider,
  runFinanceSpendIntegritySweepForAllTenants, runStripePaymentSyncForAllTenants, runVippsPaymentSyncForAllTenants,
  FinanceReconciliationService, createFikenPostingReader, runFinanceReconciliationForAllTenants,
  type FikenCredentials, type FikenCredentialsProvider, type StripeCredentials, type StripeCredentialsProvider,
  type VippsCredentials, type VippsCredentialsProvider
} from "@jarvis/finance";
import { ConsentEnforcementService, ConsentService, ConsentTransport } from "@jarvis/consent";
import {
  ExperimentRegistryService, GoogleAdsTransport, GrowthExperimentTransport, GrowthService, GrowthTransport, GrowthWriteJournal, MetaAdsTransport,
  createGrowthWriteTransports, growthExperimentToolDefinitions, growthOpIndex, growthWriteConfigFromEnv, growthWriteSpecs, growthWriteToolDefinitions,
  marketingMemoryBriefSource, runActionRecommendationSweepForAllTenants
} from "@jarvis/growth";
import { OwnerControls } from "@jarvis/policy";
import {
  ConversationGraphService, ConversationGraphSyncService, ConversationGraphTransport,
  runConversationGraphSyncForAllTenants
} from "@jarvis/conversation-graph";
import { ConversationEngine } from "./conversation.ts";
import { loadPersonalityConfig } from "./personality-config.ts";
import { executiveHandler } from "./executive.ts";
import { buildSloReaders, createSloReportProvider } from "./slo-source.ts";
import { parseIncidentProducerConfig, startApiIncidentProducers } from "./incident-producers.ts";
import { createInfraStatusSource } from "./infra-status-source.ts";
import { createRadarState, radarSweepFailures } from "./evolution-radar.ts";
import { createEvolutionReadinessProvider, createEvolutionReportProvider, type EvolutionSourceDeps } from "./evolution-source.ts";
import { createEvolutionDecisionRecorder } from "./evolution-decisions.ts";
import { createAiMeshReportProvider } from "./ai-mesh-source.ts";
import { parseKnowledgeClaimWrites } from "./knowledge-flags.ts";
import { createPushSendGuard, startFollowUpPush } from "./follow-up-push.ts";
import { buildValueRuntimeFacts } from "./value-facts.ts";
import { createValueMeasurementSource } from "./value-source.ts";
import { ChatJobs, MAX_ACTIVE_JOBS, TasksDelegateTransport, tasksDelegateToolDefinitions } from "./chat-jobs.ts";
import { RunRateService, RunRateTransport, runRateToolDefinitions } from "./run-rate.ts";
import { createControlCenterRegistry, ownerPredicate, registerControlCenters } from "./control-center/register.ts";
import { CONTROL_FEATURE_FLAGS, controlCentersWithTools, flagOn } from "./control-center/shared.ts";
import { createAutonomyAudit } from "./autonomy-audit.ts";
import { createGoldenSuiteRunner } from "./golden-suite-runner.ts";
import { servedByCloudModel } from "./cloud-tool-screen.ts";
import { createProviderPauseSourceFromPool } from "./provider-pause.ts";
import { claudeBudgetBriefSource } from "./claude-budget-surfaces.ts";
import { createOwnerControlsService } from "./provider-pause.ts";
import { createApiServer, makeReadiness, type ApiDeps } from "./server.ts";

const port = envPort("JARVIS_API_PORT", 3010);

async function buildDeps(): Promise<ApiDeps | undefined> {
  if (!process.env["JARVIS_DB_PASSWORD"] && !process.env["JARVIS_DB_HOST"]) {
    console.log(JSON.stringify({ msg: "ingen databasekonfig - starter i helse-modus" }));
    return undefined;
  }
  // Q-21 (2026-08-15): fail-closed FØR tilkobling forsøkes - en manglende/feilkonfigurert
  // JARVIS_DB_USER skal ALDRI stille falle tilbake til admin-tilkoblingen (root cause for
  // host-blockeren var nettopp dette - api kjørte som Postgres-superbruker).
  assertRuntimeCredentialsConfigured();
  // Remediering del 2 (JARVIS-065): ÉN validert eier-identitet for hele prosessen (fail closed uten).
  const owner = ownerConfigOrExit();
  // WP-D2 (Q-44/Q-48 C): standard `[JARVIS_TENANT_ID]`; `JARVIS_OWNER_EXTRA_TENANTS` er en dormant, eier-satt utvidelse (kun eierens person-id; aldri `system`/delegat/andre personer - men planlagte jobber som kjører som eieren, f.eks. brief og situasjonssveip, er suverene der som i primær-tenanten, PR #326 F1).
  const ownerTenants = ownerTenantsOrExit(owner);
  // WP-E1 (UA-5, JARVIS-068): incident-produsentene (AV som standard) - parses tidlig, fordi driftsstatus-verktøyet (`executive.get_infra_status`) og produsent-løkka begge leser den.
  const incidentProducerConfig = parseIncidentProducerConfig(process.env);
  process.env["JARVIS_PROCESS"] ??= "api"; // D-394 (JARVIS-054): audit-rader merkes med hvilken prosess som skrev dem
  const pool = createPool(configFromEnv());
  // Migrasjoner kjøres av admin-bruker i drift (compose: `migrate`-tjenesten); her antas app-bruker å ha skjema fra før.
  // D-395 (JARVIS-075): flagget kjører migratoren med ADMIN-konfig i en egen, kortlivet pool - aldri med runtime-rollen (Q-21) - og feiler
  // lukket uten JARVIS_DB_ADMIN_PASSWORD.
  if (process.env["JARVIS_DB_RUN_MIGRATIONS"] === "true") {
    await runMigrationsAsAdmin();
  }
  // Q-21: appen skal ALDRI starte normalt med en superuser/BYPASSRLS-tilkobling - RLS
  // er strukturelt umulig å håndheve for en slik rolle, uansett hvor korrekte policyene er.
  await assertRuntimeRoleSafe(pool);
  // BO-09: Langfuse-sink når konfigurert (D-27), ellers JSONL - samme mesh-observability overalt.
  const trace = traceSinkFromEnv(process.env["JARVIS_TRACE_FILE"] ?? "var/traces.jsonl");
  // K1 (Sovereign graduation, D-164): FØR denne sliceen var `killSwitch`/
  // `ownerControls` rene in-memory-objekter, SEPARAT konstruert i api- OG
  // worker-prosessen - en pause satt i den ene var usynlig for den andre,
  // og en omstart glemte stille en aktiv pause (fail-OPEN). Nå gitt SAMME
  // `pool`+`authority` som resten av eier-autoritets-mønstrene i denne
  // filen (`situationDomainPauses` under) - `restore()` kalles rett under,
  // FØR noe kan bruke dem, og `PolicyGateway.authorize()`/
  // `ToolGateway.execute()` bruker ALLTID de LIVE `*Durable()`-sjekkene
  // (aldri de rene synkrone), se `KillSwitch`/`OwnerControls` sine filhoder.
  const ownerControlAuthority = { owner_person_id: owner.owner_person_id };
  const killSwitch = new KillSwitch(pool, ownerControlAuthority);
  await killSwitch.restore();
  const ownerControls = new OwnerControls(killSwitch, pool, ownerControlAuthority);
  // EV-1 (D-412): leserne selvdiagnosen (`executive.get_self_diagnosis`) komponeres av. `toolGateway` refereres først når en leser kalles (lat).
  const selfModelControls = createOwnerControlsService(killSwitch, ownerControls);
  // WP-C2: backup-status fra en skrivebeskyttet statusfil (JARVIS_BACKUP_STATUS_FILE); uten den er `backup` UKJENT i selvdiagnosen.
  const backupStatusSource = backupStatusSourceFromEnv();
  const selfModelReaders = buildSelfModelReaders({
    pool,
    tenantId: owner.tenant_id,
    meshStatus: () => gateway.meshStatus(),
    controlState: () => selfModelControls.getControlState(),
    connectorStatus: () => listConnectorStatus(toolGateway),
    // EV-0 oppstartsresultat (konstitusjon + endringsregister); null til sjekken har kjørt -> UKJENT.
    ev0Status: () => getLastEv0BootStatus(),
    build: () => ({ sha: process.env["JARVIS_BUILD_SHA"]?.trim() || null, version: process.env["JARVIS_VERSION"]?.trim() || "0.1.0" }),
    backupStatus: backupStatusSource
  });
  await ownerControls.restore();
  // EV-2 (D-417): SLO/drift/dataskvalitet fra eksisterende observerbarhet (cost_events, tool_executions, tasks, memory_items) - ingen parallell telemetri.
  const sloReports = createSloReportProvider(pool, owner.tenant_id);
  Object.assign(selfModelReaders, buildSloReaders(sloReports));
  // WP-B (D-452): evolusjonsportene (EV-0…EV-23) i OBSERVASJONSMODUS - kun lesing av eksisterende observerbarhet, `acts: false`. Selvendring er fortsatt frosset (D-397).
  // EV-3: radaren er INERT uten `JARVIS_RADAR_SOURCES` (ingen nettverkskall). Kildene velges av eieren; innholdet går gjennom sikkerhetssonen og forlater den aldri (kun status vises).
  const evolutionRadar = createRadarState(process.env);
  // EV-10: siste nattlige omregning av lagret sensitivitet (D-451) holdes i minnet så rapporten kan vise tallet uten å skanne på nytt.
  let lastResensitize: ResensitizeSweepSummary | null = null;
  const rememberResensitize = (summary: ResensitizeSweepSummary): ResensitizeSweepSummary => {
    lastResensitize = summary;
    return summary;
  };
  // WP-B3 (D-475): kildene er trukket ut til ÉN verdi (uendret innhold) så Evolusjon-senteret kan lese den samme rapporten og de samme beredskapsfaktaene (`createEvolutionReadinessProvider`) uten en parallell kobling.
  const evolutionSourceDeps: EvolutionSourceDeps = {
    radar: evolutionRadar,
    resensitize: () => lastResensitize,
    pool,
    tenantId: owner.tenant_id,
    ev0Status: () => getLastEv0BootStatus(),
    slo: sloReports,
    connectors: () => listConnectorStatus(toolGateway),
    killSwitchActive: async () => (await selfModelControls.getControlState()).kill_switch.active,
    mesh: () => gateway.meshStatus(),
    toolSurface: () => modelToolSurface
  };
  const evolutionReports = createEvolutionReportProvider(evolutionSourceDeps);
  const evolutionReadiness = createEvolutionReadinessProvider(evolutionSourceDeps);
  // WP-D4 (JARVIS-033/036/078): AI Mesh-status (`executive.get_ai_mesh_status`) - leverandørhelse i prosessen + cost_events siste 7 døgn. Kun lesing; gjør aldri et modellkall.
  const aiMeshReports = createAiMeshReportProvider({
    pool,
    tenantId: owner.tenant_id,
    details: () => gateway.meshDetails(),
    mesh: () => gateway.meshStatus(),
    chain: () => ({ candidates: [...chatCandidates.chain], auto_fallback: chatCandidates.autoFallback })
  });
  // WP-C4 (UA0-RUNRATE): Value Center - bruk per verdiløkke fra eksisterende tabeller (kun aggregater/tidsstempler, lesing som app-rolle under RLS). Den daglige løperens helse (global tabell) vises kun for eierens tenant.
  const valueSource = createValueMeasurementSource(pool, { schedulerTenantId: owner.tenant_id });
  // WP-C4 V2: planlagt oppfølgingsvarsel. AV som standard (kun `JARVIS_V2_PUSH_ENABLED=true` slår på); kanalen (Telegram) avgjøres lenger ned når token/chat er lest.
  const v2PushPolicy = parseFollowUpPushPolicy(process.env);
  let telegramDeliveryConfigured = false;
  // D-174 (B2): hoistet hit (tidligere konstruert lenger nede, kun for
  // `enrollmentService`) - `OwnerControlsService` sitt nye, eier-vendte
  // `revoke_device` (se under, `additionalTools`) trenger DENNE SAMME
  // instansen, SAMME `pool`/`ownerControlAuthority` som resten av eier-
  // autoritets-mønstrene over. `SessionGrantService` er en ren, tilstandsløs
  // `pool`-innpakning ved konstruksjon (ingen side-effekt å flytte tidligere) -
  // ÉN delt instans, ALDRI en duplikat parallell konstruksjon.
  const grantService = new SessionGrantService(pool);
  // D-104 (UA-5 Production Operations Control Plane v1): global infra-eksekusjonsmodus - EN NY, SNEVRERE bryter enn `killSwitch` over (som forblir
  // strengest/uendret). Gjelder KUN registrerte infra-tool_id-er (`infraToolIds` under). D-438 (JARVIS-025): modusen er DELT med worker-prosessen via
  // `owner_control_state` og leses LIVE av `PolicyGateway` (ingen cache/timer); varige overganger krever eier-autoritet (`ownerControlAuthority`).
  const infraGate = new InfraExecutionGate(undefined, createPgInfraModeStore(pool), ownerControlAuthority);
  // WP-E1: SAMME ene sannhet som worker-main.ts (`INFRA_GATED_TOOL_IDS`): github/docker/gce/vercel + de kontrollerte skymålene (cloudflare/langfuse/infisical/postgres_ops).
  const infraToolIds = new Set(INFRA_GATED_TOOL_IDS);
  // WP-E1: Postgres-drift (diagnostikk + terminate/cancel/VACUUM) mot Jarvis' EGEN database. Listene er eier-konfigurert vertskonfig (kun `.env` + restart): tom `databases` = ingen
  // klasse D-skriving; selve tilkoblingen (`JARVIS_POSTGRES_OPS_URL`, en dedikert minste-privilegium-rolle) er en credential og gjør hele connectoren sovende når den mangler.
  const postgresOpsConfig = parsePostgresOpsConfig({
    databases: process.env["JARVIS_POSTGRES_OPS_DATABASES"], schemas: process.env["JARVIS_POSTGRES_OPS_SCHEMAS"], protectedRoles: process.env["JARVIS_POSTGRES_OPS_PROTECTED_ROLES"]
  });
  // Enhetsregister fra databasen (fase 8): godkjenninger verifiseres mot registrerte enhetsnøkler.
  const deviceRegistry = new PgDeviceRegistry(pool, owner.tenant_id);
  // D-222: tidligere `.catch(() => undefined)` på begge steder - en vedvarende
  // refresh-feil (DB nede, skjemadrift) ville latt policy-autorisasjon kjøre
  // mot et stille voksende UTDATERT enhetsregister på ubestemt tid, uten NOEN
  // logglinje. Samme "siste sikkerhetsnett"-mønster som D-218/D-221/D-222 over.
  await deviceRegistry.refresh().catch((err) => {
    console.error(JSON.stringify({
      msg: "device_registry_initial_refresh_failed",
      error: err instanceof Error ? err.message : String(err)
    }));
  });
  setInterval(() => void deviceRegistry.refresh().catch((err) => {
    console.error(JSON.stringify({
      msg: "device_registry_refresh_tick_failed",
      error: err instanceof Error ? err.message : String(err)
    }));
  }), 30_000).unref();
  // Gjennomgang av PR #316 (M-2): ÉN eier-autoritetskonfigurasjon, delt av Policy Gateway og kontrollsentrene (eier-porten og Authority Center), så de aldri kan være uenige om hvem eieren er.
  const ownerAuthority: AuthorityConfig = { owner_person_id: owner.owner_person_id, owner_tenants: ownerTenants };
  // WP-K (D-471, JARVIS-053): varig policy-journal (AV som standard; `JARVIS_POLICY_AUDIT_SINK=db` skriver hver avgjørelse til `policy_decisions`). En sink-feil kan aldri endre en avgjørelse (telt og vist i
  // Autoritet-senteret); uten flagget er `policyAuditSink` null og PolicyGateway bruker ringbufferen som før (byte-identisk oppførsel).
  const policyAuditSink = createPolicyAuditSinkFromEnv(pool);
  if (policyAuditSink) installPolicyAuditDrain(policyAuditSink);
  const policy = new PolicyGateway({
    devices: deviceRegistry,
    nonces: new PgApprovalStore(pool),
    killSwitch,
    // K1 (D-164): tidligere ALDRI satt her (dødt felt) - `ToolGateway.execute()`
    // hadde sin EGEN, separate frys-/tilbakekalls-sjekk, men enhver kaller
    // som gikk RETT til `policy.authorize()` (f.eks. `/infra/pause`) omgikk
    // den helt. Nå håndhevet på BEGGE veier, samme `ownerControls`-instans.
    controls: ownerControls,
    infraGate,
    infraToolIds,
    // v4.0 sovereign-owner (BO-11.1 §2-funn): uten denne kjørte runtime i legacy
    // SCOPED-modus og krevde approval for owners D-kall. A-D er risikoklasser -
    // for owner gir SOVEREIGN autonom utførelse; sikkerheten ligger i D-pipelinen
    // (preflight/readback/evidens/recovery) + owner-kontrollene, ikke approval.
    authority: ownerAuthority,
    ...(policyAuditSink ? { auditSink: policyAuditSink.write } : {})
  });
  const queue = new PgTaskQueue(pool);
  const worker = new InProcessWorker(queue);
  // WP-B4 (D-476): Claude-kreditten (100 USD/mnd, tempostyring og behovsprioritering). AV som standard (`JARVIS_CLAUDE_BUDGET_USD` tom/usatt = ingen enforcer, gatewayen er identisk med main). En ugyldig
  // JARVIS_CLAUDE_BUDGET_* KASTER her og stopper oppstarten (buildDeps().catch → exit 1) - aldri en stille standard. Samme parsing og samme enforcer-type i worker-main.ts.
  const claudeBudgetConfig = claudeBudgetConfigFromEnv(process.env);
  const claudeBudget = claudeBudgetConfig === null ? undefined : new ClaudeBudgetEnforcer({ config: claudeBudgetConfig, pool, trace, actor_person_id: owner.owner_person_id, owner_tenant_id: owner.tenant_id });
  // WP-G3 (D-465): `local_vision` (lokal bildeklassifisering av kamerabilder) registreres KUN når JARVIS_VISION_ENABLED=on og JARVIS_VISION_CLASSIFIER=on - ellers `null` (ingenting registreres, identisk med main).
  // En ikke-lokal/manglende JARVIS_VISION_LOCAL_URL KASTER her og stopper oppstarten (kamerabilder forlater aldri maskinen).
  // Review A-L5/A-INFO-4: vertsnavnene i endepunktene løses ved oppstart og må peke til det lokale nettet (offentlig oppløsning KASTER); embedding-endepunktet som ikke er lokalt gir kun «ingen vision-embedding».
  const visionEndpoints = await verifyVisionEndpoints(process.env, { lookup: (host) => dnsLookup(host, { all: true, verbatim: true }) });
  const visionAdapter = visionAdapterFromEnv(process.env);
  const gateway = new ModelGateway({
    pool,
    trace,
    // D-414 («chat først»): bakgrunnsformål (minneuttrekk/sammendrag) venter mens en chat pågår, så chatten ikke står i kø bak dem på den lokale modellen.
    // JARVIS_BACKGROUND_YIELD_MAX_MS=0 slår det av.
    priorityGate: new InteractivePriorityGate({
      maxWaitMs: envInt("JARVIS_BACKGROUND_YIELD_MAX_MS", 90_000, { min: 0, max: 600_000 }),
      quietMs: envInt("JARVIS_BACKGROUND_YIELD_QUIET_MS", 4_000, { min: 0, max: 60_000 })
    }),
    // D-399: eier-bekreftede modellpriser (JARVIS_MODEL_PRICING) flettes over standardtabellen - nødvendig for at dyrere modeller skal være valgbare per kall.
    pricing: pricingFromEnv(),
    providers: [
      // D-79 (AI Mesh Gemma-first): gemma_hosted/local_llm registreres alltid,
      // som alle andre adaptere - `.available()` (nøkkel/URL satt) avgjør om de
      // faktisk deltar i ruting, IKKE et eget feature-flag her (§23: samme
      // konvensjon som alle øvrige providere - ingen ny mekanisme).
      new OpenAiAdapter(),
      new AnthropicAdapter(),
      new GeminiAdapter(),
      new GemmaHostedAdapter(),
      new LocalOpenAiCompatibleAdapter(),
      // D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): SAMME
      // `LocalOpenAiCompatibleAdapter`-klasse som `local_llm` over, registrert
      // EN GANG TIL under en distinkt provider-identitet (`gemma_local`) for
      // Gemma kjørt lokalt (Tobias sin RTX 4070-PC, eller en annen dedikert
      // vertsmaskin via et OpenAI-kompatibelt endepunkt) - `.available()`
      // (URL satt) avgjør deltakelse, samme konvensjon som alle andre
      // providere. Se `capability-registry.ts` sin `gemma_local`-profil.
      new LocalOpenAiCompatibleAdapter(
        process.env["JARVIS_GEMMA_LOCAL_URL"],
        // D-340: samme tom-streng-.env-bug som resten av provider-adapters -
        // denne ENE oppringingen satte modellen RÅTT (bypasset adapterens
        // egen `envOrDefault()`-fiksede default), `||` retter opp samme sted.
        process.env["JARVIS_GEMMA_LOCAL_MODEL"] || "gemma-local",
        undefined,
        "gemma_local"
      ),
      new KimiAdapter(),
      new HermesAdapter(),
      new OllamaAdapter(),
      ...(visionAdapter !== null ? [visionAdapter] : [])
      // D-106 HOST-FIX (produksjonsherding, Defekt E): `ScriptedAdapter` er ALDRI
      // registrert her lenger - live host-kjøring viste at den, som en ordinær
      // "local"-profilert provider, kunne bli et LEGITIMT AUTO-rutingvalg under
      // `paid_models_allowed=false` når INGEN ekte lokal provider var frisk/
      // konfigurert - Jarvis returnerte da et KANONISERT FAKE-svar i produksjon,
      // ALDRI en ærlig feil. `ScriptedAdapter` er en DETERMINISTISK TEST-DOBLE
      // (se `packages/provider-adapters/src/scripted.ts`) - tester konstruerer
      // den EKSPLISITT selv i egne testfiler, den skal ALDRI stille dukke opp
      // som en ordinær provider i den ekte API-/worker-
      // prosessens `ModelGateway`. Uten den her feiler `paid_models_allowed=false`
      // + ingen ekte lokal provider NÅ ærlig med `PaidModelsDisabledError`
      // (router.ts) - en strukturert, auditerbar feil, ALDRI et falskt svar.
    ],
    // D-395 (JARVIS-039): samme budsjettkilde som workeren (`budgetConfigFromEnv`) - tidligere hardkodet her og med `DEFAULT_BUDGET` i workeren.
    budget: budgetConfigFromEnv(),
    // WP-H0 (JARVIS-087): eierens pause/tilbakekall av en modellleverandør, lest LIVE fra `owner_control_state` ved hvert kall (samme kilde i worker-main.ts) - se provider-pause.ts.
    providerPause: createProviderPauseSourceFromPool(pool),
    // WP-B4: Claude-kreditten (kun når JARVIS_CLAUDE_BUDGET_USD er satt) - beslutningen tas inne i gatewayen FØR leverandørvalg, for api OG worker (samme miljøvariabler).
    ...(claudeBudget !== undefined ? { claudeBudget } : {}),
    // WP-G3 (review A-L3): `local_vision`-PROFILEN (lokal, dedikert til vision) legges til registeret KUN når adapteren registreres - uten JARVIS_VISION_* er registeret byte-identisk med main.
    ...(visionAdapter !== null ? { registry: new CapabilityRegistry(PROFILES_WITH_LOCAL_VISION) } : {})
  });
  // JARVIS-006: hver konstruert adapter MÅ ha eksplisitt pris - ingen stille `default_rate`.
  assertProvidersHaveExplicitPricing(pricingFromEnv(), gateway.listProviderNames());
  // D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): egen
  // orkestrering over SAMME `gateway`/`pool` - ingen ny modellkall-vei, ingen
  // ny sikkerhetsvei (hvert Council-medlemsanrop går via `gateway.complete()`
  // med SPECIFIC_PROVIDER-override, samme budsjett/kost/helse/trace/
  // sensitivitet/paid_models_allowed-håndhevelse som alle andre kall).
  const aiCouncil = new AiCouncil(gateway, pool);
  // BO-03: Tool Gateway m/live transporter (aktiveres av credentials i .env),
  // Daily Brief-kilder, morgenlevering og Telegram-kommandoer.
  // K1 (D-164): `ownerControls` konstruert lenger opp (delt med `policy`).
  //
  // Task #119 (D-211): Infisical er nå PRIMÆR (Q-05 lukket - Infisical valgt,
  // ikke OpenBao), `.env`/`BusinessInternal` forblir fallback-kjeden UENDRET
  // (staged migration, D-35). `InfisicalSecretProvider.get()` returnerer
  // `null` UMIDDELBART når den ikke er konfigurert (`available()` == false,
  // se gateway.ts) - lokal dev/CI UTEN kjørende Infisical faller derfor
  // rett gjennom til SAMME env-kjede som før, INGEN regresjon.
  // Task #122 (D-213): SAMME InfisicalSecretProvider-INSTANS gis inn TO
  // ganger - én gang inni les-fallback-kjeden under (uendret), én gang som
  // det separate `writableSecrets`-argumentet (5. posisjon) som
  // `ToolGateway.setSecret()` skriver via. ALDRI to uavhengige Infisical-
  // tilkoblinger.
  const infisicalSecretProvider = new InfisicalSecretProvider();
  // Task #121 (D-214): hevet ut til en navngitt konstant (tidligere anonym
  // inline i ToolGateway-konstruktøren) - `SelfModificationService` sin
  // `resolveGitToken` gjenbruker DENNE SAMME kjeden (Infisical PRIMÆR,
  // .env/BusinessInternal fallback, D-211) for å hente `JARVIS_GITHUB_TOKEN`,
  // i stedet for en egen, parallell secret-oppløsningsvei.
  const baseSecretProvider = new FallbackSecretProvider(
    infisicalSecretProvider,
    new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())
  );
  // WP-C3 (Q-45 b / D-35): GitHub App-autentisering - KORTLEVD, REPO-SCOPET installasjonstoken i stedet for en langlevd PAT. Uten
  // JARVIS_GITHUB_APP_ID/_INSTALLATION_ID i miljøet returnerer `secretProvider()` `baseSecretProvider` UENDRET (PAT som før). Med dem
  // leverer dekoratøren installasjonstokenet under SAMME ref (`JARVIS_GITHUB_TOKEN`); privatnøkkelen leses fra vaulten ved hver signering.
  const githubAuth = createGitHubAuth({ secrets: baseSecretProvider, env: process.env });
  const readSecretProvider = githubAuth.secretProvider(baseSecretProvider);
  // Del 3 (JARVIS-013/043): klasse D-pipelinen er HÅRD i produksjon (nøkkel + full kjede + out-of-band-varsler; varsleren bindes sent under).
  const toolGateway = new ToolGateway(pool, policy, readSecretProvider, ownerControls, infisicalSecretProvider, {
    classDPipeline: { enforce: true },
    // Del 3 (JARVIS-003/005): eier-tilkoblede leverandør-credentials bindes til den autentiserte eieren i eierens tenant.
    credentialBinding: { owner_person_id: owner.owner_person_id, owner_tenants: ownerTenants, internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  // WP-K (D-471, JARVIS-056): Google-klientens id/secret leses hvelv-først (dashbord-lagret/Infisical) med miljøet som LOGGET-DEPRECATED fallback (dagens NAS-oppsett virker uendret);
  // Drive-registreringssjekken (`driveTransportsIfConfigured()` under) måles hvelv-bevisst ÉN gang her, FØR `firstWaveTools()`. API/worker-parity: samme to linjer i worker-main.ts.
  configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: infisicalSecretProvider }));
  await primeGoogleDriveCredentialCheck((ref) => readSecretProvider.get(ref));
  // D-104: egen tjeneste over SAMME runtime-pool, ingen ny motor - gjenbruker
  // DEN SAMME `toolGateway`-instansen (registrert med github under) for
  // recovery-forsøk, ALDRI et direkte transport-kall (se recovery.ts).
  const incidentService = new IncidentService(pool);
  const deploymentService = new DeploymentService(pool);
  // D-105: samme runtime-pool, ingen ny motor - diagnose er en atskilt
  // domenetjeneste (evidens vs. konklusjon, se diagnosis.ts).
  const diagnosisService = new DiagnosisService(pool);
  const businessService = new BusinessService(pool);
  // UA-3 next slice (D-53): open-loop-deteksjon - egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§4/§19/§20 i byggeordren).
  // WP-D2 (JARVIS-082): svarfrist («SLA») for support_ticket_overdue. Ugyldig JARVIS_SUPPORT_SLA_HOURS KASTER her (fail closed ved oppstart) - aldri en stille standard.
  const openLoopService = new OpenLoopService(pool, { supportSla: parseSupportSlaHours(process.env["JARVIS_SUPPORT_SLA_HOURS"]) });
  // UA-3 profiling/scoring-slice (D-61): egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§14/§23 i byggeordren) - gjenbruker Business Graph uendret.
  const scoringService = new ScoringService(pool);
  // UA-7 Communications Hub - foerste slice (D-119): egen tjeneste over
  // SAMME runtime-pool, ingen ny motor - gjenbruker Business Graph
  // (business_contacts/business_followups/business_activities) uendret via
  // pekere (linked_business_contact_id), aldri en kopi.
  const conversationGraphService = new ConversationGraphService(pool);
  // UA-3 Native Jarvis Support Core (D-66): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - gjenbruker Business Graph (kontakt-/
  // selskap-kobling) og OpenLoopService (§17 i byggeordren) uendret.
  const supportService = new SupportService(pool);
  // UA-3 Native Jarvis Contracts Core (D-71): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - motpart gjenbruker Business Graph
  // (company_id/contact_id) og OpenLoopService (renewal/deadline/obligation/
  // review-reglene) uendret. Ingen e-sign-avhengighet - `AgreementsTransport`
  // trenger derfor IKKE `toolGateway`/`ToolInvocationContext`, i motsetning
  // til `SupportTransport`.
  const agreementsService = new AgreementsService(pool);
  // UA-3 Native Jarvis Product Core (D-128): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - rapportør gjenbruker Business Graph
  // (company_id/contact_id) og OpenLoopService (triage/stagnasjon-reglene)
  // uendret. Ingen ekstern issue-tracker-avhengighet - SAMME lat/enkel-
  // avhengighet-mønster som `AgreementsTransport`.
  const productService = new ProductService(pool);
  // UA-3 Native Jarvis Operations Core (D-129): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - leverandørkontakt gjenbruker Business
  // Graph (company_id/contact_id) og OpenLoopService (forfalt/eskalerings-
  // reglene) uendret. Ingen ekstern driftsplattform-/ticketing-avhengighet
  // - SAMME lat/enkel-avhengighet-mønster som `ProductTransport`.
  const operationsService = new OperationsService(pool);
  // UA-8 Personal Digital Twin (D-130): provider-nøytral lokasjon/geofencing
  // og helse-ingestion - egne tjenester over SAMME runtime-pool, ingen ny
  // motor. Ingen ToolGateway-handlinger/API-flate lagt til her i denne
  // sliceen (bevisst utenfor UA-8-kjernens akseptansekriterier) - kun
  // datamodellen + retensjons-håndhevelsen (se DailyScheduler-sveipene under).
  const locationService = new LocationService(pool);
  const healthService = new HealthService(pool);
  const visionService = new VisionService(pool);
  // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
  // Core - egen tjeneste over SAMME runtime-pool, ingen ny motor. Refererer
  // `business_contacts` KUN via en DB-håndhevet FK (`contact_id: string`) -
  // `@jarvis/consent` importerer ALDRI `@jarvis/business` i src/ (kun i
  // test/ for fixtures) - INGEN ny kjøretids-pakkeavhengighet.
  const consentService = new ConsentService(pool);
  // D-92 (UA-4 NESTE SLICE): Consent Enforcement Activation/Rollout v1 -
  // konstrueres FØR growthService (som injiserer den valgfritt) - standard
  // rollout-modus er 'disabled' for ALLE tenant/space/formål inntil eieren
  // eksplisitt aktiverer 'audit'/'enforce' via consent.set_enforcement_policy
  // - IDENTISK oppførsel med FØR D-92 helt til det gjøres.
  const consentEnforcementService = new ConsentEnforcementService(pool, consentService);
  // UA-4 Native Jarvis Growth Core (D-74): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - attribusjon gjenbruker Business Graph
  // (business_leads/business_opportunities) og OpenLoopService
  // (marketing_spend_anomaly-regelen) uendret. Ingen annonseplattform-
  // avhengighet - `GrowthTransport` trenger derfor IKKE `toolGateway`/
  // `ToolInvocationContext`, i motsetning til `SupportTransport`.
  // D-92: `consentEnforcementService` injiseres her (valgfritt konstruktør-
  // parameter, se GrowthService-JSDoc) - `attributeToCampaign()`/
  // `attributeFromTracking()` konsulterer NÅ D-91/D-92-motoren, men KUN
  // blokkerende når eieren faktisk har aktivert 'enforce' for et gitt
  // tenant/space/formål (se D-92 i DECISIONS_AND_ASSUMPTIONS.md).
  const growthService = new GrowthService(pool, consentEnforcementService);
  // UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107): egen
  // tjeneste over SAMME runtime-pool, ingen ny motor - avviks-/avstemming-
  // deteksjon gjenbruker OpenLoopService (payment_intent_anomaly/
  // payment_intent_reconciliation_mismatch-reglene) uendret. Fiken er
  // masterplan-navngitt P0-connector (IKKE et Claude-valgt leverandørvalg),
  // ETT globalt eier-tilkoblet credential-par (SAMME "single-owner, ikke
  // multi-kunde-SaaS"-mønster som JARVIS_GOOGLE_ADS_REFRESH_TOKEN) - INGEN
  // tenant-parametrisert oppslag i denne sliceen (kun én Tobias-eid Fiken-
  // konto er i scope).
  // D-109 (UA-6 Slice 3): SAMME "ETT globalt eier-tilkoblet credential-par"-
  // mønster som `fikenCredentialsProvider` under - INGEN tenant-parametrisert
  // Stripe-Connect-oppslag denne sliceen (kun én Tobias-eid Stripe-konto er i
  // scope, se stripe-transport.ts/types.ts sin D-109-kommentar).
  // D-246 (2026-09-23, funnet LIVE av Tobias: "Test tilkobling" feilet på
  // Neonomics med `credentials_unavailable` selv om CLIENT_ID/SECRET/
  // DEVICE_ID ALLE viste ✓ som lagret i dashbordet). Root cause: de fire
  // finans-`getCredentials()`-lukkingene under leste FØR direkte fra
  // `process.env[...]`, HELT UTENOM `readSecretProvider` (Infisical-primær,
  // se D-211 over) - eierens "lim inn ny verdi"-dashbord-flyt (D-213)
  // skriver KUN til Infisical (`ToolGateway.setSecret()`), aldri til den
  // kjørende prosessens `process.env`. `hasSecret()`/dashbordets ✓-visning
  // SPØR `readSecretProvider` (finner den i Infisical - viser derfor
  // korrekt ✓), mens disse fire lukkingene ALDRI så den samme verdien -
  // strukturelt umulig å få "Test tilkobling" til å lykkes via dashbordet
  // alene, uansett hva som ble limt inn. Fiken var IKKE rammet (dens
  // faktiske credential, `JARVIS_FIKEN_REFRESH_TOKEN`, kommer utelukkende
  // fra `fiken-reauth.ts`, som skriver DIREKTE til `.env`-filen, aldri via
  // dashbordet/Infisical). Fiks: alle fire leser nå via `readSecretProvider`
  // (SAMME kjede `hasSecret()` allerede bruker) - `.env`-fallback UENDRET
  // for de som fortsatt foretrekker den ruten.
  const stripeCredentialsProvider: StripeCredentialsProvider = {
    async getCredentials(): Promise<StripeCredentials | null> {
      const secretKey = await readSecretProvider.get("JARVIS_STRIPE_SECRET_KEY");
      if (!secretKey) return null;
      return { secretKey };
    }
  };
  // D-394 (JARVIS-056): webhook-hemmeligheter leses via den delte kjeden (Infisical-primær, .env-fallback) - samme som øvrige credentials -
  // slik at «lim inn ny verdi» i dashbordet faktisk gjelder, i stedet for at en rotert hemmelighet ble liggende i `process.env` til omstart.
  const stripeWebhookSecretProvider = async () => (await readSecretProvider.get("JARVIS_STRIPE_WEBHOOK_SECRET")) ?? null;
  const stripeTenantResolver = () => process.env["JARVIS_STRIPE_TENANT_ID"] ?? null;
  // D-110 (UA-6 Slice 4): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster som Stripe over - INGEN tenant-parametrisert multi-MSN-oppslag
  // denne sliceen (kun én Tobias-eid Vipps-selgerkonto er i scope).
  const vippsCredentialsProvider: VippsCredentialsProvider = {
    async getCredentials(): Promise<VippsCredentials | null> {
      const clientId = await readSecretProvider.get("JARVIS_VIPPS_CLIENT_ID");
      const clientSecret = await readSecretProvider.get("JARVIS_VIPPS_CLIENT_SECRET");
      const subscriptionKey = await readSecretProvider.get("JARVIS_VIPPS_SUBSCRIPTION_KEY");
      const merchantSerialNumber = await readSecretProvider.get("JARVIS_VIPPS_MSN");
      if (!clientId || !clientSecret || !subscriptionKey || !merchantSerialNumber) return null;
      return { clientId, clientSecret, subscriptionKey, merchantSerialNumber, environment: process.env["JARVIS_VIPPS_ENVIRONMENT"] === "production" ? "production" : "test" };
    }
  };
  const vippsWebhookSecretProvider = async () => (await readSecretProvider.get("JARVIS_VIPPS_WEBHOOK_SECRET")) ?? null;
  const vippsTenantResolver = () => process.env["JARVIS_VIPPS_TENANT_ID"] ?? null;
  // D-111 (UA-6 Slice 5): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster - ett Neonomics-kundeforhold, en Jarvis-stabil x-device-id.
  const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
    async getCredentials(): Promise<NeonomicsCredentials | null> {
      const clientId = await readSecretProvider.get("JARVIS_NEONOMICS_CLIENT_ID");
      const clientSecret = await readSecretProvider.get("JARVIS_NEONOMICS_CLIENT_SECRET");
      const deviceId = await readSecretProvider.get("JARVIS_NEONOMICS_DEVICE_ID");
      if (!clientId || !clientSecret || !deviceId) return null;
      return {
        clientId, clientSecret, deviceId,
        environment: process.env["JARVIS_NEONOMICS_ENVIRONMENT"] === "production" ? "production" : "sandbox",
        ...(process.env["JARVIS_NEONOMICS_REALM"] ? { realm: process.env["JARVIS_NEONOMICS_REALM"] } : {})
      };
    }
  };
  const neonomicsWebhookApiKeyProvider = async () => (await readSecretProvider.get("JARVIS_NEONOMICS_WEBHOOK_API_KEY")) ?? null;
  const neonomicsTenantResolver = () => process.env["JARVIS_NEONOMICS_TENANT_ID"] ?? null;
  // D-112 (UA-6 Slice 6), korrigert owner-provided primary-source-audit
  // (PR #62 runde 4): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster - ett Wallester Business-kundeforhold. Autentisering er
  // api_key/ts JWT signert RS256 (IKKE issuer/audience/sub/rbh - den
  // modellen gjaldt Wallester Card API, en ANNEN produkt-grense, se
  // wallester-transport.ts filhode). Selve nøkkelanskaffelsen
  // (BUSINESS_AUTH_SIGNING_MATERIAL) er PRIMARY_SOURCE_PUBLIC_DOC_GAP -
  // `sign` forblir injiserbar/fail-closed fremfor gjettet.
  const wallesterCredentialsProvider: WallesterCredentialsProvider = {
    async getCredentials(): Promise<WallesterCredentials | null> {
      const baseUrl = await readSecretProvider.get("JARVIS_WALLESTER_API_BASE_URL");
      const apiKey = await readSecretProvider.get("JARVIS_WALLESTER_API_KEY");
      const accountId = await readSecretProvider.get("JARVIS_WALLESTER_ACCOUNT_ID");
      const privateKeyPem = await readSecretProvider.get("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
      if (!baseUrl || !apiKey || !accountId || !privateKeyPem) return null;
      return {
        baseUrl, apiKey, accountId,
        sign: createRsaJwtSigner(privateKeyPem),
        environment: process.env["JARVIS_WALLESTER_ENVIRONMENT"] === "production" ? "production" : "sandbox"
      };
    }
  };
  const wallesterWebhookBasicAuthProvider = () => {
    const username = process.env["JARVIS_WALLESTER_WEBHOOK_BASIC_USER"];
    const password = process.env["JARVIS_WALLESTER_WEBHOOK_BASIC_PASSWORD"];
    return username && password ? { username, password } : null;
  };
  const wallesterTenantResolver = () => process.env["JARVIS_WALLESTER_TENANT_ID"] ?? null;
  const financeService = new FinanceService(
    pool, undefined, stripeCredentialsProvider, undefined, stripeWebhookSecretProvider, stripeTenantResolver,
    vippsCredentialsProvider, undefined, vippsWebhookSecretProvider, vippsTenantResolver,
    neonomicsCredentialsProvider, undefined, neonomicsWebhookApiKeyProvider, neonomicsTenantResolver
  );
  const bankingService = new BankingService(pool, neonomicsCredentialsProvider);
  const cardService = new CardService(pool, wallesterCredentialsProvider, undefined, wallesterWebhookBasicAuthProvider, wallesterTenantResolver);
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): egen
  // tjeneste over SAMME runtime-pool - ZERO ekstern leverandør (kun
  // interne kilder Jarvis allerede eier, se spend-service.ts). Avviks-
  // surfacing gjenbruker OpenLoopService (finance_spend_unexpected/
  // finance_spend_amount_deviation/finance_recurring_charge_missing/
  // finance_recurring_charge_duplicate/finance_spend_correction_conflict-
  // reglene) uendret.
  const spendService = new SpendService(pool);
  // D-246: samme fiks som stripe/vipps/neonomics/wallester over - leser nå
  // via readSecretProvider i stedet for rå process.env.
  const fikenCredentialsProvider: FikenCredentialsProvider = {
    async getCredentials(): Promise<FikenCredentials | null> {
      const refreshToken = await readSecretProvider.get("JARVIS_FIKEN_REFRESH_TOKEN");
      const companySlug = await readSecretProvider.get("JARVIS_FIKEN_COMPANY_SLUG");
      if (!refreshToken || !companySlug) return null;
      return { refreshToken, companySlug };
    }
  };
  // WP-F1 (D-462, UA-6): deterministisk avstemming av penger (intensjon <-> leverandørutfall <-> Fiken-bilag). Observasjon + varsel, ALDRI korreksjon. DORMANT uten Fiken-
  // credentials (`checks.fiken = skipped_no_credentials`); varsler eieren via den eksisterende Telegram-banen i ToolGateway (feil gjøres synlig, rulles aldri tilbake).
  const financeReconciliation = new FinanceReconciliationService(pool, {
    fiken: createFikenPostingReader(fikenCredentialsProvider),
    notifier: {
      async notify({ run_id, text }) {
        const sent = await toolGateway.execute({
          identity: ownerIdentity as never, tool_id: "telegram", action: "notify", parameters: { message: text.slice(0, 3900) }, idempotency_key: `finance-reconcile:${run_id}`
        });
        if (!sent.ok) throw new Error(`notify_failed:${sent.reason}`);
      }
    }
  });
  // D-97: sentralisert GitHub rate-limit-kontroller - Postgres-baaret delt
  // tilstand (SHARED_RUNTIME, deles med worker-main.ts sin egen instans over
  // SAMME pool/tabell). `onTransition` er en bevisst minimal operativ-
  // synlighet-krok (§24) - IKKE en full EventWriter/tenant-audit-kobling
  // (GitHub-credentialen er global, ikke tenant-scoped, se D-97).
  const githubRateLimitController = githubAuth.rateLimitController(
    // WP-C3: nøkkelen er `JARVIS_GITHUB_TOKEN` i PAT-modus (uendret), ellers per installasjon (installasjonstokenet har egen kvote).
    new PgGithubRateLimitStore(pool),
    (event) => console.warn(`[github-rate-limit] ${event.transition} -> ${event.state}${event.retryAt ? ` retry_at=${event.retryAt.toISOString()} source=${event.source}` : ""}`)
  );
  // Remediering del 2 (JARVIS-065): systemidentitet med unik sesjons-id per oppstart (ingen falsk fast `sess-brief`).
  const ownerIdentity = systemIdentity(owner, "brief", { channel: "api" });
  // UA-10 P1 AKTIVERING (D-160): Situation Engine kobles til komposisjons-
  // roten for FØRSTE gang (P0 lot den bevisst stå ukoblet til det fantes en
  // reell kaller - den finnes nå: `situation-sweep`-jobben lenger ned).
  // DURABLE domene-pause med fail-closed `restore()` FØR noe kan kalle
  // motoren (en omstart glemmer aldri en aktiv pause), sovereign-eier-
  // autoritet for pause/policy/gjenoppretting = SAMME eier som
  // `ownerIdentity`/`PolicyGateway`. Kontrollflaten (`situations`-verktøyet)
  // registreres gjennom `firstWaveTools(..., { additionalTools })` under -
  // SAMME ene register-løkke, aldri en parallell registreringsvei.
  const situationDomainPauses = new DomainPauseRegistry(pool, { owner_person_id: ownerIdentity.person_id });
  await situationDomainPauses.restore();
  const situationEngine = new SituationEngine(pool, situationDomainPauses, { owner_person_id: ownerIdentity.person_id });
  // Task #118 ("Charlie"-minne-verifisering): hevet ut hit (FØR register-
  // løkken) slik at DEN SAMME instansen kan registreres som
  // `memory.search`-verktøyet i `additionalTools` under OG gjenbrukes av
  // `ConversationEngine` sin egen bakgrunns-kontekst (`conversationEngine`
  // under) - IKKE to separate `MemoryRetriever`-instanser mot samme pool.
  // D-386 (Minne v2): ÉN faktory for embedding-provideren - alltid LOKAL (`assertLocalEmbedding` i writer/retriever
  // stopper en sky-provider ved oppstart). `ollama` (bge-m3 o.l.) gir ekte semantisk gjenfinning; `local-hash` er
  // kun fallback uten semantikk og logges som advarsel så det aldri går ubemerket i drift.
  const memoryEmbedding = createEmbeddingProviderFromEnv();
  console.log(JSON.stringify({
    msg: memoryEmbedding.model === "local-hash-v1" ? "memory_embedding_fallback_hash_no_semantics" : "memory_embedding_provider",
    model: memoryEmbedding.model, dim: memoryEmbedding.dim, locality: memoryEmbedding.locality
  }));
  const memoryRetriever = new MemoryRetriever(pool, memoryEmbedding);
  // WP-D1 (UA-2, JARVIS-060): kunnskapslaget (`KnowledgeRetriever`) er nå koblet til chatten som `knowledge.search` (chattens lese-nivå, klasse A, ubetrodd output). SAMME lokale
  // embedding-leverandør som minnet og kunnskaps-synken (en sky-provider er avvist ved oppstart av `MemoryWriter`/`MemoryRetriever`; vektorer fra en annen modell filtreres bort i søket).
  const knowledgeRetriever = new KnowledgeRetriever(pool, memoryEmbedding);
  // D-283 (Tobias direkte i chat, "ja bygg minne-skrivingen", ETTER at D-282
  // sin live-samtale avdekket at minnet var en HELT PASSIV lesestruktur -
  // `MemoryWriter`/ekstraksjon var bygget og enhetstestet, men ALDRI kalt fra
  // noe produksjonssted, se D-283 i DECISIONS_AND_ASSUMPTIONS.md): SAMME
  // delte `memoryEmbedding`-instans som `memoryRetriever` over
  // (deterministisk/lokal - ingen grunn til to separate objekter).
  // D-300 (Tobias direkte i chat, "husker han ingenting... vi trodde det
  // fungerte fungerte det ikke" - live telefon-testing avslørte at D-287 sin
  // regelbaserte extractor i praksis var for streng til reell samtale, kun
  // fire snevre signalord-mønstre): `LlmExtractionAdapter` (`extraction.ts`)
  // er nå den WIRED-INN implementasjonen - `gateway` (konstruert over) sendes
  // rett inn, den strukturelt-minimale `MemoryExtractionCompleter` den
  // faktisk krever er allerede oppfylt av en ekte `ModelGateway`.
  // `RuleBasedExtractor` forblir en deterministisk test-/referanse-
  // implementasjon, IKKE lenger wired inn her. Brukt KUN av
  // `conversationEngine` sin `memory.ingest()` under - ALDRI av
  // `IngestionService.ingestExternal()` (den forblir den separate,
  // Ingestion Zone-karantene-veien for EKSTERNT/ubetrodd innhold - e-post/
  // web/verktøyoutput - som er en helt annen tillitsklasse enn eierens egne
  // ord i en samtale, se `ingest`-kommentaren ved `conversationEngine` under).
  const memoryWriter = new MemoryWriter(pool, memoryEmbedding, new LlmExtractionAdapter(gateway, { maxConcurrent: envInt("JARVIS_MEMORY_EXTRACTION_CONCURRENCY", 1, { min: 1, max: 8 }) }), policy);
  // WP-D1 (UA-2, Q-26): påstandsverifisering (kildeuavhengighet, ingen autonom nettsøk). Lesingen (`knowledge.get_claim_status`) er alltid på; SKRIVING er AV som standard og slås på med
  // JARVIS_KNOWLEDGE_CLAIM_WRITES=on (kun den eksakte verdien «on» - alt annet er av). Promotering til etablert kunnskap er KUN et forslag til minnets karantene (`MemoryWriter.propose`, D-367).
  const knowledgeClaimWrites = parseKnowledgeClaimWrites(process.env["JARVIS_KNOWLEDGE_CLAIM_WRITES"]);
  const knowledgeClaims = createKnowledgeClaimsPort(
    new ClaimVerificationService(pool, { default_min_independent_sources: envInt("JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES", 2, { min: 2, max: 10 }) }),
    { writes: knowledgeClaimWrites, promotion: memoryWriter }
  );
  // D-286 (Tobias "alle" - se retention-sweep.ts sitt filhode for full
  // begrunnelse): `SummaryService` FANTES fra før, men ble ALDRI konstruert
  // eller kalt fra noe produksjonssted (D-286 sitt eget funn) - kun
  // `memory-retention-sweep`-jobben under bruker den.
  // D-386: LLM-genererte dagssammendrag (purpose SUMMARIZE via samme gateway/ruter - sensitivt innhold går lokalt) med vektor,
  // så sammendragslaget faktisk er LESBART i retrieveren. Template-fallback når modellen feiler.
  const memorySummaries = new SummaryService(pool, { completer: gateway, embeddings: memoryEmbedding });
  // D-102: ÉN delt `TaskService`-instans - gjenbrukes UENDRET av `ConversationEngine`
  // (eksisterende `tasks.create`-goal-only-vei), den nye `/tasks/submit`-HTTP-ruten
  // (full `JobContract`, inkl. `agent_profile: "coding"`), OG (task #123, D-214)
  // `SelfModificationService.proposeCodeChange()` under - ALDRI to parallelle
  // `TaskService`-konstruksjoner mot samme pool. Hevet hit (tidligere lenger ned)
  // FORDI selfModificationService (rett under) nå trenger den ved konstruksjon.
  const taskService = new TaskService(pool, queue, policy, { codingRepoAllowlist: allowedReposFromEnv(process.env) });
  // D-125/task #123 (D-214): `sendTelegram` hevet hit (tidligere lenger ned, kun
  // brukt av Telegram-pollerens svarbane/DailyScheduler) - `SelfModificationService`
  // sin nye owner-varsling (se `notify` under) trenger DEN SAMME, allerede
  // ToolGateway-styrte send-banen, IKKE en egen, parallell varslingsmekanisme.
  // Avhenger KUN av `toolGateway`/`ownerIdentity`, begge allerede konstruert over.
  toolGateway.setClassDNotifier(telegramClassDNotifier({
    execute: (req) => toolGateway.execute({ ...req, identity: req.identity as never }),
    secrets: readSecretProvider,
    identity: ownerIdentity as never
  }));
  const sendTelegram = async (text: string) => {
    for (let i = 0; i < text.length; i += 3900) {
      await toolGateway.execute({ identity: ownerIdentity as never, tool_id: "telegram", action: "notify",
        parameters: { message: text.slice(i, i + 3900) } });
    }
  };
  // D-416: chat og agenter er to løp - delegerte bakgrunnsjobber (kø), levering av resultat tilbake til samtalen (melding + Telegram).
  const chatJobs = new ChatJobs(pool, {
    saveMessage: (identity, role, content) => new MessageStore(pool).save(identity, role, content),
    notify: (text) => sendTelegram(`🔔 ${text}`),
    log: (event) => console.log(JSON.stringify(event))
  });
  // REMEDIERING DEL 1 (JARVIS-042/043): selvmodifikasjon er FRYST inntil
  // remedieringsdel 9 (SHA-bundet godkjenning, kill-switch-/freeze-respekt,
  // audit). `SelfModificationService` konstrueres IKKE, de tre 60-sekunders-
  // sveipene (`sweepPendingRequests`/`sweepPendingJobs`/`sweepApprovedRequests`)
  // startes IKKE, `self_modification.*` registreres IKKE i ToolGateway og
  // Telegram-kommandoene `/godkjenn`/`/avvis` har ingen handler. Modulen
  // `@jarvis/self-modification` ligger urørt og dormant i repoet.
  // D-388: én delt Microsoft Graph-auth for OneDrive + Outlook (se wiring under).
  const microsoftGraphAuth = new MicrosoftGraphAuth({
    refreshToken: () => readSecretProvider.get("JARVIS_MICROSOFT_REFRESH_TOKEN"),
    clientId: () => readSecretProvider.get("JARVIS_MICROSOFT_CLIENT_ID"),
    clientSecret: () => readSecretProvider.get("JARVIS_MICROSOFT_CLIENT_SECRET"),
    tenant: () => readSecretProvider.get("JARVIS_MICROSOFT_TENANT_ID"),
    persist: (value) => toolGateway.setSecret("JARVIS_MICROSOFT_REFRESH_TOKEN", value)
  });
  // WP-H0 (UA-11 Admin Control Center): registeret over de ti kontrollsentrene. EIER-KUN og fail-closed: kun den suverene eieren (eier-person i eier-tenant, ingen delegasjon) får rapporter, samme
  // `resolveAuthorityMode` og SAMME `ownerAuthority` som Policy Gateway. Fabrikken (control-center/register.ts) eier både eier-predikatet og redigeringen av hemmeligheter - ingen av dem er en parameter her
  // (gjennomgang av PR #316, M-2; låst av wph0-control-wiring.test.ts). Sentrene leser kun eksisterende kilder; de skriver ingenting.
  const controlCenters = createControlCenterRegistry({ authority: ownerAuthority });
  // WP-H0 (AI Center): ÉN delt begrenser for AI-rådets automatiske trigger - samme instans i chatten (`ConversationEngine`) og i kontrollsenteret, så tellerne som vises er de som faktisk håndheves.
  const councilAutoLimiter = new CouncilAutoTriggerLimiter(envInt("JARVIS_COUNCIL_AUTO_MAX_PER_HOUR", 3, { min: 1, max: 100 }));
  // WP-H2: Drift- og Verdi-sentrene leser rapportene til ExecutiveService (bygges lenger ned) gjennom late funksjoner. Golden-suite-kjøreren deles av Sikkerhet-senteret og `executive.run_golden_suite` -
  // den finnes KUN med JARVIS_CONTROL_GOLDEN_SUITE=on (deterministisk, lesende, ingen modell). Prosessens starttidspunkt gir oppetid i Drift-senteret.
  const executiveRef: { service?: ExecutiveService } = {};
  const lateExecutive = (): ExecutiveService => {
    if (executiveRef.service === undefined) throw new Error("executive_service_not_ready");
    return executiveRef.service;
  };
  const goldenSuiteRunner = flagOn(process.env, CONTROL_FEATURE_FLAGS.goldenSuite) ? createGoldenSuiteRunner({ surface: () => modelToolSurface }) : undefined;
  const processStartedAt = new Date(Date.now() - Math.round(process.uptime() * 1000));
  registerControlCenters(controlCenters, {
    pool, env: process.env, toolGateway, ownerControls, meshStatus: () => gateway.meshStatus(),
    authority: ownerAuthority, killSwitch, infraGate,
    ...(policyAuditSink ? { policyAudit: () => ({ gateway: policy.auditStats(), sink: policyAuditSink.stats() }) } : {}),
    modelGateway: gateway, runRate: new RunRateService(pool), councilLimiter: councilAutoLimiter, evolutionReport: evolutionReports, maxActiveJobs: MAX_ACTIVE_JOBS,
    // WP-B3 (D-475, EV-22): Evolusjon-senteret (kun med JARVIS_CONTROL_CENTER_EVOLUTION=on) leser samme rapport + beredskap + oppstartssjekk, bundet til eierens tenant.
    evolutionReadiness, ev0Status: () => getLastEv0BootStatus(), evolutionTenantId: owner.tenant_id,
    valueReport: (tenantId) => lateExecutive().getValueReport(tenantId), infraStatus: (tenantId) => lateExecutive().getInfraStatus(tenantId),
    ...(backupStatusSource ? { backupStatus: backupStatusSource } : {}), processStartedAt: () => processStartedAt,
    ...(goldenSuiteRunner ? { goldenSuite: goldenSuiteRunner } : {})
  });
  // WP-D3 (UA-4 Growth, D-459): skrivehandlinger mot annonse-/analyseplattformene + eksperimentregisteret. ALT er AV som standard: uten `JARVIS_GROWTH_WRITE_PLATFORMS` registreres INGEN skriveverktøy, og uten
  // `JARVIS_GROWTH_EXPERIMENTS=on` ingen eksperimentverktøy - verktøylister, utvalg og rate-grenser er da identiske med main, og `deps.growthWrites` (rutene) finnes ikke (404). Skriving krever dessuten
  // eierens EGNE konto-/eiendoms-id-er i `JARVIS_GROWTH_WRITE_TARGETS` (mål-autorisasjon i gatewayen, fail-closed). Kun API-prosessen registrerer dem (worker/bakgrunn er read-only).
  const growthWriteConfig = growthWriteConfigFromEnv(process.env);
  const growthWriteEnabled = growthWriteConfig.platforms.size > 0;
  const growthExperimentsEnabled = process.env["JARVIS_GROWTH_EXPERIMENTS"] === "on";
  const growthWriteTransports = growthWriteEnabled
    ? createGrowthWriteTransports(growthWriteConfig, {
        readSecret: (ref) => readSecretProvider.get(ref), env: process.env,
        // UA-6: pengeøkende handlinger nektes mens eierens finans-nødbryter er på OG når tilstanden er ukjent (fail-closed i fabrikken); det er ikke et beløpstak.
        financeKillSwitch: async (tenantId) => (await financeService.getKillSwitch(tenantId))?.enabled === true
      })
    : {};
  const growthExperimentRegistry = growthExperimentsEnabled ? new ExperimentRegistryService(pool) : undefined;
  // Review INFO: loggen kommer KUN når et av flaggene er satt (med alt AV er oppstarten identisk med main - ingen ekstra loggline).
  if (growthWriteEnabled || growthExperimentsEnabled) {
    console.log(JSON.stringify({ msg: "growth_writes", platforms: [...growthWriteConfig.platforms], targets: [...growthWriteConfig.targets.entries()].map(([p, ids]) => ({ platform: p, count: ids.size })), experiments: growthExperimentsEnabled }));
  }
  // WP-B3 (D-475, EV-23): eierens avgjørelse om et endringsforslag (`executive.record_evolution_decision`, kun en registrering i revisjonssporet - ingen virkning) finnes KUN med JARVIS_CONTROL_EVOLUTION_APPROVAL=on OG når
  // Evolusjon-senteret faktisk er koblet inn (knappene bor der). Uten flagget finnes hverken verktøyet, skriveren eller ruten-navnet (flagg AV er identisk med main).
  const evolutionApprovalOn = flagOn(process.env, CONTROL_FEATURE_FLAGS.evolutionApproval) && controlCenters.has("evolution");
  for (const tool of firstWaveTools({
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(githubRateLimitController),
    // D-247: `chatId` som en resolver mot `readSecretProvider` (samme
    // Infisical-primær kjede `JARVIS_TELEGRAM_TOKEN` allerede leses via) -
    // slås opp på nytt ved hvert `notify`-kall i stedet for å fryses fra
    // `process.env` ved oppstart (samme bug-klasse/fiks som D-246).
    telegram: new TelegramTransport(() => readSecretProvider.get("JARVIS_TELEGRAM_CHAT_ID")),
    // D-292: SlackTransport tar boten sin egen token direkte per kall (via
    // ToolGateway.execute() sin vanlige credential-oppslag, SAMME mønster som
    // GmailTransport/GithubTransport over) - ingen resolver-closure nødvendig
    // her, i motsetning til Telegram sin `chat_id` (Slack sender `channel`
    // som et vanlig model-/trusted-lag-parameter, ALDRI en fast bot-config).
    slack: new SlackTransport(),
    // D-294: samme mønster som Slack over - Discord sender `channel_id` som
    // et vanlig handlingsparameter per kall, ingen resolver-closure nødvendig.
    discord: new DiscordTransport(),
    // D-295: Twilio krever TO faste konfigurasjonsverdier utover selve
    // credential-en (`AccountSid`/`From`-nummer) - SAMME resolver-mot-
    // readSecretProvider-mønster som Telegram sin `chat_id` (D-247) over,
    // slått opp PÅ NYTT ved hvert kall, ikke frosset ved oppstart.
    twilio: new TwilioTransport(
      () => readSecretProvider.get("JARVIS_TWILIO_ACCOUNT_SID"),
      () => readSecretProvider.get("JARVIS_TWILIO_FROM_NUMBER")
    ),
    // D-296: ren tom-konstruktør, samme mønster som Slack/Discord over -
    // Brave Search sender `query` som et vanlig handlingsparameter per kall,
    // ingen resolver-closure nødvendig (ingen ekstra fast kontokonfigurasjon
    // slik Twilio krevde).
    brave_search: new BraveSearchTransport(),
    // D-297: Sentry krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (organisasjons-slug, URL-sti-parameter for ALLE fire
    // handlinger) - SAMME resolver-mot-readSecretProvider-mønster som Twilio
    // sin AccountSid (D-295) over, slått opp PÅ NYTT ved hvert kall.
    sentry: new SentryTransport(() => readSecretProvider.get("JARVIS_SENTRY_ORG_SLUG")),
    // D-298: ren tom-konstruktør, samme mønster som Slack/Discord/Brave
    // Search over - Google Maps sender `address`/`latlng` som et vanlig
    // handlingsparameter per kall, ingen resolver-closure nødvendig.
    google_maps: new GoogleMapsTransport(),
    // D-299: ren tom-konstruktør - `GoogleSheetsTransport` slår selv opp
    // `googleAccessToken()` internt per kall (samme mønster som Gmail/
    // Calendar/Drive sine transporter over, som ALLE også har tomme
    // konstruktører - access-token-utvekslingen skjer per `invoke()`-kall,
    // ikke ved konstruksjon).
    google_sheets: new GoogleSheetsTransport(),
    // D-301: ren tom-konstruktør, samme mønster som Brave Search over -
    // Tavily sender `query`/`api_key` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    tavily: new TavilyTransport(),
    // D-302: ren tom-konstruktør, samme mønster som Tavily over - Exa
    // sender `query`/`url` som vanlige handlingsparametere per kall, ingen
    // resolver-closure nødvendig.
    exa: new ExaTransport(),
    // D-303: ren tom-konstruktør, samme mønster som Google Maps over - Google
    // Places sender `query`/`place_id` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    google_places: new GooglePlacesTransport(),
    // D-304: ren tom-konstruktør, samme mønster som Google Maps/Google Places
    // over - Google Routes sender `origin`/`destination`/`origins`/
    // `destinations` som vanlige handlingsparametere per kall, ingen
    // resolver-closure nødvendig.
    google_routes: new GoogleRoutesTransport(),
    // D-305: Grafana krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (base-URL, siden Grafana typisk er selv-hostet uten et
    // fast SaaS-domene) - SAMME resolver-mot-readSecretProvider-mønster som
    // Sentry sin org-slug (D-297), slått opp PÅ NYTT ved hvert kall.
    grafana: new GrafanaTransport(() => readSecretProvider.get("JARVIS_GRAFANA_API_BASE_URL")),
    // D-306: SAMME resolver-mot-readSecretProvider-mønster som Grafana over
    // - Prometheus krever også en fast base-URL utover selve credential-en,
    // siden Prometheus også er typisk selv-hostet.
    prometheus: new PrometheusTransport(() => readSecretProvider.get("JARVIS_PROMETHEUS_API_BASE_URL")),
    // D-307: ren tom-konstruktør, samme mønster som Brave Search/Tavily/Exa
    // over - Dropbox sender `path` som et vanlig handlingsparameter per
    // kall, ingen resolver-closure nødvendig (ETT fast access-token, INGEN
    // OAuth-refresh-flyt som Google-familien).
    // D-388: Dropbox-tokens er kortlivede - refresh-token + app-nøkkel/-hemmelighet via secret-kjeden gir automatisk
    // fornyelse (cachet i minnet); uten refresh-konfig brukes `JARVIS_DROPBOX_TOKEN` statisk som før.
    dropbox: new DropboxTransport({
      refreshToken: () => readSecretProvider.get("JARVIS_DROPBOX_REFRESH_TOKEN"),
      appKey: () => readSecretProvider.get("JARVIS_DROPBOX_APP_KEY"),
      appSecret: () => readSecretProvider.get("JARVIS_DROPBOX_APP_SECRET")
    }),
    // D-308: ren tom-konstruktør, samme mønster som Dropbox over - Notion
    // sender `Notion-Version` som en FAST header inni transporten selv
    // (ingen resolver-closure nødvendig, ETT fast integrasjonstoken).
    notion: new NotionTransport(),
    // D-309: ren tom-konstruktør, samme mønster som Dropbox/Notion over -
    // OneDrive sender `path`/`name` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    // D-388: OneDrive og Outlook deler ÉN Microsoft Graph-auth (refresh-token + app-registrering + tenant via
    // secret-kjeden). Microsoft roterer refresh-tokenet i hvert svar - det nye skrives tilbake via
    // `toolGateway.setSecret()` (Infisical). Uten refresh-konfig brukes de statiske tokenene som før.
    onedrive: new OneDriveTransport(microsoftGraphAuth),
    microsoft_outlook: new MicrosoftOutlookTransport(microsoftGraphAuth),
    // D-311: SAMME resolver-mot-readSecretProvider-mønster som Grafana/
    // Prometheus - n8n er også typisk selv-hostet.
    n8n: new N8nTransport(() => readSecretProvider.get("JARVIS_N8N_API_BASE_URL")),
    // D-313: tom konstruktør - `client_id`/`client_secret` leses direkte fra
    // env inne i `spotifyAccessToken()` (delt app-konfig, ikke en resolver).
    // D-388: client_id/secret via secret-kjeden (ikke fryst fra env), access-token cachet, rotert refresh-token persisteres.
    spotify: new SpotifyTransport({
      clientId: () => readSecretProvider.get("JARVIS_SPOTIFY_CLIENT_ID"),
      clientSecret: () => readSecretProvider.get("JARVIS_SPOTIFY_CLIENT_SECRET"),
      persist: (value) => toolGateway.setSecret("JARVIS_SPOTIFY_REFRESH_TOKEN", value)
    }),
    // D-314: `phone_number_id` er Jarvis sin egen avsenderidentitet - SAMME
    // resolver-mot-readSecretProvider-mønster som Telegram sin chat_id.
    whatsapp: new WhatsAppTransport(() => readSecretProvider.get("JARVIS_WHATSAPP_PHONE_NUMBER_ID")),
    // D-315: SAMME resolver-mot-readSecretProvider-mønster som n8n - Make
    // sin API-base-URL er zone-spesifikk (brukerens kontosone).
    make: new MakeTransport(() => readSecretProvider.get("JARVIS_MAKE_API_BASE_URL")),
    // D-316: tom konstruktør - INGEN base-URL/org-slug nødvendig (fast
    // OpenAI-vertsnavn, kun Bearer-token).
    openai_images: new OpenAIImagesTransport(),
    // D-321: `from`-nummeret er Jarvis sin egen avsenderidentitet - SAMME
    // resolver-mot-readSecretProvider-mønster som Twilio (D-295).
    telnyx: new TelnyxTransport(() => readSecretProvider.get("JARVIS_TELNYX_FROM_NUMBER")),
    // D-322: tom konstruktør - fast Runway-vertsnavn, kun Bearer-token +
    // en fast X-Runway-Version-header (satt inni transporten selv).
    runway: new RunwayTransport(),
    // D-323: Kling krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (Access Key, brukt som JWT `iss`-claim) - SAMME
    // resolver-mot-readSecretProvider-mønster som Telnyx/Twilio over.
    // Secret Key (credential_ref) brukes til JWT-signering inni
    // transporten selv, ALDRI sendt uendret som header-verdi.
    kling: new KlingTransport(() => readSecretProvider.get("JARVIS_KLING_ACCESS_KEY")),
    // D-324: tom konstruktør - fast Gemini API-vertsnavn, kun
    // x-goog-api-key-header (SAMME auth-form som `gemini` sin EKSISTERENDE
    // model_provider-oppføring, se GoogleVeoTransport sin doc-kommentar).
    google_veo: new GoogleVeoTransport(),
    // D-327: Higgsfield krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (Key ID, brukt sammen med Key Secret i ETT
    // Authorization-header-felt) - SAMME resolver-mot-readSecretProvider-
    // mønster som Telnyx/Twilio/Kling over.
    higgsfield: new HiggsfieldTransport(() => readSecretProvider.get("JARVIS_HIGGSFIELD_KEY_ID")),
    // D-329: Todoist krever KUN selve credential-en (bearer-token, ingen
    // ekstra fast konfigurasjonsverdi) - samme tomme-konstruktør-mønster
    // som Discord/Notion over.
    todoist: new TodoistTransport(),
    // D-330: Trello krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (API-nøkkel, brukt sammen med token som query-
    // parametere) - SAMME resolver-mot-readSecretProvider-mønster som
    // Telnyx/Twilio/Kling/Higgsfield over.
    trello: new TrelloTransport(() => readSecretProvider.get("JARVIS_TRELLO_API_KEY")),
    // D-331: Jira Cloud er PER-TENANT - krever TO faste konfigurasjons-
    // verdier utover selve credential-en (base-URL + e-post), SAMME
    // resolver-mot-readSecretProvider-mønster som Twilio (D-295) sin
    // to-resolver-form.
    jira: new JiraTransport(
      () => readSecretProvider.get("JARVIS_JIRA_BASE_URL"),
      () => readSecretProvider.get("JARVIS_JIRA_EMAIL")
    ),
    // D-332: Linear krever KUN selve credential-en (rå API-nøkkel i
    // Authorization-headeren, ingen ekstra fast konfigurasjonsverdi) -
    // samme tomme-konstruktør-mønster som Discord/Notion/Todoist over.
    linear: new LinearTransport(),
    // D-333: HubSpot krever KUN selve credential-en (Bearer private
    // app-token, ingen ekstra fast konfigurasjonsverdi) - samme
    // tomme-konstruktør-mønster som Discord/Notion/Todoist/Linear over.
    hubspot: new HubSpotTransport(),
    // D-334: Pipedrive er PER-TENANT (samme mønster som Jira sin base-URL-
    // resolver, D-331) - krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en.
    pipedrive: new PipedriveTransport(() => readSecretProvider.get("JARVIS_PIPEDRIVE_BASE_URL")),
    // D-242/D-248: `vercel` hadde en `live_test` siden D-213, men ALDRI en
    // ekte transport her - falt gjennom til `UnconfiguredHttpTransport`
    // (ubetinget `vercel_not_configured`), uansett credential-tilstand (se
    // `live-transports.ts` sin `VercelTransport`-doc-kommentar for full
    // begrunnelse).
    // D-388: valgfri team-kontekst (`teamId` på alle kall) via secret-kjeden.
    vercel: new VercelTransport(() => readSecretProvider.get("JARVIS_VERCEL_TEAM_ID")),
    // D-388 (JARVIS-061): ekte Home Assistant-transport - base-URL + romkart via secret-kjeden, token via credential_ref.
    "home-assistant": new HomeAssistantTransport(() => readSecretProvider.get("JARVIS_HA_BASE_URL"), () => readSecretProvider.get("JARVIS_HA_ROOMS")),
    // D-90 (UA-4 NESTE SLICE): Business OS × Marketing Memory-integrasjon -
    // `marketingMemoryBriefSource(growthService)` injiseres her (app-laget,
    // som allerede har BEGGE tjenestene) i stedet for at `@jarvis/business`
    // importerer `@jarvis/growth` direkte (ville vært sirkulært, se
    // `business-os-integration.ts`).
    business: new BusinessTransport(
      businessService, openLoopService, pool, toolGateway, scoringService,
      [marketingMemoryBriefSource(growthService)]
    ),
    // SAMME lazy-init-mønster som BusinessTransport sin `requireEventSync()`
    // (D-49): `SupportTransport` får `toolGateway` DIREKTE (objektreferansen
    // finnes allerede, selv om selve register()-loopen ikke er ferdig ennå) -
    // bygger `SupportEmailService` lat ved første `reply`/`ingest`-kall.
    support: new SupportTransport(supportService, businessService, toolGateway),
    contract: new AgreementsTransport(agreementsService),
    // UA-3 Native Jarvis Product Core (D-128): SAMME lat/enkel-avhengighet-
    // mønster som AgreementsTransport over (INGEN toolGateway/
    // ToolInvocationContext, ingen nøstet klasse D-handling).
    product: new ProductTransport(productService),
    // UA-3 Native Jarvis Operations Core (D-129): identisk wiring-mønster som ProductTransport over.
    operations: new OperationsTransport(operationsService),
    growth: new GrowthTransport(growthService),
    // UA-4 Google Ads-slice (D-83): SAMME lat/enkel-avhengighet-mønster som
    // GrowthTransport over - INGEN toolGateway/ToolInvocationContext (ingen
    // nøstet klasse D-handling i denne sliceen).
    googleads: new GoogleAdsTransport(growthService),
    // D-335 (UA-4 Meta Ads-slice): SAMME lat/enkel-avhengighet-mønster som
    // GoogleAdsTransport over - INGEN toolGateway/ToolInvocationContext.
    metaads: new MetaAdsTransport(growthService),
    // UA-6 Finance & Spend Integrity Gateway (D-107): SAMME lat/enkel-
    // avhengighet-mønster som GrowthTransport/GoogleAdsTransport over -
    // INGEN toolGateway/ToolInvocationContext (ingen nøstet klasse D-
    // handling i denne sliceen - `submit_payment_intent` sin klasse D er
    // selve handlingen, ikke en nøstet under-handling).
    finance: new FinanceTransport(financeService, fikenCredentialsProvider, financeReconciliation),
    // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): eget
    // `finance_spend.*`-namespace, SEPARAT fra `finance` over - SAMME
    // lat/enkel-avhengighet-mønster som GrowthTransport (INGEN
    // toolGateway/ToolInvocationContext, ingen provider-kall i dette
    // namespacet i det hele tatt).
    finance_spend: new SpendTransport(spendService),
    // D-109 (UA-6 Slice 3): eget `finance_stripe.*`-namespace, SEPARAT fra
    // `finance`/`finance_spend` over - SAMME lat/enkel-avhengighet-mønster
    // (INGEN toolGateway/ToolInvocationContext).
    finance_stripe: new StripeFinanceTransport(financeService),
    // D-110 (UA-6 Slice 4): eget `finance_vipps.*`-namespace - SAMME mønster.
    finance_vipps: new VippsFinanceTransport(financeService),
    // D-111 (UA-6 Slice 5): eget `finance_neonomics.*`-namespace - SAMME mønster.
    finance_neonomics: new NeonomicsFinanceTransport(bankingService, financeService),
    // D-112 (UA-6 Slice 6): eget `finance_wallester.*`-namespace - SAMME mønster.
    finance_wallester: new WallesterFinanceTransport(cardService),
    // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
    // Core - SAMME lat/enkel-avhengighet-mønster som GrowthTransport/
    // AgreementsTransport over (INGEN toolGateway/ToolInvocationContext,
    // ingen nøstet klasse D-handling).
    consent: new ConsentTransport(consentService, consentEnforcementService),
    // D-105 (UA-5 kriterium 1+3): egen Docker-transport - JARVIS_DOCKER_BIN
    // gater tilgjengelighet SAMME vei som ethvert annet credential_ref (se
    // docker-transport.ts) - uten den satt er "docker" strukturelt
    // credential_unavailable, ALDRI et stille fall til en ambient binærsti.
    docker: new DockerTransport(),
    // D-337 (Google Cloud "servere"-sliceen): SAMME lat/tom-konstruktør-
    // mønster som DockerTransport over - JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN
    // gater tilgjengelighet, JARVIS_GOOGLE_CLOUD_PROJECT_ID leses direkte
    // fra env (se gce-transport.ts).
    gce: new GceTransport(),
    // D-338 (MCP Zapier discovery-only sliceen): lat/tom-konstruktør - selve
    // URL-en (hemmelighets-ekvivalent) leses via credential_ref inni
    // ToolGateway sin secret-provider-kjede, ALDRI konstruktør-parameter
    // (se mcp-zapier-transport.ts).
    mcp_zapier: new McpZapierTransport(),
    // D-339 (Playwright-sliceen): lat/tom-konstruktør - selve base-URL-en
    // (ingen ekte hemmelighet, kun en konfigurert adresse til
    // apps/browser-gateway sin egen prosess) leses via credential_ref inni
    // ToolGateway sin secret-provider-kjede, ALDRI konstruktør-parameter
    // (se browser-transport.ts).
    browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? ""),
    // UA-7 Communications Hub - foerste slice (D-119): eget
    // `conversation_graph.*`-namespace. D-119 FINAL AUTHORITY HARDENING:
    // denne transporten MOTTAR og KREVER `ToolInvocationContext` (D-68) -
    // tenant/space avledes UTELUKKENDE fra den, aldri fra kallerparametre
    // (se `transport.ts` sitt filhode). Navnerommet er READ-ONLY via
    // ToolGateway (`merge_identities`/`split_merge`/`link_channel_identity`
    // alle fjernet - canonical mutasjon skjer kun via
    // `ConversationGraphSyncService`, direkte mot service-en).
    conversation_graph: new ConversationGraphTransport(conversationGraphService),
    ...driveTransportsIfConfigured()
  }, {
    // D-105 host-fix (D-41-korreksjon): eier-konfigurert produksjonsmål-
    // autorisasjon for docker-mutasjon - parset ÉN gang ved oppstart (samme
    // "les env her, tre inn i konstruktør/config"-mønster som resten av
    // denne funksjonen). Tom/ukonfigurert -> INGEN produksjonsmål autorisert
    // (fail-closed, se docker-target-policy.ts) - sentinel-mål (host-
    // akseptanse) er alltid tilgjengelig uavhengig av denne variabelen.
    dockerMutationTargets: parseDockerMutationTargets(process.env["JARVIS_DOCKER_MUTATION_TARGETS"]),
    // D-337: SAMME "les env ÉN gang ved oppstart, fail-closed hvis tom"-
    // mønster som dockerMutationTargets over - se gce-target-policy.ts.
    gceMutationTargets: parseGceMutationTargets(process.env["JARVIS_GCE_MUTATION_TARGETS"]),
    // UA-10 P1 (D-160): eierens kontrollflate for Situation Engine - se over.
    // UA-11 Executive Mode P0 (D-162): den SAMLEDE attention-ranking-/
    // kontrollflaten - komponerer `situations.*` via DENNE SAMME
    // `toolGateway`-instansen (nøstet `gateway.execute()`, ALDRI
    // `situationEngine`/`situationDomainPauses` direkte) - se
    // `@jarvis/executive` sitt filhode for hele begrunnelsen. Ren tilføyelse
    // på slutten av listen, SAMME ene register-løkke som resten av verktøyene.
    // K1 (Sovereign graduation, D-164): kanonisk owner_controls.*-flate over
    // DE SAMME `killSwitch`/`ownerControls`-instansene `policy`/`toolGateway`
    // selv bruker - IKKE en kopi. Registrert i SAMME liste/løkke som
    // `situations`/`executive`, ingen parallell registreringsvei.
    additionalTools: [
      // D-388 (JARVIS-061): Home Assistant-verktøyene (definert siden fase 9, aldri registrert) registreres nå med den
      // ekte transporten fra `transports`-recorden over - samme ene register-løkke som resten.
      ...homeAssistantTools(new HomeAssistantTransport(() => readSecretProvider.get("JARVIS_HA_BASE_URL"), () => readSecretProvider.get("JARVIS_HA_ROOMS"))),
      ...situationsToolDefinitions(new SituationsTransport(situationEngine, situationDomainPauses)),
      // WP-H2: tjenesten legger seg i `executiveRef` (`holder`) så Drift-/Verdi-sentrene kan lese rapportene dens (late funksjoner over); `run_golden_suite` og `revoke_autonomy_binding` registreres KUN med sine flagg.
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(toolGateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES, ...CHAT_READ_TIER, ...CHAT_ACT_TIER],
        selfModel: {
          readers: selfModelReaders,
          limitations: {
            forbiddenModelToolIds: FORBIDDEN_MODEL_TOOL_IDS,
            connectors: CONNECTOR_REGISTRY.map((c) => ({ id: c.id, category: c.category, test_method: c.live_test ? "live" : "presence_only" })),
            // WP-G3 (review A-L3): begrensningsregisteret (self-model) får `local_vision` KUN når adapteren er registrert - ellers er listen identisk med main.
            modelProfiles: visionAdapter !== null ? PROFILES_WITH_LOCAL_VISION : DEFAULT_PROFILES,
            allModelCapabilities: ["text", "reasoning", "vision", "tool_calling", "structured_output", "streaming"],
            backupStatusReadable: backupStatusSource !== undefined
          }
        },
        slo: { report: sloReports },
        // WP-C3 (Q-45 b): autentiseringsmetode (pat/app, installasjons-id, utløp, repo-scope, rettigheter) i get_connector_status - aldri tokenverdier.
        connectorAuth: (connectorId) => (connectorId === "github" ? githubAuth.connectorAuthInfo() : undefined),
        evolution: { report: evolutionReports },
        aiMesh: { report: aiMeshReports },
        // WP-E1 (UA-5, JARVIS-068): driftsstatus - åpne hendelser (fase/alvorlighet/sannhetsmerking), skymål (helse + siste journalførte endring) og produsentenes helse. Kun lesing under RLS, ingen hemmeligheter.
        infra: {
          source: createInfraStatusSource(pool), producers_enabled: incidentProducerConfig.enabled, producers_interval_ms: incidentProducerConfig.intervalMs,
          producer_names: INCIDENT_PRODUCER_NAMES, mode: async () => (await infraGate.statusDurable()).state.mode
        },
        controlCenters,
        // Gjennomgang M2: finansdata er SECRET_RESTRICTED (D-378) - en SKYmodell får aldri finans-senteret (holdes tilbake ved utførelse i executive-transporten, uansett hvilke verktøy turens utvalg valgte); en lokal modell
        // og siden får det. Lokalitet kommer fra leverandørregisteret (SAMME `servedByCloudModel` som chattens verktøyskjerm); ukjent leverandør regnes som sky (fail-closed).
        servedLocally: (model) => !servedByCloudModel({ provider: model.provider }),
        // WP-H0 (JARVIS-087): kontrollsenterets avbryt-handling bruker den EKSISTERENDE kanselleringsveien (samme `taskService` som chatens «avbryt jobb <id>»).
        tasks: { cancel: (identity, taskId) => taskService.cancel(identity, taskId) },
        // WP-C4: Value Center - kilde (aggregater under RLS) + kjøretidsfakta (flagg, EV-0, kill switch, erklærte porter). Ingen innhold, ingen skriving; V3/V5 er sovende og kan aldri aktiveres herfra.
        value: {
          source: valueSource,
          facts: () => buildValueRuntimeFacts({
            env: process.env, push: v2PushPolicy, deliveryConfigured: () => telegramDeliveryConfigured, ev0Status: () => getLastEv0BootStatus(),
            killSwitchActive: async () => (await selfModelControls.getControlState()).kill_switch.active
          })
        },
        ...(goldenSuiteRunner ? { goldenSuite: goldenSuiteRunner } : {}),
        // WP-H2 (gjennomgang L1): før-bildet av en autonomi-binding skrives og committes i revisjonssporet FØR `revoke_autonomy_binding` sletter den (kun brukt når verktøyet er registrert, JARVIS_CONTROL_AUTONOMY_REVOKE=on).
        autonomyAudit: createAutonomyAudit(pool),
        // WP-B3 (D-475, EV-23): skriveren (kun revisjonssporet; aldri endringsregisteret) finnes KUN når avgjørelsesverktøyet er registrert.
        ...(evolutionApprovalOn ? { evolutionDecisions: createEvolutionDecisionRecorder(pool) } : {}),
        holder: executiveRef
      })), {
        // WP-H1/H2 (gjennomgang M1): per-senter lese-verktøyene (`get_<senter>_center`) registreres KUN for sentrene hvis flagg er på - flagg AV er identisk med main (ingen verktøy, ingen utvalgstreff, ingen rate-endring).
        // Gjennomgang L5: OG som faktisk er registrert i registeret (en slått-på flagg uten sine avhengigheter gir et uregistrert senter) - et verktøy for et senter som ikke finnes skal aldri listes som tilgjengelig (`get_capability_status`).
        controlCenters: controlCentersWithTools(process.env, controlCenters),
        // WP-H2 (M1): `run_golden_suite` og `revoke_autonomy_binding` registreres KUN med sine egne flagg (uten flagg finnes verktøyene ikke - og `/executive/mutate` godtar ikke navnene, se `server.ts`).
        goldenSuite: goldenSuiteRunner !== undefined,
        autonomyRevoke: flagOn(process.env, CONTROL_FEATURE_FLAGS.autonomyRevoke),
        // WP-B3 (D-475, EV-23): `record_evolution_decision` registreres kun med eget flagg + Evolusjon-senteret (se `evolutionApprovalOn`).
        evolutionApproval: evolutionApprovalOn
      }),
      // D-174 (B2): tredje konstruktør-argument kobler `owner_controls.revoke_device`
      // til DEN SAMME `pool`/`grantService`/`ownerControlAuthority` som resten
      // av eier-autoritets-/session-grant-mønstrene i denne filen - IKKE en ny,
      // parallell tilstand. Se `OwnerControlsService.revokeDevice()` sitt filhode.
      // Task #122 (D-213): andre konstruktør-argument - DEN SAMME `toolGateway`-
      // instansen (allerede konstruert over) - kobler `set_connector_credential`/
      // `test_connector` til `ToolGateway.setSecret()`/nøstet `execute()`.
      // Gjennomgang av PR #316 (L-5): `createOwnerControlsService` kobler alltid frys-validatoren (`model:<leverandør>` valideres mot modellregisteret ved frysing, ellers «Utført» uten pause).
      ...ownerControlsToolDefinitions(new OwnerControlsTransport(createOwnerControlsService(killSwitch, ownerControls, {
        pool,
        grants: grantService,
        devices: new DeviceService(pool),
        authority: ownerControlAuthority
      }), toolGateway, (process.env["JARVIS_DESTINATION_HOST_ALLOWLIST"] ?? "").split(",").map((h) => h.trim()).filter((h) => h.length > 0))),
      // UA-11 Executive Mode "K2" (D-64): decision log/scenarios/risk register/
      // goals-OKRs - RENE journalposter over DEN SAMME `pool`-instansen som
      // resten av denne filen (`withMemoryTransaction`, se `GovernanceService`
      // sitt filhode) - IKKE en parallell tilkobling. Registrert i SAMME
      // liste/løkke som `situations`/`executive`/`owner_controls`.
      // WP-H1 (JARVIS-087 del 2): proveniens (kanal/sesjon/jobb/opphav) på nye journalrader - AV som standard, kun den eksakte verdien «on» slår det på.
      ...governanceToolDefinitions(new GovernanceTransport(new GovernanceService(pool), { recordProvenance: process.env["JARVIS_GOVERNANCE_PROVENANCE"] === "on" })),
      // Task #118 ("Charlie"-minne-verifisering): `memory.search` over DEN
      // SAMME `memoryRetriever`-instansen `conversationEngine` under gjenbruker
      // for bakgrunnskontekst - se `memoryRetriever` sin egen filhode-kommentar
      // lenger opp for hvorfor den ble hevet ut hit.
      ...memoryToolDefinitions(new MemorySearchTransport(memoryRetriever, memoryWriter)),
      // WP-D1 (UA-2): `knowledge.search` over `knowledgeRetriever` (tenant-/space-skopet via RLS som app-rolle; treffene bærer strukturerte sensitivitetsmerker for skyskjermen) og
      // `knowledge.get_claim_status` (Q-26: kildeverifiseringsstatus, ren lesing). Skrive-handlingene i kildeverifiseringen (registrer/evidens/tilbaketrekking/promotering som FORSLAG til karantenen)
      // finnes KUN med JARVIS_KNOWLEDGE_CLAIM_WRITES=on, og står uansett på ingen modellflate.
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport(knowledgeRetriever, knowledgeClaims), { claimWrites: knowledgeClaimWrites }),
      // D-416: delegeringsnivået (opprett lesende bakgrunnsjobb / les jobbstatus) over SAMME `taskService` (policy + kontraktsregler).
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport(taskService, chatJobs)),
      // D-421 (UA0-RUNRATE): run-rate og connector maintenance ledger (kun lesing for modellen; skriving via dashbord-ruten).
      ...runRateToolDefinitions(new RunRateTransport(new RunRateService(pool))),
      // WP-E1 (UA-5): de kontrollerte skymålene (Cloudflare nå; Langfuse/Infisical/Postgres-drift legges til i samme fabrikk). SOVENDE uten credential;
      // skriving krever sone i JARVIS_CLOUDFLARE_MUTATION_ZONES (kun på verten) og går alltid gjennom klasse D-kjeden + InfraExecutionGate.
      ...cloudControlToolDefinitions(
        {
          cloudflare: new CloudflareTransport({ accountId: () => readSecretProvider.get("JARVIS_CLOUDFLARE_ACCOUNT_ID") }),
          // Langfuse/Infisical/Postgres-drift: basis-URL, klient-id, prosjekt og miljø er ikke-hemmelig VERTSKONFIG (aldri modellstyrt, aldri dashbord-redigerbar);
          // selve hemmelighetene (secret key / klient-hemmelighet / ops-tilkoblingsstreng) hentes av ToolGateway via credential_ref og når bare transporten.
          langfuse: new LangfuseTransport({ baseUrl: async () => process.env["LANGFUSE_BASE_URL"] ?? null, publicKey: async () => process.env["LANGFUSE_PUBLIC_KEY"] ?? null }),
          infisical: new InfisicalTransport({
            baseUrl: async () => process.env["INFISICAL_URL"] ?? null, clientId: async () => process.env["INFISICAL_CLIENT_ID"] ?? null,
            projectId: async () => process.env["INFISICAL_PROJECT_ID"] ?? null, environment: async () => process.env["INFISICAL_ENV"] || "dev"
          }),
          postgres_ops: new PostgresOpsTransport({ config: postgresOpsConfig })
        },
        { cloudflareMutationZones: parseCloudflareMutationZones(process.env["JARVIS_CLOUDFLARE_MUTATION_ZONES"]), postgresOps: postgresOpsConfig, infisicalRotationIds: parseInfisicalRotationIds(process.env["JARVIS_INFISICAL_ROTATION_IDS"]) }
      ),
      // WP-D3 (UA-4 Growth): kun med flaggene på (se over). Eier-eksklusive navnerom (`growth_*`) som aldri står på en modellflate; skriving går alltid gjennom step-up + klasse D-kjeden.
      ...(growthWriteEnabled ? growthWriteToolDefinitions(growthWriteConfig, growthWriteTransports) : []),
      ...(growthExperimentRegistry ? growthExperimentToolDefinitions(new GrowthExperimentTransport(growthExperimentRegistry)) : [])
    ]
  })) toolGateway.register(tool);
  // REMEDIERING DEL 1 (JARVIS-002): `allMeshTools()` (hele registeret) er IKKE
  // lenger koblet til noen aktiv flate. Chat, tale, Telegram og executive-jobber
  // får KUN det eksplisitte lese-minimumssettet (`MODEL_SURFACE_ALLOWLIST`);
  // oppstarten feiler lukket hvis noe i flaten ikke er klasse A / ren lesing.
  const modelToolSurface = resolveModelToolSurface(toolGateway, { includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });
  // D-404: hvilke tjenester Charlie FAKTISK får i katalogen per flate (kun navn - ingen innhold). Eier meldte at han «bare har to verktøy»;
  // da kan loggen vise om katalogen eller modellens lesning var feil.
  for (const surface of ["web_chat", "voice"] as const) {
    console.log(JSON.stringify({ msg: "chat_tool_catalog", surface, services: describeSurfaceCatalog(modelToolSurface, surface).services.map((s) => s.tool_id) }));
  }
  // Del 3: sentralt manifest avledet fra ALLE registrerte handlinger. Bruddet er en oppstartsfeil (fail closed): ingen modellflate med
  // send/pay/delete/control, ingen klasse B/A for utgående handlinger, ingen eier-eksklusive navnerom på en flate.
  const toolManifest = buildToolManifest(toolGateway.list());
  assertManifestInvariants(toolManifest);
  const confirmationStore = new ConfirmationStore(pool);
  // WP-D4 (JARVIS-078): rådets forslagsvei - AV som standard (`JARVIS_COUNCIL_PROPOSALS=on` slår den på). Porten har ingen eksekutor: den velger kun ut hvilke handlinger rådet kan foreslå og legger et gyldig forslag frem som en
  // PENDING bekreftelse i den eksisterende veien; utførelsen skjer først når eieren godkjenner kortet via /confirmations.
  const councilProposalsEnabled = parseCouncilProposals(process.env["JARVIS_COUNCIL_PROPOSALS"]);
  const councilProposalGate = councilProposalsEnabled
    ? new CouncilProposalGate({ mappings: modelToolSurface, manifest: toolManifest, definitions: toolGateway.list(), confirmations: confirmationStore })
    : undefined;
  console.log(JSON.stringify({ msg: "council_proposals", enabled: councilProposalsEnabled }));
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans (allerede
  // registrert med Gmail/Calendar over) - ingen ny transport-vei.
  const businessEventSyncService = new BusinessEventSyncService(toolGateway, businessService, openLoopService);
  // UA-7 Communications Hub - foerste slice (D-119): SAMME toolGateway-
  // instans (allerede registrert med Gmail over) - ingen ny transport-vei,
  // gjenbruker DENNE toolGateway-instansens `email.list_messages` (den
  // SAMME motpart-e-post-utledningen som businessEventSyncService, kun i en
  // egen, tynn synk-tjeneste for å unngå en sirkulær pakkeavhengighet - se
  // `@jarvis/conversation-graph` sin `sync.ts`).
  const conversationGraphSyncService = new ConversationGraphSyncService(toolGateway, businessService, conversationGraphService);
  // UA-3 Native Jarvis Support Core (D-66) §7/§24: egen instans for den
  // periodiske innboks-sveipen (SAMME mønster som `businessEventSyncService`
  // over - en direkte, parallell instans, IKKE den lazy interne i
  // SupportTransport) - SAMME toolGateway/businessService, ingen ny transport-vei.
  const supportEmailService = new SupportEmailService(toolGateway, businessService, supportService);
  // D-433 (JARVIS-025, valg B - Tobias 2026-10-07): WORKER-containeren eier `executive`-køen. Tidligere tømte begge prosessene den med ulikt verktøysett
  // og ulik identitet, så en bakgrunnsjobb oppførte seg ulikt etter hvem som vant kø-racet - og agentkjøring delte prosess med chatten. API-et
  // registrerer derfor IKKE lenger handleren (en worker uten handler claimer ingenting). `JARVIS_API_DRAINS_EXECUTIVE=true` er en nød-/utviklingsbryter
  // for oppsett UTEN worker-container (da kjører jobbene i API-prosessen som før).
  // D-431: verktøyturer til skymodell (standard Sonnet 5.5), ren prat lokalt. `JARVIS_TOOL_TURN_MODEL=off` slår det av.
  // D-449 (Q-50): samme rute og samme dagstak gjelder delegerte bakgrunnsjobber med verktøy (executive-handleren under, og i worker-main.ts).
  const toolTurnRoute = parseToolTurnRoute(process.env["JARVIS_TOOL_TURN_MODEL"]);
  // D-432: dagstak for verktøyturer til sky (standard 30 kr; 0 = ingen tak). Over taket går verktøyturer lokalt med en synlig merknad.
  const toolTurnDailyCapOre = parseDailyCapOre(process.env["JARVIS_TOOL_TURN_DAILY_CAP_ORE"]);
  // D-449: delegerte jobber følger chattens rute med mindre `JARVIS_JOB_TOOL_TURN_MODEL` sier noe annet (`off` = jobber lokalt, chatten urørt).
  const jobToolTurnRoute = resolveJobToolTurnRoute(process.env["JARVIS_JOB_TOOL_TURN_MODEL"], toolTurnRoute);
  const executiveOwner = executiveQueueOwner(process.env);
  const apiDrainsExecutive = executiveOwner === "api";
  console.log(JSON.stringify({ msg: "executive_queue_owner", owner: executiveOwner }));
  if (apiDrainsExecutive) worker.register(
    "executive",
    executiveHandler({
      gateway,
      toolTurnRoute: jobToolTurnRoute,
      toolTurnDayCap: jobToolTurnRoute !== null && toolTurnDailyCapOre > 0 ? { cap_ore: toolTurnDailyCapOre, spentToday: (tenantId) => dailySpentOre(pool, tenantId) } : null,
      tools: {
        all: modelToolSurface,
        // D-351: 4000 → 20_000 (se mesh-bridge.ts sitt filhode for host-målt begrunnelse).
        // Del 3 (JARVIS-005/012): per-jobb identitet fra den signerte kontrakten + bakgrunnsflate + kontrakten håndhevet i gatewayen.
        executorFor: (task, allowed) => new MeshToolExecutor(
          toolGateway, jobIdentityFor(ownerIdentity, task.contract), 20_000, [...allowed],
          createTurnContext("background", String((task.contract.input.data as { prompt?: unknown })["prompt"] ?? "")),
          { manifest: toolManifest, confirmations: confirmationStore, jobContract: task.contract }
        )
      }
    })
  );

  // D-123 (Q-32 punkt 2): ÉN delt instans av hver identitetsprimitiv.
  // `DeviceService` holder utstedte challenges in-memory, så en egen instans
  // til voice-autoriteten ville aldri gjenkjent en nonce utstedt av
  // `/devices/challenge` - to instanser er her en STILLE funksjonsfeil, ikke
  // bare uryddig. Samme delings-disiplin som D-102 sin `taskService`.
  const identityService = new IdentityService(pool);
  const deviceService = new DeviceService(pool);
  const sessionService = new SessionService(pool);
  // D-131 (uavhengig arkitektkontroll av PR #79): SAMME delings-disiplin som
  // over. `SessionGrantService` eier `session_grants` - det avgrensede,
  // revokerbare autorisasjonsbeviset som erstatter «rå session_id = autentisert
  // enhet» - og `DeviceEnrollmentService` er den ENESTE nettverksnære veien til
  // å skrive nytt enhetsnøkkelmateriale. `grantService` er nå hoistet lenger
  // opp (D-174, B2) - gjenbrukt uendret her, ALDRI en duplikat konstruksjon.
  const enrollmentService = new DeviceEnrollmentService({
    pool,
    devices: deviceService,
    grants: grantService
  });
  // Autoritetene eier sin egen transaksjon (D-131 funn 3: hele autorisasjonen
  // må kunne rulles tilbake ved avslag), og trenger derfor SAMME pool som
  // tjenestene de komponerer.
  const authorityDeps = {
    pool,
    devices: deviceService,
    sessions: sessionService,
    identity: identityService,
    grants: grantService
  };
  // D-125 (UA-7, FEMTE slice): ÉN delt `ConversationEngine`-instans. Den er
  // hevet ut av `deps`-literalen fordi den inngående Telegram-banen skal bruke
  // NØYAKTIG samme motor som `/chat` - ikke en parallell konstruksjon (samme
  // delings-disiplin som D-102 sin `taskService` og D-123 sine identitets-
  // primitiver). To instanser ville gitt to separate verktøy-/trace-oppsett
  // mot samme pool, altså en stille divergens mellom kanalene.
  // D-431/D-432: ruten og dagstaket er parset tidlig (rett før executive-handleren, D-449) og brukes her uendret.
  console.log(JSON.stringify({ msg: "tool_turn_route", route: toolTurnRoute ? `${toolTurnRoute.provider}:${toolTurnRoute.model}` : "off", daily_cap_ore: toolTurnDailyCapOre }));
  // WP-D4 (JARVIS-033): kandidatkjeden for vanlig prat. Tom/usatt = som før (`gemma_local, gemma_hosted`, siste reserve på). Navn som ikke er en registrert leverandør er inerte - logges så en skrivefeil ikke gjemmer seg.
  const chatCandidates = parseChatCandidates(process.env["JARVIS_CHAT_CANDIDATES"], process.env["JARVIS_CHAT_AUTO_FALLBACK"]);
  console.log(JSON.stringify({ msg: "chat_candidates", chain: chatCandidates.chain, auto_fallback: chatCandidates.autoFallback, source: chatCandidates.source, unknown_members: unknownChainMembers(chatCandidates.chain, gateway.listProviderNames()) }));
  const conversationEngine = new ConversationEngine({
    councilAutoLimiter,
    messages: new MessageStore(pool),
    context: new ContextBuilder(pool),
    gateway,
    tasks: taskService,
    worker,
    trace,
    toolTurnRoute,
    toolTurnDayCap: toolTurnRoute !== null && toolTurnDailyCapOre > 0 ? { cap_ore: toolTurnDailyCapOre, spentToday: (tenantId) => dailySpentOre(pool, tenantId) } : null,
    chatCandidates,
    // EV-1 (D-412): hurtigbanens selvdiagnose går gjennom Tool Gateway (Policy + revisjon) - samme verktøy som modellen kan kalle.
    selfDiagnosis: {
      async run(identity, opts) {
        const result = await toolGateway.execute({ identity, tool_id: "executive", action: "get_self_diagnosis", parameters: {} });
        if (!result.ok || result.data === undefined) return null;
        return renderSelfDiagnosisNo(result.data as unknown as SelfDiagnosis, opts.brief ? { maxFindings: 3 } : { maxFindings: 10, includeLimitations: true });
      }
    },
    // EV-2 (D-417): hurtigbanens «hvor bra yter du» går gjennom Tool Gateway (Policy + revisjon) - samme verktøy som modellen kan kalle.
    sloReport: {
      async run(identity) {
        const result = await toolGateway.execute({ identity, tool_id: "executive", action: "get_slo_report", parameters: {} });
        const text = result.ok ? (result.data as { summary_no?: unknown } | undefined)?.summary_no : undefined;
        return typeof text === "string" ? text : null;
      }
    },
    // WP-B (D-452): hurtigbanens «hvordan utvikler du deg» går gjennom Tool Gateway (Policy + revisjon) - samme verktøy modellen kan kalle.
    evolutionReport: {
      async run(identity) {
        const result = await toolGateway.execute({ identity, tool_id: "executive", action: "get_evolution_report", parameters: {} });
        const text = result.ok ? (result.data as { summary_no?: unknown } | undefined)?.summary_no : undefined;
        return typeof text === "string" ? text : null;
      }
    },
    // WP-C4: hurtigbanens «hva har du hjulpet meg med» går gjennom Tool Gateway (Policy + revisjon) - samme verktøy modellen kan kalle (`executive.get_value_report`, klasse A).
    valueReport: {
      async run(identity) {
        const result = await toolGateway.execute({ identity, tool_id: "executive", action: "get_value_report", parameters: {} });
        const text = result.ok ? (result.data as { summary_no?: unknown } | undefined)?.summary_no : undefined;
        return typeof text === "string" ? text : null;
      }
    },
    // D-424: hurtigbanens «hva koster du» og «… i bakgrunnen» går gjennom Tool Gateway (Policy + revisjon) - samme verktøy modellen kan kalle.
    costReport: {
      async run(identity) {
        const result = await toolGateway.execute({ identity, tool_id: "run_rate", action: "get_cost_overview", parameters: {} });
        const text = result.ok ? (result.data as { summary_no?: unknown } | undefined)?.summary_no : undefined;
        return typeof text === "string" ? text : null;
      }
    },
    delegateBackground: {
      async run(identity, prompt, options) {
        const title = (prompt.split("\n")[0] ?? prompt).replace(/\s+/g, " ").trim().slice(0, 70).padEnd(3, ".");
        const result = await toolGateway.execute({
          identity, tool_id: "tasks", action: "delegate_background_task", parameters: { title, prompt: prompt.slice(0, 2000), use_tools: true },
          idempotency_key: `fast-delegate:${identity.session_id}:${Date.now()}`,
          // D-449 (Q-50): hurtigbanen bruker ingen modell - oppgaveteksten ER eierens egne ord (ordrett). Eneste sted `contentOrigin` settes, og KUN når samtalemotoren har avgjort at chatten ville latt en
          // verktøytur gå til sky (eierens ruteoverstyring, de siste meldingene, minnerom og innlimt tekst, se `delegationCloudDecision`). Uten merket (eller `servingModel`) kjører jobben lokalt.
          ...(options?.cloudAllowed === true ? { contentOrigin: "owner_direct" as const } : {})
        });
        if (!result.ok) return null;
        const data = result.data as { started?: unknown; message?: unknown; cloud_tool_turns?: unknown } | undefined;
        // `started` skiller en faktisk startet jobb fra en forklaring («for mange aktive jobber»): kun en startet jobb får merknaden om at den kjører lokalt.
        // `cloud` = om transporten FAKTISK ga jobben skyflagget (den kontrollerer jobbteksten selv, også når motoren sa ja) - kun eksplisitt `true` teller (fail-closed).
        return data?.started === true
          ? { started: true, reply: `Jobben «${title}» er startet i bakgrunnen. Jeg gir beskjed her når den er ferdig - du kan fortsette å snakke med meg.`, cloud: data.cloud_tool_turns === true }
          : typeof data?.message === "string" ? { started: false, reply: data.message, cloud: false } : null;
      }
    },
    memory: {
      contextFor: (identity, userText) => memoryRetriever.contextFor(identity, userText),
      // D-384: minnets rom/sensitivitet må følge med til ruteren (helse/special ⇒ kun lokal modell) - uten dette ble det aldri klassifisert.
      contextWithMeta: (identity, userText, options) => memoryRetriever.contextWithMeta(identity, userText, options),
      // D-283: eierens EGNE ord i denne samtalen (chat OG tale - BEGGE går
      // via SAMME `/chat`, se D-30-kommentaren ved `tools` under) skrives nå
      // faktisk til minnet, IKKE lenger en ren lesestruktur. `trust:
      // "trusted"` - eieren som snakker DIREKTE til Jarvis er den høyeste
      // tillitskilden i systemet, STRUKTURELT forskjellig fra §7 sin
      // Ingestion Zone-karantene (den gjelder UBETRODD/EKSTERNT innhold -
      // e-post/web/verktøyoutput/MCP - ALDRI eierens egne ytringer til
      // Jarvis selv). `ref: identity.session_id` tagger kilden med
      // sesjonen (rule 4: "kilde og task_id/session_id"). Feil her
      // SVELGES av kalleren (`conversation.ts` sin `.catch()`) - en
      // minnefeil skal ALDRI ødelegge selve samtalesvaret.
      ingest: (identity, text, opts) =>
        memoryWriter.ingestText(
          identity,
          // Del 3 (JARVIS-013): innlimt/lang tekst er ikke eierens egne ord -> untrusted (karantene), ikke aktivt betrodd minne.
          { kind: "conversation", ref: identity.session_id, trust: opts?.pasted ? "untrusted" : "trusted" },
          text,
          // D-386: foregående turer som DATA til uttrekket (pronomen/svar på spørsmål) + kanal på episoden.
          { ...(opts?.recent_turns ? { recent_turns: opts.recent_turns } : {}), channel: identity.channel }
        )
    },
    council: aiCouncil,
    ...(councilProposalGate
      ? { councilProposals: { actionsFor: (input) => councilProposalGate.actionsFor(input), submit: (identity, surface, proposal) => councilProposalGate.submit(identity, surface, proposal) } }
      : {}),
    // D-30 live-funn: samtalebanen (tekst + voice via /chat) har verktøykall.
    // REMEDIERING DEL 1 (JARVIS-002/JARVIS-035): kun det eksplisitte lese-
    // minimumssettet. `delegate_code_task` (nøstet sky-kall med hardkodet
    // PUBLIC-sensitivitet som omgår `paid_models_allowed`/policy, D-354/D-355)
    // er FRYST av flaten inntil en senere remedieringsfase har gjort
    // delegeringen policy-/budsjettstyrt. Executor bindes til samtalens
    // RESOLVED identity (aldri ownerIdentity) - autorisasjon/D-pipeline/audit
    // håndheves uendret per kall i ToolGateway.
    tools: {
      definitions: modelToolSurface.map((t) => t.def),
      // D-351: 4000 → 20_000 (se mesh-bridge.ts sitt filhode for host-målt begrunnelse).
      // D-369: eierens rå melding i turen (kun fra grant-autentisert chat) gir den deterministiske «uttrykkelig be om å huske»-sjekken;
      // `JARVIS_MEMORY_AUTO_APPROVE=false` slår auto-godkjenning av eier-uttrykte minner av (da går ALT via karantene).
      // Del 3 (JARVIS-002/014/028): turen bærer flate + taint + grenser; executoren håndhever flate-allowlist, kallgrenser og taint-porten
      // (bundne bekreftelser) i deterministisk kode. Modellen ser kun relevante verktøy per flate/intensjon (`select`), ikke hele settet.
      executorFor: (identity, turn) => new MeshToolExecutor(
        toolGateway, identity, 20_000, modelToolSurface,
        turn && process.env["JARVIS_MEMORY_AUTO_APPROVE"] === "false" ? { ...turn, user_message: "" } : turn,
        { manifest: toolManifest, confirmations: confirmationStore }
      ),
      // D-383: Charlie vet alltid hvilke tjenester som finnes på flaten (ikke bare de skjemaene som er vedlagt denne runden).
      catalog: (surface) => describeSurfaceCatalog(modelToolSurface, surface).text,
      select: ({ surface, text, recent_owner_messages }) => {
        // D-389: eierens forrige meldinger gir kontekst til utvalget (oppfølgingsspørsmål beholder tjenesten).
        const selection = selectSurfaceTools(surface, text, modelToolSurface, { recent_owner_messages: recent_owner_messages ?? [] });
        return {
          definitions: selection.selected.map((m) => m.def),
          limits: selection.limits,
          // Q-53 A (D-450): tjenesten (`tool_id`) til hver valgte definisjon - samtalemotoren avgjør «kun minne-reserven» strukturelt av dette (ikke av verktøynavn).
          tool_ids: selection.selected.map((m) => m.tool_id),
          ...(selection.min_sensitivity ? { min_sensitivity: selection.min_sensitivity } : {})
        };
      }
    },
    // Task #121 (D-214): kosmetisk personlighetslag, se conversation.ts sin
    // `buildSystemPrompt()`/`loadPersonality()`.
    personality: loadPersonalityConfig
  });
  // WP-G3 (D-465): UA-9-kjøretiden (pipeline, HA-poller, `/vision/*`-rutene, vedlikehold). `null` (ingenting bygget) uten JARVIS_VISION_ENABLED=on. Se vision-runtime.ts for flaggene.
  const visionRuntime = buildVisionRuntime({
    pool, env: process.env, vision: visionService, gateway, memoryEmbedding, devices: deviceRegistry, ownerTenantId: owner.tenant_id, secrets: readSecretProvider,
    ownerControls: { killSwitch, controls: ownerControls }, embeddingBlockedReason: visionEndpoints.embeddingBlockedReason
  });
  const deps: ApiDeps = {
    // D-393 (JARVIS-026): `/health` svarer 503 når databasen ikke svarer (tidligere konstant «ok»).
    readiness: makeReadiness({ database: () => pool.query("SELECT 1") }),
    // Del 2 (JARVIS-065): den validerte eier-identiteten fyller visningsfeltene i /chat, /dashboard og /voice
    // (aldri autoritet - den kommer fra et verifisert grant). Uten denne svarer sidene 503 `owner_not_configured`.
    owner: { tenant_id: owner.tenant_id, person_id: owner.owner_person_id },
    // WP-E1 review (M3): eier-porten for incident-livssyklus, reparasjon, driftsoversikt og skymutasjoner = DET SAMME predikatet som kontrollsentrene (`ownerPredicate`), bygget fra DEN SAMME `ownerAuthority`
    // som Policy Gateway. Ingen egen sammenligning her - uten verdien nektes alle (`owner_required`).
    ownerGate: ownerPredicate(ownerAuthority),
    identity: identityService,
    devices: deviceService,
    grants: grantService,
    enrollment: enrollmentService,
    voiceAuthority: new VoiceSessionAuthority(authorityDeps),
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: SAMME delte instanser som
    // `voiceAuthority` over (D-123-delingsdisiplinen - `DeviceService` holder
    // utstedte challenges in-memory, så en egen instans her ville aldri
    // gjenkjent en nonce utstedt av `/devices/challenge`/`/session/authorize`).
    channelAuthority: new ChannelSessionAuthority(authorityDeps),
    brief: {
      generate: (identity) => dailyBrief.generate(identity as never),
      render: (artifact) => DailyBrief.render(artifact as never)
    },
    sessions: sessionService,
    policy,
    worker,
    tasks: taskService,
    incidents: {
      service: incidentService, deployments: deploymentService, diagnosis: diagnosisService,
      gateway: toolGateway, controls: ownerControls, infraGate, pool
    },
    // D-109 (UA-6 Slice 3): eksponerer FinanceService for `/webhooks/stripe`-
    // ruten i server.ts - webhook-ingestion krever rå (usignert-parset) body
    // og skjer derfor UTENFOR den generiske `readBody()`-JSON-parseren, se
    // server.ts sin nye rute-gren.
    finance: { service: financeService, cards: cardService },
    conversation: conversationEngine,
    // D-199 (UA-11 Executive dashboard-UI, lese-delen): SAMME toolGateway-
    // instans som resten av deps over (incidents.gateway osv.) - `/executive/
    // query` i server.ts begrenser seg selv til et hardkodet lese-kun
    // allowlist, ingen ny autorisasjonsmekanisme her.
    executive: { gateway: toolGateway },
    confirmations: confirmationStore,
    chatJobs,
    // WP-D2 (JARVIS-044/Q-48): eier-ruten for å opprette en bedrifts-tenant er AV som standard - kun eksakt `true` åpner den (ellers 404). Ingenting provisjoneres automatisk.
    ...(process.env["JARVIS_BUSINESS_TENANT_PROVISIONING"] === "true" ? { businessTenants: { pool } } : {}),
    // WP-G3 (D-465): `/vision/*` finnes KUN med JARVIS_VISION_ENABLED=on (ellers 404, identisk med main).
    ...(visionRuntime !== null ? { vision: visionRuntime.api } : {}),
    // WP-D2 (UA-3 «churn/product usage»): produktbruk-webhooken er AV som standard - ruten finnes først når eieren har satt JARVIS_PRODUCT_USAGE_TENANT_ID (en bedrifts-tenant;
    // tjenesten avviser alt annet). Hemmeligheten leses ved HVERT kall via den delte kjeden (Infisical-primær, .env-fallback), slik at rotasjon gjelder umiddelbart; er den
    // borte eller kortere enn 32 tegn svarer ruten 503 (fail closed).
    // WP-D3 (UA-4 Growth): eier-rutene `/growth/*` finnes KUN når skriving (plattformliste) eller eksperimenter er slått på; ellers 404 (identisk med main).
    ...(growthWriteEnabled || growthExperimentsEnabled
      ? {
          growthWrites: {
            executor: {
              pool, gateway: toolGateway, journal: new GrowthWriteJournal(pool), index: growthOpIndex(growthWriteSpecs(growthWriteConfig)),
              findCampaign: (tenantId, space, channel, externalId) => growthService.findCampaignByExternalId(tenantId, space, channel, externalId)
            },
            // Review INFO: skrive-/lese-/journalrutene finnes KUN med minst én plattform (kun `JARVIS_GROWTH_EXPERIMENTS=on` gir bare eksperimentruten; de øvrige gir 404).
            writes: growthWriteEnabled, experiments: growthExperimentsEnabled
          }
        }
      : {}),
    ...(process.env["JARVIS_PRODUCT_USAGE_TENANT_ID"]
      ? {
          productUsage: {
            service: new ProductUsageService(pool, {
              webhookSecretProvider: async () => (await readSecretProvider.get("JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET")) ?? null,
              tenantResolver: () => process.env["JARVIS_PRODUCT_USAGE_TENANT_ID"] ?? null
            })
          }
        }
      : {})
  };
  // D-416: lever ferdige bakgrunnsjobber tilbake til samtalen (nøyaktig én gang). Feil logges, stopper aldri prosessen.
  setInterval(
    () => void chatJobs.sweepDeliveries(ownerIdentity as never).catch((err) => console.error(JSON.stringify({ msg: "chat_job_sweep_error", error: (err as Error).message }))),
    15_000
  ).unref();
  // D-196: samme drain-løkke som worker-main.ts (linje ~486) - MEN den
  // logget ALDRI en `tick()`-feil her (feil under selve claim/complete/fail-
  // kallene mot DB, ikke en per-oppgave-handler-feil - de er allerede
  // sikkert isolert inne i `InProcessWorker.tick()` og skrevet til
  // `queue.fail()`). En slik feil ville stille stanset denne prosessens
  // "executive"-oppgavekø (ConversationEngine sin `tasks.create()`-vei) UTEN
  // noe varsel - samme leksjon som D-180 allerede fastslo for
  // `Watchdog.tick()`, aldri anvendt på DENNE identiske mekanismen.
  if (apiDrainsExecutive) setInterval(
    () => void worker.drain().catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
    2_000
  ).unref();

  const dailyBrief = new DailyBrief([
    tasksSource(pool),
    schedulerSource(pool, (id) => id.person_id === owner.owner_person_id && id.tenant_id === owner.tenant_id),
    buildStatusSource(toolGateway),
    emailSource(toolGateway), calendarSource(toolGateway),
    // WP-B4 (D-476): ÉN linje om Claude-kreditten i den daglige briefen - kun med JARVIS_CLAUDE_BUDGET_USD (uten flagget er kildelisten uendret).
    ...(claudeBudgetConfig !== null ? [claudeBudgetBriefSource({ pool, config: claudeBudgetConfig })] : [])
  ], pool);
  const aiMeshText = async () => {
    const mesh = gateway.meshStatus();
    const lines = mesh.providers
      .filter((p) => p.provider !== "scripted")
      .map((p) => `${p.provider.padEnd(10)} ${p.state}${p.avg_latency_ms ? ` ~${p.avg_latency_ms}ms` : ""}`);
    return `AI MESH
${lines.join("\n")}
Router     ${mesh.router}
Fallback   ${mesh.fallback}
Critic     ${mesh.critic}`;
  };
  // BO-12 §37: voice-helse fra gatewayens /status når den kjører (egen prosess).
  const voiceText = async (): Promise<string> => {
    const voiceUrl = process.env["JARVIS_VOICE_URL"];
    if (!voiceUrl) {
      return "Voice      ikke konfigurert (JARVIS_VOICE_URL)";
    }
    try {
      const status = (await (await fetch(`${voiceUrl}/status`, { signal: AbortSignal.timeout(2_000) })).json()) as {
        stt: { name: string; state: string };
        tts: { name: string; state: string };
        transport: string;
        barge_in: string;
      };
      return `Voice
  STT      ${status.stt.name} ${status.stt.state}
  TTS      ${status.tts.name} ${status.tts.state}
  Transport ${status.transport}
  Barge-in ${status.barge_in}`;
    } catch {
      return "Voice      UNAVAILABLE (gateway svarer ikke)";
    }
  };
  const statusText = async () => {
    const gates = [...toolGateway.health.entries()].map(([k, v]) => `${k}:${v.state}`).join(" ");
    return `JARVIS STATUS
miljø: ${process.env["JARVIS_ENV"] ?? "dev"}
connectors: ${gates || "ingen kall enda"}
${await aiMeshText()}
${await voiceText()}
porter: se docs/RUNTIME_GATES.md`;
  };
  // D-394 (JARVIS-056): Telegram-token/chat-id leses via den delte kjeden (Infisical-primær, .env-fallback) - tidligere kun `process.env`, så en
  // token limt inn i dashbordet var usynlig for polleren (split-brain mot `telegram.notify`-verktøyet som allerede brukte kjeden).
  const telegramToken = (await readSecretProvider.get("JARVIS_TELEGRAM_TOKEN")) ?? undefined;
  const telegramChatId = (await readSecretProvider.get("JARVIS_TELEGRAM_CHAT_ID")) ?? undefined;
  telegramDeliveryConfigured = Boolean(telegramToken && telegramChatId);
  if (telegramToken && telegramChatId) {
    // D-125 (UA-7, FEMTE slice): den betrodde server-side eier-autoriteten for
    // inngående Telegram. HVER verdi kommer fra prosessens egen konfigurasjon
    // og fra `seedOwner()`-radene (`apps/api/src/seed.ts`) - INGEN av dem kan
    // påvirkes av en Telegram-melding. `person_id` utledes med SAMME uttrykk
    // som seeden (`JARVIS_OWNER_PERSON_ID`), ikke hardkodet, slik at en
    // konfigurert eier-ID ikke gir `unknown_membership` mot en seedet database.
    const telegramOwnerAuthority = new TelegramOwnerAuthority(
      { sessions: sessionService, identity: identityService },
      {
        owner_chat_id: telegramChatId,
        tenant_id: owner.tenant_id,
        person_id: owner.owner_person_id,
        // Tjeneste-enheten denne prosessen allerede ER seedet som.
        device_id: "jarvis-core",
        memory_space: "personal"
      }
    );
    new TelegramCommandPoller(telegramToken, telegramChatId, {
      brief: async () => DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)),
      status: statusText,
      ai: aiMeshText,
      // D-125: vanlig eier-tekst inn i den KANONISKE samtalebanen. Ingen ny
      // chat-motor, ingen ny identitetslagring, ingen ny sesjonsmodell.
      chat: async ({ chat_id, text }) => {
        // 1. Uavhengig, server-side autoritet. Meldingsteksten er ALDRI et
        //    argument her - se `authorize()`-signaturen. Avslag ⇒ `undefined`
        //    ⇒ polleren sender ingenting (fail-closed, ingen bekreftelse).
        const authorized = await telegramOwnerAuthority.authorize(chat_id);
        if (!authorized.ok) return undefined;
        // 2. Idempotent eier-identitetslenking i Conversation Graph (D-119).
        //    KUN den konfigurerte chat-ID-en deltar; `match_method` forblir
        //    `owner_configured`. En feil her skal aldri hindre selve samtalen
        //    - lenken er proveniens, ikke en autorisasjonsavhengighet.
        try {
          await conversationGraphSyncService.linkOwnerTelegramIdentity(
            authorized.identity.tenant_id,
            authorized.identity.memory_space_id,
            authorized.chat_id,
            authorized.identity.person_id
          );
        } catch (err) {
          console.error(JSON.stringify({
            msg: "telegram_owner_identity_link_failed",
            reason: err instanceof Error ? err.message.slice(0, 120) : "unknown"
          }));
        }
        // 3. SAMME motor som /chat, bundet til den OPPLØSTE identiteten.
        const result = await conversationEngine.handle(authorized.identity, text);
        return result.reply;
      }
      // REMEDIERING DEL 1: `/godkjenn`/`/avvis` (selvmodifikasjon) har ingen handler - frosset (JARVIS-042/043).
    }, sendTelegram, {
      // Del 3 (JARVIS-024): holdbar offset (restart spiller ikke av meldinger), fetch-timeout (standard i polleren) og
      // varsling - polleren logger HVER feil strukturert; en vedvarende feil (3 på rad, deretter hver 30.) får i tillegg en audit-rad.
      offsetStore: new PgTelegramOffsetStore(pool, telegramToken),
      onFailure: (failure) => {
        if (failure.consecutive !== 3 && failure.consecutive % 30 !== 0) return;
        void withTenantTransaction(pool, owner.tenant_id, (client) =>
          writeAudit(client, ownerIdentity, { type: "telegram.poll_degraded", reason: failure.kind, payload: { ...failure } })
        ).catch((err: unknown) => {
          console.error(JSON.stringify({ msg: "telegram_poll_degraded_audit_failed", error: err instanceof Error ? err.message : String(err) }));
        });
      }
    }).start();
    // BO-05: reboot-durabel morgenlevering (DB-laas, Europe/Oslo, catch-up, aldri duplikat).
    // Bruker DailyBrief.deliverViaTelegram() (ikke den generiske sendTelegram-
    // closuren over) FORDI den idempotency-nøkler hver chunk på
    // brief.generated_at+indeks - en re-kjørt/gjentatt levering (f.eks. etter
    // en prosessrestart midt i en flerdelt brief) kan derfor aldri duplisere
    // en allerede sendt del. sendTelegram selv har ingen idempotency-nøkkel og
    // sjekker heller ikke gateway-resultatet - fin for generiske
    // kommandosvar (TelegramCommandPoller over), men FEIL for den daglige
    // morgenleveringen, der en stille tapt levering ville sett ut som
    // "jobb fullført" for DailyScheduler.
    new DailyScheduler(pool).start(async () => {
      const brief = await dailyBrief.generate(ownerIdentity as never);
      const delivered = await DailyBrief.deliverViaTelegram(toolGateway, ownerIdentity as never, brief);
      if (!delivered) {
        console.error(JSON.stringify({ msg: "daily_brief_delivery_failed", generated_at: brief.generated_at }));
        // D-442: kast, så DailyScheduler planlegger nytt forsøk (1/5/15 min) i stedet for å bokføre dagen som fullført uten at briefen kom frem.
        // Avveining: et nytt forsøk lager en ny brief (ny `generated_at` = nye idempotensnøkler); feilet bare del 2+ av en flerdelt brief, kan del 1 komme to ganger.
        throw new Error("daily-brief: Telegram-levering feilet");
      }
    });
    // WP-C4 V2 (DORMANT): planlagt oppfølgingsvarsel til eierens EGEN Telegram via den eksisterende `telegram.notify` (Policy Gateway, kill switch, frys, revisjon, idempotens). Startes KUN når `JARVIS_V2_PUSH_ENABLED=true`;
    // rolig tid, døgngrense, minsteavstand og dedupe håndheves av ledgeren (se `follow-up-push.ts`); kill switch/frys/tilbakekalt credential sjekkes FØR reservasjon (`createPushSendGuard`). Uten flagget opprettes verken tidtaker eller lesing.
    if (v2PushPolicy.enabled) {
      startFollowUpPush({ pool, graph: conversationGraphService, gateway: toolGateway, ownerIdentity, policy: v2PushPolicy, guard: createPushSendGuard({ killSwitch, controls: ownerControls, infraGate, infraToolIds }) });
    } else {
      console.log(JSON.stringify({ msg: "v2_push_disabled" }));
    }
  }
  if (v2PushPolicy.enabled && !telegramDeliveryConfigured) console.warn(JSON.stringify({ msg: "v2_push_enabled_but_no_channel", detail: "JARVIS_V2_PUSH_ENABLED=true, men Telegram (token + chat) er ikke konfigurert - ingen varsler sendes" }));
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2) §12:
  // periodisk intern utgifts-synk (marketing/model_cost) + matching/
  // avstemming + deterministisk avviksdeteksjon - SAMME reboot-durable
  // DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env). Kjøres
  // FØR business-open-loop-sweep (default kl. 06) slik at de fem nye
  // finance_spend_*-open-loop-reglene ser FERSKE avviksflagg når den
  // sveipen kjører (default kl. 04) - REN passiv observasjon/regnskap,
  // ALDRI påvirket av finance_kill_switch (se spend-service.ts §13-JSDoc).
  new DailyScheduler(
    pool, "finance-spend-integrity-sweep", envHour("JARVIS_FINANCE_SPEND_SWEEP_HOUR", 4)
  ).start(() => failOnSweepFailures("finance-spend-integrity-sweep", (failures) => runFinanceSpendIntegritySweepForAllTenants(pool, spendService, failures)));
  // D-109 (UA-6 Slice 3) §15: periodisk Stripe-utfallssynk (explicit GET-
  // refresh av `provider_acknowledged`-rader) + provider-avviksdeteksjon -
  // SAMME reboot-durable DailyScheduler-mekanisme (eget job_name, egen
  // klokkeslett-env). Kjøres FØR finance-spend-integrity-sweep (default
  // kl. 03, mot kl. 04) slik at ferske Stripe-utfall er tilgjengelige når
  // resten av finans-sveipet kjører samme morgen. Trygt å kjøre uten
  // JARVIS_STRIPE_SECRET_KEY konfigurert - `listBusinessTenantIds` finner
  // ingen `provider_acknowledged`-Stripe-rader å synke før noen faktisk
  // sender en Stripe-betaling.
  new DailyScheduler(
    pool, "stripe-payment-sync", envHour("JARVIS_STRIPE_SYNC_HOUR", 3)
  ).start(() => failOnSweepFailures("stripe-payment-sync", (failures) => runStripePaymentSyncForAllTenants(pool, financeService, failures)));
  // D-110 (UA-6 Slice 4) §14: periodisk Vipps-utfallssynk + provider-
  // avviksdeteksjon - SAMME mekanisme/begrunnelse som stripe-payment-sync
  // over (eget job_name, egen klokkeslett-env, trygt å kjøre uten
  // JARVIS_VIPPS_*-credentials konfigurert).
  new DailyScheduler(
    pool, "vipps-payment-sync", envHour("JARVIS_VIPPS_SYNC_HOUR", 3)
  ).start(() => failOnSweepFailures("vipps-payment-sync", (failures) => runVippsPaymentSyncForAllTenants(pool, financeService, failures)));
  // D-111 (UA-6 Slice 5) §17: periodisk open-banking-sveip (samtykke-
  // verifisering/konto-/transaksjonssynk/betalingsstatus/avstemming/avvik)
  // - SAMME mekanisme/tidsvindu-klasse som Stripe-/Vipps-sveipene. Trygg
  // uten JARVIS_NEONOMICS_*-credentials (provider-steg blir no-op, de
  // rent lokale avstemmings-/avviks-stegene kjører fortsatt).
  new DailyScheduler(
    pool, "neonomics-sweep", envHour("JARVIS_NEONOMICS_SYNC_HOUR", 3)
  ).start(() => failOnSweepFailures("neonomics-sweep", (failures) => runNeonomicsSweepForAllTenants(pool, bankingService, financeService, failures)));
  // D-112 (UA-6 Slice 6): daglig Wallester-kortsveip (tilstands-/
  // autorisasjons-/transaksjonssynk -> avstemming -> avviksdeteksjon) -
  // SAMME reboot-durable DailyScheduler-mekanisme.
  new DailyScheduler(
    pool, "wallester-sweep", envHour("JARVIS_WALLESTER_SYNC_HOUR", 5)
  ).start(() => failOnSweepFailures("wallester-sweep", (failures) => runWallesterSweepForAllTenants(pool, cardService, failures)));
  // WP-F1 (D-462, UA-6): daglig finansavstemming (kl. 5 - ETTER leverandørsynkene kl. 3 og utgiftssveipet kl. 4, FØR open-loop-sveipet kl. 6). Observasjon + varsel; dormant
  // uten credentials; trygg på en tenant uten betalinger (tom kjøring).
  new DailyScheduler(
    pool, "finance-reconcile-sweep", envHour("JARVIS_FINANCE_RECONCILE_HOUR", 5)
  ).start(() => failOnSweepFailures("finance-reconcile-sweep", (failures) => runFinanceReconciliationForAllTenants(pool, financeReconciliation, failures)));
  // UA-3 next slice (D-53) §19/§20: periodisk open-loop-sveip - gjenbruker SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av om Telegram er konfigurert (deteksjon != levering).
  new DailyScheduler(
    pool, "business-open-loop-sweep", envHour("JARVIS_BUSINESS_SWEEP_HOUR", 6)
  ).start(() => failOnSweepFailures("business-open-loop-sweep", (failures) => runOpenLoopSweepForAllTenants(pool, openLoopService, failures)));
  // D-198 (V4-revisjon, masterplanens "Business Operating Loop"): UKENTLIG
  // (ALDRI daglig - se runBusinessWeeklyBriefForAllTenants() sin doc-
  // kommentar for hvorfor en daglig push her ville duplisert situations-
  // broens allerede eksisterende sanntidsvarsling) push av
  // generateWeeklyBrief()/renderWeeklyBrief() (D-53, fantes allerede men var
  // ALDRI schedulert - kun on-demand via business.get_business_brief).
  // SAMME reboot-durable DailyScheduler-mekanisme (claimer/markerer fullført
  // HVER dag - selve leveransen er en ren no-op utenom den konfigurerte
  // ukedagen, se isWeeklyBriefDay()). Default mandag (JARVIS_BUSINESS_
  // WEEKLY_BRIEF_WEEKDAY=1) kl. 07 (JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR).
  new DailyScheduler(
    pool, "business-weekly-brief", envHour("JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR", 7)
  ).start(async () => {
    if (!isWeeklyBriefDay(new Date(), "Europe/Oslo", envInt("JARVIS_BUSINESS_WEEKLY_BRIEF_WEEKDAY", 1, { min: 0, max: 7 }))) return;
    const result = await runBusinessWeeklyBriefForAllTenants(pool, toolGateway, (tenantId) => ({
      ...ownerIdentity, tenant_id: tenantId, memory_space_id: "business", session_id: `${ownerIdentity.session_id}-weekly-brief`
    }));
    if (result.errors.length > 0) {
      console.error(JSON.stringify({ msg: "business_weekly_brief_failed", errors: result.errors }));
      // D-442: retry kjører hele sveipet på nytt og briefens idempotensnøkkel inneholder `generated_at` (ny per kjøring). Etter DELVIS levering (en tenant som fikk
      // briefen, eller en flerdelt brief der kun del 1 ble sendt) ville et nytt forsøk sendt noe på nytt - derfor kastes det KUN når INGEN del ble sendt til noen.
      if (result.delivered === 0 && result.chunks_sent === 0) {
        throw new Error(`business-weekly-brief: ingen av ${result.attempted} tenant(s) fikk briefen (${result.errors[0]})`);
      }
    }
  });
  // UA-10 P1 AKTIVERING (D-160): situasjons-sveipen - ingest fra
  // `business_open_loops` -> `situations`, kildebasert løsning, evidens-først
  // INFORM/SUGGEST-leveranse via `telegram.notify`, og auto-ACT KUN under en
  // eksplisitt eier-policy (`situation_autonomy_policies`). SAMME reboot-
  // durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env).
  // Kjøres ETTER business-open-loop-sweep (default kl. 06 -> kl. 07) slik at
  // dagens ferske loops er detektert FØR de oversettes til situasjoner.
  // Identiteten per tenant er eierens identitet i sveipens space; en tenant
  // eieren ikke er autorisert for avvises av PolicyGateway inne i
  // `execute()` (fail-closed) - aldri en stille utelatelse her.
  // Arkitekt-review runde 1 på PR #86 (funn 3): resultatet KASTES ALDRI
  // bort - `assertSituationSweepHealthy()` kaster på ikke-tom `errors[]`,
  // evidensmismatch, ulevert varsel eller identitetskonflikt, så
  // `DailyScheduler` aldri bokfører en slik kjøring som fullført
  // (`completed_at` forblir NULL) og en `situation_sweep_failed`-linje
  // logges strukturert.
  new DailyScheduler(
    pool, "situation-sweep", envHour("JARVIS_SITUATION_SWEEP_HOUR", 7)
  ).start(() => runSituationSweepForAllTenants(pool, {
    openLoops: openLoopService,
    // D-195 (infra-slice): SAMME allerede-konstruerte `incidentService`
    // (UA-5/D-104) - bygger BARE på situasjoner via `infra-incident-bridge.ts`,
    // oppfinner INGEN ny deteksjonskilde. Se sweep.ts sin `IncidentReader`-
    // doc-kommentar for hvorfor dette feltet er frivillig (bakoverkompatibelt).
    incidents: incidentService,
    engine: situationEngine,
    gateway: toolGateway,
    identityFor: (tenantId, memorySpace) => ({
      ...ownerIdentity, tenant_id: tenantId, memory_space_id: memorySpace, session_id: `${ownerIdentity.session_id}-situation-sweep`
    })
  }).then(assertSituationSweepHealthy));
  // UA-3 business-event-linkage (D-57) §19/§20/§21: periodisk Gmail/Calendar->
  // Business-OS-synkronisering - SAMME reboot-durable DailyScheduler-mekanisme
  // (eget job_name, egen klokkeslett-env), uavhengig av Telegram-konfig.
  // Kjøres FØR open-loop-sveipet i klokkeslett (default 05) slik at nylig
  // synkroniserte aktiviteter er tilgjengelige naar sveipet (default 06) og
  // morgenbriefen kjører.
  new DailyScheduler(
    pool, "business-events-sync", envHour("JARVIS_BUSINESS_EVENTS_SYNC_HOUR", 5)
  ).start((run) => failOnSweepFailures("business-events-sync", (failures) => runBusinessEventSyncForAllTenants(pool, businessEventSyncService, failures, run)));
  // UA-7 Communications Hub - foerste slice (D-119): periodisk Gmail->
  // Conversation Graph-identitetskobling - SAMME reboot-durable
  // DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av business-events-sync over.
  new DailyScheduler(
    pool, "conversation-graph-sync", envHour("JARVIS_CONVERSATION_GRAPH_SYNC_HOUR", 5)
  ).start((run) => failOnSweepFailures("conversation-graph-sync", (failures) => runConversationGraphSyncForAllTenants(pool, conversationGraphSyncService, failures, run)));
  // UA-3 profiling/scoring-slice (D-61) §23: periodisk, idempotent
  // score-rekalkulering - SAMME reboot-durable DailyScheduler-mekanisme (eget
  // job_name, egen klokkeslett-env). Kjøres ETTER events-sync (05) og
  // open-loop-sveipet (06) slik at rekalkuleringen ser den ferskeste
  // aktivitets-/open-loop-tilstanden (default kl. 07).
  new DailyScheduler(
    pool, "business-scoring-recalc", envHour("JARVIS_BUSINESS_SCORING_HOUR", 7)
  ).start(() => failOnSweepFailures("business-scoring-recalc", (failures) => runScoringSweepForAllTenants(pool, scoringService, failures)));
  // UA-3 Native Jarvis Support Core (D-66) §7/§24: periodisk Gmail-innboks-
  // reconciliation - SAMME reboot-durable DailyScheduler-mekanisme, eget
  // job_name/klokkeslett-env. Kjøres ETTER de øvrige business-jobbene
  // (default kl. 08) - support-open-loop-reglene (§17, kjørt AV den
  // EKSISTERENDE business-open-loop-sweep kl. 06 over) ser dermed IKKE
  // nødvendigvis samme dags nye tickets før neste sveip - akseptabelt
  // forsinkelse (samme "periodisk, ikke event-drevet"-modell som resten av
  // UA-3, se Q-25 punkt 2). Trygt å kjøre uten `JARVIS_SUPPORT_INBOX_EMAILS`
  // konfigurert - routing blir da deterministisk tomt (ingen meldinger
  // klassifiseres som support, se `email-ingress.ts`).
  new DailyScheduler(
    pool, "support-inbox-sync", envHour("JARVIS_SUPPORT_INBOX_SYNC_HOUR", 8)
  ).start((run) => failOnSweepFailures("support-inbox-sync", (failures) => runSupportInboxSyncForAllTenants(pool, supportEmailService, failures, run)));
  // D-85: periodisk anomaly->anbefaling-sveip (growth-eid BESLUTNINGS-lag,
  // ALDRI utførelse) - SAMME reboot-durable DailyScheduler-mekanisme, eget
  // job_name/klokkeslett-env. Kjøres ETTER business-open-loop-sweep (default
  // kl. 06) slik at den kan lese den ferskeste søster-open-loopen via
  // `detection_key` (default kl. 09) - rekkefølgen er BEVISST, ikke
  // strengt nødvendig (åpen-loop-koblingen er `null`-trygg uansett rekkefølge,
  // se `detectAndRecommendSpendAnomalies()`-kommentaren i modules/growth).
  new DailyScheduler(
    pool, "growth-action-recommendation-sweep", envHour("JARVIS_GROWTH_RECOMMENDATION_SWEEP_HOUR", 9)
  ).start(() => failOnSweepFailures("growth-action-recommendation-sweep", (failures) => runActionRecommendationSweepForAllTenants(pool, growthService, failures)));
  // UA-8 Personal Digital Twin (D-130) §6: periodisk retensjons-håndhevelse
  // for lokasjonsobservasjoner - SAMME reboot-durable DailyScheduler-
  // mekanisme (eget job_name, egen klokkeslett-env). Trygt å kjøre uten noen
  // faktiske observasjoner ennå (ingen ekstern lokasjons-leverandør koblet
  // til i denne sliceen) - sveipet blir da et no-op.
  new DailyScheduler(
    pool, "location-retention-sweep", envHour("JARVIS_LOCATION_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runLocationRetentionSweepForAllTenants(pool, locationService).then((summary) => assertNoSweepFailures("location-retention-sweep", summary.failed)));
  // UA-8 Personal Digital Twin (D-130) §6: periodisk retensjons-håndhevelse
  // for helseobservasjoner - SAMME mekanisme/begrunnelse som
  // location-retention-sweep over. Kjøres i samme tidlige klokkeslett-vindu
  // (default kl. 02) - begge er rene, uavhengige retensjons-ryddejobber uten
  // downstream-avhengigheter til andre UA-3/UA-4-sveip.
  new DailyScheduler(
    pool, "health-retention-sweep", envHour("JARVIS_HEALTH_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runHealthRetentionSweepForAllTenants(pool, healthService).then((summary) => assertNoSweepFailures("health-retention-sweep", summary.failed)));
  // UA-9 Vision & Physical World (D-153): periodisk retensjons-håndhevelse
  // for hendelsesobservasjoner - SAMME reboot-durable DailyScheduler-
  // mekanisme som location-retention-sweep over (MULTI-SPACE, IKKE health-
  // stil enkelt-låst space - se modules/vision/src/sweep.ts sitt filhode).
  // Trygt å kjøre uten noen faktiske hendelser ennå (ingen ekstern kamera-
  // leverandør koblet til i denne sliceen) - sveipet blir da et no-op.
  new DailyScheduler(
    pool, "vision-retention-sweep", envHour("JARVIS_VISION_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runVisionRetentionSweepForAllTenants(pool, visionService).then((summary) => assertNoSweepFailures("vision-retention-sweep", summary.failed)));
  // WP-G3 (D-465): vedlikehold av bilder/inventar/vektorer/gravsteiner/opptaksforespørsler - KUN med JARVIS_VISION_ENABLED=on (ellers ingen jobb, identisk med main). Daglig full kjøring (reboot-durable,
  // samme mekanisme som over) + en hyppig LETT kjøring (gravsteiner, pending, utløp) slik at et slettet bilde forsvinner fra disken innen minutter.
  if (visionRuntime !== null) {
    new DailyScheduler(
      pool, "vision-maintenance-sweep", envHour("JARVIS_VISION_MAINTENANCE_HOUR", 3)
    ).start(() => visionRuntime.fullMaintenance().then((summary) => assertNoSweepFailures("vision-maintenance-sweep", summary.failed)));
    setInterval(
      () => void visionRuntime.lightMaintenance().catch((err: unknown) => console.error(JSON.stringify({ msg: "vision_light_maintenance_failed", error: err instanceof Error ? err.message.slice(0, 80) : "unknown" }))),
      envInt("JARVIS_VISION_MAINTENANCE_INTERVAL_MINUTES", 15, { min: 1, max: 1440 }) * 60_000
    ).unref();
  }
  // D-286 (Tobias direkte i chat, "alle" - alle tre foreslåtte tilnærminger
  // til ubegrenset minnevekst): periodisk konsolidering av gamle EPISODISKE
  // samtale-minner til dagssammendrag - SAMME reboot-durable
  // DailyScheduler-mekanisme/mønster som location/health/vision sine
  // retensjons-sveip over. Se `retention-sweep.ts` sitt filhode for full
  // begrunnelse (bevisst snever scope - rører ALDRI preference/decision/
  // relation/semantic-typer, KUN episodic samtale-minner).
  new DailyScheduler(
    pool, "memory-retention-sweep", envHour("JARVIS_MEMORY_RETENTION_SWEEP_HOUR", 2)
  ).start(() =>
    runMemoryRetentionSweepForAllTenants(
      pool, memoryWriter, memorySummaries, envInt("JARVIS_MEMORY_RETENTION_DAYS", 60, { min: 1, max: 3650 })
    ).then((summary) => assertNoSweepFailures("memory-retention-sweep", summary.failed))
  );
  // D-386: nattlig re-embedding av items/episoder/sammendrag som mangler vektor for GJELDENDE modell (modellbytte i
  // .env, eller vektorskriving som feilet fordi Ollama var nede). Samme reboot-durable DailyScheduler-mønster.
  // I tillegg ett kort, begrenset kick etter oppstart så et modellbytte virker samme dag - aldri i oppstartsstien.
  new DailyScheduler(
    pool, "memory-reembed-sweep", envHour("JARVIS_MEMORY_REEMBED_SWEEP_HOUR", 3)
  ).start(() => runMemoryReembedSweepForAllTenants(pool, memoryEmbedding).then((summary) => assertNoSweepFailures("memory-reembed-sweep", summary.failed)));
  // Gjennomgang av WP-A (D-451): regn sensitiviteten på nytt for elementer lagret FØR ordforrådet ble utvidet (Q-52 A). Standard er `report` (kun tellinger i loggen); `JARVIS_MEMORY_RESENSITIZE=apply` hever
  // nivået (aldri senker) med revisjonsspor, `off` slår sveipet av. Kjører før profilsveipet, så profilen rekompileres uten nye `special`-elementer.
  new DailyScheduler(
    pool, "memory-resensitize-sweep", envHour("JARVIS_MEMORY_RESENSITIZE_SWEEP_HOUR", 3)
  ).start(() =>
    runMemoryResensitizeSweepForAllTenants(pool, { mode: resensitizeModeFromEnv(process.env["JARVIS_MEMORY_RESENSITIZE"]) }).then(rememberResensitize).then((summary) => assertNoSweepFailures("memory-resensitize-sweep", summary.failed))
  );
  // EV-3 (D-452): radar-sveip av KILDER EIEREN SELV HAR VALGT (`JARVIS_RADAR_SOURCES`) - inert uten dem (ingen nettverkskall). Hvert svar går gjennom sikkerhetssonen (ubetrodd forskning, karantene ved mistenkelig innhold);
  // kun status per kilde beholdes i minnet, aldri innholdet. L6 (gjennomgang av PR #313): sveipet kjører KUN via den persisterte DailyScheduler, så det går høyst én gang per døgn også ved omstart/crash-loop (tidligere
  // et ubetinget sveip 60 s etter HVER oppstart = tung trafikk mot kildene). Prisen er ærlig: statusen holdes i minnet, så etter en omstart står EV-3 som «ikke kjørt ennå» til neste planlagte kjøring.
  // Feiler ALLE kilder (nett/DNS nede) kaster sveipet via assertNoSweepFailures (D-442): nytt forsøk med backoff, og synlig oppgitt til slutt. En delvis svikt er et funn i EV-3, ikke en feilet kjøring (et nytt forsøk ville hentet de friske kildene på nytt).
  if (evolutionRadar.configured > 0) {
    new DailyScheduler(pool, "evolution-radar-sweep", envHour("JARVIS_RADAR_SWEEP_HOUR", 6)).start(() => evolutionRadar.run().then((summary) => { console.log(JSON.stringify({ msg: "evolution_radar_sweep_done", configured: summary.configured, ok: summary.ok, quarantined: summary.quarantined, failed: summary.failed, security_events: summary.security_events })); return summary; }).then((summary) => assertNoSweepFailures("evolution-radar-sweep", radarSweepFailures(summary, owner.tenant_id))));
  }
  // D-386: nattlig rekompilering av den alltid-tilstede eierprofilen per space (deterministisk, ingen LLM).
  new DailyScheduler(
    pool, "memory-profile-sweep", envHour("JARVIS_MEMORY_PROFILE_SWEEP_HOUR", 4)
  ).start(() => runMemoryProfileSweepForAllTenants(pool).then((summary) => assertNoSweepFailures("memory-profile-sweep", summary.failed)));
  // D-395 (JARVIS-074): daglig oppbevaring for driftsrader som ellers vokser uten grense (utløpte godkjenninger/grants/billetter, ferdige
  // verktøyutføringer, gamle scheduler-rader). All sletting skjer i `prune_operational_data()` (SECURITY DEFINER, faste gulv i RLS-policyene);
  // runtime-rollen har kun EXECUTE. Revisjon/hendelser/kostnadsledger berøres ikke (eierbeslutning).
  new DailyScheduler(
    pool, "operational-retention-sweep", envHour("JARVIS_OPERATIONAL_RETENTION_SWEEP_HOUR", 3)
  ).start(async () => {
    const result = await runOperationalRetentionSweep(pool);
    console.log(JSON.stringify({ msg: "operational_retention_sweep_completed", ...result }));
  });
  // WP-K (D-471, JARVIS-053): oppbevaring for den varige policy-journalen (`policy_decisions`, migrasjon 108) - SAMME mønster og klokkeslett som sveipet over, men egen jobb (egen claim/retry/helse i
  // `scheduler_state`, så en feil her aldri skjuler resultatet av det eksisterende sveipet). Kun registrert når journalen er PÅ (AV = ingenting nytt kjører); `prune_policy_decisions()` har et fast gulv på 30 dager.
  if (policyAuditSink) {
    new DailyScheduler(
      pool, "policy-decision-retention-sweep", envHour("JARVIS_OPERATIONAL_RETENTION_SWEEP_HOUR", 3)
    ).start(async () => {
      const result = await runPolicyDecisionRetentionSweep(pool, { days: policyAuditSinkConfigFromEnv().retentionDays });
      console.log(JSON.stringify({ msg: "policy_decision_retention_sweep_completed", ...result }));
    });
  }
  if (memoryEmbedding.model !== "local-hash-v1") {
    setTimeout(() => {
      runMemoryReembedSweepForAllTenants(pool, memoryEmbedding, { maxRows: 500 }).catch((err: unknown) => {
        console.error(JSON.stringify({ msg: "memory_reembed_boot_kick_failed", error: (err as Error).message.slice(0, 200) }));
      });
    }, 30_000).unref();
  }
  // D-242 (Tobias direkte chat-instruks: "du skal bygge det for absolutt
  // alle som tester en gang om dagen så vi vet om credentials fungerer
  // eller ikke hele tiden"): daglig `ConnectorHealthSweep` - SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen
  // klokkeslett-env). Kjøres via `toolGateway.execute()` MED eierens egen
  // `ownerIdentity` (SAMME identitet `business-weekly-brief`/
  // `situation-sweep` allerede bruker over) - alle 11 `live_test`-
  // connectorer er klasse A (`test_connector` sin egen D-213-begrunnelse:
  // "en 'test at dette fungerer'-handling for en allerede lesende, klasse
  // A-operasjon ER fortsatt klasse A"), ALLOW uansett autoritetsmodus,
  // INGEN mandat/godkjenning nødvendig. Trygt å kjøre uten NOEN
  // finans-/Vercel-credentials konfigurert - `runConnectorHealthSweep()`
  // hopper deterministisk over enhver ikke-konfigurert connector FØR noe
  // kall gjøres (se doc-kommentaren i `connector-health-sweep.ts`).
  new DailyScheduler(
    pool, "connector-health-sweep", envHour("JARVIS_CONNECTOR_HEALTH_SWEEP_HOUR", 10)
  ).start(async () => {
    const result = await runConnectorHealthSweep(toolGateway, ownerIdentity);
    if (result.failed.length > 0) {
      console.error(JSON.stringify({ msg: "connector_health_sweep_completed_with_failures", failed: result.failed }));
    }
  });
  // WP-E1 (UA-5, JARVIS-068): deterministiske incident-produsenter - bakgrunnsjobber som gir opp, feilede utrullinger, brutte tjenestemål, sviktende tilkoblinger, mislykkede infra-handlinger og
  // Sentry-feil blir hendelser. KUN observasjon + registrering i Jarvis' egen database (ingen reparasjon, intet eksternt skriv). AV som standard (`JARVIS_INCIDENT_PRODUCERS_ENABLED=true`).
  if (incidentProducerConfig.enabled) {
    startApiIncidentProducers({
      pool, gateway: toolGateway, identity: ownerIdentity, deployments: deploymentService, sloReport: sloReports,
      config: incidentProducerConfig, incidents: incidentService, tenantId: owner.tenant_id
    });
  } else {
    console.log(JSON.stringify({ msg: "incident_producers_disabled" }));
  }
  // D-411 (EV-0): KUN observasjon - logger om Safety Constitution er verifisert og om endringsregisterets hash-kjede er hel. Kaster aldri,
  // blokkerer ikke oppstart, og endrer ingenting (selvendring er fortsatt frosset, D-397).
  void checkEv0Boot({
    pool,
    pinnedPublicKeySha256: process.env["JARVIS_CONSTITUTION_PUBKEY_SHA256"]?.trim() || null,
    configDir: fileURLToPath(new URL("../../../config/evolution/", import.meta.url))
  }).then((status) => logEv0Boot(status)).catch((err: unknown) => {
    console.error(JSON.stringify({ msg: "ev0_boot_check_failed", error: (err as Error).message.slice(0, 200) }));
  });
  // WP-C2 (OPS-RUNTIME): ekstern oppetids-heartbeat (dead man's switch). AV uten JARVIS_UPTIME_HEARTBEAT_URL; pinger KUN mens en lokal selvsjekk
  // (databasen + api-prosessen svarer på /health) består - stillhet er alarmen hos eierens monitor. Kun status, aldri innhold; kan ikke velte API-et.
  startUptimeHeartbeat({ port });
  return deps;
}

const deps = await buildDeps().catch((err: unknown) => {
  // Q-21: fail-closed - en usikker DB-rolle skal stoppe oppstart tydelig, aldri
  // starte videre "på lavere tillit" med en stille degradert sikkerhetsmodell.
  console.error(JSON.stringify({ msg: "jarvis-api startup_failed", error: (err as Error).message }));
  process.exit(1);
});
const server = createApiServer(deps);
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port, db: Boolean(deps) }));
});
