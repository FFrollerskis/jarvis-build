import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { homeAssistantSituationReadTools, type ToolDefinition, type ToolGateway, type ToolTransport } from "@jarvis/tool-gateway";
import type { SituationSignalApiDeps } from "./situation-signal-routes.ts";
import {
  boundedInt, DEFAULT_SIGNAL_LOG_RETENTION_DAYS, FeedbackService, MAX_OBSERVATIONS_PER_BATCH, ModelSignalAssist, MorningSummaryService, SignalLogService, SimulationService, SituationSignalBus, SituationSignalRunner, SubscriptionRegistry,
  SituationSignalsTransport, SituationsTransport, simulationToolInfoFrom, situationFlagsFromEnv, situationSignalsToolDefinitions, situationsToolDefinitions, SIGNAL_LOG_RETENTION_BOUNDS, SOURCE_SPACES,
  type AssistModelGateway, type DailyPoint, type DomainPauseRegistry, type HealthObservation, type HealthSignalMetric, type HomeObservation, type IncidentObservation, type SignalSourceReaders,
  type SituationEngine, type SituationFlags, type VisionObservation
} from "@jarvis/situations";

/**
 * WP-G4 (D-466), UA-10: kobling av det samlede hendelsesabonnementet til api-prosessen. ALT er AV som standard: uten `JARVIS_SITUATION_SIGNALS=on` bygges ingenting (ingen verktøy, ingen løper, ingen loggline) og
 * verktøylister, utvalg, intents, rate-grenser, ruter og det daglige sveipet er identiske med main. Underflaggene (`JARVIS_SITUATION_HOME|VISION|HEALTH|INCIDENTS|MODEL_ASSIST|FEEDBACK`) gjelder kun under hovedbryteren.
 *
 * Kildeportene her er TYNNE lim mot eksisterende tjenester (D-64): HA-tilstander via den eksisterende HA-connectoren gjennom ToolGateway (ny LESE-handling `read_state_detail`, klasse A), kamerahendelser via
 * `VisionService.getRecentEvents`, helse via `HealthService.getRecentMetrics`, hendelser via `IncidentService.listIncidents`. Disse injiseres STRUKTURELT fra `main.ts` (denne filen importerer aldri helse-/visjonspakken: helsedata skal
 * ikke kunne nå noen ny importør, se `wpg2-health-intake.test.ts`). Observasjonene som forlater en port er minimerte; rå helseverdier aggregeres til ett tall per døgn INNE i denne filen og forlater aldri prosessen.
 */
export interface SituationSignalsWiringDeps {
  env: NodeJS.ProcessEnv;
  pool: pg.Pool;
  engine: SituationEngine;
  domainPauses: DomainPauseRegistry;
  gateway: ToolGateway;
  /** Den ekte `ModelGateway` (strukturelt: `complete`). Alle modellkall går gjennom den (sensitivitetsruting først, så Claude-kreditten). */
  modelGateway: AssistModelGateway;
  /** WP-G4b K4: lokalitet slått opp LIVE mot modellregisteret (i drift `!servedByCloudModel`); snevrer inn assist-vaktens navneliste, widner aldri. Utelatt = kun navnelisten (uendret). */
  isLocalProvider?: (provider: string) => boolean;
  ownerIdentity: IdentityContext;
  /** Eierens tenant (løperen betjener kun denne). Navnet er bevisst ikke `ownerTenantId`: `wpg3-vision-runtime.test.ts` teller den strengen i main.ts (kun HA-polleren skal få eierens tenant dit). */
  ownerTenant: string;
  ownerPersonId: string;
  incidents: { listIncidents(tenantId: string, memorySpace: MemorySpace, status: "all"): Promise<Array<{ incident_id: string; title: string; status: string; severity: string; opened_at: string | Date }>> };
  vision: {
    getRecentEvents(tenantId: string, memorySpace: MemorySpace, personId: string, filter: { sinceMs?: number; limit?: number }): Promise<Array<{
      observation_id: string; event_type: string; source_instance_id: string; source_event_id: string; observed_at: string | Date; object_label: string | null; classification_status: string }>>;
    /** Kildens EGEN oppbevaring (G3): en signalsituasjon overlever aldri kameradataene. Valgfri (uten den brukes standard). */
    getRetentionPolicy?(tenantId: string, memorySpace: MemorySpace): Promise<{ retention_days: number } | null>;
  };
  /** `value` er `unknown`: helsemodulens `value`-kolonne er `numeric`, og node-postgres leverer det som STRENG (se `num()`). (Tabellnavnet står bevisst ikke her: G2-vakten tillater det kun i helsemodulen og slettekjeden.) */
  health: {
    getRecentMetrics(tenantId: string, personId: string, metricType: HealthSignalMetric, sinceMs?: number, limit?: number): Promise<Array<{ value: unknown; observed_at: string | Date }>>;
    /** Kildens EGEN oppbevaring (G2): en signalsituasjon overlever aldri helsedataene. Valgfri (uten den brukes standard). */
    getRetentionPolicy?(tenantId: string): Promise<{ retention_days: number } | null>;
  };
  /** HA-transporten (den samme som `home-assistant`-verktøyene bruker) for den nye lese-handlingen. */
  haTransport: ToolTransport;
  killSwitch: { isActiveDurable(): Promise<boolean> };
  now?: () => number;
}

export interface SituationSignalsWiring {
  flags: SituationFlags;
  tools: ToolDefinition[];
  runner: SituationSignalRunner | null;
  registry: SubscriptionRegistry | null;
  /** Eierens HTTP-flate `/situations/signals/*` (B-MEDIUM-5). `null` uten hovedbryteren = ingen ruter (404, identisk med main). */
  api: SituationSignalApiDeps | null;
  /** Startlogg (kun når noe er på). */
  describe(): Record<string, unknown> | null;
  /** Starter løperen (ingen effekt uten flagg). */
  start(): void;
}

const DAY_MS = 86_400_000;
const HEALTH_WINDOW_DAYS = 35;
/** B-LOW-6: tak per lesing (de NYESTE radene). Kamera: samme som bussens batch-tak. Helse: rå prøver per metrikk over 35 døgn (aggregeres til ett tall per døgn); treffer lesingen taket, er det en synlig advarsel. */
export const VISION_READ_LIMIT = MAX_OBSERVATIONS_PER_BATCH;
export const HEALTH_ROWS_LIMIT = 20_000;
const iso = (value: string | Date): string | null => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * B-HIGH-2 (fiks-runde): helsemodulens `value`-kolonne er `numeric`, og node-postgres leverer `numeric` som STRENG (ingen type-parser). `Number.isFinite("95")` er false, så ALLE rader ble droppet (tom serie, ingen signal, ingen feil).
 * Tall og tallstrenger (`-?\d+(\.\d+)?`) godtas; alt annet (NaN, uendelig, tom/tekst, objekt) er ugyldig og hoppes over. Samme regel som G2s `num()` i personal-family-readers.
 */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Aggregerer rå prøver til ÉN verdi per UTC-døgn (gjennomsnitt for hvilepuls, sum for søvn og skritt). De rå verdiene forlater aldri denne funksjonen. */
export function aggregateDaily(metric: HealthSignalMetric, rows: ReadonlyArray<{ value: unknown; observed_at: string | Date }>): DailyPoint[] {
  const days = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    const at = iso(row.observed_at);
    const value = num(row.value);
    if (at === null || value === null) continue;
    const day = at.slice(0, 10);
    const cur = days.get(day) ?? { sum: 0, n: 0 };
    cur.sum += value;
    cur.n += 1;
    days.set(day, cur);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, { sum, n }]) => ({ day, value: metric === "resting_heart_rate" ? sum / n : sum, samples: n }));
}

/**
 * Effekt i watt ut fra HAs tilstand og måleenhet: `W` (eller manglende enhet - antatt W) som den er, `kW` x 1000; en annen enhet (`MW`, `A`, `%`, ...) er ikke sammenlignbar med eierens grense i watt (`null` = ukjent, ingen påstand).
 * B-LOW-9: tidligere ble enheten aldri sjekket, så en sensor i kW (1,2) aldri kunne passere en grense på 2000 W.
 */
export function wattsOf(state: string, unit: unknown): number | null {
  const value = state.trim() === "" ? Number.NaN : Number(state);
  if (!Number.isFinite(value)) return null;
  if (unit === null || unit === undefined || unit === "W") return value;
  if (unit === "kW") return value * 1000;
  return null;
}

/**
 * Hjem: tilstander via ToolGateway (policy, kill switch, frys, credential-tilbakekall og revisjon gjelder). ÉN gateway-kjøring per tikk for ALLE abonnerte entiteter (`read_states_detail`, fiks-runde B-MEDIUM-4: ÉN revisjonsrad
 * per tikk i stedet for én per entitet). Ukjent entitet (en skrivefeil i entitets-id-en) og enkeltfeil er ikke kildefeil, men synlige ADVARSLER i tikkresultatet (`home_entities_unknown`/`home_entities_failed`); feiler hele kallet er det
 * en kildefeil (`home_source_unavailable`). Effekt-sensorer sporer «på rad over eierens grense» i minnet (en omstart nullstiller telleren: varselet kommer litt senere, aldri for tidlig).
 */
export function createHomeReader(deps: { gateway: Pick<ToolGateway, "execute">; identityFor: (tenantId: string, space: MemorySpace) => IdentityContext }): NonNullable<SignalSourceReaders["home"]> {
  const powerTracker = new Map<string, { since: string; ticks: number }>();
  return async (ctx, entities) => {
    if (entities.length === 0) return [];
    const identity = deps.identityFor(ctx.tenant_id, ctx.memory_space);
    const result = await deps.gateway.execute({ identity, tool_id: "home-assistant", action: "read_states_detail", parameters: { entities: entities.map((e) => e.entity_id) } });
    // Hele kallet feilet (HA nede, credential utilgjengelig/tilbakekalt, connector fryst) eller svaret er ugyldig: synlig kildefeil, aldri en stille tom liste.
    const states = result.ok ? (result.data as { states?: unknown } | null | undefined)?.states : undefined;
    if (!Array.isArray(states) || states.length !== entities.length) throw new Error("home_source_unavailable");
    const out: HomeObservation[] = [];
    let unknown = 0;
    let failed = 0;
    entities.forEach((entity, i) => {
      const data = states[i];
      if (data === null || data === undefined) {
        unknown += 1; // 404: entiteten finnes ikke i HA (typisk en skrivefeil i abonnementet)
        return;
      }
      if (typeof data !== "object" || Array.isArray(data) || typeof (data as Record<string, unknown>)["error"] === "string") {
        failed += 1;
        return;
      }
      const state = (data as Record<string, unknown>)["state"];
      const lastChanged = (data as Record<string, unknown>)["last_changed"];
      if (typeof state !== "string" || typeof lastChanged !== "string") {
        failed += 1;
        return;
      }
      const base = { source: "home_assistant" as const, entity_id: entity.entity_id, role: entity.role, state, last_changed: lastChanged };
      if (entity.role === "power" && entity.limit_w !== undefined) {
        const watts = wattsOf(state, (data as Record<string, unknown>)["unit"]);
        const key = `${ctx.tenant_id}|${entity.entity_id}`;
        if (watts !== null && watts > entity.limit_w) {
          const cur = powerTracker.get(key) ?? { since: new Date(ctx.now).toISOString(), ticks: 0 };
          cur.ticks += 1;
          powerTracker.set(key, cur);
          out.push({ ...base, limit_w: entity.limit_w, over_limit_ticks: cur.ticks, over_limit_since: cur.since });
        } else {
          powerTracker.delete(key);
          // A-MEDIUM-4: under grensen er NORMAL (bussen løser åpne effektsituasjoner for entiteten); en ukjent verdi eller ukjent enhet (`unavailable`, `MW`) er det ikke (ingen løsing på gjetning).
          out.push(watts !== null ? { ...base, limit_w: entity.limit_w, over_limit_ticks: 0, over_limit_since: new Date(ctx.now).toISOString() } : base);
        }
        return;
      }
      out.push(base);
    });
    if (unknown > 0) ctx.warnings?.push(`home_entities_unknown:${unknown}`);
    if (failed > 0) ctx.warnings?.push(`home_entities_failed:${failed}`);
    return out;
  };
}

/** Kamera: kun de minimerte feltene bridgen trenger (etiketten brukes kun til å avgjøre kategorien «pakke» og lagres/gis aldri videre). */
export function createVisionReader(deps: { vision: SituationSignalsWiringDeps["vision"]; ownerPersonId: string }): NonNullable<SignalSourceReaders["vision"]> {
  return async (ctx, sinceMs) => {
    const rows = await deps.vision.getRecentEvents(ctx.tenant_id, ctx.memory_space, deps.ownerPersonId, { sinceMs, limit: VISION_READ_LIMIT });
    // B-LOW-6: taket er nådd = eldre hendelser i vinduet leses ikke (de nyeste først); synlig advarsel i stedet for stille tap.
    if (rows.length >= VISION_READ_LIMIT) ctx.warnings?.push(`vision_events_truncated:${VISION_READ_LIMIT}`);
    const out: VisionObservation[] = [];
    for (const row of rows) {
      const at = iso(row.observed_at);
      if (at === null) continue;
      out.push({ source: "vision", observation_id: row.observation_id, event_type: row.event_type, source_instance_id: row.source_instance_id, source_event_id: row.source_event_id, observed_at: at, object_label: row.object_label, classification_status: row.classification_status });
    }
    return out;
  };
}

/** Helse: kun EGEN helse (eierens person-id), rå prøver aggregeres til ett tall per døgn her og forlater aldri prosessen. */
export function createHealthReader(deps: { health: SituationSignalsWiringDeps["health"]; ownerPersonId: string }): NonNullable<SignalSourceReaders["health"]> {
  return async (ctx, personId, metrics) => {
    // Registeret krever allerede `health_self_only`; her sjekkes det en gang til mot eierens person-id (forsvar i dybden).
    if (personId !== deps.ownerPersonId) return [];
    const out: HealthObservation[] = [];
    for (const metric of metrics) {
      const fetched = await deps.health.getRecentMetrics(ctx.tenant_id, personId, metric, ctx.now - HEALTH_WINDOW_DAYS * DAY_MS, HEALTH_ROWS_LIMIT);
      let rows = fetched;
      if (fetched.length >= HEALTH_ROWS_LIMIT) {
        // B-LOW-6: taket er nådd (de NYESTE radene kom): det eldste døgnet i utvalget kan være delvis og droppes, så en sum (søvn, skritt) aldri blir feil lav; synlig advarsel (aldri et stille tap).
        ctx.warnings?.push(`health_rows_truncated:${metric}`);
        const dayOf = (r: { observed_at: string | Date }): string | null => iso(r.observed_at)?.slice(0, 10) ?? null;
        const days = fetched.map(dayOf).filter((d): d is string => d !== null);
        const oldest = days.reduce((a, b) => (a < b ? a : b), days[0] ?? "");
        rows = fetched.filter((r) => dayOf(r) !== oldest);
      }
      out.push({ source: "health", metric, series: aggregateDaily(metric, rows) });
    }
    return out;
  };
}

/** Hendelser: kun aktive (ikke løst/vil ikke fikses). Samme innhold som det daglige sveipet leser (D-195). */
export function createIncidentReader(deps: { incidents: SituationSignalsWiringDeps["incidents"] }): NonNullable<SignalSourceReaders["incident"]> {
  return async (ctx) => {
    const all = await deps.incidents.listIncidents(ctx.tenant_id, ctx.memory_space, "all");
    const out: IncidentObservation[] = [];
    for (const i of all) {
      const opened = iso(i.opened_at);
      if (opened === null || i.status === "resolved" || i.status === "wont_fix") continue;
      out.push({ source: "incident", incident: { incident_id: i.incident_id, title: i.title, status: i.status as never, severity: i.severity as never, opened_at: opened } });
    }
    return out;
  };
}

export function createSituationSignalsWiring(deps: SituationSignalsWiringDeps): SituationSignalsWiring {
  const flags = situationFlagsFromEnv(deps.env);
  if (!flags.signals) return { flags, tools: [], runner: null, registry: null, api: null, describe: () => null, start: () => undefined };

  const now = deps.now ?? Date.now;
  const authority = { owner_person_id: deps.ownerPersonId };
  const registry = new SubscriptionRegistry(deps.pool, authority);
  const logs = new SignalLogService(deps.pool);
  const identityFor = (tenantId: string, space: MemorySpace): IdentityContext => ({ ...deps.ownerIdentity, tenant_id: tenantId, memory_space_id: space, session_id: `${deps.ownerIdentity.session_id}-situation-signals` });
  const assist = flags.modelAssist ? new ModelSignalAssist({ gateway: deps.modelGateway, ...(deps.isLocalProvider !== undefined ? { isLocalProvider: deps.isLocalProvider } : {}) }) : null;
  // Tilbakemeldingslæring (P2d) KUN med `JARVIS_SITUATION_FEEDBACK=on`: uten flagget finnes verken handlingene eller en terskelkilde (alle regler bruker standard). Simulering er ren lesing og følger hovedbryteren.
  const feedback = flags.feedback ? new FeedbackService(deps.pool, authority, true, now) : undefined;
  const simulation = new SimulationService(deps.pool, simulationToolInfoFrom(deps.gateway), now);
  const bus = new SituationSignalBus({ pool: deps.pool, engine: deps.engine, domainPauses: deps.domainPauses, subscriptions: (t, s) => registry.listEnabled(t, s), ...(feedback ? { tuning: feedback } : {}), assist, now });

  const readers: SignalSourceReaders = {
    ...(flags.home ? { home: createHomeReader({ gateway: deps.gateway, identityFor }) } : {}),
    ...(flags.vision ? { vision: createVisionReader({ vision: deps.vision, ownerPersonId: deps.ownerPersonId }) } : {}),
    ...(flags.health ? { health: createHealthReader({ health: deps.health, ownerPersonId: deps.ownerPersonId }) } : {}),
    ...(flags.incidents ? { incident: createIncidentReader({ incidents: deps.incidents }) } : {})
  };
  // Kun de rommene kildene bor i, i eierens tenant (HA-credentialen og helse-/kameradata tilhører eieren).
  const spaces = new Set<MemorySpace>();
  if (flags.home || flags.vision) spaces.add("home");
  if (flags.health) spaces.add("health");
  if (flags.incidents) spaces.add("business");
  const targets = [...spaces].map((memory_space) => ({ tenant_id: deps.ownerTenant, memory_space }));
  // D-LOW-3 (delta-review B): oppryddingen (signallogg, signalsituasjoner) dekker ALLE rom en kilde kan bo i, så lenge hovedbryteren er på - uavhengig av om kilden er på nå. Slås en kilde AV, ryddes de gamle radene fortsatt etter
  // kildedataenes oppbevaring. (Er hovedbryteren AV bygges ingen løper, og ingenting kjører: da er erasure veien.)
  const retentionSpaces = new Set<MemorySpace>(Object.values(SOURCE_SPACES).flat());
  const retentionTargets = [...retentionSpaces].map((memory_space) => ({ tenant_id: deps.ownerTenant, memory_space }));

  const intervalSeconds = boundedInt(deps.env["JARVIS_SITUATION_BUS_INTERVAL_SECONDS"], 15, 3600, 60);
  const retentionDays = boundedInt(deps.env["JARVIS_SITUATION_LOG_RETENTION_DAYS"], SIGNAL_LOG_RETENTION_BOUNDS.min, SIGNAL_LOG_RETENTION_BOUNDS.max, DEFAULT_SIGNAL_LOG_RETENTION_DAYS);
  const runner = new SituationSignalRunner({
    pool: deps.pool, bus, engine: deps.engine, gateway: deps.gateway, readers, subscriptions: (t, s) => registry.listEnabled(t, s), targets, retentionTargets, identityFor,
    guard: { blocked: async () => ((await deps.killSwitch.isActiveDurable()) ? "kill_switch_active" : null) },
    intervalMs: intervalSeconds * 1000, logRetentionDays: retentionDays, now,
    // WP-G4b K5 (D-484): morgenoppsummering av nattlige kamerahendelser - kun når kamerakilden er på (ellers finnes ingen tjeneste og tikkresultatet er identisk med før).
    ...(flags.vision ? { morningSummary: new MorningSummaryService(deps.pool) } : {}),
    // Signalsituasjonene (kamera/helse/hjem) rydder etter kildedataenes egen oppbevaring (G3/G2) når den finnes; ellers etter `logRetentionDays`.
    sourceRetention: {
      ...(deps.health.getRetentionPolicy ? { healthDays: async (tenantId: string) => (await deps.health.getRetentionPolicy!(tenantId))?.retention_days ?? null } : {}),
      ...(deps.vision.getRetentionPolicy ? { visionDays: async (tenantId: string, space: MemorySpace) => (await deps.vision.getRetentionPolicy!(tenantId, space))?.retention_days ?? null } : {})
    }
  });

  // `set_autonomy_policy` får et valgfritt `expires_at` KUN med hovedbryteren på. Definisjonen (samme tool_id/action) ERSTATTER den eksisterende ved registrering (`ToolGateway.register` er en `Map.set`, siste vinner);
  // `main.ts` legger denne listen ETTER `situationsToolDefinitions(...)`, hvis linje står uendret slik at flagg AV er byte-identisk med main (kildevakten i `executive-wiring.test.ts`).
  // WP-G4b K2: `set_autonomy_policy` OG `clear_autonomy_policy` får i tillegg valgfrie `rule`/`category` (skop) - samme gating, samme erstatningsmekanisme.
  const autonomyWithExpiry = situationsToolDefinitions(new SituationsTransport(deps.engine, deps.domainPauses), { autonomyExpiry: true, autonomyScope: true }).filter((d) => d.action === "set_autonomy_policy" || d.action === "clear_autonomy_policy");
  const tools: ToolDefinition[] = [
    ...autonomyWithExpiry,
    ...situationSignalsToolDefinitions(new SituationSignalsTransport({ registry, engine: deps.engine, logs, runner, simulation, ...(feedback ? { feedback } : {}) }), { feedback: flags.feedback }),
    ...(flags.home ? homeAssistantSituationReadTools(deps.haTransport) : [])
  ];

  return {
    flags, tools, runner, registry,
    api: { registry, engine: deps.engine, logs, runner, simulation, ...(feedback ? { feedback } : {}) },
    describe: () => ({
      msg: "situation_signals", interval_seconds: intervalSeconds, log_retention_days: retentionDays, spaces: [...spaces], retention_spaces: [...retentionSpaces],
      sources: { home: flags.home, vision: flags.vision, health: flags.health, incidents: flags.incidents }, model_assist: flags.modelAssist, feedback: flags.feedback
    }),
    start: () => runner.start()
  };
}
