import type { ResensitizeSweepSummary } from "@jarvis/memory";
import type { SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import { EXTERNAL_GATES } from "@jarvis/self-modification";
import type { ConnectorStatus } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "../../src/ev0-boot.ts";
import { createRadarState } from "../../src/evolution-radar.ts";
import type { EvolutionContext, EvolutionSourceDeps } from "../../src/evolution-source.ts";
import type { LookupImpl } from "../../src/radar-url-guard.ts";
import { PRODUCTION_SURFACE } from "./fast-path-harness.ts";

/**
 * Felles testverden for evolusjonskildene (M2/L2/L3, gjennomgang av PR #313): en FRISK, fullt lesbar verden der alle observasjonsseksjonene er OK og alle ni sovende deler er klare for en beslutning. Testene
 * ødelegger så ÉN avhengighet av gangen og viser nøyaktig hva som slutter å være OK - uten en slik referanse kan ikke en test skille «svikt gir ikke-OK» fra «seksjonen var aldri OK».
 * Ingen test kaller nettet eller en ekte database: pool er skriptet, radaren bruker falsk DNS og falsk fetch.
 */
export const NOW = new Date("2026-10-15T12:00:00.000Z");

/** En feilmelding full av ting som ALDRI skal ende i en rapport (vert, port, rolle, passord) - eksempler hentet fra gjennomgangen (L2). */
export const SECRET_TEXT = "connect ECONNREFUSED 10.0.0.5:5432 (db=jarvis, user=jarvis_app) password authentication failed for user \"jarvis_ro\" hunter2";
export const secretError = (): Error => Object.assign(new Error(SECRET_TEXT), { code: "ECONNREFUSED" });
/** Fragmenter av `SECRET_TEXT` som ikke kan forekomme i en rapport av legitime grunner. */
export const SECRET_FRAGMENTS = ["10.0.0.5", "5432", "jarvis_app", "jarvis_ro", "hunter2", "password", "ECONNREFUSED 10"] as const;

export type Handler = [RegExp, (params: unknown[]) => unknown[]];
export function fakePool(handlers: Handler[], seen: string[] = []): EvolutionSourceDeps["pool"] {
  const run = async (sql: string, params: unknown[] = []) => {
    seen.push(sql);
    const hit = handlers.find(([re]) => re.test(sql));
    return { rows: hit ? hit[1](params) : [], rowCount: 0 };
  };
  return { query: run, connect: async () => ({ query: run, release: () => undefined }) } as never;
}

export const verified: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "abc" }, ledger: { status: "ok", count: 12, head_hash: "h" } };
export const connector = (id: string, configured: boolean, health: ConnectorStatus["health"] = null, test_method: "live" | "presence_only" = "presence_only"): ConnectorStatus =>
  ({ id, display_name: id, category: "integration" as never, configured, credentials: [], test_method, health });
export const healthy = (): NonNullable<ConnectorStatus["health"]> => ({ state: "healthy", at: NOW.toISOString() });
export const sloReport = (over: Partial<SloReport> = {}): SloReport => ({
  as_of: NOW.toISOString(), not_measured: [], drift: null, data_quality: null, summary_no: "",
  slos: [{ id: "chat-success", label: "Chat", status: "OK", value: 1, target: 0.9, metric: "success_rate", samples: 50, window_hours: 24, source: "x", observed_at: NOW.toISOString(), detail: "d" }],
  ...over
});
export const mesh = (over: Partial<MeshStatus> = {}, providers: MeshStatus["providers"] = [
  { provider: "gemma_local", model: "g", state: "LIVE", success: 5, failures: 0 },
  { provider: "anthropic", model: "c", state: "CONFIGURED", success: 0, failures: 0 }
]): MeshStatus => ({ providers, router: "HEALTHY", fallback: "VERIFIED", critic: "READY_SELECTIVE", ...over });
export const cleanDrift: ResensitizeSweepSummary = { mode: "report", scanned: 10, raised: { sensitive: 0, special: 0 }, written: 0, skipped_concurrent: 0, failed: [], truncated: false };

const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
export const jobRow = { job_name: "daily-brief", run_date: "2026-10-15", attempts: 1, completed_at: recent, retry_after: null, last_error: null, past_day: false, claim_stale: false };
export const cleanMemory = { id: "m1", space: "personal", subject: "a.1", content: "Tobias liker kaffe", observed_at: "2026-10-01T00:00:00.000Z", valid_to: null, trust: "trusted", has_conflict: false, source_kind: "conversation", source_ref: "s1" };
export const HEALTHY_HANDLERS: Handler[] = [
  [/FROM incidents/, () => [{ n: 0 }]],
  [/DISTINCT ON \(change_id\)/, () => [{ n: 0 }]],
  [/GROUP BY decision/, () => []],
  [/GROUP BY 1, 2/, () => []],
  [/::bigint/, () => [{ n: 0 }]],
  [/max\(completed_at\)/, () => [{ job_name: "connector-health-sweep", last: recent }, { job_name: "daily-brief", last: recent }]],
  [/DISTINCT ON \(job_name\)/, () => [jobRow]],
  [/FROM memory_items i JOIN memory_sources/, () => [cleanMemory]]
];

/** Eierens erklæringer og runner-oppsett som gjør alle sovende deler «klare» når runtime-fakta er friske (se `readinessFacts`). */
export const READY_ENV: Readonly<Record<string, string>> = {
  JARVIS_EV_VERIFIED_GATES: EXTERNAL_GATES.join(","), JARVIS_JOB_RUNNER: "container", JARVIS_JOB_IMAGE: "jarvis-job:test", JARVIS_JOB_NETWORK: "jarvis-jobs", JARVIS_JOB_EGRESS_PROXY: "http://egress:3128"
};

export const PUBLIC_DNS: LookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];

/** Valgfrie avhengigheter som kan utelates helt (ikke bare settes til `undefined` - `exactOptionalPropertyTypes`). */
export type OptionalDep = "radar" | "resensitize" | "toolSurface";

export interface World {
  /** `over` bytter ut avhengigheter; `drop` utelater valgfrie avhengigheter helt. */
  deps: (over?: Partial<EvolutionSourceDeps>, drop?: readonly OptionalDep[]) => EvolutionSourceDeps;
  radar: ReturnType<typeof createRadarState>;
}

/** Den friske verdenen. `deps(over)` bytter ut enkelte avhengigheter; alt annet forblir friskt. */
export async function healthyWorld(): Promise<World> {
  const radar = createRadarState(
    { JARVIS_RADAR_SOURCES: JSON.stringify([{ kind: "security", name: "Varsler", url: "https://security.example.com/feed" }]) },
    { lookupImpl: PUBLIC_DNS, now: () => NOW, fetchImpl: async () => new Response("Versjon 5 er ute.", { status: 200, headers: { "content-type": "text/plain" } }) }
  );
  await radar.run();
  const deps = (over: Partial<EvolutionSourceDeps> = {}, drop: readonly OptionalDep[] = []): EvolutionSourceDeps => {
    const d: EvolutionSourceDeps = {
      pool: fakePool(HEALTHY_HANDLERS),
      tenantId: "t1",
      now: () => NOW,
      env: READY_ENV,
      ev0Status: () => verified,
      slo: async () => sloReport(),
      // Tre beviste connectorer (live-testet + friske) gjør EV-18 klar i referanseverdenen.
      connectors: async () => ["github", "gmail", "slack"].map((id) => connector(id, true, healthy(), "live")),
      killSwitchActive: async () => false,
      mesh: () => mesh(),
      toolSurface: () => PRODUCTION_SURFACE,
      radar,
      resensitize: () => cleanDrift,
      ...over
    };
    for (const key of drop) delete d[key];
    return d;
  };
  return { deps, radar };
}

export const ctxOf = (d: EvolutionSourceDeps): EvolutionContext => ({ pool: d.pool, tenantId: d.tenantId, now: NOW, env: d.env ?? {}, deps: d, shared: {} });
