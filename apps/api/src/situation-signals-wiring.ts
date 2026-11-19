import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { homeAssistantStateDetailTool, type ToolDefinition, type ToolGateway, type ToolTransport } from "@jarvis/tool-gateway";
import {
  boundedInt, DEFAULT_SIGNAL_LOG_RETENTION_DAYS, FeedbackService, ModelSignalAssist, SignalLogService, SimulationService, SituationSignalBus, SituationSignalRunner, SubscriptionRegistry,
  SituationSignalsTransport, situationFlagsFromEnv, situationSignalsToolDefinitions, SIGNAL_LOG_RETENTION_BOUNDS,
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
  ownerIdentity: IdentityContext;
  ownerTenantId: string;
  ownerPersonId: string;
  incidents: { listIncidents(tenantId: string, memorySpace: MemorySpace, status: "all"): Promise<Array<{ incident_id: string; title: string; status: string; severity: string; opened_at: string | Date }>> };
  vision: { getRecentEvents(tenantId: string, memorySpace: MemorySpace, personId: string, filter: { sinceMs?: number }): Promise<Array<{
    observation_id: string; event_type: string; source_instance_id: string; source_event_id: string; observed_at: string | Date; object_label: string | null; classification_status: string }>> };
  health: { getRecentMetrics(tenantId: string, personId: string, metricType: HealthSignalMetric, sinceMs?: number): Promise<Array<{ value: number; observed_at: string | Date }>> };
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
  /** Startlogg (kun når noe er på). */
  describe(): Record<string, unknown> | null;
  /** Starter løperen (ingen effekt uten flagg). */
  start(): void;
}

const DAY_MS = 86_400_000;
const HEALTH_WINDOW_DAYS = 35;
const iso = (value: string | Date): string | null => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Aggregerer rå prøver til ÉN verdi per UTC-døgn (gjennomsnitt for hvilepuls, sum for søvn og skritt). De rå verdiene forlater aldri denne funksjonen. */
export function aggregateDaily(metric: HealthSignalMetric, rows: ReadonlyArray<{ value: number; observed_at: string | Date }>): DailyPoint[] {
  const days = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    const at = iso(row.observed_at);
    if (at === null || !Number.isFinite(row.value)) continue;
    const day = at.slice(0, 10);
    const cur = days.get(day) ?? { sum: 0, n: 0 };
    cur.sum += row.value;
    cur.n += 1;
    days.set(day, cur);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, { sum, n }]) => ({ day, value: metric === "resting_heart_rate" ? sum / n : sum, samples: n }));
}

/** Hjem: tilstander via ToolGateway (policy, kill switch, frys, credential-tilbakekall og revisjon gjelder). Effekt-sensorer sporer «på rad over eierens grense» i minnet (en omstart nullstiller telleren: varselet kommer litt senere, aldri for tidlig). */
export function createHomeReader(deps: { gateway: Pick<ToolGateway, "execute">; identityFor: (tenantId: string, space: MemorySpace) => IdentityContext }): NonNullable<SignalSourceReaders["home"]> {
  const powerTracker = new Map<string, { since: string; ticks: number }>();
  return async (ctx, entities) => {
    const identity = deps.identityFor(ctx.tenant_id, ctx.memory_space);
    const out: HomeObservation[] = [];
    let attempted = 0;
    let succeeded = 0;
    for (const entity of entities) {
      attempted += 1;
      const result = await deps.gateway.execute({ identity, tool_id: "home-assistant", action: "read_state_detail", parameters: { entity: entity.entity_id } });
      if (!result.ok) continue;
      succeeded += 1;
      const data = result.data;
      if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) continue;
      const state = (data as Record<string, unknown>)["state"];
      const lastChanged = (data as Record<string, unknown>)["last_changed"];
      if (typeof state !== "string" || typeof lastChanged !== "string") continue;
      const base = { source: "home_assistant" as const, entity_id: entity.entity_id, role: entity.role, state, last_changed: lastChanged };
      if (entity.role === "power" && entity.limit_w !== undefined) {
        const watts = Number(state);
        const key = `${ctx.tenant_id}|${entity.entity_id}`;
        if (Number.isFinite(watts) && watts > entity.limit_w) {
          const cur = powerTracker.get(key) ?? { since: new Date(ctx.now).toISOString(), ticks: 0 };
          cur.ticks += 1;
          powerTracker.set(key, cur);
          out.push({ ...base, limit_w: entity.limit_w, over_limit_ticks: cur.ticks, over_limit_since: cur.since });
        } else {
          powerTracker.delete(key);
        }
        continue;
      }
      out.push(base);
    }
    // Alle lesinger feilet (HA nede, credential utilgjengelig/tilbakekalt, connector fryst): synlig kildefeil, aldri en stille tom liste.
    if (attempted > 0 && succeeded === 0) throw new Error("home_source_unavailable");
    return out;
  };
}

/** Kamera: kun de minimerte feltene bridgen trenger (etiketten brukes kun til å avgjøre kategorien «pakke» og lagres/gis aldri videre). */
export function createVisionReader(deps: { vision: SituationSignalsWiringDeps["vision"]; ownerPersonId: string }): NonNullable<SignalSourceReaders["vision"]> {
  return async (ctx, sinceMs) => {
    const rows = await deps.vision.getRecentEvents(ctx.tenant_id, ctx.memory_space, deps.ownerPersonId, { sinceMs });
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
      const rows = await deps.health.getRecentMetrics(ctx.tenant_id, personId, metric, ctx.now - HEALTH_WINDOW_DAYS * DAY_MS);
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
  if (!flags.signals) return { flags, tools: [], runner: null, registry: null, describe: () => null, start: () => undefined };

  const now = deps.now ?? Date.now;
  const authority = { owner_person_id: deps.ownerPersonId };
  const registry = new SubscriptionRegistry(deps.pool, authority);
  const logs = new SignalLogService(deps.pool);
  const identityFor = (tenantId: string, space: MemorySpace): IdentityContext => ({ ...deps.ownerIdentity, tenant_id: tenantId, memory_space_id: space, session_id: `${deps.ownerIdentity.session_id}-situation-signals` });
  const assist = flags.modelAssist ? new ModelSignalAssist({ gateway: deps.modelGateway }) : null;
  // Tilbakemeldingslæring (P2d) KUN med `JARVIS_SITUATION_FEEDBACK=on`: uten flagget finnes verken handlingene eller en terskelkilde (alle regler bruker standard). Simulering er ren lesing og følger hovedbryteren.
  const feedback = flags.feedback ? new FeedbackService(deps.pool, authority, true, now) : undefined;
  const simulation = new SimulationService(deps.pool, (toolId, action) => (deps.gateway.get(toolId, action)?.capability_class as "A" | "B" | "C" | "D" | undefined) ?? null, now);
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
  const targets = [...spaces].map((memory_space) => ({ tenant_id: deps.ownerTenantId, memory_space }));

  const intervalSeconds = boundedInt(deps.env["JARVIS_SITUATION_BUS_INTERVAL_SECONDS"], 15, 3600, 60);
  const retentionDays = boundedInt(deps.env["JARVIS_SITUATION_LOG_RETENTION_DAYS"], SIGNAL_LOG_RETENTION_BOUNDS.min, SIGNAL_LOG_RETENTION_BOUNDS.max, DEFAULT_SIGNAL_LOG_RETENTION_DAYS);
  const runner = new SituationSignalRunner({
    pool: deps.pool, bus, engine: deps.engine, gateway: deps.gateway, readers, subscriptions: (t, s) => registry.listEnabled(t, s), targets, identityFor,
    guard: { blocked: async () => ((await deps.killSwitch.isActiveDurable()) ? "kill_switch_active" : null) },
    intervalMs: intervalSeconds * 1000, logRetentionDays: retentionDays, now
  });

  const tools: ToolDefinition[] = [
    ...situationSignalsToolDefinitions(new SituationSignalsTransport({ registry, engine: deps.engine, logs, runner, simulation, ...(feedback ? { feedback } : {}) }), { feedback: flags.feedback }),
    ...(flags.home ? [homeAssistantStateDetailTool(deps.haTransport)] : [])
  ];

  return {
    flags, tools, runner, registry,
    describe: () => ({
      msg: "situation_signals", interval_seconds: intervalSeconds, log_retention_days: retentionDays, spaces: [...spaces],
      sources: { home: flags.home, vision: flags.vision, health: flags.health, incidents: flags.incidents }, model_assist: flags.modelAssist, feedback: flags.feedback
    }),
    start: () => runner.start()
  };
}
