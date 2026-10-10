import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import {
  createAuthorityCenter, readAutonomy, readDevices, readDomainPauses, readFinanceKillSwitch, readPendingConfirmations
} from "../src/control-center/authority.ts";
import { tenantRead } from "../src/control-center/shared.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H0 Authority Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - alle seks lesespørringene kjører med rollens faktiske GRANT-er og kolonner (enheter, grants, autonomi, situasjoner, pauser, finans-bryter, bekreftelser);
 *  - tenant-isolasjon: A ser kun egne enheter, grants, autonomi-bindinger, finansbryter og bekreftelser - aldri B sine;
 *  - minnerom-RLS (RESTRICTIVE) er default deny uten `jarvis.memory_spaces`, og health-rommet leses KUN som antall i en egen lesing;
 *  - innholdsvern: autonomi-parametre, bekreftelsessammendrag, pausebegrunnelser og nøkkelmateriale leses aldri og når aldri rapporten;
 *  - de varige eierbryterne (`owner_control_state`) leses via de ekte `KillSwitch`/`OwnerControls`;
 *  - senteret skriver ingenting (radtall i alle berørte tabeller er uendret).
 */
let db: H0Db;
const TENANT_A = "tenant-ac-a";
const TENANT_B = "tenant-ac-b";
const DELEGATE = "person-ac-delegate";
const NOW = new Date();
const H = 3_600_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ahead = (ms: number): Date => new Date(NOW.getTime() + ms);
const idA: IdentityContext = { person_id: "person-ac-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "dev-ac-cur", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-ac-b", tenant_id: TENANT_B, device_id: "dev-ac-b" };
const defs = productionToolDefinitions();
const SECRET_PARAM = "sk-ant-api03-PARAMETERSHEMMELIGHET";
const SECRET_REASON = "privat begrunnelse som aldri skal vises";
const SECRET_SUMMARY = "hemmelig-mottaker@example.com";

async function grant(id: string, tenant: string, person: string, device: string, session: string, expires: Date, revokedAt: Date | null = null): Promise<void> {
  await db.adminPool.query(
    "INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, issued_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,'personal','web','signed','fp-hemmelig',$6,$7,$8)",
    [id, tenant, person, device, session, ago(2 * H), expires, revokedAt]
  );
}

beforeAll(async () => {
  db = await startH0Db("ac");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [DELEGATE]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [DELEGATE, TENANT_A]);

  // Enheter: A har eierens to aktive enheter, delegatens, og en tilbakekalt; B har en egen
  const dev = (id: string, tenant: string, person: string, revokedAt: Date | null = null): Promise<unknown> =>
    admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, created_at, revoked_at) VALUES ($1,$2,$3,'web',$4,$5,$6)", [id, tenant, person, revokedAt ? null : "-----BEGIN PUBLIC KEY-----hemmelig-----END PUBLIC KEY-----", ago(100 * H), revokedAt]);
  await dev("dev-ac-cur", TENANT_A, idA.person_id);
  await dev("dev-ac-phone", TENANT_A, idA.person_id);
  await dev("dev-ac-del", TENANT_A, DELEGATE);
  await dev("dev-ac-old", TENANT_A, idA.person_id, ago(50 * H));
  await dev("dev-ac-b", TENANT_B, idB.person_id);
  await admin.query("INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ('sess-ac-a',$1,$2,'active','web','dev-ac-cur'), ('sess-ac-del',$1,$3,'active','web','dev-ac-del'), ('sess-ac-b',$4,$5,'active','web','dev-ac-b')", [TENANT_A, idA.person_id, DELEGATE, TENANT_B, idB.person_id]);
  await grant("g-cur", TENANT_A, idA.person_id, "dev-ac-cur", "sess-ac-a", ahead(5 * H));
  await grant("g-phone", TENANT_A, idA.person_id, "dev-ac-phone", "sess-ac-a", ahead(5 * H));
  await grant("g-phone-expired", TENANT_A, idA.person_id, "dev-ac-phone", "sess-ac-a", ago(H));
  await grant("g-phone-revoked", TENANT_A, idA.person_id, "dev-ac-phone", "sess-ac-a", ahead(5 * H), ago(H));
  await grant("g-del-1", TENANT_A, DELEGATE, "dev-ac-del", "sess-ac-del", ahead(5 * H));
  await grant("g-del-2", TENANT_A, DELEGATE, "dev-ac-del", "sess-ac-del", ahead(4 * H));
  await grant("g-b", TENANT_B, idB.person_id, "dev-ac-b", "sess-ac-b", ahead(5 * H));

  // Autonomi-bindinger (parametrene er hemmelige i testen og skal ALDRI leses), situasjoner, pause, finansbryter, bekreftelser
  const policy = (tenant: string, person: string, space: string, domain: string, enabled = true): Promise<unknown> =>
    admin.query("INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id, updated_at) VALUES ($1,$2,$3,'finance_spend','sync_internal_spend',$4::jsonb,$5,$6,$7)", [tenant, space, domain, JSON.stringify({ token: SECRET_PARAM }), enabled, person, ago(30 * H)]);
  await policy(TENANT_A, idA.person_id, "business", "finance");
  await policy(TENANT_A, idA.person_id, "personal", "support", false);
  await policy(TENANT_A, idA.person_id, "health", "helse-domene");
  await policy(TENANT_B, idB.person_id, "business", "b-domene");
  const situation = (id: string, tenant: string, space: string, domain: string): Promise<unknown> =>
    admin.query("INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, reason) VALUES ($1,$2,$3,$4,$1,'privat situasjonsgrunn')", [id, tenant, space, domain]);
  await situation("sit-a-1", TENANT_A, "business", "finance");
  await situation("sit-a-2", TENANT_A, "project", "pipeline");
  await situation("sit-b-1", TENANT_B, "business", "b-situasjon");
  await admin.query("INSERT INTO situation_domain_pauses (domain, reason, paused_by, paused_at) VALUES ('sales', $1, $2, $3)", [SECRET_REASON, idA.person_id, ago(3 * H)]);
  await admin.query("INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_by_person_id, enabled_at, reason) VALUES ($1, true, $2, $3, $4)", [TENANT_A, idA.person_id, ago(4 * H), SECRET_REASON]);
  const confirmation = (id: string, tenant: string, person: string, status: string, expires: Date): Promise<unknown> =>
    admin.query(
      "INSERT INTO action_confirmations (confirmation_id, tenant_id, person_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, status, expires_at, created_at) VALUES ($1,$2,$3,'email','send','fp','bh',$1,$4::jsonb,$5,$6,$7,$8)",
      [id, tenant, person, JSON.stringify({ to: SECRET_SUMMARY }), ["untrusted_output:email.read_inbox"], status, expires, ago(2 * H)]
    );
  await confirmation("conf-a-pending", TENANT_A, idA.person_id, "pending", ahead(3 * H));
  await confirmation("conf-a-consumed", TENANT_A, idA.person_id, "consumed", ahead(3 * H));
  await confirmation("conf-b-pending", TENANT_B, idB.person_id, "pending", ahead(3 * H));
  // Varige eierbrytere (globale, ingen tenant): frosset connector, frosset modellleverandør (mål utenfor connector-registeret), tilbakekalt credential
  await admin.query("INSERT INTO owner_control_state (control_kind, control_target, reason, actor_person_id, changed_at) VALUES ('connector_freeze','github',$1,$2,$3), ('connector_freeze','model:anthropic',$1,$2,$3), ('credential_revocation','JARVIS_EMAIL_TOKEN',$1,$2,$3)", [SECRET_REASON, idA.person_id, ago(5 * H)]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function center(): ReturnType<typeof createAuthorityCenter> {
  const killSwitch = new KillSwitch(db.appPool);
  return createAuthorityCenter({
    pool: db.appPool,
    env: { JARVIS_GITHUB_REPO: "tsworkflow/jarvisbuild" },
    authority: { owner_person_id: idA.person_id, owner_tenants: [TENANT_A] },
    toolGateway: { list: () => defs, get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a), policyFlags: () => ({ class_d_pipeline_enforced: true, credential_binding_active: true }) },
    ownerControls: new OwnerControls(killSwitch, db.appPool),
    killSwitch
  });
}
async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center());
  return (await registry.report("authority", identity)) as ControlCenterReport;
}
const item = (r: ControlCenterReport, section: string, id: string) => r.sections.find((s) => s.id === section)!.items.find((i) => i.id === id)!;
const sec = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;

describe("lesespørringene som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("enheter og grants: A ser kun egne enheter; utløpte og tilbakekalte grants telles ikke; roller kommer fra person_tenants", async () => {
    const rows = await readDevices(db.appPool, TENANT_A, NOW.getTime());
    expect(rows.map((r) => r.device_id).sort()).toEqual(["dev-ac-cur", "dev-ac-del", "dev-ac-old", "dev-ac-phone"]);
    const by = new Map(rows.map((r) => [r.device_id, r]));
    expect(by.get("dev-ac-cur")).toMatchObject({ person_id: idA.person_id, role: "owner", active_grants: 1, revoked_at: null });
    expect(by.get("dev-ac-phone")?.active_grants).toBe(1); // 1 aktiv av 3 grants (1 utløpt, 1 tilbakekalt)
    expect(by.get("dev-ac-del")).toMatchObject({ person_id: DELEGATE, role: "member", active_grants: 2 });
    expect(by.get("dev-ac-old")?.revoked_at).not.toBeNull();
    expect(rows[rows.length - 1]?.device_id).toBe("dev-ac-old"); // tilbakekalte sist
    const json = JSON.stringify(rows);
    for (const forbidden of ["hemmelig", "BEGIN PUBLIC KEY", "g-cur", "fp-hemmelig"]) expect(json, forbidden).not.toContain(forbidden);
    const b = await readDevices(db.appPool, TENANT_B, NOW.getTime());
    expect(b.map((r) => r.device_id)).toEqual(["dev-ac-b"]);
    expect(b[0]?.active_grants).toBe(1);
  });

  it("autonomi: alle rom UTEN health listes (kun navn), health telles i egen lesing, domener fra situasjoner, kun egen tenant; parametre leses aldri", async () => {
    const a = await readAutonomy(db.appPool, TENANT_A);
    expect(a.rows.map((r) => `${r.memory_space_id}:${r.domain}`).sort()).toEqual(["business:finance", "personal:support"]);
    expect(a.rows.find((r) => r.domain === "support")?.enabled).toBe(false);
    expect(a.health_count).toBe(1);
    expect(a.situation_domains.sort()).toEqual(["finance", "pipeline"]);
    expect(JSON.stringify(a)).not.toContain(SECRET_PARAM);
    expect(JSON.stringify(a)).not.toContain("helse-domene");
    const b = await readAutonomy(db.appPool, TENANT_B);
    expect(b.rows.map((r) => r.domain)).toEqual(["b-domene"]);
    expect(b.health_count).toBe(0);
    expect(b.situation_domains).toEqual(["b-situasjon"]);
  });

  it("minnerom-RLS er default deny: uten jarvis.memory_spaces er autonomi-bindinger og situasjoner usynlige selv med riktig tenant", async () => {
    const counts = await tenantRead(db.appPool, TENANT_A, async (query) => ({
      policies: Number((await query("SELECT count(*)::int AS n FROM situation_autonomy_policies"))[0]?.["n"]),
      situations: Number((await query("SELECT count(*)::int AS n FROM situations"))[0]?.["n"])
    }));
    expect(counts).toEqual({ policies: 0, situations: 0 });
  });

  it("domene-pauser leses globalt uten begrunnelsestekst", async () => {
    const rows = await readDomainPauses(db.appPool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "sales", paused_by: idA.person_id });
    expect(JSON.stringify(rows)).not.toContain(SECRET_REASON);
  });

  it("finans-nødbryter per tenant: A er på, B har ingen rad (= av)", async () => {
    expect(await readFinanceKillSwitch(db.appPool, TENANT_A)).toMatchObject({ enabled: true });
    expect(await readFinanceKillSwitch(db.appPool, TENANT_B)).toEqual({ enabled: false, enabled_at: null });
  });

  it("åpne bekreftelser: kun egen tenant og kun pending; sammendrag/parametre leses aldri", async () => {
    const a = await readPendingConfirmations(db.appPool, TENANT_A);
    expect(a.map((c) => c.confirmation_id)).toEqual(["conf-a-pending"]);
    expect(a[0]).toMatchObject({ tool_id: "email", action: "send", taint_reasons: ["untrusted_output:email.read_inbox"] });
    expect(JSON.stringify(a)).not.toContain(SECRET_SUMMARY);
    expect((await readPendingConfirmations(db.appPool, TENANT_B)).map((c) => c.confirmation_id)).toEqual(["conf-b-pending"]);
  });
});

describe("hele senteret mot ekte data", () => {
  it("A: enheter, delegater, autonomi, brytere og pauser fra ekte tabeller - og ingen innhold lekker", async () => {
    const r = await report(idA);
    expect(sec(r, "authority").status).toBe("OK");
    expect(item(r, "authority", "delegates").facts).toMatchObject({ other_person_devices: 1, other_person_active_grants: 2 });
    expect(item(r, "devices", "dev-ac-del").facts).toMatchObject({ delegated: true, active_grants: 2 });
    expect(item(r, "devices", "dev-ac-cur").facts).toMatchObject({ current_device: true });
    expect(r.actions.map((a) => a.id).filter((id) => id.startsWith("authority.revoke_device:")).sort()).toEqual(["authority.revoke_device:dev-ac-del", "authority.revoke_device:dev-ac-phone"]);
    expect(item(r, "autonomy", "business:finance")).toMatchObject({ status: "OK", facts: { tool: "finance_spend", action: "sync_internal_spend", enabled: true } });
    expect(sec(r, "autonomy").summary_no).toContain("1 i health-rommet");
    expect(item(r, "switches", "kill_switch")).toMatchObject({ status: "OK", facts: { active: false } });
    expect(item(r, "switches", "finance_kill_switch")).toMatchObject({ status: "WARN", facts: { enabled: true } });
    expect(item(r, "pauses", "domain:sales").status).toBe("WARN");
    expect(item(r, "pauses", "frozen:github").status).toBe("WARN");
    expect(item(r, "pauses", "frozen:model:anthropic").status).toBe("WARN");
    expect(item(r, "pauses", "revoked:JARVIS_EMAIL_TOKEN").status).toBe("WARN");
    expect(item(r, "confirmations", "conf-a-pending")).toMatchObject({ status: "WARN", facts: { tool: "email", action: "send", expired: false } });
    expect(r.sections.filter((s) => !s.measured)).toEqual([]);
    const json = JSON.stringify(r);
    for (const forbidden of [SECRET_PARAM, SECRET_REASON, SECRET_SUMMARY, "BEGIN PUBLIC KEY", "fp-hemmelig", "privat situasjonsgrunn", "helse-domene", "conf-b-pending", "b-domene", "dev-ac-b"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("B ser kun sine egne tall: ingen av A sine enheter, bindinger eller bekreftelser er synlige", async () => {
    const r = await report(idB);
    expect(sec(r, "devices").items.map((i) => i.id)).toEqual(["dev-ac-b"]);
    expect(sec(r, "autonomy").items.map((i) => i.id)).toEqual(["business:b-domene"]);
    expect(sec(r, "confirmations").items.map((i) => i.id)).toEqual(["conf-b-pending"]);
    expect(item(r, "switches", "finance_kill_switch").status).toBe("OK");
    const json = JSON.stringify(r);
    for (const forbidden of ["dev-ac-cur", "dev-ac-del", "conf-a-pending", "finance_spend:", "person-ac-delegate"]) expect(json, forbidden).not.toContain(forbidden);
  });

  it("senteret skriver ingenting: radtallet i alle berørte tabeller er uendret etter bygging", async () => {
    const tables = ["devices", "session_grants", "sessions", "situation_autonomy_policies", "situations", "situation_domain_pauses", "finance_kill_switch", "action_confirmations", "owner_control_state", "audit_events", "tool_executions"];
    const count = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = Number(((await db.adminPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n);
      return out;
    };
    const before = await count();
    await report(idA);
    await report(idB);
    expect(await count()).toEqual(before);
  });

  it("en bruker uten tenant-kontekst ser ingenting: RLS gjelder for app-rollen selv uten tenant-filteret i spørringen", async () => {
    const client: pg.PoolClient = await db.appPool.connect();
    try {
      for (const t of ["devices", "session_grants", "action_confirmations"]) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect((rows[0] as { n: number }).n, t).toBe(0);
      }
    } finally {
      client.release();
    }
  });
});
