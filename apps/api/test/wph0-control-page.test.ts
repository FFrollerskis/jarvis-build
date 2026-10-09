import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROL_ACTION_ENDPOINTS } from "@jarvis/executive";
import { renderStaticPage } from "../src/server.ts";
import { runPage, type FakeElement, type FetchCall, type FetchRoute } from "./support/fake-dom.ts";

/**
 * WP-H0: `apps/web/control.html` - ingen byggesteg, ingen ekstern avhengighet. Siden bevises på to nivåer:
 *  1. KILDE: ingen innerHTML/eval/ekstern URL, kun de lukkede rutene, lokal endepunktliste = CONTROL_ACTION_ENDPOINTS, tilgjengelighetskrav til stede (lang, skip-lenke, aria-live, <dialog>, fokusring, redusert bevegelse).
 *  2. ATFERD: sidens ekte script kjøres mot en falsk nettleser (se support/fake-dom.ts) med skriptede svar: autentisering, rendering av sentre/seksjoner/rader/handlinger, step-up synlig FØR trykk,
 *     bekreftelsesdialog (klasse D krever skrevet navn), utførelse mot den eksisterende ruten, feilmeldinger, hemmelighetsvask og uinnrullert enhet.
 */
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const SOURCE = readFileSync(`${WEB_DIR}control.html`, "utf8");
const SERVED = renderStaticPage(SOURCE, "TESTNONCE", { tenant_id: "tenant-h0", person_id: "person-h0" });
const ALLOWED_PATHS = new Set(["/devices/challenge", "/session/authorize", "/devices/register", "/control/centers", "/control/center", ...CONTROL_ACTION_ENDPOINTS]);

describe("kilde: sikkerhet og tilgjengelighet", () => {
  it("ingen innerHTML-tilordning, eval, document.write, new Function, ekstern URL eller inline handler/stil", () => {
    expect(SOURCE).not.toMatch(/\.innerHTML\s*=/);
    expect(SOURCE).not.toMatch(/\beval\s*\(|document\.write|new Function\s*\(/);
    expect(SOURCE).not.toMatch(/\bhttps?:\/\/(?!www\.w3\.org)/);
    expect(SOURCE).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(SOURCE).not.toMatch(/\sstyle\s*=|cssText|insertAdjacentHTML|javascript:/i);
    expect(SOURCE).not.toMatch(/person-tobias|tenant-personal/);
  });

  it("alle fetch-baner er lukket: kun autentiseringsrutene, de to lese-rutene og de eksisterende mutasjonsrutene", () => {
    const paths = [...SOURCE.matchAll(/["'`](\/[a-z][a-z0-9/_-]*)["'`]/g)].map((m) => m[1] as string).filter((p) => p !== "/" && !p.startsWith("/>"));
    const used = new Set(paths.filter((p) => /^\/(devices|session|control|executive|owner-controls)\b/.test(p)));
    for (const p of used) expect(ALLOWED_PATHS.has(p), p).toBe(true);
    expect(used.has("/control/centers") && used.has("/control/center")).toBe(true);
  });

  it("den lokale endepunkt-allowlisten i siden er IDENTISK med CONTROL_ACTION_ENDPOINTS (kontrakten)", () => {
    const literal = /const ACTION_ENDPOINTS = new Set\(\[([^\]]*)\]\)/.exec(SOURCE)?.[1] ?? "";
    const local = [...literal.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(local.sort()).toEqual([...CONTROL_ACTION_ENDPOINTS].sort());
  });

  it("tilgjengelighet: lang, skip-lenke, aria-live-region, <dialog> med aria-labelledby, fokusring, redusert bevegelse, status med symbol og tekst", () => {
    expect(SOURCE).toContain('<html lang="no">');
    expect(SOURCE).toMatch(/<a class="skip" href="#main">/);
    expect(SOURCE).toMatch(/<div id="status" role="status" aria-live="polite">/);
    expect(SOURCE).toMatch(/<dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-desc">/);
    expect(SOURCE).toContain(":focus-visible");
    expect(SOURCE).toContain("prefers-reduced-motion");
    expect(SOURCE).toMatch(/OK: \{ sym: "✓", text: "i orden"/);
    expect(SOURCE).toMatch(/UNKNOWN: \{ sym: "\?", text: "ikke målt"/);
    expect(SOURCE).toContain('name="viewport"');
  });

  it("serveringen bytter ut eier-meta og setter nonce på det ene scriptet og det ene style-elementet", () => {
    expect(SERVED).toContain('<meta name="jarvis-owner"');
    expect(SERVED).toContain('<script nonce="TESTNONCE">');
    expect(SERVED).toContain('<style nonce="TESTNONCE">');
    expect(SERVED).not.toMatch(/<script>|<style>/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Atferd
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-09T10:00:00.000Z";
const freeze = {
  id: "integration.freeze:github", label: "Frys GitHub", endpoint: "/executive/mutate", risk_class: "C", requires_step_up: false, reversible: true,
  description_no: "Fryser GitHub umiddelbart.", rollback_no: "Opphev frys.", section_id: "connectors", item_id: "github",
  body: { action: "freeze_connector", parameters: { connector_id: "github", reason: "Pauset fra kontrollsenter" } }
};
const revoke = {
  id: "integration.revoke:JARVIS_GITHUB_TOKEN", label: "Tilbakekall GitHub-nøkkel", endpoint: "/executive/mutate", risk_class: "C", requires_step_up: true, reversible: true,
  description_no: "Tilbakekaller nøkkelen.", rollback_no: "Gjenopprett nøkkelen.", section_id: "connectors", item_id: "github",
  body: { action: "revoke_credential", parameters: { credential_ref: "JARVIS_GITHUB_TOKEN", reason: "Tilbakekalt fra kontrollsenter" } }
};
const killSwitch = {
  id: "authority.kill_switch", label: "Aktiver kill switch", endpoint: "/executive/mutate", risk_class: "D", requires_step_up: false, reversible: true,
  description_no: "Stanser hele systemet.", rollback_no: "Opphev kill switch.", body: { action: "activate_kill_switch", parameters: { reason: "Stanset fra kontrollsenter" } }
};
const irreversible = {
  id: "authority.revoke_device:dev-1", label: "Tilbakekall enhet dev-1", endpoint: "/executive/mutate", risk_class: "C", requires_step_up: true, reversible: false,
  description_no: "Tilbakekaller enheten permanent.", body: { action: "revoke_device", parameters: { device_id: "dev-1", reason: "x" } }
};
const rogue = { ...freeze, id: "rogue", label: "Rogue", endpoint: "/tasks/submit" };

const section = (over: Record<string, unknown> = {}) => ({
  id: "connectors", title_no: "Connectorer", status: "WARN", measured: true, summary_no: "1 av 2 connectorer feiler", source: "connector-registeret", observed_at: NOW,
  items: [
    { id: "github", label: "GitHub", status: "FAIL", detail_no: "auth_failed siste kall", facts: { configured: true, minutter_30d: 12, siste_feil: null }, observed_at: NOW },
    { id: "slack", label: "Slack", status: "OK" }
  ], ...over
});
const report = (center: string, status: string, over: Record<string, unknown> = {}) => ({
  center, title_no: center === "integration" ? "Integrasjoner" : "AI", generated_at: NOW, status, sensitivity: "PRIVATE", sections: [section()], actions: [freeze, revoke], summary_no: `${center}: ${status}`, ...over
});
const reports: Record<string, ReturnType<typeof report>> = { integration: report("integration", "FAIL"), ai: report("ai", "OK", { sections: [section({ id: "providers", title_no: "Leverandører", status: "OK", items: [] })], actions: [killSwitch, irreversible] }) };
const overview = {
  generated_at: NOW, status: "FAIL", sensitivity: "PRIVATE", unregistered: ["authority", "finance", "memory", "agent", "operations", "value", "privacy", "security"], summary_no: "2 av 10",
  centers: ["integration", "ai"].map((id) => ({ center: id, title_no: id === "integration" ? "Integrasjoner" : "AI", description_no: `Beskrivelse ${id}`, status: reports[id]!.status, generated_at: NOW, sections: reports[id]!.sections.map((s) => ({ id: s.id, title_no: s.title_no, status: s.status, measured: true, summary_no: s.summary_no })), action_count: reports[id]!.actions.length, summary_no: `${id}-sammendrag` }))
};

function baseRoute(extra: FetchRoute = () => undefined): FetchRoute {
  return (call: FetchCall) => {
    const custom = extra(call);
    if (custom) return custom;
    if (call.path === "/devices/challenge") return { body: { challenge: "utfordring-1" } };
    if (call.path === "/session/authorize") return { body: { ok: true, grant: { grant_token: "GRANT", expires_at_ms: Date.now() + 3_600_000 } } };
    if (call.path === "/control/centers") return { body: { ok: true, data: overview } };
    if (call.path === "/control/center") {
      const r = reports[String(call.body["center"])];
      return r ? { body: { ok: true, data: { found: true, summary_no: r.summary_no, explanation_no: `Forklaring for ${r.center}`, report: r } } } : { status: 404, body: { error: "center_not_registered" } };
    }
    if (call.path === "/executive/mutate") return { body: { ok: true, data: {} } };
    return undefined;
  };
}

const allText = (el: FakeElement) => el.textContent;
const button = (page: ReturnType<typeof runPage>, actionId: string): FakeElement => {
  const found = page.byId("centers").findAll((e) => e.getAttribute("data-action-id") === actionId)[0];
  if (!found) throw new Error(`fant ikke knapp ${actionId}`);
  return found;
};
const loaded = (page: ReturnType<typeof runPage>) => page.waitFor(() => page.byId("updated").textContent.startsWith("Oppdatert"), "siden er ferdig lastet");
const closeDialog = (page: ReturnType<typeof runPage>, value: "ok" | "cancel") => page.byId("confirm-dialog").close(value);

describe("atferd: autentisering og lesing", () => {
  it("henter grant via challenge → authorize, deretter oversikt og hvert senter - med grantet, uten identitetsfelt", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const paths = page.fetchCalls.map((c) => c.path);
    expect(paths.slice(0, 3)).toEqual(["/devices/challenge", "/session/authorize", "/control/centers"]);
    expect(paths.filter((p) => p === "/control/center")).toHaveLength(2);
    for (const call of page.fetchCalls.filter((c) => c.path.startsWith("/control"))) {
      expect(call.body["grant_token"]).toBe("GRANT");
      expect(Object.keys(call.body).sort()).toEqual(call.path === "/control/center" ? ["center", "grant_token"] : ["grant_token"]);
    }
    // Aldri en rute utenfor den lukkede listen.
    for (const call of page.fetchCalls) expect(ALLOWED_PATHS.has(call.path), call.path).toBe(true);
    // Autentiseringen bruker eier-identiteten fra meta-taggen (ikke hardkodet) og lagrer enhetsnøkkel + enhets-id lokalt.
    const authorize = page.fetchCalls.find((c) => c.path === "/session/authorize")!;
    expect(authorize.body).toMatchObject({ person_id: "person-h0", tenant_id: "tenant-h0", channel: "web" });
    expect(page.storage.has("jarvis.devicekey")).toBe(true);
    expect(page.storage.get("jarvis.deviceid")).toMatch(/^web-/);
  });

  it("viser oversikten med status som tekst + symbol, og de ikke-koblede sentrene separat (aldri som «i orden»)", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const overviewText = allText(page.byId("overview"));
    expect(overviewText).toContain("Integrasjoner");
    expect(overviewText).toContain("✕ feil");
    expect(overviewText).toContain("✓ i orden");
    const missing = page.byId("unregistered");
    expect(missing.classList.contains("hidden")).toBe(false);
    for (const name of ["Autoritet", "Finans", "Minne", "Agenter", "Drift", "Verdi", "Personvern", "Sikkerhet"]) expect(missing.textContent).toContain(name);
    expect(missing.textContent).toContain("de finnes bare ikke ennå");
  });

  it("rendrer seksjoner med kilde og måletidspunkt, rader med fakta, og forklaringen («Hvorfor feil?»)", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const integ = allText(page.byId("center-integration"));
    expect(integ).toContain("Connectorer");
    expect(integ).toContain("Kilde: connector-registeret · målt 2026-10-09T10:00:00.000Z");
    expect(integ).toContain("GitHub");
    expect(integ).toContain("auth_failed siste kall");
    expect(integ).toContain("minutter_30d");
    expect(integ).toContain("Hvorfor feil?");
    expect(integ).toContain("Forklaring for integration");
    expect(page.byId("center-integration").open).toBe(true); // FAIL/WARN åpnes automatisk
  });

  it("en seksjon som ikke kunne måles vises som ukjent - ikke «i orden»", async () => {
    const unmeasured = report("integration", "UNKNOWN", { sections: [section({ status: "UNKNOWN", measured: false, observed_at: null, items: [], summary_no: "Ikke målt: målingen feilet (Error)" })], actions: [] });
    const page = runPage(SERVED, baseRoute(({ path, body }) => path === "/control/center" && body["center"] === "integration" ? { body: { ok: true, data: { found: true, summary_no: "x", explanation_no: "e", report: unmeasured } } } : undefined));
    await loaded(page);
    const text = allText(page.byId("center-integration"));
    expect(text).toContain("? ikke målt");
    expect(text).toContain("kunne ikke måles (ukjent, ikke «i orden»)");
  });

  it("feiler ett senter, vises feilen for det senteret - de andre rendres", async () => {
    const page = runPage(SERVED, baseRoute(({ path, body }) => path === "/control/center" && body["center"] === "ai" ? { status: 403, body: { error: "tool_denied", reason: "control_center_owner_only" } } : undefined));
    await loaded(page);
    expect(allText(page.byId("center-ai"))).toContain("Kunne ikke hente senteret");
    expect(allText(page.byId("center-integration"))).toContain("GitHub");
  });

  it("uinnrullert enhet: innrulleringsskjemaet vises og ingen kontrollruter kalles", async () => {
    const page = runPage(SERVED, baseRoute(({ path }) => path === "/session/authorize" ? { status: 403, body: { ok: false, reason: "unknown_device" } } : undefined));
    await page.waitFor(() => page.byId("enroll").classList.contains("open"), "innrullering vises");
    expect(page.fetchCalls.some((c) => c.path.startsWith("/control"))).toBe(false);
    expect(page.byId("overview").textContent).toContain("enhet ikke innrullert");
  });

  it("hemmelighetsvask: token-lignende tekst i en rapport vises aldri", async () => {
    const leaky = report("integration", "WARN", {
      sections: [section({ items: [{ id: "x", label: "Rad sk-ant-api03-ABCDEFGHIJKLMNOP", status: "WARN", detail_no: `Token ghp_${"a".repeat(30)} og ${"f".repeat(48)} og Bearer abcdefghijklmnopqrstuvwxyz`, facts: { nøkkel: ["AKIA", "ABCDEFGHIJKLMNOP"].join("") } }] })]
    });
    const page = runPage(SERVED, baseRoute(({ path, body }) => path === "/control/center" && body["center"] === "integration" ? { body: { ok: true, data: { found: true, summary_no: "s", explanation_no: "e", report: leaky } } } : undefined));
    await loaded(page);
    const text = allText(page.byId("center-integration"));
    expect(text).toContain("[skjult]");
    for (const secret of ["sk-ant-api03", "ghp_aaaa", "ffffffff", "AKIAABCD", "abcdefghijklmnopqrstuvwxyz"]) expect(text, secret).not.toContain(secret);
  });
});

describe("atferd: handlinger", () => {
  it("viser step-up og angre-status FØR trykk (merker + aria-label), og bare lovlige knapper", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const stop = button(page, "integration.freeze:github");
    const revokeBtn = button(page, "integration.revoke:JARVIS_GITHUB_TOKEN");
    expect(stop.getAttribute("aria-label")).toContain("klasse C");
    expect(stop.getAttribute("aria-label")).not.toContain("krever signert enhet");
    expect(revokeBtn.getAttribute("aria-label")).toContain("krever signert enhet");
    const row = allText(revokeBtn.parent!);
    expect(row).toContain("krever signert enhet");
    expect(allText(stop.parent!)).toContain("ingen step-up");
    expect(allText(button(page, "authority.revoke_device:dev-1").parent!)).toContain("kan ikke angres");
  });

  it("trykk → dialog med klasse/step-up/angre → bekreft → POST til den eksisterende ruten med grantet og kroppen, deretter ny lasting", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const before = page.fetchCalls.length;
    button(page, "integration.freeze:github").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    expect(page.byId("confirm-title").textContent).toBe("Frys GitHub");
    expect(page.byId("confirm-class").textContent).toBe("klasse C");
    expect(page.byId("confirm-stepup").textContent).toContain("ingen step-up");
    expect(page.byId("confirm-reversible").textContent).toBe("kan angres");
    expect(page.byId("confirm-rollback").textContent).toContain("Opphev frys.");
    expect(page.byId("confirm-reason-wrap").classList.contains("hidden")).toBe(false);
    expect(page.byId("confirm-reason").value).toBe("Pauset fra kontrollsenter");
    page.byId("confirm-reason").value = "GitHub-token mistenkes lekket";
    closeDialog(page, "ok");
    await page.waitFor(() => page.fetchCalls.slice(before).some((c) => c.path === "/executive/mutate"), "mutasjonen sendes");
    const post = page.fetchCalls.slice(before).find((c) => c.path === "/executive/mutate")!;
    expect(post.body).toEqual({ grant_token: "GRANT", action: "freeze_connector", parameters: { connector_id: "github", reason: "GitHub-token mistenkes lekket" } });
    await page.waitFor(() => page.fetchCalls.slice(before).filter((c) => c.path === "/control/centers").length >= 1, "siden laster på nytt etter handlingen");
    expect(page.byId("status").textContent).toMatch(/Oppdaterer|Samlet status/);
  });

  it("avbryt i dialogen sender ingenting, og kroppen i rapporten er urørt av begrunnelsesfeltet", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const before = page.fetchCalls.length;
    button(page, "integration.freeze:github").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    closeDialog(page, "cancel");
    await new Promise((r) => setTimeout(r, 30));
    expect(page.fetchCalls.length).toBe(before);
    expect(reports["integration"]!.actions[0]!.body.parameters.reason).toBe("Pauset fra kontrollsenter");
  });

  it("klasse D (kill switch) krever at handlingsnavnet skrives - «Bekreft» er deaktivert til det stemmer", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    button(page, "authority.kill_switch").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    expect(page.byId("confirm-class").textContent).toBe("klasse D");
    expect(page.byId("confirm-typed-wrap").classList.contains("hidden")).toBe(false);
    expect(page.byId("confirm-typed-label").textContent).toContain("activate_kill_switch");
    expect(page.byId("confirm-ok").disabled).toBe(true);
    page.byId("confirm-typed").value = "aktiver";
    page.byId("confirm-typed").dispatch("input");
    expect(page.byId("confirm-ok").disabled).toBe(true);
    page.byId("confirm-typed").value = "activate_kill_switch";
    page.byId("confirm-typed").dispatch("input");
    expect(page.byId("confirm-ok").disabled).toBe(false);
    closeDialog(page, "cancel");
  });

  it("step-up-avslag forklares tydelig (signert enhet, ikke tale/Telegram)", async () => {
    const page = runPage(SERVED, baseRoute(({ path }) => path === "/executive/mutate" ? { status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session" } } : undefined));
    await loaded(page);
    button(page, "integration.revoke:JARVIS_GITHUB_TOKEN").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    expect(page.byId("confirm-stepup").textContent).toContain("krever signert enhetsøkt");
    closeDialog(page, "ok");
    await page.waitFor(() => page.byId("status").history.some((t) => t.includes("Krever step-up")), "step-up-feil vises");
    const shown = page.byId("status").history.find((t) => t.includes("Krever step-up"))!;
    expect(shown).toContain("signert enhetsøkt");
    expect(shown).toContain("ikke fra tale eller Telegram");
  });

  it("policy-avslag og ugyldig grant vises med årsaken", async () => {
    let answer: { status: number; body: unknown } = { status: 403, body: { error: "tool_denied", reason: "connector_frozen" } };
    const page = runPage(SERVED, baseRoute(({ path }) => path === "/executive/mutate" ? answer : undefined));
    await loaded(page);
    button(page, "integration.freeze:github").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    closeDialog(page, "ok");
    await page.waitFor(() => page.byId("status").history.some((t) => t.includes("Avvist av policy: connector_frozen")), "policy-avslag vises");
    answer = { status: 403, body: { error: "identity_denied", reason: "grant_expired" } };
    await page.waitFor(() => page.byId("status").textContent.startsWith("Samlet status"), "siden er lastet på nytt");
    button(page, "integration.freeze:github").dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes igjen");
    closeDialog(page, "ok");
    await page.waitFor(() => page.byId("status").history.some((t) => t.includes("Avvist: enheten/grantet er ikke gyldig (grant_expired)")), "identitetsavslag vises");
  });

  it("en handling mot en rute utenfor kontrakten utføres aldri - ingen dialog, ingen fetch", async () => {
    const withRogue = report("integration", "WARN", { actions: [freeze, rogue] });
    const page = runPage(SERVED, baseRoute(({ path, body }) => path === "/control/center" && body["center"] === "integration" ? { body: { ok: true, data: { found: true, summary_no: "s", explanation_no: "e", report: withRogue } } } : undefined));
    await loaded(page);
    const before = page.fetchCalls.length;
    button(page, "rogue").dispatch("click");
    await new Promise((r) => setTimeout(r, 30));
    expect(page.byId("confirm-dialog").open).toBe(false);
    expect(page.fetchCalls.length).toBe(before);
    expect(page.byId("status").textContent).toContain("ikke utført");
  });

  it("en handling kan ikke utføres to ganger samtidig (dobbelttrykk)", async () => {
    const page = runPage(SERVED, baseRoute());
    await loaded(page);
    const b = button(page, "integration.freeze:github");
    b.dispatch("click");
    b.dispatch("click");
    await page.waitFor(() => page.byId("confirm-dialog").open, "dialogen åpnes");
    closeDialog(page, "ok");
    await page.waitFor(() => page.fetchCalls.some((c) => c.path === "/executive/mutate"), "mutasjonen sendes");
    await new Promise((r) => setTimeout(r, 50));
    expect(page.fetchCalls.filter((c) => c.path === "/executive/mutate")).toHaveLength(1);
  });
});
