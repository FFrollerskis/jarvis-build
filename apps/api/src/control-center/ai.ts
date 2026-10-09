// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import {
  controlAction, controlItem, controlSection, unknownControlSection, worstStatus,
  type ControlAction, type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus, type EvolutionReport
} from "@jarvis/executive";
import { BudgetGuard, budgetConfigFromEnv, dailySpentOre, type CouncilLimiterUsage, type MeshStatus, type ProviderOverviewRow } from "@jarvis/model-gateway";
import type { OwnerControls } from "@jarvis/policy";
import { CONNECTOR_REGISTRY, type ConnectorDefinition, type ToolGateway } from "@jarvis/tool-gateway";
import { modelFreezeTarget, pausedProvidersFrom, providerCredentialRefs } from "../provider-pause.ts";
import type { RunRateReport } from "../run-rate.ts";
import { actionRequiresStepUp } from "../step-up.ts";
import { parseDailyCapOre, parseToolTurnRoute, resolveJobToolTurnRoute, type ToolTurnRoute } from "../tool-turn-route.ts";
import { activeTaskRows, readActiveTasks, readTaskCounts, type ActiveTaskRow, type TaskCounts } from "./agents.ts";
import { DAY_MS, bySeverityThenLabel, countsNo, relativeNo, riskOf, settle, tenantRead, toIso, type ControlCenterPool, type Settled } from "./shared.ts";

/**
 * WP-H0 (UA-11 Admin Control Center) - AI CENTER, med dekningen JARVIS-087 sier manglet: modellLEVERANDØRER og KJØRENDE AGENTER kan nå stoppes fra kontrollflaten.
 *
 * Seksjoner (alle kildeforankret; en kilde som ikke kan leses gjør kun de berørte tallene UKJENT, aldri «i orden»):
 *  1. `providers`  - hver leverandør i ModelGateway: lokal/sky, konfigurert, helse inkl. krets (halv-åpen, D-393), siste feilkategori (aldri meldingen), kost og siste fallback, og eierens pause/tilbakekall.
 *  2. `routing`    - Gemma-først og lokal/sky-andel, sensitive turer (kun lokal, D-378), D-431/D-449-rutene for verktøyturer og jobber med dagstaket (D-432), og siste rutevalg per tur-type.
 *  3. `cost`       - månedsbudsjett (BudgetGuard), dagens kost, månedsprognose og kost per leverandør/modell (D-421 run-rate).
 *  4. `evals`      - modellrådgiveren (D-399: av/skygge/aktiv), skygge-modellruten (EV-12) og golden-suiten. Golden-suiten er DEFERRED (EV-4) - UKJENT, ikke «i orden».
 *  5. `delegation` - overhead ved parallell delegering: AI-rådets auto-trigger (tak per time), samtidige bakgrunnsjobber (tak), kost bokført på jobber, kritikk-/fallback-/feilkall.
 *  6. `agents`     - kjørende og ventende agenter/jobber fra `tasks` (profil, status, forsøk, lease; aldri tittel eller innhold) med avbryt-handling.
 *
 * HANDLINGER peker kun på EKSISTERENDE ruter (`/executive/mutate`): pause/gjenoppta en leverandør (`freeze_connector`/`unfreeze_connector` på målet `model:<leverandør>`), tilbakekall/gjenopprett av leverandørens
 * nøkkel (`revoke_credential`/`restore_credential`, for de registrerte leverandørene) og avbryt jobb (`cancel_task`). `ModelGateway` leser pausen LIVE ved hvert kall (se provider-pause.ts). Sensitivitetsrutingen
 * er uendret: SECRET_RESTRICTED er alltid lokal, og en pauset lokal leverandør gir fail-closed for slike turer (aldri sky) - handlingens beskrivelse sier det FØR eieren trykker.
 */

const WINDOW_MS = 7 * DAY_MS;
/** Samme terskel som run-rate («mange feilede kall»): minst 5 kall og minst 30 % feil. */
export const FAIL_SHARE_WARN = 0.3;
export const FAIL_SHARE_MIN_CALLS = 5;
/** Standardkjeden for chat (D-354) - drift-testen låser at `conversation.ts` bruker nøyaktig denne. */
export const GEMMA_FIRST_CHAIN: readonly string[] = ["gemma_local", "gemma_hosted"];
/** Overhead-tak i kildene (låses av test mot chat-jobs.ts): maks samtidige delegerte bakgrunnsjobber. */
export const DEFAULT_MAX_ACTIVE_JOBS = 5;

const ERROR_KIND_NO: Readonly<Record<string, string>> = {
  timeout: "tidsavbrudd", network: "nettverk", server: "leverandørfeil", auth: "autentisering", rate_limit: "rate-begrensning", bad_request: "ugyldig forespørsel",
  invalid_response: "ubrukelig svar", not_configured: "ikke konfigurert", cancelled: "avbrutt", stream_interrupted: "avbrutt strøm"
};
const errorKindNo = (kind: string | undefined): string => (kind === undefined ? "ukjent kategori" : (ERROR_KIND_NO[kind] ?? "annen feil"));

const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
const pct = (share: number): string => `${Math.round(share * 100)} %`;

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (kun SELECT, tenant-RLS; kun aggregater og kategorier)
// ---------------------------------------------------------------------------------------------------------------------

export interface RoutingUsageRow {
  provider: string;
  purpose: string | null;
  ok_calls: number;
  failed_calls: number;
  fallback_calls: number;
  critic_calls: number;
  ore: number;
  last_ok_at: string | null;
  last_fallback_at: string | null;
}

/** Modellkall siste 7 døgn per leverandør og formål (`cost_events`). Alle modellkall bokføres her, også mislykkede (0 øre). */
export async function readRoutingUsage(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<RoutingUsageRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT provider, purpose,
            (count(*) FILTER (WHERE success AND NOT critic))::int AS ok_calls,
            (count(*) FILTER (WHERE NOT success))::int AS failed_calls,
            (count(*) FILTER (WHERE success AND fallback))::int AS fallback_calls,
            (count(*) FILTER (WHERE critic))::int AS critic_calls,
            (coalesce(sum(amount_ore), 0))::int AS ore,
            max(at) FILTER (WHERE success AND NOT critic) AS last_ok_at,
            max(at) FILTER (WHERE success AND fallback) AS last_fallback_at
       FROM cost_events
      WHERE tenant_id = $1 AND at >= $2 AND provider IS NOT NULL
      GROUP BY provider, purpose`,
    [tenantId, new Date(nowMs - WINDOW_MS)]
  ));
  return rows.map((r) => ({
    provider: String(r["provider"]), purpose: r["purpose"] === null || r["purpose"] === undefined ? null : String(r["purpose"]),
    ok_calls: Number(r["ok_calls"] ?? 0), failed_calls: Number(r["failed_calls"] ?? 0), fallback_calls: Number(r["fallback_calls"] ?? 0), critic_calls: Number(r["critic_calls"] ?? 0),
    ore: Number(r["ore"] ?? 0), last_ok_at: toIso(r["last_ok_at"]), last_fallback_at: toIso(r["last_fallback_at"])
  }));
}

export interface LastRouteRow { purpose: string; provider: string; model: string | null; fallback: boolean; at: string | null }

/** Siste vellykkede (ikke-kritikk) modellkall per formål = «siste rutevalg per tur-type». */
export async function readLastRoutePerPurpose(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<LastRouteRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT DISTINCT ON (purpose) purpose, provider, model, fallback, at
       FROM cost_events
      WHERE tenant_id = $1 AND at >= $2 AND success AND NOT critic AND purpose IS NOT NULL AND provider IS NOT NULL
      ORDER BY purpose, at DESC, cost_id DESC`,
    [tenantId, new Date(nowMs - WINDOW_MS)]
  ));
  return rows.map((r) => ({
    purpose: String(r["purpose"]), provider: String(r["provider"]), model: r["model"] === null || r["model"] === undefined ? null : String(r["model"]),
    fallback: r["fallback"] === true, at: toIso(r["at"])
  }));
}

export interface DelegationCostRow { all_calls: number; all_ore: number; task_calls: number; task_ore: number; task_failed: number }

/** Kost bokført på bakgrunnsjobber (`task_id` satt) mot all modellkost siste 7 døgn: den målte delen av overheaden ved delegering. */
export async function readDelegationCost(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<DelegationCostRow> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT (count(*))::int AS all_calls, (coalesce(sum(amount_ore), 0))::int AS all_ore,
            (count(*) FILTER (WHERE task_id IS NOT NULL))::int AS task_calls,
            (coalesce(sum(amount_ore) FILTER (WHERE task_id IS NOT NULL), 0))::int AS task_ore,
            (count(*) FILTER (WHERE task_id IS NOT NULL AND NOT success))::int AS task_failed
       FROM cost_events WHERE tenant_id = $1 AND at >= $2 AND provider IS NOT NULL`,
    [tenantId, new Date(nowMs - WINDOW_MS)]
  ));
  const r = rows[0] ?? {};
  return { all_calls: Number(r["all_calls"] ?? 0), all_ore: Number(r["all_ore"] ?? 0), task_calls: Number(r["task_calls"] ?? 0), task_ore: Number(r["task_ore"] ?? 0), task_failed: Number(r["task_failed"] ?? 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ren logikk (testbar uten database)
// ---------------------------------------------------------------------------------------------------------------------

export interface ProviderPauseInfo {
  /** Leverandøren er pauset (frosset ELLER nøkkel tilbakekalt). */
  paused: boolean;
  frozen: boolean;
  revoked_refs: string[];
}

export function pauseInfoFor(provider: string, frozenTargets: readonly string[], revokedRefs: ReadonlySet<string>, refsByProvider: ReadonlyMap<string, readonly string[]>): ProviderPauseInfo {
  const frozen = frozenTargets.includes(modelFreezeTarget(provider));
  const revoked = (refsByProvider.get(provider) ?? []).filter((ref) => revokedRefs.has(ref));
  return { paused: frozen || revoked.length > 0, frozen, revoked_refs: revoked };
}

export interface ProviderUsage { ok_calls: number; failed_calls: number; ore: number; last_ok_at: string | null; last_fallback_at: string | null }

export function usageByProvider(rows: readonly RoutingUsageRow[]): Map<string, ProviderUsage> {
  const out = new Map<string, ProviderUsage>();
  for (const r of rows) {
    const prev = out.get(r.provider) ?? { ok_calls: 0, failed_calls: 0, ore: 0, last_ok_at: null, last_fallback_at: null };
    out.set(r.provider, {
      ok_calls: prev.ok_calls + r.ok_calls, failed_calls: prev.failed_calls + r.failed_calls, ore: prev.ore + r.ore,
      last_ok_at: (prev.last_ok_at ?? "") >= (r.last_ok_at ?? "") ? prev.last_ok_at : r.last_ok_at,
      last_fallback_at: (prev.last_fallback_at ?? "") >= (r.last_fallback_at ?? "") ? prev.last_fallback_at : r.last_fallback_at
    });
  }
  return out;
}

/**
 * Status for én leverandør. Pauset = WARN (eierens bryter er i kraft); ikke konfigurert = OK (ikke en feil); LIVE = OK; DEGRADED/RATE_LIMITED = WARN; UNAVAILABLE (åpen krets) = FAIL.
 * «Konfigurert, men aldri bevist siden oppstart» er UKJENT KUN for en leverandør som faktisk er i bruk (på en rute eller med kall siste 7 døgn); en ubrukt leverandør er OK (ellers ville hver ubrukt nøkkel
 * for alltid holdt senteret på «ikke målt»). Mange feilede kall (>= 30 % av minst 5) løfter til minst WARN.
 */
export function providerStatus(row: ProviderOverviewRow, pause: ProviderPauseInfo, inUse: boolean, usage: ProviderUsage | undefined): ControlStatus {
  if (pause.paused) return "WARN";
  if (!row.configured) return "OK";
  let status: ControlStatus;
  switch (row.health.state) {
    case "LIVE": status = "OK"; break;
    case "CONFIGURED": status = inUse ? "UNKNOWN" : "OK"; break;
    case "DEGRADED": case "RATE_LIMITED": status = "WARN"; break;
    case "UNAVAILABLE": status = "FAIL"; break;
    default: status = "OK";
  }
  if (row.health.circuit === "open") status = "FAIL";
  else if (row.health.circuit === "half_open") status = worstStatus([status, "WARN"]);
  const calls = (usage?.ok_calls ?? 0) + (usage?.failed_calls ?? 0);
  if (usage !== undefined && calls >= FAIL_SHARE_MIN_CALLS && usage.failed_calls / calls >= FAIL_SHARE_WARN) status = worstStatus([status, "WARN"]);
  return status;
}

/** Lokale leverandører som kan svare på en sensitiv tur akkurat nå (konfigurert, ikke pauset, krets ikke åpen). */
export function usableLocalProviders(overview: readonly ProviderOverviewRow[], paused: ReadonlySet<string>): string[] {
  return overview
    .filter((r) => r.locality === "local" && r.provider !== "scripted" && r.configured && !paused.has(r.provider) && r.health.state !== "UNAVAILABLE")
    .map((r) => r.provider);
}

export interface LocalitySplit { local_ok: number; cloud_ok: number; total_ok: number; local_share: number | null; cloud_share: number | null }

/** Andel av VELLYKKEDE modellkall (ikke kritikk) som ble betjent lokalt mot i sky. Lokalitet fra gatewayens egen kapabilitetsprofil; ukjent leverandør regnes som sky (som `profileOrGeneric`). */
export function localitySplit(rows: readonly RoutingUsageRow[], localityOf: (provider: string) => "local" | "cloud", purpose?: string): LocalitySplit {
  let local = 0;
  let cloud = 0;
  for (const r of rows) {
    if (purpose !== undefined && r.purpose !== purpose) continue;
    if (localityOf(r.provider) === "local") local += r.ok_calls;
    else cloud += r.ok_calls;
  }
  const total = local + cloud;
  return { local_ok: local, cloud_ok: cloud, total_ok: total, local_share: total === 0 ? null : local / total, cloud_share: total === 0 ? null : cloud / total };
}

export function describeRoute(route: ToolTurnRoute | null): string {
  return route === null ? "av" : `${route.provider}:${route.model}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

/** Det AI Center trenger av ModelGateway (strukturelt; `ModelGateway` oppfyller det). Kun lesing. */
export interface AiGatewayView {
  providerOverview(): ProviderOverviewRow[];
  meshStatus(): Pick<MeshStatus, "router" | "fallback">;
  readonly routingAdvisorMode: "off" | "shadow" | "active";
}

export interface AiCenterDeps {
  pool: ControlCenterPool;
  /** Miljøet rutene og grensene leses fra (kun ikke-hemmelige verdier). */
  env: Readonly<Record<string, string | undefined>>;
  gateway: AiGatewayView;
  ownerControls: Pick<OwnerControls, "listFrozenConnectorsDurable" | "listRevokedCredentialsDurable">;
  toolGateway: Pick<ToolGateway, "get">;
  /** `RunRateService` (D-421): kost per leverandør/modell, prognose, feilrate. Utelatt = kost-seksjonen er UKJENT. */
  runRate?: { report(tenantId: string): Promise<RunRateReport> };
  /** AI-rådets auto-trigger-begrenser (samme instans som chatten bruker). Utelatt = UKJENT. */
  councilLimiter?: { usage(tenantId: string): CouncilLimiterUsage };
  /** Evolusjonsrapporten (B1) - EV-12 (skygge-modellrute) hentes derfra. Utelatt = UKJENT. */
  evolutionReport?: () => Promise<Pick<EvolutionReport, "sections">>;
  maxActiveJobs?: number;
  /** Standard: `CONNECTOR_REGISTRY` (nøkkelkart og «deles med»). Injiserbar for tester. */
  registry?: readonly ConnectorDefinition[];
}

interface Anchor { section_id: string; item_id: string }

export function createAiCenter(deps: AiCenterDeps): ControlCenterDefinition {
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const maxActiveJobs = deps.maxActiveJobs ?? DEFAULT_MAX_ACTIVE_JOBS;
  return {
    id: "ai",
    title_no: "AI",
    description_no: "Modellleverandører, ruting, kost, evals og parallell delegering - og kjørende agenter. Du kan pause/tilbakekalle en leverandør og avbryte en agent herfra",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const actions: ControlAction[] = [];
      const sections: ControlSection[] = [];

      const [controlsR, usageR, lastRouteR, delegationR, dailyR, budgetR, runRateR, tasksR, countsR, evoR] = await Promise.all([
        settle(async () => ({ frozen: await deps.ownerControls.listFrozenConnectorsDurable(), revoked: await deps.ownerControls.listRevokedCredentialsDurable() })),
        settle(() => readRoutingUsage(deps.pool, tenantId, nowMs)),
        settle(() => readLastRoutePerPurpose(deps.pool, tenantId, nowMs)),
        settle(() => readDelegationCost(deps.pool, tenantId, nowMs)),
        settle(() => dailySpentOre(deps.pool as pg.Pool, tenantId)),
        settle(async () => new BudgetGuard(deps.pool as pg.Pool, budgetConfigFromEnv({ ...deps.env })).evaluate(tenantId)),
        deps.runRate ? settle(() => deps.runRate!.report(tenantId)) : Promise.resolve(null),
        settle(() => readActiveTasks(deps.pool, tenantId)),
        settle(() => readTaskCounts(deps.pool, tenantId, nowMs)),
        deps.evolutionReport ? settle(() => deps.evolutionReport!()) : Promise.resolve(null)
      ]);
      const overviewR = await settle(async () => deps.gateway.providerOverview().filter((r) => r.provider !== "scripted"));

      // --- eierens pause/tilbakekall (LIVE, samme kilde som ModelGateway leser)
      const refsByProvider = providerCredentialRefs(registry);
      const frozenTargets = controlsR.ok ? controlsR.value.frozen.map((f) => f.connector_id) : [];
      const revokedRefs = new Set(controlsR.ok ? controlsR.value.revoked.map((r) => r.credential_ref) : []);
      const pausedSet = pausedProvidersFrom(frozenTargets, revokedRefs, refsByProvider);
      const usage = usageR.ok ? usageByProvider(usageR.value) : new Map<string, ProviderUsage>();
      const overview = overviewR.ok ? overviewR.value : [];
      const localityByProvider = new Map(overview.map((r) => [r.provider, r.locality] as const));
      const localityOf = (provider: string): "local" | "cloud" => localityByProvider.get(provider) ?? "cloud";

      // --- ruter (D-431/D-449): leverandørene som er «på en rute» regnes som i bruk
      const chatRoute = parseToolTurnRoute(deps.env["JARVIS_TOOL_TURN_MODEL"]);
      const jobRoute = resolveJobToolTurnRoute(deps.env["JARVIS_JOB_TOOL_TURN_MODEL"], chatRoute);
      const dailyCapOre = parseDailyCapOre(deps.env["JARVIS_TOOL_TURN_DAILY_CAP_ORE"]);
      const routeProviders = new Set<string>([...GEMMA_FIRST_CHAIN, ...(chatRoute ? [chatRoute.provider] : []), ...(jobRoute ? [jobRoute.provider] : [])]);

      // =====================================================================================================================
      // 1. Leverandører
      // =====================================================================================================================
      if (overviewR.ok) {
        const items: ControlItem[] = [];
        for (const row of overview) {
          const pause = pauseInfoFor(row.provider, frozenTargets, revokedRefs, refsByProvider);
          const u = usage.get(row.provider);
          const inUse = routeProviders.has(row.provider) || (u?.ok_calls ?? 0) > 0;
          const status = controlsR.ok || !row.configured ? providerStatus(row, pause, inUse, u) : worstStatus([providerStatus(row, pause, inUse, u), "UNKNOWN"]);
          const h = row.health;
          const parts: string[] = [];
          parts.push(row.locality === "local" ? "lokal" : row.hosted_free_tier ? "sky (gratis-tier, kun lav sensitivitet)" : "sky");
          if (!row.configured) parts.push("ikke konfigurert (ingen nøkkel/URL)");
          else {
            const healthNo = h.state === "LIVE" ? "i orden" : h.state === "CONFIGURED" ? "ikke bevist siden oppstart" : h.state === "DEGRADED" ? "degradert" : h.state === "RATE_LIMITED" ? "rate-begrenset" : "utilgjengelig";
            parts.push(`helse: ${healthNo}`);
            if (h.circuit === "open") parts.push(`kretsen er åpen - nytt forsøk ${h.retry_after_ms !== undefined ? `om ${Math.max(1, Math.ceil(h.retry_after_ms / 1000))} s` : "snart"}`);
            else if (h.circuit === "half_open") parts.push("kretsen er halv-åpen - ett prøvekall slippes gjennom");
            if (h.last_error_kind !== undefined && h.consecutive_failures > 0) parts.push(`siste feil: ${errorKindNo(h.last_error_kind)} ${relativeNo(h.last_failure_at, nowMs)}`);
          }
          if (pause.frozen) parts.push("PAUSET av eier");
          if (pause.revoked_refs.length > 0) parts.push(`nøkkel TILBAKEKALT (${pause.revoked_refs.join(", ")})`);
          if (pause.paused && row.locality === "local") parts.push("sensitive turer har ingen lokal modell å gå til før den gjenopptas (de går aldri til sky)");
          if (u !== undefined) parts.push(`7 d: ${u.ok_calls + u.failed_calls} kall${u.failed_calls > 0 ? ` (${u.failed_calls} feilet)` : ""}, ${kr(u.ore)}${u.last_fallback_at ? `; sist brukt som fallback ${relativeNo(u.last_fallback_at, nowMs)}` : ""}`);
          items.push(controlItem({
            id: row.provider,
            label: `${row.provider} (${row.model})`,
            status,
            detail_no: parts.join(" · "),
            observed_at: h.last_success_at ?? h.last_failure_at ?? null,
            facts: {
              provider: row.provider, model: row.model, locality: row.locality, hosted_free_tier: row.hosted_free_tier, configured: row.configured,
              paused: pause.paused, paused_by_freeze: pause.frozen, revoked_credentials: pause.revoked_refs.length > 0 ? pause.revoked_refs.join(", ") : null,
              health_state: h.state, circuit: h.circuit, consecutive_failures: h.consecutive_failures, last_error_kind: h.last_error_kind ?? null,
              last_success_at: h.last_success_at ?? null, last_failure_at: h.last_failure_at ?? null, retry_after_ms: h.retry_after_ms ?? null, avg_latency_ms: h.avg_latency_ms ?? null,
              calls_ok_7d: usageR.ok ? (u?.ok_calls ?? 0) : null, calls_failed_7d: usageR.ok ? (u?.failed_calls ?? 0) : null, cost_7d_ore: usageR.ok ? (u?.ore ?? 0) : null,
              last_fallback_at: u?.last_fallback_at ?? null, in_use: inUse
            }
          }));

          // --- handlinger: pause/gjenoppta og (for registrerte leverandører) tilbakekall/gjenopprett nøkkel
          const anchor: Anchor = { section_id: "providers", item_id: row.provider };
          const sensitiveNote = row.locality === "local"
            ? " Sensitive turer (helse, økonomi, hemmeligheter) går ALDRI til sky, så uten en annen lokal modell får de ikke svar før du gjenopptar."
            : " Turer som ville gått hit faller til lokal modell eller en annen leverandør; sensitive turer berøres ikke.";
          if (pause.frozen) {
            actions.push(controlAction({
              id: `ai.resume:${row.provider}`, label: `Gjenoppta ${row.provider}`, endpoint: "/executive/mutate",
              body: { action: "unfreeze_connector", parameters: { connector_id: modelFreezeTarget(row.provider) } },
              risk_class: riskOf(deps.toolGateway, "executive", "unfreeze_connector"), requires_step_up: actionRequiresStepUp("unfreeze_connector"), reversible: true,
              description_no: `Opphever pausen av modellleverandøren «${row.provider}»: ruteren kan bruke den igjen fra neste modellkall (ingen omstart).`, rollback_no: "Pause leverandøren på nytt.", ...anchor
            }));
          } else if (row.configured) {
            actions.push(controlAction({
              id: `ai.pause:${row.provider}`, label: `Pause ${row.provider}`, endpoint: "/executive/mutate",
              body: { action: "freeze_connector", parameters: { connector_id: modelFreezeTarget(row.provider), reason: "Pauset av eier fra kontrollsenteret" } },
              risk_class: riskOf(deps.toolGateway, "executive", "freeze_connector"), requires_step_up: actionRequiresStepUp("freeze_connector"), reversible: true,
              description_no: `Stanser ALLE modellkall til «${row.provider}» fra neste kall, i både api og worker, uten omstart (også eksplisitte valg, fallback og AI-råd).${sensitiveNote}`,
              rollback_no: "Gjenoppta leverandøren (krever signert enhetsøkt).", ...anchor
            }));
          }
          const keyRef = (refsByProvider.get(row.provider) ?? [])[0];
          const registered = registry.some((c) => c.category === "model_provider" && c.id === row.provider);
          if (registered && keyRef !== undefined) {
            const restorable = pause.revoked_refs;
            if (restorable.length > 0) {
              for (const ref of restorable) {
                actions.push(controlAction({
                  id: `ai.restore:${row.provider}:${ref}`, label: `Gjenopprett ${ref}`, endpoint: "/executive/mutate", body: { action: "restore_credential", parameters: { credential_ref: ref } },
                  risk_class: riskOf(deps.toolGateway, "executive", "restore_credential"), requires_step_up: actionRequiresStepUp("restore_credential"), reversible: true,
                  description_no: `Gjenoppretter den tilbakekalte nøkkelen «${ref}» (selve verdien er uendret).`, rollback_no: "Tilbakekall nøkkelen på nytt.", ...anchor
                }));
              }
            } else if (row.configured) {
              const sharedWith = [...refsByProvider].filter(([p, refs]) => p !== row.provider && refs.includes(keyRef)).map(([p]) => p);
              const sharedConnectors = registry.filter((c) => c.id !== row.provider && c.credential_refs.includes(keyRef)).map((c) => c.display_name);
              const shared = [...sharedWith, ...sharedConnectors];
              actions.push(controlAction({
                id: `ai.revoke:${row.provider}:${keyRef}`, label: `Tilbakekall ${keyRef}`, endpoint: "/executive/mutate",
                body: { action: "revoke_credential", parameters: { credential_ref: keyRef, reason: "Tilbakekalt av eier fra kontrollsenteret" } },
                risk_class: riskOf(deps.toolGateway, "executive", "revoke_credential"), requires_step_up: actionRequiresStepUp("revoke_credential"), reversible: true,
                description_no: `Stanser modellkall til «${row.provider}» OG alle verktøy som bruker nøkkelen «${keyRef}»${shared.length > 0 ? ` (deles med: ${shared.join(", ")})` : ""} umiddelbart. Verdien slettes ikke.${sensitiveNote}`,
                rollback_no: "Gjenopprett nøkkelen (krever signert enhetsøkt).", ...anchor
              }));
            }
          }
        }
        items.sort(bySeverityThenLabel);
        const failures = [controlsR.ok ? "" : `pause-tilstanden (${controlsR.category})`, usageR.ok ? "" : `kostradene (${usageR.category})`].filter((x) => x !== "");
        const pausedCount = items.filter((i) => i.facts?.["paused"] === true).length;
        sections.push(controlSection({
          id: "providers", title_no: "Modellleverandører", source: "ModelGateway.providerOverview() (minne i denne prosessen) · owner_control_state (pause/tilbakekall, live) · cost_events (7 d, tenant-RLS)", observed_at: nowIso,
          status: failures.length > 0 ? "UNKNOWN" : "OK",
          summary_no: `${items.length} leverandører: ${countsNo(items)}.${pausedCount > 0 ? ` ${pausedCount} er pauset av deg.` : ""} Helse og kretser gjelder denne prosessen (workeren har sin egen).${failures.length > 0 ? ` Kunne ikke leses: ${failures.join(", ")} - berørte tall er ukjente.` : ""}`,
          items
        }));
      } else {
        sections.push(unknownControlSection("providers", "Modellleverandører", "ModelGateway.providerOverview()", `kunne ikke leses (${overviewR.category})`));
      }

      // =====================================================================================================================
      // 2. Ruting
      // =====================================================================================================================
      const routeItems: ControlItem[] = [];
      if (overviewR.ok) {
        const chainRows = GEMMA_FIRST_CHAIN.map((name) => overview.find((r) => r.provider === name)).filter((r): r is ProviderOverviewRow => r !== undefined);
        const chainUsable = chainRows.filter((r) => r.configured && !pausedSet.has(r.provider) && r.health.state !== "UNAVAILABLE").map((r) => r.provider);
        const split = usageR.ok ? localitySplit(usageR.value, localityOf) : null;
        const chatSplit = usageR.ok ? localitySplit(usageR.value, localityOf, "CHAT") : null;
        routeItems.push(controlItem({
          id: "gemma_first", label: "Gemma først (lokal modell som standard)", status: chainUsable.length > 0 ? "OK" : "WARN",
          detail_no: [
            `Standardkjeden ${GEMMA_FIRST_CHAIN.join(" → ")} har ${chainUsable.length === 0 ? "ingen brukbar leverandør - chat faller til øvrig ruting (D-354)" : chainUsable.length === 1 ? "1 brukbar leverandør" : `${chainUsable.length} brukbare leverandører`}`,
            split === null ? "lokal/sky-andel kunne ikke leses" : split.total_ok === 0 ? "ingen vellykkede kall siste 7 døgn" : `siste 7 døgn: ${pct(split.local_share ?? 0)} av ${split.total_ok} vellykkede modellkall var lokale, ${pct(split.cloud_share ?? 0)} sky`
          ].join(" · "),
          facts: {
            chain: GEMMA_FIRST_CHAIN.join(", "), usable: chainUsable.join(", ") || null,
            local_share_7d: split?.local_share ?? null, cloud_share_7d: split?.cloud_share ?? null, ok_calls_7d: split?.total_ok ?? null,
            chat_local_share_7d: chatSplit?.local_share ?? null, chat_ok_calls_7d: chatSplit?.total_ok ?? null
          }
        }));
        const locals = usableLocalProviders(overview, pausedSet);
        routeItems.push(controlItem({
          id: "sensitive_local", label: "Sensitive turer (helse, økonomi, hemmeligheter): kun lokal modell", status: locals.length > 0 ? "OK" : "WARN",
          detail_no: locals.length > 0
            ? `Går kun til lokal modell, aldri sky (D-378). ${locals.length} lokal leverandør kan svare nå: ${locals.join(", ")}.`
            : "Går kun til lokal modell, aldri sky (D-378) - og INGEN lokal leverandør er brukbar nå (ikke konfigurert, pauset eller utilgjengelig), så slike turer feiler lukket til en lokal modell er tilbake.",
          facts: { rule: "SECRET_RESTRICTED => kun lokal", usable_local: locals.join(", ") || null, paused_local: overview.filter((r) => r.locality === "local" && pausedSet.has(r.provider)).map((r) => r.provider).join(", ") || null }
        }));
      } else {
        routeItems.push(controlItem({ id: "gemma_first", label: "Gemma først (lokal modell som standard)", status: "UNKNOWN", detail_no: `Leverandørene kunne ikke leses (${overviewR.category}).` }));
      }

      const routeItem = (id: string, label: string, route: ToolTurnRoute | null, extra: string): ControlItem => {
        if (route === null) {
          return controlItem({ id, label, status: "OK", detail_no: `Av - ${extra} kjører på den lokale modellen.`, facts: { route: "off" } });
        }
        const row = overview.find((r) => r.provider === route.provider);
        const paused = pausedSet.has(route.provider);
        const down = !overviewR.ok ? null : row === undefined || !row.configured || row.health.state === "UNAVAILABLE";
        const downNo = row === undefined || !row.configured ? "ikke konfigurert" : "utilgjengelig akkurat nå";
        const capReached = dailyCapOre > 0 && dailyR.ok && dailyR.value >= dailyCapOre;
        const problems: string[] = [];
        if (paused) problems.push(`leverandøren «${route.provider}» er pauset av deg`);
        else if (down === true) problems.push(`leverandøren «${route.provider}» er ${downNo}`);
        if (capReached) problems.push(`dagstaket (${kr(dailyCapOre)}) er nådd`);
        const status: ControlStatus = problems.length > 0 ? "WARN" : down === null || (dailyCapOre > 0 && !dailyR.ok) ? "UNKNOWN" : "OK";
        return controlItem({
          id, label, status,
          detail_no: `${route.provider}:${route.model} · ${dailyCapOre === 0 ? "ingen dagstak" : dailyR.ok ? `i dag ${kr(dailyR.value)} av ${kr(dailyCapOre)}` : "dagens kost kunne ikke leses"}${problems.length > 0 ? ` · ${problems.join(", ")} - ${extra} går til lokal modell` : ""}`,
          facts: { route: describeRoute(route), provider: route.provider, model: route.model, provider_paused: paused, daily_cap_ore: dailyCapOre, spent_today_ore: dailyR.ok ? dailyR.value : null, cap_reached: capReached }
        });
      };
      routeItems.push(routeItem("tool_turn_route", "Verktøyturer i chat (D-431)", chatRoute, "verktøyturer"));
      routeItems.push(routeItem("job_route", "Delegerte bakgrunnsjobber med verktøy (D-449)", jobRoute, "jobbene"));

      if (lastRouteR.ok) {
        for (const r of [...lastRouteR.value].sort((a, b) => a.purpose.localeCompare(b.purpose))) {
          routeItems.push(controlItem({
            id: `last:${r.purpose}`, label: `Siste svar: ${r.purpose}`, status: "OK", observed_at: r.at,
            detail_no: `${r.provider}${r.model ? ` (${r.model})` : ""} · ${localityOf(r.provider) === "local" ? "lokal" : "sky"} · ${relativeNo(r.at, nowMs)}${r.fallback ? " · via fallback fra en annen leverandør" : ""}`,
            facts: { purpose: r.purpose, provider: r.provider, model: r.model, locality: localityOf(r.provider), fallback: r.fallback, at: r.at }
          }));
        }
      }
      const mesh = settleSync(() => deps.gateway.meshStatus());
      sections.push(controlSection({
        id: "routing", title_no: "Ruting", source: "ModelGateway (leverandørvalg, minne) · cost_events (7 d: siste rutevalg per formål, lokal/sky-andel) · miljø (JARVIS_TOOL_TURN_MODEL, JARVIS_JOB_TOOL_TURN_MODEL, JARVIS_TOOL_TURN_DAILY_CAP_ORE)",
        observed_at: nowIso, status: usageR.ok && lastRouteR.ok ? "OK" : "UNKNOWN",
        summary_no: `${routeItems.length} ruteopplysninger: ${countsNo(routeItems)}. Ruteren: ${mesh.ok ? mesh.value.router : "ukjent"}; fallback mellom leverandører: ${mesh.ok ? mesh.value.fallback : "ukjent"}. Sensitivitetsrutingen er uendret og kan ikke endres herfra.${usageR.ok && lastRouteR.ok ? "" : " Kostradene kunne ikke leses - andeler og siste rutevalg er ukjente."}`,
        items: routeItems
      }));

      // =====================================================================================================================
      // 3. Kost
      // =====================================================================================================================
      const costItems: ControlItem[] = [];
      if (budgetR.ok) {
        const b = budgetR.value;
        const level: ControlStatus = b.level === "ok" ? "OK" : b.level === "warn" ? "WARN" : "FAIL";
        costItems.push(controlItem({
          id: "budget", label: "Månedsbudsjett (modell)", status: level,
          detail_no: b.level === "ok" ? `Forbruk denne måneden: ${kr(b.spent_ore)} - under varselgrensen.`
            : b.level === "warn" ? `Forbruk denne måneden: ${kr(b.spent_ore)} - over varselgrensen.`
            : b.level === "needs_approval" ? `Forbruk denne måneden: ${kr(b.spent_ore)} - over godkjenningsgrensen: nye modellkall STOPPES til du godkjenner (JARVIS_BUDGET_APPROVED).`
            : `Forbruk denne måneden: ${kr(b.spent_ore)} - hardgrensen er nådd: nye modellkall nektes.`,
          facts: { level: b.level, spent_month_ore: b.spent_ore }
        }));
      } else {
        costItems.push(controlItem({ id: "budget", label: "Månedsbudsjett (modell)", status: "UNKNOWN", detail_no: `Kunne ikke måles (${budgetR.category}).`, facts: { level: null } }));
      }
      if (runRateR === null) {
        costItems.push(controlItem({ id: "run_rate", label: "Kost og prognose", status: "UNKNOWN", detail_no: "Run-rate-kilden er ikke koblet inn i dette senteret.", facts: { projected_month_ore: null } }));
      } else if (runRateR.ok) {
        const rr = runRateR.value;
        const hard = (() => { try { return budgetConfigFromEnv({ ...deps.env }).hard_limit_ore; } catch { return null; } })();
        const over = rr.totals.projected_month_ore !== null && hard !== null && rr.totals.projected_month_ore > hard;
        costItems.push(controlItem({
          id: "run_rate", label: "Kost og månedsprognose", status: rr.totals.projected_month_ore === null ? "UNKNOWN" : over ? "WARN" : "OK",
          detail_no: `I dag ${kr(rr.totals.today_ore)}, 7 d ${kr(rr.totals.last_7d_ore)}, 30 d ${kr(rr.totals.last_30d_ore)}. ${rr.totals.projected_month_ore === null ? "Månedsprognose: for lite data (under 3 døgn)." : `Prognose (snitt siste 7 d × 30): ${kr(rr.totals.projected_month_ore)}${over ? " - over hardgrensen" : ""}.`}${rr.cloud_share_30d !== null ? ` Andel sky (kost, 30 d): ${pct(rr.cloud_share_30d)}.` : ""}`,
          facts: { today_ore: rr.totals.today_ore, last_7d_ore: rr.totals.last_7d_ore, last_30d_ore: rr.totals.last_30d_ore, projected_month_ore: rr.totals.projected_month_ore, cloud_share_30d: rr.cloud_share_30d, hard_limit_ore: hard }
        }));
        for (const p of rr.by_provider.slice(0, 10)) {
          const failShare = p.calls >= FAIL_SHARE_MIN_CALLS ? p.failed_calls / p.calls : 0;
          costItems.push(controlItem({
            id: `cost:${p.provider}:${p.model ?? "ukjent"}`, label: `${p.provider}${p.model ? ` (${p.model})` : ""}`, status: failShare >= FAIL_SHARE_WARN ? "WARN" : "OK",
            detail_no: `30 d: ${p.calls} kall${p.failed_calls > 0 ? ` (${p.failed_calls} feilet)` : ""}, ${kr(p.ore)}, ${p.tokens_in} inn / ${p.tokens_out} ut tokens${p.local ? " · lokal" : ""}`,
            facts: { provider: p.provider, model: p.model, calls_30d: p.calls, failed_30d: p.failed_calls, ore_30d: p.ore, tokens_in_30d: p.tokens_in, tokens_out_30d: p.tokens_out, local: p.local }
          }));
        }
      } else {
        costItems.push(controlItem({ id: "run_rate", label: "Kost og månedsprognose", status: "UNKNOWN", detail_no: `Kunne ikke måles (${runRateR.category}).`, facts: { projected_month_ore: null } }));
      }
      sections.push(controlSection({
        id: "cost", title_no: "Kost", source: "cost_events via BudgetGuard og RunRateService (D-421; tenant-RLS) · miljø (JARVIS_COST_*)", observed_at: nowIso,
        summary_no: `${costItems.length} kostopplysninger: ${countsNo(costItems)}.${runRateR?.ok ? ` Ikke målt: ${runRateR.value.not_measured.slice(0, 2).join("; ")}.` : ""}`,
        items: costItems
      }));

      // =====================================================================================================================
      // 4. Evals og modellrådgiver
      // =====================================================================================================================
      const evalItems: ControlItem[] = [];
      const mode = deps.gateway.routingAdvisorMode;
      evalItems.push(controlItem({
        id: "advisor", label: "Modellrådgiver (D-399)", status: "OK",
        detail_no: mode === "off" ? "Av: ingen rådgivning."
          : mode === "shadow" ? "Skygge: rådgiveren logger hva den VILLE valgt, men endrer ingenting. Antall avvik spores i trace-sinken, ikke i databasen, og er derfor ikke målt her."
          : "AKTIV: rådgiveren velger billigste modell som holder innenfor ruterens primære leverandør. Antall avvik spores i trace-sinken og er ikke målt her.",
        facts: { mode, shadow_decisions: mode === "off" ? null : "ikke målt her (trace-sink)" }
      }));
      if (evoR === null) {
        evalItems.push(controlItem({ id: "ev12_shadow_route", label: "Skygge-modellrute (EV-12)", status: "UNKNOWN", detail_no: "Evolusjonsrapporten er ikke koblet inn i dette senteret." }));
      } else if (evoR.ok) {
        const section = evoR.value.sections.find((s) => s.ev === "EV-12");
        if (section === undefined) {
          evalItems.push(controlItem({ id: "ev12_shadow_route", label: "Skygge-modellrute (EV-12)", status: "UNKNOWN", detail_no: "Evolusjonsrapporten har ingen EV-12-seksjon." }));
        } else {
          const st: ControlStatus = section.status === "OK" ? "OK" : section.status === "ATTENTION" ? "WARN" : "UNKNOWN";
          evalItems.push(controlItem({
            id: "ev12_shadow_route", label: "Skygge-modellrute (EV-12)", status: st, observed_at: section.observed_at,
            detail_no: `${section.summary_no} ${section.findings.slice(0, 2).join(" ")}`.trim(), facts: { ev: section.ev, source: section.source, evolution_status: section.status }
          }));
        }
      } else {
        evalItems.push(controlItem({ id: "ev12_shadow_route", label: "Skygge-modellrute (EV-12)", status: "UNKNOWN", detail_no: `Evolusjonsrapporten kunne ikke leses (${evoR.category}).` }));
      }
      evalItems.push(controlItem({
        id: "golden_suite", label: "Golden-suite og modellmåling (EV-4/D-439)", status: "UNKNOWN",
        detail_no: "IKKE MÅLT: eval-kjernen finnes (evals.ts), men golden-task-biblioteket og kjøring mot modeller er DEFERRED (EV-4), og modellmålingen (bake-off) er et manuelt skript som ikke lagrer resultater. Det finnes derfor ingen kvalitetstall å vise.",
        facts: { status: "DEFERRED", results_stored: false }
      }));
      sections.push(controlSection({
        id: "evals", title_no: "Evals og modellrådgiver", source: "ModelGateway.routingAdvisorMode (D-399) · evolusjonsrapporten EV-12 (B1) · golden-suite: ingen kilde (DEFERRED)", observed_at: nowIso,
        summary_no: `${evalItems.length} punkter: ${countsNo(evalItems)}. Golden-suiten er ikke bygget, så modellkvalitet er ukjent - ikke «i orden».`, items: evalItems
      }));

      // =====================================================================================================================
      // 5. Parallell delegering: overhead
      // =====================================================================================================================
      const delegationItems: ControlItem[] = [];
      if (deps.councilLimiter === undefined) {
        delegationItems.push(controlItem({ id: "council_auto", label: "AI-råd: automatisk trigger", status: "UNKNOWN", detail_no: "Begrenseren er ikke koblet inn i dette senteret." }));
      } else {
        const lim = settleSync(() => deps.councilLimiter!.usage(tenantId));
        if (lim.ok) {
          const u = lim.value;
          const reached = u.used_in_window >= u.max_per_window;
          delegationItems.push(controlItem({
            id: "council_auto", label: "AI-råd: automatisk trigger (fem betalte kall + kritikk + syntese)", status: reached ? "WARN" : "OK",
            detail_no: `${u.used_in_window} av ${u.max_per_window} plasser brukt siste ${Math.round(u.window_ms / 60_000)} min${reached ? " - taket er nådd, flere automatiske råd faller tilbake til vanlig samtale" : ""}. Siden oppstart: ${u.acquired_total} gitt, ${u.denied_total} nektet (nullstilles ved omstart). Eksplisitt bestilling («bruk AI-rådet») begrenses aldri.`,
            facts: { used_in_window: u.used_in_window, max_per_window: u.max_per_window, window_minutes: Math.round(u.window_ms / 60_000), acquired_since_start: u.acquired_total, denied_since_start: u.denied_total }
          }));
        } else {
          delegationItems.push(controlItem({ id: "council_auto", label: "AI-råd: automatisk trigger", status: "UNKNOWN", detail_no: `Kunne ikke leses (${lim.category}).` }));
        }
      }
      if (tasksR.ok) {
        const active = tasksR.value.filter((t) => t.delegated && t.status !== "paused").length;
        delegationItems.push(controlItem({
          id: "background_jobs", label: "Samtidige bakgrunnsjobber delegert fra chat", status: active >= maxActiveJobs ? "WARN" : "OK",
          detail_no: `${active} av maks ${maxActiveJobs} kjører eller venter${active >= maxActiveJobs ? " - taket er nådd, nye delegeringer avvises til en er ferdig" : ""}.`,
          facts: { active_delegated: active, max_active: maxActiveJobs }
        }));
      } else {
        delegationItems.push(controlItem({ id: "background_jobs", label: "Samtidige bakgrunnsjobber delegert fra chat", status: "UNKNOWN", detail_no: `Kunne ikke leses (${tasksR.category}).` }));
      }
      if (delegationR.ok) {
        const d = delegationR.value;
        const failedShare = d.task_calls === 0 ? 0 : d.task_failed / d.task_calls;
        delegationItems.push(controlItem({
          id: "task_cost", label: "Kost bokført på bakgrunnsjobber (7 d)", status: d.task_calls >= FAIL_SHARE_MIN_CALLS && failedShare >= FAIL_SHARE_WARN ? "WARN" : "OK",
          detail_no: `${d.task_calls} av ${d.all_calls} modellkall (${d.all_calls === 0 ? "0 %" : pct(d.task_calls / d.all_calls)}) og ${kr(d.task_ore)} av ${kr(d.all_ore)} er knyttet til jobber${d.task_failed > 0 ? `; ${d.task_failed} feilet` : ""}.`,
          facts: { task_calls_7d: d.task_calls, all_calls_7d: d.all_calls, task_ore_7d: d.task_ore, all_ore_7d: d.all_ore, task_failed_7d: d.task_failed }
        }));
      } else {
        delegationItems.push(controlItem({ id: "task_cost", label: "Kost bokført på bakgrunnsjobber (7 d)", status: "UNKNOWN", detail_no: `Kunne ikke leses (${delegationR.category}).` }));
      }
      if (usageR.ok) {
        const critic = usageR.value.reduce((a, r) => a + r.critic_calls, 0);
        const fallback = usageR.value.reduce((a, r) => a + r.fallback_calls, 0);
        const failed = usageR.value.reduce((a, r) => a + r.failed_calls, 0);
        const ok = usageR.value.reduce((a, r) => a + r.ok_calls, 0);
        delegationItems.push(controlItem({
          id: "extra_calls", label: "Ekstra modellkall: kritikk, fallback og feil (7 d)", status: ok + failed >= FAIL_SHARE_MIN_CALLS && failed / (ok + failed) >= FAIL_SHARE_WARN ? "WARN" : "OK",
          detail_no: `${critic} kritikkkall, ${fallback} svar via fallback, ${failed} feilede forsøk (0 øre, men sløser tid) av ${ok + failed + critic} kall.`,
          facts: { critic_calls_7d: critic, fallback_calls_7d: fallback, failed_calls_7d: failed, ok_calls_7d: ok }
        }));
      }
      delegationItems.push(controlItem({
        id: "specialist", label: "Spesialist-delegering (delegate_code_task, D-355)", status: "OK",
        detail_no: "Ikke koblet inn: modulen finnes, men ingen verktøyflate bruker den i drift, så det er ingen teller å vise (DEFERRED - ikke en feil).",
        facts: { wired: false }
      }));
      sections.push(controlSection({
        id: "delegation", title_no: "Parallell delegering og overhead", source: "CouncilAutoTriggerLimiter.usage() (minne, nullstilles ved omstart) · tasks og cost_events (7 d, tenant-RLS)", observed_at: nowIso,
        summary_no: `${delegationItems.length} punkter: ${countsNo(delegationItems)}. Tellerne for AI-rådet er prosesslokale; kost på jobber er en måling av modellkall med jobb-id, ikke en full kostnadsfordeling.`, items: delegationItems
      }));

      // =====================================================================================================================
      // 6. Kjørende agenter og jobber (+ avbryt)
      // =====================================================================================================================
      if (tasksR.ok) {
        const rows: ActiveTaskRow[] = tasksR.value;
        const built = activeTaskRows(rows, nowMs, deps.toolGateway, "agents");
        actions.push(...built.actions);
        const c: TaskCounts | null = countsR.ok ? countsR.value : null;
        sections.push(controlSection({
          id: "agents", title_no: "Kjørende agenter og jobber", source: "tasks (created/running/paused + utfall siste 24 t; tenant-RLS; aldri tittel eller innhold) · avbryt via executive.cancel_task", observed_at: nowIso,
          status: countsR.ok ? "OK" : "UNKNOWN",
          summary_no: c === null
            ? `${rows.length} aktive jobber vises; tellingen kunne ikke leses (${countsR.ok ? "" : countsR.category}).`
            : `${c.running} kjører, ${c.created} venter, ${c.paused} er pauset. Siste 24 t: ${c.completed_24h} ferdige, ${c.failed_24h} feilet, ${c.cancelled_24h} avbrutt. Tittel og innhold vises ikke (finnes i chatten); avbryt stopper jobben ved neste trygge punkt.${c.running + c.created + c.paused > rows.length ? ` Viser de ${rows.length} eldste.` : ""}`,
          items: built.items
        }));
      } else {
        sections.push(unknownControlSection("agents", "Kjørende agenter og jobber", "tasks (tenant-RLS)", `kunne ikke leses (${tasksR.category})`));
      }

      return { sections, actions };
    }
  };
}

/** Synkron variant av `settle` for rene minneoppslag. */
function settleSync<T>(read: () => T): Settled<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    return { ok: false, category: err instanceof Error ? err.name || "Error" : "ukjent feil" };
  }
}
