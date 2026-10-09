// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withMemoryTransaction, type ResensitizeSweepSummary } from "@jarvis/memory";
import { withTenantTransaction } from "@jarvis/core";
import { composeEvolutionReport, unknownSection, type EvolutionReport, type EvolutionSection, type SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import {
  MAINTENANCE_CATALOG, assessCredential, auditFallbackChains, changeFreeze, creditRunway, decideHeal, detectCostAnomalies, detectPoisoning, dueMaintenance, evaluateAllReadiness, forecastBreach, needsReverification, parseDeclaredGates,
  proposeDedupe, RED_TEAM_CATEGORIES,
  type CostPoint, type CredentialState, type FreezeVerdict, type MaintenanceTask, type MemoryFact, type MemorySourceKind, type ReadinessFacts
} from "@jarvis/self-modification";
import { readSchedulerHealth, type ConnectorStatus, type MeshToolMapping } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "./ev0-boot.ts";
import type { RadarState } from "./evolution-radar.ts";
import { GOLDEN_SUITE_DIGEST, runGolden, type GoldenRun } from "./golden-suite.ts";

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
  /** Chat-flatens verktøy (for verktøyutvalgs-oppgavene i gull-suiten). Udefinert/null = de oppgavene hoppes over (og sies å være hoppet over). */
  toolSurface?: () => ReadonlyArray<MeshToolMapping> | null;
  /** EV-3: siste radarsveip (kilder eieren selv har valgt; udefinert/0 kilder = inert). Rapporten leser kun resultatet - selve sveipet kjører planlagt, aldri fra rapporten. */
  radar?: RadarState;
  /** EV-10: siste nattlige omregning av lagret sensitivitet (D-451 `memory-resensitize-sweep`); null/udefinert = ikke kjørt siden oppstart. Kun tellinger - aldri innhold. */
  resensitize?: () => ResensitizeSweepSummary | null;
  /** Ekstra seksjoner (senere deler): hver leverer sin egen fail-soft seksjon. */
  extraSections?: ReadonlyArray<(ctx: EvolutionContext) => Promise<EvolutionSection>>;
}

/** Felles kontekst for alle seksjoner. `shared` memoiserer det flere seksjoner trenger (én beregning per rapport). */
export interface EvolutionContext {
  pool: Pool;
  tenantId: string;
  now: Date;
  env: Env;
  deps: EvolutionSourceDeps;
  shared?: { freeze?: Promise<{ verdict: FreezeVerdict; incidents: number | null }>; golden?: Promise<GoldenRun> };
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

/** Change freeze-vurderingen (delt av flere seksjoner; beregnes én gang per rapport). */
export function computeFreeze(ctx: EvolutionContext): Promise<{ verdict: FreezeVerdict; incidents: number | null }> {
  ctx.shared ??= {};
  ctx.shared.freeze ??= (async () => {
    const { deps } = ctx;
    const [sloResult, killResult, incidents] = await Promise.all([
      deps.slo().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
      deps.killSwitchActive().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
      openIncidentCount(ctx)
    ]);
    const breaches = sloResult.ok ? sloResult.v.slos.filter((s) => s.status === "BREACH").length : 0;
    const verdict = changeFreeze({ incident_open: (incidents ?? 0) > 0, observability_ok: sloResult.ok, slo_breaches: breaches, kill_switch_active: killResult.ok ? killResult.v : false });
    return { verdict, incidents };
  })();
  return ctx.shared.freeze;
}

export async function boundariesSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const { deps } = ctx;
  const ev0 = deps.ev0Status();
  const { verdict: freeze, incidents } = await computeFreeze(ctx);
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
    failing.length === 0 ? "Ingen konfigurert tilkobling har feilende fornyelse eller dårlig tilstand." : `Trenger oppmerksomhet: ${failing.map((a) => `${a.ref} (${a.health}${a.needs !== "none" ? `, ${a.needs}` : ""})`).join("; ")}.`,
    noHealth > 0 ? `${noHealth} konfigurerte tilkoblinger har ingen tilstandsmåling ennå (ukjent, ikke «frisk»).` : "Alle konfigurerte tilkoblinger har en tilstandsmåling.",
    "Utløpsdato er ikke målt (leverandørene oppgir den ikke i registeret) - vurderingen dekker tilstand og fornyelsesfeil, ikke utløp. Fornyelse utføres av tilkoblingene selv; nye nøkler, OAuth-samtykke og kontoer er alltid eier/ekstern port."
  ];
  return {
    ev: "EV-17", title_no: "Nøkler og tilkoblinger", mode: "observe", status: failing.length > 0 ? "ATTENTION" : "OK",
    summary_no: failing.length > 0 ? `${failing.length} tilkobling(er) trenger oppmerksomhet.` : `${configured.length} konfigurerte tilkoblinger uten kjente feil.`,
    findings, source: "connector-registeret (presence + siste tilstand; aldri verdier)", observed_at: ctx.now.toISOString()
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
  const { verdict: freeze } = await computeFreeze(ctx);
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
// EV-4 + EV-21: gull-suite og selvtest av forsvaret (deterministisk; ingen modell kalles)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function goldenRun(ctx: EvolutionContext): Promise<GoldenRun> {
  ctx.shared ??= {};
  ctx.shared.golden ??= runGolden({ surface: ctx.deps.toolSurface?.() ?? null });
  return ctx.shared.golden;
}

export async function goldenSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const run = await goldenRun(ctx);
  const passed = run.metrics.tasks - run.failed.length;
  const findings = [
    `Gull-suite v1 (digest ${run.digest.slice(0, 12)}): ${passed} av ${run.metrics.tasks} oppgaver bestått${run.skipped.length > 0 ? `; ${run.skipped.length} hoppet over (verktøyflaten er ikke tilgjengelig her)` : ""}.`,
    ...(run.failed.length > 0 ? [`Ikke bestått: ${run.failed.join(", ")}.`] : []),
    "Oppgavene er faktiske feil og beslutninger fra Jarvis' egen historie (klassifisering, ruting, verktøyutvalg, skjerming, repo-lås), kjørt mot de deterministiske reglene - ingen modell kalles.",
    "Ikke koblet ennå: modellevaluering mot representative oppgaver, regresjonsport mot en lagret baseline og blind A/B (krever modellkjøringer og lagret historikk)."
  ];
  return {
    ev: "EV-4", title_no: "Gull-suite (regresjonsvern)", mode: "observe", status: run.failed.length > 0 ? "ATTENTION" : "OK",
    summary_no: run.failed.length > 0 ? `${run.failed.length} av ${run.metrics.tasks} gull-oppgaver er ikke bestått - en regel Jarvis allerede har fungerer ikke lenger.` : `Alle ${run.metrics.tasks} gull-oppgaver er bestått.`,
    findings, source: `apps/api/src/golden-suite.ts (versjon 1, ${GOLDEN_SUITE_DIGEST().slice(0, 12)})`, observed_at: ctx.now.toISOString()
  };
}

export async function redTeamSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const run = await goldenRun(ctx);
  const attempts = run.red_team.reduce((a, r) => a + r.attempts, 0);
  const breaches = run.red_team.reduce((a, r) => a + r.breaches, 0);
  const breached = run.red_team.filter((r) => r.breaches > 0).map((r) => r.category);
  const findings = [
    `${attempts} angrepsforsøk mot egne forsvar i ${run.red_team.length} av ${RED_TEAM_CATEGORIES.length} kategorier: ${breaches} brudd.`,
    ...(breached.length > 0 ? [`BRUDD i: ${breached.join(", ")} - sikkerhetsregresjon er en hard stopp som aldri kan veies opp av noe annet.`] : []),
    ...(run.uncovered.length > 0 ? [`Ikke dekket: ${run.uncovered.join(", ")} (aldri tolket som bestått).`] : []),
    "Dette er en selvtest av eksisterende, deterministiske forsvar (radar-sonen, skjerming, hemmelighetsskanning, repo-lås, ruteinstruks) - ikke en adversariell red-team-agent (EV-21-agenten er ikke bygget)."
  ];
  const bad = breaches > 0;
  return {
    ev: "EV-21", title_no: "Sikkerhetsselvtest (red team lite)", mode: "observe", status: bad || run.uncovered.length > 0 ? "ATTENTION" : "OK",
    summary_no: bad ? `${breaches} brudd i selvtesten - hard stopp for all evolusjon.` : run.uncovered.length > 0 ? `Ingen brudd, men ${run.uncovered.length} kategori(er) er ikke dekket.` : `Ingen brudd i ${attempts} forsøk.`,
    findings, source: "apps/api/src/golden-suite.ts (adversarielle oppgaver) + judgeRedTeam", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-10: minnevedlikehold (forslag; ingenting slettes eller slås sammen)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** Helse- og gjesterommet er bevisst utelatt (helse kan aldri kombineres med andre rom, MEMORY_ARCHITECTURE §4); kun ANTALL og id-er rapporteres, aldri innhold. */
const MEMORY_SPACES = ["personal", "business", "project", "home", "shared"] as const;
const MEMORY_SAMPLE = 2000;

/** Kildekvalitet utledet av hvordan minnet kom inn (aldri av innholdet). */
export function memorySourceKind(kind: string, trust: string, ref: string): MemorySourceKind {
  if (kind === "manual") return "owner_statement";
  if (kind === "conversation") return trust === "trusted" ? "owner_statement" : "external";
  if (kind === "tool") return ref.startsWith("memory.propose.owner:") ? "owner_statement" : trust === "trusted" ? "tool" : "inference";
  return "document";
}

export async function memorySection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const rows = await withMemoryTransaction(ctx.pool as pg.Pool, ctx.tenantId, MEMORY_SPACES, async (client) =>
    (await client.query(
      `SELECT i.memory_item_id AS id, i.space, i.subject, i.content, i.observed_at, i.valid_to, i.trust_level AS trust, i.has_conflict, s.kind AS source_kind, s.ref AS source_ref
         FROM memory_items i JOIN memory_sources s ON s.source_id = i.source_id AND s.tenant_id = i.tenant_id
        WHERE i.status = 'active' ORDER BY i.observed_at DESC LIMIT ${MEMORY_SAMPLE}`
    )).rows as Array<{ id: string; space: string; subject: string; content: string; observed_at: Date | string; valid_to: Date | string | null; trust: string; has_conflict: boolean; source_kind: string; source_ref: string }>
  );
  const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
  const facts: MemoryFact[] = rows.map((r) => ({
    id: r.id, space: r.space, subject: r.subject, content: r.content, source_kind: memorySourceKind(r.source_kind, r.trust, r.source_ref),
    trust: r.trust === "trusted" || r.trust === "internal" ? r.trust : "untrusted", observed_at: iso(r.observed_at), valid_to: r.valid_to === null ? null : iso(r.valid_to), has_conflict: r.has_conflict
  }));
  const reverify = needsReverification(facts, ctx.now);
  const poisoning = detectPoisoning(facts);
  const dedupe = proposeDedupe(facts);
  const by = (reason: string) => reverify.filter((r) => r.reason === reason).length;
  const findings = [
    `Vurdert: ${facts.length} aktive minner (de ${MEMORY_SAMPLE} nyeste; to private rom er utelatt av personvernhensyn).`,
    `Bør re-verifiseres før bruk: ${reverify.length} (utløpt ${by("expired")}, gamle eksterne ${by("stale_external")}, gamle slutninger ${by("stale_low_quality")}).`,
    poisoning.length === 0 ? "Ingen mistanke om forgiftning (ubetrodd innhold som motsier dine egne utsagn)." : `${poisoning.length} ubetrodde påstander motsier dine egne utsagn om samme emne - se i karantene/dashbordet.`,
    dedupe.length === 0 ? "Ingen identiske duplikater." : `${dedupe.length} duplikatgrupper kan slås sammen (${dedupe.reduce((a, d) => a + d.merge.length, 0)} minner); forslagene er reversible og ingenting er slått sammen.`,
    "Kun forslag: ingenting slettes eller slås sammen herfra (sletting har egen policy og din godkjenning). Antall gjentakelser fra ubetrodd kilde og uavhengige bekreftelser spores ikke ennå, så de to forgiftningsreglene som trenger dem er ikke i bruk."
  ];
  // Sensitivitetsdrift: elementer lagret før ordforrådet ble utvidet (Q-52 A) kan stå lavere enn de nå ville blitt merket. Tallet kommer fra det nattlige sveipet (ikke en ny skanning her).
  const drift = ctx.deps.resensitize?.() ?? null;
  const driftPending = drift !== null && drift.mode === "report" && drift.raised.special + drift.raised.sensitive > 0;
  if (drift === null) findings.splice(2, 0, "Sensitivitetsdrift: den nattlige omregningen (kl. 03) har ikke kjørt siden oppstart, så tallet er ukjent.");
  else if (drift.mode === "off") findings.splice(2, 0, "Sensitivitetsdrift: omregningen er slått av (JARVIS_MEMORY_RESENSITIZE=off).");
  else findings.splice(2, 0, `Sensitivitetsdrift (siste omregning, modus ${drift.mode}): ${drift.scanned} skannet, ${drift.raised.special + drift.raised.sensitive} ${drift.mode === "apply" ? "hevet" : "ville blitt hevet"} (special ${drift.raised.special}, sensitive ${drift.raised.sensitive})${drift.skipped_concurrent > 0 ? `, ${drift.skipped_concurrent} hoppet over fordi de ble endret samtidig` : ""}${drift.truncated ? "; avkortet av radtaket" : ""}${driftPending ? ". Gamle, feilmerkede elementer holder samtaler lokale til du setter JARVIS_MEMORY_RESENSITIZE=apply." : "."}`);
  const attention = reverify.length > 0 || poisoning.length > 0 || dedupe.length > 0 || driftPending;
  return {
    ev: "EV-10", title_no: "Minnevedlikehold", mode: "observe", status: attention ? "ATTENTION" : "OK",
    summary_no: attention ? `${reverify.length} å re-verifisere, ${poisoning.length} forgiftningsmistanker, ${dedupe.length} duplikatgrupper${driftPending ? `, ${drift.raised.special + drift.raised.sensitive} minner med for lav sensitivitet` : ""}.` : "Ingen funn i minnet som ble vurdert.",
    findings, source: "memory_items + memory_sources (kun metadata og antall)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-9: selvhelbredelse - tillatelsesmodellen mot ekte signaler (ingenting repareres herfra)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function healSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const [mesh, connectors, scheduler, kill] = await Promise.all([
    Promise.resolve().then(() => ctx.deps.mesh()),
    ctx.deps.connectors().catch(() => null),
    readSchedulerHealth(ctx.pool).catch(() => null),
    ctx.deps.killSwitchActive().catch(() => false)
  ]);
  const base = { attempts: 0, max_attempts: 2, repair_class: null, owner_approved: false, kill_switch_active: kill };
  const failoverPreapproved = (ctx.env["JARVIS_EV_PREAPPROVED_FAILOVER"] ?? "").trim().toLowerCase() === "true";
  const findings: string[] = [];
  let anySignal = false;
  const down = mesh.providers.filter((p) => p.provider !== "scripted" && p.state === "UNAVAILABLE");
  for (const p of down) {
    anySignal = true;
    const v = decideHeal({ ...base, action: "switch_provider", preapproved_failover: failoverPreapproved, ua_gate_live: mesh.fallback === "VERIFIED" });
    findings.push(`Leverandør ${p.provider} er nede → bytte til annen leverandør er ${v.level}: ${v.allowed ? "tillatt automatisk" : `krever eier (${v.reasons.join(", ")})`}.`);
  }
  const failing = (connectors ?? []).filter((c) => c.configured && c.health !== null && c.health.state !== "healthy");
  for (const c of failing.slice(0, 5)) {
    anySignal = true;
    const v = decideHeal({ ...base, action: "reconnect", preapproved_failover: failoverPreapproved, ua_gate_live: false });
    findings.push(`Tilkobling ${c.id} svikter → gjenoppkobling er ${v.level}: ${v.allowed ? "tillatt automatisk" : "krever eier"}.`);
  }
  if (scheduler && scheduler.problems.length > 0) {
    anySignal = true;
    findings.push(`${scheduler.problems.length} planlagte jobber har problemer → kun deteksjon (H0) er tillatt automatisk; reparasjon følger jobbens egen nytt-forsøk-logikk.`);
  }
  if (!anySignal) findings.push("Ingen feilsignaler å vurdere akkurat nå (leverandører, tilkoblinger og jobber).");
  findings.push("Evolution utfører ingen reparasjon: H0 (deteksjon) er alt som er aktivt. Watchdog og restart (fase 10) er laveste lag og er uberørt; H1+ er DEFERRED.");
  const owner = findings.filter((f) => f.includes("krever eier")).length;
  return {
    ev: "EV-9", title_no: "Selvhelbredelse (tillatelser)", mode: "observe", status: owner > 0 ? "ATTENTION" : "OK",
    summary_no: owner > 0 ? `${owner} signal(er) ville kreve eier om noe skulle repareres.` : anySignal ? "Signalene er innenfor det som kan håndteres uten eier - men ingenting repareres herfra." : "Ingen feilsignaler.",
    findings, source: "modellmeshen, connector-registeret, scheduler_state + decideHeal (EV-9)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Sovende deler: hva mangler før eieren kan ta en navngitt D-beslutning om aktivering
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function dormantSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const [{ verdict: freeze }, connectors] = await Promise.all([computeFreeze(ctx), ctx.deps.connectors().catch(() => [] as ConnectorStatus[])]);
  const ev0 = ctx.deps.ev0Status();
  const env = ctx.env;
  const facts: ReadinessFacts = {
    constitution_verified: ev0?.constitution.status === "verified",
    ledger_ok: ev0?.ledger.status === "ok",
    change_freeze_off: !freeze.frozen,
    proven_connectors: connectors.filter((c) => c.configured && c.test_method === "live" && c.health?.state === "healthy").length,
    job_runner_configured: env["JARVIS_JOB_RUNNER"] === "container" && ["JARVIS_JOB_IMAGE", "JARVIS_JOB_NETWORK", "JARVIS_JOB_EGRESS_PROXY"].every((k) => (env[k] ?? "").trim() !== ""),
    declared_gates: parseDeclaredGates(env["JARVIS_EV_VERIFIED_GATES"])
  };
  const verdicts = evaluateAllReadiness(facts);
  const findings = verdicts.map((v) =>
    v.ready_for_owner_decision
      ? `${v.ev} ${v.title_no}: alle tekniske krav er oppfylt - klar for en navngitt D-beslutning (ikke aktivert).`
      : `${v.ev} ${v.title_no} (${v.why_dormant_no}): mangler ${v.missing.length} - ${v.missing.map((m) => m.label_no).slice(0, 3).join("; ")}${v.missing.length > 3 ? "; …" : ""}.`
  );
  findings.push("Ingenting av dette er aktivert, og ingen kodevei aktiverer det: aktivering krever en navngitt D-beslutning fra deg (porter du har verifisert oppgis i JARVIS_EV_VERIFIED_GATES).");
  return {
    ev: "EV-6/11/13/14/15/18/20/22/23", title_no: "Sovende deler", mode: "dormant", status: "DORMANT",
    summary_no: `${verdicts.length} deler er bygget som beslutningsregler, men sover: ${verdicts.filter((v) => v.ready_for_owner_decision).length} har alle tekniske krav oppfylt.`,
    findings, source: "kjøretidsfakta + eierens erklærte porter (JARVIS_EV_VERIFIED_GATES)", observed_at: ctx.now.toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// EV-3: radar (innhenting fra eierens egne kilder; sikkerhetssonen er `radar.ts`)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function radarSection(ctx: EvolutionContext): Promise<EvolutionSection> {
  const radar = ctx.deps.radar;
  if (radar === undefined || (radar.configured === 0 && radar.rejected === 0)) {
    return unknownSection("EV-3", "Radar (eksterne kilder)", "JARVIS_RADAR_SOURCES", "ingen kilder er valgt (radaren er inert; eieren velger kildene)");
  }
  const last = radar.last();
  const rejected = radar.rejected > 0 ? [`${radar.rejected} kilde(r) i konfigurasjonen ble forkastet (må være https mot et vanlig vertsnavn, gyldig type og navn).`] : [];
  if (last === null) {
    return {
      ev: "EV-3", title_no: "Radar (eksterne kilder)", mode: "observe", status: rejected.length > 0 ? "ATTENTION" : "UNKNOWN",
      summary_no: `${radar.configured} kilde(r) er valgt, men radaren har ikke kjørt ennå.`,
      findings: [...rejected, "Sveipet kjører planlagt (JARVIS_RADAR_SWEEP_HOUR); innhold fra kildene er alltid ubetrodd forskning og blir aldri instruks eller evidens."],
      source: "JARVIS_RADAR_SOURCES", observed_at: ctx.now.toISOString()
    };
  }
  const attention = last.quarantined > 0 || last.failed > 0 || rejected.length > 0;
  return {
    ev: "EV-3", title_no: "Radar (eksterne kilder)", mode: "observe", status: attention ? "ATTENTION" : "OK",
    summary_no: `${last.ok} av ${last.configured} kilde(r) hentet og kontrollert${last.quarantined > 0 ? `, ${last.quarantined} i karantene` : ""}${last.failed > 0 ? `, ${last.failed} feilet` : ""}.`,
    findings: [
      ...rejected,
      ...last.per_source.map((s) => `${s.name} (${s.kind}): ${s.status === "ok" ? "ok" : s.status === "quarantined" ? "karantene" : "kunne ikke hentes"}${s.findings.length > 0 ? ` - ${s.findings.join(", ")}` : ""}.`),
      last.security_events > 0 ? `${last.security_events} kilde(r) hadde mistenkelig innhold (sikkerhetshendelse); innholdet ble ikke brukt.` : "Ingen mistenkelig innhold funnet.",
      "Kun status vises - innholdet fra kildene lagres ikke, vises ikke og kan ikke utløse noe."
    ],
    source: "JARVIS_RADAR_SOURCES (siste sveip)", observed_at: last.at
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Rapporten
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const BASE_SECTIONS: ReadonlyArray<{ ev: string; title: string; source: string; build: (ctx: EvolutionContext) => Promise<EvolutionSection> }> = [
  { ev: "EV-0/EV-8", title: "Endringsgrenser og frys", source: "konstitusjon + endringsregister", build: boundariesSection },
  { ev: "EV-5", title: "Endringsforslag", source: "evolution_change_ledger", build: proposalsSection },
  { ev: "EV-3", title: "Radar (eksterne kilder)", source: "JARVIS_RADAR_SOURCES", build: radarSection },
  { ev: "EV-4", title: "Gull-suite (regresjonsvern)", source: "golden-suite", build: goldenSection },
  { ev: "EV-9", title: "Selvhelbredelse (tillatelser)", source: "mesh + connectors + scheduler", build: healSection },
  { ev: "EV-10", title: "Minnevedlikehold", source: "memory_items", build: memorySection },
  { ev: "EV-12", title: "Modellrute i skygge", source: "modellmeshen", build: modelRouteSection },
  { ev: "EV-16", title: "Kostnad og kapasitet", source: "cost_events", build: costSection },
  { ev: "EV-17", title: "Nøkler og tilkoblinger", source: "connector-registeret", build: credentialsSection },
  { ev: "EV-19", title: "Vedlikeholdsplan", source: "scheduler_state", build: maintenanceSection },
  { ev: "EV-21", title: "Sikkerhetsselvtest (red team lite)", source: "golden-suite (adversarielle)", build: redTeamSection },
  { ev: "EV-6/11/13/14/15/18/20/22/23", title: "Sovende deler", source: "kjøretidsfakta", build: dormantSection }
];

/** Bygger rapporten NÅ (hver seksjon fail-soft). */
export async function buildEvolutionReport(deps: EvolutionSourceDeps): Promise<EvolutionReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ctx: EvolutionContext = { pool: deps.pool, tenantId: deps.tenantId, now, env: deps.env ?? process.env, deps, shared: {} };
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
