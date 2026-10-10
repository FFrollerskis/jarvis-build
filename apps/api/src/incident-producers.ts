// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import {
  DeploymentService, IncidentService, ProducerRunStore, WatchdogIncidentProducer, deploymentProducer, infraExecutionProducer, providerProducer, runIncidentProducers,
  schedulerProducer, sentryProducer, sloProducer,
  type IncidentProducer, type ProducerRunSummary, type ProviderStatusLike, type SloReportLike, type WatchdogReportLike
} from "@jarvis/incidents";
import { CONNECTOR_REGISTRY, type ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-E1 (UA-5, JARVIS-068): kobler de deterministiske incident-produsentene (`@jarvis/incidents`, `producers/`) til kjøretiden. PRODUSENTENE ER OBSERVASJON + REGISTRERING: de leser fakta Jarvis
 * allerede har og skriver hendelsesrader i Jarvis' EGEN database - de utfører ingen reparasjon og skriver ikke mot noe eksternt system (reparasjon er fortsatt bak `InfraExecutionGate`/klasse D).
 *
 * AV som standard (`JARVIS_INCIDENT_PRODUCERS_ENABLED=true`, kun eksakt «true»): eieren slår dem på bevisst, fordi en hendelse flyter videre til situasjonsmotoren (`infra-incident-bridge`) og dermed
 * til eierens oppmerksomhetskø. Hendelsene lages for EIERENS tenant i `business`-rommet - samme rom situasjonssveipet leser incidents fra.
 */
export const INCIDENT_PRODUCER_MEMORY_SPACE = "business" as const;
export const INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT = 300_000;
export const INCIDENT_PRODUCER_INTERVAL_MS_MIN = 60_000;
export const INCIDENT_PRODUCER_INTERVAL_MS_MAX = 3_600_000;

export interface IncidentProducerConfig {
  enabled: boolean;
  intervalMs: number;
  /** Grener hvis utrullinger teller (standard `main`). */
  deployRefs: string[];
  /** `owner/repo` som leses aktivt for nye Actions-kjøringer (tom = kun det som allerede er ingestet). */
  deployRepos: string[];
}

const REF_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function csv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Validerer miljøet. Avslått (standard) leser ingenting annet. Påslått med en ugyldig verdi KASTER (fail-closed oppstart, samme prinsipp som `parseWatchdogIntervalMs`) - aldri en stille
 * `NaN`-timer eller en gren-/repo-liste som ikke betyr det eieren trodde.
 */
export function parseIncidentProducerConfig(env: Record<string, string | undefined>): IncidentProducerConfig {
  const enabled = env["JARVIS_INCIDENT_PRODUCERS_ENABLED"] === "true";
  if (!enabled) return { enabled: false, intervalMs: INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT, deployRefs: ["main"], deployRepos: [] };
  const rawInterval = env["JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS"];
  let intervalMs = INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT;
  if (rawInterval !== undefined && rawInterval.trim() !== "") {
    const n = Number(rawInterval);
    if (!Number.isInteger(n) || n < INCIDENT_PRODUCER_INTERVAL_MS_MIN || n > INCIDENT_PRODUCER_INTERVAL_MS_MAX) {
      throw new Error(`JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS ugyldig: "${rawInterval}" - heltall mellom ${INCIDENT_PRODUCER_INTERVAL_MS_MIN} og ${INCIDENT_PRODUCER_INTERVAL_MS_MAX} (ms)`);
    }
    intervalMs = n;
  }
  const refs = csv(env["JARVIS_INCIDENT_DEPLOY_REFS"]);
  const deployRefs = refs.length > 0 ? refs : ["main"];
  const badRef = deployRefs.find((r) => !REF_PATTERN.test(r) || r.includes(".."));
  if (badRef !== undefined) throw new Error(`JARVIS_INCIDENT_DEPLOY_REFS ugyldig gren: "${badRef.slice(0, 40)}"`);
  const deployRepos = csv(env["JARVIS_INCIDENT_DEPLOY_REPOS"]);
  const badRepo = deployRepos.find((r) => !REPO_PATTERN.test(r));
  if (badRepo !== undefined) throw new Error(`JARVIS_INCIDENT_DEPLOY_REPOS ugyldig repo (forventer owner/repo): "${badRepo.slice(0, 40)}"`);
  return { enabled, intervalMs, deployRefs, deployRepos };
}

/**
 * Tilkoblingshelse fra `ToolGateway.health` (BO-03) - UTEN hvelv-oppslag (`listConnectorStatus` gjør ett `hasSecret()` per credential, altså hundrevis av Infisical-kall hvert intervall). En helserad
 * finnes kun når transporten faktisk ble kalt, dvs. når credentialen var tilgjengelig - derfor er en rad i seg selv «konfigurert».
 */
export function connectorStatusesFromGateway(gateway: Pick<ToolGateway, "health">): ProviderStatusLike[] {
  const names = new Map(CONNECTOR_REGISTRY.map((def) => [def.live_test?.tool_id ?? def.id, def.display_name]));
  return [...gateway.health].map(([id, health]) => ({ id, display_name: names.get(id) ?? id, configured: true, health }));
}

export interface ApiIncidentProducerDeps {
  pool: pg.Pool;
  gateway: ToolGateway;
  identity: IdentityContext;
  deployments: DeploymentService;
  sloReport: () => Promise<SloReportLike>;
  config: IncidentProducerConfig;
}

/** Produsentene som kjører i API-prosessen (vakthund-produsenten bor i worker-prosessen - se `createWatchdogIncidentBridge`). */
export function buildApiIncidentProducers(deps: ApiIncidentProducerDeps): IncidentProducer[] {
  return [
    schedulerProducer({ pool: deps.pool }),
    deploymentProducer({
      pool: deps.pool, refs: deps.config.deployRefs,
      ...(deps.config.deployRepos.length > 0 ? { ingest: { gateway: deps.gateway, deployments: deps.deployments, identity: deps.identity, repos: deps.config.deployRepos } } : {})
    }),
    sloProducer({ report: deps.sloReport }),
    providerProducer({ readStatus: async () => connectorStatusesFromGateway(deps.gateway) }),
    infraExecutionProducer({ pool: deps.pool }),
    sentryProducer({ gateway: deps.gateway, identity: deps.identity })
  ];
}

export interface IncidentProducerLoop {
  /** Kjører ÉN runde nå. `null` = en forrige runde pågår fortsatt (overlapp hoppes over, aldri to samtidig). */
  tick(): Promise<ProducerRunSummary[] | null>;
  start(): void;
  stop(): void;
}

export function createIncidentProducerLoop(opts: {
  intervalMs: number;
  run: () => Promise<ProducerRunSummary[]>;
  log?: (line: Record<string, unknown>) => void;
  initialDelayMs?: number;
}): IncidentProducerLoop {
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let first: NodeJS.Timeout | undefined;
  const tick = async (): Promise<ProducerRunSummary[] | null> => {
    if (running) {
      log({ msg: "incident_producers_skipped_overlap" });
      return null;
    }
    running = true;
    try {
      const summaries = await opts.run();
      // Kun tall og utfall - aldri innhold. Feilende produsenter er synlige i loggen og i `incident_producer_runs`.
      log({ msg: "incident_producers_run", producers: summaries.map((s) => ({ p: s.producer, status: s.status, seen: s.facts_seen, opened: s.opened, updated: s.updated, resolved: s.resolved, suppressed: s.suppressed, ...(s.error ? { error: s.error.slice(0, 120) } : {}) })) });
      return summaries;
    } catch (err) {
      log({ msg: "incident_producers_error", error: (err as Error).message.slice(0, 200) });
      return [];
    } finally {
      running = false;
    }
  };
  return {
    tick,
    start() {
      first = setTimeout(() => void tick(), opts.initialDelayMs ?? 30_000);
      first.unref();
      timer = setInterval(() => void tick(), opts.intervalMs);
      timer.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
    }
  };
}

/** Starter produsentene i API-prosessen. Kalles kun når `config.enabled`. */
export function startApiIncidentProducers(
  deps: ApiIncidentProducerDeps & { incidents: IncidentService; tenantId: string }
): IncidentProducerLoop {
  const producers = buildApiIncidentProducers(deps);
  const runs = new ProducerRunStore(deps.pool);
  const loop = createIncidentProducerLoop({
    intervalMs: deps.config.intervalMs,
    run: () => runIncidentProducers({ incidents: deps.incidents, runs }, deps.tenantId, INCIDENT_PRODUCER_MEMORY_SPACE, producers)
  });
  loop.start();
  return loop;
}

/**
 * Worker-siden: vakthundens tikk-observatør. Hvert fullførte tikk mates til `WatchdogIncidentProducer`, som kjøres umiddelbart (ingen egen timer). Feil her kastes aldri tilbake til vakthunden
 * (observatøren i `Watchdog` er uansett fire-and-forget), og et nytt tikk mens forrige registrering pågår hoppes over.
 */
export function createWatchdogIncidentBridge(opts: {
  pool: pg.Pool;
  tenantId: string;
  log?: (line: Record<string, unknown>) => void;
}): { observe(report: WatchdogReportLike): Promise<void> } {
  const incidents = new IncidentService(opts.pool);
  const runs = new ProducerRunStore(opts.pool);
  const producer = new WatchdogIncidentProducer();
  const base = opts.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  // Vakthunden tikker hvert minutt: en rolig runde (ingen endring, ingen feil) skal ikke fylle loggen.
  const log = (line: Record<string, unknown>): void => {
    if (line["msg"] === "incident_producers_run") {
      const quiet = (line["producers"] as Array<{ status: string; opened: number; resolved: number }>).every((p) => p.status !== "failed" && p.opened === 0 && p.resolved === 0);
      if (quiet) return;
    }
    base(line);
  };
  const loop = createIncidentProducerLoop({
    intervalMs: INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT,
    run: () => runIncidentProducers({ incidents, runs }, opts.tenantId, INCIDENT_PRODUCER_MEMORY_SPACE, [producer]),
    log
  });
  return {
    async observe(report) {
      producer.record(report);
      await loop.tick();
    }
  };
}
