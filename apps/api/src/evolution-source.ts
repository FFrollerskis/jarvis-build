// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import { withTenantTransaction } from "@jarvis/core";
import { composeEvolutionReport, unknownSection, type EvolutionReport, type EvolutionSection, type SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import {
  MAINTENANCE_CATALOG, assessCredential, auditFallbackChains, changeFreeze, creditRunway, detectCostAnomalies, dueMaintenance, forecastBreach,
  type CostPoint, type CredentialState, type MaintenanceTask
} from "@jarvis/self-modification";
import type { ConnectorStatus } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "./ev0-boot.ts";

/**
 * WP-B (D-452): evolusjonsportene (EV-0…EV-23) i OBSERVASJONSMODUS. Denne filen leser kun eksisterende observerbarhet (endringsregisteret, cost_events, scheduler_state, connector-status, SLO-rapporten,
 * modellmeshen) og kjører de RENE beslutningsreglene i `@jarvis/self-modification/evolution` mot tallene. Ingenting skrives, ingenting utføres: rapporten har `acts: false`, og en seksjon som ikke kan måles blir
 * UNKNOWN (aldri «OK» ved feil). Kun antall og kategorier - aldri innhold fra minne/e-post, aldri hemmelige verdier.
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;
type Env = Readonly<Record<string, string | undefined>>;

export interface EvolutionSourceDeps {
  pool: Pool;
  tenantId: string;
  now?: () => Date;
  env?: Env;
  /** EV-0-oppstartsresultatet (konstitusjon + endringsregister); null før første sjekk. */
  ev0Status: () => Ev0BootStatus | null;
  slo: () => Promise<SloReport>;
  connectors: () => Promise<ConnectorStatus[]>;
  killSwitchActive: () => Promise<boolean>;
  mesh: () => MeshStatus;
  /** Ekstra seksjoner (B2 og senere): hver leverer sin egen fail-soft seksjon. */
  extraSections?: ReadonlyArray<(ctx: EvolutionContext) => Promise<EvolutionSection>>;
}

/** Felles kontekst for alle seksjoner. */
export interface EvolutionContext {
  pool: Pool;
  tenantId: string;
  now: Date;
  env: Env;
  deps: EvolutionSourceDeps;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const ore = (n: number): string => `${Math.round(n / 100)} kr`;

/** Én seksjon kan aldri velte hele rapporten: en feil blir UNKNOWN med årsaken (kun klasse, aldri innhold). */
async function safely(ev: string, title: string, source: string, fn: () => Promise<EvolutionSection>): Promise<EvolutionSection> {
  try {
    return await fn();
  } catch (err) {
    return unknownSection(ev, title, source, `målingen feilet (${(err as Error).message.slice(0, 100)})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-0 / EV-8: endringsgrenser og change freeze
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const INCIDENT_SPACES = ["personal", "business", "project", "home", "shared"] as const;

async function openIncidentCount(ctx: EvolutionContext): Promise<number | null> {
  try {
    return await withMemoryTransaction(ctx.pool as pg.Pool, ctx.tenantId, INCIDENT_SPACES, async (client) =>
      Number((await client.query(`SELECT count(*)::int AS n FROM incidents WHERE status IN ('open', 'diagnosing', 'repair_proposed', 'repair_in_progress')`)).rows[0]?.n ?? 0)
    );
  } catch {
    return null;
  }
}

export async function boundariesSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const { deps } = ctx;
  const ev0 = deps.ev0Status();
  const [sloResult, killResult, incidents] = await Promise.all([deps.slo().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })), deps.killSwitchActive().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })), openIncidentCount(ctx)]);
  const breaches = sloResult.ok ? sloResult.v.slos.filter((s) => s.status === "BREACH").length : 0;
  const freeze = changeFreeze({
    incident_open: (incidents ?? 0) > 0,
    observability_ok: sloResult.ok,
    slo_breaches: breaches,
    kill_switch_active: killResult.ok ? killResult.v : false
  });
  const findings: string[] = [];
  let attention = false;
  if (!ev0) findings.push("Oppstartssjekken av konstitusjon og endringsregister har ikke kjørt (ukjent).");
  else {
    if (ev0.constitution.status === "verified") findings.push(`Safety Constitution er verifisert (versjon ${ev0.constitution.version}).`);
    else { findings.push(`Safety Constitution er ikke verifisert (${ev0.constitution.code}) - Evolution kan ikke aktiveres før eieren har signert den (EV-0).`); attention = true; }
    if (ev0.ledger.status === "ok") findings.push(`Endringsregisteret: hash-kjeden er intakt (${ev0.ledger.count} rader).`);
    else if (ev0.ledger.status === "broken") { findings.push(`Endringsregisteret: hash-kjeden er ØDELAGT${ev0.ledger.broken_seq ? ` fra rad ${ev0.ledger.broken_seq}` : ""}.`); attention = true; }
    else { findings.push("Endringsregisteret er utilgjengelig akkurat nå."); attention = true; }
  }
  findings.push(freeze.frozen ? `Change freeze er PÅ: ${freeze.reasons.join(", ")}.` : "Change freeze er av (ingen hendelse, kill switch eller brutte tjenestemål).");
  if (incidents === null) findings.push("Åpne hendelser kunne ikke telles (ikke med i frysevurderingen).");
  if (freeze.frozen) attention = true;
  findings.push("Selvendring er frosset (D-397): ingen kodevei lar Evolution endre produksjon.");
  return {
    ev: "EV-0/EV-8", title_no: "Endringsgrenser og frys", mode: "observe", status: attention ? "ATTENTION" : "OK",
    summary_no: attention ? "Noe står i veien for (eller bør sees på før) at Evolution kan aktiveres." : "Grensene er på plass; ingenting står i veien.",
    findings, source: "konstitusjon + endringsregister (oppstartssjekk), SLO-rapport, kill switch, hendelser", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-5: endringsforslag (kun lesing av endringsregisteret)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function proposalsSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const [byDecision, pending] = await Promise.all([
    ctx.pool.query<{ decision: string; n: number }>(`SELECT decision, count(*)::int AS n FROM evolution_change_ledger WHERE at >= $1::timestamptz GROUP BY decision ORDER BY decision`, [new Date(ctx.now.getTime() - 30 * 86_400_000).toISOString()]),
    ctx.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (change_id) change_id, decision FROM evolution_change_ledger ORDER BY change_id, seq DESC) t WHERE decision = 'proposed'`)
  ]);
  const counts = new Map(byDecision.rows.map((r) => [r.decision, Number(r.n)]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const waiting = Number(pending.rows[0]?.n ?? 0);
  const findings = [
    total === 0 ? "Ingen forslag registrert siste 30 dager." : `Registrert siste 30 dager: ${[...counts].map(([d, n]) => `${n} ${d}`).join(", ")}.`,
    waiting > 0 ? `${waiting} forslag venter på eierens avgjørelse.` : "Ingen forslag venter på eier.",
    "Forslag valideres av kode (klasse E0–E3 utledes, E3 avvises alltid) og havner kun i endringsregisteret - ingenting utføres av forslaget."
  ];
  return {
    ev: "EV-5", title_no: "Endringsforslag", mode: "observe", status: waiting > 0 ? "ATTENTION" : "OK",
    summary_no: waiting > 0 ? `${waiting} forslag venter på deg.` : total === 0 ? "Ingen forslag er registrert." : `${total} forslag registrert siste 30 dager, ingen venter.`,
    findings, source: "evolution_change_ledger", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-16: kostnad og kapasitet (prognose/anomali; ingen utgift utløses)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function envNumber(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  return /^\d{1,12}$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
}

export async function costSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const now = ctx.now;
  const today = dayOf(now);
  const monthStart = `${today.slice(0, 7)}-01T00:00:00.000Z`;
  const { daily, monthToDate } = await withTenantTransaction(ctx.pool as pg.Pool, ctx.tenantId, async (client) => {
    const dailyRows = (await client.query(
      `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, provider, coalesce(sum(amount_ore), 0)::int AS ore
         FROM cost_events WHERE at >= $1::timestamptz GROUP BY 1, 2`,
      [new Date(now.getTime() - 15 * 86_400_000).toISOString()]
    )).rows as Array<{ day: string; provider: string; ore: number }>;
    const mtd = Number((await client.query(`SELECT coalesce(sum(amount_ore), 0)::bigint AS n FROM cost_events WHERE at >= $1::timestamptz`, [monthStart])).rows[0]?.n ?? 0);
    return { daily: dailyRows, monthToDate: mtd };
  });
  const points: CostPoint[] = daily.map((r) => ({ key: r.provider, day: r.day, ore: Number(r.ore) }));
  const anomalies = detectCostAnomalies(points, today);
  const hardLimit = envNumber(ctx.env, "JARVIS_COST_HARD_LIMIT_ORE", 300_000);
  const warnLimit = envNumber(ctx.env, "JARVIS_COST_WARN_ORE", 100_000);
  const dayOfMonth = Number(today.slice(8, 10));
  const burn = dayOfMonth > 0 ? monthToDate / dayOfMonth : 0;
  const runway = creditRunway({ balance_ore: Math.max(0, hardLimit - monthToDate), burn_ore_per_day: burn, warn_days: 7 });
  // Prognose mot månedens hardgrense fra kumulative dagssummer (kun når det finnes nok dager i måneden).
  const perDay = new Map<string, number>();
  for (const p of points) if (p.day >= monthStart.slice(0, 10)) perDay.set(p.day, (perDay.get(p.day) ?? 0) + p.ore);
  let cumulative = 0;
  const samples = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ at: `${day}T12:00:00.000Z`, value: (cumulative += v) }));
  const forecast = forecastBreach(samples, hardLimit, 45, 5);
  const findings: string[] = [
    `Hittil i måneden: ${ore(monthToDate)} (varselgrense ${ore(warnLimit)}, hardgrense ${ore(hardLimit)}).`,
    runway.days_left === null ? "Ingen kostnad hittil i måneden, så ingen utregnet rekkevidde." : `Rekkevidde til hardgrensen med dagens tempo: ${runway.days_left} dager.`
  ];
  if (forecast.confidence === "ok" && forecast.days_to_breach !== null) findings.push(`Prognose: hardgrensen nås om ca. ${forecast.days_to_breach} dager med dagens vekst.`);
  else if (forecast.confidence === "low") findings.push("For lite data i måneden til en trendprognose.");
  for (const a of anomalies.slice(0, 5)) findings.push(`Uvanlig kostnad i dag hos ${a.key}: ${ore(a.today_ore)} mot snitt ${ore(a.baseline_mean_ore)} (z=${a.z}).`);
  findings.push("Prognosene foreslår kun; ingen utgift, opprydding eller påfyll utløses herfra (alt kapasitetsforslag er eier- og finansport).");
  const attention = anomalies.length > 0 || runway.warn || monthToDate >= warnLimit || (forecast.days_to_breach !== null && forecast.days_to_breach <= 14);
  return {
    ev: "EV-16", title_no: "Kostnad og kapasitet", mode: "observe", status: attention ? "ATTENTION" : "OK",
    summary_no: attention
      ? `${anomalies.length > 0 ? `${anomalies.length} kostnadsavvik i dag. ` : ""}${runway.warn ? "Rekkevidden til hardgrensen er kort. " : ""}${monthToDate >= warnLimit ? "Varselgrensen er passert. " : ""}`.trim()
      : "Kostnaden er innenfor grensene og uten avvik.",
    findings, source: "cost_events", observed_at: now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-17: nøkler og tilkoblinger (vurdering; ingen fornyelse utføres her)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const OAUTH_CONNECTOR = /^(google|gmail|calendar|drive|sheets|docs|youtube|microsoft|outlook|onedrive|teams|dropbox|spotify)/i;

export async function credentialsSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const connectors = await ctx.deps.connectors();
  const configured = connectors.filter((c) => c.configured);
  const states: CredentialState[] = configured.map((c) => ({
    ref: c.id,
    kind: OAUTH_CONNECTOR.test(c.id) ? "oauth" : "api_key",
    expires_at: null,
    // «healthy» (samme tolkning som selvdiagnosen) regnes som vellykket bruk; ingen måling sier ingenting (null), alt annet er mislykket.
    last_refresh_ok: c.health === null ? null : c.health.state === "healthy",
    scopes_granted: [],
    scopes_required: [],
    revoked: false
  }));
  const assessed = states.map((s) => assessCredential(s, ctx.now));
  const failing = assessed.filter((a) => a.health !== "ok");
  const notConfigured = connectors.length - configured.length;
  const noHealth = configured.filter((c) => c.health === null).length;
  const findings: string[] = [
    `${configured.length} av ${connectors.length} kjente tilkoblinger er konfigurert; ${notConfigured} er ikke konfigurert (ikke en feil - bare ikke koblet til).`,
    failing.length === 0 ? "Ingen konfigurert tilkobling har feilende fornyelse eller helse." : `Trenger oppmerksomhet: ${failing.map((a) => `${a.ref} (${a.health}${a.needs !== "none" ? `, ${a.needs}` : ""})`).join("; ")}.`,
    noHealth > 0 ? `${noHealth} konfigurerte tilkoblinger har ingen helsemåling ennå (ukjent, ikke «frisk»).` : "Alle konfigurerte tilkoblinger har en helsemåling.",
    "Utløpsdato er ikke målt (leverandørene oppgir den ikke i registeret) - vurderingen dekker helse og fornyelsesfeil, ikke utløp. Fornyelse utføres av tilkoblingene selv; nye nøkler, OAuth-samtykke og kontoer er alltid eier/ekstern port."
  ];
  return {
    ev: "EV-17", title_no: "Nøkler og tilkoblinger", mode: "observe", status: failing.length > 0 ? "ATTENTION" : "OK",
    summary_no: failing.length > 0 ? `${failing.length} tilkobling(er) trenger oppmerksomhet.` : `${configured.length} konfigurerte tilkoblinger uten kjente feil.`,
    findings, source: "connector-registeret (presence + siste helse; aldri verdier)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-19: vedlikeholdsplan (hva er forfalt; ingenting kjøres herfra)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** Hvem utfører (eller dekker) en vedlikeholdsoppgave i dag. Alt som ikke står her har ingen utfører ennå (DEFERRED) og telles som «ikke koblet». */
export const MAINTENANCE_COVERAGE: Readonly<Record<string, { by: "scheduler"; job: string } | { by: "report"; ev: string }>> = {
  health_check: { by: "scheduler", job: "connector-health-sweep" },
  expired_credentials: { by: "scheduler", job: "connector-health-sweep" },
  failed_jobs_review: { by: "scheduler", job: "daily-brief" },
  cost_optimization: { by: "report", ev: "EV-16" },
  cost_spike_review: { by: "report", ev: "EV-16" },
  model_candidates: { by: "report", ev: "EV-12" }
};

const MONTHLY_CAPS = { radar: 4, eval: 4, red_team: 1, shadow: 1 } as const;

export async function maintenanceSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const rows = await ctx.pool.query<{ job_name: string; last: string | null }>(`SELECT job_name, max(completed_at)::text AS last FROM scheduler_state WHERE completed_at IS NOT NULL GROUP BY job_name`);
  const lastByJob = new Map(rows.rows.map((r) => [r.job_name, r.last]));
  const covered: MaintenanceTask[] = MAINTENANCE_CATALOG.filter((t) => t.id in MAINTENANCE_COVERAGE);
  const last_run: Record<string, string | undefined> = {};
  for (const t of covered) {
    const c = MAINTENANCE_COVERAGE[t.id]!;
    if (c.by === "report") last_run[t.id] = ctx.now.toISOString();
    else { const last = lastByJob.get(c.job); if (last) last_run[t.id] = new Date(last).toISOString(); }
  }
  const sloResult = await ctx.deps.slo().then((v) => v, () => null);
  const freeze = changeFreeze({ incident_open: false, observability_ok: sloResult !== null, slo_breaches: sloResult ? sloResult.slos.filter((s) => s.status === "BREACH").length : 0, kill_switch_active: await ctx.deps.killSwitchActive().catch(() => false) });
  const plan = dueMaintenance({ now: ctx.now, last_run, change_freeze: freeze.frozen, cap_usage: {}, caps: MONTHLY_CAPS }, covered);
  const uncovered = MAINTENANCE_CATALOG.filter((t) => !(t.id in MAINTENANCE_COVERAGE));
  const findings = [
    plan.run.length === 0 ? "Ingen koblede vedlikeholdsoppgaver er forfalt." : `Forfalt nå: ${plan.run.join(", ")}.`,
    ...(plan.blocked.length > 0 ? [`Stoppet: ${plan.blocked.map((b) => `${b.id} (${b.reason})`).join(", ")}.`] : []),
    `${covered.length} av ${MAINTENANCE_CATALOG.length} vedlikeholdsoppgaver har en utfører i dag (planlagt jobb eller denne rapporten); ${uncovered.length} er ikke koblet ennå: ${uncovered.map((t) => t.id).join(", ")}.`,
    "Planen er en oversikt; ingen oppgave kjøres herfra, og muterende vedlikehold stoppes av change freeze."
  ];
  return {
    ev: "EV-19", title_no: "Vedlikeholdsplan", mode: "observe", status: plan.run.length > 0 ? "ATTENTION" : "OK",
    summary_no: plan.run.length > 0 ? `${plan.run.length} koblet(e) vedlikeholdsoppgave(r) er forfalt.` : `Ingenting forfalt blant de ${covered.length} koblede oppgavene; ${uncovered.length} har ingen utfører ennå.`,
    findings, source: "scheduler_state + vedlikeholdskatalogen (EV-19)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-12: modellrute i skygge (kjede-revisjon av faktisk konfigurasjon; ingenting rutes om)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const CRITICAL_WORKFLOWS = ["CHAT", "BACKGROUND"] as const;

export async function modelRouteSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const mesh = ctx.deps.mesh();
  const usable = mesh.providers.filter((p) => p.provider !== "scripted" && p.state !== "NOT_CONFIGURED" && p.state !== "UNAVAILABLE");
  const down = mesh.providers.filter((p) => p.provider !== "scripted" && p.state === "UNAVAILABLE").map((p) => p.provider);
  // Kjeden per kritisk arbeidsflyt = de brukbare leverandørene (lokal først, slik ruteren gjør). Uttestet inntil mesh-fallbacken er sett i drift.
  const chain = usable.map((p) => ({ provider: p.provider }));
  const tested = mesh.fallback === "VERIFIED";
  const audit = auditFallbackChains(
    CRITICAL_WORKFLOWS.map((workflow) => ({ workflow, chain, last_tested_at: tested ? ctx.now.toISOString() : null })),
    { critical_workflows: CRITICAL_WORKFLOWS },
    ctx.now
  );
  const findings = [
    `Brukbare leverandører: ${usable.map((p) => p.provider).join(", ") || "ingen"}${down.length > 0 ? ` (nede: ${down.join(", ")})` : ""}.`,
    `Mesh-ruteren: ${mesh.router}; fallback mellom leverandører: ${mesh.fallback}${tested ? "" : " (ikke sett i drift ennå)"}.`,
    ...audit.map((a) => `${a.workflow}: ${a.issue === "single_provider" ? "bare én leverandør i kjeden (konsentrasjonsrisiko)" : a.issue === "never_tested" ? "fallback-kjeden er aldri testet" : "fallback-testen er gammel"}.`),
    "Skygge: Evolution velger ikke modell og ruter ingenting om. Aktivering krever en eier-godkjent allowlist, bake-off og evals (EV-12) - se modellrådgiveren (D-399)."
  ];
  return {
    ev: "EV-12", title_no: "Modellrute i skygge", mode: "observe", status: audit.length > 0 ? "ATTENTION" : "OK",
    summary_no: audit.length > 0 ? `${audit.length} funn i fallback-kjedene til de kritiske arbeidsflytene.` : "Kritiske arbeidsflyter har ≥2 leverandører og en testet fallback.",
    findings, source: "modellmeshen (meshStatus) + fallback-revisjon (EV-12)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Rapporten
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const BASE_SECTIONS: ReadonlyArray<{ ev: string; title: string; source: string; build: (ctx: EvolutionContext) => Promise<EvolutionSection> }> = [
  { ev: "EV-0/EV-8", title: "Endringsgrenser og frys", source: "konstitusjon + endringsregister", build: boundariesSection },
  { ev: "EV-5", title: "Endringsforslag", source: "evolution_change_ledger", build: proposalsSection },
  { ev: "EV-12", title: "Modellrute i skygge", source: "modellmeshen", build: modelRouteSection },
  { ev: "EV-16", title: "Kostnad og kapasitet", source: "cost_events", build: costSection },
  { ev: "EV-17", title: "Nøkler og tilkoblinger", source: "connector-registeret", build: credentialsSection },
  { ev: "EV-19", title: "Vedlikeholdsplan", source: "scheduler_state", build: maintenanceSection }
];

/** Bygger rapporten NÅ (hver seksjon fail-soft). */
export async function buildEvolutionReport(deps: EvolutionSourceDeps): Promise<EvolutionReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ctx: EvolutionContext = { pool: deps.pool, tenantId: deps.tenantId, now, env: deps.env ?? process.env, deps };
  const base = await Promise.all(BASE_SECTIONS.map((s) => safely(s.ev, s.title, s.source, () => s.build(ctx))));
  const extra = await Promise.all((deps.extraSections ?? []).map((build, i) => safely(`EV-extra-${i + 1}`, "Seksjon", "ukjent", () => build(ctx))));
  return composeEvolutionReport({ as_of: now.toISOString(), sections: [...base, ...extra] });
}

/** Rapport-leverandør med kort cache (selvdiagnose + verktøy + hurtigbane skal ikke gi N dyre aggregeringer). */
export function createEvolutionReportProvider(deps: EvolutionSourceDeps, options: { ttlMs?: number } = {}): () => Promise<EvolutionReport> {
  const ttl = options.ttlMs ?? 30_000;
  const clock = deps.now ?? (() => new Date());
  let cached: { at: number; report: Promise<EvolutionReport> } | undefined;
  return () => {
    const t = clock().getTime();
    if (cached && t - cached.at < ttl) return cached.report;
    const report = buildEvolutionReport(deps);
    cached = { at: t, report };
    report.catch(() => { if (cached?.report === report) cached = undefined; });
    return report;
  };
}
