// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { DAILY_BRIEF_JOB_NAME } from "@jarvis/tool-gateway";
import type { ValueMeasurement, ValueMeasurementSet, ValueMeasurementSource, ValueWindows } from "@jarvis/executive";

/**
 * WP-C4: datakilden for Value Center. Leser KUN eksisterende tabeller (cost_events, tool_executions, scheduler_state, messages, tasks, action_confirmations, approvals, audit_events, business_followups,
 * business_open_loops, incidents) som app-rollen under RLS - ingen ny tabell, ingen skriving. Hver spørring returnerer KUN tellinger, summer, gjennomsnitt og maks (aldri en kolonne med innhold: ingen meldingstekst,
 * mål, tittel, årsak eller payload leses). En spørring som feiler gir `not_measurable` for NØYAKTIG de metrikkene den eier, med feilkoden (SQLSTATE) som årsak - aldri et påstått 0 og aldri feilmeldingens tekst.
 *
 * Vinduer: «siste 7/30 døgn» er hele lokale døgn i Europe/Oslo, i dag inkludert (grensene regnes i databasen, DST-trygt), slik at «døgn med bruk» aldri kan bli 8 av 7.
 * Rom: oppfølginger og hendelser er rom-skopet (RLS); helse og gjest leses aldri (helse kan ikke kombineres med andre rom). `scheduler_state` er én delt tabell uten tenant-RLS og vises kun for eierens tenant.
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

const SPACES = ["personal", "business", "project", "home", "shared"] as const;
const TIME_ZONE = "Europe/Oslo";
const CACHE_MAX_TENANTS = 8;

interface Ctx {
  pool: Pool;
  tenantId: string;
  /** Tidspunktet vinduene regnes mot. */
  asOf: Date;
  /** Starten av siste 7 / 30 lokale døgn. */
  d7: Date;
  d30: Date;
  /** Lokale datoer (YYYY-MM-DD) for i dag, 7- og 30-døgnsvinduets første døgn. */
  today: string;
  d7Date: string;
  d30Date: string;
  schedulerTenantId: string | null;
  dailyBriefJob: string;
}

type Row = Record<string, unknown>;

const q = (ctx: Ctx, sql: string, params: unknown[]): Promise<Row> =>
  withTenantTransaction(ctx.pool as pg.Pool, ctx.tenantId, async (client) => (await client.query(sql, params)).rows[0] as Row);
const qSpaces = (ctx: Ctx, sql: string, params: unknown[]): Promise<Row> =>
  withMemoryTransaction(ctx.pool as pg.Pool, ctx.tenantId, SPACES, async (client) => (await client.query(sql, params)).rows[0] as Row);

/** Antall/summer: heltall (aldri null). */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/** Gjennomsnitt/maks: null når det ikke finnes grunnlag (aldri 0). Rundes til 2 desimaler. */
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

const win = (id: string, d7: number | null, d30: number | null): ValueMeasurement => ({ id, state: "measured", last_7d: d7, last_30d: d30 });
const snap = (id: string, now: number | null): ValueMeasurement => ({ id, state: "measured", now });

interface Probe {
  /** Metrikk-id-ene denne spørringen eier (de som markeres ikke målbare hvis den feiler). */
  ids: readonly string[];
  run(ctx: Ctx): Promise<ValueMeasurement[]>;
}

/** Hver proben eier en disjunkt mengde id-er; samlet dekker de alle kildebaserte katalogmetrikker (låst av test). */
export const VALUE_PROBES: readonly Probe[] = [
  // ---- V1 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["v1.briefs_generated", "v1.days_with_brief"],
    async run(ctx) {
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE at >= $2)::int AS gen7, count(*)::int AS gen30,
                count(DISTINCT (timezone('${TIME_ZONE}', at))::date) FILTER (WHERE at >= $2)::int AS days7,
                count(DISTINCT (timezone('${TIME_ZONE}', at))::date)::int AS days30
           FROM cost_events WHERE kind = 'brief:generation' AND at >= $3 AND at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("v1.briefs_generated", n(r["gen7"]), n(r["gen30"])), win("v1.days_with_brief", n(r["days7"]), n(r["days30"]))];
    }
  },
  {
    ids: ["v1.briefs_delivered"],
    async run(ctx) {
      // Nøkkelen er `brief-<ISO-tid>-<delnr>` (DailyBrief.deliverViaTelegram); del 0 ER briefen, så en flerdelt brief telles én gang.
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE executed_at >= $2)::int AS d7, count(*)::int AS d30
           FROM tool_executions
          WHERE tool_id = 'telegram' AND action = 'notify' AND status = 'succeeded'
            AND idempotency_key ~ '^brief-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z-0$' AND executed_at >= $3 AND executed_at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("v1.briefs_delivered", n(r["d7"]), n(r["d30"]))];
    }
  },
  {
    ids: ["v1.runner_days_completed", "v1.runner_days_lost", "v1.runner_retry_days"],
    async run(ctx) {
      // scheduler_state er global (ingen tenant-RLS): kun eierens tenant får se løperens helse.
      if (ctx.schedulerTenantId === null || ctx.tenantId !== ctx.schedulerTenantId) {
        const reason = "den daglige løperen er én delt tabell uten tenant-skille og vises kun for eierens tenant";
        return ["v1.runner_days_completed", "v1.runner_days_lost", "v1.runner_retry_days"].map((id): ValueMeasurement => ({ id, state: "not_measurable", reason_no: reason }));
      }
      const { rows } = await ctx.pool.query(
        `SELECT count(*) FILTER (WHERE completed_at IS NOT NULL AND run_date >= $2::date)::int AS done7,
                count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done30,
                count(*) FILTER (WHERE completed_at IS NULL AND run_date < $1::date AND run_date >= $2::date)::int AS lost7,
                count(*) FILTER (WHERE completed_at IS NULL AND run_date < $1::date)::int AS lost30,
                count(*) FILTER (WHERE attempts > 1 AND run_date >= $2::date)::int AS retry7,
                count(*) FILTER (WHERE attempts > 1)::int AS retry30
           FROM scheduler_state WHERE job_name = $4 AND run_date >= $3::date AND run_date <= $1::date`, [ctx.today, ctx.d7Date, ctx.d30Date, ctx.dailyBriefJob]);
      const r = rows[0] as Row;
      return [win("v1.runner_days_completed", n(r["done7"]), n(r["done30"])), win("v1.runner_days_lost", n(r["lost7"]), n(r["lost30"])), win("v1.runner_retry_days", n(r["retry7"]), n(r["retry30"]))];
    }
  },

  // ---- V2 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["v2.followups_open_now", "v2.followups_overdue_now", "v2.followups_avg_open_age_days", "v2.followups_max_overdue_days", "v2.followups_created", "v2.followups_closed", "v2.followups_cancelled"],
    async run(ctx) {
      const r = await qSpaces(ctx,
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open_now,
                count(*) FILTER (WHERE status = 'open' AND due_at < $1)::int AS overdue_now,
                (avg(extract(epoch FROM ($1::timestamptz - created_at)) / 86400.0) FILTER (WHERE status = 'open'))::float8 AS avg_age,
                (max(extract(epoch FROM ($1::timestamptz - due_at)) / 86400.0) FILTER (WHERE status = 'open' AND due_at < $1))::float8 AS max_overdue,
                count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)::int AS created7,
                count(*) FILTER (WHERE created_at >= $3 AND created_at < $1)::int AS created30,
                count(*) FILTER (WHERE status = 'completed' AND completed_at >= $2 AND completed_at < $1)::int AS closed7,
                count(*) FILTER (WHERE status = 'completed' AND completed_at >= $3 AND completed_at < $1)::int AS closed30,
                count(*) FILTER (WHERE status = 'cancelled' AND cancelled_at >= $2 AND cancelled_at < $1)::int AS cancelled7,
                count(*) FILTER (WHERE status = 'cancelled' AND cancelled_at >= $3 AND cancelled_at < $1)::int AS cancelled30
           FROM business_followups`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [
        snap("v2.followups_open_now", n(r["open_now"])), snap("v2.followups_overdue_now", n(r["overdue_now"])),
        snap("v2.followups_avg_open_age_days", nn(r["avg_age"])), snap("v2.followups_max_overdue_days", nn(r["max_overdue"])),
        win("v2.followups_created", n(r["created7"]), n(r["created30"])), win("v2.followups_closed", n(r["closed7"]), n(r["closed30"])), win("v2.followups_cancelled", n(r["cancelled7"]), n(r["cancelled30"]))
      ];
    }
  },
  {
    ids: ["v2.open_loops_open_now", "v2.open_loops_overdue_now", "v2.open_loops_resolved"],
    async run(ctx) {
      const r = await qSpaces(ctx,
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open_now,
                count(*) FILTER (WHERE status = 'open' AND due_at IS NOT NULL AND due_at < $1)::int AS overdue_now,
                count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= $2 AND resolved_at < $1)::int AS res7,
                count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= $3 AND resolved_at < $1)::int AS res30
           FROM business_open_loops`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [snap("v2.open_loops_open_now", n(r["open_now"])), snap("v2.open_loops_overdue_now", n(r["overdue_now"])), win("v2.open_loops_resolved", n(r["res7"]), n(r["res30"]))];
    }
  },
  {
    ids: ["v2.reminders_sent", "v2.reminder_messages_sent"],
    async run(ctx) {
      // `payload.count` er antall løkker i meldingen (skrevet av push-løkken); alt annet i payload leses aldri.
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE at >= $2)::int AS msgs7, count(*)::int AS msgs30,
                coalesce(sum(CASE WHEN payload->>'count' ~ '^[0-9]{1,6}$' THEN (payload->>'count')::int ELSE 0 END) FILTER (WHERE at >= $2), 0)::int AS items7,
                coalesce(sum(CASE WHEN payload->>'count' ~ '^[0-9]{1,6}$' THEN (payload->>'count')::int ELSE 0 END), 0)::int AS items30
           FROM audit_events WHERE type = 'followup.push_sent' AND at >= $3 AND at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("v2.reminders_sent", n(r["items7"]), n(r["items30"])), win("v2.reminder_messages_sent", n(r["msgs7"]), n(r["msgs30"]))];
    }
  },

  // ---- Jobber -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["tasks.created", "tasks.completed", "tasks.failed", "tasks.open_now", "ops.tasks_waiting_over_15m_now"],
    async run(ctx) {
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)::int AS created7,
                count(*) FILTER (WHERE created_at >= $3 AND created_at < $1)::int AS created30,
                count(*) FILTER (WHERE status = 'completed' AND finished_at >= $2 AND finished_at < $1)::int AS done7,
                count(*) FILTER (WHERE status = 'completed' AND finished_at >= $3 AND finished_at < $1)::int AS done30,
                count(*) FILTER (WHERE status = 'failed' AND finished_at >= $2 AND finished_at < $1)::int AS failed7,
                count(*) FILTER (WHERE status = 'failed' AND finished_at >= $3 AND finished_at < $1)::int AS failed30,
                count(*) FILTER (WHERE status IN ('created', 'running', 'paused'))::int AS open_now,
                count(*) FILTER (WHERE status = 'created' AND created_at < $1::timestamptz - interval '15 minutes' AND (not_before IS NULL OR not_before <= $1))::int AS waiting
           FROM tasks WHERE created_at >= $3 OR finished_at >= $3 OR status IN ('created', 'running', 'paused')`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [
        win("tasks.created", n(r["created7"]), n(r["created30"])), win("tasks.completed", n(r["done7"]), n(r["done30"])), win("tasks.failed", n(r["failed7"]), n(r["failed30"])),
        snap("tasks.open_now", n(r["open_now"])), snap("ops.tasks_waiting_over_15m_now", n(r["waiting"]))
      ];
    }
  },
  {
    ids: ["tasks.cost_ore"],
    async run(ctx) {
      const r = await q(ctx,
        `SELECT coalesce(sum(amount_ore) FILTER (WHERE at >= $2), 0)::float8 AS d7, coalesce(sum(amount_ore), 0)::float8 AS d30
           FROM cost_events WHERE task_id IS NOT NULL AND at >= $3 AND at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("tasks.cost_ore", n(r["d7"]), n(r["d30"]))];
    }
  },

  // ---- Samtaler ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["chat.user_messages", "chat.sessions", "chat.active_days"],
    async run(ctx) {
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE created_at >= $2)::int AS msgs7, count(*)::int AS msgs30,
                count(DISTINCT session_id) FILTER (WHERE created_at >= $2)::int AS sess7, count(DISTINCT session_id)::int AS sess30,
                count(DISTINCT (timezone('${TIME_ZONE}', created_at))::date) FILTER (WHERE created_at >= $2)::int AS days7,
                count(DISTINCT (timezone('${TIME_ZONE}', created_at))::date)::int AS days30
           FROM messages WHERE role = 'user' AND created_at >= $3 AND created_at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("chat.user_messages", n(r["msgs7"]), n(r["msgs30"])), win("chat.sessions", n(r["sess7"]), n(r["sess30"])), win("chat.active_days", n(r["days7"]), n(r["days30"]))];
    }
  },
  {
    ids: ["chat.model_calls", "chat.tool_requesting_calls"],
    async run(ctx) {
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE success AND at >= $2)::int AS calls7, count(*) FILTER (WHERE success)::int AS calls30,
                count(*) FILTER (WHERE success AND tool_calls > 0 AND at >= $2)::int AS tool7, count(*) FILTER (WHERE success AND tool_calls > 0)::int AS tool30
           FROM cost_events WHERE purpose = 'CHAT' AND at >= $3 AND at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("chat.model_calls", n(r["calls7"]), n(r["calls30"])), win("chat.tool_requesting_calls", n(r["tool7"]), n(r["tool30"]))];
    }
  },

  // ---- Godkjenninger og bekreftelser -----------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["approvals.confirmations_requested", "approvals.confirmations_approved", "approvals.confirmations_rejected", "approvals.confirmations_expired", "approvals.avg_response_seconds"],
    async run(ctx) {
      // Avgjort = `decided_at` satt. Godkjent = avgjort og ikke avvist (også en som utløp ubrukt etter godkjenning). Utløpt = aldri avgjort og enten markert utløpt eller pending etter utløpstiden.
      const r = await q(ctx,
        `SELECT count(*) FILTER (WHERE created_at >= $2)::int AS req7, count(*)::int AS req30,
                count(*) FILTER (WHERE decided_at IS NOT NULL AND status <> 'rejected' AND decided_at >= $2)::int AS app7,
                count(*) FILTER (WHERE decided_at IS NOT NULL AND status <> 'rejected')::int AS app30,
                count(*) FILTER (WHERE decided_at IS NOT NULL AND status = 'rejected' AND decided_at >= $2)::int AS rej7,
                count(*) FILTER (WHERE decided_at IS NOT NULL AND status = 'rejected')::int AS rej30,
                count(*) FILTER (WHERE decided_at IS NULL AND created_at >= $2 AND (status = 'expired' OR (status = 'pending' AND expires_at < $1)))::int AS exp7,
                count(*) FILTER (WHERE decided_at IS NULL AND (status = 'expired' OR (status = 'pending' AND expires_at < $1)))::int AS exp30,
                (avg(extract(epoch FROM (decided_at - created_at))) FILTER (WHERE decided_at IS NOT NULL AND decided_at >= $2))::float8 AS resp7,
                (avg(extract(epoch FROM (decided_at - created_at))) FILTER (WHERE decided_at IS NOT NULL))::float8 AS resp30
           FROM action_confirmations WHERE created_at >= $3 AND created_at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [
        win("approvals.confirmations_requested", n(r["req7"]), n(r["req30"])), win("approvals.confirmations_approved", n(r["app7"]), n(r["app30"])),
        win("approvals.confirmations_rejected", n(r["rej7"]), n(r["rej30"])), win("approvals.confirmations_expired", n(r["exp7"]), n(r["exp30"])),
        win("approvals.avg_response_seconds", nn(r["resp7"]), nn(r["resp30"]))
      ];
    }
  },
  {
    ids: ["approvals.signed_used"],
    async run(ctx) {
      const r = await q(ctx, `SELECT count(*) FILTER (WHERE consumed_at >= $2)::int AS d7, count(*)::int AS d30 FROM approvals WHERE consumed_at >= $3 AND consumed_at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("approvals.signed_used", n(r["d7"]), n(r["d30"]))];
    }
  },

  // ---- Kost og drift ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    ids: ["cost.model_total_ore"],
    async run(ctx) {
      const r = await q(ctx, `SELECT coalesce(sum(amount_ore) FILTER (WHERE at >= $2), 0)::float8 AS d7, coalesce(sum(amount_ore), 0)::float8 AS d30 FROM cost_events WHERE at >= $3 AND at < $1`, [ctx.asOf, ctx.d7, ctx.d30]);
      return [win("cost.model_total_ore", n(r["d7"]), n(r["d30"]))];
    }
  },
  {
    ids: ["ops.incidents_open_now"],
    async run(ctx) {
      const r = await qSpaces(ctx, `SELECT count(*)::int AS n FROM incidents WHERE status IN ('open', 'diagnosing', 'repair_proposed', 'repair_in_progress')`, []);
      return [snap("ops.incidents_open_now", n(r["n"]))];
    }
  }
];

/** Feilkoden (SQLSTATE, 5 tegn) hvis den finnes - aldri feilmeldingen, som kan sitere SQL eller data. */
function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "ukjent";
}

async function runProbe(probe: Probe, ctx: Ctx): Promise<ValueMeasurement[]> {
  try {
    const out = await probe.run(ctx);
    // Forsvar: en probe skal levere nøyaktig sine id-er. Mangler en, er den ikke målbar (aldri en stille utelatelse).
    return probe.ids.map((id): ValueMeasurement => out.find((m) => m.id === id) ?? { id, state: "not_measurable", reason_no: "spørringen leverte ikke denne målingen" });
  } catch (err) {
    return probe.ids.map((id): ValueMeasurement => ({ id, state: "not_measurable", reason_no: `kilden er utilgjengelig (feilkode ${errorClass(err)})` }));
  }
}

async function windowsAt(pool: Pool, asOf: Date): Promise<{ d7: Date; d30: Date; today: string; d7Date: string; d30Date: string }> {
  const { rows } = await pool.query(
    `SELECT ((date_trunc('day', timezone('${TIME_ZONE}', $1::timestamptz)) - interval '6 days') AT TIME ZONE '${TIME_ZONE}') AS d7,
            ((date_trunc('day', timezone('${TIME_ZONE}', $1::timestamptz)) - interval '29 days') AT TIME ZONE '${TIME_ZONE}') AS d30,
            to_char(timezone('${TIME_ZONE}', $1::timestamptz)::date, 'YYYY-MM-DD') AS today,
            to_char(timezone('${TIME_ZONE}', $1::timestamptz)::date - 6, 'YYYY-MM-DD') AS d7_date,
            to_char(timezone('${TIME_ZONE}', $1::timestamptz)::date - 29, 'YYYY-MM-DD') AS d30_date`, [asOf]);
  const r = rows[0] as { d7: Date; d30: Date; today: string; d7_date: string; d30_date: string };
  return { d7: r.d7, d30: r.d30, today: r.today, d7Date: r.d7_date, d30Date: r.d30_date };
}

export interface ValueSourceOptions {
  now?: () => Date;
  /** Hvor lenge et svar gjenbrukes per tenant (ms). Standard 30 s, som SLO-kilden. */
  ttlMs?: number;
  /** Eierens tenant: den daglige løperens helse (`scheduler_state`, global tabell) vises kun for denne. null/udefinert = vises ikke. */
  schedulerTenantId?: string | null;
  dailyBriefJob?: string;
}

/** Alle id-er kilden eier (for dekningstest mot katalogen). */
export const VALUE_SOURCE_IDS: readonly string[] = VALUE_PROBES.flatMap((p) => p.ids);

/**
 * Value Center-kilden. Måler alle probene sekvensielt (små spørringer; ikke tøm den delte poolen) og cacher svaret per tenant i kort tid, så selvdiagnose + verktøy + hurtigbane + dashbord ikke gir N dyre aggregeringer.
 * Kaster kun når selve vinduene ikke kan regnes ut (databasen er helt nede) - da gir tjenesten «kilden er utilgjengelig» for hele rapporten.
 */
export function createValueMeasurementSource(pool: Pool, options: ValueSourceOptions = {}): ValueMeasurementSource {
  const now = options.now ?? (() => new Date());
  const ttl = options.ttlMs ?? 30_000;
  const cache = new Map<string, { at: number; set: Promise<ValueMeasurementSet> }>();

  async function measureUncached(tenantId: string): Promise<ValueMeasurementSet> {
    const asOf = now();
    const w = await windowsAt(pool, asOf);
    const ctx: Ctx = {
      pool, tenantId, asOf, ...w, schedulerTenantId: options.schedulerTenantId ?? null, dailyBriefJob: options.dailyBriefJob ?? DAILY_BRIEF_JOB_NAME
    };
    const measurements: ValueMeasurement[] = [];
    for (const probe of VALUE_PROBES) measurements.push(...(await runProbe(probe, ctx)));
    const windows: ValueWindows = {
      d7: { from: w.d7.toISOString(), to: asOf.toISOString() },
      d30: { from: w.d30.toISOString(), to: asOf.toISOString() }
    };
    return { windows, measurements };
  }

  return {
    measure(tenantId: string): Promise<ValueMeasurementSet> {
      const t = now().getTime();
      const hit = cache.get(tenantId);
      if (hit && t - hit.at < ttl) return hit.set;
      const set = measureUncached(tenantId);
      cache.set(tenantId, { at: t, set });
      if (cache.size > CACHE_MAX_TENANTS) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
      }
      set.catch(() => { if (cache.get(tenantId)?.set === set) cache.delete(tenantId); });
      return set;
    }
  };
}
