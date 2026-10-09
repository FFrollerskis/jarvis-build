import { describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ExecutiveService, ExecutiveTransport, composeEvolutionReport, executiveToolDefinitions, renderEvolutionReportNo, unknownSection, type EvolutionSection } from "../src/index.ts";

/**
 * WP-B (D-452): evolusjonsrapportens type, komposisjon og eksponering som et vanlig, kun-lesende ToolGateway-verktøy (`executive.get_evolution_report`), samme mønster som `get_slo_report`.
 */
const section = (over: Partial<EvolutionSection> = {}): EvolutionSection => ({
  ev: "EV-1", title_no: "Test", mode: "observe", status: "OK", summary_no: "alt bra", findings: [], source: "test", observed_at: null, ...over
});
const gateway = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;

describe("composeEvolutionReport", () => {
  it("acts er alltid false, og oppsummeringen skiller OK / oppmerksomhet / ikke målt / sovende", () => {
    const report = composeEvolutionReport({
      as_of: "2026-10-15T12:00:00.000Z",
      sections: [section(), section({ ev: "EV-2", status: "ATTENTION", summary_no: "se på dette" }), section({ ev: "EV-3", status: "UNKNOWN" }), section({ ev: "EV-6", status: "DORMANT", mode: "dormant" }), section({ ev: "EV-7", status: "DORMANT", mode: "dormant" })]
    });
    expect(report.acts).toBe(false);
    expect(report.summary_no).toContain("1 OK, 1 trenger oppmerksomhet, 1 ikke målt, 2 sovende");
    expect(report.summary_no).toContain("jeg endrer ingenting av meg selv");
    expect(report.summary_no).toContain("💤 EV-6");
    expect(report.summary_no).toContain("⚠️ EV-2");
  });

  it("viser høyst fire funn per seksjon og sier hvor mange som er utelatt", () => {
    const report = composeEvolutionReport({ as_of: "x", sections: [section({ findings: ["a", "b", "c", "d", "e", "f"] })] });
    expect(report.summary_no).toContain("   - d");
    expect(report.summary_no).not.toContain("   - e");
    expect(report.summary_no).toContain("… og 2 til");
  });

  it("unknownSection er UNKNOWN (aldri OK) og bærer årsaken", () => {
    const s = unknownSection("EV-9", "Heal", "kilde", "ingen data");
    expect(s).toMatchObject({ status: "UNKNOWN", mode: "observe", observed_at: null });
    expect(renderEvolutionReportNo({ as_of: "x", acts: false, sections: [s] })).toContain("❔ EV-9 Heal: Ikke målt: ingen data");
  });
});

describe("ExecutiveService.getEvolutionReport", () => {
  it("uten kilde: én ærlig UNKNOWN-seksjon (aldri en gjetning om at noe er i orden)", async () => {
    const report = await new ExecutiveService(gateway).getEvolutionReport();
    expect(report.acts).toBe(false);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({ status: "UNKNOWN" });
    expect(report.summary_no).toContain("Ingen kilde er koblet inn");
  });

  it("med kilde: returnerer kildens rapport uendret", async () => {
    const injected = composeEvolutionReport({ as_of: "2026-10-15T00:00:00.000Z", sections: [section()] });
    const report = await new ExecutiveService(gateway, { evolution: { report: async () => injected } }).getEvolutionReport();
    expect(report).toBe(injected);
  });
});

describe("executive.get_evolution_report som verktøy", () => {
  const transport = new ExecutiveTransport(new ExecutiveService(gateway, { evolution: { report: async () => composeEvolutionReport({ as_of: "2026-10-15T00:00:00.000Z", sections: [section()] }) } }));
  const context = { identity: { tenant_id: "t1", person_id: "p1", memory_space_id: "personal" } } as never;

  it("er registrert som lesing (klasse A), uten parametre og uten skrive-scope", () => {
    const def = executiveToolDefinitions(transport).find((d) => d.action === "get_evolution_report");
    expect(def).toBeDefined();
    expect(def!.capability_class).toBe("A");
    expect(def!.scopes.join(",")).not.toContain("write");
    expect(def!.input_schema.safeParse({}).success).toBe(true);
    expect(def!.description).toContain("KUN observasjon");
  });

  it("transporten returnerer rapporten med acts:false og norsk oppsummering", async () => {
    const result = await transport.invoke("get_evolution_report", {}, "", context);
    const data = result.data as unknown as { acts: boolean; summary_no: string };
    expect(data.acts).toBe(false);
    expect(data.summary_no).toContain("Evolusjonsporter");
  });
});
