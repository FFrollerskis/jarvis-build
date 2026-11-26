// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { controlItem, controlSection, unknownControlSection, type ControlItem, type ControlSection, type ControlStatus } from "@jarvis/executive";
import type { VisionStatusReport } from "../vision-routes.ts";
import { HOUR_MS, NON_HEALTH_SPACES, bySeverityThenLabel, countsNo, relativeNo, safeCategory, settle, tenantSpaceRead, toInt, toIso, type ControlCenterPool, type Settled } from "./shared.ts";

/**
 * WP-G3b (D-485), K2 (Q-74 pkt 10): SYN-KORTET i Personvern-senteret - helsebildet til kamerakjøretiden (UA-9) og de gjeldende oppbevaringsvinduene, KUN LESING.
 *
 * Kortet FINNES kun når `JARVIS_VISION_ENABLED=on` OG Personvern-senteret er på (`registerControlCenters` gir senteret en `vision`-kilde bare da; uten den er senteret byte-identisk med main, bevist mot et opptak i
 * `wpg3b-privacy-parity.test.ts`). Ingen handlinger: retensjonsvinduene settes via eier-ruten `/vision/retention/set` (grant, eier, step-up), aldri herfra.
 *
 * INNHOLDSVERN (ingen personopplysninger): kun tellere, tilstander, koder og tidspunkt for kjøretiden - aldri bilder, etiketter, kameranavn, rom, enhets-id-er, entity-id-er eller hendelsesinnhold. Kilden er `VisionStatusReport`
 * (samme tall som `/vision/status`, som allerede er kode- og tall-kun), men hvert felt lest HER er enten et heltall (`toInt`), en boolsk, et ISO-tidspunkt (`toIso`) eller en kort kode gjennom `safeCategory` - en feil i kilden kan derfor
 * ikke gi fri tekst i rapporten. `last_inventory_skip_at` tas BEVISST ikke med (tidspunktet for en kamerahendelse med et objekt er aktivitetsinformasjon); kun tellerne. Dagene fra `vision_retention_policies` er konfigurasjon, ikke innhold.
 * Senteret er IKKE finansavledet (ingen finanskilde leses, ingen finanstilstand vises), så `restrictFinance` er uten betydning her; kortet kan heller ikke bære finansdata fordi det kun leser de to kildene over (låst av en kildevakt).
 *
 * FEIL-LUKKET: kilden kaster (`status()` før kjøretiden er klar), er malformet, eller databasen svarer ikke -> kortet viser `Utilgjengelig` (UNKNOWN, aldri OK) og resten av senteret er uberørt (hver lesing går gjennom `settle`, og
 * hele byggingen er innpakket så en uforutsett feil gir en «ikke målt»-seksjon, aldri et kastet senter).
 *
 * ÆRLIGHET: å sette vinduene gjelder rader som skrives ETTER endringen (utløpet er forankret ved skriving); eksisterende hendelser, bilder og inventar beholder sitt utløp. Det står i seksjonssammendraget.
 */
export interface PrivacyVisionSource {
  /** Kjøretidens helsebilde (`VisionRuntime.status()`); LAT fordi kjøretiden bygges etter sentrene i `main.ts`. Kaster = kortet viser «utilgjengelig». */
  status: () => VisionStatusReport;
  /** Standardvinduene (dager) som gjelder uten egen innstilling: `DEFAULT_RETENTION_DAYS` og `DEFAULT_SNAPSHOT_RETENTION_DAYS` fra `@jarvis/vision` (sendes inn av `main.ts`, så senteret ikke importerer visjonsmodulen). */
  defaults: { retention_days: number; snapshot_retention_days: number };
}

export const VISION_SECTION_ID = "vision";
const TITLE = "Syn og kamera";
const SOURCE = "kamerakjøretidens helsebilde (samme tall som /vision/status: kun koder, antall og tilstander) + vision_retention_policies (tenant-RLS; kun antall dager) - aldri bilder, etiketter, kameranavn eller hendelsesinnhold";
/** En lett vedlikeholdskjøring som har stått lenger enn dette er forlatt av kjøretiden selv (`LIGHT_MAINTENANCE_MAX_RUN_MS`); kortet advarer fra samme grense. */
const LIGHT_RUN_OVERDUE_MS = 30 * 60_000;
/** Den daglige fulle kjøringen: eldre enn dette (med margin for oppstartstidspunkt og skjev klokke) er forsinket. */
const FULL_RUN_STALE_MS = 36 * HOUR_MS;
/** Antall feil på rad der pollerens backoff har nådd taket (20 -> 40 -> 80 -> 160 -> 300 s): en vedvarende feilserie, ikke et sporadisk avbrudd. */
const POLLER_FAIL_SERIES = 5;

export interface VisionRetentionRow {
  memory_space: string;
  retention_days: number;
  snapshot_retention_days: number | null;
  updated_at: string | null;
}

/** Retensjonsradene for tenanten i alle minnerom UNNTATT health (isolert): kun dager og tidspunkt. RLS (tenant + minnerom) gjelder; ekte SQL bevises mot app-rollen i wpg3b-privacy-vision-db.test.ts. */
export async function readVisionRetention(pool: ControlCenterPool, tenantId: string): Promise<VisionRetentionRow[]> {
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const rows = await query(`SELECT memory_space_id, retention_days, snapshot_retention_days, updated_at FROM vision_retention_policies WHERE tenant_id = $1 ORDER BY memory_space_id`, [tenantId]);
    return rows.map((r) => ({
      memory_space: safeCategory(r["memory_space_id"]), retention_days: toInt(r["retention_days"]),
      snapshot_retention_days: r["snapshot_retention_days"] === null || r["snapshot_retention_days"] === undefined ? null : toInt(r["snapshot_retention_days"]), updated_at: toIso(r["updated_at"])
    }));
  });
}

const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
/** En kort kode (aldri fri tekst): `safeCategory` slipper kun `[A-Za-z0-9_:.-]` opptil 60 tegn gjennom, alt annet blir `annet`. `null` = ingen verdi. */
const code = (value: unknown): string | null => (typeof value === "string" && value !== "" ? safeCategory(value) : null);
/** En teller er et heltall >= 0; tekst, NaN og negative verdier fra en feilaktig kilde blir 0 (aldri tekst og aldri et negativt antall i rapporten). */
const count = (value: unknown): number => Math.max(0, toInt(value));
const days = (n: number): string => `${n} døgn`;

type MaintenanceRead = { at: string | null; failed: number; tombstones_failed: number; tombstones_stuck: number; temp_files_truncated: boolean } | null;
function maintenanceOf(value: unknown): MaintenanceRead {
  if (value === null || value === undefined) return null;
  const m = rec(value);
  return { at: toIso(m["at"]), failed: count(m["failed"]), tombstones_failed: count(m["tombstones_failed"]), tombstones_stuck: count(m["tombstones_stuck"]), temp_files_truncated: m["temp_files_truncated"] === true };
}

function pollerItem(raw: unknown, nowMs: number): ControlItem {
  const p = rec(raw);
  if (p["enabled"] !== true) {
    return controlItem({ id: "poller", label: "Kamerapoller (Home Assistant)", status: "OK", detail_no: "Av: ingen kamera leses automatisk (JARVIS_VISION_HA_POLL er ikke på).", facts: { enabled: false } });
  }
  const failures = count(p["consecutive_failures"]);
  const lastTick = toIso(p["last_tick_at"]);
  const lastStatus = code(p["last_status"]);
  const lastReason = code(p["last_reason"]);
  const sourceError = code(p["last_source_error"]);
  let status: ControlStatus = "OK";
  let detail: string;
  if (lastTick === null) {
    status = "UNKNOWN";
    detail = "På, men ingen runde er målt siden oppstart.";
  } else if (lastStatus === "blocked") {
    status = "WARN";
    detail = `Stanset (${lastReason ?? "ukjent årsak"}): ingen nye kamerahendelser leses. Siste runde ${relativeNo(lastTick, nowMs)}.`;
  } else if (failures >= POLLER_FAIL_SERIES) {
    status = "FAIL";
    detail = `${failures} runder på rad med feil${sourceError !== null ? ` (kode ${sourceError})` : ""}; neste forsøk om ${Math.round(count(p["next_delay_ms"]) / 1000)} s. Siste runde ${relativeNo(lastTick, nowMs)}.`;
  } else if (failures > 0 || sourceError !== null) {
    status = "WARN";
    detail = `${failures} feilet runde(r) på rad${sourceError !== null ? ` (kode ${sourceError})` : ""}. Siste runde ${relativeNo(lastTick, nowMs)}.`;
  } else {
    detail = `Går; siste runde ${relativeNo(lastTick, nowMs)} uten feil.`;
  }
  return controlItem({
    id: "poller", label: "Kamerapoller (Home Assistant)", status, observed_at: lastTick, detail_no: detail,
    facts: { enabled: true, last_tick_at: lastTick, last_status: lastStatus, last_reason: lastReason, last_source_error: sourceError, consecutive_failures: failures, next_delay_ms: count(p["next_delay_ms"]) }
  });
}

function maintenanceItem(id: "maintenance_light" | "maintenance_full", label: string, m: MaintenanceRead, nowMs: number): ControlItem {
  if (m === null) return controlItem({ id, label, status: "UNKNOWN", detail_no: "Ikke kjørt ennå siden oppstart.", facts: { measured: false } });
  const age = m.at === null ? null : Math.max(0, nowMs - Date.parse(m.at));
  let status: ControlStatus = "OK";
  const problems: string[] = [];
  if (m.failed > 0) { status = "FAIL"; problems.push(`${m.failed} sveipefeil`); }
  if (m.tombstones_stuck > 0) { status = "FAIL"; problems.push(`${m.tombstones_stuck} slettede bilder kan ikke fjernes fra lagringen (oppbevaringen er ikke håndhevet)`); }
  if (m.tombstones_failed > 0 && status !== "FAIL") { status = "WARN"; problems.push(`${m.tombstones_failed} bildesletting(er) feilet og prøves på nytt`); }
  if (m.temp_files_truncated) { if (status === "OK") status = "WARN"; problems.push("opprydding av skriverester ble avkortet"); }
  if (id === "maintenance_full" && age !== null && age > FULL_RUN_STALE_MS && status === "OK") { status = "WARN"; problems.push("siste kjøring er eldre enn 36 timer"); }
  return controlItem({
    id, label, status, observed_at: m.at,
    detail_no: `Siste kjøring ${relativeNo(m.at, nowMs)}: ${problems.length === 0 ? "ingen feil." : `${problems.join("; ")}.`}`,
    facts: { at: m.at, failed: m.failed, tombstones_failed: m.tombstones_failed, tombstones_stuck: m.tombstones_stuck, temp_files_truncated: m.temp_files_truncated }
  });
}

function guardItem(raw: unknown, nowMs: number): ControlItem {
  const g = rec(raw);
  const runningSince = toIso(g["running_since"]);
  const skipped = count(g["skipped_ticks"]);
  const abandoned = count(g["abandoned_runs"]);
  const overdue = runningSince !== null && nowMs - Date.parse(runningSince) >= LIGHT_RUN_OVERDUE_MS;
  const status: ControlStatus = overdue || abandoned > 0 ? "WARN" : "OK";
  return controlItem({
    id: "maintenance_guard", label: "Vedlikeholdsvakt (lett kjøring)", status,
    detail_no: abandoned > 0 ? `${abandoned} lett(e) kjøring(er) er regnet som forlatt (hengt fil- eller volumoperasjon).`
      : overdue ? `En lett kjøring har pågått siden ${relativeNo(runningSince, nowMs)} - den kan henge.`
        : `${runningSince === null ? "Ingen kjøring pågår" : "En kjøring pågår"}; ${skipped} hoppede tikk siden oppstart (kumulativt, uten betydning alene).`,
    facts: { running: runningSince !== null, running_since: runningSince, skipped_ticks: skipped, abandoned_runs: abandoned }
  });
}

function ingestItem(raw: unknown): ControlItem {
  const i = rec(raw);
  const invalid = count(i["inventory_label_invalid"]);
  const rejected = count(i["inventory_label_rejected"]);
  return controlItem({
    id: "ingest", label: "Inventarskrivinger som ble hoppet over", status: rejected > 0 ? "WARN" : "OK",
    detail_no: rejected > 0
      ? `${rejected} etikett(er) ble avvist av databasen selv om skjemaet godtok dem (drift mellom regelsettene - hendelsene er lagret, inventaret for dem mangler); ${invalid} manglet inventarform. Kumulativt siden oppstart.`
      : `${invalid} etikett(er) uten inventarform er hoppet over siden oppstart (hendelsene er lagret); ingen avvist av databasen.`,
    facts: { inventory_label_invalid: invalid, inventory_label_rejected: rejected }
  });
}

function configItem(report: Record<string, unknown>): ControlItem {
  const storage = rec(report["storage"]);
  const writing = storage["writing_enabled"] === true;
  const maintenance = storage["maintenance_enabled"] === true;
  const classifier = report["classifier"] === true;
  const embeddings = report["embeddings"] === true;
  return controlItem({
    id: "configuration", label: "Konfigurasjon (kun av/på)", status: "OK",
    detail_no: `Lokal klassifisering ${classifier ? "på" : "av"}; embeddings ${embeddings ? "på" : "av"}; bildelagring: ${writing ? "ny lagring på" : maintenance ? "ny lagring av, sletting kjører" : "ingen mappe konfigurert"}.`,
    facts: { classifier, embeddings, storage_writing: writing, storage_maintenance: maintenance }
  });
}

function statusItems(report: VisionStatusReport, nowMs: number): ControlItem[] {
  const r = rec(report);
  // En malformet kilde er «utilgjengelig», aldri et tomt «alt er av» (som ville lest som OK): de to hovedstrukturene MÅ finnes.
  if (typeof r["poller"] !== "object" || r["poller"] === null || typeof r["maintenance"] !== "object" || r["maintenance"] === null) throw new Error("vision_status_malformed");
  const maintenance = rec(r["maintenance"]);
  return [
    pollerItem(r["poller"], nowMs),
    maintenanceItem("maintenance_light", "Lett vedlikehold (bilder, gravsteiner)", maintenanceOf(maintenance["light"]), nowMs),
    maintenanceItem("maintenance_full", "Daglig fullt vedlikehold (bilder, inventar, vektorer)", maintenanceOf(maintenance["full"]), nowMs),
    guardItem(maintenance["light_run"], nowMs),
    ingestItem(r["ingest"]),
    configItem(r)
  ];
}

function retentionItems(source: PrivacyVisionSource, rows: readonly VisionRetentionRow[], nowMs: number): ControlItem[] {
  const d = { retention_days: toInt(source.defaults.retention_days), snapshot_retention_days: toInt(source.defaults.snapshot_retention_days) };
  const items: ControlItem[] = [
    controlItem({
      id: "retention_default", label: "Standard oppbevaring (uten egen innstilling)", status: "OK",
      detail_no: `Hendelser ${days(d.retention_days)}, bilder ${days(Math.min(d.snapshot_retention_days, d.retention_days))} (aldri lengre enn hendelsene).`,
      facts: { retention_days: d.retention_days, snapshot_retention_days: d.snapshot_retention_days }
    })
  ];
  const ids = new Set<string>(items.map((item) => item.id));
  for (const row of rows) {
    // Id-er i en seksjon må være unike (en kollisjon ville felt hele senteret): minnerommet er en lukket enum i databasen, men en uventet verdi får et unikt reserve-id.
    const base = `retention:${row.memory_space}`;
    let id = base;
    for (let k = 2; ids.has(id); k += 1) id = `${base}:${k}`;
    ids.add(id);
    const effective = Math.min(row.snapshot_retention_days ?? d.snapshot_retention_days, row.retention_days);
    items.push(controlItem({
      id, label: `Oppbevaring i minnerommet ${row.memory_space}`, status: "OK", observed_at: row.updated_at,
      detail_no: `Hendelser ${days(row.retention_days)}, bilder ${days(effective)}${row.snapshot_retention_days === null ? " (standard bildevindu)" : ""}; satt ${relativeNo(row.updated_at, nowMs)}.`,
      facts: { memory_space: row.memory_space, retention_days: row.retention_days, snapshot_retention_days: row.snapshot_retention_days, effective_snapshot_retention_days: effective, updated_at: row.updated_at }
    }));
  }
  return items;
}

/**
 * Bygger Syn-seksjonen. Kaster ALDRI: en uforutsett feil gir en «ikke målt»-seksjon (UNKNOWN), og en kilde som ikke kan leses gir et `Utilgjengelig`-element - aldri OK ved feil, og aldri et kastet senter.
 */
export async function buildVisionSection(args: { source: PrivacyVisionSource; pool: ControlCenterPool; tenantId: string; nowMs: number; nowIso: string }): Promise<ControlSection> {
  try {
    const { source, pool, tenantId, nowMs, nowIso } = args;
    const [statusR, policiesR] = await Promise.all([
      settle(async () => statusItems(source.status(), nowMs)),
      settle(() => readVisionRetention(pool, tenantId))
    ]);
    const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);
    if (!statusR.ok && !policiesR.ok) return unknownControlSection(VISION_SECTION_ID, TITLE, SOURCE, `utilgjengelig${failed(statusR)}`);
    const items: ControlItem[] = [];
    if (statusR.ok) items.push(...statusR.value);
    else items.push(controlItem({ id: "runtime", label: "Kamerakjøretidens helsebilde", status: "UNKNOWN", detail_no: `Utilgjengelig${failed(statusR)}: kjøretiden svarer ikke eller er ikke klar.`, facts: { measured: false } }));
    const retentionR: Settled<ControlItem[]> = policiesR.ok ? await settle(async () => retentionItems(source, policiesR.value, nowMs)) : policiesR;
    if (retentionR.ok) items.push(...retentionR.value);
    else items.push(controlItem({ id: "retention", label: "Oppbevaringsvinduer", status: "UNKNOWN", detail_no: `Utilgjengelig${failed(retentionR)}.`, facts: { measured: false } }));
    items.sort(bySeverityThenLabel);
    return controlSection({
      id: VISION_SECTION_ID, title_no: TITLE, observed_at: nowIso, items, source: SOURCE,
      summary_no: `Kun helsebilde og oppbevaringsvinduer - aldri bilder, etiketter eller kameranavn. En endring av vinduene gjelder rader som skrives etter den. ${countsNo(items)}.`
    });
  } catch {
    return unknownControlSection(VISION_SECTION_ID, TITLE, SOURCE, "utilgjengelig");
  }
}
