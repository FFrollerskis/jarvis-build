// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  ContextBuilder,
  DeviceService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionService,
  assertRuntimeCredentialsConfigured,
  assertRuntimeRoleSafe,
  configFromEnv,
  createPool,
  runMigrations
} from "@jarvis/core";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter,
  ScriptedAdapter
} from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { LocalHashEmbedding, MemoryRetriever } from "@jarvis/memory";
import {
  DailyBrief, EnvSecretProvider, FallbackSecretProvider, GithubRateLimitController, GithubTransport, GmailTransport,
  GoogleCalendarTransport, MeshToolExecutor, meshToolDefinitions, PgGithubRateLimitStore, TelegramCommandPoller,
  TelegramTransport, ToolGateway, buildStatusSource, calendarSource, driveTransportsIfConfigured, emailSource,
  firstWaveTools, tasksSource, DailyScheduler
} from "@jarvis/tool-gateway";
import {
  BusinessEventSyncService, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService,
  ScoringService, runBusinessEventSyncForAllTenants, runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants
} from "@jarvis/business";
import { SupportEmailService, SupportService, SupportTransport, runSupportInboxSyncForAllTenants } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { ConsentEnforcementService, ConsentService, ConsentTransport } from "@jarvis/consent";
import {
  GoogleAdsTransport, GrowthService, GrowthTransport, marketingMemoryBriefSource, runActionRecommendationSweepForAllTenants
} from "@jarvis/growth";
import { OwnerControls } from "@jarvis/policy";
import { ConversationEngine } from "./conversation.ts";
import { executiveHandler } from "./executive.ts";
import { createApiServer, type ApiDeps } from "./server.ts";

const port = Number(process.env["JARVIS_API_PORT"] ?? 3010);

async function buildDeps(): Promise<ApiDeps | undefined> {
  if (!process.env["JARVIS_DB_PASSWORD"] && !process.env["JARVIS_DB_HOST"]) {
    console.log(JSON.stringify({ msg: "ingen databasekonfig - starter i helse-modus" }));
    return undefined;
  }
  // Q-21 (2026-08-15): fail-closed FØR tilkobling forsøkes - en manglende/feilkonfigurert
  // JARVIS_DB_USER skal ALDRI stille falle tilbake til admin-tilkoblingen (root cause for
  // host-blockeren var nettopp dette - api kjørte som Postgres-superbruker).
  assertRuntimeCredentialsConfigured();
  const pool = createPool(configFromEnv());
  // Migrasjoner kjøres av admin-bruker i drift; her antas app-bruker å ha skjema fra før.
  if (process.env["JARVIS_DB_RUN_MIGRATIONS"] === "true") {
    await runMigrations(pool);
  }
  // Q-21: appen skal ALDRI starte normalt med en superuser/BYPASSRLS-tilkobling - RLS
  // er strukturelt umulig å håndheve for en slik rolle, uansett hvor korrekte policyene er.
  await assertRuntimeRoleSafe(pool);
  // BO-09: Langfuse-sink når konfigurert (D-27), ellers JSONL - samme mesh-observability overalt.
  const trace = traceSinkFromEnv(process.env["JARVIS_TRACE_FILE"] ?? "var/traces.jsonl");
  const killSwitch = new KillSwitch();
  // Enhetsregister fra databasen (fase 8): godkjenninger verifiseres mot registrerte enhetsnøkler.
  const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
  await deviceRegistry.refresh().catch(() => undefined);
  setInterval(() => void deviceRegistry.refresh().catch(() => undefined), 30_000).unref();
  const policy = new PolicyGateway({
    devices: deviceRegistry,
    nonces: new PgApprovalStore(pool),
    killSwitch,
    // v4.0 sovereign-owner (BO-11.1 §2-funn): uten denne kjørte runtime i legacy
    // SCOPED-modus og krevde approval for owners D-kall. A-D er risikoklasser -
    // for owner gir SOVEREIGN autonom utførelse; sikkerheten ligger i D-pipelinen
    // (preflight/readback/evidens/recovery) + owner-kontrollene, ikke approval.
    authority: {
      owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
      owner_tenants: [process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"]
    }
  });
  const queue = new PgTaskQueue(pool);
  const worker = new InProcessWorker(queue);
  const gateway = new ModelGateway({
    pool,
    trace,
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
      new KimiAdapter(),
      new OllamaAdapter(),
      new ScriptedAdapter()
    ],
    budget: {
      warn_ore: 100_000,
      approval_ore: 200_000,
      hard_limit_ore: 300_000,
      spend_approved: process.env["JARVIS_BUDGET_APPROVED"] === "true"
    }
  });
  // BO-03: Tool Gateway m/live transporter (aktiveres av credentials i .env),
  // Daily Brief-kilder, morgenlevering og Telegram-kommandoer.
  const toolGateway = new ToolGateway(
    pool, policy,
    new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
    new OwnerControls(killSwitch)
  );
  const businessService = new BusinessService(pool);
  // UA-3 next slice (D-53): open-loop-deteksjon - egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§4/§19/§20 i byggeordren).
  const openLoopService = new OpenLoopService(pool);
  // UA-3 profiling/scoring-slice (D-61): egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§14/§23 i byggeordren) - gjenbruker Business Graph uendret.
  const scoringService = new ScoringService(pool);
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
  // D-97: sentralisert GitHub rate-limit-kontroller - Postgres-baaret delt
  // tilstand (SHARED_RUNTIME, deles med worker-main.ts sin egen instans over
  // SAMME pool/tabell). `onTransition` er en bevisst minimal operativ-
  // synlighet-krok (§24) - IKKE en full EventWriter/tenant-audit-kobling
  // (GitHub-credentialen er global, ikke tenant-scoped, se D-97).
  const githubRateLimitController = new GithubRateLimitController(
    new PgGithubRateLimitStore(pool), "JARVIS_GITHUB_TOKEN",
    (event) => console.warn(`[github-rate-limit] ${event.transition} -> ${event.state}${event.retryAt ? ` retry_at=${event.retryAt.toISOString()} source=${event.source}` : ""}`)
  );
  for (const tool of firstWaveTools({
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(githubRateLimitController), telegram: new TelegramTransport(),
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
    growth: new GrowthTransport(growthService),
    // UA-4 Google Ads-slice (D-83): SAMME lat/enkel-avhengighet-mønster som
    // GrowthTransport over - INGEN toolGateway/ToolInvocationContext (ingen
    // nøstet klasse D-handling i denne sliceen).
    googleads: new GoogleAdsTransport(growthService),
    // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
    // Core - SAMME lat/enkel-avhengighet-mønster som GrowthTransport/
    // AgreementsTransport over (INGEN toolGateway/ToolInvocationContext,
    // ingen nøstet klasse D-handling).
    consent: new ConsentTransport(consentService, consentEnforcementService),
    ...driveTransportsIfConfigured()
  })) toolGateway.register(tool);
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans (allerede
  // registrert med Gmail/Calendar over) - ingen ny transport-vei.
  const businessEventSyncService = new BusinessEventSyncService(toolGateway, businessService, openLoopService);
  // UA-3 Native Jarvis Support Core (D-66) §7/§24: egen instans for den
  // periodiske innboks-sveipen (SAMME mønster som `businessEventSyncService`
  // over - en direkte, parallell instans, IKKE den lazy interne i
  // SupportTransport) - SAMME toolGateway/businessService, ingen ny transport-vei.
  const supportEmailService = new SupportEmailService(toolGateway, businessService, supportService);
  const ownerIdentity = {
    person_id: "person-tobias", tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
    memory_space_id: "personal", session_id: "sess-brief", device_id: "jarvis-core",
    channel: "api", auth_strength: "active"
  } as const;
  // BO-11.1 §9: SAMME executive-handler som worker-containeren (delt fil) - api-workeren
  // som vinner queue-racet skal håndtere tools=true-jobber identisk (uten sandbox).
  worker.register(
    "executive",
    executiveHandler({
      gateway,
      tools: { definitions: meshToolDefinitions(), executor: new MeshToolExecutor(toolGateway, ownerIdentity) }
    })
  );

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
      memory: new MemoryRetriever(pool, new LocalHashEmbedding()),
      // D-30 live-funn: samtalebanen (tekst + voice via /chat) får mesh-verktøyene.
      // Executor bindes til samtalens RESOLVED identity - aldri ownerIdentity -
      // slik at tenant/delegation/authority følger den som faktisk snakker.
      tools: {
        definitions: meshToolDefinitions(),
        executorFor: (identity) => new MeshToolExecutor(toolGateway, identity)
      }
    })
  };
  setInterval(() => void worker.drain().catch(() => undefined), 2_000).unref();

  const dailyBrief = new DailyBrief([
    tasksSource(pool), buildStatusSource(toolGateway),
    emailSource(toolGateway), calendarSource(toolGateway)
  ], pool);
  const sendTelegram = async (text: string) => {
    for (let i = 0; i < text.length; i += 3900) {
      await toolGateway.execute({ identity: ownerIdentity as never, tool_id: "telegram", action: "notify",
        parameters: { message: text.slice(i, i + 3900) } });
    }
  };
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
fase: v4.0 UA-1 P1A + D-30 voice foundation
connectors: ${gates || "ingen kall enda"}
${await aiMeshText()}
${await voiceText()}
porter: se docs/RUNTIME_GATES.md`;
  };
  if (process.env["JARVIS_TELEGRAM_TOKEN"] && process.env["JARVIS_TELEGRAM_CHAT_ID"]) {
    new TelegramCommandPoller(process.env["JARVIS_TELEGRAM_TOKEN"], process.env["JARVIS_TELEGRAM_CHAT_ID"], {
      brief: async () => DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)),
      status: statusText,
      ai: aiMeshText
    }, sendTelegram).start();
    // BO-05: reboot-durabel morgenlevering (DB-laas, Europe/Oslo, catch-up, aldri duplikat).
    new DailyScheduler(pool).start(async () => {
      await sendTelegram(DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)));
    });
  }
  // UA-3 next slice (D-53) §19/§20: periodisk open-loop-sveip - gjenbruker SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av om Telegram er konfigurert (deteksjon != levering).
  new DailyScheduler(
    pool, "business-open-loop-sweep", Number(process.env["JARVIS_BUSINESS_SWEEP_HOUR"] ?? 6)
  ).start(() => runOpenLoopSweepForAllTenants(pool, openLoopService).then(() => undefined));
  // UA-3 business-event-linkage (D-57) §19/§20/§21: periodisk Gmail/Calendar->
  // Business-OS-synkronisering - SAMME reboot-durable DailyScheduler-mekanisme
  // (eget job_name, egen klokkeslett-env), uavhengig av Telegram-konfig.
  // Kjøres FØR open-loop-sveipet i klokkeslett (default 05) slik at nylig
  // synkroniserte aktiviteter er tilgjengelige naar sveipet (default 06) og
  // morgenbriefen kjører.
  new DailyScheduler(
    pool, "business-events-sync", Number(process.env["JARVIS_BUSINESS_EVENTS_SYNC_HOUR"] ?? 5)
  ).start(() => runBusinessEventSyncForAllTenants(pool, businessEventSyncService).then(() => undefined));
  // UA-3 profiling/scoring-slice (D-61) §23: periodisk, idempotent
  // score-rekalkulering - SAMME reboot-durable DailyScheduler-mekanisme (eget
  // job_name, egen klokkeslett-env). Kjøres ETTER events-sync (05) og
  // open-loop-sveipet (06) slik at rekalkuleringen ser den ferskeste
  // aktivitets-/open-loop-tilstanden (default kl. 07).
  new DailyScheduler(
    pool, "business-scoring-recalc", Number(process.env["JARVIS_BUSINESS_SCORING_HOUR"] ?? 7)
  ).start(() => runScoringSweepForAllTenants(pool, scoringService).then(() => undefined));
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
    pool, "support-inbox-sync", Number(process.env["JARVIS_SUPPORT_INBOX_SYNC_HOUR"] ?? 8)
  ).start(() => runSupportInboxSyncForAllTenants(pool, supportEmailService).then(() => undefined));
  // D-85: periodisk anomaly->anbefaling-sveip (growth-eid BESLUTNINGS-lag,
  // ALDRI utførelse) - SAMME reboot-durable DailyScheduler-mekanisme, eget
  // job_name/klokkeslett-env. Kjøres ETTER business-open-loop-sweep (default
  // kl. 06) slik at den kan lese den ferskeste søster-open-loopen via
  // `detection_key` (default kl. 09) - rekkefølgen er BEVISST, ikke
  // strengt nødvendig (åpen-loop-koblingen er `null`-trygg uansett rekkefølge,
  // se `detectAndRecommendSpendAnomalies()`-kommentaren i modules/growth).
  new DailyScheduler(
    pool, "growth-action-recommendation-sweep", Number(process.env["JARVIS_GROWTH_RECOMMENDATION_SWEEP_HOUR"] ?? 9)
  ).start(() => runActionRecommendationSweepForAllTenants(pool, growthService).then(() => undefined));
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
