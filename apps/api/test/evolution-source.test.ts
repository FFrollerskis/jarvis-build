import { describe, expect, it } from "vitest";
import type { SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import type { ConnectorStatus } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import {
  MAINTENANCE_COVERAGE, boundariesSection, buildEvolutionReport, costSection, createEvolutionReportProvider, credentialsSection, maintenanceSection, modelRouteSection, proposalsSection,
  type EvolutionContext, type EvolutionSourceDeps
} from "../src/evolution-source.ts";
import { MAINTENANCE_CATALOG } from "@jarvis/self-modification";

/**
 * WP-B (D-452): evolusjonsportene i observasjonsmodus. Seksjonene leser eksisterende observerbarhet og kjører de rene EV-reglene; ingenting skrives eller utføres (`acts: false`), og en måling som feiler
 * blir UNKNOWN (aldri «OK» ved feil). Her mot en skriptet pool (ingen database), slik at hvert tall kan styres.
 */
type Handler = [RegExp, (params: unknown[]) => unknown[]];
function fakePool(handlers: Handler[], seen: string[] = []): EvolutionSourceDeps["pool"] {
  const run = async (sql: string, params: unknown[] = []) => {
    seen.push(sql);
    const hit = handlers.find(([re]) => re.test(sql));
    return { rows: hit ? hit[1](params) : [], rowCount: 0 };
  };
  return { query: run, connect: async () => ({ query: run, release: () => undefined }) } as never;
}

const NOW = new Date("2026-10-15T12:00:00.000Z");
const okSlo = (breaches = 0): SloReport => ({
  as_of: NOW.toISOString(), not_measured: [], drift: null, data_quality: null, summary_no: "",
  slos: Array.from({ length: breaches + 1 }, (_, i) => ({ id: `s${i}`, label: `slo ${i}`, status: i < breaches ? "BREACH" : "OK", value: 1, target: 1, metric: "m", samples: 10, window_hours: 24, source: "x", observed_at: NOW.toISOString(), detail: "d" })) as never
});
const verified: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "abc" }, ledger: { status: "ok", count: 12, head_hash: "h" } };
const unsigned: Ev0BootStatus = { constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "ok", count: 0, head_hash: "h" } };
const mesh = (over: Partial<MeshStatus> = {}, providers: MeshStatus["providers"] = [
  { provider: "gemma_local", model: "g", state: "LIVE", success: 5, failures: 0 },
  { provider: "anthropic", model: "c", state: "CONFIGURED", success: 0, failures: 0 }
]): MeshStatus => ({ providers, router: "HEALTHY", fallback: "READY", critic: "READY_SELECTIVE", ...over });
const connector = (id: string, configured: boolean, health: ConnectorStatus["health"] = null): ConnectorStatus =>
  ({ id, display_name: id, category: "integration" as never, configured, credentials: [], test_method: "presence_only", health });

function deps(over: Partial<EvolutionSourceDeps> & { handlers?: Handler[] } = {}): EvolutionSourceDeps {
  const { handlers, ...rest } = over;
  return {
    pool: fakePool(handlers ?? []),
    tenantId: "t1",
    now: () => NOW,
    env: {},
    ev0Status: () => verified,
    slo: async () => okSlo(),
    connectors: async () => [],
    killSwitchActive: async () => false,
    mesh: () => mesh(),
    ...rest
  };
}
const ctxOf = (d: EvolutionSourceDeps): EvolutionContext => ({ pool: d.pool, tenantId: d.tenantId, now: NOW, env: d.env ?? {}, deps: d });

describe("EV-0/EV-8: endringsgrenser og frys", () => {
  it("signert konstitusjon, intakt register, ingen hendelser → OK, og selvendring står som frosset", async () => {
    const s = await boundariesSection(ctxOf(deps({ handlers: [[/FROM incidents/, () => [{ n: 0 }]]] })));
    expect(s.status).toBe("OK");
    expect(s.findings.join("\n")).toContain("Safety Constitution er verifisert");
    expect(s.findings.join("\n")).toContain("hash-kjeden er intakt (12 rader)");
    expect(s.findings.join("\n")).toContain("Change freeze er av");
    expect(s.findings.join("\n")).toContain("Selvendring er frosset (D-397)");
  });

  it("usignert konstitusjon er ATTENTION (Evolution kan ikke aktiveres), med koden i funnet", async () => {
    const s = await boundariesSection(ctxOf(deps({ ev0Status: () => unsigned, handlers: [[/FROM incidents/, () => [{ n: 0 }]]] })));
    expect(s.status).toBe("ATTENTION");
    expect(s.findings.join("\n")).toContain("constitution_unsigned");
  });

  it("ødelagt hash-kjede, kill switch, åpen hendelse og brutt SLO gir frys og ATTENTION; ukjent oppstartssjekk sies som ukjent", async () => {
    const broken: Ev0BootStatus = { constitution: verified.constitution, ledger: { status: "broken", broken_seq: "7", count: 9 } };
    const s = await boundariesSection(ctxOf(deps({ ev0Status: () => broken, slo: async () => okSlo(2), killSwitchActive: async () => true, handlers: [[/FROM incidents/, () => [{ n: 3 }]]] })));
    expect(s.status).toBe("ATTENTION");
    const text = s.findings.join("\n");
    expect(text).toContain("ØDELAGT fra rad 7");
    expect(text).toContain("Change freeze er PÅ");
    for (const reason of ["kill_switch_active", "incident_open", "slo_breached"]) expect(text).toContain(reason);
    const unknown = await boundariesSection(ctxOf(deps({ ev0Status: () => null, handlers: [[/FROM incidents/, () => [{ n: 0 }]]] })));
    expect(unknown.findings.join("\n")).toContain("har ikke kjørt (ukjent)");
  });

  it("SLO-rapporten utilgjengelig → observerbarhet mangler, som gir frys (aldri «OK» uten måling); hendelser som ikke kan telles sies", async () => {
    const s = await boundariesSection(ctxOf(deps({ slo: async () => { throw new Error("nede"); }, pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error("db nede"); } } as never })));
    expect(s.findings.join("\n")).toContain("observability_missing");
    expect(s.findings.join("\n")).toContain("Åpne hendelser kunne ikke telles");
    expect(s.status).toBe("ATTENTION");
  });
});

describe("EV-5: endringsforslag", () => {
  it("tellinger per beslutning og antall som venter på eier", async () => {
    const s = await proposalsSection(ctxOf(deps({ handlers: [[/DISTINCT ON \(change_id\)/, () => [{ n: 2 }]], [/GROUP BY decision/, () => [{ decision: "blocked", n: 1 }, { decision: "proposed", n: 3 }]]] })));
    expect(s.status).toBe("ATTENTION");
    expect(s.summary_no).toContain("2 forslag venter på deg");
    expect(s.findings.join("\n")).toContain("1 blocked, 3 proposed");
    expect(s.findings.join("\n")).toContain("E3 avvises alltid");
  });
  it("ingen forslag → OK", async () => {
    const s = await proposalsSection(ctxOf(deps({ handlers: [[/DISTINCT ON \(change_id\)/, () => [{ n: 0 }]], [/GROUP BY decision/, () => []]] })));
    expect(s.status).toBe("OK");
    expect(s.summary_no).toContain("Ingen forslag er registrert");
  });
});

describe("EV-16: kostnad og kapasitet", () => {
  const baseline = Array.from({ length: 6 }, (_, i) => ({ day: `2026-10-${String(8 + i).padStart(2, "0")}`, provider: "anthropic", ore: 100 }));
  it("kostnadsavvik i dag mot en stabil baseline gir ATTENTION med leverandør, beløp og snitt - aldri innhold", async () => {
    const s = await costSection(ctxOf(deps({ handlers: [[/GROUP BY 1, 2/, () => [...baseline, { day: "2026-10-15", provider: "anthropic", ore: 2500 }]], [/::bigint/, () => [{ n: 3000 }]]] })));
    expect(s.status).toBe("ATTENTION");
    expect(s.findings.join("\n")).toContain("Uvanlig kostnad i dag hos anthropic: 25 kr mot snitt 1 kr");
    expect(s.findings.join("\n")).toContain("Hittil i måneden: 30 kr");
    expect(s.findings.join("\n")).toContain("ingen utgift, opprydding eller påfyll utløses herfra");
  });
  it("rolig måned under grensene → OK med rekkevidde", async () => {
    const s = await costSection(ctxOf(deps({ handlers: [[/GROUP BY 1, 2/, () => baseline], [/::bigint/, () => [{ n: 1500 }]]] })));
    expect(s.status).toBe("OK");
    expect(s.findings.join("\n")).toMatch(/Rekkevidde til hardgrensen med dagens tempo: \d+/);
  });
  it("varselgrensen (JARVIS_COST_WARN_ORE) passert → ATTENTION; ugyldig env faller til standard", async () => {
    const handlers: Handler[] = [[/GROUP BY 1, 2/, () => baseline], [/::bigint/, () => [{ n: 150_000 }]]];
    const s = await costSection(ctxOf(deps({ handlers })));
    expect(s.status).toBe("ATTENTION");
    expect(s.summary_no).toContain("Varselgrensen er passert");
    const strict = await costSection(ctxOf(deps({ handlers, env: { JARVIS_COST_WARN_ORE: "ikke et tall" } })));
    expect(strict.findings.join("\n")).toContain("varselgrense 1000 kr");
  });
  it("ingen kostnad hittil i måneden → ingen utregnet rekkevidde", async () => {
    const s = await costSection(ctxOf(deps({ handlers: [[/GROUP BY 1, 2/, () => []], [/::bigint/, () => [{ n: 0 }]]] })));
    expect(s.findings.join("\n")).toContain("ingen utregnet rekkevidde");
  });
});

describe("EV-17: nøkler og tilkoblinger", () => {
  it("konfigurerte tilkoblinger med feilende helse trekkes frem; ikke-konfigurerte er ikke en feil; manglende måling er ukjent", async () => {
    const s = await credentialsSection(ctxOf(deps({
      connectors: async () => [
        connector("github", true, { state: "healthy", at: NOW.toISOString() }),
        connector("gmail", true, { state: "unauthorized", at: NOW.toISOString() }),
        connector("notion", true, null),
        connector("slack", false, null)
      ]
    })));
    expect(s.status).toBe("ATTENTION");
    const text = s.findings.join("\n");
    expect(text).toContain("3 av 4 kjente tilkoblinger er konfigurert; 1 er ikke konfigurert");
    expect(text).toContain("gmail (refresh_failing, human_external_gate)");
    expect(text).toContain("1 konfigurerte tilkoblinger har ingen helsemåling ennå");
    expect(text).toContain("Utløpsdato er ikke målt");
    expect(JSON.stringify(s)).not.toMatch(/token|secret|password/i);
  });
  it("alt sunt → OK", async () => {
    const s = await credentialsSection(ctxOf(deps({ connectors: async () => [connector("github", true, { state: "healthy", at: NOW.toISOString() })] })));
    expect(s.status).toBe("OK");
  });
});

describe("EV-19: vedlikeholdsplan", () => {
  it("koblede oppgaver uten kjøring er forfalt; dekningen oppgis ærlig (hvor mange har en utfører)", async () => {
    const s = await maintenanceSection(ctxOf(deps({ handlers: [[/FROM scheduler_state/, () => []]] })));
    expect(s.status).toBe("ATTENTION");
    const text = s.findings.join("\n");
    expect(text).toContain("Forfalt nå:");
    expect(text).toContain("health_check");
    const covered = Object.keys(MAINTENANCE_COVERAGE).length;
    expect(text).toContain(`${covered} av ${MAINTENANCE_CATALOG.length} vedlikeholdsoppgaver har en utfører`);
    expect(text).toContain("ikke koblet ennå");
    expect(text).toContain("backup_status");
  });
  it("nylig kjørte planlagte jobber er ikke forfalt (rapport-dekkede oppgaver regnes som kjørt når rapporten leses)", async () => {
    const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
    const s = await maintenanceSection(ctxOf(deps({ handlers: [[/FROM scheduler_state/, () => [{ job_name: "connector-health-sweep", last: recent }, { job_name: "daily-brief", last: recent }]]] })));
    expect(s.status).toBe("OK");
    expect(s.summary_no).toContain("Ingenting forfalt");
  });
  it("hver dekning peker på en oppgave som finnes i katalogen (ingen råtnende kobling)", () => {
    const ids = new Set(MAINTENANCE_CATALOG.map((t) => t.id));
    for (const id of Object.keys(MAINTENANCE_COVERAGE)) expect(ids.has(id), id).toBe(true);
  });
});

describe("EV-12: modellrute i skygge", () => {
  it("lokal + sky uten sett fallback → funn for begge kritiske arbeidsflyter (aldri testet), og skyggen ruter ingenting om", async () => {
    const s = await modelRouteSection(ctxOf(deps()));
    expect(s.status).toBe("ATTENTION");
    const text = s.findings.join("\n");
    expect(text).toContain("CHAT: fallback-kjeden er aldri testet");
    expect(text).toContain("BACKGROUND: fallback-kjeden er aldri testet");
    expect(text).toContain("ruter ingenting om");
  });
  it("bare én leverandør brukbar gir konsentrasjonsrisiko; nedlagte leverandører nevnes", async () => {
    const s = await modelRouteSection(ctxOf(deps({ mesh: () => mesh({}, [{ provider: "gemma_local", model: "g", state: "LIVE", success: 1, failures: 0 }, { provider: "anthropic", model: "c", state: "UNAVAILABLE", success: 0, failures: 3 }, { provider: "scripted", model: "s", state: "LIVE", success: 0, failures: 0 }]) })));
    expect(s.findings.join("\n")).toContain("bare én leverandør i kjeden");
    expect(s.findings.join("\n")).toContain("nede: anthropic");
    expect(s.findings.join("\n")).not.toContain("scripted");
  });
  it("to leverandører og en verifisert fallback → OK", async () => {
    const s = await modelRouteSection(ctxOf(deps({ mesh: () => mesh({ fallback: "VERIFIED" }) })));
    expect(s.status).toBe("OK");
  });
});

describe("rapporten", () => {
  const handlers: Handler[] = [
    [/FROM incidents/, () => [{ n: 0 }]], [/DISTINCT ON \(change_id\)/, () => [{ n: 0 }]], [/GROUP BY decision/, () => []],
    [/GROUP BY 1, 2/, () => []], [/::bigint/, () => [{ n: 0 }]], [/FROM scheduler_state/, () => []]
  ];

  it("består av seksjonene i fast rekkefølge, har acts:false, og en norsk oppsummering som skiller OK/oppmerksomhet/ikke målt/sovende", async () => {
    const report = await buildEvolutionReport(deps({ handlers }));
    expect(report.acts).toBe(false);
    expect(report.sections.map((s) => s.ev)).toEqual(["EV-0/EV-8", "EV-5", "EV-12", "EV-16", "EV-17", "EV-19"]);
    expect(report.summary_no).toContain("kun observasjon - jeg endrer ingenting av meg selv");
    expect(report.summary_no).toMatch(/\d+ OK, \d+ trenger oppmerksomhet, \d+ ikke målt, \d+ sovende/);
    for (const s of report.sections) expect(s.mode).toBe("observe");
  });

  it("en seksjon som feiler blir UNKNOWN med årsaken - resten av rapporten påvirkes ikke", async () => {
    const report = await buildEvolutionReport(deps({ handlers, connectors: async () => { throw new Error("registeret svarte ikke"); } }));
    const credentials = report.sections.find((s) => s.ev === "EV-17")!;
    expect(credentials.status).toBe("UNKNOWN");
    expect(credentials.summary_no).toContain("registeret svarte ikke");
    expect(report.sections.find((s) => s.ev === "EV-5")!.status).toBe("OK");
  });

  it("ekstra seksjoner (B2 og senere) legges til og er også fail-soft", async () => {
    const report = await buildEvolutionReport(deps({
      handlers,
      extraSections: [async () => ({ ev: "EV-X", title_no: "Ekstra", mode: "dormant", status: "DORMANT", summary_no: "sover", findings: [], source: "test", observed_at: null }), async () => { throw new Error("boom"); }]
    }));
    expect(report.sections.map((s) => s.ev).slice(-2)).toEqual(["EV-X", "EV-extra-2"]);
    expect(report.sections.at(-1)!.status).toBe("UNKNOWN");
    expect(report.summary_no).toContain("1 sovende");
  });

  it("leverandøren cacher i kort tid (ett bygg per vindu) og kaster aldri en mislykket cache videre", async () => {
    let calls = 0;
    let now = NOW.getTime();
    const provider = createEvolutionReportProvider(deps({ handlers, now: () => new Date(now), mesh: () => { calls += 1; return mesh(); } }), { ttlMs: 1000 });
    const a = await provider();
    const b = await provider();
    expect(b).toBe(a);
    expect(calls).toBe(1);
    now += 2000;
    await provider();
    expect(calls).toBe(2);
  });

  it("ingen hemmelige verdier eller innhold i rapporten: kun antall, kategorier og ID-er", async () => {
    const report = await buildEvolutionReport(deps({ handlers, connectors: async () => [connector("github", true, { state: "healthy", at: NOW.toISOString(), detail: "Authorization: Bearer abc" })] }));
    expect(JSON.stringify(report)).not.toContain("Bearer");
  });
});
