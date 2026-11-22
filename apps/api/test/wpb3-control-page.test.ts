import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_CENTER_IDS, EXTENSION_CONTROL_CENTER_IDS, controlSection, controlItem, type ControlCenterDefinition, type ControlCenterId, type ControlCenterReport
} from "@jarvis/executive";
import { evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import { createEvolutionCenter } from "../src/control-center/evolution.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { renderStaticPage } from "../src/server.ts";
import { runPage, type FetchCall, type FetchRoute, type PageHarness } from "./support/fake-dom.ts";
import { ScriptedPool } from "./support/scripted-pool.ts";

/**
 * WP-B3 (D-475, EV-22): `/control`-siden er DATADREVET - Evolusjon-senteret vises som en vanlig flis når oversikten lister det, uten egen sidekode. Eneste sideendring er telleteksten: «N av 10 sentre er koblet inn» teller
 * KUN masterplanens ti, og et tilleggssenter nevnes som «Pluss N tilleggssenter» (tidligere ville 11 sentre gitt «11 av 10»). Her kjøres sidens EKTE script (falsk nettleser) mot rapporter bygget av det EKTE senteret via det EKTE registeret.
 *  - uten tilleggssenter er teksten tegn for tegn som før (flagg AV = main);
 *  - Evolusjon står aldri under «ikke koblet inn», og det som ikke måles står som «ikke målt» (aldri «i orden»);
 *  - sidens egen liste over tilleggssentre speiler `EXTENSION_CONTROL_CENTER_IDS` (låst her);
 *  - ingen knapper (kun lesing), og et ID-formet innhold vises ikke rått.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../web/control.html", import.meta.url)), "utf8");
const SERVED = renderStaticPage(SOURCE, "TESTNONCE", { tenant_id: "tenant-b3p", person_id: "person-b3p" });
const owner: IdentityContext = { person_id: "person-b3p", tenant_id: "tenant-b3p", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const FACTS: ReadinessFacts = { constitution_verified: null, ledger_ok: null, change_freeze_off: null, proven_connectors: null, job_runner_configured: null, declared_gates: new Set<string>() };

const probe = (id: ControlCenterId): ControlCenterDefinition => ({
  id, title_no: `Senter ${id}`, description_no: `Beskrivelse ${id}`,
  build: async () => ({ sections: [controlSection({ id: "s1", title_no: "Seksjon", source: "test", summary_no: "ok", items: [controlItem({ id: "i1", label: "Rad", status: "OK" })] })], actions: [] })
});

let withEvolution: { overview: unknown; reports: Map<string, ControlCenterReport> };
let tenOnly: { overview: unknown; reports: Map<string, ControlCenterReport> };
let onlyEvolution: { overview: unknown; reports: Map<string, ControlCenterReport> };

async function snapshot(ids: ReadonlyArray<ControlCenterId>, withEvo: boolean): Promise<{ overview: unknown; reports: Map<string, ControlCenterReport> }> {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-b3p", owner_tenants: ["tenant-b3p"] }, now: () => NOW });
  for (const id of ids) registry.register(probe(id));
  if (withEvo) {
    registry.register(createEvolutionCenter({
      pool: new ScriptedPool([{ match: /date_trunc\('month', now\(\)\)/, rows: [{ spent: 1_000 }] }]).asPool(), env: {},
      evolutionReport: async () => ({ as_of: NOW.toISOString(), sections: [] }), readiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => null, reportTenantId: "tenant-b3p"
    }));
  }
  const reports = new Map<string, ControlCenterReport>();
  for (const c of registry.list()) reports.set(c.id, (await registry.report(c.id, owner)) as ControlCenterReport);
  return { overview: await registry.overview(owner), reports };
}

beforeAll(async () => {
  withEvolution = await snapshot(CONTROL_CENTER_IDS, true);
  tenOnly = await snapshot(CONTROL_CENTER_IDS, false);
  onlyEvolution = await snapshot([], true);
});

function route(data: { overview: unknown; reports: Map<string, ControlCenterReport> }): FetchRoute {
  return (call: FetchCall) => {
    if (call.path === "/devices/challenge") return { body: { challenge: "utfordring-1" } };
    if (call.path === "/session/authorize") return { body: { ok: true, grant: { grant_token: "GRANT", expires_at_ms: Date.now() + 3_600_000 } } };
    if (call.path === "/control/centers") return { body: { ok: true, data: data.overview } };
    if (call.path === "/control/center") {
      const r = data.reports.get(String(call.body["center"]));
      return r ? { body: { ok: true, data: { found: true, summary_no: r.summary_no, explanation_no: `Forklaring for ${r.center}`, report: r } } } : { status: 404, body: { error: "center_not_registered" } };
    }
    return undefined;
  };
}
const loaded = (page: PageHarness) => page.waitFor(() => page.byId("updated").textContent.startsWith("Oppdatert"), "siden er ferdig lastet");

describe("telleteksten teller kun masterplanens ti - og er uendret uten tilleggssenter", () => {
  it("uten Evolusjon (flagg AV): «10 av 10 sentre er koblet inn.» - nøyaktig som før, ingen nevnt tilleggssenter, og ingenting under «ikke koblet inn»", async () => {
    const page = runPage(SERVED, route(tenOnly));
    await loaded(page);
    expect(page.byId("status").textContent).toBe("Samlet status: i orden. 10 av 10 sentre er koblet inn.");
    expect(page.byId("unregistered").classList.contains("hidden")).toBe(true);
    expect(page.fetchCalls.filter((c) => c.path === "/control/center").map((c) => c.body["center"]).sort()).toEqual([...CONTROL_CENTER_IDS].sort());
  });

  it("med Evolusjon (flagg PÅ): «10 av 10 …» + «Pluss 1 tilleggssenter.» - aldri «11 av 10» - og Evolusjon er en egen flis som ble hentet", async () => {
    const page = runPage(SERVED, route(withEvolution));
    await loaded(page);
    const message = page.byId("status").textContent;
    expect(message).toContain("10 av 10 sentre er koblet inn. Pluss 1 tilleggssenter.");
    expect(message).not.toContain("11 av 10");
    expect(page.fetchCalls.filter((c) => c.path === "/control/center").map((c) => c.body["center"])).toContain("evolution");
    expect(page.byId("center-evolution")).toBeDefined();
    expect(page.byId("center-evolution").textContent).toContain("Evolusjon");
    expect(page.byId("unregistered").classList.contains("hidden")).toBe(true);
  });

  it("kun Evolusjon koblet inn: «0 av 10 sentre er koblet inn. Pluss 1 tilleggssenter.» og de ti står under «ikke koblet inn» - Evolusjon gjør det aldri", async () => {
    const page = runPage(SERVED, route(onlyEvolution));
    await loaded(page);
    expect(page.byId("status").textContent).toContain("0 av 10 sentre er koblet inn. Pluss 1 tilleggssenter.");
    const missing = page.byId("unregistered").textContent;
    for (const name of ["Integrasjoner", "Autoritet", "AI", "Finans", "Minne", "Agenter", "Drift", "Verdi", "Personvern", "Sikkerhet"]) expect(missing, name).toContain(name);
    expect(missing).not.toContain("Evolusjon");
  });

  it("sidens egen liste over tilleggssentre speiler `EXTENSION_CONTROL_CENTER_IDS` (ellers ville et nytt tilleggssenter telt som «av 10»)", () => {
    const m = /const EXTENSION_CENTERS = new Set\(\[([^\]]*)\]\);/.exec(SOURCE);
    expect(m).not.toBeNull();
    const ids = (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(ids).toEqual([...EXTENSION_CONTROL_CENTER_IDS]);
  });
});

describe("Evolusjon på siden: ærlig «ikke målt», kun lesing", () => {
  it("seksjonene vises med kilde; det som ikke kunne måles (ukjente beredskapsinnsignal, ikke kjørt oppstartssjekk) står som «ikke målt» - aldri «i orden» - og senteret har ingen knapper", async () => {
    const page = runPage(SERVED, route(withEvolution));
    await loaded(page);
    const text = page.byId("center-evolution").textContent;
    for (const section of ["Evolusjonsporter", "Sovende deler", "Endringsregister og forslag", "Kostmodell"]) expect(text, section).toContain(section);
    expect(text).toContain("ikke målt");
    expect(withEvolution.reports.get("evolution")?.status).toBe("UNKNOWN");
    expect(withEvolution.reports.get("evolution")?.actions).toEqual([]);
    // ingen knapper i senteret (rapporten har ingen handlinger, og siden lager en `button` kun for en handling)
    expect(page.byId("center-evolution").findAll((el) => el.tagName === "button")).toEqual([]);
  });
});
