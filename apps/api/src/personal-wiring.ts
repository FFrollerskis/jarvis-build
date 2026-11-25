import type pg from "pg";
import { FamilyService } from "@jarvis/context";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { KillSwitch, OwnerControls } from "@jarvis/policy";
import { BankingService } from "@jarvis/finance";
import { HEALTH_INTAKE_MAX_DELETES, HEALTH_INTAKE_MAX_SAMPLES, HEALTH_INTAKE_SOURCE_TYPE, HealthIntakeService, HealthService, MetricTypeSchema } from "@jarvis/health";
import { LocationService } from "@jarvis/location";
import {
  AppleDavClient, FetchDavTransport, PERSONAL_CONFIG_NAMES, parseDavCollections, type DavSendGuard,
  CAR_CRITICAL_OPS, CAR_READ_ACTION, CAR_TOOL_ID, CarTransport, UnconfiguredCarAdapter, carCriticalConfigFromEnv, carCriticalToolDefinitions,
  HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HOME_ASSISTANT_TOOL_ID, HomeAssistantCriticalTransport, PERSONAL_FLAG_NAMES, PERSONAL_SECRET_REFS, PersonalActionJournal,
  executePersonalAction, homeCriticalConfigFromEnv, homeCriticalToolDefinitions, homeSettleMsFor, legacyCriticalActionsToDrop, personalActionIndex, personalFlagOn, reconcilePersonalAction,
  type CarAdapter, type ExecutePersonalActionInput, type PersonalActionIndexEntry, type ReconcileInput, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { familySharedDataReaders, type HealthReadApi, type LocationReadApi } from "./personal-family-readers.ts";
import { createDavRateLimit, davAuditDecision, type DavRateLimits, type PersonalDavDeps } from "./personal-dav.ts";
import { FINANCE_READ_VIEWS, type PersonalFinanceDeps } from "./personal-finance-read.ts";
import type { PersonalActionDomainDeps, PersonalApiDeps, PersonalFamilyDeps, PersonalHealthDeps } from "./personal-routes.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin): ÉN komposisjonsfunksjon for hele personlig-domenet (verktøy + rute-avhengigheter + oppstartslogg). ALT er dormant: uten `JARVIS_PERSONAL_*`-flagg returnerer den tom verktøyliste,
 * identitets-filter og `deps: undefined` - verktøylister, utvalg, rate-grenser og ruter er da identiske med main (bevist av seksjon A i `wpg2-personal-routes.test.ts`, `wpg2-family-routes.test.ts`, `wpg2-health-intake.test.ts`, `wpg2-apple-dav-routes.test.ts` og de eksisterende `wph1`/`wph2`-baselinene). Kun API-prosessen kaller den (worker/bakgrunn er read-only).
 * `main.ts` trenger tre små kroker: `...personal.tools` blant tilleggsverktøyene, `personal.filterTools(...)` rundt `firstWaveTools(...)` og `...(personal.deps ? { personal: personal.deps } : {})` i `ApiDeps`.
 */
export interface PersonalWiring {
  /** Verktøy som skal registreres (tom uten flagg). */
  tools: ToolDefinition[];
  /** Identitet uten flagg. Med `JARVIS_PERSONAL_HOME_CRITICAL=on` fjernes de gamle uherdede `home-assistant.lock_set`/`alarm_set` (ellers ville de leve side om side med den strenge familien uten allowlist og step-up). */
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  /** Rute-avhengigheter; `undefined` uten noe flagg (da finnes ikke `/personal/*`). */
  deps: PersonalApiDeps | undefined;
  /** Oppstartslogg: `null` uten flagg (ingen ekstra loggline, oppstarten er identisk med main). */
  describe(): Record<string, unknown> | null;
}

export interface PersonalWiringInput {
  env: Readonly<Record<string, string | undefined>>;
  pool: pg.Pool;
  gateway: Pick<ToolGateway, "execute" | "get">;
  /** Leser en hemmelighet/konfig via vault-referanse (aldri fra parametre). */
  readSecret: (ref: string) => Promise<string | null>;
  /**
   * Bil-adapteren. Uten verdi brukes `UnconfiguredCarAdapter` (INGEN leverandør er valgt, D-64): hver bil-handling feiler lukket. En ekte adapter kobles inn HER først etter at Tobias har besluttet leverandør
   * (og, hvis det er et aggregat-API, `CORE_DEPENDENCY_DECISION_REQUIRED` er besvart).
   */
  carAdapter?: CarAdapter;
  /** Den suverene eierens person-id (eierkonfigurasjonen). Uten den registreres IKKE familie-rutene selv om flagget er på (fail closed: ingen kan opprette sirkelen). */
  ownerPersonId?: string;
  /** Lesere for delt lokasjon/helse (tester gir fakes; i drift opprettes de fra `pool`). */
  locationReader?: LocationReadApi;
  healthReader?: HealthReadApi;
  /** IANA-tidssone for «skritt i dag» (standard `Europe/Oslo`). */
  timeZone?: string;
  /**
   * Eierens stoppkontroller (fiks-runde review B MEDIUM-1): DAV-rutene går utenom ToolGateway, så kill switch og credential-revokering må sjekkes av dem selv, FØR hver utsendelse. Uten denne registreres IKKE DAV-rutene (fail closed).
   * Må være de SAMME instansene som `PolicyGateway`/`ToolGateway` bruker (LIVE `*Durable`-sjekker, delt mellom prosesser).
   */
  controls?: { killSwitch: Pick<KillSwitch, "isActiveDurable">; ownerControls: Pick<OwnerControls, "isRevokedDurable"> };
  /** Grenser per prinsipal for DAV-rutene (WP-G2c, JARVIS-113 e/6); utelatt = `DEFAULT_DAV_RATE_LIMITS`. Ugyldige verdier faller tilbake til standarden (aldri «ingen grense»). Ingen miljøvariabel: grensene er en kodebeslutning. */
  davRateLimits?: Partial<DavRateLimits>;
  /** KUN tester: virtuell klokke for HA-transportens venteløkke (uten den brukes ekte tid). Gjør at «domenets ventetid brukes faktisk» kan bevises gjennom selve oppkoblingen uten å vente 90 s (fiks-runde 2, review A NY-2). */
  homeTimers?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
}

export function createPersonalWiring(input: PersonalWiringInput): PersonalWiring {
  const { env, pool, gateway, readSecret } = input;
  const tools: ToolDefinition[] = [];
  const entries: PersonalActionIndexEntry[] = [];
  const domains = new Map<string, PersonalActionDomainDeps>();
  const log: Record<string, unknown> = {};
  let dropLegacyHome = false;

  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.homeCritical)) {
    const config = homeCriticalConfigFromEnv(env);
    const transport = new HomeAssistantCriticalTransport({
      baseUrl: () => readSecret("JARVIS_HA_BASE_URL"), alarmCode: () => readSecret(PERSONAL_SECRET_REFS.homeAlarmCode), settleMs: config.settleMs, pollMs: config.pollMs,
      ...(config.settleMsByDomain ? { settleMsByDomain: config.settleMsByDomain } : {}),
      ...(input.homeTimers?.now ? { now: input.homeTimers.now } : {}), ...(input.homeTimers?.sleep ? { sleep: input.homeTimers.sleep } : {})
    });
    tools.push(...homeCriticalToolDefinitions(transport, config));
    dropLegacyHome = true;
    domains.set("home", { toolId: HOME_ASSISTANT_TOOL_ID, readAction: HOME_CRITICAL_READ_ACTION });
    entries.push(...HOME_CRITICAL_OPS.map((op): PersonalActionIndexEntry => ({ domain: "home", toolId: HOME_ASSISTANT_TOOL_ID, op })));
    // `targets: 0` er en gyldig (fail-closed) tilstand: verktøyene finnes, men hver mutasjon nektes til eieren har listet sine egne entiteter.
    log["home_critical"] = { targets: config.targets.size, settle_ms: config.settleMs, alarm_settle_ms: homeSettleMsFor(config, "alarm_control_panel"), legacy_lock_alarm_removed: true };
  }

  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.car)) {
    const config = carCriticalConfigFromEnv(env);
    const adapter = input.carAdapter ?? new UnconfiguredCarAdapter();
    tools.push(...carCriticalToolDefinitions(new CarTransport({ adapter, settleMs: config.settleMs, pollMs: config.pollMs }), config));
    domains.set("car", { toolId: CAR_TOOL_ID, readAction: CAR_READ_ACTION });
    entries.push(...CAR_CRITICAL_OPS.map((op): PersonalActionIndexEntry => ({ domain: "car", toolId: CAR_TOOL_ID, op })));
    log["car"] = { targets: config.targets.size, settle_ms: config.settleMs, adapter: adapter.name, live: adapter.name === "unconfigured" ? "BLOCKED_EXTERNAL" : "configured" };
  }

  // Eksekutoren bygges ETTER at alle domener har registrert sine handlinger: indeksen er en ferdig bygd Map (en handling som legges til etterpå ville vært ukjent for ruten).
  const executor = { pool, gateway, journal: new PersonalActionJournal(pool), index: personalActionIndex(entries) };
  const actions = domains.size > 0
    ? {
      executor, domains, run: (identity: IdentityContext, request: ExecutePersonalActionInput) => executePersonalAction(executor, identity, request),
      // WP-G2c (D-483): avstemming av `outcome_unknown` (kun eier-ruten `/personal/actions/reconcile`; leser via lese-handlingen, aldri skrive-verktøyet, aldri en retry).
      reconcile: (identity: IdentityContext, request: ReconcileInput) => reconcilePersonalAction({ executor, domains }, identity, request)
    }
    : undefined;

  let family: PersonalFamilyDeps | undefined;
  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.family)) {
    if (input.ownerPersonId === undefined || input.ownerPersonId.length === 0) {
      log["family"] = { registered: false, reason: "owner_person_id_missing" };
    } else {
      const timeZone = input.timeZone ?? "Europe/Oslo";
      const readers = familySharedDataReaders({ location: input.locationReader ?? new LocationService(pool), health: input.healthReader ?? new HealthService(pool), timeZone });
      family = { service: new FamilyService(pool, { readers }), ownerPersonId: input.ownerPersonId };
      log["family"] = { registered: true, shared_categories: ["location", "health_summary"], time_zone: timeZone };
    }
  }

  // Helse-inntaket (P1d): KUN en rute (`POST /personal/health/ingest`), aldri et verktøy - helsedata skal ikke kunne nå en modell. Uten flagg finnes ingen rute (404).
  let health: PersonalHealthDeps | undefined;
  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.healthIngest)) {
    health = { intake: new HealthIntakeService(pool) };
    log["health_ingest"] = { registered: true, source_type: HEALTH_INTAKE_SOURCE_TYPE, max_samples: HEALTH_INTAKE_MAX_SAMPLES, max_deletes: HEALTH_INTAKE_MAX_DELETES, metrics: MetricTypeSchema.options.length };
  }

  // Personlig økonomi-lesing (P2f): KUN en rute (`POST /personal/finance/read`), aldri et verktøy - finansdata er begrenset og skal ikke kunne nå en modell. `BankingService` konstrueres UTEN credentials: lesingen er ren database, ingen leverandørkall.
  let finance: PersonalFinanceDeps | undefined;
  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.financeRead)) {
    finance = { banking: new BankingService(pool) };
    log["finance_read"] = { registered: true, space: "personal", read_only: true, views: FINANCE_READ_VIEWS };
  }

  // Apple Kalender/Påminnelser/Kontakter (P2e): KUN ruter (`/personal/dav/*`), aldri verktøy. Samlingene er en allowlist fra eieren; passordet (app-spesifikt, D-108) hentes per forespørsel fra vaulten. Live mot iCloud er `BLOCKED_EXTERNAL`.
  let dav: PersonalDavDeps | undefined;
  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.appleDav) && input.controls === undefined) {
    // FAIL CLOSED (fiks-runde review B MEDIUM-1): uten kill switch og credential-revokering ville DAV-rutene (som går utenom ToolGateway) ikke kunne stoppes av eieren - da registreres de ikke.
    log["apple_dav"] = { registered: false, reason: "controls_missing" };
  } else if (personalFlagOn(env, PERSONAL_FLAG_NAMES.appleDav) && input.controls !== undefined) {
    const { collections, rejected } = parseDavCollections(env[PERSONAL_CONFIG_NAMES.appleDavAccounts]);
    const { killSwitch, ownerControls } = input.controls;
    // Stoppvakten FØR hver utsendelse (gatewayen hører kill switch og revokering for verktøykall; DAV er ruter utenom den): kill switch aktiv eller en av iCloud-referansene tilbakekalt = ingenting sendes.
    const guard: DavSendGuard = async () => {
      if (await killSwitch.isActiveDurable()) return "kill_switch_active";
      for (const ref of [PERSONAL_SECRET_REFS.appleDavUser, PERSONAL_SECRET_REFS.appleDavAppPassword]) if (await ownerControls.isRevokedDurable(ref)) return "credential_revoked";
      return null;
    };
    const transport = new FetchDavTransport({
      collections, guard,
      credentials: async () => {
        const [user, password] = [await readSecret(PERSONAL_SECRET_REFS.appleDavUser), await readSecret(PERSONAL_SECRET_REFS.appleDavAppPassword)];
        return user && password ? { user, password } : null;
      }
    });
    dav = {
      guard,
      rateLimit: createDavRateLimit(input.davRateLimits),
      client: new AppleDavClient({ transport, collections }),
      // Et forsøk stoppkontrollene stoppet (`decision: "DENY"`) skrives som `tool.denied` med årsaken - samme type som et avslått verktøykall, så sikkerhetssenteret teller den; alt annet er mutasjonssporet (`dav.mutation`). Aldri innhold.
      // `decision` følger UTFALLET (WP-G2c, JARVIS-113 e/7): ALLOW kun for `requested`/`SUCCESS`/`REPLAYED`; avvist, uavklart og avvikende readback er aldri ALLOW (se `davAuditDecision`).
      audit: (identity, entry) =>
        withTenantTransaction(pool, identity.tenant_id, (client) =>
          writeAudit(client, identity, {
            type: entry.decision === "DENY" ? "tool.denied" : "dav.mutation", decision: davAuditDecision(entry), ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            tool_id: "apple_dav", action: entry.action, payload: { collection: entry.collection, ...(entry.uid !== undefined ? { uid: entry.uid } : {}), outcome: entry.outcome, channel: identity.channel }
          })
        )
    };
    log["apple_dav"] = { registered: true, collections: collections.length, rejected_entries: rejected, live: "BLOCKED_EXTERNAL" };
  }

  const deps: PersonalApiDeps | undefined =
    actions || family || health || finance || dav
      ? { ...(actions ? { actions } : {}), ...(family ? { family } : {}), ...(health ? { health } : {}), ...(finance ? { finance } : {}), ...(dav ? { dav } : {}) }
      : undefined;
  return {
    tools,
    filterTools: (all) => (dropLegacyHome ? legacyCriticalActionsToDrop(all) : all),
    deps,
    describe: () => (Object.keys(log).length === 0 ? null : { msg: "personal_twin", ...log })
  };
}
