import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import {
  BusinessInternalSecretProvider, BusinessService, BusinessTransport, ChurnService, OpenLoopService, ProductUsageService, ScoringService
} from "../src/index.ts";

/**
 * WP-D2 (UA-3 «churn/product usage» + JARVIS-045): verktøyflaten for churn-oversikt, kalibreringsrapport, kobling konto -> selskap og lukking med utfall - gjennom ToolGateway mot
 * EKTE Postgres som APP-ROLLE (RLS). Dekker:
 *  A. get_churn_overview (klasse A, aldri pseudonymer, skjema-grenser, scope), B. get_calibration_report (ren lesing), C. link_product_account (klasse B, forsvar i dybden),
 *  D. resolve_open_loop med utfall (klasse C, kun suveren eier), E. kundebildet viser churn-vurderingen i klartekst.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let business: BusinessService;
let openLoops: OpenLoopService;
let churn: ChurnService;
let usage: ProductUsageService;
let transport: BusinessTransport;
let gateway: ToolGateway;

const BIZ = "tenant-wpd2-act";
const BIZ_B = "tenant-wpd2-act-b";
const PERSON_TENANT = "tenant-wpd2-act-person";
const OWNER = "person-wpd2-act-owner";
const MEMBER = "person-wpd2-act-member";
const SP = "business" as const;
const DAY = 86_400_000;

const ownerIdentity: IdentityContext = { person_id: OWNER, tenant_id: BIZ, memory_space_id: "business", session_id: "sess-act", device_id: "dev-act", channel: "api", auth_strength: "active" };
const memberIdentity: IdentityContext = { ...ownerIdentity, person_id: MEMBER };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-actions-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_act LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_act");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Act', 'business'), ('${BIZ_B}', 'Act B', 'business'), ('${PERSON_TENANT}', 'Person', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${MEMBER}', 'Medlem');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${BIZ}'), ('${MEMBER}', '${BIZ}'), ('${OWNER}', '${BIZ_B}'), ('${OWNER}', '${PERSON_TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-biz', '${BIZ}', 'business'), ('ms-a-bizb', '${BIZ_B}', 'business'), ('ms-a-pers', '${PERSON_TENANT}', 'personal');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_act", password: "pw2" });
  business = new BusinessService(app);
  openLoops = new OpenLoopService(app);
  churn = new ChurnService(app);
  usage = new ProductUsageService(app);
  const scoring = new ScoringService(app);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [BIZ] } });
  gateway = new ToolGateway(app, policy, new FallbackSecretProvider({ name: "none", get: async () => null }, new BusinessInternalSecretProvider()));
  transport = new BusinessTransport(business, openLoops, app, gateway, scoring);
  for (const tool of firstWaveTools({ business: transport })) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const exec = (identity: IdentityContext, action: string, parameters: Record<string, unknown>) =>
  gateway.execute({ identity, tool_id: "business", action, parameters: parameters as never });
const count = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const ago = (days: number): string => new Date(Date.now() - days * DAY - 60_000).toISOString();
const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n");
const importEvents = (events: unknown[]) => usage.importText(BIZ, "jsonl", "act", jsonl(events), { actor_person_id: OWNER });
interface AtRiskRow { company_id: string; company_name: string | null; risk_score: number; risk_level: string; signals: string[]; metrics: Record<string, unknown> }
interface OverviewData { rule_version: string; at_risk: AtRiskRow[]; linked_accounts: number; assessed_accounts: number; unlinked_accounts: number; note: string }
interface CalibrationData { by_type: Array<{ loop_type: string }>; notes: string[] }
interface CustomerOverviewData { churn_risk: unknown[] }
const dataOf = <T>(r: unknown): T => (r as { data: T }).data;

const ACCT_HIGH = "acct-act-high-01";
const ACCT_MID = "acct-act-mid-001";
const ACCT_ORPHAN = "acct-act-orphan-1";
let coHigh = "";
let coMid = "";

describe("A: get_churn_overview (klasse A) - hvem risikerer vi å miste, aldri pseudonymer", () => {
  it("setter opp: inaktiv konto + åpen supportsak (høy), 33 dagers stillhet (middels), og en ukoblet konto", async () => {
    coHigh = (await business.createCompany(BIZ, SP, { name: "Risiko AS" })).company_id;
    coMid = (await business.createCompany(BIZ, SP, { name: "Middels AS" })).company_id;
    await importEvents([
      { event_id: "act-evt-000001", account_ref: ACCT_HIGH, feature: "chat.send", occurred_at: ago(40) },
      { event_id: "act-evt-000002", account_ref: ACCT_HIGH, feature: "chat.send", occurred_at: ago(38) },
      { event_id: "act-evt-000003", account_ref: ACCT_MID, feature: "chat.send", occurred_at: ago(33) },
      { event_id: "act-evt-000004", account_ref: ACCT_ORPHAN, feature: "chat.send", occurred_at: ago(50) }
    ]);
    await usage.linkAccount(BIZ, SP, ACCT_HIGH, coHigh, OWNER);
    await usage.linkAccount(BIZ, SP, ACCT_MID, coMid, OWNER);
    await admin.query("INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, status, priority) VALUES ('tkt-act-0001', $1, $2, 'Hjelp', 'open', 'normal')", [BIZ, coHigh]);
    await openLoops.detectChurnRisk(BIZ, SP);
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1", [BIZ])).toBe(2);
  });

  it("returnerer selskapsnavn, score, signaler i klartekst og mål - høyest risiko først - med tellere for koblede/vurderte/ukoblede kontoer", async () => {
    const res = await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business" });
    expect(res.ok).toBe(true);
    const d = dataOf<OverviewData>(res);
    expect(d.rule_version).toBe("churn_risk_v1");
    expect(d.at_risk.map((a) => a.company_name)).toEqual(["Risiko AS", "Middels AS"]);
    expect(d.at_risk[0]).toMatchObject({ company_id: coHigh, risk_score: 55, risk_level: "high", signals: ["Ingen produktbruk på 38 dager", "1 åpen supportsak"] });
    expect(d.at_risk[0]?.metrics).toMatchObject({ days_since_last_usage: 38, open_support_tickets: 1, overdue_invoices: null }); // null = ingen faktureringsdata (ikke «0 forfalt»)
    expect(d.at_risk[1]).toMatchObject({ company_id: coMid, risk_score: 45, risk_level: "medium" });
    expect(d).toMatchObject({ linked_accounts: 2, assessed_accounts: 2, unlinked_accounts: 1 });
    expect(d.note).toContain("forslag");
  });

  it("ALDRI pseudonymer: verken konto- eller bruker-referanser finnes i svaret (ubetrodd webhook-innhold når ikke modellen)", async () => {
    const res = await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business", min_level: "medium", limit: 50 });
    const dump = JSON.stringify(res);
    for (const ref of [ACCT_HIGH, ACCT_MID, ACCT_ORPHAN, "account_ref", "user_ref"]) expect(dump, ref).not.toContain(ref);
    // heller ikke i kundebildet
    const overview = JSON.stringify(await exec(ownerIdentity, "get_customer_overview", { tenant_id: BIZ, memory_space: "business", company_id: coHigh }));
    for (const ref of [ACCT_HIGH, ACCT_MID]) expect(overview, ref).not.toContain(ref);
  });

  it("min_level høy filtrerer bort middels; limit begrenser; standard er middels", async () => {
    const high = dataOf<OverviewData>(await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business", min_level: "high" }));
    expect(high.at_risk.map((a) => a.company_name)).toEqual(["Risiko AS"]);
    const one = dataOf<OverviewData>(await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business", limit: 1 }));
    expect(one.at_risk).toHaveLength(1);
  });

  it("ugyldige parametre avvises av skjemaet (strict) FØR tjenesten: nivå 'low', limit utenfor 1-50, ukjente felt", async () => {
    for (const bad of [{ min_level: "low" }, { min_level: "critical" }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { evil: true }, { account_ref: ACCT_HIGH }]) {
      const r = await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business", ...bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, reason: "invalid_parameters" });
    }
  });

  it("transporten avviser selv et ugyldig nivå (forsvar i dybden utover skjemaet)", async () => {
    await expect(transport.invoke("get_churn_overview", { tenant_id: BIZ, memory_space: "business", min_level: "low" }, undefined, { identity: ownerIdentity } as never)).rejects.toThrow(/min_level_invalid/);
  });

  it("scope: en annen tenant i parametrene enn identitetens avvises av gatewayen; en annen tenant ser ingenting av denne", async () => {
    expect(await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ_B, memory_space: "business" })).toMatchObject({ ok: false, reason: "scope_mismatch:tenant_id" });
    const b = await churn.overview(BIZ_B, SP);
    expect(b).toMatchObject({ at_risk: [], linked_accounts: 0, assessed_accounts: 0, unlinked_accounts: 0 });
    // person-tenanten har ingen produktkontoer og feiler ikke
    expect(await churn.overview(PERSON_TENANT, "business")).toMatchObject({ at_risk: [], linked_accounts: 0 });
  });

  it("er ren lesing: ingen rader endres av å hente oversikten", async () => {
    const snap = async () => JSON.stringify([
      (await admin.query("SELECT account_ref, risk_score, calculated_at FROM business_churn_assessments WHERE tenant_id = $1 ORDER BY 1", [BIZ])).rows,
      (await admin.query("SELECT open_loop_id, updated_at FROM business_open_loops WHERE tenant_id = $1 ORDER BY 1", [BIZ])).rows,
      (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type LIKE 'business.%'", [BIZ])).rows
    ]);
    const before = await snap();
    await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business" });
    await exec(ownerIdentity, "get_churn_overview", { tenant_id: BIZ, memory_space: "business", min_level: "high", limit: 3 });
    expect(await snap()).toBe(before);
  });
});

describe("B: get_calibration_report (klasse A) - forutsagt mot utfall, endrer ingenting", () => {
  it("rapporten teller merkede utfall per loop-type; andre tenanter påvirker den ikke; skjemagrenser for since_days", async () => {
    const seed = async (tenant: string, outcome: "acted" | "dismissed", n: number) => {
      for (let i = 0; i < n; i += 1) {
        await admin.query(
          `INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason, status, resolved_at, resolution_reason, resolution_outcome, confidence, opened_at)
           VALUES ($1, $2, 'overdue_followup', $3, 'seed', 'resolved', now(), 'Seedet', $4, 0.9, now() - interval '5 days')`,
          [`ol-act-${tenant}-${outcome}-${i}`, tenant, `seed:${tenant}:${outcome}:${i}`, outcome]
        );
      }
    };
    await seed(BIZ, "acted", 12);
    await seed(BIZ, "dismissed", 8);
    await seed(BIZ_B, "dismissed", 30);
    const res = await exec(ownerIdentity, "get_calibration_report", { tenant_id: BIZ, memory_space: "business", since_days: 90 });
    expect(res.ok).toBe(true);
    const t = dataOf<CalibrationData>(res).by_type.find((x) => x.loop_type === "overdue_followup");
    expect(t).toMatchObject({ n_acted: 12, n_dismissed: 8, n_labelled: 20, hit_rate: 0.6, mean_confidence: 0.9, gap: 0.3, verdict: "overconfident", heuristic: false });
    expect(dataOf<CalibrationData>(res).notes.join(" ")).toContain("NEEDS_TOBIAS");
    for (const bad of [{ since_days: 3 }, { since_days: 2000 }, { since_days: 30.5 }, { loop_type: "x" }]) {
      expect(await exec(ownerIdentity, "get_calibration_report", { tenant_id: BIZ, memory_space: "business", ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, reason: "invalid_parameters" });
    }
    expect(await exec(ownerIdentity, "get_calibration_report", { tenant_id: BIZ_B, memory_space: "business" })).toMatchObject({ ok: false, reason: "scope_mismatch:tenant_id" });
  });

  it("ren lesing: confidence/utfall på loopene er uendret etter henting", async () => {
    const snap = async () => JSON.stringify((await admin.query("SELECT open_loop_id, confidence, resolution_outcome, updated_at FROM business_open_loops WHERE tenant_id = $1 ORDER BY 1", [BIZ])).rows);
    const before = await snap();
    await exec(ownerIdentity, "get_calibration_report", { tenant_id: BIZ, memory_space: "business" });
    expect(await snap()).toBe(before);
  });
});

describe("C: link_product_account (klasse B) - eierens kobling konto -> selskap", () => {
  const link = (identity: IdentityContext, params: Record<string, unknown>) => exec(identity, "link_product_account", { tenant_id: BIZ, memory_space: "business", ...params });

  it("kobler en konto, er idempotent, flytter til et annet selskap (forrige id returneres) og skriver revisjon uten pseudonymet", async () => {
    const REF = "acct-act-link-001";
    const first = await link(ownerIdentity, { account_ref: REF, company_id: coHigh });
    expect(first).toMatchObject({ ok: true, data: { changed: true, company_id: coHigh, previous_company_id: null } });
    expect(await link(ownerIdentity, { account_ref: REF, company_id: coHigh })).toMatchObject({ ok: true, data: { changed: false } });
    expect(await link(ownerIdentity, { account_ref: REF, company_id: coMid })).toMatchObject({ ok: true, data: { changed: true, company_id: coMid, previous_company_id: coHigh } });
    const audit = await admin.query("SELECT payload, person_id FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_account_linked' ORDER BY audit_id DESC LIMIT 2", [BIZ]);
    expect(audit.rowCount).toBe(2);
    for (const row of audit.rows as Array<{ payload: unknown; person_id: string }>) {
      expect(JSON.stringify(row.payload)).not.toContain(REF);
      expect(row.person_id).toBe(OWNER);
    }
  });

  it("en ikke-suveren medlem kan koble (klasse B), og aktøren i revisjonen er identitetens person - ikke noe modellen oppgir", async () => {
    const r = await link(memberIdentity, { account_ref: "acct-act-link-002", company_id: coHigh });
    expect(r).toMatchObject({ ok: true, data: { changed: true } });
    expect((await admin.query("SELECT linked_by FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = 'acct-act-link-002'", [BIZ])).rows[0]).toEqual({ linked_by: MEMBER });
  });

  it("ukjent/fremmed selskap, ugyldig referanse (e-post/kort) og ukjente felt avvises uten å skrive", async () => {
    const before = await count("SELECT count(*)::int AS n FROM product_usage_accounts WHERE tenant_id = $1", [BIZ]);
    const coB = await business.createCompany(BIZ_B, SP, { name: "Fremmed AS" });
    expect(await link(ownerIdentity, { account_ref: "acct-act-link-003", company_id: "biz-co-finnes-ikke" })).toMatchObject({ ok: false, reason: expect.stringContaining("company_not_found") });
    expect(await link(ownerIdentity, { account_ref: "acct-act-link-003", company_id: coB.company_id })).toMatchObject({ ok: false, reason: expect.stringContaining("company_not_found") });
    expect(await link(ownerIdentity, { account_ref: "ola.nordmann@example.com", company_id: coHigh })).toMatchObject({ ok: false, reason: expect.stringContaining("invalid_input") });
    for (const bad of [{ account_ref: "kort", company_id: coHigh }, { account_ref: "acct-act-link-004" }, { account_ref: "acct-act-link-004", company_id: coHigh, owner_person_id: "x" }, { account_ref: 5, company_id: coHigh }]) {
      expect(await link(ownerIdentity, bad), JSON.stringify(bad)).toMatchObject({ ok: false, reason: "invalid_parameters" });
    }
    expect(await count("SELECT count(*)::int AS n FROM product_usage_accounts WHERE tenant_id = $1", [BIZ])).toBe(before);
  });

  it("scope: gatewayen avviser fremmed tenant; transporten avviser det selv (forsvar i dybden) og nekter å skrive i en person-tenant", async () => {
    expect(await exec(ownerIdentity, "link_product_account", { tenant_id: BIZ_B, memory_space: "business", account_ref: "acct-act-link-005", company_id: coHigh })).toMatchObject({ ok: false, reason: "scope_mismatch:tenant_id" });
    await expect(transport.invoke("link_product_account", { tenant_id: BIZ_B, memory_space: "business", account_ref: "acct-act-link-005", company_id: coHigh }, undefined, { identity: ownerIdentity } as never)).rejects.toThrow(/scope_mismatch/);
    const personIdentity: IdentityContext = { ...ownerIdentity, tenant_id: PERSON_TENANT, memory_space_id: "personal" };
    const r = await exec(personIdentity, "link_product_account", { tenant_id: PERSON_TENANT, memory_space: "business", account_ref: "acct-act-link-006", company_id: "biz-co-x" });
    expect(r.ok).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_accounts WHERE tenant_id = $1", [PERSON_TENANT])).toBe(0);
  });

  it("en ny kobling fjerner gamle vurderinger for kontoen (de hørte til en annen kunde) - neste sveip beregner på nytt", async () => {
    const REF = "acct-act-link-007";
    await importEvents([{ event_id: "act-evt-100001", account_ref: REF, feature: "chat.send", occurred_at: ago(36) }]);
    expect(await link(ownerIdentity, { account_ref: REF, company_id: coHigh })).toMatchObject({ ok: true });
    await openLoops.detectChurnRisk(BIZ, SP);
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = $2 AND company_id = $3", [BIZ, REF, coHigh])).toBe(1);
    expect(await link(ownerIdentity, { account_ref: REF, company_id: coMid })).toMatchObject({ ok: true, data: { changed: true } });
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = $2", [BIZ, REF])).toBe(0);
  });
});

describe("D: resolve_open_loop med utfall (klasse C) - kalibreringsgrunnlag, kun suveren eier", () => {
  const makeLoop = async (title: string): Promise<string> => {
    const co = await business.createCompany(BIZ, SP, { name: `Lukk ${title} AS` });
    const fu = await business.createFollowup(BIZ, SP, { title, company_id: co.company_id, due_at: new Date(Date.now() - 3 * DAY).toISOString() });
    await openLoops.detectOverdueFollowups(BIZ, SP);
    return ((await openLoops.listOpenLoops(BIZ, SP, "open")).find((l) => l.followup_id === fu.followup_id))!.open_loop_id;
  };
  const row = async (id: string) => (await admin.query("SELECT status, resolution_outcome, resolution_reason FROM business_open_loops WHERE open_loop_id = $1", [id])).rows[0];

  it("eier: outcome 'acted' og 'dismissed' lagres; uten outcome er lukkingen umerket (null)", async () => {
    const a = await makeLoop("A");
    const d = await makeLoop("D");
    const n = await makeLoop("N");
    expect(await exec(ownerIdentity, "resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: a, resolution_reason: "Ringte kunden", outcome: "acted" })).toMatchObject({ ok: true, data: { resolution_outcome: "acted" } });
    expect(await exec(ownerIdentity, "resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: d, resolution_reason: "Ikke relevant", outcome: "dismissed" })).toMatchObject({ ok: true, data: { resolution_outcome: "dismissed" } });
    expect(await exec(ownerIdentity, "resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: n, resolution_reason: "Ferdig" })).toMatchObject({ ok: true, data: { resolution_outcome: null, status: "resolved" } });
    expect(await row(a)).toMatchObject({ status: "resolved", resolution_outcome: "acted" });
  });

  it("ugyldig utfall (condition_cleared er forbeholdt sveipet, 'won', tom streng) avvises av skjemaet OG av transporten, og loopen forblir åpen", async () => {
    const id = await makeLoop("Ugyldig");
    for (const bad of ["condition_cleared", "won", "", "ACTED"]) {
      expect(await exec(ownerIdentity, "resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: id, resolution_reason: "x", outcome: bad }), bad).toMatchObject({ ok: false, reason: "invalid_parameters" });
      await expect(transport.invoke("resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: id, resolution_reason: "x", outcome: bad }, undefined, { identity: ownerIdentity } as never), bad).rejects.toThrow(/outcome/);
    }
    expect((await row(id))["status"]).toBe("open");
  });

  it("klasse C: en ikke-suveren medlem avvises (class_c_no_mandate) og ingenting lukkes", async () => {
    const id = await makeLoop("Medlem");
    expect(await exec(memberIdentity, "resolve_open_loop", { tenant_id: BIZ, memory_space: "business", open_loop_id: id, resolution_reason: "x", outcome: "acted" })).toMatchObject({ ok: false, reason: "class_c_no_mandate" });
    expect((await row(id))["status"]).toBe("open");
  });
});

describe("E: kundebildet viser churn-vurderingen i klartekst (uten pseudonymer)", () => {
  it("get_customer_overview har churn_risk med score, nivå og signaler; et selskap uten koblet konto har en tom liste", async () => {
    const withChurn = await business.customerOverview(BIZ, SP, coHigh);
    expect(withChurn?.churn_risk.length).toBeGreaterThanOrEqual(1);
    expect(withChurn?.churn_risk[0]).toMatchObject({ risk_level: "high", signals: ["Ingen produktbruk på 38 dager", "1 åpen supportsak"] });
    const none = await business.createCompany(BIZ, SP, { name: "Uten konto AS" });
    expect((await business.customerOverview(BIZ, SP, none.company_id))?.churn_risk).toEqual([]);
    const viaTool = await exec(ownerIdentity, "get_customer_overview", { tenant_id: BIZ, memory_space: "business", company_id: coHigh });
    expect(viaTool.ok).toBe(true);
    expect(dataOf<CustomerOverviewData>(viaTool).churn_risk.length).toBeGreaterThanOrEqual(1);
    // en annen tenants selskap-id gir ingenting (RLS)
    expect(await business.customerOverview(BIZ_B, SP, coHigh)).toBeNull();
  });
});
