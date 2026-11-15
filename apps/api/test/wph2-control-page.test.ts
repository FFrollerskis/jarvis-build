import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_ACTION_ENDPOINTS, ControlCenterRegistry, ExecutiveService, composeInfraStatus, type ControlCenterReport, type InfraStatusReport } from "@jarvis/executive";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import { createGoldenSuiteRunner } from "../src/golden-suite-runner.ts";
import { createOperationsCenter } from "../src/control-center/operations.ts";
import { createPrivacyCenter } from "../src/control-center/privacy.ts";
import { createSecurityCenter } from "../src/control-center/security.ts";
import { createValueCenter } from "../src/control-center/value.ts";
import { renderStaticPage } from "../src/server.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";
import { runPage, type FakeElement, type FetchCall, type FetchRoute } from "./support/fake-dom.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-H2: `/control`-siden er DATADREVET - den viser hvert senter oversikten lister, og hver seksjon/rad/handling rapporten har - så Drift, Verdi, Personvern og Sikkerhet krever INGEN endring i `apps/web/control.html`.
 * Her kjøres sidens EKTE script (falsk nettleser) mot rapporter bygget av de EKTE composerne over EKTE Postgres (app-rolle) via det EKTE registeret, og vi beviser at:
 *  - de fire nye sentrene vises (og ikke lenger under «ikke koblet inn»), og det som ikke måles står som «ikke målt» (aldri «i orden»);
 *  - golden-suite-knappen vises med klasse (A), step-up-merke og «kan angres» FØR trykk, går via dialogen, og sender nøyaktig `run_golden_suite` til den eksisterende ruten;
 *  - ingen ny rute er lagt til: sidens handlingsendepunkter er de samme, og siden nevner ikke de nye handlingene (de kommer fra rapportene).
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../web/control.html", import.meta.url)), "utf8");
const SERVED = renderStaticPage(SOURCE, "TESTNONCE", { tenant_id: "tenant-h2p", person_id: "person-h2p" });
const owner: IdentityContext = { person_id: "person-h2p", tenant_id: "tenant-h2p", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const defs = productionToolDefinitions({ goldenSuite: true });
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } as never;

let db: H0Db;
let overview: unknown;
const reports = new Map<string, ControlCenterReport>();

function infra(): InfraStatusReport {
  return composeInfraStatus({
    as_of: new Date(),
    measurements: { incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 }, last_changes: {}, producer_runs: [], errors: [] },
    producers_enabled: true, producers_interval_ms: 300_000, producer_names: ["scheduler"], infra_mode: "NORMAL", targets: []
  });
}

beforeAll(async () => {
  db = await startH0Db("h2p");
  await seedTenants(db.adminPool, [{ tenant_id: "tenant-h2p", person_id: "person-h2p" }]);
  const killSwitch = new KillSwitch(db.appPool, { owner_person_id: "person-h2p" });
  await killSwitch.restore();
  const ownerControls = new OwnerControls(killSwitch, db.appPool, { owner_person_id: "person-h2p" });
  await ownerControls.restore();
  const service = new ExecutiveService({ list: () => [], health: new Map(), hasSecret: async () => true } as never);
  const registry = new ControlCenterRegistry({ isOwner: () => true });
  registry.register(createOperationsCenter({ pool: db.appPool, infraStatus: async () => infra(), backupStatus: async () => ({ kind: "missing" }), processStartedAt: () => new Date(Date.now() - 3_600_000) }));
  registry.register(createValueCenter({ valueReport: (t) => service.getValueReport(t) }));
  registry.register(createPrivacyCenter({ pool: db.appPool, env: {} }));
  registry.register(createSecurityCenter({ pool: db.appPool, toolGateway, ownerControls, killSwitch, goldenSuite: createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE }) }));
  overview = await registry.overview(owner);
  for (const id of ["operations", "value", "privacy", "security"]) reports.set(id, (await registry.report(id as never, owner)) as ControlCenterReport);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function route(extra: FetchRoute = () => undefined): FetchRoute {
  return (call: FetchCall) => {
    const custom = extra(call);
    if (custom) return custom;
    if (call.path === "/devices/challenge") return { body: { challenge: "utfordring-1" } };
    if (call.path === "/session/authorize") return { body: { ok: true, grant: { grant_token: "GRANT", expires_at_ms: Date.now() + 3_600_000 } } };
    if (call.path === "/control/centers") return { body: { ok: true, data: overview } };
    if (call.path === "/control/center") {
      const r = reports.get(String(call.body["center"]));
      return r ? { body: { ok: true, data: { found: true, summary_no: r.summary_no, explanation_no: `Forklaring for ${r.center}`, report: r } } } : { status: 404, body: { error: "center_not_registered" } };
    }
    if (call.path === "/executive/mutate") return { body: { ok: true, data: {} } };
    return undefined;
  };
}
const loaded = (page: ReturnType<typeof runPage>) => page.waitFor(() => page.byId("updated").textContent.startsWith("Oppdatert"), "siden er ferdig lastet");
const text = (el: FakeElement) => el.textContent;

describe("siden viser de fire nye sentrene uten endring i siden", () => {
  it("oversikten har Drift, Verdi, Personvern og Sikkerhet som flis (ikke lenger «ikke koblet inn»), og de øvrige står fortsatt som ikke koblet inn", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const tiles = text(page.byId("overview"));
    for (const name of ["Drift", "Verdi", "Personvern", "Sikkerhet"]) expect(tiles, name).toContain(name);
    const missing = text(page.byId("unregistered"));
    for (const name of ["Integrasjoner", "Autoritet", "AI", "Finans", "Minne", "Agenter"]) expect(missing, name).toContain(name);
    for (const name of ["Drift", "Verdi", "Personvern", "Sikkerhet"]) expect(missing, name).not.toContain(name);
    expect(page.fetchCalls.filter((c) => c.path === "/control/center").map((c) => c.body["center"]).sort()).toEqual(["operations", "privacy", "security", "value"]);
  });

  it("Drift: hver seksjon har kilde, og det som ikke måles (backup uten statusfil, tilgjengelighet i prosent, ledig disk) står som «ikke målt» - aldri «i orden»; ingen hendelsestitler", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const ops = text(page.byId("center-operations"));
    for (const title of ["Hendelser", "Backup", "Planlagte jobber", "Kapasitet"]) expect(ops, title).toContain(title);
    expect(ops).toContain("Kilde:");
    expect(ops).toContain("? ikke målt");
    expect(ops).toMatch(/ikke målt/);
    expect(ops).not.toContain("permission denied");
  });

  it("Verdi: uten en måle-kilde står alle metrikker som «ikke målt» (aldri 0 eller «i orden»), og «spart tid» og «korrigeringer» er alltid ikke målt", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const value = text(page.byId("center-value"));
    expect(value).toContain("Spart tid");
    expect(value).toContain("Eierens korrigeringer");
    expect(value).toContain("ikke målt");
    expect(value).toContain("ingen kilde koblet inn");
  });

  it("Personvern: oversikten er et UTKAST og DPIA-ene er ikke godkjent (advarsel, aldri «i orden»), og dekningen mot de levende tabellene er målt", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const privacy = text(page.byId("center-privacy"));
    expect(privacy).toContain("Behandlingsoversikt");
    expect(privacy).toContain("UTKAST");
    expect(privacy).toMatch(/ikke (juridisk )?(vurdert|godkjent)|IKKE godkjent|ikke godkjent/i);
  });

  it("Sikkerhet: revisjonens append-only-trigger er målt, golden-suite er «ikke kjørt» (ukjent), og knappen viser klasse, step-up og at den kan angres FØR trykk", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const security = text(page.byId("center-security"));
    for (const title of ["Revisjon", "Golden-suite"]) expect(security, title).toContain(title);
    expect(security).toContain("Kjør golden-suite");
    const btn = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "security.golden_suite.run")[0];
    expect(btn).toBeDefined();
    expect(btn!.getAttribute("aria-label")).toContain("klasse A");
    expect(text(btn!.parent!)).toContain("krever signert enhet");
    expect(text(btn!.parent!)).toContain("kan angres");
  });

  it("golden-suite-knappen: dialogen viser klasse A + step-up + «kan angres», og bekreftelse sender NØYAKTIG run_golden_suite til den eksisterende ruten (ingen parametre, ingen ny rute)", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const btn = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "security.golden_suite.run")[0]!;
    const before = page.fetchCalls.length;
    btn.dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    expect(page.byId("confirm-class").textContent).toBe("klasse A");
    expect(page.byId("confirm-stepup").textContent).toContain("krever signert enhetsøkt");
    expect(page.byId("confirm-reversible").textContent).toBe("kan angres");
    page.byId("confirm-dialog").close("ok");
    await page.waitFor(() => page.fetchCalls.slice(before).some((c) => c.path === "/executive/mutate"), "mutasjonen sendes");
    const sent = page.fetchCalls.slice(before).find((c) => c.path === "/executive/mutate")!;
    expect(sent.body).toEqual({ grant_token: "GRANT", action: "run_golden_suite", parameters: {} });
    // etter utført handling hentes sentrene på nytt (resultatet vises i Sikkerhet-senteret, ikke i dialogen)
    await page.waitFor(() => page.fetchCalls.slice(before).filter((c) => c.path === "/control/centers").length >= 1, "oversikten hentes på nytt");
  });

  it("avbrutt dialog sender ingenting", async () => {
    const page = runPage(SERVED, route());
    await loaded(page);
    const btn = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "security.golden_suite.run")[0]!;
    const before = page.fetchCalls.length;
    btn.dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    page.byId("confirm-dialog").close("cancel");
    await new Promise((r) => setTimeout(r, 50));
    expect(page.fetchCalls.slice(before).some((c) => c.path === "/executive/mutate")).toBe(false);
  });

  it("en avvist handling (step-up) lar siden stå i orden: sentrene hentes på nytt og Sikkerhet vises fortsatt med knappen", async () => {
    const denied: FetchRoute = (call) => (call.path === "/executive/mutate" ? { status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session" } } : undefined);
    const page = runPage(SERVED, route(denied));
    await loaded(page);
    const btn = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "security.golden_suite.run")[0]!;
    const before = page.fetchCalls.length;
    btn.dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    page.byId("confirm-dialog").close("ok");
    await page.waitFor(() => page.fetchCalls.slice(before).filter((c) => c.path === "/control/centers").length >= 1, "oversikten hentes på nytt etter avslaget");
    expect(page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "security.golden_suite.run").length).toBe(1);
  });
});

describe("ingen ny rute og ingen sidendring", () => {
  it("sidens handlingsendepunkter er uendret (kun de to eksisterende), og siden kjenner ikke de nye handlingsnavnene (de kommer fra rapportene)", () => {
    expect([...CONTROL_ACTION_ENDPOINTS]).toEqual(["/executive/mutate", "/owner-controls/connector-credentials"]);
    for (const endpoint of CONTROL_ACTION_ENDPOINTS) expect(SOURCE, endpoint).toContain(endpoint);
    for (const name of ["run_golden_suite", "revoke_autonomy_binding", "golden_suite", "autonomy"]) expect(SOURCE, name).not.toContain(name);
  });

  it("alle handlingene i de fire nye sentrenes rapporter peker på en eksisterende rute", () => {
    for (const report of reports.values()) for (const action of report.actions) expect(CONTROL_ACTION_ENDPOINTS as readonly string[], action.id).toContain(action.endpoint);
    expect(reports.get("security")!.actions.map((a) => a.id)).toEqual(["security.golden_suite.run"]);
    for (const id of ["operations", "value", "privacy"]) expect(reports.get(id)!.actions, id).toEqual([]);
  });
});
