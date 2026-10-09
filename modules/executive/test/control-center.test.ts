import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_ACTION_ALLOWED, CONTROL_ACTION_BODY_KEYS, CONTROL_ACTION_ENDPOINTS, CONTROL_CENTER_IDS, CONTROL_CENTER_TITLES_NO, ControlCenterAccessError, ControlCenterRegistry,
  composeControlCenterOverview, composeControlCenterReport, controlAction, controlItem, controlSection, explainControlCenterNo, failureCategory, isControlCenterId,
  isEffectiveRedactor, redactControlCenterReport, unknownControlSection, worstStatus,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlStatus
} from "../src/index.ts";

/**
 * WP-H0: den delte kontrakten for kontrollsentrene. Her låses de strukturelle garantiene (ikke bare happy path): ukjent er aldri OK, en bygger kan ikke skjule et feilende element eller påstå en bedre
 * status, handlinger kan kun peke på eksisterende ruter med lovlige kropper, registeret er eier-kun og fail-closed, en bygger som kaster/henger gir UNKNOWN (aldri en feil som velter oversikten), og
 * hemmeligheter redigeres i menneskelesbare felt.
 */
const NOW = new Date("2026-10-09T10:00:00.000Z");
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "signed" };
const stranger: IdentityContext = { ...owner, person_id: "person-stranger" };
const delegate: IdentityContext = { ...owner, delegation_id: "deleg-1" };
const otherTenant: IdentityContext = { ...owner, tenant_id: "tenant-annen" };
const isOwner = (i: IdentityContext) => i.person_id === "person-owner" && i.tenant_id === "tenant-owner" && i.delegation_id === undefined;

const okSection = (id = "s-ok") => controlSection({ id, title_no: "Seksjon", source: "kilde_x", summary_no: "Alt i orden", observed_at: NOW.toISOString() });
const center = (id: (typeof CONTROL_CENTER_IDS)[number], build: (ctx: ControlCenterBuildContext) => Promise<ControlCenterParts>): ControlCenterDefinition =>
  ({ id, title_no: CONTROL_CENTER_TITLES_NO[id], description_no: `Beskrivelse av ${id}`, build });
const registry = (opts: ConstructorParameters<typeof ControlCenterRegistry>[0] = {}) => new ControlCenterRegistry({ isOwner, now: () => NOW, ...opts });

describe("statusrangering: ukjent er aldri OK", () => {
  it("FAIL > WARN > UNKNOWN > OK, og en tom liste er UNKNOWN", () => {
    expect(worstStatus(["OK", "OK"])).toBe("OK");
    expect(worstStatus(["OK", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstStatus(["UNKNOWN", "WARN"])).toBe("WARN");
    expect(worstStatus(["WARN", "FAIL", "UNKNOWN", "OK"])).toBe("FAIL");
    expect(worstStatus([])).toBe("UNKNOWN");
  });

  it("de ti senter-id-ene er masterplanens, og en ukjent id gjenkjennes ikke", () => {
    expect([...CONTROL_CENTER_IDS]).toEqual(["integration", "authority", "ai", "finance", "memory", "agent", "operations", "value", "privacy", "security"]);
    expect(isControlCenterId("ai")).toBe(true);
    for (const bad of ["AI", "billing", "", undefined, null, 5, "ai ", "../ai"]) expect(isControlCenterId(bad), String(bad)).toBe(false);
    for (const id of CONTROL_CENTER_IDS) expect(CONTROL_CENTER_TITLES_NO[id].length).toBeGreaterThan(1);
  });
});

describe("controlSection / controlItem: invariantene bor i byggerne", () => {
  it("measured:false gir ALLTID UNKNOWN - også når byggeren oppgir OK - og fjerner måletidspunktet", () => {
    const s = controlSection({ id: "a", title_no: "A", source: "x", summary_no: "?", measured: false, status: "OK", observed_at: NOW.toISOString(), items: [] });
    expect(s.status).toBe("UNKNOWN");
    expect(s.measured).toBe(false);
    expect(s.observed_at).toBeNull();
  });

  it("en bygger kan ikke skjule et feilende element: sluttstatus er verste av byggerens vurdering og elementene", () => {
    const s = controlSection({
      id: "a", title_no: "A", source: "x", summary_no: "Alt ok, sier bygger", status: "OK",
      items: [controlItem({ id: "i1", label: "Fin", status: "OK" }), controlItem({ id: "i2", label: "Dårlig", status: "FAIL" })]
    });
    expect(s.status).toBe("FAIL");
    expect(controlSection({ id: "b", title_no: "B", source: "x", summary_no: "s", status: "WARN", items: [controlItem({ id: "i", label: "ok", status: "OK" })] }).status).toBe("WARN");
    expect(controlSection({ id: "c", title_no: "C", source: "x", summary_no: "s", items: [controlItem({ id: "i", label: "?", status: "UNKNOWN" })] }).status).toBe("UNKNOWN");
  });

  it("antall elementer begrenses og sies ærlig i sammendraget", () => {
    const items = Array.from({ length: 250 }, (_, i) => controlItem({ id: `i${i}`, label: `Rad ${i}`, status: "OK" }));
    const s = controlSection({ id: "a", title_no: "A", source: "x", summary_no: "Mange", items });
    expect(s.items).toHaveLength(200);
    expect(s.summary_no).toContain("50 flere vises ikke");
  });

  it("fakta er kun skalarer: nøstede verdier, funksjoner og ikke-endelige tall utelates (ingenting kan smugle innhold med)", () => {
    const item = controlItem({
      id: "i", label: "L", status: "OK",
      facts: { ok: true, n: 3, s: "tekst", nul: null, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, obj: { a: 1 } as never, arr: [1] as never, fn: (() => 1) as never, undef: undefined }
    });
    expect(item.facts).toEqual({ ok: true, n: 3, s: "tekst", nul: null });
  });

  it("tomme id-er og etiketter avvises", () => {
    expect(() => controlItem({ id: "", label: "x", status: "OK" })).toThrow();
    expect(() => controlItem({ id: "x", label: "  ", status: "OK" })).toThrow();
    expect(() => controlSection({ id: "", title_no: "t", source: "s", summary_no: "x" })).toThrow();
    expect(() => controlSection({ id: "a", title_no: "t", source: "", summary_no: "x" })).toThrow();
  });

  it("unknownControlSection er målt:false/UNKNOWN med årsaken i sammendraget", () => {
    const s = unknownControlSection("a", "A", "tabell_x", "kilden mangler");
    expect(s).toMatchObject({ status: "UNKNOWN", measured: false, source: "tabell_x" });
    expect(s.summary_no).toContain("kilden mangler");
  });

  it("feilkategori viser aldri meldingen: klassenavn (+ SQLSTATE), ikke teksten", () => {
    class PgLike extends Error { code = "42P01"; constructor() { super("relation \"hemmelig_tabell\" does not exist; password=hunter22"); this.name = "DatabaseError"; } }
    expect(failureCategory(new PgLike())).toBe("DatabaseError:42P01");
    expect(failureCategory(new TypeError("sk-ant-api03-ABCDEFGHIJKLMNOP"))).toBe("TypeError");
    expect(failureCategory("streng")).toBe("ukjent feil");
  });
});

describe("controlAction: peker kun på eksisterende ruter, aldri en ny skrivevei", () => {
  const base = {
    id: "integration.freeze:github", label: "Frys GitHub", endpoint: "/executive/mutate",
    body: { action: "freeze_connector", parameters: { connector_id: "github", reason: "test" } },
    risk_class: "C" as const, requires_step_up: false, reversible: true, description_no: "Fryser GitHub", rollback_no: "Opphev frys"
  };

  it("en gyldig handling normaliseres, og kroppen kopieres (ingen delt referanse)", () => {
    const a = controlAction(base);
    expect(a.endpoint).toBe("/executive/mutate");
    expect(a.body).toEqual(base.body);
    (a.body["parameters"] as Record<string, unknown>)["reason"] = "endret";
    expect((base.body.parameters as Record<string, unknown>)["reason"]).toBe("test");
  });

  it("endepunkt utenfor den lukkede listen avvises (annen sti, absolutt URL, protokoll-relativ, traversering, tom)", () => {
    for (const endpoint of ["/executive/query", "/tasks/submit", "https://evil.example/executive/mutate", "//evil.example/x", "/executive/mutate/../x", "", "executive/mutate", "/executive/mutate?x=1"]) {
      expect(() => controlAction({ ...base, endpoint }), endpoint).toThrow("invalid_control_action_endpoint");
    }
    expect([...CONTROL_ACTION_ENDPOINTS]).toEqual(["/executive/mutate", "/owner-controls/connector-credentials"]);
  });

  it("kroppen kan bare ha nøklene ruten kjenner - aldri grant_token eller identitetsfelt på toppnivå", () => {
    for (const key of ["grant_token", "tenant_id", "person_id", "device_id", "session_id", "memory_space", "channel", "auth_strength", "extra"]) {
      expect(() => controlAction({ ...base, body: { ...base.body, [key]: "x" } }), key).toThrow("invalid_control_action_body_key");
    }
    expect(() => controlAction({ ...base, body: [] as never })).toThrow("invalid_control_action_body");
    expect(CONTROL_ACTION_BODY_KEYS["/executive/mutate"]).toEqual(["action", "parameters"]);
  });

  it("handlingsnavnet må stå på rutens allowlist - aldri set_connector_credential (hemmeligheter), en ukjent handling eller en manglende", () => {
    for (const name of ["set_connector_credential", "delete_everything", "", "FREEZE_CONNECTOR", "freeze_connector ", "test_connector"]) {
      expect(() => controlAction({ ...base, body: { action: name, parameters: {} } }), name).toThrow("invalid_control_action_name");
    }
    expect(() => controlAction({ ...base, body: { parameters: {} } })).toThrow("invalid_control_action_name");
    expect(() => controlAction({ ...base, body: { action: 5 as never, parameters: {} } })).toThrow("invalid_control_action_name");
    const secrets = { connector_id: "github", credential_ref: "JARVIS_GITHUB_TOKEN", value: "x" };
    expect(() => controlAction({ ...base, endpoint: "/owner-controls/connector-credentials", body: { action: "set_connector_credential", parameters: secrets }, risk_class: "C" })).toThrow("invalid_control_action_name");
    expect(() => controlAction({ ...base, endpoint: "/owner-controls/connector-credentials", body: { action: "freeze_connector", parameters: {} } })).toThrow("invalid_control_action_name");
    const test = controlAction({ ...base, endpoint: "/owner-controls/connector-credentials", body: { action: "test_connector", parameters: { connector_id: "github" } }, risk_class: "A" });
    expect(test.body["action"]).toBe("test_connector");
    expect(CONTROL_ACTION_ALLOWED["/owner-controls/connector-credentials"]).toEqual(["test_connector"]);
    expect(CONTROL_ACTION_ALLOWED["/executive/mutate"]).toHaveLength(13); // 12 + cancel_task (WP-H0, JARVIS-087)
  });

  it("parametre må være et objekt (ikke liste/streng/null)", () => {
    for (const parameters of [[], "x", 5, null]) {
      expect(() => controlAction({ ...base, body: { action: "freeze_connector", parameters: parameters as never } }), JSON.stringify(parameters)).toThrow("invalid_control_action_parameters");
    }
    expect(controlAction({ ...base, body: { action: "deactivate_kill_switch" } }).body).toEqual({ action: "deactivate_kill_switch" });
  });

  it("ugyldig risikoklasse og ikke-boolske flagg avvises", () => {
    expect(() => controlAction({ ...base, risk_class: "E" as never })).toThrow("invalid_control_action_risk_class");
    expect(() => controlAction({ ...base, requires_step_up: "ja" as never })).toThrow("invalid_control_action_flags");
    expect(() => controlAction({ ...base, reversible: undefined as never })).toThrow("invalid_control_action_flags");
  });
});

describe("composeControlCenterReport: statusen utledes, byggefeil er høylytte", () => {
  const def = { id: "integration" as const, title_no: "Integrasjoner" };

  it("senterstatus er verste seksjon; ingen seksjoner = UNKNOWN; OK kun når alle er målt og OK", () => {
    expect(composeControlCenterReport(def, { sections: [okSection()], actions: [] }, NOW).status).toBe("OK");
    expect(composeControlCenterReport(def, { sections: [okSection(), unknownControlSection("u", "U", "x", "feil")], actions: [] }, NOW).status).toBe("UNKNOWN");
    expect(composeControlCenterReport(def, { sections: [unknownControlSection("u", "U", "x", "feil"), controlSection({ id: "w", title_no: "W", source: "x", summary_no: "s", status: "WARN" })], actions: [] }, NOW).status).toBe("WARN");
    expect(composeControlCenterReport(def, { sections: [], actions: [] }, NOW).status).toBe("UNKNOWN");
  });

  it("rapporten er merket PRIVATE, tidsstemplet kommer fra klokken, og sammendraget teller seksjonene", () => {
    const r = composeControlCenterReport(def, { sections: [okSection("a"), controlSection({ id: "b", title_no: "B", source: "x", summary_no: "s", status: "FAIL" })], actions: [] }, NOW);
    expect(r.sensitivity).toBe("PRIVATE");
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.summary_no).toContain("Integrasjoner: feil");
    expect(r.summary_no).toContain("1 feiler");
    expect(r.summary_no).toContain("1 i orden");
  });

  it("duplikate seksjons-/element-/handlings-id-er og handlinger mot ukjent seksjon/rad kaster", () => {
    const act = (over: Record<string, unknown> = {}) => controlAction({
      id: "a1", label: "L", endpoint: "/executive/mutate", body: { action: "pause_domain", parameters: { domain: "d", reason: "r" } },
      risk_class: "C", requires_step_up: false, reversible: true, description_no: "d", ...over
    });
    expect(() => composeControlCenterReport(def, { sections: [okSection("a"), okSection("a")], actions: [] }, NOW)).toThrow("duplicate_control_section_id");
    const dupItems = controlSection({ id: "a", title_no: "A", source: "x", summary_no: "s", items: [controlItem({ id: "i", label: "1", status: "OK" }), controlItem({ id: "i", label: "2", status: "OK" })] });
    expect(() => composeControlCenterReport(def, { sections: [dupItems], actions: [] }, NOW)).toThrow("duplicate_control_item_id");
    expect(() => composeControlCenterReport(def, { sections: [okSection("a")], actions: [act(), act()] }, NOW)).toThrow("duplicate_control_action_id");
    expect(() => composeControlCenterReport(def, { sections: [okSection("a")], actions: [act({ section_id: "finnes-ikke" })] }, NOW)).toThrow("control_action_unknown_section");
    expect(() => composeControlCenterReport(def, { sections: [okSection("a")], actions: [act({ section_id: "a", item_id: "finnes-ikke" })] }, NOW)).toThrow("control_action_unknown_item");
    expect(() => composeControlCenterReport(def, { sections: [okSection("a")], actions: [act({ item_id: "i" })] }, NOW)).toThrow("control_action_unknown_item");
  });
});

describe("ControlCenterRegistry: registrering og rekkefølge", () => {
  it("register avviser ukjent id, tom tittel/beskrivelse, manglende build og dobbeltregistrering", () => {
    const r = registry();
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    expect(() => r.register(center("ai", async () => ({ sections: [], actions: [] })))).toThrow("control_center_already_registered:ai");
    expect(() => r.register({ ...center("memory", async () => ({ sections: [], actions: [] })), id: "billing" as never })).toThrow("control_center_unknown_id");
    expect(() => r.register({ ...center("memory", async () => ({ sections: [], actions: [] })), title_no: " " })).toThrow("control_center_missing_title:memory");
    expect(() => r.register({ ...center("memory", async () => ({ sections: [], actions: [] })), description_no: "" })).toThrow("control_center_missing_description:memory");
    expect(() => r.register({ ...center("memory", async () => ({ sections: [], actions: [] })), build: undefined as never })).toThrow("control_center_missing_build:memory");
  });

  it("list() gir de registrerte i masterplanens rekkefølge uansett registreringsrekkefølge, og has() svarer kun for registrerte", () => {
    const r = registry();
    for (const id of ["security", "integration", "ai"] as const) r.register(center(id, async () => ({ sections: [okSection()], actions: [] })));
    expect(r.list().map((c) => c.id)).toEqual(["integration", "ai", "security"]);
    expect(r.has("ai")).toBe(true);
    expect(r.has("finance")).toBe(false);
    expect(r.has("nonsense")).toBe(false);
  });
});

describe("ControlCenterRegistry: eier-kun og fail-closed", () => {
  const withOk = () => { const r = registry(); r.register(center("ai", async () => ({ sections: [okSection()], actions: [] }))); return r; };

  it("eieren får rapport og oversikt", async () => {
    const r = withOk();
    expect((await r.report("ai", owner))?.status).toBe("OK");
    expect((await r.overview(owner)).centers).toHaveLength(1);
  });

  it("en annen person, en delegat og eierens person i en annen tenant nektes - rapport, oversikt og forklaring", async () => {
    const r = withOk();
    for (const who of [stranger, delegate, otherTenant]) {
      await expect(r.report("ai", who)).rejects.toBeInstanceOf(ControlCenterAccessError);
      await expect(r.overview(who)).rejects.toBeInstanceOf(ControlCenterAccessError);
      await expect(r.explain("ai", who)).rejects.toBeInstanceOf(ControlCenterAccessError);
      expect(r.authorize(who)).toEqual({ allowed: false, reason: "control_center_owner_only" });
    }
  });

  it("uten eier-predikat nektes ALLE (fail-closed) - en feilkonfigurert kobling lekker aldri konfigurasjon", async () => {
    const r = new ControlCenterRegistry({ now: () => NOW });
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    expect(r.authorize(owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
    await expect(r.report("ai", owner)).rejects.toBeInstanceOf(ControlCenterAccessError);
  });

  it("et eier-predikat som kaster nekter (aldri tillat ved feil)", async () => {
    const r = new ControlCenterRegistry({ isOwner: () => { throw new Error("boom"); } });
    expect(r.authorize(owner).allowed).toBe(false);
  });

  it("bygging skjer ikke i det hele tatt for en nektet identitet", async () => {
    let built = 0;
    const r = registry();
    r.register(center("ai", async () => { built += 1; return { sections: [okSection()], actions: [] }; }));
    await expect(r.report("ai", stranger)).rejects.toThrow();
    expect(built).toBe(0);
  });

  it("ukjent og ikke-koblet senter gir null (ikke feil, ikke OK)", async () => {
    const r = withOk();
    expect(await r.report("finance", owner)).toBeNull();
    expect(await r.report("nonsense", owner)).toBeNull();
    expect(await r.explain("finance", owner)).toBeNull();
  });
});

describe("ControlCenterRegistry: fail-soft", () => {
  it("en bygger som kaster gir en UNKNOWN-rapport med feilkategorien - aldri feilmeldingen, aldri OK - og de andre sentrene påvirkes ikke", async () => {
    const r = registry();
    r.register(center("integration", async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter22 sk-ant-api03-ABCDEFGHIJKLMNOP"); }));
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    const overview = await r.overview(owner);
    const byId = Object.fromEntries(overview.centers.map((c) => [c.center, c]));
    expect(byId["integration"]?.status).toBe("UNKNOWN");
    expect(byId["ai"]?.status).toBe("OK");
    expect(overview.status).toBe("UNKNOWN");
    const json = JSON.stringify(overview) + JSON.stringify(await r.report("integration", owner));
    expect(json).not.toContain("hunter22");
    expect(json).not.toContain("ECONNREFUSED");
    expect(json).not.toContain("sk-ant");
    expect(json).toContain("målingen feilet (Error)");
  });

  it("våre egne konstante feilkoder vises (snake_case), og SQLSTATE tas med", async () => {
    const r = registry();
    r.register(center("integration", async () => ({ sections: [okSection("a"), okSection("a")], actions: [] })));
    r.register(center("ai", async () => { throw Object.assign(new Error("relation \"x\" does not exist"), { code: "42P01", name: "DatabaseError" }); }));
    expect((await r.report("integration", owner))?.sections[0]?.summary_no).toContain("duplicate_control_section_id");
    expect((await r.report("ai", owner))?.sections[0]?.summary_no).toContain("DatabaseError:42P01");
  });

  it("en bygger som aldri svarer gir UNKNOWN etter tidsavbruddet (oversikten henger ikke)", async () => {
    const r = registry({ buildTimeoutMs: 20 });
    r.register(center("integration", () => new Promise(() => undefined)));
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    const t0 = Date.now();
    const overview = await r.overview(owner);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(overview.centers.find((c) => c.center === "integration")?.sections[0]?.summary_no).toContain("målingen tok for lang tid");
    expect(overview.centers.find((c) => c.center === "ai")?.status).toBe("OK");
  });

  it("byggeren får den betrodde identiteten og klokken, aldri noe annet", async () => {
    let seen: ControlCenterBuildContext | undefined;
    const r = registry();
    r.register(center("ai", async (ctx) => { seen = ctx; return { sections: [okSection()], actions: [] }; }));
    await r.report("ai", owner);
    expect(seen?.identity).toBe(owner);
    expect(seen?.now).toEqual(NOW);
  });
});

describe("ControlCenterRegistry: oversikt", () => {
  it("lister de registrerte sentrene og de som ikke er koblet inn - et senter som ikke finnes sies å ikke finnes", async () => {
    const r = registry();
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    const o = await r.overview(owner);
    expect(o.unregistered).toEqual(["integration", "authority", "finance", "memory", "agent", "operations", "value", "privacy", "security"]);
    expect(o.summary_no).toContain("1 av 10 er koblet inn");
    expect(o.summary_no).toContain("Ikke koblet inn ennå");
    expect(o.sensitivity).toBe("PRIVATE");
  });

  it("ingen registrerte sentre = UNKNOWN (aldri OK), med en ærlig tekst", async () => {
    const o = await registry().overview(owner);
    expect(o.status).toBe("UNKNOWN");
    expect(o.centers).toEqual([]);
    expect(o.summary_no).toContain("Ingen kontrollsentre er koblet inn");
    expect(composeControlCenterOverview([], NOW).status).toBe("UNKNOWN");
  });

  it("samlet status er verste av sentrene, og sammendraget bærer seksjonsstatus + antall handlinger", async () => {
    const r = registry();
    r.register(center("ai", async () => ({ sections: [okSection()], actions: [] })));
    r.register(center("integration", async () => ({
      sections: [controlSection({ id: "c", title_no: "Connectorer", source: "x", summary_no: "To feiler", status: "FAIL" })],
      actions: [controlAction({ id: "a1", label: "Frys", endpoint: "/executive/mutate", body: { action: "freeze_connector", parameters: { connector_id: "github", reason: "r" } }, risk_class: "C", requires_step_up: false, reversible: true, description_no: "d" })]
    })));
    const o = await r.overview(owner);
    expect(o.status).toBe("FAIL");
    const integ = o.centers.find((c) => c.center === "integration");
    expect(integ).toMatchObject({ status: "FAIL", action_count: 1 });
    expect(integ?.sections[0]).toEqual({ id: "c", title_no: "Connectorer", status: "FAIL", measured: true, summary_no: "To feiler" });
    expect(integ?.description_no).toBe("Beskrivelse av integration");
  });
});

describe("hemmelighetsvern: siste forsvarslinje i registeret", () => {
  const redact = (t: string) => t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/hunter22/g, "[REDACTED]");

  it("redigerer menneskelesbare felt (tittel, sammendrag, kilde, etikett, detalj, tekstfakta, handlingstekster) men aldri id-er, endepunkt eller handlingskropper", async () => {
    const leaky = "nøkkel sk-ant-api03-LEAK passord hunter22";
    const r = registry({ redact });
    r.register(center("integration", async () => ({
      sections: [controlSection({
        id: "sec-sk-ant-keep", title_no: `T ${leaky}`, source: `S ${leaky}`, summary_no: `Sum ${leaky}`,
        items: [controlItem({ id: "item-sk-ant-keep", label: `L ${leaky}`, status: "OK", detail_no: `D ${leaky}`, facts: { tekst: `F ${leaky}`, tall: 7, ja: true } })]
      })],
      actions: [controlAction({
        id: "act-sk-ant-keep", label: `A ${leaky}`, endpoint: "/executive/mutate",
        body: { action: "freeze_connector", parameters: { connector_id: "github", reason: "sk-ant-api03-IBODY" } },
        risk_class: "C", requires_step_up: false, reversible: true, description_no: `B ${leaky}`, rollback_no: `R ${leaky}`
      })]
    })));
    const report = await r.report("integration", owner);
    const human = JSON.stringify({
      t: report?.title_no, s: report?.summary_no, sec: report?.sections.map((s) => [s.title_no, s.source, s.summary_no, s.items.map((i) => [i.label, i.detail_no, i.facts])]),
      act: report?.actions.map((a) => [a.label, a.description_no, a.rollback_no])
    });
    expect(human).not.toContain("LEAK");
    expect(human).not.toContain("hunter22");
    expect(human).toContain("[REDACTED]");
    // Strukturelle felt er urørt (en falsk positiv der ville ødelagt handlingen):
    expect(report?.sections[0]?.id).toBe("sec-sk-ant-keep");
    expect(report?.sections[0]?.items[0]?.id).toBe("item-sk-ant-keep");
    expect(report?.actions[0]?.id).toBe("act-sk-ant-keep");
    expect(report?.actions[0]?.endpoint).toBe("/executive/mutate");
    expect(report?.actions[0]?.body).toEqual({ action: "freeze_connector", parameters: { connector_id: "github", reason: "sk-ant-api03-IBODY" } });
    expect(report?.sections[0]?.items[0]?.facts).toMatchObject({ tall: 7, ja: true });
  });

  it("registeret avviser en redigerer som ikke redigerer (identitetsfunksjonen m.fl.) allerede ved konstruksjon - «redigeringen er på» er ikke bare en påstand om oppstartskoden (gjennomgang av PR #316, M-2)", () => {
    for (const [label, bad] of [["identitet", (t: string) => t], ["bare store bokstaver", (t: string) => t.toUpperCase()], ["kaster", () => { throw new Error("x"); }], ["ikke-streng", (() => 1) as never]] as const) {
      expect(isEffectiveRedactor(bad), label).toBe(false);
      expect(() => new ControlCenterRegistry({ isOwner, redact: bad }), label).toThrow("control_center_redact_not_effective");
    }
    expect(isEffectiveRedactor(redact)).toBe(true);
    expect(() => new ControlCenterRegistry({ isOwner, redact })).not.toThrow();
    expect(() => new ControlCenterRegistry({ isOwner })).not.toThrow();
  });

  it("redactControlCenterReport muterer ikke inndata", () => {
    const original = composeControlCenterReport({ id: "ai", title_no: "AI" }, { sections: [controlSection({ id: "a", title_no: "T hunter22", source: "x", summary_no: "s" })], actions: [] }, NOW);
    const copy = JSON.parse(JSON.stringify(original));
    redactControlCenterReport(original, redact);
    expect(original).toEqual(copy);
  });
});

describe("explainControlCenterNo: deterministisk norsk forklaring", () => {
  const status = (s: ControlStatus) => controlSection({ id: s.toLowerCase(), title_no: `Seksjon ${s}`, source: `tabell_${s.toLowerCase()}`, summary_no: `Sammendrag ${s}`, status: s, observed_at: s === "UNKNOWN" ? null : NOW.toISOString(), measured: s !== "UNKNOWN" });

  it("WARN/FAIL: nevner hvilke seksjoner og rader det skyldes, kilden og når det ble målt", () => {
    const report = composeControlCenterReport({ id: "integration", title_no: "Integrasjoner" }, {
      sections: [
        controlSection({ id: "c", title_no: "Connectorer", source: "connector-registeret", summary_no: "1 connector feiler", observed_at: NOW.toISOString(), items: [
          controlItem({ id: "gh", label: "GitHub", status: "FAIL", detail_no: "auth_failed siste kall" }), controlItem({ id: "ok", label: "Slack", status: "OK" })
        ] }),
        status("OK")
      ], actions: []
    }, NOW);
    const text = explainControlCenterNo(report);
    expect(text).toContain("Integrasjoner er feil fordi");
    expect(text).toContain("Connectorer (feil): 1 connector feiler");
    expect(text).toContain("GitHub (feil): auth_failed siste kall");
    expect(text).not.toContain("Slack");
    expect(text).toContain("Kilde: connector-registeret, målt 2026-10-09T10:00:00.000Z");
    expect(text).not.toContain("Seksjon OK"); // seksjoner i orden forklares ikke som årsak
  });

  it("UNKNOWN sies som ukjent - ikke som i orden", () => {
    const report = composeControlCenterReport({ id: "ai", title_no: "AI" }, { sections: [status("UNKNOWN")], actions: [] }, NOW);
    const text = explainControlCenterNo(report);
    expect(text).toContain("AI er ikke målt fordi");
    expect(text).toContain("kunne ikke måles, så dette er ukjent og ikke «i orden»");
  });

  it("OK: sier at alt er målt og i orden, og nevner hva som er målt", () => {
    const report = composeControlCenterReport({ id: "ai", title_no: "AI" }, { sections: [status("OK")], actions: [] }, NOW);
    expect(explainControlCenterNo(report)).toContain("AI er i orden: alle 1 seksjoner er målt og uten funn.");
    expect(explainControlCenterNo(report)).toContain("tabell_ok");
  });

  it("handlinger nevnes med antall og step-up-krav, og at senteret ikke utfører noe selv", () => {
    const a = (id: string, stepUp: boolean) => controlAction({ id, label: id, endpoint: "/executive/mutate", body: { action: "pause_domain", parameters: { domain: id, reason: "r" } }, risk_class: "C", requires_step_up: stepUp, reversible: true, description_no: "d" });
    const report = composeControlCenterReport({ id: "ai", title_no: "AI" }, { sections: [status("WARN")], actions: [a("a", false), a("b", true), a("c", true)] }, NOW);
    const text = explainControlCenterNo(report);
    expect(text).toContain("Handlinger eieren kan ta herfra: 3 (2 krever signert enhetsøkt)");
    expect(text).toContain("utfører ingenting selv");
  });

  it("forklaringen er helt deterministisk (samme rapport gir samme tekst) og kutter lange lister", () => {
    const items = Array.from({ length: 9 }, (_, i) => controlItem({ id: `i${i}`, label: `Rad ${i}`, status: "WARN", detail_no: "d" }));
    const report = composeControlCenterReport({ id: "ai", title_no: "AI" }, { sections: [controlSection({ id: "a", title_no: "A", source: "x", summary_no: "mange", items })], actions: [] }, NOW);
    expect(explainControlCenterNo(report)).toBe(explainControlCenterNo(report));
    expect(explainControlCenterNo(report)).toContain("… og 4 til");
  });

  it("registeret.explain gir samme tekst som den rene funksjonen", async () => {
    const r = registry();
    r.register(center("ai", async () => ({ sections: [status("WARN")], actions: [] })));
    const report = await r.report("ai", owner);
    expect(await r.explain("ai", owner)).toBe(explainControlCenterNo(report!));
  });
});
