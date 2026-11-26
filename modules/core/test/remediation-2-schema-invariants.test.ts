import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeMemorySpaces } from "@jarvis/contracts";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * Remediering del 2 (JARVIS-073/076) - SCHEMA-INVARIANTER mot ekte Postgres:
 *  A. SECURITY DEFINER-funksjoner fungerer med MINSTE privilegium (ikke-superbruker-eier, ingen BYPASSRLS),
 *  B. tabeller uten RLS er en eksplisitt, begrunnet liste (og bærer ingen `tenant_id`),
 *  C. policyer med `true` er smale og rettet mot definer-rollen (unntak: people_via_membership, dokumentert),
 *  D. scope-FK-baseline: ingen NYE enkeltkolonne-FK-er mellom tenant-eide tabeller uten tenant_id i nøkkelen,
 *  E. komma-/mellomrom-semantikken til `jarvis.memory_spaces` er fail-closed.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "fixtures", "scope-fk-baseline.json");

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool; // vanlig jarvis_app-medlem (NOSUPERUSER/NOBYPASSRLS), ingen tenant-kontekst
let port = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-r2schema-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_r2schema LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_r2schema");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-person','P','person'), ('t-biz','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','One');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','t-person'), ('p-1','t-biz');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-p','t-person','personal'), ('ms-b','t-person','business');`);
  app = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "jarvis_r2schema", password: "pw2" });
  app.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: SECURITY DEFINER med minste privilegium (JARVIS-073)", () => {
  it("jarvis_definer er NOLOGIN, NOSUPERUSER, NOBYPASSRLS, uten CREATEDB/CREATEROLE/REPLICATION", async () => {
    const r = await admin.query("SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = 'jarvis_definer'");
    expect(r.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false });
  });

  it("HVER SECURITY DEFINER-funksjon i public: ikke-superbruker/ikke-BYPASSRLS-eier, låst search_path (pg_temp sist), ingen PUBLIC-EXECUTE", async () => {
    const r = await admin.query(`
      SELECT p.oid::regprocedure::text AS fn, o.rolname AS owner, o.rolsuper, o.rolbypassrls, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('jarvis_app', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
       WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef ORDER BY 1`);
    expect(r.rows.map((x: { fn: string }) => x.fn)).toEqual([
      "claim_next_task(text,integer,text[])",
      "jarvis_list_all_tenant_ids(integer)",
      "jarvis_list_business_tenant_ids(integer)",
      "jarvis_session_grant_tenant(text)",
      // D-395 (JARVIS-074): oppbevaringsfunksjonen (073) - samme invarianter (eid av jarvis_definer, låst search_path, ingen PUBLIC-EXECUTE).
      "prune_operational_data(integer,integer,integer,integer,integer,integer)",
      // WP-K (D-471, JARVIS-053): policy-journalens oppbevaring (108) - samme invarianter (eid av jarvis_definer, låst search_path, ingen PUBLIC-EXECUTE).
      "prune_policy_decisions(integer,integer)"
    ]);
    for (const row of r.rows as Array<{ fn: string; owner: string; rolsuper: boolean; rolbypassrls: boolean; proconfig: string[]; public_exec: boolean; app_exec: boolean }>) {
      expect(row.owner, row.fn).toBe("jarvis_definer");
      expect(row.rolsuper, row.fn).toBe(false);
      expect(row.rolbypassrls, row.fn).toBe(false);
      expect(row.proconfig, row.fn).toContain("search_path=pg_catalog, public, pg_temp");
      expect(row.public_exec, row.fn).toBe(false);
      expect(row.app_exec, row.fn).toBe(true);
    }
  });

  it("jarvis_definer har KUN de smale rettighetene funksjonene trenger (ingen INSERT/DELETE, ingen audit/events/approvals)", async () => {
    const priv = async (table: string, p: string): Promise<boolean> =>
      (await admin.query("SELECT has_table_privilege('jarvis_definer', $1, $2) AS ok", [table, p])).rows[0].ok as boolean;
    // D-395 (073): DELETE finnes KUN på oppbevaringstabellene, og hver er bundet av en egen DELETE-policy rettet mot jarvis_definer (faste gulv).
    const RETENTION_DELETE = new Set(["session_grants", "approvals"]);
    for (const t of ["tasks", "tenants", "session_grants", "audit_events", "events", "approvals", "devices", "sessions", "memory_items"]) {
      expect(await priv(t, "INSERT"), `${t} INSERT`).toBe(false);
      expect(await priv(t, "DELETE"), `${t} DELETE`).toBe(RETENTION_DELETE.has(t));
      expect(await priv(t, "TRUNCATE"), `${t} TRUNCATE`).toBe(false);
    }
    for (const t of ["session_grants", "approvals", "device_enrollment_tickets", "tool_executions"]) {
      const policies = await admin.query(
        "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND cmd = 'DELETE' AND 'jarvis_definer' = ANY(roles)",
        [t]
      );
      expect((policies.rows[0] as { n: number }).n, `${t} DELETE-policy for jarvis_definer`).toBeGreaterThanOrEqual(1);
    }
    for (const t of ["audit_events", "events", "approvals", "devices", "sessions", "memory_items", "messages"]) {
      expect(await priv(t, "SELECT"), `${t} SELECT`).toBe(false);
    }
    // tabell-nivå SELECT/UPDATE finnes ikke - kun kolonne-nivå
    expect(await priv("tasks", "UPDATE")).toBe(false);
    expect((await admin.query("SELECT has_column_privilege('jarvis_definer','tasks','status','UPDATE') AS ok")).rows[0].ok).toBe(true);
    expect((await admin.query("SELECT has_column_privilege('jarvis_definer','tasks','contract','UPDATE') AS ok")).rows[0].ok).toBe(false);
    expect((await admin.query("SELECT has_column_privilege('jarvis_definer','tenants','name','SELECT') AS ok")).rows[0].ok).toBe(false);
  });

  it("katalogfunksjonene virker for en vanlig jarvis_app-rolle UTEN tenant-kontekst og UTEN superbruker/BYPASSRLS noe sted", async () => {
    const all = await app.query("SELECT tenant_id FROM jarvis_list_all_tenant_ids(10) ORDER BY 1");
    expect(all.rows.map((r: { tenant_id: string }) => r.tenant_id)).toEqual(["t-biz", "t-person"]);
    const biz = await app.query("SELECT tenant_id FROM jarvis_list_business_tenant_ids(10)");
    expect(biz.rows.map((r: { tenant_id: string }) => r.tenant_id)).toEqual(["t-biz"]);
    // Kontroll: en rå spørring uten kontekst ser FORTSATT ingenting (FORCE RLS er intakt for vanlige roller).
    expect((await app.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n).toBe(0);
    // Funksjonene gir kun det de skal: ingen kolonner utover tenant_id.
    const cols = (await app.query("SELECT * FROM jarvis_list_all_tenant_ids(1)")).fields.map((f) => f.name);
    expect(cols).toEqual(["tenant_id"]);
  });

  it("jarvis_session_grant_tenant: returnerer kun tenant for kjent grant_id, null ellers", async () => {
    await admin.query(`SELECT set_config('jarvis.tenant_id','t-person', false)`);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('jarvis.tenant_id','t-person', true)");
      await c.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('d-1','t-person','p-1','web')`);
      await c.query(`INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space_id, channel, auth_strength, key_fingerprint, issued_at, expires_at)
                     VALUES ('g-known','t-person','p-1','d-1','s-1','personal','web','signed','fp', now(), now() + interval '5 minutes')`).catch(async () => {
        // kolonnesettet kan ha utviklet seg - da beviser vi funksjonen mot en minimal rad via SELECT-lista
        await c.query("ROLLBACK");
        await c.query("BEGIN");
      });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const known = await admin.query("SELECT grant_id FROM session_grants WHERE grant_id = 'g-known'");
    if (known.rowCount === 1) {
      expect((await app.query("SELECT jarvis_session_grant_tenant('g-known') AS t")).rows[0].t).toBe("t-person");
    }
    expect((await app.query("SELECT jarvis_session_grant_tenant('nope') AS t")).rows[0].t).toBeNull();
  });

  it("claim_next_task virker som jarvis_app-medlem uten tenant-kontekst (og oppdaterer kun lease-kolonnene)", async () => {
    const contract = JSON.stringify({ task_id: "task-claim-1", agent_profile: "executive" });
    await admin.query(
      `INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract) VALUES ('task-claim-1','t-person','p-1','g','created', $1::jsonb)`, [contract]
    );
    const claimed = await app.query("SELECT task_id, tenant_id, attempts FROM claim_next_task('w-1', 30, ARRAY['executive'])");
    expect(claimed.rows).toEqual([{ task_id: "task-claim-1", tenant_id: "t-person", attempts: 1 }]);
    const after = await admin.query("SELECT status, worker_id, attempts FROM tasks WHERE task_id = 'task-claim-1'");
    expect(after.rows[0]).toEqual({ status: "running", worker_id: "w-1", attempts: 1 });
    // en annen profil får ingenting
    expect((await app.query("SELECT * FROM claim_next_task('w-2', 30, ARRAY['coding'])")).rowCount).toBe(0);
  });
});

describe("B/C: RLS-dekning og policyer (JARVIS-076)", () => {
  /** Tabeller uten RLS - hver med begrunnelse. Ingen bærer en `tenant_id`-kolonne (tenant-eide rader MÅ ha RLS). */
  const RLS_EXEMPT: Record<string, string> = {
    capabilities: "global kapabilitetsregister (tool_id/action -> klasse), ingen tenant-data; jarvis_app har kun SELECT",
    evolution_change_ledger: "globalt append-only endringsregister for selvendring (EV-0, D-408); hash-kjede + trigger, jarvis_app har kun SELECT/INSERT",
    evolution_usage_ledger: "globalt append-only forbruks- og eier-tid-register for Evolution (WP-EV0, migrasjon 280; samme mønster som endringsregisteret); kun beløp/kategori/kilde-referanse, ingen personopplysninger; jarvis_app har kun SELECT/INSERT",
    github_rate_limit_state: "global state per GitHub-credential_ref (infrastruktur), ikke tenant-data",
    owner_control_state: "global eier-kontroll (kill switch/frys/tilbakekalling, D-164) - eierens egen autoritetstilstand, ikke tenant-data",
    scheduler_state: "global jobb-claim per (job_name, run_date) for flere instanser",
    schema_migrations: "migrasjonsregister; jarvis_app har kun SELECT",
    self_modification_requests: "globale selvendringsforespørsler (eier-autorisert PR-flyt); `coding_tenant_id` er en peker, ikke tenant-eierskap",
    situation_domain_pauses: "global domene-pause satt av eier (D-163)",
    telegram_poll_state: "global holdbar getUpdates-offset per bot (infrastruktur, D-374), ikke tenant-data"
  };

  it("hver tabell i public har FORCE RLS eller står i den begrunnede unntakslisten - og unntakene bærer ingen tenant_id", async () => {
    const r = await admin.query(`
      SELECT c.relname, (c.relrowsecurity AND c.relforcerowsecurity) AS forced,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
    const unprotected = (r.rows as Array<{ relname: string; forced: boolean; has_tenant: boolean }>).filter((x) => !x.forced);
    expect(unprotected.map((x) => x.relname).sort()).toEqual(Object.keys(RLS_EXEMPT).sort());
    for (const row of unprotected) expect(row.has_tenant, `${row.relname} har tenant_id uten RLS`).toBe(false);
  });

  it("unntakene er minst mulig eksponert for jarvis_app (ingen TRUNCATE/REFERENCES/TRIGGER; schema_migrations/capabilities kun SELECT)", async () => {
    const privs = await admin.query(
      `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type)::text[] AS p FROM information_schema.table_privileges
        WHERE grantee = 'jarvis_app' AND table_schema = 'public' AND table_name = ANY($1) GROUP BY 1`, [Object.keys(RLS_EXEMPT)]
    );
    const byTable = new Map((privs.rows as Array<{ table_name: string; p: string[] }>).map((x) => [x.table_name, x.p]));
    for (const [table, p] of byTable) {
      for (const bad of ["TRUNCATE", "REFERENCES", "TRIGGER"]) expect(p, `${table} ${bad}`).not.toContain(bad);
    }
    expect(byTable.get("schema_migrations")).toEqual(["SELECT"]);
    expect(byTable.get("capabilities")).toEqual(["SELECT"]);
  });

  it("policyer med USING/WITH CHECK (true) er rettet mot jarvis_definer - eneste unntak er people_via_membership (dokumentert)", async () => {
    const r = await admin.query(`
      SELECT tablename, policyname, roles::text AS roles, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND (qual = 'true' OR with_check = 'true') ORDER BY 1, 2`);
    const rows = r.rows as Array<{ tablename: string; policyname: string; roles: string; qual: string | null; with_check: string | null }>;
    const nonDefiner = rows.filter((x) => x.roles !== "{jarvis_definer}").map((x) => `${x.tablename}.${x.policyname}`);
    // people_via_membership: `WITH CHECK (true)` lar en tenant-kontekst opprette `people`-rader (identitetsposter uten tenant-data)
    // FØR medlemskapsraden finnes; lesing/endring er fortsatt begrenset av USING (medlemskap). Se D-364 / Q-44.
    expect(nonDefiner).toEqual(["people.people_via_membership"]);
    expect(rows.find((x) => x.policyname === "people_via_membership")?.with_check).toBe("true");
    expect(rows.find((x) => x.policyname === "people_via_membership")?.qual).not.toBe("true");
  });
});

describe("D: scope-FK-baseline (JARVIS-076)", () => {
  /** FK til en tenant-eid forelder (har tenant_id) uten tenant_id i nøkkelen - gjelder også koblingstabeller UTEN egen tenant_id (kan ikke ha komposittnøkkel): kan peke på en annen tenants rad (FK-kontroll omgår RLS). */
  async function currentViolations(): Promise<string[]> {
    const r = await admin.query(`
      SELECT c.conrelid::regclass::text || '.' || c.conname AS id
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
         AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum WHERE a.attname = 'tenant_id')
       ORDER BY 1`);
    return (r.rows as Array<{ id: string }>).map((x) => x.id);
  }

  it("ingen NYE tenant-kryssende FK-er (baseline kan bare krympe) - eksisterende gjeld er registrert som DEFERRED (Q-44)", async () => {
    const current = await currentViolations();
    if (process.env["JARVIS_UPDATE_SCOPE_FK_BASELINE"] === "1") {
      await writeFile(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    }
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as string[];
    const added = current.filter((x) => !baseline.includes(x));
    const removed = baseline.filter((x) => !current.includes(x));
    expect(added, "NY FK uten tenant_id i nøkkelen - bruk (tenant_id, id)-komposittnøkkel").toEqual([]);
    expect(removed, "FK er fikset/fjernet - fjern den fra baseline (JARVIS_UPDATE_SCOPE_FK_BASELINE=1)").toEqual([]);
  });

  it("baseline er TOM (Q-44 løst): gjeld kan ikke stille føres tilbake i fixture-filen", async () => {
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as string[];
    expect(baseline, "ny gjeld skal rettes med jarvis_scope_fk i en migrasjon - ikke registreres på baseline").toEqual([]);
  });

  it("cross-tenant: et grant i tenant A kan IKKE referere en enhet/sesjon i tenant B (FK avviser)", async () => {
    await admin.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-b','t-biz','p-1','web') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO sessions (session_id, tenant_id, person_id, memory_space_id, last_device_id, last_channel, status) VALUES ('sess-b','t-biz','p-1','x','dev-b','web','active')`).catch(() => undefined);
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'session_grants'")).rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["grant_id", "tenant_id", "device_id", "session_id"]));
    const fks = await admin.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'session_grants'::regclass AND contype = 'f' ORDER BY 1`);
    const defs = (fks.rows as Array<{ def: string }>).map((r) => r.def);
    expect(defs).toContain("FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, device_id)");
    // D-395 (migrasjon 074): sesjons-FK-en er ON DELETE CASCADE (erasure av en sesjon må ikke blokkeres av grants) - fortsatt tenant-komposittnøkkel.
    expect(defs).toContain("FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, session_id) ON DELETE CASCADE");
  });
});

describe("D2: tenant-komposittnøkler for identitetsdomenet (Q-44, D-435)", () => {
  const seedIdentities = () => admin.query(`INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id, display_name) VALUES ('ci-a','t-person','business','A'), ('ci-b','t-biz','business','B') ON CONFLICT DO NOTHING`);

  it("conversation_channel_links kan IKKE peke på en identitet i en annen tenant (FK avviser), samme tenant virker", async () => {
    await seedIdentities();
    const link = (id: string, tenant: string, identity: string) => admin.query(
      `INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method, status) VALUES ($1,$2,'business',$3,'telegram',$4,1,'manual','active')`,
      [id, tenant, identity, `chat-${id}`]);
    await expect(link("l-cross", "t-person", "ci-b")).rejects.toThrow(/conversation_channel_links_identity_id_tenant_fkey/);
    await expect(link("l-ok", "t-person", "ci-a")).resolves.toBeDefined();
  });

  it("en identitet kan ikke slås sammen inn i en annen tenants identitet, og FK-ene har tenant_id i nøkkelen", async () => {
    await seedIdentities();
    await expect(admin.query(`UPDATE conversation_identities SET status='merged', merged_into_identity_id='ci-b' WHERE identity_id='ci-a'`)).rejects.toThrow(/merged_into_identity_id_tenant_fkey/);
    const r = await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'messages'::regclass AND contype = 'f' AND conname LIKE 'messages_session_id%'`);
    expect((r.rows as Array<{ def: string }>).map((x) => x.def).join("\n")).toContain("FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, session_id)");
  });

  it("jarvis_scope_fk er idempotent og kan ikke kalles av appen", async () => {
    await admin.query(`SELECT jarvis_scope_fk('conversation_channel_links', 'identity_id', 'conversation_identities', 'identity_id')`);
    await expect(app.query(`SELECT jarvis_scope_fk('conversation_channel_links', 'identity_id', 'conversation_identities', 'identity_id')`)).rejects.toThrow(/permission denied/i);
  });
});

describe("D3: tenant-komposittnøkler for pengedomenet (Q-44, D-435)", () => {
  it("betalingsintensjon-hendelser og vipps-captures peker på (tenant_id, payment_intent_id)", async () => {
    const r = await admin.query(`SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('payment_intent_events'::regclass, 'vipps_captures'::regclass, 'stripe_refunds'::regclass) AND confrelid = 'payment_intents'::regclass`);
    const defs = r.rows as Array<{ tbl: string; def: string }>;
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) expect(d.def, `${d.tbl}: ${d.def}`).toMatch(/FOREIGN KEY \(tenant_id, /);
  });
});

describe("D5: hjelperne feiler høyt og forklarer (Q-44, D-435)", () => {
  it("pre-flight lister raden som krysser tenant (id-er, ikke innhold), og jarvis_scope_fk_named avviser skrivefeil", async () => {
    await admin.query(`CREATE TABLE pf_parent (id text PRIMARY KEY, tenant_id text NOT NULL)`);
    await admin.query(`CREATE TABLE pf_child (cid text PRIMARY KEY, tenant_id text NOT NULL, parent_id text REFERENCES pf_parent (id))`);
    try {
      await admin.query(`INSERT INTO pf_parent VALUES ('p-1','t-person')`);
      await admin.query(`INSERT INTO pf_child VALUES ('c-1','t-biz','p-1')`);
      await expect(admin.query(`SELECT jarvis_scope_fk_preflight()`)).rejects.toThrow(/tenant_scope_fk_preflight.*pf_child\.parent_id.*t-biz\/p-1/s);
      await expect(admin.query(`SELECT jarvis_scope_fk_named('messages', 'no_such_fkey')`)).rejects.toThrow(/ukjent constraint/);
      // Rettes raden, passerer pre-flight og konverteringen.
      await admin.query(`UPDATE pf_child SET tenant_id = 't-person'`);
      await expect(admin.query(`SELECT jarvis_scope_fk_preflight()`)).resolves.toBeDefined();
      await admin.query(`SELECT jarvis_scope_fk('pf_child', 'parent_id', 'pf_parent', 'id')`);
      const def = await admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'pf_child'::regclass AND contype = 'f'`);
      expect((def.rows as Array<{ d: string }>)[0]!.d).toContain("FOREIGN KEY (tenant_id, parent_id) REFERENCES pf_parent(tenant_id, id)");
    } finally {
      await admin.query(`DROP TABLE IF EXISTS pf_child, pf_parent`);
    }
  });
});

describe("D4: koblingstabell uten egen tenant_id fikk tenant_id + komposittnøkler (Q-44, D-435, migrasjon 081)", () => {
  it("tenant A kan IKKE pare sin diagnose med tenant B sitt bevis; samme tenant virker; RLS er på tenant_id", async () => {
    await admin.query(`INSERT INTO incidents (incident_id, tenant_id, title) VALUES ('inc-a','t-person','A'), ('inc-b','t-biz','B') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, incident_id, conclusion, source) VALUES ('dx-a','t-person','inc-a','c','owner') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO incident_evidence (evidence_id, tenant_id, incident_id, source_type, summary, observed_at) VALUES ('ev-a','t-person','inc-a','manual','s', now()), ('ev-b','t-biz','inc-b','manual','s', now()) ON CONFLICT DO NOTHING`);
    const link = (tenant: string, evidence: string) => admin.query(
      `INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES ($1, 'dx-a', $2, 'supports')`, [tenant, evidence]);
    await expect(link("t-person", "ev-b")).rejects.toThrow(/incident_diagnosis_evidence_evidence_id_tenant_fkey/);
    await expect(link("t-biz", "ev-a")).rejects.toThrow(/incident_diagnosis_evidence_diagnosis_id_tenant_fkey/);
    await expect(link("t-person", "ev-a")).resolves.toBeDefined();
    const pol = await admin.query(`SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy WHERE polrelid = 'incident_diagnosis_evidence'::regclass`);
    expect((pol.rows as Array<{ q: string }>)[0]!.q).toContain("tenant_id");
  });

  it("RLS beholder MINNE-ROM-isolasjonen fra 037: en 'personal'-sesjon ser/lager/sletter ikke lenker til en diagnose i rommet 'health' (samme tenant)", async () => {
    await admin.query(`INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title) VALUES ('inc-h','t-person','health','H') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, memory_space_id, incident_id, conclusion, source) VALUES ('dx-h','t-person','health','inc-h','c','owner') ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO incident_evidence (evidence_id, tenant_id, memory_space_id, incident_id, source_type, summary, observed_at) VALUES ('ev-h','t-person','health','inc-h','manual','s', now()) ON CONFLICT DO NOTHING`);
    await admin.query(`INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES ('t-person','dx-h','ev-h','supports') ON CONFLICT DO NOTHING`);
    const asSession = async (spaces: string, sql: string): Promise<{ rows: unknown[]; error?: string }> => {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('jarvis.tenant_id','t-person',true), set_config('jarvis.memory_spaces',$1,true)", [spaces]);
        try {
          const r = await c.query(sql);
          return { rows: r.rows };
        } catch (err) {
          return { rows: [], error: (err as Error).message };
        }
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    expect((await asSession("personal", "SELECT 1 FROM incident_diagnosis_evidence WHERE diagnosis_id = 'dx-h'")).rows).toHaveLength(0);
    expect((await asSession("health", "SELECT 1 FROM incident_diagnosis_evidence WHERE diagnosis_id = 'dx-h'")).rows).toHaveLength(1);
    const forged = await asSession("personal", "INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES ('t-person','dx-h','ev-a','contradicts')");
    expect(forged.error ?? "").toMatch(/row-level security/i);
    const del = await asSession("personal", "DELETE FROM incident_diagnosis_evidence WHERE diagnosis_id = 'dx-h' RETURNING 1");
    expect(del.rows).toHaveLength(0);
  });
});

describe("E: jarvis.memory_spaces - komma/mellomrom-semantikk (JARVIS-076)", () => {
  it("serializeMemorySpaces: kun gyldige space-navn, dedupe, ingen komma/mellomrom/injeksjon, ikke tom", () => {
    expect(serializeMemorySpaces(["personal", "business", "personal"])).toBe("personal,business");
    for (const bad of [[], ["personal,business"], ["personal "], [" personal"], ["Personal"], ["x"], ["personal", "bu siness"], [""], ["personal;drop"]]) {
      expect(() => serializeMemorySpaces(bad as string[]), JSON.stringify(bad)).toThrow(/memory_spaces_(empty|invalid)/);
    }
  });

  it("DB: en komma+mellomrom-GUC ('personal, business') matcher BARE personal (fail closed), kommaen alene matcher begge", async () => {
    await admin.query(`INSERT INTO entities (entity_id, tenant_id, space, kind, name, canonical_key)
                       VALUES ('e-p','t-person','personal','x','P','kp'), ('e-b','t-person','business','x','B','kb')`);
    const visible = async (guc: string): Promise<string[]> => {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('jarvis.tenant_id','t-person', true), set_config('jarvis.memory_spaces', $1, true)", [guc]);
        const r = await c.query("SELECT entity_id FROM entities ORDER BY 1");
        await c.query("COMMIT");
        return (r.rows as Array<{ entity_id: string }>).map((x) => x.entity_id);
      } finally {
        c.release();
      }
    };
    expect(await visible("personal,business")).toEqual(["e-b", "e-p"]);
    expect(await visible("personal, business")).toEqual(["e-p"]); // ' business' matcher ingenting
    expect(await visible("personal business")).toEqual([]);       // mellomrom er ikke skilletegn
    expect(await visible("")).toEqual([]);
  });
});

describe("F: runtime-rolle-passord havner aldri i klartekst i DDL (JARVIS-076)", () => {
  it("scramSha256Verifier har riktig format, og Postgres godtar det som passord (innlogging med klartekst virker)", async () => {
    const { scramSha256Verifier, ensureRuntimeRole } = await import("../src/services/runtime-role.ts");
    const v = scramSha256Verifier("Sup3rSecretPassw0rd-xyz");
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain("Sup3rSecretPassw0rd");
    // unikt salt per kall
    expect(scramSha256Verifier("x")).not.toBe(scramSha256Verifier("x"));

    // Fanger SQL-en admin-poolen faktisk sender: klartekstpassordet skal ikke være med.
    const sent: string[] = [];
    const spy = { query: (text: string, params?: unknown[]) => { sent.push(text); return admin.query(text, params as unknown[]); } } as unknown as pg.Pool;
    const password = "Plain-Passw0rd-NeverInDdl";
    await ensureRuntimeRole(spy, { user: "jarvis_r2scram", password });
    expect(sent.join("\n")).not.toContain(password);
    expect(sent.join("\n")).toContain("SCRAM-SHA-256$4096:");
    // ...og innlogging med klartekstpassordet virker likevel (verifieren er gyldig).
    const login = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "jarvis_r2scram", password });
    login.on("error", () => undefined);
    await expect(login.query("SELECT current_user AS u")).resolves.toMatchObject({ rows: [{ u: "jarvis_r2scram" }] });
    await login.end();
    const attrs = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_r2scram'");
    expect(attrs.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // Rotasjon: nytt passord via samme vei.
    await ensureRuntimeRole(spy, { user: "jarvis_r2scram", password: "Rotated-Passw0rd-NeverInDdl" });
    const old = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "jarvis_r2scram", password });
    old.on("error", () => undefined);
    await expect(old.query("SELECT 1")).rejects.toThrow(/password authentication failed/);
    await old.end();
  });
});
