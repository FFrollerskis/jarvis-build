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
  BusinessInternalSecretProvider, BusinessPipelineError, BusinessPipelineService, BusinessService, BusinessTransport, OpenLoopService, ScoringService
} from "../src/index.ts";

/**
 * WP-D2 (JARVIS-049): lead-/mulighetsoppdatering mot EKTE Postgres som APP-ROLLE (RLS). Dekker:
 *  A. kun business-tenant + business-space, B. opprett (idempotens), C/D. oppdater (validering, no-op, referanser), E. neste handling, F. stadium/status,
 *  G. lukk med utfall, H. sletting (detach/rydd/RLS), I. samtidig idempotens, J. gjennom ToolGateway (klasse B/C, før/etter-evidens uten fritekst).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let pipeline: BusinessPipelineService;
let business: BusinessService;
let openLoops: OpenLoopService;
let scoring: ScoringService;
let gateway: ToolGateway;

const BIZ = "tenant-wpd2-biz";
const BIZ_B = "tenant-wpd2-biz-b";
const PERSON_TENANT = "tenant-wpd2-person";
const OWNER = "person-wpd2-owner";
const MEMBER = "person-wpd2-member";
const OUTSIDER = "person-wpd2-outsider";
const SP = "business" as const;

const ownerIdentity: IdentityContext = { person_id: OWNER, tenant_id: BIZ, memory_space_id: "business", session_id: "sess-wpd2", device_id: "dev-wpd2", channel: "api", auth_strength: "active" };
const scopedIdentity: IdentityContext = { ...ownerIdentity, person_id: MEMBER };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-pipeline-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_pipe LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_pipe");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Biz', 'business'), ('${BIZ_B}', 'Biz B', 'business'), ('${PERSON_TENANT}', 'Person', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${MEMBER}', 'Medlem'), ('${OUTSIDER}', 'Utenforstående');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${BIZ}'), ('${MEMBER}', '${BIZ}'), ('${OWNER}', '${PERSON_TENANT}'), ('${OWNER}', '${BIZ_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-w-biz', '${BIZ}', 'business'), ('ms-w-bizb', '${BIZ_B}', 'business'), ('ms-w-pers', '${PERSON_TENANT}', 'personal');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_pipe", password: "pw2" });
  pipeline = new BusinessPipelineService(app);
  business = new BusinessService(app);
  openLoops = new OpenLoopService(app);
  scoring = new ScoringService(app);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [BIZ] } });
  gateway = new ToolGateway(app, policy, new FallbackSecretProvider({ name: "none", get: async () => null }, new BusinessInternalSecretProvider()));
  for (const tool of firstWaveTools({ business: new BusinessTransport(business, openLoops, app, gateway, scoring) })) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const count = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const logRows = (tenant: string, entityId: string) => admin.query("SELECT action, changed_fields, before_state, after_state, idempotency_key, actor_person_id FROM business_change_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at", [tenant, entityId]).then((r) => r.rows as Array<{ action: string; changed_fields: string[]; before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null; idempotency_key: string | null; actor_person_id: string | null }>);
const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toBeInstanceOf(BusinessPipelineError); await expect(p).rejects.toMatchObject({ code }); };

describe("A: skriving KUN i en bedrifts-tenant og business-space", () => {
  it("person-tenant og ikke-business space avvises for ALLE pipeline-skrivinger, og ingenting skrives", async () => {
    const ctx = { actor_person_id: OWNER };
    const calls: Array<() => Promise<unknown>> = [
      () => pipeline.createLead(PERSON_TENANT, "personal", { title: "x" }, ctx),
      () => pipeline.createOpportunity(PERSON_TENANT, "personal", { title: "x" }, ctx),
      () => pipeline.updateLead(PERSON_TENANT, "personal", "biz-ld-x", { title: "y" }, ctx),
      () => pipeline.setLeadStatus(PERSON_TENANT, "personal", "biz-ld-x", "qualified", ctx),
      () => pipeline.moveOpportunityStage(PERSON_TENANT, "personal", "biz-op-x", "won", undefined, ctx),
      () => pipeline.closeLead(PERSON_TENANT, "personal", "biz-ld-x", { outcome: "converted" }, ctx),
      () => pipeline.deleteOpportunity(PERSON_TENANT, "personal", "biz-op-x", ctx),
      () => pipeline.setNextAction(PERSON_TENANT, "personal", "lead", "biz-ld-x", { next_action: "ring" }, ctx)
    ];
    for (const call of calls) await rejects(call(), "not_business_space");
    // riktig space, men person-tenant: avvist på tenant-typen (kind)
    for (const call of [
      () => pipeline.createLead(PERSON_TENANT, SP, { title: "x" }, ctx),
      () => pipeline.deleteLead(PERSON_TENANT, SP, "biz-ld-x", ctx)
    ]) await rejects(call(), "not_business_tenant");
    // andre spaces i en bedrifts-tenant
    for (const space of ["project", "shared", "health"] as const) await rejects(pipeline.createLead(BIZ, space, { title: "x" }, ctx), "not_business_space");
    expect(await count("SELECT count(*)::int AS n FROM business_leads WHERE tenant_id = $1", [PERSON_TENANT])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM business_change_log WHERE tenant_id IN ($1, $2)", [PERSON_TENANT, BIZ])).toBe(0);
  });
});

describe("B: opprett - før/etter-logg og idempotens", () => {
  it("createLead logger create (før null, etter full rad) med aktør; samme kilde-hendelse gir samme lead uten ny logg", async () => {
    const a = await pipeline.createLead(BIZ, SP, { title: "Interessert i X", source_type: "web", source_instance_id: "form-1", external_id: "e-1" }, { actor_person_id: OWNER });
    expect(a).toMatchObject({ changed: true, replayed: false, changed_fields: ["created"] });
    const lead = a.entity as unknown as { lead_id: string; status: string };
    expect(lead.status).toBe("new");
    const again = await pipeline.createLead(BIZ, SP, { title: "Annen tittel", source_type: "web", source_instance_id: "form-1", external_id: "e-1" }, { actor_person_id: OWNER });
    expect((again.entity as unknown as { lead_id: string }).lead_id).toBe(lead.lead_id);
    expect(again.changed).toBe(false);
    const log = await logRows(BIZ, lead.lead_id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "create", before_state: null, actor_person_id: OWNER, changed_fields: ["created"] });
    expect(log[0]?.after_state).toMatchObject({ lead_id: lead.lead_id, title: "Interessert i X", status: "new" });
  });

  it("idempotency_key: samme nøkkel = samme lead og ÉN logg-rad; samme nøkkel med annet innhold avvises; ugyldig nøkkel avvises", async () => {
    const key = "wpd2-create-opp-0001";
    const first = await pipeline.createOpportunity(BIZ, SP, { title: "Avtale Y", value_ore: 500_000, expected_close_date: "2026-12-01" }, { idempotency_key: key, actor_person_id: OWNER });
    const second = await pipeline.createOpportunity(BIZ, SP, { title: "Avtale Y", value_ore: 500_000, expected_close_date: "2026-12-01" }, { idempotency_key: key, actor_person_id: OWNER });
    expect(second).toMatchObject({ replayed: true, changed: false });
    expect((second.entity as unknown as { opportunity_id: string }).opportunity_id).toBe((first.entity as unknown as { opportunity_id: string }).opportunity_id);
    expect(await count("SELECT count(*)::int AS n FROM business_opportunities WHERE tenant_id = $1 AND title = 'Avtale Y'", [BIZ])).toBe(1);
    await rejects(pipeline.createOpportunity(BIZ, SP, { title: "Avtale Y", value_ore: 999 }, { idempotency_key: key }), "idempotency_key_conflict");
    for (const bad of ["kort", "har mellomrom i seg", "x".repeat(129), "with;semicolon-1234"]) {
      await rejects(pipeline.createLead(BIZ, SP, { title: "z" }, { idempotency_key: bad }), "idempotency_key_invalid");
    }
    expect(await count("SELECT count(*)::int AS n FROM business_leads WHERE tenant_id = $1 AND title = 'z'", [BIZ])).toBe(0);
  });

  it("validering ved opprettelse: tom/lang/kontrolltegn-tittel, ukjent status/stadium, ugyldig beløp/valuta/dato/id avvises", async () => {
    for (const input of [{ title: "" }, { title: "a".repeat(301) }, { title: "ny\nlinje" }, { title: 5 }, { title: "ok", status: "nonsense" }, { title: "ok", company_id: "x y" }]) {
      await rejects(pipeline.createLead(BIZ, SP, input as never), "invalid_input");
    }
    for (const input of [{ title: "ok", stage: "bogus" }, { title: "ok", value_ore: -1 }, { title: "ok", value_ore: 1.5 }, { title: "ok", value_ore: 2_147_483_648 }, { title: "ok", currency: "nok" }, { title: "ok", expected_close_date: "2026-02-30" }, { title: "ok", expected_close_date: "morgen" }]) {
      await rejects(pipeline.createOpportunity(BIZ, SP, input as never), "invalid_input");
    }
  });
});

describe("C/D: oppdater lead og opportunity", () => {
  it("endrer kun oppgitte felt; før/etter + endrede felt i loggen; no-op skriver ingenting og rører ikke updated_at", async () => {
    const created = await pipeline.createLead(BIZ, SP, { title: "Opprinnelig", source: "web" }, { actor_person_id: OWNER });
    const id = (created.entity as unknown as { lead_id: string }).lead_id;
    const r = await pipeline.updateLead(BIZ, SP, id, { title: "Nytt navn", source: null }, { actor_person_id: OWNER });
    expect(r).toMatchObject({ changed: true, changed_fields: expect.arrayContaining(["title", "source"]) });
    expect(r.entity).toMatchObject({ title: "Nytt navn", source: null });
    const log = await logRows(BIZ, id);
    expect(log.map((l) => l.action)).toEqual(["create", "update"]);
    expect(log[1]?.before_state).toMatchObject({ title: "Opprinnelig", source: "web" });
    expect(log[1]?.after_state).toMatchObject({ title: "Nytt navn", source: null });
    const before = await admin.query("SELECT updated_at FROM business_leads WHERE lead_id = $1", [id]);
    const noop = await pipeline.updateLead(BIZ, SP, id, { title: "Nytt navn" }, { actor_person_id: OWNER });
    expect(noop).toMatchObject({ changed: false, replayed: false, change_id: null, changed_fields: [] });
    expect((await admin.query("SELECT updated_at FROM business_leads WHERE lead_id = $1", [id])).rows[0]).toEqual(before.rows[0]);
    expect((await logRows(BIZ, id)).length).toBe(2);
  });

  it("avviser tom patch, ukjente/ikke-endrebare felt (status, tenant_id, id, owner_person_id), tomt obligatorisk felt og kontrolltegn", async () => {
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Valider" })).entity as unknown as { lead_id: string }).lead_id;
    for (const patch of [{}, { status: "qualified" }, { tenant_id: BIZ_B }, { lead_id: "x" }, { owner_person_id: OUTSIDER }, { title: null }, { title: "" }, { title: "a\u0000b" }, { surprise: 1 }, null, [], "str"]) {
      await rejects(pipeline.updateLead(BIZ, SP, id, patch as never), "invalid_input");
    }
    expect((await admin.query("SELECT title, status FROM business_leads WHERE lead_id = $1", [id])).rows[0]).toEqual({ title: "Valider", status: "new" });
  });

  it("referanser: selskap i ANNEN tenant og ukjente id-er avvises (tenant-skopet FK); ansvarlig må være medlem av tenanten", async () => {
    const mine = await business.createCompany(BIZ, SP, { name: "Min Kunde" });
    const foreign = await business.createCompany(BIZ_B, SP, { name: "Fremmed Kunde" });
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Kobling" })).entity as unknown as { lead_id: string }).lead_id;
    await expect(pipeline.updateLead(BIZ, SP, id, { company_id: mine.company_id })).resolves.toMatchObject({ changed: true });
    await rejects(pipeline.updateLead(BIZ, SP, id, { company_id: foreign.company_id }), "reference_not_found");
    await rejects(pipeline.updateLead(BIZ, SP, id, { company_id: "biz-co-finnes-ikke" }), "reference_not_found");
    await rejects(pipeline.updateLead(BIZ, SP, id, { assign_to_person_id: OUTSIDER }), "reference_not_found");
    await expect(pipeline.updateLead(BIZ, SP, id, { assign_to_person_id: MEMBER })).resolves.toMatchObject({ changed: true });
    expect((await admin.query("SELECT company_id, owner_person_id FROM business_leads WHERE lead_id = $1", [id])).rows[0]).toEqual({ company_id: mine.company_id, owner_person_id: MEMBER });
    // null fjerner koblingen
    await expect(pipeline.updateLead(BIZ, SP, id, { company_id: null, assign_to_person_id: null })).resolves.toMatchObject({ changed: true });
  });

  it("updateOpportunity: beløp/valuta/dato/lead-kobling; grenser og formater håndheves", async () => {
    const lead = ((await pipeline.createLead(BIZ, SP, { title: "For opp" })).entity as unknown as { lead_id: string }).lead_id;
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Opp 1" })).entity as unknown as { opportunity_id: string }).opportunity_id;
    const r = await pipeline.updateOpportunity(BIZ, SP, opp, { value_ore: 123_456, currency: "EUR", expected_close_date: "2027-03-04", lead_id: lead }, { actor_person_id: OWNER });
    expect(r.changed_fields.sort()).toEqual(["currency", "expected_close_date", "lead_id", "value_ore"]);
    expect(r.entity).toMatchObject({ value_ore: 123_456, currency: "EUR", expected_close_date: "2027-03-04", lead_id: lead });
    for (const patch of [{ value_ore: -5 }, { value_ore: 1e12 }, { currency: "euro" }, { expected_close_date: "2027-13-01" }, { currency: null }, { stage: "won" }]) {
      await rejects(pipeline.updateOpportunity(BIZ, SP, opp, patch as never), "invalid_input");
    }
    await expect(pipeline.updateOpportunity(BIZ, SP, opp, { value_ore: null, expected_close_date: null })).resolves.toMatchObject({ changed: true });
  });

  it("ukjent entitet gir not_found, og en annen tenant kan ikke endre (eller se) den", async () => {
    await rejects(pipeline.updateLead(BIZ, SP, "biz-ld-finnes-ikke", { title: "x" }), "not_found");
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Kun A" })).entity as unknown as { lead_id: string }).lead_id;
    await rejects(pipeline.updateLead(BIZ_B, SP, id, { title: "Kapret" }), "not_found");
    await rejects(pipeline.deleteLead(BIZ_B, SP, id), "not_found");
    expect(await pipeline.inspect(BIZ_B, SP, "lead", id)).toBeNull();
    expect((await admin.query("SELECT title FROM business_leads WHERE lead_id = $1", [id])).rows[0]).toEqual({ title: "Kun A" });
  });
});

describe("E: neste handling", () => {
  it("setter, endrer og fjerner paret; frist krever tekst; ugyldig frist/tekst avvises; stagnert-regelen respekterer en planlagt neste handling", async () => {
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Stagnert Opp" })).entity as unknown as { opportunity_id: string }).opportunity_id;
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const r = await pipeline.setNextAction(BIZ, SP, "opportunity", opp, { next_action: "Ring og avklar", next_action_due_at: due }, { actor_person_id: OWNER });
    expect(r.entity).toMatchObject({ next_action: "Ring og avklar" });
    expect(r.changed_fields.sort()).toEqual(["next_action", "next_action_due_at"]);
    // gammel opportunity uten planlagt neste handling -> stagnert; med planlagt neste handling i fremtiden -> ikke stagnert
    await admin.query("UPDATE business_opportunities SET updated_at = now() - interval '30 days' WHERE opportunity_id = $1", [opp]);
    await openLoops.detectStalledOpportunities(BIZ, SP);
    expect((await openLoops.listOpenLoops(BIZ, SP, "open")).filter((l) => l.opportunity_id === opp)).toHaveLength(0);
    await admin.query("UPDATE business_opportunities SET next_action_due_at = now() - interval '1 day' WHERE opportunity_id = $1", [opp]); // frist passert
    await openLoops.detectStalledOpportunities(BIZ, SP);
    expect((await openLoops.listOpenLoops(BIZ, SP, "open")).filter((l) => l.opportunity_id === opp)).toHaveLength(1);
    // fjerne paret
    const cleared = await pipeline.setNextAction(BIZ, SP, "opportunity", opp, { next_action: null }, { actor_person_id: OWNER });
    expect(cleared.entity).toMatchObject({ next_action: null, next_action_due_at: null });
    for (const bad of [{ next_action: null, next_action_due_at: due }, { next_action: "", next_action_due_at: due }, { next_action: "x".repeat(501) }, { next_action: "ok", next_action_due_at: "i morgen" }, { next_action: "ok\nlinje" }, { next_action: 5 }]) {
      await rejects(pipeline.setNextAction(BIZ, SP, "opportunity", opp, bad as never), "invalid_input");
    }
    await rejects(pipeline.setNextAction(BIZ, SP, "company" as never, opp, { next_action: "x" }), "invalid_input");
    await rejects(pipeline.setNextAction(BIZ, SP, "lead", "biz-ld-finnes-ikke", { next_action: "x" }), "not_found");
  });

  it("customerOverview viser neste handling på åpne muligheter", async () => {
    const company = await business.createCompany(BIZ, SP, { name: "Overblikk AS" });
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Overblikk-opp", company_id: company.company_id })).entity as unknown as { opportunity_id: string }).opportunity_id;
    await pipeline.setNextAction(BIZ, SP, "opportunity", opp, { next_action: "Send tilbud" });
    const overview = await business.customerOverview(BIZ, SP, company.company_id);
    expect(overview?.open_opportunities[0]).toMatchObject({ opportunity_id: opp, next_action: "Send tilbud" });
  });
});

describe("F/G: stadium, status og lukking med utfall", () => {
  it("stadium/status: lukketidspunkt settes ved terminal og nullstilles ved gjenåpning; verdi kan settes samtidig; samme verdi er no-op", async () => {
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Stadium" })).entity as unknown as { opportunity_id: string }).opportunity_id;
    const won = await pipeline.moveOpportunityStage(BIZ, SP, opp, "won", 777_000, { actor_person_id: OWNER });
    expect(won.entity).toMatchObject({ stage: "won", value_ore: 777_000 });
    expect((won.entity as unknown as { closed_at: string | null }).closed_at).not.toBeNull();
    expect((await pipeline.moveOpportunityStage(BIZ, SP, opp, "won")).changed).toBe(false);
    const reopened = await pipeline.moveOpportunityStage(BIZ, SP, opp, "negotiation", undefined, { actor_person_id: OWNER });
    expect(reopened.entity).toMatchObject({ stage: "negotiation", closed_at: null, close_reason: null, value_ore: 777_000 });
    await rejects(pipeline.moveOpportunityStage(BIZ, SP, opp, "bogus"), "invalid_input");
    await rejects(pipeline.moveOpportunityStage(BIZ, SP, opp, "won", -1), "invalid_input");
    const lead = ((await pipeline.createLead(BIZ, SP, { title: "Status" })).entity as unknown as { lead_id: string }).lead_id;
    const dq = await pipeline.setLeadStatus(BIZ, SP, lead, "disqualified");
    expect((dq.entity as unknown as { closed_at: string | null }).closed_at).not.toBeNull();
    expect((await pipeline.setLeadStatus(BIZ, SP, lead, "contacted")).entity).toMatchObject({ status: "contacted", closed_at: null });
    await rejects(pipeline.setLeadStatus(BIZ, SP, lead, "won"), "invalid_input");
    expect((await logRows(BIZ, opp)).map((l) => l.action)).toEqual(["create", "move_stage", "move_stage"]);
  });

  it("closeOpportunity: utfall + grunn + endelig verdi, tidslinje-hendelse (én gang), omlukking med annet utfall nullstiller gammel grunn", async () => {
    const company = await business.createCompany(BIZ, SP, { name: "Lukk AS" });
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Lukk meg", company_id: company.company_id, value_ore: 100 })).entity as unknown as { opportunity_id: string }).opportunity_id;
    const r = await pipeline.closeOpportunity(BIZ, SP, opp, { outcome: "won", reason: "Signert i dag", final_value_ore: 900_000 }, { actor_person_id: OWNER, idempotency_key: "wpd2-close-opp-0001" });
    expect(r.entity).toMatchObject({ stage: "won", close_reason: "Signert i dag", value_ore: 900_000 });
    const replay = await pipeline.closeOpportunity(BIZ, SP, opp, { outcome: "won", reason: "Signert i dag", final_value_ore: 900_000 }, { actor_person_id: OWNER, idempotency_key: "wpd2-close-opp-0001" });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    const timeline = await business.companyTimeline(BIZ, SP, company.company_id);
    expect(timeline.filter((t) => t.summary === "Mulighet lukket som won")).toHaveLength(1);
    const relost = await pipeline.closeOpportunity(BIZ, SP, opp, { outcome: "lost" });
    expect(relost.entity).toMatchObject({ stage: "lost", close_reason: null });
    await rejects(pipeline.closeOpportunity(BIZ, SP, opp, { outcome: "negotiation" }), "invalid_input");
    await rejects(pipeline.closeOpportunity(BIZ, SP, opp, { outcome: "won", reason: "" }), "invalid_input");
    await rejects(pipeline.closeOpportunity(BIZ, SP, "biz-op-finnes-ikke", { outcome: "won" }), "not_found");
  });

  it("closeLead: converted/disqualified med grunn; ugyldig utfall avvises; tidslinjehendelse skrives i samme transaksjon", async () => {
    const company = await business.createCompany(BIZ, SP, { name: "Lead-lukk AS" });
    const lead = ((await pipeline.createLead(BIZ, SP, { title: "Lukk lead", company_id: company.company_id })).entity as unknown as { lead_id: string }).lead_id;
    const r = await pipeline.closeLead(BIZ, SP, lead, { outcome: "disqualified", reason: "Ikke målgruppe" }, { actor_person_id: OWNER });
    expect(r.entity).toMatchObject({ status: "disqualified", close_reason: "Ikke målgruppe" });
    expect((await business.companyTimeline(BIZ, SP, company.company_id)).some((t) => t.summary === "Lead lukket som disqualified")).toBe(true);
    await rejects(pipeline.closeLead(BIZ, SP, lead, { outcome: "won" }), "invalid_input");
    await rejects(pipeline.closeLead(BIZ, SP, lead, { outcome: "converted", reason: "x".repeat(501) }), "invalid_input");
    expect((await pipeline.closeLead(BIZ, SP, lead, { outcome: "disqualified", reason: "Ikke målgruppe" })).changed).toBe(false);
  });
});

describe("H: sletting - detach, rydd derivert, bevar før-tilstand, RLS", () => {
  it("deleteLead detacher muligheter/oppfølginger/aktiviteter, fjerner open loops og score, og bevarer full før-tilstand i loggen", async () => {
    const company = await business.createCompany(BIZ, SP, { name: "Slett AS" });
    const lead = ((await pipeline.createLead(BIZ, SP, { title: "Slett meg", company_id: company.company_id })).entity as unknown as { lead_id: string }).lead_id;
    const opp = await business.createOpportunity(BIZ, SP, { title: "Lenket opp", lead_id: lead, company_id: company.company_id });
    const fu = await business.createFollowup(BIZ, SP, { title: "Forfalt", lead_id: lead, company_id: company.company_id, due_at: new Date(Date.now() - 4 * 86_400_000).toISOString() });
    const act = await business.recordActivity(BIZ, SP, { activity_type: "note", summary: "Notat", lead_id: lead, company_id: company.company_id });
    await openLoops.detectOverdueFollowups(BIZ, SP);
    await scoring.recalculateLeadScore(BIZ, SP, lead);
    expect(await count("SELECT count(*)::int AS n FROM business_scores WHERE entity_id = $1", [lead])).toBe(1);
    const key = "wpd2-delete-lead-0001";
    const del = await pipeline.deleteLead(BIZ, SP, lead, { actor_person_id: OWNER, idempotency_key: key });
    expect(del).toMatchObject({ deleted: true, entity_id: lead, replayed: false, detached: { opportunities: 1, followups: 1, activities: 1 } });
    expect(del.removed.scores).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM business_leads WHERE lead_id = $1", [lead])).toBe(0);
    expect((await admin.query("SELECT lead_id FROM business_opportunities WHERE opportunity_id = $1", [opp.opportunity_id])).rows[0]).toEqual({ lead_id: null });
    expect((await admin.query("SELECT lead_id FROM business_followups WHERE followup_id = $1", [fu.followup_id])).rows[0]).toEqual({ lead_id: null });
    expect((await admin.query("SELECT lead_id FROM business_activities WHERE activity_id = $1", [act.activity_id])).rows[0]).toEqual({ lead_id: null });
    expect(await count("SELECT count(*)::int AS n FROM business_scores WHERE entity_id = $1", [lead])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM business_open_loops WHERE lead_id = $1", [lead])).toBe(0);
    const log = await logRows(BIZ, lead);
    expect(log.map((l) => l.action)).toEqual(["create", "delete"]);
    expect(log[1]?.before_state).toMatchObject({ lead_id: lead, title: "Slett meg" });
    // samme nøkkel igjen: replay, ikke en ny sletting/feil
    const replay = await pipeline.deleteLead(BIZ, SP, lead, { idempotency_key: key });
    expect(replay).toMatchObject({ deleted: true, replayed: true, entity_id: lead });
    // uten nøkkel: raden finnes ikke lenger
    await rejects(pipeline.deleteLead(BIZ, SP, lead), "not_found");
  });

  it("deleteOpportunity fjerner deriverte stagnasjons-loops og beholder oppfølgingen (uten peker)", async () => {
    const opp = ((await pipeline.createOpportunity(BIZ, SP, { title: "Slett opp" })).entity as unknown as { opportunity_id: string }).opportunity_id;
    const fu = await business.createFollowup(BIZ, SP, { title: "Beholdes", opportunity_id: opp, due_at: new Date(Date.now() + 86_400_000).toISOString() });
    await admin.query("UPDATE business_opportunities SET updated_at = now() - interval '40 days' WHERE opportunity_id = $1", [opp]);
    await admin.query("UPDATE business_followups SET status = 'cancelled', cancelled_at = now() WHERE followup_id = $1", [fu.followup_id]);
    await openLoops.detectStalledOpportunities(BIZ, SP);
    expect(await count("SELECT count(*)::int AS n FROM business_open_loops WHERE opportunity_id = $1", [opp])).toBe(1);
    const del = await pipeline.deleteOpportunity(BIZ, SP, opp, { actor_person_id: OWNER });
    expect(del.removed.open_loops).toBe(1);
    expect(del.detached.followups).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM business_followups WHERE followup_id = $1", [fu.followup_id])).toBe(1);
  });
});

describe("I: samtidig idempotens", () => {
  it("fem samtidige updateLead med SAMME nøkkel gir nøyaktig én endring og én logg-rad (resten er replay)", async () => {
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Samtidig" })).entity as unknown as { lead_id: string }).lead_id;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => pipeline.updateLead(BIZ, SP, id, { title: "Samtidig - ny" }, { idempotency_key: "wpd2-concurrent-0001", actor_person_id: OWNER })));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(4);
    expect(new Set(results.map((r) => r.change_id)).size).toBe(1);
    expect((await logRows(BIZ, id)).filter((l) => l.action === "update")).toHaveLength(1);
  });

  it("samme nøkkel brukt av en ANNEN entitet/handling med annet innhold avvises", async () => {
    const a = ((await pipeline.createLead(BIZ, SP, { title: "Nøkkel A" })).entity as unknown as { lead_id: string }).lead_id;
    const b = ((await pipeline.createLead(BIZ, SP, { title: "Nøkkel B" })).entity as unknown as { lead_id: string }).lead_id;
    await pipeline.updateLead(BIZ, SP, a, { title: "A2" }, { idempotency_key: "wpd2-shared-key-01" });
    await rejects(pipeline.updateLead(BIZ, SP, b, { title: "A2" }, { idempotency_key: "wpd2-shared-key-01" }), "idempotency_key_conflict");
    await rejects(pipeline.updateLead(BIZ, SP, a, { title: "A3" }, { idempotency_key: "wpd2-shared-key-01" }), "idempotency_key_conflict");
  });
});

describe("J: gjennom ToolGateway - klasse B/C, før/etter-evidens uten fritekst, scope", () => {
  const exec = (identity: IdentityContext, action: string, parameters: Record<string, unknown>, idempotency_key?: string) =>
    gateway.execute({ identity, tool_id: "business", action, parameters: parameters as never, ...(idempotency_key ? { idempotency_key } : {}) });

  it("eier (suveren i tenanten): update_lead (B) og close_lead (C) virker; C gir før/etter-snapshot i audit UTEN tittel/fritekst", async () => {
    const created = await exec(ownerIdentity, "create_lead", { tenant_id: BIZ, memory_space: "business", title: "Hemmelig Tittel Med Navn" });
    expect(created.ok).toBe(true);
    const leadId = (created as { external_id: string }).external_id;
    const upd = await exec(ownerIdentity, "update_lead", { tenant_id: BIZ, memory_space: "business", lead_id: leadId, source: "messe", idempotency_key: "wpd2-gw-update-0001" });
    expect(upd).toMatchObject({ ok: true });
    expect((upd as unknown as { data: { changed: boolean } }).data.changed).toBe(true);
    const closed = await exec(ownerIdentity, "close_lead", { tenant_id: BIZ, memory_space: "business", lead_id: leadId, outcome: "converted", reason: "Fritekst-grunn som ikke skal i audit" }, "gw-close-0001");
    expect(closed).toMatchObject({ ok: true });
    const audit = await admin.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'close_lead' AND type = 'tool.executed'", [BIZ]);
    expect(audit.rowCount).toBe(1);
    const payload = JSON.stringify((audit.rows[0] as { payload: unknown }).payload);
    expect(payload).toContain("before_state");
    expect(payload).toContain("after_state");
    expect(payload).toContain("title_sha256_12");
    expect(payload).not.toContain("Hemmelig Tittel");
    expect(payload).not.toContain("Fritekst-grunn");
    const payloadObj = (audit.rows[0] as { payload: { before_state: { status: string }; after_state: { status: string } } }).payload;
    expect(payloadObj.before_state.status).toBe("new");
    expect(payloadObj.after_state.status).toBe("converted");
    // gateway-ledger: samme gateway-nøkkel igjen = dedupe (ingen ny utførelse)
    const again = await exec(ownerIdentity, "close_lead", { tenant_id: BIZ, memory_space: "business", lead_id: leadId, outcome: "converted", reason: "Fritekst-grunn som ikke skal i audit" }, "gw-close-0001");
    expect(again).toMatchObject({ ok: true, deduplicated: true });
  });

  it("scope: tenant_id i parametrene som ikke er identitetens tenant avvises av gatewayen; klasse C uten suverenitet avvises (class_c_no_mandate); klasse B går", async () => {
    const mismatch = await exec(ownerIdentity, "update_lead", { tenant_id: BIZ_B, memory_space: "business", lead_id: "biz-ld-x", title: "x" });
    expect(mismatch).toMatchObject({ ok: false, reason: "scope_mismatch:tenant_id" });
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Scoped" })).entity as unknown as { lead_id: string }).lead_id;
    const c = await exec(scopedIdentity, "delete_lead", { tenant_id: BIZ, memory_space: "business", lead_id: id });
    expect(c).toMatchObject({ ok: false, reason: "class_c_no_mandate" });
    expect(await count("SELECT count(*)::int AS n FROM business_leads WHERE lead_id = $1", [id])).toBe(1);
    const b = await exec(scopedIdentity, "update_lead", { tenant_id: BIZ, memory_space: "business", lead_id: id, title: "Scoped ok" });
    expect(b).toMatchObject({ ok: true });
    // aktør i loggen er identitetens person, ikke noe modellen kan oppgi
    expect((await logRows(BIZ, id)).at(-1)).toMatchObject({ action: "update", actor_person_id: MEMBER });
  });

  it("ugyldige/ukjente parametre avvises av skjemaet (strict) FØR tjenesten: eksterne felt, assign_to_person_id som tall, for kort nøkkel", async () => {
    const id = ((await pipeline.createLead(BIZ, SP, { title: "Skjema" })).entity as unknown as { lead_id: string }).lead_id;
    for (const extra of [{ evil: 1 }, { assign_to_person_id: 5 }, { idempotency_key: "kort" }, { title: "" }, { status: "converted" }]) {
      const r = await exec(ownerIdentity, "update_lead", { tenant_id: BIZ, memory_space: "business", lead_id: id, ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ ok: false, reason: "invalid_parameters" });
    }
    const wrongSpace = await exec({ ...ownerIdentity, memory_space_id: "personal" }, "update_lead", { tenant_id: BIZ, memory_space: "personal", lead_id: id, title: "x" });
    expect(wrongSpace.ok).toBe(false);
    expect((await admin.query("SELECT title FROM business_leads WHERE lead_id = $1", [id])).rows[0]).toEqual({ title: "Skjema" });
  });

  it("eksisterende handlinger er bakoverkompatible: update_lead_status returnerer raden, og null data for ukjent lead (ikke feil)", async () => {
    const created = await exec(ownerIdentity, "create_lead", { tenant_id: BIZ, memory_space: "business", title: "Bakover" });
    const leadId = (created as { external_id: string }).external_id;
    const st = await exec(ownerIdentity, "update_lead_status", { tenant_id: BIZ, memory_space: "business", lead_id: leadId, status: "qualified" });
    expect(st).toMatchObject({ ok: true, data: { lead_id: leadId, status: "qualified" } });
    const unknown = await exec(ownerIdentity, "update_lead_status", { tenant_id: BIZ, memory_space: "business", lead_id: "biz-ld-ukjent", status: "qualified" });
    expect(unknown).toMatchObject({ ok: true, data: null });
  });
});
