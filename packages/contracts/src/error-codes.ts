import { z } from "zod";

/**
 * WP-DX0 (HF6 §25.3, H6-DX10): FEILKODE-REGISTER. Én stabil identitet per feiltype, slik at fritekst aldri er den eneste feilidentiteten i en korrelasjonskjede, et incident eller et
 * feilfingeravtrykk (§25.5: `fault_fingerprint` er en signatur over `error_code`, komponent og versjon).
 *
 * ATFERDSENDRING: INGEN. Registeret er kontrakt og tabell. Ingen produksjonskode importerer det ennå, og ingen eksisterende årsaksstreng (`class_d_*`, `constitution_*`, `truth_*`, `migration_*` ...) er omdøpt:
 * `legacy` kobler hver gammel streng (slik den lagres i journaler/logger) til sin stabile kode, så en senere diagnostikk-WP (DX1/DX3) kan slå opp uten å røre kilden.
 *
 * NAVNEROM: §25.3 har elleve navnerom-rader; hver rad er ETT navnerom (kodeprefiks = radens deler skilt med understrek, se `ERROR_NAMESPACES`). Hvert eksempel i §25.3 har en kode.
 *
 * STABILITET: en utgitt kode fjernes eller omdøpes aldri (lint-test `error-codes.test.ts` pinner navn + navnerom); en kode som ikke lenger skal brukes får `status: "deprecated"` og peker på `replaced_by`.
 * `owner` er en komponent-id i programindeksen (`config/program/components/`); testen i `program-index-repo.test.ts` sjekker at eieren finnes.
 *
 * Vokabular: `severity` = IncidentSeverity (`modules/incidents`), så en feil kan løftes til en hendelse uten oversettelse. `retryability`:
 *  - `retry_with_backoff`: forbigående; forsøk på nytt med utsettelse er trygt (idempotent).
 *  - `retry_after_fix`: forsøk først etter at en person/operatør har rettet årsaken (ny godkjenning, konfig, tilgang, hemmelighet).
 *  - `readback_first`: ALDRI blind retry - les tilstanden hos leverandør/mål først (utfallet kan være utført; ukjent er ikke feilet).
 *  - `never`: samme forespørsel skal ikke gjentas (avslag, bruddvern, ugyldig input).
 */

export const ERROR_NAMESPACES = Object.freeze(["AUTH_TENANT", "SECRET_IDENTITY", "MODEL_ROUTING", "TOOL_CONNECTOR", "DB_DATA", "WORKER_INFRA", "MEMORY_RETRIEVAL_EXPERT", "LEARNING_EVAL", "VOICE_DEVICE_UI", "FINANCE_SIDE_EFFECT", "SECURITY"] as const);
export type ErrorNamespace = (typeof ERROR_NAMESPACES)[number];

export const ErrorNamespaceSchema = z.enum(ERROR_NAMESPACES);
export const ErrorSeveritySchema = z.enum(["low", "normal", "high", "critical"]);
export type ErrorSeverity = z.infer<typeof ErrorSeveritySchema>;
export const ErrorRetryabilitySchema = z.enum(["retry_with_backoff", "retry_after_fix", "readback_first", "never"]);
export type ErrorRetryability = z.infer<typeof ErrorRetryabilitySchema>;

/** NAMESPACE.NAVN - store bokstaver, tall og understrek; punktum skiller navnerom fra navn. */
export const ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\.[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
/** Komponent-id i programindeksen (`<familie>.<navn>`), samme mønster som `config/program/components/<id>.json`. */
const COMPONENT_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
/** Repo-relativ sti: ingen absolutt sti, ingen `..`, ingen backslash. */
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/;

const LegacyReasonSchema = z
  .object({
    /** Filen som EMITTERER strengen slik den lagres i journal/logg (nøkkelen i oppslaget sammen med `reason`). */
    source: z.string().regex(REPO_PATH),
    /** Strengen slik den lagres (f.eks. `class_d_tenant_mismatch`). */
    reason: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/),
    /** Der strengen er SATT SAMMEN av deler (prefiks + årsak), står literalen i en annen fil: oppgi filen og literalen (driftvakten sjekker dem). */
    defined_in: z.string().regex(REPO_PATH).optional(),
    defined_as: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional()
  })
  .strict()
  .refine((l) => (l.defined_in === undefined) === (l.defined_as === undefined), { message: "defined_in og defined_as hører sammen" });
export type LegacyReason = z.infer<typeof LegacyReasonSchema>;

export const ErrorCodeDefSchema = z
  .object({
    code: z.string().regex(ERROR_CODE_FORMAT),
    namespace: ErrorNamespaceSchema,
    title: z.string().min(3).max(80),
    description: z.string().min(10).max(400),
    /** Komponent-id (programindeksen) som eier feiltypen: den som kan rette den og oppdatere definisjonen. */
    owner: z.string().max(64).regex(COMPONENT_ID),
    severity: ErrorSeveritySchema,
    retryability: ErrorRetryabilitySchema,
    status: z.enum(["active", "deprecated"]),
    replaced_by: z.string().regex(ERROR_CODE_FORMAT).nullable(),
    legacy: z.array(LegacyReasonSchema).readonly()
  })
  .strict()
  .refine((d) => d.code.split(".")[0] === d.namespace, { message: "kodens prefiks må være definisjonens namespace" })
  .refine((d) => (d.status === "deprecated") === (d.replaced_by !== null), { message: "deprecated krever replaced_by; aktiv kode har ingen erstatter" });
export type ErrorCodeDef = z.infer<typeof ErrorCodeDefSchema>;

type L = { source: string; reason: string; defined_in?: string; defined_as?: string };
const POLICY = "modules/policy/src/policy-gateway.ts";
const VERIFIER = "modules/policy/src/approval-verifier.ts";
const INFRA_GATE = "modules/policy/src/infra-execution-gate.ts";
const CONSTITUTION = "modules/self-modification/src/constitution.ts";
const TRUTH = "modules/incidents/src/truth.ts";
const FREEZE = "modules/self-modification/src/evolution/release-gate.ts";
const MIGRATOR = "modules/core/src/db/migrator.ts";
/** Strenger policy-gatewayen lagrer i policy-journalen men som er DEFINERT i en annen fil (`defined_in`/`defined_as`: literalen driftvakten leter etter). */
const viaPolicy = (stored: string, definedIn: string, definedAs: string): L => ({ source: POLICY, reason: stored, defined_in: definedIn, defined_as: definedAs });
/** Godkjenningsavslag lagres av policy-gatewayen som `class_d_<årsak>`; literalen `<årsak>` står i verifisereren. */
const approval = (reason: string): L => viaPolicy(`class_d_${reason}`, VERIFIER, reason);
/** Infra-modus-portens avslag lagres av policy-gatewayen uendret; literalen står i infra-porten. */
const infra = (reason: string): L => viaPolicy(reason, INFRA_GATE, reason);
const at = (source: string, reason: string): L => ({ source, reason });

/** Definisjonene i registeret. `as const` gir en bokstavelig union (`ErrorCode`); `deepFreeze` under gjør det uforanderlig i kjøretid. */
const DEFS = [
  // ---------------------------------------------------------------- AUTH / TENANT
  { code: "AUTH_TENANT.MEMBERSHIP_MISMATCH", namespace: "AUTH_TENANT", title: "Medlemskap stemmer ikke", description: "Personen er ikke medlem av tenanten/rommet handlingen gjelder, eller godkjenningen er utstedt for en annen person.", owner: "core.identity", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("person_mismatch")] },
  { code: "AUTH_TENANT.WRONG_ORG", namespace: "AUTH_TENANT", title: "Feil org/tenant", description: "Handlingen peker på en annen org/tenant enn identiteten eller godkjenningen gjelder (HF3 org_id = repoets tenant_id).", owner: "core.identity", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("tenant_mismatch")] },
  { code: "AUTH_TENANT.DEVICE_REVOKED", namespace: "AUTH_TENANT", title: "Enhet tilbakekalt", description: "Enheten er tilbakekalt (nøkkelen står i revoked_device_keys); ingen signering eller sesjon fra den godtas.", owner: "core.identity", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "AUTH_TENANT.DEVICE_UNKNOWN", namespace: "AUTH_TENANT", title: "Enhet ukjent", description: "Godkjenningen er signert av en enhet som ikke finnes i registeret for denne tenanten (ukjent, tilbakekalt eller feil tenant).", owner: "core.identity", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("unknown_device")] },
  { code: "AUTH_TENANT.POLICY_DENY", namespace: "AUTH_TENANT", title: "Policy avslo handlingen", description: "Policy Gateway avslo handlingen; avslaget er endelig for denne forespørselen (årsaken står i policy-journalen).", owner: "core.policy", severity: "normal", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "AUTH_TENANT.STALE_GRANT", namespace: "AUTH_TENANT", title: "Utløpt eller foreldet tilgang", description: "Sesjonstilgangen (grant) er utløpt eller trukket tilbake; en ny, fersk tilgang må utstedes før handlingen kan prøves igjen.", owner: "core.identity", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "AUTH_TENANT.INVALID_IDENTITY_CONTEXT", namespace: "AUTH_TENANT", title: "Ugyldig identitetskontekst", description: "Identitetskonteksten i forespørselen består ikke kontraktvalideringen; policy avslår alltid ugyldig input (aldri unntak videre opp).", owner: "core.policy", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [at(POLICY, "invalid_identity_context")] },
  { code: "AUTH_TENANT.AUTH_STRENGTH_INSUFFICIENT", namespace: "AUTH_TENANT", title: "For svak autentisering", description: "Klasse B krever aktiv autentisering; en passiv sesjon utenfor suveren eier-modus avslås til sesjonen er trappet opp.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(POLICY, "class_b_requires_active_auth")] },
  { code: "AUTH_TENANT.NO_MANDATE", namespace: "AUTH_TENANT", title: "Mangler mandat", description: "Klasse C-handlingen er ikke dekket av et mandat (verktøy:handling) og identiteten er ikke suveren eier.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(POLICY, "class_c_no_mandate")] },
  { code: "AUTH_TENANT.KILL_SWITCH_ACTIVE", namespace: "AUTH_TENANT", title: "Kill switch er aktiv", description: "Eierens kill switch er aktiv: alt unntatt de navngitte selvgjenopprettingshandlingene avslås inntil eieren deaktiverer den.", owner: "core.policy", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(POLICY, "kill_switch_active"), at(FREEZE, "kill_switch_active")] },
  { code: "AUTH_TENANT.APPROVAL_MISSING", namespace: "AUTH_TENANT", title: "Signert godkjenning mangler", description: "Klasse D-handlingen krever et signert godkjenningsobjekt og ingen fulgte med forespørselen.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(POLICY, "class_d_missing_approval")] },
  { code: "AUTH_TENANT.APPROVAL_MALFORMED", namespace: "AUTH_TENANT", title: "Godkjenningsobjektet er ugyldig", description: "Godkjenningsobjektet består ikke strukturvalideringen (SignedApprovalSchema) og kan ikke verifiseres.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [approval("malformed_approval")] },
  { code: "AUTH_TENANT.APPROVAL_EXPIRED", namespace: "AUTH_TENANT", title: "Godkjenningen er utløpt", description: "Godkjenningen er utløpt eller har en levetid over taket (TTL); en ny godkjenning må signeres.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [approval("expired"), approval("ttl_exceeded")] },
  { code: "AUTH_TENANT.APPROVAL_NOT_YET_VALID", namespace: "AUTH_TENANT", title: "Godkjenningen er utstedt i fremtiden", description: "Utstedelsestidspunktet ligger i fremtiden utover tillatt klokkeavvik; sjekk klokkesynk på enheten som signerte.", owner: "core.policy", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [approval("issued_in_future")] },
  { code: "AUTH_TENANT.APPROVAL_BINDING_MISMATCH", namespace: "AUTH_TENANT", title: "Godkjenningen gjelder noe annet", description: "Godkjenningen er bundet til et annet verktøy, en annen handling eller andre parametere enn de som ble forsøkt utført.", owner: "core.policy", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("tool_mismatch"), approval("action_mismatch"), approval("parameters_mismatch")] },
  { code: "AUTH_TENANT.APPROVAL_REPLAYED", namespace: "AUTH_TENANT", title: "Godkjenningen er allerede brukt", description: "Engangs-ID-en (nonce) i godkjenningen er allerede forbrukt: replay-vernet avslår gjenbruk.", owner: "core.policy", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [at(POLICY, "class_d_nonce_already_used")] },
  { code: "AUTH_TENANT.APPROVER_NOT_AUTHORIZED", namespace: "AUTH_TENANT", title: "Godkjenneren har ikke myndighet", description: "Den som signerte er ikke eier, eller godkjennerens identitet stemmer ikke med enheten som signerte.", owner: "core.policy", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("approver_not_owner"), approval("approver_mismatch")] },

  // ---------------------------------------------------------------- SECRET / IDENTITY
  { code: "SECRET_IDENTITY.TOKEN_EXPIRED", namespace: "SECRET_IDENTITY", title: "Token utløpt", description: "Leverandørtoken eller OAuth-tilgang er utløpt; fornyelse eller ny samtykkerunde kreves før kallet kan gjentas.", owner: "core.tool-gateway", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "SECRET_IDENTITY.VAULT_LOOKUP_FAILED", namespace: "SECRET_IDENTITY", title: "Hvelvoppslag feilet", description: "Oppslaget mot hemmelighetshvelvet feilet; hemmeligheten ble ikke levert. Aldri en reservehemmelighet.", owner: "core.tool-gateway", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "SECRET_IDENTITY.PROVIDER_VERIFICATION_FAILED", namespace: "SECRET_IDENTITY", title: "Leverandørverifisering feilet", description: "Leverandøren avviste identiteten eller signaturen (webhook, API-nøkkel, enhetsattest); kallet er ikke autentisert.", owner: "core.tool-gateway", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "SECRET_IDENTITY.MISSING_SCOPE", namespace: "SECRET_IDENTITY", title: "Manglende scope", description: "Tilkoblingen mangler et påkrevd scope/tillatelse hos leverandøren; scope må utvides og samtykkes før handlingen kan utføres.", owner: "core.tool-gateway", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "SECRET_IDENTITY.SIGNATURE_INVALID", namespace: "SECRET_IDENTITY", title: "Signaturen er ugyldig", description: "Den kryptografiske signaturen på godkjenningsobjektet verifiserer ikke mot enhetens registrerte nøkkel.", owner: "core.policy", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [approval("invalid_signature")] },

  // ---------------------------------------------------------------- MODEL / ROUTING
  { code: "MODEL_ROUTING.PROVIDER_TIMEOUT", namespace: "MODEL_ROUTING", title: "Modelleverandør tidsavbrudd", description: "Modelleverandøren svarte ikke innen fristen; ruteren kan prøve neste kandidat i kjeden.", owner: "core.model-gateway", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "MODEL_ROUTING.MALFORMED_OUTPUT", namespace: "MODEL_ROUTING", title: "Ugyldig modellutdata", description: "Modellens utdata følger ikke den forventede strukturen (JSON/skjema); utdata er data, aldri en instruksjon.", owner: "core.model-gateway", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "MODEL_ROUTING.TOOL_SELECTION_FAILED", namespace: "MODEL_ROUTING", title: "Verktøyvalg feilet", description: "Modellen valgte ikke et gyldig verktøy for oppgaven (ukjent verktøy, ugyldige argumenter eller ikke tillatt for flaten).", owner: "core.model-gateway", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "MODEL_ROUTING.CONTEXT_OVERFLOW", namespace: "MODEL_ROUTING", title: "Kontekst for stor", description: "Konteksten overstiger modellens vindu eller budsjettgrensen; konteksten må kuttes eller en annen modell velges.", owner: "core.model-gateway", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "MODEL_ROUTING.QUALITY_REGRESSION", namespace: "MODEL_ROUTING", title: "Kvalitetsregresjon", description: "Benchmark eller drift viser dårligere kvalitet for ruten enn baseline; ruten må tilbakerulles eller fryses.", owner: "core.model-gateway", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },

  // ---------------------------------------------------------------- TOOL / CONNECTOR
  { code: "TOOL_CONNECTOR.API_CLIENT_ERROR", namespace: "TOOL_CONNECTOR", title: "Leverandør-API avviste kallet (4xx)", description: "Leverandøren svarte 4xx (ikke rate limit): forespørselen er feil eller ikke tillatt og endres ikke av et nytt forsøk.", owner: "core.tool-gateway", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.API_SERVER_ERROR", namespace: "TOOL_CONNECTOR", title: "Leverandør-API-feil (5xx)", description: "Leverandøren svarte 5xx eller falt ut midt i kallet; for en mutasjon er utfallet UKJENT inntil det er lest tilbake.", owner: "core.tool-gateway", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.RATE_LIMITED", namespace: "TOOL_CONNECTOR", title: "Ratebegrenset", description: "Leverandøren (eller Jarvis' egen grense) begrenset kallet; forsøk igjen etter Retry-After/utsettelse.", owner: "core.tool-gateway", severity: "low", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.SCHEMA_DRIFT", namespace: "TOOL_CONNECTOR", title: "Leverandørskjema har endret seg", description: "Leverandørens svar avviker fra kontrakten (felt mangler eller har ny form); transporten svikter lukket i stedet for å gjette.", owner: "core.tool-gateway", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.IDEMPOTENCY_REPLAY", namespace: "TOOL_CONNECTOR", title: "Idempotensnøkkel er brukt", description: "Samme idempotensnøkkel er allerede utført eller pågår; les det tidligere utfallet i stedet for å sende på nytt.", owner: "core.tool-gateway", severity: "normal", retryability: "readback_first", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.WRONG_TARGET_READBACK", namespace: "TOOL_CONNECTOR", title: "Tilbakelesing viser feil mål", description: "Etter mutasjonen viser readback et annet mål/en annen tilstand enn forventet; handlingen må vurderes og evt. rettes manuelt.", owner: "core.tool-gateway", severity: "high", retryability: "readback_first", status: "active", replaced_by: null, legacy: [] },
  { code: "TOOL_CONNECTOR.INVALID_TOOL_CALL", namespace: "TOOL_CONNECTOR", title: "Ugyldig verktøykall", description: "Verktøykallet består ikke kontraktvalideringen (ToolCallSchema); policy avslår alltid ugyldig input.", owner: "core.tool-gateway", severity: "normal", retryability: "never", status: "active", replaced_by: null, legacy: [at(POLICY, "invalid_tool_call")] },
  { code: "TOOL_CONNECTOR.CONNECTOR_FROZEN", namespace: "TOOL_CONNECTOR", title: "Connector er frosset", description: "Eieren har frosset connectoren (durabelt register); alle kall mot den avslås til eieren opphever frysen.", owner: "core.owner-controls", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(POLICY, "connector_frozen")] },

  // ---------------------------------------------------------------- DB / DATA
  { code: "DB_DATA.RLS_DENY", namespace: "DB_DATA", title: "Radnivåsikkerhet avslo", description: "Databasens RLS-policy ga ingen rader eller avviste skrivingen: tenant-/romkonteksten dekker ikke raden.", owner: "core.db-foundation", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.MIGRATION_MISMATCH", namespace: "DB_DATA", title: "Migrasjon avviker fra anvendt skjema", description: "En allerede anvendt migrasjonsfil er endret (sjekksum stemmer ikke): lag en NY migrasjon i stedet; oppstart feiler høyt.", owner: "core.db-foundation", severity: "critical", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(MIGRATOR, "migration_checksum_mismatch")] },
  { code: "DB_DATA.MIGRATION_SET_INVALID", namespace: "DB_DATA", title: "Migrasjonssettet er ugyldig", description: "En .sql-fil følger ikke NNN_navn.sql eller to filer har samme prefiks (tvetydig rekkefølge); migratoren nekter å kjøre.", owner: "core.db-foundation", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(MIGRATOR, "migration_file_name_invalid"), at(MIGRATOR, "migration_prefix_duplicate")] },
  { code: "DB_DATA.MIGRATION_CREDENTIALS_MISSING", namespace: "DB_DATA", title: "Admin-legitimasjon for migrasjon mangler", description: "Migratoren fikk ikke databasens admin-legitimasjon; migrasjoner kjøres kun av migrate-tjenesten, aldri av api/worker.", owner: "core.db-foundation", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(MIGRATOR, "migration_admin_credentials_missing")] },
  { code: "DB_DATA.STALE_DATA", namespace: "DB_DATA", title: "Foreldet data", description: "Raden eller avledningen er eldre enn kilden/frisken kreves (optimistisk konflikt, utløpt cache); les på nytt og vurder på nytt.", owner: "core.db-foundation", severity: "low", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.DUPLICATE_DATA", namespace: "DB_DATA", title: "Duplikatdata", description: "Samme logiske rad finnes allerede (unikhetsbrudd eller dedupe-treff); les eksisterende rad før en ny skriving vurderes.", owner: "core.db-foundation", severity: "low", retryability: "readback_first", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.CORRUPT_DATA", namespace: "DB_DATA", title: "Korrupte data", description: "Lagrede data bryter en invariant (sjekksum, hash-kjede, skjema); lesing stoppes og saken løftes som hendelse.", owner: "core.db-foundation", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.CONSTRAINT_VIOLATION", namespace: "DB_DATA", title: "Skjemabegrensning brutt", description: "Skrivingen bryter en CHECK-/FK-/NOT NULL-begrensning; inndata er ugyldig og endres ikke av et nytt forsøk.", owner: "core.db-foundation", severity: "normal", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.DEADLOCK", namespace: "DB_DATA", title: "Vranglås eller serialiseringsfeil", description: "Transaksjonen ble avbrutt av databasen (deadlock/serialiseringsfeil); en ren retry av hele transaksjonen er trygg.", owner: "core.db-foundation", severity: "low", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "DB_DATA.NONCE_STORE_ERROR", namespace: "DB_DATA", title: "Nonce-lager feilet", description: "Lageret for engangs-ID-er (replay-vern) feilet; policy avslår lukket (usikkerhet gir aldri tillatelse).", owner: "core.policy", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [at(POLICY, "class_d_nonce_store_error")] },
  { code: "DB_DATA.TRUTH_REGIME_INVALID_INPUT", namespace: "DB_DATA", title: "Ugyldig sannhetsinput", description: "Sannhetsregimet (hendelsesbevis) fikk en ukjent påstander, verifiserer, status eller diagnosekilde og avviste skrivingen.", owner: "ua.incidents", severity: "normal", retryability: "never", status: "active", replaced_by: null, legacy: [at(TRUTH, "truth_unknown_asserter"), at(TRUTH, "truth_unknown_status"), at(TRUTH, "truth_unknown_verifier"), at(TRUTH, "truth_unknown_diagnosis_source")] },
  { code: "DB_DATA.TRUTH_BASIS_REQUIRED", namespace: "DB_DATA", title: "Verifisering mangler grunnlag", description: "VERIFIED krever et deterministisk grunnlag (eller verifisert evidens bak diagnosen); en påstand uten grunnlag forblir UNVERIFIED.", owner: "ua.incidents", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(TRUTH, "truth_verified_requires_deterministic_basis"), at(TRUTH, "truth_verification_basis_required"), at(TRUTH, "truth_verified_diagnosis_needs_verified_evidence")] },

  // ---------------------------------------------------------------- WORKER / INFRA
  { code: "WORKER_INFRA.CRASH_LOOP", namespace: "WORKER_INFRA", title: "Krasjløkke", description: "Prosessen eller containeren restarter gjentatte ganger uten å bli frisk; automatisk restart hjelper ikke.", owner: "core.watchdog", severity: "critical", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.OOM", namespace: "WORKER_INFRA", title: "Tom for minne", description: "Prosessen ble drept av minnegrensen (OOM); jobben må kjøres med mindre last eller større grense.", owner: "core.watchdog", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.DISK_FULL", namespace: "WORKER_INFRA", title: "Disk full", description: "Lagringen er full eller under terskel (EV-16-prognose); skriving stoppes, og opprydding eller utvidelse kreves.", owner: "core.watchdog", severity: "critical", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.QUEUE_LEASE_LOST", namespace: "WORKER_INFRA", title: "Køleasen er tapt", description: "Arbeideren mistet leasen på jobben (tidsavbrudd/restart); jobben gjenopptas av en annen arbeider, så skriving må være idempotent.", owner: "core.tasks", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.HOST_UNREACHABLE", namespace: "WORKER_INFRA", title: "Vert utilgjengelig", description: "Verten (NAS/GCE/Docker-målet) svarer ikke på kontrollkanalen; infrastrukturhandlinger mot den utsettes.", owner: "ua.incidents", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.NETWORK_FAILURE", namespace: "WORKER_INFRA", title: "Nettverksfeil", description: "Forbindelsen feilet (tilbakestilt, tidsavbrudd, ruting); for en mutasjon er utfallet UKJENT inntil det er lest tilbake.", owner: "ua.incidents", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.DNS_FAILURE", namespace: "WORKER_INFRA", title: "DNS-feil", description: "Navneoppslag feilet eller ga uventet svar; kallet er ikke utført.", owner: "ua.incidents", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.TUNNEL_DOWN", namespace: "WORKER_INFRA", title: "Tunnel nede", description: "Tunnelen (edge/egress) mellom Jarvis og omverdenen er nede; innkommende og utgående trafikk via den stopper.", owner: "ua.incidents", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "WORKER_INFRA.INFRA_MODE_PAUSED", namespace: "WORKER_INFRA", title: "Infra-modus er pauset", description: "Infrastrukturhandlinger er pauset av eier/kill switch (modus PAUSED); alle infra-mutasjoner avslås.", owner: "core.policy", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [infra("infra_paused")] },
  { code: "WORKER_INFRA.INFRA_DEGRADED_BLOCKS_CLASS_D", namespace: "WORKER_INFRA", title: "Degradert infra-modus blokkerer klasse D", description: "Infra-modus er DEGRADED: klasse D-infrahandlinger avslås mens lavere klasser kan gå.", owner: "core.policy", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [infra("infra_degraded_blocks_class_d")] },
  { code: "WORKER_INFRA.INFRA_MODE_UNAVAILABLE", namespace: "WORKER_INFRA", title: "Infra-modus kan ikke leses", description: "Den delte infra-modusen kunne ikke leses fra databasen; mutasjon avslås lukket (aldri en antatt NORMAL).", owner: "core.policy", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [infra("infra_mode_unavailable")] },
  { code: "WORKER_INFRA.STATE_UNKNOWN", namespace: "WORKER_INFRA", title: "Tilstand kunne ikke måles", description: "Et innsignal (kill switch, hendelsestilstand) kunne ikke måles; ukjent er ikke OK og utelukker ikke change freeze.", owner: "ev.evolution-gates", severity: "high", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [at(FREEZE, "kill_switch_unknown"), at(FREEZE, "incident_state_unknown")] },
  { code: "WORKER_INFRA.OBSERVABILITY_MISSING", namespace: "WORKER_INFRA", title: "Observerbarhet mangler", description: "SLO-/telemetri-grunnlaget mangler eller er ikke friskt; uten måling kan endringsfrys ikke utelukkes.", owner: "ev.evolution-gates", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(FREEZE, "observability_missing")] },
  { code: "WORKER_INFRA.INCIDENT_OPEN", namespace: "WORKER_INFRA", title: "Åpen hendelse", description: "En uløst hendelse er åpen; endringer fryses til hendelsen er lukket.", owner: "ev.evolution-gates", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(FREEZE, "incident_open")] },
  { code: "WORKER_INFRA.SLO_BREACHED", namespace: "WORKER_INFRA", title: "SLO brutt", description: "Minst ett SLO-mål er brutt i vinduet; endringer fryses til målingen er innenfor grensen.", owner: "ev.evolution-gates", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(FREEZE, "slo_breached")] },

  // ---------------------------------------------------------------- MEMORY / RETRIEVAL / EXPERT
  { code: "MEMORY_RETRIEVAL_EXPERT.MISSING_SOURCE", namespace: "MEMORY_RETRIEVAL_EXPERT", title: "Kilden mangler", description: "Påstanden eller minnet kan ikke spores til en kilde (eier-ytring, dokument); uten kilde brukes det ikke som betrodd.", owner: "core.memory", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "MEMORY_RETRIEVAL_EXPERT.STALE_PACK", namespace: "MEMORY_RETRIEVAL_EXPERT", title: "Foreldet ekspertpakke", description: "Ekspertpakken er eldre enn ferskhetskravet; bruk krever fornyelse eller eksplisitt akseptert alder.", owner: "ex.expert-registry", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "MEMORY_RETRIEVAL_EXPERT.EXPERT_RECALLED", namespace: "MEMORY_RETRIEVAL_EXPERT", title: "Ekspert tilbakekalt", description: "Ekspertversjonen er tilbakekalt (provenance/rettigheter/forurensning); alt som avhenger av den må blokkeres.", owner: "ex.expert-registry", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "MEMORY_RETRIEVAL_EXPERT.RETRIEVAL_CONTAMINATION", namespace: "MEMORY_RETRIEVAL_EXPERT", title: "Forurenset gjenfinning", description: "Gjenfunnet innhold er forurenset (injeksjon, feil rom/tenant eller forgiftet kilde) og slippes ikke inn i konteksten.", owner: "core.memory", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },

  // ---------------------------------------------------------------- LEARNING / EVAL
  { code: "LEARNING_EVAL.BAD_CANDIDATE", namespace: "LEARNING_EVAL", title: "Dårlig læringskandidat", description: "Kandidaten (metode/skill) består ikke evalueringen eller sikkerhetskravene og promoteres aldri.", owner: "ci.skill-learning", severity: "normal", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "LEARNING_EVAL.HOLDOUT_REGRESSION", namespace: "LEARNING_EVAL", title: "Regresjon på skjult holdout", description: "Kandidaten presterer dårligere enn baseline på det skjulte holdout-settet; promotering blokkeres.", owner: "ev.eval-lab", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "LEARNING_EVAL.POISONED_EVIDENCE", namespace: "LEARNING_EVAL", title: "Forgiftet evidens", description: "Læringsevidensen er forgiftet eller manipulert (repetisjon fra én kilde, injisert innhold); alt avledet må ugyldiggjøres.", owner: "ci.experience-ledger", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "LEARNING_EVAL.SKILL_DRIFT", namespace: "LEARNING_EVAL", title: "Ferdighetsdrift", description: "En lært metode presterer dårligere over tid eller etter modell-/kontraktbytte; den må re-evalueres.", owner: "ci.skill-learning", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "LEARNING_EVAL.EVAL_LEAKAGE", namespace: "LEARNING_EVAL", title: "Eval-lekkasje", description: "Evalueringssettet (holdout) har lekket inn i trening/øving eller kandidaten; resultatet er ugyldig.", owner: "ev.eval-lab", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },

  // ---------------------------------------------------------------- VOICE / DEVICE / UI
  { code: "VOICE_DEVICE_UI.STT_FAILURE", namespace: "VOICE_DEVICE_UI", title: "Talegjenkjenning feilet", description: "STT-adapteren feilet eller ga ikke brukbar tekst; samtalen fortsetter ikke på gjetning.", owner: "core.voice-gateway", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "VOICE_DEVICE_UI.TTS_FAILURE", namespace: "VOICE_DEVICE_UI", title: "Talesyntese feilet", description: "TTS-adapteren feilet; svaret leveres som tekst eller på nytt etter utsettelse.", owner: "core.voice-gateway", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "VOICE_DEVICE_UI.APNS_FAILURE", namespace: "VOICE_DEVICE_UI", title: "APNs-levering feilet", description: "Push til iPhone/Watch feilet (ugyldig token, avvist, tidsavbrudd); varselet er ikke levert.", owner: "client.mobile", severity: "normal", retryability: "retry_with_backoff", status: "active", replaced_by: null, legacy: [] },
  { code: "VOICE_DEVICE_UI.DEVICE_STATE_INVALID", namespace: "VOICE_DEVICE_UI", title: "Ugyldig enhetstilstand", description: "Enhetens tilstand (sesjon, kanal, innrulling) passer ikke forespørselen; enheten må rulles inn eller sesjonen fornyes.", owner: "core.identity", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "VOICE_DEVICE_UI.CALL_PROVIDER_FAILURE", namespace: "VOICE_DEVICE_UI", title: "Telefonileverandør feilet", description: "Samtaleleverandøren (telefoni) feilet midt i oppringing/overføring; en samtale kan ha blitt satt opp, så les status først.", owner: "ua.comms", severity: "high", retryability: "readback_first", status: "active", replaced_by: null, legacy: [] },
  { code: "VOICE_DEVICE_UI.CLIENT_MISMATCH", namespace: "VOICE_DEVICE_UI", title: "Klientversjon passer ikke", description: "Klienten (web/mobil) snakker en kontraktversjon serveren ikke støtter; klienten må oppdateres.", owner: "core.api", severity: "normal", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },

  // ---------------------------------------------------------------- FINANCE / SIDE_EFFECT
  { code: "FINANCE_SIDE_EFFECT.RECONCILIATION_MISMATCH", namespace: "FINANCE_SIDE_EFFECT", title: "Avstemmingsavvik", description: "Banken/leverandøren og Jarvis' intensjoner stemmer ikke (beløp, mottaker eller tilstand); avviket flagges og ingenting rettes stille.", owner: "ua.finance", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [] },
  { code: "FINANCE_SIDE_EFFECT.DUPLICATE_INTENT", namespace: "FINANCE_SIDE_EFFECT", title: "Duplikat betalingsintensjon", description: "En identisk betalings-/utgiftsintensjon finnes allerede; en ny sending kan gi dobbel betaling og avslås.", owner: "ua.finance", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "FINANCE_SIDE_EFFECT.RECIPIENT_MISMATCH", namespace: "FINANCE_SIDE_EFFECT", title: "Mottaker stemmer ikke", description: "Mottakeren ved leverandøren avviker fra den godkjente intensjonen; handlingen stoppes før eller etter utførelse og eskaleres.", owner: "ua.finance", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "FINANCE_SIDE_EFFECT.PROVIDER_STATE_AMBIGUOUS", namespace: "FINANCE_SIDE_EFFECT", title: "Leverandørtilstand uklar", description: "Leverandørens tilstand for en pengehandling er uklar (utfall ukjent); ALDRI blind retry - les status hos leverandøren først.", owner: "ua.finance", severity: "critical", retryability: "readback_first", status: "active", replaced_by: null, legacy: [] },

  // ---------------------------------------------------------------- SECURITY
  { code: "SECURITY.PROMPT_INJECTION", namespace: "SECURITY", title: "Prompt-injeksjon", description: "Ubetrodd innhold (e-post, web, verktøyutdata) forsøkte å fungere som instruksjon; innholdet er data og er karantenesatt.", owner: "core.tool-gateway", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "SECURITY.EXFILTRATION_ATTEMPT", namespace: "SECURITY", title: "Forsøk på datalekkasje", description: "En handling forsøkte å sende data ut av tillatt grense (verter, mottakere, begrenset innhold til sky); stoppet og logget.", owner: "core.tool-gateway", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "SECURITY.TAMPER_DETECTED", namespace: "SECURITY", title: "Manipulasjon oppdaget", description: "Et signert eller hash-sikret artefakt er endret, svekket eller rullet tilbake (signatur, nøkkel, versjon); stol ikke på det.", owner: "ev.safety-constitution", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [at(CONSTITUTION, "constitution_signature_invalid"), at(CONSTITUTION, "constitution_key_mismatch"), at(CONSTITUTION, "constitution_weakened"), at(CONSTITUTION, "constitution_rollback")] },
  { code: "SECURITY.CROSS_TENANT_ESCAPE", namespace: "SECURITY", title: "Brudd på tenantisolasjon", description: "Data eller handling krysset en tenant-/romgrense (lesing, skriving eller læring på tvers); sikkerhetshendelse.", owner: "core.db-foundation", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "SECURITY.SUSPICIOUS_SELF_CHANGE", namespace: "SECURITY", title: "Mistenkelig selvendring", description: "Jarvis (eller en modell) forsøkte en endring av egen kode/konfig/policy utenfor tillatte stier eller uten godkjenning.", owner: "ev.self-modification", severity: "critical", retryability: "never", status: "active", replaced_by: null, legacy: [] },
  { code: "SECURITY.CONSTITUTION_NOT_VERIFIED", namespace: "SECURITY", title: "Konstitusjonen er ikke verifisert", description: "Safety Constitution mangler, er usignert, eller nøkkelen er ikke festet; selvendring forblir frosset til eieren har signert.", owner: "ev.safety-constitution", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(CONSTITUTION, "constitution_missing"), at(CONSTITUTION, "constitution_unsigned"), at(CONSTITUTION, "constitution_key_not_pinned"), at("apps/api/src/ev0-boot.ts", "constitution_load_failed")] },
  { code: "SECURITY.CONSTITUTION_INVALID", namespace: "SECURITY", title: "Konstitusjonen er ugyldig", description: "Konstitusjonsmanifestet består ikke skjema- eller nøkkelvalideringen; det brukes ikke.", owner: "ev.safety-constitution", severity: "high", retryability: "retry_after_fix", status: "active", replaced_by: null, legacy: [at(CONSTITUTION, "constitution_invalid")] },
  { code: "SECURITY.TRUTH_REGIME_MODEL_ESCALATION", namespace: "SECURITY", title: "Modell forsøkte å heve bevisstatus", description: "En modell forsøkte å heve status på egen evidens eller verifisere den; kun deterministisk grunnlag kan gi VERIFIED.", owner: "ua.incidents", severity: "high", retryability: "never", status: "active", replaced_by: null, legacy: [at(TRUTH, "truth_model_cannot_raise_status"), at(TRUTH, "truth_model_evidence_cannot_be_verified")] }
] as const satisfies readonly z.input<typeof ErrorCodeDefSchema>[];

export type ErrorCode = (typeof DEFS)[number]["code"];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Alle definisjoner (uforanderlige), i navnerom-rekkefølge. */
export const ERROR_CODE_DEFS: readonly ErrorCodeDef[] = deepFreeze(DEFS.map((d) => ({ ...d, legacy: d.legacy.map((l) => ({ ...l })) })) as unknown as ErrorCodeDef[]);

/** kode -> definisjon (uforanderlig). */
export const ERROR_CODES = deepFreeze(Object.fromEntries(ERROR_CODE_DEFS.map((d) => [d.code, d])) as Readonly<Record<ErrorCode, ErrorCodeDef>>);

const LEGACY_INDEX: ReadonlyMap<string, ErrorCode> = new Map(ERROR_CODE_DEFS.flatMap((d) => d.legacy.map((l) => [`${l.source}\u0000${l.reason}`, d.code as ErrorCode] as const)));

/** Er verdien en registrert feilkode? (Prototype-nøkler som `constructor` og `__proto__` er det aldri.) */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** Definisjonen for en kode. Kaster for en ukjent kode (aldri `undefined` som kan misbrukes). */
export function errorCodeInfo(code: ErrorCode): ErrorCodeDef {
  if (!isErrorCode(code)) throw new Error("unknown_error_code");
  return ERROR_CODES[code];
}

/**
 * Slår opp den stabile koden for en gammel årsaksstreng slik den lagres i journal/logg (`source` = filen som emitterer den, `reason` = strengen). `null` for alt ukjent: aldri en gjetning.
 * Ren tabell - ingen atferdsendring i kilden.
 */
export function errorCodeForLegacy(source: string, reason: string): ErrorCode | null {
  return LEGACY_INDEX.get(`${source}\u0000${reason}`) ?? null;
}
