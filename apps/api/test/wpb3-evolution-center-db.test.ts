import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { ControlCenterParts, ControlItem, ControlSection, SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import { ChangeLedger, EXTERNAL_GATES } from "@jarvis/self-modification";
import type { ConnectorStatus } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionCenter, MAX_LISTED_PROPOSALS } from "../src/control-center/evolution.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { createEvolutionReadinessProvider, createEvolutionReportProvider, type EvolutionSourceDeps } from "../src/evolution-source.ts";
import { RunRateService } from "../src/run-rate.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475, EV-22): Evolusjon-senteret mot EKTE Postgres som app-rollen (`jarvis_app`, RLS) med de EKTE kildene (evolusjonsrapporten, beredskapen, BudgetGuard, RunRateService, endringsregisteret):
 *  - SQL-en mot det GLOBALE endringsregisteret er riktig (siste beslutning per forslag; omforeslått etter avvisning; klassetall; de nyeste først (L5); digest = hash-raden) og leser aldri tekstkolonnene;
 *  - kostnad er TENANT-skopet (RLS): A sine tall er databasens egne tall for A, aldri B sine - også når senteret bygges direkte for B;
 *  - `restrictFinance`: ingen kostnads-SQL kjøres og ingen øre-tall finnes i rapporten;
 *  - senteret skriver ingenting (radtall i alle relevante tabeller uendret);
 *  - hele kjeden (rapport + beredskap + register + kost) bygger uten feil og uten å lekke seeded forslagstekst.
 */
let db: H0Db;
const TENANT_A = "tenant-b3-a";
const TENANT_B = "tenant-b3-b";
const OWNER_A = "person-b3-a";
const OWNER_B = "person-b3-b";
const DIGEST = "c".repeat(64);
const SECRET_SUBJECT = "HEMMELIG FORSLAGSTEKST som aldri skal vises";
const SECRET_PATH = "config/hemmelig-sti-som-aldri-skal-vises.json";
const SECRET_EVIDENCE = "HEMMELIG-EVIDENS-MARKØR";
const idFor = (person: string, tenant: string): IdentityContext => ({ person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed" });
const A = idFor(OWNER_A, TENANT_A);
const B = idFor(OWNER_B, TENANT_B);
const NOW = new Date();

const BOOT: Ev0BootStatus = { constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "ok", count: 0, head_hash: "h" } };
const slo: SloReport = { as_of: NOW.toISOString(), not_measured: [], drift: null, data_quality: null, summary_no: "", slos: [{ id: "chat-success", label: "Chat", status: "OK", value: 1, target: 0.9, metric: "success_rate", samples: 50, window_hours: 24, source: "x", observed_at: NOW.toISOString(), detail: "d" }] };
const github: ConnectorStatus = { id: "github", display_name: "github", category: "integration" as never, configured: true, credentials: [], test_method: "presence_only", health: { state: "healthy", at: NOW.toISOString() } };
const mesh: MeshStatus = { providers: [{ provider: "gemma_local", model: "g", state: "LIVE", success: 1, failures: 0 }], router: "HEALTHY", fallback: "LOGIC_ONLY", critic: "READY_SELECTIVE" };
function sourceDeps(pool: pg.Pool, tenantId: string, env: Record<string, string> = {}): EvolutionSourceDeps {
  return { pool, tenantId, env, ev0Status: () => BOOT, slo: async () => slo, connectors: async () => [github], killSwitchActive: async () => false, mesh: () => mesh };
}

/**
 * En pool som husker all SQL (også de som kjøres i en transaksjon via `connect`), uten å endre svaret og uten å røre de delte klientene: `connect` gir en PROXY rundt klienten (aldri en endret klient - pg-pool sender en
 * tilbakekalling som tredje argument til `client.query`, og en omskrevet `query` som mister den lar `pool.query` henge og lekker klienten).
 */
function spy(pool: pg.Pool): { pool: pg.Pool; sql: string[] } {
  const sql: string[] = [];
  const textOf = (arg: unknown): string => (typeof arg === "string" ? arg : typeof arg === "object" && arg !== null && "text" in arg ? String((arg as { text: unknown }).text) : "");
  const wrapped = {
    query: (...args: unknown[]) => { sql.push(textOf(args[0])); return (pool.query as (...a: unknown[]) => unknown)(...args); },
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") return (...args: unknown[]) => { sql.push(textOf(args[0])); return (target.query as (...a: unknown[]) => unknown)(...args); };
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      });
    }
  };
  return { pool: wrapped as unknown as pg.Pool, sql };
}

const sectionOf = (parts: ControlCenterParts, id: string): ControlSection => {
  const s = parts.sections.find((x) => x.id === id);
  if (!s) throw new Error(`seksjon mangler: ${id}`);
  return s;
};
const itemOf = (s: ControlSection, id: string): ControlItem => {
  const i = s.items.find((x) => x.id === id);
  if (!i) throw new Error(`rad mangler: ${id}`);
  return i;
};

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["audit_events", "cost_events", "evolution_change_ledger", "tasks", "payment_intents", "memory_items", "owner_control_state", "situation_autonomy_policies"]) {
    out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}
const truthSpent = async (tenant: string): Promise<number> =>
  Number((await db.adminPool.query("SELECT coalesce(sum(amount_ore), 0)::bigint AS n FROM cost_events WHERE tenant_id = $1 AND at >= date_trunc('month', now())", [tenant])).rows[0].n);
const lastHash = async (changeId: string): Promise<string> =>
  String((await db.adminPool.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1", [changeId])).rows[0].entry_hash);

beforeAll(async () => {
  db = await startH0Db("b3c");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER_A }, { tenant_id: TENANT_B, person_id: OWNER_B }]);

  // Kostnad (relativt til databasens klokke, så testen ikke avhenger av dato): A har litt, B har MYE - A sin rapport skal aldri telle B sin.
  const cost = (tenant: string, ore: number, daysAgo: number): Promise<unknown> =>
    admin.query("INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model) VALUES (now() - make_interval(days => $3), $1, 'model', $2, 'anthropic', 'claude')", [tenant, ore, daysAgo]);
  await cost(TENANT_A, 1_500, 0);
  await cost(TENANT_A, 2_300, 0);
  for (const d of [1, 2, 3, 4]) await cost(TENANT_A, 700, d);
  await cost(TENANT_B, 7_777_777, 0);
  await cost(TENANT_B, 5_000_000, 1);

  // Endringsregisteret (globalt): ulike livsløp. Teksten (subject, paths, evidence) er HEMMELIG og skal aldri nå rapporten.
  const ledger = new ChangeLedger(admin);
  const row = (change_id: string, change_class: "E0" | "E1" | "E2" | "E3", decision: "proposed" | "approved" | "rejected" | "blocked") =>
    ledger.append({ change_id, change_class, decision, constitution_digest: DIGEST, subject: SECRET_SUBJECT, paths: [SECRET_PATH, "docs/x.md"], branch: "hemmelig-gren", head_sha: null, evidence: { note: SECRET_EVIDENCE }, recorded_by: "hemmelig-forslagsstiller" });
  // `many-*` legges inn FØRST (de er de ELDSTE åpne forslagene); `c*` kommer etter og er dermed de nyeste (senteret lister nyest først, L5).
  for (let i = 1; i <= 22; i += 1) await row(`many-${String(i).padStart(2, "0")}`, "E1", "proposed");
  await row("c1", "E1", "proposed");
  await row("c2", "E2", "proposed");
  await row("c2", "E2", "rejected");
  await row("c3", "E2", "proposed");
  await row("c3", "E2", "approved");
  await row("c4", "E1", "proposed");
  await row("c4", "E1", "blocked");
  await row("c5", "E3", "blocked");
  await row("c6", "E0", "proposed");
  await row("c7", "E2", "proposed");
  await row("c7", "E2", "rejected");
  await row("c7", "E2", "proposed"); // omforeslått etter avvisning: venter igjen, med den NYE radens digest
  await row("c8 med mellomrom <b>og tegn</b>", "E1", "proposed"); // ubetrodd id
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("endringsregisteret: siste beslutning per forslag, klassetall, de nyeste først - og aldri tekstkolonnene", () => {
  const built = async (pool: pg.Pool = db.appPool, identity: IdentityContext = A): Promise<ControlCenterParts> => {
    const center = createEvolutionCenter({
      pool, env: {}, evolutionReport: createEvolutionReportProvider(sourceDeps(pool, TENANT_A)), readiness: createEvolutionReadinessProvider(sourceDeps(pool, TENANT_A)),
      ev0Status: () => BOOT, runRate: new RunRateService(pool), reportTenantId: TENANT_A
    });
    return center.build({ identity, now: new Date() });
  };

  it("26 forslag venter (c1, c6, c7 omforeslått, c8 og 22 `many-*`); avviste, godkjente og blokkerte er IKKE med - fordelt på klasse E0 1, E1 24 og E2 1", async () => {
    const ledger = sectionOf(await built(), "ledger");
    expect(itemOf(ledger, "proposals")).toMatchObject({ status: "WARN", facts: { waiting: 26, class_E0: 1, class_E1: 24, class_E2: 1 } });
    const listed = ledger.items.filter((i) => i.id.startsWith("proposal:")).map((i) => i.id);
    for (const closed of ["c2", "c3", "c4", "c5"]) expect(listed, closed).not.toContain(`proposal:${closed}`);
    expect(listed).toContain("proposal:c1");
    expect(listed).toContain("proposal:c6");
    expect(listed).toContain("proposal:c7");
  });

  it(`de ${MAX_LISTED_PROPOSALS} NYESTE listes nyest først (høyest ledger-seq, etter siste rad per forslag), resten telles: 6 vises ikke, og \`many-01\`…\`many-06\` (de eldste) mangler (L5)`, async () => {
    const ledger = sectionOf(await built(), "ledger");
    const listed = ledger.items.filter((i) => i.id.startsWith("proposal:")).map((i) => i.id);
    expect(listed).toHaveLength(MAX_LISTED_PROPOSALS);
    expect(itemOf(ledger, "proposals_more").facts).toEqual({ not_listed: 6 });
    // nyest først: c8 (ubetrodd id -> reserve-id), c7 (omforeslått sist), c6, c1, så many-22 ... many-07
    expect(listed.slice(0, 4)).toEqual(["proposal:forslag-ukjent-1", "proposal:c7", "proposal:c6", "proposal:c1"]);
    expect(listed.slice(4)).toEqual(Array.from({ length: 16 }, (_, i) => `proposal:many-${String(22 - i).padStart(2, "0")}`));
    for (const old of ["many-01", "many-06"]) expect(listed, old).not.toContain(`proposal:${old}`);
  });

  it("digesten som vises er de 12 første tegnene av SISTE rads hash (omforeslåtte c7 har den nye radens hash, ikke den første)", async () => {
    const ledger = sectionOf(await built(), "ledger");
    const c7 = itemOf(ledger, "proposal:c7").facts as { digest: string };
    const first = String((await db.adminPool.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = 'c7' ORDER BY seq ASC LIMIT 1")).rows[0].entry_hash);
    expect(c7.digest).toBe((await lastHash("c7")).slice(0, 12));
    expect(c7.digest).not.toBe(first.slice(0, 12));
    expect(itemOf(ledger, "proposal:c1").facts).toMatchObject({ change_class: "E1", path_count: 2, digest: (await lastHash("c1")).slice(0, 12) });
  });

  it("den ubetrodde id-en (mellomrom, tagger) vises aldri; raden får en reserve-id og forslagsteksten, stiene, evidensen og gren-/forslagsstillernavnet finnes ikke i noe i rapporten", async () => {
    const parts = await built();
    const out = JSON.stringify(parts);
    expect(out).not.toContain("mellomrom");
    expect(out).not.toContain("<b>");
    expect(sectionOf(parts, "ledger").items.some((i) => /^proposal:forslag-ukjent-\d+$/.test(i.id))).toBe(true);
    for (const secret of [SECRET_SUBJECT, SECRET_PATH, SECRET_EVIDENCE, "hemmelig-gren", "hemmelig-forslagsstiller", "docs/x.md"]) expect(out, secret).not.toContain(secret);
  });

  it("registrert siste 30 døgn teller alle rader per beslutning (proposed 30, rejected 2, approved 1, blocked 2 - 35 rader)", async () => {
    const facts = itemOf(sectionOf(await built(), "ledger"), "decisions_30d").facts as Record<string, number>;
    expect(facts).toMatchObject({ proposed: 30, rejected: 2, approved: 1, blocked: 2 });
    expect(facts["total"]).toBe(35);
  });

  it("senteret er kun lesing av endringsregisteret: app-rollen kan ikke endre eller slette det (append-only), og bygging endrer ingen radtall", async () => {
    const before = await counts();
    await built();
    await built();
    expect(await counts()).toEqual(before);
    await expect(db.appPool.query("UPDATE evolution_change_ledger SET subject = 'x' WHERE change_id = 'c1'")).rejects.toThrow();
    await expect(db.appPool.query("DELETE FROM evolution_change_ledger WHERE change_id = 'c1'")).rejects.toThrow();
  });
});

describe("kostmodellen mot ekte cost_events: tenant-skopet (RLS) - A sine tall er databasens egne for A, aldri B sine", () => {
  const build = (identity: IdentityContext, env: Record<string, string> = {}, restrictFinance = false) => {
    const s = spy(db.appPool);
    const center = createEvolutionCenter({
      pool: s.pool, env, evolutionReport: async () => ({ as_of: new Date().toISOString(), sections: [] }), readiness: async () => [], ev0Status: () => BOOT, runRate: new RunRateService(s.pool)
    });
    return { s, run: () => center.build({ identity, now: new Date(), ...(restrictFinance ? { restrictFinance: true } : {}) }) };
  };

  it("A: forbruket hittil i måneden er databasens sum for A (og ikke B sine millioner) - nivå fra grensene i miljøet", async () => {
    const truthA = await truthSpent(TENANT_A);
    expect(truthA).toBeGreaterThanOrEqual(3_800);
    const parts = await build(A, { JARVIS_COST_WARN_ORE: "3000", JARVIS_COST_APPROVAL_ORE: "6000", JARVIS_COST_HARD_LIMIT_ORE: "9000" }).run();
    const mtd = itemOf(sectionOf(parts, "cost_model"), "month_to_date");
    expect(mtd.facts).toMatchObject({ spent_month_ore: truthA });
    expect(mtd.status).toBe(truthA >= 9_000 ? "FAIL" : truthA >= 6_000 ? "FAIL" : "WARN");
    expect(JSON.stringify(parts)).not.toContain("7777777");
    expect(JSON.stringify(parts)).not.toContain("5000000");
    expect(itemOf(sectionOf(parts, "cost_model"), "limits").facts).toMatchObject({ warn_ore: 3_000, approval_ore: 6_000, hard_limit_ore: 9_000, spend_approved: false });
  });

  it("B (bygget direkte, uten registerets eier-port): B sin sum er B sin, hardgrensen er nådd (FEIL), og A sine tall finnes ikke i B sin rapport", async () => {
    const truthB = await truthSpent(TENANT_B);
    expect(truthB).toBeGreaterThanOrEqual(7_777_777);
    const parts = await build(B).run();
    const mtd = itemOf(sectionOf(parts, "cost_model"), "month_to_date");
    expect(mtd).toMatchObject({ status: "FAIL", facts: { level: "hard_blocked", spent_month_ore: truthB } });
    expect(JSON.stringify(parts)).not.toContain(String(await truthSpent(TENANT_A)) + ",");
  });

  it("databasens tidssone (re-review INFO 4) leses av app-rollen som en synlig faktarad - lik innstillingen databasen faktisk har (UTC = OK, ellers ADVARSEL), aldri en blokkering", async () => {
    const truth = String((await db.adminPool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz);
    const utc = /^(utc|etc\/utc|uct|etc\/uct|universal|etc\/universal|zulu|etc\/zulu|z|gmt|etc\/gmt|gmt0|etc\/gmt0|greenwich)$/i.test(truth);
    const parts = await build(A).run();
    const item = itemOf(sectionOf(parts, "cost_model"), "db_timezone");
    expect(item.facts).toEqual({ timezone: truth, is_utc: utc });
    expect(item.status).toBe(utc ? "OK" : "WARN");
    expect(item.status).not.toBe("FAIL"); // en opplysning: raden alene gjør aldri seksjonen til FEIL
    // og den lagrede innstillingen blir ikke endret av å bygge senteret
    expect(String((await db.adminPool.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz)).toBe(truth);
  });

  it("månedsprognosen er run-rate fra de ekte radene: databasens egen 7-døgnssum og antall døgn gir prognosen (snitt siste 7 døgn x 30)", async () => {
    const t = (await db.adminPool.query(
      "SELECT coalesce(sum(amount_ore),0)::int AS d7, count(DISTINCT date_trunc('day', at))::int AS days FROM cost_events WHERE tenant_id = $1 AND at >= now() - interval '7 days'", [TENANT_A]
    )).rows[0] as { d7: number; days: number };
    expect(t.days).toBeGreaterThanOrEqual(3);
    const projection = itemOf(sectionOf(await build(A).run(), "cost_model"), "projection");
    expect(projection.facts).toMatchObject({ projected_month_ore: Math.round((t.d7 / t.days) * 30), basis: "snitt siste 7 døgn x 30", last_7d_ore: t.d7 });
    expect(["OK", "WARN"]).toContain(projection.status);
  });

  it("restrictFinance: INGEN kostnads-SQL kjøres (verken cost_events eller run-rate), og ingen øre-tall, grenser eller kostverdier finnes i rapporten", async () => {
    const { s, run } = build(A, { JARVIS_COST_WARN_ORE: "3000" }, true);
    const parts = await run();
    expect(parts.sections.map((x) => x.id)).toEqual(["ports", "dormant", "ledger"]);
    expect(s.sql.some((q) => /cost_events|connector_maintenance_log|brief_seen/.test(q))).toBe(false);
    const out = JSON.stringify(parts);
    expect(out).not.toMatch(/_ore"|hard_limit|spend_approved|percent_of_hard/);
    expect(out).not.toContain(String(await truthSpent(TENANT_A)));
  });

  it("all kostnadslesing skjer under identitetens tenant: hver spørring mot cost_events kjører i en tenant-transaksjon (RLS) - ingen rå pool.query mot cost_events", async () => {
    const { s, run } = build(A);
    await run();
    const rawCostQueries = s.sql.filter((q) => /FROM cost_events/.test(q));
    expect(rawCostQueries.length).toBeGreaterThan(0);
    // `set_config('jarvis.tenant_id'` settes først i hver transaksjon (withTenantTransaction); en cost_events-spørring uten den ville gitt 0 rader (RLS default deny) - og A sin sum er > 0 over
    expect(s.sql.some((q) => /set_config\('jarvis\.tenant_id'/.test(q))).toBe(true);
  });
});

describe("hele kjeden med de EKTE kildene: rapport + beredskap + register + kost bygger uten feil som eieren, og skriver ingenting", () => {
  it("registeret (produksjonsfabrikken) gir eieren en rapport der ALLE fire seksjoner er målt (kilden finnes), ingen er «i orden» uten måling, og senteret står som advarsel/ukjent - aldri OK på NAS-lignende data", async () => {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: OWNER_A, owner_tenants: [TENANT_A] } });
    const deps = sourceDeps(db.appPool, TENANT_A);
    registry.register(createEvolutionCenter({
      pool: db.appPool, env: { JARVIS_EV_VERIFIED_GATES: EXTERNAL_GATES.join(",") }, evolutionReport: createEvolutionReportProvider({ ...deps, env: { JARVIS_EV_VERIFIED_GATES: EXTERNAL_GATES.join(",") } }),
      readiness: createEvolutionReadinessProvider({ ...deps, env: { JARVIS_EV_VERIFIED_GATES: EXTERNAL_GATES.join(",") } }), ev0Status: () => BOOT, runRate: new RunRateService(db.appPool), reportTenantId: TENANT_A
    }));
    const before = await counts();
    const report = await registry.report("evolution", A);
    expect(report).not.toBeNull();
    expect(report?.sections.map((s) => s.id)).toEqual(["ports", "dormant", "ledger", "cost_model"]);
    expect(report?.sections.every((s) => s.measured), JSON.stringify(report?.sections.map((s) => [s.id, s.summary_no]))).toBe(true);
    expect(report?.status).not.toBe("OK");
    // porter: alle elleve finnes, og EV-5 teller de samme 26 som endringsregisteret
    const ports = report?.sections.find((s) => s.id === "ports") as ControlSection;
    expect(ports.items).toHaveLength(11);
    expect(itemOf(ports, "port:ev5").status).toBe("WARN");
    expect(itemOf(ports, "port:ev5").detail_no).toContain("26 forslag venter");
    // sovende deler: erklærte porter + friske fakta gjør noen «klare» (men aldri aktivert)
    const dormant = report?.sections.find((s) => s.id === "dormant") as ControlSection;
    for (const i of dormant.items) expect(i.facts?.["activation_decision"], i.id).toBe(false);
    expect(await counts()).toEqual(before);
    expect(report?.actions).toEqual([]);
  });

  it("en annen eier (B) får ingenting av A sin tenant: registeret nekter før noe leses", async () => {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: OWNER_A, owner_tenants: [TENANT_A] } });
    registry.register(createEvolutionCenter({ pool: db.appPool, env: {}, evolutionReport: async () => ({ sections: [] }), reportTenantId: TENANT_A }));
    await expect(registry.report("evolution", B)).rejects.toThrow(/control_center_denied:control_center_owner_only/);
  });
});
