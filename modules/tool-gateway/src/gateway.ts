import type pg from "pg";
import { z } from "zod";
import type { CapabilityClass, IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import { UnsafeVendorUrlError, guardedFetch } from "./url-safety.ts";
import { currentCallSignal, detachFromCallSignal, invokeWithCallSignal, toolCallAbortEnabled } from "./call-signal.ts";
import { currentModelScope, runWithModelScope } from "./model-scope.ts";
import { assessClassDPipeline, isClassDExempt, isNotFoundError, ownerStepUpDenial, type ClassDNotifier, type ClassDPipelineOptions } from "./class-d-pipeline.ts";
import { isIndeterminateTransportError, transportErrorKind } from "./transport-errors.ts";
import { isPolicyDenied } from "./policy-denied.ts";
import { isFinancialNamespace } from "./tool-manifest.ts";
import type { AutonomyBindability } from "./autonomy-bindable.ts";
import {
  IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_REUSE_MISMATCH, REQUEST_DIGEST_INVALID_PREFIX, digestForRequest, judgeKeyReuse, requestDigestMode, shortFingerprint, type RequestDigestMode
} from "./request-digest-gate.ts";
import { isSelfRecoveryAction, type OwnerControls, type PolicyGateway } from "@jarvis/policy";

/**
 * Gjennomgang av PR #316 (M-1): helsen til en credential-kilde etter siste oppslag. `unavailable` = kilden svarte ikke / feilet (nettverk, 5xx, auth), `unconfigured` = kilden er ikke i bruk (mangler URL/klient),
 * `healthy` = siste oppslag gikk bra. En kilde som ikke kan feile (miljøvariabler) har ingen helse.
 */
export type SecretSourceHealth = "healthy" | "unavailable" | "unconfigured";

/**
 * Gjennomgang av PR #316 (M-1): presence er TRI-STATE. `absent` er en MÅLING (kilden svarte og har ingen verdi); `unknown` betyr at kilden ikke kunne spørres. `get()` kan ikke skille de to (begge gir null, fail-closed ved
 * kall), og derfor ble «Infisical nede» vist som «ikke konfigurert» med status OK i kontrollsenteret.
 */
export type SecretPresence = "present" | "absent" | "unknown";

/** WP-K (D-471, JARVIS-054): korrelasjonen som følger en revisjonsrad: oppgave-/spor-ID fra kalleren og ID-en til Policy Gateway-avgjørelsen som førte til raden. */
interface AuditCorrelation {
  task_id?: string;
  trace_id?: string;
  policy_decision_id?: string;
}

/** Secrets bak adapter (D-16): env/SOPS nå; Infisical/OpenBao (Q-05, krever Docker) senere. */
export interface SecretProvider {
  readonly name: string;
  /** Returnerer credential eller null. Verdien går ALDRI i logg/trace/modellkontekst. */
  get(ref: string): Promise<string | null>;
  /** Helsen til kilden etter siste oppslag (se `SecretSourceHealth`). Utelatt/`undefined` = kilden kan ikke feile (eller kjeden har ingen del med helse). */
  readonly health?: SecretSourceHealth | undefined;
  /**
   * Tri-state presence for visning (kontrollsentre, dashbord). Implementeres av kilder der «null» kan bety både «finnes ikke» og «kunne ikke måles» (Infisical). Utelatt: `secretPresenceOf` utleder den fra `get()`
   * og `health` (null + `health === "unavailable"` er `unknown`, ikke `absent`). Skal aldri kaste og aldri returnere verdien.
   */
  presence?(ref: string): Promise<SecretPresence>;
  /**
   * VALGFRI (WP-C3 review F3): tilstedeværelse UTEN å materialisere verdien. `ToolGateway.hasSecret()` bruker den hvis den finnes, ellers `get(ref) !== null`. Trengs av leverandører der
   * `get` har en SIDEEFFEKT eller kostnad - i dag GitHub App-dekoratøren, hvor `get` utsteder et installasjonstoken (et kall mot GitHub): uten `has` ville hver statuspoll, helse-sveip
   * og dashbord-visning («er X konfigurert») utstedt et token, selv for en tilbakekalt credential. Skal aldri kaste (`false` = ikke tilgjengelig) og aldri gjøre nettverkskall mot
   * selve tjenesten credentialen gjelder. En wrapper som ikke videresender `has` faller trygt tilbake til `get`.
   */
  has?(ref: string): Promise<boolean>;
}

/**
 * Presence for én kilde som tri-state. Bruker kildens egen `presence()` når den finnes (deterministisk, ingen delt tilstand); ellers utledes den av `get()` og `health`: en verdi er `present`, null fra en kilde som
 * rapporterer `unavailable` er `unknown`, og null ellers er `absent`. En tom streng er aldri en gyldig credential (D-236) og regnes som fraværende, som `ToolGateway.execute()` gjør.
 */
export async function secretPresenceOf(provider: SecretProvider, ref: string): Promise<SecretPresence> {
  if (typeof provider.presence === "function") return provider.presence(ref);
  // WP-C3 (review F3): en kilde med `has` (GitHub App-dekoratøren: `get` utsteder et installasjonstoken) svarer på presence uten å materialisere noe.
  if (typeof provider.has === "function") {
    let has = false;
    try {
      has = await provider.has(ref);
    } catch {
      has = false;
    }
    if (has) return "present";
    return provider.health === "unavailable" ? "unknown" : "absent";
  }
  const value = await provider.get(ref);
  if (value) return "present";
  return provider.health === "unavailable" ? "unknown" : "absent";
}
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env-sops";
  /**
   * D-236 (funn i Tobias sin faktiske host-kjøring, 2026-09-22): en linje som
   * `JARVIS_VIPPS_CLIENT_ID=` i `.env` (uutfylt placeholder, IKKE et bevisst
   * tomt secret) gir `process.env[ref] === ""` inne i containeren - IKKE
   * `undefined`. Det opprinnelige `process.env[ref] ?? null` fanget kun
   * `undefined`/`null`, aldri tom streng, så `hasSecret()`/dashbordets
   * "konfigurert"-visning viste FEILAKTIG ✓ for enhver connector der
   * `.env.example` har en uutfylt `NØKKEL=`-linje for referansen (så godt
   * som alle) - reprodusert live: Vipps viste "konfigurert" med tomme
   * `.env`-felt. En tom streng er ALDRI en gyldig credential-verdi, uansett
   * kilde - behandles nå identisk med "ikke satt".
   */
  async get(ref: string): Promise<string | null> {
    const value = process.env[ref];
    return value ? value : null;
  }
}

/**
 * Task #122 (connector credential-skriving, D-213): en SEPARAT, opt-in
 * kapabilitet - IKKE en del av `SecretProvider` selv (som `FallbackSecretProvider`
 * og `EnvSecretProvider`/`BusinessInternalSecretProvider` FORTSATT bare
 * implementerer les-kontrakten, uendret). Kun leverandører som FAKTISK
 * tilbyr en skrive-API (i dag: Infisical) implementerer denne - et forsøk på
 * å skrive mot en ikke-skrivbar kjede skal feile TYDELIG
 * (`secret_provider_not_writable`), ALDRI stille falle tilbake til å skrive
 * et sted (f.eks. `.env`, som er git-ignorert og IKKE et sted kjørende kode
 * trygt kan skrive til uten å risikere å miste eierens egne, manuelt satte
 * verdier - se D-41: read-only er kun akseptabelt når leverandøren faktisk
 * ikke tilbyr mer ELLER en genuin isolasjonsgrense hindrer det, aldri fordi
 * det var enklere å kode).
 */
export interface WritableSecretProvider extends SecretProvider {
  /** Skriver (oppretter ELLER oppdaterer) en secret-verdi. Verdien logges/auditeres ALDRI. */
  set(ref: string, value: string): Promise<void>;
}
export function isWritableSecretProvider(provider: SecretProvider): provider is WritableSecretProvider {
  return typeof (provider as Partial<WritableSecretProvider>).set === "function";
}
/**
 * Infisical-secret-provider (D-35): maskinidentitet (universal auth) → hent
 * secret via API. Rå verdi returneres KUN til transport-laget; aldri logget,
 * aldri til modell/Langfuse. Helse eksponeres for /status.
 */
/** Infisical er en lokal sidecar foran HVER credential-oppslag: kort tak (ikke standard 45 s), ellers stanser et hengt sidecar chat-turer. Skriving (dashbord «Lagre») får lengre tid. */
const INFISICAL_READ_TIMEOUT_MS = 5_000;
const INFISICAL_WRITE_TIMEOUT_MS = 15_000;

export class InfisicalSecretProvider implements SecretProvider {
  readonly name = "infisical";
  private token: string | null = null;
  /** Gjennomgang av PR #316 (L-3): ÉN pågående innlogging deles av alle samtidige oppslag (en Integration-bygging leser ~87 refs; uten dette ga `this.token ??= await this.login()` opptil 87 parallelle innlogginger). */
  private loginInflight: Promise<string> | null = null;
  health: SecretSourceHealth = "unconfigured";

  constructor(
    private readonly baseUrl = process.env["INFISICAL_URL"],
    private readonly clientId = process.env["INFISICAL_CLIENT_ID"],
    private readonly clientSecret = process.env["INFISICAL_CLIENT_SECRET"],
    private readonly projectId = process.env["INFISICAL_PROJECT_ID"],
    // D-340: samme "en tom, men til stede, .env-verdi ER IKKE 'usatt'"-bug
    // D-236 (rett over, EnvSecretProvider.get()) allerede fikset i DENNE
    // filen - `??` fanger kun null/undefined, ikke tom streng, så en uutfylt
    // `INFISICAL_ENV=`-linje i .env ga tidligere `environment=""` i alle
    // Infisical-kall i stedet for defaulten "dev". `||` (streng, aldri en
    // gyldig tom verdi) løser det samme her, samme semantikk som ovenfor.
    private readonly env = process.env["INFISICAL_ENV"] || "dev"
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret && this.projectId);
  }

  private async login(): Promise<string> {
    const response = await guardedFetch(`${this.baseUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST", signal: AbortSignal.timeout(INFISICAL_READ_TIMEOUT_MS), headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret })
    });
    if (!response.ok) throw new Error(`infisical_login_${response.status}`);
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  /** Innlogging med single-flight (L-3): samtidige oppslag uten token deler ÉN innlogging; en mislykket innlogging nullstilles slik at neste oppslag prøver på nytt. */
  private ensureToken(): Promise<string> {
    if (this.token !== null) return Promise.resolve(this.token);
    if (this.loginInflight === null) {
      const attempt: Promise<string> = this.login().then((token) => { this.token = token; return token; });
      this.loginInflight = attempt;
      const clear = (): void => { if (this.loginInflight === attempt) this.loginInflight = null; };
      attempt.then(clear, clear);
    }
    return this.loginInflight;
  }

  /** Leser ÉN secret. 404 = «finnes ikke» (null, kilden svarte); enhver annen feil (nettverk, 5xx, auth, ugyldig svar) KASTES. Oppdaterer `health` ved vellykket svar. */
  private async read(ref: string): Promise<string | null> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}?workspaceId=${this.projectId}&environment=${this.env}`;
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(INFISICAL_READ_TIMEOUT_MS), headers: { authorization: `Bearer ${token}` } });
    if (response.status === 401) { this.token = null; throw new Error("infisical_auth_expired"); }
    if (response.status === 404) { this.health = "healthy"; return null; }
    if (!response.ok) throw new Error(`infisical_${response.status}`);
    const value = ((await response.json()) as { secret: { secretValue: string } }).secret.secretValue;
    this.health = "healthy";
    return value;
  }

  private noteFailure(err: unknown): void {
    // En utrygg INFISICAL_URL er en KONFIG-feil, ikke et avbrudd: si det tydelig (uten verdi) i stedet for å se ut som en Infisical-nedetid.
    if (err instanceof UnsafeVendorUrlError) console.error(JSON.stringify({ msg: "infisical_url_unsafe", reason: err.reason }));
    this.health = "unavailable";
  }

  async get(ref: string): Promise<string | null> {
    if (!this.available()) {
      this.health = "unconfigured";
      return null;
    }
    try {
      return await this.read(ref);
    } catch (err) {
      this.noteFailure(err);
      return null; // fail-closed her; FallbackSecretProvider håndterer rollback
    }
  }

  /**
   * Gjennomgang av PR #316 (M-1): TRI-STATE presence uten delt tilstand. `absent` = kilden svarte og har ikke secreten (404) eller er ikke konfigurert (ikke i bruk); `unknown` = kilden kunne ikke spørres
   * (nettverk, 5xx, auth, ugyldig svar). `get()` gir null i begge tilfeller, og derfor kunne «Infisical nede» ikke skilles fra «ikke konfigurert».
   */
  async presence(ref: string): Promise<SecretPresence> {
    if (!this.available()) {
      this.health = "unconfigured";
      return "absent";
    }
    try {
      const value = await this.read(ref);
      return value ? "present" : "absent";
    } catch (err) {
      this.noteFailure(err);
      return "unknown";
    }
  }

  /**
   * Task #122 (D-213): upsert - PATCH (oppdater eksisterende) FØRST, POST
   * (opprett) KUN på 404 (secreten fantes ikke fra før). Rekkefølgen er
   * bevisst: eieren limer ofte inn en NY verdi for en referanse som ALLEREDE
   * har en (utløpt/feil) verdi fra en tidligere manuell oppsett - PATCH er
   * derfor det VANLIGE tilfellet, POST unntaket. Infisical raw secrets v3-
   * API-et (offisiell dokumentasjon, ikke gjettet): `PATCH /api/v3/secrets/
   * raw/{secretName}` og `POST /api/v3/secrets/raw/{secretName}`, begge med
   * kropp `{workspaceId, environment, secretValue}`. Verdien logges ALDRI -
   * kun HTTP-status/feilkode fanges i feilmeldinger.
   */
  async set(ref: string, value: string): Promise<void> {
    if (!this.available()) {
      throw new Error("infisical_unconfigured");
    }
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}`;
    const body = JSON.stringify({ workspaceId: this.projectId, environment: this.env, secretValue: value });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    let response = await guardedFetch(url, { method: "PATCH", signal: AbortSignal.timeout(INFISICAL_WRITE_TIMEOUT_MS), headers, body });
    if (response.status === 401) {
      this.token = null;
      throw new Error("infisical_auth_expired");
    }
    if (response.status === 404) {
      response = await guardedFetch(url, { method: "POST", signal: AbortSignal.timeout(INFISICAL_WRITE_TIMEOUT_MS), headers, body });
    }
    if (!response.ok) {
      this.health = "unavailable";
      throw new Error(`infisical_set_${response.status}`);
    }
    this.health = "healthy";
  }
}

/**
 * Staged migration (D-35): prøv primær (vault) først, fall tilbake til .env
 * hvis vault mangler verdien eller er nede. Gir trygg rollback i overgangen.
 */
export class FallbackSecretProvider implements SecretProvider {
  readonly name = "fallback";
  constructor(
    private readonly primary: SecretProvider,
    private readonly fallback: SecretProvider
  ) {}
  async get(ref: string): Promise<string | null> {
    return (await this.primary.get(ref)) ?? this.fallback.get(ref);
  }

  /** Gjennomgang av PR #316 (M-1): kjedens helse = den verste av delene (`unavailable` hvis en del ikke svarer). Kilder uten helse (miljøvariabler) teller ikke. */
  get health(): SecretSourceHealth | undefined {
    const parts = [this.primary.health, this.fallback.health];
    if (parts.includes("unavailable")) return "unavailable";
    if (parts.includes("healthy")) return "healthy";
    if (parts.includes("unconfigured")) return "unconfigured";
    return undefined;
  }

  /**
   * Tri-state presence for kjeden: `present` så snart en del har verdien (samme regel som `get()`); `absent` KUN når ALLE deler har svart «finnes ikke»; ellers `unknown` - en del som ikke kunne spørres kan ha secreten
   * (Infisical nede og verdien kun der er akkurat tilfellet som ellers ble vist som «ikke konfigurert»).
   */
  async presence(ref: string): Promise<SecretPresence> {
    const first = await this.partPresence(this.primary, ref);
    if (first === "present") return "present";
    const second = await this.partPresence(this.fallback, ref);
    if (second === "present") return "present";
    return first === "absent" && second === "absent" ? "absent" : "unknown";
  }

  private async partPresence(part: SecretProvider, ref: string): Promise<SecretPresence> {
    try {
      return await secretPresenceOf(part, ref);
    } catch {
      return "unknown";
    }
  }
}

/**
 * SECURITY FIX #2 (D-68): kontekst fra DEN OPPRINNELIGE kalleren - IdentityContext
 * og en evt. medfulgt signert godkjenning - som en transport kan trenge for å gjøre
 * et NØSTET, autoritetsbevisst `ToolGateway.execute()`-kall (i dag: `SupportTransport`
 * sin `reply`, som ruter GJENNOM `email.send`, klasse D). ALDRI en fabrikkert/eskalert
 * identitet - `resolveAuthorityMode()` skal EVALUERE den ekte kalleren, aldri stoles
 * blindt på. De aller fleste transporter trenger den ikke og kan la parameteren stå
 * ureferert (strukturell typing tillater færre deklarerte parametre - allerede
 * etablert praksis, se f.eks. `FakeTransport`/`UnconfiguredHttpTransport`).
 */
export interface ToolInvocationContext {
  identity: IdentityContext;
  approval?: unknown;
  /**
   * D-317 (modell-selvbevissthet i `check_my_capabilities`): hvilken
   * leverandør/modell som FAKTISK genererer DENNE samtaleturen, hentet fra
   * `ToolCallRequest.provider`/`.model` (allerede stemplet av hver adapter,
   * se `packages/provider-adapters/src/types.ts`). SAMME "ALDRI fra
   * `parameters`, kun trusted-lag"-disiplin som `identity`/`approval` over -
   * en modell kan ALDRI oppgi sin egen leverandør/modell-identitet selv
   * (ville vært nøyaktig den konfabulasjonsveien `check_my_capabilities`
   * finnes for å stenge).
   */
  servingModel?: { provider: string; model: string };
  /**
   * D-449 (Q-50): hvem som skrev innholdet i `parameters`. `owner_direct` = parameterne er eierens EGNE ord, ordrett (ingen modell har formulert eller omskrevet dem). Settes KUN av trusted kode i
   * kallerens `ToolGateway.execute()`-kall, ALDRI fra `parameters` - SAMME disiplin som `servingModel`. Nøyaktig TO godkjente setter-steder i produksjonskoden (låst av `d449-delegated-tool-jobs-cloud.test.ts`):
   * (1) hurtigbanen i `main.ts` (`delegateBackground`, kun når samtalemotoren sa cloudAllowed), og (2) dashbord-ruten `POST /governance/mutate` i `server.ts` (WP-H1, proveniens på styringsjournalen) - KUN etter løst
   * grant, KUN for den suverene eieren (`ownerGate`) OG kun når grantet er en enhetssignert økt fra en eier-kanal (`ownerStepUpDenial(identity) === undefined`, gjennomgang L3): en svak/passiv/aktiv økt eller en
   * tale-/Telegram-kanal får aldri attesten. Mangler både denne og `servingModel` (f.eks. en eier-godkjent bekreftelse som utfører et modellskrevet kall senere), er innholdets opphav
   * UKJENT, og en transport som bruker opphavet til å åpne en dyrere/mer eksponert rute må da regne det som ikke betrodd (fail-closed).
   */
  contentOrigin?: "owner_direct";
  /**
   * WP-N1 (fiks-runde 1, F-A2): innholdet i `parameters` stammer fra en tur som er LÅST til SECRET_RESTRICTED (D-378: helse/finans, kun lokal modell). En transport som oppretter varig tilstand ut fra kallet (i dag: `tasks.delegate_background_task`,
   * som bærer det som `restricted_origin` i jobbkontrakten, så leveringen av resultatet lagres begrenset i samtalen) må ikke la den miste dette merket. Settes KUN av trusted kode i kallerens `ToolGateway.execute()`-kall, ALDRI fra
   * `parameters` - SAMME disiplin som `servingModel`/`contentOrigin`. Nøyaktig TO godkjente setter-steder i produksjonskoden (låst av `wpn1-job-delivery.test.ts`): (1) hurtigbanen i `main.ts` (`delegateBackground`, kun når samtalemotoren
   * har avgjort at ruten er låst), (2) `MeshToolExecutor` (videreformidler `TurnContext.restricted`, satt av samtalemotoren når turen er låst). Uten dem (vakten AV) er det aldri satt, og alt er som før N1.
   */
  restrictedOrigin?: true;
  /**
   * WP-K (D-471, JARVIS-054): korrelasjons-ID-ene fra det YTRE kallet (`ToolGateway.execute({ task_id, trace_id })`), slik at en transport som gjør NØSTEDE gateway-kall (f.eks. `business.sync_business_events`,
   * som leser Gmail/Calendar som `person_id: "system"`) kan bære dem videre til revisjonsradene og policy-avgjørelsene det nøstede kallet gir. Settes KUN av gatewayen, aldri fra `parameters`.
   */
  task_id?: string;
  trace_id?: string;
  /**
   * WP-G2 (D-464, fiks-runde A-L12): gatewayens idempotensnøkkel for DETTE kallet (klasse C/D krever den), slik at en transport hvis leverandør støtter idempotensnøkkel kan sende SAMME nøkkel videre i stedet for å finne på en ny
   * (en leverandør-side dobbeltkommando hindres da også utenfor Jarvis' ledger). Settes KUN av gatewayen fra `request.idempotency_key`, aldri fra `parameters`. Mangler for kall uten nøkkel (klasse A).
   */
  idempotency_key?: string;
}

/**
 * Transport per integrasjon: ekte HTTP i drift, kontrollert fake i test.
 *
 * WP-K (D-471, JARVIS-018): `signal` er gatewayens avbruddssignal for DETTE kallet - det avbrytes når `ToolDefinition.timeout_ms` slår inn (se `call-signal.ts`). Kontrakten:
 *  - en transport som gjør nettverkskall via `guardedFetch` uten eget `signal` får signalet AUTOMATISK (ambient kontekst) - den trenger ikke gjøre noe, men RETRY-/POLL-løkker må sjekke
 *    `throwIfAborted()` før hvert nytt forsøk og vente med `abortableSleep()`;
 *  - en transport med EGEN I/O (prosess, database, egen `fetch`, eget `signal`) MÅ selv koble `signal ?? currentCallSignal()` til I/O-en (se Docker-, Postgres-drift-, nettleser- og annonse-transportene);
 *  - etter at signalet er avbrutt skal INGEN ny forespørsel sendes (aldri en automatisk retry av en ikke-idempotent POST etter tidsavbrudd - utfallet er da UKJENT og gatewayen har merket raden `unverified`).
 * Parameteren er valgfri: transporter som ikke gjør ekstern I/O (databasebaserte domenetransporter) kan la den stå ureferert, og eldre kallere uten signal er uendret.
 */
export interface ToolTransport {
  invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    credential: string,
    context: ToolInvocationContext,
    signal?: AbortSignal
  ): Promise<{ external_id?: string; data?: JsonValue }>;
}

/** Maskinlesbar verktøydefinisjon (INTEGRATIONS.md §2). */
export interface ToolDefinition {
  tool_id: string;
  action: string;
  description: string;
  input_schema: z.ZodType<Record<string, JsonValue>>;
  capability_class: CapabilityClass;
  scopes: string[];
  reversible: boolean;
  rollback_procedure: string;
  idempotent_external: boolean;
  timeout_ms: number;
  rate_limit_per_minute: number;
  credential_ref: string;
  output_trust: TrustLevel;
  transport: ToolTransport;
  /** v4.0 D-pipeline: handling som leser nå-tilstand for preflight + readback (før/etter-evidens). */
  preflight_action?: string;
  /**
   * Q-34 (funnet 2026-09-09, D-130; lukket i denne cross-domene-audit-sliceen):
   * FØR denne fantes var "fail-closed på et ukjent mål" for klasse D KUN en
   * tilfeldighet av at `preflight_action` fikk transporten til å KASTE for et
   * ukjent mål - en transport som i stedet svarer NORMALT med `data: null`
   * (en helt reell HTTP-/CLI-oppførsel) lot en klasse D-mutasjon mot et mål
   * som aldri fantes rapportere `ok: true`. Denne flagget gjør sjekken
   * STRUKTURELL i stedet for tilfeldig: satt til `true`, krever
   * `ToolGateway.execute()` at preflight-resultatet er eksplisitt IKKE
   * null/undefined FØR selve mutasjonen tillates (se `execute()` under).
   *
   * IKKE sett denne blindt for alle klasse D-verktøy med `preflight_action` -
   * revider FØRST at et null/undefined preflight-resultat for AKKURAT denne
   * handlingen alltid betyr "mål finnes ikke", aldri en gyldig tom tilstand.
   * `docker.redeploy_container` er det kjente moteksempelet: dens
   * `preflight_action` (`inspect_container`) svarer BEVISST `data: null` for
   * "container finnes ikke ennå" som en LEGITIM førstegangs-deploy-tilstand
   * (D-105) - denne flagget er derfor BEVISST IKKE satt der. Se
   * `q34-preflight-target-existence.test.ts` for revisjonen av samtlige
   * eksisterende brukere og en test som tvinger et eksplisitt valg for hver
   * FREMTIDIG klasse D + `preflight_action`-kombinasjon.
   */
  preflight_requires_target?: boolean;
  /**
   * Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82, EXACT_HEAD_SHA
   * 821545f): `preflight_requires_target` beviser KUN at preflight-svaret som
   * HELHET er ikke-null - for et verktøy med et EGET mål-ID-parameter inni en
   * ellers gyldig, ikke-null tilstand (`drive.update_permission`/
   * `delete_permission` sin `permission_id` inni en gyldig, men tom eller
   * ikke-treffende `{permissions: [...]}`-liste), er det IKKE tilstrekkelig -
   * en fil som EKSISTERER men der DEN SPESIFIKKE tillatelsen ikke gjør det,
   * passerte tidligere sjekken og lot en klasse D-mutasjon gå mot et
   * mål-ID som aldri fantes. Denne PREDIKAT-funksjonen kjøres FØR mutasjonen
   * (samme "ingenting å rulle tilbake"-egenskap) og skal returnere `true` KUN
   * når preflight-dataen faktisk viser at DET PÅSTÅTTE mål-ID-et eksisterer -
   * ALDRI bare at RESSURSEN overordnet gjør det. Samme opt-in-disiplin som
   * `preflight_requires_target`: revider FØR bruk, se
   * `q34-preflight-target-existence.test.ts`.
   */
  preflight_target_check?: (data: JsonValue, parameters: Record<string, JsonValue>) => boolean;
  /**
   * Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82): en klasse
   * D-mutasjon hvis readback (etter-tilstand) er ULESELIG (kaster), MANGLER
   * (`data: null`) eller ikke MATCHER det som faktisk ble bedt om, skal ALDRI
   * rapporteres `ok: true` for et verktøy som EKSPLISITT lover
   * resultatverifisering - `ToolGateway.execute()` konverterte tidligere en
   * kastet readback stille til `after_state: null` og returnerte `ok: true`
   * uansett (se `home-assistant-critical-action.test.ts` sine daværende D/E-
   * tester, som nettopp KODIFISERTE dette som akseptert oppførsel). Denne
   * PREDIKAT-funksjonen tar den FAKTISKE etter-tilstanden (aldri `null` når
   * den kalles - `null`/uleselig kortslutter til avslag FØR predikatet nås)
   * og de opprinnelige mutasjonsparametrene, og skal returnere `true` KUN når
   * etter-tilstanden faktisk viser den TILTENKTE nye tilstanden (f.eks.
   * `home-assistant.lock_set` sin `after.locked === parameters.locked`).
   * `tool_executions`-raden og audit-bevismaterialet (before/after/recovery)
   * skrives UENDRET selv når verifiseringen feiler - mutasjonskallet LYKTES
   * strukturelt, og recovery-tooling må fortsatt se before_state - men den
   * RETURNERTE `ToolResult`en blir `ok: false` slik at kalleren ALDRI får
   * inntrykk av en bekreftet handling gatewayen ikke faktisk kunne bevise.
   * Opt-in (samme disiplin som over): uendret oppførsel for alt uten dette
   * feltet satt.
   */
  postcondition_predicate?: (afterState: JsonValue, parameters: Record<string, JsonValue>) => boolean;
  /**
   * D-105 host-fix (D-41-korreksjon): valgfri PARAMETER-nivå-autorisasjon,
   * kjørt av `ToolGateway.execute()` SELV for HVERT kall gjennom denne
   * SAMME, generiske gatewayen - uansett innslagsvei (dedikert REST-rute
   * ELLER en fremtidig samtale-drevet verktøykalls-vei). En transport-
   * spesifikk regel bygget INN I transporten kan omgås av et hvilket som
   * helst annet kall til `gateway.execute()`; denne hooken kan det ikke,
   * fordi den er del av selve gateway-pipelinen (etter policy.authorize()
   * ALLOW, FØR rate-limit/credential/preflight/invoke). I dag brukt KUN av
   * `docker.*`-mål-autorisasjon (se `docker-target-policy.ts`) - generisk
   * mekanisme i gatewayen, ingen docker-spesifikk kode her.
   */
  parameterAuthorizer?: (parameters: Record<string, JsonValue>, identity: IdentityContext) => { allowed: boolean; reason: string };
  /**
   * Del 3 (JARVIS-013/043): `true` når et slette-/fjerne-verktøy bekrefter etterbetingelsen ved at readback svarer «finnes ikke»
   * (kastet not-found eller `data: null`). Uten dette kan en vellykket sletting aldri verifiseres av en readback.
   */
  postcondition_target_absent?: boolean;
  /**
   * Del 3: `true` når `preflight_requires_target` er BEVISST false (f.eks. første deploy av en container - «finnes ikke ennå» er en gyldig
   * tilstand), slik at klasse D-pipelinen aksepterer en nullable før-tilstand uten å kreve eksisterende mål.
   */
  allows_missing_preflight_target?: boolean;
  /** Del 3: `outbound_message` = ingen forhåndseksisterende tilstand; mottaker valideres i transporten og leverandørens bekreftede ID er etterbetingelsen. */
  class_d_profile?: "outbound_message";
  /**
   * WP-F1 (D-462, JARVIS-013/043 for penger): MÅLVALIDERING MED SPESIFIKK ÅRSAK. `preflight_target_check` svarer bare ja/nei og gir alltid
   * `preflight_target_not_found` - for en pengehandling må eieren se HVORFOR den ble stoppet (feil tilstand, beløpsformat, valuta, konto, leverandør,
   * duplikat, nødbryter). Kjøres på den ferske tilstandslesingen FØR noe reserveres/utføres (klasse D). Returnerer `null` når målet er gyldig,
   * ellers en kort årsakskode som gatewayen avviser med som `preflight_invalid:<kode>`. Mangler tilstanden (`null`) avvises det som
   * `preflight_target_not_found`, og en kastet feil i validatoren er fail-closed (`preflight_invalid:validator_error`).
   */
  preflight_validator?: (data: JsonValue, parameters: Record<string, JsonValue>) => string | null;
  /**
   * WP-F1 (JARVIS-072): credential-kravet bestemmes PER KALL i stedet for statisk (`finance.submit_payment_intent` krevde alltid Fiken-token, også for
   * Stripe/Vipps-intensjoner). Kjøres ETTER policy-/parameter-/rate-limit-/frys-portene (aldri før autorisasjon) og returnerer credential-referansen som
   * gjelder for akkurat dette kallet; `null`/feil = fail-closed (`credential_ref_unresolved`). Den STATISKE `credential_ref` beholdes som eier-binding-markør
   * (en ikke-intern statisk ref krever fortsatt den autentiserte eieren) - den løste refen får samme eier-binding, aldri en svakere.
   */
  credential_ref_resolver?: (parameters: Record<string, JsonValue>, context: ToolInvocationContext) => Promise<string | null>;
  /**
   * WP-F1: kort, REDIGERT sammendrag (beløp/valuta/leverandørtype - aldri kontonummer/KID/kortdata) av hva handlingen gjelder, hentet fra den ferske
   * tilstandslesingen. Settes på det umiddelbare out-of-band-varselet (`ClassDNotification.summary`) slik at eieren ser HVA som ble gjort, ikke bare
   * at noe ble gjort. Kastet feil = intet sammendrag (varselet sendes uansett).
   */
  notification_summary?: (state: JsonValue | null, parameters: Record<string, JsonValue>) => string | null;
  /**
   * WP-F1 (D-462): handlingen flytter penger og kan KUN utføres med eierens step-up - en enhetssignert økt (`auth_strength: "signed"`) fra en eier-kanal
   * (web/desktop/api/mobile; se `ownerStepUpDenial`). Håndheves av gatewayen SELV, rett etter policy-/parameter-portene og FØR noe annet leses - slik at ingen ny rute, jobb
   * eller modellvei kan flytte penger uten step-up, uavhengig av om kalleren husket å sjekke. Avslag: `step_up_required:<årsak>`.
   * Review F4: håndheves UAVHENGIG av `classDPipeline.enforce` (en `ToolGateway` uten options lot tidligere en `active/api`-identitet sende en Stripe-intensjon). Host-akseptansescript
   * kjøres med en eksplisitt, merket eier-/enhetsidentitet (`device_id: "jarvis-host-acceptance"`, signert), ikke ved at kontrollen er av.
   */
  step_up_required?: boolean;
  /**
   * WP-F1 (review F8): CONNECTOR-id-ene (f.eks. `stripe`, `vipps`, `fiken`, `neonomics`) en frys skal gjelde for, utledet av den LØSTE credential-referansen. Frys-sjekken (`isFrozenDurable`)
   * gjaldt bare `tool_id` (namespacet `finance`/`finance_stripe`/`finance_vipps`), så en eier som frøs connectoren `stripe` stoppet ikke pengehandlingene. Sjekkes både ved start og
   * på nytt rett før leverandørkallet. Utelatt = kun `tool_id` (uendret oppførsel for alle andre verktøy).
   */
  connector_ids_for?: (credentialRef: string) => readonly string[];
  /**
   * WP-F1 (review F9): KUN den autentiserte eieren (ikke gjest, ikke delegat) i eierens tenant kan kalle handlingen via gatewayen - også for klasse A-lesinger. Uten dette kunne en gjest i
   * samme tenant lese f.eks. `finance.check_submit_*` og `finance.get_reconciliation_status` (klasse A, intern credential-ref = ingen eier-binding). Krever `credentialBinding` (uten den kjenner
   * ikke gatewayen eieren, og flagget har ingen effekt - som resten av eier-bindingen). Avslag: `owner_only`. Gatewayens egne preflight-/readback-lesinger går direkte via transporten og påvirkes ikke.
   */
  owner_only?: boolean;
  /**
   * WP-G4b K1 (Q-75 pkt 11, JARVIS-115 m, D-484): eksplisitt, BEGRUNNET samtykke til at handlingen kan BINDES til autonom ACT (`situation_autonomy_policies`) og utføres av situasjonsmotoren uten et menneske i løkka.
   * DEFAULT-DENY: utelatt = IKKE bindbar. Bindingen avvises ved bind-tid og nektes ved utførelse; de fysiske navnerommene (`home-assistant`, `car`) er stengt uansett hva som står her.
   * Se `autonomy-bindable.ts` for begrunnelsen, kravene og de manifestinvariantene som feller en feilmerket definisjon. Påvirker ikke hvordan handlingen utføres (risikoklasse, step-up, D-kjede) - kun OM den kan bindes.
   */
  autonomy_bindable?: AutonomyBindability;
  /**
   * WP-T1 K4 (JARVIS-102, Q-65 pkt 1): handlingens KRAV til idempotensnøkkel.
   *  - `required` = hvert kall MÅ bære en `idempotency_key` (sideeffekter som ikke er idempotente av natur: penger, utsendelse, skriv mot ekstern leverandør, sletting). Håndheves av gatewayen
   *    (`idempotency_key_required`) når `JARVIS_TOOL_REQUEST_DIGEST=enforce`; i `observe` kun en revisjonsrad.
   *  - `optional` = nøkkel brukes (ledger) når den oppgis, kreves ikke.
   *  - `none`     = ikke aktuelt (ren lesing, eller en handling som er idempotent av natur): erklært, aldri krevd.
   * UTELATT = som før WP-T1: kun styrt klasse D krever nøkkel (`class_d_idempotency_key_required`). Produksjonsregisteret får verdien satt fra den deterministiske listen i `idempotency-requirements.ts`;
   * en test feller en NY skrivehandling som ikke tar stilling.
   */
  idempotency?: IdempotencyMode;
  /**
   * WP-T1 K1: toppnivåfelt i `parameters` som IKKE skal inngå i `request_digest` (i tillegg til `idempotency_key`). Brukes for felt som bærer en hemmelighet (digesten er et usaltet avtrykk og skal ikke
   * kunne brukes til å gjette en lav-entropi-verdi) - f.eks. `owner_controls.set_connector_credential.value`. Konsekvens: en endring av akkurat dette feltet under samme nøkkel gir IKKE `idempotency_key_reuse_mismatch`.
   */
  digest_exclude_parameters?: readonly string[];
}

/** WP-T1 K4: se `ToolDefinition.idempotency`. */
export type IdempotencyMode = "required" | "optional" | "none";

/**
 * WP-F1: en transport som VET at leverandørutfallet er ukjent (tidsavbrudd/nettverk/5xx etter at et kall kan ha nådd leverandøren) kaster en feil som begynner med
 * dette prefikset. Gatewayen behandler den som et gateway-tidsavbrudd: raden blir `unverified` (aldri retry-bar med samme nøkkel, havner i `reconcile()`),
 * og eieren varsles om at utfallet er ukjent - en kastet leverandørfeil (`failed`) betyr derimot «ingen bivirkning, retry tillatt».
 */
export const OUTCOME_UNKNOWN_PREFIX = "outcome_unknown";

export function isOutcomeUnknownMessage(message: string): boolean {
  return message === "tool_timeout" || message.startsWith(OUTCOME_UNKNOWN_PREFIX);
}

/**
 * WP-K (uavhengig delta-review L-1): ÉN felles definisjon av hvilke `ToolResult.reason`-strenger som betyr at utfallet av leverandørkallet er UKJENT (kallet KAN ha blitt utført) - for forbrukere av resultatet
 * (infra-journalen i `modules/incidents`, feilforklaringen til modellen). Ledgeren lagrer ukjent utfall som `unverified`, men det første kallets SVAR bærer `tool_failed:tool_timeout` /
 * `tool_failed:outcome_unknown:...` (kun replay-svaret er `postcondition_unverified:tool_timeout_outcome_unknown`), og en retry mot en reservert rad gir `execution_in_flight_or_outcome_unknown`.
 * Forbrukere som la disse i «feilet»-bøtta (FAILED / retry «later») fortalte ledgeren og journalen to forskjellige historier om samme kall. Endrer ingen `postcondition_reason`-streng (11 testfiler og
 * produksjonskode er festet til dem); dette er kun en klassifisering av strengene som finnes.
 */
export function isUnknownOutcomeReason(reason: string): boolean {
  return reason === "execution_in_flight_or_outcome_unknown"
    || reason === "tool_failed:tool_timeout"
    || reason.startsWith(`tool_failed:${OUTCOME_UNKNOWN_PREFIX}`)
    || reason.startsWith("postcondition_unverified:tool_timeout")
    || reason.startsWith("postcondition_unverified:ledger_finalize_failed");
}

/**
 * WP-K (review M1): klasse C/D-mutasjoner som IKKE er idempotente hos leverandøren (`idempotent_external: false`). En uavklart transportfeil (`TimeoutError`/`AbortError`, nullstilt socket etter sending, `fetch failed`)
 * betyr at leverandøren KAN ha utført mutasjonen - da er utfallet ukjent (`unverified`), aldri `failed`, ellers re-armer et samme-nøkkel-replay raden og sender POST-en en gang til. Klasse A (lesing) har ingen ledger,
 * idempotente mutasjoner tåler en retry, og klasse B (intern/reversibel bokføring og varsler) er bevisst utenfor (se runbook).
 */
function mayDuplicateOnRetry(definition: Pick<ToolDefinition, "capability_class" | "idempotent_external">): boolean {
  return (definition.capability_class === "C" || definition.capability_class === "D") && definition.idempotent_external === false;
}

/** Årsakskoder fra en validator havner i avslagsårsaken og audit - kun et trygt tegnsett og en kort lengde. */
function sanitizeReasonCode(reason: string): string {
  return reason.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80);
}

/**
 * Del 3: `allowed_tools`-oppføring = `tool_id` (alle handlinger i verktøyet) ELLER `tool_id.action` (kun den handlingen).
 * Tom liste tillater ingenting.
 */
export function jobContractAllows(allowed: readonly string[], toolId: string, action: string): boolean {
  return allowed.includes(toolId) || allowed.includes(`${toolId}.${action}`);
}

export type ToolResult =
  | { ok: true; external_id?: string; data?: JsonValue; output_trust: TrustLevel; deduplicated: boolean; notified?: boolean }
  | { ok: false; reason: string };

/**
 * Tool Gateway: eneste vei til eksterne systemer.
 * Pipeline: IdentityContext → (jobbmandat) → Policy Gateway → rate limit →
 * idempotensdedupe → adapter → audit (credential-ref + ekstern ID, aldri selve
 * secreten) → output klassifisert som untrusted der kilden er ekstern.
 */
/**
 * Del 3 (JARVIS-003/005/035): `credentialBinding` binder eier-tilkoblede leverandør-credentials til den autentiserte eieren i eierens
 * tenant(s). `internalRefs` (interne, tenant-skopede referanser uten leverandør-secret) er unntatt. Uten binding oppfører gatewayen seg som før.
 */
export interface CredentialBinding {
  owner_person_id: string;
  owner_tenants: readonly string[];
  internalRefs: ReadonlySet<string>;
}

/**
 * WP-N1 (Q-64 pkt 3, K6): UTFØRELSESLÅS for finansverktøyene (`finance`, `finance_*`, se `isFinancialNamespace`). Finansdata er SECRET_RESTRICTED (D-378: kun lokal modell). De eksisterende finansverktøyene hadde bare en
 * UTVALGSLÅS (en tur som VELGER dem blir låst lokalt), men `MeshToolExecutor` sjekker bare flate-tildelingen: en skymodell som likevel kaller et ikke-valgt `finance_*`-verktøy (hallusinert eller injisert kall) omgikk den.
 * Når dette valget er satt, nektes kall der `servingModel` (stemplet av adapteren, aldri fra parametere) er en SKYMODELL ELLER en ukjent modell - FØR policy og transport (ingenting hentes, ingenting utføres), med en vanlig
 * `tool.denied`-revisjonsrad (årsakskode, aldri innhold). Uten `servingModel` (eierens egne HTTP-ruter, `/control`, eier-godkjente bekreftelser: ingen modell i løkka) er oppførselen uendret, og en LOKAL modell får
 * hele resultatet (D-378 pkt 2). Uten valget (flagg AV) er gatewayen identisk med main.
 */
export interface FinanceExecutionLock {
  /**
   * Er modellen som betjener kallet LOKAL? I drift: leverandørregisterets `locality` (`!servedByCloudModel`, apps/api). FAIL-CLOSED: utelatt, et kast, en ikke-`true` verdi eller en `servingModel` uten gyldig leverandørnavn
   * regnes som SKY.
   */
  servedLocally?: (model: { provider: string; model: string }) => boolean;
}

/** WP-N1: årsakskoden for en finansnektelse (revisjonsraden og modellens forklaring, `tool-failure.ts`). Ingen tall, id-er eller leverandørnavn. */
export const FINANCE_WITHHELD_REASON = "finance_withheld_from_cloud_model";

export interface ToolGatewayOptions {
  classDPipeline?: ClassDPipelineOptions;
  credentialBinding?: CredentialBinding;
  /** WP-N1 (K6): utførelseslås for finansverktøyene mot skymodeller. Utelatt = av (identisk med main). */
  financeExecutionLock?: FinanceExecutionLock;
  /** WP-T1 (K3/K4): modus for forespørselsavtrykk og nøkkelkrav. Utelatt = leses fra `JARVIS_TOOL_REQUEST_DIGEST` ved hvert kall (standard `off` = identisk med main). Tester kan sette den eksplisitt. */
  requestDigestMode?: RequestDigestMode;
}

/**
 * Forespørselen til `ToolGateway.execute()`. Trukket ut av metodesignaturen (WP-N1b) uten endring av felt eller semantikk, så den tynne `execute()` (som setter den modell-stemplede konteksten) og `executeCall` (den uendrede
 * kroppen) deler ÉN type.
 */
export interface ToolExecuteRequest {
  identity: IdentityContext;
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  idempotency_key?: string;
  approval?: unknown;
  /** Delegert jobb: verktøyet MÅ stå i kontraktens allowed_tools. */
  jobContract?: JobContract;
  /** D-317: se `ToolInvocationContext.servingModel` sitt filhode. WP-N1b: med begrenset-vakten på arves den av nøstede kall (`model-scope.ts`). */
  servingModel?: { provider: string; model: string };
  /** D-449: se `ToolInvocationContext.contentOrigin` sitt filhode (kun trusted kode setter den). */
  contentOrigin?: "owner_direct";
  /** WP-N1 (F-A2): se `ToolInvocationContext.restrictedOrigin` (kun trusted kode setter den). */
  restrictedOrigin?: true;
  /** D-394 (JARVIS-054): korrelasjons-ID-er som følger HVER audit-rad for dette kallet. */
  task_id?: string;
  trace_id?: string;
  /**
   * WP-G2 (fiks-runde A-L7): kalles etter at klasse D-varslingen er FORSØKT, med `notified` og en kort, sanert feilkode. Resultatformen er uendret (også for MISMATCH/UKJENT, der varslingsstatus ellers ikke fantes
   * på resultatet), så eksisterende kallere og tester påvirkes ikke. Kun trusted kode setter den; en feil i observatøren bryter aldri kjeden.
   */
  onClassDNotification?: (status: { notified: boolean; error: string | null }) => void;
}

/** Parameterfelt som er identitet/scope - utledes av den autentiserte identiteten, aldri av en modell- eller klientverdi. */
const IDENTITY_PARAMETER_FIELDS = ["tenant_id", "person_id", "actor_person_id", "owner_person_id"] as const;

export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  /** BO-03: connector-health per tool_id (healthy/degraded/auth_failed/rate_limited/unavailable). */
  readonly health = new Map<string, { state: string; at: string; detail?: string }>();
  private setHealth(toolId: string, state: string, detail?: string): void {
    this.health.set(toolId, { state, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  }
  private readonly callTimes = new Map<string, number[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: PolicyGateway,
    private readonly secrets: SecretProvider,
    private readonly controls?: OwnerControls,
    /**
     * Task #122 (D-213): SEPARAT fra `secrets` over med hensikt - `secrets`
     * er en LESE-fallback-kjede (Infisical → .env → BusinessInternal, D-211)
     * der EN provider som svarer er nok. Skriving har INGEN slik fallback-
     * semantikk: å skrive til `.env` fra kjørende kode ville enten vært en
     * fil-skriving inn i en git-ignorert fil (aldri gjort av
     * `EnvSecretProvider`, som er ren lesing) eller stille skrevet til feil
     * sted. `writableSecrets` er derfor typisk DEN SAMME `InfisicalSecretProvider`-
     * INSTANSEN som allerede sitter FØRST i `secrets`-kjeden (se main.ts/
     * worker-main.ts), gitt en gang til her, eksplisitt for skriving - ALDRI
     * en egen, parallell Infisical-tilkobling.
     */
    private readonly writableSecrets?: WritableSecretProvider,
    /** Del 3: valgfrie harde porter. Av som standard for testhjelpere; produksjon slår dem på (main.ts/worker-main.ts). */
    private readonly options?: ToolGatewayOptions
  ) {
    this.classDPipeline = options?.classDPipeline;
    this.classDNotifier = options?.classDPipeline?.notifier;
  }

  private readonly classDPipeline: ClassDPipelineOptions | undefined;

  private classDNotifier: ClassDNotifier | undefined;

  /** Del 3: sen binding (varsleren trenger selve gatewayen for Telegram-transporten). */
  setClassDNotifier(notifier: ClassDNotifier): void {
    this.classDNotifier = notifier;
  }

  /**
   * WP-H0: LESING for kontrollsenteret - hvilke harde porter som er slått på i DENNE prosessen (kun sannhetsverdier, ingen konfigurasjonsinnhold, ingen hemmeligheter).
   * Å vise at klasse D-pipelinen og credential-bindingen faktisk er på er en måling, ikke en antakelse om oppstartskoden.
   */
  policyFlags(): { class_d_pipeline_enforced: boolean; credential_binding_active: boolean } {
    return {
      class_d_pipeline_enforced: this.options?.classDPipeline?.enforce === true,
      credential_binding_active: this.options?.credentialBinding !== undefined
    };
  }

  /**
   * Task #119 (integrasjons-dashboard, D-211): presence-sjekk for eierens
   * "er X konfigurert"-visning - kaller SAMME `SecretProvider` gatewayen
   * allerede injiseres med (aldri en egen, parallell secret-lesevei), men
   * returnerer KUN en boolean. Selve verdien forlater ALDRI denne metoden -
   * samme "verdien går aldri i logg/trace/modellkontekst"-disiplin som
   * `SecretProvider.get()` sin egen kontrakt (se filhode over).
   */
  async hasSecret(ref: string): Promise<boolean> {
    // WP-C3 review F3: leverandører med en `get` som utsteder noe (GitHub App-installasjonstoken) tilbyr `has`, slik at en statuspoll aldri utsteder en credential.
    if (typeof this.secrets.has === "function") {
      try {
        return await this.secrets.has(ref);
      } catch {
        return false; // kontrakten: kaster aldri - en leverandør som likevel gjør det er «ikke tilgjengelig», ikke en feil som velter statusen
      }
    }
    return (await this.secrets.get(ref)) !== null;
  }

  /**
   * Gjennomgang av PR #316 (M-1): TRI-STATE presence for kontrollsentre. `true` = secreten finnes, `false` = kilden SVARTE og har den ikke (en måling), `null` = kilden kunne ikke spørres (ukjent - aldri «mangler»).
   * Kaster aldri. `hasSecret()` er uendret (to-state, brukt av dashbord og sveip): den kunne ikke skille «Infisical nede» fra «ikke konfigurert», og kontrollsentrene må kunne det. Verdien forlater aldri metoden.
   */
  async secretPresence(ref: string): Promise<boolean | null> {
    try {
      const presence = await secretPresenceOf(this.secrets, ref);
      return presence === "present" ? true : presence === "absent" ? false : null;
    } catch {
      return null;
    }
  }

  /** Gjennomgang av PR #316 (M-1): helsen til credential-kilden etter siste oppslag (for visning: «Infisical er utilgjengelig»). Kilder som ikke kan feile er `healthy`. */
  secretsHealth(): SecretSourceHealth {
    return this.secrets.health ?? "healthy";
  }

  /**
   * Task #122 (D-213): eierens "lim inn nøkkel"-skrivevei - ALDRI kallbar
   * uten en konfigurert `writableSecrets`-provider (fail-closed med en
   * TYDELIG feil, ALDRI en stille no-op eller et skriveforsøk mot en
   * les-only-kjede). Selve verdien går ALDRI i logg/trace/modellkontekst -
   * samme disiplin som `SecretProvider.get()`/`hasSecret()` sin kontrakt.
   * Kalles UTELUKKENDE gjennom `ToolGateway.execute()` sin vanlige
   * pipeline (Policy Gateway → audit) via `connector_credentials.set_credential`
   * (se `modules/owner-controls`) - ALDRI en direkte, policy-omgått vei.
   */
  async setSecret(ref: string, value: string): Promise<void> {
    if (!this.writableSecrets) {
      throw new Error("secret_provider_not_writable");
    }
    await this.writableSecrets.set(ref, value);
  }

  register(definition: ToolDefinition): void {
    this.tools.set(`${definition.tool_id}:${definition.action}`, definition);
  }

  get(toolId: string, action: string): ToolDefinition | undefined {
    return this.tools.get(`${toolId}:${action}`);
  }

  /**
   * D-289 (Tobias direkte i chat: "vil ha alt at han har full kontroll" -
   * svar på D-288 sitt funn om at samtaleflaten kun kunne kalle 5 av ~28
   * registrerte tool_id-er): eneste kilde `allMeshTools()` (`mesh-bridge.ts`)
   * trenger for å bygge EN mesh-mapping per FAKTISK registrert
   * `tool_id:action`-par - ALDRI en egen, potensielt avvikende opptelling.
   * Returnerer definisjonene selv (inkl. `transport`/`credential_ref`) -
   * disse forlater ALDRI denne prosessen mot modellen (kun `mesh-bridge.ts`
   * sin konverterte `name`/`description`/JSON-schema gjør det); kalleren har
   * samme tillitsnivå som `register()`/`execute()` selv.
   */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * WP-N1b (JARVIS-116 b, K1): inngangen til ALLE verktøykall. Tynn omslag rundt `executeCall` (den uendrede kroppen) som setter den MODELL-STEMPLEDE KONTEKSTEN (`model-scope.ts`) ÉN gang når et modellstyrt kall starter,
   * slik at NØSTEDE `execute()`-kall (en transport som selv kaller gatewayen) arver modellen og utførelseslåsen for `finance*` ser den sentralt - uten at hver tjeneste må holde tilbake selv.
   *  - VAKT AV (`financeExecutionLock` utelatt = begrenset-vakten er AV): går rett til `executeCall` med uendret forespørsel - ingen skop, ingen arvet modell, identisk med main.
   *  - INGEN MODELL (eierens HTTP-ruter, `/control`, eier-godkjent bekreftelse; hverken eksplisitt eller arvet): ingen skop - eieren får alt som før.
   *  - ET SKYSKOP KAN ALDRI LØSNES: er det ytre kallet betjent av sky/ukjent, gjelder DEN modellen for alle nøstede kall, selv om et nøstet kall oppgir en lokal. Et lokalt skop kan strammes inn (nøstet kall oppgir sky).
   *  - Lokalitetsvedtaket (`cloud`) tas HER, ÉN gang, med den ene regelen (`servedByCloud` -> `FinanceExecutionLock.servedLocally`, i drift `financeLockServedLocally`; fail-closed) og ligger i skopet for alle lesere.
   */
  execute(request: ToolExecuteRequest): Promise<ToolResult> {
    // Hele omslaget står i `try`: en feil (også en løsrevet `execute` uten `this`) er en AVVISNING som før N1b (`execute` var `async`), aldri et synkront kast. Vakt AV returnerer fortsatt kroppens eget løfte uendret (ingen `await`, ingen ekstra tick).
    try {
      const lock = this.options?.financeExecutionLock;
      if (lock === undefined) return this.executeCall(request);
      const ambient = currentModelScope();
      // `!== undefined` (ikke `??`): en `null`/uleselig verdi er IKKE «ingen modell» - den regnes som sky av `servedByCloud` (fail-lukket), akkurat som finanslåsen i `executeCall` alltid har gjort. Kun fraværet av en modell gir arv/full tilgang.
      const model = ambient?.cloud === true ? ambient.servingModel : (request.servingModel !== undefined ? request.servingModel : ambient?.servingModel);
      if (model === undefined) return this.executeCall(request);
      const cloud = ambient?.cloud === true || this.servedByCloud(model, lock);
      const effective: ToolExecuteRequest = model === request.servingModel ? request : { ...request, servingModel: model };
      return runWithModelScope({ servingModel: model, cloud }, () => this.executeCall(effective));
    } catch (err) {
      return Promise.reject(err); // som før: en feil i kallet er en avvisning, aldri et synkront kast
    }
  }

  private async executeCall(request: ToolExecuteRequest): Promise<ToolResult> {
    const definition = this.get(request.tool_id, request.action);
    const corr = { ...(request.task_id !== undefined ? { task_id: request.task_id } : {}), ...(request.trace_id !== undefined ? { trace_id: request.trace_id } : {}) };
    // WP-K (D-471, JARVIS-054): ID-en til Policy Gateway-avgjørelsen som førte til dette kallet står i HVER revisjonsrad herfra (`payload.policy_decision_id`), og avslag
    // etter policy (rate limit, frys, credential, preflight ...) bærer den samme ID-en - «policy sa ALLOW, men porten X stoppet det» kan rekonstrueres. Før policy finnes ingen avgjørelse (ingen ID).
    let policyDecisionId: string | undefined;
    const auditPayload = (payload: Record<string, unknown> = {}): Record<string, unknown> =>
      policyDecisionId === undefined ? payload : { ...payload, policy_decision_id: policyDecisionId };
    const deny = (reason: string): Promise<ToolResult> =>
      this.deny(request, reason, { ...corr, ...(policyDecisionId !== undefined ? { policy_decision_id: policyDecisionId } : {}) });
    // WP-K (D-471, JARVIS-018): et NØSTET kall (en transport som selv kaller `execute()`, f.eks. `support.reply` -> `email.send`) startes aldri på vegne av et ytre kall som allerede er avbrutt/tidsavbrutt -
    // ellers kunne en forlatt transport utføre en mutasjon ETTER at det ytre kallet er meldt «utfall ukjent».
    // UNNTAK (review H1): sikkerhetsbryterne (kill switch, `CLASS_D_EXEMPT_ACTIONS`) og selvgjenopprettings-handlingene (`isSelfRecoveryAction`) MÅ virke også fra en avbrutt kontekst - de er
    // nettopp det eieren trenger når noe har gått galt, og de kan aldri være «en forlatt mutasjon». Klasse D-varslingen (`notifyClassD`/`ready()`) kjører i tillegg frakoblet fra kallsignalet.
    const exemptFromAbortGuard = definition !== undefined && (isClassDExempt(definition) || isSelfRecoveryAction(request.tool_id, request.action));
    if (!exemptFromAbortGuard && toolCallAbortEnabled() && currentCallSignal()?.aborted === true) {
      return deny("caller_call_aborted");
    }
    if (!definition) {
      return deny("unknown_tool");
    }
    if (request.jobContract && !jobContractAllows(request.jobContract.allowed_tools, request.tool_id, request.action)) {
      return deny("tool_not_in_job_contract");
    }
    // Del 3 (JARVIS-005/012): en jobb kan aldri handle som en annen person/tenant enn den signerte kontrakten sier.
    if (
      request.jobContract &&
      (request.jobContract.owner_person_id !== request.identity.person_id || request.jobContract.tenant_id !== request.identity.tenant_id)
    ) {
      return deny("job_identity_mismatch");
    }
    // WP-N1 (Q-64 pkt 3, K6): utførelseslås for finansverktøyene - TIDLIG (før parametervalidering, policy og transport): en nektet skytur verken bruker en policy-avgjørelse, henter noe eller får tilbakemelding om
    // parametre, og låsen er uavhengig av hva kallet inneholder. Revisjonsraden bærer kun årsakskoden.
    if (this.options?.financeExecutionLock !== undefined && isFinancialNamespace(request.tool_id) && this.servedByCloud(request.servingModel, this.options.financeExecutionLock)) {
      return deny(FINANCE_WITHHELD_REASON);
    }
    const input = definition.input_schema.safeParse(request.parameters);
    if (!input.success) {
      return deny("invalid_parameters");
    }
    // Del 3 (JARVIS-005/035): identitets-/scope-felt i parametrene må samsvare med den autentiserte identiteten (gatewayen avviser avvik).
    const binding = this.options?.credentialBinding;
    const isOwner = binding
      ? request.identity.person_id === binding.owner_person_id && binding.owner_tenants.includes(request.identity.tenant_id) && request.identity.delegation_id === undefined
      : false;
    for (const field of IDENTITY_PARAMETER_FIELDS) {
      const supplied = request.parameters[field];
      if (supplied === undefined || supplied === null) continue;
      const expected = field === "tenant_id" ? request.identity.tenant_id : request.identity.person_id;
      // `owner_person_id` er «eier/ansvarlig» i CRM/styring: bare den suverene eieren kan tildele en annen person.
      if (supplied !== expected && !(field === "owner_person_id" && isOwner)) {
        return deny(`scope_mismatch:${field}`);
      }
    }
    if (request.jobContract) {
      const space = request.parameters["memory_space"] ?? request.parameters["memory_space_id"];
      if (typeof space === "string" && !request.jobContract.allowed_memory_spaces.includes(space)) {
        return deny("job_memory_space_not_allowed");
      }
    }
    // Eier-tilkoblede leverandør-credentials kan bare brukes av den autentiserte eieren i eierens tenant (aldri en annen person/tenant/delegat).
    if (binding && definition.credential_ref !== "" && !binding.internalRefs.has(definition.credential_ref) && !isOwner) {
      return deny("credential_not_bound_to_identity");
    }
    // WP-F1 (review F9): eier-eksklusive handlinger (finans-lesinger) også for klasse A.
    if (definition.owner_only === true && binding && !isOwner) {
      return deny("owner_only");
    }
    const decision = await this.policy.authorize({
      identity: request.identity,
      toolCall: {
        tool_id: request.tool_id,
        action: request.action,
        capability_class: definition.capability_class,
        parameters: request.parameters
      },
      ...(request.approval !== undefined ? { approval: request.approval } : {}),
      // JARVIS-051: noncen forbrukes FØRST rett før handlingen, etter alle ortogonale porter.
      deferNonceConsumption: true,
      // WP-K (JARVIS-054): oppgave-/spor-ID-en følger avgjørelsen, så den kan slås opp sammen med revisjonsraden.
      ...(Object.keys(corr).length > 0 ? { correlation: corr } : {})
    });
    policyDecisionId = decision.decision_id;
    if (decision.decision !== "ALLOW") {
      return deny(decision.reason);
    }
    if (definition.parameterAuthorizer) {
      const paramDecision = definition.parameterAuthorizer(request.parameters, request.identity);
      if (!paramDecision.allowed) {
        return deny(paramDecision.reason);
      }
    }
    // Del 3 (JARVIS-013/043): klasse D-pipelinen er en HARD port i produksjon (påslått i api og worker).
    const classDGoverned = this.classDPipeline?.enforce === true && definition.capability_class === "D" && !isClassDExempt(definition);
    // WP-F1: pengehandlinger krever eierens step-up (signert enhet + eier-kanal) - håndhevet her, ikke bare i rutene.
    // Review F4: UAVHENGIG av `classDPipeline.enforce` - en gateway uten options (testhjelper, host-skript) skal ikke la en svakere økt flytte penger.
    if (definition.step_up_required === true) {
      const stepUp = ownerStepUpDenial(request.identity);
      if (stepUp !== undefined) return deny(stepUp);
    }
    if (!this.withinRateLimit(definition, request.identity.tenant_id)) {
      return deny("rate_limited");
    }
    // K1 (Sovereign graduation, D-164): LIVE, delt sjekk (aldri den rene
    // synkrone `isFrozen()`/`isRevoked()`) - se `OwnerControls` sitt
    // filhode. `owner_controls` selv kan aldri fryse seg selv ute (samme
    // selvgjenopprettings-unntak som `PolicyGateway.authorize()` - se der).
    if (request.tool_id !== "owner_controls" && (await this.controls?.isFrozenDurable(request.tool_id))) {
      return deny("connector_frozen");
    }
    // D-166 (arkitekt-review PR #93, funn B1): `owner_controls.*` deler
    // SAMME `credential_ref` (`BUSINESS_INTERNAL_CREDENTIAL_REF`) som
    // `situations`/`executive`. Uten et unntak ville et eier-kall til
    // `owner_controls.revoke_credential` med DEN delte interne refen (feil,
    // forveksling, eller kompromittert eier-identitet) blokkert `owner_
    // controls.restore_credential` selv med `credential_revoked` - et
    // ENVEIS-LÅS. Unntaket er BEGRENSET til `OWNER_CONTROLS_SELF_RECOVERY_
    // ACTIONS` (SAMME navngitte mengde som `PolicyGateway.authorize()` sin
    // kill-switch-sjekk over bruker - se `owner-control-store.ts` for full
    // begrunnelse, inkl. hvorfor `restore_credential` MÅ stå i begge
    // sjekkene for at en SAMTIDIG kill-switch+tilbakekalt-credential-
    // tilstand skal ha en deterministisk, kanonisk gjenopprettingsvei) -
    // IKKE et blanket-unntak for HELE `owner_controls`-verktøyet slik
    // frys-sjekken over har (den dekker en annen, smalere selv-mål-risiko).
    // `activate_kill_switch`/`freeze_connector`/`unfreeze_connector`/
    // `revoke_credential` er ALDRI unntatt herfra.
    //
    // D-174 (B2, unified owner-control-surface mutation completion):
    // `executive.*` proxyer NÅ de samme selvgjenopprettings-handlingene
    // videre til `owner_controls.*` via en NESTET `ToolGateway.execute()`-
    // kall (executive → owner_controls). Den nestede INDRE kallet er
    // allerede trygt (tool_id="owner_controls" der). Men den YTRE
    // executive.*-kallet vurderes MED SIN EGEN tool_id ("executive") FØR
    // det når det nestede kallet - uten dette tillegget ville den ytre
    // sjekken blokkert executive.deactivate_kill_switch/restore_credential
    // FØR de i det hele tatt kunne nå den trygge, nestede owner_controls-
    // stien, og dermed brutt B1-gjenoppretting via executive.
    // D-176 (RETTET, arkitekt-review 5251073737, BLOKKER B5): den
    // OPPRINNELIGE D-174-antakelsen her - at "executive-handlingsnavnene er
    // IDENTISKE med owner_controls sine" - var FEIL for LESING:
    // `executive.get_control_surface_status` het BEVISST IKKE
    // `get_control_state`, så den ble AVSLÅTT av akkurat denne
    // tilbakekalt-credential-sjekken (og den analoge kill-switch-sjekken i
    // `PolicyGateway.authorize()`) mens den delte refen var tilbakekalt -
    // et REELT brudd på B2 sitt "ETT panel for lesing OG gjenoppretting".
    // `isSelfRecoveryAction()` erstatter nå BEGGE de to tidligere
    // `tool_id === "..."`-unionene med en eksplisitt per-(tool_id,action)-
    // mapping (se owner-control-store.ts) - `executive.get_control_surface_
    // status` OG dens NØSTEDE `situations.get_pause_state`/`finance.
    // get_kill_switch`-kall er NÅ med (uten dette ville selve komposisjonen
    // FORTSATT feilet under lås, selv etter at den ytre executive-sjekken
    // alene var rettet - se D-176), `owner_controls.get_control_state`
    // direkte forblir uendret den kanoniske, alltid-tilgjengelige veien.
    // Unntaket er FORTSATT like smalt - kun disse navngitte handlingene per
    // tool_id, ALDRI en bredere "alle lesinger"-regel for noen av de fire.
    const isCredentialRevocationSelfRecovery = isSelfRecoveryAction(request.tool_id, request.action);
    // SECURITY FIX #2 (D-68): DEN OPPRINNELIGE kalleren sin identitet/godkjenning -
    // gitt uendret videre til transporten for ethvert nøstet gateway-kall den evt.
    // selv gjør. ALDRI fabrikkert/eskalert her - kun videreformidlet.
    const invocationContext: ToolInvocationContext = {
      identity: request.identity,
      ...(request.approval !== undefined ? { approval: request.approval } : {}),
      ...(request.servingModel !== undefined ? { servingModel: request.servingModel } : {}),
      ...(request.contentOrigin !== undefined ? { contentOrigin: request.contentOrigin } : {}),
      ...(request.restrictedOrigin === true ? { restrictedOrigin: true as const } : {}),
      ...(request.idempotency_key !== undefined ? { idempotency_key: request.idempotency_key } : {}),
      // WP-K (JARVIS-054): nøstede kall fra transporten (system-synk via `business.sync_business_events`) bærer samme korrelasjon videre.
      ...corr
    };
    // WP-F1 (JARVIS-072): credential-kravet kan bestemmes per kall (f.eks. intensjonens provider). Skjer ETTER alle autorisasjonsportene over, og er
    // fail-closed: en resolver som feiler eller ikke kan avgjøre refen gir avslag - aldri en stille fallback til en annen leverandørs credential.
    let credentialRef = definition.credential_ref;
    if (definition.credential_ref_resolver) {
      let resolved: string | null = null;
      try {
        resolved = await definition.credential_ref_resolver(request.parameters, invocationContext);
      } catch {
        resolved = null;
      }
      if (typeof resolved !== "string" || resolved === "") {
        return deny("credential_ref_unresolved");
      }
      credentialRef = resolved;
      // Samme eier-binding for den løste refen som for den statiske (aldri svakere).
      if (binding && !binding.internalRefs.has(credentialRef) && !isOwner) {
        return deny("credential_not_bound_to_identity");
      }
    }
    // WP-F1 (review F8): frys gjelder også CONNECTOR-id-en (stripe/vipps/fiken/neonomics) utledet av den løste credential-referansen, ikke bare tool-namespacet.
    if (this.controls && request.tool_id !== "owner_controls") {
      for (const connectorId of definition.connector_ids_for?.(credentialRef) ?? []) {
        if (await this.controls.isFrozenDurable(connectorId)) return deny("connector_frozen");
      }
    }
    if (!isCredentialRevocationSelfRecovery && (await this.controls?.isRevokedDurable(credentialRef))) {
      return deny("credential_revoked");
    }
    const credential = await this.secrets.get(credentialRef);
    if (!credential) {
      return deny("credential_unavailable");
    }

    // Del 3 (JARVIS-013/043): klasse D-pipelinen er en HARD port - uten hele kjeden er handlingen utilgjengelig (fail-closed).
    if (classDGoverned) {
      const assessment = assessClassDPipeline(definition);
      if (!assessment.complete) {
        return deny(`class_d_pipeline_incomplete:${assessment.missing.join(",")}`);
      }
      if (!request.idempotency_key) {
        return deny("class_d_idempotency_key_required");
      }
      let notifierReady = false;
      try {
        // Review H1: frakoblet fra det ytre kallets signal (varslerens egen nøstede `telegram.notify` skal aldri nektes fordi et YTRE kall har fått tidsavbrudd).
        notifierReady = this.classDNotifier ? await detachFromCallSignal(() => this.classDNotifier!.ready()) : false;
      } catch {
        notifierReady = false;
      }
      if (!notifierReady) {
        return deny(this.classDNotifier ? "class_d_notifier_not_ready" : "class_d_notifier_missing");
      }
    }

    // Q-18 (D-30 host-akseptanse): tool_executions-dedupe finnes for å hindre
    // dobbel SIDE-EFFEKT på C/D-mutasjoner (§21/§19 i BO-11) - A-klasse READs
    // har ingen side-effekt å beskytte mot duplisering, og data kan ha endret
    // seg mellom to spørringer (f.eks. to "hva står på kalenderen"-spørsmål i
    // samme langtlevende voice-session). Dedupe på database-/session-nivå
    // gjelder derfor KUN C/D. Beskyttelse mot at MODELLEN utfører samme
    // semantiske kall flere ganger i ÉN modellrunde/samtaletur er uendret og
    // håndheves separat (in-memory `executed`-cache i
    // ModelGateway.completeWithTools, modules/model-gateway/src/model-gateway.ts).
    const dedupeApplies = definition.capability_class !== "A";
    const tenantId = request.identity.tenant_id;
    const ledgerKey = dedupeApplies && request.idempotency_key ? request.idempotency_key : undefined;

    // WP-T1 (JARVIS-102, K3/K4): modus `off` (standard) = ingenting under kjøres - identisk med main (ingen digest, ingen ny kolonne, ingen ekstra spørring).
    // `observe`/`enforce`: (K4) en handling merket `idempotency: "required"` uten nøkkel, og (K3) forespørselens digest for ledger-raden. Begge FØR preflight og FØR approval-noncen forbrukes.
    const digestMode: RequestDigestMode = this.options?.requestDigestMode ?? requestDigestMode();
    let requestDigestValue: string | undefined;
    if (digestMode !== "off") {
      // Nødbrytere og selvgjenopprettings-handlinger (`exemptFromAbortGuard`) MÅ virke uten nøkkel, uansett hva en definisjon sier.
      if (dedupeApplies && definition.idempotency === "required" && !exemptFromAbortGuard && !request.idempotency_key) {
        if (digestMode === "enforce") return deny(IDEMPOTENCY_KEY_REQUIRED);
        await this.auditObservation(request, definition, "tool.idempotency_key_missing_observed", IDEMPOTENCY_KEY_REQUIRED, {}, corr, policyDecisionId);
      }
      if (ledgerKey !== undefined) {
        const outcome = digestForRequest({
          tool_id: request.tool_id, action: request.action, parameters: request.parameters, tenant_id: tenantId, person_id: request.identity.person_id,
          exclude_parameters: definition.digest_exclude_parameters
        });
        if (outcome.ok) requestDigestValue = outcome.digest;
        else if (digestMode === "enforce") return deny(`${REQUEST_DIGEST_INVALID_PREFIX}:${outcome.code}`);
        else await this.auditObservation(request, definition, "tool.request_digest_invalid_observed", `${REQUEST_DIGEST_INVALID_PREFIX}:${outcome.code}`, {}, corr, policyDecisionId);
      }
    }

    // v4.0 D-pipeline: for høyrisiko (C/D) med definert preflight leses
    // nå-tilstanden FØR handlingen (deterministisk preflight + recovery-
    // grunnlag) og PÅ NYTT etterpå (readback/before-after-evidens).
    // Preflight-feil på klasse D er fail-closed.
    let beforeState: JsonValue | null = null;
    // WP-F1 (review F6): true når validatoren ble hoppet over fordi replay-peeken så en eksisterende ledger-rad. Blir den raden `failed` hos et samtidig kall og re-armes av oss,
    // MÅ validatoren kjøres på fersk tilstand før noe utføres (se re-arm under).
    let validatorSkipped = false;
    const needsEvidence = (definition.capability_class === "C" || definition.capability_class === "D") && definition.preflight_action;
    if (needsEvidence) {
      try {
        const pre = await invokePreflight(definition, request.parameters, credential, invocationContext);
        beforeState = pre.data ?? null;
        // Q-34: preflight-KALLET lyktes (kastet ikke), men for et revidert
        // klasse D-verktøy betyr et null/undefined resultat FAKTISK "mål
        // finnes ikke" - se `preflight_requires_target` sin doc-kommentar.
        // Denne mutasjonen har ikke skjedd ennå og transaksjonen er ikke
        // startet, så avslaget her har PRESIS samme "ingenting å rulle
        // tilbake"-egenskap som en kastet preflight-feil under.
        if (definition.capability_class === "D" && definition.preflight_requires_target && beforeState === null) {
          return deny("preflight_target_not_found");
        }
        // Q-34 P1-oppfølging: den FINERE sjekken - ressursen finnes (over),
        // men det PÅSTÅTTE mål-ID-et inni den må også faktisk finnes.
        if (
          definition.capability_class === "D" &&
          beforeState !== null &&
          definition.preflight_target_check &&
          !definition.preflight_target_check(beforeState, request.parameters)
        ) {
          return deny("preflight_target_not_found");
        }
        // WP-F1: validering med SPESIFIKK årsak (beløp/valuta/konto/leverandør/tilstand/duplikat/nødbryter). En replay av en nøkkel som allerede har et
        // endelig utfall i ledgeren (gjennomført/uverifisert/under utførelse) valideres IKKE på nytt: tilstanden har da flyttet seg ved handlingen selv, og
        // ledger-porten under svarer med det lagrede utfallet (aldri en ny mutasjon) i stedet for et misvisende «ikke lenger gyldig».
        if (definition.capability_class === "D" && definition.preflight_validator) {
          if (beforeState === null) return deny("preflight_target_not_found");
          const replayStatus = ledgerKey !== undefined ? await this.peekLedgerStatus(tenantId, ledgerKey) : null;
          if (replayStatus === null || replayStatus === "failed") {
            let invalid: string | null;
            try {
              invalid = definition.preflight_validator(beforeState, request.parameters);
            } catch {
              invalid = "validator_error";
            }
            if (invalid !== null) return deny(`preflight_invalid:${sanitizeReasonCode(invalid)}`);
          } else {
            validatorSkipped = true;
          }
        }
      } catch (err) {
        if (definition.capability_class === "D") {
          return deny(`preflight_failed:${(err as Error).message.slice(0, 60)}`);
        }
      }
    }

    // JARVIS-051: alle ortogonale porter (parameter, rate limit, frys, credential,
    // preflight) har passert - FØRST NÅ brennes godkjenningens engangs-nonce.
    if (decision.commit) {
      const committed = await decision.commit();
      if (!committed.ok) {
        // En nonce som feiler ved forbruk gir en NY (DENY-)avgjørelse i Policy Gateway - revisjonsraden refererer til den, ikke til den foreløpige ALLOW-en.
        if (decision.commit_decision_id !== undefined) policyDecisionId = decision.commit_decision_id;
        return deny(committed.reason);
      }
    }

    let classDOutcome: { outcome: "executed" | "unverified" | "unknown"; external_id: string | null } | undefined;

    // D-392 (JARVIS-004/022) fase 1 - RESERVER: raden committes FØR leverandørkallet, og ingen DB-forbindelse holdes åpen over nettverket.
    // Står raden igjen som 'reserved' (krasj/SIGKILL/audit-feil midt i kallet) er utfallet UKJENT og en retry utfører ALDRI en ny mutasjon.
    if (ledgerKey !== undefined) {
      const gate = await withTenantTransaction<ToolResult | "rearmed_unvalidated" | null>(this.pool, tenantId, async (client) => {
        // WP-T1 (K3): digesten skrives KUN når modusen er observe/enforce og en digest kunne beregnes; ellers er INSERT/SELECT akkurat som før (modus `off` = main).
        const inserted = requestDigestValue === undefined
          ? await client.query(
            `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state)
           VALUES ($1, $2, $3, $4, 'reserved', $5) ON CONFLICT DO NOTHING`,
            [tenantId, ledgerKey, request.tool_id, request.action, JSON.stringify(beforeState)]
          )
          : await client.query(
            `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state, request_digest)
           VALUES ($1, $2, $3, $4, 'reserved', $5, $6) ON CONFLICT DO NOTHING`,
            [tenantId, ledgerKey, request.tool_id, request.action, JSON.stringify(beforeState), requestDigestValue]
          );
        if (inserted.rowCount === 1) return null;
        const prior = digestMode === "off"
          ? await client.query(
            "SELECT external_id, status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1",
            [ledgerKey]
          )
          : await client.query(
            "SELECT external_id, status, postcondition_reason, tool_id, action, request_digest FROM tool_executions WHERE idempotency_key = $1",
            [ledgerKey]
          );
        const row = prior.rows[0] as
          | { external_id: string | null; status: string; postcondition_reason: string | null; tool_id?: string; action?: string; request_digest?: string | null }
          | undefined;
        // WP-T1 (K3, JARVIS-102): SAMME nøkkel brukt til en ANNEN forespørsel er aldri «det lagrede resultatet». Avgjort HER, i samme transaksjon som konflikten (atomisk mot samtidige kall), FØR noen statusgren.
        if (digestMode !== "off" && requestDigestValue !== undefined && row?.tool_id !== undefined && row.action !== undefined) {
          const verdict = judgeKeyReuse({ tool_id: row.tool_id, action: row.action, request_digest: row.request_digest ?? null }, { tool_id: request.tool_id, action: request.action, digest: requestDigestValue });
          if (verdict !== "match") {
            const detail = {
              mode: digestMode, key_fp: shortFingerprint(ledgerKey), request_digest_fp: shortFingerprint(requestDigestValue),
              stored_digest_fp: row.request_digest === null || row.request_digest === undefined ? null : shortFingerprint(row.request_digest),
              stored_tool_id: row.tool_id.slice(0, 80), stored_action: row.action.slice(0, 80), stored_status: row.status
            };
            if (verdict === "mismatch" && digestMode === "enforce") {
              await writeAudit(client, request.identity, { ...corr,
                type: "tool.idempotency_key_reuse_mismatch", decision: "DENY", reason: IDEMPOTENCY_KEY_REUSE_MISMATCH,
                tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class, payload: auditPayload(detail)
              });
              return { ok: false, reason: IDEMPOTENCY_KEY_REUSE_MISMATCH } as const;
            }
            // observe (mismatch) og begge moduser for en rad uten digest (legacy): kjører som før, men loggføres.
            await writeAudit(client, request.identity, { ...corr,
              type: verdict === "mismatch" ? "tool.idempotency_key_reuse_observed" : "tool.idempotency_legacy_row", decision: "ALLOW",
              reason: verdict === "mismatch" ? IDEMPOTENCY_KEY_REUSE_MISMATCH : "idempotency_legacy_row_unverifiable",
              tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class, payload: auditPayload({ ...detail, would_reject: verdict === "mismatch" })
            });
          }
        }
        if (row?.status === "succeeded") {
          await writeAudit(client, request.identity, { ...corr,
            type: "tool.deduplicated", tool_id: request.tool_id, action: request.action,
            payload: auditPayload({ external_id: row.external_id })
          });
          return {
            ok: true,
            ...(row.external_id !== null ? { external_id: row.external_id } : {}),
            output_trust: definition.output_trust,
            deduplicated: true
          } as const;
        }
        // Q-34 P2-oppfølging: en retry med SAMME idempotency_key etter `unverified` skal ALDRI utløse en ny mutasjon og ALDRI bli ok:true -
        // den ser NØYAKTIG det samme sanne, ikke-suksessfulle resultatet som den opprinnelige kalleren fikk.
        if (row?.status === "unverified") {
          await writeAudit(client, request.identity, { ...corr,
            type: "tool.postcondition_unverified", decision: "ALLOW",
            tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class,
            payload: auditPayload({ external_id: row.external_id, replayed: true, reason: row.postcondition_reason })
          });
          return { ok: false, reason: row.postcondition_reason ?? "postcondition_unverified:replayed" } as const;
        }
        if (row?.status === "failed") {
          // Leverandøren avviste forrige forsøk (ingen bekreftet bivirkning): re-arm raden atomisk; kun én samtidig retry vinner.
          const rearmed = await client.query(
            `UPDATE tool_executions SET status = 'reserved', executed_at = now(), before_state = $2, postcondition_reason = NULL
              WHERE idempotency_key = $1 AND status = 'failed'`,
            [ledgerKey, JSON.stringify(beforeState)]
          );
          // Review F6: validatoren ble hoppet over ved replay-peeken (raden var da `reserved` hos et samtidig kall som siden feilet) - signaliser at den må kjøres nå.
          if (rearmed.rowCount === 1) return validatorSkipped ? "rearmed_unvalidated" as const : null;
        }
        await writeAudit(client, request.identity, { ...corr,
          type: "tool.execution_in_flight", decision: "DENY", reason: "execution_in_flight_or_outcome_unknown",
          tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class,
          payload: auditPayload({ status: row?.status ?? null })
        });
        return { ok: false, reason: "execution_in_flight_or_outcome_unknown" } as const;
      });
      if (gate === "rearmed_unvalidated") {
        // WP-F1 (review F6): re-arm av en feilet rad uten at validatoren har kjørt. Kjør den på FERSK tilstand (utenfor transaksjonen) før noe utføres; feiler den,
        // frigis reservasjonen uten leverandørkall (raden tilbake til `failed`, ikke ukjent utfall).
        const revalidated = await this.revalidateAfterRearm(definition, request, credential, invocationContext);
        if (revalidated.reason !== null) {
          await this.releaseLedgerReservation(tenantId, ledgerKey, `rearm_${revalidated.reason}`);
          return deny(revalidated.reason);
        }
        beforeState = revalidated.beforeState;
        await this.updateLedgerBeforeState(tenantId, ledgerKey, beforeState);
      } else if (gate !== null) {
        return gate;
      }
    }

    // WP-F1 (review F8): global kill switch, frys (tool-namespace OG connector) og tilbakekalling av den løste credentialen kan ha slått inn siden start - sjekk dem PÅ NYTT rett
    // FØR leverandørkallet, etter at reservasjonen er tatt (analogt med C3 sin `authorizePush()` rett før push). Feiler det, frigis reservasjonen uten leverandørkall
    // (raden tilbake til `failed` - ingenting er sendt, så dette er ikke et ukjent utfall).
    if (classDGoverned && ledgerKey !== undefined) {
      const denial = await this.liveControlDenial(request.tool_id, definition, credentialRef, isCredentialRevocationSelfRecovery);
      if (denial !== null) {
        await this.releaseLedgerReservation(tenantId, ledgerKey, `recheck_${denial}`);
        return deny(denial);
      }
    }

    // Fase 2 - UTFØR utenfor transaksjon (JARVIS-022): leverandørkall, preflight og readback holder ingen pool-forbindelse, så nøstede
    // `execute()`-kall (eksekutiv/komposisjoner) kan ikke tømme poolen og deadlocke.
    let external: { external_id?: string; data?: JsonValue } = {};
    let failure: { message: string; timedOut: boolean } | undefined;
    try {
      // WP-K (D-471, JARVIS-018): tidsavbruddet AVBRYTER nå selve forespørselen (signal til transporten + ambient kontekst) - ikke bare løftet.
      external = await withTimeout(
        (signal) => invokeWithCallSignal(definition.transport, request.action, request.parameters, credential, invocationContext, signal),
        definition.timeout_ms
      );
    } catch (err) {
      const raw = (err as Error).message;
      // WP-F1: «utfall ukjent» = gateway-tidsavbrudd ELLER en transport som selv vet at leverandørkallet kan ha gått gjennom (`outcome_unknown:...`).
      // Review M1: OG en uavklart transportfeil på en ikke-idempotent klasse C/D-mutasjon (feilformen avgjøres av `isIndeterminateTransportError`; DNS/tilkobling nektet/TLS beviser at ingenting ble sendt og forblir `failed`).
      const transportUnknown = !isOutcomeUnknownMessage(raw) && mayDuplicateOnRetry(definition) && isIndeterminateTransportError(err);
      const message = transportUnknown ? `${OUTCOME_UNKNOWN_PREFIX}:transport_${transportErrorKind(err)}` : raw;
      failure = { message, timedOut: isOutcomeUnknownMessage(message) };
      // WP-G1c (JARVIS-112 g4): et typet policy-avslag (`PolicyDeniedError`) er Jarvis' egen beslutning, ikke en leverandørfeil: connector-helsen røres ikke. ALT annet er klassifisert som før.
      if (!isPolicyDenied(err)) {
        this.setHealth(request.tool_id,
          /401|403|auth/.test(raw) ? "auth_failed" : /429|rate/.test(raw) ? "rate_limited" : "unavailable",
          raw.slice(0, 60));
      }
    }

    let afterState: JsonValue | null = null;
    let postconditionReason: string | null = null;
    if (!failure) {
      let readbackFailed = false;
      let readbackAbsent = false;
      if (needsEvidence) {
        try {
          const post = await withTimeout(
            (signal) => invokeWithCallSignal(definition.transport, definition.preflight_action!, request.parameters, credential, invocationContext, signal),
            definition.timeout_ms
          );
          afterState = post.data ?? null;
        } catch (err) {
          afterState = null; // readback-feil skjuler aldri at handlingen skjedde - audit under
          // Del 3: for et slette-verktøy ER «finnes ikke» etterbetingelsen - ikke en uleselig readback.
          if (definition.postcondition_target_absent && isNotFoundError((err as Error).message)) readbackAbsent = true;
          else readbackFailed = true;
        }
      }
      // Q-34 P1-oppfølging: `postconditionReason` er `null` NÅR OG BARE NÅR verifisert (kun for verktøy som lover verifisering).
      if (classDGoverned && definition.class_d_profile === "outbound_message") {
        // Del 3: leverandørens bekreftede ID er etterbetingelsen for en utgående melding.
        if (!external.external_id) postconditionReason = "postcondition_unverified:no_provider_id";
      } else if (definition.capability_class === "D" && definition.postcondition_target_absent) {
        if (readbackFailed) postconditionReason = "postcondition_unverified:readback_failed";
        else if (!readbackAbsent && afterState !== null) postconditionReason = "postcondition_mismatch";
      } else if (definition.capability_class === "D" && definition.postcondition_predicate) {
        if (readbackFailed) {
          postconditionReason = "postcondition_unverified:readback_failed";
        } else if (afterState === null) {
          postconditionReason = "postcondition_unverified:target_missing";
        } else {
          // Predikatet er UTVIDELSESKODE: en kastet feil er «ikke verifisert», aldri en tapt bevisføring for en mutasjon som skjedde.
          let predicateHeld: boolean;
          try {
            predicateHeld = definition.postcondition_predicate(afterState, request.parameters);
          } catch {
            predicateHeld = false;
            postconditionReason = "postcondition_unverified:predicate_error";
          }
          if (postconditionReason === null && !predicateHeld) postconditionReason = "postcondition_mismatch";
        }
      }
    }
    const postconditionVerified = !failure && postconditionReason === null;
    // Et tidsavbrudd betyr at bivirkningen KAN ha skjedd: aldri retry-bar (unverified), i motsetning til en kastet leverandørfeil.
    const finalStatus: "succeeded" | "failed" | "unverified" = failure
      ? (failure.timedOut ? "unverified" : "failed")
      : postconditionVerified ? "succeeded" : "unverified";
    const finalReason = failure
      ? (failure.timedOut ? "postcondition_unverified:tool_timeout_outcome_unknown" : `tool_failed:${failure.message.slice(0, 80)}`)
      : postconditionReason;

    // Fase 3 - FERDIGSTILL ledger + audit i én kort transaksjon (to forsøk; feiler begge står raden som 'reserved' = fail-closed).
    const finalize = (): Promise<void> =>
      withTenantTransaction<void>(this.pool, tenantId, async (client) => {
        if (ledgerKey !== undefined) {
          await client.query(
            `UPDATE tool_executions SET status = $2, external_id = $3, after_state = $4, postcondition_reason = $5, executed_at = now()
              WHERE idempotency_key = $1 AND status = 'reserved'`,
            [ledgerKey, finalStatus, external.external_id ?? null, JSON.stringify(afterState), finalReason]
          );
        }
        if (failure) {
          // Kontrollert feil: revoked credential/timeout/providerfeil åpner ingenting.
          await writeAudit(client, request.identity, { ...corr,
            type: "tool.failed", decision: "DENY", reason: failure.message.slice(0, 120),
            tool_id: request.tool_id, action: request.action,
            capability_class: definition.capability_class,
            payload: auditPayload({ credential_ref: credentialRef, outcome_unknown: failure.timedOut })
          });
          return;
        }
        await writeAudit(client, request.identity, { ...corr,
          // Egen audit-type når verifiseringen feiler - ALDRI «tool.executed» for en ubekreftet handling.
          type: postconditionVerified ? "tool.executed" : "tool.postcondition_unverified", decision: "ALLOW",
          tool_id: request.tool_id, action: request.action,
          capability_class: definition.capability_class,
          payload: auditPayload({
            credential_ref: credentialRef, // referanse - aldri verdien
            external_id: external.external_id ?? null,
            scopes: definition.scopes,
            rollback: definition.rollback_procedure,
            ...(needsEvidence ? { before_state: beforeState, after_state: afterState, recovery: { snapshot: beforeState, procedure: definition.rollback_procedure } } : {})
          })
        });
      });
    let finalized = false;
    let finalizeError = "";
    for (let attempt = 0; attempt < 2 && !finalized; attempt += 1) {
      try {
        await finalize();
        finalized = true;
      } catch (err) {
        finalizeError = (err as Error).message.slice(0, 80);
      }
    }
    if (!finalized) {
      console.error(JSON.stringify({ msg: "tool_ledger_finalize_failed", tool_id: request.tool_id, action: request.action, error: finalizeError }));
      this.setHealth(request.tool_id, "degraded", "ledger_finalize_failed");
      if (!failure) classDOutcome = { outcome: "unverified", external_id: external.external_id ?? null };
      else if (failure.timedOut) classDOutcome = { outcome: "unknown", external_id: null };
      const unfinalized: ToolResult = failure
        ? { ok: false, reason: `tool_failed:${failure.message.slice(0, 80)}` }
        : { ok: false, reason: "postcondition_unverified:ledger_finalize_failed" };
      if (classDGoverned && classDOutcome) return this.notifyClassD(request, definition, classDOutcome, unfinalized, beforeState, { ...corr, ...(policyDecisionId !== undefined ? { policy_decision_id: policyDecisionId } : {}) });
      return unfinalized;
    }
    let result: ToolResult;
    if (failure) {
      result = { ok: false, reason: `tool_failed:${failure.message.slice(0, 80)}` };
      // WP-F1: et UKJENT utfall (tidsavbrudd/`outcome_unknown`) er ikke «ingenting skjedde» - eieren varsles umiddelbart out-of-band (aldri stille).
      if (failure.timedOut) classDOutcome = { outcome: "unknown", external_id: null };
    } else {
      classDOutcome = { outcome: postconditionVerified ? "executed" : "unverified", external_id: external.external_id ?? null };
      if (!postconditionVerified) {
        // Uleselig/manglende/feil etter-tilstand er en driftsavvikelse - men FORTSATT ikke «healthy».
        this.setHealth(request.tool_id, "degraded", "postcondition_unverified");
        result = { ok: false, reason: postconditionReason! };
      } else {
        this.setHealth(request.tool_id, "healthy");
        result = {
          ok: true,
          ...(external.external_id !== undefined ? { external_id: external.external_id } : {}),
          ...(external.data !== undefined ? { data: external.data } : {}),
          output_trust: definition.output_trust,
          deduplicated: false
        };
      }
    }
    if (classDGoverned && classDOutcome) {
      return this.notifyClassD(request, definition, classDOutcome, result, beforeState, { ...corr, ...(policyDecisionId !== undefined ? { policy_decision_id: policyDecisionId } : {}) });
    }
    return result;
  }

  /**
   * WP-T1 (modus `observe`): en OBSERVASJON - kallet kjører som før, men det som ville blitt avvist i `enforce` står i revisjonssporet (`decision: ALLOW`, `reason` = koden enforce ville gitt). Best-effort: en feil her
   * bryter aldri kallet (en observasjon er ikke en port). Aldri parametre eller nøkkel i klartekst.
   */
  private async auditObservation(
    request: { identity: IdentityContext; tool_id: string; action: string; idempotency_key?: string },
    definition: ToolDefinition, type: string, reason: string, extra: Record<string, unknown>, corr: AuditCorrelation, policyDecisionId: string | undefined
  ): Promise<void> {
    try {
      await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
        writeAudit(client, request.identity, {
          ...(corr.task_id !== undefined ? { task_id: corr.task_id } : {}), ...(corr.trace_id !== undefined ? { trace_id: corr.trace_id } : {}),
          type, decision: "ALLOW", reason, tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class,
          payload: { mode: "observe", would_deny: true, ...extra, ...(request.idempotency_key !== undefined ? { key_fp: shortFingerprint(request.idempotency_key) } : {}), ...(policyDecisionId !== undefined ? { policy_decision_id: policyDecisionId } : {}) }
        })
      );
    } catch (err) {
      console.error(JSON.stringify({ msg: "tool_observation_audit_failed", type, error: err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80) }));
    }
  }

  /** WP-F1: status på ledger-raden for en nøkkel (`null` = ingen rad). Kort, selvstendig transaksjon - brukes av replay-vakten rundt preflight-validatoren. */
  private async peekLedgerStatus(tenantId: string, ledgerKey: string): Promise<string | null> {
    return withTenantTransaction<string | null>(this.pool, tenantId, async (client) => {
      const res = await client.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [ledgerKey]);
      return (res.rows[0] as { status: string } | undefined)?.status ?? null;
    });
  }

  /**
   * WP-F1 (review F6): validatoren på FERSK tilstand etter at vi re-armet en feilet ledger-rad uten å ha validert (peeken så `reserved`). Samme rekkefølge som den vanlige preflight:
   * finnes målet, målsjekken, så validatoren. Kastet feil er fail-closed. Returnerer avslagsårsaken (eller `null`) og den ferske før-tilstanden.
   */
  private async revalidateAfterRearm(
    definition: ToolDefinition, request: { parameters: Record<string, JsonValue> }, credential: string, invocationContext: ToolInvocationContext
  ): Promise<{ reason: string | null; beforeState: JsonValue | null }> {
    try {
      const pre = await invokePreflight(definition, request.parameters, credential, invocationContext);
      const state = pre.data ?? null;
      if (state === null) return { reason: "preflight_target_not_found", beforeState: null };
      if (definition.preflight_target_check && !definition.preflight_target_check(state, request.parameters)) return { reason: "preflight_target_not_found", beforeState: null };
      let invalid: string | null;
      try {
        invalid = definition.preflight_validator!(state, request.parameters);
      } catch {
        invalid = "validator_error";
      }
      return invalid === null ? { reason: null, beforeState: state } : { reason: `preflight_invalid:${sanitizeReasonCode(invalid)}`, beforeState: null };
    } catch (err) {
      return { reason: `preflight_failed:${(err as Error).message.slice(0, 60)}`, beforeState: null };
    }
  }

  /** WP-F1 (review F6/F8): frigir en ledger-reservasjon FØR noe leverandørkall er gjort (`reserved -> failed`, retry med samme nøkkel tillatt). Best-effort: feiler skrivingen står raden som `reserved` (fail-closed). */
  private async releaseLedgerReservation(tenantId: string, ledgerKey: string, reason: string): Promise<void> {
    try {
      await withTenantTransaction<void>(this.pool, tenantId, async (client) => {
        await client.query(
          `UPDATE tool_executions SET status = 'failed', postcondition_reason = $2, executed_at = now() WHERE idempotency_key = $1 AND status = 'reserved'`,
          [ledgerKey, reason.slice(0, 200)]
        );
      });
    } catch (err) {
      console.error(JSON.stringify({ msg: "tool_ledger_release_failed", error: err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80) }));
    }
  }

  /** WP-F1 (review F6): oppdaterer før-tilstanden på en re-armet rad med den ferske lesingen (bevismateriale; best-effort). */
  private async updateLedgerBeforeState(tenantId: string, ledgerKey: string, beforeState: JsonValue | null): Promise<void> {
    try {
      await withTenantTransaction<void>(this.pool, tenantId, async (client) => {
        await client.query(`UPDATE tool_executions SET before_state = $2 WHERE idempotency_key = $1 AND status = 'reserved'`, [ledgerKey, JSON.stringify(beforeState)]);
      });
    } catch {
      /* bevismateriale - aldri en grunn til å stoppe en validert handling */
    }
  }

  /**
   * WP-F1 (review F8): de LIVE eierkontrollene (global kill switch, frys for tool-namespace OG connector-id-er, tilbakekalling av den løste credentialen) - samme koder som
   * startsjekkene, kjørt på nytt rett før leverandørkallet. `null` = ingenting er slått inn. Selvgjenopprettings-handlingene (`isSelfRecoveryAction`) er unntatt som ved start.
   */
  private async liveControlDenial(toolId: string, definition: ToolDefinition, credentialRef: string, selfRecovery: boolean): Promise<string | null> {
    const controls = this.controls;
    if (!controls) return null;
    if (!selfRecovery && (await controls.killSwitch.isActiveDurable())) return "kill_switch_active";
    if (toolId !== "owner_controls") {
      if (await controls.isFrozenDurable(toolId)) return "connector_frozen";
      for (const connectorId of definition.connector_ids_for?.(credentialRef) ?? []) {
        if (await controls.isFrozenDurable(connectorId)) return "connector_frozen";
      }
    }
    if (!selfRecovery && (await controls.isRevokedDurable(credentialRef))) return "credential_revoked";
    return null;
  }

  /**
   * Del 3: umiddelbar out-of-band-varsling etter en klasse D-utførelse. Handlingen har da allerede skjedd, så en varslingsfeil kan ikke
   * rulle den tilbake - den gjøres i stedet SYNLIG: audit `tool.class_d_notification_failed` + `notified:false` på resultatet.
   * WP-F1: også ved UKJENT utfall (`unknown`), og med et redigert sammendrag (`notification_summary`) av hva handlingen gjaldt.
   */
  private async notifyClassD(
    request: { identity: IdentityContext; tool_id: string; action: string; idempotency_key?: string; parameters?: Record<string, JsonValue>; onClassDNotification?: (status: { notified: boolean; error: string | null }) => void },
    definition: ToolDefinition,
    outcome: { outcome: "executed" | "unverified" | "unknown"; external_id: string | null },
    result: ToolResult,
    summaryState: JsonValue | null = null,
    audit: AuditCorrelation = {}
  ): Promise<ToolResult> {
    let notified = false;
    let notifyError: string | null = null;
    let summary: string | null = null;
    try {
      summary = definition.notification_summary?.(summaryState, request.parameters ?? {}) ?? null;
    } catch {
      summary = null; // et sammendrag er pynt - aldri en grunn til å miste selve varselet
    }
    try {
      // Review H1: out-of-band-varslingen er hele poenget med klasse D-kjeden («aldri stille»), og den er ALLTID mest nødvendig når utfallet er ukjent - nettopp da kan det YTRE kallet ha fått tidsavbrudd.
      // Varsleren er selv en nøstet `execute(telegram.notify)`, så den kjører frakoblet fra kallsignalet (egen frist per leverandørkall gjelder fortsatt).
      await detachFromCallSignal(() => this.classDNotifier!.notify({
        tenant_id: request.identity.tenant_id, person_id: request.identity.person_id,
        tool_id: request.tool_id, action: request.action, outcome: outcome.outcome,
        external_id: outcome.external_id, idempotency_key: request.idempotency_key ?? "",
        recovery: definition.rollback_procedure, at: new Date().toISOString(),
        ...(summary !== null && summary.length > 0 ? { summary: summary.slice(0, 300) } : {})
      }));
      notified = true;
    } catch (err) {
      // Kun en FAST kode (aldri feilteksten: den kan sitere URL-er/tokens fra varsel-leverandøren).
      notifyError = isIndeterminateTransportError(err) ? `notification_failed:${transportErrorKind(err)}` : "notification_failed";
      await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
        writeAudit(client, request.identity, {
          ...(audit.task_id !== undefined ? { task_id: audit.task_id } : {}), ...(audit.trace_id !== undefined ? { trace_id: audit.trace_id } : {}),
          type: "tool.class_d_notification_failed", decision: "ALLOW", reason: (err as Error).message.slice(0, 120),
          tool_id: request.tool_id, action: request.action, capability_class: "D",
          payload: { external_id: outcome.external_id, ...(audit.policy_decision_id !== undefined ? { policy_decision_id: audit.policy_decision_id } : {}) }
        })
      ).catch(() => undefined);
      this.setHealth("class_d_notifier", "degraded", (err as Error).message.slice(0, 60));
    }
    try { request.onClassDNotification?.({ notified, error: notifyError }); } catch { /* en observatør kan aldri bryte kjeden */ }
    return result.ok ? { ...result, notified } : result;
  }

  /**
   * Del 3: avstemming av klasse D-handlinger hvis utfall ikke kunne bekreftes (`status='unverified'`). Returnerer før-tilstand og
   * recovery-prosedyren slik at eieren (eller en jobb) kan rette opp - ALDRI en ny automatisk mutasjon.
   */
  async reconcile(tenantId: string, limit = 50): Promise<Array<{
    idempotency_key: string; tool_id: string; action: string; external_id: string | null;
    reason: string | null; before_state: JsonValue | null; recovery: string;
    /** WP-F1: `unverified` (utført men ikke bekreftet / utfall ukjent) eller `reserved` (krasj midt i kallet, eldre enn 5 min). */
    status: string; executed_at: string; after_state: JsonValue | null;
  }>> {
    const rows = await withTenantTransaction(this.pool, tenantId, async (client) =>
      (await client.query(
        `SELECT idempotency_key, tool_id, action, external_id, postcondition_reason, before_state, after_state, status, executed_at
           FROM tool_executions WHERE status = 'unverified' OR (status = 'reserved' AND executed_at < now() - interval '5 minutes') ORDER BY executed_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]
      )).rows as Array<{
        idempotency_key: string; tool_id: string; action: string; external_id: string | null; postcondition_reason: string | null;
        before_state: JsonValue | null; after_state: JsonValue | null; status: string; executed_at: Date
      }>
    );
    return rows.map((r) => ({
      idempotency_key: r.idempotency_key, tool_id: r.tool_id, action: r.action, external_id: r.external_id,
      reason: r.postcondition_reason, before_state: r.before_state, after_state: r.after_state,
      status: r.status, executed_at: r.executed_at instanceof Date ? r.executed_at.toISOString() : String(r.executed_at),
      recovery: this.get(r.tool_id, r.action)?.rollback_procedure ?? "ukjent verktøy - manuell oppfølging"
    }));
  }

  /**
   * WP-N1: betjenes kallet av en SKYMODELL (eller en ukjent modell)? `false` uten modell (eierens ruter, `/control`, eier-godkjente bekreftelser) og for en lokal modell; `true` for sky og alt ukjent (fail-closed):
   * en `servingModel` uten gyldig leverandørnavn, et gateway-oppsett uten `servedLocally`, et kast eller en ikke-`true` verdi. Samme regel som `ExecutiveService.isCloudServed` (H1/H2).
   */
  private servedByCloud(model: { provider: string; model: string } | undefined, lock: FinanceExecutionLock): boolean {
    if (model === undefined) return false;
    if (typeof model !== "object" || model === null || typeof model.provider !== "string" || model.provider.trim() === "") return true;
    const local = lock.servedLocally;
    if (typeof local !== "function") return true;
    try {
      return local(model) !== true;
    } catch {
      return true;
    }
  }

  /**
   * D-219: hvis selve audit-skrivingen her feiler (DB-blipp/RLS-/kontekst-
   * problem), skal ALDRI-avslaget likevel returneres til kalleren som normalt
   * (fail-safe - en policy-avslag skal aldri henge fast på en audit-skrivefeil)
   * - MEN et slikt tilfelle er da et avslag som forsvinner sporløst fra
   * revisjonssporet den samme regelen (CLAUDE.md §6, "Policy Gateway aldri
   * hoppes over") faktisk skal bevises av. Samme "isolasjon beholdes, feilen
   * gjøres OBSERVERBAR"-mønster som PR #79 sin fiks for
   * `location`/`health`-retensjonssveipene (`sweep.ts` i begge pakker).
   */
  private async deny(
    request: { identity: IdentityContext; tool_id: string; action: string },
    reason: string,
    audit: AuditCorrelation = {}
  ): Promise<ToolResult> {
    await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
      writeAudit(client, request.identity, {
        // WP-K (JARVIS-054): også avslag bærer oppgave-/spor-ID og (etter policy) ID-en til avgjørelsen som gikk forut.
        ...(audit.task_id !== undefined ? { task_id: audit.task_id } : {}), ...(audit.trace_id !== undefined ? { trace_id: audit.trace_id } : {}),
        type: "tool.denied", decision: "DENY", reason,
        tool_id: request.tool_id, action: request.action,
        ...(audit.policy_decision_id !== undefined ? { payload: { policy_decision_id: audit.policy_decision_id } } : {})
      })
    ).catch((err) => {
      console.error(JSON.stringify({
        msg: "tool_denied_audit_write_failed",
        tool_id: request.tool_id,
        action: request.action,
        reason,
        error: err instanceof Error ? err.message : String(err)
      }));
    });
    return { ok: false, reason };
  }

  private withinRateLimit(definition: ToolDefinition, tenantId: string): boolean {
    const key = `${definition.tool_id}:${definition.action}:${tenantId}`;
    const now = Date.now();
    const times = (this.callTimes.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= definition.rate_limit_per_minute) {
      return false;
    }
    times.push(now);
    this.callTimes.set(key, times);
    return true;
  }
}

/**
 * WP-K (D-471, JARVIS-018): fristen for ett leverandørkall. `run` får et `AbortSignal` som avbrytes når fristen går ut - ETTER at løftet er avvist med `tool_timeout`
 * (rekkefølgen er bevisst: tidsavbruddet vinner alltid kappløpet, så utfallet klassifiseres som «ukjent» og aldri som en vanlig leverandørfeil som kan prøves på nytt, selv om den
 * avbrutte forespørselen avviser nesten samtidig). En vellykket retur avbryter ikke noe.
 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("tool_timeout");
      reject(err);
      // Review M2: med `JARVIS_TOOL_CALL_ABORT=off` avvises løftet som før WP-K, men forespørselen avbrytes ikke.
      if (toolCallAbortEnabled()) controller.abort(err);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * WP-FIN2 (D-486, K3): preflight (og re-arm-lesingen) leser tilstanden FØR noe reserveres eller utføres og hadde INGEN frist - en hengende lesing holdt kallet for alltid. Nå samme `timeout_ms` og
 * kallsignal som selve utførelsen. Tidsavbrudd gir det EKSISTERENDE utfallet av en kastet preflight (klasse D: avslag `preflight_failed:tool_timeout` før noe reserveres; klasse C: som en kastet preflight;
 * re-arm: avslag og frigitt reservasjon) - aldri en ny utfallstype. `JARVIS_TOOL_CALL_ABORT=off` = som før (ingen frist, intet signal).
 */
function invokePreflight(
  definition: ToolDefinition, parameters: Record<string, JsonValue>, credential: string, invocationContext: ToolInvocationContext
): Promise<{ external_id?: string; data?: JsonValue }> {
  const action = definition.preflight_action!;
  if (!toolCallAbortEnabled()) return definition.transport.invoke(action, parameters, credential, invocationContext);
  return withTimeout((signal) => invokeWithCallSignal(definition.transport, action, parameters, credential, invocationContext, signal), definition.timeout_ms);
}
