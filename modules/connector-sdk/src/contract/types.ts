import type { JsonValue, TrustLevel } from "@jarvis/contracts";
import type { HealthState } from "../health-state.ts";
import type { VirtualClock } from "./clock.ts";

/**
 * WP-I (D-472): PORTEN en connector eksponerer for kontraktstest-kittet (`runConnectorContract`). Den modellerer connectoren SLIK JARVIS KJØRER DEN (ToolGateway + transport): idempotens-ledger,
 * parametervalidering, autoritet, pause/tilbakekall, tidsavbrudd, helsetilstand, revisjon og klasse D-varsling - uten database og uten nettverk. Feilkategoriene og helsetilstandene speiler
 * det kjøretiden allerede bruker (`HealthState` i Integrasjonssenteret, `FailureCategory`/`classifyFailureReason`, `ToolGateway.health`), så en connector ikke trenger en ny ordbok.
 *
 * Kittet kan kjøres mot (1) en FAKE bygget av `createFakeConnector` (ingen nettverk), og i prinsippet (2) en ekte transport bak en fake leverandørserver - den broen er DEFERRED (se runbook).
 *
 * ÆRLIG OM HVA «MODELLERT» BESKRIVER (review N2): kontrakten her er STRENGERE enn dagens kjøretid på idempotens. ToolGateway-ledgeren (`tool_executions`, migrasjon 010) er nøklet på idempotensnøkkelen ALENE:
 * PRIMARY KEY (tenant_id, idempotency_key), og `gateway.ts` (ledger-blokken rundt `INSERT ... ON CONFLICT DO NOTHING`, ca. 958-983) svarer med det LAGREDE resultatet som `deduplicated: true` også når samme nøkkel gjenbrukes
 * med en ANNEN nyttelast eller handling - aldri en konflikt. Nøkkelkravet håndheves bare for styrt klasse D (`class_d_idempotency_key_required`, ca. 859-862); for andre handlinger som manifestet kaller `required` (send/pay)
 * betyr manglende nøkkel at ingen ledger brukes. Finans håndhever nyttelast-konflikt på DOMENEsiden (`IdempotencyKeyConflictError`, `finance/service.ts` ca. 415-426), ikke i gatewayen. Kittet og fakeen krever derimot
 * `conflict` ved nøkkelgjenbruk med annen nyttelast (`idempotency.key_reuse_other_payload`) og `idempotency_key_required` for hver påkrevd skriving (`idempotency.required_key_enforced`). `modelled` betyr derfor «den ØNSKEDE
 * kontrakten er konsistent og kittet kan felle brudd», IKKE «kjøretiden gjør dette i dag». Den utsatte transport-broen (`adapter_kind: real_transport`) vil feile de to sjekkene på selve gatewayen til en kjøretids-oppfølging
 * finnes (runbook §5/§11) - det er et funn i gatewayen, ikke en connector-defekt. WP-I endrer ingen kjøretidskode.
 */

export type { HealthState, JsonValue, TrustLevel };

/** Speiler `FailureCategory` (Integrasjonssenteret) + de avvisningsårsakene gatewayen selv gir. */
export type ErrorCategory = "auth" | "rate_limit" | "timeout" | "network" | "not_found" | "invalid_input" | "authority" | "paused" | "conflict" | "policy" | "other";

/**
 * Hva slags adapter kittet kjørte mot (review M4). `fake_from_manifest` = en fake bygget av manifestet selv (`createFakeConnector`): den beviser at manifestets garantier er konsistente og at kittet
 * fanger brudd, men sier INGENTING om en ekte transport (kontrakten er modellert ut fra samme manifest den testes mot). `real_transport` er reservert for en bro som kjører en EKTE transport bak en
 * fake leverandørserver (DEFERRED). Kun `real_transport` kan gi akseptansestatus `proven`; en fake gir høyst `modelled`.
 *
 * Review N3: feltet alene er en PÅSTAND og kan kopieres (`{ ...fake, adapter_kind: "real_transport" }`). `runConnectorContract` honorerer derfor `real_transport` kun for et objekt som er merket med den modul-private
 * branden i `provenance.ts` (ikke eksportert fra noen inngang) - til broen finnes er ingen adapter merket, og ingenting kan gi `proven`.
 */
export type AdapterKind = "fake_from_manifest" | "real_transport";

export interface AdapterIdentity {
  tenant_id: string;
  person_id: string;
  /** En delegert identitet (agent/jobb på vegne av eieren) i stedet for den autentiserte eieren. */
  delegated?: boolean;
  /** Delegaten har en signert godkjenning for akkurat dette kallet (kun relevant når manifestet krever godkjenning). */
  approved?: boolean;
}

export interface AdapterRequest {
  /** `tool_id.action` */
  action: string;
  parameters: Record<string, JsonValue>;
  idempotency_key?: string;
  identity: AdapterIdentity;
  /** Avbrytes ved tidsavbrudd; connectoren SKAL slutte å arbeide og svare `timeout`. */
  signal?: AbortSignal;
}

export interface AdapterError {
  category: ErrorCategory;
  /** Stabil, maskinlesbar kode (`idempotency_key_required`, `outcome_unknown`, `credential_revoked` ...). */
  code: string;
  /** Redaksjonssikker tekst (aldri credential, aldri hemmelighetsformede verdier). */
  message: string;
  retryable: boolean;
}

export interface AdapterEvidence {
  before: JsonValue | null;
  after: JsonValue | null;
}

export type AdapterResult =
  | { ok: true; data: JsonValue; external_id?: string; deduplicated: boolean; output_trust: TrustLevel; evidence?: AdapterEvidence; notified?: boolean }
  | { ok: false; error: AdapterError };

export interface AdapterHealth {
  state: HealthState;
  /** ISO-tidspunkt fra den injiserte klokken. */
  at: string;
  detail?: string;
}

export interface ConnectorAdapter {
  readonly connector_id: string;
  /** Handlingsnøklene (`tool_id.action`) adapteren faktisk kan utføre. */
  readonly actions: readonly string[];
  invoke(request: AdapterRequest): Promise<AdapterResult>;
  health(): AdapterHealth | null;
}

/** Feil leverandøren (eller nettverket) kan påføre - settes av kittet via `injectFault`. */
export type Fault =
  | { kind: "auth" }
  | { kind: "rate_limit" }
  | { kind: "network" }
  | { kind: "server" }
  | { kind: "not_found" }
  | { kind: "invalid" }
  /** Leverandøren er treg: `before` = forsinkelsen kommer FØR effekten (ingenting skjer hvis kallet avbrytes), `after` = effekten er utført men svaret kommer sent (utfallet er UKJENT for kalleren). */
  | { kind: "slow"; ms: number; effect: "before" | "after" };

export interface ProviderState {
  [key: string]: JsonValue;
}

/** Testkroker kittet trenger for å bevise egenskapene (en fake implementerer dem; en ekte transport ville fått dem fra en fake leverandørserver). */
export interface ContractControls {
  /** Proveniens for beviset (review M4/N3): en fake bygget fra manifestet, eller en ekte transport. Feltet er en påstand: `real_transport` teller kun for en merket adapter (`provenance.ts`); ukjent/manglende/ikke-merket regnes som `fake_from_manifest`. */
  readonly adapter_kind: AdapterKind;
  readonly clock: VirtualClock;
  injectFault(fault: Fault | null): void;
  /** Antall leverandør-side effekter (kjøringer av en skrivehandling) - per handling eller totalt. */
  effects(actionKey?: string): number;
  /** Antall kall som faktisk nådde leverandøren (for å bevise at ugyldige kall aldri gjorde det). */
  providerCalls(): number;
  setPaused(paused: boolean): void;
  setCredentialRevoked(revoked: boolean): void;
  /** Tekst skrevet av en tredjepart som leverandøren returnerer (og siterer i feilmeldinger). `null` fjerner den. */
  seedProviderText(text: string | null): void;
  /** Utfører den deklarerte kompensasjonen for et tidligere utført kall (identifisert ved idempotensnøkkelen). */
  compensate(actionKey: string, idempotencyKey: string): Promise<{ restored: boolean; reason?: string }>;
  /** Leverandør-side tilstand (for å sammenligne før handling og etter kompensasjon). */
  snapshot(): JsonValue;
  readonly observed: { logs: string[]; audit: string[]; notifications: string[] };
  /** Den (falske) credential-verdien adapteren har fått; skal ALDRI dukke opp i noe utdata, logg eller revisjon. */
  credentialCanary(): string;
  sampleParameters(actionKey: string): Record<string, JsonValue>;
  readonly identities: { owner: AdapterIdentity; foreign_tenant: AdapterIdentity; delegated: AdapterIdentity; delegated_approved: AdapterIdentity };
}

export type ContractAdapter = ConnectorAdapter & ContractControls;

export type CheckStatus = "pass" | "fail" | "skip";

export interface ContractCheckResult {
  id: string;
  level: "R" | "A";
  title: string;
  status: CheckStatus;
  /** Redaksjonssikker forklaring (aldri verdier/credentials). */
  detail?: string;
  /** Handlinger (eller delsjekker) som feilet/ble hoppet over. */
  subjects?: string[];
}
