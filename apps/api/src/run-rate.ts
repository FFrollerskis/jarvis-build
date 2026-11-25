// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction } from "@jarvis/core";
import { financeWithheldMarker, isFinanceConnectorId, withholdFinanceFromCurrentModel, type ToolDefinition, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";

/**
 * D-421 (UA0-RUNRATE): run-rate - hva Jarvis faktisk koster (modell per leverandør/formål/dag, prognose for måneden) og hva connectorene koster i
 * vedlikeholdstid (`connector_maintenance_log`, migrasjon 077). Leser KUN eksisterende `cost_events` og `brief_seen` under tenant-RLS. Det som IKKE
 * er målt står eksplisitt i rapporten (STT/TTS og connector-API-kostnader er ikke i `cost_events`, JARVIS-039) - aldri stille utelatt.
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

const LOCAL_PROVIDERS = new Set(["gemma_local", "local_llm", "ollama", "scripted", "local_vision"]);
export const MAINTENANCE_KINDS = ["incident", "credential_rotation", "api_change", "manual_fix", "upgrade", "outage", "other"] as const;

export interface RunRateReport {
  as_of: string;
  totals: { today_ore: number; last_7d_ore: number; last_30d_ore: number; projected_month_ore: number | null };
  /** Andel av 30-dagers kostnad som gikk til skyleverandører (ikke-lokale). null uten kostnad. */
  cloud_share_30d: number | null;
  by_provider: Array<{ provider: string; model: string | null; local: boolean; calls: number; failed_calls: number; ore: number; tokens_in: number; tokens_out: number }>;
  by_purpose: Array<{ purpose: string; calls: number; ore: number }>;
  daily: Array<{ day: string; calls: number; ore: number }>;
  maintenance: {
    minutes_30d: number;
    by_connector: Array<{ connector_id: string; events: number; minutes: number }>;
    recent: Array<{ connector_id: string; event_kind: string; minutes: number; reason: string; occurred_at: string }>;
  };
  /** Bruksbevis for «daglig verdi»: antall døgn siste 30 der Daily Brief er vist (proxy, ikke en bruksmetrikk). */
  value_loop: { brief_days_30d: number };
  not_measured: string[];
  summary_no: string;
}

const NOT_MEASURED = [
  "STT/TTS-kostnad (stemme) er ikke registrert i cost_events",
  "Connector-/API-kostnader (søk, kart, SMS m.fl.) er ikke registrert i cost_events",
  "Prognosen er en enkel snitt-av-siste-7-døgn × 30 - ikke en budsjettgaranti"
];

const nOre = (v: unknown): number => Math.round(Number(v ?? 0));
const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;

export class RunRateService {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  private q<T extends Record<string, unknown>>(tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    return withTenantTransaction(this.pool as pg.Pool, tenantId, async (client) => (await client.query(sql, params)).rows as T[]);
  }

  async report(tenantId: string): Promise<RunRateReport> {
    const asOf = this.now();
    const [totals] = await this.q<{ today: number; d7: number; d30: number; days_with_data_7: number }>(
      tenantId,
      `SELECT coalesce(sum(amount_ore) FILTER (WHERE at >= date_trunc('day', now())), 0)::int AS today,
              coalesce(sum(amount_ore) FILTER (WHERE at >= now() - interval '7 days'), 0)::int AS d7,
              coalesce(sum(amount_ore) FILTER (WHERE at >= now() - interval '30 days'), 0)::int AS d30,
              count(DISTINCT date_trunc('day', at)) FILTER (WHERE at >= now() - interval '7 days')::int AS days_with_data_7
         FROM cost_events WHERE at >= now() - interval '30 days'`
    );
    const byProvider = await this.q<{ provider: string | null; model: string | null; calls: number; failed: number; ore: number; tin: number; tout: number }>(
      tenantId,
      `SELECT provider, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT success)::int AS failed, coalesce(sum(amount_ore), 0)::int AS ore,
              coalesce(sum(input_tokens), 0)::bigint AS tin, coalesce(sum(output_tokens), 0)::bigint AS tout
         FROM cost_events WHERE at >= now() - interval '30 days' GROUP BY provider, model ORDER BY ore DESC, calls DESC LIMIT 30`
    );
    const byPurpose = await this.q<{ purpose: string | null; calls: number; ore: number }>(
      tenantId,
      `SELECT purpose, count(*)::int AS calls, coalesce(sum(amount_ore), 0)::int AS ore
         FROM cost_events WHERE at >= now() - interval '30 days' GROUP BY purpose ORDER BY ore DESC, calls DESC LIMIT 20`
    );
    const daily = await this.q<{ day: string; calls: number; ore: number }>(
      tenantId,
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int AS calls, coalesce(sum(amount_ore), 0)::int AS ore
         FROM cost_events WHERE at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`
    );
    const maint = await this.q<{ connector_id: string; events: number; minutes: number }>(
      tenantId,
      `SELECT connector_id, count(*)::int AS events, coalesce(sum(minutes), 0)::int AS minutes
         FROM connector_maintenance_log WHERE occurred_at >= now() - interval '30 days' GROUP BY connector_id ORDER BY minutes DESC, connector_id LIMIT 30`
    );
    const recent = await this.q<{ connector_id: string; event_kind: string; minutes: number; reason: string; occurred_at: Date | string }>(
      tenantId,
      `SELECT connector_id, event_kind, minutes, reason, occurred_at FROM connector_maintenance_log ORDER BY occurred_at DESC, log_id DESC LIMIT 5`
    );
    const [brief] = await this.q<{ days: number }>(
      tenantId,
      `SELECT count(DISTINCT date_trunc('day', last_presented))::int AS days FROM brief_seen WHERE last_presented >= now() - interval '30 days'`
    );

    const d30 = totals?.d30 ?? 0;
    const providers = byProvider.map((r) => {
      const provider = r.provider ?? "ukjent";
      return { provider, model: r.model, local: LOCAL_PROVIDERS.has(provider), calls: r.calls, failed_calls: r.failed, ore: nOre(r.ore), tokens_in: Number(r.tin), tokens_out: Number(r.tout) };
    });
    const cloudOre = providers.filter((p) => !p.local).reduce((a, p) => a + p.ore, 0);
    const days7 = totals?.days_with_data_7 ?? 0;
    const report: Omit<RunRateReport, "summary_no"> = {
      as_of: asOf.toISOString(),
      totals: { today_ore: totals?.today ?? 0, last_7d_ore: totals?.d7 ?? 0, last_30d_ore: d30, projected_month_ore: days7 >= 3 ? Math.round(((totals?.d7 ?? 0) / days7) * 30) : null },
      cloud_share_30d: d30 > 0 ? Math.round((cloudOre / d30) * 1000) / 1000 : null,
      by_provider: providers,
      by_purpose: byPurpose.map((r) => ({ purpose: r.purpose ?? "ukjent", calls: r.calls, ore: nOre(r.ore) })),
      daily: daily.map((r) => ({ day: r.day, calls: r.calls, ore: nOre(r.ore) })),
      maintenance: {
        minutes_30d: maint.reduce((a, m) => a + m.minutes, 0),
        by_connector: maint,
        recent: recent.map((r) => ({ connector_id: r.connector_id, event_kind: r.event_kind, minutes: r.minutes, reason: r.reason, occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : new Date(r.occurred_at).toISOString() }))
      },
      value_loop: { brief_days_30d: brief?.days ?? 0 },
      not_measured: [...NOT_MEASURED]
    };
    return { ...report, summary_no: renderRunRateNo(report) };
  }

  /**
   * WP-N1b fiks-runde 1 (FIX-5): vedlikeholdsloggen for en SKY-/ukjent modell - UTEN finanskoblinger, og uten å lese kostnadsdata i det hele tatt. Finanskoblingene filtreres i SQL FØR `LIMIT` (en tillatelsesliste over de koblings-id-ene som
   * KJENT ikke er finans, `isFinanceConnectorId`: fail-closed, så en id som dukker opp underveis utelates): ellers ville nye finansrader stjålet plassene i `recent` (LIMIT 5) og tømt skyens liste mens summen var uendret - et orakel for at
   * finansvedlikehold finnes. Summen (`minutes_30d`) regnes på de SAMME radene som `by_connector`. Fritekst-begrunnelsen (`reason`) holdes tilbake (`null`): eieren har skrevet den, og ukjent innhold regnes som finans (samme regel som `owner_control`).
   * Alt i ÉN transaksjon (RLS, én øyeblikkstilstand).
   */
  async maintenanceWithoutFinance(tenantId: string): Promise<{ minutes_30d: number; by_connector: Array<{ connector_id: string; events: number; minutes: number }>; recent: Array<{ connector_id: string; event_kind: string; minutes: number; reason: null; occurred_at: string }> }> {
    return withTenantTransaction(this.pool as pg.Pool, tenantId, async (client) => {
      const known = (await client.query("SELECT DISTINCT connector_id FROM connector_maintenance_log")).rows as Array<{ connector_id: string }>;
      const allowed = known.map((r) => r.connector_id).filter((id) => !isFinanceConnectorId(id));
      const by_connector = (await client.query(
        `SELECT connector_id, count(*)::int AS events, coalesce(sum(minutes), 0)::int AS minutes
           FROM connector_maintenance_log WHERE occurred_at >= now() - interval '30 days' AND connector_id = ANY($1::text[]) GROUP BY connector_id ORDER BY minutes DESC, connector_id LIMIT 30`, [allowed]
      )).rows as Array<{ connector_id: string; events: number; minutes: number }>;
      const recent = (await client.query(
        `SELECT connector_id, event_kind, minutes, occurred_at FROM connector_maintenance_log WHERE connector_id = ANY($1::text[]) ORDER BY occurred_at DESC, log_id DESC LIMIT 5`, [allowed]
      )).rows as Array<{ connector_id: string; event_kind: string; minutes: number; occurred_at: Date | string }>;
      return {
        minutes_30d: by_connector.reduce((a, m) => a + m.minutes, 0),
        by_connector,
        recent: recent.map((r) => ({ connector_id: r.connector_id, event_kind: r.event_kind, minutes: r.minutes, reason: null, occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : new Date(r.occurred_at).toISOString() }))
      };
    });
  }

  async recordMaintenance(tenantId: string, recordedBy: string, input: { connector_id: string; event_kind: (typeof MAINTENANCE_KINDS)[number]; minutes: number; reason: string; occurred_at?: string }): Promise<{ log_id: string }> {
    const reason = scanForSecrets(input.reason).text.trim();
    const rows = await this.q<{ log_id: string }>(
      tenantId,
      `INSERT INTO connector_maintenance_log (tenant_id, connector_id, event_kind, minutes, reason, occurred_at, recorded_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7) RETURNING log_id::text AS log_id`,
      [tenantId, input.connector_id, input.event_kind, input.minutes, reason, input.occurred_at ?? null, recordedBy]
    );
    return { log_id: rows[0]!.log_id };
  }
}

/** Deterministisk norsk oppsummering (ingen LLM). Ukjent/ikke målt sies tydelig. */
export function renderRunRateNo(r: Omit<RunRateReport, "summary_no">): string {
  const lines: string[] = [];
  lines.push(`Modellkostnad: i dag ${kr(r.totals.today_ore)}, siste 7 døgn ${kr(r.totals.last_7d_ore)}, siste 30 døgn ${kr(r.totals.last_30d_ore)}.`);
  lines.push(r.totals.projected_month_ore === null ? "Månedsprognose: for lite data (under 3 døgn med målinger)." : `Månedsprognose (snitt siste 7 døgn × 30): ${kr(r.totals.projected_month_ore)}.`);
  if (r.cloud_share_30d !== null) lines.push(`Andel til skyleverandører siste 30 døgn: ${Math.round(r.cloud_share_30d * 100)} %.`);
  const top = r.by_provider.filter((p) => p.ore > 0).slice(0, 3);
  if (top.length > 0) lines.push(`Dyreste: ${top.map((p) => `${p.provider}${p.model ? ` (${p.model})` : ""} ${kr(p.ore)}`).join("; ")}.`);
  const failing = r.by_provider.filter((p) => p.calls >= 5 && p.failed_calls / p.calls >= 0.3);
  if (failing.length > 0) lines.push(`Mange feilede kall: ${failing.map((p) => `${p.provider}${p.model ? ` (${p.model})` : ""} ${p.failed_calls}/${p.calls}`).join("; ")}.`);
  lines.push(r.maintenance.minutes_30d > 0 ? `Connector-vedlikehold siste 30 døgn: ${r.maintenance.minutes_30d} min (${r.maintenance.by_connector.slice(0, 3).map((m) => `${m.connector_id} ${m.minutes} min`).join("; ")}).` : "Connector-vedlikehold: ingenting registrert siste 30 døgn.");
  lines.push(`Daily Brief vist ${r.value_loop.brief_days_30d} av siste 30 døgn.`);
  lines.push(`Ikke målt: ${r.not_measured.join("; ")}.`);
  return lines.join("\n");
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

export class RunRateTransport implements ToolTransport {
  constructor(private readonly service: RunRateService) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, _credential: string, context?: ToolInvocationContext): Promise<{ data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity) throw new Error("run_rate_missing_invocation_context");
    switch (action) {
      case "get_cost_overview":
        // WP-N1b (JARVIS-116 a, K2, strengeste regel til Q-64 pkt 1 er besvart): hele rapporten er modellkost i øre (i dag/7/30 døgn, prognose, per leverandør og formål) - holdt tilbake fra sky/ukjent VED UTFØRELSE (sentral lesning).
        // Lokal modell og eierens ruter får den som før; flagg AV er uendret.
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        return { data: (await this.service.report(identity.tenant_id)) as unknown as JsonValue };
      case "list_connector_maintenance": {
        // WP-N1b (K2 + FIX-5): vedlikeholdstid per finanskobling (og begrunnelsene, fritekst) er finansavledet: for sky/ukjent filtreres finanskoblingene i SQL FØR LIMIT (ingen plassmangel, ingen orakel), summen regnes på resten,
        // og kostnadsrapporten leses ikke i det hele tatt. Svaret har alltid det nøytrale merket. Lokal modell og eier: som før.
        if (withholdFinanceFromCurrentModel()) return { data: { ...(await this.service.maintenanceWithoutFinance(identity.tenant_id)), ...financeWithheldMarker() } as unknown as JsonValue };
        const r = await this.service.report(identity.tenant_id);
        return { data: r.maintenance as unknown as JsonValue };
      }
      case "record_connector_maintenance": {
        const kind = String(parameters["event_kind"] ?? "other");
        if (!(MAINTENANCE_KINDS as readonly string[]).includes(kind)) throw new Error("invalid_event_kind");
        const res = await this.service.recordMaintenance(identity.tenant_id, identity.person_id, {
          connector_id: String(parameters["connector_id"] ?? ""),
          event_kind: kind as (typeof MAINTENANCE_KINDS)[number],
          minutes: Number(parameters["minutes"] ?? 0),
          reason: String(parameters["reason"] ?? ""),
          ...(typeof parameters["occurred_at"] === "string" ? { occurred_at: parameters["occurred_at"] } : {})
        });
        return { data: res as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_run_rate_action:${action}`);
    }
  }
}

export function runRateToolDefinitions(transport: RunRateTransport): ToolDefinition[] {
  const common = { tool_id: "run_rate", scopes: ["run_rate.read"] as string[], credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", transport, timeout_ms: 15_000, reversible: true, idempotent_external: true, output_trust: "internal" as const };
  return [
    {
      ...common, action: "get_cost_overview",
      description: "Hva Jarvis koster akkurat nå: modellkostnad i dag/7/30 døgn, månedsprognose, fordeling per leverandør og formål, andel til sky, connector-vedlikeholdstid og hva som IKKE er målt. Svar fra EKTE tall (cost_events) - aldri gjett.",
      input_schema: record({}), capability_class: "A", rollback_procedure: "ingen (lesing)", rate_limit_per_minute: 20
    },
    {
      ...common, action: "list_connector_maintenance",
      description: "Eierens register over tid brukt på å vedlikeholde connectorer (siste 30 døgn per connector, og de siste hendelsene).",
      input_schema: record({}), capability_class: "A", rollback_procedure: "ingen (lesing)", rate_limit_per_minute: 20
    },
    {
      ...common, action: "record_connector_maintenance", scopes: ["run_rate.write"],
      description: "Eier-handling (kun dashbord-grant, ikke modellflaten): registrer en vedlikeholdshendelse for en connector (append-only; en rettelse er en ny rad).",
      input_schema: record({
        connector_id: z.string().min(1).max(80), event_kind: z.enum(MAINTENANCE_KINDS), minutes: z.number().int().min(0).max(100000),
        reason: z.string().min(1).max(500), occurred_at: z.string().datetime().optional()
      }),
      capability_class: "B", rollback_procedure: "append-only: registrer en korrigerende rad", rate_limit_per_minute: 20
    }
  ];
}
