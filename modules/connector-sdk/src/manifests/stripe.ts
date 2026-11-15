import { mutationAction, readAction, maxTimeoutMs, strictestTrust } from "../builders.ts";
import type { ConnectorManifest } from "../manifest.ts";

/**
 * WP-I (D-472): FULLT, håndskrevet referansemanifest for finansleverandøren Stripe (`CONNECTOR_REGISTRY` id `stripe`, UA-6/WP-F1, D-462). Kilder (alle i repoet): `docs/runbooks/FINANCE_D_CHAIN.md` (klasse D-kjeden for penger,
 * step-up, dobbeltbetalingsvern, avstemming, webhooks, kjente begrensninger), D-228 (Stripe testmodus), `docs/ARCHITECTURE.md` §11.9 (finans/betalinger: «sannsynlig HYBRID»). Alt som kan avledes av registeret SJEKKES mot det.
 *
 * REGISTERETS HANDLINGSMENGDE for `stripe` er de tre handlingene bundet til Stripe-credentialen. Selve betalingskjeden (intensjoner, refusjonsforespørsel, avstemming) er Jarvis-kjernen (`finance*`-handlingene med intern credential,
 * JARVIS_CANONICAL) og står derfor IKKE i handlingslisten under - se `core_boundary.authority_split`.
 *
 * STATUS: BUILT_UNWIRED som manifest. Connectoren er DORMANT uten credential og IKKE kjørt mot ekte Stripe etter WP-F1 (testmodus-kjøringen D-228 gjaldt FØR den nye kjeden; live smoke `BLOCKED_EXTERNAL`).
 */
const actions = [
  readAction("finance_stripe.get_balance", { rate: 30, timeout: 10_000, required: ["tenant_id"], identity_fields: ["tenant_id"] }),
  readAction("finance_stripe.refresh_payment_state", { rate: 30, timeout: 15_000, trust: "internal", required: ["payment_intent_id", "tenant_id"], identity_fields: ["tenant_id", "memory_space", "actor_person_id"] }),
  mutationAction("finance_stripe.submit_refund", {
    effect: "pay", risk: "D", rate: 10, timeout: 30_000, idempotency: "required", provider_idempotent: true, reversible: false, step_up: true,
    rollback_method: "manual",
    rollback_procedure: "Ikke reverserbar hos Stripe - en feilaktig refusjon korrigeres ved en NY, separat finansoperasjon (ny betaling), aldri en stille reversering. UKJENT utfall: sjekk Stripe Dashboard (Refunds) FØR du prøver igjen; samme refusjon sendes alltid med samme Idempotency-Key.",
    compensating_action: "ny, separat finansoperasjon (ny betaling) etter eierens beslutning - aldri en stille reversering",
    before_state: true, postcondition: "readback", required: ["refund_id", "tenant_id"], identity_fields: ["tenant_id", "memory_space", "actor_person_id"]
  })
];

export const STRIPE_MANIFEST: ConnectorManifest = {
  schema_version: "1",
  completeness: "full",
  source: "authored",
  identity: {
    id: "stripe", name: "Stripe", vendor: "Stripe",
    version: { manifest: "1.0.0", provider_api: "API v1 (kontoens standardversjon - koden fester ikke Stripe-Version)" },
    owner: { kind: "tenant_owner", ref: "owner" },
    environment: {
      deployment: "production",
      sandbox: { available: true, description: "Stripe testmodus med egen test-nøkkel; akseptansescriptet stripe-real-payment-acceptance-host-run.ts bruker aldri live-nøkkelen (D-228)" }
    }
  },
  auth: {
    type: "api_key",
    scopes: {
      declared_by_actions: ["finance.read", "finance.stripe", "finance.write"],
      provider: [
        { scope: "balance (lesing)", needed_for: ["finance_stripe.get_balance"] },
        { scope: "payment_intents (lesing)", needed_for: ["finance_stripe.refresh_payment_state"] },
        { scope: "refunds (skriving)", needed_for: ["finance_stripe.submit_refund"] }
      ]
    },
    rotation: { credential_kind: "api_key", method: "manual", note: "eieren roterer nøkkelen i Stripe Dashboard; utløp og rotasjon overvåkes ikke automatisk (EV-17)" }
  },
  capabilities: {
    read: { status: "implemented" },
    write: { status: "not_implemented", note: "opprettelse av betalinger går via Jarvis-kjernens finance.submit_payment_intent (intern kjede), ikke som en connector-handling bundet til Stripe-credentialen" },
    actions: { status: "implemented" },
    webhooks: { status: "implemented", items: ["POST /webhooks/stripe (Stripe-Signature t/v1 HMAC, 300 s toleranse)"], note: "krever webhook-hemmeligheten, som ikke står i registerets credential_refs (funn, se runbook)" },
    sync: { status: "implemented", items: ["stripe-payment-sync"], note: "daglig synk av betalingstilstand (CONNECTOR_SYNC_JOBS) i tillegg til webhooks og refresh_payment_state" },
    search: { status: "not_implemented", items: [] }
  },
  authority: {
    owner: {
      mode: "sovereign", credential_binding: "owner_bound",
      note: "ingen pengehandling kan nås av modellen (eier-eksklusive navnerom); eierens vei er forhåndsvisning, bundet bekreftelse (5 min) og step-up-godkjenning"
    },
    delegated: { mode: "denied", note: "credential_not_bound_to_identity for alle andre enn eieren, også gjester og delegater" },
    tenant: { binding: "per_tenant_credential", note: "tenant og person kommer alltid fra grantet, aldri fra kroppen; webhook-tenant via JARVIS_STRIPE_TENANT_ID" },
    approval_policy: {
      step_up_actions: ["finance_stripe.submit_refund"], delegated_class_cd: "denied",
      note: "step-up håndheves i ToolGateway selv (D-462), uavhengig av om klasse D-pipelinen er påslått"
    }
  },
  reversibility: { snapshot_support: "before_state_in_ledger" },
  idempotency: {
    dedupe_key: "jarvis_idempotency_key",
    retry_semantics: {
      on_timeout: "reconcile_before_retry", on_rate_limit: "retry_after", on_server_error: "reconcile_before_retry",
      note: "samme refusjon sendes alltid med samme Idempotency-Key hos Stripe (23 t-vindu); ukjent utfall går til avstemming og prøves aldri på nytt blindt"
    },
    exactly_once_target: "exactly_once"
  },
  limits: {
    rate_limits: "Stripes egne rate limits er ikke dokumentert i repoet (429 gir helsetilstanden rate_limited); Jarvis: 10-30 kall/min per handling",
    quotas: "ingen kjente kvoter",
    owner_caps: "ingen interne beløpsgrenser i Sovereign Mode (valgfri eier-policy); MAX_AMOUNT_MINOR_UNITS er en numerisk sikkerhetsgrense, ikke policy"
  },
  trust: {
    output: { class: strictestTrust(actions) },
    injection_exposure: { level: "possible", note: "saldo, betalingstilstand og webhook-innhold er ubetrodd leverandørdata" },
    sanitization: { methods: ["webhook-signatur (HMAC + 300 s toleranse) FØR noe lagres", "strengt heltall i minste enhet, trygge id-er, gyldig dato og tre-bokstavs valuta (ingen coercion)", "dødbrev lagrer kun kort årsakskode, aldri innholdet"] }
  },
  data: {
    schemas: { input: "zod input_schema i ToolDefinition (påkrevde parametre i actions[].data)", output: "normalisert betalingstilstand (beløp i minste enhet, valuta, status) i Jarvis' egne tabeller" },
    provenance: { origin: "mixed", tagging: "payment_intents og refusjoner med tenant-RLS, leverandørens ekstern id og revisjon merket person/tenant/task_id" },
    freshness: { model: "synced", note: "webhooks (hendelsesdrevet) + daglig stripe-payment-sync + live refresh_payment_state" },
    retention: { stored_by_jarvis: ["audit_metadata", "before_after_ledger", "synced_copy"], note: "pengekolonnene er uforanderlige og sendte rader kan ikke slettes (migrasjon 101)" },
    delete_semantics: { provider_side: "not_offered", jarvis_side: "en sendt refusjon kan ikke angres hos Stripe; utkast kan slettes og erasure virker (transaksjonslokal, ErasureService); sendte rader kan ikke slettes" }
  },
  operations: {
    health_check: { method: "live_probe", action_key: "finance_stripe.get_balance", cadence: "daglig helsesveip (ConnectorHealthSweep)" },
    timeout: { max_ms: maxTimeoutMs(actions) },
    circuit_breaker: { status: "partial", mechanism: "finans-nødbryteren (kill switch), frys av connector-id (review F8) og step-up-/eier-portene stanser pengehandlinger; ingen automatisk bryter på feilrate" },
    metrics: { sources: ["ToolGateway.health (i minnet)", "audit_events tool.executed og tool.failed", "avstemmingsfunn (finance.get_reconciliation_status)"] },
    runbook: { path: "docs/runbooks/FINANCE_D_CHAIN.md" },
    maintenance_owner: { role: "owner", ledger: "connector_maintenance_log" },
    reconciliation: { required: true, method: "daglig avstemming finance-reconcile-sweep kl. 5: observasjon og varsel, aldri korreksjon; funn (beløp/valuta-avvik, ukjent utfall, over-refundert, duplikat) vises via finance.get_reconciliation_status" }
  },
  secrets: {
    refs: [{ ref: "JARVIS_STRIPE_SECRET_KEY", required: true, purpose: "Stripe secret key (testmodus bruker en egen test-nøkkel)" }],
    model_visibility: "never"
  },
  tests: {
    fake_adapter: { status: "present", paths: ["modules/connector-sdk/test/references/stripe.fake.ts"] },
    contract: { status: "present", paths: ["modules/connector-sdk/test/references/reference-connectors.contract.test.ts", "modules/finance/test/stripe-service.test.ts"] },
    live_smoke: { status: "blocked_external", paths: [], note: "D-228 testmodus-kjøring skjedde FØR WP-F1; den nye kjeden er IKKE kjørt mot ekte Stripe. Krever eierens test-nøkkel" },
    authority: { status: "present", paths: ["modules/tool-gateway/test/wpf1-finance-class-d.test.ts", "modules/tool-gateway/test/wpf1-gateway-extensions.test.ts"] },
    recovery: { status: "present", paths: ["modules/finance/test/wpf1-d-chain.test.ts", "modules/finance/test/wpf1-reconciliation.test.ts"] },
    security: { status: "present", paths: ["modules/finance/test/stripe-webhook.test.ts", "modules/finance/test/wpf1-double-pay-service.test.ts"] }
  },
  d41_audit: {
    classification: "PARTIAL",
    read: { provider_offers: "yes", implemented: "partial", action_keys: ["finance_stripe.get_balance", "finance_stripe.refresh_payment_state"], note: "saldo og betalingstilstand; øvrige lese-flater (kunder, abonnementer, payouts, disputes) er ikke bygget" },
    write: { provider_offers: "yes", implemented: "partial", action_keys: ["finance_stripe.submit_refund"], note: "kun refusjon (klasse D, penger); betalingsopprettelse er Jarvis-kjernens finance.submit_payment_intent (intern kjede, JARVIS_CANONICAL), ikke en handling i dette registerinnslaget; kunder, abonnementer og payouts er ikke bygget" },
    delete: { provider_offers: "unknown", implemented: "none", action_keys: [], note: "ikke vurdert: betalingsobjekter slettes ikke hos Stripe (refunderes/avbrytes); andre ressurser er utenfor scope" },
    access_control: { provider_offers: "unknown", implemented: "none", action_keys: [], note: "ikke vurdert: API-nøkler og teammedlemmer er root-nivå og skal aldri nås av modellen" },
    scopes_verified_against_docs: false,
    unverified_scopes: ["Stripe restricted key-tillatelsesnavn for balance, payment_intents og refunds (ikke lest mot Stripes dokumentasjon i WP-I)"],
    docs_reference: ["Stripe API-referanse (balance, payment_intents, refunds) slik D-228 og transporten bruker den; tillatelsesnavn ikke verifisert i WP-I - se docs/runbooks/FINANCE_D_CHAIN.md §8"],
    gaps: [
      { capability: "Stripe restricted key-tillatelser verifisert mot dokumentasjon", status: "PARTIAL", reason: "tillatelsesnavnene er ikke lest mot offisiell dokumentasjon i WP-I" },
      { capability: "kunder, abonnementer, payouts, disputes (lese- og skriveflater)", status: "DEFERRED", reason: "ikke bygget; ikke vurdert mot dokumentasjon" },
      { capability: "manuell disposisjon av ukjent utfall", status: "DEFERRED", reason: "bevisst ikke bygget (FINANCE_D_CHAIN §9); forslaget resolve_submit_outcome ligger som åpent spørsmål" }
    ]
  },
  core_boundary: {
    system_of_record: "HYBRID_WITH_CLEAR_AUTHORITY", basis: "audited",
    external_role: "betalingsrail og utførelsesleverandør for refusjoner; betalings- og refusjonstilstand hentes via webhooks, synk og refresh",
    authority_split: "Jarvis eier betalingsintensjoner, bekreftelse, journal, avstemming, policy og revisjon (finance*-kjernen, JARVIS_CANONICAL); Stripe eier betalings- og refusjonstilstanden og selve pengebevegelsen (EXTERNAL_CANONICAL, betalingsrails er intrinsic regulert ekstern, ARCHITECTURE.md §11.9).",
    core_dependency_decision_required: false
  },
  actions
};
