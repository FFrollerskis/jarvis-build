// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlItem, controlSection, unknownControlSection,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import { jobState, readJobs, type JobRow } from "./integration.ts";
import {
  DAY_MS, HOUR_MS, NON_HEALTH_SPACES, bySeverityThenLabel, countsNo, mergeBy, relativeNo, safeCategory, settle, tenantRead, tenantSpaceRead, toInt, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H1 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - MEMORY CENTER: kilder, synk, minner, proveniens, sletting/eksport og konflikt/karantene - pluss STYRINGSJOURNALEN med proveniens (JARVIS-087 del 2).
 *
 * Kun LESING av eksisterende tabeller (008/017/018/059/068/086-088/102) - ingen nye eksterne kall, ingen skriving. Hver seksjon oppgir kilden og når den ble målt; en kilde som ikke kan leses gir
 * `UNKNOWN` (aldri «i orden»).
 *
 * INNHOLDSVERN: minneinnhold, emner, nøkkelord, kildereferanser (`memory_sources.ref`), dokumenttitler/-innhold, URI-er, beslutningstekster og begrunnelser leses ALDRI. Kun antall, kategorier
 * (type/status/rom/sensitivitet/tillitsnivå/kildeart), tidsstempler og interne id-er. `health` er isolert: leses kun som ett antall i en EGEN lesing (aldri sammen med andre rom) og listes ikke.
 *
 * INVARIANT (CLAUDE.md regel 7): aktive minner med tillitsnivå `untrusted` skal ikke finnes - ubetrodd innhold går via karantene og blir `internal` først ved eierens godkjenning. Et slikt funn er FAIL.
 *
 * DEFERRED (ikke stille utelatt): handlinger fra panelet. Godkjenn/avvis av karantene-forslag bruker dashbordets eksisterende minneforslag-rute; sletting (ErasureService) og eksport (MemoryExporter)
 * har ingen app-rute ennå (JARVIS-060) og ingen sporbar eksportlogg - eksport er derfor `ikke målt`.
 */

/** Daglige minnejobber (`DailyScheduler`): oppbevaring, re-embedding, sensitivitetsvask og profil. */
export const MEMORY_JOBS: readonly string[] = ["memory-retention-sweep", "memory-reembed-sweep", "memory-resensitize-sweep", "memory-profile-sweep"];
/** Et karantene-forslag som har ventet så lenge uten beslutning. */
export const QUARANTINE_STALE_MS = 7 * DAY_MS;
/** Kunnskapskilder synkes minst daglig; eldre enn dette er en advarsel. */
export const KNOWLEDGE_SYNC_STALE_MS = 48 * HOUR_MS;
/** En sletteforespørsel som står som «pending» så lenge er sannsynligvis død. */
export const ERASURE_PENDING_STALE_MS = HOUR_MS;
const CONFLICT_WINDOW_DAYS = 30;

const MEMORY_STATUS_NO: Readonly<Record<string, string>> = { active: "Aktive", quarantined: "I karantene (venter på deg)", invalidated: "Ugyldiggjort", superseded: "Erstattet av nyere versjon" };
const SOURCE_KIND_NO: Readonly<Record<string, string>> = { conversation: "samtale", document: "dokument", tool: "verktøy", manual: "manuell" };
const JOURNAL_KINDS: ReadonlyArray<{ kind: string; table: string; label: string }> = [
  { kind: "decision", table: "decision_log", label: "Beslutninger" }, { kind: "scenario", table: "scenarios", label: "Scenarier" },
  { kind: "risk", table: "risks", label: "Risikoer" }, { kind: "goal", table: "goals", label: "Mål" }, { kind: "key_result", table: "goal_key_results", label: "Nøkkelresultater" }
];

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (ekte SQL mot ekte tabeller - bevist som app-rolle i wph1-memory-center-db.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface MemorySourcesRead {
  memory_sources: Array<{ kind: string; trust_level: string; n: number; last_at: string | null }>;
  knowledge: Array<{ source_type: string; documents: number; tombstoned: number; instances: number; last_synced_at: string | null }>;
  health_knowledge_documents: number;
}

export async function readMemorySources(pool: ControlCenterPool, tenantId: string): Promise<MemorySourcesRead> {
  const sources = await tenantRead(pool, tenantId, (query) => query(
    `SELECT kind, trust_level, (count(*))::int AS n, max(created_at) AS last_at FROM memory_sources WHERE tenant_id = $1 GROUP BY kind, trust_level ORDER BY kind, trust_level`, [tenantId]
  ));
  const knowledge = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, (query) => query(
    `SELECT source_type, (count(*) FILTER (WHERE NOT deleted))::int AS documents, (count(*) FILTER (WHERE deleted))::int AS tombstoned,
            (count(DISTINCT source_instance_id))::int AS instances, max(last_synced_at) AS last_synced_at
       FROM knowledge_documents WHERE tenant_id = $1 GROUP BY source_type ORDER BY source_type`, [tenantId]
  ));
  const health = await tenantSpaceRead(pool, tenantId, ["health"], (query) => query(`SELECT (count(*))::int AS n FROM knowledge_documents WHERE tenant_id = $1 AND NOT deleted`, [tenantId]));
  return {
    memory_sources: sources.map((r) => ({ kind: safeCategory(r["kind"]), trust_level: safeCategory(r["trust_level"]), n: toInt(r["n"]), last_at: toIso(r["last_at"]) })),
    knowledge: mergeBy(
      knowledge.map((r) => ({
        source_type: safeCategory(r["source_type"]), documents: toInt(r["documents"]), tombstoned: toInt(r["tombstoned"]), instances: toInt(r["instances"]), last_synced_at: toIso(r["last_synced_at"])
      })),
      (k) => k.source_type,
      (a, b) => ({
        source_type: a.source_type, documents: a.documents + b.documents, tombstoned: a.tombstoned + b.tombstoned, instances: a.instances + b.instances,
        last_synced_at: a.last_synced_at === null ? b.last_synced_at : b.last_synced_at === null ? a.last_synced_at : Date.parse(a.last_synced_at) >= Date.parse(b.last_synced_at) ? a.last_synced_at : b.last_synced_at
      })
    ),
    health_knowledge_documents: toInt(health[0]?.["n"])
  };
}

export interface MemoryItemsRead {
  by_status: Array<{ status: string; n: number }>;
  active_by_space: Array<{ space: string; n: number }>;
  active_by_sensitivity: Array<{ sensitivity: string; n: number }>;
  active_by_type: Array<{ type: string; n: number }>;
  active_without_vector: number;
  last_accessed_at: string | null;
  health_items: number;
}

export async function readMemoryItems(pool: ControlCenterPool, tenantId: string): Promise<MemoryItemsRead> {
  const main = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => ({
    status: await query(`SELECT status, (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 GROUP BY status ORDER BY status`, [tenantId]),
    space: await query(`SELECT space, (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active' GROUP BY space ORDER BY space`, [tenantId]),
    sensitivity: await query(`SELECT sensitivity, (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active' GROUP BY sensitivity ORDER BY sensitivity`, [tenantId]),
    type: await query(`SELECT type, (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active' GROUP BY type ORDER BY type`, [tenantId]),
    vectors: await query(
      `SELECT (count(*))::int AS n FROM memory_items m WHERE m.tenant_id = $1 AND m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.ref_kind = 'item' AND v.ref_id = m.memory_item_id AND v.tenant_id = m.tenant_id)`, [tenantId]
    ),
    accessed: await query(`SELECT max(last_accessed_at) AS at FROM memory_items WHERE tenant_id = $1`, [tenantId])
  }));
  // health er isolert: ETT antall i en egen lesing, aldri sammen med andre rom.
  const health = await tenantSpaceRead(pool, tenantId, ["health"], (query) => query(`SELECT (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active'`, [tenantId]));
  return {
    by_status: main.status.map((r) => ({ status: safeCategory(r["status"]), n: toInt(r["n"]) })),
    active_by_space: main.space.map((r) => ({ space: safeCategory(r["space"]), n: toInt(r["n"]) })),
    active_by_sensitivity: main.sensitivity.map((r) => ({ sensitivity: safeCategory(r["sensitivity"]), n: toInt(r["n"]) })),
    active_by_type: main.type.map((r) => ({ type: safeCategory(r["type"]), n: toInt(r["n"]) })),
    active_without_vector: toInt(main.vectors[0]?.["n"]),
    last_accessed_at: toIso(main.accessed[0]?.["at"]),
    health_items: toInt(health[0]?.["n"])
  };
}

export interface ProvenanceRead {
  active_by_source: Array<{ kind: string; trust_level: string; n: number }>;
  untrusted_active: number;
}

export async function readMemoryProvenance(pool: ControlCenterPool, tenantId: string): Promise<ProvenanceRead> {
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const bySource = await query(
      `SELECT s.kind, m.trust_level, (count(*))::int AS n FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id AND s.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.status = 'active' GROUP BY s.kind, m.trust_level ORDER BY s.kind, m.trust_level`, [tenantId]
    );
    const untrusted = await query(`SELECT (count(*))::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active' AND trust_level = 'untrusted'`, [tenantId]);
    return {
      active_by_source: bySource.map((r) => ({ kind: safeCategory(r["kind"]), trust_level: safeCategory(r["trust_level"]), n: toInt(r["n"]) })),
      untrusted_active: toInt(untrusted[0]?.["n"])
    };
  });
}

export interface ConflictsRead {
  conflicts: number;
  quarantined: number;
  quarantined_stale: number;
  oldest_quarantined_at: string | null;
  version_events_30d: Array<{ change_kind: string; n: number }>;
}

export async function readMemoryConflicts(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<ConflictsRead> {
  const stale = new Date(nowMs - QUARANTINE_STALE_MS);
  const since = new Date(nowMs - CONFLICT_WINDOW_DAYS * DAY_MS);
  return tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => {
    const counts = await query(
      `SELECT (count(*) FILTER (WHERE has_conflict AND status = 'active'))::int AS conflicts,
              (count(*) FILTER (WHERE status = 'quarantined'))::int AS quarantined,
              (count(*) FILTER (WHERE status = 'quarantined' AND created_at < $2))::int AS quarantined_stale,
              min(created_at) FILTER (WHERE status = 'quarantined') AS oldest_quarantined_at
         FROM memory_items WHERE tenant_id = $1`, [tenantId, stale]
    );
    const versions = await query(`SELECT change_kind, (count(*))::int AS n FROM memory_versions WHERE tenant_id = $1 AND changed_at >= $2 GROUP BY change_kind ORDER BY change_kind`, [tenantId, since]);
    const c = counts[0] ?? {};
    return {
      conflicts: toInt(c["conflicts"]), quarantined: toInt(c["quarantined"]), quarantined_stale: toInt(c["quarantined_stale"]), oldest_quarantined_at: toIso(c["oldest_quarantined_at"]),
      version_events_30d: versions.map((r) => ({ change_kind: safeCategory(r["change_kind"]), n: toInt(r["n"]) }))
    };
  });
}

export interface ErasureRead {
  by_status: Array<{ status: string; scope_type: string; n: number; last_started_at: string | null; last_completed_at: string | null }>;
  failed: number;
  pending_stale: number;
  fingerprints: number;
}

export async function readErasure(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<ErasureRead> {
  const stale = new Date(nowMs - ERASURE_PENDING_STALE_MS);
  return tenantRead(pool, tenantId, async (query) => {
    const groups = await query(
      `SELECT status, scope_type, (count(*))::int AS n, max(started_at) AS last_started_at, max(completed_at) AS last_completed_at
         FROM erasure_requests WHERE tenant_id = $1 GROUP BY status, scope_type ORDER BY status, scope_type`, [tenantId]
    );
    const flags = await query(
      `SELECT (count(*) FILTER (WHERE status = 'failed'))::int AS failed, (count(*) FILTER (WHERE status = 'pending' AND started_at < $2))::int AS pending_stale FROM erasure_requests WHERE tenant_id = $1`,
      [tenantId, stale]
    );
    const fingerprints = await query(`SELECT (count(*))::int AS n FROM erasure_fingerprints WHERE tenant_id = $1`, [tenantId]);
    return {
      by_status: groups.map((r) => ({ status: safeCategory(r["status"]), scope_type: safeCategory(r["scope_type"]), n: toInt(r["n"]), last_started_at: toIso(r["last_started_at"]), last_completed_at: toIso(r["last_completed_at"]) })),
      failed: toInt(flags[0]?.["failed"]), pending_stale: toInt(flags[0]?.["pending_stale"]), fingerprints: toInt(fingerprints[0]?.["n"])
    };
  });
}

export interface JournalKindRead {
  kind: string;
  total: number;
  with_provenance: number;
  owner_direct: number;
  model: number;
  unspecified: number;
  /** Rader opprettet ETTER at proveniens først ble skrevet, men uten proveniens (hull: flagget ble slått av igjen, eller en vei utenom). */
  gaps_after_first: number;
  first_recorded_at: string | null;
  last_created_at: string | null;
}

/** Tabellene er faste (`JOURNAL_KINDS`) - navnene bygges aldri fra data. */
export async function readGovernanceJournal(pool: ControlCenterPool, tenantId: string): Promise<JournalKindRead[]> {
  const union = JOURNAL_KINDS.map(({ kind, table }) =>
    `SELECT '${kind}' AS kind, (count(*))::int AS total,
            (count(*) FILTER (WHERE prov_origin IS NOT NULL))::int AS with_provenance,
            (count(*) FILTER (WHERE prov_origin = 'owner_direct'))::int AS owner_direct,
            (count(*) FILTER (WHERE prov_origin = 'model'))::int AS model,
            (count(*) FILTER (WHERE prov_origin = 'unspecified'))::int AS unspecified,
            (count(*) FILTER (WHERE prov_origin IS NULL AND created_at > (SELECT min(prov_recorded_at) FROM ${table} WHERE tenant_id = $1)))::int AS gaps_after_first,
            min(prov_recorded_at) AS first_recorded_at, max(created_at) AS last_created_at
       FROM ${table} WHERE tenant_id = $1`
  ).join(" UNION ALL ");
  const rows = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, (query) => query(union, [tenantId]));
  return rows.map((r) => ({
    kind: safeCategory(r["kind"]), total: toInt(r["total"]), with_provenance: toInt(r["with_provenance"]), owner_direct: toInt(r["owner_direct"]), model: toInt(r["model"]), unspecified: toInt(r["unspecified"]),
    gaps_after_first: toInt(r["gaps_after_first"]), first_recorded_at: toIso(r["first_recorded_at"]), last_created_at: toIso(r["last_created_at"])
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface MemoryCenterDeps {
  pool: ControlCenterPool;
  /** Miljøet (kun `JARVIS_GOVERNANCE_PROVENANCE` leses - om journalen skriver proveniens). */
  env: Readonly<Record<string, string | undefined>>;
}

export function createMemoryCenter(deps: MemoryCenterDeps): ControlCenterDefinition {
  return {
    id: "memory",
    title_no: "Minne",
    description_no: "Minnekilder, synk, minner, proveniens, sletting/eksport, konflikt og karantene - og styringsjournalen med proveniens (kun lesing; ingen handlinger herfra ennå)",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [sourcesR, itemsR, provR, conflictsR, erasureR, journalR, jobsR] = await Promise.all([
        settle(() => readMemorySources(deps.pool, tenantId)),
        settle(() => readMemoryItems(deps.pool, tenantId)),
        settle(() => readMemoryProvenance(deps.pool, tenantId)),
        settle(() => readMemoryConflicts(deps.pool, tenantId, nowMs)),
        settle(() => readErasure(deps.pool, tenantId, nowMs)),
        settle(() => readGovernanceJournal(deps.pool, tenantId)),
        // `scheduler_state` er global (ingen tenant-RLS): kun jobbnavn og tidspunkt leses, aldri tenantdata.
        settle(() => readJobs(deps.pool, MEMORY_JOBS))
      ]);

      const sections: ControlSection[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Kilder
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (sourcesR.ok) {
        const v = sourcesR.value;
        const items: ControlItem[] = [];
        for (const s of v.memory_sources) {
          items.push(controlItem({
            id: `memory_source:${s.kind}:${s.trust_level}`, label: `Minnekilde: ${SOURCE_KIND_NO[s.kind] ?? s.kind} (${s.trust_level})`, status: "OK", observed_at: s.last_at,
            detail_no: `${s.n} kilder; sist registrert ${rel(s.last_at)}. Kildereferansene vises aldri.${s.trust_level === "untrusted" ? " Ubetrodd: innhold herfra går via karantene, aldri direkte til autoritativt minne." : ""}`,
            facts: { kind: s.kind, trust_level: s.trust_level, count: s.n, last_at: s.last_at }
          }));
        }
        for (const k of v.knowledge) {
          items.push(controlItem({
            id: `knowledge:${k.source_type}`, label: `Kunnskapskilde: ${k.source_type}`, status: "OK", observed_at: k.last_synced_at,
            detail_no: `${k.documents} dokumenter fra ${k.instances} kildeinstans(er)${k.tombstoned > 0 ? `, ${k.tombstoned} slettet i kilden (tombstone)` : ""}; sist synket ${rel(k.last_synced_at)}. Titler og innhold vises aldri.`,
            facts: { source_type: k.source_type, documents: k.documents, tombstoned: k.tombstoned, instances: k.instances, last_synced_at: k.last_synced_at }
          }));
        }
        if (v.health_knowledge_documents > 0) {
          items.push(controlItem({
            id: "knowledge:health", label: "Kunnskapsdokumenter i health-rommet (isolert)", status: "OK",
            detail_no: `${v.health_knowledge_documents} dokumenter i det isolerte health-rommet - kun antall, aldri listet eller sammenstilt med andre rom.`, facts: { documents: v.health_knowledge_documents }
          }));
        }
        items.sort(bySeverityThenLabel);
        const totalDocs = v.knowledge.reduce((a, k) => a + k.documents, 0);
        sections.push(controlSection({
          id: "sources", title_no: "Kilder", observed_at: nowIso, items,
          source: "memory_sources (tenant-RLS) + knowledge_documents (tenant + minnerom-RLS; ref, titler og innhold leses aldri)",
          summary_no: `${v.memory_sources.reduce((a, s) => a + s.n, 0)} minnekilder og ${totalDocs} kunnskapsdokumenter fra ${v.knowledge.length} kildetyper.`
        }));
      } else {
        sections.push(unknownControlSection("sources", "Kilder", "memory_sources + knowledge_documents (tenant + minnerom-RLS)", `kunne ikke leses${failed(sourcesR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Synk (kunnskapskilder + daglige minnejobber)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        let measured = false;
        if (sourcesR.ok) {
          measured = true;
          if (sourcesR.value.knowledge.length === 0) {
            items.push(controlItem({
              id: "knowledge_sync", label: "Kunnskapssynk", status: "UNKNOWN",
              detail_no: "Ingen kunnskapsdokument er synket. Det kan bety at kunnskapslaget er i dvale (ingen kilder konfigurert i workeren) ELLER at synken feiler - det kan ikke skilles herfra, så det er ikke «i orden». Kildekonfigurasjonen leses av worker-prosessen.",
              facts: { documents: 0 }
            }));
          }
          for (const k of sourcesR.value.knowledge) {
            const age = k.last_synced_at ? nowMs - Date.parse(k.last_synced_at) : null;
            const status: ControlStatus = k.last_synced_at === null ? "UNKNOWN" : age !== null && age > KNOWLEDGE_SYNC_STALE_MS ? "WARN" : "OK";
            items.push(controlItem({
              id: `sync:${k.source_type}`, label: `Synk: ${k.source_type}`, status, observed_at: k.last_synced_at,
              detail_no: k.last_synced_at ? `Sist synket ${rel(k.last_synced_at)}${status === "WARN" ? " - synken skal gå minst daglig; kilden kan være nede eller hoppes over" : ""}.` : "Aldri synket.",
              facts: { last_synced_at: k.last_synced_at }
            }));
          }
        }
        if (jobsR.ok) {
          measured = true;
          const byName = new Map<string, JobRow>(jobsR.value.map((j) => [j.job_name, j]));
          for (const name of MEMORY_JOBS) {
            const st = jobState(byName.get(name), nowMs);
            items.push(controlItem({ id: `job:${name}`, label: `Daglig jobb: ${name}`, status: st.status, detail_no: st.detail_no, observed_at: st.last_completed_at, facts: { last_completed_at: st.last_completed_at, lag_hours: st.lag_hours } }));
          }
        }
        items.sort(bySeverityThenLabel);
        if (measured) {
          const partial = !sourcesR.ok || !jobsR.ok;
          sections.push(controlSection({
            id: "sync", title_no: "Synk", observed_at: nowIso, items, status: partial ? "UNKNOWN" : "OK",
            source: "knowledge_documents.last_synced_at (kunnskapssynk i workeren) + scheduler_state (daglige minnejobber, siste 14 døgn)",
            summary_no: `${items.length} synk-/jobbindikatorer: ${countsNo(items)}.${partial ? ` Delvis ikke målt:${sourcesR.ok ? "" : ` kunnskapssynk${failed(sourcesR)}`}${jobsR.ok ? "" : ` daglige jobber${failed(jobsR)}`}.` : ""}`
          }));
        } else {
          sections.push(unknownControlSection("sync", "Synk", "knowledge_documents + scheduler_state", `kunne ikke leses${failed(sourcesR)}${failed(jobsR)}`));
        }
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 3. Minner
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (itemsR.ok) {
        const v = itemsR.value;
        const items: ControlItem[] = [];
        for (const status of ["active", "quarantined", "invalidated", "superseded"]) {
          const n = v.by_status.find((s) => s.status === status)?.n ?? 0;
          items.push(controlItem({ id: `status:${status}`, label: MEMORY_STATUS_NO[status] ?? status, status: "OK", detail_no: `${n} minner.`, facts: { count: n } }));
        }
        items.push(controlItem({
          id: "spaces", label: "Aktive minner per rom", status: "OK",
          detail_no: `${v.active_by_space.map((s) => `${s.space} ${s.n}`).join(", ") || "ingen"}${v.health_items > 0 ? `; health ${v.health_items} (isolert, kun antall)` : ""}.`,
          facts: { ...Object.fromEntries(v.active_by_space.map((s) => [`space_${s.space}`, s.n])), health: v.health_items }
        }));
        const sensitive = v.active_by_sensitivity.filter((s) => s.sensitivity !== "normal").reduce((a, s) => a + s.n, 0);
        items.push(controlItem({
          id: "sensitivity", label: "Sensitivitet (aktive minner)", status: "OK",
          detail_no: `${v.active_by_sensitivity.map((s) => `${s.sensitivity} ${s.n}`).join(", ") || "ingen"}. Sensitive og spesielle minner går aldri til sky-modeller (D-23).`,
          facts: { ...Object.fromEntries(v.active_by_sensitivity.map((s) => [`sensitivity_${s.sensitivity}`, s.n])), non_normal: sensitive }
        }));
        items.push(controlItem({
          id: "types", label: "Minnetyper (aktive)", status: "OK", detail_no: v.active_by_type.map((t) => `${t.type} ${t.n}`).join(", ") || "ingen",
          facts: Object.fromEntries(v.active_by_type.map((t) => [`type_${t.type}`, t.n]))
        }));
        items.push(controlItem({
          id: "vectors", label: "Gjenfinnbarhet (embedding)", status: v.active_without_vector > 0 ? "WARN" : "OK",
          detail_no: v.active_without_vector > 0
            ? `${v.active_without_vector} aktive minner har ingen vektor og finnes ikke i semantisk søk (re-embedding-jobben tar dem, eller embedding-leverandøren feiler).`
            : "Alle aktive minner har en vektor.",
          facts: { active_without_vector: v.active_without_vector }
        }));
        items.push(controlItem({
          id: "access", label: "Siste bruk av minnet", status: "OK", observed_at: v.last_accessed_at,
          detail_no: v.last_accessed_at ? `Et minne ble sist hentet ${rel(v.last_accessed_at)}.` : "Ingen minne er hentet ennå.", facts: { last_accessed_at: v.last_accessed_at }
        }));
        items.sort(bySeverityThenLabel);
        const active = v.by_status.find((s) => s.status === "active")?.n ?? 0;
        sections.push(controlSection({
          id: "memories", title_no: "Minner", observed_at: nowIso, items,
          source: "memory_items + memory_vectors (tenant + minnerom-RLS; innhold, emner og nøkkelord leses aldri; health leses som ett antall i egen lesing)",
          summary_no: `${active} aktive minner (${v.by_status.reduce((a, s) => a + s.n, 0)} totalt) i ${v.active_by_space.length} rom. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("memories", "Minner", "memory_items + memory_vectors (tenant + minnerom-RLS)", `kunne ikke leses${failed(itemsR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Proveniens (minner)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (provR.ok) {
        const v = provR.value;
        const items: ControlItem[] = v.active_by_source.map((s) => controlItem({
          id: `source:${s.kind}:${s.trust_level}`, label: `Aktive minner fra ${SOURCE_KIND_NO[s.kind] ?? s.kind} (${s.trust_level})`, status: s.trust_level === "untrusted" ? "FAIL" : "OK",
          detail_no: `${s.n} aktive minner med kilde ${SOURCE_KIND_NO[s.kind] ?? s.kind} og tillitsnivå ${s.trust_level}.`, facts: { kind: s.kind, trust_level: s.trust_level, count: s.n }
        }));
        items.push(controlItem({
          id: "untrusted_active", label: "Ubetrodd innhold i autoritativt minne (skal være 0)", status: v.untrusted_active > 0 ? "FAIL" : "OK",
          detail_no: v.untrusted_active > 0
            ? `${v.untrusted_active} aktive minner har tillitsnivå «untrusted» - ubetrodd innhold skal gå via karantene og bli «internal» først ved din godkjenning (regel 7). Dette er et brudd som må undersøkes.`
            : "Ingen aktive minner har ubetrodd tillitsnivå: ubetrodd innhold går via karantene.",
          facts: { count: v.untrusted_active }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "provenance", title_no: "Proveniens (minner)", observed_at: nowIso, items,
          source: "memory_items + memory_sources (kilde-art og tillitsnivå; tenant + minnerom-RLS; kildereferanser leses aldri)",
          summary_no: `${v.active_by_source.reduce((a, s) => a + s.n, 0)} aktive minner fordelt på ${v.active_by_source.length} kilde-/tillitskombinasjoner; ${v.untrusted_active} ubetrodde i autoritativt minne.`
        }));
      } else {
        sections.push(unknownControlSection("provenance", "Proveniens (minner)", "memory_items + memory_sources (tenant + minnerom-RLS)", `kunne ikke leses${failed(provR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 5. Konflikt og karantene
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (conflictsR.ok) {
        const v = conflictsR.value;
        const items: ControlItem[] = [
          controlItem({
            id: "quarantine", label: "Karantene (forslag som venter på din beslutning)", status: v.quarantined_stale > 0 ? "WARN" : "OK", observed_at: v.oldest_quarantined_at,
            detail_no: `${v.quarantined} minneforslag venter${v.quarantined > 0 ? `; eldste ${rel(v.oldest_quarantined_at)}` : ""}${v.quarantined_stale > 0 ? `; ${v.quarantined_stale} har ventet over ${QUARANTINE_STALE_MS / DAY_MS} døgn` : ""}. Godkjenn/avvis i dashbordets minneforslag (eksisterende rute) - ikke herfra (DEFERRED).`,
            facts: { quarantined: v.quarantined, stale: v.quarantined_stale, oldest_at: v.oldest_quarantined_at }
          }),
          controlItem({
            id: "conflicts", label: "Motstridende aktive minner", status: v.conflicts > 0 ? "WARN" : "OK",
            detail_no: v.conflicts > 0 ? `${v.conflicts} aktive minner er markert med motstrid mot en tidligere versjon - versjonert, aldri skjult.` : "Ingen aktive minner er markert med motstrid.", facts: { count: v.conflicts }
          })
        ];
        for (const e of v.version_events_30d) {
          items.push(controlItem({
            id: `versions:${e.change_kind}`, label: `Versjonshendelser siste ${CONFLICT_WINDOW_DAYS} døgn: ${e.change_kind}`, status: "OK",
            detail_no: `${e.n} versjonerte minner (${e.change_kind}) - historikken er append-only.`, facts: { change_kind: e.change_kind, count: e.n }
          }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "conflicts", title_no: "Konflikt og karantene", observed_at: nowIso, items,
          source: "memory_items (status, has_conflict) + memory_versions (append-only; tenant + minnerom-RLS)",
          summary_no: `${v.quarantined} i karantene (${v.quarantined_stale} gamle), ${v.conflicts} med motstrid.`
        }));
      } else {
        sections.push(unknownControlSection("conflicts", "Konflikt og karantene", "memory_items + memory_versions (tenant + minnerom-RLS)", `kunne ikke leses${failed(conflictsR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 6. Sletting og eksport
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (erasureR.ok) {
        const v = erasureR.value;
        const items: ControlItem[] = v.by_status.map((g) => controlItem({
          id: `erasure:${g.status}:${g.scope_type}`, label: `Sletting (${g.scope_type}): ${g.status}`, status: g.status === "failed" ? "FAIL" : g.status === "pending" ? "WARN" : "OK", observed_at: g.last_completed_at ?? g.last_started_at,
          detail_no: `${g.n} forespørsler; siste startet ${rel(g.last_started_at)}${g.last_completed_at ? `, siste fullført ${rel(g.last_completed_at)}` : ""}.`,
          facts: { status: g.status, scope_type: g.scope_type, count: g.n, last_started_at: g.last_started_at, last_completed_at: g.last_completed_at }
        }));
        if (v.pending_stale > 0) {
          items.push(controlItem({
            id: "erasure_pending_stale", label: "Sletting som står fast", status: "WARN",
            detail_no: `${v.pending_stale} sletteforespørsler har stått som «pågår» i over ${ERASURE_PENDING_STALE_MS / HOUR_MS} time - sletting er ikke bevist fullført.`, facts: { count: v.pending_stale }
          }));
        }
        items.push(controlItem({
          id: "erasure_fingerprints", label: "Slettebevis (fingeravtrykk)", status: "OK",
          detail_no: `${v.fingerprints} fingeravtrykk er lagret så slettet innhold ikke kommer tilbake ved neste synk.`, facts: { fingerprints: v.fingerprints }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "erasure", title_no: "Sletting og eksport", observed_at: nowIso, items,
          source: "erasure_requests + erasure_fingerprints (tenant-RLS; omfang og antall, aldri innhold)",
          summary_no: `${v.by_status.reduce((a, g) => a + g.n, 0)} sletteforespørsler (${v.failed} feilet, ${v.pending_stale} står fast). Slette- og eksporthandlinger finnes ikke som app-rute ennå (DEFERRED, JARVIS-060); eksport er IKKE målt (ingen eksportlogg - MemoryExporter kjøres av backupplanen).`
        }));
      } else {
        sections.push(unknownControlSection("erasure", "Sletting og eksport", "erasure_requests + erasure_fingerprints (tenant-RLS)", `kunne ikke leses${failed(erasureR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 7. Styringsjournalen (JARVIS-087 del 2): proveniens på beslutninger, risiko, mål og scenarier
      // -------------------------------------------------------------------------------------------------------------------------------------------
      const provenanceOn = deps.env["JARVIS_GOVERNANCE_PROVENANCE"] === "on";
      if (journalR.ok) {
        const rows = JOURNAL_KINDS.map(({ kind, label }) => ({ label, kind, row: journalR.value.find((r) => r.kind === kind) }));
        const items: ControlItem[] = rows.map(({ label, kind, row }) => {
          const total = row?.total ?? 0;
          const withProv = row?.with_provenance ?? 0;
          const gaps = row?.gaps_after_first ?? 0;
          const without = total - withProv;
          const status: ControlStatus = total === 0 ? "OK" : gaps > 0 ? "WARN" : withProv === 0 ? "WARN" : "OK";
          return controlItem({
            id: kind, label, status, observed_at: row?.last_created_at ?? null,
            detail_no: total === 0
              ? "Ingen poster."
              : `${total} poster: ${withProv} med proveniens (eier ${row?.owner_direct ?? 0}, modell ${row?.model ?? 0}, uspesifisert ${row?.unspecified ?? 0}), ${without} uten${withProv === 0 ? " - kilden til disse postene er IKKE registrert" : gaps > 0 ? ` - ${gaps} av dem er opprettet ETTER at proveniens først ble skrevet (hull)` : " (eldre poster fra før proveniens ble slått på)"}.`,
            facts: { total, with_provenance: withProv, without_provenance: without, owner_direct: row?.owner_direct ?? 0, model: row?.model ?? 0, unspecified: row?.unspecified ?? 0, gaps_after_first: gaps, first_recorded_at: row?.first_recorded_at ?? null }
          });
        });
        items.push(controlItem({
          id: "provenance_writing", label: "Skriving av proveniens (JARVIS_GOVERNANCE_PROVENANCE)", status: provenanceOn ? "OK" : "WARN",
          detail_no: provenanceOn ? "På: nye journalposter får kanal, sesjon, jobb-id og opphav." : "AV: nye journalposter får IKKE kilde-merking (regel 4). Slå på med JARVIS_GOVERNANCE_PROVENANCE=on.", facts: { enabled: provenanceOn }
        }));
        items.sort(bySeverityThenLabel);
        const total = rows.reduce((a, r) => a + (r.row?.total ?? 0), 0);
        const withProv = rows.reduce((a, r) => a + (r.row?.with_provenance ?? 0), 0);
        sections.push(controlSection({
          id: "governance_journal", title_no: "Styringsjournal (beslutninger, risiko, mål, scenarier)", observed_at: nowIso, items,
          source: "decision_log + scenarios + risks + goals + goal_key_results (prov_*-kolonner, migrasjon 102; tenant + minnerom-RLS; titler og begrunnelser leses aldri)",
          summary_no: `${total} journalposter, ${withProv} med registrert proveniens. Eldre poster har ingen proveniens (de bakdateres aldri). Endringer etter opprettelse spores kun via revisjonssporet (PARTIAL).`
        }));
      } else {
        sections.push(unknownControlSection("governance_journal", "Styringsjournal (beslutninger, risiko, mål, scenarier)", "decision_log + scenarios + risks + goals + goal_key_results (tenant + minnerom-RLS)", `kunne ikke leses${failed(journalR)}`));
      }

      return { sections, actions: [] };
    }
  };
}
