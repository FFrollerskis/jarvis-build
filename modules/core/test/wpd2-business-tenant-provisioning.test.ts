import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  BusinessTenantProvisioningError, createPool, deriveBusinessTenantSlug, listBusinessTenantIds, normalizeBusinessTenantName, ownerActionsFor,
  previewBusinessTenant, provisionBusinessTenant, runMigrations, withTenantTransaction
} from "../src/index.ts";

/**
 * WP-D2 (JARVIS-044, Q-44/Q-48): eier-initiert, idempotent bedrifts-tenant-provisjonering - mot EKTE Postgres og som APP-ROLLE (NOSUPERUSER/NOBYPASSRLS).
 *  A. ren plan: slug-utledning (norske tegn), streng validering, injeksjon/kontrolltegn.
 *  B. provisjonering som app-rolle: tenant + 2 spaces + medlemskap + 2 audit-rader; sveipenes katalog finner den; fremmed kontekst ser 0 rader.
 *  C. idempotens: samme kall to ganger og to SAMTIDIGE kall gir nøyaktig én tenant uten duplikater.
 *  D. konflikter (samme id annen type / annet navn) endrer ingenting; ukjent eier-person ruller HELE transaksjonen tilbake.
 *  E. admin-veien (CLI) virker, og rapporten sier ærlig at RLS ikke håndheves for den rollen.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

const OWNER_TENANT = "tenant-wpd2-owner";
const OWNER_PERSON = "person-wpd2-owner";
const owner = { owner_person_id: OWNER_PERSON, owner_tenant_id: OWNER_TENANT };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-prov-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_prov LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_prov");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_prov", password: "pw2" });
  // Speiler `seedOwner()`: person-tenant + eier + medlemskap + personal-space. INGEN bedrifts-tenant (det er hele poenget).
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${OWNER_TENANT}', 'Eier', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER_PERSON}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER_PERSON}', '${OWNER_TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpd2-owner-personal', '${OWNER_TENANT}', 'personal');
  `);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

async function rowsFor(tenantId: string): Promise<{ tenants: number; spaces: string[]; members: string[] }> {
  const t = await admin.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [tenantId]);
  const s = await admin.query("SELECT space FROM memory_spaces WHERE tenant_id = $1 ORDER BY space", [tenantId]);
  const m = await admin.query("SELECT person_id || ':' || role AS pr FROM person_tenants WHERE tenant_id = $1 ORDER BY 1", [tenantId]);
  return { tenants: (t.rows[0] as { n: number }).n, spaces: s.rows.map((r: { space: string }) => r.space), members: m.rows.map((r: { pr: string }) => r.pr) };
}

describe("A: ren plan (ingen DB)", () => {
  it("slug utledes deterministisk med norske tegn; tenant_id får prefikset `tenant-`", () => {
    expect(previewBusinessTenant({ name: "Kundeoppfølging AS" })).toMatchObject({ slug: "kundeoppfolging-as", tenant_id: "tenant-kundeoppfolging-as", kind: "business", memory_spaces: ["business", "project"], owner_role: "owner" });
    expect(deriveBusinessTenantSlug("Ærlig Åse & Øyvind")).toBe("aerlig-ase-oyvind");
    expect(deriveBusinessTenantSlug("  Café   Crème!!  ")).toBe("cafe-creme");
    expect(previewBusinessTenant({ name: "Kundeoppfølging AS", slug: "kundeoppfolging" }).tenant_id).toBe("tenant-kundeoppfolging");
    // samme navn gir ALLTID samme id (grunnlaget for idempotens)
    expect(previewBusinessTenant({ name: "  Kundeoppfølging   AS " }).tenant_id).toBe(previewBusinessTenant({ name: "Kundeoppfølging AS" }).tenant_id);
  });

  it("ugyldig navn avvises: tomt, for kort/langt, ikke-tekst, kontrolltegn, < og >", () => {
    for (const bad of ["", " ", "x", "a".repeat(81), 42, null, undefined, "Navn\u0000med null", "Navn\nlinjeskift", "<script>alert(1)</script>", "A > B"]) {
      expect(() => normalizeBusinessTenantName(bad), String(bad)).toThrowError(BusinessTenantProvisioningError);
    }
    expect(() => deriveBusinessTenantSlug("!!! ???")).toThrowError(/slug_invalid/);
  });

  it("eksplisitt slug valideres STRENGT (ingen stille retting): store bokstaver, mellomrom, understrek, punktum, sti, bindestrek først/sist, for kort/lang", () => {
    for (const bad of ["Stor", "med mellomrom", "under_strek", "pun.ktum", "../etc", "-start", "slutt-", "a", "a".repeat(49), "", "æøå", "a/b", "a;b"]) {
      expect(() => previewBusinessTenant({ name: "Gyldig Navn", slug: bad }), bad).toThrowError(/slug_invalid/);
    }
    expect(previewBusinessTenant({ name: "Gyldig Navn", slug: "a".repeat(48) }).tenant_id).toBe(`tenant-${"a".repeat(48)}`);
    expect(previewBusinessTenant({ name: "Gyldig Navn", slug: "ab" }).slug).toBe("ab");
  });

  it("eier-handlingene nevner den konkrete tenant-id-en og de faktiske miljøvariablene", () => {
    const actions = ownerActionsFor("tenant-x").join("\n");
    for (const must of ["tenant-x", "JARVIS_OWNER_EXTRA_TENANTS=tenant-x", "enroll-device.sh", "Q-48", "JARVIS_PRODUCT_USAGE_TENANT_ID=tenant-x"]) expect(actions).toContain(must);
  });
});

describe("B: provisjonering som app-rolle (RLS håndheves)", () => {
  it("FØR provisjonering finner sveipenes katalog ingen bedrifts-tenant (utgangspunktet i JARVIS-044)", async () => {
    expect(await listBusinessTenantIds(app, 200)).toEqual([]);
  });

  it("oppretter tenant + business/project-space + eier-medlemskap, med revisjonsspor i begge tenants - og sveipene finner den", async () => {
    const report = await provisionBusinessTenant(app, owner, { name: "Kundeoppfølging AS", slug: "kundeoppfolging" }, { via: "cli", session_id: "sess-wpd2" });
    expect(report).toMatchObject({
      tenant_id: "tenant-kundeoppfolging", name: "Kundeoppfølging AS", idempotent_replay: false,
      created: { tenant: true, memory_spaces: ["business", "project"], membership: true },
      already_present: { tenant: false, memory_spaces: [], membership: false },
      visible_to_business_sweeps: true
    });
    expect(await rowsFor("tenant-kundeoppfolging")).toEqual({ tenants: 1, spaces: ["business", "project"], members: [`${OWNER_PERSON}:owner`] });
    const kind = await admin.query("SELECT kind, name FROM tenants WHERE tenant_id = 'tenant-kundeoppfolging'");
    expect(kind.rows[0]).toEqual({ kind: "business", name: "Kundeoppfølging AS" });
    // det sveipene faktisk bruker, som app-rolle
    expect(await listBusinessTenantIds(app, 200)).toContain("tenant-kundeoppfolging");
    // eierens primære tenant er uberørt
    expect(await rowsFor(OWNER_TENANT)).toMatchObject({ tenants: 1, spaces: ["personal"] });
    // revisjon: én rad i den nye tenanten og én i eierens tenant, begge med eier som aktør og uten hemmeligheter
    const audit = await admin.query("SELECT tenant_id, person_id, session_id, payload FROM audit_events WHERE type = 'tenant.business_provisioned' ORDER BY tenant_id");
    expect(audit.rows.map((r: { tenant_id: string }) => r.tenant_id)).toEqual(["tenant-kundeoppfolging", OWNER_TENANT]);
    for (const row of audit.rows as Array<{ person_id: string; session_id: string; payload: Record<string, unknown> }>) {
      expect(row.person_id).toBe(OWNER_PERSON);
      expect(row.session_id).toBe("sess-wpd2");
      expect(row.payload).toMatchObject({ tenant_id: "tenant-kundeoppfolging", via: "cli", spaces: ["business", "project"] });
    }
  });

  it("rapporten BEVISER isolasjon: rollen håndhever RLS, fremmed kontekst ser 0 rader, egen kontekst ser tenant 1 / spaces 2 / medlemskap 1", async () => {
    const report = await provisionBusinessTenant(app, owner, { name: "Kundeoppfølging AS", slug: "kundeoppfolging" }, { via: "cli" });
    expect(report.rls_probe).toEqual({
      enforced: true,
      foreign_context_rows: { tenants: 0, memory_spaces: 0, person_tenants: 0 },
      own_context_rows: { tenants: 1, memory_spaces: 2, person_tenants: 1 }
    });
  });

  it("en annen tenant ser ingenting av den nye, og kan ikke skrive inn rader i den (WITH CHECK)", async () => {
    await withTenantTransaction(app, OWNER_TENANT, async (client) => {
      expect((await client.query("SELECT 1 FROM tenants WHERE tenant_id = 'tenant-kundeoppfolging'")).rowCount).toBe(0);
      expect((await client.query("SELECT 1 FROM memory_spaces WHERE tenant_id = 'tenant-kundeoppfolging'")).rowCount).toBe(0);
      expect((await client.query("SELECT 1 FROM person_tenants WHERE tenant_id = 'tenant-kundeoppfolging'")).rowCount).toBe(0);
    });
    await expect(withTenantTransaction(app, OWNER_TENANT, (client) =>
      client.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-evil', 'tenant-kundeoppfolging', 'guest')")
    )).rejects.toThrow(/row-level security/);
    // uten tenant-kontekst ser app-rollen heller ingenting (default deny)
    expect((await app.query("SELECT 1 FROM tenants WHERE tenant_id = 'tenant-kundeoppfolging'")).rowCount).toBe(0);
  });

  it("navn med SQL-tegn lagres bokstavelig (parametrisert) - tenants-tabellen er intakt", async () => {
    const report = await provisionBusinessTenant(app, owner, { name: "Robert'); DROP TABLE tenants;--" }, { via: "cli" });
    expect(report.tenant_id).toBe("tenant-robert-drop-table-tenants");
    const stored = await admin.query("SELECT name FROM tenants WHERE tenant_id = 'tenant-robert-drop-table-tenants'");
    expect((stored.rows[0] as { name: string }).name).toBe("Robert'); DROP TABLE tenants;--");
    expect((await admin.query("SELECT count(*)::int AS n FROM tenants")).rows[0]).toMatchObject({ n: expect.any(Number) });
  });
});

describe("C: idempotens", () => {
  it("samme kall to ganger: andre kall endrer ingenting (replay), ingen duplikater, ny audit-type `replayed`", async () => {
    const first = await provisionBusinessTenant(app, owner, { name: "Idem AS", slug: "idem" }, { via: "dashboard" });
    expect(first.idempotent_replay).toBe(false);
    const second = await provisionBusinessTenant(app, owner, { name: "Idem AS", slug: "idem" }, { via: "dashboard" });
    expect(second).toMatchObject({
      idempotent_replay: true,
      created: { tenant: false, memory_spaces: [], membership: false },
      already_present: { tenant: true, memory_spaces: ["business", "project"], membership: true }
    });
    expect(await rowsFor("tenant-idem")).toEqual({ tenants: 1, spaces: ["business", "project"], members: [`${OWNER_PERSON}:owner`] });
    const types = await admin.query("SELECT type, count(*)::int AS n FROM audit_events WHERE tenant_id = 'tenant-idem' AND type LIKE 'tenant.business_provision%' GROUP BY type ORDER BY type");
    expect(types.rows).toEqual([{ type: "tenant.business_provision_replayed", n: 1 }, { type: "tenant.business_provisioned", n: 1 }]);
  });

  it("samme navn UTEN slug gir samme tenant (slug utledes) - to SAMTIDIGE kall gir nøyaktig én tenant og én skaper", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => provisionBusinessTenant(app, owner, { name: "Samtidig Test AS" }, { via: "dashboard" })));
    expect(results.every((r) => r.tenant_id === "tenant-samtidig-test-as")).toBe(true);
    expect(results.filter((r) => r.created.tenant)).toHaveLength(1);
    expect(results.filter((r) => r.created.membership)).toHaveLength(1);
    expect(await rowsFor("tenant-samtidig-test-as")).toEqual({ tenants: 1, spaces: ["business", "project"], members: [`${OWNER_PERSON}:owner`] });
  });

  it("delvis tilstand repareres: manglende space/medlemskap fylles på uten å røre det som finnes", async () => {
    await provisionBusinessTenant(app, owner, { name: "Delvis AS", slug: "delvis" }, { via: "cli" });
    await admin.query("DELETE FROM memory_spaces WHERE tenant_id = 'tenant-delvis' AND space = 'project'");
    await admin.query("DELETE FROM person_tenants WHERE tenant_id = 'tenant-delvis'");
    const healed = await provisionBusinessTenant(app, owner, { name: "Delvis AS", slug: "delvis" }, { via: "cli" });
    expect(healed.created).toEqual({ tenant: false, memory_spaces: ["project"], membership: true });
    expect(healed.idempotent_replay).toBe(false);
    expect(await rowsFor("tenant-delvis")).toEqual({ tenants: 1, spaces: ["business", "project"], members: [`${OWNER_PERSON}:owner`] });
  });
});

describe("D: konflikter og alt-eller-ingenting", () => {
  it("samme id som en person-tenant avvises og endrer ingenting (eierens egen tenant kan aldri «gjøres om» til business)", async () => {
    // `tenant-wpd2-owner` finnes som PERSON (utgangspunktet speiler seedOwner).
    await expect(provisionBusinessTenant(app, owner, { name: "Eier", slug: "wpd2-owner" }, { via: "cli" })).rejects.toMatchObject({ code: "tenant_exists_with_other_kind" });
    expect((await admin.query("SELECT kind FROM tenants WHERE tenant_id = $1", [OWNER_TENANT])).rows[0]).toEqual({ kind: "person" });
    expect((await rowsFor(OWNER_TENANT)).spaces).toEqual(["personal"]);
  });

  it("samme slug med ANNET navn avvises (ingen stille omdøping/gjenbruk)", async () => {
    await provisionBusinessTenant(app, owner, { name: "Navn En AS", slug: "navnkonflikt" }, { via: "cli" });
    await expect(provisionBusinessTenant(app, owner, { name: "Navn To AS", slug: "navnkonflikt" }, { via: "cli" })).rejects.toMatchObject({ code: "tenant_name_mismatch" });
    expect((await admin.query("SELECT name FROM tenants WHERE tenant_id = 'tenant-navnkonflikt'")).rows[0]).toEqual({ name: "Navn En AS" });
  });

  it("ukjent eier-person ruller HELE transaksjonen tilbake - ingen halv tenant", async () => {
    await expect(provisionBusinessTenant(app, { owner_person_id: "person-finnes-ikke", owner_tenant_id: OWNER_TENANT }, { name: "Foreldrelos AS", slug: "foreldrelos" }, { via: "cli" }))
      .rejects.toMatchObject({ code: "owner_person_not_found" });
    expect(await rowsFor("tenant-foreldrelos")).toEqual({ tenants: 0, spaces: [], members: [] });
    const audit = await admin.query("SELECT 1 FROM audit_events WHERE tenant_id = 'tenant-foreldrelos'");
    expect(audit.rowCount).toBe(0);
  });

  it("ugyldig eier-id og ugyldig input avvises FØR noe skrives", async () => {
    await expect(provisionBusinessTenant(app, { owner_person_id: "Eier med mellomrom", owner_tenant_id: OWNER_TENANT }, { name: "Gyldig AS" }, { via: "cli" })).rejects.toMatchObject({ code: "owner_invalid" });
    await expect(provisionBusinessTenant(app, owner, { name: "<b>x</b>" }, { via: "cli" })).rejects.toMatchObject({ code: "name_invalid" });
    expect(await rowsFor("tenant-gyldig-as")).toEqual({ tenants: 0, spaces: [], members: [] });
  });
});

describe("E: admin-veien (NAS-CLI)", () => {
  it("virker med admin-pool, og rapporten sier ærlig at RLS ikke håndheves for den rollen (beviset sier da ingenting om isolasjon)", async () => {
    const report = await provisionBusinessTenant(admin, owner, { name: "Via Admin AS", slug: "via-admin" }, { via: "cli" });
    expect(report.created.tenant).toBe(true);
    expect(report.rls_probe.enforced).toBe(false);
    expect(report.visible_to_business_sweeps).toBe(true);
    expect(await rowsFor("tenant-via-admin")).toEqual({ tenants: 1, spaces: ["business", "project"], members: [`${OWNER_PERSON}:owner`] });
  });
});
