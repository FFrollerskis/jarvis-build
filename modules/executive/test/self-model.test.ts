import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_POLICY, EXPECTED_AREAS, buildLimitationRegistry, composeSelfDiagnosis, computeConfidenceGate, renderSelfDiagnosisNo,
  type ConfidenceSignals, type Observation, type ObservationReader
} from "../src/index.ts";

/** EV-1 (D-412): selvmodell - ren logikk, ingen DB/nettverk. */
const NOW = () => new Date("2026-10-07T10:30:00.000Z");
const ok = (source: string, detail = "ok"): Observation => ({ status: "OK", source, observed_at: "2026-10-07T10:30:00.000Z", detail });
const bad = (status: "DEGRADED" | "DOWN", source: string, detail: string): Observation => ({ status, source, observed_at: "2026-10-07T10:30:00.000Z", detail });
const allOk = (): Record<string, ObservationReader> =>
  Object.fromEntries(EXPECTED_AREAS.map((a) => [a.id, async () => ok(`src:${a.id}`)]));

describe("A: selvdiagnose - kildebelagt og ærlig om ukjent", () => {
  it("A1: alt OK -> overall OK uten funn, og gjengivelsen sier frisk", async () => {
    const d = await composeSelfDiagnosis({ readers: allOk(), limitations: [], now: NOW });
    expect(d.overall).toBe("OK");
    expect(d.findings).toEqual([]);
    expect(d.unknown).toEqual([]);
    expect(renderSelfDiagnosisNo(d)).toContain("Jeg er frisk");
  });

  it("A2: manglende leser = UNKNOWN (aldri OK); ukjent KRITISK del gir overall UNKNOWN, ikke OK", async () => {
    const readers = allOk();
    delete readers["database"];
    const d = await composeSelfDiagnosis({ readers, limitations: [], now: NOW });
    expect(d.observations["database"]).toMatchObject({ status: "UNKNOWN", observed_at: null });
    expect(d.unknown).toContain("database");
    expect(d.overall).toBe("UNKNOWN");
  });

  it("A3: ukjent ikke-kritisk del (f.eks. backup) gir fortsatt OK, men listes som ukjent og vises ærlig", async () => {
    const readers = allOk();
    delete readers["backup"];
    const d = await composeSelfDiagnosis({ readers, limitations: [], now: NOW });
    expect(d.overall).toBe("OK");
    expect(d.unknown).toEqual(["backup"]);
    expect(renderSelfDiagnosisNo(d)).toContain("Jeg kan ikke måle: backup");
  });

  it("A4: en leser som kaster blir UNKNOWN med feilen - kaster aldri videre", async () => {
    const readers = { ...allOk(), providers: async (): Promise<Observation> => { throw new Error("nettverk nede"); } };
    const d = await composeSelfDiagnosis({ readers, limitations: [], now: NOW });
    expect(d.observations["providers"]!.status).toBe("UNKNOWN");
    expect(d.observations["providers"]!.detail).toContain("nettverk nede");
  });

  it("A5: kritisk DOWN -> overall DOWN; ikke-kritisk DOWN -> kun DEGRADED; funn sortert kritisk først", async () => {
    const down = { ...allOk(), database: async () => bad("DOWN", "pg", "Databasen svarer ikke") };
    expect((await composeSelfDiagnosis({ readers: down, limitations: [], now: NOW })).overall).toBe("DOWN");
    const soft = { ...allOk(), tasks: async () => bad("DOWN", "tasks", "3 jobber står fast"), errors: async () => bad("DEGRADED", "tool_executions", "12 % feil") };
    const d = await composeSelfDiagnosis({ readers: soft, limitations: [], now: NOW });
    expect(d.overall).toBe("DEGRADED");
    expect(d.findings.map((f) => f.severity)).toEqual(["critical", "warning"]);
  });

  it("A6: flere observasjoner fra én leser (en pr. leverandør) beholdes med eget funn, kilde og tidspunkt", async () => {
    const readers = { ...allOk(), providers: async () => [ok("mesh:gemma_local"), bad("DOWN", "mesh:anthropic", "anthropic er nede")] };
    const d = await composeSelfDiagnosis({ readers, limitations: [], now: NOW });
    expect(Object.keys(d.observations).filter((k) => k.startsWith("providers"))).toEqual(["providers:0", "providers:1"]);
    expect(d.overall).toBe("DOWN");
    expect(d.findings[0]).toMatchObject({ severity: "critical", source: "mesh:anthropic", area: "providers:1" });
    expect(renderSelfDiagnosisNo(d)).toContain("[mesh:anthropic 10:30]");
  });

  it("A7: gjengivelsen kutter ved maxFindings og kan inkludere begrensninger", async () => {
    const many = { ...allOk(), connectors: async () => Array.from({ length: 12 }, (_, i) => bad("DEGRADED", `c${i}`, `feil ${i}`)) };
    const d = await composeSelfDiagnosis({ readers: many, limitations: [{ id: "x", statement: "Jeg kan ikke X.", kind: "policy", source_ref: "t" }], now: NOW });
    const text = renderSelfDiagnosisNo(d, { maxFindings: 3, includeLimitations: true });
    expect(text).toContain("… og 9 til.");
    expect(text).toContain("- Jeg kan ikke X.");
  });
});

describe("B: limitation registry - avledet fra kodens egne registre", () => {
  const input = {
    forbiddenModelToolIds: ["docker", "finance"],
    connectors: [{ id: "tiktok", category: "backlog_social" }, { id: "slack", test_method: "presence_only" }, { id: "github", test_method: "live" }],
    modelProfiles: [{ provider: "kimi", capabilities: ["text"] }, { provider: "claude", capabilities: ["text", "tool_calling"] }],
    allModelCapabilities: ["text", "tool_calling"]
  };
  const reg = buildLimitationRegistry(input);

  it("B1: håndskrevne poster finnes (frosset selvendring, ingen bevissthetspåstand, uten backup-heartbeat)", () => {
    const ids = reg.map((l) => l.id);
    for (const id of ["self_modification_frozen", "no_consciousness_claim", "no_backup_heartbeat", "no_own_authority_changes"]) expect(ids).toContain(id);
  });

  it("B2: forbudte verktøy, backlog-connectorer, presence-only og modeller uten evne avledes - og friske poster gir ingen begrensning", () => {
    const ids = reg.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["forbidden_tool:docker", "forbidden_tool:finance", "connector_backlog:tiktok", "connector_unverified:slack", "model_missing:kimi"]));
    expect(ids).not.toContain("connector_unverified:github");
    expect(ids).not.toContain("model_missing:claude");
  });

  it("B3: hver post har kilde og gyldig type; id-er er unike", () => {
    expect(new Set(reg.map((l) => l.id)).size).toBe(reg.length);
    for (const l of reg) {
      expect(l.source_ref.length).toBeGreaterThan(0);
      expect(["policy", "technical", "deferred", "unverified"]).toContain(l.kind);
    }
  });
});

describe("C: confidence gate - metrikk-avledet, aldri selvrapportert", () => {
  const strong: ConfidenceSignals = {
    eval: { score: 0.95, delta: 0.02 }, evidence: { independent_sources: 2, primary_source: true }, data: { fresh: true, contradictory: false },
    history: { successes: 19, failures: 1 }, runtime: { tests_passed: true, health: "OK", partial_execution: false }, ambiguity: { unresolved_requirements: 0 }
  };

  it("C1: sterke signaler på alle områder -> auto", () => {
    const r = computeConfidenceGate(strong);
    expect(r.band).toBe("auto");
    expect(r.missing).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(DEFAULT_GATE_POLICY.min_auto);
  });

  it("C2: modellens selvrapporterte sikkerhet avvises uansett navn - også nøstet", () => {
    for (const bad of [{ ...strong, model_confidence: 0.99 }, { ...strong, eval: { score: 0.9, self_reported_confidence: 1 } }, { ...strong, verbal_certainty: 0.9 }]) {
      expect(() => computeConfidenceGate(bad as unknown as ConfidenceSignals)).toThrow(/self_reported_confidence_not_allowed/);
    }
  });

  it("C3: typesystemet har ikke et selvrapportert-felt", () => {
    // @ts-expect-error - `confidence` finnes ikke på ConfidenceSignals
    const typed: ConfidenceSignals = { confidence: 0.9 };
    expect(typeof typed).toBe("object");
  });

  it("C4: manglende signaler er aldri bra: ingen signaler -> owner med score null; manglende eval hindrer auto", () => {
    expect(computeConfidenceGate({})).toMatchObject({ band: "owner", score: null });
    const noEval: ConfidenceSignals = { ...strong };
    delete noEval.eval;
    const r = computeConfidenceGate(noEval);
    expect(r.missing).toContain("eval");
    expect(r.band).not.toBe("auto");
  });

  it("C5: ufullstendig verifikasjon, feilede tester eller system nede = blocked", () => {
    expect(computeConfidenceGate({ ...strong, runtime: { tests_passed: true, health: "OK", partial_execution: true } }).band).toBe("blocked");
    expect(computeConfidenceGate({ ...strong, runtime: { tests_passed: false, health: "OK", partial_execution: false } }).band).toBe("blocked");
    expect(computeConfidenceGate({ ...strong, runtime: { tests_passed: true, health: "DOWN", partial_execution: false } }).band).toBe("blocked");
  });

  it("C6: lav eval, negativ delta, motstridende data eller uavklarte krav eskalerer til eier", () => {
    for (const patch of [
      { eval: { score: 0.5 } }, { eval: { score: 0.95, delta: -0.1 } }, { data: { fresh: true, contradictory: true } }, { ambiguity: { unresolved_requirements: 2 } }
    ]) {
      expect(computeConfidenceGate({ ...strong, ...patch } as ConfidenceSignals).band, JSON.stringify(patch)).toBe("owner");
    }
  });

  it("C7: for få historiske utfall teller ikke som evidens", () => {
    const r = computeConfidenceGate({ ...strong, history: { successes: 2, failures: 0 } });
    expect(r.missing).toContain("history_samples");
    expect(r.band).not.toBe("auto");
  });
});
