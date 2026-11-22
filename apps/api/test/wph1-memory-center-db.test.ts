import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { MEMORY_JOBS, createMemoryCenter, readErasure, readGovernanceJournal, readMemoryConflicts, readMemoryItems, readMemoryProvenance, readMemorySources } from "../src/control-center/memory.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H1 Memory Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - alle lesespørringene kjører med rollens faktiske GRANT-er og kolonner (minner, kilder, kunnskap, versjoner, sletting, styringsjournal med prov_*-kolonnene fra migrasjon 102);
 *  - tenant-isolasjon: A ser aldri B sine rader; health leses KUN som antall i en egen lesing;
 *  - innholdsvern: minneinnhold, emner, kildereferanser, dokumenttitler/-innhold, URI-er og beslutningstekster når aldri rapporten;
 *  - INVARIANTEN «ingen aktive minner med ubetrodd tillitsnivå» gir FAIL når den brytes;
 *  - senteret skriver ingenting.
 */
let db: H0Db;
const TENANT_A = "tenant-mem-a";
const TENANT_B = "tenant-mem-b";
const NOW = new Date();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-mem-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-mem-b", tenant_id: TENANT_B };
const HIDDEN_CONTENT = "hemmelig minneinnhold som aldri skal vises";
const HIDDEN_SUBJECT = "hemmelig-emne";
const HIDDEN_REF = "ref-hemmelig-sti/til/kilde";
const HIDDEN_TITLE = "Hemmelig dokumenttittel";
const HIDDEN_URI = "https://hemmelig.example/dokument";
const HIDDEN_RATIONALE = "hemmelig begrunnelse for beslutning";
const HIDDEN_HEALTH = "helse-hemmelighet-aldri-sammen-med-andre-rom";

const TABLES_TOUCHED = ["memory_sources", "memory_items", "memory_vectors", "memory_versions", "knowledge_documents", "erasure_requests", "erasure_fingerprints", "decision_log", "scenarios", "risks", "goals", "goal_key_results", "scheduler_state"] as const;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES_TOUCHED) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

async function seedItem(id: string, tenant: string, over: Record<string, unknown> = {}): Promise<void> {
  const r = { space: "personal", type: "semantic", status: "active", trust_level: "trusted", sensitivity: "normal", has_conflict: false, source_id: "src-a-conv", created_at: ago(H), last_accessed_at: null, ...over };
  await db.adminPool.query(
    `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, trust_level, sensitivity, status, has_conflict, created_at, last_accessed_at)
     VALUES ($1, $2, $3, 'p', $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14)`,
    [id, tenant, r.space, r.type, `${HIDDEN_SUBJECT}-${id}`, HIDDEN_CONTENT, r.source_id, ago(D), r.trust_level, r.sensitivity, r.status, r.has_conflict, r.created_at, r.last_accessed_at]
  );
}

beforeAll(async () => {
  db = await startH0Db("mem");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  await admin.query(
    `INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ('src-a-conv', $1, 'conversation', $3, 'trusted'), ('src-a-tool', $1, 'tool', $3, 'untrusted'), ('src-a-doc', $1, 'document', $3, 'internal'), ('src-b-conv', $2, 'conversation', $3, 'trusted')`,
    [TENANT_A, TENANT_B, HIDDEN_REF]
  );
  await seedItem("mi-a-1", TENANT_A, { last_accessed_at: ago(2 * H) });
  await seedItem("mi-a-2", TENANT_A, { space: "business", type: "project", trust_level: "internal", sensitivity: "sensitive", source_id: "src-a-doc" });
  await seedItem("mi-a-3", TENANT_A, { type: "preference", has_conflict: true, sensitivity: "special" });
  await seedItem("mi-a-4", TENANT_A, { type: "episodic", status: "quarantined", trust_level: "untrusted", source_id: "src-a-tool", created_at: ago(10 * D) });
  await seedItem("mi-a-5", TENANT_A, { type: "episodic", status: "quarantined", trust_level: "untrusted", source_id: "src-a-tool", created_at: ago(H) });
  await seedItem("mi-a-6", TENANT_A, { status: "invalidated" });
  await seedItem("mi-a-7", TENANT_A, { status: "superseded" });
  await seedItem("mi-a-bad", TENANT_A, { type: "operational", trust_level: "untrusted", source_id: "src-a-tool" });
  await seedItem("mi-a-health", TENANT_A, { space: "health", type: "semantic" });
  await seedItem("mi-b-1", TENANT_B, { source_id: "src-b-conv", has_conflict: true, status: "quarantined" });
  await admin.query(
    `INSERT INTO memory_vectors (ref_kind, ref_id, tenant_id, space, model, dim, embedding) VALUES ('item', 'mi-a-1', $1, 'personal', 'm', 2, '{0.1,0.2}'), ('item', 'mi-a-3', $1, 'personal', 'm', 2, '{0.1,0.2}'), ('item', 'mi-b-1', $2, 'personal', 'm', 2, '{0.1,0.2}')`,
    [TENANT_A, TENANT_B]
  );
  await admin.query(
    `INSERT INTO memory_versions (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind, changed_at) VALUES
       ('mi-a-1', $1, 'personal', 1, 's', $3, $4, $4, 'superseded', $4), ('mi-a-3', $1, 'personal', 1, 's', $3, $4, $4, 'conflict', $4), ('mi-a-3', $1, 'personal', 2, 's', $3, $4, $4, 'conflict', $5), ('mi-b-1', $2, 'personal', 1, 's', $3, $4, $4, 'invalidated', $4)`,
    [TENANT_A, TENANT_B, HIDDEN_CONTENT, ago(D), ago(60 * D)]
  );
  const doc = (id: string, tenant: string, space: string, type: string, instance: string, deleted: boolean, syncedAt: Date): Promise<unknown> =>
    admin.query(
      `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash, deleted, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $1, $6, $7, $8, 'text/plain', $1, $9, $10)`,
      [id, tenant, space, type, instance, HIDDEN_URI, HIDDEN_TITLE, HIDDEN_CONTENT, deleted, syncedAt]
    );
  await doc("kd-a-1", TENANT_A, "business", "drive", "inst-1", false, ago(H));
  await doc("kd-a-2", TENANT_A, "business", "drive", "inst-1", false, ago(2 * H));
  await doc("kd-a-3", TENANT_A, "business", "drive", "inst-2", true, ago(3 * H));
  await doc("kd-a-4", TENANT_A, "project", "obsidian", "vault", false, ago(5 * D));
  await doc("kd-a-health", TENANT_A, "health", "drive", "inst-h", false, ago(H));
  await doc("kd-b-1", TENANT_B, "business", "drive", "inst-b", false, ago(H));

  const erasure = (id: string, tenant: string, scope: string, status: string, startedAt: Date, completedAt: Date | null): Promise<unknown> =>
    admin.query(`INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status, record_counts, started_at, completed_at) VALUES ($1, $2, $3, $4::jsonb, $5, '{}'::jsonb, $6, $7)`, [id, tenant, scope, JSON.stringify({ hemmelig: HIDDEN_CONTENT }), status, startedAt, completedAt]);
  await erasure("er-a-1", TENANT_A, "person", "completed", ago(3 * D), ago(3 * D));
  await erasure("er-a-2", TENANT_A, "conversation", "failed", ago(2 * D), null);
  await erasure("er-a-3", TENANT_A, "memory_space", "pending", ago(3 * H), null);
  await erasure("er-b-1", TENANT_B, "tenant", "failed", ago(D), null);
  await admin.query(`INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id) VALUES ('fp1', $1, 'drive', 'inst-1', 'er-a-1'), ('fp2', $1, 'drive', 'inst-1', 'er-a-1'), ('fpb', $2, 'drive', 'inst-b', 'er-b-1')`, [TENANT_A, TENANT_B]);

  await admin.query(
    `INSERT INTO scheduler_state (job_name, run_date, claimed_by, claimed_at, completed_at, attempts, last_error) VALUES
       ('memory-retention-sweep', current_date, 'w1', $1, $1, 1, NULL), ('memory-reembed-sweep', current_date, 'w1', $1, NULL, 2, 'noe feilet')`,
    [ago(3 * H)]
  );

  // Styringsjournal: beslutninger (eldre uten proveniens, to med, ett HULL etter første proveniens), scenarier kun eldre, ett mål med nøkkelresultat (med proveniens)
  const decision = (id: string, tenant: string, createdAt: Date, prov: [string, string, string | null, string, Date] | null): Promise<unknown> =>
    admin.query(
      `INSERT INTO decision_log (decision_id, tenant_id, title, rationale, decision_maker, created_at, prov_channel, prov_session_id, prov_task_id, prov_origin, prov_recorded_at)
       VALUES ($1, $2, 't', $3, 'owner', $4, $5, $6, $7, $8, $9)`,
      [id, tenant, HIDDEN_RATIONALE, createdAt, prov?.[0] ?? null, prov?.[1] ?? null, prov?.[2] ?? null, prov?.[3] ?? null, prov?.[4] ?? null]
    );
  await decision("dec-a-legacy", TENANT_A, ago(20 * D), null);
  await decision("dec-a-owner", TENANT_A, ago(5 * D), ["web", "sess-1", null, "owner_direct", ago(5 * D)]);
  await decision("dec-a-model", TENANT_A, ago(4 * D), ["system", "job:t-1", "t-1", "model", ago(4 * D)]);
  await decision("dec-a-gap", TENANT_A, ago(D), null);
  await decision("dec-b-1", TENANT_B, ago(D), ["web", "sess-b", null, "unspecified", ago(D)]);
  await admin.query(`INSERT INTO scenarios (scenario_id, tenant_id, title, assumptions, projected_outcome, created_at) VALUES ('scn-a-1', $1, 't', 'a', 'p', $2)`, [TENANT_A, ago(10 * D)]);
  await admin.query(`INSERT INTO goals (goal_id, tenant_id, title, prov_channel, prov_session_id, prov_origin, prov_recorded_at) VALUES ('goal-a-1', $1, 't', 'web', 's', 'owner_direct', $2)`, [TENANT_A, ago(D)]);
  await admin.query(`INSERT INTO goal_key_results (key_result_id, goal_id, tenant_id, memory_space_id, title, prov_channel, prov_session_id, prov_origin, prov_recorded_at) VALUES ('kr-a-1', 'goal-a-1', $1, 'business', 't', 'web', 's', 'owner_direct', $2)`, [TENANT_A, ago(D)]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function center(env: Record<string, string | undefined> = {}): ReturnType<typeof createMemoryCenter> {
  return createMemoryCenter({ pool: db.appPool, env });
}
async function report(identity: IdentityContext, env: Record<string, string | undefined> = {}): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center(env));
  return (await registry.report("memory", identity)) as ControlCenterReport;
}
const sec = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;
const item = (r: ControlCenterReport, section: string, id: string) => sec(r, section).items.find((i) => i.id === id)!;

describe("lesespørringene som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("kilder: minnekilder per art/tillit, kunnskapskilder med dokumenter/tombstones/instanser, health kun som antall", async () => {
    const v = await readMemorySources(db.appPool, TENANT_A);
    expect(v.memory_sources.map((s) => `${s.kind}:${s.trust_level}:${s.n}`)).toEqual(["conversation:trusted:1", "document:internal:1", "tool:untrusted:1"]);
    expect(v.knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "drive", documents: 2, tombstoned: 1, instances: 2 }),
      expect.objectContaining({ source_type: "obsidian", documents: 1, tombstoned: 0, instances: 1 })
    ]));
    expect(v.health_knowledge_documents).toBe(1);
    expect(v.knowledge.some((k) => k.documents === 99)).toBe(false);
  });

  it("minner: status, aktive per rom/sensitivitet/type, uten vektor (kun aktive i ikke-health), siste bruk, health som antall", async () => {
    const v = await readMemoryItems(db.appPool, TENANT_A);
    expect(Object.fromEntries(v.by_status.map((s) => [s.status, s.n]))).toEqual({ active: 4, quarantined: 2, invalidated: 1, superseded: 1 });
    expect(Object.fromEntries(v.active_by_space.map((s) => [s.space, s.n]))).toEqual({ personal: 3, business: 1 });
    expect(Object.fromEntries(v.active_by_sensitivity.map((s) => [s.sensitivity, s.n]))).toEqual({ normal: 2, sensitive: 1, special: 1 });
    expect(v.active_without_vector).toBe(2); // mi-a-2 og mi-a-bad (mi-a-1/mi-a-3 har vektor; health-minnet er utenfor lesingen)
    expect(v.last_accessed_at).not.toBeNull();
    expect(v.health_items).toBe(1);
  });

  it("proveniens: aktive minner per kildeart/tillit, og brudd på «ingen ubetrodd i aktivt minne»", async () => {
    const v = await readMemoryProvenance(db.appPool, TENANT_A);
    expect(v.untrusted_active).toBe(1);
    expect(v.active_by_source).toEqual(expect.arrayContaining([
      { kind: "conversation", trust_level: "trusted", n: 2 }, { kind: "document", trust_level: "internal", n: 1 }, { kind: "tool", trust_level: "untrusted", n: 1 }
    ]));
  });

  it("konflikt og karantene: motstrid kun for aktive, karantene totalt og gamle, versjonshendelser siste 30 døgn - kun A", async () => {
    const v = await readMemoryConflicts(db.appPool, TENANT_A, NOW.getTime());
    expect(v).toMatchObject({ conflicts: 1, quarantined: 2, quarantined_stale: 1 });
    expect(v.oldest_quarantined_at).not.toBeNull();
    expect(Object.fromEntries(v.version_events_30d.map((e) => [e.change_kind, e.n]))).toEqual({ superseded: 1, conflict: 1 }); // den 60 døgn gamle versjonen og B sin er utenfor
    const b = await readMemoryConflicts(db.appPool, TENANT_B, NOW.getTime());
    expect(b).toMatchObject({ conflicts: 0, quarantined: 1 }); // B sitt motstridende minne er i karantene (ikke aktivt), og A sine tall lekker ikke inn
  });

  it("sletting: per status/omfang, feilede, fastlåste (pending over 1 time), fingeravtrykk - kun A", async () => {
    const v = await readErasure(db.appPool, TENANT_A, NOW.getTime());
    expect(v.by_status.map((g) => `${g.status}:${g.scope_type}:${g.n}`).sort()).toEqual(["completed:person:1", "failed:conversation:1", "pending:memory_space:1"]);
    expect(v).toMatchObject({ failed: 1, pending_stale: 1, fingerprints: 2 });
  });

  it("styringsjournal: totalt/med proveniens/opphav/hull etter første proveniens per type - kun A", async () => {
    const rows = await readGovernanceJournal(db.appPool, TENANT_A);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by["decision"]).toMatchObject({ total: 4, with_provenance: 2, owner_direct: 1, model: 1, unspecified: 0, gaps_after_first: 1 });
    expect(by["scenario"]).toMatchObject({ total: 1, with_provenance: 0, gaps_after_first: 0, first_recorded_at: null });
    expect(by["risk"]).toMatchObject({ total: 0 });
    expect(by["goal"]).toMatchObject({ total: 1, with_provenance: 1, owner_direct: 1, gaps_after_first: 0 });
    expect(by["key_result"]).toMatchObject({ total: 1, with_provenance: 1 });
  });
});

describe("senteret som helhet (registeret → rapport)", () => {
  it("alle sju seksjoner er målt; ingen handlinger (alt er DEFERRED/eksisterende ruter utenfor panelet)", async () => {
    const r = await report(idA);
    expect(r.center).toBe("memory");
    expect(r.sections.map((s) => s.id)).toEqual(["sources", "sync", "memories", "provenance", "conflicts", "erasure", "governance_journal"]);
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(r.actions).toEqual([]);
  });

  it("ubetrodd innhold i aktivt minne er FAIL; gammel karantene, motstrid og manglende vektorer er advarsler", async () => {
    const r = await report(idA);
    expect(item(r, "provenance", "untrusted_active")).toMatchObject({ status: "FAIL", facts: { count: 1 } });
    expect(sec(r, "provenance").status).toBe("FAIL");
    expect(item(r, "conflicts", "quarantine")).toMatchObject({ status: "WARN", facts: { quarantined: 2, stale: 1 } });
    expect(item(r, "conflicts", "conflicts").status).toBe("WARN");
    expect(item(r, "memories", "vectors")).toMatchObject({ status: "WARN", facts: { active_without_vector: 2 } });
    expect(r.status).toBe("FAIL");
  });

  it("sletting: feilet forespørsel er FAIL, fastlåst pågående er advarsel, fullført er OK", async () => {
    const r = await report(idA);
    expect(item(r, "erasure", "erasure:failed:conversation").status).toBe("FAIL");
    expect(item(r, "erasure", "erasure:pending:memory_space").status).toBe("WARN");
    expect(item(r, "erasure", "erasure:completed:person").status).toBe("OK");
    expect(item(r, "erasure", "erasure_pending_stale").status).toBe("WARN");
  });

  it("synk: utdatert kunnskapskilde er advarsel, ferske er OK; jobber uten kjøring er UKJENT (aldri OK), feilet jobb er advarsel", async () => {
    const r = await report(idA);
    expect(item(r, "sync", "sync:drive").status).toBe("OK");
    expect(item(r, "sync", "sync:obsidian").status).toBe("WARN");
    expect(item(r, "sync", "job:memory-retention-sweep").status).toBe("OK");
    expect(item(r, "sync", "job:memory-reembed-sweep").status).not.toBe("OK");
    expect(item(r, "sync", "job:memory-profile-sweep").status).toBe("UNKNOWN");
    expect(MEMORY_JOBS).toContain("memory-profile-sweep");
  });

  it("styringsjournal: hull etter første proveniens er advarsel, scenarier uten noen proveniens er advarsel (kilden er IKKE registrert), mål med proveniens er OK; flagget vises", async () => {
    const off = await report(idA);
    expect(item(off, "governance_journal", "decision")).toMatchObject({ status: "WARN", facts: { total: 4, with_provenance: 2, gaps_after_first: 1 } });
    expect(item(off, "governance_journal", "scenario").status).toBe("WARN");
    expect(item(off, "governance_journal", "scenario").detail_no).toContain("IKKE registrert");
    expect(item(off, "governance_journal", "goal").status).toBe("OK");
    expect(item(off, "governance_journal", "risk").status).toBe("OK");
    expect(item(off, "governance_journal", "provenance_writing")).toMatchObject({ status: "WARN", facts: { enabled: false } });
    const on = await report(idA, { JARVIS_GOVERNANCE_PROVENANCE: "on" });
    expect(item(on, "governance_journal", "provenance_writing")).toMatchObject({ status: "OK", facts: { enabled: true } });
    // kun den eksakte verdien «on» teller
    expect(item(await report(idA, { JARVIS_GOVERNANCE_PROVENANCE: "true" }), "governance_journal", "provenance_writing").facts).toMatchObject({ enabled: false });
  });

  it("tenant-isolasjon: B sin rapport viser kun B (egne tall), og A sin viser aldri B sine id-er", async () => {
    const a = JSON.stringify(await report(idA));
    const bReport = await report(idB);
    const b = JSON.stringify(bReport);
    for (const id of ["mi-b-1", "src-b-conv", "kd-b-1", "er-b-1", "dec-b-1", "sess-b"]) expect(a, id).not.toContain(id);
    for (const id of ["mi-a-", "src-a-", "kd-a-", "er-a-", "dec-a-", "sess-1"]) expect(b, id).not.toContain(id);
    expect(item(bReport, "conflicts", "quarantine").facts).toMatchObject({ quarantined: 1 });
    expect(item(bReport, "provenance", "untrusted_active").status).toBe("OK");
  });

  it("innholdsvern: innhold, emner, kildereferanser, titler, URI-er, begrunnelser og health-innhold når aldri rapporten", async () => {
    const text = JSON.stringify(await report(idA, { JARVIS_GOVERNANCE_PROVENANCE: "on" }));
    for (const secret of [HIDDEN_CONTENT, HIDDEN_SUBJECT, HIDDEN_REF, HIDDEN_TITLE, HIDDEN_URI, HIDDEN_RATIONALE, HIDDEN_HEALTH]) expect(text, secret).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain("hemmelig");
  });

  it("senteret skriver ingenting: radtall i alle berørte tabeller er uendret etter flere bygginger", async () => {
    const before = await counts();
    await report(idA);
    await report(idB);
    expect(await counts()).toEqual(before);
  });

  it("en kilde som svikter gir UKJENT kun for de berørte seksjonene (aldri OK, aldri hele senteret)", async () => {
    await db.adminPool.query("REVOKE SELECT ON erasure_requests FROM jarvis_app");
    try {
      const r = await report(idA);
      expect(sec(r, "erasure")).toMatchObject({ status: "UNKNOWN", measured: false });
      expect(sec(r, "memories").measured).toBe(true);
      expect(sec(r, "governance_journal").measured).toBe(true);
    } finally {
      await db.adminPool.query("GRANT SELECT ON erasure_requests TO jarvis_app");
    }
  });
});

describe("rene tilstander", () => {
  it("en tenant uten noe minne: alt er målt (0 rader); kunnskapssynk uten dokumenter og jobber uten kjøring er UKJENT - aldri «i orden»", async () => {
    await db.adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-mem-empty', 'e', 'business')");
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(center());
    const r = (await registry.report("memory", { ...idA, tenant_id: "tenant-mem-empty" })) as ControlCenterReport;
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(item(r, "sync", "knowledge_sync").status).toBe("UNKNOWN");
    expect(item(r, "memories", "status:active").facts).toMatchObject({ count: 0 });
    expect(item(r, "provenance", "untrusted_active").status).toBe("OK");
    expect(item(r, "governance_journal", "decision").status).toBe("OK");
  });
});
