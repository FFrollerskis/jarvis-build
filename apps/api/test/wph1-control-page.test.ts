import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { createAgentCenter } from "../src/control-center/agent.ts";
import { createFinanceCenter } from "../src/control-center/finance.ts";
import { createMemoryCenter } from "../src/control-center/memory.ts";
import { renderStaticPage } from "../src/server.ts";
import { runPage, type FakeElement, type FetchCall, type FetchRoute } from "./support/fake-dom.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H1: `/control`-siden er DATADREVET - den viser hvert senter oversikten lister, og hver seksjon/rad/handling rapporten har - så de tre nye sentrene krever INGEN endring i `apps/web/control.html`.
 * Her kjøres sidens EKTE script (falsk nettleser) mot rapporter bygget av de EKTE composerne (skriptet database) via det EKTE registeret, og vi beviser at: de nye sentrene vises (og ikke lenger under
 * «ikke koblet inn»), ukjent vises som «ikke målt», avbryt-knappen peker på den eksisterende ruten med step-up-merke, og en hemmelighetsformet verdi aldri vises.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../web/control.html", import.meta.url)), "utf8");
const SERVED = renderStaticPage(SOURCE, "TESTNONCE", { tenant_id: "tenant-h1", person_id: "person-h1" });
const NOW = new Date("2026-11-14T10:00:00.000Z");
const iso = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const owner: IdentityContext = { person_id: "person-h1", tenant_id: "tenant-h1", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const defs = productionToolDefinitions();
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } as never;

const rules: ScriptedRule[] = [
  { match: /FROM payment_intents WHERE tenant_id = \$1 GROUP BY state/, rows: [{ state: "settled", n: 2, ore: "300000" }, { state: "submitted", n: 1, ore: "20000" }] },
  { match: /submit_outcome|AS outcome_unknown/, rows: [{ outcome_unknown: 1, in_flight: 1, flagged: 0, settled_unreconciled: 0, failed_7d: 0, created_30d: 3 }] },
  { match: /FROM tasks\s+WHERE tenant_id = \$1 AND status IN \('created', 'running', 'paused'\)\s+ORDER BY/, rows: [
    { task_id: "task-page-1", status: "running", attempts: 1, created_at: iso(30 * 60_000), claimed_at: iso(10 * 60_000), lease_expires_at: new Date(NOW.getTime() + 40_000).toISOString(), worker_id: "worker-1", cancel_requested: false, has_error: false, agent_profile: "executive", max_attempts: 3, delegated: true, network_targets: 0 }
  ] },
  { match: /FROM erasure_requests/, rows: new Error("permission denied for table erasure_requests") }
];

async function buildRegistry(): Promise<ControlCenterRegistry> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(createFinanceCenter({ pool: new ScriptedPool(rules).asPool(), toolGateway }));
  registry.register(createMemoryCenter({ pool: new ScriptedPool(rules).asPool(), env: {} }));
  registry.register(createAgentCenter({ pool: new ScriptedPool(rules).asPool(), toolGateway }));
  return registry;
}

async function route(extra: FetchRoute = () => undefined): Promise<FetchRoute> {
  const registry = await buildRegistry();
  const overview = await registry.overview(owner);
  const reports = new Map<string, ControlCenterReport>();
  for (const c of overview.centers) reports.set(c.center, (await registry.report(c.center, owner)) as ControlCenterReport);
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

describe("siden viser de tre nye sentrene uten endring i siden", () => {
  it("oversikten har Finans, Minne og Agenter som flis (ikke lenger «ikke koblet inn»), og de øvrige står fortsatt som ikke koblet inn", async () => {
    const page = runPage(SERVED, await route());
    await loaded(page);
    const overview = text(page.byId("overview"));
    for (const name of ["Finans", "Minne", "Agenter"]) expect(overview, name).toContain(name);
    const missing = text(page.byId("unregistered"));
    for (const name of ["Integrasjoner", "Autoritet", "AI", "Drift", "Verdi", "Personvern", "Sikkerhet"]) expect(missing, name).toContain(name);
    for (const name of ["Finans", "Minne", "Agenter"]) expect(missing, name).not.toContain(name);
    expect(page.fetchCalls.filter((c) => c.path === "/control/center").map((c) => c.body["center"]).sort()).toEqual(["agent", "finance", "memory"]);
  });

  it("Finans: seksjoner med kilde og måletidspunkt, UKJENT utfall som feil, og nødbryteren med step-up-merke FØR trykk", async () => {
    const page = runPage(SERVED, await route());
    await loaded(page);
    const finance = text(page.byId("center-finance"));
    expect(finance).toContain("Betalingsintensjoner");
    expect(finance).toContain("Kilde: payment_intents");
    expect(finance).toContain("Utfall ukjent");
    expect(finance).toContain("✕ feil");
    expect(finance).toContain("Aktiver finans-nødbryter");
    expect(page.byId("center-finance").open).toBe(true); // FAIL åpnes automatisk
    // beløp står i måledata for eieren (siden har ingen modell i løkka)
    expect(finance).toContain("amount_ore");
  });

  it("Minne: en kilde som ikke kunne leses vises som «ikke målt» og «kunne ikke måles» - aldri «i orden»", async () => {
    const page = runPage(SERVED, await route());
    await loaded(page);
    const memory = text(page.byId("center-memory"));
    expect(memory).toContain("Sletting og eksport");
    expect(memory).toContain("? ikke målt");
    expect(memory).toContain("kunne ikke måles (ukjent, ikke «i orden»)");
    expect(memory).not.toContain("permission denied");
  });

  it("Agenter: den kjørende jobben vises uten tittel, med avbryt-knapp mot den eksisterende ruten (klasse B, ingen step-up, kan ikke angres) - og bekreftelse sender cancel_task", async () => {
    const page = runPage(SERVED, await route());
    await loaded(page);
    const agent = text(page.byId("center-agent"));
    expect(agent).toContain("Kjørende, ventende og pauset jobber");
    expect(agent).toContain("task-page-1");
    const btn = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === "agent.cancel:task-page-1")[0];
    expect(btn).toBeDefined();
    expect(btn!.getAttribute("aria-label")).toContain("klasse B");
    expect(btn!.getAttribute("aria-label")).toContain("kan ikke angres");
    expect(text(btn!.parent!)).toContain("ingen step-up");
    const before = page.fetchCalls.length;
    btn!.dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    expect(page.byId("confirm-class").textContent).toBe("klasse B");
    expect(page.byId("confirm-reversible").textContent).toBe("kan IKKE angres");
    page.byId("confirm-dialog").close("ok");
    await page.waitFor(() => page.fetchCalls.slice(before).some((c) => c.path === "/executive/mutate"), "mutasjonen sendes");
    expect(page.fetchCalls.slice(before).find((c) => c.path === "/executive/mutate")!.body).toEqual({ grant_token: "GRANT", action: "cancel_task", parameters: { task_id: "task-page-1" } });
  });

  it("en hemmelighetsformet verdi i en rapport vises aldri (sidens egen vask er siste forsvarslinje)", async () => {
    // Bygges i to deler uten nøkkelord rett foran den lange delen (skanneren leser kildeteksten; verdien settes sammen først ved kjøring).
    const fake = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;
    const base = await route();
    const leaky: FetchRoute = (call) => {
      if (call.path === "/control/center" && call.body["center"] === "finance") {
        const answer = base(call);
        const data = (answer?.body as { data: { report: ControlCenterReport } }).data;
        const poisoned = { ...data.report, sections: data.report.sections.map((s, i) => (i === 0 ? { ...s, summary_no: `${s.summary_no} ${fake}` } : s)) };
        return { body: { ok: true, data: { ...data, report: poisoned } } };
      }
      return undefined;
    };
    const page = runPage(SERVED, await route(leaky));
    await loaded(page);
    expect(text(page.byId("center-finance"))).toContain("[skjult]");
    expect(text(page.byId("center-finance"))).not.toContain("FALSKNOKKELFORTEST");
  });
});
