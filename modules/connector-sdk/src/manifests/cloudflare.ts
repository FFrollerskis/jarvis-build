import { mutationAction, readAction, maxTimeoutMs, strictestTrust } from "../builders.ts";
import type { ConnectorManifest } from "../manifest.ts";

/**
 * WP-I (D-472): FULLT, håndskrevet referansemanifest for Cloudflare (`CONNECTOR_REGISTRY` id `cloudflare`, WP-E1/D-461). Kilder (alle i repoet): `docs/runbooks/CLOUDFLARE_CONNECTOR.md` (D-41-matrisen, klasse D-kjeden,
 * step-up, token-oppsett, DEFERRED/PARTIAL §7), `CLOUDFLARE_CAPABILITIES` i `modules/tool-gateway/src/cloudflare-target-policy.ts`, D-468/Q-55 (strengeste step-up). Alt som kan avledes av registeret SJEKKES mot det.
 *
 * STATUS: BUILT_UNWIRED som manifest (beskriver, styrer ingenting). Selve connectoren er bygget og DORMANT/SOVENDE uten token; den er kun kjørt mot en lokal fake Cloudflare-server, aldri mot ekte Cloudflare
 * (live smoke `BLOCKED_EXTERNAL`: krever eierens token og en sandbox-sone).
 */
const READ = { rate: 30, timeout: 25_000 } as const;
const WRITE = { rate: 10, timeout: 45_000 } as const;

const actions = [
  readAction("cloudflare.check_token", READ),
  readAction("cloudflare.find_dns_records", { ...READ, required: ["zone_id"] }),
  readAction("cloudflare.get_dns_record", { ...READ, required: ["record_id", "zone_id"] }),
  readAction("cloudflare.get_ruleset", { ...READ, required: ["phase", "zone_id"] }),
  readAction("cloudflare.get_zone", { ...READ, required: ["zone_id"] }),
  readAction("cloudflare.get_zone_setting", { ...READ, required: ["setting_id", "zone_id"] }),
  readAction("cloudflare.list_account_members", READ),
  readAction("cloudflare.list_account_roles", READ),
  readAction("cloudflare.list_api_tokens", READ),
  readAction("cloudflare.list_audit_logs", READ),
  readAction("cloudflare.list_dns_records", { ...READ, required: ["zone_id"] }),
  readAction("cloudflare.list_zone_settings", { ...READ, required: ["zone_id"] }),
  readAction("cloudflare.list_zones", READ),

  mutationAction("cloudflare.create_dns_record", {
    ...WRITE, effect: "write", risk: "D", idempotency: "required", provider_idempotent: false, reversible: true, step_up: true,
    rollback_method: "compensating_action", rollback_procedure: "cloudflare.delete_dns_record på posten som ble opprettet (external_id = post-id); recovery verifiserer at den er borte",
    compensating_action: "cloudflare.delete_dns_record på posten Jarvis selv opprettet (aldri en post som fantes fra før, L7)", before_state: true, postcondition: "readback", required: ["content", "name", "type", "zone_id"]
  }),
  mutationAction("cloudflare.create_waf_rule", {
    ...WRITE, effect: "write", risk: "D", idempotency: "required", provider_idempotent: false, reversible: true, step_up: true,
    rollback_method: "compensating_action", rollback_procedure: "cloudflare.delete_waf_rule på regelen som ble opprettet (external_id = regel-id); recovery verifiserer at den er borte",
    compensating_action: "cloudflare.delete_waf_rule på regelen Jarvis selv opprettet", before_state: true, postcondition: "readback", required: ["action", "expression", "phase", "zone_id"]
  }),
  mutationAction("cloudflare.delete_dns_record", {
    ...WRITE, effect: "delete", risk: "D", idempotency: "required", provider_idempotent: true, reversible: true, step_up: true,
    rollback_method: "restore_from_snapshot", rollback_procedure: "cloudflare.create_dns_record med type/navn/innhold/ttl/proxied/kommentar fra before_state (posten får ny id); recovery verifiserer ved ny lesing",
    before_state: true, postcondition: "readback", required: ["record_id", "zone_id"]
  }),
  mutationAction("cloudflare.delete_waf_rule", {
    ...WRITE, effect: "delete", risk: "D", idempotency: "required", provider_idempotent: true, reversible: true, step_up: true,
    rollback_method: "restore_from_snapshot", rollback_procedure: "cloudflare.create_waf_rule med regelens felt fra before_state (regelen får ny id); recovery verifiserer ved ny lesing",
    compensating_action: "regler med action_parameters gjenskapes IKKE automatisk (PARTIAL med snapshot i svaret - gjenopprett manuelt)", before_state: true, postcondition: "readback", required: ["phase", "rule_id", "zone_id"]
  }),
  mutationAction("cloudflare.purge_cache", {
    ...WRITE, effect: "delete", risk: "C", idempotency: "recommended", provider_idempotent: true, reversible: false, step_up: true,
    rollback_method: "none", rollback_procedure: "ingen teknisk reversering - cachen fylles på igjen fra opprinnelsen ved neste forespørsel; ved belastningsproblemer: send mindre purge eller aktiver development_mode",
    before_state: false, postcondition: "none", required: ["mode", "zone_id"], rate: 5
  }),
  mutationAction("cloudflare.update_dns_record", {
    ...WRITE, effect: "write", risk: "D", idempotency: "required", provider_idempotent: true, reversible: true, step_up: true,
    rollback_method: "restore_from_snapshot", rollback_procedure: "cloudflare.update_dns_record med feltene fra before_state (innhold/ttl/proxied/kommentar), verifisert ved ny lesing",
    before_state: true, postcondition: "readback", required: ["record_id", "zone_id"]
  }),
  mutationAction("cloudflare.update_waf_rule", {
    ...WRITE, effect: "write", risk: "D", idempotency: "required", provider_idempotent: true, reversible: true, step_up: true,
    rollback_method: "restore_from_snapshot", rollback_procedure: "cloudflare.update_waf_rule med regelens felt fra before_state, verifisert ved ny lesing av entrypoint-rulesettet",
    before_state: true, postcondition: "readback", required: ["phase", "rule_id", "zone_id"]
  }),
  mutationAction("cloudflare.update_zone_setting", {
    ...WRITE, effect: "write", risk: "D", idempotency: "required", provider_idempotent: true, reversible: true, step_up: true,
    rollback_method: "restore_from_snapshot", rollback_procedure: "cloudflare.update_zone_setting med verdien fra before_state, verifisert ved ny lesing",
    before_state: true, postcondition: "readback", required: ["setting_id", "value", "zone_id"]
  })
];

const STEP_UP = actions.filter((a) => a.authority.step_up_required).map((a) => a.key).sort();

export const CLOUDFLARE_MANIFEST: ConnectorManifest = {
  schema_version: "1",
  completeness: "full",
  source: "authored",
  identity: {
    id: "cloudflare", name: "Cloudflare", vendor: "Cloudflare",
    version: { manifest: "1.0.0", provider_api: "Cloudflare API v4 (api.cloudflare.com/client/v4)" },
    owner: { kind: "tenant_owner", ref: "owner" },
    environment: {
      deployment: "production",
      sandbox: { available: true, description: "en egen, uviktig sandbox-sone som eieren selv legger ALENE i JARVIS_CLOUDFLARE_MUTATION_ZONES under akseptanse (runbook §6); aldri produksjonssoner" }
    }
  },
  auth: {
    type: "api_key",
    scopes: {
      declared_by_actions: ["cloudflare:access_read", "cloudflare:cache", "cloudflare:read", "cloudflare:write"],
      provider: [
        { scope: "Zone: Zone (Read)", needed_for: ["cloudflare.list_zones", "cloudflare.get_zone"] },
        { scope: "Zone: DNS (Read for lesing, Edit for skriving)", needed_for: ["cloudflare.list_dns_records", "cloudflare.find_dns_records", "cloudflare.get_dns_record", "cloudflare.create_dns_record", "cloudflare.update_dns_record", "cloudflare.delete_dns_record"] },
        { scope: "Zone: Zone WAF (Read for lesing, Edit for skriving)", needed_for: ["cloudflare.get_ruleset", "cloudflare.create_waf_rule", "cloudflare.update_waf_rule", "cloudflare.delete_waf_rule"] },
        { scope: "Zone: Zone Settings (Read for lesing, Edit for skriving)", needed_for: ["cloudflare.get_zone_setting", "cloudflare.list_zone_settings", "cloudflare.update_zone_setting"] },
        { scope: "Zone: Cache Purge (Purge)", needed_for: ["cloudflare.purge_cache"] },
        { scope: "Account: Account Settings (Read)", needed_for: ["cloudflare.list_account_members", "cloudflare.list_audit_logs", "cloudflare.list_account_roles"] },
        { scope: "Account: Account API Tokens (Read)", needed_for: ["cloudflare.list_api_tokens"] }
      ]
    },
    rotation: {
      credential_kind: "api_key", method: "manual", interval_days: 90,
      note: "token med utløpsdato (anbefalt 90 dager) og IP-filter; eieren roterer. check_token leser status og utløp, men utløp overvåkes ikke automatisk (EV-17)."
    }
  },
  capabilities: {
    read: { status: "implemented", note: "list_account_roles er PARTIAL (tillatelsen for listeendepunktet er ikke bekreftet)" },
    write: { status: "implemented", note: "DNS-poster (A/AAAA/CNAME/TXT/MX/NS), WAF-/rate limit-regler og seks verifiserte sone-innstillinger" },
    actions: { status: "not_implemented", note: "ingen send/betal/styr-handlinger; cache-purge regnes som sletting (effekt delete)" },
    webhooks: { status: "not_implemented", items: [] },
    sync: { status: "not_implemented", items: [] },
    search: { status: "implemented", items: ["cloudflare.find_dns_records"], note: "finn DNS-poster med eksakt filtrering (også lokalt)" }
  },
  authority: {
    owner: {
      mode: "sovereign", credential_binding: "owner_bound",
      note: "kun den autentiserte eieren kan bruke connectoren (D-377); modellen har ingen tilgang (cloudflare står i OWNER_ONLY_NAMESPACES). Sovereign-modus er uendret, men ALLE skrivehandlinger krever step-up (Q-55, D-468)."
    },
    delegated: { mode: "denied", note: "en delegert identitet får credential_not_bound_to_identity" },
    tenant: { binding: "owner_tenants", note: "sone må stå eksakt i JARVIS_CLOUDFLARE_MUTATION_ZONES og tilhøre JARVIS_CLOUDFLARE_ACCOUNT_ID; kun på verten (env + restart), aldri via dashbordet eller modell" },
    approval_policy: {
      step_up_actions: STEP_UP, delegated_class_cd: "denied",
      note: "alle klasse C/D-mutasjoner krever enhetssignert økt (aldri tale/Telegram/meldingsplattform/system); å lempe krever en navngitt D-beslutning per handling"
    }
  },
  reversibility: { snapshot_support: "before_state_in_ledger" },
  idempotency: {
    dedupe_key: "jarvis_idempotency_key",
    retry_semantics: {
      on_timeout: "reconcile_before_retry", on_rate_limit: "retry_after", on_server_error: "reconcile_before_retry",
      note: "mutasjoner gjentas ALDRI automatisk på 5xx (bivirkningen kan ha skjedd); bare 429 (avslag før behandling, Retry-After respekteres, maks 10 s) og lesing gjentas"
    },
    exactly_once_target: "exactly_once"
  },
  limits: {
    rate_limits: "Cloudflare: 1200 forespørsler per 5 minutter per bruker (429 med Retry-After respekteres); Jarvis: 5-30 kall/min per handling",
    quotas: "purge-listen er begrenset til 30 elementer per kall (konservativt valgt, maks er ikke bekreftet)"
  },
  trust: {
    output: { class: strictestTrust(actions) },
    injection_exposure: { level: "possible", note: "DNS-innhold, regelbeskrivelser og konto-/rolle-/token-navn er fritekst fra leverandøren eller tredjeparter" },
    sanitization: { methods: ["sentral hemmelighetsskanner (scanForSecrets via vendor-text.ts) på leverandørtekst før den forlater transporten", "utdata hvitlistet per ressurs; e-post i medlemslisten maskeres", "ingen redirects følges (guardedFetch avviser 3xx)"] }
  },
  data: {
    schemas: { input: "zod input_schema i ToolDefinition (påkrevde parametre i actions[].data)", output: "hvitlistet per ressurs i transporten; konfigurasjon eieren selv skriver (DNS-innhold, regeluttrykk) vises uredigert fordi den er gjenopprettingsgrunnlaget" },
    provenance: { origin: "mixed", tagging: "ekstern id (post-/regel-id) + infra_executions-journalen (aktør/enhet, risikoklasse, mål, before/after, verifikasjonsutfall) + audit_events merket person/tenant/task_id" },
    freshness: { model: "live_read" },
    retention: { stored_by_jarvis: ["audit_metadata", "before_after_ledger"], note: "før-/etter-tilstand og state_diff i infra_executions og tool_executions" },
    delete_semantics: { provider_side: "supported", jarvis_side: "delete_dns_record, delete_waf_rule og purge_cache sletter hos leverandøren; journalen beholdes etter retensjonsregelen og snapshotet av slettet post ligger i before_state" }
  },
  operations: {
    health_check: { method: "live_probe", action_key: "cloudflare.check_token", cadence: "daglig helsesveip (ConnectorHealthSweep)" },
    timeout: { max_ms: maxTimeoutMs(actions) },
    circuit_breaker: { status: "partial", mechanism: "InfraExecutionGate: PAUSED stanser all skriving, DEGRADED stanser klasse D (lesing stanses aldri); manuell pause via POST /infra/pause; ingen automatisk bryter på feilrate" },
    metrics: { sources: ["infra_executions (verification_outcome SUCCESS/PARTIAL/FAILED/UNKNOWN)", "ToolGateway.health (i minnet)", "audit_events tool.executed og tool.failed"] },
    runbook: { path: "docs/runbooks/CLOUDFLARE_CONNECTOR.md" },
    maintenance_owner: { role: "owner", ledger: "connector_maintenance_log" }
  },
  secrets: {
    refs: [
      { ref: "JARVIS_CLOUDFLARE_API_TOKEN", required: true, purpose: "API-token med minste nødvendige tillatelser (kontoeid, avgrenset til utvalgte soner)" },
      { ref: "JARVIS_CLOUDFLARE_ACCOUNT_ID", required: true, purpose: "konto-id (32 hex) alle soner må tilhøre; uten den kan ingen skriving skje" }
    ],
    model_visibility: "never"
  },
  tests: {
    fake_adapter: { status: "present", paths: ["modules/connector-sdk/test/references/cloudflare.fake.ts"] },
    contract: { status: "present", paths: ["modules/connector-sdk/test/references/reference-connectors.contract.test.ts", "modules/tool-gateway/test/e1-cloudflare-transport.test.ts", "modules/tool-gateway/test/e1-cloudflare-tools.test.ts"] },
    live_smoke: { status: "blocked_external", paths: [], note: "runbook §6 (sandbox-sone) er NOT VERIFIED; krever eierens token og konto-id" },
    authority: { status: "present", paths: ["modules/tool-gateway/test/e1-cloudflare-policy.test.ts", "modules/tool-gateway/test/e1-review-m2-step-up.test.ts"] },
    recovery: { status: "present", paths: ["modules/incidents/test/e1-cloudflare-execution.test.ts", "modules/tool-gateway/test/e1-review-l7-already-existed.test.ts"] },
    security: { status: "present", paths: ["modules/tool-gateway/test/e1-review-l1-waf-guard.test.ts", "modules/tool-gateway/test/e1-review-l2-no-redirects.test.ts", "modules/tool-gateway/test/e1-review-m1-vendor-text.test.ts"] }
  },
  d41_audit: {
    classification: "PARTIAL",
    read: { provider_offers: "yes", implemented: "partial", action_keys: actions.filter((a) => a.kind === "read").map((a) => a.key), note: "list_account_roles: tillatelsen for listeendepunktet er ikke bekreftet; audit-logg leses kun første side; list_dns_records er begrenset til 10 sider à 100 poster" },
    write: { provider_offers: "yes", implemented: "partial", action_keys: ["cloudflare.create_dns_record", "cloudflare.update_dns_record", "cloudflare.create_waf_rule", "cloudflare.update_waf_rule", "cloudflare.update_zone_setting"], note: "kun de verifiserte DNS-typene, WAF-fasene http_request_firewall_custom og http_ratelimit, og seks sone-innstillinger" },
    delete: { provider_offers: "yes", implemented: "full", action_keys: ["cloudflare.delete_dns_record", "cloudflare.delete_waf_rule", "cloudflare.purge_cache"] },
    access_control: { provider_offers: "yes", implemented: "partial", action_keys: ["cloudflare.list_account_members", "cloudflare.list_account_roles", "cloudflare.list_api_tokens", "cloudflare.list_audit_logs"], note: "kun lesing av metadata; skriving (medlemmer, roller, opprette/tilbakekalle tokens) er DEFERRED fordi et token som kan opprette tokens er privilegie-eskalering" },
    scopes_verified_against_docs: false,
    unverified_scopes: ["Account Settings Read for rolle-listen (kun enkelt-rolle-oppslaget er verifisert)", "dashbord-navnet Account API Tokens Read for kontoeide tokens"],
    verified_on: "2026-10-09",
    docs_reference: ["Cloudflare API-dokumentasjon (developers.cloudflare.com): token-verifisering, DNS-poster, Rulesets, sone-innstillinger, cache purge, konto-medlemmer, audit-logg v2 - lest via søk 2026-10-09; se docs/runbooks/CLOUDFLARE_CONNECTOR.md §9"],
    gaps: [
      { capability: "strukturerte DNS-typer (SRV/CAA/HTTPS/LOC/SSHFP/TLSA), tags, batch, import/eksport", status: "DEFERRED", reason: "krever per-type data-skjema som ikke er verifisert enkeltvis" },
      { capability: "WAF skip/execute-regler, managed ruleset-overstyringer og egen blokkeringsrespons", status: "DEFERRED", reason: "krever action_parameters-skjema som ikke er verifisert" },
      { capability: "sone-innstillinger utover de seks verifiserte", status: "PARTIAL", reason: "kun ssl, min_tls_version, always_use_https, development_mode, security_level og tls_1_3; batch-endepunktet er deprecated" },
      { capability: "tilgangsstyring skriv: medlemmer, roller, opprette/tilbakekalle API-tokens", status: "DEFERRED", reason: "privilegie-eskalering; krever egen eierbeslutning og et eget isolert token" },
      { capability: "Workers, Pages, R2, Tunnel, Zero Trust, Load Balancing, Page/Cache/Transform Rules, Logpush, GraphQL-analyse", status: "DEFERRED", reason: "utenfor masterplanens Cloudflare (DNS/WAF)-avgrensning; hver krever egen D-41-verifisering" },
      { capability: "paginering av audit-logg (kun første side)", status: "PARTIAL", reason: "cursor-paginering er ikke bygget" }
    ]
  },
  core_boundary: {
    system_of_record: "EXTERNAL_CANONICAL", basis: "audited",
    external_role: "adapter og utførelsesleverandør for DNS, WAF og sone-innstillinger; Jarvis eier hendelsesmodellen, infra_executions-journalen, policyen og revisjonen",
    core_dependency_decision_required: false
  },
  actions
};
