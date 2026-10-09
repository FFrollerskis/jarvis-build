import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILDER_VERIFIED_GATES, deriveChangeFreeze, evaluateBuilderLoopReadiness, parseDeclaredValueGates, type BuilderLoopFacts } from "../src/index.ts";

/**
 * WP-C4, V3 Builder Loop: SOVENDE beredskapslogikk. Bevisene: (1) `activation_decision` er false for ALLE faktakombinasjoner - også når alle tekniske krav er oppfylt, (2) eierens D-beslutning er aldri oppfylt av kode,
 * (3) ukjent er aldri «oppfylt», (4) modulen importerer ingenting som kan starte en handling (statisk skanning).
 */
const ALL_GOOD: BuilderLoopFacts = {
  constitution_verified: true, ledger_ok: true, change_freeze: { frozen: false, reasons: [] }, github_connector_healthy: true, declared_gates: ["D-32", "WORKER_ISOLATION"]
};
const NONE: BuilderLoopFacts = { constitution_verified: null, ledger_ok: null, change_freeze: null, github_connector_healthy: null, declared_gates: [] };

describe("evaluateBuilderLoopReadiness", () => {
  it("uten noe fakta: ingenting er oppfylt, alt teknisk er ukjent/mangler, og løkken er ikke klar", () => {
    const v = evaluateBuilderLoopReadiness(NONE);
    expect(v.loop).toBe("V3");
    expect(v.activation_decision).toBe(false);
    expect(v.ready_for_owner_decision).toBe(false);
    expect(v.met).toEqual([]);
    expect(v.requirements.filter((r) => r.kind === "technical" && r.unknown).map((r) => r.id)).toEqual(["ev0.constitution_verified", "ev0.ledger_ok", "change_freeze_off", "github_connector_healthy"]);
    // D-32 og worker-isolasjon er erklæringer: ikke erklært = ikke oppfylt, men IKKE «ukjent».
    expect(v.requirements.find((r) => r.id === "gate:D-32")).toMatchObject({ met: false, unknown: false });
  });

  it("alle tekniske krav oppfylt gir «klar for eierens beslutning» - men aktiveringsbeslutningen er fortsatt false og eierens D-beslutning mangler", () => {
    const v = evaluateBuilderLoopReadiness(ALL_GOOD);
    expect(v.ready_for_owner_decision).toBe(true);
    expect(v.activation_decision).toBe(false);
    expect(v.missing).toEqual([{ id: "owner_decision:V3", label_no: expect.stringContaining("navngitt D-beslutning"), unknown: false }]);
    expect(v.requirements.find((r) => r.id === "owner_decision:V3")).toMatchObject({ kind: "owner_decision", met: false });
  });

  it("de fem kravene fra byggeordren er med: D-32, EV-0 (konstitusjon + register), change freeze av, worker-isolasjon og eierens godkjenning", () => {
    const ids = evaluateBuilderLoopReadiness(ALL_GOOD).requirements.map((r) => r.id);
    expect(ids).toEqual(["ev0.constitution_verified", "ev0.ledger_ok", "change_freeze_off", "github_connector_healthy", "gate:D-32", "gate:WORKER_ISOLATION", "owner_decision:V3"]);
  });

  it("hvert enkelt tekniske krav som mangler gjør løkken ikke klar (én og én)", () => {
    const breakers: Array<Partial<BuilderLoopFacts>> = [
      { constitution_verified: false }, { constitution_verified: null }, { ledger_ok: false }, { ledger_ok: null },
      { change_freeze: { frozen: true, reasons: ["incident_open"] } }, { change_freeze: null },
      { github_connector_healthy: false }, { github_connector_healthy: null },
      { declared_gates: ["WORKER_ISOLATION"] }, { declared_gates: ["D-32"] }, { declared_gates: [] }
    ];
    for (const patch of breakers) {
      const v = evaluateBuilderLoopReadiness({ ...ALL_GOOD, ...patch });
      expect(v.ready_for_owner_decision, JSON.stringify(patch)).toBe(false);
      expect(v.activation_decision).toBe(false);
    }
  });

  it("ukjent er ikke det samme som ikke oppfylt, men heller aldri oppfylt", () => {
    const v = evaluateBuilderLoopReadiness({ ...ALL_GOOD, ledger_ok: null });
    expect(v.requirements.find((r) => r.id === "ev0.ledger_ok")).toMatchObject({ met: false, unknown: true });
    expect(v.missing.find((m) => m.id === "ev0.ledger_ok")?.unknown).toBe(true);
  });

  it("activation_decision er false for ALLE kombinasjoner av fakta (uttømmende)", () => {
    const tri = [true, false, null] as const;
    const freezes = [null, { frozen: false, reasons: [] }, { frozen: true, reasons: ["kill_switch_active"] }] as const;
    const gates = [[], ["D-32"], ["WORKER_ISOLATION"], ["D-32", "WORKER_ISOLATION"], ["D-32", "OWNER_APPROVAL", "alt-mulig"]] as const;
    let combos = 0;
    for (const c of tri) for (const l of tri) for (const f of freezes) for (const g of tri) for (const d of gates) {
      const v = evaluateBuilderLoopReadiness({ constitution_verified: c, ledger_ok: l, change_freeze: f, github_connector_healthy: g, declared_gates: d });
      expect(v.activation_decision).toBe(false);
      expect(v.requirements.find((r) => r.kind === "owner_decision")?.met).toBe(false);
      combos += 1;
    }
    expect(combos).toBe(3 * 3 * 3 * 3 * 5);
  });

  it("erklærte porter utenfor de kjente ignoreres (en oppdiktet port som «OWNER_APPROVAL» oppfyller ingenting)", () => {
    const v = evaluateBuilderLoopReadiness({ ...ALL_GOOD, declared_gates: ["OWNER_APPROVAL", "owner_decision:V3", "ACTIVATE_V3"] });
    expect(v.ready_for_owner_decision).toBe(false);
    expect(v.requirements.find((r) => r.id === "owner_decision:V3")?.met).toBe(false);
  });
});

describe("parseDeclaredValueGates", () => {
  it("godtar kun eksakte, kjente navn (uten duplikater) og ignorerer alt annet", () => {
    expect(parseDeclaredValueGates(undefined)).toEqual([]);
    expect(parseDeclaredValueGates("")).toEqual([]);
    expect(parseDeclaredValueGates("D-32, WORKER_ISOLATION ,D-32")).toEqual(["D-32", "WORKER_ISOLATION"]);
    expect(parseDeclaredValueGates("d-32,worker_isolation,ALT,OWNER_APPROVAL_V3,;D-32")).toEqual([]);
    expect([...BUILDER_VERIFIED_GATES]).toEqual(["D-32", "WORKER_ISOLATION"]);
  });
});

describe("deriveChangeFreeze", () => {
  it("fryser ved kill switch, åpen hendelse, manglende observerbarhet eller brutt tjenestemål - og er ellers av", () => {
    const ok = { incident_open: false, observability_ok: true, slo_breaches: 0, kill_switch_active: false };
    expect(deriveChangeFreeze(ok)).toEqual({ frozen: false, reasons: [] });
    expect(deriveChangeFreeze({ ...ok, kill_switch_active: true }).reasons).toEqual(["kill_switch_active"]);
    expect(deriveChangeFreeze({ ...ok, incident_open: true }).reasons).toEqual(["incident_open"]);
    expect(deriveChangeFreeze({ ...ok, observability_ok: false }).reasons).toEqual(["observability_missing"]);
    expect(deriveChangeFreeze({ ...ok, slo_breaches: 2 }).reasons).toEqual(["slo_breached"]);
    expect(deriveChangeFreeze({ incident_open: true, observability_ok: false, slo_breaches: 1, kill_switch_active: true })).toEqual({
      frozen: true, reasons: ["kill_switch_active", "incident_open", "observability_missing", "slo_breached"]
    });
  });
});

describe("ingen kodevei kan starte selvmodifikasjon (statisk skanning)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const sources = {
    builder: read("../src/value/builder-loop.ts"),
    ops: read("../src/value/ops-proposals.ts"),
    loops: read("../src/value/loops.ts")
  };

  it("builder-loop.ts og ops-proposals.ts importerer KUN typer fra egen mappe (ingen tjeneste, transport, gateway eller leverandør)", () => {
    for (const [name, src] of Object.entries(sources)) {
      const imports = [...src.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)];
      for (const m of imports) {
        expect(m[1], `${name}: ${m[0]}`).toBe("type ");
        expect(m[2], `${name}: ${m[0]}`).toMatch(/^\.\/types\.ts$/);
      }
    }
  });

  it("ingen referanse til selvmodifikasjonstjenesten, kodeforslag, GitHub-skriving eller sandkasse i beredskapskoden", () => {
    for (const src of [sources.builder, sources.ops]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/SelfModificationService|proposeCodeChange|sweepApprovedRequests|create_pr|merge_pr|create_branch|SandboxRunner|\.execute\(|fetch\(|child_process|writeFile|exec\(/);
    }
  });

  it("activation_decision er typet som litteralen false (ikke boolean) i verdikttypen", () => {
    expect(readFileSync(fileURLToPath(new URL("../src/value/types.ts", import.meta.url)), "utf8")).toMatch(/activation_decision:\s*false;/);
  });
});
