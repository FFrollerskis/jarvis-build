// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import {
  controlItem, controlSection, unknownControlSection,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus, type EvolutionReport, type EvolutionSection
} from "@jarvis/executive";
import { BudgetGuard, budgetConfigFromEnv, type BudgetConfig } from "@jarvis/model-gateway";
import { creditRunway, forecastBreach, type ReadinessVerdict } from "@jarvis/self-modification";
import type { Ev0BootStatus } from "../ev0-boot.ts";
import type { RunRateReport } from "../run-rate.ts";
import { DAY_MS, countsNo, safeCategory, safeRef, settle, toInt, toIso, type ControlCenterPool, type Settled } from "./shared.ts";

/**
 * WP-B3 (D-475, EV-22; UA-11 Admin Control Center, HF2 Evolution v1.2) - EVOLUSJON-SENTERET: ett tilleggssenter (utenfor masterplanens ti) som viser Evolution-motoren slik den står NÅ.
 *
 * Kun LESING av EKSISTERENDE kilder - ingen nye eksterne kall, ingen skriving, ingenting aktiveres. Selvendring er frosset (D-397): ingen seksjon her kan gi en kodevei til å endre Jarvis' egen produksjonskode, konfig eller
 * prompts, og `activation_decision` for de sovende delene er ALLTID false (`readiness.ts`). Rapporten bærer kun antall, kategorier, tilstander, tidsstempler og interne id-er - aldri forslagstekst, minneinnhold eller hemmeligheter.
 *
 * Seksjoner (alle kildeforankret; en kilde som ikke kan leses gjør kun SIN seksjon ukjent - «ukjent» er aldri «i orden»):
 *  1. `ports`      - evolusjonsportene EV-0…EV-21 i observasjonsmodus, fra evolusjonsrapporten (`executive.get_evolution_report`, D-452): én rad per port med rapportens egen status, sammendrag og målt-tidspunkt. Her ligger også
 *                    modellautopilot i skygge (EV-12), credential-vurderingen (EV-17), vedlikeholdsplanen (EV-19) og kostnadsporten (EV-16).
 *  2. `dormant`    - de sovende delene (EV-6, 11, 13, 14, 15, 18, 20, 22, 23): beredskapsvurdering fra `readiness.ts` (hva mangler før eieren kan ta en navngitt D-beslutning). Et krav som hviler på et innsignal som ikke kunne måles
 *                    er IKKE oppfylt (ukjent). Ingenting herfra kan aktivere noe.
 *  3. `ledger`     - endringsregisteret (EV-0, hash-kjede) og forslag (EV-5): kjedens tilstand, antall forslag per beslutning siste 30 døgn og hvilke som venter på deg (id, klasse, alder - aldri forslagstekst).
 *  4. `cost_model` - KOSTMODELLEN (EV-16): månedsforbruk mot grensene (varsel/godkjenning/hardgrense, BudgetGuard), månedsprognose (run-rate, D-421), rekkevidde og trend til hardgrensen (EV-16-reglene). Beløp i øre.
 *
 * KOSTNAD I ØRE (strengeste regel inntil eieren har svart, Q-64): kostmodellen er finansavledet. Senteret holdes derfor tilbake HELT fra skymodeller VED UTFØRELSE (`CLOUD_WITHHELD_CENTERS` i executive-transporten: en skymodell får aldri
 * en rapport herfra; lokal modell og `/control` får alt). I TILLEGG utelater senteret selv kostmodellen og kostnadsporten hvis det likevel bygges for en mottaker med `restrictFinance` (andre lag i dybden: å åpne senteret for sky
 * senere må aldri ta kostnaden med seg uten et eksplisitt valg).
 *
 * TENANT: rapportleverandøren og beredskapen er bundet til eierens tenant ved oppstart (`reportTenantId`); bygges senteret for en annen tenant, leses de ikke (ukjent). Kostnad leses som app-rolle under identitetens egen tenant (RLS).
 * Endringsregisteret er GLOBALT (selvendring er en eier-handling over den delte kodebasen, migrasjon 075) og leses uten tenant; det har ingen RLS og leses kun som antall, klasser og id-er.
 */

/** Porter i rapporten (rekkefølgen er visningsrekkefølgen). `id` er et stabilt id-navn (rapportens `ev` kan inneholde skråstrek). */
const PORTS: ReadonlyArray<{ ev: string; id: string; label: string; finance: boolean }> = [
  { ev: "EV-0/EV-8", id: "ev0_ev8", label: "EV-0/EV-8 Endringsgrenser og frys", finance: false },
  { ev: "EV-3", id: "ev3", label: "EV-3 Radar (eksterne kilder)", finance: false },
  { ev: "EV-4", id: "ev4", label: "EV-4 Gull-suite (regresjonsvern)", finance: false },
  { ev: "EV-5", id: "ev5", label: "EV-5 Endringsforslag", finance: false },
  { ev: "EV-9", id: "ev9", label: "EV-9 Selvhelbredelse (tillatelser)", finance: false },
  { ev: "EV-10", id: "ev10", label: "EV-10 Minnevedlikehold", finance: false },
  { ev: "EV-12", id: "ev12", label: "EV-12 Modellrute i skygge (modellautopilot)", finance: false },
  { ev: "EV-16", id: "ev16", label: "EV-16 Kostnad og kapasitet", finance: true },
  { ev: "EV-17", id: "ev17", label: "EV-17 Nøkler og tilkoblinger (credential-vurdering)", finance: false },
  { ev: "EV-19", id: "ev19", label: "EV-19 Vedlikeholdsplan", finance: false },
  { ev: "EV-21", id: "ev21", label: "EV-21 Sikkerhetsselvtest (red team lite)", finance: false }
];

/** Rapportens statusord til kontrollsenterets. Ukjent/uventet verdi er UKJENT (fail-closed) - aldri «i orden». */
function portStatus(status: unknown): ControlStatus {
  if (status === "OK") return "OK";
  if (status === "ATTENTION") return "WARN";
  return "UNKNOWN";
}

const STATUS_ORDER: Readonly<Record<ControlStatus, number>> = { FAIL: 0, WARN: 1, UNKNOWN: 2, OK: 3 };
/** `EV-6` før `EV-11` (numerisk), ellers bokstavorden. */
function evNumber(ev: string): number {
  const m = /(\d+)/.exec(ev);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;

/** Rapporten som sentret leser: kun seksjonene (og målt-tidspunktet hvis det finnes). Strukturelt - `createEvolutionReportProvider` oppfyller det. */
export type EvolutionReportRead = () => Promise<Pick<EvolutionReport, "sections"> & { as_of?: string }>;

export interface EvolutionCenterDeps {
  /** App-rollens pool: kostnad (under identitetens tenant, RLS) og endringsregisteret (globalt, kun SELECT). */
  pool: ControlCenterPool;
  /** Miljøet grensene leses fra (`JARVIS_COST_*`; kun ikke-hemmelige verdier). */
  env: Readonly<Record<string, string | undefined>>;
  /** Evolusjonsrapporten (B1/B2, kort cache). Uten den finnes ikke senteret (registreres ikke). */
  evolutionReport: EvolutionReportRead;
  /** Strukturerte beredskapsvurderinger (`evaluateEvolutionReadiness`). Utelatt = «Sovende deler» er UKJENT. */
  readiness?: () => Promise<readonly ReadinessVerdict[]>;
  /** EV-0-oppstartsresultatet (konstitusjon + endringsregister); `null` før første sjekk. Utelatt = UKJENT. */
  ev0Status?: () => Ev0BootStatus | null;
  /** `RunRateService` (D-421): månedsprognose og dagssummer. Utelatt = kostmodellens prognose er UKJENT. */
  runRate?: { report(tenantId: string): Promise<RunRateReport> };
  /** Tenanten rapportleverandøren og beredskapen er bundet til (eierens). En annen identitet-tenant leser dem ikke. Utelatt = ingen kontroll (kun enhetstester). */
  reportTenantId?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Porter
// ---------------------------------------------------------------------------------------------------------------------
function portsSection(report: Settled<Awaited<ReturnType<EvolutionReportRead>>> | "other_tenant", restrictFinance: boolean, nowIso: string): ControlSection {
  const title = "Evolusjonsporter (observasjon)";
  const source = "evolusjonsrapporten (executive.get_evolution_report, WP-B/D-452; seksjonene EV-0…EV-21, kun observasjon, `acts: false`) - hver rad har egen kilde og målt-tidspunkt";
  if (report === "other_tenant") return unknownControlSection("ports", title, source, "rapporten gjelder en annen tenant enn din (den leses ikke)");
  if (!report.ok) return unknownControlSection("ports", title, source, `rapporten kunne ikke leses (${report.category})`);
  const sections = Array.isArray(report.value?.sections) ? report.value.sections : null;
  if (sections === null) return unknownControlSection("ports", title, source, "rapporten hadde ikke den forventede formen");
  const byEv = new Map<string, EvolutionSection>();
  for (const s of sections) if (s && typeof s.ev === "string") byEv.set(s.ev, s);
  const items: ControlItem[] = [];
  for (const port of PORTS) {
    if (restrictFinance && port.finance) continue;
    const s = byEv.get(port.ev);
    if (s === undefined) {
      items.push(controlItem({ id: `port:${port.id}`, label: port.label, status: "UNKNOWN", detail_no: "Porten finnes ikke i rapporten (ikke målt).", facts: { ev: port.ev, mode: "observe", report_status: null, findings: null } }));
      continue;
    }
    items.push(controlItem({
      id: `port:${port.id}`, label: port.label, status: portStatus(s.status),
      detail_no: typeof s.summary_no === "string" && s.summary_no.trim() !== "" ? s.summary_no : "Rapporten ga ikke et sammendrag (ikke målt).",
      facts: { ev: port.ev, mode: "observe", report_status: typeof s.status === "string" ? s.status : null, findings: Array.isArray(s.findings) ? s.findings.length : null, source: typeof s.source === "string" ? s.source : null },
      observed_at: toIso(s.observed_at)
    }));
  }
  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const measuredAt = typeof report.value.as_of === "string" ? toIso(report.value.as_of) ?? nowIso : nowIso;
  return controlSection({
    id: "ports", title_no: title, source, observed_at: measuredAt, items,
    summary_no: `${items.length} porter i observasjonsmodus: ${countsNo(items)}. Ingenting herfra utfører eller aktiverer noe (selvendring er frosset, D-397).${restrictFinance ? " Kostnadsporten (EV-16) er holdt tilbake." : ""}`
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Sovende deler (beredskap)
// ---------------------------------------------------------------------------------------------------------------------
/** Hva senteret selv sier om EV-22 og EV-23 (denne WP-en): fast tekst, aldri data. */
function dormantNote(ev: string): string {
  if (ev === "EV-22") return " Denne flaten (Evolusjon-senteret) er koblet inn og slått på, men det er IKKE en aktivering: kravet «Kontrollsentrene (UA-11) finnes» erklærer du selv (JARVIS_EV_VERIFIED_GATES).";
  if (ev === "EV-23") return " Godkjenning i kontrollsenteret er DEFERRED: ingen knapp godkjenner, avviser eller utfører noe.";
  return "";
}

/** Kravets id (fast kodeverdi, f.eks. `gate:D-32` eller `proven_connectors>=3`) som en trygg kategori: `>=` blir `_ge_` og øvrige tegn utenfor kategorialfabetet `_` - aldri «annet» for et ekte krav. */
function requirementId(id: unknown): string {
  return safeCategory(typeof id === "string" ? id.replace(/>=/g, "_ge_").replace(/[^A-Za-z0-9_:.-]/g, "_") : "ukjent_krav");
}

function dormantSection(verdicts: Settled<readonly ReadinessVerdict[]> | "other_tenant", nowIso: string): ControlSection {
  const title = "Sovende deler (beredskap, ingenting aktiveres)";
  const source = "readiness.ts (EV-6/11/13/14/15/18/20/22/23) mot kjøretidsfakta (konstitusjon, endringsregister, frys, beviste connectorer) og dine erklærte porter (JARVIS_EV_VERIFIED_GATES)";
  if (verdicts === "other_tenant") return unknownControlSection("dormant", title, source, "beredskapen gjelder en annen tenant enn din (den leses ikke)");
  if (!verdicts.ok) return unknownControlSection("dormant", title, source, `beredskapen kunne ikke vurderes (${verdicts.category})`);
  if (!Array.isArray(verdicts.value)) return unknownControlSection("dormant", title, source, "beredskapen hadde ikke den forventede formen");
  const items: ControlItem[] = [];
  for (const v of verdicts.value) {
    // Formen valideres ved kjøring (beredskapen kan være en testdobler): en vurdering uten forventet form hoppes over, og er ingen del igjen står seksjonen som ukjent.
    if (!v || typeof v.ev !== "string" || !Array.isArray(v.met) || !Array.isArray(v.missing)) continue;
    const missing: ReadonlyArray<{ id?: unknown; label_no?: unknown; unknown?: unknown }> = v.missing;
    const ev = safeCategory(v.ev);
    const unknownCount = missing.filter((m) => m?.unknown === true).length;
    const unknownSignals = Array.isArray(v.unknown_signals) ? v.unknown_signals.length : 0;
    // Et krav som hviler på et innsignal som ikke kunne måles er IKKE oppfylt (ukjent) - aldri «i orden». Et KJENT, manglende krav er derimot nettopp det en sovende del skal ha, og er ikke en feil.
    const status: ControlStatus = unknownCount > 0 || unknownSignals > 0 ? "UNKNOWN" : "OK";
    const missingLabels = missing.slice(0, 2).map((m) => (typeof m?.label_no === "string" ? m.label_no : "ukjent krav")).join("; ");
    items.push(controlItem({
      id: `dormant:${ev}`, label: `${ev} ${typeof v.title_no === "string" ? v.title_no : ""}`.trim(), status,
      // Rekkefølgen er bevisst: det som MÅ stå (ikke aktivert, hva senteret selv er, antall og klarhet) kommer først; kravenes etiketter er lengst og står sist (detaljen kuttes ved 400 tegn; id-ene står i `missing_ids`).
      detail_no: `Sover (${typeof v.why_dormant_no === "string" ? v.why_dormant_no : "ukjent årsak"}). Ikke aktivert - ingen kodevei aktiverer dette.${dormantNote(v.ev)} ${v.met.length} krav oppfylt, ${missing.length} mangler${unknownCount > 0 ? ` (${unknownCount} kunne ikke måles og regnes som IKKE oppfylt)` : ""}. ${v.ready_for_owner_decision === true ? "Alle tekniske krav er oppfylt: klar for en navngitt D-beslutning fra deg - IKKE aktivert." : "Ikke klar for en D-beslutning."}${missing.length > 0 ? ` Mangler: ${missingLabels}${missing.length > 2 ? "; …" : ""}` : ""}`,
      facts: {
        ev, dormant: true, activation_decision: false, ready_for_owner_decision: v.ready_for_owner_decision === true,
        met: v.met.length, missing: missing.length, missing_unknown: unknownCount, unknown_signals: unknownSignals,
        missing_ids: missing.map((m) => requirementId(m?.id)).join(",")
      },
      observed_at: nowIso
    }));
  }
  if (items.length === 0) return unknownControlSection("dormant", title, source, "beredskapen ga ingen deler");
  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || evNumber(a.label) - evNumber(b.label));
  const ready = items.filter((i) => i.facts?.["ready_for_owner_decision"] === true).length;
  return controlSection({
    id: "dormant", title_no: title, source, observed_at: nowIso, items,
    summary_no: `${items.length} sovende deler: ${countsNo(items)}; ${ready} har alle tekniske krav oppfylt. Alle er bevisst IKKE aktivert - aktivering krever en navngitt D-beslutning fra deg, og ingen kodevei gjør «klar» til en aktivering.`
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Endringsregister og forslag
// ---------------------------------------------------------------------------------------------------------------------
/** Forslag som venter på eieren vises med høyst så mange rader; resten telles. */
export const MAX_LISTED_PROPOSALS = 20;

interface PendingProposal { change_id: string; change_class: string; digest: string; recorded_at: string | null; path_count: number }
interface LedgerRead { by_decision: Array<{ decision: string; n: number }>; pending: PendingProposal[]; pending_total: number; pending_by_class: Array<{ change_class: string; n: number }> }

/** Endringsregisteret er GLOBALT (ingen tenant, ingen RLS): kun antall, klasser, id-er og tidspunkt leses - aldri `subject`, `paths`, `evidence` eller `branch`. */
async function readLedger(pool: ControlCenterPool, sinceIso: string): Promise<LedgerRead> {
  const byDecision = (await pool.query(
    `SELECT decision, count(*)::int AS n FROM evolution_change_ledger WHERE at >= $1::timestamptz GROUP BY decision ORDER BY decision`, [sinceIso]
  )).rows as Array<{ decision: unknown; n: unknown }>;
  const pending = (await pool.query(
    `SELECT t.change_id, t.change_class, t.entry_hash AS digest, t.at::text AS recorded_at, cardinality(t.paths)::int AS path_count
       FROM (SELECT DISTINCT ON (change_id) change_id, change_class, decision, entry_hash, at, paths FROM evolution_change_ledger ORDER BY change_id, seq DESC) t
      WHERE t.decision = 'proposed' ORDER BY t.at ASC, t.change_id ASC LIMIT ${MAX_LISTED_PROPOSALS}`
  )).rows as Array<{ change_id: unknown; change_class: unknown; digest: unknown; recorded_at: unknown; path_count: unknown }>;
  const byClass = (await pool.query(
    `SELECT t.change_class, count(*)::int AS n
       FROM (SELECT DISTINCT ON (change_id) change_id, change_class, decision FROM evolution_change_ledger ORDER BY change_id, seq DESC) t
      WHERE t.decision = 'proposed' GROUP BY t.change_class ORDER BY t.change_class`
  )).rows as Array<{ change_class: unknown; n: unknown }>;
  return {
    by_decision: byDecision.map((r) => ({ decision: safeCategory(r.decision), n: toInt(r.n) })),
    pending: pending.map((r) => ({
      change_id: String(r.change_id), change_class: safeCategory(r.change_class), digest: String(r.digest), recorded_at: toIso(r.recorded_at), path_count: toInt(r.path_count)
    })),
    pending_total: byClass.reduce((a, r) => a + toInt(r.n), 0),
    pending_by_class: byClass.map((r) => ({ change_class: safeCategory(r.change_class), n: toInt(r.n) }))
  };
}

function ledgerSection(ev0: Settled<Ev0BootStatus | null> | null, ledger: Settled<LedgerRead>, nowMs: number, nowIso: string): ControlSection {
  const title = "Endringsregister og forslag";
  const source = "evolution_change_ledger (EV-0/EV-5, globalt, kun antall/klasser/id-er) · EV-0-oppstartssjekken (konstitusjon + hash-kjede)";
  const items: ControlItem[] = [];

  // Hash-kjeden og konstitusjonen (oppstartssjekken). Ikke kjørt/ulesbar er UKJENT; en ødelagt kjede er FEIL.
  const boot = ev0 !== null && ev0.ok ? ev0.value : null;
  if (boot === null) {
    items.push(controlItem({ id: "chain", label: "Hash-kjeden i endringsregisteret", status: "UNKNOWN", detail_no: ev0 === null ? "Oppstartssjekken er ikke koblet inn (ikke målt)." : ev0.ok ? "Oppstartssjekken har ikke kjørt siden oppstart (ikke målt)." : `Oppstartssjekken kunne ikke leses (${ev0.category}).`, facts: { chain: null } }));
    items.push(controlItem({ id: "constitution", label: "Safety Constitution (EV-0)", status: "UNKNOWN", detail_no: "Oppstartssjekken har ikke et resultat (ikke målt).", facts: { constitution: null } }));
  } else {
    const l = boot.ledger;
    if (l?.status === "ok") items.push(controlItem({ id: "chain", label: "Hash-kjeden i endringsregisteret", status: "OK", detail_no: `Intakt (${toInt(l.count)} rader), verifisert ved oppstart.`, facts: { chain: "ok", rows: toInt(l.count) } }));
    else if (l?.status === "broken") items.push(controlItem({ id: "chain", label: "Hash-kjeden i endringsregisteret", status: "FAIL", detail_no: `Hash-kjeden er ØDELAGT${typeof l.broken_seq === "string" ? ` fra rad ${safeCategory(l.broken_seq)}` : ""} - Evolution kan ikke aktiveres, og endringsregisteret kan ikke stoles på.`, facts: { chain: "broken", broken_seq: typeof l.broken_seq === "string" ? safeCategory(l.broken_seq) : null } }));
    else items.push(controlItem({ id: "chain", label: "Hash-kjeden i endringsregisteret", status: "UNKNOWN", detail_no: "Endringsregisteret var utilgjengelig ved oppstart (ikke målt).", facts: { chain: "unavailable" } }));
    const c = boot.constitution;
    if (c?.status === "verified") items.push(controlItem({ id: "constitution", label: "Safety Constitution (EV-0)", status: "OK", detail_no: `Signert og verifisert (versjon ${toInt(c.version)}).`, facts: { constitution: "verified", version: toInt(c.version) } }));
    else items.push(controlItem({ id: "constitution", label: "Safety Constitution (EV-0)", status: "WARN", detail_no: `Ikke verifisert (${safeCategory(c?.status === "not_verified" ? c.code : "ukjent_kode")}) - Evolution kan ikke aktiveres før du har signert den.`, facts: { constitution: "not_verified", code: safeCategory(c?.status === "not_verified" ? c.code : "ukjent_kode") } }));
  }

  if (!ledger.ok) {
    items.push(controlItem({ id: "proposals", label: "Forslag i endringsregisteret", status: "UNKNOWN", detail_no: `Endringsregisteret kunne ikke leses (${ledger.category}).`, facts: { waiting: null } }));
  } else {
    const r = ledger.value;
    const total = r.by_decision.reduce((a, d) => a + d.n, 0);
    items.push(controlItem({
      id: "decisions_30d", label: "Registrert siste 30 døgn", status: "OK",
      detail_no: total === 0 ? "Ingen rader i endringsregisteret siste 30 døgn (ingen forslag er registrert)." : `${total} rader: ${r.by_decision.map((d) => `${d.n} ${d.decision}`).join(", ")}.`,
      facts: { total, ...Object.fromEntries(r.by_decision.map((d) => [d.decision, d.n])) }
    }));
    items.push(controlItem({
      id: "proposals", label: "Forslag som venter på din avgjørelse", status: r.pending_total > 0 ? "WARN" : "OK",
      detail_no: r.pending_total === 0 ? "Ingen forslag venter på deg." : `${r.pending_total} forslag venter på deg (${r.pending_by_class.map((c) => `${c.n} ${c.change_class}`).join(", ")}). Å se innholdet og avgjøre skjer utenfor kontrollsenteret - ingenting utføres av et forslag.`,
      facts: { waiting: r.pending_total, ...Object.fromEntries(r.pending_by_class.map((c) => [`class_${c.change_class}`, c.n])) }
    }));
    const usedIds = new Set<string>();
    r.pending.forEach((p, i) => {
      // Id-er i en seksjon må være unike (en kollisjon ville felt hele senteret): en id som ikke er trygg å vise får en reserveverdi, og en som likevel kolliderer får en løpenummer-hale.
      let id = safeRef(p.change_id, `forslag-ukjent-${i + 1}`);
      if (usedIds.has(id)) id = `${id}-${i + 1}`;
      usedIds.add(id);
      const ageMs = p.recorded_at === null ? null : Math.max(0, nowMs - Date.parse(p.recorded_at));
      items.push(controlItem({
        id: `proposal:${id}`, label: `Forslag ${id}`, status: "WARN",
        detail_no: `${p.change_class}-forslag, ${p.path_count} sti${p.path_count === 1 ? "" : "er"}, registrert ${ageMs === null ? "ukjent tid siden" : `for ${Math.floor(ageMs / DAY_MS)} d siden`}. Forslagets innhold vises ikke her (kun id, klasse og alder).`,
        facts: { change_class: p.change_class, path_count: p.path_count, digest: p.digest.slice(0, 12), age_days: ageMs === null ? null : Math.floor(ageMs / DAY_MS) },
        observed_at: p.recorded_at
      }));
    });
    if (r.pending_total > r.pending.length) {
      items.push(controlItem({ id: "proposals_more", label: "Flere forslag venter", status: "WARN", detail_no: `${r.pending_total - r.pending.length} forslag til venter (de eldste ${r.pending.length} vises).`, facts: { not_listed: r.pending_total - r.pending.length } }));
    }
  }
  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return controlSection({
    id: "ledger", title_no: title, source, observed_at: nowIso, items,
    summary_no: `${items.length} opplysninger om endringsregisteret og forslag: ${countsNo(items)}. Selvendring er frosset (D-397): et forslag utføres aldri av seg selv.`
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Kostmodellen (EV-16)
// ---------------------------------------------------------------------------------------------------------------------
/** Trendprognosen advarer når hardgrensen nås innen så mange dager (samme terskel som EV-16-seksjonen i rapporten). */
export const TREND_WARN_DAYS = 14;
/** Rekkevidden advarer når det er så få dager igjen til hardgrensen med månedens snitt (samme terskel som EV-16-seksjonen). */
export const RUNWAY_WARN_DAYS = 7;

type Budget = { level: "ok" | "warn" | "needs_approval" | "hard_blocked"; spent_ore: number };

function costModelSection(
  limits: Settled<BudgetConfig>, budget: Settled<Budget>, runRate: Settled<RunRateReport> | null, nowIso: string
): ControlSection {
  const title = "Kostmodell (EV-16)";
  const source = "cost_events via BudgetGuard og RunRateService (D-421; tenant-RLS) · miljø (JARVIS_COST_WARN_ORE, JARVIS_COST_APPROVAL_ORE, JARVIS_COST_HARD_LIMIT_ORE, JARVIS_BUDGET_APPROVED) · EV-16-reglene (creditRunway, forecastBreach)";
  const items: ControlItem[] = [];
  const lim = limits.ok ? limits.value : null;

  items.push(lim === null
    ? controlItem({ id: "limits", label: "Grenser per måned", status: "UNKNOWN", detail_no: `Grensene kunne ikke leses (${limits.ok ? "ukjent" : limits.category}) - ingenting kan vurderes mot dem.`, facts: { warn_ore: null, approval_ore: null, hard_limit_ore: null } })
    : controlItem({
      id: "limits", label: "Grenser per måned", status: "OK",
      detail_no: `Varsel ${kr(lim.warn_ore)}, godkjenning ${kr(lim.approval_ore)}, hardgrense ${kr(lim.hard_limit_ore)}. Forbruk over godkjenningsgrensen er ${lim.spend_approved ? "godkjent av deg (JARVIS_BUDGET_APPROVED)" : "IKKE godkjent - nye modellkall stoppes ved grensen"}.`,
      facts: { warn_ore: lim.warn_ore, approval_ore: lim.approval_ore, hard_limit_ore: lim.hard_limit_ore, spend_approved: lim.spend_approved }
    }));

  let spent: number | null = null;
  if (budget.ok) {
    spent = budget.value.spent_ore;
    const b = budget.value;
    const status: ControlStatus = b.level === "ok" ? "OK" : b.level === "warn" ? "WARN" : "FAIL";
    items.push(controlItem({
      id: "month_to_date", label: "Forbruk hittil denne måneden", status,
      detail_no: b.level === "ok" ? `${kr(b.spent_ore)} - under varselgrensen.`
        : b.level === "warn" ? `${kr(b.spent_ore)} - over varselgrensen.`
        : b.level === "needs_approval" ? `${kr(b.spent_ore)} - over godkjenningsgrensen: nye modellkall STOPPES til du godkjenner (JARVIS_BUDGET_APPROVED).`
        : `${kr(b.spent_ore)} - hardgrensen er nådd: nye modellkall nektes.`,
      facts: { level: b.level, spent_month_ore: b.spent_ore, percent_of_hard_limit: lim === null || lim.hard_limit_ore <= 0 ? null : Math.round((b.spent_ore / lim.hard_limit_ore) * 1000) / 10 }
    }));
  } else {
    items.push(controlItem({ id: "month_to_date", label: "Forbruk hittil denne måneden", status: "UNKNOWN", detail_no: `Forbruket kunne ikke måles (${budget.category}).`, facts: { level: null, spent_month_ore: null } }));
  }

  // Månedsprognose (run-rate: snitt siste 7 døgn x 30) mot grensene.
  let rr: RunRateReport | null = null;
  if (runRate === null) {
    items.push(controlItem({ id: "projection", label: "Månedsprognose", status: "UNKNOWN", detail_no: "Run-rate-kilden er ikke koblet inn i dette senteret (ikke målt).", facts: { projected_month_ore: null } }));
  } else if (!runRate.ok) {
    items.push(controlItem({ id: "projection", label: "Månedsprognose", status: "UNKNOWN", detail_no: `Run-rate kunne ikke måles (${runRate.category}).`, facts: { projected_month_ore: null } }));
  } else {
    rr = runRate.value;
    const projected = rr.totals.projected_month_ore;
    const base = { projected_month_ore: projected, basis: "snitt siste 7 døgn x 30", today_ore: rr.totals.today_ore, last_7d_ore: rr.totals.last_7d_ore, last_30d_ore: rr.totals.last_30d_ore, cloud_share_30d: rr.cloud_share_30d };
    if (projected === null) {
      items.push(controlItem({ id: "projection", label: "Månedsprognose", status: "UNKNOWN", detail_no: "For lite data til en prognose (under 3 døgn med målinger siste 7 døgn) - ikke målt.", facts: base }));
    } else if (lim === null) {
      items.push(controlItem({ id: "projection", label: "Månedsprognose", status: "UNKNOWN", detail_no: `Prognose ${kr(projected)} (snitt siste 7 døgn x 30), men grensene er ukjente - kan ikke vurderes mot dem.`, facts: base }));
    } else {
      const status: ControlStatus = projected >= lim.approval_ore ? "WARN" : "OK";
      const vs = projected >= lim.hard_limit_ore ? "over hardgrensen" : projected >= lim.approval_ore ? "over godkjenningsgrensen" : projected >= lim.warn_ore ? "over varselgrensen, men under godkjenningsgrensen" : "under varselgrensen";
      items.push(controlItem({
        id: "projection", label: "Månedsprognose", status,
        detail_no: `Prognose ${kr(projected)} for måneden (snitt siste 7 døgn x 30; ikke en budsjettgaranti): ${vs}.`,
        facts: { ...base, vs_limits: vs }
      }));
    }
  }

  // Rekkevidde til hardgrensen med månedens snitt (EV-16 `creditRunway`) og lineær trend til hardgrensen (EV-16 `forecastBreach`).
  if (lim !== null && spent !== null && rr !== null) {
    const asOf = new Date(rr.as_of);
    const dayOfMonth = Number.isNaN(asOf.getTime()) ? 0 : asOf.getUTCDate();
    if (dayOfMonth > 0) {
      const burn = spent / dayOfMonth;
      const runway = creditRunway({ balance_ore: Math.max(0, lim.hard_limit_ore - spent), burn_ore_per_day: burn, warn_days: RUNWAY_WARN_DAYS });
      items.push(controlItem({
        id: "runway", label: "Rekkevidde til hardgrensen", status: runway.warn ? "WARN" : "OK",
        detail_no: runway.days_left === null ? "Ikke noe forbruk hittil i måneden, så ingen utregnet rekkevidde." : `Med månedens snitt (${kr(Math.round(burn))} per døgn) nås hardgrensen om ca. ${runway.days_left} dager.${runway.warn ? " Det er kort." : ""}`,
        facts: { days_left: runway.days_left, burn_ore_per_day: Math.round(burn) }
      }));
      const month = rr.as_of.slice(0, 7);
      let cumulative = 0;
      const samples = rr.daily.filter((d) => typeof d.day === "string" && d.day.startsWith(month)).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ at: `${d.day}T12:00:00.000Z`, value: (cumulative += toInt(d.ore)) }));
      const trend = forecastBreach(samples, lim.hard_limit_ore, 45, 5);
      if (trend.confidence === "low") {
        items.push(controlItem({ id: "trend", label: "Trend mot hardgrensen", status: "UNKNOWN", detail_no: "For lite data i måneden til en trendprognose (krever minst 5 dager med kostnad over minst 2 døgn) - ikke målt.", facts: { days_to_breach: null, samples: trend.samples, confidence: trend.confidence } }));
      } else {
        const soon = trend.days_to_breach !== null && trend.days_to_breach <= TREND_WARN_DAYS;
        items.push(controlItem({
          id: "trend", label: "Trend mot hardgrensen", status: soon ? "WARN" : "OK",
          detail_no: trend.days_to_breach === null ? "Ingen brudd på hardgrensen innen 45 dager med dagens vekst." : trend.days_to_breach === 0 ? "Trenden ligger allerede på eller over hardgrensen." : `Med dagens vekst nås hardgrensen om ca. ${trend.days_to_breach} dager.`,
          facts: { days_to_breach: trend.days_to_breach, slope_ore_per_day: trend.slope_per_day, samples: trend.samples, confidence: trend.confidence }
        }));
      }
    }
  }

  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const notMeasured = rr !== null ? ` Ikke målt: ${rr.not_measured.slice(0, 2).join("; ")}.` : "";
  return controlSection({
    id: "cost_model", title_no: title, source, observed_at: nowIso, items,
    summary_no: `${items.length} kostopplysninger (beløp i øre i måledata): ${countsNo(items)}. Prognosene foreslår kun - ingen utgift, opprydding eller påfyll utløses herfra.${notMeasured}`
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------
export function createEvolutionCenter(deps: EvolutionCenterDeps): ControlCenterDefinition {
  return {
    id: "evolution",
    title_no: "Evolusjon",
    description_no: "Evolusjonsportene (observasjon), beredskap for de sovende delene, endringsregisteret og forslag som venter, og kostmodellen (EV-16) - kun lesing; ingenting aktiveres, selvendring er frosset",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const tenantId = ctx.identity.tenant_id;
      const nowIso = ctx.now.toISOString();
      const nowMs = ctx.now.getTime();
      const restrictFinance = ctx.restrictFinance === true;
      // Rapportleverandøren og beredskapen er bundet til eierens tenant ved oppstart: en annen identitet leser dem ikke (tenant-isolasjon i dybden).
      const sameTenant = deps.reportTenantId === undefined || deps.reportTenantId === tenantId;

      const limitsR: Settled<BudgetConfig> = await settle(async () => budgetConfigFromEnv({ ...deps.env }));
      const [reportR, readinessR, ledgerR, budgetR, runRateR] = await Promise.all([
        sameTenant ? settle(() => deps.evolutionReport()) : Promise.resolve("other_tenant" as const),
        sameTenant ? (deps.readiness ? settle(() => deps.readiness!()) : Promise.resolve({ ok: false, category: "ikke koblet inn" } as Settled<readonly ReadinessVerdict[]>)) : Promise.resolve("other_tenant" as const),
        settle(() => readLedger(deps.pool, new Date(nowMs - 30 * DAY_MS).toISOString())),
        // Kostmodellen leses KUN når mottakeren ikke er begrenset (finansavledet tilstand holdes tilbake fra sky, og senteret bygges normalt aldri for sky).
        restrictFinance ? Promise.resolve(null) : (limitsR.ok ? settle<Budget>(async () => new BudgetGuard(deps.pool as pg.Pool, limitsR.value).evaluate(tenantId)) : Promise.resolve({ ok: false, category: "ugyldige grenser" } as Settled<Budget>)),
        restrictFinance ? Promise.resolve(null) : (deps.runRate ? settle(() => deps.runRate!.report(tenantId)) : Promise.resolve(null))
      ]);
      const ev0R: Settled<Ev0BootStatus | null> | null = deps.ev0Status ? await settle(async () => deps.ev0Status!()) : null;

      const sections: ControlSection[] = [
        portsSection(reportR, restrictFinance, nowIso),
        dormantSection(readinessR, nowIso),
        ledgerSection(ev0R, ledgerR, nowMs, nowIso)
      ];
      if (!restrictFinance && budgetR !== null) sections.push(costModelSection(limitsR, budgetR, runRateR, nowIso));
      return { sections, actions: [] };
    }
  };
}
