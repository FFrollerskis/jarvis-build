import { stepUpDenial } from "./step-up.ts";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { BusinessTenantProvisioningError, ChallengeLimitError, previewBusinessTenant, provisionBusinessTenant, withTenantTransaction, writeAudit, type ConfirmationStore } from "@jarvis/core";
import type {
  ChannelSessionAuthority, DeviceEnrollmentService, DeviceService, IdentityService,
  SessionGrantService, SessionService, VoiceSessionAuthority
} from "@jarvis/core";
import {
  OWNER_LIFECYCLE_ACTIONS, acquireContainerLogs, attemptRecovery, correlateDbState, correlateIncident, dockerProviderStatus, executeCloudMutation, executeInfraMutation,
  getInfraExecution, incidentPhase, incidentPhaseNo, ingestGithubDeployment, proposeRepairTask, truthLabelNo,
  type DeploymentService, type DiagnosisService, type IncidentService, type IncidentStatus
} from "@jarvis/incidents";
import { OwnerControlUnauthorizedError, type InfraExecutionGate, type OwnerControls, type PolicyGateway } from "@jarvis/policy";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { CLOUD_CONTROL_TOOL_IDS, ownerStepUpDenial, type DockerMutationAction, type ToolGateway } from "@jarvis/tool-gateway";
import {
  InvalidWebhookSignatureError, StripeCredentialsUnavailableError, StripeTenantNotConfiguredError,
  VippsCredentialsUnavailableError, VippsTenantNotConfiguredError,
  NeonomicsCredentialsUnavailableError, NeonomicsTenantNotConfiguredError,
  WallesterCredentialsUnavailableError, WallesterTenantNotConfiguredError,
  type CardService, type FinanceService
} from "@jarvis/finance";
import { ProductUsageError, UsageImportError, USAGE_LIMITS, USAGE_WEBHOOK_SIGNATURE_HEADER, type ProductUsageService } from "@jarvis/business";
import { CONTROL_CENTER_READ_TOOLS, isControlCenterId, isExtensionControlCenterId } from "@jarvis/executive";
import { GROWTH_EXPERIMENT_TOOL_ACTIONS, executeGrowthWrite, type GrowthWriteExecutorDeps, type GrowthWriteStatusFilter } from "@jarvis/growth";
import {
  COMMS_CONTACT_READ_ACTIONS, COMMS_KNOWN_ACTIONS, COMMS_MEETING_READ_ACTIONS, COMMS_READ_ACTIONS, COMMS_VENDOR_READ_ACTIONS, WEBHOOK_MAX_BYTES_BY_PROVIDER as COMMS_WEBHOOK_MAX_BYTES_BY_PROVIDER, executeCommsOwnerAction, previewCommsSend,
  type CommsWebhookProvider, type CommsWebhookService, type OutboundFunnel, type PreSignatureRejection
} from "@jarvis/comms";
import type { ConversationEngine } from "./conversation.ts";
import { handlePersonalRoute, type PersonalApiDeps } from "./personal-routes.ts";
import { handleVisionRoute, type VisionApiDeps } from "./vision-routes.ts";
import { handleSituationSignalRoute, type SituationSignalApiDeps } from "./situation-signal-routes.ts";
import { FINANCE_ACTION_ROUTE_ACTIONS, moneyActionParameters, parseFinanceActionRequest, previewFinanceAction, readReconciliationStatus } from "./finance-actions.ts";
import { submittedContractHasReservedKey, type ChatJobs } from "./chat-jobs.ts";
import { confirmationRestrictsOrigin } from "./restricted-context-guard.ts";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  FORBIDDEN_IDENTITY_BODY_KEYS, HttpError, RateLimiter, clientKey, newRequestId, readJsonBody, readRawBodyGuarded, readRawBodyLimited, webhookBodyGuardFor, type WebhookBodyReadConfig
} from "./http-guard.ts";

/**
 * Fase 3: minimalt API uten rammeverk (rammeverksvalg utsatt til behovet
 * krever det). Ruter: /health, / (webchat), /chat (SSE/JSON).
 * (/tools/critical-demo og /worker/tick finnes kun bak `enableDevRoutes`, aldri i produksjon.)
 *
 * Merk: API-et binder localhost i dev og har ingen egen HTTP-autentisering
 * ennå - enhetsautentisering kommer med kanalene i senere faser (dokumentert).
 */
export interface ApiDeps {
  /** D-393 (JARVIS-026): se `makeReadiness` - uten denne er `/health` ren prosess-liveness. */
  readiness?: () => Promise<ReadinessResult>;
  identity: IdentityService;
  sessions: SessionService;
  conversation: ConversationEngine;
  policy: PolicyGateway;
  worker: InProcessWorker;
  /** Fase 8: enhetsregistrering/challenge-auth for mobil/Watch. */
  devices?: DeviceService;
  /**
   * D-123 (UA-7 slice 4, Q-32 punkt 2): betrodd server-side sesjons-/
   * memory-space-autoritet for Voice Gateway. Valgfri av samme grunn som
   * `devices`/`tasks`: uten database-avhengigheter kjører API-et i helse-modus.
   * Ingen NY autorisasjonsmekanisme - se `VoiceSessionAuthority`.
   */
  voiceAuthority?: VoiceSessionAuthority;
  /**
   * D-130 arkitekt-review MERGE BLOCKER 1-fiks: den generaliserte, kanal-
   * uavhengige søsteren til `voiceAuthority` over - PÅKREVD (ikke valgfri, i
   * motsetning til `voiceAuthority`) fordi `/chat`/`/brief` fra nå av ALDRI
   * stoler på klient-oppgitt `person_id`/`device_id`/`auth_strength` direkte
   * (se `/session/authorize`-ruten og de nye `/chat`/`/brief`-grenene under).
   * Konstrueres i `main.ts` fra de SAMME delte `devices`/`sessions`/`identity`-
   * instansene som `voiceAuthority` allerede bruker (samme delingsdisiplin som
   * D-123 krevde - `DeviceService` holder utstedte challenges in-memory).
   */
  channelAuthority: ChannelSessionAuthority;
  /**
   * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): den server-side
   * eieren av `session_grants`. PÅKREVD, ikke valgfri: `/chat`/`/brief` har
   * ingen annen autoritetskilde igjen - de godtar KUN et `grant_token`, og
   * ALDRI en rå sesjons-ID.
   */
  grants: SessionGrantService;
  /**
   * D-131 funn 2: den betrodde innrullerings-autoriteten bak
   * `/devices/register`. Valgfri på samme måte som `devices`: uten
   * database-avhengigheter kjører API-et i helse-modus, og da er ruten 404
   * i stedet for en åpen innrulleringsflate.
   */
  enrollment?: DeviceEnrollmentService;
  /** v4.0 BO-02: Daily Executive Brief on demand. */
  brief?: { generate(identity: unknown): Promise<unknown>; render(artifact: unknown): string };
  /**
   * D-199 (UA-11 Executive dashboard-UI, LESE-DELEN): SAMME allerede-
   * konstruerte `toolGateway`-instans som resten av appen (`incidents.gateway`
   * over, `situations`-sveipet, osv.) - INGEN ny autorisasjonsmekanisme,
   * INGEN ny ToolGateway-instans. Valgfritt, samme mønster som `brief`/
   * `tasks`/`incidents`: uten database-avhengigheter kjører API-et i
   * helse-modus. Route-en under (`/executive/query`) begrenser SEG SELV til
   * et hardkodet, LESE-KUN allowlist av `executive.*`-handlinger (se
   * `EXECUTIVE_QUERY_ACTIONS`) - mutasjoner (pause/revoke/kill switch osv.)
   * er BEVISST IKKE eksponert her ennå, egen fremtidig slice (samme
   * "P0 lese/komposisjon FØR P1 mutasjon/autonomi"-rekkefølge som UA-9/
   * UA-10/UA-11 selv allerede fulgte).
   */
  executive?: { gateway: ToolGateway };
  /**
   * Del 3 (JARVIS-002/014): bundne bekreftelsesobjekter for handlinger i en tainted tur. Kun grant-ruten `/confirmations` kan liste/avgjøre dem -
   * aldri modellen. Uten verdien svarer ruten 404.
   */
  confirmations?: ConfirmationStore;
  /** D-416: eierens delegerte bakgrunnsjobber (liste/status) for chat-UI-et. Uten verdien svarer `/chat/jobs` 404. */
  chatJobs?: ChatJobs;
  /**
   * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
   * SAMME `TaskService`-instans som allerede konstrueres for `ConversationEngine`
   * (main.ts) - eksponerer den EKSISTERENDE, allerede validerte/policy-håndhevede
   * `submit()`-metoden (full `JobContract`, klasse B) over HTTP i stedet for å
   * bygge en ny innsendingsmekanisme. Valgfritt: uten database-avhengigheter
   * kjører API-et i helse-modus (samme mønster som `worker`/`brief`).
   */
  tasks?: TaskService;
  /**
   * D-104 (UA-5 Production Operations Control Plane v1): valgfritt - uten
   * database-avhengigheter kjører API-et i helse-modus (samme mønster som
   * `tasks`/`worker`/`brief`). `gate`/`infraToolIds` er DEN SAMME
   * `InfraExecutionGate`-instansen `PolicyGateway` allerede håndhever -
   * disse rutene MUTERER kun dens tilstand, de omgår ALDRI `policy.
   * authorize()` (hver rute kaller `policy.authorize()` FØRST, identisk
   * mønster som `/tools/critical-demo`).
   */
  incidents?: {
    service: IncidentService;
    deployments: DeploymentService;
    /** D-105: valgfritt - diagnose-rutene forblir 404 uten den (samme mønster som `tasks`). */
    diagnosis?: DiagnosisService;
    gateway: ToolGateway;
    controls?: OwnerControls;
    infraGate: InfraExecutionGate;
    pool: pg.Pool;
  };
  /**
   * D-109 (UA-6 Slice 3): eksponerer `FinanceService` for `/webhooks/stripe`.
   * Valgfritt - uten database-avhengigheter kjører API-et i helse-modus
   * (samme mønster som `tasks`/`incidents`/`brief`). Denne ruten leser
   * RÅ body direkte (IKKE via `readBody()`, som JSON-parser og dermed
   * ødelegger byte-for-byte-signaturen Stripe krever) - se egen gren under.
   */
  finance?: { service: FinanceService; cards?: CardService };
  /**
   * Remediering del 1 (JARVIS-001/063): dev-/demo-rutene `/worker/tick` (uautentisert
   * kødrenering) og `/tools/critical-demo` (klasse D-stub) er DEAKTIVERT i produksjon.
   * Kun tester setter denne eksplisitt til `true`; `main.ts` setter den ALDRI, og
   * den kan ikke slås på via miljøvariabel.
   */
  enableDevRoutes?: boolean;
  /** Remediering del 2 (JARVIS-063): overstyr rate-limit-tallene (tester). Standard: se `DEFAULT_RATE_LIMITS`. */
  rateLimits?: Partial<ApiRateLimits>;
  /**
   * WP-D2 (JARVIS-044/Q-48): eierens dashbord-handling for å opprette en bedrifts-tenant (`POST /owner/business-tenants`). DORMANT: uten verdien svarer ruten 404;
   * `main.ts` setter den KUN når `JARVIS_BUSINESS_TENANT_PROVISIONING=true`. Ruten krever eier-grant, signert enhet (step-up) og typet bekreftelse, og er
   * ALDRI et modellverktøy. Poolen er runtime-poolen (RLS håndheves) - tjenesten trenger ingen admin-rolle.
   */
  businessTenants?: { pool: pg.Pool };
  /**
   * WP-G3 (D-465, UA-9): `/vision/*` (eierens kamera-/«sist sett»-flate og iPhone-opptak på forespørsel, se `vision-routes.ts`). DORMANT: uten verdien finnes ingen av rutene (404, identisk med main);
   * `main.ts` setter den KUN når `JARVIS_VISION_ENABLED=on`. Aldri et modellverktøy.
   */
  vision?: VisionApiDeps;
  /**
   * WP-G4 fiks-runde (D-466, B-MEDIUM-5): `/situations/signals/*` (eierens egen flate for hendelsesabonnementet: abonnementer, status, logg, vurderinger, simulering, stille-timer-valget og tilbakemelding; se `situation-signal-routes.ts`).
   * DORMANT: uten verdien finnes ingen av rutene (404, identisk med main); `main.ts` setter den KUN med `JARVIS_SITUATION_SIGNALS=on`. Aldri et modellverktøy.
   */
  situationSignals?: SituationSignalApiDeps;
  /**
   * WP-D2 (UA-3 «churn/product usage»): innkommende webhook for produktbruk-hendelser fra eierens egne produkter (`POST /webhooks/product-usage`). DORMANT: uten verdien
   * svarer ruten 404; `main.ts` setter den KUN når `JARVIS_PRODUCT_USAGE_TENANT_ID` er satt. Det finnes ingen identitet å oppløse her: autentiseringen ER HMAC-signaturen
   * (`X-Jarvis-Signature: t=<unix>,v1=<hex>` over `<t>.<rå kropp>`, ±300 s replay-vindu, konstant-tid-sammenligning) som `ProductUsageService.ingestWebhook()` håndhever FØR
   * noe parses eller skrives. Tenanten er eier-konfigurert, aldri avledet fra innholdet.
   */
  productUsage?: { service: ProductUsageService };
  /**
   * WP-G1 (D-463, UA-7 Communications Hub - resterende deler). DORMANT og `NOT VERIFIED`: `main.ts` setter hver del KUN med sitt eget flagg (`JARVIS_COMMS_WEBHOOKS` / `JARVIS_COMMS_OUTBOUND`); uten verdien finnes ingen av rutene
   * (404, identisk med main) og de er heller ikke i den strenge per-IP-grensen.
   *  - `webhooks`: `POST|GET /webhooks/comms/{slack,meta,twilio,telnyx}` - KUN leverandørene i `providers`. SAMME «signatur ER autentisering»-prinsipp som `/webhooks/stripe`: ingen identitet å oppløse, rå kropp med hard
   *    størrelsesgrense FØR signaturen, svar uten innholdsekko. Innholdet er UBETRODD data i Ingestion Zone (ingen vei til verktøy/modell/utsendelse) - se `@jarvis/comms` `webhooks/ingest.ts`.
   *  - `outbound`: eierens `POST /comms/preview` (tørrkjøring av policyen) og `POST /comms/action`. Grant -> KUN den suverene eieren (`ownerGate`) -> step-up (signert enhet) for sending/redigering/sletting/konto-administrasjon -> `gateway.execute()`
   *    (policy, eier-binding, klasse D-kjeden, idempotens, varsling). Ruten har ingen egen sendevei og ingen egen sjekk å omgå, og er ALDRI et modellverktøy.
   */
  comms?: {
    /** `bodyRead` (FIX-2, runde 2): lesefrist og global samtidighetsgrense for store kropper; utelatt = standardverdiene (`DEFAULT_WEBHOOK_BODY_READ`). Kun testene setter den. */
    webhooks?: { service: CommsWebhookService; providers: ReadonlySet<CommsWebhookProvider>; bodyRead?: Partial<WebhookBodyReadConfig> };
    outbound?: { gateway: ToolGateway; funnel: OutboundFunnel };
  };
  /**
   * Remediering del 2 (JARVIS-065): den ENE validerte eier-identiteten (fra `loadOwnerConfig`). Brukes KUN til å fylle
   * visningsfeltene (`person_id`/`tenant_id`) i de statiske sidene - aldri som autoritet (autoritet kommer alltid fra
   * en verifisert grant). Uten verdien svarer de brukervendte sidene 503 `owner_not_configured`.
   */
  owner?: { tenant_id: string; person_id: string };
  /**
   * Gjennomgang av PR #324 (M3): EIER-PORTEN for incident-livssyklusen (`/incidents/transition`), reparasjon (`/incidents/repair`), driftsoversikten (`/infra/overview`) og skymutasjonene (`/infra/cloud/mutate`).
   * I drift: `ownerPredicate(ownerAuthority)` (apps/api/src/control-center/register.ts) - DET SAMME predikatet som kontrollsentrene og Policy Gateway bruker (`resolveAuthorityMode(...) === "SOVEREIGN"`: eier-person,
   * eier-tenant, ingen delegasjon), aldri en egen sammenligning her. FAIL-CLOSED: uten verdien (eller ved en kastet feil) nektes alle med `owner_required`.
   */
  ownerGate?: (identity: IdentityContext) => boolean;
  /**
   * WP-D3 (UA-4 Growth, D-459): eier-rutene for SKRIVING mot annonse-/analyseplattformene (`POST /growth/mutate`), lesing (`/growth/read`), journal (`/growth/writes/list`) og eksperimentregisteret
   * (`/growth/experiments`). DORMANT: uten verdien svarer rutene 404; `main.ts` setter den KUN når `JARVIS_GROWTH_WRITE_PLATFORMS` er ikke-tom (skriving) eller `JARVIS_GROWTH_EXPERIMENTS=on` (eksperimenter).
   * Utførelsen går UTELUKKENDE via `ToolGateway.execute()` (policy, mål-autorisasjon, step-up, klasse D-kjeden) - rutene omgår ingenting.
   */
  growthWrites?: { executor: GrowthWriteExecutorDeps; /** Skriving/lesing/journal (`/growth/mutate|read|writes/list`) finnes KUN når minst én plattform er slått på (`JARVIS_GROWTH_WRITE_PLATFORMS`). */ writes: boolean; experiments: boolean };
  /**
   * WP-G2 (D-464, UA-8 Personal Twin): rutene under `/personal/*` (kritiske hjem-/bilhandlinger, familie, helse-inntak, ...). DORMANT: uten verdien svarer `/personal/*` 404, identisk med main; `main.ts` setter den KUN når
   * minst ett `JARVIS_PERSONAL_*`-flagg er på, og hver rutefamilie finnes kun med sitt eget flagg. Se `personal-routes.ts`/`personal-wiring.ts`.
   */
  personal?: PersonalApiDeps;
}

export interface HealthStatus {
  status: "ok";
  service: "jarvis-api";
  version: string;
  time: string;
}

export function healthStatus(): HealthStatus {
  return { status: "ok", service: "jarvis-api", version: "0.1.0", time: new Date().toISOString() };
}

/**
 * D-393 (JARVIS-026): ekte beredskap. `/health` var en konstant «ok» - compose-helsesjekker og `depends_on` så «frisk» selv om databasen var
 * borte. Når `ApiDeps.readiness` er satt, svarer `/health` og `/ready` 503 med per-komponent-status ved svikt; uten den (ren helse-modus,
 * ingen avhengigheter konfigurert) er prosessen sin egen eneste avhengighet og svaret er uendret. `/live` er alltid ren prosess-liveness.
 */
export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, "ok" | string>;
}

/** Bygger en readiness-sjekk som kjører hver sonde med tidsavbrudd og gjenbruker siste svar kort (ingen sonde-storm fra helsesjekker). */
export function makeReadiness(
  probes: Record<string, () => Promise<unknown>>,
  options: { timeoutMs?: number; cacheMs?: number; now?: () => number } = {}
): () => Promise<ReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const cacheMs = options.cacheMs ?? 3000;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: ReadinessResult } | undefined;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.result;
    const checks: Record<string, "ok" | string> = {};
    await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          probe(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })
        ]);
        checks[name] = "ok";
      } catch (err) {
        checks[name] = `unavailable:${(err as Error).message.slice(0, 60)}`;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    const result: ReadinessResult = { ready: Object.values(checks).every((v) => v === "ok"), checks };
    cached = { at: now(), result };
    return result;
  };
}

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): kroppen inneholder nå
 * IKKE ETT ENESTE identitetsbærende felt.
 *
 * D-130-runden fjernet `person_id`/`device_id`/`auth_strength`, men beholdt
 * `session_id` som bevis - og slo opp `person_id`/`device_id` fra sesjonsraden
 * via `sessions.getActive()`. Reviewen påviste at det gjorde
 * SAMTALEKONTINUITET om til DEVICE-AUTHENTICATION: en sesjon deles bevisst
 * mellom personens kanaler og `last_device_id` overskrives ved hvert
 * kanalbytte, så en eldre klient ble re-attribuert til den sist aktive
 * enhetens identitet, en tilbakekalt nøkkel fortsatte å virke, og en
 * `TelegramOwnerAuthority`-sesjon (`active`) ble oppgradert til `signed`.
 *
 * Nå presenteres KUN et `grant_token`: et serverutstedt, avgrenset og
 * revokerbart bevis (`session_grants`, migrasjon 053) bundet til NØYAKTIG én
 * bevist enhet, ett autorisert scope, én kanal og et utløp.
 * `tenant_id`/`memory_space`/`channel` er FJERNET fordi de nå leses ut av
 * grantet - en klient kan ikke lenger be om et annet scope enn det den faktisk
 * er autorisert for. Vil den ha en annen memory space, må den autorisere på
 * nytt (én signatur). `session_id` returneres i SVARET som ren
 * samtalekontinuitet, men godtas aldri mer som input.
 */
interface ChatBody {
  grant_token: string;
  message: string;
  /** BO-12 §33: valgfri owner-override av LLM-provider (router §38-semantikk). */
  provider?: string;
}

/** Kroppen for `/brief` - samme grant-baserte autoritet som `/chat`, uten `message`. */
interface BriefBody {
  grant_token: string;
}

/** Nøkkel-hvitelistene for de to kroppene - alt annet er fail-closed avvist. */
const CHAT_BODY_KEYS = ["grant_token", "message", "provider"] as const;
const BRIEF_BODY_KEYS = ["grant_token"] as const;

/**
 * D-199: `/executive/query` sin egen, EKSPLISITTE hvitelilste - kun de to
 * LESE-handlingene (klasse A) `executive.*` selv definerer i dag. Enhver
 * fremtidig mutasjonshandling (pause_domain/activate_kill_switch/
 * revoke_device/osv.) MÅ IKKE kunne nås via denne ruten uten en bevisst,
 * separat kodeendring her - en hardkodet allowlist, ALDRI "alt executive.*
 * tilbyr", er nettopp poenget: ruten skal forbli lese-kun helt til en egen,
 * separat gjennomgått slice bevisst utvider den.
 */
// Task #119 (D-211): `get_connector_status` er en RENT LESENDE (klasse A)
// tredje oppføring - "test connector"/"lim inn nøkkel"-mutasjoner er BEVISST
// IKKE lagt til her, samme "P0 lese FØR P1 mutasjon"-rekkefølge D-199 selv
// dokumenterte for denne allowlisten.
// D-230 (K2 governance-dashboard): `get_delegation_board` er den FJERDE
// lese-handlingen - allerede bygget/host-provent klasse A (executive/
// transport.ts) som KUN var ikke-allowlistet ennå, INGEN ny logikk her.
// Delegeringstavlen leses via /executive/query (IKKE /governance/query) -
// samme "komposisjon, ingen egen tabell"-begrunnelse som selve handlingen.
const EXECUTIVE_QUERY_ACTIONS = [
  "get_attention_queue", "get_control_surface_status", "get_connector_status", "get_delegation_board"
] as const;
const EXECUTIVE_QUERY_BODY_KEYS = ["grant_token", "action", "parameters"] as const;

/**
 * WP-H0 (UA-11 Admin Control Center): kontrollsentrene leses via to EGNE, LESE-KUN ruter (`POST /control/centers` = oversikt, `POST /control/center` = ett senter) som begge går via ToolGateway
 * (`executive.get_control_center`, klasse A, eier-kun port i verktøydefinisjonen) - SAMME grant-autoritet, avslagsrekkefølge og kroppsdisiplin som `/executive/query`. Kroppen har ingen identitetsfelt
 * og ingen handlings-/parameterfelt: kun `center` (en av de ti kjente id-ene). Rutene muterer ALDRI noe; handlingene i rapporten peker på de EKSISTERENDE mutasjonsrutene (`/executive/mutate` m.fl.),
 * som håndhever step-up, policy og revisjon som før.
 */
const CONTROL_CENTERS_BODY_KEYS = ["grant_token"] as const;
const CONTROL_CENTER_BODY_KEYS = ["grant_token", "center"] as const;

/**
 * D-421 (UA0-RUNRATE): run-rate og connector maintenance ledger. EGNE ruter med EGNE hardkodede allowlister (lese-kun og skrive-kun holdt adskilt,
 * samme disiplin som `/executive/query` vs `/owner-controls/...`). Skriving krever grant fra en innrullert enhet; modellen har kun lese-handlingene.
 */
const RUN_RATE_QUERY_ACTIONS = ["get_cost_overview", "list_connector_maintenance"] as const;
const RUN_RATE_MUTATE_ACTIONS = ["record_connector_maintenance"] as const;

/**
 * WP-C4: Value Center (bruk per verdiløkke, kun tall). EGEN lese-rute med EGET hardkodet allowlist (`/executive/query` forblir uendret og lese-kun): kun `get_value_report`, ingen skriving finnes. Samme grant-baserte
 * autoritet som `/runrate/query`; tenanten kommer fra det løste grantet (aldri fra body), og kallet går via `ToolGateway.execute()` (policy + revisjon).
 */
const VALUE_QUERY_ACTIONS = ["get_value_report"] as const;
/**
 * WP-E1 (UA-5, JARVIS-068): driftsstatus (åpne hendelser, skymål, produsenthelse). EGEN lese-rute med EGET hardkodet allowlist - `/executive/query` forblir uendret og lese-kun (en test låser den til fire handlinger).
 * Kun `get_infra_status`; verktøyskjemaet har ingen parametre, så ingenting fra kroppen (tenant/person/rom) videresendes.
 */
const INFRA_OVERVIEW_ACTIONS = ["get_infra_status"] as const;

/**
 * D-230 (K2 governance-dashboard): `@jarvis/governance` (migrasjon 059) var
 * FERDIG BYGGET og testet (`modules/governance/test/`), men uten HTTP-rute/
 * UI - denne allowlisten er den LESE-KUN halvdelen, SAMME "hardkodet
 * allowlist, ALDRI hele verktøyet"-disiplin som `EXECUTIVE_QUERY_ACTIONS`.
 * Speiler EKSAKT de fem `read(...)`-handlingene `governanceToolDefinitions()`
 * (modules/governance/src/transport.ts) selv definerer.
 */
const GOVERNANCE_QUERY_ACTIONS = ["list_decisions", "list_scenarios", "list_risks", "list_goals"] as const;

/**
 * D-230: skrive-halvdelen. ALLE ti handlingene er klasse A/B per
 * `governanceToolDefinitions()` - INGEN klasse C/D finnes i
 * `@jarvis/governance` (rene journalposter, aldri en ekstern mutasjon), så
 * denne ruten krever INGEN ekstra bekreftelsesdialog-plikt slik
 * `/executive/mutate` sine klasse D-handlinger gjør (se `dashboard.html` sin
 * "Styring (K2)"-seksjon: skriveoperasjoner går direkte, samme mønster som
 * `mutateOwnerControls()` sine klasse C-handlinger allerede gjør uten modal).
 */
const GOVERNANCE_MUTATE_ACTIONS = [
  "create_decision", "reverse_decision", "create_scenario", "update_scenario_status",
  "create_risk", "update_risk", "create_goal", "update_goal_status",
  "add_key_result", "update_key_result_progress"
] as const;

/**
 * Task #122 (D-213): eierens FØRSTE mutasjonsrute på dashbordet.
 * `/executive/query` sin allowlist over FORBLIR lese-kun for alltid (D-199s
 * egen regel) - dette er derfor en HELT NY, egen HTTP-rute
 * (`POST /owner-controls/connector-credentials`), ALDRI en utvidelse av
 * `EXECUTIVE_QUERY_ACTIONS`. Gjenbruker SAMME grant-baserte autoritetsmodell/
 * kroppsform (`EXECUTIVE_QUERY_BODY_KEYS`) og `deps.executive.gateway` - DEN
 * SAMME `toolGateway`-instansen `owner_controls.*` allerede er registrert på
 * i main.ts (ingen ny ApiDeps-nøkkel, ingen parallell autorisasjonsvei).
 * Allowlisten er BEVISST begrenset til NØYAKTIG disse to handlingene - kill
 * switch/frys/tilbakekall/enhetstilbakekall forblir UNÅDBARE fra denne
 * ruten, samme "hardkodet allowlist, ALDRI hele verktøyet"-disiplin som
 * `EXECUTIVE_QUERY_ACTIONS` selv.
 */
export const OWNER_CONTROLS_CONNECTOR_ACTIONS = ["set_connector_credential", "test_connector"] as const;
/**
 * WP-D2 (JARVIS-044/Q-48): `POST /owner/business-tenants`. Egen rute med egen, hardkodet kropp: `preview` skriver ALDRI; `provision` skriver først når
 * `confirm === true` OG `confirm_tenant_id` er NØYAKTIG den tenant-id-en `preview` viste (typet bekreftelse - en blind `confirm: true` er ikke nok).
 * `confirm_tenant_id` er bevisst ikke i `FORBIDDEN_IDENTITY_BODY_KEYS` (eksakt nøkkelmatch): den er en bekreftelse, aldri en identitet.
 */
const BUSINESS_TENANT_BODY_KEYS = ["grant_token", "action", "name", "slug", "confirm", "confirm_tenant_id"] as const;
const BUSINESS_TENANT_ACTIONS = ["preview", "provision"] as const;
const BUSINESS_TENANT_STATUS: Record<string, number> = {
  name_invalid: 400, slug_invalid: 400, owner_invalid: 400,
  tenant_exists_with_other_kind: 409, tenant_name_mismatch: 409, owner_person_not_found: 409
};


/**
 * D-367: eierens godkjenning av modellens minneforslag (`memory.propose` -> karantene). EGEN rute og EGET hardkodet
 * allowlist; handlingene står IKKE på modellens verktøyflate, og ruten krever et grant fra en innrullert enhet - modellen
 * kan altså aldri godkjenne sine egne forslag. Samme kroppsform/avslagsrekkefølge som `/owner-controls/connector-credentials`.
 */
const CONFIRMATION_ACTIONS = ["list", "decide"] as const;
const MEMORY_PROPOSAL_ACTIONS = ["list_proposals", "approve_proposal", "reject_proposal"] as const;

/**
 * Task #124 (UA-11 Executive dashboard-UI, MUTASJONS-DELEN, D-199 §7s eget
 * eksplisitt utsatte gap): de 12 `executive.*`-mutasjonshandlingene
 * (`pause_domain`/`resume_domain`/`resolve_situation`/`activate_kill_switch`/
 * `deactivate_kill_switch`/`freeze_connector`/`unfreeze_connector`/
 * `revoke_credential`/`restore_credential`/`revoke_device`/
 * `enable_finance_kill_switch`/`disable_finance_kill_switch`) - ALLE
 * allerede bygde, host-proven `executive.*`-videresendinger til
 * `situations.*`/`owner_controls.*`/`finance.*` (D-171/D-174/D-179), INGEN
 * ny logikk her. EGEN, HELT NY HTTP-rute (`POST /executive/mutate`) - ALDRI
 * en utvidelse av `EXECUTIVE_QUERY_ACTIONS`, som D-199 selv sier skal
 * forbli lese-kun for alltid (samme "hardkodet allowlist, ALDRI hele
 * verktøyet"-disiplin som `OWNER_CONTROLS_CONNECTOR_ACTIONS`). Klientsidens
 * bekreftelsesdialoger/klasse-D-preflight-visning (D-199 §7s eksplisitte
 * krav) er BEVISST håndhevet KUN i `dashboard.html` (UI-lag, se der) - denne
 * ruten selv håndhever INGEN ekstra "har eieren bekreftet"-tilstand utover
 * `ToolGateway.execute()` sin EGEN, allerede eksisterende klasse D-preflight/
 * autoritetssjekk (samme dobbelt-gatede modell som §2/§6 i design-notatet
 * beskriver - denne ruten legger ALDRI til en tredje, egen autoritetsrunde).
 *
 * WP-H0 (JARVIS-087): den 13. handlingen, `cancel_task`, er kontrollsenterets avbryt-handling for en bakgrunnsjobb/agent. Den er et gjennomslag til den EKSISTERENDE kanselleringsveien (`TaskService.cancel`, samme som
 * chatens «avbryt jobb <id>»), eier-kun (verktøydefinisjonens parameterAuthorizer), klasse B og en stopp-handling uten step-up (se `STEP_UP_EXEMPT_ACTIONS`). Allowlisten er ellers uendret.
 *
 * WP-H2 (gjennomgang M1): de to FLAGGSTYRTE handlingene står IKKE i denne listen (den er NØYAKTIG main sin, 13 handlinger) men i `EXECUTIVE_MUTATE_FLAGGED_ACTIONS` under.
 */
export const EXECUTIVE_MUTATE_ACTIONS = [
  "pause_domain", "resume_domain", "resolve_situation",
  "activate_kill_switch", "deactivate_kill_switch",
  "freeze_connector", "unfreeze_connector",
  "revoke_credential", "restore_credential", "revoke_device",
  "enable_finance_kill_switch", "disable_finance_kill_switch",
  "cancel_task"
] as const;

/**
 * WP-H2: to tilføyelser til `/executive/mutate` - hver bak sitt EGET flagg (AV som standard) og BARE akseptert når verktøyet faktisk er REGISTRERT i gatewayen (`deps.executive.gateway.get("executive", navn)`):
 *  - `revoke_autonomy_binding` (14.): tilbakekall av eierens autonomi-binding for ett domene (klasse C, gjennomslag til `situations.clear_autonomy_policy`, eier-kun, KREVER step-up: ikke unntatt i `STEP_UP_EXEMPT_ACTIONS`,
 *    og gatewayen krever den også selv: `step_up_required`).
 *  - `run_golden_suite` (15.): golden-suite-knappen. BEVISST den ENESTE lesende handlingen i disse listene: den er en deterministisk selvtest uten sideeffekter (klasse A), men plassert her fordi knappen skal gå
 *    gjennom SAMME grant-, step-up- (signert enhet) og revisjonsvei som alle andre kontrollsenter-knapper - ikke en ny rute, og ikke `/executive/query` (som ikke har step-up). Tool-porten krever i tillegg eier + signert økt.
 * Gjennomgang M1: med flaggene AV er navnene IKKE kjent for ruten og svarer NØYAKTIG som main svarer på et ukjent navn (400 `action_not_allowed` FØR grantet løses, ingen `tool.denied`-revisjonsrad) - bevist mot en opptaket
 * baseline fra ren main i `wph2-flag-off-main-parity.test.ts`. Kun CONTROL_ACTION_ALLOWED (knappenes tillatelsestabell) kjenner alle 16 navnene.
 *
 * WP-B3 (D-475, EV-23): en TREDJE flaggstyrt handling, `record_evolution_decision` (16.): eierens avgjørelse (godkjenn/avvis/utsett) om ett endringsforslag fra Evolusjon-senteret (klasse C, eier + signert enhet, KREVER step-up:
 * ikke unntatt i `STEP_UP_EXEMPT_ACTIONS`, og gatewayen krever den også selv). KUN en registrering i revisjonssporet (`evolution.owner_decision`) - ingenting utføres, godkjennes i endringsregisteret eller aktiveres (selvendring er frosset, D-397).
 * Samme regler som de to andre: kjent for ruten KUN når verktøyet faktisk er registrert (`JARVIS_CONTROL_EVOLUTION_APPROVAL=on` + Evolusjon-senteret koblet inn); ellers 400 `action_not_allowed` som for ethvert ukjent navn.
 */
export const EXECUTIVE_MUTATE_FLAGGED_ACTIONS = ["revoke_autonomy_binding", "run_golden_suite", "record_evolution_decision"] as const;

/**
 * D-475: er `center` et kjent valg for `/control/center`? Masterplanens ti alltid; et TILLEGGSSENTER (Evolusjon) kun når lese-verktøyet er registrert i gatewayen (flagget på og senteret koblet). Med flagget AV er «evolution» et ukjent senter og
 * ruten svarer NØYAKTIG som main svarer på ethvert ukjent navn (400 `unknown_center`, FØR grantet løses). En gateway uten `get` (testdobler) registrerer ingen tilleggssentre (fail-closed).
 */
function controlCenterKnown(center: string, gateway: Pick<ToolGateway, "get">): boolean {
  if (!isControlCenterId(center)) return false;
  if (!isExtensionControlCenterId(center)) return true;
  const tool = CONTROL_CENTER_READ_TOOLS.find((t) => t.center === center);
  return tool !== undefined && typeof gateway.get === "function" && gateway.get("executive", tool.action) !== undefined;
}

/** Er handlingen kjent for `/executive/mutate`? Main sin 13, pluss de flaggstyrte kun når verktøyet er registrert. En gateway uten `get` (testdobler) registrerer ingen av de flaggstyrte (fail-closed). */
function executiveMutateActionKnown(action: string, gateway: Pick<ToolGateway, "get">): boolean {
  if ((EXECUTIVE_MUTATE_ACTIONS as readonly string[]).includes(action)) return true;
  if (!(EXECUTIVE_MUTATE_FLAGGED_ACTIONS as readonly string[]).includes(action)) return false;
  return typeof gateway.get === "function" && gateway.get("executive", action) !== undefined;
}

/**
 * Fail-closed parsing, speilbildet av `.strict()`: et forsøk på å sende f.eks.
 * `session_id`, `tenant_id`, `person_id`, `memory_space`, `channel` eller
 * `auth_strength` gir `malformed_request` i stedet for å bli stille ignorert.
 * Stille ignorering er farlig her: en klient (eller en fremtidig
 * refaktorering) kunne ellers TRO at feltet virket.
 */
/**
 * Remediering del 2 (JARVIS-001): SAMME avvisningsrekkefølge og -koder som `authedRequest` for de grant-beskyttede rutene som
 * tolker kroppen selv (chat/brief/executive/governance): ikke-objekt -> 400, forbudt identitetsfelt -> 400
 * `identity_field_forbidden`, ukjent felt -> 400, manglende grant -> 401 `grant_required`. Sender svaret selv og returnerer null.
 */
function grantBodyOrReject<K extends readonly string[]>(res: ServerResponse, raw: unknown, allowedKeys: K): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    json(res, 400, { error: "malformed_request", request_id: requestIdOf(res) });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const forbidden = FORBIDDEN_IDENTITY_BODY_KEYS.find((key) => key in obj);
  if (forbidden !== undefined) {
    json(res, 400, { error: "identity_field_forbidden", field: forbidden, request_id: requestIdOf(res) });
    return null;
  }
  if (Object.keys(obj).some((key) => !(allowedKeys as readonly string[]).includes(key))) {
    json(res, 400, { error: "malformed_request", reason: "unknown_field", request_id: requestIdOf(res) });
    return null;
  }
  if (typeof obj["grant_token"] !== "string" || obj["grant_token"].length === 0) {
    json(res, 401, { error: "grant_required", request_id: requestIdOf(res) });
    return null;
  }
  return obj;
}


/**
 * D-131 funn 1: DEN ENE veien fra et framlagt bærer-bevis til en
 * kontraktvalidert `IdentityContext`.
 *
 * To uavhengige porter, i denne rekkefølgen:
 *
 *   1. `grants.verify()` - er beviset selv fortsatt gyldig? (finnes / ikke
 *      utløpt / ikke tilbakekalt / enhetsnøkkelen er fortsatt NØYAKTIG den som
 *      ble bevist da grantet ble utstedt). Det er her tilbakekalling og
 *      nøkkelrotasjon slår inn STRUKTURELT, ved hvert eneste kall.
 *   2. `identity.resolveIdentity()` - er kombinasjonen person↔tenant↔enhet↔
 *      space fortsatt tillatt NÅ? Et grant fryser ikke medlemskap: mister
 *      personen tilgangen, eller slettes enheten/space-en, nektes kallet
 *      umiddelbart selv om grantet ennå ikke er utløpt.
 *
 * Hvert felt kommer fra grant-raden - `auth_strength` inkludert. En transport
 * kan derfor ikke lenger «oppgradere» seg selv: en `active`-autoritet (f.eks.
 * Telegram sin bot-token-baserte sesjon) forblir `active` hele veien, mens
 * kun et enhetssignert grant er `signed`.
 */
async function resolveFromGrant(
  deps: ApiDeps,
  grantToken: string,
  res?: ServerResponse
): Promise<{ ok: true; identity: IdentityContext } | { ok: false; reason: string; responded?: true }> {
  const verified = await deps.grants.verify(grantToken);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  const grant = verified.grant;
  const resolved = await deps.identity.resolveIdentity({
    person_id: grant.person_id,
    tenant_id: grant.tenant_id,
    memory_space: grant.memory_space,
    session_id: grant.session_id,
    device_id: grant.device_id,
    channel: grant.channel,
    auth_strength: grant.auth_strength
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  // Arkitekt-review (P3): per-enhet rate limit gjelder ALLE grant-beskyttede ruter (ikke bare `authedRequest`-rutene) - et gyldig
  // grant er det som identifiserer enheten, så grensen tas først ETTER vellykket verifisering. Svaret (429) sendes her.
  if (res) {
    const limiters = limiterRegistry.get(res);
    if (limiters && !limiters.device.take(`${resolved.identity.tenant_id}|${resolved.identity.device_id}`)) {
      json(res, 429, { error: "rate_limited", request_id: requestIdOf(res) });
      return { ok: false, reason: "rate_limited", responded: true };
    }
  }
  return { ok: true, identity: resolved.identity };
}

const WEB_INDEX = fileURLToPath(new URL("../../web/index.html", import.meta.url));
/** D-199: samme statiske servering som WEB_INDEX over, egen side for dashboard.html. */
const WEB_DASHBOARD = fileURLToPath(new URL("../../web/dashboard.html", import.meta.url));
/** WP-H0: kontrollsentrene (UA-11 Admin Control Center) - egen, selvstendig side (ingen endring i dashbord/skall), samme statiske servering og nonce-CSP som de øvrige. */
const WEB_CONTROL = fileURLToPath(new URL("../../web/control.html", import.meta.url));
/**
 * D-361 (Tobias direkte i chat: "sinnsyk interface ... slipper og skrive 3
 * forskjellige url"): en samlet HUD-skall-side som viser WEB_INDEX/WEB_VOICE/
 * WEB_DASHBOARD som samme-origin iframes bak faner - ingen av de tre sin
 * egen logikk er duplisert/omskrevet. `/` serverer nå dette skallet;
 * chat-siden flyttet til `/chat` (fortsatt direkte nåbar, nå også iframe-
 * kilden for Samtale-fanen) slik at skallet har noe å peke chat-fanen til.
 */
const WEB_COMMAND = fileURLToPath(new URL("../../web/command.html", import.meta.url));
/**
 * D-212 (task #120): samme statiske servering som WEB_INDEX/WEB_DASHBOARD
 * over - `voice.html` snakker IKKE med denne Core-prosessen for selve
 * talestrømmen (den kobler direkte til den separate voice-gateway-prosessen
 * sin WebSocket, CLAUDE.md ufravikelig regel 5). Core serverer kun siden og
 * de eksisterende enhets-/grant-rutene (`/devices/challenge`,
 * `/session/authorize`) siden gjenbrukes for enhetsbeviset.
 */
const WEB_VOICE = fileURLToPath(new URL("../../web/voice.html", import.meta.url));

/** Størrelsesbegrenset JSON-parsing (413 over grensen, 400 `malformed_json` ved ugyldig JSON). `maxBytes` (kun WP-G3 sin bildeopplasting) heves bare for ruten som eksplisitt ber om det. */
async function readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  return maxBytes === undefined ? readJsonBody(req) : readJsonBody(req, maxBytes);
}

/**
 * Autentiseringsrutene (`/session/authorize` m.fl.) har alltid svart med et
 * deterministisk `403 malformed_evidence` på ugyldig JSON - aldri en feil som
 * skiller «parseren knakk» fra «beviset holdt ikke». Størrelsesgrensen (413)
 * og alle andre feil propageres uendret.
 */
async function readBodyOrUndefined(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    if (err instanceof HttpError && err.code === "malformed_json") {
      return undefined;
    }
    throw err;
  }
}

/**
 * D-109: rå byte-for-byte body - `readBody()` over ville JSON.parse()-et og
 * dermed gjort HMAC-signaturverifisering (som må hashe EKSAKT det Stripe
 * sendte) umulig å reprodusere korrekt. Størrelsesgrensen gjelder FØR
 * signaturkontrollen (JARVIS-063).
 */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return readRawBodyLimited(req);
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function requestIdOf(res: ServerResponse): string {
  const header = res.getHeader("x-request-id");
  return typeof header === "string" ? header : "unknown";
}

/**
 * Rate limits (JARVIS-063). Per-IP FØR autentisering, per-device ETTER at
 * grantet er løst. Tallene er bevisst romslige for én eier med noen få
 * enheter, men gjør brute force/flom mot kontrollflatene kostbart.
 */
export interface ApiRateLimits {
  /** Alle forespørsler per klient-IP per minutt. */
  perIpPerMinute: number;
  /** Auth-/innrulleringsrutene per klient-IP per minutt (nonce-/bevisflater). */
  authPerIpPerMinute: number;
  /** Grant-beskyttede kontrollruter per enhet per minutt. */
  perDevicePerMinute: number;
}

const DEFAULT_RATE_LIMITS: ApiRateLimits = { perIpPerMinute: 600, authPerIpPerMinute: 30, perDevicePerMinute: 120 };

interface RateLimiters {
  ip: RateLimiter;
  auth: RateLimiter;
  device: RateLimiter;
}

const AUTH_ROUTES: ReadonlySet<string> = new Set([
  "/devices/challenge", "/devices/register", "/session/authorize", "/voice/session/authorize",
  // WP-D2: HMAC-autentisert, offentlig nåbar rute - samme strenge per-IP-grense som de andre autentiseringsflatene (en gyldig avsender trenger få, store kall).
  "/webhooks/product-usage"
]);

/**
 * WP-G1 (D-463): de fire signerte kommunikasjons-webhook-rutene. De er KUN med i den strenge per-IP-grensen (som `AUTH_ROUTES`) når `deps.comms.webhooks` er satt og leverandøren er slått på - uten flagg er stien
 * en vanlig 404 helt uten grensen (flagg AV = identisk med main, også for rate limits; `AUTH_ROUTES` er bevisst uendret).
 */
const COMMS_WEBHOOK_ROUTES: ReadonlyMap<string, CommsWebhookProvider> = new Map<string, CommsWebhookProvider>([
  ["/webhooks/comms/slack", "slack"], ["/webhooks/comms/meta", "meta"], ["/webhooks/comms/twilio", "twilio"], ["/webhooks/comms/telnyx", "telnyx"]
]);

function commsStrictRoutes(deps: ApiDeps | undefined): ReadonlySet<string> {
  const webhooks = deps?.comms?.webhooks;
  if (webhooks === undefined) return new Set<string>();
  return new Set([...COMMS_WEBHOOK_ROUTES].filter(([, provider]) => webhooks.providers.has(provider)).map(([path]) => path));
}

/** Eierens `/comms/action`: kroppsnøklene (identitet kan aldri være med - `grantBodyOrReject`), og hvilke handlinger som IKKE krever step-up (leser + registrering av en avmelding, som reduserer risiko). */
const COMMS_ACTION_BODY_KEYS = ["grant_token", "action", "parameters", "idempotency_key"] as const;
const COMMS_PREVIEW_BODY_KEYS = ["grant_token", "parameters"] as const;
const COMMS_STEP_UP_EXEMPT: ReadonlySet<string> = new Set([...COMMS_READ_ACTIONS, ...COMMS_VENDOR_READ_ACTIONS, ...COMMS_CONTACT_READ_ACTIONS, ...COMMS_MEETING_READ_ACTIONS, "record_opt_out"]);

/**
 * B-M5: ÉN normalisering av forespørselsstien, brukt av BÅDE de strenge per-IP-begrenserne og rutingen (`route()` bruker `new URL(...).pathname`). Begrenseren nøklet før på den RÅ stien, så `/webhooks/comms/./slack` og
 * `/webhooks/comms/%2e/slack` (samme rute etter URL-normalisering) aldri traff grensen (kun den romslige 600/min/IP-grensen gjaldt). Samme mønster gjaldt de eksisterende `AUTH_ROUTES`. Ugyldig URL faller tilbake til den rå stien.
 */
export function normalizedRequestPath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return (rawUrl ?? "/").split("?")[0] ?? "/";
  }
}

const limiterRegistry = new WeakMap<ServerResponse, RateLimiters>();

function limitersFor(limits: ApiRateLimits): RateLimiters {
  const minute = 60_000;
  return {
    ip: new RateLimiter(limits.perIpPerMinute, minute),
    auth: new RateLimiter(limits.authPerIpPerMinute, minute),
    device: new RateLimiter(limits.perDevicePerMinute, minute)
  };
}

export function createApiServer(deps?: ApiDeps): Server {
  const limiters = limitersFor({ ...DEFAULT_RATE_LIMITS, ...(deps?.rateLimits ?? {}) });
  const commsStrict = commsStrictRoutes(deps);
  return createServer((req, res) => {
    const requestId = newRequestId();
    res.setHeader("x-request-id", requestId);
    limiterRegistry.set(res, limiters);
    const peer = clientKey(req);
    const path = normalizedRequestPath(req.url);
    const allowed = limiters.ip.take(peer) && (!(AUTH_ROUTES.has(path) || commsStrict.has(path)) || limiters.auth.take(`${peer}|${path}`));
    if (!allowed) {
      req.resume();
      res.setHeader("retry-after", String(limiters.ip.retryAfterSeconds(peer)));
      return json(res, 429, { error: "rate_limited", request_id: requestId });
    }
    void route(req, res, deps).catch((err: Error) => {
      // D-251 (live NAS-migreringsfunn): denne grenen logget FØR ingenting når
      // headers allerede var sendt (SSE-streamen fra /chat) - en feil etter
      // `res.writeHead(200, text/event-stream)` avsluttet streamen stille med
      // `res.end()` alene, usynlig for BÅDE klienten (ingen `error`-event) OG
      // server-loggen. Logg ALLTID, uansett hvilken gren som følger.
      //
      // JARVIS-064: klienten får ALDRI intern feiltekst (pg-feil, ID-er, stier) -
      // kun en generisk kode og request-ID-en; detaljene står i server-loggen.
      if (err instanceof HttpError) {
        if (!res.headersSent) {
          json(res, err.status, { error: err.code, request_id: requestId });
        } else {
          res.end();
        }
        return;
      }
      console.error(JSON.stringify({ msg: "route_unhandled_error", request_id: requestId, path, error: err.message }));
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error", request_id: requestId });
      } else {
        res.end();
      }
    });
  });
}

/**
 * JARVIS-001: DEN ENE inngangen for alle grant-beskyttede kontrollruter
 * (tasks/incidents/infra/observability/deployments). Identitet, tenant, person,
 * enhet, sesjon, kanal og auth-styrke utledes UTELUKKENDE fra det verifiserte
 * grantet - kroppen kan aldri bære dem. Et forsøk på det er en 400, ikke en
 * stille ignorering (en klient kunne ellers tro at feltet virket).
 *
 * Rekkefølge: kropp (størrelse/JSON) → forbudte identitetsfelt → hvitelistede
 * felt → grant-verifisering → enhet-rate-limit. En 401/403 gis FØR noen
 * domeneoperasjon er nådd.
 */
interface AuthedRequest {
  identity: IdentityContext;
  body: Record<string, unknown>;
}

async function authedRequest(
  req: IncomingMessage, res: ServerResponse, deps: ApiDeps, allowedKeys: readonly string[], maxBytes?: number
): Promise<AuthedRequest | null> {
  const raw = await readBody(req, maxBytes);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    json(res, 400, { error: "malformed_request", request_id: requestIdOf(res) });
    return null;
  }
  const body = raw as Record<string, unknown>;
  const forbidden = FORBIDDEN_IDENTITY_BODY_KEYS.find((key) => key in body);
  if (forbidden !== undefined) {
    json(res, 400, { error: "identity_field_forbidden", field: forbidden, request_id: requestIdOf(res) });
    return null;
  }
  const unknownKey = Object.keys(body).find((key) => key !== "grant_token" && !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    json(res, 400, { error: "malformed_request", reason: "unknown_field", request_id: requestIdOf(res) });
    return null;
  }
  const token = body["grant_token"];
  if (typeof token !== "string" || token.length === 0) {
    json(res, 401, { error: "grant_required", request_id: requestIdOf(res) });
    return null;
  }
  const resolved = await resolveFromGrant(deps, token, res);
  if (!resolved.ok) {
    if (resolved.responded) return null; // 429 er allerede sendt (per-enhet-grense)
    json(res, 403, { error: "identity_denied", reason: resolved.reason, request_id: requestIdOf(res) });
    return null;
  }
  const { grant_token: _omit, ...rest } = body;
  void _omit;
  return { identity: resolved.identity, body: rest };
}

/**
 * Gjennomgang av PR #324 (M3): `authedRequest` bekrefter bare at grantet er gyldig - IKKE at innehaveren er eieren. `/incidents/transition` merket derfor enhver autentisert person som `actor_kind: "owner"` (en
 * delegert/sekundær person i eierens tenant kunne lukke eierens hendelser og dermed dempe produsentene), og `/incidents/repair` og `/infra/overview` hadde ingen eier-sjekk. Denne porten bruker
 * `deps.ownerGate` (= kontrollsentrenes `ownerPredicate`, ingen ny logikk). Avslag: `403 owner_required` og en vanlig `tool.denied`-revisjonsrad (som H0), skrevet i AKTØRENS egen tenant. Fail-closed.
 */
async function requireOwner(
  res: ServerResponse, deps: ApiDeps, identity: IdentityContext, subject: { tool_id: string; action: string }
): Promise<boolean> {
  let allowed = false;
  try {
    allowed = deps.ownerGate !== undefined && deps.ownerGate(identity) === true;
  } catch {
    allowed = false;
  }
  if (allowed) return true;
  const reason = deps.ownerGate === undefined ? "owner_gate_not_configured" : "owner_required";
  const pool = deps.incidents?.pool;
  if (pool) {
    await withTenantTransaction(pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "tool.denied", decision: "DENY", reason, tool_id: subject.tool_id, action: subject.action })
    ).catch((err: unknown) => {
      console.error(JSON.stringify({ msg: "owner_gate_audit_write_failed", tool_id: subject.tool_id, action: subject.action, error: err instanceof Error ? err.message.slice(0, 80) : "unknown" }));
    });
  }
  json(res, 403, { error: "owner_required", reason, request_id: requestIdOf(res) });
  return false;
}

function fieldString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000) {
    throw new HttpError(400, "malformed_request", key);
  }
  return value;
}

function fieldOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : fieldString(body, key);
}

function fieldOptionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 4_000)) {
    throw new HttpError(400, "malformed_request", key);
  }
  return value as string[];
}

function fieldOptionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "malformed_request", key);
  }
  return value;
}

function fieldOptionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "malformed_request", key);
  }
  return value;
}

function fieldRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "malformed_request", key);
  }
  return value as Record<string, unknown>;
}

/** Fanger en domene-feil uten å lekke den: logges med request-ID, klienten får kun en generisk kode. */
function domainFailure(res: ServerResponse, status: number, code: string, err: unknown): void {
  console.error(JSON.stringify({ msg: "route_domain_failure", request_id: requestIdOf(res), code, error: (err as Error).message }));
  json(res, status, { error: code, request_id: requestIdOf(res) });
}

/**
 * WP-E1 (JARVIS-068): som `domainFailure`, men VÅRE egne, bevisste feilkoder (sannhetsregime `truth_*`, livssyklus `incident_*`, ulovlig overgang) vises til eieren som `reason`
 * (maks 80 tegn) - eieren må få vite HVORFOR «VERIFIED» eller en overgang avvises. Alt annet (pg-feil, stack) forblir generisk og kun i loggen.
 */
const OWN_INCIDENT_REASON = /^(truth_[a-z_]+|incident_[a-z_]+|diagnosis_[a-z_]+|invalid_incident_transition:[a-z_]+->[a-z_]+)$/;
function incidentDomainFailure(res: ServerResponse, status: number, code: string, err: unknown): void {
  const message = (err as Error).message ?? "";
  if (!OWN_INCIDENT_REASON.test(message)) return domainFailure(res, status, code, err);
  console.error(JSON.stringify({ msg: "route_domain_failure", request_id: requestIdOf(res), code, error: message }));
  json(res, status, { error: code, reason: message.slice(0, 80), request_id: requestIdOf(res) });
}

const INCIDENT_STATUSES: readonly IncidentStatus[] = ["open", "diagnosing", "repair_proposed", "repair_in_progress", "resolved", "wont_fix"];
/** WP-E1: hendelsen slik eieren ser den - fase (åpen/anerkjent/avbøtende/løst/lukket) i tillegg til den lagrede statusen, samme oversettelse overalt. */
function withPhase<T extends { status: IncidentStatus }>(incident: T): T & { phase: string; phase_no: string } {
  return { ...incident, phase: incidentPhase(incident.status), phase_no: incidentPhaseNo(incident.status) };
}


/**
 * Remediering del 2 (JARVIS-066): statiske sider får (a) en nonce-basert CSP (ingen `unsafe-inline`-script), (b) rammebeskyttelse
 * (`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` - command.html monterer de andre sidene som samme-origin iframes),
 * (c) `nosniff`/`no-referrer`, og (d) eier-identiteten injisert fra validert konfig i stedet for hardkodet i HTML.
 */
const OWNER_META_PLACEHOLDER = "<!--JARVIS_OWNER_META-->";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderStaticPage(html: string, nonce: string, owner?: { tenant_id: string; person_id: string }): string {
  const meta = owner
    ? `<meta name="jarvis-owner" content="${escapeAttribute(JSON.stringify({ tenant_id: owner.tenant_id, person_id: owner.person_id }))}">`
    : "";
  return html
    .replace(OWNER_META_PLACEHOLDER, meta)
    .replace(/<script>/g, `<script nonce="${nonce}">`)
    .replace(/<style>/g, `<style nonce="${nonce}">`);
}

export function staticPageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      // D-440: ingen inline style-attributter lenger (D-366 tillot dem via `style-src-attr 'unsafe-inline'`). Sidene bruker klasser og CSSOM
      // (`el.style.x = ...`, som CSP tillater); `<style>`-elementer krever nonce, og verken script-src eller style-src har unsafe-inline.
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      // Tale-gatewayen er en egen prosess på samme vert (port 3020) - ws(s) mot samme vert, aldri vilkårlige mål.
      "connect-src 'self' ws://*:3020 wss://*:3020",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'"
    ].join("; "),
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "microphone=(self), camera=(), geolocation=()"
  };
}

async function sendStaticPage(res: ServerResponse, file: string, deps: ApiDeps | undefined, needsOwner: boolean): Promise<void> {
  if (needsOwner && !deps?.owner) {
    return json(res, 503, { error: "owner_not_configured", request_id: requestIdOf(res) });
  }
  const html = await readFile(file, "utf8");
  const nonce = randomBytes(16).toString("base64");
  res.writeHead(200, staticPageHeaders(nonce));
  res.end(renderStaticPage(html, nonce, deps?.owner));
}

async function route(req: IncomingMessage, res: ServerResponse, deps?: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/live") {
    return json(res, 200, healthStatus());
  }
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
    if (!deps?.readiness) return json(res, 200, healthStatus());
    const readiness = await deps.readiness();
    return json(res, readiness.ready ? 200 : 503, { ...healthStatus(), status: readiness.ready ? "ok" : "unavailable", checks: readiness.checks });
  }

  if (req.method === "GET" && url.pathname === "/") {
    await sendStaticPage(res, WEB_COMMAND, deps, false);
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat") {
    await sendStaticPage(res, WEB_INDEX, deps, true);
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard") {
    await sendStaticPage(res, WEB_DASHBOARD, deps, true);
    return;
  }

  if (req.method === "GET" && url.pathname === "/control") {
    await sendStaticPage(res, WEB_CONTROL, deps, true);
    return;
  }

  if (req.method === "GET" && url.pathname === "/voice") {
    await sendStaticPage(res, WEB_VOICE, deps, true);
    return;
  }

  // D-395 (JARVIS-092): uten avhengigheter (helse-modus) er HVER API-rute utilgjengelig fordi API-et ikke er konfigurert - ikke bare en håndskrevet
  // liste som ble stale (~25 nyere ruter ga 404 i stedet for 503). ALLE API-ruter er ikke-GET (de eneste GET-rutene er sidene/helse over), så
  // enhver ikke-GET svarer 503 `not_configured`; en ukjent GET er fortsatt 404.
  if (!deps) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) });
    }
    return json(res, 404, { error: "not_found" });
  }

  if (req.method === "POST" && url.pathname === "/session/authorize") {
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: generisk, kanal-uavhengig
    // søster til `/voice/session/authorize` - eneste vei til et gyldig
    // `session_id` for `/chat`/`/brief` fra nå av. INGEN egen logikk her,
    // nøyaktig samme disiplin som `/voice/session/authorize`: les kroppen,
    // gi den til `ChannelSessionAuthority.authorize()` (som selv krever ekte
    // enhetsbevis FØR noen sesjonsrad røres), returner vedtaket. Ugyldig JSON
    // fanges og sendes inn som `undefined` -> deterministisk fail-closed
    // `403 malformed_evidence` (aldri en `500` en klient kan skille fra et
    // ekte avslag). `channel` skilles ut FØR resten sendes som bevismateriale
    // - `ChannelSessionAuthority.authorize()` avviser ukjente nøkler i
    // bevismaterialet (inkl. et forsøk på å smugle inn `channel` der).
    //
    // D-131 funn 3: `channel` sendes videre som `unknown` og valideres mot
    // kontraktens ENUM inne i autoriteten. Ruten sjekket tidligere kun
    // `typeof === "string"`, så en vilkårlig streng ble skrevet rett inn i
    // `sessions.last_channel` og i audit-radene - en usann kildemerking
    // (CLAUDE.md regel 4). Valideringen hører hjemme i autoriteten slik at det
    // finnes ÉN valideringssannhet uansett hvilken transport som kaller.
    const raw: unknown = await readBodyOrUndefined(req);
    const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const { channel, ...evidence } = obj;
    const result = await deps.channelAuthority.authorize(channel, evidence);
    if (!result.ok) {
      return json(res, 403, result);
    }
    // D-131 funn 1: `grant` er det klienten skal bruke videre. `session_id`
    // beholdes i svaret som SAMTALEKONTINUITET (og for bakoverkompatibel
    // korrelasjon/logging), men gir i seg selv ingen tilgang lenger.
    return json(res, 200, {
      ok: true,
      grant: result.grant,
      session_id: result.session.session_id,
      identity: result.identity
    });
  }

  if (deps.chatJobs && req.method === "POST" && url.pathname === "/chat/jobs") {
    // D-416: chat og agenter er to løp. UI-et poller denne (grant-autentisert) for å vise kjørende/ferdige bakgrunnsjobber uten å blokkere chatten.
    const parsedBody = grantBodyOrReject(res, await readBody(req), ["grant_token"] as const);
    if (!parsedBody) return;
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    return json(res, 200, { ok: true, data: { jobs: await deps.chatJobs.list(resolved.identity, 10) } });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    const parsedBody = grantBodyOrReject(res, await readBody(req), CHAT_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["message"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const body: ChatBody = {
      grant_token: parsedBody["grant_token"] as string,
      message: parsedBody["message"],
      ...(typeof parsedBody["provider"] === "string" ? { provider: parsedBody["provider"] } : {})
    };
    const resolved = await resolveFromGrant(deps, body.grant_token, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const sessionId = resolved.identity.session_id;

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
    if (wantsStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      // D-30 HOST BLOCKER §1/§2 (spørsmål D): valgfri diagnostikk - kun event-navn/
      // timing, ALDRI dataInnhold (aldri token-tekst/secrets), kun når eksplisitt på.
      const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
      const tSseStart = Date.now();
      const send = (event: string, data: unknown) => {
        // Frakoblet socket får aldri flere events - og aldri duplisert 'done'.
        if (!res.writableEnded && !res.destroyed) {
          if (streamDebug) {
            console.error(JSON.stringify({ msg: "stream_debug_sse_write", event, at_ms: Date.now() - tSseStart }));
          }
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };
      // BO-11.1 §6/§8 (barge-in-fundament for D-30): klient-disconnect propagerer
      // hele veien - HTTP close → AbortSignal → ModelGateway → provider-upstream.
      // Ikke bare slutte å skrive til socketen mens provideren fortsetter.
      const abort = new AbortController();
      // 'close' på RESPONSEN fyrer når forbindelsen termineres for tidlig
      // (req-'close' fyrer ved fullført request-body i moderne Node - feil signal).
      res.on("close", () => {
        if (!res.writableEnded) {
          abort.abort();
        }
      });
      // D-251 (live NAS-migreringsfunn): en feil herfra, etter at SSE-headers
      // allerede er sendt (over), kunne IKKE lenger bli en vanlig 500-respons -
      // den ytre feilhåndteringen i `createApiServer()` kunne kun avslutte
      // streamen stille (`res.end()`), usynlig for klienten OG (før D-251) for
      // loggen. Fang derfor HER: logg strukturert (samme mønster som resten av
      // filen) og send et eksplisitt `error`-event FØR streamen lukkes, slik at
      // klienten kan vise noe i stedet for en tom, uforklarlig "svarer ikke".
      try {
        const result = await deps.conversation.handle(
          resolved.identity,
          body.message,
          (token) => send("token", { token }),
          abort.signal,
          body.provider,
          // D-30: trusted verktøy-aktivitet - kun tool_name, aldri args/resultat-JSON.
          // Voice-klientens HttpCoreClient forstår allerede `tool_call`-eventet.
          (toolName) => send("tool_call", { tool_name: toolName })
        );
        send("done", { ...result, session_id: sessionId });
      } catch (err) {
        console.error(JSON.stringify({
          msg: "chat_stream_error", session_id: sessionId, error: (err as Error).message
        }));
        send("error", { message: "Noe gikk galt under generering. Prøv igjen." });
      }
      res.end();
      return;
    }

    const result = await deps.conversation.handle(resolved.identity, body.message, undefined, undefined, body.provider);
    return json(res, 200, { ...result, session_id: sessionId });
  }

  if (deps.brief && req.method === "POST" && url.pathname === "/brief") {
    // D-131 funn 1: identisk autoritetsmodell som `/chat` over - `/brief` var
    // den ANDRE ruten som oppgraderte en rå sesjons-ID til `signed`.
    const parsedBody = grantBodyOrReject(res, await readBody(req), BRIEF_BODY_KEYS);
    if (!parsedBody) return;
    const body: BriefBody = { grant_token: parsedBody["grant_token"] as string };
    const resolved = await resolveFromGrant(deps, body.grant_token, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const artifact = await deps.brief.generate(resolved.identity);
    return json(res, 200, {
      brief: artifact,
      rendered: deps.brief.render(artifact),
      session_id: resolved.identity.session_id
    });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/executive/query") {
    // D-199 (UA-11 Executive dashboard-UI, lese-delen): SAMME grant-baserte
    // autoritetsmodell som `/chat`/`/brief` - INGEN egen autentisering
    // oppfunnet her. `action` valideres FØR grantet løses (billigere avslag
    // for en åpenbart ugyldig forespørsel), men et ugyldig grant avslås
    // UANSETT FØR selve `toolGateway.execute()`-kallet - identisk rekkefølge
    // som `/chat`.
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!(EXECUTIVE_QUERY_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "executive", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.executive && req.method === "POST" && (url.pathname === "/control/centers" || url.pathname === "/control/center")) {
    // WP-H0: SAMME rekkefølge/avslagsform som /executive/query - ugyldig kropp/senter avvises FØR grantet løses, et ugyldig/utløpt grant FØR gateway.execute() nås. Lese-kun: ingen mutasjon.
    const single = url.pathname === "/control/center";
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, single ? CONTROL_CENTER_BODY_KEYS : CONTROL_CENTERS_BODY_KEYS);
    if (!parsedBody) return;
    let parameters: Record<string, JsonValue> = {};
    if (single) {
      const center = parsedBody["center"];
      if (typeof center !== "string") {
        return json(res, 400, { error: "malformed_request", reason: "center_required", request_id: requestIdOf(res) });
      }
      if (!controlCenterKnown(center, deps.executive.gateway)) {
        return json(res, 400, { error: "malformed_request", reason: "unknown_center", request_id: requestIdOf(res) });
      }
      parameters = { center };
    }
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "executive", action: "get_control_center", parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    if (single && (result.data as { found?: unknown } | undefined)?.found === false) {
      return json(res, 404, { error: "center_not_registered", request_id: requestIdOf(res) });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id }, { "cache-control": "no-store" });
  }

  if (deps.executive && req.method === "POST" && (url.pathname === "/runrate/query" || url.pathname === "/runrate/maintenance")) {
    const mutate = url.pathname === "/runrate/maintenance";
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    const allowed: readonly string[] = mutate ? RUN_RATE_MUTATE_ACTIONS : RUN_RATE_QUERY_ACTIONS;
    // Spørringen har standardhandlingen `get_cost_overview`; skrivingen krever eksplisitt handling.
    const action = typeof parsedBody["action"] === "string" ? parsedBody["action"] : mutate ? "" : "get_cost_overview";
    if (!allowed.includes(action)) return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "run_rate", action, parameters,
      ...(mutate ? { idempotency_key: `runrate-maint:${resolved.identity.session_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` } : {})
    });
    if (!result.ok) return json(res, 403, { error: "tool_denied", reason: result.reason });
    return json(res, 200, { ok: true, data: result.data });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/value/query") {
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    // Standardhandlingen er `get_value_report` (som `/runrate/query`); en eksplisitt handling utenfor allowlisten avvises FØR grantet løses.
    const action = typeof parsedBody["action"] === "string" ? parsedBody["action"] : "get_value_report";
    if (!(VALUE_QUERY_ACTIONS as readonly string[]).includes(action)) return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    // Verktøyskjemaet er strengt og uten felt: `parameters` fra kroppen sendes bevisst ALDRI videre.
    const result = await deps.executive.gateway.execute({ identity: resolved.identity, tool_id: "executive", action, parameters: {} });
    if (!result.ok) return json(res, 403, { error: "tool_denied", reason: result.reason });
    return json(res, 200, { ok: true, data: result.data });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/infra/overview") {
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    const action = typeof parsedBody["action"] === "string" ? parsedBody["action"] : "get_infra_status";
    if (!(INFRA_OVERVIEW_ACTIONS as readonly string[]).includes(action)) return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    // M3: driftsoversikten (hendelsestitler, skymål-tilstand) er en EIER-flate - samme port som kontrollsentrene. Verktøydefinisjonen har i tillegg SIN EGEN eier + signert-økt-port (gjelder også chat).
    if (!(await requireOwner(res, deps, resolved.identity, { tool_id: "executive", action }))) return;
    const result = await deps.executive.gateway.execute({ identity: resolved.identity, tool_id: "executive", action, parameters: {} });
    if (!result.ok) return json(res, 403, { error: "tool_denied", reason: result.reason });
    return json(res, 200, { ok: true, data: result.data });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/owner-controls/connector-credentials") {
    // Task #122 (D-213): se OWNER_CONTROLS_CONNECTOR_ACTIONS sitt filhode -
    // SAMME rekkefølge/avslagsform som /executive/query (avvis ugyldig
    // action FØR grantet løses, avvis et ugyldig/utløpt grant FØR
    // gateway.execute() nås).
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!(OWNER_CONTROLS_CONNECTOR_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const stepUp = stepUpDenial(resolved.identity, action);
    if (stepUp) {
      return json(res, 403, { error: "step_up_required", reason: stepUp });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "owner_controls", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  // WP-G3 (D-465): `/vision/*` finnes KUN når `deps.vision` er satt (JARVIS_VISION_ENABLED=on); ellers faller alt til den vanlige 404-en. Ruten håndterer selv grant/eier/step-up (vision-routes.ts).
  if (deps.vision && url.pathname.startsWith("/vision/")) {
    const handled = await handleVisionRoute(req, url.pathname, deps.vision, {
      authed: (keys, maxBytes) => authedRequest(req, res, deps, keys, maxBytes),
      requireOwner: (identity, subject) => requireOwner(res, deps, identity, subject),
      json: (status, body) => json(res, status, body),
      requestId: () => requestIdOf(res)
    });
    if (handled) return;
  }

  // WP-G4 fiks-runde (B-MEDIUM-5): `/situations/signals/*` finnes KUN når `deps.situationSignals` er satt (JARVIS_SITUATION_SIGNALS=on); ellers faller alt til den vanlige 404-en. Ruten håndterer selv grant/eier/step-up.
  if (deps.situationSignals && url.pathname.startsWith("/situations/signals/")) {
    const handled = await handleSituationSignalRoute(req, url.pathname, deps.situationSignals, {
      authed: (keys, maxBytes) => authedRequest(req, res, deps, keys, maxBytes),
      requireOwner: (identity, subject) => requireOwner(res, deps, identity, subject),
      json: (status, body) => json(res, status, body),
      requestId: () => requestIdOf(res)
    });
    if (handled) return;
  }

  if (deps.businessTenants && req.method === "POST" && url.pathname === "/owner/business-tenants") {
    // WP-D2 (JARVIS-044/Q-48): eier-initiert, idempotent, dormant. Rekkefølge: kropp (felt/typer) -> grant -> KUN konfigurert eier i eierens tenant (ingen delegat) ->
    // step-up (signert enhet, egnet kanal) -> plan (ren validering) -> `preview` svarer her, `provision` krever typet bekreftelse FØR noe skrives.
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, BUSINESS_TENANT_BODY_KEYS);
    if (!parsedBody) return;
    const action = parsedBody["action"];
    if (typeof action !== "string" || !(BUSINESS_TENANT_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed", request_id: requestIdOf(res) });
    }
    const name = parsedBody["name"];
    const slug = parsedBody["slug"];
    if (typeof name !== "string" || (slug !== undefined && typeof slug !== "string")
      || (parsedBody["confirm"] !== undefined && typeof parsedBody["confirm"] !== "boolean")
      || (parsedBody["confirm_tenant_id"] !== undefined && typeof parsedBody["confirm_tenant_id"] !== "string")) {
      return json(res, 400, { error: "malformed_request", reason: "field_types", request_id: requestIdOf(res) });
    }
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    if (!deps.owner) return json(res, 503, { error: "owner_not_configured", request_id: requestIdOf(res) });
    const identity = resolved.identity;
    if (identity.person_id !== deps.owner.person_id || identity.tenant_id !== deps.owner.tenant_id || identity.delegation_id !== undefined) {
      return json(res, 403, { error: "owner_only", request_id: requestIdOf(res) });
    }
    const stepUp = stepUpDenial(identity, "provision_business_tenant");
    if (stepUp) return json(res, 403, { error: "step_up_required", reason: stepUp });
    let plan;
    try {
      plan = previewBusinessTenant({ name, ...(slug !== undefined ? { slug } : {}) });
    } catch (err) {
      if (err instanceof BusinessTenantProvisioningError) return json(res, BUSINESS_TENANT_STATUS[err.code] ?? 400, { error: err.code, request_id: requestIdOf(res) });
      throw err;
    }
    if (action === "preview") {
      return json(res, 200, { ok: true, data: { plan, writes: false, confirm_tenant_id_required: plan.tenant_id } });
    }
    if (parsedBody["confirm"] !== true || parsedBody["confirm_tenant_id"] !== plan.tenant_id) {
      return json(res, 409, { error: "confirmation_required", data: { plan, writes: false, confirm_tenant_id_required: plan.tenant_id }, request_id: requestIdOf(res) });
    }
    try {
      const report = await provisionBusinessTenant(
        deps.businessTenants.pool,
        { owner_person_id: identity.person_id, owner_tenant_id: identity.tenant_id },
        { name, ...(slug !== undefined ? { slug } : {}) },
        { via: "dashboard", session_id: identity.session_id, device_id: identity.device_id }
      );
      return json(res, 200, { ok: true, data: report, session_id: identity.session_id });
    } catch (err) {
      if (err instanceof BusinessTenantProvisioningError) return json(res, BUSINESS_TENANT_STATUS[err.code] ?? 400, { error: err.code, request_id: requestIdOf(res) });
      throw err;
    }
  }

  if (deps.confirmations && req.method === "POST" && url.pathname === "/confirmations") {
    // Del 3: eierens bekreftelser for tainted handlinger. SAMME grant-rekkefølge som /memory/proposals. `decide` gjelder KUN
    // bekreftelser for samme person som grantet, kun mens de er pending og ikke utløpt (se ConfirmationStore.decide).
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string" || !(CONFIRMATION_ACTIONS as readonly string[]).includes(parsedBody["action"])) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const action = parsedBody["action"] as (typeof CONFIRMATION_ACTIONS)[number];
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    if (action === "list") {
      return json(res, 200, { ok: true, data: await deps.confirmations.listPending(resolved.identity) });
    }
    const id = parameters["confirmation_id"];
    const decision = parameters["decision"];
    if (typeof id !== "string" || id.length === 0 || id.length > 100 || (decision !== "approve" && decision !== "reject")) {
      return json(res, 400, { error: "malformed_request", reason: "decision_malformed" });
    }
    if (decision === "approve" && deps.executive) {
      // WP-F1 (D-462): godkjenning av en handling som flytter penger (`ToolDefinition.step_up_required`) krever eierens step-up - en enhetssignert økt fra en
      // eier-kanal - FØR bekreftelsen forbrukes. (Avvisning er unntatt: den reduserer risiko.) ToolGateway håndhever det samme på nytt ved utførelsen.
      const pending = await deps.confirmations.peekPending(resolved.identity, id);
      if (pending && deps.executive.gateway.get(pending.tool_id, pending.action)?.step_up_required === true) {
        const stepUp = stepUpDenial(resolved.identity, "approve_finance_action");
        if (stepUp) return json(res, 403, { error: "step_up_required", reason: stepUp });
      }
      // D-382: godkjenning UTFØRER kallet i deterministisk kode - samme ToolGateway (policy, kill switch, klasse D-pipeline, audit) som
      // alt annet, med eierens grant-identitet og bekreftelses-id som idempotensnøkkel (aldri dobbel utførelse).
      const taken = await deps.confirmations.approveAndTake(resolved.identity, id);
      if (!taken) return json(res, 404, { error: "not_pending", reason: "confirmation_not_pending_or_expired" });
      const result = await deps.executive.gateway.execute({
        identity: resolved.identity,
        tool_id: taken.tool_id,
        action: taken.action,
        parameters: taken.parameters,
        idempotency_key: `confirmation:${taken.confirmation_id}`,
        // WP-N1 (F2-A1): en delegert bakgrunnsjobb godkjent fra en kort opprettet i en LÅST tur utføres med `restrictedOrigin` (kortets `restricted_turn`, satt av trusted kode) - ellers mister kontrakten `restricted_origin` og leveringen lagres umerket.
        // Kort uten grunnen (alle kort med begrenset-vakten AV) gir NØYAKTIG kallet fra før N1.
        ...(confirmationRestrictsOrigin(taken) ? { restrictedOrigin: true as const } : {})
      });
      const stored: JsonValue = result.ok
        ? { ok: true, data: (result.data ?? null) as JsonValue, external_id: result.external_id ?? null }
        : { ok: false, reason: result.reason };
      await deps.confirmations.recordResult(resolved.identity, id, stored);
      return json(res, result.ok ? 200 : 409, {
        ok: result.ok, data: { confirmation_id: id, decision, executed: true, tool: `${taken.tool_id}.${taken.action}`, result: stored }
      });
    }
    const ok = await deps.confirmations.decide(resolved.identity, id, decision);
    if (!ok) return json(res, 404, { error: "not_pending", reason: "confirmation_not_pending_or_expired" });
    return json(res, 200, { ok: true, data: { confirmation_id: id, decision } });
  }

  if (deps.executive && deps.confirmations && deps.owner && req.method === "POST" && url.pathname === "/finance/actions") {
    // WP-F1 (D-462, Q-47 a): eierens vei til pengehandlingene (se finance-actions.ts). EGEN rute med hardkodet allowlist (`preview`/`request`/`reconciliation_status`) - aldri en utvidelse av
    // /confirmations eller /executive/*. SAMME grant-rekkefølge som de øvrige muterende rutene: avvis ugyldig action/parametre FØR grantet løses, avvis et ugyldig
    // grant FØR step-up, og step-up FØR noe leses eller opprettes. `request` UTFØRER ALDRI - den oppretter kun en bundet, engangs bekreftelse som eieren godkjenner
    // via `/confirmations` (som igjen krever step-up og kjører gjennom klasse D-pipelinen).
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    const action = parsedBody["action"];
    if (typeof action !== "string" || !(FINANCE_ACTION_ROUTE_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const rawParameters = parsedBody["parameters"];
    const parameterObject = typeof rawParameters === "object" && rawParameters !== null && !Array.isArray(rawParameters) ? (rawParameters as Record<string, unknown>) : {};
    // `reconciliation_status` er en ren LESING av avstemmingsrapporten (klasse A, `finance.get_reconciliation_status`) og tar INGEN parametre (tenant kommer fra grantet).
    let parsedRequest: ReturnType<typeof parseFinanceActionRequest> = { ok: false, reason: "not_applicable" };
    if (action === "reconciliation_status") {
      const extra = Object.keys(parameterObject)[0];
      if (extra !== undefined) return json(res, 400, { error: "malformed_request", reason: `unknown_parameter:${extra.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, "_")}` });
    } else {
      parsedRequest = parseFinanceActionRequest(parameterObject);
      if (!parsedRequest.ok) return json(res, 400, { error: "malformed_request", reason: parsedRequest.reason });
    }
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    // Kun den validerte eieren (ikke en gjest eller delegat i samme tenant) kan se eller be om pengehandlinger - `deps.owner` er prosessens ENE eier-identitet.
    if (resolved.identity.person_id !== deps.owner.person_id || resolved.identity.tenant_id !== deps.owner.tenant_id || resolved.identity.delegation_id !== undefined) {
      return json(res, 403, { error: "owner_only", reason: "finance_actions_require_owner" });
    }
    const stepUp = stepUpDenial(resolved.identity, `finance_${action}`);
    if (stepUp) {
      return json(res, 403, { error: "step_up_required", reason: stepUp });
    }
    if (action === "reconciliation_status") {
      const status = await readReconciliationStatus(deps.executive.gateway, resolved.identity);
      return status.ok ? json(res, 200, { ok: true, data: status.data }) : json(res, 403, { error: "tool_denied", reason: status.reason });
    }
    if (!parsedRequest.ok) return json(res, 400, { error: "malformed_request", reason: parsedRequest.reason });
    const request = parsedRequest.request;
    const preview = await previewFinanceAction(deps.executive.gateway, resolved.identity, request);
    if (!preview.ok) {
      return preview.kind === "not_found"
        ? json(res, 404, { error: "target_not_found", reason: preview.reason, request_id: requestIdOf(res) })
        : json(res, 403, { error: "tool_denied", reason: preview.reason });
    }
    const tool = `${request.spec.tool_id}.${request.spec.action}`;
    const view = { tool, target_id: request.targetId, allowed: preview.reason === null && preview.binding !== null, reason: preview.reason, summary: preview.summary, binding: preview.binding, state: preview.state };
    if (action === "preview") return json(res, 200, { ok: true, data: view });
    if (preview.reason !== null) {
      return json(res, 409, { error: "not_submittable", reason: preview.reason, data: view });
    }
    // Uten beløp/valuta/mottaker-digest i den ferske tilstanden kan beløp + mottaker ikke bindes - da opprettes ingen bekreftelse (fail-closed).
    if (preview.binding === null) {
      return json(res, 409, { error: "not_submittable", reason: "binding_unavailable", data: view });
    }
    const identity = resolved.identity;
    const pending = await deps.confirmations.requestPending(
      { tool_id: request.spec.tool_id, action: request.spec.action, parameters: moneyActionParameters(identity, request, preview.binding) },
      { tenant_id: identity.tenant_id, person_id: identity.person_id, device_id: identity.device_id, session_id: identity.session_id },
      ["owner_finance_action_request"],
      preview.summary ?? undefined
    );
    return json(res, 200, { ok: true, data: { ...pending, tool, target_id: request.targetId, summary: preview.summary, next: "approve_via_confirmations_with_step_up" } });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/memory/proposals") {
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!(MEMORY_PROPOSAL_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "memory", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/executive/mutate") {
    // Task #124: SAMME rekkefølge/avslagsform som /executive/query og
    // /owner-controls/connector-credentials (avvis ugyldig action FØR
    // grantet løses, avvis et ugyldig/utløpt grant FØR gateway.execute()
    // nås). `tool_id: "executive"` (ALDRI "owner_controls"/"situations"/
    // "finance" direkte) - executive-laget videresender selv, nøstet, med
    // UENDRET identitet (§2 i design-notatet).
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!executiveMutateActionKnown(action, deps.executive.gateway)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    // Del 3 (JARVIS-024/037): step-up for følsomme kontrollhandlinger (signert enhet + egnet kanal); brytere som stopper ting er unntatt.
    const stepUp = stepUpDenial(resolved.identity, action);
    if (stepUp) {
      return json(res, 403, { error: "step_up_required", reason: stepUp });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "executive", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/governance/query") {
    // D-230: SAMME rekkefølge/avslagsform/kroppsform som /executive/query -
    // avvis en ugyldig action FØR grantet løses, avvis et ugyldig/utløpt
    // grant FØR gateway.execute() nås. `tool_id: "governance"` - DEN SAMME
    // `toolGateway`-instansen `deps.executive.gateway` allerede peker på
    // (`governanceToolDefinitions()` registrert i main.ts), INGEN ny
    // ApiDeps-nøkkel.
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!(GOVERNANCE_QUERY_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "governance", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/governance/mutate") {
    // D-230: EGEN, HELT NY rute (aldri en utvidelse av /governance/query,
    // samme "egen rute per risikoklasse-endring, aldri utvid en eksisterende
    // lese-only-rute til å skrive"-disiplin D-211/D-213/D-199 allerede
    // fulgte). ALLE ti handlingene er klasse A/B - INGEN klasse C/D-
    // preflight-krav her, i motsetning til /executive/mutate.
    const raw: unknown = await readBodyOrUndefined(req);
    const parsedBody = grantBodyOrReject(res, raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody) return;
    if (typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    const action = parsedBody["action"];
    if (!(GOVERNANCE_MUTATE_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    // WP-H1 (JARVIS-087 del 2): dashbord-ruten attesterer at parameterne er eierens EGNE ord (skjemaet i dashbordet, grant fra en innrullert enhet - ingen modell har formulert dem) - men KUN når kalleren er
    // den suverene eieren (`deps.ownerGate`, samme predikat som kontrollsentrene) OG grantet er en enhetssignert økt fra en eier-kanal (`ownerStepUpDenial(identity) === undefined`, samme regel som gatewayens
    // `step_up_required` og kontrollrutenes step-up; gjennomgang L3): en annen innrullert person i tenanten, en passiv/aktiv økt uten enhetssignatur, en tale-/Telegram-kanal eller en rute uten konfigurert eier-port
    // får ingen attest, og journalraden står da som `unspecified` (fail-closed - aldri «eierens ord» på noe annet enn eierens egen inntasting fra en signert enhet). Kun journal-transporten leser verdien (og kun
    // når JARVIS_GOVERNANCE_PROVENANCE=on); den åpner ingen rute.
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "governance", action, parameters,
      ...(deps.ownerGate?.(resolved.identity) === true && ownerStepUpDenial(resolved.identity) === undefined ? { contentOrigin: "owner_direct" as const } : {})
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.enrollment && req.method === "POST" && url.pathname === "/devices/register") {
    // D-131 funn 2: ruten har med vilje INGEN egen logikk lenger - den leser en
    // kropp og gir den til `DeviceEnrollmentService.enroll()`, som krever
    // eksplisitt eier-/bootstrap-autoritet (proof-of-possession fra en allerede
    // innrullert enhet, ELLER en engangs innrullerings-billett fra en lokal
    // eier-handling). Den gamle veien - `resolveIdentity(body.identity)` -
    // VERIFISERTE EKSISTENS og autentiserte ingenting: en caller med bare
    // gyldige, ikke-hemmelige ID-er kunne skrive sin egen nøkkel inn på en
    // fremmed enhet og deretter «bevise» den.
    //
    // Ugyldig JSON fanges og sendes inn som `undefined` → deterministisk
    // `malformed_request`, aldri en 500 en klient kan skille fra et avslag.
    const raw: unknown = await readBodyOrUndefined(req);
    const result = await deps.enrollment.enroll(raw);
    if (!result.ok) {
      // 400 for en syntaktisk ugyldig kropp, 403 for et ekte
      // autorisasjons-/eierskapsavslag.
      const status = result.reason === "malformed_request" || result.reason === "invalid_public_key" ? 400 : 403;
      return json(res, status, { ok: false, reason: result.reason });
    }
    return json(res, 200, {
      ok: true,
      registered: result.device_id,
      rotated: result.rotated,
      revoked_grants: result.revoked_grants
    });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge") {
    // Engangs-nonce for enhetsbeviset (utstedes KUN her; forbrukes av
    // `/session/authorize`, `/voice/session/authorize` og `/devices/register`).
    // JARVIS-063: kroppen valideres, og `DeviceService` begrenser antall
    // utestående nonces (globalt og per enhet) - ruten kan ikke fylle minnet.
    //
    // JARVIS-051 (remediering del 2): den gamle `/devices/challenge/verify`-
    // ruten er FJERNET. Den returnerte `auth_strength: "signed"` uten
    // sesjon/grant og var en ALTERNATIV identitetsvei ved siden av
    // `/session/authorize` (som er den eneste veien til et grant).
    const body = await readBody(req);
    const deviceId = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["device_id"] : undefined;
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "device_id")
      || typeof deviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
      // JARVIS-063: enhets-id har et lukket tegnsett (ingen stier/mellomrom/kontrolltegn) og maks 128 tegn.
      return json(res, 400, { error: "malformed_request", request_id: requestIdOf(res) });
    }
    try {
      return json(res, 200, { challenge: deps.devices.issueChallenge(deviceId) });
    } catch (err) {
      if (err instanceof ChallengeLimitError) {
        return json(res, 429, { error: "rate_limited", request_id: requestIdOf(res) });
      }
      throw err;
    }
  }

  if (deps.voiceAuthority && req.method === "POST" && url.pathname === "/voice/session/authorize") {
    // D-123 (Q-32 punkt 2): den BETRODDE server-side space-/sesjonsautoriteten
    // for voice-transporten. Ruten har med vilje INGEN egen logikk - den leser
    // en kropp, gir den til `VoiceSessionAuthority.authorize()` (som kun
    // komponerer `DeviceService`/`SessionService`/`resolveIdentity()`) og
    // returnerer vedtaket. Ingen `resolveIdentity()`-kall her oppe: det ville
    // vært en ANDRE identitetssti ved siden av den autoriteten selv kjører.
    //
    // Kroppen valideres inne i autoriteten (`.strict()`-skjema), ikke her, slik
    // at det finnes ÉN valideringssannhet. Ugyldig JSON fanges likevel her og
    // sendes inn som `undefined`, slik at ALLE former for ugyldig input gir
    // det samme fail-closed `403 malformed_evidence` - aldri en `500` som en
    // klient kan bruke til å skille «parseren knakk» fra «beviset holdt ikke».
    const body: unknown = await readBodyOrUndefined(req);
    const result = await deps.voiceAuthority.authorize(body);
    return json(res, result.ok ? 200 : 403, result);
  }

  if (deps.tasks && req.method === "POST" && url.pathname === "/tasks/submit") {
    // D-102: minimal, provider-nøytral ingress for en fullstendig `JobContract`
    // (inkl. `agent_profile: "coding"`) - gjenbruker `TaskService.submit()`
    // UENDRET: kontraktvalidering (Zod), tenant-match, untrusted-privat-
    // minne-og-nettverk-invarianten, klasse B policy-autorisasjon og audit
    // skjer ALT i den eksisterende metoden.
    //
    // JARVIS-001 (remediering del 2): identiteten kommer UTELUKKENDE fra det
    // verifiserte grantet (`authedRequest`) - kroppen er `{ grant_token, contract }`.
    const authed = await authedRequest(req, res, deps, ["contract"]);
    if (!authed) return;
    if (!("contract" in authed.body)) {
      return json(res, 400, { error: "malformed_request", reason: "contract", request_id: requestIdOf(res) });
    }
    // D-449 (Q-50): interne rutingsflagg (`cloud_tool_turns_allowed`) kan bare settes av trusted kode - en innsendt kontrakt som bærer dem avvises FØR submit.
    const reservedKey = submittedContractHasReservedKey(authed.body["contract"]);
    if (reservedKey !== null) {
      return json(res, 400, { error: "task_rejected", reason: "reserved_input_key", key: reservedKey, request_id: requestIdOf(res) });
    }
    const result = await deps.tasks.submit(authed.identity, authed.body["contract"]);
    if (!result.ok) {
      return json(res, 400, { error: "task_rejected", reason: result.reason, request_id: requestIdOf(res) });
    }
    return json(res, 200, { task_id: result.value.task_id });
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/stripe") {
    // D-109 (UA-6 Slice 3): INGEN identity-oppløsning her - Stripe sender
    // denne ruten direkte, uten en Jarvis-owner-identitet å oppløse. Selve
    // autentiseringen ER HMAC-signaturverifiseringen (`Stripe-Signature`-
    // headeren), håndhevet inni `ingestStripeWebhookEvent()` - SAMME
    // "signatur ER autentisering"-prinsipp som ethvert annet webhook-mottak.
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers["stripe-signature"];
    try {
      const result = await deps.finance.service.ingestStripeWebhookEvent(
        rawBody, typeof signatureHeader === "string" ? signatureHeader : undefined
      );
      // Stripe tolker 2xx som "stopp gjentakelse", ALT annet som "prøv igjen
      // senere" - `failed_retryable` er derfor BEVISST et 502 her (samme
      // navn/semantikk som `stripe_webhook_events.status`), IKKE en stille 200.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 400, { error: "invalid_signature", request_id: requestIdOf(res) });
      }
      if (err instanceof StripeCredentialsUnavailableError || err instanceof StripeTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) });
      }
      throw err;
    }
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/vipps") {
    // D-110 (UA-6 Slice 4): SAMME "signatur ER autentisering"-prinsipp som
    // /webhooks/stripe, men med Vipps sin HELT ANDERLEDES HMAC-kontrakt
    // (Host/X-Ms-Date/X-Ms-Content-Sha256/Authorization-headere, se
    // vipps-webhook.ts) - `method`/`pathAndQuery` deltar i den signerte
    // strengen og MÅ derfor speile den faktiske forespørselen eksakt.
    const rawBody = await readRawBody(req);
    const hostHeader = req.headers["host"];
    const dateHeader = req.headers["x-ms-date"];
    const contentHashHeader = req.headers["x-ms-content-sha256"];
    const authHeader = req.headers["authorization"];
    try {
      const result = await deps.finance.service.ingestVippsWebhookEvent(
        rawBody, req.method, url.pathname + url.search,
        {
          host: typeof hostHeader === "string" ? hostHeader : undefined,
          xMsDate: typeof dateHeader === "string" ? dateHeader : undefined,
          xMsContentSha256: typeof contentHashHeader === "string" ? contentHashHeader : undefined,
          authorization: typeof authHeader === "string" ? authHeader : undefined
        }
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som Stripe-ruten.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_signature", request_id: requestIdOf(res) });
      }
      if (err instanceof VippsCredentialsUnavailableError || err instanceof VippsTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) });
      }
      throw err;
    }
  }

  if (deps.productUsage && req.method === "POST" && url.pathname === "/webhooks/product-usage") {
    // WP-D2: SAMME «signatur ER autentisering»-prinsipp som /webhooks/stripe. Kroppen leses som RÅ bytes med en HARD størrelsesgrense FØR signaturen vurderes (413 ved
    // overskridelse). Svaret ekkoer aldri hendelsesinnhold: kun tellere og (posisjon, årsakskode) for avviste hendelser.
    const rawBody = await readRawBodyLimited(req, USAGE_LIMITS.webhook_max_bytes);
    const signatureHeader = req.headers[USAGE_WEBHOOK_SIGNATURE_HEADER];
    try {
      const summary = await deps.productUsage.service.ingestWebhook(rawBody, typeof signatureHeader === "string" ? signatureHeader : undefined);
      return json(res, 200, {
        received: true,
        events: { received: summary.received, inserted: summary.inserted, duplicates: summary.duplicates, conflicts: summary.conflicts, rejected: summary.rejected },
        rejected_detail: summary.rejected_detail,
        request_id: requestIdOf(res)
      });
    } catch (err) {
      if (err instanceof ProductUsageError) {
        // Årsaken til en avvist signatur logges (kode, aldri kropp/hemmelighet) men svares aldri - ingen orakel for en angriper.
        if (err.code === "invalid_signature") {
          console.error(JSON.stringify({ msg: "product_usage_webhook_rejected", request_id: requestIdOf(res), reason: err.message.split(":").pop() }));
          return json(res, 401, { error: "invalid_signature", request_id: requestIdOf(res) });
        }
        // Manglende/for kort hemmelighet, manglende tenant eller en tenant som ikke er en bedrifts-tenant: eierens konfigurasjonsfeil, ikke avsenderens.
        console.error(JSON.stringify({ msg: "product_usage_webhook_not_configured", request_id: requestIdOf(res), reason: err.code }));
        return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) });
      }
      if (err instanceof UsageImportError) {
        return json(res, 400, { error: err.code, request_id: requestIdOf(res) });
      }
      throw err;
    }
  }

  // WP-G1 (D-463, P1d): signerte kommunikasjons-webhooks (Slack/Meta/Twilio/Telnyx). DORMANT: uten `deps.comms.webhooks` (main.ts setter den KUN med JARVIS_COMMS_WEBHOOKS) og leverandøren i `providers` finnes ikke ruten (404,
  // identisk med main). SAMME «signatur ER autentisering»-prinsipp som /webhooks/stripe og /webhooks/product-usage: INGEN identitet å oppløse, kroppen leses som RÅ bytes med en HARD størrelsesgrense FØR signaturen vurderes
  // (413), og alt som ikke består verifiseringen avvises uten å lese kroppen videre. Svaret ekkoer aldri meldingsinnhold. Innholdet er UBETRODD data i Ingestion Zone: inntaket har ingen vei til verktøy, modell, minne eller utsendelse.
  const commsWebhookProvider = deps.comms?.webhooks !== undefined ? COMMS_WEBHOOK_ROUTES.get(url.pathname) : undefined;
  if (commsWebhookProvider !== undefined && deps.comms?.webhooks?.providers.has(commsWebhookProvider) === true) {
    if (req.method !== "POST") req.resume();
    // FIX-1: byte-grensen er per leverandør (Meta 4 MiB, øvrige 256 KB) og håndheves FØR signaturen. Et avslag (413) logges med leverandør og årsakskode - aldri innhold - så en gyldig, stor batch som avvises ikke er usynlig for driften.
    let rawBody: Buffer = Buffer.alloc(0);
    if (req.method === "POST") {
      // FIX-2 (runde 2): lesefrist og GLOBAL samtidighetsgrense for store kropper (Meta, 4 MiB); en avvist lesing (413 for stor, 408 for treg, 503 `webhook_busy` for full) logges med leverandør og årsakskode - aldri innhold.
      const bodyGuard = webhookBodyGuardFor(deps.comms.webhooks, deps.comms.webhooks.bodyRead);
      try {
        rawBody = await readRawBodyGuarded(req, COMMS_WEBHOOK_MAX_BYTES_BY_PROVIDER[commsWebhookProvider], bodyGuard);
      } catch (err) {
        if (err instanceof HttpError) {
          // 503: be leverandøren prøve igjen om litt, og lukk forbindelsen så resten av den store kroppen ikke leses videre.
          if (err.status === 503) { res.setHeader("retry-after", String(bodyGuard.config.retryAfterSeconds)); res.setHeader("connection", "close"); }
          // En loggfeil skal aldri endre svaret: leverandøren skal fortsatt få 413/503 (ikke 500) selv om logghjelperen kaster.
          try { deps.comms.webhooks.service.noteRejectedBeforeSignature(commsWebhookProvider, err.code as PreSignatureRejection); } catch { /* bevisst ignorert */ }
        }
        throw err;
      }
    }
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = typeof value === "string" ? value : undefined;
    const out = await deps.comms.webhooks.service.handle(commsWebhookProvider, {
      method: req.method ?? "GET", headers, rawBody, pathAndQuery: url.pathname + url.search, query: url.searchParams
    });
    if (typeof out.body === "string") {
      // Meta-håndtrykket (GET) forventer at `hub.challenge` ekkoes som ren tekst.
      res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(out.body);
      return;
    }
    if (commsWebhookProvider === "twilio" && out.status === 200) {
      // Twilio forventer TwiML (eller en tom 2xx): en tom <Response/> = ingen automatisk svarmelding. Tellerne står i tjenestens egen logg, ikke i svaret.
      res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
      res.end("<Response></Response>");
      return;
    }
    return json(res, out.status, out.body);
  }

  // WP-G1 (D-463, P1b): eierens kommunikasjonsflate. DORMANT: uten `deps.comms.outbound` (JARVIS_COMMS_OUTBOUND=on) finnes ingen av rutene (404). Alt går via `gateway.execute()` (verktøyene i `@jarvis/comms`): policy, eier-binding,
  // klasse D-kjeden (idempotensnøkkel, preflight, ledger, readback, eier-varsling) og den felles utgående policyen kjøres der - ruten har ingen egen sendevei og ingen egen sjekk å omgå, og er ALDRI et modellverktøy. Rekkefølge,
  // som `/executive/mutate`: ugyldig handling -> grant -> KUN suveren eier (`ownerGate`, samme predikat som kontrollsentrene) -> step-up (signert enhet) for alt unntatt lesing/avmeldingsregistrering -> gateway.
  if (deps.comms?.outbound !== undefined && req.method === "POST" && url.pathname === "/comms/preview") {
    const parsedBody = grantBodyOrReject(res, await readBodyOrUndefined(req), COMMS_PREVIEW_BODY_KEYS);
    if (!parsedBody) return;
    if (parsedBody["parameters"] !== undefined && (typeof parsedBody["parameters"] !== "object" || parsedBody["parameters"] === null || Array.isArray(parsedBody["parameters"]))) {
      return json(res, 400, { error: "malformed_request", reason: "parameters_malformed", request_id: requestIdOf(res) });
    }
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason, request_id: requestIdOf(res) });
    }
    if (!(await requireOwner(res, deps, resolved.identity, { tool_id: "comms", action: "preview" }))) return;
    const preview = await previewCommsSend({ ...deps.comms.outbound, ownerGate: deps.ownerGate }, resolved.identity, (parsedBody["parameters"] ?? {}) as Record<string, JsonValue>);
    if (!preview.ok) {
      if (preview.status !== "denied" && preview.reason === "owner_required") return json(res, 403, { error: "owner_required", reason: "owner_required", request_id: requestIdOf(res) });
      return json(res, 400, { error: "malformed_request", reason: preview.status === "denied" ? "policy_denied" : preview.reason, request_id: requestIdOf(res) });
    }
    return json(res, 200, { ok: true, data: preview.data, session_id: resolved.identity.session_id });
  }

  if (deps.comms?.outbound !== undefined && req.method === "POST" && url.pathname === "/comms/action") {
    const parsedBody = grantBodyOrReject(res, await readBodyOrUndefined(req), COMMS_ACTION_BODY_KEYS);
    if (!parsedBody) return;
    const action = parsedBody["action"];
    if (typeof action !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed", request_id: requestIdOf(res) });
    }
    if (!COMMS_KNOWN_ACTIONS.includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed", request_id: requestIdOf(res) });
    }
    if (parsedBody["parameters"] !== undefined && (typeof parsedBody["parameters"] !== "object" || parsedBody["parameters"] === null || Array.isArray(parsedBody["parameters"]))) {
      return json(res, 400, { error: "malformed_request", reason: "parameters_malformed", request_id: requestIdOf(res) });
    }
    if (parsedBody["idempotency_key"] !== undefined && typeof parsedBody["idempotency_key"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "idempotency_key_malformed", request_id: requestIdOf(res) });
    }
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string, res);
    if (!resolved.ok) {
      if (resolved.responded) return;
      return json(res, 403, { error: "identity_denied", reason: resolved.reason, request_id: requestIdOf(res) });
    }
    if (!(await requireOwner(res, deps, resolved.identity, { tool_id: "comms", action }))) return;
    const stepUp = COMMS_STEP_UP_EXEMPT.has(action) ? undefined : ownerStepUpDenial(resolved.identity);
    if (stepUp !== undefined) {
      return json(res, 403, { error: "step_up_required", reason: stepUp, request_id: requestIdOf(res) });
    }
    const result = await executeCommsOwnerAction({ ...deps.comms.outbound, ownerGate: deps.ownerGate }, resolved.identity, {
      action, parameters: (parsedBody["parameters"] ?? {}) as Record<string, JsonValue>,
      ...(typeof parsedBody["idempotency_key"] === "string" ? { idempotency_key: parsedBody["idempotency_key"] } : {})
    });
    if (result.ok) {
      return json(res, 200, {
        ok: true, ...(result.external_id !== undefined ? { external_id: result.external_id } : {}), data: result.data, output_trust: result.output_trust,
        deduplicated: result.deduplicated, session_id: resolved.identity.session_id
      });
    }
    if (result.status === "denied") {
      // En policy-avvisning er et fullt, strukturert svar (ALLE regelutfall, aldri innhold) + journal-id som bevis - ikke en generisk feil.
      return json(res, 403, { error: "comms_policy_denied", denial_codes: result.denial_codes, rules: result.rules, journal_id: result.journal_id, request_id: requestIdOf(res) });
    }
    if (result.status === "rejected") {
      if (result.reason === "owner_required") return json(res, 403, { error: "owner_required", reason: "owner_required", request_id: requestIdOf(res) });
      return json(res, 400, { error: "malformed_request", reason: result.reason, request_id: requestIdOf(res) });
    }
    return json(res, 403, { error: "tool_denied", reason: result.reason, request_id: requestIdOf(res) });
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/neonomics") {
    // D-111 (UA-6 Slice 5): Neonomics sin EGEN offisielle webhook-kontrakt
    // (betalingsstatus-oppdateringer): API-NØKKEL-autentisering - nøkkelen
    // Tobias selv velger ved registrering i Merchant-portalen, sendt av
    // Neonomics i `x-api-key`-headeren. IKKE HMAC (Stripe) og IKKE
    // forespørselssignering (Vipps) - se neonomics-webhook.ts.
    const rawBody = await readRawBody(req);
    const apiKeyHeader = req.headers["x-api-key"];
    try {
      const result = await deps.finance.service.ingestNeonomicsWebhookEvent(
        rawBody, typeof apiKeyHeader === "string" ? apiKeyHeader : undefined
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som
      // Stripe-/Vipps-rutene (Neonomics retryer eksponentielt i opptil 7
      // dager på alt annet enn 200).
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_api_key", request_id: requestIdOf(res) });
      }
      if (err instanceof NeonomicsCredentialsUnavailableError || err instanceof NeonomicsTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) });
      }
      throw err;
    }
  }

  if (deps.finance?.cards && req.method === "POST" && url.pathname === "/webhooks/wallester") {
    // D-112 (UA-6 Slice 6): Wallester sin EGEN offisielle webhook-kontrakt
    // (autorisasjons-/transaksjons-/korthendelser): HTTP BASIC-
    // autentisering med kunde-konfigurert brukernavn/passord i
    // `Authorization`-headeren, verifisert konstant-tid i
    // ingestWallesterWebhookEvent(). IKKE HMAC (Stripe), IKKE
    // forespørselssignering (Vipps), IKKE API-nøkkel (Neonomics) - se
    // wallester-webhook.ts.
    const rawBody = await readRawBody(req);
    const authHeader = req.headers["authorization"];
    // Owner-provided primary-source-audit (PR #62 runde 4): Wallester
    // Business ekko-er X-Request-ID for korrelasjon - fanges opp her og
    // speiles tilbake i responsen (rent transport-nivå, IKKE noe
    // envelope-parsing-anliggende - se wallester-webhook.ts filhode).
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" ? requestIdHeader : undefined;
    const echoHeaders = requestId ? { "x-request-id": requestId } : {};
    try {
      const result = await deps.finance.cards.ingestWallesterWebhookEvent(
        rawBody, typeof authHeader === "string" ? authHeader : undefined
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som
      // de øvrige webhook-rutene.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId }, echoHeaders);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_basic_auth", request_id: requestIdOf(res) }, echoHeaders);
      }
      if (err instanceof WallesterCredentialsUnavailableError || err instanceof WallesterTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", request_id: requestIdOf(res) }, echoHeaders);
      }
      throw err;
    }
  }

  if (deps.enableDevRoutes === true && req.method === "POST" && url.pathname === "/worker/tick") {
    // Dev-hjelper: kjør køen én runde (produksjonsworker kjører på intervall i main).
    const ran = await deps.worker.drain();
    return json(res, 200, { ran });
  }

  if (deps.enableDevRoutes === true && req.method === "POST" && url.pathname === "/tools/critical-demo") {
    // Klasse D-stub (fase 3-avgrensning): beviser at kritiske verktøy
    // blokkeres uten gyldig signert godkjenning i den KJØRENDE appen.
    // KUN bak `enableDevRoutes` (aldri i produksjon). Remediering del 2: ruten
    // tar IKKE lenger en identitet i kroppen - også dev-ruten bruker grantet.
    const authed = await authedRequest(req, res, deps, ["parameters", "approval"]);
    if (!authed) return;
    const decision = await deps.policy.authorize({
      identity: authed.identity,
      toolCall: {
        tool_id: "demo",
        action: "critical_demo",
        capability_class: "D",
        parameters: (authed.body["parameters"] as Record<string, never> | undefined) ?? {}
      },
      ...(authed.body["approval"] !== undefined ? { approval: authed.body["approval"] } : {})
    });
    if (decision.decision !== "ALLOW") {
      return json(res, 403, { decision: decision.decision, reason: decision.reason });
    }
    return json(res, 200, { decision: "ALLOW", executed: "critical_demo_stub" });
  }

  // WP-G2 (D-464): `/personal/*` finnes KUN når `deps.personal` er satt (minst ett JARVIS_PERSONAL_*-flagg på). Eier-kun og step-up håndheves inni rutene; uten verdien er dette en vanlig 404.
  if (deps.personal !== undefined && url.pathname.startsWith("/personal/")) {
    const personalDeps = deps.personal;
    // WP-G2c (D-483, JARVIS-113 e/5): ALT under `/personal/` bærer personopplysninger (lokasjon, helse, familie, kalender, økonomi, handlinger). `setHeader` (ikke `json()`-argumentet) slik at også 401/400/413/500 fra grant-/kropp-/feilgrenene
    // bærer den: ingen nettleser eller mellomliggende cache skal lagre et svar. Kun her (flagg PÅ): uten `deps.personal` er svarene byte-identiske med main.
    res.setHeader("cache-control", "no-store");
    const handled = await handlePersonalRoute({
      req, res, url, deps: personalDeps,
      authed: (allowedKeys) => authedRequest(req, res, deps, allowedKeys),
      requireOwner: (identity, subject) => requireOwner(res, deps, identity, subject),
      stepUpDenial, json: (status, body) => json(res, status, body), requestId: () => requestIdOf(res),
      fieldString, fieldOptionalString, fieldRecord, fieldOptionalNumber, domainFailure: (status, code, err) => domainFailure(res, status, code, err)
    });
    if (handled) return;
  }

  if (deps.incidents) {
    const { service, deployments, gateway, controls, infraGate, pool } = deps.incidents;

    // JARVIS-001 (remediering del 2): ALLE ruter under /incidents, /deployments,
    // /infra og /observability bruker `authedRequest()` - identitet/tenant/
    // memory space kommer fra det verifiserte grantet, aldri fra kroppen.
    // `memory_space` er derfor IKKE lenger et kroppsfelt: det er grantets scope.

    if (req.method === "POST" && url.pathname === "/incidents/create") {
      const authed = await authedRequest(req, res, deps, ["title", "severity"]);
      if (!authed) return;
      const severity = fieldOptionalString(authed.body, "severity") as "low" | "normal" | "high" | "critical" | undefined;
      const incident = await service.createIncident(authed.identity.tenant_id, authed.identity.memory_space_id, {
        title: fieldString(authed.body, "title"), ...(severity !== undefined ? { severity } : {}),
        owner_person_id: authed.identity.person_id
      });
      return json(res, 200, { incident });
    }

    if (req.method === "POST" && url.pathname === "/incidents/get") {
      const authed = await authedRequest(req, res, deps, ["incident_id"]);
      if (!authed) return;
      const incidentId = fieldString(authed.body, "incident_id");
      const incident = await service.getIncident(authed.identity.tenant_id, authed.identity.memory_space_id, incidentId);
      if (!incident) return json(res, 404, { error: "incident_not_found", request_id: requestIdOf(res) });
      const evidence = await service.listEvidence(authed.identity.tenant_id, authed.identity.memory_space_id, incidentId);
      // WP-E1: varig overgangshistorikk (hvem/når/hvorfor) og sannhetsmerking per bevis (bekreftet / observert, ikke bekreftet / påstått) følger med.
      const transitions = await service.listTransitions(authed.identity.tenant_id, authed.identity.memory_space_id, incidentId);
      return json(res, 200, {
        incident: withPhase(incident), transitions,
        evidence: evidence.map((e) => ({ ...e, truth_no: truthLabelNo(e.status) }))
      });
    }

    if (req.method === "POST" && url.pathname === "/incidents/list") {
      const authed = await authedRequest(req, res, deps, ["status"]);
      if (!authed) return;
      const requested = fieldOptionalString(authed.body, "status") ?? "open";
      if (requested !== "all" && !INCIDENT_STATUSES.includes(requested as IncidentStatus)) throw new HttpError(400, "malformed_request", "status");
      const incidents = await service.listIncidents(authed.identity.tenant_id, authed.identity.memory_space_id, requested as IncidentStatus | "all");
      return json(res, 200, { incidents: incidents.map(withPhase) });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/add") {
      const authed = await authedRequest(req, res, deps, [
        "incident_id", "source_type", "status", "source_ref", "summary", "observed_at", "contradicts_evidence_id"
      ]);
      if (!authed) return;
      const status = fieldOptionalString(authed.body, "status");
      const sourceRef = fieldOptionalString(authed.body, "source_ref");
      const contradicts = fieldOptionalString(authed.body, "contradicts_evidence_id");
      try {
        const evidence = await service.addEvidence(
          authed.identity.tenant_id, authed.identity.memory_space_id, fieldString(authed.body, "incident_id"), {
            source_type: fieldString(authed.body, "source_type") as never, ...(status !== undefined ? { status: status as never } : {}),
            ...(sourceRef !== undefined ? { source_ref: sourceRef } : {}), summary: fieldString(authed.body, "summary"),
            observed_at: fieldString(authed.body, "observed_at"),
            ...(contradicts !== undefined ? { contradicts_evidence_id: contradicts } : {})
          }
        );
        return json(res, 200, { evidence });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // WP-E1: sannhetstype-regimet - `status: "VERIFIED"` fra avsenderen avvises (ingen kan bekrefte sin egen påstand); `asserted_by` kan ikke oppgis (rutens kropp har ikke feltet), eieren er alltid `owner`.
        return incidentDomainFailure(res, 400, "evidence_rejected", err);
      }
    }

    if (req.method === "POST" && url.pathname === "/incidents/transition") {
      // WP-E1 (JARVIS-068): eierens livssyklus-handlinger - anerkjenn, foreslå/start avbøting, løs, lukk uten tiltak, gjenåpne. Eneste HTTP-vei til en statusendring; aktøren er ALLTID den verifiserte
      // eieren fra grantet (aldri en kropps-oppgitt aktør), årsak er påkrevd, og lovligheten avgjøres av tilstandsmaskinen. Klasse B (intern bokføring, reversibel via «gjenåpne») bak vanlig policy.
      const authed = await authedRequest(req, res, deps, ["incident_id", "action", "reason", "evidence_ref"]);
      if (!authed) return;
      // M3: `actor_kind: "owner"` er bare sant for den SUVERENE eieren (samme predikat som kontrollsentrene) - ikke for enhver autentisert person i eierens tenant.
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "incidents", action: "transition" }))) return;
      const action = fieldString(authed.body, "action");
      if (!Object.prototype.hasOwnProperty.call(OWNER_LIFECYCLE_ACTIONS, action)) throw new HttpError(400, "malformed_request", "action");
      const decision = await deps.policy.authorize({
        identity: authed.identity,
        toolCall: { tool_id: "incidents", action: "transition", capability_class: "B", parameters: { action } }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      const evidenceRef = fieldOptionalString(authed.body, "evidence_ref");
      try {
        const incident = await service.transition(
          authed.identity.tenant_id, authed.identity.memory_space_id, fieldString(authed.body, "incident_id"),
          OWNER_LIFECYCLE_ACTIONS[action as keyof typeof OWNER_LIFECYCLE_ACTIONS], { kind: "owner", person_id: authed.identity.person_id },
          { reason: fieldString(authed.body, "reason"), ...(evidenceRef !== undefined ? { evidence_ref: evidenceRef } : {}) }
        );
        if (!incident) return json(res, 404, { error: "incident_not_found", request_id: requestIdOf(res) });
        return json(res, 200, { incident: withPhase(incident) });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        return incidentDomainFailure(res, 409, "transition_rejected", err);
      }
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate") {
      const authed = await authedRequest(req, res, deps, ["incident_id", "repo"]);
      if (!authed) return;
      try {
        const correlation = await correlateIncident(
          service, deployments, authed.identity.tenant_id, authed.identity.memory_space_id,
          fieldString(authed.body, "incident_id"), fieldString(authed.body, "repo")
        );
        return json(res, 200, { correlation });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        return domainFailure(res, 404, "correlation_failed", err);
      }
    }

    if (req.method === "POST" && url.pathname === "/deployments/ingest/github") {
      // D-105 (UA-5 kriterium 1 host-fix): den EKSISTERENDE `DeploymentService.
      // recordDeployment()` sin FØRSTE produksjons-callsite. Kaller UTELUKKENDE
      // `ingestGithubDeployment()`, som selv går via `ToolGateway`/
      // `github.get_workflow_run` - INGEN egen HTTP/Octokit-klient her, INGEN
      // rå credential i request-body.
      const authed = await authedRequest(req, res, deps, ["repo", "workflow_run_id"]);
      if (!authed) return;
      const outcome = await ingestGithubDeployment({ gateway, deployments }, authed.identity, {
        repo: fieldString(authed.body, "repo"), workflow_run_id: fieldString(authed.body, "workflow_run_id")
      });
      if (outcome.status === "provider_unavailable") return json(res, 502, { error: "provider_unavailable", reason: outcome.reason });
      if (outcome.status === "invalid_provider_response") return json(res, 422, { error: "invalid_provider_response", reason: outcome.reason });
      return json(res, 200, { deployment: outcome.deployment, created: outcome.created, provenance: outcome.provenance });
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate/db") {
      const authed = await authedRequest(req, res, deps, ["window_start", "window_end"]);
      if (!authed) return;
      const db_state = await correlateDbState(
        pool, authed.identity.tenant_id, fieldString(authed.body, "window_start"), fieldString(authed.body, "window_end")
      );
      return json(res, 200, { db_state });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/acquire_logs") {
      const authed = await authedRequest(req, res, deps, ["incident_id", "container", "since", "until", "tail"]);
      if (!authed) return;
      const since = fieldOptionalString(authed.body, "since");
      const until = fieldOptionalString(authed.body, "until");
      const tail = fieldOptionalNumber(authed.body, "tail");
      const outcome = await acquireContainerLogs(
        { gateway, incidents: service }, authed.identity, authed.identity.memory_space_id,
        fieldString(authed.body, "incident_id"), {
          container: fieldString(authed.body, "container"), ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}), ...(tail !== undefined ? { tail } : {})
        }
      );
      if (outcome.status === "unavailable") return json(res, 502, { error: "acquisition_unavailable", reason: outcome.reason });
      return json(res, 200, { evidence: outcome.evidence });
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/create") {
      const diagnosisService = deps.incidents.diagnosis;
      const authed = await authedRequest(req, res, deps, [
        "incident_id", "conclusion", "status", "source", "supersedes_diagnosis_id",
        "supporting_evidence_ids", "contradicting_evidence_ids"
      ]);
      if (!authed) return;
      const status = fieldOptionalString(authed.body, "status");
      const supersedes = fieldOptionalString(authed.body, "supersedes_diagnosis_id");
      const supporting = fieldOptionalStringArray(authed.body, "supporting_evidence_ids");
      const contradicting = fieldOptionalStringArray(authed.body, "contradicting_evidence_ids");
      // WP-E1: en `deterministic` diagnose kommer fra KODE, aldri fra en HTTP-kaller (ellers kunne avsenderen selv gi sin påstand deterministisk status). Over HTTP: kun eier eller modell-assistert.
      if (!["owner", "model_assisted"].includes(fieldString(authed.body, "source"))) throw new HttpError(400, "malformed_request", "source");
      try {
        const diagnosis = await diagnosisService.createDiagnosis(
          authed.identity.tenant_id, authed.identity.memory_space_id, fieldString(authed.body, "incident_id"), {
            conclusion: fieldString(authed.body, "conclusion"), source: fieldString(authed.body, "source") as never,
            ...(status !== undefined ? { status: status as never } : {}),
            ...(supersedes !== undefined ? { supersedes_diagnosis_id: supersedes } : {}),
            ...(supporting !== undefined ? { supporting_evidence_ids: supporting } : {}),
            ...(contradicting !== undefined ? { contradicting_evidence_ids: contradicting } : {})
          }
        );
        return json(res, 200, { diagnosis });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        return incidentDomainFailure(res, 400, "diagnosis_rejected", err);
      }
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/list") {
      const diagnosisService = deps.incidents.diagnosis;
      const authed = await authedRequest(req, res, deps, ["incident_id"]);
      if (!authed) return;
      const diagnoses = await diagnosisService.listDiagnoses(
        authed.identity.tenant_id, authed.identity.memory_space_id, fieldString(authed.body, "incident_id")
      );
      return json(res, 200, { diagnoses });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/mutate") {
      const authed = await authedRequest(req, res, deps, ["target", "action", "target_image", "idempotency_key", "incident_id"]);
      if (!authed) return;
      // D-105 host-fix: `action` er valgfri - default `redeploy_container`
      // (bakoverkompatibelt med D105_INFRA_OPS_V2_HOST_ACCEPTANCE.md sine
      // eksisterende eksempler, som ikke sender `action`). Nye kall bruker
      // `stop_container`/`start_container` for produksjons-autorisert mutasjon.
      const action = (fieldOptionalString(authed.body, "action") ?? "redeploy_container") as DockerMutationAction;
      const targetImage = fieldOptionalString(authed.body, "target_image");
      const incidentId = fieldOptionalString(authed.body, "incident_id");
      const execution = await executeInfraMutation({ pool, gateway }, authed.identity, {
        tenant_id: authed.identity.tenant_id, person_id: authed.identity.person_id,
        device_id: authed.identity.device_id,
        target: fieldString(authed.body, "target"), action, idempotency_key: fieldString(authed.body, "idempotency_key"),
        ...(targetImage !== undefined ? { target_image: targetImage } : {}),
        ...(incidentId !== undefined ? { incident_id: incidentId } : {})
      });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/get") {
      const authed = await authedRequest(req, res, deps, ["execution_id"]);
      if (!authed) return;
      const execution = await getInfraExecution(pool, authed.identity.tenant_id, fieldString(authed.body, "execution_id"));
      if (!execution) return json(res, 404, { error: "execution_not_found", request_id: requestIdOf(res) });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/infra/cloud/mutate") {
      // WP-E1 (UA-5): kritisk mutasjon mot et kontrollert skymål (Cloudflare) med SAMME sammenhengende før/etter-journal som Docker (`infra_executions`).
      // Selve utførelsen går UTELUKKENDE via `ToolGateway.execute()` (policy, InfraExecutionGate, frys, sone-autorisasjon, klasse D-kjede, varsling) -
      // ruten omgår ingenting. Identitet fra det verifiserte grantet (som alle kontrollruter); credential-bindingen avviser alle andre enn eieren.
      const authed = await authedRequest(req, res, deps, ["provider", "action", "parameters", "idempotency_key", "incident_id"]);
      if (!authed) return;
      // M2/M3: skymutasjoner (DNS/WAF/SSL, Postgres-økter, Infisical-rotasjon) er EIER-kun og krever step-up (enhetssignert økt fra web/desktop/api/mobile). Svaret er et tydelig `step_up_required`
      // FØR noe journalføres - gatewayen håndhever det samme på verktøynivå (`ToolDefinition.step_up_required`) uavhengig av denne ruten.
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "infra", action: "cloud_mutate" }))) return;
      const cloudStepUp = stepUpDenial(authed.identity, "cloud_mutate");
      if (cloudStepUp) return json(res, 403, { error: "step_up_required", reason: cloudStepUp, request_id: requestIdOf(res) });
      const incidentId = fieldOptionalString(authed.body, "incident_id");
      try {
        const execution = await executeCloudMutation({ pool, gateway }, authed.identity, {
          tenant_id: authed.identity.tenant_id, person_id: authed.identity.person_id, device_id: authed.identity.device_id,
          provider: fieldString(authed.body, "provider"), action: fieldString(authed.body, "action"),
          parameters: fieldRecord(authed.body, "parameters") as Record<string, JsonValue>,
          idempotency_key: fieldString(authed.body, "idempotency_key"),
          ...(incidentId !== undefined ? { incident_id: incidentId } : {})
        });
        return json(res, 200, { execution });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Kun VÅRE egne, bevisste feilkoder (ukjent leverandør/handling, nøkkelkonflikt) vises til eieren; alt annet logges og blir generisk.
        const reason = (err as Error).message;
        if (/^(cloud_mutation_[a-z_]+|infra_idempotency_key_conflict)(?::|$)/.test(reason)) return json(res, 400, { error: "cloud_mutation_rejected", reason: reason.slice(0, 80), request_id: requestIdOf(res) });
        return domainFailure(res, 400, "cloud_mutation_rejected", err);
      }
    }

    if (req.method === "POST" && url.pathname === "/infra/cloud/read") {
      // WP-E1 (UA-5): klasse A-lesing av de kontrollerte skymålene (Cloudflare/Langfuse/Infisical/Postgres-drift) for eieren - bl.a. økt-identiteten (pid + backend_start) en
      // terminate/cancel krever. Går UTELUKKENDE via `ToolGateway.execute()` (policy, credential-binding til eieren, infra-gate, revisjon); kun registrerte klasse A-handlinger
      // i de fire verktøy-id-ene kan nås - aldri en skrivehandling, aldri et annet verktøy. Utdata er ubetrodd data (merket som sådan), aldri instruksjoner.
      const authed = await authedRequest(req, res, deps, ["provider", "action", "parameters"]);
      if (!authed) return;
      const provider = fieldString(authed.body, "provider");
      const action = fieldString(authed.body, "action");
      const definition = CLOUD_CONTROL_TOOL_IDS.has(provider) ? gateway.get(provider, action) : undefined;
      if (!definition) return json(res, 400, { error: "cloud_read_unknown_action", request_id: requestIdOf(res) });
      if (definition.capability_class !== "A") return json(res, 400, { error: "cloud_read_not_a_read_action", request_id: requestIdOf(res) });
      const result = await gateway.execute({
        identity: authed.identity, tool_id: provider, action,
        parameters: (authed.body["parameters"] === undefined ? {} : fieldRecord(authed.body, "parameters")) as Record<string, JsonValue>
      });
      if (!result.ok) return json(res, 200, { ok: false, reason: result.reason.slice(0, 120), request_id: requestIdOf(res) });
      return json(res, 200, { ok: true, output_trust: result.output_trust, data: result.data ?? null });
    }

    if (deps.growthWrites?.writes && req.method === "POST" && url.pathname === "/growth/mutate") {
      // WP-D3 (UA-4 Growth, D-459): eier-initiert skriving mot en annonse-/analyseplattform (budsjett, bud, status, nøkkelord, kreativer ...). Rekkefølge: grant -> KUN eieren (ingen delegat) -> step-up (enhetssignert økt) ->
      // `executeGrowthWrite` (journal + `ToolGateway.execute()`: mål-autorisasjon, klasse D-kjede, idempotens, readback, varsling). Svaret er journalraden med FØR-/ETTER-tilstand og utfall (SUCCESS/NOOP/UNKNOWN/PARTIAL/FAILED).
      const authed = await authedRequest(req, res, deps, ["provider", "action", "parameters", "idempotency_key", "command_id", "experiment_id", "variant_id"]);
      if (!authed) return;
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "growth", action: "mutate" }))) return;
      const growthStepUp = stepUpDenial(authed.identity, "growth_mutate");
      if (growthStepUp) return json(res, 403, { error: "step_up_required", reason: growthStepUp, request_id: requestIdOf(res) });
      const commandId = fieldOptionalString(authed.body, "command_id");
      const experimentId = fieldOptionalString(authed.body, "experiment_id");
      const variantId = fieldOptionalString(authed.body, "variant_id");
      try {
        const execution = await executeGrowthWrite(deps.growthWrites.executor, authed.identity, {
          provider: fieldString(authed.body, "provider"), action: fieldString(authed.body, "action"), parameters: fieldRecord(authed.body, "parameters") as Record<string, JsonValue>,
          idempotency_key: fieldString(authed.body, "idempotency_key"), source: "owner_route", session_id: authed.identity.session_id,
          ...(commandId !== undefined ? { command_id: commandId } : {}), ...(experimentId !== undefined ? { experiment_id: experimentId } : {}), ...(variantId !== undefined ? { variant_id: variantId } : {})
        });
        return json(res, 200, { execution });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Kun VÅRE egne, bevisste feilkoder (ukjent handling, nøkkel-/kommando-/konfliktfeil) vises til eieren; alt annet logges og blir generisk.
        const reason = (err as Error).message;
        if (/^(growth_write_[a-z_]+|growth_command_[a-z_]+)(?::|$)/.test(reason)) return json(res, 400, { error: "growth_write_rejected", reason: reason.slice(0, 80), request_id: requestIdOf(res) });
        return domainFailure(res, 400, "growth_write_rejected", err);
      }
    }

    if (deps.growthWrites?.writes && req.method === "POST" && url.pathname === "/growth/read") {
      // WP-D3: klasse A-lesing av leverandørtilstand (kampanje-/annonsegruppe-/nøkkelord-/eiendomstilstand osv.) for eieren. Kun registrerte klasse A-handlinger i skrive-familiens navnerom kan nås; utdata er UBETRODD data
      // (kampanje-/kreativ-/omtaletekst er leverandør- eller brukerskrevet) og merkes som sådan - aldri instruksjoner.
      const authed = await authedRequest(req, res, deps, ["provider", "action", "parameters"]);
      if (!authed) return;
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "growth", action: "read" }))) return;
      const entry = deps.growthWrites.executor.index.get(`${fieldString(authed.body, "provider")}.${fieldString(authed.body, "action")}`);
      if (!entry || entry.op.risk !== "A" || !deps.growthWrites.executor.gateway.get(entry.spec.toolId, entry.op.action)) return json(res, 400, { error: "growth_read_unknown_action", request_id: requestIdOf(res) });
      const result = await deps.growthWrites.executor.gateway.execute({
        identity: authed.identity, tool_id: entry.spec.toolId, action: entry.op.action,
        parameters: (authed.body["parameters"] === undefined ? {} : fieldRecord(authed.body, "parameters")) as Record<string, JsonValue>
      });
      if (!result.ok) return json(res, 200, { ok: false, reason: result.reason.slice(0, 120), request_id: requestIdOf(res) });
      return json(res, 200, { ok: true, output_trust: result.output_trust, data: result.data ?? null });
    }

    if (deps.growthWrites?.writes && req.method === "POST" && url.pathname === "/growth/writes/list") {
      // WP-D3: skrivejournalen (FØR-/ETTER-tilstand, utfall, proveniens) for eieren. Ren lesing under RLS.
      const authed = await authedRequest(req, res, deps, ["campaign_id", "status", "provider", "limit"]);
      if (!authed) return;
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "growth", action: "writes_list" }))) return;
      const status = fieldOptionalString(authed.body, "status") as GrowthWriteStatusFilter | undefined;
      if (status !== undefined && !["requested", "applied", "failed", "outcome_unknown"].includes(status)) return json(res, 400, { error: "malformed_request", reason: "status", request_id: requestIdOf(res) });
      const campaignFilter = fieldOptionalString(authed.body, "campaign_id");
      const providerFilter = fieldOptionalString(authed.body, "provider");
      const limit = fieldOptionalNumber(authed.body, "limit");
      const writes = await deps.growthWrites.executor.journal.list(authed.identity.tenant_id, authed.identity.memory_space_id as never, {
        ...(campaignFilter !== undefined ? { campaign_id: campaignFilter } : {}), ...(status !== undefined ? { status } : {}), ...(providerFilter !== undefined ? { provider: providerFilter } : {}), ...(limit !== undefined ? { limit } : {})
      });
      return json(res, 200, { writes });
    }

    if (deps.growthWrites?.experiments && req.method === "POST" && url.pathname === "/growth/experiments") {
      // WP-D3: eksperimentregisteret (plan/variant/observasjon/utfall, evaluering, kreativ-intelligens) for eieren. Går via `ToolGateway.execute()` (verktøyet `growth.*` er eier-eksklusivt). Skriving krever step-up.
      const authed = await authedRequest(req, res, deps, ["action", "parameters", "idempotency_key"]);
      if (!authed) return;
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "growth", action: "experiments" }))) return;
      const action = fieldString(authed.body, "action");
      const definition = (GROWTH_EXPERIMENT_TOOL_ACTIONS as readonly string[]).includes(action) ? deps.growthWrites.executor.gateway.get("growth", action) : undefined;
      if (!definition) return json(res, 400, { error: "growth_experiment_unknown_action", request_id: requestIdOf(res) });
      if (definition.capability_class !== "A") {
        const experimentStepUp = stepUpDenial(authed.identity, "growth_experiments");
        if (experimentStepUp) return json(res, 403, { error: "step_up_required", reason: experimentStepUp, request_id: requestIdOf(res) });
      }
      const idempotencyKey = fieldOptionalString(authed.body, "idempotency_key");
      const result = await deps.growthWrites.executor.gateway.execute({
        identity: authed.identity, tool_id: "growth", action, ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
        parameters: (authed.body["parameters"] === undefined ? {} : fieldRecord(authed.body, "parameters")) as Record<string, JsonValue>
      });
      if (!result.ok) return json(res, 200, { ok: false, reason: result.reason.slice(0, 120), request_id: requestIdOf(res) });
      return json(res, 200, { ok: true, output_trust: result.output_trust, data: result.data ?? null });
    }

    if (req.method === "POST" && url.pathname === "/observability/docker/status") {
      const authed = await authedRequest(req, res, deps, []);
      if (!authed) return;
      const status = await dockerProviderStatus(gateway, authed.identity);
      return json(res, 200, { status });
    }

    if (deps.tasks && req.method === "POST" && url.pathname === "/incidents/repair") {
      const authed = await authedRequest(req, res, deps, [
        "incident_id", "repo_url", "goal", "test_command", "publish_pr", "model_budget_ore"
      ]);
      if (!authed) return;
      // M3: reparasjon setter i gang en betalt agentkjøring som kan pushe/åpne en PR - EIER-kun og step-up (enhetssignert økt fra en eier-kanal), og budsjettet kan aldri økes utover serverens tak (`proposeRepairTask`).
      if (!(await requireOwner(res, deps, authed.identity, { tool_id: "incidents", action: "repair" }))) return;
      const repairStepUp = stepUpDenial(authed.identity, "incident_repair");
      if (repairStepUp) return json(res, 403, { error: "step_up_required", reason: repairStepUp, request_id: requestIdOf(res) });
      const incident = await service.getIncident(
        authed.identity.tenant_id, authed.identity.memory_space_id, fieldString(authed.body, "incident_id")
      );
      if (!incident) return json(res, 404, { error: "incident_not_found", request_id: requestIdOf(res) });
      // WP-E1 (JARVIS-068): `test_command` er PÅKREVD (validert mot testløper-allowlisten i `proposeRepairTask`) - aldri en vakuøs standardtest som alltid består.
      const testCommand = fieldOptionalStringArray(authed.body, "test_command") ?? [];
      const publishPr = fieldOptionalBoolean(authed.body, "publish_pr");
      const budget = fieldOptionalNumber(authed.body, "model_budget_ore");
      const result = await proposeRepairTask(
        { taskService: deps.tasks, pool, incidents: service },
        authed.identity, authed.identity.memory_space_id, incident,
        {
          repo_url: fieldString(authed.body, "repo_url"), goal: fieldString(authed.body, "goal"),
          test_command: testCommand,
          ...(publishPr !== undefined ? { publishPr } : {}),
          ...(budget !== undefined ? { model_budget_ore: budget } : {})
        }
      );
      if (!result.ok) return json(res, 400, { error: "repair_task_rejected", reason: result.reason, request_id: requestIdOf(res) });
      return json(res, 200, { task_id: result.task_id });
    }

    if (req.method === "POST" && url.pathname === "/infra/recovery/attempt") {
      const authed = await authedRequest(req, res, deps, [
        "tool_id", "action", "idempotency_key", "parameters", "incident_id", "execution_id"
      ]);
      if (!authed) return;
      const toolId = fieldString(authed.body, "tool_id");
      const recoveryAction = fieldString(authed.body, "action");
      // M2: gjenoppretting av en skymutasjon (Cloudflare/Postgres-drift/Infisical) er selv en skrivehandling mot skyen og krever samme step-up som selve mutasjonen (gatewayen håndhever det uansett).
      if (CLOUD_CONTROL_TOOL_IDS.has(toolId)) {
        const recoveryStepUp = stepUpDenial(authed.identity, "cloud_recovery");
        if (recoveryStepUp) return json(res, 403, { error: "step_up_required", reason: recoveryStepUp, request_id: requestIdOf(res) });
      }
      const decision = await deps.policy.authorize({
        identity: authed.identity,
        toolCall: { tool_id: "infra", action: "attempt_recovery", capability_class: "B", parameters: { tool_id: toolId, action: recoveryAction } }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      const incidentId = fieldOptionalString(authed.body, "incident_id");
      const executionId = fieldOptionalString(authed.body, "execution_id");
      const recovery = await attemptRecovery({ pool, gateway }, authed.identity, {
        tenant_id: authed.identity.tenant_id, tool_id: toolId, action: recoveryAction,
        idempotency_key: fieldString(authed.body, "idempotency_key"),
        parameters: (authed.body["parameters"] === undefined ? {} : fieldRecord(authed.body, "parameters")) as Record<string, never>,
        ...(incidentId !== undefined ? { incident_id: incidentId } : {}),
        ...(executionId !== undefined ? { execution_id: executionId } : {})
      });
      return json(res, 200, { recovery });
    }

    if (req.method === "POST" && (url.pathname === "/infra/pause" || url.pathname === "/infra/resume" || url.pathname === "/infra/degrade")) {
      const authed = await authedRequest(req, res, deps, ["reason"]);
      if (!authed) return;
      const action = url.pathname.slice("/infra/".length);
      const decision = await deps.policy.authorize({
        identity: authed.identity,
        toolCall: { tool_id: "infra", action, capability_class: "B", parameters: {} }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      const reason = fieldOptionalString(authed.body, "reason");
      // D-438: varig overgang (delt med workeren), kun for eieren. Feiler lagringen etter en innstramming, er DENNE prosessen likevel stanset (strengeste-av) - men
      // kalleren får feilen, ikke en falsk suksess: den delte modusen (og dermed workeren) er da IKKE endret.
      try {
        if (action === "pause") await infraGate.pauseDurable(reason ?? "owner_requested", authed.identity.person_id);
        else if (action === "degrade") await infraGate.degradeDurable(reason ?? "owner_requested", authed.identity.person_id);
        else await infraGate.resumeDurable(authed.identity.person_id);
      } catch (err) {
        if (err instanceof OwnerControlUnauthorizedError) return json(res, 403, { error: "owner_control_unauthorized", request_id: requestIdOf(res) });
        return domainFailure(res, 500, "infra_mode_persist_failed", err);
      }
      return json(res, 200, { state: (await infraGate.statusDurable()).state });
    }

    if (req.method === "POST" && url.pathname === "/infra/status") {
      const authed = await authedRequest(req, res, deps, []);
      if (!authed) return;
      const infra = await infraGate.statusDurable();
      return json(res, 200, {
        infra_mode: infra.state,
        infra_mode_local: infra.local,
        infra_mode_shared: infra.shared,
        infra_mode_shared_readable: infra.shared_readable,
        // false = en innstramming gjelder KUN denne prosessen (f.eks. en pause som ikke fikk lagret) eller den delte modusen kan ikke leses: workeren er da ikke nødvendigvis stanset.
        infra_mode_in_sync: infra.in_sync,
        connector_health: Object.fromEntries(gateway.health),
        frozen_connectors: controls ? ["github"].filter((id) => controls.isFrozen(id)) : []
      });
    }
  }

  json(res, 404, { error: "not_found", request_id: requestIdOf(res) });
}
