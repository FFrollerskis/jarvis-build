import type pg from "pg";
import { z } from "zod";
import type { CapabilityClass, IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import { UnsafeVendorUrlError, guardedFetch } from "./url-safety.ts";
import { assessClassDPipeline, isClassDExempt, isNotFoundError, ownerStepUpDenial, type ClassDNotifier, type ClassDPipelineOptions } from "./class-d-pipeline.ts";
import { isSelfRecoveryAction, type OwnerControls, type PolicyGateway } from "@jarvis/policy";

/** Secrets bak adapter (D-16): env/SOPS nå; Infisical/OpenBao (Q-05, krever Docker) senere. */
export interface SecretProvider {
  readonly name: string;
  /** Returnerer credential eller null. Verdien går ALDRI i logg/trace/modellkontekst. */
  get(ref: string): Promise<string | null>;
  /**
   * VALGFRI (WP-C3 review F3): tilstedeværelse UTEN å materialisere verdien. `ToolGateway.hasSecret()` bruker den hvis den finnes, ellers `get(ref) !== null`. Trengs av leverandører der
   * `get` har en SIDEEFFEKT eller kostnad - i dag GitHub App-dekoratøren, hvor `get` utsteder et installasjonstoken (et kall mot GitHub): uten `has` ville hver statuspoll, helse-sveip
   * og dashbord-visning («er X konfigurert») utstedt et token, selv for en tilbakekalt credential. Skal aldri kaste (`false` = ikke tilgjengelig) og aldri gjøre nettverkskall mot
   * selve tjenesten credentialen gjelder. En wrapper som ikke videresender `has` faller trygt tilbake til `get`.
   */
  has?(ref: string): Promise<boolean>;
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
  health: "healthy" | "unavailable" | "unconfigured" = "unconfigured";

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

  async get(ref: string): Promise<string | null> {
    if (!this.available()) {
      this.health = "unconfigured";
      return null;
    }
    try {
      this.token ??= await this.login();
      const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}?workspaceId=${this.projectId}&environment=${this.env}`;
      const response = await guardedFetch(url, { signal: AbortSignal.timeout(INFISICAL_READ_TIMEOUT_MS), headers: { authorization: `Bearer ${this.token}` } });
      if (response.status === 401) { this.token = null; throw new Error("infisical_auth_expired"); }
      if (response.status === 404) { this.health = "healthy"; return null; }
      if (!response.ok) throw new Error(`infisical_${response.status}`);
      this.health = "healthy";
      return ((await response.json()) as { secret: { secretValue: string } }).secret.secretValue;
    } catch (err) {
      // En utrygg INFISICAL_URL er en KONFIG-feil, ikke et avbrudd: si det tydelig (uten verdi) i stedet for å se ut som en Infisical-nedetid.
      if (err instanceof UnsafeVendorUrlError) console.error(JSON.stringify({ msg: "infisical_url_unsafe", reason: err.reason }));
      this.health = "unavailable";
      return null; // fail-closed her; FallbackSecretProvider håndterer rollback
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
    this.token ??= await this.login();
    const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}`;
    const body = JSON.stringify({ workspaceId: this.projectId, environment: this.env, secretValue: value });
    const headers = { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
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
   * D-449 (Q-50): hvem som skrev innholdet i `parameters`. `owner_direct` = den deterministiske hurtigbanen der parameterne er eierens EGNE ord, ordrett (ingen modell har
   * formulert eller omskrevet dem; `main.ts` sin `delegateBackground`). Settes KUN av trusted kode i kallerens `ToolGateway.execute()`-kall, ALDRI fra `parameters` -
   * SAMME disiplin som `servingModel`. Mangler både denne og `servingModel` (f.eks. en eier-godkjent bekreftelse som utfører et modellskrevet kall senere), er innholdets opphav
   * UKJENT, og en transport som bruker opphavet til å åpne en dyrere/mer eksponert rute må da regne det som ikke betrodd (fail-closed).
   */
  contentOrigin?: "owner_direct";
}

/** Transport per integrasjon: ekte HTTP i drift, kontrollert fake i test. */
export interface ToolTransport {
  invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    credential: string,
    context: ToolInvocationContext
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
}

/**
 * WP-F1: en transport som VET at leverandørutfallet er ukjent (tidsavbrudd/nettverk/5xx etter at et kall kan ha nådd leverandøren) kaster en feil som begynner med
 * dette prefikset. Gatewayen behandler den som et gateway-tidsavbrudd: raden blir `unverified` (aldri retry-bar med samme nøkkel, havner i `reconcile()`),
 * og eieren varsles om at utfallet er ukjent - en kastet leverandørfeil (`failed`) betyr derimot «ingen bivirkning, retry tillatt».
 */
export const OUTCOME_UNKNOWN_PREFIX = "outcome_unknown";

export function isOutcomeUnknownMessage(message: string): boolean {
  return message === "tool_timeout" || message.startsWith(OUTCOME_UNKNOWN_PREFIX);
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

export interface ToolGatewayOptions {
  classDPipeline?: ClassDPipelineOptions;
  credentialBinding?: CredentialBinding;
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

  async execute(request: {
    identity: IdentityContext;
    tool_id: string;
    action: string;
    parameters: Record<string, JsonValue>;
    idempotency_key?: string;
    approval?: unknown;
    /** Delegert jobb: verktøyet MÅ stå i kontraktens allowed_tools. */
    jobContract?: JobContract;
    /** D-317: se `ToolInvocationContext.servingModel` sitt filhode. */
    servingModel?: { provider: string; model: string };
    /** D-449: se `ToolInvocationContext.contentOrigin` sitt filhode (kun trusted kode setter den). */
    contentOrigin?: "owner_direct";
    /** D-394 (JARVIS-054): korrelasjons-ID-er som følger HVER audit-rad for dette kallet. */
    task_id?: string;
    trace_id?: string;
  }): Promise<ToolResult> {
    const definition = this.get(request.tool_id, request.action);
    const corr = { ...(request.task_id !== undefined ? { task_id: request.task_id } : {}), ...(request.trace_id !== undefined ? { trace_id: request.trace_id } : {}) };
    if (!definition) {
      return this.deny(request, "unknown_tool");
    }
    if (request.jobContract && !jobContractAllows(request.jobContract.allowed_tools, request.tool_id, request.action)) {
      return this.deny(request, "tool_not_in_job_contract");
    }
    // Del 3 (JARVIS-005/012): en jobb kan aldri handle som en annen person/tenant enn den signerte kontrakten sier.
    if (
      request.jobContract &&
      (request.jobContract.owner_person_id !== request.identity.person_id || request.jobContract.tenant_id !== request.identity.tenant_id)
    ) {
      return this.deny(request, "job_identity_mismatch");
    }
    const input = definition.input_schema.safeParse(request.parameters);
    if (!input.success) {
      return this.deny(request, "invalid_parameters");
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
        return this.deny(request, `scope_mismatch:${field}`);
      }
    }
    if (request.jobContract) {
      const space = request.parameters["memory_space"] ?? request.parameters["memory_space_id"];
      if (typeof space === "string" && !request.jobContract.allowed_memory_spaces.includes(space)) {
        return this.deny(request, "job_memory_space_not_allowed");
      }
    }
    // Eier-tilkoblede leverandør-credentials kan bare brukes av den autentiserte eieren i eierens tenant (aldri en annen person/tenant/delegat).
    if (binding && definition.credential_ref !== "" && !binding.internalRefs.has(definition.credential_ref) && !isOwner) {
      return this.deny(request, "credential_not_bound_to_identity");
    }
    // WP-F1 (review F9): eier-eksklusive handlinger (finans-lesinger) også for klasse A.
    if (definition.owner_only === true && binding && !isOwner) {
      return this.deny(request, "owner_only");
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
      deferNonceConsumption: true
    });
    if (decision.decision !== "ALLOW") {
      return this.deny(request, decision.reason);
    }
    if (definition.parameterAuthorizer) {
      const paramDecision = definition.parameterAuthorizer(request.parameters, request.identity);
      if (!paramDecision.allowed) {
        return this.deny(request, paramDecision.reason);
      }
    }
    // Del 3 (JARVIS-013/043): klasse D-pipelinen er en HARD port i produksjon (påslått i api og worker).
    const classDGoverned = this.classDPipeline?.enforce === true && definition.capability_class === "D" && !isClassDExempt(definition);
    // WP-F1: pengehandlinger krever eierens step-up (signert enhet + eier-kanal) - håndhevet her, ikke bare i rutene.
    // Review F4: UAVHENGIG av `classDPipeline.enforce` - en gateway uten options (testhjelper, host-skript) skal ikke la en svakere økt flytte penger.
    if (definition.step_up_required === true) {
      const stepUp = ownerStepUpDenial(request.identity);
      if (stepUp !== undefined) return this.deny(request, stepUp);
    }
    if (!this.withinRateLimit(definition, request.identity.tenant_id)) {
      return this.deny(request, "rate_limited");
    }
    // K1 (Sovereign graduation, D-164): LIVE, delt sjekk (aldri den rene
    // synkrone `isFrozen()`/`isRevoked()`) - se `OwnerControls` sitt
    // filhode. `owner_controls` selv kan aldri fryse seg selv ute (samme
    // selvgjenopprettings-unntak som `PolicyGateway.authorize()` - se der).
    if (request.tool_id !== "owner_controls" && (await this.controls?.isFrozenDurable(request.tool_id))) {
      return this.deny(request, "connector_frozen");
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
      ...(request.contentOrigin !== undefined ? { contentOrigin: request.contentOrigin } : {})
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
        return this.deny(request, "credential_ref_unresolved");
      }
      credentialRef = resolved;
      // Samme eier-binding for den løste refen som for den statiske (aldri svakere).
      if (binding && !binding.internalRefs.has(credentialRef) && !isOwner) {
        return this.deny(request, "credential_not_bound_to_identity");
      }
    }
    // WP-F1 (review F8): frys gjelder også CONNECTOR-id-en (stripe/vipps/fiken/neonomics) utledet av den løste credential-referansen, ikke bare tool-namespacet.
    if (this.controls && request.tool_id !== "owner_controls") {
      for (const connectorId of definition.connector_ids_for?.(credentialRef) ?? []) {
        if (await this.controls.isFrozenDurable(connectorId)) return this.deny(request, "connector_frozen");
      }
    }
    if (!isCredentialRevocationSelfRecovery && (await this.controls?.isRevokedDurable(credentialRef))) {
      return this.deny(request, "credential_revoked");
    }
    const credential = await this.secrets.get(credentialRef);
    if (!credential) {
      return this.deny(request, "credential_unavailable");
    }

    // Del 3 (JARVIS-013/043): klasse D-pipelinen er en HARD port - uten hele kjeden er handlingen utilgjengelig (fail-closed).
    if (classDGoverned) {
      const assessment = assessClassDPipeline(definition);
      if (!assessment.complete) {
        return this.deny(request, `class_d_pipeline_incomplete:${assessment.missing.join(",")}`);
      }
      if (!request.idempotency_key) {
        return this.deny(request, "class_d_idempotency_key_required");
      }
      let notifierReady = false;
      try {
        notifierReady = this.classDNotifier ? await this.classDNotifier.ready() : false;
      } catch {
        notifierReady = false;
      }
      if (!notifierReady) {
        return this.deny(request, this.classDNotifier ? "class_d_notifier_not_ready" : "class_d_notifier_missing");
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
        const pre = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential, invocationContext);
        beforeState = pre.data ?? null;
        // Q-34: preflight-KALLET lyktes (kastet ikke), men for et revidert
        // klasse D-verktøy betyr et null/undefined resultat FAKTISK "mål
        // finnes ikke" - se `preflight_requires_target` sin doc-kommentar.
        // Denne mutasjonen har ikke skjedd ennå og transaksjonen er ikke
        // startet, så avslaget her har PRESIS samme "ingenting å rulle
        // tilbake"-egenskap som en kastet preflight-feil under.
        if (definition.capability_class === "D" && definition.preflight_requires_target && beforeState === null) {
          return this.deny(request, "preflight_target_not_found");
        }
        // Q-34 P1-oppfølging: den FINERE sjekken - ressursen finnes (over),
        // men det PÅSTÅTTE mål-ID-et inni den må også faktisk finnes.
        if (
          definition.capability_class === "D" &&
          beforeState !== null &&
          definition.preflight_target_check &&
          !definition.preflight_target_check(beforeState, request.parameters)
        ) {
          return this.deny(request, "preflight_target_not_found");
        }
        // WP-F1: validering med SPESIFIKK årsak (beløp/valuta/konto/leverandør/tilstand/duplikat/nødbryter). En replay av en nøkkel som allerede har et
        // endelig utfall i ledgeren (gjennomført/uverifisert/under utførelse) valideres IKKE på nytt: tilstanden har da flyttet seg ved handlingen selv, og
        // ledger-porten under svarer med det lagrede utfallet (aldri en ny mutasjon) i stedet for et misvisende «ikke lenger gyldig».
        if (definition.capability_class === "D" && definition.preflight_validator) {
          if (beforeState === null) return this.deny(request, "preflight_target_not_found");
          const replayStatus = ledgerKey !== undefined ? await this.peekLedgerStatus(tenantId, ledgerKey) : null;
          if (replayStatus === null || replayStatus === "failed") {
            let invalid: string | null;
            try {
              invalid = definition.preflight_validator(beforeState, request.parameters);
            } catch {
              invalid = "validator_error";
            }
            if (invalid !== null) return this.deny(request, `preflight_invalid:${sanitizeReasonCode(invalid)}`);
          } else {
            validatorSkipped = true;
          }
        }
      } catch (err) {
        if (definition.capability_class === "D") {
          return this.deny(request, `preflight_failed:${(err as Error).message.slice(0, 60)}`);
        }
      }
    }

    // JARVIS-051: alle ortogonale porter (parameter, rate limit, frys, credential,
    // preflight) har passert - FØRST NÅ brennes godkjenningens engangs-nonce.
    if (decision.commit) {
      const committed = await decision.commit();
      if (!committed.ok) {
        return this.deny(request, committed.reason);
      }
    }

    let classDOutcome: { outcome: "executed" | "unverified" | "unknown"; external_id: string | null } | undefined;

    // D-392 (JARVIS-004/022) fase 1 - RESERVER: raden committes FØR leverandørkallet, og ingen DB-forbindelse holdes åpen over nettverket.
    // Står raden igjen som 'reserved' (krasj/SIGKILL/audit-feil midt i kallet) er utfallet UKJENT og en retry utfører ALDRI en ny mutasjon.
    if (ledgerKey !== undefined) {
      const gate = await withTenantTransaction<ToolResult | "rearmed_unvalidated" | null>(this.pool, tenantId, async (client) => {
        const inserted = await client.query(
          `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state)
           VALUES ($1, $2, $3, $4, 'reserved', $5) ON CONFLICT DO NOTHING`,
          [tenantId, ledgerKey, request.tool_id, request.action, JSON.stringify(beforeState)]
        );
        if (inserted.rowCount === 1) return null;
        const prior = await client.query(
          "SELECT external_id, status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1",
          [ledgerKey]
        );
        const row = prior.rows[0] as
          | { external_id: string | null; status: string; postcondition_reason: string | null }
          | undefined;
        if (row?.status === "succeeded") {
          await writeAudit(client, request.identity, { ...corr,
            type: "tool.deduplicated", tool_id: request.tool_id, action: request.action,
            payload: { external_id: row.external_id }
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
            payload: { external_id: row.external_id, replayed: true, reason: row.postcondition_reason }
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
          payload: { status: row?.status ?? null }
        });
        return { ok: false, reason: "execution_in_flight_or_outcome_unknown" } as const;
      });
      if (gate === "rearmed_unvalidated") {
        // WP-F1 (review F6): re-arm av en feilet rad uten at validatoren har kjørt. Kjør den på FERSK tilstand (utenfor transaksjonen) før noe utføres; feiler den,
        // frigis reservasjonen uten leverandørkall (raden tilbake til `failed`, ikke ukjent utfall).
        const revalidated = await this.revalidateAfterRearm(definition, request, credential, invocationContext);
        if (revalidated.reason !== null) {
          await this.releaseLedgerReservation(tenantId, ledgerKey, `rearm_${revalidated.reason}`);
          return this.deny(request, revalidated.reason);
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
        return this.deny(request, denial);
      }
    }

    // Fase 2 - UTFØR utenfor transaksjon (JARVIS-022): leverandørkall, preflight og readback holder ingen pool-forbindelse, så nøstede
    // `execute()`-kall (eksekutiv/komposisjoner) kan ikke tømme poolen og deadlocke.
    let external: { external_id?: string; data?: JsonValue } = {};
    let failure: { message: string; timedOut: boolean } | undefined;
    try {
      external = await withTimeout(
        definition.transport.invoke(request.action, request.parameters, credential, invocationContext),
        definition.timeout_ms
      );
    } catch (err) {
      const message = (err as Error).message;
      // WP-F1: «utfall ukjent» = gateway-tidsavbrudd ELLER en transport som selv vet at leverandørkallet kan ha gått gjennom (`outcome_unknown:...`).
      failure = { message, timedOut: isOutcomeUnknownMessage(message) };
      this.setHealth(request.tool_id,
        /401|403|auth/.test(message) ? "auth_failed" : /429|rate/.test(message) ? "rate_limited" : "unavailable",
        message.slice(0, 60));
    }

    let afterState: JsonValue | null = null;
    let postconditionReason: string | null = null;
    if (!failure) {
      let readbackFailed = false;
      let readbackAbsent = false;
      if (needsEvidence) {
        try {
          const post = await withTimeout(
            definition.transport.invoke(definition.preflight_action!, request.parameters, credential, invocationContext),
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
            payload: { credential_ref: credentialRef, outcome_unknown: failure.timedOut }
          });
          return;
        }
        await writeAudit(client, request.identity, { ...corr,
          // Egen audit-type når verifiseringen feiler - ALDRI «tool.executed» for en ubekreftet handling.
          type: postconditionVerified ? "tool.executed" : "tool.postcondition_unverified", decision: "ALLOW",
          tool_id: request.tool_id, action: request.action,
          capability_class: definition.capability_class,
          payload: {
            credential_ref: credentialRef, // referanse - aldri verdien
            external_id: external.external_id ?? null,
            scopes: definition.scopes,
            rollback: definition.rollback_procedure,
            ...(needsEvidence ? { before_state: beforeState, after_state: afterState, recovery: { snapshot: beforeState, procedure: definition.rollback_procedure } } : {})
          }
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
      if (classDGoverned && classDOutcome) return this.notifyClassD(request, definition, classDOutcome, unfinalized, beforeState);
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
      return this.notifyClassD(request, definition, classDOutcome, result, beforeState);
    }
    return result;
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
      const pre = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential, invocationContext);
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
    request: { identity: IdentityContext; tool_id: string; action: string; idempotency_key?: string; parameters?: Record<string, JsonValue> },
    definition: ToolDefinition,
    outcome: { outcome: "executed" | "unverified" | "unknown"; external_id: string | null },
    result: ToolResult,
    summaryState: JsonValue | null = null
  ): Promise<ToolResult> {
    let notified = false;
    let summary: string | null = null;
    try {
      summary = definition.notification_summary?.(summaryState, request.parameters ?? {}) ?? null;
    } catch {
      summary = null; // et sammendrag er pynt - aldri en grunn til å miste selve varselet
    }
    try {
      await this.classDNotifier!.notify({
        tenant_id: request.identity.tenant_id, person_id: request.identity.person_id,
        tool_id: request.tool_id, action: request.action, outcome: outcome.outcome,
        external_id: outcome.external_id, idempotency_key: request.idempotency_key ?? "",
        recovery: definition.rollback_procedure, at: new Date().toISOString(),
        ...(summary !== null && summary.length > 0 ? { summary: summary.slice(0, 300) } : {})
      });
      notified = true;
    } catch (err) {
      await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
        writeAudit(client, request.identity, {
          type: "tool.class_d_notification_failed", decision: "ALLOW", reason: (err as Error).message.slice(0, 120),
          tool_id: request.tool_id, action: request.action, capability_class: "D", payload: { external_id: outcome.external_id }
        })
      ).catch(() => undefined);
      this.setHealth("class_d_notifier", "degraded", (err as Error).message.slice(0, 60));
    }
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
    reason: string
  ): Promise<ToolResult> {
    await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
      writeAudit(client, request.identity, {
        type: "tool.denied", decision: "DENY", reason,
        tool_id: request.tool_id, action: request.action
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tool_timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
