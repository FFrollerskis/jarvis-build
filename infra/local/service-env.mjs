// Remediering del 2 (JARVIS-010): HVEM FÅR HVA. Én kilde til sannhet for hvilke miljøvariabler hver
// compose-tjeneste får. `docker-compose.yml` bruker IKKE lenger `env_file: ../../.env` (hele hemmelighetssettet
// til alle containere) - hver tjeneste lister eksplisitt kun det den faktisk trenger.
// Generer compose-blokkene med `node ops/security/generate-compose-env.mjs`; strukturtesten
// `modules/core/test/remediation-2-compose-isolation.test.ts` låser at compose og denne filen er like.
//
// ALDRI i noen runtime-tjeneste (api/worker/voice/browser): INFISICAL_ENCRYPTION_KEY, INFISICAL_AUTH_SECRET,
// INFISICAL_SMTP_*, JARVIS_DB_ADMIN_*, POSTGRES_*, NEXTAUTH_SECRET, SALT, LANGFUSE_INIT_* - se NEVER_IN_RUNTIME.

/** Hemmeligheter som kun hører hjemme i db-bootstrap/migrate/postgres/infisical/langfuse - ALDRI i api/worker/voice/browser. */
export const NEVER_IN_RUNTIME = [
  "INFISICAL_AUTH_SECRET",
  "INFISICAL_DB_PASSWORD",
  "INFISICAL_ENCRYPTION_KEY",
  "INFISICAL_SMTP_FROM_ADDRESS",
  "INFISICAL_SMTP_FROM_NAME",
  "INFISICAL_SMTP_HOST",
  "INFISICAL_SMTP_PASSWORD",
  "INFISICAL_SMTP_PORT",
  "INFISICAL_SMTP_USERNAME",
  "JARVIS_DB_ADMIN_PASSWORD",
  "JARVIS_DB_ADMIN_USER",
  "LANGFUSE_DB_PASSWORD",
  "LANGFUSE_INIT_ORG_ID",
  "LANGFUSE_INIT_PROJECT_ID",
  "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
  "LANGFUSE_INIT_PROJECT_SECRET_KEY",
  "LANGFUSE_INIT_USER_EMAIL",
  "LANGFUSE_INIT_USER_NAME",
  "LANGFUSE_INIT_USER_PASSWORD",
  "NEXTAUTH_SECRET",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "SALT"
];
/** Identitet, DB-runtime-rolle (IKKE admin), vault-KLIENT (ikke vault-hovednøkkel), tracing-nøkler, browser-gateway-kobling. */
export const CORE_ENV = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_ENV",
  "INFISICAL_PROJECT_ID",
  "JARVIS_BRIEF_HOUR",
  "JARVIS_BROWSER_GATEWAY_BASE_URL",
  "JARVIS_BROWSER_GATEWAY_TOKEN_SECRET",
  // WP-G2c (D-483, JARVIS-113 d): tidsavbrudd (ms) for å få en forbindelse fra den delte DB-poolen (`createPool`, 0 = ingen grense, standard 30000). Ikke-hemmelig; api, worker og migrate lager hver sin pool.
  "JARVIS_DB_CONNECT_TIMEOUT_MS",
  "JARVIS_DB_PASSWORD",
  "JARVIS_DB_USER",
  "JARVIS_DESTINATION_HOST_ALLOWLIST",
  "JARVIS_ENV",
  "JARVIS_GIT_ALLOWED_REPOS",
  // WP-E1 (JARVIS-068): incident-produsentene (observasjon + registrering). AV som standard; api kjører de fleste, worker kjører vakthund-produsenten - begge leser samme bryter.
  "JARVIS_INCIDENT_PRODUCERS_ENABLED",
  "JARVIS_OWNER_EXTRA_TENANTS",
  "JARVIS_OWNER_NAME",
  "JARVIS_OWNER_PERSON_ID",
  // WP-K (D-471, JARVIS-053): varig policy-journal (`policy_decisions`). AV som standard (kun `db` slår på); api OG worker bruker samme sink-kode og leser samme bryter. Ingen hemmeligheter.
  "JARVIS_POLICY_AUDIT_QUEUE_MAX",
  "JARVIS_POLICY_AUDIT_SINK",
  "JARVIS_TENANT_ID",
  // WP-K (D-471, JARVIS-018, review M2): nødutgang for avbruddsmekanismen i ToolGateway (kun eksakt `off` slår den av; standard PÅ). api OG worker bruker samme gateway-kode. Ingen hemmeligheter.
  "JARVIS_TOOL_CALL_ABORT",
  "JARVIS_WATCHDOG_INTERVAL_MS",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY"
];
/** Modellleverandør-nøkler og modellkonfig. */
export const MODEL_ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GEMMA_API_KEY",
  "HERMES_API_KEY",
  "JARVIS_BUDGET_APPROVED",
  // WP-B4 (D-476): Claude-kreditten (100 USD/mnd) med tempostyring og behovsprioritering. AV som standard (tom/usatt = av; `JARVIS_CLAUDE_BUDGET_USD=100` slår på). Både api og worker kaller modellen, så begge får dem
  // (MODEL_ENV er felles); worker kjører også varslingen (Telegram). Kun tall, flagg og tabeller - ingen hemmeligheter.
  "JARVIS_CLAUDE_BUDGET_ALERT_PCTS",
  "JARVIS_CLAUDE_BUDGET_HARD_STOP",
  "JARVIS_CLAUDE_BUDGET_MARGIN_PCT",
  "JARVIS_CLAUDE_BUDGET_RESERVE_PCT",
  "JARVIS_CLAUDE_BUDGET_RESET_DAY",
  "JARVIS_CLAUDE_BUDGET_TIERS",
  "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO",
  "JARVIS_CLAUDE_BUDGET_USD",
  "JARVIS_COST_APPROVAL_ORE",
  "JARVIS_COST_HARD_LIMIT_ORE",
  "JARVIS_COST_WARN_ORE",
  "JARVIS_COUNCIL_MODEL_TIMEOUT_MS",
  "JARVIS_GEMINI_MODEL",
  "JARVIS_MODEL_ADVISOR",
  "JARVIS_MODEL_CATALOG",
  "JARVIS_MODEL_PRICING",
  "JARVIS_GEMMA_LOCAL_MODEL",
  "JARVIS_GEMMA_LOCAL_URL",
  "JARVIS_EMBEDDING_DIM",
  "JARVIS_EMBEDDING_MODEL",
  "JARVIS_EMBEDDING_PROVIDER",
  "JARVIS_EMBEDDING_URL",
  "JARVIS_GEMMA_MODEL",
  "JARVIS_LOCAL_LLM_THINKING",
  "JARVIS_MEMORY_AUTO_APPROVE",
  "JARVIS_MEMORY_EXTRACTION_CONCURRENCY",
  "JARVIS_MEMORY_PROFILE_SWEEP_HOUR",
  "JARVIS_MEMORY_REEMBED_SWEEP_HOUR",
  "JARVIS_MEMORY_RESENSITIZE",
  "JARVIS_MEMORY_RESENSITIZE_SWEEP_HOUR",
  "JARVIS_MEMORY_RETENTION_DAYS",
  "JARVIS_MEMORY_RETENTION_SWEEP_HOUR",
  "JARVIS_MODEL_TIMEOUT_MS",
  "JARVIS_OLLAMA_URL",
  // WP-G4b K4 (D-484, JARVIS-115 d): oppstartsvakt for URL-ene til de lokale modellidentitetene (`gemma_local`, `local_llm`, `ollama`). Kun eksakt `on` slår på (AV = identisk med main); `_ALLOW_TAILSCALE=on` regner eierens tailnet som lokalt.
  // api OG worker kjører vakten (begge bygger en ModelGateway med disse identitetene). Ingen hemmeligheter - kun flagg.
  "JARVIS_LOCAL_MODEL_URL_GUARD",
  "JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE",
  // WP-D4 (JARVIS-036): valgfri modell-/endepunktoverstyring for Kimi og Hermes (tom = adapterens standard).
  "JARVIS_KIMI_MODEL",
  "JARVIS_KIMI_URL",
  "JARVIS_HERMES_MODEL",
  "JARVIS_HERMES_URL",
  // WP-D4 (gjennomgang av PR #315, M3): leverandører eieren har erklært LIVE-verifisert for verktøykall/streaming etter `mesh-live-smoke.ts --tools` (tom = AUTO-ruting bruker ikke Kimi/Hermes til verktøyløkker). Api OG worker.
  "JARVIS_MESH_TOOLS_VERIFIED",
  "JARVIS_JOB_TOOL_TURN_MODEL",
  "JARVIS_TOOL_TURN_DAILY_CAP_ORE",
  "JARVIS_TOOL_TURN_MODEL",
  "KIMI_API_KEY",
  "LOCAL_LLM_BASE_URL",
  "LOCAL_LLM_MODEL",
  "OPENAI_API_KEY"
];
/** Connector-credentials (env-fallback; Infisical er primær). */
export const CONNECTOR_ENV = [
  "JARVIS_BRAVE_SEARCH_API_KEY",
  "JARVIS_BUSINESS_INTERNAL_TOKEN",
  "JARVIS_CLOUDFLARE_ACCOUNT_ID",
  "JARVIS_CLOUDFLARE_API_TOKEN",
  "JARVIS_CLOUDFLARE_MUTATION_ZONES",
  "JARVIS_DISCORD_BOT_TOKEN",
  "JARVIS_DOCKER_BIN",
  "JARVIS_DOCKER_MUTATION_TARGETS",
  "JARVIS_DROPBOX_APP_KEY",
  "JARVIS_DROPBOX_APP_SECRET",
  "JARVIS_DROPBOX_REFRESH_TOKEN",
  "JARVIS_DROPBOX_TOKEN",
  "JARVIS_EMAIL_TOKEN",
  "JARVIS_EXA_API_KEY",
  "JARVIS_FIKEN_CLIENT_ID",
  "JARVIS_FIKEN_CLIENT_SECRET",
  "JARVIS_FIKEN_COMPANY_SLUG",
  "JARVIS_FIKEN_REFRESH_TOKEN",
  "JARVIS_GCE_MUTATION_TARGETS",
  "JARVIS_GITHUB_ALLOW_OTHER_REPOS",
  "JARVIS_GITHUB_API_BASE",
  "JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK",
  "JARVIS_GITHUB_APP_ID",
  "JARVIS_GITHUB_APP_INSTALLATION_ID",
  "JARVIS_GITHUB_REPO",
  "JARVIS_GITHUB_TOKEN",
  "JARVIS_GIT_CREDENTIAL_TOKEN",
  "JARVIS_GOOGLE_ACCOUNT",
  "JARVIS_GOOGLE_ADS_API_VERSION",
  "JARVIS_GOOGLE_ADS_CUSTOMER_ID",
  "JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN",
  "JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
  "JARVIS_GOOGLE_ANALYTICS_REFRESH_TOKEN",
  "JARVIS_GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN",
  "JARVIS_GOOGLE_CLIENT_ID",
  "JARVIS_GOOGLE_CLIENT_SECRET",
  "JARVIS_GOOGLE_CLOUD_PROJECT_ID",
  "JARVIS_GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
  // WP-G1 (D-463, P2e): Google Contacts - EGEN refresh-token med `contacts`-scope (eierens samtykke, BLOCKED_EXTERNAL live). Tom = kontakt-handlingene feiler lukket. Kun api.
  "JARVIS_GOOGLE_CONTACTS_TOKEN",
  "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN",
  "JARVIS_GOOGLE_MAPS_API_KEY",
  "JARVIS_GOOGLE_PLACES_API_KEY",
  "JARVIS_GOOGLE_ROUTES_API_KEY",
  "JARVIS_GOOGLE_SHEETS_TOKEN",
  "JARVIS_GOOGLE_TOKEN",
  "JARVIS_GRAFANA_API_BASE_URL",
  "JARVIS_GRAFANA_API_KEY",
  "JARVIS_HA_BASE_URL",
  "JARVIS_HA_ROOMS",
  "JARVIS_HA_TOKEN",
  "JARVIS_HUBSPOT_API_KEY",
  // WP-G1 (D-463): Instagram-/Messenger-tilgangstokener (Meta Send API) og Teams' delegerte refresh-token. Tomme = kanalen kan ikke sende (credential_ref_unresolved). Kun api.
  "JARVIS_INSTAGRAM_ACCESS_TOKEN",
  "JARVIS_INFISICAL_ROTATION_IDS",
  "JARVIS_JIRA_API_TOKEN",
  "JARVIS_JIRA_BASE_URL",
  "JARVIS_JIRA_EMAIL",
  "JARVIS_LINEAR_API_KEY",
  "JARVIS_LINKEDIN_ACCESS_TOKEN",
  "JARVIS_LINKEDIN_API_VERSION",
  "JARVIS_MCP_ZAPIER_SERVER_URL",
  "JARVIS_META_ADS_ACCESS_TOKEN",
  "JARVIS_META_ADS_AD_ACCOUNT_ID",
  "JARVIS_META_ADS_API_VERSION",
  "JARVIS_META_PAGE_ACCESS_TOKEN",
  "JARVIS_MICROSOFT_CLIENT_ID",
  "JARVIS_MICROSOFT_CLIENT_SECRET",
  "JARVIS_MICROSOFT_REFRESH_TOKEN",
  "JARVIS_MICROSOFT_TENANT_ID",
  "JARVIS_NEONOMICS_CLIENT_ID",
  "JARVIS_NEONOMICS_CLIENT_SECRET",
  "JARVIS_NEONOMICS_DEVICE_ID",
  "JARVIS_NEONOMICS_ENVIRONMENT",
  "JARVIS_NEONOMICS_REALM",
  "JARVIS_NEONOMICS_SYNC_HOUR",
  "JARVIS_NEONOMICS_TENANT_ID",
  "JARVIS_NOTION_API_KEY",
  "JARVIS_ONEDRIVE_TOKEN",
  "JARVIS_OUTLOOK_TOKEN",
  "JARVIS_PIPEDRIVE_API_KEY",
  "JARVIS_PIPEDRIVE_BASE_URL",
  "JARVIS_POSTGRES_OPS_DATABASES",
  "JARVIS_POSTGRES_OPS_PROTECTED_ROLES",
  "JARVIS_POSTGRES_OPS_SCHEMAS",
  "JARVIS_POSTGRES_OPS_URL",
  "JARVIS_PROMETHEUS_API_BASE_URL",
  "JARVIS_PROMETHEUS_TOKEN",
  "JARVIS_SENTRY_API_TOKEN",
  "JARVIS_SENTRY_ORG_SLUG",
  "JARVIS_SITUATIONS_INTERNAL_TOKEN",
  "JARVIS_SLACK_BOT_TOKEN",
  "JARVIS_STRIPE_SECRET_KEY",
  "JARVIS_STRIPE_SYNC_HOUR",
  "JARVIS_STRIPE_TENANT_ID",
  "JARVIS_SUPPORT_INBOX_EMAILS",
  "JARVIS_SUPPORT_SLA_HOURS",
  "JARVIS_TAVILY_API_KEY",
  "JARVIS_TEAMS_REFRESH_TOKEN",
  "JARVIS_TELEGRAM_CHAT_ID",
  "JARVIS_TELEGRAM_TOKEN",
  "JARVIS_TIKTOK_ACCESS_TOKEN",
  "JARVIS_TODOIST_API_TOKEN",
  "JARVIS_TRELLO_API_KEY",
  "JARVIS_TRELLO_TOKEN",
  "JARVIS_VERCEL_TEAM_ID",
  "JARVIS_VERCEL_TOKEN",
  "JARVIS_YOUTUBE_REFRESH_TOKEN",
  "JARVIS_VIPPS_CLIENT_ID",
  "JARVIS_VIPPS_CLIENT_SECRET",
  "JARVIS_VIPPS_ENVIRONMENT",
  "JARVIS_VIPPS_MSN",
  "JARVIS_VIPPS_SUBSCRIPTION_KEY",
  "JARVIS_VIPPS_SYNC_HOUR",
  "JARVIS_VIPPS_TENANT_ID",
  "JARVIS_WALLESTER_ACCOUNT_ID",
  "JARVIS_WALLESTER_API_BASE_URL",
  "JARVIS_WALLESTER_API_KEY",
  "JARVIS_WALLESTER_ENVIRONMENT",
  "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
  "JARVIS_WALLESTER_SYNC_HOUR",
  "JARVIS_WALLESTER_TENANT_ID"
];
/**
 * Q-46 / D-434 + D-437 (minste privilegium, etter review): worker-containeren får KUN connector-variablene dens egne handlere faktisk bruker -
 * kodejobb (GitHub-token, git-credential), e-postvedlegg-ingestion (e-post/Google), bakgrunnsflatens lesing (e-post, kalender, GitHub) og
 * Telegram-varsling (klasse D-varsler, watchdog). I tillegg IKKE-hemmelige modusvariabler som styrer hvilket endepunkt en transport peker mot
 * (Vipps/Neonomics/Wallester-miljø, Neonomics-realm) og support-innboksliste: uten dem ville en transport stille velge test/sandbox eller ignorere
 * meldinger. Docker-/GCE-mutasjonsmål og `JARVIS_DOCKER_BIN` er IKKE med (workeren har ingen docker-socket; tom liste = ingen mutasjoner tillatt).
 * Finans-, annonse-, lagrings-, CRM-, overvåkings- og meldingsnøkler (resten av CONNECTOR_ENV) er api-only; bakgrunnsflaten er read-only.
 * NB (ærlig): dashbord-lagrede hemmeligheter ligger i Infisical (primær), og workeren beholder Infisical-maskinidentiteten (CORE_ENV) - denne
 * listen begrenser KUN env-fallbacken, ikke hvelvtilgangen. Se D-437.
 */
export const WORKER_CONNECTOR_ENV = [
  "JARVIS_EMAIL_TOKEN",
  "JARVIS_GITHUB_ALLOW_OTHER_REPOS",
  "JARVIS_GITHUB_API_BASE",
  "JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK",
  "JARVIS_GITHUB_APP_ID",
  "JARVIS_GITHUB_APP_INSTALLATION_ID",
  "JARVIS_GITHUB_REPO",
  "JARVIS_GITHUB_TOKEN",
  "JARVIS_GIT_CREDENTIAL_TOKEN",
  "JARVIS_GOOGLE_ACCOUNT",
  "JARVIS_GOOGLE_CLIENT_ID",
  "JARVIS_GOOGLE_CLIENT_SECRET",
  "JARVIS_GOOGLE_TOKEN",
  "JARVIS_NEONOMICS_ENVIRONMENT",
  "JARVIS_NEONOMICS_REALM",
  "JARVIS_SUPPORT_INBOX_EMAILS",
  "JARVIS_SUPPORT_SLA_HOURS",
  "JARVIS_TELEGRAM_CHAT_ID",
  "JARVIS_TELEGRAM_TOKEN",
  "JARVIS_VIPPS_ENVIRONMENT",
  "JARVIS_WALLESTER_ENVIRONMENT"
];
/** Webhook-hemmeligheter - KUN api (mottar webhooks). */
export const WEBHOOK_ENV = [
  // WP-G1 (D-463, UA-7): signeringshemmeligheter for POST /webhooks/comms/{slack,meta,twilio,telnyx}. Twilio-ruten bruker den EKSISTERENDE JARVIS_TWILIO_AUTH_TOKEN (MESSAGING_AUTOMATION_ENV). Tom/manglende = ruten svarer 503 (fail-closed).
  "JARVIS_META_APP_SECRET",
  "JARVIS_META_WEBHOOK_VERIFY_TOKEN",
  "JARVIS_NEONOMICS_WEBHOOK_API_KEY",
  // WP-D2 (UA-3 «churn/product usage»): HMAC-hemmelighet for POST /webhooks/product-usage (eierens egne produkter). Tom = ruten svarer 503 selv om tenanten er satt.
  "JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET",
  "JARVIS_SLACK_SIGNING_SECRET",
  "JARVIS_STRIPE_WEBHOOK_SECRET",
  "JARVIS_TELNYX_WEBHOOK_PUBLIC_KEY",
  "JARVIS_VIPPS_WEBHOOK_SECRET",
  "JARVIS_WALLESTER_WEBHOOK_BASIC_PASSWORD",
  "JARVIS_WALLESTER_WEBHOOK_BASIC_USER"
];
/**
 * WP-G1 (D-463, UA-7 Communications Hub): flagg og IKKE-hemmelig konfigurasjon for felles utgående kommunikasjon, innkommende webhooks, kontakter, møtetranskripsjon, utgående AI-ringing og oppfølgingssveip.
 * ALT er AV som standard (kun den eksakte verdien `on` slår et flagg på; tom = AV) og NOT VERIFIED. KUN api (worker kjører ingen kommunikasjonsflate). Ingen hemmeligheter her - credentials er vault-referansene
 * (`JARVIS_SLACK_BOT_TOKEN` m.fl. i CONNECTOR_ENV/MESSAGING_AUTOMATION_ENV) og signeringshemmelighetene i WEBHOOK_ENV.
 */
export const COMMS_ENV = [
  "JARVIS_COMMS_AI_DISCLOSURE_TEXT",
  "JARVIS_COMMS_CALLS",
  "JARVIS_COMMS_CALL_WINDOW_END",
  "JARVIS_COMMS_CALL_WINDOW_START",
  "JARVIS_COMMS_CHANNELS",
  "JARVIS_COMMS_CONTACTS",
  "JARVIS_COMMS_CONTENT_PEPPER",
  "JARVIS_COMMS_INBOUND_RETENTION_DAYS",
  "JARVIS_COMMS_LOG_RETENTION_DAYS",
  "JARVIS_COMMS_MAX_CALLS_PER_NUMBER_DAY",
  "JARVIS_COMMS_MAX_COLD_PER_RECIPIENT_DAY",
  "JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR",
  "JARVIS_COMMS_MAX_PER_RECIPIENT_DAY",
  "JARVIS_COMMS_MEDIA_URL_HOSTS",
  "JARVIS_COMMS_MEETINGS",
  "JARVIS_COMMS_MEETING_RETENTION_DAYS",
  "JARVIS_COMMS_MEMORY_SPACE",
  "JARVIS_COMMS_OUTBOUND",
  "JARVIS_COMMS_PUBLIC_BASE_URL",
  "JARVIS_COMMS_QUIET_END",
  "JARVIS_COMMS_QUIET_HOURS",
  "JARVIS_COMMS_QUIET_START",
  "JARVIS_COMMS_REPLY_AFTER_HOURS",
  "JARVIS_COMMS_REPLY_SWEEP",
  "JARVIS_COMMS_REPLY_WINDOW_DAYS",
  "JARVIS_COMMS_TEMPLATES_WITH_DISCLOSURE",
  "JARVIS_COMMS_TENANT_ID",
  "JARVIS_COMMS_VENDOR_READS",
  "JARVIS_COMMS_WEBHOOKS",
  "JARVIS_META_GRAPH_VERSION"
];
/** Media-/hjem-/underholdnings-leverandører - KUN api. */
export const MEDIA_HOME_ENV = [
  "JARVIS_APNS_AUTH_KEY",
  "JARVIS_APPLE_MUSIC_TOKEN",
  "JARVIS_APPLE_SHORTCUTS_TOKEN",
  "JARVIS_APPLE_WATCH_TOKEN",
  "JARVIS_DEEPGRAM_API_KEY",
  "JARVIS_ELEVENLABS_API_KEY",
  "JARVIS_ELEVENLABS_VOICE_ID",
  "JARVIS_FOLIO_API_KEY",
  "JARVIS_GOOGLE_VEO_API_KEY",
  "JARVIS_HIGGSFIELD_KEY_ID",
  "JARVIS_HIGGSFIELD_KEY_SECRET",
  "JARVIS_HOMEKIT_TOKEN",
  "JARVIS_IOS_SHORTCUTS_TOKEN",
  "JARVIS_KLING_ACCESS_KEY",
  "JARVIS_KLING_SECRET_KEY",
  "JARVIS_LIVEKIT_API_KEY",
  "JARVIS_OPENAI_IMAGES_API_KEY",
  "JARVIS_OPENAI_REALTIME_API_KEY",
  "JARVIS_PHILIPS_HUE_API_KEY",
  "JARVIS_RUNWAY_API_KEY",
  "JARVIS_SPOTIFY_CLIENT_ID",
  "JARVIS_SPOTIFY_CLIENT_SECRET",
  "JARVIS_SPOTIFY_REFRESH_TOKEN"
];
/** Meldings-/automasjons-leverandører - KUN api (worker kjører bare lese-minimumsflaten). */
export const MESSAGING_AUTOMATION_ENV = [
  "JARVIS_MAKE_API_BASE_URL",
  "JARVIS_MAKE_API_KEY",
  "JARVIS_N8N_API_BASE_URL",
  "JARVIS_N8N_API_KEY",
  "JARVIS_PLAYWRIGHT_API_KEY",
  "JARVIS_TELNYX_API_KEY",
  "JARVIS_TELNYX_FROM_NUMBER",
  "JARVIS_TWILIO_ACCOUNT_SID",
  "JARVIS_TWILIO_AUTH_TOKEN",
  "JARVIS_TWILIO_FROM_NUMBER",
  "JARVIS_WHATSAPP_PHONE_NUMBER_ID",
  "JARVIS_WHATSAPP_TOKEN",
  "JARVIS_ZAPIER_API_KEY"
];
/** Brukes kun av host-akseptansescript som leser vertsmiljøet direkte - sendes til INGEN container. */
export const TEST_ONLY_ENV = [
  "JARVIS_GOOGLE_CLIENT_SECRET_JSON",
  "JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID",
  "JARVIS_GOOGLE_EMAIL_REAUTH_PORT",
  "JARVIS_GOOGLE_OAUTH_CLIENT_TYPE",
  "JARVIS_GOOGLE_REAUTH_PORT",
  "JARVIS_GOOGLE_SHEETS_TEST_SPREADSHEET_ID",
  "JARVIS_STRIPE_CLI_BIN",
  "JARVIS_STRIPE_TEST_SECRET_KEY"
];

/** Faste, ikke-hemmelige tjenestekoblinger som settes som literaler i compose (ikke videresendt fra .env). */
export const FIXED_ENV = {
  // D-395 (JARVIS-092): JSONL-sporfilen MÅ ligge på tmpfs (rootfs er read-only, default `var/traces.jsonl` ga EROFS), og api når voice-gateway på
  // tjenestenavnet (uten JARVIS_VOICE_URL viste /status alltid «ikke konfigurert»).
  api: { JARVIS_DB_HOST: "postgres", JARVIS_DB_PORT: "5432", INFISICAL_URL: "http://infisical:8080", JARVIS_TRACE_FILE: "/tmp/traces.jsonl", JARVIS_VOICE_URL: "http://voice-gateway:3020" },
  worker: { JARVIS_DB_HOST: "postgres", JARVIS_DB_PORT: "5432", INFISICAL_URL: "http://infisical:8080", JARVIS_TRACE_FILE: "/tmp/traces.jsonl" }
};

// D-437: browser-gateway-token-hemmeligheten (HMAC-nøkkel for browser-kall) trengs ikke av den read-only bakgrunnsflaten.
const WORKER_EXCLUDES = new Set(["JARVIS_BRIEF_HOUR", "JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"]);

/** Hva hver tjeneste får videresendt fra operatørens `.env` (interpolasjon `${NAVN:-}` i compose). */
export const SERVICE_ENV = {
  api: [...CORE_ENV, ...MODEL_ENV, ...CONNECTOR_ENV, ...WEBHOOK_ENV, ...MEDIA_HOME_ENV, ...MESSAGING_AUTOMATION_ENV, ...COMMS_ENV, "LANGFUSE_BASE_URL", "JARVIS_API_PORT", "JARVIS_OPERATIONAL_RETENTION_SWEEP_HOUR", "JARVIS_CONSTITUTION_PUBKEY_SHA256",
    // D-433: nød-/utviklingsbryter - API-et tømmer `executive`-køen selv (standard: worker-containeren eier køen).
    "JARVIS_API_DRAINS_EXECUTIVE",
    // EV-1 (D-412): bygg-sha og versjon som selvdiagnosen viser (uten dem vises bygget som UKJENT).
    "JARVIS_BUILD_SHA", "JARVIS_VERSION",
    // WP-B (D-452): evolusjonsobservatoriet (kun lesing) - porter eieren har verifisert og forhåndsgodkjent failover. L6 (gjennomgang av PR #313): jobb-runner-variablene (`JARVIS_JOB_RUNNER/IMAGE/NETWORK/EGRESS_PROXY`) går
    // KUN til worker (se under): API-et utfører ingen kodejobber, og egress-proxyen kan avsløre intern topologi/legitimasjon. Aktiveringsberedskapen for EV-6 ser derfor «jobb-runner konfigurert» som UKJENT i API-et,
    // og eieren erklærer det med `JOB_RUNNER_CONFIGURED` i `JARVIS_EV_VERIFIED_GATES` når han har verifisert det på verten.
    "JARVIS_EV_VERIFIED_GATES", "JARVIS_EV_PREAPPROVED_FAILOVER",
    // EV-3 (D-452): radar-kilder eieren selv velger (inert uten) og klokkeslett for det planlagte sveipet.
    "JARVIS_RADAR_SOURCES", "JARVIS_RADAR_SWEEP_HOUR",
    // D-414: «chat først» - bakgrunnsformål venter mens chat pågår (maks / stillhet, ms).
    "JARVIS_BACKGROUND_YIELD_MAX_MS", "JARVIS_BACKGROUND_YIELD_QUIET_MS", "JARVIS_TRACE_FILE", "JARVIS_VOICE_URL", "JARVIS_COUNCIL_AUTO_MAX_PER_HOUR",
    // WP-D4 (JARVIS-033): kandidatkjeden for vanlig prat og om den siste reserven (D-354/D-404) er tillatt.
    "JARVIS_CHAT_CANDIDATES", "JARVIS_CHAT_AUTO_FALLBACK",
    // WP-D4 (JARVIS-078): rådets forslagsvei (AV som standard) - rådet kan foreslå én handling fra chattens handlingsnivå, som legges frem som en bekreftelse. Rådet utfører aldri noe.
    "JARVIS_COUNCIL_PROPOSALS",
    // WP-C4 (Value Center): V2 oppfølgingsvarsel (AV som standard), V5-forslag (AV som standard) og eier-erklærte porter for V3-beredskap. Ingen hemmeligheter - kun flagg, tall og portnavn.
    "JARVIS_V2_PUSH_ENABLED", "JARVIS_V2_PUSH_MAX_PER_DAY", "JARVIS_V2_PUSH_QUIET_START", "JARVIS_V2_PUSH_QUIET_END", "JARVIS_V2_PUSH_TITLES", "JARVIS_V5_PROPOSALS_ENABLED", "JARVIS_VALUE_VERIFIED_GATES",
    // D-395 (JARVIS-092): sveip-klokkeslett main.ts leser (tidligere ikke videresendt til containeren, så compose kunne aldri endre dem).
    "JARVIS_BUSINESS_EVENTS_SYNC_HOUR", "JARVIS_BUSINESS_SCORING_HOUR", "JARVIS_BUSINESS_SWEEP_HOUR", "JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR", "JARVIS_BUSINESS_WEEKLY_BRIEF_WEEKDAY", "JARVIS_CONNECTOR_HEALTH_SWEEP_HOUR", "JARVIS_CONVERSATION_GRAPH_SYNC_HOUR", "JARVIS_FINANCE_RECONCILE_HOUR", "JARVIS_FINANCE_SPEND_SWEEP_HOUR", "JARVIS_GROWTH_RECOMMENDATION_SWEEP_HOUR", "JARVIS_HEALTH_RETENTION_SWEEP_HOUR", "JARVIS_LOCATION_RETENTION_SWEEP_HOUR", "JARVIS_SITUATION_SWEEP_HOUR", "JARVIS_SUPPORT_INBOX_SYNC_HOUR", "JARVIS_VISION_RETENTION_SWEEP_HOUR", "JARVIS_STREAM_DEBUG",
    // WP-E1 (JARVIS-068): incident-produsentene i api-prosessen - intervall (ms), grener hvis utrullinger teller, og repoer som leses aktivt for nye Actions-kjøringer (tom = ingen polling). Ingen hemmeligheter.
    "JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS", "JARVIS_INCIDENT_DEPLOY_REFS", "JARVIS_INCIDENT_DEPLOY_REPOS",
    // WP-K (D-471, JARVIS-053): oppbevaring (dager, 30..3650, standard 90) for den varige policy-journalen - retensjonssveipet kjører i api-prosessen.
    "JARVIS_POLICY_AUDIT_RETENTION_DAYS",
    // WP-D2 (JARVIS-044/Q-48): dashbord-ruten for å opprette en bedrifts-tenant er AV som standard (api-only; CLI-en trenger ikke flagget).
    "JARVIS_BUSINESS_TENANT_PROVISIONING",
    // WP-D2 (UA-3 «churn/product usage»): bedrifts-tenanten produktbruk-webhooken skriver til (api-only; tom = ruten finnes ikke, 404).
    "JARVIS_PRODUCT_USAGE_TENANT_ID",
    // WP-C2 (OPS-RUNTIME): ekstern oppetids-heartbeat (AV som standard; pinger kun mens en lokal selvsjekk består) og stien til den SKRIVEBESKYTTEDE backup-statusfilen
    // (monteres `:ro` med infra/backup/docker-compose.backup-status.yml - aldri selve backup-mappen).
    "JARVIS_UPTIME_HEARTBEAT_URL", "JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC", "JARVIS_BACKUP_STATUS_FILE",
    // WP-D1 (Q-26): kildeverifisering - skriving er AV som standard (kun «on» slår den på), og standard antall uavhengige kilder for VERIFIED (2..10).
    "JARVIS_KNOWLEDGE_CLAIM_WRITES", "JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES",
    // WP-H1 (UA-11, JARVIS-087 del 2): kontrollsentrene Finans/Minne/Agenter (AV som standard; kun den eksakte verdien «on» slår dem på) og proveniens på nye styringsjournal-poster (AV som standard). Api-only; ingen hemmeligheter.
    // Uten disse linjene når en verdi i `.env` aldri containeren (compose sender kun det manifestet lister) - flaggene ville vært stille virkningsløse.
    "JARVIS_CONTROL_CENTER_FINANCE", "JARVIS_CONTROL_CENTER_MEMORY", "JARVIS_CONTROL_CENTER_AGENT", "JARVIS_GOVERNANCE_PROVENANCE",
    // WP-H2 (UA-11): kontrollsentrene Drift/Verdi/Personvern/Sikkerhet og de to enkeltfunksjonene golden-suite-knappen og tilbakekall av autonomi-binding. Alle AV som standard (kun eksakt «on»), api-only, ingen hemmeligheter.
    "JARVIS_CONTROL_CENTER_OPERATIONS", "JARVIS_CONTROL_CENTER_VALUE", "JARVIS_CONTROL_CENTER_PRIVACY", "JARVIS_CONTROL_CENTER_SECURITY", "JARVIS_CONTROL_GOLDEN_SUITE", "JARVIS_CONTROL_AUTONOMY_REVOKE",
    // WP-D3 (UA-4 Growth, D-459): skrivehandlinger mot annonse-/analyseplattformene (plattformliste, eierens EGNE konto-/eiendoms-id-er, tillatte kreativ-verter) og eksperimentregisteret. ALLE AV som standard
    // (tom/manglende = ingen verktøy, ingen rute). Api-only (bakgrunnsflaten er read-only). Ingen hemmeligheter - kun flagg og eksakte, ikke-hemmelige id-er; credentials er vault-referansene i CONNECTOR_ENV.
    "JARVIS_GROWTH_WRITE_PLATFORMS", "JARVIS_GROWTH_WRITE_TARGETS", "JARVIS_GROWTH_CREATIVE_URL_HOSTS", "JARVIS_GROWTH_EXPERIMENTS",
    // WP-B3 (D-475, EV-22/EV-23): tilleggssenteret Evolusjon og eierens avgjørelse om et endringsforslag (kun en registrering, ingen virkning). Begge AV som standard; kun eksakt «on», api-only, ingen hemmeligheter.
    "JARVIS_CONTROL_CENTER_EVOLUTION", "JARVIS_CONTROL_EVOLUTION_APPROVAL",
    // WP-G2 (D-464, UA-8 Personal Twin): kritiske hjem-/bilhandlinger, familie/delte rom, helse-inntak, Apple CalDAV/CardDAV, personlig økonomi-lesing og kontekstmotor. ALLE AV som standard (kun eksakt «on»; tom/manglende
    // liste = ingenting tillatt), api-only (worker/bakgrunn er read-only). Ikke-hemmelig konfigurasjon (eierens EGNE entitets-/kjøretøy-id-er, settle-tid, konto-referanser) + vault-referanser (alarmkode, iCloud-bruker og
    // app-spesifikt passord - verdiene leses via `SecretProvider`, aldri her). Uten disse linjene når en verdi i `.env` aldri containeren og flaggene ville vært stille virkningsløse (vakt: `wpg2-flags-wiring.test.ts`).
    "JARVIS_PERSONAL_HOME_CRITICAL", "JARVIS_PERSONAL_HOME_TARGETS", "JARVIS_PERSONAL_HOME_SETTLE_MS", "JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN", "JARVIS_PERSONAL_CAR", "JARVIS_PERSONAL_CAR_TARGETS", "JARVIS_PERSONAL_CAR_SETTLE_MS",
    "JARVIS_PERSONAL_FAMILY", "JARVIS_PERSONAL_HEALTH_INGEST", "JARVIS_PERSONAL_APPLE_DAV", "JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS", "JARVIS_PERSONAL_FINANCE_READ", "JARVIS_PERSONAL_CONTEXT",
    "JARVIS_PERSONAL_HOME_ALARM_CODE", "JARVIS_PERSONAL_CAR_CREDENTIAL", "JARVIS_PERSONAL_APPLE_DAV_USER", "JARVIS_PERSONAL_APPLE_DAV_APP_PASSWORD",
    // WP-G3 (D-465, UA-9): kamerabilder (hendelses-øyeblikksbilder), lokal klassifisering, bilde-lagring, HA-poller og iPhone-opptak. ALLE AV som standard (kun eksakt «on» slår dem på; JARVIS_VISION_ENABLED er hovedbryter),
    // api-only (bakgrunnsflaten bruker dem ikke). Ingen hemmeligheter - kun flagg, tall, en lokal modell-URL og en lagringsmappe. HA-credentials er de EKSISTERENDE JARVIS_HA_BASE_URL/JARVIS_HA_TOKEN (vault-kjeden).
    // JARVIS_VISION_LOCAL_URL MÅ peke til en lokal/privat adresse (kamerabilder forlater aldri maskinen) - validert ved oppstart. JARVIS_VISION_RETENTION_SWEEP_HOUR er videresendt fra før (D-153).
    "JARVIS_VISION_ENABLED", "JARVIS_VISION_CLASSIFIER", "JARVIS_VISION_LOCAL_URL", "JARVIS_VISION_LOCAL_MODEL", "JARVIS_VISION_ALLOW_TAILSCALE", "JARVIS_VISION_MODEL_TIMEOUT_MS", "JARVIS_VISION_STORE_SNAPSHOTS", "JARVIS_VISION_STORAGE_DIR", "JARVIS_VISION_MAX_STORED_MB",
    "JARVIS_VISION_HA_POLL", "JARVIS_VISION_POLL_INTERVAL_SECONDS", "JARVIS_VISION_MAINTENANCE_INTERVAL_MINUTES", "JARVIS_VISION_MAINTENANCE_HOUR",
    // WP-G4 (D-466, UA-10): samlet hendelsesabonnement (abonnementsregister, inntaksbuss, hendelsesløper) med hjem-/kamera-/helse-/hendelseskilder, modellassistert vurdering og tilbakemeldingslæring. ALLE AV som standard (kun eksakt «on»;
    // JARVIS_SITUATION_SIGNALS er hovedbryter, de begrensede kildene helse og kamera har hvert sitt eksplisitte flagg), api-only. Ingen hemmeligheter - kun flagg og tall (vakt: `wpg4-flags-wiring.test.ts`).
    "JARVIS_SITUATION_SIGNALS", "JARVIS_SITUATION_HOME", "JARVIS_SITUATION_VISION", "JARVIS_SITUATION_HEALTH", "JARVIS_SITUATION_INCIDENTS", "JARVIS_SITUATION_MODEL_ASSIST", "JARVIS_SITUATION_FEEDBACK",
    "JARVIS_SITUATION_BUS_INTERVAL_SECONDS", "JARVIS_SITUATION_LOG_RETENTION_DAYS",
    // WP-N1 (Q-66, JARVIS-101): «begrenset»-merking av samtalehistorikken (messages.restricted) og utførelseslås for finance/finance_* mot skymodeller (Q-64 pkt 3). AV som standard (kun eksakt «on»), api-only,
    // ingen hemmeligheter. Uten denne linjen når en verdi i `.env` aldri containeren og flagget ville vært stille virkningsløst (vakt: `wpn1-guard-env.test.ts`).
    "JARVIS_RESTRICTED_CONTEXT_GUARD"],
  worker: [...CORE_ENV.filter((n) => !WORKER_EXCLUDES.has(n)), ...MODEL_ENV, ...WORKER_CONNECTOR_ENV, "LANGFUSE_BASE_URL", "JARVIS_TRACE_FILE", "JARVIS_CLAUDE_BIN", "JARVIS_JOB_RUNNER", "JARVIS_JOB_IMAGE", "JARVIS_JOB_NETWORK", "JARVIS_JOB_EGRESS_PROXY",
    // WP-C1 (D-32 / Q-45a): vertsside job-runner (JARVIS_JOB_RUNNER=host). Socket-katalogen og tokenfilen monteres inn via infra/job-runner/docker-compose.job-runner.yml
    // (valgfri override) - uten den, og med tomme verdier her, feiler hver kodejobb lukket som før.
    "JARVIS_JOB_RUNNER_SOCKET", "JARVIS_JOB_RUNNER_TOKEN_FILE",
    // WP-D1 (UA-2): konfigurerte kunnskapskilder (dvale uten), allowlistede basemapper for filsystemkilder og det valgfrie modellassisterte entitetspasset (AV som standard).
    "JARVIS_KNOWLEDGE_SOURCES", "JARVIS_KNOWLEDGE_FS_ROOTS", "JARVIS_KNOWLEDGE_ENTITY_LLM"],
  // migrate: engangs-jobb med ADMIN-rollen (CREATE ROLE/EXTENSION/RLS) - IKKE en runtime-tjeneste. Får den distinkte
  // runtime-rollens passord for å opprette rollen, men ingen connector-/modellnøkler.
  migrate: ["JARVIS_DB_ADMIN_USER", "JARVIS_DB_ADMIN_PASSWORD", "JARVIS_DB_USER", "JARVIS_DB_PASSWORD", "JARVIS_DB_CONNECT_TIMEOUT_MS", "JARVIS_ENV", "JARVIS_TENANT_ID", "JARVIS_OWNER_PERSON_ID", "JARVIS_OWNER_NAME"],
  voice: ["OPENAI_API_KEY", "JARVIS_DEEPGRAM_API_KEY", "JARVIS_DEEPGRAM_LANG", "JARVIS_ELEVENLABS_API_KEY", "JARVIS_ELEVENLABS_VOICE_ID", "JARVIS_VOICE_VAD_THRESHOLD", "JARVIS_VOICE_VAD_HANGOVER_MS", "JARVIS_VOICE_PORT",
    // D-390: adaptiv VAD, pre-roll, fyllord, talt verktøystatus, piper-samplerate, whisper-tråder/-prompt.
    "JARVIS_VOICE_VAD_ADAPTIVE", "JARVIS_VOICE_PREROLL_MS", "JARVIS_VOICE_FILLER_MS", "JARVIS_VOICE_SPEAK_TOOL_ACTIVITY", "JARVIS_PIPER_SAMPLE_RATE", "JARVIS_WHISPER_THREADS", "JARVIS_WHISPER_PROMPT",
    // D-403: egen Whisper-server (privat adresse) med lokal fallback.
    "JARVIS_STT_REMOTE_URL", "JARVIS_STT_REMOTE_MODEL", "JARVIS_STT_REMOTE_TIMEOUT_MS", "JARVIS_WHISPER_LANG"],
  browser: ["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET", "JARVIS_BROWSER_GATEWAY_PORT"]
};
