import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, listBusinessTenantIds, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { parseProvisionCliArgs, ProvisionCliUsageError, runProvisionBusinessTenantCli } from "../src/provision-business-tenant-cli.ts";
import { seedOwner } from "../src/seed.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-D2 (JARVIS-044/Q-48): `POST /owner/business-tenants` - eier-grant + step-up + TYPET bekreftelse, dormant, aldri et modellverktøy. Mot ekte Postgres som app-rolle.
 * Dekker også «ingenting provisjoneres automatisk»: migrering + seed gir null bedrifts-tenants.
 */
const OWNER_TENANT = "tenant-wpd2route-owner";
const OWNER_PERSON = "person-wpd2route-owner";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let url = "";
let urlDormant = "";
const closers: Array<() => Promise<void>> = [];
let tenantsAfterSeed: string[] = [];

const GRANTS: Record<string, { person_id: string; tenant_id: string; channel: string; auth_strength: string; session_id: string }> = {
  "owner-signed": { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, channel: "web", auth_strength: "signed", session_id: "s-owner" },
  "owner-active": { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, channel: "web", auth_strength: "active", session_id: "s-active" },
  "owner-voice": { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, channel: "voice", auth_strength: "signed", session_id: "s-voice" },
  "owner-telegram": { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, channel: "telegram", auth_strength: "signed", session_id: "s-tg" },
  "other-person": { person_id: "person-annen", tenant_id: OWNER_TENANT, channel: "web", auth_strength: "signed", session_id: "s-other" },
  "owner-elsewhere": { person_id: OWNER_PERSON, tenant_id: "tenant-annen", channel: "web", auth_strength: "signed", session_id: "s-else" },
  "delegate": { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, channel: "web", auth_strength: "signed", session_id: "s-delegate" }
};

function makeDeps(withFeature: boolean): ApiDeps {
  return {
    grants: {
      verify: async (token: string) => (GRANTS[token]
        ? { ok: true, grant: { ...GRANTS[token], memory_space: "personal", device_id: "d1" } }
        : { ok: false, reason: "grant_invalid" })
    },
    identity: {
      resolveIdentity: async (i: Record<string, string>) => ({
        ok: true,
        identity: { ...i, memory_space_id: i["memory_space"], ...(i["session_id"] === "s-delegate" ? { delegation_id: "delegation-1" } : {}) }
      })
    },
    owner: { tenant_id: OWNER_TENANT, person_id: OWNER_PERSON },
    ...(withFeature ? { businessTenants: { pool: app } } : {})
  } as unknown as ApiDeps;
}

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-route-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  // Den ekte seeden (som migrate-tjenesten kjører): identitet + personal-space, INGEN bedrifts-tenant.
  await seedOwner(admin, { tenant_id: OWNER_TENANT, owner_person_id: OWNER_PERSON, owner_display_name: "Eier" });
  await admin.query("CREATE ROLE jarvis_wpd2_route LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_route");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_route", password: "pw2" });
  tenantsAfterSeed = await listBusinessTenantIds(app, 200);
  url = await listen(makeDeps(true));
  urlDormant = await listen(makeDeps(false));
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const post = (base: string, body: unknown) => fetch(`${base}/owner/business-tenants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const businessCount = async () => ((await admin.query("SELECT count(*)::int AS n FROM tenants WHERE kind = 'business'")).rows[0] as { n: number }).n;
const NAME = "Kundeoppfølging AS";

describe("dormant: ingenting provisjoneres automatisk", () => {
  it("migrering + seed gir NULL bedrifts-tenants (det er eierens valg)", () => {
    expect(tenantsAfterSeed).toEqual([]);
  });

  it("uten JARVIS_BUSINESS_TENANT_PROVISIONING (businessTenants i deps) er ruten 404 - selv med gyldig eier-grant", async () => {
    const res = await post(urlDormant, { grant_token: "owner-signed", action: "provision", name: NAME, confirm: true, confirm_tenant_id: "tenant-kundeoppfolging-as" });
    expect(res.status).toBe(404);
    expect(await businessCount()).toBe(0);
  });

  it("main.ts åpner ruten KUN ved eksakt «true», og provisjoneringen er aldri et modellverktøy", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toMatch(/process\.env\["JARVIS_BUSINESS_TENANT_PROVISIONING"\] === "true" \? \{ businessTenants: \{ pool \} \} : \{\}/);
    const tools = readFileSync(fileURLToPath(new URL("../../../modules/tool-gateway/src/chat-act-tier.ts", import.meta.url)), "utf8");
    const integrations = readFileSync(fileURLToPath(new URL("../../../modules/tool-gateway/src/integrations.ts", import.meta.url)), "utf8");
    for (const src of [tools, integrations]) expect(src).not.toMatch(/provision_business_tenant|business_tenant/);
    // seed/migrate kaller aldri tjenesten
    for (const f of ["../src/seed.ts", "../src/migrate-main.ts"]) {
      expect(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")).not.toMatch(/provisionBusinessTenant/);
    }
  });
});

describe("kropp, grant og eier-autoritet - alt avvises FØR noe skrives", () => {
  it("uten grant -> 401; identitetsfelt -> 400; ukjent felt -> 400; ugyldig action -> 400; feil typer -> 400", async () => {
    expect((await post(url, { action: "preview", name: NAME })).status).toBe(401);
    const idField = await post(url, { grant_token: "owner-signed", action: "preview", name: NAME, tenant_id: "tenant-evil" });
    expect(idField.status).toBe(400);
    expect((await json(idField))["error"]).toBe("identity_field_forbidden");
    expect((await post(url, { grant_token: "owner-signed", action: "preview", name: NAME, surprise: 1 })).status).toBe(400);
    for (const action of ["delete", "provision_all", "", 7, undefined]) {
      const res = await post(url, { grant_token: "owner-signed", action, name: NAME });
      expect(res.status, String(action)).toBe(400);
      expect((await json(res))["reason"]).toBe("action_not_allowed");
    }
    for (const bad of [{ name: 42 }, { name: NAME, slug: 5 }, { name: NAME, confirm: "true" }, { name: NAME, confirm_tenant_id: 1 }, {}]) {
      expect((await post(url, { grant_token: "owner-signed", action: "preview", ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await businessCount()).toBe(0);
  });

  it("ugyldig grant -> 403 identity_denied", async () => {
    const res = await post(url, { grant_token: "bogus", action: "preview", name: NAME });
    expect(res.status).toBe(403);
    expect((await json(res))["error"]).toBe("identity_denied");
  });

  it("KUN den konfigurerte eieren i eierens tenant: annen person, eieren i annen tenant og en delegat -> 403 owner_only", async () => {
    for (const token of ["other-person", "owner-elsewhere", "delegate"]) {
      const res = await post(url, { grant_token: token, action: "provision", name: NAME, confirm: true, confirm_tenant_id: "tenant-kundeoppfolging-as" });
      expect(res.status, token).toBe(403);
      expect((await json(res))["error"], token).toBe("owner_only");
    }
    expect(await businessCount()).toBe(0);
  });

  it("step-up: uten signert enhet eller fra tale/Telegram -> 403 step_up_required (også for preview)", async () => {
    for (const token of ["owner-active", "owner-voice", "owner-telegram"]) {
      for (const action of ["preview", "provision"]) {
        const res = await post(url, { grant_token: token, action, name: NAME, confirm: true, confirm_tenant_id: "tenant-kundeoppfolging-as" });
        expect(res.status, `${token}/${action}`).toBe(403);
        expect((await json(res))["error"], `${token}/${action}`).toBe("step_up_required");
      }
    }
    expect(await businessCount()).toBe(0);
  });
});

describe("preview skriver aldri; provision krever TYPET bekreftelse", () => {
  it("preview viser planen og tenant-id-en som må skrives inn - og skriver ingenting", async () => {
    const res = await post(url, { grant_token: "owner-signed", action: "preview", name: NAME });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["data"]).toMatchObject({ writes: false, confirm_tenant_id_required: "tenant-kundeoppfolging-as", plan: { tenant_id: "tenant-kundeoppfolging-as", kind: "business", memory_spaces: ["business", "project"] } });
    expect(await businessCount()).toBe(0);
  });

  it("provision uten bekreftelse / med confirm:true alene / med feil tenant-id -> 409 confirmation_required, ingenting skrevet", async () => {
    for (const extra of [{}, { confirm: true }, { confirm: false, confirm_tenant_id: "tenant-kundeoppfolging-as" }, { confirm: true, confirm_tenant_id: "tenant-annen-id" }, { confirm: true, confirm_tenant_id: "TENANT-KUNDEOPPFOLGING-AS" }, { confirm_tenant_id: "tenant-kundeoppfolging-as" }]) {
      const res = await post(url, { grant_token: "owner-signed", action: "provision", name: NAME, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(409);
      expect((await json(res))["error"]).toBe("confirmation_required");
    }
    expect(await businessCount()).toBe(0);
  });

  it("ugyldig navn/slug -> 400 med feilkode, ingenting skrevet", async () => {
    expect((await json(await post(url, { grant_token: "owner-signed", action: "preview", name: "x" })))["error"]).toBe("name_invalid");
    expect((await json(await post(url, { grant_token: "owner-signed", action: "preview", name: NAME, slug: "../etc" })))["error"]).toBe("slug_invalid");
    expect((await json(await post(url, { grant_token: "owner-signed", action: "preview", name: "<script>" })))["error"]).toBe("name_invalid");
    expect(await businessCount()).toBe(0);
  });

  it("riktig bekreftelse oppretter tenanten (som app-rolle/RLS), sveipene finner den, rapporten viser hva eieren selv må gjøre", async () => {
    const res = await post(url, { grant_token: "owner-signed", action: "provision", name: NAME, slug: "kundeoppfolging", confirm: true, confirm_tenant_id: "tenant-kundeoppfolging" });
    expect(res.status).toBe(200);
    const report = (await json(res))["data"];
    expect(report).toMatchObject({
      tenant_id: "tenant-kundeoppfolging", idempotent_replay: false, visible_to_business_sweeps: true,
      created: { tenant: true, memory_spaces: ["business", "project"], membership: true },
      rls_probe: { enforced: true, foreign_context_rows: { tenants: 0, memory_spaces: 0, person_tenants: 0 } }
    });
    expect((report.owner_actions as string[]).join("\n")).toContain("JARVIS_OWNER_EXTRA_TENANTS=tenant-kundeoppfolging");
    expect(await listBusinessTenantIds(app, 200)).toEqual(["tenant-kundeoppfolging"]);
    const audit = await admin.query("SELECT payload->>'via' AS via, session_id, device_id FROM audit_events WHERE tenant_id = 'tenant-kundeoppfolging' AND type = 'tenant.business_provisioned'");
    expect(audit.rows).toEqual([{ via: "dashboard", session_id: "s-owner", device_id: "d1" }]);
  });

  it("gjentatt provision er idempotent (replay), og samme slug med annet navn -> 409 tenant_name_mismatch uten endring", async () => {
    const again = await post(url, { grant_token: "owner-signed", action: "provision", name: NAME, slug: "kundeoppfolging", confirm: true, confirm_tenant_id: "tenant-kundeoppfolging" });
    expect(again.status).toBe(200);
    expect((await json(again))["data"]).toMatchObject({ idempotent_replay: true, created: { tenant: false, memory_spaces: [], membership: false } });
    const clash = await post(url, { grant_token: "owner-signed", action: "provision", name: "Et Helt Annet Navn", slug: "kundeoppfolging", confirm: true, confirm_tenant_id: "tenant-kundeoppfolging" });
    expect(clash.status).toBe(409);
    expect((await json(clash))["error"]).toBe("tenant_name_mismatch");
    expect(await businessCount()).toBe(1);
    expect((await admin.query("SELECT name FROM tenants WHERE tenant_id = 'tenant-kundeoppfolging'")).rows[0]).toEqual({ name: NAME });
  });

  it("slug som kolliderer med eierens person-tenant -> 409 tenant_exists_with_other_kind (eierens tenant forblir person)", async () => {
    const res = await post(url, { grant_token: "owner-signed", action: "provision", name: "Eier AS", slug: "wpd2route-owner", confirm: true, confirm_tenant_id: OWNER_TENANT });
    expect(res.status).toBe(409);
    expect((await json(res))["error"]).toBe("tenant_exists_with_other_kind");
    expect((await admin.query("SELECT kind FROM tenants WHERE tenant_id = $1", [OWNER_TENANT])).rows[0]).toEqual({ kind: "person" });
  });
});

describe("CLI (NAS): dry-run som standard, typet --confirm, idempotent, ingen hemmeligheter", () => {
  const cliOwner = { owner_person_id: OWNER_PERSON, owner_tenant_id: OWNER_TENANT };
  function io() {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, io: { out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) } };
  }
  const cli = (argv: string[]) => { const c = io(); return runProvisionBusinessTenantCli(argv, cliOwner, admin, c.io).then((code) => ({ code, out: c.lines.join("\n"), err: c.errs.join("\n") })); };
  const exists = async (id: string) => ((await admin.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [id])).rows[0] as { n: number }).n;

  it("uten --confirm er kjøringen en DRY-RUN: planen vises, tenant-id oppgis for bekreftelse, ingenting skrives (exit 0)", async () => {
    const r = await cli(["--name", "CLI Test AS", "--slug", "cli-test"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tenant_id:  tenant-cli-test");
    expect(r.out).toContain("DRY-RUN");
    expect(r.out).toContain("--confirm tenant-cli-test");
    expect(await exists("tenant-cli-test")).toBe(0);
  });

  it("feil --confirm avvises (exit 2) uten å skrive; riktig --confirm oppretter; gjentatt kjøring er idempotent og sier det", async () => {
    const wrong = await cli(["--name", "CLI Test AS", "--slug", "cli-test", "--confirm", "tenant-annet"]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("NØYAKTIG");
    expect(await exists("tenant-cli-test")).toBe(0);

    const ok = await cli(["--name", "CLI Test AS", "--slug", "cli-test", "--confirm", "tenant-cli-test"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("Bedrifts-tenant klar:");
    expect(ok.out).toContain("opprettet:  tenant=true spaces=[business,project] medlemskap=true");
    expect(ok.out).toContain("sveipene finner tenanten (jarvis_list_business_tenant_ids): true");
    expect(ok.out).toContain("denne rollen omgår RLS (admin)");
    expect(ok.out).toContain("JARVIS_OWNER_EXTRA_TENANTS=tenant-cli-test");
    expect(await exists("tenant-cli-test")).toBe(1);

    const again = await cli(["--name", "CLI Test AS", "--slug", "cli-test", "--confirm", "tenant-cli-test"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("fantes allerede - ingenting ble endret (idempotent)");
    expect(await exists("tenant-cli-test")).toBe(1);
  });

  it("konflikt (annet navn, samme slug) gir exit 3 og endrer ingenting; ugyldig input gir exit 2", async () => {
    const clash = await cli(["--name", "Helt Annet Navn", "--slug", "cli-test", "--confirm", "tenant-cli-test"]);
    expect(clash.code).toBe(3);
    expect(clash.err).toContain("ingenting er endret");
    expect((await admin.query("SELECT name FROM tenants WHERE tenant_id = 'tenant-cli-test'")).rows[0]).toEqual({ name: "CLI Test AS" });
    expect((await cli(["--name", "x"])).code).toBe(2);
    expect((await cli(["--name", "Gyldig Navn", "--slug", "UPPER"])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });

  it("argumentparsing er streng: ukjente flagg, manglende verdi, duplikater og løse argumenter avvises", () => {
    for (const bad of [["--oops", "x"], ["--name"], ["--name", "--slug"], ["--name", "a", "--name", "b"], ["navn uten flagg"], ["--name", "ok", "--confirm"]]) {
      expect(() => parseProvisionCliArgs(bad), bad.join(" ")).toThrowError(ProvisionCliUsageError);
    }
    expect(parseProvisionCliArgs(["--name", "Navn Her", "--slug", "x1", "--confirm", "tenant-x1"])).toEqual({ name: "Navn Her", slug: "x1", confirm: "tenant-x1" });
  });

  it("CLI-en leser/skriver ingen hemmeligheter og er ikke koblet til oppstart (statisk vakt)", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/provision-business-tenant-main.ts", import.meta.url)), "utf8");
    const cliSrc = readFileSync(fileURLToPath(new URL("../src/provision-business-tenant-cli.ts", import.meta.url)), "utf8");
    for (const src of [main, cliSrc]) {
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(code).not.toMatch(/PASSWORD|SECRET|TOKEN|process\.env\[/);
    }
    // admin-pool via den samme konfigen som migrasjonene/enroll-ticket (ingen ny credential)
    expect(main).toContain("adminConfigFromEnv");
  });
});
